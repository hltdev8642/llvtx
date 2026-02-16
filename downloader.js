/**
 * Download & install — browser-based download workflow with file monitoring,
 * version backup before update, and Vortex install-from-file integration.
 */
const path = require('path');
const nodeFs = require('fs');
const { fs, util } = require('vortex-api');
const {
  GAME_ID,
  DOWNLOAD_STATES,
  debugLog,
  infoLog,
  errorLog,
  getSettings,
  sanitizeFileName,
  normalizeModName,
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
    if (!nodeFs.existsSync(modInstallDir)) {
      debugLog('Mod directory not found; skipping backup', { modInstallDir });
      return null;
    }

    const backupRoot = path.join(
      util.getVortexPath('temp'),
      'llmm-backups',
    );
    if (!nodeFs.existsSync(backupRoot)) {
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract LoversLab file/page ID from URL for use as modId.
 * Vortex groups mods by modId first, then by logicalFileName.
 * This ensures all versions of the same LL mod share a unique identifier.
 */
function extractLoversLabModId(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  try {
    // Match patterns like: /files/file/12345-mod-name/ or /files/file/12345/
    const match = sourceUrl.match(/\/files\/file\/(\d+)/);
    return match ? `ll_${match[1]}` : null;
  } catch {
    return null;
  }
}

/**
 * Tag a Vortex download entry with LoversLab-related metadata.
 * CRITICAL: logicalFileName must be set in download metadata (not just mod attributes)
 * so Vortex's attributeExtractor picks it up during installation.
 */
function setDownloadMeta(api, dlId, modName, version, sourceUrl, forcedLogicalFileName) {
  try {
    const llModId = extractLoversLabModId(sourceUrl);
    const llFileNum = llModId ? llModId.replace('ll_', '') : null;
    // Preserve the user-visible logicalFileName — do NOT replace it with `loverslab_<id>`.
    // Use `modId` (ll_<id>) for stable grouping and allow callers to override the logicalFileName.
    const readableLogicalName = forcedLogicalFileName || normalizeModName(modName);

    if (modName) {
      api.store.dispatch({ type: 'SET_DOWNLOAD_MODINFO', payload: { id: dlId, key: 'name', value: modName } });
    }
    // Ensure a human-friendly logicalFileName is present so Vortex displays the mod name.
    if (readableLogicalName) {
      api.store.dispatch({ type: 'SET_DOWNLOAD_MODINFO', payload: { id: dlId, key: 'meta', value: { logicalFileName: readableLogicalName } } });
    }
    if (version) {
      api.store.dispatch({ type: 'SET_DOWNLOAD_MODINFO', payload: { id: dlId, key: 'version', value: version } });
    }
    // Set modId for stable byModId grouping (primary).
    if (llModId) {
      api.store.dispatch({ type: 'SET_DOWNLOAD_MODINFO', payload: { id: dlId, key: 'ids', value: { modId: llModId } } });
    }
    api.store.dispatch({ type: 'SET_DOWNLOAD_MODINFO', payload: { id: dlId, key: 'source', value: 'loverslab' } });
    debugLog('Set download metadata for grouping', { dlId, modName, readableLogicalName, version, llModId });
  } catch (err) {
    debugLog('Could not set download metadata (non-critical)', { error: err.message });
  }
}

/**
 * Set mod attributes required for Vortex's native version dropdown grouping.
 * This is a backup/enhancement to ensure attributes are correct even if
 * Vortex's attributeExtractor didn't pick them up from download metadata.
 */
function applyVersionGrouping(api, installedModId, modName, version, sourceUrl) {
  if (!installedModId) return;
  try {
    const llModId = extractLoversLabModId(sourceUrl);

    // Preserve the user-facing logicalFileName — do not overwrite it with an ll_id.
    // Only set a readable logicalFileName if the mod currently lacks one.
    if (version) {
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId: installedModId, attribute: 'version', value: version },
      });
    }
    if (llModId) {
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId: installedModId, attribute: 'modId', value: llModId },
      });
    }
    // IMPORTANT: Do NOT overwrite source attribute — it stores the full LL URL
    // which is needed for update checking and LL file ID extraction.
    // Only set source if the mod has no LoversLab source at all.
    const state = api.getState();
    const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
    const mod = mods[installedModId];
    // If the mod lacks a logicalFileName, set a readable one so it displays properly.
    if (!mod?.attributes?.logicalFileName && modName) {
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId: installedModId, attribute: 'logicalFileName', value: normalizeModName(modName) },
      });
    }
    const currentSource = mod?.attributes?.source || '';
    if (!currentSource.includes('loverslab')) {
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId: installedModId, attribute: 'source', value: sourceUrl || 'loverslab' },
      });
    }
    debugLog('Applied version grouping attributes', { installedModId, modName, version, llModId });
  } catch (err) {
    debugLog('Failed to apply version grouping (non-critical)', { error: err.message });
  }
}

/**
 * Find a mod id by its display name (best-effort match).
 * Returns undefined when not found.
 */
function findModIdByName(api, modName) {
  try {
    if (!modName) return undefined;
    const state = api.getState();
    const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
    const found = Object.values(mods).find((m) => (m.attributes?.name || '').toLowerCase() === String(modName).toLowerCase());
    return found ? found.id : undefined;
  } catch (e) {
    debugLog('findModIdByName failed', { error: e.message });
    return undefined;
  }
}

// ─── Install ─────────────────────────────────────────────────────────────────

/**
 * Import a file into Vortex's download management and trigger installation.
 * Uses import-downloads → start-install-download, the same pipeline Vortex
 * uses natively for Nexus mods.
 */
async function installFile(api, filePath, modName, version) {
  debugLog('Installing file via Vortex pipeline', { filePath, modName, version });

  return new Promise((resolve, reject) => {
    api.events.emit('import-downloads', [filePath], (dlIds) => {
      if (!dlIds || dlIds.length === 0) {
        return reject(new Error('Vortex did not return a download ID'));
      }
      const dlId = dlIds[0];
      setDownloadMeta(api, dlId, modName, version, null);

      api.events.emit('start-install-download', dlId, true, (err, installedModId) => {
        if (err) {
          errorLog('installFile: install step failed', { dlId, error: err.message });
          return reject(err);
        }
        applyVersionGrouping(api, installedModId, modName, version, null);
        resolve(installedModId || dlId);
      });
    });
  });
}

/**
 * Import a local archive as a Vortex download and install it through Vortex's
 * native pipeline (import-downloads → start-install-download).
 * This gives the user Vortex's standard "replace / keep both" dialog, and
 * correctly populates the version dropdown.
 */
async function installLocalFileUpdate(api, mod, filePath, latestVersion) {
  const modId = mod.id;
  const modName = mod.attributes?.name || modId;
  const previousVersion = mod.attributes?.version || 'unknown';

  if (!filePath || !nodeFs.existsSync(filePath)) {
    throw new Error('Selected update file does not exist');
  }

  infoLog('Importing local update via Vortex pipeline', { modId, modName, filePath, latestVersion });

  return new Promise((resolve, reject) => {
    // Step 1: Import the archive into Vortex's download management
    api.events.emit('import-downloads', [filePath], (dlIds) => {
      if (!dlIds || dlIds.length === 0) {
        return reject(new Error('Vortex did not return a download ID after import'));
      }

      const dlId = dlIds[0];
      debugLog('File imported to Vortex downloads', { dlId, filePath });

      // Step 2: Tag the download with mod metadata INCLUDING logicalFileName
      // so Vortex's attributeExtractor picks it up during installation
      const sourceUrl = mod.attributes?.source || null;
      const forceLogical = mod.attributes?.logicalFileName || normalizeModName(modName);
      setDownloadMeta(api, dlId, modName, latestVersion || previousVersion, sourceUrl, forceLogical);

      // Step 3: Trigger Vortex's native mod installation
      api.events.emit('start-install-download', dlId, true, (err, installedModId) => {
        if (err) {
          errorLog('Vortex install-from-download failed', { dlId, error: err.message });
          return reject(new Error(`Installation failed: ${err.message}`));
        }

        infoLog('Local update installed via Vortex', {
          installedModId: installedModId || modId,
          modName,
          previousVersion,
          latestVersion,
        });

        // Apply version grouping attributes (backup/enhancement)
        applyVersionGrouping(api, installedModId, modName, latestVersion || previousVersion, sourceUrl);

        // CRITICAL: Ensure the existing (old) mod also has MATCHING grouping attributes
        // Both versions must have identical logicalFileName and modId for Vortex grouping to work
        if (modId && modId !== installedModId) {
          // Apply grouping attributes to the old mod (defensive)
          applyVersionGrouping(api, modId, modName, previousVersion, sourceUrl);

          // Force-copy the old mod's logicalFileName onto the newly installed mod so Vortex
          // groups them together regardless of how the incoming archive names itself.
          try {
            const stateAfter = api.getState();
            const modsAfter = util.getSafe(stateAfter, ['persistent', 'mods', GAME_ID], {});
            const oldLogical = modsAfter[modId]?.attributes?.logicalFileName || normalizeModName(modName);
            api.store.dispatch({
              type: 'SET_MOD_ATTRIBUTE',
              payload: { gameId: GAME_ID, modId: installedModId, attribute: 'logicalFileName', value: oldLogical },
            });
            debugLog('Copied logicalFileName from old to new mod (forced)', { oldModId: modId, newModId: installedModId, logicalFileName: oldLogical });
          } catch (e) {
            debugLog('Failed to force-copy logicalFileName (non-critical)', { error: e.message });
          }

          debugLog('Version grouping applied to both old and new mod', {
            oldModId: modId,
            newModId: installedModId,
            normalizedName: normalizeModName(modName),
            oldVersion: previousVersion,
            newVersion: latestVersion,
            sourceUrl: sourceUrl ? 'available' : 'missing'
          });
        }

        // Record previous version in mod attributes so the extension can
        // present a per-mod version history dropdown if needed.
        try {
          const existingHistory = Array.isArray(mod.attributes?.llPreviousVersions)
            ? mod.attributes.llPreviousVersions
            : [];
          const nextHistory = [...new Set([...existingHistory, String(previousVersion)])].slice(-20);
          api.store.dispatch({
            type: 'SET_MOD_ATTRIBUTE',
            payload: { gameId: GAME_ID, modId, attribute: 'llPreviousVersions', value: nextHistory },
          });
        } catch (e) {
          debugLog('Failed to record llPreviousVersions (non-critical)', { error: e.message });
        }

        api.sendNotification({
          id: `llmm-local-install-${modId}`,
          type: 'success',
          title: 'Update Installed',
          message: `${modName} updated to ${latestVersion || 'new version'}.`,
          displayMS: 6000,
        });

        resolve({
          modId: installedModId || modId,
          modName,
          previousVersion,
          latestVersion,
          filePath,
        });
      });
    });
  });
}

/**
 * Install a file that is already present in Vortex's download directory.
 * Waits briefly for Vortex's built-in file watcher to register the download,
 * then falls back to manual registration via ADD_LOCAL_DOWNLOAD.
 */
async function installAlreadyDownloaded(api, filePath, modName, latestVersion, knownModId) {
  const fileName = path.basename(filePath);
  debugLog('Installing file already in download directory', { fileName, modName, latestVersion });

  // Give Vortex's built-in watcher time to register the download
  await new Promise((r) => setTimeout(r, 2500));

  const state = api.getState();
  const downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], {});
  let dlId = Object.keys(downloads).find((id) => downloads[id].localPath === fileName);

  if (!dlId) {
    dlId = `llmm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      const stats = nodeFs.statSync(filePath);
      api.store.dispatch({
        type: 'ADD_LOCAL_DOWNLOAD',
        payload: { id: dlId, game: GAME_ID, localPath: fileName, fileSize: stats.size },
      });
      debugLog('Manually registered download entry', { dlId, fileName });
    } catch (err) {
      throw new Error(`Failed to register download: ${err.message}`);
    }
  }

  // Get source URL and logicalFileName from existing mod for modId extraction and forced logical name
  let sourceUrl = null;
  let knownLogical = null;
  if (knownModId) {
    try {
      const state = api.getState();
      const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
      sourceUrl = mods[knownModId]?.attributes?.source || null;
      knownLogical = mods[knownModId]?.attributes?.logicalFileName || null;
    } catch (_e) { /* non-critical */ }
  }

  const forcedLogical = knownLogical || normalizeModName(modName);
  setDownloadMeta(api, dlId, modName, latestVersion, sourceUrl, forcedLogical);

  return new Promise((resolve, reject) => {
    api.events.emit('start-install-download', dlId, true, (err, installedModId) => {
      if (err) {
        errorLog('Install failed for downloaded file', { dlId, error: err.message });
        return reject(new Error(`Installation failed: ${err.message}`));
      }

      infoLog('Downloaded file installed via Vortex', { installedModId, modName, latestVersion });

      // Apply version grouping attributes
      applyVersionGrouping(api, installedModId, modName, latestVersion, sourceUrl);

      // Ensure the existing mod also has grouping attributes and force logicalFileName on the installed mod
      if (knownModId && knownModId !== installedModId) {
        applyVersionGrouping(api, knownModId, modName, null, sourceUrl);
        try {
          const stateAfter = api.getState();
          const modsAfter = util.getSafe(stateAfter, ['persistent', 'mods', GAME_ID], {});
          const oldLogical = modsAfter[knownModId]?.attributes?.logicalFileName || normalizeModName(modName);
          api.store.dispatch({ type: 'SET_MOD_ATTRIBUTE', payload: { gameId: GAME_ID, modId: installedModId, attribute: 'logicalFileName', value: oldLogical } });
          debugLog('Copied logicalFileName from known mod to installed mod (forced)', { knownModId, installedModId, logicalFileName: oldLogical });
        } catch (e) {
          debugLog('Failed to force-copy logicalFileName after install (non-critical)', { error: e.message });
        }
      }

      // Attempt to attach previous version metadata to the installed mod
      try {
        const state = api.getState();
        const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
        const modEntry = Object.values(mods).find((m) => (m.attributes?.name || '') === modName);
        if (modEntry) {
          const modId = modEntry.id;
          const existingHistory = Array.isArray(modEntry.attributes?.llPreviousVersions)
            ? modEntry.attributes.llPreviousVersions
            : [];
          // We don't know the exact previous version here; preserve any existing history.
          const nextHistory = existingHistory.slice(-20);
          api.store.dispatch({ type: 'SET_MOD_ATTRIBUTE', payload: { gameId: GAME_ID, modId, attribute: 'llPreviousVersions', value: nextHistory } });
        }
      } catch (e) {
        debugLog('Failed to set llPreviousVersions after install (non-critical)', { error: e.message });
      }

      api.sendNotification({
        id: `llmm-dl-installed-${dlId}`,
        type: 'success',
        title: 'Mod Installed',
        message: `${modName} v${latestVersion || 'unknown'} installed successfully.`,
        displayMS: 6000,
      });

      resolve({ modId: installedModId, modName, version: latestVersion, filePath });
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
            const result = await installAlreadyDownloaded(api, filePath, modName, latestVersion, modId);
            resolve({ success: true, filePath, ...result });
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
  installLocalFileUpdate,
  installAlreadyDownloaded,
  monitorDirectory,
  applyVersionGrouping,
};
