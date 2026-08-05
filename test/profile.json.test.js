"use strict";

/**
 * What this file tests
 * --------------------
 * The declarative entry point of the profile CLI: one JSON file describing
 * every actor, applied in a single run.
 *
 * How it tests it
 * ---------------
 * Writes real files to a temp directory and reads them back through the CLI's
 * own parsing functions. The path resolution matters most: image paths inside
 * the file are relative to the *file*, not to the shell's working directory,
 * so the file and its images can be committed and moved together.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { readProfileFile, optionsFromSpec, buildPatch } = require("../manual-profile.js");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstmxx-json-profile-"));
const imagesDir = path.join(workDir, "fedi-images");
fs.mkdirSync(imagesDir, { recursive: true });
fs.writeFileSync(path.join(imagesDir, "video-avatar.png"), Buffer.from([0x89, 0x50]));
fs.writeFileSync(path.join(workDir, "news-bio.txt"), "Updates from the lab.\n");

const profilePath = path.join(workDir, "fedi-profile.json");
fs.writeFileSync(
  profilePath,
  JSON.stringify({
    actors: {
      video: {
        displayName: "Ghostmaxxing / video",
        bio: "Camouflage.\n\nLab: https://ghostmaxxing.vecna.eu/lab.html",
        url: "https://ghostmaxxing.vecna.eu/",
        fields: [{ name: "Lab", value: "https://ghostmaxxing.vecna.eu/lab.html" }],
        avatarFile: "fedi-images/video-avatar.png",
        headerUrl: "https://ghostmaxxing.vecna.eu/images/social-card.png",
        indexable: false
      },
      news: {
        displayName: "Ghostmaxxing / news",
        bioFile: "news-bio.txt"
      }
    }
  })
);

test.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

test("every actor in the file is returned, in file order", () => {
  const entries = readProfileFile(profilePath);
  assert.deepEqual(
    entries.map(([handle]) => handle),
    ["video", "news"]
  );
});

test("--actor narrows the file to a single entry", () => {
  const entries = readProfileFile(profilePath, "news");
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "news");
});

test("an actor missing from the file is an error, not a silent no-op", () => {
  assert.throws(
    () => readProfileFile(profilePath, "clipboard"),
    /no entry for actor "clipboard"/
  );
});

test("a bare single-actor object needs no 'actors' nesting", () => {
  const bare = path.join(workDir, "one.json");
  fs.writeFileSync(bare, JSON.stringify({ displayName: "Solo" }));
  const entries = readProfileFile(bare, "video");
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "video");
  assert.equal(entries[0][1].displayName, "Solo");
});

test("invalid JSON names the file and the parse problem", () => {
  const broken = path.join(workDir, "broken.json");
  fs.writeFileSync(broken, "{ not json");
  assert.throws(() => readProfileFile(broken), /is not valid JSON/);
});

test("image and bio paths resolve against the file, not the shell's cwd", () => {
  const [[, spec]] = readProfileFile(profilePath, "video");
  const options = optionsFromSpec(spec);
  assert.equal(options.avatarFile, path.join(imagesDir, "video-avatar.png"));
  assert.ok(fs.existsSync(options.avatarFile));

  const [[, newsSpec]] = readProfileFile(profilePath, "news");
  const newsOptions = optionsFromSpec(newsSpec);
  assert.equal(newsOptions.bioFile, path.join(workDir, "news-bio.txt"));
});

test("a spec becomes the same patch the flag-based CLI would produce", () => {
  const [[, spec]] = readProfileFile(profilePath, "video");
  const patch = buildPatch(optionsFromSpec(spec));

  assert.equal(patch.displayName, "Ghostmaxxing / video");
  assert.match(patch.summaryText, /^Camouflage\./);
  assert.equal(patch.url, "https://ghostmaxxing.vecna.eu/");
  assert.deepEqual(patch.fields, [
    { name: "Lab", value: "https://ghostmaxxing.vecna.eu/lab.html" }
  ]);
  assert.equal(patch.headerUrl, "https://ghostmaxxing.vecna.eu/images/social-card.png");
  assert.equal(patch.indexable, false);
  // discoverable was not mentioned, so it must stay out of the patch entirely
  // rather than being sent as a default that overwrites a stored value.
  assert.equal("discoverable" in patch, false);
});

test("bioFile is read at apply time, so editing the text file is enough", () => {
  const [[, spec]] = readProfileFile(profilePath, "news");
  const patch = buildPatch(optionsFromSpec(spec));
  assert.equal(patch.summaryText, "Updates from the lab.\n");
});
