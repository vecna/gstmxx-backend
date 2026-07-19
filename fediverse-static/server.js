const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { Readable } = require('node:stream');
const { isDeepStrictEqual } = require('node:util');
const { Temporal } = require('@js-temporal/polyfill');

const ACTOR_HANDLES = ['video', 'ghostyles', 'news', 'clipboard'];
const KEY_ALGORITHMS = ['RSASSA-PKCS1-v1_5', 'Ed25519'];

const DEFAULT_PORT = Number.parseInt(process.env.PORT || '4040', 10);
const DEFAULT_DATA_DIR = process.env.FEDIVERSE_STATIC_DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_PUBLIC_DIR = process.env.FEDIVERSE_STATIC_PUBLIC_DIR || path.join(__dirname, 'public');
const DEFAULT_BASE_URL = process.env.FEDIVERSE_STATIC_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

async function loadFedify() {
   return import('@fedify/fedify');
}

function ensureDir(dir) {
   fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath, fallback) {
   try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
   } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
   }
}

function writeJson(filePath, value) {
   ensureDir(path.dirname(filePath));
   const tempPath = `${filePath}.${process.pid}.tmp`;
   fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
   fs.renameSync(tempPath, filePath);
}

function writeFileIfMissing(filePath, content, encoding = 'utf8') {
   if (fs.existsSync(filePath)) return;
   ensureDir(path.dirname(filePath));
   fs.writeFileSync(filePath, content, encoding);
}

function ensurePublicFixtures(publicDir) {
   ensureDir(publicDir);
   writeFileIfMissing(path.join(publicDir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Static Fediverse Lab</title>
</head>
<body>
  <h1>Static Fediverse Lab</h1>
  <p>This server isolates Fedify from Ghostmaxxing uploads, moderation, ffmpeg, and SQLite.</p>
  <ul>
    <li><a href="/federation/actors/video">@video</a></li>
    <li><a href="/federation/actors/ghostyles">@ghostyles</a></li>
    <li><a href="/federation/actors/news">@news</a></li>
    <li><a href="/federation/actors/clipboard">@clipboard</a></li>
  </ul>
</body>
</html>
`);
   writeFileIfMissing(path.join(publicDir, 'video.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Static video object</title>
<body><h1>Static video object</h1><p>A stand-in for a moderated Ghostmaxxing video publication.</p></body></html>
`);
   writeFileIfMissing(path.join(publicDir, 'ghostyles.json'), JSON.stringify([
      { id: 'brush', title: 'Brush ghostyle' },
      { id: 'soft-contour', title: 'Soft contour ghostyle' }
   ], null, 2));
   writeFileIfMissing(path.join(publicDir, 'news.json'), JSON.stringify([
      { id: 'launch-note', title: 'Static Fediverse lab is online' }
   ], null, 2));
   writeFileIfMissing(
      path.join(publicDir, 'clipboard.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3YfGAAAAABJRU5ErkJggg==', 'base64')
   );
}

function encodeKey(key) {
   return JSON.stringify(Array.from(key || []));
}

function decodeKey(encoded) {
   return JSON.parse(encoded);
}

function encodeValue(value) {
   return Buffer.from(v8.serialize(value)).toString('base64');
}

function decodeValue(encoded) {
   return v8.deserialize(Buffer.from(encoded, 'base64'));
}

function ttlToExpiration(options) {
   if (!options || !options.ttl) return null;
   return Temporal.Now.instant()
      .add(options.ttl.round({ largestUnit: 'hour' }))
      .toString();
}

function isExpired(expiresAt) {
   if (!expiresAt) return false;
   return Temporal.Now.instant().since(Temporal.Instant.from(expiresAt)).sign >= 0;
}

class FileKvStore {
   constructor(filePath) {
      this.filePath = filePath;
      this.values = readJson(filePath, {});
   }

   persist() {
      writeJson(this.filePath, this.values);
   }

   async get(key) {
      const encoded = encodeKey(key);
      const entry = this.values[encoded];
      if (!entry) return undefined;
      if (isExpired(entry.expiresAt)) {
         delete this.values[encoded];
         this.persist();
         return undefined;
      }
      return decodeValue(entry.value);
   }

   async set(key, value, options) {
      this.values[encodeKey(key)] = {
         value: encodeValue(value),
         expiresAt: ttlToExpiration(options)
      };
      this.persist();
   }

   async delete(key) {
      delete this.values[encodeKey(key)];
      this.persist();
   }

   async cas(key, expectedValue, newValue, options) {
      const currentValue = await this.get(key);
      if (!isDeepStrictEqual(currentValue, expectedValue)) return false;
      await this.set(key, newValue, options);
      return true;
   }

   async *list(prefix) {
      for (const [encoded, entry] of Object.entries(this.values)) {
         const key = decodeKey(encoded);
         if (prefix) {
            const prefixParts = Array.from(prefix);
            if (key.length < prefixParts.length) continue;
            if (!prefixParts.every((part, index) => key[index] === part)) continue;
         }
         if (isExpired(entry.expiresAt)) {
            delete this.values[encoded];
            this.persist();
            continue;
         }
         yield { key, value: decodeValue(entry.value) };
      }
   }
}

function createJsonStores(dataDir) {
   ensureDir(dataDir);
   const keysPath = path.join(dataDir, 'keys.json');
   const followersPath = path.join(dataDir, 'followers.json');
   const kvPath = path.join(dataDir, 'fedify-kv.json');

   if (!fs.existsSync(keysPath)) writeJson(keysPath, {});
   if (!fs.existsSync(followersPath)) writeJson(followersPath, {});

   return {
      kv: new FileKvStore(kvPath),
      readKeys: () => readJson(keysPath, {}),
      writeKeys: (keys) => writeJson(keysPath, keys),
      readFollowers: () => readJson(followersPath, {}),
      writeFollowers: (followers) => writeJson(followersPath, followers),
      paths: { keysPath, followersPath, kvPath }
   };
}

function assertActor(handle) {
   if (!ACTOR_HANDLES.includes(handle)) {
      throw new Error(`Unknown static Fediverse actor: ${handle}`);
   }
}

async function ensureActorKeyPairs(handle, fedify, stores) {
   assertActor(handle);
   const allKeys = stores.readKeys();
   allKeys[handle] ||= {};

   for (const algorithm of KEY_ALGORITHMS) {
      if (allKeys[handle][algorithm]) continue;
      const keyPair = await fedify.generateCryptoKeyPair(algorithm);
      allKeys[handle][algorithm] = {
         publicJwk: await fedify.exportJwk(keyPair.publicKey),
         privateJwk: await fedify.exportJwk(keyPair.privateKey)
      };
      stores.writeKeys(allKeys);
   }

   const latest = stores.readKeys();
   const pairs = [];
   for (const algorithm of KEY_ALGORITHMS) {
      pairs.push({
         publicKey: await fedify.importJwk(latest[handle][algorithm].publicJwk, 'public'),
         privateKey: await fedify.importJwk(latest[handle][algorithm].privateJwk, 'private')
      });
   }
   return pairs;
}

function followersFor(stores, handle) {
   const allFollowers = stores.readFollowers();
   return Array.isArray(allFollowers[handle]) ? allFollowers[handle] : [];
}

function addFollower(stores, handle, actorId, inboxUrl) {
   const allFollowers = stores.readFollowers();
   const rows = Array.isArray(allFollowers[handle]) ? allFollowers[handle] : [];
   const next = rows.filter((row) => row.actorId !== actorId);
   next.push({ actorId, inboxUrl, followedActor: handle, createdAt: new Date().toISOString() });
   allFollowers[handle] = next;
   stores.writeFollowers(allFollowers);
}

function removeFollower(stores, handle, actorId) {
   const allFollowers = stores.readFollowers();
   const rows = Array.isArray(allFollowers[handle]) ? allFollowers[handle] : [];
   allFollowers[handle] = rows.filter((row) => row.actorId !== actorId);
   stores.writeFollowers(allFollowers);
}

function staticObjectForActor(handle, baseUrl, fedify) {
   const actor = new URL(`/federation/actors/${handle}`, baseUrl);
   if (handle === 'clipboard') {
      const imageUrl = new URL('/static/clipboard.png', baseUrl);
      return new fedify.Image({
         id: imageUrl,
         name: 'Static clipboard PNG',
         url: imageUrl,
         mediaType: 'image/png',
         attribution: actor
      });
   }

   const pathByActor = {
      video: '/static/video.html',
      ghostyles: '/static/ghostyles.json',
      news: '/static/news.json'
   };
   const titleByActor = {
      video: 'Static workshop video announcement',
      ghostyles: 'Static ghostyle manifest announcement',
      news: 'Static project news announcement'
   };
   const objectUrl = new URL(pathByActor[handle], baseUrl);
   return new fedify.Note({
      id: objectUrl,
      name: titleByActor[handle],
      content: `${titleByActor[handle]} from the isolated Fedify lab.`,
      url: objectUrl,
      attribution: actor
   });
}

async function createFederationForLab(config, stores) {
   const fedify = await loadFedify();
   const federation = fedify.createFederation({
      kv: stores.kv,
      origin: {
         handleHost: new URL(config.baseUrl).host,
         webOrigin: new URL(config.baseUrl).origin
      }
   });

   federation.setActorDispatcher('/federation/actors/{handle}', async (ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return null;
      const keys = await ctx.getActorKeyPairs(handle);
      return new fedify.Person({
         id: ctx.getActorUri(handle),
         preferredUsername: handle,
         name: `Static Fediverse ${handle}`,
         summary: `Isolated static ActivityPub actor for ${handle}.`,
         publicKey: keys[0]?.cryptographicKey,
         assertionMethods: keys.map((key) => key.multikey),
         inbox: ctx.getInboxUri(handle),
         followers: ctx.getFollowersUri(handle),
         endpoints: new fedify.Endpoints({ sharedInbox: ctx.getInboxUri() })
      });
   }).setKeyPairsDispatcher(async (_ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return [];
      return ensureActorKeyPairs(handle, fedify, stores);
   }).mapHandle((_ctx, handle) => {
      return ACTOR_HANDLES.includes(handle) ? handle : null;
   });

   federation.setFollowersDispatcher('/federation/actors/{handle}/followers', (_ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return null;
      return {
         items: followersFor(stores, handle).map((row) => ({
            id: new URL(row.actorId),
            inboxId: new URL(row.inboxUrl)
         }))
      };
   });

   federation.setInboxListeners('/federation/actors/{handle}/inbox', '/federation/inbox')
      .on(fedify.Follow, async (ctx, activity) => {
         const handle = ctx.recipient;
         if (!ACTOR_HANDLES.includes(handle)) return;

         const actorId = activity.actorId;
         const inboxUrl = activity.inboxId || activity.actor?.inboxId;
         if (!actorId || !inboxUrl) return;

         addFollower(stores, handle, actorId.href, inboxUrl.href);
         const acceptActivity = new fedify.Accept({
            id: new URL(`/federation/activities/accept-${handle}-${Date.now()}`, config.baseUrl),
            actor: ctx.getActorUri(handle),
            object: activity
         });
         await ctx.sendActivity({ identifier: handle }, [{ id: actorId, inboxId: inboxUrl }], acceptActivity, {
            immediate: true,
            preferSharedInbox: true
         });
      })
      .on(fedify.Undo, async (ctx, activity) => {
         const handle = ctx.recipient;
         const actorId = activity.actorId;
         if (!ACTOR_HANDLES.includes(handle) || !actorId) return;
         removeFollower(stores, handle, actorId.href);
      });

   federation.__staticLab = { fedify };
   return federation;
}

function requestBaseUrl(req, fallbackBaseUrl) {
   const forwardedProto = req.get('x-forwarded-proto');
   const forwardedHost = req.get('x-forwarded-host');
   const proto = forwardedProto || req.protocol || new URL(fallbackBaseUrl).protocol.replace(':', '');
   const host = forwardedHost || req.get('host') || new URL(fallbackBaseUrl).host;
   return `${proto}://${host}`;
}

function expressRequestToFetchRequest(req, fallbackBaseUrl) {
   const headers = new Headers();
   for (const [key, value] of Object.entries(req.headers || {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
         for (const item of value) headers.append(key, item);
      } else {
         headers.set(key, String(value));
      }
   }

   const init = { method: req.method, headers };
   if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req;
      init.duplex = 'half';
   }

   return new Request(new URL(req.originalUrl || req.url, requestBaseUrl(req, fallbackBaseUrl)), init);
}

function writeFetchResponseToExpress(response, res, next) {
   res.status(response.status);
   response.headers.forEach((value, key) => res.setHeader(key, value));
   if (!response.body) return res.end();
   const stream = Readable.fromWeb(response.body);
   stream.on('error', next);
   return stream.pipe(res);
}

function createStaticFediverseApp(options = {}) {
   const config = {
      dataDir: options.dataDir || DEFAULT_DATA_DIR,
      publicDir: options.publicDir || DEFAULT_PUBLIC_DIR,
      baseUrl: options.baseUrl || DEFAULT_BASE_URL
   };
   ensurePublicFixtures(config.publicDir);
   const stores = createJsonStores(config.dataDir);
   let federationPromise = null;
   const getFederation = () => {
      federationPromise ||= createFederationForLab(config, stores);
      return federationPromise;
   };

   const app = express();
   const bridge = async (req, res, next) => {
      try {
         const federation = await getFederation();
         const response = await federation.fetch(expressRequestToFetchRequest(req, config.baseUrl), {
            contextData: undefined
         });
         return writeFetchResponseToExpress(response, res, next);
      } catch (err) {
         console.error('[Static Fediverse Lab] federation bridge error:', err);
         return next(err);
      }
   };

   app.use('/.well-known', bridge);
   app.use('/federation', bridge);
   app.use(express.json({ limit: '1mb' }));
   app.use('/static', express.static(config.publicDir));

   app.get('/', (_req, res) => {
      return res.sendFile(path.join(config.publicDir, 'index.html'));
   });

   app.get('/healthz', (_req, res) => {
      return res.json({ ok: true, actors: ACTOR_HANDLES });
   });

   app.get('/lab/followers', (_req, res) => {
      return res.json({ ok: true, followers: stores.readFollowers() });
   });

   app.post('/lab/announce/:handle', async (req, res) => {
      const { handle } = req.params;
      if (!ACTOR_HANDLES.includes(handle)) {
         return res.status(404).json({ ok: false, message: 'Unknown actor.' });
      }

      try {
         const federation = await getFederation();
         const fedify = federation.__staticLab.fedify;
         const ctx = federation.createContext(new URL(config.baseUrl), undefined);
         const actor = ctx.getActorUri(handle);
         const object = staticObjectForActor(handle, config.baseUrl, fedify);
         const activity = new fedify.Create({
            id: new URL(`/federation/activities/create-${handle}-${Date.now()}`, config.baseUrl),
            actor,
            object,
            tos: [fedify.PUBLIC_COLLECTION]
         });

         await ctx.sendActivity({ identifier: handle }, 'followers', activity, {
            immediate: true,
            preferSharedInbox: true
         });

         return res.json({
            ok: true,
            actor: handle,
            object: object.id?.href,
            followers: followersFor(stores, handle).length
         });
      } catch (err) {
         console.error('[Static Fediverse Lab] announce error:', err);
         return res.status(500).json({ ok: false, message: err.message });
      }
   });

   app.use((req, res) => {
      return res.status(404).json({ ok: false, message: 'Not found.' });
   });

   app.use((err, _req, res, _next) => {
      if (res.headersSent) return;
      return res.status(err.status || err.statusCode || 500).json({ ok: false, message: err.message });
   });

   return { app, config, stores, getFederation };
}

if (require.main === module) {
   const { app, config } = createStaticFediverseApp();
   app.listen(DEFAULT_PORT, () => {
      console.log(`[Static Fediverse Lab] listening on ${config.baseUrl}`);
      console.log(`[Static Fediverse Lab] data: ${config.dataDir}`);
      console.log(`[Static Fediverse Lab] public: ${config.publicDir}`);
   });
}

module.exports = {
   ACTOR_HANDLES,
   FileKvStore,
   createStaticFediverseApp
};
