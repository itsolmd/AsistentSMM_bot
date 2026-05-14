/**
 * Strapi API Token Diagnostic Test
 * ===================================
 *
 * Tests whether the STRAPI_TOKEN from .env is valid and has access.
 *
 * Usage:
 *   node tests/testStrapiToken.js
 *
 * Requirements:
 *   - .env file with BACK_END and STRAPI_TOKEN
 *   - dotenv and axios in package.json
 */

require("dotenv").config();
const axios = require("axios");

/* ════════════════════════════════════════════════════════════════
   CONFIGURATION
   ════════════════════════════════════════════════════════════════ */

const STRAPI_TOKEN = process.env.STRAPI_TOKEN;
const BACK_END     = process.env.BACK_END;
const STRAPI_URL   = BACK_END ? `http://${BACK_END}` : null;

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

function log(color, label, msg) {
  console.log(`${color}${COLORS.bold}[${label}]${COLORS.reset} ${msg}`);
}

function divider(title) {
  const line = "═".repeat(60);
  console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
  console.log(`${COLORS.cyan}  ${title}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${line}${COLORS.reset}\n`);
}

/* ════════════════════════════════════════════════════════════════
   HELPER — print response summary
   ════════════════════════════════════════════════════════════════ */

function printResponse(label, status, data) {
  console.log(`  ${COLORS.bold}${label}${COLORS.reset}`);
  console.log(`  ${COLORS.blue}Status :${COLORS.reset} ${status}`);
  console.log(
    `  ${COLORS.blue}Body   :${COLORS.reset}`,
    JSON.stringify(data, null, 2).slice(0, 600)
  );
  console.log();
}

/* ════════════════════════════════════════════════════════════════
   STEP 1 — Pre-flight: check .env values
   ════════════════════════════════════════════════════════════════ */

function checkEnv() {
  divider("STEP 1 — Environment Variable Check");

  if (!STRAPI_TOKEN) {
    log(COLORS.red, "FAIL", "STRAPI_TOKEN is MISSING from .env");
    return false;
  }
  log(COLORS.green, "OK", `STRAPI_TOKEN present (${STRAPI_TOKEN.length} chars)`);

  if (!BACK_END) {
    log(COLORS.red, "FAIL", "BACK_END is MISSING from .env");
    return false;
  }
  log(COLORS.green, "OK", `BACK_END = ${BACK_END}`);

  return true;
}

/* ════════════════════════════════════════════════════════════════
   STEP 2 — GET /api/users/me  (authenticated user info)
   ════════════════════════════════════════════════════════════════ */

async function testGetUsersMe() {
  divider("STEP 2 — GET /api/users/me");

  const url = `${STRAPI_URL}/api/users/me`;
  log(COLORS.cyan, "URL", url);

  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${STRAPI_TOKEN}` },
      timeout: 15_000,
      validateStatus: () => true, // capture any status code
    });

    printResponse("Response", res.status, res.data);

    if (res.status === 200) {
      log(COLORS.green, "PASS", "GET /api/users/me succeeded — token is valid");
      return { ok: true, verdict: "VALID TOKEN", user: res.data };
    }

    if (res.status === 401) {
      log(COLORS.red, "FAIL", "HTTP 401 — token is invalid or revoked");
      return { ok: false, verdict: "INVALID TOKEN", status: res.status };
    }

    if (res.status === 403) {
      log(COLORS.yellow, "WARN", "HTTP 403 — token valid but no access to users/me");
      return { ok: false, verdict: "MISSING PERMISSIONS", status: res.status };
    }

    log(COLORS.yellow, "WARN", `Unexpected status ${res.status}`);
    return { ok: false, verdict: `UNEXPECTED STATUS ${res.status}`, status: res.status };
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ERR_NETWORK") {
      log(COLORS.red, "FAIL", `Network error — cannot reach Strapi: ${err.message}`);
      return { ok: false, verdict: "NETWORK ERROR", error: err.message };
    }
    log(COLORS.red, "FAIL", `Request error: ${err.message}`);
    return { ok: false, verdict: "NETWORK ERROR", error: err.message };
  }
}

/* ════════════════════════════════════════════════════════════════
   STEP 3 — POST /api/upload (lightweight auth check, no file)
   ════════════════════════════════════════════════════════════════ */

async function testUploadEndpoint() {
  divider("STEP 3 — POST /api/upload (lightweight auth check)");

  const url = `${STRAPI_URL}/api/upload`;
  log(COLORS.cyan, "URL", url);

  try {
    const res = await axios.post(
      url,
      {},                                    // empty body — no file sent
      {
        headers: {
          Authorization: `Bearer ${STRAPI_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 15_000,
        validateStatus: () => true,
      }
    );

    printResponse("Response", res.status, res.data);

    if (res.status === 200 || res.status === 201) {
      log(COLORS.green, "PASS", "Upload endpoint accepts the token — auth OK");
      return { ok: true, verdict: "VALID TOKEN", status: res.status };
    }

    if (res.status === 401) {
      log(COLORS.red, "FAIL", "HTTP 401 — token is invalid or revoked");
      return { ok: false, verdict: "INVALID TOKEN", status: res.status };
    }

    if (res.status === 403) {
      log(COLORS.yellow, "WARN", "HTTP 403 — token valid but no upload permission");
      return { ok: false, verdict: "MISSING PERMISSIONS", status: res.status };
    }

    // 400 is expected when sending empty body (no files) — still tells us auth works
    if (res.status === 400) {
      const bodyErr = (res.data?.error?.message || res.data?.message || "").toLowerCase();
      if (bodyErr.includes("auth") || bodyErr.includes("unauthorized") || bodyErr.includes("token")) {
        log(COLORS.red, "FAIL", `HTTP 400 with auth-related message: ${bodyErr}`);
        return { ok: false, verdict: "MISSING PERMISSIONS", status: res.status };
      }
      // 400 because no files — auth likely worked
      log(COLORS.green, "PASS", `HTTP 400 (expected — no file sent) — auth appears OK`);
      return { ok: true, verdict: "VALID TOKEN (upload permission confirmed)", status: res.status };
    }

    log(COLORS.yellow, "WARN", `Unexpected status ${res.status}`);
    return { ok: false, verdict: `UNEXPECTED STATUS ${res.status}`, status: res.status };
  } catch (err) {
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ERR_NETWORK") {
      log(COLORS.red, "FAIL", `Network error — cannot reach Strapi: ${err.message}`);
      return { ok: false, verdict: "NETWORK ERROR", error: err.message };
    }
    log(COLORS.red, "FAIL", `Request error: ${err.message}`);
    return { ok: false, verdict: "NETWORK ERROR", error: err.message };
  }
}

/* ════════════════════════════════════════════════════════════════
   MAIN
   ════════════════════════════════════════════════════════════════ */

(async function main() {
  console.clear();
  console.log(`${COLORS.bold}${COLORS.cyan}╔═══════════════════════════════════════════════════╗`);
  console.log(`║      Strapi API Token Diagnostic Test        ║`);
  console.log(`╚═══════════════════════════════════════════════════╝${COLORS.reset}\n`);

  // ── Step 1: env check ──────────────────────────────────────
  const envOk = checkEnv();
  if (!envOk) {
    divider("RESULT");
    log(COLORS.red, "FAIL", "Cannot proceed — missing environment variables");
    process.exit(1);
  }

  // ── Step 2: GET /api/users/me ──────────────────────────────
  const userMe = await testGetUsersMe();

  if (userMe.ok) {
    divider("FINAL VERDICT");
    log(COLORS.green, "✅", userMe.verdict);
    console.log(`  ${COLORS.bold}User:${COLORS.reset}`, userMe.user?.username || userMe.user?.email || "N/A");
    process.exit(0);
  }

  // ── Step 3: fallback — POST /api/upload ────────────────────
  log(COLORS.yellow, "INFO", "GET /api/users/me did not confirm access — trying POST /api/upload...");

  const upload = await testUploadEndpoint();

  // ── Final verdict ───────────────────────────────────────────
  divider("FINAL VERDICT");

  if (upload.ok) {
    log(COLORS.green, "✅", upload.verdict);
  } else {
    log(COLORS.red, "❌", upload.verdict);
  }

  process.exit(upload.ok ? 0 : 1);
})();
