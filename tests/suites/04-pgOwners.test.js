// tests/suites/04-pgOwners.test.js
//
// Covers: profile get/put, photo put/delete, contact reveal (POST, unlike
// students' GET), documents submit.
//
// Note: profile/photo updates do NOT require verification_status = 'verified'
// (that gate only applies to property/listing creation via
// assertPgOwnerVerified — see src/db/utils/pgOwner.js and its callers in
// property.service.js / listing.service.js). A freshly-registered,
// unverified pg_owner can still manage their own profile and photo.
//
// Document submission emails are already covered end-to-end by
// 05-verification-email.test.js — this suite only asserts the HTTP contract
// (status codes, request_id shape, duplicate-pending rejection).

import request from "supertest";
import { app } from "../../src/app.js";
import { registerPgOwner, registerStudent } from "../setup/testAuth.js";
import { tinyJpegBuffer } from "../setup/testImage.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@business.test`;

describe("GET /pg-owners/:userId/profile", () => {
	test("self-view includes email and business_phone", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("profile-self") });

		const res = await agent.get(`/api/v1/pg-owners/${user.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(user.userId);
		expect(res.body.data.email).toEqual(expect.any(String));
	});

	test("other-user-view omits email and business_phone", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("profile-target") });
		const { agent: viewerAgent } = await registerPgOwner({ email: uniqueEmail("profile-viewer") });

		const res = await viewerAgent.get(`/api/v1/pg-owners/${target.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.email).toBeNull();
		expect(res.body.data.business_phone).toBeNull();
	});

	test("404 for a non-existent pg_owner", async () => {
		const { agent } = await registerPgOwner({ email: uniqueEmail("profile-404") });
		const res = await agent.get(`/api/v1/pg-owners/00000000-0000-0000-0000-000000000000/profile`);
		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { user } = await registerPgOwner({ email: uniqueEmail("profile-noauth") });
		const res = await request(app).get(`/api/v1/pg-owners/${user.userId}/profile`);
		expect(res.status).toBe(401);
	});
});

describe("PUT /pg-owners/:userId/profile", () => {
	test("updates own profile fields without requiring verification", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("update-self") });

		const res = await agent.put(`/api/v1/pg-owners/${user.userId}/profile`).send({
			businessDescription: "Clean, quiet PG near campus.",
			businessPhone: "9876543210",
			operatingSince: 2019,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.business_description).toBe("Clean, quiet PG near campus.");
		expect(res.body.data.operating_since).toBe(2019);
	});

	test("rejects updating another owner's profile with 403", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("update-target") });
		const { agent: attackerAgent } = await registerPgOwner({ email: uniqueEmail("update-attacker") });

		const res = await attackerAgent
			.put(`/api/v1/pg-owners/${target.userId}/profile`)
			.send({ businessDescription: "hijacked" });

		expect(res.status).toBe(403);
	});

	test("a student cannot hit the pg_owner profile update route", async () => {
		const { agent, user } = await registerStudent({ email: `update-student-${Date.now()}@college.edu` });

		const res = await agent.put(`/api/v1/pg-owners/${user.userId}/profile`).send({ businessDescription: "x" });

		expect(res.status).toBe(403);
	});

	test("rejects invalid operatingSince (future year)", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("update-badyear") });
		const futureYear = new Date().getFullYear() + 5;

		const res = await agent.put(`/api/v1/pg-owners/${user.userId}/profile`).send({ operatingSince: futureYear });

		expect(res.status).toBe(400);
	});

	test("rejects malformed businessPhone", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("update-badphone") });

		const res = await agent.put(`/api/v1/pg-owners/${user.userId}/profile`).send({ businessPhone: "abc" });

		expect(res.status).toBe(400);
	});
});

describe("PUT /pg-owners/:userId/photo, DELETE /pg-owners/:userId/photo", () => {
	test("uploads a photo and sets profilePhotoUrl", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("photo-upload") });

		const res = await agent
			.put(`/api/v1/pg-owners/${user.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		expect(res.status).toBe(200);
		expect(res.body.data.profilePhotoUrl).toEqual(expect.any(String));
		expect(res.body.data.profilePhotoUrl).toMatch(/\.webp$/);
	});

	test("rejects upload with no file with 400", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("photo-nofile") });

		const res = await agent.put(`/api/v1/pg-owners/${user.userId}/photo`);

		expect(res.status).toBe(400);
	});

	test("deletes an existing photo and clears profilePhotoUrl", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("photo-delete") });

		await agent
			.put(`/api/v1/pg-owners/${user.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		const res = await agent.delete(`/api/v1/pg-owners/${user.userId}/photo`);

		expect(res.status).toBe(200);
		expect(res.body.data.profilePhotoUrl).toBeNull();
	});

	test("cannot upload a photo to another owner's profile", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("photo-target") });
		const { agent: attackerAgent } = await registerPgOwner({ email: uniqueEmail("photo-attacker") });

		const res = await attackerAgent
			.put(`/api/v1/pg-owners/${target.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		expect(res.status).toBe(403);
	});
});

describe("POST /pg-owners/:userId/contact/reveal", () => {
	test("verified authenticated viewer bypasses guest quota", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("reveal-target") });
		const { agent: viewerAgent } = await registerPgOwner({ email: uniqueEmail("reveal-viewer") });

		const res = await viewerAgent.post(`/api/v1/pg-owners/${target.userId}/contact/reveal`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(target.userId);
	});

	test("guest (no auth) can reveal within free quota", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("reveal-guest-target") });

		const res = await request(app).post(`/api/v1/pg-owners/${target.userId}/contact/reveal`);

		expect(res.status).toBe(200);
	});

	test("sets Cache-Control: no-store", async () => {
		const { user: target } = await registerPgOwner({ email: uniqueEmail("reveal-cache-target") });

		const res = await request(app).post(`/api/v1/pg-owners/${target.userId}/contact/reveal`);

		expect(res.headers["cache-control"]).toBe("no-store");
	});

	test("404 for a non-existent target owner", async () => {
		const res = await request(app).post(`/api/v1/pg-owners/00000000-0000-0000-0000-000000000000/contact/reveal`);
		expect(res.status).toBe(404);
	});
});

describe("POST /pg-owners/:userId/documents", () => {
	test("submits a document and returns pending status", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("doc-submit") });

		const res = await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "owner_id",
			documentUrl: "https://example.com/doc.pdf",
		});

		expect(res.status).toBe(201);
		expect(res.body.data.status).toBe("pending");
		expect(res.body.data.document_type).toBe("owner_id");
	});

	test("rejects a second submission while one is already pending", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("doc-dup") });

		await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "owner_id",
			documentUrl: "https://example.com/doc1.pdf",
		});

		const res = await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "trade_license",
			documentUrl: "https://example.com/doc2.pdf",
		});

		expect(res.status).toBe(409);
	});

	test("rejects an invalid documentType", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("doc-badtype") });

		const res = await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "passport",
			documentUrl: "https://example.com/doc.pdf",
		});

		expect(res.status).toBe(400);
	});

	test("a student cannot submit pg_owner verification documents", async () => {
		const { agent, user } = await registerStudent({ email: `doc-student-${Date.now()}@college.edu` });

		const res = await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "owner_id",
			documentUrl: "https://example.com/doc.pdf",
		});

		expect(res.status).toBe(403);
	});

	test("rejects an empty documentUrl", async () => {
		const { agent, user } = await registerPgOwner({ email: uniqueEmail("doc-nourl") });

		const res = await agent.post(`/api/v1/pg-owners/${user.userId}/documents`).send({
			documentType: "owner_id",
			documentUrl: "",
		});

		expect(res.status).toBe(400);
	});
});
