/**
 * utils/telegramMediaSafe.js
 *
 * Production-safe image pipeline for Telegram sendMediaGroup.
 * Guarantees ALL mediaGroup URLs are valid, preventing:
 *   - "invalid file HTTP URL specified"
 *   - "Disallowed character in URL host"
 *
 * Usage:
 *   const { sanitizeImages } = require("../utils/telegramMediaSafe");
 *   adData.images = sanitizeImages(adData.images);
 *
 * ==============================================================
 * TELEGRAM SAFETY RULES (enforced here):
 *   • NEVER send raw scraped URLs directly
 *   • ALWAYS sanitize before sendMediaGroup
 *   • MAX 10 images per request
 *   • NO exceptions
 * ==============================================================
 */

/* ──────────────────────────────────────────────────────────────
 * normalizeUrl(url)
 * ------------------
 * Removes backslashes from a URL (fixes accidental escaping).
 * Use this BEFORE any axios.get() call to prevent crashes.
 *
 * @param  {string} url - URL that may contain backslashes
 * @return {string}     - Clean URL without backslashes
 * ────────────────────────────────────────────────────────────── */
function normalizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  return url
    .replace(/\\\\/g, "")    // remove escaped backslashes
    .replace(/\\/g, "")      // remove single backslashes
    .replace(/\s/g, "")      // remove ALL whitespace (spaces, tabs, newlines)
    .replace(/([^:])\/\//g, "$1/")  // remove duplicate "//" (but keep protocol "https://")
    .trim();
}

/* ──────────────────────────────────────────────────────────────
 * safeUrl(url)
 * ------------
 * Returns a clean http/https URL without any escaping or backslashes.
 * Validates the URL is a proper http/https URL.
 *
 * @param  {*} url - Raw URL (may contain backslashes from prior escaping)
 * @return {string|null} - Clean URL or null if invalid
 * ────────────────────────────────────────────────────────────── */
function safeUrl(url) {
  if (url === null || url === undefined || typeof url !== "string") {
    return null;
  }
  // Remove any backslashes (from accidental escaping)
  let cleaned = url.replace(/\\/g, "");
  cleaned = cleaned.trim();
  // Must be http/https
  if (!/^https?:\/\//i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/* ──────────────────────────────────────────────────────────────
 * normalizeImageUrl(url)
 * -----------------------
 * Validates and normalizes a single image URL.
 *
 * RULES:
 *   - return null if invalid
 *   - trim spaces
 *   - fix protocol: "//img.jpg" → "https://img.jpg"
 *   - reject: relative paths (/images/...)
 *   - reject: data:image/*
 *   - reject: empty/null
 *   - reject: URLs with spaces
 *   - allow only http/https
 *
 * @param  {*} url - Raw image URL
 * @return {string|null} - Normalized URL or null if invalid
 * ────────────────────────────────────────────────────────────── */
function normalizeImageUrl(url) {
  // Reject null/undefined/non-string
  if (url === null || url === undefined || typeof url !== "string") {
    return null;
  }

  // Trim whitespace
  let normalized = url.trim();

  // Reject empty after trim
  if (normalized.length === 0) {
    return null;
  }

  // Reject data:image URLs (base64 embedded images)
  if (/^data:\s*image\//i.test(normalized)) {
    return null;
  }

  // Reject relative paths (starts with / but not //)
  if (/^\/[^\/]/.test(normalized)) {
    return null;
  }

  // Fix protocol: "//img.jpg" → "https://img.jpg"
  if (normalized.startsWith("//")) {
    normalized = "https:" + normalized;
  }

  // BUG v2.1 FIXED: Fix triple-slash "https:///path" → "https://path"
  // Caused by broken __PROTO__ trick in scraper that created https:///i.simpalsmedia.com/...
  normalized = normalized.replace(/(https?:\/\/)(\/)+/g, '$1');

  // Reject URLs containing spaces (after protocol fix)
  if (/\s/.test(normalized)) {
    return null;
  }

  // Reject if not http or https
  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }

  // Final regex validation — must be valid http/https URL
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) {
    return null;
  }

  return normalized;
}

/* ──────────────────────────────────────────────────────────────
 * sanitizeImages(imagesArray)
 * ---------------------------
 * Processes an array of image URLs through the safety pipeline.
 *
 * STEPS:
 *   1. map normalizeImageUrl on each entry
 *   2. filter(Boolean) to remove nulls
 *   3. remove duplicates (Set)
 *   4. cap at 10 images (Telegram safety limit)
 *
 * @param  {Array} imagesArray - Raw array of image URLs
 * @return {Array}             - Clean, deduplicated, limited array
 * ────────────────────────────────────────────────────────────── */
function sanitizeImages(imagesArray) {
  // Ensure we have an array
  if (!Array.isArray(imagesArray)) {
    console.warn('⚠️ [sanitizeImages] Input is not an array:', typeof imagesArray);
    return [];
  }

  console.log('[sanitizeImages] INPUT count:', imagesArray.length);
  if (imagesArray.length > 0) {
    console.log('[sanitizeImages] First 3 raw URLs:', JSON.stringify(imagesArray.slice(0, 3)));
  }

  // Step 1-2: normalize and remove invalid
  const valid = imagesArray
    .map((url) => normalizeImageUrl(url))
    .filter(Boolean);

  console.log('[sanitizeImages] After normalize+filter:', valid.length, 'valid URLs');

  // Step 3: remove duplicates
  const unique = [...new Set(valid)];

  console.log('[sanitizeImages] After dedupe:', unique.length, 'unique URLs');
  if (unique.length > 0) {
    console.log('[sanitizeImages] First 3 clean URLs:', JSON.stringify(unique.slice(0, 3)));
  }

  // Step 4: cap at 10 (Telegram safety limit)
  const capped = unique.slice(0, 10);
  console.log('[sanitizeImages] FINAL count (capped at 10):', capped.length);
  return capped;
}

/* ──────────────────────────────────────────────────────────────
 * validateImageUrl(url)
 * ----------------------
 * OPTIONAL lightweight HEAD-based validation.
 * Checks that the URL is reachable before sending to Telegram.
 *
 * NOTE: This is an async HEAD request. Use sparingly to avoid
 * rate-limiting. For most cases, normalizeImageUrl + sanitizeImages
 * is sufficient.
 *
 * @param  {string}  url - Image URL to validate
 * @return {Promise<boolean>} - true if URL is reachable
 * ────────────────────────────────────────────────────────────── */
async function validateImageUrl(url) {
  // Must pass basic normalization first
  const normalized = normalizeImageUrl(url);
  if (!normalized) {
    return false;
  }

  try {
    const https = require("https");
    const http = require("http");

    const client = normalized.startsWith("https") ? https : http;

    return new Promise((resolve) => {
      const req = client.request(
        normalized,
        { method: "HEAD", timeout: 5000 },
        (res) => {
          // Consider 2xx and 3xx as valid
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  } catch {
    return false;
  }
}

/* ──────────────────────────────────────────────────────────────
 * sanitizeText(text)
 * -------------------
 * Sanitizes text for Strapi payload fields (infos, description).
 *
 * BUG v2.1 FIXED: Removes unnecessary backslashes, normalizes
 * whitespace while preserving newlines, keeps unicode intact.
 *
 * RULES:
 *   - Remove unnecessary backslashes (\. \_ \€ \+)
 *   - Preserve intentional newlines (\n)
 *   - Collapse multiple spaces within a line
 *   - Preserve unicode characters (emoji, diacritics)
 *   - Trim result
 *
 * @param  {string} text - Raw text that may contain escaped chars
 * @return {string}      - Clean text safe for Strapi payload
 * ────────────────────────────────────────────────────────────── */
function sanitizeText(text) {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') text = String(text);

  return text
    // Remove backslash before special chars: \. → ., \_ → _, \€ → €, \+ → +
    .replace(/\\([._€+])/g, '$1')
    // Remove backslash before regex special chars
    .replace(/\\([|{}[\]()*?^$])/g, '$1')
    // Remove any remaining stray backslashes
    .replace(/\\+/g, '')
    // Split by newline to preserve them
    .split('\n')
    // Normalize whitespace per line
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    // Rejoin with newlines
    .join('\n')
    // Collapse excessive blank lines
    .replace(/\n{3,}/g, '\n\n')
    // Final trim
    .trim();
}

module.exports = {
  normalizeImageUrl,
  sanitizeImages,
  validateImageUrl,
  normalizeUrl,
  safeUrl,
  sanitizeText,
};
