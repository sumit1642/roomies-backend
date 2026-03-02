// tests/setup/globalTeardown.js
//
// Jest runs this file once after ALL test files have finished. It is the
// right place to close any shared infrastructure (database pool, Redis
// connection) that was opened during the suite.
//
// Right now this is a no-op placeholder. Each test file manages its own
// connections via afterAll() hooks. This file exists so jest.config.js
// has a valid globalTeardown target and future shared teardown logic has
// a clear home without requiring a config change later.

export default async function globalTeardown() {
	// Future: if a shared pg.Pool or Redis client is opened in globalSetup,
	// close it here. Example:
	//   await sharedPool.end();
	//   await sharedRedis.close();
}
