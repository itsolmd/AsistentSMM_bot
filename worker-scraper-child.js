/**
 * ════════════════════════════════════════════════════════════════
 *  WORKER SCRAPER CHILD — Procesul Copil pentru Scraping
 * ════════════════════════════════════════════════════════════════
 *
 *  Rulează ca child_process. Primește comenzi de la procesul
 *  părinte prin IPC și returnează rezultatele.
 *
 *  Acest proces POATE să se blocheze fără a afecta botul.
 *  Procesul părinte îl va omorî și reporni automat.
 * ════════════════════════════════════════════════════════════════ */

// Signal that worker is ready
process.send({ type: "ready" });

// Handle incoming messages from parent
process.on("message", async (msg) => {
  if (msg.type === "scrape") {
    try {
      const { url, options, requestId } = msg;

      process.send({
        type: "log",
        message: `Scraping URL: ${url.substring(0, 80)}...`,
        data: { url: url.substring(0, 80) },
      });

      // Determine which scraper to use based on URL
      const result = await routeScraper(url, options);

      process.send({
        type: "result",
        requestId,
        success: true,
        data: result,
      });
    } catch (err) {
      process.send({
        type: "result",
        requestId: msg.requestId,
        success: false,
        error: err.message,
        stack: err.stack,
      });
    }
  }
});

/**
 * Route scraping to the appropriate scraper based on URL
 */
async function routeScraper(url, options) {
  const hostname = new URL(url).hostname.toLowerCase();

  switch (true) {
    case hostname.includes("999.md"):
      return await scrape999(url);
    case hostname.includes("immobiliare.md"):
      return await scrapeImmobiliare(url);
    case hostname.includes("loyal.md"):
      return await scrapeLoyal(url);
    case hostname.includes("mirax.md"):
      return await scrapeMirax(url);
    case hostname.includes("seli.md"):
      return await scrapeSeli(url);
    case hostname.includes("makler.md"):
      return await scrapeMakler(url);
    default:
      throw new Error(`Unsupported domain: ${hostname}`);
  }
}

/**
 * Scrape 999.md
 */
async function scrape999(url) {
  const { scrap_999 } = require("./webscrape/websites/999");
  return await scrap_999(null, url);
}

/**
 * Scrape Immobiliare.md
 */
async function scrapeImmobiliare(url) {
  const { scrap_immobiliare } = require("./webscrape/websites/immobiliare");
  return await scrap_immobiliare(null, url);
}

/**
 * Scrape Loyal.md
 */
async function scrapeLoyal(url) {
  const { parseLoyal } = require("./webscrape/websites/loyal");
  return await parseLoyal(url);
}

/**
 * Scrape Mirax.md
 */
async function scrapeMirax(url) {
  // Placeholder — implement when parser is available
  throw new Error("Mirax.md parser not yet implemented");
}

/**
 * Scrape Seli.md
 */
async function scrapeSeli(url) {
  // Placeholder — implement when parser is available
  throw new Error("Seli.md parser not yet implemented");
}

/**
 * Scrape Makler.md
 */
async function scrapeMakler(url) {
  // Placeholder — implement when parser is available
  throw new Error("Makler.md parser not yet implemented");
}

// Handle uncaught errors in worker — log and exit gracefully
process.on("uncaughtException", (err) => {
  process.send({
    type: "error",
    message: `Uncaught exception in worker: ${err.message}`,
    data: { stack: err.stack },
  });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.send({
    type: "error",
    message: `Unhandled rejection in worker: ${reason}`,
  });
});