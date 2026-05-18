#!/usr/bin/env node
/**
 * verify999Api.js — Diagnostic tool for 999.md Partners API integration
 *
 * TESTS ONLY THE MONGODB KEY (the exclusive source of truth used by the bot).
 * The bot uses ctx.session.user.token_999 from MongoDB for all 999.md API calls.
 * This tool does NOT read from .env — MongoDB is the ONLY valid source.
 *
 * Tests:
 *   1. Auth (Basic Auth + masked key logging)
 *   2. GET /cash — check account balance
 *   3. GET /phone_numbers — check verified phone numbers
 *   4. GET /adverts — check existing listings
 *   5. POST /adverts — minimal payload test to reproduce "insufficient balance"
 *   6. GET /features — check required features
 *   7. Detailed request/response logging
 *
 * Usage:
 *   node verify999Api.js
 *
 * Environment:
 *   Reads API key EXCLUSIVELY from MongoDB (users collection, token_999 field)
 */

require("dotenv").config();
const axios = require("axios");
const { MongoClient } = require("mongodb");

const BASE_URL = "https://partners-api.999.md";

// ─── Color helpers ─────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function logSection(title) {
  console.log("\n" + "═".repeat(72));
  console.log(`${BOLD}${CYAN} ${title}${RESET}`);
  console.log("═".repeat(72));
}

function logSub(message) {
  console.log(`  ${GRAY}→${RESET} ${message}`);
}

function logOk(message) {
  console.log(`  ${GREEN}✅${RESET} ${message}`);
}

function logWarn(message) {
  console.log(`  ${YELLOW}⚠️ ${RESET}${message}`);
}

function logErr(message) {
  console.log(`  ${RED}❌${RESET} ${message}`);
}

function logData(label, data) {
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const lines = str.split("\n");
  console.log(`  ${GRAY}── ${label} ──${RESET}`);
  for (const line of lines) {
    console.log(`  ${GRAY}|${RESET} ${line}`);
  }
  console.log(`  ${GRAY}──────────────${RESET}`);
}

/**
 * Mask an API key for safe logging.
 */
function maskKey(key) {
  if (!key || key.length < 12) return "***INVALID-KEY***";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

/**
 * Make an authenticated request with full debug logging.
 */
async function apiCall(method, path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const authUser = options.apiKey;
  const authPass = options.apiPassword || "";

  console.log("");
  logSub(`${BOLD}${method}${RESET} ${url}`);

  if (authUser) {
    logSub(`Auth user (masked): ${maskKey(authUser)}`);
    logSub(`Auth password: ${authPass === "" ? "(empty)" : "(set)"}`);
  } else {
    logWarn("No API key provided!");
  }

  if (options.data) {
    logData("Payload", options.data);
  }

  try {
    const response = await axios({
      method,
      url,
      data: options.data || undefined,
      params: options.params || undefined,
      auth: {
        username: authUser,
        password: authPass,
      },
      headers: options.headers || { "Content-Type": "application/json" },
      timeout: options.timeout || 30000,
      validateStatus: () => true,
    });

    logSub(`Status: ${response.status} ${response.statusText}`);

    const relevantHeaders = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (["content-type", "content-length", "x-request-id", "x-amzn-requestid"].includes(k)) {
        relevantHeaders[k] = v;
      }
    }
    if (Object.keys(relevantHeaders).length > 0) {
      logData("Response Headers", relevantHeaders);
    }

    if (response.data) {
      logData("Response body", response.data);
    }

    return response;
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logErr(`Request timed out after ${options.timeout || 30000}ms`);
    } else if (error.code === "ECONNREFUSED") {
      logErr(`Connection refused: ${error.message}`);
    } else if (error.code === "ENOTFOUND") {
      logErr(`DNS lookup failed: ${error.message}`);
    } else {
      logErr(`Request error: ${error.message}`);
      if (error.stack) {
        const stackLines = error.stack.split("\n").slice(0, 5).join("\n");
        logData("Stack trace (first 5 lines)", stackLines);
      }
    }
    return null;
  }
}

/**
 * Test all endpoints for a given API key.
 */
async function testKey(apiKey, label) {
  const results = {
    auth: false,
    cash: null,
    hasPhone: false,
    postStatus: null,
    postError: null,
  };

  logSection(`Testing Key: ${label} (${maskKey(apiKey)})`);

  // ─── Auth ──────────────────────────────────────────────────────
  logSub("--- Auth: GET /categories ---");
  const authResp = await apiCall("GET", "/categories?lang=ro", { apiKey, timeout: 15000 });
  results.auth = authResp?.status === 200;

  if (!results.auth) {
    logErr(`Auth failed for ${label}. Skipping remaining tests.`);
    return results;
  }
  logOk("Auth OK");

  // ─── Cash ──────────────────────────────────────────────────────
  logSub("--- Balance: GET /cash ---");
  const cashResp = await apiCall("GET", "/cash", { apiKey, timeout: 15000 });
  if (cashResp?.status === 200) {
    results.cash = cashResp.data?.cash;
    if (results.cash > 0) {
      logOk(`Balance: ${results.cash}`);
    } else if (results.cash === 0) {
      logErr(`Balance is ZERO!`);
    }
  } else {
    logErr(`Failed to get cash: ${cashResp?.status}`);
  }

  // ─── Phone Numbers ─────────────────────────────────────────────
  logSub("--- Phone: GET /phone_numbers ---");
  const phoneResp = await apiCall("GET", "/phone_numbers?lang=ro", { apiKey, timeout: 15000 });
  if (phoneResp?.status === 200) {
    const phones = phoneResp.data?.phone_numbers || [];
    results.hasPhone = phones.length > 0;
    logOk(`${phones.length} phone number(s)`);
  }

  // ─── POST /adverts with proper payload ─────────────────────────
  logSub("--- POST /adverts with full payload ---");
  const postPayload = {
    category_id: "270",
    subcategory_id: "1404",
    offer_type: "776",
    features: [
      { id: "795", value: "18894" },           // autor: agentie
      { id: "2", value: 1, unit: "eur" },       // pret (minim)
      { id: "241", value: "13920" },             // 1 camera (option ID for "Apartament cu 1 cameră")
      { id: "244", value: 30, unit: "m2" },      // suprafata
      { id: "852", value: "18897" },             // fond locativ: "Secundar"  
      { id: "248", value: "13894" },             // etaj: "1"
      { id: "249", value: "13899" },             // nr etaje: "1"
      { id: "7", value: "12900" },               // regiune: Chisinau
      { id: "8", value: "13859" },               // localitate: Chisinau
      { id: "9", value: "13907" },               // sector: Centru
      { id: "10", value: "Strada Test" },        // strada
      { id: "11", value: "1" },                   // cladirea
      { id: "12", value: "Test — diagnostic (va rog ignorati)" },
      { id: "13", value: "Test de diagnostic — va rog ignorati." },
      { id: "16", value: ["37376583452"] },      // telefon
      { id: "14", value: [] },                   // imagini (array gol)
    ],
  };

  const postResp = await apiCall("POST", "/adverts", { apiKey, data: postPayload, timeout: 30000 });
  if (postResp) {
    results.postStatus = postResp.status;
    if (postResp.status === 201) {
      logOk("ADVERT CREATED SUCCESSFULLY!");
    } else if (postResp.data?.error === "insufficient balance") {
      results.postError = "insufficient balance";
      logErr("INSUFFICIENT BALANCE error confirmed!");
    } else if (postResp.data?.error) {
      results.postError = postResp.data.error;
      if (typeof postResp.data.error === "object") {
        results.postError = JSON.stringify(postResp.data.error);
      }
    }
  }

  return results;
}

// ================================================================
//  MAIN
// ================================================================

async function main() {
  console.log("");
  console.log(`${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════╗${RESET}`);
  console.log(`${BOLD}${MAGENTA}║      999.md Partners API — Diagnostic Tool v3.0              ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}║      KEY SOURCE: MongoDB ONLY (no .env fallback)             ║${RESET}`);
  console.log(`${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════╝${RESET}`);
  console.log(`  Timestamp: ${new Date().toISOString()}`);
  console.log(`  API Base:  ${BASE_URL}`);

  // ─── STEP 0: Collect API key from MongoDB ONLY ────────────────
  logSection("STEP 0: API Key Collection (MongoDB ONLY)");

  let mongoKey = null;
  let mongoUserInfo = null;

  if (!process.env.MONGO_URL) {
    logErr("MONGO_URL not found in .env — cannot read from MongoDB.");
    logErr("Set MONGO_URL in .env to connect to your MongoDB database.");
    process.exit(1);
  }

  logSub("Reading key from MongoDB (EXCLUSIVE source)...");
  try {
    const client = new MongoClient(process.env.MONGO_URL, {
      tls: true,
      tlsInsecure: true,
      serverSelectionTimeoutMS: 10000,
    });
    await client.connect();
    const db = client.db("users");
    const user = await db.collection("users").findOne(
      { token_999: { $exists: true, $ne: "" } },
      { projection: { token_999: 1, name: 1, telegramChatID: 1 } }
    );
    if (user) {
      mongoKey = user.token_999;
      mongoUserInfo = { name: user.name, chatId: user.telegramChatID };
      logOk(`Key from MongoDB (user: ${user.name || user.telegramChatID}): ${maskKey(mongoKey)}`);
    } else {
      logErr("No user with token_999 found in MongoDB!");
      logErr("The bot requires token_999 to be set in MongoDB (users collection).");
      logErr("Add a token_999 field to a user document in MongoDB manually.");
      logErr("Example: db.users.updateOne({ telegramChatID: \"...\" }, { $set: { token_999: \"YOUR_KEY\" } })");
      process.exit(1);
    }
    await client.close();
  } catch (mongoErr) {
    logErr(`MongoDB read failed: ${mongoErr.message}`);
    process.exit(1);
  }

  // ─── Test the MongoDB key ─────────────────────────────────────
  const keysToTest = [{ key: mongoKey, label: "MONGO_KEY (used by bot)" }];

  const allResults = {};

  for (const { key, label } of keysToTest) {
    allResults[label] = await testKey(key, label);
  }

  // ─── FINAL DIAGNOSTIC SUMMARY ────────────────────────────────
  logSection("═══ DIAGNOSTIC SUMMARY ═══");

  for (const [label, res] of Object.entries(allResults)) {
    console.log("");
    console.log(`  ${BOLD}── ${label} ──${RESET}`);
    console.log(`  Auth:         ${res.auth ? `${GREEN}OK${RESET}` : `${RED}FAIL${RESET}`}`);
    console.log(`  Balance:      ${res.cash !== null ? (res.cash > 0 ? `${GREEN}${res.cash}${RESET}` : `${RED}${res.cash} (ZERO)${RESET}`) : `${RED}UNKNOWN${RESET}`}`);
    console.log(`  Phone:        ${res.hasPhone ? `${GREEN}YES${RESET}` : `${RED}NONE${RESET}`}`);
    console.log(`  POST status:  ${res.postStatus === 201 ? `${GREEN}201 SUCCESS${RESET}` : res.postStatus ? `${RED}${res.postStatus}${RESET}` : `${RED}UNKNOWN${RESET}`}`);
    if (res.postError) {
      console.log(`  POST error:   ${RED}${res.postError}${RESET}`);
    }
  }

  // ─── ROOT CAUSE ANALYSIS ─────────────────────────────────────
  console.log("");
  logSection("═══ ROOT CAUSE ═══");

  const mongoRes = allResults["MONGO_KEY (used by bot)"];
  if (!mongoRes) {
    console.log(`${RED}No test results available.${RESET}`);
  } else {
    if (mongoRes.postError === "insufficient balance") {
      console.log(`${BOLD}${RED}ROOT CAUSE IDENTIFIED:${RESET}`);
      console.log("");
      console.log(`  ${BOLD}Problem:${RESET} The MongoDB API key has insufficient balance.`);
      console.log(`  Balance: ${mongoRes.cash}`);
      console.log("");
      console.log(`  ${BOLD}Fix:${RESET} Top up the account for this key at https://partners-api.999.md`);
    } else if (!mongoRes.auth) {
      console.log(`${BOLD}${RED}ROOT CAUSE:${RESET} Authentication failed.`);
      console.log(`  The MongoDB API key is invalid or expired.`);
      console.log(`  ${BOLD}Fix:${RESET} Update the token_999 field in MongoDB with a valid 999.md Partners API key.`);
    } else {
      console.log(`${GREEN}No critical issues detected.${RESET}`);
    }
  }

  console.log("");
  console.log(`  ${BOLD}Note:${RESET} The bot uses ctx.session.user.token_999 EXCLUSIVELY from MongoDB.`);
  console.log(`  The .env TOKEN_999 variable is IGNORED by the bot for posting.`);
  console.log("");
  console.log(`  ${BOLD}Diagnostic completed.${RESET} Review the detailed logs above.`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n${RED}Fatal error:${RESET}`, err.message);
  console.error(err.stack);
  process.exit(1);
});
