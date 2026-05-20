/**
 * ════════════════════════════════════════════════════════════════
 * ai/models.js — AI Model Configuration & Fallback Chain
 * ════════════════════════════════════════════════════════════════
 *
 * Definește modelele AI disponibile pentru OpenRouter, ordinea
 * de fallback, și timeout-urile specifice fiecărui model.
 * Sistemul încearcă întotdeauna modelul preferat, iar dacă
 * acesta eșuează, trece automat la următorul din chain.
 *
 * Flow:
 *   preferredModel → fallback[0] → fallback[1] → ... → last resort
 *
 * Dacă TOATE modelele eșuează, sistemul returnează o eroare
 * controlată (NU crapă).
 *
 * Modele disponibile (OpenRouter):
 *   - google/gemini-2.0-flash-exp:free   (gratuit, rapid)
 *   - openai/gpt-4o-mini:free              (gratuit, bun)
 *   - openai/gpt-4o                         (plătit, excelent)
 *   - anthropic/claude-3.5-haiku           (plătit, rapid)
 *   - anthropic/claude-3.5-sonnet          (plătit, cel mai bun)
 *   - meta-llama/llama-3.2-3b-instruct:free (gratuit, ultra-rapid)
 * ════════════════════════════════════════════════════════════════ */

/**
 * Lanțul de fallback pentru modele AI.
 * Fiecare model are: id, timeout, și o descriere
 *
 * ORDINEA:
 *   1. Modelul configurat în env (OPENROUTER_MODEL)
 *   2. Fallback-uri gratuite (încercate în ordine)
 *   3. Fallback-uri plătite (ultima soluție)
 *   4. Model de ultimă instanță (garantează că există mereu ceva)
 */
const MODEL_CHAIN = [
  // ── 0. Modelul preferat (din env) ──
  // Se adaugă dinamic la runtime

  // ── 1. Free models (rapide, bun raport calitate-viteză) ──
  { id: 'google/gemini-2.0-flash-exp:free', timeout: 15000, tier: 'free', desc: 'Gemini Flash (free)' },

  // ── 2. Open-source free ──
  { id: 'meta-llama/llama-3.2-3b-instruct:free', timeout: 10000, tier: 'free', desc: 'Llama 3.2 3B (free)' },

  // ── 3. GPT-4o-mini free (dacă este disponibil) ──
  { id: 'openai/gpt-4o-mini:free', timeout: 20000, tier: 'free', desc: 'GPT-4o-mini (free)' },

  // ── 4. Paid models (când free-urile eșuează) ──
  { id: 'openai/gpt-4o-mini', timeout: 15000, tier: 'paid', desc: 'GPT-4o-mini (paid)' },

  // ── 5. Alternative paid ──
  { id: 'anthropic/claude-3.5-haiku', timeout: 20000, tier: 'paid', desc: 'Claude 3.5 Haiku' },

  // ── 6. Ultra-rezervă (aproape sigur funcționează) ──
  { id: 'openai/gpt-4o', timeout: 30000, tier: 'paid', desc: 'GPT-4o (full)' },

  // ── 7. Ultimă instanță (garantat disponibil) ──
  { id: 'google/gemini-2.0-flash-exp:free', timeout: 30000, tier: 'free', desc: 'Gemini Flash (last resort)' },
];

/**
 * Build the effective model chain at runtime.
 * Inserts the configured env model at position 0 if set.
 *
 * @returns {Array} Array of model config objects
 */
function buildModelChain() {
  const envModel = process.env.OPENROUTER_MODEL || '';
  const chain = [];

  // 1. Add env-configured model first (if set and not already in chain)
  if (envModel) {
    const existing = MODEL_CHAIN.find(m => m.id === envModel);
    if (existing) {
      chain.push({ ...existing }); // Clone to avoid mutation
    } else {
      chain.push({
        id: envModel,
        timeout: 20000,
        tier: 'configured',
        desc: `Configured: ${envModel}`,
      });
    }
  }

  // 2. Add the rest of the chain (skip duplicates)
  for (const model of MODEL_CHAIN) {
    if (!chain.find(m => m.id === model.id)) {
      chain.push({ ...model });
    }
  }

  return chain;
}

/**
 * Get the next model in chain after a given model ID.
 * Used for fallback: if model X fails, try model X+1.
 *
 * @param {string} currentModelId - The model that just failed
 * @returns {Object|null} Next model config or null if at end
 */
function getNextModel(currentModelId) {
  const chain = buildModelChain();
  const currentIndex = chain.findIndex(m => m.id === currentModelId);
  if (currentIndex === -1 || currentIndex >= chain.length - 1) {
    return null; // No more fallbacks
  }
  return chain[currentIndex + 1];
}

/**
 * Get the first model in the chain.
 *
 * @returns {Object} First model config
 */
function getFirstModel() {
  const chain = buildModelChain();
  return chain[0] || MODEL_CHAIN[0];
}

/**
 * Check if a model is free (no cost).
 *
 * @param {string} modelId
 * @returns {boolean}
 */
function isFreeModel(modelId) {
  const chain = buildModelChain();
  const model = chain.find(m => m.id === modelId);
  return model ? model.tier === 'free' : modelId.includes(':free');
}

module.exports = {
  buildModelChain,
  getNextModel,
  getFirstModel,
  isFreeModel,
  MODEL_CHAIN,
};