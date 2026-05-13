const axios = require("axios");
const { parsePriceToNumber } = require('../../utils/cleaners');
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { removeWatermark } = require("../../utils/dewatermarking");
const { getFilter } = require("../../utils/filters");
const { normalizeUrl, safeUrl, sanitizeText } = require("../../utils/telegramMediaSafe");
const { uploadImageToStrapi } = require("../../utils/uploadImagStrapi");
//const { getCoordinates } = require('../../utils/mapmdgeoloc');               // geoloc map
// const { scrap_999, GeoLoc } = require("../../webscrape/websites/999");

//functie care ia un field si il trece prin obiectul cu ids pina gaseste match.
//daca este match, seteaza-l.
//e facut urat. in dependenta de baza de date, majoritatea tabelelor au: id, ro, ru en. Tabelele "series" si "developers" au "serie" si "name"



const filterData = (data, key = "ro") => {
  if (key === "serie") {
    return data.map((item) => ({ id: item.id, serie: item.serie }));
  } else if (key === "name") {
    return data.map((item) => ({ id: item.id, name: item.name }));
  } else if (key === "telegram_id") {
    return data.map((item) => ({ id: item.id, telegram_id: item.telegram_id }));
  } else {
    return data.map((item) => ({ id: item.id, ro: item.ro }));
  }
};

const matchFieldId = async (ctx, field, endpoint, key = "ro") => {
  // ── Token resolution: env-level first, session-level fallback ──
  const envToken    = process.env.STRAPI_TOKEN;
  const sessionToken = ctx?.session?.user?.strapi_token;
  const token = envToken || sessionToken;

  if (!token) {
    console.error("❌ [matchFieldId] No Strapi token available (env or session)");
    return null;
  }

  // ── Backend URL resolution: env-level first, session-level fallback ──
  const envBackend    = process.env.BACK_END;
  const sessionBackend = ctx?.session?.user?.strapi_backend;
  const backend = envBackend || sessionBackend;

  if (!backend) {
    console.error("❌ [matchFieldId] No Strapi backend URL available (env or session)");
    return null;
  }

  const ids = await filterData(
    await (
      await axios.get(
        `http://${backend}/api/${endpoint}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      )
    ).data.data,
    key
  );

  // ids.map((item) => {
  //   console.log(item.name + " - " + field);
  // });
  //greseala de la 999
  if (field === "Ms (serie  moldovenească)") {
    field = "Ms (serie moldovenească)";
  }
  return ids.find((object) => object[key] === field)?.id || null;
};

//hardcod pentru conditii pentru a satisface campurile din db
const hardcodedConditions = (condition) => {
  if (condition === "Variantă albă" || condition === "Fără reparație") {
    //valoarea din 999
    return "Fără reparație/ Variantă albă"; //valoarea din tabel
  } else if (condition === "Euroreparație") {
    return "Reparație euro";
  } else if (condition === "Reparație cosmetică") {
    return "Reparație medie";
  }
};

const hardcodedHouseTypes = (type) => {
  if (type === "Casă") {
    //valoarea din 999
    return "Casă"; //valoarea din tabel
  } else if (type === "Townhouse") {
    return "Townhouse";
  } else if (type === "Vilă") {
    return "Vilă";
  }
};

const hardcodedCommercialDest = (type) => {
  if (type === "Birou") {
    //valoarea din 999
    return "Birouri"; //valoarea din tabel
  } else if (type === "Comercial") {
    return "Comercial";
  } else {
    return "Depozit/ Producere";
  }
};

const hardcodedTerrainDest = (type) => {
  if (type === "Teren pentru construcții") {
    //valoarea din 999
    return "Construcție"; //valoarea din tabel
  } else if (type === "Teren agricol") {
    return "Agricol";
  } else {
    return "Teren agricol";
  }
};


// fond locativ
const hardcodedBuilding = (building) => {
  //valoarea din 999
  if (building === "Secundar") {
    return "Bloc secundar"; //valoarea din tabel
  } else if (building === "Construcţii noi") {
    return "Bloc nou";
  }
};
//end fond locativ


// async function uploadImageToStrapi(imageBuffer, ctx) {
//   const formData = new FormData();
//   formData.append("files", imageBuffer, { filename: "image.jpg" });

//   const uploadResponse = await axios.post(
//     `http://${ctx.session.user.strapi_backend}/api/upload`,
//     formData,
//     {
//       headers: {
//         ...formData.getHeaders(),
//         Authorization: `Bearer ${ctx.session.user.strapi_token}`,
//       },
//     }
//   );

//   return uploadResponse.data[0].id;
// }

const postToPremier = async (data, ctx, removeWatermarkFlag) => {
  try {
  // ── VALIDATION: Ensure data object is not empty ──
  if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
    console.error("❌ [postToPremier] Empty or invalid data object received");
    return ctx.reply("Eroare: datele anunțului sunt goale. Reîncercați.");
  }

  console.log("🔍 [postToPremier] Obiectul de date trimis:", JSON.stringify(data, null, 2));
  console.log("🔍 [postToPremier] Se pregătește postarea pe premier.md!");

  // ── IMAGE UPLOAD ──
  const uploadedImageIds = [];

  // Guard: ensure data.images is an array before iterating
  if (!Array.isArray(data.images)) {
    console.warn("⚠️ [postToPremier] data.images is not an array — treating as empty. Value:", data.images);
    data.images = [];
  }

  // Deduplicate image URLs to avoid uploading the same image twice
  const uniqueImageUrls = [...new Set(data.images)];
  console.log('[postToPremier] IMAGE UPLOAD LOOP: total unique images to process:', uniqueImageUrls.length);
  if (uniqueImageUrls.length > 0) {
    console.log('[postToPremier] First 3 image URLs:', JSON.stringify(uniqueImageUrls.slice(0, 3)));
  }
  if (uniqueImageUrls.length < data.images.length) {
    console.log("🔁 [postToPremier] Removed", data.images.length - uniqueImageUrls.length, "duplicate image URL(s)");
  }

  for (const imageUrl of uniqueImageUrls) {
    // ── URL SAFETY: normalize and validate before request ──
    console.log('[postToPremier] Processing image URL:', imageUrl);
    const cleanUrl = safeUrl(normalizeUrl(imageUrl));
    if (!cleanUrl) {
      console.error("❌ [postToPremier] Invalid image URL rejected:", imageUrl);
      continue; // skip this image, don't crash
    }
    console.log("📸 [postToPremier] Final image URL before request:", cleanUrl);

    let response;
    try {
      response = await axios.get(cleanUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
      });
    } catch (axiosErr) {
      console.error("❌ [postToPremier] Axios download failed for URL:", cleanUrl, axiosErr.message);
      continue; // skip this image, don't crash
    }
    const imageBuffer = Buffer.from(response.data);

    let finalImageBuffer = imageBuffer;

    // Only remove watermark if the flag is true
    if (removeWatermarkFlag) {
      finalImageBuffer = await removeWatermark(imageBuffer);
    }

    // Upload the image (with or without watermark removal)
    const imageId = await uploadImageToStrapi(finalImageBuffer, ctx);
    if (imageId) {
      uploadedImageIds.push(imageId);
      console.log("✅ Sa procesat imaginea spre Premierimobil.md: " + imageUrl + " → ID:", imageId);
    } else {
      console.warn("⚠️ [postToPremier] Image upload returned null for:", imageUrl);
    }
  }

  console.log("📸 [postToPremier] Total uploaded image IDs:", uploadedImageIds);

  // ── DEBUG: Strapi model keys & image IDs (BUG REPAIR) ──────────
  console.log('[STRAPI MODEL KEYS] Available data keys:', Object.keys(data));
  console.log('[STRAPI IMAGE IDS] Uploaded image IDs:', JSON.stringify(uploadedImageIds));
  console.log('[STRAPI IMAGE IDS] Count:', uploadedImageIds.length);

  // ── TYPE NORMALIZATION ──────────────────────────────────────────
  // Map all possible data.type values from different scrapers to canonical types
  const typeMap = {
    "Toate apartamentele": "apartments",
    "Apartament":          "apartments",
    "Apartamente":         "apartments",
    "Case":                "houses",
    "Casă":                "houses",
    "houses":              "houses",
    "Imobiliare comerciale": "commercials",
    "Comercial":           "commercials",
    "commercials":         "commercials",
    "Loturi de teren":     "terrains",
    "Teren":               "terrains",
    "terrains":            "terrains",
  };
  const canonicalType = typeMap[data.type] || null;
  console.log(`🔍 [postToPremier] Original type: "${data.type}" → Canonical: "${canonicalType}"`);

  if (!canonicalType) {
    console.error(`❌ [postToPremier] Unknown data.type: "${data.type}" — cannot determine Strapi endpoint`);
    return ctx.reply(`Eroare: tipul anunțului "${data.type}" nu este recunoscut. Nu s-a putut posta.`);
  }

  // ── SAFETY GUARD: If images were uploaded but dataToSend would be empty, fail fast ──
  if (uploadedImageIds.length > 0 && (!data || typeof data !== "object" || Object.keys(data).length === 0)) {
    console.error("❌ [postToPremier] Images uploaded but data object is empty — aborting to avoid orphan images");
    return ctx.reply("Eroare: imaginile au fost încărcate dar datele anunțului sunt goale. Operațiunea a fost anulată.");
  }

  //start Region — BUG #2, #3 FIXED: data.region is now [municipality, city, sector, street?, streetNumber?]
  // data.region[0] = municipality (Chișinău mun.)
  // data.region[1] = city (Chișinău)
  // data.region[2] = sector (Sculeni, Botanica, Centru, etc.)
  console.log("🔍 [postToPremier] Region array received:", JSON.stringify(data.region));
  console.log("🔍 [postToPremier] Parsed location:", JSON.stringify(data.parsedLocation));

  // Try suburb first (for Chișinău sectors that are registered as suburbs in Strapi)
  const suburbName = Array.isArray(data.region) && data.region.length > 2 ? data.region[2] : null;
  console.log("🔍 [postToPremier] Looking up suburb/sector:", suburbName);

  const suburbie = suburbName
    ? ((await matchFieldId(ctx, suburbName, "suburbs?pagination[pageSize]=100")) || null)
    : null;

  let sector = null;
  if (!suburbie && suburbName) {
    sector = await matchFieldId(ctx, suburbName, "sectors");
    console.log("🔍 [postToPremier] Match as sector:", sector, "for:", suburbName);
  } else if (suburbie) {
    console.log("🔍 [postToPremier] Match as suburb:", suburbie, "for:", suburbName);
  } else {
    console.log("⚠️ [postToPremier] Could not match:", suburbName, "as suburb or sector");
  }
// console.log("Suburbie spre Premierimobil.md:", suburbie);//null
// console.log("Sector spre Premierimobil.md:", sector);// da id
// console.log("tot randul regiunii chisinau centru str.  spre Premierimobil.md ", data.region);// aici imi da tot randul regiunii chisinau centru str. .....
// console.log("data . region 2 Premierimobil.md:", data.region[2]); //da numele sectorului ex " "centru"
// console.log("data . region 1 Premierimobil.md:", data.region[1]); //chisinau
// console.log("data . region 3 Premierimobil.md:", data.region[3]);// strada
// console.log("data . region 4 Premierimobil.md:", data.region[4]); // nr casei/bloc
//end Region




/////start geolocatia pri fuctie aparte din map.md (mapmdgeoloc.js)



// (async () => {
//     // Exemplu de URL (poți înlocui cu un URL dinamic sau primit ca input)
//     //const url = "https://999.md/ro/100115627"; // URL-ul anunțului

//     // Apelează funcția de scraping
//     const objectToSend = await scrap_999(null, url);

//     // Verifică dacă obiectul returnat conține date valide
//     if (objectToSend) {
//         console.log("Obiectul returnat de scrap_999:", objectToSend);

//         // Extrage geolocația din obiect
//         if (objectToSend.geolocation) {
//             const { lat, lng } = objectToSend.geolocation;
//             console.log("Geolocația extrasă:", { lat, lng });
//         } else {
//             console.error("Geolocația nu a fost găsită în obiectul returnat.");
//         }

//         // Extrage alte date din obiect (opțional)
//         console.log("Titlul anunțului:", objectToSend.title);
//         console.log("Prețul:", objectToSend.price);
//         console.log("Descrierea:", objectToSend.description);
//     } else {
//         console.error("Nu s-au putut extrage datele de pe site.");
//     }
// })();
// /// end extract geolocatia pri fuctie aparte din map.md (mapmdgeoloc.js)



  // ── LIVING FIELD: convert from string (e.g. "Apartament cu living") to boolean ──
  const hasLiving =
    typeof data.living === "string" &&
    data.living.toLowerCase().includes("living");
  console.log("[postToPremier] Living raw:", data.living);
  console.log("[postToPremier] Living boolean:", hasLiving);

  let dataToSend = {};
  if (canonicalType === "apartments") {
    dataToSend = {
      data: {
        //obligatorii in db
        rooms: data.rooms,
        area: data.area,
        // BUG #8 FIXED: price must be numeric, not "97.000 €"
        price: parsePriceToNumber(data.price),
        floor: data.floor,
        //////////////
        floors: data.floors,
        living: hasLiving,
        balcony: data.balcony,
        bathrooms: data.bathrooms || 1,






        
        //relatiile
        building: await matchFieldId(
          ctx,
          hardcodedBuilding(data.building),
          "buildings"
        ),
        // ── HEATING with smart fallback based on building/fund type ──
        heating: await (async () => {
          // 1. Try real heating type first
          if (data.heating) {
            const heatingId = await matchFieldId(ctx, data.heating, "apartament-heatings");
            if (heatingId) {
              console.log("[HEATING] Real heating type found:", data.heating, "→ ID:", heatingId);
              return heatingId;
            }
          }

          // 2. Fallback: infer from building type when heating is missing
          if (data.building) {
            const normalizedBuilding = data.building
              ?.toLowerCase()
              ?.normalize("NFD")
              ?.replace(/[\u0300-\u036f]/g, "");

            console.log("[HEATING FALLBACK] Building:", data.building);

            // New buildings → Autonomous
            if (
              normalizedBuilding.includes("constructii noi") ||
              normalizedBuilding.includes("bloc nou")
            ) {
              const autoId = await matchFieldId(ctx, "Autonomă", "apartament-heatings");
              console.log("[HEATING FALLBACK] Selected heating: AUTONOMOUS — new building detected → ID:", autoId);
              return autoId;
            }

            // Secondary market → Centralized
            if (
              normalizedBuilding.includes("fond secundar") ||
              normalizedBuilding.includes("secundar")
            ) {
              const centId = await matchFieldId(ctx, "Centralizată", "apartament-heatings");
              console.log("[HEATING FALLBACK] Selected heating: CENTRALIZED — secondary market detected → ID:", centId);
              return centId;
            }
          }

          console.log("[HEATING] No heating data and no fallback applicable — returning null");
          return null;
        })(),
        features: await Promise.all(
          Array.isArray(data.features)
            ? data.features.map(async (feature) => {
                return await matchFieldId(ctx, feature, "apartament-features");
              })
            : [] // Fallback to an empty array if data.features is not an array or is undefined
        ),
        developer: await matchFieldId(
          ctx,
          data.developer,
          "developers?pagination[pageSize]=100",
          "name"
        ),
        condition: await matchFieldId(
          ctx,
          hardcodedConditions(data.condition),
          "conditions"
        ),
        apartament_sery: await matchFieldId(
          ctx,
          data.serie,
          "apartament-series",
          "serie"
        ),
        // BUG #7 FIXED: Strapi v5 requires { connect: [{ id }] } for relation fields
        // OLD (v3 format): images: [{ id: 17450 }]  →  Error: "Invalid key images"
        // OLD (v4 format):  images: [17450]          →  Error: "Invalid key images"
        // NEW (v5 format):  images: { connect: [{ id: 17450 }] }
        // BUG v2.1 FIXED: REMOVED "images" field — it doesn't exist in Strapi schema.
        // Only "thumbnails" is the correct relation field name.
        // Sending both caused: "ValidationError: Invalid key images"
        // BUG FIX STRAPI v5: Changed from { connect: [{ id }] } to simple array format
        // Strapi v5 accepts: thumbnails: [id1, id2, id3] for CREATE operations
        thumbnails: uploadedImageIds,
        sector: sector,
        suburb: suburbie,
        // BUG #9 FIXED: Use real GPS from scraper if available, fallback only if missing
        geolocation: data.geolocation || { lat: 46.86513324840075, lng: 28.99087267849402 },
        infos: await (async () => {
          let filterUrl = "";
          try {
            filterUrl = await getFilter(data, ctx);
          } catch (filterErr) {
            console.error("❌ [postToPremier] getFilter failed:", filterErr.message);
            filterUrl = ""; // Graceful fallback — never crash on filter
          }
          // BUG #10 FIXED: Prevent "null" injection — use empty string for missing values
          const link = data.link || '';
          const phone = data.phoneNr || '';
          const regionStr = Array.isArray(data.region) ? data.region.join(', ') : (data.regionText || '');
          const desc = data.description && data.description !== 'N/A' ? data.description : '';
          // BUG v2.1 FIXED: Apply sanitizeText() to remove backslash escaping
          // and normalize whitespace while preserving newlines
          return sanitizeText([
            link,
            phone ? `📞 ${phone}` : '',
            `📍 ${regionStr}`,
            filterUrl ? `🔍 Filtru: ${filterUrl}` : '',
            desc ? `\nDescriere: ${desc}` : '',
          ].filter(Boolean).join('\n'));
        })(),
        agent: await matchFieldId(
          ctx,
          ctx.session.user.telegramChatID,
          "agents",
          "telegram_id"
        ),
      },
    };


    console.log("premier.js Numărul de camere:", dataToSend.data.rooms);
    console.log("premier.js Suprafața:", dataToSend.data.area);
    console.log("premier.js Prețul:", dataToSend.data.price);
    console.log("premier.js Etajul:", dataToSend.data.floor);
    console.log("din Premier.js data.geolocation:", data.geolocation);
    //console.log("din Premier.js objectToSend.geolocation:", objectToSend.geolocation);

  } else if (canonicalType === "houses") {
    dataToSend = {
      data: {
        area: data.area || null,
        hectares: data.hectares,
        house_feature: await Promise.all(
          Array.isArray(data.features)
            ? data.features.map(async (feature) => {
                return await matchFieldId(ctx, feature, "house-features");
              })
            : [] // Fallback to an empty array if data.features is not an array or is undefined
        ),
        price: parsePriceToNumber(data.price),
        geolocation: data.geolocation,
        // BUG v2.1 FIXED: Removed "images" field — not in Strapi schema
        // BUG FIX STRAPI v5: Simple array format instead of { connect: [...] }
        thumbnails: uploadedImageIds,
        sector: sector,
        suburb: suburbie,
        views: data.views,
        rooms: data.rooms,
        floors: data.floors,
        house_type: await matchFieldId(
          ctx,
          hardcodedHouseTypes(data.house_type),
          "house-types"
        ),
        infos: `${data.link}
        ${data.phoneNr //Proprietar: 
          
        }${"inca nu e gandit ;)" /*await getFilters(data)*/}`, //\n\n Filtru:
        agent: await matchFieldId(
          ctx,
          ctx.session.user.telegramChatID,
          "agents",
          "telegram_id"
        ),
        condition: await matchFieldId(
          ctx,
          hardcodedConditions(data.condition),
          "conditions"
        ),
        sanitary: data.sanitary,
        canalization: data.canalization,
        gasification: data.gasification,
      },
    };
  } else if (canonicalType === "commercials") {
    dataToSend = {
      data: {
        area: data.area || null,
        commercial_features: await Promise.all(
          Array.isArray(data.features)
            ? data.features.map(async (feature) => {
                return await matchFieldId(ctx, feature, "commercial-features");
              })
            : [] // Fallback to an empty array if data.features is not an array or is undefined
        ),

        price: parsePriceToNumber(data.price),
        geolocation: data.geolocation,
        // BUG v2.1 FIXED: Removed "images" field — not in Strapi schema
        // BUG FIX STRAPI v5: Simple array format instead of { connect: [...] }
        thumbnails: uploadedImageIds,
        sector: sector,
        suburb: suburbie,
        views: data.views,
        condition: await matchFieldId(
          ctx,
          hardcodedConditions(data.condition),
          "conditions"
        ),
        commercial_destination: await matchFieldId(
          ctx,
          hardcodedCommercialDest(data.commercial_destination),
          "commercial-destinations"
        ),
        infos: await (async () => {
          let filterUrl = "";
          try {
            filterUrl = await getFilter(data, ctx);
          } catch (filterErr) {
            console.error("❌ [postToPremier] getFilter failed for Imobiliare comerciale:", filterErr.message);
            filterUrl = "";
          }
          return `Link: ${data.link}\n\n Proprietar: ${
            data.phoneNr
          }\n\n [Filtru](${filterUrl})`;
        })(),
        agent: await matchFieldId(
          ctx,
          ctx.session.user.telegramChatID,
          "agents",
          "telegram_id"
        ),
      },
    };
  } else if (canonicalType === "terrains") {
    dataToSend = {
      data: {
        area: data.area || null,
        //inca nu este in db
        // terrain_features: await Promise.all(
        //   Array.isArray(data.features)
        //     ? data.features.map(async (feature) => {
        //         return await matchFieldId(ctx, feature, "commercial-features");
        //       })
        //     : [] // Fallback to an empty array if data.features is not an array or is undefined
        // ),

        price: parsePriceToNumber(data.price),
        geolocation: data.geolocation,
        // BUG v2.1 FIXED: Removed "images" field — not in Strapi schema
        // BUG FIX STRAPI v5: Simple array format instead of { connect: [...] }
        thumbnails: uploadedImageIds,
        sector: sector,
        suburb: suburbie,
        views: data.views,

        terrain_destination: await matchFieldId(
          ctx,
          hardcodedTerrainDest(data.terrain_destination),
          "terrain-destinations"
        ),
        infos: `Link: ${data.link}\n\n Proprietar: ${
          data.phoneNr
        }\n\n Filtru: ${"inca nu e gandit ;)" /*await getFilters(data)*/}`,
        agent: await matchFieldId(
          ctx,
          ctx.session.user.telegramChatID,
          "agents",
          "telegram_id"
        ),
      },
    };
  }

  // ── FALLBACK: If canonicalType didn't match any known type, construct a minimal payload ──
  if (!dataToSend.data || Object.keys(dataToSend.data).length === 0) {
    console.warn("⚠️ [postToPremier] No matching type handler for canonicalType:", canonicalType, "— constructing minimal payload");
    dataToSend = {
      data: {
        price: parsePriceToNumber(data.price),
        geolocation: data.geolocation || { lat: 46.86513324840075, lng: 28.99087267849402 },
        // BUG v2.1 FIXED: Removed "images" field — not in Strapi schema
        // BUG FIX STRAPI v5: Simple array format instead of { connect: [...] }
        thumbnails: uploadedImageIds,
        sector: sector,
        suburb: suburbie,
        infos: `Link: ${data.link || "N/A"}\n\n Proprietar: ${data.phoneNr || "N/A"}`,
        agent: await matchFieldId(ctx, ctx.session.user.telegramChatID, "agents", "telegram_id"),
      },
    };
  }

  // ── VALIDATION: Ensure dataToSend has the required { data: { ... } } structure ──
  if (!dataToSend || !dataToSend.data || Object.keys(dataToSend.data).length === 0) {
    console.error("❌ [postToPremier] dataToSend is STILL empty after fallback. Aborting.");
    console.error("❌ [postToPremier] data.type =", data.type, "| canonicalType =", canonicalType);
    console.error("❌ [postToPremier] dataToSend content:", JSON.stringify(dataToSend, null, 2));
    return ctx.reply("Eroare: datele anunțului sunt incomplete. Nu s-a putut posta.");
  }

  // ── DEBUG LOG: Show the complete JSON body that will be sent ──
  console.log('[STRAPI FINAL PAYLOAD] Model keys:', Object.keys(dataToSend.data || {}));
  console.log('[STRAPI FINAL PAYLOAD] thumbnails value:', JSON.stringify(dataToSend.data?.thumbnails));
  console.log("📤 [postToPremier] FINAL PAYLOAD:", JSON.stringify(dataToSend, null, 2));
  console.log("📤 [postToPremier] ENDPOINT: /api/" + canonicalType);

  try {
    // ── Token resolution: env-level first, session-level fallback ──
    const envToken    = process.env.STRAPI_TOKEN;
    const sessionToken = ctx?.session?.user?.strapi_token;
    const token = envToken || sessionToken;

    if (!token) {
      console.error("❌ [postToPremier] No Strapi token available (env or session)");
      return ctx.reply("Eroare: token-ul Strapi lipsește. Contactați administratorul.");
    }

    console.log("🔑 [postToPremier] Using token from:", envToken ? ".env (server-level)" : "session (user-level)");
    console.log("🔑 [postToPremier] STRAPI TOKEN EXISTS:", !!token);

    // ── Backend URL resolution: env-level first, session-level fallback ──
    const envBackend    = process.env.BACK_END;
    const sessionBackend = ctx?.session?.user?.strapi_backend;
    const backend = envBackend || sessionBackend;

    if (!backend) {
      console.error("❌ [postToPremier] No Strapi backend URL available (env or session)");
      return ctx.reply("Eroare: URL-ul backend-ului Strapi lipsește. Contactați administratorul.");
    }

    const postImobil = await axios.post(
      `http://${backend}/api/${canonicalType}`,
      dataToSend,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    ctx.editMessageText("Postare finalizata!");
    if (
      backend ===
      "z0cs0ko4k0ow4ggkskkc40wc.62.169.31.87.sslip.io"
    ) {
      ctx.reply(
        `Postarea valabila la: https://premierimobil.md/en/${canonicalType}/` + postImobil.data.data.documentId
      );
    } else if (
      backend ===
      "d88w4ccwoggkkgc8k0k0sook.62.169.31.87.sslip.io"
    ) {
      ctx.reply(
        `Postarea valabila la: https://imobil.parkit.md/en/${canonicalType}/` + postImobil.data.data.documentId
      );
    }

    console.log(postImobil.data);
    return postImobil.data;
  } catch (error) {
    console.error("❌ [postToPremier] Strapi POST failed:", error.message);
    if (error.response) {
      console.error("❌ [postToPremier] HTTP Status:", error.response.status);
      console.error("❌ [postToPremier] Response body:", JSON.stringify(error.response.data, null, 2).slice(0, 1000));
      console.error("❌ [postToPremier] Request URL:", error.response.config?.url);
      console.error("❌ [postToPremier] Request headers:", JSON.stringify(error.response.config?.headers, null, 2));
      console.error("❌ [postToPremier] Request body that was sent:", JSON.stringify(dataToSend, null, 2));
    } else if (error.request) {
      console.error("❌ [postToPremier] No response received — network error?");
    }
    return ctx.reply("A avut loc o eroare la postarea anuntului pe site.");
  }
  } catch (outerErr) {
    console.error("❌ [postToPremier] Top-level error:", outerErr.message);
    console.error(outerErr.stack);
    await ctx.reply("A avut loc o eroare gravă la postarea pe Premier. Verificați log-urile.");
  }
};

module.exports = { postToPremier };
