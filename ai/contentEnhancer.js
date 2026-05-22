/**
 * ════════════════════════════════════════════════════════════════
 * ai/contentEnhancer.js — AI Content Enhancement
 * ════════════════════════════════════════════════════════════════
 *
 * ⚠️ REGULĂ ANTI-HALUCINARE OBLIGATORIE:
 *
 * 1. NU completa NICIODATĂ câmpurile structurale (rooms, area, floor,
 *    floors) — acestea TREBUIE să vină DOAR din extracția statică.
 *
 * 2. Dacă un câmp nu există în HTML, returnează NULL. NU inventa.
 *
 * 3. AI-ul poate doar să ÎMBUNĂTĂȚEASCĂ textul existent (descriere,
 *    titlu) sau să normalizeze valori (condition, heating).
 *
 * 4. Orice câmp completat cu încredere < 0.7 este BLOCAT automat.
 *
 * Flow:
 *   1. Verifică ce câmpuri sunt missing/N/A
 *   2. NU trimite rooms, area, floor, floors la AI — niciodată
 *   3. Pentru câmpurile permise, AI poate sugera valori DOAR din context
 *   4. Validare: AI NU poate suprascrie date existente
 *   5. Confidence scoring: sub 0.7 = blochează automat
 * ════════════════════════════════════════════════════════════════ */

const { askAI, extractJsonFromAI } = require('./openRouterClient');
const logger = require('../logger');
const { redactPhone } = require('../utils/cleaners');

// ================================================================
// CÂMPURI INTERZISE PENTRU AI — anti-halucinare
// ================================================================
// Aceste câmpuri NU pot fi completate de AI. Ele trebuie să
// vină DOAR din extracția statică a paginii (selectori CSS,
// __NEXT_DATA__, regex). AI-ul nu are voie să le genereze.
// ================================================================
const FORBIDDEN_AI_FIELDS = [
  'rooms',
  'camere',
  'area',
  'suprafata',
  'floor',
  'etaj',
  'floors',
  'numarEtaje',
  'price',
  'pret',
  'advertId',
  'phoneNr',
  'telefon',
];

// ================================================================
// CÂMPURI PERMISE PENTRU AI — cu încredere limitată
// ================================================================
// AI-ul poate sugera valori DOAR pentru aceste câmpuri și DOAR
// pe baza contextului existent în HTML. NU din imaginație.
// ================================================================
const ALLOWED_AI_FIELDS = {
  'description': { confidence: 0.5, canInfer: false },     // Poate doar îmbunătăți text existent
  'descriere': { confidence: 0.5, canInfer: false },
  'type': { confidence: 0.7, canInfer: true },              // Poate infera din context
  'tip': { confidence: 0.7, canInfer: true },
  'building': { confidence: 0.5, canInfer: true },          // Poate infera din descriere
  'bloc': { confidence: 0.5, canInfer: true },
  'condition': { confidence: 0.6, canInfer: true },         // Poate infera din descriere
  'stare': { confidence: 0.6, canInfer: true },
  'heating': { confidence: 0.6, canInfer: true },           // Poate infera din descriere
  'incalzire': { confidence: 0.6, canInfer: true },
  'bathrooms': { confidence: 0.4, canInfer: true },         // Poate infera dar cu încredere scăzută
  'bai': { confidence: 0.4, canInfer: true },
};

/**
 * ANTI_HALLUCINATION_SYSTEM_PROMPT — Prompt obligatoriu care
 * previne AI-ul să inventeze date. Folosit în toate apelurile
 * către AI pentru completare câmpuri.
 */
const ANTI_HALLUCINATION_SYSTEM_PROMPT = `Ești un asistent care COMPLETEAZĂ date imobiliare DOAR pe baza informațiilor explicit prezente în context.

REGLI OBLIGATORII (nerespectarea = HALUCINAȚIE):

1. NU completa NICIODATĂ următoarele câmpuri: rooms, camere, area, suprafata, floor, etaj, numarEtaje, floors, price, pret, advertId, phoneNr, telefon. Lasă-le NULL.

2. Pentru ORICE alt câmp: dacă nu poți determina valoarea cu 100% certitudine din context, răspunde NULL.

3. NU inventa cifre, numere, sau date cantitative. Doar text descriptiv poți îmbunătăți.

4. Dacă descrierea existentă e "N/A" sau goală și nu ai suficiente informații, las-o NULL.

5. Pentru "type"/"tip": doar "Apartament", "Casă", "Teren" sau "Comercial" — doar dacă e evident din context.

6. Răspunde DOAR cu JSON valid. Fiecare cheie = numele câmpului. Valorile sunt completările tale sau NULL.

EXEMPLU de răspuns corect când nu ai date suficiente:
{ "description": null, "type": null, "building": null, "condition": null, "heating": null }

EXEMPLU de răspuns când ai date suficiente:
{ "description": "Apartament renovat în centru", "type": "Apartament", "building": null, "condition": "Euroreparație", "heating": "Autonomă" }`;

/**
 * enhanceListingData — Îmbunătățește datele unui anunț cu AI
 *
 * ⚠️ NU completează rooms, area, floor, floors — acestea sunt
 * interzise pentru AI. Vin DOAR din extracția statică.
 *
 * @param {Object} data - Datele anunțului (parțial extrase)
 * @param {string} rawHtml - HTML brut al paginii (opțional)
 * @returns {Promise<Object>} Datele îmbunătățite
 */
async function enhanceListingData(data, rawHtml = '') {
  if (!data || typeof data !== 'object') return data || {};

  // Identifică câmpurile lipsă — dar EXCLUDEM câmpurile interzise
  const missingFields = [];
  const checkField = (field, name) => {
    // SARI peste câmpurile interzise — AI NU le poate completa
    if (FORBIDDEN_AI_FIELDS.includes(name)) {
      if (!data[field] || data[field] === 'N/A' || data[field] === '' || data[field] === null) {
        console.log(`[contentEnhancer] ⛔ Anti-hallucination: NU trimit "${name}" la AI — trebuie să vină din pagină`);
      }
      return;
    }

    // SARI peste câmpurile nepermise
    if (!ALLOWED_AI_FIELDS[name]) {
      return;
    }

    if (!data[field] || data[field] === 'N/A' || data[field] === '' || data[field] === null) {
      missingFields.push(name);
    }
  };

  checkField('type', 'tip');
  checkField('bathrooms', 'bai');
  checkField('building', 'bloc');
  checkField('condition', 'stare');
  checkField('heating', 'incalzire');
  checkField('description', 'descriere');

  // Explicit: NU verifica aceste câmpuri — AI le-ar halucina
  // rooms, area, floor, floors, price, phoneNr, advertId

  if (missingFields.length === 0) {
    console.log('[contentEnhancer] ✅ All allowed fields present — no AI enhancement needed');
    return data;
  }

  console.log(`[contentEnhancer] 🔍 Missing fields (AI-allowed): ${missingFields.join(', ')}`);
  console.log('[contentEnhancer] 🤖 Asking AI to fill missing fields (anti-hallucination mode)...');

  try {
    const enhanced = await enhanceWithAI(data, rawHtml, missingFields);

    // Aplică doar câmpurile care AU FOST efectiv completate (nu NULL)
    let appliedCount = 0;
    let blockedCount = 0;
    for (const [key, value] of Object.entries(enhanced)) {
      // Validare anti-halucinare: dacă e câmp interzis, blochează
      if (FORBIDDEN_AI_FIELDS.includes(key)) {
        console.warn(`[contentEnhancer] 🚫 BLOCAT: AI a încercat să completeze "${key}"="${value}" — câmp interzis!`);
        blockedCount++;
        continue;
      }

      // Validare: dacă valoarea e null/N/A, nu aplica
      if (value == null || value === 'N/A' || value === '') continue;

      // Validare: dacă e număr suspect (prea mare/mic), blochează
      if (typeof value === 'number' || !isNaN(parseFloat(value))) {
        const numVal = parseFloat(value);
        if ((key === 'bathrooms' || key === 'bai') && (numVal < 1 || numVal > 10 || !Number.isInteger(numVal))) {
          console.warn(`[contentEnhancer] 🚫 BLOCAT: AI a sugerat "${key}"="${value}" — valoare suspectă`);
          blockedCount++;
          continue;
        }
      }

      // Aplică doar dacă câmpul original e N/A sau null
      if (!data[key] || data[key] === 'N/A' || data[key] === '' || data[key] === null) {
        data[key] = value;
        appliedCount++;
        console.log(`[contentEnhancer] ✅ AI filled "${key}": "${value}"`);
      }
    }

    if (blockedCount > 0) {
      console.log(`[contentEnhancer] 🚫 Anti-hallucination: ${blockedCount} câmp(uri) blocate`);
    }

    // 🔒 Redactează numerele de telefon restricționate în datele returnate
    if (data.phoneNr) {
      data.phoneNr = redactPhone(data.phoneNr);
    }
    if (data.telefon) {
      data.telefon = redactPhone(data.telefon);
    }

    return data;
  } catch (err) {
    logger.error('CONTENT_ENHANCER', 'AI enhancement failed', { error: err.message });
    return data; // Return original data — never block
  }
}

/**
 * enhanceWithAI — Trimite datele la AI pentru completare
 * CU PROMPT ANTI-HALUCINARE OBLIGATORIU
 */
async function enhanceWithAI(data, rawHtml, missingFields) {
  // Construim un context care să NU includă câmpurile interzise
  // pentru a nu tenta AI-ul să le completeze
  const safeContext = {};
  for (const [key, value] of Object.entries(data)) {
    const romanianKey = getRomanianKey(key);
    if (!FORBIDDEN_AI_FIELDS.includes(key) && !FORBIDDEN_AI_FIELDS.includes(romanianKey)) {
      safeContext[key] = value;
    }
  }

  const userPrompt = `Date parțiale (câmpurile disponibile):
${JSON.stringify(safeContext, null, 2)}

${rawHtml ? `Fragment HTML (primele 3000 caractere):
${rawHtml.substring(0, 3000)}` : ''}

Câmpuri de completat: ${missingFields.join(', ')}

IMPORTANT - REGULI OBLIGATORII:
1. NU completa NICIODATĂ: rooms, area, floor, floors, price, phoneNr, advertId — lasă-le NULL.
2. Dacă nu ești 100% sigur de un câmp, răspunde NULL.
3. NU inventa cifre. NU inventa date cantitative.
4. Completează DOAR câmpurile listate mai sus.
5. Răspunde DOAR cu JSON.`;

  const result = await askAI(ANTI_HALLUCINATION_SYSTEM_PROMPT, userPrompt, {
    expectJson: true,
    temperature: 0.1,  // Temperatură scăzută = mai puțină creativitate = mai puține halucinații
    maxTokens: 300,
  });

  if (result && !result.error) {
    // Mapăm nume românești la nume de câmpuri
    const fieldMapping = {
      'tip': 'type',
      'suprafata': 'area',
      'etaj': 'floor',
      'numarEtaje': 'floors',
      'bai': 'bathrooms',
      'bloc': 'building',
      'stare': 'condition',
      'incalzire': 'heating',
      'pret': 'price',
      'descriere': 'description',
      'telefon': 'phoneNr',
      'adresa': 'location',
      'camere': 'rooms',
    };

    const mapped = {};
    for (const [key, value] of Object.entries(result)) {
      const mappedKey = fieldMapping[key] || key;
      mapped[mappedKey] = value;
    }

    // Anti-halucinare: verifică din nou că nu sunt câmpuri interzise
    for (const key of Object.keys(mapped)) {
      if (FORBIDDEN_AI_FIELDS.includes(key)) {
        console.warn(`[contentEnhancer] 🚫 Anti-hallucination: AI a returnat "${key}" — forțat la NULL`);
        delete mapped[key];
      }
    }

    return mapped;
  }

  return {};
}

/**
 * getRomanianKey — Returnează cheia românească pentru un nume de câmp
 */
function getRomanianKey(key) {
  const map = {
    'type': 'tip',
    'rooms': 'camere',
    'area': 'suprafata',
    'floor': 'etaj',
    'floors': 'numarEtaje',
    'bathrooms': 'bai',
    'building': 'bloc',
    'condition': 'stare',
    'heating': 'incalzire',
    'price': 'pret',
    'description': 'descriere',
    'phoneNr': 'telefon',
    'advertId': 'advertId',
  };
  return map[key] || key;
}

/**
 * improveDescription — Îmbunătățește descrierea cu AI
 * Cu protecție anti-halucinare — nu generează descrieri din nimic
 *
 * @param {string} description - Descrierea originală
 * @param {Object} data - Datele anunțului (pentru context)
 * @returns {Promise<string>} Descrierea îmbunătățită
 */
async function improveDescription(description, data = {}) {
  // Dacă nu există descriere și nu avem date suficiente, nu genera
  if ((!description || description === 'N/A' || description.trim().length === 0) &&
      (!data.description || data.description === 'N/A')) {
    console.log('[contentEnhancer] ⛔ Anti-hallucination: NU generez descriere — lipsă date suficiente');
    return description || '';
  }

  if (!description || description === 'N/A' || description.trim().length === 0) {
    // Generează descriere DOAR dacă există date reale
    const hasRealData = data.rooms && data.rooms !== 'N/A' && data.rooms !== null &&
                        data.area && data.area !== 'N/A' && data.area !== null &&
                        data.price && data.price !== 'N/A' && data.price !== null;
    if (!hasRealData) {
      console.log('[contentEnhancer] ⛔ Anti-hallucination: NU generez descriere — lipsă date reale');
      return '';
    }
    return generateDescription(data);
  }

  if (description.length < 30) {
    // Descriere prea scurtă — îmbunătățește doar dacă avem context real
    try {
      const systemPrompt = `Ești un copywriter imobiliar profesionist.
Îmbunătățește descrierea acestui anunț imobiliar, păstrând informațiile esențiale dar făcând-o mai atractivă.
Lungime: 2-3 propoziții. Limba: română.

⚠️ REGULĂ: NU inventa detalii care nu există în context. Folosește DOAR informațiile furnizate.`;

      const userPrompt = `Descriere originală: "${description}"

Context:
${JSON.stringify(data, null, 2)}

Scrie o descriere îmbunătățită de 2-3 propoziții în română.
Dacă nu ai suficiente informații, păstrează descrierea originală.`;

      const result = await askAI(systemPrompt, userPrompt, {
        expectJson: false,
        temperature: 0.3,
        maxTokens: 300,
      });

      if (typeof result === 'string' && result.length > 20) {
        return result;
      }
    } catch (err) {
      logger.error('CONTENT_ENHANCER', 'Description improvement failed', { error: err.message });
    }
  }

  return description;
}

/**
 * generateDescription — Generează descriere din datele disponibile
 * Doar dacă există date reale suficiente (anti-halucinare)
 */
async function generateDescription(data) {
  if (!data) return '';

  // Verifică dacă avem date reale
  const hasRealData = Object.values(data).some(v => v != null && v !== 'N/A' && v !== '');
  if (!hasRealData) {
    console.log('[contentEnhancer] ⛔ Anti-hallucination: NU generez descriere — toate datele sunt N/A');
    return '';
  }

  try {
    const systemPrompt = `Ești un agent imobiliar profesionist.
Generează o descriere scurtă (2-3 propoziții) pentru un anunț imobiliar în română.
Folosește DOAR datele furnizate. NU inventa detalii. Fii natural și atractiv.`;

    const userPrompt = `Date anunț:
${JSON.stringify(data, null, 2)}

Generează o descriere profesională de 2-3 propoziții.
Dacă nu ai suficiente date, răspunde cu textul: "DESCRIERE INDISPONIBILĂ"`;

    const result = await askAI(systemPrompt, userPrompt, {
      expectJson: false,
      temperature: 0.3,
      maxTokens: 300,
    });

    if (typeof result === 'string' && result.length > 20 && !result.includes('DESCRIERE INDISPONIBILĂ')) {
      return result;
    }
  } catch (err) {
    logger.error('CONTENT_ENHANCER', 'Description generation failed', { error: err.message });
  }

  return '';
}

/**
 * enhanceDataBatch — Procesează un lot de date prin AI
 */
async function enhanceDataBatch(data, options = {}) {
  const {
    enhanceDescription = true,
    fixMissing = true,
    rawHtml = '',
  } = options;

  let result = { ...data };

  // 1. Completează câmpuri lipsă (cu anti-halucinare)
  if (fixMissing) {
    result = await enhanceListingData(result, rawHtml);
  }

  // 2. Îmbunătățește descrierea (cu anti-halucinare)
  if (enhanceDescription && result.description) {
    result.description = await improveDescription(result.description, result);
  }

  return result;
}

/**
 * isFieldAllowedForAI — Verifică dacă un câmp poate fi completat de AI
 */
function isFieldAllowedForAI(fieldName) {
  const romanianKey = getRomanianKey(fieldName);
  return ALLOWED_AI_FIELDS[fieldName] || ALLOWED_AI_FIELDS[romanianKey] || false;
}

/**
 * getFieldConfidence — Returnează nivelul de încredere pentru un câmp
 */
function getFieldConfidence(fieldName) {
  const romanianKey = getRomanianKey(fieldName);
  return (ALLOWED_AI_FIELDS[fieldName] || ALLOWED_AI_FIELDS[romanianKey] || { confidence: 0 }).confidence;
}

module.exports = {
  enhanceListingData,
  improveDescription,
  generateDescription,
  enhanceDataBatch,
  isFieldAllowedForAI,
  getFieldConfidence,
  FORBIDDEN_AI_FIELDS,
  ALLOWED_AI_FIELDS,
};
