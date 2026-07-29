# Operations: environment, backups, interfaces

This is the operator's reference for the Ghostmaxxing backend. It is written to
render as a JSDoc `@tutorial` (point `npx jsdoc` at `tutorials/`) but reads fine
as plain Markdown.

## Environment variables

### Networking & identity
- **`HOST`** (default `0.0.0.0`) — bind address. `0.0.0.0` allows LAN access.
- **`PORT`** (default `4040`) — HTTP port. nginx proxies to `127.0.0.1:PORT`.
- **`LAB_BASE_URL`** — the public HTTPS origin embedded in actor and post IDs
  (e.g. `https://ghostmaxxing.vecna.eu`). This is the federated identity origin,
  not the CLI target. Changing it changes every actor id.
- **`LAB_API_URL`** (default = base) — where CLIs (`manual-*.js`) send control
  requests. Keep this local (`http://127.0.0.1:PORT`) even when `LAB_BASE_URL`
  is public, to avoid DNS hairpin/TLS/proxy surprises.

### Storage locations
- **`LAB_DATA_DIR`** (default `./data`) — durable state (see backups).
- **`GSTMXX_STORAGE_DIR`** (default `./storage`) — media.
- **`LAB_CLIENT_INTERFACE_DIR`** / **`GSTMXX_CLIENT_INTERFACE_DIR`** — optional
  path to the built static client, served as a top-priority layer for
  single-process development. In production nginx serves the client instead.

### Auth & secrets
- **`LAB_POST_TOKEN`** — Bearer token guarding the control API
  (`POST /api/posts`, `/api/posts/:id/announce`, `/api/digests/run`). Set a
  strong value whenever the port is reachable from the internet. Reads stay
  public.
- **`GSTMXX_ADMIN_USER`** / **`GSTMXX_ADMIN_PASS`** — HTTP Basic Auth for the
  moderation UI and the news composer under `/api/admin`. **Change the
  defaults.**

### Behaviour tuning
- **`GSTMXX_FILTERS`** — comma-separated filter-actor handles to enable
  (default: `ghostyles-pictures,ghostyles-video,ghostyles-daily,ghostyles-weekly,ghostyles-top-rated`).
  A handle's behaviour is derived by parsing it; add a new one just by listing
  it. Unparseable handles are ignored.
- **`GSTMXX_DIGEST_INTERVAL_MS`** (default `300000` = 5 min) — how often the
  in-process scheduler checks whether any digest window is due.
- **`GSTMXX_STALE_DAYS`** (default `14`) — pending uploads older than this are
  swept (media removed, ledger marked deleted).
- **`GSTMXX_UPLOAD_RATE_WINDOW_MS`** (default `900000` = 15 min) and
  **`GSTMXX_UPLOAD_RATE_MAX`** (default `20`) — per-IP limit on `POST
  /api/uploads`.

### Diagnostics (optional) and test-only
- **`DEBUG`** — enable structured logs, e.g. `DEBUG=gstmxx:flow` (also `http`,
  `store`, `activitypub`). Tokens and post bodies are never logged.
- **`NODE_ENV=test`** plus **`GSTMXX_MOCK_VIDEO_PROCESSING=1`** and
  **`GSTMXX_MOCK_FFPROBE=video|other`** bypass ffmpeg/ffprobe in the test suite.
  Never set these in production.

## What to back up

Back up, treated as **secrets** where noted:
- **`data/`** — the whole directory:
  - `data/posts/` — published posts.
  - `data/uploads/` — the moderation ledger.
  - `data/keys.json` **(secret)** and `data/followers.json` — the **federated
    identity**. Lose these and the instance changes identity; every remote
    follower must re-follow.
  - `data/fedify-kv.json` — federation KV (inbox dedup, delivery queue).
  - `data/digests.json` — per-filter digest state.
- **`storage/approved/`** and **`storage/thumbnails/`** — published media.

Do **not** back up:
- **`storage/incoming/`** — ephemeral pre-moderation media.
- the built static client — regenerate it from the client repo.

## The interfaces

1. **Public web + preview.** `GET /posts/:id` is content-negotiated: browsers
   get an Open Graph HTML page, fediverse servers get the ActivityPub object.
   Plus `/feed/<actor>.xml` and `/feed/all.xml` (RSS), and the media paths
   `/videos/`, `/clipboard/`, `/thumbnails/`.
2. **Federation (server-to-server).** `/.well-known/webfinger`, the actor
   documents and inboxes under `/federation/`, for both raw actors (`video`,
   `ghostyles`, `news`, `clipboard`) and the enabled filter actors. Handles
   Follow/Undo, Like/Undo(Like), and delivers Create/Announce/Delete.
3. **Moderation.** `/api/admin/` (Basic Auth): the pending queue, authenticated
   media preview, approve (ffmpeg privacy-strip → publish → federate), reject.
4. **News composer.** `/api/admin/compose` (Basic Auth): staff authoring of text
   + image updates, published directly without the moderation queue.
5. **Control API.** `POST /api/posts`, `/api/posts/:id/announce`,
   `/api/announce/:handle`, `/api/digests/run` — Bearer `LAB_POST_TOKEN`.
6. **CLIs.** `node manual-add-post.js`, `node manual-quote-picture.js` for
   scripted posting/quoting against `LAB_API_URL`.
