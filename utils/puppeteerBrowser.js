/**
 * utils/puppeteerBrowser.js
 *
 * Shared Puppeteer browser instance for image downloads.
 * Maintains session cookies from 999.md to access simpalsmedia.com images.
 */
const puppeteer = require('puppeteer');

let browserInstance = null;

/**
 * Get or create a shared browser instance
 */
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserInstance;
}

/**
 * Get or create a page with 999.md session
 */
async function getPageWithSession() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Navigate to 999.md to establish session cookies
  await page.goto('https://999.md', { waitUntil: 'networkidle2', timeout: 30000 });

  return page;
}

/**
 * Download image using Puppeteer (with session cookies)
 */
async function downloadImageWithPuppeteer(imageUrl) {
  try {
    const page = await getPageWithSession();

    // Set viewport to avoid image resizing issues
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to image URL
    await page.goto(imageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Get image buffer
    const imageBuffer = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img'))
        .map(img => img.src)
        .find(src => src.includes('simpalsmedia.com')) || null;
    });

    if (imageBuffer) {
      // Download the image
      const response = await page.goto(imageBuffer, { waitUntil: 'networkidle2' });
      const buffer = await response.buffer();
      return { buffer, success: true };
    }

    return { buffer: null, success: false };
  } catch (error) {
    console.error(`[Puppeteer Download] Failed for ${imageUrl}:`, error.message);
    return { buffer: null, success: false };
  }
}

/**
 * Download image directly using page.goto and response
 */
async function downloadImageDirect(imageUrl) {
  try {
    const page = await getPageWithSession();
    const response = await page.goto(imageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const buffer = await response.buffer();
    return { buffer, success: true };
  } catch (error) {
    console.error(`[Puppeteer Download] Failed for ${imageUrl}:`, error.message);
    return { buffer: null, success: false };
  }
}

module.exports = {
  getBrowser,
  getPageWithSession,
  downloadImageWithPuppeteer,
  downloadImageDirect,
};
