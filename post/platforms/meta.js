const axios = require("axios");
async function postToMeta(ctx, mediaGroupProcessed = true) {
  let desc;
  if (ctx.session.imobilType === "apartments") {
    desc = `In vânzare apartament ${
      ctx.session.data.apartament_sery
        ? `seria ${ctx.session.data.apartament_sery.serie}`
        : ""
    }, amplasat în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }. 
        Locuința se desfășoară pe o suprafață de ${
          ctx.session.data.area
        } m2, localizat la etajul ${ctx.session.data.floor} din ${
      ctx.session.data.floors
    }, fiind compartimentat în: ${
      ctx.session.data.rooms === 1
        ? "1 cameră"
        : `${ctx.session.data.rooms} camere`
    }, bucătărie,
         ${
           ctx.session.data.bathrooms === 1
             ? "1 bloc sanitar"
             : `${ctx.session.data.bathrooms} blocuri sanitare`
         } și antreu.`;
  } else if (ctx.session.imobilType === "houses") {
    desc = `In vânzare casa de tip ${
      ctx.session.data.house_type
    }, amplasata în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }.
        Locuința se desfășoară pe o suprafață de ${
          ctx.session.data.area
        } m2, dotat cu ${
      ctx.session.data.floors
    } etaje, fiind compartimentat în: ${
      ctx.session.data.rooms === 1
        ? "1 cameră"
        : `${ctx.session.data.rooms} camere`
    }, bucătărie,
         ${
           ctx.session.data.bathrooms === 1
             ? "1 bloc sanitar"
             : `${ctx.session.data.bathrooms} blocuri sanitare`
         }.`;
  } else if (ctx.session.imobilType === "commercials") {
    desc = `In vânzare spatiu comercial de tip ${
      ctx.session.data.commercial_destination.ro
    }, amplasata în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }.
      Se desfășoară pe o suprafață de ${ctx.session.data.area} m2.`;
  } else if (ctx.session.imobilType === "terrains") {
    desc = `In vânzare lot de pamant pentru ${
      ctx.session.data.terrain_destination.ro
    }, amplasat în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }. Se desfășoară pe o suprafață de ${ctx.session.data.area} m2.`;
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
    for (const imagePath of ctx.session.data.thumbnails) {
      const photoUpload = await axios.post(
        `${pageGraph}/photos`,
        { url: imagePath.url, published: false },
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
    for (const url of ctx.session.data.thumbnails) {
      const mediaContainer = await axios.post(
        `${graph}/${instagramId}/media`,
        {
          image_url: url.url,
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
    console.error("An error occurred:", error.response.data);
    return {};
  }
}

module.exports = { postToMeta };
