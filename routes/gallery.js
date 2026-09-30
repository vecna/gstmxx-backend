"use strict";

const express = require("express");

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const GALLERY_ACTOR = "ghostyles-pictures";

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

function encodeCursor(post) {
  return Buffer.from(JSON.stringify([post.createdAt, post.id])).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((part) => typeof part === "string")) return null;
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}

function isOlderThan(post, cursor) {
  return post.createdAt < cursor.createdAt || (post.createdAt === cursor.createdAt && post.id < cursor.id);
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
    const cursor = decodeCursor(req.query.cursor);
    if (req.query.cursor && !cursor) {
      return res.status(400).json({ ok: false, message: "Invalid gallery cursor." });
    }
    const candidates = ctx.postStore
      .list(ctx.postDir, req.flow && req.flow.id)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .filter((post) => !cursor || isOlderThan(post, cursor))
      .map((post) => galleryItem({ ...post, url: new URL(`/posts/${post.id}`, ctx.baseUrl).href }))
      .filter(Boolean);
    const items = candidates.slice(0, limit);
    const hasMore = candidates.length > items.length;
    const last = items.at(-1);
    res.json({
      ok: true,
      gallery: {
        actor: `@${GALLERY_ACTOR}@${new URL(ctx.baseUrl).host}`,
        actorUrl: new URL(`/federation/actors/${GALLERY_ACTOR}`, ctx.baseUrl).href,
        followers: typeof ctx.followerCount === "function" ? ctx.followerCount(GALLERY_ACTOR) : 0
      },
      items,
      nextCursor: hasMore && last ? encodeCursor(last) : null
    });
  });

  return router;
}

module.exports = { createGalleryRouter, galleryItem, parseLimit, encodeCursor, decodeCursor, isOlderThan, DEFAULT_LIMIT, MAX_LIMIT, GALLERY_ACTOR };
