#!/usr/bin/env node
/**
 * fix999Key.js — Check 999.md API keys in MongoDB
 *
 * Reads the 999 API key EXCLUSIVELY from MongoDB (the source of truth used by the bot).
 * The bot uses ctx.session.user.token_999 from MongoDB for all 999.md API calls.
 * The .env TOKEN_999 variable is IGNORED by the bot — only MongoDB matters.
 *
 * If no token_999 is found in MongoDB, the bot cannot post to 999.md.
 * Add token_999 manually to the user document in MongoDB.
 *
 * Usage:
 *   node fix999Key.js
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URL = process.env.MONGO_URL;

async function main() {
  if (!MONGO_URL) {
    console.error("❌ MONGO_URL not found in .env");
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  999.md API Key Check — Reads key from MongoDB ONLY    ║");
  console.log("║  The .env TOKEN_999 is IGNORED by the bot              ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");

  const client = new MongoClient(MONGO_URL, {
    tls: true,
    tlsInsecure: true,
    serverSelectionTimeoutMS: 15000,
  });

  await client.connect();
  const db = client.db("users");
  const users = db.collection("users");

  // ── STEP 1: Fetch ALL users with a token_999 field from MongoDB ──
  console.log("  🔍 Searching for users with token_999 in MongoDB...\n");

  const mongoUsers = await users.find(
    { token_999: { $exists: true, $ne: "" } },
    { projection: { _id: 1, name: 1, token_999: 1, telegramChatID: 1 } }
  ).toArray();

  if (mongoUsers.length === 0) {
    console.log("  ❌ No users with token_999 found in MongoDB.");
    console.log("");
    console.log("  ⚠️  The bot CANNOT post to 999.md without a valid token_999 in MongoDB.");
    console.log("");
    console.log("  💡 Add a token_999 field to a user document:");
    console.log("     db.users.updateOne(");
    console.log('       { telegramChatID: "USER_CHAT_ID" },');
    console.log('       { $set: { token_999: "YOUR_999_API_KEY" } }');
    console.log("     )");
    console.log("");
    console.log("  Or use MongoDB Compass to add the field manually.");
    await client.close();
    return;
  }

  console.log(`  Found ${mongoUsers.length} user(s) with token_999 in MongoDB:\n`);

  // ── STEP 2: Display all keys found in MongoDB ──
  const allKeys = [];
  for (const user of mongoUsers) {
    const masked = user.token_999
      ? user.token_999.slice(0, 4) + "****" + user.token_999.slice(-4)
      : "***NONE***";
    console.log(`  📋 User: ${user.name || "unnamed"} (chat: ${user.telegramChatID || "N/A"})`);
    console.log(`     Key:  ${masked}`);
    if (!allKeys.includes(user.token_999)) {
      allKeys.push(user.token_999);
    }
  }

  console.log("");
  console.log(`  🔑 Unique key(s) in MongoDB: ${allKeys.length}`);

  if (allKeys.length > 1) {
    console.log("");
    console.log("  ⚠️  Multiple different keys found in MongoDB.");
    console.log("     Each user may have a different 999.md account.");
    console.log("     Verify each account has sufficient balance.");
  }

  console.log("");
  console.log("  ✅ The bot uses ctx.session.user.token_999 from");
  console.log("     MongoDB EXCLUSIVELY for all 999.md API calls.");
  console.log("");
  console.log("  ℹ️  The .env TOKEN_999 variable is NOT used by the bot.");
  console.log("     Only the token_999 field in MongoDB matters.");
  console.log("");

  await client.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
