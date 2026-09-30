"use strict";

/**
 * What this file tests
 * --------------------
 * The third CLI's server side: storing a display name, biography, fields,
 * avatar and header, and having all of it appear in the `Person` document a
 * remote server actually reads. Plus the follow-related guarantee that made
 * Mastodon show "pending authorization": `manuallyApprovesFollowers: false`.
 *
 * How it tests it
 * ---------------
 * Boots the real app on an ephemeral port against a temp data/storage dir, then
 * drives the HTTP surface exactly as `manual-profile.js` does. Federation is a
 * no-op here (no followers), so this asserts stored state and rendering, not
 * delivery.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4072;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-profile-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-profile-store-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "profile-token";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const auth = { Authorization: "Bearer profile-token" };

let server;
const { before, after } = test;

before(async () => {
  server = createApp().listen(PORT, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

/** A one-pixel PNG: real bytes, so the content hash is real too. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function putProfile(body) {
  return fetch(`${base}/api/actors/video/profile`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("writing a profile requires the post token", async () => {
  const response = await fetch(`${base}/api/actors/video/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "nope" })
  });
  assert.equal(response.status, 401);
});

test("an unknown actor is a 404, not a silent write", async () => {
  const response = await fetch(`${base}/api/actors/not-an-actor/profile`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "x" })
  });
  assert.equal(response.status, 404);
});

test("plain-text biography becomes paragraphs with autolinked URLs", async () => {
  const response = await putProfile({
    displayName: "Ghostmaxxing / video",
    summaryText:
      "Face-recognition camouflage, tested in the open.\nEverything runs locally.\n\nLab: https://ghostmaxxing.vecna.eu/lab.html"
  });
  assert.equal(response.status, 200);
  const { profile } = await response.json();
  assert.equal(profile.displayName, "Ghostmaxxing / video");
  // Two blank-line-separated blocks become two paragraphs; the single newline
  // inside the first becomes a <br>.
  assert.match(profile.summaryHtml, /^<p>/);
  assert.match(profile.summaryHtml, /<br>/);
  assert.match(
    profile.summaryHtml,
    /<a href="https:\/\/ghostmaxxing\.vecna\.eu\/lab\.html"/
  );
});

test("biography HTML is reduced to the tags a fediverse client renders", async () => {
  const response = await putProfile({
    summaryHtml:
      '<p>safe <strong>bold</strong> <script>alert(1)</script><img src=x onerror=y> <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">good</a></p>'
  });
  assert.equal(response.status, 200);
  const { profile } = await response.json();
  assert.doesNotMatch(profile.summaryHtml, /<script|<img|onerror|javascript:/i);
  assert.match(profile.summaryHtml, /<strong>bold<\/strong>/);
  assert.match(profile.summaryHtml, /<a href="https:\/\/ok\.example\/?"/);
  // The disallowed tags are dropped but their text survives.
  assert.match(profile.summaryHtml, /alert\(1\)/);
});

test("profile fields render URLs as links and cap at four", async () => {
  const ok = await putProfile({
    fields: [
      { name: "Lab", value: "https://ghostmaxxing.vecna.eu/lab.html" },
      { name: "Contact", value: "plain text" }
    ]
  });
  assert.equal(ok.status, 200);
  const { profile } = await ok.json();
  assert.equal(profile.fields.length, 2);
  assert.match(profile.fields[0].value, /^<a href="https:\/\/ghostmaxxing/);
  assert.equal(profile.fields[1].value, "plain text");

  const tooMany = await putProfile({
    fields: Array.from({ length: 5 }, (_, index) => ({
      name: `f${index}`,
      value: `v${index}`
    }))
  });
  assert.equal(tooMany.status, 400);
});

test("avatar upload is content-addressed and served back with a long cache", async () => {
  const upload = await fetch(`${base}/api/actors/video/media/avatar`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/png" },
    body: PNG_BYTES
  });
  assert.equal(upload.status, 200);
  const { media } = await upload.json();
  assert.match(media.file, /^video-avatar-[0-9a-f]{12}\.png$/);
  assert.equal(media.bytes, PNG_BYTES.length);

  const fetched = await fetch(`${base}/api/actors/video/media/${media.file}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.match(fetched.headers.get("cache-control"), /immutable/);
  assert.equal(Buffer.from(await fetched.arrayBuffer()).length, PNG_BYTES.length);

  // Same bytes, same URL: remote servers cache avatars by URL, so this is what
  // makes a genuine change visible and a re-upload of the same image a no-op.
  const again = await fetch(`${base}/api/actors/video/media/avatar`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/png" },
    body: PNG_BYTES
  });
  assert.equal((await again.json()).media.file, media.file);
});

test("SVG and oversized images are refused with a usable message", async () => {
  const svg = await fetch(`${base}/api/actors/video/media/avatar`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/svg+xml" },
    body: Buffer.from("<svg/>")
  });
  assert.ok(svg.status >= 400, `expected a rejection, got ${svg.status}`);
});

test("one actor's media cannot be fetched through another actor's path", async () => {
  const upload = await fetch(`${base}/api/actors/news/media/header`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/png" },
    body: PNG_BYTES
  });
  const { media } = await upload.json();
  const crossed = await fetch(`${base}/api/actors/video/media/${media.file}`);
  assert.equal(crossed.status, 404);
});

test("the Person document carries the profile and auto-accepts follows", async () => {
  // Restate the biography: the sanitiser test above deliberately overwrote it.
  await putProfile({
    displayName: "Ghostmaxxing / video",
    summaryText: "Camouflage, tested in the open.\n\nLab: https://ghostmaxxing.vecna.eu/lab.html"
  });
  await fetch(`${base}/api/actors/video/media/header`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "image/png" },
    body: Buffer.concat([PNG_BYTES, Buffer.from([0])])
  });

  const response = await fetch(`${base}/federation/actors/video`, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(response.status, 200);
  const actor = await response.json();

  assert.equal(actor.name, "Ghostmaxxing / video");
  assert.match(actor.summary, /<a href="https:\/\/ghostmaxxing/);
  assert.equal(actor.icon.type, "Image");
  assert.match(actor.icon.url, /\/api\/actors\/video\/media\/video-avatar-/);
  assert.equal(actor.image.type, "Image");
  assert.match(actor.image.url, /\/api\/actors\/video\/media\/video-header-/);

  // The reason Mastodon showed "pending authorization": without this flag a
  // client has to guess, and it guesses conservatively.
  assert.equal(actor.manuallyApprovesFollowers, false);

  const attachments = [].concat(actor.attachment || []);
  assert.equal(attachments.length, 2);
  assert.equal(attachments[0].type, "PropertyValue");
});

test("preview returns exactly what the actor endpoint serves", async () => {
  const preview = await (
    await fetch(`${base}/api/actors/video/preview`)
  ).json();
  const live = await (
    await fetch(`${base}/federation/actors/video`, {
      headers: { Accept: "application/activity+json" }
    })
  ).json();
  assert.equal(preview.actor.name, live.name);
  assert.equal(preview.actor.summary, live.summary);
  assert.equal(preview.actor.icon.url, live.icon.url);
});

test("clearing removes the image and prunes the bytes", async () => {
  const before = await (
    await fetch(`${base}/api/actors/video/profile`)
  ).json();
  assert.ok(before.profile.avatar.file);

  const cleared = await fetch(`${base}/api/actors/video/media/avatar`, {
    method: "DELETE",
    headers: auth
  });
  assert.equal(cleared.status, 200);

  const after = await (await fetch(`${base}/api/actors/video/profile`)).json();
  assert.equal(after.profile.avatar, undefined);

  const gone = await fetch(
    `${base}/api/actors/video/media/${before.profile.avatar.file}`
  );
  assert.equal(gone.status, 404);
});

test("a patch leaves untouched keys alone", async () => {
  await putProfile({ displayName: "Renamed" });
  const { profile } = await (
    await fetch(`${base}/api/actors/video/profile`)
  ).json();
  assert.equal(profile.displayName, "Renamed");
  assert.ok(profile.summaryHtml, "the biography survived a name-only patch");
  assert.ok(profile.fields.length, "the fields survived a name-only patch");
});

test("publishing with no followers succeeds and reports zero", async () => {
  const response = await fetch(`${base}/api/actors/video/publish`, {
    method: "POST",
    headers: auth
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.delivery.followers, 0);
  assert.equal(body.delivery.delivered, 0);
});

test("diagnostics name the origin problem before a remote server does", async () => {
  const response = await fetch(`${base}/api/federation/diagnostics`, {
    headers: auth
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  // The suite runs on loopback, which is exactly the production misconfiguration.
  assert.equal(body.origin.private, true);
  assert.equal(body.canFederate, false);
  assert.match(body.reason, /GSTMXX_PUBLIC_URL/);

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.federation.canFederate, false);
  assert.equal(health.federation.originIsPrivate, true);
});
