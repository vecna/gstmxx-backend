"use strict";

/**
 * @module services/cleanup
 *
 * Background sweep that retires uploads left pending too long: their media is
 * removed and the ledger row is marked `deleted`. The scan itself lives in
 * {@link module:uploadStore} (`findStale`); this only schedules it and performs
 * the removals.
 */

const media = require("./media");

/** One hour in milliseconds. @type {number} */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Run one sweep now. Exposed for tests and for a manual/endpoint trigger.
 *
 * @param {Object} deps
 * @param {import("../uploadStore")} deps.uploadStore
 * @param {string} deps.uploadsDir
 * @param {{incoming:string, approved:string, thumbnails:string}} deps.dirs
 * @param {number} [deps.staleDays]
 * @param {(string|number|Date)} [deps.now]
 * @returns {{scanned:number, deleted:number}}
 */
function runSweep(deps) {
  const stale = deps.uploadStore.findStale(deps.uploadsDir, {
    staleDays: deps.staleDays,
    now: deps.now
  });
  let deleted = 0;
  for (const record of stale) {
    media.removeUploadFiles(record, deps.dirs);
    if (deps.uploadStore.markDeleted(deps.uploadsDir, record.id, { now: deps.now })) {
      deleted += 1;
    }
  }
  return { scanned: stale.length, deleted };
}

/**
 * Start a recurring hourly sweep. The timer is `unref`'d so it never keeps the
 * process alive on its own.
 *
 * @param {Object} deps - Same shape as {@link runSweep} (minus `now`), plus:
 * @param {number} [deps.intervalMs=ONE_HOUR_MS]
 * @returns {NodeJS.Timeout}
 */
function startStaleUploadCleanup(deps) {
  const interval = deps.intervalMs || ONE_HOUR_MS;
  const timer = setInterval(() => {
    try {
      const result = runSweep(deps);
      if (result.deleted > 0) {
        console.log(`[cleanup] removed ${result.deleted} stale pending upload(s).`);
      }
    } catch (error) {
      console.error("[cleanup] sweep failed:", error);
    }
  }, interval);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = { runSweep, startStaleUploadCleanup, ONE_HOUR_MS };
