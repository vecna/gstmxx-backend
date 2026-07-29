"use strict";

/**
 * What this file tests
 * --------------------
 * The `/latest` aggregator served by Node: the newest 5 news appear (not more,
 * no "see more"), the archive holds all of them, the search index lists every
 * item, and publishing a new news post refreshes `/latest` immediately
 * (event-driven cache invalidation).
 *
 * How it tests it
 * ---------------
 * Boots the real app and authors news through the composer. No ffmpeg needed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 4071;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-data-"));
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-storage-"));

process.env.NODE_ENV = "test";
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.LAB_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.LAB_DATA_DIR = dataDir;
process.env.GSTMXX_STORAGE_DIR = storageDir;
process.env.LAB_POST_TOKEN = "latest-token";
process.env.GSTMXX_ADMIN_USER = "mod";
process.env.GSTMXX_ADMIN_PASS = "secret";

const { createApp } = require("../server.js");
const base = process.env.LAB_BASE_URL;
const auth = "Basic " + Buffer.from("mod:secret").toString("base64");

let server;
const { before, after } = test;
before(async () => {
  server = createApp().listen(PORT, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(storageDir, { recursive: true, force: true });
});

async function publishNews(title) {
  const form = new FormData();
  form.set("actor", "news");
  form.set("title", title);
  form.set("content", `Body of ${title}. ` + "word ".repeat(50));
  const res = await fetch(`${base}/api/admin/compose`, { method: "POST", headers: { Authorization: auth }, body: form });
  assert.equal(res.status, 201);
}

test("latest shows the newest 5, archive shows all, index lists all", async () => {
  for (let i = 1; i <= 6; i += 1) {
    await publishNews(`News number ${i}`);
    await new Promise((r) => setTimeout(r, 5)); // keep createdAt ordering distinct
  }

  const latest = await (await fetch(`${base}/latest`)).text();
  assert.match(latest, /News number 6/);
  assert.match(latest, /News number 2/);
  assert.ok(!latest.includes("News number 1"), "the 6th-oldest should not be on /latest");
  assert.match(latest, /Older news \(1 more\)/);
  assert.match(latest, /class="latest-toc"/);
  assert.match(latest, /min read/);

  const archive = await (await fetch(`${base}/latest/archive`)).text();
  assert.match(archive, /News number 1/);
  assert.match(archive, /News number 6/);

  const index = await (await fetch(`${base}/latest/index.json`)).json();
  assert.equal(index.length, 6);
  assert.ok(index.every((n) => typeof n.readingTime === "number" && n.title));
});

test("publishing new news refreshes /latest immediately", async () => {
  const before = await (await fetch(`${base}/latest`)).text();
  assert.ok(!before.includes("Breaking headline"));
  await publishNews("Breaking headline");
  const after = await (await fetch(`${base}/latest`)).text();
  assert.match(after, /Breaking headline/);
});
