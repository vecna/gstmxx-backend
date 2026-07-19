const v8 = require('node:v8');
const { isDeepStrictEqual } = require('node:util');
const { Temporal } = require('@js-temporal/polyfill');

function encodeKey(key) {
   return JSON.stringify(Array.from(key || []));
}

function decodeKey(encoded) {
   return JSON.parse(encoded);
}

function encodeValue(value) {
   return Buffer.from(v8.serialize(value));
}

function decodeValue(buffer) {
   return v8.deserialize(buffer);
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

class SqliteKvStore {
   constructor(db) {
      this.db = db;
      this.getStmt = db.prepare('SELECT value, expires_at FROM fedify_kv WHERE key = ?');
      this.setStmt = db.prepare(`
         INSERT INTO fedify_kv (key, value, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            expires_at = excluded.expires_at
      `);
      this.deleteStmt = db.prepare('DELETE FROM fedify_kv WHERE key = ?');
      this.listStmt = db.prepare('SELECT key, value, expires_at FROM fedify_kv ORDER BY key ASC');
   }

   async get(key) {
      const encoded = encodeKey(key);
      const row = this.getStmt.get(encoded);
      if (!row) return undefined;
      if (isExpired(row.expires_at)) {
         this.deleteStmt.run(encoded);
         return undefined;
      }
      return decodeValue(row.value);
   }

   async set(key, value, options) {
      this.setStmt.run(encodeKey(key), encodeValue(value), ttlToExpiration(options));
   }

   async delete(key) {
      this.deleteStmt.run(encodeKey(key));
   }

   async cas(key, expectedValue, newValue, options) {
      const currentValue = await this.get(key);
      if (!isDeepStrictEqual(currentValue, expectedValue)) return false;
      await this.set(key, newValue, options);
      return true;
   }

   async *list(prefix) {
      const rows = this.listStmt.all();
      for (const row of rows) {
         const key = decodeKey(row.key);
         if (prefix) {
            if (key.length < prefix.length) continue;
            if (!Array.from(prefix).every((part, index) => key[index] === part)) continue;
         }
         if (isExpired(row.expires_at)) {
            this.deleteStmt.run(row.key);
            continue;
         }
         yield { key, value: decodeValue(row.value) };
      }
   }
}

module.exports = {
   SqliteKvStore
};
