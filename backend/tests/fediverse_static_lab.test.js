const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStaticFediverseApp } = require('../../fediverse-static/server');

let server;
let baseUrl;
let tempRoot;
let stores;

beforeAll(async () => {
   tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-fediverse-static-'));
   const created = createStaticFediverseApp({
      dataDir: path.join(tempRoot, 'data'),
      publicDir: path.join(tempRoot, 'public'),
      baseUrl: 'http://127.0.0.1'
   });
   stores = created.stores;
   server = created.app.listen(0);
   await new Promise((resolve) => server.once('listening', resolve));
   baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
   if (server) await new Promise((resolve) => server.close(resolve));
   fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('static lab serves static files and health without Ghostmaxxing routes', async () => {
   const health = await fetch(`${baseUrl}/healthz`);
   assert.equal(health.status, 200);
   assert.equal((await health.json()).actors.join(','), 'video,ghostyles,news,clipboard');

   const news = await fetch(`${baseUrl}/static/news.json`);
   assert.equal(news.status, 200);
   assert.match(news.headers.get('content-type') || '', /json/);

   const uploadRoute = await fetch(`${baseUrl}/api/uploads`);
   assert.equal(uploadRoute.status, 404);
});

test('static lab resolves WebFinger and actor JSON for all four actors', async () => {
   const host = new URL(baseUrl).host;
   for (const handle of ['video', 'ghostyles', 'news', 'clipboard']) {
      const webfinger = await fetch(`${baseUrl}/.well-known/webfinger?resource=acct:${handle}@${host}`, {
         headers: { Accept: 'application/jrd+json' }
      });
      assert.equal(webfinger.status, 200, `WebFinger for ${handle}`);
      const jrd = await webfinger.json();
      assert.ok(Array.isArray(jrd.links));

      const actor = await fetch(`${baseUrl}/federation/actors/${handle}`, {
         headers: { Accept: 'application/activity+json' }
      });
      assert.equal(actor.status, 200, `actor JSON for ${handle}`);
      const body = await actor.json();
      assert.equal(body.preferredUsername, handle);
      assert.ok(body.publicKey);
   }

   const keyFile = JSON.parse(fs.readFileSync(stores.paths.keysPath, 'utf8'));
   assert.equal(Object.keys(keyFile).length, 4);
   assert.ok(keyFile.video['RSASSA-PKCS1-v1_5']);
   assert.ok(keyFile.video.Ed25519);
});

test('static lab isolates junk inbox POST and can still announce static objects', async () => {
   const junk = await fetch(`${baseUrl}/federation/actors/video/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/activity+json' },
      body: '{"not":"a valid activity"}'
   });
   assert.ok(junk.status >= 400 && junk.status < 500);

   const actor = await fetch(`${baseUrl}/federation/actors/video`, {
      headers: { Accept: 'application/activity+json' }
   });
   assert.equal(actor.status, 200);

   const announce = await fetch(`${baseUrl}/lab/announce/clipboard`, { method: 'POST' });
   assert.equal(announce.status, 200);
   const body = await announce.json();
   assert.equal(body.ok, true);
   assert.equal(body.actor, 'clipboard');
   assert.equal(body.followers, 0);
   assert.match(body.object, /\/static\/clipboard\.png$/);
});
