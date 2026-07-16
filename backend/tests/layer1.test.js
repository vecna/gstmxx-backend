const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-layer1-'));
const ghostylesManifestPath = path.join(tempRoot, 'ghostyles.json');
fs.writeFileSync(ghostylesManifestPath, JSON.stringify([
   { id: 'brush', url: 'ghostyles/brush.js' },
   { id: 'soft-contour', url: 'ghostyles/soft-contour.js' }
]));

process.env.NODE_ENV = 'test';
process.env.GSTMXX_ENABLE_AP = '0';
process.env.GSTMXX_MOCK_FFPROBE = 'video';
process.env.GSTMXX_MOCK_VIDEO_PROCESSING = '1';
process.env.GSTMXX_DATA_DIR = path.join(tempRoot, 'data');
process.env.GSTMXX_STORAGE_DIR = path.join(tempRoot, 'storage');
process.env.GSTMXX_STALE_DAYS = '14';
process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX = '100';
process.env.GSTMXX_GHOSTYLES_JSON_PATH = ghostylesManifestPath;

const db = require('../src/db');
const { createApp } = require('../src/server');
const {
   STORAGE_APPROVED_DIR,
   STORAGE_INCOMING_DIR,
   STORAGE_THUMBNAILS_DIR
} = require('../src/paths');
const { cleanupStaleUploads } = require('../src/services/cleanup');
const { ACTOR_HANDLES, ensureActorKeyPairs } = require('../src/services/keys');

let server;
let baseUrl;

function resetDb() {
   db.prepare('DELETE FROM uploads').run();
   db.prepare('DELETE FROM ap_followers').run();
   db.prepare('DELETE FROM keys').run();
   db.prepare('DELETE FROM news').run();
}

function resetStorage() {
   for (const dir of [STORAGE_INCOMING_DIR, STORAGE_APPROVED_DIR, STORAGE_THUMBNAILS_DIR]) {
      fs.mkdirSync(dir, { recursive: true });
      for (const entry of fs.readdirSync(dir)) {
         if (entry === '.gitkeep') continue;
         fs.rmSync(path.join(dir, entry), { force: true, recursive: true });
      }
   }
}

function authHeader() {
   return `Basic ${Buffer.from('admin:cambiami-subito-2026').toString('base64')}`;
}

async function uploadFixture(note = 'Layer-1 proof', kind = 'video') {
   const form = new FormData();
   const file = kind === 'clipboard'
      ? new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])], { type: 'image/png' })
      : new Blob(['fake video bytes'], { type: 'video/mp4' });
   form.set('video', file, kind === 'clipboard' ? 'fixture.png' : 'fixture.mp4');
   form.set('kind', kind);
   form.set('consent_version', 'test-consent');
   form.set('ghostyle_id', 'smokey-eyes');
   form.set('app_version', 'test');
   form.set('user_note', note);

   const response = await fetch(`${baseUrl}/api/uploads`, {
      method: 'POST',
      body: form
   });
   const body = await response.json();
   return { response, body };
}

async function approveUpload(uploadId) {
   const response = await fetch(`${baseUrl}/api/admin/approve/${uploadId}`, {
      method: 'POST',
      headers: { Authorization: authHeader() }
   });
   const body = await response.json();
   return { response, body };
}

beforeAll(async () => {
   server = createApp().listen(0);
   await new Promise((resolve) => server.once('listening', resolve));
   const { port } = server.address();
   baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(() => {
   process.env.GSTMXX_MOCK_FFPROBE = 'video';
   resetDb();
   resetStorage();
});

afterAll(async () => {
   if (server) {
      await new Promise((resolve) => server.close(resolve));
   }
   fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('DELETE /api/uploads/:id rejects a wrong token and deletes a pending upload with the right token', async () => {
   const upload = await uploadFixture();
   assert.equal(upload.response.status, 201);

   const record = db.prepare('SELECT filename, status FROM uploads WHERE id = ?').get(upload.body.uploadId);
   const incomingPath = path.join(STORAGE_INCOMING_DIR, record.filename);
   assert.equal(record.status, 'pending');
   assert.equal(fs.existsSync(incomingPath), true);

   const wrong = await fetch(`${baseUrl}/api/uploads/${upload.body.uploadId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': 'wrong-token' }
   });
   assert.equal(wrong.status, 403);
   assert.equal(fs.existsSync(incomingPath), true);

   const ok = await fetch(`${baseUrl}/api/uploads/${upload.body.uploadId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': upload.body.deleteToken }
   });
   const okBody = await ok.json();
   assert.equal(ok.status, 200);
   assert.equal(okBody.ok, true);
   assert.equal(fs.existsSync(incomingPath), false);
   assert.equal(db.prepare('SELECT status FROM uploads WHERE id = ?').get(upload.body.uploadId).status, 'deleted');

   const gone = await fetch(`${baseUrl}/api/uploads/${upload.body.uploadId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': upload.body.deleteToken }
   });
   assert.equal(gone.status, 410);
});

test('DELETE /api/uploads/:id unpublishes an approved upload and removes approved media plus thumbnail', async () => {
   const upload = await uploadFixture('approved delete');
   const approval = await approveUpload(upload.body.uploadId);
   assert.equal(approval.response.status, 200);

   const thumbnailName = `thumb-${upload.body.uploadId}.png`;
   const thumbnailPath = path.join(STORAGE_THUMBNAILS_DIR, thumbnailName);
   fs.writeFileSync(thumbnailPath, 'thumb');
   db.prepare('UPDATE uploads SET thumbnail_filename = ? WHERE id = ?').run(thumbnailName, upload.body.uploadId);

   const record = db.prepare('SELECT filename, thumbnail_filename, status FROM uploads WHERE id = ?').get(upload.body.uploadId);
   const approvedPath = path.join(STORAGE_APPROVED_DIR, record.filename);
   assert.equal(record.status, 'approved');
   assert.equal(fs.existsSync(approvedPath), true);
   assert.equal(fs.existsSync(thumbnailPath), true);

   const response = await fetch(`${baseUrl}/api/uploads/${upload.body.uploadId}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': upload.body.deleteToken }
   });
   const body = await response.json();
   assert.equal(response.status, 200);
   assert.equal(body.federation.reason, 'activitypub-disabled');
   assert.equal(fs.existsSync(approvedPath), false);
   assert.equal(fs.existsSync(thumbnailPath), false);
   assert.equal(db.prepare('SELECT status FROM uploads WHERE id = ?').get(upload.body.uploadId).status, 'deleted');
});

test('clipboard PNG uploads use the same queue and approve path', async () => {
   const upload = await uploadFixture('clipboard proof', 'clipboard');
   assert.equal(upload.response.status, 201);

   let row = db.prepare('SELECT id, filename, kind, status FROM uploads WHERE id = ?').get(upload.body.uploadId);
   assert.equal(row.kind, 'clipboard');
   assert.equal(row.status, 'pending');
   assert.equal(path.extname(row.filename), '.png');

   const approval = await approveUpload(upload.body.uploadId);
   assert.equal(approval.response.status, 200);
   assert.equal(approval.body.kind, 'clipboard');
   assert.equal(approval.body.federation.reason, 'activitypub-disabled');

   row = db.prepare('SELECT filename, kind, status FROM uploads WHERE id = ?').get(upload.body.uploadId);
   assert.equal(row.kind, 'clipboard');
   assert.equal(row.status, 'approved');
   assert.equal(path.extname(row.filename), '.png');
   assert.equal(fs.existsSync(path.join(STORAGE_APPROVED_DIR, row.filename)), true);
});

test('POST /api/uploads rejects a MIME-spoofed non-video after ffprobe and unlinks it', async () => {
   process.env.GSTMXX_MOCK_FFPROBE = 'invalid';
   const beforeFiles = fs.readdirSync(STORAGE_INCOMING_DIR).filter((entry) => entry !== '.gitkeep');

   const upload = await uploadFixture('bad mime');

   const afterFiles = fs.readdirSync(STORAGE_INCOMING_DIR).filter((entry) => entry !== '.gitkeep');
   assert.equal(upload.response.status, 400);
   assert.equal(upload.body.ok, false);
   assert.deepEqual(afterFiles, beforeFiles);
   assert.equal(db.prepare('SELECT COUNT(*) AS count FROM uploads').get().count, 0);
});

test('admin page lists pending uploads, filters by kind, and previews private media', async () => {
   const video = await uploadFixture('video pending', 'video');
   const clipboard = await uploadFixture('clipboard pending', 'clipboard');

   const page = await fetch(`${baseUrl}/api/admin/`, {
      headers: { Authorization: authHeader() }
   });
   assert.equal(page.status, 200);
   assert.match(await page.text(), /Ghostmaxxing moderation/);

   const pending = await fetch(`${baseUrl}/api/admin/pending?kind=clipboard`, {
      headers: { Authorization: authHeader() }
   });
   const pendingBody = await pending.json();
   assert.equal(pending.status, 200);
   assert.equal(pendingBody.pending.length, 1);
   assert.equal(pendingBody.pending[0].id, clipboard.body.uploadId);
   assert.equal(pendingBody.pending[0].kind, 'clipboard');
   assert.match(pendingBody.pending[0].publicUrl, /\/clipboard\//);

   const image = await fetch(`${baseUrl}/api/admin/media/${clipboard.body.uploadId}`, {
      headers: { Authorization: authHeader() }
   });
   assert.equal(image.status, 200);
   assert.match(image.headers.get('content-type'), /image\/png/);

   const videoMedia = await fetch(`${baseUrl}/api/admin/media/${video.body.uploadId}`, {
      headers: { Authorization: authHeader() }
   });
   assert.equal(videoMedia.status, 200);
});

test('admin news insert route feeds /feed/news.xml and ghostyles feed reads the manifest', async () => {
   const created = await fetch(`${baseUrl}/api/admin/news`, {
      method: 'POST',
      headers: {
         Authorization: authHeader(),
         'Content-Type': 'application/json'
      },
      body: JSON.stringify({
         title: 'Launch note',
         body: 'Ghostmaxxing backend feeds are alive.',
         link: 'https://ghostmaxxing.vecna.eu/news/launch-note'
      })
   });
   assert.equal(created.status, 201);

   const news = await fetch(`${baseUrl}/feed/news.xml`);
   const newsXml = await news.text();
   assert.equal(news.status, 200);
   assert.match(newsXml, /<language>en<\/language>/);
   assert.match(newsXml, /Launch note/);
   assert.match(newsXml, /Ghostmaxxing backend feeds are alive\./);

   const ghostyles = await fetch(`${baseUrl}/feed/ghostyles.xml`);
   const ghostylesXml = await ghostyles.text();
   assert.equal(ghostyles.status, 200);
   assert.match(ghostylesXml, /<language>en<\/language>/);
   assert.match(ghostylesXml, /Ghostyle: brush/);
   assert.match(ghostylesXml, /ghostyles\/brush\.js/);
});

test('/feed/videos.xml is English and excludes approved clipboard images', async () => {
   const video = await uploadFixture('video feed item', 'video');
   const clipboard = await uploadFixture('clipboard feed item', 'clipboard');
   await approveUpload(video.body.uploadId);
   await approveUpload(clipboard.body.uploadId);

   const response = await fetch(`${baseUrl}/feed/videos.xml`);
   const xml = await response.text();
   assert.equal(response.status, 200);
   assert.match(xml, /<language>en<\/language>/);
   assert.match(xml, new RegExp(video.body.uploadId));
   assert.doesNotMatch(xml, new RegExp(clipboard.body.uploadId));
   assert.match(xml, /Workshop video/);
});

test('cleanupStaleUploads marks old pending uploads deleted and removes their files', () => {
   const staleFile = 'stale.mp4';
   const freshFile = 'fresh.mp4';
   fs.writeFileSync(path.join(STORAGE_INCOMING_DIR, staleFile), 'stale');
   fs.writeFileSync(path.join(STORAGE_INCOMING_DIR, freshFile), 'fresh');

   db.prepare(`
      INSERT INTO uploads (id, filename, status, consent_version, delete_token, created_at)
      VALUES (?, ?, 'pending', 'test', ?, ?)
   `).run('stale-id', staleFile, 'stale-token', '2026-06-01 00:00:00');

   db.prepare(`
      INSERT INTO uploads (id, filename, status, consent_version, delete_token, created_at)
      VALUES (?, ?, 'pending', 'test', ?, ?)
   `).run('fresh-id', freshFile, 'fresh-token', '2026-07-15 00:00:00');

   const result = cleanupStaleUploads(new Date('2026-07-16T12:00:00Z'));
   assert.deepEqual(result, { scanned: 1, deleted: 1 });
   assert.equal(fs.existsSync(path.join(STORAGE_INCOMING_DIR, staleFile)), false);
   assert.equal(fs.existsSync(path.join(STORAGE_INCOMING_DIR, freshFile)), true);
   assert.equal(db.prepare('SELECT status FROM uploads WHERE id = ?').get('stale-id').status, 'deleted');
   assert.equal(db.prepare('SELECT status FROM uploads WHERE id = ?').get('fresh-id').status, 'pending');
});

test('ActivityPub actor keys are real, persisted RSA and Ed25519 pairs', async () => {
   const first = await ensureActorKeyPairs('video');
   const second = await ensureActorKeyPairs('video');
   const rows = db.prepare(`
      SELECT actor, algorithm, public_jwk, private_jwk
      FROM keys
      WHERE actor = ?
      ORDER BY CASE algorithm
         WHEN 'RSASSA-PKCS1-v1_5' THEN 0
         WHEN 'Ed25519' THEN 1
         ELSE 2
      END
   `).all('video');

   assert.equal(first.length, 2);
   assert.equal(second.length, 2);
   assert.equal(rows.length, 2);
   assert.equal(rows.map((row) => String(row.algorithm)).join(','), 'RSASSA-PKCS1-v1_5,Ed25519');
   assert.match(rows[0].public_jwk, /"kty":"RSA"/);
   assert.match(rows[1].public_jwk, /"crv":"Ed25519"/);
});

test('ActivityPub actor handle set includes video, ghostyles, news, and clipboard', async () => {
   assert.equal(ACTOR_HANDLES.join(','), 'video,ghostyles,news,clipboard');
   for (const handle of ACTOR_HANDLES) {
      const pairs = await ensureActorKeyPairs(handle);
      assert.equal(pairs.length, 2);
   }
});
