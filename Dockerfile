# Dockerfile optimizat pentru Coolify / Contabo VPS
# Folosește Chromium instalat via apt (evită descărcarea Puppeteer)
FROM node:20-slim

# Instalează Chromium și toate dependențele necesare pentru rulare stabilă
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

# Setează variabilele de mediu pentru Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NPM_CONFIG_PREFER_OFFLINE=true

# Instalează PM2 global
RUN npm install -g pm2

WORKDIR /app

# Copiază package.json și .puppeteerrc.cjs (pentru caching optimizat)
COPY package*.json ./
COPY .puppeteerrc.cjs ./

# Instalează dependențele de producție
RUN npm ci --only=production --no-audit --no-fund || npm install --only=production --no-audit --no-fund

# Copiază restul codului
COPY . .

# Creează directorul de loguri
RUN mkdir -p logs

# Healthcheck — verifică botul la fiecare 30s
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expune portul pentru healthcheck
EXPOSE 8080

# Folosește PM2 runtime pentru producție (restart automat la crash)
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
