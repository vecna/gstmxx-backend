"use strict";

const assert = require("node:assert/strict");

/**
 * Step 3: verify content visibility across web, ActivityPub, RSS, and post APIs.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep3(t, cycle) {
  /** GET /api/posts lists all publicly visible post records. */
  await t.test("GET /api/posts", async () => {
    cycle.hit("GET /api/posts");
    const res = await fetch(`${cycle.baseUrl}/api/posts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.posts.length >= 3);
  });

  /** POST /api/posts creates a direct API post using explicit JSON payload. */
  await t.test("POST /api/posts", async () => {
    cycle.hit("POST /api/posts");
    const payload = {
      actor: "news",
      content: "API-created text post for announcement checks",
      publish: false
    };

    const res = await fetch(`${cycle.baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: cycle.bearerHeader
      },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.posts.apiTextPostId = body.post.id;
    cycle.posts.apiTextPostUrl = body.post.url;
  });

  /** GET /api/posts/{id} returns one stored post in JSON format. */
  await t.test("GET /api/posts/{id}", async () => {
    cycle.hit("GET /api/posts/{id}");
    const res = await fetch(`${cycle.baseUrl}/api/posts/${cycle.posts.apiTextPostId}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.post.id, cycle.posts.apiTextPostId);
  });

  /** POST /api/posts/{id}/announce announces an existing post to followers. */
  await t.test("POST /api/posts/{id}/announce", async () => {
    cycle.hit("POST /api/posts/{id}/announce");
    const res = await fetch(
      `${cycle.baseUrl}/api/posts/${cycle.posts.apiTextPostId}/announce`,
      {
        method: "POST",
        headers: {
          authorization: cycle.bearerHeader
        }
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.published, true);
  });

  /** GET /posts/{id} serves HTML when no ActivityPub Accept header is provided. */
  await t.test("GET /posts/{id} as HTML", async () => {
    cycle.hit("GET /posts/{id}");
    const res = await fetch(`${cycle.baseUrl}/posts/${cycle.posts.apiTextPostId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
  });

  /** GET /posts/{id} serves ActivityPub JSON when Accept requests it. */
  await t.test("GET /posts/{id} as ActivityPub", async () => {
    const res = await fetch(`${cycle.baseUrl}/posts/${cycle.posts.apiTextPostId}`, {
      headers: {
        accept: "application/activity+json"
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "Note");
  });

  /** POST /api/posts with quoteUrl creates cross-actor quote authorization metadata. */
  await t.test("POST /api/posts with quoteUrl", async () => {
    const payload = {
      actor: "news",
      content: "Quoting clipboard post from another local actor",
      publish: false,
      quoteUrl: `${cycle.baseUrl}/posts/${cycle.uploads.approvedClipboard.postId}`
    };

    const res = await fetch(`${cycle.baseUrl}/api/posts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: cycle.bearerHeader
      },
      body: JSON.stringify(payload)
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    cycle.posts.quotedPostId = body.post.id;
    cycle.posts.quotedPostUrl = body.post.url;
    cycle.posts.quoteAuthorizationUrl = body.post.quoteAuthorizationUrl;
    assert.ok(cycle.posts.quoteAuthorizationUrl);
  });

  /** GET /quote-authorizations/{postId} returns local FEP-044f authorization object. */
  await t.test("GET /quote-authorizations/{postId}", async () => {
    cycle.hit("GET /quote-authorizations/{postId}");
    const res = await fetch(
      `${cycle.baseUrl}/quote-authorizations/${cycle.posts.quotedPostId}`,
      { headers: { accept: "application/activity+json" } }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.type, "QuoteAuthorization");
  });

  /** GET /feed/{name} returns RSS XML for the merged all.xml feed. */
  await t.test("GET /feed/{name} all.xml", async () => {
    cycle.hit("GET /feed/{name}");
    const res = await fetch(`${cycle.baseUrl}/feed/all.xml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/rss\+xml/);
    const xml = await res.text();
    assert.match(xml, /<rss/);
  });
}

module.exports = { runStep3 };