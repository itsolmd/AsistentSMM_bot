/**
 * ════════════════════════════════════════════════════════════════
 *  WORKER SCRAPER — Worker Isolation pentru Scraping
 * ════════════════════════════════════════════════════════════════
 *
 *  Scraping-ul NU rulează în procesul principal.
 *  Rulează în child_process separat.
 *  Dacă se blochează → kill worker fără a afecta botul.
 *
 *  Mecanism:
 *    • Procesul principal trimite un URL către worker
 *    • Worker-ul face scraping și returnează rezultatul
 *    • Dacă worker-ul nu răspunde în X secunde → timeout → kill
 *    • Worker-ul nou este pornit automat la nevoie
 *
 *  Configurare (env):
 *    WORKER_TIMEOUT = timeout worker în ms (default: 120000 = 2min)
 *    WORKER_MAX_RESTARTS = restarturi maxime per oră (default: 5)
 * ════════════════════════════════════════════════════════════════ */

const { fork } = require("child_process");
const path = require("path");
const logger = require("./logger");

const WORKER_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT || "120000", 10);
const WORKER_MAX_RESTARTS = parseInt(process.env.WORKER_MAX_RESTARTS || "5", 10);

class ScraperWorker {
  constructor() {
    this.worker = null;
    this.pendingRequests = new Map();
    this.requestId = 0;
    this.restartCount = 0;
    this.lastRestartTime = Date.now();
    this.workerPath = path.join(__dirname, "worker-scraper-child.js");
    this.ready = false;
  }

  /**
   * Start the worker process
   */
  start() {
    if (this.worker) {
      this.kill();
    }

    try {
      this.worker = fork(this.workerPath, [], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        env: { ...process.env },
      });

      logger.worker(`Worker process started (PID: ${this.worker.pid})`);

      // Handle messages from worker
      this.worker.on("message", (msg) => {
        this.handleMessage(msg);
      });

      // Handle worker exit
      this.worker.on("exit", (code, signal) => {
        logger.worker(`Worker exited (code: ${code}, signal: ${signal})`);
        this.ready = false;
        this.handleWorkerExit(code, signal);
      });

      // Handle worker errors
      this.worker.on("error", (err) => {
        logger.error("WORKER", "Worker process error", { error: err.message });
        this.ready = false;
      });

      // Handle stdout/stderr from worker
      this.worker.stdout.on("data", (data) => {
        logger.worker(`Worker stdout: ${data.toString().trim()}`);
      });

      this.worker.stderr.on("data", (data) => {
        logger.worker(`Worker stderr: ${data.toString().trim()}`);
      });

      // Wait for ready signal
      this.ready = true;
      return true;
    } catch (err) {
      logger.error("WORKER", "Failed to start worker", { error: err.message });
      this.worker = null;
      this.ready = false;
      return false;
    }
  }

  /**
   * Handle messages from worker
   */
  handleMessage(msg) {
    if (msg.type === "ready") {
      this.ready = true;
      logger.worker("Worker is ready");
      return;
    }

    if (msg.type === "result" && msg.requestId) {
      const pending = this.pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.requestId);

        if (msg.success) {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(msg.error || "Worker scraping failed"));
        }
      }
    }

    if (msg.type === "log") {
      logger.worker(`[Worker] ${msg.message}`, msg.data || {});
    }

    if (msg.type === "error") {
      logger.error("WORKER", `[Worker] ${msg.message}`, msg.data || {});
    }
  }

  /**
   * Handle worker exit
   */
  handleWorkerExit(code, signal) {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Worker exited unexpectedly (code: ${code}, signal: ${signal})`));
    }
    this.pendingRequests.clear();

    // Check restart rate limit
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    if (now - this.lastRestartTime > oneHour) {
      // Reset counter if more than an hour has passed
      this.restartCount = 0;
    }

    this.restartCount++;
    this.lastRestartTime = now;

    if (this.restartCount > WORKER_MAX_RESTARTS) {
      logger.fatal("WORKER", `Worker exceeded max restarts (${WORKER_MAX_RESTARTS}/hr). Not restarting.`);
      this.worker = null;
      this.ready = false;
      return;
    }

    // Auto-restart worker
    logger.worker(`Auto-restarting worker (restart #${this.restartCount})`);
    setTimeout(() => {
      this.start();
    }, 2000);
  }

  /**
   * Send a scraping task to the worker
   * @param {string} url - URL to scrape
   * @param {object} options - Scraping options
   * @returns {Promise<object>} Scraped data
   */
  async scrape(url, options = {}) {
    if (!this.worker || !this.ready) {
      const started = this.start();
      if (!started) {
        throw new Error("Failed to start worker process");
      }
      // Wait a bit for worker to initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        logger.timeout(`Worker scraping timed out for URL: ${url.substring(0, 50)}...`, {
          requestId: id,
          timeout: WORKER_TIMEOUT,
        });

        // Kill and restart worker on timeout
        this.kill();
        setTimeout(() => this.start(), 1000);

        reject(new Error(`Worker scraping timed out after ${WORKER_TIMEOUT}ms`));
      }, options.timeout || WORKER_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.worker.send({
        type: "scrape",
        requestId: id,
        url,
        options,
      });
    });
  }

  /**
   * Kill the worker process
   */
  kill() {
    if (this.worker) {
      try {
        this.worker.kill("SIGKILL");
        logger.worker(`Worker process killed (PID: ${this.worker.pid})`);
      } catch (err) {
        // Process may already be dead
      }
      this.worker = null;
      this.ready = false;
    }

    // Reject any remaining pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Worker was killed"));
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if worker is healthy
   */
  isHealthy() {
    if (!this.worker) return false;
    try {
      return this.worker.connected && this.ready;
    } catch {
      return false;
    }
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      alive: this.isHealthy(),
      pid: this.worker ? this.worker.pid : null,
      pendingRequests: this.pendingRequests.size,
      restartCount: this.restartCount,
      ready: this.ready,
    };
  }
}

// Singleton
const scraperWorker = new ScraperWorker();

module.exports = scraperWorker;