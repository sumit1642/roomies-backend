// tests/setup/testAuth.js
//
// Registers a user through the real /auth/register endpoint (not a JWT
// shortcut) so tests also exercise the real register -> cookie ->
// authenticate middleware chain. Returns a supertest agent that carries the
// resulting HttpOnly cookies on subsequent requests, plus the created user
// and the credentials used, in case a test needs to log in again explicitly
// (e.g. to test /auth/login itself).

import request from "supertest";
import { app } from "../../src/app.js";
import jwt from "jsonwebtoken";
import { config } from "../../src/config/env.js";

export const registerUser = async ({ role = "student", ...overrides } = {}) => {
	const agent = request.agent(app);
	const email = overrides.email ?? `test.${Date.now()}.${Math.random().toString(36).slice(2)}@college.edu`;
	const body = {
		email,
		password: "TestPass123!",
		role,
		fullName: "Test User",
		...(role === "pg_owner" ? { businessName: "Test PG" } : {}),
		...overrides,
	};
	const res = await agent.post("/api/v1/auth/register").send(body);

	if (res.status !== 201) {
		throw new Error(
			`registerUser: expected 201 from /auth/register, got ${res.status}. ` + `Body: ${JSON.stringify(res.body)}`,
		);
	}

	return { agent, user: res.body.data.user, email, password: body.password };
};

// Convenience for tests that need a second independent user (e.g. testing
// forbidden cross-user access, or a poster + an interested student).
export const registerStudent = (overrides = {}) => registerUser({ role: "student", ...overrides });
export const registerPgOwner = (overrides = {}) => registerUser({ role: "pg_owner", ...overrides });
// Builds an already-expired access-token JWT with the same claim shape
// issueAccessToken produces, for exercising authenticate.js's silent-refresh
// path directly (bypassing the normal ~15m wait for a real token to expire).
export const expiredAccessToken = ({ userId, email, roles = [], sid }) =>
	jwt.sign({ userId, email, roles, sid, purpose: "session_access" }, config.JWT_SECRET, { expiresIn: -10 });

// Fetches the sid of the agent's current session via GET /auth/sessions,
// which every registered agent already has exactly one of.
export const getCurrentSid = async (agent) => {
	const res = await agent.get("/api/v1/auth/sessions");
	const current = res.body.data.find((s) => s.isCurrent);
	if (!current) throw new Error("getCurrentSid: no current session found");
	return current.sid;
};
