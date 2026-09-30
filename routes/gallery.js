"use strict";

const express = require("express");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

function galleryItem(post) {
  const attachment = post && post.attachment;
  // Only moderation-approved uploads carry sourceUploadId. Direct control/API
  // posts remain public elsewhere but do not silently enter the community gallery.
  if (!post || !post.sourceUploadId) return null;
  if (!attachment || !String(attachment.mediaType || "").startsWith("image/")) return null;
  return {
    id: post.id,
    createdAt: post.createdAt,
    content: post.content,
    actor: post.actor,
    sourceUploadId: post.sourceUploadId,
    ghostyleId: post.ghostyleId || null,
    likes: Number.isInteger(post.likes) ? post.likes : 0,
    postUrl: post.url,
    imageUrl: attachment.url,
    thumbnailUrl: attachment.thumbnailUrl || attachment.url,
    alt: attachment.name || post.content || "Ghostmaxxing community image"
  };
}

function parseLimit(value) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function createGalleryRouter(ctx) {
  const router = express.Router();

  // The gallery is public, read-only data. A permissive CORS header is scoped
  // to this router so local/static clients can explicitly opt into production
  // fallback without exposing any write or administration endpoint.
  router.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    next();
  });
  router.options("/", (_req, res) => res.sendStatus(204));

  router.get("/", (req, res) => {
    const limit = parseLimit(req.query.limit);
    const items = ctx.postStore
      .list(ctx.postDir, req.flow && req.flow.id)
      .map((post) => galleryItem({ ...post, url: new URL(`/posts/${post.id}`, ctx.baseUrl).href }))
      .filter(Boolean)
      .slice(0, limit);
    res.json({ ok: true, items });
  });

  return router;
}

module.exports = { createGalleryRouter, galleryItem, parseLimit, DEFAULT_LIMIT, MAX_LIMIT };
