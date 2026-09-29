# 工作原理 / How it works

> 本文件承接原先放在 README 首页的**实现细节**：实时渲染管线、出图来源链、宿主 / 客户端分工。
> 门面（`../README.md` / `../README.en.md`）只保留「支持哪些壁纸类型」的结论表 + 本文件链接。
> **HTTP 路由表不在本文件手写** —— 权威清单是自动生成、由守卫逐字节比对的
> [`ROUTE-INDEX.md`](./ROUTE-INDEX.md)（手写必烂：本文件曾长期列着三条早已删除的路由）。
> 渲染路线的工程决策见 [`RENDERER-FEASIBILITY.md`](./archive/static-frame/RENDERER-FEASIBILITY.md)（已归档）。
> 场景动画的旧实现（beta 场景动画 / `/scene-anim`）已随 WebWallGL 实时渲染落地而**移除**，
> 其历史记录见 [`SCENE-ANIMATION-HANDOFF.md`](./archive/scene-animation/SCENE-ANIMATION-HANDOFF.md)（已归档）。

## 中文

### 场景 / 网页壁纸的默认形态：WebWallGL 实时渲染

**scene 与 web 壁纸默认走实时渲染**（设置项 `sceneLive`，UI 文案「场景实时渲染」/「网页实时渲染」，
默认开）——渲染器是**上游 WebWallGL（版本钉在 `lib/webwallgl/.upstream.json`）的原版页面**，vendored 在 `lib/webwallgl/`，
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
  **首帧之前不留黑屏**：垫底画面按 **实时抓帧 → 作者随包发布的工程预览图 → 主题色** 取
  （`buildLivePoster`）—— 新壁纸**第一次**激活时抓帧还不存在（要等这一轮 live 回填），先由作者的
  预览图占位，live 首帧一到即被顶掉。预览图只是占位，**不会被当成"这张壁纸的出图"**。
  关掉实时渲染不会改变 ①②；`?v=4` 是"强制自定义画面"（**豁免**抓帧：显式 pin 的来源不被一张抓帧顶掉），
  `?v=1/2/3` 已退役、一律 clamp 到 0。
- **为什么没有 CPU 兜底出图（P2-12 的设计决定）**：0.6–0.7.x 曾用「离线场景渲染器 / 主纹理提取 /
  工坊预览图」三级兜底。它们的共同缺陷是**能"成功"产出一张劣质图**：绕过质量门禁、把糊帧写进缓存、
  让"这张壁纸没有可用画面"这个**可判定事实**退化成一张看似正常的画面 —— 用户看到的是"壁纸糊了"，
  而不是"它没有画面"。整条线（渲染器 + 提取链 + 合成器，约 1 万行）已随 P2-12 删除；现在的契约是
  **要么给真画面、要么明确留空**（状态行给出可判定原因）。
  ⚠️ **这条裁定管的是服务端"出图"**：`/scene-frame` 不会产出猜来的图。而客户端在**首帧前 / 空帧时
  的占位**仍会用**作者随包发布的预览图**（那是作者自己的图，不是本插件合成的）—— 它只顶到 live 首帧
  或用户导入的自定义画面出现为止。
- **帧率**：`实时渲染帧率`（15 / 30 / 60 fps）经 iframe query 下发，改档会重建图层。
- 护栏：`test/verify-scene-live.mjs`（实时链）、`test/verify-scene.mjs`（出图来源链 + 抓帧缓存）。

### 场景渲染：怎么工作的

场景由**内置的 WebWallGL 引擎**实时渲染（vendored 在 `lib/webwallgl/`；它自己解析 `scene.pkg` / 松散
`scene.json`、重放对象树 / 纹理 / 粒子 / shader，并优先走 GPU、无 GPU 时熔断回软渲染）：
在 WebGL2 里解析对象树，实时渲染全部 image 层（waterwaves / waterripple 等 shader 效果按 HLSL 转译后
在 GPU 执行）、puppet 骨骼模型、粒子系统与文本对象，并执行场景自带的 SceneScript —— 鼠标移动会驱动
视差 / 光标交互，包内音频（BGM / 音效）随「音量 / 壁纸音轨」设置播放并驱动音频反应效果。

选择器里场景卡片的**类型**徽标是「场景」；`/scene-live` + `/scene-files` 是它的数据面。宿主侧的契约
只有两条：**把场景文件按需喂给渲染页**，以及**把渲染页抓回来的帧收好**（③ 实时抓帧）。

### 网页壁纸：实现细节与已知边界

**网页壁纸**同样走 WebWallGL：宿主把 **WE API shim**（`wallpaperRegisterAudioListener` /
`wallpaperPropertyListener` / 媒体监听等，来自上游 `web-shim.js`，由 `/scene-files` 注入入口 HTML）
交给渲染页加载 —— 依赖 WE API 的工坊网页壁纸（音频可视化、属性驱动、鼠标跟随等）因此能真正跑起来，
不再是一片空白或报错。**安全**：壁纸 iframe 强制 `sandbox="allow-scripts"`（严格沙箱），第三方 HTML
拿不到 DSH 的 origin（无法冒用宿主身份调宿主 API / 读宿主存储）；跨源控制与指针注入经渲染页的
`postMessage` 通道下发。加载失败或运行失联时按壁纸记忆并自动退回旧的兼容 iframe（裸 HTML，无 WE API）。

> **载荷来源（独立媒体源）**：网页壁纸的入口 HTML 与全部子资源由宿主**自建的独立 loopback 媒体源**
> （`127.0.0.1` 上的随机端口，见 `GET /wallpaper-engine/media-origin`）提供，**不走**插件的 HTTP 路由。
> 原因：DSH Desktop 给每条插件路由都套了能力头栅栏（`x-dsh-desktop-renderer`，只注入给同源 frame 发出的
> 请求），而严格沙箱 iframe 是不透明源、永远拿不到这个头 —— 壁纸入口会一律 `403 Forbidden`（表现：预览图
> 先正常、随后整块黑）。媒体源不经过该栅栏，第三方 HTML 也因此连宿主 origin 都不沾边，沙箱之外又多一层隔离。

> **帧率上限与「卡」的排查**：网页壁纸的 rAF 上限由 shim 按**跳帧**实现 —— 每帧都与显示器 vsync 对齐、
> 只把第 n 帧交给壁纸（`setTimeout` 定时器式实现会产生 17/33/50ms 抖动，观感更差）。实时渲染期间每 5 秒
> 往诊断文件写一条 `live-fps`：`ui=` 整页帧率、`web=` 壁纸自身帧率、`rnd=` 渲染页帧率、`cap=` 当前上限 ——
> 「限了 30 还是卡」时先看这条：只有 `web` 低＝壁纸自己的开销；`ui` 也低＝整页代价（例如侧栏液态玻璃的
> `backdrop-filter` 每帧重采样壁纸，可先把模糊调小验证）。

> **已知边界**：作者脚本的 `fetch`/`XHR` 在 opaque origin 下携带 `Origin: null`（宿主已返回
> `Access-Control-Allow-Origin: *`，常规资源可用）；`wallpaperMediaIntegration`（系统 Now Playing /
> 歌曲封面）已提供数据源；CSS `:hover` 等由浏览器 hit-test 驱动的交互不受外部指针注入影响（与上游文档一致）。

### 宿主 / 客户端分工

- **Host 端**（`lib/index.js` + `lib/routes/*.js`）：一个 Cordis 插件，负责
  1. 通过读取 Steam 的 `libraryfolders.vdf` 定位 Wallpaper Engine 安装位置（所以 Steam 装在非默认盘也能用）；
  2. 从 `projects/defaultprojects`、`projects/myprojects` 以及 `steamapps/workshop/content/431960/*` 枚举壁纸；
  3. 在 DSH webserver 上注册同源 HTTP 路由，让浏览器端直接获取数据和流式加载媒体。**共 31 条**，按职责分五族：
     **素材**（inventory / media / preview / video-preview / media-info）· **转码**（transcoded /
     transcode-progress）· **实时渲染**（scene-live / scene-files / media-origin）· **出图与抓帧**
     （scene-frame / scene-frame-cache / custom-frame / live-frame）· **设置与系统**（settings / props /
     upload / remove / upload-dir / now-playing 族 / diag 族 / scene-video / scene-audio /
     api/local-assets / we-assets-dir）。
     **权威清单（含每条路由的来源行、注册形态与 context 契约）见 [`ROUTE-INDEX.md`](./ROUTE-INDEX.md)** ——
     本文件不再手写路径表（手写必烂：那张表曾长期列着 `/scene-runtime`、`/scene-manifest`、
     `/scene-resource` 三条**早已删除**的路由，还漏了当时大半的路由）。
- **Client 端**（`lib/client.js`）：一个浏览器模块，拉取壁纸列表，把选中壁纸渲染到应用三列**后方**的固定图层，并在「设置」里注册一个**一级设置页**「Wallpaper Engine」（含液态玻璃卡片、选择弹窗、隐藏 / 恢复、倍速 / 翻转、配色 / 透明度与自定义壁纸管理）。
- **自定义壁纸存储**：上传的文件写入插件管理的本地目录（默认 `~/.dsh-wallpaper-engine/uploads`，可在设置里改到任意盘符），经同一套 `/media`、`/preview` 路由服务（视频缩略图另走 `/video-preview`）——与 WE 媒体走完全相同的管道，天然跨重启持久、无浏览器配额限制。

> 开发相关（构建产物、热挂载规则、缓存键前缀）见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。

### 字体集：一整套外观住在哪

字体自定义以**一套**为单位（「字体集」）。它**不是** settings 里的一堆键，而是**文件**：

- **两层存储**：随包层 `lib/fontsets/<id>.json`（只读）+ 用户层 `<pluginDataDir>/fontsets/<id>.json`；
  同 id **用户层胜**。改随包那份会**写时复制**成用户层的一份，删掉它 = 「恢复原样」（随包那份
  重新可见）。`config.json` 只留根字段 `{ fontSetId, fontCustom }` —— 六个字体键不在 settings 的
  持久化白名单里（唯一真源是 `lib/settings-schema.js`，客户端与宿主共用同一份 kind 消毒）。
- **谁负责什么**：宿主 `lib/routes/fontsets.js` 一个 `prefix` 注册挂七个端点（列表 / 读 / 写 / 删 /
  激活 / 导入 / 导出）；客户端 `src/fontset-store.js` 是**另一条**通道（与设置平行：真源不同、键集不同、
  失败语义也不同 —— 字体集读不出来必须**整套不采用**）；`src/fontset-editor.js` 是纯渲染面板。
- **切换只有一条写原语**：`POST …/activate` 改指针，改完客户端**必须把它那份值读回来采用**（只挪指针
  界面不会变）。"使用中"的判据是**值仍与采纳时一致**，指针另作能力判定（活动集不可删）。
- **导入导出**：导出走宿主响应头 + 普通链接（桌面端 = 系统「另存为」），导入前按文件里的 `$schema`
  预检并给出具体原因。决策见账本 §9.5，过程记录见 [`archive/audits/F3-PLAN.md`](./archive/audits/F3-PLAN.md)。

### 抓帧几何校验（视口宽高比）

抓帧是「抓帧那一刻渲染页视口的构图」—— 渲染器按画布比取景（与场景设计比 2% 内 → 整张设计上屏，
否则按画布比 cover 裁切），而静态帧上屏时还要再经 CSS `object-fit: cover`。所以**在别的窗口 / 旧会话
抓的帧**拿到当前窗口上屏会被再裁一次：实测一张 1440×960（3:2）的帧在 2488×1376 视口里只显示场景设计
宽度的 84.5%（对 CPU 帧做最佳匹配拟合得到），人物比 live 大约 19% 且四周被切。因此宿主在
`HEAD /scene-frame/<token>` 上附带 `X-WE-GPU-W/H/AR`（读 PNG 的 IHDR，纯文件头，不触发提取），客户端
拿它与当前视口比对照：相对差 > 2%（与渲染器自己的 fit 容差同口径）或几何未知（旧宿主 / 文件读不出）→
**先抓帧过内容门禁，再清槽、再 PUT**（清槽在抓帧之后：抓帧失败时留下空槽会退回 CPU 帧，比留一张旧构图
的帧更糟），落地后就地重挂屏上静帧并记 `gpu-frame-stale` / `gpu-frame-recaptured` 诊断行。旧帧因此会在
下次挂载 / 轮换时自愈，不必手动清理。

### 空帧门禁与清除通道

体积阈值不可靠（headless 实测全黑 PNG：960×540≈12KB、1080p≈44KB、4K≈165KB，都远超固定字节闸），
因此抓帧前会把 canvas 降采样到 64×64 看亮度分布 —— 近全黑或几乎无对比度判为「还没渲染出画面」，直接
放弃回填（保留 CPU 帧），另加分辨率相关的体积地板（≈0.02 B/px）。抓到不满意的一帧时，在
**设置 → 效果 → 画面 → 「实时帧」**里有三个入口：**微缩预览**（就是切换途中 / live 首帧前显示的那张静帧，
与层里正在用的 URL 同源 —— 附像素尺寸）、**「重新截」**（按**当前**画面重抓一张并替换缓存；抓不到就原样
保留，原因显示在行内）、**「清除 GPU 帧」**（等价于 `DELETE /wallpaper-engine/scene-frame-cache/<token>`，
或 `POST …?clear=1` —— 删后 HEAD 回到 `X-WE-GPU: 0`、当前档位立即生效、下次 live 会重新抓取）。

> **这一行不受「场景实时渲染」开关影响**：那张实时帧正是切换壁纸途中与 live 首帧之前屏幕上显示的画面，
> 构图不对（黑帧 / 旧视口 / 切走瞬间抓的）时用户必须能**立刻重抓**，而不是先关掉实时渲染再回来。同理
> **「自定义画面」也一直显示**（导入截图与实时渲染互不干扰）。只有**「出图来源」**（换抓帧档位）在
> 实时渲染生效时隐藏 —— 那时换档位不会生效，摆出来只会误导。

### 遮挡暂停：判定**不只靠事件**

「最小化 / 切页时暂停」「窗口失焦时暂停」「电池供电时暂停」三项（设置 → 效果 → 省电）都由
`occlusionReason()` 一处判定，再经 `emit()` → `syncLayers()` 落到视频的 play/pause。判定最初只由
`visibilitychange` / `blur` / `focus` 事件驱动 —— 这有一个**原生模态**造成的漏洞：`window.confirm` /
`alert` 会把焦点交给它自己的窗口，而**回来时的 `focus` 事件不保证送达**。于是判定永久停在
「窗口失焦」：壁纸停住、判定也不会再变（真机形态是"确认弹窗之后壁纸不播了、只剩重载能救"）。

现在事件之外还有一次**低频复核**（`OCCLUSION_RECHECK_MS = 3000`）：只在判定**变了**的时候
`emit()` 并写一行 `play-state … occlusion-recheck` 诊断 —— 所以常态零代价，而"事件丢了、复核补上"
这件事在诊断缓冲里看得见（这是事后排查唯一能依赖的痕迹）。

> 破坏性操作的确认因此**不用原生对话框**：字体集的删除走**面板内**确认（点一次"待确认"、再点"确认"）。
> `src/**` 里还剩 4 处 `window.confirm`（轮播列表 / 隐藏壁纸 / 移除自定义画面 / 恢复已隐藏），
> 它们同样会抢焦点 —— `verify-fontset` 里有一条棘轮只许它们减少。

### 客户端异常也留痕（`client-error`）

面板是 React 渲染的，一次渲染期异常会让整块界面白掉，而**这台机器打不开 DevTools** ⇒ 诊断缓冲里
什么都没有、只剩"UI 崩了"这句转述。因此客户端挂了两个监听器（`error` / `unhandledrejection`），
把异常的消息与栈前三行写进同一条诊断通道（`[we-live …] client-error · …`，级别 `error`，随 fiber 注销）。
标签是 `client-error`：排查时先 `Select-String 'client-error' diag/http.jsonl`，有栈就能直接定位。

### 测试

`npm run verify`（24 条链，含 client / 转码 / 播放控制 / scene / scene-live）+ `npm run smoke`
（轮换、轮换-live 节点级领养、轮换准备期零驻留、GPU 回填抓帧、抓帧身份校验五套冒烟）—— 所有断言都有
失败通道（不通过即非零退出），`npm run verify:all` = 构建 + 两套全跑。

---

## English

### The default form for scene / web wallpapers: WebWallGL live rendering

**Scene and web wallpapers render live by default** (setting `sceneLive`, UI labels 「场景实时渲染」 /
「网页实时渲染」, on by default) — the renderer is the **upstream WebWallGL page** (version pinned in `lib/webwallgl/.upstream.json`), vendored under
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
  **No black screen before the first frame**: the placeholder still is chosen as **live-captured frame →
  the author's packaged project preview → the theme colour** (`buildLivePoster`) — on a wallpaper's
  **first** activation the captured frame does not exist yet (this live session has to backfill it), so
  the author's preview stands in and is displaced the moment the live first frame lands. It is only a
  placeholder and is **never treated as "this wallpaper's out-figure"**.
  `?v=4` forces the custom frame and is **exempt** from the captured frame (an explicit pin is never
  displaced by a capture); `?v=1/2/3` are retired and clamped to 0.
- **Why there is no CPU fallback image any more (the P2-12 design decision)**: 0.6–0.7.x fell back to an
  offline scene renderer / main-texture extraction / the workshop preview image. All three could
  **"succeed" by producing a poor image** — bypassing the quality gate, caching a blurry frame, and
  turning a decidable fact ("this wallpaper has no usable picture") into something that looks like a
  normal frame. The whole line (renderer + extraction + compositor, ~10k lines) is gone; the contract
  now is **either a real picture or an honest blank** (the status row names the reason).
  ⚠️ **That ruling governs the server-side "out-figure"**: `/scene-frame` never produces a guessed
  image. The client's **pre-first-frame / empty-frame placeholder** still uses the **author's packaged
  preview** (the author's own image, not one this plugin synthesised) — it only holds until the live
  first frame or a user-imported custom frame appears.
- **Frame rate**: 「实时渲染帧率」 (15 / 30 / 60 fps) is passed through the iframe query.
- Guards: `test/verify-scene-live.mjs` (live chain), `test/verify-scene.mjs` (out-figure chain + cache).

### Scene rendering: how it works

Scenes are rendered live by the bundled **WebWallGL engine** (vendored under `lib/webwallgl/`; it parses
`scene.pkg` / loose `scene.json` itself and replays the object tree, textures, particles and shaders,
preferring the GPU and falling back to software): in WebGL2 it renders every image layer in real time
(shader effects such as waterwaves / waterripple translated from HLSL and executed on the GPU), puppet
skeletal models, particle systems and text objects, and runs the scene's own SceneScript — mouse
movement drives parallax / cursor interaction, and packaged audio (BGM / SFX) plays under the shared
volume / audio-switch settings and drives the audio-reactive effects.

The scene card's **type** badge in the picker reads 「场景」; `/scene-live` + `/scene-files` are its data
plane. The host contract is just two things: **feed the scene files to the render page on demand**, and
**keep the frame it captures** (③ above).

### Web wallpapers: implementation details & known limits

**Web wallpapers** go through WebWallGL too: the host injects the **WE API shim**
(`wallpaperRegisterAudioListener` / `wallpaperPropertyListener` / media listeners, from upstream
`web-shim.js`, injected into the entry HTML by `/scene-files`) and hands the page to the renderer — so
workshop web wallpapers that depend on the WE API (audio visualizers, property-driven and
pointer-tracking pages) actually run instead of rendering blank or erroring. **Security**: the wallpaper
iframe is forced into `sandbox="allow-scripts"` (strict sandbox) so the third-party HTML can never
inherit the DSH origin (it cannot call host APIs or read host storage as the app). Cross-origin control
and pointer injection go through the renderer page's `postMessage` channel. On load failure or a stalled
runtime the wallpaper is remembered and degrades to the legacy plain iframe (no WE API).

> **Payload origin (separate media origin)**: a web wallpaper's entry HTML and all of its subresources are
> served by a **dedicated loopback media origin the host opens itself** (a random port on `127.0.0.1`,
> reported by `GET /wallpaper-engine/media-origin`) — *not* by the plugin's HTTP routes. Why: DSH Desktop
> wraps every plugin route in a capability-header fence (`x-dsh-desktop-renderer`, injected only into
> requests issued by same-origin frames), and a strict-sandbox iframe is an opaque origin that can never
> carry that header — the wallpaper entry would always answer `403 Forbidden` (symptom: the preview frame
> looks fine, then the wallpaper goes fully black). The media origin bypasses that fence, and third-party
> HTML no longer shares the host origin at all, so the sandbox gets a second layer of isolation.

> **Frame cap and "it still stutters"**: the wallpaper's rAF cap is implemented by **frame skipping** —
> every vsync is kept so the delivered frame stays phase-aligned with the display and only every n-th
> frame reaches the page (a `setTimeout`-based cap yields 17/33/50 ms jitter, which looks worse). While
> live, a `live-fps` line is written to the diagnostics file every 5 s: `ui=` whole-page fps, `web=` the
> wallpaper's own fps, `rnd=` renderer-page fps, `cap=` the current cap. If it still feels heavy, that
> line tells you whether the wallpaper itself is slow (`web` low) or the whole page is (`ui` low too —
> e.g. the sidebar's `backdrop-filter` re-sampling the wallpaper every frame; try lowering the blur to
> confirm).

> **Known limits**: author `fetch`/`XHR` carries `Origin: null` under the opaque origin (the host answers
> with `Access-Control-Allow-Origin: *`, so ordinary resources load); `wallpaperMediaIntegration` (system
> Now Playing / cover art) **is** supplied by the host; CSS `:hover` interaction driven by the browser's
> own hit-test cannot be triggered by external pointer injection (as documented upstream).

### Host / client split

- **Host half** (`lib/index.js` + `lib/routes/*.js`): a Cordis plugin that
  1. locates the Wallpaper Engine install by reading Steam's `libraryfolders.vdf` (so it works even when Steam is on a non-default drive),
  2. enumerates wallpapers from `projects/defaultprojects`, `projects/myprojects`, and `steamapps/workshop/content/431960/*`,
  3. registers same-origin HTTP routes on the DSH webserver so the browser half can fetch data and stream media directly. There are **31** of them in five families: **assets** (inventory / media / preview / video-preview / media-info) · **transcode** (transcoded / transcode-progress) · **live rendering** (scene-live / scene-files / media-origin) · **out-figure & capture** (scene-frame / scene-frame-cache / custom-frame / live-frame) · **settings & system** (settings / props / upload / remove / upload-dir / the now-playing family / the diag family / scene-video / scene-audio / api/local-assets / we-assets-dir).
     **The authoritative list (each route's source line, registration shape and context contract) is [`ROUTE-INDEX.md`](./ROUTE-INDEX.md)** — this file no longer hand-writes the path table (hand-writing always rots: that table long listed `/scene-runtime`, `/scene-manifest` and `/scene-resource`, **all three deleted**, while missing most of the routes that existed).
- **Client half** (`lib/client.js`): a browser module that fetches the inventory and renders the selected
  wallpaper into a fixed layer *behind* the app columns, plus a **first-level settings page**
  "Wallpaper Engine" (liquid-glass card, picker modal, hide/restore, playback speed / flip, accent color +
  glass transparency, and custom-upload management).
- **Custom-upload storage**: uploaded files are written to a plugin-managed local directory (default
  `~/.dsh-wallpaper-engine/uploads`, changeable from the settings UI) and served through the same
  `/media` + `/preview` routes as WE media — identical pipeline, survives restarts, no browser quota limits.

> Development details (build artifacts, hot-mount rules, cache-key prefixes) live in
> [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

### Captured-frame geometry validation (viewport aspect ratio)

A captured frame is "the composition of the renderer viewport at the moment of capture" — the renderer
frames by canvas ratio (within 2 % of the scene's design ratio it shows the whole design, otherwise it
covers by canvas ratio), and the frame is then laid out through CSS `object-fit: cover` again. So a frame
captured in **another window / an older session** gets cropped a second time on screen: measured, a
1440×960 (3:2) frame in a 2488×1376 viewport shows only 84.5 % of the scene's design width (from a
best-match fit against a CPU frame), with subjects ~19 % larger than live and cut off on all sides. The
host therefore attaches `X-WE-GPU-W/H/AR` to `HEAD /scene-frame/<token>` (read from the PNG's IHDR, pure
file header, no extraction), and the client compares it with the current viewport: a relative difference
> 2 % (the same tolerance the renderer uses for its own fit) or an unknown geometry (old host / unreadable
file) triggers **capture → content gate → clear the slot → PUT** (clearing after capturing, because a
capture failure that left an empty slot would fall back to a CPU frame — worse than keeping an
old-composition frame). Once stored, the still frame is re-mounted in place and a `gpu-frame-stale` /
`gpu-frame-recaptured` diagnostics line is written. Old frames therefore heal themselves on the next
mount / rotation; no manual cleanup is needed.

### Empty-frame gate & clear channels

A byte-size threshold is unreliable (measured black PNGs from a headless run: 960×540 ≈ 12 KB,
1080p ≈ 44 KB, 4K ≈ 165 KB — all far above any fixed gate), so before storing a capture the canvas is
downsampled to 64×64 and its brightness distribution inspected: near-black or almost no contrast means
"nothing has been rendered yet" and the capture is abandoned (the CPU frame stays), plus a
resolution-scaled size floor (≈0.02 B/px). When a capture is unsatisfactory there are three entries under
**Settings → Effects → Picture → 「实时帧」**: the **thumbnail preview** (the very still shown during a
switch / before the live first frame, same URL as the one in use — with its pixel dimensions),
**「重新截」** (re-capture the **current** picture and replace the cache; if it fails the old frame stays,
with the reason shown inline), and **「清除 GPU 帧」** (equivalent to
`DELETE /wallpaper-engine/scene-frame-cache/<token>`, or `POST …?clear=1` — afterwards HEAD reports
`X-WE-GPU: 0`, the current tier takes effect immediately, and the next live session captures again).

> **This row is not gated on the live-rendering switch**: that live frame is exactly what is on screen
> during a switch and before the live first frame, so a wrong composition (black frame / old viewport /
> captured mid-transition) must be re-capturable **immediately** rather than after turning live rendering
> off and back on. By the same argument **「自定义画面」 is always shown** (an imported screenshot and live
> rendering do not interfere). Only **「出图来源」** (switching capture tiers) is hidden while live
> rendering is effective — changing tiers has no effect then, so showing it would only mislead.

### Tests

`npm run verify` (24 chain entries, including client / transcode / playback controls / scene / scene-live) plus
`npm run smoke` (five smokes: rotation, rotation live node-level adoption, zero leftovers during rotation
preparation, GPU frame backfill, capture identity). Every assertion has a failure channel (a non-zero exit
when it does not hold); `npm run verify:all` = build + both suites.
