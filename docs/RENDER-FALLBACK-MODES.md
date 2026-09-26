# 回退形态设计（**目标**）：静态帧渲染归档之后

> **本文是目标设计，不是现状说明。** 上一版（旧主线 2026-09-24 的「两层模型 + 全局回退链」）描述的
> 是另一条线的实现 —— 其档位 id 体系（`{0,2,4,7,8}`、`0=auto`、`7=mp4`、`8=static`）与本仓库
> **完全不同**，其 `静态帧兜底与调优` 三级级联 / `?cached=1` / `sceneLossyRoute` 在本仓库均不存在。
> 那一版作废，本文取而代之。
>
> **状态：2026-09-26 目标稿 · 未实施。**
> 前置：**整条「静态帧渲染」线**（不只是那个离线渲染器）**将由其它贡献者在下一次更新移除** —— 它的
> 完整血统见 §1.3。实现已迁往独立仓库
> [`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)；**该仓库的文件清单里包含
> `src/pkg-extract.js`**，即提取器也一并迁走了。
> 适用范围：**场景类壁纸**。网页壁纸的形态与垫底不在本文范围（其它贡献者在处理）。
> 设计原则：**零迁移优先**（不改用户可感知的持久化语义）；**不新增用户可见开关**；**不留死代码**。

---

## 1. 现状取证（写本文时的代码事实，可逐条复核）

### 1.1 有**两层**结构，别把两层混成一层

| 层 | 是什么 | 落点 |
|---|---|---|
| **显示链** | 屏上"动态还是静态" | `buildMedia()`，`lib/client.js:3743-3752` |
| **静帧来源枚举** | 静态时那张图**由哪个来源产出** | `FRAME_VARIANTS`，`lib/client.js:531` |

**显示链**（源码注释称"优先级不变量"，`lib/client.js:1456`）：

```
① live（WebWallGL） → ② sceneVideo（作者内嵌 MP4，poster = 静帧） → ③ 静帧图（sel.url → /scene-frame?v=N）
```

`isSceneVideo = (type==='scene' && sceneVideo && !isLive)`；
`isStill = (type==='image') || (type==='scene' && !isLive && !isSceneVideo)`。

### 1.2 静帧来源枚举（本仓库的真实档位）

`FRAME_VARIANTS`（`lib/client.js:531-537`）↔ 宿主 `?v=`（`lib/index.js:3201`：`?v=1..4` 有效，缺省/0 → 0）：

| 档 | 客户端标签 | 宿主的真实来源 | 落点 |
|---|---|---|---|
| **0** | 合成（分层） | `tryCompositeSceneLayers()` 多层合成；**失败则静默回落到单图排序** | `lib/pkg-extract.js:1643-1651` |
| **1** | 主纹理（单张大图） | **找最大图片**：遍历包内 `.tex`，按 `面积 × 嵌入格式权重 × 路径惩罚` 打分排序 | `lib/pkg-extract.js:1683-1706` |
| **2** | 作者原画（嵌入 JPEG/PNG） | **作者 PNG**：包内嵌入 JPEG/PNG 整图按面积置顶 | `lib/pkg-extract.js:1711-1729` |
| **3** | 预览图 | 直接读工坊目录 `preview.jpg|png|gif`（**不经** `pkg-extract`） | `lib/index.js:3260` |
| **4** | 自定义画面 | 用户导入的 `overrides/<id>.*`，缺失 → 422 | `lib/index.js:3253` |

**GPU 实时帧（`<key>_gpu.png`）优先于 v=0–3 的全部档位**（`lib/index.js:1980-1987`）；**v=4 豁免**。
该帧由 live 渲染页经 `PUT /scene-frame-cache/<token>` 回填（`lib/index.js:3325` 起）。
缓存键：`SCENE_FRAME_KEY_VERSION = 'sf34'`（`lib/index.js:1941`），非 0 档追加 `_vN`（`:1960-1961`）。

### 1.3 「静态帧渲染」的完整血统 —— 它**不只是**那个离线渲染器

按提交史核实，下面这些都属同一条线，**应当一起走**：

| 组成 | 引入 | 说明 |
|---|---|---|
| **找最大图片**（打分排序） | **`3666a66` · 2026-08-19 · v0.3.0** | `feat: scene wallpaper static frames with quality gating` —— **这条线的开山提交** |
| **作者 PNG**（嵌入整图置顶） | **同上 `3666a66`** | 与「找最大图片」同批诞生 |
| 合成（分层） | `3b43034` · 2026-08-23 | `fix(scene-frame): 多图层场景按场景变换合成整帧，修复只显示中间一块` |
| 档位表把它俩暴露成可切换档 | `152aa74` · 2026-09-21 | `feat: #91 …、壁纸画面刷新与自定义画面` |
| 离线渲染器（`SceneRenderer`） | 更早的静态帧路线 | **在本仓库已无调用点**（§1.5） |

**⇒ 口径确认**：找最大图片与作者 PNG 是「很早期的逻辑」，与渲染器、合成同属「静态帧渲染」。
**⇒ 因此整条线一起移除**：`extractSceneMainImage*`（**含合成**）、渲染器，以及档位 `1/2/3`。

### 1.4 ⚠️ 一个会从后门活下来的陷阱：`v=0` 的静默回落

```js
// lib/pkg-extract.js:1643-1651
if (!variant) {
  try { const composite = tryCompositeSceneLayers(scene, access, label); if (composite) return composite; }
  catch { /* fall through to the single-texture path */ }   // ← 「找最大图片」从这里继续活着
}
```

**只要合成路径还在，删掉 `v=1/v=2` 这两个"档"并不能把「找最大图片」移出自动链。**
本设计因此**连合成一起移除**，从根上断掉这条回落。

### 1.5 离线渲染器在本仓库**已经是死代码**

- 入口 `renderSceneFrameInWorker`（`lib/index.js:922`）**只有定义、无调用点**；`lib/index.js` 只导出
  `inject` / `apply` / `default`（`:2562` / `:2618` / `:4647`）—— **它也没被导出**。
- `/scene-frame` 注释写明原因：「**提取优先（2026-09-20，用户确认后实施）：scene-frame 不再先试
  SceneRenderer worker**」（`lib/index.js:3273-3278`）。
- beta 场景动画（多帧/APNG）已移除，`scripts/verify-client.mjs:27-28` 有**反向探针**断言永不复活。

### 1.6 依赖分解（决定什么能删、什么必须留）

| 模块 / 依赖 | 归属 | 依据 |
|---|---|---|
| `extractSceneMainImage*`、`tryCompositeSceneLayers`、打分排序、puppet 图集分流、作者原画置顶 | **静态帧 → 删** | §1.3 |
| `renderSceneFrameInWorker`（`lib/index.js:922`）、`extractSceneVideoFrames`（`:840`） | **静态帧 → 删** | 死代码；后者仅被前者调用 |
| `lib/scene-render-worker.mjs`、`lib/scene-renderer.js`（再导出壳） | **静态帧 → 删** | 仅为渲染器服务 |
| `lib/we-renderer/**`（**除下面两项**） | **静态帧 → 删** | `core` / `canvas` / `mdl` / `bloom` / `camera` / `effects*` / `glsl/*` / `gpu-*` / `model` / `particles` / `puppet` / `text` / `jpeg` / `image` / `profile` / `predecode*` 等 |
| `readPkg`（`we-renderer/textures.js`） | **必须留** | `lib/index.js:72` |
| `parseVec3`（`we-renderer/math.js`） | **必须留** | `lib/scene-script-apis.js:4` |
| `parsePkg` / `readPkgEntry` / `extractTexVideoMp4`（同在 `pkg-extract.js`） | **必须留** | `/scene-video`（作者内嵌 MP4）这条**非静态帧**线要用（`lib/index.js:872-885`） |
| `_gpu.png` 实时抓帧与 `/scene-frame-cache` | **必须留** | 它是**实时**帧的缓存，不是静态帧产物 |
| 自定义画面通道（`overrides/`、`customFramePath`） | **必须留** | §2.1 ④ |

> **落地要求**：不要"整目录 / 整文件删除"。`pkg-extract.js` 与 `we-renderer/` 都是**混合体** ——
> 先把活依赖迁到语义正确的位置（如 `lib/pkg-read.js` / `lib/scene-math.js`），再删其余。
> 否则会留下"删了模块、import 悬空"的破窗。

### 1.7 `preview` 是**双重身份**，不能一刀切

| 用途 | 落点 | 处置 |
|---|---|---|
| **壁纸来源**（档 3） | `FRAME_VARIANTS` id 3、`lib/index.js:3260` | **删** —— 作者 preview 比静态帧废弃更早，实测**几乎任何情况下都糊成一团**，作壁纸来源完全不可用 |
| **选择器缩略图 / 卡片封面** | `lib/client.js:6344-6346`、`:7277`、`:6120`、`:1960`；`inventory.preview`（`lib/index.js:2755`、`:2808`） | **必须留** |
| **视频探测期的海报** | `lib/client.js:1472`、`:1482`（`prepareVideoProbe(…, w.frameUrl \|\| w.preview, …)`） | **留**（探测期占位，与"来源"无关） |

### 1.8 UI 现状

- 「**壁纸画面刷新**」行只在实时渲染未生效时出现（`lib/client.js:6912`），状态行 `第 N/M 档 · <来源> · 共 M 种`。
- 「**实时帧**」行独立显示（live 开着也显示），含「重新截」/「清除 GPU 帧」（`:6927-6938`）。
- 失败记忆 `sceneLiveFailures[id]`（值 `true | 'timeout' | 'stall'`，`lib/index.js:1081`），
  `liveRenderEnabled()` 一旦读到记录就不再走 live（`lib/client.js:2313-2327`）。
- ⚠️ **现存笔误**：状态行的「档」写成了「**秡**」—— `lib/client.js:6923`、`src/client.js:6947`。

---

## 2. 目标

### 2.1 显示链（唯一权威顺序，5 级）

```
① live（WebWallGL 实时渲染）
② sceneVideo（作者内嵌 MP4，/scene-video）        ← 与 ① 同属「动」；作者本意
③ 实时抓帧缓存（场景 _gpu.png / 网页 liveFrame）  ← 「静」的链头；真实画面，不是猜图
④ 自定义画面（用户导入 overrides/）               ← 用户显式资产
⑤ 空（不渲染）                                   ← 全链不可用时的诚实终端
```

**①→② 的顺序不变**：沿用现有优先级不变量 `live > sceneVideo > 静帧`（`lib/client.js:1456`）——
本次只移除静态帧线，不借机改这条已验证的顺序。

**③ 是上一稿的缺口，这里补上**：实时抓帧是**这台机器真实渲染出来的**最后一帧
（`__wp.capture` → `PUT /scene-frame-cache` → `_gpu.png`），与 ① 同源，**优先于 ④**；
这与宿主 `gpuFrameFileFor()` 的既有语义一致（`v=4` 豁免，见 §2.3）。网页侧的 `liveFrame`
（`PUT /live-frame/<token>`）现状只用作 live 启动海报；目标形态里它同时是 ③ 的来源。

**没有 ⑥。明确不做**：不再有任何"替作者猜一张图"的来源 —— 找最大图片 / 作者 PNG / 合成
**正是**在干这件事，也正是本次要移除的。

### 2.2 静帧来源档位（目标枚举）

| id | 名称 | 说明 |
|---|---|---|
| **0** | **自动** | **取链头**（③→④ 中第一个可用者）—— 见 §2.3 |
| **4** | 自定义画面 | 沿用既有 id |

**移除的 id**：`1`（主纹理 / 找最大图片）、`2`（作者原画 / 作者 PNG）、`3`（预览图）。
宿主侧对 `1/2/3` 及越界值一律 **clamp 到 0**（沿用旧主线 `clampFrameVariant()` 的思路）。

> 值域里的洞（缺 1/2/3）**有意保留**：它让"哪些档已退役"在数据里可读，同时避免值域迁移。

### 2.3 默认 = 链头

`GET /scene-frame/<token>`（**无 `?v=`**）不再隐含"档 0 = 合成"，而是**求链头**：
**有实时抓帧（`_gpu.png`）→ 服务它**；否则有自定义画面 → 服务它；否则 → 404 / 空态（客户端走 ⑤）。

`?v=4` 仍是"强制自定义画面"（缺失 → 422，客户端明示"自定义画面已失效"）。

### 2.4 失败语义与终端

| 环节 | 目标行为 |
|---|---|
| live 首帧逾时 / 运行期失联 | 记 `sceneLiveFailures[id]` → 前进到 ②；**同会话对该壁纸不再重试 live**（现状即此，保留） |
| ② 内嵌 MP4 | 取不到 → 静默前进；**不记失败记忆**（作者没给视频是常态，不是故障） |
| ③ 自定义画面 | 缺失 → 前进到 ④ |
| ④ 空 | **留空**，状态行给出可判定原因。**不回落任何"猜图"来源**，也不回落预览图 |

### 2.5 持久化与兼容（零迁移论证）

- 用户可感知的语义不变：**"我为这张壁纸 pin 过一个来源"这个事实仍被记住**。
  被移除的 pin 值（`1/2/3`）**clamp 到 0（自动）** ⇒ 旧配置**原样可用**，只是那条 pin 变成"自动"。
  这是唯一可接受的降级方向 —— 反向（把 auto 变成某个具体档）会让老配置被误读成用户没选过的来源。
- `customFrames`（`{[id]: true}`）形状不变；`sceneLiveFailures` 值域不变。
- 三个键必须同时存在于**客户端发送 / 宿主白名单 / 客户端读回**三份清单（历史"设置存不住"的根因类别）。

### 2.6 要删除 / 要保留的代码

**删（静态帧线，§1.3 血统）**

- `pkg-extract.js`：`extractSceneMainImage` / `extractSceneMainImageFromDir` /
  `tryCompositeSceneLayers` / `collectImageObjectTextures` / puppet 图集分流 / 打分排序 / 作者原画置顶
  （**保留** `parsePkg` / `readPkgEntry` / `extractTexVideoMp4` 及 sceneVideo 需要的解码部分）
- `lib/index.js`：`renderSceneFrameInWorker`（`:922`）、`extractSceneVideoFrames`（`:840`）、
  `/scene-frame` 里 `variant ∈ {0,1,2,3}` 的提取分支、`gpuFrameFileFor` 的 `variant > 3` 旧豁免需按新档位重写
- **`sceneFramePrewarm()`（`lib/index.js:2570`）** 与它的一整套记账：`SCENE_PREWARM_LOGIC`（`:2568`）、
  `_scenePrewarmStarted`、`prewarm-state.json`，以及 `:2875` 的开机自调用。
  ⚠️ **它是静态帧线的直接附属** —— 它 `import` 的正是将被删的 `extractSceneMainImage*`：
  不一起删就会引用已删导出而崩；而且它就是"旧预热"的本体（见 §3）。
- `lib/scene-render-worker.mjs`、`lib/scene-renderer.js`、`lib/we-renderer/**`（除 §1.6 两项活依赖）
- 客户端 `FRAME_VARIANTS` 的 `1/2/3` 三项与相关文案
- **`scripts/verify-comment-discipline.mjs` 的两处钉子要同步收窄**：它的 `FILES` 名单含
  `lib/scene-render-worker.mjs` 与 `lib/we-renderer/core.js`（删掉后被 `try/catch` 静默跳过 ⇒
  等于悄悄失去覆盖），棘轮基线 `CEIL` 里也钉着这两个文件 —— 删除时应把它们**从名单移除**，而不是留空跑。

**保留**

- `/scene-frame` 路由名、`?v=` 参数形态、`?v=4` 语义（URL 兼容）
- GPU 实时帧 `_gpu.png` 与 `/scene-frame-cache`（**它不是静态帧**）
- `preview` 作为缩略图 / 海报（§1.7）
- `readPkg` / `parseVec3` / `extractTexVideoMp4` 的落点

### 2.7 缓存键与命名：**本稿结论与上一稿相反**

移除提取链后，帧缓存目录里**只剩 `_gpu.png`（实时抓帧）** —— 提取产物 `<key>.png|jpg|gif` 不再产生，
自定义画面存在 `overrides/` 而不进缓存目录。

**⇒ 升 `SCENE_FRAME_KEY_VERSION` 的代价，从"所有壁纸重新提取"降为"重抓几张实时帧"（几秒、零画质损失）。**
另有第二条理由：若采纳 §3.3 的「抓帧延后到 t≈N」，**抓帧内容本身会变**，旧帧本就该作废。
因此本稿**建议一并改名并升值**：

| 现名 | 目标 | 理由 |
|---|---|---|
| `SCENE_FRAME_KEY_VERSION = 'sf34'` | `LIVE_FRAME_KEY_VERSION = 'lf1'` | 语义已从"静态帧产物"变为"实时帧缓存"，且此时升值很便宜 |

UI 命名：`壁纸画面刷新` → **`出图来源`**（它换的是**来源**，不是"刷新"；"刷新"会被误读成重抓实时帧
—— 那是「实时帧」行的「重新截」）。

### 2.8 守卫计划（实施时同步落地）

| 断言 | 目的 |
|---|---|
| **反向探针**：`renderSceneFrameInWorker` / `scene-render-worker` / `extractSceneMainImage` 仓内**零引用** | 防静态帧线悄悄复活（沿用 `/scene-anim/` 的做法） |
| **反向探针**：`collectImageObjectTextures` / `FORMAT_PENALTY` 等「找最大图片」标识零残留 | 防它换条路径回来（§1.4 的教训） |
| `lib/we-renderer/` 已不存在，且 `readPkg` / `parseVec3` 新落点可解析 | 防"删了目录但 import 悬空" |
| `?v=1/2/3` 与越界值均 clamp 到 0（正/负对照） | 零迁移的机器保证 |
| `?v=4` 不被 GPU 帧覆盖；无 `?v=` 时求链头 | §2.1–2.3 的语义断言 |
| 自动链末尾**留空**、不回落预览图 | §2.4 |
| `inventory.preview` 仍在（缩略图可用） | 防 §1.7 误删 |
| **反向探针**：`sceneFramePrewarm` / `SCENE_PREWARM_LOGIC` / `prewarm-state` 零残留 | 防"旧预热"复活（§2.6 / §3.2） |
| **预热时长闸**：`prepareSceneLiveStage` 的就绪判定含"运行满 N 秒" | §3.3 的语义断言（N=0 时该断言应可关闭） |
| 状态行不含「秡」 | 顺手修 §1.8 的笔误 |

### 2.9 分阶段迁移（交给接手者）

1. **阶段 0**：加全部反向探针 + 修「秡」笔误 → `npm run verify` 全绿（**此时不删任何东西**）。
2. **阶段 1**：把 `readPkg` / `parseVec3` 落点迁出 `we-renderer/`；把 sceneVideo 依赖的
   `parsePkg` / `readPkgEntry` / `extractTexVideoMp4` 留在 `pkg-extract.js`（或一并迁出）。验证。
3. **阶段 2**：删 `extractSceneMainImage*` 全链 + 渲染器 + `we-renderer/`；`?v=` 只认 `{0,4}`；
   客户端档位表只留 `{0,4}`；跑反向探针与全链验证。
4. **阶段 3**：缓存键常量改名升值（`LIVE_FRAME_KEY_VERSION = 'lf1'`）。
5. **阶段 4**：UI 改名「出图来源」+ 文档/注释统一去掉「静态帧」「画面刷新」旧词。

---

## 3. 开机镜头与预热（本次新增目标）

### 3.1 取证：WebWallGL **不支持**渲染特定时刻（`__wp` 全成员表）

判断依据（全部取自 vendored 1.4.2）：

- 渲染页只读 4 个 URL 参数：`localAssets` / `resources` / `texcompress` / `texr8` —— **无时间参数**。
- `window.__wp` 的**完整**成员（逐个提取）：
  `setWallpaper pause resume release restore capture loadSceneFile setFit fit setFilter filter
  setQuality getQuality setRenderDpr renderDpr setSceneFps sceneFps mode type source setVolume
  muted setAudioBridge setMedia props getProperties updateWebProps pushPointer pushWheel
  pointerLeave buttons mods getState loop`
  —— **没有 `seek` / `setTime` / `renderAt` / `setRuntime`**。
- 源码里 30+ 处 `seek`/`setTime` 命中全在**视频纹理**控制（`videoCtl.setCurrentTime` → `<video>.currentTime`）
  与通用媒体控制，**不是场景时钟**。
- 场景时钟是**内部累积量**：`engine.runtime = B`，`B` 由 rAF 循环里 `performance.now()` 的差值累加，
  脚本只读；唯一外部杠杆是 `pause()` / `resume()`。
- 上游 `webwallgl` 无 release/tag；最新提交为 2026-09-23 的 camerashake 修复，**无时间 API 迹象**。

**⇒ 「跳到 t=N 以避开开机镜头」在当前渲染器上做不到。**

**而且即使上游加了 `setSceneTime(t)`，「跳」也不是纯赋值**：场景时钟驱动的是**累积状态** ——
动画控制器逐帧 `ctrl.advance(O)`、粒子系统内部计时、脚本 `engine.runtime`。直接设数字会得到
"动画根本没走到那一步"的错误画面。**正确实现最便宜的路径仍然是「从头快进跑 N 帧」—— 那就是预热。**

### 3.2 把三种「预热」拆开（它们的命运完全不同）

| # | 机制 | 它解决什么 | 移除静态帧后 | 结论 |
|---|---|---|---|---|
| ① | **宿主静态帧预提取** `sceneFramePrewarm()`（`lib/index.js:2570`；`SCENE_PREWARM_LOGIC` + `prewarm-state.json` 记账；`:2875` 开机自调） | 把 ~10s 的 CPU 提取等待移出交互路径（"切换即命中缓存，感知 ≈ 0"） | **服务对象消失** | **不回归**，随 §2.6 一并删除 |
| ② | **轮换的 live 渲染页预载** `prepareSceneLiveStage`（staging 层 `opacity:0` 但满视口几何 → 渲染页**全分辨率**初始化 → 首帧就绪后节点级领养） | live 冷启动窗口（拉 pkg + 纹理上传） | **仍在，而且更重要**（live 是唯一动态来源） | **已经在了** —— 不需要"回归"，需要**延长预热时长** |
| ③ | **手动切换的 live 启动**（`buildMedia` 直接挂 iframe + 主题色海报，不走准备链） | 同上 | 同上 | **缺** —— 手动切换必然看到开机镜头 |

### 3.3 目标：把「首帧就绪」升级为「运行满 N 秒」

② 的就绪判定现在是 `st.running && st.fps > 0`（`lib/client.js:1653`）—— **首帧一到位就提交，
而首帧正是开机镜头**。改成「首帧就绪 **且** 已运行 ≥ N 秒」即可跨过去。

**轮换场景下这 N 秒是免费的**：用户正看着上一张，时间本来就在流逝。现有机制已覆盖"预热期间
用户切走"的各种情况（`PREPARE_LIVE_TIMEOUT_LIMIT = 2`、`PREPARE_LIVE_HIDDEN_HOLD_MAX_MS = 60s`、
隐藏期 2s 轮询），**不需要新造机制**。

③ 手动切换有两个选择：

- **A（彻底）**：手动路径也走准备链 —— 代价是牺牲"即时反馈"，除非改成"先亮主题色/上一张、
  预热满 N 秒再切"。
- **B（折中，推荐）**：手动切换的**首次可见**保持即时（接受开机镜头），但**把抓帧延后到 t≈N** ——
  于是"降级时 / 切走再切回时看到的静帧"是干净的。代价接近零，并给 §2.7 的升值多一条理由。

**N 取多少**需要拍板（见 §5）：默认 0（关闭，行为不变）还是 2–3s？per-wallpaper 覆盖可以后挂到
已有的「壁纸属性」面板（`propsUrl` / `updateWebProps`），不在本次范围。

---

## 4. 与上一版（旧主线那版）的关系

**不采纳其结构，但采纳其中两条结论** —— 它们与本仓库独立得出的方向一致：

| 旧版主张 | 本稿态度 |
|---|---|
| `0 = auto`（取链头） | **采纳**（§2.3）—— 与"默认 = 链头"一致 |
| 删除 `preview` 作为回退来源 | **采纳**（§1.7 / §2.4）—— 与本仓库实测"作者 preview 糊到不可用"一致 |
| 新增 `7=mp4` / `8=static` | **不采纳** —— 内嵌 MP4 属**显示链**②（§1.1），塞进静帧档位表就是把两层又混了；`static` 是被移除的东西，不该再占 id |
| `1=maintex` / `2=art` 继续占 id | **不采纳** —— 它们正是要移除的"找最大图片 / 作者 PNG"（§1.3） |
| 「静态帧兜底与调优」三级级联 | **不采纳** —— 不新增用户可见开关 |
| 教训：回退层可见性只由 live 状态决定；资产层写操作不得改写 live 层 key | **保留** —— 对应实现见 `LAYER_KEY_FIELDS` 与 live 期间不吃资产 URL |

---

## 5. 未决（需要拍板）

1. **`/scene-frame` 路由是否改名**（→ `/scene-image`）：它此后只服务"自定义画面 + 实时帧"，名字里的
   "frame" 已无静态帧含义。**本稿默认不改**（URL 兼容零风险）。
2. **`?v=` 参数是否保留**：只剩 `{0,4}` 两个值后参数价值不大；删掉会打断既有客户端约定。
   **本稿默认保留。**
3. **⑤ 空态的呈现**：留空 + 状态行原因之外，是否给一次"可导入自定义画面"的引导？
   （考虑：这会把"失败"变成"推销"，可能被反感。）
4. **③ 与 ④ 的先后**：本稿把实时抓帧（③）放在自定义画面（④）之前，与宿主 `gpuFrameFileFor()`
   既有语义一致。但若用户已**显式导入**自定义画面却被一张抓帧顶掉，体感是"我导入了却不生效" ——
   这是产品判断（注：`?v=4` 是显式 pin，不受影响；有疑问的是"自动"档下的默认选择）。
5. **预热的 N 取多少**（§3.3）：默认 **0（关闭、行为不变）** 还是 2–3s？以及手动切换是否走
   §3.3 的 B 方案（只延后抓帧、不延后首帧可见）。
6. **是否向上游提 `setSceneTime` 需求**：可以提，但需一并说明"正确实现必须快进"（§3.1），
   所以它大概率仍以预热为底层实现 —— 提了也不替代 §3.3。
