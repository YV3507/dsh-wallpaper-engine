# 原生场景引擎取证（WE 2.8.42）—— 静态帧路径的几何与决策依据

> **为什么有这份文档**：静态帧链（`/scene-frame`）是对 WE 场景渲染的**离线复刻**（`lib/pkg-extract.js` 的合成器 +
> `lib/we-renderer/` 的 CPU/GPU 渲染器），它的几何、变换与图层口径必须以**原生实现**为准，不能凭"看起来对"。
> 本文记录针对 `decompiled/` 反编译产物的取证结论，以及由取证**确定**的静态帧实现缺陷。
>
> **范围（重要）**：本文只裁决**静态帧回退路径**。完整动画渲染（蒙皮 / 动画层 / 实时渲染帧内执行）**不在裁决范围**，
> 也**不应**据此改动 —— 这些部分由 `docs/DEFAULT-SCENE-RENDER-AUDIT.md` 与本仓渲染器既有取证覆盖。
>
> **源（只读）**：
> `W` = `E:\SteamLibrary\steamapps\common\wallpaper_engine\decompiled\wallpaper64.exe.c`（D3D11 渲染宿主，Ghidra 反编译）；
> `SH` = `<WE>\assets\shaders\`（官方 GLSL；团队已定为唯一 shader 真相源，第三方实现 `linux-wallpaperengine` 只作旁证）；
> `IDX` = `_refs/ghidra-proj/stringrefs.c`（字符串→引用函数索引）。
> **判定强度**：**strong** = 首方代码/资产直读并给出 `文件:行`；**inference** = 明示推断。
>
> 既有取证见 `.test-cache/native-engine-evidence.md`（含 10 项未定性清单）；本文补上其中与静态帧相关的三项。

## 1. 场景坐标系：y 轴朝上（strong）

| 事实 | 锚点 |
|---|---|
| 图像层与模型对象**共用同一套变换属性**：`origin` vec3 @0x128（x@0x128 / **y@0x12C** / z@0x130）、`scale`@0x134、`angles`@0x140、`sortorder`@0x124、`parallaxDepth`@0x170 | W:355220–355333（注册表 `FUN_1401e0530`）；运行时读法 W:291383–291388 |
| `origin`/`scale` 的 apply 是**通用 vec3 解析** `FUN_1401a4230`（与 `color`/`clearcolor` 同一函数），**无任何 y 取反** | W:355220、W:355255、W:300662 |
| 图像层构造器 `FUN_1401fac50` 只读 `material/width/height/fullscreen/nopadding/autosize/passthrough/solidlayer/projectlayer/instanced`（置 flag），**不做坐标翻转** | IDX:4218–4563 |
| `parallaxDepth` 视差用的两个屏幕轴 = `origin.x` 与 **`origin.y`**（0x128 / 0x12C）⇒ y 是垂直轴 | W:291855–291861、W:291381–291388 |
| **正交投影构造器**：`m11=2/(r−l)`、**`m22=2/(t−b)`（正）**、`m33=−1/(n−f)`、`m42=−(b+t)/(t−b)`、`m43=−f/(n−f)` ⇒ y **单调递增**、**不取反**；z∈[0,1] = D3D 约定 | **W:117685–117706**（`FUN_14009a630`） |
| **透视投影构造器**（交叉验证）：`m11=f/aspect`、**`m22=f`（f=1/tan(fov/2)，正）**、`m34=−1.0` | **W:117655–117680** |
| 正交场景的投影由渲染器 vtable `+0x18` 建造，正交时 near/far 被替换为 **−2000/+2000** | W:287519–287520、W:287496–287505 |

**结论**：两条投影路径都不对 y 取反，而 D3D 的 NDC **+y = 屏幕上方** ⇒ **场景 y 越大越靠上（y-up）**，图像层与模型对象
同处一个 y-up 空间。本仓渲染器与此一致（`lib/we-renderer/model.js:181` 的 `(0.5 − ndcY·0.5)·H`）。

## 2. 正交场景的声明（strong）

* `general.orthogonalprojection` 是**对象**（`width`/`height`），或字符串 **`"auto"`**：`auto` 为真时置渲染器 flag bit 0x18；
  否则读 `width`/`height`，任一为 0 则清 ortho 位（0x8），否则置位 —— `W:289783–289808`（`DAT_14048e4b8` = `"auto"`）。
* 场景 `general` 的其它静态帧相关键：`clearcolor`@0x35c、`clearenabled`（flag bit 0x20）、`ambientcolor`@0x368、
  `skylightcolor`@0x374（见既有取证 §1）。

## 3. 对象变换：角度单位与合成顺序（strong）

| 事实 | 锚点 |
|---|---|
| `angles` 的 apply `FUN_1401df2f0` 只做 1–3 分量**解析**（无换算），存储走 `FUN_1401dd630` | W:354394–354478、W:355290–355295 |
| `angles` 的 getter `FUN_1401df590` 输出时 **×57.29578**（180/π）⇒ **JSON 用度、内部用弧度** | W:355156–355158 |
| 合成用**半角四元数**：`sz,sy,sx = sin(θ/2)`、`cz,cy,cx = cos(θ/2)`（各分量先 `×0.017453292`）；<br>`w = cz·cy·cx + sz·sy·sx`、`x = sy·sx·cz − cy·cx·sz`、`y = cx·sy·cz + cy·sx·sz`、`z = cx·sy·sz − cy·sx·cz` | **W:387458–387472**（同构另一份 W:387491–387500） |
| 与标准 `Rz·Ry·Rx` 四元数相比，**x 与 z 分量取反** ⇒ **R = Rz(−z)·Ry(y)·Rx(−x)** | 同上（逐项比对） |
| 方法表：`getTransformMatrix` → `FUN_1401df5e0`（只把对象 vtable `+0x80` 的 4×4 拷出）、`rotateObjectSpace` → `FUN_1401df620`、`lookAt` → `FUN_1401dfc00`、`lookAtYaw` → `FUN_1401dfe30` | W:355387–355512 |

**结论**：角度是**度**、绕 **−z**；顺序与 `lib/we-renderer` 既有的 `T · Rz(−z) · Ry(y) · Rx(−x) · S` 约定一致（T·R·S 的矩阵装配在该 vtable 实现内）。

## 4. puppet：原生是蒙皮网格（strong）

| 事实 | 锚点 |
|---|---|
| 场景对象带 `model` ⇒ 走**模型资源**加载（资源指针写 object+0x2f0，与材质同一 loader） | W:394474–394521 |
| 对象带 `animationlayers` ⇒ 逐元素交给 `FUN_1401fcc20`（动画层构造器） | W:375094–375121、W:395254 |
| 图像层构造器**不读** `animationlayers`/`model`（两套键互斥） | IDX:4218–4563 vs 上两行 |

**结论**：原生里 puppet 是**蒙皮网格**，图集是网格贴图，**不存在**"把图集当一张平面图贴上去"的渲染路径。

## 5. 由取证确定的静态帧缺陷

| # | 缺陷 | 代码位置 | 原生依据 | 影响面 |
|---|---|---|---|---|
| **D-1** | 合成器**缺一次 y 翻转**：把 JSON y 当画布 y-down 直接用 | `lib/pkg-extract.js:1632`（`let cy = tr.origin[1]`） | §1（两条投影路径 m22 均正 + D3D NDC） | 所有 y 非居中的图层；只波及**有损 / 主纹理近似 / `.fb.` 兜底帧 / 档位 6**，不动默认完整渲染档 |
| **D-2** | `resolveObjectTransform` 把 `angles[2]` **当弧度且未取反**（原生：度→弧度、绕 **−z**） | `lib/pkg-extract.js:1270 / 1274–1283` | §3 | 仅**父链有非零 z 角**的对象（`tr.angle` 在函数外未被使用，影响限于子偏移累加） |
| **D-3** | 单图层候选路径把 **puppet 图集**当平面图贴 | `lib/pkg-extract.js:1322 / 1792–1850`（`puppetSkip` **当前生效**） | §4 | 含部件图集壁纸的「主纹理」候选（可选档位 1 可直接观察） |

**处置口径**：

* D-1 / D-2 是**原生已定案**的口径错误，属静态帧回退路径内的修正；改动会改变这些产物 ⇒ 需同步
  `PIPELINE_VERSION`（`lib/index.js:2393` 现为 `sf45`）或失效对应缓存（否则用户继续看到旧帧）。
* D-3 **保留现状**（`puppetSkip` 生效中；来历经 git 核实：`2d17fd5` = 0 处、上游 `d5f98e7` = 8 处 ⇒ 追版带入、
  回滚几何时未撤），只需把 §4 的原生依据写进注释 —— 原生不会把图集当平面层，故"跳过部件图集"比"平铺图集"更接近原生意图。

## 6. 未决与明确不做的事

* **未决（不影响平面合成）**：`models/*.json` 的顶点/UV 算术（既有取证 §9-1）—— 只影响 puppet 网格，平面合成器没有网格能力，故不追。
* **明确不做**：不为静态帧去实现蒙皮/动画层/完整动画渲染；不改实时渲染路线（`/scene-live`、`/scene-files`、`lib/webwallgl/`）。
  静态帧只做"离线复刻一帧"这一件事，遇到网格类图层按 D-3 的口径处理。

## 7. 复现命令（只读）

```powershell
$W='E:\SteamLibrary\steamapps\common\wallpaper_engine\decompiled\wallpaper64.exe.c'
Select-String -Path $W -Pattern 'orthogonalprojection'          # 289783 声明解析；287496 正交 near-far
Select-String -Path $W -Pattern '"origin"|"scale"|"angles"'     # 355220 / 355255 / 355290 属性注册表
Select-String -Path $W -Pattern '2\.0 / \('                     # 117689/117694 → 投影构造器 FUN_14009a630
Select-String -Path $W -Pattern '0\.017453292|57\.29578'        # 387458 组（四元数）；355156（angles getter）
Select-String -Path $W -Pattern '"animationlayers"'             # 375094 / 395254
```

取证摘录（只读，随仓库保存在 `.test-cache/`，不入包）：`native-static-frame-decisions.md`、`w-ortho.txt`、`w-proj.txt`、
`w-angles.txt`、`w-quat.txt`、`w-reg.txt`、`w-methods.txt`、`w-animlayer.txt`。
