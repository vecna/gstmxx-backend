# Static Fediverse Lab

This is a standalone Fedify HTTP server for testing the ActivityPub mechanics
without Ghostmaxxing uploads, moderation, ffmpeg, cleanup jobs, feeds, or the
backend SQLite schema.

It implements the same core federation shape:

- four actors: `video`, `ghostyles`, `news`, `clipboard`
- WebFinger lookup for `acct:<actor>@<host>`
- actor JSON under `/federation/actors/:handle`
- actor inboxes and shared inbox
- `Follow` and `Undo` inbox listeners
- persisted RSA and Ed25519 keypairs in `fediverse-static/data/keys.json`
- persisted followers in `fediverse-static/data/followers.json`
- file-backed Fedify KV in `fediverse-static/data/fedify-kv.json`
- static public files under `/static`

Run it:

```sh
PORT=4040 FEDIVERSE_STATIC_BASE_URL=http://127.0.0.1:4040 npm run fediverse:static
```

Useful curls:

```sh
curl -i http://127.0.0.1:4040/healthz
```

Expected: `200 OK` with JSON containing the four actor handles.

```sh
curl -i -H 'Accept: application/jrd+json' \
  'http://127.0.0.1:4040/.well-known/webfinger?resource=acct:video@127.0.0.1:4040'
```

Expected: `200 OK` JRD JSON with links to the `@video` actor.

```sh
curl -i -H 'Accept: application/activity+json' \
  http://127.0.0.1:4040/federation/actors/video
```

Expected: `200 OK` ActivityPub actor JSON with a real `publicKey`.

```sh
curl -i http://127.0.0.1:4040/static/news.json
```

Expected: `200 OK` static JSON served outside Fedify.

```sh
curl -i -X POST -H 'Content-Type: application/activity+json' \
  --data '{"not":"a valid activity"}' \
  http://127.0.0.1:4040/federation/actors/video/inbox
```

Expected: a clean `4xx` response. The process must keep serving afterwards.

```sh
curl -i -X POST http://127.0.0.1:4040/lab/announce/clipboard
```

Expected: `200 OK` JSON. With no followers it reports `followers: 0`, but still
constructs the same still-image `Create` path used by the real clipboard actor.
