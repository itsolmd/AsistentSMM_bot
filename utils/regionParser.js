/**
 * utils/regionParser.js
 *
 * INTELLIGENT REGION PARSER for Moldova (Republic of Moldova) addresses.
 *
 * v2.1 — FULL STREET-LEVEL PRECISION
 *   • Extracts: municipality, city, sector, street, streetNumber
 *   • Normalizes street prefixes (str. → Tudor Vladimirescu)
 *   • Supports street numbers: 38, 38a, 38/1, 38-B
 *   • Deduplicates municipality/city when identical
 *   • buildGeoAddress() for precise geocoding queries
 *
 * BUG FIXED:
 *   Input: "Sculeni, Chișinău, Chișinău mun."
 *   OLD (wrong): Municipality=Sculeni, City=Chișinău, Sector=Chișinău mun.
 *   NEW (correct): City=Chișinău, Sector=Sculeni, Municipality=Chișinău mun.
 *
 * KNOWNSECTORS for Chișinău:
 *   Sculeni, Botanica, Ciocana, Buiucani, Râșcani, Centru,
 *   Telecentru, Poșta Veche, Aeroport, etc.
 *
 * HOW IT WORKS:
 *   1. Split address by comma
 *   2. Identify known sectors (suburbs/districts of Chișinău)
 *   3. Identify "mun." keywords for municipality
 *   4. Identify streets (str., strada, bd., bulevard, etc.)
 *   5. Smart ordering: City → Sector → Street → Number
 *   6. Normalize street prefixes for clean output
 *
 * USAGE:
 *   const { parseLocation, formatLocation, buildGeoAddress } = require('./utils/regionParser');
 *   const result = parseLocation("Chișinău mun., Chișinău, Buiucani, str. Tudor Vladimirescu, 38a");
 *   // → { city: "Chișinău", sector: "Buiucani", municipality: "Chișinău mun.",
 *   //    street: "str. Tudor Vladimirescu", streetNumber: "38a",
 *   //    original: "Chișinău mun., Chișinău, Buiucani, str. Tudor Vladimirescu, 38a" }
 *
 *   buildGeoAddress(result)
 *   // → "Tudor Vladimirescu 38a, Buiucani, Chișinău, Moldova"
 */

/* =================================================================
 * KNOWN SECTORS OF CHIȘINĂU
 * ================================================================= */
const KNOWN_SECTORS = new Set([
  // Major sectors
  'botanica', 'ciocana', 'buiucani', 'râșcani', 'rîșcani', 'centru',
  // Sub-sectors / micro-districts
  'telecentru', 'poșta veche', 'posta veche', 'aeroport',
  'sculeni', 'durlesti', 'durlești', 'trușeni', 'truseni',
  'cricova', 'vadul lui vodă', 'vadul lui voda',
  'codru', 'singera', 'șingera', 'vatra',
  'băcioi', 'bacioi', 'brăila', 'braila', 'budești', 'budesti',
  'bubuieci', 'colonița', 'colonita', 'condrița', 'condrita',
  'crucești', 'crucesti', 'ghetău', 'ghetao',
  'dobrogea', 'frumoasa', 'ghidighici', 'grătiești', 'gratiesti',
  'hulboaca', 'joc', 'johănești', 'johanesti',
  'muncești', 'muncesti', 'revaca', 'sîngera', 'singera',
  'stăuceni', 'stauceni', 'străisteni', 'straisteni',
  'tohatin', 'țânțăreni', 'tantareni',
  // Streets identified as landmarks (but these are street names, not sectors)
]);

/* =================================================================
 * KNOWN MUNICIPALITY KEYWORDS
 * ================================================================= */
const MUNICIPALITY_KEYWORDS = ['mun.', 'municipiu', 'municipiul'];

/* =================================================================
 * STREET PREFIXES
 * ================================================================= */
const STREET_PREFIXES = ['str.', 'strada', 'bd.', 'bulevardul', 'bulevard',
  'aleea', 'alee', 'intrarea', 'intrare',
  'șoseaua', 'soseaua', 'șos.', 'sos.',
  'calea', 'cal.',
  // Russian prefixes for mixed-language addresses
  'ул.', 'улица',
  'бул.', 'бульвар',
  'пер.', 'переулок',
  'просп.', 'проспект',
  'ш.', 'шоссе'];
const STREET_PREFIX_REGEX = new RegExp(`^(${STREET_PREFIXES.join('|')})\\s`, 'i');

/* =================================================================
 * STREET NUMBER REGEX — supports 38, 38a, 38/1, 38-B
 * ================================================================= */
const STREET_NUMBER_REGEX = /^\d+[A-Za-z]?(?:\/\d+)?(?:-[A-Za-z0-9]+)?$/;

/* =================================================================
 * MD_PHONE_REGEX — Moldovan phone numbers
 * ================================================================= */
const MD_PHONE_REGEX = /(?:\+?373|0)\s*\d[\d\s]{6,}/;

/* =================================================================
 * 1. isKnownSector(token)
 * -----------------------------------------------------------------
 * Checks if a token (lowercased, trimmed) is a known Chișinău sector.
 * ================================================================= */
function isKnownSector(token) {
  if (!token || typeof token !== 'string') return false;
  return KNOWN_SECTORS.has(token.toLowerCase().trim());
}

/* =================================================================
 * 2. isMunicipality(token)
 * -----------------------------------------------------------------
 * Checks if a token contains municipality keywords like "mun.".
 * ================================================================= */
function isMunicipality(token) {
  if (!token || typeof token !== 'string') return false;
  const lower = token.toLowerCase().trim();
  return MUNICIPALITY_KEYWORDS.some(kw => lower.includes(kw));
}

/* =================================================================
 * 3. isStreet(token)
 * -----------------------------------------------------------------
 * Checks if a token starts with a street prefix like "str." or "strada".
 * ================================================================= */
function isStreet(token) {
  if (!token || typeof token !== 'string') return false;
  return STREET_PREFIX_REGEX.test(token.trim());
}

/* =================================================================
 * 4. normalizeStreetPrefix(street)
 * -----------------------------------------------------------------
 * Strips street prefixes like "str.", "strada", "bd." from the
 * beginning of a street name.
 *
 * @param {string} street - Raw street string (e.g., "str. Tudor Vladimirescu")
 * @returns {string|null} Normalized street name (e.g., "Tudor Vladimirescu")
 * ================================================================= */
function normalizeStreetPrefix(street) {
  if (!street || typeof street !== 'string') return null;
  return street.replace(STREET_PREFIX_REGEX, '').trim();
}

/* =================================================================
 * 5. parseLocation(locationStr)
 * -----------------------------------------------------------------
 * Parses a raw location string into structured components.
 *
 * @param {string} locationStr - Raw location from 999.md
 *   Examples:
 *     "Sculeni, Chișinău, Chișinău mun."
 *     "Chișinău, Centru"
 *     "Chișinău mun., Chișinău, Botanica, str. Mihai Eminescu, 28"
 *     "Chișinău, str. Calea Ieșilor, 6"
 *     "Chișinău mun., Chișinău, Buiucani, str. Tudor Vladimirescu, 38a"
 *
 * @returns {Object} {
 *   city: string|null,
 *   sector: string|null,
 *   municipality: string|null,
 *   street: string|null,
 *   streetNumber: string|null,
 *   original: string,
 * }
 * ================================================================= */
function parseLocation(locationStr) {
  const result = {
    city: null,
    sector: null,
    municipality: null,
    street: null,
    streetNumber: null,
    original: locationStr || '',
  };

  if (!locationStr || typeof locationStr !== 'string') {
    console.warn('⚠️ [parseLocation] Invalid input:', locationStr);
    return result;
  }

  // Normalize whitespace
  const cleaned = locationStr.replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(',').map(p => p.trim()).filter(p => p.length > 0);

  console.log('🔍 [parseLocation] Raw parts:', JSON.stringify(parts));

  // ── Step 1: Identify municipality ─────────────────────────────
  const munIndex = parts.findIndex(p => isMunicipality(p));
  if (munIndex !== -1) {
    result.municipality = parts[munIndex];
  }

  // ── Step 2: Identify street and number ────────────────────────
  const streetIndex = parts.findIndex(p => isStreet(p));
  if (streetIndex !== -1) {
    result.street = parts[streetIndex];
    // Check if next part looks like a number (e.g., "6", "28", "38a", "38/1", "38-B")
    if (streetIndex + 1 < parts.length) {
      const nextPart = parts[streetIndex + 1];
      if (STREET_NUMBER_REGEX.test(nextPart)) {
        result.streetNumber = nextPart;
      }
    }
  }

  // ── Step 3: Identify known sectors ────────────────────────────
  const sectorIndex = parts.findIndex(p => isKnownSector(p));
  if (sectorIndex !== -1) {
    result.sector = parts[sectorIndex];
  }

  // ── Step 4: Identify city ─────────────────────────────────────
  // City is usually "Chișinău" — look for it
  const cityIndex = parts.findIndex(p => {
    const lower = p.toLowerCase().trim();
    return lower === 'chișinău' || lower === 'chisinau' || lower === 'chişinău';
  });
  if (cityIndex !== -1) {
    result.city = parts[cityIndex];
  }

  // ── Step 5: Deduplicate municipality vs city ──────────────────
  // If municipality contains the city name (e.g., "Chișinău mun." and "Chișinău"),
  // keep both but they are semantically distinct roles
  if (result.municipality && result.city) {
    const munCity = result.municipality.replace(/\s*mun\.?\s*/i, '').trim().toLowerCase();
    const cityLower = result.city.toLowerCase().trim();
    if (munCity === cityLower) {
      // Both refer to the same place — keep municipality as the full form
      // city stays as-is for display purposes
      console.log('🔍 [parseLocation] Municipality and city match — keeping both roles');
    }
  }

  // ── Step 6: Fallback logic ────────────────────────────────────
  // If we have municipality but no city, city might be embedded in municipality
  // e.g., "Chișinău mun." → city = "Chișinău"
  if (!result.city && result.municipality) {
    const munCity = result.municipality.replace(/\s*mun\.?\s*/i, '').trim();
    if (munCity && munCity.length > 0) {
      result.city = munCity;
    }
  }

  // If we still have no city, try to find any part that looks like a city name
  if (!result.city) {
    const cityFallback = parts.find(p => {
      const lower = p.toLowerCase().trim();
      return !isKnownSector(p) && !isMunicipality(p) && !isStreet(p) && !STREET_NUMBER_REGEX.test(p);
    });
    if (cityFallback) result.city = cityFallback;
  }

  // ── DEBUG LOG ─────────────────────────────────────────────────
  console.log('[ADDRESS PARSER] Parsed:', JSON.stringify(result));

  return result;
}

/* =================================================================
 * 6. formatLocation(parsed, includeStreet = true)
 * -----------------------------------------------------------------
 * Formats the parsed location into the desired output.
 *
 * RULES:
 *   Without street:  "Chișinău, Sculeni"
 *   With street:     "Chișinău, Sculeni, str. Calea Ieșilor, 6"
 *   Only city:       "Chișinău"
 *   Only sector:     "Chișinău, Sculeni"
 * ================================================================= */
function formatLocation(parsed, includeStreet = true) {
  if (!parsed || typeof parsed !== 'object') return 'N/A';

  const parts = [];

  // Always include city if available
  if (parsed.city) {
    parts.push(parsed.city);
  }

  // Include sector if available
  if (parsed.sector) {
    parts.push(parsed.sector);
  }

  // Include street + number if requested and available
  if (includeStreet && parsed.street) {
    parts.push(parsed.street);
    if (parsed.streetNumber) {
      parts.push(parsed.streetNumber);
    }
  }

  const formatted = parts.join(', ');

  console.log(`🔍 [formatLocation] Parsed: ${JSON.stringify(parsed)} → "${formatted}"`);

  return formatted || 'N/A';
}

/* =================================================================
 * 7. buildGeoAddress(parsed)
 * -----------------------------------------------------------------
 * Builds a FULL geocoding address from parsed location components.
 * Used for precise map.md API queries.
 *
 * Format: "street streetNumber, sector, city, Moldova"
 * Example: "Tudor Vladimirescu 38a, Buiucani, Chișinău, Moldova"
 *
 * If street/number are missing, falls back to "sector, city, Moldova"
 * or "city, Moldova".
 *
 * @param {Object} parsed - Result from parseLocation()
 * @returns {string} Full geocoding address string
 * ================================================================= */
function buildGeoAddress(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[buildGeoAddress] Invalid parsed object, using fallback');
    return 'Chișinău, Moldova';
  }

  // ── Normalize street prefix ──────────────────────────────────
  // Handle Romanian: "strada Ialoveni" → "str. Ialoveni"
  // Handle Russian:  "ул. Каля Ешилор" → "str. Calea Ieșilor" (prefix only)
  // Handle no prefix: "Tudor Vladimirescu" → "Tudor Vladimirescu"
  let normalizedStreet = parsed.street
    ?.replace(/^strada\s+/i, "str. ")
    ?.replace(/^str\s+/i, "str. ")
    ?.replace(/^улица\s+/i, "str. ")   // Russian full form
    ?.replace(/^ул\.?\s*/i, "str. ")   // Russian abbreviation (ул. or ул)
    ?.trim();

  // Also produce a version WITHOUT any street prefix for map.md
  const streetWithoutPrefix = normalizedStreet
    ?.replace(/^(str\.|strada)\s+/i, '')
    ?.trim();

  // Combine street and number into a single item: "str. Ialoveni 136"
  const streetLine = normalizedStreet
    ? `${normalizedStreet}${parsed.streetNumber ? ` ${parsed.streetNumber}` : ""}`
    : null;

  // Version without prefix: "Calea Ieșilor 6" (sometimes map.md prefers this)
  const streetNoPrefixLine = streetWithoutPrefix
    ? `${streetWithoutPrefix}${parsed.streetNumber ? ` ${parsed.streetNumber}` : ""}`
    : null;

  // ── Build Romanian-style address (recommended for map.md) ────
  const parts = [
    streetLine,
    parsed.sector,
    parsed.city,
    'Moldova',
  ].filter(Boolean);

  // If we have street-level data, use full address
  if (streetLine) {
    const geoAddress = parts.join(', ');
    console.log('[GEO ADDRESS] Primary address (with prefix):', geoAddress);
    console.log('[GEO ADDRESS] Alternative address (no prefix):',
      [streetNoPrefixLine, parsed.sector, parsed.city, 'Moldova'].filter(Boolean).join(', '));
    return geoAddress;
  }

  // Fallback: sector + city (or just city)
  const fallbackParts = [
    parsed.sector,
    parsed.city,
    'Moldova',
  ].filter(Boolean);

  const fallbackAddress = fallbackParts.join(', ') || 'Chișinău, Moldova';
  console.log('[GEO ADDRESS] Fallback address (no street):', fallbackAddress);
  return fallbackAddress;
}

/* =================================================================
 * 8. getLocationArrayForFilter(parsed, ctx)
 * -----------------------------------------------------------------
 * Returns the location array in the order expected by filters.js:
 *   [municipality, city, sector, street, streetNumber]
 *
 * BUG FIXED: The old code used parts[0]=municipality, parts[1]=city, parts[2]=sector,
 *   but the actual data had Sculeni in parts[0] (which was treated as municipality).
 *   Now we explicitly set the order based on parsed semantic roles.
 * ================================================================= */
function getLocationArrayForFilter(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return ['Chișinău mun.', 'Chișinău', 'Centru'];
  }

  return [
    parsed.municipality || 'Chișinău mun.',
    parsed.city || 'Chișinău',
    parsed.sector || 'Centru',
    parsed.street || null,
    parsed.streetNumber || null,
  ].filter(item => item !== null && item !== undefined);
}

/* =================================================================
 * EXPORTS
 * ================================================================= */
module.exports = {
  parseLocation,
  formatLocation,
  buildGeoAddress,
  normalizeStreetPrefix,
  getLocationArrayForFilter,
  isKnownSector,
  isMunicipality,
  isStreet,
  KNOWN_SECTORS,
};
