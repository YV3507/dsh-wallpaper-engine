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

- **场景静态帧缓存会整体失效一次**：帧缓存键以管线版本打头（当前 `PIPELINE_VERSION = 'sf45'`，
  已发布版本是 `sf33_`），源码里渲染逻辑一改就会升版 —— 升版后 `~/.dsh-wallpaper-engine/cache/frames/`
  里的旧帧**全部不再命中**，每张场景壁纸首次显示时重新冷渲染一次（实测约 2–10 秒/张，见
  [`SCENE-FRAME-PERF.md`](./archive/static-frame/SCENE-FRAME-PERF.md)）。**这是预期行为，不是回归**，旧帧也不会自动删除
  （可手动清 `cache/frames/` 回收磁盘）。想摊平这段时间可在「效果」页签提前开「空闲预热」。
  同理，切换「GPU 渲染加速」或「有损路线（主纹理近似）」也会各自换一套缓存键，两套产物互不命中。
- **新增实时渲染需要 WebGL2**：升级后场景 / 网页壁纸**默认走 WebWallGL 实时渲染**（「场景实时渲染」/
  「网页实时渲染」开关，默认开）。浏览器不支持 WebGL2、或显卡驱动异常时，渲染页首帧 15 秒超时后会
  **静默降级**回旧的「内嵌 MP4 → 静态帧」链（行为与升级前一致，不会黑屏卡住）；场景是松散
  `scene.json` 目录（没有 `scene.pkg`）时同样直接走旧链。
- 两级静态帧开关默认都是**开**（「静态帧渲染」/ 三级级联见 [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)），
  升级后无需任何操作。

### 兼容性实测记录

- **v0.7.1** 已在 DSH Desktop v2.0.5（harness 0.1.2-rc.1）上完成实测：壁纸宿主路由（inventory / media /
  scene-frame）、设置一级分区、选择器弹窗、视频与场景壁纸播放、拉绳抽屉、液态玻璃在「兼容模式」与
  「增强模式」下均正常。
- 本插件依赖的 slots / webserver / 主题变量等 API 在 0.1.2-rc.1 → 0.1.5-rc.1 之间经实测同样稳定。
- v0.7.2 起官方原生右侧栏纳入「侧栏液态玻璃」适配（修复升级 better-sidebar 0.19 后右侧栏整体透明的
  回归），细节见 [`CHANGELOG.md`](./CHANGELOG.md) 的 v0.7.2 条目。
- **当前版本 0.7.5**：本文件的实测记录停在 v0.7.1/v0.7.2，v0.7.5 的实时渲染链路另有离线验收
  （`scripts/verify-scene-live.mjs` 等 16 条链，`npm run verify`），尚未在真实宿主机上做端到端实测。

---

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

### Verified compatibility

- **v0.7.1** has been verified on DSH Desktop v2.0.5 (harness 0.1.2-rc.1): host routes (inventory / media /
  scene-frame), the first-level settings section, the picker modal, video & scene wallpaper playback, the
  rope-dock drawer, and the liquid-glass effects all work in both Compatibility and Enhanced desktop modes.
- The APIs this plugin relies on (slots / webserver / theme variables) were verified unchanged between
  0.1.2-rc.1 and 0.1.5-rc.1.
- From v0.7.2 the official native right sidebar is covered by the「侧栏液态玻璃」adaptation (fixing the
  fully-transparent right column after upgrading better-sidebar to 0.19) — see the v0.7.2 entry in
  [`CHANGELOG.md`](./CHANGELOG.md).
