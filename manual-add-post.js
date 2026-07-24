#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_ENV_FILE = path.resolve(__dirname, "fedibasic.env.example");

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv) {
  const options = {
    actor: "video",
    publish: false,
    serverUrl: process.env.LAB_API_URL,
    envFile: process.env.FEDIBASIC_ENV_FILE || DEFAULT_ENV_FILE,
    contentParts: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--actor") {
      options.actor = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--server") {
      options.serverUrl = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--env-file") {
      options.envFile = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--publish") {
      options.publish = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      options.contentParts.push(argument);
    }
  }

  return options;
}

function usage() {
  console.log(`Usage:
  npm run post -- [--actor video] [--publish] [--server URL] "post text"

Options:
  --actor NAME    Local actor: video, ghostyles, news, or clipboard
  --publish       Also send a Create activity to the actor's followers
  --server URL    Local API URL (default: LAB_API_URL or LAB_BASE_URL)
  --env-file PATH Load env defaults from a Fedibasic-style env file

Examples:
  npm run post -- "Hello from the lab"
  npm run post -- --actor news --publish $'First line\\nSecond line'
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }

  loadEnvFile(options.envFile);

  const serverUrl =
    options.serverUrl ||
    process.env.LAB_BASE_URL ||
    `http://127.0.0.1:${process.env.PORT || "4040"}`;
  const content = options.contentParts.join(" ");

  if (!content) {
    console.error("Missing post text. Run with --help for examples.");
    process.exit(2);
  }

  const headers = { "Content-Type": "application/json" };
  if (process.env.LAB_POST_TOKEN) {
    headers.Authorization = `Bearer ${process.env.LAB_POST_TOKEN}`;
  }

  try {
    const response = await fetch(
      new URL("/api/posts", `${serverUrl.replace(/\/+$/, "")}/`),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          actor: options.actor,
          publish: options.publish
        })
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText}: ${body.message || "request failed"}`
      );
    }
    console.log(JSON.stringify(body, null, 2));
  } catch (error) {
    console.error(`Could not add post: ${error.message}`);
    process.exit(1);
  }
}

main();
