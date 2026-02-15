/**
 * Core utilities for the LoversLab Vortex extension.
 * Constants, logging, HTTP helpers, and version comparison.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { log } = require('vortex-api');

// ─── Constants ───────────────────────────────────────────────────────────────

const GAME_ID = 'skyrimse';
const LOVERSLAB_DOMAIN = 'www.loverslab.com';
const LOVERSLAB_BASE_URL = 'https://www.loverslab.com';
const EXTENSION_ID = 'loverslab-mod-manager';

const DEBUG = true;

const DOWNLOAD_STATES = Object.freeze({
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const MOD_STATUS = Object.freeze({
  CURRENT: 'current',
  OUTDATED: 'outdated',
  UNKNOWN: 'unknown',
});

const DEFAULT_SETTINGS = Object.freeze({
  autoCheckOnActivate: true,
  autoCheckOnDeploy: false,
  autoDownload: false,
  autoImportDetectedMods: false,
  checkIntervalMinutes: 60,
  maxConcurrentChecks: 3,
  requestTimeoutMs: 30000,
  maxRetries: 3,
  showNotifications: true,
  backupBeforeUpdate: true,
});

// ─── Logging ─────────────────────────────────────────────────────────────────

function debugLog(message, data) {
  if (DEBUG) {
    log('debug', `[LLMM] ${message}`, data);
  }
}

function infoLog(message, data) {
  log('info', `[LLMM] ${message}`, data);
}

function errorLog(message, data) {
  log('error', `[LLMM] ${message}`, data);
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

/**
 * Make a GET request that follows redirects (up to `maxRedirects`).
 * Returns { statusCode, headers, body }.
 */
function makeRequest(requestUrl, options = {}) {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeout = options.timeout ?? 30000;

  return new Promise((resolve, reject) => {
    const doRequest = (url, redirectsLeft) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${url}`));
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Vortex/LoversLabModManager/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...(options.headers || {}),
        },
        timeout,
      };

      const req = transport.request(reqOptions, (res) => {
        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) {
            return reject(new Error('Too many redirects'));
          }
          let nextUrl = res.headers.location;
          if (nextUrl.startsWith('/')) {
            nextUrl = `${parsedUrl.protocol}//${parsedUrl.host}${nextUrl}`;
          }
          return doRequest(nextUrl, redirectsLeft - 1);
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timed out after ${timeout}ms`));
      });

      req.end();
    };

    doRequest(requestUrl, maxRedirects);
  });
}

/**
 * Retry wrapper with exponential back-off.
 */
async function withRetry(fn, { maxRetries = 3, baseDelay = 1000, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 500;
        debugLog(`Retry ${attempt + 1}/${maxRetries} for ${label} in ${Math.round(delay)}ms`, {
          error: err.message,
        });
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

// ─── Version Comparison ──────────────────────────────────────────────────────

/**
 * Normalise a version string to digits-and-dots only, ensuring at least major.minor.
 */
function normalizeVersion(ver) {
  if (typeof ver !== 'string') ver = String(ver || '0');
  ver = ver.replace(/^v/i, '').replace(/[^0-9.]/g, '').replace(/\.{2,}/g, '.');
  ver = ver.replace(/^\./, '').replace(/\.$/, '');
  if (!ver || ver === '.') return '0.0.0';
  const parts = ver.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/**
 * Compare two version strings.  Returns  1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
function compareVersions(v1, v2) {
  const p1 = normalizeVersion(v1).split('.').map(Number);
  const p2 = normalizeVersion(v2).split('.').map(Number);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i++) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

/**
 * Parse a version string into a structured object.
 */
function parseVersion(versionStr) {
  const normalized = normalizeVersion(versionStr);
  const parts = normalized.split('.').map(Number);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    raw: versionStr,
    normalized,
  };
}

// ─── Misc Helpers ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute Levenshtein distance between two strings (for fuzzy mod matching).
 */
function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Sanitise a string for safe file-system usage.
 */
function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
}

/**
 * Normalize mod name for consistent version grouping.
 * Strips version numbers, file extensions, and common suffixes.
 * Vortex's fileMatch() does similar normalization when comparing logicalFileName.
 */
function normalizeModName(name) {
  if (!name || typeof name !== 'string') return name;
  let normalized = name;
  
  // Strip common file extensions
  normalized = normalized.replace(/\.(7z|zip|rar)$/i, '');
  
  // Strip version patterns like: v1.2.3, 1.2.3, (1.2.3), [1.2.3], -1.2.3
  normalized = normalized.replace(/[\s_-]*[v]?\d+\.\d+(?:\.\d+)?[a-z]?/gi, '');
  normalized = normalized.replace(/[\[(]\d+\.\d+(?:\.\d+)?[a-z]?[\])]/gi, '');
  
  // Strip common suffixes
  normalized = normalized.replace(/[\s_-]*(SE|SSE|AE|LE|SKSE|Special Edition|Anniversary Edition)$/i, '');
  
  // Clean up multiple spaces/dashes and trim
  normalized = normalized.replace(/[\s_-]+/g, ' ').trim();
  
  return normalized;
}

/**
 * Get the Vortex settings for this extension, falling back to defaults.
 */
function getSettings(state) {
  const stored = state.settings?.loverslab || {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  LOVERSLAB_BASE_URL,
  EXTENSION_ID,
  DEBUG,
  DOWNLOAD_STATES,
  MOD_STATUS,
  DEFAULT_SETTINGS,
  debugLog,
  infoLog,
  errorLog,
  makeRequest,
  withRetry,
  normalizeVersion,
  compareVersions,
  parseVersion,
  sleep,
  levenshtein,
  sanitizeFileName,
  normalizeModName,
  getSettings,
};
