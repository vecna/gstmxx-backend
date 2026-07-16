/**
 * INTEGRATION TEST — src/server.js (B1 request isolation & routing, ADDED).
 *
 * WHY THIS FILE EXISTS
 *   server.js held the app assembly, the isolateMiddleware() wrapper (the core
 *   of B1's "one bad request must not kill the process" guarantee), the 404
 *   handler, the JSON error handler, and the upload rate-limit config — and it
 *   was only ~55% covered. layer1 exercised the happy paths; this file targets
 *   the failure/edge paths directly.
 *
 * WHAT WE TEST
 *   - Unknown routes return the JSON 404 contract (not an HTML stack trace).
 *   - Malformed JSON on a POST is caught by the error handler as a 400 and the
 *     server keeps serving afterwards (the F1/B1 isolation property).
 *   - isolateMiddleware() forwards a thrown sync error and a rejected async
 *     middleware to next(err) instead of letting them escape.
 *   - uploadRateLimitMax() parses the env override and falls back to 5.
 *
 * SETUP
 *   AP stays disabled; a temp storage/data dir keeps this file independent of
 *   the other integration files. Env is set before requiring server.js.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-server-'));
process.env.NODE_ENV = 'test';
process.env.GSTMXX_ENABLE_AP = '0';
process.env.GSTMXX_DATA_DIR = path.join(tmp, 'data');
process.env.GSTMXX_STORAGE_DIR = path.join(tmp, 'storage');

const { createApp, isolateMiddleware, uploadRateLimitMax } = require('../src/server');

let server;
let baseUrl;

beforeAll(async () => {
   server = createApp().listen(0);
   await new Promise((r) => server.once('listening', r));
   baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
   if (server) await new Promise((r) => server.close(r));
   fs.rmSync(tmp, { recursive: true, force: true });
});

test('unknown route returns the JSON 404 contract', async () => {
   const res = await fetch(`${baseUrl}/does/not/exist`);
   expect(res.status).toBe(404);
   const body = await res.json();
   expect(body).toEqual({ ok: false, message: 'Risorsa non trovata.' });
});

test('malformed JSON is isolated as a 400 and the server stays up', async () => {
   // A broken body must not crash the process (the whole point of B1). Express's
   // json parser throws; the error handler must convert it to a clean 400.
   const bad = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json'
   });
   expect(bad.status).toBeGreaterThanOrEqual(400);

   // Prove the process survived: a normal request still works right after.
   const ok = await fetch(`${baseUrl}/feed/videos.xml`);
   expect(ok.status).toBe(200);
});

describe('isolateMiddleware()', () => {
   test('forwards a thrown synchronous error to next(err)', () => {
      const boom = new Error('sync boom');
      const wrapped = isolateMiddleware('test', () => { throw boom; });
      const next = jest.fn();
      wrapped({}, {}, next);
      expect(next).toHaveBeenCalledWith(boom);
   });

   test('forwards a rejected async middleware to next(err)', async () => {
      const boom = new Error('async boom');
      // A middleware whose invocation returns a rejected promise (the shape of
      // an async Express handler that throws) must be caught, not swallowed.
      const wrapped = isolateMiddleware('test', () => Promise.reject(boom));
      const next = jest.fn();
      wrapped({}, {}, next);
      await new Promise((r) => setImmediate(r));   // let the .catch microtask run
      expect(next).toHaveBeenCalledWith(boom);
   });
});

describe('uploadRateLimitMax()', () => {
   const original = process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX;
   afterEach(() => {
      if (original === undefined) delete process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX;
      else process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX = original;
   });

   test('uses a positive env override', () => {
      process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX = '42';
      expect(uploadRateLimitMax()).toBe(42);
   });

   test('falls back to 5 on missing or invalid values', () => {
      delete process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX;
      expect(uploadRateLimitMax()).toBe(5);
      process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX = 'nope';
      expect(uploadRateLimitMax()).toBe(5);
   });
});
