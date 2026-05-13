/**
 * Build a clean Telegram location string from parsedLocation object.
 *
 * @param {Object} parsedLocation - { municipality, city, sector, street, streetNumber }
 * @returns {string} Clean location string for Telegram
 */
function buildTelegramLocation(parsedLocation) {
  if (!parsedLocation || typeof parsedLocation !== 'object') {
    return 'N/A';
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

  return formatted || 'N/A';
}

const sendMessageFromPremier = (ctx) => {
  let message;

  // Build clean Telegram location from parsedLocation if available
  const telegramLocation = ctx.session.data.parsedLocation
    ? buildTelegramLocation(ctx.session.data.parsedLocation)
    : (ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector?.ro || 'N/A');

  console.log("[TELEGRAM LOCATION PREMIER] Using location:", telegramLocation);

  if (ctx.session.imobilType === "Toate apartamentele") {
    message = `🏢️Apartament cu ${ctx.session.data.rooms} camere • ${
      ctx.session.data.area
    }m2 • ${ctx.session.data.building.ro}\n💶 • ${
      ctx.session.data.price
    } € \n📐Nivel • ${
      ctx.session.data.floor + "/" + ctx.session.data.floors
    }\n📍${telegramLocation}\nContact • +${ctx.session.user.phoneNr} | ${
      ctx.session.user.name.split(" ")[0]
    }\n`;
  } else if (ctx.session.imobilType === "houses") {
    message = `Casa cu ${ctx.session.data.rooms} camere • ${
      ctx.session.data.area
    }m2 • ${ctx.session.data.hecatres} ari\n💶 • ${
      ctx.session.data.price
    } € \n📐Nivele • ${ctx.session.data.floors}\n📍${telegramLocation}\nContact • +${ctx.session.user.phoneNr} | ${
      ctx.session.user.name.split(" ")[0]
    }\n`;
  } else if (ctx.session.imobilType === "commercials") {
    message = `Spatiu comercial de tip ${
      ctx.session.data.commercial_destination.ro
    } • ${ctx.session.data.area}m2 \n💶 • ${ctx.session.data.price} € \n📍${telegramLocation}\nContact • +${ctx.session.user.phoneNr} | ${
      ctx.session.user.name.split(" ")[0]
    }\n`;
  } else if (ctx.session.imobilType === "terrains") {
    message = `Lot de pamant pentru ${
      ctx.session.data.terrain_destination.ro
    } • ${ctx.session.data.area} ari \n💶 • ${ctx.session.data.price} € \n📍${telegramLocation}\nContact • +${ctx.session.user.phoneNr} | ${
      ctx.session.user.name.split(" ")[0]
    }\n`;
  }
  //let message = "test";
  return ctx.session.data.thumbnails.slice(0, 10).map((thumbnail, index) => ({
    type: "photo",
    media: thumbnail.url,
    caption: index === 0 ? message : "",
  }));
};

module.exports = { sendMessageFromPremier };
