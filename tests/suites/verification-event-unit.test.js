// tests/suites/verification-event-unit.test.js
//
// Unit-level: exercises verificationEventWorker.processEvent() directly
// against a real pg client (no HTTP, no BullMQ worker, no outbox polling).
// Mirrors auth-otp-unit.test.js's shape: mock enqueueEmail/enqueueNotification,
// assert on call args and DB side effects, skip the real mail transport.
//
// The one real end-to-end pipe check (drainOutbox -> real email worker ->
// nodemailer-mock) lives in 05-verification-email.test.js — don't duplicate
// that here. This file covers processEvent's branching logic cheaply:
// unknown event_type, missing user/profile, already-correct status (no-op
// update skipped), and the exact enqueue payloads for each event type.

import { jest } from "@jest/globals";

const mockEnqueueNotification = jest.fn();
const mockEnqueueEmail = jest.fn();

jest.unstable_mockModule("../../src/workers/notificationQueue.js", () => ({
	enqueueNotification: mockEnqueueNotification,
}));
jest.unstable_mockModule("../../src/workers/emailQueue.js", () => ({
	enqueueEmail: mockEnqueueEmail,
}));

const { processEvent } = await import("../../src/workers/verificationEventWorker.js");
const { pool } = await import("../../src/db/client.js");
const { registerPgOwner } = await import("../setup/testAuth.js");

const insertOutboxRow = async (eventType, userId, requestId, rejectionReason = null) => {
	const { rows } = await pool.query(
		`INSERT INTO verification_event_outbox (event_type, user_id, request_id, rejection_reason)
     VALUES ($1, $2, $3, $4)
     RETURNING event_id, event_type, user_id, request_id, rejection_reason, attempts`,
		[eventType, userId, requestId, rejectionReason],
	);
	return rows[0];
};

const insertVerificationRequest = async (userId) => {
	const { rows } = await pool.query(
		`INSERT INTO verification_requests (user_id, document_type, document_url)
     VALUES ($1, 'owner_id', 'https://example.com/doc.pdf')
     RETURNING request_id`,
		[userId],
	);
	return rows[0].request_id;
};

describe("processEvent — branching logic", () => {
	beforeEach(() => {
		mockEnqueueNotification.mockClear();
		mockEnqueueEmail.mockClear();
	});

	test("verification_approved: corrects status, returns notification + email side effects", async () => {
		const { user: owner, email } = await registerPgOwner({ email: `pe-approve-${Date.now()}@business.test` });
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_approved", owner.userId, requestId);

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			expect(sideEffects).toHaveLength(2);

			// Side effects are deferred closures — invoke them to observe the calls,
			// same as the real drainOutbox does after commit.
			await Promise.all(sideEffects.map((fn) => fn()));
		} finally {
			client.release();
		}

		expect(mockEnqueueNotification).toHaveBeenCalledWith(
			expect.objectContaining({ recipientId: owner.userId, type: "verification_approved" }),
		);
		expect(mockEnqueueEmail).toHaveBeenCalledWith(
			expect.objectContaining({ type: "verification_approved", to: email }),
		);

		const { rows } = await pool.query(`SELECT verification_status FROM pg_owner_profiles WHERE user_id = $1`, [
			owner.userId,
		]);
		expect(rows[0].verification_status).toBe("verified");
	});

	test("verification_approved: status already 'verified' — skips redundant UPDATE, still enqueues", async () => {
		const { user: owner } = await registerPgOwner({ email: `pe-already-verified-${Date.now()}@business.test` });
		await pool.query(`UPDATE pg_owner_profiles SET verification_status = 'verified' WHERE user_id = $1`, [
			owner.userId,
		]);
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_approved", owner.userId, requestId);

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			expect(sideEffects).toHaveLength(2);
		} finally {
			client.release();
		}
	});

	test("verification_rejected: sets status + rejection_reason, enqueues with reason", async () => {
		const { user: owner, email } = await registerPgOwner({ email: `pe-reject-${Date.now()}@business.test` });
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_rejected", owner.userId, requestId, "Blurry photo");

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			await Promise.all(sideEffects.map((fn) => fn()));
		} finally {
			client.release();
		}

		expect(mockEnqueueEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "verification_rejected",
				to: email,
				data: expect.objectContaining({ rejectionReason: "Blurry photo" }),
			}),
		);

		const { rows } = await pool.query(
			`SELECT verification_status, rejection_reason FROM pg_owner_profiles WHERE user_id = $1`,
			[owner.userId],
		);
		expect(rows[0].verification_status).toBe("rejected");
		expect(rows[0].rejection_reason).toBe("Blurry photo");
	});

	test("verification_rejected: null rejectionReason falls back to default message in email data", async () => {
		const { user: owner, email } = await registerPgOwner({ email: `pe-reject-null-${Date.now()}@business.test` });
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_rejected", owner.userId, requestId, null);

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			await Promise.all(sideEffects.map((fn) => fn()));
		} finally {
			client.release();
		}

		expect(mockEnqueueEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: email,
				data: expect.objectContaining({
					rejectionReason: expect.stringMatching(/review the requirements/i),
				}),
			}),
		);
	});

	test("verification_pending: enqueues acknowledgement email only, no notification", async () => {
		const { user: owner, email } = await registerPgOwner({ email: `pe-pending-${Date.now()}@business.test` });
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_pending", owner.userId, requestId);

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			expect(sideEffects).toHaveLength(1);
			await Promise.all(sideEffects.map((fn) => fn()));
		} finally {
			client.release();
		}

		expect(mockEnqueueEmail).toHaveBeenCalledWith(
			expect.objectContaining({ type: "verification_pending", to: email }),
		);
		expect(mockEnqueueNotification).not.toHaveBeenCalled();
	});

	test("unknown event_type: no side effects, no throw (skipped without retry)", async () => {
		const { user: owner } = await registerPgOwner({ email: `pe-unknown-${Date.now()}@business.test` });
		const requestId = await insertVerificationRequest(owner.userId);
		const event = await insertOutboxRow("verification_pending", owner.userId, requestId);
		event.event_type = "some_future_event_type"; // simulate an unhandled type without a DB enum change

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			expect(sideEffects).toEqual([]);
		} finally {
			client.release();
		}

		expect(mockEnqueueEmail).not.toHaveBeenCalled();
		expect(mockEnqueueNotification).not.toHaveBeenCalled();
	});

	test("missing user/profile: returns empty side effects, does not throw", async () => {
		// A request_id/user_id combination pointing at a user_id with no
		// matching pg_owner_profiles row (deleted between event write and drain).
		const orphanUserId = "00000000-0000-0000-0000-000000000000";
		const event = {
			event_id: "11111111-1111-1111-1111-111111111111",
			event_type: "verification_approved",
			user_id: orphanUserId,
			request_id: "22222222-2222-2222-2222-222222222222",
			rejection_reason: null,
		};

		const client = await pool.connect();
		try {
			const sideEffects = await processEvent(event, client);
			expect(sideEffects).toEqual([]);
		} finally {
			client.release();
		}

		expect(mockEnqueueEmail).not.toHaveBeenCalled();
		expect(mockEnqueueNotification).not.toHaveBeenCalled();
	});
});
