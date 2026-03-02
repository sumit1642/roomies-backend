// tests/auth.middleware.test.js
//
// Integration tests for the authenticate middleware.
//
// Rather than testing the middleware in isolation (unit test style), we test
// it through a real endpoint — GET /api/v1/auth/me — which is protected by
// authenticate and does nothing except return req.user. This gives us full
// middleware behaviour (cookie parsing, token extraction priority, silent
// refresh, account status checks) without needing a purpose-built test route.
//
// Test groups:
//   1. Token extraction — no token, Bearer header, cookie
//   2. Token validity — malformed, expired via Bearer, expired via cookie
//   3. Silent refresh — cookie path only, not header path
//   4. Account status — suspended/banned/deactivated users rejected

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../src/app.js";
import { config } from "../src/config/env.js";
import { pool, truncateAll, createUser, loginAs, extractCookies, issueToken } from "./setup/dbHelpers.js";

const request = supertest(app);
let redis;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
	redis = createClient({ url: config.REDIS_URL });
	await redis.connect();
});

beforeEach(async () => {
	await truncateAll(redis);
});

afterAll(async () => {
	await redis.close();
	await pool.end();
});

// ─── Group 1: Token extraction ────────────────────────────────────────────────

describe("authenticate middleware — token extraction", () => {
	it("returns 401 when no token is provided (no header, no cookie)", async () => {
		const res = await request.get("/api/v1/auth/me");

		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/no token/i);
	});

	it("accepts a valid token in the Authorization Bearer header", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const { accessToken } = loginRes.body.data;

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);

		expect(res.status).toBe(200);
		expect(res.body.data.userId).toBe(user.user_id);
	});

	it("accepts a valid token in the accessToken cookie", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		const res = await request.get("/api/v1/auth/me").set("Cookie", cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.userId).toBe(user.user_id);
	});

	it("prefers the cookie over the Bearer header when both are present", async () => {
		// Two different users — cookie belongs to user A, header belongs to user B.
		// The middleware should use the cookie (user A) because cookie takes priority.
		const userA = await createUser();
		const userB = await createUser();

		const loginA = await loginAs(request, userA);
		const loginB = await loginAs(request, userB);

		const cookiesA = extractCookies(loginA);
		const tokenB = loginB.body.data.accessToken;

		const res = await request
			.get("/api/v1/auth/me")
			.set("Cookie", cookiesA)
			.set("Authorization", `Bearer ${tokenB}`);

		// Cookie takes priority — should see userA
		expect(res.status).toBe(200);
		expect(res.body.data.userId).toBe(userA.user_id);
	});

	it("populates req.user with the correct shape", async () => {
		const user = await createUser({ role: "student", is_email_verified: true });
		const loginRes = await loginAs(request, user);
		const { accessToken } = loginRes.body.data;

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);

		expect(res.status).toBe(200);
		// Verify the full req.user shape that downstream handlers depend on
		expect(res.body.data).toMatchObject({
			userId: user.user_id,
			email: user.email,
			roles: ["student"],
			isEmailVerified: true,
			accountStatus: "active",
		});
	});
});

// ─── Group 2: Token validity ──────────────────────────────────────────────────

describe("authenticate middleware — token validity", () => {
	it("returns 401 for a malformed Bearer token", async () => {
		const res = await request.get("/api/v1/auth/me").set("Authorization", "Bearer not.a.real.jwt");

		expect(res.status).toBe(401);
	});

	it("returns 401 for a token signed with a different secret", async () => {
		const user = await createUser();
		// Sign with the wrong secret — jwt.verify will reject it
		const { default: jwt } = await import("jsonwebtoken");
		const fakeToken = jwt.sign({ userId: user.user_id }, "wrong-secret", { expiresIn: "15m" });

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${fakeToken}`);

		expect(res.status).toBe(401);
	});

	it("returns 401 for an expired Bearer token — no silent refresh", async () => {
		const user = await createUser();
		const expiredToken = issueToken(user, {}, { expiresIn: "-1s" });

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${expiredToken}`);

		// Expired header token → immediate 401, no refresh attempt
		expect(res.status).toBe(401);

		// No new cookie should have been set
		const outCookies = res.headers["set-cookie"] ?? [];
		expect(outCookies.some((c) => c.startsWith("accessToken="))).toBe(false);
	});

	it("returns 401 for a token whose user has been deleted", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const { accessToken } = loginRes.body.data;

		// Soft-delete the user
		await pool.query(`UPDATE users SET deleted_at = NOW() WHERE user_id = $1`, [user.user_id]);

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);

		expect(res.status).toBe(401);
	});
});

// ─── Group 3: Silent refresh ──────────────────────────────────────────────────

describe("authenticate middleware — silent refresh (cookie path only)", () => {
	it("transparently refreshes an expired access token cookie and returns 200", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		// Replace the accessToken cookie value with an expired token
		const expiredAccessToken = issueToken(user, {}, { expiresIn: "-1s" });
		const refreshCookie = cookies.find((c) => c.startsWith("refreshToken="));
		const expiredCookie = `accessToken=${expiredAccessToken}; Path=/; HttpOnly; SameSite=Strict`;

		const res = await request.get("/api/v1/auth/me").set("Cookie", [expiredCookie, refreshCookie]);

		// Silent refresh succeeded — normal 200 response
		expect(res.status).toBe(200);
		expect(res.body.data.userId).toBe(user.user_id);

		// A new accessToken cookie must appear in the response
		const outCookies = res.headers["set-cookie"] ?? [];
		const newAccessCookie = outCookies.find((c) => c.startsWith("accessToken="));
		expect(newAccessCookie).toBeDefined();

		// The new cookie value must be different from the expired token
		const newTokenValue = newAccessCookie.split(";")[0].replace("accessToken=", "");
		expect(newTokenValue).not.toBe(expiredAccessToken);
	});

	it("returns 401 when the refresh cookie is also expired or missing", async () => {
		const user = await createUser();
		const expiredAccessToken = issueToken(user, {}, { expiresIn: "-1s" });
		const expiredCookie = `accessToken=${expiredAccessToken}; Path=/; HttpOnly; SameSite=Strict`;
		// No refresh cookie — silent refresh cannot proceed
		const fakeRefreshCookie = `refreshToken=invalid.token.here; Path=/; HttpOnly; SameSite=Strict`;

		const res = await request.get("/api/v1/auth/me").set("Cookie", [expiredCookie, fakeRefreshCookie]);

		expect(res.status).toBe(401);
	});

	it("returns 401 when the refresh token is valid JWT but not in Redis (revoked)", async () => {
		// This covers the case where the user logged out on another device,
		// removing the Redis key, but the refresh token cookie persists in
		// the browser's cookie jar.
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		// Delete the Redis key (simulates logout from another device)
		await redis.del(`refreshToken:${user.user_id}`);

		const expiredAccessToken = issueToken(user, {}, { expiresIn: "-1s" });
		const refreshCookie = cookies.find((c) => c.startsWith("refreshToken="));
		const expiredCookie = `accessToken=${expiredAccessToken}; Path=/; HttpOnly; SameSite=Strict`;

		const res = await request.get("/api/v1/auth/me").set("Cookie", [expiredCookie, refreshCookie]);

		expect(res.status).toBe(401);
	});
});

// ─── Group 4: Account status ──────────────────────────────────────────────────

describe("authenticate middleware — account status checks", () => {
	for (const status of ["suspended", "banned", "deactivated"]) {
		it(`returns 401 for a ${status} user even with a valid token`, async () => {
			const user = await createUser({ account_status: status });
			// issueToken bypasses the login endpoint — we need a valid-signature
			// token for a user whose account status is not 'active'
			const token = issueToken(user);

			const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);

			expect(res.status).toBe(401);
			expect(res.body.message.toLowerCase()).toContain(status);
		});
	}
});
