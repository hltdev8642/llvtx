/**
 * Website integration — HTML scraping for LoversLab mod pages.
 * Extracts mod titles, version numbers, file names, download URLs,
 * and dependency information from public pages.
 */
const { URL } = require('url');
const {
  LOVERSLAB_DOMAIN,
  LOVERSLAB_BASE_URL,
  debugLog,
  errorLog,
  makeRequest,
  withRetry,
  compareVersions,
} = require('./utils');

// ─── URL Parsing ─────────────────────────────────────────────────────────────

/**
 * Extract structured info from a LoversLab URL.
 * Handles both /topic/ and /files/file/ URL formats.
 * @returns {{ id: string, url: string, type: 'topic'|'file' } | null}
 */
function extractModInfoFromUrl(modUrl) {
  try {
    const parsed = new URL(modUrl);
    if (parsed.hostname !== LOVERSLAB_DOMAIN) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);

    if (segments.includes('topic')) {
      const idx = segments.indexOf('topic');
      const slug = segments[idx + 1] || '';
      const id = slug.split('-')[0];
      if (!id || isNaN(Number(id))) return null;
      return { id, url: modUrl, type: 'topic' };
    }

    if (segments.includes('files') && segments.includes('file')) {
      const idx = segments.indexOf('file');
      const slug = segments[idx + 1] || '';
      const id = slug.split('-')[0];
      if (!id || isNaN(Number(id))) return null;
      return { id, url: modUrl, type: 'file' };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Version Extraction ─────────────────────────────────────────────────────

/**
 * Try JSON-LD `softwareVersion` first (most reliable).
 */
function extractVersionFromJsonLd(html) {
  try {
    const match = html.match(/<script\s+type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    const data = JSON.parse(match[1]);
    if (data.softwareVersion) {
      debugLog('Version via JSON-LD', { version: data.softwareVersion });
      return data.softwareVersion;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cascade of regex patterns to pull a version string from raw HTML.
 */
function extractVersionFromHtml(html) {
  const patterns = [
    // "Version: 1.2.3" or "version 1.2.3"
    /[Vv]ersion\s*:?\s*([0-9]+(?:\.[0-9]+)+)/,
    // "Current Version: 1.2.3"
    /[Cc]urrent\s+[Vv]ersion\s*:?\s*([0-9]+(?:\.[0-9]+)+)/,
    // title tag with bracketed version "[v1.2.3]" or "[1.2.3]"
    /<title>[^<]*\[\s*v?([0-9]+(?:\.[0-9]+)+)\s*\][^<]*<\/title>/i,
    // bracketed version anywhere
    /\[\s*v?([0-9]+(?:\.[0-9]+)+)\s*\]/,
    // v-prefixed version
    /\bv([0-9]+(?:\.[0-9]+)+)\b/i,
    // download link filename with version
    /download\/file\?id=\d+[^>]*>([^<]*?([0-9]+(?:\.[0-9]+)+)[^<]*)<\/a>/i,
    // standalone version-like string (M.m or M.m.p)
    /\b(\d+\.\d+(?:\.\d+)?)\b/,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = html.match(patterns[i]);
    if (m) {
      // Pattern for download link captures group 2
      const version = (i === 5 && m[2]) ? m[2] : m[1];
      debugLog(`Version via pattern ${i}`, { version });
      return version;
    }
  }

  return null;
}

/**
 * Master function: extract version from page HTML.
 */
function extractVersion(html) {
  return extractVersionFromJsonLd(html) || extractVersionFromHtml(html);
}

// ─── Title Extraction ────────────────────────────────────────────────────────

function extractModTitle(html) {
  // <title>…</title>
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    let title = titleMatch[1].trim();
    // Remove common suffixes like "- LoversLab"
    title = title.replace(/\s*[-–—]\s*LoversLab.*$/i, '').trim();
    return title;
  }
  // og:title
  const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (ogMatch) return ogMatch[1].trim();
  return null;
}

// ─── Download URL Extraction ─────────────────────────────────────────────────

/**
 * Find download links on a LoversLab download/file page.
 * Returns an array of { url, fileName }.
 */
function extractDownloadLinks(html) {
  const links = [];

  // Pattern A: button with confirm link and sibling filename span
  const patternA =
    /<a\s+href='([^']+\?do=download&amp;r=\d+&amp;confirm=1[^']*)'\s+class='ipsButton[^']*'\s+data-action="download"\s*>[\s\S]*?<span\s+class='ipsType_break\s+ipsContained'>([^<]+)<\/span>/gi;
  let m;
  while ((m = patternA.exec(html)) !== null) {
    links.push({ url: m[1].replace(/&amp;/g, '&'), fileName: m[2].trim() });
  }

  if (links.length > 0) return links;

  // Pattern B: simpler confirm links
  const patternB =
    /<a\s+href='([^']+\?do=download&amp;r=\d+&amp;confirm=1[^']*)'/gi;
  while ((m = patternB.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    // Try to find nearby filename
    const surrounding = html.substring(
      Math.max(0, m.index - 500),
      Math.min(html.length, m.index + 500),
    );
    const fnMatch = surrounding.match(
      /<span\s+class='ipsType_break\s+ipsContained'>([^<]+)<\/span>/i,
    );
    links.push({ url, fileName: fnMatch ? fnMatch[1].trim() : 'unknown' });
  }

  if (links.length > 0) return links;

  // Pattern C: generic download/file?id= links
  const patternC = /href="([^"]*download\/file\?id=\d+[^"]*)"/gi;
  while ((m = patternC.exec(html)) !== null) {
    let url = m[1].replace(/&amp;/g, '&');
    if (url.startsWith('/')) url = LOVERSLAB_BASE_URL + url;
    links.push({ url, fileName: 'unknown' });
  }

  return links;
}

/**
 * Pick the best download link from a set, preferring SE builds and highest version.
 */
function pickBestDownloadLink(links) {
  if (links.length === 0) return null;
  if (links.length === 1) return links[0];

  const versionRe =
    /[_\s-]v?([0-9]+\.[0-9]+(?:\.[0-9]+)?)[_\s-]?(?:SE)?[^.]*\.(?:7z|zip|rar)/i;

  const scored = links.map((link) => {
    const vMatch = link.fileName.match(versionRe);
    const hasSE =
      link.fileName.toUpperCase().includes('_SE') ||
      link.fileName.toUpperCase().includes(' SE');
    return { ...link, version: vMatch ? vMatch[1] : '0', hasSE };
  });

  scored.sort((a, b) => {
    const vCmp = compareVersions(a.version, b.version);
    if (vCmp !== 0) return vCmp;
    if (a.hasSE && !b.hasSE) return 1;
    if (!a.hasSE && b.hasSE) return -1;
    return 0;
  });

  return scored[scored.length - 1];
}

// ─── Dependency Extraction ───────────────────────────────────────────────────

/**
 * Scan HTML for mentions of required mods / dependencies.
 * Returns an array of { name, url? }.
 */
function extractDependencies(html) {
  const deps = [];
  const seen = new Set();

  // Pattern: "Requires: <a href='...'>ModName</a>"
  const reqLinkRe =
    /[Rr]equire[ds]?\s*:?\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = reqLinkRe.exec(html)) !== null) {
    const name = m[2].trim();
    if (!seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      deps.push({ name, url: m[1].replace(/&amp;/g, '&') });
    }
  }

  // Pattern: "Requirements:" or "Dependencies:" section with bullet list
  const sectionRe =
    /(?:Requirements|Dependencies|Prerequisite)[^<]*<\/[^>]+>([\s\S]{0,3000}?)(?=<\/(?:div|section|article)|<h[1-6])/gi;
  while ((m = sectionRe.exec(html)) !== null) {
    const block = m[1];
    // Find linked names
    const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
    let lm;
    while ((lm = linkRe.exec(block)) !== null) {
      const name = lm[2].trim();
      if (!seen.has(name.toLowerCase()) && name.length > 2) {
        seen.add(name.toLowerCase());
        deps.push({ name, url: lm[1].replace(/&amp;/g, '&') });
      }
    }
    // Find plain text list items
    const liRe = /<li[^>]*>([^<]+)<\/li>/gi;
    let li;
    while ((li = liRe.exec(block)) !== null) {
      const name = li[1].trim();
      if (!seen.has(name.toLowerCase()) && name.length > 2) {
        seen.add(name.toLowerCase());
        deps.push({ name });
      }
    }
  }

  // Common well-known dependencies mentioned by name
  const knownDeps = [
    'SKSE', 'SkyUI', 'FNIS', 'Nemesis', 'Racemenu', 'XPMSSE', 'XP32',
    'BodySlide', 'CBBE', 'UNP', '3BBB', 'BHUNP', 'HDT-SMP', 'CBPC',
    'SexLab', 'SexLab Framework', 'ZaZ Animation Pack', 'Devious Devices',
    'PapyrusUtil', 'JContainers', 'UIExtensions', 'AddressLibrary',
    'powerofthree\'s Papyrus Extender', 'ConsoleUtil',
  ];

  for (const dep of knownDeps) {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    if (re.test(html) && !seen.has(dep.toLowerCase())) {
      // Only add if mentioned in a requirements-like context
      const contextRe = new RegExp(
        `(?:require|need|depend|prerequisite)[^.]{0,200}${escaped}`,
        'i',
      );
      if (contextRe.test(html)) {
        seen.add(dep.toLowerCase());
        deps.push({ name: dep });
      }
    }
  }

  return deps;
}

// ─── High-Level Page Fetcher ─────────────────────────────────────────────────

/**
 * Fetch and parse a LoversLab mod page.
 * Returns all scraped data or throws on failure.
 */
async function fetchModPage(modUrl, settings = {}) {
  const timeout = settings.requestTimeoutMs || 30000;
  const maxRetries = settings.maxRetries || 3;

  const response = await withRetry(
    () => makeRequest(modUrl, { timeout }),
    { maxRetries, label: `fetch ${modUrl}` },
  );

  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode} for ${modUrl}`);
  }

  const html = response.body;
  const version = extractVersion(html);
  const title = extractModTitle(html);
  const modInfo = extractModInfoFromUrl(modUrl);
  const dependencies = extractDependencies(html);

  return {
    url: modUrl,
    modInfo,
    title,
    version,
    dependencies,
    htmlLength: html.length,
    fetchedAt: Date.now(),
    _html: html, // kept in memory only, not persisted
  };
}

/**
 * Fetch the download page for a mod and extract the best download link.
 */
async function fetchDownloadUrl(modUrl, settings = {}) {
  const downloadPageUrl = modUrl.replace(/\/$/, '') + '?do=download';
  const timeout = settings.requestTimeoutMs || 30000;
  const maxRetries = settings.maxRetries || 3;

  const response = await withRetry(
    () => makeRequest(downloadPageUrl, { timeout }),
    { maxRetries, label: `fetch download page ${downloadPageUrl}` },
  );

  if (response.statusCode !== 200) {
    throw new Error(`HTTP ${response.statusCode} for download page`);
  }

  const links = extractDownloadLinks(response.body);
  const best = pickBestDownloadLink(links);
  return {
    downloadPageUrl,
    allLinks: links,
    bestLink: best,
    downloadUrl: best ? best.url : null,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  extractModInfoFromUrl,
  extractVersion,
  extractVersionFromJsonLd,
  extractVersionFromHtml,
  extractModTitle,
  extractDownloadLinks,
  pickBestDownloadLink,
  extractDependencies,
  fetchModPage,
  fetchDownloadUrl,
};
