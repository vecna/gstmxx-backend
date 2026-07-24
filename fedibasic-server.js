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
  Endpoints,
  Follow,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Undo,
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk
} = require("@fedify/fedify");
const debugS = require("debug")("fedibasic:server");
const debugV = require("debug")("fedibasic:validation");
const debugI = require("debug")("fedibasic:internal");
const debugN = require("debug")("fedibasic:notes");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parsePositiveInt(process.env.PORT, 4040);
const BASE_URL = normalizeBaseUrl(
  process.env.LAB_BASE_URL || `http://127.0.0.1:${PORT}`
);
const DATA_DIR = path.resolve(
  process.env.LAB_DATA_DIR || path.join(__dirname, "fedibasic-data")
);
const POST_DIR = path.join(DATA_DIR, "posts");
const POST_TOKEN = process.env.LAB_POST_TOKEN || "big-oopsie";
const PUBLIC_DIR = path.join(__dirname, "fedibasic-public");
const ACTORS = ["video", "ghostyles", "news", "clipboard"];
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
    debugS("Follow listener: received Follow activity for recipient=%s", ctx.recipient);
    const handle = ctx.recipient;
/*    const actorId = activity.actorId;
    const inboxUrl = activity.inboxId || activity.actor?.inboxId;
    if (!ACTORS.includes(handle) || !actorId || !inboxUrl) return;

    saveFollower(handle, actorId.href, inboxUrl.href); */

    if(!ACTORS.includes(handle) || !activity.objectId) {
      debugV("Follow listener: invalid follow payload or unknown recipient");
      return;
    }

    const target = ctx.parseUri(activity.objectId);
    debugV("Follow listener: validating Follow.object target against local recipient");

    if(target?.type !== "actor" || target.identifier !== handle) {
      debugV("Follow listener: Follow.object target mismatch target=%o activity=%o", target, activity);
      return;
    }


    const follower = await activity.getActor(ctx);
    debugI("Follow listener: resolved actor profile from incoming Follow");
    if (!follower?.id || !follower.inboxId) return;
    const actorId = follower.id;
    const inboxUrl = follower.endpoints?.sharedInbox || follower.inboxId;
    debugN("Follow listener: selected inbox endpoint and saving follower state");
    saveFollower(handle, actorId.href, inboxUrl.href);

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
    debugS("Follow listener: sent Accept response for follower actor=%s", actorId.href);
  })
  .on(Undo, async (ctx, activity) => {
    debugS("Undo listener: received Undo activity for recipient=%s", ctx.recipient);
    if (ACTORS.includes(ctx.recipient) && activity.actorId) {
      debugN("Undo listener: deleting follower state for actor=%s", activity.actorId.href);
      deleteFollower(ctx.recipient, activity.actorId.href);
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
  debugI("requirePostToken: evaluating whether write operation requires authorization");
  if (!POST_TOKEN) return next();
  const authorization = req.get("authorization") || "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  debugV("requirePostToken: validating bearer token format and value");
  if (!tokenMatches(POST_TOKEN, provided)) {
    debugS("requirePostToken: rejected write request due to missing or invalid token");
    return res.status(401).json({
      ok: false,
      message: "A valid LAB_POST_TOKEN bearer token is required."
    });
  }
  return next();
}

function publicPost(post) {
  debugN("publicPost: enriching stored post with public ActivityPub URL");
  const url = new URL(`/posts/${post.id}`, BASE_URL).href;
  return { ...post, url };
}

function activityPubPost(post) {
  debugN("activityPubPost: transforming stored post into ActivityStreams Note object");
  const actorUrl = new URL(`/federation/actors/${post.actor}`, BASE_URL).href;
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: new URL(`/posts/${post.id}`, BASE_URL).href,
    type: "Note",
    attributedTo: actorUrl,
    content: post.content,
    mediaType: "text/plain",
    published: post.createdAt,
    to: "https://www.w3.org/ns/activitystreams#Public"
  };
}


async function announcePost(post) {
  debugS("announcePost: sending Create activity for post id=%s actor=%s", post.id, post.actor);
  const ctx = federation.createContext(new URL(BASE_URL), undefined);
  const actor = ctx.getActorUri(post.actor);
  const objectUrl = new URL(`/posts/${post.id}`, BASE_URL);
  debugN("announcePost: transforming post into Note object and wrapping Create activity");
  const object = new Note({
    id: objectUrl,
    content: post.content,
    mediaType: "text/plain",
    published: Temporal.Instant.from(post.createdAt),
    attribution: actor,
    tos: [PUBLIC_COLLECTION]
  });
  const activity = new Create({
    id: new URL(
      `/federation/activities/create-${post.id}-${Date.now()}`,
      BASE_URL
    ),
    actor,
    object,
    tos: [PUBLIC_COLLECTION]
  });
  await ctx.sendActivity(
    { identifier: post.actor },
    "followers",
    activity,
    { immediate: true, preferSharedInbox: true }
  );
  debugS("announcePost: Create activity delivered to follower collection for actor=%s", post.actor);
  return { followers: followerRows(post.actor).length };
}


function createApp() {
  debugS("createApp: initializing Express app and Fedify bridge routes");
  const app = express();
  app.set("trust proxy", true);

  const fedifyBridge = async (req, res, next) => {
    debugS("fedifyBridge: routing request through Fedify path=%s", req.originalUrl || req.url);
    try {
      const response = await federation.fetch(toFetchRequest(req), {
        contextData: undefined
      });
      debugI("fedifyBridge: received Fedify response status=%d", response.status);
      return sendFetchResponse(response, res, next);
    } catch (error) {
      debugS("fedifyBridge: Fedify interaction failed with error=%s", error.message);
      return next(error);
    }
  };

  app.use("/.well-known", fedifyBridge);
  app.use("/federation", fedifyBridge);
  app.use(express.json({ limit: "128kb" }));
  app.use("/static", express.static(PUBLIC_DIR));

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

  app.get("/api/posts", (_req, res) => {
    debugS("GET /api/posts: listing stored posts for client");
    res.json({ ok: true, posts: postStore.list(POST_DIR).map(publicPost) });
  });

  app.get("/api/posts/:id", (req, res) => {
    debugS("GET /api/posts/:id: fetching single post id=%s", req.params.id);
    debugV("GET /api/posts/:id: validating post id format through postStore");
    const post = postStore.read(POST_DIR, req.params.id);
    if (!post) {
      debugI("GET /api/posts/:id: post not found id=%s", req.params.id);
      return res.status(404).json({ ok: false, message: "Post not found." });
    }
    return res.json({ ok: true, post: publicPost(post) });
  });

  app.post("/api/posts", requirePostToken, async (req, res, next) => {
    debugS("POST /api/posts: creating new post via API");
    try {
      const { content, actor = "video", publish = false } = req.body || {};
      debugV("POST /api/posts: validating content and actor fields");
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
      debugN("POST /api/posts: persisting validated post payload");
      const post = postStore.create(POST_DIR, content, actor);
      const delivery = publish ? await announcePost(post) : null;
      debugI("POST /api/posts: create completed id=%s publish=%s", post.id, publish);
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
      const post = postStore.read(POST_DIR, req.params.id);
      if (!post) {
        debugI("POST /api/posts/:id/announce: post not found id=%s", req.params.id);
        return res.status(404).json({ ok: false, message: "Post not found." });
      }
      const delivery = await announcePost(post);
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

  app.get("/posts/:id", (req, res) => {
    debugS("GET /posts/:id: serving ActivityPub object id=%s", req.params.id);
    const post = postStore.read(POST_DIR, req.params.id);
    if (!post) {
      debugI("GET /posts/:id: post not found id=%s", req.params.id);
      return res.status(404).json({ ok: false, message: "Post not found." });
    }
    debugN("GET /posts/:id: transformed stored post into activity+json note");
    return res.type("application/activity+json").json(activityPubPost(post));
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

  app.use((error, _req, res, _next) => {
    debugS("error handler: caught error status=%o message=%s", error.status || error.statusCode, error.message);
    console.error("[fedify-browser-lab]", error);
    if (res.headersSent) return;
    res.status(error.status || error.statusCode || 500).json({
      ok: false,
      message: error.message || "Unexpected server error."
    });
  });

  return app;
}

function startServer() {
  debugS("startServer: starting HTTP server host=%s port=%d", HOST, PORT);
  const server = createApp().listen(PORT, HOST, () => {
    debugI("startServer: Express listen callback fired and server is ready");
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
