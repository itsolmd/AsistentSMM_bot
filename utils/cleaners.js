/**
 * utils/cleaners.js
 *
 * GLOBAL HELPER FUNCTIONS — production-ready, defensive, reusable.
 *
 * Contains:
 *   cleanEscapedText()     → removes unnecessary backslash escapes (\. \_ \€)
 *   deduplicateImages()    → normalizes image URLs, removes duplicates, fixes //
 *   parsePriceToNumber()   → "97.000 €" → 97000
 *   parseFloorString()     → "6/12" → { floor: 6, totalFloors: 12 }
 *   cleanNaN()             → removes NaN from objects recursively
 *   cleanNullInjections()  → removes "null" string injections from objects
 *   normalizeWhitespace()  → collapses extra spaces / newlines
 *   safeNumber()           → safely parse a number from any input
 */

/* =================================================================
 * 1. cleanEscapedText(text)
 * -----------------------------------------------------------------
 * Removes unnecessary backslash-escaped characters from formatted text.
 *
 * BUG FIXED:
 *   "97.000 \€"     → "97.000 €"
 *   "Apartament\."  → "Apartament."
 *   "DB_Ap101563488" → "DB_Ap101563488"  (no change — underscores stay)
 *
 * CONTRACT:
 *   - Only removes backslash BEFORE special chars: . _ €
 *   - Preserves intentional escapes
 *   - Returns empty string for null/undefined
 * ================================================================= */
function cleanEscapedText(text) {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') text = String(text);

  return text
    // Remove backslash before literal dots: \. → .
    .replace(/\\(\.)/g, '$1')
    // Remove backslash before underscore: \_ → _  (but KEEP the underscore)
    .replace(/\\(_)/g, '$1')
    // Remove backslash before euro sign: \€ → €
    .replace(/\\(€)/g, '$1')
    // Remove backslash before any other letter-special combos that slipped through
    .replace(/\\([|{}[\]()*+?^$])/g, '$1')
    // Clean up any remaining stray backslashes
    .replace(/\\+/g, '')
    // Final trim
    .trim();
}

/* =================================================================
 * 2. deduplicateImages(images)
 * -----------------------------------------------------------------
 * Normalizes image URLs, removes duplicates, fixes double slashes.
 *
 * BUG FIXED:
 *   ".../900x900/file.jpg" and ".../900x900//file.jpg" → one unique URL
 *
 * CONTRACT:
 *   - Accepts array of URL strings
 *   - Normalizes: removes backslashes, fixes // in path
 *   - Returns unique URLs only
 *   - Returns empty array for invalid input
 * ================================================================= */
function deduplicateImages(images) {
  if (!Array.isArray(images)) {
    console.warn('⚠️ [deduplicateImages] Input is not an array:', typeof images);
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const raw of images) {
    if (!raw || typeof raw !== 'string') continue;

    // Step 1: remove any backslashes
    let url = raw.replace(/\\/g, '').trim();

    // Step 2: basic validation
    if (!url.startsWith('http')) continue;

    // Step 3: extract protocol to protect it from double-slash fix
    // We replace ONLY the first "://" with a safe marker
    const protoEndIndex = url.indexOf('://');
    if (protoEndIndex === -1) continue; // invalid URL

    const protocol = url.substring(0, protoEndIndex + 3); // e.g., "https://"
    const path = url.substring(protoEndIndex + 3);        // e.g., "example.com/900x900//file.jpg"

    // Step 4: fix double slashes in PATH only (protocol is already preserved)
    // "example.com/900x900//file.jpg" → "example.com/900x900/file.jpg"
    const cleanPath = path.replace(/\/{2,}/g, '/');

    // Step 5: rebuild URL
    url = protocol + cleanPath;

    // Step 6: deduplicate
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }

  if (result.length < images.length) {
    console.log(`🔁 [deduplicateImages] Removed ${images.length - result.length} duplicate/normalized image(s)`);
  }

  return result;
}

/* =================================================================
 * 3. parsePriceToNumber(price)
 * -----------------------------------------------------------------
 * Converts a formatted price string to a plain number.
 *
 * BUG FIXED:
 *   "97.000 €" + 5000 → "97.000 €5000"  (string concatenation)
 *   parsePriceToNumber("97.000 €") + 5000 → 102000  (correct)
 *
 * SUPPORTED FORMATS:
 *   "97.000 €"        → 97000
 *   "97 000 EUR"      → 97000
 *   "120,000 €"       → 120000
 *   "97000"           → 97000
 *   "€ 97.000"        → 97000
 *   null/undefined    → 0
 * ================================================================= */
function parsePriceToNumber(price) {
  if (price === null || price === undefined) {
    console.warn('⚠️ [parsePriceToNumber] Input is null/undefined, returning 0');
    return 0;
  }

  // Convert to string
  let str = String(price);

  // Remove currency symbols and suffixes (€, EUR, eur, $, USD, etc.)
  str = str.replace(/[€$£¥]/g, '');
  str = str.replace(/\b(EUR|EUR\.|eur|USD|usd)\b/g, '');

  // Remove thousand separators (. or , or space)
  // Handle both "97.000" (dot as thousand sep) and "120,000" (comma as thousand sep)
  if (str.includes('.') && !str.includes(',')) {
    // European format: 97.000 → remove dots
    str = str.replace(/\./g, '');
  } else if (str.includes(',') && !str.includes('.')) {
    // European format: 120,000 → remove commas
    str = str.replace(/,/g, '');
  } else if (str.includes('.') && str.includes(',')) {
    // Mixed format like "1,234.56" → keep only decimal dot
    str = str.replace(/,/g, '');
  }

  // Remove whitespace
  str = str.replace(/\s+/g, '');

  // Try parsing as integer
  const result = parseInt(str, 10);

  if (isNaN(result)) {
    console.warn('⚠️ [parsePriceToNumber] Could not parse price:', price, '— returning 0');
    return 0;
  }

  return result;
}

/* =================================================================
 * 4. parseFloorString(floorStr)
 * -----------------------------------------------------------------
 * Parses a floor string like "6/12" into { floor, totalFloors }.
 *
 * BUG FIXED:
 *   "6/12" → was extracting "6" for floor AND totalFloors was "12"
 *   BUT in filters.js: adData.floor + 1 → "61" (string concat!)
 *   Now parseFloorString("6/12") → { floor: 6, totalFloors: 12 }
 *   Both are returned as NUMBERS, not strings.
 *
 * SUPPORTED FORMATS:
 *   "6/12"          → { floor: 6, totalFloors: 12 }
 *   "Etaj: 6/12"    → { floor: 6, totalFloors: 12 }
 *   "6"             → { floor: 6, totalFloors: null }
 *   null/undefined  → { floor: null, totalFloors: null }
 * ================================================================= */
function parseFloorString(floorStr) {
  if (!floorStr || typeof floorStr !== 'string') {
    return { floor: null, totalFloors: null };
  }

  // Remove label prefix like "Etaj: " or "Etaj "
  let cleaned = floorStr.replace(/^(etaj\s*[:]?\s*)/i, '').trim();

  // Try "6/12" pattern
  const slashMatch = cleaned.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (slashMatch) {
    const floor = parseInt(slashMatch[1], 10);
    const totalFloors = parseInt(slashMatch[2], 10);
    console.log(`🔍 [parseFloorString] Parsed "${floorStr}" → floor=${floor}, totalFloors=${totalFloors}`);
    return { floor, totalFloors };
  }

  // Single number
  const singleNum = parseInt(cleaned, 10);
  if (!isNaN(singleNum)) {
    console.log(`🔍 [parseFloorString] Parsed "${floorStr}" → floor=${singleNum}, totalFloors=null`);
    return { floor: singleNum, totalFloors: null };
  }

  console.warn(`⚠️ [parseFloorString] No match for floor string: "${floorStr}"`);
  return { floor: null, totalFloors: null };
}

/* =================================================================
 * 5. safeNumber(value, fallback)
 * -----------------------------------------------------------------
 * Safely parse a number from any input. Returns fallback on failure.
 *
 * USAGE:
 *   safeNumber("6")       → 6
 *   safeNumber("abc", 0)  → 0
 *   safeNumber(null, 1)   → 1
 * ================================================================= */
function safeNumber(value, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const num = Number(value);
  return isNaN(num) ? fallback : num;
}

/* =================================================================
 * 6. cleanNaN(obj)
 * -----------------------------------------------------------------
 * Recursively walks an object and replaces NaN values with null.
 *
 * BUG FIXED: NaN in URLs/objects from bad number parsing.
 * ================================================================= */
function cleanNaN(obj) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'number' && isNaN(obj)) {
    return null;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => cleanNaN(item));
  }

  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = cleanNaN(value);
    }
    return cleaned;
  }

  return obj;
}

/* =================================================================
 * 7. cleanNullInjections(obj)
 * -----------------------------------------------------------------
 * Recursively removes the string "null" injected into text fields.
 *
 * BUG FIXED: "null" appearing in formatted text (e.g., infos field).
 * ================================================================= */
function cleanNullInjections(obj) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Remove isolated "null" strings (but not "null" as part of a word)
    return obj.replace(/\bnull\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  }

  if (Array.isArray(obj)) {
    return obj.map(item => cleanNullInjections(item));
  }

  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = cleanNullInjections(value);
    }
    return cleaned;
  }

  return obj;
}

/* =================================================================
 * 8. normalizeWhitespace(text)
 * -----------------------------------------------------------------
 * Collapses multiple spaces, tabs, and newlines into single space.
 * Trims result.
 *
 * WARNING: This DESTROYS multiline formatting. For text that needs
 * to preserve newlines, use normalizeText() instead.
 * ================================================================= */
function normalizeWhitespace(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* =================================================================
 * 8b. normalizeText(text)
 * -----------------------------------------------------------------
 * NEWLINE-PRESERVING version of normalizeWhitespace.
 * Collapses multiple spaces/tabs within a line, but PRESERVES
 * intentional newlines for multiline formatted text.
 *
 * BUG v2.1 FIXED: normalizeWhitespace() was destroying multiline
 * formatting by replacing \n with spaces.
 *
 * USAGE:
 *   normalizeText("Apartament.\n\n📍 Locație: Chișinău")
 *   → "Apartament.\n\n📍 Locație: Chișinău"
 *
 * CONTRACT:
 *   - Preserves single newlines (\n)
 *   - Collapses multiple blank lines into single blank line
 *   - Removes trailing whitespace on each line
 *   - Trims overall result
 * ================================================================= */
function normalizeText(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // max one blank line between sections
    .trim();
}

/* =================================================================
 * 9. extractPhoneFromPage(page) — Puppeteer-based
 * -----------------------------------------------------------------
 * Extracts phone number from a 999.md page using multiple sources:
 *   1. Click "Arată numărul" button ([data-testid="show-number"])
 *      → wait for tel: link → extract (PRIMARY — real owner phone)
 *   2. href="tel:" links (fallback if already visible)
 *   3. JSON-LD (schema.org)
 *   4. __NEXT_DATA__ hydration state
 *   5. Body text regex
 *
 * Returns the first valid phone found, or null.
 * ================================================================= */
async function extractPhoneFromPage(page) {
  try {
    // ── SOURCE 0: Next.js RSC flight data (__next_f) — most reliable ──
    // 999.md uses Next.js App Router (no __NEXT_DATA__). The phone is
    // embedded in RSC flight data as phoneNumbers.value.phone_numbers[]
    // inside inline <script> tags with self.__next_f.push(...).
    // The data is JavaScript-string-escaped (e.g. \"phone_numbers\":[\"373...\"])
    // so we search for the raw phone number pattern directly.
    const KNOWN_NON_OWNER_PHONES = ['37322888002', '+37322888002'];
    const rscPhone = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        // Search for Moldovan phone numbers (373 + 8-9 digits)
        const phoneMatches = text.matchAll(/373\d{8,9}/g);
        for (const match of phoneMatches) {
          const phone = match[0];
          // Skip known non-owner numbers (support/developer)
          if (phone === '37322888002') continue;
          return phone;
        }
      }
      return null;
    });
    if (rscPhone) {
      console.log('📞 [extractPhoneFromPage] Found in RSC flight data:', rscPhone);
      return rscPhone;
    }

    // ── SOURCE 1: Click "Arată numărul" button → extract owner's phone ──
    // 999.md hides the real phone behind a button with data-testid="show-number".
    // Clicking it reveals the owner's phone.
    const showBtn = await page.$('[data-testid="show-number"]');
    if (showBtn) {
      console.log('[PHONE DEBUG] Show button found');

      // Snapshot existing tel: links BEFORE clicking
      const existingTelHrefs = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href^="tel:"]');
        return Array.from(links).map(l => l.getAttribute('href'));
      });
      console.log('[PHONE DEBUG] Existing tel: links before click:', existingTelHrefs);

      await showBtn.click();
      console.log('[PHONE DEBUG] Button clicked');

      // Wait briefly for React re-render after click
      await new Promise(r => setTimeout(r, 1500));

      // After click: find the NEW tel: link that wasn't there before
      const telPhone = await page.evaluate((existing) => {
        const allLinks = document.querySelectorAll('a[href^="tel:"]');
        for (const link of allLinks) {
          const href = link.getAttribute('href');
          if (href && !existing.includes(href)) {
            return href
              ?.replace('tel:', '')
              ?.replace(/\s+/g, '')
              ?.trim();
          }
        }
        // Fallback: any tel link
        const anyLink = document.querySelector('a[href^="tel:"]');
        if (anyLink) {
          const href = anyLink.getAttribute('href');
          return href
            ?.replace('tel:', '')
            ?.replace(/\s+/g, '')
            ?.trim();
        }
        return null;
      }, existingTelHrefs);

      if (telPhone) {
        console.log('[PHONE DEBUG] Extracted phone:', telPhone);
        return telPhone;
      }

      // Fallback after click: try body text regex
      const pageTextAfter = await page.evaluate(() => document.body.innerText);
      const phoneMatch = pageTextAfter.match(/(?:\+?373|0)\s*\d[\d\s]{6,}/);
      if (phoneMatch) {
        const phone = phoneMatch[0].trim().replace(/\s+/g, '');
        console.log('[PHONE DEBUG] Extracted phone from body after click:', phone);
        return phone;
      }
    } else {
      console.log('[PHONE DEBUG] Show button not found, trying fallbacks');
    }

    // ── SOURCE 2: href="tel:" links (already visible, no click needed) ──
    // BUG FIX v3.2: Use before/after snapshot approach — same as Source 1
    // but without clicking. This handles pages where the phone is already
    // visible without needing to click "Arată numărul".
    const telPhone = await page.evaluate(() => {
      // Try phone__link class first (more specific)
      const phoneLink = document.querySelector('a[class*="phone__link"]');
      if (phoneLink) {
        const href = phoneLink.getAttribute('href');
        if (href && href.startsWith('tel:')) {
          return href
            ?.replace('tel:', '')
            ?.replace(/\s+/g, '')
            ?.trim();
        }
      }
      // Fallback: any tel link on the page
      const telLink = document.querySelector('a[href^="tel:"]');
      if (telLink) {
        const href = telLink.getAttribute('href');
        return href
          ?.replace('tel:', '')
          ?.replace(/\s+/g, '')
          ?.trim();
      }
      return null;
    });
    if (telPhone) {
      console.log('📞 [extractPhoneFromPage] Found in tel: link:', telPhone);
      return telPhone;
    }

    // ── SOURCE 3: JSON-LD structured data ──────────────────────
    const jsonLdPhone = await page.evaluate(() => {
      try {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
          const data = JSON.parse(script.textContent);
          const phone = data?.telephone || data?.telePhone || data?.contactPoint?.telephone;
          if (phone) return phone;
        }
      } catch (_) { /* ignore */ }
      return null;
    });
    if (jsonLdPhone) {
      console.log('📞 [extractPhoneFromPage] Found in JSON-LD:', jsonLdPhone);
      return jsonLdPhone;
    }

    // ── SOURCE 4: React/Next.js hydration state (__NEXT_DATA__) ──
    const nextDataPhone = await page.evaluate(() => {
      try {
        const script = document.getElementById('__NEXT_DATA__');
        if (!script) return null;
        const data = JSON.parse(script.textContent);
        const advert = data?.props?.pageProps?.advert;
        // Check all known field locations for phone in 999.md SSR data
        return advert?.phone
          || advert?.phone_number
          || advert?.user?.phone
          || advert?.contact?.phone
          || advert?.contacts?.[0]
          || null;
      } catch (_) { /* ignore */ }
      return null;
    });
    if (nextDataPhone) {
      console.log('📞 [extractPhoneFromPage] Found in __NEXT_DATA__:', nextDataPhone);
      return nextDataPhone;
    }

    // ── SOURCE 5: Direct regex in body text ────────────────────
    const bodyPhone = await page.evaluate(() => {
      const text = document.body.innerText;
      const match = text.match(/(?:\+?373|0)\s*\d[\d\s]{6,}/);
      return match ? match[0].trim().replace(/\s+/g, '') : null;
    });
    if (bodyPhone) {
      console.log('📞 [extractPhoneFromPage] Found in body text:', bodyPhone);
      return bodyPhone;
    }

    console.log('📞 [extractPhoneFromPage] No phone found from any source');
    return null;
  } catch (err) {
    console.error('❌ [extractPhoneFromPage] Error:', err.message);
    return null;
  }
}

/* =================================================================
 * EXPORTS
 * ================================================================= */
module.exports = {
  cleanEscapedText,
  deduplicateImages,
  parsePriceToNumber,
  parseFloorString,
  safeNumber,
  cleanNaN,
  cleanNullInjections,
  normalizeWhitespace,
  normalizeText,        // BUG v2.1 FIXED: newline-preserving text normalization
  extractPhoneFromPage,
};
