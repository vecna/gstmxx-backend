"use strict";

const assert = require("node:assert/strict");

function pngBlob() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = Buffer.concat([signature, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
  return new Blob([payload], { type: "image/png" });
}

function fakeVideoBlob() {
  return new Blob([Buffer.from([0, 1, 2, 3, 4, 5])], { type: "video/mp4" });
}

/**
 * Step 1: verify base/system APIs and simulate users uploading all supported media kinds.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep1(t, cycle) {
  /** GET / serves the public lab index HTML. */
  await t.test("GET /", async () => {
    cycle.hit("GET /");
    const res = await fetch(`${cycle.baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });

  /** GET /lab serves the lab mount HTML. */
  await t.test("GET /lab", async () => {
    cycle.hit("GET /lab");
    const res = await fetch(`${cycle.baseUrl}/lab`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });

  /** GET /healthz returns actor/filter runtime health. */
  await t.test("GET /healthz", async () => {
    cycle.hit("GET /healthz");
    const res = await fetch(`${cycle.baseUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.actors));
  });

  /** GET /api/config returns browser/runtime config. */
  await t.test("GET /api/config", async () => {
    cycle.hit("GET /api/config");
    const res = await fetch(`${cycle.baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.configuredBaseUrl, cycle.baseUrl);
  });

  /** GET /api/openapi.json serves the API schema consumed by this cycle. */
  await t.test("GET /api/openapi.json", async () => {
    cycle.hit("GET /api/openapi.json");
    const res = await fetch(`${cycle.baseUrl}/api/openapi.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.openapi, "3.1.0");
  });

  /** GET /api/docs serves Swagger UI HTML. */
  await t.test("GET /api/docs", async () => {
    cycle.hit("GET /api/docs");
    const res = await fetch(`${cycle.baseUrl}/api/docs`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /SwaggerUIBundle/);
  });

  /** POST /api/uploads accepts a user video upload into moderation queue. */
  await t.test("POST /api/uploads (video)", async () => {
    cycle.hit("POST /api/uploads");
    const form = new FormData();
    form.set("video", fakeVideoBlob(), "user-video.mp4");
    form.set("kind", "video");
    form.set("consent_version", "consent-v1");
    form.set("user_note", "video for approval");

    const res = await fetch(`${cycle.baseUrl}/api/uploads`, {
      method: "POST",
      body: form
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.uploads.approvedVideo = {
      id: body.uploadId,
      deleteToken: body.deleteToken
    };
  });

  /** POST /api/uploads accepts a clipboard PNG upload into moderation queue. */
  await t.test("POST /api/uploads (clipboard)", async () => {
    const form = new FormData();
    form.set("video", pngBlob(), "clip.png");
    form.set("kind", "clipboard");
    form.set("consent_version", "consent-v1");
    form.set("user_note", "clipboard for approval");

    const res = await fetch(`${cycle.baseUrl}/api/uploads`, {
      method: "POST",
      body: form
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.uploads.approvedClipboard = {
      id: body.uploadId,
      deleteToken: body.deleteToken
    };
  });

  /** POST /api/uploads accepts a ghostyles-tagged upload to feed digest filters. */
  await t.test("POST /api/uploads (ghostyles source)", async () => {
    const form = new FormData();
    form.set("video", fakeVideoBlob(), "ghostyle.mp4");
    form.set("kind", "video");
    form.set("consent_version", "consent-v1");
    form.set("ghostyle_id", "brush-demo");
    form.set("user_note", "ghostyles digest candidate");

    const res = await fetch(`${cycle.baseUrl}/api/uploads`, {
      method: "POST",
      body: form
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.uploads.ghostylesVideo = {
      id: body.uploadId,
      deleteToken: body.deleteToken
    };
  });

  /** POST /api/uploads accepts a video that moderation will reject later. */
  await t.test("POST /api/uploads (to reject)", async () => {
    const form = new FormData();
    form.set("video", fakeVideoBlob(), "reject-me.mp4");
    form.set("kind", "video");
    form.set("consent_version", "consent-v1");
    form.set("user_note", "video for rejection");

    const res = await fetch(`${cycle.baseUrl}/api/uploads`, {
      method: "POST",
      body: form
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.uploads.rejectedVideo = {
      id: body.uploadId,
      deleteToken: body.deleteToken
    };
  });
}

module.exports = { runStep1 };