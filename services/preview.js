"use strict";

/**
 * @module services/preview
 *
 * Renders the human-facing HTML page for a post — the same URL that serves the
 * ActivityPub object, content-negotiated. The page carries Open Graph and
 * Twitter Card metadata so that when the post is shared (including the
 * fediverse Note whose `url` points here) a rich preview appears. The image is
 * the attachment for a picture, or the stored poster thumbnail for a video.
 *
 * Self-contained (inline CSS, no external assets) so it renders even before the
 * client static layer is deployed.
 */

/**
 * Escape a value for HTML text/attribute contexts.
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Truncate to a sensible meta-description length on a word boundary.
 * @param {string} text
 * @param {number} [max=200]
 * @returns {string}
 */
function truncate(text, max = 200) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, s.lastIndexOf(" ", max) > 0 ? s.lastIndexOf(" ", max) : max)}…`;
}

/**
 * The image URL to use for `og:image`: the attachment itself for a picture, or
 * the poster thumbnail for a video (stored as `attachment.thumbnailUrl`).
 * @param {Object} post
 * @returns {?string}
 */
function ogImageFor(post) {
  const a = post.attachment;
  if (!a) return null;
  if (String(a.mediaType).startsWith("image/")) return a.url;
  return a.thumbnailUrl || null;
}

/**
 * Render the full HTML page for a post.
 *
 * @param {Object} post - A post record.
 * @param {Object} options
 * @param {string} options.baseUrl - Public origin.
 * @returns {string} A complete HTML document.
 */
function renderPostPage(post, options) {
  const baseUrl = options.baseUrl;
  const url = new URL(`/posts/${post.id}`, baseUrl).href;
  const actorLabel = `Ghostmaxxing: ${post.actor}`;
  const description = truncate(post.content);
  const ogImage = ogImageFor(post);
  const isVideo = post.attachment && String(post.attachment.mediaType).startsWith("video/");

  const mediaBlock = !post.attachment
    ? ""
    : isVideo
      ? `<video controls playsinline preload="metadata"${ogImage ? ` poster="${escapeHtml(ogImage)}"` : ""} src="${escapeHtml(post.attachment.url)}"></video>`
      : `<img alt="${escapeHtml(post.attachment.name)}" src="${escapeHtml(post.attachment.url)}">`;

  const meta = [
    `<meta property="og:title" content="${escapeHtml(actorLabel)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : "",
    isVideo ? `<meta property="og:video" content="${escapeHtml(post.attachment.url)}">` : "",
    isVideo ? `<meta property="og:video:type" content="${escapeHtml(post.attachment.mediaType)}">` : "",
    `<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">`
  ].filter(Boolean).join("\n    ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(actorLabel)}</title>
    ${meta}
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #0f1013; color: #f2f3f5; }
      main { max-width: 640px; margin: 0 auto; padding: 24px; }
      .kicker { color: #9aa3b2; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
      img, video { display: block; width: 100%; border-radius: 10px; background: #000; margin: 16px 0; }
      p { white-space: pre-wrap; word-break: break-word; }
      a { color: #7db3ff; }
    </style>
  </head>
  <body>
    <main>
      <div class="kicker">@${escapeHtml(post.actor)} · ${escapeHtml(post.createdAt)}</div>
      ${mediaBlock}
      <p>${escapeHtml(post.content)}</p>
      <p><a href="${escapeHtml(url)}">Permalink</a></p>
    </main>
  </body>
</html>
`;
}

module.exports = { renderPostPage, ogImageFor, escapeHtml, truncate };
