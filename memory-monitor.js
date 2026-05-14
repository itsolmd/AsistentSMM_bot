/**
 * ════════════════════════════════════════════════════════════════
 *  MEMORY MONITOR — Protecție împotriva Memory Leaks
 * ════════════════════════════════════════════════════════════════
 *
 *  Monitorizează consumul de RAM al procesului.
 *  Dacă memoria depășește pragul definit → restart automat.
 *
 *  Configurare (env):
 *    MEMORY_LIMIT_MB    = limită RAM în MB (default: 1024 = 1GB)
 *    MEMORY_CHECK_INTERVAL = interval verificare în secunde (default: 60)
 *    MEMORY_GC_INTERVAL    = interval forțare GC în secunde (default: 300)
 *
 *  Prevenire memory leaks:
 *    • Forțează garbage collection (dacă e disponibil)
 *    • Loghează trendul de creștere a memoriei
 *    • Restart automat la depășirea pragului
 * ════════════════════════════════════════════════════════════════ */

const logger = require("./logger");

const MEMORY_LIMIT_MB = parseInt(process.env.MEMORY_LIMIT_MB || "1024", 10);
const MEMORY_CHECK_INTERVAL = parseInt(process.env.MEMORY_CHECK_INTERVAL || "60", 10);
const MEMORY_GC_INTERVAL = parseInt(process.env.MEMORY_GC_INTERVAL || "300", 10);

class MemoryMonitor {
  constructor() {
    this.interval = null;
    this.gcInterval = null;
    this.enabled = true;
    this.history = [];
    this.maxHistory = 60; // Keep last 60 samples
    this.warningThreshold = Math.floor(MEMORY_LIMIT_MB * 0.8); // 80% warning
    this.criticalThreshold = Math.floor(MEMORY_LIMIT_MB * 0.95); // 95% critical
  }

  /**
   * Start memory monitoring
   */
  start() {
    logger.memory(
      `Memory monitor started — limit: ${MEMORY_LIMIT_MB}MB, check interval: ${MEMORY_CHECK_INTERVAL}s`,
      { memoryLimitMB: MEMORY_LIMIT_MB }
    );

    // Check memory periodically
    this.interval = setInterval(() => {
      this.check();
    }, MEMORY_CHECK_INTERVAL * 1000);
    this.interval.unref();

    // Force GC periodically (if --expose-gc is enabled)
    if (global.gc) {
      this.gcInterval = setInterval(() => {
        const before = process.memoryUsage().heapUsed;
        global.gc();
        const after = process.memoryUsage().heapUsed;
        const freed = Math.round((before - after) / 1024 / 1024);
        if (freed > 1) {
          logger.memory(`GC freed ${freed}MB`, { freedMB: freed });
        }
      }, MEMORY_GC_INTERVAL * 1000);
      this.gcInterval.unref();
    } else {
      logger.memory("GC not available — run with --expose-gc for better memory management");
    }
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.gcInterval) {
      clearInterval(this.gcInterval);
      this.gcInterval = null;
    }
  }

  /**
   * Get current memory usage in MB
   */
  getUsage() {
    const mem = process.memoryUsage();
    return {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    };
  }

  /**
   * Check memory and take action if needed
   */
  check() {
    if (!this.enabled) return;

    const usage = this.getUsage();
    this.history.push({ timestamp: Date.now(), ...usage });

    // Keep history bounded
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Detect memory growth trend
    const trend = this.detectTrend();

    // Log current state
    logger.memory(
      `Memory: RSS=${usage.rss}MB, Heap=${usage.heapUsed}MB/${usage.heapTotal}MB, Limit=${MEMORY_LIMIT_MB}MB`,
      { usage, trend }
    );

    // Check thresholds
    if (usage.rss >= MEMORY_LIMIT_MB) {
      // CRITICAL — exceeded limit, force restart
      logger.fatal("MEMORY", `Memory limit exceeded! RSS=${usage.rss}MB > ${MEMORY_LIMIT_MB}MB. Forcing restart.`, {
        rss: usage.rss,
        limit: MEMORY_LIMIT_MB,
        trend,
      });

      logger.restart("Memory monitor triggered forced restart due to limit exceeded");
      setTimeout(() => {
        process.exit(1);
      }, 2000);
    } else if (usage.rss >= this.criticalThreshold) {
      // CRITICAL — near limit, warn and try GC
      logger.memory(
        `CRITICAL: Memory at ${usage.rss}MB (${Math.round((usage.rss / MEMORY_LIMIT_MB) * 100)}% of limit)`,
        { level: "critical", usage, trend }
      );

      // Try forced GC
      if (global.gc) {
        global.gc();
        const afterGc = this.getUsage();
        logger.memory(`After forced GC: RSS=${afterGc.rss}MB`, { afterGc });
      }
    } else if (usage.rss >= this.warningThreshold) {
      // WARNING — approaching limit
      logger.memory(
        `WARNING: Memory at ${usage.rss}MB (${Math.round((usage.rss / MEMORY_LIMIT_MB) * 100)}% of limit)`,
        { level: "warning", usage, trend }
      );
    }
  }

  /**
   * Detect memory growth trend
   */
  detectTrend() {
    if (this.history.length < 5) return "insufficient_data";

    const recent = this.history.slice(-5);
    const first = recent[0].rss;
    const last = recent[recent.length - 1].rss;
    const diff = last - first;

    if (diff > 50) return `growing (+${diff}MB in 5 samples)`;
    if (diff < -50) return `shrinking (${diff}MB in 5 samples)`;
    return `stable (${diff >= 0 ? "+" : ""}${diff}MB)`;
  }

  /**
   * Get memory status summary
   */
  getStatus() {
    const usage = this.getUsage();
    return {
      ...usage,
      limitMB: MEMORY_LIMIT_MB,
      usagePercent: Math.round((usage.rss / MEMORY_LIMIT_MB) * 100),
      trend: this.detectTrend(),
      enabled: this.enabled,
    };
  }
}

// Singleton
const memoryMonitor = new MemoryMonitor();

module.exports = memoryMonitor;