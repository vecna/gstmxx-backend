"use strict";

const assert = require("node:assert/strict");

/**
 * Step 6: publish 10 randomized news entries via admin composer API.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep6(t, cycle) {
  /** POST /api/admin/compose publishes staff-authored news with explicit multipart payloads. */
  await t.test("POST /api/admin/compose (10 random news)", async () => {
    cycle.hit("POST /api/admin/compose");

    for (let i = 0; i < 10; i += 1) {
      const randomPart = Math.random().toString(36).slice(2, 10);
      const title = `Admin random news ${i + 1} ${randomPart}`;
      const form = new FormData();
      form.set("actor", "news");
      form.set("title", title);
      form.set("subtitle", `Subtitle ${randomPart}`);
      form.set("content", `This is generated admin news #${i + 1} (${randomPart}).`);

      const res = await fetch(`${cycle.baseUrl}/api/admin/compose`, {
        method: "POST",
        headers: { authorization: cycle.adminHeader },
        body: form
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      cycle.posts.newsPostIds.push(body.post.id);
    }

    assert.equal(cycle.posts.newsPostIds.length, 10);
  });
}

module.exports = { runStep6 };