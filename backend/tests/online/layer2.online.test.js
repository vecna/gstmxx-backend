/**
 * ============================================================================
 * LAYER 2 — ONLINE / PRE-LAUNCH TEST SUITE  (scaffolding)
 * ============================================================================
 *
 * WHAT THIS FILE IS
 * -----------------
 * Layer 1 (the default `npm test`) proves the *code* is internally consistent
 * against mocks: in-memory SQLite, a temp storage dir, ffmpeg/ffprobe faked at
 * their boundary, ActivityPub disabled. It can never prove that a *real*
 * deployment behaves correctly, because the things most likely to break in
 * production are exactly the things Layer 1 mocks away:
 *
 *   - nginx routing (static frontend vs. proxied /api /feed /federation /.well-known)
 *   - TLS termination and Basic-Auth-only-over-HTTPS
 *   - real ffmpeg transcode + thumbnail generation on the VPS
 *   - Fedify's real HTTP surface (WebFinger, actor JSON) — see the B7 note below
 *   - actual ActivityPub delivery to a real Mastodon inbox (Follow -> Accept -> Create)
 *
 * This suite is the "online environment" half of the two-layer strategy in
 * MILESTONE-backend-stabilization.md §5. It runs against a already-deployed
 * instance identified by the TEST_BASE_URL env var, e.g.:
 *
 *     TEST_BASE_URL=https://ghostmaxxing.vecna.eu npm run test:online
 *
 * WHAT STATE IT IS IN
 * -------------------
 * SCAFFOLDING. The structure, the ordering, the assertions we *want*, and the
 * cleanup discipline are all here and commented. Several checks are marked
 * `test.todo(...)` or throw `NotImplemented` where they need a real credential
 * (a Mastodon test account) or a decision that is still open (see the B7/B12
 * notes). The intent is that a human filling these in has a precise checklist,
 * not a blank page.
 *
 * SAFETY RAILS
 * ------------
 *   1. If TEST_BASE_URL is unset, the whole suite becomes an explained skip —
 *      it never invents a target and never fails "empty".
 *   2. Every artifact this suite creates on the live server is torn down via
 *      the public delete-token endpoint (B3) in afterEach/afterAll, so an
 *      online run leaves no residue in the moderation queue or on disk.
 *   3. It never approves/publishes on a production instance unless
 *      TEST_ALLOW_PUBLISH=1 is *also* set, because publishing federates.
 *
 * ---------------------------------------------------------------------------
 */

'use strict';

const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Configuration pulled from the environment. Nothing here is hard-coded to a
// real host — the suite is inert until you point it at one.
// ---------------------------------------------------------------------------
const BASE_URL = process.env.TEST_BASE_URL;                 // e.g. https://ghostmaxxing.vecna.eu
const ADMIN_USER = process.env.TEST_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.TEST_ADMIN_PASS || '';       // must be supplied for moderation checks
const ALLOW_PUBLISH = process.env.TEST_ALLOW_PUBLISH === '1';
const MASTODON_HANDLE = process.env.TEST_MASTODON_ACCT;      // e.g. @you@mastodon.social, for B8

// `describe.skip` when there is no target, with a loud, explanatory banner so a
// no-op run is obviously intentional rather than a silent pass.
const suite = BASE_URL ? describe : describe.skip;
if (!BASE_URL) {
   // eslint-disable-next-line no-console
   console.warn(
      '\n[layer2] TEST_BASE_URL is not set — skipping the entire online suite.\n' +
      '[layer2] Run against a deployed instance with, e.g.:\n' +
      '[layer2]   TEST_BASE_URL=https://ghostmaxxing.vecna.eu \\\n' +
      '[layer2]   TEST_ADMIN_PASS=... npm run test:online\n'
   );
}

// ---------------------------------------------------------------------------
// Small helpers. These are intentionally thin wrappers over fetch so the
// individual tests below read like a runbook.
// ---------------------------------------------------------------------------

/** Basic-Auth header for the moderation routes (B11). */
function authHeader() {
   return `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`;
}

/**
 * Uploads a tiny video (or clipboard PNG) to the live /api/uploads endpoint and
 * returns { uploadId, deleteToken }. The caller is responsible for deleting it
 * again (see `deleteUpload`) so the online run is residue-free.
 *
 * NOTE: this posts a *real* small media blob. On a production instance behind
 * ffprobe MIME-sniffing (B5) the payload must actually decode as video/png, or
 * the server will (correctly) 400 it. The fixture bytes below are a placeholder
 * — replace with a checked-in 1-second mp4 / 1x1 png fixture before use.
 */
async function uploadReviewClip({ kind = 'video', note = 'layer2-online-probe' } = {}) {
   const form = new FormData();
   // TODO(fixture): swap these placeholder bytes for tests/fixtures/tiny.mp4 and
   //                tests/fixtures/tiny.png so a real ffprobe accepts them.
   const blob = kind === 'clipboard'
      ? new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
      : new Blob([Buffer.from('REPLACE-WITH-REAL-MP4-FIXTURE')], { type: 'video/mp4' });
   form.set('video', blob, kind === 'clipboard' ? 'probe.png' : 'probe.mp4');
   form.set('kind', kind);
   form.set('consent_version', '2026-07-v1');   // must match the frontend consent constant
   form.set('user_note', note);

   const res = await fetch(`${BASE_URL}/api/uploads`, { method: 'POST', body: form });
   const body = await res.json().catch(() => ({}));
   return { status: res.status, body };
}

/** Deletes an upload with its own delete-token (B3). Used for teardown. */
async function deleteUpload(uploadId, deleteToken) {
   if (!uploadId || !deleteToken) return { status: 0 };
   const res = await fetch(`${BASE_URL}/api/uploads/${uploadId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': deleteToken }
   });
   return { status: res.status };
}

// Track everything we create so afterEach can always clean up, even on failure.
const createdUploads = [];

suite('Layer 2 — online / deployed instance', () => {
   afterEach(async () => {
      // Residue-free guarantee: delete every upload we created this test.
      while (createdUploads.length) {
         const { uploadId, deleteToken } = createdUploads.pop();
         await deleteUpload(uploadId, deleteToken);
      }
   });

   // ------------------------------------------------------------------
   // 1. PUBLIC UPLOAD ROUND-TRIP  (mirrors Layer 1, but over the wire)
   //    Proves nginx proxies /api/uploads to Node, that the 15MB body cap
   //    and ffprobe MIME-sniff run on the real box, and that the contract
   //    response ({ ok, uploadId, deleteToken }) is intact end-to-end.
   // ------------------------------------------------------------------
   test('public upload accepts a consented clip and returns a usable delete token', async () => {
      const { status, body } = await uploadReviewClip({ note: 'layer2 upload round-trip' });

      // A real ffprobe will reject the placeholder bytes above; until the mp4
      // fixture is wired this documents the intended contract rather than passing.
      assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true);
      assert.ok(body.uploadId, 'response must carry an uploadId');
      assert.ok(body.deleteToken, 'response must carry a deleteToken (self-service deletion)');

      createdUploads.push({ uploadId: body.uploadId, deleteToken: body.deleteToken });

      // Self-service deletion (B3) must work from a cold client with only the token.
      const gone = await deleteUpload(body.uploadId, body.deleteToken);
      assert.equal(gone.status, 200);
      createdUploads.pop(); // already deleted; don't double-delete in afterEach
   });

   test('public upload without consent_version is rejected (400)', async () => {
      // The consent gate is a hard contract requirement; the frontend promises
      // deletion, so the server must refuse anything unconsented.
      const form = new FormData();
      form.set('video', new Blob([Buffer.from('x')], { type: 'video/mp4' }), 'x.mp4');
      const res = await fetch(`${BASE_URL}/api/uploads`, { method: 'POST', body: form });
      assert.equal(res.status, 400);
   });

   // ------------------------------------------------------------------
   // 2. MODERATION VIA THE B11 PAGE  (authenticated, HTTPS-only)
   //    Proves the admin surface is reachable, Basic-Auth-gated, and that
   //    the private media preview route serves the raw incoming file.
   // ------------------------------------------------------------------
   test('moderation page and pending API require auth and are reachable over HTTPS', async () => {
      if (!ADMIN_PASS) {
         // Without a password we can only assert the gate, not what's behind it.
         const noauth = await fetch(`${BASE_URL}/api/admin/pending`);
         assert.equal(noauth.status, 401, 'admin must be Basic-Auth gated');
         return;
      }

      // B12 threat-model item: Basic Auth must never traverse plain HTTP.
      assert.ok(BASE_URL.startsWith('https://'), 'admin credentials must only be sent over TLS');

      const unauth = await fetch(`${BASE_URL}/api/admin/pending`);
      assert.equal(unauth.status, 401);

      const authed = await fetch(`${BASE_URL}/api/admin/pending`, {
         headers: { Authorization: authHeader() }
      });
      assert.equal(authed.status, 200);
      const body = await authed.json();
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.pending));
   });

   test('a moderator can preview, then approve, a queued clip end-to-end', async () => {
      if (!ADMIN_PASS) return; // covered by the auth-gate test above
      if (!ALLOW_PUBLISH) {
         // Approval federates. Refuse to publish on a live instance unless the
         // operator explicitly opts in, to avoid emitting real Create activities.
         // eslint-disable-next-line no-console
         console.warn('[layer2] skipping approve/publish path (set TEST_ALLOW_PUBLISH=1 to run it)');
         return;
      }

      const up = await uploadReviewClip({ note: 'layer2 moderation path' });
      assert.equal(up.status, 201);
      createdUploads.push({ uploadId: up.body.uploadId, deleteToken: up.body.deleteToken });

      // Private preview route (B11): the raw file lives outside any served path
      // and must only be reachable through this authenticated route.
      const preview = await fetch(`${BASE_URL}/api/admin/media/${up.body.uploadId}`, {
         headers: { Authorization: authHeader() }
      });
      assert.equal(preview.status, 200);

      // Real ffmpeg transcode + thumbnail happen here on the server (B9/video.js).
      const approve = await fetch(`${BASE_URL}/api/admin/approve/${up.body.uploadId}`, {
         method: 'POST', headers: { Authorization: authHeader() }
      });
      assert.equal(approve.status, 200);
      const approved = await approve.json();
      assert.ok(approved.publicUrl, 'approval must return a public URL to copy');

      // KNOWN DEFECT to verify here: publicUrl is BASE_URL/videos/<uploadId>, but
      // the approved file on disk is named pub-<random>.mp4 and nginx aliases
      // /videos/ -> storage/approved/. Confirm whether the public URL actually
      // resolves to the media; if it 404s, that's the id-vs-filename mismatch
      // flagged in ASSESSMENT.md and must be fixed before launch.
      const resolved = await fetch(approved.publicUrl);
      assert.equal(resolved.status, 200, 'published public URL must resolve to the media file');
   });

   // ------------------------------------------------------------------
   // 3. FEEDS THROUGH NGINX
   //    Proves the RSS endpoints are reachable at the proxied paths, are
   //    served as XML, are English (F10 fix), and parse as well-formed XML.
   // ------------------------------------------------------------------
   for (const feed of ['videos', 'news', 'ghostyles', 'all']) {
      test(`/feed/${feed}.xml is reachable, XML, and English`, async () => {
         const res = await fetch(`${BASE_URL}/feed/${feed}.xml`);
         assert.equal(res.status, 200);
         assert.match(res.headers.get('content-type') || '', /xml/);
         const xml = await res.text();
         assert.match(xml, /<language>en<\/language>/, 'feeds must be English, not it-it (F10)');
         assert.match(xml, /<rss[\s>]/, 'must be a well-formed RSS document');
         // TODO(xml): parse with a real XML parser (e.g. fast-xml-parser) and
         //            assert entity escaping, rather than regex-matching.
      });
   }

   // ------------------------------------------------------------------
   // 4. FEDERATION HTTP SURFACE  (WebFinger + actor JSON)
   //    This is where B7 lives. On the current snapshot these WILL FAIL,
   //    because the Express<->Fedify bridge calls a non-existent method
   //    (`fed.handle`) instead of `federation.fetch()` / @fedify/express's
   //    integrateFederation. See ASSESSMENT.md "Federation (B7)".
   //
   //    We keep these as first-class online assertions (not todos) precisely
   //    so this suite is the thing that turns green the day B7 is done right.
   // ------------------------------------------------------------------
   test('WebFinger resolves the four actors', async () => {
      const host = new URL(BASE_URL).host;
      for (const actor of ['video', 'ghostyles', 'news', 'clipboard']) {
         const res = await fetch(
            `${BASE_URL}/.well-known/webfinger?resource=acct:${actor}@${host}`,
            { headers: { Accept: 'application/jrd+json' } }
         );
         assert.equal(res.status, 200, `WebFinger for @${actor} must resolve (B7)`);
         const jrd = await res.json();
         assert.ok(Array.isArray(jrd.links), 'JRD must expose links');
      }
   });

   test('actor JSON exposes a real, persisted public key (B4 reachable through B7)', async () => {
      const res = await fetch(`${BASE_URL}/federation/actors/video`, {
         headers: { Accept: 'application/activity+json' }
      });
      assert.equal(res.status, 200, 'actor document must resolve (B7)');
      const actor = await res.json();
      // F2 fix: the key must be a real PEM, not the old truncated placeholder mock.
      assert.ok(actor.publicKey, 'actor must carry a publicKey');
      const pem = actor.publicKey.publicKeyPem || '';
      assert.match(pem, /BEGIN PUBLIC KEY/, 'publicKeyPem must be a real key');
      assert.ok(pem.length > 200, 'a real RSA public key PEM is far longer than the placeholder mock');
   });

   test('junk POSTed to an inbox is handled without taking down the server', async () => {
      // B7 "done when: server survives arbitrary junk POSTs to inboxes".
      const junk = await fetch(`${BASE_URL}/federation/actors/video/inbox`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/activity+json' },
         body: '{"not":"a valid activity"}'
      });
      // Any well-formed HTTP status (4xx) is fine; what matters is the next line.
      assert.ok(junk.status >= 400 && junk.status < 500);
      const stillUp = await fetch(`${BASE_URL}/feed/videos.xml`);
      assert.equal(stillUp.status, 200, 'server must still serve traffic after junk inbox POST');
   });

   // ------------------------------------------------------------------
   // 5. MASTODON FOLLOW ROUND-TRIP  (B8 — semi-manual runbook)
   //    Fully automating this needs a controllable Mastodon test account and
   //    its API token. We encode the *procedure* so it is a checklist, and
   //    assert only the local, observable side (a follower row appears) when a
   //    handle is provided.
   // ------------------------------------------------------------------
   if (MASTODON_HANDLE) {
      test.todo(
         'B8 runbook: from ' + MASTODON_HANDLE + ', Follow @video@<host>; ' +
         'confirm the Accept is received on the Mastodon side (manual), then ' +
         'assert an ap_followers row exists via an authenticated admin probe.'
      );
   } else {
      test.todo(
         'B8 Mastodon follow round-trip — set TEST_MASTODON_ACCT and follow the ' +
         'runbook in the backend README to exercise Follow -> Accept -> Create.'
      );
   }

   // ------------------------------------------------------------------
   // 6. DELETE / TOMBSTONE FEDERATION  (B9, best-effort — §6 of the milestone)
   //    Verifies that after a takedown the object URL responds 410/Tombstone.
   //    Requires ALLOW_PUBLISH to have produced a federated object first.
   // ------------------------------------------------------------------
   test.todo(
      'B9: after deleting a published upload, its object URL responds 410 Gone / ' +
      'Tombstone, and a Delete activity is dispatched (best-effort) to followers.'
   );
});
