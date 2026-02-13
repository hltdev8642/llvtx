/**
 * Batch operations — check all, download all, and cancel-all workflows
 * with progress tracking and cancellation support.
 */
const { util } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  debugLog,
  infoLog,
  errorLog,
  getSettings,
} = require('./utils');
const { checkAllMods } = require('./updateChecker');
const { downloadUpdate, cancelDownload } = require('./downloader');

// ─── Cancel Token ────────────────────────────────────────────────────────────

let activeBatchToken = null;

function createCancelToken() {
  activeBatchToken = { cancelled: false };
  return activeBatchToken;
}

function cancelBatch() {
  if (activeBatchToken) {
    activeBatchToken.cancelled = true;
  }
}

function isBatchRunning() {
  return activeBatchToken !== null && !activeBatchToken.cancelled;
}

// ─── Batch Check ─────────────────────────────────────────────────────────────

/**
 * Check all LoversLab mods for updates and present the results via dialog.
 */
async function batchCheckUpdates(api) {
  if (isBatchRunning()) {
    api.sendNotification({
      id: 'llmm-batch-busy',
      type: 'warning',
      title: 'Batch In Progress',
      message: 'A batch operation is already running. Please wait or cancel it first.',
      displayMS: 5000,
    });
    return [];
  }

  const cancelToken = createCancelToken();

  try {
    const updates = await checkAllMods(api, true, cancelToken);

    if (cancelToken.cancelled) {
      api.sendNotification({
        id: 'llmm-batch-cancelled',
        type: 'info',
        title: 'Batch Cancelled',
        message: 'Update check was cancelled.',
        displayMS: 3000,
      });
      return [];
    }

    if (updates.length > 0) {
      showUpdateDialog(api, updates);
    }

    return updates;
  } finally {
    activeBatchToken = null;
  }
}

// ─── Batch Download ──────────────────────────────────────────────────────────

/**
 * Download all updates sequentially with progress notifications.
 * @param {Object} api
 * @param {Object[]} updates - array from checkAllMods
 */
async function batchDownloadUpdates(api, updates) {
  const downloadable = updates.filter((u) => u.downloadUrl);
  if (downloadable.length === 0) {
    api.sendNotification({
      id: 'llmm-batch-no-dl',
      type: 'info',
      title: 'No Downloads',
      message: 'No downloadable URLs were found for the available updates.',
      displayMS: 5000,
    });
    return;
  }

  const cancelToken = createCancelToken();
  const total = downloadable.length;
  let completed = 0;
  let failed = 0;

  api.sendNotification({
    id: 'llmm-batch-dl',
    type: 'activity',
    title: 'Batch Download',
    message: `Downloading 0/${total}...`,
    noDismiss: true,
    progress: 0,
    actions: [
      {
        title: 'Cancel',
        action: () => {
          cancelBatch();
          downloadable.forEach((u) => cancelDownload(u.modId));
          api.dismissNotification('llmm-batch-dl');
          api.sendNotification({
            id: 'llmm-batch-dl-cancel',
            type: 'info',
            title: 'Batch Download Cancelled',
            message: `Cancelled after ${completed}/${total} downloads.`,
            displayMS: 5000,
          });
        },
      },
    ],
  });

  for (const update of downloadable) {
    if (cancelToken.cancelled) break;

    try {
      await downloadUpdate(api, update);
      completed++;
    } catch (err) {
      failed++;
      errorLog('Batch download item failed', { modId: update.modId, error: err.message });
    }

    const pct = Math.round(((completed + failed) / total) * 100);
    api.sendNotification({
      id: 'llmm-batch-dl',
      type: 'activity',
      title: 'Batch Download',
      message: `${completed + failed}/${total} (${failed} failed)...`,
      noDismiss: true,
      progress: pct,
    });
  }

  api.dismissNotification('llmm-batch-dl');
  activeBatchToken = null;

  api.sendNotification({
    id: 'llmm-batch-dl-done',
    type: failed === 0 ? 'success' : 'warning',
    title: 'Batch Download Complete',
    message: `Downloaded ${completed}/${total} mod(s).${failed ? ` ${failed} failed.` : ''}`,
    displayMS: 8000,
  });

  infoLog('Batch download complete', { completed, failed, total });
}

// ─── Dialog ──────────────────────────────────────────────────────────────────

/**
 * Show a Vortex dialog listing available updates with action buttons.
 */
function showUpdateDialog(api, updates) {
  const state = api.getState();
  const mods = util.getSafe(state, ['persistent', 'mods', GAME_ID], {});

  const lines = updates.map((u) => {
    const name = u.modName || mods[u.modId]?.attributes?.name || u.modId;
    return `${name}: ${u.currentVersion} → ${u.latestVersion}`;
  });

  const buttons = [{ label: 'Close' }];

  // Individual download buttons
  updates.forEach((update) => {
    if (update.downloadUrl) {
      buttons.push({
        label: `Download ${update.modName}`,
        action: () => downloadUpdate(api, update).catch(() => {}),
      });
    }
  });

  // "Download All" if any have URLs
  if (updates.some((u) => u.downloadUrl)) {
    buttons.push({
      label: 'Download All Updates',
      action: () => batchDownloadUpdates(api, updates),
    });
  }

  // "Open in Browser" for all
  if (updates.length > 0) {
    buttons.push({
      label: 'Open All in Browser',
      action: () => {
        updates.forEach((u) => {
          if (u.modUrl) util.opn(u.modUrl).catch(() => {});
        });
      },
    });
  }

  api.showDialog('info', 'LoversLab Updates Available', {
    text: lines.join('\n\n'),
    options: { wrap: true },
  }, buttons);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  batchCheckUpdates,
  batchDownloadUpdates,
  showUpdateDialog,
  cancelBatch,
  isBatchRunning,
};
