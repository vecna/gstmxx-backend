# Ghostmaxxing Backend

## Runtime Requirements

- Node.js 20 or newer.
- npm dependencies installed with `npm install`.
- `ffmpeg` available on `PATH`. The admin approval path uses `ffmpeg`/`ffprobe`
  through `fluent-ffmpeg` to normalize approved uploads and generate thumbnails.

## Start Locally

```sh
npm start
```

Expected result: the backend starts on `PORT` or `3000` by default.

## B1/B2 Verification Curls

These commands reproduce the ActivityPub-disabled Layer-1 smoke test used for
the backend stabilization checkpoint.

Start the backend with ActivityPub disabled and the test-mode ffmpeg boundary
mock enabled:

```sh
PORT=31337 \
NODE_ENV=test \
GSTMXX_ENABLE_AP=0 \
GSTMXX_MOCK_VIDEO_PROCESSING=1 \
GSTMXX_DATA_DIR=/private/tmp/gstmxx-b1b2-data \
GSTMXX_STORAGE_DIR=/private/tmp/gstmxx-b1b2-storage \
npm start
```

Expected result: logs include:

```text
[Ghostmaxxing Backend] ActivityPub disabled. Set GSTMXX_ENABLE_AP=1 to enable it.
[Ghostmaxxing Backend] Server avviato sulla porta 31337
```

Check the public video feed:

```sh
curl -sS -i http://127.0.0.1:31337/feed/videos.xml
```

Expected result: `HTTP/1.1 200 OK`, `Content-Type: application/xml`, and a valid
RSS document with a `<channel>` element.

Upload a workshop video payload. In the Layer-1 mock this uses `package.json`
with a forced multipart content type so the route contract is exercised without
depending on local `ffmpeg`:

```sh
curl -sS -i \
  -F video=@package.json\;type=video/mp4 \
  -F consent_version=b1b2-layer1 \
  -F ghostyle_id=smokey-eyes \
  -F app_version=test \
  -F user_note=B1B2-proof \
  http://127.0.0.1:31337/api/uploads
```

Expected result: `HTTP/1.1 201 Created` and a JSON body like:

```json
{
  "ok": true,
  "uploadId": "<uuid>",
  "deleteToken": "<hex-token>",
  "message": "Upload ricevuto ed inserito nella coda di moderazione umana."
}
```

Approve the uploaded item. Replace `<uploadId>` with the ID returned by the
previous command:

```sh
curl -sS -i \
  -u admin:cambiami-subito-2026 \
  -X POST \
  http://127.0.0.1:31337/api/admin/approve/<uploadId>
```

Expected result: `HTTP/1.1 200 OK` and a JSON body like:

```json
{
  "ok": true,
  "message": "Video normalizzato e pubblicato con successo.",
  "video": "pub-<generated-name>.mp4",
  "thumbnail": null
}
```

Send junk to the ActivityPub inbox path while ActivityPub is disabled:

```sh
curl -sS -i \
  -X POST \
  http://127.0.0.1:31337/federation/actors/video/inbox \
  -H 'Content-Type: application/json' \
  --data '{"type":"Follow","actor":"https://example.invalid/@junk"}'
```

Expected result: `HTTP/1.1 404 Not Found` and:

```json
{
  "ok": false,
  "message": "Risorsa non trovata."
}
```

Send malformed JSON to confirm a single bad request is isolated:

```sh
curl -sS -i \
  -H 'Content-Type: application/json' \
  --data '{bad-json' \
  http://127.0.0.1:31337/api/uploads
```

Expected result: `HTTP/1.1 400 Bad Request` and a JSON parse-error response. The
server logs the isolated request error and continues running.

Confirm the process is still alive after the bad requests:

```sh
curl -sS -i http://127.0.0.1:31337/feed/videos.xml
```

Expected result: `HTTP/1.1 200 OK`; after approval, the RSS contains an `<item>`
for the uploaded `uploadId`.

