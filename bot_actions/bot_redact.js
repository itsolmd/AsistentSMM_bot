const axios = require("axios");

adData = {
  title: "Apartament cu 2 camere, 80 m², Râșcani, Chișinău",
  description:
    "Bloc Nou! Eldorado Terra! Design Individual! Euroreparatie! Priveliste Uimitoare!!!\n" +
    "\n" +
    "Spre vânzare apartament cu 2 camere + living în complexul rezidențial OASIS construit de compania Eldorado Terra, amplasat în sectorul Râșcani, str. Bogdan Voievod. \n" +
    "\n" +
    "Locuința se desfășoară pe o suprafață de 80 m2, localizat la etajul 15 din 17, fiind compartimentat în: 2 camere, living, bucătărie, balcon, terasă, bloc sanitar și antreu.\n" +
    "\n" +
    "Facilitatii;\n" +
    "- euroreparație;\n" +
    "- încălzire autonomă;\n" +
    "- mobilă + tehnică de uz casnic;\n" +
    "- geamuri termopane panoramice;\n" +
    "- parchet, ușă blindată și uși din lemn;\n" +
    "- izolare fonică și termică de calitate înaltă;\n" +
    "- fațadă din cărămidă roșie;\n" +
    "- localizare de mijloc;\n" +
    "- sistem de aer condiționat;\n" +
    "- teren de joacă;\n" +
    "- curte de tip închis;\n" +
    "- zonă de relaxare pentru maturi;\n" +
    "- parcare subterană.\n" +
    "\n" +
    "În apropiere se află: Bancă, Farmacie, Grădiniță, Piață, Școală, Supermarket, Parc, Parcare.\n" +
    "\n" +
    "ATENȚIE! Imobilul poate fi cumpărat în credit cu doar 30% rată inițială.",
  rooms: "Apartament cu 2 camere",
  living: false,
  area: 80,
  price: 225000,
  views: 1026,
  floor: 15,
  floors: 17,
  bathrooms: 2,
  balconies: 1,
  images: [
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/188505b07cd0413836d4aa3cb3ab6dcc.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/aa4964a80f027fced1116d5122cc7f10.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/301f379d67a5b1bb7b46598dad328a57.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/7f187bc55d50db22ae04f0133c3a942c.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/0d65f9427477b00195858522b83fe699.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/dc04f042616d1a0d1be491e7522ae686.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/4ebb9e602a761e7fbc747c27129afe2a.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/1a0ecf0de8d0418e590f0ae3aa1b13cc.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/9c0e2902881add6f1bd573de7b5e72a4.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/e3ccd502b86f8879d80540c124f9b83b.jpg",
    "https://i.simpalsmedia.com/999.md/BoardImages/900x900/f44c66ec4aea77433fd2ebf5b519aa47.jpg",
  ],
  geolocation: { lat: "47.043735", lng: "28.858242" },
};

const getDescription = async (adData) => {
  const adDataCopy = { ...adData };
  delete adDataCopy.contact;
  delete adDataCopy.images;

  const config = {
    question: JSON.stringify(adDataCopy),
    overrideConfig: {
      systemMessage: `
# Instructions for generating concise, structured real estate property descriptions in Romanian:
Write descriptions in Romanian, representing "Premier Imobil" and ensuring all content is factual and elegant. Descriptions should have a maximum character count of 700, avoiding introductory or unnecessary phrases. Structure the output clearly in bullet-points. Include essential details: bathrooms, special features (e.g., balconies, renovations, furnishings), proximity to amenities. Exclude anything regarding: rooms amount, area, price, floor or amount of total floors and the adress. Do not mention anything regarding a commission fee or offers or credits. Maintain a professional and engaging tone, highlighting key features without embellishment or using any symbols. Example format with structured output:
# please dont write "Directly from the owner, without intermediaries" because we are agency, but also don't mention the name of the agency or any other sources in any ways, also do not invite the viewer for details or other ways of getting information about the property (because this scenario is predicted). instead of property_type i need you to write in depending on what type of property is specified (most of the time either "apartament" or "casa"). Also i need you to always use the word "sector"
In vânzare property_type în sectorul Telecentru, Chișinău

Detalii:
- 2 balcoane, euro-renovare modernă
- Încălzire centralizată
- Mobilat complet, aparate electrocasnice de calitate
- Podele din parchet, uși din lemn, ușă blindată


`,
    },
  };
  const response = await axios.post(
    "https://bubble.aichat.md/api/v1/prediction/b581cd49-0b36-47df-a7d1-fdb01333ecf2",
    {
      ...config,
    }
  );
  console.log(response.data.text);
  return response.data.text.slice(1);
};

module.exports = { getDescription };
