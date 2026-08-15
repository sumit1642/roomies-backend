// tests/suites/auth-otp-unit.test.js
//
// Unit-level: mocks enqueueEmail entirely, so no Redis/BullMQ/worker needed.
// Covers the branching logic in sendOtp/verifyOtp cheaply and without flake
// risk. The one real end-to-end pipe check lives in
// 01-auth-otp-integration.test.js — don't duplicate that here.

import { jest } from "@jest/globals";

const mockEnqueueEmail = jest.fn();

jest.unstable_mockModule("../../src/workers/emailQueue.js", () => ({
	enqueueEmail: mockEnqueueEmail,
}));

const { sendOtp, verifyOtp } = await import("../../src/services/auth.service.js");
const { pool } = await import("../../src/db/client.js");

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
