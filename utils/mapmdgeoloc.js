/**
 * utils/mapmdgeoloc.js
 *
 * @deprecated Use utils/geolocNominatim.js instead.
 *
 * This module previously used the map.md API which is NOT a real geocoder
 * (it returns business directory results, not coordinates).
 *
 * It now delegates to Nominatim OSM geocoder for backward compatibility.
 * All new code should import from './geolocNominatim' directly.
 */

const { geocodeWithFallback } = require('./geolocNominatim');

/**
 * getGeolocation(parsedLocation)
 *
 * @deprecated Use geocodeWithFallback() from './geolocNominatim' instead.
 *
 * Fetches geolocation coordinates using Nominatim OSM geocoder.
 * Returns normalized { lat, lng } format.
 *
 * @param {Object} parsedLocation - Result from parseLocation()
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function getGeolocation(parsedLocation) {
  console.warn(
    '⚠️ [mapmdgeoloc] DEPRECATED: Import from "utils/geolocNominatim" instead. ' +
    'The map.md API is not a real geocoder — using Nominatim OSM fallback.'
  );
  return geocodeWithFallback(parsedLocation);
}

module.exports = { getGeolocation };
