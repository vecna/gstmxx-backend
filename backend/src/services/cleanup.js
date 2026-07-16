const db = require('../db');
const { removeUploadFiles } = require('./uploadFiles');

const ONE_HOUR_MS = 60 * 60 * 1000;
let cleanupTimer = null;

/**
 * Retrieves the number of days after which pending uploads are considered stale.
 * Falls back to 14 days if the GSTMXX_STALE_DAYS environment variable is not defined or invalid.
 * 
 * @returns {number} The stale threshold in days.
 */
function staleDays() {
   const parsed = Number.parseInt(process.env.GSTMXX_STALE_DAYS || '14', 10);
   return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
}

/**
 * Scans the database for pending uploads that have exceeded the stale period,
 * marks their database status as 'deleted', and deletes their physical video files.
 * 
 * @param {Date} [now=new Date()] - Reference timestamp to calculate the cutoff date.
 * @returns {{scanned: number, deleted: number}} Object containing count of scanned and deleted stale uploads.
 */
function cleanupStaleUploads(now = new Date()) {
   const cutoff = new Date(now.getTime() - staleDays() * 24 * 60 * 60 * 1000).toISOString();
   const staleRows = db.prepare(`
      SELECT id, filename, thumbnail_filename, status
      FROM uploads
      WHERE status = 'pending' AND datetime(created_at) < datetime(?)
   `).all(cutoff);

   const markDeleted = db.prepare(`
      UPDATE uploads
      SET status = 'deleted', moderated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'pending'
   `);

   let deleted = 0;
   db.transaction(() => {
      for (const row of staleRows) {
         const result = markDeleted.run(row.id);
         if (result.changes > 0) deleted += 1;
      }
   })();

   for (const row of staleRows) {
      removeUploadFiles(row);
   }

   return { scanned: staleRows.length, deleted };
}

/**
 * Starts a recurring background timer that executes the stale uploads cleanup routine
 * every hour.
 * 
 * @returns {NodeJS.Timeout} The timer instance.
 */
function startStaleUploadCleanup() {
   if (cleanupTimer) return cleanupTimer;

   cleanupTimer = setInterval(() => {
      try {
         const result = cleanupStaleUploads();
         if (result.deleted > 0) {
            console.log(`[Ghostmaxxing Backend] Cleaned ${result.deleted} stale pending upload(s).`);
         }
      } catch (err) {
         console.error('[Ghostmaxxing Backend] Stale upload cleanup failed:', err);
      }
   }, ONE_HOUR_MS);

   if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
   return cleanupTimer;
}

module.exports = {
   cleanupStaleUploads,
   startStaleUploadCleanup,
   staleDays
};
