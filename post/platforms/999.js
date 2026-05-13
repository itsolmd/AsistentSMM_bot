const axios = require("axios");
const cheerio = require("cheerio");
const fetch = require("node-fetch");
const FormData = require("form-data"); // Ensure you use form-data in Node.js
const { normalizeUrl, safeUrl } = require("../../utils/telegramMediaSafe");

// Function to upload an image from a URL to 999.md
async function uploadImageFromURL999(ctx, imageSrc) {
  try {
    // ── URL SAFETY: normalize and validate before request ──
    console.log("[uploadImageFromURL999] RAW input URL:", imageSrc);
    const cleanUrl = safeUrl(normalizeUrl(imageSrc));
    if (!cleanUrl) {
      console.error("❌ [uploadImageFromURL999] Invalid image URL rejected:", imageSrc);
      return null;
    }
    console.log("📸 [uploadImageFromURL999] Final image URL before request:", cleanUrl);

    // Fetch the image data as a buffer
    const response = await axios.get(cleanUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(response.data);

    // Create form data for the file upload
    const form = new FormData();
    form.append("file", imageBuffer, {
      filename: "image.jpg",
      contentType: "image/jpeg",
    });

    // Perform the image upload to the 999.md API
    const uploadResponse = await axios.post(
      "https://partners-api.999.md/images",
      form,
      {
        ...form.getHeaders(),
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    // Log success and return the image ID
    console.log("Imaginea incarcata cu succes:", uploadResponse.data.image_id);
    return uploadResponse.data.image_id;
  } catch (error) {
    // Log any errors during the image upload
    console.error("Eroare la incarcarea imaginii:", error);
    return null;
  }
}

//scrap regions form the link provided in db
async function extractRegion(ctx) {
  // ═══════════════════════════════════════════════════════════════
  // SAFE GEO EXTRACTION with validation
  // Accepts: lat/lng, lat/lon, latitude/longitude
  // Prevents Invalid LatLng crashes from undefined coordinates
  // ═══════════════════════════════════════════════════════════════
  const geo = ctx.session.data.geolocation;
  const safeLat = geo?.lat ?? geo?.latitude;
  const safeLng = geo?.lng ?? geo?.lon ?? geo?.longitude;

  console.log('[GEO RAW] geolocation from session:', JSON.stringify(geo));
  console.log('[GEO NORMALIZED] lat:', safeLat, 'lng:', safeLng);

  // VALIDATION: Both coordinates must be finite numbers
  const latNum = Number(safeLat);
  const lngNum = Number(safeLng);
  const hasValidGeo = Number.isFinite(latNum) && Number.isFinite(lngNum) &&
    latNum >= -90 && latNum <= 90 && lngNum >= -180 && lngNum <= 180;

  if (!hasValidGeo) {
    console.log('[GEO VALIDATION] ❌ Invalid coordinates — cannot extract region from map.md');
    console.log('[GEO VALIDATION] lat:', latNum, 'lng:', lngNum);
    // Return a basic Chișinău location when geo is invalid
    return [{ id: "7", value: "12900" }];
  }

  console.log('[GEO VALIDATION] ✅ Valid — lat:', latNum, 'lng:', lngNum);

  //aici se afla numele la raion, sector, strada si nr la bloc
  const mapObj = await axios.get(
    `https://map.md/api/companies/webmap/near?lat=${latNum}&lon=${lngNum}`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      auth: {
        username: ctx.session.user.map_token,
        password: "",
      },
    }
  );
  console.log("Răspunsul de la API din post on 999.js:", mapObj.data);
  console.log('[GEO PAYLOAD] map.md request with lat:', latNum, 'lon:', lngNum);
  //                  Chisinau Municipiu
  const location = [{ id: "7", value: "12900" }];

  //daca este sector din premier din db => hardcodeaza id 8 cu chisinau si cauta care e id-ul sectorului
  if (ctx.session.data.sector) {
    location.push({ id: "8", value: "13859" });

    const sectoare = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=8&parent_option_id=13859&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );

    const sector = sectoare.data.options.find(
      (item) => item.title === ctx.session.data.sector.ro
    );
    location.push({ id: "9", value: sector.id });
    location.push({ id: "10", value: mapObj.data.building.street_name });
    location.push({ id: "11", value: mapObj.data.building.number });
  }
  //daca este suburb => cauta care e id 8 (bubuieci, bacioi etc) si 9 hardcodeaza-l la centru
  else {
    const suburbii = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=7&parent_option_id=12900&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );
    const suburbId = suburbii.data.options.find(
      (item) => item.title === ctx.session.data.suburb.ro
    ).id;
    location.push({ id: "8", value: suburbId });

    const suburbSect = await axios.get(
      `https://partners-api.999.md/dependent_options?subcategory_id=1404&dependency_feature_id=8&parent_option_id=${suburbId}&lang=ro`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        auth: {
          username: ctx.session.user.token_999,
          password: "",
        },
      }
    );
    location.push({ id: "9", value: suburbSect.data.options[0].id });
    location.push({ id: "10", value: mapObj.data.building.street_name });
    location.push({ id: "11", value: mapObj.data.building.number });
  }
  return location;
}

// extragerea caracterist din 999
const extractFeaturesId = async (ctx, type) => {
  let typeID;
  if (type === "apartments") {
    typeID = 1404;
  } else if (type === "houses") {
    typeID = 1406;
  } else if (type === "commercials") {
    typeID = 1405;
  } else if (type === "terrains") {
    typeID = 1407;
  }
  const features = await axios.get(
    `https://partners-api.999.md/features?category_id=270&subcategory_id=${typeID}&offer_type=776&lang=ro`,
    {
      headers: {
        "Content-Type": "application/json",
      },
      auth: {
        username: `${ctx.session.user.token_999}`,
        password: "",
      },
    }
  );
  return features.data;
};

const extractFeatures = (data, featuresObj, ctx) => {
  const features = [];

  const findFeatureByTitle = (title) => {
    for (const group of featuresObj.features_groups) {
      const feature = group.features.find((f) => f.title === title);
      if (feature) return feature;
    }
    return null;
  };

  // Helper to process options
  const findOptionIdByTitle = (options, title) =>
    options.find((opt) => opt.title === title)?.id;

  //Comune///////////////////////////////////////////////////////////////

  // Price
  if (data.price != null) {
    const feature = findFeatureByTitle("Preț");
    if (feature) {
      features.push({
        id: feature.id,
        value: parseInt(data.price, 10),
        unit: "eur",
      });
    }
  }
  // Geolocation — Safe extraction with validation for 999.md API
  if (data.geolocation) {
    const feature = findFeatureByTitle("Harta");

    // Safe extraction: accept any coordinate key naming
    const geoLat = data.geolocation.lat ?? data.geolocation.latitude;
    const geoLon = data.geolocation.lon ?? data.geolocation.lng ?? data.geolocation.longitude;

    console.log('[GEO RAW] extractFeatures geolocation:', JSON.stringify(data.geolocation));
    console.log('[GEO NORMALIZED] lat:', geoLat, 'lon:', geoLon);

    const latNum = Number(geoLat);
    const lonNum = Number(geoLon);
    const validGeo = Number.isFinite(latNum) && Number.isFinite(lonNum) &&
      latNum >= -90 && latNum <= 90 && lonNum >= -180 && lonNum <= 180;

    if (feature && validGeo) {
      features.push({
        id: feature.id,
        value: { lat: latNum, lon: lonNum },
      });
      console.log('[GEO VALIDATION] ✅ Added 999.md map feature:', latNum, lonNum);
    } else if (!validGeo) {
      console.log('[GEO VALIDATION] ❌ Invalid geolocation — skipping 999.md map feature');
      console.log('[GEO VALIDATION] lat:', latNum, 'lon:', lonNum);
    }
  }

  //nr de telefon a agentului, sau default a lui dmn vasile
  if (data.agent) {
    //                                   elimina plusul din nr
    features.push({ id: "16", value: [ctx.session.user.phoneNr] });
  } else {
    //                                //nr de telefon a lui dmn vasile
    features.push({ id: "16", value: ["37376583452"] });
  }

  if (ctx.session.imobilType === "apartments") {
    if (data.features) {
      data.features.forEach((title) => {
        console.log("tesst12");
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    // Rooms
    if (data.rooms != null) {
      const feature = findFeatureByTitle("Număr de camere");
      if (feature) {
        const optionsMap = {
          1: "Apartament cu 1 cameră",
          2: "Apartament cu 2 camere",
          3: "Apartament cu 3 camere",
          4: "Apartament cu 4 camere",
          5: "Apartament cu 5 camere sau mai multe",
        };
        const roomTitle =
          data.rooms === 1 ? "Apartament cu 1 cameră" : optionsMap[data.rooms];
        const optionId = findOptionIdByTitle(feature.options, roomTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Living
    if (data.living != null) {
      const feature = findFeatureByTitle("Living");
      if (feature) {
        const livingTitle = data.living
          ? "Apartament cu living"
          : "Apartament fără living";
        const optionId = findOptionIdByTitle(feature.options, livingTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Area
    if (data.area != null) {
      const feature = findFeatureByTitle("Suprafață totală");
      if (feature) {
        features.push({ id: feature.id, value: parseInt(data.area, 10) });
      }
    }
    // Floor
    if (data.floor != null) {
      const feature = findFeatureByTitle("Etaj");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.floor)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Floors
    if (data.floors != null) {
      const feature = findFeatureByTitle("Număr de etaje");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.floors)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Bathrooms
    if (data.bathrooms != null) {
      const feature = findFeatureByTitle("Grup sanitar");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.bathrooms)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Balcony — BUG FIX: handle numeric IDs from scraper (1=Da, 2=Nu)
    if (data.balcony != null) {
      const feature = findFeatureByTitle("Balcon/ lojie");
      if (feature) {
        // Map numeric ID back to option title for 999.md API
        const balconyTitleMap = {
          1: "Da",
          2: "Nu",
        };
        const balconyTitle = typeof data.balcony === 'number'
          ? balconyTitleMap[data.balcony]
          : String(data.balcony);
        if (balconyTitle) {
          const optionId = findOptionIdByTitle(feature.options, balconyTitle);
          if (optionId) {
            features.push({ id: feature.id, value: optionId });
            console.log('[extractFeatures] Balcony mapped:', data.balcony, '→', balconyTitle, '→ option ID:', optionId);
          } else {
            console.warn('[extractFeatures] Balcony option not found for:', balconyTitle);
          }
        }
      }
    }

    // Building
    if (data.building) {
      const feature = findFeatureByTitle("Fond locativ");
      if (feature) {
        const buildingTitle =
          data.building.ro === "Bloc nou" ? "Construcţii noi" : "Secundar";
        const optionId = findOptionIdByTitle(feature.options, buildingTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Developer
    if (data.developer) {
      const feature = findFeatureByTitle("Dezvoltator");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.developer.ro
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // ══════════════════════════════════════════════════════════════
    // HEATING MAP — Maps normalized heating type to Strapi numeric IDs
    // ══════════════════════════════════════════════════════════════
    const POST_HEATING_MAP = {
      AUTONOMOUS: 1,
      CENTRALIZED: 2,
    };

    // Heating — with smart fallback based on building type
    let heatingId = data.heating != null && data.heating !== undefined ? data.heating : null;

    // ── HEATING FALLBACK: Infer from building/fund type when heating is missing ──
    if (heatingId === null && data.building) {
      // BUG FIX v3.0: data.building can be a string OR an object {ro: "..."}
      // Handle both cases to prevent .toLowerCase() crash on objects
      let buildingStr = '';
      if (typeof data.building === 'string') {
        buildingStr = data.building;
      } else if (data.building?.ro) {
        buildingStr = data.building.ro;
      } else if (data.building?.title) {
        buildingStr = data.building.title;
      } else {
        buildingStr = String(data.building);
      }

      const normalizedBuilding = buildingStr
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

      console.log("[HEATING FALLBACK] Building (raw):", data.building);
      console.log("[HEATING FALLBACK] Building (normalized):", normalizedBuilding);

      // "Construcţii noi" => AUTONOMOUS => ID 1
      if (
        normalizedBuilding.includes("constructii noi") ||
        normalizedBuilding.includes("bloc nou")
      ) {
        heatingId = POST_HEATING_MAP.AUTONOMOUS;
        console.log("[HEATING FALLBACK] Selected heating: AUTONOMOUS (ID " + POST_HEATING_MAP.AUTONOMOUS + ") — 'Construcţii noi' detected");
      }
      // Secondary/old building => CENTRALIZED => ID 2
      else if (
        normalizedBuilding.includes("fond secundar") ||
        normalizedBuilding.includes("secundar")
      ) {
        heatingId = POST_HEATING_MAP.CENTRALIZED;
        console.log("[HEATING FALLBACK] Selected heating: CENTRALIZED (ID " + POST_HEATING_MAP.CENTRALIZED + ") — secondary/old building detected");
      } else {
        console.log("[HEATING FALLBACK] No building match for:", normalizedBuilding);
      }
    }

    if (heatingId !== null) {
      const feature = findFeatureByTitle("Tip încălzire");
      if (feature) {
        const heatingOptions = {
          1: "Autonomă",
          2: "Centralizată",
        };
        const heatingTitle = heatingOptions[heatingId];
        if (heatingTitle) {
          const optionId = findOptionIdByTitle(feature.options, heatingTitle);
          if (optionId) {
            features.push({ id: feature.id, value: optionId });
            console.log('[extractFeatures] Heating mapped:', heatingId, '→', heatingTitle, '→ option ID:', optionId);
          } else {
            console.warn('[extractFeatures] Heating option not found for:', heatingTitle);
          }
        }
      }
    }

    // Condition
    if (data.condition) {
      const feature = findFeatureByTitle("Starea apartamentului");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    // Apartment series
    if (data.apartament_sery) {
      const feature = findFeatureByTitle("Compartimentare");
      if (data.apartament_sery.serie === "Ms (serie moldovenească)") {
        data.apartament_sery.serie = "Ms (serie  moldovenească)";
      }
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.apartament_sery.serie
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
  } else if (ctx.session.imobilType === "houses") {
    if (data.house_feature) {
      data.house_feature.forEach((title) => {
        console.log("tesst12");
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    //rooms
    if (data.rooms != null) {
      const feature = findFeatureByTitle("Număr de camere");
      //const optionId = findOptionIdByTitle(feature.options, data.rooms);
      features.push({ id: feature.id, value: data.rooms });
    }

    if (data.bathrooms != null) {
      const feature = findFeatureByTitle("Bloc sanitar");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          String(data.bathrooms)
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    //floors
    if (data.floors != null) {
      const feature = findFeatureByTitle("Nivele");
      if (feature) {
        const optionsMap = {
          1: "1 etaj",
          2: "2 etaje",
          3: "3 etaje",
          4: "4 sau mai multe etaje",
        };
        const floorTitle =
          data.floors === 1 ? "1 etaj" : optionsMap[data.rooms];
        const optionId = findOptionIdByTitle(feature.options, floorTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
    //tipul casei
    if (data.house_type) {
      const feature = findFeatureByTitle("Tip");
      console.log(feature);
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          data.house_type.ro
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    if (data.area) {
      const feature = findFeatureByTitle("Suprafața totală");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }
    if (data.hectares) {
      const feature = findFeatureByTitle("Suprafața terenului");
      if (feature) {
        features.push({ id: feature.id, value: data.hectares });
      }
    }
    if (data.sanitary) {
      const feature = findFeatureByTitle("Instalații sanitare");
      if (feature) {
        const optionId = findOptionIdByTitle(
          feature.options,
          "Cu instalații sanitare"
        );
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Instalații sanitare");

      const optionId = findOptionIdByTitle(
        feature.options,
        "Fără instalații sanitare"
      );
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    if (data.canalization) {
      const feature = findFeatureByTitle("Canalizare");
      if (feature) {
        const optionId = findOptionIdByTitle(feature.options, "Сu сanalizare");
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Canalizare");

      const optionId = findOptionIdByTitle(feature.options, "Fără canalizare");
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    if (data.gasification) {
      const feature = findFeatureByTitle("Gazeificare");
      if (feature) {
        const optionId = findOptionIdByTitle(feature.options, "Cu gazificare");
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    } else {
      const feature = findFeatureByTitle("Gazeificare");

      const optionId = findOptionIdByTitle(feature.options, "Fără gazificare");
      if (optionId) {
        features.push({ id: feature.id, value: optionId });
      }
    }

    // Condition
    if (data.condition) {
      const feature = findFeatureByTitle("Starea casei");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }
    features.push({
      id: "12",
      value: `Casa cu ${data.hecatres} ari spre vanzare, in ${
        data.suburb ? data.suburb : data.sector
      }`,
    });
    ////gata feature case
  } else if (ctx.session.imobilType === "commercials") {
    if (data.commercial_features) {
      data.commercial_features.forEach((title) => {
        const feature = findFeatureByTitle(title.ro);
        if (feature) {
          features.push({ id: feature.id, value: true });
        }
      });
    }

    if (data.commercial_destination) {
      const feature = findFeatureByTitle("Tip spațiu");
      if (feature) {
        const conditionMap = {
          //prettier-ignore
          "Birouri": "Birou",
          //prettier-ignore
          "Comercial": "Comercial",
          "Depozit/ Producere": "Depozit",
        };
        const conditionTitle = conditionMap[data.commercial_destination.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    if (data.area) {
      const feature = findFeatureByTitle("Suprafață totală");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }

    if (data.condition) {
      const feature = findFeatureByTitle("Starea încăperii");
      if (feature) {
        const conditionMap = {
          "Fără reparație/ Variantă albă": "Variantă albă",
          "Reparație euro": "Euroreparație",
          "Reparație medie": "Reparație cosmetică",
        };
        const conditionTitle = conditionMap[data.condition.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    features.push({
      id: "12",
      value: `Spatiu comercial cu ${data.area}m2 spre vanzare, in ${
        data.suburb ? data.suburb.ro : data.sector.ro
      }`,
    });
  }
  ////gata feature comerciale
  else if (ctx.session.imobilType === "terrains") {
    if (data.area) {
      const feature = findFeatureByTitle("Suprafață teren");
      if (feature) {
        features.push({ id: feature.id, value: data.area });
      }
    }

    if (data.terrain_destination) {
      const feature = findFeatureByTitle("Tip lot");
      if (feature) {
        const conditionMap = {
          //strapi : 999
          //prettier-ignore
          "Construcție": "Teren pentru construcții",
          //prettier-ignore
          "Agricol": "Teren agricol",
          //prettier-ignore
          "Pomicol": "Teren agricol",
        };
        const conditionTitle = conditionMap[data.terrain_destination.ro];
        const optionId = findOptionIdByTitle(feature.options, conditionTitle);
        if (optionId) {
          features.push({ id: feature.id, value: optionId });
        }
      }
    }

    features.push({
      id: "12",
      value: `Lot de pamant de ${data.area} ari spre vanzare, in ${
        data.suburb ? data.suburb.ro : data.sector.ro
      }`,
    });
  }
  return features;
};

// main
const postTo999 = async (ctx) => {
  let location;
  try {
    location = await extractRegion(ctx);
  } catch (error) {
    ctx.reply("a avut loc o eroare la extragerea locatiei");
    return console.log("Nu a fost extras linkul din baza de date: " + error);
  }
  let features;
  try {
    features = extractFeatures(
      ctx.session.data,
      await extractFeaturesId(ctx, ctx.session.imobilType),
      ctx
    );
    console.log(features);
  } catch (error) {
    console.log(error);
    return console.log("nu au putut fi extrase caracteristicile");
  }
  // BUG v2.1 FIXED: Changed ctx.session.data.thumbnails → ctx.session.data.images
  // The scraper sets ctx.session.data.images, but the code was reading
  // ctx.session.data.thumbnails which was undefined, resulting in 0 uploaded images.
  const uploadedImagesIds = []; // Array to hold the uploaded image IDs
  const imagesToUpload = ctx.session.data.images || ctx.session.data.thumbnails || [];
  console.log('[UPLOAD LOOP INPUT] images array length:', imagesToUpload.length);
  console.log('[UPLOAD LOOP INPUT] first 3 URLs:', JSON.stringify(imagesToUpload.slice(0, 3)));

  for (const image of imagesToUpload) {
    // Support both string URLs and { url } objects
    const imageUrl = typeof image === 'string' ? image : (image?.url || image?.src || null);
    if (imageUrl) {
      // Upload image and collect the uploaded image ID
      console.log('[UPLOADING IMAGE]', imageUrl);
      const imageId = await uploadImageFromURL999(ctx, imageUrl);
      if (imageId) {
        uploadedImagesIds.push(imageId);
        console.log("[UPLOADED IMAGE ID]", imageId, "for", imageUrl);
      } else {
        console.log("Eroare la procesarea imaginii:", imageUrl);
      }
    }
  }
  console.log('[UPLOADED IMAGE IDS total]', uploadedImagesIds.length);
  // Log the uploaded image IDs
  let subcategory;
  let desc;
  if (ctx.session.imobilType === "apartments") {
    subcategory = "1404";
    desc = `In vânzare apartament ${
      ctx.session.data.apartament_sery
        ? `seria ${ctx.session.data.apartament_sery.serie}`
        : ""
    }, amplasat în ${location[1].value}, ${location[2].value}.
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
    subcategory = "1406";
    desc = `In vânzare casa de tip ${
      ctx.session.data.house_type
    }, amplasata în ${location[1].value}, ${location[2].value}.
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
    subcategory = "1405";
    desc = `In vânzare spatiu comercial de tip ${
      ctx.session.data.commercial_destination.ro
    }, amplasat în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }.
        Spatiul comercial e dotat cu ${ctx.session.data.area} m2.`;
  } else if (ctx.session.imobilType === "terrains") {
    subcategory = "1407";
    desc = `In vânzare lot de pamant de tip ${
      ctx.session.data.terrain_destination.ro
    }, amplasat în ${
      ctx.session.data.suburb
        ? ctx.session.data.suburb.ro
        : ctx.session.data.sector.ro
    }.
        Spatiul comercial e dotat cu ${ctx.session.data.area} m2.`;
  }

  console.log(features);
  const objectToSend = {
    category_id: "270", //imobile
    subcategory_id: subcategory,
    offer_type: "776", //vand
    features: [
      {
        id: "795", //fata celui care publica
        value: "18894", //agentie
      },
      {
        id: "13", //descriere
        value: desc,
      },
      {
        id: "14", //imagini///////////////////////////////
        value:
          uploadedImagesIds.length > 0
            ? uploadedImagesIds.map((id) => `${id}`)
            : [],
      },
      ...features,
      ...location,
    ],
  };

  console.log("Object to send:", objectToSend);
  const post = await axios.post(
    "https://partners-api.999.md/adverts",
    objectToSend,
    {
      headers: { "Content-Type": "application/json" },
      auth: {
        username: ctx.session.user.token_999,
        password: "",
      },
    }
  );

  console.log(post.data.advert.id);
  ctx.reply("Postarea valabila la: https://999.md/ro/" + post.data.advert.id);
  return post.data.advert.id;
};

module.exports = { postTo999 };
