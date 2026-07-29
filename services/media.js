"use strict";

/**
 * @module services/media
 *
 * Pure helpers for approved-media naming, public URLs, and file removal.
 * No ffmpeg here (see {@link module:services/video}); this is the bit that is
 * safe to unit-test without any binaries.
 *
 * Public URLs mirror the nginx aliases: approved video → `/videos/<file>`,
 * approved clipboard image → `/clipboard/<file>`, thumbnail →
 * `/thumbnails/<file>`. In development the Node server serves these paths from
 * the storage dirs; in production nginx aliases them (and caches them).
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * Derive the published media filename (and thumbnail name for videos) for an
 * approved upload. Naming the file after the upload id makes the public URL
 * resolvable directly from the id.
 *
 * @param {string} inputFilename - The incoming filename (fallback base).
 * @param {?string} uploadId - The upload id; when present the output is named after it.
 * @param {("video"|"clipboard")} kind
 * @returns {{mediaName: string, thumbnailName: ?string}}
 */
function outputNamesForApproval(inputFilename, uploadId, kind) {
  const isClip = kind === "clipboard";
  if (uploadId) {
    return {
      mediaName: `${uploadId}${isClip ? ".png" : ".mp4"}`,
      thumbnailName: isClip ? null : `thumb-${uploadId}.png`
    };
  }
  const base = path.parse(inputFilename).name;
  return {
    mediaName: `pub-${base}${isClip ? ".png" : ".mp4"}`,
    thumbnailName: isClip ? null : `thumb-${base}.png`
  };
}

/**
 * Public path (origin-relative) for an approved media file.
 * @param {("video"|"clipboard")} kind
 * @param {string} mediaName
 * @returns {string}
 */
function publicPathForApproved(kind, mediaName) {
  return `/${kind === "clipboard" ? "clipboard" : "videos"}/${mediaName}`;
}

/**
 * Absolute public URL for an approved media file.
 * @param {string} baseUrl - The public origin (`LAB_BASE_URL`).
 * @param {("video"|"clipboard")} kind
 * @param {string} mediaName
 * @returns {string}
 */
function publicUrlForApproved(baseUrl, kind, mediaName) {
  return new URL(publicPathForApproved(kind, mediaName), baseUrl).href;
}

/**
 * Absolute public URL for a thumbnail.
 * @param {string} baseUrl
 * @param {string} thumbnailName
 * @returns {string}
 */
function thumbnailUrl(baseUrl, thumbnailName) {
  return new URL(`/thumbnails/${thumbnailName}`, baseUrl).href;
}

/**
 * The ActivityPub attachment `mediaType` for an approved upload kind.
 * @param {("video"|"clipboard")} kind
 * @returns {string}
 */
function mediaTypeForKind(kind) {
  return kind === "clipboard" ? "image/png" : "video/mp4";
}

/**
 * Unlink a file if it exists.
 * @param {string} filePath
 * @returns {boolean} True if a file was removed.
 */
function removeIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Remove the raw incoming media for a filename.
 * @param {string} filename
 * @param {string} incomingDir
 * @returns {boolean}
 */
function removeIncoming(filename, incomingDir) {
  return removeIfExists(path.join(incomingDir, filename));
}

/**
 * Resolve the on-disk files associated with an upload record, depending on
 * whether it is still incoming or already approved.
 *
 * @param {Object} record - An upload record.
 * @param {{incoming:string, approved:string, thumbnails:string}} dirs
 * @returns {string[]} Absolute paths (existence not checked).
 */
function uploadFilePaths(record, dirs) {
  if (!record || !record.filename) return [];
  if (record.status === "approved") {
    const paths = [path.join(dirs.approved, record.filename)];
    if (record.thumbnailFilename) {
      paths.push(path.join(dirs.thumbnails, record.thumbnailFilename));
    }
    return paths;
  }
  return [path.join(dirs.incoming, record.filename)];
}

/**
 * Remove every file associated with an upload record.
 * @param {Object} record
 * @param {{incoming:string, approved:string, thumbnails:string}} dirs
 * @returns {string[]} The paths that were actually removed.
 */
function removeUploadFiles(record, dirs) {
  return uploadFilePaths(record, dirs).filter(removeIfExists);
}

module.exports = {
  outputNamesForApproval,
  publicPathForApproved,
  publicUrlForApproved,
  thumbnailUrl,
  mediaTypeForKind,
  removeIfExists,
  removeIncoming,
  uploadFilePaths,
  removeUploadFiles
};
