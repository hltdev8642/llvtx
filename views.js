/**
 * React UI components for Vortex integration.
 * - ModInfoPanel: detail view for a single mod's LoversLab data
 * - SettingsPage: configuration page registered via context.registerSettings
 * - Version badge column for the mods table
 *
 * Vortex bundles React, so we use the copy from the Vortex runtime.
 */
const React = require('react');
const { connect } = require('react-redux');
const { util, selectors } = require('vortex-api');
const {
  GAME_ID,
  LOVERSLAB_DOMAIN,
  MOD_STATUS,
  DEFAULT_SETTINGS,
  normalizeVersion,
  compareVersions,
} = require('./utils');
const { getVersionData, buildVersionSummary } = require('./versionTracking');

// ─── Helper: timestamp → readable string ─────────────────────────────────────

function formatTimestamp(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleString();
}

// ─── ModInfoPanel ────────────────────────────────────────────────────────────
// Displayed in the mod detail panel when a LoversLab mod is selected.

class ModInfoPanelBase extends React.Component {
  render() {
    const { mod, versionData } = this.props;
    if (!mod) {
      return React.createElement('div', { className: 'llmm-info-panel' },
        React.createElement('p', null, 'Select a LoversLab mod to see details.'));
    }

    const source = mod.attributes?.source || '';
    const isLL = source.includes(LOVERSLAB_DOMAIN);
    if (!isLL) {
      return React.createElement('div', { className: 'llmm-info-panel' },
        React.createElement('p', null, 'This mod is not tagged as a LoversLab mod.'));
    }

    const installedVersion = normalizeVersion(mod.attributes?.version);
    const tracking = versionData?.[mod.id];
    const latestScraped = tracking?.latestScraped || null;
    const lastChecked = tracking?.lastChecked || null;
    const history = tracking?.history || [];

    let statusLabel = 'Unknown';
    let statusColor = '#888';
    if (latestScraped) {
      const cmp = compareVersions(latestScraped, installedVersion);
      if (cmp > 0) { statusLabel = 'Update Available'; statusColor = '#f9e2af'; }
      else { statusLabel = 'Up to Date'; statusColor = '#a6e3a1'; }
    }

    return React.createElement('div', { className: 'llmm-info-panel', style: { padding: '8px' } },
      React.createElement('h3', { style: { marginTop: 0 } }, 'LoversLab Info'),
      React.createElement('table', { style: { width: '100%', borderCollapse: 'collapse' } },
        React.createElement('tbody', null,
          this.row('Name', mod.attributes?.name || mod.id),
          this.row('Installed Version', installedVersion),
          this.row('Latest Scraped', latestScraped || '—'),
          this.row('Status', React.createElement('span', { style: { color: statusColor, fontWeight: 'bold' } }, statusLabel)),
          this.row('Last Checked', formatTimestamp(lastChecked)),
          this.row('Source', React.createElement('a', {
            href: '#',
            onClick: (e) => { e.preventDefault(); if (source) util.opn(source); },
            style: { color: '#89dceb' },
          }, 'Open on LoversLab')),
        ),
      ),
      history.length > 0 && React.createElement('details', { style: { marginTop: '8px' } },
        React.createElement('summary', { style: { cursor: 'pointer', color: '#cba6f7' } },
          `Version History (${history.length})`),
        React.createElement('ul', { style: { fontSize: '0.85rem', maxHeight: '120px', overflowY: 'auto' } },
          history.slice().reverse().map((h, i) =>
            React.createElement('li', { key: i },
              `${h.version} — ${formatTimestamp(h.scrapedAt)}`)),
        ),
      ),
    );
  }

  row(label, value) {
    return React.createElement('tr', null,
      React.createElement('td', { style: { padding: '2px 8px 2px 0', fontWeight: 'bold', whiteSpace: 'nowrap', verticalAlign: 'top' } }, label),
      React.createElement('td', { style: { padding: '2px 0' } }, value),
    );
  }
}

function mapModInfoState(state) {
  return {
    versionData: getVersionData(state),
  };
}

const ModInfoPanel = connect(mapModInfoState)(ModInfoPanelBase);

// ─── Settings Page ───────────────────────────────────────────────────────────
// Rendered via context.registerSettings

class SettingsPageBase extends React.Component {
  constructor(props) {
    super(props);
    this.handleChange = this.handleChange.bind(this);
  }

  handleChange(key, value) {
    this.props.onSetSetting(key, value);
  }

  render() {
    const s = { ...DEFAULT_SETTINGS, ...(this.props.settings || {}) };

    return React.createElement('div', { style: { maxWidth: 600 } },
      React.createElement('h3', null, 'LoversLab Mod Manager'),

      this.checkbox('autoCheckOnActivate', 'Auto-check for updates on game activation', s.autoCheckOnActivate),
      this.checkbox('autoCheckOnDeploy', 'Auto-check for updates after deployment', s.autoCheckOnDeploy),
      this.checkbox('autoDownload', 'Automatically download detected updates', s.autoDownload),
      this.checkbox('showNotifications', 'Show progress notifications', s.showNotifications),
      this.checkbox('backupBeforeUpdate', 'Backup mod files before update', s.backupBeforeUpdate),

      this.numberInput('checkIntervalMinutes', 'Check interval (minutes)', s.checkIntervalMinutes, 1, 1440),
      this.numberInput('maxConcurrentChecks', 'Max concurrent checks', s.maxConcurrentChecks, 1, 10),
      this.numberInput('requestTimeoutMs', 'Request timeout (ms)', s.requestTimeoutMs, 5000, 120000),
      this.numberInput('maxRetries', 'Max retries', s.maxRetries, 0, 10),
    );
  }

  checkbox(key, label, checked) {
    return React.createElement('div', { style: { margin: '6px 0' } },
      React.createElement('label', null,
        React.createElement('input', {
          type: 'checkbox',
          checked,
          onChange: (e) => this.handleChange(key, e.target.checked),
          style: { marginRight: 8 },
        }),
        label,
      ),
    );
  }

  numberInput(key, label, value, min, max) {
    return React.createElement('div', { style: { margin: '6px 0', display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement('label', { style: { minWidth: 200 } }, label),
      React.createElement('input', {
        type: 'number',
        value,
        min,
        max,
        onChange: (e) => {
          const num = parseInt(e.target.value, 10);
          if (!isNaN(num) && num >= min && num <= max) {
            this.handleChange(key, num);
          }
        },
        style: { width: 80 },
      }),
    );
  }
}

function mapSettingsState(state) {
  return {
    settings: state.settings?.loverslab || {},
  };
}

function mapSettingsDispatch(dispatch) {
  return {
    onSetSetting: (key, value) => dispatch({ type: 'LLMM_SET_SETTING', payload: { key, value } }),
  };
}

const SettingsPage = connect(mapSettingsState, mapSettingsDispatch)(SettingsPageBase);

// ─── Version Badge (table column attribute) ──────────────────────────────────

/**
 * Returns a React element showing the LL update badge.
 */
class VersionBadgeBase extends React.Component {
  render() {
    const { mod, versionData } = this.props;
    if (!mod) return null;

    const source = (mod.attributes?.source || '');
    if (!source.includes(LOVERSLAB_DOMAIN)) return null;

    const tracking = versionData?.[mod.id];
    if (!tracking?.latestScraped) {
      return React.createElement('span', {
        style: { color: '#888', fontSize: '0.8rem' },
        title: 'Not yet checked',
      }, '?');
    }

    const installed = normalizeVersion(mod.attributes?.version);
    const latest = tracking.latestScraped;
    const cmp = compareVersions(latest, installed);

    if (cmp > 0) {
      return React.createElement('span', {
        style: {
          background: '#f9e2af',
          color: '#1e1e2e',
          padding: '1px 6px',
          borderRadius: 3,
          fontSize: '0.75rem',
          fontWeight: 'bold',
        },
        title: `Update available: ${latest}`,
      }, `⬆ ${latest}`);
    }

    return React.createElement('span', {
      style: {
        background: '#a6e3a1',
        color: '#1e1e2e',
        padding: '1px 6px',
        borderRadius: 3,
        fontSize: '0.75rem',
      },
      title: 'Up to date',
    }, '✓');
  }
}

const VersionBadge = connect(mapModInfoState)(VersionBadgeBase);

// ─── Dashboard Summary Widget ────────────────────────────────────────────────

class DashboardWidgetBase extends React.Component {
  render() {
    const summary = buildVersionSummary(this.props.state || {});
    const outdated = summary.filter((s) => s.status === MOD_STATUS.OUTDATED).length;
    const total = summary.length;

    return React.createElement('div', { style: { padding: 8 } },
      React.createElement('h4', { style: { margin: '0 0 8px 0' } }, 'LoversLab Mods'),
      React.createElement('p', null, `${total} mod(s) tracked`),
      outdated > 0
        ? React.createElement('p', { style: { color: '#f9e2af', fontWeight: 'bold' } },
            `${outdated} update(s) available`)
        : React.createElement('p', { style: { color: '#a6e3a1' } }, 'All up to date'),
    );
  }
}

function mapDashboardState(state) {
  return { state };
}

const DashboardWidget = connect(mapDashboardState)(DashboardWidgetBase);

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ModInfoPanel,
  SettingsPage,
  VersionBadge,
  DashboardWidget,
};
