"use strict";

/**
 * @module routes/latest
 *
 * The `/latest` news aggregator, served by Node behind the nginx micro-cache.
 * The rendered pages and the search index come from an injected cache whose
 * contents are rebuilt on news publish/delete (with a short TTL backstop), so
 * requests are answered from memory and the output is stable enough for nginx
 * to cache too.
 */

const express = require("express");

/**
 * Build the latest router.
 *
 * @param {Object} ctx
 * @param {{latestHtml:()=>string, archiveHtml:()=>string, index:()=>Object[]}} ctx.cache
 * @returns {import("express").Router}
 */
function createLatestRouter(ctx) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    res.type("html").send(ctx.cache.latestHtml());
  });

  router.get("/archive", (_req, res) => {
    res.type("html").send(ctx.cache.archiveHtml());
  });

  router.get("/index.json", (_req, res) => {
    res.json(ctx.cache.index());
  });

  return router;
}

module.exports = { createLatestRouter };
