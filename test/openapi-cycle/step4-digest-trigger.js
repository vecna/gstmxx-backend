"use strict";

const assert = require("node:assert/strict");

/**
 * Step 4: trigger first digest execution for daily and weekly windows.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep4(t, cycle) {
  /** POST /api/digests/run executes due digest filters using explicit JSON body. */
  await t.test("POST /api/digests/run", async () => {
    cycle.hit("POST /api/digests/run");
    const payload = {
      force: true,
      now: "2026-07-30T12:00:00.000Z"
    };

    const res = await fetch(`${cycle.baseUrl}/api/digests/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: cycle.bearerHeader
      },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.results));
    cycle.digest.ranHandles = body.results.map((item) => item.handle);
  });
}

module.exports = { runStep4 };