const { Telegraf, session, Markup } = require("telegraf");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const { linkRouter } = require("./webscrape/linkRouter");
const { postRouter } = require("./post/postRouter");
const { sendMessage } = require("./utils/message_main");
const { getDescription } = require("./bot_actions/bot_redact");
const { removeWatermark } = require("./utils/dewatermarking");
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
   GLOBAL CRASH PROTECTION  (Nivelul 2)
   FORCE restart on uncaughtException / unhandledRejection
   ════════════════════════════════════════════════════════════════ */
process.on("unhandledRejection", (reason, promise) => {
  logger.fatal("GENERAL", "❌ GLOBAL: Unhandled Rejection", {
    reason: reason?.message || reason,
    stack: reason?.stack,
  });
  logger.restart("Forced restart due to unhandled rejection");

  // Allow 2s for logs to flush, then die hard (PM2 will restart)
  setTimeout(() => {
    process.exit(1);
  }, 2000);
});

process.on("uncaughtException", (error) => {
  logger.fatal("GENERAL", "❌ GLOBAL: Uncaught Exception", {
    error: error.message,
    stack: error.stack,
  });
  logger.restart("Forced restart due to uncaught exception");

  // Allow 2s for logs to flush, then die hard (PM2 will restart)
  setTimeout(() => {
    process.exit(1);
  }, 2000);
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

    // Wrap linkRouter execution (handles all scraping internally)
    await linkRouter(ctx, userAdId);

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

// Handle Yes/No response for watermark removal
bot.action("remove_watermark_yes", checkUser, async (ctx) => {
  ctx.editMessageText("Postare in executie dureza pana la 5 sec....");
  ctx.session.removeWatermark = true;
  await postToPremier(ctx.session.data, ctx, true);
});

bot.action("remove_watermark_no", checkUser, async (ctx) => {
  ctx.editMessageText("Se incarca imaginile pe Premierimobil.md va dura pana la 5-6 sec...");
  ctx.session.removeWatermark = false;
  await postToPremier(ctx.session.data, ctx, false);
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
  ctx.session.selectedPlatforms = ctx.session.selectedPlatforms.includes(
    platform
  )
    ? ctx.session.selectedPlatforms.filter((p) => p !== platform)
    : [...ctx.session.selectedPlatforms, platform];

  const platformButtons = [
    { name: "FB/Inst", value: "meta" },
    { name: "999.md", value: "999" },
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
    ctx.editMessageText("Postare in executie...");
    logger.info("GENERAL", "Post platforms confirmed", { platforms: ctx.session.selectedPlatforms });
    await postRouter(ctx);
    ctx.session.selectedPlatforms = [];
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error in confirm_platforms", { error: error.message });
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
    const imageUrls = ctx.session.data.images;

    const dewatermarkedImages = [];
    for (const imageUrl of imageUrls) {
      try {
        // ── URL SAFETY: normalize and validate before request ──
        const cleanUrl = safeUrl(normalizeUrl(imageUrl));
        if (!cleanUrl) {
          logger.error("GENERAL", "Invalid image URL rejected in edit", { url: imageUrl });
          continue;
        }

        const imageResponse = await axios.get(cleanUrl, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        const imageBuffer = Buffer.from(imageResponse.data);

        const dewatermarkedBuffer = await removeWatermark(imageBuffer);

        const jpgBuffer = await sharp(dewatermarkedBuffer).jpeg().toBuffer();

        dewatermarkedImages.push(jpgBuffer);
      } catch (imgErr) {
        logger.error("GENERAL", "Image processing failed in edit", { url: imageUrl, error: imgErr.message });
      }
    }
    await ctx.replyWithMediaGroup(
      sendMessage(
        ctx.session.data,
        ctx,
        userAdId,
        redactedDesc,
        dewatermarkedImages,
        true
      )
    );
  } catch (error) {
    watchdog.recordError();
    logger.error("GENERAL", "Error during image processing", { error: error.message });
    await ctx.reply("Something went wrong while processing the images.");
  }
});

/* ════════════════════════════════════════════════════════════════
   BOT LAUNCH
   ════════════════════════════════════════════════════════════════ */

bot.launch()
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
