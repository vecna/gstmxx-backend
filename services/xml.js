"use strict";

/**
 * @module services/xml
 *
 * Minimal, dependency-free RSS 2.0 construction with correct escaping. Kept
 * pure so the feed output can be validated by a real XML parser in tests — a
 * stray `&` in a title must not produce malformed XML.
 */

/**
 * Escape a value for inclusion in XML text or attributes.
 * @param {*} unsafe - Any value; null/undefined become "".
 * @returns {string}
 */
function escapeXml(unsafe) {
  if (unsafe == null) return "";
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      case '"': return "&quot;";
      default: return c;
    }
  });
}

/**
 * @typedef {Object} RssItem
 * @property {string} title
 * @property {string} link
 * @property {string} description
 * @property {(string|number|Date)} [pubDate]
 * @property {string} [guid] - Defaults to `link`.
 * @property {string} [enclosureUrl] - Media URL (image/video).
 * @property {string} [enclosureType] - Media MIME type.
 */

/**
 * Build a complete RSS 2.0 document.
 *
 * @param {Object} channel
 * @param {string} channel.title
 * @param {string} channel.description
 * @param {string} channel.link - Channel homepage/origin.
 * @param {RssItem[]} channel.items
 * @returns {string} The XML document.
 */
function buildRssFeed({ title, description, link, items }) {
  const now = new Date().toUTCString();
  const head =
`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <description>${escapeXml(description)}</description>
  <language>en</language>
  <lastBuildDate>${now}</lastBuildDate>
`;

  const body = items.map((item) => {
    const pubDate = new Date(item.pubDate || Date.now()).toUTCString();
    const guid = item.guid || item.link;
    const enclosure = item.enclosureUrl
      ? `    <enclosure url="${escapeXml(item.enclosureUrl)}" type="${escapeXml(item.enclosureType || "")}" length="0" />\n`
      : "";
    return (
`  <item>
    <title>${escapeXml(item.title)}</title>
    <link>${escapeXml(item.link)}</link>
    <description>${escapeXml(item.description)}</description>
    <pubDate>${pubDate}</pubDate>
    <guid isPermaLink="true">${escapeXml(guid)}</guid>
${enclosure}  </item>
`);
  }).join("");

  return `${head}${body}</channel>\n</rss>\n`;
}

module.exports = { escapeXml, buildRssFeed };
