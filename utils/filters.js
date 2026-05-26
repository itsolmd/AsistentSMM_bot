const { default: axios } = require("axios");
const {
  parsePriceToNumber,
  safeNumber,
  cleanEscapedText,
} = require('./cleaners');

// ═══════════════════════════════════════════════════════════════════════════════
// REGULA 5 - STRUCTURA OBLIGATORIE FILTRU IMOBILIAR
// ═══════════════════════════════════════════════════════════════════════════════
// Definiește schema standard pentru un filtru de căutare imobiliară.
// Toate funcțiile de validare și generare filtru trebuie să respecte această structură.
//
// Câmpuri obligatorii:
//   tip_oferta  – unul din cele 6 tipuri de ofertă
//   pret.min    – preț minim (sau null)
//   pret.max    – preț maxim (sau null)
//   pret.interval_delta – marja implicită de ±5000
// ═══════════════════════════════════════════════════════════════════════════════
const FILTER_STRUCTURE = {
  tip_oferta: ["Vând", "Cumpăr", "De închiriat pe zi", "De închiriat lunar", "Închiriez", "Schimb"],
  pret: {
    min: "number | null",
    max: "number | null",
    interval_delta: 5000,
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// REGULA 2 - TIP OFERTĂ (OBLIGATORIU)
// ═══════════════════════════════════════════════════════════════════════════════
// Mapare denumire afișată → ID 999.md API pentru filtrul URL.
// NOTĂ: "De închiriat pe zi" și "De închiriat lunar" se mapează la același ID 779
// (tipul general "Închiriez" în 999.md), iar diferențierea pe durată se face
// prin alte feature-uri (preț/zi vs. preț/lună).
// ═══════════════════════════════════════════════════════════════════════════════
const OFFER_TYPES = [
  { id: 776, label: "Vând" },
  { id: 777, label: "Cumpăr" },
  { id: 780, label: "De închiriat pe zi" },   // mapped to 999.md rental (daily variant)
  { id: 781, label: "De închiriat lunar" },     // mapped to 999.md rental (monthly variant)
  { id: 779, label: "Închiriez" },
  { id: 778, label: "Schimb" },
];

// Quick lookup: label → ID
const OFFER_TYPE_MAP = Object.fromEntries(
  OFFER_TYPES.map((ot) => [ot.label.toLowerCase(), ot.id])
);

// Quick lookup: ID → label
const OFFER_TYPE_ID_TO_LABEL = Object.fromEntries(
  OFFER_TYPES.map((ot) => [ot.id, ot.label])
);

// ═══════════════════════════════════════════════════════════════════════════════
// REGULA 3 & 4 - VALIDARE FILTRU
// ═══════════════════════════════════════════════════════════════════════════════
// validateFilter() verifică dacă datele conțin câmpurile obligatorii.
// Returnează:
//   { valid: true, structuredFilter: {...} }   – dacă totul este complet
//   { valid: false, message: "..." }           – dacă lipsește ceva (REGULA 4)
// ═══════════════════════════════════════════════════════════════════════════════
function validateFilter(input) {
  const errors = [];

  // ── Verifică tip ofertă ──────────────────────────────────────────
  // BUG FIX v3.1: If offerType label is "N/A" but offerTypeId is valid,
  // resolve the label from OFFER_TYPE_ID_TO_LABEL map.
  // BUG FIX v4.0: If offerType is unknown/garbage, default to "Vând"
  // instead of failing validation. This prevents the filter from being
  // completely unavailable when the scraper returns bad data.
  let offerTypeLabel = input?.offerType || input?.tip_oferta || null;
  if ((!offerTypeLabel || offerTypeLabel === "N/A") && input?.offerTypeId != null) {
    const resolvedLabel = OFFER_TYPE_ID_TO_LABEL[input.offerTypeId];
    if (resolvedLabel) {
      offerTypeLabel = resolvedLabel;
      console.log(`🔍 [validateFilter] Resolved offerType from ID ${input.offerTypeId} → "${resolvedLabel}"`);
    }
  }

  if (!offerTypeLabel || offerTypeLabel === "N/A") {
    // Offer type is missing entirely — default to "Vând" (most common)
    console.warn('⚠️ [validateFilter] offerType missing — defaulting to "Vând"');
    offerTypeLabel = "Vând";
  } else {
    const normalized = offerTypeLabel.toLowerCase().trim();
    const isValid = OFFER_TYPES.some(
      (ot) => ot.label.toLowerCase() === normalized
    );
    if (!isValid) {
      // Offer type is garbage/unknown (e.g. scraper extracted wrong data)
      console.warn(`⚠️ [validateFilter] Unrecognized offerType "${offerTypeLabel}" — defaulting to "Vând"`);
      offerTypeLabel = "Vând";
    }
  }

  // ── Verifică preț ─────────────────────────────────────────────────
  const priceNum =
    input?.priceNumeric != null
      ? safeNumber(input.priceNumeric)
      : input?.price
        ? parsePriceToNumber(input.price)
        : null;

  // Prețul nu este obligatoriu (poate fi căutare fără interval),
  // dar dacă există, trebuie să fie un număr valid.
  if (priceNum != null && (isNaN(priceNum) || priceNum < 0)) {
    errors.push({
      field: "pret",
      message: `Prețul specificat ("${input.price || input.priceNumeric}") nu este un număr valid.`,
    });
  }

  // ── Rezultat validare ─────────────────────────────────────────────
  if (errors.length > 0) {
    // REGULA 4: Format răspuns când lipsește ceva
    let response = "Corect. La formarea filtrului trebuie adăugat:\n";

    for (const err of errors) {
      if (err.field === "tip_oferta") {
        response += `1. Tip ofertă: (selectează una din: ${FILTER_STRUCTURE.tip_oferta.join(", ")})\n`;
      } else if (err.field === "pret") {
        const pNum =
          input?.priceNumeric != null
            ? safeNumber(input.priceNumeric)
            : input?.price
              ? parsePriceToNumber(input.price)
              : null;
        const fromPrice = pNum != null ? Math.max(0, pNum - 5000) : "?";
        const toPrice = pNum != null ? pNum + 5000 : "?";
        response += `2. Interval preț: ${fromPrice} - ${toPrice} (cu opțiunea de ±5000)\n`;
      } else {
        response += `- ${err.field}: ${err.message}\n`;
      }
    }

    return {
      valid: false,
      message: response.trim(),
      errors,
    };
  }

  // ── Construiește obiectul structurat (REGULA 5) ────────────────────
  const structuredFilter = {
    tip_oferta: offerTypeLabel,
    pret: {
      min: priceNum != null ? Math.max(0, priceNum - 5000) : null,
      max: priceNum != null ? priceNum + 5000 : null,
      interval_delta: 5000,
    },
  };

  return {
    valid: true,
    structuredFilter,
    priceNum,
    offerTypeLabel,
  };
}

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
    fields.push({ id: "7", value: raionID });
    return fields;
  }

  if (!Array.isArray(resSector?.data?.Options)) {
    console.error(`❌ [getLocationArray] Lista de sectoare pentru orașul "${city}" nu este validă!`);
    fields.push({ id: "7", value: raionID });
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
    fields.push({ id: "7", value: raionID });
    return fields;
  }

  const sectorID = sectorOption.id;
  fields.push({ id: "7", value: raionID });
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

    // ═══════════════════════════════════════════════════════════════════
    // REGULA 3 - VALIDARE: Verifică dacă tipul ofertei este prezent
    // ═══════════════════════════════════════════════════════════════════
    const validation = validateFilter(adData);
    if (!validation.valid) {
      console.warn("⚠️ [getFilter] Validation failed:", validation.message);
      // BUG FIX v4.0: Return an object (NOT a JSON string) for consistency.
      // The old behavior returned a JSON string which broke sendFilter's
      // result?.filterUrl access (string.filterUrl is undefined).
      // Now callers can always do result.filterUrl safely.
      return {
        filterUrl: "",
        error: "VALIDATION_FAILED",
        message: validation.message,
        structuredFilter: FILTER_STRUCTURE,
      };
    }

    const { structuredFilter, priceNum, offerTypeLabel } = validation;

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
    const effectivePriceNum = priceNum != null
      ? priceNum
      : adData.priceNumeric != null
        ? safeNumber(adData.priceNumeric)
        : parsePriceToNumber(adData.price);
    console.log("🔍 [getFilter] Parsed price:", adData.price, "→ numeric:", effectivePriceNum);

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
    // Determină ID-ul ofertei din label (REGULA 2)
    const offerTypeLabelLower = offerTypeLabel.toLowerCase().trim();
    const offerTypeId = OFFER_TYPE_MAP[offerTypeLabelLower] || 776;
    console.log("🔍 [getFilter] Offer type label:", offerTypeLabel, "→ ID:", offerTypeId);

    // ── HEATING (feature 2203) ───────────────────────────────────
    // Map Strapi heating ID (1=Autonomă, 2=Centralizată) to 999.md filter option ID.
    // Returns null when option ID is unknown — the caller skips the filter param.
    // TODO: Replace null with actual 999.md filter option IDs once verified via API.
    const getHeatingFilterOptionId = (heatingId) => {
      if (heatingId === 1) return null;  // Autonomă — option ID unknown
      if (heatingId === 2) return null;  // Centralizată — option ID unknown
      return null;
    };
    const heatingOptionId = adData.heating != null ? getHeatingFilterOptionId(adData.heating) : null;
    console.log("🔍 [getFilter] Heating ID:", adData.heating, "→ filter option:", heatingOptionId, "(null = skipped)");

    // ── BALCONY (feature 1192) ───────────────────────────────────
    // Map Strapi balcony ID (1=Da, 2=Nu) to 999.md filter option ID.
    // Returns null when option ID is unknown — the caller skips the filter param.
    // TODO: Replace null with actual 999.md filter option IDs once verified via API.
    const getBalconyFilterOptionId = (balconyId) => {
      if (balconyId === 1) return null;  // Da/Balcon — option ID unknown
      if (balconyId === 2) return null;  // Nu/Fără balcon — option ID unknown
      return null;
    };
    const balconyOptionId = adData.balcony != null ? getBalconyFilterOptionId(adData.balcony) : null;
    console.log("🔍 [getFilter] Balcony ID:", adData.balcony, "→ filter option:", balconyOptionId, "(null = skipped)");

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

    // ══════════════════════════════════════════════════════════════
    // REGULA 1 - INTERVAL PREȚ: ±5000 față de valoarea căutată
    // ══════════════════════════════════════════════════════════════
    // Intervalul implicit sugerat: [valoarea_cautată - 5000] până la [valoarea_cautată + 5000]
    // Dacă prețul nu este disponibil, se omite filtrul de preț.
    const PRICE_OFFSET = 5000;
    let fromPrice, toPrice;

    if (effectivePriceNum != null && !isNaN(effectivePriceNum) && effectivePriceNum > 0) {
      fromPrice = Math.max(0, effectivePriceNum - PRICE_OFFSET);
      toPrice = effectivePriceNum + PRICE_OFFSET;
      console.log("🔍 [getFilter] Price range (±5000):", fromPrice, "—", toPrice, "(base:", effectivePriceNum, ")");
    } else {
      fromPrice = 0;
      toPrice = 0;
      console.log("🔍 [getFilter] No valid price — price filter omitted");
    }

    // ── BUILD FILTER URL ─────────────────────────────────────────
    // Format exact conform cerințelor: ofertă → locație → preț → camere → etaj → suprafață → stare → bloc
    let init = `https://999.md/ro/list/real-estate/apartments-and-rooms?hide_duplicates=no&applied=1&show_all_checked_childrens=no&ef=33,32,31,30,2307,1073,2203,1074,1191,1192&o_16_1=${offerTypeId}&eo=${
      region.map(r => r.value).join(',')
     }&r_31_2_unit=eur&r_1073_244_unit=m2&o_30_241=${getNumberOfRoomsFromString(
      adData.rooms
     )}&o_32_9=${region[2].value}&from_1073_244=${Math.max(0, areaNum - 5)}&to_1073_244=${areaNum + 5}&unit_1073_244=meter_square&o_1074_253=${conditionOptionId}&o_1191_248=${
      `${floorNum !== 1 ? getNumberOfFloorsFromString(floorNum - 1) + "," : ""}` +
      getNumberOfFloorsFromString(floorNum) +
      `${floorNum !== 25 ? "," + getNumberOfFloorsFromString(floorNum + 1) : ""}`
     }&o_2307_852=${buildingOptionId}`;

    // Adaugă intervalul de preț doar dacă avem o valoare validă
    if (fromPrice > 0 || toPrice > 0) {
      init += `&from_9441_2=${fromPrice}&to_9441_2=${toPrice}&unit_9441_2=eur`;
    }

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
    console.log("[DEBUG v3.0] Offer type ID:", offerTypeId, "(from label:", offerTypeLabel, ")");
    console.log("[DEBUG v3.0] Heating ID:", adData.heating, "→ filter option:", heatingOptionId);
    console.log("[DEBUG v3.0] Balcony ID:", adData.balcony, "→ filter option:", balconyOptionId);
    console.log("[DEBUG v3.0] Building option:", buildingOptionId);
    console.log("[DEBUG v3.0] Condition option:", conditionOptionId);
    console.log("[DEBUG v3.0] Price range:", fromPrice, "—", toPrice);
    console.log("[DEBUG v3.0] Final filter URL:", init);
    console.log("[DEBUG v3.0] =======================");

    // ══════════════════════════════════════════════════════════════
    // REGULA 5 - Returnează și obiectul structurat al filtrului
    // ══════════════════════════════════════════════════════════════
    const result = {
      filterUrl: init,
      structuredFilter: {
        tip_oferta: offerTypeLabel,
        pret: {
          min: fromPrice > 0 ? fromPrice : null,
          max: toPrice > 0 ? toPrice : null,
          interval_delta: PRICE_OFFSET,
        },
      },
    };

    return result;
  } catch (error) {
    console.error("❌ [getFilter] Error generating filter URL:", error.message);
    console.error(error.stack);
    return {
      filterUrl: "",
      error: error.message,
      structuredFilter: FILTER_STRUCTURE,
    };
  }
};

module.exports = {
  getFilter,
  validateFilter,
  FILTER_STRUCTURE,
  OFFER_TYPES,
  OFFER_TYPE_MAP,
  OFFER_TYPE_ID_TO_LABEL,
};
