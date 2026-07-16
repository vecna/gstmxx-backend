const db = require('../db');
const path = require('path');
const fs = require('fs');

let federationInstance = null;

/**
 * Inizializzazione asincrona di Fedify con Dynamic Import per superare i vincoli CJS.
 */
async function initActivityPub() {
   if (federationInstance) return federationInstance;

   // Importazione dinamica dei moduli ESM nativi di Fedify
   const { createFederation, MemoryKvStore } = await import('@fedify/fedify');

   federationInstance = createFederation({
      kv: new MemoryKvStore(), // Gestione stato volatile a breve termine interna a Fedify
   });

   // 1. Configurazione del Dispatcher degli Attori per i tre profili vincolati
   federationInstance.setActorDispatcher('/federation/actors/{handle}', async (ctx, handle) => {
      const validHandles = ['video', 'ghostyles', 'news'];
      if (!validHandles.includes(handle)) return null;

      // Generazione dinamica della chiave RSA per l'attore (per compatibilità v1.0 usiamo un placeholder statico generabile a freddo)
      // Nota di produzione: integrare crypto.generateKeyPairSync per ruotare chiavi reali persistite su DB
      const mockKey = {
         publicKeyPem: `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0v3... \n-----END PUBLIC KEY-----`
      };

      return {
         id: ctx.getActorUri(handle),
         type: 'Person',
         username: handle,
         name: `Ghostmaxxing ${handle.toUpperCase()}`,
         summary: `Canale ufficiale automatizzato per il flusso ${handle} di Ghostmaxxing.`,
         publicKey: {
            id: new URL('#main-key', ctx.getActorUri(handle)),
            owner: ctx.getActorUri(handle),
            publicKeyPem: mockKey.publicKeyPem
         }
      };
   });

   // 2. Gestione degli Inbox: Ascolto delle attività in entrata (Follow / Undo)
   federationInstance.setInboxListener('/federation/actors/{handle}/inbox', async (ctx, handle, activity) => {
      // Intercettazione dell'attività di Follow (Qualcuno si iscrive da Mastodon)
      if (activity.type === 'Follow') {
         const actorId = activity.actorId; // URL univoco del profilo remoto
         const inboxUrl = activity.inboxId; // URL dove spedire le future notifiche

         try {
            // Registrazione persistente del follower su SQLite
            const stmt = db.prepare(`
               INSERT OR IGNORE INTO ap_followers (actor_id, inbox_url, followed_actor) 
               VALUES (?, ?, ?)
            `);
            stmt.run(actorId.href, inboxUrl.href, handle);

            // Costruzione ed invio dell'attività di Accept automatica per confermare la federazione
            const acceptActivity = {
               '@context': 'https://www.w3.org/ns/activitystreams',
               id: new URL(`#accept-${Date.now()}`, ctx.getActorUri(handle)),
               type: 'Accept',
               actor: ctx.getActorUri(handle).href,
               object: activity
            };

            // Spedizione asincrona verso l'inbox del server remoto
            await ctx.sendActivity(handle, [inboxUrl], acceptActivity);
            console.log(`[ActivityPub] Nuovo follower registrato con successo per l'attore @${handle}: ${actorId.href}`);
         } catch (dbErr) {
            console.error('[ActivityPub DB Register Error]:', dbErr);
         }
      }

      // Intercettazione dell'attività di Undo (Qualcuno smette di seguire / Unfollow)
      if (activity.type === 'Undo' && activity.object && activity.object.type === 'Follow') {
         try {
            const actorId = activity.actorId;
            const stmt = db.prepare('DELETE FROM ap_followers WHERE actor_id = ? AND followed_actor = ?');
            stmt.run(actorId.href, handle);
            console.log(`[ActivityPub] Rimossa sottoscrizione per l'attore @${handle} da parte di: ${actorId.href}`);
         } catch (unfollowErr) {
            console.error('[ActivityPub Unfollow Error]:', unfollowErr);
         }
      }
   });

   return federationInstance;
}

/**
 * Middleware Express per convogliare le richieste HTTP in arrivo verso il motore di Fedify.
 */
async function activityPubMiddleware(req, res, next) {
   const fed = await initActivityPub();
   // Converte la richiesta Express nei Web Streams standard digeriti internamente da Fedify
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
   activityPubMiddleware
};
