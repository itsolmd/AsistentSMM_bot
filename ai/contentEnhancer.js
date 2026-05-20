/**
 * ════════════════════════════════════════════════════════════════
 * ai/contentEnhancer.js — AI Content Enhancement
 * ════════════════════════════════════════════════════════════════
 *
 * Folosește OpenRouter pentru a îmbunătăți conținutul extras:
 *   • Corectează datele lipsă/incomplete
 *   • Îmbunătățește descrierile (gramatică, claritate)
 *   • Completează câmpurile obligatorii
 *   • Traduce când e necesar
 *   • Generează titluri profesionale
 *
 * Sistemul NU modifică datele care există deja — doar
 * completează ce lipsește și îmbunătățește calitatea.
 *
 * Flow:
 *   1. Verifică ce câmpuri sunt missing/N/A
 *   2. Pentru fiecare câmp lipsă, AI încearcă să-l determine
 *   3. Validare: AI NU poate suprascrie date existente
 *   4. Return: obiectul îmbunătățit
 * ════════════════════════════════════════════════════════════════ */

const { askAI, extractJsonFromAI } = require('./openRouterClient');
const logger = require('../logger');

/**
 * enhanceListingData — Îmbunătățește datele unui anunț cu AI
 *
 * Verifică fiecare câmp și, dacă lipsește sau e "N/A", încearcă
 * să-l determine din contextul existent.
 *
 * @param {Object} data - Datele anunțului (parțial extrase)
 * @param {string} rawHtml - HTML brut al paginii (opțional)
 * @returns {Promise<Object>} Datele îmbunătățite
 */
async function enhanceListingData(data, rawHtml = '') {
  if (!data || typeof data !== 'object') return data || {};

  // Identifică câmpurile lipsă
  const missingFields = [];
  const checkField = (field, name) => {
    if (!data[field] || data[field] === 'N/A' || data[field] === '' || data[field] === null) {
      missingFields.push(name);
    }
  };

  checkField('type', 'tip');
  checkField('rooms', 'camere');
  checkField('area', 'suprafata');
  checkField('floor', 'etaj');
  checkField('floors', 'numarEtaje');
  checkField('bathrooms', 'bai');
  checkField('building', 'bloc');
  checkField('condition', 'stare');
  checkField('heating', 'incalzire');
  checkField('price', 'pret');
  checkField('description', 'descriere');
  checkField('phoneNr', 'telefon');
  checkField('advertId', 'advertId');

  if (missingFields.length === 0) {
    console.log('[contentEnhancer] ✅ All fields present — no enhancement needed');
    return data;
  }

  console.log(`[contentEnhancer] 🔍 Missing fields: ${missingFields.join(', ')}`);
  console.log('[contentEnhancer] 🤖 Asking AI to fill missing fields...');

  try {
    const enhanced = await enhanceWithAI(data, rawHtml, missingFields);

    // Aplică doar câmpurile care AU FOST efectiv completate
    for (const [key, value] of Object.entries(enhanced)) {
      if (value != null && value !== 'N/A' && value !== '' && value !== false) {
        // NU suprascrie câmpuri care deja există și sunt valide
        if (!data[key] || data[key] === 'N/A' || data[key] === '' || data[key] === null) {
          data[key] = value;
          console.log(`[contentEnhancer] ✅ Filled "${key}": "${value}"`);
        }
      }
    }

    return data;
  } catch (err) {
    logger.error('CONTENT_ENHANCER', 'AI enhancement failed', { error: err.message });
    return data; // Return original data — never block
  }
}

/**
 * enhanceWithAI — Trimite datele la AI pentru completare
 */
async function enhanceWithAI(data, rawHtml, missingFields) {
  const systemPrompt = `Ești un expert imobiliar care completează date lipsă din anunțuri imobiliare.

Sarcina ta: Analizează datele parțiale și HTML-ul paginii, apoi COMPLETEAZĂ doar câmpurile lipsă.

Câmpuri lipsă de completat: ${missingFields.join(', ')}

Reguli:
1. NU inventa date — folosește doar informația din context
2. Dacă nu poți determina un câmp, lasă-l null
3. Pentru "tip": poate fi "Apartament", "Casă", "Teren", "Comercial"
4. Pentru "stare": poate fi "Euroreparație", "Reparație cosmetică", "Variantă albă", "Fără reparație"
5. Pentru "incalzire": poate fi "Autonomă" sau "Centralizată"
6. Prețul trebuie să includă moneda (ex: "97.000 €")
7. Telefonul trebuie să fie format mobil moldovenesc (373XXXXXXXX)

Răspunde DOAR cu JSON unde cheile sunt numele câmpurilor și valorile sunt completările tale.`;

  const userPrompt = `Date parțiale:
${JSON.stringify(data, null, 2)}

${rawHtml ? `Fragment HTML:\n${rawHtml.substring(0, 5000)}` : ''}

Câmpuri lipsă: ${missingFields.join(', ')}

Completează câmpurile pe care le poți determina cu certitudine.`;

  const result = await askAI(systemPrompt, userPrompt, {
    expectJson: true,
    temperature: 0.1,
    maxTokens: 500,
  });

  if (result && !result.error) {
    // Mapăm nume românești la nume de câmpuri
    const fieldMapping = {
      'tip': 'type',
      'camere': 'rooms',
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
      'imagini': 'images',
    };

    const mapped = {};
    for (const [key, value] of Object.entries(result)) {
      const mappedKey = fieldMapping[key] || key;
      mapped[mappedKey] = value;
    }

    return mapped;
  }

  return {};
}

/**
 * improveDescription — Îmbunătățește descrierea cu AI
 *
 * @param {string} description - Descrierea originală
 * @param {Object} data - Datele anunțului (pentru context)
 * @returns {Promise<string>} Descrierea îmbunătățită
 */
async function improveDescription(description, data = {}) {
  if (!description || description === 'N/A' || description.trim().length === 0) {
    // Generează descriere din datele disponibile
    return generateDescription(data);
  }

  if (description.length < 30) {
    // Descriere prea scurtă — îmbunătățește
    try {
      const systemPrompt = `Ești un copywriter imobiliar profesionist.
Îmbunătățește descrierea acestui anunț imobiliar, păstrând informațiile esențiale dar făcând-o mai atractivă.
Lungime: 2-3 propoziții. Limba: română.`;

      const userPrompt = `Descriere originală: "${description}"

Context:
${JSON.stringify(data, null, 2)}

Scrie o descriere îmbunătățită de 2-3 propoziții în română.`;

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
 */
async function generateDescription(data) {
  if (!data) return '';

  try {
    const systemPrompt = `Ești un agent imobiliar profesionist.
Generează o descriere scurtă (2-3 propoziții) pentru un anunț imobiliar în română.
Folosește datele furnizate. Fii natural și atractiv.`;

    const userPrompt = `Date anunț:
${JSON.stringify(data, null, 2)}

Generează o descriere profesională de 2-3 propoziții.`;

    const result = await askAI(systemPrompt, userPrompt, {
      expectJson: false,
      temperature: 0.3,
      maxTokens: 300,
    });

    if (typeof result === 'string' && result.length > 20) {
      return result;
    }
  } catch (err) {
    logger.error('CONTENT_ENHANCER', 'Description generation failed', { error: err.message });
  }

  return '';
}

/**
 * enhanceDataBatch — Procesează un lot de date prin AI
 *
 * @param {Object} data - Datele de îmbunătățit
 * @param {Object} options - Opțiuni
 * @param {boolean} options.enhanceDescription - Îmbunătățește descrierea
 * @param {boolean} options.fixMissing - Completează câmpuri lipsă
 * @param {boolean} options.rawHtml - HTML brut pentru context
 * @returns {Promise<Object>} Datele îmbunătățite
 */
async function enhanceDataBatch(data, options = {}) {
  const {
    enhanceDescription = true,
    fixMissing = true,
    rawHtml = '',
  } = options;

  let result = { ...data };

  // 1. Completează câmpuri lipsă
  if (fixMissing) {
    result = await enhanceListingData(result, rawHtml);
  }

  // 2. Îmbunătățește descrierea
  if (enhanceDescription && result.description) {
    result.description = await improveDescription(result.description, result);
  }

  return result;
}

module.exports = {
  enhanceListingData,
  improveDescription,
  generateDescription,
  enhanceDataBatch,
};