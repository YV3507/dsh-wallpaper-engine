# Upgrading

> **中文**: [`../UPGRADING.md`](../UPGRADING.md)（与本文同源：改一处请同步另一处）


### ⚠️ Prerequisites from v1.2.0: the official desktop (DeepSeek Harness) ≥ 0.2.0-rc.1

**The adaptation baseline moves to the official desktop line in v1.2.0**: the plugin manifest declares
`engines.dsh: ">=0.2.0-rc.1"` — the old **DSH Desktop 2.0.x** (kernel 0.1.7-rc.1) **cannot install
v1.2.0** (the plugin market flags it red and refuses the install). If you already run 1.1.0 on the old
desktop it keeps working; switch to the official desktop before updating. The dsh-better-sidebar
prerequisite is unchanged (≥ 0.19.0) — the latest release the market installs on the official desktop
(0.24+) itself targets the 0.2.0-rc.1 line.

| Component | Required by v1.2.0+ |
|---|---|
| DeepSeek Harness desktop (official) | ≥ 0.2.0-rc.1 |
| dsh-better-sidebar | ≥ 0.19.0 |

### ⚠️ Prerequisites for updating: ① latest DSH kernel ② latest better-sidebar

**Do NOT update this plugin until BOTH prerequisites are met.** v0.7.2 targets DeepSeek Harness
**0.1.5-rc.1** (shipped in **DSH Desktop ≥ 2.0.7**) and requires **dsh-better-sidebar ≥ 0.19.0**
(from 0.19 the right column plugs into the native right sidebar of harness 0.1.5; users still on the
0.1.2-rc.1 line should keep better-sidebar 0.18.x — **do not mix**).

| Component | Required by v0.7.2+ | Staying on the older kernel (0.1.2-rc.1) |
|---|---|---|
| DeepSeek Harness / DSH Desktop | 0.1.5-rc.1 / ≥ 2.0.7 | 0.1.2-rc.1 / v2.0.5 |
| dsh-better-sidebar | ≥ 0.19.0 | 0.18.x |

### The correct update order

1. **Update DeepSeek Harness / DSH Desktop first**: check for updates via the desktop app's top-bar version info, or grab the installer from [GitHub Releases](https://github.com/anywhere-labs/dsh-desktop/releases);
2. **Then update dsh-better-sidebar to 0.19.0+**: `dsh plugin --profile web add dsh-better-sidebar@latest`;
3. **Finally update this plugin**: `dsh plugin --profile web add dsh-plugin-wallpaper-engine` (or click update in the plugin market).

> 💡 Also update your **other DSH plugins at the same time**: older plugins may fail to load outright on
> harness 0.1.5 (an old dsh-better-sidebar was observed misbehaving on 0.1.5 due to API changes).

### If you updated out of order

Bringing the kernel and better-sidebar back to their matching latest versions restores everything —
**no plugin rollback needed**.

### Update notice

The plugin shows a one-time in-app notice per release; missing it is harmless.

### What changes after the upgrade (frame cache / live rendering)

- **The frame cache is invalidated once**: cache keys are prefixed with a pipeline version (currently
  `LIVE_FRAME_KEY_VERSION = 'lf1'`; the published version was `sf33_`), and any change to the capture /
  live-render logic bumps it — after a bump nothing under `~/.dsh-wallpaper-engine/cache/frames/` hits any
  more, and each scene wallpaper is captured afresh. **This is expected, not a regression**; old files are
  not deleted automatically (clear `cache/frames/` by hand to reclaim the space). The same directory also
  holds the scene's embedded video (`sv1_*.mp4`) and packaged audio (`sa1_*`), each with its own prefix.
- **Live rendering needs WebGL2**: after upgrading, scene / web wallpapers render live through WebWallGL by
  default (「场景实时渲染」/「网页实时渲染」, on by default). Without WebGL2, or with a broken GPU driver, the
  renderer page times out after a 15 s first frame and **degrades silently** to the
  「embedded MP4 → live capture → custom frame → empty state」 chain (before the first frame the
  **author's preview** stands in and only a missing preview leaves it honestly blank — no black screen); a loose `scene.json`
  directory takes that chain directly.
- **Live rendering is on by default** (`sceneLive`) — nothing to do after upgrading.

### Verified compatibility

- **v0.7.1** has been verified on DSH Desktop v2.0.5 (harness 0.1.2-rc.1): host routes (inventory / media /
  scene-frame), the first-level settings section, the picker modal, video & scene wallpaper playback, the
  rope-dock drawer, and the liquid-glass effects all work in both Compatibility and Enhanced desktop modes.
- The APIs this plugin relies on (slots / webserver / theme variables) were verified unchanged between
  0.1.2-rc.1 and 0.1.5-rc.1.
- From v0.7.2 the official native right sidebar is covered by the「侧栏液态玻璃」adaptation (fixing the
  fully-transparent right column after upgrading better-sidebar to 0.19) — see the v0.7.2 entry in
  [`CHANGELOG.md`](../CHANGELOG.md) (Chinese only).

- **Current version 1.1.0** (`package.json`; the latest published npm release is still v1.0.1): the end-to-end record in this file stops
  at v0.7.1/v0.7.2; the live-rendering chain from v0.7.5 on has offline verification only
  (`test/verify-scene-live.mjs` and more, `npm run verify`). **Recommended pairing: `dsh-desktop` ≥ 2.0.14** —
  that release fixed plugin load failures, the right-sidebar glass grey plate when collapsed, and the
  enhanced-mode left grey panel covering the wallpaper; from v1.0.1 wallpapers and every effect work in all
  three window modes (compatibility / enhanced / extended). See the v1.0.1 and v0.7.6–v0.7.8 entries in
  [`CHANGELOG.md`](../CHANGELOG.md) (Chinese only).

### Settings persistence: moved to a host-side file (v0.4.0)

**Since v0.4.0 every setting (selected wallpaper, accent, transparency, layout, rotation, hidden list,
playback speed/flip, …) lives in a host-side file instead of browser localStorage.**

- **Where**: `~/.dsh-wallpaper-engine/config.json` (the same file that stores your upload directory).
- **Why**: localStorage is isolated per "origin + port", and **DSH Desktop picks a random port on every
  start** — so each launch looked like a brand-new store and every setting reverted to default. A host-side
  file is port-independent.
- **Benefits**: restarts, port changes, cleared browser data, a different browser or a private window no
  longer lose your settings.
- **Migration**: settings previously kept in localStorage are **migrated automatically on first start**.
- **Behaviour change**: several browsers on the same machine now **share one config** (they used to be
  separate); rolling back to an older version still reads the localStorage copy, so nothing is lost.
- **Writes**: debounced 200 ms; a corrupt file falls back to defaults and is **never overwritten**.


