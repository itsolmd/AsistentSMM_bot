/**
 * services/imageDownloader.js
 *
 * High-performance image downloader.
 * REPLACES Puppeteer for direct .jpg URLs from simpalsmedia.com.
 * Uses axios with proper headers — NO browser overhead.
 *
 * Features:
 *   - Direct axios download (no Puppeteer)
 *   - Retry logic with exponential backoff (3 retries)
 *   - Per-image timeout (30s)
 *   - Corrupt image detection
 *   - Buffer cleanup hooks
 *   - Progress logging
 */

const axios = require("axios");
const sharp = require("sharp");
const https = require("https");
const http = require("http");

/* ──────────────────────────────────────────────────────────────
 * HTTP Keep-Alive Agents (reuse connections)
 * ────────────────────────────────────────────────────────────── */
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 30000,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 25,
  maxFreeSockets: 10,
  timeout: 30000,
});

/* ──────────────────────────────────────────────────────────────
 * Browser-like headers to avoid blocks
 * ────────────────────────────────────────────────────────────── */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept:
    "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://999.md/",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Fetch-Dest": "image",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
};

/* ──────────────────────────────────────────────────────────────
 * isSimpalsMediaUrl(url)
 * Returns true if URL is a direct image from simpalsmedia.com
 * ────────────────────────────────────────────────────────────── */
function isSimpalsMediaUrl(url) {
  if (!url || typeof url !== "string") return false;
  return url.includes("simpalsmedia.com");
}

/* ──────────────────────────────────────────────────────────────
 * isDirectImageUrl(url)
 * Returns true if URL points to a direct image file (.jpg, .jpeg, .png, .webp)
 * ────────────────────────────────────────────────────────────── */
function isDirectImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  return /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(url);
}

/* ──────────────────────────────────────────────────────────────
 * downloadSingleImage(url, options)
 *
 * Downloads a single image directly with axios.
 * NO Puppeteer needed for simpalsmedia.com direct .jpg URLs.
 *
 * @param {string} url - Image URL
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - Per-image timeout (ms)
 * @param {number} [options.maxRetries=3] - Retry count
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<{buffer: Buffer|null, url: string, success: boolean, error: string|null, duration: number}>}
 * ────────────────────────────────────────────────────────────── */
async function downloadSingleImage(url, options = {}) {
  const timeout = options.timeout || 30000;
  const maxRetries = options.maxRetries || 3;
  const startTime = Date.now();

  const result = {
    buffer: null,
    url,
    success: false,
    error: null,
    duration: 0,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const shortUrl = url.length > 80 ? url.slice(0, 80) + '...' : url;
      console.log(`    📥 [${attempt}/${maxRetries}] ${shortUrl}`);

      const response = await axios.get(url, {
        responseType: "arraybuffer",
        timeout,
        headers: {
          ...BROWSER_HEADERS,
          // Add Referer from original URL domain if simpalsmedia
          ...(isSimpalsMediaUrl(url) ? { Referer: "https://999.md/" } : {}),
        },
        httpAgent,
        httpsAgent,
        maxRedirects: 5,
        signal: options.signal,
        // Validate status — accept any 2xx
        validateStatus: (status) => status >= 200 && status < 300,
      });

      const buffer = Buffer.from(response.data);

      // ── Validate: buffer must have content ──
      if (!buffer || buffer.length === 0) {
        console.warn(`⚠️ [imageDownloader] Empty buffer for: ${url.slice(0, 100)}`);
        result.error = "Empty response buffer";
        continue;
      }

      // ── Validate: buffer must be a valid image (try sharp) ──
      try {
        const metadata = await sharp(buffer).metadata();
        if (!metadata || !metadata.format) {
          console.warn(`    ⚠️ Invalid image (no format)`);
          result.error = "Invalid image — no format detected";
          continue;
        }
        console.log(
          `    ✅ Descărcat: ${(buffer.length / 1024).toFixed(1)}KB, ${metadata.width}x${metadata.height}, ${metadata.format}`
        );
      } catch (sharpErr) {
        console.warn(`    ⚠️ Imagine coruptă: ${sharpErr.message}`);
        result.error = `Corrupt image: ${sharpErr.message}`;
        continue; // Retry — maybe transient corruption
      }

      result.buffer = buffer;
      result.success = true;
      result.error = null;
      result.duration = Date.now() - startTime;
      return result;
    } catch (err) {
      const isLastAttempt = attempt === maxRetries;
      const errorMsg = err.message || "Unknown error";

      if (isLastAttempt) {
        console.error(`    ❌ Eșuat după ${maxRetries} încercări: ${errorMsg}`);
        result.error = errorMsg;
        result.duration = Date.now() - startTime;

        // Log detailed error info
        if (err.response) {
          console.error(`       HTTP ${err.response.status}: ${err.response.statusText}`);
        } else if (err.code === "ECONNABORTED") {
          console.error(`       Timeout după ${timeout}ms`);
        } else if (err.code === "ENOTFOUND") {
          console.error(`       DNS lookup eșuat`);
        }
      } else {
        // Exponential backoff: 1s, 2s, 4s
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        console.warn(`    ⚠️ Încercare ${attempt} eșuată, reîncerc în ${backoff}ms: ${errorMsg}`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  return result;
}

/* ──────────────────────────────────────────────────────────────
 * downloadImagesParallel(urls, options)
 *
 * Downloads multiple images with CONTROLLED PARALLELISM.
 * Uses p-limit for concurrency control.
 *
 * @param {string[]} urls - Array of image URLs
 * @param {Object} [options]
 * @param {number} [options.concurrency=5] - Max parallel downloads
 * @param {number} [options.timeout=30000] - Per-image timeout
 * @param {number} [options.maxRetries=3] - Retries per image
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<Array<{buffer: Buffer|null, url: string, success: boolean, error: string|null, duration: number}>>}
 * ────────────────────────────────────────────────────────────── */
async function downloadImagesParallel(urls, options = {}) {
  const { default: pLimit } = await import("p-limit");
  const concurrency = options.concurrency || 5;
  const limit = pLimit(concurrency);

  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`📥 [IMAGE DOWNLOADER] Descărcare ${urls.length} imagini (concurrency: ${concurrency})`);
  console.log("───────────────────────────────────────────────────────────");

  const startTime = Date.now();

  let completedCount = 0;
  const totalCount = urls.length;

  const tasks = urls.map((url, index) =>
    limit(async () => {
      const result = await downloadSingleImage(url, options);
      completedCount++;
      const status = result.success ? '✅' : '❌';
      console.log(`  ${status} [${completedCount}/${totalCount}] ${result.success ? 'OK' : 'FAIL'} — ${url.slice(0, 60)}...`);
      return result;
    })
  );

  const results = await Promise.allSettled(tasks);

  const downloaded = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      buffer: null,
      url: urls[i],
      success: false,
      error: r.reason?.message || "Unexpected rejection",
      duration: 0,
    };
  });

  const successCount = downloaded.filter((r) => r.success).length;
  const failCount = downloaded.filter((r) => !r.success).length;
  const totalDuration = Date.now() - startTime;

  console.log("───────────────────────────────────────────────────────────");
  console.log(`📊 [IMAGE DOWNLOADER] Rezumat: ${successCount} succes, ${failCount} eșuat în ${totalDuration}ms`);
  console.log("───────────────────────────────────────────────────────────");

  if (failCount > 0) {
    const failedUrls = downloaded
      .filter((r) => !r.success)
      .map((r) => `  ❌ ${r.url.slice(0, 80)} — ${r.error}`);
    console.warn(`⚠️ [IMAGE DOWNLOADER] Imagini eșuate:\n${failedUrls.join("\n")}`);
  }

  return downloaded;
}

/* ──────────────────────────────────────────────────────────────
 * cleanupBuffers(buffers)
 * Helper to explicitly free buffer references for GC
 * ────────────────────────────────────────────────────────────── */
function cleanupBuffers(results) {
  if (!Array.isArray(results)) return;
  for (const result of results) {
    result.buffer = null;
  }
}

module.exports = {
  downloadSingleImage,
  downloadImagesParallel,
  isSimpalsMediaUrl,
  isDirectImageUrl,
  cleanupBuffers,
};