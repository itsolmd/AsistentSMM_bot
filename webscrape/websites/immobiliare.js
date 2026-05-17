//// imobiliare.md/////

const cheerio = require("cheerio");
const axios = require("axios");
const { URL } = require("url"); // Use the URL constructor from the `url` module
const querystring = require("querystring");

//type => extract info
const scrap_immobiliare = async (ctx, url) => {
  try {
    console.log("🔍 [scrap_immobiliare] Fetching URL:", url);
    const res = await fetch(url);

    const data = await res.text();
    const $ = cheerio.load(data);
    const root_post = $(".content-property-detail").html();

  let type = cheerio.load(root_post)(".type-property").text().trim();

  const characteristics = cheerio
    .load(root_post)(".list.list-detail.d-flex.flex-wrap")
    .html()
    .split("</li>")
    .map((li) => {
      const key = cheerio.load(li)(".text.flex-shrink-0").text().trim();
      const val = cheerio.load(li)(".value.flex-grow-1").text().trim();
      return {
        key,
        val,
      };
    })
    .filter((item) => item.key !== "");

  const getCharacteristic = (key) => {
    const foundObject = characteristics.find((item) => item.key == key);
    return foundObject ? foundObject.val : null;
  };

  //tot ce e adaugator (in db features)
  let features;
  if ($(".property-section.property-amenities").length !== 0) {
    features = cheerio
      .load(root_post)(".property-section.property-amenities ul")
      .html()
      .split("</li>")
      .map((li) => {
        const key = cheerio.load(li)(".yes").text().trim();
        return key;
      });
    features.pop();
  } else {
    features = null;
  }

  const getFeature = (key) => {
    return features?.find((item) => item == key);
  };

  const objectToSend = {};
  objectToSend.type = type;
  objectToSend.link = url;
  objectToSend.features = features;

  const price = getCharacteristic("Prețul:");
  objectToSend.price = parseInt(
    price
      .split("")
      .splice(0, price.length - 2)
      .join("")
      .replace(",", "")
  );

  // ═══════════════════════════════════════════════════════════════
  // GEOLOCATION — Extract from map widget data attributes
  // Normalized to { lat, lng } format with safe validation.
  // ═══════════════════════════════════════════════════════════════
  const rawLat = cheerio.load(root_post)("#js-ad-map").attr("data-marker-lat");
  const rawLng = cheerio.load(root_post)("#js-ad-map").attr("data-marker-lng");

  console.log('[GEO RAW] lat:', rawLat, 'lng:', rawLng);

  const lat = Number(rawLat);
  const lng = Number(rawLng);

  const hasValidGeo = Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

  if (hasValidGeo) {
    objectToSend.geolocation = { lat, lng };
    console.log('[GEO VALIDATION] ✅ Valid — lat:', lat, 'lng:', lng);
  } else {
    // Fallback to Chișinău city center
    objectToSend.geolocation = { lat: 47.017461, lng: 28.846762 };
    console.log('[GEO VALIDATION] ❌ Invalid or missing — using fallback Chișinău center');
  }
  console.log('[GEO PAYLOAD]', JSON.stringify(objectToSend.geolocation));

  const views_element = $(
    ".adPage__aside__stats__views.not-marketplace"
  ).text();
  objectToSend.region = [...region];

  //haltura
  var images = [];
  var images_temp = cheerio
    .load(root_post)("#js-ad-photos .js-item a.js-fancybox")
    .map((_, element) => {
      const rawUrl = $(element).attr("data-mfp-src");
      if (rawUrl) {
        const imageUrl = rawUrl.trim();
        // HARDENING: ONLY push valid http URLs
        if (imageUrl && imageUrl.startsWith("http")) {
          images.push(imageUrl);
        }
      }
    })
    .html();
  //daca mai sus nu s-a executat codul (dar in caz de e doar o fotografie el nu se va executa) va cauta unica fotografie si o va returna
  if (images.length === 0) {
    var images_temp = cheerio.load(root_post)(
      ".js-fancybox.mfp-zoom.mfp-image"
    );

    var rawSrc = images_temp.find("img").attr("src");
    if (rawSrc) {
      const imageSrc = rawSrc.trim();
      // HARDENING: ONLY push if starts with http
      if (imageSrc.startsWith("http")) {
        images.push(imageSrc);
      }
    }
  }

  objectToSend.images = [...images];
  console.log(`📸 TOATE imaginile (${images.length}):`);
  images.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));

  const views = parseInt(
    views_element
      .substring(views_element.indexOf(":") + 1, views_element.indexOf("("))
      .trim()
      .split(" ")
      .join("")
  );
  objectToSend.views = views;

  const title = $(".adPage__header").text().trim();
  objectToSend.title = title;
  //de la patanasi
  const contact = $('a[href^="tel:"]').attr("href").replace("tel:", "");
  objectToSend.contact = contact;
  const description = cheerio
    .load(root_post)(".adPage__content__description.grid_18")
    .text();
  objectToSend.description = description;

  //sus e tot ce e comun intre tipurile de imobile: type (apart sau casa), characteristics, features, price, geolocation, images, region, views, title, contact, desc,
  if (type === "Apartamente") {
    const roomsString = getCharacteristic("Numărul de camere").trim();
    const rooms =
      roomsString === "O cameră" ? 1 : roomsString.split(" ").splice(2, 1)[0];
    objectToSend.rooms = parseInt(rooms);

    var living = false;
    if (getCharacteristic("Living") == "Apartament cu living") {
      living = true;
    }
    objectToSend.living = living;

    const area = parseInt(
      getCharacteristic("Suprafață totală").trim().split(" ")[0]
    );
    objectToSend.area = area;

    const floor = parseInt(getCharacteristic("Etaj").trim());
    objectToSend.floor = floor;

    const floors = parseInt(getCharacteristic("Număr de etaje").trim());
    objectToSend.floors = floors;

    const condition = getCharacteristic("Starea apartamentului");
    objectToSend.condition = condition;

    const building = getCharacteristic("Fond locativ").trim();
    objectToSend.building = building;

    const serie = getCharacteristic("Compartimentare");
    objectToSend.serie = serie;

    const developer = getCharacteristic("Dezvoltator");
    objectToSend.developer = developer;

    //e pus key la autonoma pentru ca daca nu e autonoma, returneaza undefined si incearca sa caute de sus la undefined.key
    const heating =
      getFeature("Încălzire autonomă") || "Încălzire centralizată";
    objectToSend.heating = heating;
    /////////
    //optionale

    let bathrooms = getCharacteristic("Grup sanitar");
    if (bathrooms != null) {
      bathrooms = parseInt(bathrooms);
    }
    objectToSend.bathrooms = bathrooms;

    var balcony = getCharacteristic("Balcon/ lojie");
    if (balcony != null) {
      balcony = parseInt(balcony);
    }
    objectToSend.balcony = balcony;
  } else if (type === "Case") {
    //trebuie suprafata totala si cea locativa
    const area = parseInt(getCharacteristic("Suprafață totală"));
    objectToSend.area = parseInt(area) || null;

    const hectares = parseInt(getCharacteristic("Suprafața terenului"));
    objectToSend.hectares = parseInt(hectares);

    const house_type = getCharacteristic("Tip");
    objectToSend.house_type = house_type;

    const rooms = getCharacteristic("Număr de camere");
    objectToSend.rooms = parseInt(rooms);

    const floors = getCharacteristic("Număr de etaje");
    objectToSend.floors = parseInt(floors);

    const condition = getCharacteristic("Starea casei");
    objectToSend.condition = condition;

    var sanitary = false;
    if (getCharacteristic("Instalații sanitare") == "Cu instalații sanitare") {
      sanitary = true;
    }
    objectToSend.sanitary = sanitary;

    var canalization = false;
    if (getCharacteristic("Canalizare") == "Сu сanalizare") {
      canalization = true;
    }
    objectToSend.canalization = canalization;

    var gasification = false;
    if (getCharacteristic("Gazeificare") == "Cu gazificare") {
      gasification = true;
    }
    objectToSend.gasification = gasification;
  } else if (type === "Imobiliare comerciale") {
    const area = parseInt(getCharacteristic("Suprafață totală"));
    objectToSend.area = parseInt(area);

    const commercial_destination = getCharacteristic("Tipul încăperii");
    objectToSend.commercial_destination = commercial_destination;

    const condition = getCharacteristic("Starea încăperii");
    objectToSend.condition = condition;

    return objectToSend;
  } else if (type === "Loturi de teren") {
    const terrain_destination = getCharacteristic("Tipul lotului");
    objectToSend.terrain_destination = terrain_destination;

    const area = parseInt(getCharacteristic("Suprafața terenului"));
    objectToSend.area = parseInt(area);
  }

  return objectToSend;
  } catch (err) {
    console.error("❌ [scrap_immobiliare] Error scraping:", url, err.message);
    return null;
  }
};

module.exports = { scrap_immobiliare };
