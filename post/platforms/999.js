const axios = require("axios");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const FormData = require("form-data"); // Ensure you use form-data in Node.js
const { normalizeUrl, safeUrl } = require("../../utils/telegramMediaSafe");
const { downloadSingleImage } = require("../../services/imageDownloader");
const { parseWithFallback } = require("../../services/aiFallback");

// ═══════════════════════════════════════════════════════════════════
// CATEGORIES — Fetched from https://partners-api.999.md/categories
// These are the top-level categories available on 999.md.
// Use the ID or URL slug when constructing an advert payload.
// ═══════════════════════════════════════════════════════════════════
const CATEGORIES = [
  { id: "658",  title: "Transport",                       url: "transport" },
  { id: "270",  title: "Imobiliare",                      url: "real-estate" },
  { id: "38",   title: "Telefoane și gadgeturi",           url: "phone-and-communication" },
  { id: "2",    title: "Calculatoare și birotică",         url: "computers-and-office-equipment" },
  { id: "1237", title: "Construcții și reparații",         url: "construction-and-repair" },
  { id: "1213", title: "Îmbrăcăminte și încălțăminte",    url: "clothes-and-shoes" },
  { id: "1195", title: "Mobilă și interior",              url: "furniture-and-interior" },
  { id: "44",   title: "Audio-Video-Foto",                url: "audio-video-photo" },
  { id: "6146", title: "Oferte de lucru",                 url: "work" },
  { id: "6026", title: "Agricultură",                     url: "agriculture" },
  { id: "6341", title: "Servicii",                        url: "services" },
  { id: "226",  title: "Animale de companie și plante",    url: "animals-and-plants" },
  { id: "1155", title: "Sport și sănătate",               url: "sports-health-and-beauty" },
  { id: "7522", title: "Frumusețe și îngrijire",          url: "beauty-and-personal-care" },
  { id: "693",  title: "Turism, recreație și divertisment", url: "tourism-leisure-and-entertainment" },
  { id: "1182", title: "Business",                        url: "business" },
  { id: "269",  title: "Instrumente muzicale",            url: "musical-instruments" },
  { id: "45",   title: "Tehnică de uz casnic",            url: "household-appliances" },
  { id: "1223", title: "Totul pentru sărbători",          url: "all-for-celebrations" },
  { id: "1412", title: "Lumea copiilor",                  url: "children-world" },
  { id: "1170", title: "Totul pentru casă și oficiu",     url: "all-for-home-and-office" },
  { id: "753",  title: "Diverse",                         url: "all-else" },
  { id: "1187", title: "Matrimoniale",                    url: "dating-and-greetings" },
];

// Quick lookup maps for category resolution
const CATEGORY_BY_ID    = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
const CATEGORY_BY_URL   = Object.fromEntries(CATEGORIES.map(c => [c.url, c]));
const CATEGORY_BY_TITLE = Object.fromEntries(CATEGORIES.map(c => [c.title, c]));

/**
 * Resolve the category_id for the advert being posted.
 * Priority:
 *   1. ctx.session.data.category_id (explicit numeric/string ID)
 *   2. ctx.session.data.category    (by title or URL slug)
 *   3. Default "270" (Imobiliare) — backward compatible
 *
 * @param {Object} ctx - Telegram session context
 * @returns {string} Valid 999.md category ID
 */
function resolveCategoryId(ctx) {
  // Priority 1: Explicit category_id from session data
  if (ctx.session.data?.category_id) {
    const cid = String(ctx.session.data.category_id);
    if (CATEGORY_BY_ID[cid]) {
      console.log('[resolveCategoryId] ✅ Using explicit category_id:', cid, CATEGORY_BY_ID[cid].title);
      return cid;
    }
    console.warn('[resolveCategoryId] ⚠️ Unknown category_id:', cid, '— falling back to default');
  }

  // Priority 2: Resolve by title or URL slug
  if (ctx.session.data?.category) {
    const raw = ctx.session.data.category;
    const byTitle = CATEGORY_BY_TITLE[raw];
    if (byTitle) {
      console.log('[resolveCategoryId] ✅ Resolved by title:', raw, '→ ID:', byTitle.id);
      return byTitle.id;
    }
    const byUrl = CATEGORY_BY_URL[raw];
    if (byUrl) {
      console.log('[resolveCategoryId] ✅ Resolved by URL slug:', raw, '→ ID:', byUrl.id);
      return byUrl.id;
    }
    console.warn('[resolveCategoryId] ⚠️ Could not resolve category:', raw, '— falling back to default');
  }

  // Priority 3: Default to Imobiliare
  console.log('[resolveCategoryId] ℹ️ Using default category: Imobiliare (270)');
  return "270";
}

/**
 * Resolve the subcategory_id based on category_id and imobilType.
 *
 * For Imobiliare (270), maps imobilType to the known 999.md subcategory IDs:
 *   apartments  → 1404
 *   houses      → 1406
 *   commercials → 1405
 *   terrains    → 1407
 *
 * For other categories, returns the value from ctx.session.data.subcategory_id
 * if provided, otherwise null (the caller must handle this).
 *
 * @param {Object} ctx - Telegram session context
 * @param {string} categoryId - Resolved 999.md category ID
 * @returns {string|null} Subcategory ID or null
 */
function resolveSubcategoryId(ctx, categoryId) {
  // If an explicit subcategory_id is provided, use it directly (works for ANY category)
  if (ctx.session.data?.subcategory_id) {
    const sid = String(ctx.session.data.subcategory_id);
    console.log('[resolveSubcategoryId] ℹ️ Using explicit subcategory_id:', sid);
    return sid;
  }

  // Imobiliare (270) — use existing imobilType-based mapping
  if (categoryId === "270") {
    const imobilType = ctx.session.imobilType || inferImobilType(ctx);
    const SUB_MAP = {
      apartments:  "1404",
      houses:      "1406",
      commercials: "1405",
      terrains:    "1407",
    };
    const sub = SUB_MAP[imobilType];
    if (sub) {
      console.log('[resolveSubcategoryId] ✅ Imobiliare subcategory:', imobilType, '→', sub);
      return sub;
    }
    console.warn('[resolveSubcategoryId] ⚠️ Unknown imobilType for Imobiliare:', imobilType, '— defaulting to apartments (1404)');
    return "1404";
  }

  // Other categories — no subcategory resolved automatically
  console.warn('[resolveSubcategoryId] ⚠️ No subcategory_id for category:', categoryId, '— set ctx.session.data.subcategory_id');
  return null;
}

// Function to upload an image from a URL to 999.md
async function uploadImageFromURL999(ctx, imageSrc) {
  try {
    // ── URL SAFETY: normalize and validate before request ──
    console.log("[uploadImageFromURL999] RAW input URL:", imageSrc);
    const cleanUrl = safeUrl(normalizeUrl(imageSrc));
    if (!cleanUrl) {
      console.error("❌ [uploadImageFromURL999] Invalid image URL rejected:", imageSrc);
      return null;
    }
    console.log("📸 [uploadImageFromURL999] Final image URL before request:", cleanUrl);

    // Fetch the image data as a buffer
    // OPTIMIZED: Direct axios download for ALL URLs (simpalsmedia + others).
    // NO Puppeteer needed — direct .jpg URLs work fine with axios + proper headers.
    const downloadResult = await downloadSingleImage(cleanUrl, {
      timeout: 30000,
      maxRetries: 3,
    });

    if (!downloadResult.success || !downloadResult.buffer) {
      console.error("❌ [uploadImageFromURL999] Download failed for URL:", cleanUrl, downloadResult.error);
      return null;
    }

    const imageBuffer = downloadResult.buffer;

    // Create form data for the file upload
    const form = new FormData();
    form.append("file", imageBuffer, {
      filename: "image.jpg",
      contentType: "image/jpeg",
    });

    // Perform the image upload to the 999.md API
    const uploadResponse = await axios.post(
      "https://partners-api.999.md/images",
      form,
      {
        ...form.getHeaders(),
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    // Log success and return the image ID
    console.log("Imaginea incarcata cu succes:", uploadResponse.data.image_id);
    return uploadResponse.data.image_id;
  } catch (error) {
    // Log any errors during the image upload
    console.error("Eroare la incarcarea imaginii:", error);
    return null;
  }
}

//scrap regions form the link provided in db
async function extractRegion(ctx) {
  // ═══════════════════════════════════════════════════════════════
  // SAFE GEO EXTRACTION with validation
  // Accepts: lat/lng, lat/lon, latitude/longitude
  // Prevents Invalid LatLng crashes from undefined coordinates
  // ═══════════════════════════════════════════════════════════════
  const geo = ctx.session.data.geolocation;
  const safeLat = geo?.lat ?? geo?.latitude;
  const safeLng = geo?.lng ?? geo?.lon ?? geo?.longitude;

  console.log('[GEO RAW] geolocation from session:', JSON.stringify(geo));
  console.log('[GEO NORMALIZED] lat:', safeLat, 'lng:', safeLng);

  // VALIDATION: Both coordinates must be finite numbers
  const latNum = Number(safeLat);
  const lngNum = Number(safeLng);
  const hasValidGeo = Number.isFinite(latNum) && Number.isFinite(lngNum) &&
    latNum >= -90 && latNum <= 90 && lngNum >= -180 && lngNum <= 180;

  if (!hasValidGeo) {
    console.log('[GEO VALIDATION] ❌ Invalid coordinates — cannot extract region from map.md');
    console.log('[GEO VALIDATION] lat:', latNum, 'lng:', lngNum);
    // Return a basic Chișinău location when geo is invalid
    return [{ id: "7", value: "12900" }];
  }

  console.log('[GEO VALIDATION] ✅ Valid — lat:', latNum, 'lng:', lngNum);

  //aici se afla numele la raion, sector, strada si nr la bloc
  const mapObj = await axios.get(
    `https://map.md/api/companies/webmap/near?lat=${latNum}&lon=${lngNum}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      auth: {
        username: ctx.session.user.map_token,
        password: "",
      },
    }
  );
  console.log("Răspunsul de la API din post on 999.js:", mapObj.data);
  console.log('[GEO PAYLOAD] map.md request with lat:', latNum, 'lon:', lngNum);
  //                  Chisinau Municipiu
  const location = [{ id: "7", value: "12900" }];

  // Determine the sector name (supports multiple data sources):
  //   1. Premier format: ctx.session.data.sector = {ro: "Centru"}
  //   2. 999.md scraper: ctx.session.data.parsedLocation.sector = "Centru"
  //   3. Direct string:   ctx.session.data.sector = "Centru"
  const sectorName = typeof ctx.session.data.sector === 'object' && ctx.session.data.sector !== null
    ? ctx.session.data.sector.ro || ctx.session.data.sector.name
    : ctx.session.data.sector || ctx.session.data?.parsedLocation?.sector;

  const suburbName = typeof ctx.session.data.suburb === 'object' && ctx.session.data.suburb !== null
    ? ctx.session.data.suburb.ro || ctx.session.data.suburb.name
    : ctx.session.data.suburb;

  // If we have no sector or suburb from scraped data, use map.md building location
  if (!sectorName && !suburbName) {
    console.log('[extractRegion] No sector/suburb in session data — using map.md building location');
    // Always add city (id: "8") for Chișinău when sector/suburb is unknown
    // BUG FIX: Required field "8" was missing, causing "Completați câmpul" validation error
    location.push({ id: "8", value: "13859" });
    // BUG FIX v3.2: Prefer scraped street name over map.md data
    // map.md may return wrong street/building for nearby addresses
    const scrapedStreet = ctx.session.data?.parsedLocation?.street;
    const scrapedStreetNumber = ctx.session.data?.parsedLocation?.streetNumber;
    if (scrapedStreet) {
      location.push({ id: "10", value: scrapedStreet });
    } else if (mapObj?.data?.building?.street_name) {
      location.push({ id: "10", value: mapObj.data.building.street_name });
    }
    if (scrapedStreetNumber) {
      location.push({ id: "11", value: scrapedStreetNumber });
    } else if (mapObj?.data?.building?.number) {
      location.push({ id: "11", value: mapObj.data.building.number });
    }
    return location;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SECTOR NAME MAP: Romanian → Russian (999.md API uses Russian names)
  // BUG FIX v4.0: The 999.md API returns sector names in Russian (e.g. "Центр")
  // but the scraper/parsedLocation provides Romanian names (e.g. "Centru").
  // This mapping bridges the language gap so feature_id "9" (sector) is always found.
  // ═══════════════════════════════════════════════════════════════════
  const SECTOR_NAME_MAP = {
    // Romanian (ro) → Russian (ru) for Chișinău sectors
    "Centru": "Центр",
    "Центр": "Центр",
    "Botanica": "Ботаника",
    "Ботаника": "Ботаника",
    "Buiucani": "Буюканы",
    "Буюканы": "Буюканы",
    "Rîșcani": "Рышкановка",
    "Râșcani": "Рышкановка",
    "Рышкановка": "Рышкановка",
    "Ciocana": "Чокана",
    "Чокана": "Чокана",
    "Aeroport": "Аэропорт",
    "Аэропорт": "Аэропорт",
    "Sculeanca": "Скулянка",
    "Скулянка": "Скулянка",
    "Telecentru": "Телецентр",
    "Телецентр": "Телецентр",
    "Posta Veche": "Старая Почта",
    "Poșta Veche": "Старая Почта",
    "Старая Почта": "Старая Почта",
  };

  //daca este sector din premier din db => hardcodeaza id 8 cu chisinau si cauta care e id-ul sectorului
  if (sectorName) {
    location.push({ id: "8", value: "13859" });

    const sectoare = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=8&parent_option_id=13859&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    // API returns "Options" (capital O) — handle both cases for safety
    const sectorOptions = sectoare?.data?.Options || sectoare?.data?.options || [];
    
    // Try exact match first (Romanian name)
    let sector = sectorOptions.find(
      (item) => item.title === sectorName
    );
    
    // BUG FIX v4.0: If exact match fails, try mapped Russian name
    // The 999.md API returns sector names in Russian (e.g. "Центр")
    // but scraped data may have Romanian names (e.g. "Centru")
    if (!sector) {
      const mappedName = SECTOR_NAME_MAP[sectorName];
      if (mappedName) {
        sector = sectorOptions.find((item) => item.title === mappedName);
        if (sector) {
          console.log(`[extractRegion] ✅ Sector matched via name map: "${sectorName}" → "${mappedName}" → ID: ${sector.id}`);
        } else {
          console.warn(`[extractRegion] ❌ Sector name mapped to "${mappedName}" but not found in API options`);
        }
      } else {
        console.warn(`[extractRegion] ❌ Sector "${sectorName}" not in name map and not found in API options`);
      }
    } else {
      console.log(`[extractRegion] ✅ Sector matched directly: "${sectorName}" → ID: ${sector.id}`);
    }
    
    // BUG FIX v4.0: Hardcoded fallback for well-known Chișinău sectors
    // If API lookup fails entirely, use known option IDs to prevent "Completați câmpul" on feature_id "9"
    if (!sector) {
      const SECTOR_HARDCODED_IDS = {
        "Центр": "13913",
        "Centru": "13913",
        "Ботаника": "13912",
        "Botanica": "13912",
        "Буюканы": "13911",
        "Buiucani": "13911",
        "Рышкановка": "13910",
        "Rîșcani": "13910",
        "Râșcani": "13910",
        "Чокана": "13914",
        "Ciocana": "13914",
        "Аэропорт": "14405",
        "Aeroport": "14405",
        "Скулянка": "14397",
        "Sculeanca": "14397",
        "Телецентр": "14396",
        "Telecentru": "14396",
        "Старая Почта": "14399",
        "Poșta Veche": "14399",
        "Posta Veche": "14399",
      };
      const hardcodedId = SECTOR_HARDCODED_IDS[sectorName] || SECTOR_HARDCODED_IDS[SECTOR_NAME_MAP[sectorName]];
      if (hardcodedId) {
        sector = { id: hardcodedId, title: sectorName };
        console.log(`[extractRegion] ⚠️ Using hardcoded sector ID for "${sectorName}": ${hardcodedId}`);
      } else {
        console.warn(`[extractRegion] ❌ No hardcoded fallback for sector: "${sectorName}"`);
      }
    }
    
    if (sector) {
      location.push({ id: "9", value: sector.id });
    } else {
      console.warn('[extractRegion] ❌ Sector not found in API options and no fallback available:', sectorName);
    }
    // BUG FIX v3.2: Prefer scraped street/building number over map.md
    const scrapedStreet = ctx.session.data?.parsedLocation?.street;
    const scrapedStreetNumber = ctx.session.data?.parsedLocation?.streetNumber;
    if (scrapedStreet) {
      location.push({ id: "10", value: scrapedStreet });
    } else if (mapObj?.data?.building?.street_name) {
      location.push({ id: "10", value: mapObj.data.building.street_name });
    }
    if (scrapedStreetNumber) {
      location.push({ id: "11", value: scrapedStreetNumber });
    } else if (mapObj?.data?.building?.number) {
      location.push({ id: "11", value: mapObj.data.building.number });
    }
  }
  //daca este suburb => cauta care e id 8 (bubuieci, bacioi etc) si  si 9 hardcodeaza-l la centru
  // BUG FIX v3.2: Prefer scraped street/building number over map.md
  else if (suburbName) {
    const suburbii = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=7&parent_option_id=12900&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    // API returns "Options" (capital O) — handle both cases for safety
    const suburbOptions = suburbii?.data?.Options || suburbii?.data?.options || [];
    const suburbMatch = suburbOptions.find(
      (item) => item.title === suburbName
    );

    if (!suburbMatch) {
      console.warn('[extractRegion] ❌ Suburb not found in API options:', suburbName);
      // Return basic location if suburb not found
      // BUG FIX v3.2: Prefer scraped street/building number over map.md
      const scrapedStreet = ctx.session.data?.parsedLocation?.street;
      const scrapedStreetNumber = ctx.session.data?.parsedLocation?.streetNumber;
      if (scrapedStreet) {
        location.push({ id: "10", value: scrapedStreet });
      } else if (mapObj?.data?.building?.street_name) {
        location.push({ id: "10", value: mapObj.data.building.street_name });
      }
      if (scrapedStreetNumber) {
        location.push({ id: "11", value: scrapedStreetNumber });
      } else if (mapObj?.data?.building?.number) {
        location.push({ id: "11", value: mapObj.data.building.number });
      }
      return location;
    }

    const suburbId = suburbMatch.id;
    location.push({ id: "8", value: suburbId });

    const suburbSect = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=8&parent_option_id=${suburbId}&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    const suburbSectOptions = suburbSect?.data?.Options || suburbSect?.data?.options || [];
    if (suburbSectOptions.length > 0) {
      location.push({ id: "9", value: suburbSectOptions[0].id });
    }
    // BUG FIX v3.2: Prefer scraped street/building number over map.md
    const scrapedStreet = ctx.session.data?.parsedLocation?.street;
    const scrapedStreetNumber = ctx.session.data?.parsedLocation?.streetNumber;
    if (scrapedStreet) {
      location.push({ id: "10", value: scrapedStreet });
    } else if (mapObj?.data?.building?.street_name) {
      location.push({ id: "10", value: mapObj.data.building.street_name });
    }
    if (scrapedStreetNumber) {
      location.push({ id: "11", value: scrapedStreetNumber });
    } else if (mapObj?.data?.building?.number) {
      location.push({ id: "11", value: mapObj.data.building.number });
    }
  }
  return location;
}

// extragerea caracterist din 999
const extractFeaturesId = async (ctx, type) => {
  let typeID;
  if (type === "apartments") {
    typeID = 1404;
  } else if (type === "houses") {
    typeID = 1406;
  } else if (type === "commercials") {
    typeID = 1405;
  } else if (type === "terrains") {
    typeID = 1407;
  } else {
    console.error(`[extractFeaturesId] ❌ Tip imobil necunoscut: "${type}". Se folosește apartamente ca fallback.`);
    typeID = 1404; // fallback la apartamente — NU întrerupe procesul
  }
  // SAFETY GUARD: typeID must be a valid number before making API call
  if (typeof typeID !== 'number' || isNaN(typeID)) {
    console.error(`[extractFeaturesId] ❌ Invalid typeID: "${typeID}" for type: "${type}". Using default 1404.`);
    typeID = 1404; // fallback — NU întrerupe procesul
  }
  // Use the resolved category_id dynamically instead of hardcoded "270"
  const categoryId = resolveCategoryId(ctx);
  const features = await axios.get(
    `https://partners-api.999.md/features?category_id=${categoryId}&subcategory_id=${typeID}&offer_type=776&lang=ro`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      auth: {
        username: `${ctx.session.user.token_999}`,
        password: "",
      },
    }
  );
  return features.data;
};

const extractFeatures = (data, featuresObj, ctx) => {
  const features = [];

  const findFeatureByTitle = (title) => {
    for (const group of featuresObj.features_groups) {
      const feature = group.features.find((f) => f.title === title);
      if (feature) return feature;
    }
    return null;
  };

  // Helper to process options
  const findOptionIdByTitle = (options, title) =>
    options.find((opt) => opt.title === title)?.id;

  //Comune///////////////////////////////////////////////////////////////

  // Price — BUG FIX v3.2: Remove all non-digit characters before parseInt
  // e.g. "195.000 €" → "195000" → parseInt → 195000
  // Previously used parseInt("195.000 €", 10) which returns 195 (stops at '.')
  if (data.price != null) {
    const feature = findFeatureByTitle("Preț");
    if (feature) {
      const priceStr = String(data.price).replace(/[^\d]/g, '');
      const priceVal = parseInt(priceStr, 10);
      features.push({
        id: feature.id,
        value: priceVal,
        unit: "eur",
      });
      console.log('[extractFeatures] Price parsed:', data.price, '→', priceVal, 'eur');
    }
  }
  // Geolocation — Safe extraction with validation for 999.md API
  if (data.geolocation) {
    const feature = findFeatureByTitle("Harta");

    // Safe extraction: accept any coordinate key naming
    const geoLat = data.geolocation.lat ?? data.geolocation.latitude;
    const geoLon = data.geolocation.lon ?? data.geolocation.lng ?? data.geolocation.longitude;

    console.log('[GEO RAW] extractFeatures geolocation:', JSON.stringify(data.geolocation));
    console.log('[GEO NORMALIZED] lat:', geoLat, 'lon:', geoLon);

    const latNum = Number(geoLat);
    const lonNum = Number(geoLon);
    const validGeo = Number.isFinite(latNum) && Number.isFinite(lonNum) &&
      latNum >= -90 && latNum <= 90 && lonNum >= -180 && lonNum <= 180;

    if (feature && validGeo) {
      features.push({
        id: feature.id,
        value: { lat: latNum, lon: lonNum },
      });
      console.log('[GEO VALIDATION] ✅ Added 999.md map feature:', latNum, lonNum);
    } else if (!validGeo) {
      console.log('[GEO VALIDATION] ❌ Invalid geolocation — skipping 999.md map feature');
      console.log('[GEO VALIDATION] lat:', latNum, 'lon:', lonNum);
    }
  }

  // NOTE: Phone number (feature id:16) is intentionally NOT included in the features array.
  // The 999.md API associates the phone number with the authenticated account automatically.
  // Including a phone feature causes "Numărul de telefon nu a fost găsit" (400) error.
  // The phoneNr is kept in session.data for Telegram display only.

  if (ctx.session.imobilType === "apartments") {
    if (data.features) {
      data.features.forEach((title) => {
        console.log("tesst12");
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    // Rooms
    if (data.rooms != null) {
      const feature = findFeatureByTitle("Număr de camere");
      if (feature) {
        const optionsMap = {
          1: "Apartament cu 1 cameră",
          2: "Apartament cu 2 camere",
          3: "Apartament cu 3 camere",
          4: "Apartament cu 4 camere",
          5: "Apartament cu 5 camere sau mai multe",
        };
        const roomTitle =
          data.rooms === 1 ? "Apartament cu 1 cameră" : optionsMap[data.rooms];
        const optionId = findOptionIdByTitle(feature.options, roomTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Living
    if (data.living != null) {
      const feature = findFeatureByTitle("Living");
      if (feature) {
        const livingTitle = data.living
          ? "Apartament cu living"
          : "Apartament fără living";
        const optionId = findOptionIdByTitle(feature.options, livingTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Area — BUG FIX v3.2: Added unit "m2" to prevent "Completați câmpul" validation error
    // 999.md API requires the unit for textbox_numeric_measurement type features
    if (data.area != null) {
      const feature = findFeatureByTitle("Suprafață totală");
      if (feature) {
        const areaVal = parseInt(data.area, 10);
        features.push({ id: feature.id, value: areaVal, unit: "m2" });
        console.log('[extractFeatures] Area:', data.area, '→', areaVal, 'm2 (feature id:', feature.id, ')');
      }
    }
    // Floor
    if (data.floor != null) {
      const feature = findFeatureByTitle("Etaj");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.floor)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Floors
    if (data.floors != null) {
      const feature = findFeatureByTitle("Număr de etaje");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.floors)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Bathrooms
    if (data.bathrooms != null) {
      const feature = findFeatureByTitle("Grup sanitar");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.bathrooms)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Balcony — handle multiple numeric formats from different scrapers:
    //   Premier scraper: 0=Nu, 1=Da
    //   999.md scraper:  1=Da, 2=Nu
    if (data.balcony != null) {
      const feature = findFeatureByTitle("Balcon/ lojie");
      if (feature) {
        // Unified map supporting all scraper formats
        const balconyTitleMap = {
          0: "Nu",
          1: "Da",
          2: "Nu",
        };
        const balconyTitle = typeof data.balcony === 'number'
          ? balconyTitleMap[data.balcony]
          : String(data.balcony);
        if (balconyTitle) {
          const optionId = findOptionIdByTitle(feature.options, balconyTitle);
          if (optionId) {
            features.push({ id: feature.id, value: optionId });
            console.log('[extractFeatures] Balcony mapped:', data.balcony, '→', balconyTitle, '→ option ID:', optionId);
          } else {
            console.warn('[extractFeatures] Balcony option not found for:', balconyTitle);
          }
        }
      }
    }

    // Building — supports both object {ro: "Bloc nou"} and string "Construcţii noi"
    if (data.building) {
      const feature = findFeatureByTitle("Fond locativ");
      if (feature) {
        // Handle both formats: Premier scraper returns string, 999 scraper returns object
        const buildingRaw = typeof data.building === 'string'
          ? data.building
          : (data.building.ro || data.building.title || '');
        // Detect "new construction" from either "Bloc nou" (object) or "Construcţii noi" (string)
        const isNew = buildingRaw.toLowerCase().includes("nou") || buildingRaw.toLowerCase().includes("noi");
        const buildingTitle = isNew ? "Construcţii noi" : "Secundar";
        const optionId = findOptionIdByTitle(feature.options, buildingTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Developer
    if (data.developer) {
      const feature = findFeatureByTitle("Dezvoltator");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.developer.ro
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // HEATING MAP — Maps normalized heating type to Strapi numeric IDs
    // ══════════════════════════════════════════════════════════════
    const POST_HEATING_MAP = {
      AUTONOMOUS: 1,
      CENTRALIZED: 2,
    };

    // Heating — with smart fallback based on building type
    let heatingId = data.heating != null && data.heating !== undefined ? data.heating : null;

    // ── HEATING FALLBACK: Infer from building/fund type when heating is missing ──
    if (heatingId === null && data.building) {
      // BUG FIX v3.0: data.building can be a string OR an object {ro: "..."}
      // Handle both cases to prevent .toLowerCase() crash on objects
      let buildingStr = '';
      if (typeof data.building === 'string') {
        buildingStr = data.building;
      } else if (data.building?.ro) {
        buildingStr = data.building.ro;
      } else if (data.building?.title) {
        buildingStr = data.building.title;
      } else {
        buildingStr = String(data.building);
      }

      const normalizedBuilding = buildingStr
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      console.log("[HEATING FALLBACK] Building (raw):", data.building);
      console.log("[HEATING FALLBACK] Building (normalized):", normalizedBuilding);

      // "Construcţii noi" => AUTONOMOUS => ID 1
      if (
        normalizedBuilding.includes("constructii noi") ||
        normalizedBuilding.includes("bloc nou")
      ) {
        heatingId = POST_HEATING_MAP.AUTONOMOUS;
        console.log("[HEATING FALLBACK] Selected heating: AUTONOMOUS (ID " + POST_HEATING_MAP.AUTONOMOUS + ") — 'Construcţii noi' detected");
      }
      // Secondary/old building => CENTRALIZED => ID 2
      else if (
        normalizedBuilding.includes("fond secundar") ||
        normalizedBuilding.includes("secundar")
      ) {
        heatingId = POST_HEATING_MAP.CENTRALIZED;
        console.log("[HEATING FALLBACK] Selected heating: CENTRALIZED (ID " + POST_HEATING_MAP.CENTRALIZED + ") — secondary/old building detected");
      } else {
        console.log("[HEATING FALLBACK] No building match for:", normalizedBuilding);
      }
    }

    if (heatingId !== null) {
      const feature = findFeatureByTitle("Tip încălzire");
      if (feature) {
        const heatingOptions = {
          1: "Autonomă",
          2: "Centralizată",
        };
        const heatingTitle = heatingOptions[heatingId];
        if (heatingTitle) {
          const optionId = findOptionIdByTitle(feature.options, heatingTitle);
          if (optionId) {
            features.push({ id: feature.id, value: optionId });
            console.log('[extractFeatures] Heating mapped:', heatingId, '→', heatingTitle, '→ option ID:', optionId);
          } else {
            console.warn('[extractFeatures] Heating option not found for:', heatingTitle);
          }
        }
      }
    }

    // Condition
    if (data.condition) {
      const feature = findFeatureByTitle("Starea apartamentului");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Apartment series
    if (data.apartament_sery) {
      const feature = findFeatureByTitle("Compartimentare");
      if (data.apartament_sery.serie === "Ms (serie moldovenească)") {
        data.apartament_sery.serie = "Ms (serie  moldovenească)";
      }
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.apartament_sery.serie
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
  } else if (ctx.session.imobilType === "houses") {
    if (data.house_feature) {
      data.house_feature.forEach((title) => {
        console.log("tesst12");
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    //rooms
    if (data.rooms != null) {
      const feature = findFeatureByTitle("Număr de camere");
      //const optionId = findOptionIdByTitle(feature.options, data.rooms);
      features.push({ id: feature.id, value: data.rooms });
    }

    if (data.bathrooms != null) {
      const feature = findFeatureByTitle("Bloc sanitar");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.bathrooms)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    //floors
    if (data.floors != null) {
      const feature = findFeatureByTitle("Nivele");
      if (feature) {
        const optionsMap = {
          1: "1 etaj",
          2: "2 etaje",
          3: "3 etaje",
          4: "4 sau mai multe etaje",
        };
        // BUG FIX: use data.floors instead of data.rooms for the floor options lookup
        const floorsNum = parseInt(data.floors, 10);
        const floorTitle = floorsNum >= 4
          ? optionsMap[4]
          : optionsMap[floorsNum] || `${floorsNum} etaje`;
        const optionId = findOptionIdByTitle(feature.options, floorTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
    //tipul casei
    if (data.house_type) {
      const feature = findFeatureByTitle("Tip");
      console.log(feature);
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.house_type.ro
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    if (data.area) {
      const feature = findFeatureByTitle("Suprafața totală");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }
    if (data.hectares) {
      const feature = findFeatureByTitle("Suprafața terenului");
      if (feature) {
        features.push({ id: feature.id, value: data.hectares });
      }
    }
    if (data.sanitary) {
      const feature = findFeatureByTitle("Instalații sanitare");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          "Cu instalații sanitare"
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Instalații sanitare");

      const optionId = findOptionIdByTitle(
        feature.options,
        "Fără instalații sanitare"
      );
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    if (data.canalization) {
      const feature = findFeatureByTitle("Canalizare");
      if (feature) {
        const optionId = findOptionIdByTitle(feature.options, "Сu сanalizare");
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Canalizare");

      const optionId = findOptionIdByTitle(feature.options, "Fără canalizare");
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    if (data.gasification) {
      const feature = findFeatureByTitle("Gazeificare");
      if (feature) {
        const optionId = findOptionIdByTitle(feature.options, "Cu gazificare");
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Gazeificare");

      const optionId = findOptionIdByTitle(feature.options, "Fără gazificare");
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    // Condition
    if (data.condition) {
      const feature = findFeatureByTitle("Starea casei");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
    features.push({
      id: "12",
      value: `Casa cu ${data.hecatres} ari spre vanzare, in ${
        data.suburb ? data.suburb : data.sector
      }`,
    });
    ////gata feature case
  } else if (ctx.session.imobilType === "commercials") {
    if (data.commercial_features) {
      data.commercial_features.forEach((title) => {
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    if (data.commercial_destination) {
      const feature = findFeatureByTitle("Tip spațiu");
      if (feature) {
        const conditionMap = {
          //prettier-ignore
          "Birouri": "Birou",
          //prettier-ignore
          "Comercial": "Comercial",
          "Depozit/ Producere": "Depozit",
        };
        const conditionTitle = conditionMap[data.commercial_destination.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    if (data.area) {
      const feature = findFeatureByTitle("Suprafață totală");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }

    if (data.condition) {
      const feature = findFeatureByTitle("Starea încăperii");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    features.push({
      id: "12",
      value: `Spatiu comercial cu ${data.area}m2 spre vanzare, in ${
        data.suburb ? data.suburb.ro : data.sector.ro
      }`,
    });
  }
  ////gata feature comerciale
  else if (ctx.session.imobilType === "terrains") {
    if (data.area) {
      const feature = findFeatureByTitle("Suprafață teren");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }

    if (data.terrain_destination) {
      const feature = findFeatureByTitle("Tip lot");
      if (feature) {
        const conditionMap = {
          //strapi : 999
          //prettier-ignore
          "Construcție": "Teren pentru construcții",
          //prettier-ignore
          "Agricol": "Teren agricol",
          //prettier-ignore
          "Pomicol": "Teren agricol",
        };
        const conditionTitle = conditionMap[data.terrain_destination.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    features.push({
      id: "12",
      value: `Lot de pamant de ${data.area} ari spre vanzare, in ${
        data.suburb ? data.suburb.ro : data.sector.ro
      }`,
    });
  }
  return features;
};

/**
 * Ensure all required features are present in the features array.
 * This is a safety net for when the API-based feature lookup (findFeatureByTitle)
 * fails to match feature titles. It uses the known field IDs from the
 * 999.md API validation errors to fill in missing critical fields.
 *
 * The known feature IDs for Imobiliare / Apartments (from API validation errors):
 *   "2"   → Price
 *   "244" → Area (Suprafață totală)
 *   "248" → Rooms (Număr de camere)
 *   "852" → Building (Fond locativ)
 *   "9"   → Floor (Etaj)
 *   "241" → Offer type for price (Vânzare/Cumpărare/Schimb)
 *   "249" → Bathrooms (Grup sanitar)
 *   "8"   → City/Sector (handled by extractRegion)
 *
 * @param {Array} features - The features array built by extractFeatures
 * @param {Object} featuresIdData - Raw API response from /features endpoint
 * @param {Object} data - ctx.session.data
 * @param {string} imobilType - e.g. "apartments", "houses"
 * @returns {Array} - Enhanced features array with missing fields filled in
 */
function ensureRequiredFields(features, featuresIdData, data, imobilType) {
  if (!featuresIdData?.features_groups) return features;

  // Build a map of feature ID → feature object from API response
  const featureApiMap = {};
  for (const group of featuresIdData.features_groups) {
    for (const f of (group.features || [])) {
      featureApiMap[f.id] = f;
    }
  }

  // Helper: find option ID by title within a feature
  const findOptionId = (featureId, optionTitle) => {
    const feature = featureApiMap[featureId];
    if (!feature?.options) return null;
    const opt = feature.options.find(o => o.title === optionTitle);
    return opt ? opt.id : null;
  };

  // Check if feature ID is already present in the features array
  const hasFeature = (id) => features.some(f => String(f.id) === String(id));

  // BUG FIX v3.2: Helper to find the ACTUAL feature ID by title from the API response.
  // This is needed because hardcoded IDs like "8" and "9" conflict with LOCATION features
  // (city uses id "8", sector uses id "9"). By looking up the actual feature ID from the API,
  // we use the correct apartment-specific ID (e.g. "252" for Etaj instead of "9").
  const findFeatureIdByTitle = (title) => {
    for (const group of featuresIdData.features_groups || []) {
      for (const f of group.features || []) {
        if (f.title === title) return f.id;
      }
    }
    return null;
  };

  if (imobilType === "apartments") {
    // ── Price (id: "2") — textbox_numeric_measurement with unit "eur" ──
    if (!hasFeature("2")) {
      let priceVal = data.priceNumeric;
      if (!priceVal && data.price) {
        priceVal = parseInt(String(data.price).replace(/[^\d]/g, ''), 10);
      }
      if (priceVal && !isNaN(priceVal)) {
        features.push({ id: "2", value: priceVal, unit: "eur" });
        console.log('[ensureRequiredFields] ✅ Added missing Price (id:2):', priceVal, 'eur');
      }
    }

    // ── Area (id: "244") — Suprafață totală ──
    if (!hasFeature("244") && data.area != null) {
      const areaVal = parseInt(data.area, 10);
      if (!isNaN(areaVal)) {
        // textbox_numeric_measurement may need unit "m2"
        const feature = featureApiMap["244"];
        const unit = feature?.units?.includes("m2") ? "m2" : undefined;
        features.push({ id: "244", value: areaVal, ...(unit ? { unit } : {}) });
        console.log('[ensureRequiredFields] ✅ Added missing Area (id:244):', areaVal, unit || '');
      }
    }

    // ── Rooms (id: "248") — Număr de camere, drop_down_options ──
    if (!hasFeature("248") && data.rooms != null) {
      const roomTitles = {
        1: "Apartament cu 1 cameră",
        2: "Apartament cu 2 camere",
        3: "Apartament cu 3 camere",
        4: "Apartament cu 4 camere",
        5: "Apartament cu 5 camere sau mai multe",
      };
      const title = roomTitles[data.rooms];
      if (title && featureApiMap["248"]?.options) {
        const optId = findOptionId("248", title);
        if (optId) {
          features.push({ id: "248", value: optId });
          console.log('[ensureRequiredFields] ✅ Added missing Rooms (id:248):', title, '→ option:', optId);
        }
      }
    }

    // ── Floor — Etaj ──
    // BUG FIX v3.2: Look up the ACTUAL feature ID from the API by title "Etaj"
    // instead of hardcoding ID "9" which conflicts with the LOCATION sector feature (also id "9").
    // This prevents duplicate feature id "9" in the payload (one for sector, one for floor).
    const floorFeatureId = findFeatureIdByTitle("Etaj");
    if (!hasFeature(floorFeatureId) && data.floor != null && floorFeatureId) {
      if (featureApiMap[floorFeatureId]?.options) {
        const optId = findOptionId(floorFeatureId, String(data.floor));
        if (optId) {
          features.push({ id: floorFeatureId, value: optId });
          console.log('[ensureRequiredFields] ✅ Added missing Floor (id:' + floorFeatureId + '):', data.floor, '→ option:', optId);
        }
      }
    }

    // ── Total floors — Număr de etaje ──
    // BUG FIX v3.2: Look up the ACTUAL feature ID from the API by title "Număr de etaje"
    // instead of hardcoding ID "8" which conflicts with the LOCATION city feature (also id "8").
    const totalFloorsFeatureId = findFeatureIdByTitle("Număr de etaje");
    if (!hasFeature(totalFloorsFeatureId) && data.floors != null && totalFloorsFeatureId) {
      if (featureApiMap[totalFloorsFeatureId]?.options) {
        const optId = findOptionId(totalFloorsFeatureId, String(data.floors));
        if (optId) {
          features.push({ id: totalFloorsFeatureId, value: optId });
          console.log('[ensureRequiredFields] ✅ Added missing Total floors (id:' + totalFloorsFeatureId + '):', data.floors, '→ option:', optId);
        }
      }
    }

    // ── Bathrooms (id: "249") — Grup sanitar, drop_down_options ──
    if (!hasFeature("249") && data.bathrooms != null && featureApiMap["249"]?.options) {
      const optId = findOptionId("249", String(data.bathrooms));
      if (optId) {
        features.push({ id: "249", value: optId });
        console.log('[ensureRequiredFields] ✅ Added missing Bathrooms (id:249):', data.bathrooms, '→ option:', optId);
      }
    }

    // ── Building (id: "852") — Fond locativ, drop_down_options ──
    if (!hasFeature("852") && data.building && featureApiMap["852"]?.options) {
      const buildingStr = typeof data.building === 'string' ? data.building : (data.building.ro || data.building.title || '');
      const isNew = buildingStr.toLowerCase().includes("nou") || buildingStr.toLowerCase().includes("noi");
      const buildingTitle = isNew ? "Construcţii noi" : "Secundar";
      const optId = findOptionId("852", buildingTitle);
      if (optId) {
        features.push({ id: "852", value: optId });
        console.log('[ensureRequiredFields] ✅ Added missing Building (id:852):', buildingTitle, '→ option:', optId);
      }
    }

    // ── Offer type for price (id: "241") — Vânzare / Cumpărare / Schimb, drop_down_options ──
    // BUG FIX v3.2: Always add feature 241 (Vânzare) even if the API's features endpoint
    // doesn't return it. Use API lookup first, fall back to known hardcoded option ID.
    // From filter URL debug: o_30_241=893 means option 893 = "Vânzare" for feature 241.
    if (!hasFeature("241")) {
      let optId = null;
      // Try API lookup first
      if (featureApiMap["241"]?.options) {
        optId = findOptionId("241", "Vânzare");
      }
      // Fallback: hardcoded known option ID for "Vânzare"
      if (!optId) {
        optId = "893"; // Known option ID for "Vânzare" on 999.md
        console.log('[ensureRequiredFields] Using hardcoded offer type option ID: 893 (Vânzare)');
      }
      if (optId) {
        features.push({ id: "241", value: optId });
        console.log('[ensureRequiredFields] ✅ Added missing Offer type (id:241): Vânzare → option:', optId);
      }
    }

    // ── Heating (id from API) — Tip încălzire ──
    if (!hasFeature(featureApiMap["heating"]?.id) && data.heating != null) {
      // Try to find heating feature by title
      for (const group of featuresIdData.features_groups) {
        const heatingFeat = group.features?.find(f => f.title === "Tip încălzire");
        if (heatingFeat && heatingFeat.options) {
          const heatTitle = data.heating === 1 ? "Autonomă" : "Centralizată";
          const optId = findOptionId(heatingFeat.id, heatTitle);
          if (optId) {
            features.push({ id: heatingFeat.id, value: optId });
            console.log('[ensureRequiredFields] ✅ Added missing Heating:', heatTitle, '→ option:', optId);
          }
          break;
        }
      }
    }

    // ── Condition (id from API) — Starea apartamentului ──
    if (!hasFeature(featureApiMap["condition"]?.id) && data.condition) {
      const conditionStr = typeof data.condition === 'string' ? data.condition : (data.condition.ro || '');
      const conditionMap = {
        "Fără reparație/ Variantă albă": "Variantă albă",
        "Reparație euro": "Euroreparație",
        "Reparație medie": "Reparație cosmetică",
      };
      const mappedTitle = conditionMap[conditionStr] || conditionStr;
      for (const group of featuresIdData.features_groups) {
        const condFeat = group.features?.find(f => f.title === "Starea apartamentului");
        if (condFeat && condFeat.options) {
          const optId = findOptionId(condFeat.id, mappedTitle);
          if (optId) {
            features.push({ id: condFeat.id, value: optId });
            console.log('[ensureRequiredFields] ✅ Added missing Condition:', mappedTitle, '→ option:', optId);
          }
          break;
        }
      }
    }
  }

  console.log('[ensureRequiredFields] Final feature count:', features.length);
  return features;
}

/**
 * Build minimal fallback features from session data when the 999.md
 * features API is unavailable or fails. This creates basic feature
 * entries for essential fields (price, area, description) so the
 * listing can still be posted without full API feature data.
 *
 * @param {Object} data - ctx.session.data
 * @returns {Array<{id: string, value: string}>} - Array of feature objects
 */
function buildFallbackFeatures(data) {
  if (!data) return [];

  const fallback = [];

  // Price
  if (data.price) {
    fallback.push({ id: '12', value: `Preț: ${data.price} €` });
  }

  // Area
  if (data.area) {
    fallback.push({ id: '12', value: `Suprafață: ${data.area} m²` });
  }

  // Rooms (apartments/houses)
  if (data.rooms != null) {
    fallback.push({ id: '12', value: `${data.rooms} camere` });
  }

  // Floor (apartments)
  if (data.floor != null) {
    fallback.push({ id: '12', value: `Etaj: ${data.floor}${data.floors ? '/' + data.floors : ''}` });
  }

  // Condition
  if (data.condition?.ro || data.condition) {
    const conditionText = typeof data.condition === 'string' ? data.condition : data.condition?.ro;
    fallback.push({ id: '12', value: `Stare: ${conditionText}` });
  }

  // Building type
  if (data.building?.ro || data.building) {
    const buildingText = typeof data.building === 'string' ? data.building : data.building?.ro;
    fallback.push({ id: '12', value: `Bloc: ${buildingText}` });
  }

  // Heating
  if (data.heating?.ro || data.heating) {
    const heatText = typeof data.heating === 'string' ? data.heating : data.heating?.ro;
    fallback.push({ id: '12', value: `Încălzire: ${heatText}` });
  }

  // Balcony
  if (data.balcony != null) {
    fallback.push({ id: '12', value: `Balcon: ${data.balcony === true || data.balcony === 'da' ? 'Da' : 'Nu'}` });
  }

  // Description from data
  const desc = data.description || data.descriere || '';
  if (desc) {
    fallback.push({ id: '12', value: desc.slice(0, 500) });
  }

  // Location info
  const locationParts = [
    data.suburb?.ro || data.suburb || '',
    data.sector?.ro || data.sector || '',
    data.city || '',
  ].filter(Boolean);
  if (locationParts.length > 0) {
    fallback.push({ id: '12', value: locationParts.join(', ') });
  }

  console.log('[buildFallbackFeatures] Created', fallback.length, 'fallback features');
  return fallback;
}

// ── Helper: infer imobilType from session data when not explicitly set ──
//    Mirrors the logic in post/platforms/meta.js getMetaPropertyType().
//
//    IMPORTANT: ctx.session.imobilType can be set by multiple sources:
//    - Premier URL parsing (raw Romanian slugs e.g. "apartament", "casa")
//    - Premier category selection ("Toate apartamentele")
//    - 999.md/immobiliare/loyal scrapers (mapped English values)
//    All raw values MUST be normalized before being consumed by
//    extractFeaturesId(), which expects only: apartments, houses,
//    commercials, terrains.
//
function inferImobilType(ctx) {
  // ── Stage 1: Try ctx.session.imobilType (Premier URL or pre-set) ──
  if (ctx.session.imobilType) {
    // Comprehensive map covering ALL possible input formats:
    // Premier URL slugs, Premier category names, Romanian scraped titles, English values.
    const SESSION_TYPE_MAP = {
      // ── Premier URL slug (Romanian, from URL path segment) ──
      'apartament': 'apartments',
      'casa':       'houses',
      'casa cu':    'houses',
      'comercial':  'commercials',
      'teren':      'terrains',
      // ── Premier category display names ──
      'Toate apartamentele': 'apartments',
      'Case':               'houses',
      'Comercial':          'commercials',
      'Terenuri':           'terrains',
      // ── Romanian scraper titles (for safety) ──
      'Apartament':   'apartments',
      'Apartamente':  'apartments',
      'Casă':         'houses',
      'Case':         'houses',      // duplicate but harmless
      'Comercial':    'commercials', // duplicate but harmless
      'Imobiliare comerciale': 'commercials',
      'Teren':        'terrains',
      'Loturi de teren': 'terrains',
      // ── English values — pass through ──
      'apartments':  'apartments',
      'houses':      'houses',
      'commercials': 'commercials',
      'terrains':    'terrains',
    };

    const raw = ctx.session.imobilType;
    const normalized = SESSION_TYPE_MAP[raw];
    if (normalized) {
      console.log('[inferImobilType] Mapped imobilType:', raw, '→', normalized);
      return normalized;
    }

    // Unknown imobilType — log warning and fall through to data-based detection
    console.warn(
      '[inferImobilType] ⚠️ Unknown imobilType value:',
      JSON.stringify(raw),
      '— falling back to data field detection'
    );
  }

  // ── Stage 2: Detect from session.data fields ──
  const data = ctx.session.data;
  if (!data) return 'apartments'; // safest default

  // 999.md/immobiliare/loyal scrapers store type as display string
  const AD_TYPE_MAP = {
    'Apartament': 'apartments',
    'Casă': 'houses',
    'Comercial': 'commercials',
    'Teren': 'terrains',
    // immobiliare.md
    'Apartamente': 'apartments',
    'Case': 'houses',
    'Imobiliare comerciale': 'commercials',
    'Loturi de teren': 'terrains',
  };
  if (data.type && AD_TYPE_MAP[data.type]) return AD_TYPE_MAP[data.type];

  // Fallback: detect from data fields
  if (data.rooms != null) return 'apartments';
  if (data.house_type) return 'houses';
  if (data.commercial_destination) return 'commercials';
  if (data.terrain_destination) return 'terrains';

  return 'apartments'; // safest default
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION SAFETY LAYER v4.0
// ═══════════════════════════════════════════════════════════════════
//
// Pre-flight validation for 999.md API payload.
// Checks that all required fields are present before sending the POST request
// to prevent "Completați câmpul" and other validation errors.

const REQUIRED_FEATURES_APARTMENTS = [
  { id: "12", fieldName: "title", description: "Titlu (feature id 12)" },
  { id: "13", fieldName: "description", description: "Descriere (feature id 13)" },
  { id: "14", fieldName: "images", description: "Imagini (feature id 14)" },
  { id: "2", fieldName: "price", description: "Preț (feature id 2)" },
  { id: "244", fieldName: "area", description: "Suprafață totală (feature id 244)" },
  { id: "248", fieldName: "rooms", description: "Număr de camere (feature id 248)" },
  { id: "241", fieldName: "offerType", description: "Tip ofertă (feature id 241)" },
  { id: "7", fieldName: "location_municipality", description: "Municipiu (feature id 7)" },
  { id: "8", fieldName: "location_city", description: "Localitate (feature id 8)" },
  { id: "9", fieldName: "location_sector", description: "Sector (feature id 9)" },
  // NOTE: Phone (feature id:16) intentionally excluded — the 999.md API associates
  // the phone with the authenticated account. Sending phone in features causes
  // "Numărul de telefon nu a fost găsit" (400) error.
];

/**
 * Validate that all required features are present in the payload features array.
 * Logs missing fields for debugging.
 * @param {Array} features - The features array from the payload
 * @param {string} imobilType - The imobil type (apartments, houses, etc.)
 * @returns {Array<string>} - Array of missing field descriptions
 */
function validateRequiredFeatures(features, imobilType) {
  const missingFields = [];
  const featureIds = features.map(f => String(f.id));

  let requiredSet;
  if (imobilType === "apartments") {
    requiredSet = REQUIRED_FEATURES_APARTMENTS;
  } else {
    requiredSet = [
      { id: "12", fieldName: "title", description: "Titlu (feature id 12)" },
      { id: "13", fieldName: "description", description: "Descriere (feature id 13)" },
      { id: "14", fieldName: "images", description: "Imagini (feature id 14)" },
    ];
  }

  for (const required of requiredSet) {
    if (!featureIds.includes(required.id)) {
      missingFields.push(required.description);
      console.warn(`[validateRequiredFeatures] ❌ Missing required feature: ${required.description} (id: ${required.id})`);
    }
  }

  return missingFields;
}

/**
 * Final payload validation check before sending to 999.md API.
 * Logs a summary of the payload and any issues found.
 * @param {Object} payload - The complete payload object
 * @returns {boolean} - Whether the payload passes validation
 */
function finalPayloadValidationCheck(payload) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('🔍 [FINAL PAYLOAD VALIDATION]');
  console.log('═══════════════════════════════════════════════════════');

  const checks = [
    { field: 'category_id', passed: !!payload.category_id, value: payload.category_id },
    { field: 'subcategory_id', passed: !!payload.subcategory_id, value: payload.subcategory_id },
    { field: 'offer_type', passed: !!payload.offer_type, value: payload.offer_type },
    // NOTE: Phone is intentionally not validated here — 999.md API associates
    // the phone with the authenticated account, so we never send it in the payload.
    { field: 'features array', passed: Array.isArray(payload.features) && payload.features.length > 0, value: `${payload.features?.length || 0} features` },
  ];

  // Check specific features
  if (Array.isArray(payload.features)) {
    const featureIds = payload.features.map(f => String(f.id));
    
    checks.push({ field: 'title (id:12)', passed: featureIds.includes('12'), value: featureIds.includes('12') ? 'present' : 'MISSING' });
    checks.push({ field: 'description (id:13)', passed: featureIds.includes('13'), value: featureIds.includes('13') ? 'present' : 'MISSING' });
    checks.push({ field: 'images (id:14)', passed: featureIds.includes('14'), value: featureIds.includes('14') ? 'present' : 'MISSING' });
    checks.push({ field: 'price (id:2)', passed: featureIds.includes('2'), value: featureIds.includes('2') ? 'present' : 'MISSING' });
    // NOTE: Phone feature (id:16) validation intentionally excluded — 999.md API
    // associates phone with authenticated account; sending it causes 400 error.
    checks.push({ field: 'location municipality (id:7)', passed: featureIds.includes('7'), value: featureIds.includes('7') ? 'present' : 'MISSING' });
    checks.push({ field: 'location city (id:8)', passed: featureIds.includes('8'), value: featureIds.includes('8') ? 'present' : 'MISSING' });
    checks.push({ field: 'location sector (id:9)', passed: featureIds.includes('9'), value: featureIds.includes('9') ? 'present' : 'MISSING' });
  }

  let allPassed = true;
  for (const check of checks) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`  ${icon} ${check.field}: ${check.value}`);
    if (!check.passed) allPassed = false;
  }

  console.log('───────────────────────────────────────────────────────');
  console.log(`  📊 Result: ${allPassed ? '✅ ALL CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  return allPassed;
}

// main
const postTo999 = async (ctx) => {
  // ═══════════════════════════════════════════════════════════════════
  // VALIDATION: token_999 must exist in MongoDB session (EXCLUSIVE source)
  // The bot does NOT fall back to .env TOKEN_999 — MongoDB is the only
  // valid source for the 999.md API key.
  // ═══════════════════════════════════════════════════════════════════
  if (!ctx.session.user?.token_999) {
    console.error('❌ [postTo999] CRITICAL: No token_999 found in user session (MongoDB).');
    console.error('❌ [postTo999] The bot requires token_999 to be set in MongoDB (users collection).');
    console.error('❌ [postTo999] Add it via: db.users.updateOne({ telegramChatID: "..." }, { $set: { token_999: "YOUR_KEY" } })');
    ctx.reply('❌ Cheia API 999.md lipsește din contul tău. Adaugă token_999 în baza de date (MongoDB).');
    return null;
  }
  console.log('[postTo999] ✅ token_999 found in MongoDB session, proceeding...');

  let location;
  try {
    location = await extractRegion(ctx);
  } catch (error) {
    ctx.reply("a avut loc o eroare la extragerea locatiei");
    return console.log("Nu a fost extras linkul din baza de date: " + error);
  }
  let features;
  let featuresIdData;
  // SAFETY: infer imobilType if not set (handles 999.md/immobiliare/loyal scrapers)
  const safeImobilType = inferImobilType(ctx);
  console.log('[postTo999] imobilType resolved to:', safeImobilType);

  // ── Try 1: Normal API-based feature extraction ────────────────
  try {
    featuresIdData = await extractFeaturesId(ctx, safeImobilType);
  } catch (err) {
    // ── Try 2: AI fallback — use AI to determine correct type ──
    console.warn('[postTo999] ⚠️ Features API failed — trying AI fallback to infer type', err.message);

    try {
      // Build a short text description from session data for AI classification
      const data = ctx.session.data || {};
      const descText = [
        data.description || data.descriere || '',
        data.type || '',
        data.rooms ? `${data.rooms} camere` : '',
        data.area ? `${data.area} m²` : '',
        data.price ? `${data.price} €` : '',
        data.condition?.ro || data.condition || '',
        data.building?.ro || data.building || '',
      ].filter(Boolean).join(', ') || `imobil tip: ${safeImobilType}`;

      const aiResult = await parseWithFallback(descText, 0);

      // Try AI-determined type
      const aiType = aiResult.type || safeImobilType;
      console.log('[postTo999] 🤖 AI determined type:', aiType);

      if (aiType && aiType !== safeImobilType) {
        console.log('[postTo999] 🔄 Retrying with AI-determined type:', aiType);
        featuresIdData = await extractFeaturesId(ctx, aiType);
      } else {
        // AI confirmed same type — re-throw original error
        throw err;
      }
    } catch (aiErr) {
      // ── Try 3: Final fallback — create minimal features from session data ──
      console.warn('[postTo999] ❌ AI fallback also failed — using minimal features from session data');
      console.error('[postTo999] AI fallback error:', aiErr.message);

      // Create minimal features from data fields (no API data needed)
      const fallbackFeatures = buildFallbackFeatures(ctx.session.data);
      if (fallbackFeatures && fallbackFeatures.length > 0) {
        features = fallbackFeatures;
        console.log('[postTo999] ✅ Created', features.length, 'fallback features from session data');
      } else {
        console.log('[postTo999] ❌ Cannot create fallback features — aborting');
        return console.log("nu au putut fi extrase caracteristicile");
      }
    }
  }

  // If we got featuresIdData from API, run the normal extractFeatures
  if (featuresIdData) {
    try {
      features = extractFeatures(ctx.session.data, featuresIdData, ctx);
      console.log('[extractFeatures] Initial features count:', features.length, features);

      // BUG FIX v3.1: ensureRequiredFields fills in missing critical fields
      // that extractFeatures may have skipped due to findFeatureByTitle mismatches.
      // This adds features like price (id:2), area (id:244), rooms (id:248),
      // floor (id:9), bathrooms (id:249), building (id:852), etc.
      features = ensureRequiredFields(features, featuresIdData, ctx.session.data, safeImobilType);
      console.log('[extractFeatures] After ensureRequiredFields — features count:', features.length);
    } catch (extractErr) {
      console.error('[postTo999] extractFeatures failed:', extractErr.message);
      // Fallback to minimal features
      const fallbackFeatures = buildFallbackFeatures(ctx.session.data);
      if (fallbackFeatures && fallbackFeatures.length > 0) {
        features = fallbackFeatures;
        console.log('[postTo999] ✅ Created', features.length, 'fallback features after extractFeatures failure');
      } else {
        return console.log("nu au putut fi extrase caracteristicile");
      }
    }
  }
  // BUG v2.1 FIXED: Changed ctx.session.data.thumbnails → ctx.session.data.images
  // The scraper sets ctx.session.data.images, but the code was reading
  // ctx.session.data.thumbnails which was undefined, resulting in 0 uploaded images.
  const uploadedImagesIds = []; // Array to hold the uploaded image IDs
  const imagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];

  console.log("");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`📤 [999.md] UPLOAD ${imagesToUpload.length} IMAGINI`);
  console.log("───────────────────────────────────────────────────────────");

  let uploadIndex = 0;
  for (const image of imagesToUpload) {
    uploadIndex++;
    // Support both string URLs and { url } objects
    const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
    if (imageUrl) {
      // Upload image and collect the uploaded image ID
      console.log(`  📤 [${uploadIndex}/${imagesToUpload.length}] Upload: ${imageUrl.slice(0, 60)}...`);
      const imageId = await uploadImageFromURL999(ctx, imageUrl);
      if (imageId) {
        uploadedImagesIds.push(imageId);
        console.log(`  ✅ [${uploadIndex}/${imagesToUpload.length}] ID: ${imageId}`);
      } else {
        console.log(`  ❌ [${uploadIndex}/${imagesToUpload.length}] Eșuat`);
      }
    }
  }
  console.log(`📊 [999.md] Upload complet: ${uploadIndex} procesate, ${uploadedImagesIds.length} succes`);
  console.log("───────────────────────────────────────────────────────────");
  // Log the uploaded image IDs
  let subcategory;
  let desc;

  // ── DYNAMIC CATEGORY & SUBCATEGORY RESOLUTION ──
  // Use the new resolveCategoryId() and resolveSubcategoryId() helpers
  // instead of hardcoded "270" for category_id.
  // This allows posting to ANY 999.md category, not just Imobiliare.
  // ──────────────────────────────────────────────────────────────────
  const categoryId = resolveCategoryId(ctx);
  const subcategoryId = resolveSubcategoryId(ctx, categoryId);

  console.log('[postTo999] 🏷️ Category:', categoryId, '(' + (CATEGORY_BY_ID[categoryId]?.title || 'unknown') + ')');
  console.log('[postTo999] 🏷️ Subcategory:', subcategoryId || 'NOT SET');

  if (categoryId === "270") {
    // ── Imobiliare — use existing description logic ──
    const sessionData = ctx.session.data || {};
    if (ctx.session.imobilType === "apartments") {
      subcategory = "1404";
      // Use human-readable location names instead of numeric IDs from location array
      const cityName = sessionData.parsedLocation?.city || sessionData.region?.[1] || location[1]?.value || '';
      const sectorName = sessionData.parsedLocation?.sector || sessionData.region?.[2] || location[2]?.value || '';
      desc = `În vânzare apartament${
        sessionData.apartament_sery
          ? `, seria ${sessionData.apartament_sery.serie}`
          : ""
      }, amplasat în ${cityName}, ${sectorName}.
          Locuința se desfășoară pe o suprafață de ${
            sessionData.area
          } m², localizat la etajul ${sessionData.floor} din ${
        sessionData.floors
      }, fiind compartimentată în: ${
        sessionData.rooms == 1
          ? "1 cameră"
          : `${sessionData.rooms} camere`
      }, bucătărie,
           ${
             sessionData.bathrooms == 1
               ? "1 bloc sanitar"
               : `${sessionData.bathrooms} blocuri sanitare`
           } și antreu.`;
    } else if (ctx.session.imobilType === "houses") {
      subcategory = "1406";
      // Use human-readable location names instead of numeric IDs from location array
      const cityName = sessionData.parsedLocation?.city || sessionData.region?.[1] || location[1]?.value || '';
      const sectorName = sessionData.parsedLocation?.sector || sessionData.region?.[2] || location[2]?.value || '';
      desc = `În vânzare casă${
        sessionData.house_type
          ? `, tip ${sessionData.house_type}`
          : ""
      }, amplasată în ${cityName}, ${sectorName}.
          Locuința se desfășoară pe o suprafață de ${
            sessionData.area
          } m², dispune de ${
        sessionData.floors
      } etaje, fiind compartimentată în: ${
        sessionData.rooms == 1
          ? "1 cameră"
          : `${sessionData.rooms} camere`
      }, bucătărie,
           ${
             sessionData.bathrooms == 1
               ? "1 grup sanitar"
               : `${sessionData.bathrooms} grupuri sanitare`
           }.`;
    } else if (ctx.session.imobilType === "commercials") {
      subcategory = "1405";
      desc = `În vânzare spațiu comercial${
        ctx.session.data.commercial_destination?.ro
          ? `, tip ${ctx.session.data.commercial_destination.ro}`
          : ""
      }, amplasat în ${
        ctx.session.data.suburb
          ? ctx.session.data.suburb.ro
          : ctx.session.data.sector?.ro || ""
      }.
          Spațiul comercial are o suprafață de ${ctx.session.data.area} m².`;
    } else if (ctx.session.imobilType === "terrains") {
      subcategory = "1407";
      desc = `În vânzare teren${
        ctx.session.data.terrain_destination?.ro
          ? `, tip ${ctx.session.data.terrain_destination.ro}`
          : ""
      }, amplasat în ${
        ctx.session.data.suburb
          ? ctx.session.data.suburb.ro
          : ctx.session.data.sector?.ro || ""
      }.
          Terenul are o suprafață de ${ctx.session.data.area} m².`;
    }
  } else {
    // ── Non-Imobiliare category — use generic description from session data ──
    subcategory = subcategoryId;
    desc = ctx.session.data.description ||
           ctx.session.data.descriere ||
           ctx.session.data.desc_ro ||
           `Anunț în categoria ${CATEGORY_BY_ID[categoryId]?.title || categoryId}`;
  }

  console.log(features);

  // ═══════════════════════════════════════════════════════════════════
  // TITLE (feature id: 12) — REQUIRED per API docs
  // ═══════════════════════════════════════════════════════════════════
  // ⚠️ REGULĂ STRICTĂ: Pentru categoria Imobiliare (270), titlul trebuie
  // să aibă MAXIM 5-7 cuvinte. Fără preț, suprafață, camere, locație.
  //
  // FORMATUL CORECT:
  //   - "În vânzare apartament"
  //   - "Vând apartament"
  //   - "Apartament de vânzare"
  //   - "În vânzare casă"
  //   - "Casă de vânzare"
  //
  // CE NU TREBUIE SĂ FIE:
  //   - Fără preț
  //   - Fără suprafață
  //   - Fără număr camere
  //   - Fără cartier/sector
  //   - Fără număr de telefon
  // ═══════════════════════════════════════════════════════════════════
  const SHORT_TITLE_MAP = {
    'apartments': ['În vânzare apartament', 'Vând apartament', 'Apartament de vânzare'],
    'houses':     ['În vânzare casă', 'Vând casă', 'Casă de vânzare'],
    'commercials': ['În vânzare spațiu comercial', 'Vând spațiu comercial', 'Spațiu comercial de vânzare'],
    'terrains':   ['În vânzare teren', 'Vând teren', 'Teren de vânzare'],
  };

  let titleValue;
  const safeType = safeImobilType || inferImobilType(ctx);
  const shortTitles = SHORT_TITLE_MAP[safeType] || SHORT_TITLE_MAP.apartments;

  // Rotate through short title variants based on first letter of content hash
  // to avoid identical titles for every post
  const contentStr = JSON.stringify(ctx.session.data || {});
  const titleIndex = contentStr.length % shortTitles.length;
  const enforcedShortTitle = shortTitles[titleIndex];

  if (categoryId === "270") {
    // Imobiliare — FORCE short title (max 5-7 cuvinte)
    titleValue = enforcedShortTitle;
    console.log(`[postTo999] 🏷️ Titlu scurt forțat (imobiliare): "${titleValue}"`);
  } else if (ctx.session.data.title_ro && ctx.session.data.title_ru) {
    titleValue = {
      ro: ctx.session.data.title_ro,
      ru: ctx.session.data.title_ru,
    };
  } else if (ctx.session.data.title) {
    titleValue = ctx.session.data.title;
  } else {
    titleValue = enforcedShortTitle;
  }

  // ═══════════════════════════════════════════════════════════════════
  // DESCRIPTION (feature id: 13)
  // ═══════════════════════════════════════════════════════════════════
  // API supports the same two formats as title:
  //   1. Multilingual object: { "ro": "Descriere RO", "ru": "Описание RU" }
  //   2. Simple string: "Descriere RO"
  // ═══════════════════════════════════════════════════════════════════
  let descriptionValue;
  const hasBilingualDesc = ctx.session.data.desc_ro && ctx.session.data.desc_ru;
  if (hasBilingualDesc) {
    descriptionValue = {
      ro: ctx.session.data.desc_ro,
      ru: ctx.session.data.desc_ru,
    };
  } else {
    // Use the dynamically built Romanian description (single language)
    descriptionValue = desc;
  }

  // ═══════════════════════════════════════════════════════════════════
  // AUTHOR TYPE (feature id: 795) — Determines posting cost on 999.md
  // ═══════════════════════════════════════════════════════════════════
  // Options from 999.md API:
  //   "18894": "Агентство" (Agency) — HIGHER posting cost
  //   "20364": "Застройщик" (Developer) — HIGHER posting cost
  //   "18895": "Частное лицо" (Private person) — LOWER posting cost
  //
  // BUG FIX: Make author type configurable. For accounts with low balance,
  // use private person ("18895") to reduce cost. Agency costs more.
  // ═══════════════════════════════════════════════════════════════════
  // Priority: 1) ctx.session.data.authorType  2) env var  3) default "18894" (agency)
  const envAuthorType = process.env.AUTHOR_TYPE_999 || null;
  const authorTypeId = ctx.session.data?.authorType_999 || envAuthorType || "18894";
  console.log(`[postTo999] 👤 Author type: ${authorTypeId} (agency=18894, private=18895)`);

  // ═══════════════════════════════════════════════════════════════════
  // PRE-FLIGHT BALANCE CHECK (BUG FIX: prevent "insufficient balance")
  // ═══════════════════════════════════════════════════════════════════
  let balance = null;
  try {
    const cashResp = await axios.get("https://partners-api.999.md/cash", {
      headers: { "Content-Type": "application/json" },
      auth: {
        username: ctx.session.user.token_999,
        password: "",
      },
      timeout: 10000,
    });
    balance = cashResp.data?.cash;
    console.log(`[postTo999] 💰 Balance: ${balance !== null ? balance : 'UNKNOWN'}`);
  } catch (cashErr) {
    console.warn(`[postTo999] ⚠️ Could not check balance: ${cashErr.message}`);
  }

  // ── If balance is 0 or very low, warn but still attempt post ──
  if (balance !== null && balance <= 0) {
    console.error(`[postTo999] ❌ CRITICAL: Balance is ZERO (${balance}). Post will likely fail with "insufficient balance".`);
  } else if (balance !== null && balance < 5) {
    console.warn(`[postTo999] ⚠️ WARNING: Very low balance (${balance}). Post may fail.`);
  }

  // NOTE: Phone number is intentionally NOT included in the payload.
  // The 999.md API associates the phone with the authenticated account.
  // Sending phone in the payload causes "Numărul de telefon nu a fost găsit" (400) error.
  // Phone number (phoneNr) is kept in session.data for Telegram display only.
  // ═══════════════════════════════════════════════════════════════════
  // VALIDATE REQUIRED FEATURES v4.0
  // Check for missing required fields before building payload
  // ═══════════════════════════════════════════════════════════════════
  const allFeatures = [
    ...(features || []),
    ...(location || []),
  ];
  const missingRequiredFields = validateRequiredFeatures(allFeatures, safeImobilType);

  // ═══════════════════════════════════════════════════════════════════
  // FAILSAFE v4.0: Abort if critical features are missing
  // ═══════════════════════════════════════════════════════════════════
  // BUG FIX v4.0: If feature_id "9" (sector) cannot be resolved, do NOT send the request.
  // This prevents "Completați câmpul" validation errors.
  // ═══════════════════════════════════════════════════════════════════
  const hasSectorFeature9 = allFeatures.some(f => String(f.id) === '9');
  if (!hasSectorFeature9 && safeImobilType === 'apartments') {
    console.error('═══════════════════════════════════════════════════════');
    console.error('❌ [FAILSAFE v4.0] CRITICAL: Feature id "9" (sector/location) is MISSING.');
    console.error('❌ [FAILSAFE v4.0] The 999.md API requires this field for apartments.');
    console.error('❌ [FAILSAFE v4.0] Attempted locations:', JSON.stringify(location));
    console.error('❌ [FAILSAFE v4.0] Cannot send request — aborting to prevent validation error.');
    console.error('═══════════════════════════════════════════════════════');
    ctx.reply('❌ Eroare: Sectorul nu a putut fi determinat. Verificați datele de localizare.');
    return null;
  }

  const objectToSend = {
    category_id: categoryId, // Now dynamic — resolved via resolveCategoryId()
    subcategory_id: subcategory || subcategoryId,
    offer_type: "776", //vand
    // NOTE: Top-level "phone" field intentionally omitted — the 999.md API
    // associates the phone with the authenticated account automatically.
    // Including it causes "Numărul de telefon nu a fost găsit" (400) error.
    features: [
      {
        id: "795", // Contributor (author type): agency=18894, private=18895
        value: authorTypeId,
      },
      // ── Title (id: 12) — REQUIRED per API docs ──
      {
        id: "12",
        value: titleValue,
      },
      // ── Description (id: 13) ──
      {
        id: "13",
        value: descriptionValue,
      },
      // ── Images (id: 14) — REQUIRED per API docs ──
      {
        id: "14", //imagini
        value:
          uploadedImagesIds.length > 0
            ? uploadedImagesIds.map((id) => `${id}`)
            : [],
      },
      ...features,
      ...location,
    ],
  };

  // ═══════════════════════════════════════════════════════════════════
  // FINAL PAYLOAD VALIDATION CHECK v4.0
  // ═══════════════════════════════════════════════════════════════════
  // Logs a detailed check of all required fields before sending
  const validationPassed = finalPayloadValidationCheck(objectToSend);

  if (!validationPassed && missingRequiredFields.length > 0) {
    console.warn(`[postTo999] ⚠️ Payload validation found ${missingRequiredFields.length} missing fields, but proceeding with request.`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // DEBUG: Log full payload for audit
  // ═══════════════════════════════════════════════════════════════════
  console.log("═══════════════════════════════════════════════════════");
  console.log("📦 [999.md] FINAL PAYLOAD:");
  console.log(JSON.stringify(objectToSend, null, 2));
  console.log("═══════════════════════════════════════════════════════");

  try {
    const post = await axios.post(
      "https://partners-api.999.md/adverts",
      objectToSend,
      {
        headers: { "Content-Type": "application/json" },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    console.log("✅ [999.md] Postare reușită! ID:", post.data.advert.id);
    ctx.reply("✅ Postarea valabila la: https://999.md/ro/" + post.data.advert.id);
    return post.data.advert.id;
  } catch (postError) {
    // ── Error handling: log full API response body for debugging ──
    if (postError.response) {
      const status = postError.response.status;
      const responseBody = postError.response.data;
      const errorMsg = responseBody?.error || "unknown";

      console.error("❌ [999.md] API error response status:", status);
      console.error("❌ [999.md] API error response body:", JSON.stringify(responseBody, null, 2));

      // ── INSUFFICIENT BALANCE — provide actionable guidance ──
      if (errorMsg === "insufficient balance") {
        console.error("═══════════════════════════════════════════════════════");
        console.error("💰 [999.md] INSUFFICIENT BALANCE DETECTED");
        console.error("💰 Account balance:", balance);
        console.error("💰 Author type used:", authorTypeId, "(agency=18894, private=18895)");
        console.error("💰 FIXES:");
        console.error("💰   1. Top up account at https://partners-api.999.md");
        console.error("💰   2. Set AUTHOR_TYPE_999=18895 in .env (private person = cheaper)");
        console.error(`💰   3. Run: node verify999Api.js`);
        console.error("═══════════════════════════════════════════════════════");

        ctx.reply(
          `❌ Fonduri insuficiente pe 999.md.\n` +
          `Sold: ${balance !== null ? balance : "necunoscut"}\n` +
          `Tip autor: ${authorTypeId === "18894" ? "Agenție" : "Persoană privată"}\n` +
          `➡️ Completați soldul la https://partners-api.999.md\n` +
          `➡️ Sau setați AUTHOR_TYPE_999=18895 în .env`
        );
      } else {
        ctx.reply(`❌ Eroare la postarea pe 999.md: ${errorMsg || `Status ${status}`}. Verificați log-urile.`);
      }
    } else if (postError.request) {
      console.error("❌ [999.md] No response received:", postError.message);
      ctx.reply("❌ Nu s-a primit răspuns de la serverul 999.md. Verificați conexiunea.");
    } else {
      console.error("❌ [999.md] Post error:", postError.message);
      ctx.reply("❌ Eroare la postarea pe 999.md: " + postError.message);
    }
    return null;
  }
};

module.exports = { postTo999 };
