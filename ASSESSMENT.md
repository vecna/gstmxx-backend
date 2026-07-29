# Ghostmaxxing backend — assessment (July 2026)

This reviews the backend snapshot in `CODE2PROMPT.txt` against
`MILESTONE-backend-stabilization.md`, the upload/consent milestone, and the
roadmap. Everything below was verified by actually installing the real
dependencies (`@fedify/fedify@1.3.x`, `better-sqlite3`, Express, multer, jest),
running the suite, and booting the server both with ActivityPub off and on.

---

## 1. Is the backend correctly implemented? (short answer)

**Mostly yes for launch-on-RSS; no for federation.** The snapshot no longer
crashes on the first request (the original F1 blocker is fixed), the upload →
moderate → publish → delete lifecycle works end to end with ActivityPub
disabled, and 51 automated tests pass. But the one milestone task that was
called out as needing a *rewrite* — B7, the Fedify HTTP integration — is still
built against an imaginary Fedify API and does not work against the real
library. Federation is effectively non-functional, and turning it on currently
degrades the whole server.

I read "the first three milestones regarding the backend" as the three original
blocker areas the stabilization milestone was written around: **F1 crash-on-first-request**,
**F2 placeholder cryptography**, **F3 volatile federation state**. Verdict on
each, plus the rest of the B-sequence, follows.

### The three original blockers

| Blocker | Status | Evidence |
|---|---|---|
| **F1 — crash on first request** | ✅ Fixed (B1) | AP is behind `GSTMXX_ENABLE_AP` (default off); `isolateMiddleware` + `uncaughtException`/`unhandledRejection` guards keep the process alive. With AP off, feeds/upload/approve/delete all succeed and 51 tests pass. Even with AP *on* and a broken bridge, a bad request no longer kills Node. |
| **F2 — placeholder cryptography** | ◑ Logic done (B4), unreachable | `keys.js` generates and persists real RSA + Ed25519 JWKs; `layer1.test.js` proves they are real and survive. **But** they are only produced lazily by the actor dispatcher, which never runs because the HTTP bridge (B7) is broken — so actor JSON never exposes a real key at runtime. A fresh AP-on boot leaves the `keys` table empty. |
| **F3 — volatile federation state** | ❌ Not fixed | `activitypub.js` still constructs `createFederation({ kv: new MemoryKvStore() })`. The milestone requires a SQLite-backed `KvStore`; inbox dedup/state is still lost on restart. |

### The B-task sequence

| Task | Status | Notes |
|---|---|---|
| B1 isolate the crash | ✅ | Feature flag + per-request isolation, verified. |
| B2 directory bootstrap | ✅ | `bootstrap.js` `mkdirSync(..,{recursive})`; fresh boot needs no manual mkdir. |
| B3 delete-token endpoint | ✅ | `DELETE /api/uploads/:id`, constant-time compare, 200/403/410/404 all correct and tested. |
| B4 real keypairs | ◑ | Generation/persistence correct and tested; unreachable via HTTP until B7 (see F2). |
| B5 MIME sniffing | ✅ | `ffprobe` post-upload; renamed non-video is rejected + unlinked (tested). |
| B6 stale cleanup | ✅ | Hourly interval; real SQL date cutoff tested in `layer1`. |
| B7 rewrite Fedify integration | ❌ **still broken** | See §2 — this is the headline problem. |
| B8 Mastodon follow round-trip | ❌ blocked by B7 | No inbox request can reach Fedify. |
| B9 outbound Create/Delete | ◑ code present, unreachable | `emitCreateForUpload`/`emitDeleteForUpload` are written to a plausible API but never succeed while B7 is broken; both are gated on `isActivityPubEnabled()` and are no-ops with AP off. |
| B10 feed data sources | ✅ | `news` table + admin insert → `/feed/news.xml`; ghostyles feed reads the manifest; feeds are English (F10 fixed). |
| B11 minimal moderation page | ✅ | `admin/index.html` lists pending, filters by kind, previews via authenticated `/api/admin/media/:id`, approve/reject/copy-URL. |
| B12 domain unification + nginx split + TLS | ◑ partial | Canonical domain is `ghostmaxxing.vecna.eu` everywhere; conf renamed. **But** `location /` still proxies *everything* to Node (F12 not resolved — the static-frontend split was not done) and the TLS block is still commented out. |
| B13 docs | ◑ | README has run/verify curls and env vars, but not the full deploy/backup/moderate runbook. |
| B14 clipboard channel | ✅ | `kind` column, four-actor CHECK, shared queue/approve path; tested. |

---

## 2. The one thing to fix before federating: B7

This is empirically demonstrated, not inferred. Booting with `GSTMXX_ENABLE_AP=1`
and requesting any federation URL:

```
GET /.well-known/webfinger?resource=acct:video@host   → 400 {"message":"fed.handle is not a function"}
GET /federation/actors/video                           → 400 {"message":"fed.handle is not a function"}
```

Two concrete defects:

1. **Wrong HTTP entrypoint.** `activityPubMiddleware` calls `fed.handle(req)`.
   The real Fedify 1.x federation object has **no `handle` method** — its
   entrypoint is `federation.fetch(request, { contextData })`, taking a
   web-standard `Request` and returning a `Response`. The milestone's
   recommended path — `@fedify/express`'s `integrateFederation(...)` — is not
   even installed (only `@fedify/fedify` is in `node_modules`). So every
   federation request throws.

2. **Global-first mounting makes it worse than F1's "federation only" impact.**
   The AP middleware is mounted with `app.use(...)` (no path), so it runs on
   *every* request. With AP on, the broken bridge therefore 400s **feeds and
   uploads too** — I confirmed `/feed/videos.xml` returns 400 when AP is
   enabled. The process survives (B1 holds), but the site is functionally down.
   When B7 is rewritten, mount Fedify only on its own paths, or ensure a
   non-match falls through cleanly.

Also still open under B7: swap `MemoryKvStore` for a persistent `KvStore` (F3),
and the key dispatcher must actually be reached so B4's keys surface.

The internals that *are* correct: the dispatcher/listener registration uses the
right modern names (`setActorDispatcher`, `setKeyPairsDispatcher`,
`setFollowersDispatcher`, `setInboxListeners(...).on(Follow).on(Undo)`), so the
rewrite is genuinely "fix the HTTP bridge + KV store", not "start over".

### Secondary correctness bug (not federation-specific)

The published **public URL does not resolve to the stored file**. On approve,
the file is written as `pub-<random>.mp4` (derived from multer's random name),
but the public URL emitted into feeds and AP objects is
`${BASE_URL}/videos/<uploadId>` (the UUID). nginx aliases `/videos/` →
`storage/approved/`, so `/videos/<uuid>` will 404. Either name the approved file
after the upload id, or add a route that maps id → filename. The Layer 2 suite
has an assertion positioned to catch exactly this.

---

## 3. Does the testing capture the core behaviour? (Q2)

The Layer 1 suite is genuinely good where it is real: it boots the actual
Express app over real HTTP against real SQLite and drives the whole
upload/moderate/publish/delete lifecycle, including the clipboard variant, MIME
rejection, stale cleanup with real date arithmetic, and real persisted
keypairs. That is the core happy path and it is well covered.

But there are missing/again conditions worth knowing about:

- **The ActivityPub unit test is a false-green.** `activitypub.test.js` mocks
  `getFedify` and hands the service a fake object that *has* a `.handle()`
  method — so the test asserts the middleware calls the exact method that does
  not exist in the real library. It passes precisely because it encodes the bug
  as the contract. This is the single most misleading part of the suite. I have
  (a) rewritten its header to say so in bold, (b) added `ap_runtime.test.js`
  which uses the **real** library and pins the correct entrypoint (`.fetch`,
  not `.handle`), and (c) put the true end-to-end proof (WebFinger/actor resolve)
  in the Layer 2 suite so it goes green only when B7 is actually done.

- **The real media pipeline is never asserted.** `video.js` short-circuits in
  test mode, so the ffmpeg transcode, the `-map_metadata -1` **privacy strip**,
  and the thumbnail frame are never exercised by any automated test. The privacy
  strip is a stated guarantee in the consent copy and has zero coverage — it
  belongs in Layer 2 on a box with ffmpeg.

- **No test that the published URL resolves** (the id-vs-filename bug above).

- **Rate limiting is configured but never tripped.** No test drives the 429 path
  the frontend U6 copy depends on. (I added coverage for the `max` parser, not
  an actual 429 trip — that needs a Layer-2-style loop.)

- **Feeds are only regex-checked, not parsed.** The milestone asks for parsing
  with a real XML parser and asserting escaping; today a malformed feed with a
  stray `&` could pass the `assert.match` checks. `escapeXml` itself is untested.

- **A few small edges:** malformed `Authorization` header on admin; the delete
  endpoint returns 410 for already-deleted rows *before* checking the token (a
  minor status-oracle); double-approve / delete-during-approve races. None are
  crashers, but none are tested.

---

## 4. Unit-test coverage assessment (Q4)

Measured with `npm run test:coverage`. **Before** my additions the suite was 39
tests at ~67% statements / 55% branches. **After** adding the migration, server-
isolation, and AP-runtime tests it is **51 tests, ~73% statements / ~63%
branches**, with the two biggest structural holes largely closed:

| Module | Before | After | Note |
|---|---|---|---|
| `db.js` | 50% | **96%** | Migration rename/backfill branches + CHECK constraints now tested. |
| `server.js` | 55% | **80%** | 404 contract, malformed-JSON isolation, `isolateMiddleware` sync+async, rate-limit parser. |
| `activitypub.js` | 25% | 27% | **Structurally uncoverable in Layer 1** — the runtime path needs a working B7. The new `ap_runtime.test.js` covers init + the isolation guarantee; the rest is Layer 2's job. Don't chase this number with more mocks; that just deepens the false-green. |
| `public.js` | 66% | 66% | `all.xml` merge path and `escapeXml` still thin; worth a small unit test. |
| `video.js` | 73% | 73% | Real ffmpeg path only reachable in Layer 2. |
| `keys.js`, `uploadFiles.js`, `cleanup.js`, `videoValidation.js` | high | high | Solid. |

Headline: coverage *percentage* is now healthy, but the honest reading is that
the untested remainder is concentrated exactly on the unfinished/uncoverable
federation surface — so the number should be read alongside "B7 is not done",
not as "the backend is 73% proven".

---

## 5. What I changed in this bundle

I deliberately did **not** rewrite B7 — that is a milestone in its own right and
a blind rewrite (choosing `@fedify/express` vs. a hand-rolled `fetch` bridge,
plus the SQLite `KvStore`) shouldn't be smuggled into a test/assessment pass.
Application logic under `backend/src/` is unchanged. The delta is test-only:

- **`backend/tests/online/layer2.online.test.js`** — Layer 2 scaffolding
  (deliverable 3): upload round-trip, moderation via the B11 page, feeds through
  nginx, WebFinger/actor resolution, junk-inbox survival, and a B8 Mastodon
  runbook. Guarded so it is inert without `TEST_BASE_URL` and residue-free via
  the delete-token endpoint. `jest.online.config.js` + `npm run test:online`.
- **`backend/tests/ap_runtime.test.js`** — real-library test that (a) proves B1
  isolation holds with AP on and (b) pins the correct Fedify entrypoint so B7
  has a target.
- **`backend/tests/db.migrations.test.js`** and **`backend/tests/server.test.js`**
  — the coverage additions above.
- **Comments on every existing test file** (deliverable 5): each now opens with
  a "what we test / how / what we do NOT cover" header, and the subtler
  assertions are annotated inline. The `activitypub.test.js` header calls out
  the false-green explicitly.

Run: `npm test` (Layer 1, 51 tests) and `npm run test:online` (Layer 2, skips
cleanly with no target).
