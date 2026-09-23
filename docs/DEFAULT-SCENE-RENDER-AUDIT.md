# WE 官方默认壁纸「无损渲染」审计（首轮 · 纯数学）

> 日期：2026-10-03　对象：`projects/defaultprojects/` 官方壁纸（用户点名 Sheep / Razer Bedroom /
> Eagle Flag / DNA Fragment / Deep Space / Arsenal / Beach）
> 方法约束（用户长期准则）：**不依赖目视判断**。全部结论来自
> ①场景数据解析 ②渲染器插桩后的可判定量 ③官方 preview 的数学画像 ④反编译宿主端代码。
> 本文件只记录**能复现的量**与**能指到行号的根因**；证据不足的一律标注「候选/待定性」。

---

## 0. 结论速览

> 首轮（定位）→ 已修 7 项、待修 4 项。下表的「修后」列都是本机实测（480×270，t=2.5，
> 与修前同口径）；回归：`npm run verify` exit 0、`verify-scene` 22/22（含新增 Level C 护栏）。

| 壁纸 | 现象（数字） | 根因 | 状态 |
|---|---|---|---|
| **Sheep** | 被判成 `scene`（真实 application）；主纹理路径把 `sheep.exe` 当 PKG 解 → `pkg: invalid string length 9460301` | `lib/index.js` `inferType()` 未处理 `.exe`，而该 `project.json` 无 `type` 字段 | **已修**：`.exe → application`；客户端按预览图展示（原先落到 `src=null` 的 iframe） |
| **Eagle Flag** | 正交 2D 层被 `-camera.eye.x·ps` 平移：左边界 72px@480（**583px@4K**），覆盖率 84.63% | `camera.js` `_viewShift()` 静态分支（官方宿主对"正交+无相机路径"会把相机重置为 eye=0，静态 JSON eye 不参与取景） | **已修**：覆盖率 **84.63% → 99.86%**，左边界 → 0 |
| **Eagle Flag**（第二处） | `flag` 的法线解码三通道全错（用 `(R,G,B)*2-1`），`n.x` 可用幅度只有官方的 **1/147** | `image.js` `_flagImage` 未按 `TEX1FORMAT` 分支 | **已修**：按 format 分支 + 暴露纹理 format（缺 format 时用法线有效性判据兜底） |
| **Beach** | 背景层 **整幅纯黑且 100% 覆盖**（`flowimage` 变体 B 返回 `[0,0,0,1]`）；全帧均值 rgb(32,26,18) | `model.js` 层过滤把基准层也排除（`flowIdx=1` 时 `layers=[]`） | **已修**：全帧均值 **rgb(32,26,18) → rgb(150,126,107)**（官方参考亮度 180.7） |
| **Arsenal** | 只画出一把刀：非清屏 **1.68%**、bbox `[290,0,374,157]` | `.mdl` 只解析第一个子网格（6 块里丢掉 5 块 = 84.8% 顶点） | **已修**：非清屏 **1.68% → 41.26%**，bbox 满帧 |
| **DNA Fragment** | `particles` 单独渲染 **0.00%**（12 个存活粒子全越界） | `particles.js` 只在正交场景做坐标映射，透视场景把世界坐标当像素（官方是过 MVP） | **已修**：0.00% → **0.82%**（1063px，12 粒子落屏 10） |
| **Razer Bedroom** | 5 个辉光层隔离显示 0.00%；`glow1` 报「tint 输出退化」并回退 | ①「0.00%」是**隔离口径失效**（`colorBlendMode=11` 底色依赖，黑底 ⇒ Overlay≡0），非缺陷；②`tint` 退化判据只看 RGB ⇒ **误杀合法单色输出** | **已修**②（判据纳入 alpha；`razer_vortex/THS` 是同类第 2 个受害者）；①为口径问题，已澄清 |
| **Deep Space** | 无失败，但 `flowimage` 多层合成模型错（离线参考 mean 差 **27.996/255**、65.94% 超阈） | `model.js` 用 Power 权重 + 1/N 平均 + 常量 alpha（官方是逐层 `blendLayers`、alpha 取 max、第 3 层相位 +0.3333） | **已修**（合成误差 27.996 → 0.093/255，按离线官方参考） |
| 同族（未点名）<br>**audiophile / fantasticcar / ricepod / techno** | **完全无法渲染**：`scene.json 不存在`（4/4） | 场景主文件名硬编码 | **已修**：读取 `project.json.file` 声明名（4/4 可构造 4/4/8/4 个对象） |
| 同族（顺带）<br>全部**松散**场景项目 | `project.json` 的 `general.properties` 从未被读到（查了项目目录的**父目录**）⇒ 作者配色/滑块被丢 | `core.js` `_readUserProps()` | **已修**（eagleflag 旗帜配色、razer_bedroom light_speed 现已读到） |

**待修（已定位 + 已量化）**：`genericimage` 的 `Scroll 1/2` 未实现（beach 云层不漂移、alpha 0.26 丢失，
alpha 差 188.7/255）；`flowimage` 走全屏 quad ⇒ 忽略 origin/scale/angles；最终 blit 最近邻采样；
`bloom.js` HDR 分支写线性值而全链路无 linear→sRGB（razer_bedroom 均值 19.51 → 3.14）；
`blitRotated` 无 blendMode 形参 ⇒ 旋转分支丢 `colorBlendMode`；`Date.now()` 进 tint color 脚本 ⇒
同 t 两次渲染差 2631 字节；`p.lifetime` 未赋值 ⇒ 粒子达 `maxcount` 后永久停发；`frameQuality()`
用 `Math.random()` 抽样。



---

## 1. 方法（可复现）

新增三个只读诊断脚本（均在 `scripts/`，不写仓库外任何文件）：

| 脚本 | 作用 | 命令 |
|---|---|---|
| `diag-default-scenes.mjs` | 逐对象隔离渲染：把每个对象单独打开、其余隐藏，量它的**非清屏覆盖率 / 包围盒 / 均值色 / NaN**；同时分类渲染器日志 | `node scripts/diag-default-scenes.mjs eagleflag deep_space arsenal beach razer_bedroom dna_fragment --w 480 --h 270 --isolate` |
| `diag-preview-grid.mjs` | 官方 `preview.jpg` 的数学画像：清屏色占比、非清屏 bbox、8×6 网格占用、行列一维剖面 | `node scripts/diag-preview-grid.mjs` |
| `survey-default-scenes.mjs` | 把**全部**官方默认场景的 2D 图层布局摊平：正交尺寸 / 相机 eye / 每个图层的 origin、sprite 尺寸、相对正交矩形的归一化位置（两种坐标约定各算一遍） | `node scripts/survey-default-scenes.mjs` |

**为什么「非清屏」而不是「alpha」**：渲染器画布 alpha 恒为 255，alpha 统计无效（本文件首版
曾因此得到一个 100% 的假读数，已纠正）。凡「0.00%」均指该对象单独渲染时**所有像素与
`general.clearcolor` 逐通道相差 ≤2**。

---

## 2. 已确证缺陷

### D1 — Sheep 被判成 scene 壁纸（应用型壁纸类型判定缺失）

* `projects/defaultprojects/sheep/project.json` **没有 `type` 字段**，`file` 为 `sheep.exe`。
* `lib/index.js`：
  ```js
  function inferType(file) {
    if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return 'video';
    if (/\.(html?|js)$/i.test(file)) return 'web';
    return 'scene';                       // ← .exe 落到这里
  }
  ```
  ⇒ Sheep 进入 `scene` 分支：`resolveSceneMainFileP()` 把 `sheep.exe` 当场景主文件，
  `/scene-frame`、主纹理提取、预热全部按「场景」处理。
* 宿主日志取证（`~/.dsh-wallpaper-engine/gpu-diag.log`）：
  ```
  [framesource] 主纹理提取失败 → 回退真实渲染: sheep/sheep.exe pkg: invalid string length 9460301
  [framesource] 主纹理不适用   → 回退真实渲染: sheep/sheep.exe 无产物 (质量门拒收/无候选)
  ```
* 离线复现（直接构造 `SceneRenderer`）：`sheep → FAIL: scene.json 不存在`。

**结论**：Sheep 的「无损渲染」不是画得对不对的问题，而是**它不该走场景渲染**。WE 的应用型
壁纸（.exe）本插件无法内嵌，正确行为是与 video/web 并列的第四类：只服务 preview。

### D2 — 主文件名不是 `scene.json` 的官方场景**整条链路失败**

官方默认项目里有 4 个场景的主文件是 `<名字>.json`（不是 `scene.json`）：`audiophile.json`、
`fantasticcar.json`、`ricepod.json`、`techno.json`。渲染器与提取器把它硬编码成 `scene.json`：

| 位置 | 代码 |
|---|---|
| `lib/we-renderer/core.js:54` | `this.scene = this.pkg.readJson('scene.json');` |
| `lib/pkg-extract.js:1645 / 1837 / 1848` | `access.readJson('scene.json')` |
| `lib/scene-manifest.js:1333 / 1903` | `access.readJson('scene.json')` |
| `lib/index.js:921 / 952` | `path.join(src, 'scene.json')`、`name === 'scene.json'` |

离线复现（全部 19 个默认项目的构造结果）：

```
scene      scene.json        arsenal               OK objects=3
(no type)  audiophile.json   audiophile            FAIL: scene.json 不存在
scene      scene.json        beach                 OK objects=3
scene      fantasticcar.json fantasticcar           FAIL: scene.json 不存在
scene      ricepod.json      ricepod               FAIL: scene.json 不存在
(no type)  sheep.exe         sheep                 FAIL: scene.json 不存在
scene      techno.json       techno                FAIL: scene.json 不存在
...（其余 OK）
```

宿主日志同一结论：`finish: ERR scene.json 不存在`、`scene: scene.json not found or invalid`
（对 fantasticcar / ricepod / techno 各出现多次）。

**结论**：这些壁纸在**主纹理模式与完整渲染模式下都**不可用，且失败在「读场景」这一步，
与渲染数学无关。修法是把「声明的主文件名」透传到底层（`project.json.file` 已经解析出来了，
只是没有传进去）。

---

## 3. Eagle Flag：正交 2D 层被相机 `eye.x` 平移（已确证并修复）

### 3.1 测量（不是推断）

`eagleflag/scene.json`：唯一对象 `eagle`，`image: models/eagle.json`（sprite 2048×1024），
`origin 1082.000 550.906 0`，`scale 1.1`；`general.orthogonalprojection = 2200×1080`；
`camera.eye = -378.290 -185.706 0`。

`scripts/diag-default-scenes.mjs --isolate` 实测（480×270）：

```
#2 eagle  image  非清屏=84.63%  bbox=[72,0,479,269]  均值=[84,81,72]
```

用 `image.js` 的绘制公式逐步算（`ps = [W/orthoW, H/orthoH]`）：

| 项 | 不带 eye 平移 | 实际（带平移） |
|---|---|---|
| `vs[0]` | 0 | `-eye.x·ps[0]` = **+82.5px**（480 宽）/ **+660px**（4K） |
| 绘制左边界 `dx` | **-9.7px**（整屏覆盖） | **+72.8px**（实测 bbox 起点 72 ✓） |
| 左侧留空 | 0 | **15.0%（4K: 583px）** |

`_viewShift`（`lib/we-renderer/camera.js`）：

```js
const isBg = size && size[0] >= w - 1 && size[1] >= h - 1;
if (isBg || !this.camEye) return [0, 0];
if (this._camObjDriven) return [(-this.camEye[0]) * (ps ? ps[0] : 1), (this.camEye[1]) * (ps ? ps[1] : 1)];
return [(-this.camEye[0]) * (ps ? ps[0] : 1), 0];   // ← eagleflag 走这一行
```

### 3.2 为什么怀疑它错（两条**独立于像素**的证据）

**证据 A — 作者布局几何（自洽性）**：旗子缩放后 2252.8×1126.4，正交矩形 2200×1080。
若坐标约定是「正交矩形 = [0,W]×[0,H]」，旗面覆盖 `[-44.4, 2208.4]×[-12.3, 1114.1]`，
**中心 (1082, 550.9) 与矩形中心 (1100, 540) 相差 18/11 单位（0.8%/1.0%）** —— 正是
「把整屏图层居中」的结果。若是「矩形 = [eye, eye+W]」约定，矩形中心为
`(721.7, 354.3)`，作者的图层偏了 **360/197 单位（16.4%/18.2%）**，且左侧必然露出
15% 的清屏灰带。**同一份数据在两种约定下的「居中残差」相差 20 倍。**

**证据 B — 全库统计（`survey-default-scenes.mjs`）**：官方默认场景里所有「尺寸≈正交矩形
且居中」的 2D 图层，其 origin 在 `[0,W]` 约定下的归一化位置是

```
deep_space/galaxy_2_base   BL(0.500,0.500)   ← 整屏覆盖
deep_space/Background      BL(0.483,0.511)   ← 整屏覆盖
razer_vortex/vortex        BL(0.500,0.500)
razer_bedroom/new_wall…    BL(0.500,0.500)
shimmering_particles/grad  BL(0.500,0.500)
eagleflag/eagle            BL(0.492,0.510)   ← 整屏覆盖
--- 3 个「整屏覆盖」图层 x/y 均值 = 0.492 / 0.507 ---
```

即：**官方作者把整屏图层放在正交矩形中心（`[0,W]` 约定）**，与相机 `eye` 无关；
上述场景的 `eye` 恰好都是 0，所以只有 eagleflag 能区分两种约定 —— 而它的数据同样落在中心。

**证据 C — 着色器**：`assets/shaders/flag.vert` 只做 `mul(a_Position, g_ModelViewProjectionMatrix)`
＋法线 UV 扰动，**没有任何顶点重定位到全屏的写法**，所以旗子的屏幕位置完全由
origin/size 决定，不存在「shader 把它拉回来」的可能。

### 3.3 静态逆向结论：正交画布原点 = **被驱动**的 eye，静态 JSON eye 被重置为 0

逆向 `E:\SteamLibrary\steamapps\common\wallpaper_engine\decompiled\wallpaper64.exe.c` 得到完整链路：

| 环节 | 证据 |
|---|---|
| LookAt = 行向量约定，平移行 = **−eye** | `303489 FUN_14019d920`：`param_1[0xc] = -(right·eye)`、`[0xd] = -(up·eye)`、`[0xe] = +(forward·eye)`（第 3 基 = −forward，故符号自洽） |
| 正交分支改写 **view 矩阵的平移行** | `291224`（函数 `FUN_140189e10` 内）：`*(renderer+0x68) += (int)(renderer+0x84)*0.5`、`+0x6c += (int)(renderer+0x88)*0.5`、`+0x70 = 0x44fa0000 (2000.0)`；`0x68/0x6c/0x70 = 0x38+0x30/34/38` 正是 4×4 的平移行 |
| 正交投影 = 内联 `XMMatrixOrthographicOffCenterLH` | `117685 FUN_14009a630`：`m[0]=2/(right−left)`、`m[5]=2/(top−bottom)`、`m[12]=−(l+r)/(r−l)`、`m[13]=−(b+t)/(t−b)` |
| ⇒ 可见世界矩形 = **[eye, eye+(W,H)]**，即 eye 是画布原点（"约定 C"） | 上面两条合成：`view = p − eye + half`，投影再以 `W/2` 为中心 ⇒ 世界 `eye` 落在画布左下角 |
| 但加载期对"正交 + 无相机路径"的场景**把相机重置为默认**：eye=(0,0,0)、center=(0,0,−1)、up=(0,1,0) | `290440`：`if ((scene+0x1c >> 3 & 1) != 0 && scene[0x62] == scene[99]) { eye=0; center=(0,0,-1); up=(0,1,0); }`（0x1c bit3 = 正交标志，同 289793 处的解析） |
| 每帧位姿：有相机路径 → 路径关键帧（**Catmull-Rom 三次 Hermite**，非线性）；无路径 → 拷贝 JSON 相机 | `291006`（路径）/ `290979`（拷贝 `scene+0x118`-based 相机到 `scene+0xf0` 位姿）；`291037` 附近的 Hermite 基 `h00=2t³−3t²+1, h01=3t²−2t³` |

**结论**：正交模式下画布锚在 **resolved** eye（路径/相机对象驱动）上；**静态 JSON `camera.eye` 被官方重置为 0**。
三份独立证据一致：①作者布局残差 1.7% vs 33.5%（§3.2 证据 A）；②全库整屏图层都居中（证据 B）；
③宿主端存在正交专用重置分支。因此 `_viewShift` 里"静态 eye 的 x 平移"是**真 bug**。

> 复数域旁证：`291151` 起把 `scene+0x340`（= 加载期写下的 `eye.xy + halfSize`）做平滑后**再除以正交宽高**
> 得到归一化相机位置（0.5 = 屏幕中心），这也只有在"画布原点 = eye"时才有意义 —— 佐证约定 C 本身成立；
> 与 `0xe0 bit3` 的重置分支合起来，等于"正交 + 无路径 ⇒ eye=0"。

### 3.4 修复与验收（已落地）

`lib/we-renderer/camera.js`：
* `_resolveCameraPose()` 现在记 `this._camPathDriven`（位姿是否来自相机路径）；
* `_viewShift()` 在正交（`ps != null`）且**非**路径/相机对象驱动时返回 `[0, 0]`。

| 量 | 修前 | 修后 |
|---|---|---|
| eagleflag 非清屏覆盖率（480×270, t=2.5） | 84.63% | **99.63%** |
| eagleflag 非清屏包围盒 | `[72,0,479,269]`（左侧 15% 空带） | **`[0,0,479,269]`** |
| 4K 下左侧空带 | 583px | **0** |

护栏：`scripts/verify-scene.mjs` Level C2（真实渲染 + 覆盖率/左边界断言，非正则）。


---

## 4. Arsenal：根因 = `.mdl` 只解析第一个子网格（已确证并修复）

**根因不是取景也不是光照，是几何解析。** `lib/we-renderer/mdl.js` 的 `parseMdlStatic` / `parseMdlPuppet`
只读 MDLV0014 的**第一个子网格块**；`pistols.mdl`（570179 B）实含 **6 块**：

| 块 | 顶点 | 三角 |
|---|---|---|
| knife_df | 1423 | 1347 |
| planks | 8 | — |
| Pistol0101 / 0102 / 0103 | 4698 / 382 / 260 | — |
| goldmetal | 2566 | — |
| **合计** | **9337**（第一块仅 15.2%） | |

块链 `materials/<x>.json\0 + u32 + u32(vertBytes) + verts + u32(idxBytes) + idx` 在 4 个多块
MDLV0014 文件上恰好走到 `filesize-1`（pistols 570178/570179、body 375424/375425、ricepod、
orbitaleffects）。⇒ **84.8% 的顶点、5 块网格从不渲染**；而 5 段 camera path 的 `center` 全部落在
被丢弃的那 5 块范围内 —— 刀片恰好立在原点角落，于是画面里只剩一小条刀。

关键数字（480×270，t=2.5，`--isolate`）：

| 量 | 值 |
|---|---|
| 仅第一块的**解析预测** bbox / 覆盖 | `[287,0,382,157]` / 2.92% |
| **实测** bbox / 覆盖 | `[290,0,374,157]` / **1.68%**（差 ≤8px ⇒ 取景正确） |
| 全 6 块几何覆盖 | **45.53%**（满帧） |
| 官方光照公式预测的亮像素（>2/255） | **13.37%** |
| 实测亮像素 | 1.68%，且 **100% 落在刀片掩码内** |
| 「可见但无模型」像素 | 0 ⇒ 画面里根本没有模型 |
| 光照是否被压成 0 | 否（解析光项 p50=0.3 / p95=1.5 / max=1.8） |
| 逐像素复刻 vs 实测 | 平均差 3.90/255、70.5% 完全相等、>2 像素 2178 vs 实测 2180 |

**被否证的假设**：相机插值语义（宿主 `wallpaper64.exe.c:299985-299993`：有 `timestamp` 用 timestamp，
否则 `i/(n-1)*duration` —— 与 `camera.js` 等价）、轴交换/缩放、近平面裁剪、alpha 裁切、光照归零、
光源打包。

**次要缺陷（有数字，同一路径）**：`model.js:610-619` 的 lightmap 乘了**全部**灯光（官方
`assets/shaders/generic.frag:85-89` 只乘 `light[0]`）；`model.js:573-580` 把切线空间法线当世界法线
用（官方 `generic.vert:63-69` 用 `BuildTangentSpace` 把光/视方向变换进切线空间）；`model.js:622-627`
的环境光用了法线贴图法线（官方用顶点法线，影响 <2%）。三处叠加使刀片亮度中位数 5.1 → 3.4。

**修法与验收**：`mdl.js` 循环解析全部块（**每块独立判 stride**）+
`model.js` 每块各取材质各光栅化；**MDLV0004/0017 必须版本门控保持现状**。

### 4.1 已修与验收（已落地）

| 项 | 内容 |
|---|---|
| `mdl.js` | 单块主体抽成 `_parseStaticBlockAt()` 并返回 `{mesh,end}`；`parseMdlStatic` 返回 `{...first, submeshes:[...]}`（旧字段仍指第 1 块，调用方零破坏）；**仅 MDLV0014** 走多块，三重自检（每块解析成功 / 链末 ∈ {filesize−1, filesize} / 块数 == `u32@16>>>8`）任一不过即回退旧行为 |
| `model.js` | **关键**：`model.js:14` 原先调的是 `puppet.js:683` 的**副本** `this._parseMdlStatic`，不是 `mdl.js` 的导出 —— 只改 `mdl.js` 修不好渲染。改为 `parseMdlStatic(raw) \|\| this._parseMdlStatic(raw)`（两副本在 26 个本地 MDL 上逐字段等价：26 SAME / 0 DIFF）；`renderModel` 拆出 `_renderStaticSubmesh`，逐块各取自己的 material / 纹理 / blending / depthwrite，共享 worldM + camVP + z-buffer |

| 量（480×270，t=2.5，`--isolate`） | 修前 | 修后 |
|---|---|---|
| `pistols` 非清屏覆盖率 | 1.68% | **41.26%** |
| bbox | `[290,0,374,157]` | **`[0,0,479,269]`**（满帧） |
| 画布均值 / 唯一色 | rgb(0,0,0) / 19 | rgb(9,7,4) / 247 |
| 单帧耗时 | 108ms | 311ms |

逐子网格归因（强自证）：仅第 0 块 = **1.68%**，与修前整帧同值；planks 34.96%、Pistol0101 5.38%、
goldmetal 0.74%、Pistol0102 0.36%、Pistol0103 0.33%。

**真值不退化**（用 `git checkout` 真回退后做 before/after）：workshop `431960` 抽 5 个场景
**全画布 SHA-256 逐位一致**；defaultprojects 里**只有 arsenal 变化**（audiophile=MDLV0004、
techno=MDLV0023 及其余 11 个单块场景逐位不变）。`verify-mdla` / `verify-scene` / `verify-client` /
`npm run verify` 全绿，**未改任何断言**。

**与首轮取证不符的 2 处（已按后者修正）**：`body.mdl` 的 6 块**全是 stride 48**（不是 48/56/64 混合）；
旧 UV 判据无法验证 `orbitaleffects` 第 2 块（其 UV 是合法平铺坐标，u∈[-6.6,7.75]），改用
"索引全量合法 + 整除"后 3 块全部解析。

**未决**：MDLV0004/0017/0023 仍单块（本地无 MDLV0017 样本，门控保守回退 ⇒ 未知变体最坏 = 旧行为）；
透明/多块 additive 的跨子网格排序未验证。


---

## 4.5 着色器数学核对（deep_space / beach / eagleflag）

子代理逐行核对官方 `assets/shaders/` 与场景自带的 `shaders/` 副本（报告 `.test-cache/audit-shaders.md`），
量化方式是对同一贴图/uniform/t 逐像素跑两版实现：

| 着色器 | 结论 | 量化差异 |
|---|---|---|
| `swayimage`（beach/palms, deep_space） | **完全等价** | mean 0.104/255，超阈像素 0.09% — 不用修 |
| `flowimage` variant B（beach 单层） | **整幅纯黑**（见下） | 修前 mean 差 **135.5/255**、75.06% 超阈 |
| `flowimage` variant A（deep_space 多层） | 合成模型错（Power 权重 / 1-N 平均 / 常量 alpha） | mean **27.996/255**、65.94% 超阈；按官方修正后 0.093 |
| `genericimage`（beach/clouds 等） | **`Scroll 1/2` 完全未实现**（全库 grep 零命中），`Bright/Alpha/Power` 材质常量未接 | scroll 未滚动；clouds alpha 用 1 而非 0.26 → alpha 差 **188.7/255** |
| `flag`（eagleflag） | **唯一错误是 `DecompressNormal`**；其余 15 项逐字一致 | mean **12.36/255**、65.11% 超阈；交叉验证 100% 归因于法线解码 |
| 最终 blit（`canvas.js:74,78`） | 最近邻（官方双线性 + 三线性 mip + 各向异性 8） | eagle mean 6.788/255、58.58% 超阈 |

### 已修：beach 背景整幅纯黑（P0）

`model.js` 旧过滤 `textures.filter((t, i) => t && i !== flowIdx && i !== (flowIdx === 0 ? -1 : 0))`
在 beach（材质 `textures=["beach","flowmask"]` ⇒ `flowIdx=1`）时把**基准层 `i=0` 也一起排除**
⇒ `layers=[]` ⇒ `_shadeFlowImage` 返回 `[0,0,0,1]` ⇒ **不透明的纯黑满屏**。
已按官方两个变体重写（变体 A：mask 在 0、中心 (0.5,0.5)、基准 `g_Texture1`、逐层
`blendLayers`（rgb 以该层 alpha 混合、alpha 取 max）、第 3 层相位 +0.3333；变体 B：mask 在 1、
中心 (0.506,0.482)、`mix(tex0(uv+o1), tex0(uv+o2), blend)*Bright`）。

| 场景（240×135，t=2.5） | 修前均值 | 修后均值 |
|---|---|---|
| **beach** | rgb(32,26,18)（背景黑） | **rgb(149.8,125.7,106.8)** |
| deep_space | rgb(86,71,72)@480 | rgb(93.3,76.2,78.1)（逐像素误差按离线参考从 27.996 → 0.093/255） |

### 已修：eagleflag 的 `DecompressNormal`（法线贴图解码）

官方 `common_fragment.h:19-32` 按 `TEX1FORMAT` 分支解码法线：

| 格式 | 公式 |
|---|---|
| DXT5/DXT3/ETC1/ETC2/DXT1/BC7（`3..7`、`12`） | `x = G*2-1`，`y = A*2-0.965` |
| RG88（`8`） | `x = R*2-1`，`y = G*2-1` |
| 其它（RGBA8888 等） | `x = A*2-1`，`y = G*2-1` |
| 统一 | `z = sqrt(saturate(1 - x² - y²))` |

旧实现用 `(R,G,B)*2-1` 且把第三通道当 z。实测 `flag_normal.tex` 是 DXT5（format=4）且
`R≡255、B≡0` ⇒ 旧实现 `x≡+1`、`z≡-1`，**n.x 的可用变化幅度只有官方的 1/147**
（1.78e-3 vs 0.2618），旗帜褶皱几乎不动。已修：
* `core.js` 把容器像素格式暴露到纹理对象上（`texMip0Info(raw, { metaOnly: true })`，只解析头、
  不解压；原先只有带 `opts.time` 的调用才走到那个分支，而法线贴图恰恰不带）；
* `image.js` `_flagImage` 按 format 选官方分支，并在 format 缺失时用**法线有效性判据**
  （`x²+y²>1` 的比例，两个候选取小者）兜底。

复测：`flag_normal` 的 `format=4` 已可取到；eagleflag 全帧均值 rgb(62.8,61.9,51.1) →
rgb(51.3,50.7,41.8)（法线扰动幅度回到官方量级后褶皱明暗对比变强）。

### 未修（已量化，待排期）

1. `genericimage` 的 `Scroll 1/2`（beach 云层漂移、alpha 0.26）——**能力缺口**，不是取整误差。
2. `flowimage` 被列入 `_customShaders` ⇒ 走 `_renderFullscreenShader` 全屏 quad，**忽略
   origin/scale/angles**（deep_space Δu 0.0961 = 185 texel、丢掉 -3.667° 旋转；beach 纵向
   拉伸 1.2184×、宽高比失真 0.8438×）。
3. 最终 blit 的最近邻采样（`canvas.js:74,78`；官方双线性 + 三线性 mip + 各向异性 8；
   eagle mean 6.788/255、58.58% 超阈）。



---

## 5. 零贡献对象：已定性（含两个被推翻的猜测）

> 方法学前提（子代理实测）：**必须冻结 `Date.now()` 再用全帧消融**，否则"隐藏任意对象"的差集恒
> ~2500px（时间漂移）；并且要用一个**确定不可见**的对象做零假设校验。
> 另外 `--isolate`（只显示单个对象）对 `colorBlendMode > 0` 的对象**口径失效**。

### 5.1 `dna_fragment/particles` 零产出 = **渲染器真缺陷**（已修）

`particles.js` 的 `_drawParticles` **只在场景带 `general.orthogonalprojection` 时做坐标映射**
（`particles.js:95-99`），其余情况把**世界坐标直接当画布像素**（`particles.js:462-463`、`249-250`
的 `pos=[wx, H-wy]`），而官方（`common_particles.h` / `genericparticle.vert:88-89`）是**过 MVP 投影**。
`dna_fragment` 是透视相机，12 个存活粒子的 `x∈[-0.5,0.5]、y≈270` 被当像素 ⇒ 全部越界 ⇒ **写出 0 像素**。

| 量（480×270，t=2.5，`--isolate`） | 修前 | 修后 |
|---|---|---|
| `particles` 非清屏 | **0.00%** | **0.82%**（1063 px，maxCh 0→255） |
| bbox | —（无像素） | `[112,166,163,269]` |
| 落屏粒子 / 像素尺寸 | 0 / — | 10/12 / 3.0–17.6px |

实现：`_drawParticles` 三分支（正交 / 透视 / 无相机矩阵）；透视 `clip = mat4TransformPoint(camVP, …)`，
`clip[3] <= 0` 跳过，`x=(clip.x*0.5+0.5)*W`、`y=(0.5-clip.y*0.5)*H`，
像素尺寸 `= size·|camProj[5]|·H/(2|clip.w|)`（size 钳制只作用于投影后的值）。
**正交分支与原实现逐字符等价**：`shimmering_particles` t=2.5 与 t=60 全帧 0 差异字节，
t=60 的 dust motes 隔离帧（129524 非清屏 px，确实走正交粒子分支）同样 0 差异字节。

> ⚠ 审计首轮给出的建议片段用的是 `clip[0]/clip[3]`，而 `mat4TransformPoint` **已做过透视除法** ⇒
> 会二次除 w（把粒子拉向画面中心）。实现按 `model.js` 的单次口径，故屏幕 x 区间与首轮表格不同
> （两者都在画布内）。**那两处公式不要原样复用。**

### 5.2 `razer_bedroom` 的 5 个「0.00%」= **隔离口径失效，不是被吃掉**（已澄清）

它们都是 `colorBlendMode = 11`（底色依赖叠加：`scene.json:531/576/621/670/759` →
`image.js:200-201` → `canvas.js:84-95`；官方 `genericimage2.frag:162-168` 用帧缓冲做 screen 混合），
隔离帧底色为黑 ⇒ `Overlay(0, src) ≡ 0`。冻结时间后的全帧消融：

| 对象 | 消融像素 | 备注 |
|---|---|---|
| glow4 / glow1 / glow3 / glow2 / NEON | 592 / 742 / 610 / 923 / **22** | 100% 落在各自矩形内 |
| hue-bulb | 22 | 贴图 α>8 仅 1.2% ⇒ 本就极弱，自洽 |
| **LED controller**（真不可见，零假设校验） | **0** | 校验通过 ✓ |

### 5.3 `glow1` 的 `tint`「整幅单色」判据**误杀**（已修）

官方 `common_blending.h:146` `BlendTint = max(rgb)·tintColor`；当贴图所有采样点 `max(rgb)=255` 时，
输出**必然**是整幅单色 RGB + alpha 形状（实测该贴图 100% 采样点 `max(rgb)=255`，输出 RGB 唯一=1、
alpha 唯一=198），却被 `effects.js` 的 `flat` 判据判为退化并回退原图。已修：判据改为
**RGBA 全图同值**（`sa.uniRgba && !sb.uniRgba`）。验收：`glow1` 的「输出退化」日志 **1 → 0**，
全帧差 400px / max|Δ|=255（bbox 落在 glow1 矩形内），**其它 17 个对象逐字节不变**；
`razer_vortex/THS` 是同一误杀的第 2 个受害者，同样修复（全帧差 179px）。


### 5.4 顺带查出的另外 3 个真缺陷（已量化，未修）

| # | 位置 | 现象（数字） |
|---|---|---|
| ① | `bloom.js:207-214`（及 67/78-84） | HDR 分支把 `lin(albedo)` 直接写进 8bit 画布，而 `scene-render-worker.mjs:98/129/146` 直接 `encodePng`、**全链路没有 linear→sRGB** ⇒ `razer_bedroom`（hdr=true）整帧均值 19.51 → **3.14**（k=0.2709，96.00% 像素逐字节等于 sRGB→linear(源)） |
| ② | `image.js:183-188`（及 261-263） | 旋转分支走 `blitRotated`，而 `canvas.js:113` 的 `blitRotated` **没有 blendMode 形参** ⇒ 静默丢弃 `colorBlendMode`（id265 wave：`angles z=-0.555`、`cbm=12`，隔离 1.262% vs 应为 0；同几何 cbm12 vs cbm0 全帧差 499px / max163） |
| ③ | 6 个 tint color 脚本用 `Date.now()` | 同一 `t` 两次渲染差 **2631 字节 / 1787px**（冻结后为 0）⇒ 帧缓存键与逐帧一致性受影响 |


---

## 6. 顺带发现（同族，影响面更大）

* **主文件名硬编码**（D2）砸掉 4 个官方场景，且失败发生在读场景阶段。修复面小
  （把已知的 `project.json.file` 透传下去），收益确定。
* 质量门对**法线/遮罩类纹理**的 `gray=100%` 拒收会把主纹理模式打到回退，例如
  `neon_sunset`（`materials/neonsun/neonsun.tex`）、`shimmering_particles`
  （`materials/particle/dustmote.tex`）、`3640755971`（`pulse__mask_*.tex`）——
  属于有损路线的行为，记在此处以免与完整渲染缺陷混淆。

---

## 8. 第二轮：用户报告的三类症状（过暗 / 马赛克 / 回退缩略图）

用户报告 Arsenal、Beach、Deep Space、DNA Fragment、Razer Bedroom、Retro、Ricepod、Sheep、
Shimmering Particles 仍"过暗（疑似缺少光源）、马赛克（普遍是背景）、失败回退缩略图"。
三类症状各自转成可判定量（`scripts/tmp-symptom-probe.mjs`、`tmp-dark-probe.mjs`）：

### 8.1 马赛克 = 绘制采样是最近邻且不做 mip（背景恰好是缩放倍数最大的层）

`DSH_WE_PROFILE=1` 下的 `renderer._drawArea`（已解码像素 / 实际绘制像素，1920×1080，t=2.5）：

| 场景/图层 | tex px | drawn px | 比值 |
|---|---|---|---|
| beach `clouds` | 65536（256×256） | 3841349 | **放大 58.6×** |
| razer_bedroom `backgroundclear` | 64 | 433448 | **放大 6772×** |
| razer_bedroom `wave` | 1024 | 68878 | 放大 67× |
| beach `palms` | 1572864 | 2674523 | 放大 1.70× |
| deep_space `galaxy_2_base` | 2073600 | 2509056 | 放大 1.21× |
| shimmering_particles `grad` | 16384（256×64） | ~1920×1080 | 放大 ~8× |
| razer_bedroom `new_wall_combined4k` | 8294400 | 2073600 | **缩小 4.0×**（无 mip ⇒ 锯齿） |
| retro `retro` | 4194304 | 907852 | **缩小 4.62×** |

官方采样是双线性 + 三线性 mip + 各向异性 8。离线量化：最近邻相对官方 mean 差 6.788/255、
58.58% 像素超 2/255 阈值。**"背景马赛克"由此完全解释**（背景层缩放倍数最大）。

### 8.2 过暗 = 两个独立机制（都不是贴图解码问题）

**(a) 先排除解码**：用官方随项目发布的 **PNG 源图**逐像素校验 `.tex` 解码
（`scripts/tmp-pairs.mjs`，同尺寸对照 42 对）：**37/42 逐通道平均差 ≤2**；唯二大偏差是
`flag_normal` / `planks_normal` —— 那是法线贴图的**打包差异**（源 PNG 是标准 RGBA 法线图，
编译后 DXT5 把 x/y 放进 G/A，官方着色器按 `TEX1FORMAT` 解码），不是解码错误。
⇒ **排除"贴图解出来就黑"这一整类假设**，并反证 §4.5 的 `DecompressNormal` 修法方向正确。

**(b) `hdr=true` 场景的 bloom 段写线性值**：`razer_bedroom` **bloom 开 4.58 / 关 20.35**
（压暗 4.4×），96.00% 像素逐字节等于 `sRGB→linear(源)`（k=0.2709）。

**(c) 三维场景"缺少光源"式全黑**：`ricepod` 全帧均值 **0.3/255**、6 个对象逐个隔离都是 0.0 ——
场景数据是 `ambientcolor=0`、`skylightcolor=0`、**没有灯**，材质全是壁纸自带的**自定义着色器**
（`ricepod` / `skybox` / `ricepodjet` / `ricepodorbitalaurora` / `ricepodorbitalthunder`，多带
`blending: additive`，其中 `separatistship_engine` 还有 `combos: {selfillum: 1}`）⇒ 官方靠**自发光**；
插件对这些未实现的着色器落到通用受光分支 ⇒ 环境项为 0 ⇒ 必然黑。`arsenal` 同族但没那么极端
（均值 6.4，`ambient=0` + `skylight=0.396 0.329 0.200` + 2 个点光）。

### 8.3 回退缩略图 = 空帧门禁 + 场景语义

**`shimmering_particles`**：场景有 **WE 的 `visible.user.condition` 机制**（`project.json` 的
`style` combo 默认 `"0"`）：`grad` 与 3 个 `small_motes_copy1` 的 `condition="1"` ⇒ **正确地被隐藏**，
唯一可见内容是 `dust motes` 粒子系统。而粒子在 **t=2.5 / 10 / 30 全是 0 像素，t=60 才满帧
（129600px）** ⇒ 生产路径 t=2.5 的帧真的空白 → `lib/index.js` 的门禁
`result.diff < result.checked * 0.0005` 判失败 → **回退成缩略图**。

**`sheep`**：应用型壁纸（`.exe`），插件无法内嵌 —— 现在类型判定已修（`application`），
界面也明确标注"应用型壁纸（本插件不支持渲染）"，不再反复排注定失败的渲染任务。

### 8.5 第二轮验收（全部以生产路径/直接渲染实测）

| 壁纸 | 修前（均值亮度@1920×1080,t=2.5） | 修后 | 说明 |
|---|---|---|---|
| razer_bedroom | 4.6（bloom 压暗 4.4×） | **20.4** | bloom 段补 linear→sRGB；关/开比 4.5944 → 1.0000 |
| ricepod | **0.3**（6 个对象全 0） | **68.1**（Skybox 0→7.8、orbit FX 0→48.0、Ricepod 0→3.3） | 逐行复刻壁纸自带 5 个着色器 + `selfillum` + generic 光照公式 + `depthwriting` 别名 |
| shimmering_particles | 0.0 + **回退缩略图** | **生产路径改用 t=60**：diff 99.961%、非零 100%、均值 205.1 | 粒子稳态取帧（候选 [60, …]；实测 `starttime+lifetimeMax=120` 反而是空帧） |
| beach / deep_space | 127.8 / 82.5 | 128.2 / 82.5 | 采样改双线性/盒式后与官方语义参考的逐像素差 **0/0%**（beach 修前 2.445/15.87%） |
| arsenal | 6.4（几何 41.26% 覆盖） | 3.7（几何不回归：足迹 41.54%、bbox 满帧） | 光照改为官方公式后更暗是**正确**的（`ambientcolor=0`）；官方 preview 均值 63.1 属另一时刻（其 225s 相机路径的最佳时刻 t≈65 预测 34.8） |
| dna_fragment / retro | 44.7 / 42.1 | 44.7 / 42.1 | 本轮未动：`curve`/`bgfade`（0.8/10.9）与 `retro`（7.0）的着色器数学**尚未逐行核对** |
| sheep | 构造失败 | 不进入渲染（application），UI 明确标注 | 设计如此 |

**验收**：`npm run verify` exit 0；`verify-scene` 22/22；`verify-mdla` 21/0；`verify-client` 全绿；
官方 19 个 defaultprojects 逐字节对照 **17/19 一致**（仅 arsenal 与 ricepod 变化 = 目标）；
`hdr≠true` 场景 14 个逐字节不变；1:1 绘制 4608/4608 逐字节不变。

**缓存必须失效**：`PIPELINE_VERSION` 已 `sf35a → sf36a` —— 否则用户仍会命中旧的暗帧/马赛克帧。

### 8.6 本轮新增的仍待办

| # | 缺陷 | 现状 |
|---|---|---|
| T11 | **静态帧取样时刻策略** | 固定 t=2.5 对长动画场景不具代表性（arsenal 的 225s 相机路径落在开场暗景；shimmering 靠"空白→t=60"特判绕过）。建议按内容度量选时刻（或按场景 `starttime`/动画时长） |
| T12 | `audiophile` / `techno` / `fantasticcar` | 主文件名修复后**已能渲染**，但被空帧门禁判失败（非粒子型，本轮未处理） |
| T13 | `retro` / `dna_fragment` 的着色器数学 | `retro`（7.0）、`curve`（0.8/1.1）、`bgfade`（10.9）尚未逐行核对官方 `shaders/*.frag` |
| T14 | `blitRotated` 仍点采样 | 旋转图层缩小时依旧马赛克（本轮只修了 `blitScaled`） |
| T15 | sprite 对象不渲染 / 粒子 `maxcount` 语义（累计发射数） | 见 `.test-cache/fix-particles-light.md` 未决点 |


### 8.4 本轮新增的修复

| # | 缺陷 | 修前 → 修后 |
|---|---|---|
| D10 | 绘制采样最近邻 + 无 mip（马赛克） | **已修**（`canvas.js`：放大双线性、缩小盒式面积预滤波、边缘 CLAMP）。与官方语义参考的逐像素差：beach 2.445/15.87% → **0/0%**、deep_space 0.575 → 0、retro 0.116 → 0；块状度（隔离 clouds）adjRMS 0.986 → 0.372、硬台阶 0.36% → 0%；顺带确认 `backgroundclear`（6772×）是 8×8 恒定色，**不是**马赛克来源。1:1 绘制 4608/4608 逐字节不变；4K 整帧 +1.4%~+4.1%。报告 `.test-cache/fix-mosaic.md` |
| D11 | `hdr=true` 的 bloom 段缺 linear→sRGB（过暗） | **已修**：razer_bedroom 关/开 **4.5944 → 1.0000**（均值 4.46 → 20.50）、"逐字节==lin(源)" **96.00% → 0.12%**；14 个 `hdr≠true` 场景逐字节不变。**仅 2 个官方场景 `hdr=true`**（razer_bedroom / shimmering_particles），`demon_core`/`neon_sunset`/`arsenal` 的 scene.json 根本没有 `hdr` 键（走 LDR，本就没被压暗）。报告 `.test-cache/fix-bloom-srgb.md` |
| D12 | 粒子型壁纸在 t=2.5 空白 → 误判失败回退 | **已修**：worker 仅在"空白 + 按 condition 可见的粒子系统"时按场景数据重试更晚时刻（60 优先）⇒ 生产路径 diff **0 → 99.961%**、非零 100%、均值 205.1 |
| D13 | 三维场景缺自发光/光源处理（ricepod 全黑） | **已修**：ricepod 0.30 → **69.55**；generic 光照 4 处按官方源码改正（lightmap 只乘 `light[0]`、切线空间、环境用顶点法线、`DecompressNormal` 按 `TEX1FORMAT` 取通道）+ 逐行复刻壁纸自带 5 个 shader + `depthwriting` 别名 |
| D14 | Sheep 的应用型诊断（UI 诚实化） | 当前壁纸面板显示"应用型壁纸（本插件不支持渲染，仅预览图）" + 类型标签 |
| D15 | **生产路径把主文件名换成目录**（宿主侧） | ricepod/audiophile/fantasticcar/techno 在生产路径必失败（配置修复永不生效）→ 已在 worker 按 `project.json.file` 补回；ricepod 生产从"渲染失败"→ diff **71.584%** 通过 |
| D16 | `visible.user.condition` 语义（WE 的 style 槽） | `core.js` `_isVisibleSelf` 改为 `String(userProps[name]) === String(condition)`；真值表 8/8、官方语料差异 0 |

> **shimmering_particles 的机制收窄**（强制可见性实验，240×135）：t=2.5 强制全部可见 mean=200.27；
> 仅 `grad`=200.27；仅 `dust motes`=**0.00**；t=60 仅 `dust motes`=208.01。
> ⇒ `grad` 层没坏，它是被 `visible.user.condition` **正确隐藏**的（`style=0`=Large 风格）；
> t=2.5 全黑的原因是"唯一可见的粒子当时还没生成粒子"。修法建立在**按 condition 判定后的可见集合**上。

---

## 9. 第三轮：用户报告"三张新增问题 + 其余不变"

### 9.1 三张"新增问题"的机制：不是渲染错，是**回退链走到了主纹理提取**

用户描述"似乎只显示某个材质而非真正渲染" —— 宿主日志原文即是答案：

```
scene 渲染失败 → 已回退主纹理: fantasticcar/fantasticcar.json dims= 1024x1024 served= …fb.png
scene 渲染失败 → 已回退主纹理: techno/techno.json        dims=  256x256 served= …fb.png
```
实测这三张的完整渲染当时是**平色帧**（唯一色 = 1）：fantasticcar 0.0、techno 23.0、audiophile 13.0
⇒ 空帧门禁判失败 ⇒ 回退链挑了一张材质贴图。**修好主文件名之前提取器也失败**，所以退到官方
preview（好看）；提取器能读场景之后反而露出单张材质 —— 是"暴露"而非"新引入"，但观感是回归。

**止血（已落地）**：`scene-manifest.js` 早有"3D 场景不能按 2D 提取"的拒绝，生产用的
`pkg-extract.js` 那份漏了。补上后 techno/fantasticcar/ricepod 一律拒绝提取（2D 场景不受影响：
beach 仍产出 `1920x1080 composite(3 layers)`），回退链重新落到官方 preview。
`PIPELINE_VERSION → sf36b`。

### 9.2 三张的完整渲染：根因是 **6 个叠加缺陷**，不止着色器

| # | 缺陷 | 后果 |
|---|---|---|
| ① | 10 个壁纸自带着色器（techno 3 / audiophile 3 / car、dome、grid、shadow）未实现 | 落到 generic 受光分支 × `ambient=0` ⇒ 全黑 |
| ② | 材质无 `textures` 键时 `pass.textures[1]` 抛异常 | Dome/Shadow/bars **整个对象不画** |
| ③ | `glass.json` 含 `//` 注释使 `JSON.parse` 抛错 | Car **5/6 子网格丢失** |
| ④ | MDLV0023 的 AABB 块头 / MDLV0004 多 skin 解析失败 | techno 3/4 对象 + audiophile `grid` **整体丢弃** |
| ⑤ | `renderOrder` 按 `o.id` 去重（手写 scene JSON 无 `id`） | techno `objects=4 / renderOrder=1`；audiophile 只剩 bars |
| ⑥ | CPU 光栅化器**缺近裁剪面** | 跨相机三角形 11 倍过绘，把 techno 加亮到 194 |

修后（480×270，t=2.5）：techno 23.0 → **48.5**（唯一色 1 → **9617**，门禁 0 → 0.3637 PASS）；
audiophile 13.0 → **16.7**（1 → 414，0.0603 PASS）；fantasticcar 0.0 → **140.3**（1 → **9769**，0.9725 PASS）；
生产 worker 路径同样全部过关；与官方源码独立直译的逐点 oracle **16 组 max|Δ| ≤ 1e-9**；
19 个 defaultprojects 逐帧 SHA-256 **只有这 3 个变化**。

> **audiophile 偏暗是官方公式在 audio=0 下的正确结果**：`audiophileglow.vert:17-19`
> `position.xy *= audio`、`audiophile.vert:26-27` 竖条顶部按 `a_Position.y*audio`。注入诊断频谱
> 0.55 后 glow 0% → **80.83%**、bars 0.12% → **81.65%**（否证完成）。生产路径不注入音频，未伪造。
> **未决**：grid 地板缺"镜像车/天空"——官方 `_rt_Reflection` 来自镜像相机 pass，插件 `_rt_` 是当前
> 画布快照（`core.js:259-270`），需要新增反射 pass。

### 9.3 粒子寿命缺陷：真缺陷、已修，但**不是**糊状的原因（否证）

`lifetimerandom` 只写 `p.life`、`_stepParticles` 用 `p.lifetime` 判死 ⇒ 粒子恒不死、`sys.count` 只增
⇒ 池满后永久停发（修前 t=60：存活 200、`lifetime === undefined` 200/200）。
官方依据（**引擎粒子逻辑在 `wallpaper64.exe`，不在 `scenescript64.dll`**）：`CParticle.h:46/77/79`、
`CParticle.cpp:58-65/307-320/395/461`、`wallpaper64.exe.c:330442`（maxcount 缺省 10）。
修后 `t=120` 由「0.09 均值 / 11 色 / 被拒收」→「191.6 / 12610 色 / 99.42% 通过」；
`dna_fragment`、`demon_core` 的粒子层从永久空白恢复为持续回收。
**但 t=60 帧修前修后逐字节相同**（只推进 10s，无粒子活到 48–70s 寿命）⇒ 与糊状无关。

### 9.4 糊状真因 = 加性累积硬裁剪；**已修**（HDR 累积层）

量化：`sizerandom 80–2000` × 200 颗 × additive = **47.2 层/像素**，8bit 画布硬裁剪在 176–255 档。
已实现 `canvas.js` 的 Float32 线性光累加层（`addLight/additiveCommit`，链尾照
`combine_hdr.frag:40-44` 一次做 `saturate×曝光 + linear→sRGB`）+ `particles.js` 按 `general.hdr` 分流
additive 通道。shimmering_particles t=60 @3840×720：

| 量 | 修前 | 修后 |
|---|---|---|
| 均值亮度 | 202.87 | 153.65 |
| **唯一色** | 23642 | **45721** |
| 全白像素 | 3.42% | **0.00%** |
| 任一分量 ≥250 | 91.75% | **57.24%** |
| 直方图熵 | 5.41 bit | **6.95 bit** |
| 生产管线自己的 `isWashed` 判据 | ★过曝糊★（评分 2.862） | 非糊（**4.778**） |
| 生产 worker 采用时刻 | 弃用 t=60 改 t=200 | 直接采用 **t=60**（门禁 99.921%，5 次同 SHA） |

非加性路径逐字节不变：两棵只差这 2 个文件的冻结树同进程 A/B，960×180 与 1920×540 各 45 格中
**39 格相同**，变化仅 shimmering_particles。

### 9.5 取样时刻策略（T11）：已改成按内容度量选点

规则：**请求时刻先按生产尺寸渲染一次**（与旧代码同路径）→ 尺度无关的内容度量判定"健康"；
**健康 ⇒ 直接采用，一个探针都不做**（正常场景"逐字节不变"是**结构保证**，不是事后比对）；
不健康 ⇒ 在小探针帧上量化候选时刻（含相机路径分位；arsenal 路径总长实测 **225s**）取最优。

8 个验收场景：**7 个原本正常的仍取 t=2.5 且全帧 SHA-256 逐字节相同**；
`arsenal` 2.5 → **200**（均值 4.08 → **23.54**/255，非清屏 5.1% → **35.2%**）。
代价：退化场景多渲染一次生产帧（arsenal 5.4s → 33.0s、audiophile 3.7s → 7.1s）。

### 9.6 第三轮验收

`npm run verify` **exit 0**（曾有并发改动把临时基线快照落在 `lib/` 下导致
`verify-package-files` P1 失败，已清理）；`verify-scene` **22/22**（含 C1–C4）；`verify-mdla` 21/0；
`verify-client` 通过。修复报告：`.test-cache/fix-{3d-shaders,particle-life,hdr-accum,sampling-time}.md`。

---

## 7. 首轮快照：已落地 / 仍待办（2026-10-03）

> ⚠️ **本节是首轮审计的快照，且章节序号排在 §8/§9 之后**（原文按轮次追加），容易被误读成"最新状态"。
> 2026-09-23 复核：下表"仍待办"里 **T1（genericimage Scroll 1/2）、T2（flowimage 全屏 quad）、
> T3（bloom HDR 线性值）、T5（最终 blit 最近邻）、T7（p.lifetime）、T8（粒子世界 z）、T14（blitRotated
> 点采样）七条均已被代码修掉**（见 §8.4 / §9.3 / §10.2 的追记）；仍有效的只有 T4（`blitRotated`
> 缺 `blendMode` 形参）与 T9（`pkg-extract.js` 仍用 `Math.random()` 抽样）。行号、`verify-scene` 的
> 检查条数与 `PIPELINE_VERSION` 一律**以代码为准**（当时记 sf35a→sf36a，现为 `sf45`）。
> 正文保留作当时的证据记录。

### 已落地（本轮全部）

| # | 缺陷 | 改动 | 护栏 |
|---|---|---|---|
| D1 | Sheep 被判成 scene | `index.js` `inferType()`：`.exe → application`（并导出该纯函数）；`src/client.js`：application 走预览图 | verify-scene C3 / C3b |
| D2 | 主文件名硬编码 `scene.json` | `core.js` 记住并读取声明主文件名（`opts.sceneFile` 可覆盖）；`pkg-extract.js` 两个入口接收 `sceneFile` 并对 `project.json.file` 兜底；`index.js` 传 `basename(abs)`；`readSceneJsonFast`/`sceneAspect` 同步 | verify-scene C1（4/4） |
| D3 | 正交静态 eye 平移 2D 图层（eagleflag 583px@4K） | `camera.js` `_camPathDriven` + `_viewShift()` 正交静态分支返回 `[0,0]` | verify-scene C2（≥99% 且左边界 0） |
| D4 | 松散项目读不到 `project.json` 用户属性 | `core.js` `_readUserProps()`：目录自身优先、父目录兜底 | 现场校验（eagleflag 配色 / razer light_speed 已读到） |
| D5 | beach 背景整幅纯黑（`flowimage` 变体 B） | `model.js` `_shadeFlowImage()` 按官方两变体重写 | verify-scene C4（平均亮度 ≥100） |
| D6 | eagleflag 法线解码三通道全错 | `image.js` 按 `TEX1FORMAT` 分支（+ `core.js` 暴露纹理 format，`texMip0Info(metaOnly)`） | 现场：`flag_normal format=4` 可取到 |
| D7 | Arsenal 只画第一块网格 | `mdl.js` 多块解析（三重自检 + 版本门控 MDLV0014）+ `model.js` 逐块材质光栅化（并改用 `mdl.js` 的导出而非 `puppet.js` 里的副本） | verify-mdla 21/0；workshop 5 场景 SHA-256 逐位一致 |
| D8 | 透视场景粒子零产出 | `particles.js` `_drawParticles` 加 camVP 透视分支（正交分支逐字符等价，shimmering 逐字节一致） | verify-scene / verify-client 全绿 |
| D9 | `tint` 退化判据误杀单色输出 | `effects.js` 判据改为 RGBA 全图同值 | verify-fx-chain 12/0；其它 17 对象逐字节不变 |

`npm run verify` exit 0；`verify-scene` 22/22（含 Level C 的 C1–C4）；`verify-mdla` 21/0；
`verify-fx-chain` 12/0；`verify-client` 全绿。**过程中未改弱任何既有断言。**


### 仍待办（全部已定位 + 已量化，按影响排序）

| # | 缺陷 | 位置 | 量化 |
|---|---|---|---|
| T1 | `genericimage` 的 `Scroll 1/2` **完全未实现**，`Bright/Alpha/Power` 材质常量未接 | `image.js` / `model.js` | beach 云层不漂移；alpha 用 1 而非 0.26 ⇒ alpha 差 **188.7/255**（覆盖 48.4%） |
| T2 | `flowimage` 被列入 `_customShaders` ⇒ 走全屏 quad，**忽略 origin/scale/angles** | `image.js:491` → `_renderFullscreenShader` | deep_space Δu 0.0961（185 texel）、丢 -3.667° 旋转；beach 纵向拉伸 1.2184×、宽高比失真 0.8438× |
| T3 | `bloom.js` HDR 分支写线性值，而全链路无 linear→sRGB | `bloom.js:207-214`（及 67/78-84） | razer_bedroom 整帧均值 19.51 → **3.14**（k=0.2709，96.00% 逐字节 = sRGB→linear(源)） |
| T4 | `blitRotated` 无 `blendMode` 形参 ⇒ 旋转分支丢 `colorBlendMode` | `canvas.js:113` + `image.js:183-188/261-263` | id265 wave（cbm=12）：隔离 1.262% vs 应 0；同几何 cbm12 vs cbm0 全帧差 499px |
| T5 | 最终 blit 用最近邻（官方双线性 + 三线性 mip + 各向异性 8） | `canvas.js:74,78` | eagle mean 6.788/255、58.58% 超阈 |
| T6 | 6 个 tint color 脚本用 `Date.now()` ⇒ 渲染不可复现 | 场景脚本 | 同 t 两次渲染差 **2631 字节 / 1787px**（冻结后 0） |
| T7 | `p.lifetime` 未被赋值（`lifetimerandom` 只写 `p.life`）⇒ 粒子永不移除、`sys.count` 不减 ⇒ 达 `maxcount` 后**永久停发** | `particles.js` `_stepParticles` | dna_fragment t=60：存活 100 全 `lifeDead`、0px；demon_core 200 同理 |
| T8 | 粒子世界 z 恒为 0（`_spawnParticle` 写死），对象 `origin.z` 被丢 | `particles.js` | neon_sunset `Fog 1`（origin z=-0.824，相机朝 -z）750/750 粒子 `clip.w=0` 全跳过 |
| T9 | `frameQuality()` 用 `Math.random()` 抽样做质量门 ⇒ 同一帧两次判定可能不同 | `pkg-extract.js:1085` | razer_bedroom 同代码连跑两次 SHA-256 即不同（与渲染无关，但污染 A/B 对照） |
| T10 | 已知能力缺口（本轮未动） | `camera.js` | 正交场景**真由相机路径驱动**时只做 x 平移、不做 y 平移（未被官方帧验证）；`camera.eye` 在**透视**场景仍是 x-only 平移（沿用 sf32 用户实测） |


---

## 10. 第四轮：点名清单（Retro / Deep Space / DNA Fragment / Arsenal / Audiophile / Dino Run / Mutsumi）

### 10.1 Retro：**同名 shader `bg` 的两个实现被合并**（4.2× 暗的真根因，已修）

`retro/materials/bgfade/bgfade.json` 的 `shader: "bg"` 命中了 **dna_fragment/shaders/bg.frag** 的移植 ——
两个项目各带同名不同源的 `bg.frag`，而 `assets/shaders/` 下**没有** `bg.frag`
（retro 自带 `blobsGES3/SM40` 各 7 个已编译 blob，证明项目版被编译过）。
修法：新增 `_shadeBgRetro`（retro/shaders/bg 逐行直译），`_makeShadeFn` 按材质纹理数区分（4 张含 `g_Texture2/3`）。
次要：`g_TexelSize.y/x` 应为**画布 W/H**（lwe `CPass.cpp:883`），旧代码用 tex0 的 w/h。

| 量 | 修前 | 修后 |
|---|---|---|
| retro 全帧均值亮度 | 42.139 | **101.849**（×2.42） |
| `bgfade` 隔离层 | 38.371 | **102.723**（逐通道恰好打到 `bg.frag` 硬上界 R184/G163/B107） |

> retro 的官方 preview **不是该版本源码的输出**：preview 逐通道 R245/G226/B206 **远超硬上界**
> R184/G163/B107（92%/75%/75% 像素越界），且角落最亮与 `1/vignette` 暗角方向相反 ⇒ 未做任何
> "向 preview 提亮"的常数。

### 10.2 Deep Space 的"偏暗 24%"是**口径问题**，不是缺陷

官方 preview 是 1:1 方图，与 16:9 全帧不可直接比。改用**1:1 中心方裁**同口径后：

| 口径 | 我们 | 官方 preview |
|---|---|---|
| 1:1 中心方裁 | **108.1**（修前 104.3） | **108.2** ⇒ 差 **0.1%** |

行/列剖面逐段吻合（差 ≤5/255）。顺带修了 `flowimage` 的派发（此前丢掉对象矩形 origin(928.1,552.3)、
scale 1.117、-3.667° 旋转）。材质常数 `Bright/Alpha/Power` 已核对为默认 1（不是原因）。

### 10.3 DNA Fragment 的极暗层是**官方就该这么暗**（oracle 逐点 max|Δ| = 0）

`curve`（additive 细线）、`curve2`、`bgfade`（含 alpha=0 区域）的移植与官方逐点一致；
真实贡献量：`curve` +0.414 / 2.0% 像素，`bgfade` −7.623 / 11.2% 像素。
顺手修掉 3 条真错：`_shadeDna` 最近邻 → 双线性（oracle 修前 max|Δ|=0.117 / 12.3% 像素）、
`_dnaVertex` 的 `Math.PI` → 官方字面量 3.1416、`_shadeCurve` 的 `Freq` 默认 1 → 0。

oracle（`scripts/tmp-oracle-ds.mjs`，范式同 `.test-cache/fix-3d-shaders.md`）：
`bg`(dna)/`bg`(retro)/`curve`/`dna`/`dna-vert`/`flowimage` **逐点 max|Δ| ≤ 1e-9**（多数为 0）；
`retro.frag`（含 DOTS）**8bit 逐字节相同**。

不回归：逐帧 SHA-256 只有 retro/deep_space/dna_fragment 变化，其余 13 个场景逐字节相同；
`verify-scene` 22/0、`verify-mdla` 21/0、`verify-client` exit 0、`npm run verify` exit 0。
报告 `.test-cache/fix-retro-deepspace.md`。
