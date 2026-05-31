/**
 * ════════════════════════════════════════════════════════════════
 * utils/retryExtract.js — Retry wrapper with AI escalation
 * ════════════════════════════════════════════════════════════════
 *
 * Wrapper care încearcă extragerea datelor dintr-un URL cu retry
 * și escaladare progresivă:
 *   1. Încearcă scraperul existent de max N ori (cu delay progresiv)
 *   2. Dacă toate încercările eșuează, folosește AI (Claude Sonnet)
 *      pentru a extrage datele direct din HTML-ul paginii
 *   3. Returnează mereu un rezultat (nu aruncă erori necontrolate)
 *
 * DEPENDENȚE:
 *   - scrap_999, scrap_premier, scrap_immobiliare etc.
 *   - askAI / askAIWithRetry din ai/openRouterClient.js
 * ════════════════════════════════════════════════════════════════ */

const { scrap_999 } = require('../webscrape/websites/999');
const { scrap_premier } = require('../webscrape/websites/premier');
const { scrap_immobiliare } = require('../webscrape/websites/immobiliare');
const { askAIWithRetry } = require('../ai/openRouterClient');

// ── Sleep helper ───────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * isValidResult(result)
 * ─────────────────────────
 * Verifică dacă rezultatul scraping-ului este valid (conține
 * cel puțin unul dintre câmpurile obligatorii: price, area,
 * rooms, title).
 *
 * Un rezultat e considerat invalid dacă:
 *   - e null/undefined
 *   - are proprietatea error = true (page not found, deleted etc.)
 *   - nu conține niciun câmp obligatoriu cu o valoare reală
 *
 * @param {Object|null} result - Rezultatul de la scraper
 * @returns {boolean} true dacă rezultatul e utilizabil
 */
function isValidResult(result) {
  if (!result || result.error === true) return false;

  // Câmpurile obligatorii pe care le verificăm
  const requiredFields = ['price', 'area', 'rooms', 'title'];
  const placeholderValues = ['—', '-', 'N/A', 'null', '', 'undefined'];

  for (const field of requiredFields) {
    const val = result[field];
    if (val != null && !placeholderValues.includes(String(val).trim())) {
      // Câmpul există și nu e placeholder — rezultatul e valid
      return true;
    }
  }

  return false;
}

/**
 * extractWithAI(url, partialResult)
 * ────────────────────────────────────
 * Fază de escaladare AI: folosește Claude Sonnet (via OpenRouter)
 * pentru a extrage datele din HTML-ul paginii brute.
 *
 * Flow:
 *   1. Fetch conținutul paginii brute (fără a folosi Puppeteer)
 *   2. Trimite textul relevant (HTML/text) la Claude Sonnet
 *   3. Claude returnează JSON cu câmpurile imobiliare
 *   4. Returnăm obiectul JSON parsat
 *
 * @param {string} url - URL-ul anunțului imobiliar
 * @param {Object|null} partialResult - Rezultat parțial (dacă există)
 * @returns {Promise<Object>} Obiect cu datele extrase
 */
async function extractWithAI(url, partialResult = null) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🤖 [RETRY_AI] Escaladare AI — extragere date');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  🔗 URL: ${url}`);
  console.log('');

  try {
    // ── 1. Fetch conținutul paginii brute ──────────────────────
    console.log('  📡 [RETRY_AI] Fetch pagină...');
    const axios = require('axios');
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,ru;q=0.8,en;q=0.7',
      },
    });

    const rawHtml = response.data || '';
    console.log(`  📦 [RETRY_AI] HTML primit: ${rawHtml.length} caractere`);

    // Extragem textul vizibil + părți relevante din HTML
    // (strip tags pentru a reduce dimensiunea)
    const strippedText = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 15000); // Limită pentru context AI

    console.log(`  📝 [RETRY_AI] Text relevant: ${strippedText.length} caractere`);
    console.log('  🧠 [RETRY_AI] Trimitere la Claude Sonnet...');

    // ── 2. Prompt pentru AI ────────────────────────────────────
    const systemPrompt = 'Ești un expert în extragerea datelor imobiliare. ' +
      'Extrage informațiile din textul furnizat și returnează JSON valid. ' +
      'Răspunde DOAR cu JSON, fără markdown, fără explicații.';

    let partialContext = '';
    if (partialResult) {
      partialContext = '\n\nRezultat parțial deja extras (poți completa/ajusta): ' +
        JSON.stringify(partialResult, null, 2);
    }

    const userPrompt =
      'Din acest HTML/text de anunț imobiliar, extrage în JSON: ' +
      'title, price, currency, area, rooms, floor, totalFloors, address, condition, buildingType, description.\n\n' +
      'Reguli:\n' +
      '- price = valoare numerică (fără simboluri)\n' +
      '- currency = "EUR" sau "MDL"\n' +
      '- area = număr (m²)\n' +
      '- rooms = număr\n' +
      '- floor, totalFloors = număr (sau null dacă nu există)\n' +
      '- Dacă un câmp nu există în text, pune null\n' +
      '- DOAR JSON, fără markdown, fără \`\`\`\n\n' +
      'TEXTUL ANUNȚULUI:\n' + strippedText +
      partialContext;

    // ── 3. Trimite la AI ───────────────────────────────────────
    const aiResult = await askAIWithRetry(systemPrompt, userPrompt, {
      expectJson: true,
      temperature: 0.05,
      maxTokens: 800,
      forceModel: 'anthropic/claude-sonnet-4-20250514',
    });

    console.log('  ✅ [RETRY_AI] Răspuns AI primit:', JSON.stringify(aiResult).substring(0, 200));

    // ── 4. Construiește rezultatul final ───────────────────────
    // Îmbină rezultatul AI cu datele parțiale existente
    const finalResult = {
      ...(partialResult || {}),
      ...aiResult,
      // Marchează că a fost extras cu AI
      _aiExtracted: true,
      _aiSource: 'claude-sonnet-4-20250514',
    };

    console.log('  ✅ [RETRY_AI] Date extrase cu succes via AI');
    console.log('');

    return finalResult;
  } catch (err) {
    console.error('  ❌ [RETRY_AI] Eroare la extragerea AI:', err.message);

    // Dacă AI e complet indisponibil, returnăm partialResult (dacă există)
    // sau un obiect gol
    if (partialResult) {
      console.log('  ⚠️ [RETRY_AI] Returnare rezultat parțial (AI indisponibil)');
      return {
        ...partialResult,
        _aiExtracted: false,
        _aiError: err.message,
      };
    }

    // Fallback: returnăm un obiect gol (nu aruncăm niciodată eroare)
    return {
      title: url,
      price: null,
      area: null,
      rooms: null,
      _aiExtracted: false,
      _aiError: err.message,
    };
  }
}

/**
 * extractWithRetry(url, options)
 * ────────────────────────────────
 * Wrapper principal cu retry + escaladare AI.
 *
 * Flow:
 *   1. Încearcă scraperul existent de max `maxAttempts` ori
 *   2. După fiecare eșec, așteaptă `delayMs * attempt` milisecunde
 *   3. Verifică rezultatul cu isValidResult()
 *   4. Dacă toate încercările eșuează, escaladează la AI
 *   5. Returnează rezultatul (sau aruncă eroare dacă și AI eșuează)
 *
 * @param {string} url - URL-ul de scrapuit
 * @param {Object} options
 * @param {number} options.maxAttempts - Număr maxim de încercări (default: 5)
 * @param {number} options.delayMs - Delay între încercări (default: 3000)
 * @param {boolean} options.useAI - Activează escaladarea AI (default: true)
 * @param {Function} options.onAttempt - Callback pentru status mesaje (ctx, attempt, maxAttempts)
 * @returns {Promise<Object>} Rezultatul extragerii
 */
async function extractWithRetry(url, options = {}) {
  const {
    maxAttempts = 5,
    delayMs = 3000,
    useAI = true,
    ctx = null,
    onAttempt = null,
  } = options;

  let lastResult = null;
  let lastError = null;

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🔄 [RETRY] ÎNCEPE EXTRAGERE CU RETRY (max ${maxAttempts} încercări)`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  🔗 URL: ${url}`);
  console.log(`  ⏱️  Delay: ${delayMs}ms, AI escalation: ${useAI}`);
  console.log('');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`  🔄 [RETRY] Încercarea ${attempt}/${maxAttempts}...`);

    // Notificare callback (de ex. pentru a trimite mesaj utilizatorului)
    if (typeof onAttempt === 'function' && attempt > 1) {
      await onAttempt(attempt, maxAttempts);
    }

    try {
      // ── 1. Determină scraperul în funcție de URL ───────────
      let host;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        throw new Error(`URL invalid: ${url}`);
      }

      let result;
      if (host === '999.md' || host === 'm.999.md') {
        result = await scrap_999(ctx, url);
      } else if (host === 'premierimobil.md') {
        result = await scrap_premier(ctx, url);
      } else if (host === 'immobiliare.md') {
        result = await scrap_immobiliare(ctx, url);
      } else {
        throw new Error(`Host negestionat: ${host}`);
      }

      // ── 2. Salvează rezultatul (chiar dacă e invalid) ─────
      lastResult = result;

      // ── 3. Verifică validitatea ────────────────────────────
      if (isValidResult(result)) {
        console.log(`  ✅ [RETRY] Încercarea ${attempt}/${maxAttempts} REUȘITĂ`);
        console.log('');
        return result;
      }

      // Rezultat invalid — aruncă eroare pentru a declanșa retry
      const invalidReason = result?.error === true
        ? `Pagină invalidă: ${result.reason || 'unknown'}`
        : `Rezultat incomplet: ${JSON.stringify(result)}`;

      throw new Error(invalidReason);
    } catch (err) {
      lastError = err;
      console.warn(`  ⚠️ [RETRY] Încercarea ${attempt}/${maxAttempts} eșuată: ${err.message}`);

      // ── CODE BUG DETECTION ──────────────────────────────────────
      // If the error is a programming bug (TypeError, ReferenceError, SyntaxError),
      // retrying will NEVER fix it. Throw immediately instead of wasting attempts.
      const isCodeBug = err instanceof TypeError ||
                        err instanceof ReferenceError ||
                        err instanceof SyntaxError;
      if (isCodeBug) {
        console.error(`  🐛 [RETRY] Code bug detected (${err.name}) — aborting immediately: ${err.message}`);
        throw err;
      }

      // Dacă nu mai sunt încercări, ieșim din buclă
      if (attempt >= maxAttempts) {
        console.warn(`  ❌ [RETRY] Toate ${maxAttempts} încercările au eșuat.`);
        break;
      }

      // Delay progresiv: delayMs * attempt
      const waitTime = delayMs * attempt;
      console.log(`  ⏳ [RETRY] Următoarea încercare peste ${waitTime}ms...`);
      await sleep(waitTime);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ESCALADARE AI — toate încercările au eșuat
  // ══════════════════════════════════════════════════════════════
  if (useAI) {
    console.log('');
    console.log('  🤖 [RETRY] Escaladare la AI...');
    console.log('');

    try {
      // Folosește ultimul rezultat (chiar și parțial) ca context pentru AI
      const aiResult = await extractWithAI(url, lastResult);

      if (aiResult && !aiResult._aiError) {
        console.log('  ✅ [RETRY] Escaladare AI reușită');
        console.log('');
        return aiResult;
      }

      // AI a eșuat — aruncă eroare
      throw new Error(`AI extraction failed: ${aiResult?._aiError || 'unknown'}`);
    } catch (aiErr) {
      console.error('  ❌ [RETRY] Escaladare AI eșuată:', aiErr.message);
      console.error('');
      throw new Error(
        `Nu am putut extrage datele după ${maxAttempts} încercări. ` +
        `Ultima eroare: ${lastError?.message || 'unknown'}. ` +
        `AI fallback: ${aiErr.message}`
      );
    }
  }

  // ══════════════════════════════════════════════════════════════
  // EȘEC TOTAL — fără AI sau AI dezactivat
  // ══════════════════════════════════════════════════════════════
  throw new Error(
    `Nu am putut extrage datele după ${maxAttempts} încercări. ` +
    `Ultima eroare: ${lastError?.message || 'unknown'}`
  );
}

module.exports = {
  extractWithRetry,
  extractWithAI,
  isValidResult,
};
