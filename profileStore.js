"use strict";

/**
 * @module profileStore
 *
 * Durable per-actor profile: display name, biography, profile fields, avatar
 * and header image.
 *
 * Storage layout
 * --------------
 *   data/profiles.json        one record per actor handle
 *   storage/profile/<file>    the avatar/header bytes, content-addressed
 *
 * The filename carries a hash of the bytes (`video-avatar-1f3a9c02.png`).
 * That matters for federation: Mastodon caches remote avatars *by URL*, so a
 * new image must arrive at a new URL or it will never be re-fetched. Deriving
 * the URL from the content gives that for free and makes the media immutable
 * and safely cacheable forever.
 *
 * Bio HTML is sanitised down to the tag set Mastodon itself renders, so what
 * the operator writes is what remote timelines show.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** Tags kept in a biography. Everything else is unwrapped or escaped. */
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "a",
  "span",
  "em",
  "strong",
  "b",
  "i",
  "code",
  "del",
  "ul",
  "ol",
  "li"
]);

/** Raster formats remote servers actually accept for avatars and headers. */
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

/** Mastodon rejects avatars and headers above 2 MB. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Mastodon renders at most four profile fields. */
const MAX_FIELDS = 4;

const MAX_NAME_CHARS = 60;
const MAX_SUMMARY_CHARS = 2200;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value) {
  try {
    const url = new URL(String(value).trim());
    if (!["http:", "https:", "mailto:", "xmpp:"].includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Reduce arbitrary HTML to the small tag set above.
 *
 * Implemented as a single forward scan rather than a regex replace so that a
 * malformed or nested tag cannot smuggle an attribute through: anything that is
 * not an allowed tag becomes escaped text.
 *
 * @param {string} html
 * @returns {string}
 */
function sanitizeHtml(html) {
  const input = String(html || "");
  const voidTags = new Set(["br"]);
  // Each entry records the tag we *emitted* for a tag we *read*, because an
  // anchor without a usable href is downgraded to a span and must still be
  // closed as a span. Emitting </a> for a <span> would corrupt the document.
  const open = [];
  let out = "";
  let index = 0;

  while (index < input.length) {
    const lt = input.indexOf("<", index);
    if (lt === -1) {
      out += escapeHtml(input.slice(index));
      break;
    }
    out += escapeHtml(input.slice(index, lt));
    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      out += escapeHtml(input.slice(lt));
      break;
    }
    const raw = input.slice(lt + 1, gt);
    index = gt + 1;

    const closing = raw.startsWith("/");
    const body = closing ? raw.slice(1) : raw;
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body.trim());
    const name = nameMatch ? nameMatch[1].toLowerCase() : null;

    if (!name || !ALLOWED_TAGS.has(name)) continue; // drop the tag, keep the text

    if (closing) {
      if (voidTags.has(name)) continue;
      const top = open[open.length - 1];
      if (top && top.source === name) {
        open.pop();
        out += `</${top.emitted}>`;
      }
      continue;
    }
    if (voidTags.has(name)) {
      out += "<br>";
      continue;
    }
    if (name === "a") {
      const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(body);
      const href = hrefMatch
        ? safeHref(hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4])
        : null;
      if (href) {
        out += `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer" target="_blank">`;
        open.push({ source: "a", emitted: "a" });
      } else {
        out += "<span>";
        open.push({ source: "a", emitted: "span" });
      }
      continue;
    }
    out += `<${name}>`;
    open.push({ source: name, emitted: name });
  }

  while (open.length) out += `</${open.pop().emitted}>`;
  return out.trim();
}

/**
 * Turn operator-authored plain text into the HTML a bio needs: blank lines
 * become paragraphs, single newlines become `<br>`, bare URLs become links.
 *
 * @param {string} text
 * @returns {string}
 */
function textToHtml(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const withBreaks = paragraph
        .split("\n")
        .map((line) => autolink(line))
        .join("<br>");
      return `<p>${withBreaks}</p>`;
    })
    .join("");
}

function autolink(line) {
  const pattern = /(https?:\/\/[^\s<>"']+)/g;
  let out = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, match.index));
    const href = safeHref(match[1]);
    out += href
      ? `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer" target="_blank">${escapeHtml(
          href.replace(/^https?:\/\//, "").replace(/\/$/, "")
        )}</a>`
      : escapeHtml(match[1]);
    last = match.index + match[1].length;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

/**
 * Normalise a profile field pair into the `PropertyValue` shape Mastodon draws
 * in the sidebar. A value that parses as a URL becomes a link.
 *
 * @param {{name?:string, value?:string}} field
 * @returns {{name:string, value:string}|null}
 */
function normalizeField(field) {
  if (!field || typeof field !== "object") return null;
  const name = String(field.name ?? "").trim().slice(0, 60);
  const rawValue = String(field.value ?? "").trim();
  if (!name || !rawValue) return null;
  const href = safeHref(rawValue);
  const value = href
    ? `<a href="${escapeHtml(href)}" rel="me nofollow noopener noreferrer" target="_blank">${escapeHtml(
        href.replace(/^https?:\/\//, "").replace(/\/$/, "")
      )}</a>`
    : sanitizeHtml(rawValue) || escapeHtml(rawValue);
  return { name, value };
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

/**
 * Create a profile store bound to a data directory and a media directory.
 *
 * @param {Object} options
 * @param {string} options.dataDir - Durable state directory (`data/`).
 * @param {string} options.mediaDir - Where avatar/header bytes live.
 * @returns {Object} The store API.
 */
function createProfileStore({ dataDir, mediaDir }) {
  const file = path.join(dataDir, "profiles.json");

  function readAll() {
    const all = readJson(file, {});
    return all && typeof all === "object" ? all : {};
  }

  /**
   * The stored record for a handle, or an empty record.
   * @param {string} handle
   * @returns {Object}
   */
  function read(handle) {
    const record = readAll()[handle];
    return record && typeof record === "object" ? record : {};
  }

  /**
   * Merge a partial update into a handle's record.
   *
   * `null` clears a key; `undefined` leaves it untouched. That distinction is
   * what lets the CLI say "remove the header" without also wiping the bio.
   *
   * @param {string} handle
   * @param {Object} patch
   * @returns {Object} The stored record after the merge.
   */
  function update(handle, patch) {
    const all = readAll();
    const current = all[handle] && typeof all[handle] === "object" ? all[handle] : {};
    const next = { ...current };

    for (const [key, value] of Object.entries(patch || {})) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = value;
    }
    next.updatedAt = new Date().toISOString();
    all[handle] = next;
    writeJsonAtomic(file, all);
    return next;
  }

  /**
   * Store image bytes under a content-addressed name and return the record to
   * put on the profile.
   *
   * @param {string} handle
   * @param {"avatar"|"header"} kind
   * @param {Buffer} bytes
   * @param {string} mediaType
   * @returns {{file:string, mediaType:string, bytes:number, hash:string}}
   */
  function putMedia(handle, kind, bytes, mediaType) {
    const extension = ALLOWED_IMAGE_TYPES.get(String(mediaType).toLowerCase());
    if (!extension) {
      throw Object.assign(
        new Error(
          `Unsupported image type "${mediaType}". Use one of: ${[...ALLOWED_IMAGE_TYPES.keys()].join(", ")}. ` +
            "SVG is rejected by Mastodon for avatars and headers."
        ),
        { status: 400 }
      );
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw Object.assign(new Error("The image body is empty."), { status: 400 });
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw Object.assign(
        new Error(
          `The image is ${(bytes.length / 1024 / 1024).toFixed(2)} MB; the limit is 2 MB.`
        ),
        { status: 413 }
      );
    }
    const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    const name = `${handle}-${kind}-${hash}.${extension}`;
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, name), bytes);
    return { file: name, mediaType: String(mediaType).toLowerCase(), bytes: bytes.length, hash };
  }

  /**
   * Read stored media bytes by filename, refusing anything outside mediaDir.
   * @param {string} name
   * @returns {Buffer|null}
   */
  function readMedia(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(name || ""))) return null;
    const full = path.join(mediaDir, name);
    if (!full.startsWith(path.resolve(mediaDir))) return null;
    try {
      return fs.readFileSync(full);
    } catch {
      return null;
    }
  }

  /**
   * Delete media files for a handle that no profile references any more.
   * @param {string} handle
   * @returns {number} How many files were removed.
   */
  function pruneMedia(handle) {
    const record = read(handle);
    const keep = new Set(
      [record.avatar?.file, record.header?.file].filter(Boolean)
    );
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(mediaDir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${handle}-`)) continue;
      if (keep.has(entry)) continue;
      try {
        fs.unlinkSync(path.join(mediaDir, entry));
        removed += 1;
      } catch {
        /* best effort */
      }
    }
    return removed;
  }

  return { file, read, readAll, update, putMedia, readMedia, pruneMedia };
}

/**
 * Validate and normalise an incoming profile payload from the API.
 *
 * @param {Object} input
 * @returns {Object} A patch suitable for {@link createProfileStore}'s `update`.
 */
function normalizeProfileInput(input) {
  const patch = {};
  const body = input && typeof input === "object" ? input : {};

  if ("displayName" in body) {
    const name = body.displayName === null ? null : String(body.displayName).trim();
    if (name && name.length > MAX_NAME_CHARS) {
      throw Object.assign(
        new Error(`displayName is longer than ${MAX_NAME_CHARS} characters.`),
        { status: 400 }
      );
    }
    patch.displayName = name || null;
  }

  if ("summaryHtml" in body || "summaryText" in body) {
    const html =
      "summaryHtml" in body && body.summaryHtml != null
        ? sanitizeHtml(body.summaryHtml)
        : body.summaryText != null
          ? textToHtml(body.summaryText)
          : null;
    if (html && html.length > MAX_SUMMARY_CHARS) {
      throw Object.assign(
        new Error(`The biography renders to ${html.length} characters; the limit is ${MAX_SUMMARY_CHARS}.`),
        { status: 400 }
      );
    }
    patch.summaryHtml = html || null;
  }

  if ("fields" in body) {
    if (body.fields === null) {
      patch.fields = null;
    } else {
      if (!Array.isArray(body.fields)) {
        throw Object.assign(new Error("fields must be an array."), { status: 400 });
      }
      const fields = body.fields.map(normalizeField).filter(Boolean);
      if (fields.length > MAX_FIELDS) {
        throw Object.assign(
          new Error(`At most ${MAX_FIELDS} profile fields are rendered by Mastodon.`),
          { status: 400 }
        );
      }
      patch.fields = fields.length ? fields : null;
    }
  }

  if ("url" in body) {
    if (body.url === null || body.url === "") patch.url = null;
    else {
      const href = safeHref(body.url);
      if (!href) {
        throw Object.assign(new Error("url must be an absolute http(s) URL."), {
          status: 400
        });
      }
      patch.url = href;
    }
  }

  for (const flag of ["discoverable", "indexable"]) {
    if (flag in body) {
      patch[flag] = body[flag] === null ? null : Boolean(body[flag]);
    }
  }

  if ("avatarUrl" in body) {
    patch.avatar = body.avatarUrl ? { url: requireHref(body.avatarUrl, "avatarUrl") } : null;
  }
  if ("headerUrl" in body) {
    patch.header = body.headerUrl ? { url: requireHref(body.headerUrl, "headerUrl") } : null;
  }

  return patch;
}

function requireHref(value, field) {
  const href = safeHref(value);
  if (!href) {
    throw Object.assign(new Error(`${field} must be an absolute http(s) URL.`), {
      status: 400
    });
  }
  return href;
}

module.exports = {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  createProfileStore,
  normalizeField,
  normalizeProfileInput,
  sanitizeHtml,
  textToHtml
};
