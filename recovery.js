/**
 * ════════════════════════════════════════════════════════════════
 *  RECOVERY — Auto-Recovery Logic
 * ════════════════════════════════════════════════════════════════
 *
 *  După restart:
 *    • Botul reia automat taskurile
 *    • Nu pierde starea critică
 *    • Reîncearcă operațiunile eșuate
 *
 *  Mecanism:
 *    • Salvează starea critică în fișier JSON
 *    • La pornire, verifică dacă există stare salvată
 *    • Reîncearcă taskurile eșuate (cu backoff exponențial)
 *    • Curăță starea după recuperare reușită
 *
 *  Configurare (env):
 *    RECOVERY_STATE_FILE = cale fișier stare (default: .recovery-state.json)
 *    RECOVERY_MAX_RETRIES = reîncercări maxime (default: 3)
 * ════════════════════════════════════════════════════════════════ */

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const STATE_FILE = path.join(__dirname, process.env.RECOVERY_STATE_FILE || ".recovery-state.json");
const MAX_RETRIES = parseInt(process.env.RECOVERY_MAX_RETRIES || "3", 10);

class RecoveryManager {
  constructor() {
    this.state = {
      version: 1,
      lastRestart: null,
      restartCount: 0,
      pendingTasks: [],
      failedTasks: [],
      lastActivity: null,
      sessionData: null,
    };
    this.recoveryInProgress = false;
  }

  /**
   * Initialize recovery manager — load saved state
   */
  init() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        const saved = JSON.parse(raw);
        this.state = { ...this.state, ...saved };
        logger.recovery("Recovery state loaded from file", {
          restartCount: this.state.restartCount,
          pendingTasks: this.state.pendingTasks.length,
          failedTasks: this.state.failedTasks.length,
        });
        return true;
      }
    } catch (err) {
      logger.error("RECOVERY", "Failed to load recovery state", { error: err.message });
    }
    return false;
  }

  /**
   * Save current state to disk
   */
  saveState() {
    try {
      this.state.lastActivity = new Date().toISOString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), "utf8");
    } catch (err) {
      logger.error("RECOVERY", "Failed to save recovery state", { error: err.message });
    }
  }

  /**
   * Record a restart event
   */
  recordRestart(reason) {
    this.state.restartCount++;
    this.state.lastRestart = {
      time: new Date().toISOString(),
      reason,
      pid: process.pid,
    };
    this.saveState();
    logger.restart(`Restart #${this.state.restartCount} recorded`, {
      reason,
      restartCount: this.state.restartCount,
    });
  }

  /**
   * Add a pending task (to be retried after recovery)
   */
  addPendingTask(task) {
    this.state.pendingTasks.push({
      ...task,
      addedAt: new Date().toISOString(),
      retries: 0,
    });
    this.saveState();
    logger.recovery(`Pending task added: ${task.name}`, { taskName: task.name });
  }

  /**
   * Add a failed task (for diagnostics)
   */
  addFailedTask(task, error) {
    this.state.failedTasks.push({
      ...task,
      error: error.message,
      failedAt: new Date().toISOString(),
    });

    // Keep only last 50 failed tasks
    if (this.state.failedTasks.length > 50) {
      this.state.failedTasks = this.state.failedTasks.slice(-50);
    }

    this.saveState();
    logger.recovery(`Failed task recorded: ${task.name}`, {
      taskName: task.name,
      error: error.message,
    });
  }

  /**
   * Save session data (critical state that must survive restart)
   */
  saveSessionData(data) {
    this.state.sessionData = {
      savedAt: new Date().toISOString(),
      data,
    };
    this.saveState();
  }

  /**
   * Get saved session data
   */
  getSessionData() {
    return this.state.sessionData ? this.state.sessionData.data : null;
  }

  /**
   * Clear session data
   */
  clearSessionData() {
    this.state.sessionData = null;
    this.saveState();
  }

  /**
   * Execute recovery — retry pending tasks
   * @param {Function} taskHandler - Function to handle task execution
   */
  async executeRecovery(taskHandler) {
    if (this.recoveryInProgress) {
      logger.recovery("Recovery already in progress, skipping");
      return;
    }

    this.recoveryInProgress = true;
    logger.recovery("Starting recovery process", {
      pendingTasks: this.state.pendingTasks.length,
      failedTasks: this.state.failedTasks.length,
    });

    // Retry pending tasks
    const tasksToRetry = [...this.state.pendingTasks];
    this.state.pendingTasks = [];
    this.saveState();

    for (const task of tasksToRetry) {
      try {
        logger.recovery(`Retrying task: ${task.name}`, { taskName: task.name, retry: task.retries + 1 });

        if (task.retries >= MAX_RETRIES) {
          logger.recovery(`Task ${task.name} exceeded max retries, moving to failed`, {
            taskName: task.name,
            retries: task.retries,
          });
          this.addFailedTask(task, new Error("Max retries exceeded"));
          continue;
        }

        // Exponential backoff
        const backoff = Math.min(1000 * Math.pow(2, task.retries), 30000);
        await new Promise((resolve) => setTimeout(resolve, backoff));

        await taskHandler(task);
        logger.recovery(`Task ${task.name} recovered successfully`, { taskName: task.name });
      } catch (err) {
        logger.recovery(`Task ${task.name} retry failed`, {
          taskName: task.name,
          error: err.message,
        });
        this.addPendingTask({ ...task, retries: task.retries + 1 });
      }
    }

    this.recoveryInProgress = false;
    logger.recovery("Recovery process completed", {
      remainingPending: this.state.pendingTasks.length,
      totalFailed: this.state.failedTasks.length,
    });

    this.saveState();
  }

  /**
   * Clear all recovery state (after successful recovery)
   */
  clearState() {
    try {
      this.state.pendingTasks = [];
      this.state.failedTasks = [];
      this.state.sessionData = null;
      this.saveState();
      logger.recovery("Recovery state cleared");

      if (fs.existsSync(STATE_FILE)) {
        fs.unlinkSync(STATE_FILE);
        logger.recovery("Recovery state file deleted");
      }
    } catch (err) {
      logger.error("RECOVERY", "Failed to clear recovery state", { error: err.message });
    }
  }

  /**
   * Get recovery status
   */
  getStatus() {
    return {
      restartCount: this.state.restartCount,
      lastRestart: this.state.lastRestart,
      pendingTasks: this.state.pendingTasks.length,
      failedTasks: this.state.failedTasks.length,
      hasSessionData: !!this.state.sessionData,
      recoveryInProgress: this.recoveryInProgress,
    };
  }
}

// Singleton
const recoveryManager = new RecoveryManager();

module.exports = recoveryManager;