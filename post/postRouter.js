const { postTo999 } = require("./platforms/999");
const { postToMeta } = require("./platforms/meta");
const { postToPremier } = require("./platforms/premier");

const postRouter = async (ctx) => {
  try {
    /*if meta => meta; if 999 => 999; if sitedb => sitedb*/
    console.log("🔍 [postRouter] Post router called");
    console.log("🔍 [postRouter] Selected platforms:", ctx.session.selectedPlatforms);

    if (ctx.session.selectedPlatforms.includes("999")) {
      console.log("🔍 [postRouter] Posting to 999.md...");
      await postTo999(ctx);
    }
    if (ctx.session.selectedPlatforms.includes("meta")) {
      console.log("🔍 [postRouter] Posting to Meta (FB/Inst)...");
      await postToMeta(ctx);
    }
    if (ctx.session.selectedPlatforms.length == 0) {
      await ctx.editMessageText("Nici o platforma nu a fost selectata.");
    }
  } catch (error) {
    console.error("❌ [postRouter] Error in post router:", error.message);
    console.error(error.stack);
    await ctx.reply("A avut loc o eroare la postare. Verificați log-urile.");
  }
};

module.exports = { postRouter };
