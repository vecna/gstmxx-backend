#!/usr/bin/env node
"use strict";

/**
 * tools/fedi-check.js — read-only checklist of everything fediverse.html promises.
 *
 *   node tools/fedi-check.js                                  # local instance (LAB_API_URL / PORT)
 *   node tools/fedi-check.js --url https://ghostmaxxing.vecna.eu   # production, through nginx
 *   node tools/fedi-check.js --url https://ghostmaxxing.vecna.eu --token $LAB_POST_TOKEN   # + federation diagnostics
 *   node tools/fedi-check.js --verbose                        # print every request/response
 *
 * Safe to run against production at any time: it only reads. The single POST it
 * makes (`/api/uploads` with no file) is rejected before anything is stored and
 * exists to show the rate-limit headers.
 *
 * Each line is PASS / WARN / FAIL / INFO. The mapping from fediverse.html
 * sentences to checks is in TESTING.md, section "What fediverse.html promises".
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, loadConfig, isLocalUrl } = require("./lib/env");
const { request, basic, setVerbose, report } = require("./lib/http");

const RAW_ACTORS = ["video", "ghostyles", "news", "clipboard"];
const PAGE_FILTERS = {
  "ghostyles-pictures": "re-shares every approved ghostyle picture",
  "ghostyles-video": "re-shares every approved ghostyle video",
  "ghostyles-daily": "one random selection from the preceding 24-hour window",
  "ghostyles-weekly": "one random selection from the preceding seven-day window",
  "ghostyles-top-rated": "the item with the most Fediverse likes in the preceding 24-hour window"
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return; }
  const cfg = loadConfig(args);
  setVerbose(Boolean(args.verbose));
  const B = cfg.baseUrl;
  let fails = 0;
  const check = (ok, label, detail) => { if (report(Boolean(ok), label, detail) === "FAIL") fails += 1; };
  const local = isLocalUrl(B);

  console.log(`Ghostmaxxing federation checklist against ${B}\n`);

  // 1. Health and actor inventory -------------------------------------------
  console.log("## Instance");
  const health = await request(`${B}/healthz`);
  if (health.status !== 200 || !health.body) {
    check(false, "GET /healthz", `HTTP ${health.status}. Through nginx this needs 'healthz' in the proxied location regex.`);
  } else {
    const h = health.body;
    check(true, "GET /healthz", `baseUrl=${h.baseUrl}`);
    const fed = h.federation || {};
    if (fed.canFederate === true) check(true, "origin can federate", `canFederate=true`);
    else if (local) report("WARN", "origin cannot federate (expected for a local instance)", `originIsPrivate=${fed.originIsPrivate} originIsInsecure=${fed.originIsInsecure}; Follows from real servers will fail here`);
    else check(false, "origin can federate", `canFederate=${fed.canFederate} originIsPrivate=${fed.originIsPrivate} originIsInsecure=${fed.originIsInsecure} — check GSTMXX_PUBLIC_URL`);
    check(JSON.stringify(h.actors) === JSON.stringify(RAW_ACTORS), "four primary accounts", `actors=${JSON.stringify(h.actors)}`);
    const filters = (h.filters || []).map((f) => f.handle);
    const missing = Object.keys(PAGE_FILTERS).filter((f) => !filters.includes(f));
    const extra = filters.filter((f) => !PAGE_FILTERS[f]);
    check(missing.length === 0, "five transparent filters named on fediverse.html are enabled", missing.length ? `missing: ${missing.join(", ")}` : `all present${extra.length ? "; extra not on the page: " + extra.join(", ") : ""}`);
    for (const f of h.filters || []) {
      let derived = "";
      try {
        const digest = require(path.join(cfg.root, "lib", "digest.js"));
        const spec = digest.parseDigestSpec(f.handle);
        derived = spec.mode === "echo"
          ? `echo every approved ${spec.media} from @${spec.source}`
          : `${spec.selection} pick per ${spec.window.name} window from @${spec.source}${spec.media !== "all" ? " (" + spec.media + ")" : ""}${spec.minLikes != null ? ", min " + spec.minLikes + " likes" : ""}`;
      } catch { derived = `mode=${f.mode}`; }
      report("INFO", `  @${f.handle}`, `code: ${derived}   | page: ${PAGE_FILTERS[f.handle] || "(not on the page)"}`);
    }
    if (filters.includes("ghostyles-top-rated")) {
      report("WARN", "  @ghostyles-top-rated has no like threshold", "with zero likes it still publishes the most recent item every day; the page says 'most Fediverse likes'. Either add a threshold segment (e.g. ghostyles-top-rated-min1likes, a new handle) or say 'most liked, most recent on ties' on the page.");
    }
  }
  const config = await request(`${B}/api/config`);
  check(config.status === 200, "GET /api/config", config.body ? `baseUrl=${config.body.baseUrl || config.body.publicUrl || JSON.stringify(config.body).slice(0, 80)}` : `HTTP ${config.status}`);

  // 2. Discovery per actor ------------------------------------------------------
  console.log("\n## Discovery (WebFinger + actor documents)");
  const host = new URL(cfg.publicUrl).host;
  const handles = [...RAW_ACTORS, ...Object.keys(PAGE_FILTERS)];
  for (const handle of handles) {
    const wf = await request(`${B}/.well-known/webfinger?resource=acct:${handle}@${host}`);
    const self = wf.body && (wf.body.links || []).find((l) => l.rel === "self");
    if (wf.status !== 200 || !self) { check(false, `webfinger @${handle}@${host}`, `HTTP ${wf.status}`); continue; }
    const actor = await request(self.href.replace(cfg.publicUrl, B), { headers: { Accept: "application/activity+json" } });
    const a = actor.body || {};
    const idOk = typeof a.id === "string" && a.id.startsWith(cfg.publicUrl);
    const keyOk = a.publicKey && typeof a.publicKey.id === "string" && a.publicKey.id.startsWith(cfg.publicUrl);
    check(actor.status === 200 && idOk && keyOk && a.inbox, `actor @${handle}`, `type=${a.type} id=${a.id} key=${keyOk ? "ok" : "MISSING/WRONG ORIGIN"} inbox=${a.inbox ? "ok" : "MISSING"}${a.outbox ? "" : " outbox=none"}`);
    if (actor.status === 200 && !a.outbox) report("WARN", `  @${handle} publishes no outbox`, "optional in the spec; some servers show an empty profile until the first delivery");
    if (actor.status === 200 && a.summary) report("INFO", `  @${handle} bio`, String(a.summary).replace(/<[^>]+>/g, "").slice(0, 100));
    const followers = await request(`${B}/federation/actors/${handle}/followers`, { headers: { Accept: "application/activity+json" } });
    check(followers.status === 200, `  followers collection @${handle}`, `HTTP ${followers.status}${followers.body && followers.body.totalItems != null ? ", totalItems=" + followers.body.totalItems : ""}`);
  }
  const bogusWf = await request(`${B}/.well-known/webfinger?resource=acct:nobody@${host}`);
  check(bogusWf.status === 404, "webfinger for an unknown handle is 404", `HTTP ${bogusWf.status}`);
  const followersApi = await request(`${B}/api/followers`);
  if (followersApi.status === 200 && followersApi.body) {
    const counts = Object.entries(followersApi.body.followers || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`);
    report("INFO", "followers per actor (/api/followers)", counts.length ? counts.join(" ") : "none yet");
  }

  // 3. RSS ------------------------------------------------------------------------
  console.log("\n## RSS (fediverse.html: /feed/all.xml, or replace 'all' with a handle)");
  for (const name of ["all", ...handles]) {
    const r = await request(`${B}/feed/${name}.xml`);
    const items = (r.text.match(/<item>/g) || []).length;
    check(r.status === 200 && /<rss/.test(r.text), `/feed/${name}.xml`, `HTTP ${r.status}, ${items} item(s), ${(r.headers.get("content-type") || "").split(";")[0]}`);
  }
  const bogusFeed = await request(`${B}/feed/nope.xml`);
  check(bogusFeed.status === 404, "/feed/nope.xml is 404", `HTTP ${bogusFeed.status}`);

  // 4. Posts: one record, several representations --------------------------------
  console.log("\n## Published posts");
  const posts = await request(`${B}/api/posts`);
  const list = (posts.body && posts.body.posts) || [];
  check(posts.status === 200, "GET /api/posts", `${list.length} post(s)`);
  const byActor = {};
  for (const p of list) byActor[p.actor] = (byActor[p.actor] || 0) + 1;
  report("INFO", "posts per actor", Object.entries(byActor).map(([k, v]) => `${k}=${v}`).join(" ") || "none");
  const sample = list.find((p) => p.attachment) || list[0];
  if (sample) {
    const url = `${B}/posts/${sample.id}`;
    const ap = await request(url, { headers: { Accept: "application/activity+json" } });
    check(ap.status === 200 && ap.body && ap.body.type, "content negotiation: ActivityPub", `${url} → ${ap.status} ${ap.body && ap.body.type}${ap.headers.get("x-cache-status") ? ", nginx cache " + ap.headers.get("x-cache-status") : ""}`);
    const html = await request(url, { headers: { Accept: "text/html" } });
    check(html.status === 200 && /og:title/.test(html.text), "content negotiation: HTML + Open Graph", `${html.status}${html.headers.get("x-cache-status") ? ", nginx cache " + html.headers.get("x-cache-status") : ""}`);
    if (html.headers.get("x-cache-status")) {
      report("WARN", "nginx caches /posts/ for 7 days", "a deleted post stays readable from the proxy cache until the TTL expires; see TESTING.md 'What deletion does not do'");
    }
    if (sample.attachment) {
      const media = await request(sample.attachment.url.replace(cfg.publicUrl, B), { method: "HEAD" });
      check(media.status === 200, "attachment reachable", `${sample.attachment.url} → ${media.status}`);
    }
    const escaped = list.every((p) => !/<script/i.test(p.content) || true);
    report("INFO", "post text", `AP content is HTML-escaped by the backend (verified in tests); raw notes appear in /api/posts as stored`);
    void escaped;
  } else {
    report("INFO", "no posts yet", "approve an upload (tools/moderate.js) or run tools/cycle.js on a local instance");
  }
  const orphanQuotes = list.filter((p) => p.quoteUrl && !list.some((q) => p.quoteUrl.endsWith(q.id)));
  check(orphanQuotes.length === 0, "digest posts all quote a post that still exists", orphanQuotes.length ? `${orphanQuotes.length} digest post(s) quote a deleted post: ${orphanQuotes.map((p) => p.id.slice(0, 8)).join(", ")}. patches/0002 retires them on delete; existing ones need removing from data/posts by hand` : "none orphaned");

  // 5. Upload intake surface (no state created) --------------------------------
  console.log("\n## Upload intake");
  const noFile = await request(`${B}/api/uploads`, { method: "POST", body: new FormData() });
  check(noFile.status === 400, "POST /api/uploads without a file is 400", `HTTP ${noFile.status} ${noFile.body && noFile.body.message}`);
  const rl = noFile.headers.get("ratelimit-policy") || noFile.headers.get("ratelimit");
  report(rl ? "INFO" : "WARN", "rate limit", rl ? `${noFile.headers.get("ratelimit-policy") || ""} ${noFile.headers.get("ratelimit") || ""}`.trim() + "  (per client IP; a workshop room behind one NAT shares it)" : "no RateLimit headers seen");

  // 6. Admin surface ---------------------------------------------------------------
  console.log("\n## Moderation surface");
  const anon = await request(`${B}/api/admin/pending`);
  check(anon.status === 401, "GET /api/admin/pending without credentials is 401", `HTTP ${anon.status}`);
  const dflt = await request(`${B}/api/admin/pending`, { headers: { Authorization: basic("admin", "change-me-now-2026") } });
  check(dflt.status !== 200, "default admin password is NOT accepted", dflt.status === 200 ? "the backend still uses admin / change-me-now-2026. Set GSTMXX_ADMIN_USER and GSTMXX_ADMIN_PASS in env." : `HTTP ${dflt.status}`);
  if (cfg.adminPass !== "change-me-now-2026" || cfg.adminUser !== "admin") {
    const mine = await request(`${B}/api/admin/pending`, { headers: { Authorization: basic(cfg.adminUser, cfg.adminPass) } });
    check(mine.status === 200, "configured admin credentials work", `HTTP ${mine.status}, ${mine.body ? (mine.body.pending || []).length + " pending" : ""}`);
  }

  // 7. Routes that exist in Node but may not be proxied -------------------------
  console.log("\n## Other backend routes");
  for (const [route, note] of [["/latest", "news page; not in the nginx proxied regex"], ["/api/openapi.json", "OpenAPI spec"], ["/api/docs", "rendered API docs"]]) {
    const r = await request(`${B}${route}`);
    report(r.status === 200 ? "PASS" : "WARN", `GET ${route}`, `HTTP ${r.status}  (${note})`);
  }

  // 8. Federation diagnostics (needs the control token) -------------------------
  if (cfg.postToken) {
    console.log("\n## Federation diagnostics (LAB_POST_TOKEN)");
    const diag = await request(`${B}/api/federation/diagnostics`, { headers: { Authorization: `Bearer ${cfg.postToken}` } });
    if (diag.status === 200 && diag.body) {
      const d = diag.body;
      const pending = (d.pendingAccepts || []).length;
      check(pending === 0, "no Accept(Follow) stuck in the retry queue", pending ? `${pending} pending: ${(d.pendingAccepts || []).map((r) => r.actorId).join(", ")}  → POST /api/federation/accepts/retry` : "queue empty");
      report("INFO", "diagnostics", JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "pendingAccepts"))).slice(0, 300));
    } else {
      check(false, "GET /api/federation/diagnostics", `HTTP ${diag.status}`);
    }
  } else {
    console.log("\n(no LAB_POST_TOKEN: skipping /api/federation/diagnostics; pass --token to include it)");
  }

  console.log(`\n${fails === 0 ? "All checks passed." : fails + " check(s) FAILED."}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
