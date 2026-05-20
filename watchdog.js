/**
 * ════════════════════════════════════════════════════════════════
 *  WATCHDOG — Anti-Stall Monitoring System
 * ════════════════════════════════════════════════════════════════
 *
 *  Monitorizează:
 *    • Activitatea botului (mesaje procesate)
 *    • Activitatea scraping-ului
 *    • Timpul de răspuns
 *
 *  Dacă nu există activitate pentru WATCHDOG_TIMEOUT minute
 *  → restart automat al procesului.
 *
 *  Configurare (env):
 *    WATCHDOG_TIMEOUT  = minute fără activitate înainte de restart (default: 10)
 *    WATCHDOG_INTERVAL = intervalul de verificare în secunde (default: 30)
 * ════════════════════════════════════════════════════════════════ */

const logger = require("./logger");

const WATCHDOG_TIMEOUT = parseInt(process.env.WATCHDOG_TIMEOUT || "30", 10); // minute
const WATCHDOG_INTERVAL = parseInt(process.env.WATCHDOG_INTERVAL || "30", 10); // seconds

class Watchdog {
  constructor() {
    this.lastActivity = Date.now();
    this.lastScrapeActivity = Date.now();
    this.lastResponseTime = 0;
    this.messageCount = 0;
    this.scrapeCount = 0;
    this.errorCount = 0;
    this.interval = null;
    this.enabled = true;
    this.stallDetected = false;
  }

  /**
   * Start watchdog monitoring
   */
  start() {
    logger.watchdog(`Watchdog started — timeout: ${WATCHDOG_TIMEOUT}m, check interval: ${WATCHDOG_INTERVAL}s`);

    this.interval = setInterval(() => {
      this.check();
    }, WATCHDOG_INTERVAL * 1000);

    this.interval.unref(); // Don't keep process alive just for watchdog
  }

  /**
   * Stop watchdog
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Record bot activity (message received/processed)
   */
  recordActivity() {
    this.lastActivity = Date.now();
    this.messageCount++;
    this.stallDetected = false;
  }

  /**
   * Record scraping activity
   */
  recordScrapeActivity() {
    this.lastScrapeActivity = Date.now();
    this.scrapeCount++;
  }

  /**
   * Record response time (ms)
   */
  recordResponseTime(ms) {
    this.lastResponseTime = ms;
  }

  /**
   * Record an error
   */
  recordError() {
    this.errorCount++;
  }

  /**
   * Get watchdog status
   */
  getStatus() {
    const now = Date.now();
    const idleMinutes = (now - this.lastActivity) / 60000;
    const scrapeIdleMinutes = (now - this.lastScrapeActivity) / 60000;

    return {
      status: this.stallDetected ? "stalled" : "healthy",
      idleMinutes: Math.round(idleMinutes * 10) / 10,
      scrapeIdleMinutes: Math.round(scrapeIdleMinutes * 10) / 10,
      messageCount: this.messageCount,
      scrapeCount: this.scrapeCount,
      errorCount: this.errorCount,
      lastResponseTime: this.lastResponseTime,
      enabled: this.enabled,
    };
  }

  /**
   * Internal check — called by interval
   */
  check() {
    if (!this.enabled) return;

    const now = Date.now();
    const idleMs = now - this.lastActivity;
    const idleMinutes = idleMs / 60000;

    // Check for scrape stall separately
    const scrapeIdleMs = now - this.lastScrapeActivity;
    const scrapeIdleMinutes = scrapeIdleMs / 60000;

    // If no activity for WATCHDOG_TIMEOUT minutes → STALL DETECTED
    if (idleMinutes >= WATCHDOG_TIMEOUT) {
      this.stallDetected = true;
      logger.watchdog(
        `STALL DETECTED — No activity for ${Math.round(idleMinutes)} minutes. Initiating restart.`,
        {
          idleMinutes: Math.round(idleMinutes * 10) / 10,
          messageCount: this.messageCount,
          scrapeCount: this.scrapeCount,
          errorCount: this.errorCount,
        }
      );

      // Force restart via process.exit (PM2 will restart)
      logger.restart("Watchdog triggered forced restart due to stall");
      setTimeout(() => {
        process.exit(1);
      }, 2000);
    }

    // Warn if scrape is idle but bot is active
    if (scrapeIdleMinutes >= Math.floor(WATCHDOG_TIMEOUT / 2) && idleMinutes < WATCHDOG_TIMEOUT) {
      logger.watchdog(
        `Scrape idle warning — No scrape activity for ${Math.round(scrapeIdleMinutes)} minutes`,
        { scrapeIdleMinutes: Math.round(scrapeIdleMinutes * 10) / 10 }
      );
    }
  }

  /**
   * Reset all counters (after restart/recovery)
   */
  reset() {
    this.lastActivity = Date.now();
    this.lastScrapeActivity = Date.now();
    this.messageCount = 0;
    this.scrapeCount = 0;
    this.errorCount = 0;
    this.stallDetected = false;
    logger.watchdog("Watchdog counters reset");
  }
}

// Singleton
const watchdog = new Watchdog();

module.exports = watchdog;