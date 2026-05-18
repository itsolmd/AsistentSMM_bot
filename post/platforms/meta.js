const axios = require("axios");
const { getCollection } = require("../../db");

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
 * Extract apartment series string from session data,
 * supporting both Premier format ({serie: "..."}) and
 * 999.md scraper format (plain string in .serie or .apartament_sery).
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
   * "Construcţii noi", "Bloc nou", "nou" → "nou"
   * "secundar", "vechi", "existent" → "secundar"
   */
  const normalizeBuilding = (building) => {
    if (!building) return null;
    if (/nou/i.test(building)) return 'nou';
    return 'secundar';
  };

  let lines = [];

  // Title line
  lines.push(`În vânzare ${titleType}...`);

  // Location with full address (no "Locație:" label)
  const locationParts = [locationText];
  if (addressLine) locationParts.push(addressLine);
  lines.push(`📍 ${locationParts.join(', ')}`);

  // Price
  lines.push(`💰 Preț: ${price}`);

  // Property-specific details (no Serie, no Băi, no contact, no ID on Facebook)
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

  // ── Contact phone ────────────────────────────────────────────
  // Priority: 1) direct MongoDB query (phoneFromDb), 2) session user, 3) scraped ad data
  const phone = phoneFromDb || ctx.session.user?.phoneNr || ctx.session.data?.phoneNr || '';
  const userName = ctx.session.user?.name || '';
  const firstName = userName ? userName.split(' ')[0] : '';
  if (phone) {
    const phoneDisplay = phone.startsWith('+') ? phone : `+${phone}`;
    lines.push(`📞 ${phoneDisplay} (WhatsApp/Viber) - ${firstName}`);
  }

  // ── DB ID from advertisement (e.g. 🆔DB_Ap101739166) ──────
  // Priority:
  //   1. advertId (set by 999.md scraper as "DB_Ap...")
  //   2. data.id (Strapi/Premier document ID)
  //   3. data._id (raw MongoDB ObjectId)
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

async function postToMeta(ctx, mediaGroupProcessed = true) {
  // ── Fetch phone number directly from MongoDB ─────────────────
  let phoneFromDb = '';
  try {
    const usersCollection = await getCollection("users");
    const mongoUser = await usersCollection.findOne(
      { telegramChatID: ctx.chat.id.toString() },
      { projection: { phoneNr: 1 } }
    );
    if (mongoUser?.phoneNr) {
      phoneFromDb = mongoUser.phoneNr;
      console.log('[postToMeta] 📞 Phone fetched from MongoDB:', phoneFromDb);
    }
  } catch (err) {
    console.warn('[postToMeta] ⚠️ Could not fetch phone from MongoDB, falling back to session:', err.message);
  }

  const desc = buildMetaDescription(ctx, phoneFromDb);
  try {
    const graph = `https://graph.facebook.com/v21.0`;
    const pagesResponse = await axios.get(`${graph}/me/accounts`, {
      headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` },
    });
    const retValue = {};
    let pageAccessToken = null;
    for (const page of pagesResponse.data.data) {
      console.log(page);
      if (page.id === ctx.session.user.fb_page_id) {
        pageAccessToken = page.access_token;
        break;
      }
    }
    if (!pageAccessToken) {
      return "facebook doesnt posted";
    }

    // ── Pre-check Instagram availability BEFORE posting ─────────
    let instagramId = null;
    try {
      const instagramAccountResponse = await axios.get(
        `${graph}/${ctx.session.user.fb_page_id}?fields=instagram_business_account`,
        {
          headers: {
            Authorization: `Bearer ${ctx.session.user.fb_acces_token}`,
          },
        }
      );
      if (instagramAccountResponse.data.instagram_business_account?.id) {
        instagramId = instagramAccountResponse.data.instagram_business_account.id;
      }
    } catch (instErr) {
      console.warn('[postToMeta] ⚠️ Instagram check failed:', instErr.response?.data || instErr.message);
      // Non-fatal: proceed without Instagram
    }

    if (instagramId) {
      console.log('[postToMeta] ✅ Instagram Business Account found:', instagramId);
    } else {
      console.log('[postToMeta] ℹ️ No Instagram Business Account linked — Instagram will be skipped.');
    }

    const pageGraph = `${graph}/${ctx.session.user.fb_page_id}`;
    const photoIds = [];
    // Support both string URLs and { url } objects
    const imagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];
    for (const image of imagesToUpload) {
      const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
      if (!imageUrl) {
        console.warn('[postToMeta] Skipping invalid image:', image);
        continue;
      }
      const photoUpload = await axios.post(
        `${pageGraph}/photos`,
        { url: imageUrl, published: false },
        { headers: { Authorization: `Bearer ${pageAccessToken}` } }
      );
      photoIds.push(photoUpload.data.id);
    }

    const params = {
      message: `${desc}`,
      published: true,
    };
    if (photoIds.length > 0) {
      params.attached_media = [];
    }
    photoIds.forEach((photoId, index) => {
      params.attached_media.push(
        JSON.stringify({
          media_fbid: photoId,
        })
      );
    });
    console.log(params);

    // Publish post to Facebook
    const retValueFB = await axios.post(`${pageGraph}/feed`, params, {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
    });
    const fbPostId = retValueFB.data.id;
    const fbPostLink = `https://www.facebook.com/${ctx.session.user.fb_page_id}/posts/${fbPostId}`;
    await ctx.reply(`✅ Postarea pe Facebook: ${fbPostLink}`);
    console.log("Successfully posted on Facebook!", fbPostId);
    retValue.fb = fbPostLink;

    // ── Gracefully skip Instagram if no Business Account linked ─
    if (!instagramId) {
      await ctx.reply('ℹ️ Postarea pe Instagram a fost omisă — pagina Facebook nu are un cont Instagram de business conectat. Pentru a publica pe Instagram, conectați un cont Instagram de business în setările paginii Facebook.');
      retValue.inst = null;
      return retValue;
    }

    await ctx.reply("Postarea pe Instagram in executie...");
    const instContainersIds = [];

    // Create media containers for Instagram
    const instImagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];
    for (const image of instImagesToUpload) {
      const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
      if (!imageUrl) {
        console.warn('[postToMeta] Skipping invalid Instagram image:', image);
        continue;
      }
      const mediaContainer = await axios.post(
        `${graph}/${instagramId}/media`,
        {
          image_url: imageUrl,
          caption: `${desc}`,
          is_carousel_item: mediaGroupProcessed,
        },
        {
          headers: {
            Authorization: `Bearer ${ctx.session.user.fb_acces_token}`,
          },
        }
      );
      instContainersIds.push(mediaContainer.data.id);
    }

    // Create and publish carousel or single post on Instagram
    let instContainerId;
    if (mediaGroupProcessed) {
      const carouselContainer = await axios.post(
        `${graph}/${instagramId}/media`,
        {
          media_type: "CAROUSEL",
          caption: `${desc}`,
          children: instContainersIds.join(","),
        },
        {
          headers: {
            Authorization: `Bearer ${ctx.session.user.fb_acces_token}`,
          },
        }
      );
      instContainerId = carouselContainer.data.id;
    } else {
      instContainerId = instContainersIds[0];
    }

    // Publish Instagram post
    const retValInst = await axios.post(
      `${graph}/${instagramId}/media_publish`,
      { creation_id: instContainerId },
      {
        headers: {
          Authorization: `Bearer ${ctx.session.user.fb_acces_token}`,
        },
      }
    );
    const instMediaId = retValInst.data.id;
    console.log(
      "The media has been published on Instagram successfully!",
      instMediaId
    );
    // Fetch Instagram permalink
    let instPostLink = '#';
    try {
      const instMediaResp = await axios.get(`${graph}/${instMediaId}`, {
        params: { fields: 'permalink' },
        headers: { Authorization: `Bearer ${ctx.session.user.fb_acces_token}` },
      });
      instPostLink = instMediaResp.data.permalink;
    } catch (permalinkErr) {
      console.warn('[postToMeta] Could not fetch Instagram permalink:', permalinkErr.message);
      // Fallback: construct URL from media ID
      instPostLink = `https://www.instagram.com/p/${instMediaId}/`;
    }
    await ctx.reply(`✅ Postarea pe Instagram: ${instPostLink}`);
    retValue.inst = instPostLink;
    return retValue;
  } catch (error) {
    console.error("An error occurred:", error.response?.data || error.message);
    // Check for Facebook token expiration/invalidation
    const fbError = error.response?.data?.error;
    if (fbError?.code === 190) {
      console.error('[postToMeta] ❌ Facebook token expired or invalidated. User needs to re-authenticate.');
      // Try to use env fallback token if user's token failed
      try {
        if (process.env.FB_ACCES_TOKEN) {
          console.log('[postToMeta] Attempting fallback with env FB_ACCES_TOKEN...');
          ctx.session.user.fb_acces_token = process.env.FB_ACCES_TOKEN;
          return await postToMeta(ctx, mediaGroupProcessed);
        }
      } catch (fallbackErr) {
        console.error('[postToMeta] ❌ Fallback token also failed:', fallbackErr.message);
        await ctx.reply('❌ Token-ul Facebook a expirat. Trebuie să reautentificați contul Facebook. Contactați administratorul.');
      }
      await ctx.reply('❌ Token-ul Facebook a expirat sau a fost invalidat. Conectați-vă din nou la Facebook.');
    } else {
      await ctx.reply('❌ A apărut o eroare la postarea pe Facebook/Instagram. Verificați token-ul și încercați din nou.');
    }
    return {};
  }
}

module.exports = { postToMeta };
