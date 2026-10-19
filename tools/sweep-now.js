#!/usr/bin/env node
"use strict";

/**
 * tools/sweep-now.js — run the stale-upload sweep immediately, on the backend host.
 *
 *   node tools/sweep-now.js                  # dry run: list what the 14-day rule would remove now
 *   node tools/sweep-now.js --apply          # actually remove
 *   node tools/sweep-now.js --stale-days 1           # a different threshold (must be > 0)
 *   node tools/sweep-now.js --all-pending --apply    # treat every pending upload as stale (local testing)
 *   node tools/sweep-now.js --now 2026-12-01T00:00:00Z  # evaluate the rule as if it were that date
 *
 * fediverse.html: "Pending media that has not been reviewed is automatically
 * removed after 14 days." The backend does this with an hourly timer
 * (services/cleanup.js) and there is no HTTP endpoint to trigger it, so this
 * tool calls the same function directly. It therefore has to run on the same
 * machine as the backend, with the same `env` (LAB_DATA_DIR, GSTMXX_STORAGE_DIR),
 * because it reads and writes data/uploads and storage/incoming.
 *
 * The store is plain files with atomic writes, so running this while the server
 * is up is what the server's own timer does anyway.
 */

const path = require("node:path");
const { parseArgs, loadConfig, readEnvFile } = require("./lib/env");

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args);

// Load the env file into process.env (without overriding real env) so paths.js
// resolves LAB_DATA_DIR / GSTMXX_STORAGE_DIR the way the server does.
for (const [k, v] of Object.entries(readEnvFile(cfg.envFile))) {
  if (process.env[k] == null) process.env[k] = v;
}

const paths = require(path.join(cfg.root, "paths.js"));
const uploadStore = require(path.join(cfg.root, "uploadStore.js"));
const cleanup = require(path.join(cfg.root, "services", "cleanup.js"));

const staleDays = args["stale-days"] != null ? Number(args["stale-days"]) : Number(process.env.GSTMXX_STALE_DAYS || uploadStore.DEFAULT_STALE_DAYS);
if (!(staleDays > 0)) { console.error("--stale-days must be > 0 (the store falls back to 14 otherwise). Use --all-pending to sweep everything."); process.exit(2); }
// `--all-pending` moves the clock far enough ahead that every pending row is past the threshold.
const now = args["all-pending"] ? Date.now() + (staleDays + 1) * 24 * 60 * 60 * 1000 : args.now ? new Date(args.now).getTime() : Date.now();
const dirs = { incoming: paths.STORAGE_INCOMING_DIR, approved: paths.STORAGE_APPROVED_DIR, thumbnails: paths.STORAGE_THUMBNAILS_DIR };

console.log(`uploads ledger  ${paths.UPLOADS_DIR}`);
console.log(`incoming media  ${dirs.incoming}`);
console.log(`stale after     ${staleDays} day(s)`);
console.log(`evaluated at    ${new Date(now).toISOString()}${args["all-pending"] ? "  (--all-pending: clock moved forward)" : ""}\n`);

const stale = uploadStore.findStale(paths.UPLOADS_DIR, { staleDays, now });
if (!stale.length) { console.log("nothing pending is older than the threshold."); process.exit(0); }
for (const r of stale) console.log(`- ${r.id}  ${r.kind}  created ${r.createdAt}  ghostyle=${r.ghostyleId || "-"}`);

if (!args.apply) {
  console.log(`\n${stale.length} would be removed. Re-run with --apply to do it.`);
  process.exit(0);
}
const result = cleanup.runSweep({ uploadStore, uploadsDir: paths.UPLOADS_DIR, dirs, staleDays, now });
console.log(`\nscanned ${result.scanned}, deleted ${result.deleted}. Ledger rows are kept with status "deleted"; media files are gone.`);
