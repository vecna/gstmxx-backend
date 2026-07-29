"use strict";

/**
 * @module services/video
 *
 * ffmpeg pipeline run when a moderator approves an upload. Two guarantees the
 * consent copy depends on live here:
 *
 *  1. **Privacy strip.** `-map_metadata -1` drops all container metadata
 *     (timestamps, device info, GPS) from the published video.
 *  2. **Poster frame.** A thumbnail is captured at 0.5s so the UI never shows a
 *     black opening frame.
 *
 * `fluent-ffmpeg` is required lazily (inside the functions) so the module can be
 * loaded — and the non-ffmpeg parts tested — without the package or the ffmpeg
 * binaries present. In tests, `NODE_ENV=test` + `GSTMXX_MOCK_VIDEO_PROCESSING=1`
 * short-circuits the transcode to a plain file copy.
 */

const fs = require("node:fs");
const path = require("node:path");
const { outputNamesForApproval } = require("./media");

/**
 * Normalize and privacy-strip an approved video, then extract a thumbnail.
 *
 * @param {string} inputFilename - Filename in `dirs.incoming`.
 * @param {?string} uploadId - Upload id (names the outputs).
 * @param {{incoming:string, approved:string, thumbnails:string}} dirs
 * @returns {Promise<{mediaName:string, thumbnailName:?string}>}
 */
function processApprovedVideo(inputFilename, uploadId, dirs) {
  return new Promise((resolve, reject) => {
    const inputPath = path.join(dirs.incoming, inputFilename);
    const { mediaName, thumbnailName } = outputNamesForApproval(inputFilename, uploadId, "video");
    const outputPath = path.join(dirs.approved, mediaName);

    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Source file not found: ${inputPath}`));
    }

    if (process.env.NODE_ENV === "test" && process.env.GSTMXX_MOCK_VIDEO_PROCESSING === "1") {
      // Mimic both real outputs: the transcoded video and a poster thumbnail,
      // so the approve → preview/OG path is exercised end to end in tests.
      fs.copyFileSync(inputPath, outputPath);
      if (thumbnailName) fs.writeFileSync(path.join(dirs.thumbnails, thumbnailName), "");
      return resolve({ mediaName, thumbnailName });
    }

    const ffmpeg = require("fluent-ffmpeg");
    ffmpeg(inputPath)
      .output(outputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .size("640x?")
      .outputOptions([
        "-crf 28", // aggressive but decent compression to save VPS storage
        "-map_metadata -1", // PRIVACY: strip metadata, timestamps, geolocation
        "-pix_fmt yuv420p" // broad mobile-browser playback compatibility
      ])
      .on("end", () => {
        ffmpeg(outputPath)
          .screenshots({
            timestamps: ["00:00:00.500"],
            filename: thumbnailName,
            folder: dirs.thumbnails,
            size: "320x?"
          })
          .on("end", () => resolve({ mediaName, thumbnailName }))
          .on("error", (thumbErr) => {
            // Do not fail publication just because the poster frame failed.
            console.error("[ffmpeg-thumb-error]:", thumbErr);
            resolve({ mediaName, thumbnailName: null });
          });
      })
      .on("error", (err) => {
        console.error("[ffmpeg-conversion-error]:", err);
        reject(err);
      })
      .run();
  });
}

/**
 * "Process" an approved clipboard image. There is nothing to transcode; the PNG
 * is copied verbatim into the approved directory.
 *
 * @param {string} inputFilename - Filename in `dirs.incoming`.
 * @param {?string} uploadId
 * @param {{incoming:string, approved:string, thumbnails:string}} dirs
 * @returns {Promise<{mediaName:string, thumbnailName:?string}>}
 */
function processApprovedClipboard(inputFilename, uploadId, dirs) {
  return new Promise((resolve, reject) => {
    const inputPath = path.join(dirs.incoming, inputFilename);
    const { mediaName } = outputNamesForApproval(inputFilename, uploadId, "clipboard");
    const outputPath = path.join(dirs.approved, mediaName);
    if (!fs.existsSync(inputPath)) {
      return reject(new Error(`Source file not found: ${inputPath}`));
    }
    fs.copyFile(inputPath, outputPath, (err) => {
      if (err) return reject(err);
      return resolve({ mediaName, thumbnailName: null });
    });
  });
}

module.exports = {
  processApprovedVideo,
  processApprovedClipboard
};
