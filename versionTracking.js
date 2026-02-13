/**
 * Version tracking — persists version history per mod and computes status badges.
 */
const { util } = require('vortex-api');
const {
  GAME_ID,
  EXTENSION_ID,
  MOD_STATUS,
  debugLog,
  compareVersions,
  normalizeVersion,
  parseVersion,
} = require('./utils');

// ─── Reducers ────────────────────────────────────────────────────────────────

const versionTrackingReducer = {
  reducers: {
    /**
     * Record a scraped version for a mod.
     * payload: { modId, version, scrapedAt, source }
     */
    LLMM_RECORD_VERSION: (state, payload) => {
      const { modId, version, scrapedAt, source } = payload;
      const existing = state[modId] || { history: [], latestScraped: null };
      const entry = {
        version: normalizeVersion(version),
        raw: version,
        scrapedAt: scrapedAt || Date.now(),
        source: source || '',
      };

      // Avoid duplicate consecutive entries
      const last = existing.history[existing.history.length - 1];
      if (last && last.version === entry.version) {
        return state; // no change
      }

      const history = [...existing.history, entry].slice(-50); // keep last 50
      return {
        ...state,
        [modId]: {
          ...existing,
          history,
          latestScraped: entry.version,
          lastChecked: entry.scrapedAt,
        },
      };
    },

    /**
     * Clear history for a single mod.
     */
    LLMM_CLEAR_VERSION_HISTORY: (state, payload) => {
      const next = { ...state };
      delete next[payload.modId];
      return next;
    },

    /**
     * Clear all version tracking data.
     */
    LLMM_CLEAR_ALL_VERSION_DATA: () => ({}),
  },
  defaults: {},
};

// ─── Actions (dispatchers) ───────────────────────────────────────────────────

function recordVersion(api, modId, version, source) {
  api.store.dispatch({
    type: 'LLMM_RECORD_VERSION',
    payload: { modId, version, scrapedAt: Date.now(), source },
  });
}

function clearVersionHistory(api, modId) {
  api.store.dispatch({
    type: 'LLMM_CLEAR_VERSION_HISTORY',
    payload: { modId },
  });
}

function clearAllVersionData(api) {
  api.store.dispatch({ type: 'LLMM_CLEAR_ALL_VERSION_DATA', payload: {} });
}

// ─── Selectors ───────────────────────────────────────────────────────────────

/**
 * Retrieve the version-tracking slice from state.
 */
function getVersionData(state) {
  return util.getSafe(state, ['persistent', EXTENSION_ID, 'versionTracking'], {});
}

/**
 * Get version info for a single mod.
 */
function getModVersionData(state, modId) {
  return getVersionData(state)[modId] || null;
}

/**
 * Compute the display status for a mod.
 * Returns one of MOD_STATUS values.
 */
function computeModStatus(state, mod) {
  const modId = mod.id;
  const vData = getModVersionData(state, modId);
  if (!vData || !vData.latestScraped) return MOD_STATUS.UNKNOWN;

  const installedVersion = mod.attributes?.version;
  if (!installedVersion) return MOD_STATUS.UNKNOWN;

  const cmp = compareVersions(vData.latestScraped, normalizeVersion(installedVersion));
  if (cmp > 0) return MOD_STATUS.OUTDATED;
  return MOD_STATUS.CURRENT;
}

/**
 * Build a summary array used by the UI badge system.
 * Returns [{ modId, modName, installedVersion, latestVersion, status }]
 */
function buildVersionSummary(state) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const vData = getVersionData(state);
  const results = [];

  for (const [modId, mod] of Object.entries(mods)) {
    const source = mod.attributes?.source || '';
    if (!source.includes('loverslab.com')) continue;

    const tracking = vData[modId];
    const installedVersion = normalizeVersion(mod.attributes?.version);
    const latestVersion = tracking?.latestScraped || null;
    let status = MOD_STATUS.UNKNOWN;
    if (latestVersion) {
      const cmp = compareVersions(latestVersion, installedVersion);
      status = cmp > 0 ? MOD_STATUS.OUTDATED : MOD_STATUS.CURRENT;
    }

    results.push({
      modId,
      modName: mod.attributes?.name || modId,
      installedVersion,
      latestVersion,
      status,
      lastChecked: tracking?.lastChecked || null,
      history: tracking?.history || [],
    });
  }

  return results;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  versionTrackingReducer,
  recordVersion,
  clearVersionHistory,
  clearAllVersionData,
  getVersionData,
  getModVersionData,
  computeModStatus,
  buildVersionSummary,
};
