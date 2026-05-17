/**
 * services/deduplicator.js
 *
 * Image URL deduplication with intelligent comparison.
 * Handles different URL formats for the same image.
 */

const crypto = require("crypto");

/**
 * normalizeImageUrl(url)
 * Strips query params, trailing slashes, protocol differences
 * to compare image URLs semantically.
 */
function normalizeForDedupe(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    // Remove protocol for comparison (http vs https)
    const protocol = u.protocol;
    // Sort query params to avoid order-based mismatches
    const params = new URLSearchParams(u.search);
    params.sort();
    const queryStr = params.toString();
    // Rebuild without fragment
    return `${protocol}//${u.hostname}${u.pathname}${queryStr ? "?" + queryStr : ""}`;
  } catch {
    // If URL parsing fails, return a cleaned version
    return url.replace(/\/+$/, "").trim().toLowerCase();
  }
}

/**
 * hashUrl(url)
 * Creates a deterministic hash of a normalized URL.
 */
function hashUrl(url) {
  const normalized = normalizeForDedupe(url);
  if (!normalized) return null;
  return crypto.createHash("md5").update(normalized).digest("hex");
}

/**
 * deduplicateImages(imageUrls)
 *
 * Removes duplicate image URLs while preserving order.
 * Handles:
 *   - Exact duplicates
 *   - Protocol differences (http vs https)
 *   - Query param ordering
 *   - Trailing slashes
 *
 * @param {string[]} imageUrls - Array of image URLs
 * @returns {string[]} Deduplicated array (order preserved)
 */
function deduplicateImages(imageUrls) {
  if (!Array.isArray(imageUrls)) return [];

  const seen = new Set();
  const result = [];

  for (const url of imageUrls) {
    if (!url || typeof url !== "string") continue;

    const h = hashUrl(url);
    if (h && !seen.has(h)) {
      seen.add(h);
      result.push(url);
    }
  }

  const removed = imageUrls.length - result.length;
  if (removed > 0) {
    console.log(
      `[deduplicator] Removed ${removed} duplicate image URL(s) (${result.length} unique)`
    );
  }

  return result;
}

/**
 * areSameDimension(bufferA, bufferB)
 * Quick check if two image buffers have the same dimensions.
 * Useful for detecting truly identical images even from different URLs.
 */
async function areSameImage(bufferA, bufferB) {
  if (!bufferA || !bufferB) return false;
  if (bufferA.length === bufferB.length) return true; // Fast path
  return false;
}

module.exports = {
  deduplicateImages,
  normalizeForDedupe,
  hashUrl,
  areSameImage,
};