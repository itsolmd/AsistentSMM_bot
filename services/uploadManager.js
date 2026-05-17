/**
 * services/uploadManager.js
 *
 * Master orchestrator for the complete image upload pipeline.
 * Coordinates: download → deduplicate → watermark → upload → cleanup
 *
 * Pipeline:
 *   1. Image URLs → parallel download (axios, no Puppeteer)
 *   2. Deduplicate URLs + buffers
 *   3. Watermark removal (if flag set)
 *   4. Parallel Strapi upload with keep-alive
 *   5. Buffer cleanup
 *   6. Return uploaded image IDs
 *
 * Features:
 *   - Controlled parallelism via p-limit (concurrency: 5)
 *   - Per-image timeout (30s download, 30s upload)
 *   - Retry logic (3 attempts per image)
 *   - Corrupt image detection and skip
 *   - Memory buffer cleanup
 *   - Detailed progress logging
 *   - Orphan cleanup on failure
 */

const { downloadImagesParallel, cleanupBuffers } = require("./imageDownloader");
const { deduplicateImages } = require("./deduplicator");
const { uploadBatchToStrapi, deleteOrphanImages } = require("./strapiUploader");
const { removeWatermark } = require("../WaterMark-services/dewatermarking");
const sharp = require("sharp");

/**
 * ImagePipelineResult
 * @typedef {Object} ImagePipelineResult
 * @property {number[]} uploadedIds - Array of Strapi image IDs
 * @property {number} totalImages - Total input images
 * @property {number} successCount - Successfully uploaded
 * @property {number} failCount - Failed images
 * @property {number} skippedCount - Skipped (corrupt/duplicate)
 * @property {number} durationMs - Total pipeline duration
 * @property {Array} details - Per-image results
 */

/* ──────────────────────────────────────────────────────────────
 * processImagePipeline(data, ctx, removeWatermarkFlag, options)
 *
 * MAIN ENTRY POINT for image processing pipeline.
 * Processes ALL images in parallel with controlled concurrency.
 *
 * @param {Object} data - Ad data object (must have data.images array)
 * @param {Object} ctx - Telegraf context
 * @param {boolean} removeWatermarkFlag - Whether to remove watermarks
 * @param {Object} [options]
 * @param {number} [options.downloadConcurrency=5] - Parallel downloads
 * @param {number} [options.uploadConcurrency=3] - Parallel uploads
 * @param {number} [options.downloadTimeout=30000] - Per-download timeout (ms)
 * @param {number} [options.uploadTimeout=30000] - Per-upload timeout (ms)
 * @param {number} [options.maxRetries=3] - Retries per operation
 * @param {boolean} [options.keepAllImages=true] - If true, process ALL images (no cap)
 * @returns {Promise<ImagePipelineResult>}
 * ────────────────────────────────────────────────────────────── */
async function processImagePipeline(data, ctx, removeWatermarkFlag, options = {}) {
  const pipelineStart = Date.now();
  const downloadConcurrency = options.downloadConcurrency || 5;
  const uploadConcurrency = options.uploadConcurrency || 3;
  const downloadTimeout = options.downloadTimeout || 30000;
  const uploadTimeout = options.uploadTimeout || 30000;
  const maxRetries = options.maxRetries || 3;
  const keepAllImages = options.keepAllImages !== false; // Default: keep ALL

  // ── Initialize result ──
  const result = {
    uploadedIds: [],
    totalImages: 0,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    durationMs: 0,
    details: [],
  };

  // ── STEP 0: Validate input ──
  if (!data || !Array.isArray(data.images)) {
    console.warn("[uploadManager] No images array in data — skipping image pipeline");
    result.durationMs = Date.now() - pipelineStart;
    return result;
  }

  // ── STEP 1: Normalize and deduplicate URLs ──
  const rawUrls = data.images.filter(Boolean);
  result.totalImages = rawUrls.length;

  if (rawUrls.length === 0) {
    console.log("[uploadManager] Zero images to process");
    result.durationMs = Date.now() - pipelineStart;
    return result;
  }

  // Normalize URLs using telegramMediaSafe
  const { normalizeUrl, safeUrl } = require("../utils/telegramMediaSafe");
  const normalizedUrls = rawUrls
    .map((url) => safeUrl(normalizeUrl(url)))
    .filter(Boolean);

  if (normalizedUrls.length === 0) {
    console.warn("[uploadManager] All image URLs failed normalization");
    result.durationMs = Date.now() - pipelineStart;
    return result;
  }

  // Deduplicate
  const uniqueUrls = deduplicateImages(normalizedUrls);
  const dedupeSkipped = normalizedUrls.length - uniqueUrls.length;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("🚀 [UPLOAD MANAGER] PIPELINE START");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  📥 URL-uri brute:     ${rawUrls.length}`);
  console.log(`  📥 Normalizate:       ${normalizedUrls.length}`);
  console.log(`  📥 Unice:             ${uniqueUrls.length} (${dedupeSkipped} duplicate eliminate)`);
  console.log(`  💧 Watermark removal: ${removeWatermarkFlag ? 'DA' : 'NU'}`);
  console.log("───────────────────────────────────────────────────────────");

  // ── STEP 2: Parallel download (NO Puppeteer) ──
  console.log("📥 ETAPA 1/3: Descărcare imagini...");

  const downloadResults = await downloadImagesParallel(uniqueUrls, {
    concurrency: downloadConcurrency,
    timeout: downloadTimeout,
    maxRetries,
  });

  const successfulDownloads = downloadResults.filter((r) => r.success);
  const failedDownloads = downloadResults.filter((r) => !r.success);

  console.log(`  📊 Descărcare: ${successfulDownloads.length} succes, ${failedDownloads.length} eșuat`);
  console.log("───────────────────────────────────────────────────────────");

  // ── STEP 3: Watermark removal (parallel) ──
  let buffersToUpload = [];

  if (removeWatermarkFlag) {
    console.log(`💧 ETAPA 2/3: Eliminare watermark din ${successfulDownloads.length} imagini...`);
    buffersToUpload = await _processWatermarks(successfulDownloads, {
      concurrency: 3,
      timeout: 60000,
    });
    console.log(`  📊 Watermark: ${buffersToUpload.length} imagini procesate`);
  } else {
    // No watermark removal — use buffers directly
    console.log("💧 ETAPA 2/3: Watermark dezactivat — se folosesc imaginile originale");
    buffersToUpload = successfulDownloads.map((d) => ({
      buffer: d.buffer,
      url: d.url,
      duration: d.duration,
    }));
  }
  console.log("───────────────────────────────────────────────────────────");

  // ── STEP 4: Parallel Strapi upload ──
  console.log(`📤 ETAPA 3/3: Upload ${buffersToUpload.length} imagini pe Strapi...`);

  const uploadResults = await uploadBatchToStrapi(buffersToUpload, ctx, {
    concurrency: uploadConcurrency,
    timeout: uploadTimeout,
  });

  // ── Aggregate results ──
  const successfulUploads = uploadResults.filter((r) => r.id !== null);
  const failedUploads = uploadResults.filter((r) => r.id === null);

  result.uploadedIds = successfulUploads.map((r) => r.id);
  result.successCount = successfulUploads.length;
  result.failCount = failedUploads.length + failedDownloads.length;
  result.skippedCount = dedupeSkipped;
  result.durationMs = Date.now() - pipelineStart;

  // Build detailed results
  result.details = uploadResults.map((u) => ({
    url: u.url,
    strapiId: u.id,
    success: u.success,
    error: u.error,
    uploadDuration: u.duration,
  }));

  // ── STEP 5: Cleanup buffers (GC-friendly) ──
  cleanupBuffers(downloadResults);

  // ── REZUMAT FINAL ──
  console.log("───────────────────────────────────────────────────────────");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("🏁 [UPLOAD MANAGER] PIPLINIE COMPLETĂ");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ✅ Încărcate:  ${result.successCount}`);
  console.log(`  ❌ Eșuate:     ${result.failCount}`);
  console.log(`  ⏭️  Sărite:     ${result.skippedCount} (duplicate)`);
  console.log(`  ⏱️  Durată:     ${result.durationMs}ms`);
  console.log(`  🆔 IDs Strapi:  [${result.uploadedIds.join(", ")}]`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("");

  return result;
}

/* ──────────────────────────────────────────────────────────────
 * processImagePipelineFast(data, ctx, removeWatermarkFlag, options)
 *
 * FAST variant — processes with higher concurrency (8/5) for large image sets.
 * Same pipeline, just more aggressive parallelism.
 * ────────────────────────────────────────────────────────────── */
async function processImagePipelineFast(data, ctx, removeWatermarkFlag, options = {}) {
  return processImagePipeline(data, ctx, removeWatermarkFlag, {
    downloadConcurrency: 8,
    uploadConcurrency: 5,
    downloadTimeout: 30000,
    uploadTimeout: 30000,
    maxRetries: 2,
    ...options,
  });
}

/* ──────────────────────────────────────────────────────────────
 * _processWatermarks(downloadResults, options)
 *
 * Parallel watermark removal with controlled concurrency.
 * Falls back to original image on failure.
 * Returns array of {buffer, url} for upload.
 * ────────────────────────────────────────────────────────────── */
async function _processWatermarks(downloadResults, options = {}) {
  const { default: pLimit } = await import("p-limit");
  const concurrency = options.concurrency || 3;
  const limit = pLimit(concurrency);

  console.log(`  💧 Procesare watermark pentru ${downloadResults.length} imagini...`);

  let wmSuccess = 0;
  let wmFallback = 0;
  let wmIndex = 0;
  const totalWm = downloadResults.length;

  const tasks = downloadResults.map((download) =>
    limit(async () => {
      wmIndex++;
      try {
        console.log(`    💧 [${wmIndex}/${totalWm}] Eliminare watermark: ${download.url.slice(0, 60)}...`);
        const dewatermarkResult = await removeWatermark(download.buffer);

        if (dewatermarkResult.success && dewatermarkResult.buffer) {
          // Ensure JPEG format
          const jpgBuffer = await sharp(dewatermarkResult.buffer).jpeg().toBuffer();
          console.log(`    ✅ [${wmIndex}/${totalWm}] Watermark eliminat cu succes`);
          wmSuccess++;
          return { buffer: jpgBuffer, url: download.url, duration: download.duration };
        }

        // Watermark removal failed — use original
        console.warn(`    ⚠️ [${wmIndex}/${totalWm}] Watermark eșuat, folosesc original`);
        const jpgBuffer = await sharp(download.buffer).jpeg().toBuffer();
        wmFallback++;
        return { buffer: jpgBuffer, url: download.url, duration: download.duration };
      } catch (err) {
        // Exception during watermark — use original
        console.error(`    ❌ [${wmIndex}/${totalWm}] Excepție watermark: ${err.message}`);
        try {
          const jpgBuffer = await sharp(download.buffer).jpeg().toBuffer();
          wmFallback++;
          return { buffer: jpgBuffer, url: download.url, duration: download.duration };
        } catch {
          wmFallback++;
          return { buffer: download.buffer, url: download.url, duration: download.duration };
        }
      }
    })
  );

  const results = await Promise.allSettled(tasks);
  const buffers = [];

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      buffers.push(r.value);
    }
  }

  console.log(`  📊 Watermark rezumat: ${wmSuccess} succes, ${wmFallback} fallback`);
  return buffers;
}

/* ──────────────────────────────────────────────────────────────
 * processImagesFor999(data, ctx)
 *
 * Specialized pipeline for 999.md platform.
 * Downloads images but returns buffers directly (no Strapi upload).
 * Used by post/platforms/999.js
 * ────────────────────────────────────────────────────────────── */
async function processImagesFor999(data, ctx, options = {}) {
  const concurrency = options.concurrency || 5;

  if (!data || !Array.isArray(data.images)) {
    return { buffers: [], results: [] };
  }

  const { normalizeUrl, safeUrl } = require("../utils/telegramMediaSafe");
  const normalizedUrls = data.images
    .map((url) => safeUrl(normalizeUrl(url)))
    .filter(Boolean);
  const uniqueUrls = deduplicateImages(normalizedUrls);

  console.log(
    `[uploadManager:999] Downloading ${uniqueUrls.length} images for 999.md...`
  );

  const downloadResults = await downloadImagesParallel(uniqueUrls, {
    concurrency,
    timeout: 30000,
    maxRetries: 3,
  });

  const validBuffers = downloadResults
    .filter((r) => r.success && r.buffer)
    .map((r) => ({
      buffer: r.buffer,
      url: r.url,
      downloadDuration: r.duration,
    }));

  console.log(`[uploadManager:999] Downloaded ${validBuffers.length}/${uniqueUrls.length} images`);

  // Cleanup failed buffers
  cleanupBuffers(downloadResults.filter((r) => !r.success));

  return {
    buffers: validBuffers,
    results: downloadResults,
  };
}

module.exports = {
  processImagePipeline,
  processImagePipelineFast,
  processImagesFor999,
};