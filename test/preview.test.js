"use strict";

/**
 * What this file tests
 * --------------------
 * The HTML/Open Graph preview renderer: the right og:image source for pictures
 * vs videos (attachment vs poster thumbnail), the video-specific og:video tags,
 * and that post content is HTML-escaped (no injection through the note body).
 *
 * What it does NOT cover
 * ----------------------
 * Content negotiation on the route (that is the publish integration test).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const preview = require("../services/preview");

const BASE = "https://ghostmaxxing.vecna.eu";

test("picture post: og:image is the attachment, summary_large_image", () => {
  const post = {
    id: "11111111-1111-1111-1111-111111111111",
    actor: "ghostyles",
    content: "a look",
    createdAt: "2026-07-29T12:00:00.000Z",
    media: "pictures",
    attachment: { type: "Image", url: `${BASE}/clipboard/x.png`, mediaType: "image/png", name: "alt" }
  };
  const html = preview.renderPostPage(post, { baseUrl: BASE });
  assert.match(html, /property="og:image" content="https:\/\/ghostmaxxing\.vecna\.eu\/clipboard\/x\.png"/);
  assert.match(html, /twitter:card" content="summary_large_image"/);
  assert.match(html, /<img /);
});

test("video post: og:image is the poster thumbnail, plus og:video", () => {
  const post = {
    id: "22222222-2222-2222-2222-222222222222",
    actor: "ghostyles",
    content: "a clip",
    createdAt: "2026-07-29T12:00:00.000Z",
    media: "videos",
    attachment: {
      type: "Video",
      url: `${BASE}/videos/y.mp4`,
      mediaType: "video/mp4",
      name: "clip",
      thumbnailUrl: `${BASE}/thumbnails/thumb-y.png`
    }
  };
  const html = preview.renderPostPage(post, { baseUrl: BASE });
  assert.match(html, /og:image" content="https:\/\/ghostmaxxing\.vecna\.eu\/thumbnails\/thumb-y\.png"/);
  assert.match(html, /og:video" content="https:\/\/ghostmaxxing\.vecna\.eu\/videos\/y\.mp4"/);
  assert.match(html, /<video /);
  assert.match(html, /poster="https:\/\/ghostmaxxing\.vecna\.eu\/thumbnails\/thumb-y\.png"/);
});

test("content is HTML-escaped (no injection via the note body)", () => {
  const post = {
    id: "33333333-3333-3333-3333-333333333333",
    actor: "news",
    content: "<script>alert(1)</script> & <b>",
    createdAt: "2026-07-29T12:00:00.000Z"
  };
  const html = preview.renderPostPage(post, { baseUrl: BASE });
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script must not appear");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("ogImageFor: null when there is no attachment", () => {
  assert.equal(preview.ogImageFor({ actor: "news", content: "x" }), null);
});
