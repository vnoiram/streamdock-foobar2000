(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var settings = { endpoint: 'ws://127.0.0.1:41920', volumeStep: 2, seekStepSeconds: 5, playlistName: '', playlistDialMode: 'playlist', rating: 5, showProgress: true, searchQuery: '', albumArtUrlTemplate: '', generatedImages: true };

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function sendSettings() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    settings.endpoint = document.getElementById('endpoint').value.trim();
    settings.volumeStep = Number(document.getElementById('volumeStep').value) || 2;
    settings.seekStepSeconds = Number(document.getElementById('seekStepSeconds').value) || 5;
    settings.playlistName = document.getElementById('playlistName').value.trim();
    settings.playlistDialMode = document.getElementById('playlistDialMode').value;
    settings.rating = Number(document.getElementById('rating').value) || 5;
    settings.showProgress = document.getElementById('showProgress').checked;
    settings.searchQuery = document.getElementById('searchQuery').value.trim();
    settings.albumArtUrlTemplate = document.getElementById('albumArtUrlTemplate').value.trim();
    settings.generatedImages = document.getElementById('generatedImages').checked;
    websocket.send(JSON.stringify({
      event: 'setGlobalSettings',
      context: context,
      payload: settings
    }));
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

  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('volumeStep').value = settings.volumeStep;
    document.getElementById('seekStepSeconds').value = settings.seekStepSeconds;
    document.getElementById('playlistName').value = settings.playlistName;
    document.getElementById('playlistDialMode').value = settings.playlistDialMode || 'playlist';
    document.getElementById('rating').value = settings.rating;
    document.getElementById('showProgress').checked = settings.showProgress !== false && settings.showProgress !== 'false';
    document.getElementById('searchQuery').value = settings.searchQuery || '';
    document.getElementById('albumArtUrlTemplate').value = settings.albumArtUrlTemplate || '';
    document.getElementById('generatedImages').checked = settings.generatedImages !== false && settings.generatedImages !== 'false';
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
    document.getElementById('seekStepSeconds').addEventListener('input', sendSettings);
    document.getElementById('playlistName').addEventListener('input', sendSettings);
    document.getElementById('playlistDialMode').addEventListener('change', sendSettings);
    document.getElementById('rating').addEventListener('input', sendSettings);
    document.getElementById('showProgress').addEventListener('change', sendSettings);
    document.getElementById('searchQuery').addEventListener('input', sendSettings);
    document.getElementById('albumArtUrlTemplate').addEventListener('input', sendSettings);
    document.getElementById('generatedImages').addEventListener('change', sendSettings);
    document.getElementById('copySettings').addEventListener('click', copySettings);
    document.getElementById('pasteSettings').addEventListener('click', pasteSettings);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
  });
}());
