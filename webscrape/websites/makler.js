
  // //// MAKLER ////
  
  async function parseMakler(url) {
    try {
      const response = await axios.get(url);
      const html = response.data;
      const $ = cheerio.load(html);
      const name = $("h1[itemprop='name'] strong#anNameData").text().trim();
  console.log(name);
  
      const images = [];
      $("a.fancybox-disaproved-img").each((_, el) => {
      const rawUrl = $(el).attr("href");  // Extrage atributul 'href' din <a>
    
    if (rawUrl) {
      const imageUrl = rawUrl.trim();
      // HARDENING: ALWAYS trim, NEVER push undefined/empty/relative
      if (imageUrl && imageUrl.startsWith("http")) {
        images.push(imageUrl);
      } else if (imageUrl && imageUrl.startsWith("/")) {
        // Convert relative to absolute
        const fullImageUrl = `https://makler.md${imageUrl}`;
        images.push(fullImageUrl);
      }
    }
  });console.log(images);
  
      const description = $("#anText").length > 0 ? $("#anText").text().trim() : "Descriere indisponibilă";
      console.log(description);
     // Localitate (Chișinău apare în alt tag <ul class="item-city">)
  const localitate = $("ul.item-city li").text().trim();
  console.log(localitate);
  const sector = $("ul.itemtable li").filter((_, el) => {
    const text = $(el).find(".fields").text().trim();
    return text.includes("Район") || text.includes("Sectorul");
  }).find(".values").text().trim();
  console.log(sector);
  const street = $("ul.itemtable li").filter((_, el) => {
    const text = $(el).find(".fields").text().trim();
    return text.includes("Улица") || text.includes("Strada");
  }).find(".values").text().trim();
  console.log(street);
  const casanr = $("ul.itemtable li").filter((_, el) => {
    const text = $(el).find(".fields").text().trim();
    return text.includes("Номер дома") || text.includes("Numărul casei");
  }).find(".values").text().trim();
  console.log(casanr);
  const region = `${localitate} mun., ${localitate}, ${sector}, ${street}, ${casanr}`;
  console.log(region);
      function extractFieldValue($, labels) {
        return $("ul.itemtable li").filter((_, el) => {
          const text = $(el).find(".fields").text().trim();
          return labels.some(label => text.includes(label));
        }).find(".values").text().trim();
      }
      function extractFloorAndFloors($) {
        const raw = extractFieldValue($, ["Etaj", "Этаж"]).replace(/\s+/g, ' ').trim();
        let floor = "";
        let floors = "";
        const match = raw.match(/^(\d+)/); 
        if (match) {
          floor = match[1];  
        }
        const matchFloors = raw.match(/(\d+)\/(\d+)/); 
      
        if (matchFloors) {
          floors = matchFloors[2];  
        } else {
          floors = extractFieldValue($, ["Etaje", "Этажность дома"]);
        }
        return { floor, floors };
      }
      const { floor, floors } = extractFloorAndFloors($);
      console.log("Floor:", floor);  // '4'
      console.log("Floors:", floors);  // '5'
      const rooms = extractFieldValue($, ["Numărul de camere", "Количество комнат"]);
      const supraface = extractFieldValue($, ["Suprafaţa totală", "Общая площадь"]);
      const baths = extractFieldValue($, ["Grup sanitar", "Санузел"]);
      const heatingType = extractFieldValue($, ["Încălzire", "Отопление"]);
      const etape = extractFieldValue($, ["Tipul clădirii", "Тип строения"]);
      const locativeFont = extractFieldValue($, ["Tipul casei", "Тип дома"]);
      const balcony = extractFieldValue($, ["Balcon/lojă", "Балкон/лоджия"]);
      const parking = extractFieldValue($, ["Parcare", "Парковка"]);
      const condition = extractFieldValue($, ["Starea apartamentului", "Состояние квартиры"]);
      const planning = extractFieldValue($, ["Planificare", "Планировка"]);
      let price = $("div.user-price").text().trim();
      if (!price) {
        price = $("div.item_title_price").text().trim();
      }
      price = price.replace("Preţul:", "").replace("€", "").replace("$", "").trim();
      console.log(price);  
  const contact = $("li[itemprop='telephone']").text().replace(/\s+/g, "").trim();
  console.log(contact); 
      const adData = {
        name,
        description,
        link: url,
        floor,
        floors,
        locativeFont,     
        heatingType,
        etape,
        rooms,
        lat: null,
        lon: null,
        baths,
        balcony,
        condition,
        parking,
        planning,
        price,
        currency: "€",
        recomandate: false,
        supraface,
        tipAnunt: "Vânzare",
        email: null,
        advantages: [],
        region,         
        sector,
        address: region,       
        street,
        images,
        contact, 
        advantages: [], // Adaugă avantajele dacă le ai
        localitate,    // ← încă rămâne "Chișinău"
      };
      return adData;
  
    } catch (error) {
      console.error("Eroare la încărcarea paginii:", error);
      return null;
    }
  }
  
  module.exports = { parseMakler };
  