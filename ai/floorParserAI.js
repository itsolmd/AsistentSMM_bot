/**
 * ════════════════════════════════════════════════════════════════
 * ai/floorParserAI.js — AI-Enhanced Floor Extraction (3-Stage)
 * ════════════════════════════════════════════════════════════════
 *
 * Sistem inteligent în 3 etape pentru extragerea etajului:
 *
 * STAGE 1 - Static DOM Selectors:
 *   Caută selectori CSS exacti pentru 'Etaj' și 'Număr de etaje'
 *   în HTML-ul paginii. Folosește regex pe HTML brut pentru a
 *   găsi pattern-ul: <span>Etaj</span> ... <a>13</a>
 *
 * STAGE 2 - AI Analysis:
 *   Trimite HTML-ul complet (sau fragmentul relevant) către
 *   OpenRouter și cere AI-ului să extragă etajul din context.
 *   Funcționează chiar dacă CSS classes s-au schimbat.
 *
 * STAGE 3 - AI Inference:
 *   Dacă nici STAGE 2 nu găsește, AI-ul deduce etajul din
 *   contextul anunțului (descriere, titlu, alte câmpuri).
 *   De exemplu: "Apartament la etajul 5" sau "ultimul etaj".
 *
 * REGULA #1: Nu rata NICIODATĂ etajul
 *   Dacă toate etapele eșuează, returnează { floor: null, floors: null }
 *   și marchează pentru revizuire manuală (NU aruncă eroare).
 * ════════════════════════════════════════════════════════════════ */

const { askAI, extractJsonFromAI } = require('./openRouterClient');
const logger = require('../logger');

// ── STAGE 1: Regex patterns pentru extracție directă din HTML ──
// Aceste pattern-uri funcționează pe HTML BRUT (nu DOM) și sunt
// rezistente la schimbări de CSS classes.

/**
 * STAGE 1A: Extrage etajul din HTML brut folosind regex flexibil
 *
 * Caută pattern-ul:
 *   <span class="...">Etaj</span>
 *   <a href="...">NUMĂR</a>
 *
 * @param {string} html - HTML brut al paginii
 * @returns {{ floor: number|null, floors: number|null }}
 */
function extractFloorStage1(html) {
  if (!html) return { floor: null, floors: null };

  let floor = null;
  let floors = null;

  // ── Pattern pentru etajul curent ──
  // <span class="styles_group__key__SXHV5">Etaj</span>
  // <a href="/ro/list/...?exo_248=958">13</a>
  const floorPatterns = [
    // Pattern 1: span cu text "Etaj" urmat de a cu numărul
    /<span[^>]*>Etaj<\/span>\s*<a[^>]*>(\d+)<\/a>/i,
    // Pattern 2: label "Etaj" urmat de orice și un număr
    /Etaj[:\s]*(\d+)/i,
    // Pattern 3: "etajul" urmat de număr
    /etajul\s*(\d+)/i,
    // Pattern 4: "et. " urmat de număr
    /\bet[.]?\s*(\d+)/i,
    // Pattern 5: JSON-LD conținând numărul etajului
    /"floorNumber"\s*:\s*(\d+)/i,
  ];

  for (const pattern of floorPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num >= 0 && num <= 200) {
        floor = num;
        console.log(`[floorParserAI:Stage1] ✅ Floor found via regex: ${floor}`);
        break;
      }
    }
  }

  // ── Pattern pentru numărul total de etaje ──
  const floorsPatterns = [
    // Pattern 1: span cu text "Număr de etaje" urmat de a cu numărul
    /<span[^>]*>Număr de etaje<\/span>\s*<a[^>]*>(\d+)<\/a>/i,
    /<span[^>]*>Număr de etaje<\/span>\s*<a[^>]*>(\d+)<\/a>/i,
    // Pattern 2: label "Număr de etaje" urmat de număr
    /Număr de etaje[:\s]*(\d+)/i,
    // Pattern 3: "etaje" urmat de număr
    /(\d+)\s*(?:de\s*)?etaje/i,
    // Pattern 4: JSON-LD
    /"numberOfFloors"\s*:\s*(\d+)/i,
    // Pattern 5: "total floors" sau "floors"
    /"floors"\s*:\s*(\d+)/i,
  ];

  for (const pattern of floorsPatterns) {
    const match = html.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num >= 1 && num <= 200) {
        floors = num;
        console.log(`[floorParserAI:Stage1] ✅ Total floors found via regex: ${floors}`);
        break;
      }
    }
  }

  // ── Pattern combinat: "3/12" (etaj/etaje totale) ──
  if (!floor || !floors) {
    const combinedPatterns = [
      /Etaj\s*(\d+)\s*\/\s*(\d+)/i,
      /etajul\s*(\d+)\s*(?:din|al)\s*(\d+)/i,
      /(\d+)\s*\/\s*(\d+)\s*etaj/i,
      /"floor"\s*:\s*"(\d+)\/(\d+)"/i,
    ];
    for (const pattern of combinedPatterns) {
      const match = html.match(pattern);
      if (match) {
        const f = parseInt(match[1], 10);
        const t = parseInt(match[2], 10);
        if (!isNaN(f) && !isNaN(t) && f >= 0 && f <= 200 && t >= 1 && t <= 200) {
          floor = f;
          floors = t;
          console.log(`[floorParserAI:Stage1] ✅ Combined floor: ${floor}/${floors}`);
          break;
        }
      }
    }
  }

  return { floor, floors };
}

/**
 * STAGE 2: Folosește AI pentru a extrage etajul din HTML
 *
 * Trimite un fragment relevant din HTML către OpenRouter și
 * cere AI-ului să identifice etajul. AI-ul poate înțelege
 * structura paginii chiar dacă CSS classes s-au schimbat.
 *
 * @param {string} htmlSnippet - Fragment HTML relevant (ex: secțiunea de caracteristici)
 * @returns {Promise<{ floor: number|null, floors: number|null }>}
 */
async function extractFloorStage2(htmlSnippet) {
  if (!htmlSnippet || htmlSnippet.length < 50) return { floor: null, floors: null };

  try {
    const systemPrompt = `Ești un expert în web scraping imobiliar.
Sarcina ta: Extrage NUMĂRUL ETAJULUI și NUMĂRUL TOTAL DE ETAJE din fragmentul HTML de mai jos.

Reguli:
1. Caută 'Etaj' sau 'Floor' în text → valoarea numerică după el
2. Caută 'Număr de etaje' sau 'Total floors' → valoarea numerică
3. Dacă vezi format "X/Y" → X=etaj curent, Y=total etaje
4. Dacă nu găsești, caută în JSON-LD sau în atribute data-*
5. Verifică și textul alternativ din alt="" sau title=""

Răspunde DOAR cu JSON:
{ "floor": number|null, "floors": number|null, "confidence": "high"|"medium"|"low" }`;

    const userPrompt = `Fragment HTML:
\`\`\`html
${htmlSnippet.substring(0, 8000)}
\`\`\`

Extrage etajul (floor) și numărul total de etaje (floors).`;

    const result = await askAI(systemPrompt, userPrompt, {
      expectJson: true,
      temperature: 0.05,
      maxTokens: 300,
    });

    if (result && !result.error) {
      const floor = result.floor != null ? parseInt(result.floor, 10) : null;
      const floors = result.floors != null ? parseInt(result.floors, 10) : null;

      // Validare
      const validFloor = floor != null && !isNaN(floor) && floor >= 0 && floor <= 200 ? floor : null;
      const validFloors = floors != null && !isNaN(floors) && floors >= 1 && floors <= 200 ? floors : null;

      console.log(`[floorParserAI:Stage2] 🤖 AI extracted: floor=${validFloor}, floors=${validFloors} (confidence: ${result.confidence})`);
      return { floor: validFloor, floors: validFloors };
    }

    console.log('[floorParserAI:Stage2] ⚠️ AI returned no valid floor data');
    return { floor: null, floors: null };
  } catch (err) {
    logger.error('FLOOR_PARSER', 'Stage2 AI extraction failed', { error: err.message });
    return { floor: null, floors: null };
  }
}

/**
 * STAGE 3: AI deduce etajul din context (descriere, titlu, text)
 *
 * Când nici DOM-ul nici HTML-ul nu conțin etajul explicit,
 * AI-ul analizează descrierea și contextul pentru a-l deduce.
 *
 * Exemple:
 *   - "Apartament la ultimul etaj" → floor = floors (ultimul)
 *   - "Apartament la parter" → floor = 0
 *   - "Apartament la etajul intermediar" → floor = floors/2 (aproximativ)
 *   - "Bloc cu 10 etaje, apartament la etajul 5" → floor=5, floors=10
 *
 * @param {Object} extractedData - Datele parțial extrase (cu câmpuri goale)
 * @returns {Promise<{ floor: number|null, floors: number|null }>}
 */
async function extractFloorStage3(extractedData) {
  if (!extractedData) return { floor: null, floors: null };

  try {
    // Construiește context din datele disponibile
    const context = [
      extractedData.title ? `Title: ${extractedData.title}` : '',
      extractedData.description ? `Description: ${extractedData.description}` : '',
      extractedData.bodyText ? `Body: ${extractedData.bodyText?.substring(0, 2000)}` : '',
    ].filter(Boolean).join('\n');

    if (!context || context.length < 20) {
      console.log('[floorParserAI:Stage3] ⚠️ Insufficient context for inference');
      return { floor: null, floors: null };
    }

    const systemPrompt = `Ești un expert imobiliar care poate deduce etajul unui apartament din descrierea anunțului.

Sarcina ta: Analizează textul și încearcă să DEDUCI etajul și numărul total de etaje.

Reguli:
1. Caută cuvinte cheie: "ultimul etaj" → floor = floors, "parter" → floor = 0, "etajul X" → floor = X
2. Dacă vezi "etajul X din Y" sau "etajul X al Y" → floor=X, floors=Y
3. Dacă menționează doar "etaj superior" sau "ultimul etaj" fără număr → nu deduce arbitrar
4. Prioritate: informația explicită > deducerea din context

Răspunde DOAR cu JSON:
{ "floor": number|null, "floors": number|null, "confidence": "high"|"medium"|"low", "reasoning": "explicație scurtă" }`;

    const userPrompt = `Context anunț:
${context}

Poți determina etajul din acest text?`;

    const result = await askAI(systemPrompt, userPrompt, {
      expectJson: true,
      temperature: 0.1,
      maxTokens: 300,
    });

    if (result && !result.error) {
      const floor = result.floor != null ? parseInt(result.floor, 10) : null;
      const floors = result.floors != null ? parseInt(result.floors, 10) : null;

      const validFloor = floor != null && !isNaN(floor) && floor >= 0 && floor <= 200 ? floor : null;
      const validFloors = floors != null && !isNaN(floors) && floors >= 1 && floors <= 200 ? floors : null;

      console.log(`[floorParserAI:Stage3] 🤖 AI inferred: floor=${validFloor}, floors=${validFloors} (confidence: ${result.confidence}, reasoning: ${result.reasoning || 'N/A'})`);
      return { floor: validFloor, floors: validFloors };
    }

    return { floor: null, floors: null };
  } catch (err) {
    logger.error('FLOOR_PARSER', 'Stage3 AI inference failed', { error: err.message });
    return { floor: null, floors: null };
  }
}

/**
 * aiExtractFloor — 3-Stage AI Floor Extraction (Main Entry)
 *
 * Pipeline complet:
 *   1. Stage 1: Regex pe HTML brut (rapid, sigur)
 *   2. Stage 2: AI pe HTML (când regex eșuează)
 *   3. Stage 3: AI deduce din context (când nici HTML nu ajută)
 *
 * @param {string} rawHtml - HTML brut al paginii
 * @param {string} htmlSnippet - Fragment HTML relevant pentru analiză AI
 * @param {Object} extractedData - Datele parțial extrase (pentru Stage 3)
 * @returns {Promise<{ floor: number|null, floors: number|null, source: string }>}
 */
async function aiExtractFloor(rawHtml, htmlSnippet = null, extractedData = null) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🏢 [FLOOR PARSER AI] 3-STAGE EXTRACTION');
  console.log('═══════════════════════════════════════════════════════════');

  // ── STAGE 1: Regex pe HTML brut ──
  console.log('  📡 Stage 1: Static regex extraction...');
  let result = extractFloorStage1(rawHtml);

  if (result.floor != null) {
    console.log(`  ✅ Stage 1 SUCCESS: floor=${result.floor}, floors=${result.floors}`);
    return { ...result, source: 'stage1_regex' };
  }
  console.log('  ⚠️ Stage 1: No match — proceeding to Stage 2');

  // ── STAGE 2: AI on HTML ──
  console.log('  📡 Stage 2: AI HTML analysis...');
  const snippet = htmlSnippet || rawHtml?.substring(0, 10000);
  result = await extractFloorStage2(snippet);

  if (result.floor != null) {
    console.log(`  ✅ Stage 2 SUCCESS: floor=${result.floor}, floors=${result.floors}`);
    return { ...result, source: 'stage2_ai_html' };
  }
  console.log('  ⚠️ Stage 2: AI could not determine — proceeding to Stage 3');

  // ── STAGE 3: AI inference from context ──
  console.log('  📡 Stage 3: AI context inference...');
  result = await extractFloorStage3(extractedData);

  if (result.floor != null) {
    console.log(`  ✅ Stage 3 SUCCESS: floor=${result.floor}, floors=${result.floors} (confidence: ${result.confidence})`);
    return { ...result, source: 'stage3_ai_inference' };
  }

  // ── ALL STAGES EXHAUSTED ──
  console.log('  ❌ All 3 stages exhausted — floor not found');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  return { floor: null, floors: null, source: 'none' };
}

module.exports = {
  aiExtractFloor,
  extractFloorStage1,
  extractFloorStage2,
  extractFloorStage3,
};