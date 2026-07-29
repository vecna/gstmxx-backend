/**
 * @module debugLog
 *
 * Structured, quiet-by-default diagnostics on the `gstmxx:*` DEBUG namespaces
 * (`gstmxx:flow` for per-request state transitions, plus `http`, `store`,
 * `activitypub`). Tokens and full post bodies are deliberately never logged.
 * Enable with e.g. `DEBUG=gstmxx:flow node server.js`.
 */

const crypto = require("node:crypto");
const createDebug = require("debug");

const namespaces = {
  activitypub: createDebug("gstmxx:activitypub"),
  flow: createDebug("gstmxx:flow"),
  http: createDebug("gstmxx:http"),
  store: createDebug("gstmxx:store")
};

function printable(value) {
  if (value instanceof URL) return value.href;
  if (value instanceof Error) {
    return value.cause ? `${value.message} (${printable(value.cause)})` : value.message;
  }
  if (typeof value === "string") {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

function formatFields(fields = {}) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${printable(value)}`)
    .join(" ");
}

/**
 * Emit a one-line structured event on a namespace.
 * @param {"activitypub"|"flow"|"http"|"store"} namespace
 * @param {string} name - Event name, e.g. `"post.write.done"`.
 * @param {Object} [fields] - Key/value context; `undefined` values are dropped.
 * @returns {void}
 */
function event(namespace, name, fields) {
  const suffix = formatFields(fields);
  namespaces[namespace]("%s%s", name, suffix ? ` ${suffix}` : "");
}

/**
 * Build a per-request flow logger with a short correlation id and numbered
 * state transitions on `gstmxx:flow`.
 * @param {import("express").Request} req
 * @returns {{id:string, next:(name:string, fields?:Object)=>void}}
 */
function createRequestFlow(req) {
  const id = req.get("x-request-id") || crypto.randomUUID().slice(0, 8);
  let step = 0;

  return {
    id,
    next(name, fields) {
      step += 1;
      const suffix = formatFields(fields);
      namespaces.flow(
        "[%s] %s %s%s",
        id,
        String(step).padStart(2, "0"),
        name,
        suffix ? ` ${suffix}` : ""
      );
    }
  };
}

module.exports = {
  createRequestFlow,
  event
};

