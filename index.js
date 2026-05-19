const { Telegraf, session, Markup } = require("telegraf");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const { linkRouter } = require("./webscrape/linkRouter");
const { postRouter } = require("./post/postRouter");
const { sendMessage, buildCaptionText } = require("./utils/message_main");
const { getDescription } = require("./bot_actions/bot_redact");
const { removeWatermark } = require("./WaterMark-services/dewatermarking");
const axios = require("axios");
const sharp = require("sharp");
const { postToPremier } = require("./post/platforms/premier");
const { parseLoyal } = require('./webscrape/websites/loyal');
const { normalizeUrl, safeUrl } = require("./utils/telegramMediaSafe");

/* ════════════════════════════════════════════════════════════════
   RESILIENCE SYSTEM — Initialization
   ════════════════════════════════════════════════════════════════ */

const logger           = require("./logger");
const watchdog          = require("./watchdog");
const memoryMonitor     = require("./memory-monitor");
const recoveryManager   = require("./recovery");
const { startHealthServer, updateHealthState } = require("./healthcheck");

const client = new MongoClient(process.env.MONGO_URL, {
  tls: true,
  tlsInsecure: true,
  serverSelectionTimeoutMS: 15000,
});
let db;
const bot = new Telegraf(process.env.BOT_ID);

let healthServer = null;

/* ════════════════════════════════════════════════════════════════
   GLOBAL ERROR HANDLERS  (RESILIENT — NO CRASH)
   NEVER exit the process — just log and continue
   ════════════════════════════════════════════════════════════════ */
process.on("unhandledRejection", (reason, promise) => {
  logger.error("GENERAL", "❌ GLOBAL: Unhandled Rejection (process continues)", {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });
  // ❌ NU face process.exit() — procesul continuă
});

process.on("uncaughtException", (error) => {
  logger.error("GENERAL", "❌ GLOBAL: Uncaught Exception (process continues)", {
    error: error.message,
    stack: error.stack,
  });
  // ❌ NU face process.exit() — procesul continuă
});

/* ════════════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN  —  SIGTERM / SIGINT
   ════════════════════════════════════════════════════════════════ */
async function gracefulShutdown(signal) {
  logger.restart(`Received ${signal} — starting graceful shutdown`);

  // Stop monitoring systems
  watchdog.stop();
  memoryMonitor.stop();

  // Save recovery state
  recoveryManager.recordRestart(`${signal} graceful shutdown`);

  // Stop the bot
  try {
    await bot.stop();
    logger.restart("Bot stopped gracefully");
  } catch (err) {
    logger.error("RESTART", "Error stopping bot", { error: err.message });
  }

  // Close MongoDB connection
  try {
    await client.close();
    logger.restart("MongoDB connection closed");
  } catch (err) {
    logger.error("RESTART", "Error closing MongoDB", { error: err.message });
  }

  logger.restart("Graceful shutdown complete");

  // Exit after a small delay
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/* ════════════════════════════════════════════════════════════════
   APPLICATION BOOT
   ════════════════════════════════════════════════════════════════ */

logger.info("GENERAL", "🚀 Bot starting...", {
  pid: process.pid,
  nodeVersion: process.version,
  platform: process.platform,
});

// Initialize recovery state
const hadRecoveryState = recoveryManager.init();
if (hadRecoveryState) {
  logger.recovery("Bot previously crashed — recovery state found");
  recoveryManager.recordRestart("Auto-recovery after crash");
}

// Start healthcheck server (Nivelul 3)
healthServer = startHealthServer();
updateHealthState({ status: "starting", pid: process.pid });

// Start watchdog (Nivelul 3)
watchdog.start();

// Start memory monitor (Nivelul 4)
memoryMonitor.start();

bot.use(session());
let userAdId;

async function initMongo() {
  try {
    await client.connect();
    db = client.db("users");
    logger.info("GENERAL", "Connected to MongoDB");
  } catch (error) {
    logger.error("GENERAL", "MongoDB connection error", { error: error.message });
  }
}

const checkUser = async (ctx, next) => {
  try {
    // Record bot activity for watchdog
    watchdog.recordActivity();

    if (!ctx.session) ctx.session = {};

    await initMongo();
    const user = await db
      .collection("users")
      .findOne({ telegramChatID: ctx.chat.id.toString() });

    if (!user) {
      return ctx.reply("Utilizatorul nu a fost gasit, inregistrati-va.");
    } else {
      ctx.session.user = user;
      return next();
    }
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in checkUser middleware", { error: error.message });
    await ctx.reply("A avut loc o eroare la extragerea utilizatorului");
  }
};

bot.start(checkUser, async (ctx) => {
  watchdog.recordActivity();
  await ctx.reply(
    `Bine ați venit! ${ctx.session.user.name}. Alegeți acțiunea:`,
    Markup.keyboard([["Adauga o postare"]]).resize()
  );
});

bot.hears("Adauga o postare", async (ctx) => {
  watchdog.recordActivity();
  await ctx.reply(
    "Introduce-ti link-ul cu anuntul in formatul https://999.md/ro/numar:"
  );
});

bot.on("text", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const verificationMessage = await ctx.reply("Ma duc pana pe 999.md, sa va aduc anuntul!! 😃 in cateva sec.");
    if (!ctx.session) ctx.session = {};
    userAdId =
      ctx.session.user.initials +
      Math.floor(10000 + Math.random() * 90000).toString();

    // Record scrape activity for watchdog
    watchdog.recordScrapeActivity();

    const startTime = Date.now();

    // ── WRAP linkRouter execution ──
    // linkRouter now also receives `db` to persist session.data to MongoDB
    // IMMEDIATELY when it's stored (inside returnInfoInChat). This is the
    // PRIMARY persistence layer. The code below is a SECONDARY backup.
    await linkRouter(ctx, userAdId, db);

    // ── BACKUP PERSIST: session.data → MongoDB ──
    // This is a secondary safety net in case the primary persistence inside
    // returnInfoInChat/linkRouter did not have a valid `db` reference.
    if (ctx.session.data && typeof ctx.session.data === 'object' && Object.keys(ctx.session.data).length > 0) {
      try {
        await db.collection("users").updateOne(
          { telegramChatID: ctx.chat.id.toString() },
          { $set: { pendingAdData: JSON.parse(JSON.stringify(ctx.session.data)) } }
        );
        console.log('[PERSIST BACKUP] session.data saved to MongoDB for user', ctx.chat.id);
      } catch (persistErr) {
        console.error('[PERSIST BACKUP] Failed to save session.data to MongoDB:', persistErr.message);
        // Non-blocking: continue even if persistence fails
      }
    }

    // Record response time
    watchdog.recordResponseTime(Date.now() - startTime);

    setTimeout(() => {
      ctx.deleteMessage(verificationMessage.message_id).catch((err) => logger.error("GENERAL", "Error deleting verification message", { error: err.message }));
    }, 300);
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in text handler", { error: error.message, stack: error.stack });
    ctx.reply("Mai trimiteti inca o data anuntul... verificati daca ati copiat corect");
  }
});

bot.action("post_premier", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    logger.info("GENERAL", "Post to Premier action triggered");

    // ── PERSIST session.data to MongoDB before asking watermark question ──
    // CRITICAL: Telegraf's in-memory session store loses session.data between
    // the text handler (where scraped data is stored) and the watermark answer
    // callback (remove_watermark_yes/no). This persist bridges that gap.
    // Without this, session.data is already gone by the time the user answers.
    if (ctx.session?.data && typeof ctx.session.data === 'object' && Object.keys(ctx.session.data).length > 0) {
      try {
        await db.collection("users").updateOne(
          { telegramChatID: ctx.chat.id.toString() },
          { $set: { pendingAdData: JSON.parse(JSON.stringify(ctx.session.data)) } }
        );
        console.log('[POST_PREMIER] ✅ session.data persisted to MongoDB for watermark flow');
      } catch (persistErr) {
        console.error('[POST_PREMIER] ❌ Failed to persist session.data:', persistErr.message);
      }
    } else {
      console.warn('[POST_PREMIER] ⚠️ session.data already empty at post_premier stage — relying on earlier persist from linkRouter');
    }

    // Ask user if they want to remove the watermark
    await ctx.editMessageText(
      "Scoatem watermarkul?",
      Markup.inlineKeyboard([
        Markup.button.callback("Da", "remove_watermark_yes"),
        Markup.button.callback("Nu", "remove_watermark_no"),
      ])
    );
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in post_premier action", { error: error.message });
  }
});

/**
 * restoreSessionDataFromMongo(ctx, db)
 *
 * Attempts to restore ctx.session.data from MongoDB (pendingAdData field)
 * when the in-memory session has lost it. This is a resilience mechanism
 * for Telegraf's unreliable in-memory session store.
 *
 * Enhanced logging:
 *   - Logs whether the user document was found in MongoDB
 *   - Logs whether pendingAdData exists and its type/size
 *   - Logs the exact reason when restore fails
 *
 * @param {Object} ctx - Telegraf context
 * @param {Object} db  - MongoDB database instance
 * @returns {boolean}  - true if data was restored, false otherwise
 */
async function restoreSessionDataFromMongo(ctx, db) {
  try {
    // ── DIAGNOSTIC: Check if db is available ──
    if (!db) {
      console.error('[RESTORE] ❌ db is null/undefined — cannot query MongoDB');
      return false;
    }

    const userIdStr = ctx.chat?.id?.toString() || 'unknown';
    console.log('[RESTORE] 🔍 Looking up pendingAdData for user:', userIdStr);

    const user = await db.collection("users").findOne(
      { telegramChatID: userIdStr },
      { projection: { pendingAdData: 1, telegramChatID: 1 } }
    );

    // ── DIAGNOSTIC: Log DB lookup result ──
    if (!user) {
      console.warn('[RESTORE] ❌ User document NOT FOUND in MongoDB for telegramChatID:', userIdStr);
      return false;
    }
    console.log('[RESTORE] ✅ User document found in MongoDB');

    const hasPendingData = user.pendingAdData !== undefined && user.pendingAdData !== null;
    console.log('[RESTORE] pendingAdData exists:', hasPendingData);
    if (hasPendingData) {
      const dataType = typeof user.pendingAdData;
      const dataKeys = dataType === 'object' ? Object.keys(user.pendingAdData).join(', ') : 'N/A (not an object)';
      const dataLength = dataType === 'object' ? Object.keys(user.pendingAdData).length : 'N/A';
      console.log('[RESTORE] pendingAdData type:', dataType, '| keys count:', dataLength, '| keys:', dataKeys);
    }

    if (user?.pendingAdData && typeof user.pendingAdData === 'object' && Object.keys(user.pendingAdData).length > 0) {
      ctx.session.data = JSON.parse(JSON.stringify(user.pendingAdData));
      console.log('[RESTORE] ✅ session.data restored from MongoDB for user', userIdStr);
      console.log('[RESTORE] Restored data keys:', Object.keys(ctx.session.data).join(', '));
      return true;
    }

    console.warn('[RESTORE] ❌ pendingAdData missing or empty — cannot restore');
    return false;
  } catch (err) {
    console.error('[RESTORE] ❌ Error restoring session.data from MongoDB:', err.message);
    console.error('[RESTORE] Stack:', err.stack);
    return false;
  }
}

// Handle Yes/No response for watermark removal
bot.action("remove_watermark_yes", checkUser, async (ctx) => {
  try {
    ctx.editMessageText("Postare in executie dureza pana la 5 sec....");

    // ── DIAGNOSTIC: Log session data state before posting ──
    console.log('[remove_watermark_yes] session keys:', Object.keys(ctx.session));
    console.log('[remove_watermark_yes] session.data type:', typeof ctx.session.data);
    console.log('[remove_watermark_yes] session.data keys:', ctx.session.data ? Object.keys(ctx.session.data) : 'NO DATA');

    // ── RESILIENCE: Try to restore from MongoDB if session.data is lost ──
    if (!ctx.session.data || typeof ctx.session.data !== 'object' || Object.keys(ctx.session.data).length === 0) {
      console.warn('⚠️ [remove_watermark_yes] session.data is empty — attempting MongoDB restore...');
      const restored = await restoreSessionDataFromMongo(ctx, db);
      if (!restored) {
        console.error('❌ [remove_watermark_yes] session.data empty AND MongoDB restore failed — aborting');
        return ctx.reply('Eroare: datele anunțului s-au pierdut. Trimiteți din nou link-ul.');
      }
    }

    ctx.session.removeWatermark = true;

    // ── CLEAN UP: Remove pendingAdData from MongoDB after successful restore ──
    try {
      await db.collection("users").updateOne(
        { telegramChatID: ctx.chat.id.toString() },
        { $unset: { pendingAdData: "" } }
      );
    } catch (cleanupErr) {
      console.error('[CLEANUP] Failed to remove pendingAdData:', cleanupErr.message);
      // Non-blocking
    }

    await postToPremier(ctx.session.data, ctx, true);
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in remove_watermark_yes action", { error: error.message });
    await ctx.reply("A apărut o eroare la postare. Încercați din nou.");
  }
});

bot.action("remove_watermark_no", checkUser, async (ctx) => {
  try {
    ctx.editMessageText("Se incarca imaginile pe Premierimobil.md va dura pana la 5-6 sec...");

    // ── DIAGNOSTIC: Log session data state before posting ──
    console.log('[remove_watermark_no] session keys:', Object.keys(ctx.session));
    console.log('[remove_watermark_no] session.data type:', typeof ctx.session.data);
    console.log('[remove_watermark_no] session.data keys:', ctx.session.data ? Object.keys(ctx.session.data) : 'NO DATA');

    // ── RESILIENCE: Try to restore from MongoDB if session.data is lost ──
    if (!ctx.session.data || typeof ctx.session.data !== 'object' || Object.keys(ctx.session.data).length === 0) {
      console.warn('⚠️ [remove_watermark_no] session.data is empty — attempting MongoDB restore...');
      const restored = await restoreSessionDataFromMongo(ctx, db);
      if (!restored) {
        console.error('❌ [remove_watermark_no] session.data empty AND MongoDB restore failed — aborting');
        return ctx.reply('Eroare: datele anunțului s-au pierdut. Trimiteți din nou link-ul.');
      }
    }

    ctx.session.removeWatermark = false;

    // ── CLEAN UP: Remove pendingAdData from MongoDB after successful restore ──
    try {
      await db.collection("users").updateOne(
        { telegramChatID: ctx.chat.id.toString() },
        { $unset: { pendingAdData: "" } }
      );
    } catch (cleanupErr) {
      console.error('[CLEANUP] Failed to remove pendingAdData:', cleanupErr.message);
      // Non-blocking
    }

    await postToPremier(ctx.session.data, ctx, false);
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in remove_watermark_no action", { error: error.message });
    await ctx.reply("A apărut o eroare la postare. Încercați din nou.");
  }
});

//redundant///////
bot.action("post_platforms", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const agents = await db
      .collection("users")
      .find({ token_999: { $exists: true, $ne: "" } })
      .toArray();
    if (agents.length === 0)
      return ctx.reply("Nu sunt agenti valabili pentru alegere.");

    const buttons = agents.map((agent) =>
      Markup.button.callback(agent.name, `select_agent_${agent._id}`)
    );
    const buttonRows = [];
    for (let i = 0; i < buttons.length; i += 2)
      buttonRows.push(buttons.slice(i, i + 2));

    await ctx.editMessageText(
      "Din numele cui sa fie postarea?",
      Markup.inlineKeyboard(buttonRows)
    );
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error selecting agent", { error: error.message });
    ctx.reply("A avut loc o eroare la alegerea agentului.");
  }
});

bot.action(/^select_agent_(.*)$/, checkUser, async (ctx) => {
  const agentId = ctx.match[1];
  const agent = await db
    .collection("users")
    .findOne({ _id: new ObjectId(agentId) });
  if (!agent) return ctx.reply("Agentul nu a fost gasit.");

  ctx.session.selectedAgent = agent;
  ctx.session.selectedPlatforms = [];

  const platformButtons = [
    { name: "FB/Inst", value: "meta" },
    { name: "999.md", value: "999" },
    { name: "Premier", value: "premier" },
  ].map((platform) =>
    Markup.button.callback(
      `${
        ctx.session.selectedPlatforms.includes(platform.value) ? "✅" : "➕"
      } ${platform.name}`,
      `select_platform_${platform.value}`
    )
  );

  const buttonRows = [];
  for (let i = 0; i < platformButtons.length; i += 2)
    buttonRows.push(platformButtons.slice(i, i + 2));
  buttonRows.push([Markup.button.callback("Confirmare", "confirm_platforms")]);

  await ctx.editMessageText(
    "Alege-ti platformele pentru publicare:",
    Markup.inlineKeyboard(buttonRows)
  );
});

bot.action(/^select_platform_(.*)$/, checkUser, async (ctx) => {
  const platform = ctx.match[1];
  // CRASH-PROOF: Initialize if undefined (session expiry or race condition)
  ctx.session.selectedPlatforms = ctx.session.selectedPlatforms || [];
  ctx.session.selectedPlatforms = ctx.session.selectedPlatforms.includes(
    platform
  )
    ? ctx.session.selectedPlatforms.filter((p) => p !== platform)
    : [...ctx.session.selectedPlatforms, platform];

  const platformButtons = [
    { name: "FB/Inst", value: "meta" },
    { name: "999.md", value: "999" },
    { name: "Premier", value: "premier" },
  ].map((platform) =>
    Markup.button.callback(
      `${
        ctx.session.selectedPlatforms.includes(platform.value) ? "✅" : "➕"
      } ${platform.name}`,
      `select_platform_${platform.value}`
    )
  );

  const buttonRows = [];
  for (let i = 0; i < platformButtons.length; i += 2)
    buttonRows.push(platformButtons.slice(i, i + 2));
  buttonRows.push([Markup.button.callback("Confirmare", "confirm_platforms")]);

  await ctx.editMessageText(
    "Alege-ti platformele pentru publicare:",
    Markup.inlineKeyboard(buttonRows)
  );
});

bot.action("confirm_platforms", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const selected = ctx.session.selectedPlatforms || [];
    if (selected.length === 0) {
      return ctx.editMessageText("Nicio platformă selectată. Alegeți cel puțin una.");
    }

    logger.info("GENERAL", "Platforms selected, asking about watermark", { platforms: selected });

    // Ask about watermark removal BEFORE posting
    await ctx.editMessageText(
      "Scoatem watermarkul de pe toate pozele?",
      Markup.inlineKeyboard([
        Markup.button.callback("Da", "watermark_yes_post"),
        Markup.button.callback("Nu", "watermark_no_post"),
      ])
    );
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in confirm_platforms", { error: error.message });
    ctx.reply("A avut loc o eroare la pregătirea publicării.");
  }
});

// Handle watermark answer — Da — then post to all selected platforms
bot.action("watermark_yes_post", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    ctx.session.removeWatermark = true;
    await ctx.editMessageText("Postare în execuție cu eliminare watermark...");
    logger.info("GENERAL", "Posting with watermark removal", { platforms: ctx.session.selectedPlatforms });
    await postRouter(ctx);
    ctx.session.selectedPlatforms = [];
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in watermark_yes_post", { error: error.message });
    ctx.reply("A avut loc o eroare la publicare.");
  }
});

// Handle watermark answer — Nu — then post to all selected platforms
bot.action("watermark_no_post", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    ctx.session.removeWatermark = false;
    await ctx.editMessageText("Postare în execuție...");
    logger.info("GENERAL", "Posting without watermark removal", { platforms: ctx.session.selectedPlatforms });
    await postRouter(ctx);
    ctx.session.selectedPlatforms = [];
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in watermark_no_post", { error: error.message });
    ctx.reply("A avut loc o eroare la publicare.");
  }
});
//redundant-end////////

bot.action("post_no", async (ctx) => {
  await ctx.editMessageText("Publicare intrerupta.");
});

bot.action("edit", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    logger.info("GENERAL", "Edit action triggered");

    const redactedDesc = await getDescription(ctx.session.data);
    const imageUrls = ctx.session.data.images || [];

    // ── PARALLEL PIPELINE: download + watermark removal ──
    // REPLACED: old sequential Puppeteer loop with parallel pipeline.
    // Uses: axios download (NO Puppeteer), p-limit concurrency, retry logic.
    const { downloadImagesParallel, cleanupBuffers } = require("./services/imageDownloader");

    // Normalize URLs
    const normalizedUrls = imageUrls
      .map((url) => safeUrl(normalizeUrl(url)))
      .filter(Boolean);

    if (normalizedUrls.length === 0) {
      logger.error("GENERAL", "No valid image URLs for edit");
      return ctx.reply("Nu s-au găsit imagini valide pentru editare.");
    }

    // Step 1: Download all images IN PARALLEL (NO Puppeteer)
    console.log(`[edit] Downloading ${normalizedUrls.length} images in parallel...`);
    const downloadResults = await downloadImagesParallel(normalizedUrls, {
      concurrency: 5,
      timeout: 30000,
      maxRetries: 3,
    });

    const successfulDownloads = downloadResults.filter((r) => r.success);

    // Step 2: Process watermarks in parallel
    const { default: pLimit } = await import("p-limit");
    const watermarkLimit = pLimit(3);
    const dewatermarkedImages = [];

    const watermarkTasks = successfulDownloads.map((download) =>
      watermarkLimit(async () => {
        try {
          const dewatermarkResult = await removeWatermark(download.buffer);
          if (dewatermarkResult.success && dewatermarkResult.buffer) {
            const jpgBuffer = await sharp(dewatermarkResult.buffer).jpeg().toBuffer();
            return jpgBuffer;
          }
          // Fallback to original
          console.warn("[edit] ⚠️ Watermark removal failed, using original");
          return await sharp(download.buffer).jpeg().toBuffer();
        } catch (err) {
          console.error("[edit] ❌ Watermark exception, using original:", err.message);
          try {
            return await sharp(download.buffer).jpeg().toBuffer();
          } catch {
            return null;
          }
        }
      })
    );

    const results = await Promise.allSettled(watermarkTasks);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        dewatermarkedImages.push(r.value);
      }
    }

    // Cleanup download buffers
    cleanupBuffers(downloadResults);

    console.log(`[edit] Processed ${dewatermarkedImages.length} images for editing`);

    // Build caption text ONCE
    const editCaptionText = buildCaptionText(ctx.session.data, ctx, userAdId, redactedDesc);

    // Split dewatermarked buffers into batches of 10 FIRST
    const editBatches = [];
    for (let i = 0; i < dewatermarkedImages.length; i += 10) {
      editBatches.push(dewatermarkedImages.slice(i, i + 10));
    }

    console.log(`[edit] Sending ${editBatches.length} batch(es) of edited images...`);

    // Send each batch — caption ONLY on last image of LAST batch
    for (let batchIdx = 0; batchIdx < editBatches.length; batchIdx++) {
      const batch = editBatches[batchIdx];
      const isLastBatch = batchIdx === editBatches.length - 1;

      const mediaGroup = batch.map((imgBuffer, imgIdx) => ({
        type: "photo",
        media: { source: imgBuffer },
        ...(isLastBatch && imgIdx === batch.length - 1
          ? { caption: editCaptionText, parse_mode: "Markdown" }
          : {}),
      }));

      await ctx.replyWithMediaGroup(mediaGroup);
    }
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error during image processing", { error: error.message });
    await ctx.reply("Something went wrong while processing the images.");
  }
});

/* ════════════════════════════════════════════════════════════════
   BOT LAUNCH
   ════════════════════════════════════════════════════════════════ */

bot.launch({ dropPendingUpdates: true })
  .then(() => {
    const now = Date.now();
    logger.info("GENERAL", "✅ Bot launched successfully!");

    // Mark as running for healthcheck
    updateHealthState({
      status: "running",
      launchedAt: new Date().toISOString(),
      botUptime: 0,
    });

    // Clear recovery state after successful launch
    setTimeout(() => {
      recoveryManager.clearState();
    }, 10000); // Wait 10s to ensure stability
  })
  .catch((err) => {
    logger.fatal("GENERAL", "❌ Bot failed to launch!", { error: err.message, stack: err.stack });
    logger.restart("Bot launch failed — forcing restart");
    setTimeout(() => process.exit(1), 2000);
  });

/* ════════════════════════════════════════════════════════════════
   HEALTHCHECK STATUS UPDATE (every 30s)
   ════════════════════════════════════════════════════════════════ */
setInterval(() => {
  const watchdogStatus = watchdog.getStatus();
  const memoryStatus = memoryMonitor.getStatus();

  updateHealthState({
    watchdog: watchdogStatus,
    memory: memoryStatus,
    processUptime: process.uptime(),
  });
}, 30000).unref();
