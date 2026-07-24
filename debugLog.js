const crypto = require("node:crypto");
const createDebug = require("debug");

const namespaces = {
  activitypub: createDebug("fedibasic:activitypub"),
  flow: createDebug("fedibasic:flow"),
  http: createDebug("fedibasic:http"),
  store: createDebug("fedibasic:store")
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

function event(namespace, name, fields) {
  const suffix = formatFields(fields);
  namespaces[namespace]("%s%s", name, suffix ? ` ${suffix}` : "");
}

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
