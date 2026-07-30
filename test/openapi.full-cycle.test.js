"use strict";

const test = require("node:test");
const { before, after } = test;

const { createCycleHarness } = require("./openapi-cycle/harness.js");
const { runStep1 } = require("./openapi-cycle/step1-upload-and-system.js");
const { runStep2 } = require("./openapi-cycle/step2-moderation.js");
const { runStep3 } = require("./openapi-cycle/step3-visibility.js");
const { runStep4 } = require("./openapi-cycle/step4-digest-trigger.js");
const { runStep5 } = require("./openapi-cycle/step5-digest-check.js");
const { runStep6 } = require("./openapi-cycle/step6-admin-news.js");
const { runStep7 } = require("./openapi-cycle/step7-news-propagation.js");
const { runStep8 } = require("./openapi-cycle/step8-aggregation-and-federation.js");
const { runStep9 } = require("./openapi-cycle/step9-cleanup.js");
const { runStep10 } = require("./openapi-cycle/step10-empty-check.js");

const cycle = createCycleHarness();

before(async () => {
  await cycle.startServer();
});

after(async () => {
  await cycle.stopServer();
  cycle.cleanup();
});

/**
 * End-to-end 10-step OpenAPI cycle:
 * 1) users upload everything possible,
 * 2) admin allows/denies,
 * 3) visibility checks,
 * 4) digest first trigger,
 * 5) digest verification,
 * 6) 10 random admin news,
 * 7) news propagation,
 * 8) aggregation/federation/static/media coverage,
 * 9) deletion/cleanup,
 * 10) reconnect and verify empty.
 */
test("openapi full cycle with explicit fetch payloads", async (t) => {
  await runStep1(t, cycle);
  await runStep2(t, cycle);
  await runStep3(t, cycle);
  await runStep4(t, cycle);
  await runStep5(t, cycle);
  await runStep6(t, cycle);
  await runStep7(t, cycle);
  await runStep8(t, cycle);
  await runStep9(t, cycle);
  await runStep10(t, cycle);

  cycle.assertCoveredAllOperations();
});