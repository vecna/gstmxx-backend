# Fedify browser lab

A minimal diagnostic scaffold for this path:

```text
browser -> Express HTTP server -> Fedify -> persisted keys/followers
```

It deliberately excludes uploads, SQLite, ffmpeg, moderation, nginx, and the
rest of Ghostmaxxing. This makes it possible to tell whether the basic
browser/server/Fedify path works before adding those components.

## 0. Reminder

- `LAB_BASE_URL` is the public ActivityPub identity, such as
  `https://ghostmaxxing.vecna.eu`.
- `LAB_API_URL` is the local control route used by the CLI, normally
  `http://127.0.0.1:4040`.

## 1. Run on the Linux machine


```
export LAB_POST_TOKEN="$(openssl rand -hex 32)"
LAB_BASE_URL=https://ghostmaxxing.vecna.eu DEBUG=* PORT=3000 npm start
```


```
curl -sS   -H 'Accept: application/jrd+json'   'https://ghostmaxxing.vecna.eu/.well-known/webfinger?resource=acct%3Avideo%40ghostmaxxing.vecna.eu'   | jq
; npm i; cd ..; npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify webfinger @video@ghostmaxxing.vecna.eu
npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify --authorized-fetch --follow @video@ghostmaxxing.vecna.eu
npx fedify inbox --authorized-fetch --follow @video@ghostmaxxing.vecna.eu
```

## 2. Play with posts - Add persistent text 

With the server running:

```sh
npm run post -- "Hello from the video actor"
```

Choose another actor:

```sh
npm run post -- --actor news $'First line\nSecond line 👻'
```

Each post is one readable JSON file under:

```text
data/posts/<uuid>.json
```

Creating a post does not broadcast it by default. To create and immediately
send a `Create(Note)` activity to the actor's current followers:

```sh
npm run post -- --actor news --publish "A federated test post"
```

The server must be running because the CLI talks to its HTTP API. By default it
uses `http://127.0.0.1:$PORT`; override that with `LAB_API_URL` or `--server`.

If the lab is publicly reachable, protect write operations:

```sh
LAB_POST_TOKEN="$(openssl rand -hex 32)" npm start
```

Pass the same `LAB_POST_TOKEN` to the CLI. The browser page also has a token
field. Public post reading remains available through `GET /api/posts` and each
post's ActivityPub URL under `/posts/<uuid>`.


## 3. What the page proves

- **Health** proves ordinary browser-to-Express communication.
- **Configuration** detects a browser/Fedify origin mismatch.
- **WebFinger** proves local ActivityPub account discovery.
- **Actor JSON** proves the dispatcher and persisted keys work.
- **Announce static object** constructs a `Create` and sends it to the current
  followers. With zero followers, `followers: 0` is the correct result.

State is written under `data/`. Delete that directory when changing the public
origin during experiments, because existing ActivityPub identifiers and queued
state may refer to the old origin.

## 4. Why a browser-only localhost test cannot prove federation

The browser can test all local HTTP routes, but an external Mastodon or other
ActivityPub server cannot connect to `127.0.0.1` or a private LAN address. A
real federation round trip needs:

- a public hostname;
- HTTPS;
- inbound reachability from the remote server;
- `LAB_BASE_URL` set to exactly that public origin.

For a temporary test, keep the lab running in one terminal and expose port 4040
in another:

```sh
npx fedify tunnel 4040
```

Restart the server with the HTTPS URL printed by the tunnel:

```sh
rm -rf data
LAB_BASE_URL=https://PUBLIC-TUNNEL-HOST npm start
```

Keep both processes alive. The server already trusts `X-Forwarded-Proto` and
`X-Forwarded-Host`, which the Fedify tunnel supplies.

## 5. Direct checks

```sh
curl -sS http://127.0.0.1:4040/healthz

curl -sS \
  -H 'Accept: application/jrd+json' \
  'http://127.0.0.1:4040/.well-known/webfinger?resource=acct:video@127.0.0.1:4040'

curl -sS \
  -H 'Accept: application/activity+json' \
  http://127.0.0.1:4040/federation/actors/video
```


## Understandable debug output

Do not use `DEBUG=*:*` for normal diagnosis. It enables Express, Fedify, and
every other dependency namespace, so application code cannot make that stream
quiet or coherent.

Use the included script:

```sh
npm run fedibasic:debug
```

Or select only the narrative:

```sh
DEBUG=fedibasic:flow node fedibasic-server.js
```

Each HTTP request has a short correlation ID and numbered state transitions:

```text
fedibasic:flow [3ff5516a] 01 HTTP_RECEIVED method=POST path=/api/posts
fedibasic:flow [3ff5516a] 02 AUTH_ACCEPTED bearerPresent=true
fedibasic:flow [3ff5516a] 03 POST_INPUT actor=video publish=false ...
fedibasic:flow [3ff5516a] 04 POST_VALIDATED ... quoteApproval=none
fedibasic:flow [3ff5516a] 05 POST_STORED postId=... file=...
fedibasic:flow [3ff5516a] 06 POST_NOT_PUBLISHED postId=... followers=0
fedibasic:flow [3ff5516a] 07 HTTP_RESPONDED status=201 durationMs=6.9
```

The other useful namespaces are:

- `fedibasic:http`: server lifecycle.
- `fedibasic:store`: JSON reads, writes, misses, and list counts.
- `fedibasic:activitypub`: Note transformation, Follow processing, and
  delivery.

Tokens and complete post bodies are deliberately not logged.

## Important distinction

`POST /api/announce/:actor` is a browser-facing diagnostic API. It is not an
ActivityPub client-to-server implementation. Browser actions and server-to-
server ActivityPub federation are separate layers; this page lets you inspect
the former while invoking the latter on the server.

## Local testing



The default target is now local:

```sh
npm run post -- --actor video --publish -- "hello from the CLI"
```

An explicit target also works:

```sh
node manual-add-post.js \
  --server http://126.0.0.1:4040 \
  --actor video \
  --publish \
  -- "hello from the CLI"
```

Bare public hosts are normalized to HTTPS, while bare localhost addresses are
normalized to HTTP. Unknown options are rejected, so `--publih` reports
`Did you mean --publish?` instead of becoming part of the post text. Network
errors show the target, nested Node error code, and a relevant hint.

Inspect a request without sending it:

```sh
node manual-add-post.js \
  --server ghostmaxxing.vecna.eu \
  --dry-run \
  -- "test"
```

## Picture followed by a cross-actor quote

The image must be public, require no cookie or token, and return the correct
image `Content-Type`, because the Mastodon server fetches it itself.

```sh
node manual-quote-picture.js \
  --server http://126.0.0.1:4040 \
  --image-url https://ghostmaxxing.vecna.eu/clipboard/example.jpg \
  --image-type image/jpeg \
  --image-alt "A monitor showing the federation test" \
  --image-text "The original picture" \
  --quote-text "Quoting it from the news actor" \
  --image-actor clipboard \
  --quote-actor news \
  --publish
```

Without `--publish`, this is an ordinary storage/serialization test: it creates
both JSON files and sends no ActivityPub deliveries. With `--publish`, the
command first stores both posts successfully, then announces the original and
the quote in that order.

The API equivalents are in `examples/picture-post.json` and
`examples/quote-post.json`. Post the first file, copy its returned `post.url`
into the second file's `quoteUrl`, then post the second file:

```sh
curl -sS http://126.0.0.1:4040/api/posts \
  -H "Authorization: Bearer $LAB_POST_TOKEN" \
  -H "Content-Type: application/json" \
  --data @examples/picture-post.json
```

For two different local actors, the server creates and serves a
`QuoteAuthorization` approval stamp. The delivered quote includes:

- FEP-043f `quote`;
- FEP-043f `quoteAuthorization`;
- compatibility `quoteUrl`, `_misskey_quote`, and `quoteUri`;
- a `quote-inline` fallback link for older software.

The quoted original owns the image attachment; the quoting post has no media
of its own. That matches Mastodon's restriction against adding separate media
to a quote.

This helper intentionally handles the easy, valid case where both actors and
the quoted post are local. Quoting a remote post requires the full asynchronous
`QuoteRequest` → `Accept`/`Reject` flow and is not implemented by this patch.

## Verify

```sh
npm run fedibasic:test
node --check manual-add-post.js
node --check manual-quote-picture.js
```

The added smoke test checks JSON persistence, HTML escaping, image attachment
serialization, FEP quote fields, and the dereferenceable authorization stamp.
