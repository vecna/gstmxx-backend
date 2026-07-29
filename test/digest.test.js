"use strict";

/**
 * What this file tests
 * --------------------
 * The pure digest/filter engine in `lib/digest.js`: how actor handles are
 * parsed into specs, how "due" is computed from a sliding window, how the
 * single per-window pick is chosen, and how the human summary line is built.
 *
 * How it tests it
 * ---------------
 * Everything is deterministic. `lib/digest.js` takes the clock (`now`) and the
 * RNG (`rng`) as arguments, so there is no reliance on wall-clock time or real
 * randomness. Candidates are hand-built with fixed ISO timestamps.
 *
 * What it does NOT cover
 * ----------------------
 * Delivery/federation (an approved pick becoming a FEP-044f quote and going out
 * to followers), like-count ingestion from inbox `Like`/`Undo`, and the
 * in-process scheduler wiring. Those touch I/O and belong in the server-level
 * suite, not this pure-logic file.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const digest = require("../lib/digest");

// A fixed "now" so windows are reproducible: 2026-07-29T12:00:00Z.
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Small helper to fabricate a candidate. */
function item(id, media, likes, hoursAgo) {
  return {
    id,
    media,
    likes,
    createdAt: new Date(NOW - hoursAgo * HOUR).toISOString()
  };
}

test("parse: a bare source is not a filter", () => {
  assert.equal(digest.parseDigestSpec("ghostyles"), null);
});

test("parse: an unknown source is rejected", () => {
  assert.equal(digest.parseDigestSpec("banana-daily"), null);
});

test("parse: media-only handle is an echo filter", () => {
  const spec = digest.parseDigestSpec("ghostyles-pictures");
  assert.equal(spec.mode, "echo");
  assert.equal(spec.media, "pictures");
  assert.equal(spec.window, null);
});

test("parse: 'video' after the source is a media segment, not a source", () => {
  // The first token is always the source; "video" here restricts media.
  const spec = digest.parseDigestSpec("ghostyles-video-daily");
  assert.equal(spec.source, "ghostyles");
  assert.equal(spec.media, "videos");
  assert.equal(spec.window.name, "daily");
  assert.equal(spec.mode, "digest");
});

test("parse: a window makes it a digest and defaults selection to random", () => {
  const spec = digest.parseDigestSpec("ghostyles-weekly");
  assert.equal(spec.mode, "digest");
  assert.equal(spec.selection, "random");
  assert.equal(spec.window.name, "weekly");
  assert.equal(spec.window.ms, 7 * DAY);
});

test("parse: 'top-rated' splits into top+rated and means rank-by-likes", () => {
  const spec = digest.parseDigestSpec("ghostyles-top-rated");
  assert.equal(spec.selection, "top");
  // top with no explicit window defaults to the trailing 24h.
  assert.equal(spec.window.name, "daily");
});

test("parse: a like threshold is captured and implies top", () => {
  const spec = digest.parseDigestSpec("ghostyles-top-rated-min10likes");
  assert.equal(spec.selection, "top");
  assert.equal(spec.minLikes, 10);
});

test("parse: an unrecognized segment refuses the whole spec", () => {
  // Better to fall back to raw-actor handling than to silently mis-parse.
  assert.equal(digest.parseDigestSpec("ghostyles-monthly"), null);
});

test("isDue: echo specs are never timer-due", () => {
  const echo = digest.parseDigestSpec("ghostyles-pictures");
  assert.equal(digest.isDue(echo, null, NOW), false);
});

test("isDue: never-run digest is due; then not due until a window passes", () => {
  const spec = digest.parseDigestSpec("ghostyles-daily");
  assert.equal(digest.isDue(spec, null, NOW), true);
  const lastRun = new Date(NOW - 2 * HOUR).toISOString();
  assert.equal(digest.isDue(spec, lastRun, NOW), false);
  const lastRunOld = new Date(NOW - 25 * HOUR).toISOString();
  assert.equal(digest.isDue(spec, lastRunOld, NOW), true);
});

test("window: only items inside the trailing window are candidates", () => {
  const spec = digest.parseDigestSpec("ghostyles-daily");
  const candidates = [
    item("a", "pictures", 0, 2), // 2h ago  -> in
    item("b", "videos", 0, 20), // 20h ago -> in
    item("c", "pictures", 0, 30) // 30h ago -> out
  ];
  const inWin = digest.withinWindow(candidates, spec, NOW).map((i) => i.id);
  assert.deepEqual(inWin.sort(), ["a", "b"]);
});

test("select random: deterministic with an injected rng", () => {
  const spec = digest.parseDigestSpec("ghostyles-daily");
  const candidates = [
    item("a", "pictures", 0, 1),
    item("b", "videos", 0, 2),
    item("c", "pictures", 0, 3)
  ];
  // rng returns 0.5 -> floor(0.5 * 3) = index 1 -> "b".
  const pick = digest.selectFromWindow(candidates, spec, { now: NOW, rng: () => 0.5 });
  assert.equal(pick.id, "b");
});

test("select top: highest likes wins, newer breaks ties", () => {
  const spec = digest.parseDigestSpec("ghostyles-top-rated");
  const candidates = [
    item("a", "pictures", 5, 1),
    item("b", "videos", 9, 10),
    item("c", "pictures", 9, 3) // same likes as b but newer -> wins
  ];
  const pick = digest.selectFromWindow(candidates, spec, { now: NOW });
  assert.equal(pick.id, "c");
});

test("select: media restriction and like threshold both apply", () => {
  const spec = digest.parseDigestSpec("ghostyles-video-top-rated-min10likes");
  const candidates = [
    item("pic", "pictures", 50, 1), // wrong media
    item("lowvid", "videos", 3, 1), // below threshold
    item("goodvid", "videos", 12, 1) // eligible
  ];
  const pick = digest.selectFromWindow(candidates, spec, { now: NOW });
  assert.equal(pick.id, "goodvid");
});

test("select: empty pool returns null", () => {
  const spec = digest.parseDigestSpec("ghostyles-video-daily");
  const candidates = [item("pic", "pictures", 0, 1)]; // no videos
  assert.equal(digest.selectFromWindow(candidates, spec, { now: NOW }), null);
});

test("summary: matches the requested phrasing", () => {
  const spec = digest.parseDigestSpec("ghostyles-weekly");
  // 30 items in the last week: 10 pictures, 20 videos.
  const candidates = [];
  for (let i = 0; i < 10; i += 1) candidates.push(item(`p${i}`, "pictures", 0, i + 1));
  for (let i = 0; i < 20; i += 1) candidates.push(item(`v${i}`, "videos", 0, i + 1));
  const line = digest.summarizeWindow(candidates, spec, NOW);
  assert.equal(
    line,
    "30 ghostyles received in last week, 10 pictures 20 videos, random weekly selection:"
  );
});
