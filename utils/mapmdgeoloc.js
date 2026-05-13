const axios = require("axios");
require('dotenv').config();
const { buildGeoAddress } = require('./regionParser');

/**
 * getGeolocation(parsedLocation)
 *
 * Fetches geolocation coordinates from map.md API using a FULL
 * street-level address built from parsed location components.
 *
 * Builds geoAddress as: "street streetNumber, sector, city, Moldova"
 * Falls back to "sector, city, Moldova" if street/number are missing.
 *
 * @param {Object} parsedLocation - Result from parseLocation()
 *   { municipality, city, sector, street, streetNumber, original }
 * @returns {Object|null} { latitude, longitude } or null on failure
 */
async function getGeolocation(parsedLocation) {
  // Build full geoAddress from parsed components
  const geoAddress = buildGeoAddress(parsedLocation);

  console.log("Continutul adresei din mapmdgeoloc.js:", geoAddress);
  console.log("[GEO ADDRESS] Final address:", geoAddress);

  const MAP_TOKEN = process.env.MAP_TOKEN;

  try {
    const response = await axios.get(
      `https://map.md/api/companies/webmap/search?q=${encodeURIComponent(geoAddress)}`,
      {
        auth: {
          username: MAP_TOKEN,
          password: ''
        }
      }
    );
    console.log("[GEO RESULT] Coordinates:", response.data);

    if (response.data && response.data.selected) {
      const { lat, lon } = response.data.selected.centroid;
      const coords = { latitude: lat, longitude: lon };
      console.log("[GEO RESULT] Coordinates:", coords);
      return coords;
    } else {
      throw new Error('Geolocation not found');
    }
  } catch (error) {
    console.error('Error fetching geolocation:', error);
    return null;
  }
}

module.exports = { getGeolocation };
