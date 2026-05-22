/**
 * webscrape/websites/premier.js
 *
 * Scraper pentru premierimobil.md
 * Extrage datele direct din API-ul public Strapi (nu necesită autentificare).
 *
 * Diferențe față de scrap_999:
 *  - 999.md: scraping direct din HTML (Puppeteer)
 *  - premierimobil.md: API Strapi public → JSON structurat
 *
 * Formatul de ieșire este IDENTIC cu scrap_999 pentru compatibilitate
 * cu returnInfoInChat(), sendFilter() și postarea pe platforme.
 */

const axios = require("axios");
require("dotenv").config();

const {
  parseLocation,
  formatLocation,
  buildGeoAddress,
  getLocationArrayForFilter,
} = require("../../utils/regionParser");

const {
  redactPhone,          // 🔒 GDPR/confidentiality phone redaction
} = require('../../utils/cleaners');

/**
 * Extrage dintr-un URL de pe premierimobil.md slug-ul
 * Exemplu: "https://premierimobil.md/ro/apartments/txrh4wcrsd7u7ss0c3az4i1u"
 *   → slug = "apartments/txrh4wcrsd7u7ss0c3az4i1u"
 */
function extractSlug(url) {
  const parts = url.split("/");
  // Ultimele 2 părți = tip + documentId
  // ["https:", "", "premierimobil.md", "ro", "apartments", "txrh4wcrsd7u7ss0c3az4i1u"]
  const slugParts = parts.slice(-2);
  return slugParts.join("/");
}

/**
 * Determină tipul imobilului după primul segment al slug-ului
 */
function extractImobilType(slug) {
  const typeMap = {
    apartments: "Toate apartamentele",
    houses: "Case",
    commercials: "Imobiliare comerciale",
    terrains: "Loturi de teren",
  };
  const segment = slug.split("/")[0]; // "apartments", "houses", etc.
  return typeMap[segment] || "Apartament";
}

/**
 * Normalizează valoarea pentru încălzire
 * API-ul Strapi returnează obiectul complet; noi extragem doar un ID numeric
 * conform convenției scrap_999: 1=autonomă, 2=centralizată
 */
function normalizeHeating(heatingObj) {
  if (!heatingObj) return 1; // implicit autonomă
  const name = (heatingObj.ro || "").toLowerCase();
  if (name.includes("centralizat")) return 2;
  return 1; // autonomă
}

/**
 * Normalizează tipul de bloc
 * API-ul returnează "Bloc nou" / "Secundar" — exact aceleași valori ca 999.md
 */
function normalizeBuilding(buildingObj) {
  if (!buildingObj) return "Construcţii noi";
  return buildingObj.ro || "Construcţii noi";
}

/**
 * Normalizează living: din true/false → string "Da"/"Nu"/"Cu living"
 */
function normalizeLiving(value) {
  if (value === true || value === "true") return "Da";
  if (value === false || value === "false") return "Nu";
  return "Nu";
}

/**
 * Normalizează balcon: din null/1/0 → 1 (Da) / 0 (Nu)
 */
function normalizeBalcony(value) {
  if (value === 1 || value === true || value === "1" || value === "true") return 1;
  return 0;
}

/**
 * scrap_premier — Extrage datele unui anunț de pe premierimobil.md
 *                prin API-ul public Strapi.
 *
 * @param {Object} ctx - Context Telegraf (necesar pentru session)
 * @param {string} url - URL-ul complet al anunțului
 * @returns {Object|null} Obiect formatat identic cu scrap_999, sau null la eroare
 */
const scrap_premier = async (ctx, url) => {
  try {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("🕷️  [SCRAP_PREMIER] ÎNCEPE EXTRAGERE DATE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("🔗 URL:", url);
    console.log("");

    // ── 1. Extrage slug din URL ───────────────────────────────────
    const slug = extractSlug(url);
    console.log("🔍 [SCRAP_PREMIER] Slug extras:", slug);

    // ── 2. Determină backend-ul Strapi ─────────────────────────────
    //   Sesiune → .env → fallback hardcodat
    const sessionBackend = ctx?.session?.user?.strapi_backend;
    const envBackend     = process.env.BACK_END;
    const backend        = sessionBackend || envBackend || "z0cs0ko4k0ow4ggkskkc40wc.62.169.31.87.sslip.io";

    console.log(`🔍 [SCRAP_PREMIER] Using backend: ${backend}`);

    // ── 3. Apelează API-ul public (NU necesită token!) ────────────
    const apiUrl = `http://${backend}/api/${slug}?populate=*`;
    console.log(`🔍 [SCRAP_PREMIER] Fetching API: ${apiUrl}`);

    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" },
    });

    const data = response.data?.data;
    if (!data) {
      console.error("❌ [SCRAP_PREMIER] API returned empty data");
      return null;
    }

    console.log("✅ [SCRAP_PREMIER] API data received");

    // ── 4. Extrage câmpurile din răspunsul Strapi ─────────────────
    //    Structura: data = { id, documentId, rooms, living, area, price,
    //                        floor, floors, bathrooms, balcony, geolocation,
    //                        infos, rent, building: { ro }, heating: { ro },
    //                        developer: { name }, sector: { ro },
    //                        thumbnails: [{ url }], ... }

    const rooms     = data.rooms || 1;
    const area      = data.area || 50;
    const price     = data.price || "0";
    const floor     = data.floor || 1;
    const floors    = data.floors || 1;
    const bathrooms = data.bathrooms || 1;
    const balcony   = normalizeBalcony(data.balcony);
    const living    = normalizeLiving(data.living);
    const building  = normalizeBuilding(data.building);
    const heating   = normalizeHeating(data.heating);
    const developer = data.developer?.name || "";
    const sectorRo  = data.sector?.ro || "";

    // ── 5. Geolocație ────────────────────────────────────────────
    let geolocation = null;
    if (data.geolocation &&
        Number.isFinite(Number(data.geolocation.lat)) &&
        Number.isFinite(Number(data.geolocation.lng))) {
      geolocation = {
        lat: Number(data.geolocation.lat),
        lng: Number(data.geolocation.lng),
      };
    } else {
      // Fallback Chișinău
      geolocation = { lat: 47.037, lng: 28.819 };
    }
    console.log("🌐 [SCRAP_PREMIER] Geolocation:", JSON.stringify(geolocation));

    // ── 6. Extrage informații din "infos" ─────────────────────────
    //    Câmpul infos conține: link original, telefon, locație, filtru
    //    Exemplu: "https://999.md/ro/103367823\n📞 37368355585...\n📍 Chișinău..."
    const infos = data.infos || "";

    // Extrage telefonul din infos
    let phoneNr = "";
    const phoneMatch = infos.match(/📞\s*(\d+)/);
    if (phoneMatch) {
      phoneNr = phoneMatch[1];
    }
    // 🔒 Redactează numerele de telefon restricționate (confidențialitate)
    phoneNr = redactPhone(phoneNr) || '';

    // Extrage locația din infos
    let regionText = "";
    const locationMatch = infos.match(/📍\s*(.+)/);
    if (locationMatch) {
      regionText = locationMatch[1].trim();
    }

    // Extrage link-ul original
    let originalLink = "";
    const firstLine = infos.split("\n")[0] || "";
    if (firstLine.startsWith("http")) {
      originalLink = firstLine.trim();
    }

    // ── 7. Construiește parsedLocation ───────────────────────────
    //    Folosim același parser ca la 999.md
    const regionArr = getLocationArrayForFilter({
      city: "Chișinău",
      sector: sectorRo || "Centru",
      municipality: "Chișinău mun.",
    });

    const parsedLocation = {
      city: "Chișinău",
      sector: sectorRo || "Centru",
      municipality: "Chișinău mun.",
      street: "",
      streetNumber: "",
      original: regionText || `Chișinău, ${sectorRo || "Centru"}`,
    };

    console.log("[SCRAP_PREMIER] Parsed location:", JSON.stringify(parsedLocation));

    // ── 8. Extrage imaginile ──────────────────────────────────────
    const images = Array.isArray(data.thumbnails)
      ? data.thumbnails.map((t) => t.url).filter(Boolean)
      : [];

    console.log(`📸 [SCRAP_PREMIER] Imagini: ${images.length}`);

    // ── 9. Construiește formattedText (pentru caption Telegram) ──
    //    Același format ca scrap_999, dar adaptat pentru Premier
    const typeLabel = extractImobilType(slug);
    const formattedText =
      `Apartament.\n\n` +
      `📍 Locație: ${parsedLocation.original || `Chișinău, ${sectorRo}`}\n` +
      `🛏️ Dormitoare: ${rooms}\n` +
      `📐 Suprafață: ${area} m²\n` +
      `🏢 Etaj: ${floor}/${floors}\n` +
      `🚽 Băi: ${bathrooms}\n` +
      `🏗️ Bloc: ${building}\n` +
      `💰 Preț: ${Number(price).toLocaleString()} €\n` +
      `📞 ${phoneNr}\n` +
      (originalLink ? `🔗 ${originalLink}\n` : "") +
      `🆔 DB_Ap${data.documentId || slug.split("/").pop()}`;

    // ── 10. Construiește obiectul de returnat ─────────────────────
    //     FORMAT IDENTIC cu scrap_999 pentru compatibilitate totală
    const result = {
      formattedText,

      type: typeLabel,
      link: url,
      price: `${Number(price).toLocaleString()} €`,
      priceNumeric: Number(price) || 0,
      offerType: data.rent || "Vânzare",
      offerTypeId: 776, // Vânzare pe 999.md
      regionText: regionText || `Chișinău, ${sectorRo || "Centru"}`,
      region: regionArr,
      parsedLocation,

      rooms: String(rooms),
      area: String(area),
      floor: String(floor),
      floors: String(floors),
      bathrooms: bathrooms,
      building: building,

      title: data.title || `Apartament cu ${rooms} camere, ${sectorRo}, Chișinău`,
      description: "",
      images: images,
      phoneNr: phoneNr || "",
      advertId: `DB_Ap${data.documentId || slug.split("/").pop()}`,

      geolocation: geolocation,

      heating: heating,
      condition: "",
      serie: "",
      features: [],
      balcony: balcony,
      living: living === "Da",
      developer: developer,
    };

    // ══════════════════════════════════════════════════════════════
    // REZUMAT FINAL
    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("📊 [SCRAP_PREMIER] REZUMAT FINAL EXTRAGERE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  🏠 Tip:        ${typeLabel}`);
    console.log(`  📍 Locație:    ${regionText || `Chișinău, ${sectorRo}`}`);
    console.log(`  🛏️  Camere:     ${rooms}`);
    console.log(`  📐 Suprafață:  ${area} m²`);
    console.log(`  🏢 Etaj:       ${floor}/${floors}`);
    console.log(`  🚽 Băi:        ${bathrooms}`);
    console.log(`  🏗️  Bloc:       ${building}`);
    console.log(`  💰 Preț:       ${Number(price).toLocaleString()} €`);
    console.log(`  📞 Telefon:    ${phoneNr || "N/A"}`);
    console.log(`  🌍 Geo:        ${geolocation.lat}, ${geolocation.lng}`);
    console.log(`  🆔 ID:         ${result.advertId}`);
    console.log("");
    console.log(`  📸 Imagini:         ${images.length}`);
    console.log(`  🔥 Încălzire:       ${result.heating}`);
    console.log(`  🏠 Balcon:          ${result.balcony}`);
    console.log(`  🛋️  Living:           ${result.living}`);
    console.log(`  🏗️  Dezvoltator:     ${result.developer}`);
    console.log("═══════════════════════════════════════════════════════════");
    console.log("✅ [SCRAP_PREMIER] EXTRAGERE COMPLETĂ");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");

    return result;
  } catch (err) {
    console.error("❌ [SCRAP_PREMIER] Eroare:", err.message);
    if (err.response) {
      console.error("❌ [SCRAP_PREMIER] HTTP Status:", err.response.status);
      console.error("❌ [SCRAP_PREMIER] Response:", JSON.stringify(err.response.data || {}).slice(0, 300));
    }
    return null;
  }
};

module.exports = { scrap_premier };
