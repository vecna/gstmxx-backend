"use strict";

/**
 * @module digestStore
 *
 * Tiny JSON store for filter-actor digest state, one object per filter handle
 * in `data/digests.json`:
 *
 * ```json
 * { "ghostyles-daily": { "lastRunAt": "2026-07-29T00:00:00.000Z", "lastPickId": "…" } }
 * ```
 *
 * State is per *digest mechanism*, never per follower — a digest is computed
 * once per window and then delivered by the outbox. This is what keeps a cold
 * start after downtime cheap: the number of entries here equals the (small)
 * number of digest filters.
 */

const fs = require("node:fs");
const path = require("node:path");

/** @param {string} dataDir @returns {string} */
function filePath(dataDir) {
  return path.join(dataDir, "digests.json");
}

/**
 * Read the whole map (empty object if the file does not exist yet).
 * @param {string} dataDir
 * @returns {Object<string,{lastRunAt?:string,lastPickId?:?string}>}
 */
function readAll(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(filePath(dataDir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

/**
 * State for one filter handle, or null.
 * @param {string} dataDir
 * @param {string} handle
 * @returns {?{lastRunAt?:string,lastPickId?:?string}}
 */
function get(dataDir, handle) {
  return readAll(dataDir)[handle] || null;
}

/**
 * Merge and persist state for one filter handle (atomic write).
 * @param {string} dataDir
 * @param {string} handle
 * @param {{lastRunAt?:string,lastPickId?:?string}} state
 * @returns {Object} The merged state for the handle.
 */
function set(dataDir, handle, state) {
  const all = readAll(dataDir);
  all[handle] = { ...(all[handle] || {}), ...state };
  fs.mkdirSync(dataDir, { recursive: true });
  const finalPath = filePath(dataDir);
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, finalPath);
  return all[handle];
}

module.exports = { readAll, get, set };
