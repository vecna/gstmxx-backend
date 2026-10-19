"use strict";

/**
 * @module tools/lib/http
 *
 * Thin fetch helpers shared by the operator tools. Every request is printed in
 * a `curl`-like form when `--verbose` is set, so a run doubles as a worked
 * example of the HTTP contract. No dependencies: Node >= 20 ships `fetch`,
 * `FormData`, `Blob` and `fs.openAsBlob`.
 */

const fs = require("node:fs");
const path = require("node:path");

let verbose = false;

/** @param {boolean} on */
function setVerbose(on) { verbose = Boolean(on); }

/**
 * Perform a request and return `{ status, headers, body, text }` where `body`
 * is parsed JSON when the response is JSON, else `null`.
 *
 * @param {string} url
 * @param {RequestInit & {label?: string}} [init]
 * @returns {Promise<{status:number, ok:boolean, headers:Headers, body:any, text:string}>}
 */
async function request(url, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  if (verbose) {
    const hdrs = Object.entries(init.headers || {}).map(([k, v]) => `  -H '${k}: ${redact(k, v)}'`).join("\n");
    const bodyNote = init.body instanceof FormData
      ? "  (multipart/form-data: " + [...init.body.keys()].join(", ") + ")"
      : typeof init.body === "string" ? `  -d '${init.body}'` : "";
    console.log(`\n> ${method} ${url}${hdrs ? "\n" + hdrs : ""}${bodyNote ? "\n" + bodyNote : ""}`);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  const ct = res.headers.get("content-type") || "";
  if (/json/.test(ct)) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (verbose) {
    console.log(`< ${res.status} ${res.statusText}  (${ct.split(";")[0] || "no content-type"}, ${text.length} bytes)`);
    if (body) console.log(indent(JSON.stringify(body, null, 2)));
    else if (text && text.length < 600) console.log(indent(text));
  }
  return { status: res.status, ok: res.ok, headers: res.headers, body, text };
}

function redact(name, value) {
  if (/authorization|x-delete-token/i.test(name)) return String(value).slice(0, 12) + "…";
  return value;
}

function indent(s) { return String(s).split("\n").map((l) => "  " + l).join("\n"); }

/** Basic-Auth header value. */
function basic(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/**
 * Build the exact multipart body the lab client sends
 * (`lab-js/upload-consent.js` → `buildUploadFormData`).
 *
 * @param {Object} o
 * @param {string} o.file - Path to the media file.
 * @param {"video"|"clipboard"} [o.kind="video"]
 * @param {string} [o.consentVersion="2026-07-v1"] - Must match `UPLOAD_CONSENT_VERSION` in the client.
 * @param {string} [o.appVersion="0.1.0"]
 * @param {string} [o.ghostyleId]
 * @param {string} [o.note]
 * @param {Object|string} [o.metrics]
 * @param {string} [o.mimeType] - Override the sniffed MIME type (to test rejections).
 * @returns {Promise<FormData>}
 */
async function buildUploadForm(o) {
  const kind = o.kind || "video";
  const ext = path.extname(o.file).toLowerCase();
  const mime = o.mimeType || (
    ext === ".png" ? "image/png"
      : ext === ".webm" ? "video/webm"
        : ext === ".ogg" || ext === ".ogv" ? "video/ogg"
          : ext === ".txt" ? "text/plain"
            : "video/mp4");
  const blob = await fs.openAsBlob(o.file, { type: mime });
  const fd = new FormData();
  // The field is named `video` for both kinds; that is what multer expects.
  fd.append("video", blob, path.basename(o.file));
  fd.set("kind", kind);
  if (o.consentVersion !== null) fd.set("consent_version", o.consentVersion || "2026-07-v1");
  fd.set("app_version", o.appVersion || "0.1.0");
  if (o.ghostyleId) fd.set("ghostyle_id", o.ghostyleId);
  if (o.note) fd.set("user_note", o.note);
  if (o.metrics) fd.set("metrics_json", typeof o.metrics === "string" ? o.metrics : JSON.stringify(o.metrics));
  return fd;
}

/** Print a PASS/FAIL/WARN line. */
function report(status, label, detail) {
  const tag = status === true || status === "PASS" ? "PASS" : status === "WARN" ? "WARN" : status === "INFO" ? "INFO" : "FAIL";
  console.log(`[${tag}] ${label}${detail ? "  — " + detail : ""}`);
  return tag;
}

module.exports = { request, basic, buildUploadForm, setVerbose, report };
