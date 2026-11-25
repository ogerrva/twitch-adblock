/**
 * TwitchShield — Background Service Worker (MV3)
 * Gerencia configurações, estatísticas, regras declarativeNetRequest,
 * logs de atividade e badge da extensão por aba.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'auto', // 'auto' | 'mute'
  hideBanners: true,
  fallbackMute: true,
  whitelist: []
};

const DEFAULT_STATS = {
  totalBlocked: 0,
  lastBlockedAt: null
};

const MAX_LOGS = 60;
const RULESET_ID = 'twitch_ad_rules';

const NON_CHANNEL_ROUTES = new Set([
  '',
  'directory',
  'downloads',
  'jobs',
  'turbo',
  'settings',
  'subscriptions',
  'inventory',
  'drops',
  'wallet',
  'search',
  'videos',
  'p',
  'u',
  'store',
  'prime',
  'friends',
  'messages',
  'activity',
  'following',
  'browse',
  'team',
  'teams',
  'collections',
  'clips'
]);

function extractChannelFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const url = new URL(urlStr);
    if (!url.hostname.endsWith('twitch.tv')) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    let candidate = parts[0].toLowerCase();
    if ((candidate === 'popout' || candidate === 'moderator' || candidate === 'embed') && parts[1]) {
      candidate = parts[1].toLowerCase();
    }
    if (NON_CHANNEL_ROUTES.has(candidate)) return null;
    if (!/^[a-z0-9_]{2,32}$/.test(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get(['settings']);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  if (Array.isArray(next.whitelist)) {
    next.whitelist = Array.from(
      new Set(
        next.whitelist
          .map((c) => String(c).trim().toLowerCase().replace(/^#/, ''))
          .filter((c) => /^[a-z0-9_]{2,32}$/.test(c))
      )
    );
  }
  await chrome.storage.local.set({ settings: next });
  await syncDnrRuleset(next.enabled);
  await refreshAllTwitchBadges(next);
  return next;
}

async function getStats() {
  const { stats } = await chrome.storage.local.get(['stats']);
  return { ...DEFAULT_STATS, ...(stats || {}) };
}

async function getLogs() {
  const { logs } = await chrome.storage.local.get(['logs']);
  return Array.isArray(logs) ? logs : [];
}

async function appendLog(entry) {
  const logs = await getLogs();
  logs.unshift({
    level: entry?.level || 'info',
    message: entry?.message || '',
    channel: entry?.channel || null,
    timestamp: entry?.timestamp || Date.now()
  });
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS;
  }
  await chrome.storage.local.set({ logs });
}

async function getTabState(tabId) {
  if (!tabId) return null;
  const key = `tab_${tabId}`;
  const data = await chrome.storage.session.get([key]);
  return (
    data[key] || {
      channel: null,
      sessionBlocked: 0,
      isBlockingAd: false,
      strategy: null
    }
  );
}

async function setTabState(tabId, patch) {
  if (!tabId) return null;
  const current = await getTabState(tabId);
  const next = { ...current, ...patch };
  await chrome.storage.session.set({ [`tab_${tabId}`]: next });
  return next;
}

async function syncDnrRuleset(enabled) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enabled ? [RULESET_ID] : [],
      disableRulesetIds: enabled ? [] : [RULESET_ID]
    });
  } catch {
    // Ignora caso o ruleset já esteja no estado solicitado
  }
}

async function updateTabBadge(tabId, settingsOverride = null) {
  if (!tabId) return;
  try {
    const settings = settingsOverride || (await getSettings());
    const tabState = await getTabState(tabId);

    if (!settings.enabled) {
      await chrome.action.setBadgeText({ tabId, text: 'OFF' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#53535f' });
      return;
    }

    const isWhitelisted =
      tabState.channel &&
      settings.whitelist.some((c) => c.toLowerCase() === tabState.channel.toLowerCase());

    if (isWhitelisted) {
      await chrome.action.setBadgeText({ tabId, text: 'WL' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });
      return;
    }

    if (tabState.isBlockingAd) {
      await chrome.action.setBadgeText({ tabId, text: 'AD' });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#00c978' });
      return;
    }

    if (tabState.sessionBlocked > 0) {
      const text = tabState.sessionBlocked > 99 ? '99+' : String(tabState.sessionBlocked);
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#9147ff' });
      return;
    }

    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Aba pode ter sido fechada durante a atualização
  }
}

async function refreshAllTwitchBadges(settings) {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' });
    await Promise.all(tabs.map((tab) => updateTabBadge(tab.id, settings)));
  } catch {
    // noop
  }
}

// ===========================================================================
// Ciclo de vida da extensão
// ===========================================================================

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get(['settings']);
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  const { stats } = await chrome.storage.local.get(['stats']);
  if (!stats) {
    await chrome.storage.local.set({ stats: DEFAULT_STATS });
  }
  const current = await getSettings();
  await syncDnrRuleset(current.enabled);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([`tab_${tabId}`]).catch(() => {});
});

// ===========================================================================
// Mensagens dos content scripts e do popup
// ===========================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  (async () => {
    try {
      const tabId = sender?.tab?.id;

      switch (message.type) {
        case 'TAB_CHANNEL_UPDATE': {
          if (tabId) {
            const prev = await getTabState(tabId);
            const changed = prev.channel !== message.channel;
            await setTabState(tabId, {
              channel: message.channel || null,
              isBlockingAd: false,
              strategy: null,
              sessionBlocked: changed ? 0 : prev.sessionBlocked
            });
            await updateTabBadge(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'AD_BLOCKED': {
          const stats = await getStats();
          stats.totalBlocked += 1;
          stats.lastBlockedAt = Date.now();
          await chrome.storage.local.set({ stats });

          if (tabId) {
            const prev = await getTabState(tabId);
            await setTabState(tabId, {
              channel: message.channel || prev.channel,
              sessionBlocked: prev.sessionBlocked + 1,
              isBlockingAd: true
            });
            await updateTabBadge(tabId);
          }
          sendResponse({ ok: true, totalBlocked: stats.totalBlocked });
          break;
        }

        case 'AD_STATE': {
          if (tabId) {
            await setTabState(tabId, {
              isBlockingAd: Boolean(message.active),
              strategy: message.strategy || null,
              channel: message.channel || (await getTabState(tabId)).channel
            });
            await updateTabBadge(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'ADD_LOG': {
          if (message.entry) {
            await appendLog(message.entry);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'GET_POPUP_STATE': {
          const [settings, stats, logs, tabs] = await Promise.all([
            getSettings(),
            getStats(),
            getLogs(),
            chrome.tabs.query({ active: true, currentWindow: true })
          ]);
          const activeTab = tabs[0] || null;
          const isTwitchTab = Boolean(activeTab?.url && /https?:\/\/([^/]+\.)?twitch\.tv/i.test(activeTab.url));
          let tabState = activeTab?.id
            ? await getTabState(activeTab.id)
            : { channel: null, sessionBlocked: 0, isBlockingAd: false, strategy: null };

          if (isTwitchTab && !tabState.channel) {
            tabState = {
              ...tabState,
              channel: extractChannelFromUrl(activeTab.url)
            };
          }

          sendResponse({
            ok: true,
            settings,
            stats,
            logs,
            isTwitchTab,
            activeTabId: activeTab?.id || null,
            tabState
          });
          break;
        }

        case 'UPDATE_SETTINGS': {
          const next = await saveSettings(message.settings || {});
          sendResponse({ ok: true, settings: next });
          break;
        }

        case 'TOGGLE_WHITELIST': {
          const channel = String(message.channel || '').trim().toLowerCase().replace(/^#/, '');
          if (!channel) {
            sendResponse({ ok: false, error: 'Canal inválido' });
            break;
          }
          const current = await getSettings();
          const exists = current.whitelist.includes(channel);
          const nextWhitelist = exists
            ? current.whitelist.filter((c) => c !== channel)
            : [...current.whitelist, channel];
          const next = await saveSettings({ whitelist: nextWhitelist });
          sendResponse({ ok: true, settings: next, whitelisted: !exists });
          break;
        }

        case 'RESET_STATS': {
          await chrome.storage.local.set({ stats: DEFAULT_STATS });
          if (message.activeTabId) {
            await setTabState(message.activeTabId, { sessionBlocked: 0 });
            await updateTabBadge(message.activeTabId);
          }
          sendResponse({ ok: true, stats: DEFAULT_STATS });
          break;
        }

        case 'CLEAR_LOGS': {
          await chrome.storage.local.set({ logs: [] });
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true;
});
