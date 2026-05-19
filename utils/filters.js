





const { default: axios } = require("axios");
const {
  parsePriceToNumber,
  safeNumber,
  cleanEscapedText,
} = require('./cleaners');

function extractStreet(address) {
  const match = address.match(/((?:str\.|ул\.|strada)\s[^,]*?)(?=\s\d+|$)/i);
  return match ? match[1].trim() : null;
}
const getNumberOfRoomsFromString = (str) => {
  const options = [
    {
      id: "908",
      title: "O cameră",
    },
    {
      id: "893",
      title: "Apartament cu 1 cameră",
    },
    {
      id: "894",
      title: "Apartament cu 2 camere",
    },
    {
      id: "902",
      title: "Apartament cu 3 camere",
    },
    {
      id: "904",
      title: "Apartament cu 4 camere",
    },
    {
      id: "20442",
      title: "Apartament cu 5 camere sau mai multe",
    },
  ];

  // 🛡️ Handle null/undefined/NaN
  if (str === null || str === undefined || str === "N/A") {
    console.warn("⚠️ [getNumberOfRoomsFromString] Invalid input, defaulting to 1 cameră:", str);
    str = 1;
  }

  const numStr = String(str);
  if (numStr == 1) {
    str = "Apartament cu 1 cameră";
  } else {
    str = `Apartament cu ${numStr} camere`;
  }
  const matchedItem = options.find((item) => item.title === str);

  // Check if a match was found
  if (matchedItem) {
    return matchedItem.id;
  } else {
    // 🛡️ NEVER throw — return default instead
    console.warn("⚠️ [getNumberOfRoomsFromString] No match found for:", str, "— using default 'O cameră'");
    return "908"; // Default: "O cameră"
  }
};

const getNumberOfFloorsFromString = (str) => {
  const options = [
    {
      id: "977",
      title: "Subsol",
    },
    {
      id: "973",
      title: "Demisol",
    },
    {
      id: "918",
      title: "1",
    },
    {
      id: "935",
      title: "2",
    },
    {
      id: "905",
      title: "3",
    },
    {
      id: "929",
      title: "4",
    },
    {
      id: "909",
      title: "5",
    },
    {
      id: "955",
      title: "6",
    },
    {
      id: "895",
      title: "7",
    },
    {
      id: "921",
      title: "8",
    },
    {
      id: "934",
      title: "9",
    },
    {
      id: "947",
      title: "10",
    },
    {
      id: "970",
      title: "11",
    },
    {
      id: "965",
      title: "12",
    },
    {
      id: "958",
      title: "13",
    },
    {
      id: "913",
      title: "14",
    },
    {
      id: "1016",
      title: "15",
    },
    {
      id: "1019",
      title: "16",
    },
    {
      id: "940",
      title: "17",
    },
    {
      id: "1021",
      title: "18",
    },
    {
      id: "1015",
      title: "19",
    },
    {
      id: "1681",
      title: "20",
    },
    {
      id: "1679",
      title: "21",
    },
    {
      id: "12484",
      title: "22",
    },
    {
      id: "12485",
      title: "23",
    },
    {
      id: "1661",
      title: "24",
    },
    {
      id: "1014",
      title: "25",
    },
    {
      id: "12487",
      title: "Penthouse",
    },
    {
      id: "12486",
      title: "Mansardă",
    },
  ];
  // 🛡️ Safe find with fallback
  const match = options.find((item) => item.title == `${str}`);
  if (!match) {
    console.warn("⚠️ [getNumberOfFloorsFromString] No match for floor:", str, "— defaulting to 1");
    return "918"; // Default: floor 1
  }
  return match.id;
};
const getNumberOfTotalFloorsFromString = (str) => {
  const options = [
    {
      id: "956",
      title: "1",
    },
    {
      id: "964",
      title: "2",
    },
    {
      id: "906",
      title: "3",
    },
    {
      id: "936",
      title: "4",
    },
    {
      id: "910",
      title: "5",
    },
    {
      id: "919",
      title: "6",
    },
    {
      id: "971",
      title: "7",
    },
    {
      id: "975",
      title: "8",
    },
    {
      id: "896",
      title: "9",
    },
    {
      id: "951",
      title: "10",
    },
    {
      id: "948",
      title: "11",
    },
    {
      id: "954",
      title: "12",
    },
    {
      id: "966",
      title: "13",
    },
    {
      id: "959",
      title: "14",
    },
    {
      id: "979",
      title: "15",
    },
    {
      id: "914",
      title: "16",
    },
    {
      id: "1018",
      title: "17",
    },
    {
      id: "1017",
      title: "18",
    },
    {
      id: "982",
      title: "19",
    },
    {
      id: "972",
      title: "20",
    },
    {
      id: "963",
      title: "21",
    },
    {
      id: "1020",
      title: "22",
    },
    {
      id: "1680",
      title: "23",
    },
    {
      id: "941",
      title: "24",
    },
    {
      id: "1668",
      title: "25",
    },
  ];

  // 🛡️ Safe find with fallback
  const match = options.find((item) => item.title === `${str}`);
  if (!match) {
    console.warn("⚠️ [getNumberOfTotalFloorsFromString] No match for total floors:", str, "— defaulting to 1");
    return "956"; // Default: floor 1
  }
  return match.id;
};

const DEFAULT_CITY_ID = "12900"; // Chișinău mun.

/**
 * Case-insensitive partial match helper.
 * Returns true if `target` contains `query` (case-insensitive, trimmed).
 */
function fuzzyMatch(target, query) {
  if (!target || !query) return false;
  return target.toLowerCase().trim().includes(query.toLowerCase().trim());
}

const getLocationArray = async (str, ctx) => {
  // 🛡️ DEFENSIVE CHECK: log full input when crash happens
  console.log("🔍 [getLocationArray] Input received:", JSON.stringify(str));
  console.log("🔍 [getLocationArray] Input type:", typeof str);

  if (!str || !Array.isArray(str)) {
    console.error("❌ [getLocationArray] Invalid input — expected array, got:", typeof str, str);
    return [{ id: DEFAULT_CITY_ID, value: DEFAULT_CITY_ID }]; // fallback to Chișinău
  }

  // Filter out undefined/null items
  const parts = str.filter(item => item !== null && item !== undefined);
  if (parts.length < 3) {
    console.error("❌ [getLocationArray] Array too short (need ≥3 items):", parts);
    return [{ id: DEFAULT_CITY_ID, value: DEFAULT_CITY_ID }]; // fallback to Chișinău
  }

  const municipality = parts[0];
  const city = parts[1];
  const sector = parts[2];
  const fields = [];

  const optionsLocalitates = [
    { id: "12900", title: "Chișinău mun." },
  ];

  // 🛡️ Debug: log supported locations
  console.log("🔍 [getLocationArray] Supported locations:", JSON.stringify(optionsLocalitates));

  // 🛡️ Find municipality — case-insensitive + partial match
  let municipii = optionsLocalitates.find((item) => item.title === municipality);
  if (!municipii) {
    // Try case-insensitive exact match
    municipii = optionsLocalitates.find(
      (item) => item.title.toLowerCase() === municipality.toLowerCase()
    );
  }
  if (!municipii) {
    // Try partial match (e.g., "Sculeni" contains nothing from "Chișinău mun." — this won't match either)
    municipii = optionsLocalitates.find((item) =>
      fuzzyMatch(item.title, municipality) || fuzzyMatch(municipality, item.title)
    );
  }
  if (!municipii) {
    console.warn("⚠️ [getLocationArray] Municipiul negăsit, folosesc Chișinău ca fallback:", municipality);
    // Fallback: use default Chișinău
    municipii = { id: DEFAULT_CITY_ID, title: "Chișinău mun." };
  }
  const municipiiID = municipii.id;

  fields.push({ id: "7", value: `${municipiiID}` });

  // ── Fetch raion (city/district) from 999.md API ──────────────
  let resRaion;
  try {
    resRaion = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=${"1404"}&dependency_feature_id=7&parent_option_id=${municipiiID}&lang=ro`,
      {
        headers: { "Content-Type": "application/json" },
        auth: {
          username: ctx?.session?.user?.token_999,
          password: "",
        },
        timeout: 15000,
      }
    );
  } catch (axiosErr) {
    console.error("❌ [getLocationArray] Axios error fetching raion:", axiosErr.message);
    return [{ id: "7", value: municipiiID }];
  }

  console.log("Municipality:", municipality);
  console.log("City:", city);
  console.log("Sector:", sector);
  console.log("Street:", parts[3]);
  console.log("Număr:", parts[4]);
  console.log("🔍 Raion options:", resRaion?.data?.Options);
  console.log("📦 din Filters.js Răspuns complet de la dependent_options:", resRaion?.data);

  if (!resRaion?.data?.Options || !Array.isArray(resRaion.data.Options)) {
    console.error(`❌ [getLocationArray] Opțiunile pentru raion nu au fost returnate pentru municipiul ${municipiiID}`);
    return [{ id: "7", value: municipiiID }];
  }

  // 🛡️ Find raion — case-insensitive + partial match
  let raionOption = resRaion.data.Options.find((item) => item.title === city);
  if (!raionOption) {
    raionOption = resRaion.data.Options.find(
      (item) => item.title.toLowerCase() === city.toLowerCase()
    );
  }
  if (!raionOption) {
    raionOption = resRaion.data.Options.find((item) =>
      fuzzyMatch(item.title, city) || fuzzyMatch(city, item.title)
    );
  }
  if (!raionOption) {
    console.warn(`⚠️ [getLocationArray] Orașul/raionul "${city}" nu a fost găsit. Se folosește primul raion disponibil.`);
    // Fallback: use first available option
    raionOption = resRaion.data.Options[0];
    if (!raionOption) {
      return [{ id: "7", value: municipiiID }];
    }
  }
  const raionID = raionOption.id;

  // ── Fetch sector from 999.md API ─────────────────────────────
  let resSector;
  try {
    resSector = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=${"1404"}&dependency_feature_id=8&parent_option_id=${raionID}&lang=ro`,
      {
        headers: { "Content-Type": "application/json" },
        auth: {
          username: ctx?.session?.user?.token_999,
          password: "",
        },
        timeout: 15000,
      }
    );
  } catch (axiosErr) {
    console.error("❌ [getLocationArray] Axios error fetching sectors:", axiosErr.message);
    // Non-critical: return fields without sector
    fields.push({ id: "7", value: municipiiID });
    return fields;
  }

  if (!Array.isArray(resSector?.data?.Options)) {
    console.error(`❌ [getLocationArray] Lista de sectoare pentru orașul "${city}" nu este validă!`);
    fields.push({ id: "7", value: municipiiID });
    return fields;
  }

  // 🛡️ Find sector — case-insensitive + partial match
  let sectorOption = resSector.data.Options.find(
    (item) => item.title && item.title.trim() === (sector ? sector.trim() : "")
  );
  if (!sectorOption) {
    sectorOption = resSector.data.Options.find(
      (item) => item.title && item.title.toLowerCase().trim() === (sector ? sector.toLowerCase().trim() : "")
    );
  }
  if (!sectorOption) {
    sectorOption = resSector.data.Options.find((item) =>
      item.title && (fuzzyMatch(item.title, sector) || fuzzyMatch(sector, item.title))
    );
  }

  if (!sectorOption) {
    console.log("⚠️ [getLocationArray] Sectorul nu a fost găsit. Opțiuni disponibile:");
    resSector.data.Options.forEach(opt => console.log(`  - ${opt.title}`));
    // Non-critical: return fields without sector rather than crash
    fields.push({ id: "7", value: municipiiID });
    return fields;
  }

  const sectorID = sectorOption.id;
  fields.push({ id: "7", value: municipiiID });
  fields.push({ id: "10", value: sectorID });

  return fields;
};
//end inlocuire
const DEFAULT_FILTER_REGION = [
  { id: "7", value: "12900" },   // Chișinău mun.
  { id: "7", value: "12900" },   // Chișinău (same ID for city level)
  { id: "10", value: "12900" },  // Chișinău (sector fallback)
];

const getFilter = async (adData, ctx) => {
  try {
    // 🛡️ Debug log: filter input object
    console.log("🔍 [getFilter] Function called.");
    console.log("🔍 [getFilter] Input adData:", JSON.stringify(adData, null, 2));
    console.log("🔍 [getFilter] adData.region:", adData.region);

    if (!adData || !adData.region) {
      console.error("❌ [getFilter] adData or adData.region is missing:", adData);
      adData = adData || {};
      adData.region = ["Chișinău mun.", "Chișinău", "Centru"];
    }

    // 🛡️ Debug log: region input before getLocationArray
    console.log("🔍 [getFilter] Region input before getLocationArray:", JSON.stringify(adData.region));
    let region = await getLocationArray(adData.region, ctx);
    console.log("🔍 [getFilter] Region after getLocationArray:", region);

    // 🛡️ If region is empty or too short, use DEFAULT fallback
    if (!region || region.length < 3) {
      console.warn("⚠️ [getFilter] Region array too short. Using DEFAULT Chișinău fallback.");
      region = DEFAULT_FILTER_REGION;
    }

    // ── Build filter URL with guaranteed valid region ──────────
    console.log("Suprafață totală in filter.js:", adData.area);
    console.log("Stare apartament:", adData.condition);

    const regionId = region[0].value;
    const cityId = region[1].value;

    console.log("Filters.js regionId:", regionId);
    console.log("Filters.js cityId:", cityId);
    console.log("Filters.js region[0]:", region[0]);
    console.log("Filters.js region[1]:", region[1]);
    console.log("Filters.js region[2]:", region[2]);

    // ── SAFE PRICE (BUG #8 FIXED) ───────────────────────────────
    // Use priceNumeric if available (from new scraper), otherwise parse the price string
    const priceNum = adData.priceNumeric != null
      ? safeNumber(adData.priceNumeric)
      : parsePriceToNumber(adData.price);
    console.log("🔍 [getFilter] Parsed price:", adData.price, "→ numeric:", priceNum);

    // ── SAFE FLOOR (BUG #6 FIXED) ───────────────────────────────
    // Convert floor to NUMBER to prevent string concatenation (floor + 1 → "61")
    const floorNum = safeNumber(adData.floor, 1);
    console.log("🔍 [getFilter] Floor (safe numeric):", adData.floor, "→", floorNum, typeof floorNum);

    // ── SAFE AREA ────────────────────────────────────────────────
    const areaNum = safeNumber(adData.area, 50);
    console.log("🔍 [getFilter] Area (safe numeric):", adData.area, "→", areaNum);

    // ══════════════════════════════════════════════════════════════
    // FILTER URL PARAMETER HELPERS (BUG FIX v3.0)
    // ══════════════════════════════════════════════════════════════

    // ── OFFER TYPE (feature 33) ──────────────────────────────────
    // 776 = Vând, 779 = Închiriez, 777 = Cumpăr, 778 = Schimb
    const offerTypeId = adData.offerTypeId || 776;
    console.log("🔍 [getFilter] Offer type ID:", offerTypeId);

    // ── HEATING (feature 2203) ───────────────────────────────────
    // Map Strapi heating ID (1=Autonomă, 2=Centralizată) to 999.md filter option ID
    // TODO: Verify these option IDs by querying 999.md API
    const getHeatingFilterOptionId = (heatingId) => {
      if (heatingId === 1) return 'TODO_AUTONOMOUS_OPTION_ID';  // Autonomă
      if (heatingId === 2) return 'TODO_CENTRALIZED_OPTION_ID'; // Centralizată
      return null;
    };
    const heatingOptionId = adData.heating != null ? getHeatingFilterOptionId(adData.heating) : null;
    console.log("🔍 [getFilter] Heating ID:", adData.heating, "→ filter option:", heatingOptionId);

    // ── BALCONY (feature 1192) ───────────────────────────────────
    // Map Strapi balcony ID (1=Da, 2=Nu) to 999.md filter option ID
    // TODO: Verify these option IDs by querying 999.md API
    const getBalconyFilterOptionId = (balconyId) => {
      if (balconyId === 1) return 'TODO_YES_OPTION_ID';  // Da/Balcon
      if (balconyId === 2) return 'TODO_NO_OPTION_ID';   // Nu/Fără balcon
      return null;
    };
    const balconyOptionId = adData.balcony != null ? getBalconyFilterOptionId(adData.balcony) : null;
    console.log("🔍 [getFilter] Balcony ID:", adData.balcony, "→ filter option:", balconyOptionId);

    // ── BUILDING TYPE ────────────────────────────────────────────
    // Normalize building string for comparison (handle object {ro: "..."} or string)
    let buildingStr = '';
    if (typeof adData.building === 'string') {
      buildingStr = adData.building;
    } else if (adData.building?.ro) {
      buildingStr = adData.building.ro;
    } else {
      buildingStr = String(adData.building || '');
    }
    const isNewBuilding = buildingStr.toLowerCase().includes('construcţii noi') ||
                          buildingStr.toLowerCase().includes('constructii noi') ||
                          buildingStr.toLowerCase().includes('bloc nou');
    const buildingOptionId = isNewBuilding ? "19108" : "19109";
    console.log("🔍 [getFilter] Building:", buildingStr, "→ isNew:", isNewBuilding, "→ option:", buildingOptionId);

    // ── CONDITION ────────────────────────────────────────────────
    // Normalize condition string for comparison
    let conditionStr = '';
    if (typeof adData.condition === 'string') {
      conditionStr = adData.condition;
    } else if (adData.condition?.ro) {
      conditionStr = adData.condition.ro;
    } else {
      conditionStr = String(adData.condition || '');
    }
    const isWhiteVariant = conditionStr.toLowerCase().includes('variantă albă') ||
                           conditionStr.toLowerCase().includes('varianta alba') ||
                           conditionStr.toLowerCase().includes('fără reparaţie') ||
                           conditionStr.toLowerCase().includes('fara reparatie');
    const conditionOptionId = isWhiteVariant ? "925" : "916";
    console.log("🔍 [getFilter] Condition:", conditionStr, "→ isWhiteVariant:", isWhiteVariant, "→ option:", conditionOptionId);

    // ── BUILD FILTER URL ─────────────────────────────────────────
    let init = `https://999.md/ro/list/real-estate/apartments-and-rooms?hide_duplicates=no&applied=1&show_all_checked_childrens=no&ef=33,32,31,30,2307,1073,2203,1074,1191,1192&o_33_1=${offerTypeId}&eo=${
      region.map(r => r.value).join(',')
     }&o_32_9_${region[0].value}_${region[1].value}=${
      region[2].value
     }&from_6_2=${Math.max(0, Math.round(priceNum * 0.8))}&to_6_2=${Math.max(Math.round(priceNum * 1.2), 100)}&r_31_2_unit=eur&o_30_241=${getNumberOfRoomsFromString(
      adData.rooms
     )}&o_2307_852=${buildingOptionId}&o_1074_253=${conditionOptionId}&from_1073_244=${Math.max(0, areaNum - 5)}&to_1073_244=${areaNum + 5}&r_1073_244_unit=m2&o_1191_248=${
      `${floorNum !== 1 ? getNumberOfFloorsFromString(floorNum - 1) + "," : ""}` +
      getNumberOfFloorsFromString(floorNum) +
      `${floorNum !== 25 ? "," + getNumberOfFloorsFromString(floorNum + 1) : ""}`
     }`;

    // Append heating filter if option ID is known
    if (heatingOptionId && !heatingOptionId.startsWith('TODO_')) {
      init += `&o_2203_XXX=${heatingOptionId}`;
    }

    // Append balcony filter if option ID is known
    if (balconyOptionId && !balconyOptionId.startsWith('TODO_')) {
      init += `&o_1192_XXX=${balconyOptionId}`;
    }

    // ══════════════════════════════════════════════════════════════
    // DEBUG LOG: Final filter URL (BUG FIX v3.0)
    // ══════════════════════════════════════════════════════════════
    console.log("[DEBUG v3.0] === FILTER URL DEBUG ===");
    console.log("[DEBUG v3.0] Offer type ID:", offerTypeId);
    console.log("[DEBUG v3.0] Heating ID:", adData.heating, "→ filter option:", heatingOptionId);
    console.log("[DEBUG v3.0] Balcony ID:", adData.balcony, "→ filter option:", balconyOptionId);
    console.log("[DEBUG v3.0] Building option:", buildingOptionId);
    console.log("[DEBUG v3.0] Condition option:", conditionOptionId);
    console.log("[DEBUG v3.0] Final filter URL:", init);
    console.log("[DEBUG v3.0] =======================");

    return init;
  } catch (error) {
    console.error("❌ [getFilter] Error generating filter URL:", error.message);
    console.error(error.stack);
    return ""; // Return empty string instead of undefined to prevent further crashes
  }
};

module.exports = {
  getFilter,
};
