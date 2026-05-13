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

const returnPremierOptions = async (ctx) => {
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

const returnInfoInChat = async (adData, ctx, userAdId) => {
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

  ctx.session.data = adData;

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

const linkRouter = async (ctx, userAdId) => {
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
      return returnInfoInChat(adData, ctx, userAdId);

    } else if (host === "premierimobil.md") {
      ctx.session.imobilType = ctx.message.text.trim().split("/")[4];
      return returnPremierOptions(ctx);

    } else if (host === "immobiliare.md") {
      const adData = await scrap_immobiliare(ctx, ctx.message.text.trim());
      return returnInfoInChat(adData, ctx, userAdId);

    } else if (host === "loyal.md") {
      const adData = await parseLoyal(ctx.message.text.trim());
      return returnInfoInChat(adData, ctx, userAdId);

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

module.exports = { linkRouter };


