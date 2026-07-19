/**
 * ============================================================================
 * LAYER 1 — ActivityPub RUNTIME ISOLATION & B7 CONTRACT
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The other ActivityPub unit test (tests/services/activitypub.test.js) mocks
 * `getFedify` and hands the service a *fake* federation object. This file uses
 * the REAL library (no getFedify mock) and boots Express with AP enabled.
 *
 * The assertions cover the fixed B7 bridge: WebFinger and actor JSON resolve,
 * junk inbox traffic is isolated, and initActivityPub exposes Fedify's real
 * `.fetch(Request)` entrypoint, never the old fictional `.handle()` call.
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

test('B7 resolves WebFinger and actor JSON for all four actors', async () => {
   const host = new URL(baseUrl).host;
   for (const handle of ['video', 'ghostyles', 'news', 'clipboard']) {
      const webfinger = await fetch(`${baseUrl}/.well-known/webfinger?resource=acct:${handle}@${host}`, {
         headers: { Accept: 'application/jrd+json' }
      });
      assert.equal(webfinger.status, 200, `WebFinger for ${handle} resolves`);
      const jrd = await webfinger.json();
      assert.ok(Array.isArray(jrd.links), 'WebFinger returns JRD links');

      const actor = await fetch(`${baseUrl}/federation/actors/${handle}`, {
         headers: { Accept: 'application/activity+json' }
      });
      assert.equal(actor.status, 200, `actor ${handle} resolves`);
      const actorJson = await actor.json();
      assert.equal(actorJson.preferredUsername, handle);
      assert.ok(actorJson.publicKey, 'actor exposes persisted key material');
   }
});

test('B1 holds under AP=on: junk inbox traffic is isolated and the process survives', async () => {
   const junk = await fetch(`${baseUrl}/federation/actors/video/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: '{"not":"a valid activity"}'
   });
   assert.ok(junk.status >= 400 && junk.status < 500, 'junk inbox payload gets a clean HTTP error');

   const actor = await fetch(`${baseUrl}/federation/actors/video`, {
      method: 'GET',
      headers: { Accept: 'application/activity+json' }
   });
   assert.equal(actor.status, 200, 'server still serves AP after junk inbox POST');

   const ping = await fetch(`${baseUrl}/api/uploads`, { method: 'DELETE' });
   assert.ok(ping.status >= 400, 'server is still responding after the AP failure');
});

test('B7 contract: initActivityPub() builds a real Fedify object whose HTTP entrypoint is .fetch, not .handle', async () => {
   const federation = await initActivityPub();

   assert.equal(typeof federation.fetch, 'function',
      'real Fedify exposes .fetch(request) — the middleware must call this');
   assert.equal(typeof federation.handle, 'undefined',
      '.handle does not exist in Fedify 1.x');
});
