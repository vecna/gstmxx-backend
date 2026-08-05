"use strict";

/**
 * What this file tests
 * --------------------
 * The exact production failure: with a loopback public origin and a real remote
 * follower, publishing used to end as
 *
 *   500 ... 401 Unauthorized {"error":"Requests to private network addresses
 *   are disallowed (tried to query Mastodon::PrivateNetworkAddressError on
 *   http://127.0.0.1:4040/federation/actors/video#main-key)"}
 *
 * The post was already on disk, so a 500 threw away the id the operator needed
 * in order to retry, and the message pointed at the *remote* rather than at the
 * one-line misconfiguration that caused it.
 *
 * How it tests it
 * ---------------
 * Boots the app on loopback (which is the misconfiguration), plants a follower
 * whose inbox is on a public host, and asserts the new contract: creation still
 * answers 201 with the post id, the delivery report says why nothing went out,
 * and an explicit announce — where delivery *is* the request — answers 502.
 * No network call is made: the preflight refuses before any request leaves.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4073;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-origin-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-origin-store-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "origin-token";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const auth = { Authorization: "Bearer origin-token" };

let server;
const { before, after } = test;

before(async () => {
  server = createApp().listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  // A follower on a real, public instance — the shape the follower store had
  // when the production 500 happened.
  fs.writeFileSync(
    path.join(dataDir, "followers.json"),
    JSON.stringify({
      video: [
        {
          actorId: "https://retro.pizza/users/vecna",
          inboxUrl: "https://retro.pizza/inbox",
          createdAt: new Date().toISOString()
        }
      ]
    })
  );
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

async function createPost(publish) {
  const response = await fetch(`${base}/api/posts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "test ciao ciao ciao CLI 2", actor: "video", publish })
  });
  return { status: response.status, body: await response.json() };
}

test("publishing to a public follower from a loopback origin no longer 500s", async () => {
  const { status, body } = await createPost(true);

  // The post is durable the moment it is written; the network is a later fact.
  assert.equal(status, 201);
  assert.equal(body.ok, true);
  assert.ok(body.post.id, "the operator still gets the post id to retry with");

  assert.equal(body.delivery.ok, false);
  assert.equal(body.delivery.code, "PRIVATE_ORIGIN");
  assert.equal(body.delivery.delivered, 0);
  assert.equal(body.delivery.followers, 1);
});

test("the reason names the origin, the key id and the variable to set", async () => {
  const { body } = await createPost(true);
  const reason = body.delivery.error;
  assert.match(reason, new RegExp(`http://127\\.0\\.0\\.1:${PORT}`));
  assert.match(reason, /#main-key/);
  assert.match(reason, /retro\.pizza/);
  assert.match(reason, /GSTMXX_PUBLIC_URL/);
});

test("the post survives the failed delivery and is readable", async () => {
  const { body } = await createPost(true);
  const stored = await fetch(`${base}/api/posts/${body.post.id}`);
  assert.equal(stored.status, 200);
  assert.equal((await stored.json()).post.content, "test ciao ciao ciao CLI 2");
});

test("an explicit announce is an error, because delivery *is* the request", async () => {
  const { body } = await createPost(false);
  const response = await fetch(`${base}/api/posts/${body.post.id}/announce`, {
    method: "POST",
    headers: auth
  });
  assert.equal(response.status, 502);
  const announced = await response.json();
  assert.equal(announced.ok, false);
  assert.match(announced.message, /GSTMXX_PUBLIC_URL/);
});

test("delivery to a follower on the same private network still works", async () => {
  // Two loopback processes talking to each other is a legitimate local test and
  // must not be caught by the guard. There is nothing listening on 4999, so the
  // send fails at the socket — the point is that it was *attempted*.
  fs.writeFileSync(
    path.join(dataDir, "followers.json"),
    JSON.stringify({
      news: [
        {
          actorId: "http://127.0.0.1:4999/users/peer",
          inboxUrl: "http://127.0.0.1:4999/inbox",
          createdAt: new Date().toISOString()
        }
      ]
    })
  );
  const response = await fetch(`${base}/api/posts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "local peer", actor: "news", publish: true })
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.notEqual(
    body.delivery.code,
    "PRIVATE_ORIGIN",
    "a loopback-to-loopback send must not be pre-emptively refused"
  );
});

test("diagnostics list the follower inboxes that cannot be reached", async () => {
  fs.writeFileSync(
    path.join(dataDir, "followers.json"),
    JSON.stringify({
      video: [
        {
          actorId: "https://retro.pizza/users/vecna",
          inboxUrl: "https://retro.pizza/inbox",
          createdAt: new Date().toISOString()
        }
      ]
    })
  );
  const body = await (
    await fetch(`${base}/api/federation/diagnostics`, { headers: auth })
  ).json();
  assert.equal(body.canFederate, false);
  assert.equal(body.followerCount, 1);
  assert.deepEqual(body.undeliverableInboxes, ["https://retro.pizza/inbox"]);
});
