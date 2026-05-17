const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { removeWatermark } = require("./dewatermarking");
const FormData = require("form-data");
const { downloadSingleImage } = require("../services/imageDownloader");

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, "temp_downloads");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * Decode a JWT payload (base64) without verifying signature.
 * Returns null on invalid input.
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * Check if the configured DEWATERMARK_API_KEY has expired.
 * Returns { valid: true } or { valid: false, expiredAt: Date, reason: string }.
 */
function checkApiKeyStatus() {
  const apiKey =
    process.env.DEWATERMARK_API_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJpZ25vcmUiLCJwbGF0Zm9ybSI6IndlYiIsImlzX3BybyI6ZmFsc2UsImV4cCI6MTczMDk5NzI0M30.UPYSK0Vt-Jx2FHz_ACqRPQc7FFmi3gKGBt4gotC5kvA";

  const payload = decodeJwtPayload(apiKey);
  if (!payload || !payload.exp) {
    return { valid: true }; // can't determine → assume valid
  }
  const expiredAt = new Date(payload.exp * 1000);
  const now = new Date();
  if (now >= expiredAt) {
    return {
      valid: false,
      expiredAt,
      reason: `API key expired on ${expiredAt.toISOString()}`,
    };
  }
  return { valid: true, expiredAt };
}

/**
 * downloadImage - Downloads an image from a URL to a temp file
 * OPTIMIZED: Direct download via axios for ALL URLs (simpalsmedia + others).
 * NO Puppeteer needed — direct .jpg URLs work fine with proper headers.
 * Uses the shared imageDownloader service with retry + timeout.
 */
async function downloadImage(imageUrl) {
  try {
    // Use the shared high-performance downloader (axios, no Puppeteer)
    const result = await downloadSingleImage(imageUrl, {
      timeout: 30000,
      maxRetries: 3,
    });

    if (result.success && result.buffer) {
      const ext = path.extname(imageUrl) || ".jpg";
      const filename = `img_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`;
      const filepath = path.join(tempDir, filename);
      fs.writeFileSync(filepath, result.buffer);
      return { filepath, buffer: result.buffer };
    }

    console.error(`    ❌ [downloadImage] Eșuat: ${result.error}`);
    return null;
  } catch (error) {
    console.error(`    ❌ [downloadImage] Excepție: ${error.message}`);
    return null;
  }
}

/**
 * processListingImages - Processes a list of image URLs through watermark removal
 *
 * @param {string[]} imageUrls - Array of image URLs
 * @param {Object} options - Processing options
 * @param {number} options.concurrency - Max concurrent downloads
 * @returns {Promise<Object>} Result with cleanedImages array
 */
async function processListingImages(imageUrls, options = {}) {
  // ── Pre-emptive token expiry check ──
  const keyStatus = checkApiKeyStatus();
  if (!keyStatus.valid) {
    console.error(`  💧 [WATERMARK] ⛔ Sare peste: ${keyStatus.reason}`);
    console.error("  💧 [WATERMARK] 💡 Actualizează DEWATERMARK_API_KEY în .env");
    // Return results with all images marked as skipped
    const skippedResults = (imageUrls || []).map((url) => ({
      originalUrl: url,
      success: false,
      cleanedPath: null,
      fallbackUsed: true,
      error: keyStatus.reason,
    }));
    return { cleanedImages: skippedResults };
  }

  const concurrency = options.concurrency || 3;
  const results = [];
  const totalImages = imageUrls.length;
  const totalBatches = Math.ceil(totalImages / concurrency);

  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`💧 [WATERMARK] Procesare ${totalImages} imagini (batch-uri de ${concurrency}, ${totalBatches} batch-uri)`);
  console.log("───────────────────────────────────────────────────────────");

  let globalImgIndex = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  // Process images in batches based on concurrency
  for (let batchIdx = 0; batchIdx < imageUrls.length; batchIdx += concurrency) {
    const batch = imageUrls.slice(batchIdx, batchIdx + concurrency);
    const batchNum = Math.floor(batchIdx / concurrency) + 1;
    console.log(`  💧 Batch ${batchNum}/${totalBatches} (${batch.length} imagini)...`);

    const batchResults = await Promise.all(
      batch.map(async (url) => {
        globalImgIndex++;
        const result = {
          originalUrl: url,
          success: false,
          cleanedPath: null,
          fallbackUsed: false,
          error: null,
        };

        try {
          // Step 1: Download image
          console.log(`    📥 [${globalImgIndex}/${totalImages}] Descărcare: ${url.slice(0, 60)}...`);
          const downloadResult = await downloadImage(url);
          if (!downloadResult) {
            console.log(`    ❌ [${globalImgIndex}/${totalImages}] Descărcare eșuată`);
            result.error = "Download failed";
            totalFailed++;
            return result;
          }

          // Step 2: Remove watermark
          console.log(`    🎨 [${globalImgIndex}/${totalImages}] Eliminare watermark...`);
          const dewatermarkResult = await removeWatermark(downloadResult.buffer);

          if (dewatermarkResult.success && dewatermarkResult.buffer) {
            // Step 3: Save cleaned image
            const cleanedFilename = `cleaned_${path.basename(downloadResult.filepath)}`;
            const cleanedPath = path.join(tempDir, cleanedFilename);
            fs.writeFileSync(cleanedPath, dewatermarkResult.buffer);

            result.success = true;
            result.cleanedPath = cleanedPath;
            console.log(`    ✅ [${globalImgIndex}/${totalImages}] Watermark eliminat: ${cleanedFilename}`);
            totalSuccess++;
          } else {
            console.error(`    ❌ [${globalImgIndex}/${totalImages}] Watermark eșuat: ${dewatermarkResult.error}`);
            result.error = dewatermarkResult.error || "Watermark removal failed";
            result.fallbackUsed = true;
            totalFailed++;
          }
        } catch (error) {
          console.error(`    ❌ [${globalImgIndex}/${totalImages}] Excepție: ${error.message}`);
          result.error = error.message;
          result.fallbackUsed = true;
          totalFailed++;
        }

        return result;
      })
    );
    results.push(...batchResults);
  }

  console.log("───────────────────────────────────────────────────────────");
  console.log(`💧 [WATERMARK] Rezumat: ${totalSuccess} succes, ${totalFailed} eșuat din ${totalImages} imagini`);
  console.log("───────────────────────────────────────────────────────────");
  console.log("");

  return {
    cleanedImages: results,
  };
}

module.exports = { processListingImages };
