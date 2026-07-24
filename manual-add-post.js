#!/usr/bin/env node

const path = require("node:path");
const {
  createPost,
  loadEnvFile,
  localApiUrl
} = require("./postClient.js");

const DEFAULT_ENV_FILE = path.resolve(__dirname, "fedibasic.env");
const VALUE_OPTIONS = new Set([
  "--actor",
  "--server",
  "--env-file",
  "--image-url",
  "--image-type",
  "--image-alt",
  "--quote"
]);

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function takeValue(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${argv[index]} requires a value.`);
  }
  return value;
}

function unknownOption(argument) {
  const suggestion =
    argument === "--publih"
      ? " Did you mean --publish?"
      : argument === "--image"
        ? " Did you mean --image-url?"
        : "";
  throw new Error(`Unknown option: ${argument}.${suggestion}`);
}

function parseArgs(argv) {
  const options = {
    actor: "video",
    publish: false,
    dryRun: false,
    contentParts: []
  };
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (positionalOnly) {
      options.contentParts.push(argument);
    } else if (argument === "--") {
      positionalOnly = true;
    } else if (VALUE_OPTIONS.has(argument)) {
      const value = takeValue(argv, index);
      const key = {
        "--actor": "actor",
        "--server": "serverUrl",
        "--env-file": "envFile",
        "--image-url": "imageUrl",
        "--image-type": "imageType",
        "--image-alt": "imageAlt",
        "--quote": "quoteUrl"
      }[argument];
      options[key] = value;
      index += 1;
    } else if (argument === "--publish") {
      options.publish = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument.startsWith("--")) {
      unknownOption(argument);
    } else {
      options.contentParts.push(argument);
    }
  }
  return options;
}

function usage() {
  console.log(`Usage:
  node manual-add-post.js [options] -- "post text"

Options:
  --actor NAME       video, ghostyles, news, or clipboard
  --publish          Deliver a Create to this actor's followers
  --server URL       Control API (default: LAB_API_URL or http://127.0.0.1:PORT)
  --env-file PATH    Load configuration (default: ./fedibasic.env)
  --image-url URL    Attach a publicly fetchable picture
  --image-type MIME  Picture MIME type (default: image/jpeg)
  --image-alt TEXT   Picture description/alt text
  --quote URL        Quote an ActivityPub object
  --dry-run          Print the request without sending it

Examples:
  node manual-add-post.js --actor video --publish -- "hello from the CLI"
  node manual-add-post.js --server 127.0.0.1:4040 --dry-run -- "test"
  node manual-add-post.js --actor clipboard --image-url https://example/image.jpg \\
    --image-alt "A test image" --publish -- "picture post"
`);
}

async function main(argv = process.argv.slice(2)) {
  const requestedEnv =
    argumentValue(argv, "--env-file") ||
    process.env.FEDIBASIC_ENV_FILE ||
    DEFAULT_ENV_FILE;
  loadEnvFile(requestedEnv);

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error("Run with --help to see valid options.");
    process.exitCode = 2;
    return;
  }
  if (options.help) return usage();

  const content = options.contentParts.join(" ").trim();
  if (!content) {
    console.error("Missing post text. Put -- before text that starts with a dash.");
    process.exitCode = 2;
    return;
  }

  const payload = {
    content,
    actor: options.actor,
    publish: options.publish
  };
  if (options.imageUrl) {
    payload.attachment = {
      type: "Image",
      url: options.imageUrl,
      mediaType: options.imageType || "image/jpeg",
      name: options.imageAlt || "Image attached from the manual CLI"
    };
  }
  if (options.quoteUrl) payload.quoteUrl = options.quoteUrl;

  try {
    const result = await createPost(
      options.serverUrl || localApiUrl(),
      payload,
      {
        token: process.env.LAB_POST_TOKEN,
        dryRun: options.dryRun
      }
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Could not add post:\n${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs
};
