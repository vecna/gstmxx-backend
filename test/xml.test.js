"use strict";

/**
 * What this file tests
 * --------------------
 * XML escaping and RSS 2.0 construction. Crucially, the generated feed is
 * validated by a real XML parser (fast-xml-parser), and a title containing a
 * stray `&` / `<` is round-tripped — proving the output is well-formed and the
 * escaping is correct, which a regex `assert.match` could miss.
 *
 * What it does NOT cover
 * ----------------------
 * The HTTP feed route wiring (that is the publish integration test).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { XMLParser } = require("fast-xml-parser");
const { escapeXml, buildRssFeed } = require("../services/xml");

test("escapeXml handles the five entities and null", () => {
  assert.equal(escapeXml(`<a & b "c" 'd'>`), "&lt;a &amp; b &quot;c&quot; &apos;d&apos;&gt;");
  assert.equal(escapeXml(null), "");
});

test("buildRssFeed produces well-formed XML that a real parser accepts", () => {
  const xml = buildRssFeed({
    title: "Ghostmaxxing — ghostyles",
    description: "Published ghostyles.",
    link: "https://ghostmaxxing.vecna.eu",
    items: [
      {
        title: "Tom & Jerry <b>",
        link: "https://ghostmaxxing.vecna.eu/posts/1",
        description: "a note with an & ampersand and <tag>",
        pubDate: "2026-07-29T12:00:00Z",
        enclosureUrl: "https://ghostmaxxing.vecna.eu/videos/1.mp4",
        enclosureType: "video/mp4"
      }
    ]
  });

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml); // throws if malformed
  const channel = doc.rss.channel;
  assert.equal(channel.title, "Ghostmaxxing — ghostyles");

  const item = channel.item;
  // The stray & and < survived escaping and decoded back to the originals.
  assert.equal(item.title, "Tom & Jerry <b>");
  assert.equal(item.description, "a note with an & ampersand and <tag>");
  assert.equal(item.link, "https://ghostmaxxing.vecna.eu/posts/1");
  assert.equal(item.enclosure["@_url"], "https://ghostmaxxing.vecna.eu/videos/1.mp4");
  assert.equal(item.enclosure["@_type"], "video/mp4");
});

test("buildRssFeed with no items still parses", () => {
  const xml = buildRssFeed({ title: "empty", description: "d", link: "https://x", items: [] });
  const doc = new XMLParser().parse(xml);
  assert.equal(doc.rss.channel.title, "empty");
});
