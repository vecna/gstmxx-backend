"use strict";

const assert = require("node:assert/strict");

/**
 * Step 9: remove produced uploads through API, then wipe runtime files not exposed by API.
 * @param {import("node:test").TestContext} t
 * @param {any} cycle
 */
async function runStep9(t, cycle) {
  /** DELETE /api/uploads/{id} removes approved video upload and linked post/media. */
  await t.test("DELETE /api/uploads/{id} (video)", async () => {
    cycle.hit("DELETE /api/uploads/{id}");
    const res = await fetch(`${cycle.baseUrl}/api/uploads/${cycle.uploads.approvedVideo.id}`, {
      method: "DELETE",
      headers: {
        "x-delete-token": cycle.uploads.approvedVideo.deleteToken
      }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  /** DELETE /api/uploads/{id} removes approved clipboard upload and linked post/media. */
  await t.test("DELETE /api/uploads/{id} (clipboard)", async () => {
    const res = await fetch(`${cycle.baseUrl}/api/uploads/${cycle.uploads.approvedClipboard.id}`, {
      method: "DELETE",
      headers: {
        "x-delete-token": cycle.uploads.approvedClipboard.deleteToken
      }
    });
    assert.equal(res.status, 200);
  });

  /** DELETE /api/uploads/{id} removes approved ghostyles upload and linked post/media. */
  await t.test("DELETE /api/uploads/{id} (ghostyles source)", async () => {
    const res = await fetch(`${cycle.baseUrl}/api/uploads/${cycle.uploads.ghostylesVideo.id}`, {
      method: "DELETE",
      headers: {
        "x-delete-token": cycle.uploads.ghostylesVideo.deleteToken
      }
    });
    assert.equal(res.status, 200);
  });

  /** Cleanup fallback for resources without delete APIs: restart on a clean runtime state. */
  await t.test("wipe runtime files and restart", async () => {
    await cycle.restartWithCleanState();
  });
}

module.exports = { runStep9 };