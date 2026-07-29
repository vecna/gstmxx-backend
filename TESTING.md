# Testing guide — the two layers

The backend has two test layers, deliberately separated so CI can never
accidentally hit a live server, and so the "does the code hold together"
question stays distinct from "does the deployment actually work".

## Layer 1 — mock / CI (default)

```sh
npm test              # run everything under backend/tests/ except online/
npm run test:coverage # same, with a coverage report
```

- Boots the real Express app in-process on an ephemeral port and drives it over
  real HTTP against an **in-memory SQLite** DB and a **temp storage** dir.
- ffmpeg/ffprobe are faked via `GSTMXX_MOCK_VIDEO_PROCESSING=1` and
  `GSTMXX_MOCK_FFPROBE`, so no binaries are required.
- ActivityPub is **disabled** (`GSTMXX_ENABLE_AP=0`), the supported production
  default until B7 lands.
- Fast, hermetic, no network. This is what a pre-commit / CI hook runs.

Files:
- `layer1.test.js` — the full upload → moderate → publish → delete lifecycle,
  clipboard variant, MIME rejection, stale cleanup, real keypairs, feeds.
- `ap_runtime.test.js` — real Fedify library: proves B1 isolation with AP on and
  pins the correct HTTP entrypoint (`.fetch`) that B7 must use.
- `db.migrations.test.js`, `server.test.js` — migration + isolation edge paths.
- `services/*.test.js`, `bootstrap`/`db`/`paths` — focused unit tests. Each file
  opens with a header explaining exactly what it does and does not cover.

## Layer 2 — online / pre-launch

```sh
# Inert (skips with a banner) unless you point it at a deployed instance:
TEST_BASE_URL=https://ghostmaxxing.vecna.eu \
TEST_ADMIN_PASS=... \
npm run test:online
```

Optional env:
- `TEST_ADMIN_USER` (default `admin`), `TEST_ADMIN_PASS` — enables the
  moderation-path checks; without a password only the auth *gate* is asserted.
- `TEST_ALLOW_PUBLISH=1` — permits the approve/publish path (it federates), off
  by default so a routine online run never emits real Create activities.
- `TEST_MASTODON_ACCT` — flags the B8 follow round-trip runbook.

What it verifies against the real box (through nginx, with TLS, with AP on):
upload round-trip, consent gate, authenticated moderation + private preview,
all four feeds reachable/English/well-formed, WebFinger + actor JSON resolve
with a real key, junk-inbox survival, and (todo/runbook) the Mastodon
Follow→Accept→Create round-trip and Delete/Tombstone.

Several checks are `test.todo` or need a real fixture/credential — this is
scaffolding, and each stub says precisely what to fill in. Everything the suite
creates on the live server is torn down via the delete-token endpoint, so an
online run leaves no residue.

> Note: on the current snapshot the WebFinger/actor assertions are expected to
> **fail** against a real deployment because B7 (the Fedify HTTP bridge) is not
> finished. They are written to go green the day B7 is done correctly — that is
> their purpose.
