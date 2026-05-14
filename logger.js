/**
 * ════════════════════════════════════════════════════════════════
 *  LOGGER — Structured Logging & Diagnostics
 * ════════════════════════════════════════════════════════════════
 *
 *  Features:
 *    • Timestamped, structured JSON logs
 *    • Log levels: DEBUG, INFO, WARN, ERROR, FATAL
 *    • Automatic log rotation (via file size)
 *    • Special categories: RESTART, BLOCK, RECOVERY, MEMORY, WATCHDOG
 *    • Console + optional file output
 * ════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "bot.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB per file

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

const LEVEL_NAMES = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

const CATEGORIES = {
  RESTART: "🔄 RESTART",
  BLOCK: "🔒 BLOCK",
  RECOVERY: "♻️ RECOVERY",
  MEMORY: "🧠 MEMORY",
  WATCHDOG: "🐕 WATCHDOG",
  HEALTH: "💚 HEALTH",
  WORKER: "⚙️ WORKER",
  TIMEOUT: "⏰ TIMEOUT",
  GENERAL: "📋 GENERAL",
};

let currentLogSize = 0;

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE
 */
function rotateLogIfNeeded() {
  try {
    const stats = fs.statSync(LOG_FILE);
    currentLogSize = stats.size;
    if (currentLogSize >= MAX_LOG_SIZE) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const rotatedPath = path.join(LOG_DIR, `bot-${timestamp}.log`);
      fs.renameSync(LOG_FILE, rotatedPath);
      currentLogSize = 0;
      console.log(`[LOGGER] Log rotated → ${rotatedPath}`);
    }
  } catch {
    // File doesn't exist yet, that's fine
    currentLogSize = 0;
  }
}

/**
 * Write a single log entry
 */
function writeLog(entry) {
  const line = JSON.stringify(entry) + "\n";
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch (err) {
    console.error("[LOGGER] Failed to write log file:", err.message);
  }
}

/**
 * Core log function
 */
function log(level, category, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: LEVEL_NAMES[level] || "INFO",
    category: CATEGORIES[category] || category,
    message,
    pid: process.pid,
    uptime: process.uptime(),
    ...data,
  };

  // Console output with colors
  const prefix = `[${entry.timestamp}] [${entry.level}] ${entry.category}`;
  switch (level) {
    case LEVELS.FATAL:
    case LEVELS.ERROR:
      console.error(`${prefix} ${message}`, data.error ? data.error : "");
      if (data.stack) console.error(data.stack);
      break;
    case LEVELS.WARN:
      console.warn(`${prefix} ${message}`);
      break;
    default:
      console.log(`${prefix} ${message}`);
  }

  // Write to file
  writeLog(entry);
}

// Public API
const logger = {
  debug: (category, message, data) => log(LEVELS.DEBUG, category, message, data),
  info: (category, message, data) => log(LEVELS.INFO, category, message, data),
  warn: (category, message, data) => log(LEVELS.WARN, category, message, data),
  error: (category, message, data) => log(LEVELS.ERROR, category, message, data),
  fatal: (category, message, data) => log(LEVELS.FATAL, category, message, data),

  // Convenience methods for resilience categories
  restart: (message, data) => log(LEVELS.INFO, "RESTART", message, data),
  block: (message, data) => log(LEVELS.WARN, "BLOCK", message, data),
  recovery: (message, data) => log(LEVELS.INFO, "RECOVERY", message, data),
  memory: (message, data) => log(LEVELS.WARN, "MEMORY", message, data),
  watchdog: (message, data) => log(LEVELS.WARN, "WATCHDOG", message, data),
  health: (message, data) => log(LEVELS.INFO, "HEALTH", message, data),
  worker: (message, data) => log(LEVELS.INFO, "WORKER", message, data),
  timeout: (message, data) => log(LEVELS.WARN, "TIMEOUT", message, data),
};

module.exports = logger;