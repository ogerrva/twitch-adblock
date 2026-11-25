/**
 * TwitchShield — Lógica da Interface Popup
 */
(function initPopup() {
  'use strict';

  const els = {
    toggleEnabled: document.getElementById('toggle-enabled'),
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    channelName: document.getElementById('channel-name'),
    btnChannelWhitelist: document.getElementById('btn-channel-whitelist'),
    statSession: document.getElementById('stat-session'),
    statTotal: document.getElementById('stat-total'),
    btnResetStats: document.getElementById('btn-reset-stats'),
    modeAuto: document.getElementById('mode-auto'),
    modeMute: document.getElementById('mode-mute'),
    optHideBanners: document.getElementById('opt-hide-banners'),
    optFallbackMute: document.getElementById('opt-fallback-mute'),
    whitelistForm: document.getElementById('whitelist-form'),
    whitelistInput: document.getElementById('whitelist-input'),
    whitelistList: document.getElementById('whitelist-list'),
    whitelistEmpty: document.getElementById('whitelist-empty'),
    logsList: document.getElementById('logs-list'),
    logsEmpty: document.getElementById('logs-empty'),
    btnClearLogs: document.getElementById('btn-clear-logs'),
    tabButtons: document.querySelectorAll('.tab-btn'),
    tabPanels: document.querySelectorAll('.tab-panel')
  };

  let appState = {
    settings: null,
    stats: null,
    logs: [],
    isTwitchTab: false,
    activeTabId: null,
    tabState: null
  };

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false });
          return;
        }
        resolve(response || { ok: false });
      });
    });
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function render() {
    const { settings, stats, tabState, isTwitchTab, logs } = appState;
    if (!settings) return;

    // Controles gerais
    els.toggleEnabled.checked = Boolean(settings.enabled);
    els.optHideBanners.checked = Boolean(settings.hideBanners);
    els.optFallbackMute.checked = Boolean(settings.fallbackMute);

    els.modeAuto.classList.toggle('selected', settings.mode === 'auto');
    els.modeMute.classList.toggle('selected', settings.mode === 'mute');

    // Estatísticas
    els.statSession.textContent = String(tabState?.sessionBlocked || 0);
    els.statTotal.textContent = String(stats?.totalBlocked || 0);

    // Status do canal atual
    const channel = tabState?.channel || null;
    const whitelisted = Boolean(
      channel && settings.whitelist.some((c) => c.toLowerCase() === channel.toLowerCase())
    );

    els.statusPill.className = 'status-pill';

    if (!settings.enabled) {
      els.statusPill.classList.add('paused');
      els.statusText.textContent = 'Proteção pausada';
      els.channelName.textContent = channel ? `#${channel}` : 'Extensão desativada';
    } else if (!isTwitchTab) {
      els.statusPill.classList.add('paused');
      els.statusText.textContent = 'Aguardando Twitch';
      els.channelName.textContent = 'Abra uma live na Twitch';
    } else if (whitelisted) {
      els.statusPill.classList.add('whitelisted');
      els.statusText.textContent = 'Na lista branca';
      els.channelName.textContent = `#${channel}`;
    } else if (tabState?.isBlockingAd) {
      els.statusPill.classList.add('blocking');
      els.statusText.textContent =
        tabState.strategy === 'swap' ? 'Trocando stream (ad bloqueado)' : 'Silenciando anúncio';
      els.channelName.textContent = channel ? `#${channel}` : 'Live da Twitch';
    } else {
      els.statusText.textContent = 'Proteção ativa';
      els.channelName.textContent = channel ? `#${channel}` : 'Navegando na Twitch';
    }

    if (isTwitchTab && channel) {
      els.btnChannelWhitelist.hidden = false;
      els.btnChannelWhitelist.classList.toggle('is-whitelisted', whitelisted);
      els.btnChannelWhitelist.textContent = whitelisted ? 'Reativar bloqueio' : 'Permitir ads aqui';
    } else {
      els.btnChannelWhitelist.hidden = true;
    }

    // Lista branca
    renderWhitelist(settings.whitelist || []);

    // Logs
    renderLogs(logs || []);
  }

  function renderWhitelist(list) {
    els.whitelistList.innerHTML = '';
    els.whitelistEmpty.hidden = list.length > 0;

    for (const channel of list) {
      const li = document.createElement('li');
      li.className = 'whitelist-item';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `#${channel}`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-remove';
      removeBtn.textContent = 'Remover';
      removeBtn.addEventListener('click', async () => {
        const res = await sendMessage({ type: 'TOGGLE_WHITELIST', channel });
        if (res.ok) {
          appState.settings = res.settings;
          render();
        }
      });

      li.appendChild(nameSpan);
      li.appendChild(removeBtn);
      els.whitelistList.appendChild(li);
    }
  }

  function renderLogs(logs) {
    els.logsList.innerHTML = '';
    els.logsEmpty.hidden = logs.length > 0;

    for (const entry of logs) {
      const div = document.createElement('div');
      div.className = `log-item ${entry.level || 'info'}`;

      const meta = document.createElement('div');
      meta.className = 'log-meta';
      const ch = entry.channel ? ` · #${entry.channel}` : '';
      meta.textContent = `${formatTime(entry.timestamp)}${ch}`;

      const text = document.createElement('div');
      text.textContent = entry.message || '';

      div.appendChild(meta);
      div.appendChild(text);
      els.logsList.appendChild(div);
    }
  }

  async function updateSettings(partial) {
    const res = await sendMessage({ type: 'UPDATE_SETTINGS', settings: partial });
    if (res.ok) {
      appState.settings = res.settings;
      render();
    }
  }

  // =========================================================================
  // Eventos da UI
  // =========================================================================

  els.tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      els.tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
      els.tabPanels.forEach((p) => p.classList.toggle('active', p.id === `panel-${target}`));
    });
  });

  els.toggleEnabled.addEventListener('change', () => {
    updateSettings({ enabled: els.toggleEnabled.checked });
  });

  els.modeAuto.addEventListener('click', () => updateSettings({ mode: 'auto' }));
  els.modeMute.addEventListener('click', () => updateSettings({ mode: 'mute' }));

  els.optHideBanners.addEventListener('change', () => {
    updateSettings({ hideBanners: els.optHideBanners.checked });
  });

  els.optFallbackMute.addEventListener('change', () => {
    updateSettings({ fallbackMute: els.optFallbackMute.checked });
  });

  els.btnChannelWhitelist.addEventListener('click', async () => {
    const channel = appState.tabState?.channel;
    if (!channel) return;
    const res = await sendMessage({ type: 'TOGGLE_WHITELIST', channel });
    if (res.ok) {
      appState.settings = res.settings;
      render();
    }
  });

  els.btnResetStats.addEventListener('click', async () => {
    const res = await sendMessage({
      type: 'RESET_STATS',
      activeTabId: appState.activeTabId
    });
    if (res.ok) {
      appState.stats = res.stats;
      if (appState.tabState) appState.tabState.sessionBlocked = 0;
      render();
    }
  });

  els.whitelistForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = els.whitelistInput.value.trim().toLowerCase().replace(/^#/, '');
    if (!raw) return;
    if (!/^[a-z0-9_]{2,32}$/.test(raw)) {
      els.whitelistInput.focus();
      return;
    }
    const current = appState.settings?.whitelist || [];
    if (!current.includes(raw)) {
      await updateSettings({ whitelist: [...current, raw] });
    }
    els.whitelistInput.value = '';
  });

  els.btnClearLogs.addEventListener('click', async () => {
    const res = await sendMessage({ type: 'CLEAR_LOGS' });
    if (res.ok) {
      appState.logs = [];
      render();
    }
  });

  // Carrega estado inicial
  async function loadState() {
    const res = await sendMessage({ type: 'GET_POPUP_STATE' });
    if (res.ok) {
      appState = res;
      render();
    }
  }

  loadState();
})();
