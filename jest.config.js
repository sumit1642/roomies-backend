// jest.config.js
//
// Jest requires explicit ESM configuration when the project uses
// "type": "module" in package.json. Without these settings Jest tries
// to parse ES module syntax (import/export) with its CommonJS transform
// pipeline and throws a SyntaxError before any test runs.
//
// The test script in package.json already passes the Node flag:
//   node --experimental-vm-modules node_modules/.bin/jest
// This file tells Jest itself how to behave once Node hands it control.

export default {
	// Use the experimental ESM-aware test runner. This is the correct
	// pairing with --experimental-vm-modules on the Node side.
	// Do NOT use 'jest-environment-node' with a babel transform here —
	// that would silently downcompile your ESM to CJS and hide import errors.
	testEnvironment: "node",

	// Tell Jest which files are tests. The double-star glob covers any depth
	// under src/. Files outside src/ (config files, scripts) are ignored.
	testMatch: ["**/src/**/*.test.js", "**/tests/**/*.test.js"],

	// Jest's default transform tries to process files through Babel/CJS.
	// An empty transform map tells Jest: "do not transform anything — treat
	// all files as native ESM." This works because we're running under
	// --experimental-vm-modules which handles ESM natively.
	transform: {},

	// How long (ms) a single test can run before Jest marks it as failed.
	// 10 seconds is generous for unit tests but necessary for integration
	// tests that hit a real database and Redis over loopback.
	testTimeout: 10000,

	// Runs once before the entire test suite starts — used to set ENV_FILE
	// so src/config/env.js loads .env.test instead of .env.local.
	// This is the seam that prevents tests from ever touching your dev DB.
	globalSetup: "./tests/setup/globalSetup.js",

	// Runs once after every test file completes — tears down shared resources
	// (DB pool, Redis connection) that were opened for the suite.
	globalTeardown: "./tests/setup/globalTeardown.js",

	// Coverage configuration — only collect from src/, exclude generated files.
	collectCoverageFrom: [
		"src/**/*.js",
		"!src/server.js", // entry point — not unit-testable
		"!src/logger/index.js", // trivial config wrapper
	],
};
