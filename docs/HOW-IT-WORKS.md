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
  目录**（没有 `scene.pkg` 可供渲染页拉取）。此时按下面的静态帧链出图。重新打开开关会清空失败记忆
  （显式重试入口）。
- **完整显示优先级（代码事实，见 `buildMedia`）**：
  ① 实时渲染 iframe（垫底图 = **缓存里的静态帧**，见下）→ ② 场景**作者内嵌 MP4**（`sceneVideo`，硬件解码
  `<video>`；**排在静态帧之前，且不受「静态帧渲染」开关影响**）→ ③ 静态帧（`/scene-frame`，
  自研渲染器；失败回退 ④ 主纹理提取）→ ⑤ 作者预览图 / 已导入的「自定义画面」。
  关掉「静态帧渲染」不会改变 ①②，只把 ③ 槽位换成档 4 自定义画面 / 档 3 作者预览图，并停止空闲预热。
- **实时渲染期间的画面连续性（静态帧降级为"缓存兜底"）**：垫底图只在静态帧**已经在缓存里**时才摆 ——
  客户端用 `?cached=1` 请求 `/scene-frame`，宿主**只命中、绝不渲染**，未命中直接 404，客户端把垫底图摘掉留空
  （**首次加载可以为空**：宁可牺牲它，也不为一张过渡图跑 4K 冷渲染去和实时渲染的首帧抢 CPU/GPU —— 那会导致
  卡顿、首帧超时降级并写进失败记忆、以及黑屏）。作者预览图不再当垫底（画质太差）；实时渲染关掉（`sceneLive === false`）
  或该壁纸已判失败时才回到"静态帧就是显示形态"的旧口径。对应地，宿主「空闲预热」的定位也变成**为切换 / 轮换攒缓存**：
  实时渲染流量（`/scene-live` + `/scene-files`）算用户活动 ⇒ 预热自动推迟到动画起来之后；当前**正在实时渲染**的那张
  **不进预热名单**（它的帧此刻最没必要算）。
- **帧率**：`实时渲染帧率`（15 / 30 / 60 fps）经 iframe query 下发，改档会重建图层。
- 护栏：`scripts/verify-scene-live.mjs`。

### 场景渲染器（静态帧链 / 实时渲染不可用时的回退）

Scene 壁纸的 3D 场景由本插件内置的**自研场景渲染器**（入口 `lib/scene-renderer.js` 只是 9 行
re-export 壳，实现主体在 `lib/we-renderer/core.js` 及其子模块；参考
linux-wallpaperengine / repkg 逆向成果）完整重放：解析 `scene.pkg` 的对象树，渲染全部 image 层
（含 waterwaves / waterripple / shake 等 shader 效果的 CPU 实现）、puppet 骨骼网格（绑定姿态）、
以及粒子系统（发射器 / 初始化器 / 运算符 / 精灵绘制）。效果链可用「GPU 渲染加速」切到 WebGL 执行
（无 GPU 时自身熔断回 CPU，两套产物不共用缓存）。选择器里场景卡片的**类型**徽标是「场景」，
另有**形态**徽标显示当前走哪条路（实时渲染 / 静态帧）。

> **展现效果**：渲染器输出 **3840 宽**（高度按场景比例推导，16:9 场景即 2160）的完整场景帧（背景 + 水 +
> 后发 + 人物 + 伞 + 粒子），对摄影、
> 插画、动画截图类场景壁纸效果接近原版；渲染失败（纯 shader 生成类 / 特殊纹理格式）时自动回退旧的
> 主纹理提取，再失败回退工坊预览图（`preview.jpg`），属预期行为，不视为缺陷。

### 场景渲染：怎么工作的

- **对象树**：解析 `scene.pkg`（PKGV 容器 + LZ4 条目链）或松散 `scene.json` 目录，按 dependencies/parent 拓扑排序全部对象（image / particle / text / sound）。
- **image 层**：加载材质主纹理（RGBA8888 / DXT1/3/5 等），按 scene 坐标定位（origin/scale/angle 父链累积），应用 alpha/brightness。
- **puppet 网格**：MDL（MDLV）网格 + 绑定姿态光栅化（软件光栅 + 双线性 UV 采样 + 透明合成），人物 / 后发等骨骼模型正确显示。
- **shader 效果链**：waterwaves（含 DUALWAVES 双波乘积）/ waterripple / shake 按 shader 精确数学在 CPU 实现；mask 纹理支持。
- **粒子系统**：boxrandom / sphererandom 发射器、color/size/alpha/lifetime/velocity/rotation 等初始化器、movement/alphafade/sizechange/turbulence/oscillate* 等运算符、sprite 精灵绘制。
- **缓存**：渲染结果按 `sf45_<gpu 标志><来源标志>_<base64url(路径)>_<mtime>[_vN]` 缓存到 `~/.dsh-wallpaper-engine/cache/frames/`（可用 `DSH_WE_CACHE_DIR` 覆盖），工坊更新后自动失效重建；**冷缓存首次渲染实测约 2–10 秒**（视场景图层数；同机实测见 [`SCENE-FRAME-PERF.md`](./archive/static-frame/SCENE-FRAME-PERF.md)），之后秒级命中。

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

- **When live rendering is skipped**: the wallpaper's switch is off, the wallpaper has been recorded in
  the **failure memory** (15 s without a first frame; or **~40 s** without a frame at runtime — the
  heartbeat ticks once per second and issues one rescue `resume()` at 20 s), or the scene is a **loose
  `scene.json` directory** (no `scene.pkg` for the renderer page to fetch). It then falls back to the
  static-frame chain below. Re-enabling the switch clears the failure memory (explicit retry entry point).
- **Full display priority (code fact, see `buildMedia`)**:
  ① the live-render iframe (poster = **a cached static frame**, see below) → ② the scene's **author-embedded MP4**
  (`sceneVideo`, hardware-decoded `<video>`; **it outranks the static frame and is unaffected by the
  「静态帧渲染」 switch**) → ③ the static frame (`/scene-frame`, in-house renderer; on failure ④
  main-texture extraction) → ⑤ the author's preview image / an imported 「自定义画面」.
  Turning the 「静态帧渲染」 switch off does not change ①② — it only replaces slot ③ with tier 4
  (custom frame) or tier 3 (author preview) and stops idle prewarming.
- **Continuity during live rendering (the static frame is now a *cache fallback*)**: a poster is shown only
  when the static frame **is already cached** — the client requests `/scene-frame?cached=1`, the host
  **answers from the cache and never renders**, and a miss returns 404 so the client drops the poster and
  stays blank (**a blank first load is the accepted trade-off**: never run a cold 4K render for a merely
  transitional image while live rendering is starting — that steals CPU/GPU from the first frame, which
  produced stutter, watchdog degradation into the failure memory, and black screens). The author's preview
  image is no longer used as a poster (quality too low). The old rule — "the static frame *is* the display
  form" — applies again only when live rendering is off (`sceneLive === false`) or that wallpaper has
  already failed. Accordingly the host's 「空闲预热」 now exists to **build the cache for switching /
  rotation**: live-rendering traffic (`/scene-live` + `/scene-files`) counts as user activity, so prewarming
  is pushed back until the animation is already up, and the wallpaper currently being **live-rendered** is
  **excluded from the prewarm candidate list** (its frame is the least useful one to compute right now).
- **Frame rate**: 「实时渲染帧率」 (15 / 30 / 60 fps) is passed through the iframe query; changing it
  rebuilds the layer.
- Guard: `scripts/verify-scene-live.mjs`.

### The scene renderer (static-frame chain / fallback when live rendering is unavailable)

A Scene wallpaper's 3D scene is fully replayed by the plugin's **in-house scene renderer**
(`lib/scene-renderer.js` is a 9-line re-export shell; the implementation body lives in
`lib/we-renderer/core.js` and its submodules — built from linux-wallpaperengine / repkg
reverse-engineering): it parses
`scene.pkg`'s object tree and renders every image layer (with CPU implementations of shader effects
like waterwaves / waterripple / shake), the puppet skeletal meshes (bind pose), and the particle
systems (emitters / initializers / operators / sprite drawing). Scene cards carry a 「场景」 type badge in
the picker.

> **Expected result**: the renderer outputs a **3840-wide** full-scene frame (height derived from the
> scene aspect — 2160 for a 16:9 scene) containing background + water + back
> hair + character + umbrella + particles, close to the original for photographic, illustration and
> animation-screenshot scenes. On failure (pure shader/procedural scenes, exotic texture formats) it
> falls back to the older main-texture extractor, then to the workshop preview image (`preview.jpg`) —
> expected behaviour, not a defect.

### Scene rendering: how it works

- **Object tree**: parses `scene.pkg` (PKGV container + LZ4 entry chains) or a loose `scene.json`
  directory, topologically sorts every object (image / particle / text / sound) by dependencies / parent.
- **image layers**: loads the material main textures (RGBA8888 / DXT1/3/5 …), positions them in scene
  coordinates (origin / scale / angle accumulated down the parent chain), and applies alpha / brightness.
- **puppet meshes**: MDL (MDLV) mesh + bind-pose rasterization (software raster + bilinear UV sampling +
  alpha compositing), so skeletal models like the character / back hair display correctly.
- **shader effect chain**: waterwaves (incl. the dual-wave DUALWAVES product) / waterripple / shake are
  implemented in the CPU with the exact shader math; mask textures are supported.
- **particle systems**: boxrandom / sphererandom emitters, color / size / alpha / lifetime / velocity /
  rotation initializers, movement / alphafade / sizechange / turbulence / oscillate* operators, and
  sprite drawing.
- **Cache**: results are cached at `~/.dsh-wallpaper-engine/cache/frames/` keyed by
  `sf45_<gpu-flag><source-flag>_<base64url(abs path)>_<mtime>[_vN]` (override with `DSH_WE_CACHE_DIR`);
  workshop updates and renderer upgrades
  invalidate the frame automatically. A cold-cache first render measures **~2–10 s** (depends on the
  scene's layer count; same-machine measurements in [`SCENE-FRAME-PERF.md`](./archive/static-frame/SCENE-FRAME-PERF.md)),
  then near-instant on cache hit.

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
