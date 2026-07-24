const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const debugServer = require("debug")("postStore:server");
const debugValidation = require("debug")("postStore:validation");
const debugInternal = require("debug")("postStore:internal");
const debugNotes = require("debug")("postStore:notes");

function ensureDirectory(directory) {
    debugInternal("ensureDirectory: ensuring posts directory exists at %s", directory);
    if (!fs.existsSync(directory)) {
        debugNotes("ensureDirectory: directory missing, creating recursively");
        fs.mkdirSync(directory, { recursive: true });
    }
}

function postPath(postsDirectory, postId) {
    debugValidation("postPath: validating post id format for %s", postId);
    if (!/^[0-9a-f-]{36}$/i.test(postId)) {
        debugValidation("postPath: invalid post id format rejected: %s", postId);
        return null;
    }
    debugNotes("postPath: building canonical post path for id %s", postId);
    return path.join(postsDirectory, `${postId}.json`);
}


function read(postsDirectory, postId) {
    debugServer("read: loading post from storage for id %s", postId);

    const filePath = postPath(postsDirectory, postId);
    if (!filePath) {
        debugValidation("read: refusing to read because post id did not validate");
        return null;
    }

    try {
        debugInternal("read: reading json file %s", filePath);
        const data = fs.readFileSync(filePath, "utf-8");
        debugNotes("read: transforming file content into post object");
        return JSON.parse(data);
    } catch (err) {
        if (err.code === "ENOENT") {
            debugInternal("read: post file not found for id %s", postId);
            return null;
        } else
            throw err;
    }
}

function list(postsDirectory) {
    debugServer("list: listing stored posts from %s", postsDirectory);

     return fs
      .readdirSync(postsDirectory, { withFileTypes: true })
      .filter((entry) => {
        const valid = entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name);
        if (!valid) {
          debugValidation("list: skipping non-post entry %s", entry.name);
        }
        return valid;
      })
      .map((entry) => read(postsDirectory, path.basename(entry.name, ".json")))
      .filter(Boolean)
      .map((post) => {
        debugNotes("list: including post id=%s actor=%s", post.id, post.actor);
        return post;
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

}

function create(postsDirectory, content, actor) {
    debugServer("create: creating post for actor %s", actor);
    if (typeof content !== "string") {
        debugValidation("create: content type rejected, expected string and got %s", typeof content);
        throw new Error("Content must be a string");
    }

    if(!content.length) {
        debugValidation("create: rejecting empty content");
        throw new Error("Content cannot be empty");
    }

    ensureDirectory(postsDirectory);

    debugNotes("create: building post payload and enriching with id and timestamp");
    const post = {
        id: crypto.randomUUID(),
        type: "Note",
        actor,
        content,
        createdAt: new Date().toISOString()
    };

    const finalPath = postPath(postsDirectory, post.id);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    debugInternal("create: writing temporary file %s before atomic rename", temporaryPath);
    fs.writeFileSync(temporaryPath, JSON.stringify(post, null, 2) + "\n", "utf-8");
    fs.renameSync(temporaryPath, finalPath);
    debugNotes("create: post persisted at %s", finalPath);

    return post;
}

module.exports = {
    create,
    list,
    read
};