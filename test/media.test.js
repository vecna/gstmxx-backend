"use strict";

/**
 * What this file tests
 * --------------------
 * The pure media helpers: approved-media/thumbnail naming, public path/URL
 * construction (mirroring the nginx aliases), the AP media type per kind, and
 * the record→file-path resolution used for removal.
 *
 * How it tests it
 * ---------------
 * No filesystem and no ffmpeg — these are string/URL functions. `removeIfExists`
 * / `removeUploadFiles` touch the disk and are exercised via a temp dir.
 *
 * What it does NOT cover
 * ----------------------
 * The ffmpeg transcode/thumbnail itself (that is `services/video`, needs the
 * binaries) and multer receipt.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const media = require("../services/media");

test("outputNamesForApproval: named after the upload id", () => {
  assert.deepEqual(media.outputNamesForApproval("raw.mp4", "abc", "video"),
    { mediaName: "abc.mp4", thumbnailName: "thumb-abc.png" });
  assert.deepEqual(media.outputNamesForApproval("raw.png", "abc", "clipboard"),
    { mediaName: "abc.png", thumbnailName: null });
});

test("outputNamesForApproval: falls back to the input base with no id", () => {
  assert.deepEqual(media.outputNamesForApproval("deadbeef.mp4", null, "video"),
    { mediaName: "pub-deadbeef.mp4", thumbnailName: "thumb-deadbeef.png" });
});

test("public URLs mirror the nginx aliases", () => {
  const base = "https://ghostmaxxing.vecna.eu";
  assert.equal(media.publicUrlForApproved(base, "video", "x.mp4"), "https://ghostmaxxing.vecna.eu/videos/x.mp4");
  assert.equal(media.publicUrlForApproved(base, "clipboard", "y.png"), "https://ghostmaxxing.vecna.eu/clipboard/y.png");
  assert.equal(media.thumbnailUrl(base, "thumb-x.png"), "https://ghostmaxxing.vecna.eu/thumbnails/thumb-x.png");
});

test("mediaTypeForKind", () => {
  assert.equal(media.mediaTypeForKind("video"), "video/mp4");
  assert.equal(media.mediaTypeForKind("clipboard"), "image/png");
});

test("uploadFilePaths: approved video includes the thumbnail; pending is the raw file", () => {
  const dirs = { incoming: "/i", approved: "/a", thumbnails: "/t" };
  const approved = media.uploadFilePaths(
    { status: "approved", kind: "video", filename: "id.mp4", thumbnailFilename: "thumb-id.png" }, dirs);
  assert.deepEqual(approved, ["/a/id.mp4", "/t/thumb-id.png"]);
  const pending = media.uploadFilePaths({ status: "pending", filename: "raw.mp4" }, dirs);
  assert.deepEqual(pending, ["/i/raw.mp4"]);
});

test("removeUploadFiles: removes what exists, reports it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
  const dirs = { incoming: dir, approved: dir, thumbnails: dir };
  fs.writeFileSync(path.join(dir, "raw.mp4"), "x");
  const removed = media.removeUploadFiles({ status: "pending", filename: "raw.mp4" }, dirs);
  assert.equal(removed.length, 1);
  assert.equal(fs.existsSync(path.join(dir, "raw.mp4")), false);
  // Removing again removes nothing.
  assert.equal(media.removeUploadFiles({ status: "pending", filename: "raw.mp4" }, dirs).length, 0);
});
