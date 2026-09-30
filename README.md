# Ghostmaxxing backend

A single Node/Express process that serves the Ghostmaxxing web, upload,
moderation, RSS, and ActivityPub surfaces. State is flat JSON plus media on
disk; there is no database. ActivityPub is handled by Fedify and bridged through
the same public origin as browser requests.

## The one idea

```text
published post record
└── data/posts/<uuid>.json
    ├── GET /posts/:id as HTML preview
    │   └── services/preview.js
    ├── GET /posts/:id as ActivityPub object
    │   └── server.js Fedify object builders
    ├── GET /feed/<actor>.xml
    │   ├── routes/feeds.js
    │   └── services/xml.js
    └── outbound federation delivery
        ├── @fedify/fedify
        └── data/fedify-kv.json
```

One published post lives in `data/posts/<uuid>.json` and becomes four things at
the same URL: an Open Graph web page, an ActivityPub object, an RSS item, and a
federated activity delivered to followers.

Raw actors are `video`, `ghostyles`, `news`, and `clipboard`. Filter actors are
derived from their handles by `lib/digest.js`: echo filters re-share matching
media immediately, and digest filters publish one quote-style pick per window.

## server.js

```text
npm start / npm run dev / npm run debug
└── server.js
    ├── package.json
    ├── env.example -> process.env
    ├── paths.js
    │   ├── data/posts/*.json
    │   ├── data/uploads/*.json
    │   ├── data/keys.json
    │   ├── data/followers.json
    │   ├── data/fedify-kv.json
    │   ├── data/digests.json
    │   └── storage/{incoming,approved,thumbnails}/
    ├── postStore.js -> debugLog.js
    ├── uploadStore.js -> debugLog.js
    ├── digestStore.js
    ├── lib/digest.js
    ├── routes/uploads.js
    │   ├── uploadStore.js
    │   ├── services/media.js
    │   └── services/videoValidation.js
    ├── routes/admin.js
    │   ├── admin/index.html
    │   ├── admin/compose.html
    │   ├── uploadStore.js
    │   ├── postStore.js
    │   ├── services/video.js -> services/media.js
    │   ├── services/media.js
    │   └── services/news.js -> services/preview.js
    ├── routes/feeds.js -> services/xml.js
    ├── routes/latest.js -> services/news.js
    ├── services/cleanup.js -> services/media.js
    ├── services/likes.js
    ├── services/preview.js
    ├── public/
    └── client-interface/.keep
```

`server.js` is the primary runtime entry point. It creates the Express app,
mounts Fedify on `/.well-known` and `/federation`, serves the lab UI from
`public/`, serves an optional built client from `client-interface/`, exposes the
control API, and starts background cleanup/digest work.

Use `npm run serve` (an alias of `npm start`) to serve the staged client and API
from one origin. `GSTMXX_CLIENT_INTERFACE_DIR` or the legacy
`LAB_CLIENT_INTERFACE_DIR` can point at an isolated staged client directory;
the frontend integration harness uses this to avoid modifying the checkout.

Run locally:

```bash
npm install
cp env.example env
npm start
```

Requires Node >= 20.16. Video approval requires `ffmpeg` and `ffprobe` on
`PATH` unless the test-only mock variables are set.

## manual-add-post.js

```text
npm run post
└── manual-add-post.js
    ├── postClient.js
    │   ├── fedibasic.env or --env-file
    │   ├── LAB_API_URL / PORT
    │   └── LAB_POST_TOKEN
    └── POST /api/posts
        └── server.js -> postStore.js -> data/posts/<uuid>.json
```

`manual-add-post.js` is the CLI entry point for creating a single text,
picture, or quote post through the control API. It can store drafts or publish
immediately with `--publish`.

Example:

```bash
npm run post -- --actor news --publish -- "hello from the CLI"
```

## manual-quote-picture.js

```text
npm run quote-picture
└── manual-quote-picture.js
    ├── postClient.js
    ├── POST /api/posts for the original image post
    ├── POST /api/posts for the quote post
    └── optional POST /api/posts/:id/announce for both posts
```

`manual-quote-picture.js` is the CLI entry point for testing the local quote
authorization flow. It creates an image post, creates a second post quoting it,
and can announce both after both records exist.

## Public and lab files

```text
browser
├── GET /
│   └── public/index.html
│       ├── /static/index.css -> public/index.css
│       └── /static/index.js -> public/index.js
├── GET /lab/
│   └── public/index.html
└── POST /api/announce/:handle
    └── /static/<handle>.json
        ├── public/video.json
        ├── public/ghostyles.json
        ├── public/news.json
        └── public/clipboard.json
```

`public/` is a diagnostic lab, not the production client. It checks health,
config, followers, WebFinger, actor JSON, post creation, and static-object
announce behavior. The four actor JSON files are still used as diagnostic
objects for `/api/announce/:handle`.

`client-interface/.keep` has no code content, but it preserves the optional
static-client directory that `server.js` mounts ahead of backend routes when a
client build is present.

## Admin interfaces

```text
Basic Auth /api/admin
├── routes/admin.js
│   ├── GET /api/admin/ -> admin/index.html
│   ├── GET /api/admin/pending -> uploadStore.js -> data/uploads/*.json
│   ├── GET /api/admin/media/:id -> storage/incoming/<file>
│   ├── POST /api/admin/approve/:id
│   │   ├── services/video.js -> services/media.js
│   │   ├── postStore.js -> data/posts/<uuid>.json
│   │   └── server.js announce/digest hooks
│   ├── POST /api/admin/reject/:id
│   └── GET/POST /api/admin/compose -> admin/compose.html
└── services/news.js -> services/preview.js
```

The moderation UI reviews pending uploads and approves or rejects them. The
composer publishes staff-authored updates directly, optionally with an uploaded
image. Both are protected by `GSTMXX_ADMIN_USER` and `GSTMXX_ADMIN_PASS`.

## Upload and media lifecycle

```text
public upload
└── routes/uploads.js
    ├── multer -> storage/incoming/<uuid.ext>
    ├── services/videoValidation.js
    ├── uploadStore.js -> data/uploads/<uuid>.json
    └── delete endpoint

approval
└── routes/admin.js
    ├── services/video.js
    │   └── services/media.js
    ├── storage/approved/<media>
    ├── storage/thumbnails/<thumb>
    ├── postStore.js -> data/posts/<uuid>.json
    └── services/cleanup.js -> services/media.js
```

Uploads are accepted into a durable moderation ledger and an ephemeral incoming
media file. Approval normalizes media, removes incoming files, creates the post,
and federates it. Rejection and stale cleanup remove incoming media and update
the ledger.

## Feeds, previews, likes, and filters

```text
reader or fediverse request
├── routes/feeds.js
│   ├── postStore.js
│   └── services/xml.js
├── GET /latest
│   └── routes/latest.js -> services/news.js -> services/preview.js
├── GET /posts/:id as HTML
│   └── services/preview.js
├── inbox Like / Undo Like
│   ├── services/likes.js
│   └── postStore.js
└── digest scheduler / POST /api/digests/run
    ├── lib/digest.js
    ├── digestStore.js
    └── postStore.js
```

Feeds are generated from post records, previews render shareable HTML for the
same post URLs, likes update stored post counts, and filter actors use
`lib/digest.js` plus `digestStore.js` to track echo and digest state.

## Configuration and deployment

```text
operator
├── env.example
│   └── server.js / manual CLIs via process.env
├── package.json
│   ├── package-lock.json
│   ├── npm start -> server.js
│   ├── npm test -> test/*.test.js
│   ├── npm run test:coverage -> c8 -> test/*.test.js
│   ├── npm run post -> manual-add-post.js
│   ├── npm run quote-picture -> manual-quote-picture.js
│   └── npm run tunnel -> @fedify/cli
├── .github/workflows/ci.yml
│   ├── npm ci
│   ├── npm test
│   ├── npm run test:coverage
│   └── codecov/codecov-action
├── nginx/ghostmaxxing.vecna.eu.conf
│   ├── /videos /clipboard /thumbnails -> storage/
│   ├── /posts /federation/actors -> cached proxy to server.js
│   ├── /api /feed /.well-known /federation -> proxy to server.js
│   │   └── /api/docs and /api/openapi.json are covered here
│   └── / -> deployed static client
└── .gitignore
```

`env.example`, `package.json`, `package-lock.json`, `.gitignore`, the GitHub
Actions workflow, and the nginx site config are all deployment or repository
configuration. Keep the nginx media aliases synchronized with
`services/media.js`.

## Tests

```text
npm test
└── node --test
    ├── test/smoke.test.js -> server.js
    ├── test/uploads.lifecycle.test.js -> server.js
    ├── test/uploads.ratelimit.test.js -> server.js
    ├── test/publish.web.test.js -> server.js
    ├── test/filters.digest.test.js -> server.js
    ├── test/compose.test.js -> server.js
    ├── test/latest.test.js -> server.js
    ├── test/uploadStore.test.js -> uploadStore.js
    ├── test/postStore.test.js -> postStore.js
    ├── test/digest.test.js -> lib/digest.js
    ├── test/media.test.js -> services/media.js
    ├── test/videoValidation.test.js -> services/videoValidation.js
    ├── test/xml.test.js -> services/xml.js
    ├── test/preview.test.js -> services/preview.js
    ├── test/news.test.js -> services/news.js
    └── test/likes.test.js -> services/likes.js

npm run test:coverage
└── c8
    └── node --test -> test/*.test.js
```

The active test entry points are `npm test`, which runs Node's built-in test
runner, and `npm run test:coverage`, which wraps the same suite with `c8`.
`jest.config.js` and `jest.online.config.js` are not wired to `package.json` and
are listed in `to-deleted.sh`.

## Informational files

```text
repository docs and fixtures
├── README.md
├── tutorials/operations.md
│   └── operator reference for env, backups, interfaces
├── tutorials/openapi.json
│   └── served by server.js at /api/openapi.json and displayed at /api/docs
├── TESTING.md
│   └── historical testing guide; informative but stale against package.json
├── ASSESSMENT.md
│   └── historical July 2026 audit; useful context, not live truth
└── examples/
    ├── picture-post.json -> POST /api/posts payload shape
    └── quote-post.json -> POST /api/posts quote payload shape
```

These files are not runtime dependencies, except that `tutorials/openapi.json`
is served read-only by the API docs route. `tutorials/operations.md` is still
operator documentation. `TESTING.md` and `ASSESSMENT.md` have historical value,
but their claims should be checked against the current code before being used as
runbooks. The example payloads remain useful references for the manual control
API.
