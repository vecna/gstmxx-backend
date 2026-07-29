/**
 * @module server
 *
 * Ghostmaxxing backend: one Express process serving a single public origin.
 * Browser and fediverse both talk to the same host; `federation.fetch` bridges
 * ActivityPub, post/actor/feed state lives in flat JSON files (see
 * {@link module:postStore} and `uploadStore`), and Fedify's KV is a persistent
 * on-disk store (`FileKvStore`) so federation state survives restarts.
 *
 * This file was renamed from `fedibasic-server.js` and repathed
 * (`fedibasic-public/` → `public/`, `fedibasic-data/` → `data/`, diagnostic UI
 * mounted at `/lab`). Behaviour is otherwise unchanged in this iteration; the
 * upload/moderation/feed/preview routes and their full per-function JSDoc are
 * added in the next iteration when the routing layer is restructured.
 */

const express = require("express");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const v8 = require("node:v8");
const { Readable } = require("node:stream");
const { isDeepStrictEqual } = require("node:util");
const { Temporal } = require("@js-temporal/polyfill");
const postStore = require("./postStore.js");
const {
  Accept,
  Create,
  Delete,
  Endpoints,
  Follow,
  Image,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Tombstone,
  Undo,
  Video,
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk
} = require("@fedify/fedify");
const { createRequestFlow, event } = require("./debugLog.js");
const uploadStore = require("./uploadStore.js");
const paths = require("./paths.js");
const media = require("./services/media.js");
const video = require("./services/video.js");
const validation = require("./services/videoValidation.js");
const { startStaleUploadCleanup } = require("./services/cleanup.js");
const { createUploadsRouter } = require("./routes/uploads.js");
const { createAdminRouter } = require("./routes/admin.js");
const { createFeedsRouter } = require("./routes/feeds.js");
const xml = require("./services/xml.js");
const preview = require("./services/preview.js");

// The former line-by-line logs are intentionally silent.  The request-scoped
// gstmxx:flow logger below records state transitions instead.
const debugS = () => {};
const debugV = () => {};
const debugI = () => {};
const debugN = () => {};

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parsePositiveInt(process.env.PORT, 4040);
const BASE_URL = normalizeBaseUrl(
  process.env.LAB_BASE_URL || `http://127.0.0.1:${PORT}`
);
const { DATA_DIR, POST_DIR } = paths;
const POST_TOKEN = process.env.LAB_POST_TOKEN || "big-oopsie";
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENT_INTERFACE_DIR = path.resolve(path.join(__dirname, "client-interface"));
const ACTORS = ["video", "ghostyles", "news", "clipboard"];
const ADMIN_USER = process.env.GSTMXX_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.GSTMXX_ADMIN_PASS || "change-me-now-2026";

/**
 * Which local actor a submitted upload publishes as. This is *content* routing,
 * not media routing: an upload tagged with a ghostyle is ghostyle content and
 * publishes as the `ghostyles` actor (whose media-filter actors then split
 * pictures vs videos); otherwise it publishes as the actor matching its media
 * kind.
 *
 * FLAG: this encodes a product decision, not a mechanical one — confirm it.
 *
 * @param {Object} record - An upload record.
 * @returns {string} The actor handle.
 */
function actorForUpload(record) {
  if (record.ghostyleId) return "ghostyles";
  return record.kind === "clipboard" ? "clipboard" : "video";
}
const ALGORITHMS = ["RSASSA-PKCS1-v1_5", "Ed25519"];

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  debugV("parsePositiveInt: validating numeric env value=%o with fallback=%o", value, fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  debugV("normalizeBaseUrl: validating base URL candidate=%s", value);
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  debugN("normalizeBaseUrl: canonicalized base origin=%s", url.origin);
  return url.origin;
}

function ensureDir(directory) {
  debugI("ensureDir: ensuring directory exists at %s", directory);
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath, fallback) {
  debugI("readJson: loading JSON file=%s", filePath);
  try {
    debugN("readJson: decoding JSON payload from file");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      debugI("readJson: file missing, returning fallback value");
      return fallback;
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  debugI("writeJson: persisting JSON file=%s", filePath);
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  debugN("writeJson: serializing value and writing temp file=%s", temporary);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
  debugN("writeJson: atomic rename completed for file=%s", filePath);
}

function encodeKey(key) {
  debugN("encodeKey: transforming key tuple into string token");
  return JSON.stringify(Array.from(key || []));
}

function decodeKey(key) {
  debugN("decodeKey: transforming key token back to tuple");
  return JSON.parse(key);
}

function encodeValue(value) {
  debugN("encodeValue: serializing cache value to base64 blob");
  return Buffer.from(v8.serialize(value)).toString("base64");
}

function decodeValue(value) {
  debugN("decodeValue: deserializing base64 blob to runtime value");
  return v8.deserialize(Buffer.from(value, "base64"));
}

function expirationFor(options) {
  debugI("expirationFor: computing expiration from options=%o", options);
  if (!options?.ttl) return null;
  return Temporal.Now.instant()
    .add(options.ttl.round({ largestUnit: "hour" }))
    .toString();
}

function expired(isoDate) {
  debugV("expired: validating expiration timestamp=%o", isoDate);
  if (!isoDate) return false;
  return Temporal.Now.instant().since(Temporal.Instant.from(isoDate)).sign >= 0;
}

class FileKvStore {
  constructor(filePath) {
    debugI("FileKvStore.constructor: initializing kv store at %s", filePath);
    this.filePath = filePath;
    this.values = readJson(filePath, {});
  }

  persist() {
    debugI("FileKvStore.persist: flushing kv in-memory values to disk");
    writeJson(this.filePath, this.values);
  }

  async get(key) {
    debugI("FileKvStore.get: reading kv entry for key tuple");
    const encoded = encodeKey(key);
    const entry = this.values[encoded];
    if (!entry) return undefined;
    if (expired(entry.expiresAt)) {
      delete this.values[encoded];
      this.persist();
      return undefined;
    }
    debugN("FileKvStore.get: returning decoded kv value");
    return decodeValue(entry.value);
  }

  async set(key, value, options) {
    debugI("FileKvStore.set: setting kv entry with optional ttl");
    this.values[encodeKey(key)] = {
      value: encodeValue(value),
      expiresAt: expirationFor(options)
    };
    this.persist();
  }

  async delete(key) {
    debugI("FileKvStore.delete: deleting kv entry");
    delete this.values[encodeKey(key)];
    this.persist();
  }

  async cas(key, expectedValue, newValue, options) {
    debugI("FileKvStore.cas: compare-and-swap request received");
    const currentValue = await this.get(key);
    debugV("FileKvStore.cas: validating expected value match");
    if (!isDeepStrictEqual(currentValue, expectedValue)) return false;
    await this.set(key, newValue, options);
    return true;
  }

  async *list(prefix) {
    debugI("FileKvStore.list: iterating kv entries with prefix=%o", prefix);
    for (const [encoded, entry] of Object.entries(this.values)) {
      const key = decodeKey(encoded);
      const prefixParts = prefix ? Array.from(prefix) : [];
      if (!prefixParts.every((part, index) => key[index] === part)) continue;
      if (expired(entry.expiresAt)) {
        delete this.values[encoded];
        this.persist();
        continue;
      }
      debugN("FileKvStore.list: yielding key/value pair for caller");
      yield { key, value: decodeValue(entry.value) };
    }
  }
}

function createStores(dataDir) {
  debugI("createStores: preparing store files under %s", dataDir);
  ensureDir(dataDir);
  const keysPath = path.join(dataDir, "keys.json");
  const followersPath = path.join(dataDir, "followers.json");
  const kvPath = path.join(dataDir, "fedify-kv.json");
  if (!fs.existsSync(keysPath)) writeJson(keysPath, {});
  if (!fs.existsSync(followersPath)) writeJson(followersPath, {});

  return {
    kv: new FileKvStore(kvPath),
    readKeys: () => readJson(keysPath, {}),
    writeKeys: (value) => writeJson(keysPath, value),
    readFollowers: () => readJson(followersPath, {}),
    writeFollowers: (value) => writeJson(followersPath, value)
  };
}

const stores = createStores(DATA_DIR);

async function actorKeyPairs(handle) {
  debugS("actorKeyPairs: resolving key pairs for actor=%s", handle);
  debugV("actorKeyPairs: validating actor handle membership");
  const keys = stores.readKeys();
  keys[handle] ||= {};

  for (const algorithm of ALGORITHMS) {
    if (keys[handle][algorithm]) continue;
    const pair = await generateCryptoKeyPair(algorithm);
    debugN("actorKeyPairs: generated new key material for actor=%s algorithm=%s", handle, algorithm);
    keys[handle][algorithm] = {
      publicJwk: await exportJwk(pair.publicKey),
      privateJwk: await exportJwk(pair.privateKey)
    };
    stores.writeKeys(keys);
  }

  return Promise.all(
    ALGORITHMS.map(async (algorithm) => ({
      publicKey: await importJwk(keys[handle][algorithm].publicJwk, "public"),
      privateKey: await importJwk(keys[handle][algorithm].privateJwk, "private")
    }))
  );
}

function followerRows(handle) {
  debugI("followerRows: loading follower rows for actor=%s", handle);
  const followers = stores.readFollowers();
  return Array.isArray(followers[handle]) ? followers[handle] : [];
}

function saveFollower(handle, actorId, inboxUrl) {
  debugS("saveFollower: recording follower actor=%s for local handle=%s", actorId, handle);
  debugN("saveFollower: enriching follower row with createdAt timestamp");
  const followers = stores.readFollowers();
  const rows = followerRows(handle).filter((row) => row.actorId !== actorId);
  rows.push({ actorId, inboxUrl, createdAt: new Date().toISOString() });
  followers[handle] = rows;
  stores.writeFollowers(followers);
}

function deleteFollower(handle, actorId) {
  debugS("deleteFollower: removing follower actor=%s from handle=%s", actorId, handle);
  const followers = stores.readFollowers();
  followers[handle] = followerRows(handle).filter(
    (row) => row.actorId !== actorId
  );
  stores.writeFollowers(followers);
}

const federation = createFederation({
  kv: stores.kv,
  origin: {
    handleHost: new URL(BASE_URL).host,
    webOrigin: BASE_URL
  }
});

federation
  .setActorDispatcher("/federation/actors/{handle}", async (ctx, handle) => {
    debugS("setActorDispatcher: handling actor document request for handle=%s", handle);
    if (!ACTORS.includes(handle)) return null;
    const keys = await ctx.getActorKeyPairs(handle);
    debugN("setActorDispatcher: assembling Person actor payload for handle=%s", handle);
    return new Person({
      id: ctx.getActorUri(handle),
      preferredUsername: handle,
      name: `Ghostmaxxing lab: ${handle}`,
      summary: "Local diagnostic actor served by the Fedify browser lab.",
      publicKey: keys[0]?.cryptographicKey,
      assertionMethods: keys.map((key) => key.multikey),
      inbox: ctx.getInboxUri(handle),
      followers: ctx.getFollowersUri(handle),
      endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() })
    });
  })
  .setKeyPairsDispatcher(async (_ctx, handle) => {
    debugS("setKeyPairsDispatcher: resolving keypairs for handle=%s", handle);
    if (!ACTORS.includes(handle)) return [];
    return actorKeyPairs(handle);
  })
  .mapHandle((_ctx, handle) => {
    debugV("mapHandle: validating account mapping for handle=%s", handle);
    return ACTORS.includes(handle) ? handle : null;
  });

federation.setFollowersDispatcher(
  "/federation/actors/{handle}/followers",
  (_ctx, handle) => {
    debugS("setFollowersDispatcher: building followers collection for handle=%s", handle);
    if (!ACTORS.includes(handle)) return null;
    debugN("setFollowersDispatcher: transforming follower rows into ActivityPub ids");
    return {
      items: followerRows(handle).map((row) => ({
        id: new URL(row.actorId),
        inboxId: new URL(row.inboxUrl)
      }))
    };
  }
);

federation
  .setInboxListeners(
    "/federation/actors/{handle}/inbox",
    "/federation/inbox"
  )
  .on(Follow, async (ctx, activity) => {
    const handle = ctx.recipient;
    event("activitypub", "follow.received", {
      recipient: handle,
      activity: activity.id,
      actor: activity.actorId
    });

    if(!ACTORS.includes(handle) || !activity.objectId) {
      event("activitypub", "follow.rejected", {
        recipient: handle,
        reason: "unknown recipient or missing object"
      });
      return;
    }

    const target = ctx.parseUri(activity.objectId);

    if(target?.type !== "actor" || target.identifier !== handle) {
      event("activitypub", "follow.rejected", {
        recipient: handle,
        reason: "Follow.object does not match recipient",
        object: activity.objectId
      });
      return;
    }

    const follower = await activity.getActor(ctx);
    if (!follower?.id || !follower.inboxId) {
      event("activitypub", "follow.rejected", {
        recipient: handle,
        reason: "actor could not be resolved to an inbox"
      });
      return;
    }
    const actorId = follower.id;
    const inboxUrl = follower.endpoints?.sharedInbox || follower.inboxId;
    event("activitypub", "follow.resolved", {
      recipient: handle,
      actor: actorId,
      deliveryInbox: inboxUrl,
      usedSharedInbox: Boolean(follower.endpoints?.sharedInbox)
    });
    saveFollower(handle, actorId.href, inboxUrl.href);
    event("activitypub", "follow.stored", {
      recipient: handle,
      actor: actorId
    });

    const accept = new Accept({
      id: new URL(
        `/federation/activities/accept-${handle}-${Date.now()}`,
        BASE_URL
      ),
      actor: ctx.getActorUri(handle),
      object: activity
    });
    await ctx.sendActivity(
      { identifier: handle },
      [{ id: actorId, inboxId: inboxUrl }],
      accept,
      { immediate: true, preferSharedInbox: true }
    );
    event("activitypub", "follow.accepted", {
      recipient: handle,
      actor: actorId,
      deliveredTo: inboxUrl
    });
  })
  .on(Undo, async (ctx, activity) => {
    if (ACTORS.includes(ctx.recipient) && activity.actorId) {
      deleteFollower(ctx.recipient, activity.actorId.href);
      event("activitypub", "follow.removed", {
        recipient: ctx.recipient,
        actor: activity.actorId
      });
    }
  });

function publicRequestUrl(req) {
  debugI("publicRequestUrl: deriving externally visible request URL");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  debugN("publicRequestUrl: combined proto and host into origin %s://%s", proto, host);
  return new URL(req.originalUrl || req.url, `${proto}://${host}`);
}

function toFetchRequest(req) {
  debugI("toFetchRequest: converting Express request to Fetch API Request");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, String(value));
    }
  }
  const init = { method: req.method, headers };
  debugV("toFetchRequest: validating body forwarding rule for method=%s", req.method);
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(publicRequestUrl(req), init);
}

function sendFetchResponse(response, res, next) {
  debugI("sendFetchResponse: bridging Fetch response back into Express response");
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.on("error", next);
  return stream.pipe(res);
}


function tokenMatches(expected, provided) {
  debugV("tokenMatches: validating token presence before constant-time compare");
  if (!expected || !provided) return false;
  const expectedDigest = crypto
    .createHash("sha256")
    .update(String(expected))
    .digest();
 const providedDigest = crypto
    .createHash("sha256")
    .update(String(provided))
    .digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function requirePostToken(req, res, next) {
  if (!POST_TOKEN) {
    req.flow?.next("AUTH_SKIPPED", { reason: "LAB_POST_TOKEN is empty" });
    return next();
  }
  const authorization = req.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!tokenMatches(POST_TOKEN, provided)) {
    req.flow?.next("AUTH_REJECTED", {
      bearerPresent: Boolean(provided)
    });
    return res.status(401).json({
      ok: false,
      message: "A valid LAB_POST_TOKEN bearer token is required."
    });
  }
  req.flow?.next("AUTH_ACCEPTED", { bearerPresent: true });
  return next();
}

function publicPost(post) {
  const url = new URL(`/posts/${post.id}`, BASE_URL).href;
  return { ...post, url };
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderContent(post) {
  const body = `<p>${escapeHtml(post.content).replaceAll("\n", "<br>")}</p>`;
  if (!post.quoteUrl) return body;
  const quoteUrl = escapeHtml(post.quoteUrl);
  return `${body}<p class="quote-inline">RE: <a href="${quoteUrl}">${quoteUrl}</a></p>`;
}

function normalizeHttpUrl(value, fieldName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error(`${fieldName} must be an absolute URL.`), {
      status: 400
    });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw Object.assign(
      new Error(`${fieldName} must use http or https.`),
      { status: 400 }
    );
  }
  return url;
}

function normalizeAttachment(value) {
  if (value == null) return null;
  if (
    typeof value !== "object" ||
    value.type !== "Image" ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    typeof value.mediaType !== "string" ||
    !value.mediaType.startsWith("image/")
  ) {
    throw Object.assign(
      new Error(
        "attachment must be { type: \"Image\", url, mediaType: \"image/...\", name: \"alt text\" }."
      ),
      { status: 400 }
    );
  }
  return {
    type: "Image",
    url: normalizeHttpUrl(value.url, "attachment.url").href,
    mediaType: value.mediaType,
    name: value.name.trim()
  };
}

function localQuotedPost(quoteUrl, traceId) {
  const url = new URL(quoteUrl);
  if (url.origin !== new URL(BASE_URL).origin) return null;
  const match = /^\/posts\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (!match) {
    throw Object.assign(
      new Error("A local quoteUrl must point to /posts/{uuid}."),
      { status: 400 }
    );
  }
  const post = postStore.read(POST_DIR, match[1], traceId);
  if (!post) {
    throw Object.assign(new Error("The local quoted post does not exist."), {
      status: 400
    });
  }
  return post;
}

async function activityPubPost(post, traceId) {
  const objectUrl = new URL(`/posts/${post.id}`, BASE_URL);
  const actorUrl = new URL(`/federation/actors/${post.actor}`, BASE_URL);
  const followersUrl = new URL(
    `/federation/actors/${post.actor}/followers`,
    BASE_URL
  );
  const attachments = post.attachment
    ? [
        new (String(post.attachment.mediaType).startsWith("video/") ? Video : Image)({
          url: new URL(post.attachment.url),
          mediaType: post.attachment.mediaType,
          name: post.attachment.name
        })
      ]
    : [];
  const note = new Note({
    id: objectUrl,
    url: objectUrl,
    content: renderContent(post),
    mediaType: "text/html",
    published: Temporal.Instant.from(post.createdAt),
    attribution: actorUrl,
    attachments,
    tos: [PUBLIC_COLLECTION],
    ccs: [followersUrl],
    quoteUrl: post.quoteUrl ? new URL(post.quoteUrl) : null
  });
  const json = await note.toJsonLd();

  if (post.quoteUrl) {
    if (!Array.isArray(json["@context"])) {
      json["@context"] = [json["@context"]].filter(Boolean);
    }
    json["@context"].push({
      quote: {
        "@id": "https://w3id.org/fep/044f#quote",
        "@type": "@id"
      },
      quoteAuthorization: {
        "@id": "https://w3id.org/fep/044f#quoteAuthorization",
        "@type": "@id"
      }
    });
    json.quote = post.quoteUrl;
    if (post.quoteAuthorizationUrl) {
      json.quoteAuthorization = post.quoteAuthorizationUrl;
    }
  }

  event("activitypub", "note.transformed", {
    trace: traceId,
    postId: post.id,
    actor: post.actor,
    attachment: attachments.length,
    quote: Boolean(post.quoteUrl),
    authorizedQuote: Boolean(post.quoteAuthorizationUrl)
  });
  return json;
}

async function announcePost(post, traceId) {
  const ctx = federation.createContext(new URL(BASE_URL), undefined);
  const actor = ctx.getActorUri(post.actor);
  const object = await activityPubPost(post, traceId);
  const activityId = new URL(
    `/federation/activities/create-${post.id}-${Date.now()}`,
    BASE_URL
  );
  const activity = await Create.fromJsonLd({
    "@context": object["@context"],
    id: activityId.href,
    type: "Create",
    actor: actor.href,
    object,
    to: object.to,
    cc: object.cc
  });
  const followers = followerRows(post.actor).length;
  event("activitypub", "delivery.start", {
    trace: traceId,
    activity: activityId,
    actor: post.actor,
    followers
  });
  await ctx.sendActivity(
    { identifier: post.actor },
    "followers",
    activity,
    { immediate: true, preferSharedInbox: true }
  );
  event("activitypub", "delivery.done", {
    trace: traceId,
    activity: activityId,
    followers
  });
  return { followers };
}


/**
 * Build the Express application: the client static layer, the Fedify HTTP
 * bridge (`/.well-known`, `/federation`), the JSON post/announce API, the
 * ActivityPub object and quote-authorization endpoints, and the error/404
 * handlers. Pure factory — it does not bind a port (see {@link startServer}),
 * which is what lets tests drive it in-process on an ephemeral port.
 *
 * @returns {import("express").Express} The configured app.
 */
/**
 * Federate a `Delete(Tombstone)` for a retired post to its actor's followers.
 * A no-op-successful when there are no followers.
 *
 * @param {Object} post - The post record being retired.
 * @param {string} [traceId]
 * @returns {Promise<{followers:number}>}
 */
async function emitDeleteForPost(post, traceId) {
  const ctx = federation.createContext(new URL(BASE_URL), undefined);
  const objectUrl = new URL(`/posts/${post.id}`, BASE_URL);
  const activity = new Delete({
    id: new URL(`/federation/activities/delete-${post.id}-${Date.now()}`, BASE_URL),
    actor: ctx.getActorUri(post.actor),
    object: new Tombstone({ id: objectUrl }),
    tos: [PUBLIC_COLLECTION]
  });
  const followers = followerRows(post.actor).length;
  event("activitypub", "delete.start", { trace: traceId, postId: post.id, actor: post.actor, followers });
  await ctx.sendActivity(
    { identifier: post.actor },
    "followers",
    activity,
    { immediate: true, preferSharedInbox: true }
  );
  event("activitypub", "delete.done", { trace: traceId, postId: post.id, followers });
  return { followers };
}

function createApp() {
  debugS("createApp: initializing Express app and Fedify bridge routes");
  const app = express();
  app.set("trust proxy", true);

  if (fs.existsSync(CLIENT_INTERFACE_DIR)) {
    // Top-priority static layer: if the client has a matching file/path, serve it before backend routes.
    app.use(express.static(CLIENT_INTERFACE_DIR, { index: "index.html" }));
  }

  app.use("/lab", express.static(PUBLIC_DIR, { index: "index.html" }));

  // Ensure runtime directories exist before serving any request.
  for (const dir of paths.RUNTIME_DIRS) fs.mkdirSync(dir, { recursive: true });

  // Serve approved media in development; in production nginx aliases (and
  // caches) these same paths from the storage directories.
  app.use("/videos", express.static(paths.STORAGE_APPROVED_DIR));
  app.use("/clipboard", express.static(paths.STORAGE_APPROVED_DIR));
  app.use("/thumbnails", express.static(paths.STORAGE_THUMBNAILS_DIR));

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.flow = createRequestFlow(req);
    res.setHeader("x-request-id", req.flow.id);
    req.flow.next("HTTP_RECEIVED", {
      method: req.method,
      path: req.originalUrl || req.url
    });
    res.on("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      req.flow.next("HTTP_RESPONDED", {
        status: res.statusCode,
        durationMs: durationMs.toFixed(1)
      });
    });
    next();
  });

  const fedifyBridge = async (req, res, next) => {
    req.flow.next("FEDIFY_DISPATCH", {
      publicUrl: publicRequestUrl(req)
    });
    try {
      const response = await federation.fetch(toFetchRequest(req), {
        contextData: undefined
      });
      req.flow.next("FEDIFY_RESULT", {
        status: response.status,
        contentType: response.headers.get("content-type")
      });
      return sendFetchResponse(response, res, next);
    } catch (error) {
      req.flow.next("FEDIFY_ERROR", { error });
      return next(error);
    }
  };

  app.use("/.well-known", fedifyBridge);
  app.use("/federation", fedifyBridge);
  app.use(express.json({ limit: "128kb" }));
  app.use("/static", express.static(PUBLIC_DIR));

  app.use("/api/uploads", createUploadsRouter({
    uploadStore,
    uploadsDir: paths.UPLOADS_DIR,
    incomingDir: paths.STORAGE_INCOMING_DIR,
    dirs: paths.mediaDirs,
    media,
    validation,
    postStore,
    postDir: POST_DIR,
    emitDelete: emitDeleteForPost
  }));

  app.use("/api/admin", createAdminRouter({
    uploadStore,
    uploadsDir: paths.UPLOADS_DIR,
    postStore,
    postDir: POST_DIR,
    dirs: paths.mediaDirs,
    video,
    media,
    baseUrl: BASE_URL,
    actorForUpload,
    adminHtmlPath: path.join(__dirname, "admin", "index.html"),
    adminUser: ADMIN_USER,
    adminPass: ADMIN_PASS,
    announce: announcePost
  }));

  app.use("/feed", createFeedsRouter({
    postStore,
    postDir: POST_DIR,
    baseUrl: BASE_URL,
    actors: ACTORS,
    xml
  }));

  app.get("/", (_req, res) => {
    debugS("GET /: serving lab index page");
    return res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.get("/api/config", (req, res) => {
    debugS("GET /api/config: returning runtime configuration summary");
    const browserOrigin = `${req.protocol}://${req.get("host")}`;
    debugN("GET /api/config: computed browserOrigin=%s for comparison", browserOrigin);
    res.json({
      ok: true,
      configuredBaseUrl: BASE_URL,
      browserOrigin,
      originMatches: browserOrigin === BASE_URL,
      actors: ACTORS,
      postAuthRequired: Boolean(POST_TOKEN),
      realFederationReady:
        new URL(BASE_URL).protocol === "https:" &&
        !["127.0.0.1", "localhost"].includes(new URL(BASE_URL).hostname)
    });
  });

  app.get("/api/followers", (_req, res) => {
    debugS("GET /api/followers: returning current follower store snapshot");
    res.json({ ok: true, followers: stores.readFollowers() });
  });

  app.get("/api/posts", (req, res) => {
    debugS("GET /api/posts: listing stored posts for client");
    res.json({
      ok: true,
      posts: postStore.list(POST_DIR, req.flow.id).map(publicPost)
    });
  });

  app.get("/api/posts/:id", (req, res) => {
    debugS("GET /api/posts/:id: fetching single post id=%s", req.params.id);
    debugV("GET /api/posts/:id: validating post id format through postStore");
    const post = postStore.read(POST_DIR, req.params.id, req.flow.id);
    if (!post) {
      debugI("GET /api/posts/:id: post not found id=%s", req.params.id);
      return res.status(404).json({ ok: false, message: "Post not found." });
    }
    return res.json({ ok: true, post: publicPost(post) });
  });

  app.post("/api/posts", requirePostToken, async (req, res, next) => {
    try {
      const {
        content,
        actor = "video",
        publish = false,
        attachment: attachmentInput,
        quoteUrl: quoteInput
      } = req.body || {};
      req.flow.next("POST_INPUT", {
        actor,
        publish: Boolean(publish),
        contentChars: typeof content === "string" ? content.length : null,
        attachment: Boolean(attachmentInput),
        quote: Boolean(quoteInput)
      });
      if (typeof content !== "string" || content.length === 0) {
        return res.status(400).json({
          ok: false,
          message: "content must be a non-empty string."
        });
      }
      if (!ACTORS.includes(actor)) {
        return res.status(400).json({
          ok: false,
          message: `actor must be one of: ${ACTORS.join(", ")}.`
        });
      }

      const attachment = normalizeAttachment(attachmentInput);
      const quoteUrl = quoteInput
        ? normalizeHttpUrl(quoteInput, "quoteUrl").href
        : null;
      const originalPost = quoteUrl
        ? localQuotedPost(quoteUrl, req.flow.id)
        : null;
      const postId = crypto.randomUUID();
      const quoteAuthorizationUrl =
        originalPost && originalPost.actor !== actor
          ? new URL(`/quote-authorizations/${postId}`, BASE_URL).href
          : null;
      req.flow.next("POST_VALIDATED", {
        actor,
        postId,
        attachment: Boolean(attachment),
        quote: quoteUrl || null,
        quoteApproval: quoteAuthorizationUrl ? "local-preapproved" : "none"
      });

      const post = postStore.create(POST_DIR, content, actor, {
        id: postId,
        attachment,
        quoteUrl,
        quoteAuthorizationUrl,
        traceId: req.flow.id
      });
      req.flow.next("POST_STORED", {
        postId: post.id,
        file: path.join(POST_DIR, `${post.id}.json`)
      });
      const delivery = publish
        ? await announcePost(post, req.flow.id)
        : null;
      req.flow.next(publish ? "POST_PUBLISHED" : "POST_NOT_PUBLISHED", {
        postId: post.id,
        followers: delivery?.followers || 0
      });
      return res.status(201).json({
        ok: true,
        post: publicPost(post),
        published: Boolean(publish),
        delivery
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/posts/:id/announce", requirePostToken, async (req, res, next) => {
    debugS("POST /api/posts/:id/announce: announcing existing post id=%s", req.params.id);
    try {
      const post = postStore.read(POST_DIR, req.params.id, req.flow.id);
      if (!post) {
        debugI("POST /api/posts/:id/announce: post not found id=%s", req.params.id);
        return res.status(404).json({ ok: false, message: "Post not found." });
      }
      req.flow.next("POST_LOADED_FOR_DELIVERY", {
        postId: post.id,
        actor: post.actor
      });
      const delivery = await announcePost(post, req.flow.id);
      req.flow.next("POST_PUBLISHED", {
        postId: post.id,
        followers: delivery.followers
      });
      return res.json({
        ok: true,
        post: publicPost(post),
        published: true,
        delivery
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/posts/:id", async (req, res, next) => {
    debugS("GET /posts/:id: serving ActivityPub object id=%s", req.params.id);
    const post = postStore.read(POST_DIR, req.params.id, req.flow.id);
    if (!post) {
      debugI("GET /posts/:id: post not found id=%s", req.params.id);
      return res.status(404).json({ ok: false, message: "Post not found." });
    }
    // Same resource, two representations: a browser (Accept: text/html) gets the
    // Open Graph preview page; a fediverse server gets the ActivityPub object.
    const accept = req.get("accept") || "";
    const wantsActivityPub = /application\/(activity|ld)\+json/i.test(accept);
    if (!wantsActivityPub) {
      req.flow.next("POST_PAGE_SERVED", { postId: post.id });
      return res.type("html").send(preview.renderPostPage(post, { baseUrl: BASE_URL }));
    }
    try {
      const object = await activityPubPost(post, req.flow.id);
      req.flow.next("ACTIVITYPUB_OBJECT_SERVED", {
        postId: post.id,
        type: object.type
      });
      return res.type("application/activity+json").json(object);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/quote-authorizations/:postId", async (req, res, next) => {
    try {
      const quotePost = postStore.read(
        POST_DIR,
        req.params.postId,
        req.flow.id
      );
      if (!quotePost?.quoteAuthorizationUrl || !quotePost.quoteUrl) {
        return res.status(404).json({
          ok: false,
          message: "Quote authorization not found."
        });
      }
      const originalPost = localQuotedPost(quotePost.quoteUrl, req.flow.id);
      if (!originalPost || originalPost.actor === quotePost.actor) {
        return res.status(404).json({
          ok: false,
          message: "Quote authorization not found."
        });
      }
      const authorization = {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          {
            QuoteAuthorization:
              "https://w3id.org/fep/044f#QuoteAuthorization",
            gts: "https://gotosocial.org/ns#",
            interactingObject: {
              "@id": "gts:interactingObject",
              "@type": "@id"
            },
            interactionTarget: {
              "@id": "gts:interactionTarget",
              "@type": "@id"
            }
          }
        ],
        id: quotePost.quoteAuthorizationUrl,
        type: "QuoteAuthorization",
        attributedTo: new URL(
          `/federation/actors/${originalPost.actor}`,
          BASE_URL
        ).href,
        interactingObject: new URL(`/posts/${quotePost.id}`, BASE_URL).href,
        interactionTarget: quotePost.quoteUrl
      };
      req.flow.next("QUOTE_AUTHORIZATION_SERVED", {
        quotePost: quotePost.id,
        originalPost: originalPost.id,
        approvingActor: originalPost.actor
      });
      return res.type("application/activity+json").json(authorization);
    } catch (error) {
      return next(error);
    }
  });


  app.post("/api/announce/:handle", async (req, res, next) => {
    debugS("POST /api/announce/:handle: announcing static object for handle=%s", req.params.handle);
    const { handle } = req.params;
    debugV("POST /api/announce/:handle: validating actor handle exists");
    if (!ACTORS.includes(handle)) {
      return res.status(404).json({ ok: false, message: "Unknown actor." });
    }
    try {
      const ctx = federation.createContext(new URL(BASE_URL), undefined);
      const actor = ctx.getActorUri(handle);
      const objectUrl = new URL(`/static/${handle}.json`, BASE_URL);
      debugN("POST /api/announce/:handle: composing Note and Create wrappers for static asset");
      const object = new Note({
        id: objectUrl,
        name: `Static ${handle} announcement`,
        content: `Diagnostic Create from the ${handle} actor.`,
        url: objectUrl,
        attribution: actor
      });
      const activity = new Create({
        id: new URL(
          `/federation/activities/create-${handle}-${Date.now()}`,
          BASE_URL
        ),
        actor,
        object,
        tos: [PUBLIC_COLLECTION]
      });

      await ctx.sendActivity(
        { identifier: handle },
        "followers",
        activity,
        { immediate: true, preferSharedInbox: true }
      );
      debugS("POST /api/announce/:handle: delivered Create to follower collection handle=%s", handle);
      return res.json({
        ok: true,
        actor: handle,
        object: objectUrl.href,
        followers: followerRows(handle).length
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/healthz", (_req, res) => {
    debugS("GET /healthz: returning health payload");
    res.json({ ok: true, baseUrl: BASE_URL, actors: ACTORS });
  });

  app.use((req, res) => {
    debugI("404 handler: route not found path=%s", req.originalUrl || req.url);
    res.status(404).json({ ok: false, message: "Not found." });
  });

  app.use((error, req, res, _next) => {
    debugS("error handler: caught error status=%o message=%s", error.status || error.statusCode, error.message);
    req.flow?.next("REQUEST_ERROR", {
      status: error.status || error.statusCode || 500,
      error
    });
    console.error("[fedify-browser-lab]", error);
    if (res.headersSent) return;
    res.status(error.status || error.statusCode || 500).json({
      ok: false,
      message: error.message || "Unexpected server error."
    });
  });

  return app;
}

/**
 * Create the app and bind it to `HOST:PORT`, logging the reachable URL.
 *
 * @returns {import("node:http").Server} The listening HTTP server.
 */
function startServer() {
  debugS("startServer: starting HTTP server host=%s port=%d", HOST, PORT);
  startStaleUploadCleanup({
    uploadStore,
    uploadsDir: paths.UPLOADS_DIR,
    dirs: paths.mediaDirs
  });
  const server = createApp().listen(PORT, HOST, () => {
    debugI("startServer: Express listen callback fired and server is ready");
    event("http", "server.ready", {
      host: HOST,
      port: PORT,
      baseUrl: BASE_URL,
      dataDir: DATA_DIR
    });
    console.log(`Browser: ${BASE_URL}/`);
    console.log(`Listening on ${HOST}:${PORT}`);
    if (HOST === "0.0.0.0") {
      console.log(
        "For a browser on another machine, set LAB_BASE_URL to this Linux host's LAN URL."
      );
    }
  });
  return server;
}

module.exports = {
  createApp,
  startServer
};

if (require.main === module) {
  startServer();
}
