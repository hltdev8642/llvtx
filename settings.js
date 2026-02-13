/**
 * Settings — configuration UI registration and persistent settings management.
 * Uses Vortex's settings API and persistent state.
 */
const { DEFAULT_SETTINGS, GAME_ID, debugLog, infoLog } = require('./utils');

// ─── Reducer ─────────────────────────────────────────────────────────────────

const settingsReducer = {
  reducers: {
    LLMM_SET_SETTING: (state, payload) => {
      const { key, value } = payload;
      return { ...state, [key]: value };
    },
    LLMM_RESET_SETTINGS: () => ({ ...DEFAULT_SETTINGS }),
  },
  defaults: { ...DEFAULT_SETTINGS },
};

// ─── Actions ─────────────────────────────────────────────────────────────────

function setSetting(api, key, value) {
  api.store.dispatch({
    type: 'LLMM_SET_SETTING',
    payload: { key, value },
  });
}

function resetSettings(api) {
  api.store.dispatch({ type: 'LLMM_RESET_SETTINGS', payload: {} });
}

// ─── Settings Dialog (fallback for non-React registration) ───────────────────

function showSettingsDialog(api) {
  const state = api.getState();
  const s = state.settings?.loverslab || {};
  const current = { ...DEFAULT_SETTINGS, ...s };

  api.showDialog(
    'question',
    'LoversLab Mod Manager — Settings',
    {
      text: 'Configure the LoversLab mod manager extension.\n\n',
      checkboxes: [
        {
          id: 'autoCheckOnActivate',
          text: 'Auto-check for updates when game mode activates',
          value: current.autoCheckOnActivate,
        },
        {
          id: 'autoCheckOnDeploy',
          text: 'Auto-check for updates after deployment',
          value: current.autoCheckOnDeploy,
        },
        {
          id: 'autoDownload',
          text: 'Automatically download updates when found',
          value: current.autoDownload,
        },
        {
          id: 'autoImportDetectedMods',
          text: 'Automatically import all detected LoversLab mods',
          value: current.autoImportDetectedMods,
        },
        {
          id: 'showNotifications',
          text: 'Show progress notifications',
          value: current.showNotifications,
        },
        {
          id: 'backupBeforeUpdate',
          text: 'Backup mod before applying update',
          value: current.backupBeforeUpdate,
        },
      ],
      input: [
        {
          id: 'checkIntervalMinutes',
          type: 'number',
          label: 'Check interval (minutes)',
          value: String(current.checkIntervalMinutes),
        },
        {
          id: 'maxConcurrentChecks',
          type: 'number',
          label: 'Max concurrent checks',
          value: String(current.maxConcurrentChecks),
        },
        {
          id: 'requestTimeoutMs',
          type: 'number',
          label: 'Request timeout (ms)',
          value: String(current.requestTimeoutMs),
        },
        {
          id: 'maxRetries',
          type: 'number',
          label: 'Max retries per request',
          value: String(current.maxRetries),
        },
      ],
    },
    [
      { label: 'Cancel' },
      { label: 'Reset to Defaults', action: () => { resetSettings(api); infoLog('Settings reset to defaults'); } },
      {
        label: 'Save',
        default: true,
        action: (result) => {
          const readDialogValue = (res, key) => {
            const sourceInput = res?.input;
            if (sourceInput && !Array.isArray(sourceInput) && Object.prototype.hasOwnProperty.call(sourceInput, key)) {
              return sourceInput[key];
            }
            if (Array.isArray(sourceInput)) {
              const found = sourceInput.find((entry) => entry?.id === key);
              if (found) return found.value;
            }

            const sourceCheckboxes = res?.checkboxes;
            if (sourceCheckboxes && !Array.isArray(sourceCheckboxes) && Object.prototype.hasOwnProperty.call(sourceCheckboxes, key)) {
              return sourceCheckboxes[key];
            }
            if (Array.isArray(sourceCheckboxes)) {
              const found = sourceCheckboxes.find((entry) => entry?.id === key);
              if (found) return found.value;
            }

            if (res && !Array.isArray(res) && Object.prototype.hasOwnProperty.call(res, key)) {
              return res[key];
            }
            return undefined;
          };

          // Boolean checkboxes
          [
            'autoCheckOnActivate',
            'autoCheckOnDeploy',
            'autoDownload',
            'autoImportDetectedMods',
            'showNotifications',
            'backupBeforeUpdate',
          ].forEach((key) => {
            const value = readDialogValue(result, key);
            if (value === undefined) return;
            const normalizedBool =
              typeof value === 'string'
                ? value.trim().toLowerCase() === 'true'
                : !!value;
            setSetting(api, key, normalizedBool);
          });

          // Numeric inputs
          ['checkIntervalMinutes', 'maxConcurrentChecks', 'requestTimeoutMs', 'maxRetries'].forEach((key) => {
            const num = parseInt(readDialogValue(result, key), 10);
            if (!isNaN(num) && num > 0) {
              setSetting(api, key, num);
            }
          });

          api.sendNotification({
            id: 'llmm-settings-saved',
            type: 'success',
            title: 'Settings Saved',
            message: 'LoversLab Mod Manager settings have been saved.',
            displayMS: 3000,
          });

          infoLog('Settings saved');
        },
      },
    ],
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  settingsReducer,
  setSetting,
  resetSettings,
  showSettingsDialog,
};
