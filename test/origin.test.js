"use strict";

/**
 * What this file tests
 * --------------------
 * The rule that decides whether this instance can federate at all: an origin a
 * remote server cannot dial makes every signed activity unverifiable, because
 * the key id we sign with lives at that origin.
 *
 * How it tests it
 * ---------------
 * Pure functions, no server. The asymmetry is the point: private origin to
 * private inbox is a normal local test and must stay allowed; private origin to
 * public inbox is always the misconfiguration that produced the 401 /
 * PrivateNetworkAddressError seen in production.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  classifyOrigin,
  explainPrivateOrigin,
  isPrivateHostname,
  undeliverableInboxes
} = require("../lib/origin.js");

test("loopback, RFC1918, CGNAT and link-local hostnames are private", () => {
  for (const host of [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.4.5.6",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.50",
    "169.254.10.1",
    "100.64.0.1",
    "localhost",
    "::1",
    "[::1]",
    "fd00::1",
    "fe80::1"
  ]) {
    assert.equal(isPrivateHostname(host), true, `${host} should be private`);
  }
});

test("public hostnames and routable addresses are not private", () => {
  for (const host of [
    "ghostmaxxing.vecna.eu",
    "retro.pizza",
    "mastodon.social",
    "8.8.8.8",
    "172.32.0.1",
    "172.15.0.1",
    "2606:4700::1111"
  ]) {
    assert.equal(isPrivateHostname(host), false, `${host} should be public`);
  }
});

test("bare machine names and internal TLDs count as private", () => {
  // `vackend` and `box.local` resolve on the LAN and nowhere else, which is the
  // same practical failure as 127.0.0.1.
  for (const host of ["vackend", "box.local", "api.internal", "thing.test"]) {
    assert.equal(isPrivateHostname(host), true, `${host} should be private`);
  }
});

test("classifyOrigin separates 'unreachable' from 'reachable but plain http'", () => {
  const production = classifyOrigin("https://ghostmaxxing.vecna.eu");
  assert.equal(production.private, false);
  assert.equal(production.insecure, false);
  assert.equal(production.federable, true);

  const loopback = classifyOrigin("http://127.0.0.1:4040");
  assert.equal(loopback.private, true);
  assert.equal(loopback.federable, false);
  // A private host is not additionally flagged as "insecure": there is one
  // problem to fix, not two.
  assert.equal(loopback.insecure, false);

  const plainHttp = classifyOrigin("http://ghostmaxxing.vecna.eu");
  assert.equal(plainHttp.private, false);
  assert.equal(plainHttp.insecure, true);
  assert.equal(plainHttp.federable, false);
});

test("a private origin blocks delivery to public inboxes only", () => {
  const blocked = undeliverableInboxes("http://127.0.0.1:4040", [
    "https://retro.pizza/inbox",
    "https://mastodon.social/inbox",
    "http://127.0.0.1:5050/inbox"
  ]);
  assert.deepEqual(blocked, [
    "https://mastodon.social/inbox",
    "https://retro.pizza/inbox"
  ]);
});

test("a public origin blocks nothing", () => {
  const blocked = undeliverableInboxes("https://ghostmaxxing.vecna.eu", [
    "https://retro.pizza/inbox",
    "http://127.0.0.1:5050/inbox"
  ]);
  assert.deepEqual(blocked, []);
});

test("local-to-local delivery stays allowed, so the test suite keeps working", () => {
  assert.deepEqual(
    undeliverableInboxes("http://127.0.0.1:4040", [
      "http://127.0.0.1:5050/inbox",
      "http://localhost:6060/inbox"
    ]),
    []
  );
});

test("malformed inbox URLs are skipped rather than throwing", () => {
  assert.deepEqual(
    undeliverableInboxes("http://127.0.0.1:4040", ["not a url", "", null]),
    []
  );
});

test("the explanation names the origin, the key path and the fix", () => {
  const message = explainPrivateOrigin("http://127.0.0.1:4040", [
    "https://retro.pizza/inbox"
  ]);
  assert.match(message, /http:\/\/127\.0\.0\.1:4040/);
  assert.match(message, /#main-key/);
  assert.match(message, /retro\.pizza/);
  assert.match(message, /GSTMXX_PUBLIC_URL/);
});
