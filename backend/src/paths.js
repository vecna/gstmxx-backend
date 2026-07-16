const os = require('os');
const path = require('path');

/**
 * Absolute path to the backend directory.
 * @type {string}
 */
const ROOT_DIR = path.resolve(__dirname, '..');
const isTest = process.env.NODE_ENV === 'test';

/**
 * Directory for storing application data (e.g., sqlite database).
 * @type {string}
 */
const DATA_DIR = path.resolve(
   process.env.GSTMXX_DATA_DIR ||
   (isTest ? path.join(os.tmpdir(), 'ghostmaxxing-backend-test-data') : path.join(ROOT_DIR, 'data'))
);

/**
 * Main storage directory for uploaded files.
 * @type {string}
 */
const STORAGE_DIR = path.resolve(
   process.env.GSTMXX_STORAGE_DIR ||
   (isTest ? path.join(os.tmpdir(), 'ghostmaxxing-backend-test-storage') : path.join(ROOT_DIR, 'storage'))
);

/**
 * Directory where incoming video uploads are placed.
 * @type {string}
 */
const STORAGE_INCOMING_DIR = path.join(STORAGE_DIR, 'incoming');

/**
 * Directory where approved/published videos are stored.
 * @type {string}
 */
const STORAGE_APPROVED_DIR = path.join(STORAGE_DIR, 'approved');

/**
 * Directory where generated video thumbnails are stored.
 * @type {string}
 */
const STORAGE_THUMBNAILS_DIR = path.join(STORAGE_DIR, 'thumbnails');

/**
 * Path to the SQLite database file, or ':memory:' for tests.
 * @type {string}
 */
const DB_PATH = process.env.GSTMXX_DB_PATH || (isTest ? ':memory:' : path.join(DATA_DIR, 'ghostmaxxing.sqlite'));

module.exports = {
   ROOT_DIR,
   DATA_DIR,
   STORAGE_DIR,
   STORAGE_INCOMING_DIR,
   STORAGE_APPROVED_DIR,
   STORAGE_THUMBNAILS_DIR,
   DB_PATH
};
