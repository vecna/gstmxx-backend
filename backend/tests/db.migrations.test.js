/**
 * INTEGRATION TEST — src/db.js migrations & CHECK constraints (ADDED).
 *
 * WHY THIS FILE EXISTS
 *   db.js was the least-covered core module (~50%). The uncovered lines were
 *   the in-place forward-migration branches: migrateUploadsTable() and
 *   migrateFollowersTable(), which only run when an OLD-schema table already
 *   exists on disk. A fresh in-memory DB (what every other test uses) always
 *   takes the "table doesn't exist -> just CREATE" path and never touches them.
 *
 * HOW WE REACH THE MIGRATION BRANCHES
 *   We point GSTMXX_DB_PATH at a temp FILE, pre-seed it with the OLD schema
 *   (no 'deleted' status, no 'kind'/'thumbnail_filename' columns, no 'clipboard'
 *   follower) plus one row, THEN require a fresh copy of db.js. On import db.js
 *   runs its migrations against our seeded table, so we can assert the row
 *   survived and the schema was upgraded.
 *
 * ALSO TESTED
 *   The live CHECK constraints reject bogus enum values and accept the
 *   §8-delta 'clipboard' values (both the uploads.kind and the
 *   ap_followers.followed_actor widening).
 */

'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

describe('db.js forward migrations (old schema -> current schema)', () => {
   let tmpDir;
   let dbFile;

   beforeEach(() => {
      jest.resetModules();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstmxx-migrate-'));
      dbFile = path.join(tmpDir, 'old.sqlite');
   });

   afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.GSTMXX_DB_PATH;
   });

   test('upgrades a pre-"deleted"/pre-"kind"/pre-"thumbnail" uploads table and preserves rows', () => {
      // 1) Seed the OLD schema with a separate connection, then close it.
      const seed = new Database(dbFile);
      seed.prepare(`
         CREATE TABLE uploads (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            status TEXT CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
            consent_version TEXT NOT NULL,
            ghostyle_id TEXT,
            app_version TEXT,
            user_note TEXT,
            metrics_json TEXT,
            delete_token TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            moderated_at TEXT
         )
      `).run();
      seed.prepare(`
         INSERT INTO uploads (id, filename, status, consent_version, delete_token)
         VALUES ('legacy-1', 'old.mp4', 'approved', 'v0', 'tok')
      `).run();
      seed.close();

      // 2) Point db.js at our seeded file and require it fresh so migrations run.
      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_DB_PATH = dbFile;
      let db;
      jest.isolateModules(() => { db = require('../src/db'); });

      // 3) The pre-existing row must survive the rename+backfill...
      const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get('legacy-1');
      expect(row).toBeDefined();
      expect(row.filename).toBe('old.mp4');
      // ...and the new columns must exist with their defaults applied.
      expect(row.kind).toBe('video');               // backfilled default
      expect(row.thumbnail_filename).toBeNull();     // new nullable column

      // 4) The 'deleted' status (missing from the old CHECK) is now accepted.
      expect(() =>
         db.prepare("UPDATE uploads SET status = 'deleted' WHERE id = 'legacy-1'").run()
      ).not.toThrow();
   });

   test('widens ap_followers.followed_actor to include clipboard (§8 delta)', () => {
      const seed = new Database(dbFile);
      seed.prepare(`
         CREATE TABLE ap_followers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_id TEXT UNIQUE NOT NULL,
            inbox_url TEXT NOT NULL,
            followed_actor TEXT CHECK(followed_actor IN ('video','ghostyles','news')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
         )
      `).run();
      seed.prepare(`
         INSERT INTO ap_followers (actor_id, inbox_url, followed_actor)
         VALUES ('https://a/1', 'https://a/inbox', 'video')
      `).run();
      seed.close();

      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_DB_PATH = dbFile;
      let db;
      jest.isolateModules(() => { db = require('../src/db'); });

      // Legacy follower preserved.
      expect(db.prepare('SELECT COUNT(*) c FROM ap_followers').get().c).toBe(1);
      // The new 'clipboard' actor is now a valid follower target.
      expect(() =>
         db.prepare(`INSERT INTO ap_followers (actor_id, inbox_url, followed_actor)
                     VALUES ('https://a/2', 'https://a/inbox2', 'clipboard')`).run()
      ).not.toThrow();
   });
});

describe('db.js live CHECK constraints', () => {
   let db;
   beforeAll(() => {
      process.env.NODE_ENV = 'test';
      delete process.env.GSTMXX_DB_PATH;            // -> :memory:, current schema
      jest.resetModules();
      jest.isolateModules(() => { db = require('../src/db'); });
   });

   test('uploads.kind rejects values outside video|clipboard', () => {
      expect(() =>
         db.prepare(`INSERT INTO uploads (id, filename, kind, consent_version, delete_token)
                     VALUES ('k1','f.mp4','bogus','v','t')`).run()
      ).toThrow();
   });

   test('uploads.status rejects values outside the allowed set', () => {
      expect(() =>
         db.prepare(`INSERT INTO uploads (id, filename, status, consent_version, delete_token)
                     VALUES ('s1','f.mp4','weird','v','t')`).run()
      ).toThrow();
   });
});
