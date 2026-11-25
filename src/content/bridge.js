/**
 * TwitchShield v1.1 — ISOLATED World Bridge (bridge.js)
 * Sincroniza configurações entre chrome.storage e o motor MAIN world,
 * aplica filtros cosméticos de banners e mantém a live 100% limpa (sem cards ou overlays).
 */
(function initTwitchShieldBridge() {
  'use strict';

  const MSG_SOURCE_MAIN = 'TWITCHSHIELD_MAIN';
  const MSG_SOURCE_BRIDGE = 'TWITCHSHIELD_BRIDGE';

  const DEFAULT_CONFIG = {
    enabled: true,
    mode: 'auto',
    hideBanners: true,
    fallbackMute: true,
    whitelist: []
  };

  let currentConfig = { ...DEFAULT_CONFIG };
  let currentChannel = null;
  let domAdActive = false;

  function isWhitelisted(channel) {
    if (!channel || !Array.isArray(currentConfig.whitelist)) return false;
    const lower = channel.toLowerCase();
    return currentConfig.whitelist.some((c) => String(c).toLowerCase() === lower);
  }

  function updateCosmeticClasses() {
    const root = document.documentElement;
    if (!root) return;

    const active = currentConfig.enabled && !isWhitelisted(currentChannel);
    root.classList.toggle('twitchshield-enabled', active);
    root.classList.toggle('twitchshield-hide-banners', active && currentConfig.hideBanners);
  }

  function pushConfigToMain() {
    window.postMessage(
      {
        source: MSG_SOURCE_BRIDGE,
        type: 'CONFIG_SYNC',
        payload: currentConfig
      },
      window.location.origin
    );
    updateCosmeticClasses();
  }

  function loadConfig() {
    chrome.storage.local.get(['settings'], (result) => {
      if (chrome.runtime.lastError) return;
      if (result && result.settings) {
        currentConfig = { ...DEFAULT_CONFIG, ...result.settings };
      }
      pushConfigToMain();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    currentConfig = { ...DEFAULT_CONFIG, ...(changes.settings.newValue || {}) };
    pushConfigToMain();
  });

  // Rede de segurança silenciosa no DOM (sem exibir card/overlay)
  function checkDomAdIndicator() {
    if (!currentConfig.enabled || isWhitelisted(currentChannel)) {
      if (domAdActive) {
        domAdActive = false;
        window.postMessage(
          { source: MSG_SOURCE_BRIDGE, type: 'DOM_AD_DETECTED', payload: { active: false } },
          window.location.origin
        );
      }
      return;
    }

    const adLabel = document.querySelector(
      '[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]'
    );
    const isVisible = Boolean(adLabel && adLabel.offsetParent !== null);

    if (isVisible !== domAdActive) {
      domAdActive = isVisible;
      window.postMessage(
        {
          source: MSG_SOURCE_BRIDGE,
          type: 'DOM_AD_DETECTED',
          payload: { active: isVisible }
        },
        window.location.origin
      );
    }
  }

  let domCheckScheduled = false;
  const observer = new MutationObserver(() => {
    if (domCheckScheduled) return;
    domCheckScheduled = true;
    requestAnimationFrame(() => {
      domCheckScheduled = false;
      checkDomAdIndicator();
    });
  });

  function startDomObserver() {
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
      return;
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function safeSendRuntimeMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // Extensão recarregada durante a sessão
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE_MAIN) return;

    switch (data.type) {
      case 'MAIN_READY':
        currentChannel = data.payload?.channel || null;
        pushConfigToMain();
        safeSendRuntimeMessage({
          type: 'TAB_CHANNEL_UPDATE',
          channel: currentChannel
        });
        break;

      case 'CHANNEL_CHANGED':
        currentChannel = data.payload?.channel || null;
        updateCosmeticClasses();
        safeSendRuntimeMessage({
          type: 'TAB_CHANNEL_UPDATE',
          channel: currentChannel
        });
        break;

      case 'AD_BLOCKED_EVENT':
        safeSendRuntimeMessage({
          type: 'AD_BLOCKED',
          channel: data.payload?.channel || currentChannel,
          mode: data.payload?.mode
        });
        break;

      case 'AD_STATUS_UPDATE': {
        const { active, strategy } = data.payload || {};
        safeSendRuntimeMessage({
          type: 'AD_STATE',
          active: Boolean(active),
          strategy: strategy || null,
          channel: data.payload?.channel || currentChannel
        });
        break;
      }

      case 'LOG_EVENT':
        safeSendRuntimeMessage({
          type: 'ADD_LOG',
          entry: data.payload
        });
        break;
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'PING_CHANNEL') {
      sendResponse({ channel: currentChannel });
      return true;
    }
    return false;
  });

  loadConfig();
  startDomObserver();
})();
