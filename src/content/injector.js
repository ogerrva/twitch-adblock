/**
 * TwitchShield v1.1 — MAIN World Engine (injector.js)
 * Executa em document_start no contexto da página para:
 * 1) Interceptar URL.createObjectURL + window.Worker e injetar o motor HLS
 *    diretamente no Blob do player Amazon IVS (sem race condition com revokeObjectURL).
 * 2) Detectar anúncios SSAI (stitched-ad / Amazon) nas playlists .m3u8.
 * 3) Trocar instantaneamente a playlist por um stream ao vivo limpo usando
 *    requisições anônimas em paralelo (embed, popout, autoplay, ios/android, etc.)
 *    com fallback automático para resoluções limpas (720p -> 480p -> 360p).
 * 4) Remover segmentos de anúncio (#EXTINF:...,Amazon / PREFETCH) para não exibir ads.
 * 5) Sem exibir NENHUM card ou overlay sobre o vídeo da live.
 */
(function initTwitchShieldMain() {
  'use strict';

  if (window.__TWITCHSHIELD_LOADED__) return;
  window.__TWITCHSHIELD_LOADED__ = true;

  const MSG_SOURCE_MAIN = 'TWITCHSHIELD_MAIN';
  const MSG_SOURCE_BRIDGE = 'TWITCHSHIELD_BRIDGE';
  const DEFAULT_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

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
    'clips',
    'activate',
    'login',
    'signup',
    'broadcast',
    'creatorcamp',
    'security'
  ]);

  const BLOCKED_GQL_OPERATIONS = new Set([
    'ClientSideAdEventHandling_RecordAdEvent',
    'VideoAdBanner',
    'AdRequestHandling',
    'RecordAdEvent',
    'StreamDisplayAd'
  ]);

  const state = {
    config: {
      enabled: true,
      mode: 'auto', // 'auto' (Stream Swap + Strip) | 'mute' (Apenas silenciar áudio nos ads)
      hideBanners: true,
      fallbackMute: true,
      whitelist: []
    },
    currentChannel: null,
    clientId: DEFAULT_CLIENT_ID,
    workerPorts: new Set(),
    isBlockingAd: false,
    isFallbackMuted: false,
    previousMutedState: null
  };

  // =========================================================================
  // Utilitários de canal e whitelist
  // =========================================================================

  function extractChannelFromUrl(urlStr) {
    try {
      const url = new URL(urlStr || window.location.href);
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

  function isChannelWhitelisted(channel) {
    if (!channel || !Array.isArray(state.config.whitelist)) return false;
    const normalized = channel.toLowerCase();
    return state.config.whitelist.some((c) => String(c).toLowerCase() === normalized);
  }

  function postToBridge(type, payload = {}) {
    try {
      window.postMessage(
        {
          source: MSG_SOURCE_MAIN,
          type,
          payload
        },
        window.location.origin
      );
    } catch {
      // Ignora erros de origem em frames transitórios
    }
  }

  function emitLog(level, message, details = null) {
    postToBridge('LOG_EVENT', {
      level,
      message,
      details,
      channel: state.currentChannel,
      timestamp: Date.now()
    });
  }

  function broadcastConfigToWorkers() {
    const msg = {
      type: 'CONFIG_UPDATE',
      config: state.config,
      clientId: state.clientId,
      currentChannel: state.currentChannel
    };
    for (const port of state.workerPorts) {
      try {
        port.postMessage(msg);
      } catch {
        state.workerPorts.delete(port);
      }
    }
  }

  // =========================================================================
  // Controle silencioso de áudio (sem exibir card nem overlay)
  // =========================================================================

  function getActiveVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    return videos.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];
  }

  function applyFallbackMute(shouldMute) {
    const video = getActiveVideoElement();
    if (!video) return;

    if (shouldMute) {
      if (!state.isFallbackMuted) {
        state.previousMutedState = video.muted;
        state.isFallbackMuted = true;
      }
      if (!video.muted) {
        video.muted = true;
      }
    } else if (state.isFallbackMuted) {
      if (state.previousMutedState === false) {
        video.muted = false;
      }
      state.isFallbackMuted = false;
      state.previousMutedState = null;
    }
  }

  // =========================================================================
  // Motor HLS injetado diretamente no Web Worker do player da Twitch
  // =========================================================================

  function workerBootstrap(handshakeTag) {
    const workerState = {
      port: null,
      config: {
        enabled: true,
        mode: 'auto',
        fallbackMute: true,
        whitelist: []
      },
      clientId: 'kimne78kx3ncx6brgo4mv6wki5h1ko',
      currentChannel: null,
      channelStreams: new Map(),
      urlToChannel: new Map()
    };

    const GQL_URL = 'https://gql.twitch.tv/gql';

    // Perfis testados em paralelo (Tier 1 mais rápido, Tier 2 fallback multiplataforma)
    const BACKUP_TIERS = [
      [
        { playerType: 'embed', platform: 'web' },
        { playerType: 'popout', platform: 'web' },
        { playerType: 'autoplay', platform: 'web' },
        { playerType: 'picture-by-picture', platform: 'web' }
      ],
      [
        { playerType: 'site', platform: 'ios' },
        { playerType: 'site', platform: 'android' },
        { playerType: 'frontpage', platform: 'web' },
        { playerType: 'thunderdome', platform: 'web' }
      ]
    ];

    const PLAYBACK_TOKEN_QUERY = `
      query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {
        streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
          value
          signature
          __typename
        }
        videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
          value
          signature
          __typename
        }
      }
    `;

    function sendToMain(type, payload) {
      if (!workerState.port) return;
      try {
        workerState.port.postMessage({ type, payload });
      } catch {
        // Canal fechado
      }
    }

    function log(level, message, details) {
      sendToMain('LOG', { level, message, details });
    }

    function isWhitelisted(channel) {
      if (!channel || !Array.isArray(workerState.config.whitelist)) return false;
      const lower = channel.toLowerCase();
      return workerState.config.whitelist.some((item) => String(item).toLowerCase() === lower);
    }

    function randomHex(length) {
      const chars = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < length; i++) {
        out += chars[Math.floor(Math.random() * 16)];
      }
      return out;
    }

    // Detecta anúncios SSAI (excluindo falsos positivos de metadados isolados)
    function hasAdMarkers(playlistText) {
      if (!playlistText) return false;
      if (
        playlistText.includes('stitched-ad') ||
        playlistText.includes('twitch-stitched-ad') ||
        playlistText.includes('X-TV-TWITCH-AD-URL') ||
        playlistText.includes('X-TV-TWITCH-AD-CLICK-TRACKING-URL') ||
        playlistText.includes('amazon-adsystem') ||
        /#EXTINF:[0-9.]+,\s*Amazon/i.test(playlistText) ||
        /#EXTINF:[0-9.]+,\s*[^,\n]*\|Amazon/i.test(playlistText)
      ) {
        return true;
      }
      // Verifica 'stitched' em DATERANGE ignorando 'twitch-ad-quartile' puro
      const lines = playlistText.split('\n');
      for (const line of lines) {
        if (
          line.startsWith('#EXT-X-DATERANGE') &&
          line.includes('stitched') &&
          !line.includes('twitch-ad-quartile')
        ) {
          return true;
        }
        if (line.startsWith('#EXT-X-SCTE35-OUT')) {
          return true;
        }
      }
      return false;
    }

    // Remove tags de ad e segmentos de vídeo marcados como anúncio (#EXTINF:...,Amazon)
    function stripAdSegments(playlistText) {
      const lines = playlistText.split('\n');
      const output = [];
      let liveSegmentCount = 0;
      let strippedCount = 0;
      let insideAdBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Remove DATERANGEs de anúncio
        if (
          line.startsWith('#EXT-X-DATERANGE') &&
          (line.includes('stitched') ||
            line.includes('twitch-ad-') ||
            line.includes('X-TV-TWITCH-AD-'))
        ) {
          if (line.includes('stitched-ad') || line.includes('twitch-stitched-ad')) {
            insideAdBlock = true;
          }
          continue;
        }

        if (line.startsWith('#EXT-X-SCTE35-OUT') || line.startsWith('#EXT-X-CUE-OUT')) {
          insideAdBlock = true;
          continue;
        }
        if (line.startsWith('#EXT-X-SCTE35-IN') || line.startsWith('#EXT-X-CUE-IN')) {
          insideAdBlock = false;
          continue;
        }

        // Remove PREFETCH de anúncios
        if (
          line.startsWith('#EXT-X-TWITCH-PREFETCH:') &&
          (insideAdBlock || line.includes('stitched') || line.includes('amazon-adsystem'))
        ) {
          strippedCount++;
          continue;
        }

        // Analisa pares #EXTINF + URL do segmento
        if (line.startsWith('#EXTINF:')) {
          const nextLine = lines[i + 1] || '';
          const isExplicitLive = /#EXTINF:[0-9.]+,\s*live\b/i.test(line);
          const isExplicitAd =
            /#EXTINF:[0-9.]+,\s*(Amazon|[^,\n]*\|Amazon|stitched)/i.test(line) ||
            nextLine.includes('stitched') ||
            nextLine.includes('amazon-adsystem');

          if (isExplicitAd || (!isExplicitLive && insideAdBlock)) {
            strippedCount++;
            // Pula o #EXTINF e a URL seguinte do segmento de ad
            if (nextLine && !nextLine.startsWith('#')) {
              i++;
            }
            continue;
          }

          if (isExplicitLive) {
            insideAdBlock = false;
            liveSegmentCount++;
          }
        }

        output.push(line);
      }

      return {
        text: output.join('\n'),
        liveSegmentCount,
        strippedCount
      };
    }

    function stripAdMetadataOnly(playlistText) {
      const lines = playlistText.split('\n');
      const cleaned = [];
      for (const line of lines) {
        if (
          line.startsWith('#EXT-X-DATERANGE') &&
          (line.includes('stitched') ||
            line.includes('twitch-ad-') ||
            line.includes('X-TV-TWITCH-AD-'))
        ) {
          continue;
        }
        cleaned.push(line);
      }
      return cleaned.join('\n');
    }

    function parseMasterPlaylist(text) {
      const lines = text.split('\n');
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const nextLine = (lines[i + 1] || '').trim();
          if (nextLine && !nextLine.startsWith('#')) {
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
            const videoMatch = line.match(/VIDEO="([^"]+)"/);
            variants.push({
              url: nextLine,
              bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0,
              width: resMatch ? parseInt(resMatch[1], 10) : 0,
              height: resMatch ? parseInt(resMatch[2], 10) : 0,
              video: videoMatch ? videoMatch[1] : ''
            });
          }
        }
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      return variants;
    }

    // Ordena variantes para tentar: 1) mais próxima da escolhida, 2) 720p/480p, 3) menor limpa
    function buildCandidateVariants(variants, preferredHeight) {
      if (!variants || variants.length === 0) return [];
      const seen = new Set();
      const ordered = [];

      const pushIfNew = (v) => {
        if (v && !seen.has(v.url)) {
          seen.add(v.url);
          ordered.push(v);
        }
      };

      if (preferredHeight) {
        const exact = variants.find((v) => v.height === preferredHeight);
        pushIfNew(exact);
      }
      // Tenta 720p, depois 480p, depois 360p, depois maior e menor disponíveis
      pushIfNew(variants.find((v) => v.height === 720));
      pushIfNew(variants.find((v) => v.height === 480));
      pushIfNew(variants.find((v) => v.height === 360));
      pushIfNew(variants[0]);
      pushIfNew(variants[variants.length - 1]);

      return ordered.slice(0, 4);
    }

    const originalFetch = self.fetch.bind(self);

    // Requisição GQL 100% anônima (credentials: 'omit', sem cookies, sem X-Device-Id)
    // para que a Twitch não vincule o stream reserva à sessão marcada com ad.
    async function fetchAnonymousToken(channelName, playerType, platform) {
      const body = JSON.stringify({
        operationName: 'PlaybackAccessToken_Template',
        query: PLAYBACK_TOKEN_QUERY,
        variables: {
          isLive: true,
          login: channelName,
          isVod: false,
          vodID: '',
          playerType,
          platform
        }
      });

      const res = await originalFetch(GQL_URL, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          'Client-ID': workerState.clientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'text/plain;charset=UTF-8'
        },
        body
      });

      if (!res.ok) return null;
      const json = await res.json();
      const tokenData = json?.data?.streamPlaybackAccessToken;
      if (!tokenData || !tokenData.value || !tokenData.signature) return null;
      return tokenData;
    }

    async function trySingleBackupProfile(channelName, profile, preferredHeight) {
      const tokenData = await fetchAnonymousToken(channelName, profile.playerType, profile.platform);
      if (!tokenData) throw new Error('no_token');

      const randomP = Math.floor(Math.random() * 9999999);
      const sessionId = randomHex(32);
      const masterUrl =
        `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(channelName)}.m3u8` +
        `?acmb=e30%3D&allow_source=true&fast_bread=true&p=${randomP}` +
        `&play_session_id=${sessionId}` +
        `&player_backend=mediaplayer&playlist_include_framerate=true` +
        `&reassignments_supported=true&supported_codecs=av1,h265,h264` +
        `&transcode_mode=cbr_v1&cdm=wv&player_version=1.30.0` +
        `&sig=${encodeURIComponent(tokenData.signature)}` +
        `&token=${encodeURIComponent(tokenData.value)}`;

      const masterRes = await originalFetch(masterUrl, { credentials: 'omit' });
      if (!masterRes.ok) throw new Error('master_failed');
      const masterText = await masterRes.text();
      const variants = parseMasterPlaylist(masterText);
      const candidates = buildCandidateVariants(variants, preferredHeight);

      for (const candidate of candidates) {
        const mediaRes = await originalFetch(candidate.url, { credentials: 'omit' });
        if (!mediaRes.ok) continue;
        const mediaText = await mediaRes.text();

        if (!hasAdMarkers(mediaText)) {
          return {
            text: stripAdMetadataOnly(mediaText),
            variantUrl: candidate.url,
            playerType: `${profile.playerType}/${profile.platform}`,
            resolution: candidate.height ? `${candidate.height}p` : 'auto'
          };
        }
      }

      throw new Error('profile_has_ads');
    }

    // Corre múltiplos perfis em paralelo e retorna o primeiro stream limpo em < 300ms
    async function fetchCleanBackupPlaylist(channelName, preferredHeight) {
      for (const tier of BACKUP_TIERS) {
        try {
          const winner = await Promise.any(
            tier.map((profile) => trySingleBackupProfile(channelName, profile, preferredHeight))
          );
          if (winner) return winner;
        } catch {
          // Nenhum perfil deste tier retornou limpo — tenta próximo tier
        }
      }
      return null;
    }

    function getOrCreateChannelEntry(channelName) {
      let entry = workerState.channelStreams.get(channelName);
      if (!entry) {
        entry = {
          channelName,
          variantMap: new Map(),
          backupVariantUrl: null,
          backupPlayerType: null,
          backupResolution: null,
          backupExpiresAt: 0,
          backupPromise: null,
          lastCleanPlaylist: null,
          isAdActive: false,
          usedSwap: false
        };
        workerState.channelStreams.set(channelName, entry);
      }
      return entry;
    }

    // Injeta #EXT-X-DISCONTINUITY logo antes do primeiro segmento ao trocar de stream
    function ensureDiscontinuity(playlistText) {
      if (playlistText.includes('#EXT-X-DISCONTINUITY')) return playlistText;
      return playlistText.replace(/(#EXTINF:)/, '#EXT-X-DISCONTINUITY\n$1');
    }

    // Intercepta a mensagem inicial de handshake sem vazá-la ao player Amazon IVS
    const nativeAddEventListener = self.addEventListener.bind(self);

    self.addEventListener = function (type, listener, options) {
      if (type === 'message' && typeof listener === 'function') {
        const proxy = function (event) {
          if (event && event.data && event.data[handshakeTag]) return;
          return listener.call(this, event);
        };
        return nativeAddEventListener(type, proxy, options);
      }
      return nativeAddEventListener(type, listener, options);
    };

    const onmessageDesc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(self),
      'onmessage'
    );
    if (onmessageDesc && onmessageDesc.set && onmessageDesc.get) {
      let userOnMessage = null;
      Object.defineProperty(self, 'onmessage', {
        configurable: true,
        enumerable: true,
        get() {
          return userOnMessage;
        },
        set(fn) {
          userOnMessage = fn;
          if (typeof fn === 'function') {
            onmessageDesc.set.call(self, function (event) {
              if (event && event.data && event.data[handshakeTag]) return;
              return fn.call(this, event);
            });
          } else {
            onmessageDesc.set.call(self, fn);
          }
        }
      });
    }

    nativeAddEventListener('message', function onHandshake(event) {
      if (event && event.data && event.data[handshakeTag] && event.ports && event.ports[0]) {
        event.stopImmediatePropagation();
        workerState.port = event.ports[0];
        if (event.data.initialState) {
          Object.assign(workerState.config, event.data.initialState.config || {});
          workerState.clientId = event.data.initialState.clientId || workerState.clientId;
          workerState.currentChannel = event.data.initialState.currentChannel || null;
        }
        workerState.port.onmessage = function (e) {
          const msg = e.data;
          if (!msg) return;
          if (msg.type === 'CONFIG_UPDATE') {
            if (msg.config) workerState.config = Object.assign({}, workerState.config, msg.config);
            if (msg.clientId) workerState.clientId = msg.clientId;
            if (msg.currentChannel !== undefined) workerState.currentChannel = msg.currentChannel;
          }
        };
        sendToMain('WORKER_READY', {});
      }
    });

    // Hook principal de self.fetch dentro do Worker HLS
    self.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';

      // 1) Playlist Master (usher.ttvnw.net) — registra canal e variantes
      if (url.includes('usher.ttvnw.net/api/channel/hls/')) {
        const res = await originalFetch(input, init);
        const match = url.match(/\/api\/channel\/hls\/([^/?]+)\.m3u8/i);
        if (match && res.ok) {
          const channelName = decodeURIComponent(match[1]).toLowerCase();
          try {
            const clone = res.clone();
            const masterText = await clone.text();
            const variants = parseMasterPlaylist(masterText);
            const entry = getOrCreateChannelEntry(channelName);
            for (const v of variants) {
              entry.variantMap.set(v.url, v);
              workerState.urlToChannel.set(v.url, channelName);
            }
            log('info', `Stream HLS capturado para #${channelName} (${variants.length} qualidades)`);
          } catch {
            // Não interrompe o player
          }
        }
        return res;
      }

      // 2) Playlists de mídia HLS (.m3u8)
      const isHlsMedia =
        url.includes('.m3u8') &&
        (url.includes('ttvnw.net') || url.includes('video-weaver') || url.includes('video-edge'));

      if (!isHlsMedia) {
        return originalFetch(input, init);
      }

      const res = await originalFetch(input, init);
      if (!res.ok) return res;

      const channelName = workerState.urlToChannel.get(url) || workerState.currentChannel;
      if (!workerState.config.enabled || isWhitelisted(channelName)) {
        return res;
      }

      let playlistText;
      try {
        playlistText = await res.text();
      } catch {
        return res;
      }

      const entry = channelName ? getOrCreateChannelEntry(channelName) : null;
      const adDetected = hasAdMarkers(playlistText);

      // Playlist limpa (sem anúncio)
      if (!adDetected) {
        let finalText = playlistText;
        if (entry) {
          entry.lastCleanPlaylist = playlistText;
          if (entry.isAdActive) {
            if (entry.usedSwap) {
              finalText = ensureDiscontinuity(playlistText);
            }
            entry.isAdActive = false;
            entry.usedSwap = false;
            entry.backupVariantUrl = null;
            entry.backupPlayerType = null;
            entry.backupExpiresAt = 0;
            entry.backupPromise = null;
            sendToMain('AD_ENDED', { channel: channelName });
            log('success', `Anúncio finalizado em #${channelName}. Qualidade original restaurada.`);
          }
        }
        return new Response(finalText, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      }

      // Anúncio SSAI detectado na playlist HLS!
      const isNewAdBreak = entry ? !entry.isAdActive : true;
      if (entry) entry.isAdActive = true;

      if (isNewAdBreak) {
        sendToMain('AD_STARTED', {
          channel: channelName,
          mode: workerState.config.mode
        });
        log('warn', `Anúncio HLS interceptado em #${channelName || 'live'}`);
      }

      // Modo "Silenciar Anúncios" (apenas mudo automático, sem card)
      if (workerState.config.mode === 'mute') {
        sendToMain('AD_FALLBACK_MUTE', { channel: channelName, reason: 'mute_mode' });
        return new Response(stripAdMetadataOnly(playlistText), {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
      }

      // Modo "Automático (Stream Swap + Strip)"
      if (channelName && entry) {
        const now = Date.now();
        const variantInfo = entry.variantMap.get(url);
        const preferredHeight = variantInfo ? variantInfo.height : 720;

        // 2a) Tenta reutilizar stream reserva já ativo
        if (entry.backupVariantUrl && now < entry.backupExpiresAt) {
          try {
            const cachedRes = await originalFetch(entry.backupVariantUrl, { credentials: 'omit' });
            if (cachedRes.ok) {
              const cachedText = await cachedRes.text();
              if (!hasAdMarkers(cachedText)) {
                entry.usedSwap = true;
                sendToMain('AD_SWAPPED', {
                  channel: channelName,
                  playerType: entry.backupPlayerType,
                  resolution: entry.backupResolution
                });
                return new Response(stripAdMetadataOnly(cachedText), {
                  status: 200,
                  statusText: 'OK',
                  headers: res.headers
                });
              }
            }
          } catch {
            // Busca novo backup abaixo
          }
          entry.backupVariantUrl = null;
        }

        // 2b) Evita buscas duplicadas simultâneas se o player fizer 2 polls seguidos
        if (!entry.backupPromise) {
          entry.backupPromise = fetchCleanBackupPlaylist(channelName, preferredHeight).finally(() => {
            entry.backupPromise = null;
          });
        }

        const backup = await entry.backupPromise;
        if (backup) {
          entry.backupVariantUrl = backup.variantUrl;
          entry.backupPlayerType = backup.playerType;
          entry.backupResolution = backup.resolution;
          entry.backupExpiresAt = Date.now() + 90_000;
          entry.usedSwap = true;

          sendToMain('AD_SWAPPED', {
            channel: channelName,
            playerType: backup.playerType,
            resolution: backup.resolution
          });
          log(
            'success',
            `Anúncio pulado! Stream limpo ativo (${backup.playerType} · ${backup.resolution}) em #${channelName}`
          );

          return new Response(ensureDiscontinuity(backup.text), {
            status: 200,
            statusText: 'OK',
            headers: res.headers
          });
        }
      }

      // 2c) Se o playlist misturar segmentos de live + anúncio, remove os segmentos de anúncio!
      const stripped = stripAdSegments(playlistText);
      if (stripped.liveSegmentCount > 0 && stripped.strippedCount > 0) {
        sendToMain('AD_SWAPPED', {
          channel: channelName,
          playerType: 'strip-segments',
          resolution: 'original'
        });
        log(
          'success',
          `Removidos ${stripped.strippedCount} segmentos de ad preservando ${stripped.liveSegmentCount} segmentos ao vivo.`
        );
        return new Response(stripped.text, {
          status: 200,
          statusText: 'OK',
          headers: res.headers
        });
      }

      // 2d) Último recurso quando 100% dos perfis de backup também recebem ad no servidor:
      // silencia apenas o áudio (sem card/overlay) enquanto tenta novamente no próximo poll HLS
      if (workerState.config.fallbackMute) {
        sendToMain('AD_FALLBACK_MUTE', { channel: channelName, reason: 'backup_unavailable' });
        if (isNewAdBreak) {
          log(
            'warn',
            `Todos os streams reserva receberam ad da Twitch em #${channelName}; aguardando stream limpo (áudio silenciado).`
          );
        }
      }

      return new Response(stripAdMetadataOnly(playlistText), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    };
  }

  // =========================================================================
  // Hook de URL.createObjectURL + URL.revokeObjectURL + window.Worker
  // Concatena o motor diretamente no Blob do Worker da Twitch (zero race condition)
  // =========================================================================

  const blobRegistry = new Map(); // blobUrl -> Blob
  const protectedWorkerUrls = new Set();

  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  URL.createObjectURL = function (obj) {
    const url = nativeCreateObjectURL(obj);
    if (obj instanceof Blob) {
      blobRegistry.set(url, obj);
      // Limite de memória: mantém no máximo os 40 blobs mais recentes
      if (blobRegistry.size > 40) {
        const oldestKey = blobRegistry.keys().next().value;
        blobRegistry.delete(oldestKey);
      }
    }
    return url;
  };

  URL.revokeObjectURL = function (url) {
    const urlStr = String(url);
    if (protectedWorkerUrls.has(urlStr)) {
      setTimeout(() => {
        protectedWorkerUrls.delete(urlStr);
        blobRegistry.delete(urlStr);
        nativeRevokeObjectURL(urlStr);
      }, 30_000);
      return;
    }
    blobRegistry.delete(urlStr);
    return nativeRevokeObjectURL(url);
  };

  const NativeWorker = window.Worker;
  const HANDSHAKE_TAG = '__ts_handshake_v2__';

  function shouldWrapWorker(scriptURL) {
    const urlStr = String(scriptURL || '');
    return (
      urlStr.startsWith('blob:') ||
      urlStr.includes('twitch') ||
      urlStr.includes('ttvnw') ||
      urlStr.includes('amazon-ivs') ||
      urlStr.includes('wasmworker')
    );
  }

  function createWrappedWorkerUrl(originalUrl, isModule) {
    const raw = String(originalUrl);
    const bootstrapCode = `(${workerBootstrap.toString()})(${JSON.stringify(HANDSHAKE_TAG)});\n`;

    // Caminho ideal (síncrono e imune a revokeObjectURL): concatena o Blob original!
    const originalBlob = blobRegistry.get(raw);
    if (originalBlob) {
      const mergedBlob = new Blob([bootstrapCode, originalBlob], {
        type: 'application/javascript'
      });
      return nativeCreateObjectURL(mergedBlob);
    }

    // Fallback para URLs externas ou blobs criados antes do script
    if (raw.startsWith('blob:')) {
      protectedWorkerUrls.add(raw);
    }
    const resolvedUrl = raw.startsWith('blob:') ? raw : new URL(raw, window.location.href).href;
    const escapedUrl = JSON.stringify(resolvedUrl);
    const loaderLine = isModule ? `import ${escapedUrl};` : `importScripts(${escapedUrl});`;

    const blob = new Blob([bootstrapCode + loaderLine], { type: 'application/javascript' });
    return nativeCreateObjectURL(blob);
  }

  class TwitchShieldWorker extends NativeWorker {
    constructor(scriptURL, options) {
      if (!shouldWrapWorker(scriptURL)) {
        super(scriptURL, options);
        return;
      }

      const isModule = Boolean(options && options.type === 'module');
      const wrappedUrl = createWrappedWorkerUrl(scriptURL, isModule);
      super(wrappedUrl, options);

      setTimeout(() => {
        try {
          nativeRevokeObjectURL(wrappedUrl);
        } catch {
          // noop
        }
      }, 20_000);

      try {
        const channel = new MessageChannel();
        const port1 = channel.port1;
        state.workerPorts.add(port1);

        port1.onmessage = (event) => {
          const msg = event.data;
          if (!msg || !msg.type) return;
          handleWorkerMessage(msg);
        };

        this.postMessage(
          {
            [HANDSHAKE_TAG]: true,
            initialState: {
              config: state.config,
              clientId: state.clientId,
              currentChannel: state.currentChannel
            }
          },
          [channel.port2]
        );
      } catch {
        // Falha silenciosa para nunca quebrar o player
      }
    }
  }

  try {
    Object.defineProperty(window, 'Worker', {
      value: TwitchShieldWorker,
      writable: true,
      configurable: true
    });
  } catch {
    window.Worker = TwitchShieldWorker;
  }

  function handleWorkerMessage(msg) {
    switch (msg.type) {
      case 'WORKER_READY':
        emitLog('info', 'Motor HLS v2 acoplado diretamente ao player da Twitch.');
        break;

      case 'AD_STARTED':
        state.isBlockingAd = true;
        postToBridge('AD_BLOCKED_EVENT', {
          channel: msg.payload?.channel || state.currentChannel,
          status: 'blocking',
          mode: msg.payload?.mode || state.config.mode
        });
        break;

      case 'AD_SWAPPED':
        applyFallbackMute(false);
        postToBridge('AD_STATUS_UPDATE', {
          active: true,
          channel: msg.payload?.channel || state.currentChannel,
          strategy: 'swap',
          playerType: msg.payload?.playerType,
          resolution: msg.payload?.resolution
        });
        break;

      case 'AD_FALLBACK_MUTE':
        applyFallbackMute(true);
        postToBridge('AD_STATUS_UPDATE', {
          active: true,
          channel: msg.payload?.channel || state.currentChannel,
          strategy: 'mute',
          reason: msg.payload?.reason
        });
        break;

      case 'AD_ENDED':
        state.isBlockingAd = false;
        applyFallbackMute(false);
        postToBridge('AD_STATUS_UPDATE', {
          active: false,
          channel: msg.payload?.channel || state.currentChannel
        });
        break;

      case 'LOG':
        emitLog(msg.payload?.level || 'info', msg.payload?.message || '', msg.payload?.details);
        break;
    }
  }

  // =========================================================================
  // Hook de window.fetch na thread principal (GQL + captura passiva de Client-ID)
  // =========================================================================

  const nativeWindowFetch = window.fetch.bind(window);

  function extractHeader(headers, name) {
    if (!headers) return null;
    const lower = name.toLowerCase();
    if (headers instanceof Headers) {
      return headers.get(name) || headers.get(lower);
    }
    if (Array.isArray(headers)) {
      const found = headers.find(([k]) => String(k).toLowerCase() === lower);
      return found ? found[1] : null;
    }
    if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return null;
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url ? input.url : '';

    if (url.includes('gql.twitch.tv/gql')) {
      const reqHeaders = init?.headers || (input instanceof Request ? input.headers : null);
      const cid = extractHeader(reqHeaders, 'Client-ID');
      if (cid && cid !== state.clientId) {
        state.clientId = cid;
        broadcastConfigToWorkers();
      }

      if (
        state.config.enabled &&
        !isChannelWhitelisted(state.currentChannel) &&
        init &&
        typeof init.body === 'string'
      ) {
        try {
          const parsed = JSON.parse(init.body);
          if (Array.isArray(parsed)) {
            const hasBlocked = parsed.some((op) => BLOCKED_GQL_OPERATIONS.has(op?.operationName));
            if (hasBlocked) {
              const filtered = parsed.filter((op) => !BLOCKED_GQL_OPERATIONS.has(op?.operationName));
              if (filtered.length === 0) {
                return new Response(
                  JSON.stringify(parsed.map(() => ({ data: {}, extensions: {} }))),
                  { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
              }
            }
          } else if (parsed && BLOCKED_GQL_OPERATIONS.has(parsed.operationName)) {
            return new Response(JSON.stringify({ data: {}, extensions: {} }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        } catch {
          // Segue requisição original
        }
      }
    }

    return nativeWindowFetch(input, init);
  };

  // =========================================================================
  // Monitoramento de navegação SPA da Twitch
  // =========================================================================

  function checkChannelChange() {
    const nextChannel = extractChannelFromUrl(window.location.href);
    if (nextChannel !== state.currentChannel) {
      state.currentChannel = nextChannel;
      state.isBlockingAd = false;
      applyFallbackMute(false);
      broadcastConfigToWorkers();
      postToBridge('CHANNEL_CHANGED', { channel: nextChannel });
    }
  }

  const nativePushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = nativePushState(...args);
    checkChannelChange();
    return result;
  };

  const nativeReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = nativeReplaceState(...args);
    checkChannelChange();
    return result;
  };

  window.addEventListener('popstate', checkChannelChange);

  // =========================================================================
  // Comunicação com bridge.js (ISOLATED world)
  // =========================================================================

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== MSG_SOURCE_BRIDGE) return;

    if (data.type === 'CONFIG_SYNC' && data.payload) {
      state.config = Object.assign({}, state.config, data.payload);
      if (!state.config.enabled || isChannelWhitelisted(state.currentChannel)) {
        applyFallbackMute(false);
      }
      broadcastConfigToWorkers();
    } else if (data.type === 'DOM_AD_DETECTED') {
      // Só silencia via rede DOM se o motor HLS não estiver em modo swap bem-sucedido
      if (
        state.config.enabled &&
        !isChannelWhitelisted(state.currentChannel) &&
        (state.config.mode === 'mute' || state.config.fallbackMute)
      ) {
        applyFallbackMute(Boolean(data.payload?.active));
      }
    }
  });

  state.currentChannel = extractChannelFromUrl(window.location.href);
  postToBridge('MAIN_READY', { channel: state.currentChannel });
})();
