# Testing the Ghostmaxxing backend

This is the operator's testing manual. It covers three things:

1. how to exercise the upload → moderation → publication → deletion path
   **without a webcam**, from the command line, against a local instance or
   against production;
2. how to verify, one sentence at a time, that what `fediverse.html` promises
   is what the backend does;
3. the tooling that already existed (unit tests, the full-cycle test, the
   `manual-*.js` CLIs, the browser diagnostic lab, the admin pages) and what
   each is for.

Everything under `tools/` is dependency-free Node (>= 20). The tools talk to the
backend over HTTP only, except `tools/sweep-now.js`, which says so. Real outputs
below were captured on 2026-09-05 against `main` (`5f78f4b`).

Contents

- [Layout](#layout)
- [A local sandbox that cannot touch production data](#a-local-sandbox-that-cannot-touch-production-data)
- [Quick start](#quick-start)
- [The tools, one by one](#the-tools-one-by-one)
- [Running against production](#running-against-production)
- [Client ↔ server contract](#client--server-contract)
- [What fediverse.html promises, and what the code does](#what-fediversehtml-promises-and-what-the-code-does)
- [What deletion does not do](#what-deletion-does-not-do)
- [Following from a real Mastodon account](#following-from-a-real-mastodon-account)
- [Tooling that already existed](#tooling-that-already-existed)
- [Patches](#patches)

---

## Layout

```
tools/
  fixtures.js        build tools/fixtures/{clip.mp4,clip.png,bogus.txt}
  upload.js          POST /api/uploads exactly as lab-js/upload-consent.js does
  moderate.js        pending | media | approve | reject   (Basic Auth)
  delete-upload.js   DELETE /api/uploads/:id with the contributor's token
  cycle.js           the whole lifecycle, ~60 assertions, narrated
  fedi-check.js      read-only checklist of the fediverse.html promises
  sweep-now.js       run the 14-day purge now (same host as the backend)
  lib/env.js         reads ./env like `npm start` does; --url/--token overrides
  lib/http.js        fetch helpers; --verbose prints every request/response
  fixtures/          generated media (gitignored)
  receipts/          {uploadId, deleteToken} of every upload made by the tools (gitignored, mode 600)
patches/             three optional git diffs for issues the tools surface
test/openapi-cycle/step4-digest-trigger.js   fixed: a hardcoded date made the suite fail after July 2026
```

Every tool accepts `--help`, `--verbose`, `--url <base>`, `--env-file <path>`,
`--token <LAB_POST_TOKEN>`, `--admin-user`, `--admin-pass`. Without flags they
read the repository `env` file (the one `npm start` loads) and talk to
`LAB_API_URL`, falling back to `http://127.0.0.1:PORT`.

---

## A local sandbox that cannot touch production data

Do this once. It runs a second backend from the same checkout with its own
data and storage directories, its own port, and a permissive rate limit, so
you can hammer it and `rm -rf` it.

```bash
cd ~/gstmxx-backend
mkdir -p /tmp/gm-local
cat > /tmp/gm-local/env <<'EOF'
HOST=127.0.0.1
PORT=4141
GSTMXX_PUBLIC_URL=http://127.0.0.1:4141
GSTMXX_ALLOW_PRIVATE_ORIGIN=1
LAB_API_URL=http://127.0.0.1:4141
LAB_POST_TOKEN=local-test-token
GSTMXX_ADMIN_USER=admin
GSTMXX_ADMIN_PASS=admin-local
LAB_DATA_DIR=/tmp/gm-local/data
GSTMXX_STORAGE_DIR=/tmp/gm-local/storage
GSTMXX_UPLOAD_RATE_MAX=200
EOF
node --env-file=/tmp/gm-local/env server.js &
```

Then point every tool at it with `GSTMXX_ENV_FILE=/tmp/gm-local/env` (or
`--env-file /tmp/gm-local/env`). A private origin means nothing federates, which
is the point: approvals still produce posts, feeds and AP objects, but with
zero followers there is nobody to deliver to.

`GSTMXX_UPLOAD_RATE_MAX=200` matters: the production default is **20 uploads
per 15 minutes per client IP**, the cycle alone makes about ten upload
attempts, and the limiter is in-memory (restart resets it).

To start over: stop the server, `rm -rf /tmp/gm-local/data /tmp/gm-local/storage`.

---

## Quick start

```bash
export GSTMXX_ENV_FILE=/tmp/gm-local/env
node tools/fixtures.js      # media with identifying metadata baked in
node tools/cycle.js         # upload ×4, reject paths, queue, approve, reject, self-delete, digests, retire
node tools/fedi-check.js    # the fediverse.html checklist
```

A green cycle ends with:

```
Cycle complete, all assertions passed.
```

and, on current `main`, exactly three `[WARN]` lines: the 500 on a bad MIME
type, the PNG-as-video acceptance, and the digest posts that survive a
deletion. Those are the known gaps; see [Patches](#patches).

---

## The tools, one by one

### tools/fixtures.js

```
$ node tools/fixtures.js
wrote tools/fixtures/clip.png (PNG with a tEXt Comment chunk)
wrote tools/fixtures/clip.mp4 (2 s H.264/AAC with title, comment and GPS tags)
wrote tools/fixtures/bogus.txt
```

The MP4 is the shape the lab records (2 s, from `RECORDING_CONFIG.durationMs`)
and carries `title`, `comment` and a GPS `location` tag on purpose. The PNG
carries a `tEXt` chunk with a fake device and location string. Both are there
so a run can *show* what the backend does with metadata rather than assert it.

### tools/upload.js

Sends the multipart body the client builds in `lab-js/upload-consent.js`:
file field `video` (for PNGs too), `kind`, `consent_version`, `app_version`,
optional `ghostyle_id`, `user_note`, `metrics_json`.

```
$ node tools/upload.js --ghostyle brush --note "two strokes on the nose bridge, eluded at 0.71"
HTTP 201  Upload received and queued for human moderation.
uploadId     a6b9aabe-0e1a-470e-918f-780329275aa1
deleteToken  8ef3d76919ae425b75b0b6c100eb40e0c8e9ab1e8c7bf5381b8d1686c020ed99
will publish http://127.0.0.1:4040/videos/a6b9aabe-0e1a-470e-918f-780329275aa1.mp4  (if approved, as @ghostyles)
receipt      tools/receipts/a6b9aabe-0e1a-470e-918f-780329275aa1.json
RateLimit    limit=200, remaining=188, reset=835   (default 20 uploads per 15 min per client IP)

$ node tools/upload.js --kind clipboard
HTTP 201  Upload received and queued for human moderation.
uploadId     6c143447-0ec0-411c-a1e9-c91ff83d85d1
...
will publish http://127.0.0.1:4040/clipboard/6c143447-0ec0-411c-a1e9-c91ff83d85d1.png  (if approved, as @clipboard)

$ node tools/upload.js --no-consent
HTTP 400: consent_version is required.
```

Other flags: `--file <path>` (any MP4/WebM/OGG/PNG, e.g. a real lab recording
saved from the browser), `--metrics '<json>'`, `--consent <version>`,
`--mime <type>` to lie about the content type and see the rejection.

`--verbose` prints the exchange:

```
> POST http://127.0.0.1:4040/api/uploads
  (multipart/form-data: video, kind, consent_version, app_version)
< 201 Created  (application/json, 203 bytes)
  {
    "ok": true,
    "uploadId": "86ac472f-0e4c-4eaf-b2e8-d05cff8a0ea5",
    "deleteToken": "5ec94958e9865c88cbae8833c00a3b4510a586d01226973a3324703783a73e45",
    "message": "Upload received and queued for human moderation."
  }
```

Where a submission is published (`server.js`, `actorForUpload`): with a
`ghostyle_id` → `@ghostyles`, whatever the kind. Without one: videos →
`@video`, PNGs → `@clipboard`.

### tools/moderate.js

The moderation API (`routes/admin.js`) from the shell. Same Basic Auth as the
web UI at `/api/admin/`.

```
$ node tools/moderate.js pending
4 pending upload(s):
- 5c1da408-9846-4864-8c09-a1b690ce1c4b  video     2026-09-05T21:32:15.277Z  ghostyle=-  app=-  consent=2026-07-v1
    media: http://127.0.0.1:4040/api/admin/media/5c1da408-9846-4864-8c09-a1b690ce1c4b   (Basic Auth)
- a6b9aabe-0e1a-470e-918f-780329275aa1  video     2026-09-05T21:44:18.335Z  ghostyle=brush  app=0.1.0  consent=2026-07-v1
    note: "two strokes on the nose bridge, eluded at 0.71"
    media: http://127.0.0.1:4040/api/admin/media/a6b9aabe-0e1a-470e-918f-780329275aa1   (Basic Auth)
...
Note: the moderator never sees metrics_json, and cannot edit the note that becomes the post text.
```

```
$ node tools/moderate.js approve a6b9aabe-0e1a-470e-918f-780329275aa1
HTTP 200  Approved, published, and federated.
actor        @ghostyles   (ghostyle_id present → ghostyles; else video/clipboard by kind)
post         http://127.0.0.1:4040/posts/7d7b1d5a-b288-41df-86a7-60f43f3b6aa3
media        http://127.0.0.1:4040/videos/a6b9aabe-0e1a-470e-918f-780329275aa1.mp4  thumb: /thumbnails/thumb-a6b9aabe-....png
federation   Create → 0 follower(s), 0 delivered, 0 failed
echo         @ghostyles-video Announce → 0 follower(s), 0 delivered
[PASS] ActivityPub object  — .../posts/7d7b1d5a-... → 200, type=Note, attributedTo=.../federation/actors/ghostyles
[PASS] HTML preview  — og:title=Ghostmaxxing: ghostyles
[PASS] RSS /feed/ghostyles.xml  — contains the post: true
[PASS] RSS /feed/all.xml  — contains the post: true
[PASS] published video metadata stripped  — only container defaults remain (major_brand, minor_version, compatible_brands, encoder)
```

The last line is the proof for the "video metadata is stripped" sentence: the
fixture went in with `title`, `comment`, `location`, `location-eng`; the tool
downloads the published file and runs `ffprobe` on it.

```
$ node tools/moderate.js reject 6c143447-0ec0-411c-a1e9-c91ff83d85d1 --reason 'fixture'
HTTP 200  Upload rejected and the raw file deleted.

$ node tools/moderate.js media <uploadId>      # saves the pending file to tools/receipts/<id>.<ext>
$ node tools/moderate.js approve --all         # local testing only
```

### tools/delete-upload.js

The contributor's side of the "deletion code" promise.

```
$ node tools/delete-upload.js a6b9aabe-0e1a-470e-918f-780329275aa1
HTTP 200  Upload deleted.
federation   Delete(Tombstone) → 0 follower(s), 0 delivered, 0 failed
removedFiles 2

post 7d7b1d5a-b288-41df-86a7-60f43f3b6aa3 by @ghostyles was live; checking the public surfaces now:
  /posts/:id (ActivityPub)  404
  /posts/:id (HTML)         404
  media                     404
  note: if nginx fronts this backend, /posts/7d7b1d5a-... may be served from the proxy cache for up to its TTL (7d in nginx/ghostmaxxing.vecna.eu.conf).
```

The token comes from `tools/receipts/<uploadId>.json`, or `--token <hex>`
(paste it from a lab receipt to test a real contribution's code). Status
codes: 200 deleted, 403 wrong token, 404 unknown id, 410 already gone.

### tools/cycle.js

Runs everything above in sequence with assertions. Refuses a non-local `--url`
unless `--allow-remote`, because it creates public posts and digest posts that
would federate to real followers. Full output of a green run is about 70
lines; the section headers are:

```
## Instance http://127.0.0.1:4040
## Intake: POST /api/uploads (multipart, field 'video', as lab-js/upload-consent.js sends it)
## Intake: rejection paths
## Queue: GET /api/admin/pending
## Approve A (video + ghostyle): POST /api/admin/approve/:id
## Approve C (PNG + ghostyle)
## Reject B (plain video): POST /api/admin/reject/:id
## Contributor self-delete while pending: DELETE /api/uploads/:id + X-Delete-Token
## Digests: POST /api/digests/run {force:true} (Bearer LAB_POST_TOKEN)
## Retire A (approved, echoed, possibly quoted): DELETE with the contributor token
## Tidy: delete the approved PNG too
```

If it stops with `[STOP] 429`, you hit the intake rate limit; see the sandbox
section.

### tools/fedi-check.js

Read-only. Safe against production. Checks, in order: `/healthz` (actors,
filters, `canFederate`), the derived rule of each filter actor next to the
sentence on the page, WebFinger + actor document + followers collection for
all nine handles, RSS for `all` and all nine handles plus a 404 probe,
`/api/posts` and content negotiation of one post, orphaned digest quotes, the
intake's 400 and rate-limit headers, admin auth (401 anonymous, **default
password rejected**, configured credentials accepted), `/latest`,
`/api/openapi.json`, `/api/docs`, and with `--token` the federation
diagnostics (stuck `Accept(Follow)` queue).

Against production:

```bash
node tools/fedi-check.js --url https://ghostmaxxing.vecna.eu --token "$LAB_POST_TOKEN"
```

Exit code 1 if anything FAILs.

### tools/sweep-now.js

Runs the same function as the hourly timer in `services/cleanup.js`. Must run
on the backend host with the backend's `env`, because it touches
`data/uploads` and `storage/incoming` directly.

```
$ node tools/sweep-now.js                       # dry run with the real 14-day rule
$ node tools/sweep-now.js --all-pending         # what would go if every pending row were stale
uploads ledger  /tmp/gm-local/data/uploads
incoming media  /tmp/gm-local/storage/incoming
stale after     14 day(s)
evaluated at    2026-09-20T21:44:55.999Z  (--all-pending: clock moved forward)

- 5c1da408-9846-4864-8c09-a1b690ce1c4b  video  created 2026-09-05T21:32:15.277Z  ghostyle=-
- 23734bcf-b4d8-4e31-a17b-2201dbdb9e99  clipboard  created 2026-09-05T21:32:15.329Z  ghostyle=-

2 would be removed. Re-run with --apply to do it.

$ node tools/sweep-now.js --all-pending --apply
scanned 2, deleted 2. Ledger rows are kept with status "deleted"; media files are gone.
```

---

## Running against production

Read-only, any time:

```bash
node tools/fedi-check.js --url https://ghostmaxxing.vecna.eu --token "$LAB_POST_TOKEN"
```

A real contribution, without the webcam. This puts a file in the real queue,
where it is visible to whoever moderates; nothing is public until approval.

```bash
node tools/upload.js --url https://ghostmaxxing.vecna.eu --file tools/fixtures/clip.mp4 --note "backend test, please reject"
node tools/moderate.js --url https://ghostmaxxing.vecna.eu --admin-user ... --admin-pass ... pending
node tools/moderate.js --url https://ghostmaxxing.vecna.eu --admin-user ... --admin-pass ... reject <uploadId>
# or, to test the public side end to end (this federates to real followers):
node tools/moderate.js --url https://ghostmaxxing.vecna.eu --admin-user ... --admin-pass ... approve <uploadId>
node tools/delete-upload.js <uploadId> --url https://ghostmaxxing.vecna.eu
```

Things that differ through nginx (`nginx/ghostmaxxing.vecna.eu.conf`):

- `/posts/:id` is cached for **7 days** (`proxy_cache_valid 200 7d`). After a
  deletion, the proxy keeps answering 200 with the old HTML/AP object until the
  TTL expires. `fedi-check.js` warns when it sees an `X-Cache-Status` header.
  `patches/0003` lowers it to 10 minutes.
- `/latest` is a backend route but is not in the proxied regex, so it 404s on
  production (`fedi-check.js` reports it). Also in `patches/0003`.
- `/` on the Node process (the "Fedify browser lab", `public/index.html`) is
  not reachable through nginx; production serves the static client there.
  Reach it with `ssh -L 4040:127.0.0.1:4040 server` then
  `http://127.0.0.1:4040/`.
- The rate limit is per client IP from `X-Forwarded-For` (`trust proxy` is on).

---

## Client ↔ server contract

What `ghostmaxxing/lab-js/upload-consent.js` and `config.js` send, and what
`gstmxx-backend/routes/uploads.js` expects. Verified field by field.

| Client | Server | Status |
|---|---|---|
| `POST /api/uploads` multipart, file field **`video`** | `upload.single("video")` | match |
| `kind` = `"video"` (the client never sends `clipboard`) | `video` \| `clipboard`, else 400 | match; PNG path is server-only |
| `consent_version` = `'2026-07-v1'` | required, any non-empty string; stored | match; not validated against a current version |
| `app_version` = `'0.1.0'` | stored | match |
| `ghostyle_id` when a Ghostyle was active | stored; routes the post to `@ghostyles` | match |
| `user_note` | stored; **becomes the post text verbatim** (HTML-escaped) | match |
| `metrics_json` (JSON string of face-api / MediaPipe state) | stored as `metrics` in the ledger; never shown to the moderator, never published | received, unused |
| expects `{ ok, uploadId, deleteToken }` | returns exactly that plus `message`, HTTP 201 | match |
| `DELETE /api/uploads/:id` with header `X-Delete-Token` | verified constant-time; 200/403/404/410 | match |
| receipt guesses public URL `/videos/<uploadId>.mp4` (`/clipboard/<uploadId>.png`) | approved media is named `<uploadId>.mp4` / `.png` under those paths; thumbnail `thumb-<uploadId>.png` | match |
| accepted types (client records WebM or MP4 depending on browser) | `video/mp4`, `video/webm`, `video/ogg`, `image/png`; 15 MB | match; output is always MP4 |
| private receipt URL `#receipt=<uploadId>.<token>` | client-side only | n/a |

Gaps that are on the **client** side: there is no PNG contribution flow
(`export-makeup.js` copies to the OS clipboard or downloads; it never POSTs),
so "contribute a video or PNG image" on fediverse.html is only half wired.
The recorded clip does not include the AR overlay (`consent-and-ownership.md`
says so), so a `@ghostyles` video shows the physical face; the Ghostyle is
context only.

---

## What fediverse.html promises, and what the code does

Each row is a sentence from `ghostmaxxing/fediverse.html` (main, 2026-09-05).

| Promise | Where | Verified by | Verdict |
|---|---|---|---|
| Four primary accounts `@video`, `@ghostyles`, `@clipboard`, `@news` | `server.js` `ACTORS`; `/healthz` | fedi-check: actors, WebFinger, actor docs | holds |
| `@video` = approved video experiments; `@ghostyles` = media associated with a documented ghostyle; `@clipboard` = stills | `actorForUpload` | cycle: approve A/C/D | holds. Subtlety: a *video* with a `ghostyle_id` goes to `@ghostyles`, not `@video` |
| `@news` = editorial updates by the team | `/api/admin/compose`, `manual-add-post.js --actor news` | manual | holds |
| Filter accounts are automatic views of `@ghostyles`, rule encoded in the name, no follower profiling | `lib/digest.js` grammar, `DEFAULT_FILTERS` | fedi-check prints code rule vs page rule per handle | holds |
| `@ghostyles-pictures` re-shares every approved picture; `@ghostyles-video` every approved video | echo filters → `Announce` on approval | cycle: `echoes` on approve | holds |
| `@ghostyles-daily` one random pick per 24 h; `@ghostyles-weekly` per 7 days | digest filters, scheduler every 5 min (`GSTMXX_DIGEST_INTERVAL_MS`) | cycle: `POST /api/digests/run` | holds. Published as a quote post (FEP-044f) by the filter actor, text like `3 ghostyles received in last day, 2 pictures 1 videos, random daily selection:` |
| `@ghostyles-top-rated` = the item with the most likes in the last 24 h | `top` selection, no `minLikes` | fedi-check WARN | mostly. With **zero likes** it still publishes one item every day (ties → most recent). Either add a threshold (a new handle such as `ghostyles-top-rated-min1likes`, which breaks existing follows) or soften the sentence |
| Follows are public and auto-accepted | `Follow` inbox listener → `Accept`, retry queue | manual (see below); `/api/federation/diagnostics` | holds; a failed Accept is retried with backoff up to ~1 day |
| Running an experiment publishes nothing; contribution is explicit and shows the consent notice | client `upload-consent.js` | client code | holds; `consent_version` is a hard gate server-side |
| Private queue, human moderator, then one public post that is web + RSS + ActivityPub + timelines | `routes/admin.js` approve; `/posts/:id` content negotiation; `/feed/*.xml`; `Create` delivery | cycle: approve section | holds |
| "Approval is editorial, not a technical certification" | copy | n/a | holds. Note the post body is the contributor's note verbatim; the moderator cannot edit or annotate it, and metrics are never attached |
| No account, no byline | posts are `attributedTo` the project actor | AP object | holds |
| Server receives media, submission type, consent version; may include ghostyle id, app version, note, metrics | `routes/uploads.js` | cycle: queue section | holds |
| Pending media auto-removed after 14 days; rejected media removed | `services/cleanup.js` hourly, `GSTMXX_STALE_DAYS`; reject handler | `tools/sweep-now.js`; cycle: reject | holds. Ledger row stays (status `deleted`/`rejected`) with note, metrics and token |
| Approved video is transcoded and container metadata (device, location) stripped | `services/video.js` `-map_metadata -1` | moderate.js approve → ffprobe on the published file | **holds, verified** |
| PNG published as submitted | `processApprovedClipboard` = copy | cycle: tEXt chunk survives | holds (and is a real exposure; the page warns) |
| Deletion code returned at upload; deletes while pending or after publication | `deleteToken`, `DELETE /api/uploads/:id` | cycle: self-delete + retire | holds |
| Deleting an approved contribution removes post and media and sends a deletion notice to known followers | `emitDeleteForPost` → `Delete(Tombstone)` to the actor's followers | cycle: retire | holds for the origin actor. **Gaps:** digest quote posts by `-daily/-weekly/-top-rated` that quoted it stay published (now pointing at a 404); no `Undo(Announce)` goes to `@ghostyles-video`/`-pictures` followers; nginx serves the cached post for up to 7 days |
| "No federated publisher can guarantee every remote copy disappears" | copy | n/a | accurate |
| RSS: `/feed/all.xml`, or a handle | `routes/feeds.js` | fedi-check | holds; filter handles have feeds too |

---

## What deletion does not do

Verified on `main`:

1. **Digest quote posts survive.** `@ghostyles-daily`, `-weekly`, `-top-rated`
   publish a quote post pointing at the picked original. Deleting the original
   removes the original only; the three quote posts remain in `data/posts`,
   in `/api/posts`, in their RSS feeds and in followers' timelines, quoting a
   URL that now returns 404. `patches/0002` retires them in the same request
   and sends their `Delete(Tombstone)` too.
2. **Echo boosts are not undone.** The `Announce` sent by `@ghostyles-video`
   or `@ghostyles-pictures` at approval time is not followed by an
   `Undo(Announce)`. Servers that also follow `@ghostyles` receive the
   `Delete` and drop the boost; servers following only the filter do not.
3. **nginx keeps the post for 7 days** (`/posts/` cache). `patches/0003`.
4. **The ledger keeps the content.** `data/uploads/<id>.json` retains
   `userNote`, `metrics`, `ghostyleId` and the plaintext `deleteToken` after
   deletion. Not public, but "removed" is stronger than what happens on disk.

---

## Following from a real Mastodon account

The one thing no local script can do is receive a signed `Follow` from another
server. Procedure, once the production origin is right:

1. `node tools/fedi-check.js --url https://ghostmaxxing.vecna.eu` must show
   `origin can federate` and every actor with `key=ok`.
2. From a Mastodon account, search `@ghostyles@ghostmaxxing.vecna.eu`, Follow.
   The first search can take seconds while Mastodon fetches WebFinger and the
   actor.
3. On the server: `curl -s http://127.0.0.1:4040/api/followers | jq` shows the
   follower under `ghostyles`; the Mastodon side shows "Following" (not
   "Pending"). If it stays pending:
   `curl -s -X POST -H "Authorization: Bearer $LAB_POST_TOKEN" http://127.0.0.1:4040/api/federation/accepts/retry`
   and read `/api/federation/diagnostics`.
4. Approve any upload with a `ghostyle_id` (`tools/moderate.js approve`). The
   `federation` line now shows `1 follower(s), 1 delivered`; the post appears in
   the Mastodon home timeline within seconds. Follow `@ghostyles-video` from a
   second account to see the boost arrive.
5. Like the post from Mastodon. `GET /api/posts` shows `likes: 1`
   (`services/likes.js`); `POST /api/digests/run {"force":true}` makes
   `@ghostyles-top-rated` pick it.
6. `node tools/delete-upload.js <uploadId> --url https://ghostmaxxing.vecna.eu`
   and watch the post disappear from the Mastodon timeline (the `Delete`).
   Then check the follower of `@ghostyles-daily` still sees the quote post:
   that is gap 1 above.

---

## Tooling that already existed

| Tool | What it is for | How |
|---|---|---|
| `npm test` | 118 unit/integration tests, in-process servers with mocked ffmpeg | passes on `main` |
| `npm run test:full-cycle` | 55-step OpenAPI walk-through with HTTP trace | **was failing** (2 of 55) because `step4-digest-trigger.js` hardcoded `now: "2026-07-30"`, so every post created today fell outside the digest windows. Fixed in this kit; 55/55 |
| `npm run test:coverage` | c8 over `npm test` | |
| `node manual-add-post.js --actor news --publish -- "text"` | staff post via `POST /api/posts` (Bearer token) | reads `./fedibasic.env` by default, not `./env`; pass `--env-file env` |
| `node manual-quote-picture.js --image-url … --publish` | picture post + quote post, tests the FEP-044f quote authorization | same env caveat |
| `node manual-profile.js --actor video --show` / `--from-json fedi-profile.json --publish` | avatar, header, bio, fields; `Update(Person)` | see `CONFIG-REMINDER.md` |
| `http://127.0.0.1:4040/` (Node, not nginx) | "Fedify browser lab": health, config, followers, WebFinger, actor JSON, create post, announce static object | SSH tunnel on production |
| `https://ghostmaxxing.vecna.eu/api/admin/` | moderation UI (pending, preview, approve, reject) | Basic Auth |
| `https://ghostmaxxing.vecna.eu/api/admin/compose` | news composer with optional image, publishes directly | Basic Auth |
| `https://ghostmaxxing.vecna.eu/api/docs` | rendered OpenAPI (`tutorials/openapi.json`) | public. Missing from the spec: `/api/actors/*` (profiles), `/api/federation/diagnostics`, `/api/federation/accepts/retry` |
| `npm run doctor` | prints `/healthz` | |
| `curl -s http://127.0.0.1:4040/api/federation/diagnostics -H "Authorization: Bearer $LAB_POST_TOKEN"` | origin, followers, pending Accepts | |

---

## Patches

Optional, small, reviewed against `npm test` (118/118 still pass with 0001 and
0002 applied). Apply from the repository root:

```bash
git apply patches/0001-uploads-4xx-on-bad-mime-and-size.diff
git apply patches/0002-retire-digest-quotes-on-delete.diff
git apply patches/0003-nginx-posts-cache-ttl-and-latest.diff   # then reload nginx
```

- **0001** `routes/uploads.js`: multer's `fileFilter` and size errors currently
  reach Express's default handler → HTTP 500 and a stack trace in the log for
  every wrong-type upload. Returns 415 (type), 413 (size), 400 (other) with
  the usual `{ok:false,message}` body. Behaviour otherwise unchanged.
- **0002** `routes/uploads.js`: when an approved upload is deleted, also find
  posts whose `quoteUrl` points at the deleted post (the digest filters'
  quote posts), federate a `Delete(Tombstone)` for each from its filter actor,
  and remove them. Reported in the response as `federation.retiredQuotes`.
  Existing orphans on production need removing by hand from `data/posts/`
  (`fedi-check.js` lists their ids).
- **0003** `nginx/ghostmaxxing.vecna.eu.conf`: `/posts/` cache TTL 7d → 10m,
  cache 404/410 for 1m, and add `latest` to the proxied location regex.

Not patched, noted for a decision:

- `kind=video` with a PNG body is accepted (ffprobe sees a one-frame video).
- `@ghostyles-top-rated` publishes daily even with zero likes.
- Ledger rows keep note/metrics/token after deletion; a scrub on delete
  would make "removed" literally true.
- The rate limit of 20 uploads / 15 min / IP is per NAT, so a workshop room
  shares one budget. `GSTMXX_UPLOAD_RATE_MAX=60` for a workshop day is a
  one-line env change.
- `metrics_json` is stored and never used; either surface it to the moderator
  and in the post (it is the "stated test conditions" the page talks about)
  or stop collecting it.
