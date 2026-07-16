const db = require('../db');

const ACTOR_HANDLES = ['video', 'ghostyles', 'news', 'clipboard'];
const KEY_ALGORITHMS = ['RSASSA-PKCS1-v1_5', 'Ed25519'];

const { getFedify } = require('./fedifyWrapper');

/**
 * Asserts that the given actor handle is valid.
 * Throws an error if the actor handle is not recognized.
 * 
 * @param {string} actor - The actor handle to validate.
 * @throws {Error} If the actor is not valid.
 * @returns {void}
 */
function assertValidActor(actor) {
   if (!ACTOR_HANDLES.includes(actor)) {
      throw new Error(`Unknown ActivityPub actor: ${actor}`);
   }
}

/**
 * Dynamically loads the Fedify key APIs. Used to bypass CommonJS/ESM module boundaries.
 * 
 * @returns {Promise<{generateCryptoKeyPair: Function, exportJwk: Function, importJwk: Function}>} The imported Fedify cryptographic helper APIs.
 */
async function loadFedifyKeyApi() {
   const fedify = await getFedify();
   return {
      generateCryptoKeyPair: fedify.generateCryptoKeyPair,
      exportJwk: fedify.exportJwk,
      importJwk: fedify.importJwk
   };
}

/**
 * Generates a cryptographic key pair for the specified actor and algorithm,
 * then stores the serialized JWKs into the database.
 * 
 * @param {string} actor - The actor handle (e.g. 'video').
 * @param {string} algorithm - The signature algorithm (e.g. 'RSASSA-PKCS1-v1_5').
 * @returns {Promise<void>}
 */
async function generateAndStoreKeyPair(actor, algorithm) {
   const { generateCryptoKeyPair, exportJwk } = await loadFedifyKeyApi();
   const keyPair = await generateCryptoKeyPair(algorithm);
   const publicJwk = await exportJwk(keyPair.publicKey);
   const privateJwk = await exportJwk(keyPair.privateKey);

   db.prepare(`
      INSERT OR IGNORE INTO keys (actor, algorithm, public_jwk, private_jwk)
      VALUES (?, ?, ?, ?)
   `).run(actor, algorithm, JSON.stringify(publicJwk), JSON.stringify(privateJwk));
}

/**
 * Ensures that both RSA and Ed25519 key pairs exist in the database for the given actor.
 * Generates and stores them if they are missing.
 * 
 * @param {string} actor - The actor handle.
 * @returns {Promise<Object[]>} Array of key pair objects containing CryptoKey instances.
 */
async function ensureActorKeyPairs(actor) {
   assertValidActor(actor);

   for (const algorithm of KEY_ALGORITHMS) {
      const row = db.prepare('SELECT 1 FROM keys WHERE actor = ? AND algorithm = ?').get(actor, algorithm);
      if (!row) {
         await generateAndStoreKeyPair(actor, algorithm);
      }
   }

   return getActorKeyPairs(actor);
}

/**
 * Retrieves the cryptographic key pairs for the specified actor from the database,
 * deserializing their stored JWK data back into CryptoKey instances.
 * 
 * @param {string} actor - The actor handle.
 * @returns {Promise<Object[]>} Array of key pair objects containing CryptoKey instances.
 */
async function getActorKeyPairs(actor) {
   assertValidActor(actor);
   const { importJwk } = await loadFedifyKeyApi();
   const rows = db.prepare(`
      SELECT algorithm, public_jwk, private_jwk
      FROM keys
      WHERE actor = ?
      ORDER BY CASE algorithm
         WHEN 'RSASSA-PKCS1-v1_5' THEN 0
         WHEN 'Ed25519' THEN 1
         ELSE 2
      END
   `).all(actor);

   if (rows.length < KEY_ALGORITHMS.length) {
      return ensureActorKeyPairs(actor);
   }

   const keyPairs = [];
   for (const row of rows) {
      keyPairs.push({
         publicKey: await importJwk(JSON.parse(row.public_jwk), 'public'),
         privateKey: await importJwk(JSON.parse(row.private_jwk), 'private')
      });
   }
   return keyPairs;
}

/**
 * Converts a CryptoKey instance representing a public key into standard PEM string format.
 * 
 * @param {CryptoKey} publicKey - The public key to convert.
 * @returns {Promise<string>} The public key formatted as a PEM string.
 */
async function publicKeyToPem(publicKey) {
   const spki = await crypto.subtle.exportKey('spki', publicKey);
   const base64 = Buffer.from(spki).toString('base64').match(/.{1,64}/g).join('\n');
   return `-----BEGIN PUBLIC KEY-----\n${base64}\n-----END PUBLIC KEY-----`;
}

module.exports = {
   ACTOR_HANDLES,
   KEY_ALGORITHMS,
   ensureActorKeyPairs,
   getActorKeyPairs,
   publicKeyToPem
};
