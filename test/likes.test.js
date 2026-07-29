"use strict";

/**
 * What this file tests
 * --------------------
 * The pure like helpers: extracting a local post id from a `Like`'s object URL
 * (rejecting foreign origins and non-post paths), and the de-duplicated
 * add/remove-liker bookkeeping that backs the `-top-rated` filter.
 *
 * What it does NOT cover
 * ----------------------
 * Signed inbox delivery of `Like`/`Undo(Like)` — that is the server's inbox
 * listener, exercised at the federation layer.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { postIdFromUrl, applyLike, applyUnlike } = require("../services/likes");

const BASE = "https://ghostmaxxing.vecna.eu";
const UUID = "11111111-1111-1111-1111-111111111111";

test("postIdFromUrl: only local /posts/{uuid} URLs", () => {
  assert.equal(postIdFromUrl(`${BASE}/posts/${UUID}`, BASE), UUID);
  assert.equal(postIdFromUrl(`https://evil.example/posts/${UUID}`, BASE), null);
  assert.equal(postIdFromUrl(`${BASE}/actors/ghostyles`, BASE), null);
  assert.equal(postIdFromUrl("not a url", BASE), null);
  assert.equal(postIdFromUrl(null, BASE), null);
});

test("applyLike: idempotent per liker, count follows the set", () => {
  let patch = applyLike({ }, "https://a/1");
  assert.deepEqual(patch, { likers: ["https://a/1"], likes: 1 });
  patch = applyLike({ likers: ["https://a/1"] }, "https://a/1"); // same liker again
  assert.equal(patch.likes, 1);
  patch = applyLike({ likers: ["https://a/1"] }, "https://a/2"); // new liker
  assert.equal(patch.likes, 2);
});

test("applyUnlike: removes a liker, idempotent", () => {
  const patch = applyUnlike({ likers: ["https://a/1", "https://a/2"] }, "https://a/1");
  assert.deepEqual(patch, { likers: ["https://a/2"], likes: 1 });
  const noop = applyUnlike({ likers: ["https://a/2"] }, "https://a/9");
  assert.deepEqual(noop, { likers: ["https://a/2"], likes: 1 });
});
