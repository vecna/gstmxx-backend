"use strict";

/**
 * What this file tests
 * --------------------
 * The staff news composer: text+image publishes directly (no moderation) as a
 * post that is immediately a web page and an RSS item; auth is enforced; and
 * text-only works.
 *
 * How it tests it
 * ---------------
 * Boots the real app; posts multipart to the Basic-Auth'd composer. No ffmpeg
 * needed (images are copied straight to approved storage).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4067;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "compose-token";
process.env.GSTMXX_ADMIN_USER = "mod";
process.env.GSTMXX_ADMIN_PASS = "secret";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const auth = "Basic " + Buffer.from("mod:secret").toString("base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

test("composer requires auth", async () => {
  const form = new FormData();
  form.set("content", "hi");
  const res = await fetch(`${base}/api/admin/compose`, { method: "POST", body: form });
  assert.equal(res.status, 401);
});

test("compose news with text + image publishes to web and feed", async () => {
  const form = new FormData();
  form.set("actor", "news");
  form.set("title", "Workshop Saturday");
  form.set("subtitle", "Come paint your face");
  form.set("content", "Workshop this Saturday");
  form.set("altText", "poster");
  form.set("image", new Blob([PNG], { type: "image/png" }), "poster.png");
  const res = await fetch(`${base}/api/admin/compose`, {
    method: "POST", headers: { Authorization: auth }, body: form
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.actor, "news");
  const postId = body.post.id;

  const html = await (await fetch(`${base}/posts/${postId}`, { headers: { Accept: "text/html" } })).text();
  assert.match(html, /property="og:image" content="[^"]+\.png"/);
  assert.match(html, /Workshop Saturday/);

  const feed = await (await fetch(`${base}/feed/news.xml`)).text();
  assert.match(feed, new RegExp(`/posts/${postId}`));
});

test("compose requires a title", async () => {
  const form = new FormData();
  form.set("actor", "news");
  form.set("content", "no title here");
  const res = await fetch(`${base}/api/admin/compose`, {
    method: "POST", headers: { Authorization: auth }, body: form
  });
  assert.equal(res.status, 400);
});

test("compose text-only works; bad actor is rejected", async () => {
  const ok = new FormData();
  ok.set("actor", "news");
  ok.set("title", "Just text");
  ok.set("content", "just text");
  assert.equal((await fetch(`${base}/api/admin/compose`, {
    method: "POST", headers: { Authorization: auth }, body: ok
  })).status, 201);

  const bad = new FormData();
  bad.set("actor", "nonsense");
  bad.set("title", "x");
  bad.set("content", "x");
  assert.equal((await fetch(`${base}/api/admin/compose`, {
    method: "POST", headers: { Authorization: auth }, body: bad
  })).status, 400);
});
