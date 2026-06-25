(function () {
  'use strict';

  var websocket = null;
  var context = null;
  var settings = { endpoint: 'ws://127.0.0.1:41920', volumeStep: 2, seekStepSeconds: 5, playlistName: '', rating: 5 };

  function sendSettings() {
    if (!websocket || websocket.readyState !== WebSocket.OPEN || !context) {
      return;
    }
    settings.endpoint = document.getElementById('endpoint').value.trim();
    settings.volumeStep = Number(document.getElementById('volumeStep').value) || 2;
    settings.seekStepSeconds = Number(document.getElementById('seekStepSeconds').value) || 5;
    settings.playlistName = document.getElementById('playlistName').value.trim();
    settings.rating = Number(document.getElementById('rating').value) || 5;
    websocket.send(JSON.stringify({
      event: 'setGlobalSettings',
      context: context,
      payload: settings
    }));
  }

  function exportSettings() {
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

  function applySettings(next) {
    settings = Object.assign({}, settings, next || {});
    document.getElementById('endpoint').value = settings.endpoint;
    document.getElementById('volumeStep').value = settings.volumeStep;
    document.getElementById('seekStepSeconds').value = settings.seekStepSeconds;
    document.getElementById('playlistName').value = settings.playlistName;
    document.getElementById('rating').value = settings.rating;
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
    document.getElementById('rating').addEventListener('input', sendSettings);
    document.getElementById('exportSettings').addEventListener('click', exportSettings);
    document.getElementById('importSettings').addEventListener('change', importSettings);
  });
}());
