#!/usr/bin/env node

const path = require("node:path");
const {
  announcePost,
  createPost,
  loadEnvFile,
  localApiUrl
} = require("./postClient.js");

const DEFAULT_ENV_FILE = path.resolve(__dirname, "fedibasic.env");

function usage() {
  console.log(`Usage:
  node manual-quote-picture.js --image-url URL [options]

This creates two posts:
  1. clipboard (by default) posts a picture.
  2. news (by default) quotes that first post.

Options:
  --image-url URL       Required public picture URL
  --image-type MIME     Default: image/jpeg
  --image-alt TEXT      Required useful image description
  --image-text TEXT     Default: Original picture post
  --quote-text TEXT     Default: Quoting the picture post
  --image-actor NAME    Default: clipboard
  --quote-actor NAME    Default: news
  --server URL          Control API (default: local 127.0.0.1:PORT)
  --env-file PATH       Default: ./fedibasic.env
  --publish             Announce both posts after both were stored

Example:
  node manual-quote-picture.js \\
    --image-url https://ghostmaxxing.vecna.eu/clipboard/example.jpg \\
    --image-type image/jpeg \\
    --image-alt "A monitor showing the federation test" \\
    --image-text "The original picture" \\
    --quote-text "Quoting it from another actor" \\
    --publish
`);
}

function parseArgs(argv) {
  const values = {
    imageActor: "clipboard",
    quoteActor: "news",
    imageText: "Original picture post",
    quoteText: "Quoting the picture post",
    imageType: "image/jpeg",
    publish: false
  };
  const names = {
    "--image-url": "imageUrl",
    "--image-type": "imageType",
    "--image-alt": "imageAlt",
    "--image-text": "imageText",
    "--quote-text": "quoteText",
    "--image-actor": "imageActor",
    "--quote-actor": "quoteActor",
    "--server": "serverUrl",
    "--env-file": "envFile"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--publish") {
      values.publish = true;
    } else if (argument === "--help" || argument === "-h") {
      values.help = true;
    } else if (names[argument]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      values[names[argument]] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const envIndex = argv.indexOf("--env-file");
  loadEnvFile(
    (envIndex >= 0 && argv[envIndex + 1]) ||
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
  if (options.help) return usage();
  if (!options.imageUrl || !options.imageAlt) {
    console.error("--image-url and --image-alt are required.");
    process.exitCode = 2;
    return;
  }

  const serverUrl = options.serverUrl || localApiUrl();
  const requestOptions = { token: process.env.LAB_POST_TOKEN };
  let original;
  let quote;

  try {
    original = await createPost(
      serverUrl,
      {
        actor: options.imageActor,
        content: options.imageText,
        publish: false,
        attachment: {
          type: "Image",
          url: options.imageUrl,
          mediaType: options.imageType,
          name: options.imageAlt
        }
      },
      requestOptions
    );

    quote = await createPost(
      serverUrl,
      {
        actor: options.quoteActor,
        content: options.quoteText,
        publish: false,
        quoteUrl: original.post.url
      },
      requestOptions
    );

    const deliveries = [];
    if (options.publish) {
      deliveries.push(
        await announcePost(serverUrl, original.post.id, requestOptions)
      );
      deliveries.push(
        await announcePost(serverUrl, quote.post.id, requestOptions)
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          original: original.post,
          quote: quote.post,
          published: options.publish,
          deliveries
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(`Could not create the picture/quote pair:\n${error.message}`);
    if (original?.post && !quote?.post) {
      console.error(
        `The original was stored but the quote was not: ${original.post.url}`
      );
    }
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  main,
  parseArgs
};
