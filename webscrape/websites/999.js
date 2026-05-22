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
  redactPhone,          // 🔒 GDPR/confidentiality phone redaction
} = require('../../utils/cleaners');

const {
  parseLocation,
  formatLocation,
  buildGeoAddress,
  getLocationArrayForFilter,
} = require('../../utils/regionParser');

// ── AI-Powered Floor Extraction (3-Stage) ───────────────────
// Se integrează în scraper pentru a garanta extragerea etajului
// chiar și când selectoarele statice eșuează.
const { aiExtractFloor } = require('../../ai/floorParserAI');
const { enhanceListingData } = require('../../ai/contentEnhancer');

// ── Anti-Hallucination Page Validation ──────────────────────
// Verifică dacă pagina există și conține un anunț valid
// ÎNAINTE de a extrage orice date. Oprește pipeline-ul dacă
// pagina e ștearsă, blocată sau inexistentă.
const { isPageValid, extractBodyContent } = require('../../utils/pageValidator');

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

    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("🕷️  [SCRAP_999] ÎNCEPE EXTRAGERE DATE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("🔗 URL:", fixedUrl);
    console.log("");

    // ── 2. Lansează browser ────────────────────────────────────
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(fixedUrl, { waitUntil: 'networkidle2' });

    console.log("✅ [SCRAP_999] Pagina încărcată cu succes");
    console.log("");

    // ══════════════════════════════════════════════════════════════
    // ANTI-HALLUCINATION: PAGE VALIDATION
    // ══════════════════════════════════════════════════════════════
    // ÎNAINTE de a extrage orice date, verificăm dacă pagina
    // conține un anunț VALID. Dacă e ștearsă/blocată/404,
    // OPRIM COMPLET procesarea și returnăm eroare.
    // ══════════════════════════════════════════════════════════════
    const pageTitle = await page.title();
    const pageHtml = await page.content();

    // ── Detailed Validation Debug Logging ──────────────────────────
    const bodyContent = extractBodyContent(pageHtml);
    console.log('📄 [VALIDATION] === Detailed Page Validation Diagnostics ===');
    console.log(`📄 [VALIDATION] Page title: "${pageTitle}"`);
    console.log(`📄 [VALIDATION] HTML length: ${pageHtml.length} chars`);
    console.log(`📄 [VALIDATION] Body content length: ${bodyContent.length} chars`);
    console.log(`🔍 [VALIDATION] Has "Suprafață totală": ${pageHtml.includes('Suprafață totală')}`);
    console.log(`🔍 [VALIDATION] Has "Număr de camere": ${pageHtml.includes('Număr de camere')}`);
    console.log(`🔍 [VALIDATION] Has "Preț": ${pageHtml.includes('Preț')}`);
    console.log(`🔍 [VALIDATION] Has "price": ${pageHtml.includes('price')}`);
    console.log(`🔍 [VALIDATION] Has "Etaj": ${pageHtml.includes('Etaj')}`);
    console.log(`🔍 [VALIDATION] Has price with currency (€/lei): ${/\d[\d\s]*(?:€|EUR|eur|lei|MDL)/.test(pageHtml)}`);
    console.log(`🔍 [VALIDATION] Has area (m² with number): ${/\d+\s*m²/.test(pageHtml)}`);
    console.log(`🔍 [VALIDATION] Has floor format (X/Y): ${/\d+\s*\/\s*\d+/.test(pageHtml)}`);
    console.log(`🔍 [VALIDATION] Has __NEXT_DATA__: ${pageHtml.includes('__NEXT_DATA__')}`);
    console.log(`🔍 [VALIDATION] Has "styles_group__feature__GsOUi": ${pageHtml.includes('styles_group__feature__GsOUi')}`);
    console.log(`🔍 [VALIDATION] Has "Anunțul nu a fost găsit" in body (scripts removed): ${bodyContent.includes('Anunțul nu a fost găsit')}`);
    console.log(`🔍 [VALIDATION] Has "Anunțul nu a fost găsit" in raw HTML: ${pageHtml.includes('Anunțul nu a fost găsit')}`);
    console.log('');

    const validation = isPageValid(pageHtml, { title: pageTitle, url: fixedUrl });
    if (!validation.valid) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`❌ [SCRAP_999] PAGE VALIDATION FAILED`);
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`  📄 URL:     ${fixedUrl}`);
      console.error(`  📌 Titlu:   ${pageTitle}`);
      console.error(`  🚫 Motiv:   ${validation.reason}`);
      if (validation.details) {
        console.error(`  📊 Detalii: ${JSON.stringify(validation.details)}`);
      }
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
      await browser.close();
      return {
        error: true,
        type: 'PAGE_NOT_FOUND',
        reason: validation.reason,
        link: fixedUrl,
        title: pageTitle,
      };
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`✅ [SCRAP_999] PAGE VALIDATION PASSED`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  📄 URL:     ${fixedUrl}`);
    console.log(`  📌 Titlu:   ${pageTitle}`);
    console.log(`  ✅ Motiv:   ${validation.reason}`);
    if (validation.details) {
      console.log(`  📊 Detalii: ${JSON.stringify(validation.details)}`);
    }
    console.log('═══════════════════════════════════════════════════════════');
    console.log("");

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
         CÂMPURILE — Extragere text cu logging organizat
         ========================================================= */

      console.log("───────────────────────────────────────────────────────────");
      console.log("📝 [SCRAP_999] EXTRAGERE TEXT");
      console.log("───────────────────────────────────────────────────────────");

      // ── 1. ID anunț ─────────────────────────────────────────────
      let advertId = null;
      if (advert?.id) {
        advertId = advert.id;
      } else {
        const idMatch = window.location.pathname.match(/\/(\d+)\/?$/);
        if (idMatch) advertId = idMatch[1];
      }
      console.log(`  🆔 1) ID anunț: ${advertId}`);

      // ── 2. Tip proprietate ──────────────────────────────────────
      // SURSE (în ordinea priorității):
      //   1. Title keywords — detectează "Spațiu de birou", "Oficiu" etc.
      //   2. Subcategorie 999.md (advert.categories.subcategory.title)
      //   3. Body text fallback
      let propertyType = 'N/A';
      let commercial_destination = null; // For commercial sub-type detection

      // Helper: detect commercial keywords in a string
      const hasCommercialKeywords = (str) => {
        if (!str) return false;
        // 🛡️ BUG FIX: Exclude apartment titles — "Apartament" clearly indicates a residential listing,
        // not a commercial one. The string "comercial" can false-match on some page titles.
        if (/^apartament/i.test(str.trim())) return false;

        // 🛡️ BUG FIX v2.1: If the text contains "Număr de camere" (apartment-specific feature),
        // or "Suprafață totală" combined with "Apartament", it's definitely residential
        if (/Număr de camere/i.test(str)) return false;
        if (/apartament/i.test(str) && /suprafaţă totală/i.test(str)) return false;

        const commercialPatterns = [
          /birou/i, /birouri/i, /spaţiu de birou/i, /spațiu de birou/i,
          /spaţiu comercial/i, /spațiu comercial/i,
          /comercial/i, /office/i, /magazin/i, /depozit/i,
          /local comercial/i, /sediu/i, /showroom/i,
          /spaţiu/i, /spațiu/i,  // "Spațiu de..." pattern
        ];
        return commercialPatterns.some(p => p.test(str));
      };

      // Helper: determine commercial destination from title/text
      const detectCommercialDestination = (str) => {
        if (!str) return null;
        // 🛡️ BUG FIX: Skip detection for apartment titles
        if (/^apartament/i.test(str.trim())) return null;
        // 🛡️ BUG FIX v2.1: Skip if text contains apartment-specific indicators
        if (/Număr de camere/i.test(str)) return null;
        if (/apartament/i.test(str) && /suprafaţă totală/i.test(str)) return null;
        if (/birou/i.test(str) || /birouri/i.test(str) || /office/i.test(str) || /sediu/i.test(str)) return 'Birou';
        if (/magazin/i.test(str) || /showroom/i.test(str) || /comercial/i.test(str) || /spaţiu comercial/i.test(str) || /spațiu comercial/i.test(str) || /local comercial/i.test(str)) return 'Comercial';
        if (/depozit/i.test(str) || /producere/i.test(str) || /depozit/i.test(str)) return 'Depozit/ Producere';
        // Default for generic "Spațiu" entries without specific destination
        if (/spaţiu/i.test(str) || /spațiu/i.test(str)) return 'Birou';
        return null;
      };

      // SURSA 1: Title (highest priority — "Spațiu de birou" in title overrides any subcategory)
      const h2Title = document.querySelector('h2');
      const pageTitleStr = document.title || '';
      const h2Text = h2Title ? h2Title.textContent.trim() : '';
      const combinedTitle = pageTitleStr || h2Text;

      if (hasCommercialKeywords(combinedTitle)) {
        propertyType = 'Comercial';
        commercial_destination = detectCommercialDestination(combinedTitle);
        console.log(`  🏠 2) Tip proprietate: ${propertyType} (din titlu: "${combinedTitle}")`);
        if (commercial_destination) {
          console.log(`  🏬 2a) Destinație comercială: ${commercial_destination} (din titlu)`);
        }
      }

      // SURSA 2: Subcategorie 999.md (only if not already determined by title)
      if (propertyType === 'N/A' && advert?.categories?.subcategory?.title) {
        const sub = advert.categories.subcategory.title;
        if (/apartamente/i.test(sub)) propertyType = 'Apartament';
        else if (/case/i.test(sub) || /vile/i.test(sub)) propertyType = 'Casă';
        else if (/comercial/i.test(sub)) {
          propertyType = 'Comercial';
          if (!commercial_destination) {
            commercial_destination = detectCommercialDestination(sub);
          }
        }
        else if (/teren/i.test(sub) || /loturi/i.test(sub)) propertyType = 'Teren';
        else propertyType = sub;
      }

      // SURSA 3: Body text fallback (only if still undetected)
      if (propertyType === 'N/A') {
        // 🛡️ BUG FIX v2.1: Check apartment indicators FIRST — bodyText contains ALL page text
        // including navigation/breadcrumbs like "Imobiliare comerciale" which falsely triggers
        // commercial detection. If the page has "Număr de camere" or mentions "Apartament",
        // it's residential regardless of commercial keywords in nav elements.
        const hasApartmentFeatures = /Număr de camere/i.test(bodyText);
        const hasApartmentText = /toate apartamentele|apartament/i.test(bodyText);

        if (hasApartmentFeatures || hasApartmentText) {
          propertyType = 'Apartament';
        } else if (hasCommercialKeywords(bodyText)) {
          propertyType = 'Comercial';
          if (!commercial_destination) {
            commercial_destination = detectCommercialDestination(bodyText);
          }
        } else if (/toate casele|casă|vile/i.test(bodyText)) propertyType = 'Casă';
        else if (/imobiliare comerciale|comercial/i.test(bodyText)) {
          propertyType = 'Comercial';
          if (!commercial_destination) {
            commercial_destination = detectCommercialDestination(bodyText);
          }
        }
        else if (/loturi de teren|teren/i.test(bodyText)) propertyType = 'Teren';
      }

      // SURSA 4: Heuristic fallback — if no rooms field AND area < 25 m², likely commercial
      if (propertyType === 'Apartament') {
        const areaRaw = extractByLabel('Suprafață totală', bodyText);
        const areaNum = areaRaw ? parseInt(extractNumber(areaRaw) || '0', 10) : 0;
        const hasRoomsLabel = /Număr de camere/i.test(bodyText);

        if (!hasRoomsLabel && areaNum > 0 && areaNum < 25) {
          console.log(`  ⚠️ 2) Heuristic: Area ${areaNum}m² without "Număr de camere" — likely commercial, overriding "Apartament"`);
          propertyType = 'Comercial';
          if (!commercial_destination) {
            // If the title contains clues, use them; otherwise default to Birou
            if (hasCommercialKeywords(combinedTitle)) {
              commercial_destination = detectCommercialDestination(combinedTitle);
            } else {
              commercial_destination = 'Birou';
            }
          }
        }
      }

      console.log(`  🏠 2) Tip proprietate: ${propertyType}`);
      if (commercial_destination) {
        console.log(`  🏬 2a) Destinație comercială: ${commercial_destination}`);
      }

      // ── 3. Locație completă ─────────────────────────────────────
      // BUG FIX: Use .styles_map__title__UgISm as PRIMARY source for address
      // Supports Romanian, Russian, and mixed addresses
      let location = 'N/A';
      const mapTitleEl = document.querySelector('.styles_map__title__UgISm');
      if (mapTitleEl) {
        location = mapTitleEl.textContent.trim();
      }
      if (location === 'N/A') {
        const regionMatch = bodyText.match(/Regiunea\s*[:]\s*(.+?)(?:\n|$)/i);
        if (regionMatch) {
          location = regionMatch[1].trim();
        }
      }
      if (location === 'N/A') {
        const h2 = document.querySelector('h2');
        if (h2) {
          const h2Text = h2.textContent.trim();
          const parts = h2Text.split(',').map(s => s.trim());
          if (parts.length >= 2) {
            location = parts.slice(1).join(', ').trim();
          }
        }
      }
      console.log(`  📍 3) Locație: ${location}`);

      // ── 4. Număr de camere (dormitoare) ─────────────────────────
      let rooms = 'N/A';
      const roomsRaw = extractByLabel('Număr de camere', bodyText);
      if (roomsRaw) {
        if (/o cameră/i.test(roomsRaw)) rooms = '1';
        else {
          const n = extractNumber(roomsRaw);
          if (n) rooms = n;
        }
      }
      console.log(`  🛏️ 4) Camere: ${rooms}`);

      // ── 5. Suprafață ────────────────────────────────────────────
      let area = 'N/A';
      const areaRaw = extractByLabel('Suprafață totală', bodyText);
      if (areaRaw) {
        const n = extractNumber(areaRaw);
        if (n) area = n;
      }
      console.log(`  📐 5) Suprafață: ${area} m²`);

      // ── 6. Etaj (BUG #6 FIXED: parse "6/12" correctly) ─────────
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
      console.log(`  🏢 6) Etaj: ${floor}/${totalFloors}`);

      // ── 7. Băi (Grup sanitar) ──────────────────────────────────
      // Fallback: if not found or invalid, default to 1
      // Never returns 'N/A' — always a valid number for Strapi
      let bathrooms = 1;
      const bathRaw = extractByLabel('Grup sanitar', bodyText);
      if (bathRaw) {
        const n = extractNumber(bathRaw);
        if (n) bathrooms = n;
      }
      console.log(`  🚽 7) Băi: ${bathrooms}`);

      // ── 8. Tip construcție (Fond locativ) ───────────────────────
      let building = 'N/A';
      const buildingRaw = extractByLabel('Fond locativ', bodyText);
      if (buildingRaw) {
        building = buildingRaw;
      }
      console.log(`  🏗️ 8) Bloc: ${building}`);

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

      // ── 9. Preț ─────────────────────────────────────────────────
      // Helper: parse a European-formatted number string to integer
      // "285.000" → 285000, "285 000" → 285000, "3 202" → 3202
      function parseEuropeanNumber(str) {
        if (!str) return NaN;
        let s = str.replace(/\s+/g, '');   // remove spaces
        // If contains dots but no commas → European format (dots = thousands)
        if (s.includes('.') && !s.includes(',')) {
          s = s.replace(/\./g, '');
        }
        // If contains commas but no dots → European format (commas = thousands)
        if (s.includes(',') && !s.includes('.')) {
          s = s.replace(/,/g, '');
        }
        return parseInt(s, 10);
      }

      let price = 'N/A';

      // PRIMARY: CSS selector for the exact price element on the page
      // Uses [data-onboarding="advert-currency-rates"] which is more stable than hashed classes
      const priceContainer = document.querySelector('[data-onboarding="advert-currency-rates"]');
      if (priceContainer) {
        const priceSpan = priceContainer.querySelector('span') || priceContainer;
        const priceText = priceSpan.textContent.trim();
        const priceMatch = priceText.match(/([\d\s]+)\s*(€|EUR|eur)/i);
        if (priceMatch) {
          const num = parseEuropeanNumber(priceMatch[1]);
          if (!isNaN(num) && num > 0) {
            price = `${num.toLocaleString()} €`;
          }
        }
      }

      // SECONDARY: __NEXT_DATA__ advert.price (with European number parsing)
      if (price === 'N/A' && advert?.price?.value != null && advert?.price?.unit) {
        const val = parseEuropeanNumber(String(advert.price.value));
        if (!isNaN(val) && val > 0) {
          const unit = String(advert.price.unit).toUpperCase();
          price = `${val.toLocaleString()} ${unit === 'EUR' ? '€' : unit}`;
        }
      }

      // TERTIARY: Find ALL € amounts in bodyText, pick the LARGEST (actual sale price)
      if (price === 'N/A') {
        const priceRegex = /(\d[\d\s]*)\s*(€|EUR|eur)/gi;
        let match;
        const allMatches = [];
        while ((match = priceRegex.exec(bodyText)) !== null) {
          allMatches.push(match);
        }
        if (allMatches.length > 0) {
          // Parse all matches, filter valid, sort descending by value
          const parsed = allMatches
            .map(m => ({ raw: m[1], num: parseEuropeanNumber(m[1]) }))
            .filter(p => !isNaN(p.num) && p.num > 0)
            .sort((a, b) => b.num - a.num);
          if (parsed.length > 0) {
            // Pick the largest price (most likely the total sale price)
            price = `${parsed[0].num.toLocaleString()} €`;
          }
        }
      }
      console.log(`  💰 9) Preț: ${price}`);

      // ══════════════════════════════════════════════════════════
      // 10. OFFER TYPE — Vând / Închiriez / Schimb
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
      }
      // Secondary: .styles_filters__type__selector__title__NdcP_ selector
      if (offerType === 'N/A') {
        const filterTypeEl = document.querySelector('.styles_filters__type__selector__title__NdcP_');
        if (filterTypeEl) {
          offerType = filterTypeEl.textContent.trim();
        }
      }
      // Tertiary: extractByLabel('Tipul', bodyText)
      if (offerType === 'N/A') {
        const ot = extractByLabel('Tipul', bodyText);
        if (ot) {
          offerType = ot;
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
      console.log(`  🏷️ 10) Oferta: ${offerType} (ID: ${offerTypeId})`);

      // ── 11. Titlu ────────────────────────────────────────────────
      let title = 'N/A';
      if (advert?.title) {
        title = advert.title;
      } else {
        const h2 = document.querySelector('h2');
        if (h2) title = h2.textContent.trim();
      }
      console.log(`  📌 11) Titlu: ${title}`);

      // ── 12. Descriere ────────────────────────────────────────────
      let description = 'N/A';
      if (advert?.body) {
        description = advert.body;
      }
      const descPreview = description !== 'N/A' ? description.substring(0, 80).replace(/\n/g, ' ') + '...' : 'N/A';
      console.log(`  📄 12) Descriere: ${descPreview}`);

      // ══════════════════════════════════════════════════════════════════
      // IMAGINI — BUG FIX: Extrage DOAR imaginile reale ale anunțului
      // ══════════════════════════════════════════════════════════════
      // PROBLEMA (veche): Se extrăgeau imagini din TOATE <img>-urile paginii.
      // 999.md injectează "recommended ads" și "similar listings" în DOM
      // după galeria principală, iar acestea conțin imagini de pe același CDN
      // (simpalsmedia.com/999.md/BoardImages). Filtrul extractImageUrl() NU
      // poate distinge între imaginile reale și cele recomandate.
      //
      // SOLUȚIA:
      //   1. Sursa PRIMARĂ: __NEXT_DATA__ → advert.photos / advert.images
      //      (SSR autoritativ — conține DOAR imaginile reale ale anunțului)
      //   2. Sursa SECUNDARĂ: Extragere DOAR din containerul galeriei
      //      (găsit prin selectori structurali), NICIODATĂ din toată pagina
      //   3. Containerul galeriei exclude automat recommended/similar ads
      // ══════════════════════════════════════════════════════════════
      const MAX_SCRAPER_IMAGES = 20;
      const images = [];
      const seenUrls = new Set();
      let imgCounter = 0;

      console.log("───────────────────────────────────────────────────────────");
      console.log("📸 [SCRAP_999] EXTRAGERE IMAGINI");
      console.log("───────────────────────────────────────────────────────────");

      // ── Helper: normalizează URL imagine 999.md la full-size (900x900) ──
      function extractImageUrl(rawSrc) {
        if (!rawSrc) return null;
        const src = rawSrc.trim();
        if (!src.includes('simpalsmedia.com/999.md/BoardImages')) return null;
        if (!src.startsWith('http')) return null;
        // Convertim la full-size (900x900)
        let fullSize = src.replace(/\/\d+x\d+\//, '/900x900/').split('?')[0];
        // Normalize: fix double slashes in PATH only, preserve protocol
        const protoEnd = fullSize.indexOf('://') + 3;
        const pathPart = fullSize.substring(protoEnd);
        const cleanPath = pathPart.replace(/\/{2,}/g, '/');
        fullSize = fullSize.substring(0, protoEnd) + cleanPath;
        return fullSize;
      }

      // ── Helper: extrage URL dintr-un element imagine (src sau data-src) ──
      function getImgUrl(img) {
        return img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy') || '';
      }

      // ── Helper: adaugă URL în lista de imagini (cu deduplicare + limită) ──
      function addImage(url) {
        if (!url) return;
        if (images.length >= MAX_SCRAPER_IMAGES) return;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        images.push(url);
        imgCounter++;
        console.log(`  📷 Imagine ${imgCounter}: ${url}`);
      }

      // ── Helper: găsește containerul galeriei principale ─────────────────
      function findGalleryContainer() {
        // Strategie multi-selector pentru a găsi containerul oficial al galeriei
        const selectors = [
          // CSS module: orice clasă care conține "gallery" (ex: styles_gallery__abc123)
          '[class*="gallery"]',
          // Swiper carousel (999.md folosește Swiper în galerie)
          '.swiper',
          // Orice container cu "slider" în clasă
          '[class*="slider"]',
          // Orice container cu "carousel" în clasă (ortografie alternativă)
          '[class*="carousel"]',
          // Container cu "photos" în clasă
          '[class*="photos"]',
        ];
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            console.log(`  🔍 [GALERIE] Container găsit cu selectorul: "${selector}"`);
            return el;
          }
        }
        // Dacă niciun selector nu a găsit containerul, caută primul element
        // care conține 2+ imagini BoardImages — probabil galeria principală
        console.log('  🔍 [GALERIE] Căutare container fallback — primul element cu multiple BoardImages...');
        const allCandidates = document.querySelectorAll('div, section, main, article');
        for (const candidate of allCandidates) {
          const imgs = candidate.querySelectorAll('img');
          let boardCount = 0;
          for (const img of imgs) {
            const url = getImgUrl(img);
            if (url && url.includes('simpalsmedia.com/999.md/BoardImages')) boardCount++;
            if (boardCount >= 2) {
              console.log(`  🔍 [GALERIE] Container fallback găsit: <${candidate.tagName.toLowerCase()} class="${(candidate.className || '').slice(0, 60)}">`);
              return candidate;
            }
          }
        }
        console.log('  ⚠️ [GALERIE] Niciun container de galerie găsit — fallback la document.body');
        return document.body;
      }

      // ── DEBUG: Numără imagini BoardImages în toată pagina (pentru comparație) ──
      const allPageImages = Array.from(document.querySelectorAll('img[src], img[data-src], img[data-lazy]'))
        .filter(img => {
          const url = getImgUrl(img);
          return url && url.includes('simpalsmedia.com/999.md/BoardImages');
        });
      console.log(`  🔢 [DEBUG] Total imagini BoardImages pe PAGINA ÎNTREAGĂ: ${allPageImages.length}`);

      // ══════════════════════════════════════════════════════════════
      // SURSA 1 (PRIMARĂ): __NEXT_DATA__ → advert.photos / advert.images
      // ══════════════════════════════════════════════════════════════
      // SSR data conține DOAR imaginile reale ale anunțului (0% risc de
      // contaminare cu recommended/similar ads).
      // ══════════════════════════════════════════════════════════════
      let ssrImageUrls = [];
      if (advert) {
        // Verifică mai multe nume de proprietăți posibile
        const photoCandidates = [
          advert.photos,
          advert.images,
          advert.pictures,
        ];
        for (const photos of photoCandidates) {
          if (Array.isArray(photos) && photos.length > 0) {
            ssrImageUrls = photos
              .map(p => {
                // Poate fi obiect { url: "..." } sau direct string
                const rawUrl = typeof p === 'string' ? p : (p?.url || p?.src || p?.full_url || p?.path || p?.link);
                return extractImageUrl(rawUrl);
              })
              .filter(Boolean);
            if (ssrImageUrls.length > 0) {
              console.log(`  📦 [SSR] imagini din __NEXT_DATA__.${photoCandidates.indexOf(photos) === 0 ? 'photos' : photoCandidates.indexOf(photos) === 1 ? 'images' : 'pictures'}: ${ssrImageUrls.length}`);
              break;
            }
          }
        }
      }

      if (ssrImageUrls.length > 0) {
        // Folosește imaginile din SSR — sunt autoritative și nu conțin recomandări
        console.log(`  ✅ [SURSĂ] Folosesc ${ssrImageUrls.length} imagini din __NEXT_DATA__ SSR (autoritative, 0% recomandări)`);
        ssrImageUrls.forEach(url => addImage(url));
        console.log(`  🎯 [GALERIE] Număr REAL în galerie (SSR): ${ssrImageUrls.length}`);
      } else {
        // ══════════════════════════════════════════════════════════
        // SURSA 2 (SECUNDARĂ): Containerul galeriei principale
        // ══════════════════════════════════════════════════════════
        // Când SSR nu are imagini (999.md App Router → uneori __NEXT_DATA__
        // lipsește sau nu conține photos), extragem DOAR din containerul
        // galeriei — NICIODATĂ din toată pagina.
        // ══════════════════════════════════════════════════════════
        console.log('  ℹ️ [SURSĂ] __NEXT_DATA__ nu conține imagini — caut container galerie în DOM');
        const galleryContainer = findGalleryContainer();

        // Debug: câte imagini BoardImages sunt în containerul galeriei
        const galleryImgs = galleryContainer.querySelectorAll('img');
        let galleryBoardCount = 0;
        galleryImgs.forEach(img => {
          const url = getImgUrl(img);
          if (url && url.includes('simpalsmedia.com/999.md/BoardImages')) galleryBoardCount++;
        });
        console.log(`  🎯 [GALERIE] Număr REAL detectat în containerul galeriei: ${galleryBoardCount} imagini BoardImages`);
        console.log(`  🎯 [GALERIE] Diferență față de totalul paginii: ${allPageImages.length - galleryBoardCount} imagini în afara galeriei (recommended/similar/thumbnails)`);

        // Extrage imagini DOAR din containerul galeriei
        galleryImgs.forEach(img => {
          const url = extractImageUrl(getImgUrl(img));
          addImage(url);
        });

        console.log(`  ✅ [SURSĂ] Folosesc ${images.length} imagini din containerul galeriei (excluse ${allPageImages.length - images.length} imagini din recommended/similar ads)`);
      }

      // ══════════════════════════════════════════════════════════════
      // FALLBACK: og:image — doar dacă nu s-a găsit NICI o imagine
      // ══════════════════════════════════════════════════════════════
      if (images.length === 0) {
        console.log('  ⚠️ [FALLBACK] Nicio imagine găsită în SSR sau galerie — încerc og:image');
        const ogImage = document.querySelector('meta[property="og:image"]');
        if (ogImage) {
          const url = extractImageUrl(ogImage.getAttribute('content'));
          addImage(url);
        }
      }

      // ── DEBUG FINAL: TOATE URL-urile imaginilor ────────────────
      console.log(`───────────────────────────────────────────────────────────`);
      console.log(`📊 [DEBUG] RAPORT IMAGINI`);
      console.log(`───────────────────────────────────────────────────────────`);
      console.log(`  🔢 Total imagini pe PAGINA ÎNTREAGĂ: ${allPageImages.length}`);
      console.log(`  🎯 Număr REAL în galeria anunțului: ${images.length}`);
      console.log(`  📊 Selector folosit: ${ssrImageUrls.length > 0 ? '__NEXT_DATA__ SSR' : 'findGalleryContainer()'}`);
      console.log(`✅ [SCRAP_999] Total imagini extrase: ${images.length}`);
      console.log(`📸 TOATE imaginile:`);
      images.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
      console.log("");

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
          if (phone === '[număr suport ascuns - restricție permanentă]') continue;
          phoneNr = phone;
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
        }
      }
      // 🔒 Redactează numărul restricționat (confidențialitate)
      if (phoneNr) {
        const normalizedPhone = phoneNr.replace(/[^\d+]/g, '');
        if (normalizedPhone === '+37322888002') {
          phoneNr = null;
        }
      }
      console.log(`  📞 13) Telefon: ${phoneNr || 'N/A'}`);

      // ── 14. Geolocare ───────────────────────────────────────────
      const geoStr = geolocation ? `${geolocation.lat}, ${geolocation.lng}` : 'N/A';
      console.log(`  🌍 14) Geolocare: ${geoStr}`);

      console.log("───────────────────────────────────────────────────────────");
      console.log("✅ [SCRAP_999] EXTRAGERE TEXT COMPLETĂ");
      console.log("───────────────────────────────────────────────────────────");

      // ── Return ───────────────────────────────────────────────
      return {
        advertId,
        propertyType,
        commercial_destination, // BUG FIX: Commercial sub-type for Strapi
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
    // 🔒 Redactează numerele de telefon restricționate (confidențialitate)
    phoneNr = redactPhone(phoneNr);
    console.log("[PHONE] Extracted:", phoneNr ? phoneNr : '[telefon ascuns]');

    await browser.close();

    // ── AI FLOOR PARSER FALLBACK (3-Stage) ──────────────────
    // Dacă floor parsing-ul static a eșuat, folosim AI pentru
    // a extrage etajul din HTML brut sau din context.
    // STAGE 1: regex, STAGE 2: AI pe HTML, STAGE 3: AI inference.
    // ══════════════════════════════════════════════════════════
    // Initialize floorParsed from static extraction results (or null if N/A)
    // This object is used by the AI floor parser fallback and the formatted text
    const floorParsed = {
      floor: extracted.floor !== 'N/A' && extracted.floor != null ? parseInt(extracted.floor, 10) || null : null,
      totalFloors: extracted.totalFloors !== 'N/A' && extracted.totalFloors != null ? parseInt(extracted.totalFloors, 10) || null : null,
    };
    let floorAIUsed = false;
    let floorAISource = 'static';

    if (extracted.floor === 'N/A' || extracted.totalFloors === 'N/A' || !floorParsed.floor) {
      console.log('');
      console.log('⚠️ [SCRAP_999] Static floor parsing failed — activating AI floor parser (3-Stage)');
      try {
        const bodyText = extracted.bodyText || '';
        const htmlSnippet = bodyText ? `<body>${bodyText.substring(0, 10000)}</body>` : null;
        const aiFloorResult = await aiExtractFloor(
          bodyText,                          // raw HTML (bodyText)
          htmlSnippet,                        // HTML snippet for AI
          {                                  // extracted data for context
            title: extracted.title,
            description: extracted.description,
            bodyText: bodyText.substring(0, 5000),
            building: extracted.building,
            propertyType: extracted.propertyType,
            location: extracted.location,
          }
        );

        if (aiFloorResult.floor != null || aiFloorResult.floors != null) {
          console.log(`[SCRAP_999] ✅ AI floor parser found: floor=${aiFloorResult.floor}, floors=${aiFloorResult.floors} (source: ${aiFloorResult.source})`);
          
          // Actualizează valorile doar dacă AI a găsit ceva
          if (aiFloorResult.floor != null) {
            floorParsed.floor = aiFloorResult.floor;
            extracted.floor = String(aiFloorResult.floor);
          }
          if (aiFloorResult.floors != null) {
            floorParsed.totalFloors = aiFloorResult.floors;
            extracted.totalFloors = String(aiFloorResult.floors);
          }
          
          floorAIUsed = true;
          floorAISource = aiFloorResult.source || 'ai_enhanced';
        } else {
          console.log('[SCRAP_999] ⚠️ AI floor parser also failed — using defaults');
        }
      } catch (aiFloorErr) {
        console.error('[SCRAP_999] ❌ AI floor parser error (non-blocking):', aiFloorErr.message);
      }
    }

    // ══════════════════════════════════════════════════════════
    // AI CONTENT ENHANCEMENT — Completează date lipsă cu AI
    // ══════════════════════════════════════════════════════════
    let aiEnhancedAnyField = false;
    try {
      const partialData = {
        type: extracted.propertyType,
        rooms: extracted.rooms,
        area: extracted.area,
        floor: extracted.floor,
        floors: extracted.totalFloors,
        bathrooms: extracted.bathrooms,
        building: extracted.building,
        condition: extracted.condition,
        heating: extracted.heating,
        price: extracted.price,
        description: extracted.description,
        phoneNr: phoneNr,
      };
      
      const enhanced = await enhanceListingData(partialData, extracted.bodyText || '');
      
      // Apply enhanced values where original is still N/A or missing
      const checkAndApply = (target, sourceKey, extractedFallback) => {
        if (target[sourceKey] && target[sourceKey] !== 'N/A' && target[sourceKey] !== '') {
          if ((!extracted[extractedFallback] || extracted[extractedFallback] === 'N/A')) {
            extracted[extractedFallback] = target[sourceKey];
            aiEnhancedAnyField = true;
            console.log(`[SCRAP_999] ✅ AI enhanced "${extractedFallback}": "${target[sourceKey]}"`);
          }
        }
      };
      
      checkAndApply(enhanced, 'type', 'propertyType');
      checkAndApply(enhanced, 'rooms', 'rooms');
      checkAndApply(enhanced, 'area', 'area');
      checkAndApply(enhanced, 'floor', 'floor');
      checkAndApply(enhanced, 'floors', 'totalFloors');
      checkAndApply(enhanced, 'bathrooms', 'bathrooms');
      checkAndApply(enhanced, 'price', 'price');
      checkAndApply(enhanced, 'phoneNr', null);
      
      if (enhanced.description && enhanced.description !== 'N/A' &&
          (!extracted.description || extracted.description === 'N/A')) {
        extracted.description = enhanced.description;
        aiEnhancedAnyField = true;
      }
    } catch (aiEnhanceErr) {
      console.error('[SCRAP_999] ❌ AI content enhancement error (non-blocking):', aiEnhanceErr.message);
    }

    // ── 7. Construiește formattedText (BUG #1, #11 FIXED) ──────
    // Price numeric for filter URL (BUG #8)
    const priceNumeric = parsePriceToNumber(extracted.price);

    let formattedText = `${extracted.propertyType}.

📍 Locație: ${formattedLocation}
🛏️ Dormitoare: ${extracted.rooms}
📐 Suprafață: ${extracted.area} m²
🏢 Etaj: ${floorParsed.floor || extracted.floor}/${floorParsed.totalFloors || extracted.totalFloors}
🚽 Băi: ${extracted.bathrooms || 1}
🏗️ Bloc: ${extracted.building}
💰 Preț: ${extracted.price}
📞+${ctx.session.user.phoneNr}|${ctx.session.user.name.split(" ")[0]}
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
    // BUG FIX: NEVER return null/N/A — replace with safe defaults
    // This ensures the posting pipeline never crashes on missing data
    const result = {
      formattedText,

      type: extracted.propertyType || 'Apartament',
      // BUG FIX: Pass commercial_destination for Strapi commercial endpoint
      commercial_destination: extracted.commercial_destination || null,
      link: fixedUrl,
      price: extracted.price || 'N/A',
      priceNumeric: priceNumeric || 0, // BUG #8: numeric price for filter URL
      // BUG FIX v4.0: offerType must be one of the VALID known values.
      // 999.md can return garbage (e.g. "confecției);- Termopan...") when the
      // CSS selectors or extractByLabel('Tipul', bodyText) match the WRONG content.
      // Only accept values that match known offer types from OFFER_TYPE_MAP.
      offerType: (() => {
        const raw = (extracted.offerType && extracted.offerType !== 'N/A') ? extracted.offerType : null;
        if (!raw) return 'Vând';
        // Normalize for comparison
        const normalized = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
        // Valid normalized values from OFFER_TYPE_MAP
        const VALID_OFFER_TYPES = ['vand', 'vinzare', 'vanzare', 'inchiriez', 'schimb', 'cumpar', 'cumpar'];
        const isValid = VALID_OFFER_TYPES.some(v => normalized.includes(v));
        if (isValid) return raw; // Keep original
        console.warn(`[scrap_999] ⚠️ Invalid offerType "${raw}" — defaulting to "Vând"`);
        return 'Vând';
      })(),
      offerTypeId: extracted.offerTypeId || 776, // BUG FIX v3.0: numeric ID for filter URL (776 = Vând)
      regionText: extracted.location || 'Chișinău',
      // BUG #2, #3 FIXED: region array with correct order
      region: getLocationArrayForFilter(parsedLocation),
      // Parsed location components
      parsedLocation,
      // ANTI-HALLUCINATION: NU mai folosim fallback-uri hardcodate!
      // Dacă un câmp nu există în pagină, returnăm null — NU inventăm '1', '50', etc.
      // Pipeline-ul downstream (postare, filtre) trebuie să oprească postarea
      // când câmpurile obligatorii sunt null.
      rooms: extracted.rooms !== 'N/A' && extracted.rooms != null ? extracted.rooms : null,
      area: extracted.area !== 'N/A' && extracted.area != null ? extracted.area : null,
      floor: floorParsed.floor !== null ? String(floorParsed.floor) : (extracted.floor !== 'N/A' ? extracted.floor : null),
      floors: floorParsed.totalFloors !== null ? String(floorParsed.totalFloors) : (extracted.totalFloors !== 'N/A' ? extracted.totalFloors : null),
      bathrooms: extracted.bathrooms || 1,
      building: extracted.building || 'Construcţii noi',
      title: extracted.title || 'Anunț imobiliar',
      description: extracted.description || '',
      images: uniqueImages,
      phoneNr: phoneNr || '',
      advertId: formatId || '',
      geolocation: geolocation || { lat: 47.037, lng: 28.819 },
      // BUG REPAIR: Caracteristici apartament normalizate — NEVER null
      heating: normalizedHeating != null ? normalizedHeating : 1,           // ID numeric (1=autonomă — cel mai comun)
      condition: normalizedCondition || '',                                 // string gol în loc de null
      serie: normalizedSerie || '',                                         // string gol în loc de null
      features: normalizedFeatures || [],                                   // array gol în loc de null
      balcony: normalizedBalcony != null ? normalizedBalcony : 1,           // 1 (Da) — implicit pozitiv
      living: normalizedLiving != null ? normalizedLiving : false,          // boolean, niciodată null
      developer: normalizedDeveloper || '',                                 // string gol în loc de null
    };

    // ══════════════════════════════════════════════════════════════
    // REZUMAT FINAL ORGANIZAT
    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("📊 [SCRAP_999] REZUMAT FINAL EXTRAGERE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  🏠 Tip:        ${extracted.propertyType}`);
    console.log(`  📍 Locație:    ${extracted.location}`);
    console.log(`  🛏️  Camere:     ${extracted.rooms}`);
    console.log(`  📐 Suprafață:  ${extracted.area} m²`);
    console.log(`  🏢 Etaj:       ${floorParsed.floor}/${floorParsed.totalFloors}`);
    console.log(`  🚽 Băi:        ${extracted.bathrooms}`);
    console.log(`  🏗️  Bloc:       ${extracted.building}`);
    console.log(`  💰 Preț:       ${extracted.price}`);
    console.log(`  🏷️  Oferta:     ${extracted.offerType} (ID: ${extracted.offerTypeId})`);
    console.log(`  📌 Titlu:      ${extracted.title}`);
    console.log(`  📞 Telefon:    ${phoneNr || 'N/A'}`);
    console.log(`  🌍 Geo:        ${geolocation ? `${geolocation.lat}, ${geolocation.lng}` : 'N/A'}`);
    console.log(`  🆔 ID:         ${formatId}`);
    console.log("");
    console.log(`  📸 Imagini RAW:     ${extracted.images.length}`);
    console.log(`  📸 Imagini unice:   ${uniqueImages.length}`);
    console.log(`  🔥 Încălzire:       ${result.heating}`);
    console.log(`  🛠️  Stare:           ${result.condition}`);
    console.log(`  📋 Serie:           ${result.serie}`);
    console.log(`  ✅ Caracteristici:  ${result.features.length} items`);
    console.log(`  🏠 Balcon:          ${result.balcony}`);
    console.log(`  🛋️  Living:           ${result.living}`);
    console.log(`  🏗️  Dezvoltator:     ${result.developer}`);
    console.log("═══════════════════════════════════════════════════════════");
    console.log("✅ [SCRAP_999] EXTRAGERE COMPLETĂ");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");

    return result;
  } catch (err) {
    console.error('❌ [scrap_999] Puppeteer scraper error:', err.message);
    console.error(err.stack);
    return null;
  }
};

module.exports = { scrap_999 };
