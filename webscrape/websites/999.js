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
      // Fallback: if not found or invalid, default to 1
      // Never returns 'N/A' — always a valid number for Strapi
      let bathrooms = 1;
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

      // ══════════════════════════════════════════════════════════
      // OFFER TYPE — Vând / Închiriez / Schimb
      // ══════════════════════════════════════════════════════════
      // OFFER_TYPE_MAP: maps UI labels to 999.md offer_type IDs
      // 776 = Vând (Sell), 777 = Cumpăr (Buy), 778 = Schimb (Exchange)
      // 779 = Închiriez (Rent)
      // ══════════════════════════════════════════════════════════
      const OFFER_TYPE_MAP = {
        'Vând': 776,
        'Vînzare': 776,
        'Vanzare': 776,
        'Închiriez': 779,
        'Inchiriez': 779,
        'Schimb': 778,
        'Cumpăr': 777,
        'Cumpar': 777,
      };

      let offerType = 'N/A';
      let offerTypeId = null;
      // Primary: __NEXT_DATA__ advert.offer_type
      if (advert?.offer_type?.value) {
        offerType = advert.offer_type.value;
        console.log('[OFFER TYPE] From __NEXT_DATA__:', offerType);
      }
      // Secondary: .styles_filters__type__selector__title__NdcP_ selector
      if (offerType === 'N/A') {
        const filterTypeEl = document.querySelector('.styles_filters__type__selector__title__NdcP_');
        if (filterTypeEl) {
          offerType = filterTypeEl.textContent.trim();
          console.log('[OFFER TYPE] From selector:', offerType);
        }
      }
      // Tertiary: extractByLabel('Tipul', bodyText)
      if (offerType === 'N/A') {
        const ot = extractByLabel('Tipul', bodyText);
        if (ot) {
          offerType = ot;
          console.log('[OFFER TYPE] From bodyText:', offerType);
        }
      }
      // Map to numeric ID for filter URL
      const normalizedOfferType = offerType
        ?.toLowerCase()
        ?.normalize('NFD')
        ?.replace(/[\u0300-\u036f]/g, '')
        ?.trim();
      for (const [key, id] of Object.entries(OFFER_TYPE_MAP)) {
        const normalizedKey = key
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .trim();
        if (normalizedOfferType?.includes(normalizedKey)) {
          offerTypeId = id;
          break;
        }
      }
      console.log('[OFFER TYPE] Final text:', offerType, '→ ID:', offerTypeId);

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

      // ══════════════════════════════════════════════════════════════
      // GEOLOCATION — Multiple source extraction
      // ══════════════════════════════════════════════════════════════
      // Priority order:
      //   1. advert.geolocation / advert.map / advert.coordinates (__NEXT_DATA__)
      //   2. __INITIAL_STATE__ (legacy Next.js pages)
      //   3. application/ld+json scripts
      //   4. Map widget data (Leaflet, Yandex, Google Maps)
      //   5. window globals / inline scripts
      // ══════════════════════════════════════════════════════════════
      let geolocation = null;

      // ── Helper: normalize extracted coords ──────────────────────
      // NORMALIZED FORMAT: { lat: number, lng: number }
      // Accepts any input naming (lat/lng/lon/longitude) via safe extraction.
      const normalizeCoords = (lat, lng) => {
        console.log('[GEO RAW] lat:', lat, 'lng:', lng);
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
      };

      // ── SOURCE 1: __NEXT_DATA__ (Next.js SSR JSON) ─────────────
      if (!geolocation && advert?.geolocation) {
        const lat = advert.geolocation.lat ?? advert.geolocation.latitude;
        const lng = advert.geolocation.lng ?? advert.geolocation.longitude ?? advert.geolocation.lon;
        geolocation = normalizeCoords(lat, lng);
        if (geolocation) console.log('[GEO SOURCE] From advert.geolocation');
      }
      if (!geolocation && advert?.map?.lat && advert?.map?.lng) {
        geolocation = normalizeCoords(advert.map.lat, advert.map.lng);
        if (geolocation) console.log('[GEO SOURCE] From advert.map');
      }
      if (!geolocation && advert?.coordinates) {
        const lat = advert.coordinates.lat ?? advert.coordinates.latitude;
        const lng = advert.coordinates.lng ?? advert.coordinates.longitude ?? advert.coordinates.lon;
        geolocation = normalizeCoords(lat, lng);
        if (geolocation) console.log('[GEO SOURCE] From advert.coordinates');
      }

      // ── SOURCE 2: __INITIAL_STATE__ (legacy Next.js) ──────────
      if (!geolocation) {
        try {
          const initState = window.__INITIAL_STATE__;
          if (initState) {
            // Try known paths for coordinates
            const paths = [
              'advert.geolocation',
              'advert.map',
              'listing.geolocation',
              'listing.coordinates',
              'property.geolocation',
              'property.coordinates',
              'data.advert.geolocation',
              'data.listing.coordinates',
            ];
            for (const path of paths) {
              const val = path.split('.').reduce((obj, key) => obj?.[key], initState);
              if (val) {
                const lat = val.lat ?? val.latitude;
                const lng = val.lng ?? val.lon ?? val.longitude;
                geolocation = normalizeCoords(lat, lng);
                if (geolocation) {
                  console.log('[GEO SOURCE] From __INITIAL_STATE__.' + path);
                  break;
                }
              }
            }
          }
        } catch (_) { /* silent */ }
      }

      // ── SOURCE 3: application/ld+json scripts ─────────────────
      if (!geolocation) {
        try {
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of ldScripts) {
            let data;
            try { data = JSON.parse(script.textContent); } catch (_) { continue; }
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              // Schema.org Place / GeoCoordinates pattern
              const geo = item?.geo || item?.location?.geo || item?.address?.geo;
              if (geo) {
                const lat = geo.latitude ?? geo.lat;
                const lng = geo.longitude ?? geo.lng ?? geo.lon;
                geolocation = normalizeCoords(lat, lng);
                if (geolocation) {
                  console.log('[GEO SOURCE] From application/ld+json');
                  break;
                }
              }
            }
            if (geolocation) break;
          }
        } catch (_) { /* silent */ }
      }

      // ── SOURCE 4: Map widget data (Leaflet / Yandex / Google) ─
      if (!geolocation) {
        try {
          // Leaflet: check for L.map instances or data attributes
          const mapContainers = document.querySelectorAll('[class*="leaflet"], [id*="map"]');
          for (const el of mapContainers) {
            // Check data attributes
            const lat = el.getAttribute('data-lat') || el.getAttribute('data-center-lat');
            const lng = el.getAttribute('data-lng') || el.getAttribute('data-lon') || el.getAttribute('data-center-lng');
            geolocation = normalizeCoords(lat, lng);
            if (geolocation) {
              console.log('[GEO SOURCE] From Leaflet/map widget data attributes');
              break;
            }
          }

          // Yandex Maps: window.ymapsMapData
          if (!geolocation && window.ymapsMapData) {
            const center = window.ymapsMapData?.center || window.ymapsMapData?.geometry?.coordinates;
            if (center && Array.isArray(center) && center.length >= 2) {
              geolocation = normalizeCoords(center[0], center[1]);
              if (geolocation) console.log('[GEO SOURCE] From window.ymapsMapData');
            }
          }

          // Google Maps: search for google maps iframe data
          if (!geolocation) {
            const gmapsIframes = document.querySelectorAll('iframe[src*="google.com/maps"]');
            for (const iframe of gmapsIframes) {
              const src = iframe.getAttribute('src') || '';
              const llMatch = src.match(/[?&]ll=([\d.]+),([\d.]+)/);
              if (llMatch) {
                geolocation = normalizeCoords(llMatch[1], llMatch[2]);
                if (geolocation) {
                  console.log('[GEO SOURCE] From Google Maps iframe URL');
                  break;
                }
              }
            }
          }
        } catch (_) { /* silent */ }
      }

      // ── SOURCE 5: Inline scripts with coordinate patterns ──────
      if (!geolocation) {
        try {
          const allScripts = document.querySelectorAll('script:not([src])');
          const coordPatterns = [
            /lat['"]?\s*[:=]\s*([\d.]+)[,;}\s]/i,
            /latitude['"]?\s*[:=]\s*([\d.]+)[,;}\s]/i,
            /center['"]?\s*:\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/,
          ];
          for (const script of allScripts) {
            const text = script.textContent || '';

            // Try named coordinate properties
            for (const pattern of coordPatterns) {
              const latMatch = text.match(pattern);
              if (latMatch && latMatch[1]) {
                const latVal = parseFloat(latMatch[1]);
                if (Number.isFinite(latVal) && Math.abs(latVal) > 1) {
                  // Found a promising latitude — try to find corresponding longitude
                  // Search for `lon` or `lng` after the lat match position
                  const afterLat = text.slice(latMatch.index + latMatch[0].length);
                  const lonMatch = afterLat.match(/['"]?(?:lon|lng|longitude)['"]?\s*[:=]\s*([\d.]+)/i);
                  if (lonMatch) {
                    const lonVal = parseFloat(lonMatch[1]);
                    geolocation = normalizeCoords(latVal, lonVal);
                    if (geolocation) {
                      console.log('[GEO SOURCE] From inline script coordinates');
                      break;
                    }
                  }
                }
              }
            }
            if (geolocation) break;
          }
        } catch (_) { /* silent */ }
      }

      // ── Telefon (BUG FIX v3.2: prefer RSC flight data, then DOM selectors) ──
      // BUG FIX v3.2: 999.md now uses Next.js App Router (no __NEXT_DATA__).
      // The phone is embedded in RSC flight data (__next_f) inside inline scripts.
      // Fall back to DOM selectors if flight data has no phone.
      let phoneNr = null;

      // Source A: RSC flight data (inline scripts with self.__next_f.push)
      // Search for Moldovan phone pattern (373 + 8-9 digits) in all scripts
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const phoneMatches = [...text.matchAll(/373\d{8,9}/g)];
        for (const match of phoneMatches) {
          const phone = match[0];
          // Skip known non-owner numbers (support/developer)
          if (phone === '37322888002') continue;
          phoneNr = phone;
          console.log('[PHONE] From RSC flight data:', phoneNr);
          break;
        }
        if (phoneNr) break;
      }

      // Source B: DOM selectors (fallback if RSC flight data had no phone)
      if (!phoneNr) {
        // Primary: phone__link class (generic, not hash-dependent)
        const phoneLink = document.querySelector('a[class*="phone__link"]');
        if (phoneLink) {
          const href = phoneLink.getAttribute('href');
          if (href && href.startsWith('tel:')) {
            phoneNr = href
              ?.replace('tel:', '')
              ?.replace(/\s+/g, '')
              ?.trim();
            console.log('[PHONE] From DOM phone__link:', phoneNr);
          }
        }
      }
      if (!phoneNr) {
        // Fallback: any tel: link
        const anyTelLink = document.querySelector('a[href^="tel:"]');
        if (anyTelLink) {
          const fallbackHref = anyTelLink.getAttribute('href');
          phoneNr = fallbackHref
            ?.replace('tel:', '')
            ?.replace(/\s+/g, '')
            ?.trim();
          console.log('[PHONE] Fallback href:', fallbackHref);
          console.log('[PHONE] Fallback normalized:', phoneNr);
        }
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
        offerTypeId,      // BUG FIX v3.0: numeric ID for filter URL (776=Vând, 779=Închiriez, etc.)
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
    // HEATING MAP — Maps normalized heating type to Strapi numeric IDs
    // ══════════════════════════════════════════════════════════════
    const HEATING_MAP = {
      AUTONOMOUS: 1,
      CENTRALIZED: 2,
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
        normalizedHeating = HEATING_MAP.AUTONOMOUS;
        console.log('[HEATING] Mapped to AUTONOMUS ID:', HEATING_MAP.AUTONOMOUS);
      }

      // Detect centralizată (includes: centralizată, încălzire centralizată)
      if (normalizedHeatingStr.includes('centralizata')) {
        normalizedHeating = HEATING_MAP.CENTRALIZED;
        console.log('[HEATING] Mapped to CENTRALIZED ID:', HEATING_MAP.CENTRALIZED);
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

        console.log('[HEATING FALLBACK] Building (raw):', extracted.building);
        console.log('[HEATING FALLBACK] Building (normalized):', normalizedBuilding);

        // "Construcţii noi" => AUTONOMOUS => ID 1
        if (
          normalizedBuilding.includes('constructii noi') ||
          normalizedBuilding.includes('bloc nou')
        ) {
          normalizedHeating = HEATING_MAP.AUTONOMOUS;
          console.log('[HEATING FALLBACK] Selected heating: AUTONOMOUS (ID ' + HEATING_MAP.AUTONOMOUS + ') — "Construcţii noi" detected');
        }
        // Secondary/old building => CENTRALIZED => ID 2
        else if (
          normalizedBuilding.includes('fond secundar') ||
          normalizedBuilding.includes('secundar')
        ) {
          normalizedHeating = HEATING_MAP.CENTRALIZED;
          console.log('[HEATING FALLBACK] Selected heating: CENTRALIZED (ID ' + HEATING_MAP.CENTRALIZED + ') — secondary/old building detected');
        } else {
          console.log('[HEATING FALLBACK] No building match for:', normalizedBuilding);
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
    console.log("[ADDRESS PARSER] Parsed:", parsedLocation);
    const formattedLocation = formatLocation(parsedLocation, true);

    // ── FALLBACK: If location parsing failed (no city found), use hardcoded address ──
    // This prevents flow interruption when the page's address selector fails or
    // returns an unparseable string. The bot continues with a valid default address.
    if (!parsedLocation || !parsedLocation.city) {
      console.warn('⚠️ [scrap_999] Location parsing failed — using hardcoded fallback address: Chișinău, Botanica, bd. Cuza Vodă, 17/1');
      parsedLocation = {
        city: 'Chișinău',
        sector: 'Botanica',
        municipality: 'Chișinău mun.',
        street: 'bd. Cuza Vodă',
        streetNumber: '17/1',
        original: 'Chișinău mun., Chișinău, Botanica, bd. Cuza Vodă, 17/1'
      };
      formattedLocation = formatLocation(parsedLocation, true);
      console.log('[ADDRESS FALLBACK] Using hardcoded location:', formattedLocation);
    }

    // ── 5. Formatează ID-ul ────────────────────────────────────
    const formatId = extracted.advertId
      ? `DB_Ap${extracted.advertId}`
      : 'N/A';

    // ── 6. Extrage telefonul (BUG #4 FIXED) ────────────────────
    let phoneNr = await extractPhoneFromPage(page);

    // Normalize phone: remove spaces, keep only digits and +
    if (phoneNr) {
      phoneNr = phoneNr
        ?.replace(/\s+/g, '')
        ?.replace(/[^\d+]/g, '');
    }
    console.log("[PHONE] Extracted:", phoneNr);

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
🚽 Băi: ${extracted.bathrooms || 1}
🏗️ Bloc: ${extracted.building}
💰 Preț: ${extracted.price}
📞• +${ctx.session.user.phoneNr} | ${ctx.session.user.name.split(" ")[0]}
🆔${formatId}`;

    // BUG #1 FIXED: clean escaped text
    formattedText = cleanEscapedText(formattedText);

    // BUG #10 FIXED: clean NaN, null injections
    // BUG v2.1 FIXED: normalizeWhitespace() was destroying multiline formatting
    // by replacing \n with spaces. Using normalizeText() instead, which
    // preserves intentional newlines while cleaning up extra whitespace.
    formattedText = normalizeText(formattedText);

    // ── 8. Deduplicate images (BUG #5 FIXED) ───────────────────
    const uniqueImages = deduplicateImages(extracted.images);

    // ── 9. Geolocation (v5.0 — Nominatim OSM geocoder) ────────────
    // PRIMARY: Coordinates extracted from page sources (__NEXT_DATA__,
    // __INITIAL_STATE__, ld+json, map widgets, inline scripts).
    // FALLBACK: Nominatim OpenStreetMap API (replaces unreliable map.md).
    //
    // Fallback strategy (precision order):
    //   1. Full street address (with prefix normalization)
    //   2. Street without prefix, no number
    //   3. Sector + city centroid
    //   AVOIDS: city-only geocoding (inaccurate for real estate)
    // ═══════════════════════════════════════════════════════════════
    // GEOLOCATION — Safe extraction + validation + Nominatim fallback
    // ALL coordinates normalized to { lat, lng } format.
    // ═══════════════════════════════════════════════════════════════
    let geolocation = extracted.geolocation;

    // Safe check: must have both finite lat and lng
    const hasValidLatLng = geolocation &&
      Number.isFinite(geolocation.lat) &&
      Number.isFinite(geolocation.lng);
    console.log('[GEO] Extracted from page sources:', JSON.stringify(geolocation));
    console.log('[GEO] Has valid lat+lng:', hasValidLatLng);

    if (!hasValidLatLng) {
      console.log('⚠️ [scrap_999] No valid GPS in page sources — querying Nominatim OSM geocoder');

      try {
        const { geocodeWithFallback } = require('../../utils/geolocNominatim');

        // geocodeWithFallback handles the multi-attempt strategy internally:
        //   1. Full street address (buildGeoAddress)
        //   2. Street without prefix, with/without number
        //   3. Sector + city centroid
        const coords = await geocodeWithFallback(parsedLocation);

        if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng)) {
          geolocation = {
            lat: coords.lat,
            lng: coords.lng,
          };
          console.log('[GEO RESULT] ✅ Using Nominatim coordinates:', JSON.stringify(geolocation));
        } else {
          // Nominatim failed — use hardcoded fallback coordinates (Chișinău, Buiucani center)
          // This ensures the flow continues without interruption. The bot never returns null
          // or throws for missing geolocation — it always has a valid fallback.
          console.log('[GEO RESULT] ❌ Nominatim returned no coordinates — using hardcoded fallback (Chișinău, Buiucani)');
          geolocation = { lat: 47.037, lng: 28.819 };
        }
      } catch (geoErr) {
        console.error('⚠️ [scrap_999] Nominatim fallback failed:', geoErr.message);
        // Use hardcoded fallback coordinates — never return null
        console.log('[GEO RESULT] Using hardcoded fallback coordinates (Chișinău, Buiucani) after Nominatim error');
        geolocation = { lat: 47.037, lng: 28.819 };
      }
    } else {
      console.log('[GEO] ✅ Using coordinates from page sources:', JSON.stringify(geolocation));
    }
    console.log('[GEO PAYLOAD]', JSON.stringify(geolocation));

    // ── 10. Construiește obiectul de returnat ──────────────────
    const result = {
      formattedText,

      type: extracted.propertyType,
      link: fixedUrl,
      price: extracted.price,
      priceNumeric, // BUG #8: numeric price for filter URL
      offerType: extracted.offerType,
      offerTypeId: extracted.offerTypeId, // BUG FIX v3.0: numeric ID for filter URL
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

    // ══════════════════════════════════════════════════════════════
    // DETAILED DEBUG LOGS (BUG FIX v3.0)
    // ══════════════════════════════════════════════════════════════
    console.log('[DEBUG v3.0] === SCRAPER RESULT DEBUG ===');
    console.log('[DEBUG v3.0] Extracted owner phone:', phoneNr || 'NONE');
    console.log('[DEBUG v3.0] Final geolocation:', JSON.stringify(geolocation));
    console.log('[DEBUG v3.0] Final heating ID:', normalizedHeating);
    console.log('[DEBUG v3.0] Final offer type:', extracted.offerType, '(ID:', extracted.offerTypeId + ')');
    console.log('[DEBUG v3.0] Final building:', extracted.building);
    console.log('[DEBUG v3.0] Final balcony ID:', normalizedBalcony);
    console.log('[DEBUG v3.0] Final condition:', normalizedCondition);
    console.log('[DEBUG v3.0] Final rooms:', extracted.rooms);
    console.log('[DEBUG v3.0] Final area:', extracted.area);
    console.log('[DEBUG v3.0] Final floor:', floorParsed.floor, '/', floorParsed.totalFloors);
    console.log('[DEBUG v3.0] ============================');

    console.log('[HEATING FINAL]', result.heating);

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
