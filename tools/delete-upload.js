#!/usr/bin/env node
"use strict";

/**
 * tools/delete-upload.js — DELETE /api/uploads/:id with the contributor's token.
 *
 *   node tools/delete-upload.js <uploadId>                   # token read from tools/receipts/<uploadId>.json
 *   node tools/delete-upload.js <uploadId> --token <hex>     # explicit token (e.g. copied from the lab receipt)
 *   node tools/delete-upload.js --receipt path/to/receipt.json
 *   node tools/delete-upload.js <uploadId> --token wrong     # expect 403
 *
 * What the backend does (routes/uploads.js):
 *   pending  → ledger row marked deleted, incoming file removed          → 200
 *   approved → ledger marked deleted, approved media + thumbnail removed,
 *              post record removed, Delete(Tombstone) sent to the actor's
 *              followers                                                  → 200 with `federation`
 *   already deleted/rejected                                              → 410
 *   unknown id                                                            → 404
 *   wrong token                                                           → 403
 *
 * Afterwards this tool re-reads the public surfaces (/posts/:id, media URL,
 * /feed/all.xml) so you can see the removal, and warns about what is NOT
 * removed (see TESTING.md, "What deletion does not do").
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, loadConfig } = require("./lib/env");
const { request, setVerbose } = require("./lib/http");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return; }
  const cfg = loadConfig(args);
  setVerbose(Boolean(args.verbose));

  let receipt = null;
  let uploadId = args._[0];
  const receiptPath = args.receipt || (uploadId ? path.join(__dirname, "receipts", `${uploadId}.json`) : null);
  if (receiptPath && fs.existsSync(receiptPath)) receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  uploadId = uploadId || (receipt && receipt.uploadId);
  const token = args.token || (receipt && receipt.deleteToken);
  if (!uploadId || !token) {
    console.error("Need an uploadId and a token: pass <uploadId> (with a saved receipt) or --token.");
    process.exit(2);
  }

  // Snapshot before, so the diff is visible.
  const before = await request(`${cfg.baseUrl}/api/posts`);
  const postBefore = before.body && before.body.posts
    ? before.body.posts.find((p) => p.attachment && p.attachment.url && p.attachment.url.includes(uploadId))
    : null;

  const res = await request(`${cfg.baseUrl}/api/uploads/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    headers: { "X-Delete-Token": token }
  });
  console.log(`HTTP ${res.status}  ${res.body ? res.body.message : res.text.slice(0, 200)}`);
  if (!res.ok) process.exit(1);
  if (res.body.federation && !res.body.federation.skipped) {
    const f = res.body.federation;
    console.log(`federation   Delete(Tombstone) → ${f.followers ?? 0} follower(s), ${f.delivered ?? 0} delivered, ${(f.failures || []).length} failed`);
  }
  console.log(`removedFiles ${res.body.removedFiles}`);

  if (receipt) {
    receipt.status = "deleted"; receipt.deletedAt = new Date().toISOString();
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  }

  if (postBefore) {
    console.log(`\npost ${postBefore.id} by @${postBefore.actor} was live; checking the public surfaces now:`);
    const ap = await request(`${cfg.baseUrl}/posts/${postBefore.id}`, { headers: { Accept: "application/activity+json" } });
    const html = await request(`${cfg.baseUrl}/posts/${postBefore.id}`, { headers: { Accept: "text/html" } });
    const media = await request(postBefore.attachment.url.replace(cfg.publicUrl, cfg.baseUrl), { method: "HEAD" });
    console.log(`  /posts/:id (ActivityPub)  ${ap.status}`);
    console.log(`  /posts/:id (HTML)         ${html.status}`);
    console.log(`  media                     ${media.status}`);
    const after = await request(`${cfg.baseUrl}/api/posts`);
    const quoting = (after.body && after.body.posts || []).filter((p) => p.quoteUrl && p.quoteUrl.endsWith(postBefore.id));
    if (quoting.length) {
      console.log(`  [WARN] ${quoting.length} digest post(s) still quote the deleted post: ${quoting.map((p) => "@" + p.actor).join(", ")}`);
    }
    console.log(`  note: if nginx fronts this backend, /posts/${postBefore.id} may be served from the proxy cache for up to its TTL (7d in nginx/ghostmaxxing.vecna.eu.conf).`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
