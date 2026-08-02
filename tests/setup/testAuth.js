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
