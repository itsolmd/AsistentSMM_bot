/**
 * ════════════════════════════════════════════════════════════════
 * utils/summaryBuilder.js — Single Summary Message Builder
 * ════════════════════════════════════════════════════════════════
 *
 * Construiește un UNIC mesaj rezumat care conține TOATE
 * rezultatele postării pe toate platformele simultan.
 *
 * Principiu: UN SINGUR mesaj de confirmare cu toate rezultatele,
 * în loc de mesaje separate pentru fiecare platformă.
 * ════════════════════════════════════════════════════════════════ */

/**
 * buildPipelineSummary — Construiește rezumatul pipeline-ului
 *
 * @param {Object} data - Datele anunțului
 * @param {Object} results - Rezultatele postării per platformă
 * @param {Object} options - Opțiuni suplimentare
 * @returns {string} Mesajul formatat
 */
function buildPipelineSummary(data, results = {}, options = {}) {
  const {
    durationMs = 0,
    aiEnhanced = false,
    floorSource = 'N/A',
    deduplicationSkipped = false,
  } = options;

  const lines = [];
  const separator = '─'.repeat(35);

  // ── Header ──
  lines.push('═══════════════════════════════════════');
  lines.push('📋 *RAPORT FINAL — PUBLICARE ANUNȚ*');
  lines.push('═══════════════════════════════════════');
  lines.push('');

  // ── Property Info ──
  lines.push('*🏠 Date anunț:*');
  if (data.type) lines.push(`  • Tip: \`${data.type}\``);
  if (data.price) lines.push(`  • Preț: \`${data.price}\``);
  if (data.rooms || data.area) {
    const parts = [];
    if (data.rooms && data.rooms !== 'N/A') parts.push(`${data.rooms} cameră${parseInt(data.rooms) > 1 ? 'e' : ''}`);
    if (data.area && data.area !== 'N/A') parts.push(`${data.area} m²`);
    if (parts.length) lines.push(`  • ${parts.join(', ')}`);
  }
  if (data.floor || data.floors) {
    const floorT = data.floor && data.floor !== 'N/A' ? data.floor : '?';
    const floorsT = data.floors && data.floors !== 'N/A' ? data.floors : '?';
    lines.push(`  • Etaj: \`${floorT}/${floorsT}\` (${floorSource})`);
  }
  if (data.location || data.regionText) {
    lines.push(`  • Locație: \`${data.location || data.regionText}\``);
  }
  lines.push('');

  // ── AI Enhancement Info ──
  if (aiEnhanced) {
    lines.push('*🧠 AI Enhancement:*');
    lines.push('  ✅ Date completate/îmbunătățite cu AI');
    lines.push('');
  }

  // ── Deduplication ──
  if (deduplicationSkipped) {
    lines.push('*⛔ Deduplicare:*');
    lines.push('  Anunțul a fost deja postat (skip automat)');
    lines.push('');
  }

  // ── Posting Results ──
  lines.push('*📤 Rezultate publicare:*');
  lines.push(`${separator}`);

  const platformNames = {
    'meta': '📘 Facebook/Instagram',
    'facebook': '📘 Facebook',
    'instagram': '📸 Instagram',
    'premier': '🏠 Premierimobil.md',
    '999': '🔢 999.md',
    'all': '📋 Toate platformele',
  };

  const platformIcons = {
    'success': '✅',
    'failed': '❌',
    'crashed': '💥',
    'skipped': '⏭️',
    'pending': '⏳',
  };

  // Process results
  const sortedPlatforms = ['meta', 'facebook', 'instagram', 'premier', '999'];
  let hasAnySuccess = false;

  for (const platform of sortedPlatforms) {
    const result = results[platform];
    if (!result) continue;

    const name = platformNames[platform] || platform;
    let statusText;
    let statusIcon;

    if (typeof result === 'string') {
      statusIcon = platformIcons[result] || '❓';
      statusText = result;
      if (result === 'success') hasAnySuccess = true;
    } else if (result === true) {
      statusIcon = '✅';
      statusText = 'success';
      hasAnySuccess = true;
    } else if (result === false) {
      statusIcon = '❌';
      statusText = 'failed';
    } else if (typeof result === 'object') {
      if (result.fb || result.link) {
        statusIcon = '✅';
        statusText = 'success';
        hasAnySuccess = true;
      } else if (result.error) {
        statusIcon = '❌';
        statusText = `error: ${result.error.slice(0, 100)}`;
      } else {
        statusIcon = '❓';
        statusText = JSON.stringify(result).slice(0, 100);
      }
    }

    let line = `  ${statusIcon} **${name}**: ${statusText}`;
    if (result?.fb) line += `\n    ├ 🔗 [Facebook Post](${result.fb})`;
    if (result?.inst) line += `\n    └ 🔗 [Instagram Post](${result.inst})`;
    if (result?.link) line += `\n    └ 🔗 [Postare](${result.link})`;

    lines.push(line);
  }

  lines.push(`${separator}`);
  lines.push('');

  // ── Stats ──
  lines.push('*📊 Statistici:*');
  const successCount = Object.values(results).filter(r =>
    r === 'success' || r === true || (typeof r === 'object' && (r.fb || r.link))
  ).length;
  const totalCount = Object.keys(results).length;
  lines.push(`  • Reușite: \`${successCount}/${totalCount}\``);
  lines.push(`  • Durată totală: \`${(durationMs / 1000).toFixed(1)}s\``);
  lines.push(`  • Link original: [${data.link || 'Anunț'}](${data.link || '#'})`);
  lines.push('');

  // ── Footer ──
  if (hasAnySuccess) {
    lines.push('✅ *Publicare finalizată cu succes!*');
  } else {
    lines.push('⚠️ *Publicarea a eșuat pe toate platformele.*');
  }
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}

/**
 * buildAutoRepairSummary — Rezumatul acțiunilor de auto-reparare
 *
 * @param {Array} repairs - Lista reparațiilor efectuate
 * @returns {string} Mesajul formatat
 */
function buildAutoRepairSummary(repairs) {
  if (!repairs || repairs.length === 0) return '';

  const lines = [];
  lines.push('');
  lines.push('🔧 *Auto-repair actions:*');
  lines.push('─'.repeat(25));

  for (const repair of repairs.slice(-5)) {
    lines.push(`  • \`${repair.action}\`: ${repair.message || 'N/A'}`);
  }

  lines.push('─'.repeat(25));
  return lines.join('\n');
}

/**
 * buildShortStatus — Status scurt pentru notificări rapide
 *
 * @param {Object} data - Datele anunțului
 * @param {string} platform - Platforma vizată
 * @param {string} status - Statusul ('success', 'failed', etc.)
 * @returns {string} Mesajul scurt
 */
function buildShortStatus(data, platform, status) {
  const platformEmoji = {
    'meta': '📘',
    'facebook': '📘',
    'instagram': '📸',
    'premier': '🏠',
    '999': '🔢',
  };

  const statusEmoji = {
    'success': '✅',
    'failed': '❌',
    'crashed': '💥',
    'skipped': '⏭️',
  };

  const emoji = platformEmoji[platform] || '📋';
  const statusIcon = statusEmoji[status] || '❓';

  return `${statusIcon} ${emoji} *${platform.toUpperCase()}*: ${status} | ${data.type || 'N/A'} | ${data.price || 'N/A'}`;
}

module.exports = {
  buildPipelineSummary,
  buildAutoRepairSummary,
  buildShortStatus,
};