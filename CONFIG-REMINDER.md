# `manual-profile.js`

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

## One JSON file for everything

Long command lines do not survive a second edit. `fedi-profile.example.json`
carries every option for every actor; apply it in one run:

```bash
npm run profile -- --from-json fedi-profile.json --publish          # all actors
npm run profile -- --from-json fedi-profile.json --actor video --publish
npm run profile -- --from-json fedi-profile.json --dry-run          # inspect first
```

Per actor: `displayName`, `bio` (plain text) or `bioHtml` or `bioFile`, `url`,
`fields[]`, `avatarFile`/`avatarUrl`, `headerFile`/`headerUrl`, `discoverable`,
`indexable`. **Paths inside the file resolve against the file itself**, so
`fedi-images/` sits next to `fedi-profile.json` and the whole thing can be
committed and moved as a unit. An omitted key is left untouched; a key set to
`null` is cleared.

Layout:

```
gstmxx-backend/
├── fedi-profile.json
└── fedi-images/
    ├── video-avatar.png      400x400
    ├── video-header.jpg      1500x500
    ├── ghostyles-avatar.png
    └── news-bio.txt          long biographies are easier in a text file
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

---

# Managing the environment

Inline variables in tmux work, but they are exactly how the wrong variable name
went unnoticed for weeks, and they vanish on every reconnect. Pick one of these.

### Recommended: an `env` file

`package.json` now loads it from **all three** entry points — previously only
`npm run debug` did, so `npm start` silently ran with defaults:

```json
"start": "node --env-file-if-exists=env server.js",
"dev":   "node --watch --env-file-if-exists=env server.js",
"debug": "DEBUG=gstmxx:* node --env-file-if-exists=env server.js",
```

```bash
cd ~/gstmxx-backend
cp env.example env
$EDITOR env                  # set GSTMXX_PUBLIC_URL and LAB_POST_TOKEN
chmod 600 env                # it holds the token
echo 'env' >> .gitignore     # never commit it
npm run debug
```

The file is `KEY=value` per line, no `export`, `#` comments allowed. Node's
`--env-file-if-exists` does not do shell expansion, so no `$VAR` inside values.

### Production: systemd, so it survives a reboot and a dropped tmux

```ini
# /etc/systemd/system/gstmxx-backend.service
[Unit]
Description=Ghostmaxxing backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gstmxx
WorkingDirectory=/home/gstmxx/gstmxx-backend
EnvironmentFile=/home/gstmxx/gstmxx-backend/env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gstmxx-backend
journalctl -u gstmxx-backend -f          # the boot banner shows up here
```

`EnvironmentFile` and `--env-file-if-exists` read the same syntax, so one `env`
file serves both the service and your manual `npm run debug` sessions.

With `GSTMXX_STRICT_ORIGIN=1` in that file, a unit that starts at all is a unit
whose origin is federable — the failure moves from "silent 500 three days later"
to "the service did not come up".

### with tmux

```bash
GSTMXX_PUBLIC_URL="https://ghostmaxxing.vecna.eu" \
LAB_POST_TOKEN="12454686765435675456754" \
npm run debug
```

---

## 5. Deploying

```bash
cd ~/gstmxx-backend
grep -n 'PUBLIC_URL\|LAB_BASE_URL' env

# 2. Restart, then confirm before touching Mastodon:
curl -s http://127.0.0.1:4040/healthz | jq .federation
# -> {"canFederate": true, "originIsPrivate": false, "originIsInsecure": false}

curl -sH 'Accept: application/activity+json' \
  https://ghostmaxxing.vecna.eu/federation/actors/video | jq '.id, .publicKey.id'
# -> both must start with https://ghostmaxxing.vecna.eu

# 3. Drain any follow that was stuck while the origin was wrong:
curl -s -X POST -H "Authorization: Bearer $LAB_POST_TOKEN" \
  http://127.0.0.1:4040/api/federation/accepts/retry

# 4. Full picture whenever something looks off:
curl -s -H "Authorization: Bearer $LAB_POST_TOKEN" \
  http://127.0.0.1:4040/api/federation/diagnostics | jq
```

`/healthz` returned 404 through nginx because it was not in the backend
location regex — it fell through to `try_files ... =404`. The updated conf adds
it, so the check above works over TLS too. If you would rather keep it internal,
drop `healthz` from that group and query `127.0.0.1:4040` instead.

If the pending follow from `@vecna@retro.pizza` does not resolve after step 3,
unfollow and re-follow: retro.pizza may have cached the actor document from
before the fix, and the 1-minute actor cache means the refresh is quick.

**Back up** `data/` (now also `profiles.json` and `pending-accepts.json`) and
`storage/approved`, `storage/thumbnails`, `storage/profile`.


