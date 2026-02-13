/**
 * Mod detection — identify which installed mods likely came from LoversLab
 * using filename patterns, fuzzy matching, and a keyword database.
 */
const { util } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  levenshtein,
} = require('./utils');

// ─── Keyword Database ────────────────────────────────────────────────────────
// Common LoversLab mod identifiers / prefixes / keywords.
// This list helps identify mods that may have been installed from LoversLab
// but don't have a source URL set.

const LL_KEYWORDS = [
  // Frameworks
  'sexlab', 'sl_', 'slal', 'sexlab framework', 'sla ',
  // Devious series
  'devious', 'dd_', 'devious devices', 'devious followers',
  // Body / character
  'cbbe', 'bhunp', '3bbb', '3ba', 'bodyslide',
  // Animation
  'fnis', 'nemesis', 'zaz ', 'zap ', 'animation pack',
  // Physics
  'hdt-smp', 'hdt ', 'cbpc', 'smp ',
  // Common LL mod name fragments
  'defeat', 'submit', 'aroused', 'approach', 'eager',
  'milk mod', 'milkmod', 'estrus', 'fill her up', 'parasites',
  'creature', 'baka', 'billyy', 'nibbles', 'anubs',
  'flower girls', 'amorous', 'osa ', 'ostim',
  // Other patterns
  'loverslab', 'lovers lab',
];

// ─── Detection Logic ─────────────────────────────────────────────────────────

/**
 * Check whether a mod is already tagged as LoversLab-sourced.
 */
function isTaggedAsLoversLab(mod) {
  const source = (mod.attributes?.source || '').toLowerCase();
  return source.includes(LOVERSLAB_DOMAIN) || source.includes('loverslab');
}

/**
 * Score how likely a mod is from LoversLab based on its metadata.
 * Returns 0–100.
 */
function scoreMod(mod) {
  if (isTaggedAsLoversLab(mod)) return 100;

  let score = 0;
  const name = (mod.attributes?.name || '').toLowerCase();
  const fileName = (mod.attributes?.fileName || '').toLowerCase();
  const combined = `${name} ${fileName}`;

  // Keyword hits
  for (const kw of LL_KEYWORDS) {
    if (combined.includes(kw)) {
      score += 15;
    }
  }

  // Not from Nexus
  const source = (mod.attributes?.source || '').toLowerCase();
  if (source && !source.includes('nexusmods')) {
    score += 5;
  }
  if (!source) {
    // Unknown source — more likely LL
    score += 10;
  }

  return Math.min(score, 100);
}

/**
 * Detect all mods that are likely from LoversLab.
 *
 * @param {Object} state - Vortex state
 * @param {Object} options
 * @param {number} [options.threshold=30] - minimum score to include
 * @param {boolean} [options.includeTagged=true] - include already-tagged mods
 * @returns {Array<{ mod, score, tagged }>}
 */
function detectLoversLabMods(state, options = {}) {
  const { threshold = 30, includeTagged = true } = options;
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const results = [];

  for (const mod of Object.values(mods)) {
    const tagged = isTaggedAsLoversLab(mod);
    if (tagged && !includeTagged) continue;

    const score = scoreMod(mod);
    if (score >= threshold) {
      results.push({ mod, score, tagged });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Get only the confirmed LoversLab mods (tagged with a source URL).
 */
function getTaggedMods(state) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  return Object.values(mods).filter(isTaggedAsLoversLab);
}

/**
 * Fuzzy-match an installed mod name against a LoversLab mod title.
 * Returns a similarity score between 0 and 1 (1 = exact match).
 */
function fuzzyMatch(installedName, llTitle) {
  const a = installedName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const b = llTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (a === b) return 1;
  if (!a || !b) return 0;

  const distance = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

/**
 * Try to find the best match for a LoversLab mod title among installed mods.
 * @param {string} llTitle - scraped title from LoversLab
 * @param {Object} state
 * @param {number} [minSimilarity=0.6]
 * @returns {{ mod, similarity }|null}
 */
function findBestMatch(llTitle, state, minSimilarity = 0.6) {
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  let best = null;
  let bestScore = 0;

  for (const mod of Object.values(mods)) {
    const name = mod.attributes?.name || '';
    const sim = fuzzyMatch(name, llTitle);
    if (sim > bestScore && sim >= minSimilarity) {
      bestScore = sim;
      best = { mod, similarity: sim };
    }
  }

  return best;
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  LL_KEYWORDS,
  isTaggedAsLoversLab,
  scoreMod,
  detectLoversLabMods,
  getTaggedMods,
  fuzzyMatch,
  findBestMatch,
};
