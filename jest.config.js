/**
 * Jest configuration for the Ghostmaxxing backend.
 *
 * There are two test *layers* (see MILESTONE-backend-stabilization.md §5):
 *
 *   Layer 1 (mock / CI, the default `npm test`):
 *     - Runs entirely offline against the in-memory SQLite DB and a temp
 *       storage dir. ffmpeg/ffprobe are mocked at their boundary.
 *     - This is everything under backend/tests/ EXCEPT backend/tests/online/.
 *
 *   Layer 2 (online / pre-launch, `npm run test:online`):
 *     - Runs against a REAL deployed instance reachable at $TEST_BASE_URL,
 *       through nginx, with ActivityPub actually enabled.
 *     - Lives under backend/tests/online/ and is IGNORED by the default run so
 *       CI never accidentally hits a live server.
 */
module.exports = {
   testEnvironment: 'node',
   // Default (Layer 1) run must never touch the online suite.
   testPathIgnorePatterns: ['/node_modules/', '/backend/tests/online/'],
   collectCoverageFrom: [
      'backend/src/**/*.js',
      '!backend/src/admin/**'
   ],
   // A single worker keeps the shared in-memory SQLite handle and the
   // module-level federation singleton deterministic across files.
   maxWorkers: 1
};
