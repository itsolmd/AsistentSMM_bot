/**
 * ════════════════════════════════════════════════════════════════
 * OPENROUTER — AI API client with retry and error classification
 * ════════════════════════════════════════════════════════════════
 *
 * Handles communication with OpenRouter's API for real estate data
 * extraction. Supports JSON mode, timeout, and error classification
 * for the fallback system.
 */

const axios = require('axios');
const logger = require('../logger');

// ── Configuration ──────────────────────────────────────────────
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const REQUEST_TIMEOUT_MS = 30000;       // 30 seconds
const MAX_RETRIES = 2;

/**
 * Error types used by the fallback system
 */
const ERROR_TYPES = {
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth_error',
  SERVER: 'server_error',
  NETWORK: 'network_error',
  PARSE: 'parse_error',
  UNKNOWN: 'unknown_error',
};

/**
 * Classify an error from OpenRouter API
 *
 * @param {Error} error - The error object from axios or general Error
 * @returns {string} One of ERROR_TYPES values
 */
function classifyError(error) {
  if (!error) return ERROR_TYPES.UNKNOWN;

  // Axios timeout
  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return ERROR_TYPES.TIMEOUT;
  }

  // Network errors
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNRESET' || error.code === 'ERR_NETWORK') {
    return ERROR_TYPES.NETWORK;
  }

  // HTTP status-based classification
  const status = error.response?.status || error.status;
  if (status === 429) return ERROR_TYPES.RATE_LIMIT;
  if (status === 401 || status === 403) return ERROR_TYPES.AUTH;
  if (status >= 500 && status < 600) return ERROR_TYPES.SERVER;

  // JSON parse error
  if (error.message?.includes('Unexpected token') ||
      error.message?.includes('JSON')) {
    return ERROR_TYPES.PARSE;
  }

  return ERROR_TYPES.UNKNOWN;
}

/**
 * Check if an error type is retryable (can switch to next model)
 *
 * @param {string} errorType - One of ERROR_TYPES values
 * @returns {boolean}
 */
function isRetryable(errorType) {
  switch (errorType) {
    case ERROR_TYPES.TIMEOUT:
    case ERROR_TYPES.RATE_LIMIT:
    case ERROR_TYPES.SERVER:
    case ERROR_TYPES.NETWORK:
    case ERROR_TYPES.PARSE:
      return true;
    case ERROR_TYPES.AUTH:
    case ERROR_TYPES.UNKNOWN:
      return false;
    default:
      return false;
  }
}

/**
 * Call OpenRouter API with a given model and messages
 *
 * @param {string} model - Model identifier (e.g., "openai/gpt-4o:free")
 * @param {Array} messages - Array of { role, content } objects
 * @param {Object} options
 * @param {boolean} options.expectJson - If true, parses response as JSON
 * @param {number} options.timeout - Custom timeout in ms
 * @returns {Promise<Object|string>} Parsed JSON object or raw text
 */
async function callOpenRouter(model, messages, options = {}) {
  const { expectJson = true, timeout = REQUEST_TIMEOUT_MS } = options;

  const apiKey = process.env['OpenRouter-API-Key'] || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const err = new Error('OpenRouter API key not configured');
    err.errorType = ERROR_TYPES.AUTH;
    throw err;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug('OPENROUTER', `Calling ${model} (attempt ${attempt}/${MAX_RETRIES})`);

      const response = await axios.post(
        `${OPENROUTER_BASE}/chat/completions`,
        {
          model,
          messages,
          ...(expectJson ? {
            response_format: { type: 'json_object' },
          } : {}),
        },
        {
          timeout,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/your-repo',
            'X-Title': 'AsistentSMM',
          },
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from OpenRouter');
      }

      if (expectJson) {
        try {
          return JSON.parse(content);
        } catch (parseErr) {
          parseErr.errorType = ERROR_TYPES.PARSE;
          throw parseErr;
        }
      }

      return content;
    } catch (err) {
      lastError = err;
      const errorType = classifyError(err);

      // Don't retry auth errors
      if (errorType === ERROR_TYPES.AUTH) {
        err.errorType = errorType;
        throw err;
      }

      // Don't retry non-retryable errors on last attempt
      if (attempt < MAX_RETRIES && isRetryable(errorType)) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        logger.warn('OPENROUTER', `Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`, {
          errorType,
          model,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Attach error type and throw
      err.errorType = err.errorType || errorType || ERROR_TYPES.UNKNOWN;
      throw err;
    }
  }

  // Should not reach here, but just in case
  const fallbackErr = lastError || new Error('Unexpected error in callOpenRouter');
  fallbackErr.errorType = fallbackErr.errorType || ERROR_TYPES.UNKNOWN;
  throw fallbackErr;
}

module.exports = {
  callOpenRouter,
  isRetryable,
  classifyError,
  ERROR_TYPES,
};
