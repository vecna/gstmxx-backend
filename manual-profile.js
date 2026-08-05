#!/usr/bin/env node

/**
 * manual-profile.js — the third CLI, next to `manual-add-post.js` and
 * `manual-quote-picture.js`.
 *
 * Controls what a fediverse client draws on an actor's profile page:
 * the header image, the avatar, the display name, the biography (with links)
 * and up to four metadata fields.
 *
 * Nothing is federated until `--publish`, which pushes an `Update(Person)` to
 * the actor's followers. Without it, only servers that fetch the actor fresh
 * would ever see the change.
 *
 * Examples:
 *   node manual-profile.js --actor video --show
 *   node manual-profile.js --actor video \
 *     --name "Ghostmaxxing / video" \
 *     --bio-file ./bio.txt \
 *     --field "Lab=https://ghostmaxxing.vecna.eu/lab.html" \
 *     --field "Code=https://github.com/vecna/ghostmaxxing" \
 *     --avatar-file ./avatar.png \
 *     --header-file ./header.jpg \
 *     --publish
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { apiRequest, loadEnvFile, localApiUrl } = require("./postClient.js");

const DEFAULT_ENV_FILE = path.resolve(__dirname, "fedibasic.env");

const VALUE_OPTIONS = new Map([
  ["--actor", "actor"],
  ["--server", "serverUrl"],
  ["--env-file", "envFile"],
  ["--from-json", "fromJson"],
  ["--name", "displayName"],
  ["--bio", "bioText"],
  ["--bio-file", "bioFile"],
  ["--bio-html", "bioHtml"],
  ["--url", "profileUrl"],
  ["--avatar-file", "avatarFile"],
  ["--avatar-url", "avatarUrl"],
  ["--header-file", "headerFile"],
  ["--header-url", "headerUrl"]
]);

const FLAGS = new Map([
  ["--publish", "publish"],
  ["--show", "show"],
  ["--preview", "preview"],
  ["--clear-avatar", "clearAvatar"],
  ["--clear-header", "clearHeader"],
  ["--clear-fields", "clearFields"],
  ["--clear-bio", "clearBio"],
  ["--no-discoverable", "notDiscoverable"],
  ["--no-indexable", "notIndexable"],
  ["--dry-run", "dryRun"]
]);

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);

function takeValue(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith("--") && value.length > 2)) {
    throw new Error(`${argv[index]} requires a value.`);
  }
  return value;
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * @param {string[]} argv
 * @returns {Object} Parsed options.
 */
function parseArgs(argv) {
  const options = { actor: "video", actorGiven: false, fields: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (VALUE_OPTIONS.has(argument)) {
      options[VALUE_OPTIONS.get(argument)] = takeValue(argv, index);
      if (argument === "--actor") options.actorGiven = true;
      index += 1;
    } else if (argument === "--field") {
      const raw = takeValue(argv, index);
      const separator = raw.indexOf("=");
      if (separator < 1) {
        throw new Error(`--field expects "Name=Value", got "${raw}".`);
      }
      options.fields.push({
        name: raw.slice(0, separator).trim(),
        value: raw.slice(separator + 1).trim()
      });
      index += 1;
    } else if (FLAGS.has(argument)) {
      options[FLAGS.get(argument)] = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${argument}.`);
    }
  }
  return options;
}

function usage() {
  console.log(`Usage:
  node manual-profile.js --actor NAME [options]

Declarative:
  --from-json PATH       Apply a profile file (see fedi-profile.example.json).
                         Every actor in it is applied unless --actor narrows it
                         to one. File paths inside the JSON are resolved
                         relative to the JSON file, so keep images next to it.

Read:
  --show                 Print the stored profile and exit
  --preview              Print the rendered Person document (what Mastodon reads)

Identity:
  --name TEXT            Display name (max 60 chars)
  --bio TEXT             Biography as plain text (blank lines become paragraphs,
                         bare URLs become links)
  --bio-file PATH        Same, read from a file — the practical way to write one
  --bio-html HTML        Biography as HTML (sanitised to p/br/a/span/em/strong/
                         b/i/code/del/ul/ol/li)
  --clear-bio            Remove the biography
  --url URL              The link behind the profile name
  --field "Name=Value"   A profile field; repeat up to 4 times. A value that is
                         a URL is rendered as a link
  --clear-fields         Remove all profile fields

Images (PNG, JPEG, WebP or GIF, max 2 MB — SVG is rejected by Mastodon):
  --avatar-file PATH     Upload the profile picture
  --avatar-url URL       Point at an already-hosted profile picture
  --clear-avatar         Remove it
  --header-file PATH     Upload the header/banner image
  --header-url URL       Point at an already-hosted header image
  --clear-header         Remove it

Visibility:
  --no-discoverable      Opt out of the profile directory
  --no-indexable         Ask search engines and remote indexes to skip it

Delivery:
  --publish              Send Update(Person) to this actor's followers.
                         Without it the change is stored but nobody is told.
  --dry-run              Print the request plan and exit

Connection:
  --server URL           Control API (default: LAB_API_URL or http://127.0.0.1:PORT)
  --env-file PATH        Load configuration (default: ./fedibasic.env)

Environment:
  LAB_POST_TOKEN         Bearer token, same one manual-add-post.js uses

Examples:
  node manual-profile.js --from-json fedi-profile.json --publish
  node manual-profile.js --from-json fedi-profile.json --actor video --publish
  node manual-profile.js --actor video --show
  node manual-profile.js --actor video --name "Ghostmaxxing / video" \\
    --bio-file ./bio.txt --field "Lab=https://ghostmaxxing.vecna.eu/lab.html" \\
    --avatar-file ./avatar.png --header-file ./header.jpg --publish
`);
}

/**
 * Read an image from disk and infer its MIME type from the extension.
 * @param {string} filePath
 * @returns {{bytes:Buffer, contentType:string}}
 */
function readImage(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No such file: ${resolved}`);
  }
  const extension = path.extname(resolved).toLowerCase();
  const contentType = IMAGE_TYPES.get(extension);
  if (!contentType) {
    throw new Error(
      `Unsupported image extension "${extension || "(none)"}". ` +
        `Use one of: ${[...IMAGE_TYPES.keys()].join(", ")}. ` +
        "Mastodon does not accept SVG avatars or headers."
    );
  }
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > 2 * 1024 * 1024) {
    throw new Error(
      `${path.basename(resolved)} is ${(bytes.length / 1024 / 1024).toFixed(2)} MB; the limit is 2 MB.`
    );
  }
  return { bytes, contentType };
}

/**
 * Turn CLI options into the profile patch the API expects.
 * @param {Object} options
 * @returns {Object|null} The patch, or null when nothing textual changed.
 */
function buildPatch(options) {
  const patch = {};
  if (options.displayName !== undefined) patch.displayName = options.displayName;
  if (options.clearBio) patch.summaryHtml = null;
  else if (options.bioHtml !== undefined) patch.summaryHtml = options.bioHtml;
  else if (options.bioFile !== undefined) {
    patch.summaryText = fs.readFileSync(path.resolve(options.bioFile), "utf8");
  } else if (options.bioText !== undefined) patch.summaryText = options.bioText;

  if (options.clearFields) patch.fields = null;
  else if (options.fields.length) patch.fields = options.fields;

  if (options.profileUrl !== undefined) patch.url = options.profileUrl;
  if (options.notDiscoverable) patch.discoverable = false;
  if (options.notIndexable) patch.indexable = false;

  if (options.avatarUrl !== undefined) patch.avatarUrl = options.avatarUrl;
  if (options.headerUrl !== undefined) patch.headerUrl = options.headerUrl;
  if (options.clearAvatar) patch.avatarUrl = null;
  if (options.clearHeader) patch.headerUrl = null;

  return Object.keys(patch).length ? patch : null;
}

/**
 * Read a profile file and normalise it into `{ handle: spec }`.
 *
 * Accepts either `{ "actors": { "video": {...} } }` or a bare single-actor
 * object, so a one-actor setup does not need the extra nesting. Relative image
 * paths are resolved against the file's own directory: the file and the images
 * travel together.
 *
 * @param {string} filePath
 * @param {string} [onlyActor] - Narrow to one handle.
 * @returns {Array<[string, Object]>}
 */
function readProfileFile(filePath, onlyActor) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`No such file: ${resolved}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${resolved} is not valid JSON: ${error.message}`);
  }
  const baseDir = path.dirname(resolved);
  const actors =
    parsed && typeof parsed.actors === "object" && parsed.actors !== null
      ? parsed.actors
      : { [onlyActor || "video"]: parsed };

  const entries = Object.entries(actors)
    .filter(([handle]) => !onlyActor || handle === onlyActor)
    .map(([handle, spec]) => [handle, { ...spec, __baseDir: baseDir }]);

  if (!entries.length) {
    throw new Error(
      onlyActor
        ? `${resolved} has no entry for actor "${onlyActor}".`
        : `${resolved} defines no actors.`
    );
  }
  return entries;
}

/**
 * Translate one actor's JSON spec into the same shape `parseArgs` produces, so
 * that both entry points share one code path from here on.
 *
 * @param {Object} spec
 * @returns {Object}
 */
function optionsFromSpec(spec) {
  const resolve = (value) =>
    value == null ? undefined : path.resolve(spec.__baseDir || ".", value);
  return {
    displayName: spec.displayName,
    bioText: spec.bio,
    bioHtml: spec.bioHtml,
    bioFile: spec.bioFile ? resolve(spec.bioFile) : undefined,
    profileUrl: spec.url,
    fields: Array.isArray(spec.fields) ? spec.fields : [],
    avatarFile: spec.avatarFile ? resolve(spec.avatarFile) : undefined,
    avatarUrl: spec.avatarUrl,
    headerFile: spec.headerFile ? resolve(spec.headerFile) : undefined,
    headerUrl: spec.headerUrl,
    clearAvatar: spec.avatar === null || spec.avatarFile === null,
    clearHeader: spec.header === null || spec.headerFile === null,
    clearFields: spec.fields === null,
    clearBio: spec.bio === null && spec.bioHtml == null && spec.bioFile == null,
    notDiscoverable: spec.discoverable === false,
    notIndexable: spec.indexable === false
  };
}

/**
 * Apply one actor's changes: clears, image uploads, the textual patch, then an
 * optional `Update(Person)`.
 *
 * @returns {Promise<{ok:boolean, profile:Object|null}>}
 */
async function applyProfile(request, actorHandle, options, { publish, dryRun }) {
  const actor = encodeURIComponent(actorHandle);
  const patch = buildPatch(options);
  const uploads = [];
  if (options.avatarFile) uploads.push(["avatar", readImage(options.avatarFile)]);
  if (options.headerFile) uploads.push(["header", readImage(options.headerFile)]);
  const clears = [
    options.clearAvatar && !options.avatarUrl ? "avatar" : null,
    options.clearHeader && !options.headerUrl ? "header" : null
  ].filter(Boolean);

  if (!patch && !uploads.length && !clears.length && !publish) {
    return { ok: false, profile: null, empty: true };
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          actor: actorHandle,
          patch,
          uploads: uploads.map(([kind, image]) => ({
            kind,
            contentType: image.contentType,
            bytes: image.bytes.length
          })),
          clears,
          publish: Boolean(publish)
        },
        null,
        2
      )
    );
    return { ok: true, profile: null };
  }

  for (const kind of clears) {
    await request(`/api/actors/${actor}/media/${kind}`, { method: "DELETE" });
    console.log(`[${actorHandle}] removed ${kind}`);
  }
  for (const [kind, image] of uploads) {
    const result = await request(`/api/actors/${actor}/media/${kind}`, {
      method: "PUT",
      body: image.bytes,
      contentType: image.contentType
    });
    console.log(
      `[${actorHandle}] uploaded ${kind}: ${result.media.file} (${result.media.bytes} bytes)`
    );
  }
  let profile = null;
  if (patch) {
    profile = (
      await request(`/api/actors/${actor}/profile`, { method: "PUT", json: patch })
    ).profile;
    console.log(`[${actorHandle}] profile stored`);
  }
  if (!profile) {
    profile = (await request(`/api/actors/${actor}/profile`)).profile;
  }

  let ok = true;
  if (publish) {
    const result = await request(`/api/actors/${actor}/publish`, { method: "POST" });
    const delivery = result.delivery || {};
    console.log(
      `[${actorHandle}] Update(Person) delivered to ${delivery.delivered ?? 0}/${delivery.followers ?? 0} followers`
    );
    if (delivery.error) console.warn(`[${actorHandle}] ${delivery.error}`);
    for (const failure of delivery.failures || []) {
      console.warn(`[${actorHandle}]   ${failure.inbox}: ${failure.error}`);
    }
    ok = Boolean(result.ok);
  }
  return { ok, profile };
}

async function main(argv = process.argv.slice(2)) {
  loadEnvFile(
    argumentValue(argv, "--env-file") ||
      process.env.FEDIBASIC_ENV_FILE ||
      DEFAULT_ENV_FILE
  );

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Run with --help to see valid options.");
    process.exitCode = 2;
    return;
  }
  if (options.help || argv.length === 0) return usage();

  const server = options.serverUrl || localApiUrl();
  const token = process.env.LAB_POST_TOKEN;
  const actor = encodeURIComponent(options.actor);
  const request = (pathname, extra) =>
    apiRequest(server, pathname, { token, ...extra });

  try {
    if (options.show) {
      const result = await request(`/api/actors/${actor}/profile`);
      console.log(JSON.stringify(result.profile ?? {}, null, 2));
      return;
    }
    if (options.preview) {
      const result = await request(`/api/actors/${actor}/preview`);
      console.log(JSON.stringify(result.actor ?? {}, null, 2));
      return;
    }

    // Declarative path: one file drives every actor. Same code below.
    if (options.fromJson) {
      const entries = readProfileFile(options.fromJson, options.actorGiven ? options.actor : null);
      let allOk = true;
      for (const [handle, spec] of entries) {
        const result = await applyProfile(
          request,
          handle,
          optionsFromSpec(spec),
          { publish: options.publish, dryRun: options.dryRun }
        );
        if (result.empty) {
          console.warn(`[${handle}] nothing to apply`);
        }
        if (!result.ok && !result.empty) allOk = false;
      }
      if (!options.publish && !options.dryRun) {
        console.log(
          "\nStored locally. Add --publish to push Update(Person) to the followers."
        );
      }
      if (!allOk) process.exitCode = 3;
      return;
    }

    const result = await applyProfile(request, options.actor, options, {
      publish: options.publish,
      dryRun: options.dryRun
    });
    if (result.empty) {
      console.error(
        "Nothing to do. Pass --show, --from-json, or one of --name/--bio*/--field/--avatar-*/--header-*, or --publish."
      );
      process.exitCode = 2;
      return;
    }
    if (result.profile) console.log(JSON.stringify(result.profile, null, 2));
    if (!options.publish && !options.dryRun) {
      console.log(
        "Stored locally. Add --publish to push Update(Person) to the followers."
      );
    }
    if (!result.ok) process.exitCode = 3;
  } catch (error) {
    console.error(`Could not update the profile:\n${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs, buildPatch, readProfileFile, optionsFromSpec };
