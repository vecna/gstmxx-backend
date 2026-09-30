"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { galleryItem, parseLimit, encodeCursor, decodeCursor, isOlderThan, DEFAULT_LIMIT, MAX_LIMIT } = require("../routes/gallery.js");

test("galleryItem exposes image fields and rejects non-images", () => {
  const item = galleryItem({
    id: "one",
    sourceUploadId: "upload-one",
    actor: "ghostyles",
    content: "Brush result",
    createdAt: "2026-09-30T12:00:00.000Z",
    likes: 3,
    url: "https://example.test/posts/one",
    attachment: { mediaType: "image/png", url: "https://example.test/one.png", name: "Painted face" }
  });
  assert.equal(item.imageUrl, "https://example.test/one.png");
  assert.equal(item.thumbnailUrl, item.imageUrl);
  assert.equal(item.alt, "Painted face");
  assert.equal(item.likes, 3);
  assert.equal(galleryItem({ attachment: { mediaType: "video/mp4" } }), null);
  assert.equal(galleryItem({ attachment: { mediaType: "image/png", url: "https://example.test/direct.png" } }), null);
  assert.equal(galleryItem({}), null);
});

test("gallery limits are bounded", () => {
  assert.equal(parseLimit(), DEFAULT_LIMIT);
  assert.equal(parseLimit("0"), DEFAULT_LIMIT);
  assert.equal(parseLimit("12"), 12);
  assert.equal(parseLimit("999"), MAX_LIMIT);
});

test("gallery cursor is opaque, round-trips, and orders ties by id", () => {
  const post = { createdAt: "2026-09-30T12:00:00.000Z", id: "bbb" };
  assert.deepEqual(decodeCursor(encodeCursor(post)), post);
  assert.equal(decodeCursor("not-a-cursor"), null);
  assert.equal(isOlderThan({ createdAt: post.createdAt, id: "aaa" }, post), true);
  assert.equal(isOlderThan({ createdAt: post.createdAt, id: "ccc" }, post), false);
});
