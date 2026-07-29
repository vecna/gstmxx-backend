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
const crypto = require("node:crypto");
const path = require("node:path");

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
 * @param {string} ctx.adminHtmlPath
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
        federation
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

  return router;
}

module.exports = { createAdminRouter, basicAuth, safeEqual };
