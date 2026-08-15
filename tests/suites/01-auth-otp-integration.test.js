// tests/suites/01-auth-otp-integration.test.js
//
// Full-stack integration: real HTTP request -> real BullMQ enqueue ->
// real email worker processes it -> nodemailer-mock captures the "sent"
// mail -> extract OTP -> verify it against POST /auth/otp/verify.
//
// This is the pipe-integrity check for OTP email. Edge cases (wrong OTP
// logic, rate limits, already-verified) belong in auth-otp-unit.test.js —
// keep this file to "does the real pipe work end to end."

import { jest } from "@jest/globals";
import { mockNodemailer, waitForNextEmail, closeEmailTestListener, extractOtpFromMock } from "../setup/testEmail.js";
import { registerStudent } from "../setup/testAuth.js";

mockNodemailer();

let app, startEmailWorker, nodemailerMock, emailWorker;

beforeAll(async () => {
	({ app } = await import("../../src/app.js"));
	({ startEmailWorker } = await import("../../src/workers/emailWorker.js"));
	nodemailerMock = (await import("nodemailer-mock")).default ?? (await import("nodemailer-mock"));
	emailWorker = startEmailWorker();
});

afterEach(() => {
	nodemailerMock.mock.reset();
});

afterAll(async () => {
	await closeEmailTestListener();
	await emailWorker.close();
});

describe("OTP email — full pipeline", () => {
	test("register -> otp/send -> real email delivered -> otp/verify succeeds", async () => {
		const { agent, email } = await registerStudent({ email: `otp-e2e-${Date.now()}@college.edu` });

		const waitPromise = waitForNextEmail();
		const sendRes = await agent.post("/api/v1/auth/otp/send");
		expect(sendRes.status).toBe(200);

		await waitPromise;

		const otp = await extractOtpFromMock(nodemailerMock, email);
		expect(otp).toMatch(/^\d{6}$/);

		const verifyRes = await agent.post("/api/v1/auth/otp/verify").send({ otp });
		expect(verifyRes.status).toBe(200);

		const meRes = await agent.get("/api/v1/auth/me");
		expect(meRes.body.data.isEmailVerified).toBe(true);
	});

	test("wrong otp is rejected and does not verify", async () => {
		const { agent, email } = await registerStudent({ email: `otp-wrong-${Date.now()}@college.edu` });

		const waitPromise = waitForNextEmail();
		await agent.post("/api/v1/auth/otp/send");
		await waitPromise;

		const otp = await extractOtpFromMock(nodemailerMock, email);
		const wrongOtp = otp === "000000" ? "111111" : "000000";

		const verifyRes = await agent.post("/api/v1/auth/otp/verify").send({ otp: wrongOtp });
		expect(verifyRes.status).toBe(400);
	});
});
