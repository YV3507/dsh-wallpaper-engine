# 宿主路由索引（P2-11 前置 1 · 自动生成，勿手改）

> 生成：`node scripts/host-route-index.mjs --write`；核对：`node scripts/verify-route-index.mjs`
> （守卫会在索引与代码不一致时失败 —— 索引因此不会烂掉）。
>
> **依赖** = 该处理器块里引用到的 `apply` 作用域声明（缩进 ≤2）= **将来 context 对象的字段候选**；
> 同一列里反复出现的名字，就是该提出来的字段。拆到 `lib/routes/*.js` 的族则列它的 **`c` 字段**。
> 循环里注册的路由（`for (const seg of [...])`）按**实际条数**逐条列出，不折叠成一行。
> 路径列省略 `${BASE}` 前缀；因此**看起来同名的两行**是同一路径同时挂了根路径与带前缀
> 两条注册（渲染页按根路径上报，只挂一条会静默 404）。提及判定带尾边界，`/media` 不会被
> `/media-info` 误算成已覆盖。

共 **31** 条路由。

| # | 路径 | 来源 | 形态 | 依赖（闭包状态 / `c` 字段） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `/inventory` | lib/index.js:2803 | async 箭头 | webServer buildInventory disposers | 8 |
| 2 | `/media-info` | lib/index.js:2905 | 箭头 | webServer mediaMap disposers | 7 |
| 3 | `/transcode-progress` | lib/index.js:2931 | 箭头 | webServer mediaMap disposers | 1 |
| 4 | `/transcoded` | lib/index.js:2984 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 5 | `/media` | lib/index.js:3040 | 箭头 | webServer mediaMap disposers serveFile | 10 |
| 6 | `/preview` | lib/index.js:3040 | 箭头 | webServer mediaMap disposers serveFile | 7 |
| 7 | `/video-preview` | lib/index.js:3064 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 8 | `/scene-frame` | lib/index.js:3104 | 箭头 | webServer mediaMap disposers trackStream | 8 |
| 9 | `/scene-frame-cache` | lib/index.js:3246 | 箭头 | webServer mediaMap disposers | 4 |
| 10 | `/scene-live` | lib/index.js:3338 | 箭头 | webServer disposers serveFile | 5 |
| 11 | `/scene-files` | lib/index.js:3461 | 箭头 | webServer disposers handleSceneFiles | 4 |
| 12 | `/media-origin` | lib/index.js:3533 | 箭头 | webServer disposers mediaOrigin mediaOriginBase | 1 |
| 13 | `/props` | lib/index.js:3549 | 箭头 | webServer mediaMap disposers | 2 |
| 14 | `/live-frame` | lib/index.js:3595 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 15 | `/media-status` | lib/index.js:3678 | 箭头 | webServer disposers ensureMedia | 2 |
| 16 | `/audio-spectrum` | lib/index.js:3688 | 箭头 | webServer disposers mediaBackend ensureMedia | 2 |
| 17 | `/now-playing` | lib/index.js:3707 | 箭头 | webServer disposers mediaBackend ensureMedia | 2 |
| 18 | `/now-playing/artwork` | lib/index.js:3721 | 箭头 | webServer disposers serveFile mediaBackend | 1 |
| 19 | `/client-diag` | lib/routes/diag.js:29 | 箭头 | disposers appendDiagLine base | 1 |
| 20 | `/diag` | lib/routes/diag.js:90 | 箭头 | disposers | 5 |
| 21 | `/diag` | lib/routes/diag.js:91 | 箭头 | disposers base | 5 |
| 22 | `/diag-log` | lib/routes/diag.js:92 | 箭头 | disposers base | 1 |
| 23 | `/api/local-assets` | lib/index.js:3748 | async 箭头 | webServer disposers serveFile | 1 |
| 24 | `/we-assets-dir` | lib/index.js:3798 | 箭头 | webServer disposers | 1 |
| 25 | `/scene-video` | lib/index.js:3851 | 箭头 | webServer mediaMap disposers serveFile SCENE_VIDEO_INFLIGHT | 1 |
| 26 | `/scene-audio` | lib/index.js:3934 | 箭头 | webServer mediaMap disposers serveFile | 2 |
| 27 | `/custom-frame` | lib/index.js:3970 | 箭头 | webServer disposers serveFile | 1 |
| 28 | `/upload` | lib/index.js:4056 | 箭头 | webServer tokenFor disposers | 1 |
| 29 | `/remove` | lib/index.js:4204 | 箭头 | webServer disposers | 1 |
| 30 | `/upload-dir` | lib/index.js:4248 | 箭头 | webServer disposers | 1 |
| 31 | `/settings` | lib/index.js:4309 | 箭头 | webServer disposers SETTINGS_MAX_BYTES | 11 |

**零提及（拆分前必须先补守卫）**：（无）

**被最多路由引用的闭包状态（context 字段优先级，仅 `lib/index.js` 内的路由）**：

`webServer`×27 · `disposers`×27 · `mediaMap`×12 · `serveFile`×11 · `ensureMedia`×3 · `mediaBackend`×3 · `buildInventory`×1 · `trackStream`×1 · `handleSceneFiles`×1 · `mediaOrigin`×1 · `mediaOriginBase`×1 · `SCENE_VIDEO_INFLIGHT`×1

**路由模块的 context 契约**（声明了却没用到的字段单独标出 —— 那是死声明）：

| 模块 | 入口 | 路由数 | `c` 字段 | 死声明 |
|---|---|---|---|---|
| `lib/routes/diag.js` | `registerDiagRoutes(webServer, c)` | 4 | `disposers` `appendDiagLine` `base` | — |

