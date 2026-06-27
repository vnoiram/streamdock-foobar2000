(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var settings = { endpoint: 'ws://127.0.0.1:41920', volumeStep: 2, seekStepSeconds: 5, playlistName: '', playlistDialMode: 'playlist', rating: 5, showProgress: true, nowPlayingTemplate: '', searchQuery: '', albumArtUrlTemplate: '', generatedImages: true, invertKnob: false, minVolume: 0, maxVolume: 100 };
  var SETTING_KEYS = ['endpoint', 'volumeStep', 'seekStepSeconds', 'playlistName', 'playlistDialMode', 'rating', 'showProgress', 'nowPlayingTemplate', 'searchQuery', 'albumArtUrlTemplate', 'generatedImages', 'invertKnob', 'minVolume', 'maxVolume'];

  function setStatus(text) {
    document.getElementById('status').textContent = text;
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
    settings.playlistName = document.getElementById('playlistName').value.trim();
    settings.playlistDialMode = document.getElementById('playlistDialMode').value;
    settings.rating = Number(document.getElementById('rating').value) || 5;
    settings.showProgress = document.getElementById('showProgress').checked;
    settings.nowPlayingTemplate = document.getElementById('nowPlayingTemplate').value;
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
    var blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
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
      applySettings(JSON.parse(text));
      sendSettings();
    });
  }

  function copySettings() {
    sendSettings();
    navigator.clipboard.writeText(JSON.stringify(settings, null, 2)).then(function () {
      setStatus('settings copied');
    }).catch(function () {
      setStatus('copy failed');
    });
  }

  function pasteSettings() {
    navigator.clipboard.readText().then(function (text) {
      applySettings(JSON.parse(text));
      sendSettings();
      setStatus('settings pasted');
    }).catch(function () {
      setStatus('paste failed');
    });
  }

  function previewSearch() {
    sendSettings();
    var mode = settings.playlistDialMode === 'track' ? 'track browse' : 'playlist switch';
    var target = settings.searchQuery || settings.playlistName || 'active playlist';
    setStatus(mode + ': ' + target);
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
        socket.send(JSON.stringify({ command: 'now_playing' }));
      };
      socket.onmessage = function () {
        clearTimeout(timer);
        setStatus('component ok');
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

  function resetSettings() {
    applySettings({ endpoint: 'ws://127.0.0.1:41920', volumeStep: 2, seekStepSeconds: 5, playlistName: '', playlistDialMode: 'playlist', rating: 5, showProgress: true, nowPlayingTemplate: '', searchQuery: '', albumArtUrlTemplate: '', generatedImages: true, invertKnob: false, minVolume: 0, maxVolume: 100 });
    sendSettings();
    setStatus('settings reset');
  }

  function applySettings(next) {
    settings = mergeKnownSettings(mergeKnownSettings({}, settings), next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('volumeStep').value = settings.volumeStep;
    document.getElementById('minVolume').value = settings.minVolume;
    document.getElementById('maxVolume').value = settings.maxVolume;
    document.getElementById('invertKnob').checked = settings.invertKnob === true || settings.invertKnob === 'true';
    document.getElementById('seekStepSeconds').value = settings.seekStepSeconds;
    document.getElementById('playlistName').value = settings.playlistName;
    document.getElementById('playlistDialMode').value = settings.playlistDialMode || 'playlist';
    document.getElementById('rating').value = settings.rating;
    document.getElementById('showProgress').checked = settings.showProgress !== false && settings.showProgress !== 'false';
    document.getElementById('nowPlayingTemplate').value = settings.nowPlayingTemplate || '';
    document.getElementById('searchQuery').value = settings.searchQuery || '';
    document.getElementById('albumArtUrlTemplate').value = settings.albumArtUrlTemplate || '';
    document.getElementById('generatedImages').checked = settings.generatedImages !== false && settings.generatedImages !== 'false';
    renderEndpointStatus();
  }

  function mergeKnownSettings(target, source) {
    SETTING_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
      }
    });
    return target;
  }

  window.connectElgatoStreamDeckSocket = function (port, uuid, registerEvent, info, actionInfo) {
    context = uuid;
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
    document.getElementById('playlistName').addEventListener('input', sendSettings);
    document.getElementById('playlistDialMode').addEventListener('change', sendSettings);
    document.getElementById('rating').addEventListener('input', sendSettings);
    document.getElementById('showProgress').addEventListener('change', sendSettings);
    document.getElementById('nowPlayingTemplate').addEventListener('input', sendSettings);
    document.getElementById('searchQuery').addEventListener('input', sendSettings);
    document.getElementById('albumArtUrlTemplate').addEventListener('input', sendSettings);
    document.getElementById('generatedImages').addEventListener('change', sendSettings);
    document.getElementById('copySettings').addEventListener('click', copySettings);
    document.getElementById('previewSearch').addEventListener('click', previewSearch);
    document.getElementById('diagnoseSettings').addEventListener('click', diagnoseSettings);
    document.getElementById('resetSettings').addEventListener('click', resetSettings);
    document.getElementById('pasteSettings').addEventListener('click', pasteSettings);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
    renderEndpointStatus();
  });
}());
