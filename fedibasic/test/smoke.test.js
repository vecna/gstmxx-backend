import assert from "node:assert/strict";
import test, { after, before } from "node:test";

process.env.PORT = "4049";
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = "http://127.0.0.1:4049";
process.env.LAB_DATA_DIR = "/tmp/ghostmaxxing-fedify-browser-lab-test";

const { createApp } = await import("../server.js");
let server;
const baseUrl = process.env.LAB_BASE_URL;

before(async () => {
  server = createApp().listen(4049, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("browser page and health endpoint work", async () => {
  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Fedify browser lab/);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual((await health.json()).actors, [
    "video",
    "ghostyles",
    "news",
    "clipboard"
  ]);
});

test("WebFinger and actor JSON work over real HTTP", async () => {
  const webfinger = await fetch(
    `${baseUrl}/.well-known/webfinger?resource=${encodeURIComponent("acct:video@127.0.0.1:4049")}`,
    { headers: { Accept: "application/jrd+json" } }
  );
  assert.equal(webfinger.status, 200);
  assert.ok(Array.isArray((await webfinger.json()).links));

  const actor = await fetch(`${baseUrl}/federation/actors/video`, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(actor.status, 200);
  const body = await actor.json();
  assert.equal(body.preferredUsername, "video");
  assert.ok(body.publicKey);
});

test("browser announce endpoint constructs a Create", async () => {
  const response = await fetch(`${baseUrl}/api/announce/news`, {
    method: "POST"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    actor: "news",
    object: `${baseUrl}/static/news.json`,
    followers: 0
  });
});
