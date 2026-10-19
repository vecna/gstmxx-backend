"use strict";

/**
 * @module tools/lib/env
 *
 * Shared configuration for the operator tools in `tools/`.
 *
 * Resolution order for every value: an explicit CLI flag, then the process
 * environment, then the repository `env` file (the same `KEY=value` file that
 * `npm start` loads through `--env-file-if-exists=env`), then a default.
 *
 * The tools talk to the backend over HTTP only, so they work equally against a
 * local instance and against production. Nothing here touches `data/` or
 * `storage/` directly, except `tools/sweep-now.js`, which says so.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

/**
 * Parse a `KEY=value` env file. Mirrors Node's `--env-file` rules closely
 * enough: blank lines and `#` comments skipped, optional surrounding quotes
 * removed, no shell expansion.
 *
 * @param {string} file
 * @returns {Record<string,string>}
 */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Minimal argv parser: `--key value`, `--key=value`, `--flag`, and positionals.
 * Repeated keys become arrays.
 *
 * @param {string[]} argv
 * @returns {{_: string[], [key:string]: any}}
 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    let key = a.slice(2);
    let value;
    const eq = key.indexOf("=");
    if (eq >= 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { value = argv[i + 1]; i += 1; }
    else value = true;
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

/**
 * Build the effective configuration for a tool run.
 *
 * @param {Object} args - Parsed CLI args (see {@link parseArgs}).
 * @returns {{
 *   baseUrl: string, publicUrl: string, postToken: ?string,
 *   adminUser: string, adminPass: string, envFile: string, root: string
 * }}
 */
function loadConfig(args = {}) {
  const envFile = args["env-file"] || process.env.GSTMXX_ENV_FILE || path.join(ROOT, "env");
  const fileEnv = readEnvFile(envFile);
  const get = (...keys) => {
    for (const k of keys) {
      if (process.env[k] != null && process.env[k] !== "") return process.env[k];
    }
    for (const k of keys) {
      if (fileEnv[k] != null && fileEnv[k] !== "") return fileEnv[k];
    }
    return undefined;
  };
  const port = get("PORT") || "4040";
  const baseUrl = String(args.url || get("LAB_API_URL") || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const publicUrl = String(get("GSTMXX_PUBLIC_URL", "LAB_BASE_URL") || baseUrl).replace(/\/+$/, "");
  return {
    baseUrl,
    publicUrl,
    postToken: args.token || get("LAB_POST_TOKEN") || null,
    adminUser: args["admin-user"] || get("GSTMXX_ADMIN_USER") || "admin",
    adminPass: args["admin-pass"] || get("GSTMXX_ADMIN_PASS") || "change-me-now-2026",
    envFile,
    root: ROOT
  };
}

/**
 * True when the base URL points at this machine. Used by the tools that create
 * public posts to refuse a remote target unless explicitly allowed.
 * @param {string} baseUrl
 * @returns {boolean}
 */
function isLocalUrl(baseUrl) {
  try {
    const { hostname } = new URL(baseUrl);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

module.exports = { ROOT, readEnvFile, parseArgs, loadConfig, isLocalUrl };
