// webscrape/linkRouter.js
const { Markup } = require("telegraf");

const { sendMessage }            = require("../utils/message_main");
const { sendFilter }             = require("../utils/messasge_filter");
const { loyalSendMessage }       = require("../utils/loyalsendmesssage");
const { sanitizeAdData }         = require("../utils/telegramSafeText");
const { sanitizeImages }         = require("../utils/telegramMediaSafe");

const { scrap_999 }              = require("./websites/999");
const { scrap_immobiliare }      = require("./websites/immobiliare");
const { parseLoyal }             = require("./websites/loyal");

const axios                      = require("axios");
const { sendMessageFromPremier } = require("../utils/message_main_premier");

/*───────────────────────────────────────────────────────────*/
/* Helpers                                                   */
/*───────────────────────────────────────────────────────────*/

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

    const { data } = await axios.get(
      `http://${ctx.session.user.strapi_backend}/api/${slug}?populate=*`,
      {
        headers: {
          Authorization: `Bearer ${ctx.session.user.strapi_token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    ctx.session.data = data.data;
    console.log('[returnPremierOptions] session.data stored — keys:', Object.keys(ctx.session.data || {}).join(', '));

    // ── PERSIST to MongoDB for resilience across callback queries ──
    await persistSessionDataToMongo(ctx, db);

    await ctx.replyWithMediaGroup(sendMessageFromPremier(ctx));
    await ctx.reply(
      "Ce doriți să faceți?",
      Markup.inlineKeyboard([
        Markup.button.callback("Postează", "post_platforms"),
      ])
    );
  } catch (err) {
    console.error("❌ [returnPremierOptions] Error:", err.message);
    await ctx.reply("A apărut o eroare la preluarea datelor de pe Premier. Verificați link-ul.");
  }
};

const returnInfoInChat = async (adData, ctx, userAdId, db) => {
  if (!adData) return ctx.reply("Nu am putut extrage datele.");

  /*─── DEBUG: Log raw images before any sanitization ────────────*/
  console.log('[linkRouter] RAW images count:', adData.images?.length || 0);
  if (adData.images && adData.images.length > 0) {
    console.log('[linkRouter] First 3 raw image URLs:', JSON.stringify(adData.images.slice(0, 3)));
  }

  /*─── SAFETY: sanitize all text fields before sending to Telegram ───*/
  adData = sanitizeAdData(adData);

  /*─── SAFETY: sanitize ALL image URLs before mediaGroup ───────────
    Telegram crashes on:
      - invalid file HTTP URL specified
      - Disallowed character in URL host
    sanitizeImages() removes ALL dangerous URLs automatically.
    ──────────────────────────────────────────────────────────────*/
  adData.images = sanitizeImages(adData.images);

  // ── DEEP CLONE: Store a copy of the data in session to prevent any
  //    cross-context mutation issues between text handler and callback
  //    query contexts. The Telegraf session middleware may persist the
  //    object reference, and any subsequent modifications to `adData`
  //    (e.g., in media group fallback) could corrupt the session copy.
  ctx.session.data = JSON.parse(JSON.stringify(adData));
  console.log('[linkRouter] session.data stored — keys:', Object.keys(ctx.session.data).join(', '));

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

  /*─── 1. Trimitem galeria ───*/
  try {
    if (adData.link.includes("loyal.md")) {
      await ctx.replyWithMediaGroup(loyalSendMessage(adData, ctx, userAdId));
    } else {
      await ctx.replyWithMediaGroup(sendMessage(adData, ctx, userAdId));
    }
  } catch {
    // Fallback: try with only the first image
    adData.images = [adData.images[0]];
    try {
      if (adData.link.includes("loyal.md")) {
        await ctx.replyWithMediaGroup(loyalSendMessage(adData, ctx, userAdId));
      } else {
        await ctx.replyWithMediaGroup(sendMessage(adData, ctx, userAdId));
      }
    } catch (secondErr) {
      // Last resort: send text-only to keep bot alive
      const fallbackText = `📄 *Anunț (fallback text)*\n\n${adData.description || "Descriere indisponibilă"}\n\n🔗 ${adData.link || "N/A"}`;
      await ctx.reply(fallbackText, { disable_web_page_preview: true, parse_mode: "Markdown" });
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
    await ctx.reply(await sendFilter(ctx, adData), {
      disable_web_page_preview: true,
      parse_mode: "Markdown",
    });
  }

  /*─── 3. Butoane de acțiune ───*/
  const keyboard = ctx.session.user.type === "admin"
    ? Markup.inlineKeyboard([
        Markup.button.callback("Post Premier", "post_premier"),
        Markup.button.callback("Nu posta",      "post_no"),
        Markup.button.callback("Edit",          "edit"),
      ])
    : Markup.inlineKeyboard([
        Markup.button.callback("Nu posta", "post_no"),
        Markup.button.callback("Edit",     "edit"),
      ]);

  await ctx.reply("Ce doriți să faceți?", keyboard);
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
      ctx.session.imobilType = ctx.message.text.trim().split("/")[4];
      return returnPremierOptions(ctx, db);

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


