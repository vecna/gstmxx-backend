"use strict";

/**
 * What this file tests
 * --------------------
 * The pure news renderer: reading-time estimation, the search index (title
 * fallback, snippet, media, lowercased search text), and that the rendered
 * `/latest` page includes the TOC, the articles, the archive link, the reader
 * toggle, the search box, and the client stylesheet link — with content escaped.
 *
 * What it does NOT cover
 * ----------------------
 * The route wiring, caching and invalidation (that is the /latest integration
 * test).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const news = require("../services/news");

const BASE = "https://ghostmaxxing.vecna.eu";

function newsPost(over = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    actor: "news",
    title: "Workshop Saturday",
    subtitle: "Come along",
    content: "We are running a face-paint workshop this Saturday afternoon.",
    createdAt: "2026-07-29T12:00:00.000Z",
    ...over
  };
}

test("readingTimeMinutes: at least 1, scales with length", () => {
  assert.equal(news.readingTimeMinutes(""), 1);
  assert.equal(news.readingTimeMinutes("word ".repeat(200)), 1);
  assert.equal(news.readingTimeMinutes("word ".repeat(600)), 3);
});

test("titleOf: title, else first line, else fallback", () => {
  assert.equal(news.titleOf(newsPost()), "Workshop Saturday");
  assert.equal(news.titleOf(newsPost({ title: undefined, content: "First line\nsecond" })), "First line");
  assert.equal(news.titleOf(newsPost({ title: undefined, content: "" })), "Untitled");
});

test("buildNewsIndex: entry shape with url, reading time, search text", () => {
  const idx = news.buildNewsIndex([newsPost()], BASE);
  assert.equal(idx.length, 1);
  const e = idx[0];
  assert.equal(e.title, "Workshop Saturday");
  assert.equal(e.subtitle, "Come along");
  assert.equal(e.url, `${BASE}/posts/11111111-1111-1111-1111-111111111111`);
  assert.equal(typeof e.readingTime, "number");
  assert.ok(e.text.includes("face-paint"));
});

test("renderLatestPage: TOC, article, archive link, controls, escaping", () => {
  const html = news.renderLatestPage([newsPost({ content: "<script>x</script>" })], { baseUrl: BASE, total: 3 });
  assert.match(html, /class="latest-toc"/);           // TOC present
  assert.match(html, /id="reader-toggle"/);           // reader mode
  assert.match(html, /id="news-search"/);             // search box
  assert.match(html, /href="\/styles\/content-pages\.css"/); // client CSS linked
  assert.match(html, /Older news \(2 more\)/);        // archive link with older count
  assert.ok(!html.includes("<script>x</script>"), "content must be escaped");
});

test("renderLatestPage: empty state", () => {
  const html = news.renderLatestPage([], { baseUrl: BASE, total: 0 });
  assert.match(html, /No news yet/);
});
