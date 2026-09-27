# 宿主路由索引（P2-11 前置 1 · 自动生成，勿手改）

> 生成：`node scripts/host-route-index.mjs --write`；核对：`node scripts/verify-route-index.mjs`
> （守卫会在索引与代码不一致时失败 —— 索引因此不会烂掉）。
>
> `闭包状态` = 该处理器的块里引用到的 `apply` 作用域声明（缩进 ≤2）= **将来 context 对象的字段候选**；
> 同一列里反复出现的名字，就是该提出来的字段。

共 **30** 条路由。

| # | 路径 | 行 | 形态 | 闭包状态（引用了哪些） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `/inventory` | 2802 | async 箭头 | webServer buildInventory disposers | 8 |
| 2 | `/media-info` | 2904 | 箭头 | webServer mediaMap disposers | 7 |
| 3 | `/transcode-progress` | 2930 | 箭头 | webServer mediaMap disposers | 1 |
| 4 | `/transcoded` | 2983 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 5 | `(动态路径)` | 3039 | 箭头 | webServer mediaMap disposers serveFile | **0** |
| 6 | `/video-preview` | 3063 | 箭头 | webServer mediaMap disposers serveFile | 1 |
| 7 | `/scene-frame` | 3103 | 箭头 | webServer mediaMap disposers trackStream | 8 |
| 8 | `/scene-frame-cache` | 3245 | 箭头 | webServer mediaMap disposers | 4 |
| 9 | `/scene-live` | 3337 | 箭头 | webServer disposers serveFile | 6 |
| 10 | `/scene-files` | 3460 | 箭头 | webServer disposers handleSceneFiles | 4 |
| 11 | `/media-origin` | 3532 | 箭头 | webServer disposers mediaOrigin mediaOriginBase | 1 |
| 12 | `/props` | 3548 | 箭头 | webServer mediaMap disposers | 2 |
| 13 | `/live-frame` | 3594 | 箭头 | webServer mediaMap disposers serveFile | 2 |
| 14 | `/media-status` | 3677 | 箭头 | webServer disposers ensureMedia | 2 |
| 15 | `/audio-spectrum` | 3687 | 箭头 | webServer disposers mediaBackend ensureMedia | 2 |
| 16 | `/now-playing` | 3706 | 箭头 | webServer disposers mediaBackend ensureMedia | 2 |
| 17 | `/now-playing/artwork` | 3720 | 箭头 | webServer disposers serveFile mediaBackend | 1 |
| 18 | `/client-diag` | 3735 | 箭头 | webServer disposers | 1 |
| 19 | `/api/local-assets` | 3778 | async 箭头 | webServer disposers serveFile | 1 |
| 20 | `/we-assets-dir` | 3828 | 箭头 | webServer disposers | 1 |
| 21 | `/diag` | 3903 | 箭头 | webServer disposers handleDiag | 6 |
| 22 | `/diag` | 3904 | 箭头 | webServer disposers handleDiag | 6 |
| 23 | `/diag-log` | 3905 | 箭头 | webServer disposers diagLog | 1 |
| 24 | `/scene-video` | 3920 | 箭头 | webServer mediaMap disposers serveFile SCENE_VIDEO_INFLIGHT | 1 |
| 25 | `/scene-audio` | 4003 | 箭头 | webServer mediaMap disposers serveFile | 2 |
| 26 | `/custom-frame` | 4039 | 箭头 | webServer disposers serveFile | 1 |
| 27 | `/upload` | 4125 | 箭头 | webServer tokenFor disposers | 2 |
| 28 | `/remove` | 4273 | 箭头 | webServer disposers | 1 |
| 29 | `/upload-dir` | 4317 | 箭头 | webServer disposers | 1 |
| 30 | `/settings` | 4378 | 箭头 | webServer disposers SETTINGS_MAX_BYTES | 15 |

**零提及（拆分前必须先补守卫）**：`(动态路径)`

**被最多路由引用的闭包状态（context 字段优先级）**：

`webServer`×30 · `disposers`×30 · `mediaMap`×11 · `serveFile`×10 · `ensureMedia`×3 · `mediaBackend`×3 · `handleDiag`×2 · `buildInventory`×1 · `trackStream`×1 · `handleSceneFiles`×1 · `mediaOrigin`×1 · `mediaOriginBase`×1

