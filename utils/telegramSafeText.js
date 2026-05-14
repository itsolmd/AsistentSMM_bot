/**
 * utils/telegramSafeText.js
 *
 * Global "safe text system" that prevents ANY Telegram formatting crash.
 * - escapeTelegramText()     → neutralizes all MarkdownV2 dangerous characters
 * - sanitizeAdData()         → recursively sanitizes TEXT fields in adData,
 *                              but SKIPS URL/image fields to avoid corruption
 * - safeUrl()                → returns clean http/https URL without escapes
 *
 * CRITICAL RULE:
 *   NEVER escape dots in URLs. Only escape text content.
 *   URL fields (images, thumbnails, links) MUST remain intact.
 *
 * Usage:
 *   const { sanitizeAdData, safeUrl } = require("../utils/telegramSafeText");
 *   adData = sanitizeAdData(adData);
 *   const cleanUrl = safeUrl(rawUrl);
 */

/* ──────────────────────────────────────────────
 * MarkdownV2 special characters
 * ──────────────────────────────────────────────
 * NOTE: Dots (.) are NOT escaped because:
 *   1. Messages use parse_mode: "Markdown" (NOT MarkdownV2)
 *   2. Markdown mode does NOT require dot escaping
 *   3. Escaping dots corrupts prices: "97.000 €" → "97\.000 \€"
 *   4. Escaping dots corrupts IDs: "DB_Ap101563488" → "DB_Ap101563488" (underscore also not needed in Markdown mode)
 */
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!]/g;

/**
 * isUrl(str)
 * ----------
 * Quick check if a string is likely a URL (http/https scheme).
 * Used to prevent escaping dots in URLs.
 */
function isUrl(str) {
  if (typeof str !== "string") return false;
  return /^https?:\/\//i.test(str) || /^data:\s*image\//i.test(str);
}

/**
 * safeUrl(url)
 * ------------
 * Returns a clean http/https URL without any escaping or backslashes.
 * Removes any backslash characters that may have been introduced by
 * accidental escaping.
 *
 * @param  {*} url - Raw URL (may contain backslashes from prior escaping)
 * @return {string|null} - Clean URL or null if invalid
 */
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

/**
 * escapeTelegramText(text)
 * -------------------------
 * Removes / neutralizes ALL MarkdownV2 dangerous characters.
 * Returns safe plain text that will never break Telegram parsing.
 *
 * IMPORTANT: This function is for TEXT only. URLs are returned
 * unchanged to prevent dot-escaping corruption.
 *
 * @param  {*} text - Input value (will be coerced to string)
 * @return {string}  - Safe plain text
 */
function escapeTelegramText(text) {
  // Convert null/undefined to empty string
  if (text === null || text === undefined) {
    return "";
  }

  // Ensure we're working with a string
  let str = String(text);

  // SAFETY: If the string is a URL, return it UNCHANGED — never escape dots in URLs
  if (isUrl(str)) {
    return str;
  }

  // Replace each MarkdownV2 special character with a safe alternative.
  // CRITICAL: Dots (.) and underscores (_) are NOT escaped because:
  //   - Messages use parse_mode: "Markdown" (NOT MarkdownV2)
  //   - Escaping dots breaks prices: "97.000 €" → "97\.000 \€" ✗
  //   - Escaping underscores breaks IDs: "DB_Ap101563488" → "DB\_Ap101563488" ✗
  // BUG v2.1 FIXED: Removed `+` escaping. The `+` character is NOT special
  // in Telegram Markdown mode (only in MarkdownV2). Escaping `+` to `\+`
  // caused phone numbers to appear as "\+373..." in output.
  return str
    .replace(/\*/g, "\\*")    // asterisk
    .replace(/\[/g, "\\[")    // open bracket
    .replace(/\]/g, "\\]")    // close bracket
    .replace(/\(/g, "\\(")    // open parenthesis
    .replace(/\)/g, "\\)")    // close parenthesis
    .replace(/~/g, "\\~")     // tilde
    .replace(/`/g, "\\`")     // backtick
    .replace(/>/g, "\\>")     // greater than
    .replace(/#/g, "\\#")     // hash
    .replace(/-/g, "\\-")     // minus/dash
    .replace(/=/g, "\\=")     // equals
    .replace(/\|/g, "\\|")    // pipe
    .replace(/\{/g, "\\{")    // open brace
    .replace(/\}/g, "\\}")    // close brace
    .replace(/!/g, "\\!");    // exclamation
}

/**
 * sanitizeAdData(adData)
 * -----------------------
 * Recursively sanitizes all text fields in an adData object.
 * Handles nested objects, arrays of strings, and primitive values.
 *
 * CRITICAL: URL fields (images, thumbnails, links) are NOT escaped.
 * Only human-readable text fields are sanitized for Telegram MarkdownV2.
 *
 * Fields sanitized:
 *   name, description, address, region, title,
 *   contact fields, and any other string property found.
 *
 * @param  {*} adData - The scraped ad data object
 * @return {*}        - Sanitized copy with all strings made safe
 */
function sanitizeAdData(adData) {
  // Handle null/undefined
  if (adData === null || adData === undefined) {
    return adData;
  }

  // If it's a string, sanitize it
  if (typeof adData === "string") {
    return escapeTelegramText(adData);
  }

  // If it's a number or boolean, return as-is
  if (typeof adData === "number" || typeof adData === "boolean") {
    return adData;
  }

  // If it's an array, sanitize each element recursively
  if (Array.isArray(adData)) {
    return adData.map((item) => sanitizeAdData(item));
  }

  // If it's an object (and not null), sanitize each value recursively
  if (typeof adData === "object") {
    const sanitized = {};
    for (const [key, value] of Object.entries(adData)) {
      sanitized[key] = sanitizeAdData(value);
    }
    return sanitized;
  }

  // Fallback: return as-is (shouldn't reach here)
  return adData;
}

module.exports = { escapeTelegramText, sanitizeAdData, safeUrl };