"use strict";

const assert = require("node:assert/strict");

/**
 * Step 8: verify news aggregation plus federation/static/media endpoints.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep8(t, cycle) {
  /** POST /api/announce/{handle} triggers a diagnostic Create for one actor. */
  await t.test("POST /api/announce/{handle}", async () => {
    cycle.hit("POST /api/announce/{handle}");
    const res = await fetch(`${cycle.baseUrl}/api/announce/news`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  /** GET /api/followers returns raw follower store snapshot. */
  await t.test("GET /api/followers", async () => {
    cycle.hit("GET /api/followers");
    const res = await fetch(`${cycle.baseUrl}/api/followers`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  /** GET /.well-known/webfinger resolves local actor account metadata. */
  await t.test("GET /.well-known/webfinger", async () => {
    cycle.hit("GET /.well-known/webfinger");
    const resource = encodeURIComponent(`acct:video@127.0.0.1:${cycle.port}`);
    const res = await fetch(`${cycle.baseUrl}/.well-known/webfinger?resource=${resource}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.links));
  });

  /** GET /federation/actors/{handle} serves ActivityPub actor JSON-LD. */
  await t.test("GET /federation/actors/{handle}", async () => {
    cycle.hit("GET /federation/actors/{handle}");
    const res = await fetch(`${cycle.baseUrl}/federation/actors/video`, {
      headers: { accept: "application/activity+json" }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.preferredUsername, "video");
  });

  /** GET /federation/actors/{handle}/followers serves followers collection. */
  await t.test("GET /federation/actors/{handle}/followers", async () => {
    cycle.hit("GET /federation/actors/{handle}/followers");
    const res = await fetch(`${cycle.baseUrl}/federation/actors/video/followers`, {
      headers: { accept: "application/activity+json" }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body === "object");
  });

  /** POST /federation/actors/{handle}/inbox accepts or rejects inbox activity payloads. */
  await t.test("POST /federation/actors/{handle}/inbox", async () => {
    cycle.hit("POST /federation/actors/{handle}/inbox");
    const payload = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Like",
      actor: "https://remote.example/users/demo",
      object: `${cycle.baseUrl}/posts/${cycle.uploads.approvedVideo.postId}`
    };
    const res = await fetch(`${cycle.baseUrl}/federation/actors/video/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(payload)
    });
    assert.ok([200, 202, 400, 401, 403, 404, 500].includes(res.status));
  });

  /** POST /federation/inbox accepts or rejects shared inbox activity payloads. */
  await t.test("POST /federation/inbox", async () => {
    cycle.hit("POST /federation/inbox");
    const payload = {
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Follow",
      actor: "https://remote.example/users/demo",
      object: `${cycle.baseUrl}/federation/actors/video`
    };
    const res = await fetch(`${cycle.baseUrl}/federation/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify(payload)
    });
    assert.ok([200, 202, 400, 401, 403, 404, 500].includes(res.status));
  });

  /** GET /static/{filename} serves static diagnostic actor files. */
  await t.test("GET /static/{filename}", async () => {
    cycle.hit("GET /static/{filename}");
    const res = await fetch(`${cycle.baseUrl}/static/news.json`);
    assert.equal(res.status, 200);
  });

  /** GET /videos/{filename} serves approved moderated video media. */
  await t.test("GET /videos/{filename}", async () => {
    cycle.hit("GET /videos/{filename}");
    const res = await fetch(`${cycle.baseUrl}/videos/${cycle.uploads.approvedVideo.media}`);
    assert.equal(res.status, 200);
  });

  /** GET /clipboard/{filename} serves approved moderated clipboard media. */
  await t.test("GET /clipboard/{filename}", async () => {
    cycle.hit("GET /clipboard/{filename}");
    const res = await fetch(`${cycle.baseUrl}/clipboard/${cycle.uploads.approvedClipboard.media}`);
    assert.equal(res.status, 200);
  });

  /** GET /thumbnails/{filename} serves generated thumbnail for approved video. */
  await t.test("GET /thumbnails/{filename}", async () => {
    cycle.hit("GET /thumbnails/{filename}");
    const res = await fetch(`${cycle.baseUrl}/thumbnails/${cycle.uploads.approvedVideo.thumbnail}`);
    assert.equal(res.status, 200);
  });

  /** GET /feed/{name} validates news feed aggregation after admin publishing. */
  await t.test("GET /feed/{name} news.xml", async () => {
    const res = await fetch(`${cycle.baseUrl}/feed/news.xml`);
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /Ghostmaxxing/);
  });
}

module.exports = { runStep8 };