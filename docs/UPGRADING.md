# 升级指南 / Upgrading

> 本文件承接原先放在 README 首页的**升级前置条件与版本兼容说明**。README 只保留一行提示 + 链接。
> 各版本修了什么见 [`CHANGELOG.md`](./CHANGELOG.md)；安装失败报错见 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)。

## 中文

### ⚠️ 更新前置条件：① DSH 内核最新 ② better-sidebar 最新

**两个前置条件都满足之前，请勿更新本插件。** v0.7.2 适配 DeepSeek Harness **0.1.5-rc.1**
（对应 **DSH Desktop ≥ 2.0.7**），并要求 **dsh-better-sidebar ≥ 0.19.0**（0.19 起右侧栏接入
DSH 0.1.5 的官方原生侧栏；仍停留在 0.1.2-rc.1 旧内核的用户请保持 better-sidebar 0.18.x，**不要混搭**）。

| 组件 | v0.7.2+ 要求 | 停留在旧内核（0.1.2-rc.1）时 |
|---|---|---|
| DeepSeek Harness / DSH Desktop | 0.1.5-rc.1 / ≥ 2.0.7 | 0.1.2-rc.1 / v2.0.5 |
| dsh-better-sidebar | ≥ 0.19.0 | 0.18.x |

### 正确的更新顺序

1. **先把 DeepSeek Harness / DSH Desktop 更新到最新版**：DSH Desktop 在「顶部导航栏 → 版本信息」检查更新，或到 [GitHub Releases](https://github.com/anywhere-labs/dsh-desktop/releases) 下载对应平台安装包；
2. **再把 dsh-better-sidebar 更新到 0.19.0+**：`dsh plugin --profile web add dsh-better-sidebar@latest`；
3. **最后更新本插件**：`dsh plugin --profile web add dsh-plugin-wallpaper-engine`（或插件市场里点更新）。

> 💡 同时建议把**其它 DSH 插件也一并更新**：旧版插件在 harness 0.1.5 下可能直接加载失败
> （实测旧版 dsh-better-sidebar 在 0.1.5 下会因 API 变更异常）。

### 顺序反了怎么办

把内核与 better-sidebar 各自更新到匹配版本即可恢复；**无需回滚本插件**。

### 升级提示

插件更新后会在界面里弹一次提示（每个新版本仅出现一次），漏看也没关系。

### 升级后会发生什么（帧缓存 / 实时渲染）

- **帧缓存会整体失效一次**：缓存键以管线版本打头（当前 `LIVE_FRAME_KEY_VERSION = 'lf1'`，
  已发布版本用过 `sf33_`（见 CHANGELOG 的 v0.7.5 条目）），源码里抓帧 / 实时渲染逻辑一改就会升版 —— 升版后
  `~/.dsh-wallpaper-engine/cache/frames/` 里的旧产物**全部不再命中**，每张场景壁纸需要重新抓一次
  实时帧。**这是预期行为，不是回归**，旧文件也不会自动删除（可手动清 `cache/frames/` 回收磁盘）。
  该目录同时还存场景内嵌视频（`sv1_*.mp4`）与场景包内音频（`sa1_*`），各有自己的版本前缀。
- **新增实时渲染需要 WebGL2**：升级后场景 / 网页壁纸**默认走 WebWallGL 实时渲染**（「场景实时渲染」/
  「网页实时渲染」开关，默认开）。浏览器不支持 WebGL2、或显卡驱动异常时，渲染页首帧 15 秒超时后会
  **静默降级**回「内嵌 MP4 → 实时抓帧 → 自定义画面 → 空态」这条链（首帧之前垫的是**作者的预览图**，
  连它都取不到才诚实留空 —— 不会黑屏卡住）；场景是松散
  `scene.json` 目录（没有 `scene.pkg`）时同样直接走那条链。
- **实时渲染默认开**（`sceneLive`），升级后无需任何操作。

### 兼容性实测记录

- **v0.7.1** 已在 DSH Desktop v2.0.5（harness 0.1.2-rc.1）上完成实测：壁纸宿主路由（inventory / media /
  scene-frame）、设置一级分区、选择器弹窗、视频与场景壁纸播放、拉绳抽屉、液态玻璃在「兼容模式」与
  「增强模式」下均正常。
- 本插件依赖的 slots / webserver / 主题变量等 API 在 0.1.2-rc.1 → 0.1.5-rc.1 之间经实测同样稳定。
- v0.7.2 起官方原生右侧栏纳入「侧栏液态玻璃」适配（修复升级 better-sidebar 0.19 后右侧栏整体透明的
  回归），细节见 [`CHANGELOG.md`](./CHANGELOG.md) 的 v0.7.2 条目。
- **当前版本 1.1.0**（打包修复版；上游最新 release 仍是 v1.0.1）：本文件的端到端实测记录停在 v0.7.1/v0.7.2；
  v0.7.5 及之后的实时渲染链路另有离线验收（`test/verify-scene-live.mjs` 等 24 条链，`npm run verify`）。

  **v1.0.1 的搭配建议：`dsh-desktop` ≥ 2.0.14** —— 该版修复了插件加载失败、右栏玻璃关闭态露灰板、
  增强模式左栏灰面板遮挡壁纸等问题；v1.0.1 起**兼容 / 增强 / 扩展三种窗口模式**下壁纸与全部效果均可用。
  行为差异见 [`CHANGELOG.md`](./CHANGELOG.md) 的 v1.0.1 / v0.7.6–v0.7.8 条目。

---

### 设置持久化：改存宿主端文件（v0.4.0）

**你的全部设置（已选壁纸、配色、透明度、布局、轮播、隐藏、倍速/翻转等）从 v0.4.0 起保存在宿主端文件里，不再依赖浏览器 localStorage。**

- **存在哪里**：`~/.dsh-wallpaper-engine/config.json`（与「上传目录」的配置是同一个文件）。
  Windows：`C:\Users\<你的用户名>\.dsh-wallpaper-engine\config.json`；WSL / Linux / macOS：`~/.dsh-wallpaper-engine/config.json`。
- **为什么改**：localStorage 按「地址 + 端口」隔离，而 **DSH Desktop 每次启动用随机端口** ⇒ 每次都是全新的存储空间，配置全部恢复默认（Web 端固定端口无此问题）。改存宿主端文件后与端口无关。
- **好处**：重启 / 换端口 / 清浏览器数据 / 换浏览器 / 无痕模式都不再丢失配置。
- **旧数据迁移**：老版本存在 localStorage 里的配置会在**首次启动时自动迁移**，无需手动操作。
- **行为变化**：同一台电脑上多个浏览器（如 Chrome 与 Edge）访问同一个 dsh 时**共享同一份配置**（此前各存各的）；回滚到旧版本仍会读 localStorage 里的缓存副本，配置不会丢。
- **读写**：每次修改自动写入（200ms 防抖合并）；文件损坏时回退默认值且**不会覆盖**你的文件。


## English

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
  [`CHANGELOG.md`](./CHANGELOG.md).

- **Current version 1.1.0** (packaging fix; the latest upstream release is still v1.0.1): the end-to-end record in this file stops
  at v0.7.1/v0.7.2; the live-rendering chain from v0.7.5 on has offline verification only
  (`test/verify-scene-live.mjs` and more, `npm run verify`). **Recommended pairing: `dsh-desktop` ≥ 2.0.14** —
  that release fixed plugin load failures, the right-sidebar glass grey plate when collapsed, and the
  enhanced-mode left grey panel covering the wallpaper; from v1.0.1 wallpapers and every effect work in all
  three window modes (compatibility / enhanced / extended). See the v1.0.1 and v0.7.6–v0.7.8 entries in
  [`CHANGELOG.md`](./CHANGELOG.md).

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

