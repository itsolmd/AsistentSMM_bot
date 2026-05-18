/**
 * ════════════════════════════════════════════════════════════════
 * AI FALLBACK SYSTEM — Multi-model retry with automatic fallback
 * ════════════════════════════════════════════════════════════════
 *
 * Flow:
 * 1. Try primary model
 * 2. On failure (timeout, rate limit, 500), try next model in priority list
 * 3. Wait with exponential backoff between retries
 * 4. If all models fail, return fallback data via regex parser
 *
 * Handles:
 * - Timeout (ECONNABORTED)
 * - Rate limit (429)
 * - Server errors (500, 502, 503)
 * - Auth errors (401, 403) — skips to next model
 * - Network errors (ENOTFOUND, ECONNREFUSED)
 */

const { MODELS_PRIORITY, getModelCount } = require('./aiModels');
const { callOpenRouter, isRetryable, classifyError } = require('./openrouter');
const { fallbackParse } = require('./aiParser');
const logger = require('../logger');

// ── Configuration ──────────────────────────────────────────────
const MAX_RETRIES_PER_MODEL = 1;
const BASE_DELAY_MS = 2000;       // 2 seconds base delay
const MAX_DELAY_MS = 60000;       // 60 seconds max delay
const RATE_LIMIT_DELAY_MS = 15000; // 15 seconds for rate limits

/**
 * Parse real estate text with automatic model fallback
 *
 * @param {string} text - Raw real estate text
 * @param {number} imageCount - Number of images (for context)
 * @param {string} primaryModel - Override primary model (optional)
 * @returns {Promise<Object>} - Structured real estate data
 */
async function parseWithFallback(text, imageCount = 0, primaryModel = null) {
  const models = getModelsList(primaryModel);
  const errors = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const attempt = i + 1;

    try {
      logger.info('AI_FALLBACK', `Trying model ${attempt}/${models.length}`, { model });

      const result = await tryModel(model, text, imageCount);

      if (i > 0) {
        logger.info('AI_FALLBACK', `✅ Model ${model} succeeded after ${i} failures`);
      }

      return result;
    } catch (err) {
      const errorType = err.errorType || classifyError(err.error || err);
      const status = err.status || err.error?.response?.status;

      errors.push({ model, errorType, status });

      logger.warn('AI_FALLBACK', `Model ${model} failed`, {
        errorType,
        status,
        message: err.error?.message || err.message,
      });

      // Don't retry auth errors on the same model
      if (errorType === 'auth_error') {
        logger.error('AI_FALLBACK', `Auth error — check API key`);
        continue;
      }

      // If not retryable, skip to next model
      if (!isRetryable(errorType)) {
        logger.warn('AI_FALLBACK', `Non-retryable error — skipping to next model`);
        continue;
      }

      // If this was the last model, don't wait
      if (i < models.length - 1) {
        const delay = calculateDelay(errorType, i);
        logger.info('AI_FALLBACK', `Waiting ${Math.round(delay / 1000)}s before next model...`);
        await sleep(delay);
      }
    }
  }

  // All models failed — use regex fallback
  logger.warn('AI_FALLBACK', `❌ All ${models.length} models failed — using regex fallback parser`, {
    errors: errors.map(e => `${e.model}: ${e.errorType} (${e.status || 'no status'})`),
  });

  return fallbackParse(text, imageCount);
}

/**
 * Try a single model with retry
 */
async function tryModel(model, text, imageCount) {
  const { getSystemPrompt } = require('./realEstatePrompt');
  const { createUserPrompt } = require('./realEstatePrompt');

  const messages = [
    { role: 'system', content: getSystemPrompt() },
    { role: 'user', content: createUserPrompt(text, imageCount) },
  ];

  const { normalizeParsedData } = require('./aiParser');

  const rawResult = await callOpenRouter(model, messages, {
    expectJson: true,
  });

  return normalizeParsedData(rawResult);
}

/**
 * Calculate delay before next model attempt
 */
function calculateDelay(errorType, attemptIndex) {
  if (errorType === 'rate_limit') {
    return RATE_LIMIT_DELAY_MS;
  }

  // Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at 60s
  return Math.min(BASE_DELAY_MS * Math.pow(2, attemptIndex), MAX_DELAY_MS);
}

/**
 * Get ordered list of models to try
 */
function getModelsList(primaryModel = null) {
  if (primaryModel) {
    // Put primary model first, then the rest
    const rest = MODELS_PRIORITY.filter(m => m !== primaryModel);
    return [primaryModel, ...rest];
  }
  return [...MODELS_PRIORITY];
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  parseWithFallback,
  tryModel,
  getModelsList,
  calculateDelay,
};
