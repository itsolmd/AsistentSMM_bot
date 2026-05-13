const { getFilter } = require("./filters");

const sendFilter = async (ctx, data) => {
  try {
    const filterUrl = await getFilter(data, ctx);
    if (!filterUrl) {
      console.warn("⚠️ [sendFilter] Filter URL is empty, returning fallback");
      return `Link : ${ctx.message.text.trim()}
  Proprietar: ${data.phoneNr || "Nu a fost indicat"}
  [Filtru](N/A)`;
    }
    return `Link : ${ctx.message.text.trim()}
  Proprietar: ${data.phoneNr || "Nu a fost indicat"}
  [Filtru](${filterUrl})`;
  } catch (error) {
    console.error("❌ [sendFilter] Error generating filter:", error.message);
    return `Link : ${ctx.message.text.trim()}
  Proprietar: ${data.phoneNr || "Nu a fost indicat"}
  [Filtru](N/A — eroare la generare)`;
  }
};

module.exports = { sendFilter };
