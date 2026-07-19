const db = require('../db');
const { Readable } = require('node:stream');
const { ACTOR_HANDLES, getActorKeyPairs } = require('./keys');
const { SqliteKvStore } = require('./sqliteKvStore');
const { publicPathForUpload } = require('./publicUrls');

let federationInstance = null;
const BASE_URL = process.env.GSTMXX_BASE_URL || 'https://ghostmaxxing.vecna.eu';

function isActivityPubEnabled() {
   return /^(1|true|yes|on)$/i.test(process.env.GSTMXX_ENABLE_AP || '');
}

const { getFedify } = require('./fedifyWrapper');

/**
 * Asynchronously initializes the Fedify ActivityPub federation instance.
 * Uses dynamic imports to load ESM packages in a CommonJS context.
 * 
 * @returns {Promise<Object>} The initialized Fedify federation instance.
 */
async function initActivityPub() {
   if (federationInstance) return federationInstance;

   // Importazione dinamica dei moduli ESM nativi di Fedify
   const {
      Accept,
      Create,
      createFederation,
      Delete,
      Endpoints,
      Follow,
      Image,
      Note,
      Person,
      PUBLIC_COLLECTION,
      Tombstone,
      Undo
   } = await getFedify();

   federationInstance = createFederation({
      kv: new SqliteKvStore(db),
   });

   federationInstance.setActorDispatcher('/federation/actors/{handle}', async (ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return null;

      const keys = await ctx.getActorKeyPairs(handle);
      return new Person({
         id: ctx.getActorUri(handle),
         preferredUsername: handle,
         name: `Ghostmaxxing ${handle.toUpperCase()}`,
         summary: `Canale ufficiale automatizzato per il flusso ${handle} di Ghostmaxxing.`,
         publicKey: keys[0]?.cryptographicKey,
         assertionMethods: keys.map((key) => key.multikey),
         inbox: ctx.getInboxUri(handle),
         followers: ctx.getFollowersUri(handle),
         endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() })
      });
   }).setKeyPairsDispatcher(async (_ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return [];
      return getActorKeyPairs(handle);
   }).mapHandle((_ctx, handle) => {
      return ACTOR_HANDLES.includes(handle) ? handle : null;
   });

   federationInstance.setFollowersDispatcher('/federation/actors/{handle}/followers', (_ctx, handle) => {
      if (!ACTOR_HANDLES.includes(handle)) return null;

      const rows = db.prepare(`
         SELECT actor_id, inbox_url
         FROM ap_followers
         WHERE followed_actor = ?
      `).all(handle);

      return {
         items: rows.map((row) => ({
            id: new URL(row.actor_id),
            inboxId: new URL(row.inbox_url)
         }))
      };
   });

   federationInstance.setInboxListeners('/federation/actors/{handle}/inbox', '/federation/inbox')
      .on(Follow, async (ctx, activity) => {
         const handle = ctx.recipient;
         if (!ACTOR_HANDLES.includes(handle)) return;

         const actorId = activity.actorId;
         const inboxUrl = activity.inboxId || activity.actor?.inboxId;
         if (!actorId || !inboxUrl) return;

         try {
            db.prepare(`
               INSERT OR IGNORE INTO ap_followers (actor_id, inbox_url, followed_actor)
               VALUES (?, ?, ?)
            `).run(actorId.href, inboxUrl.href, handle);

            const acceptActivity = new Accept({
               id: new URL(`#accept-${Date.now()}`, ctx.getActorUri(handle)),
               actor: ctx.getActorUri(handle),
               object: activity
            });

            await ctx.sendActivity({ identifier: handle }, [{ id: actorId, inboxId: inboxUrl }], acceptActivity);
            console.log(`[ActivityPub] Nuovo follower registrato con successo per l'attore @${handle}: ${actorId.href}`);
         } catch (err) {
            console.error('[ActivityPub Follow Error]:', err);
         }
      })
      .on(Undo, async (ctx, activity) => {
         const handle = ctx.recipient;
         if (!ACTOR_HANDLES.includes(handle)) return;

         try {
            const actorId = activity.actorId;
            if (!actorId) return;

            db.prepare('DELETE FROM ap_followers WHERE actor_id = ? AND followed_actor = ?').run(actorId.href, handle);
            console.log(`[ActivityPub] Rimossa sottoscrizione per l'attore @${handle} da parte di: ${actorId.href}`);
         } catch (err) {
            console.error('[ActivityPub Undo Error]:', err);
         }
      });

   federationInstance.__gstmxxClasses = { Create, Delete, Image, Note, PUBLIC_COLLECTION, Tombstone };
   return federationInstance;
}

function uploadActor(upload) {
   return upload.kind === 'clipboard' ? 'clipboard' : 'video';
}

function uploadPublicPath(upload) {
   return publicPathForUpload(upload);
}

async function emitCreateForUpload(upload) {
   if (!isActivityPubEnabled()) {
      return { skipped: true, reason: 'activitypub-disabled' };
   }

   try {
      const fed = await initActivityPub();
      const { Create, Image, Note, PUBLIC_COLLECTION } = fed.__gstmxxClasses || await getFedify();
      const actorHandle = uploadActor(upload);
      const ctx = fed.createContext(new URL(BASE_URL), undefined);
      const actor = ctx.getActorUri(actorHandle);
      const publicUrl = new URL(uploadPublicPath(upload), BASE_URL);
      const object = upload.kind === 'clipboard'
         ? new Image({
            id: publicUrl,
            name: upload.user_note || 'Ghostmaxxing clipboard image',
            url: publicUrl,
            mediaType: 'image/png',
            attribution: actor
         })
         : new Note({
            id: publicUrl,
            name: 'Ghostmaxxing workshop video',
            content: upload.user_note || 'A moderated Ghostmaxxing workshop video was published.',
            url: publicUrl,
            attribution: actor
         });

      const activity = new Create({
         id: new URL(`/federation/activities/create-${upload.id}-${Date.now()}`, BASE_URL),
         actor,
         object,
         tos: [PUBLIC_COLLECTION]
      });

      await ctx.sendActivity({ identifier: actorHandle }, 'followers', activity, {
         immediate: true,
         preferSharedInbox: true
      });

      return { skipped: false };
   } catch (err) {
      console.error('[ActivityPub Create Emit Error]:', err);
      return { skipped: false, failed: true, message: err.message };
   }
}

async function emitDeleteForUpload(upload) {
   if (!isActivityPubEnabled()) {
      return { skipped: true, reason: 'activitypub-disabled' };
   }

   try {
      const fed = await initActivityPub();
      const { Delete, Tombstone } = fed.__gstmxxClasses || await getFedify();
      const actorHandle = uploadActor(upload);
      const ctx = fed.createContext(new URL(BASE_URL), undefined);
      const actor = ctx.getActorUri(actorHandle);
      const objectId = new URL(uploadPublicPath(upload), BASE_URL);
      const activity = new Delete({
         id: new URL(`/federation/activities/delete-${upload.id}-${Date.now()}`, BASE_URL),
         actor,
         object: new Tombstone({ id: objectId })
      });

      await ctx.sendActivity({ identifier: actorHandle }, 'followers', activity, {
         immediate: true,
         preferSharedInbox: true
      });

      return { skipped: false };
   } catch (err) {
      console.error('[ActivityPub Delete Emit Error]:', err);
      return { skipped: false, failed: true, message: err.message };
   }
}

/**
 * Middleware Express per convogliare le richieste HTTP in arrivo verso il motore di Fedify.
 */
async function activityPubMiddleware(req, res, next) {
   try {
      const fed = await initActivityPub();
      const request = expressRequestToFetchRequest(req);
      const response = await fed.fetch(request, { contextData: undefined });

      res.status(response.status);
      response.headers.forEach((value, key) => {
         res.setHeader(key, value);
      });

      if (!response.body) {
         return res.end();
      }

      const stream = Readable.fromWeb(response.body);
      stream.on('error', next);
      return stream.pipe(res);
   } catch (err) {
      console.error('[Fedify Request Handler Error]:', err);
      return next(err);
   }
}

function requestBaseUrl(req) {
   const forwardedProto = req.get && req.get('x-forwarded-proto');
   const forwardedHost = req.get && req.get('x-forwarded-host');
   const proto = forwardedProto || req.protocol || new URL(BASE_URL).protocol.replace(':', '');
   const host = forwardedHost || (req.get && req.get('host')) || new URL(BASE_URL).host;
   return `${proto}://${host}`;
}

function expressRequestToFetchRequest(req) {
   const headers = new Headers();
   for (const [key, value] of Object.entries(req.headers || {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
         for (const item of value) headers.append(key, item);
      } else {
         headers.set(key, String(value));
      }
   }

   const init = {
      method: req.method,
      headers
   };
   if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = req;
      init.duplex = 'half';
   }

   return new Request(new URL(req.originalUrl || req.url, requestBaseUrl(req)), init);
}

module.exports = {
   initActivityPub,
   activityPubMiddleware,
   emitCreateForUpload,
   emitDeleteForUpload,
   isActivityPubEnabled
};
