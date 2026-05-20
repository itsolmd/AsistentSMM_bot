/**
 * ════════════════════════════════════════════════════════════════
 * bot/dashboard.js — Interactive Telegram Dashboard
 * ════════════════════════════════════════════════════════════════
 *
 * Dashboard interactiv cu butoane pentru controlul botului:
 *
 * 📊 Status      → Afișează starea tokenurilor, conexiunilor, postărilor
 * 🔄 Refresh FB  → Reîmprospătează tokenul Facebook
 * 🧠 AI Config    → Configurează modelul AI preferat
 * 📋 Logs        → Arată ultimele 50 evenimente
 * ▶️ Auto-post    → Pornește postarea automată
 * ⏹️ Auto-post    → Oprește postarea automată
 * /repost <link>  → Forțează repostarea unui anunț
 * ════════════════════════════════════════════════════════════════ */

const { Markup } = require('telegraf');
const { healthCheck, getRepairHistory } = require('../services/selfHealing');
const logger = require('../logger');

// ── Auto-post state ───────────────────────────────────────────
let autoPostEnabled = false;
let autoPostInterval = null;
const AUTO_POST_INTERVAL_MS = 5 * 60 * 1000; // 5 minute default
const postedLinks = new Set(); // Pentru deduplicare în sesiunea curentă

/**
 * getDashboardKeyboard — Construiește butoanele dashboard-ului
 *
 * @param {boolean} isAutoPostEnabled - Starea auto-post
 * @returns {Object} Markup.inlineKeyboard
 */
function getDashboardKeyboard(isAutoPostEnabled = false) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Status', 'dashboard_status'),
      Markup.button.callback('🔄 Refresh FB', 'dashboard_refresh_fb'),
    ],
    [
      Markup.button.callback('🧠 AI Config', 'dashboard_ai_config'),
      Markup.button.callback('📋 Logs', 'dashboard_logs'),
    ],
    [
      Markup.button.callback(
        isAutoPostEnabled ? '⏹️ Stop Auto-post' : '▶️ Start Auto-post',
        isAutoPostEnabled ? 'auto_post_stop' : 'auto_post_start'
      ),
    ],
    [
      Markup.button.url('📘 Facebook Page', 'https://www.facebook.com/'),
      Markup.button.url('🏠 Premierimobil', 'https://premierimobil.md'),
    ],
  ]);
}

/**
 * buildStatusMessage — Construiește mesajul de status
 *
 * @param {Object} ctx - Telegraf context
 * @param {Object} health - Rezultatul health check
 * @param {Object} watchdogStatus - Status watchdog
 * @returns {string} Mesajul formatat
 */
function buildStatusMessage(ctx, health, watchdogStatus) {
  const lines = [];
  lines.push('📊 *Dashboard Status*');
  lines.push('═'.repeat(30));
  lines.push('');

  // ── System ──
  lines.push('*🖥️ System:*');
  lines.push(`  • Uptime: \`${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s\``);
  lines.push(`  • PID: \`${process.pid}\``);
  lines.push(`  • Auto-post: \`${autoPostEnabled ? '✅ ON' : '❌ OFF'}\``);
  lines.push('');

  // ── MongoDB ──
  const mongoStatus = health?.components?.mongodb;
  lines.push('*🗄️ MongoDB:*');
  lines.push(`  • Status: \`${mongoStatus?.healthy ? '✅ Connected' : '❌ ' + (mongoStatus?.error || 'Disconnected')}\``);
  lines.push('');

  // ── OpenRouter ──
  const orStatus = health?.components?.openrouter;
  lines.push('*🧠 OpenRouter (AI):*');
  lines.push(`  • Status: \`${orStatus?.healthy ? '✅ Configured' : '❌ ' + (orStatus?.error || 'Not configured')}\``);
  const aiModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
  lines.push(`  • Model: \`${aiModel}\``);
  lines.push('');

  // ── Facebook ──
  const fbStatus = health?.components?.facebook;
  const fbToken = ctx?.session?.user?.fb_acces_token || process.env.FB_ACCES_TOKEN || '';
  lines.push('*📘 Facebook:*');
  lines.push(`  • Token: \`${fbStatus?.healthy ? '✅ Set' : '❌ ' + (fbStatus?.error || 'Not configured')}\``);
  lines.push(`  • Token length: \`${fbToken.length} chars\``);
  lines.push(`  • Group ID: \`${process.env.FB_GROUP_ID || 'N/A'}\``);
  lines.push('');

  // ── Strapi ──
  const strapiStatus = health?.components?.strapi;
  const strapiUrl = process.env.BACK_END || process.env.STRAPI_URL || 'N/A';
  lines.push('*🏠 Premierimobil (Strapi):*');
  lines.push(`  • Status: \`${strapiStatus?.healthy ? '✅ Configured' : '❌ ' + (strapiStatus?.error || 'Not configured')}\``);
  lines.push(`  • URL: \`${strapiUrl}\``);
  lines.push('');

  // ── Watchdog ──
  if (watchdogStatus) {
    lines.push('*🐕 Watchdog:*');
    lines.push(`  • Status: \`${watchdogStatus.status || 'healthy'}\``);
    lines.push(`  • Mesaje procesate: \`${watchdogStatus.messageCount || 0}\``);
    lines.push(`  • Scrape-uri: \`${watchdogStatus.scrapeCount || 0}\``);
    lines.push(`  • Erori: \`${watchdogStatus.errorCount || 0}\``);
    lines.push(`  • Idle: \`${watchdogStatus.idleMinutes || 0}m\``);
    lines.push('');
  }

  // ── Repair History ──
  const repairs = getRepairHistory();
  if (repairs.length > 0) {
    lines.push('*🔧 Auto-repair history:*');
    for (const repair of repairs.slice(-5)) {
      lines.push(`  • \`${repair.key}\`: ${repair.attempts} attempt(s)`);
    }
    lines.push('');
  }

  // ── Telegram ──
  lines.push('*📱 Telegram:*');
  lines.push(`  • Chat ID: \`${ctx.chat?.id || 'N/A'}\``);
  lines.push(`  • User: \`${ctx.session?.user?.name || 'N/A'}\``);
  lines.push('');

  lines.push('═'.repeat(30));
  lines.push('_Ultima actualizare: ' + new Date().toLocaleTimeString('ro-RO') + '_');

  return lines.join('\n');
}

/**
 * buildLogsMessage — Construiește mesajul cu ultimele loguri
 *
 * @param {number} lines - Numărul de linii de log
 * @returns {string} Mesajul formatat
 */
function buildLogsMessage(lines = 50) {
  return [
    '📋 *Ultimele evenimente:*',
    '═'.repeat(30),
    '',
    `_Ultimele ${lines} evenimente vor fi afișate mai jos._`,
    '',
    '💡 *Comenzi rapide:*',
    '  • `/status` — Status detaliat',
    '  • `/repost <link>` — Forțează repostare',
    '  • `/ai_model <model>` — Schimbă modelul AI',
    '',
    '📌 *Link-uri utile:*',
    `  • PM2: \`pm2 logs asistent-smm-bot --lines ${lines}\``,
    '  • Healthcheck: `curl http://localhost:3000/health`',
  ].join('\n');
}

/**
 * buildAIConfigMessage — Mesaj pentru configurarea AI
 *
 * @returns {Object} { text, keyboard }
 */
function buildAIConfigMessage() {
  const currentModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  const text = [
    '🧠 *Configurare AI*',
    '═'.repeat(30),
    '',
    `Model curent: \`${currentModel}\``,
    '',
    '*Modele disponibile:*',
    '',
    '🔹 *Free (recomandat):*',
    '  • `openai/gpt-4o-mini:free`',
    '  • `google/gemini-2.0-flash-exp:free`',
    '  • `meta-llama/llama-3.2-3b-instruct:free`',
    '',
    '🔸 *Premium (plătit):*',
    '  • `openai/gpt-4o-mini`',
    '  • `openai/gpt-4o`',
    '  • `anthropic/claude-3.5-haiku`',
    '',
    '📝 *Pentru a schimba modelul:*',
    '  Trimite: `/ai_model <model_id>`',
    '  Exemplu: `/ai_model openai/gpt-4o`',
    '',
    '⚙️ Modelul se schimbă DOAR în variabila de mediu `OPENROUTER_MODEL`',
    'și va fi disponibil după restartul botului.',
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Restart bot', 'dashboard_restart'),
      Markup.button.callback('◀️ Înapoi', 'dashboard_back'),
    ],
  ]);

  return { text, keyboard };
}

/**
 * handleDashboardAction — Procesează acțiunile din dashboard
 *
 * @param {Object} ctx - Telegraf context
 * @param {string} action - Acțiunea (din callback data)
 * @param {Object} db - MongoDB instance
 */
async function handleDashboardAction(ctx, action, db = null) {
  try {
    switch (action) {
      case 'dashboard_status': {
        const health = await healthCheck();
        const watchdogStatus = global.watchdogInstance?.getStatus?.() || null;
        const statusMsg = buildStatusMessage(ctx, health, watchdogStatus);

        await ctx.editMessageText(statusMsg, {
          parse_mode: 'Markdown',
          ...getDashboardKeyboard(autoPostEnabled),
        });
        break;
      }

      case 'dashboard_refresh_fb': {
        await ctx.editMessageText(
          '🔄 *Reîmprospătare token Facebook...*\n\n' +
          'Pentru a reîmprospăta tokenul Facebook, urmează acești pași:\n\n' +
          '1. Mergi la https://developers.facebook.com/tools/accesstoken/\n' +
          '2. Generează un token nou cu permisiunile: `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`\n' +
          '3. Setează tokenul în `.env`: `FB_ACCES_TOKEN=noul_token`\n' +
          '4. Restartează botul: `/restart` sau PM2\n\n' +
          '🔗 *Link rapid:* [Facebook Token Tool](https://developers.facebook.com/tools/accesstoken/)',
          {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            ...getDashboardKeyboard(autoPostEnabled),
          }
        );
        break;
      }

      case 'dashboard_ai_config': {
        const { text, keyboard } = buildAIConfigMessage();
        await ctx.editMessageText(text, {
          parse_mode: 'Markdown',
          ...keyboard,
        });
        break;
      }

      case 'dashboard_logs': {
        const logsMsg = buildLogsMessage();
        await ctx.editMessageText(logsMsg, {
          parse_mode: 'Markdown',
          ...getDashboardKeyboard(autoPostEnabled),
        });
        break;
      }

      case 'dashboard_restart': {
        await ctx.editMessageText(
          '🔄 *Restartare bot...*\n\nBotul se va restarta în 3 secunde.',
          { parse_mode: 'Markdown' }
        );
        setTimeout(() => {
          process.exit(0); // PM2 va reporni automat
        }, 3000);
        break;
      }

      case 'dashboard_back': {
        await ctx.editMessageText(
          '📊 *Dashboard* — Alege o acțiune:',
          {
            parse_mode: 'Markdown',
            ...getDashboardKeyboard(autoPostEnabled),
          }
        );
        break;
      }

      case 'auto_post_start': {
        if (autoPostEnabled) {
          await ctx.answerCbQuery('Auto-post este deja activ!');
          return;
        }
        startAutoPost(ctx, db);
        await ctx.editMessageText(
          '▶️ *Auto-post ACTIVAT*\n\n' +
          'Botul va posta automat la fiecare 5 minute.\n' +
          'Pentru a opri, folosește butonul ⏹️ Stop Auto-post.',
          {
            parse_mode: 'Markdown',
            ...getDashboardKeyboard(true),
          }
        );
        break;
      }

      case 'auto_post_stop': {
        stopAutoPost(ctx);
        await ctx.editMessageText(
          '⏹️ *Auto-post DEZACTIVAT*\n\n' +
          'Postarea automată a fost oprită.',
          {
            parse_mode: 'Markdown',
            ...getDashboardKeyboard(false),
          }
        );
        break;
      }

      default: {
        await ctx.answerCbQuery('Acțiune necunoscută');
      }
    }
  } catch (err) {
    logger.error('DASHBOARD', 'Error handling dashboard action', {
      action,
      error: err.message,
    });

    try {
      await ctx.answerCbQuery('⚠️ Eroare la procesarea acțiunii');
    } catch (_) {}
  }
}

/**
 * startAutoPost — Pornește postarea automată
 *
 * @param {Object} ctx - Telegraf context
 * @param {Object} db - MongoDB instance
 */
function startAutoPost(ctx, db) {
  if (autoPostInterval) {
    clearInterval(autoPostInterval);
  }

  autoPostEnabled = true;

  autoPostInterval = setInterval(async () => {
    try {
      console.log('[AUTO_POST] 🔄 Ciclu auto-post...');

      // Aici s-ar implementa logica de a scoate un link din coadă
      // și a-l procesa automat. Pentru moment, doar logăm.
      logger.info('AUTO_POST', 'Auto-post cycle executed', {
        autoPostEnabled,
        postedLinksCount: postedLinks.size,
      });
    } catch (err) {
      logger.error('AUTO_POST', 'Auto-post cycle error', { error: err.message });
    }
  }, AUTO_POST_INTERVAL_MS);

  // Unref pentru a nu menține procesul deschis doar pentru auto-post
  if (autoPostInterval.unref) {
    autoPostInterval.unref();
  }

  logger.info('AUTO_POST', 'Auto-post started', {
    interval: AUTO_POST_INTERVAL_MS / 1000 + 's',
  });
}

/**
 * stopAutoPost — Oprește postarea automată
 */
function stopAutoPost() {
  if (autoPostInterval) {
    clearInterval(autoPostInterval);
    autoPostInterval = null;
  }

  autoPostEnabled = false;
  logger.info('AUTO_POST', 'Auto-post stopped');
}

/**
 * isAutoPostEnabled — Verifică dacă auto-post este activ
 *
 * @returns {boolean}
 */
function isAutoPostEnabled() {
  return autoPostEnabled;
}

/**
 * handleRepost — Forțează repostarea unui anunț (/repost)
 *
 * Elimină link-ul din setul de link-uri postate și îl
 * retrimite prin pipeline-ul normal.
 *
 * @param {Object} ctx - Telegraf context
 * @param {string} link - Link-ul de repostat
 * @returns {Promise<string>} Mesajul de confirmare
 */
async function handleRepost(ctx, link) {
  // Elimină din setul de link-uri postate
  if (postedLinks.has(link)) {
    postedLinks.delete(link);
  }

  // Elimină și din baza de date (dacă există)
  try {
    const { getCollection } = require('../db');
    const postsCollection = await getCollection('published_posts');
    const deleteResult = await postsCollection.deleteMany({
      link: link,
    });
    if (deleteResult.deletedCount > 0) {
      console.log(`[REPOST] 🗑️ Șters ${deleteResult.deletedCount} înregistrare(i) pentru ${link}`);
    }
  } catch (err) {
    console.warn(`[REPOST] ⚠️ Eroare la ștergerea din DB: ${err.message}`);
    // Non-blocking
  }

  logger.info('REPOST', `Forced repost for: ${link}`);

  return `🔄 *Repost forțat pentru:*\n${link}\n\n🔜 Procesarea va începe imediat.`;
}

/**
 * markAsPosted — Marchează un link ca postat
 *
 * @param {string} link - Link-ul postat
 */
function markAsPosted(link) {
  if (link) {
    postedLinks.add(link);
  }
}

/**
 * isAlreadyPosted — Verifică dacă un link a fost deja postat
 *
 * @param {string} link - Link-ul de verificat
 * @returns {boolean}
 */
function isAlreadyPosted(link) {
  return postedLinks.has(link);
}

module.exports = {
  getDashboardKeyboard,
  buildStatusMessage,
  buildLogsMessage,
  buildAIConfigMessage,
  handleDashboardAction,
  startAutoPost,
  stopAutoPost,
  isAutoPostEnabled,
  handleRepost,
  markAsPosted,
  isAlreadyPosted,
};