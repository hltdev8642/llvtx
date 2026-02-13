/**
 * Download & install — browser-based download workflow with file monitoring,
 * version backup before update, and Vortex install-from-file integration.
 */
const path = require('path');
const { fs, util } = require('vortex-api');
const {
  GAME_ID,
  DOWNLOAD_STATES,
  debugLog,
  infoLog,
  errorLog,
  getSettings,
  sanitizeFileName,
} = require('./utils');

// ─── Global State ────────────────────────────────────────────────────────────

/** Per-mod download state keyed by modId */
const activeDownloads = {};

/** Active file watchers keyed by a random ID */
const fileWatchers = {};

// ─── Directory Monitor ───────────────────────────────────────────────────────

/**
 * Poll a directory for new files that weren't present at start time.
 * Ignores partial-download temp files (.crdownload, .part, .tmp).
 *
 * @param {string} directory
 * @param {Object} opts
 * @param {string[]} opts.initialFiles - snapshot before download started
 * @param {function} opts.onNewFile - (filePath, error?) => void
 * @param {number}   [opts.pollInterval=1000]
 * @param {number}   [opts.timeout=300000]
 * @returns {{ stop: Function, id: string }}
 */
function monitorDirectory(directory, opts = {}) {
  const {
    initialFiles = [],
    onNewFile,
    pollInterval = 1000,
    timeout = 300000,
  } = opts;

  const id = `watcher-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  let intervalId = null;
  let timeoutId = null;
  let running = true;
  const startTime = Date.now();

  const stop = () => {
    if (!running) return;
    running = false;
    if (intervalId) clearInterval(intervalId);
    if (timeoutId) clearTimeout(timeoutId);
    delete fileWatchers[id];
    debugLog('Stopped directory monitor', { id });
  };

  const check = () => {
    if (!running) return;
    if (Date.now() - startTime > timeout) {
      stop();
      if (onNewFile) onNewFile(null, new Error('Monitoring timed out'));
      return;
    }
    try {
      const current = fs.readdirSync(directory);
      const newFiles = current.filter(
        (f) =>
          !initialFiles.includes(f) &&
          !f.endsWith('.crdownload') &&
          !f.endsWith('.part') &&
          !f.endsWith('.tmp'),
      );
      if (newFiles.length > 0) {
        debugLog('Detected new file(s)', { newFiles });
        stop();
        if (onNewFile) onNewFile(path.join(directory, newFiles[0]));
      }
    } catch (err) {
      errorLog('Directory monitor error', { error: err.message });
    }
  };

  intervalId = setInterval(check, pollInterval);
  timeoutId = setTimeout(() => {
    if (running) {
      stop();
      if (onNewFile) onNewFile(null, new Error('Monitoring timed out'));
    }
  }, timeout);

  fileWatchers[id] = { stop, directory, startTime };
  debugLog('Started directory monitor', { id, directory });
  return { stop, id };
}

// ─── Version Backup ──────────────────────────────────────────────────────────

/**
 * Back up the current installed mod files before applying an update.
 * Creates a timestamped zip-style folder under the extension's backup dir.
 *
 * @param {Object} api - Vortex API
 * @param {string} modId
 * @param {string} modName
 * @param {string} currentVersion
 * @returns {Promise<string|null>} - path to backup directory, or null on failure
 */
async function backupModVersion(api, modId, modName, currentVersion) {
  try {
    const state = api.getState();
    const installPath = util.getSafe(
      state,
      ['settings', 'mods', 'installPath', GAME_ID],
      undefined,
    );
    if (!installPath) {
      debugLog('No install path configured; skipping backup');
      return null;
    }

    const modInstallDir = path.join(installPath, modId);
    if (!fs.existsSync(modInstallDir)) {
      debugLog('Mod directory not found; skipping backup', { modInstallDir });
      return null;
    }

    const backupRoot = path.join(
      util.getVortexPath('temp'),
      'llmm-backups',
    );
    if (!fs.existsSync(backupRoot)) {
      fs.mkdirSync(backupRoot, { recursive: true });
    }

    const safeName = sanitizeFileName(modName || modId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(
      backupRoot,
      `${safeName}_v${currentVersion}_${timestamp}`,
    );
    fs.mkdirSync(backupDir, { recursive: true });

    // Recursive copy
    await copyDirRecursive(modInstallDir, backupDir);

    infoLog('Mod backup created', { modId, backupDir });
    return backupDir;
  } catch (err) {
    errorLog('Backup failed', { modId, error: err.message });
    return null;
  }
}

async function copyDirRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      await copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ─── Install ─────────────────────────────────────────────────────────────────

/**
 * Install a downloaded mod file through Vortex's event system.
 */
async function installFile(api, filePath, modName, version) {
  const fileName = path.basename(filePath);
  debugLog('Installing file', { filePath, modName, version });

  return new Promise((resolve, reject) => {
    api.events.emit('import-downloads', [filePath], (dlIds) => {
      if (!dlIds || dlIds.length === 0) {
        return reject(new Error('Vortex did not return a download ID'));
      }
      resolve(dlIds[0]);
    });
  });
}

// ─── Browser-Based Download ──────────────────────────────────────────────────

/**
 * Open the download URL in the user's browser and monitor for the file.
 * This avoids the need for authentication — the user's browser session handles it.
 *
 * Returns a promise that resolves when the file is detected, or rejects on timeout.
 */
function downloadViaBrowser(api, updateInfo) {
  const { modId, modName, latestVersion, downloadUrl, modUrl } = updateInfo;
  const urlToOpen = downloadUrl || modUrl;

  return new Promise(async (resolve, reject) => {
    activeDownloads[modId] = {
      state: DOWNLOAD_STATES.PENDING,
      modId,
      modName,
      version: latestVersion,
      startTime: Date.now(),
    };

    api.sendNotification({
      id: `llmm-dl-${modId}`,
      type: 'activity',
      title: 'Opening Browser',
      message: `Opening browser for ${modName}...`,
    });

    try {
      // Snapshot the download directory
      const downloadDir = api.getPath('download');
      const initialFiles = fs.readdirSync(downloadDir);

      activeDownloads[modId].state = DOWNLOAD_STATES.DOWNLOADING;

      const watcher = monitorDirectory(downloadDir, {
        initialFiles,
        pollInterval: 1000,
        timeout: 300000,
        onNewFile: async (filePath, error) => {
          if (error) {
            activeDownloads[modId].state = DOWNLOAD_STATES.FAILED;
            activeDownloads[modId].error = error.message;
            api.dismissNotification(`llmm-dl-${modId}`);
            api.sendNotification({
              id: `llmm-dl-fail-${modId}`,
              type: 'warning',
              title: 'Download Not Detected',
              message: `Could not detect download for ${modName}: ${error.message}`,
              displayMS: 8000,
            });
            return reject(error);
          }

          activeDownloads[modId].state = DOWNLOAD_STATES.COMPLETED;
          activeDownloads[modId].filePath = filePath;
          api.dismissNotification(`llmm-dl-${modId}`);
          api.sendNotification({
            id: `llmm-dl-ok-${modId}`,
            type: 'success',
            title: 'Download Detected',
            message: `${modName} download detected. Installing...`,
            displayMS: 5000,
          });

          try {
            await installFile(api, filePath, modName, latestVersion);
            resolve({ success: true, filePath, modId, modName, version: latestVersion });
          } catch (installErr) {
            errorLog('Install failed after download', { modId, error: installErr.message });
            reject(installErr);
          }
        },
      });

      activeDownloads[modId].watcherId = watcher.id;

      // Open the URL
      debugLog('Opening URL in browser', { url: urlToOpen });
      await util.opn(urlToOpen);
    } catch (err) {
      activeDownloads[modId].state = DOWNLOAD_STATES.FAILED;
      activeDownloads[modId].error = err.message;
      api.dismissNotification(`llmm-dl-${modId}`);
      reject(err);
    }
  });
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Download a mod update with optional backup.
 * @param {Object} api - Vortex API
 * @param {Object} updateInfo - from updateChecker
 * @returns {Promise<Object>}
 */
async function downloadUpdate(api, updateInfo) {
  const { modId, modName, currentVersion, latestVersion } = updateInfo;
  const state = api.getState();
  const settings = getSettings(state);

  // Optional backup
  if (settings.backupBeforeUpdate) {
    api.sendNotification({
      id: `llmm-backup-${modId}`,
      type: 'activity',
      title: 'Backing Up',
      message: `Backing up ${modName} v${currentVersion}...`,
    });
    const backupPath = await backupModVersion(api, modId, modName, currentVersion);
    api.dismissNotification(`llmm-backup-${modId}`);
    if (backupPath) {
      debugLog('Backup complete', { modId, backupPath });
    }
  }

  return downloadViaBrowser(api, updateInfo);
}

/**
 * Cancel a running download.
 */
function cancelDownload(modId) {
  const dl = activeDownloads[modId];
  if (!dl) return;
  dl.state = DOWNLOAD_STATES.CANCELLED;
  if (dl.watcherId && fileWatchers[dl.watcherId]) {
    fileWatchers[dl.watcherId].stop();
  }
  delete activeDownloads[modId];
}

/**
 * Get all active download states (for UI display).
 */
function getActiveDownloads() {
  return { ...activeDownloads };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  downloadUpdate,
  downloadViaBrowser,
  cancelDownload,
  getActiveDownloads,
  backupModVersion,
  installFile,
  monitorDirectory,
};
