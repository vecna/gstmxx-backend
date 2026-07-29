"use strict";

/**
 * @module paths
 *
 * Single source of truth for on-disk locations. Both the durable state under
 * `data/` and the media under `storage/` are resolved here so the server,
 * routes, services and tests all agree.
 *
 * Backup guidance (see the env tutorial): back up everything under `data/`
 * (posts, uploads ledger, keys, followers, kv) and `storage/approved` +
 * `storage/thumbnails`. Do NOT back up `storage/incoming` — it is ephemeral
 * pre-moderation media.
 */

const path = require("node:path");

/** Repository root (this file lives at the root). @type {string} */
const ROOT = __dirname;

/** Durable state directory (posts, uploads, keys, followers, kv). @type {string} */
const DATA_DIR = path.resolve(process.env.LAB_DATA_DIR || path.join(ROOT, "data"));

/** Published posts, one JSON file each. @type {string} */
const POST_DIR = path.join(DATA_DIR, "posts");

/** Moderation ledger, one JSON file per submission. @type {string} */
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

/** Media root. @type {string} */
const STORAGE_DIR = path.resolve(process.env.GSTMXX_STORAGE_DIR || path.join(ROOT, "storage"));

/** Raw pre-moderation media (ephemeral). @type {string} */
const STORAGE_INCOMING_DIR = path.join(STORAGE_DIR, "incoming");

/** Published, normalized media. @type {string} */
const STORAGE_APPROVED_DIR = path.join(STORAGE_DIR, "approved");

/** Generated poster-frame thumbnails. @type {string} */
const STORAGE_THUMBNAILS_DIR = path.join(STORAGE_DIR, "thumbnails");

/**
 * Directories that must exist before the server serves a request.
 * @type {ReadonlyArray<string>}
 */
const RUNTIME_DIRS = Object.freeze([
  DATA_DIR,
  POST_DIR,
  UPLOADS_DIR,
  STORAGE_INCOMING_DIR,
  STORAGE_APPROVED_DIR,
  STORAGE_THUMBNAILS_DIR
]);

module.exports = {
  ROOT,
  DATA_DIR,
  POST_DIR,
  UPLOADS_DIR,
  STORAGE_DIR,
  STORAGE_INCOMING_DIR,
  STORAGE_APPROVED_DIR,
  STORAGE_THUMBNAILS_DIR,
  RUNTIME_DIRS,
  /** Convenience bag of the three media dirs. */
  mediaDirs: Object.freeze({
    incoming: STORAGE_INCOMING_DIR,
    approved: STORAGE_APPROVED_DIR,
    thumbnails: STORAGE_THUMBNAILS_DIR
  })
};
