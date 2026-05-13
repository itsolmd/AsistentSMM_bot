const cheerio = require("cheerio");
const fetch = require("node-fetch"); // Make sure to include this if not already required
const url = "https://999.md/ro/85839188";

async function test_999(url) {
  // Force using "ro" in the URL if necessary
  const urlParts = url.split("/");
  if (urlParts[3] && urlParts[3].length === 2) {
    urlParts[3] = "ro";
  }
  const fixedUrl = urlParts.join("/");

  const res = await fetch(fixedUrl);
  const data = await res.text();
  const $ = cheerio.load(data);
  const root_post = $(".adPage__content.container_25").html();

  // Extract region information including either the data-option-id or data-value attribute
  const region = cheerio
    .load(root_post)(".adPage__content__region.grid_18")
    .find("dd")
    .map((i, el) => {
      // Try to get the data-option-id
      const optionId = $(el).attr("data-option-id");

      // If data-option-id is "None", fallback to using data-value
      const valueToUse =
        optionId === "None" ? $(el).attr("data-value") : optionId;

      return valueToUse; // Return either data-option-id or data-value based on the condition
    })
    .get();

  return region;
}

// Wrapping your call inside an async function
async function run() {
  const resp = await test_999(url);
  console.log(resp); // Prints out the data-option-id or data-value values
}

// Run the async function
run();
