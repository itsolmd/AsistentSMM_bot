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

const client = new MongoClient(process.env.MONGO_URL, {
  tls: true,
  tlsInsecure: true,
  serverSelectionTimeoutMS: 15000,
});
let db;
const bot = new Telegraf(process.env.BOT_ID);


/* ════════════════════════════════════════════════════════════════
   GLOBAL CRASH PROTECTION
   NEVER allow unhandled rejection to crash the process.
   ════════════════════════════════════════════════════════════════ */
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ GLOBAL: Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("❌ GLOBAL: Uncaught Exception:", error.message, error.stack);
});

bot.use(session());
let userAdId;

async function initMongo() {
  try {
    await client.connect();
    db = client.db("users");
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

const checkUser = async (ctx, next) => {
  try {
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
    await ctx.reply("A avut loc o eroare la extragerea utilizatorului");
  }
};

bot.start(checkUser, async (ctx) => {
  await ctx.reply(
    `Bine ați venit! ${ctx.session.user.name}. Alegeți acțiunea:`,
    Markup.keyboard([["Adauga o postare"]]).resize()
  );
});

bot.hears("Adauga o postare", async (ctx) => {
  await ctx.reply(
    "Introduce-ti link-ul cu anuntul in formatul https://999.md/ro/numar:"
  );
});

bot.on("text", checkUser, async (ctx) => {
  try {
    const verificationMessage = await ctx.reply("Ma duc pana pe 999.md, sa va aduc anuntul!! 😃 in cateva sec.");
    if (!ctx.session) ctx.session = {};
    userAdId =
      ctx.session.user.initials +
      Math.floor(10000 + Math.random() * 90000).toString(); //aici se creaza un identificator unic in mesaju returnat  din telegram cu continutul anuntuioi 999
    await linkRouter(ctx, userAdId);
    setTimeout(() => {//start sterge mesajul de mai sus Ma duc pana pe 999.md, sa va aduc anuntul!!
      ctx.deleteMessage(verificationMessage.message_id).catch((err) => console.log("Eroare la ștergerea mesajului:", err));
    }, 300);//end sterge mesajul de mai sus Ma duc pana pe 999.md, sa va aduc anuntul!!
  } catch (error) {
    ctx.reply("Mai trimiteti inca o data anuntul... verificati daca ati copiat corect");
    console.log(error);
  }
});

bot.action("post_premier", checkUser, async (ctx) => {
  try {
    console.log("index post_premier");

    // Ask user if they want to remove the watermark
    await ctx.editMessageText(
      "Scoatem watermarkul?",
      Markup.inlineKeyboard([
        Markup.button.callback("Da", "remove_watermark_yes"),
        Markup.button.callback("Nu", "remove_watermark_no"),
      ])
    );
  } catch (error) {
    console.log(error);
  }
});

// Handle Yes/No response for watermark removal
bot.action("remove_watermark_yes", checkUser, async (ctx) => {
  ctx.editMessageText("Postare in executie dureza pana la 5 sec....");

  ctx.session.removeWatermark = true;
  await postToPremier(ctx.session.data, ctx, true); // Pass true for watermark removal
});

bot.action("remove_watermark_no", checkUser, async (ctx) => {
  ctx.editMessageText("Se incarca imaginile pe Premierimobil.md va dura pana la 5-6 sec...");
 

  ctx.session.removeWatermark = false;
  await postToPremier(ctx.session.data, ctx, false); // Pass false for no watermark removal

});

//reudant///////
bot.action("post_platforms", checkUser, async (ctx) => {
  try {
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
    console.error("Eroare la alegerea agentului:", error);
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
    console.log(ctx.session.selectedPlatforms);
    await postRouter(ctx);
    ctx.session.selectedPlatforms = [];
  } catch (error) {
    console.error("Eroare la publicare:", error);
    ctx.reply("A avut loc o eroare la publicare.");
  }
});
//reudant-end////////

bot.action("post_no", async (ctx) => {
  await ctx.editMessageText("Publicare intrerupta.");
});

bot.action("edit", checkUser, async (ctx) => {
  try {
    const redactedDesc = await getDescription(ctx.session.data);
    const imageUrls = ctx.session.data.images;

    const dewatermarkedImages = [];
    for (const imageUrl of imageUrls) {
      try {
        // ── URL SAFETY: normalize and validate before request ──
        const cleanUrl = safeUrl(normalizeUrl(imageUrl));
        if (!cleanUrl) {
          console.error("❌ [edit] Invalid image URL rejected:", imageUrl);
          continue;
        }
        console.log("📸 [edit] Final image URL before request:", cleanUrl);

        const imageResponse = await axios.get(cleanUrl, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        const imageBuffer = Buffer.from(imageResponse.data);

        const dewatermarkedBuffer = await removeWatermark(imageBuffer);

        const jpgBuffer = await sharp(dewatermarkedBuffer).jpeg().toBuffer();

        dewatermarkedImages.push(jpgBuffer);
      } catch (imgErr) {
        console.error("❌ [edit] Image processing failed for URL:", imageUrl, imgErr.message);
        // continue with next image
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
    console.error("Error during image processing:", error);
    await ctx.reply("Something went wrong while processing the images.");
  }
});






bot.launch();
