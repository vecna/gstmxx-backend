"use strict";

const assert = require("node:assert/strict");

async function fetchWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

/**
 * Step 10: reconnect after cleanup and verify exposed state is empty.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep10(t, cycle) {
  /** GET /api/posts should be empty after cleanup and restart. */
  await t.test("GET /api/posts empty", async () => {
    const res = await fetchWithRetry(`${cycle.baseUrl}/api/posts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.posts, []);
  });

  /** GET /api/admin/pending should be empty after cleanup and restart. */
  await t.test("GET /api/admin/pending empty", async () => {
    const res = await fetchWithRetry(`${cycle.baseUrl}/api/admin/pending`, {
      headers: { authorization: cycle.adminHeader }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.pending, []);
  });

  /** GET /latest should render an empty latest surface after cleanup and restart. */
  await t.test("GET /latest empty state", async () => {
    const res = await fetchWithRetry(`${cycle.baseUrl}/latest`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /No news yet\.|News archive/);
  });

  /** GET /latest/index.json should be empty after cleanup and restart. */
  await t.test("GET /latest/index.json empty", async () => {
    const res = await fetchWithRetry(`${cycle.baseUrl}/latest/index.json`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
  });
}

module.exports = { runStep10 };