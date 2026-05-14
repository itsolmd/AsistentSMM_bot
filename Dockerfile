# Dockerfile
FROM node:20

# Install PM2 globally
RUN npm install -g pm2

WORKDIR /app

COPY package*.json ./
RUN npm install

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
