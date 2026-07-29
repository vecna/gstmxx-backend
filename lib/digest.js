"use strict";

/**
 * @module lib/digest
 *
 * Composable "filter actor" engine for Ghostmaxxing.
 *
 * A **filter actor** is a local ActivityPub actor whose entire behaviour is
 * derived by parsing its own handle. Followers of a raw actor (for example
 * `ghostyles`) receive *every* approved item. Followers of a filter actor
 * receive a curated subset or a periodic single pick. The definition lives in
 * the handle itself, so the mechanism is fully composable from a URL and needs
 * no per-actor configuration file:
 *
 *   @ghostyles                     raw actor — echoes everything (not a filter)
 *   @ghostyles-pictures            echo: every approved *picture* about ghostyles
 *   @ghostyles-video               echo: every approved *video* about ghostyles
 *   @ghostyles-daily               digest: one random pick per 24h window
 *   @ghostyles-video-daily         digest: one random *video* pick per 24h
 *   @ghostyles-weekly              digest: one random pick per 7d window
 *   @ghostyles-top-rated           digest: the most-liked item (default 24h)
 *   @ghostyles-top-rated-min10likes  digest: most-liked, only if it has >=10 likes
 *
 * The grammar is a source token followed by any number of hyphen-separated
 * segments, in any order:
 *
 *   spec    := source ("-" segment)*
 *   source  := a registered raw actor handle (e.g. "ghostyles")
 *   segment := media | window | selection | threshold
 *   media   := "picture" | "pictures" | "video" | "videos"
 *   window  := "daily" | "weekly"
 *   selection := "random" | "latest" | "top" | "rated"   ("top"/"rated" => top)
 *   threshold := /^min(\d+)likes?$/                        (e.g. "min10likes")
 *
 * Design notes that matter for the rest of the backend:
 *
 *  - **Two modes.** A spec with a window or a selection is a *digest* (timer
 *    driven, one pick per window, delivered as a FEP-044f quote of the picked
 *    post). A spec with only a media segment is an *echo* (event driven,
 *    re-emitted the moment a matching item is approved). A bare source token is
 *    not a filter at all and parses to `null`.
 *
 *  - **Per-digest, never per-follower.** The pick is computed once per filter
 *    actor per window and then delivered to that actor's followers by the
 *    normal ActivityPub outbox. Nothing here scales with follower count; it
 *    scales with the (small) number of filter actors. This is what keeps a
 *    cold start after downtime cheap: there are only a handful of digests to
 *    catch up, not one job per user.
 *
 *  - **Downtime is not back-filled.** After an outage we do not replay every
 *    missed window. {@link isDue} simply reports that a digest is overdue, and
 *    the scheduler runs exactly one digest over whatever candidates currently
 *    fall in the trailing window. One catch-up pick, not a backlog.
 *
 * This module is deliberately pure (no I/O, no Date.now, no randomness of its
 * own) so it can be unit-tested deterministically and, later, lifted out into a
 * standalone package. Callers inject the clock and the RNG.
 */

/**
 * Registered raw source actors a filter may derive from.
 * @type {ReadonlyArray<string>}
 */
const SOURCES = Object.freeze(["video", "ghostyles", "news", "clipboard"]);

/**
 * Window definitions, in milliseconds.
 * @type {Readonly<Record<string, number>>}
 */
const WINDOWS = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
});

/**
 * Media classes a filter can restrict to. `"all"` means no restriction.
 * @type {ReadonlyArray<string>}
 */
const MEDIA = Object.freeze(["all", "pictures", "videos"]);

/**
 * Selection strategies for digest mode.
 * @type {ReadonlyArray<string>}
 */
const SELECTIONS = Object.freeze(["random", "latest", "top"]);

/**
 * @typedef {Object} DigestSpec
 * @property {string}  raw        The original handle/spec string.
 * @property {string}  source     The raw source actor (one of {@link SOURCES}).
 * @property {"echo"|"digest"} mode  How the filter behaves.
 * @property {"all"|"pictures"|"videos"} media  Media restriction.
 * @property {?{name:string, ms:number}} window  Trailing window, or null in echo mode.
 * @property {"random"|"latest"|"top"} selection  Pick strategy (digest mode only).
 * @property {?number} minLikes   Minimum like count to be eligible, or null.
 */

/**
 * @typedef {Object} Candidate
 * @property {string} id
 * @property {"pictures"|"videos"} media   Media class of the item.
 * @property {number} likes                Current like count.
 * @property {string} createdAt            ISO-8601 timestamp.
 */

/**
 * Classify a single hyphen segment of a handle.
 *
 * @param {string} token - One lowercase segment (already split on "-").
 * @returns {?{kind:string, value:*}} A classified segment, or null if the token
 *   is not part of the grammar.
 */
function classifySegment(token) {
  if (token === "picture" || token === "pictures") {
    return { kind: "media", value: "pictures" };
  }
  if (token === "video" || token === "videos") {
    return { kind: "media", value: "videos" };
  }
  if (token === "daily" || token === "weekly") {
    return { kind: "window", value: token };
  }
  if (token === "random" || token === "latest") {
    return { kind: "selection", value: token };
  }
  // "top" and "top-rated" both mean "rank by likes"; the handle "top-rated"
  // splits into the two tokens "top" and "rated", so accept either.
  if (token === "top" || token === "rated") {
    return { kind: "selection", value: "top" };
  }
  const threshold = /^min(\d+)likes?$/.exec(token);
  if (threshold) {
    return { kind: "threshold", value: Number.parseInt(threshold[1], 10) };
  }
  return null;
}

/**
 * Parse an actor handle (or any equivalent hyphenated spec string) into a
 * normalized {@link DigestSpec}.
 *
 * Returns `null` when the handle is not a filter actor — either because it is a
 * bare raw source (e.g. `"ghostyles"`), because the first token is not a known
 * source, or because an unrecognized segment makes the spec ambiguous. Callers
 * should treat `null` as "this is not a digest/echo actor" and fall back to
 * normal raw-actor handling.
 *
 * @param {string} handle - e.g. `"ghostyles-video-daily"`.
 * @returns {?DigestSpec} The normalized spec, or null.
 */
function parseDigestSpec(handle) {
  if (typeof handle !== "string" || handle.length === 0) return null;
  const tokens = handle.toLowerCase().split("-").filter(Boolean);
  if (tokens.length < 2) return null; // bare source (or empty) is not a filter

  const [source, ...rest] = tokens;
  if (!SOURCES.includes(source)) return null;

  let media = "all";
  let window = null;
  let selection = null;
  let minLikes = null;

  for (const token of rest) {
    const segment = classifySegment(token);
    if (!segment) return null; // an unknown segment => refuse rather than guess
    if (segment.kind === "media") media = segment.value;
    else if (segment.kind === "window") window = segment.value;
    else if (segment.kind === "selection") selection = segment.value;
    else if (segment.kind === "threshold") minLikes = segment.value;
  }

  // Mode resolution: a window OR a selection (including a bare threshold, which
  // only makes sense for "top") makes this a periodic digest; otherwise it is a
  // continuous media echo.
  const isDigest = Boolean(window) || Boolean(selection) || minLikes != null;

  if (!isDigest) {
    // Echo filter: media-only. "all" echo would just duplicate the raw actor,
    // so require a real media restriction to be a meaningful filter.
    if (media === "all") return null;
    return {
      raw: handle,
      source,
      mode: "echo",
      media,
      window: null,
      selection: "latest",
      minLikes: null
    };
  }

  // Digest defaults:
  //  - a threshold or explicit "top" ranks by likes; anything else defaults to
  //    a random pick (matches "random weekly selection").
  if (!selection) selection = minLikes != null ? "top" : "random";
  //  - "top"/threshold with no explicit window defaults to the trailing 24h
  //    ("the one with most likes in the last 24 hours").
  if (!window) window = selection === "top" ? "daily" : "daily";

  return {
    raw: handle,
    source,
    mode: "digest",
    media,
    window: { name: window, ms: WINDOWS[window] },
    selection,
    minLikes
  };
}

/**
 * Restrict a candidate list to the ones a spec is allowed to pick from: the
 * right media class, and (for top-rated) at or above the like threshold.
 *
 * @param {Candidate[]} candidates
 * @param {DigestSpec} spec
 * @returns {Candidate[]} The eligible subset (input is not mutated).
 */
function eligible(candidates, spec) {
  return candidates.filter((item) => {
    if (spec.media !== "all" && item.media !== spec.media) return false;
    if (spec.minLikes != null && (item.likes || 0) < spec.minLikes) return false;
    return true;
  });
}

/**
 * Keep only candidates whose `createdAt` falls inside the trailing window that
 * ends at `now`. Echo specs (no window) return the input unchanged.
 *
 * @param {Candidate[]} candidates
 * @param {DigestSpec} spec
 * @param {number} now - Epoch milliseconds for the end of the window.
 * @returns {Candidate[]}
 */
function withinWindow(candidates, spec, now) {
  if (!spec.window) return candidates.slice();
  const start = now - spec.window.ms;
  return candidates.filter((item) => {
    const at = Date.parse(item.createdAt);
    return Number.isFinite(at) && at > start && at <= now;
  });
}

/**
 * Decide whether a digest is due to run.
 *
 * Echo specs are event-driven and never "due" on a timer, so they always return
 * false. Digest specs are due when a full window has elapsed since the last run
 * (or when they have never run). Deliberately window-based, not clock-aligned:
 * the window slides from the previous run, so a restart after downtime makes the
 * digest due immediately and it runs once over whatever is currently available.
 *
 * @param {DigestSpec} spec
 * @param {?(string|number)} lastRunAt - ISO string / epoch ms of the last run, or null.
 * @param {number} now - Epoch milliseconds.
 * @returns {boolean}
 */
function isDue(spec, lastRunAt, now) {
  if (!spec || spec.mode !== "digest" || !spec.window) return false;
  if (lastRunAt == null) return true;
  const last = typeof lastRunAt === "number" ? lastRunAt : Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= spec.window.ms;
}

/**
 * Pick the single item a digest should quote this window, or null if nothing is
 * eligible. The RNG is injected so tests are deterministic; production passes
 * `Math.random`.
 *
 * @param {Candidate[]} candidates - All items from the source (any age).
 * @param {DigestSpec} spec
 * @param {Object} [options]
 * @param {number} [options.now=Date.now()] - Window end.
 * @param {() => number} [options.rng=Math.random] - Uniform [0,1) source.
 * @returns {?Candidate} The chosen item, or null.
 */
function selectFromWindow(candidates, spec, options = {}) {
  const now = options.now ?? Date.now();
  const rng = options.rng ?? Math.random;
  const pool = eligible(withinWindow(candidates, spec, now), spec);
  if (pool.length === 0) return null;

  if (spec.selection === "latest") {
    return pool.reduce((newest, item) =>
      Date.parse(item.createdAt) > Date.parse(newest.createdAt) ? item : newest
    );
  }
  if (spec.selection === "top") {
    // Rank by likes; tie-break on the more recent item for stability.
    return pool.reduce((best, item) => {
      const bl = best.likes || 0;
      const il = item.likes || 0;
      if (il > bl) return item;
      if (il === bl && Date.parse(item.createdAt) > Date.parse(best.createdAt)) {
        return item;
      }
      return best;
    });
  }
  // random
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Build the human summary line that heads a digest quote, e.g.
 *
 *   "30 ghostyles received in last week, 10 pictures 20 videos,
 *    random weekly selection:"
 *
 * The counts describe the *window candidates before the media filter* so a
 * follower of `ghostyles-video-daily` still sees how much overall traffic the
 * pick was drawn from. The trailing phrase names the algorithm, which is the
 * transparency the composable design is meant to provide.
 *
 * @param {Candidate[]} candidates - All items from the source (any age).
 * @param {DigestSpec} spec
 * @param {number} [now=Date.now()] - Window end.
 * @returns {string}
 */
function summarizeWindow(candidates, spec, now = Date.now()) {
  const inWindow = withinWindow(candidates, spec, now);
  const total = inWindow.length;
  const pictures = inWindow.filter((i) => i.media === "pictures").length;
  const videos = inWindow.filter((i) => i.media === "videos").length;
  const period = spec.window ? spec.window.name === "weekly" ? "week" : "day" : "run";
  const periodAdj = spec.window ? spec.window.name : "";

  let algorithm;
  if (spec.selection === "top") {
    algorithm = spec.minLikes != null
      ? `top-rated (>=${spec.minLikes} likes) ${periodAdj} selection`
      : `top-rated by likes ${periodAdj} selection`;
  } else if (spec.selection === "latest") {
    algorithm = `latest ${periodAdj} selection`;
  } else {
    algorithm = `random ${periodAdj} selection`;
  }

  const mediaNote = spec.media === "all"
    ? `${pictures} pictures ${videos} videos`
    : spec.media === "pictures"
      ? `${pictures} pictures of ${total}`
      : `${videos} videos of ${total}`;

  return `${total} ${spec.source} received in last ${period}, ${mediaNote}, ${algorithm.trim()}:`;
}

module.exports = {
  SOURCES,
  WINDOWS,
  MEDIA,
  SELECTIONS,
  classifySegment,
  parseDigestSpec,
  eligible,
  withinWindow,
  isDue,
  selectFromWindow,
  summarizeWindow
};
