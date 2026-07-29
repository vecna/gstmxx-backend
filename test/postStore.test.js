"use strict";

/**
 * What this file tests
 * --------------------
 * The flat-file post store: media classification, the likes default, atomic
 * create/read, newest-first listing, per-actor listing, shallow update with
 * immutable id/createdAt, removal, and the UUID path guard.
 *
 * How it tests it
 * ---------------
 * Each test uses a throwaway temp directory. Where ordering matters, records
 * are written with fixed `createdAt` values (via a direct helper) so the sort
 * is asserted without relying on wall-clock timing.
 *
 * What it does NOT cover
 * ----------------------
 * ActivityPub serialization of a post (that is the server's `activityPubPost`)
 * and like ingestion from the inbox — only the storage contract lives here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const postStore = require("../postStore.js");

/** Fresh temp posts dir per test. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "poststore-"));
}

/** Write a raw record with a controlled createdAt (bypasses create's clock). */
function seed(dir, id, actor, createdAt, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const rec = { id, type: "Note", actor, content: "x", createdAt, likes: 0, ...extra };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  return rec;
}

test("classifyMedia maps mime types", () => {
  assert.equal(postStore.classifyMedia("image/png"), "pictures");
  assert.equal(postStore.classifyMedia("video/mp4"), "videos");
  assert.equal(postStore.classifyMedia("text/plain"), null);
  assert.equal(postStore.classifyMedia(undefined), null);
});

test("create: text post has no media and likes default to 0", () => {
  const dir = tmpDir();
  const post = postStore.create(dir, "hello", "news");
  assert.equal(post.media, undefined);
  assert.equal(post.likes, 0);
  assert.equal(postStore.read(dir, post.id).content, "hello");
});

test("create: media is derived from an image attachment", () => {
  const dir = tmpDir();
  const post = postStore.create(dir, "pic", "ghostyles", {
    attachment: { type: "Image", url: "https://x/y.jpg", mediaType: "image/jpeg", name: "alt" }
  });
  assert.equal(post.media, "pictures");
});

test("create: explicit media overrides derivation", () => {
  const dir = tmpDir();
  const post = postStore.create(dir, "clip", "ghostyles", { media: "videos" });
  assert.equal(post.media, "videos");
});

test("read: a malformed id is rejected as null (path guard)", () => {
  const dir = tmpDir();
  assert.equal(postStore.read(dir, "../etc/passwd"), null);
});

test("list: newest first regardless of filesystem order", () => {
  const dir = tmpDir();
  seed(dir, "11111111-1111-1111-1111-111111111111", "news", "2026-07-01T00:00:00.000Z");
  seed(dir, "22222222-2222-2222-2222-222222222222", "news", "2026-07-29T00:00:00.000Z");
  seed(dir, "33333333-3333-3333-3333-333333333333", "news", "2026-07-15T00:00:00.000Z");
  const order = postStore.list(dir).map((p) => p.createdAt);
  assert.deepEqual(order, [
    "2026-07-29T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  ]);
});

test("listByActor filters to one actor", () => {
  const dir = tmpDir();
  seed(dir, "11111111-1111-1111-1111-111111111111", "news", "2026-07-01T00:00:00.000Z");
  seed(dir, "22222222-2222-2222-2222-222222222222", "ghostyles", "2026-07-02T00:00:00.000Z");
  const ghostyles = postStore.listByActor(dir, "ghostyles");
  assert.equal(ghostyles.length, 1);
  assert.equal(ghostyles[0].actor, "ghostyles");
});

test("update: merges a patch but keeps id/createdAt immutable", () => {
  const dir = tmpDir();
  const post = postStore.create(dir, "hi", "news");
  const updated = postStore.update(dir, post.id, {
    likes: 5,
    id: "hacked",
    createdAt: "1970-01-01T00:00:00.000Z"
  });
  assert.equal(updated.likes, 5);
  assert.equal(updated.id, post.id);
  assert.equal(updated.createdAt, post.createdAt);
  assert.equal(postStore.update(dir, "44444444-4444-4444-4444-444444444444", { likes: 1 }), null);
});

test("remove: deletes an existing post, false otherwise", () => {
  const dir = tmpDir();
  const post = postStore.create(dir, "bye", "news");
  assert.equal(postStore.remove(dir, post.id), true);
  assert.equal(postStore.read(dir, post.id), null);
  assert.equal(postStore.remove(dir, post.id), false);
});

test("mediaOf: derives for legacy records that predate the media field", () => {
  const dir = tmpDir();
  const rec = seed(dir, "55555555-5555-5555-5555-555555555555", "ghostyles",
    "2026-07-01T00:00:00.000Z",
    { attachment: { type: "Image", url: "https://x/y.png", mediaType: "image/png", name: "a" } });
  delete rec.media; // simulate an old record with no media field
  assert.equal(postStore.mediaOf(rec), "pictures");
});
