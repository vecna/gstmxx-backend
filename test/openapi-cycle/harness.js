"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const EXPECTED_OPERATIONS = Object.freeze([
  "GET /",
  "GET /lab",
  "GET /healthz",
  "GET /api/config",
  "GET /api/openapi.json",
  "GET /api/docs",
  "GET /api/followers",
  "POST /api/uploads",
  "DELETE /api/uploads/{id}",
  "GET /api/admin/",
  "GET /api/admin/pending",
  "GET /api/admin/media/{id}",
  "POST /api/admin/approve/{id}",
  "POST /api/admin/reject/{id}",
  "GET /api/admin/compose",
  "POST /api/admin/compose",
  "GET /api/posts",
  "POST /api/posts",
  "GET /api/posts/{id}",
  "POST /api/posts/{id}/announce",
  "GET /posts/{id}",
  "GET /quote-authorizations/{postId}",
  "POST /api/digests/run",
  "POST /api/announce/{handle}",
  "GET /feed/{name}",
  "GET /latest",
  "GET /latest/archive",
  "GET /latest/index.json",
  "GET /.well-known/webfinger",
  "GET /federation/actors/{handle}",
  "GET /federation/actors/{handle}/followers",
  "POST /federation/actors/{handle}/inbox",
  "POST /federation/inbox",
  "GET /static/{filename}",
  "GET /videos/{filename}",
  "GET /clipboard/{filename}",
  "GET /thumbnails/{filename}"
]);

function createCycleHarness() {
  const port = 4098;
  const host = "127.0.0.1";
  const baseUrl = `http://${host}:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-cycle-data-"));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-cycle-storage-"));

  const cycle = {
    port,
    host,
    baseUrl,
    dataDir,
    storageDir,
    server: null,
    adminHeader: "Basic " + Buffer.from("mod:secret").toString("base64"),
    bearerHeader: "Bearer cycle-token",
    hitOperations: new Set(),
    uploads: {
      approvedVideo: null,
      approvedClipboard: null,
      rejectedVideo: null,
      ghostylesVideo: null
    },
    posts: {
      apiTextPostId: null,
      apiTextPostUrl: null,
      quotedPostId: null,
      quotedPostUrl: null,
      quoteAuthorizationUrl: null,
      newsPostIds: []
    },
    digest: {
      ranHandles: []
    }
  };

  cycle.hit = (operation) => {
    cycle.hitOperations.add(operation);
  };

  cycle.assertCoveredAllOperations = () => {
    for (const operation of EXPECTED_OPERATIONS) {
      assert.equal(
        cycle.hitOperations.has(operation),
        true,
        `missing operation coverage: ${operation}`
      );
    }
  };

  cycle.startServer = async () => {
    process.env.NODE_ENV = "test";
    process.env.PORT = String(port);
    process.env.HOST = host;
    process.env.LAB_BASE_URL = baseUrl;
    process.env.LAB_DATA_DIR = dataDir;
    process.env.GSTMXX_STORAGE_DIR = storageDir;
    process.env.LAB_POST_TOKEN = "cycle-token";
    process.env.GSTMXX_ADMIN_USER = "mod";
    process.env.GSTMXX_ADMIN_PASS = "secret";
    process.env.GSTMXX_MOCK_VIDEO_PROCESSING = "1";
    process.env.GSTMXX_MOCK_FFPROBE = "video";

    delete require.cache[require.resolve("../../server.js")];
    const { createApp } = require("../../server.js");
    cycle.server = createApp().listen(port, host);
    await new Promise((resolve) => cycle.server.once("listening", resolve));
  };

  cycle.stopServer = async () => {
    if (!cycle.server) return;
    await new Promise((resolve) => cycle.server.close(resolve));
    cycle.server = null;
  };

  cycle.resetRuntimeState = () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, "posts"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
    fs.mkdirSync(path.join(storageDir, "incoming"), { recursive: true });
    fs.mkdirSync(path.join(storageDir, "approved"), { recursive: true });
    fs.mkdirSync(path.join(storageDir, "thumbnails"), { recursive: true });
  };

  cycle.restartWithCleanState = async () => {
    await cycle.stopServer();
    cycle.resetRuntimeState();
    await cycle.startServer();
  };

  cycle.cleanup = () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  };

  return cycle;
}

module.exports = { createCycleHarness };