/**
 * utils/puppeteerBrowser.js
 *
 * Shared Puppeteer browser instance for image downloads.
 * Maintains session cookies from 999.md to access simpalsmedia.com images.
 *
 * Chromium auto-detection:
 *   1. PUPPETEER_EXECUTABLE_PATH env var (highest priority)
 *   2. Known system paths (Docker, macOS, etc.)
 *   3. `which` command fallback
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const { execSync } = require('child_process');

let browserInstance = null;

/**
 * Auto-detect Chromium executable path
 * Returns the first valid path found, or null if none exist.
 */
function detectChromiumPath() {
  // Priority 1: Environment variable
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath && fs.existsSync(envPath)) {
    console.log(`[PuppeteerBrowser] ✓ Using Chromium from ENV: ${envPath}`);
    return envPath;
  }

  // Priority 2: Common system paths
  const systemPaths = [
    '/usr/bin/chromium',           // Debian/Ubuntu (apt)
    '/usr/bin/chromium-browser',   // Some Debian variants / snap
    '/snap/bin/chromium',          // Snap installations
    '/usr/local/bin/chromium',     // Manual / compiled
    '/opt/chromium/chromium',      // /opt installations
  ];

  for (const p of systemPaths) {
    if (fs.existsSync(p)) {
      console.log(`[PuppeteerBrowser] ✓ Using Chromium at: ${p}`);
      return p;
    }
  }

  // Priority 3: `which` command
  try {
    const whichResult = execSync('which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || which google-chrome-stable 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      console.log(`[PuppeteerBrowser] ✓ Using Chromium from \`which\`: ${whichResult}`);
      return whichResult;
    }
  } catch (e) {
    // which failed — continue
  }

  // Priority 4: Filesystem search (last resort — slow)
  try {
    const findResult = execSync('find /usr -name "chromium" -type f -executable 2>/dev/null | head -1', { encoding: 'utf-8' }).trim();
    if (findResult && fs.existsSync(findResult)) {
      console.log(`[PuppeteerBrowser] ✓ Using Chromium from filesystem search: ${findResult}`);
      return findResult;
    }
  } catch (e) {
    // find failed
  }

  console.error('[PuppeteerBrowser] ✗ Chromium not found in any path!');
  return null;
}

/**
 * Get or create a shared browser instance
 */
async function getBrowser() {
  if (!browserInstance) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    };

    const chromiumPath = detectChromiumPath();
    if (chromiumPath) {
      launchOptions.executablePath = chromiumPath;
    }

    browserInstance = await puppeteer.launch(launchOptions);
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
