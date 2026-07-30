"use strict";

const assert = require("node:assert/strict");

/**
 * Step 5: verify daily/weekly digest outputs are visible and queryable.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep5(t, cycle) {
  /** GET /api/posts confirms digest posts were materialized after trigger. */
  await t.test("GET /api/posts after digest", async () => {
    const res = await fetch(`${cycle.baseUrl}/api/posts`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const hasDaily = body.posts.some((post) => post.actor === "ghostyles-daily");
    const hasWeekly = body.posts.some((post) => post.actor === "ghostyles-weekly");

    assert.equal(cycle.digest.ranHandles.includes("ghostyles-daily"), true);
    assert.equal(cycle.digest.ranHandles.includes("ghostyles-weekly"), true);
    assert.equal(hasDaily || hasWeekly, true);
  });

  /** GET /feed/{name} returns digest actor feed when digest actor exists. */
  await t.test("GET /feed/{name} ghostyles-daily.xml", async () => {
    const res = await fetch(`${cycle.baseUrl}/feed/ghostyles-daily.xml`);
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /ghostyles-daily/);
  });
}

module.exports = { runStep5 };