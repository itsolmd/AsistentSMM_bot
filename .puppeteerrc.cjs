/**
 * .puppeteerrc.cjs
 * Prevents Puppeteer from downloading Chromium during npm install.
 * Chromium is installed via apt (system package) in the Docker image.
 */
const { join } = require('path');

module.exports = {
  // Skip Chromium download entirely — we use the system-installed one
  skipDownload: true,
  // Use system Chromium installed via apt (Docker)
  executablePath: '/usr/bin/chromium',
};