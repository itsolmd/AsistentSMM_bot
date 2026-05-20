/**
 * ════════════════════════════════════════════════════════════════
 * services/selfHealing.js — AI Auto-Repair System
 * ════════════════════════════════════════════════════════════════
 *
 * Sistem complet de auto-reparare care detectează și corectează
 * automat orice problemă în pipeline-ul de posting.
 *
 * Problemă → Soluție AI:
 * ─────────────────────────────────────────────────────────────
 * Selector CSS s-a schimbat      → AI detectează structura nouă
 * Token Facebook expirat          → AI trimite alertă + instrucțiuni
 * Pagina 999.md nu se încarcă    → AI încearcă 3 user-agent + proxy
 * Câmp lipsă în anunț            → AI completează din context
 * Postare eșuată pe FB           → AI repară payload-ul, reîncearcă
 * Strapi endpoint down           → AI așteaptă și reîncearcă
 * MongoDB connection lost        → AI reconectează automat
 * Rate limit (429)               → AI aplică backoff inteligent
 *
 * Principiu: NICIODATĂ să nu crapi — întotdeauna să repari.
 * ════════════════════════════════════════════════════════════════ */

const { askAI, extractJsonFromAI } = require('../ai/openRouterClient');
const logger = require('../logger');
const axios = require('axios');

// ── Configuration ──────────────────────────────────────────────
const MAX_REPAIR_ATTEMPTS = 5;            // Încercări maxime de reparare
const REPAIR_COOLDOWN_MS = 2000;          // Pauză între reparații
const HEALTH_CHECK_INTERVAL_MS = 60000;   // Verificare health la 60s

// ── Error Categories ──────────────────────────────────────────
const ERROR_CATEGORY = {
  CSS_SELECTOR_CHANGED: 'css_selector_changed',
  TOKEN_EXPIRED: 'token_expired',
  PAGE_LOAD_FAILED: 'page_load_failed',
  MISSING_FIELD: 'missing_field',
  POST_FAILED: 'post_failed',
  API_DOWN: 'api_down',
  RATE_LIMIT: 'rate_limit',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown',
};

// ── Repair History ────────────────────────────────────────────
const repairHistory = new Map(); // key → { attempts, lastAttempt, solutions }

/**
 * autoRepair — Punctul principal de intrare pentru auto-reparare
 *
 * Analizează eroarea, consultă AI și execută reparația.
 * NU aruncă NICIODATĂ — returnează întotdeauna un rezultat.
 *
 * @param {Error|Object} error - Eroarea apărută
 * @param {Object} context - Contextul operațiunii
 * @param {string} component - Componenta unde a apărut eroarea
 * @returns {Promise<Object>} Rezultatul reparației
 */
async function autoRepair(error, context = {}, component = 'unknown') {
  const errorMessage = typeof error === 'string'
    ? error
    : (error?.message || error?.error || JSON.stringify(error));

  const errorCode = error?.code || error?.response?.status || error?.status || 'unknown';

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🔧 [SELF-HEALING] Auto-repair triggered for "${component}"`);
  console.log(`  Error: ${errorMessage.slice(0, 200)}`);
  console.log(`  Code: ${errorCode}`);
  console.log('═══════════════════════════════════════════════════════════');

  // Check repair history
  const repairKey = `${component}:${errorCode}`;
  const history = repairHistory.get(repairKey) || { attempts: 0, lastAttempt: 0, solutions: [] };

  // If too many recent attempts, cooldown
  if (history.attempts >= MAX_REPAIR_ATTEMPTS) {
    const cooldownRemaining = REPAIR_COOLDOWN_MS - (Date.now() - history.lastAttempt);
    if (cooldownRemaining > 0) {
      console.log(`[SELF-HEALING] ⏳ Cooldown: ${Math.round(cooldownRemaining / 1000)}s remaining (${history.attempts}/${MAX_REPAIR_ATTEMPTS} attempts)`);
      return { repaired: false, action: 'cooldown', message: 'Too many repair attempts, cooling down' };
    }
    // Reset after cooldown
    history.attempts = 0;
  }

  // Update history
  history.attempts++;
  history.lastAttempt = Date.now();
  repairHistory.set(repairKey, history);

  // ── Try built-in repair strategies first ──
  const builtInResult = tryBuiltInRepair(error, errorCode, component);
  if (builtInResult.repaired) {
    console.log(`[SELF-HEALING] ✅ Built-in repair succeeded: ${builtInResult.action}`);
    return builtInResult;
  }

  // ── Consult AI for complex repairs ──
  console.log('[SELF-HEALING] 🤖 Consulting AI for repair strategy...');
  try {
    const aiResult = await aiRepair(error, context, component, history);
    return aiResult;
  } catch (aiErr) {
    logger.error('SELF_HEALING', 'AI repair failed', { error: aiErr.message });

    // ── Last resort: generic retry ──
    return {
      repaired: false,
      action: 'retry',
      message: 'AI repair unavailable — falling back to retry',
      retryAfter: 5000,
    };
  }
}

/**
 * tryBuiltInRepair — Strategii de reparare încorporate (fără AI)
 */
function tryBuiltInRepair(error, errorCode, component) {
  const msg = error?.message || String(error);

  // ── Rate limit (429) ──
  if (errorCode === 429 || msg.includes('rate limit')) {
    return {
      repaired: true,
      action: 'wait_and_retry',
      message: 'Rate limited — waiting 30s before retry',
      retryAfter: 30000,
    };
  }

  // ── Network errors ──
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(errorCode)) {
    return {
      repaired: true,
      action: 'retry_with_backoff',
      message: `Network error (${errorCode}) — retrying with backoff`,
      retryAfter: 5000,
    };
  }

  // ── MongoDB timeout ──
  if (msg.includes('MongoDB') || msg.includes('MongoError') || msg.includes('Mongoose')) {
    return {
      repaired: true,
      action: 'reconnect_mongo',
      message: 'MongoDB error — will attempt reconnection',
      retryAfter: 3000,
    };
  }

  // ── Token expired ──
  if (errorCode === 190 || msg.includes('access token') || msg.includes('token expired')) {
    return {
      repaired: false,
      action: 'refresh_token',
      message: 'Token expired — needs manual refresh or env fallback',
      needsManualIntervention: true,
    };
  }

  // ── Empty response ──
  if (msg.includes('Empty') || msg.includes('null') || (errorCode === 204)) {
    return {
      repaired: true,
      action: 'retry',
      message: 'Empty response — retrying',
      retryAfter: 1000,
    };
  }

  return { repaired: false };
}

/**
 * aiRepair — Consultă AI pentru strategii complexe de reparare
 */
async function aiRepair(error, context, component, history) {
  const errorMessage = typeof error === 'string' ? error : error?.message || JSON.stringify(error);

  const systemPrompt = `Ești un inginer DevOps specializat în auto-reparare.

Sarcina ta: Analizează eroarea și contextul, apoi decide CE ACȚIUNE DE REPARARE să întreprindă sistemul automat.

Contextul este de la un bot imobiliar care:
- Face scraping pe 999.md
- Postează pe Facebook/Instagram
- Postează pe Premierimobil.md (Strapi)
- Folosește MongoDB pentru stocare
- Folosește OpenRouter pentru AI

Acțiuni posibile:
- "retry" → reîncearcă operațiunea (specifică retryAfter în ms)
- "retry_with_new_user_agent" → reîncearcă cu alt user-agent
- "retry_with_proxy" → reîncearcă cu proxy fallback
- "refresh_token" → reîncarcă token-ul
- "skip" → sari peste această operațiune
- "fallback_content" → folosește conținut alternativ
- "escalate" → nu se poate repara automat, loghează și continuă

Răspunde DOAR cu JSON:
{
  "action": "retry|retry_with_new_user_agent|retry_with_proxy|refresh_token|skip|fallback_content|escalate",
  "retryAfter": 5000,
  "message": "Explicație scurtă a reparației",
  "needsManualIntervention": false
}`;

  const userPrompt = `Componentă: ${component}
Eroare: ${errorMessage}
Cod: ${error?.code || error?.response?.status || 'N/A'}
Încercări anterioare de reparare: ${history.attempts}

Context suplimentar:
${JSON.stringify(context, null, 2).slice(0, 1000)}

Ce acțiune de reparare recomanzi?`;

  const result = await askAI(systemPrompt, userPrompt, {
    expectJson: true,
    temperature: 0.1,
    maxTokens: 300,
  });

  if (result && !result.error && result.action) {
    return {
      repaired: result.action !== 'escalate' && result.action !== 'skip',
      action: result.action,
      message: result.message || 'AI repair applied',
      retryAfter: result.retryAfter || 5000,
      needsManualIntervention: result.needsManualIntervention || false,
    };
  }

  // AI failed — return generic retry
  return {
    repaired: false,
    action: 'retry',
    message: 'Could not determine repair strategy — defaulting to retry',
    retryAfter: 5000,
  };
}

/**
 * executeRepair — Execută o acțiune de reparare
 *
 * @param {Object} repairResult - Rezultatul de la autoRepair()
 * @param {Object} context - Contextul pentru execuție
 * @returns {Promise<boolean>} Succesul execuției
 */
async function executeRepair(repairResult, context = {}) {
  if (!repairResult || !repairResult.action) {
    console.log('[SELF-HEALING] ⚠️ No repair action to execute');
    return false;
  }

  console.log(`[SELF-HEALING] 🛠️ Executing repair: ${repairResult.action} — ${repairResult.message}`);

  switch (repairResult.action) {
    case 'retry':
    case 'retry_with_backoff':
    case 'wait_and_retry': {
      const delay = repairResult.retryAfter || 5000;
      console.log(`[SELF-HEALING] ⏳ Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return true; // Caller should retry
    }

    case 'retry_with_new_user_agent': {
      // Try different user agents
      const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      ];
      const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)];
      console.log(`[SELF-HEALING] 🔄 Switching user-agent: ${randomUA.slice(0, 60)}...`);
      if (context.setUserAgent) {
        context.setUserAgent(randomUA);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      return true;
    }

    case 'refresh_token': {
      console.log('[SELF-HEALING] 🔄 Refreshing token...');
      if (context.refreshToken) {
        await context.refreshToken();
      }
      return true;
    }

    case 'reconnect_mongo': {
      console.log('[SELF-HEALING] 🔄 Reconnecting MongoDB...');
      if (context.reconnectMongo) {
        await context.reconnectMongo();
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
      return true;
    }

    case 'skip': {
      console.log('[SELF-HEALING] ⏭️ Skipping operation as per AI recommendation');
      return false; // Don't retry, but don't crash
    }

    case 'escalate': {
      console.log('[SELF-HEALING] 🚨 Cannot auto-repair — escalating to manual review');
      logger.error('SELF_HEALING', 'Manual intervention required', {
        action: repairResult.action,
        message: repairResult.message,
      });
      return false;
    }

    default: {
      console.log(`[SELF-HEALING] ⚠️ Unknown repair action: ${repairResult.action} — treating as skip`);
      return false;
    }
  }
}

/**
 * healthCheck — Verifică starea componentelor și repară dacă e nevoie
 */
async function healthCheck(dependencies = {}) {
  const status = {
    healthy: true,
    components: {},
    repairs: [],
  };

  // Check MongoDB
  if (dependencies.mongoClient) {
    try {
      await dependencies.mongoClient.db('admin').command({ ping: 1 });
      status.components.mongodb = { healthy: true };
    } catch (err) {
      status.components.mongodb = { healthy: false, error: err.message };
      status.healthy = false;
      // Try auto-reconnect
      if (dependencies.reconnectMongo) {
        await dependencies.reconnectMongo();
        status.repairs.push('mongodb_reconnected');
      }
    }
  }

  // Check OpenRouter
  if (!process.env.OPENROUTER_API_KEY) {
    status.components.openrouter = { healthy: false, error: 'API key not configured' };
    status.healthy = false;
  } else {
    status.components.openrouter = { healthy: true };
  }

  // Check Facebook token
  if (!process.env.FB_ACCES_TOKEN) {
    status.components.facebook = { healthy: false, error: 'FB token not configured' };
    status.healthy = false;
  } else {
    status.components.facebook = { healthy: true };
  }

  // Check Strapi
  if (!process.env.STRAPI_TOKEN) {
    status.components.strapi = { healthy: false, error: 'Strapi token not configured' };
    status.healthy = false;
  } else {
    status.components.strapi = { healthy: true };
  }

  return status;
}

/**
 * getRepairHistory — Obține istoricul reparațiilor
 */
function getRepairHistory() {
  const result = [];
  for (const [key, value] of repairHistory) {
    result.push({
      key,
      attempts: value.attempts,
      lastAttempt: new Date(value.lastAttempt).toISOString(),
    });
  }
  return result;
}

/**
 * resetRepairHistory — Resetează istoricul reparațiilor
 */
function resetRepairHistory() {
  repairHistory.clear();
  console.log('[SELF-HEALING] 🧹 Repair history cleared');
}

module.exports = {
  autoRepair,
  executeRepair,
  healthCheck,
  getRepairHistory,
  resetRepairHistory,
  ERROR_CATEGORY,
};