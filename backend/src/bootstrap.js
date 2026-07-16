const fs = require('fs');
const path = require('path');
const {
   DATA_DIR,
   STORAGE_INCOMING_DIR,
   STORAGE_APPROVED_DIR,
   STORAGE_THUMBNAILS_DIR,
   DB_PATH
} = require('./paths');

/**
 * Ensures that all necessary directories (data, incoming, approved, thumbnails)
 * exist on the filesystem. It creates them recursively if they do not exist.
 * 
 * @returns {void}
 */
function ensureRuntimeDirectories() {
   const dirs = [
      DATA_DIR,
      STORAGE_INCOMING_DIR,
      STORAGE_APPROVED_DIR,
      STORAGE_THUMBNAILS_DIR
   ];

   dirs.forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

   if (DB_PATH !== ':memory:') {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
   }
}

/**
 * Installs global process-level guards for uncaught exceptions and unhandled rejections
 * to prevent the Node.js application from crashing unexpectedly in production.
 * 
 * @returns {void}
 */
function installProcessGuards() {
   if (process.__gstmxxProcessGuardsInstalled) return;
   process.__gstmxxProcessGuardsInstalled = true;

   process.on('uncaughtException', (err) => {
      console.error('[Ghostmaxxing Backend] uncaughtException:', err);
   });

   process.on('unhandledRejection', (reason) => {
      console.error('[Ghostmaxxing Backend] unhandledRejection:', reason);
   });
}

/**
 * Runs the application bootstrap sequence, ensuring directory structures are intact
 * and global safety handlers are installed.
 * 
 * @returns {void}
 */
function bootstrapRuntime() {
   ensureRuntimeDirectories();
   installProcessGuards();
}

module.exports = {
   bootstrapRuntime,
   ensureRuntimeDirectories,
   installProcessGuards
};
