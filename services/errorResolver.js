/**
 * services/errorResolver.js
 *
 * AI-POWERED ERROR RESOLUTION SYSTEM
 *
 * When an unknown/unrecognized error occurs during posting, this service:
 * 1. Collects full context (error, data, timestamp, platform)
 * 2. Sends to AI (OpenRouter) for resolution instructions
 * 3. Returns executable steps for the system to follow
 * 4. If AI can't solve it, logs to "unknown_errors.log" and continues
 *
 * NEVER blocks or stops the process — always returns a decision.
 */

const fs = require("fs");
const path = require("path");
const { callOpenRouter } = require("./openrouter");
const logger = require("../logger");

// ── Configuration ──────────────────────────────────────────────
const UNKNOWN_ERRORS_LOG = path.join(__dirname, "..", "unknown_errors.log");
const AI_TIMEOUT_MS = 15000; // 15 seconds max for AI to respond

/**
 * askAIWhatToDo(error, context, platform)
 *
 * Sends the error context to an AI model and gets back executable instructions.
 * The AI acts as a "problems resolver" for posting issues.
 *
 * @param {Error|Object|string} error - The error that occurred
 * @param {Object} context - Context data (content being posted, session info, etc.)
 * @param {string} platform - The platform where the error occurred (e.g. "facebook", "999.md")
 * @returns {Promise<Object>} - Decision object with action and suggestion
 */
async function askAIWhatToDo(error, context = {}, platform = "unknown") {
  const errorMessage = typeof error === "string"
    ? error
    : (error?.message || error?.error || JSON.stringify(error));

  const errorCode = error?.code || error?.response?.status || error?.status || "unknown";

  try {
    logger.info("ERROR_RESOLVER", "🤖 Asking AI to resolve error", {
      platform,
      errorCode,
      errorMessage: errorMessage.slice(0, 200),
    });

    const systemPrompt = `Ești un asistent care rezolvă probleme de posting pe platforme sociale.
Utilizatorul a întâlnit o eroare la postare.

Sarcina ta: Analizează eroarea și contextul, apoi decide CE TREBUIE SĂ FACĂ SISTEMUL AUTOMAT.

Răspunde DOAR cu JSON, fără text adițional:
{
  "action": "retry|refresh_token|wait|skip|fallback_token|escalate",
  "delay_seconds": 0,
  "retry_count": 3,
  "suggestion": "Scurtă explicație a ce trebuie făcut"
}

Acțiuni posibile:
- "retry" → reîncearcă operațiunea (specifică delay_seconds)
- "refresh_token" → re-autentifică utilizatorul/platforma
- "wait" → așteaptă delay_seconds și reîncearcă
- "skip" → sari peste această postare, treci la următoarea
- "fallback_token" → folosește token-ul de rezervă din env
- "escalate" → nu se poate rezolva automat, loghează și continuă`;

    const userPrompt = `Am întâlnit următoarea eroare:

Platformă: ${platform}
Cod eroare: ${errorCode}
Mesaj eroare: ${errorMessage}

Context suplimentar:
${JSON.stringify(context, null, 2).slice(0, 1000)}

Ce trebuie să fac sistemul automat pentru a rezolva această problemă?
Răspunde DOAR cu JSON-ul specificat.`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const result = await callOpenRouter(
      process.env.AI_ERROR_RESOLVER_MODEL || "openai/gpt-4o-mini:free",
      messages,
      { expectJson: true, timeout: AI_TIMEOUT_MS }
    );

    // Validate the AI response has the required fields
    if (!result || !result.action) {
      throw new Error("AI returned incomplete response: " + JSON.stringify(result));
    }

    logger.info("ERROR_RESOLVER", "✅ AI resolved error", {
      action: result.action,
      suggestion: (result.suggestion || "").slice(0, 100),
    });

    return {
      action: result.action,
      delay_seconds: result.delay_seconds || 0,
      retry_count: result.retry_count || 3,
      suggestion: result.suggestion || "No suggestion provided",
    };
  } catch (aiErr) {
    // AI failed — log to unknown_errors.log and continue
    logger.error("ERROR_RESOLVER", "❌ AI error resolution failed", {
      error: aiErr.message,
    });

    // Log the original error to unknown_errors.log
    logUnknownError({
      originalError: errorMessage,
      originalCode: errorCode,
      platform,
      context: JSON.stringify(context).slice(0, 500),
      aiError: aiErr.message,
      timestamp: new Date().toISOString(),
    });

    // Return a safe default: skip and continue
    return {
      action: "skip",
      delay_seconds: 0,
      retry_count: 0,
      suggestion: "AI could not resolve. Skipping and continuing. Error logged.",
    };
  }
}

/**
 * logUnknownError(errorInfo)
 *
 * Logs an unknown/unresolvable error to unknown_errors.log file.
 * This file can be reviewed later by an administrator.
 *
 * @param {Object} errorInfo - Information about the error
 */
function logUnknownError(errorInfo) {
  try {
    const logLine = [
      `[${errorInfo.timestamp || new Date().toISOString()}]`,
      `PLATFORM: ${errorInfo.platform || "unknown"}`,
      `CODE: ${errorInfo.originalCode || "unknown"}`,
      `ERROR: ${(errorInfo.originalError || "").slice(0, 500)}`,
      `CONTEXT: ${(errorInfo.context || "").slice(0, 300)}`,
      `AI_ERROR: ${(errorInfo.aiError || "N/A").slice(0, 200)}`,
    ].join(" | ");

    fs.appendFileSync(UNKNOWN_ERRORS_LOG, logLine + "\n", "utf8");
    console.log(`[errorResolver] 📝 Logged to unknown_errors.log`);
  } catch (logErr) {
    console.error(`[errorResolver] ❌ Failed to write to unknown_errors.log: ${logErr.message}`);
  }
}

module.exports = {
  askAIWhatToDo,
  logUnknownError,
};