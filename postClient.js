const fs = require("node:fs");

function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    if (process.env[key] != null) continue;
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

function normalizeServerUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate) throw new Error("The server URL is empty.");
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
    ? candidate
    : /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(candidate)
      ? `http://${candidate}`
      : `https://${candidate}`;
  const url = new URL(withScheme);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported server protocol: ${url.protocol}`);
  }
  return url;
}

function localApiUrl() {
  return (
    process.env.LAB_API_URL ||
    `http://127.0.0.1:${process.env.PORT || "4040"}`
  );
}

function errorChain(error) {
  const parts = [];
  for (let current = error; current; current = current.cause) {
    const code = current.code ? `${current.code}: ` : "";
    const message = current.message || String(current);
    if (!parts.includes(`${code}${message}`)) parts.push(`${code}${message}`);
  }
  return parts.join(" -> ");
}

function connectionHint(error) {
  const detail = errorChain(error);
  if (detail.includes("ECONNREFUSED")) {
    return "The API is not listening there. Check npm run fedibasic:start and the PORT value.";
  }
  if (detail.includes("ENOTFOUND")) {
    return "DNS could not resolve that host. Check the spelling (for example, hhostmaxxing vs ghostmaxxing).";
  }
  if (
    detail.includes("CERT_") ||
    detail.includes("certificate") ||
    detail.includes("TLS")
  ) {
    return "TLS validation failed. Check the certificate and hostname; do not disable certificate checks.";
  }
  return "On the server machine, prefer --server http://127.0.0.1:PORT. LAB_BASE_URL is the public ActivityPub identity, not necessarily the local control route.";
}

async function createPost(serverUrl, payload, options = {}) {
  const target = new URL("/api/posts", normalizeServerUrl(serverUrl));
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  if (options.dryRun) {
    return {
      dryRun: true,
      target: target.href,
      headers: {
        ...headers,
        ...(headers.Authorization ? { Authorization: "Bearer [redacted]" } : {})
      },
      payload
    };
  }

  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs || 10_000)
    });
  } catch (error) {
    const wrapped = new Error(
      `Request did not reach the API.\nTarget: ${target.href}\nCause: ${errorChain(error)}\nHint: ${connectionHint(error)}`
    );
    wrapped.cause = error;
    throw wrapped;
  }

  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { rawBody };
  }

  if (!response.ok) {
    throw new Error(
      `API returned ${response.status} ${response.statusText}.\nTarget: ${target.href}\nResponse: ${body.message || rawBody || "(empty body)"}`
    );
  }
  return body;
}

async function announcePost(serverUrl, postId, options = {}) {
  const base = normalizeServerUrl(serverUrl);
  const target = new URL(
    `/api/posts/${encodeURIComponent(postId)}/announce`,
    base
  );
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs || 10_000)
    });
  } catch (error) {
    throw new Error(
      `Announce did not reach the API.\nTarget: ${target.href}\nCause: ${errorChain(error)}\nHint: ${connectionHint(error)}`,
      { cause: error }
    );
  }
  const rawBody = await response.text();
  let body;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = { rawBody };
  }
  if (!response.ok) {
    throw new Error(
      `Announce returned ${response.status} ${response.statusText}: ${body.message || rawBody || "(empty body)"}`
    );
  }
  return body;
}

module.exports = {
  announcePost,
  createPost,
  loadEnvFile,
  localApiUrl,
  normalizeServerUrl
};
