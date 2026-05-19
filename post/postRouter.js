const { postTo999 } = require("./platforms/999");
const { postToMeta } = require("./platforms/meta");
const { postToPremier } = require("./platforms/premier");
const { cleanupDuplicatePosts } = require("../services/deduplicator");

/**
 * postRouter(ctx)
 *
 * Routes posts to selected platforms with error resilience.
 * - NEVER throws — always catches and logs errors
 * - Each platform posts independently (one failure doesn't affect others)
 * - Runs duplicate cleanup after Facebook posts
 * - Continues to next platform even if one fails
 */
const postRouter = async (ctx) => {
  const results = {};

  try {
    console.log("🔍 [postRouter] Post router called");
    console.log("🔍 [postRouter] Selected platforms:", ctx.session.selectedPlatforms);

    const removeWatermark = ctx.session.removeWatermark === true;

    // ── Post to 999.md ─────────────────────────────────────
    if (ctx.session.selectedPlatforms.includes("999")) {
      console.log("🔍 [postRouter] Posting to 999.md...");
      try {
        const result999 = await postTo999(ctx);
        results["999"] = result999 ? "success" : "failed";
        console.log("🔍 [postRouter] 999.md result:", result999 ? "success" : "failed (null return)");
      } catch (err999) {
        // ULTIMUL NIVEL DE SIGURANȚĂ: nici o eroare nu oprește procesul
        console.error("❌ [postRouter] 999.md posting crashed (but continuing):", err999.message);
        console.error(err999.stack);
        results["999"] = "crashed";
        try {
          await ctx.reply("⚠️ A apărut o eroare la postarea pe 999.md, dar procesul continuă.");
        } catch (_) {}
      }
    }

    // ── Post to Meta (FB/Inst) ──────────────────────────────
    if (ctx.session.selectedPlatforms.includes("meta")) {
      console.log("🔍 [postRouter] Posting to Meta (FB/Inst)...");
      try {
        const metaResult = await postToMeta(ctx);
        results["meta"] = metaResult ? "success" : "failed";

        if (metaResult && metaResult.fb) {
          let linksMsg = `✅ Facebook: ${metaResult.fb}`;
          if (metaResult.inst) {
            linksMsg += `\n✅ Instagram: ${metaResult.inst}`;
          }
          await ctx.reply(linksMsg);

          // ── Run duplicate cleanup after successful Facebook post ──
          try {
            await cleanupDuplicatePosts("facebook");
            await cleanupDuplicatePosts("instagram");
          } catch (cleanupErr) {
            console.warn("[postRouter] ⚠️ Duplicate cleanup warning (non-blocking):", cleanupErr.message);
          }
        } else if (metaResult && metaResult.error) {
          console.warn("[postRouter] ⚠️ Meta post had errors but process continues:", metaResult.error);
        }
      } catch (errMeta) {
        // ULTIMUL NIVEL DE SIGURANȚĂ: nici o eroare nu oprește procesul
        console.error("❌ [postRouter] Meta posting crashed (but continuing):", errMeta.message);
        console.error(errMeta.stack);
        results["meta"] = "crashed";
        try {
          await ctx.reply("⚠️ A apărut o eroare la postarea pe Facebook/Instagram, dar procesul continuă.");
        } catch (_) {}
      }
    }

    // ── Post to Premier ─────────────────────────────────────
    if (ctx.session.selectedPlatforms.includes("premier")) {
      console.log("🔍 [postRouter] Posting to Premier (Premierimobil.md)...");
      try {
        await postToPremier(ctx.session.data, ctx, removeWatermark);
        results["premier"] = "success";
      } catch (errPremier) {
        // ULTIMUL NIVEL DE SIGURANȚĂ: nici o eroare nu oprește procesul
        console.error("❌ [postRouter] Premier posting crashed (but continuing):", errPremier.message);
        console.error(errPremier.stack);
        results["premier"] = "crashed";
        try {
          await ctx.reply("⚠️ A apărut o eroare la postarea pe Premier, dar procesul continuă.");
        } catch (_) {}
      }
    }

    // ── No platform selected ────────────────────────────────
    if (ctx.session.selectedPlatforms.length === 0) {
      try {
        await ctx.editMessageText("Nici o platforma nu a fost selectata.");
      } catch (_) {}
    }

    // ── Summary ─────────────────────────────────────────────
    console.log("🔍 [postRouter] Posting complete. Results:", JSON.stringify(results));

  } catch (error) {
    // CATEGORICAL SAFETY NET: absolut nici o eroare nu oprește procesul
    console.error("❌ [postRouter] CATASTROPHIC ERROR (but process continues):", error.message);
    console.error(error.stack);
    try {
      await ctx.reply("⚠️ A avut loc o eroare la postare. Verificați log-urile.");
    } catch (_) {}
  }
};

module.exports = { postRouter };
