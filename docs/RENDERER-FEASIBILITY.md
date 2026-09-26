# WE 场景渲染器三条路线可行性分析（重构 / 第三方 / 官方）

> 分析日期：2026-08-29　|　对象：`lib/we-renderer/` 服务端 SceneRenderer + 客户端 Scene Player
> 硬约束：**跨平台**（Windows / Linux(含 WSL) / macOS，宿主为 DSH 的 Electron/Node 与浏览器）
>
> ## ⚠️ 方向决策（2026-08-30）
>
> **自研动画子方向已放弃**（根因 A 框架级 + 维护打地鼠 + 分钟级渲染）。场景壁纸现行路径 =
> 静态帧（`/scene-frame`）+ 内嵌视频纹理快路径（`/scene-video`，硬件解码）；GPU 加速保留为
> 静态帧加速（`sceneGpuAccel`）。
>
> ## ⚠️ 追记（2026-09-23）
>
> 上游已把场景/网页壁纸接入 **WebWallGL 实时渲染**（`/scene-live` + `/scene-files`），成为
> **生产默认形态**；静态帧链整体**降级为回退**（实时渲染不可用时才走）。据此本仓库做了两件事：
> ① **移除其后又短暂存在的「beta 场景动画」**（`betaSceneAnim` 开关 + `/scene-anim`、
> `/scene-anim-progress` 路由 + 客户端升级队列/轮询/探针 + worker 多帧渲染与 APNG 输出）；
> ② 把 **有损路线 / 空闲预热 / GPU 渲染加速** 重新定位为分组的调优项 —— 它们本就只作用于静态帧
> 路径，行为与默认值不变（分组现名「**静态帧兜底与调优**」，其第一行是「出图来源」）。
> 现行显示优先级：**WebWallGL 实时渲染 → 场景作者内嵌 MP4（`/scene-video`）→ 静态帧
> （`/scene-frame`）→ 主纹理近似 → 作者预览图 / 自定义画面**。
> **完整决策背景、已删资产清单与未来实现路线见 [`SCENE-ANIMATION-HANDOFF.md`](./SCENE-ANIMATION-HANDOFF.md)**。
>
> ⚠️ **以下 §0「现状盘点」是 2026-08-29 的历史快照**：其中的行数/文件计数、符号是否存在、
> 以及"服务端 SceneRenderer 是生产默认""`/scene-anim` 多帧路径""`/scene-resources` 路由名"
> 等表述**都已过时**（§1–§5 的路线分析仍然有效）。行号与计数一律以代码为准。

---

## 0. 现状盘点（2026-08-29 快照 · 先看事实，再谈路线）

### 渲染代码规模

| 模块 | 行数 | 职责 |
|---|---|---|
| `lib/we-renderer/`（40 文件） | ~10,500 | SceneRenderer 主体：core 807 / glsl transpile 774 / puppet 715 / model 704 / integration 606 / particles 556 / gl-effect 536 / image 472 / camera 362 / 24 个 effects + glsl + gpu-gl |
| `lib/scene-manifest.js` | 2,570 | scene.pkg / 松散目录 → 场景清单（客户端 player 用） |
| `lib/scene-player.js` | 1,810 | 客户端 WebGL Scene Player 运行时（浏览器端渲染） |
| `lib/pkg-extract.js` | 1,468 | PKGV / TEX / LZ4 容器解码 |
| `lib/scene-scripts.js` + apis | 615 | NSL/内联 V8 脚本 vm 沙箱 |
| `lib/font-render.js` | 794 | CFF 字体引擎 |
| **合计** | **~16,000** | 一条自研"WE 场景引擎" |

### 已经存在的三条渲染路径（关键事实）

1. ~~**服务端 SceneRenderer（生产默认）**：`/scene-frame`（单帧 PNG）+ `/scene-anim`（多帧 → ffmpeg 合成 MP4/WebM）~~ → **已过时（2026-09-23）**：`/scene-anim` 已删除，服务端渲染器**不再是生产默认**（默认是 WebWallGL 实时渲染 `/scene-live`；静态帧是回退）。纯 JS CPU 软件光栅（Canvas + z-buffer），可选 GPU 加速（headless WebGL / ANGLE，`supreium-headless-gl`，现由「GPU 渲染加速」独立开关控制），worker 线程 / fork 系统 Node 子进程隔离，磁盘缓存（`sf*` 键）。
2. **客户端 WebGL Scene Player（`/scene-runtime` + `/scene-manifest` + `/scene-resource`，**单数**）**：浏览器内 WebGL 实时渲染，**因实测"每场景一个 WebGL 上下文冻结页面"被禁用**；路由仍在服务，但**当前客户端从不消费**（`sceneUrl` 只在 inventory 里发出）。
3. **回退链**：SceneRenderer 失败 → 主纹理提取（`extractSceneMainImage`）→ 工坊 preview 图。

### Bug 存量（"bug 众多"的量化）

- **49/168 条 git commit 触碰渲染器文件（约 29%）**；修复轮次 sf31→sf44 共 14 轮，全部是"某类壁纸又不对了"的追修。
- TODO.md 仍列出的未完成项：视频纹理逐帧播放；rope/trail/control-points 粒子 emitter；小角度旋转精确化（需官方实机核对）；即时文本单独渲染；**NSL 脚本动画时间轴未与场景时钟同步（根因 A，13/15 场景受脚本驱动）**；剩余边缘脚本/效果（多为壁纸自身缺陷）；`0x384` 矩阵 B 用途未定；多相机对象选择规则未定。
- 四轮系统性根因（A 脚本时间轴 / B 正交 zoom / C 粒子定位 / D 相机 eye）+ GLSL 解释器
  七项缺口 + GPU 全白 + 显存泄漏 + auto_sway 三层叠加 bug 均已修复，修复内联为代码注释
  （sf 标记；原 docs/RENDER-ISSUES-ANALYSIS.md 已于 2026-08-30 溶解）。
- `.test-cache/` 曾有数百个诊断脚本、39MB 反汇编、D3D11 hook 采集进展（v4.1 已能从 wallpaper32 的 Map/Unmap 精确读回 MVP 常量缓冲，CopyResource 时序不可靠）——2026-08-30 已随动画方向清理（含 HOOK-PROGRESS.md 等文档，见本文 §7）。

### GPU 加速现状（跨平台的软肋）

- `supreium-headless-gl` 仅 **x64** prebuild（ABI 108-147）；DSH Electron ABI 148 没有 prebuild → 只能 **fork 系统 Node 子进程**跑 GPU（sf41 的 workaround）；arm64 直接门控回退 CPU（gl-core.js `SUPPORTED_ARCH = ['x64']`）。
- ~~**WebGPU/Dawn spike 已做过**~~ → **⚠️ 已废弃（2026-09 决策更新，见 §8）**：spike 实测 21.1×（RTX 4060，960×540 计算着色器 0.31ms vs CPU 6.58ms）且跨平台 prebuild 覆盖面远好于 supreium，但**同进程二次 `create()` / unmap 后立即重建 pipeline 会原生崩溃**（每进程一实例），且现有 WebGL 路径尚未榨干、静态帧的读者（无可用 GPU 的虚拟机 / 远程端）与 Dawn 的适用面错位。`lib/we-renderer/gpu-dawn/backend.js` 与仅为它服务的 `lib/we-renderer/glsl/wgsl.js`（GLSL→WGSL）已删除，护栏 `scripts/verify-fx-chain.mjs` 阻止回流。

### 官方引擎逆向资产（事实已内联为代码注释；原 docs/WE-REVERSE.md 已溶解）

- 官方引擎逆向：wallpaper64.exe 函数地址表（定位数学 0x1401EC25A、相机矩阵应用 0x1401ED0D0 等）+ 已确认官方数学（eye/ortho/MDLA/蒙皮，内联在各实现处注释）。
- 本机 WE 安装目录内 `scene-renderer-analysis.md`（2.8.42）：**官方渲染器 = wallpaper64.exe（D3D11 宿主）+ bin/scenescript64.dll（场景引擎 + 内嵌 V8）+ resourcecompiler64.exe；官方 shader 以源码形式随发行版发布（assets/shaders/ ~90 个）**；难度自评：协议层 ★★ 已基本破译，C++ 宿主端 ★★★★（无符号 ~15k 函数），全量重建 ≈ 0.5–1 人年。
- `.test-cache/we-hook/` + `we-hook-d3d11-*.obj`：D3D11 hook（Present/Map/Unmap/UpdateSubresource/Draw）采集官方帧数据的实验成果与半成品。

---

## 1. 跨平台约束矩阵（所有结论的前提）

| 平台 | WE 官方引擎 | 场景文件 | 本插件角色 | 渲染器必须能在哪跑 |
|---|---|---|---|---|
| Windows | ✅ 可运行 | ✅ 本地 | 主战场 | Node（Electron 宿主）/ 浏览器 / **可访问官方引擎** |
| Linux / WSL | ❌ 无原生客户端（官方明确不支持） | ✅ Steam 库挂载在 `/mnt/...` | 枚举库 + 渲染 | **仅 Node**（Linux 进程内） |
| macOS | ❌ 无任何官方客户端（社区 mac 包独立维护） | 基本无 | 媒体为主 | 仅纯 JS（无原生依赖） |

→ 结论先行：**渲染器必须保持"能在 Node 进程里跑"这一最低公共能力**；任何依赖 Windows 专有 API 或原生模块的方案都只能做"增强路径"，不能做唯一路径。

---

## 2. 方案 A：重构现有逆向渲染器

### 可行性：✅ 高（工程层面），但无法根除问题类

**为什么重构能解决一部分：**
- 现有代码是 14 轮打补丁的产物：`core.js` 807 行里堆着 `_setupCamera`/`_viewShift`/`_orthoZoomCenter` 等互相纠缠的语义，`applySceneScripts`、效果链、worker 协议在 index.js / scene-render-worker.mjs 里散落多处。分层（解析 → 场景图 → 脚本/动画求值 → 光栅化 → 效果链 → 合成）后，**每个已知根因都能变成带 fixture 的单元测试**。~~回归靠官方 preview.gif 做像素 A/B 自动判定~~（2026-08-30 已放弃：preview.gif 是作者上传素材，非可靠基准，相关工具已删）。
- 已有模块化底座（we-renderer/ 子目录 + effects/ 每效果一文件），不是推倒重来。
- 官方 shader 源码（assets/shaders/）+ 逆向数学基准（已内联 camera.js/puppet.js 等注释）= 正确性对照物齐备。

**为什么不能指望它消灭 bug：**
- 根因 A（NSL 脚本时间轴）是**框架级**问题：NSL 库把整个动画调度器内联进每个 `{script,value}`，靠真实时钟 `setTimeout` 推进；要让"入场/昼夜/循环"动画按场景 t 演进，等于在沙箱里再实现一个事件循环语义（`engine.runtime` 与调度器解耦）。这是"再写半个引擎"的量级，不是修 bug。
- GLSL 方言解释器（transpile/preprocess/runtime/executor/integration ≈ 2,300 行）是"JS 里解释 GLSL 方言"的独立编译器，shaderfrog 的嵌套 `#if` bug 等属于上游解析器缺陷，只能靠打补丁 + 回退兜底。
- CPU 软件光栅 + CPU 效果在 4K 下每帧 3–30s；动画（scene-anim）分钟级。性能天花板仍在。
- 结构性风险：**每来一张新 workshop 壁纸都可能撞上未逆向的特性** → 打地鼠式维护（49/168 commit 已证明）。

**重构应聚焦的三件事（按 ROI 排序）：**
1. **脚本时间轴根治（根因 A）**：真实时钟驱动 NSL 调度器 + `engine.runtime` 场景时钟双轨，脚本动画不再"静默停在 init 态"（TODO P0）。
2. **GPU 后端换 WebGPU/Dawn**：消灭 x64-only + ABI 脆弱 + Electron fork hack；prebuild 覆盖 darwin-universal/linux-arm64/win32-x64/linux-x64；spike 已验证 21×。难点是 GLSL 方言 → WGSL（或 SPIR-V）的编译路径 —— 与现有 GLSL→JS 转译器同构，可复用 AST；内置效果可保留 CPU 实现（正确性已知），GPU 只加速光栅/粒子/后处理大头。
3. **管线分层 + 官方 preview 像素 A/B 回归自动化**：把"修一个坏一个"变成"改完 15 场景全量对拍"。

**工作量粗估**：分层重构 ≈ 2–4 周（单人）；脚本时间轴 ≈ 2–4 周；Dawn 后端 ≈ 3–6 周（含 GLSL→WGSL）；回归基建 ≈ 1 周。合计 **2–3 人月**，风险中等（脚本时间轴与 Dawn 是主要不确定项）。

---

## 3. 方案 B：使用第三方场景渲染器

### 候选盘点

| 项目 | 性质 | 功能覆盖 vs 现状 | 集成成本 | 许可证 |
|---|---|---|---|---|
| **linux-wallpaperengine**（Almamu，C++17/Qt/OpenGL） | 最完整的开源 WE 场景渲染器 | 对象树/image/部分粒子/**部分效果/部分脚本** —— **覆盖少于现状**（本项目 30+ 内置效果 + 第三方 GLSL 通用解释器 + puppet 蒙皮 + 完整 NSL 沙箱） | 极高：非 headless 帧服务，需加离屏 FBO + 读回导出；N-API addon 要 win/linux/darwin × x64/arm64 全 prebuild + CI 矩阵 | **需核实**（原版 GPL-3.0，重写版疑似 MIT —— 若 GPL 与插件 MIT 冲突则不可引入） |
| **repkg**（notscuffed，Rust） | 解析库（PKG/TEX 提取），**不是渲染器** | 无渲染能力 | 低（可做 `pkg-extract.js` 的健壮性/性能替代） | MIT（需核实） |
| **catsout/wallpaper-engine-kde-plugin**（Rust/QML） | KDE 壁纸插件 | 复杂场景回退静态图，**明显少于现状** | 中 | 需核实 |
| WebGPU/WebGL 社区 | 无成熟 WE scene 渲染器 | — | — | — |

### 可行性：❌ 整体替换不可行；✅ 局部吸收可行

- **没有任何第三方渲染器在功能覆盖上达到本项目现状** —— 本项目是"逆向最深"的 JS 实现（连官方 shader 的 GLSL 方言都直接解释了），换第三方 = 功能倒退。
- linux-wallpaperengine 的价值是**参考实现**（其 `Camera.cpp`/`CParticle.cpp` 语义已被本项目用作基准，代码注释多处引用），继续对照即可，不必引入。
- repkg 可作为**解析层局部替换**（若 pkg-extract.js 出现健壮性问题时再评估），与"渲染器重构"无关。
- 引入 C++/Rust 原生组件的**跨平台成本**：N-API prebuild 矩阵（与本项目已踩过的 supreium ABI 坑同类）+ 各平台构建环境 + Electron/Node ABI 双轨 —— 与"保证跨平台"的目标直接冲突。

---

## 4. 方案 C：尝试使用官方渲染器

### 关键事实

- 官方渲染器 = **wallpaper64.exe（D3D11 宿主）+ bin/scenescript64.dll（场景引擎 + 内嵌 V8 跑 NSL）+ resourcecompiler64.exe**（scene-renderer-analysis.md，2.8.42 已确认）。
- **Windows-only**：官方帮助页明确 Linux/macOS 无原生客户端；Android 官方 App（`io.wallpaperengine.weclient`）存在但**闭源、无第三方 API**；编辑器"导出 GIF/视频"是人工 UI 操作，**无离屏渲染 / render-to-file CLI**。
- 官方引擎对本项目是**可达的**：本机已装 WE（枚举 Steam 库的前提），可用 `wallpaper64.exe -control openWallpaper -file <scene.pkg>` 命令打开任意场景（单实例启动器，未运行时自动拉起服务）。

### 两条可落地的"取帧"路线（仅 Windows）

1. **窗口捕获（零新依赖）**：复用插件已有的 ffmpeg 供给链，`ffmpeg -f gdigrab -i title="..." -frames:v N` 抓壁纸窗口帧。缺点：gdigrab 对遮挡窗口抓到的是 DWM 合成内容，遮挡时内容可能陈旧/黑帧；需要标题/窗口类名探活。
2. **D3D11 Present hook（半成品，2026-08-30 已弃用并清理）**：v4.1 曾能从 wallpaper32 精确读回 MVP 常量缓冲（Map slot14/Unmap slot15/UpdateSubresource slot48），CopyResource 时序问题未解 —— 距离"Present 时抓 backbuffer 像素"还有一段路；且 32/64 位双版本、WE 更新即失效、注入的脆弱性都在。

### 收益

- **像素级 100% 与官方一致**：所有效果、puppet、粒子、NSL 脚本、音频联动全对 —— 这是唯一能**彻底消灭"逆向 bug 类"问题**的方案（不是修复，是消除问题空间）。
- 与现有架构同构：捕获帧 → 走现有 `sf*` 缓存与静态帧管线，静态帧/未来动画都能喂。

### 问题（按严重度）

| # | 问题 | 影响 |
|---|---|---|
| 1 | **仅 Windows**；Linux/WSL/macOS 无官方引擎 | **直接违反跨平台硬约束** → 只能做"Windows 快路径"，其他平台仍需内置渲染器 → 双轨维护 |
| 2 | 依赖 WE 已安装且服务可启动 | WSL 场景只有库文件没有引擎，路径 2 完全不可用 |
| 3 | 打开用户的壁纸 = 打断用户当前壁纸/占用显示器 | 需要隐藏窗口 + 移出可见桌面，或多显示器挑空闲屏 —— 与"这是桌面壁纸应用"的本质冲突，工程上绕但脏 |
| 4 | 遮挡暂停：WE 对被全屏遮挡的壁纸可能暂停/降帧 | 捕获内容不连续 |
| 5 | 分辨率/帧率由壁纸窗口决定，非 3840×2160 自由输出 | 需缩放/重采样，动画帧率受引擎上限 |
| 6 | hook 路线：WE 版本更新即失效；注入 32/64 双版本；与杀软冲突风险 | 维护成本 = 跟随 WE 每个版本 |
| 7 | 授权边界：用官方引擎渲染用户已购壁纸属灰色地带（本机自用风险低，分发无问题） | 低 |

### 变体评估

- **Wine/Proton 跑官方引擎**（SteamOS KDE 插件路线）：Linux 上可行但把 200MB+ Windows 引擎 + Wine 当运行时，插件体积/复杂度爆炸，且 DSH Linux 宿主多数无桌面会话 —— 不现实。
- **Android 官方渲染器**：闭源无 API，不可嵌入。
- **官方导出功能**：编辑器人工 UI，不可自动化。

### 可行性结论

- 作为**唯一渲染器 / 跨平台方案**：❌ 不可行（违反硬约束）。
- 作为 **Windows 增强快路径**：✅ 可行（窗口捕获路线零新依赖、与现有回退链同构），ROI 取决于"用户主要用 Windows + WE 常驻"的比例 —— 而这正是本插件的主战场。

---

## 5. 横向对比

| 维度 | A 重构 | B 第三方 | C 官方引擎 |
|---|---|---|---|
| 跨平台（硬约束） | ✅ 纯 JS 全平台 | ⚠️ 原生组件违背；LWE 功能倒退 | ❌ 仅 Windows |
| 消灭逆向 bug 的能力 | ❌ 只能缓解（根因 A 等仍在） | ❌ 覆盖更少 | ✅ **100% 一致** |
| 功能覆盖 | ✅ 现状最高 | ❌ 少于现状 | ✅ 100% |
| 性能 | ⚠️ CPU 慢；GPU 依赖 x64 | ⚠️ 原生快但集成难 | ✅ 引擎原生 GPU |
| 维护成本 | 打地鼠（49/168 commit） | 上游维护 + 自身 prebuild 矩阵 | hook 随 WE 版本失效 |
| 工作量（单人到交付） | 2–3 人月 | 3–6 人月（且倒退） | 快路径 1–2 周（捕获）；hook 2–4 周 |
| 风险 | 中（脚本时间轴 / Dawn） | 高（许可证 + ABI 矩阵） | 中（窗口管理 / 版本漂移） |

---

## 6. 推荐策略（三层混合）

**默认路径（跨平台，长期主线）—— 方案 A 的定向重构，不推倒重来：**
1. 管线分层（解析/场景图/求值/光栅/效果/合成）+ `sf*` 缓存键版本化。官方结构研究
   结论支持此方向：官方 effect.json/material.json/shader 元数据**数据驱动、效果自包含**，
   值得按官方样式渐进重构（官方结构细节已内联至 `lib/we-renderer/effects/registry.js` 与
   `materials/compile.js` 注释）。~~官方 preview 像素 A/B 回归~~（2026-08-30 放弃：
   preview.gif 是作者上传素材，非可靠基准，见顶部方向决策）。
2. ~~脚本时间轴根治（根因 A）~~—— 2026-08-30 放弃（动画方向），完整背景与复刻要点见
   [`SCENE-ANIMATION-HANDOFF.md`](./SCENE-ANIMATION-HANDOFF.md) §3.1。
3. ~~GPU 后端从 supreium（x64-only）迁到 WebGPU/Dawn~~ → **2026-09 撤销（见 §8）**：Dawn 后端已删除；
   x64-only 与 Electron ABI/fork hack 的问题改由"**能力探针 + 三态策略**"消化（有可用 GPU 才走 GPU，
   失败一律 CPU，绝不影响可用性）。

**Windows 增强路径（可选，高性价比）—— 方案 C 的"完美帧"快路径：**
4. `openWallpaper` 控制命令 + ffmpeg gdigrab 窗口捕获，产出官方像素帧，走现有缓存/动画管线；**失败自动回退内置渲染器**（与现有回退链同构，`scene-frame` 已有三层回退，加一层即可）；作为 beta 开关（与 `sceneGpuAccel` 同款门控）灰度。

**不采用 —— 方案 B 整体替换：**
5. 仅继续吸收参考实现（LWE 数学语义、repkg 解析思路）；不引入原生组件。

> 一句话结论：**重构是必走的主线（解决可维护性与跨平台 GPU），官方引擎是 Windows 上的"完美帧"增强（解决保真度），第三方渲染器不构成替代方案（功能倒退 + 跨平台冲突）。**

---

## 7. 重构执行记录（2026-08-30）

**方向决策**：放弃 scene-anim 自研动画方向。**已删资产清单、技术要点与未来实现路线见
[`SCENE-ANIMATION-HANDOFF.md`](./SCENE-ANIMATION-HANDOFF.md) §3-§5**（git 已恢复，可考古）。

**删除验证**：`npm run build` / `npm run verify` / `verify-scene` 13/13 全绿。

**保留决策**：`lib/scene-player.js`（已禁用的 WebGL Player）保留代码标注弃用（未来
WebGPU 路线的场景图种子）；`_refs/` 保留官方 shader 源码 + lwe/repkg 参考实现（静态帧
正确性对照基线）；`sceneGpuAccel` 保留为独立静态帧加速开关。

---

## 8. 决策更新（2026-09）：废弃 WebGPU/Dawn + 「接入 WebWallGL 同款加速」的权衡

### 8.1 废弃 WebGPU/Dawn（已执行）

- **删除**：`lib/we-renderer/gpu-dawn/backend.js`（21KB；无人 import，但因为 `files` 收录整个
  `lib/we-renderer/` 而**随包出货**）与 `lib/we-renderer/glsl/wgsl.js`（GLSL→WGSL 转译器，仅 Dawn 引用）。
- **清理**：`render/passes.js` 的 `_dawnEffectCache` 死钩子与相关注释、`render/framebuffer.js` 中
  "Dawn 后端将以同一接口提供"的注释；`evidence/verify-report-lines.mjs` 里指向已删文件的条目。
- **护栏**：`scripts/verify-fx-chain.mjs` 新增 4 条 —— 文件确已删除 / 全仓无残留标识（含
  `_dawnEffectCache`）/ 负对照（能抓到重新引入的 `gpu-dawn` 引用）/ 负对照（正常 GPU 引用不误判）。
- **理由**：① **原生崩溃** —— 同进程二次 `create()`、`unmap` 后立即重建 pipeline 都会崩，只能每进程一实例；
  ② 现有 WebGL 路径**尚未榨干** —— GPU 效果段现在主要由"每效果一次上传 + `readPixels` 回读"决定
  （4K 单次 13–24ms），`runEffectChainOnGL` 批处理还能再砍一刀；③ 依赖更重（WGSL 转译 + 全平台 prebuild）；
  ④ **适用面错位** —— 需要静态帧的机器是没有可用 GPU 的虚拟机 / 远程端，Dawn 恰好解决不了他们。
- **关于"对应的 UI 按键"**：**不存在 WebGPU/Dawn 的 UI 开关**。全仓只有一行「GPU 渲染加速」
  （`src/client.js` 的 `switchRow("GPU 渲染加速", sel.sceneGpuAccel …)`），它驱动的是 **WebGL**
  效果适配层（`gpu-gl/adapter.js`），**不是** Dawn。故本次没有可删的 UI 项；若要把这一行也改成
  自动策略（不再让用户手选设备），见 8.3 的三态方案。

### 8.2 权衡：「接入 WebWallGL 同款加速」（= 让实时渲染器把帧喂给静态帧缓存）

| 方案 | 做法 | 收益 | 代价 / 风险 |
|---|---|---|---|
| **A. 截帧复用（"同款加速"）** | 实时渲染器已经在 GPU 上把这一帧画好了 ⇒ 由渲染页/客户端回读一次，POST 给宿主写进静态帧缓存 | **零额外渲染**；与用户所见**像素一致**（彻底消灭"两套实现"的差异，也就不用再修那类分歧）；GPU 机器上不再需要 headless-gl 这条链 | ① 只覆盖"实时渲染能用"的机器 —— 而那正是静态帧**优先级最低**的机器；② 要给 **vendored 上游渲染页**加捕获入口（`__wp` 控制面；当前**没有任何 `preserveDrawingBuffer`**，需页内 rAF 内 readPixels 或加该选项）⇒ 持续的上游分歧，`sync-webwallgl.mjs` 每次同步都要保住它；③ 截的是**显示分辨率下的画面**（含 fit/cover 变换），不是 3840 生产帧 ⇒ 必须作为**独立产物类别**（单独缓存命名），不能混进 `sf45_` 键空间；④ 需要一个"帧回填"接口（上游 #108 有同型设计 `/scene-frame-cache/<token>`，本分支没有） |
| **B. 宿主侧 WebGL 效果加速（现状 `gpu-gl`）** | 把效果链搬到 headless-gl | 实测整帧 **1.51×**（1920×1080：效果 3044→1093ms，合计 5887→3894ms）；identity 正确性 maxΔ=0；任何失败即回退 CPU（不影响可用性） | ① 只覆盖**效果链**，非效果段（解码/blit/文本/粒子 2843ms）仍 CPU；② x64-only + ABI 108–147 + **必须 fork 系统 Node** ⇒"有显卡"≠"能用 GPU"；③ 输出与 CPU 非逐字节一致（REPEAT vs CLAMP_TO_EDGE 已知语义差）⇒ 缓存键分段、默认关闭是有据的 |
| **C. 不接（静态帧保持 CPU）** | — | 零风险；虚拟机 / 远程端（唯一真正需要静态帧的场景）本来就是 CPU | GPU 机器的静态帧仍慢 —— 但它们有实时渲染兜着 |

**建议：分层，不是二选一**

1. **实时渲染可用** ⇒ 用它；并（可选）在动画起来之后**截一帧入缓存**（方案 A），供 poster / 切换 /
   轮换 / 失败回退 —— 正是"静态帧 = 缓存兜底"的定位，而且**不需要** headless-gl。
2. **实时渲染不可用**（虚拟机 / 远程 / 无 WebGL2 / 已判失败）⇒ 走现有静态帧链；GPU 效果加速按 8.3
   的"三态 + 探针"自动启用（方案 B），能白拿就白拿。
3. **不做**静态帧的整帧 GPU 化 —— 那等于重做一条 WebWallGL；有 GPU 的机器本来就该走实时渲染。

**若决定做 A，先验证两件事**：① vendored 页能否稳定截帧（现在没有 `preserveDrawingBuffer`；
   需要在页内渲染 tick 里 readPixels，改完要复跑 `verify-scene-live` 的 55 项）；② 新产物类别与它的
   消费方（poster / 兜底 / 轮换）在缓存与 UI 上是否讲得清，且不污染 `sf45_` 生产帧。

### 8.3 后续（未做，待定）

- **三态策略** `sceneGpuMode: 'auto' | 'cpu' | 'gpu'`（默认 `auto`）+ **能力探针**：当前启动诊断只验
  "`require` 绑定成功"（`getWebGL(true) !== null`），**不验能否建上下文/能否渲染** —— 探针应到
  `createGLContext()` + 一次 identity pass，并用软件光栅黑名单（可复用客户端的
  `SOFT_RENDER_RE = /swiftshader|software|llvmpipe|softpipe|microsoft basic render|angle \(software|stack-gl/i`，
  它验的是浏览器那条栈，不能替代宿主侧）。
- `supreium-headless-gl` 从 `dependencies` 移到 `optionalDependencies`（设备支持不该让安装失败）。
- `runEffectChainOnGL` 批处理，压掉 GPU 效果段的传输开销。
