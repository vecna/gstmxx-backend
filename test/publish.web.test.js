"use strict";

/**
 * What this file tests
 * --------------------
 * The "one record, four surfaces" claim end to end: approving an upload makes
 * the post (a) readable as an HTML Open Graph page, (b) readable as an
 * ActivityPub object, (c) present in the actor's RSS feed (well-formed XML),
 * and (d) federated (a Create is attempted — 0 followers here). Deleting it
 * retires it from the web page and the feed.
 *
 * How it tests it
 * ---------------
 * Boots the real app on an ephemeral port with a temp data/storage dir and
 * ffmpeg mocked. No followers exist, so federation is a successful no-op; we
 * assert the delivery result shape, not real delivery.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");

const PORT = 4061;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "web-token";
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

async function uploadAndApprove() {
  const form = new FormData();
  form.set("video", new Blob([Buffer.from([0, 1, 2, 3])], { type: "video/mp4" }), "clip.mp4");
  form.set("kind", "video");
  form.set("consent_version", "consent-v1");
  form.set("ghostyle_id", "brush");
  form.set("user_note", "a demo of the brush ghostyle");
  const up = await (await fetch(`${base}/api/uploads`, { method: "POST", body: form })).json();
  const approve = await (await fetch(`${base}/api/admin/approve/${up.uploadId}`, {
    method: "POST", headers: { Authorization: adminHeader }
  })).json();
  return { up, approve };
}

test("approve publishes to web + feed + federates; delete retires it", async () => {
  const { up, approve } = await uploadAndApprove();
  const postId = approve.post.id;

  // (d) Federation was attempted and reported (0 followers here).
  assert.ok(approve.federation && typeof approve.federation.followers === "number");
  assert.equal(approve.federation.followers, 0);

  // (a) HTML Open Graph page for a browser.
  const htmlRes = await fetch(`${base}/posts/${postId}`, { headers: { Accept: "text/html" } });
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-type") || "", /text\/html/);
  const html = await htmlRes.text();
  assert.match(html, /property="og:video" content="[^"]*\/videos\/[^"]+\.mp4"/);
  assert.match(html, /property="og:image" content="[^"]*\/thumbnails\/[^"]+\.png"/);

  // (b) ActivityPub object for the fediverse (same URL).
  const apRes = await fetch(`${base}/posts/${postId}`, { headers: { Accept: "application/activity+json" } });
  const obj = await apRes.json();
  assert.equal(obj.type, "Note");

  // (c) Present in the ghostyles feed, and the feed is well-formed XML.
  const feedXml = await (await fetch(`${base}/feed/ghostyles.xml`)).text();
  const feed = new XMLParser().parse(feedXml); // throws if malformed
  const items = [].concat(feed.rss.channel.item || []);
  assert.ok(items.some((i) => String(i.link).endsWith(`/posts/${postId}`)), "post should be in the feed");

  // all.xml also carries it.
  const allXml = await (await fetch(`${base}/feed/all.xml`)).text();
  assert.match(allXml, new RegExp(`/posts/${postId}`));

  // Delete retires it from every read surface.
  const del = await fetch(`${base}/api/uploads/${up.uploadId}`, {
    method: "DELETE", headers: { "X-Delete-Token": up.deleteToken }
  });
  assert.equal(del.status, 200);
  const delBody = await del.json();
  assert.ok("federation" in delBody);

  assert.equal((await fetch(`${base}/posts/${postId}`, { headers: { Accept: "text/html" } })).status, 404);
  const feedXml2 = await (await fetch(`${base}/feed/ghostyles.xml`)).text();
  assert.equal(feedXml2.includes(`/posts/${postId}`), false);
});

test("unknown feed is a 404", async () => {
  assert.equal((await fetch(`${base}/feed/nope.xml`)).status, 404);
});
