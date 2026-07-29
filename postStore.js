"use strict";

/**
 * @module postStore
 *
 * Flat-file store for published posts (ActivityPub `Note`s). One post is one
 * human-readable JSON file at `<postsDir>/<uuid>.json`. There is no database:
 * listing is a directory scan sorted newest-first, and every write is a
 * temp-file + atomic rename so a reader never sees a half-written file. A single
 * writer process is assumed.
 *
 * A stored post record looks like:
 * ```json
 * {
 *   "id": "…uuid…",
 *   "type": "Note",
 *   "actor": "ghostyles",
 *   "content": "…",
 *   "createdAt": "2026-07-29T12:00:00.000Z",
 *   "media": "pictures",          // optional: derived from the attachment
 *   "likes": 0,                    // running Like count (federation fills this)
 *   "attachment": { "type": "Image", "url": "…", "mediaType": "image/jpeg", "name": "…" },
 *   "quoteUrl": "…",               // optional
 *   "quoteAuthorizationUrl": "…"   // optional
 * }
 * ```
 *
 * The `media` and `likes` fields are what the digest engine
 * ({@link module:lib/digest}) reads to build filter-actor candidates. Records
 * written before these fields existed are handled gracefully: {@link mediaOf}
 * derives the media class on the fly and a missing `likes` counts as `0`.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { event } = require("./debugLog.js");

/**
 * Classify an ActivityPub `mediaType` into the coarse media class used by
 * feeds and filter actors.
 *
 * @param {?string} mediaType - e.g. `"image/jpeg"` or `"video/mp4"`.
 * @returns {?("pictures"|"videos")} The media class, or null if unknown.
 */
function classifyMedia(mediaType) {
  if (typeof mediaType !== "string") return null;
  if (mediaType.startsWith("image/")) return "pictures";
  if (mediaType.startsWith("video/")) return "videos";
  return null;
}

/**
 * The media class of a post, whether it was stored explicitly or must be
 * derived from the attachment. Returns null for a text-only post.
 *
 * @param {Object} post - A post record.
 * @returns {?("pictures"|"videos")}
 */
function mediaOf(post) {
  if (!post) return null;
  if (post.media === "pictures" || post.media === "videos") return post.media;
  return classifyMedia(post.attachment && post.attachment.mediaType);
}

/**
 * Ensure a directory exists (recursive, idempotent).
 *
 * @param {string} directory - Absolute path.
 * @returns {void}
 */
function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

/**
 * Resolve the on-disk path for a post id, rejecting anything that is not a
 * canonical UUID so a caller can never traverse out of the posts directory.
 *
 * @param {string} postsDirectory - Absolute path of the posts directory.
 * @param {string} postId - Candidate post id.
 * @returns {?string} The file path, or null if the id is malformed.
 */
function postPath(postsDirectory, postId) {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    event("store", "post.path.rejected", { postId });
    return null;
  }
  return path.join(postsDirectory, `${postId}.json`);
}

/**
 * Read one post by id.
 *
 * @param {string} postsDirectory - Absolute path of the posts directory.
 * @param {string} postId - Post id (validated as a UUID).
 * @param {string} [traceId] - Correlation id for the debug log.
 * @returns {?Object} The post record, or null if it is missing/malformed.
 */
function read(postsDirectory, postId, traceId) {
  const filePath = postPath(postsDirectory, postId);
  if (!filePath) return null;

  try {
    const post = JSON.parse(fs.readFileSync(filePath, "utf8"));
    event("store", "post.read", {
      trace: traceId,
      postId,
      actor: post.actor,
      file: filePath
    });
    return post;
  } catch (error) {
    if (error.code === "ENOENT") {
      event("store", "post.missing", { trace: traceId, postId });
      return null;
    }
    throw error;
  }
}

/**
 * List all posts, newest first (by `createdAt`).
 *
 * @param {string} postsDirectory - Absolute path of the posts directory.
 * @param {string} [traceId] - Correlation id for the debug log.
 * @returns {Object[]} The post records, sorted newest-first.
 */
function list(postsDirectory, traceId) {
  ensureDirectory(postsDirectory);
  const posts = fs
    .readdirSync(postsDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name)
    )
    .map((entry) =>
      read(postsDirectory, path.basename(entry.name, ".json"), traceId)
    )
    .filter(Boolean)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  event("store", "post.list", {
    trace: traceId,
    directory: postsDirectory,
    count: posts.length
  });
  return posts;
}

/**
 * List posts by a single actor, newest first. Used to build a per-actor RSS
 * feed and to gather candidates for that actor's filter actors.
 *
 * @param {string} postsDirectory
 * @param {string} actor - The actor handle to filter on.
 * @param {string} [traceId]
 * @returns {Object[]}
 */
function listByActor(postsDirectory, actor, traceId) {
  return list(postsDirectory, traceId).filter((post) => post.actor === actor);
}

/**
 * Create and persist a new post. Existing callers pass `content`, `actor` and
 * an options bag; the signature is unchanged. New optional fields:
 * `media` (explicit override) and `likes` (initial count). When `media` is not
 * given it is derived from the attachment's `mediaType`.
 *
 * @param {string} postsDirectory
 * @param {string} content - Non-empty post body.
 * @param {string} actor - Author actor handle.
 * @param {Object} [options]
 * @param {string}  [options.id] - Pre-chosen UUID (else generated).
 * @param {Object}  [options.attachment] - Normalized Image/Video attachment.
 * @param {string}  [options.quoteUrl]
 * @param {string}  [options.quoteAuthorizationUrl]
 * @param {("pictures"|"videos")} [options.media] - Explicit media class.
 * @param {number}  [options.likes=0] - Initial like count.
 * @param {string}  [options.title] - Optional headline (required for news).
 * @param {string}  [options.subtitle] - Optional deck/subtitle.
 * @param {string}  [options.traceId]
 * @returns {Object} The stored post record.
 * @throws {Error} If `content` is empty or not a string.
 */
function create(postsDirectory, content, actor, options = {}) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Content must be a non-empty string");
  }

  ensureDirectory(postsDirectory);
  const post = {
    id: options.id || crypto.randomUUID(),
    type: "Note",
    actor,
    content,
    createdAt: new Date().toISOString()
  };

  for (const key of ["attachment", "quoteUrl", "quoteAuthorizationUrl", "title", "subtitle"]) {
    if (options[key] != null) post[key] = options[key];
  }

  const media = options.media || classifyMedia(post.attachment && post.attachment.mediaType);
  if (media) post.media = media;
  post.likes = Number.isInteger(options.likes) ? options.likes : 0;

  writeRecord(postPath(postsDirectory, post.id), post, {
    traceId: options.traceId,
    actor,
    attachment: Boolean(post.attachment),
    quote: Boolean(post.quoteUrl)
  });
  return post;
}

/**
 * Apply a shallow patch to an existing post and persist it atomically. `id`,
 * `type` and `createdAt` are immutable and cannot be overwritten. Used for
 * like-count updates and quote back-links.
 *
 * @param {string} postsDirectory
 * @param {string} postId
 * @param {Object} patch - Fields to merge over the stored record.
 * @param {string} [traceId]
 * @returns {?Object} The updated record, or null if the post is missing.
 */
function update(postsDirectory, postId, patch, traceId) {
  const current = read(postsDirectory, postId, traceId);
  if (!current) return null;
  const next = { ...current, ...patch, id: current.id, type: current.type, createdAt: current.createdAt };
  writeRecord(postPath(postsDirectory, postId), next, { traceId, update: true });
  return next;
}

/**
 * Remove a post file. Used when a `Delete`/`Tombstone` retires a post.
 *
 * @param {string} postsDirectory
 * @param {string} postId
 * @param {string} [traceId]
 * @returns {boolean} True if a file was removed.
 */
function remove(postsDirectory, postId, traceId) {
  const filePath = postPath(postsDirectory, postId);
  if (!filePath || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  event("store", "post.removed", { trace: traceId, postId });
  return true;
}

/**
 * Internal: serialize a record to a temp file and atomically rename it into
 * place. Shared by {@link create} and {@link update}.
 *
 * @param {string} finalPath
 * @param {Object} record
 * @param {Object} [meta] - Extra fields for the debug event.
 * @returns {void}
 * @private
 */
function writeRecord(finalPath, record, meta = {}) {
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  event("store", "post.write.start", { trace: meta.traceId, postId: record.id, ...meta });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, finalPath);
  event("store", "post.write.done", { trace: meta.traceId, postId: record.id, file: finalPath });
}

module.exports = {
  classifyMedia,
  mediaOf,
  postPath,
  read,
  list,
  listByActor,
  create,
  update,
  remove
};
