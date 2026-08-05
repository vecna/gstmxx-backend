## `manual-profile.js`

Header image, avatar, display name, biography (with links) and up to four profile
fields.

```bash
npm run profile -- --actor video --show

npm run profile -- --actor video \
  --name "Ghostmaxxing / video" \
  --bio-file ./bio.txt \
  --field "Lab=https://ghostmaxxing.vecna.eu/lab.html" \
  --field "Code=https://github.com/vecna/ghostmaxxing" \
  --avatar-file ./avatar.png \
  --header-file ./header.jpg \
  --publish
```

`--help` lists everything. Notes that matter:

- **Images: PNG, JPEG, WebP or GIF, max 2 MB. Not SVG** — Mastodon rejects vector
  avatars and headers, so your `ghostmaxxing-mark.svg` needs a raster export.
- **Stored bytes are content-addressed** (`video-avatar-1f3a9c02.png`). Remote
  servers cache avatars *by URL*, so a new image must arrive at a new URL or it
  is never re-fetched. Re-uploading the same file is a no-op.
- **Media is served from `/api/actors/:handle/media/:file`.** `/api` is already
  proxied to Node by your nginx site, so avatars work with **no nginx change**.
- **`--publish` is what reaches people.** It sends `Update(Person)` with the
  actor embedded. Without it the profile is stored but nobody is told.
- `--preview` prints the exact `Person` document a remote server will read.
- `--avatar-url` / `--header-url` point at images you already host, if you would
  rather not upload.


### `server.js`

- **`GSTMXX_PUBLIC_URL`**, with `LAB_BASE_URL` kept as an alias.
- **Delivery preflight.** `assertDeliverable()` refuses before any request leaves
  and returns one actionable sentence instead of a remote 401.
- **The Follow handler can no longer 500.** A failed `Accept` is parked in
  `data/pending-accepts.json` and retried with doubling backoff (30s → 6h, 12
  attempts), at boot and on a timer. A follow that arrived while the origin was
  wrong resolves itself once you fix the origin and restart — no re-follow needed.
- **`manuallyApprovesFollowers: false`** is now declared on the actor. Without it
  a client has to guess, and it guesses conservatively.
- **Per-inbox fan-out.** Fedify's `sendActivity(..., "followers", ...)` fans out
  under `Promise.all`, so one bad inbox rejected the whole batch and the caller
  could not tell which one, or whether anyone got it. Delivery is now one call
  per *distinct* inbox (shared inboxes are already deduplicated in the follower
  store) with a per-inbox report.
- **Publishing is non-destructive.** `POST /api/posts` answers **201** with the
  post id plus a delivery report; the post is durable the moment it hits disk and
  a network problem is a separate, later fact. `POST /api/posts/:id/announce` —
  where delivery *is* the request — answers **502** on total failure.
- **Boot banner** when the origin is unusable, plus `GSTMXX_STRICT_ORIGIN=1` to
  refuse to start at all (recommended in production: it turns a silent
  misconfiguration into a failed deploy).
- **New endpoints:** `GET /api/federation/diagnostics`,
  `POST /api/federation/accepts/retry`, and `federation.canFederate` on `/healthz`.

