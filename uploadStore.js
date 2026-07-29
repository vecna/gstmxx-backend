"use strict";

/**
 * @module uploadStore
 *
 * Flat-file moderation queue. This replaces the SQLite `uploads` table from the
 * retired backend with one JSON file per submission and an explicit `status`
 * field for the lifecycle. It is a **pure data layer**: it records and
 * transitions moderation state and resolves file paths, but it does not run
 * ffmpeg, move media, speak HTTP, or federate. Those live in the route/service
 * layer (next iteration) and call into here.
 *
 * ## Where things live
 * - **Ledger record:** `<uploadsDir>/<id>.json` — durable, backed up. Holds the
 *   consent version, delete token, moderation status and the link to the
 *   published post once approved.
 * - **Raw media (pending):** `<incomingDir>/<filename>` — ephemeral, *not*
 *   backed up. Deleted on approve/reject.
 * - **Published media / thumbnail:** `<approvedDir>/`, `<thumbnailsDir>/`.
 *
 * (This splits the ledger from the ephemeral media, refining the v1 note that
 * put the record in `storage/incoming/`: keeping the ledger under `data/` makes
 * the "don't back up `incoming/`" rule clean.)
 *
 * ## Lifecycle
 * ```
 * pending ──approve──▶ approved ──delete(token)──▶ deleted
 *    │                    ▲
 *    ├──reject──▶ rejected │
 *    └──findStale/markDeleted──▶ deleted
 * ```
 *
 * A record:
 * ```json
 * {
 *   "id": "…uuid…",
 *   "kind": "video",                 // "video" | "clipboard"
 *   "status": "pending",             // pending|approved|rejected|deleted
 *   "filename": "a1b2….mp4",         // media file (incoming, then approved)
 *   "thumbnailFilename": null,
 *   "consentVersion": "consent-v1",
 *   "ghostyleId": null,
 *   "appVersion": null,
 *   "userNote": null,
 *   "metrics": null,
 *   "deleteToken": "…hex…",          // opaque; owner-side self-service delete
 *   "postId": null,                  // set on approve → the published post
 *   "createdAt": "…ISO…",
 *   "moderatedAt": null
 * }
 * ```
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { event } = require("./debugLog.js");

/**
 * Allowed submission kinds.
 * @type {ReadonlyArray<string>}
 */
const KINDS = Object.freeze(["video", "clipboard"]);

/**
 * Allowed moderation statuses.
 * @type {ReadonlyArray<string>}
 */
const STATUSES = Object.freeze(["pending", "approved", "rejected", "deleted"]);

/**
 * Default number of days after which a still-pending upload is considered
 * stale and swept.
 * @type {number}
 */
const DEFAULT_STALE_DAYS = 14;

/**
 * Ensure a directory exists (recursive, idempotent).
 * @param {string} directory
 * @returns {void}
 */
function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

/**
 * Resolve the ledger path for an upload id, rejecting non-UUID ids so a caller
 * cannot traverse out of the uploads directory.
 *
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @returns {?string} File path, or null if the id is malformed.
 */
function uploadPath(uploadsDirectory, uploadId) {
  if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
    event("store", "upload.path.rejected", { uploadId });
    return null;
  }
  return path.join(uploadsDirectory, `${uploadId}.json`);
}

/**
 * Serialize a record atomically (temp file + rename).
 * @param {string} finalPath
 * @param {Object} record
 * @param {string} [traceId]
 * @returns {void}
 * @private
 */
function writeRecord(finalPath, record, traceId) {
  ensureDirectory(path.dirname(finalPath));
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, finalPath);
  event("store", "upload.write", { trace: traceId, uploadId: record.id, status: record.status });
}

/**
 * Read one upload record by id.
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @param {string} [traceId]
 * @returns {?Object} The record, or null if missing/malformed.
 */
function read(uploadsDirectory, uploadId, traceId) {
  const filePath = uploadPath(uploadsDirectory, uploadId);
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      event("store", "upload.missing", { trace: traceId, uploadId });
      return null;
    }
    throw error;
  }
}

/**
 * List every upload record, unsorted.
 * @param {string} uploadsDirectory
 * @param {string} [traceId]
 * @returns {Object[]}
 */
function listAll(uploadsDirectory, traceId) {
  ensureDirectory(uploadsDirectory);
  return fs
    .readdirSync(uploadsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name))
    .map((entry) => read(uploadsDirectory, path.basename(entry.name, ".json"), traceId))
    .filter(Boolean);
}

/**
 * List records in a given status. `pending` is returned **oldest-first** (a
 * moderation queue: first in, first reviewed); other statuses newest-first.
 *
 * @param {string} uploadsDirectory
 * @param {string} status - One of {@link STATUSES}.
 * @param {Object} [options]
 * @param {("video"|"clipboard")} [options.kind] - Optional kind filter.
 * @param {string} [traceId]
 * @returns {Object[]}
 */
function listByStatus(uploadsDirectory, status, options = {}, traceId) {
  const rows = listAll(uploadsDirectory, traceId).filter((r) => {
    if (r.status !== status) return false;
    if (options.kind && r.kind !== options.kind) return false;
    return true;
  });
  const ascending = status === "pending";
  rows.sort((a, b) =>
    ascending
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt)
  );
  return rows;
}

/**
 * Convenience wrapper for the moderation UI: pending uploads, oldest first.
 * @param {string} uploadsDirectory
 * @param {Object} [options]
 * @param {("video"|"clipboard")} [options.kind]
 * @param {string} [traceId]
 * @returns {Object[]}
 */
function listPending(uploadsDirectory, options = {}, traceId) {
  return listByStatus(uploadsDirectory, "pending", options, traceId);
}

/**
 * Create a new pending upload record. The media file is written to
 * `incoming/` by the caller (multer); this only records the ledger entry.
 *
 * @param {string} uploadsDirectory
 * @param {Object} fields
 * @param {("video"|"clipboard")} fields.kind
 * @param {string} fields.filename - Media filename in `incoming/`.
 * @param {string} fields.consentVersion - Required; storage is gated on consent.
 * @param {string} [fields.id] - Pre-chosen UUID (else generated).
 * @param {string} [fields.deleteToken] - Opaque token (else generated).
 * @param {?string} [fields.ghostyleId]
 * @param {?string} [fields.appVersion]
 * @param {?string} [fields.userNote]
 * @param {?string} [fields.metrics]
 * @param {(string|number|Date)} [fields.now] - Injectable clock for tests.
 * @param {string} [traceId]
 * @returns {Object} The created record.
 * @throws {Error} If `kind` is invalid or `consentVersion` is missing.
 */
function create(uploadsDirectory, fields, traceId) {
  if (!KINDS.includes(fields.kind)) {
    throw new Error(`kind must be one of: ${KINDS.join(", ")}`);
  }
  if (!fields.consentVersion) {
    throw new Error("consentVersion is required");
  }
  const createdAt = toIso(fields.now) || new Date().toISOString();
  const record = {
    id: fields.id || crypto.randomUUID(),
    kind: fields.kind,
    status: "pending",
    filename: fields.filename,
    thumbnailFilename: null,
    consentVersion: fields.consentVersion,
    ghostyleId: fields.ghostyleId || null,
    appVersion: fields.appVersion || null,
    userNote: fields.userNote || null,
    metrics: fields.metrics || null,
    deleteToken: fields.deleteToken || crypto.randomBytes(32).toString("hex"),
    postId: null,
    createdAt,
    moderatedAt: null
  };
  writeRecord(uploadPath(uploadsDirectory, record.id), record, traceId);
  return record;
}

/**
 * Transition a pending upload to `approved`, recording the published media
 * filename, thumbnail and the id of the post it became. The actual ffmpeg run
 * and file move happen in the caller; this persists the state change.
 *
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @param {Object} result
 * @param {string} result.filename - Approved media filename.
 * @param {?string} [result.thumbnailFilename]
 * @param {?string} [result.postId]
 * @param {(string|number|Date)} [result.now]
 * @param {string} [traceId]
 * @returns {?Object} The updated record, or null if it was not pending.
 */
function approve(uploadsDirectory, uploadId, result, traceId) {
  return transition(uploadsDirectory, uploadId, "pending", "approved", (record) => {
    record.filename = result.filename;
    record.thumbnailFilename = result.thumbnailFilename || null;
    record.postId = result.postId || null;
    record.moderatedAt = toIso(result.now) || new Date().toISOString();
  }, traceId);
}

/**
 * Transition a pending upload to `rejected`.
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @param {Object} [options]
 * @param {(string|number|Date)} [options.now]
 * @param {string} [traceId]
 * @returns {?Object} The updated record, or null if it was not pending.
 */
function reject(uploadsDirectory, uploadId, options = {}, traceId) {
  return transition(uploadsDirectory, uploadId, "pending", "rejected", (record) => {
    record.moderatedAt = toIso(options.now) || new Date().toISOString();
  }, traceId);
}

/**
 * Mark an upload `deleted` (owner self-service delete or stale sweep). Allowed
 * from either `pending` or `approved`.
 *
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @param {Object} [options]
 * @param {(string|number|Date)} [options.now]
 * @param {string} [traceId]
 * @returns {?Object} The updated record, or null if it was already gone.
 */
function markDeleted(uploadsDirectory, uploadId, options = {}, traceId) {
  const record = read(uploadsDirectory, uploadId, traceId);
  if (!record || (record.status !== "pending" && record.status !== "approved")) {
    return null;
  }
  record.status = "deleted";
  record.moderatedAt = toIso(options.now) || new Date().toISOString();
  writeRecord(uploadPath(uploadsDirectory, uploadId), record, traceId);
  return record;
}

/**
 * Find still-pending uploads older than the stale cutoff. Returns the records
 * for the caller to remove media for and then {@link markDeleted}. Pure scan —
 * it does not mutate anything.
 *
 * @param {string} uploadsDirectory
 * @param {Object} [options]
 * @param {number} [options.staleDays=DEFAULT_STALE_DAYS]
 * @param {(string|number|Date)} [options.now] - Reference "now".
 * @param {string} [traceId]
 * @returns {Object[]} The stale pending records.
 */
function findStale(uploadsDirectory, options = {}, traceId) {
  const staleDays = Number.isFinite(options.staleDays) && options.staleDays > 0
    ? options.staleDays
    : DEFAULT_STALE_DAYS;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const cutoff = nowMs - staleDays * 24 * 60 * 60 * 1000;
  return listByStatus(uploadsDirectory, "pending", {}, traceId).filter((r) => {
    const at = Date.parse(r.createdAt);
    return Number.isFinite(at) && at < cutoff;
  });
}

/**
 * Constant-time comparison of a provided delete token against a record's token.
 *
 * @param {Object} record - The upload record.
 * @param {string} provided - The token supplied by the caller.
 * @returns {boolean}
 */
function verifyDeleteToken(record, provided) {
  if (!record || !record.deleteToken || !provided) return false;
  const expected = crypto.createHash("sha256").update(String(record.deleteToken)).digest();
  const got = crypto.createHash("sha256").update(String(provided)).digest();
  return crypto.timingSafeEqual(expected, got);
}

/**
 * Internal: read a record, require a `from` status, apply a mutator, set the
 * new status, and persist atomically.
 *
 * @param {string} uploadsDirectory
 * @param {string} uploadId
 * @param {string} from - Required current status.
 * @param {string} to - New status.
 * @param {(record: Object) => void} mutate - In-place field updates.
 * @param {string} [traceId]
 * @returns {?Object} The updated record, or null if the precondition failed.
 * @private
 */
function transition(uploadsDirectory, uploadId, from, to, mutate, traceId) {
  const record = read(uploadsDirectory, uploadId, traceId);
  if (!record || record.status !== from) return null;
  record.status = to;
  mutate(record);
  writeRecord(uploadPath(uploadsDirectory, uploadId), record, traceId);
  return record;
}

/**
 * Coerce an injectable clock value to an ISO string, or null if not provided.
 * @param {(string|number|Date)} [value]
 * @returns {?string}
 * @private
 */
function toIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  KINDS,
  STATUSES,
  DEFAULT_STALE_DAYS,
  uploadPath,
  read,
  listAll,
  listByStatus,
  listPending,
  create,
  approve,
  reject,
  markDeleted,
  findStale,
  verifyDeleteToken
};
