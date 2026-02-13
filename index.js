/**
 * LoversLab Mod Manager — Vortex Extension Entry Point
 *
 * Registers reducers, UI components, toolbar actions, event listeners,
 * and context-menu entries. This is the single file Vortex loads.
 */
const path = require('path');
const nodeFs = require('fs');
const { fs, util, selectors } = require('vortex-api');
const {
  GAME_ID,
  EXTENSION_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  infoLog,
  errorLog,
  normalizeVersion,
  compareVersions,
  getSettings,
} = require('./utils');

// Feature modules
const { versionTrackingReducer } = require('./versionTracking');
const { dependencyReducer, analyseDependencies } = require('./dependencies');
const { settingsReducer, showSettingsDialog } = require('./settings');
const { checkAllMods, checkSingleMod } = require('./updateChecker');
const { downloadUpdate, installLocalFileUpdate } = require('./downloader');
const { batchCheckUpdates, batchDownloadUpdates, cancelBatch } = require('./batchOps');
const { detectLoversLabMods, getTaggedMods } = require('./modDetection');
const { exportToJson, exportToHtml, importFromJson } = require('./exportImport');

// ─── Main Registration ──────────────────────────────────────────────────────

function main(context) {
  // ── Reducers ────────────────────────────────────────────────────────────

  context.registerReducer(['persistent', EXTENSION_ID, 'versionTracking'], versionTrackingReducer);
  context.registerReducer(['persistent', EXTENSION_ID, 'dependencies'], dependencyReducer);
  context.registerReducer(['settings', 'loverslab'], settingsReducer);

  // ── Mod Table: LL Version Badge Column ─────────────────────────────────

  context.registerTableAttribute('mods', {
    id: 'llmm-version-badge',
    name: 'LL Status',
    description: 'LoversLab update status',
    placement: 'table',
    calc: (mod) => {
      const source = mod.attributes?.source || '';
      if (!source.includes(LOVERSLAB_DOMAIN)) return '';

      const state = context.api.getState();
      const tracking = util.getSafe(state, ['persistent', EXTENSION_ID, 'versionTracking', mod.id], null);
      if (!tracking?.latestScraped) return 'Not checked';

      const installed = normalizeVersion(mod.attributes?.version);
      const latest = normalizeVersion(tracking.latestScraped);
      const cmp = compareVersions(latest, installed);
      return cmp > 0 ? `Update: ${latest}` : 'Up to date';
    },
    edit: {},
    isSortable: false,
    isToggleable: true,
    isDefaultVisible: true,
    condition: () => {
      try {
        const state = context.api.getState();
        return selectors.activeGameId(state) === GAME_ID;
      } catch {
        return false;
      }
    },
  });

  // ── Toolbar Actions ────────────────────────────────────────────────────

  // Check for updates button
  context.registerAction('mods-action-icons', 100, 'refresh', {},
    'Check LL Updates', () => {
      const state = context.api.getState();
      if (selectors.activeGameId(state) !== GAME_ID) {
        context.api.showDialog('info', 'LoversLab Mod Manager', {
          text: 'This feature is only available for Skyrim Special Edition.',
        }, [{ label: 'Close' }]);
        return;
      }
      batchCheckUpdates(context.api);
    },
  );

  // Settings button
  context.registerAction('mods-action-icons', 110, 'settings', {},
    'LL Settings', () => {
      showSettingsDialog(context.api);
    },
  );

  // Export JSON
  context.registerAction('mods-action-icons', 120, 'export', {},
    'Export LL Mod List', () => {
      const state = context.api.getState();
      if (selectors.activeGameId(state) !== GAME_ID) return;
      showExportDialog(context.api);
    },
  );

  // Import JSON
  context.registerAction('mods-action-icons', 130, 'import', {},
    'Import LL Mod List', () => {
      const state = context.api.getState();
      if (selectors.activeGameId(state) !== GAME_ID) return;
      showImportDialog(context.api);
    },
  );

  // Detect LL mods
  context.registerAction('mods-action-icons', 140, 'search', {},
    'Detect LL Mods', () => {
      const state = context.api.getState();
      if (selectors.activeGameId(state) !== GAME_ID) return;
      showDetectionDialog(context.api);
    },
  );

  // ── Context Menu: Per-Mod Actions ──────────────────────────────────────

  // Set LoversLab source URL
  context.registerAction('mods-action-icons', 200, 'link', {},
    'Set LL Source', (instanceIds) => {
      if (!instanceIds.length) return;
      showSetSourceDialog(context.api, instanceIds[0]);
    },
  );

  // Check single mod for updates
  context.registerAction('mods-action-icons', 210, 'refresh', {},
    'Check LL Update (Single)', (instanceIds) => {
      if (!instanceIds.length) return;
      checkSingleModAction(context.api, instanceIds[0]);
    },
  );

  context.registerAction('mods-action-icons', 215, 'download', {},
    'Download LL Update (Single)', (instanceIds) => {
      if (!instanceIds.length) return;
      downloadSingleModUpdateAction(context.api, instanceIds[0]);
    },
  );

  // Check dependencies
  context.registerAction('mods-action-icons', 220, 'dependencies', {},
    'Check LL Dependencies', (instanceIds) => {
      if (!instanceIds.length) return;
      showDependencyDialog(context.api, instanceIds[0]);
    },
  );

  // ── Event Listeners ────────────────────────────────────────────────────

  context.once(() => {
    // When the game mode activates
    context.api.events.on('gamemode-activated', async (gameId) => {
      if (gameId !== GAME_ID) return;
      const state = context.api.getState();
      const settings = getSettings(state);
      if (settings.autoCheckOnActivate) {
        debugLog('Auto-checking for updates on activation');
        try {
          const updates = await checkAllMods(context.api, false);
          if (updates.length > 0 && settings.autoDownload) {
            batchDownloadUpdates(context.api, updates);
          } else if (updates.length > 0) {
            const { showUpdateDialog } = require('./batchOps');
            showUpdateDialog(context.api, updates);
          }
        } catch (err) {
          errorLog('Auto-check on activation failed', { error: err.message });
        }
      }
    });

    // After deployment
    context.api.events.on('did-deploy', async (profileId) => {
      const state = context.api.getState();
      const profile = selectors.profileById(state, profileId);
      if (!profile || profile.gameId !== GAME_ID) return;
      const settings = getSettings(state);
      if (settings.autoCheckOnDeploy) {
        debugLog('Auto-checking for updates after deploy');
        try {
          await checkAllMods(context.api, false);
        } catch (err) {
          errorLog('Auto-check on deploy failed', { error: err.message });
        }
      }
    });
  });

  return true;
}

// ─── Dialog Helpers ──────────────────────────────────────────────────────────

function getDialogValue(result, key) {
  const input = result?.input;
  if (input && !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, key)) {
    return input[key];
  }
  if (Array.isArray(input)) {
    const found = input.find((entry) => entry?.id === key);
    if (found) return found.value;
  }

  const checkboxes = result?.checkboxes;
  if (checkboxes && !Array.isArray(checkboxes) && Object.prototype.hasOwnProperty.call(checkboxes, key)) {
    return checkboxes[key];
  }
  if (Array.isArray(checkboxes)) {
    const found = checkboxes.find((entry) => entry?.id === key);
    if (found) return found.value;
  }

  if (result && !Array.isArray(result) && Object.prototype.hasOwnProperty.call(result, key)) {
    return result[key];
  }

  return undefined;
}

function getDialogBool(result, key, fallback = false) {
  const val = getDialogValue(result, key);
  if (val === undefined || val === null) return fallback;
  return !!val;
}

async function promptLocalUpdateFile(api, update) {
  const trySelectFileApi = async () => {
    if (typeof api.selectFile !== 'function') return null;
    const selected = await api.selectFile({
      title: `Select update archive for ${update.modName}`,
      defaultPath: api.getPath('download'),
      filters: [
        { name: 'Archives', extensions: ['7z', 'zip', 'rar'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });

    if (!selected) return null;
    if (typeof selected === 'string') return selected;
    if (Array.isArray(selected) && selected.length > 0) return selected[0];
    if (selected.filePath) return selected.filePath;
    if (Array.isArray(selected.filePaths) && selected.filePaths.length > 0) return selected.filePaths[0];
    return null;
  };

  try {
    const chosenByApi = await trySelectFileApi();
    if (chosenByApi) return chosenByApi;
  } catch {
  }

  return new Promise((resolve) => {
    api.showDialog('question', 'Select Local Update File', {
      text: `Select the downloaded archive for ${update.modName} (7z/zip/rar).`,
      input: [
        {
          id: 'filePath',
          type: 'text',
          label: 'Archive Path',
          placeholder: 'C:\\path\\to\\mod-update.7z',
          value: '',
        },
      ],
      options: { wrap: true },
    }, [
      { label: 'Cancel', action: () => resolve(null) },
      {
        label: 'Import & Install',
        default: true,
        action: (result) => {
          const raw = getDialogValue(result, 'filePath');
          const filePath = typeof raw === 'string' ? raw.trim() : '';
          resolve(filePath || null);
        },
      },
    ]);
  });
}

async function manualImportUpdateFallback(api, mod, update, reasonText) {
  api.showDialog('question', 'Manual Update Import', {
    text: `${reasonText}\n\nYou can select a local archive file to import and install this update now.`,
    options: { wrap: true },
  }, [
    { label: 'Cancel' },
    {
      label: 'Select File',
      default: true,
      action: async () => {
        try {
          const filePath = await promptLocalUpdateFile(api, update);
          if (!filePath) return;
          if (!nodeFs.existsSync(filePath)) {
            api.sendNotification({
              id: `llmm-manual-file-missing-${mod.id}`,
              type: 'error',
              title: 'File Not Found',
              message: 'Selected file does not exist.',
              displayMS: 5000,
            });
            return;
          }
          await installLocalFileUpdate(api, mod, filePath, update.latestVersion);
        } catch (err) {
          api.sendNotification({
            id: `llmm-manual-import-fail-${mod.id}`,
            type: 'error',
            title: 'Manual Import Failed',
            message: err.message,
            displayMS: 6000,
          });
        }
      },
    },
  ]);
}

function showSetSourceDialog(api, modId) {
  const state = api.getState();
  const gameId = selectors.activeGameId(state);
  if (gameId !== GAME_ID) return;

  const mods = util.getSafe(state, ['persistent', 'mods', gameId], {});
  const mod = mods[modId];
  if (!mod) return;

  api.showDialog('question', 'Set LoversLab Source URL', {
    text: 'Enter the LoversLab page URL and current version for this mod.',
    input: [
      {
        id: 'url',
        type: 'text',
        label: 'LoversLab URL',
        placeholder: 'https://www.loverslab.com/files/file/12345-mod-name/',
        value: mod.attributes?.source || '',
      },
      {
        id: 'version',
        type: 'text',
        label: 'Current Version',
        placeholder: '1.0.0',
        value: mod.attributes?.version || '',
      },
    ],
  }, [
    { label: 'Cancel' },
    {
      label: 'Save',
      default: true,
      action: (result) => {
        const rawUrl = typeof getDialogValue(result, 'url') === 'string'
          ? getDialogValue(result, 'url')
          : '';

        const normalizedRawUrl = rawUrl.trim();
        const candidateUrl = /^https?:\/\//i.test(normalizedRawUrl)
          ? normalizedRawUrl
          : `https://${normalizedRawUrl}`;

        let parsedUrl;
        try {
          parsedUrl = new URL(candidateUrl);
        } catch {
          parsedUrl = null;
        }

        const isValidLoversLabUrl = parsedUrl && /(^|\.)loverslab\.com$/i.test(parsedUrl.hostname);

        if (!isValidLoversLabUrl) {
          api.showDialog('error', 'Invalid URL', {
            text: 'Please enter a valid LoversLab URL (for example: https://www.loverslab.com/files/file/12345-mod-name/).',
          }, [{ label: 'OK' }]);
          return;
        }

        const inputVersion = typeof getDialogValue(result, 'version') === 'string'
          ? getDialogValue(result, 'version')
          : '';

        api.store.dispatch({
          type: 'SET_MOD_ATTRIBUTE',
          payload: { gameId, modId, attribute: 'source', value: parsedUrl.toString() },
        });
        if (inputVersion.trim()) {
          api.store.dispatch({
            type: 'SET_MOD_ATTRIBUTE',
            payload: { gameId, modId, attribute: 'version', value: inputVersion.trim() },
          });
        }

        api.sendNotification({
          id: 'llmm-source-set',
          type: 'success',
          title: 'Source URL Saved',
          message: `LoversLab source set for ${mod.attributes?.name || modId}`,
          displayMS: 3000,
        });
      },
    },
  ]);
}

async function downloadSingleModUpdateAction(api, modId) {
  const state = api.getState();
  const gameId = selectors.activeGameId(state);
  if (gameId !== GAME_ID) return;

  const mods = util.getSafe(state, ['persistent', 'mods', gameId], {});
  const mod = mods[modId];
  if (!mod) return;

  const source = mod.attributes?.source || '';
  if (!source.includes(LOVERSLAB_DOMAIN)) {
    api.sendNotification({
      id: 'llmm-no-source-download',
      type: 'info',
      title: 'No LoversLab Source',
      message: 'This mod does not have a LoversLab source URL. Use "Set LL Source" first.',
      displayMS: 5000,
    });
    return;
  }

  api.sendNotification({
    id: `llmm-download-check-${modId}`,
    type: 'activity',
    title: 'Checking for Downloadable Update',
    message: `Checking ${mod.attributes?.name || modId}...`,
    noDismiss: true,
  });

  try {
    const settings = getSettings(state);
    const update = await checkSingleMod(api, mod, settings);
    api.dismissNotification(`llmm-download-check-${modId}`);

    if (!update) {
      api.sendNotification({
        id: `llmm-download-none-${modId}`,
        type: 'info',
        title: 'No Update Available',
        message: `${mod.attributes?.name || modId} is already up to date.`,
        displayMS: 4000,
      });
      return;
    }

    if (!update.downloadUrl) {
      manualImportUpdateFallback(
        api,
        mod,
        update,
        `An update was found for ${update.modName}, but no direct download link was detected.`,
      );
      return;
    }

    try {
      await downloadUpdate(api, update);
    } catch (downloadErr) {
      manualImportUpdateFallback(
        api,
        mod,
        update,
        `Automatic download failed: ${downloadErr.message}`,
      );
    }
  } catch (err) {
    api.dismissNotification(`llmm-download-check-${modId}`);
    api.sendNotification({
      id: `llmm-download-fail-${modId}`,
      type: 'error',
      title: 'Download Failed',
      message: `Failed to download update for ${mod.attributes?.name || modId}: ${err.message}`,
      displayMS: 6000,
    });
  }
}

async function checkSingleModAction(api, modId) {
  const state = api.getState();
  const gameId = selectors.activeGameId(state);
  if (gameId !== GAME_ID) return;

  const mods = util.getSafe(state, ['persistent', 'mods', gameId], {});
  const mod = mods[modId];
  if (!mod) return;

  const source = mod.attributes?.source || '';
  if (!source.includes(LOVERSLAB_DOMAIN)) {
    api.sendNotification({
      id: 'llmm-no-source',
      type: 'info',
      title: 'No LoversLab Source',
      message: 'This mod doesn\'t have a LoversLab source URL. Use "Set LL Source" first.',
      displayMS: 5000,
    });
    return;
  }

  api.sendNotification({
    id: `llmm-check-${modId}`,
    type: 'activity',
    title: 'Checking for Update',
    message: `Checking ${mod.attributes?.name || modId}...`,
  });

  try {
    const settings = getSettings(state);
    const update = await checkSingleMod(api, mod, settings);
    api.dismissNotification(`llmm-check-${modId}`);

    if (update) {
      api.showDialog('info', 'Update Available', {
        text: `${update.modName}\n\nInstalled: ${update.currentVersion}\nLatest: ${update.latestVersion}`,
        options: { wrap: true },
      }, [
        { label: 'Close' },
        update.downloadUrl ? {
          label: 'Download Update',
          action: () => downloadUpdate(api, update).catch((err) => manualImportUpdateFallback(
            api,
            mod,
            update,
            `Automatic download failed: ${err.message}`,
          )),
        } : null,
        {
          label: 'Select Local File',
          action: () => manualImportUpdateFallback(
            api,
            mod,
            update,
            update.downloadUrl
              ? 'Use a local archive file instead of direct download.'
              : 'No direct download link was found for this update.',
          ),
        },
        {
          label: 'Open in Browser',
          action: () => util.opn(update.modUrl).catch(() => {}),
        },
      ].filter(Boolean));
    } else {
      api.sendNotification({
        id: `llmm-uptodate-${modId}`,
        type: 'info',
        title: 'Up to Date',
        message: `${mod.attributes?.name || modId} is already at the latest version.`,
        displayMS: 4000,
      });
    }
  } catch (err) {
    api.dismissNotification(`llmm-check-${modId}`);
    api.sendNotification({
      id: `llmm-check-fail-${modId}`,
      type: 'error',
      title: 'Check Failed',
      message: `Failed to check ${mod.attributes?.name || modId}: ${err.message}`,
      displayMS: 5000,
    });
  }
}

async function showDependencyDialog(api, modId) {
  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});
  const mod = mods[modId];
  if (!mod) return;

  const source = mod.attributes?.source || '';
  if (!source.includes(LOVERSLAB_DOMAIN)) {
    api.sendNotification({
      id: 'llmm-dep-no-source',
      type: 'info',
      title: 'No LoversLab Source',
      message: 'Set a LoversLab source URL first to check dependencies.',
      displayMS: 5000,
    });
    return;
  }

  api.sendNotification({
    id: `llmm-dep-check-${modId}`,
    type: 'activity',
    title: 'Checking Dependencies',
    message: `Analysing dependencies for ${mod.attributes?.name || modId}...`,
  });

  try {
    const result = await analyseDependencies(api, modId, { rescrape: true });
    api.dismissNotification(`llmm-dep-check-${modId}`);

    if (result.dependencies.length === 0) {
      api.sendNotification({
        id: `llmm-dep-none-${modId}`,
        type: 'info',
        title: 'No Dependencies Found',
        message: 'No dependency information was found on the mod page.',
        displayMS: 5000,
      });
      return;
    }

    const satisfiedText = result.satisfied
      .map((d) => `  ✓ ${d.name} → ${d.matchedModName}`)
      .join('\n');
    const missingText = result.missing
      .map((d) => `  ✗ ${d.name}${d.url ? '' : ' (no URL)'}`)
      .join('\n');

    let text = `Dependencies for ${mod.attributes?.name || modId}:\n\n`;
    if (result.satisfied.length > 0) text += `Satisfied:\n${satisfiedText}\n\n`;
    if (result.missing.length > 0) text += `Missing:\n${missingText}`;
    if (result.missing.length === 0) text += 'All dependencies are satisfied!';

    const buttons = [{ label: 'Close' }];
    const missingWithUrls = result.missing.filter((d) => d.url);
    if (missingWithUrls.length > 0) {
      buttons.push({
        label: 'Open Missing in Browser',
        action: () => {
          missingWithUrls.forEach((d) => util.opn(d.url).catch(() => {}));
        },
      });
    }

    api.showDialog('info', 'Dependency Analysis', {
      text,
      options: { wrap: true },
    }, buttons);
  } catch (err) {
    api.dismissNotification(`llmm-dep-check-${modId}`);
    api.sendNotification({
      id: `llmm-dep-fail-${modId}`,
      type: 'error',
      title: 'Dependency Check Failed',
      message: err.message,
      displayMS: 5000,
    });
  }
}

function showDetectionDialog(api) {
  const state = api.getState();
  const settings = getSettings(state);
  const detected = detectLoversLabMods(state, { threshold: 30, includeTagged: false });

  if (detected.length === 0) {
    api.sendNotification({
      id: 'llmm-detect-none',
      type: 'info',
      title: 'No Potential LL Mods',
      message: 'No untagged mods were detected as likely LoversLab mods.',
      displayMS: 5000,
    });
    return;
  }

  const importDetectedMods = (selectedDetected) => {
    let imported = 0;
    selectedDetected.forEach((entry) => {
      const modId = entry.mod.id;
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId, attribute: 'source', value: 'https://www.loverslab.com/' },
      });
      api.store.dispatch({
        type: 'SET_MOD_ATTRIBUTE',
        payload: { gameId: GAME_ID, modId, attribute: 'llDetected', value: true },
      });
      imported++;
    });

    api.sendNotification({
      id: 'llmm-detect-imported',
      type: 'success',
      title: 'Detected Mods Imported',
      message: `Imported ${imported} detected mod(s). Use "Set LL Source" to set exact page URLs where needed.`,
      displayMS: 6000,
    });
  };

  if (settings.autoImportDetectedMods) {
    importDetectedMods(detected);
    return;
  }

  const checkboxes = detected.map((d) => {
    const name = d.mod.attributes?.name || d.mod.id;
    return {
      id: `detect_${d.mod.id}`,
      text: `${name} (confidence: ${d.score}%)`,
      value: true,
    };
  });

  api.showDialog('question', 'Detected Potential LoversLab Mods', {
    text: `Found ${detected.length} potential LoversLab mod(s). Select which ones to import.`,
    checkboxes,
    options: { wrap: true },
  }, [
    { label: 'Cancel' },
    {
      label: 'Import Selected',
      default: true,
      action: (result) => {
        const selected = detected.filter((d) => getDialogBool(result, `detect_${d.mod.id}`, false));
        if (selected.length === 0) {
          api.sendNotification({
            id: 'llmm-detect-none-selected',
            type: 'info',
            title: 'No Mods Selected',
            message: 'No detected mods were selected for import.',
            displayMS: 4000,
          });
          return;
        }

        importDetectedMods(selected);
      },
    },
  ]);
}

function showExportDialog(api) {
  api.showDialog('question', 'Export LoversLab Mod List', {
    text: 'Choose an export format:',
  }, [
    { label: 'Cancel' },
    {
      label: 'Export as JSON',
      action: () => exportToJson(api).catch((err) => {
        api.sendNotification({
          id: 'llmm-export-fail',
          type: 'error',
          title: 'Export Failed',
          message: err.message,
          displayMS: 5000,
        });
      }),
    },
    {
      label: 'Export as HTML Report',
      action: () => exportToHtml(api).catch((err) => {
        api.sendNotification({
          id: 'llmm-export-fail',
          type: 'error',
          title: 'Export Failed',
          message: err.message,
          displayMS: 5000,
        });
      }),
    },
  ]);
}

function showImportDialog(api) {
  api.showDialog('question', 'Import LoversLab Mod List', {
    text: 'Enter the path to a previously exported JSON file:',
    input: [
      {
        id: 'filePath',
        type: 'text',
        label: 'File Path',
        placeholder: 'C:\\path\\to\\loverslab-mods.json',
        value: '',
      },
    ],
  }, [
    { label: 'Cancel' },
    {
      label: 'Import',
      default: true,
      action: (result) => {
        const filePathValue = getDialogValue(result, 'filePath');
        const filePath = typeof filePathValue === 'string' ? filePathValue : '';
        if (!filePath) return;
        importFromJson(api, filePath).catch((err) => {
          api.sendNotification({
            id: 'llmm-import-fail',
            type: 'error',
            title: 'Import Failed',
            message: err.message,
            displayMS: 5000,
          });
        });
      },
    },
  ]);
}

// ─── Module Export ────────────────────────────────────────────────────────────

module.exports = {
  default: main,
};
