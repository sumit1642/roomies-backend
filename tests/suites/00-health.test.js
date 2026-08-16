import request from "supertest";
import { app } from "../../src/app.js";

describe("GET /api/v1/health", () => {
	test("returns 200 with database and redis both ok", async () => {
		const res = await request(app).get("/api/v1/health");

		expect(res.status).toBe(200);
		expect(res.body.status).toBe("ok");
		expect(res.body.services.database).toBe("ok");
		expect(res.body.services.redis).toBe("ok");
		expect(res.body.timestamp).toEqual(expect.any(String));
	});
});
