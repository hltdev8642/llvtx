/**
 * Export / Import — serialize mod lists to JSON, generate HTML reports,
 * and import mod lists that validate and queue downloads.
 */
const path = require('path');
const { fs, util, selectors } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  infoLog,
  errorLog,
  normalizeVersion,
  sanitizeFileName,
} = require('./utils');
const { getVersionData } = require('./versionTracking');

// ─── Export ──────────────────────────────────────────────────────────────────

/**
 * Build the JSON-serialisable mod list for export.
 */
function buildExportData(state) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const vData = getVersionData(state);
  const entries = [];

  for (const [modId, mod] of Object.entries(mods)) {
    const source = mod.attributes?.source || '';
    if (!source.includes(LOVERSLAB_DOMAIN)) continue;

    entries.push({
      modId,
      name: mod.attributes?.name || modId,
      version: mod.attributes?.version || 'unknown',
      normalizedVersion: normalizeVersion(mod.attributes?.version),
      source,
      latestScraped: vData[modId]?.latestScraped || null,
      lastChecked: vData[modId]?.lastChecked || null,
    });
  }

  return {
    exportedAt: new Date().toISOString(),
    gameId: GAME_ID,
    modCount: entries.length,
    mods: entries,
  };
}

/**
 * Export the mod list to a JSON file.
 * @param {Object} api
 * @param {string} [filePath] - if not provided, prompts user
 */
async function exportToJson(api, filePath) {
  const state = api.getState();
  const data = buildExportData(state);

  if (!filePath) {
    const defaultName = `loverslab-mods-${new Date().toISOString().slice(0, 10)}.json`;
    const downloadsDir = api.getPath('download');
    filePath = path.join(downloadsDir, defaultName);
  }

  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json, 'utf-8');
  infoLog('Exported mod list to JSON', { filePath, count: data.modCount });

  api.sendNotification({
    id: 'llmm-export-json',
    type: 'success',
    title: 'Export Complete',
    message: `Exported ${data.modCount} mod(s) to ${path.basename(filePath)}`,
    displayMS: 5000,
  });

  return filePath;
}

/**
 * Generate an HTML report.
 */
function generateHtmlReport(data) {
  const rows = data.mods
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.version)}</td>
      <td>${m.latestScraped ? escapeHtml(m.latestScraped) : '—'}</td>
      <td><a href="${escapeHtml(m.source)}" target="_blank" rel="noopener noreferrer">Link</a></td>
    </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>LoversLab Mod Report — ${escapeHtml(data.exportedAt)}</title>
<style>
  body { font-family: 'Segoe UI', Tahoma, sans-serif; margin: 2rem; background: #1e1e2e; color: #cdd6f4; }
  h1 { color: #89b4fa; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #45475a; padding: 0.5rem 0.75rem; text-align: left; }
  th { background: #313244; color: #cba6f7; }
  tr:nth-child(even) { background: #181825; }
  a { color: #89dceb; }
  .meta { color: #a6adc8; font-size: 0.85rem; margin-top: 0.5rem; }
</style>
</head>
<body>
<h1>LoversLab Mod Report</h1>
<p class="meta">Generated: ${escapeHtml(data.exportedAt)} — ${data.modCount} mod(s)</p>
<table>
  <thead>
    <tr><th>Mod Name</th><th>Installed Version</th><th>Latest Scraped</th><th>Source</th></tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
</body>
</html>`;
}

/**
 * Export the mod list to an HTML report.
 */
async function exportToHtml(api, filePath) {
  const state = api.getState();
  const data = buildExportData(state);

  if (!filePath) {
    const defaultName = `loverslab-mods-${new Date().toISOString().slice(0, 10)}.html`;
    const downloadsDir = api.getPath('download');
    filePath = path.join(downloadsDir, defaultName);
  }

  const html = generateHtmlReport(data);
  fs.writeFileSync(filePath, html, 'utf-8');
  infoLog('Exported mod list to HTML', { filePath, count: data.modCount });

  api.sendNotification({
    id: 'llmm-export-html',
    type: 'success',
    title: 'HTML Report Generated',
    message: `Report with ${data.modCount} mod(s) saved to ${path.basename(filePath)}`,
    displayMS: 5000,
    actions: [
      {
        title: 'Open',
        action: () => util.opn(filePath).catch(() => {}),
      },
    ],
  });

  return filePath;
}

// ─── Import ──────────────────────────────────────────────────────────────────

/**
 * Validate an imported JSON object.
 */
function validateImportData(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('Invalid JSON structure');
    return { valid: false, errors };
  }
  if (!Array.isArray(data.mods)) {
    errors.push('Missing "mods" array');
    return { valid: false, errors };
  }
  for (let i = 0; i < data.mods.length; i++) {
    const m = data.mods[i];
    if (!m.source || !m.source.includes(LOVERSLAB_DOMAIN)) {
      errors.push(`Mod at index ${i} has invalid source URL`);
    }
    if (!m.name) {
      errors.push(`Mod at index ${i} is missing a name`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Import a mod list from JSON and tag matching installed mods, or queue downloads.
 * @param {Object} api
 * @param {string} filePath - path to JSON file
 */
async function importFromJson(api, filePath) {
  let rawData;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    rawData = JSON.parse(content);
  } catch (err) {
    api.sendNotification({
      id: 'llmm-import-fail',
      type: 'error',
      title: 'Import Failed',
      message: `Could not parse file: ${err.message}`,
      displayMS: 5000,
    });
    return;
  }

  const { valid, errors } = validateImportData(rawData);
  if (!valid) {
    api.sendNotification({
      id: 'llmm-import-invalid',
      type: 'error',
      title: 'Invalid Import File',
      message: errors.join('; '),
      displayMS: 8000,
    });
    return;
  }

  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  let tagged = 0;
  let notFound = 0;
  const missingMods = [];

  for (const entry of rawData.mods) {
    // Try to find the mod by exact ID first
    let mod = mods[entry.modId];

    // Fall back to name match
    if (!mod) {
      const nameLower = (entry.name || '').toLowerCase();
      mod = Object.values(mods).find(
        (m) => (m.attributes?.name || '').toLowerCase() === nameLower,
      );
    }

    if (mod) {
      // Tag the mod with the LoversLab source
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId: mod.id, attribute: 'source', value: entry.source },
      });
      if (entry.version) {
        api.store.dispatch({
          type: 'SET_MOD_ATTRIBUTE',
          payload: { gameId: GAME_ID, modId: mod.id, attribute: 'version', value: entry.version },
        });
      }
      tagged++;
    } else {
      notFound++;
      missingMods.push(entry);
    }
  }

  let message = `Tagged ${tagged} installed mod(s).`;
  if (notFound > 0) {
    message += ` ${notFound} mod(s) not found locally.`;
  }

  const actions = [];
  if (missingMods.length > 0) {
    actions.push({
      title: 'Open Missing in Browser',
      action: () => {
        missingMods.forEach((m) => {
          if (m.source) util.opn(m.source).catch(() => {});
        });
      },
    });
  }

  api.sendNotification({
    id: 'llmm-import-done',
    type: 'success',
    title: 'Import Complete',
    message,
    displayMS: 8000,
    actions,
  });

  infoLog('Import complete', { tagged, notFound, total: rawData.mods.length });
}

// ─── HTML Helper ─────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  buildExportData,
  exportToJson,
  exportToHtml,
  generateHtmlReport,
  validateImportData,
  importFromJson,
};
