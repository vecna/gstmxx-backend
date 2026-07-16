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
