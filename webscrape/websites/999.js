const puppeteer = require('puppeteer');
require("dotenv").config();

const {
  cleanEscapedText,
  deduplicateImages,
  parsePriceToNumber,
  parseFloorString,
  safeNumber,
  cleanNaN,
  cleanNullInjections,
  normalizeWhitespace,
  normalizeText,       // BUG v2.1 FIXED: newline-preserving text normalization
  extractPhoneFromPage,
} = require('../../utils/cleaners');

const {
  parseLocation,
  formatLocation,
  buildGeoAddress,
  getLocationArrayForFilter,
} = require('../../utils/regionParser');

/* ================================================================
   scrap_999 — Extrage datele unui anunț imobiliar de pe 999.md
   și le formatează pentru postare pe social media.

   BUG FIXES APPLIED (v2.0):
   • #1: cleanEscapedText() — elimină escape-urile inutile (\. \_ \€)
   • #2: regionParser — locația este parsata corect (Sculeni = sector)
   • #3: formatLocation — "Chișinău, Sculeni" în loc de "Sculeni, Chișinău, Chișinău mun."
   • #4: extractPhoneFromPage — extrage telefon din JSON-LD, tel:, __NEXT_DATA__, button click
   • #5: deduplicateImages — normalizează URL-urile, elimină // duplicate
   • #6: parseFloorString — "6/12" → floor=6, totalFloors=12 (fără concatenare "61")
   • #8: parsePriceToNumber — "97.000 €" → 97000 (numeric, nu string)
   • #9: Geolocation extras din __NEXT_DATA__ (GPS real)
   • #10: cleanNaN, cleanNullInjections, normalizeWhitespace
   • #11: Format final corect cu 🆔 ID: DB_Ap...
   ================================================================ */
const scrap_999 = async (ctx, url) => {
  try {
    // ── 1. Normalizare URL ──────────────────────────────────────
    if (url.startsWith("https://m.999.md")) {
      url = url.replace("https://m.999.md", "https://999.md");
    }
    const urlParts = url.split("/");
    if (urlParts[3] && urlParts[3].length === 2) {
      urlParts[3] = "ro";
    }
    const fixedUrl = urlParts.join("/");

    // ── 2. Lansează browser ────────────────────────────────────
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(fixedUrl, { waitUntil: 'networkidle2' });

    // ── 3. Extrage datele din pagină (fără CSS classes) ────────
    const extracted = await page.evaluate(() => {
      /*──────────────────────────────────────────────────────────
        SURSĂ PRINCIPALĂ: __NEXT_DATA__ (SSR JSON — cel mai stabil)
        ──────────────────────────────────────────────────────────*/
      let nextData = null;
      const script = document.getElementById('__NEXT_DATA__');
      if (script) {
        try {
          nextData = JSON.parse(script.textContent);
        } catch (_) { /* fallback */ }
      }

      const advert = nextData?.props?.pageProps?.advert || null;

      /*──────────────────────────────────────────────────────────
        SURSĂ SECUNDARĂ: tot textul vizibil al paginii
        ──────────────────────────────────────────────────────────*/
      const bodyText = document.body.innerText || '';

      /*──────────────────────────────────────────────────────────
        SURSĂ TERȚIARĂ: titlul paginii (breadcrumbs + h1/h2)
        ──────────────────────────────────────────────────────────*/
      const pageTitle = document.title || '';

      // ── Helper: caută un label în text și extrage valoarea ──
      const extractByLabel = (label, text) => {
        const patterns = [
          new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n]+)`, 'i'),
          new RegExp(`${label}[\\s\\S]{0,5}?[:\\-]?\\s*([^\\n]+)`, 'i'),
        ];
        for (const re of patterns) {
          const m = text.match(re);
          if (m) return m[1].trim();
        }
        return null;
      };

      // ── Helper: extrage primul număr dintr-un șir ───────────
      const extractNumber = (str) => {
        if (!str) return null;
        const m = str.match(/(\d+)/);
        return m ? m[1] : null;
      };

      /* =========================================================
         CÂMPURILE
         ========================================================= */

      // ── ID anunț ─────────────────────────────────────────────
      let advertId = null;
      if (advert?.id) {
        advertId = advert.id;
      } else {
        const idMatch = window.location.pathname.match(/\/(\d+)\/?$/);
        if (idMatch) advertId = idMatch[1];
      }

      // ── Tip proprietate ──────────────────────────────────────
      let propertyType = 'N/A';
      if (advert?.categories?.subcategory?.title) {
        const sub = advert.categories.subcategory.title;
        if (/apartamente/i.test(sub)) propertyType = 'Apartament';
        else if (/case/i.test(sub) || /vile/i.test(sub)) propertyType = 'Casă';
        else if (/comercial/i.test(sub)) propertyType = 'Comercial';
        else if (/teren/i.test(sub) || /loturi/i.test(sub)) propertyType = 'Teren';
        else propertyType = sub;
      }
      if (propertyType === 'N/A') {
        if (/toate apartamentele|apartament/i.test(bodyText)) propertyType = 'Apartament';
        else if (/toate casele|casă|vile/i.test(bodyText)) propertyType = 'Casă';
        else if (/imobiliare comerciale|comercial/i.test(bodyText)) propertyType = 'Comercial';
        else if (/loturi de teren|teren/i.test(bodyText)) propertyType = 'Teren';
      }

      // ── Locație completă ─────────────────────────────────────
      // BUG FIX: Use .styles_map__title__UgISm as PRIMARY source for address
      // Supports Romanian, Russian, and mixed addresses
      let location = 'N/A';
      const mapTitleEl = document.querySelector('.styles_map__title__UgISm');
      if (mapTitleEl) {
        location = mapTitleEl.textContent.trim();
        console.log('[ADDRESS] Raw from .styles_map__title__UgISm:', location);
      }
      if (location === 'N/A') {
        const regionMatch = bodyText.match(/Regiunea\s*[:]\s*(.+?)(?:\n|$)/i);
        if (regionMatch) {
          location = regionMatch[1].trim();
          console.log('[ADDRESS] Raw from bodyText Regiunea:', location);
        }
      }
      if (location === 'N/A') {
        const h2 = document.querySelector('h2');
        if (h2) {
          const h2Text = h2.textContent.trim();
          const parts = h2Text.split(',').map(s => s.trim());
          if (parts.length >= 2) {
            location = parts.slice(1).join(', ').trim();
            console.log('[ADDRESS] Raw from h2 fallback:', location);
          }
        }
      }

      // ── Număr de camere (dormitoare) ─────────────────────────
      let rooms = 'N/A';
      const roomsRaw = extractByLabel('Număr de camere', bodyText);
      if (roomsRaw) {
        if (/o cameră/i.test(roomsRaw)) rooms = '1';
        else {
          const n = extractNumber(roomsRaw);
          if (n) rooms = n;
        }
      }

      // ── Suprafață ────────────────────────────────────────────
      let area = 'N/A';
      const areaRaw = extractByLabel('Suprafață totală', bodyText);
      if (areaRaw) {
        const n = extractNumber(areaRaw);
        if (n) area = n;
      }

      // ── Etaj (BUG #6 FIXED: parse "6/12" correctly) ─────────
      let floor = 'N/A';
      let totalFloors = 'N/A';
      const floorRaw = extractByLabel('Etaj', bodyText);
      if (floorRaw) {
        // Check if it's a "6/12" format
        const slashMatch = floorRaw.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (slashMatch) {
          floor = slashMatch[1];
          totalFloors = slashMatch[2];
        } else {
          const n = extractNumber(floorRaw);
          if (n) floor = n;
        }
      }
      // If totalFloors not found from floor string, try separate label
      if (totalFloors === 'N/A') {
        const totalFloorsRaw = extractByLabel('Număr de etaje', bodyText);
        if (totalFloorsRaw) {
          const n = extractNumber(totalFloorsRaw);
          if (n) totalFloors = n;
        }
      }

      // ── Băi (Grup sanitar) ──────────────────────────────────
      let bathrooms = 'N/A';
      const bathRaw = extractByLabel('Grup sanitar', bodyText);
      if (bathRaw) {
        const n = extractNumber(bathRaw);
        if (n) bathrooms = n;
      }

      // ── Tip construcție (Fond locativ) ───────────────────────
      let building = 'N/A';
      const buildingRaw = extractByLabel('Fond locativ', bodyText);
      if (buildingRaw) {
        building = buildingRaw;
      }

      // ══════════════════════════════════════════════════════════
      // CARACTERISTICI APARTAMENT (BUG REPAIR)
      // SURSĂ: 1. advert.features (__NEXT_DATA__)
      //        2. extractByLabel (bodyText)
      // ══════════════════════════════════════════════════════════

      // ── Helper: caută o caracteristică în advert.features ───
      const findFeatureValue = (featureTitle) => {
        if (!advert?.features) return null;
        const found = advert.features.find(f => f.feature?.title === featureTitle);
        if (!found) return null;
        // Poate fi: { value: { title: "..." } } sau { value: "Da" } sau { value: true }
        if (found.value?.title) return found.value.title;
        if (typeof found.value === 'string') return found.value;
        if (typeof found.value === 'boolean') return found.value ? 'Da' : 'Nu';
        if (typeof found.value === 'number') return String(found.value);
        return null;
      };

      // ── Tip încălzire ──────────────────────────────────────
      let heating = null;
      const heatFromAdvert = findFeatureValue('Tip încălzire');
      if (heatFromAdvert) {
        heating = heatFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] heating:', heating);
      }
      if (!heating) {
        const heatRaw = extractByLabel('Tip încălzire', bodyText);
        if (heatRaw) heating = heatRaw;
      }

      // ── Starea apartamentului ──────────────────────────────
      let condition = null;
      const condFromAdvert = findFeatureValue('Starea apartamentului');
      if (condFromAdvert) {
        condition = condFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] condition:', condition);
      }
      if (!condition) {
        const condRaw = extractByLabel('Starea apartamentului', bodyText);
        if (condRaw) condition = condRaw;
      }

      // ── Compartimentare (seria apartamentului) ─────────────
      let apartament_sery = null;
      const serieFromAdvert = findFeatureValue('Compartimentare');
      if (serieFromAdvert) {
        apartament_sery = serieFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] apartament_sery:', apartament_sery);
      }
      if (!apartament_sery) {
        const serieRaw = extractByLabel('Compartimentare', bodyText);
        if (serieRaw) apartament_sery = serieRaw;
      }

      // ── Balcon / lojie ─────────────────────────────────────
      // BUG FIX: Normalize with diacritic removal + map to numeric IDs
      // Strapi expects numeric IDs (1=Da/Balcon/Logie, 2=Nu/Fără balcon), NOT strings
      let balcony = null;
      const balconyFromAdvert = findFeatureValue('Balcon/ lojie');
      if (balconyFromAdvert) {
        balcony = balconyFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] balcony raw:', balcony);
      }
      if (!balcony) {
        const balconyRaw = extractByLabel('Balcon/ lojie', bodyText);
        if (balconyRaw) balcony = balconyRaw;
      }
      // Normalize balcony: lowercase → NFD → strip diacritics → trim
      if (balcony) {
        const normalizedBalcony = balcony
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim();
        console.log('[BALCONY] Raw:', balcony);
        console.log('[BALCONY] Normalized:', normalizedBalcony);
        // Map to numeric IDs: 1 = Da/Balcon/Logie, 2 = Nu/Fără balcon
        if (
          normalizedBalcony.includes('da') ||
          normalizedBalcony.includes('balcon') ||
          normalizedBalcony.includes('logie')
        ) {
          balcony = 1; // YES
          console.log('[BALCONY] Mapped to ID: 1 (Da/Balcon/Logie)');
        } else if (
          normalizedBalcony.includes('nu') ||
          normalizedBalcony.includes('fara balcon') ||
          normalizedBalcony.includes('fara') ||
          normalizedBalcony.includes('lipsa') ||
          normalizedBalcony.includes('lipseste')
        ) {
          balcony = 2; // NO
          console.log('[BALCONY] Mapped to ID: 2 (Nu/Fără balcon)');
        } else {
          // Cannot determine — set to null (never send NaN/undefined/"Da"/"Nu")
          balcony = null;
          console.log('[BALCONY] Cannot determine — set to null');
        }
      }

      // ── Living ──────────────────────────────────────────────
      let living = null;
      const livingFromAdvert = findFeatureValue('Living');
      if (livingFromAdvert) {
        living = livingFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] living raw:', living);
      }
      if (living === null) {
        const livingRaw = extractByLabel('Living', bodyText);
        if (livingRaw) living = livingRaw;
      }
      // Normalize living to boolean
      if (typeof living === 'string') {
        if (/^(da|yes|1|true|este|disponibil|cu living)$/i.test(living.trim())) living = true;
        else if (/^(nu|no|0|false|lipsă|fără living)$/i.test(living.trim())) living = false;
      }

      // ── Dezvoltator ─────────────────────────────────────────
      let developer = null;
      const devFromAdvert = findFeatureValue('Dezvoltator');
      if (devFromAdvert) {
        developer = devFromAdvert;
        console.log('[scrap_999:__NEXT_DATA__] developer:', developer);
      }
      if (!developer) {
        const devRaw = extractByLabel('Dezvoltator', bodyText);
        if (devRaw) developer = devRaw;
      }

      // ── Caracteristici (features) — checkbox-type only ─────
      // Acestea sunt caracteristici de tip "bifă" (da/nu)
      const checkboxFeatureTitles = [
        'Mobilat',
        'Gata de mutat',
        'Anexă',
        'Terasă',
        'Intrare separată',
        'Zonă cu parc',
        'Cu tehnică electrocasnică',
        'Încălzire autonomă',
        'Aparat de aer condiționat',
        'Geamuri termopan',
        'Geamuri panoramice',
        'Parchet',
        'Laminat',
        'Ușă blindată',
        'Linie telefonică',
        'Interfon',
        'Internet',
        'Cablu TV',
        'Sistem de alarmă',
        'Supraveghere video',
        'Ascensor',
        'Teren de joacă',
      ];
      let features = [];
      if (advert?.features) {
        features = advert.features
          .filter(f => {
            const title = f.feature?.title;
            if (!title || !checkboxFeatureTitles.includes(title)) return false;
            // Este bifat? Valoarea poate fi: true, 'Da', 'yes', 1, { title: 'Da' }
            const val = f.value;
            if (val === true || val === 1) return true;
            if (typeof val === 'string' && /^(da|yes|1|true)$/i.test(val)) return true;
            if (val?.title && /^(da|yes|1|true)$/i.test(val.title)) return true;
            return false;
          })
          .map(f => f.feature.title);
        console.log('[scrap_999:__NEXT_DATA__] features from advert:', features);
      }
      if (features.length === 0) {
        // Fallback: caută text în body pentru caracteristici comune
        const featureLabels = [
          'Mobilat', 'Balcon', 'Aer condiționat', 'Termopan',
          'Parchet', 'Laminat', 'Interfon', 'Internet',
          'Cablu TV', 'Alarmă', 'Video', 'Ascensor'
        ];
        features = featureLabels.filter(label => {
          const re = new RegExp(`${label}\\s*[:\\-]?\\s*(Da|Yes|1|true|Disponibil|Este)`, 'i');
          return re.test(bodyText);
        });
        console.log('[scrap_999:bodyText] features fallback:', features);
      }

      // ── RAW characteristics log ────────────────────────────
      console.log('[scrap_999] RAW characteristics:', {
        heating,
        condition,
        apartament_sery,
        balcony,
        living,
        developer,
        features
      });

      // ── Preț ─────────────────────────────────────────────────
      let price = 'N/A';
      if (advert?.price?.value && advert?.price?.unit) {
        const val = Number(advert.price.value);
        const unit = advert.price.unit.toUpperCase();
        price = `${val.toLocaleString()} ${unit}`;
      }
      if (price === 'N/A') {
        const priceMatch = bodyText.match(/(\d[\d\s]*)\s*(€|EUR|eur)/);
        if (priceMatch) {
          const num = priceMatch[1].replace(/\s/g, '');
          price = `${Number(num).toLocaleString()} €`;
        }
      }

      // ── Tip ofertă (Vând/Închiriez) ─────────────────────────
      let offerType = 'N/A';
      if (advert?.offer_type?.value) {
        offerType = advert.offer_type.value;
      } else {
        const ot = extractByLabel('Tipul', bodyText);
        if (ot) offerType = ot;
      }

      // ── Titlu ────────────────────────────────────────────────
      let title = 'N/A';
      if (advert?.title) {
        title = advert.title;
      } else {
        const h2 = document.querySelector('h2');
        if (h2) title = h2.textContent.trim();
      }

      // ── Descriere ────────────────────────────────────────────
      let description = 'N/A';
      if (advert?.body) {
        description = advert.body;
      }

      // ── Imagini (BUG #5 FIXED: deduplicate + normalize URLs) ─
      // BUG v2.1 FIXED: __PROTO__ trick created https:/// (triple slash)
      // Now using proper protocol-preserving path normalization
      const images = [];
      const seenUrls = new Set();

      document.querySelectorAll('img[src]').forEach(img => {
        const rawSrc = img.getAttribute('src') || '';
        const src = rawSrc.trim();
        if (src.includes('simpalsmedia.com/999.md/BoardImages')) {
          if (src.startsWith('http')) {
            // Convertim la full-size (900x900)
            let fullSize = src.replace(/\/\d+x\d+\//, '/900x900/').split('?')[0];
            // Normalize: fix double slashes in PATH only, preserve protocol
            const protoEnd = fullSize.indexOf('://') + 3;
            const pathPart = fullSize.substring(protoEnd);
            const cleanPath = pathPart.replace(/\/{2,}/g, '/');
            fullSize = fullSize.substring(0, protoEnd) + cleanPath;
            console.log('[RAW IMAGE EXTRACTED]', fullSize);
            if (!seenUrls.has(fullSize)) {
              seenUrls.add(fullSize);
              images.push(fullSize);
            }
          }
        }
      });
      console.log('[RAW IMAGES extracted from page]', images.length, 'images');

      // ── Geolocation (BUG #9 FIXED: extract real GPS) ─────────
      let geolocation = null;
      if (advert?.geolocation) {
        geolocation = {
          lat: advert.geolocation.lat || advert.geolocation.latitude,
          lng: advert.geolocation.lng || advert.geolocation.longitude || advert.geolocation.lon,
        };
      } else if (advert?.map?.lat && advert?.map?.lng) {
        geolocation = {
          lat: advert.map.lat,
          lng: advert.map.lng,
        };
      } else if (advert?.coordinates) {
        geolocation = {
          lat: advert.coordinates.lat || advert.coordinates.latitude,
          lng: advert.coordinates.lng || advert.coordinates.longitude || advert.coordinates.lon,
        };
      }

      // ── Telefon (BUG FIX: use href="tel:" as PRIMARY source) ──
      let phoneNr = null;
      const telLink = document.querySelector('a[href^="tel:"]');
      if (telLink) {
        const phoneHref = telLink.getAttribute('href');
        phoneNr = phoneHref
          ?.replace('tel:', '')
          ?.replace(/\s+/g, '')
          ?.trim();
        console.log('[PHONE] href:', phoneHref);
        console.log('[PHONE] normalized:', phoneNr);
      }

      // ── Return ───────────────────────────────────────────────
      return {
        advertId,
        propertyType,
        location,
        rooms,
        area,
        floor,
        totalFloors,
        bathrooms,
        building,
        price,
        offerType,
        title,
        description,
        images,
        geolocation,
        bodyText,
        phoneNr,          // BUG FIX: extracted from href="tel:" as primary source
        // BUG REPAIR: Caracteristici apartament
        heating,          // raw string: 'Autonomă', 'Centralizată' etc.
        condition,        // raw string: 'Euroreparație', 'Reparație cosmetică' etc.
        apartament_sery,  // raw string: 'Ms (serie moldovenească)', 'Individuală' etc.
        features,         // array of strings: ['Mobilat', 'Aer condiționat', ...]
        balcony,          // 1 (Da/Balcon/Logie) | 2 (Nu/Fără balcon) | null — numeric ID
        living,           // boolean | null
        developer,        // string | null
      };
    });

    // ── 4. Normalizare caracteristici (BUG REPAIR) ────────────
    // Mapări pentru a normaliza valorile extrase din 999.md
    // la valorile așteptate de Strapi

    const conditionMap = {
      'Euroreparație': 'Reparație euro',
      'Reparație cosmetică': 'Reparație medie',
      'Variantă albă': 'Fără reparație/ Variantă albă',
      'Fără reparație': 'Fără reparație/ Variantă albă',
      'Reparație euro': 'Reparație euro',
      'Reparație medie': 'Reparație medie',
      'Fără reparație/ Variantă albă': 'Fără reparație/ Variantă albă',
    };

    const seriesMap = {
      'Ms (serie moldovenească)': 'Ms (serie moldovenească)',
      'Ms (serie  moldovenească)': 'Ms (serie moldovenească)',
      'Individuală': 'Individuală',
      'Individual': 'Individuală',
      'Cehă': 'Cehă',
      'Ceha': 'Cehă',
      'Finlandeză': 'Finlandeză',
      'Finlandeza': 'Finlandeză',
      'Germană': 'Germană',
      'Germana': 'Germană',
      'Olandeză': 'Olandeză',
      'Olandeza': 'Olandeză',
      'Spaniolă': 'Spaniolă',
      'Spaniola': 'Spaniolă',
      'Italiană': 'Italiană',
      'Italiana': 'Italiană',
      'Leningrad': 'Leningrad',
      'Leningrad': 'Leningrad',
      'Hrușciov': 'Hrușciov',
      'Hrușciovka': 'Hrușciovka',
    };

    // BUG FIX: balconyMap now maps to numeric IDs for Strapi compatibility
    // 1 = Da/Balcon/Logie (yes), 2 = Nu/Fără balcon (no)
    const balconyMap = {
      1: 1,   // Already numeric ID 1 (Da/Balcon/Logie)
      2: 2,   // Already numeric ID 2 (Nu/Fără balcon)
      'Da': 1,
      'Nu': 2,
      'Balcon': 1,
      'Lojie': 1,
      'Balcon/ lojie': 1,
      'da': 1,
      'nu': 2,
      'yes': 1,
      'no': 2,
    };

    // ══════════════════════════════════════════════════════════════
    // HEATING DETECTION — Normalized diacritic-aware matching
    // ══════════════════════════════════════════════════════════════
    // Sources: advert.features, bodyText, description
    // Supports: "Autonomă", "Centralizată", "Încălzire autonomă",
    //           "Încălzire centralizată", "Centrala proprie"
    // ══════════════════════════════════════════════════════════════
    let normalizedHeating = null;
    const rawHeating = extracted.heating || null;

    if (rawHeating) {
      // Normalize: lowercase → NFD → strip diacritics → trim → deduplicate spaces
      const normalizedHeatingStr = rawHeating
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      console.log('[HEATING] Raw:', rawHeating);
      console.log('[HEATING] Normalized:', normalizedHeatingStr);

      // Detect autonomă (includes: autonomă, încălzire autonomă, centrala proprie)
      if (
        normalizedHeatingStr.includes('autonoma') ||
        normalizedHeatingStr.includes('centrala proprie')
      ) {
        normalizedHeating = 1;
      }

      // Detect centralizată (includes: centralizată, încălzire centralizată)
      if (normalizedHeatingStr.includes('centralizata')) {
        normalizedHeating = 2;
      }

      console.log('[HEATING] Final mapped ID:', normalizedHeating);
    } else {
      console.log('[HEATING] Raw: null — no heating data found');

      // ── HEATING FALLBACK: Infer from building/fund type when heating is missing ──
      if (extracted.building && extracted.building !== 'N/A') {
        const normalizedBuilding = extracted.building
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

        console.log('[HEATING FALLBACK] Building:', extracted.building);

        // New buildings → Autonomous (1)
        if (
          normalizedBuilding.includes('constructii noi') ||
          normalizedBuilding.includes('bloc nou')
        ) {
          normalizedHeating = 1;
          console.log('[HEATING FALLBACK] Selected heating: AUTONOMOUS (1) — new building detected');
        }

        // Secondary market → Centralized (2)
        if (
          normalizedBuilding.includes('fond secundar') ||
          normalizedBuilding.includes('secundar')
        ) {
          normalizedHeating = 2;
          console.log('[HEATING FALLBACK] Selected heating: CENTRALIZED (2) — secondary market detected');
        }
      }
    }

    // Normalizează condition
    let normalizedCondition = null;
    const condKey = extracted.condition ? extracted.condition.trim() : '';
    if (condKey && conditionMap[condKey]) {
      normalizedCondition = conditionMap[condKey];
    } else if (condKey) {
      // Fallback: dacă nu e în map, păstrează raw
      normalizedCondition = condKey;
    }
    console.log('[scrap_999] Parsed condition:', extracted.condition, '→ normalized:', normalizedCondition);

    // Normalizează apartament_sery
    let normalizedSerie = null;
    const serieKey = extracted.apartament_sery ? extracted.apartament_sery.trim() : '';
    if (serieKey && seriesMap[serieKey]) {
      normalizedSerie = seriesMap[serieKey];
    } else if (serieKey) {
      normalizedSerie = serieKey;
    }
    console.log('[scrap_999] Parsed apartament_sery:', extracted.apartament_sery, '→ normalized:', normalizedSerie);

    // Normalizează balcony — BUG FIX: map to numeric IDs for Strapi compatibility
    // balcony is now already a numeric ID (1 or 2) from page.evaluate(),
    // but we still support string fallback via balconyMap
    let normalizedBalcony = null;
    const rawBalcony = extracted.balcony;
    if (rawBalcony !== null && rawBalcony !== undefined && rawBalcony !== 'N/A') {
      // If already numeric (from new normalization inside page.evaluate)
      if (typeof rawBalcony === 'number') {
        normalizedBalcony = rawBalcony;
        console.log('[BALCONY] Already numeric ID:', normalizedBalcony);
      } else {
        // String fallback — map through balconyMap
        const balcKey = String(rawBalcony).trim();
        if (balcKey && balconyMap[balcKey] !== undefined) {
          normalizedBalcony = balconyMap[balcKey];
        } else if (balcKey) {
          // Try to parse as number
          const parsed = parseInt(balcKey, 10);
          normalizedBalcony = isNaN(parsed) ? null : parsed;
        }
      }
    }
    console.log('[BALCONY] Raw:', rawBalcony, '→ Final mapped ID:', normalizedBalcony);

    // Normalizează features: deduplicare + filtrare valori goale
    let normalizedFeatures = [];
    if (Array.isArray(extracted.features)) {
      normalizedFeatures = Array.from(new Set(extracted.features.filter(Boolean)));
    }
    console.log('[scrap_999] Parsed features:', extracted.features, '→ normalized:', normalizedFeatures);

    // Normalizează living
    let normalizedLiving = extracted.living;
    console.log('[scrap_999] Parsed living:', extracted.living, '→ normalized:', normalizedLiving);

    // Normalizează developer
    let normalizedDeveloper = extracted.developer;
    console.log('[scrap_999] Parsed developer:', extracted.developer);

    // ── 5. Aplică regionParser pe locație (BUG #2, #3 FIXED) ──
    const parsedLocation = parseLocation(extracted.location);
    const formattedLocation = formatLocation(parsedLocation, true);

    // ── 5. Formatează ID-ul ────────────────────────────────────
    const formatId = extracted.advertId
      ? `DB_Ap${extracted.advertId}`
      : 'N/A';

    // ── 6. Extrage telefonul (BUG #4 FIXED) ────────────────────
    const phoneNr = await extractPhoneFromPage(page);
    await browser.close();

    // ── 7. Construiește formattedText (BUG #1, #11 FIXED) ──────
    // Price numeric for filter URL (BUG #8)
    const priceNumeric = parsePriceToNumber(extracted.price);

    // Floor parsing (BUG #6)
    const floorParsed = parseFloorString(
      extracted.floor !== 'N/A' && extracted.totalFloors !== 'N/A'
        ? `${extracted.floor}/${extracted.totalFloors}`
        : extracted.floor
    );

    let formattedText = `${extracted.propertyType}.

📍 Locație: ${formattedLocation}
🛏️ Dormitoare: ${extracted.rooms}
📐 Suprafață: ${extracted.area} m²
🏢 Etaj: ${floorParsed.floor || extracted.floor}/${floorParsed.totalFloors || extracted.totalFloors}
🚽 Băi: ${extracted.bathrooms}
🏗️ Bloc: ${extracted.building}
💰 Preț: ${extracted.price}
${phoneNr ? `📞 Telefon: ${phoneNr}` : ''}
🆔 ID: ${formatId}`;

    // BUG #1 FIXED: clean escaped text
    formattedText = cleanEscapedText(formattedText);

    // BUG #10 FIXED: clean NaN, null injections
    // BUG v2.1 FIXED: normalizeWhitespace() was destroying multiline formatting
    // by replacing \n with spaces. Using normalizeText() instead, which
    // preserves intentional newlines while cleaning up extra whitespace.
    formattedText = normalizeText(formattedText);

    // ── 8. Deduplicate images (BUG #5 FIXED) ───────────────────
    const uniqueImages = deduplicateImages(extracted.images);

    // ── 9. Geolocation (BUG #9 FIXED + v2.1 street-level) ─────
    let geolocation = extracted.geolocation;
    if (!geolocation) {
      // Fallback: build full geoAddress from parsed location and query map.md
      console.log('⚠️ [scrap_999] No GPS in __NEXT_DATA__, querying map.md with full address');
      try {
        const { getGeolocation } = require('../../utils/mapmdgeoloc');
        const geoAddress = buildGeoAddress(parsedLocation);
        console.log('[GEO ADDRESS] Final address:', geoAddress);
        const coords = await getGeolocation(parsedLocation);
        if (coords) {
          geolocation = {
            lat: coords.latitude,
            lng: coords.longitude,
          };
          console.log('[GEO RESULT] Coordinates:', geolocation);
        }
      } catch (geoErr) {
        console.error('⚠️ [scrap_999] map.md fallback failed:', geoErr.message);
      }
    }

    // ── 10. Construiește obiectul de returnat ──────────────────
    const result = {
      formattedText,

      type: extracted.propertyType,
      link: fixedUrl,
      price: extracted.price,
      priceNumeric, // BUG #8: numeric price for filter URL
      offerType: extracted.offerType,
      regionText: extracted.location,
      // BUG #2, #3 FIXED: region array with correct order
      region: getLocationArrayForFilter(parsedLocation),
      // Parsed location components
      parsedLocation,
      rooms: extracted.rooms,
      area: extracted.area,
      floor: floorParsed.floor !== null ? String(floorParsed.floor) : extracted.floor,
      floors: floorParsed.totalFloors !== null ? String(floorParsed.totalFloors) : extracted.totalFloors,
      bathrooms: extracted.bathrooms,
      building: extracted.building,
      title: extracted.title,
      description: extracted.description,
      images: uniqueImages,
      phoneNr,
      advertId: formatId,
      geolocation,
      // BUG REPAIR: Caracteristici apartament normalizate
      heating: normalizedHeating,           // ID numeric pentru Strapi (1=autonomă, 2=centralizată)
      condition: normalizedCondition,       // string normalizat pentru matchFieldId
      serie: normalizedSerie,               // string normalizat pentru matchFieldId
      features: normalizedFeatures,         // array de stringuri normalizate
      balcony: normalizedBalcony,           // 1 (Da/Balcon/Logie) | 2 (Nu/Fără balcon) | null — numeric ID for Strapi
      living: normalizedLiving,             // boolean | null
      developer: normalizedDeveloper,       // string | null
    };

    console.log('✅ [scrap_999] Date extrase cu succes');
    console.log('📝 Output formatat:\n', formattedText);
    console.log('🔍 [scrap_999] Region array:', result.region);
    console.log('🔍 [scrap_999] Parsed location:', JSON.stringify(parsedLocation));
    console.log('🔍 [scrap_999] Price numeric:', priceNumeric);
    console.log('🔍 [scrap_999] Floor parsed:', JSON.stringify(floorParsed));
    console.log('🔍 [scrap_999] RAW images from page:', extracted.images.length);
    console.log('🔍 [scrap_999] RAW image URLs:', JSON.stringify(extracted.images.slice(0, 3)) + (extracted.images.length > 3 ? `... (+${extracted.images.length - 3} more)` : ''));
    console.log('🔍 [scrap_999] NORMALIZED unique images:', uniqueImages.length);
    console.log('🔍 [scrap_999] NORMALIZED image URLs:', JSON.stringify(uniqueImages.slice(0, 3)) + (uniqueImages.length > 3 ? `... (+${uniqueImages.length - 3} more)` : ''));
    console.log('🔍 [scrap_999] Phone:', phoneNr);
    console.log('🔍 [scrap_999] Geolocation:', JSON.stringify(geolocation));
    // BUG REPAIR: Debug logs for characteristics
    console.log('🔍 [scrap_999] Heating (normalized):', result.heating);
    console.log('🔍 [scrap_999] Condition (normalized):', result.condition);
    console.log('🔍 [scrap_999] Serie (normalized):', result.serie);
    console.log('🔍 [scrap_999] Features (normalized):', result.features);
    console.log('🔍 [scrap_999] Balcony (normalized):', result.balcony);
    console.log('🔍 [scrap_999] Living (normalized):', result.living);
    console.log('🔍 [scrap_999] Developer (normalized):', result.developer);

    return result;
  } catch (err) {
    console.error('❌ [scrap_999] Puppeteer scraper error:', err.message);
    console.error(err.stack);
    return null;
  }
};

module.exports = { scrap_999 };
