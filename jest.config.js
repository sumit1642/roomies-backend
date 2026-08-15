export default {
	testEnvironment: "node",
	testTimeout: 15000, // DB round-trips + bcrypt hashing are slower than pure unit tests
	setupFilesAfterEnv: ["<rootDir>/tests/setup/jest.setup.js"],
	testMatch: ["**/tests/suites/**/*.test.js"],
	collectCoverage: false, // opt-in via --coverage flag / test:coverage script, not every run
	collectCoverageFrom: [
		"src/**/*.js",
		"!src/server.js", // entrypoint — never imported by tests, would show as 0%
		"!src/db/migrate.js", // standalone CLI script, not exercised by supertest
		"!src/db/seeds/**", // one-time ETL scripts, not part of the request path
	],
	coverageDirectory: "coverage",
	coverageReporters: ["text", "html", "lcov"],
};
