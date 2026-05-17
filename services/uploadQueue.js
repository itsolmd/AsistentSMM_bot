/**
 * services/uploadQueue.js
 *
 * Queue-based upload system with controlled concurrency.
 * Uses p-limit internally to cap concurrent operations.
 *
 * Features:
 *   - Configurable concurrency (default: 5)
 *   - Per-task timeout
 *   - Retry logic per task
 *   - Progress tracking with callbacks
 *   - Event-based completion notification
 *   - Drain detection (all tasks done)
 */

const { default: pLimit } = await import("p-limit");

class UploadQueue {
  /**
   * @param {Object} [options]
   * @param {number} [options.concurrency=5] - Max parallel tasks
   * @param {number} [options.defaultTimeout=60000] - Default per-task timeout (ms)
   * @param {number} [options.maxRetries=2] - Default retries per task
   * @param {Function} [options.onProgress] - Progress callback (completed, total, task)
   * @param {Function} [options.onDrain] - Called when all tasks complete
   * @param {Function} [options.onError] - Called per-task error
   */
  constructor(options = {}) {
    this.concurrency = options.concurrency || 5;
    this.defaultTimeout = options.defaultTimeout || 60000;
    this.maxRetries = options.maxRetries || 2;
    this.onProgress = options.onProgress || null;
    this.onDrain = options.onDrain || null;
    this.onError = options.onError || null;

    this._limit = pLimit(this.concurrency);
    this._queue = [];
    this._pending = 0;
    this._completed = 0;
    this._total = 0;
    this._failed = 0;
    this._startTime = null;
    this._drainCalled = false;
    this._aborted = false;
  }

  /**
   * Add a task to the queue.
   *
   * @param {Function} task - Async function to execute
   * @param {Object} [options]
   * @param {number} [options.timeout] - Per-task timeout (overrides default)
   * @param {number} [options.retries] - Retries for this task (overrides default)
   * @param {string} [options.label] - Task label for logging
   * @returns {Promise<any>} Result of the task
   */
  add(task, options = {}) {
    const timeout = options.timeout || this.defaultTimeout;
    const retries = options.retries ?? this.maxRetries;
    const label = options.label || `task_${this._total}`;
    const taskId = this._total++;

    const wrappedTask = async () => {
      this._pending++;
      let lastError = null;

      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        if (this._aborted) {
          console.warn(`[UploadQueue] Task ${label} aborted`);
          return { success: false, error: "Queue aborted", taskId, label };
        }

        try {
          const result = await this._withTimeout(task, timeout, label, attempt);
          this._pending--;
          this._completed++;
          this._reportProgress(label, true);
          return { success: true, result, taskId, label };
        } catch (err) {
          lastError = err;
          const isLastAttempt = attempt === retries + 1;

          if (isLastAttempt) {
            console.error(
              `❌ [UploadQueue] Task ${label} failed after ${attempt} attempts: ${err.message}`
            );
            this._pending--;
            this._failed++;
            this._reportProgress(label, false);

            if (this.onError) {
              this.onError({ label, error: err.message, taskId });
            }
            return { success: false, error: err.message, taskId, label };
          }

          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
          console.warn(
            `⚠️ [UploadQueue] Task ${label} attempt ${attempt} failed, ` +
            `retrying in ${backoff}ms: ${err.message}`
          );
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }

      this._pending--;
      return { success: false, error: lastError?.message || "Unknown", taskId, label };
    };

    // Wrap with p-limit for concurrency control
    const promise = this._limit(() => wrappedTask());
    this._queue.push(promise);

    // Check drain when promise resolves
    promise.finally(() => this._checkDrain());
    return promise;
  }

  /**
   * Add multiple tasks at once.
   *
   * @param {Array<{task: Function, options?: Object}>} tasks
   * @returns {Promise<Array>} Results of all tasks
   */
  addBatch(tasks) {
    if (!Array.isArray(tasks)) return Promise.resolve([]);
    return Promise.allSettled(
      tasks.map(({ task, options = {} }) => this.add(task, options))
    );
  }

  /**
   * Wait for all queued tasks to complete.
   */
  async onIdle() {
    // p-limit's activeCount and pendingCount
    while (this._limit.activeCount > 0 || this._limit.pendingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Get current queue status.
   */
  getStatus() {
    return {
      total: this._total,
      completed: this._completed,
      failed: this._failed,
      pending: this._pending,
      active: this._limit.activeCount,
      queued: this._limit.pendingCount,
      elapsed: this._startTime ? Date.now() - this._startTime : 0,
      aborted: this._aborted,
    };
  }

  /**
   * Abort all pending tasks.
   */
  abort() {
    this._aborted = true;
    console.log("[UploadQueue] ⛔ Queue aborted");
  }

  /**
   * Reset queue state.
   */
  reset() {
    this._queue = [];
    this._pending = 0;
    this._completed = 0;
    this._total = 0;
    this._failed = 0;
    this._startTime = null;
    this._drainCalled = false;
    this._aborted = false;
    // Recreate limiter
    this._limit = pLimit(this.concurrency);
    console.log("[UploadQueue] 🔄 Queue reset");
  }

  /* ── Private ── */

  _withTimeout(task, timeout, label, attempt) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task ${label} timed out after ${timeout}ms (attempt ${attempt})`));
      }, timeout);

      const start = Date.now();

      Promise.resolve()
        .then(() => task())
        .then((result) => {
          clearTimeout(timer);
          console.log(
            `[UploadQueue] ✅ Task ${label} completed in ${Date.now() - start}ms (attempt ${attempt})`
          );
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  _reportProgress(label, success) {
    if (!this._startTime) this._startTime = Date.now();
    const elapsed = Date.now() - this._startTime;
    const status = success ? "✅" : "❌";

    console.log(
      `[UploadQueue] ${status} [${this._completed}/${this._total}] ${label} ` +
      `(${elapsed}ms elapsed, ${this._limit.activeCount} active, ${this._limit.pendingCount} queued)`
    );

    if (this.onProgress) {
      this.onProgress({
        completed: this._completed,
        total: this._total,
        failed: this._failed,
        label,
        success,
        elapsed,
      });
    }
  }

  _checkDrain() {
    if (
      !this._drainCalled &&
      this._total > 0 &&
      this._completed + this._failed >= this._total &&
      this._limit.activeCount === 0 &&
      this._limit.pendingCount === 0
    ) {
      this._drainCalled = true;
      const elapsed = this._startTime ? Date.now() - this._startTime : 0;

      console.log(
        `[UploadQueue] 🏁 DRAIN: All ${this._total} tasks completed ` +
        `(${this._completed} success, ${this._failed} failed) in ${elapsed}ms`
      );

      if (this.onDrain) {
        this.onDrain({
          total: this._total,
          completed: this._completed,
          failed: this._failed,
          elapsed,
        });
      }
    }
  }
}

module.exports = { UploadQueue };