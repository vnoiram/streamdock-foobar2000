# streamdock-foobar2000

localhost integration を通じて foobar2000 を制御する Mirabox Stream Dock JavaScript/HTML プラグインです。

主制御は、仮称 `foo_streamdock_control` の custom foobar2000 component を通じ、localhost WebSocket または HTTP で行う必要があります。hotkey simulation は fallback 専用です。

## バージョン

現在のバージョン: `0.5.0`

主な `0.5.0` 更新:

- Play/Pause は configurable long-press stop をサポートし、既定は 800 ms。
- Now Playing album art は original URL template、iTunes、Spotify、Last.fm、Deezer、MusicBrainz / Cover Art Archive から解決でき、Now Playing text overlay と merge できます。
- Now Playing image は描画結果が変わった場合だけ Stream Dock に送信し、artwork 更新の合成中は前回の artwork 描画を表示し続けます。
- Playlist knob press は active playlist で playback を開始し、Play/Pause、Next、Previous は Playlist control で選択した playlist に追従できます。
- Now Playing template は `{album}` をサポート。
- bundled `foo_streamdock_control` component は version `0.5.0` を報告。

初期 actions:

- Play/pause
- long-press stop 付き Play/pause
- Stop
- Next
- Previous
- press-to-mute 付き volume knob
- Mute
- Now playing display
- component が timing を報告する場合の now playing position/length display
- knob による seek
- configurable tick threshold と press-to-play/pause 付きの track next/previous by knob
- playback order command
- playlist command
- playlist name/search query が未設定の場合の playlist button one-step next/previous
- playlist selection、playlist next/previous、playlist-name search
- playlist track browsing: `Playlist knob` を `Browse tracks` にして active playlist の track を選び、press で再生
- playback order cycling
- `{artist}`, `{album}`, `{title}`, `{track}`, `{position}`, `{length}`, `{volume}`, `{playlist}` を使う Now Playing title template
- Now Playing generated image text alignment と per-line character limit
- Now Playing image update は重複送信を抑制し、不要な再描画を避けます。
- album art がない場合の generated Now Playing image progress bar
- knob/button direction inversion
- min/max volume clamp と component-side absolute volume setting
- playback、mute、volume、offline state の generated key image
- `{artist}`, `{album}`, `{title}` placeholder を使う optional album-art URL template
- iTunes、Spotify、Last.fm、Deezer、MusicBrainz / Cover Art Archive による optional external album-art provider
- local folder album art。component は再生 file の横にある `cover`, `folder`, `front`, `album` の JPG/PNG/WebP を探し、data URL を plugin に送ります。
- Stream Dock display 用 runtime per-track rating command
- Diagnostics action
- plugin-side `logMessage` diagnostics
- Property Inspector component `Diagnose`、endpoint warning、diagnostics log copy、plugin settings import/export
- track press mode: play、queue、play-next、append、common backup export format、Property Inspector diagnostic log copy

既定 component endpoint:

```text
ws://127.0.0.1:41920
```

expected component messages は、playback command、playlist command、rating command、full/partial state event、diagnostics response です。full state には playing、artist、album、title、volume、positionSeconds、lengthSeconds、playlist、browseTrack、playbackOrder、rating、muted、image などが含まれます。partial state は変化した area だけを含み、plugin は省略 field の以前の値を保持します。

## リポジトリ構成

- `manifest.json`: Stream Dock plugin manifest。
- `plugin.html` / `plugin.js`: Stream Dock runtime plugin。
- `property-inspector.*`: Stream Dock settings UI。
- `icons/`: plugin icon asset。
- `scripts/package-plugin.js`: 配布用 `.sdPlugin` directory を作成。
- `component/foo_streamdock_control/`: foobar2000 component source。

## Stream Dock Plugin

この repository root を plugin directory として package するか、必要な plugin files を Stream Dock plugin folder にコピーします。

plugin の既定 endpoint は `ws://127.0.0.1:41920` です。component port が変わった場合だけ Property Inspector で endpoint を変更してください。

component endpoint が localhost でない場合、playback command と now-playing data がその endpoint に送信されるため、Property Inspector は警告します。bundled component は `127.0.0.1` だけで listen するよう設計されています。

Playlist action では、`Playlist knob` を `Browse tracks` にすると active foobar2000 playlist の track を rotation で移動し、press で選択 track を再生します。`Switch playlists` にすると playlist switching になります。Playlist action が playlist を変更または browse した後、Play/Pause、Next、Previous は active playlist に route されます。

Play/Pause では、`Long press ms` が Stop を送るために button を押し続ける時間を制御します。既定は 800 ms です。`Now template` は Now Playing generated image text の multiline template です。空にすると built-in playlist / artist / title display を使います。

配布用 plugin folder をビルドします。

```bash
npm run package
```

build output を削除します。

```bash
npm run clean
```

出力は `dist/` 配下です。

Windows/PowerShell で release zip を作成します。

```powershell
npm run release:zip
```

release zip には `component/foo_streamdock_control.dll` を含める必要があります。DLL が `dist/` または `component/` にない場合は明示的に渡します。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -ComponentDll C:\path\to\foo_streamdock_control.dll
```

extracted release zip から Stream Dock plugin と bundled foobar2000 component の両方を install するには次を実行します。

```powershell
.\scripts\install-local.ps1 -InstallComponent
```

## foobar2000 Component

component source は `component/foo_streamdock_control/` にあります。

通常の foobar2000 SDK component project 内で build し、`ws2_32.lib`, `bcrypt.lib`, `crypt32.lib` を link します。component は `127.0.0.1:41920` だけで listen し、allowlisted command を受け付け、playback または volume が変化したときに `state` message を push します。

`rating_set` は意図的に runtime-only です。現在再生中 track について component process 内に selected rating を保存して Stream Dock に報告します。file tag や Playback Statistics metadata は書き込みません。

### Build

要件:

- Windows
- C++ desktop tooling 付き Visual Studio
- target foobar2000 generation に合う foobar2000 SDK

Build steps:

1. foobar2000 SDK component project を作成または開きます。
2. `component/foo_streamdock_control/foo_streamdock_control.cpp` を project に追加します。
3. SDK include path が `foobar2000/SDK/foobar2000.h` を解決することを確認します。
4. `ws2_32.lib`, `bcrypt.lib`, `crypt32.lib` を link します。
5. `foo_streamdock_control.dll` という名前の Release DLL を build します。
6. foobar2000 Preferences から、または user components directory へコピーして DLL を install します。
7. foobar2000 を restart し、port `41920` が localhost で listen していることを確認します。

Visual Studio project と Windows-container build wrapper も含まれています。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-foobar-component-in-windows-docker.ps1
```

## Local Checks

foobar2000 なしで JavaScript と manifest を check できます。

```bash
npm run check
```

foobar2000 component は foobar2000 SDK のない non-Windows environment では build できません。

## Key Images

Stream Dock plugin は generated state image に `setImage` を使います。component が `image` field を送る場合、その image が Now Playing artwork background として使われます。component は playing file の folder から `cover.jpg`, `folder.jpg`, `front.png`, `album.webp` などを最大 2 MB まで探します。そうでない場合は、`Art source` で original URL template、iTunes、Spotify、Last.fm、Deezer、MusicBrainz / Cover Art Archive を使えます。Spotify には Client ID/Secret、Last.fm には API key が必要です。artwork がある場合、plugin は Now Playing text overlay と progress bar を merge します。image source がない場合は、text-only playback-state image を生成します。
