/**
 * Update checking — orchestrates version scraping against installed mods,
 * with concurrency limiting, progress tracking, and notification integration.
 */
const { util } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  infoLog,
  errorLog,
  compareVersions,
  normalizeVersion,
  getSettings,
  sleep,
} = require('./utils');
const { fetchModPage, fetchDownloadUrl } = require('./scraper');
const { recordVersion } = require('./versionTracking');

// ─── Concurrency Limiter ─────────────────────────────────────────────────────

/**
 * Process an array of tasks with a concurrency limit.
 * @param {Array} items
 * @param {number} concurrency
 * @param {function} fn - async (item, index) => result
 * @param {function} [onProgress] - (completed, total) => void
 * @returns {Promise<Array>}
 */
async function mapWithConcurrency(items, concurrency, fn, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err.message };
      }
      completed++;
      if (onProgress) onProgress(completed, items.length);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ─── Single-Mod Check ────────────────────────────────────────────────────────

/**
 * Check a single mod for updates.
 * Returns an update descriptor or null.
 */
async function checkSingleMod(api, mod, settings) {
  const modUrl = mod.attributes?.source;
  if (!modUrl || !modUrl.includes(LOVERSLAB_DOMAIN)) return null;

  debugLog('Checking mod', { modId: mod.id, modUrl });

  const pageData = await fetchModPage(modUrl, settings);

  if (!pageData.version) {
    debugLog('No version found on page', { modId: mod.id });
    return null;
  }

  // Record scraped version in tracking store
  recordVersion(api, mod.id, pageData.version, modUrl);

  const currentVersion = normalizeVersion(mod.attributes?.version);
  const latestVersion = normalizeVersion(pageData.version);
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  if (!hasUpdate) {
    debugLog('Mod is up to date', { modId: mod.id, currentVersion, latestVersion });
    return null;
  }

  infoLog('Update available', {
    modId: mod.id,
    name: mod.attributes?.name,
    currentVersion,
    latestVersion,
  });

  // Fetch download URL
  let downloadUrl = null;
  let downloadInfo = null;
  try {
    downloadInfo = await fetchDownloadUrl(modUrl, settings);
    downloadUrl = downloadInfo?.downloadUrl || null;
  } catch (err) {
    debugLog('Failed to fetch download URL', { modId: mod.id, error: err.message });
  }

  return {
    modId: mod.id,
    modName: mod.attributes?.name || mod.id,
    modUrl,
    currentVersion,
    latestVersion,
    rawLatestVersion: pageData.version,
    downloadUrl,
    downloadPageUrl: downloadInfo?.downloadPageUrl || null,
    allLinks: downloadInfo?.allLinks || [],
    title: pageData.title,
    dependencies: pageData.dependencies,
    checkedAt: Date.now(),
  };
}

// ─── Batch Check ─────────────────────────────────────────────────────────────

/**
 * Check all LoversLab mods for the active game.
 * @param {Object} api - Vortex API
 * @param {boolean} forceFull - If true, show UI feedback even when no updates found
 * @param {Object} [cancelToken] - { cancelled: boolean } — set cancelled=true to abort
 * @returns {Promise<Object[]>} - Array of update descriptors
 */
async function checkAllMods(api, forceFull = false, cancelToken = { cancelled: false }) {
  const state = api.getState();
  const settings = getSettings(state);
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});

  const llMods = Object.values(mods).filter((mod) => {
    const source = mod.attributes?.source || '';
    return source.includes(LOVERSLAB_DOMAIN);
  });

  if (llMods.length === 0) {
    if (forceFull) {
      api.sendNotification({
        id: 'llmm-no-mods',
        type: 'info',
        title: 'LoversLab Mod Manager',
        message: 'No LoversLab mods detected. Use "Set LoversLab Source" to tag mods.',
        displayMS: 5000,
      });
    }
    return [];
  }

  // Show progress notification
  const progressId = 'llmm-check-progress';
  if (forceFull || settings.showNotifications) {
    api.sendNotification({
      id: progressId,
      type: 'activity',
      title: 'Checking LoversLab Updates',
      message: `Checking ${llMods.length} mod(s)...`,
      noDismiss: true,
      progress: 0,
    });
  }

  const updates = [];

  const results = await mapWithConcurrency(
    llMods,
    settings.maxConcurrentChecks || 3,
    async (mod) => {
      if (cancelToken.cancelled) return null;
      try {
        return await checkSingleMod(api, mod, settings);
      } catch (err) {
        errorLog(`Failed checking mod ${mod.id}`, { error: err.message });
        return null;
      }
    },
    (completed, total) => {
      const pct = Math.round((completed / total) * 100);
      api.sendNotification({
        id: progressId,
        type: 'activity',
        title: 'Checking LoversLab Updates',
        message: `Checked ${completed}/${total} mod(s)...`,
        noDismiss: true,
        progress: pct,
      });
    },
  );

  // Dismiss progress
  api.dismissNotification(progressId);

  // Collect non-null update results
  for (const r of results) {
    if (r && !r.error && r.latestVersion) {
      updates.push(r);
    }
  }

  infoLog(`Update check complete: ${updates.length} update(s) found out of ${llMods.length} mod(s)`);

  if (updates.length === 0 && forceFull) {
    api.sendNotification({
      id: 'llmm-no-updates',
      type: 'info',
      title: 'LoversLab Updates',
      message: 'All LoversLab mods are up to date.',
      displayMS: 5000,
    });
  }

  return updates;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  checkSingleMod,
  checkAllMods,
  mapWithConcurrency,
};
