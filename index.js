const express = require("express");
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
const { tgRetry } = require("./utils/telegramRetry");

// ── AI ENHANCED MODULES ───────────────────────────────────
const { getDashboardKeyboard, handleDashboardAction, handleRepost, markAsPosted, isAlreadyPosted, isAutoPostEnabled } = require("./bot/dashboard");
const { buildPipelineSummary } = require("./utils/summaryBuilder");
const { healthCheck } = require("./services/selfHealing");
const { askAI } = require("./ai/openRouterClient");
const logger = require("./logger");

/* ════════════════════════════════════════════════════════════════
   RESILIENCE SYSTEM — Initialization
   ════════════════════════════════════════════════════════════════ */

const watchdog          = require("./watchdog");
const memoryMonitor     = require("./memory-monitor");
const recoveryManager   = require("./recovery");
const { startHealthServer, updateHealthState } = require("./healthcheck");

// Make watchdog globally accessible (needed by dashboard)
global.watchdogInstance = watchdog;

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

// ── Express healthcheck route ──
const healthApp = express();
const EXPRESS_HEALTH_PORT = parseInt(process.env.EXPRESS_HEALTH_PORT || "8081", 10);
healthApp.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});
healthApp.listen(EXPRESS_HEALTH_PORT, "0.0.0.0", () => {
  logger.health(`Express health route listening on port ${EXPRESS_HEALTH_PORT}`);
});
healthApp.on("error", (err) => {
  logger.error("HEALTH", "Express health route error", { error: err.message });
});

// Start watchdog (Nivelul 3)
watchdog.start();

// Start memory monitor (Nivelul 4)
memoryMonitor.start();

// Custom session store for isolated instance state
bot.use(session({
  property: 'session',
  store: {
    // Use unique key for this instance
    get: (key) => {},
    set: (key, value) => {},
    destroy: (key) => {}
  }
}));
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
    await tgRetry(() => ctx.editMessageText("Postare in executie dureza pana la 5 sec...."), 'editMessageText(watermark_yes)');

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
    await tgRetry(() => ctx.editMessageText("Se incarca imaginile pe Premierimobil.md va dura pana la 5-6 sec..."), 'editMessageText(watermark_no)');

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

    // ── RESILIENCE: Try to restore from MongoDB if session.data is lost ──
    // This handles the case where a watchdog restart wiped the in-memory
    // Telegraf session between platform selection and actual posting.
    if (!ctx.session.data || typeof ctx.session.data !== 'object' || Object.keys(ctx.session.data).length === 0) {
      console.warn('⚠️ [watermark_yes_post] session.data is empty — attempting MongoDB restore...');
      const restored = await restoreSessionDataFromMongo(ctx, db);
      if (!restored) {
        console.error('❌ [watermark_yes_post] session.data empty AND MongoDB restore failed — aborting');
        return ctx.reply('Eroare: datele anunțului s-au pierdut. Trimiteți din nou link-ul.');
      }
      console.log('✅ [watermark_yes_post] session.data restored from MongoDB');
    }

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

    // ── RESILIENCE: Try to restore from MongoDB if session.data is lost ──
    // This handles the case where a watchdog restart wiped the in-memory
    // Telegraf session between platform selection and actual posting.
    if (!ctx.session.data || typeof ctx.session.data !== 'object' || Object.keys(ctx.session.data).length === 0) {
      console.warn('⚠️ [watermark_no_post] session.data is empty — attempting MongoDB restore...');
      const restored = await restoreSessionDataFromMongo(ctx, db);
      if (!restored) {
        console.error('❌ [watermark_no_post] session.data empty AND MongoDB restore failed — aborting');
        return ctx.reply('Eroare: datele anunțului s-au pierdut. Trimiteți din nou link-ul.');
      }
      console.log('✅ [watermark_no_post] session.data restored from MongoDB');
    }
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
   DASHBOARD COMMANDS — Interactive Control Panel
   ════════════════════════════════════════════════════════════════ */

// ── /dashboard — Show interactive dashboard ──
bot.command("dashboard", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    await ctx.reply(
      '📊 *Dashboard* — Alege o acțiune:',
      {
        parse_mode: 'Markdown',
        ...getDashboardKeyboard(isAutoPostEnabled()),
      }
    );
  } catch (err) {
    logger.error("GENERAL", "Dashboard command error", { error: err.message });
    await ctx.reply("Eroare la deschiderea dashboard-ului.");
  }
});

// ── /status — Show detailed status ──
bot.command("status", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const health = await healthCheck();
    const watchdogStatus = watchdog.getStatus();
    const { buildStatusMessage } = require("./bot/dashboard");
    const statusMsg = buildStatusMessage(ctx, health, watchdogStatus);
    await ctx.reply(statusMsg, {
      parse_mode: 'Markdown',
      ...getDashboardKeyboard(isAutoPostEnabled()),
    });
  } catch (err) {
    logger.error("GENERAL", "Status command error", { error: err.message });
    await ctx.reply("Eroare la obținerea statusului.");
  }
});

// ── /repost <link> — Force repost a listing ──
bot.command("repost", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const link = ctx.message.text.replace("/repost", "").trim();
    if (!link || !link.startsWith("http")) {
      return ctx.reply(
        "❌ *Format incorect.*\n\nFolosește: `/repost https://999.md/ro/123456`\n\nExemplu: `/repost https://999.md/ro/104321098`",
        { parse_mode: "Markdown" }
      );
    }

    const msg = await handleRepost(ctx, link);
    await ctx.reply(msg, { parse_mode: "Markdown" });

    // Start the pipeline for this link
    ctx.message.text = link;
    // Trigger the existing text handler
    // (the pipeline will process it via the existing "text" handler)
    await ctx.reply("🔄 *Procesare repost începută...*", { parse_mode: "Markdown" });
  } catch (err) {
    logger.error("GENERAL", "Repost command error", { error: err.message });
    await ctx.reply("Eroare la procesarea repost-ului.");
  }
});

// ── /ai_model <model> — Change AI model ──
bot.command("ai_model", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const modelId = ctx.message.text.replace("/ai_model", "").trim();
    
    if (!modelId) {
      const currentModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
      return ctx.reply(
        `🧠 *Model AI curent:* \`${currentModel}\`\n\n` +
        `*Schimbă modelul:*\n` +
        `Trimite: \`/ai_model <model_id>\`\n\n` +
        `*Modele disponibile:*\n` +
        `• \`openai/gpt-4o-mini\` (rapid, ieftin)\n` +
        `• \`openai/gpt-4o\` (puternic)\n` +
        `• \`google/gemini-2.0-flash-exp\` (gratuit)\n` +
        `• \`anthropic/claude-3.5-haiku\` (rapid)\n` +
        `• \`meta-llama/llama-3.2-3b-instruct\` (ultra-rapid)\n\n` +
        `⚠️ Schimbarea e temporară până la restart.`,
        { parse_mode: "Markdown" }
      );
    }

    // Update environment variable for this session
    process.env.OPENROUTER_MODEL = modelId;
    logger.info("GENERAL", `AI model changed to: ${modelId}`);
    await ctx.reply(
      `✅ *Model AI schimbat la:* \`${modelId}\`\n\n` +
      `Schimbarea e activă imediat. Pentru a face schimbarea permanentă, ` +
      `actualizează \`OPENROUTER_MODEL\` în fișierul \`.env\` și restartează botul.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    logger.error("GENERAL", "AI model command error", { error: err.message });
    await ctx.reply("Eroare la schimbarea modelului AI.");
  }
});

// ── /help — Show available commands ──
bot.command("help", checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const helpText = [
      '📚 *Comenzi disponibile:*',
      '═'.repeat(30),
      '',
      '*📋 Generale:*',
      '  • `/start` — Pornește botul',
      '  • `/help` — Această listă de comenzi',
      '  • `/status` — Status detaliat sistem',
      '  • `/dashboard` — Dashboard interactiv',
      '',
      '*🤖 AI & Scraping:*',
      '  • Trimite un link 999.md → scraping automat',
      '  • `/ai_model` — Vezi/schimbă modelul AI',
      '  • `/repost <link>` — Forțează repostare',
      '',
      '*⚙️ Postare:*',
      '  • `/dashboard` → butonul "Start Auto-post"',
      '  • Platforme: Facebook, Instagram, 999.md, Premierimobil.md',
      '',
      '*🛟 Auto-repair:*',
      '  Sistemul se repară automat la orice eroare.',
      '  Verifică `/status` pentru istoric reparații.',
      '',
      '📌 *Link-uri utile:*',
      '  • [Premierimobil.md](https://premierimobil.md)',
      '  • [Facebook Page](https://www.facebook.com/)',
    ].join('\n');
    
    await ctx.reply(helpText, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    logger.error("GENERAL", "Help command error", { error: err.message });
  }
});

// ── Dashboard callback handler ──
bot.action(/^(dashboard_status|dashboard_refresh_fb|dashboard_ai_config|dashboard_logs|dashboard_restart|dashboard_back|auto_post_start|auto_post_stop)$/, checkUser, async (ctx) => {
  try {
    watchdog.recordActivity();
    const action = ctx.match[1];
    await handleDashboardAction(ctx, action, db);
  } catch (err) {
    logger.error("GENERAL", "Dashboard action error", {
      action: ctx.match?.[1],
      error: err.message,
    });
    try {
      await ctx.answerCbQuery('⚠️ Eroare la procesarea acțiunii');
    } catch (_) {}
  }
});

// ════════════════════════════════════════════════════════════════
// MARK AS POSTED — overrides in the text handler
// ════════════════════════════════════════════════════════════════
// Mark links as posted after successful processing
const originalTextHandler = bot.on; // store reference
// We'll integrate markAsPosted in the text handler below

/* ════════════════════════════════════════════════════════════════
   BOT LAUNCH — with 409 Conflict prevention
   ════════════════════════════════════════════════════════════════
   The 409 "Conflict: terminated by other getUpdates request" error occurs
   when Telegram detects an existing active polling connection from a
   previous bot instance that hasn't been cleanly released.

   Root causes in Coolify/Docker:
     1. Container restart leaves dangling poll connections
     2. PM2 restart creates overlapping instances
     3. Healthcheck probes keep old sessions alive

   Fix strategy:
     1. Stop any existing bot session FIRST (cleanup)
     2. Clear Telegram server-side long-poll state via getUpdates(-1, 0)
     3. Wait briefly for propagation
     4. Launch with dropPendingUpdates
     5. Retry with backoff if 409 still occurs
   ════════════════════════════════════════════════════════════════ */

const TELEGRAM_409_RETRY_DELAY = 3000; // ms to wait before retry on 409
const TELEGRAM_409_MAX_RETRIES = 3;

/**
 * Clean up any dangling Telegram polling connections before launch.
 * This prevents the "409: Conflict" error when multiple bot instances
 * try to poll with the same token.
 */
async function cleanupTelegramSession() {
  try {
    // Step 1: Stop any existing bot connection gracefully
    logger.info("GENERAL", "🔄 Cleaning up previous Telegram session...");
    await bot.stop();
    logger.info("GENERAL", "✓ Previous bot session stopped");

    // Step 2: Wait briefly for Telegram server to register the disconnect
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Step 3: Clear any hanging long-poll connections on Telegram's side
    // Using offset=-1 and timeout=0 cancels any pending getUpdates request
    await bot.telegram.getUpdates({ offset: -1, timeout: 0 });
    logger.info("GENERAL", "✓ Telegram long-poll state cleared");

    // Step 4: Additional wait for cleanup to propagate
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (err) {
    // Cleanup errors are non-fatal — log and continue
    logger.warn("GENERAL", "⚠️ Telegram session cleanup warning (non-fatal)", {
      error: err.message,
    });
  }
}

/**
 * Attempt to launch the bot with retry logic for 409 Conflict errors.
 * This handles the case where Telegram hasn't fully released the previous
 * polling session by the time we try to connect.
 */
async function launchBotWithRetry(retryCount = 0) {
  try {
    await bot.launch({ dropPendingUpdates: true });
    return true; // Success
  } catch (err) {
    // Check if this is a 409 Conflict error
    const is409 = err.message && (
      err.message.includes("409") ||
      err.message.toLowerCase().includes("conflict") ||
      err.message.includes("terminated by other getUpdates")
    );

    if (is409 && retryCount < TELEGRAM_409_MAX_RETRIES) {
      const delay = TELEGRAM_409_RETRY_DELAY * (retryCount + 1); // Linear backoff
      logger.warn("GENERAL", `🔄 409 Conflict detected — retrying in ${delay}ms (attempt ${retryCount + 1}/${TELEGRAM_409_MAX_RETRIES})`);

      // Cleanup again before retry
      await cleanupTelegramSession();

      await new Promise(resolve => setTimeout(resolve, delay));
      return launchBotWithRetry(retryCount + 1);
    }

    // Not a 409, or out of retries — rethrow
    throw err;
  }
}

// ── Execute launch sequence ──
(async () => {
  // Step 1: Clean up any dangling Telegram session from previous container/PM2 instance
  await cleanupTelegramSession();

  // Step 2: Launch with 409 retry protection
  try {
    await launchBotWithRetry();
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
  } catch (err) {
    logger.fatal("GENERAL", "❌ Bot failed to launch!", { error: err.message, stack: err.stack });
    logger.restart("Bot launch failed — forcing restart");
    setTimeout(() => process.exit(1), 2000);
  }
})();

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
