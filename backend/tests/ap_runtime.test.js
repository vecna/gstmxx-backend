/**
 * ============================================================================
 * LAYER 1 — ActivityPub RUNTIME ISOLATION & B7 CONTRACT
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The other ActivityPub unit test (tests/services/activitypub.test.js) mocks
 * `getFedify` and hands the service a *fake* federation object. That fake has a
 * `.handle()` method, so the test passes — but the REAL @fedify/fedify 1.x
 * object has no `.handle()`; its HTTP entrypoint is `.fetch(request)`. In other
 * words, the existing mock encodes a fictional API as "correct" and therefore
 * cannot catch the actual B7 defect.
 *
 * This file uses the REAL library (no getFedify mock) to assert two things that
 * are both true today and that a human needs to see clearly:
 *
 *   1. B1 (crash isolation) HOLDS even though B7 is unfinished: turning
 *      ActivityPub on and hitting a federation route does not crash the
 *      process — the request is isolated and the server keeps serving.
 *
 *   2. The correct B7 integration target: the federation object built by our
 *      own initActivityPub() exposes `.fetch` (the real Fedify HTTP entrypoint)
 *      and NOT `.handle`. The Express middleware must be rewritten to call
 *      `.fetch` (or use @fedify/express's integrateFederation). This test pins
 *      that contract so the eventual fix has something to satisfy.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not assert that WebFinger or actor JSON resolve — they don't yet,
 * because the middleware bridge is still wrong. That end-to-end proof lives in
 * the Layer 2 online suite and is expected to go green the day B7 is completed.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A private temp root so this file's in-memory-adjacent storage never collides
// with the other Layer 1 files that also boot the app.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-ap-runtime-'));

// IMPORTANT: env must be set BEFORE requiring server/paths, because those read
// process.env at module-load time. Here we ENABLE ActivityPub on purpose.
process.env.NODE_ENV = 'test';
process.env.GSTMXX_ENABLE_AP = '1';                     // <-- the whole point
process.env.GSTMXX_BASE_URL = 'http://127.0.0.1';
process.env.GSTMXX_DATA_DIR = path.join(tempRoot, 'data');
process.env.GSTMXX_STORAGE_DIR = path.join(tempRoot, 'storage');

const { createApp } = require('../src/server');
const { initActivityPub } = require('../src/services/activitypub');

let server;
let baseUrl;

beforeAll(async () => {
   server = createApp().listen(0);
   await new Promise((resolve) => server.once('listening', resolve));
   baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
   if (server) await new Promise((resolve) => server.close(resolve));
   fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('B1 holds under AP=on: a federation request is isolated and the process survives', async () => {
   // With ActivityPub enabled the (still-broken) global AP middleware runs on
   // every request and throws. B1's job is to make sure that throw is isolated:
   // the request gets an error response instead of killing Node.
   const fed = await fetch(`${baseUrl}/federation/actors/video`, {
      method: 'GET',
      headers: { Accept: 'application/activity+json' }
   });
   // We assert only that it's a clean HTTP error, not a socket hang-up / crash.
   assert.ok(fed.status >= 400 && fed.status < 600, 'must return an HTTP status, not crash');

   // The real proof of isolation: a subsequent request still gets served.
   const ping = await fetch(`${baseUrl}/api/uploads`, { method: 'DELETE' });
   assert.ok(ping.status >= 400, 'server is still responding after the AP failure');
});

test('B7 contract: initActivityPub() builds a real Fedify object whose HTTP entrypoint is .fetch, not .handle', async () => {
   const federation = await initActivityPub();

   // This is the crux of the B7 defect. The middleware currently calls
   // fed.handle(req); the real object has no such method. Pinning both sides
   // here makes the required fix unambiguous.
   assert.equal(typeof federation.fetch, 'function',
      'real Fedify exposes .fetch(request) — the middleware must call this');
   assert.equal(typeof federation.handle, 'undefined',
      '.handle does not exist in Fedify 1.x; the current middleware bridge is wrong (B7 unfinished)');
});
