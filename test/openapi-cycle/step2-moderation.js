"use strict";

const assert = require("node:assert/strict");

/**
 * Step 2: simulate admin moderation, including allow and deny paths.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep2(t, cycle) {
  /** GET /api/admin/ validates that the moderation dashboard is reachable. */
  await t.test("GET /api/admin/", async () => {
    cycle.hit("GET /api/admin/");
    const res = await fetch(`${cycle.baseUrl}/api/admin/`, {
      headers: { Authorization: cycle.adminHeader }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });

  /** GET /api/admin/compose validates that staff composer UI is reachable. */
  await t.test("GET /api/admin/compose", async () => {
    cycle.hit("GET /api/admin/compose");
    const res = await fetch(`${cycle.baseUrl}/api/admin/compose`, {
      headers: { Authorization: cycle.adminHeader }
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });

  /** GET /api/admin/pending returns pending queue items before moderation. */
  await t.test("GET /api/admin/pending", async () => {
    cycle.hit("GET /api/admin/pending");
    const res = await fetch(`${cycle.baseUrl}/api/admin/pending`, {
      headers: { Authorization: cycle.adminHeader }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.pending.length >= 4);
  });

  /** GET /api/admin/media/{id} previews one pending media file. */
  await t.test("GET /api/admin/media/{id}", async () => {
    cycle.hit("GET /api/admin/media/{id}");
    const res = await fetch(
      `${cycle.baseUrl}/api/admin/media/${cycle.uploads.approvedVideo.id}`,
      { headers: { Authorization: cycle.adminHeader } }
    );
    assert.equal(res.status, 200);
  });

  /** POST /api/admin/approve/{id} approves uploaded video and publishes it. */
  await t.test("POST /api/admin/approve/{id} (video)", async () => {
    cycle.hit("POST /api/admin/approve/{id}");
    const res = await fetch(
      `${cycle.baseUrl}/api/admin/approve/${cycle.uploads.approvedVideo.id}`,
      {
        method: "POST",
        headers: { Authorization: cycle.adminHeader }
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    cycle.uploads.approvedVideo.media = body.media;
    cycle.uploads.approvedVideo.thumbnail = body.thumbnail;
    cycle.uploads.approvedVideo.postId = body.post.id;
    cycle.uploads.approvedVideo.publicUrl = body.publicUrl;
  });

  /** POST /api/admin/approve/{id} approves uploaded clipboard PNG and publishes it. */
  await t.test("POST /api/admin/approve/{id} (clipboard)", async () => {
    const res = await fetch(
      `${cycle.baseUrl}/api/admin/approve/${cycle.uploads.approvedClipboard.id}`,
      {
        method: "POST",
        headers: { Authorization: cycle.adminHeader }
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    cycle.uploads.approvedClipboard.media = body.media;
    cycle.uploads.approvedClipboard.postId = body.post.id;
    cycle.uploads.approvedClipboard.publicUrl = body.publicUrl;
  });

  /** POST /api/admin/approve/{id} approves the ghostyles source post for digest input. */
  await t.test("POST /api/admin/approve/{id} (ghostyles source)", async () => {
    const res = await fetch(
      `${cycle.baseUrl}/api/admin/approve/${cycle.uploads.ghostylesVideo.id}`,
      {
        method: "POST",
        headers: { Authorization: cycle.adminHeader }
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    cycle.uploads.ghostylesVideo.postId = body.post.id;
  });

  /** POST /api/admin/reject/{id} denies one upload and removes it from queue. */
  await t.test("POST /api/admin/reject/{id}", async () => {
    cycle.hit("POST /api/admin/reject/{id}");
    const res = await fetch(
      `${cycle.baseUrl}/api/admin/reject/${cycle.uploads.rejectedVideo.id}`,
      {
        method: "POST",
        headers: { Authorization: cycle.adminHeader }
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
}

module.exports = { runStep2 };