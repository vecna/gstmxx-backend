#!/usr/bin/env node
"use strict";

/**
 * tools/upload.js — POST /api/uploads exactly as the lab client does, without a webcam.
 *
 *   node tools/upload.js                                  # tools/fixtures/clip.mp4 as a plain @video contribution
 *   node tools/upload.js --ghostyle brush --note "two lines on the nose bridge, eluded at 0.71"
 *   node tools/upload.js --kind clipboard --file tools/fixtures/clip.png --ghostyle cv-dazzle-1
 *   node tools/upload.js --file some/real/recording.webm --metrics '{"faceapi":{"detectionState":"eluded"}}'
 *   node tools/upload.js --url https://ghostmaxxing.vecna.eu --verbose   # against production (it will sit in the queue)
 *
 * Negative cases (expect 400s):
 *   node tools/upload.js --no-consent
 *   node tools/upload.js --file tools/fixtures/bogus.txt                  # rejected by MIME filter
 *   node tools/upload.js --file tools/fixtures/bogus.txt --mime video/mp4 # passes MIME, fails ffprobe
 *   node tools/upload.js --kind picture                                    # invalid kind
 *
 * On success the receipt `{uploadId, deleteToken, ...}` is saved to
 * tools/receipts/<uploadId>.json so tools/delete-upload.js and tools/moderate.js
 * can find it. The token is the only credential that can delete the upload:
 * treat that directory like a password store.
 *
 * Routing rule worth remembering (server.js `actorForUpload`): a submission
 * with a `ghostyle_id` is published by @ghostyles whatever its kind; without
 * one, videos go to @video and PNGs to @clipboard.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs, loadConfig } = require("./lib/env");
const { request, buildUploadForm, setVerbose } = require("./lib/http");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return; }
  const cfg = loadConfig(args);
  setVerbose(Boolean(args.verbose));

  const kind = args.kind || (args.file && /\.png$/i.test(args.file) ? "clipboard" : "video");
  const file = path.resolve(args.file || path.join(__dirname, "fixtures", kind === "clipboard" ? "clip.png" : "clip.mp4"));
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}\nRun \`node tools/fixtures.js\` first, or pass --file.`);
    process.exit(2);
  }

  const form = await buildUploadForm({
    file,
    kind,
    consentVersion: args["no-consent"] ? null : (args.consent || "2026-07-v1"),
    appVersion: args["app-version"] || "0.1.0",
    ghostyleId: args.ghostyle,
    note: args.note,
    metrics: args.metrics,
    mimeType: args.mime
  });

  const res = await request(`${cfg.baseUrl}/api/uploads`, { method: "POST", body: form });
  const ratelimit = res.headers.get("ratelimit");
  if (!res.ok || !res.body || !res.body.ok) {
    console.log(`HTTP ${res.status}: ${res.body ? res.body.message : res.text.slice(0, 200)}`);
    if (ratelimit) console.log(`RateLimit: ${ratelimit}`);
    process.exit(1);
  }

  const receipt = {
    uploadId: res.body.uploadId,
    deleteToken: res.body.deleteToken,
    kind,
    ghostyleId: args.ghostyle || null,
    consentVersion: args.consent || "2026-07-v1",
    userNote: args.note || null,
    file,
    baseUrl: cfg.baseUrl,
    // Same derivation as lab-js/upload-consent.js publicUrlForReceipt():
    publicUrlCandidate: `${cfg.publicUrl}/${kind === "clipboard" ? "clipboard" : "videos"}/${res.body.uploadId}.${kind === "clipboard" ? "png" : "mp4"}`,
    createdAt: new Date().toISOString(),
    status: "pending"
  };
  const receiptsDir = path.join(__dirname, "receipts");
  fs.mkdirSync(receiptsDir, { recursive: true });
  const receiptPath = path.join(receiptsDir, `${receipt.uploadId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });

  console.log(`HTTP ${res.status}  ${res.body.message}`);
  console.log(`uploadId     ${receipt.uploadId}`);
  console.log(`deleteToken  ${receipt.deleteToken}`);
  console.log(`will publish ${receipt.publicUrlCandidate}  (if approved, as @${args.ghostyle ? "ghostyles" : kind})`);
  console.log(`receipt      ${path.relative(process.cwd(), receiptPath)}`);
  if (ratelimit) console.log(`RateLimit    ${ratelimit}   (default 20 uploads per 15 min per client IP)`);
  console.log(`\nnext: node tools/moderate.js pending        # see it in the queue`);
  console.log(`      node tools/moderate.js approve ${receipt.uploadId}`);
  console.log(`      node tools/delete-upload.js ${receipt.uploadId}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
