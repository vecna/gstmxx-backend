#!/usr/bin/env node
"use strict";

/**
 * tools/fixtures.js — build the media files the other tools upload.
 *
 *   node tools/fixtures.js            # writes tools/fixtures/{clip.mp4,clip.png,bogus.txt}
 *   node tools/fixtures.js --out DIR  # somewhere else
 *
 * Both media files deliberately carry identifying metadata so that a run of
 * the cycle can prove what the backend does with it:
 *
 *   clip.mp4  — 2 s synthetic test pattern with a sine tone, the same shape the
 *               lab records (MediaRecorder, ~2 s). Container tags: title,
 *               comment, GPS `location`. Approval must strip all of them
 *               (services/video.js, `-map_metadata -1`).
 *   clip.png  — 320x240 PNG with a tEXt `Comment` chunk. Approval copies PNGs
 *               verbatim, so the chunk must survive (fediverse.html says so).
 *   bogus.txt — not media; used to exercise the rejection paths.
 *
 * Requires `ffmpeg` on PATH for the MP4 (the backend needs it anyway). The PNG
 * is written in pure Node.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { parseArgs } = require("./lib/env");

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || path.join(__dirname, "fixtures"));
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- PNG (pure Node)
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      // Diagonal stripes in the site's orange/ink, so a moderator can tell the
      // fixture apart from a real contribution at a glance.
      const stripe = Math.floor((x + y) / 24) % 2 === 0;
      raw[o] = stripe ? 0xff : 0x14; raw[o + 1] = stripe ? 0x6a : 0x12; raw[o + 2] = stripe ? 0x00 : 0x10;
    }
  }
  const text = Buffer.concat([Buffer.from("Comment", "latin1"), Buffer.from([0]),
    Buffer.from("device=TestCam location=52.37N,4.89E gstmxx-fixture", "latin1")]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", text),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const pngPath = path.join(outDir, "clip.png");
fs.writeFileSync(pngPath, makePng(320, 240));
console.log(`wrote ${pngPath} (PNG with a tEXt Comment chunk)`);

// ---------------------------------------------------------------- MP4 (ffmpeg)
const mp4Path = path.join(outDir, "clip.mp4");
const ff = spawnSync("ffmpeg", [
  "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc=duration=2:size=640x480:rate=25",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
  "-metadata", "title=GSTMXX FIXTURE",
  "-metadata", "comment=device=TestCam location=52.37N,4.89E",
  "-metadata", "location=+52.3676+004.9041/",
  mp4Path
], { stdio: "inherit" });
if (ff.error || ff.status !== 0) {
  console.error("ffmpeg is required to build clip.mp4 (and by the backend to approve videos). PNG fixture was still written.");
  process.exitCode = 1;
} else {
  console.log(`wrote ${mp4Path} (2 s H.264/AAC with title, comment and GPS tags)`);
}

// ---------------------------------------------------------------- not media
const txtPath = path.join(outDir, "bogus.txt");
fs.writeFileSync(txtPath, "this is not a video\n");
console.log(`wrote ${txtPath}`);
