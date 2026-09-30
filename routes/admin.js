"use strict";

/**
 * @module routes/admin
 *
 * The moderation surface, behind HTTP Basic Auth:
 *
 *  - `GET  /api/admin/`            the moderation page (served HTML)
 *  - `GET  /api/admin/pending`    pending uploads, oldest first, optional `?kind=`
 *  - `GET  /api/admin/media/:id`  authenticated preview of a *pending* raw file
 *  - `POST /api/admin/approve/:id` run ffmpeg, publish the post, mark approved
 *  - `POST /api/admin/reject/:id`  drop the raw file, mark rejected
 *
 * Approving **publishes into the store**: it creates the post record (so the
 * post is immediately readable as an ActivityPub object and appears in the post
 * list). Pushing a `Create` to followers, the web/OG preview page, and the RSS
 * feeds all read that record and are wired in the federation iteration.
 */

const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");

/**
 * Sniff whether a file starts with PNG or JPEG magic bytes.
 * @param {string} filePath
 * @returns {?("image/png"|"image/jpeg")} The detected type, or null.
 */
function sniffImage(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    return null;
  } catch {
    return null;
  }
}

/**
 * Constant-time HTTP Basic Auth middleware factory.
 * @param {string} user
 * @param {string} pass
 * @returns {import("express").RequestHandler}
 */
function basicAuth(user, pass) {
  const challenge = () => 'Basic realm="Ghostmaxxing Moderation"';
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", challenge());
      return res.status(401).send("Authentication required.");
    }
    let decoded = "";
    try {
      decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    } catch {
      res.setHeader("WWW-Authenticate", challenge());
      return res.status(401).send("Invalid credentials.");
    }
    const sep = decoded.indexOf(":");
    const okUser = sep >= 0 && safeEqual(decoded.slice(0, sep), user);
    const okPass = sep >= 0 && safeEqual(decoded.slice(sep + 1), pass);
    if (okUser && okPass) return next();
    res.setHeader("WWW-Authenticate", challenge());
    return res.status(401).send("Invalid credentials.");
  };
}

/**
 * Constant-time string comparison (hash-then-compare to avoid length leaks).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const da = crypto.createHash("sha256").update(String(a)).digest();
  const db = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Build the moderation router.
 *
 * @param {Object} ctx
 * @param {import("../uploadStore")} ctx.uploadStore
 * @param {string} ctx.uploadsDir
 * @param {import("../postStore")} ctx.postStore
 * @param {string} ctx.postDir
 * @param {{incoming:string, approved:string, thumbnails:string}} ctx.dirs
 * @param {import("../services/video")} ctx.video
 * @param {import("../services/media")} ctx.media
 * @param {string} ctx.baseUrl
 * @param {(record:Object)=>string} ctx.actorForUpload
 * @param {(post:Object, traceId?:string)=>Promise<{followers:number}>} ctx.announce
 * @param {(post:Object, traceId?:string)=>Promise<Array>} [ctx.afterPublish]
 * @param {string} ctx.adminHtmlPath
 * @param {string} ctx.composeHtmlPath - Path to the composer page HTML.
 * @param {ReadonlyArray<string>} ctx.actors - Actors the composer may publish as.
 * @param {()=>void} [ctx.onNewsChange] - Called after a news post is published.
 * @param {string} ctx.adminUser
 * @param {string} ctx.adminPass
 * @returns {import("express").Router}
 */
function createAdminRouter(ctx) {
  const router = express.Router();
  router.use(basicAuth(ctx.adminUser, ctx.adminPass));

  router.get("/", (_req, res) => res.sendFile(ctx.adminHtmlPath));

  router.get("/pending", (req, res) => {
    const kind = ["video", "clipboard"].includes(req.query.kind) ? req.query.kind : undefined;
    const pending = ctx.uploadStore
      .listPending(ctx.uploadsDir, { kind }, req.flow && req.flow.id)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        consentVersion: r.consentVersion,
        ghostyleId: r.ghostyleId,
        appVersion: r.appVersion,
        userNote: r.userNote,
        createdAt: r.createdAt,
        mediaUrl: `/api/admin/media/${r.id}`
      }));
    res.json({ ok: true, pending });
  });

  router.get("/media/:id", (req, res) => {
    const record = ctx.uploadStore.read(ctx.uploadsDir, req.params.id, req.flow && req.flow.id);
    if (!record || record.status !== "pending") {
      return res.status(404).json({ ok: false, message: "Pending upload not found." });
    }
    const mediaPath = path.join(ctx.dirs.incoming, record.filename);
    if (record.kind === "clipboard") res.type("image/png");
    return res.sendFile(mediaPath, (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, message: "Pending media file not found." });
    });
  });

  router.post("/approve/:id", async (req, res) => {
    const { id } = req.params;
    try {
      const record = ctx.uploadStore.read(ctx.uploadsDir, id, req.flow && req.flow.id);
      if (!record || record.status !== "pending") {
        return res.status(404).json({ ok: false, message: "Pending upload not found." });
      }

      const processed = record.kind === "clipboard"
        ? await ctx.video.processApprovedClipboard(record.filename, id, ctx.dirs)
        : await ctx.video.processApprovedVideo(record.filename, id, ctx.dirs);

      // The raw incoming file has served its purpose.
      ctx.media.removeIncoming(record.filename, ctx.dirs.incoming);

      const actor = ctx.actorForUpload(record);
      const mediaClass = record.kind === "clipboard" ? "pictures" : "videos";
      const publicUrl = ctx.media.publicUrlForApproved(ctx.baseUrl, record.kind, processed.mediaName);
      const attachment = {
        type: record.kind === "clipboard" ? "Image" : "Video",
        url: publicUrl,
        mediaType: ctx.media.mediaTypeForKind(record.kind),
        name: record.userNote || `${record.kind} ${id}`
      };
      // Poster for the OG preview of a video (ignored by the AP serializer).
      if (record.kind !== "clipboard" && processed.thumbnailName) {
        attachment.thumbnailUrl = ctx.media.thumbnailUrl(ctx.baseUrl, processed.thumbnailName);
      }
      const content = record.userNote
        || (record.ghostyleId ? `Ghostyle ${record.ghostyleId}` : `New ${record.kind}`);

      const post = ctx.postStore.create(ctx.postDir, content, actor, {
        attachment,
        media: mediaClass,
        sourceUploadId: record.id,
        ghostyleId: record.ghostyleId || null,
        traceId: req.flow && req.flow.id
      });

      const approved = ctx.uploadStore.approve(ctx.uploadsDir, id, {
        filename: processed.mediaName,
        thumbnailFilename: processed.thumbnailName,
        postId: post.id
      }, req.flow && req.flow.id);

      // Publish outward: push a Create to the actor's followers. A failure here
      // does not undo the approval — the post is already in the store and live
      // on the web; the delivery result is reported for visibility.
      let federation;
      try {
        federation = await ctx.announce(post, req.flow && req.flow.id);
      } catch (error) {
        federation = { error: error.message };
      }

      // Fan out to matching echo filter actors (e.g. ghostyles-pictures).
      // Non-fatal: a filter delivery failure must not fail the approval.
      let echoes = [];
      if (typeof ctx.afterPublish === "function") {
        try {
          echoes = await ctx.afterPublish(post, req.flow && req.flow.id);
        } catch (error) {
          echoes = [{ error: error.message }];
        }
      }

      return res.json({
        ok: true,
        message: "Approved, published, and federated.",
        kind: record.kind,
        actor,
        post: { id: post.id, url: new URL(`/posts/${post.id}`, ctx.baseUrl).href },
        media: processed.mediaName,
        thumbnail: processed.thumbnailName,
        publicUrl,
        moderatedAt: approved && approved.moderatedAt,
        federation,
        echoes
      });
    } catch (error) {
      console.error("[admin] approve error:", error);
      return res.status(500).json({ ok: false, message: `Approval failed: ${error.message}` });
    }
  });

  router.post("/reject/:id", (req, res) => {
    const { id } = req.params;
    try {
      const record = ctx.uploadStore.read(ctx.uploadsDir, id, req.flow && req.flow.id);
      if (!record || record.status !== "pending") {
        return res.status(404).json({ ok: false, message: "Pending upload not found." });
      }
      ctx.uploadStore.reject(ctx.uploadsDir, id, {}, req.flow && req.flow.id);
      ctx.media.removeIncoming(record.filename, ctx.dirs.incoming);
      return res.json({ ok: true, message: "Upload rejected and the raw file deleted." });
    } catch (error) {
      console.error("[admin] reject error:", error);
      return res.status(500).json({ ok: false, message: error.message });
    }
  });

  // --- News composer (staff authoring, direct publish, no moderation) ------
  const composeUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, ctx.dirs.approved),
      filename: (_req, file, cb) =>
        cb(null, `${crypto.randomBytes(16).toString("hex")}${path.extname(file.originalname).toLowerCase() || ".img"}`)
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) =>
      ["image/png", "image/jpeg"].includes(file.mimetype)
        ? cb(null, true)
        : cb(new Error("Composer images must be PNG or JPEG."))
  });

  router.get("/compose", (_req, res) => res.sendFile(ctx.composeHtmlPath));

  router.post("/compose", composeUpload.single("image"), async (req, res) => {
    try {
      const title = (req.body.title || "").trim();
      const subtitle = (req.body.subtitle || "").trim();
      const content = (req.body.content || "").trim();
      const actor = req.body.actor || "news";
      const altText = (req.body.altText || "").trim();

      if (!Array.isArray(ctx.actors) || !ctx.actors.includes(actor)) {
        if (req.file) ctx.media.removeIfExists(req.file.path);
        return res.status(400).json({ ok: false, message: `actor must be one of: ${(ctx.actors || []).join(", ")}.` });
      }
      // A title is mandatory: it drives the /latest TOC, the reading list and
      // the dedicated page, and nudges authors toward considered updates.
      if (!title) {
        if (req.file) ctx.media.removeIfExists(req.file.path);
        return res.status(400).json({ ok: false, message: "A title is required." });
      }
      if (!content && !req.file) {
        return res.status(400).json({ ok: false, message: "Provide text, an image, or both." });
      }

      let attachment = null;
      let mediaClass = null;
      if (req.file) {
        const sniffed = sniffImage(req.file.path);
        if (!sniffed) {
          ctx.media.removeIfExists(req.file.path);
          return res.status(400).json({ ok: false, message: "The uploaded file is not a valid PNG or JPEG." });
        }
        // News media is trusted (staff) → written straight to approved storage.
        attachment = {
          type: "Image",
          url: ctx.media.publicUrlForApproved(ctx.baseUrl, "clipboard", req.file.filename),
          mediaType: sniffed,
          name: altText || title
        };
        mediaClass = "pictures";
      }

      const post = ctx.postStore.create(ctx.postDir, content || title, actor, {
        title,
        subtitle: subtitle || undefined,
        attachment,
        media: mediaClass,
        traceId: req.flow && req.flow.id
      });

      let federation;
      try {
        federation = await ctx.announce(post, req.flow && req.flow.id);
      } catch (error) {
        federation = { error: error.message };
      }
      let echoes = [];
      if (typeof ctx.afterPublish === "function") {
        echoes = await ctx.afterPublish(post, req.flow && req.flow.id).catch(() => []);
      }
      // Refresh the /latest aggregator immediately for news changes.
      if (actor === "news" && typeof ctx.onNewsChange === "function") ctx.onNewsChange();

      return res.status(201).json({
        ok: true,
        message: "Published.",
        actor,
        post: { id: post.id, url: new URL(`/posts/${post.id}`, ctx.baseUrl).href },
        federation,
        echoes
      });
    } catch (error) {
      if (req.file) ctx.media.removeIfExists(req.file.path);
      console.error("[admin] compose error:", error);
      return res.status(500).json({ ok: false, message: error.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter, basicAuth, safeEqual };
