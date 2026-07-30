"use strict";

const assert = require("node:assert/strict");

/**
 * Step 7: verify news propagation through web and index surfaces.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep7(t, cycle) {
  /** GET /latest exposes recent news items on the web page. */
  await t.test("GET /latest", async () => {
    cycle.hit("GET /latest");
    const res = await fetch(`${cycle.baseUrl}/latest`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Admin random news/);
  });

  /** GET /latest/archive exposes the full historical news archive. */
  await t.test("GET /latest/archive", async () => {
    cycle.hit("GET /latest/archive");
    const res = await fetch(`${cycle.baseUrl}/latest/archive`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Admin random news/);
  });

  /** GET /latest/index.json exposes searchable news index entries. */
  await t.test("GET /latest/index.json", async () => {
    cycle.hit("GET /latest/index.json");
    const res = await fetch(`${cycle.baseUrl}/latest/index.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.length >= 10);
  });
}

module.exports = { runStep7 };