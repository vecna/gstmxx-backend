"use strict";

const MAX_BODY_CHARS = 1200;

function trimBody(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}... [truncated ${text.length - MAX_BODY_CHARS} chars]`;
}

function summarizeFormData(formData) {
  const summary = [];
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      summary.push({ key, type: "string", value });
      continue;
    }
    summary.push({
      key,
      type: "blob",
      blobType: value.type || "application/octet-stream",
      blobSize: value.size,
      filename: typeof value.name === "string" ? value.name : undefined
    });
  }
  return summary;
}

async function summarizeRequestBody(body) {
  if (body == null) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return trimBody(body);
    }
  }
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) return summarizeFormData(body);
  if (body instanceof Blob) {
    return {
      type: "blob",
      blobType: body.type || "application/octet-stream",
      blobSize: body.size
    };
  }
  return String(body);
}

async function summarizeResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const clone = response.clone();
  try {
    if (/application\/json/i.test(contentType)) {
      return await clone.json();
    }
    return trimBody(await clone.text());
  } catch (error) {
    return `<<unreadable response body: ${error.message}>>`;
  }
}

function createFetchTraceLogger(options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return {
      install() {
        return () => {};
      }
    };
  }

  return {
    install() {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async function tracedFetch(input, init = undefined) {
        const method = (init && init.method) || "GET";
        const url = typeof input === "string" ? input : input.url;
        const requestBody = await summarizeRequestBody(init && init.body);

        console.log(`\n[trace][request] ${method} ${url}`);
        if (requestBody != null) {
          console.log(`[trace][request.body] ${JSON.stringify(requestBody, null, 2)}`);
        }

        const response = await originalFetch(input, init);
        const responseBody = await summarizeResponseBody(response);

        console.log(`[trace][response] ${response.status} ${method} ${url}`);
        console.log(`[trace][response.body] ${JSON.stringify(responseBody, null, 2)}`);

        return response;
      };

      return () => {
        globalThis.fetch = originalFetch;
      };
    }
  };
}

module.exports = { createFetchTraceLogger };