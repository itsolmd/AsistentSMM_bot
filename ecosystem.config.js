/**
 * ════════════════════════════════════════════════════════════════
 *  PM2 ECOSYSTEM CONFIG — Process Manager Configuration
 * ════════════════════════════════════════════════════════════════
 *
 *  Nivelul 1 de protecție: Process Manager (PM2)
 *    • Restart automat la crash
 *    • Monitorizare memorie și CPU
 *    • Loguri centralizate
 *    • Max memory restart
 *    • Graceful shutdown
 *
 *  Folosește: pm2 start ecosystem.config.js
 *  Pentru monitoring: pm2 monit
 *  Pentru logs: pm2 logs
 * ════════════════════════════════════════════════════════════════ */

module.exports = {
  apps: [
    {
      name: "asistent-smm-bot",
      script: "index.js",

      // Node.js options
      node_args: "--expose-gc", // Enable garbage collection

      // Restart behavior
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000, // Wait 3s between restarts
      min_uptime: 10000, // Consider process stable after 10s

      // Memory limit — restart if exceeded
      max_memory_restart: "800M",

      // Watch for file changes (disabled in production)
      watch: false,

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: "production",
        PM2: "true",
      },

      // Graceful shutdown
      kill_timeout: 5000, // Wait 5s for graceful shutdown
      listen_timeout: 15000, // Wait 15s for app to listen

      // Exponential backoff for restarts
      exp_backoff_restart_delay: 100,

      // Do not start more than 1 instance (Telegram bot)
      instances: 1,
      exec_mode: "fork",
    },
  ],
};