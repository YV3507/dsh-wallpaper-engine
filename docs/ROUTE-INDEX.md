# 宿主路由索引（P2-11 前置 1 · 自动生成，勿手改）

> 生成：`node test/tools/host-route-index.mjs --write`；核对：`node test/verify-route-index.mjs`
> （守卫会在索引与代码不一致时失败 —— 索引因此不会烂掉）。
>
> **依赖** = 该处理器块里引用到的 `apply` 作用域声明（缩进 ≤2）= **将来 context 对象的字段候选**；
> 同一列里反复出现的名字，就是该提出来的字段。拆到 `lib/routes/*.js` 的族则列它的 **`c` 字段**。
> 循环里注册的路由（`for (const seg of [...])`）按**实际条数**逐条列出，不折叠成一行。
> 路径列省略 `${BASE}` 前缀；因此**看起来同名的两行**是同一路径同时挂了根路径与带前缀
> 两条注册（渲染页按根路径上报，只挂一条会静默 404）。提及判定带尾边界，`/media` 不会被
> `/media-info` 误算成已覆盖。

共 **33** 条路由。

| # | 路径 | 来源 | 形态 | 依赖（闭包状态 / `c` 字段） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `/inventory` | lib/index.js:2801 | async 箭头 | webServer buildInventory disposers observeAdapter | 13 |
| 2 | `/media-info` | lib/index.js:2941 | 箭头 | webServer mediaMap disposers | 7 |
| 3 | `/transcode-progress` | lib/index.js:2967 | 箭头 | webServer mediaMap disposers | 1 |
| 4 | `/transcoded` | lib/index.js:3020 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 5 | `/media` | lib/index.js:3076 | 箭头 | webServer mediaMap disposers serveFile | 16 |
| 6 | `/preview` | lib/index.js:3076 | 箭头 | webServer mediaMap disposers serveFile | 8 |
| 7 | `/video-preview` | lib/index.js:3100 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 8 | `/scene-frame` | lib/routes/scene-frame.js:57 | 箭头 | disposers base mediaMap trackStream customFramePath customIdFromAbs …(+3) | 10 |
| 9 | `/scene-frame-cache` | lib/routes/scene-frame.js:134 | 箭头 | disposers base mediaMap GPU_FRAME_MAX_BYTES GPU_WRITE_INFLIGHT armBodyIdleTimeout …(+4) | 4 |
| 10 | `/custom-frame` | lib/routes/scene-frame.js:221 | 箭头 | disposers base serveFile CUSTOM_FRAME_EXT CUSTOM_FRAME_MAX_BYTES armBodyIdleTimeout …(+3) | 1 |
| 11 | `/scene-live` | lib/routes/scene-serve.js:53 | 箭头 | disposers base WEBWALLGL_DIR appendDiagLine traceRequests serveFile …(+1) | 7 |
| 12 | `/scene-files` | lib/routes/scene-serve.js:87 | 箭头 | disposers base handleSceneFiles | 5 |
| 13 | `/media-origin` | lib/routes/scene-serve.js:95 | 箭头 | disposers base mediaOriginInfo | 1 |
| 14 | `/scene-payload-progress` | lib/routes/scene-serve.js:115 | 箭头 | disposers base payloadProgress | 1 |
| 15 | `/props` | lib/index.js:3443 | 箭头 | webServer mediaMap disposers | 4 |
| 16 | `/live-frame` | lib/index.js:3489 | 箭头 | webServer mediaMap disposers serveFile | 2 |
| 17 | `/media-status` | lib/routes/now-playing.js:69 | 箭头 | disposers base | 2 |
| 18 | `/audio-spectrum` | lib/routes/now-playing.js:79 | 箭头 | disposers base | 2 |
| 19 | `/now-playing` | lib/routes/now-playing.js:98 | 箭头 | disposers base | 2 |
| 20 | `/now-playing/artwork` | lib/routes/now-playing.js:112 | 箭头 | disposers base serveFile | 1 |
| 21 | `/client-diag` | lib/routes/diag.js:74 | 箭头 | disposers appendDiagLine notice base | 2 |
| 22 | `/diag` | lib/routes/diag.js:140 | 箭头 | disposers | 8 |
| 23 | `/diag` | lib/routes/diag.js:141 | 箭头 | disposers base | 8 |
| 24 | `/diag-log` | lib/routes/diag.js:142 | 箭头 | disposers log base | 2 |
| 25 | `/api/local-assets` | lib/index.js:3575 | async 箭头 | webServer disposers serveFile | 1 |
| 26 | `/we-assets-dir` | lib/index.js:3625 | 箭头 | webServer disposers | 2 |
| 27 | `/scene-video` | lib/index.js:3678 | 箭头 | webServer mediaMap disposers serveFile SCENE_VIDEO_INFLIGHT | 1 |
| 28 | `/scene-audio` | lib/index.js:3761 | 箭头 | webServer mediaMap disposers serveFile | 2 |
| 29 | `/upload` | lib/routes/upload.js:55 | 箭头 | disposers base tokenFor UPLOAD_EXT UPLOAD_MAX_BYTES ensureUploadDir …(+6) | 3 |
| 30 | `/remove` | lib/routes/upload.js:203 | 箭头 | disposers base ensureUploadDir removeUploadMeta resolveUploadFile armBodyIdleTimeout | 1 |
| 31 | `/upload-dir` | lib/routes/upload.js:247 | 箭头 | disposers base setUploadDir normalizeUserDir | 2 |
| 32 | `/fontsets` | lib/routes/fontsets.js:245 | async 箭头 | disposers base readFontSetId | 5 |
| 33 | `/settings` | lib/index.js:3818 | 箭头 | webServer disposers adapterFenceSeen adapterOverride observeAdapter adapterDetectedTarget …(+1) | 16 |

**零提及（拆分前必须先补守卫）**：（无）

**被最多路由引用的闭包状态（context 字段优先级，仅 `lib/index.js` 内的路由）**：

`webServer`×14 · `disposers`×14 · `mediaMap`×10 · `serveFile`×8 · `observeAdapter`×2 · `buildInventory`×1 · `SCENE_VIDEO_INFLIGHT`×1 · `adapterFenceSeen`×1 · `adapterOverride`×1 · `adapterDetectedTarget`×1 · `SETTINGS_MAX_BYTES`×1

**路由模块的 context 契约**（声明了却没用到的字段单独标出 —— 那是死声明）：

| 模块 | 入口 | 路由数 | `c` 字段 | 死声明 |
|---|---|---|---|---|
| `lib/routes/diag.js` | `registerDiagRoutes(webServer, c)` | 4 | `disposers` `appendDiagLine` `log` `notice` `base` `onHandleDiag` | — |
| `lib/routes/fontsets.js` | `registerFontsetsRoutes(webServer, c)` | 1 | `disposers` `base` `readFontSetId` | — |
| `lib/routes/now-playing.js` | `registerNowPlayingRoutes(webServer, c)` | 4 | `disposers` `base` `appendDiagLine` `configPath` `readConfig` `serveFile` `log` | — |
| `lib/routes/scene-frame.js` | `registerSceneFrameRoutes(webServer, c)` | 3 | `disposers` `base` `mediaMap` `trackStream` `serveFile` `GPU_FRAME_MAX_BYTES` `GPU_WRITE_INFLIGHT` `CUSTOM_FRAME_EXT` `CUSTOM_FRAME_MAX_BYTES` `armBodyIdleTimeout` `atomicWriteFileP` `customFrameDir` `customFramePath` `customIdFromAbs` `gpuFrameFileFor` `lingerClose` `looksLikePng` `pngSizeOf` `sceneFrameSlot` | — |
| `lib/routes/scene-serve.js` | `registerSceneServeRoutes(webServer, c)` | 4 | `disposers` `base` `WEBWALLGL_DIR` `appendDiagLine` `traceRequests` `serveFile` `handleSceneFiles` `mediaOriginInfo` `payloadProgress` `log` | — |
| `lib/routes/upload.js` | `registerUploadRoutes(webServer, c)` | 3 | `disposers` `base` `tokenFor` `UPLOAD_EXT` `UPLOAD_MAX_BYTES` `ensureUploadDir` `readUploadMeta` `metaEntry` `setUploadMeta` `removeUploadMeta` `resolveUploadFile` `setUploadDir` `normalizeUserDir` `armBodyIdleTimeout` `lingerClose` | — |

