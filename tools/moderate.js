#!/usr/bin/env node
"use strict";

/**
 * tools/moderate.js — the moderation API from the command line (Basic Auth).
 *
 *   node tools/moderate.js pending                 # queue, oldest first (what admin/index.html shows)
 *   node tools/moderate.js pending --kind clipboard
 *   node tools/moderate.js media <uploadId>        # download the pending file to tools/receipts/<id>.<ext>
 *   node tools/moderate.js approve <uploadId>      # ffmpeg strip + publish + federate + echo filters
 *   node tools/moderate.js reject <uploadId> [--reason "..."]
 *   node tools/moderate.js approve --all           # approve everything pending (local testing only)
 *
 * Credentials come from GSTMXX_ADMIN_USER / GSTMXX_ADMIN_PASS (env or the `env`
 * file), or --admin-user/--admin-pass. If neither is set the backend's
 * defaults are used, and the tool tells you so, because an internet-facing
 * instance still on the default password is the first thing to fix.
 *
 * `approve` prints the federation and echo summary the backend returns, then
 * fetches the resulting post through the three public representations
 * (ActivityPub JSON, HTML preview, RSS) so a run shows the "one record, four
 * surfaces" model concretely. For videos it also downloads the published file
 * and runs ffprobe to prove the metadata strip.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseArgs, loadConfig } = require("./lib/env");
const { request, basic, setVerbose, report } = require("./lib/http");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return; }
  const cfg = loadConfig(args);
  setVerbose(Boolean(args.verbose));
  const auth = { Authorization: basic(cfg.adminUser, cfg.adminPass) };
  if (cfg.adminPass === "change-me-now-2026") {
    console.log("[WARN] using the backend's DEFAULT admin password. Set GSTMXX_ADMIN_USER/GSTMXX_ADMIN_PASS.");
  }

  if (cmd === "pending") {
    const q = args.kind ? `?kind=${encodeURIComponent(args.kind)}` : "";
    const res = await request(`${cfg.baseUrl}/api/admin/pending${q}`, { headers: auth });
    if (res.status === 401) { console.error("401: wrong admin credentials."); process.exit(1); }
    const rows = res.body.pending || [];
    console.log(`${rows.length} pending upload(s)` + (rows.length ? ":" : "."));
    for (const r of rows) {
      console.log(`- ${r.id}  ${r.kind.padEnd(9)} ${r.createdAt}  ghostyle=${r.ghostyleId || "-"}  app=${r.appVersion || "-"}  consent=${r.consentVersion}`);
      if (r.userNote) console.log(`    note: ${JSON.stringify(r.userNote)}`);
      console.log(`    media: ${cfg.baseUrl}${r.mediaUrl}   (Basic Auth)`);
    }
    if (rows.length) console.log("\nNote: the moderator never sees metrics_json, and cannot edit the note that becomes the post text.");
    return;
  }

  if (cmd === "media") {
    const id = args._[1]; if (!id) throw new Error("media <uploadId>");
    const res = await fetch(`${cfg.baseUrl}/api/admin/media/${id}`, { headers: auth });
    if (!res.ok) { console.error(`HTTP ${res.status}: ${await res.text()}`); process.exit(1); }
    const ct = res.headers.get("content-type") || "";
    const ext = ct.includes("png") ? "png" : ct.includes("webm") ? "webm" : "mp4";
    const out = path.join(__dirname, "receipts", `${id}.${ext}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    console.log(`saved ${out} (${ct})`);
    return;
  }

  if (cmd === "reject") {
    const id = args._[1]; if (!id) throw new Error("reject <uploadId>");
    const res = await request(`${cfg.baseUrl}/api/admin/reject/${id}`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ reason: args.reason || "rejected via tools/moderate.js" })
    });
    console.log(`HTTP ${res.status}  ${res.body ? res.body.message : res.text}`);
    markReceipt(id, "rejected");
    return;
  }

  if (cmd === "approve") {
    let ids = args._.slice(1);
    if (args.all) {
      const res = await request(`${cfg.baseUrl}/api/admin/pending`, { headers: auth });
      ids = (res.body.pending || []).map((r) => r.id);
      if (!ids.length) { console.log("nothing pending."); return; }
    }
    if (!ids.length) throw new Error("approve <uploadId> | --all");
    for (const id of ids) await approve(cfg, auth, id, args);
    return;
  }

  throw new Error(`unknown command: ${cmd}`);
}

async function approve(cfg, auth, id, args) {
  const res = await request(`${cfg.baseUrl}/api/admin/approve/${id}`, { method: "POST", headers: auth });
  if (!res.ok) { console.log(`HTTP ${res.status}  ${res.body ? res.body.message : res.text}`); return; }
  const b = res.body;
  console.log(`HTTP 200  ${b.message}`);
  console.log(`actor        @${b.actor}   (ghostyle_id present → ghostyles; else video/clipboard by kind)`);
  console.log(`post         ${b.post.url}`);
  console.log(`media        ${b.publicUrl}${b.thumbnail ? "  thumb: /thumbnails/" + b.thumbnail : ""}`);
  const f = b.federation || {};
  console.log(`federation   Create → ${f.followers ?? 0} follower(s), ${f.delivered ?? 0} delivered, ${(f.failures || []).length} failed${f.error ? "  ERROR: " + f.error : ""}`);
  for (const e of b.echoes || []) {
    console.log(`echo         @${e.handle} Announce → ${e.followers ?? 0} follower(s), ${e.delivered ?? 0} delivered${e.error ? "  ERROR: " + e.error : ""}`);
  }
  markReceipt(id, "approved", { postId: b.post.id, postUrl: b.post.url, publicUrl: b.publicUrl });

  // Four surfaces of the same record.
  const postUrl = b.post.url.replace(cfg.publicUrl, cfg.baseUrl);
  const ap = await request(postUrl, { headers: { Accept: "application/activity+json" } });
  report(ap.status === 200 && ap.body && ap.body.type === "Note", "ActivityPub object", `${postUrl} → ${ap.status}, type=${ap.body && ap.body.type}, attributedTo=${ap.body && ap.body.attributedTo}`);
  const html = await request(postUrl, { headers: { Accept: "text/html" } });
  const og = /og:title" content="([^"]*)"/.exec(html.text);
  report(html.status === 200 && /<!doctype html>/i.test(html.text), "HTML preview", `og:title=${og ? og[1] : "?"}`);
  const rss = await request(`${cfg.baseUrl}/feed/${b.actor}.xml`);
  report(rss.status === 200 && rss.text.includes(b.post.id), `RSS /feed/${b.actor}.xml`, `contains the post: ${rss.text.includes(b.post.id)}`);
  const all = await request(`${cfg.baseUrl}/feed/all.xml`);
  report(all.status === 200 && all.text.includes(b.post.id), "RSS /feed/all.xml", `contains the post: ${all.text.includes(b.post.id)}`);

  // Metadata strip proof for videos.
  if (b.kind === "video" && !args["skip-ffprobe"]) {
    const mediaUrl = b.publicUrl.replace(cfg.publicUrl, cfg.baseUrl);
    const dl = await fetch(mediaUrl);
    if (dl.ok) {
      const tmp = path.join(__dirname, "receipts", `${id}.published.mp4`);
      fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", tmp], { encoding: "utf8" });
      if (probe.status === 0) {
        const tags = (JSON.parse(probe.stdout).format || {}).tags || {};
        const leaked = Object.keys(tags).filter((k) => !/^(major_brand|minor_version|compatible_brands|encoder)$/.test(k));
        report(leaked.length === 0, "published video metadata stripped", leaked.length ? `still present: ${leaked.join(", ")}` : `only container defaults remain (${Object.keys(tags).join(", ")})`);
      } else {
        report("INFO", "ffprobe not available here; skipped the metadata check");
      }
      fs.unlinkSync(tmp);
    }
  }
  if (b.kind === "clipboard") {
    report("INFO", "PNG published as submitted", "the backend does not rewrite PNGs; any tEXt/eXIf chunks in the upload are now public");
  }
}

function markReceipt(id, status, extra = {}) {
  const p = path.join(__dirname, "receipts", `${id}.json`);
  if (!fs.existsSync(p)) return;
  const r = JSON.parse(fs.readFileSync(p, "utf8"));
  Object.assign(r, extra, { status, moderatedAt: new Date().toISOString() });
  fs.writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
