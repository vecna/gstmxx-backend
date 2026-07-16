process.env.NODE_ENV = 'test';
const db = require('../src/db');

describe('db initialization and migrations', () => {
   test('should have created the required tables', () => {
      const uploadsSql = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'uploads'").get();
      expect(uploadsSql).toBeDefined();
      expect(uploadsSql.name).toBe('uploads');

      const followersSql = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ap_followers'").get();
      expect(followersSql).toBeDefined();
      expect(followersSql.name).toBe('ap_followers');

      const keysSql = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'keys'").get();
      expect(keysSql).toBeDefined();
      expect(keysSql.name).toBe('keys');

      const newsSql = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'news'").get();
      expect(newsSql).toBeDefined();
      expect(newsSql.name).toBe('news');
   });

   test('should be able to insert and retrieve from uploads', () => {
      const id = 'test-id-123';
      db.prepare(`
         INSERT INTO uploads (id, filename, consent_version, delete_token)
         VALUES (?, ?, ?, ?)
      `).run(id, 'test.mp4', '1.0', 'token123');

      const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
      expect(row).toBeDefined();
      expect(row.filename).toBe('test.mp4');
      expect(row.status).toBe('pending');
      expect(row.kind).toBe('video');
   });
});
