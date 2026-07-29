"use strict";

/**
 * What this file tests
 * --------------------
 * Content sniffing: the PNG magic-byte check against real bytes, and the
 * ffprobe video check via its test-mode mock.
 *
 * How it tests it
 * ---------------
 * PNG is checked by writing real/again fake bytes to a temp file. The video
 * path is driven through `GSTMXX_MOCK_FFPROBE` so no ffmpeg binary is needed;
 * `fluent-ffmpeg` is lazy-required, so this file runs without it installed.
 *
 * What it does NOT cover
 * ----------------------
 * A real ffprobe run against a real video — that belongs to the online/Layer-2
 * suite on a box with ffmpeg.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
const validation = require("../services/videoValidation");

function tmpFile(bytes) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vv-")), "f");
  fs.writeFileSync(p, bytes);
  return p;
}

test("validateUploadedPng: true only for real PNG magic bytes", () => {
  const png = tmpFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
  const notPng = tmpFile(Buffer.from("just some text"));
  assert.equal(validation.validateUploadedPng(png), true);
  assert.equal(validation.validateUploadedPng(notPng), false);
  assert.equal(validation.validateUploadedPng("/no/such/file"), false);
});

test("validateUploadedVideo: honours the ffprobe mock", async () => {
  process.env.GSTMXX_MOCK_FFPROBE = "video";
  assert.equal(await validation.validateUploadedVideo("/whatever"), true);
  process.env.GSTMXX_MOCK_FFPROBE = "other";
  assert.equal(await validation.validateUploadedVideo("/whatever"), false);
  delete process.env.GSTMXX_MOCK_FFPROBE;
});
