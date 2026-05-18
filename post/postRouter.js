const { postTo999 } = require("./platforms/999");
const { postToMeta } = require("./platforms/meta");
const { postToPremier } = require("./platforms/premier");

const postRouter = async (ctx) => {
  try {
    /*if meta => meta; if 999 => 999; if premier => premier; if sitedb => sitedb*/
    console.log("🔍 [postRouter] Post router called");
    console.log("🔍 [postRouter] Selected platforms:", ctx.session.selectedPlatforms);

    const removeWatermark = ctx.session.removeWatermark === true;

    if (ctx.session.selectedPlatforms.includes("999")) {
      console.log("🔍 [postRouter] Posting to 999.md...");
      await postTo999(ctx);
    }
    if (ctx.session.selectedPlatforms.includes("meta")) {
      console.log("🔍 [postRouter] Posting to Meta (FB/Inst)...");
      const metaResult = await postToMeta(ctx);
      if (metaResult && metaResult.fb) {
        let linksMsg = `✅ Facebook: ${metaResult.fb}`;
        if (metaResult.inst) {
          linksMsg += `\n✅ Instagram: ${metaResult.inst}`;
        }
        await ctx.reply(linksMsg);
      }
    }
    if (ctx.session.selectedPlatforms.includes("premier")) {
      console.log("🔍 [postRouter] Posting to Premier (Premierimobil.md)...");
      await postToPremier(ctx.session.data, ctx, removeWatermark);
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
