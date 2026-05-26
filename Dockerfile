# Dockerfile — optimized for Coolify / Contabo VPS
# Installs Chromium via apt (NOT snap) for Puppeteer compatibility
FROM node:20-slim

# Install Chromium and all required system dependencies
# Note: DO NOT use 'chromium-browser' — that's a snap shim that fails in Docker
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
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer config: use system Chromium, skip bundled download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NPM_CONFIG_PREFER_OFFLINE=true

# Install PM2 globally for process management
RUN npm install -g pm2

WORKDIR /app

# Copy dependency files (optimized Docker layer caching)
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# Install production dependencies
RUN npm ci --only=production --no-audit --no-fund || npm install --only=production --no-audit --no-fund

# Copy application source code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose healthcheck port
EXPOSE 8080

# Start with PM2 runtime (auto-restart on crash)
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
