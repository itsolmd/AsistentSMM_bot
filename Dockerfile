# Optimized Dockerfile with Chromium via apt (no Puppeteer download)
FROM node:20-bookworm-slim

# Install Chromium and dependencies for Puppeteer via apt (cached at OS layer)
RUN apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  libxshmfence-dev \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to skip its own Chromium download
ENV PUPPETEER_SKIP_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
  NPM_CONFIG_PREFER_OFFLINE=true

# Install PM2 globally
RUN npm install -g pm2

WORKDIR /app

# Copy only package files first (for layer caching)
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# npm ci with cache optimization — no audit/no fund for speed
RUN npm ci --prefer-offline --no-audit --no-fund

# Copy rest of the application
COPY . .

# Create log directory
RUN mkdir -p logs

# Healthcheck — verify the bot is alive every 30s
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose healthcheck port
EXPOSE 8080

# Use PM2 runtime for production (auto-restart on crash)
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
