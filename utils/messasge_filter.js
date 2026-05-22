const { getFilter } = require("./filters");

/**
 * Safely extract the link text from ctx, handling cases where
 * ctx.message might be undefined (e.g., during error recovery).
 */
function getLinkText(ctx) {
  try {
    return ctx?.message?.text?.trim() || ctx?.update?.message?.text?.trim() || 'N/A';
  } catch {
    return 'N/A';
  }
}

const sendFilter = async (ctx, data) => {
  try {
    const result = await getFilter(data, ctx);
    
    // BUG FIX v4.0: getFilter may return a JSON string on validation failure
    // (legacy behavior) or an object { filterUrl, structuredFilter } on success.
    // Handle both cases safely.
    let filterUrl = "";
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      // Success case: { filterUrl: "...", structuredFilter: {...} }
      filterUrl = result.filterUrl || "";
    } else if (typeof result === 'string') {
      // Legacy validation failure case: JSON string
      console.warn("⚠️ [sendFilter] getFilter returned string (validation error):", result.slice(0, 200));
    }
    
    const linkText = getLinkText(ctx);
    
    if (!filterUrl) {
      console.warn("⚠️ [sendFilter] Filter URL is empty, returning fallback");
      return `Link : ${linkText}
  Proprietar: ${data.phoneNr || "Nu are Nr,Vezi poate are mai multe anunturi  caci aicic nu are Nr Nu a fost indicat"}
  [Filtru](N/A)`;
    }
    return `Link : ${linkText}
  Proprietar: ${data.phoneNr || "Nu are Nr,Vezi poate are mai multe anunturi  caci aicic nu are Nr Nu a fost indicat"}
  [Filtru](${filterUrl})`;
  } catch (error) {
    console.error("❌ [sendFilter] Error generating filter:", error.message);
    const linkText = getLinkText(ctx);
    return `Link : ${linkText}
  Proprietar: ${data.phoneNr || "Nu are Nr,Vezi poate are mai multe anunturi  caci aicic nu are Nr Nu a fost indicat"}
  [Filtru](N/A — eroare la generare)`;
  }
};

module.exports = { sendFilter };
