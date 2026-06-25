# foo_streamdock_control

foobar2000 component that exposes a localhost WebSocket control surface for the Stream Dock plugin.

Default endpoint:

```text
ws://127.0.0.1:41920
```

This component is intended to be built inside a normal foobar2000 SDK component project. Place `foo_streamdock_control.cpp` in the component source tree and link against:

- `ws2_32.lib`
- `bcrypt.lib`
- `crypt32.lib`

The code expects the foobar2000 SDK headers to be available through:

```cpp
#include "foobar2000/SDK/foobar2000.h"
```

Accepted commands are allowlisted:

- `play_pause`
- `stop`
- `next`
- `previous`
- `volume_up`
- `volume_down`
- `mute`
- `now_playing`

Unknown commands receive an `error` message and are not dispatched to foobar2000.
