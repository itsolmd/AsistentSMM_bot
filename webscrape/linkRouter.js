// webscrape/linkRouter.js
const { Markup } = require("telegraf");
const fs = require("fs");
const https = require("https");
const http = require("http");

const { sendMessage, buildCaptionText } = require("../utils/message_main");
const { sendFilter }             = require("../utils/messasge_filter");
const { loyalSendMessage }       = require("../utils/loyalsendmesssage");
const { sanitizeAdData }         = require("../utils/telegramSafeText");
const { sanitizeImages }         = require("../utils/telegramMediaSafe");

const { scrap_999 }              = require("./websites/999");
const { scrap_premier }          = require("./websites/premier");
const { scrap_immobiliare }      = require("./websites/immobiliare");
const { parseLoyal }             = require("./websites/loyal");

const axios                      = require("axios");
const { sendMessageFromPremier } = require("../utils/message_main_premier");

// Watermark removal service
const { processListingImages }   = require("../WaterMark-services/Dewatermark");

/*───────────────────────────────────────────────────────────*/
/* Helpers                                                   */
/*───────────────────────────────────────────────────────────*/

/**
 * replyWithTimeout(ctx, text, extra, timeoutMs)
 * -----------------------------------------------
 * Wraps ctx.reply() with a configurable timeout to prevent
 * indefinite hangs when the Telegram API is slow or
 * unresponsive. If the reply times out, logs a warning
 * and returns without throwing (graceful degradation).
 *
 * @param {Object}  ctx       - Telegraf context
 * @param {string}  text      - Message text
 * @param {Object}  extra     - Extra options for reply (parse_mode, etc.)
 * @param {number}  timeoutMs - Timeout in ms (default: 15000)
 * @returns {Promise<Object|null>} Message object or null on timeout/error
 */
async function replyWithTimeout(ctx, text, extra = {}, timeoutMs = 15000) {
  try {
    const result = await Promise.race([
      ctx.reply(text, extra),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`ctx.reply timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
    return result;
  } catch (err) {
    console.warn(`  ⚠️ [replyWithTimeout] ${err.message} — continuing without reply`);
    return null;
  }
}

/**
 * splitIntoBatches(array, batchSize)
 * Splits an array into chunks of `batchSize`.
 * Used to send Telegram media groups in batches of 10.
 */
function splitIntoBatches(array, batchSize = 10) {
  const batches = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * validateImageUrlReachable(url, timeoutMs)
 * -----------------------------------------
 * Performs a HEAD request to check if an image URL is reachable.
 * Used to filter out broken/dead images BEFORE sending to Telegram.
 *
 * @param  {string}  url       - Image URL to validate
 * @param  {number}  timeoutMs - Timeout in ms (default: 5000)
 * @return {Promise<boolean>}  - true if URL responds with 2xx/3xx
 */
function validateImageUrlReachable(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith("https") ? https : http;
      const req = client.request(url, { method: "HEAD", timeout: timeoutMs }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/**
 * filterReachableImages(images, concurrency)
 * -------------------------------------------
 * Validates an array of image URLs concurrently and returns only
 * the ones that are reachable (HTTP 2xx/3xx). Used to pre-filter
 * dead links before sending to Telegram media groups.
 *
 * @param  {string[]} images     - Array of image URLs
 * @param  {number}   concurrency - Max concurrent HEAD requests (default: 5)
 * @return {Promise<string[]>}    - Array of reachable image URLs
 */
async function filterReachableImages(images, concurrency = 5) {
  if (!Array.isArray(images) || images.length === 0) return [];

  const results = [];
  const queue = [...images];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      const reachable = await validateImageUrlReachable(url);
      results.push({ url, reachable });
      if (!reachable) {
        console.warn(`  🔍 [URL CHECK] ⛔ Dead image filtered: ${url}`);
      }
    }
  }

  const workers = Array(Math.min(concurrency, images.length)).fill().map(() => worker());
  await Promise.all(workers);

  const valid = results.filter(r => r.reachable).map(r => r.url);
  const removed = results.length - valid.length;
  if (removed > 0) {
    console.warn(`  🔍 [URL CHECK] Eliminate ${removed}/${results.length} imagini moarte/inaccesibile`);
  }
  return valid;
}

/**
 * sendMediaGroupWithFallback(ctx, mediaGroup, captionText, batchIndex, totalBatches)
 *
 * Attempts to send a media group. If it fails, logs the error and falls back
 * to sending images ONE BY ONE so that valid images are preserved and only
 * the problematic ones are skipped.
 *
 * @param {Object} ctx          - Telegraf context
 * @param {Array}  mediaGroup   - Array of media objects for sendMediaGroup
 * @param {string} captionText  - Caption text for the last image
 * @param {number} batchIndex   - Current batch index (0-based)
 * @param {number} totalBatches - Total number of batches
 * @returns {Promise<boolean>}  - true if at least one image was sent
 */
async function sendMediaGroupWithFallback(ctx, mediaGroup, captionText, batchIndex, totalBatches) {
  try {
    // Attempt full media group send
    await ctx.replyWithMediaGroup(mediaGroup);
    return true;
  } catch (err) {
    console.warn(`  ⚠️ Batch ${batchIndex + 1}/${totalBatches} media group error: ${err.message}`);
    console.warn(`  ⚠️ Falling back to per-image sending for batch ${batchIndex + 1}...`);

    // Fallback: send each image individually, attaching caption only on the LAST
    // successfully sent image of the LAST batch.
    let lastSuccessIndex = -1;
    const results = [];

    for (let i = 0; i < mediaGroup.length; i++) {
      const item = mediaGroup[i];
      try {
        // Only send caption on the very last image of the entire set.
        // For per-image fallback, we don't know yet if this is the last
        // successful one, so we send without caption first, then edit later.
        await ctx.replyWithPhoto(item.media, { caption: undefined });
        results.push({ index: i, success: true });
        lastSuccessIndex = i;
      } catch (imgErr) {
        console.warn(`  ⚠️ Image ${i + 1} in batch ${batchIndex + 1} FAILED: ${imgErr.message} — skipping`);
        results.push({ index: i, success: false, error: imgErr.message });
      }
    }

    // Send caption as a separate text message for the last batch
    if (captionText && batchIndex === totalBatches - 1 && lastSuccessIndex >= 0) {
      try {
        await ctx.reply(captionText, { parse_mode: "Markdown" });
      } catch (captionErr) {
        console.warn(`  ⚠️ Caption fallback error: ${captionErr.message} — sending without parse_mode`);
        try {
          await ctx.reply(captionText);
        } catch (finalErr) {
          console.error(`  ❌ Caption completely failed: ${finalErr.message}`);
        }
      }
    }

    const sentCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;
    if (sentCount > 0) {
      console.log(`  ✅ Batch ${batchIndex + 1} fallback: ${sentCount} sent, ${failedCount} failed`);
      return true;
    }
    console.error(`  ❌ Batch ${batchIndex + 1} fallback: ALL ${failedCount} images failed`);
    return false;
  }
}
/**
 * persistSessionDataToMongo(ctx, db)
 *
 * Persists ctx.session.data to MongoDB as pendingAdData for resilience
 * against Telegraf's in-memory session loss. Called immediately after
 * session.data is set, so the MongoDB copy is always available for
 * subsequent callback queries (e.g., "Post Premier").
 *
 * @param {Object} ctx - Telegraf context
 * @param {Object} db  - MongoDB database instance
 */
async function persistSessionDataToMongo(ctx, db) {
  if (!db || !ctx?.session?.data || typeof ctx.session.data !== 'object' || Object.keys(ctx.session.data).length === 0) {
    console.warn('[PERSIST] Skipping MongoDB persist — no db or session.data is empty');
    return false;
  }
  try {
    await db.collection("users").updateOne(
      { telegramChatID: ctx.chat.id.toString() },
      { $set: { pendingAdData: JSON.parse(JSON.stringify(ctx.session.data)) } }
    );
    console.log('[PERSIST] ✅ session.data saved to MongoDB for user', ctx.chat.id);
    return true;
  } catch (persistErr) {
    console.error('[PERSIST] ❌ Failed to save session.data to MongoDB:', persistErr.message);
    return false;
  }
}

const returnPremierOptions = async (ctx, db) => {
  try {
    const slug = ctx.message.text.trim().split("/").slice(-2).join("/");
    console.log("🔍 [returnPremierOptions] Fetching slug:", slug);

    // ── Resolve Strapi backend URL: session-level first, env-level fallback ──
    const sessionBackend = ctx?.session?.user?.strapi_backend;
    const envBackend     = process.env.BACK_END;
    const backend        = sessionBackend || envBackend;

    if (!backend) {
      console.error("❌ [returnPremierOptions] No Strapi backend URL available (session or env)");
      return ctx.reply("Eroare de configurare: URL-ul backend-ului Strapi nu este disponibil. Contactați administratorul.");
    }

    // ── Resolve Strapi token: session-level first, env-level fallback ──
    const sessionToken = ctx?.session?.user?.strapi_token;
    const envToken     = process.env.STRAPI_TOKEN;
    const token        = sessionToken || envToken;

    if (!token) {
      console.error("❌ [returnPremierOptions] No Strapi token available (session or env)");
      return ctx.reply("Eroare de configurare: Token-ul Strapi nu este disponibil. Contactați administratorul.");
    }

    console.log(`🔍 [returnPremierOptions] Using backend: ${backend} (source: ${sessionBackend ? 'session' : 'env'})`);
    console.log(`🔍 [returnPremierOptions] Using token: ${token.slice(0, 8)}... (source: ${sessionToken ? 'session' : 'env'})`);

    const { data } = await axios.get(
      `http://${backend}/api/${slug}?populate=*`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    ctx.session.data = data.data;
    console.log('[returnPremierOptions] session.data stored — keys:', Object.keys(ctx.session.data || {}).join(', '));

    // ── PERSIST to MongoDB for resilience across callback queries ──
    await persistSessionDataToMongo(ctx, db);

    const { thumbnails, captionText } = sendMessageFromPremier(ctx);
    const premierBatches = splitIntoBatches(thumbnails, 10);
    for (let batchIndex = 0; batchIndex < premierBatches.length; batchIndex++) {
      const batch = premierBatches[batchIndex];
      const isLastBatch = batchIndex === premierBatches.length - 1;
      const mediaGroup = batch.map((thumbnail, index) => ({
        type: thumbnail.type,
        media: thumbnail.media,
        ...(isLastBatch && index === batch.length - 1
          ? { caption: captionText, parse_mode: 'Markdown' }
          : {}),
      }));
      await ctx.replyWithMediaGroup(mediaGroup);
    }
    await ctx.reply(
      "Ce doriți să faceți?",
      Markup.inlineKeyboard([
        Markup.button.callback("Postează", "post_platforms"),
      ])
    );
  } catch (err) {
    console.error("❌ [returnPremierOptions] Error:", err.message);
    // Log detailed error diagnostics
    if (err.response) {
      console.error("❌ [returnPremierOptions] HTTP Status:", err.response.status);
      console.error("❌ [returnPremierOptions] Response data:", JSON.stringify(err.response.data || {}).slice(0, 500));
    } else if (err.code === 'ECONNREFUSED') {
      console.error("❌ [returnPremierOptions] Connection refused — backend server may be down");
    } else if (err.code === 'ECONNABORTED') {
      console.error("❌ [returnPremierOptions] Request timed out — backend may be slow or unreachable");
    }
    console.error("❌ [returnPremierOptions] Backend used:", backend || 'N/A');
    console.error("❌ [returnPremierOptions] Slug attempted:", slug || 'N/A');
    await ctx.reply("A apărut o eroare la preluarea datelor de pe Premier. Verificați link-ul.");
  }
};

const returnInfoInChat = async (adData, ctx, userAdId, db) => {
  // CRASH-PROOF: Wrap entire function in try-catch to force publication
  // to complete even when unexpected errors occur
  try {
    if (!adData) return ctx.reply("Nu am putut extrage datele.");

    // ══════════════════════════════════════════════════════════════
    // ANTI-HALLUCINATION: PAGE NOT FOUND
    // ══════════════════════════════════════════════════════════════
    // Dacă scraperul a returnat { error: true, type: 'PAGE_NOT_FOUND' },
    // înseamnă că pagina e ștearsă/blocată/404. Oprim COMPLET procesarea.
    // ══════════════════════════════════════════════════════════════
    if (adData.error === true) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`❌ [LINK_ROUTER] ANUNȚ INVALID — PROCESARE OPRITĂ`);
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`  🔗 Link:     ${adData.link || 'N/A'}`);
      console.error(`  🚫 Motiv:    ${adData.reason || 'Pagină invalidă'}`);
      console.error(`  📌 Titlu:    ${adData.title || 'N/A'}`);
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');

      await ctx.reply(
        `⚠️ *Anunțul nu mai există!*\n\n` +
        `🔗 Link: ${adData.link || 'N/A'}\n` +
        `📝 Motiv: ${adData.reason || 'Pagină ștearsă sau blocată'}\n\n` +
        `❌ *Nu se poate posta* — pagina a fost ștearsă, ` +
        `blocată sau nu există.\n\n` +
        `✅ Anti-halucinare: Sistemul a detectat și oprit ` +
        `procesarea înainte de a genera date false.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("📨 [LINK ROADER] PRELUCRARE ANUNȚ");
    console.log("═══════════════════════════════════════════════════════════");

  /*─── DEBUG: Log raw images before any sanitization ────────────*/
  const rawImgCount = adData.images?.length || 0;
  console.log(`  📸 Imagini brute: ${rawImgCount}`);
  if (adData.images && adData.images.length > 0) {
    adData.images.forEach((img, i) => {
      console.log(`     ${i + 1}. ${img}`);
    });
  }

  /*─── SAFETY: sanitize all text fields before sending to Telegram ───*/
  console.log("  🔧 Sanitizare câmpuri text...");
  adData = sanitizeAdData(adData);

  /*─── SAFETY: sanitize ALL image URLs before mediaGroup ───────────
    Telegram crashes on:
      - invalid file HTTP URL specified
      - Disallowed character in URL host
    sanitizeImages() removes ALL dangerous URLs automatically.
    ──────────────────────────────────────────────────────────────*/
  console.log("  🔧 Sanitizare URL-uri imagini...");
  adData.images = sanitizeImages(adData.images);
  console.log(`  📸 Imagini după sanitizare: ${adData.images.length}`);

  /*─── WATERMARK REMOVAL ─────────────────────────────────────────
    If WATERMARK_ENABLE=true (default), automatically process all
    listing images through the PrecisionCounter API to remove visible
    watermarks/logos BEFORE sending to Telegram.

    Pipeline:
      1. Download each image URL to a temp file
      2. Call PrecisionCounter API (with retry + fallback)
      3. Save cleaned image locally
      4. Replace URLs with Telegraf-compatible InputFile references

    Graceful degradation:
      - If the API fails, the original image URL is kept
      - If the service is disabled, original URLs are used
      - Never blocks or crashes the bot
    ──────────────────────────────────────────────────────────────*/
  let wmImageInputs = null; // Array of Telegraf InputFile objects or URLs

  if (
    process.env.WATERMARK_ENABLE !== "false" &&
    Array.isArray(adData.images) &&
    adData.images.length > 0
  ) {
    try {
      console.log("  💧 [WATERMARK] Pornire pipeline eliminare watermark...");
      const pipelineResult = await processListingImages(adData.images, {
        concurrency: 3,
      });

      const hasCleaned = pipelineResult.cleanedImages.some(
        (r) => r.success && !r.fallbackUsed
      );

      if (hasCleaned) {
        wmImageInputs = pipelineResult.cleanedImages.map((result) => {
          if (result.success && result.cleanedPath && !result.fallbackUsed) {
            // Telegraf accepts { source: ReadStream } for local files
            return { source: fs.createReadStream(result.cleanedPath) };
          }
          // Fallback: keep original URL
          return result.originalUrl;
        });

        const cleanedCount = wmImageInputs.filter(
          (i) => typeof i === "object"
        ).length;
        console.log(`  💧 [WATERMARK] ${cleanedCount}/${wmImageInputs.length} imagini curățate`);
      } else {
        console.log("  💧 [WATERMARK] Nicio imagine curățată — se folosesc originalele");
      }
    } catch (wmErr) {
      // NEVER crash the bot — log and continue with original images
      console.error("  💧 [WATERMARK] Eroare pipeline:", wmErr.message);
    }
  }

  // ── DEEP CLONE: Store a copy of the data in session to prevent any
  //    cross-context mutation issues between text handler and callback
  //    query contexts. The Telegraf session middleware may persist the
  //    object reference, and any subsequent modifications to `adData`
  //    (e.g., in media group fallback) could corrupt the session copy.
  //    NOTE: session always stores original URLs, NOT InputFile objects,
  //    so platform posting (Meta/999/Premier) always gets valid URLs.
  ctx.session.data = JSON.parse(JSON.stringify(adData));
  console.log('[linkRouter] session.data stored — keys:', Object.keys(ctx.session.data).join(', '));

  // ── SET imobilType for non-Premier scrapers ───────────────────────
  //    Premier sets ctx.session.imobilType from URL before calling
  //    returnInfoInChat. For all other scrapers (999.md, immobiliare.md,
  //    loyal.md), the type is stored in adData.type in various Romanian
  //    formats. This mapping normalizes them to the English values
  //    expected by post/platforms/999.js and other post modules.
  // ──────────────────────────────────────────────────────────────────
  if (!ctx.session.imobilType && adData?.type) {
    const TYPE_MAP = {
      // 999.md scraper format
      'Apartament': 'apartments',
      'Casă': 'houses',
      'Comercial': 'commercials',
      'Teren': 'terrains',
      // immobiliare.md scraper format
      'Apartamente': 'apartments',
      'Case': 'houses',
      'Imobiliare comerciale': 'commercials',
      'Loturi de teren': 'terrains',
      // loyal.md scraper format (if applicable)
      'apartments': 'apartments',
      'houses': 'houses',
      'commercials': 'commercials',
      'terrains': 'terrains',
    };
    const mappedType = TYPE_MAP[adData.type];
    if (mappedType) {
      ctx.session.imobilType = mappedType;
      console.log('[linkRouter] imobilType set from adData.type:', adData.type, '→', mappedType);
    } else {
      // Fallback: detect from data fields
      if (adData.rooms != null) {
        ctx.session.imobilType = 'apartments';
      } else if (adData.house_type) {
        ctx.session.imobilType = 'houses';
      } else if (adData.commercial_destination) {
        ctx.session.imobilType = 'commercials';
      } else if (adData.terrain_destination) {
        ctx.session.imobilType = 'terrains';
      }
      if (ctx.session.imobilType) {
        console.log('[linkRouter] imobilType inferred from data fields:', ctx.session.imobilType);
      } else {
        console.warn('[linkRouter] ⚠️ Could not determine imobilType from adData.type:', adData.type);
      }
    }
  }

  // ── IMMEDIATE PERSIST to MongoDB: Save pendingAdData right after
  //    setting session.data. This ensures the data survives even if
  //    Telegraf's in-memory session store loses it before the text
  //    handler's own persistence code runs (index.js lines 202-217).
  //    The MongoDB copy serves as a resilience fallback for callback
  //    queries like "Post Premier" → "remove_watermark_no".
  await persistSessionDataToMongo(ctx, db);

  /*─── FAILSAFE MODE ────────────────────────────────────────────
    If after sanitization we have ZERO valid images:
      - Send a text-only fallback message
      - NEVER attempt mediaGroup with empty array
      - Bot remains stable
    ──────────────────────────────────────────────────────────────*/
  if (adData.images.length === 0) {
    const fallbackText = `📄 *Anunț (fără imagini)*\n\n${adData.description || "Descriere indisponibilă"}\n\n🔗 ${adData.link || "N/A"}`;
    await ctx.reply(fallbackText, { disable_web_page_preview: true, parse_mode: "Markdown" });
    return; // ⛔ Exit early — no mediaGroup to send
  }

  /*─── 1. Trimitem galeria — in loturi de câte 10 imagini ───
    REGULA CORECTĂ:
    1. Construim textul caption O SINGURĂ DATĂ
    2. Împărțim imaginile în batch-uri de max 10
    3. Pentru fiecare batch, construim mediaGroup MANUAL
    4. Caption doar pe ultima imagine a ULTIMULUI batch
    5. Batch-urile anterioare NU au caption
    ──────────────────────────────────────────────────────────────*/
  const telegramImages = wmImageInputs || adData.images;

  console.log("───────────────────────────────────────────────────────────");
  console.log("📤 [LINK ROADER] TRIMITERE MESAJE TELEGRAM");
  console.log("───────────────────────────────────────────────────────────");

  // Build caption text once (shared across all batches)
  const captionText = adData.link.includes("loyal.md")
    ? null // loyal.md builds its own caption inside loyalSendMessage
    : buildCaptionText(adData, ctx, userAdId);

  /*─── PRE-VALIDATION: Filter out unreachable images BEFORE sending ───
    Runs concurrent HEAD requests (5 at a time) to verify each image URL
    is reachable. Removes dead/broken images that would cause the entire
    mediaGroup to fail. The timeout is short (5s) so it won't block long.

    NOTE: watermark-cleaned images (InputFile objects) skip URL validation,
    while unprepared URLs go through the HEAD check.
    ──────────────────────────────────────────────────────────────────*/
  let imagesForSending = telegramImages;
  if (!wmImageInputs) {
    // Only pre-validate if we're sending raw URLs (not watermark-cleaned InputFiles)
    const preValidated = await filterReachableImages(telegramImages, 5);
    const removedCount = telegramImages.length - preValidated.length;
    if (removedCount > 0) {
      console.warn(`  🔍 Eliminate ${removedCount} imagini irecuperabile (URL mort) înainte de trimitere`);
    }
    imagesForSending = preValidated;
  }

  // If all images are dead, send text fallback
  if (imagesForSending.length === 0) {
    console.warn('  ⚠️ Toate imaginile sunt inaccesibile — trimitere text fallback');
    const fallbackText = `📄 *Anunț (fără imagini)*\n\n${captionText || adData.description || "Descriere indisponibilă"}\n\n🔗 ${adData.link || "N/A"}`;
    await ctx.reply(fallbackText, { disable_web_page_preview: true, parse_mode: "Markdown" });
  } else {
    // Split images into batches FIRST (max 10 per batch for Telegram)
    const imageBatches = splitIntoBatches(imagesForSending, 10);
    console.log(`  📤 Trimitere ${imageBatches.length} media group(s) pentru ${imagesForSending.length} imagini...`);

    let anyBatchFailed = false;

    for (let batchIndex = 0; batchIndex < imageBatches.length; batchIndex++) {
      const batch = imageBatches[batchIndex];
      const isLastBatch = batchIndex === imageBatches.length - 1;

      let mediaGroup;

      if (adData.link.includes("loyal.md")) {
        // loyal.md builds its own media group per batch
        mediaGroup = loyalSendMessage(adData, ctx, userAdId, batch);
      } else {
        // Build media group manually for this batch
        // Caption ONLY on last image of LAST batch
        mediaGroup = batch.map((img, index) => ({
          type: "photo",
          media: img,
          ...(isLastBatch && index === batch.length - 1
            ? { caption: captionText, parse_mode: "Markdown" }
            : {}),
        }));
      }

      console.log(`     📤 Batch ${batchIndex + 1}/${imageBatches.length} (${batch.length} imagini)${isLastBatch ? ' + caption' : ''}`);

      const batchSuccess = await sendMediaGroupWithFallback(
        ctx, mediaGroup,
        isLastBatch ? captionText : null,
        batchIndex, imageBatches.length
      );

      if (!batchSuccess) {
        anyBatchFailed = true;
      }
    }

    if (!anyBatchFailed) {
      console.log(`  ✅ ${imageBatches.length} media group(s) trimise cu succes`);
    } else {
      console.warn(`  ⚠️ Unele batch-uri au avut erori, dar imaginile valabile au fost trimise individual`);
    }
  }

  /*─── 2. Mesaj separat cu link + contact pentru loyal.md ───*/
  if (adData.link.includes("loyal.md")) {
    const contactLine = adData.contact
      ? `📞  ${adData.contact.name} — ${adData.contact.phone}`
      : "📞 *Contact:* N/A";

    await ctx.reply(
      `🔗 (${adData.link})\n${contactLine}`,
      { disable_web_page_preview: true }
    );
  } else {
    /* Pentru celelalte platforme trimitem filtrul */
    await replyWithTimeout(ctx, await sendFilter(ctx, adData), {
      disable_web_page_preview: true,
      parse_mode: "Markdown",
    }, 15000);
  }

  /*─── 3. Butoane de acțiune ───*/
  const keyboard = ctx.session.user.type === "admin"
    ? Markup.inlineKeyboard([
        Markup.button.callback("Postează",    "post_platforms"),
        Markup.button.callback("Post Premier", "post_premier"),
        Markup.button.callback("Nu posta",     "post_no"),
        Markup.button.callback("Edit",         "edit"),
      ])
    : Markup.inlineKeyboard([
        Markup.button.callback("Postează", "post_platforms"),
        Markup.button.callback("Nu posta", "post_no"),
        Markup.button.callback("Edit",     "edit"),
      ]);

  await replyWithTimeout(ctx, "Ce doriți să faceți?", keyboard, 15000);
  } catch (err) {
    // CRASH-PROOF: NEVER let returnInfoInChat throw — log error and notify user
    console.error('❌ [returnInfoInChat] CRITICAL ERROR (forțează continuarea):', err.message);
    console.error(err.stack);
    // Use replyWithTimeout to prevent the error handler itself from hanging
    await replyWithTimeout(ctx, 'A apărut o eroare neașteptată, dar procesul continuă. Verificați log-urile.', {}, 15000);
  }
};
/*───────────────────────────────────────────────────────────*/
/* Router principal                                          */
/*───────────────────────────────────────────────────────────*/

const linkRouter = async (ctx, userAdId, db) => {
  let urlObj;
  try {
    urlObj = new URL(ctx.message.text.trim());
  } catch (urlErr) {
    console.error("❌ [linkRouter] Invalid URL:", ctx.message.text, urlErr.message);
    return ctx.reply("Link-ul introdus nu este valid. Verificați formatul.");
  }
  const host   = urlObj.hostname.toLowerCase();

  console.log("🔍 [linkRouter] Domain detectat:", host);

  try {
    if (["999.md", "m.999.md"].includes(host)) {
      const adData = await scrap_999(ctx, ctx.message.text.trim());
      return returnInfoInChat(adData, ctx, userAdId, db);

    } else if (host === "premierimobil.md") {
      const adData = await scrap_premier(ctx, ctx.message.text.trim());
      if (!adData) {
        return ctx.reply("A apărut o eroare la preluarea datelor de pe Premier Imobil. Verificați link-ul.");
      }
      // Set imobilType din datele extrase pentru butonul "Post Premier"
      const typeMap = {
        "Toate apartamentele": "apartments",
        "Apartament":          "apartments",
        "Apartamente":         "apartments",
        "Case":                "houses",
        "Casă":                "houses",
        "houses":              "houses",
        "Imobiliare comerciale": "commercials",
        "Comercial":           "commercials",
        "commercials":         "commercials",
        "Loturi de teren":     "terrains",
        "Teren":               "terrains",
        "terrains":            "terrains",
      };
      ctx.session.imobilType = typeMap[adData.type] || adData.type;
      // Store in session for "Post Premier" button compatibility
      ctx.session.data = adData;
      return returnInfoInChat(adData, ctx, userAdId, db);

    } else if (host === "immobiliare.md") {
      const adData = await scrap_immobiliare(ctx, ctx.message.text.trim());
      return returnInfoInChat(adData, ctx, userAdId, db);

    } else if (host === "loyal.md") {
      const adData = await parseLoyal(ctx.message.text.trim());
      return returnInfoInChat(adData, ctx, userAdId, db);

    } else if (host === "mirax.md") {
      return ctx.reply("Parser Mirax.md nu este încă disponibil.");

    } else {
      return ctx.reply("Acest site nu este suportat momentan.");
    }
  } catch (scrapeErr) {
    console.error("❌ [linkRouter] Scraper error for host:", host, scrapeErr.message);
    console.error(scrapeErr.stack);
    await ctx.reply("A apărut o eroare la preluarea anunțului. Verificați link-ul și încercați din nou.");
  }
};

module.exports = { linkRouter, persistSessionDataToMongo };


