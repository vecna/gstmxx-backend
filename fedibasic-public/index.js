const output = document.querySelector("#output");
const origin = document.querySelector("#origin");
const actor = document.querySelector("#actor");
const postContent = document.querySelector("#post-content");
const postToken = document.querySelector("#post-token");
const postPublish = document.querySelector("#post-publish");
let config;

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}\n${text}`);
  }
  return body;
}

async function loadConfig(show = false) {
  config = await jsonRequest("/api/config");
  actor.replaceChildren(
    ...config.actors.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `@${name}`;
      return option;
    })
  );
  origin.className = config.originMatches ? "ok" : "bad";
  origin.textContent = config.originMatches
    ? `Connected at ${config.browserOrigin}. The configured Fedify origin matches.`
    : `Origin mismatch: browser=${config.browserOrigin}, Fedify=${config.configuredBaseUrl}. Restart with LAB_BASE_URL=${config.browserOrigin}`;
  if (show) {
    output.textContent = JSON.stringify(config, null, 2);
  }
}

async function run(action) {
  output.textContent = "Loading...";
  const handle = actor.value || "video";
  try {
    let body;
    if (action === "health") body = await jsonRequest("/healthz");
    if (action === "config") {
      await loadConfig(true);
      return;
    }
    if (action === "followers") body = await jsonRequest("/api/followers");
    if (action === "posts") body = await jsonRequest("/api/posts");
    if (action === "create-post") {
      const headers = { "Content-Type": "application/json" };
      if (postToken.value) headers.Authorization = `Bearer ${postToken.value}`;
      body = await jsonRequest("/api/posts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          content: postContent.value,
          actor: handle,
          publish: postPublish.checked
        })
      });
      postContent.value = "";
    }
    if (action === "webfinger") {
      const resource = `acct:${handle}@${location.host}`;
      body = await jsonRequest(`/.well-known/webfinger?resource=${encodeURIComponent(resource)}`, {
        headers: { Accept: "application/jrd+json" }
      });
    }
    if (action === "actor") {
      body = await jsonRequest(`/federation/actors/${handle}`, {
        headers: { Accept: "application/activity+json" }
      });
    }
    if (action === "announce") {
      body = await jsonRequest(`/api/announce/${handle}`, { method: "POST" });
    }
    output.textContent = JSON.stringify(body, null, 2);
  } catch (error) {
    output.textContent = error.stack || error.message;
  }
}

document.addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (action) run(action);
});

loadConfig().catch((error) => {
  origin.className = "bad";
  origin.textContent = "The browser could not reach the server.";
  output.textContent = error.stack || error.message;
});
