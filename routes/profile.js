"use strict";

/**
 * @module routes/profile
 *
 * The actor profile surface: display name, biography, profile fields, avatar
 * and header image.
 *
 * Two design choices worth knowing about:
 *
 * 1. Media is served from `/api/actors/:handle/media/:file` rather than a new
 *    top-level path. `/api` is already proxied to Node by the production nginx
 *    site, so avatars and headers work on a fresh deploy with no nginx change.
 *
 * 2. Writing a profile does not, by itself, reach anyone. Remote servers cache
 *    actor documents, so `POST /api/actors/:handle/publish` pushes an
 *    `Update(Person)` to the followers. The CLI does both in one step.
 */

const express = require("express");
const { normalizeProfileInput, ALLOWED_IMAGE_TYPES } = require("../profileStore.js");

const IMAGE_KINDS = new Set(["avatar", "header"]);

/**
 * Build the profile router.
 *
 * @param {Object} ctx
 * @param {Object} ctx.profileStore - A `createProfileStore` instance.
 * @param {(handle:string)=>boolean} ctx.isServableActor
 * @param {()=>string[]} ctx.listActors - Every servable handle.
 * @param {import("express").RequestHandler} ctx.requireToken - Write guard.
 * @param {(handle:string, traceId?:string)=>Promise<Object>} ctx.publishUpdate
 *        - Federates an `Update(Person)` and returns a delivery report.
 * @param {(handle:string)=>Promise<Object>} ctx.renderActor - The Person as
 *        JSON-LD, for previewing exactly what remote servers will read.
 * @returns {import("express").Router}
 */
function createProfileRouter(ctx) {
  const router = express.Router();

  // Raw image bodies. Kept narrow: only the two media routes accept binary,
  // and only the four raster types remote servers actually render.
  const imageBody = express.raw({
    type: [...ALLOWED_IMAGE_TYPES.keys()],
    limit: "2mb"
  });

  function resolveHandle(req, res) {
    const handle = String(req.params.handle || "");
    if (!ctx.isServableActor(handle)) {
      res.status(404).json({ ok: false, message: `Unknown actor: ${handle}.` });
      return null;
    }
    return handle;
  }

  /** Every actor and whether it has a stored profile. */
  router.get("/", (_req, res) => {
    const all = ctx.profileStore.readAll();
    res.json({
      ok: true,
      actors: ctx.listActors().map((handle) => ({
        handle,
        hasProfile: Boolean(all[handle]),
        updatedAt: all[handle]?.updatedAt || null
      }))
    });
  });

  /** The stored profile for one actor. */
  router.get("/:handle/profile", (req, res) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    return res.json({ ok: true, handle, profile: ctx.profileStore.read(handle) });
  });

  /**
   * The rendered `Person` document — what Mastodon actually sees. Useful for
   * confirming that a change landed before pushing it out.
   */
  router.get("/:handle/preview", async (req, res, next) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    try {
      return res.json({ ok: true, handle, actor: await ctx.renderActor(handle) });
    } catch (error) {
      return next(error);
    }
  });

  /** Public, immutable: the filename contains a hash of the bytes. */
  router.get("/:handle/media/:file", (req, res) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    const file = String(req.params.file || "");
    if (!file.startsWith(`${handle}-`)) {
      return res.status(404).json({ ok: false, message: "Not found." });
    }
    const bytes = ctx.profileStore.readMedia(file);
    if (!bytes) {
      return res.status(404).json({ ok: false, message: "Not found." });
    }
    const record = ctx.profileStore.read(handle);
    const mediaType =
      (record.avatar?.file === file && record.avatar.mediaType) ||
      (record.header?.file === file && record.header.mediaType) ||
      guessType(file);
    res.setHeader("Content-Type", mediaType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.end(bytes);
  });

  /** Merge a profile patch. Absent keys are left alone; `null` clears one. */
  router.put("/:handle/profile", ctx.requireToken, express.json({ limit: "64kb" }), (req, res, next) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    try {
      const patch = normalizeProfileInput(req.body);
      const profile = ctx.profileStore.update(handle, patch);
      req.flow?.next("PROFILE_UPDATED", {
        actor: handle,
        keys: Object.keys(patch).join(",") || "none"
      });
      return res.json({ ok: true, handle, profile });
    } catch (error) {
      return next(error);
    }
  });

  /** Upload avatar or header bytes. */
  router.put("/:handle/media/:kind", ctx.requireToken, imageBody, (req, res, next) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    const kind = String(req.params.kind || "");
    if (!IMAGE_KINDS.has(kind)) {
      return res
        .status(400)
        .json({ ok: false, message: "kind must be avatar or header." });
    }
    try {
      const mediaType = String(req.get("content-type") || "").split(";")[0].trim();
      const stored = ctx.profileStore.putMedia(handle, kind, req.body, mediaType);
      const profile = ctx.profileStore.update(handle, { [kind]: stored });
      ctx.profileStore.pruneMedia(handle);
      req.flow?.next("PROFILE_MEDIA_STORED", {
        actor: handle,
        kind,
        bytes: stored.bytes,
        file: stored.file
      });
      return res.json({ ok: true, handle, kind, media: stored, profile });
    } catch (error) {
      return next(error);
    }
  });

  /** Remove avatar or header. */
  router.delete("/:handle/media/:kind", ctx.requireToken, (req, res) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    const kind = String(req.params.kind || "");
    if (!IMAGE_KINDS.has(kind)) {
      return res
        .status(400)
        .json({ ok: false, message: "kind must be avatar or header." });
    }
    const profile = ctx.profileStore.update(handle, { [kind]: null });
    const removed = ctx.profileStore.pruneMedia(handle);
    return res.json({ ok: true, handle, kind, removed, profile });
  });

  /**
   * Federate the current profile: an `Update(Person)` to the actor's followers.
   * Without this, remote servers keep showing the cached old profile.
   */
  router.post("/:handle/publish", ctx.requireToken, async (req, res, next) => {
    const handle = resolveHandle(req, res);
    if (!handle) return undefined;
    try {
      const delivery = await ctx.publishUpdate(handle, req.flow && req.flow.id);
      req.flow?.next("PROFILE_PUBLISHED", {
        actor: handle,
        followers: delivery.followers,
        delivered: delivery.delivered,
        deliveryOk: delivery.ok
      });
      const totalFailure =
        !delivery.ok && delivery.delivered === 0 && delivery.followers > 0;
      return res.status(totalFailure ? 502 : 200).json({
        ok: !totalFailure,
        handle,
        message: totalFailure ? delivery.error : undefined,
        delivery
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

function guessType(file) {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

module.exports = { createProfileRouter };
