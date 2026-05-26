# ════════════════════════════════════════════════════════════════
# Dockerfile — optimized for Coolify / Contabo VPS
# Installs Chromium via apt (NOT snap) for Puppeteer compatibility
# ════════════════════════════════════════════════════════════════

FROM node:20-slim

# ────────────────────────────────────────────────────────────────
# STEP 1: Install Chromium and all required system dependencies
# ────────────────────────────────────────────────────────────────
# Note on Debian Bookworm (node:20-slim base):
#   • The package is called 'chromium' (NOT 'chromium-browser')
#   • Binary is installed at /usr/bin/chromium
#   • 'chromium-browser' is a snap shim that FAILS in Docker — DO NOT use it
#   • If chromium isn't found in main repo, we add bookworm-backports as fallback
#
# On some Debian variants, chromium may be in backports. We try:
#   1. Main repo (chromium)
#   2. Backports (chromium) — if main repo version is missing

# First attempt — install from main repo
RUN apt-get update && apt-get install -y \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && echo "=== Attempt 1: Installing chromium from main repo ==="

# Verify chromium exists — if not, try backports
RUN if ! command -v chromium &> /dev/null && ! [ -f /usr/bin/chromium ]; then \
      echo "=== Chromium not found in main repo. Trying bookworm-backports... ===" && \
      echo "deb http://deb.debian.org/debian bookworm-backports main" >> /etc/apt/sources.list && \
      apt-get update && \
      apt-get install -y -t bookworm-backports \
        chromium \
        --no-install-recommends \
      && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "=== Chromium installed successfully from main repo ==="; \
    fi

# Final verification — find the actual chromium binary
RUN echo "=== Chromium binary search ===" && \
    CHROMIUM_PATH=$(command -v chromium || command -v chromium-browser || find /usr -name "chromium" -type f -executable 2>/dev/null | head -1) && \
    if [ -n "$CHROMIUM_PATH" ]; then \
      echo "✓ Chromium found at: $CHROMIUM_PATH"; \
      $CHROMIUM_PATH --version; \
    else \
      echo "✗ Chromium NOT found after all attempts!"; \
      echo "Searching entire filesystem..." && \
      find / -name "chromium*" -type f 2>/dev/null | head -10 || true; \
    fi

# If chromium is installed as 'chromium-browser' (unlikely but possible), symlink it
RUN if ! command -v chromium &> /dev/null && command -v chromium-browser &> /dev/null; then \
      echo "=== Creating symlink: chromium-browser -> chromium ===" && \
      ln -sf $(command -v chromium-browser) /usr/bin/chromium; \
    fi

# ────────────────────────────────────────────────────────────────
# STEP 2: Puppeteer configuration
# ────────────────────────────────────────────────────────────────
# Skip bundled Chromium download — use the system-installed one
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NPM_CONFIG_PREFER_OFFLINE=true

# ────────────────────────────────────────────────────────────────
# STEP 3: Install PM2 globally for process management
# ────────────────────────────────────────────────────────────────
RUN npm install -g pm2

WORKDIR /app

# ────────────────────────────────────────────────────────────────
# STEP 4: Install Node.js dependencies
# ────────────────────────────────────────────────────────────────
# Copy dependency files (optimized Docker layer caching)
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# Install production dependencies
RUN npm ci --only=production --no-audit --no-fund || npm install --only=production --no-audit --no-fund

# ────────────────────────────────────────────────────────────────
# STEP 5: Copy application source code
# ────────────────────────────────────────────────────────────────
COPY . .

# Create logs directory
RUN mkdir -p logs

# ────────────────────────────────────────────────────────────────
# STEP 6: Healthcheck
# ────────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose healthcheck port
EXPOSE 8080

# ────────────────────────────────────────────────────────────────
# STEP 7: Start with PM2 runtime (auto-restart on crash)
# ────────────────────────────────────────────────────────────────
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
