/**
 * Build a clean Telegram location string from parsedLocation object.
 *
 * @param {Object} parsedLocation - { municipality, city, sector, street, streetNumber }
 * @returns {string} Clean location string for Telegram
 */
function buildTelegramLocation(parsedLocation) {
  if (!parsedLocation || typeof parsedLocation !== 'object') {
    return null;
  }

  const { city, sector, street, streetNumber } = parsedLocation;

  // Build street part: "str. Tudor Vladimirescu 38a" (number attached without comma)
  const streetPart = street
    ? `str. ${street.replace(/^(str\.|strada)\s+/i, '')}${streetNumber ? ` ${streetNumber}` : ''}`
    : null;

  const parts = [
    city,
    sector,
    streetPart,
  ].filter(Boolean);

  const formatted = parts.join(', ');

  console.log("[TELEGRAM LOCATION] Parsed:", JSON.stringify(parsedLocation));
  console.log("[TELEGRAM LOCATION] Final string:", formatted);

  return formatted || null;
}

function loyalSendMessage(data, ctx, userAdId) {
    // Build clean Telegram location from parsedLocation if available
    const telegramLocation = data.parsedLocation
      ? buildTelegramLocation(data.parsedLocation)
      : (data.region || "Chișinău");

    // Construim textul mesajului
    const captionLines = [
      `🏠 *Apartament*`,
      
      `📍 *Locație:* ${telegramLocation}`,
      `🛏️ *Dormitoare:* ${data.rooms || "—"}`,
      `📐 *Suprafață:* ${data.suprafata || data.supraface || "—"} m²`,
      `🏢 *Etaj:* ${data.floor || "—"}/${data.floors || "—"}`,
      `🚽 *Băi:* ${data.baths || "—"}`,
      `💰 *Preț:* ${data.price ? data.price + " " + (data.currency || "€") : "—"}`,
      
      
    ];
  
    if (userAdId) captionLines.push(`\nID: ${userAdId}`);
  
    if (data.advantages && data.advantages.length > 0) {
      captionLines.push(`\n✅ *Avantaje:*`);
      data.advantages.forEach((adv, i) => {
        captionLines.push(`${i + 1}. ${adv}`);
      });
    }
  
    const caption = captionLines.join("\n");
  
    // Pregătim media group cu imagini (maxim 10)
    const mediaGroup = (data.images || []).slice(0, 10).map((url, idx) => ({
      type: "photo",
      media: url,
      caption: idx === 0 ? caption : "",  // caption doar la prima imagine
    }));
  
    return mediaGroup;
  }
  
  module.exports = { loyalSendMessage };
  




// // Returnează un array gata de folosit de ctx.replyWithMediaGroup()
// function loyalSendMessage (data, ctx, userAdId) {
//     // ------- mapare câmpuri -------
//     const regionText = data.address || data.region || "Chișinău";   // locatia
//     const area       = data.suprafata ?? "—";
//     const baths      = data.baths     ?? 1;
//     const rooms      = data.rooms     ?? "—";
//     const floor      = data.floor     ?? "—";
//     const floors     = data.floors    ?? "—";
//     const price      = data.price     ?? "—";
  
//     // ------- construcție mesaj -------
//     const caption = `
//     Apartament (Loyal.md)
  
//     📍 𝐋𝐨𝐜𝐚𝐭̦𝐢𝐞: ${regionText}
//     🛏️ Dormitoare: ${rooms}
//     📐 Suprafață: ${area} m²
//     🏢 Etaj: ${floor}/${floors}
//     🚽 Băi: ${baths}
//     💰 Preț: ${price} €
//     ${userAdId}
//     `.trim();
  
//     // ------- grup media -------
//     return (data.images || []).slice(0, 10).map((url, idx) => ({
//       type      : "photo",
//       media     : url,
//       caption   : idx === 0 ? caption : "",
//       parse_mode: "Markdown"
//     }));
//   }
  
//   module.exports = { loyalSendMessage };
  