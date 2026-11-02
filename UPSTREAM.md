# Upstream and implementation scope

Behavior reference: https://github.com/arpagon/pi-rewind

Reference revision recorded on 2026-11-02: `91611ad87992fb7b635a41ba68f67916ff6e6ae3`. The source inspection used upstream `main`; the recorded revision identifies that research snapshot, not a dependency that this package downloads or executes.

## Source consulted

- [src/core.ts](https://github.com/arpagon/pi-rewind/blob/91611ad87992fb7b635a41ba68f67916ff6e6ae3/src/core.ts)
- [src/index.ts](https://github.com/arpagon/pi-rewind/blob/91611ad87992fb7b635a41ba68f67916ff6e6ae3/src/index.ts)
- [src/commands.ts](https://github.com/arpagon/pi-rewind/blob/91611ad87992fb7b635a41ba68f67916ff6e6ae3/src/commands.ts)

## Attribution

Upstream is MIT, copyright (c) 2026 arpagon. See the upstream [LICENSE](https://github.com/arpagon/pi-rewind/blob/91611ad87992fb7b635a41ba68f67916ff6e6ae3/LICENSE) and this package's [NOTICE](NOTICE) for its full license text.

This is an independently written DSH behavior port. No upstream implementation source was copied. It uses DSH 0.2.1-rc.2 named plugin exports and real ToolRuntime definitions with mandatory canonical output schemas; it does not adapt or load the Pi runtime. No Pi or upstream runtime dependency is installed by this package.

The local code is MIT, copyright (c) 2026 LIghtJUNction, under [LICENSE](LICENSE). The narrower supported behavior, changed interfaces, host-local filesystem boundary and omitted upstream features are documented in [README.md](README.md). Passing local offline tests is not a claim of full upstream parity, remote-world support, published npm packages, or live-provider acceptance.
