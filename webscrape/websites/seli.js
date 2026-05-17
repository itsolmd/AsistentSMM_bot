
  // // //// seli.md ////
  async function parseSeli(url, sourceText = url) {
    try {
      const response = await axios.get(url);
      const html = response.data;
      const $ = cheerio.load(html);
  
      // ✅ Extrage numele complet (inclusiv sectorul)
      const name = $('h1.ad-title').text().replace(/\s+/g, ' ').trim();
  
      // ✅ Extrage descrierea
      const description = $('.desc p').text().replace(/\s+/g, ' ').trim();
      const city = "Chișinău";
  
      // ✅ Definește lista de sectoare
      const SECTORS = [
        "Râșcani",
        "Aeroport",
        "Botanica",
        "Buiucani",
        "Centru",
        "Ciocana",
        "Durlești",
        "Poșta Veche",
        "Sculeni",
        "Telecentru"
      ];
  
      // ✅ Caută sectorul potrivit din titlu
      const sector = SECTORS.find((s) => name.includes(s)) || "Sector necunoscut";
  
      console.log("Titlu complet:", name);
      console.log("Sector extras:", sector);
  
  
  // 💰 Extract price
  const price = $('.new.without-discount').first().text().replace(/\s+/g, ' ').trim();
  console.log("Preț:", price);
  
  // ☎️ Extract contact
  const contact = $('#full_phone').attr('href')?.replace('tel:', '') || null;
  console.log("Contact:", contact);
  
      async function filterAccessibleImages(images) {
        const accessible = [];
      
        for (const url of images) {
          try {
            const res = await axios.head(url);
            if (res.status >= 200 && res.status < 400) {
              accessible.push(url);
            }
          } catch (e) {
            console.warn(`⚠️ Imagine inaccesibilă: ${url}`);
          }
        }
      
        return accessible;
      }
      const images = $(".swiper-wrapper a[data-fancybox='gallery']")
        .map((i, el) => {
          const rawUrl = $(el).attr("href");
          // HARDENING: ALWAYS trim, ONLY push valid http URLs
          if (rawUrl) {
            const trimmed = rawUrl.trim();
            if (trimmed.startsWith("http")) {
              return trimmed;
            }
          }
          return null;
        })
        .get()
        .filter(Boolean);

      console.log(`📸 TOATE imaginile (${images.length}):`);
      images.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));

      function getHighResImages(images, sourceUrl) {
        const urlHost = new URL(sourceUrl).host;
      
        if (urlHost.includes("999.md")) {
          return images.filter((url) => url.includes("900x900"));
        }
      
        return [...new Set(images)].filter((url) =>
          /\.(jpg|jpeg|png|webp)$/i.test(url)
        );
      }
      
      const highResImages = getHighResImages(images, sourceText);
      const validImages = await filterAccessibleImages(highResImages);
  
      function extractFieldValue($, labels = []) {
        const items = $('#caracter ul li').toArray().map(el => $(el).text().trim()).filter(Boolean);
      
        for (let i = 0; i < items.length - 1; i++) {
          const key = items[i];
          const val = items[i + 1];
      
          if (labels.includes(key)) {
            return val;
          }
        }
      
        return null; // dacă nu se găsește
      }
  
      const rooms = extractFieldValue($, ["Număr camere", "Количество комнат"]);
      const floor = extractFieldValue($, ["Nivelul", "Этаж"]);
      const floors = extractFieldValue($, ["Număr nivele", "Количество этажей"]);
      const supraface = extractFieldValue($, ["Suprăfața totală", "Общая площадь"]);
      const condition = extractFieldValue($, ["Starea apartamentului", "Состояние квартиры"]);
      const baths = extractFieldValue($, ["Baie", "Ванная комната"]);
  
  
      const adData = {
        name,
        description,
        link: url,
        // streetNumber,
        city: "Chișinău",
        price,
        region: `${city} mun.`,
        sector,
        address: name,
        // street,
        contact,
        localitate: city,
        floor,
        floors,
        rooms,
        supraface,
        baths,
        condition,
        images: validImages
      };
  
      console.log(adData);
      return adData;
    } catch (error) {
      console.error("Ошибка при загрузке страницы:", error);
      return null;
    }
  }
  
  module.exports = { parseSeli };
  