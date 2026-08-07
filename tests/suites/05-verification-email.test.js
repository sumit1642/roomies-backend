// tests/suites/05-verification-email.test.js
//
// Verification approval/rejection/pending emails flow through a different
// path than OTP: DB trigger on verification_requests.status change writes a
// row to verification_event_outbox, which verificationEventWorker.drainOutbox()
// picks up, updates pg_owner_profiles, and enqueues the email (+ notification
// for approved/rejected).
//
// We call drainOutbox() directly instead of waiting on its 5s node-cron-style
// setInterval — same pattern this codebase already uses for
// runListingExpiry/runSavedSearchAlert. No source behavior changes; drainOutbox
// was already a standalone function, just not exported until now.

import { jest } from "@jest/globals";
import { mockNodemailer, findSentMailTo, waitForNextEmail, closeEmailTestListener, getQueueEvents, getQueueEventsReady } from "../setup/testEmail.js";
import { registerPgOwner } from "../setup/testAuth.js";

mockNodemailer();

let app, drainOutbox, startEmailWorker, nodemailerMock, pool, redis, emailWorker;

// Minimal admin bootstrap: promote a registered user to admin role directly
// via SQL, since there's no public admin-signup endpoint. Mirrors how other
// admin-gated suites in this codebase would need to seed an admin.
const makeAdmin = async (userId) => {
	await pool.query(`INSERT INTO user_roles (user_id, role_name) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [
		userId,
	]);
	await pool.query(`UPDATE users SET is_email_verified = TRUE WHERE user_id = $1`, [userId]);
};

beforeAll(async () => {
	({ app } = await import("../../src/app.js"));
	({ drainOutbox } = await import("../../src/workers/verificationEventWorker.js"));
	({ startEmailWorker } = await import("../../src/workers/emailWorker.js"));
	({ pool } = await import("../../src/db/client.js"));
	({ redis } = await import("../../src/cache/client.js"));
	nodemailerMock = (await import("nodemailer-mock")).default ?? (await import("nodemailer-mock"));
	emailWorker = startEmailWorker();
	await getQueueEventsReady(); 
});

const waitForEmailAfter = async (action) => {
	const events = getQueueEvents(); // if exported, or expose a `ready()` helper
	await events.waitUntilReady();
	const waitPromise = waitForNextEmail(); // now safe — listener attaches synchronously since already ready
	const result = await action();
	await drainOutbox();
	await waitPromise;
	return result;
};

afterEach(() => {
	nodemailerMock.mock.reset();
});

afterAll(async () => {
	await closeEmailTestListener();
	await emailWorker.close();
});

describe("Verification event outbox -> email pipeline", () => {
	test("approval: pg_owner_profiles updated, approved email sent", async () => {
		const {
			agent: ownerAgent,
			user: owner,
			email: ownerEmail,
		} = await registerPgOwner({
			email: `verify-approve-${Date.now()}@business.test`,
		});
		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: `verify-admin-${Date.now()}@business.test`,
		});
		await makeAdmin(admin.userId);

		const submitRes = await waitForEmailAfter(() =>
			ownerAgent.post(`/api/v1/pg-owners/${owner.userId}/documents`).send({
				documentType: "owner_id",
				documentUrl: "https://example.com/doc.pdf",
			}),
		);
		expect(submitRes.status).toBe(201);
		const requestId = submitRes.body.data.request_id;

		nodemailerMock.mock.reset();
		const approveRes = await waitForEmailAfter(() =>
			adminAgent.patch(`/api/v1/verification/${requestId}/approve`).send({}),
		);
		expect(approveRes.status).toBe(200);

		const { rows } = await pool.query(`SELECT verification_status FROM pg_owner_profiles WHERE user_id = $1`, [
			owner.userId,
		]);
		expect(rows[0].verification_status).toBe("verified");

		const mail = findSentMailTo(nodemailerMock, ownerEmail);
		expect(mail).not.toBeNull();
		expect(mail.subject).toMatch(/verified/i);
	});

	test("rejection: pg_owner_profiles updated with reason, rejected email sent", async () => {
		const {
			agent: ownerAgent,
			user: owner,
			email: ownerEmail,
		} = await registerPgOwner({
			email: `verify-reject-${Date.now()}@business.test`,
		});
		const { agent: adminAgent, user: admin } = await registerPgOwner({
			email: `verify-admin2-${Date.now()}@business.test`,
		});
		await makeAdmin(admin.userId);

		const submitRes = await waitForEmailAfter(() =>
			ownerAgent.post(`/api/v1/pg-owners/${owner.userId}/documents`).send({
				documentType: "owner_id",
				documentUrl: "https://example.com/doc.pdf",
			}),
		);
		const requestId = submitRes.body.data.request_id;

		nodemailerMock.mock.reset();
		const rejectRes = await waitForEmailAfter(() =>
			adminAgent.patch(`/api/v1/verification/${requestId}/reject`).send({
				rejectionReason: "Document was illegible",
			}),
		);
		expect(rejectRes.status).toBe(200);

		const { rows } = await pool.query(
			`SELECT verification_status, rejection_reason FROM pg_owner_profiles WHERE user_id = $1`,
			[owner.userId],
		);
		expect(rows[0].verification_status).toBe("rejected");
		expect(rows[0].rejection_reason).toBe("Document was illegible");

		const mail = findSentMailTo(nodemailerMock, ownerEmail);
		expect(mail).not.toBeNull();
		expect(mail.text).toMatch(/Document was illegible/);
	});

	test("submission: pending acknowledgement email sent", async () => {
		const {
			agent: ownerAgent,
			user: owner,
			email: ownerEmail,
		} = await registerPgOwner({
			email: `verify-pending-${Date.now()}@business.test`,
		});

		const submitRes = await waitForEmailAfter(() =>
			ownerAgent.post(`/api/v1/pg-owners/${owner.userId}/documents`).send({
				documentType: "owner_id",
				documentUrl: "https://example.com/doc.pdf",
			}),
		);
		expect(submitRes.status).toBe(201);

		const mail = findSentMailTo(nodemailerMock, ownerEmail);
		expect(mail).not.toBeNull();
		expect(mail.subject).toMatch(/received/i);
	});

	test("drainOutbox is idempotent — re-running does not resend", async () => {
		const {
			agent: ownerAgent,
			user: owner,
			email: ownerEmail,
		} = await registerPgOwner({
			email: `verify-idempotent-${Date.now()}@business.test`,
		});

		await waitForEmailAfter(() =>
			ownerAgent.post(`/api/v1/pg-owners/${owner.userId}/documents`).send({
				documentType: "owner_id",
				documentUrl: "https://example.com/doc.pdf",
			}),
		);
		nodemailerMock.mock.reset();

		// Second drain should find no unprocessed rows for this event.
		await drainOutbox();

		const mail = findSentMailTo(nodemailerMock, ownerEmail);
		expect(mail).toBeNull();
	});
});
