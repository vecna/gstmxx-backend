"use strict";

/**
 * What this file tests
 * --------------------
 * The whole moderated-upload lifecycle over real HTTP against the real Express
 * app: intake → consent gate → pending queue → Basic-Auth moderation → approve
 * (which publishes a post with the right AP attachment) → owner delete.
 *
 * How it tests it
 * ---------------
 * Boots `createApp()` on an ephemeral port with a temp data/storage dir.
 * ffmpeg is mocked (`GSTMXX_MOCK_VIDEO_PROCESSING=1`, `GSTMXX_MOCK_FFPROBE`),
 * so no binaries are needed. ActivityPub is not driven here (no followers); we
 * assert the post is created and readable as an AP object, which is the part
 * this iteration is responsible for.
 *
 * What it does NOT cover
 * ----------------------
 * The federated `Create`/`Delete` push, the HTML/OG preview and the RSS feeds —
 * those are the next iteration.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4058;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "lifecycle-token";
process.env.GSTMXX_ADMIN_USER = "mod";
process.env.GSTMXX_ADMIN_PASS = "secret";
process.env.GSTMXX_MOCK_VIDEO_PROCESSING = "1";
process.env.GSTMXX_MOCK_FFPROBE = "video";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const adminHeader = "Basic " + Buffer.from("mod:secret").toString("base64");

let server;
const { before, after } = test;

before(async () => {
  server = createApp().listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

/** POST a fake video upload; returns the parsed JSON body. */
async function uploadVideo(note) {
  const form = new FormData();
  form.set("video", new Blob([Buffer.from([0, 1, 2, 3])], { type: "video/mp4" }), "clip.mp4");
  form.set("kind", "video");
  form.set("consent_version", "consent-v1");
  form.set("ghostyle_id", "brush");
  if (note) form.set("user_note", note);
  const res = await fetch(`${base}/api/uploads`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("intake requires consent", async () => {
  const form = new FormData();
  form.set("video", new Blob([Buffer.from([0, 1])], { type: "video/mp4" }), "c.mp4");
  form.set("kind", "video");
  const res = await fetch(`${base}/api/uploads`, { method: "POST", body: form });
  assert.equal(res.status, 400);
});

test("moderation is behind Basic Auth", async () => {
  const noAuth = await fetch(`${base}/api/admin/pending`);
  assert.equal(noAuth.status, 401);
  const withAuth = await fetch(`${base}/api/admin/pending`, { headers: { Authorization: adminHeader } });
  assert.equal(withAuth.status, 200);
});

test("full lifecycle: upload → pending → approve → readable post → delete", async () => {
  // 1. Upload.
  const up = await uploadVideo("a ghostyle demo");
  assert.equal(up.status, 201);
  assert.ok(up.body.uploadId);
  assert.ok(up.body.deleteToken);
  const { uploadId, deleteToken } = up.body;

  // 2. It appears in the pending queue.
  const pending = await (await fetch(`${base}/api/admin/pending`, { headers: { Authorization: adminHeader } })).json();
  assert.ok(pending.pending.some((p) => p.id === uploadId));

  // 3. Approve it (ffmpeg mocked). A ghostyle-tagged upload publishes as `ghostyles`.
  const approveRes = await fetch(`${base}/api/admin/approve/${uploadId}`, {
    method: "POST",
    headers: { Authorization: adminHeader }
  });
  assert.equal(approveRes.status, 200);
  const approved = await approveRes.json();
  assert.equal(approved.actor, "ghostyles");
  const postId = approved.post.id;

  // 4. The post is readable as an ActivityPub object with a Video attachment.
  const obj = await (await fetch(`${base}/posts/${postId}`, {
    headers: { Accept: "application/activity+json" }
  })).json();
  assert.equal(obj.type, "Note");
  const attachments = Array.isArray(obj.attachment) ? obj.attachment : [obj.attachment].filter(Boolean);
  assert.ok(attachments.some((a) => a.type === "Video"), "expected a Video attachment");

  // 5. The approved media is served.
  const mediaRes = await fetch(`${base}/videos/${uploadId}.mp4`);
  assert.equal(mediaRes.status, 200);

  // 6. It is gone from the pending queue.
  const pending2 = await (await fetch(`${base}/api/admin/pending`, { headers: { Authorization: adminHeader } })).json();
  assert.equal(pending2.pending.some((p) => p.id === uploadId), false);

  // 7. Owner deletes it with the token; the post disappears from the read surface.
  const wrong = await fetch(`${base}/api/uploads/${uploadId}`, { method: "DELETE", headers: { "X-Delete-Token": "nope" } });
  assert.equal(wrong.status, 403);
  const del = await fetch(`${base}/api/uploads/${uploadId}`, { method: "DELETE", headers: { "X-Delete-Token": deleteToken } });
  assert.equal(del.status, 200);
  const gone = await fetch(`${base}/posts/${postId}`);
  assert.equal(gone.status, 404);
});

test("reject drops a pending upload", async () => {
  const up = await uploadVideo("to be rejected");
  const res = await fetch(`${base}/api/admin/reject/${up.body.uploadId}`, {
    method: "POST",
    headers: { Authorization: adminHeader }
  });
  assert.equal(res.status, 200);
  const pending = await (await fetch(`${base}/api/admin/pending`, { headers: { Authorization: adminHeader } })).json();
  assert.equal(pending.pending.some((p) => p.id === up.body.uploadId), false);
});
