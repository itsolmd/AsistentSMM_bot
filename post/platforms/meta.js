const axios = require("axios");
const { getCollection } = require("../../db");
const {
  generateContentHash,
  checkDuplicatePost,
  savePostedRecord,
  cleanupDuplicatePosts,
} = require("../../services/deduplicator");
const { askAIWhatToDo } = require("../../services/errorResolver");

// ── Sleep helper ───────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract a human-readable location string from session data,
 * supporting both Premier format ({suburb.ro, sector.ro}) and
 * 999.md scraper format ({parsedLocation}).
 */
function getMetaLocation(ctx) {
  // Premier format: suburb/sector objects with .ro
  if (ctx.session.data.suburb?.ro) return ctx.session.data.suburb.ro;
  if (ctx.session.data.sector?.ro) return ctx.session.data.sector.ro;
  // 999.md scraper format: parsedLocation
  if (ctx.session.data.parsedLocation) {
    const p = ctx.session.data.parsedLocation;
    const parts = [p.city, p.sector].filter(Boolean);
    return parts.join(', ') || 'Chișinău';
  }
  // Fallback
  return 'Chișinău';
}

/**
 * Determine property type from session data,
 * supporting both Premier format (ctx.session.imobilType) and
 * 999.md scraper format (ctx.session.data.type).
 */
function getMetaPropertyType(ctx) {
  // Premier sets imobilType directly
  if (ctx.session.imobilType) return ctx.session.imobilType;
  // 999.md scraper stores type as a display string
  const typeMap = {
    'Apartament': 'apartments',
    'Casă': 'houses',
    'Comercial': 'commercials',
    'Teren': 'terrains',
  };
  const rawType = ctx.session.data?.type;
  if (rawType && typeMap[rawType]) return typeMap[rawType];
  // Fallback: try to detect from data fields
  if (ctx.session.data?.rooms != null) return 'apartments';
  if (ctx.session.data?.house_type) return 'houses';
  if (ctx.session.data?.commercial_destination) return 'commercials';
  if (ctx.session.data?.terrain_destination) return 'terrains';
  return 'apartments'; // safest default
}

/**
 * Extract apartment series string from session data.
 */
function getMetaSerie(ctx) {
  const raw = ctx.session.data?.apartament_sery;
  if (!raw) return ctx.session.data?.serie || null;
  if (typeof raw === 'string') return raw;
  if (raw?.serie) return raw.serie;
  return null;
}

/**
 * Build a clean address line for Meta posts (street-level detail).
 */
function getMetaAddressLine(ctx) {
  const p = ctx.session.data.parsedLocation;
  if (!p) return null;
  const parts = [];
  if (p.street) parts.push(p.street);
  if (p.streetNumber) parts.push(p.streetNumber);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Build a structured, emoji-formatted description for Meta (FB/IG) posts.
 */
function buildMetaDescription(ctx, phoneFromDb = '') {
  const imobilType = getMetaPropertyType(ctx);
  const locationText = getMetaLocation(ctx);
  const addressLine = getMetaAddressLine(ctx);
  const data = ctx.session.data;
  const price = data.price ? `${data.price} €` : 'N/A';

  // Map property type slug to Romanian display name for title
  const typeTitleMap = {
    'apartments': 'Apartament',
    'houses': 'Casă',
    'commercials': 'Spațiu comercial',
    'terrains': 'Teren',
  };
  const titleType = typeTitleMap[imobilType] || 'Imobil';

  /**
   * Normalize building type to simple "nou" or "secundar".
   */
  const normalizeBuilding = (building) => {
    if (!building) return null;
    if (/nou/i.test(building)) return 'nou';
    return 'secundar';
  };

  let lines = [];

  // Title line
  lines.push(`În vânzare ${titleType}...`);

  // Location with full address
  const locationParts = [locationText];
  if (addressLine) locationParts.push(addressLine);
  lines.push(`📍 ${locationParts.join(', ')}`);

  // Price
  lines.push(`💰 Preț: ${price}`);

  // Property-specific details
  if (imobilType === "apartments") {
    lines.push(`🛏️ Dormitoare: ${data.rooms || 'N/A'}`);
    lines.push(`📐 Suprafață: ${data.area || 'N/A'} m²`);
    lines.push(`🏢 Etaj: ${data.floor || 'N/A'}/${data.floors || 'N/A'}`);
    const building = data.building ? normalizeBuilding(data.building) : null;
    if (building) lines.push(`🏗️ Bloc: ${building}`);
  } else if (imobilType === "houses") {
    lines.push(`🛏️ Dormitoare: ${data.rooms || 'N/A'}`);
    lines.push(`📐 Suprafață: ${data.area || 'N/A'} m²`);
    lines.push(`📐 Nivele: ${data.floors || 'N/A'}`);
  } else if (imobilType === "commercials") {
    const destination = data.commercial_destination?.ro || data.commercial_destination || 'Spațiu comercial';
    lines.push(`🏢 Tip: ${destination}`);
    lines.push(`📐 Suprafață: ${data.area || 'N/A'} m²`);
  } else if (imobilType === "terrains") {
    const destination = data.terrain_destination?.ro || data.terrain_destination || 'Lot de teren';
    lines.push(`🌿 Tip: ${destination}`);
    lines.push(`📐 Suprafață: ${data.area || 'N/A'} m²`);
  }

  // ── Contact phone ──
  const phone = phoneFromDb || ctx.session.user?.phoneNr || ctx.session.data?.phoneNr || '';
  const userName = ctx.session.user?.name || '';
  const firstName = userName ? userName.split(' ')[0] : '';
  if (phone) {
    const phoneDisplay = phone.startsWith('+') ? phone : `+${phone}`;
    lines.push(`📞 ${phoneDisplay} (WhatsApp/Viber) - ${firstName}`);
  }

  // ── DB ID from advertisement ──
  let advertId = ctx.session.data?.advertId;
  if (!advertId && ctx.session.data?.id) {
    advertId = `DB_Ap${ctx.session.data.id}`;
  }
  if (!advertId && ctx.session.data?._id) {
    advertId = `DB_${String(ctx.session.data._id)}`;
  }
  if (advertId && advertId !== 'N/A') {
    lines.push(`🆔${advertId}`);
  }

  return lines.join('\n');
}

/**
 * refreshFacebookToken(ctx)
 *
 * Attempts to re-authenticate the Facebook token.
 * Strategy:
 *   1. Try env fallback FB_ACCES_TOKEN
 *   2. If that fails, inform user to re-authenticate
 *
 * @param {Object} ctx - Telegram session context
 * @returns {Promise<boolean>} - true if token was refreshed
 */
async function refreshFacebookToken(ctx) {
  // Try 1: Environment fallback token
  if (process.env.FB_ACCES_TOKEN) {
    console.log('[refreshFacebookToken] 🔄 Trying env FB_ACCES_TOKEN fallback...');
    ctx.session.user.fb_acces_token = process.env.FB_ACCES_TOKEN;

    // Verify the fallback token works
    try {
      const graph = `https://graph.facebook.com/v21.0`;
      const verifyResp = await axios.get(`${graph}/me/accounts`, {
        headers: { Authorization: `Bearer ${process.env.FB_ACCES_TOKEN}` },
        timeout: 10000,
      });
      if (verifyResp.data?.data) {
        console.log('[refreshFacebookToken] ✅ Env fallback token verified successfully');
        return true;
      }
    } catch (verifyErr) {
      console.warn('[refreshFacebookToken] ❌ Env fallback token also invalid:', verifyErr.response?.data?.error?.message || verifyErr.message);
    }
  }

  // Try 2: Ask user to re-authenticate (we can't do this automatically)
  // But we DON'T interrupt the process — just log and return false
  console.log('[refreshFacebookToken] ❌ Cannot refresh token automatically. User needs to re-authenticate via Facebook.');
  return false;
}

/**
 * postWithIntelligentRetry(postFn, ctx, contentData, platform, maxRetries)
 *
 * Generic intelligent retry wrapper for posting to any platform.
 * Handles:
 *   - Token expiration (error 190) → auto-refresh
 *   - Rate limiting → progressive waits
 *   - Other errors → exponential backoff
 *   - After maxRetries → AI fallback for decision
 *   - NEVER throws — always returns { success, result } or { success: false, error, skipped }
 *
 * @param {Function} postFn - Async function that performs the actual post
 * @param {Object} ctx - Telegram session context
 * @param {Object} contentData - Data being posted
 * @param {string} platform - Platform name
 * @param {number} maxRetries - Maximum retry attempts (default: 10)
 * @returns {Promise<Object>} - Result object
 */
async function postWithIntelligentRetry(postFn, ctx, contentData, platform, maxRetries = 10) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    attempt++;
    console.log(`[${platform}] 🔄 Attempt ${attempt}/${maxRetries}...`);

    try {
      const result = await postFn(ctx, contentData);
      console.log(`[${platform}] ✅ Posted successfully on attempt ${attempt}`);
      return { success: true, result };
    } catch (error) {
      lastError = error;
      const fbError = error.response?.data?.error;
      const errorCode = fbError?.code || error.code || error.response?.status;
      const errorMsg = fbError?.message || error.message || String(error);

      console.error(`[${platform}] ❌ Attempt ${attempt} failed:`, errorMsg.slice(0, 200));

      // ── Token expired (error 190) → refresh and retry immediately ──
      if (errorCode === 190 || errorMsg.includes("token") || errorMsg.includes("access token")) {
        console.log(`[${platform}] 🔄 Token issue detected — attempting refresh...`);
        const refreshed = await refreshFacebookToken(ctx);
        if (refreshed) {
          continue; // reîncearcă imediat cu token nou, NU aștepta
        }
        // Token refresh failed — try fallback then skip
        console.log(`[${platform}] ⚠️ Token refresh failed — trying fallback...`);
        continue;
      }

      // ── Rate limit → wait progressively ──
      if (errorMsg.includes("rate limit") || errorCode === 429) {
        const waitMs = attempt * 10000; // 10s, 20s, 30s...
        console.log(`[${platform}] ⏳ Rate limit — waiting ${waitMs / 1000}s...`);
        await sleep(waitMs);
        continue;
      }

      // ── Other errors → exponential backoff ──
      const waitTime = Math.min(1000 * Math.pow(2, attempt), 60000);
      console.log(`[${platform}] ⏳ Waiting ${waitTime / 1000}s before retry...`);
      await sleep(waitTime);
    }
  }

  // ── After maxRetries, ask AI what to do ──
  console.log(`[${platform}] 🤖 All ${maxRetries} attempts failed — consulting AI...`);
  try {
    const aiDecision = await askAIWhatToDo(
      lastError,
      { platform, contentPreview: JSON.stringify(contentData).slice(0, 300) },
      platform
    );

    console.log(`[${platform}] 🤖 AI decision: ${aiDecision.action} — ${aiDecision.suggestion}`);

    if (aiDecision.action === "retry" || aiDecision.action === "retry_with_new_token") {
      // If AI says retry with new token, refresh and retry (up to 5 more times)
      if (aiDecision.action === "retry_with_new_token") {
        await refreshFacebookToken(ctx);
      }
      // Retry with lower max (AI-specified count)
      return postWithIntelligentRetry(postFn, ctx, contentData, platform, aiDecision.retry_count || 5);
    }

    // For skip/wait/escalate, return the error with AI suggestion
    return {
      success: false,
      error: lastError,
      skipped: true,
      aiSuggestion: aiDecision.suggestion,
      action: aiDecision.action,
    };
  } catch (aiErr) {
    // Even AI failed — log and skip
    console.error(`[${platform}] ❌ AI consultation also failed:`, aiErr.message);
    return {
      success: false,
      error: lastError,
      skipped: true,
      aiSuggestion: "AI could not be consulted. Skipping to next post.",
    };
  }
}

/**
 * performMetaPost(ctx, contentData)
 *
 * The actual posting logic (extracted so it can be retried).
 * Called by postWithIntelligentRetry.
 *
 * @param {Object} ctx - Telegram session context
 * @param {Object} contentData - Unused (data comes from ctx.session)
 * @returns {Promise<Object>} - { fb, inst } links
 */
async function performMetaPost(ctx, contentData = {}) {
  // ── Fetch phone number directly from MongoDB ──
  let phoneFromDb = '';
  try {
    const usersCollection = await getCollection("users");
    const mongoUser = await usersCollection.findOne(
      { telegramChatID: ctx.chat.id.toString() },
      { projection: { phoneNr: 1 } }
    );
    if (mongoUser?.phoneNr) {
      phoneFromDb = mongoUser.phoneNr;
      console.log('[performMetaPost] 📞 Phone fetched from MongoDB:', phoneFromDb);
    }
  } catch (err) {
    console.warn('[performMetaPost] ⚠️ Could not fetch phone from MongoDB, falling back to session:', err.message);
  }

  const desc = buildMetaDescription(ctx, phoneFromDb);
  const graph = `https://graph.facebook.com/v21.0`;

  const pagesResponse = await axios.get(`${graph}/me/accounts`, {
    headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` },
  });

  let pageAccessToken = null;
  for (const page of pagesResponse.data.data) {
    if (page.id === ctx.session.user.fb_page_id) {
      pageAccessToken = page.access_token;
      break;
    }
  }
  if (!pageAccessToken) {
    throw new Error("No page access token found for page ID: " + ctx.session.user.fb_page_id);
  }

  // ── Pre-check Instagram availability ──
  let instagramId = null;
  try {
    const instagramAccountResponse = await axios.get(
      `${graph}/${ctx.session.user.fb_page_id}?fields=instagram_business_account`,
      {
        headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` },
      }
    );
    if (instagramAccountResponse.data.instagram_business_account?.id) {
      instagramId = instagramAccountResponse.data.instagram_business_account.id;
    }
  } catch (instErr) {
    console.warn('[performMetaPost] ⚠️ Instagram check failed:', instErr.response?.data || instErr.message);
  }

  if (instagramId) {
    console.log('[performMetaPost] ✅ Instagram Business Account found:', instagramId);
  } else {
    console.log('[performMetaPost] ℹ️ No Instagram Business Account linked.');
  }

  const pageGraph = `${graph}/${ctx.session.user.fb_page_id}`;
  const photoIds = [];

  // Upload images
  const imagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];
  for (const image of imagesToUpload) {
    const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
    if (!imageUrl) {
      console.warn('[performMetaPost] Skipping invalid image:', image);
      continue;
    }
    const photoUpload = await axios.post(
      `${pageGraph}/photos`,
      { url: imageUrl, published: false },
      { headers: { Authorization: `Bearer ${pageAccessToken}` } }
    );
    photoIds.push(photoUpload.data.id);
  }

  // Build feed params
  const params = {
    message: `${desc}`,
    published: true,
  };
  if (photoIds.length > 0) {
    params.attached_media = photoIds.map((photoId) =>
      JSON.stringify({ media_fbid: photoId })
    );
  }

  // Publish to Facebook
  const retValueFB = await axios.post(`${pageGraph}/feed`, params, {
    headers: { Authorization: `Bearer ${pageAccessToken}` },
  });
  const fbPostId = retValueFB.data.id;
  const fbPostLink = `https://www.facebook.com/${ctx.session.user.fb_page_id}/posts/${fbPostId}`;

  const retValue = { fb: fbPostLink, inst: null };

  // ── Save posted record to MongoDB (deduplication) ──
  try {
    const contentHash = generateContentHash(ctx.session.data);
    if (contentHash) {
      await savePostedRecord({
        postId: fbPostId,
        contentHash,
        platform: "facebook",
        link: fbPostLink,
        metadata: {
          propertyType: getMetaPropertyType(ctx),
          price: ctx.session.data?.price,
          location: getMetaLocation(ctx),
        },
      });
    }
  } catch (saveErr) {
    console.warn('[performMetaPost] ⚠️ Could not save posted record:', saveErr.message);
  }

  // Nu trimitem ctx.reply aici — postRouter se ocupă de mesajul final
  // cu toate link-urile (FB + IG)
  console.log("Successfully posted on Facebook!", fbPostId);

  // ── Instagram posting ──
  if (!instagramId) {
    await ctx.reply('ℹ️ Postarea pe Instagram a fost omisă — pagina Facebook nu are un cont Instagram de business conectat.');
    return retValue;
  }

  await ctx.reply("Postarea pe Instagram in executie...");
  const instContainersIds = [];

  const instImagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];
  for (const image of instImagesToUpload) {
    const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
    if (!imageUrl) {
      console.warn('[performMetaPost] Skipping invalid Instagram image:', image);
      continue;
    }
    const mediaContainer = await axios.post(
      `${graph}/${instagramId}/media`,
      {
        image_url: imageUrl,
        caption: `${desc}`,
        is_carousel_item: true,
      },
      { headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` } }
    );
    instContainersIds.push(mediaContainer.data.id);
  }

  // Create carousel
  const carouselContainer = await axios.post(
    `${graph}/${instagramId}/media`,
    {
      media_type: "CAROUSEL",
      caption: `${desc}`,
      children: instContainersIds.join(","),
    },
    { headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` } }
  );

  // Publish
  const retValInst = await axios.post(
    `${graph}/${instagramId}/media_publish`,
    { creation_id: carouselContainer.data.id },
    { headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` } }
  );
  const instMediaId = retValInst.data.id;
  console.log("Instagram published successfully!", instMediaId);

  // Fetch permalink
  let instPostLink = '#';
  try {
    const instMediaResp = await axios.get(`${graph}/${instMediaId}`, {
      params: { fields: 'permalink' },
      headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` },
    });
    instPostLink = instMediaResp.data.permalink;
  } catch (permalinkErr) {
    console.warn('[performMetaPost] Could not fetch Instagram permalink:', permalinkErr.message);
    instPostLink = `https://www.instagram.com/p/${instMediaId}/`;
  }

  // ── Save Instagram posted record ──
  try {
    const contentHash = generateContentHash(ctx.session.data);
    if (contentHash) {
      await savePostedRecord({
        postId: instMediaId,
        contentHash,
        platform: "instagram",
        link: instPostLink,
        metadata: {
          propertyType: getMetaPropertyType(ctx),
          price: ctx.session.data?.price,
        },
      });
    }
  } catch (saveErr) {
    console.warn('[performMetaPost] ⚠️ Could not save Instagram posted record:', saveErr.message);
  }

  await ctx.reply(`✅ Postarea pe Instagram: ${instPostLink}`);
  retValue.inst = instPostLink;
  return retValue;
}

/**
 * postToMeta(ctx, mediaGroupProcessed, isRetry)
 *
 * Enhanced posting function with:
 *   - Duplicate checking before posting
 *   - Intelligent retry with exponential backoff
 *   - Token refresh on error 190
 *   - AI fallback for unknown errors
 *   - NEVER throws — always returns gracefully
 */
async function postToMeta(ctx, mediaGroupProcessed = true, isRetry = false) {
  try {
    // ── STEP 1: Check for duplicate content ──
    // Verifică DUPĂ publicare dacă postarea există deja
    const contentHash = generateContentHash(ctx.session.data);

    if (contentHash) {
      const existingFB = await checkDuplicatePost(contentHash, "facebook");
      if (existingFB) {
        console.log(`[postToMeta] ⛔ Duplicate Facebook post detected. Last posted at ${existingFB.timestamp}. Skipping.`);
        await ctx.reply(`⛔ Acest conținut a fost deja publicat pe Facebook acum. Link: ${existingFB.link || 'N/A'}`);
        // Dar tot încercăm Instagram dacă nu a fost postat acolo
        const existingIG = await checkDuplicatePost(contentHash, "instagram");
        if (existingIG) {
          console.log(`[postToMeta] ⛔ Duplicate Instagram post detected too. Skipping entirely.`);
          return { fb: existingFB.link, inst: existingIG.link, skipped: true };
        }
      }
    }

    // ── STEP 2: Post with intelligent retry ──
    const result = await postWithIntelligentRetry(
      performMetaPost,
      ctx,
      ctx.session.data,
      "facebook",
      3 // Maxim 3 încercări principale (token refresh count ca reîncercări suplimentare)
    );

    if (result.success) {
      return result.result;
    }

    // ── STEP 3: If all retries failed, log but DON'T interrupt ──
    console.error('[postToMeta] ❌ All posting attempts failed:', result.error?.message || 'Unknown error');
    console.error('[postToMeta] AI suggestion:', result.aiSuggestion);

    await ctx.reply(
      `⚠️ Postarea pe Facebook nu a reușit după mai multe încercări.\n` +
      `Sugestie: ${result.aiSuggestion || 'Încercați din nou mai târziu.'}\n` +
      `Procesul continuă cu alte platforme.`
    );

    return { fb: null, inst: null, error: result.error?.message || 'All retries failed' };
  } catch (error) {
    // ── ULTIMUL NIVEL DE SIGURANȚĂ: NICIODATĂ să nu oprească procesul ──
    console.error('[postToMeta] ❌ CATASTROPHIC ERROR (but process continues):', error.message);
    console.error(error.stack);

    try {
      await ctx.reply('⚠️ A apărut o eroare neașteptată la postarea pe Facebook. Procesul continuă cu alte operațiuni.');
    } catch (replyErr) {
      console.error('[postToMeta] ❌ Could not even send error message:', replyErr.message);
    }

    return { fb: null, inst: null, error: error.message };
  }
}

module.exports = { postToMeta };
