(function () {
  'use strict';

  var DEFAULT_ENDPOINT = 'ws://127.0.0.1:41920';
  var ACTION_COMMANDS = {
    'local.streamdock.foobar2000.playpause': 'play_pause',
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
  var globalSettings = { endpoint: DEFAULT_ENDPOINT, volumeStep: 2, seekStepSeconds: 5, playlistName: '', playlistDialMode: 'playlist', trackAction: 'play', rating: 5, showProgress: true, nowPlayingTemplate: '', searchQuery: '', albumArtUrlTemplate: '', generatedImages: true, invertKnob: false, minVolume: 0, maxVolume: 100 };
  var contexts = {};
  var lastState = { connected: false };

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
      payload: { title: String(title || '') }
    });
  }

  function setImage(context, image) {
    if (context && image) {
      sendToStreamDock({ event: 'setImage', context: context, payload: { image: image } });
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
      return 'fb2k\noffline';
    }
    if (action === 'local.streamdock.foobar2000.diagnostics') {
      return 'fb2k\nok';
    }
    if (action === 'local.streamdock.foobar2000.playbackorder') {
      return 'Order\n' + (lastState.playbackOrder || 'cycle');
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
      return formatNowPlaying(context);
    }
    if (action === 'local.streamdock.foobar2000.volume') {
      return formatVolume();
    }
    if (action === 'local.streamdock.foobar2000.mute') {
      return lastState.muted ? 'Muted' : 'Mute';
    }
    if (action === 'local.streamdock.foobar2000.playpause') {
      return lastState.playing ? 'Pause' : 'Play';
    }
    return contexts[context].title || '';
  }

  function formatNowPlaying() {
    var artist = lastState.artist || '';
    var title = lastState.title || lastState.track || '';
    if (globalSettings.nowPlayingTemplate) {
      return truncateTitle(String(globalSettings.nowPlayingTemplate).replace(/\{(artist|title|track|position|length|volume|playlist)\}/g, function (_, key) {
        return {
          artist: artist,
          title: title,
          track: lastState.track || '',
          position: formatTime(lastState.positionSeconds),
          length: formatTime(lastState.lengthSeconds),
          volume: Math.round(Number(lastState.volume) || 0) + '%',
          playlist: lastState.playlist || ''
        }[key] || '';
      }));
    }
    if (!artist && !title) {
      return lastState.playing ? 'Playing' : 'Stopped';
    }
    var line = artist ? artist + '\n' + title : title;
    if (globalSettings.showProgress && typeof lastState.positionSeconds === 'number' && typeof lastState.lengthSeconds === 'number' && lastState.lengthSeconds > 0) {
      line += '\n' + formatTime(lastState.positionSeconds) + '/' + formatTime(lastState.lengthSeconds);
    }
    return line;
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

  function nowPlayingImage() {
    if (lastState.image) {
      return lastState.image;
    }
    if (globalSettings.albumArtUrlTemplate) {
      return globalSettings.albumArtUrlTemplate
        .replace(/\{artist\}/g, encodeURIComponent(lastState.artist || ''))
        .replace(/\{title\}/g, encodeURIComponent(lastState.title || lastState.track || ''));
    }
    var fill = Number(lastState.lengthSeconds) > 0 ? Number(lastState.positionSeconds) / Number(lastState.lengthSeconds) * 100 : 0;
    return svgImage(lastState.playing ? '#22543d' : '#3a3a3a', '#ffffff', lastState.playing ? 'PLAY' : 'STOP', lastState.artist || 'fb2k', fill);
  }

  function actionImage(context) {
    var action = contexts[context] && contexts[context].action;
    if (!lastState.connected) {
      return svgImage('#363b44', '#aeb7c2', 'fb2k', 'OFF');
    }
    if (action === 'local.streamdock.foobar2000.mute') {
      return svgImage(lastState.muted ? '#742a2a' : '#2d3748', '#ffffff', lastState.muted ? 'MUTE' : 'AUD', '');
    }
    if (action === 'local.streamdock.foobar2000.volume') {
      return svgImage('#234e52', '#ffffff', String(Math.round(lastState.volume || 0)), 'VOL');
    }
    return svgImage(lastState.playing ? '#22543d' : '#3a3a3a', '#ffffff', lastState.playing ? 'PLAY' : 'fb2k', '');
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

  function truncateImageText(value) {
    value = String(value || '');
    return value.length > 12 ? value.slice(0, 12) : value;
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

  function connectHelper() {
    if (helperSocket && (helperSocket.readyState === WebSocket.OPEN || helperSocket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(reconnectTimer);
    helperSocket = new WebSocket(globalSettings.endpoint || DEFAULT_ENDPOINT);

    helperSocket.onopen = function () {
      lastState.connected = true;
      reconnectDelay = 2000;
      refreshTitles();
      sendCommand('now_playing');
    };

    helperSocket.onmessage = function (event) {
      var message = parseJson(event.data, {});
      if (message.event === 'state' || message.type === 'state') {
        lastState = Object.assign({}, lastState, message.payload || message.state || {}, { connected: true });
        if (lastState.rating !== undefined) {
          pendingRating = null;
        }
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
    var command = ACTION_COMMANDS[action];
    if (command) {
      if (!sendCommand(command)) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.playlist') {
      if (globalSettings.playlistDialMode === 'track') {
        if (!sendCommand(trackCommand(globalSettings.trackAction))) {
          showAlert(context);
        }
        return;
      }
      command = globalSettings.searchQuery ? 'playlist_search' : 'playlist_select';
      if (!sendCommand(command, { name: globalSettings.playlistName, query: globalSettings.searchQuery })) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.rating') {
      var ratingVal = Math.max(1, Math.min(5, Number(pendingRating !== null ? pendingRating : (globalSettings.rating || 5))));
      pendingRating = ratingVal;
      if (!sendCommand('rating_set', { value: ratingVal })) {
        pendingRating = null;
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.diagnostics') {
      setTitle(context, lastState.connected ? 'fb2k\nconnected' : 'fb2k\noffline');
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
      if (!sendCommand('seek_delta', { seconds: ticks * seekStep })) {
        showAlert(message.context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.playlist') {
      if (globalSettings.playlistDialMode === 'track') {
        if (!sendCommand('playlist_browse_delta', { delta: ticks })) {
          showAlert(message.context);
        }
        return;
      }
      if (!sendCommand(ticks > 0 ? 'playlist_next' : 'playlist_previous')) {
        showAlert(message.context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.rating') {
      var currentRating = pendingRating !== null ? pendingRating : (Number(lastState.rating) || Number(globalSettings.rating) || 5);
      var nextRating = Math.max(1, Math.min(5, currentRating + ticks));
      pendingRating = nextRating;
      globalSettings.rating = nextRating;
      if (!sendCommand('rating_set', { value: nextRating })) {
        pendingRating = null;
        showAlert(message.context);
      } else {
        refreshTitles();
      }
      return;
    }
    var step = Number(globalSettings.volumeStep) || 2;
    if (typeof lastState.volume === 'number') {
      var nextVolume = clampVolume(Number(lastState.volume) + (ticks > 0 ? 1 : -1) * Math.abs(ticks) * step);
      if (!sendCommand('set_volume_percent', { value: Math.round(nextVolume) })) {
        showAlert(message.context);
      }
      return;
    }
    if (!sendCommand(ticks > 0 ? 'volume_up' : 'volume_down', { amount: Math.abs(ticks) * step })) {
      showAlert(message.context);
    }
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

  function rememberContext(message) {
    if (!message.context) {
      return;
    }
    contexts[message.context] = {
      action: message.action,
      title: message.payload && message.payload.title
    };
    setTitle(message.context, titleForContext(message.context));
  }

  function forgetContext(message) {
    if (message.context) {
      delete contexts[message.context];
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
    } else if (message.event === 'dialRotate') {
      handleDialRotate(message);
    } else if (message.event === 'didReceiveGlobalSettings') {
      globalSettings = Object.assign({}, globalSettings, message.payload && message.payload.settings || {});
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
