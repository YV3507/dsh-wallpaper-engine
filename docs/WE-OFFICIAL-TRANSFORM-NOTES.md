# WE 官方运行时逆向笔记（变换/动画语义）

> 适用产物：`E:\SteamLibrary\steamapps\common\wallpaper_engine\decompiled\wallpaper64.exe.c`（Ghidra 伪代码）
> 方法约束：**只读**（禁软件断点/DLL 注入 hook —— 历史上曾损坏 WE）；行号指该 `.c` 文件。
> 本文用于替代"抓帧对齐"（动态场景无法对齐、视觉不可靠）——一切结论以官方代码地址 + 纯离线数据判据为准。

## 一、已确证（含证据）

### 1.1 顶点世界变换（第一手 shader）
- `_refs/we-shaders/base/model_vertex_v1.h:147-153`：蒙皮后 `worldPosition = mul(vec4(position,1), g_ModelMatrix)`
- `_refs/we-shaders/passthroughblend.vert:19-32`：puppet 路径同样"先蒙皮 → 再 model·view·proj"
- ⇒ **world = origin + R·S·蒙皮顶点**（`g_ModelMatrix` = T·R·S，CPU 侧组装）；`canvas = world×ps`

### 1.2 MDLA 段布局（官方加载器 + 真实数据判别）
- 加载器 `wallpaper64.exe.c:437664`（`MDLA0006`）：**逐骨** `[u32 flags][u32 size][size 字节 data]`；骨0 的 `[flags][size]` 即动画头尾部的 `[u32 0][u32 segBytes]`。
- 数据：**frame-major，9 float/帧（36B）**：`[tx, ty, tz, r0, r1, r2, sx, sy, sz]`（2D 用 rz=索引5）。
- 纯离线判据（`scripts/verify-mdla.mjs`，21/21 通过）：
  - 帧0 = bind（非根骨平移/角度逐位等于 bind；根骨可整体位移）；
  - 末帧 = 帧0（循环闭合）；
  - Plana 眼动画骨 22/31 的 sy 极值 = 0.003 / 0.010（与实测吻合）。
- 消费端 `FUN_140267580`（`:440186`）：帧记录 10 通道（T3+Q4+S3），索引 `param_4*k + param_4*10*frame + bone`（`param_4`=骨数）→ **运行时缓冲是 [帧][通道][骨] 平面**（与文件的 frame-major 不同，加载器会转换）。

### 1.3 模型 JSON 的声明 → 运行时标志位（`:374282-374330`）
写入 `param_1 + 0x304`：
| 声明 | 位 |
|---|---|
| `fullscreen` | 0x2 |
| `nopadding` | 0x4 |
| **`autosize`** | **0x8** |
| `passthrough` | 0x20 |
| `solidlayer` | 0x200 |
| `projectlayer` | 0x400 |
| `instanced` | 0x800（`:374328` 处 `flags & 0x800 == 0` 才走另一分支） |

- **`autosize` 在运行时是"只写位"**：全文件无 `& 8` 读取、无清除 ⇒ 它不是"把模型拉伸到 size"的指令（实测按 size 铺满会导致整体放大/出屏，已回退 commit `a438e50`）。
- **`cropoffset`：`wallpaper64.exe` 0 引用** ⇒ 运行时不读（编辑器元数据），应忽略。

### 1.4 动画层混合函数（`:372877 / :373106 / :373451`）
- `FUN_1401f89a0`（`:372877`）— blend=1 替换路径
- `FUN_1401f9020`（`:373106`）— 普通层混合（参数含 float blend）
- `FUN_1401f9820`（`:373451`）— **additive 层**（皓风琦 N 7 层 / 十字架 3 层 / nv 8 层全走此路径）
- 层解析：`"animationlayers"` `:375094`、`:395254`；`"blendin"` `:386016/:401527`；`"blendout"` `:386059/:401570`

## 二、待逆向（下一步读取目标）

1. **additive 合成公式**：读 `FUN_1401f9820` 主体（`:373540` 之后），确认：
   - 参与混合的通道集合（平移/旋转/缩放是否同套公式）；
   - `blend` 的作用方式（加性 vs 比值）；
   - `blendin/blendout/blendtime` 如何随时间淡入淡出（`:386016` 一带的解析结果存到哪、谁消费）。
   → 目标：解释皓风琦"多数组件单方向拉伸、少数组件正常"。
2. **`nopadding`(0x4)** 的消费点（关联历史修复 `3d40c07 autosize puppet 不做声明 size 四边裁切`）。
3. **MDLA 加载器的帧→平面缓冲转换**（`:437664` 起，`FUN_140267580` 之前）：确认通道重排/是否带逐轴系数。
4. **`size` 的解析与消费**（`"size"` 读取点）：确认运行时 `size` 用于四边形/锚点/裁剪哪一项。

## 三、我方对应实现（lib/we-renderer）

| 语义 | 我方位置 | 状态 |
|---|---|---|
| MDLA 逐骨块解析 + 帧直读 | `puppet.js: _parseMdl` / `_sampleAnimRT` | ✅（verify-mdla 21/21） |
| 层可见性三形态（true/{value}/{script}） | `puppet.js: isLayerVisible` | ✅（verify-layers） |
| puppet R 绕对象原点 | `puppet.js: renderPuppet` + `canvas.js: blitRotated(pivot)` | ✅ |
| 粒子 `T(origin)·R·S` | `particles.js: _spawnParticle` | ✅ |
| `autosize`/`size` 铺满 | `puppet.js: sizeNorm` | ⛔ 已回退（默认关闭，仅 `DSH_WE_PUPPET_SIZE=1` 实验） |
| `blendtime` 淡入淡出 | — | ❌ 未实现（待 1 确认） |

## 四、验证脚本

- `scripts/verify-mdla.mjs`（帧0=bind / 循环闭合 / 眨眼骨 sy 极值）
- `scripts/verify-layers.mjs`（层可见性三形态）
- `scripts/verify-client.mjs`、`scripts/verify-transcode-state.mjs`
- 离线分析：`scripts/tmp-mdla-*.mjs`、`tmp-size-semantics*.mjs`、`tmp-scene-objects.mjs`、`tmp-model-json.mjs`、`tmp-extract-wallpapers.mjs`（均未跟踪，`.gitignore` 已含 `scripts/tmp-*.mjs`）
