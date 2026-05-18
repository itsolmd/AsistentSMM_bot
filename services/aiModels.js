/**
 * ════════════════════════════════════════════════════════════════
 * AI MODELS — OpenRouter model priority list
 * ════════════════════════════════════════════════════════════════
 *
 * Ordered by priority. The system tries each model in sequence
 * until one succeeds (handles timeout, rate limit, 500 error).
 *
 * All models are FREE tier — no billing required.
 */

const MODELS_PRIORITY = [
  "deepseek/deepseek-v4-flash:free",
  "qwen/qwen3-coder:free",
  "openai/gpt-oss-120b:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nousresearch/hermes-3-405b:free",
  "z-ai/glm-4.5-air:free",
  "google/gemma-4-31b:free",
  "minimax/minimax-m2.5:free",
  "nvidia/nemotron-3-super:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-20b:free",
];

/**
 * Get model by index, with wraparound safety
 */
function getModel(index) {
  return MODELS_PRIORITY[index % MODELS_PRIORITY.length];
}

/**
 * Get total number of models
 */
function getModelCount() {
  return MODELS_PRIORITY.length;
}

/**
 * Get all models as array
 */
function getAllModels() {
  return [...MODELS_PRIORITY];
}

module.exports = {
  MODELS_PRIORITY,
  getModel,
  getModelCount,
  getAllModels,
};
