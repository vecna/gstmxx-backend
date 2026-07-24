# Fedify browser lab

A minimal diagnostic scaffold for this path:

```text
browser -> Express HTTP server -> Fedify -> persisted keys/followers
```

It deliberately excludes uploads, SQLite, ffmpeg, moderation, nginx, and the
rest of Ghostmaxxing. This makes it possible to tell whether the basic
browser/server/Fedify path works before adding those components.

## 1. & 2. Run on the Linux machine



```
curl -sS   -H 'Accept: application/jrd+json'   'https://ghostmaxxing.vecna.eu/.well-known/webfinger?resource=acct%3Avideo%40ghostmaxxing.vecna.eu'   | jq
; npm i; cd ..; npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify webfinger @video@ghostmaxxing.vecna.eu
npx fedify lookup @video@ghostmaxxing.vecna.eu
npx fedify --authorized-fetch --follow @video@ghostmaxxing.vecna.eu
npx fedify inbox --authorized-fetch --follow @video@ghostmaxxing.vecna.eu
```


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

## Important distinction

`POST /api/announce/:actor` is a browser-facing diagnostic API. It is not an
ActivityPub client-to-server implementation. Browser actions and server-to-
server ActivityPub federation are separate layers; this page lets you inspect
the former while invoking the latter on the server.
