/**
 * .puppeteerrc.cjs
 *
 * Puppeteer configuration for Docker/Coolify deployment.
 * Chromium is installed via apt (system package), NOT bundled with npm.
 *
 * Note: The `executablePath` here is used as a fallback hint.
 * The actual path is resolved at runtime by detectChromiumPath()
 * which checks multiple locations and the PUPPETEER_EXECUTABLE_PATH env var.
 */
const fs = require('fs');

// Auto-detect the correct Chromium path at config-load time
function resolveChromiumPath() {
  // 1. Environment variable (set in Dockerfile)
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 2. Common system paths
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 3. Default fallback (will be overridden at runtime)
  return '/usr/bin/chromium';
}

module.exports = {
  // Skip Chromium download entirely — we use the system-installed one
  skipDownload: true,
  // Resolve executable path dynamically
  executablePath: resolveChromiumPath(),
};