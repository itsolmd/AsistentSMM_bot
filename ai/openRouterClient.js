/**
 * ════════════════════════════════════════════════════════════════
 * ai/openRouterClient.js — Enhanced OpenRouter Client
 * ════════════════════════════════════════════════════════════════
 *
 * Wrapper avansat peste OpenRouter API cu:
 *   • Model fallback chain (automat, transparent)
 *   • Retry cu backoff exponențial
 *   • JSON mode (forțează răspuns JSON)
 *   • Clasificare erori (timeout, rate-limit, auth, server)
 *   • Statistici de utilizare per model
 *   • Cache inteligent pentru requesturi repetate
 *   • Timeout configurabil per operație
 *
 * Flow:
 *   askAI(prompt, options)
 *     → încearcă modelul preferat (env)
 *     → dacă eșuează, trece la următorul în chain
 *     → dacă TOATE eșuează, returnează fallback controlat
 *     → NU aruncă NICIODATĂ eroare necontrolată
 * ════════════════════════════════════════════════════════════════ */

const axios = require('axios');
const { buildModelChain, getNextModel, getFirstModel, isFreeModel } = require('./models');
const logger = require('../logger');

// ── Configuration ──────────────────────────────────────────────
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const MAX_RETRIES_PER_MODEL = 2;       // Încercări per model
const REQUEST_TIMEOUT_MS = 20000;       // Timeout default
const CACHE_TTL_MS = 60 * 1000;         // Cache valabil 1 minut

// ── Error Types ───────────────────────────────────────────────
const ERROR_TYPES = {
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth_error',
  SERVER: 'server_error',
  NETWORK: 'network_error',
  PARSE: 'parse_error',
  EMPTY: 'empty_response',
  MODELS_EXHAUSTED: 'all_models_exhausted',
  UNKNOWN: 'unknown_error',
};

// ── Simple in-memory cache ────────────────────────────────────
const responseCache = new Map();

/**
 * Generate a cache key from prompt + options
 */
function getCacheKey(prompt, options = {}) {
  const { model = 'default', temperature = 0.1, maxTokens = 500 } = options;
  const normalized = prompt.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${model}|${temperature}|${maxTokens}|${normalized}`;
}

/**
 * Classify an error from the API response
 */
function classifyError(error) {
  if (!error) return ERROR_TYPES.UNKNOWN;

  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    return ERROR_TYPES.TIMEOUT;
  }

  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ERR_NETWORK'].includes(error.code)) {
    return ERROR_TYPES.NETWORK;
  }

  const status = error.response?.status || error.status;
  if (status === 429) return ERROR_TYPES.RATE_LIMIT;
  if (status === 401 || status === 403) return ERROR_TYPES.AUTH;
  if (status >= 500 && status < 600) return ERROR_TYPES.SERVER;

  if (error.message?.includes('Unexpected token') || error.message?.includes('JSON')) {
    return ERROR_TYPES.PARSE;
  }

  return ERROR_TYPES.UNKNOWN;
}

/**
 * Try a single model call
 */
async function tryModel(modelConfig, messages, options = {}) {
  const { expectJson = true, temperature = 0.1, maxTokens = 1000 } = options;
  const apiKey = process.env['OpenRouter-API-Key'] || process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    const err = new Error('OpenRouter API key not configured');
    err.errorType = ERROR_TYPES.AUTH;
    throw err;
  }

  const timeout = modelConfig.timeout || REQUEST_TIMEOUT_MS;
  const modelId = modelConfig.id;

  for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
    try {
      logger.debug('OPENROUTER', `📡 Calling ${modelId} (attempt ${attempt}/${MAX_RETRIES_PER_MODEL})`);

      const response = await axios.post(
        `${OPENROUTER_BASE}/chat/completions`,
        {
          model: modelId,
          messages,
          temperature,
          max_tokens: maxTokens,
          ...(expectJson ? { response_format: { type: 'json_object' } } : {}),
        },
        {
          timeout,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/AsistentSMM',
            'X-Title': 'AsistentSMM-AI',
          },
        }
      );

      const content = response.data?.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        const err = new Error('Empty response from model');
        err.errorType = ERROR_TYPES.EMPTY;
        throw err;
      }

      // Log successful usage
      const usage = response.data?.usage;
      if (usage) {
        logger.info('OPENROUTER', `✅ ${modelId} OK`, {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          attempt,
        });
      }

      if (expectJson) {
        try {
          return JSON.parse(content);
        } catch (parseErr) {
          // Try to extract JSON from markdown code blocks
          const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
          if (jsonMatch) {
            try {
              return JSON.parse(jsonMatch[1]);
            } catch (_) { /* fall through */ }
          }
          // Try to find JSON object in text
          const objMatch = content.match(/\{[\s\S]*\}/);
          if (objMatch) {
            try {
              return JSON.parse(objMatch[0]);
            } catch (_) { /* fall through */ }
          }
          const parseErr2 = new Error(`JSON parse error: ${content.slice(0, 200)}`);
          parseErr2.errorType = ERROR_TYPES.PARSE;
          parseErr2.rawContent = content;
          throw parseErr2;
        }
      }

      return content;
    } catch (err) {
      // Attach error type if not already set
      if (!err.errorType) {
        err.errorType = classifyError(err);
      }

      // Auth errors are non-retryable
      if (err.errorType === ERROR_TYPES.AUTH) {
        throw err;
      }

      // On last attempt for this model, propagate
      if (attempt >= MAX_RETRIES_PER_MODEL) {
        throw err;
      }

      // Retry with backoff
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
      logger.warn('OPENROUTER', `🔄 Retry ${attempt}/${MAX_RETRIES_PER_MODEL} for ${modelId} after ${delay}ms`, {
        errorType: err.errorType,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * askAI — Main entry point
 *
 * Încearcă model după model din chain până când unul răspunde.
 * Dacă toate eșuează, returnează un fallback controlat (NU aruncă eroare).
 *
 * @param {string} systemPrompt - System message
 * @param {string} userPrompt   - User message
 * @param {Object} options
 * @param {boolean} options.expectJson - Parse response as JSON (default: true)
 * @param {number} options.temperature - Model temperature (default: 0.1)
 * @param {number} options.maxTokens - Max tokens in response (default: 1000)
 * @param {boolean} options.useCache - Enable response caching (default: false)
 * @param {string} options.forceModel - Force a specific model ID
 * @returns {Promise<Object|string>} Parsed JSON or raw text
 */
async function askAI(systemPrompt, userPrompt, options = {}) {
  const {
    expectJson = true,
    temperature = 0.1,
    maxTokens = 1000,
    useCache = false,
    forceModel = null,
  } = options;

  // Build messages array
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  // Check cache
  if (useCache) {
    const cacheKey = getCacheKey(systemPrompt + '||' + userPrompt, { model: forceModel, temperature, maxTokens });
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
      logger.debug('OPENROUTER', '📦 Cache HIT for', cacheKey.slice(0, 60));
      return cached.data;
    }
  }

  // Build model chain
  let chain;
  if (forceModel) {
    chain = [{ id: forceModel, timeout: REQUEST_TIMEOUT_MS, tier: 'forced', desc: `Forced: ${forceModel}` }];
  } else {
    chain = buildModelChain();
  }

  // Try each model in chain
  let lastError = null;
  for (let i = 0; i < chain.length; i++) {
    const modelConfig = chain[i];
    try {
      logger.info('OPENROUTER', `🎯 Trying model ${i + 1}/${chain.length}: ${modelConfig.id} (${modelConfig.tier})`);

      const result = await tryModel(modelConfig, messages, {
        expectJson,
        temperature,
        maxTokens,
      });

      // ── Cache successful response ──
      if (useCache) {
        const cacheKey = getCacheKey(systemPrompt + '||' + userPrompt, { model: modelConfig.id, temperature, maxTokens });
        responseCache.set(cacheKey, { data: result, timestamp: Date.now() });
        // Clean old cache entries
        for (const [key, val] of responseCache) {
          if (Date.now() - val.timestamp > CACHE_TTL_MS * 2) {
            responseCache.delete(key);
          }
        }
      }

      logger.info('OPENROUTER', `✅ SUCCESS with ${modelConfig.id} (${modelConfig.tier})`);
      return result;
    } catch (err) {
      lastError = err;
      const errorType = err.errorType || classifyError(err);
      logger.warn('OPENROUTER', `❌ ${modelConfig.id} FAILED: ${errorType} — ${err.message?.slice(0, 100)}`);

      // Dacă e eroare de autentificare, nu mai încercăm alte modele
      if (errorType === ERROR_TYPES.AUTH) {
        logger.error('OPENROUTER', '🔴 Auth error — stopping model chain');
        break;
      }

      // Continuă cu următorul model
      logger.info('OPENROUTER', `➡️ Falling back to next model...`);
    }
  }

  // ── ALL models exhausted — return controlled fallback ──
  logger.error('OPENROUTER', '🔴 ALL MODELS EXHAUSTED — returning fallback', {
    lastError: lastError?.message?.slice(0, 200),
    modelsTried: chain.length,
  });

  if (expectJson) {
    return { error: true, message: 'AI models exhausted', fallback: true };
  }

  return '[AI UNAVAILABLE - All models exhausted]';
}

/**
 * extractJsonFromAI — Extract JSON from AI response with multiple fallbacks
 *
 * @param {Object|string} response - Raw AI response
 * @returns {Object|null} Parsed JSON or null
 */
function extractJsonFromAI(response) {
  if (!response) return null;

  // If already an object, return as-is
  if (typeof response === 'object' && !Array.isArray(response)) {
    return response;
  }

  // If string, try to parse
  if (typeof response === 'string') {
    try {
      return JSON.parse(response);
    } catch (_) { /* continue */ }

    // Try markdown code blocks
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (_) { /* continue */ }
    }

    // Try to find any JSON object
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch (_) { /* continue */ }
    }
  }

  return null;
}

/**
 * askAIWithRetry — Ask AI with guaranteed return (never throws)
 *
 * Wrapper care garantează că askAI returnează întotdeauna ceva valid.
 * Dacă AI e complet indisponibil, returnează un obiect gol sau text gol.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {Object} options
 * @returns {Promise<Object|string>}
 */
async function askAIWithRetry(systemPrompt, userPrompt, options = {}) {
  try {
    const result = await askAI(systemPrompt, userPrompt, options);
    return result;
  } catch (err) {
    logger.error('OPENROUTER', '🔴 askAIWithRetry caught unexpected error', {
      error: err.message,
    });
    if (options.expectJson !== false) {
      return {};
    }
    return '';
  }
}

module.exports = {
  askAI,
  askAIWithRetry,
  extractJsonFromAI,
  classifyError,
  ERROR_TYPES,
};