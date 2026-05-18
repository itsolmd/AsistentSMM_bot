/**
 * ════════════════════════════════════════════════════════════════
 * AI PARSER — Regex fallback parser & data normalizer
 * ════════════════════════════════════════════════════════════════
 *
 * Provides:
 * 1. fallbackParse() — Regex-based extraction when all AI models fail
 * 2. normalizeParsedData() — Normalizes AI JSON response into a
 *    consistent structured format expected by the posting pipeline
 */

const logger = require('../logger');

// ── Real estate field patterns (Romanian + English) ──
const PATTERNS = {
  price: [
    /(?:preț|price|cost|pret|preţ)\s*[:\-]?\s*([\d\s,.]+)\s*(?:€|eur|euro|lei|mdl)?/i,
    /([\d\s,.]+)\s*(?:€|eur|euro)\s*(?:\/lună|\/month)?/i,
    /(?:€|eur|euro)\s*([\d\s,.]+)/i,
  ],
  area: [
    /(?:suprafață|suprafata|area|size|surface)\s*[:\-]?\s*([\d\s,.]+)\s*(?:m²|mp|m2|sqm|metri pătrați)/i,
    /([\d\s,.]+)\s*(?:m²|mp|m2|sqm)/i,
  ],
  rooms: [
    /(?:camere|rooms|odai|număr de camere|nr\.?\s*camere)\s*[:\-]?\s*(\d+)/i,
    /(\d+)\s*(?:camere|rooms|odai)/i,
  ],
  floor: [
    /(?:etaj|floor|nivel)\s*[:\-]?\s*(\d+)/i,
    /etaj\s*(\d+)/i,
  ],
  totalFloors: [
    /(?:total\s*etaje|număr\s*etaje|floors|nivele)\s*[:\-]?\s*(\d+)/i,
    /din\s*(\d+)/i,
  ],
  condition: [
    /(?:stare|condition|starea)\s*[:\-]?\s*([^,\n]+)/i,
  ],
  building: [
    /(?:tip\s*bloc|building\s*type|bloc|building)\s*[:\-]?\s*([^,\n]+)/i,
  ],
  balcony: [
    /(?:balcon|balcony|logie)\s*[:\-]?\s*([^,\n]+)/i,
  ],
  heating: [
    /(?:încălzire|heating|termoficare|centrală)\s*[:\-]?\s*([^,\n]+)/i,
  ],
};

/**
 * Extract a single value using a set of regex patterns
 *
 * @param {string} text - Raw text to search
 * @param {Array<RegExp>} patterns - Array of regex patterns
 * @returns {string|null} - First match or null
 */
function extractByPatterns(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return null;
}

/**
 * Clean a numeric string: remove spaces, replace comma with dot
 *
 * @param {string} value - Raw numeric string
 * @returns {number|null} - Parsed number or null
 */
function cleanNumeric(value) {
  if (!value) return null;
  const cleaned = value
    .replace(/\s+/g, '')          // remove spaces
    .replace(',', '.')            // comma → dot
    .replace(/[^0-9.]/g, '');    // remove non-numeric
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Regex-based fallback parser — used when ALL AI models fail
 *
 * @param {string} text - Raw real estate text
 * @param {number} imageCount - Number of images (for context)
 * @returns {Object} - Structured real estate data
 */
function fallbackParse(text, imageCount = 0) {
  logger.info('AI_PARSER', 'Using regex fallback parser');

  const result = {
    price: cleanNumeric(extractByPatterns(text, PATTERNS.price)),
    area: cleanNumeric(extractByPatterns(text, PATTERNS.area)),
    rooms: cleanNumeric(extractByPatterns(text, PATTERNS.rooms)),
    floor: cleanNumeric(extractByPatterns(text, PATTERNS.floor)),
    totalFloors: cleanNumeric(extractByPatterns(text, PATTERNS.totalFloors)),
    condition: extractByPatterns(text, PATTERNS.condition),
    building: extractByPatterns(text, PATTERNS.building),
    balcony: extractByPatterns(text, PATTERNS.balcony),
    heating: extractByPatterns(text, PATTERNS.heating),
    _source: 'regex_fallback',
    _imageCount: imageCount,
  };

  // Infer property type from keywords
  if (/\b(apartament|apartment|apartamente)\b/i.test(text)) {
    result.type = 'apartments';
  } else if (/\b(casa|casă|house|vila|vilă)\b/i.test(text)) {
    result.type = 'houses';
  } else if (/\b(comercial|birou|office|magazin|shop|spațiu)\b/i.test(text)) {
    result.type = 'commercials';
  } else if (/\b(teren|land|lot|parcel|pamant|pământ)\b/i.test(text)) {
    result.type = 'terrains';
  }

  logger.info('AI_PARSER', 'Regex fallback result', {
    hasPrice: !!result.price,
    hasArea: !!result.area,
    type: result.type,
  });

  return result;
}

/**
 * Normalize AI parsed JSON data into a consistent format
 * expected by the posting pipeline (999.md / Meta / Premier)
 *
 * @param {Object} raw - Raw JSON from AI model
 * @returns {Object} - Normalized structured data
 */
function normalizeParsedData(raw) {
  if (!raw || typeof raw !== 'object') {
    logger.warn('AI_PARSER', 'normalizeParsedData received non-object', { type: typeof raw });
    return {};
  }

  const normalized = {
    // ── Core fields ──
    type:           raw.type || raw.property_type || raw.imobilType || null,
    price:          parseFloat(raw.price) || parseFloat(raw.pret) || null,
    currency:       raw.currency || 'EUR',
    area:           parseFloat(raw.area) || parseFloat(raw.suprafata) || null,
    areaUnit:       raw.areaUnit || raw.unitate || 'm²',

    // ── Apartment-specific ──
    rooms:          parseInt(raw.rooms, 10) || parseInt(raw.camere, 10) || null,
    floor:          parseInt(raw.floor, 10) || parseInt(raw.etaj, 10) || null,
    totalFloors:    parseInt(raw.totalFloors, 10) || parseInt(raw.totalEtaje, 10) || null,
    building:       raw.building || raw.bloc || raw.buildingType || null,

    // ── House-specific ──
    house_type:     raw.house_type || raw.houseType || raw.tipCasa || null,
    landArea:       parseFloat(raw.landArea) || parseFloat(raw.terenArea) || null,

    // ── Commercial-specific ──
    commercial_destination: raw.commercial_destination || raw.commercialType || null,

    // ── Terrain-specific ──
    terrain_destination: raw.terrain_destination || raw.terrainType || null,

    // ── Condition & Features ──
    condition:      raw.condition || raw.stare || null,
    heating:        raw.heating || raw.incalzire || null,
    balcony:        raw.balcony || raw.balcon || null,
    parking:        raw.parking || raw.parcare || null,

    // ── Location ──
    location:       raw.location || raw.locatie || raw.address || null,
    sector:         raw.sector || raw.sectorul || null,
    city:           raw.city || raw.orash || raw.municipiu || null,

    // ── Description ──
    description:    raw.description || raw.descriere || null,

    // ── Metadata ──
    _source:        raw._source || 'ai_parsed',
    _confidence:    raw._confidence || raw.confidence || null,
  };

  // Clean null values
  for (const [key, value] of Object.entries(normalized)) {
    if (value === null || value === undefined) {
      delete normalized[key];
    }
  }

  return normalized;
}

module.exports = {
  fallbackParse,
  normalizeParsedData,
  extractByPatterns,
  cleanNumeric,
};
