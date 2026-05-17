const axios = require("axios");

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

async function postToMeta(ctx, mediaGroupProcessed = true) {
  const imobilType = getMetaPropertyType(ctx);
  const locationText = getMetaLocation(ctx);
  let desc;

  if (imobilType === "apartments") {
    const serie = getMetaSerie(ctx);
    desc = `In vânzare apartament${serie ? ` seria ${serie}` : ""}, amplasat în ${locationText}.
        Locuința se desfășoară pe o suprafață de ${
          ctx.session.data.area || "N/A"
        } m2, localizat la etajul ${ctx.session.data.floor || "N/A"} din ${
      ctx.session.data.floors || "N/A"
    }, fiind compartimentat în: ${
      ctx.session.data.rooms == 1
        ? "1 cameră"
        : `${ctx.session.data.rooms || "N/A"} camere`
    }, bucătărie,
         ${
           ctx.session.data.bathrooms == 1
             ? "1 bloc sanitar"
             : `${ctx.session.data.bathrooms || "N/A"} blocuri sanitare`
         } și antreu.`;
  } else if (imobilType === "houses") {
    desc = `In vânzare casă, amplasată în ${locationText}.
        Locuința se desfășoară pe o suprafață de ${
          ctx.session.data.area || "N/A"
        } m2, având ${ctx.session.data.floors || "N/A"} nivele, fiind compartimentat în: ${
      ctx.session.data.rooms == 1
        ? "1 cameră"
        : `${ctx.session.data.rooms || "N/A"} camere`
    }, bucătărie,
         ${
           ctx.session.data.bathrooms == 1
             ? "1 bloc sanitar"
             : `${ctx.session.data.bathrooms || "N/A"} blocuri sanitare`
         }.`;
  } else if (imobilType === "commercials") {
    const destination = ctx.session.data.commercial_destination?.ro || ctx.session.data.commercial_destination || "spațiu comercial";
    desc = `In vânzare ${destination}, amplasat în ${locationText}.
      Se desfășoară pe o suprafață de ${ctx.session.data.area || "N/A"} m2.`;
  } else if (imobilType === "terrains") {
    const destination = ctx.session.data.terrain_destination?.ro || ctx.session.data.terrain_destination || "lot de pamant";
    desc = `In vânzare ${destination}, amplasat în ${locationText}. Se desfășoară pe o suprafață de ${ctx.session.data.area || "N/A"} m2.`;
  } else {
    // Fallback description
    desc = `In vânzare proprietate imobiliară, amplasată în ${locationText}.`;
  }
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
    await ctx.reply("Postarea valabila pe Facebook.");
    console.log("Successfully posted on Facebook!", retValueFB.data.id);
    await ctx.reply("Postarea pe Instagram in executie...");
    retValue.fb = retValueFB.data.id;
    // Instagram posting
    const instagramAccountResponse = await axios.get(
      `${graph}/${ctx.session.user.fb_page_id}?fields=instagram_business_account`,
      {
        headers: {
          Authorization: `Bearer ${ctx.session.user.fb_acces_token}`,
        },
      }
    );

    if (!instagramAccountResponse.data.instagram_business_account) {
      console.log("Instagram Business Account not found for this page.");
      return;
    }

    const instagramId =
      instagramAccountResponse.data.instagram_business_account.id;
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
    retValue.inst = retValInst.data.id;
    console.log(
      "The media has been published on Instagram successfully!",
      retValInst.data.id
    );
    await ctx.reply("Postarea valabila pe Instagram.");
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
