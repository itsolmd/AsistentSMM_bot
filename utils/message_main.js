/**
 * Build a clean Telegram location string from parsedLocation object.
 *
 * Rules:
 * 1. Never duplicate municipality/city values
 * 2. Include street + number if available (normalized: "str. Tudor Vladimirescu 38a")
 * 3. Support missing fields gracefully
 * 4. Normalize formatting: remove duplicate commas, trim spaces, avoid trailing commas
 *
 * @param {Object} parsedLocation - { municipality, city, sector, street, streetNumber }
 * @returns {string} Clean location string for Telegram
 */
function buildTelegramLocation(parsedLocation) {
  if (!parsedLocation || typeof parsedLocation !== 'object') {
    return 'N/A';
  }

  const { city, sector, street, streetNumber } = parsedLocation;

  // Normalize street: "strada Ialoveni" → "str. Ialoveni", "str Ialoveni" → "str. Ialoveni"
  const normalizedStreet = street
    ?.replace(/^strada\s+/i, "str. ")
    ?.replace(/^str\s+/i, "str. ")
    ?.trim();

  // Combine street and number into a single item: "str. Ialoveni 136"
  const streetLine = normalizedStreet
    ? `${normalizedStreet}${streetNumber ? ` ${streetNumber}` : ""}`
    : null;

  const parts = [
    city,
    sector,
    streetLine,
  ].filter(Boolean);

  const formatted = parts.join(', ');

  console.log("[TELEGRAM LOCATION] Parsed:", JSON.stringify(parsedLocation));
  console.log("[TELEGRAM LOCATION] Final string:", formatted);

  return formatted || 'N/A';
}

const sendMessage = (
  data,
  ctx,
  userAdId,
  description = data.description || "",
  images = (ctx.session.data && ctx.session.data.images) || [],
  edited = false
) => {
  let message = "";

  // ── Dacă scraperul a returnat deja textul formatat, îl folosim direct ──
  if (data.formattedText) {
    message = data.formattedText;
  } else {
    // ── Altfel, construim mesajul din câmpurile individuale ──
    const descriptionToUse = escapeMarkdown(description).slice(0, 500);

    // Build clean Telegram location from parsedLocation if available
    const telegramLocation = data.parsedLocation
      ? buildTelegramLocation(data.parsedLocation)
      : (data.regionText || 'N/A');

    if (data.type === "Toate apartamentele") {
      message = `
  Apartament.
  
  📍 𝐋𝐨𝐜𝐚𝐭̦𝐢𝐞: ${telegramLocation}
  🛏️ Dormitoare: ${data.rooms}
  📐 Suprafață: ${data.area} m²
  🏢 Etaj: ${data.floor}/${data.floors}
  🚽 Băi: ${data.bathrooms || '1'}
  🏗️ Bloc: ${data.building}
  💰 Preț: ${data.price} €
  ${userAdId}
      `;
    } else if (data.type === "Case") {
      message = `\n${descriptionToUse}
        \n🏠 Casă cu ${data.rooms} camere • ${data.area}m2
        \n💶 • ${data.price} €
        \n📐Nivele • ${data.floors}
        \n📍${telegramLocation}
        \n📞 Contact • +${ctx.session.user.phoneNr} | ${ctx.session.user.name.split(" ")[0]}
        \n${userAdId}`;
    } else if (data.type === "Imobiliare comerciale") {
      message = `\n${descriptionToUse}
        \n🏢 Spatiu comercial cu ${data.area}m2
        \n💶 • ${data.price} €
        \n📍${telegramLocation}
        \n📞 Contact • +${ctx.session.user.phoneNr} | ${ctx.session.user.name.split(" ")[0]}
        \n${userAdId}`;
    } else if (data.type === "Loturi de teren") {
      message = `\n${descriptionToUse}
        \n🌿 Lot de teren de ${data.area} ari
        \n💶 ${data.price} €
        \n📍${telegramLocation}
        \n📞 Contact • +${ctx.session.user.phoneNr} | ${ctx.session.user.name.split(" ")[0]}
        \n${userAdId}`;
    }
  }

  return images.slice(0, 10).map((url, index) => ({
    type: "photo",
    media: edited ? { source: url } : url,
    caption: index === 0 ? message : "",
  }));
};

function escapeMarkdown(text) {
  return String(text).replace(/([_*[\]()])/g, "\\$1");
}

module.exports = { sendMessage };
