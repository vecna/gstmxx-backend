# Testing guide

The test suite is split into two local layers:

- Classic unit and integration tests in `test/*.test.js`.
- Full OpenAPI cycle test in `test/openapi.full-cycle.test.js` with helpers in
  `test/openapi-cycle/`.

This split keeps the default test and coverage runs focused on the classic suite
while allowing the long, stateful OpenAPI cycle to be invoked explicitly.

## Commands

```sh
npm test
npm run test:coverage
npm run test:full-cycle
```

### What each command runs

- `npm test`
  Runs only top-level test files under `test/` and excludes
  `test/openapi.full-cycle.test.js`.

- `npm run test:coverage`
  Runs the same test set as `npm test` through c8. The full-cycle suite is
  excluded from coverage by scope, because this command uses the same file list
  as the default test command.

- `npm run test:full-cycle`
  Runs only `test/openapi.full-cycle.test.js`.

## Quick assessment (2026-08-06)

These checks were run after the split, without attempting any test fixes.

### npm test

- Result: failed.
- Summary: 105 tests, 104 pass, 1 fail.
- Failure: `test/profile.test.js` due to `EADDRINUSE` on `127.0.0.1:4071`.

### npm run test:coverage

- Result: failed.
- Summary: 105 tests, 104 pass, 1 fail.
- Failure: same `EADDRINUSE` issue in `test/profile.test.js`.
- Coverage still produced a report; totals from this run:
  statements 74.62%, branches 77.2%, functions 74.32%, lines 74.62%.

### npm run test:full-cycle

- Result: failed.
- Summary: 55 tests, 53 pass, 2 fail.
- Primary failing assertion:
  `test/openapi-cycle/step5-digest-check.js` in
  `GET /api/posts after digest` (`false !== true`).

## Notes

- Running default tests and full-cycle tests in parallel can increase chances of
  port collisions.
- If you want the full-cycle HTTP trace during investigation, leave
  `GSTMXX_CYCLE_TRACE` enabled (default behavior in this suite).
