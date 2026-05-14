/**
 * ════════════════════════════════════════════════════════════════
 *  TASK TIMEOUT — Timeout Centralizat pentru Toate Taskurile
 * ════════════════════════════════════════════════════════════════
 *
 *  Fiecare task (scraping / procesare) poate fi înfășurat cu
 *  timeout. Dacă depășește limita → task kill + log.
 *
 *  Configurare (env):
 *    TASK_TIMEOUT_SCRAPE  = timeout scraping în ms (default: 60000 = 60s)
 *    TASK_TIMEOUT_PROCESS = timeout procesare în ms (default: 30000 = 30s)
 *    TASK_TIMEOUT_NETWORK = timeout rețea în ms (default: 15000 = 15s)
 * ════════════════════════════════════════════════════════════════ */

const logger = require("./logger");

const DEFAULTS = {
  SCRAPE: parseInt(process.env.TASK_TIMEOUT_SCRAPE || "60000", 10),
  PROCESS: parseInt(process.env.TASK_TIMEOUT_PROCESS || "30000", 10),
  NETWORK: parseInt(process.env.TASK_TIMEOUT_NETWORK || "15000", 10),
};

/**
 * Wrap an async function with a timeout.
 * If the function doesn't complete within the timeout,
 * the promise rejects with a TimeoutError.
 *
 * @param {Function} fn - Async function to wrap
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} taskName - Name of the task (for logging)
 * @returns {Function} Wrapped function
 */
function withTimeout(fn, timeoutMs, taskName = "unnamed") {
  return async function (...args) {
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Task "${taskName}" timed out after ${timeoutMs}ms`);
        error.code = "TASK_TIMEOUT";
        error.taskName = taskName;
        error.timeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);

      // Allow the timer to be cleaned up if the promise resolves
      timer.unref();
    });

    try {
      const result = await Promise.race([
        fn.apply(this, args),
        timeoutPromise,
      ]);
      return result;
    } catch (error) {
      if (error.code === "TASK_TIMEOUT") {
        logger.timeout(`Task "${taskName}" timed out after ${timeoutMs}ms`, {
          taskName,
          timeoutMs,
          args: args.length,
        });
      }
      throw error;
    }
  };
}

/**
 * Create a timeout promise that rejects after specified ms
 */
function timeout(ms, message = "Operation timed out") {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(message);
      error.code = "TASK_TIMEOUT";
      reject(error);
    }, ms);
    timer.unref();
  });
}

/**
 * Run a promise with a timeout
 */
async function runWithTimeout(promise, ms, taskName = "unnamed") {
  try {
    const result = await Promise.race([
      promise,
      timeout(ms, `Task "${taskName}" timed out after ${ms}ms`),
    ]);
    return result;
  } catch (error) {
    if (error.code === "TASK_TIMEOUT") {
      logger.timeout(`Task "${taskName}" timed out`, { taskName, timeoutMs: ms });
    }
    throw error;
  }
}

module.exports = {
  withTimeout,
  timeout,
  runWithTimeout,
  DEFAULTS,
};