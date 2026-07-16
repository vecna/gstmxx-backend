/**
 * UNIT TEST — src/paths.js (path/config resolution).
 *
 * WHAT WE TEST
 *   - In NODE_ENV=test with no overrides, DATA_DIR/STORAGE_DIR fall back to OS
 *     tmp dirs and DB_PATH becomes ':memory:' (so CI never writes real files).
 *   - The GSTMXX_* env overrides win when provided.
 *
 * WHY IT MATTERS
 *   Every other module derives its filesystem + DB location from here; getting
 *   this wrong means tests silently share state or clobber a real database.
 *   jest.resetModules() in beforeEach forces paths.js to re-evaluate its
 *   module-load-time constants against the freshly-set env each test.
 */
const os = require('os');
const path = require('path');

describe('paths configuration', () => {
   let originalEnv;

   beforeEach(() => {
      originalEnv = { ...process.env };
      jest.resetModules();
   });

   afterEach(() => {
      process.env = originalEnv;
   });

   test('should configure paths for test environment by default when process.env.NODE_ENV is test', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.GSTMXX_DATA_DIR;
      delete process.env.GSTMXX_STORAGE_DIR;
      delete process.env.GSTMXX_DB_PATH;

      const { DATA_DIR, STORAGE_DIR, DB_PATH } = require('../src/paths');

      expect(DATA_DIR).toBe(path.resolve(path.join(os.tmpdir(), 'ghostmaxxing-backend-test-data')));
      expect(STORAGE_DIR).toBe(path.resolve(path.join(os.tmpdir(), 'ghostmaxxing-backend-test-storage')));
      expect(DB_PATH).toBe(':memory:');
   });

   test('should use custom environment variables if provided', () => {
      process.env.NODE_ENV = 'test';
      process.env.GSTMXX_DATA_DIR = '/custom/data';
      process.env.GSTMXX_STORAGE_DIR = '/custom/storage';
      process.env.GSTMXX_DB_PATH = '/custom/db.sqlite';

      const { DATA_DIR, STORAGE_DIR, DB_PATH } = require('../src/paths');

      expect(DATA_DIR).toBe('/custom/data');
      expect(STORAGE_DIR).toBe('/custom/storage');
      expect(DB_PATH).toBe('/custom/db.sqlite');
   });
});
