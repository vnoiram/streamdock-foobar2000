# streamdock-foobar2000

Mirabox Stream Dock JavaScript/HTML plugin for controlling foobar2000 through a localhost integration.

Primary control must go through a custom foobar2000 component, tentatively `foo_streamdock_control`, over localhost WebSocket or HTTP. Hotkey simulation is fallback-only.

## Version

Current version: `0.2.0`.

Notable `0.2.0` updates:

- Added `npm run clean` for removing generated `dist/` output.
- Added `npm run release:zip` as the standard release entry point.
- Release zips now include the manifest version in the filename.

Initial actions:

- Play/pause
- Stop
- Next
- Previous
- Volume up/down
- Mute
- Now playing display
- Now playing position/length display when the component reports timing
- Seek by knob
- Playback order command
- Playlist command
- Playlist selection, playlist next/previous, and playlist-name search
- Playlist track browsing: set `Playlist knob` to `Browse tracks`, rotate the Playlist action to choose a track in the active playlist, then press to play it.
- Playback order cycling
- Now Playing title template with `{artist}`, `{title}`, `{track}`, `{position}`, `{length}`, `{volume}`, and `{playlist}`
- Generated Now Playing image progress bar when album art is not available
- Invert knob direction
- Min/max volume clamp with absolute component-side volume setting
- Generated key images for playback, mute, volume, and offline states
- Optional album-art URL template for Now Playing images, using `{artist}` and `{title}` placeholders
- Local folder album art for Now Playing images. The component looks beside the playing file for `cover`, `folder`, `front`, or `album` images in JPG, PNG, or WebP format and sends a data URL to the plugin.
- Runtime per-track rating command for Stream Dock display
- Diagnostics action
- Plugin-side `logMessage` diagnostics
- Property Inspector `Copy` / `Paste` for quickly duplicating global foobar2000 settings between keys
- Property Inspector component `Diagnose`, search/playlist `Preview`, endpoint warning, and `Reset` for safe defaults

Default component endpoint:

```text
ws://127.0.0.1:41920
```

Expected component messages:

- Dock to component: `{ "command": "play_pause" }`, `stop`, `next`, `previous`, `volume_up`, `volume_down`, `mute`, `now_playing`, `seek_delta`, `cycle_playback_order`, `playlist_select`, `playlist_next`, `playlist_previous`, `playlist_search`, `library_search`, `playlist_browse_delta`, `playlist_play_selected`, `rating_set`.
- Component to Dock: `{ "event": "state", "payload": { "playing": true, "artist": "...", "title": "...", "volume": 50, "positionSeconds": 83, "lengthSeconds": 296, "playlist": "Default", "browseTrack": "...", "browseIndex": 0, "browseCount": 20, "playbackOrder": "Default", "rating": 5, "muted": false } }`.

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

For the Playlist action, set `Playlist knob` to `Browse tracks` to rotate through tracks in the active foobar2000 playlist and press to play the selected track. Set it to `Switch playlists` for the older playlist-switching behavior. `Now template` overrides the Now Playing title text; leave it blank for the built-in display.

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
6. Install the DLL into foobar2000's components folder through foobar2000 Preferences or by copying it to the user components directory.
7. Restart foobar2000 and confirm port `41920` is listening on localhost.

## Local Checks

The JavaScript and manifest can be checked without foobar2000:

```bash
npm run check
```

The foobar2000 component cannot be built in a non-Windows environment without the foobar2000 SDK.

## Key Images

The Stream Dock plugin uses `setImage` for generated state images. If the component sends an `image` field, that image is used for Now Playing. The component searches the playing file's folder for common cover filenames such as `cover.jpg`, `folder.jpg`, `front.png`, and `album.webp` up to 2 MB. Otherwise, `Art URL` can point to an external album-art service and may use `{artist}` and `{title}` placeholders. When no image source is available, the plugin generates a simple playback-state image.
