"use strict";

/**
 * @module services/news
 *
 * Pure rendering for the `/latest` news aggregator. Posts of the `news` actor go
 * in; a search index and two self-contained HTML pages come out. No I/O and no
 * clock beyond an injectable "now", so the output is deterministic and testable;
 * the server owns caching and invalidation.
 *
 * The pages link the client's editorial stylesheet (same origin) for fonts and
 * colours, but ship their own layout CSS inline so they render correctly even
 * before the client is deployed. Reader mode and search are client-side and
 * identical across requests, which keeps the rendered HTML cacheable.
 */

const { escapeHtml } = require("./preview");

/** Reading-speed constant. @type {number} */
const WORDS_PER_MINUTE = 200;

/**
 * Estimated reading time in whole minutes (minimum 1).
 * @param {string} text
 * @returns {number}
 */
function readingTimeMinutes(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** First non-empty line of a string, trimmed. @param {string} text @returns {string} */
function firstLine(text) {
  return (String(text || "").split("\n").find((l) => l.trim()) || "").trim();
}

/** Word-boundary truncation for snippets. */
function truncate(text, max = 180) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return `${s.slice(0, cut > 0 ? cut : max)}…`;
}

/** Stable anchor id for a news item's TOC entry. */
function anchorFor(post) {
  return `news-${String(post.id).slice(0, 8)}`;
}

/**
 * The display title for a news post: its `title`, else the first content line,
 * else a fallback.
 * @param {Object} post
 * @returns {string}
 */
function titleOf(post) {
  return post.title || firstLine(post.content) || "Untitled";
}

/**
 * Build one search-index entry for a news post.
 * @param {Object} post
 * @param {string} baseUrl
 * @returns {Object}
 */
function indexEntry(post, baseUrl) {
  const media = post.attachment
    ? {
        type: String(post.attachment.mediaType).startsWith("video/") ? "video" : "image",
        url: post.attachment.url,
        thumbnailUrl: post.attachment.thumbnailUrl || null
      }
    : null;
  return {
    id: post.id,
    title: titleOf(post),
    subtitle: post.subtitle || null,
    url: new URL(`/posts/${post.id}`, baseUrl).href,
    anchor: anchorFor(post),
    createdAt: post.createdAt,
    readingTime: readingTimeMinutes(post.content),
    snippet: truncate(post.content),
    media,
    // Lowercased haystack for client-side search across every news item.
    text: `${post.title || ""} ${post.subtitle || ""} ${post.content || ""}`.toLowerCase()
  };
}

/**
 * The full search index for all news posts (newest first).
 * @param {Object[]} posts
 * @param {string} baseUrl
 * @returns {Object[]}
 */
function buildNewsIndex(posts, baseUrl) {
  return posts.map((p) => indexEntry(p, baseUrl));
}

/** Render one news `<article>`. */
function renderArticle(post, baseUrl) {
  const anchor = anchorFor(post);
  const title = titleOf(post);
  const minutes = readingTimeMinutes(post.content);
  const date = new Date(post.createdAt).toISOString().slice(0, 10);
  const permalink = new URL(`/posts/${post.id}`, baseUrl).href;

  let mediaBlock = "";
  if (post.attachment) {
    const a = post.attachment;
    mediaBlock = String(a.mediaType).startsWith("video/")
      ? `<video controls playsinline preload="metadata"${a.thumbnailUrl ? ` poster="${escapeHtml(a.thumbnailUrl)}"` : ""} src="${escapeHtml(a.url)}"></video>`
      : `<img alt="${escapeHtml(a.name || title)}" src="${escapeHtml(a.url)}">`;
  }

  const subtitle = post.subtitle ? `<p class="latest-article__subtitle">${escapeHtml(post.subtitle)}</p>` : "";

  return `<article class="latest-article" id="${anchor}">
  <header>
    <h2><a href="${escapeHtml(permalink)}">${escapeHtml(title)}</a></h2>
    ${subtitle}
    <p class="latest-article__meta">${escapeHtml(date)} · ${minutes} min read</p>
  </header>
  ${mediaBlock}
  <div class="latest-article__body"><p>${escapeHtml(post.content)}</p></div>
  <p class="latest-article__permalink"><a href="${escapeHtml(permalink)}">Permalink ·
    <span data-i18n-ignore>dedicated page</span></a></p>
</article>`;
}

/** Render the table of contents from a list of posts. */
function renderToc(posts) {
  if (posts.length === 0) return "";
  const items = posts.map((p) =>
    `<li><a href="#${anchorFor(p)}">${escapeHtml(titleOf(p))}</a> <span class="latest-toc__time">${readingTimeMinutes(p.content)} min</span></li>`
  ).join("\n      ");
  return `<nav class="latest-toc" aria-label="Contents">
    <h2>On this page</h2>
    <ol>
      ${items}
    </ol>
  </nav>`;
}

/** Shared <head> + inline layout/reader/print CSS + client stylesheet link. */
function pageHead(pageTitle) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="stylesheet" href="/styles/pages.css">
  <link rel="stylesheet" href="/styles/content-pages.css">
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font: 16px/1.6 system-ui, sans-serif; }
    .latest { max-width: 760px; margin: 0 auto; padding: 24px; }
    .latest-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 12px 0 8px; }
    .latest-search { flex: 1 1 220px; padding: 9px 12px; border-radius: 8px; border: 1px solid #8884; background: transparent; color: inherit; font: inherit; }
    .latest-toc ol { padding-left: 1.2em; }
    .latest-toc__time { opacity: .6; font-size: .85em; }
    .latest-article { border-top: 1px solid #8883; padding-top: 20px; margin-top: 28px; }
    .latest-article h2 { margin: 0 0 4px; }
    .latest-article__subtitle { margin: 0 0 6px; font-size: 1.05em; opacity: .85; }
    .latest-article__meta { margin: 0 0 12px; opacity: .6; font-size: .9em; }
    .latest-article img, .latest-article video { display: block; width: 100%; border-radius: 10px; background: #000; margin: 12px 0; }
    .latest-article__body p { white-space: pre-wrap; word-break: break-word; }
    .latest-archive-link { margin: 40px 0; font-size: 1.05em; }
    #search-results:empty { display: none; }
    #search-results li { margin: 10px 0; }
    /* Reader mode: single serif column, calm contrast. */
    body.reader { background: #f7f4ec; color: #1c1a17; }
    body.reader .latest { max-width: 640px; font-family: Georgia, "Times New Roman", serif; }
    body.reader .latest-toolbar, body.reader .latest-toc { display: none; }
    body.reader .latest-article img, body.reader .latest-article video { border-radius: 4px; }
    @media print {
      .latest-toolbar, .latest-toc, .latest-article__permalink { display: none; }
      .latest-article { break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>`;
}

/** Client-side reader toggle + index-backed search. */
function pageScript() {
  return `<script>
  (function () {
    // Reader mode: ?reader=1 or the toggle.
    var params = new URLSearchParams(location.search);
    if (params.get("reader") === "1") document.body.classList.add("reader");
    var toggle = document.getElementById("reader-toggle");
    if (toggle) toggle.addEventListener("click", function () { document.body.classList.toggle("reader"); });

    // Search across ALL news via the index, not just the articles on the page.
    var box = document.getElementById("news-search");
    var results = document.getElementById("search-results");
    var articles = document.getElementById("latest-articles");
    var toc = document.querySelector(".latest-toc");
    var index = [];
    if (box) {
      fetch("/latest/index.json").then(function (r) { return r.json(); }).then(function (d) { index = d; });
      box.addEventListener("input", function () {
        var q = box.value.trim().toLowerCase();
        if (!q) { results.innerHTML = ""; if (articles) articles.style.display = ""; if (toc) toc.style.display = ""; return; }
        if (articles) articles.style.display = "none";
        if (toc) toc.style.display = "none";
        var hits = index.filter(function (n) { return n.text.indexOf(q) !== -1; }).slice(0, 50);
        results.innerHTML = hits.length
          ? hits.map(function (n) { return '<li><a href="' + n.url + '">' + n.title + '</a> <span style="opacity:.6">· ' + n.createdAt.slice(0,10) + ' · ' + n.readingTime + ' min</span></li>'; }).join("")
          : "<li>No matching news.</li>";
      });
    }
  })();
  </script>
</body>
</html>`;
}

/**
 * Render the `/latest` page: the newest posts (already sliced), a TOC, search,
 * reader toggle, and a link to the archive between the last article and footer.
 *
 * @param {Object[]} posts - The latest N news posts, newest first.
 * @param {Object} options
 * @param {string} options.baseUrl
 * @param {number} options.total - Total news count (for the archive link).
 * @param {string} [options.archiveHref="/latest/archive"]
 * @returns {string}
 */
function renderLatestPage(posts, options) {
  const baseUrl = options.baseUrl;
  const archiveHref = options.archiveHref || "/latest/archive";
  const older = Math.max(0, (options.total || posts.length) - posts.length);
  const articles = posts.map((p) => renderArticle(p, baseUrl)).join("\n");
  const archiveLink = older > 0
    ? `<p class="latest-archive-link"><a href="${archiveHref}">Older news (${older} more) →</a></p>`
    : `<p class="latest-archive-link"><a href="${archiveHref}">News archive →</a></p>`;

  return `${pageHead("Ghostmaxxing — latest")}
  <main class="latest content-page">
    <header class="content-page__header-area">
      <p class="content-page__kicker">Ghostmaxxing</p>
      <h1>Latest</h1>
    </header>
    <div class="latest-toolbar">
      <input id="news-search" class="latest-search" type="search" placeholder="Search all news…" aria-label="Search news">
      <button id="reader-toggle" type="button">Reader mode</button>
    </div>
    <ul id="search-results" aria-live="polite"></ul>
    ${renderToc(posts)}
    <div id="latest-articles">
      ${posts.length ? articles : "<p>No news yet.</p>"}
    </div>
    ${archiveLink}
    <footer class="content-page__footer"><p>Ghostmaxxing</p></footer>
  </main>
  ${pageScript()}`;
}

/**
 * Render the `/latest/archive` page: every news post, newest first, with a TOC.
 * @param {Object[]} posts - All news posts, newest first.
 * @param {Object} options
 * @param {string} options.baseUrl
 * @returns {string}
 */
function renderArchivePage(posts, options) {
  const baseUrl = options.baseUrl;
  const articles = posts.map((p) => renderArticle(p, baseUrl)).join("\n");
  return `${pageHead("Ghostmaxxing — news archive")}
  <main class="latest content-page">
    <header class="content-page__header-area">
      <p class="content-page__kicker">Ghostmaxxing</p>
      <h1>News archive</h1>
      <p><a href="/latest">← Back to latest</a></p>
    </header>
    <div class="latest-toolbar">
      <input id="news-search" class="latest-search" type="search" placeholder="Search all news…" aria-label="Search news">
      <button id="reader-toggle" type="button">Reader mode</button>
    </div>
    <ul id="search-results" aria-live="polite"></ul>
    ${renderToc(posts)}
    <div id="latest-articles">
      ${posts.length ? articles : "<p>No news yet.</p>"}
    </div>
    <footer class="content-page__footer"><p>Ghostmaxxing</p></footer>
  </main>
  ${pageScript()}`;
}

module.exports = {
  WORDS_PER_MINUTE,
  readingTimeMinutes,
  titleOf,
  anchorFor,
  buildNewsIndex,
  renderLatestPage,
  renderArchivePage
};
