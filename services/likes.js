"use strict";

/**
 * @module services/likes
 *
 * Pure helpers for inbox `Like` / `Undo(Like)` bookkeeping. A post carries a
 * de-duplicated `likers` array (remote actor ids) and a derived `likes` count.
 * `likes` is what `-top-rated` filter actors rank on. Kept pure so the counting
 * logic is unit-testable without signed inbox delivery.
 */

/**
 * Extract the post UUID from a local `/posts/{uuid}` URL, or null if the URL is
 * not a post on our own origin.
 *
 * @param {(string|URL)} objectUrl
 * @param {string} baseUrl - Our public origin.
 * @returns {?string}
 */
function postIdFromUrl(objectUrl, baseUrl) {
  if (!objectUrl) return null;
  let url;
  try {
    url = new URL(String(objectUrl));
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin) return null;
  const match = /^\/posts\/([0-9a-f-]{36})$/i.exec(url.pathname);
  return match ? match[1] : null;
}

/**
 * Add a liker, returning the patch to persist. Idempotent per liker.
 * @param {Object} post
 * @param {string} likerId - Remote actor id (href).
 * @returns {{likers:string[], likes:number}}
 */
function applyLike(post, likerId) {
  const likers = Array.isArray(post.likers) ? post.likers.slice() : [];
  if (!likers.includes(likerId)) likers.push(likerId);
  return { likers, likes: likers.length };
}

/**
 * Remove a liker, returning the patch to persist. Idempotent.
 * @param {Object} post
 * @param {string} likerId
 * @returns {{likers:string[], likes:number}}
 */
function applyUnlike(post, likerId) {
  const likers = (Array.isArray(post.likers) ? post.likers : []).filter((id) => id !== likerId);
  return { likers, likes: likers.length };
}

module.exports = { postIdFromUrl, applyLike, applyUnlike };
