"use strict";

/**
 * @module routes/uploads
 *
 * Public upload intake and owner self-service delete.
 *
 *  - `POST /api/uploads` receives one workshop video (`video`) or clipboard PNG
 *    (`clipboard`) plus the consent version, sniffs the content, and enqueues a
 *    pending moderation record. Returns the upload id and an opaque delete
 *    token.
 *  - `DELETE /api/uploads/:id` lets the uploader remove their own submission
 *    with that token, at any stage.
 *
 * The router is built from injected dependencies so it holds no globals and is
 * unit-testable in isolation.
 */

const express = require("express");
const multer = require("multer");
const path = require("node:path");
const crypto = require("node:crypto");

/** Accepted upload MIME types. @type {ReadonlyArray<string>} */
const ALLOWED_MIME = Object.freeze(["video/mp4", "video/webm", "video/ogg", "image/png"]);

/** Hard upload size limit; keep in sync with nginx `client_max_body_size`. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Normalize the `kind` field to a supported value, or null if invalid.
 * @param {?string} kind
 * @returns {?("video"|"clipboard")}
 */
function normalizeKind(kind) {
  if (!kind || kind === "video") return "video";
  if (kind === "clipboard") return "clipboard";
  return null;
}

/**
 * Build the uploads router.
 *
 * @param {Object} ctx
 * @param {import("../uploadStore")} ctx.uploadStore
 * @param {string} ctx.uploadsDir
 * @param {string} ctx.incomingDir
 * @param {{incoming:string, approved:string, thumbnails:string}} ctx.dirs
 * @param {import("../services/media")} ctx.media
 * @param {import("../services/videoValidation")} ctx.validation
 * @param {import("../postStore")} ctx.postStore
 * @param {string} ctx.postDir
 * @param {(post:Object, traceId?:string)=>Promise<{followers:number}>} ctx.emitDelete
 * @returns {import("express").Router}
 */
function createUploadsRouter(ctx) {
  const router = express.Router();

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, ctx.incomingDir),
    filename: (_req, file, cb) => {
      const randomName = crypto.randomBytes(16).toString("hex");
      cb(null, `${randomName}${path.extname(file.originalname).toLowerCase()}`);
    }
  });
  const upload = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_MIME.includes(file.mimetype)) return cb(null, true);
      cb(new Error("Unsupported file type. Allowed: MP4/WebM/OGG video or PNG image."));
    }
  });

  router.post("/", upload.single("video"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, message: "No file received." });
      }
      const { consent_version: consentVersion, kind: rawKind, ghostyle_id: ghostyleId,
        app_version: appVersion, user_note: userNote, metrics_json: metrics } = req.body;

      const kind = normalizeKind(rawKind);
      if (!kind) {
        ctx.media.removeIfExists(req.file.path);
        return res.status(400).json({ ok: false, message: "kind must be video or clipboard." });
      }
      // Consent is a hard gate on storage.
      if (!consentVersion) {
        ctx.media.removeIfExists(req.file.path);
        return res.status(400).json({ ok: false, message: "consent_version is required." });
      }
      const accepted = kind === "clipboard"
        ? ctx.validation.validateUploadedPng(req.file.path)
        : await ctx.validation.validateUploadedVideo(req.file.path);
      if (!accepted) {
        ctx.media.removeIfExists(req.file.path);
        return res.status(400).json({
          ok: false,
          message: kind === "clipboard" ? "The file is not a valid PNG." : "The file is not a valid video."
        });
      }

      const record = ctx.uploadStore.create(ctx.uploadsDir, {
        kind,
        filename: req.file.filename,
        consentVersion,
        ghostyleId,
        appVersion,
        userNote,
        metrics
      }, req.flow && req.flow.id);

      return res.status(201).json({
        ok: true,
        uploadId: record.id,
        deleteToken: record.deleteToken,
        message: "Upload received and queued for human moderation."
      });
    } catch (error) {
      if (req.file) ctx.media.removeIfExists(req.file.path);
      console.error("[uploads] intake error:", error);
      return res.status(500).json({ ok: false, message: "Internal error handling the upload." });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const record = ctx.uploadStore.read(ctx.uploadsDir, req.params.id, req.flow && req.flow.id);
      if (!record) {
        return res.status(404).json({ ok: false, message: "Upload not found." });
      }
      if (record.status === "deleted" || record.status === "rejected") {
        return res.status(410).json({ ok: false, message: "Upload already removed." });
      }
      if (!ctx.uploadStore.verifyDeleteToken(record, req.get("X-Delete-Token"))) {
        return res.status(403).json({ ok: false, message: "Invalid delete token." });
      }

      const wasApproved = record.status === "approved";
      const updated = ctx.uploadStore.markDeleted(ctx.uploadsDir, record.id, {}, req.flow && req.flow.id);
      if (!updated) {
        return res.status(410).json({ ok: false, message: "Upload already removed." });
      }
      const removed = ctx.media.removeUploadFiles(record, ctx.dirs);

      // Retire the published post: federate a Delete/Tombstone to followers,
      // then drop it from the read surfaces. Federation failure does not block
      // the local removal.
      let federation = { skipped: true };
      if (wasApproved && record.postId) {
        const post = ctx.postStore.read(ctx.postDir, record.postId, req.flow && req.flow.id);
        if (post) {
          try {
            federation = await ctx.emitDelete(post, req.flow && req.flow.id);
          } catch (error) {
            federation = { error: error.message };
          }
          ctx.postStore.remove(ctx.postDir, record.postId, req.flow && req.flow.id);
        }
      }
      return res.json({
        ok: true,
        message: "Upload deleted.",
        removedFiles: removed.length,
        federation
      });
    } catch (error) {
      console.error("[uploads] delete error:", error);
      return res.status(500).json({ ok: false, message: "Internal error deleting the upload." });
    }
  });

  return router;
}

module.exports = { createUploadsRouter, ALLOWED_MIME, MAX_UPLOAD_BYTES, normalizeKind };
