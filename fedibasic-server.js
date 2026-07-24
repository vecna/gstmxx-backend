const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const { Readable } = require("node:stream");
const { isDeepStrictEqual } = require("node:util");
const { Temporal } = require("@js-temporal/polyfill");
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

const HOST = process.env.HOST || "0.0.0.0";
const PORT = parsePositiveInt(process.env.PORT, 4040);
const BASE_URL = normalizeBaseUrl(
  process.env.LAB_BASE_URL || `http://127.0.0.1:${PORT}`
);
const DATA_DIR = path.resolve(
  process.env.LAB_DATA_DIR || path.join(__dirname, "fedibasic-data")
);
const PUBLIC_DIR = path.join(__dirname, "fedibasic-public");
const ACTORS = ["video", "ghostyles", "news", "clipboard"];
const ALGORITHMS = ["RSASSA-PKCS1-v1_5", "Ed25519"];

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function encodeKey(key) {
  return JSON.stringify(Array.from(key || []));
}

function decodeKey(key) {
  return JSON.parse(key);
}

function encodeValue(value) {
  return Buffer.from(v8.serialize(value)).toString("base64");
}

function decodeValue(value) {
  return v8.deserialize(Buffer.from(value, "base64"));
}

function expirationFor(options) {
  if (!options?.ttl) return null;
  return Temporal.Now.instant()
    .add(options.ttl.round({ largestUnit: "hour" }))
    .toString();
}

function expired(isoDate) {
  if (!isoDate) return false;
  return Temporal.Now.instant().since(Temporal.Instant.from(isoDate)).sign >= 0;
}

class FileKvStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.values = readJson(filePath, {});
  }

  persist() {
    writeJson(this.filePath, this.values);
  }

  async get(key) {
    const encoded = encodeKey(key);
    const entry = this.values[encoded];
    if (!entry) return undefined;
    if (expired(entry.expiresAt)) {
      delete this.values[encoded];
      this.persist();
      return undefined;
    }
    return decodeValue(entry.value);
  }

  async set(key, value, options) {
    this.values[encodeKey(key)] = {
      value: encodeValue(value),
      expiresAt: expirationFor(options)
    };
    this.persist();
  }

  async delete(key) {
    delete this.values[encodeKey(key)];
    this.persist();
  }

  async cas(key, expectedValue, newValue, options) {
    const currentValue = await this.get(key);
    if (!isDeepStrictEqual(currentValue, expectedValue)) return false;
    await this.set(key, newValue, options);
    return true;
  }

  async *list(prefix) {
    for (const [encoded, entry] of Object.entries(this.values)) {
      const key = decodeKey(encoded);
      const prefixParts = prefix ? Array.from(prefix) : [];
      if (!prefixParts.every((part, index) => key[index] === part)) continue;
      if (expired(entry.expiresAt)) {
        delete this.values[encoded];
        this.persist();
        continue;
      }
      yield { key, value: decodeValue(entry.value) };
    }
  }
}

function createStores(dataDir) {
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
  const keys = stores.readKeys();
  keys[handle] ||= {};

  for (const algorithm of ALGORITHMS) {
    if (keys[handle][algorithm]) continue;
    const pair = await generateCryptoKeyPair(algorithm);
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
  const followers = stores.readFollowers();
  return Array.isArray(followers[handle]) ? followers[handle] : [];
}

function saveFollower(handle, actorId, inboxUrl) {
  const followers = stores.readFollowers();
  const rows = followerRows(handle).filter((row) => row.actorId !== actorId);
  rows.push({ actorId, inboxUrl, createdAt: new Date().toISOString() });
  followers[handle] = rows;
  stores.writeFollowers(followers);
}

function deleteFollower(handle, actorId) {
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
    if (!ACTORS.includes(handle)) return null;
    const keys = await ctx.getActorKeyPairs(handle);
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
    if (!ACTORS.includes(handle)) return [];
    return actorKeyPairs(handle);
  })
  .mapHandle((_ctx, handle) => (ACTORS.includes(handle) ? handle : null));

federation.setFollowersDispatcher(
  "/federation/actors/{handle}/followers",
  (_ctx, handle) => {
    if (!ACTORS.includes(handle)) return null;
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
    const actorId = activity.actorId;
    const inboxUrl = activity.inboxId || activity.actor?.inboxId;
    if (!ACTORS.includes(handle) || !actorId || !inboxUrl) return;

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
  })
  .on(Undo, async (ctx, activity) => {
    if (ACTORS.includes(ctx.recipient) && activity.actorId) {
      deleteFollower(ctx.recipient, activity.actorId.href);
    }
  });

function publicRequestUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  return new URL(req.originalUrl || req.url, `${proto}://${host}`);
}

function toFetchRequest(req) {
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
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(publicRequestUrl(req), init);
}

function sendFetchResponse(response, res, next) {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  stream.on("error", next);
  return stream.pipe(res);
}

function createApp() {
  const app = express();
  app.set("trust proxy", true);

  const fedifyBridge = async (req, res, next) => {
    try {
      const response = await federation.fetch(toFetchRequest(req), {
        contextData: undefined
      });
      return sendFetchResponse(response, res, next);
    } catch (error) {
      return next(error);
    }
  };

  app.use("/.well-known", fedifyBridge);
  app.use("/federation", fedifyBridge);
  app.use(express.json({ limit: "128kb" }));
  app.use("/static", express.static(PUBLIC_DIR));

  app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

  app.get("/api/config", (req, res) => {
    const browserOrigin = `${req.protocol}://${req.get("host")}`;
    res.json({
      ok: true,
      configuredBaseUrl: BASE_URL,
      browserOrigin,
      originMatches: browserOrigin === BASE_URL,
      actors: ACTORS,
      realFederationReady:
        new URL(BASE_URL).protocol === "https:" &&
        !["127.0.0.1", "localhost"].includes(new URL(BASE_URL).hostname)
    });
  });

  app.get("/api/followers", (_req, res) => {
    res.json({ ok: true, followers: stores.readFollowers() });
  });

  app.post("/api/announce/:handle", async (req, res, next) => {
    const { handle } = req.params;
    if (!ACTORS.includes(handle)) {
      return res.status(404).json({ ok: false, message: "Unknown actor." });
    }
    try {
      const ctx = federation.createContext(new URL(BASE_URL), undefined);
      const actor = ctx.getActorUri(handle);
      const objectUrl = new URL(`/static/${handle}.json`, BASE_URL);
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
    res.json({ ok: true, baseUrl: BASE_URL, actors: ACTORS });
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, message: "Not found." });
  });

  app.use((error, _req, res, _next) => {
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
  const server = createApp().listen(PORT, HOST, () => {
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
