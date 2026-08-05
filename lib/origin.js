"use strict";

/**
 * @module lib/origin
 *
 * Classification of the public ActivityPub origin.
 *
 * Every id this instance mints — actor ids, `#main-key` key ids, activity ids,
 * object ids — is derived from one origin string. If that origin is a loopback
 * or private address, the ids are syntactically valid but *semantically dead*:
 * a remote server that receives one of our signed activities must fetch
 * `<origin>/federation/actors/<handle>#main-key` to verify the HTTP signature,
 * and it will refuse to dial a private address (Mastodon raises
 * `Mastodon::PrivateNetworkAddressError` and answers 401).
 *
 * The failure therefore surfaces far from its cause: an inbox POST returns 500,
 * or a publish returns 401 from the *remote*. This module lets the server detect
 * the condition up front and say so in one sentence.
 */

const PRIVATE_TLDS = [
  ".local",
  ".localhost",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".private",
  ".test",
  ".invalid",
  ".example"
];

/**
 * Whether an IPv4 dotted quad is in a non-routable range.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateIpv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const [a, b] = match.slice(1).map(Number);
  if ([a, b].some((n) => !Number.isFinite(n) || n > 255)) return false;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

/**
 * Whether an IPv6 literal (with or without brackets) is non-routable.
 * @param {string} hostname
 * @returns {boolean}
 */
function isPrivateIpv6(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!bare.includes(":")) return false;
  if (bare === "::" || bare === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true; // link-local fe80::/10
  if (bare.startsWith("::ffff:")) return isPrivateIpv4(bare.slice(7));
  return false;
}

/**
 * Whether a hostname can never be dialled by a remote fediverse server.
 *
 * Conservative on purpose: a single-label hostname (`vackend`) has no public
 * DNS meaning either, so it counts as private.
 *
 * @param {string} hostname - A URL hostname (no port).
 * @returns {boolean}
 */
function isPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  // IPv6 first: a literal like 2606:4700::1111 contains no dot, so the
  // bare-machine-name heuristic below would misjudge every public v6 address.
  if (host.includes(":") || host.startsWith("[")) return isPrivateIpv6(host);
  if (isPrivateIpv4(host)) return true;
  if (PRIVATE_TLDS.some((tld) => host.endsWith(tld))) return true;
  if (!host.includes(".")) return true; // bare machine name
  return false;
}

/**
 * Classify an origin for federation purposes.
 *
 * @param {string|URL} value - An absolute origin, e.g. `https://example.org`.
 * @returns {{origin:string, hostname:string, protocol:string, private:boolean,
 *            insecure:boolean, federable:boolean}}
 */
function classifyOrigin(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  const isPrivate = isPrivateHostname(url.hostname);
  const insecure = url.protocol !== "https:";
  return {
    origin: url.origin,
    hostname: url.hostname,
    protocol: url.protocol,
    private: isPrivate,
    // A public host reached over plain http is reachable but most servers
    // (Mastodon included) will not federate with it.
    insecure: insecure && !isPrivate,
    federable: !isPrivate && !insecure
  };
}

/**
 * Given our own origin and a set of target inbox URLs, list the inboxes that
 * cannot possibly verify our signature.
 *
 * The rule is asymmetric on purpose: a private origin delivering to a private
 * inbox is a normal local test and must keep working; a private origin
 * delivering to a public inbox is always a misconfiguration.
 *
 * @param {string} selfOrigin - This instance's public origin.
 * @param {Iterable<string|URL>} inboxUrls
 * @returns {string[]} The unreachable inbox URLs (deduplicated, sorted).
 */
function undeliverableInboxes(selfOrigin, inboxUrls) {
  const self = classifyOrigin(selfOrigin);
  if (!self.private) return [];
  const blocked = new Set();
  for (const raw of inboxUrls) {
    if (!raw) continue;
    let url;
    try {
      url = raw instanceof URL ? raw : new URL(String(raw));
    } catch {
      continue;
    }
    if (!isPrivateHostname(url.hostname)) blocked.add(url.href);
  }
  return [...blocked].sort();
}

/**
 * The one-paragraph explanation shown in logs, API errors and diagnostics.
 *
 * @param {string} selfOrigin
 * @param {string[]} [blockedInboxes]
 * @returns {string}
 */
function explainPrivateOrigin(selfOrigin, blockedInboxes = []) {
  const target = blockedInboxes.length
    ? `${blockedInboxes[0]}${blockedInboxes.length > 1 ? ` (+${blockedInboxes.length - 1} more)` : ""}`
    : "a remote inbox";
  return [
    `This instance's public ActivityPub origin is ${selfOrigin}, which is not reachable from the internet.`,
    `Every activity is signed with the key id ${selfOrigin}/federation/actors/<handle>#main-key, so ${target}`,
    "cannot fetch the key and answers 401 (Mastodon: PrivateNetworkAddressError).",
    "Set GSTMXX_PUBLIC_URL (or LAB_BASE_URL) to the HTTPS origin that remote servers use — for example",
    "GSTMXX_PUBLIC_URL=https://ghostmaxxing.vecna.eu — and restart the process."
  ].join(" ");
}

module.exports = {
  classifyOrigin,
  explainPrivateOrigin,
  isPrivateHostname,
  isPrivateIpv4,
  isPrivateIpv6,
  undeliverableInboxes
};
