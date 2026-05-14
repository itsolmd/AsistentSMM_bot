/**
 * tests/test_geolocation.js
 *
 * Test script for geolocation functionality.
 * Tests parseLocation, buildGeoAddress, geocodeWithFallback,
 * normalizeCoords, and safeExtractGeo.
 *
 * ═══════════════════════════════════════════════════════════════
 * GEOLOCATION NORMALIZATION (v6.0)
 * ═══════════════════════════════════════════════════════════════
 * All coordinates standardized to { lat: Number, lng: Number }.
 *
 * Debug log levels:
 *   [GEO RAW]          — Raw input before any processing
 *   [GEO NORMALIZED]   — After Number() conversion
 *   [GEO VALIDATION]   — Validation result (✅ or ❌)
 *   [GEO PAYLOAD]      — Final output sent downstream
 * ═══════════════════════════════════════════════════════════════
 *
 * Uses Nominatim OSM geocoder (replaces unreliable map.md API).
 */

require('dotenv').config();
const { parseLocation, buildGeoAddress } = require('../utils/regionParser');
const { geocodeWithFallback } = require('../utils/geolocNominatim');

// ═══════════════════════════════════════════════════════════════
// UNIT TESTS: normalizeCoords & safeExtractGeo
// ═══════════════════════════════════════════════════════════════

// We import the internal functions for testing.
// In production, they are used internally by geocodeNominatim.
const {
  normalizeCoords,
  safeExtractGeo,
} = require('../utils/geolocNominatim');

/**
 * Test normalizeCoords with various inputs
 */
function testNormalizeCoords() {
  console.log("\n" + "=".repeat(70));
  console.log("🧪 UNIT TEST: normalizeCoords()");
  console.log("=".repeat(70));

  const tests = [
    // [lat, lng, expected]
    { name: "Valid numeric",           lat: 47.0245,  lng: 28.8323,   expect: { lat: 47.0245,  lng: 28.8323 } },
    { name: "Valid string coords",     lat: "47.02",  lng: "28.83",   expect: { lat: 47.02,    lng: 28.83 } },
    { name: "Undefined lng",           lat: 46.9945,  lng: undefined, expect: null },
    { name: "Null lng",                lat: 46.9945,  lng: null,      expect: null },
    { name: "Null lat",                lat: null,     lng: 28.8323,   expect: null },
    { name: "NaN lng",                 lat: 46.9945,  lng: NaN,       expect: null },
    { name: "Both null",               lat: null,     lng: null,      expect: null },
    { name: "Out of range lat",        lat: 100,      lng: 28.8323,   expect: null },
    { name: "Out of range lng",        lat: 47.0245,  lng: 300,       expect: null },
    { name: "Zero placeholder",        lat: 0,        lng: 0,         expect: null },
    { name: "Near-zero placeholder",   lat: 0.001,    lng: 0.001,     expect: null },
    { name: "Missing lng (no arg)",    lat: 46.9945,  lng: undefined, expect: null },
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const result = normalizeCoords(t.lat, t.lng);
    const resultStr = JSON.stringify(result);
    const expectedStr = JSON.stringify(t.expect);

    if (resultStr === expectedStr) {
      console.log(`  ✅ ${t.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${t.name} — Expected ${expectedStr}, got ${resultStr}`);
      failed++;
    }
  }

  console.log(`\n  normalizeCoords: ${passed}/${passed + failed} passed`);
  return { passed, failed };
}

/**
 * Test safeExtractGeo with various input objects
 */
function testSafeExtractGeo() {
  console.log("\n" + "=".repeat(70));
  console.log("🧪 UNIT TEST: safeExtractGeo()");
  console.log("=".repeat(70));

  const tests = [
    { name: "{ lat, lng }",         input: { lat: 47.0245, lng: 28.8323 },         expect: { lat: 47.0245, lng: 28.8323 } },
    { name: "{ lat, lon }",         input: { lat: 47.0245, lon: 28.8323 },         expect: { lat: 47.0245, lng: 28.8323 } },
    { name: "{ latitude, longitude }",  input: { latitude: 47.0245, longitude: 28.8323 }, expect: { lat: 47.0245, lng: 28.8323 } },
    { name: "{ lat } missing lng",  input: { lat: 46.9945 },                       expect: null },
    { name: "null input",           input: null,                                    expect: null },
    { name: "undefined input",      input: undefined,                               expect: null },
    { name: "string input",         input: "invalid",                               expect: null },
    { name: "empty object",         input: {},                                      expect: null },
    { name: "lat and lng as strings", input: { lat: "47.02", lng: "28.83" },        expect: { lat: 47.02, lng: 28.83 } },
    { name: "mixed: lat + longitude", input: { lat: 47.0245, longitude: 28.8323 },  expect: { lat: 47.0245, lng: 28.8323 } },
    { name: "all keys present",     input: { lat: 47, lng: 28, lon: 29, longitude: 30 }, expect: { lat: 47, lng: 28 } },
    { name: "lat string, lon as lng fallback", input: { lat: "47.0", lon: "28.0" }, expect: { lat: 47.0, lng: 28.0 } },
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    const result = safeExtractGeo(t.input);
    const resultStr = JSON.stringify(result);
    const expectedStr = JSON.stringify(t.expect);

    if (resultStr === expectedStr) {
      console.log(`  ✅ ${t.name}`);
      passed++;
    } else {
      console.log(`  ❌ ${t.name} — Expected ${expectedStr}, got ${resultStr}`);
      failed++;
    }
  }

  console.log(`\n  safeExtractGeo: ${passed}/${passed + failed} passed`);
  return { passed, failed };
}

// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS: Full pipeline (parse → geocode)
// ═══════════════════════════════════════════════════════════════

const testAddresses = [
  // Full address with street
  "Chișinău mun., Chișinău, Buiucani, str. Tudor Vladimirescu, 38a",
  // Address with sector only
  "Chișinău, Centru",
  // Address with street (Calea Ieșilor)
  "Chișinău, str. Calea Ieșilor, 6",
  // Sculeni sector
  "Sculeni, Chișinău, Chișinău mun.",
  // Botanica sector
  "Chișinău, Botanica, str. Mihai Eminescu, 28",
  // Râșcani sector
  "Chișinău, Râșcani, str. Alecu Russo, 13",
  // Ciocana sector
  "Chișinău, Ciocana, str. Mircea cel Bătrân, 20",
  // City only
  "Chișinău",
  // Another city
  "Bălți, str. Ștefan cel Mare, 75",
  // Russian-style address
  "Кишинев, ул. Каля Ешилор, 6",
];

async function runIntegrationTests() {
  console.log("\n" + "=".repeat(70));
  console.log("🧪 INTEGRATION TEST: Full geolocation pipeline");
  console.log("=".repeat(70));
  console.log(`MAP_TOKEN present: ${!!process.env.MAP_TOKEN}`);
  console.log(`MAP_TOKEN (first 8 chars): ${process.env.MAP_TOKEN?.slice(0, 8)}...`);
  console.log("=".repeat(70));

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < testAddresses.length; i++) {
    const address = testAddresses[i];
    console.log(`\n${"─".repeat(70)}`);
    console.log(`📝 TEST ${i + 1}/${testAddresses.length}: "${address}"`);
    console.log(`${"─".repeat(70)}`);

    try {
      // Step 1: Parse the location
      console.log(`\n🔍 Step 1: parseLocation()`);
      const parsed = parseLocation(address);
      console.log(`   Parsed: ${JSON.stringify(parsed, null, 2)}`);

      // Step 2: Build geo address
      console.log(`\n🔍 Step 2: buildGeoAddress()`);
      const geoAddr = buildGeoAddress(parsed);
      console.log(`   Geo address: "${geoAddr}"`);

      // Step 3: Get geolocation via Nominatim OSM
      console.log(`\n🔍 Step 3: geocodeWithFallback()`);
      const coords = await geocodeWithFallback(parsed);

      if (coords) {
        // NORMALIZED OUTPUT: Always { lat, lng }
        console.log(`\n✅ RESULT: Coordinates found!`);
        console.log(`   Latitude:  ${coords.lat}`);
        console.log(`   Longitude: ${coords.lng}`);
        console.log(`   Format: { lat: ${typeof coords.lat}, lng: ${typeof coords.lng} }`);
        console.log(`   Google Maps: https://www.google.com/maps?q=${coords.lat},${coords.lng}`);
        passed++;
      } else {
        console.log(`\n❌ RESULT: No coordinates found`);
        failed++;
      }
    } catch (err) {
      console.error(`\n💥 ERROR: ${err.message}`);
      console.error(err.stack?.slice(0, 300));
      failed++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("📊 INTEGRATION TEST SUMMARY");
  console.log("=".repeat(70));
  console.log(`   Total:  ${testAddresses.length}`);
  console.log(`   Passed: ${passed}`);
  console.log(`   Failed: ${failed}`);
  console.log("=".repeat(70));

  return { passed, failed };
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  console.log("=".repeat(70));
  console.log("🧪 GEOLOCATION TEST SUITE");
  console.log("=".repeat(70));

  // Run unit tests
  const unit1 = testNormalizeCoords();
  const unit2 = testSafeExtractGeo();

  // Run integration tests
  const integration = await runIntegrationTests();

  // ── Grand Total ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("📊 GRAND TOTAL");
  console.log("=".repeat(70));
  const totalPassed = unit1.passed + unit2.passed + integration.passed;
  const totalFailed = unit1.failed + unit2.failed + integration.failed;
  const total = totalPassed + totalFailed;
  console.log(`   Total:  ${total}`);
  console.log(`   Passed: ${totalPassed}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`   Success rate: ${(totalPassed / total * 100).toFixed(1)}%`);
  console.log("=".repeat(70));

  process.exit(totalFailed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
