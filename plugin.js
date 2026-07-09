(function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'ws://127.0.0.1:41920';
  var ACTION_COMMANDS = {
    'local.streamdock.foobar2000.stop': 'stop',
    'local.streamdock.foobar2000.previous': 'previous',
    'local.streamdock.foobar2000.next': 'next',
    'local.streamdock.foobar2000.mute': 'mute',
    'local.streamdock.foobar2000.nowplaying': 'now_playing',
    'local.streamdock.foobar2000.playbackorder': 'cycle_playback_order'
  };

  var streamDockSocket = null;
  var pluginUuid = null;
  var helperSocket = null;
  var reconnectTimer = null;
  var reconnectDelay = 2000;
  var pendingRating = null;
  var globalSettings = { endpoint: DEFAULT_ENDPOINT, volumeStep: 2, seekStepSeconds: 5, trackKnobTicks: 8, playlistName: '', playlistDialMode: 'playlist', trackAction: 'play', playPauseLongPressMs: 800, rating: 5, showProgress: true, nowPlayingTemplate: '', nowPlayingTextAlign: 'auto', nowPlayingMaxChars: 16, albumArtProvider: 'original', albumArtUrlTemplate: '', spotifyClientId: '', spotifyClientSecret: '', lastfmApiKey: '', searchQuery: '', generatedImages: true, invertKnob: false, minVolume: 0, maxVolume: 100 };
  var contexts = {};
  var dialTickAccumulators = {};
  var keyPressStates = {};
  var playlistPlaybackScoped = false;
  var artCache = {};
  var artPending = {};
  var composedArtCache = {};
  var composedArtPending = {};
  var spotifyToken = null;
  var spotifyTokenExpiresAt = 0;
  var lastState = { connected: false };
  var lastDiagnostics = null;
  var lastStateSummary = '';

  function parseJson(value, fallback) {
    if (!value) {
      return fallback;
    }
    try {
      return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (error) {
      return fallback;
    }
  }

  function sendToStreamDock(message) {
    if (streamDockSocket && streamDockSocket.readyState === WebSocket.OPEN) {
      streamDockSocket.send(JSON.stringify(message));
    }
  }

  function setTitle(context, title) {
    if (!context) {
      return;
    }
    sendToStreamDock({
      event: 'setTitle',
      context: context,
      payload: { title: String(title || ''), target: 0, state: 0 }
    });
  }

  function setImage(context, image) {
    if (context && image) {
      sendToStreamDock({ event: 'setImage', context: context, payload: { image: image, target: 0, state: 0 } });
    }
  }

  function setState(context) {
    if (context) {
      sendToStreamDock({ event: 'setState', context: context, payload: { state: 0 } });
    }
  }

  function showAlert(context) {
    sendToStreamDock({ event: 'showAlert', context: context });
  }

  function logMessage(message) {
    sendToStreamDock({ event: 'logMessage', payload: { message: '[streamdock-foobar2000] ' + message } });
  }

  function titleForContext(context) {
    var action = contexts[context] && contexts[context].action;
    if (!lastState.connected) {
      if (action === 'local.streamdock.foobar2000.nowplaying') return 'Now\noffline';
      if (action === 'local.streamdock.foobar2000.diagnostics') return 'Diag\noffline';
      return defaultTitleForAction(action);
    }
    if (action === 'local.streamdock.foobar2000.diagnostics') {
      return diagnosticsTitle();
    }
    if (action === 'local.streamdock.foobar2000.playbackorder') {
      return 'Order\n' + (lastState.playbackOrder || 'unknown');
    }
    if (action === 'local.streamdock.foobar2000.playlist') {
      if (globalSettings.playlistDialMode === 'track') {
        var count = Number(lastState.browseCount) || 0;
        var index = Number(lastState.browseIndex) || 0;
        return count ? 'Track ' + String(index + 1) + '/' + count + '\n' + truncateTitle(lastState.browseTrack || '') : 'Track\nempty';
      }
      return 'List\n' + (lastState.playlist || globalSettings.playlistName || 'set');
    }
    if (action === 'local.streamdock.foobar2000.rating') {
      var r = Math.max(0, Math.min(5, Math.round(Number(pendingRating !== null ? pendingRating : (lastState.rating || globalSettings.rating || 5)))));
      return 'Rate\n' + ratingStars(r);
    }
    if (action === 'local.streamdock.foobar2000.nowplaying') {
      if (globalSettings.generatedImages !== false && globalSettings.generatedImages !== 'false') {
        return '';
      }
      return formatNowPlaying(context);
    }
    if (action === 'local.streamdock.foobar2000.volume') {
      return formatVolume();
    }
    if (action === 'local.streamdock.foobar2000.trackknob') {
      return 'Track';
    }
    if (action === 'local.streamdock.foobar2000.mute') {
      return lastState.muted ? 'Unmute' : 'Mute';
    }
    if (action === 'local.streamdock.foobar2000.playpause') {
      return lastState.playing ? 'Pause' : 'Play';
    }
    return defaultTitleForAction(action);
  }

  function defaultTitleForAction(action) {
    return {
      'local.streamdock.foobar2000.stop': 'Stop',
      'local.streamdock.foobar2000.previous': 'Prev',
      'local.streamdock.foobar2000.next': 'Next',
      'local.streamdock.foobar2000.volume': 'Vol',
      'local.streamdock.foobar2000.trackknob': 'Track',
      'local.streamdock.foobar2000.mute': 'Mute',
      'local.streamdock.foobar2000.seek': 'Seek',
      'local.streamdock.foobar2000.playlist': 'List',
      'local.streamdock.foobar2000.playbackorder': 'Order',
      'local.streamdock.foobar2000.rating': 'Rate',
      'local.streamdock.foobar2000.playpause': 'Play'
    }[action] || '';
  }

  function formatNowPlaying() {
    if (!lastState.connected) {
      return 'Now\noffline';
    }
    if (!lastState.hasState) {
      return 'Now\nwaiting';
    }
    return nowPlayingText();
  }

  function nowPlayingText() {
    var artist = lastState.artist || '';
    var title = lastState.title || fileNameFromPath(lastState.track || '');
    var playlist = lastState.playlist || 'Playlist';
    if (globalSettings.nowPlayingTemplate) {
      return normalizeTemplateNewlines(globalSettings.nowPlayingTemplate).replace(/\{(artist|album|title|track|position|length|volume|playlist)\}/g, function (_, key) {
        return {
          artist: artist,
          album: lastState.album || '',
          title: title,
          track: lastState.track || '',
          position: formatTime(lastState.positionSeconds),
          length: formatTime(lastState.lengthSeconds),
          volume: Math.round(Number(lastState.volume) || 0) + '%',
          playlist: playlist
        }[key] || '';
      });
    }
    if (!artist && !title) {
      return lastState.playing ? 'Playing' : 'Stopped';
    }
    var line = truncateLine(playlist) + '\n' + truncateLine(artist || 'Unknown artist') + '\n' + truncateLine(title || 'Unknown track');
    if (globalSettings.showProgress && typeof lastState.positionSeconds === 'number' && typeof lastState.lengthSeconds === 'number' && lastState.lengthSeconds > 0) {
      line += '\n' + formatTime(lastState.positionSeconds) + '/' + formatTime(lastState.lengthSeconds);
    }
    return line;
  }

  function normalizeTemplateNewlines(value) {
    return String(value || '').replace(/\\n/g, '\n');
  }

  function fileNameFromPath(value) {
    value = String(value || '');
    if (!value) return '';
    try {
      value = decodeURIComponent(value.replace(/^file:\/\//i, ''));
    } catch (error) {
      value = value.replace(/^file:\/\//i, '');
    }
    var parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
  }

  function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    return minutes + ':' + (rest < 10 ? '0' : '') + rest;
  }

  function formatVolume() {
    if (typeof lastState.volume === 'number') {
      return 'Vol\n' + Math.round(lastState.volume) + '%';
    }
    return 'Vol';
  }

  function ratingStars(value) {
    var n = Math.max(0, Math.min(5, Math.round(Number(value) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  function truncateTitle(value) {
    value = String(value || '');
    return value.length > 36 ? value.slice(0, 35) + '…' : value;
  }

  function truncateLine(value) {
    value = String(value || '');
    return value.length > 22 ? value.slice(0, 21) + '…' : value;
  }

  function refreshTitles() {
    Object.keys(contexts).forEach(function (context) {
      setTitle(context, titleForContext(context));
      if (contexts[context].action === 'local.streamdock.foobar2000.nowplaying') {
        setImage(context, nowPlayingImage());
      } else if (globalSettings.generatedImages) {
        setImage(context, actionImage(context));
      }
    });
  }

  function refreshContext(context) {
    if (!context || !contexts[context]) {
      return;
    }
    setState(context);
    setTitle(context, titleForContext(context));
    if (contexts[context].action === 'local.streamdock.foobar2000.nowplaying') {
      setImage(context, nowPlayingImage());
    } else if (globalSettings.generatedImages) {
      setImage(context, actionImage(context));
    }
  }

  function nowPlayingImage() {
    var artwork = nowPlayingArtworkDataUrl();
    if (artwork) {
      var renderKey = nowPlayingArtworkRenderKey(artwork);
      if (Object.prototype.hasOwnProperty.call(composedArtCache, renderKey)) {
        return composedArtCache[renderKey] || nowPlayingTextOnlyImage();
      }
      if (!composedArtPending[renderKey]) {
        composedArtPending[renderKey] = true;
        composeNowPlayingArtwork(artwork).then(function (image) {
          composedArtCache[renderKey] = image || '';
          delete composedArtPending[renderKey];
          refreshNowPlayingImages();
        }).catch(function (error) {
          composedArtCache[renderKey] = '';
          delete composedArtPending[renderKey];
          logMessage('album art compose failed reason=' + String(error && error.message || error || 'unknown'));
          refreshNowPlayingImages();
        });
      }
      return nowPlayingTextOnlyImage();
    }
    return nowPlayingTextOnlyImage();
  }

  function nowPlayingArtworkDataUrl() {
    if (lastState.image) {
      return lastState.image;
    }
    var provider = albumArtProvider();
    if (provider === 'original' && globalSettings.albumArtUrlTemplate) {
      return cachedRemoteArtwork(provider, albumArtUrlFromTemplate());
    }
    if (provider !== 'original') {
      return externalArtImage();
    }
    return '';
  }

  function nowPlayingTextOnlyImage() {
    var fill = nowPlayingFillPercent();
    if (!lastState.connected) {
      return svgTextImage('#3a3a3a', '#ffffff', 'offline', fill);
    }
    if (!lastState.hasState) {
      return svgTextImage('#3a3a3a', '#ffffff', 'waiting', fill);
    }
    return svgTextImage(lastState.playing ? '#22543d' : '#3a3a3a', '#ffffff', nowPlayingText(), fill);
  }

  function nowPlayingFillPercent() {
    return Number(lastState.lengthSeconds) > 0 ? Number(lastState.positionSeconds) / Number(lastState.lengthSeconds) * 100 : 0;
  }

  function nowPlayingArtworkRenderKey(artwork) {
    return [
      artCacheKey(albumArtProvider()) || 'local',
      String(artwork || '').slice(0, 80),
      String(artwork || '').length,
      Math.round(nowPlayingFillPercent()),
      nowPlayingText()
    ].join('|');
  }

  function albumArtUrlFromTemplate() {
    return globalSettings.albumArtUrlTemplate
      .replace(/\{artist\}/g, encodeURIComponent(lastState.artist || ''))
      .replace(/\{title\}/g, encodeURIComponent(lastState.title || lastState.track || ''))
      .replace(/\{album\}/g, encodeURIComponent(lastState.album || ''));
  }

  function albumArtProvider() {
    return String(globalSettings.albumArtProvider || 'original').toLowerCase();
  }

  function externalArtImage() {
    var provider = albumArtProvider();
    if (provider === 'original') {
      return '';
    }
    var key = artCacheKey(provider);
    if (!key) {
      return '';
    }
    if (Object.prototype.hasOwnProperty.call(artCache, key)) {
      return artCache[key] || '';
    }
    if (!artPending[key]) {
      artPending[key] = true;
      fetchExternalArt(provider).then(function (url) {
        if (!url) {
          artCache[key] = '';
          delete artPending[key];
          logMessage('album art not found provider=' + provider + ' key=' + safeArtLogKey());
          refreshNowPlayingImages();
          return '';
        }
        return fetchImageDataUrl(url).then(function (dataUrl) {
          artCache[key] = dataUrl || '';
          delete artPending[key];
          logMessage('album art loaded provider=' + provider + ' key=' + safeArtLogKey());
          refreshNowPlayingImages();
          return dataUrl;
        });
      }).catch(function (error) {
        artCache[key] = '';
        delete artPending[key];
        logMessage('album art failed provider=' + provider + ' reason=' + String(error && error.message || error || 'unknown'));
        refreshNowPlayingImages();
      });
    }
    return '';
  }

  function cachedRemoteArtwork(provider, url) {
    if (!url) return '';
    var key = artCacheKey(provider) + '|url:' + url;
    if (Object.prototype.hasOwnProperty.call(artCache, key)) {
      return artCache[key] || '';
    }
    if (!artPending[key]) {
      artPending[key] = true;
      fetchImageDataUrl(url).then(function (dataUrl) {
        artCache[key] = dataUrl || '';
        delete artPending[key];
        logMessage('album art loaded provider=' + provider + ' key=' + safeArtLogKey());
        refreshNowPlayingImages();
      }).catch(function (error) {
        artCache[key] = '';
        delete artPending[key];
        logMessage('album art failed provider=' + provider + ' reason=' + String(error && error.message || error || 'unknown'));
        refreshNowPlayingImages();
      });
    }
    return '';
  }

  function refreshNowPlayingImages() {
    Object.keys(contexts).forEach(function (context) {
      if (contexts[context].action === 'local.streamdock.foobar2000.nowplaying') {
        setImage(context, nowPlayingImage());
      }
    });
  }

  function artCacheKey(provider) {
    var artist = String(lastState.artist || '').trim();
    var title = String(lastState.title || fileNameFromPath(lastState.track || '') || '').trim();
    var album = String(lastState.album || '').trim();
    if (!artist && !title && !album) {
      return '';
    }
    return [provider, artist.toLowerCase(), title.toLowerCase(), album.toLowerCase()].join('|');
  }

  function safeArtLogKey() {
    return [lastState.artist || '', lastState.album || '', lastState.title || fileNameFromPath(lastState.track || '') || '']
      .filter(function (part) { return String(part || '').trim(); })
      .join(' / ')
      .slice(0, 160);
  }

  function actionImage(context) {
    var action = contexts[context] && contexts[context].action;
    if (!lastState.connected) {
      return svgIconImage('#363b44', '#aeb7c2', iconForAction(action || ''), 0);
    }
    if (action === 'local.streamdock.foobar2000.mute') {
      return svgIconImage(lastState.muted ? '#22543d' : '#742a2a', '#ffffff', lastState.muted ? 'volume' : 'mute', 0);
    }
    if (action === 'local.streamdock.foobar2000.volume') {
      return svgIconImage('#234e52', '#ffffff', 'volume', Number(lastState.volume) || 0);
    }
    if (action === 'local.streamdock.foobar2000.trackknob') {
      return svgIconImage('#2d3748', '#ffffff', 'trackknob', 0);
    }
    return svgIconImage(lastState.playing ? '#22543d' : '#3a3a3a', '#ffffff', iconForAction(action || ''), 0);
  }

  function iconForAction(action) {
    return {
      'local.streamdock.foobar2000.playpause': 'playpause',
      'local.streamdock.foobar2000.stop': 'stop',
      'local.streamdock.foobar2000.previous': 'previous',
      'local.streamdock.foobar2000.next': 'next',
      'local.streamdock.foobar2000.mute': 'mute',
      'local.streamdock.foobar2000.seek': 'seek',
      'local.streamdock.foobar2000.playbackorder': 'playbackorder',
      'local.streamdock.foobar2000.playlist': 'playlist',
      'local.streamdock.foobar2000.rating': 'rating',
      'local.streamdock.foobar2000.diagnostics': 'diagnostics'
    }[action] || 'plugin';
  }

  function fetchExternalArt(provider) {
    if (provider === 'itunes') return fetchItunesArt();
    if (provider === 'spotify') return fetchSpotifyArt();
    if (provider === 'lastfm') return fetchLastfmArt();
    if (provider === 'deezer') return fetchDeezerArt();
    if (provider === 'musicbrainz') return fetchMusicBrainzArt();
    return Promise.resolve('');
  }

  function artSearchText() {
    return [lastState.artist || '', lastState.album || '', lastState.title || fileNameFromPath(lastState.track || '') || '']
      .filter(function (part) { return String(part || '').trim(); })
      .join(' ');
  }

  function fetchJson(url, options) {
    return fetch(url, options || {}).then(function (response) {
      if (!response || !response.ok) {
        throw new Error('http ' + String(response && response.status || 0));
      }
      return response.json();
    });
  }

  function fetchImageDataUrl(url) {
    url = normalizeImageUrl(url);
    return fetch(url).then(function (response) {
      if (!response || !response.ok) {
        throw new Error('image http ' + String(response && response.status || 0));
      }
      var contentType = response.headers && response.headers.get && response.headers.get('content-type') || 'image/jpeg';
      return response.arrayBuffer().then(function (buffer) {
        return 'data:' + contentType.split(';')[0] + ';base64,' + arrayBufferToBase64(buffer);
      });
    });
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function fetchItunesArt() {
    var term = artSearchText();
    if (!term) return Promise.resolve('');
    var url = 'https://itunes.apple.com/search?media=music&entity=song&limit=5&term=' + encodeURIComponent(term);
    return fetchJson(url).then(function (json) {
      var item = json && json.results && json.results[0];
      if (!item || !item.artworkUrl100) return '';
      var artwork = String(item.artworkUrl100);
      var upgraded = artwork.replace(/100x100bb\.(jpg|png)$/i, '600x600bb.$1');
      return normalizeImageUrl(upgraded || artwork);
    });
  }

  function fetchSpotifyToken() {
    var clientId = String(globalSettings.spotifyClientId || '').trim();
    var clientSecret = String(globalSettings.spotifyClientSecret || '').trim();
    if (!clientId || !clientSecret) return Promise.resolve('');
    if (spotifyToken && Date.now() < spotifyTokenExpiresAt) {
      return Promise.resolve(spotifyToken);
    }
    return fetchJson('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }).then(function (json) {
      spotifyToken = json && json.access_token || '';
      spotifyTokenExpiresAt = Date.now() + Math.max(60, Number(json && json.expires_in) || 3600) * 900;
      return spotifyToken;
    });
  }

  function fetchSpotifyArt() {
    var term = artSearchText();
    if (!term) return Promise.resolve('');
    return fetchSpotifyToken().then(function (token) {
      if (!token) return '';
      return fetchJson('https://api.spotify.com/v1/search?type=track&limit=1&q=' + encodeURIComponent(term), {
        headers: { 'Authorization': 'Bearer ' + token }
      }).then(function (json) {
        var images = json && json.tracks && json.tracks.items && json.tracks.items[0] &&
          json.tracks.items[0].album && json.tracks.items[0].album.images || [];
        return images.length ? normalizeImageUrl(images[0].url || '') : '';
      });
    });
  }

  function fetchLastfmArt() {
    var apiKey = String(globalSettings.lastfmApiKey || '').trim();
    var artist = String(lastState.artist || '').trim();
    var track = String(lastState.title || fileNameFromPath(lastState.track || '') || '').trim();
    if (!apiKey || !artist || !track) return Promise.resolve('');
    var url = 'https://ws.audioscrobbler.com/2.0/?method=track.getInfo&format=json&api_key=' +
      encodeURIComponent(apiKey) + '&artist=' + encodeURIComponent(artist) + '&track=' + encodeURIComponent(track);
    return fetchJson(url).then(function (json) {
      var images = json && json.track && json.track.album && json.track.album.image || [];
      for (var i = images.length - 1; i >= 0; i--) {
        if (images[i] && images[i]['#text']) return normalizeImageUrl(images[i]['#text']);
      }
      return '';
    });
  }

  function fetchDeezerArt() {
    var term = artSearchText();
    if (!term) return Promise.resolve('');
    return fetchJson('https://api.deezer.com/search/track?limit=1&q=' + encodeURIComponent(term)).then(function (json) {
      var item = json && json.data && json.data[0];
      return normalizeImageUrl(item && item.album && (item.album.cover_xl || item.album.cover_big || item.album.cover_medium) || '');
    });
  }

  function fetchMusicBrainzArt() {
    var artist = String(lastState.artist || '').trim();
    var track = String(lastState.title || fileNameFromPath(lastState.track || '') || '').trim();
    if (!artist && !track) return Promise.resolve('');
    var query = ['artist:"' + artist + '"', 'recording:"' + track + '"'].filter(function (part) {
      return !/""$/.test(part);
    }).join(' AND ');
    var url = 'https://musicbrainz.org/ws/2/recording?fmt=json&limit=1&inc=releases&query=' + encodeURIComponent(query);
    return fetchJson(url).then(function (json) {
      var releases = json && json.recordings && json.recordings[0] && json.recordings[0].releases || [];
      return fetchFirstCoverFromReleases(releases).then(function (coverUrl) {
        return coverUrl || fetchMusicBrainzReleaseArt();
      });
    });
  }

  function fetchMusicBrainzReleaseArt() {
    var artist = String(lastState.artist || '').trim();
    var album = String(lastState.album || '').trim();
    var title = String(lastState.title || fileNameFromPath(lastState.track || '') || '').trim();
    var releaseTerm = album || title;
    if (!releaseTerm) return Promise.resolve('');
    var query = ['artist:"' + artist + '"', 'release:"' + releaseTerm + '"'].filter(function (part) {
      return !/""$/.test(part);
    }).join(' AND ');
    return fetchJson('https://musicbrainz.org/ws/2/release?fmt=json&limit=1&query=' + encodeURIComponent(query)).then(function (json) {
      return fetchFirstCoverFromReleases(json && json.releases || []);
    });
  }

  function fetchFirstCoverFromReleases(releases) {
    releases = (releases || []).filter(function (release) { return release && release.id; }).slice(0, 5);
    var chain = Promise.resolve('');
    releases.forEach(function (release) {
      chain = chain.then(function (found) {
        return found || fetchCoverArtArchiveUrl(release.id);
      });
    });
    return chain;
  }

  function fetchCoverArtArchiveUrl(releaseId) {
    return fetchJson('https://coverartarchive.org/release/' + encodeURIComponent(releaseId)).then(function (coverJson) {
      var images = coverJson && coverJson.images || [];
      for (var i = 0; i < images.length; i++) {
        if (images[i] && images[i].front && images[i].thumbnails) {
          return normalizeImageUrl(images[i].thumbnails.large || images[i].image || '');
        }
      }
      return normalizeImageUrl(images[0] && (images[0].thumbnails && images[0].thumbnails.large || images[0].image) || '');
    }).catch(function () {
      return '';
    });
  }

  function normalizeImageUrl(url) {
    return String(url || '').replace(/^http:\/\//i, 'https://');
  }

  function svgImage(background, foreground, main, sub, fillPercent) {
    var fill = Math.max(0, Math.min(100, Number(fillPercent) || 0));
    var barWidth = Math.round(116 * fill / 100);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
      '<rect width="144" height="144" rx="20" fill="' + background + '"/>' +
      '<rect x="14" y="124" width="' + barWidth + '" height="8" rx="4" fill="' + foreground + '" opacity="0.32"/>' +
      '<circle cx="72" cy="52" r="34" fill="' + foreground + '" opacity="0.16"/>' +
      '<text x="72" y="66" text-anchor="middle" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="' + foreground + '">' + escapeSvg(main) + '</text>' +
      '<text x="72" y="101" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="' + foreground + '">' + escapeSvg(truncateImageText(sub)) + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
  }

  function svgTextImage(background, foreground, text, fillPercent) {
    var fill = Math.max(0, Math.min(100, Number(fillPercent) || 0));
    var barWidth = Math.round(116 * fill / 100);
    var textLayout = nowPlayingTextLayout();
    var lines = String(text || '').split(/\r?\n/).map(function (line) {
      return imageLineLayout(line, textLayout);
    }).filter(function (line) {
      return line.text;
    }).slice(0, 5);
    if (!lines.length) lines = [{ text: '', x: 72, anchor: 'middle' }];
    var fontSize = lines.length <= 3 ? 18 : 15;
    var lineHeight = lines.length <= 3 ? 23 : 18;
    var startY = Math.round(72 - ((lines.length - 1) * lineHeight / 2));
    var textNodes = lines.map(function (line, index) {
      return '<text x="' + line.x + '" y="' + (startY + index * lineHeight) + '" text-anchor="' + line.anchor + '" font-family="Arial, sans-serif" font-size="' + fontSize + '" font-weight="700" fill="' + foreground + '">' + escapeSvg(line.text) + '</text>';
    }).join('');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
      '<rect width="144" height="144" rx="20" fill="' + background + '"/>' +
      '<rect x="14" y="124" width="' + barWidth + '" height="8" rx="4" fill="' + foreground + '" opacity="0.32"/>' +
      textNodes +
      '</svg>';
    return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
  }

  function svgArtworkImage(artDataUrl, text, fillPercent) {
    var fill = Math.max(0, Math.min(100, Number(fillPercent) || 0));
    var barWidth = Math.round(116 * fill / 100);
    var textLayout = nowPlayingTextLayout();
    var lines = String(text || '').split(/\r?\n/).map(function (line) {
      return imageLineLayout(line, textLayout);
    }).filter(function (line) {
      return line.text;
    }).slice(0, 4);
    if (!lines.length) lines = [{ text: '', x: 72, anchor: 'middle' }];
    var fontSize = lines.length <= 3 ? 16 : 14;
    var lineHeight = lines.length <= 3 ? 19 : 16;
    var blockHeight = lines.length * lineHeight + 18;
    var panelY = Math.max(58, 122 - blockHeight);
    var startY = panelY + 18;
    var textNodes = lines.map(function (line, index) {
      return '<text x="' + line.x + '" y="' + (startY + index * lineHeight) + '" text-anchor="' + line.anchor + '" font-family="Arial, sans-serif" font-size="' + fontSize + '" font-weight="700" fill="#ffffff" stroke="#000000" stroke-width="2" paint-order="stroke">' + escapeSvg(line.text) + '</text>';
    }).join('');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
      '<defs><linearGradient id="npFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0"/><stop offset="0.28" stop-color="#000000" stop-opacity="0.32"/><stop offset="1" stop-color="#000000" stop-opacity="0.82"/></linearGradient><clipPath id="npClip"><rect width="144" height="144" rx="20"/></clipPath></defs>' +
      '<g clip-path="url(#npClip)">' +
      '<rect width="144" height="144" fill="#20252b"/>' +
      '<image href="' + escapeSvg(artDataUrl) + '" x="0" y="0" width="144" height="144" preserveAspectRatio="xMidYMid slice"/>' +
      '<rect x="0" y="' + panelY + '" width="144" height="' + (144 - panelY) + '" fill="url(#npFade)"/>' +
      '<rect x="14" y="124" width="' + barWidth + '" height="8" rx="4" fill="#ffffff" opacity="0.55"/>' +
      textNodes +
      '</g></svg>';
    return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
  }

  function composeNowPlayingArtwork(artDataUrl) {
    if (typeof document === 'undefined' || !document.createElement || typeof Image === 'undefined') {
      return Promise.resolve(svgArtworkImage(artDataUrl, nowPlayingText(), nowPlayingFillPercent()));
    }
    return loadImage(artDataUrl).then(function (image) {
      var canvas = document.createElement('canvas');
      canvas.width = 144;
      canvas.height = 144;
      var ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.fillStyle = '#20252b';
      ctx.fillRect(0, 0, 144, 144);
      drawCover(ctx, image);
      drawArtworkOverlay(ctx);
      return canvas.toDataURL('image/png');
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error('image decode failed')); };
      image.src = src;
    });
  }

  function drawCover(ctx, image) {
    var width = image.naturalWidth || image.width || 144;
    var height = image.naturalHeight || image.height || 144;
    var scale = Math.max(144 / width, 144 / height);
    var drawWidth = width * scale;
    var drawHeight = height * scale;
    ctx.drawImage(image, (144 - drawWidth) / 2, (144 - drawHeight) / 2, drawWidth, drawHeight);
  }

  function drawArtworkOverlay(ctx) {
    var lines = String(nowPlayingText() || '').split(/\r?\n/).map(function (line) {
      return imageLineLayout(line, nowPlayingTextLayout());
    }).filter(function (line) {
      return line.text;
    }).slice(0, 4);
    if (!lines.length) lines = [{ text: '', x: 72, anchor: 'middle' }];
    var fontSize = lines.length <= 3 ? 16 : 14;
    var lineHeight = lines.length <= 3 ? 19 : 16;
    var blockHeight = lines.length * lineHeight + 18;
    var panelY = Math.max(58, 122 - blockHeight);
    var gradient = ctx.createLinearGradient(0, panelY, 0, 144);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.28, 'rgba(0,0,0,0.35)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.84)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, panelY, 144, 144 - panelY);

    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.font = '700 ' + fontSize + 'px Arial, sans-serif';
    ctx.textBaseline = 'alphabetic';
    lines.forEach(function (line, index) {
      ctx.textAlign = line.anchor === 'start' ? 'left' : line.anchor === 'end' ? 'right' : 'center';
      var y = panelY + 18 + index * lineHeight;
      ctx.strokeStyle = 'rgba(0,0,0,0.82)';
      ctx.strokeText(line.text, line.x, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(line.text, line.x, y);
    });

    var fill = Math.max(0, Math.min(100, Number(nowPlayingFillPercent()) || 0));
    ctx.globalAlpha = 0.58;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, 14, 124, Math.round(116 * fill / 100), 8, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    if (width <= 0 || height <= 0) return;
    radius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function svgIconImage(background, foreground, icon, fillPercent) {
    var fill = Math.max(0, Math.min(100, Number(fillPercent) || 0));
    var barWidth = Math.round(116 * fill / 100);
    var shape = iconShape(icon, foreground);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">' +
      '<rect width="144" height="144" rx="20" fill="' + background + '"/>' +
      '<rect x="14" y="124" width="' + barWidth + '" height="8" rx="4" fill="' + foreground + '" opacity="0.32"/>' +
      '<circle cx="72" cy="72" r="47" fill="' + foreground + '" opacity="0.12"/>' +
      shape +
      '</svg>';
    return 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);
  }

  function iconShape(icon, color) {
    var stroke = ' stroke="' + color + '" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"';
    var fill = ' fill="' + color + '"';
    if (icon === 'playpause') return '<path d="M49 42v60l42-30z"' + fill + '/><path d="M96 45v54M114 45v54"' + stroke + '/>';
    if (icon === 'stop') return '<rect x="45" y="45" width="54" height="54" rx="7"' + fill + '/>';
    if (icon === 'previous') return '<path d="M42 43v58M101 43 58 72l43 29z"' + fill + '/>';
    if (icon === 'next') return '<path d="M102 43v58M43 43l43 29-43 29z"' + fill + '/>';
    if (icon === 'volume') return '<path d="M36 62h22l26-22v64L58 82H36z"' + fill + '/><path d="M94 54c10 10 10 26 0 36"' + stroke + '/>';
    if (icon === 'mute') return '<path d="M36 62h22l26-22v64L58 82H36z"' + fill + '/><path d="M96 58l24 28M120 58 96 86"' + stroke + '/>';
    if (icon === 'trackknob') return '<circle cx="72" cy="72" r="32"' + stroke + '/><path d="M72 40v18M96 72h18M85 61l26-18M59 61 33 43"' + stroke + '/>';
    if (icon === 'seek') return '<path d="M42 72h60M58 52 38 72l20 20M86 52l20 20-20 20"' + stroke + '/>';
    if (icon === 'playbackorder') return '<path d="M46 55h45l-12-12M98 89H53l12 12"' + stroke + '/>';
    if (icon === 'playlist') return '<path d="M43 50h58M43 72h58M43 94h38"' + stroke + '/>';
    if (icon === 'rating') return '<path d="M72 35l11 24 26 3-19 18 5 26-23-13-23 13 5-26-19-18 26-3z"' + fill + '/>';
    if (icon === 'diagnostics') return '<path d="M42 76l16 16 42-44M40 112h64"' + stroke + '/>';
    return '<circle cx="72" cy="64" r="28"' + stroke + '/><path d="M45 43l-10-16M99 43l10-16M52 77h40M58 59h.1M86 59h.1"' + stroke + '/>';
  }

  function truncateImageText(value) {
    value = String(value || '');
    return value.length > 12 ? value.slice(0, 12) : value;
  }

  function truncateImageLine(value, maxChars) {
    value = String(value || '');
    var limit = Math.max(1, Math.min(64, Number(maxChars) || 16));
    return displayWidth(value) > limit ? truncateByDisplayWidth(value, Math.max(1, limit - 1)) + '…' : value;
  }

  function nowPlayingTextLayout() {
    var align = String(globalSettings.nowPlayingTextAlign || 'center').toLowerCase();
    var maxChars = Number(globalSettings.nowPlayingMaxChars) || 16;
    if (align === 'auto') {
      return { x: 72, anchor: 'middle', maxChars: maxChars, auto: true };
    }
    if (align === 'left') {
      return { x: 16, anchor: 'start', maxChars: maxChars };
    }
    if (align === 'right') {
      return { x: 128, anchor: 'end', maxChars: maxChars };
    }
    return { x: 72, anchor: 'middle', maxChars: maxChars };
  }

  function imageLineLayout(value, layout) {
    var text = String(value || '');
    var maxChars = Number(layout.maxChars) || 16;
    var truncated = displayWidth(text) > Math.max(1, Math.min(64, maxChars));
    var rendered = truncateImageLine(text, maxChars);
    if (layout.auto && truncated) {
      return { text: rendered, x: 16, anchor: 'start' };
    }
    return { text: rendered, x: layout.x, anchor: layout.anchor };
  }

  function truncateByDisplayWidth(value, maxWidth) {
    var result = '';
    var width = 0;
    var chars = Array.from(String(value || ''));
    for (var i = 0; i < chars.length; i++) {
      var charWidth = displayCharWidth(chars[i]);
      if (width + charWidth > maxWidth) {
        break;
      }
      result += chars[i];
      width += charWidth;
    }
    return result;
  }

  function displayWidth(value) {
    return Array.from(String(value || '')).reduce(function (sum, char) {
      return sum + displayCharWidth(char);
    }, 0);
  }

  function displayCharWidth(char) {
    var code = char.codePointAt(0);
    if (code <= 0x1F || (code >= 0x7F && code <= 0x9F)) return 0;
    if (
      code >= 0x1100 && (
        code <= 0x115F ||
        code === 0x2329 ||
        code === 0x232A ||
        (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F) ||
        (code >= 0xAC00 && code <= 0xD7A3) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFE10 && code <= 0xFE19) ||
        (code >= 0xFE30 && code <= 0xFE6F) ||
        (code >= 0xFF00 && code <= 0xFF60) ||
        (code >= 0xFFE0 && code <= 0xFFE6) ||
        (code >= 0x1F300 && code <= 0x1FAFF)
      )
    ) {
      return 2;
    }
    return 1;
  }

  function escapeSvg(value) {
    return String(value || '').replace(/[&<>"]/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch];
    });
  }

  function helperSend(payload) {
    if (!helperSocket || helperSocket.readyState !== WebSocket.OPEN) {
      connectHelper();
      return false;
    }
    helperSocket.send(JSON.stringify(payload));
    return true;
  }

  function sendCommand(command, extra) {
    return helperSend(Object.assign({ command: command }, extra || {}));
  }

  function sendActionCommand(context, action, command, extra) {
    if (sendCommand(command, extra)) {
      return true;
    }
    logCommandFailure(context, action, command, 'component socket unavailable');
    return false;
  }

  function logCommandFailure(context, action, command, reason) {
    logMessage('command failed action=' + String(action || 'unknown') +
      ' command=' + String(command || 'unknown') +
      ' context=' + String(context || 'none') +
      ' reason=' + String(reason || 'unknown'));
  }

  function nowPlayingSummary() {
    return [
      lastState.playlist || 'Playlist',
      lastState.artist || 'Unknown artist',
      lastState.title || fileNameFromPath(lastState.track || '') || 'Unknown track'
    ].join(' / ');
  }

  function diagnosticsTitle() {
    if (lastDiagnostics && lastDiagnostics.ok === false) {
      return 'Diag\nerror';
    }
    if (lastDiagnostics && lastDiagnostics.ok) {
      return 'Diag\nok\n' + truncateLine(lastDiagnostics.playbackOrder || lastDiagnostics.playlist || 'ready');
    }
    return lastState.connected ? 'Diag\nready' : 'Diag\noffline';
  }

  function diagnosticsSummary(payload) {
    if (!payload) return 'diagnostics unavailable';
    return 'diagnostics ok=' + String(payload.ok) +
      ' clients=' + String(payload.clientCount) +
      ' order=' + String(payload.playbackOrder || '') +
      ' playlist=' + String(payload.playlist || '') +
      ' track=' + String(payload.title || fileNameFromPath(payload.track || '') || '');
  }

  function connectHelper() {
    if (helperSocket && (helperSocket.readyState === WebSocket.OPEN || helperSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(reconnectTimer);
    logMessage('component connecting ' + (globalSettings.endpoint || DEFAULT_ENDPOINT));
    helperSocket = new WebSocket(globalSettings.endpoint || DEFAULT_ENDPOINT);

    helperSocket.onopen = function () {
      lastState.connected = true;
      reconnectDelay = 2000;
      logMessage('component connected');
      refreshTitles();
      sendCommand('now_playing');
    };

    helperSocket.onmessage = function (event) {
      var message = parseJson(event.data, {});
      if (message.event === 'state' || message.type === 'state') {
        lastState = Object.assign({}, lastState, message.payload || message.state || {}, { connected: true, hasState: true });
        if (lastState.rating !== undefined) {
          pendingRating = null;
        }
        var summary = nowPlayingSummary();
        if (summary !== lastStateSummary) {
          lastStateSummary = summary;
          logMessage('state: ' + summary);
        }
        refreshTitles();
      }
      if (message.event === 'diagnostics' || message.type === 'diagnostics') {
        lastDiagnostics = Object.assign({}, message.payload || {}, { receivedAt: new Date().toISOString() });
        logMessage(diagnosticsSummary(lastDiagnostics));
        refreshTitles();
      }
      if (message.event === 'error' || message.type === 'error') {
        lastState = Object.assign({}, lastState, { connected: true, error: message.message || 'error' });
        logMessage(lastState.error);
        refreshTitles();
      }
    };

    helperSocket.onclose = function () {
      lastState.connected = false;
      logMessage('component connection closed');
      refreshTitles();
      clearTimeout(reconnectTimer);
      var delay = reconnectDelay;
      reconnectDelay = Math.min(30000, reconnectDelay * 2);
      reconnectTimer = setTimeout(connectHelper, delay);
    };

    helperSocket.onerror = function () {
      lastState.connected = false;
      logMessage('component connection error');
      refreshTitles();
    };
  }

  function handleKeyDown(message) {
    var context = message.context;
    var action = message.action || (contexts[context] && contexts[context].action);
    if (action === 'local.streamdock.foobar2000.playpause') {
      startPlayPausePress(context, action);
      return;
    }
    if (action === 'local.streamdock.foobar2000.next' && playlistPlaybackScoped) {
      if (!sendActionCommand(context, action, 'playlist_next_track')) showAlert(context);
      return;
    }
    if (action === 'local.streamdock.foobar2000.previous' && playlistPlaybackScoped) {
      if (!sendActionCommand(context, action, 'playlist_previous_track')) showAlert(context);
      return;
    }
    var command = ACTION_COMMANDS[action];
    if (command) {
      if (!sendActionCommand(context, action, command)) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.volume') {
      if (!sendActionCommand(context, action, 'mute')) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.playlist') {
      if (globalSettings.playlistDialMode === 'track') {
        command = trackCommand(globalSettings.trackAction);
        playlistPlaybackScoped = true;
        if (!sendActionCommand(context, action, command)) {
          showAlert(context);
        }
        return;
      }
      if (!globalSettings.searchQuery && !globalSettings.playlistName) {
        command = (globalSettings.invertKnob === true || globalSettings.invertKnob === 'true') ? 'playlist_previous' : 'playlist_next';
        playlistPlaybackScoped = true;
        if (!sendActionCommand(context, action, command)) {
          showAlert(context);
        }
        return;
      }
      command = globalSettings.searchQuery ? 'playlist_search' : 'playlist_select';
      playlistPlaybackScoped = true;
      if (!sendActionCommand(context, action, command, { name: globalSettings.playlistName, query: globalSettings.searchQuery })) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.rating') {
      var current = Math.max(0, Math.min(5, Number(pendingRating !== null ? pendingRating : (lastState.rating || 0))));
      var inverted = globalSettings.invertKnob === true || globalSettings.invertKnob === 'true';
      var ratingVal = inverted ? (current <= 1 ? 5 : current - 1) : (current >= 5 ? 1 : current + 1);
      pendingRating = ratingVal;
      globalSettings.rating = ratingVal;
      if (!sendActionCommand(context, action, 'rating_set', { value: ratingVal })) {
        pendingRating = null;
        showAlert(context);
      } else {
        refreshTitles();
      }
    } else if (action === 'local.streamdock.foobar2000.diagnostics') {
      if (!sendActionCommand(context, action, 'diagnostics')) {
        lastDiagnostics = { ok: false, error: 'component offline' };
        logMessage('diagnostics failed: component offline');
        setTitle(context, diagnosticsTitle());
        showAlert(context);
      }
    }
  }

  function handleKeyUp(message) {
    var context = message.context;
    var action = message.action || (contexts[context] && contexts[context].action);
    if (action !== 'local.streamdock.foobar2000.playpause') {
      return;
    }
    finishPlayPausePress(context, action);
  }

  function startPlayPausePress(context, action) {
    clearPlayPausePress(context);
    var threshold = playPauseLongPressMs();
    keyPressStates[context] = {
      consumed: false,
      timer: setTimeout(function () {
        if (!keyPressStates[context]) {
          return;
        }
        keyPressStates[context].consumed = true;
        if (!sendActionCommand(context, action, 'stop')) {
          showAlert(context);
        }
      }, threshold)
    };
  }

  function finishPlayPausePress(context, action) {
    var state = keyPressStates[context];
    if (!state) {
      return;
    }
    clearTimeout(state.timer);
    delete keyPressStates[context];
    var command = playlistPlaybackScoped ? 'playlist_play_pause' : 'play_pause';
    if (!state.consumed && !sendActionCommand(context, action, command)) {
      showAlert(context);
    }
  }

  function clearPlayPausePress(context) {
    if (keyPressStates[context] && keyPressStates[context].timer) {
      clearTimeout(keyPressStates[context].timer);
    }
    delete keyPressStates[context];
  }

  function playPauseLongPressMs() {
    var value = Number(globalSettings.playPauseLongPressMs);
    if (!Number.isFinite(value) || value <= 0) value = 800;
    return Math.max(300, Math.min(3000, Math.round(value)));
  }

  function handleDialDown(message) {
    var context = message.context;
    var action = message.action || (contexts[context] && contexts[context].action);
    if (action === 'local.streamdock.foobar2000.volume') {
      if (!sendActionCommand(context, action, 'mute')) {
        showAlert(context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.trackknob') {
      if (!sendActionCommand(context, action, 'play_pause')) {
        showAlert(context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.playlist') {
      var command = globalSettings.playlistDialMode === 'track' ? trackCommand(globalSettings.trackAction) : 'playlist_play_active';
      playlistPlaybackScoped = true;
      if (!sendActionCommand(context, action, command)) {
        showAlert(context);
      }
    }
  }

  function trackCommand(action) {
    if (action === 'queue') return 'playlist_queue_selected';
    if (action === 'next') return 'playlist_play_next_selected';
    if (action === 'append') return 'playlist_append_selected';
    return 'playlist_play_selected';
  }

  function handleDialRotate(message) {
    var ticks = Number(message.payload && (message.payload.ticks || message.payload.delta || message.payload.rotation)) || 0;
    if (globalSettings.invertKnob === true || globalSettings.invertKnob === 'true') {
      ticks = -ticks;
    }
    if (ticks === 0) {
      return;
    }
    var action = message.action || (contexts[message.context] && contexts[message.context].action);
    if (action === 'local.streamdock.foobar2000.seek') {
      var seekStep = Number(globalSettings.seekStepSeconds) || 5;
      if (!sendActionCommand(message.context, action, 'seek_delta', { seconds: ticks * seekStep })) {
        showAlert(message.context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.playlist') {
      if (globalSettings.playlistDialMode === 'track') {
        playlistPlaybackScoped = true;
        if (!sendActionCommand(message.context, action, 'playlist_browse_delta', { delta: ticks })) {
          showAlert(message.context);
        }
        return;
      }
      var playlistCommand = ticks > 0 ? 'playlist_next' : 'playlist_previous';
      playlistPlaybackScoped = true;
      if (!sendActionCommand(message.context, action, playlistCommand)) {
        showAlert(message.context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.rating') {
      var currentRating = pendingRating !== null ? pendingRating : (Number(lastState.rating) || Number(globalSettings.rating) || 5);
      var nextRating = Math.max(1, Math.min(5, currentRating + ticks));
      pendingRating = nextRating;
      globalSettings.rating = nextRating;
      if (!sendActionCommand(message.context, action, 'rating_set', { value: nextRating })) {
        pendingRating = null;
        showAlert(message.context);
      } else {
        refreshTitles();
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.trackknob') {
      handleTrackKnobRotate(message.context, ticks);
      return;
    }
    var step = Number(globalSettings.volumeStep) || 2;
    if (typeof lastState.volume === 'number') {
      var nextVolume = clampVolume(Number(lastState.volume) + (ticks > 0 ? 1 : -1) * Math.abs(ticks) * step);
      if (!sendActionCommand(message.context, action, 'set_volume_percent', { value: Math.round(nextVolume) })) {
        showAlert(message.context);
      }
      return;
    }
    var volumeCommand = ticks > 0 ? 'volume_up' : 'volume_down';
    if (!sendActionCommand(message.context, action, volumeCommand, { amount: Math.abs(ticks) * step })) {
      showAlert(message.context);
    }
  }

  function handleTrackKnobRotate(context, ticks) {
    var threshold = Math.max(1, Math.round(Number(globalSettings.trackKnobTicks) || 8));
    var accumulated = (dialTickAccumulators[context] || 0) + ticks;
    while (accumulated >= threshold) {
      if (!sendActionCommand(context, 'local.streamdock.foobar2000.trackknob', 'next')) {
        showAlert(context);
        break;
      }
      accumulated -= threshold;
    }
    while (accumulated <= -threshold) {
      if (!sendActionCommand(context, 'local.streamdock.foobar2000.trackknob', 'previous')) {
        showAlert(context);
        break;
      }
      accumulated += threshold;
    }
    dialTickAccumulators[context] = accumulated;
  }

  function clampVolume(value) {
    var min = Number(globalSettings.minVolume);
    var max = Number(globalSettings.maxVolume);
    if (!Number.isFinite(min)) min = 0;
    if (!Number.isFinite(max)) max = 100;
    if (max < min) {
      var tmp = max;
      max = min;
      min = tmp;
    }
    return Math.max(min, Math.min(max, Number(value) || 0));
  }

  function actionFromMessage(message) {
    return message.action ||
      message.payload && message.payload.action ||
      message.payload && message.payload.settings && message.payload.settings.action ||
      message.actionInfo && message.actionInfo.action ||
      '';
  }

  function rememberContext(message) {
    if (!message.context) {
      return;
    }
    contexts[message.context] = {
      action: actionFromMessage(message),
      title: message.payload && message.payload.title
    };
    refreshContext(message.context);
  }

  function forgetContext(message) {
    if (message.context) {
      clearPlayPausePress(message.context);
      delete contexts[message.context];
      delete dialTickAccumulators[message.context];
    }
  }

  function handleMessage(event) {
    var message = parseJson(event.data, {});
    if (message.event === 'willAppear') {
      rememberContext(message);
    } else if (message.event === 'willDisappear') {
      forgetContext(message);
    } else if (message.event === 'keyDown') {
      handleKeyDown(message);
    } else if (message.event === 'keyUp') {
      handleKeyUp(message);
    } else if (message.event === 'dialDown' || message.event === 'dialPress' || message.event === 'touchTap') {
      handleDialDown(message);
    } else if (message.event === 'dialRotate') {
      handleDialRotate(message);
    } else if (message.event === 'didReceiveGlobalSettings') {
      globalSettings = Object.assign({}, globalSettings, message.payload && message.payload.settings || {});
      artCache = {};
      artPending = {};
      composedArtCache = {};
      composedArtPending = {};
      spotifyToken = null;
      spotifyTokenExpiresAt = 0;
      refreshTitles();
      connectHelper();
    }
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
    pluginUuid = uuid;
    streamDockSocket = new WebSocket('ws://127.0.0.1:' + port);
    streamDockSocket.onopen = function () {
      sendToStreamDock({ event: registerEvent, uuid: pluginUuid });
      sendToStreamDock({ event: 'getGlobalSettings', context: pluginUuid });
      connectHelper();
    };
    streamDockSocket.onmessage = handleMessage;
  };
}());
