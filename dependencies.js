/**
 * Dependency detection — cross-references scraped dependency lists with
 * installed mods. Produces warnings for missing dependencies.
 */
const { util } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  levenshtein,
} = require('./utils');
const { fetchModPage } = require('./scraper');

// ─── Reducers ────────────────────────────────────────────────────────────────

const dependencyReducer = {
  reducers: {
    /**
     * Store scraped dependencies for a mod.
     * payload: { modId, dependencies: [{ name, url? }] }
     */
    LLMM_SET_DEPENDENCIES: (state, payload) => {
      const { modId, dependencies } = payload;
      return {
        ...state,
        [modId]: {
          dependencies,
          updatedAt: Date.now(),
        },
      };
    },
    LLMM_CLEAR_DEPENDENCIES: (state, payload) => {
      const next = { ...state };
      delete next[payload.modId];
      return next;
    },
  },
  defaults: {},
};

// ─── Actions ─────────────────────────────────────────────────────────────────

function storeDependencies(api, modId, dependencies) {
  api.store.dispatch({
    type: 'LLMM_SET_DEPENDENCIES',
    payload: { modId, dependencies },
  });
}

// ─── Cross-Reference ─────────────────────────────────────────────────────────

/**
 * Normalise a mod name for loose comparison.
 */
function normaliseName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\s+/g, '');
}

/**
 * Check whether a dependency name matches any installed mod.
 * Uses exact normalised match first, then Levenshtein fallback.
 *
 * @param {string} depName
 * @param {Object} installedMods - values from Vortex state
 * @returns {{ found: boolean, matchedMod?: Object, similarity?: number }}
 */
function matchDependency(depName, installedMods) {
  const normDep = normaliseName(depName);
  if (!normDep) return { found: false };

  // Exact normalised match
  for (const mod of Object.values(installedMods)) {
    const modName = normaliseName(mod.attributes?.name || '');
    const modFile = normaliseName(mod.attributes?.fileName || '');
    if (modName === normDep || modFile === normDep) {
      return { found: true, matchedMod: mod, similarity: 1 };
    }
  }

  // Substring match (e.g. "SexLab" appearing inside "SexLab Framework SE")
  for (const mod of Object.values(installedMods)) {
    const modName = normaliseName(mod.attributes?.name || '');
    if (modName.includes(normDep) || normDep.includes(modName)) {
      return { found: true, matchedMod: mod, similarity: 0.85 };
    }
  }

  // Fuzzy match
  let bestSim = 0;
  let bestMod = null;
  for (const mod of Object.values(installedMods)) {
    const modName = normaliseName(mod.attributes?.name || '');
    if (!modName) continue;
    const dist = levenshtein(normDep, modName);
    const maxLen = Math.max(normDep.length, modName.length);
    const sim = maxLen === 0 ? 1 : 1 - dist / maxLen;
    if (sim > bestSim) {
      bestSim = sim;
      bestMod = mod;
    }
  }

  if (bestSim >= 0.7) {
    return { found: true, matchedMod: bestMod, similarity: bestSim };
  }

  return { found: false };
}

/**
 * Analyse dependencies for a mod: scrape if needed, then cross-reference.
 *
 * @param {Object} api
 * @param {string} modId
 * @param {Object} [options]
 * @param {boolean} [options.rescrape=false]
 * @returns {Promise<{ dependencies, missing, satisfied }>}
 */
async function analyseDependencies(api, modId, options = {}) {
  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const mod = mods[modId];
  if (!mod) throw new Error(`Mod ${modId} not found`);

  const modUrl = mod.attributes?.source;
  let deps;

  // Check stored dependencies first
  const stored = util.getSafe(
    state,
    ['persistent', 'loverslab-mod-manager', 'dependencies', modId],
    null,
  );

  if (stored && !options.rescrape) {
    deps = stored.dependencies;
  } else if (modUrl && modUrl.includes(LOVERSLAB_DOMAIN)) {
    // Scrape the page
    const pageData = await fetchModPage(modUrl);
    deps = pageData.dependencies || [];
    storeDependencies(api, modId, deps);
  } else {
    deps = [];
  }

  // Cross-reference
  const satisfied = [];
  const missing = [];

  for (const dep of deps) {
    const result = matchDependency(dep.name, mods);
    if (result.found) {
      satisfied.push({
        ...dep,
        matchedModId: result.matchedMod.id,
        matchedModName: result.matchedMod.attributes?.name,
        similarity: result.similarity,
      });
    } else {
      missing.push(dep);
    }
  }

  debugLog('Dependency analysis', {
    modId,
    total: deps.length,
    satisfied: satisfied.length,
    missing: missing.length,
  });

  return { dependencies: deps, satisfied, missing };
}

/**
 * Batch dependency analysis for all tagged LoversLab mods.
 */
async function analyseAllDependencies(api) {
  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const results = {};

  for (const [modId, mod] of Object.entries(mods)) {
    const source = mod.attributes?.source || '';
    if (!source.includes(LOVERSLAB_DOMAIN)) continue;
    try {
      results[modId] = await analyseDependencies(api, modId);
    } catch (err) {
      debugLog(`Dependency analysis failed for ${modId}`, { error: err.message });
      results[modId] = { dependencies: [], satisfied: [], missing: [], error: err.message };
    }
  }

  return results;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  dependencyReducer,
  storeDependencies,
  matchDependency,
  analyseDependencies,
  analyseAllDependencies,
};
