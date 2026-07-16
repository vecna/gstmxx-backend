const db = require('../db');
const { ACTOR_HANDLES, getActorKeyPairs } = require('./keys');

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
      createFederation,
      Delete,
      Endpoints,
      Follow,
      MemoryKvStore,
      Person,
      Tombstone,
      Undo
   } = await getFedify();

   federationInstance = createFederation({
      kv: new MemoryKvStore(),
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

   federationInstance.__gstmxxClasses = { Delete, Tombstone };
   return federationInstance;
}

async function emitDeleteForUpload(upload) {
   if (!isActivityPubEnabled()) {
      return { skipped: true, reason: 'activitypub-disabled' };
   }

   try {
      const fed = await initActivityPub();
      const { Delete, Tombstone } = fed.__gstmxxClasses || await getFedify();
      const ctx = fed.createContext(new URL(BASE_URL), undefined);
      const actor = ctx.getActorUri('video');
      const objectId = new URL(`/videos/${upload.id}`, BASE_URL);
      const activity = new Delete({
         id: new URL(`/federation/activities/delete-${upload.id}-${Date.now()}`, BASE_URL),
         actor,
         object: new Tombstone({ id: objectId })
      });

      await ctx.sendActivity({ identifier: 'video' }, 'followers', activity, {
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
   const fed = await initActivityPub();
   fed.handle(req).then(response => {
      if (response) {
         response.headers.forEach((val, key) => res.setHeader(key, val));
         res.status(response.status);
         response.text().then(body => res.send(body));
      } else {
         next();
      }
   }).catch(err => {
      console.error('[Fedify Request Handler Error]:', err);
      next();
   });
}

module.exports = {
   initActivityPub,
   activityPubMiddleware,
   emitDeleteForUpload,
   isActivityPubEnabled
};
