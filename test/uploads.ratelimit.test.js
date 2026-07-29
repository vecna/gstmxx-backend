"use strict";

/**
 * What this file tests
 * --------------------
 * The public upload intake is rate-limited per IP: with the limit set to 2, the
 * third upload in the window is rejected with 429 before it is processed.
 *
 * How it tests it
 * ---------------
 * Boots the app with a tiny `GSTMXX_UPLOAD_RATE_MAX=2`. ffprobe is mocked so the
 * first two uploads are accepted; the limiter runs before multer, so the third
 * is blocked regardless of payload validity.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4069;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "rl-token";
process.env.GSTMXX_MOCK_FFPROBE = "video";
process.env.GSTMXX_UPLOAD_RATE_MAX = "2";
process.env.GSTMXX_UPLOAD_RATE_WINDOW_MS = "900000";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;

let server;
const { before, after } = test;
before(async () => {
  server = createApp().listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

async function upload() {
  const form = new FormData();
  form.set("video", new Blob([Buffer.from([0, 1, 2, 3])], { type: "video/mp4" }), "c.mp4");
  form.set("kind", "video");
  form.set("consent_version", "consent-v1");
  return fetch(`${base}/api/uploads`, { method: "POST", body: form });
}

test("third upload in the window is rate-limited (429)", async () => {
  assert.equal((await upload()).status, 201);
  assert.equal((await upload()).status, 201);
  const third = await upload();
  assert.equal(third.status, 429);
});
