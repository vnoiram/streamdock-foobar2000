# streamdock-foobar2000

日本語版はこちら: [README.ja.md](README.ja.md)

Mirabox Stream Dock JavaScript/HTML plugin for controlling foobar2000 through a localhost integration.

Primary control must go through a custom foobar2000 component, tentatively `foo_streamdock_control`, over localhost WebSocket or HTTP. Hotkey simulation is fallback-only.

## Version

Current version: `0.5.1`.

Notable `0.5.1` updates:

- Now Playing images are only sent to Stream Dock when the rendered image changes, and the previous artwork render is kept visible while an updated artwork image is being composed.

Notable `0.5.0` updates:

- Play/Pause supports configurable long-press stop, defaulting to 800 ms.
- Now Playing album art can be resolved from an original URL template, iTunes, Spotify, Last.fm, Deezer, or MusicBrainz / Cover Art Archive and merged with the Now Playing text overlay.
- Playlist knob press starts playback in the active playlist, and Play/Pause, Next, and Previous can follow the playlist selected by Playlist controls.
- Now Playing templates support `{album}`.
- The bundled `foo_streamdock_control` component reports version `0.5.0`.

Initial actions:

- Play/pause
- Play/pause with long-press stop
- Stop
- Next
- Previous
- Volume knob with press-to-mute
- Volume button with current-volume display and selectable press behavior
- Mute
- Now playing display
- Now playing position/length display when the component reports timing
- Seek by knob
- Track next/previous by knob with configurable tick threshold and press-to-play/pause
- Playback order command
- Playlist command
- Playlist button one-step next/previous when no playlist name or search query is configured
- Playlist selection, playlist next/previous, and playlist-name search
- Playlist knob press starts playback in the active playlist. After using Playlist controls, Play/Pause, Next, and Previous operate within that active playlist.
- Playlist track browsing: set `Playlist knob` to `Browse tracks`, rotate the Playlist action to choose a track in the active playlist, then press to play it.
- Playback order cycling
- Now Playing title template with `{artist}`, `{album}`, `{title}`, `{track}`, `{position}`, `{length}`, `{volume}`, and `{playlist}`
- Now Playing generated image text alignment and per-line character limit
- Now Playing image updates are deduplicated to avoid unnecessary redraws.
- Generated Now Playing image progress bar when album art is not available
- Invert knob/button direction
- Min/max volume clamp with absolute component-side volume setting
- Volume button press mode for mute toggle, volume up, or volume down
- Generated key images for playback, mute, volume, and offline states
- Optional album-art URL template for Now Playing images, using `{artist}`, `{album}`, and `{title}` placeholders
- Optional external album-art providers for Now Playing images: iTunes, Spotify, Last.fm, Deezer, and MusicBrainz / Cover Art Archive. Provider art is merged with the Now Playing text overlay.
- Local folder album art for Now Playing images. The component looks beside the playing file for `cover`, `folder`, `front`, or `album` images in JPG, PNG, or WebP format and sends a data URL to the plugin.
- Runtime per-track rating command for Stream Dock display
- Diagnostics action
- Plugin-side `logMessage` diagnostics
- Property Inspector component `Diagnose`, endpoint warning, diagnostics log copy, and plugin settings import/export
- Track press modes for play, queue, play-next, or append, plus common backup export format and Property Inspector diagnostic log copy

Default component endpoint:

```text
ws://127.0.0.1:41920
```

Expected component messages:

- Dock to component: `{ "command": "play_pause" }`, `stop`, `next`, `previous`, `playlist_play_pause`, `playlist_next_track`, `playlist_previous_track`, `volume_up`, `volume_down`, `mute`, `now_playing`, `diagnostics`, `seek_delta`, `cycle_playback_order`, `playlist_select`, `playlist_next`, `playlist_previous`, `playlist_search`, `library_search`, `playlist_browse_delta`, `playlist_play_selected`, `playlist_play_active`, `rating_set`.
- Component to Dock full state: `{ "event": "state", "payload": { "stateKind": "full", "stateUpdate": "full", "playing": true, "artist": "...", "album": "...", "title": "...", "volume": 50, "positionSeconds": 83, "lengthSeconds": 296, "playlist": "Default", "browseTrack": "...", "browseIndex": 0, "browseCount": 20, "playbackOrder": "Default", "rating": 5, "muted": false, "image": "..." } }`.
- Component to Dock partial state: `{ "event": "state", "payload": { "stateKind": "partial", "stateUpdate": "time", "playing": true, "paused": false, "positionSeconds": 84, "lengthSeconds": 296 } }`. Partial states only include the changed update area; the plugin keeps previous values for omitted fields.
- Diagnostics response: `{ "event": "diagnostics", "payload": { "ok": true, "component": "foo_streamdock_control", "endpoint": "ws://127.0.0.1:41920", "clientCount": 1, "playing": true, "paused": false, "playbackOrder": "Default", "playlist": "Default", "artist": "...", "title": "...", "track": "..." } }`.

## Repository Layout

- `manifest.json`: Stream Dock plugin manifest.
- `plugin.html` / `plugin.js`: Stream Dock runtime plugin.
- `property-inspector.*`: Stream Dock settings UI.
- `icons/`: plugin icon assets.
- `scripts/package-plugin.js`: creates a distributable `.sdPlugin` directory.
- `component/foo_streamdock_control/`: foobar2000 component source.

## Stream Dock Plugin

Package this repository root as the plugin directory, or copy these files into a Stream Dock plugin folder:

- `manifest.json`
- `plugin.html`
- `plugin.js`
- `property-inspector.html`
- `property-inspector.js`
- `property-inspector.css`
- `icons/`

The plugin defaults to `ws://127.0.0.1:41920`. Change the endpoint in the Property Inspector only if the component port changes.

The Property Inspector warns when the component endpoint is not localhost because playback commands and now-playing data will be sent to that endpoint. The bundled component is designed to listen only on `127.0.0.1`.

For the Playlist action, set `Playlist knob` to `Browse tracks` to rotate through tracks in the active foobar2000 playlist and press to play the selected track. Set it to `Switch playlists` for playlist switching; pressing the playlist knob starts playback from the active playlist's focused item, or the first item if nothing is focused. Pressing Playlist with no playlist name or search query configured moves one playlist forward, or backward when `Invert` is enabled. After a Playlist action changes or browses a playlist, Play/Pause, Next, and Previous are routed to the active playlist. For Play/Pause, `Long press ms` controls how long the button must be held to send Stop instead of Play/Pause, defaulting to 800 ms. The Volume Button action shows the current foobar2000 volume and `Volume press` chooses whether pressing it toggles mute, raises volume, or lowers volume. `Now template` is a multiline template for the Now Playing generated image text; leave it blank for the built-in playlist / artist / title display. Existing templates that use `\n` are also treated as line breaks. `Text align` controls the generated Now Playing image text alignment. `Auto` centers lines that fit within `Max chars` and left-aligns lines that are ellipsized. `Max chars` is a display-width limit before ellipsis; wide Japanese/CJK characters and emoji count wider than ASCII characters.

Build a distributable plugin folder:

```bash
npm run package
```

Clean build output:

```bash
npm run clean
```

The output is written under `dist/`.

Create a release zip on Windows/PowerShell:

```powershell
npm run release:zip
```

The release zip must include `component/foo_streamdock_control.dll`. If the DLL is not under `dist/` or `component/`, pass it explicitly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -ComponentDll C:\path\to\foo_streamdock_control.dll
```

To install both the Stream Dock plugin and the bundled foobar2000 component from an extracted release zip, run:

```powershell
.\scripts\install-local.ps1 -InstallComponent
```

## foobar2000 Component

The component source lives in `component/foo_streamdock_control/`.

Build it inside a normal foobar2000 SDK component project and link `ws2_32.lib`, `bcrypt.lib`, and `crypt32.lib`. The component listens only on `127.0.0.1:41920`, accepts the allowlisted commands above, and pushes `state` messages when playback or volume changes.

`rating_set` is intentionally runtime-only: it stores the selected rating in the component process for the currently playing track and reports it back to Stream Dock. It does not write file tags or Playback Statistics metadata.

### Build

Prerequisites:

- Windows.
- Visual Studio with C++ desktop tooling.
- foobar2000 SDK matching the target foobar2000 generation.

Build steps:

1. Create or open a foobar2000 SDK component project.
2. Add `component/foo_streamdock_control/foo_streamdock_control.cpp` to the project.
3. Ensure the SDK include path resolves `foobar2000/SDK/foobar2000.h`.
4. Link these Windows libraries:
   - `ws2_32.lib`
   - `bcrypt.lib`
   - `crypt32.lib`
5. Build a Release DLL named `foo_streamdock_control.dll`.
6. Install the DLL into foobar2000's components folder through foobar2000 Preferences or by copying it to the user components directory. Release zips can do this with `.\scripts\install-local.ps1 -InstallComponent`.
7. Restart foobar2000 and confirm port `41920` is listening on localhost.

This repository also includes a Visual Studio project and Windows-container build wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-foobar-component-in-windows-docker.ps1
```

The wrapper builds `Dockerfile.foobar2000-component.windows`, installs Visual Studio Build Tools, Node.js, and the foobar2000 SDK, then writes `dist\component\foo_streamdock_control.dll` and a release zip containing that DLL.

## Local Checks

The JavaScript and manifest can be checked without foobar2000:

```bash
npm run check
```

The foobar2000 component cannot be built in a non-Windows environment without the foobar2000 SDK.

## Key Images

The Stream Dock plugin uses `setImage` for generated state images. If the component sends an `image` field, that image is used as the Now Playing artwork background. The component searches the playing file's folder for common cover filenames such as `cover.jpg`, `folder.jpg`, `front.png`, and `album.webp` up to 2 MB. Otherwise, `Art source` can use an original URL template with `{artist}`, `{album}`, and `{title}`, or fetch from iTunes, Spotify, Last.fm, Deezer, or MusicBrainz / Cover Art Archive. Spotify requires Client ID/Secret, and Last.fm requires an API key. When artwork is available, the plugin merges it with the Now Playing text overlay and progress bar. When no image source is available, the plugin generates a simple text-only playback-state image.
