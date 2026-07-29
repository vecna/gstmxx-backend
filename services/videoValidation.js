"use strict";

/**
 * @module services/videoValidation
 *
 * Post-upload content sniffing, so a renamed non-media file is rejected before
 * it ever enters the moderation queue. `fluent-ffmpeg` is required lazily so
 * the PNG check (and the module load) work without ffmpeg installed. In tests,
 * `NODE_ENV=test` + `GSTMXX_MOCK_FFPROBE=video|other` bypasses ffprobe.
 */

const fs = require("node:fs");

/**
 * Confirm a file really contains a video stream by probing it with ffprobe.
 *
 * @param {string} filePath - Absolute path to the uploaded file.
 * @returns {Promise<boolean>} True if at least one video stream is present.
 */
function validateUploadedVideo(filePath) {
  if (process.env.NODE_ENV === "test" && process.env.GSTMXX_MOCK_FFPROBE) {
    return Promise.resolve(process.env.GSTMXX_MOCK_FFPROBE === "video");
  }
  const ffmpeg = require("fluent-ffmpeg");
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err || !metadata) return resolve(false);
      const hasVideoStream =
        Array.isArray(metadata.streams) &&
        metadata.streams.some((stream) => stream.codec_type === "video");
      resolve(Boolean(hasVideoStream));
    });
  });
}

/**
 * Confirm a file begins with the PNG magic bytes.
 *
 * @param {string} filePath - Absolute path to the uploaded file.
 * @returns {boolean}
 */
function validateUploadedPng(filePath) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  try {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(signature.length);
    fs.readSync(fd, header, 0, signature.length, 0);
    fs.closeSync(fd);
    return header.equals(signature);
  } catch {
    return false;
  }
}

module.exports = { validateUploadedVideo, validateUploadedPng };
