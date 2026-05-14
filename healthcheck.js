/**
 * ════════════════════════════════════════════════════════════════
 *  HEALTHCHECK — HTTP Endpoint pentru monitoring extern
 * ════════════════════════════════════════════════════════════════
 *
 *  Rulează un server HTTP pe portul HEALTH_PORT (default 8080).
 *  Expune endpoint-uri:
 *    • GET /health  → 200 + JSON status (aplicația e vie)
 *    • GET /ready   → 200 dacă botul e fully operational
 *    • GET /status  → status detaliat (memorie, uptime, watchdog)
 *
 *  Folosit de:
 *    • Coolify / Docker healthcheck
 *    • External monitoring (UptimeRobot, BetterStack, etc.)
 *    • PM2 (via http probe)
 * ════════════════════════════════════════════════════════════════ */

const http = require("http");
const logger = require("./logger");

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080", 10);

// Shared state — updated by index.js
let healthState = {
  status: "starting",
  botUptime: 0,
  processUptime: 0,
  memory: {},
  watchdog: {
    lastActivity: null,
    status: "unknown",
  },
  workers: {
    active: 0,
    status: "unknown",
  },
  lastError: null,
  version: "1.0.0",
};

/**
 * Update shared health state (called from index.js)
 */
function updateHealthState(updates) {
  healthState = { ...healthState, ...updates };
}

/**
 * Collect current memory stats
 */
function getMemoryStats() {
  const mem = process.memoryUsage();
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)} MB`,
    heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)} MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)} MB`,
    external: `${Math.round(mem.external / 1024 / 1024)} MB`,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
  };
}

/**
 * Create and start the healthcheck server
 */
function startHealthServer() {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://localhost:${HEALTH_PORT}`);
    const path = url.pathname;

    // Update memory on every request
    const currentMem = getMemoryStats();
    const responseData = {
      ...healthState,
      memory: currentMem,
      processUptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };

    switch (path) {
      case "/health":
        // Basic liveness probe
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
        logger.health("Healthcheck OK", { uptime: process.uptime() });
        break;

      case "/ready":
        // Readiness probe — bot must be running
        if (healthState.status === "running") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ready", uptime: process.uptime() }));
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "not_ready", state: healthState.status }));
        }
        break;

      case "/status":
        // Detailed status
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseData, null, 2));
        break;

      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
    }
  });

  server.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.health(`Healthcheck server listening on port ${HEALTH_PORT}`);
  });

  // Don't let healthcheck server crash the process
  server.on("error", (err) => {
    logger.error("HEALTH", "Healthcheck server error", { error: err.message });
  });

  return server;
}

module.exports = { startHealthServer, updateHealthState };