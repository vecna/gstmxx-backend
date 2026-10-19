#!/usr/bin/env node
"use strict";

/**
 * tools/cycle.js — the whole contributor lifecycle against a RUNNING backend, narrated.
 *
 *   node tools/fixtures.js
 *   node tools/cycle.js                 # local instance; refuses a remote --url unless --allow-remote
 *   node tools/cycle.js --verbose       # print every request and response
 *   node tools/cycle.js --keep          # leave the approved PNG post online at the end
 *
 * What it exercises, in order (every step asserts and prints PASS/FAIL):
 *
 *   intake      4 uploads with the lab's exact field names: video+ghostyle, video,
 *               PNG+ghostyle, PNG. Then the rejection paths: missing consent,
 *               wrong MIME, mislabelled content, invalid kind.
 *   queue       /api/admin/pending lists them oldest-first, without delete tokens.
 *   approve     video+ghostyle → @ghostyles, echoed by @ghostyles-video, metadata
 *               stripped; PNG+ghostyle → @ghostyles, echoed by @ghostyles-pictures,
 *               tEXt chunk preserved. Post visible as AP object, HTML, RSS.
 *   reject      the plain video; raw file gone, ledger says rejected.
 *   self-delete a pending upload with its token → 200, then 410; wrong token → 403.
 *   digests     POST /api/digests/run {force:true} → daily/weekly/top-rated each pick one.
 *   retire      delete the approved video by token → post 404, media 404, feed clean,
 *               Delete(Tombstone) attempted; digest posts that quoted it are reported.
 *
 * It does not (cannot, without a second server) exercise inbound Follow / Like.
 * For that, see TESTING.md "Following from a real Mastodon account".
 *
 * Side effects on the target: uploads, posts, digest posts. On a local instance
 * wipe with `rm -rf data storage` (after stopping the server). This is why the
 * tool refuses production by default: the digest posts it creates would be
 * federated to real followers.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parseArgs, loadConfig, isLocalUrl } = require("./lib/env");
const { request, basic, buildUploadForm, setVerbose, report } = require("./lib/http");

const FIX = path.join(__dirname, "fixtures");
let fails = 0;
const check = (ok, label, detail) => { ok = Boolean(ok); if (report(ok, label, detail) === "FAIL") fails += 1; return ok; };
const section = (t) => console.log(`\n## ${t}`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); return; }
  const cfg = loadConfig(args);
  setVerbose(Boolean(args.verbose));
  const B = cfg.baseUrl;
  const auth = { Authorization: basic(cfg.adminUser, cfg.adminPass) };
  const bearer = cfg.postToken ? { Authorization: `Bearer ${cfg.postToken}` } : null;

  if (!isLocalUrl(B) && !args["allow-remote"]) {
    console.error(`Refusing to run the cycle against ${B}: it creates public posts and digest posts that federate to real followers.\nPass --allow-remote if you really mean it.`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(FIX, "clip.mp4")) || !fs.existsSync(path.join(FIX, "clip.png"))) {
    console.log("fixtures missing, building them…");
    const r = spawnSync(process.execPath, [path.join(__dirname, "fixtures.js")], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status);
  }

  section(`Instance ${B}`);
  const health = await request(`${B}/healthz`);
  if (!check(health.status === 200 && health.body && health.body.ok, "GET /healthz", `HTTP ${health.status}`)) process.exit(1);
  const adminProbe = await request(`${B}/api/admin/pending`, { headers: auth });
  if (!check(adminProbe.status === 200, "admin credentials", adminProbe.status === 401 ? "401: set GSTMXX_ADMIN_USER/GSTMXX_ADMIN_PASS (env file) or --admin-user/--admin-pass" : `HTTP ${adminProbe.status}`)) process.exit(1);
  const pendingBefore = adminProbe.body.pending.length;

  // ------------------------------------------------------------------ intake
  section("Intake: POST /api/uploads (multipart, field 'video', as lab-js/upload-consent.js sends it)");
  const up = async (label, o) => {
    const res = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm(o) });
    if (res.status === 429) {
      const rl = res.headers.get("ratelimit") || "";
      console.error(`\n[STOP] 429 from /api/uploads (${rl}). The intake is limited to ${res.headers.get("ratelimit-policy") || "20;w=900"} per client IP and this cycle needs about ten attempts.\n       Wait for the window to reset, or on a local instance restart the server with GSTMXX_UPLOAD_RATE_MAX=200 in its env (the limiter is in-memory).`);
      process.exit(3);
    }
    return { label, res, ...o };
  };
  const A = await up("video + ghostyle_id", { file: path.join(FIX, "clip.mp4"), kind: "video", ghostyleId: "brush", note: "cycle: two strokes across the nose bridge, ID eluded at 0.71 on tiny_face_detector", metrics: { faceapi: { detectionState: "eluded", liveMinDist: 0.71 } } });
  const Bv = await up("video, no ghostyle", { file: path.join(FIX, "clip.mp4"), kind: "video", note: "cycle: plain video" });
  const C = await up("PNG + ghostyle_id", { file: path.join(FIX, "clip.png"), kind: "clipboard", ghostyleId: "cv-dazzle-1", note: "cycle: png with ghostyle" });
  const D = await up("PNG, no ghostyle", { file: path.join(FIX, "clip.png"), kind: "clipboard" });
  for (const u of [A, Bv, C, D]) {
    const b = u.res.body || {};
    check(u.res.status === 201 && b.ok && b.uploadId && /^[0-9a-f]{64}$/.test(b.deleteToken || ""), `201 ${u.label}`, `uploadId=${b.uploadId} deleteToken=${b.deleteToken ? b.deleteToken.slice(0, 8) + "… (64 hex)" : "MISSING"}`);
    u.id = b.uploadId; u.token = b.deleteToken;
  }

  section("Intake: rejection paths");
  let r = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm({ file: path.join(FIX, "clip.mp4"), consentVersion: null }) });
  check(r.status === 400, "missing consent_version → 400", `HTTP ${r.status} ${r.body && r.body.message}`);
  r = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm({ file: path.join(FIX, "bogus.txt") }) });
  if (r.status === 500) report("WARN", "text/plain upload → 500 (should be 400)", "multer's fileFilter error falls through to the generic error handler; see patches/0001-uploads-4xx-on-bad-mime-and-size.diff");
  else check(r.status === 400 || r.status === 415, "text/plain upload rejected", `HTTP ${r.status}`);
  r = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm({ file: path.join(FIX, "bogus.txt"), mimeType: "video/mp4" }) });
  check(r.status === 400, "text file labelled video/mp4 → 400 (ffprobe finds no video stream)", `HTTP ${r.status} ${r.body && r.body.message}`);
  r = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm({ file: path.join(FIX, "clip.mp4"), kind: "picture" }) });
  check(r.status === 400, "kind=picture → 400", `HTTP ${r.status} ${r.body && r.body.message}`);
  r = await request(`${B}/api/uploads`, { method: "POST", body: await buildUploadForm({ file: path.join(FIX, "clip.png"), kind: "video" }) });
  if (r.status === 201) {
    report("WARN", "PNG sent as kind=video is ACCEPTED", "ffprobe sees a one-frame 'video' stream; approval would transcode a still image into an MP4. Low risk, but kind is not cross-checked against the MIME type.");
    await request(`${B}/api/uploads/${r.body.uploadId}`, { method: "DELETE", headers: { "X-Delete-Token": r.body.deleteToken } });
  } else check(r.status === 400, "PNG sent as kind=video rejected", `HTTP ${r.status}`);

  // ------------------------------------------------------------------ queue
  section("Queue: GET /api/admin/pending");
  const pend = await request(`${B}/api/admin/pending`, { headers: auth });
  const rows = pend.body.pending;
  const ids = rows.map((x) => x.id);
  check(rows.length === pendingBefore + 4, "four new rows in the queue", `${rows.length} pending (was ${pendingBefore})`);
  const idxA = ids.indexOf(A.id), idxD = ids.indexOf(D.id);
  check(idxA >= 0 && idxD > idxA, "oldest first", `A at ${idxA}, D at ${idxD}`);
  check(rows.every((x) => !("deleteToken" in x) && !("metrics" in x)), "queue rows expose no delete token", Object.keys(rows[0] || {}).join(","));
  const rowA = rows.find((x) => x.id === A.id) || {};
  check(rowA.ghostyleId === "brush" && rowA.consentVersion === "2026-07-v1" && rowA.userNote === A.note, "row A carries ghostyle_id, consent_version, user_note", `ghostyle=${rowA.ghostyleId} consent=${rowA.consentVersion}`);
  const media = await fetch(`${B}/api/admin/media/${A.id}`, { headers: auth });
  check(media.status === 200 && /video/.test(media.headers.get("content-type") || ""), "authenticated media preview", `${media.status} ${media.headers.get("content-type")}`);
  const mediaAnon = await request(`${B}/api/admin/media/${A.id}`);
  check(mediaAnon.status === 401, "media preview needs Basic Auth", `HTTP ${mediaAnon.status}`);

  // ------------------------------------------------------------------ approve
  section("Approve A (video + ghostyle): POST /api/admin/approve/:id");
  const apA = await request(`${B}/api/admin/approve/${A.id}`, { method: "POST", headers: auth });
  const a = apA.body || {};
  check(apA.status === 200 && a.ok, "approved", a.message);
  check(a.actor === "ghostyles", "routed to @ghostyles because ghostyle_id was present", `actor=${a.actor}`);
  check((a.echoes || []).some((e) => e.handle === "ghostyles-video"), "echoed by @ghostyles-video", `echoes=${(a.echoes || []).map((e) => e.handle).join(",")}`);
  check(a.publicUrl === `${cfg.publicUrl}/videos/${A.id}.mp4`, "public URL is /videos/<uploadId>.mp4 (matches the client's receipt guess)", a.publicUrl);
  check(a.thumbnail === `thumb-${A.id}.png`, "poster thumbnail", a.thumbnail);
  A.postId = a.post && a.post.id;
  const dl = await fetch(`${B}/videos/${A.id}.mp4`);
  check(dl.status === 200, "published video reachable", `HTTP ${dl.status}`);
  const tmp = path.join(__dirname, "receipts", "cycle-published.mp4");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(await dl.arrayBuffer()));
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format_tags", "-of", "json", tmp], { encoding: "utf8" });
  if (probe.status === 0) {
    const tags = (JSON.parse(probe.stdout).format || {}).tags || {};
    const leaked = Object.keys(tags).filter((k) => !/^(major_brand|minor_version|compatible_brands|encoder)$/.test(k));
    check(leaked.length === 0, "container metadata stripped (fixture had title, comment, GPS location)", leaked.length ? `LEAKED: ${leaked.join(", ")}` : `remaining tags: ${Object.keys(tags).join(", ")}`);
  } else report("INFO", "ffprobe unavailable", "skipped the metadata check");
  fs.unlinkSync(tmp);
  const apObj = await request(`${B}/posts/${A.postId}`, { headers: { Accept: "application/activity+json" } });
  check(apObj.status === 200 && apObj.body && apObj.body.type === "Note" && String(apObj.body.attributedTo).endsWith("/ghostyles"), "ActivityPub Note attributed to @ghostyles", `${apObj.body && apObj.body.attributedTo}`);
  check(apObj.body && apObj.body.attachment && apObj.body.attachment.mediaType === "video/mp4", "AP attachment is the video", JSON.stringify(apObj.body && apObj.body.attachment && apObj.body.attachment.url));
  check(apObj.body && apObj.body.content === `<p>${A.note}</p>`, "AP content is the contributor's note (escaped, wrapped in <p>)", apObj.body && apObj.body.content);
  report("INFO", "what is NOT in the post", "ghostyle_id, app_version, consent_version and metrics_json stay in the ledger only; the moderator cannot edit the text");
  const html = await request(`${B}/posts/${A.postId}`, { headers: { Accept: "text/html" } });
  check(html.status === 200 && /og:video|og:image/.test(html.text), "HTML preview with Open Graph tags", `HTTP ${html.status}`);
  for (const feed of ["ghostyles", "all"]) {
    const f = await request(`${B}/feed/${feed}.xml`);
    check(f.status === 200 && f.text.includes(A.postId), `RSS /feed/${feed}.xml carries the post`, `HTTP ${f.status}`);
  }
  const fv = await request(`${B}/feed/video.xml`);
  check(fv.status === 200 && !fv.text.includes(A.postId), "RSS /feed/video.xml does NOT carry it (it belongs to @ghostyles)", "");

  section("Approve C (PNG + ghostyle)");
  const apC = await request(`${B}/api/admin/approve/${C.id}`, { method: "POST", headers: auth });
  const c = apC.body || {};
  check(apC.status === 200 && c.actor === "ghostyles", "approved as @ghostyles", `actor=${c.actor}`);
  check((c.echoes || []).some((e) => e.handle === "ghostyles-pictures"), "echoed by @ghostyles-pictures", `echoes=${(c.echoes || []).map((e) => e.handle).join(",")}`);
  C.postId = c.post && c.post.id;
  const png = await fetch(`${B}/clipboard/${C.id}.png`);
  const pngBuf = Buffer.from(await png.arrayBuffer());
  check(png.status === 200 && pngBuf.includes("gstmxx-fixture"), "PNG published as submitted: tEXt chunk still present", "fediverse.html warns about exactly this; strip before uploading");
  const apC2 = await request(`${B}/posts/${C.postId}`, { headers: { Accept: "application/activity+json" } });
  check(apC2.body && apC2.body.attachment && apC2.body.attachment.mediaType === "image/png", "AP attachment is the image", "");

  // ------------------------------------------------------------------ reject
  section("Reject B (plain video): POST /api/admin/reject/:id");
  const rj = await request(`${B}/api/admin/reject/${Bv.id}`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ reason: "cycle test" }) });
  check(rj.status === 200, "rejected", rj.body && rj.body.message);
  const medB = await request(`${B}/api/admin/media/${Bv.id}`, { headers: auth });
  check(medB.status === 404, "raw file no longer served", `HTTP ${medB.status}`);
  const delB = await request(`${B}/api/uploads/${Bv.id}`, { method: "DELETE", headers: { "X-Delete-Token": Bv.token } });
  check(delB.status === 410, "contributor deleting a rejected upload gets 410", `HTTP ${delB.status}`);

  // ------------------------------------------------------------------ self-delete pending
  section("Contributor self-delete while pending: DELETE /api/uploads/:id + X-Delete-Token");
  const wrong = await request(`${B}/api/uploads/${D.id}`, { method: "DELETE", headers: { "X-Delete-Token": "0".repeat(64) } });
  check(wrong.status === 403, "wrong token → 403", `HTTP ${wrong.status}`);
  const noTok = await request(`${B}/api/uploads/${D.id}`, { method: "DELETE" });
  check(noTok.status === 403, "no token → 403", `HTTP ${noTok.status}`);
  const delD = await request(`${B}/api/uploads/${D.id}`, { method: "DELETE", headers: { "X-Delete-Token": D.token } });
  check(delD.status === 200 && delD.body.removedFiles === 1, "own token → 200, incoming file removed", JSON.stringify(delD.body));
  const delD2 = await request(`${B}/api/uploads/${D.id}`, { method: "DELETE", headers: { "X-Delete-Token": D.token } });
  check(delD2.status === 410, "second delete → 410", `HTTP ${delD2.status}`);
  const gone = await request(`${B}/api/uploads/00000000-0000-4000-8000-000000000000`, { method: "DELETE", headers: { "X-Delete-Token": D.token } });
  check(gone.status === 404, "unknown id → 404", `HTTP ${gone.status}`);
  const pend2 = await request(`${B}/api/admin/pending`, { headers: auth });
  check(pend2.body.pending.length === pendingBefore, "queue back to its previous size", `${pend2.body.pending.length}`);

  // ------------------------------------------------------------------ digests
  section("Digests: POST /api/digests/run {force:true} (Bearer LAB_POST_TOKEN)");
  if (!bearer) {
    report("WARN", "no LAB_POST_TOKEN configured", "skipping digests; set it in env or pass --token");
  } else {
    const dg = await request(`${B}/api/digests/run`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ force: true }) });
    check(dg.status === 200 && dg.body.ok, "digests ran", `ran=${dg.body && dg.body.ran}`);
    const ghostylePosts = new Set(((await request(`${B}/api/posts`)).body.posts || []).filter((p) => p.actor === "ghostyles").map((p) => p.id));
    for (const d of (dg.body && dg.body.results) || []) {
      const okPick = d.picked && ghostylePosts.has(d.picked);
      const ours = d.picked === A.postId || d.picked === C.postId;
      check(okPick, `@${d.handle} picked an approved @ghostyles post`, `picked=${d.picked && d.picked.slice(0, 8)}${ours ? " (one of ours)" : " (an older post on this instance)"} → quote post ${d.postId && d.postId.slice(0, 8)}  "${d.summary}"`);
    }
    const dfeed = await request(`${B}/feed/ghostyles-daily.xml`);
    check(dfeed.status === 200 && /<item>/.test(dfeed.text), "digest quote post visible in /feed/ghostyles-daily.xml", "");
    const noAuth = await request(`${B}/api/digests/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check(noAuth.status === 401 || noAuth.status === 403, "digests/run without token is refused", `HTTP ${noAuth.status}`);
  }

  // ------------------------------------------------------------------ retire approved
  section("Retire A (approved, echoed, possibly quoted): DELETE with the contributor token");
  const delA = await request(`${B}/api/uploads/${A.id}`, { method: "DELETE", headers: { "X-Delete-Token": A.token } });
  check(delA.status === 200 && delA.body.removedFiles === 2, "200, media + thumbnail removed", JSON.stringify(delA.body));
  check(delA.body.federation && !delA.body.federation.skipped, "Delete(Tombstone) attempted for @ghostyles followers", JSON.stringify(delA.body.federation));
  const afterAp = await request(`${B}/posts/${A.postId}`, { headers: { Accept: "application/activity+json" } });
  const afterMedia = await request(`${B}/videos/${A.id}.mp4`, { method: "HEAD" });
  const afterFeed = await request(`${B}/feed/all.xml`);
  check(afterAp.status === 404 || afterAp.status === 410, "/posts/:id gone", `HTTP ${afterAp.status} (Node answers 404; Mastodon accepts 404 or 410)`);
  check(afterMedia.status === 404, "media gone", `HTTP ${afterMedia.status}`);
  check(!afterFeed.text.includes(A.postId), "removed from RSS", "");
  const postsNow = await request(`${B}/api/posts`);
  const orphans = (postsNow.body.posts || []).filter((p) => p.quoteUrl && p.quoteUrl.endsWith(A.postId));
  if (orphans.length) report("WARN", `${orphans.length} digest post(s) still quote the deleted post`, `by ${orphans.map((p) => "@" + p.actor).join(", ")}; they now point at a 404. No Undo(Announce) is sent for the @ghostyles-video echo either. See TESTING.md.`);
  else report("PASS", "no digest post quotes the deleted post", "");

  // ------------------------------------------------------------------ tidy
  if (!args.keep) {
    section("Tidy: delete the approved PNG too");
    const delC = await request(`${B}/api/uploads/${C.id}`, { method: "DELETE", headers: { "X-Delete-Token": C.token } });
    check(delC.status === 200, "PNG contribution deleted", JSON.stringify(delC.body && delC.body.federation));
  } else {
    report("INFO", "kept", `PNG post ${C.postId} stays online; delete with: node tools/delete-upload.js ${C.id} --token ${C.token}`);
  }
  report("INFO", "left behind", "digest quote posts (no API deletes posts; on a local instance stop the server and rm -rf data storage), and ledger rows marked rejected/deleted that still hold userNote, metrics and the delete token");

  console.log(`\n${fails === 0 ? "Cycle complete, all assertions passed." : `Cycle complete, ${fails} assertion(s) FAILED.`}`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
