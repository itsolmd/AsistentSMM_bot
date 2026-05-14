/**
 * utils/geolocNominatim.js
 *
 * Nominatim OpenStreetMap geocoder for Moldova addresses.
 * Replaces the unreliable map.md API which returns business directory results
 * instead of actual coordinates.
 *
 * ═══════════════════════════════════════════════════════════════
 * GEOLOCATION NORMALIZATION (v6.0)
 * ═══════════════════════════════════════════════════════════════
 * All geolocation output is standardized to:
 *   { lat: Number, lng: Number }
 *
 * This ensures consistency across the entire pipeline regardless
 * of input naming (lat/lon/lng/longitude → always output as lat/lng).
 * ═══════════════════════════════════════════════════════════════
 *
 * USAGE:
 *   const { geocodeNominatim } = require('./utils/geolocNominatim');
 *   const coords = await geocodeNominatim("str. Tudor Vladimirescu 38a, Buiucani, Chișinău, Moldova");
 *   // → { lat: 47.0245, lng: 28.8323 } or null
 *
 * RATE LIMITING:
 *   Nominatim ToS requires max 1 request per second.
 *   This module enforces a minimum 1100ms delay between requests.
 *
 * USER-AGENT:
 *   Required by Nominatim ToS. Set via .env: NOMINATIM_USER_AGENT
 *   Fallback: "AsistentSMMBot/1.0"
 */

const axios = require('axios');
const { buildGeoAddress } = require('./regionParser');

// ── Rate limiting ────────────────────────────────────────────────────
const MIN_INTERVAL_MS = 1100; // 1.1s > 1s to be safe
let lastRequestTime = 0;

/**
 * Wait until enough time has passed since the last Nominatim request.
 */
async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    const waitMs = MIN_INTERVAL_MS - elapsed;
    console.log(`[NOMINATIM] Rate limit wait: ${waitMs}ms`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();
}

/**
 * normalizeCoords(lat, lng)
 *
 * Safely normalizes coordinate pairs to { lat, lng } format.
 * Handles all input variants: undefined, null, strings, numbers.
 * Returns null if either coordinate is missing or invalid.
 *
 * @param {*} lat  - Raw latitude value
 * @param {*} lng  - Raw longitude value
 * @returns {{lat: number, lng: number} | null}
 */
function normalizeCoords(lat, lng) {
  console.log('[GEO RAW] lat:', lat, 'lng:', lng);

  // ── REJECT null/undefined BEFORE Number() conversion ──
  // Number(null) = 0, which is a valid coordinate (equator/null island).
  // We must catch null/undefined explicitly.
  if (lat == null || lng == null) {
    console.log('[GEO VALIDATION] ❌ Null/undefined — lat:', lat, 'lng:', lng);
    return null;
  }

  const latN = Number(lat);
  const lngN = Number(lng);

  console.log('[GEO NORMALIZED] lat:', latN, 'lng:', lngN);

  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) {
    console.log('[GEO VALIDATION] ❌ Not finite — lat:', latN, 'lng:', lngN);
    return null;
  }

  if (latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
    console.log('[GEO VALIDATION] ❌ Out of range — lat:', latN, 'lng:', lngN);
    return null;
  }

  if (Math.abs(latN) < 0.01 && Math.abs(lngN) < 0.01) {
    console.log('[GEO VALIDATION] ❌ Placeholder zero/null — lat:', latN, 'lng:', lngN);
    return null;
  }

  console.log('[GEO VALIDATION] ✅ Valid — lat:', latN, 'lng:', lngN);
  return { lat: latN, lng: lngN };
}

/**
 * safeExtractGeo(geo)
 *
 * Extracts coordinates from an object with any known key naming:
 *   { lat, lng }, { lat, lon }, { latitude, longitude }, etc.
 * Normalizes to { lat, lng } via normalizeCoords().
 *
 * @param {object|null} geo - Raw geolocation object
 * @returns {{lat: number, lng: number} | null}
 */
function safeExtractGeo(geo) {
  if (!geo || typeof geo !== 'object') {
    console.log('[GEO RAW] No geo object');
    return null;
  }

  const lat = geo.lat ?? geo.latitude;
  const lng = geo.lng ?? geo.lon ?? geo.longitude;

  console.log('[GEO RAW] Object:', JSON.stringify(geo), '→ extracted lat:', lat, 'lng:', lng);
  return normalizeCoords(lat, lng);
}

/**
 * geocodeNominatim(address)
 *
 * Geocode a single address string via Nominatim OpenStreetMap API.
 * Returns { lat, lng } on success, null on failure.
 *
 * @param {string} address - Full address string
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function geocodeNominatim(address) {
  if (!address || typeof address !== 'string') {
    console.warn('[NOMINATIM] Invalid address:', address);
    return null;
  }

  const userAgent = process.env.NOMINATIM_USER_AGENT || 'AsistentSMMBot/1.0';

  await rateLimitWait();

  console.log(`[NOMINATIM] Geocoding: "${address}"`);

  try {
    const response = await axios.get(
      'https://nominatim.openstreetmap.org/search',
      {
        params: {
          q: address,
          format: 'jsonv2',
          limit: 1,
          countrycodes: 'md', // Restrict to Moldova for accuracy
          addressdetails: 0,
        },
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json',
        },
        timeout: 10000,
      }
    );

    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
      console.log(`[NOMINATIM] No results for: "${address}"`);
      return null;
    }

    const result = response.data[0];

    // Use safe extraction to normalize nominatim's { lat, lon } → { lat, lng }
    const coords = safeExtractGeo({ lat: result.lat, lon: result.lon });
    if (!coords) {
      console.warn(`[NOMINATIM] Invalid coordinates in response: lat=${result.lat}, lon=${result.lon}`);
      return null;
    }

    // Validate within Moldova bounds (approx)
    if (coords.lat < 45.0 || coords.lat > 48.5 || coords.lng < 26.5 || coords.lng > 30.5) {
      console.warn(`[NOMINATIM] Coordinates outside Moldova bounds: ${coords.lat}, ${coords.lng} — rejecting`);
      return null;
    }

    console.log(`[NOMINATIM] ✅ Result: ${coords.lat}, ${coords.lng} — type: ${result.type || 'N/A'}, class: ${result.class || 'N/A'}`);
    console.log('[GEO PAYLOAD]', JSON.stringify(coords));
    return coords;
  } catch (err) {
    if (err.response?.status === 429) {
      console.warn('[NOMINATIM] Rate limited (429) — waiting 5s and NOT retrying automatically');
    } else {
      console.error(`[NOMINATIM] Request failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * geocodeWithFallback(parsedLocation)
 *
 * Tries multiple address formats in order of precision:
 *   1. Full street address (with prefix)
 *   2. Street without prefix + number
 *   3. Street without prefix, no number
 *   4. Sector + city only (centroid)
 *
 * AVOIDS city-only geocoding as it produces inaccurate coordinates.
 *
 * All returns are normalized to { lat, lng } format.
 *
 * @param {Object} parsedLocation - Result from parseLocation()
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function geocodeWithFallback(parsedLocation) {
  if (!parsedLocation || typeof parsedLocation !== 'object') {
    console.warn('[NOMINATIM] Invalid parsedLocation:', parsedLocation);
    return null;
  }

  // Build address formats in order of precision
  const attempts = [];

  // 1. Full street address via buildGeoAddress (handles prefix normalization)
  const fullAddr = buildGeoAddress(parsedLocation);
  if (fullAddr) attempts.push({ address: fullAddr, label: 'full address' });

  // 2. Street without prefix + number
  if (parsedLocation.street) {
    const streetClean = parsedLocation.street.replace(/^(str\.|strada|ул\.|улица)\s+/i, '').trim();
    if (streetClean) {
      const numStr = parsedLocation.streetNumber ? ` ${parsedLocation.streetNumber}` : '';
      const addr = `${streetClean}${numStr}, ${parsedLocation.sector || ''}, ${parsedLocation.city || ''}, Moldova`
        .replace(/, ,/g, ',')
        .replace(/, $/, '');
      attempts.push({ address: addr, label: 'street no prefix' });
    }
  }

  // 3. Sector + city centroid (if sector available)
  if (parsedLocation.sector && parsedLocation.city) {
    attempts.push({
      address: `${parsedLocation.sector}, ${parsedLocation.city}, Moldova`,
      label: 'sector+city centroid',
    });
  }

  // 4. City only (LAST RESORT — only if nothing else worked)
  // Intentionally omitted — city-only geocoding is inaccurate
  // and almost never useful for real estate listings.

  // Try each attempt
  for (let i = 0; i < attempts.length; i++) {
    const { address, label } = attempts[i];
    console.log(`[NOMINATIM] Attempt ${i + 1}/${attempts.length} (${label}): "${address}"`);

    const coords = await geocodeNominatim(address);
    if (coords) {
      console.log(`[NOMINATIM] ✅ Found coordinates on attempt ${i + 1} (${label}):`, JSON.stringify(coords));
      return coords;
    }
  }

  console.log('[NOMINATIM] ❌ All address attempts failed — returning null');
  return null;
}

module.exports = { geocodeNominatim, geocodeWithFallback, normalizeCoords, safeExtractGeo };
