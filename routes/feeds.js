"use strict";

/**
 * @module routes/feeds
 *
 * RSS feeds built from the post store — one surface of the "one record, four
 * surfaces" model. `/feed/<actor>.xml` is the posts of a raw actor;
 * `/feed/all.xml` merges every actor. Each item links to the post's permalink
 * (the content-negotiated `/posts/:id`) and carries the media as an
 * `<enclosure>`.
 *
 * (The retired backend had a separate `ghostyles.xml` catalog built from the JS
 * plugin manifest. In the unified model `ghostyles` is a content actor, so its
 * feed is just its posts — consistent with every other actor.)
 */

const express = require("express");

/**
 * First non-empty line of a post's content, trimmed, as a feed item title.
 * @param {Object} post
 * @returns {string}
 */
function titleFor(post) {
  const firstLine = String(post.content || "").split("\n").find((l) => l.trim());
  const base = (firstLine || `${post.actor} post`).trim();
  return base.length > 120 ? `${base.slice(0, 119)}…` : base;
}

/**
 * Convert a post record into an RSS item.
 * @param {Object} post
 * @param {string} baseUrl
 * @returns {import("../services/xml").RssItem}
 */
function itemFor(post, baseUrl) {
  const link = new URL(`/posts/${post.id}`, baseUrl).href;
  return {
    title: titleFor(post),
    link,
    description: post.content,
    pubDate: post.createdAt,
    guid: link,
    enclosureUrl: post.attachment ? post.attachment.url : undefined,
    enclosureType: post.attachment ? post.attachment.mediaType : undefined
  };
}

/**
 * Build the feeds router.
 *
 * @param {Object} ctx
 * @param {import("../postStore")} ctx.postStore
 * @param {string} ctx.postDir
 * @param {string} ctx.baseUrl
 * @param {ReadonlyArray<string>} ctx.actors - Valid raw actor handles.
 * @param {import("../services/xml")} ctx.xml
 * @returns {import("express").Router}
 */
function createFeedsRouter(ctx) {
  const router = express.Router();

  router.get("/:name", (req, res) => {
    const match = /^(.+)\.xml$/.exec(req.params.name);
    if (!match) return res.status(404).json({ ok: false, message: "Feed not found." });
    const which = match[1];

    let posts;
    let title;
    if (which === "all") {
      posts = ctx.postStore.list(ctx.postDir, req.flow && req.flow.id);
      title = "Ghostmaxxing — all updates";
    } else if (ctx.actors.includes(which)) {
      posts = ctx.postStore.listByActor(ctx.postDir, which, req.flow && req.flow.id);
      title = `Ghostmaxxing — ${which}`;
    } else {
      return res.status(404).json({ ok: false, message: "Unknown feed." });
    }

    const xmlDoc = ctx.xml.buildRssFeed({
      title,
      description: `Published ${which === "all" ? "content" : which} from Ghostmaxxing.`,
      link: ctx.baseUrl,
      items: posts.slice(0, 50).map((p) => itemFor(p, ctx.baseUrl))
    });
    res.type("application/rss+xml").send(xmlDoc);
  });

  return router;
}

module.exports = { createFeedsRouter, itemFor, titleFor };
