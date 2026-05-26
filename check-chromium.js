/**
 * check-chromium.js
 *
 * Debug script to verify Chromium installation inside the Docker container.
 * Run with: node check-chromium.js
 *
 * This script checks:
 *   - Common Chromium binary paths
 *   - Symlinks
 *   - Environment variables
 *   - Puppeteer configuration
 *   - Actual Chromium launch capability
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}${CYAN}  Chromium Installation Diagnostic  ${RESET}`);
console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
console.log('');

// ──────────────────────────────────────────────
// 1. Check environment variables
// ──────────────────────────────────────────────
console.log(`${BOLD}📋 Environment Variables${RESET}`);
console.log('─────────────────────────────────────────');

const envVars = [
  'PUPPETEER_EXECUTABLE_PATH',
  'PUPPETEER_SKIP_CHROMIUM_DOWNLOAD',
  'CHROME_PATH',
  'CHROMIUM_PATH',
  'NODE_ENV',
];

envVars.forEach(variable => {
  const value = process.env[variable];
  if (value) {
    console.log(`  ${GREEN}✓${RESET} ${variable} = ${value}`);
  } else {
    console.log(`  ${YELLOW}⚠${RESET} ${variable} = ${RED}NOT SET${RESET}`);
  }
});
console.log('');

// ──────────────────────────────────────────────
// 2. Check Chromium binary in common paths
// ──────────────────────────────────────────────
console.log(`${BOLD}🔍 Chromium Binary Search${RESET}`);
console.log('─────────────────────────────────────────');

const commonPaths = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/local/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/chromium/chromium',
  '/opt/google/chrome/google-chrome',
  '/app/.local/share/puppeteer/chrome',
  '/root/.cache/puppeteer',
];

commonPaths.forEach(filePath => {
  const exists = fs.existsSync(filePath);
  if (exists) {
    try {
      const stat = fs.statSync(filePath);
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other';
      const realPath = stat.isSymbolicLink() ? ` → ${fs.readlinkSync(filePath)}` : '';
      console.log(`  ${GREEN}✓${RESET} ${filePath} (${type})${realPath}`);
    } catch (e) {
      console.log(`  ${GREEN}✓${RESET} ${filePath} (exists, but stat failed: ${e.message})`);
    }
  } else {
    console.log(`  ${RED}✗${RESET} ${filePath} ${RED}NOT FOUND${RESET}`);
  }
});
console.log('');

// ──────────────────────────────────────────────
// 3. Search filesystem for chromium binaries
// ──────────────────────────────────────────────
console.log(`${BOLD}🔎 Extended Filesystem Search${RESET}`);
console.log('─────────────────────────────────────────');

try {
  const whichChromium = execSync('which chromium 2>/dev/null || true').toString().trim();
  const whichChromiumBrowser = execSync('which chromium-browser 2>/dev/null || true').toString().trim();
  if (whichChromium) console.log(`  ${GREEN}✓${RESET} \`which chromium\` → ${whichChromium}`);
  else console.log(`  ${RED}✗${RESET} \`which chromium\` → ${RED}not found${RESET}`);
  if (whichChromiumBrowser) console.log(`  ${GREEN}✓${RESET} \`which chromium-browser\` → ${whichChromiumBrowser}`);
  else console.log(`  ${RED}✗${RESET} \`which chromium-browser\` → ${RED}not found${RESET}`);
} catch (e) {
  console.log(`  ${RED}✗${RESET} \`which\` command failed: ${e.message}`);
}

// Find all chromium-related executables
try {
  const findResult = execSync('find /usr -name "*chromium*" -type f -executable 2>/dev/null | head -10').toString().trim();
  if (findResult) {
    console.log(`  ${GREEN}✓${RESET} Found in /usr:`);
    findResult.split('\n').forEach(line => console.log(`       ${line}`));
  } else {
    console.log(`  ${YELLOW}⚠${RESET} No chromium executables found in /usr`);
  }
} catch (e) {
  console.log(`  ${YELLOW}⚠${RESET} find command failed: ${e.message}`);
}
console.log('');

// ──────────────────────────────────────────────
// 4. Check version (if chromium found)
// ──────────────────────────────────────────────
console.log(`${BOLD}📌 Chromium Version${RESET}`);
console.log('─────────────────────────────────────────');

const foundPath = commonPaths.find(p => fs.existsSync(p));
if (foundPath) {
  try {
    const version = execSync(`${foundPath} --version 2>&1`).toString().trim();
    console.log(`  ${GREEN}✓${RESET} ${foundPath} --version → ${version}`);
  } catch (e) {
    console.log(`  ${RED}✗${RESET} Could not run ${foundPath}: ${e.message}`);
  }
} else {
  console.log(`  ${RED}✗${RESET} No Chromium binary found to check version`);
}
console.log('');

// ──────────────────────────────────────────────
// 5. Check Puppeteer configuration
// ──────────────────────────────────────────────
console.log(`${BOLD}📦 Puppeteer Configuration${RESET}`);
console.log('─────────────────────────────────────────');

try {
  const puppeteerrcPath = path.join(__dirname, '.puppeteerrc.cjs');
  if (fs.existsSync(puppeteerrcPath)) {
    const rcContent = fs.readFileSync(puppeteerrcPath, 'utf-8');
    const execPathMatch = rcContent.match(/executablePath:\s*['"](.+?)['"]/);
    if (execPathMatch) {
      const configuredPath = execPathMatch[1];
      const exists = fs.existsSync(configuredPath);
      console.log(`  .puppeteerrc.cjs executablePath: ${configuredPath}`);
      console.log(`  File exists: ${exists ? `${GREEN}✓ YES${RESET}` : `${RED}✗ NO${RESET}`}`);
    }
  } else {
    console.log(`  ${YELLOW}⚠${RESET} .puppeteerrc.cjs not found`);
  }
} catch (e) {
  console.log(`  ${YELLOW}⚠${RESET} Error reading .puppeteerrc.cjs: ${e.message}`);
}
console.log('');

// ──────────────────────────────────────────────
// 6. Check shared libraries
// ──────────────────────────────────────────────
console.log(`${BOLD}🔧 Shared Library Check${RESET}`);
console.log('─────────────────────────────────────────');

const criticalLibs = [
  'libnss3.so',
  'libnspr4.so',
  'libgbm.so.1',
  'libgtk-3.so.0',
  'libx11-xcb.so.1',
  'libxcomposite.so.1',
  'libxdamage.so.1',
  'libxrandr.so.2',
  'libasound.so.2',
  'libatk-bridge-2.0.so.0',
  'libcups.so.2',
  'libdrm.so.2',
  'libxss.so.1',
];

criticalLibs.forEach(lib => {
  try {
    const result = execSync(`ldconfig -p 2>/dev/null | grep -q "${lib}" && echo "found" || echo "not found"`).toString().trim();
    if (result === 'found') {
      console.log(`  ${GREEN}✓${RESET} ${lib}`);
    } else {
      // Try locating directly
      const findLib = execSync(`find /usr -name "${lib}" -type f 2>/dev/null | head -1`).toString().trim();
      if (findLib) {
        console.log(`  ${GREEN}✓${RESET} ${lib} (at ${findLib})`);
      } else {
        console.log(`  ${YELLOW}⚠${RESET} ${lib} — ${YELLOW}NOT FOUND${RESET} (may cause runtime errors)`);
      }
    }
  } catch (e) {
    console.log(`  ${YELLOW}⚠${RESET} ${lib} — could not check: ${e.message}`);
  }
});
console.log('');

// ──────────────────────────────────────────────
// 7. Summary
// ──────────────────────────────────────────────
console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
console.log(`${BOLD}${CYAN}  Summary  ${RESET}`);
console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);

const chromiumExists = commonPaths.some(p => fs.existsSync(p));
if (chromiumExists) {
  console.log(`  ${GREEN}✓ Chromium binary found${RESET}`);
  const puppeteerPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (puppeteerPath) {
    const pathExists = fs.existsSync(puppeteerPath);
    if (pathExists) {
      console.log(`  ${GREEN}✓ PUPPETEER_EXECUTABLE_PATH matches an existing file${RESET}`);
    } else {
      console.log(`  ${RED}✗ PUPPETEER_EXECUTABLE_PATH (${puppeteerPath}) does NOT exist!${RESET}`);
      console.log(`  ${YELLOW}⚠ Update PUPPETEER_EXECUTABLE_PATH to a valid path${RESET}`);
    }
  }
} else {
  console.log(`  ${RED}✗ NO Chromium binary found anywhere on the system!${RESET}`);
  console.log(`  ${RED}  → The Dockerfile apt-get install failed or package name is wrong.${RESET}`);
}

console.log('');