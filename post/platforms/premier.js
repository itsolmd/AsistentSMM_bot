const axios = require("axios");
const { parsePriceToNumber } = require('../../utils/cleaners');
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { removeWatermark } = require("../../WaterMark-services/dewatermarking");
const { getFilter } = require("../../utils/filters");
const { normalizeUrl, safeUrl, sanitizeText } = require("../../utils/telegramMediaSafe");
const { uploadImageToStrapi } = require("../../utils/uploadImagStrapi");
const { geocodeWithFallback } = require('../../utils/geolocNominatim');      // Nominatim OSM geocoder
const { processImagePipeline } = require("../../services/uploadManager");
// const { scrap_999, GeoLoc } = require("../../webscrape/websites/999");

/**
 * normalizeGeolocation(geo)
 *
 * Validates and normalizes a geolocation object for Strapi's geolocation component.
 * Strapi expects: { lat: number, lon: number, bearing: 0, pitch: 0, zoom: 0 }
 *
 * INPUT: Accepts any coordinate key naming:
 *   { lat, lng } | { lat, lon } | { latitude, longitude } | { lat, lng, lon }
 *
 * OUTPUT: Strapi-compatible { lat, lon, bearing, pitch, zoom }
 * (Strapi's geolocation component uses `lon` internally, NOT `lng`.)
 *
 * Returns `null` if coordinates are missing, invalid, or out of range.
 * This prevents Invalid LatLng crashes in frontend Leaflet rendering.
 *
 * @param {Object|null} geo - Raw geolocation object
 * @returns {Object|null} Normalized Strapi geolocation or null
 */
function normalizeGeolocation(geo) {
  if (!geo || typeof geo !== 'object') {
    console.log('[GEO RAW] No geo object — using fallback coordinates');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }

  // ── SAFE EXTRACTION: Reject null/undefined BEFORE Number() conversion ──
  // Number(null) = 0, which is a valid coordinate (equator/null island).
  // We must catch null/undefined explicitly to prevent false positives.
  const rawLat = geo.lat ?? geo.latitude;
  const rawLng = geo.lng ?? geo.lon ?? geo.longitude;

  console.log('[GEO RAW] Input:', JSON.stringify(geo));
  console.log('[GEO RAW] Extracted — rawLat:', rawLat, 'rawLng:', rawLng);

  // ── NULL/UNDEFINED CHECK: Must happen BEFORE Number() ──
  if (rawLat == null || rawLng == null) {
    console.log('[GEO VALIDATION] ❌ Null/undefined — rawLat:', rawLat, 'rawLng:', rawLng, '— using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }

  const lat = Number(rawLat);
  const lng = Number(rawLng);

  console.log('[GEO NORMALIZED] lat:', lat, 'lng:', lng);

  // ── VALIDATION: Must be valid finite numbers ──
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.log('[GEO VALIDATION] ❌ Not finite — lat:', lat, 'lng:', lng, '— using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }

  // ── VALIDATION: Must be within valid geographic ranges ──
  if (lat < -90 || lat > 90) {
    console.log('[GEO VALIDATION] ❌ Lat out of range — lat:', lat, '— using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }
  if (lng < -180 || lng > 180) {
    console.log('[GEO VALIDATION] ❌ Lng out of range — lng:', lng, '— using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }

  // ── VALIDATION: Must not be placeholder values ──
  // (999.md sometimes returns { lat: 1, lng: null } which is truthy but invalid)
  if (lat === 0 && lng === 0) {
    console.log('[GEO VALIDATION] ❌ Zero/zero placeholder — using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }
  if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
    console.log('[GEO VALIDATION] ❌ Near-zero placeholder — lat:', lat, 'lng:', lng, '— using fallback');
    return { lat: 47.037, lng: 28.819, lon: 28.819, bearing: 0, pitch: 0, zoom: 0 };
  }

  console.log('[GEO VALIDATION] ✅ Valid — lat:', lat, 'lng:', lng);
  // BUG FIX: Strapi's geolocation component uses `lng` key, NOT `lon`.
  // The `lon` alias is included for backwards compatibility with any
  // existing data that may have been stored with `lon` key.
  const result = {
    lat,
    lng,
    lon: lng, // Alias for backward compatibility
    bearing: geo.bearing ?? 0,
    pitch: geo.pitch ?? 0,
    zoom: geo.zoom ?? 0,
  };
  console.log('[GEO PAYLOAD]', JSON.stringify(result));
  return result;
}

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
    console.error("❌ [postToPremier] data value:", JSON.stringify(data));
    console.error("❌ [postToPremier] typeof data:", typeof data);
    console.error("❌ [postToPremier] ctx.session keys:", Object.keys(ctx.session || {}));
    console.error("❌ [postToPremier] ctx.session.data exists:", !!ctx.session?.data);
    if (ctx.session?.data) {
      console.error("❌ [postToPremier] ctx.session.data keys:", Object.keys(ctx.session.data));
    }
    return ctx.reply("Eroare: datele anunțului sunt goale. Reîncercați.");
  }

  // ── FALLBACK: If parsedLocation is missing or has no city, use hardcoded address ──
  // This ensures posting continues even if the scraper returned incomplete location data.
  // The flow never stops — it always falls back to a valid Chișinău address.
  if (!data.parsedLocation || typeof data.parsedLocation !== 'object' || !data.parsedLocation.city) {
    console.warn('⚠️ [postToPremier] parsedLocation missing or invalid — using hardcoded fallback (Chișinău, Botanica, bd. Cuza Vodă, 17/1)');
    data.parsedLocation = {
      city: 'Chișinău',
      sector: 'Botanica',
      municipality: 'Chișinău mun.',
      street: 'bd. Cuza Vodă',
      streetNumber: '17/1',
      original: 'Chișinău mun., Chișinău, Botanica, bd. Cuza Vodă, 17/1'
    };
  }

  // ── FALLBACK: Ensure each parsedLocation field has a valid value ──
  // If any individual component is missing/null/empty, fill with defaults.
  // This prevents incomplete addresses from being sent to Strapi or displayed to user.
  // The flow never stops — it always falls back to a valid Chișinău address.
  const LOCATION_DEFAULTS = {
    city: 'Chișinău',
    sector: 'Buiucani',
    municipality: 'Chișinău mun.',
    street: 'Mihai Viteazu',
    streetNumber: '4',
  };
  data.parsedLocation.city = data.parsedLocation.city || LOCATION_DEFAULTS.city;
  data.parsedLocation.sector = data.parsedLocation.sector || LOCATION_DEFAULTS.sector;
  data.parsedLocation.municipality = data.parsedLocation.municipality || LOCATION_DEFAULTS.municipality;
  data.parsedLocation.street = data.parsedLocation.street || LOCATION_DEFAULTS.street;
  data.parsedLocation.streetNumber = data.parsedLocation.streetNumber || LOCATION_DEFAULTS.streetNumber;

  // ── FALLBACK: If region array is missing or empty, reconstruct from parsedLocation ──
  // The region array is used for sector/suburb lookups and filter URL generation.
  if (!Array.isArray(data.region) || data.region.length === 0) {
    console.warn('⚠️ [postToPremier] region array missing or empty — reconstructing from parsedLocation');
    data.region = [
      data.parsedLocation.municipality || 'Chișinău mun.',
      data.parsedLocation.city || 'Chișinău',
      data.parsedLocation.sector || 'Botanica',
      data.parsedLocation.street || 'bd. Cuza Vodă',
      data.parsedLocation.streetNumber || '17/1',
    ].filter(Boolean);
  }

  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log("🏢 [POST TO PREMIER] ÎNCEPE POSTAREA");
  console.log("═══════════════════════════════════════════════════════════");

  // ── IMAGE UPLOAD (PARALLEL PIPELINE) ──
  // REPLACED: old sequential Puppeteer loop with parallel pipeline.
  // Uses: axios download (NO Puppeteer), p-limit concurrency, retry logic.
  let uploadedImageIds = [];

  // If data.uploadedImageIds is already set (from postingWorker), skip re-upload
  if (Array.isArray(data.uploadedImageIds) && data.uploadedImageIds.length > 0) {
    uploadedImageIds = data.uploadedImageIds;
    console.log(`  📸 Folosire IDs deja încărcate: [${uploadedImageIds.join(", ")}]`);
  } else {
    // Guard: ensure data.images is an array before processing
    if (!Array.isArray(data.images)) {
      console.warn("  ⚠️ data.images nu e array — se tratează ca gol");
      data.images = [];
    }

    if (data.images.length > 0) {
      console.log(`  📸 Pornire pipeline paralel pentru ${data.images.length} imagini...`);

      // Run the parallel pipeline - downloads with axios (NO Puppeteer),
      // removes watermarks if flag is set, uploads to Strapi with keep-alive
      const pipelineResult = await processImagePipeline(
        data,
        ctx,
        removeWatermarkFlag,
        {
          downloadConcurrency: 5,
          uploadConcurrency: 3,
          downloadTimeout: 30000,
          uploadTimeout: 30000,
          maxRetries: 3,
          keepAllImages: true, // ALL images preserved, no cap
        }
      );

      uploadedImageIds = pipelineResult.uploadedIds;

      console.log(`  📊 Pipeline: ${pipelineResult.successCount} succes, ${pipelineResult.failCount} eșuat, ${pipelineResult.skippedCount} sărite (${pipelineResult.durationMs}ms)`);
    } else {
      console.warn("  ⚠️ Nicio imagine de procesat");
    }
  }

  console.log(`  📸 Total IDs încărcate: ${uploadedImageIds.length} [${uploadedImageIds.join(", ")}]`);

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







  // ── LIVING FIELD: convert from string (e.g. "Apartament cu living") to boolean ──
  const hasLiving =
    typeof data.living === "string" &&
    data.living.toLowerCase().includes("living");
  console.log("[postToPremier] Living raw:", data.living);
  console.log("[postToPremier] Living boolean:", hasLiving);

  // ── GEOLOCATION FALLBACK: Try to fetch coordinates if missing or invalid ──
  // BUG FIX v4.0: Check for VALID coordinates, not just truthy geolocation object.
  // 999.md sometimes returns { lat: 1, lng: null } which is truthy but invalid.
  const currentGeo = normalizeGeolocation(data.geolocation);
  const hasValidGeo = currentGeo !== null;

  if (!hasValidGeo && data.parsedLocation) {
    console.log("🌐 [postToPremier] Geolocation missing or invalid — attempting Nominatim OSM geocoder via parsedLocation:",
      JSON.stringify(data.parsedLocation));
    if (data.geolocation) {
      console.log("⚠️ [postToPremier] Existing geolocation was invalid, will be replaced:",
        JSON.stringify(data.geolocation));
    }
    try {
      const coords = await geocodeWithFallback(data.parsedLocation);
      if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
        console.log('[GEO NORMALIZED] Nominatim returned:', JSON.stringify(coords));
        data.geolocation = normalizeGeolocation(coords);
        console.log("✅ [postToPremier] Geolocation resolved via Nominatim OSM:", JSON.stringify(data.geolocation));
      } else {
        // Nominatim returned no coordinates — use hardcoded fallback
        // This ensures the flow never stops due to missing geolocation.
        console.log("⚠️ [postToPremier] Nominatim returned no coordinates — using hardcoded fallback (Chișinău, Buiucani)");
        data.geolocation = normalizeGeolocation({ lat: 47.037, lng: 28.819 });
      }
    } catch (geoErr) {
      console.error("❌ [postToPremier] Nominatim geolocation fetch failed:", geoErr.message);
      // Use hardcoded fallback — never return null, never block posting
      console.log("⚠️ [postToPremier] Using hardcoded fallback geolocation (Chișinău, Buiucani) after Nominatim error");
      data.geolocation = normalizeGeolocation({ lat: 47.037, lng: 28.819 });
    }
  } else if (hasValidGeo) {
    // Normalize existing valid geolocation to Strapi format (lng → lon, add bearing/pitch/zoom)
    data.geolocation = currentGeo;
    console.log("✅ [postToPremier] Geolocation already present and valid:", JSON.stringify(data.geolocation));
  } else {
    // No parsedLocation and no valid geo — use hardcoded fallback
    // This branch is reached when both geolocation AND parsedLocation are missing.
    console.log("⚠️ [postToPremier] No parsedLocation and no valid geo — using hardcoded fallback (Chișinău, Buiucani)");
    data.geolocation = normalizeGeolocation({ lat: 47.037, lng: 28.819 });
  }

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
        bathrooms: (() => {
          // Convert "N/A", null, undefined, empty string, or any non-numeric value to 1
          // Strapi expects a `number` type, not a string or NaN
          // NEVER returns null — always falls back to 1 to prevent Strapi validation errors
          const v = data.bathrooms;
          if (v == null || v === "") return 1;
          const n = parseInt(v, 10);
          return isNaN(n) ? 1 : n;
        })(),






        
        //relatiile
        building: await matchFieldId(
          ctx,
          hardcodedBuilding(data.building),
          "buildings"
        ),
        // ── HEATING with smart fallback based on building/fund type ──
        heating: await (async () => {
          // Helper: try multiple possible names for a heating type
          const tryMatchHeating = async (names) => {
            for (const name of names) {
              try {
                const id = await matchFieldId(ctx, name, "apartament-heatings");
                if (id) {
                  console.log(`[HEATING] Matched "${name}" → ID:`, id);
                  return id;
                }
              } catch (e) {
                console.warn(`[HEATING] matchFieldId error for "${name}":`, e.message);
              }
            }
            return null;
          };

          // Map numeric heating IDs from scraper to possible string names for DB lookup
          const heatingNameVariants = {
            1: ["Autonomă", "Autonoma", "Încălzire autonomă", "Incălzire autonomă", "Autonomous"],
            2: ["Centralizată", "Centralizata", "Încălzire centralizată", "Incălzire centralizata", "Centralized"],
          };

          // 1. Try real heating type first (from scraper numeric ID)
          if (data.heating !== null && data.heating !== undefined) {
            const variants = typeof data.heating === 'number'
              ? heatingNameVariants[data.heating]
              : null;

            if (variants) {
              const heatingId = await tryMatchHeating(variants);
              if (heatingId) {
                console.log("[HEATING] Real heating type found:", data.heating, "→ ID:", heatingId);
                return heatingId;
              }
            }

            // Also try the raw string value directly
            if (typeof data.heating === 'string') {
              const rawId = await matchFieldId(ctx, data.heating, "apartament-heatings");
              if (rawId) {
                console.log("[HEATING] Matched raw string:", data.heating, "→ ID:", rawId);
                return rawId;
              }
            }
          }

          // 2. Fallback: infer from building type when heating is missing or unmatched
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
              const autoId = await tryMatchHeating(heatingNameVariants[1]);
              console.log("[HEATING FALLBACK] Selected heating: AUTONOMOUS — new building detected → ID:", autoId);
              return autoId;
            }

            // Secondary market → Centralized
            if (
              normalizedBuilding.includes("fond secundar") ||
              normalizedBuilding.includes("secundar") ||
              normalizedBuilding.includes("bloc secundar")
            ) {
              const centId = await tryMatchHeating(heatingNameVariants[2]);
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
        geolocation: data.geolocation,
        infos: await (async () => {
          let filterUrl = "";
          try {
            const result = await getFilter(data, ctx);
            // getFilter now returns { filterUrl, structuredFilter }
            filterUrl = result?.filterUrl || "";
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
            const result = await getFilter(data, ctx);
            // getFilter now returns { filterUrl, structuredFilter }
            filterUrl = result?.filterUrl || "";
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
        geolocation: data.geolocation || null,
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
