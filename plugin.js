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
  var globalSettings = { endpoint: DEFAULT_ENDPOINT, volumeStep: 2, seekStepSeconds: 5, playlistName: '', rating: 5 };
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
      return 'List\n' + (lastState.playlist || globalSettings.playlistName || 'set');
    }
    if (action === 'local.streamdock.foobar2000.rating') {
      return 'Rate\n' + (lastState.rating || globalSettings.rating || 5);
    }
    if (action === 'local.streamdock.foobar2000.nowplaying') {
      return formatNowPlaying();
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
    if (!artist && !title) {
      return lastState.playing ? 'Playing' : 'Stopped';
    }
    return artist ? artist + '\n' + title : title;
  }

  function formatVolume() {
    if (typeof lastState.volume === 'number') {
      return 'Vol\n' + Math.round(lastState.volume) + '%';
    }
    return 'Vol';
  }

  function refreshTitles() {
    Object.keys(contexts).forEach(function (context) {
      setTitle(context, titleForContext(context));
      if (contexts[context].action === 'local.streamdock.foobar2000.nowplaying' && lastState.image) {
        setImage(context, lastState.image);
      }
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
      refreshTitles();
      sendCommand('now_playing');
    };

    helperSocket.onmessage = function (event) {
      var message = parseJson(event.data, {});
      if (message.event === 'state' || message.type === 'state') {
        lastState = Object.assign({}, lastState, message.payload || message.state || {}, { connected: true });
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
      reconnectTimer = setTimeout(connectHelper, 2000);
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
      if (!sendCommand('playlist_select', { name: globalSettings.playlistName })) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.rating') {
      if (!sendCommand('rating_set', { value: Number(globalSettings.rating) || 5 })) {
        showAlert(context);
      }
    } else if (action === 'local.streamdock.foobar2000.diagnostics') {
      setTitle(context, lastState.connected ? 'fb2k\nconnected' : 'fb2k\noffline');
    }
  }

  function handleDialRotate(message) {
    var ticks = Number(message.payload && (message.payload.ticks || message.payload.delta || message.payload.rotation)) || 0;
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
      if (!sendCommand(ticks > 0 ? 'playlist_next' : 'playlist_previous')) {
        showAlert(message.context);
      }
      return;
    }
    if (action === 'local.streamdock.foobar2000.rating') {
      var nextRating = Math.max(1, Math.min(5, (Number(lastState.rating) || Number(globalSettings.rating) || 5) + ticks));
      globalSettings.rating = nextRating;
      if (!sendCommand('rating_set', { value: nextRating })) {
        showAlert(message.context);
      }
      return;
    }
    var step = Number(globalSettings.volumeStep) || 2;
    if (!sendCommand(ticks > 0 ? 'volume_up' : 'volume_down', { amount: Math.abs(ticks) * step })) {
      showAlert(message.context);
    }
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
