// tests/suites/02-students.test.js
//
// Covers: profile get/put, photo put/delete, contact reveal (guest quota +
// authenticated bypass), preferences get/put.
//
// Photo tests exercise the REAL sharp compression pipeline (no worker/queue
// involved for profile photos — profilePhoto.service.js processes and
// uploads synchronously, unlike listing photos which go through BullMQ).
// storageService is LocalDiskAdapter in test env (STORAGE_ADAPTER=local),
// so uploads land under uploads/ on disk — no mocking needed.

import request from "supertest";
import { app } from "../../src/app.js";
import { registerStudent } from "../setup/testAuth.js";
import { tinyJpegBuffer } from "../setup/testImage.js";

const uniqueEmail = (label) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@college.edu`;

describe("GET /students/:userId/profile", () => {
	test("self-view includes email", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("profile-self") });

		const res = await agent.get(`/api/v1/students/${user.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(user.userId);
		expect(res.body.data.email).toEqual(expect.any(String));
	});

	test("other-user-view omits email", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("profile-target") });
		const { agent: viewerAgent } = await registerStudent({ email: uniqueEmail("profile-viewer") });

		const res = await viewerAgent.get(`/api/v1/students/${target.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.email).toBeNull();
	});

	test("404 for a non-existent user id", async () => {
		const { agent } = await registerStudent({ email: uniqueEmail("profile-404-viewer") });
		const res = await agent.get(`/api/v1/students/00000000-0000-0000-0000-000000000000/profile`);
		expect(res.status).toBe(404);
	});

	test("requires authentication", async () => {
		const { user } = await registerStudent({ email: uniqueEmail("profile-noauth") });
		const res = await request(app).get(`/api/v1/students/${user.userId}/profile`);
		expect(res.status).toBe(401);
	});
});

describe("PUT /students/:userId/profile", () => {
	test("updates own profile fields", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("update-self") });

		const res = await agent.put(`/api/v1/students/${user.userId}/profile`).send({
			bio: "I like quiet rooms and early mornings.",
			course: "Computer Science",
			yearOfStudy: 2,
		});

		expect(res.status).toBe(200);
		expect(res.body.data.bio).toBe("I like quiet rooms and early mornings.");
		expect(res.body.data.course).toBe("Computer Science");
		expect(res.body.data.year_of_study).toBe(2);
	});

	test("rejects updating another user's profile with 403", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("update-target") });
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("update-attacker") });

		const res = await attackerAgent.put(`/api/v1/students/${target.userId}/profile`).send({ bio: "hijacked" });

		expect(res.status).toBe(403);
	});

	test("rejects empty update body with 400", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("update-empty") });

		const res = await agent.put(`/api/v1/students/${user.userId}/profile`).send({});

		expect(res.status).toBe(400);
	});

	test("rejects invalid yearOfStudy out of range", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("update-badyear") });

		const res = await agent.put(`/api/v1/students/${user.userId}/profile`).send({ yearOfStudy: 99 });

		expect(res.status).toBe(400);
	});
});

describe("PUT /students/:userId/photo, DELETE /students/:userId/photo", () => {
	test("uploads a photo and sets profilePhotoUrl", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("photo-upload") });

		const res = await agent
			.put(`/api/v1/students/${user.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		expect(res.status).toBe(200);
		expect(res.body.data.profilePhotoUrl).toEqual(expect.any(String));
		expect(res.body.data.profilePhotoUrl).toMatch(/\.webp$/);
	});

	test("rejects upload with no file with 400", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("photo-nofile") });

		const res = await agent.put(`/api/v1/students/${user.userId}/photo`);

		expect(res.status).toBe(400);
	});

	test("rejects upload of unsupported file type", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("photo-badtype") });

		const res = await agent
			.put(`/api/v1/students/${user.userId}/photo`)
			.attach("photo", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" });

		expect(res.status).toBe(400);
	});

	test("deletes an existing photo and clears profilePhotoUrl", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("photo-delete") });

		await agent
			.put(`/api/v1/students/${user.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		const res = await agent.delete(`/api/v1/students/${user.userId}/photo`);

		expect(res.status).toBe(200);
		expect(res.body.data.profilePhotoUrl).toBeNull();
	});

	test("cannot upload a photo to another user's profile", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("photo-target") });
		const { agent: attackerAgent } = await registerStudent({ email: uniqueEmail("photo-attacker") });

		const res = await attackerAgent
			.put(`/api/v1/students/${target.userId}/photo`)
			.attach("photo", tinyJpegBuffer(), { filename: "avatar.jpg", contentType: "image/jpeg" });

		expect(res.status).toBe(403);
	});
});

describe("GET /students/:userId/contact/reveal", () => {
	test("verified authenticated user bypasses the guest quota and gets full contact", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("reveal-target") });
		const { agent: viewerAgent } = await registerStudent({ email: uniqueEmail("reveal-viewer") });

		const res = await viewerAgent.get(`/api/v1/students/${target.userId}/contact/reveal`);

		expect(res.status).toBe(200);
		expect(res.body.data.user_id).toBe(target.userId);
	});

	test("guest (no auth) can reveal within free quota", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("reveal-guest-target") });

		const res = await request(app).get(`/api/v1/students/${target.userId}/contact/reveal`);

		expect(res.status).toBe(200);
		expect(res.body.data.email).toEqual(expect.any(String));
	});

	test("sets Cache-Control: no-store", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("reveal-cache-target") });

		const res = await request(app).get(`/api/v1/students/${target.userId}/contact/reveal`);

		expect(res.headers["cache-control"]).toBe("no-store");
	});

	test("404 for a non-existent target user", async () => {
		const res = await request(app).get(`/api/v1/students/00000000-0000-0000-0000-000000000000/contact/reveal`);
		expect(res.status).toBe(404);
	});
});

describe("GET /students/:userId/preferences, PUT /students/:userId/preferences", () => {
	test("returns empty array when no preferences set", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("prefs-empty") });

		const res = await agent.get(`/api/v1/students/${user.userId}/preferences`);

		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([]);
	});

	test("sets and retrieves preferences", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("prefs-set") });

		const putRes = await agent.put(`/api/v1/students/${user.userId}/preferences`).send({
			preferences: [
				{ preferenceKey: "smoking", preferenceValue: "non_smoker" },
				{ preferenceKey: "food_habit", preferenceValue: "vegetarian" },
			],
		});

		expect(putRes.status).toBe(200);
		expect(putRes.body.data).toHaveLength(2);

		const getRes = await agent.get(`/api/v1/students/${user.userId}/preferences`);
		expect(getRes.body.data).toHaveLength(2);
		expect(getRes.body.data.map((p) => p.preferenceKey).sort()).toEqual(["food_habit", "smoking"]);
	});

	test("rejects an invalid preferenceValue for a known key", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("prefs-invalid") });

		const res = await agent.put(`/api/v1/students/${user.userId}/preferences`).send({
			preferences: [{ preferenceKey: "smoking", preferenceValue: "sometimes" }],
		});

		expect(res.status).toBe(400);
	});

	test("cannot read another user's preferences (403)", async () => {
		const { user: target } = await registerStudent({ email: uniqueEmail("prefs-target") });
		const { agent: viewerAgent } = await registerStudent({ email: uniqueEmail("prefs-viewer") });

		const res = await viewerAgent.get(`/api/v1/students/${target.userId}/preferences`);

		expect(res.status).toBe(403);
	});

	test("duplicate keys in payload are deduped, last write wins", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("prefs-dedupe") });

		const res = await agent.put(`/api/v1/students/${user.userId}/preferences`).send({
			preferences: [
				{ preferenceKey: "alcohol", preferenceValue: "okay" },
				{ preferenceKey: "alcohol", preferenceValue: "not_okay" },
			],
		});

		expect(res.status).toBe(200);
		expect(res.body.data).toHaveLength(1);
		expect(res.body.data[0].preferenceValue).toBe("not_okay");
	});
});

describe("phone visibility on GET /students/:userId/profile", () => {
	test("self-view includes phone after it is set", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("phone-self") });

		await agent.put(`/api/v1/students/${user.userId}/profile`).send({ phone: "9876543210" });

		const res = await agent.get(`/api/v1/students/${user.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.phone).toBe("9876543210");
	});

	test("stranger view omits phone", async () => {
		const { agent: targetAgent, user: target } = await registerStudent({ email: uniqueEmail("phone-target") });
		await targetAgent.put(`/api/v1/students/${target.userId}/profile`).send({ phone: "9876543210" });

		const { agent: viewerAgent } = await registerStudent({ email: uniqueEmail("phone-stranger") });

		const res = await viewerAgent.get(`/api/v1/students/${target.userId}/profile`);

		expect(res.status).toBe(200);
		expect(res.body.data.phone).toBeNull();
	});

	test("PUT response always includes a phone key, even when phone wasn't updated", async () => {
		const { agent, user } = await registerStudent({ email: uniqueEmail("phone-shape") });

		const res = await agent.put(`/api/v1/students/${user.userId}/profile`).send({ bio: "no phone here" });

		expect(res.status).toBe(200);
		expect(res.body.data).toHaveProperty("phone");
		expect(res.body.data.phone).toBeNull();
	});

	test("connected party (confirmed connection) can see phone", async () => {
		const { agent: posterAgent, user: poster } = await registerStudent({ email: uniqueEmail("phone-conn-poster") });
		await posterAgent.put(`/api/v1/students/${poster.userId}/profile`).send({ phone: "9111111111" });

		const listingRes = await posterAgent.post("/api/v1/listings").send({
			listingType: "student_room",
			title: "Room for connection phone test",
			rentPerMonth: 6000,
			roomType: "single",
			totalCapacity: 2,
			availableFrom: "2026-09-01",
			addressLine: "1 Test Street",
			city: "Delhi",
			latitude: 28.6139,
			longitude: 77.209,
		});
		const listingId = listingRes.body.data.listing_id;

		const { agent: senderAgent, user: sender } = await registerStudent({ email: uniqueEmail("phone-conn-sender") });
		const interestRes = await senderAgent.post(`/api/v1/listings/${listingId}/interests`);
		const acceptRes = await posterAgent
			.patch(`/api/v1/interests/${interestRes.body.data.interestRequestId}/status`)
			.send({ status: "accepted" });
		const connectionId = acceptRes.body.data.connectionId;

		// Not confirmed yet — sender should still NOT see poster's phone.
		const beforeConfirm = await senderAgent.get(`/api/v1/students/${poster.userId}/profile`);
		expect(beforeConfirm.body.data.phone).toBeNull();

		// Confirm from both sides.
		await senderAgent.post(`/api/v1/connections/${connectionId}/confirm`);
		await posterAgent.post(`/api/v1/connections/${connectionId}/confirm`);

		const afterConfirm = await senderAgent.get(`/api/v1/students/${poster.userId}/profile`);
		expect(afterConfirm.status).toBe(200);
		expect(afterConfirm.body.data.phone).toBe("9111111111");
	});
});