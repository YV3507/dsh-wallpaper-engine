# 工作原理 / How it works

> 本文件承接原先放在 README 首页的**实现细节**：场景渲染器、宿主 / 客户端分工、HTTP 路由表。
> 门面（`../README.md`）只保留「支持哪些壁纸类型」的结论表 + 本文件链接。
> 渲染路线的工程决策见 [`RENDERER-FEASIBILITY.md`](./archive/static-frame/RENDERER-FEASIBILITY.md)。
> 场景动画的旧实现（beta 场景动画 / `/scene-anim`）已随 WebWallGL 实时渲染落地而**移除**，
> 其历史记录见 [`SCENE-ANIMATION-HANDOFF.md`](./archive/scene-animation/SCENE-ANIMATION-HANDOFF.md)（已归档）。

## 中文

### 场景 / 网页壁纸的默认形态：WebWallGL 实时渲染

**scene 与 web 壁纸默认走实时渲染**（设置项 `sceneLive`，UI 文案「场景实时渲染」/「网页实时渲染」，
默认开）——渲染器是**上游 WebWallGL 1.4.1 的原版页面**，vendored 在 `lib/webwallgl/`，
由宿主以 `/wallpaper-engine/scene-live/` 为 base 挂载（资源引用按该前缀解析），壁纸自身的文件
（`scene.pkg` / 网页项目文件）经 `/wallpaper-engine/scene-files/` 供给。网页壁纸由宿主在返回的
HTML 里注入 WE API shim（`lib/webwallgl/web-shim.js`）与 `project.json` 的属性 seed ——
严格沙箱下渲染页够不到壁纸 iframe，shim 必须随文档一起到达。

- **何时不走实时渲染**：壁纸开关被关掉、该壁纸已被记入**失败记忆**（首帧 15 秒超时；或运行期连续
  **约 40 秒**无帧 —— 心跳 1 秒/次，第 20 秒先自动 `resume` 自救一次），或场景是**松散 `scene.json`
  目录**（没有 `scene.pkg` 可供渲染页拉取）。此时按下面的**出图来源链**出图（允许诚实地留空）。
  重新打开开关会清空失败记忆（显式重试入口）。
- **出图来源（唯一权威顺序，代码在 `lib/routes/scene-frame.js`）**：
  ① 实时渲染 iframe → ② 场景**作者内嵌 MP4**（`sceneVideo`，硬件解码 `<video>`）→ ③ **实时抓帧**
  （`<key>_gpu.png`，live 渲染页首帧确认后由客户端回填）→ ④ **自定义画面**（用户导入的截屏）
  → ⑤ **空态**（404 + 可判定原因）。
  关掉实时渲染不会改变 ①②；`?v=4` 是"强制自定义画面"（**豁免**抓帧：显式 pin 的来源不被一张抓帧顶掉），
  `?v=1/2/3` 已退役、一律 clamp 到 0。
- **为什么没有 CPU 兜底出图（P2-12 的设计决定）**：0.6–0.7.x 曾用「离线场景渲染器 / 主纹理提取 /
  工坊预览图」三级兜底。它们的共同缺陷是**能"成功"产出一张劣质图**：绕过质量门禁、把糊帧写进缓存、
  让"这张壁纸没有可用画面"这个**可判定事实**退化成一张看似正常的画面 —— 用户看到的是"壁纸糊了"，
  而不是"它没有画面"。整条线（渲染器 + 提取链 + 合成器，约 1 万行）已随 P2-12 删除；现在的契约是
  **要么给真画面、要么明确留空**（状态行给出可判定原因）。
- **帧率**：`实时渲染帧率`（15 / 30 / 60 fps）经 iframe query 下发，改档会重建图层。
- 护栏：`test/verify-scene-live.mjs`（实时链）、`test/verify-scene.mjs`（出图来源链 + 抓帧缓存）。

### 场景渲染：怎么工作的

场景由**内置的 WebWallGL 引擎**实时渲染（vendored 在 `lib/webwallgl/`；它自己解析 `scene.pkg` / 松散
`scene.json`、重放对象树 / 纹理 / 粒子 / shader，并优先走 GPU、无 GPU 时熔断回软渲染）。选择器里场景
卡片的**类型**徽标是「场景」；`/scene-live` + `/scene-files` 是它的数据面。宿主侧的契约只有两条：
**把场景文件按需喂给渲染页**，以及**把渲染页抓回来的帧收好**（③ 实时抓帧）。

### 工作原理

- **Host 端**（`lib/index.js`）：一个 Cordis 插件，负责
  1. 通过读取 Steam 的 `libraryfolders.vdf` 定位 Wallpaper Engine 安装位置（所以 Steam 装在非默认盘也能用）；
  2. 从 `projects/defaultprojects`、`projects/myprojects` 以及 `steamapps/workshop/content/431960/*` 枚举壁纸；
  3. 在 DSH webserver 上注册同源 HTTP 路由，让浏览器端直接获取数据和流式加载媒体：
     - `GET /wallpaper-engine/inventory` → 壁纸 JSON 列表
     - `GET /wallpaper-engine/media/<token>` → 视频 / HTML（支持 Range）
     - `GET /wallpaper-engine/web/<token>/<子路径>` → 网页壁纸的**子资源**（`main.js` / `styles.css` / `images/*`）。
       web 壁纸是多文件 HTML 应用，入口里全是相对路径，而 iframe 的 src 决定相对解析基准 —— 必须用这条
       「目录型」路由当入口，相对资源才会落回同一前缀（拿 `/media/<token>` 当入口会让每个子资源都变成
       `/media/<文件名>` 而 404，iframe 里因此什么都没有）。资源根 = 入口 HTML 所在目录；护栏：
       `scripts/verify-web-route.mjs`（该护栏未随本线保留）
     - `GET /wallpaper-engine/preview/<token>` → 预览图
     - `GET /wallpaper-engine/video-preview/<token>` → 自上传 MP4 的按需抽帧缩略图（ffmpeg，磁盘缓存）
     - `GET /wallpaper-engine/scene-live/<子路径>` → 内置 WebWallGL 渲染页（vendor 产物 `lib/webwallgl/`，以 `/wallpaper-engine/scene-live/` 为 base 挂载；实时渲染 iframe 加载它）
     - `GET /wallpaper-engine/scene-files/<token>/<子路径>` → 壁纸原始文件（`scene.pkg` / 网页项目文件，支持 Range）；网页壁纸的 HTML 在这里被注入 WE shim 与属性 seed
     - `GET /wallpaper-engine/scene-frame/<token>` → 场景壁纸完整场景帧（自研渲染器输出 3840 宽 / 高度随场景比例，失败回退主纹理提取，PNG/JPG 磁盘缓存；`?v=` 选帧来源档位）
     - `GET /wallpaper-engine/scene-video/<token>` → 场景内嵌 MP4（抽出后硬件解码播放，支持 Range；场景无内嵌视频时 404，客户端回退静态帧）
     - `GET /wallpaper-engine/scene-audio/<token>` → 场景包内独立音频（无内嵌 MP4 的场景播放；与内嵌视频音轨互斥）
     - `GET /wallpaper-engine/scene-runtime/<token>` → 场景 WebGL 播放器页面（同源 HTML；客户端默认不内嵌，仅作回退路径）
     - `GET /wallpaper-engine/scene-manifest/<token>` → 场景清单 JSON（图层 / 模型 / 粒子 / 相机，按需从 `scene.pkg` 构建，供播放器读取）
     - `GET /wallpaper-engine/scene-resource/<token>/<子路径>` → 场景资源（清单引用的纹理 / 精灵，可解码则返回 PNG，否则原始字节）
     - `GET /wallpaper-engine/custom-frame/<token>` → 用户导入的「自定义画面」（帧档位第 4 档；GET=读 / POST=导入 / DELETE=清除）
     - `GET /wallpaper-engine/diag-log` → 渲染页的诊断日志回传（GPU / 效果链自检，排障用）
     - `POST /wallpaper-engine/upload` → 上传自定义壁纸（JPG / PNG / MP4，原始字节流）
     - `POST /wallpaper-engine/remove` → 移除已上传的壁纸
     - `POST /wallpaper-engine/upload-dir` → 更改上传目录（持久化到 `~/.dsh-wallpaper-engine/config.json`，自动迁移已有文件）
     - `GET /wallpaper-engine/settings` → 读取插件设置（v0.4.0）
     - `PUT /wallpaper-engine/settings` → 保存插件设置（v0.4.0，写入 `~/.dsh-wallpaper-engine/config.json`）
     - `GET /wallpaper-engine/media-info/<token>` → 媒体元数据（分辨率 / 编码 / 帧率 / 时长，moov 探测）
     - `GET /wallpaper-engine/transcoded/<token>?fps=N` → 抽帧转码流（ffmpeg 一次性重编码，磁盘缓存）
     - `GET /wallpaper-engine/transcode-progress/<token>?fps=N` → 下载 / 转码进度（进度条轮询）
- **Client 端**（`lib/client.js`）：一个浏览器模块，拉取壁纸列表，把选中壁纸渲染到应用三列**后方**的固定图层，并在「设置」里注册一个**一级设置页**「Wallpaper Engine」（含液态玻璃卡片、选择弹窗、隐藏 / 恢复、倍速 / 翻转、配色 / 透明度与自定义壁纸管理）。
- **自定义壁纸存储**：上传的文件写入插件管理的本地目录（默认 `~/.dsh-wallpaper-engine/uploads`，可在设置里改到任意盘符），经同一套 `/media`、`/preview` 路由服务（视频缩略图另走 `/video-preview`）——与 WE 媒体走完全相同的管道，天然跨重启持久、无浏览器配额限制。

> 开发相关（构建产物、热挂载规则、缓存键前缀）见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。

---

## English

### The default form for scene / web wallpapers: WebWallGL live rendering

**Scene and web wallpapers render live by default** (setting `sceneLive`, UI labels 「场景实时渲染」 /
「网页实时渲染」, on by default) — the renderer is the **upstream WebWallGL 1.4.1 page**, vendored under
`lib/webwallgl/` and mounted by the host with `/wallpaper-engine/scene-live/` as its base (asset
references resolve under that prefix); the wallpaper's own files (`scene.pkg` / web project files) are
served through `/wallpaper-engine/scene-files/`. For web wallpapers the host injects the WE API shim
(`lib/webwallgl/web-shim.js`) and the `project.json` property seed into the returned HTML — under the
strict sandbox the renderer page cannot reach into the wallpaper iframe, so the shim must ride along
with the document.

- **When live rendering is skipped**: the wallpaper switch is off, the wallpaper is in the **failure
  memory** (15 s without a first frame, or **~40 s** without a frame at runtime — one rescue `resume()`
  at 20 s), or the scene is a **loose `scene.json` directory**. It then falls back to the **out-figure
  chain** below (which is allowed to come up honestly empty).
- **Out-figure sources (the one authoritative order; code in `lib/routes/scene-frame.js`)**:
  ① live-render iframe → ② the author-embedded MP4 (`sceneVideo`) → ③ **live-captured frame**
  (`<key>_gpu.png`, PUT back by the live page once the first frame lands) → ④ **custom frame** (a
  screenshot the user imported) → ⑤ **empty state** (404 with a machine-readable reason).
  `?v=4` forces the custom frame and is **exempt** from the captured frame (an explicit pin is never
  displaced by a capture); `?v=1/2/3` are retired and clamped to 0.
- **Why there is no CPU fallback image any more (the P2-12 design decision)**: 0.6–0.7.x fell back to an
  offline scene renderer / main-texture extraction / the workshop preview image. All three could
  **"succeed" by producing a poor image** — bypassing the quality gate, caching a blurry frame, and
  turning a decidable fact ("this wallpaper has no usable picture") into something that looks like a
  normal frame. The whole line (renderer + extraction + compositor, ~10k lines) is gone; the contract
  now is **either a real picture or an honest blank** (the status row names the reason).
- **Frame rate**: 「实时渲染帧率」 (15 / 30 / 60 fps) is passed through the iframe query.
- Guards: `test/verify-scene-live.mjs` (live chain), `test/verify-scene.mjs` (out-figure chain + cache).

### Scene rendering: how it works

Scenes are rendered live by the bundled **WebWallGL engine** (vendored under `lib/webwallgl/`; it parses
`scene.pkg` / loose `scene.json` itself and replays the object tree, textures, particles and shaders,
preferring the GPU and falling back to software). `/scene-live` + `/scene-files` are its data plane.
The host contract is just two things: **feed the scene files to the render page on demand**, and **keep
the frame it captures** (③ above).

### How it works

- **Host half** (`lib/index.js`): a Cordis plugin that
  1. locates the Wallpaper Engine install by reading Steam's `libraryfolders.vdf` (so it works even when Steam is on a non-default drive),
  2. enumerates wallpapers from `projects/defaultprojects`, `projects/myprojects`, and `steamapps/workshop/content/431960/*`,
  3. registers same-origin HTTP routes on the DSH webserver so the browser half can fetch data and stream media directly:
     - `GET /wallpaper-engine/inventory` → JSON list of wallpapers
     - `GET /wallpaper-engine/media/<token>` → video / HTML (Range supported)
     - `GET /wallpaper-engine/web/<token>/<subpath>` → **sub-resources** of a web wallpaper (`main.js` / `styles.css` / `images/*`).
       A web wallpaper is a multi-file HTML app whose entry references everything relatively, and the iframe `src`
       is what decides the relative base — so the entry must be loaded through this **directory-shaped** route
       (pointing the iframe at `/media/<token>` makes every sub-resource resolve to `/media/<filename>` and 404,
       leaving the iframe empty). Resource root = the entry HTML's own directory; guard:
       `scripts/verify-web-route.mjs`（该护栏未随本线保留）
     - `GET /wallpaper-engine/preview/<token>` → preview image
     - `GET /wallpaper-engine/video-preview/<token>` → on-demand ffmpeg-extracted thumbnail for a custom MP4 upload (disk-cached)
     - `GET /wallpaper-engine/scene-live/<subpath>` → the vendored WebWallGL renderer page (`lib/webwallgl/`, mounted with `/wallpaper-engine/scene-live/` as base; the live-render iframe loads it)
     - `GET /wallpaper-engine/scene-files/<token>/<subpath>` → raw wallpaper files (`scene.pkg` / web project files, Range supported); a web wallpaper's HTML is served here with the WE shim and property seed injected
     - `GET /wallpaper-engine/scene-frame/<token>` → scene full-scene frame (in-house renderer, 3840 wide / height from the scene aspect; falls back to main-texture extraction; PNG/JPG disk-cached; `?v=` selects the frame-source tier)
     - `GET /wallpaper-engine/scene-video/<token>` → the scene's embedded MP4 (hardware-decoded playback, Range supported; 404 when the scene embeds no video, and the client falls back to the static frame)
     - `GET /wallpaper-engine/scene-audio/<token>` → the scene's packaged standalone audio (played for scenes without an embedded MP4; mutually exclusive with the embedded video's own track)
     - `GET /wallpaper-engine/scene-runtime/<token>` → scene WebGL player page (same-origin HTML; the client does not embed it by default — fallback path only)
     - `GET /wallpaper-engine/scene-manifest/<token>` → scene manifest JSON (layers / models / particles / camera, built on demand from `scene.pkg` for the player)
     - `GET /wallpaper-engine/scene-resource/<token>/<subpath>` → scene resources (textures / sprites referenced by the manifest; PNG when decodable, raw bytes otherwise)
     - `GET /wallpaper-engine/custom-frame/<token>` → the user-imported "custom frame" (frame tier 4; GET = read / POST = import / DELETE = clear)
     - `GET /wallpaper-engine/diag-log` → diagnostics log sink for the renderer page (GPU / effect-chain self-check, for troubleshooting)
     - `POST /wallpaper-engine/upload` → upload a custom wallpaper (JPG / PNG / MP4, raw bytes)
     - `POST /wallpaper-engine/remove` → remove an uploaded wallpaper
     - `POST /wallpaper-engine/upload-dir` → change the upload directory (persisted to `~/.dsh-wallpaper-engine/config.json`, migrates existing files)
     - `GET /wallpaper-engine/settings` → read plugin settings (v0.4.0)
     - `PUT /wallpaper-engine/settings` → save plugin settings (v0.4.0, written to `~/.dsh-wallpaper-engine/config.json`)
     - `GET /wallpaper-engine/media-info/<token>` → media metadata (resolution / codec / fps / duration, from a moov probe)
     - `GET /wallpaper-engine/transcoded/<token>?fps=N` → frame-skip transcode stream (one-time ffmpeg re-encode, disk-cached)
     - `GET /wallpaper-engine/transcode-progress/<token>?fps=N` → download / transcode progress (progress-bar polling)
- **Client half** (`lib/client.js`): a browser module that fetches the inventory and renders the selected
  wallpaper into a fixed layer *behind* the app columns, plus a **first-level settings page**
  "Wallpaper Engine" (liquid-glass card, picker modal, hide/restore, playback speed / flip, accent color +
  glass transparency, and custom-upload management).
- **Custom-upload storage**: uploaded files are written to a plugin-managed local directory (default
  `~/.dsh-wallpaper-engine/uploads`, changeable from the settings UI) and served through the same
  `/media` + `/preview` routes as WE media — identical pipeline, survives restarts, no browser quota limits.

> Development details (build artifacts, hot-mount rules, cache-key prefixes) live in
> [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
