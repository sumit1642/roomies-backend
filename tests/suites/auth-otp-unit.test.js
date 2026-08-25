// tests/suites/auth-otp-unit.test.js
//
// Unit-level: mocks enqueueEmail entirely, so no Redis/BullMQ/worker needed.
// Covers the branching logic in sendOtp/verifyOtp cheaply and without flake
// risk. The one real end-to-end pipe check lives in
// 01-auth-otp-integration.test.js — don't duplicate that here.

import { jest } from "@jest/globals";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const mockEnqueueEmail = jest.fn();

jest.unstable_mockModule("../../src/workers/emailQueue.js", () => ({
	enqueueEmail: mockEnqueueEmail,
}));

const { sendOtp, verifyOtp, adminLogin, verifyAdminLoginOtp } = await import("../../src/services/auth.service.js");
const { pool } = await import("../../src/db/client.js");
const { redis } = await import("../../src/cache/client.js");

const createUnverifiedUser = async (email) => {
	const { rows } = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING user_id`, [
		email,
		"hash",
	]);
	return rows[0].user_id;
};

describe("sendOtp — enqueue shape", () => {
	beforeEach(() => mockEnqueueEmail.mockClear());

	test("enqueues type=otp with a 6-digit otp in data", async () => {
		const userId = await createUnverifiedUser("otp-unit@college.edu");

		await sendOtp(userId, "otp-unit@college.edu");

		expect(mockEnqueueEmail).toHaveBeenCalledTimes(1);
		const [payload] = mockEnqueueEmail.mock.calls[0];
		expect(payload.type).toBe("otp");
		expect(payload.to).toBe("otp-unit@college.edu");
		expect(payload.data.otp).toMatch(/^\d{6}$/);
	});

	test("throws 409 if already verified", async () => {
		const { rows } = await pool.query(
			`INSERT INTO users (email, password_hash, is_email_verified) VALUES ($1, $2, TRUE) RETURNING user_id`,
			["otp-verified@college.edu", "hash"],
		);
		await expect(sendOtp(rows[0].user_id, "otp-verified@college.edu")).rejects.toMatchObject({ statusCode: 409 });
		expect(mockEnqueueEmail).not.toHaveBeenCalled();
	});
});

describe("verifyOtp — branching logic", () => {
	test("throws 400 when no OTP was ever sent", async () => {
		const userId = await createUnverifiedUser("otp-never-sent@college.edu");
		await expect(verifyOtp(userId, "123456", "127.0.0.1")).rejects.toMatchObject({ statusCode: 400 });
	});

	test("rejects an incorrect OTP without verifying the account", async () => {
		const userId = await createUnverifiedUser("otp-wrong-unit@college.edu");
		await sendOtp(userId, "otp-wrong-unit@college.edu");

		await expect(verifyOtp(userId, "000000", "127.0.0.1")).rejects.toMatchObject({ statusCode: 400 });

		const { rows } = await pool.query(`SELECT is_email_verified FROM users WHERE user_id = $1`, [userId]);
		expect(rows[0].is_email_verified).toBe(false);
	});
});

const createAdmin = async (email) => {
	const password = "TestPass123!";
	const passwordHash = await bcrypt.hash(password, 10);
	const { rows } = await pool.query(
		`INSERT INTO users (email, password_hash, is_email_verified) VALUES ($1, $2, TRUE) RETURNING user_id`,
		[email, passwordHash],
	);
	await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin')`, [rows[0].user_id]);
	return { userId: rows[0].user_id, password };
};

const startAdminLogin = async (email) => {
	const { password } = await createAdmin(email);
	const { pendingToken } = await adminLogin({ email, password });
	const { data } = mockEnqueueEmail.mock.calls.at(-1)[0];
	return { pendingToken, otp: data.otp };
};

describe("verifyAdminLoginOtp — atomic OTP state transitions", () => {
	test("only one concurrent verification can consume an admin-login OTP", async () => {
		const { pendingToken, otp } = await startAdminLogin("admin-otp-consume@college.edu");

		const results = await Promise.allSettled([
			verifyAdminLoginOtp(pendingToken, otp),
			verifyAdminLoginOtp(pendingToken, otp),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")[0].reason).toMatchObject({ statusCode: 400 });
	});

	test("counts each concurrent incorrect admin-login OTP once", async () => {
		const { pendingToken } = await startAdminLogin("admin-otp-attempts@college.edu");

		const results = await Promise.allSettled([
			verifyAdminLoginOtp(pendingToken, "000000"),
			verifyAdminLoginOtp(pendingToken, "000000"),
		]);

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ statusCode: 400 }) }),
			]),
		);
		expect(await redis.get(`adminLoginOtpAttempts:${jwt.decode(pendingToken).userId}`)).toBe("2");
	});

});
