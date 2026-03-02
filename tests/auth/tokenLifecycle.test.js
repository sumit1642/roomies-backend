// tests/auth/tokenLifecycle.test.js
//
// Integration tests for the token lifecycle:
//   POST /api/v1/auth/refresh
//   POST /api/v1/auth/logout
//   GET  /api/v1/auth/me
//
// These tests are inherently stateful — they involve Redis (refresh token store)
// and rely on tokens issued by the login endpoint. The beforeEach truncation
// plus Redis FLUSHDB ensures each test starts from a completely clean state.
//
// Test groups:
//   1. Refresh — Android body path, browser cookie path, failure cases
//   2. Logout — cookie clearing, Redis cleanup, idempotency
//   3. /me — happy path, missing token, expired token behaviours

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "@jest/globals";
import supertest from "supertest";
import { createClient } from "redis";
import { app } from "../../src/app.js";
import { config } from "../../src/config/env.js";
import { pool, truncateAll, createUser, loginAs, extractCookies, issueToken } from "../setup/dbHelpers.js";

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

// ─── Group 1: Refresh ─────────────────────────────────────────────────────────

describe("POST /api/v1/auth/refresh", () => {
	it("issues a new access token when given a valid refresh token in the body (Android path)", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const { refreshToken } = loginRes.body.data;

		const res = await request.post("/api/v1/auth/refresh").send({ refreshToken });

		expect(res.status).toBe(200);
		expect(res.body.data.accessToken).toBeTruthy();
		// Refresh endpoint only returns a new access token, not a new refresh token
		expect(res.body.data.refreshToken).toBeUndefined();
	});

	it("issues a new access token when the refresh token is in a cookie and body is empty (browser path)", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		// Browser sends no body — token comes from the HttpOnly cookie
		const res = await request.post("/api/v1/auth/refresh").set("Cookie", cookies).send({}); // explicitly empty body

		expect(res.status).toBe(200);
		expect(res.body.data.accessToken).toBeTruthy();
	});

	it("returns 401 when the refresh token has been revoked (after logout)", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const { refreshToken } = loginRes.body.data;
		const cookies = extractCookies(loginRes);

		// Log out — this deletes the Redis key
		await request.post("/api/v1/auth/logout").set("Cookie", cookies);

		// Attempting to refresh with the now-revoked token must fail
		const res = await request.post("/api/v1/auth/refresh").send({ refreshToken });

		expect(res.status).toBe(401);
	});

	it("returns 401 when the refresh token is tampered with", async () => {
		const res = await request.post("/api/v1/auth/refresh").send({ refreshToken: "this.is.not.a.real.jwt" });

		expect(res.status).toBe(401);
	});

	it("returns 401 when no refresh token is provided via body or cookie", async () => {
		const res = await request.post("/api/v1/auth/refresh").send({});

		expect(res.status).toBe(401);
	});

	it("returns 401 when the account is suspended after the refresh token was issued", async () => {
		// This tests a real security scenario: a user is logged in, an admin
		// suspends their account, and the user tries to get a new access token.
		// Even with a valid refresh token, the suspension must be enforced.
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const { refreshToken } = loginRes.body.data;

		// Suspend the account after the token was issued
		await pool.query(`UPDATE users SET account_status = 'suspended' WHERE user_id = $1`, [user.user_id]);

		const res = await request.post("/api/v1/auth/refresh").send({ refreshToken });

		expect(res.status).toBe(401);
	});
});

// ─── Group 2: Logout ──────────────────────────────────────────────────────────

describe("POST /api/v1/auth/logout", () => {
	it("returns 200 and clears auth cookies", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		const res = await request.post("/api/v1/auth/logout").set("Cookie", cookies);

		expect(res.status).toBe(200);

		// The response should clear both cookies. Browsers interpret a cookie
		// with an expired date or maxAge=0 as a deletion instruction.
		// Supertest surfaces this as Set-Cookie headers with empty values or
		// past expiry dates.
		const outCookies = res.headers["set-cookie"] ?? [];
		const clearsAccess = outCookies.some((c) => c.startsWith("accessToken=;") || c.includes("accessToken=;"));
		const clearsRefresh = outCookies.some((c) => c.startsWith("refreshToken=;") || c.includes("refreshToken=;"));
		expect(clearsAccess).toBe(true);
		expect(clearsRefresh).toBe(true);
	});

	it("deletes the refresh token from Redis", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		// Confirm the key exists before logout
		const beforeLogout = await redis.get(`refreshToken:${user.user_id}`);
		expect(beforeLogout).toBeTruthy();

		await request.post("/api/v1/auth/logout").set("Cookie", cookies);

		// Key must be gone after logout
		const afterLogout = await redis.get(`refreshToken:${user.user_id}`);
		expect(afterLogout).toBeNull();
	});

	it("is idempotent — calling logout twice returns 200 both times", async () => {
		// The second logout call has no Redis key to delete, but it should
		// not throw or return an error. Idempotency matters for retry-safe clients.
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		const first = await request.post("/api/v1/auth/logout").set("Cookie", cookies);
		expect(first.status).toBe(200);

		const second = await request.post("/api/v1/auth/logout").set("Cookie", cookies);
		expect(second.status).toBe(200);
	});

	it("returns 401 when called without a token", async () => {
		const res = await request.post("/api/v1/auth/logout");
		expect(res.status).toBe(401);
	});
});

// ─── Group 3: GET /auth/me ────────────────────────────────────────────────────

describe("GET /api/v1/auth/me", () => {
	it("returns the authenticated user's identity with a valid Bearer token", async () => {
		const user = await createUser({ role: "student", is_email_verified: true });
		const loginRes = await loginAs(request, user);
		const { accessToken } = loginRes.body.data;

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);

		expect(res.status).toBe(200);
		expect(res.body.data.userId).toBe(user.user_id);
		expect(res.body.data.email).toBe(user.email);
		expect(res.body.data.roles).toContain("student");
	});

	it("returns the authenticated user's identity with a valid cookie", async () => {
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		const res = await request.get("/api/v1/auth/me").set("Cookie", cookies);

		expect(res.status).toBe(200);
		expect(res.body.data.email).toBe(user.email);
	});

	it("returns 401 when no token is provided", async () => {
		const res = await request.get("/api/v1/auth/me");
		expect(res.status).toBe(401);
		expect(res.body.message).toMatch(/no token/i);
	});

	it("returns 401 for a malformed Bearer token", async () => {
		const res = await request.get("/api/v1/auth/me").set("Authorization", "Bearer this-is-garbage");

		expect(res.status).toBe(401);
	});

	it("returns 401 when a Bearer token is expired — no silent refresh attempt", async () => {
		// An expired token via Authorization header must not trigger silent refresh.
		// Silent refresh is a browser-only feature (cookie source only).
		// Android clients are expected to call POST /auth/refresh explicitly.
		const user = await createUser();
		const expiredToken = issueToken(user, {}, { expiresIn: "-1s" });

		const res = await request.get("/api/v1/auth/me").set("Authorization", `Bearer ${expiredToken}`);

		// Must be 401 — not 200 with a silently refreshed session
		expect(res.status).toBe(401);

		// No new cookie should have been set — silent refresh was not attempted
		const cookies = res.headers["set-cookie"] ?? [];
		expect(cookies.some((c) => c.startsWith("accessToken="))).toBe(false);
	});

	it("performs silent refresh and returns 200 when cookie token is expired but refresh cookie is valid", async () => {
		// This is the browser silent-refresh flow:
		//   1. Access token cookie has expired
		//   2. Refresh token cookie is still valid
		//   3. authenticate middleware detects this, issues a new access token,
		//      sets it as a cookie on the response, and continues the request
		//   4. The client receives 200 and a new accessToken cookie — no visible interruption
		const user = await createUser();
		const loginRes = await loginAs(request, user);
		const cookies = extractCookies(loginRes);

		// Craft an expired access token but keep the real refresh token cookie
		const expiredAccessToken = issueToken(user, {}, { expiresIn: "-1s" });

		// Replace the accessToken cookie value with the expired one, keep refreshToken
		const refreshCookie = cookies.find((c) => c.startsWith("refreshToken="));
		const expiredAccessCookie = `accessToken=${expiredAccessToken}; Path=/; HttpOnly; SameSite=Strict`;

		const res = await request.get("/api/v1/auth/me").set("Cookie", [expiredAccessCookie, refreshCookie]);

		// Silent refresh succeeded — request continues normally
		expect(res.status).toBe(200);
		expect(res.body.data.email).toBe(user.email);

		// A new accessToken cookie must be set on the response
		const outCookies = res.headers["set-cookie"] ?? [];
		expect(outCookies.some((c) => c.startsWith("accessToken="))).toBe(true);
	});

	it("returns 401 when both the access token cookie and refresh token cookie are expired", async () => {
		const user = await createUser();

		// No real login — craft both tokens as expired directly
		const expiredAccessToken = issueToken(user, {}, { expiresIn: "-1s" });
		// Use a deliberately invalid refresh token — not in Redis, so validation fails
		const expiredAccessCookie = `accessToken=${expiredAccessToken}; Path=/; HttpOnly; SameSite=Strict`;
		const fakeRefreshCookie = `refreshToken=invalid.refresh.token; Path=/; HttpOnly; SameSite=Strict`;

		const res = await request.get("/api/v1/auth/me").set("Cookie", [expiredAccessCookie, fakeRefreshCookie]);

		expect(res.status).toBe(401);
	});
});
