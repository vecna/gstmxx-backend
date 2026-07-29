# Ghostmaxxing backend

A single Node/Express process that is both the website and the fediverse
presence for Ghostmaxxing. State is flat JSON files plus media on disk — no
database. ActivityPub is handled by [Fedify](https://fedify.dev); the earlier
SQLite backend has been retired.

## The one idea

**One published record = four surfaces, at one URL.** When a post is published
(`data/posts/<uuid>.json`) it is, at the same time:

1. an Open Graph **web page** — `GET /posts/:id` with `Accept: text/html`;
2. an **ActivityPub object** — the same URL with `Accept: application/activity+json`;
3. an **RSS item** in its actor's feed — `/feed/<actor>.xml`;
4. a **`Create`** delivered to that actor's followers.

## Actors

Raw actors `video`, `ghostyles`, `news`, `clipboard` carry everything accepted.
**Filter actors** are derived entirely from their handle (see
[`lib/digest.js`](lib/digest.js)):

- echo filters — `ghostyles-pictures`, `ghostyles-video` — boost every matching
  item as it is approved;
- digest filters — `ghostyles-daily`, `ghostyles-weekly`, `ghostyles-top-rated`
  — publish one FEP-044f quote per window, headed by a summary of the algorithm.

## How content gets in

- **Public uploads** (video / clipboard image) → `POST /api/uploads` → the
  moderation queue → a moderator approves at `/api/admin/` (ffmpeg strips
  metadata, a thumbnail is cut) → published + federated.
- **News** → the staff composer at `/api/admin/compose` → published directly.

## Run it

```bash
npm install
cp env.example env      # edit HOST/PORT/LAB_BASE_URL and the secrets
npm start               # or: npm run dev
npm test                # node --test, no test framework needed
npm run tunnel          # expose a public origin for real federation testing
```

Requires Node ≥ 20.16 and, for approving videos, `ffmpeg`/`ffprobe` on `PATH`.

## Deploy

nginx serves the static client and the approved media, caches `/posts/` and
`/federation/actors/`, and proxies the backend routes to Node — see
[`nginx/ghostmaxxing.vecna.eu.conf`](nginx/ghostmaxxing.vecna.eu.conf).

## More

Environment variables, what to back up, and every interface are documented in
[`tutorials/operations.md`](tutorials/operations.md).
