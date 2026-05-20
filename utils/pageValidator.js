/**
 * ════════════════════════════════════════════════════════════════
 * utils/pageValidator.js — Anti-Hallucination Page Validation
 * ════════════════════════════════════════════════════════════════
 *
 * REGULĂ OBLIGATORIE:
 * ÎNAINTE de a trimite ORICE către AI pentru extracție sau
 * de a extrage date, TREBUIE să verifici dacă pagina este validă.
 *
 * Flow:
 *   1. isPageValid(html, url) — Verifică dacă pagina e un anunț real
 *   2. Dacă invalid → return { valid: false, reason: '...' }
 *   3. Oprește complet procesarea → trimite notificare Telegram
 *
 * PAGINILE ȘTERSE/BLOCATE/404 returnează conținut care nu conține
 * elementele specifice unui anunț valid (preț, suprafață, camere, etc.)
 *
 * IMPORTANT: Prioritatea verificării este:
 *   PRIORITATE 1: Conținut REAL al anunțului (preț, suprafață, camere)
 *   PRIORITATE 2: Structură specifică de anunț (article, adPage)
 *   PRIORITATE 3: Dopar DUPĂ cele de mai sus, verificăm mesaje de eroare
 *     (și doar în body, NICIODATĂ în scripturi sau head)
 * ════════════════════════════════════════════════════════════════ */

// ================================================================
// VALIDATION RULES — Anti-Hallucination Configuration
// ================================================================
const VALIDATION_RULES = {
  // Prioritatea 1: Conținut real > orice altceva
  prioritizeRealContent: true,

  // Prioritatea 2: Nu bloca pe baza unor string-uri parțiale în scripturi
  ignoreScriptErrors: true,

  // Prioritatea 3: Dacă există preț SAU suprafață SAU camere → pagină validă
  hasAnyRealData: [
    'price', 'Preț', 'Preţ', 'Pret', 'Suprafață', 'Suprafata',
    'camere', 'm²', 'm2', 'Vând', 'Vind', 'Proprietar',
    'Etaj', 'euro', '€', 'lei', 'MDL',
  ],

  // Prioritatea 4: Timeout și retry dacă pagina nu se încarcă complet
  retryOnIncomplete: true,
  maxRetries: 2,
  retryDelay: 2000,
};

// ================================================================
// INDICATORI FORȚI DE CONȚINUT REAL (anunț activ cu date)
// ================================================================
// Acești indicatori sunt EXCLUSIVI paginilor de anunț valid.
// Dacă ORICARE dintre ei este prezent, pagina este VALIDĂ,
// indiferent de orice alt semnal (inclusiv mesaje de eroare).
// ================================================================
const STRONG_CONTENT_INDICATORS = [
  // Caracteristici specifice anunțurilor imobiliare (NU apar în navigation/footer)
  'Suprafață totală',
  'Suprafata totala',
  'Număr de camere',
  'Numar de camere',
  'Tip încălzire',
  'Tip incalzire',
  'Starea apartamentului',
  'Grup sanitar',
  'Fond locativ',

  // Structură specifică 999.md pentru anunțuri valide
  'styles_group__feature__GsOUi',
  'styles_price__value__',
  'styles_phone__',
  'advert-currency-rates',
];

// ================================================================
// INDICATORI SLABI DE CONȚINUT REAL (necesită combinații)
// ================================================================
// Acești indicatori POT apărea și pe pagini de eroare (navigation,
// footer, meta). Pentru a declanșa validarea, e nevoie de CEL
// PUȚIN DOI dintre ei simultan.
// ================================================================
const WEAK_CONTENT_INDICATORS = [
  'Preț',
  'Preţ',
  'Vând',
  'Vind',
  'Proprietar',
  'Agent imobiliar',
  'Etaj',
  'price',
  'euro',
  '€',
  'lei',
  'MDL',
  'Apartament',
  'Casă',
  'Casă',
];

// ================================================================
// INDICATORI DE STRUCTURĂ ANUNȚ (pagină de anunț, nu listare)
// ================================================================
const AD_STRUCTURE_INDICATORS = [
  '<article',
  'adPage',
  'board__advert',
  'product__info',
  'listing__details',
  'advert-currency-rates',
  'advert__',
];

// ================================================================
// SEMNALE DE PAGINĂ INVALIDĂ (ștearsă/blocată/404)
// ================================================================
// Aceste string-uri indică faptul că anunțul nu mai există.
// SUNT VERIFICATE DOAR ÎN BODY (după eliminarea scripturilor și head-ului).
// ================================================================
const INVALID_PAGE_SIGNALS = [
  // Română
  'Anunțul nu a fost găsit',
  'Anunțul nu a fost gasit',
  'Anunțul a fost șters',
  'Anunțul a fost sters',
  'Anunțul a fost blocat',
  'Anunțul nu mai există',
  'Anunțul nu mai exista',
  'Pagina nu a fost găsită',
  'Pagina nu a fost gasita',
  'Anunț indisponibil',
  'Anunt indisponibil',
  'Anunțul este indisponibil',
  'Anuntul este indisponibil',
  'a fost eliminat',
  'a fost eliminata',
  'acest anunț nu există',
  'acest anunt nu exista',

  // Engleză
  'Page not found',
  '404 Not Found',
  'This page does not exist',
  'This page was deleted',
  'Listing not found',
  'Ad not found',
  'This listing is no longer available',
  'The page you requested was not found',

  // Rusă
  'Объявление не найдено',
  'Объявление было удалено',
  'Объявление удалено',
  'Страница не найдена',
  'не существует',
  'было удалено',
];

// ================================================================
// CONFIDENCE THRESHOLDS
// ================================================================
const CONFIDENCE = {
  HIGH: 1.0,    // Extras din selector CSS exact / __NEXT_DATA__
  MEDIUM: 0.7,  // Extras din regex direct pe text
  LOW: 0.4,     // Inferat de AI din context
  ZERO: 0.0,    // Halucinație — completat de AI fără bază
};

// ================================================================
// HELPER: Extrage conținutul BODY eliminând scripturile și head-ul
// ================================================================
function extractBodyContent(html) {
  if (!html) return '';

  // Elimină conținutul tag-urilor <script> ... </script>
  let cleanHtml = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');

  // Elimină conținutul tag-urilor <style> ... </style>
  cleanHtml = cleanHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');

  // Elimină conținutul tag-urilor <head> ... </head>
  cleanHtml = cleanHtml.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, ' ');

  // Elimină tag-urile <noscript> ... </noscript>
  cleanHtml = cleanHtml.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');

  // Elimină comentariile HTML <!-- ... -->
  cleanHtml = cleanHtml.replace(/<!--[\s\S]*?-->/g, ' ');

  // Elimină JSON-LD (<script type="application/ld+json">...)
  cleanHtml = cleanHtml.replace(/<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, ' ');

  // Decodează entitățile HTML comune pentru a putea face matching corect
  cleanHtml = cleanHtml.replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');

  return cleanHtml;
}

/**
 * isPageValid — Verifică dacă pagina conține un anunț valid
 *
 * PRIORITATEA VERIFICĂRII:
 *   1. Conținut REAL al anunțului (preț, suprafață, camere) → VALID
 *   2. Structură de anunț (article, adPage, etc.) → VALID
 *   3. Doar dacă NU există conținut real, verificăm mesaje de eroare
 *      (și doar în body, fără scripturi)
 *   4. Fallback: pagină suspectă, dar nu confirmat ștearsă
 *
 * @param {string} html - HTML-ul complet al paginii
 * @param {Object} options - Opțiuni
 * @param {string} options.title - Titlul paginii (opțional)
 * @param {string} options.url - URL-ul paginii
 * @returns {{ valid: boolean, reason: string, confidence: number }}
 */
function isPageValid(html, options = {}) {
  const { title = '', url = '' } = options;

  // ── 0. Verifică dacă HTML-ul este valid ──────────────────
  if (!html || html.length < 100) {
    return {
      valid: false,
      reason: 'HTML INVALID — conținut prea scurt (posibil pagină neîncărcată)',
      confidence: CONFIDENCE.LOW,
    };
  }

  // ════════════════════════════════════════════════════════════
  // PRIORITATE 1: Verifică existența DATELOR REALE ale anunțului
  // ════════════════════════════════════════════════════════════
  // Folosim două niveluri de indicatori:
  //   - FORȚI (STRONG): Exclusivi paginilor de anunț (ex: "Suprafață totală")
  //   - SLABI (WEAK): Pot apărea și în navigation/footer (ex: "Preț")
  //
  // Dacă găsim ORICE indicator FORT → pagina e VALIDĂ.
  // Dacă găsim CEL PUȚIN DOI indicatori SLABI → pagina e probabil VALIDĂ.
  // ════════════════════════════════════════════════════════════

  const hasStrongIndicator = STRONG_CONTENT_INDICATORS.some(indicator =>
    html.includes(indicator)
  );

  // Numără câți indicatori SLABI sunt prezenți
  let weakIndicatorCount = 0;
  for (const indicator of WEAK_CONTENT_INDICATORS) {
    if (html.includes(indicator)) weakIndicatorCount++;
  }

  // Verifică prezența prețului cu valută (€, EUR, lei, MDL)
  const hasPriceWithCurrency = /\d[\d\s]*(?:€|EUR|eur|lei|MDL)/.test(html);
  if (hasPriceWithCurrency) weakIndicatorCount++;

  // Verifică prezența unității m² (suprafață)
  const hasAreaUnit = /\d+\s*m²/.test(html) || /\d+\s*m2/.test(html);
  if (hasAreaUnit) weakIndicatorCount++;

  // Verifică prezența unui format de etaj (ex: 13/15, etaj 13)
  const hasFloorFormat = /\d+\s*\/\s*\d+/.test(html) ||
    /etaj\s*\d+/i.test(html);
  if (hasFloorFormat) weakIndicatorCount++;

  // Verifică prezența __NEXT_DATA__
  const hasNextData = html.includes('__NEXT_DATA__');

  // Dacă există un indicator FORT → VALID sigure
  if (hasStrongIndicator || (hasPriceWithCurrency && hasAreaUnit)) {
    return {
      valid: true,
      reason: 'Conținut anunț detectat — pagină activă',
      confidence: hasNextData ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
      details: {
        hasStrongIndicator,
        weakIndicatorCount,
        hasPriceWithCurrency,
        hasAreaUnit,
        hasFloorFormat,
        hasNextData,
      },
    };
  }

  // Dacă avem cel puțin 2 indicatori SLABI + prezența NextData → probabil VALID
  if (weakIndicatorCount >= 2 && hasNextData) {
    return {
      valid: true,
      reason: 'Conținut anunț detectat (indicatori multipli) — pagină activă',
      confidence: CONFIDENCE.MEDIUM,
      details: {
        hasStrongIndicator,
        weakIndicatorCount,
        hasPriceWithCurrency,
        hasAreaUnit,
        hasFloorFormat,
        hasNextData,
      },
    };
  }

  // Salvăm starea pentru fallback
  const validationState = {
    hasStrongIndicator,
    weakIndicatorCount,
    hasPriceWithCurrency,
    hasAreaUnit,
    hasFloorFormat,
    hasNextData,
  };

  // ════════════════════════════════════════════════════════════
  // PRIORITATE 2 (IMEDIATĂ): Verifică mesajele de eroare
  // în BODY (fără scripturi) — doar dacă nu avem conținut FORT
  // ════════════════════════════════════════════════════════════
  // De ce ACUM? Pentru că:
  //   - Paginile șterse au "Anunțul nu a fost găsit" în body
  //   - Dar pot avea și cuvinte generice ca "Preț" în navigation
  //   - Deci verificăm eroarea ACUM, înainte de structură/indicatori slabi
  // ════════════════════════════════════════════════════════════

  const bodyContent = extractBodyContent(html);
  const bodyLower = bodyContent.toLowerCase();

  for (const signal of INVALID_PAGE_SIGNALS) {
    if (bodyLower.includes(signal.toLowerCase())) {
      return {
        valid: false,
        reason: `ANUNȘUL NU EXISTĂ (șters/blocat/404) — semnal detectat: "${signal}"`,
        confidence: CONFIDENCE.HIGH,
        signal,
      };
    }
  }

  // ════════════════════════════════════════════════════════════
  // PRIORITATE 3: Verifică structura specifică de anunț
  // ════════════════════════════════════════════════════════════
  // Chiar dacă nu am găsit date specifice, poate exista o
  // structură HTML care indică o pagină de anunț valid.
  // ACEASTA VERIFICARE ARE LOC DUPĂ CE AM EXCLUS MESAJELE DE EROARE.
  // ════════════════════════════════════════════════════════════

  const hasAdStructure = AD_STRUCTURE_INDICATORS.some(indicator =>
    html.includes(indicator)
  );

  // Combinația structură + indicatori slabi e mai sigură
  if (hasAdStructure && validationState.weakIndicatorCount >= 2) {
    return {
      valid: true,
      reason: 'Structură anunț + indicatori multipli detectați — pagină activă',
      confidence: CONFIDENCE.MEDIUM,
      details: { hasAdStructure, weakIndicatorCount: validationState.weakIndicatorCount },
    };
  }

  // ════════════════════════════════════════════════════════════
  // PRIORITATE 4: Verifică URL-ul (pattern de anunț: /ro/123456789)
  // ════════════════════════════════════════════════════════════

  const urlMatch = url.match(/\/(\d{6,})\/?$/);
  if (!urlMatch) {
    return {
      valid: false,
      reason: 'URL INVALID — nu conține ID numeric de anunț',
      confidence: CONFIDENCE.LOW,
    };
  }

  // ════════════════════════════════════════════════════════════
  // PRIORITATE 5: Verifică dacă titlul indică pagină de eroare
  // ════════════════════════════════════════════════════════════

  if (title) {
    const titleLower = title.toLowerCase();
    const errorTitleSignals = [
      'panou de anunțuri',
      'panou de anunturi',
      'pagina nu a fost găsită',
      'pagina nu a fost gasita',
      'error 404',
      '404 not found',
    ];

    for (const signal of errorTitleSignals) {
      if (titleLower.includes(signal)) {
        return {
          valid: false,
          reason: `ANUNȘUL NU EXISTĂ — titlu indică pagină de eroare: "${title}"`,
          confidence: CONFIDENCE.MEDIUM,
          signal,
        };
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // FALLBACK: Pagină suspectă, dar nu confirmat ștearsă
  // ════════════════════════════════════════════════════════════
  // Nu am găsit nici conținut real, nici structură de anunț,
  // dar nici mesaje de eroare. Posibil pagină incomplet încărcată.
  // Returnăm valid: false cu încredere scăzută și cerem reîncercare.
  // ════════════════════════════════════════════════════════════

  return {
    valid: false,
    reason: 'Pagină invalidă — fără date anunț detectate și fără mesaje de eroare explicite',
    confidence: CONFIDENCE.LOW,
    requiresReview: true,
    details: {
      htmlLength: html.length,
      bodyLength: bodyContent.length,
      hasStrongIndicator: validationState.hasStrongIndicator,
      weakIndicatorCount: validationState.weakIndicatorCount,
      hasPriceWithCurrency: validationState.hasPriceWithCurrency,
      hasAreaUnit: validationState.hasAreaUnit,
      hasFloorFormat: validationState.hasFloorFormat,
      hasAdStructure,
      hasNextData: validationState.hasNextData,
    },
  };
}

/**
 * validatePageWithBrowser — Verifică pagina direct în browser
 * Folosește Puppeteer pentru a verifica elemente DOM specifice
 *
 * @param {Object} page - Pagina Puppeteer
 * @param {string} url - URL-ul paginii
 * @returns {Promise<{ valid: boolean, reason: string }>}
 */
async function validatePageWithBrowser(page, url) {
  try {
    const result = await page.evaluate(() => {
      // ── 1. Verifică titlul paginii ────────────────────────
      const pageTitle = document.title || '';

      // ── 2. Verifică body text ─────────────────────────────
      const bodyText = document.body?.innerText || '';

      // ── 3. Verifică prezența __NEXT_DATA__ ────────────────
      const hasNextData = !!document.getElementById('__NEXT_DATA__');

      // ── 4. Verifică prezența prețului (selector oficial) ──
      const hasPriceContainer = !!document.querySelector('[data-onboarding="advert-currency-rates"]');

      // ── 5. Verifică prezența caracteristicilor anunțului ──
      const featureElements = document.querySelectorAll('[class*="feature"]');
      const hasFeatures = featureElements.length > 0;

      // ── 6. Verifică prezența galeriei de imagini ──────────
      const gallerySelectors = [
        '[class*="gallery"]',
        '[class*="slider"]',
        '[class*="carousel"]',
        '.swiper',
      ];
      const hasGallery = gallerySelectors.some(sel => document.querySelector(sel));

      // ── 7. Verifică semnale de eroare în textul vizibil ───
      const errorSignals = [
        'Anunțul nu a fost găsit',
        'Anunțul a fost șters',
        'Anunțul nu mai există',
        'nu există',
      ];
      const foundErrorSignal = errorSignals.find(signal =>
        bodyText.toLowerCase().includes(signal.toLowerCase())
      );

      return {
        pageTitle,
        hasNextData,
        hasPriceContainer,
        hasFeatures,
        hasGallery,
        foundErrorSignal,
        bodyTextLength: bodyText.length,
      };
    });

    // ── Analizează rezultatele ─────────────────────────────

    // PRIORITATE 1: Dacă există caracteristici sau preț → VALID
    if (result.hasPriceContainer || result.hasFeatures) {
      return { valid: true, reason: 'OK — conținut anunț detectat' };
    }

    // PRIORITATE 2: Dacă există galerie și NextData → VALID
    if (result.hasNextData && result.hasGallery) {
      return { valid: true, reason: 'OK — structură anunț detectată' };
    }

    // PRIORITATE 3: Verifică mesaje de eroare doar în textul vizibil
    if (result.foundErrorSignal && !result.hasPriceContainer) {
      return {
        valid: false,
        reason: `ANUNȘUL NU EXISTĂ — detectat: "${result.foundErrorSignal}"`,
      };
    }

    // Dacă nu are NICIU indicator de anunț valid, e probabil o pagină de eroare
    if (!result.hasNextData && !result.hasPriceContainer && result.bodyTextLength < 500) {
      return {
        valid: false,
        reason: 'PAGINĂ INVALIDĂ — conținut insuficient (posibil ștearsă/blocată)',
      };
    }

    return { valid: true, reason: 'OK' };
  } catch (err) {
    console.error('[pageValidator] ❌ Browser validation error:', err.message);
    return { valid: false, reason: `EROARE VALIDARE: ${err.message}` };
  }
}

/**
 * validateExtractedData — Verifică integritatea datelor extrase
 * și calculează un scor de încredere
 *
 * @param {Object} data - Datele extrase
 * @param {string} html - HTML-ul original
 * @returns {{ valid: boolean, confidence: number, warnings: string[] }}
 */
function validateExtractedData(data, html = '') {
  const warnings = [];
  let totalScore = 0;
  let checks = 0;

  // ── Verifică câmpurile critice ──────────────────────────
  const criticalFields = [
    { name: 'price', required: true, weight: 0.3 },
    { name: 'rooms', required: true, weight: 0.2 },
    { name: 'area', required: true, weight: 0.2 },
    { name: 'floor', required: false, weight: 0.1 },
    { name: 'floors', required: false, weight: 0.1 },
    { name: 'description', required: false, weight: 0.05 },
    { name: 'title', required: false, weight: 0.05 },
  ];

  for (const field of criticalFields) {
    const value = data[field];
    const isPresent = value != null && value !== 'N/A' && value !== '' && value !== false;

    if (field.required && !isPresent) {
      warnings.push(`Câmp obligatoriu lipsă: ${field.name}`);
    }

    if (isPresent) {
      totalScore += field.weight;
    }
    checks++;
  }

  // ── Verifică consistența datelor ─────────────────────────
  if (data.floor && data.floors) {
    const floorNum = parseInt(data.floor, 10);
    const floorsNum = parseInt(data.floors, 10);
    if (!isNaN(floorNum) && !isNaN(floorsNum) && floorNum > floorsNum) {
      warnings.push(`Etaj (${floorNum}) > Număr total etaje (${floorsNum}) — date inconsistente`);
      totalScore -= 0.2;
    }
  }

  if (data.rooms && parseInt(data.rooms, 10) > 20) {
    warnings.push(`Număr suspect de camere: ${data.rooms}`);
    totalScore -= 0.15;
  }

  if (data.area && parseInt(data.area, 10) > 10000) {
    warnings.push(`Suprafață suspectă: ${data.area} m²`);
    totalScore -= 0.15;
  }

  // ── Calculează scorul final ──────────────────────────────
  const confidence = Math.max(0, Math.min(1, totalScore));

  return {
    valid: confidence >= 0.3, // Minim 30% încredere pentru a continua
    confidence,
    warnings,
  };
}

module.exports = {
  isPageValid,
  validatePageWithBrowser,
  validateExtractedData,
  extractBodyContent,
  CONFIDENCE,
  INVALID_PAGE_SIGNALS,
  VALIDATION_RULES,
};
