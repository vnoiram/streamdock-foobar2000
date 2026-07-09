(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var currentAction = '';
  var settings = { endpoint: 'ws://127.0.0.1:41920', volumeStep: 2, seekStepSeconds: 5, trackKnobTicks: 8, playlistName: '', playlistDialMode: 'playlist', trackAction: 'play', playPauseLongPressMs: 800, rating: 5, showProgress: true, nowPlayingTemplate: '', nowPlayingTextAlign: 'auto', nowPlayingMaxChars: 16, albumArtProvider: 'original', albumArtUrlTemplate: '', spotifyClientId: '', spotifyClientSecret: '', lastfmApiKey: '', searchQuery: '', generatedImages: true, invertKnob: false, minVolume: 0, maxVolume: 100 };
  var SETTING_KEYS = ['endpoint', 'volumeStep', 'seekStepSeconds', 'trackKnobTicks', 'playlistName', 'playlistDialMode', 'trackAction', 'playPauseLongPressMs', 'rating', 'showProgress', 'nowPlayingTemplate', 'nowPlayingTextAlign', 'nowPlayingMaxChars', 'albumArtProvider', 'albumArtUrlTemplate', 'spotifyClientId', 'spotifyClientSecret', 'lastfmApiKey', 'searchQuery', 'generatedImages', 'invertKnob', 'minVolume', 'maxVolume'];
  var PLUGIN_SETTING_FIELDS = ['exportSettings', 'importSettingsButton'];
  var DIAGNOSTIC_FIELDS = ['endpoint', 'diagnoseSettings', 'copyDiagnostics'];
  var ACTION_FIELDS = {
    'local.streamdock.foobar2000.playpause': ['playPauseLongPressMs'],
    'local.streamdock.foobar2000.stop': [],
    'local.streamdock.foobar2000.previous': [],
    'local.streamdock.foobar2000.next': [],
    'local.streamdock.foobar2000.mute': [],
    'local.streamdock.foobar2000.playbackorder': [],
    'local.streamdock.foobar2000.volume': ['volumeStep', 'minVolume', 'maxVolume', 'invertKnob'],
    'local.streamdock.foobar2000.trackknob': ['trackKnobTicks', 'invertKnob'],
    'local.streamdock.foobar2000.seek': ['seekStepSeconds', 'invertKnob'],
    'local.streamdock.foobar2000.playlist': ['playlistName', 'playlistDialMode', 'trackAction', 'searchQuery', 'invertKnob'],
    'local.streamdock.foobar2000.rating': ['invertKnob'],
    'local.streamdock.foobar2000.nowplaying': ['showProgress', 'nowPlayingTemplate', 'nowPlayingTextAlign', 'nowPlayingMaxChars', 'albumArtProvider', 'albumArtUrlTemplate', 'spotifyClientId', 'spotifyClientSecret', 'lastfmApiKey'],
    'local.streamdock.foobar2000.diagnostics': DIAGNOSTIC_FIELDS
  };

  function setStatus(text) {
    document.getElementById('status').textContent = text;
    appendDiagnostics(text);
  }

  function sendSettings() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    settings.endpoint = document.getElementById('endpoint').value.trim();
    settings.volumeStep = Number(document.getElementById('volumeStep').value) || 2;
    settings.minVolume = Number(document.getElementById('minVolume').value) || 0;
    settings.maxVolume = Number(document.getElementById('maxVolume').value) || 100;
    settings.invertKnob = document.getElementById('invertKnob').checked;
    settings.seekStepSeconds = Number(document.getElementById('seekStepSeconds').value) || 5;
    settings.trackKnobTicks = Number(document.getElementById('trackKnobTicks').value) || 8;
    settings.playlistName = document.getElementById('playlistName').value.trim();
    settings.playlistDialMode = document.getElementById('playlistDialMode').value;
    settings.trackAction = document.getElementById('trackAction').value;
    settings.playPauseLongPressMs = Number(document.getElementById('playPauseLongPressMs').value) || 800;
    settings.rating = Number(document.getElementById('rating').value) || 5;
    settings.showProgress = document.getElementById('showProgress').checked;
    settings.nowPlayingTemplate = document.getElementById('nowPlayingTemplate').value;
    settings.nowPlayingTextAlign = document.getElementById('nowPlayingTextAlign').value || 'center';
    settings.nowPlayingMaxChars = Number(document.getElementById('nowPlayingMaxChars').value) || 16;
    settings.albumArtProvider = document.getElementById('albumArtProvider').value || 'original';
    settings.spotifyClientId = document.getElementById('spotifyClientId').value.trim();
    settings.spotifyClientSecret = document.getElementById('spotifyClientSecret').value.trim();
    settings.lastfmApiKey = document.getElementById('lastfmApiKey').value.trim();
    settings.searchQuery = document.getElementById('searchQuery').value.trim();
    settings.albumArtUrlTemplate = document.getElementById('albumArtUrlTemplate').value.trim();
    settings.generatedImages = document.getElementById('generatedImages').checked;
    websocket.send(JSON.stringify({
      event: 'setGlobalSettings',
      context: context,
      payload: settings
    }));
    renderEndpointStatus();
  }

  function renderEndpointStatus() {
    var status = document.getElementById('endpointStatus');
    if (!status) return;
    var endpoint = document.getElementById('endpoint').value.trim();
    if (!endpoint) {
      status.textContent = 'missing component endpoint';
      return;
    }
    if (!/^wss?:\/\//i.test(endpoint)) {
      status.textContent = 'invalid WebSocket endpoint';
      return;
    }
    status.textContent = isLoopbackEndpoint(endpoint) ? 'localhost component' : 'remote component: control leaves this PC';
  }

  function isLoopbackEndpoint(endpoint) {
    try {
      var url = new URL(endpoint);
      return ['localhost', '127.0.0.1', '::1', '[::1]'].indexOf(url.hostname) !== -1;
    } catch (error) {
      return false;
    }
  }

  function exportSettings() {
    sendSettings();
    var blob = new Blob([JSON.stringify(backupPayload(), null, 2)], { type: 'application/json' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'streamdock-foobar2000-settings.json';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function importSettings(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      applySettings(settingsFromImport(JSON.parse(text)));
      sendSettings();
    });
  }

  function diagnoseSettings() {
    sendSettings();
    var issues = [];
    if (!settings.endpoint) issues.push('missing endpoint');
    if (!/^wss?:\/\//i.test(settings.endpoint)) issues.push('invalid endpoint');
    if (!isLoopbackEndpoint(settings.endpoint)) issues.push('remote component');
    if (Number(settings.maxVolume) < Number(settings.minVolume)) issues.push('volume range reversed');
    if (issues.length) {
      setStatus(issues.join(', '));
      return;
    }
    var socket;
    var timer;
    try {
      socket = new WebSocket(settings.endpoint);
      timer = setTimeout(function () {
        setStatus('component timeout');
        socket.close();
      }, 2500);
      socket.onopen = function () {
        socket.send(JSON.stringify({ command: 'diagnostics' }));
      };
      socket.onmessage = function (event) {
        clearTimeout(timer);
        var message = JSON.parse(event.data || '{}');
        var payload = message.payload || {};
        setStatus(payload.ok ? 'component ok: ' + (payload.playbackOrder || 'ready') : 'component error');
        socket.close();
      };
      socket.onerror = function () {
        clearTimeout(timer);
        setStatus('component offline');
      };
    } catch (error) {
      clearTimeout(timer);
      setStatus('component offline');
    }
  }

  function applySettings(next) {
    settings = mergeKnownSettings(mergeKnownSettings({}, settings), next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('volumeStep').value = settings.volumeStep;
    document.getElementById('minVolume').value = settings.minVolume;
    document.getElementById('maxVolume').value = settings.maxVolume;
    document.getElementById('invertKnob').checked = settings.invertKnob === true || settings.invertKnob === 'true';
    document.getElementById('seekStepSeconds').value = settings.seekStepSeconds;
    document.getElementById('trackKnobTicks').value = settings.trackKnobTicks;
    document.getElementById('playlistName').value = settings.playlistName;
    document.getElementById('playlistDialMode').value = settings.playlistDialMode || 'playlist';
    document.getElementById('trackAction').value = settings.trackAction || 'play';
    document.getElementById('playPauseLongPressMs').value = settings.playPauseLongPressMs || 800;
    document.getElementById('rating').value = settings.rating;
    document.getElementById('showProgress').checked = settings.showProgress !== false && settings.showProgress !== 'false';
    document.getElementById('nowPlayingTemplate').value = settings.nowPlayingTemplate || '';
    document.getElementById('nowPlayingTextAlign').value = settings.nowPlayingTextAlign || 'auto';
    document.getElementById('nowPlayingMaxChars').value = settings.nowPlayingMaxChars || 16;
    document.getElementById('albumArtProvider').value = settings.albumArtProvider || 'original';
    document.getElementById('searchQuery').value = settings.searchQuery || '';
    document.getElementById('albumArtUrlTemplate').value = settings.albumArtUrlTemplate || '';
    document.getElementById('spotifyClientId').value = settings.spotifyClientId || '';
    document.getElementById('spotifyClientSecret').value = settings.spotifyClientSecret || '';
    document.getElementById('lastfmApiKey').value = settings.lastfmApiKey || '';
    document.getElementById('generatedImages').checked = settings.generatedImages !== false && settings.generatedImages !== 'false';
    renderEndpointStatus();
    renderArtProviderFields();
  }

  function mergeKnownSettings(target, source) {
    SETTING_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
      }
    });
    return target;
  }

  function backupPayload() {
    return {
      type: 'streamdock-plugin-backup',
      plugin: 'streamdock-foobar2000',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: settings
    };
  }

  function settingsFromImport(imported) {
    if (imported && imported.type === 'streamdock-plugin-backup') {
      return imported.settings || {};
    }
    return imported || {};
  }

  function diagnosticsKey() {
    return 'streamdock-foobar2000:diagnostics';
  }

  function diagnosticsLog() {
    try {
      return JSON.parse(localStorage.getItem(diagnosticsKey()) || '[]');
    } catch (error) {
      return [];
    }
  }

  function appendDiagnostics(text) {
    try {
      var items = diagnosticsLog();
      items.unshift({ time: new Date().toISOString(), message: String(text || '') });
      localStorage.setItem(diagnosticsKey(), JSON.stringify(items.slice(0, 50)));
    } catch (error) {
      // localStorage can be disabled in some plugin runtimes.
    }
  }

  function copyDiagnostics() {
    navigator.clipboard.writeText(JSON.stringify(diagnosticsLog(), null, 2)).then(function () {
      setStatus('diagnostics copied');
    }).catch(function () {
      setStatus('diagnostics copy failed');
    });
  }

  function rowFor(id) {
    var element = document.getElementById(id);
    while (element && element !== document.body) {
      if (element.classList && element.classList.contains('sdpi-item')) return element;
      element = element.parentNode;
    }
    return null;
  }

  function setFieldVisible(id, visible) {
    var element = document.getElementById(id);
    var row = rowFor(id);
    if (row && row.classList && row.classList.contains('plugin-settings')) {
      if (element) element.classList.toggle('is-hidden', !visible);
      var controls = row.querySelectorAll('.sdpi-button');
      var anyVisible = false;
      for (var i = 0; i < controls.length; i++) {
        if (!controls[i].classList.contains('is-hidden')) anyVisible = true;
      }
      row.classList.toggle('is-hidden', !anyVisible);
      return;
    }
    if (row) row.classList.toggle('is-hidden', !visible);
  }

  function applyVisibility() {
    var visible = {};
    var actionFields = ACTION_FIELDS[currentAction];
    if (!currentAction || !actionFields) {
      SETTING_KEYS.concat(['diagnoseSettings', 'exportSettings', 'copyDiagnostics', 'importSettingsButton']).forEach(function (id) {
        setFieldVisible(id, true);
      });
      return;
    }
    (actionFields.length ? PLUGIN_SETTING_FIELDS : []).concat(actionFields).forEach(function (id) {
      visible[id] = true;
    });
    SETTING_KEYS.concat(['diagnoseSettings', 'exportSettings', 'copyDiagnostics', 'importSettingsButton']).forEach(function (id) {
      setFieldVisible(id, !!visible[id]);
    });
    renderArtProviderFields();
  }

  function renderArtProviderFields() {
    var providerElement = document.getElementById('albumArtProvider');
    var provider = providerElement ? providerElement.value : settings.albumArtProvider || 'original';
    var isNowPlaying = currentAction === 'local.streamdock.foobar2000.nowplaying';
    setFieldVisible('albumArtUrlTemplate', isNowPlaying && provider === 'original');
    setFieldVisible('spotifyClientId', isNowPlaying && provider === 'spotify');
    setFieldVisible('spotifyClientSecret', isNowPlaying && provider === 'spotify');
    setFieldVisible('lastfmApiKey', isNowPlaying && provider === 'lastfm');
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
    var parsedActionInfo = JSON.parse(actionInfo || '{}');
    context = uuid;
    currentAction = parsedActionInfo.action || '';
    applyVisibility();
    websocket = new WebSocket('ws://127.0.0.1:' + port);
    websocket.onopen = function () {
      websocket.send(JSON.stringify({ event: registerEvent, uuid: uuid }));
      websocket.send(JSON.stringify({ event: 'getGlobalSettings', context: uuid }));
    };
    websocket.onmessage = function (event) {
      var message = JSON.parse(event.data);
      if (message.event === 'didReceiveGlobalSettings') {
        applySettings(message.payload && message.payload.settings);
      }
    };
  };

  window.addEventListener('DOMContentLoaded', function () {
    document.getElementById('endpoint').addEventListener('input', sendSettings);
    document.getElementById('volumeStep').addEventListener('input', sendSettings);
    document.getElementById('minVolume').addEventListener('input', sendSettings);
    document.getElementById('maxVolume').addEventListener('input', sendSettings);
    document.getElementById('invertKnob').addEventListener('change', sendSettings);
    document.getElementById('seekStepSeconds').addEventListener('input', sendSettings);
    document.getElementById('trackKnobTicks').addEventListener('input', sendSettings);
    document.getElementById('playlistName').addEventListener('input', sendSettings);
    document.getElementById('playlistDialMode').addEventListener('change', sendSettings);
    document.getElementById('trackAction').addEventListener('change', sendSettings);
    document.getElementById('playPauseLongPressMs').addEventListener('input', sendSettings);
    document.getElementById('rating').addEventListener('input', sendSettings);
    document.getElementById('showProgress').addEventListener('change', sendSettings);
    document.getElementById('nowPlayingTemplate').addEventListener('input', sendSettings);
    document.getElementById('nowPlayingTextAlign').addEventListener('change', sendSettings);
    document.getElementById('nowPlayingMaxChars').addEventListener('input', sendSettings);
    document.getElementById('searchQuery').addEventListener('input', sendSettings);
    document.getElementById('albumArtProvider').addEventListener('change', function () {
      sendSettings();
      renderArtProviderFields();
    });
    document.getElementById('albumArtUrlTemplate').addEventListener('input', sendSettings);
    document.getElementById('spotifyClientId').addEventListener('input', sendSettings);
    document.getElementById('spotifyClientSecret').addEventListener('input', sendSettings);
    document.getElementById('lastfmApiKey').addEventListener('input', sendSettings);
    document.getElementById('generatedImages').addEventListener('change', sendSettings);
    document.getElementById('diagnoseSettings').addEventListener('click', diagnoseSettings);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('copyDiagnostics').addEventListener('click', copyDiagnostics);
    document.getElementById('importSettings').addEventListener('change', importSettings);
    renderEndpointStatus();
    applyVisibility();
  });
}());
