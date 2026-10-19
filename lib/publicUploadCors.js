"use strict";

/** Public, cookie-free intake and token-authorised owner deletion.
 * Mirrors may read upload responses; DELETE still requires X-Delete-Token.
 * Deliberately scoped to /api/uploads, never the admin or federation routes.
 */
function publicUploadCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Delete-Token");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
}
module.exports = { publicUploadCors };
