/**
 * Telegram Retry Utility
 *
 * Wraps Telegram API calls (ctx.reply, ctx.editMessageText, etc.)
 * with automatic retry logic for 429 Too Many Requests errors.
 *
 * Telegram's rate limiting returns a `retry_after` field (in seconds).
 * This utility sleeps for `retry_after + 1` seconds before retrying,
 * up to `maxRetries` attempts.
 *
 * Usage:
 *   const { tgRetry } = require('./utils/telegramRetry');
 *   await tgRetry(() => ctx.reply("Hello"), 'ctx.reply');
 */

/**
 * Sleep helper — pauses execution for `ms` milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * tgRetry(fn, label)
 *
 * @param {Function} fn  - Async function that calls a Telegram API method.
 *                          Must return a Promise (i.e. be an awaited or native Promise call).
 * @param {string}   label - A short label for log messages (e.g., 'ctx.reply', 'editMessageText').
 * @param {number}   maxRetries - Maximum number of retry attempts (default: 3).
 *
 * @returns {Promise<any>} Resolves with the Telegram API result.
 *                         Never throws — all errors are caught and logged.
 *                         Returns undefined if all retries are exhausted.
 */
const tgRetry = async (fn, label = 'telegramCall', maxRetries = 3) => {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        console.log(`[tgRetry] ✅ ${label} succeeded on attempt ${attempt}/${maxRetries}`);
      }
      return result;
    } catch (err) {
      lastError = err;

      // ── Check if this is a Telegram 429 rate limit error ──
      const is429 =
        err?.response?.error_code === 429 ||
        err?.response?.statusCode === 429 ||
        err?.error_code === 429;

      if (is429) {
        // Extract retry_after: Telegram sends it in err.response.parameters.retry_after
        // or sometimes in err.parameters.retry_after
        const retryAfter =
          err?.response?.parameters?.retry_after ||
          err?.parameters?.retry_after ||
          5; // fallback: 5 seconds

        // Add 1s buffer to be safe
        const waitMs = (retryAfter + 1) * 1000;

        console.warn(
          `[tgRetry] ⏳ ${label} hit 429 rate limit (attempt ${attempt}/${maxRetries}). ` +
          `Retrying after ${retryAfter + 1}s...`
        );

        if (attempt < maxRetries) {
          await sleep(waitMs);
          continue;
        }
      } else {
        // ── Non-429 error — log and give up immediately ──
        console.error(`[tgRetry] ❌ ${label} failed (non-429):`, err.message);
        return undefined;
      }
    }
  }

  // ── All retries exhausted ──
  console.error(
    `[tgRetry] ❌ ${label} failed after ${maxRetries} attempts. ` +
    `Last error: ${lastError?.message || 'unknown'}`
  );
  return undefined;
};

module.exports = { tgRetry };