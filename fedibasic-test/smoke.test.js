const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { after, before } = test;

const testDataDirectory = "/tmp/ghostmaxxing-fedify-browser-lab-test";
fs.rmSync(testDataDirectory, { recursive: true, force: true });
process.env.PORT = "4049";
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = "http://127.0.0.1:4049";
process.env.LAB_DATA_DIR = testDataDirectory;
process.env.LAB_POST_TOKEN = "smoke-test-token";

const { createApp } = require("../fedibasic-server.js");
let server;
const baseUrl = process.env.LAB_BASE_URL;

before(async () => {
  server = createApp().listen(4049, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDataDirectory, { recursive: true, force: true });
});

test("health endpoint works", async () => {
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

test("creates, persists, lists, and serves string posts", async () => {
  const content = "Line one\nLine two\nLiteral markup: <b>not executed here</b>";
  const created = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LAB_POST_TOKEN}`
    },
    body: JSON.stringify({ content, actor: "news", publish: false })
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.post.content, content);
  assert.equal(createdBody.post.actor, "news");
  assert.equal(createdBody.published, false);

  const storedPath = `${testDataDirectory}/posts/${createdBody.post.id}.json`;
  assert.equal(fs.existsSync(storedPath), true);
  const stored = JSON.parse(fs.readFileSync(storedPath, "utf8"));
  assert.equal(stored.content, content);
  assert.equal(stored.actor, "news");

  const listed = await fetch(`${baseUrl}/api/posts`);
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.ok, true);
  assert.ok(Array.isArray(listedBody.posts));
  assert.ok(listedBody.posts.some((post) => post.id === createdBody.post.id));

  const object = await fetch(createdBody.post.url, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(object.status, 200);
  assert.match(object.headers.get("content-type"), /application\/activity\+json/);
  const objectBody = await object.json();
  assert.equal(objectBody.type, "Note");
  assert.equal(
    objectBody.content,
    "<p>Line one<br>Line two<br>Literal markup: &lt;b&gt;not executed here&lt;/b&gt;</p>"
  );
  assert.equal(objectBody.attributedTo, `${baseUrl}/federation/actors/news`);
});

test("serves an image post and a pre-authorized cross-actor quote", async () => {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.LAB_POST_TOKEN}`
  };
  const originalResponse = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      actor: "clipboard",
      content: "Original picture",
      publish: false,
      attachment: {
        type: "Image",
        url: "https://example.com/test-picture.jpg",
        mediaType: "image/jpeg",
        name: "A picture used by the federation smoke test"
      }
    })
  });
  assert.equal(originalResponse.status, 201);
  const original = (await originalResponse.json()).post;

  const originalObjectResponse = await fetch(original.url, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(originalObjectResponse.status, 200);
  const originalObject = await originalObjectResponse.json();
  assert.equal(originalObject.attachment.type, "Image");
  assert.equal(
    originalObject.attachment.url,
    "https://example.com/test-picture.jpg"
  );
  assert.equal(
    originalObject.attachment.name,
    "A picture used by the federation smoke test"
  );

  const quoteResponse = await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      actor: "news",
      content: "Quoting from a different local actor",
      publish: false,
      quoteUrl: original.url
    })
  });
  assert.equal(quoteResponse.status, 201);
  const quote = (await quoteResponse.json()).post;
  assert.ok(quote.quoteAuthorizationUrl);

  const quoteObjectResponse = await fetch(quote.url, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(quoteObjectResponse.status, 200);
  const quoteObject = await quoteObjectResponse.json();
  assert.equal(quoteObject.quote, original.url);
  assert.equal(quoteObject.quoteUrl, original.url);
  assert.equal(quoteObject.quoteAuthorization, quote.quoteAuthorizationUrl);
  assert.match(quoteObject.content, /class="quote-inline"/);

  const authorizationResponse = await fetch(quote.quoteAuthorizationUrl, {
    headers: { Accept: "application/activity+json" }
  });
  assert.equal(authorizationResponse.status, 200);
  const authorization = await authorizationResponse.json();
  assert.equal(authorization.type, "QuoteAuthorization");
  assert.equal(authorization.interactingObject, quote.url);
  assert.equal(authorization.interactionTarget, original.url);
  assert.equal(
    authorization.attributedTo,
    `${baseUrl}/federation/actors/clipboard`
  );
});
