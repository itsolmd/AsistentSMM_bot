/**
 * services/strapiUploader.js
 *
 * Optimized Strapi image uploader.
 *
 * Features:
 *   - HTTP Keep-Alive connection reuse
 *   - Per-image timeout (30s default)
 *   - Retry logic (3 attempts)
 *   - Streaming upload via FormData
 *   - Image validation before upload
 *   - Memory-efficient buffer handling
 */

const axios = require("axios");
const FormData = require("form-data");
const https = require("https");
const http = require("http");
const sharp = require("sharp");
require("dotenv").config();

/* ──────────────────────────────────────────────────────────────
 * HTTP Keep-Alive Agents (connection reuse)
 * Reduces TCP handshake overhead for each upload.
 * ────────────────────────────────────────────────────────────── */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 60000,
});

/**
 * getStrapiConfig(ctx)
 * Resolves Strapi token and backend URL from env or session.
 */
function getStrapiConfig(ctx) {
  const envToken = process.env.STRAPI_TOKEN;
  const sessionToken = ctx?.session?.user?.strapi_token;
  const token = envToken || sessionToken;

  const envBackend = process.env.BACK_END;
  const sessionBackend = ctx?.session?.user?.strapi_backend;
  const backend = envBackend || sessionBackend;

  return { token, backend };
}

/**
 * validateImageBuffer(buffer)
 * Uses sharp to verify the buffer is a valid image.
 * Returns metadata or throws.
 */
async function validateImageBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error("Empty buffer — cannot upload");
  }
  // Basic size sanity: must be at least 100 bytes
  if (buffer.length < 100) {
    throw new Error(`Buffer too small (${buffer.length} bytes) — likely corrupt`);
  }
  // Use sharp to validate image format
  const metadata = await sharp(buffer).metadata();
  if (!metadata || !metadata.format) {
    throw new Error("Sharp could not detect image format — corrupt or unsupported");
  }
  return metadata;
}

/**
 * uploadSingleImageToStrapi(imageBuffer, ctx, options)
 *
 * Uploads a single image buffer to Strapi with retry + timeout.
 *
 * @param {Buffer} imageBuffer - Image buffer
 * @param {Object} ctx - Telegraf context (for token resolution)
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - Upload timeout
 * @param {number} [options.maxRetries=3] - Retry count
 * @param {string} [options.filename] - Custom filename
 * @returns {Promise<{id: number|null, success: boolean, error: string|null, duration: number}>}
 */
async function uploadSingleImageToStrapi(imageBuffer, ctx, options = {}) {
  const timeout = options.timeout || 30000;
  const maxRetries = options.maxRetries || 3;
  const filename = options.filename || `image_${Date.now()}.jpg`;
  const startTime = Date.now();

  const result = {
    id: null,
    success: false,
    error: null,
    duration: 0,
  };

  // ── Validate buffer before attempting upload ──
  try {
    await validateImageBuffer(imageBuffer);
  } catch (validationErr) {
    result.error = `Validation failed: ${validationErr.message}`;
    result.duration = Date.now() - startTime;
    console.error(`❌ [strapiUploader] ${result.error}`);
    return result;
  }

  // ── Resolve config ──
  const { token, backend } = getStrapiConfig(ctx);
  if (!token) {
    result.error = "Missing STRAPI token";
    result.duration = Date.now() - startTime;
    console.error(`❌ [strapiUploader] ${result.error}`);
    return result;
  }
  if (!backend || backend === "i" || backend.length < 5) {
    result.error = `Malformed Strapi backend URL: "${backend}"`;
    result.duration = Date.now() - startTime;
    console.error(`❌ [strapiUploader] ${result.error}`);
    return result;
  }

  const endpoint = `http://${backend}/api/upload`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const formData = new FormData();
      formData.append("files", imageBuffer, {
        filename,
        contentType: "image/jpeg",
      });

      console.log(
        `📤 [strapiUploader] Uploading (attempt ${attempt}/${maxRetries}) ` +
        `→ ${endpoint} (${(imageBuffer.length / 1024).toFixed(1)}KB)`
      );

      const uploadResponse = await axios.post(endpoint, formData, {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${token}`,
          // Hint for keep-alive
          Connection: "keep-alive",
        },
        httpAgent,
        httpsAgent,
        timeout,
        // Strapi returns 200 on success
        validateStatus: (status) => status >= 200 && status < 300,
      });

      const imageId = uploadResponse.data?.[0]?.id;
      if (!imageId) {
        throw new Error("Upload succeeded but no image ID returned");
      }

      result.id = imageId;
      result.success = true;
      result.error = null;
      result.duration = Date.now() - startTime;

      console.log(
        `✅ [strapiUploader] Uploaded → ID: ${imageId} (${result.duration}ms)`
      );
      return result;
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;
      const errorMsg = err.message || "Unknown error";

      if (isLastAttempt) {
        console.error(
          `❌ [strapiUploader] Failed after ${maxRetries} attempts: ${errorMsg}`
        );
        if (err.response) {
          console.error(
            `   HTTP ${err.response.status}:`,
            JSON.stringify(err.response.data).slice(0, 300)
          );
        } else if (err.code === "ECONNABORTED") {
          console.error(`   Timeout after ${timeout}ms`);
        }
        result.error = errorMsg;
        result.duration = Date.now() - startTime;
      } else {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        console.warn(
          `⚠️ [strapiUploader] Attempt ${attempt} failed, retrying in ${backoff}ms: ${errorMsg}`
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  return result;
}

/**
 * uploadBatchToStrapi(buffers, ctx, options)
 *
 * Uploads multiple images with CONTROLLED CONCURRENCY via p-limit.
 *
 * @param {Array<{buffer: Buffer, url: string}>} imageItems - Array of {buffer, url}
 * @param {Object} ctx - Telegraf context
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Max parallel uploads
 * @param {number} [options.timeout=30000] - Per-upload timeout
 * @returns {Promise<Array<{id: number|null, url: string, success: boolean, error: string|null, duration: number}>>}
 */
async function uploadBatchToStrapi(imageItems, ctx, options = {}) {
  const { default: pLimit } = await import("p-limit");
  const concurrency = options.concurrency || 5;
  const limit = pLimit(concurrency);

  console.log(
    `[strapiUploader] Batch uploading ${imageItems.length} images ` +
    `(concurrency: ${concurrency}, timeout: ${options.timeout || 30000}ms)`
  );

  const startTime = Date.now();

  const tasks = imageItems.map((item, index) =>
    limit(() =>
      uploadSingleImageToStrapi(item.buffer, ctx, {
        ...options,
        filename: `image_${Date.now()}_${index}.jpg`,
      }).then((uploadResult) => ({
        ...uploadResult,
        url: item.url,
      }))
    )
  );

  const results = await Promise.allSettled(tasks);

  const uploadResults = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      id: null,
      url: imageItems[i]?.url || "unknown",
      success: false,
      error: r.reason?.message || "Unexpected rejection",
      duration: 0,
    };
  });

  const successCount = uploadResults.filter((r) => r.success).length;
  const failCount = uploadResults.filter((r) => !r.success).length;
  const totalDuration = Date.now() - startTime;

  console.log(
    `📊 [strapiUploader] Batch upload complete: ` +
    `${successCount} success, ${failCount} failed in ${totalDuration}ms`
  );

  return uploadResults;
}

/**
 * deleteOrphanImages(imageIds, ctx)
 *
 * Cleans up orphan images from Strapi if a posting fails.
 * Call this in error recovery paths.
 */
async function deleteOrphanImages(imageIds, ctx) {
  if (!Array.isArray(imageIds) || imageIds.length === 0) return;

  const { token, backend } = getStrapiConfig(ctx);
  if (!token || !backend) {
    console.warn("[strapiUploader] Cannot cleanup — missing Strapi config");
    return;
  }

  console.log(`[strapiUploader] Cleaning up ${imageIds.length} orphan images...`);

  for (const id of imageIds) {
    try {
      await axios.delete(`http://${backend}/api/upload/files/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      console.log(`[strapiUploader] Deleted orphan image ID: ${id}`);
    } catch (err) {
      console.warn(`[strapiUploader] Failed to delete image ID ${id}: ${err.message}`);
      // Non-blocking
    }
  }
}

module.exports = {
  uploadSingleImageToStrapi,
  uploadBatchToStrapi,
  deleteOrphanImages,
  validateImageBuffer,
  getStrapiConfig,
};