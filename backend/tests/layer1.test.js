const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-layer1-'));

process.env.NODE_ENV = 'test';
process.env.GSTMXX_ENABLE_AP = '0';
process.env.GSTMXX_MOCK_FFPROBE = 'video';
process.env.GSTMXX_MOCK_VIDEO_PROCESSING = '1';
process.env.GSTMXX_DATA_DIR = path.join(tempRoot, 'data');
process.env.GSTMXX_STORAGE_DIR = path.join(tempRoot, 'storage');
process.env.GSTMXX_STALE_DAYS = '14';
process.env.GSTMXX_UPLOAD_RATE_LIMIT_MAX = '100';

const db = require('../src/db');
const { createApp } = require('../src/server');
const {
   STORAGE_APPROVED_DIR,
   STORAGE_INCOMING_DIR,
   STORAGE_THUMBNAILS_DIR
} = require('../src/paths');
const { cleanupStaleUploads } = require('../src/services/cleanup');
const { ensureActorKeyPairs } = require('../src/services/keys');

let server;
let baseUrl;

function resetDb() {
   db.prepare('DELETE FROM uploads').run();
   db.prepare('DELETE FROM ap_followers').run();
   db.prepare('DELETE FROM keys').run();
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

async function uploadFixture(note = 'Layer-1 proof') {
   const form = new FormData();
   form.set('video', new Blob(['fake video bytes'], { type: 'video/mp4' }), 'fixture.mp4');
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
   const auth = Buffer.from('admin:cambiami-subito-2026').toString('base64');
   const response = await fetch(`${baseUrl}/api/admin/approve/${uploadId}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` }
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
