/**
 * workers/postingWorker.js
 *
 * Background posting worker.
 * The Telegram bot does NOT wait for this worker.
 * It returns an instant callback to the user and processes in background.
 *
 * Architecture:
 *   - Receives jobs via postWorkerQueue
 *   - Processes images in parallel (controlled concurrency)
 *   - Posts to selected platforms
 *   - Reports results via Telegram when done
 *   - Retries failed jobs
 *   - Handles errors gracefully (never crashes)
 */

const { UploadQueue } = require("../services/uploadQueue");
const { processImagePipeline } = require("../services/uploadManager");
const { postToPremier } = require("../post/platforms/premier");
const { postTo999 } = require("../post/platforms/999");
const { postToMeta } = require("../post/platforms/meta");

/* ──────────────────────────────────────────────────────────────
 * PostingWorker
 *
 * Singleton worker that processes posting jobs in the background.
 * ────────────────────────────────────────────────────────────── */
class PostingWorker {
  constructor(options = {}) {
    this._queue = new UploadQueue({
      concurrency: options.concurrency || 2, // 2 concurrent posting jobs
      defaultTimeout: options.defaultTimeout || 300000, // 5 min per job
      maxRetries: options.maxRetries || 1,
      onProgress: null, // We handle progress per-job
      onDrain: () => {
        console.log("  🏁 [POSTING WORKER] Toate job-urile completate");
      },
      onError: ({ label, error }) => {
        console.error(`  ❌ [POSTING WORKER] Job ${label} eșuat: ${error}`);
      },
    });

    this._jobCount = 0;
    this._isRunning = false;
  }

  /**
   * Submit a posting job to the background worker.
   * Returns immediately — the bot does NOT wait for completion.
   *
   * @param {Object} job - Posting job
   * @param {string} job.type - 'premier', '999', 'meta', or 'all'
   * @param {Object} job.data - Ad data object
   * @param {Object} job.ctx - Telegraf context (for reply later)
   * @param {boolean} job.removeWatermark - Watermark removal flag
   * @param {Array} [job.platforms] - Platforms to post to (for 'all' type)
   * @param {string} [job.label] - Optional job label
   */
  submitJob(job) {
    const jobId = ++this._jobCount;
    const label = job.label || `post_${jobId}`;

    console.log("");
    console.log("───────────────────────────────────────────────────────────");
    console.log(`📥 [POSTING WORKER] Job ${label} submit (type: ${job.type}, platforms: ${job.platforms?.join(", ") || job.type})`);
    console.log("───────────────────────────────────────────────────────────");

    // Send instant acknowledgment to user
    if (job.ctx && typeof job.ctx.reply === "function") {
      job.ctx
        .reply(
          "🔄 Postare în curs de procesare în fundal... " +
          `(${label})\nVeți primi notificare când este gata.`
        )
        .catch(() => {}); // Non-blocking
    }

    // Queue the job for background processing
    this._queue.add(
      () => this._processJob(job, label),
      {
        label,
        timeout: 300000, // 5 min per job
        retries: 1,
      }
    );
  }

  /**
   * Internal: process a single posting job.
   * This runs in the background queue.
   */
  async _processJob(job, label) {
    const jobStart = Date.now();

    try {
      // ── STEP 1: Process images (parallel download + Strapi upload) ──
      if (job.type === "premier" || (job.type === "all" && job.platforms?.includes("premier"))) {
        console.log(`  📸 Procesare imagini pentru Premier...`);

        const pipelineResult = await processImagePipeline(
          job.data,
          job.ctx,
          job.removeWatermark,
          {
            downloadConcurrency: 5,
            uploadConcurrency: 3,
            keepAllImages: true, // ALL images preserved
          }
        );

        // Attach uploaded image IDs to data for posting
        job.data.uploadedImageIds = pipelineResult.uploadedIds;

        console.log(`  📸 ${pipelineResult.successCount} imagini încărcate (IDs: [${pipelineResult.uploadedIds.join(", ")}])`);
      }

      // ── STEP 2: Post to selected platforms ──
      if (job.type === "premier") {
        console.log(`  🏢 Postare pe Premier...`);
        await postToPremier(job.data, job.ctx, job.removeWatermark);
        console.log(`  ✅ Premier completat`);
      } else if (job.type === "999") {
        console.log(`  🌐 Postare pe 999.md...`);
        await postTo999(job.ctx);
        console.log(`  ✅ 999.md completat`);
      } else if (job.type === "meta") {
        console.log(`  📘 Postare pe Meta...`);
        await postToMeta(job.ctx);
        console.log(`  ✅ Meta completat`);
      } else if (job.type === "all" && Array.isArray(job.platforms)) {
        for (const platform of job.platforms) {
          try {
            if (platform === "premier") {
              console.log(`  🏢 Postare pe Premier...`);
              await postToPremier(job.data, job.ctx, job.removeWatermark);
            } else if (platform === "999") {
              console.log(`  🌐 Postare pe 999.md...`);
              await postTo999(job.ctx);
            } else if (platform === "meta") {
              console.log(`  📘 Postare pe Meta...`);
              await postToMeta(job.ctx);
            }
            console.log(`  ✅ ${platform} completat`);
          } catch (platErr) {
            console.error(`  ❌ ${platform} eșuat: ${platErr.message}`);
          }
        }
      }

      const jobDuration = Date.now() - jobStart;
      console.log("───────────────────────────────────────────────────────────");
      console.log(`🏁 [POSTING WORKER] Job ${label} COMPLET în ${jobDuration}ms`);
      console.log("───────────────────────────────────────────────────────────");
      console.log("");

      // Notify user on completion
      if (job.ctx && typeof job.ctx.reply === "function") {
        try {
          await job.ctx.reply(
            `✅ Postarea **${label}** a fost finalizată cu succes! ` +
            `(${(jobDuration / 1000).toFixed(1)}s)`
          );
        } catch (replyErr) {
          console.warn(
            `  ⚠️ Nu s-a putut notifica userul pentru job ${label}: ${replyErr.message}`
          );
        }
      }

      return { success: true, duration: jobDuration, label };
    } catch (err) {
      const jobDuration = Date.now() - jobStart;
      console.error(`  ❌ Job ${label} EȘUAT după ${jobDuration}ms: ${err.message}`);
      console.error(err.stack);

      // Notify user on failure
      if (job.ctx && typeof job.ctx.reply === "function") {
        try {
          await job.ctx.reply(
            `❌ Postarea **${label}** a eșuat după ${(jobDuration / 1000).toFixed(1)}s.\n` +
            `Eroare: ${err.message}\nVă rugăm să încercați din nou.`
          );
        } catch (replyErr) {
          console.warn(
            `  ⚠️ Nu s-a putut notifica userul pentru job eșuat ${label}: ${replyErr.message}`
          );
        }
      }

      throw err; // Re-throw for queue retry logic
    }
  }

  /**
   * Get current worker status.
   */
  getStatus() {
    return {
      ...this._queue.getStatus(),
      running: this._isRunning,
    };
  }

  /**
   * Abort all pending jobs.
   */
  abort() {
    this._queue.abort();
  }
}

// Singleton instance
const postWorkerInstance = new PostingWorker();

module.exports = {
  PostingWorker,
  postWorker: postWorkerInstance,
};
