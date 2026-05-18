/**
 * ════════════════════════════════════════════════════════════════
 * REAL ESTATE PROMPT — System & user prompts for AI parsing
 * ════════════════════════════════════════════════════════════════
 *
 * Generates prompts for OpenRouter AI models to extract structured
 * real estate data from unstructured Romanian text. Supports both
 * apartment and house listings from 999.md, Premier, immobiliare.md
 * and other Moldovan/Romanian real estate platforms.
 */

/**
 * Get the system prompt for real estate AI parsing
 *
 * @returns {string} - System prompt
 */
function getSystemPrompt() {
  return `Ești un asistent specializat în extragerea datelor imobiliare din texte în limba română.

Sarcina ta este să analizezi textul unui anunț imobiliar și să extragi informațiile structurate în format JSON.

Câmpurile pe care trebuie să le extragi:

{
  "type": "Tipul proprietății — 'apartments', 'houses', 'commercials', sau 'terrains'",
  "price": "Prețul ca număr (fără simboluri)",
  "currency": "Moneda — 'EUR', 'MDL', sau 'USD'",
  "area": "Suprafața în m² ca număr",
  "rooms": "Numărul de camere (doar pentru apartamente/case)",
  "floor": "Etajul (doar pentru apartamente)",
  "totalFloors": "Numărul total de etaje (doar pentru apartamente)",
  "building": "Tipul blocului/materialul (ex: 'Panouri', 'Cărămidă', 'Monolit')",
  "condition": "Starea apartamentului (ex: 'Fără reparație', 'Variantă albă', 'Euroreparație', 'Reparație cosmetică', 'Reparație capitală')",
  "heating": "Tipul încălzirii (ex: 'Centrală termică', 'Termoficare', 'Pecară pe lemne')",
  "balcony": "Balconul (ex: 'Da', 'Nu', 'Logie')",
  "parking": "Parcare (ex: 'Da', 'Nu', 'Subterană')",
  "house_type": "Tipul casei (ex: 'Caramida', 'Piatra', 'Lemn')",
  "landArea": "Suprafața terenului în ari (doar pentru case/terenuri)",
  "commercial_destination": "Destinația comercială (ex: 'Birou', 'Magazin', 'Depozit')",
  "terrain_destination": "Destinația terenului (ex: 'Construcție', 'Agricol', 'Pomicol')",
  "location": "Locația completă",
  "sector": "Sectorul municipiului",
  "city": "Orașul/Municipiul",
  "description": "Descrierea completă a anunțului",
  "_confidence": "Un număr de la 0 la 1 care indică încrederea ta în datele extrase"
}

Reguli importante:
1. Dacă un câmp nu poate fi determinat, NU îl include în JSON (nu folosi null)
2. Prețul trebuie să fie un număr, nu un string (ex: 55000, nu "55000 €")
3. Suprafața trebuie să fie un număr, nu un string
4. Identifică tipul proprietății corect:
   - "apartments" pentru apartamente
   - "houses" pentru case/case de locuit
   - "commercials" pentru spații comerciale/birouri
   - "terrains" pentru terenuri/loturi
5. Răspunde DOAR cu JSON-ul, fără text adițional
6. Toate valorile text trebuie să fie în limba română`;
}

/**
 * Create user prompt from raw real estate text and image count
 *
 * @param {string} text - Raw real estate listing text
 * @param {number} imageCount - Number of images in the listing
 * @returns {string} - User prompt for the AI
 */
function createUserPrompt(text, imageCount = 0) {
  const imageContext = imageCount > 0
    ? `\n\nAnunțul conține ${imageCount} imagini.`
    : '';

  return `Extrage datele imobiliare din următorul anunț:${imageContext}

---
${text}
---

Returnază doar JSON-ul cu câmpurile identificate.`;
}

module.exports = {
  getSystemPrompt,
  createUserPrompt,
};
