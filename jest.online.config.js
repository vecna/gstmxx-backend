/**
 * Jest configuration for the Layer 2 (online) suite ONLY.
 *
 * Invoked via `npm run test:online`. Unlike the default config, this one
 * *targets* backend/tests/online/ and nothing else, so the two layers can
 * never be run by accident together:
 *
 *   - `npm test`         -> Layer 1 only (online folder ignored)
 *   - `npm run test:online` -> Layer 2 only (this file)
 *
 * The suite additionally guards itself at runtime: if TEST_BASE_URL is not
 * set it prints a skip banner and asserts nothing against a live server, so
 * running it with no target is a no-op rather than a failure.
 */
module.exports = {
   testEnvironment: 'node',
   roots: ['<rootDir>/backend/tests/online'],
   testMatch: ['**/*.online.test.js'],
   // Online round-trips (federation delivery, ffmpeg on the server, Mastodon
   // Accept) are slow; give them room before Jest kills the run.
   testTimeout: 120000,
   maxWorkers: 1
};
