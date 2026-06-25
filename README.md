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
- Playlist/library search command boundary for SDK projects that wire it up
- Rating command
- Diagnostics action
- Plugin-side `logMessage` diagnostics

Default component endpoint:

```text
ws://127.0.0.1:41920
```

Expected component messages:

- Dock to component: `{ "command": "play_pause" }`, `stop`, `next`, `previous`, `volume_up`, `volume_down`, `mute`, `now_playing`, `seek_delta`, `cycle_playback_order`, `playlist_select`, `playlist_next`, `playlist_previous`, `rating_set`.
- Component to Dock: `{ "event": "state", "payload": { "playing": true, "artist": "...", "title": "...", "volume": 50, "positionSeconds": 83, "lengthSeconds": 296, "muted": false } }`.

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
