const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { event } = require("./debugLog.js");

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function postPath(postsDirectory, postId) {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) {
    event("store", "post.path.rejected", { postId });
    return null;
  }
  return path.join(postsDirectory, `${postId}.json`);
}

function read(postsDirectory, postId, traceId) {
  const filePath = postPath(postsDirectory, postId);
  if (!filePath) return null;

  try {
    const post = JSON.parse(fs.readFileSync(filePath, "utf8"));
    event("store", "post.read", {
      trace: traceId,
      postId,
      actor: post.actor,
      file: filePath
    });
    return post;
  } catch (error) {
    if (error.code === "ENOENT") {
      event("store", "post.missing", { trace: traceId, postId });
      return null;
    }
    throw error;
  }
}

function list(postsDirectory, traceId) {
  ensureDirectory(postsDirectory);
  const posts = fs
    .readdirSync(postsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name)
    )
    .map((entry) =>
      read(postsDirectory, path.basename(entry.name, ".json"), traceId)
    )
    .filter(Boolean)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  event("store", "post.list", {
    trace: traceId,
    directory: postsDirectory,
    count: posts.length
  });
  return posts;
}

function create(postsDirectory, content, actor, options = {}) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("Content must be a non-empty string");
  }

  ensureDirectory(postsDirectory);
  const post = {
    id: options.id || crypto.randomUUID(),
    type: "Note",
    actor,
    content,
    createdAt: new Date().toISOString()
  };

  for (const key of ["attachment", "quoteUrl", "quoteAuthorizationUrl"]) {
    if (options[key] != null) post[key] = options[key];
  }

  const finalPath = postPath(postsDirectory, post.id);
  const temporaryPath = `${finalPath}.${process.pid}.tmp`;
  event("store", "post.write.start", {
    trace: options.traceId,
    postId: post.id,
    actor,
    attachment: Boolean(post.attachment),
    quote: Boolean(post.quoteUrl)
  });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(post, null, 2)}\n`,
    "utf8"
  );
  fs.renameSync(temporaryPath, finalPath);
  event("store", "post.write.done", {
    trace: options.traceId,
    postId: post.id,
    file: finalPath
  });
  return post;
}

module.exports = {
  create,
  list,
  read
};
