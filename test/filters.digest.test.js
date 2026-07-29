"use strict";

/**
 * What this file tests
 * --------------------
 * Filter actors as first-class ActivityPub actors: they resolve via WebFinger
 * and the actor dispatcher; approving a matching item fans out to the echo
 * filter; and a forced digest run publishes a FEP-044f quote (headed by the
 * algorithm summary) as the digest actor.
 *
 * How it tests it
 * ---------------
 * Boots the real app with two filters enabled. The digest is triggered
 * deterministically through the token-protected `POST /api/digests/run`
 * (`force:true`) rather than waiting on the interval. ffmpeg is mocked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4065;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "filter-token";
process.env.GSTMXX_ADMIN_USER = "mod";
process.env.GSTMXX_ADMIN_PASS = "secret";
process.env.GSTMXX_MOCK_VIDEO_PROCESSING = "1";
process.env.GSTMXX_MOCK_FFPROBE = "video";
process.env.GSTMXX_FILTERS = "ghostyles-daily,ghostyles-pictures";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const host = new URL(base).host;
const adminHeader = "Basic " + Buffer.from("mod:secret").toString("base64");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

async function approveClipboard(note) {
  const form = new FormData();
  form.set("video", new Blob([PNG], { type: "image/png" }), "look.png");
  form.set("kind", "clipboard");
  form.set("consent_version", "consent-v1");
  form.set("ghostyle_id", "brush");
  form.set("user_note", note);
  const up = await (await fetch(`${base}/api/uploads`, { method: "POST", body: form })).json();
  const approve = await (await fetch(`${base}/api/admin/approve/${up.uploadId}`, {
    method: "POST", headers: { Authorization: adminHeader }
  })).json();
  return approve;
}

test("filter actors resolve via the actor dispatcher and WebFinger", async () => {
  const actorRes = await fetch(`${base}/federation/actors/ghostyles-daily`, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(actorRes.status, 200);
  const actor = await actorRes.json();
  assert.equal(actor.preferredUsername, "ghostyles-daily");
  assert.match(actor.summary, /Digest filter/);

  const wf = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(`acct:ghostyles-daily@${host}`)}`);
  assert.equal(wf.status, 200);
});

test("approving a picture fans out to the ghostyles-pictures echo filter", async () => {
  const approve = await approveClipboard("first look");
  assert.equal(approve.actor, "ghostyles");
  assert.ok(Array.isArray(approve.echoes));
  assert.ok(approve.echoes.some((e) => e.handle === "ghostyles-pictures"),
    "expected an echo to ghostyles-pictures");
});

test("a forced digest publishes a summary-headed quote as ghostyles-daily", async () => {
  // Two more so there are three ghostyles pictures in the window.
  await approveClipboard("second look");
  await approveClipboard("third look");

  const run = await (await fetch(`${base}/api/digests/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer filter-token" },
    body: JSON.stringify({ force: true })
  })).json();

  assert.equal(run.ok, true);
  const daily = run.results.find((r) => r.handle === "ghostyles-daily");
  assert.ok(daily && daily.postId, "ghostyles-daily should have published a digest");
  assert.ok(daily.picked, "it should have picked one of the posts");
  assert.match(daily.summary, /^3 ghostyles received in last day, 3 pictures 0 videos, random daily selection:/);

  // The digest post is a real quote referencing the picked post.
  const obj = await (await fetch(`${base}/posts/${daily.postId}`, {
    headers: { Accept: "application/activity+json" }
  })).json();
  assert.equal(obj.type, "Note");
  assert.ok(String(obj.quote).endsWith(`/posts/${daily.picked}`), "quote should point at the pick");

  // And it shows up in the digest actor's own feed.
  const feed = await (await fetch(`${base}/feed/ghostyles-daily.xml`)).text();
  assert.match(feed, new RegExp(`/posts/${daily.postId}`));
});

test("digest run is token-protected", async () => {
  const res = await fetch(`${base}/api/digests/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: true })
  });
  assert.equal(res.status, 401);
});
