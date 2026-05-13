
// ////  LOYAL  ////

const axios = require("axios");
const cheerio = require("cheerio");

async function parseLoyal(url) {
    try {
      const response = await axios.get(url);
      const html = response.data;
      const $ = cheerio.load(html);
      const name = $("meta[itemprop='name']").attr("content") || $("title").text().trim();
      const description = $('.object-description__text p').text().trim() || "Не указано";  
      const address = $(".object-header__title").text().trim() || "Не указано";  
      const priceText = $(".object-header__amount--price").text().trim();
      const price = priceText.replace(/\s/g, "").replace(/[^\d€]/g, "");
  const currency = "€";
      const contactName = $(".object-manager__header--name span")
        .text()
        .trim()
        .replace(/(\b\w+\b)(?=.*\1)/g, '$1'); // Elimină numele repetate
      const contactPhone = $(".object-manager__header--phone")
        .text()
        .trim()
        .replace(/Telefon:\s*\n*\s*/g, "")  // Elimină secvențele "Telefon:"
        .replace(/(\+373 \d{6,})\s*\1/, '$1')  // Elimină duplicarea numărului
        .trim(); // Curăță spațiile suplimentare
      console.log("Contact Name:", contactName);
      console.log("Contact Phone:", contactPhone);
      const images = [];
      $(".object-gallery__big--item img").each((_, el) => {
        const rawUrl = $(el).attr("src");
        if (rawUrl) {
          const imageUrl = rawUrl.trim();
          // HARDENING: if already a full URL, use as-is; otherwise prepend domain
          if (imageUrl.startsWith("http")) {
            images.push(imageUrl);
          } else if (imageUrl.startsWith("/")) {
            images.push(`https://loyal.md${imageUrl}`);
          }
          // else: skip relative non-http URLs (e.g. data:image, empty)
        }
      });
      const characteristics = $(".object-characters__item");
      const floorInfo = $(characteristics[0]).find("p").text().trim();
      const rooms = $(characteristics[1]).find("p").text().trim();
      const locativeFont = $(characteristics[2]).find("p").text().trim();
      const suprafaceText = $(characteristics[5]).find("p").text().trim();
      const [floor, totalFloors] = floorInfo.includes("/")
        ? floorInfo.split("/").map((value) => value.trim())
        : [floorInfo, null];
      const advantages = [];
      $(".object-description__characters li").each((_, el) => {
        advantages.push($(el).text().trim());
      });
      const region = $(".head-card__title").text().trim();
      const adData = {
        name,
        description,
        address: `Chișinău , ${name}`,
        region: `Moldova , Chișinău mun. , ${address.split(',')[0]}, ${address.split(',')[1]}, }`,
        link: url,
        floor: parseInt(floor) || null,
        floors: parseInt(totalFloors) || null,
        rooms,
        locativeFont,
        supraface: parseFloat(suprafaceText) || 0,
        baths: parseInt($(characteristics[7]).find("p").text().trim()) || null,
        balcony: parseInt($(characteristics[6]).find("p").text().trim()) || null,
        price: parseFloat(price) || 0,
        currency,
        tipAnunt: "Vânzare",
        images,
        contact: {
          name: contactName,
          phone: contactPhone
        },
        advantages,
      };
  
      console.log(adData);
      return adData;
    } catch (error) {
      console.error("Eroare la încărcarea paginii:", error);
      return null;
    }
  }
  
  
  
  module.exports = { parseLoyal };
  
  
  