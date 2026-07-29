"use strict";

/**
 * What this file tests
 * --------------------
 * The flat-file moderation ledger: pending creation with consent gating, the
 * oldest-first pending queue with a kind filter, the approve/reject/delete
 * state transitions and their preconditions (no double-approve), the stale
 * sweep with an injected clock, and constant-time delete-token verification.
 *
 * How it tests it
 * ---------------
 * Temp directory per test. The clock is injected everywhere it matters
 * (`fields.now`, `options.now`) so "stale after 14 days" and queue ordering are
 * deterministic and independent of the real time.
 *
 * What it does NOT cover
 * ----------------------
 * multer receipt, ffmpeg transcode/thumbnail, physical file moves, and
 * federation side effects — this module is the pure data layer; those belong to
 * the route/service tests.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const uploadStore = require("../uploadStore.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uploadstore-"));
}

const CONSENT = "consent-v1";

test("create: valid pending upload gets a token and pending status", () => {
  const dir = tmpDir();
  const rec = uploadStore.create(dir, { kind: "video", filename: "a.mp4", consentVersion: CONSENT });
  assert.equal(rec.status, "pending");
  assert.equal(rec.kind, "video");
  assert.equal(rec.thumbnailFilename, null);
  assert.equal(rec.postId, null);
  assert.equal(typeof rec.deleteToken, "string");
  assert.ok(rec.deleteToken.length >= 32);
  assert.deepEqual(uploadStore.read(dir, rec.id).id, rec.id);
});

test("create: rejects bad kind and missing consent", () => {
  const dir = tmpDir();
  assert.throws(() => uploadStore.create(dir, { kind: "audio", filename: "a", consentVersion: CONSENT }));
  assert.throws(() => uploadStore.create(dir, { kind: "video", filename: "a" }));
});

test("listPending: oldest first, with kind filter", () => {
  const dir = tmpDir();
  uploadStore.create(dir, { kind: "video", filename: "old.mp4", consentVersion: CONSENT, now: "2026-07-01T00:00:00Z" });
  uploadStore.create(dir, { kind: "video", filename: "new.mp4", consentVersion: CONSENT, now: "2026-07-20T00:00:00Z" });
  uploadStore.create(dir, { kind: "clipboard", filename: "c.png", consentVersion: CONSENT, now: "2026-07-10T00:00:00Z" });

  const allPending = uploadStore.listPending(dir);
  assert.deepEqual(allPending.map((r) => r.filename), ["old.mp4", "c.png", "new.mp4"]);

  const videos = uploadStore.listPending(dir, { kind: "video" });
  assert.deepEqual(videos.map((r) => r.filename), ["old.mp4", "new.mp4"]);
});

test("approve: pending → approved with published details; no double-approve", () => {
  const dir = tmpDir();
  const rec = uploadStore.create(dir, { kind: "video", filename: "raw.mp4", consentVersion: CONSENT });
  const approved = uploadStore.approve(dir, rec.id, {
    filename: `${rec.id}.mp4`,
    thumbnailFilename: `thumb-${rec.id}.png`,
    postId: "post-123",
    now: "2026-07-29T12:00:00Z"
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.filename, `${rec.id}.mp4`);
  assert.equal(approved.postId, "post-123");
  assert.equal(approved.moderatedAt, "2026-07-29T12:00:00.000Z");
  // A second approve is a no-op (returns null) because it is no longer pending.
  assert.equal(uploadStore.approve(dir, rec.id, { filename: "x.mp4" }), null);
});

test("reject: pending → rejected; rejecting a non-pending returns null", () => {
  const dir = tmpDir();
  const rec = uploadStore.create(dir, { kind: "video", filename: "raw.mp4", consentVersion: CONSENT });
  assert.equal(uploadStore.reject(dir, rec.id, {}).status, "rejected");
  assert.equal(uploadStore.reject(dir, rec.id, {}), null);
});

test("markDeleted: works from pending and approved, not from deleted", () => {
  const dir = tmpDir();
  const p = uploadStore.create(dir, { kind: "video", filename: "a.mp4", consentVersion: CONSENT });
  assert.equal(uploadStore.markDeleted(dir, p.id).status, "deleted");
  assert.equal(uploadStore.markDeleted(dir, p.id), null);

  const q = uploadStore.create(dir, { kind: "video", filename: "b.mp4", consentVersion: CONSENT });
  uploadStore.approve(dir, q.id, { filename: `${q.id}.mp4` });
  assert.equal(uploadStore.markDeleted(dir, q.id).status, "deleted");
});

test("findStale: only pending older than the cutoff, with an injected now", () => {
  const dir = tmpDir();
  uploadStore.create(dir, { kind: "video", filename: "ancient.mp4", consentVersion: CONSENT, now: "2026-06-01T00:00:00Z" });
  uploadStore.create(dir, { kind: "video", filename: "recent.mp4", consentVersion: CONSENT, now: "2026-07-28T00:00:00Z" });
  const now = "2026-07-29T00:00:00Z"; // 14-day cutoff => 2026-07-15
  const stale = uploadStore.findStale(dir, { staleDays: 14, now });
  assert.deepEqual(stale.map((r) => r.filename), ["ancient.mp4"]);
});

test("verifyDeleteToken: constant-time match, rejects wrong/empty", () => {
  const dir = tmpDir();
  const rec = uploadStore.create(dir, { kind: "video", filename: "a.mp4", consentVersion: CONSENT, deleteToken: "s3cr3t" });
  assert.equal(uploadStore.verifyDeleteToken(rec, "s3cr3t"), true);
  assert.equal(uploadStore.verifyDeleteToken(rec, "wrong"), false);
  assert.equal(uploadStore.verifyDeleteToken(rec, ""), false);
  assert.equal(uploadStore.verifyDeleteToken({}, "x"), false);
});

test("read: malformed id is rejected (path guard)", () => {
  const dir = tmpDir();
  assert.equal(uploadStore.read(dir, "not-a-uuid"), null);
});
