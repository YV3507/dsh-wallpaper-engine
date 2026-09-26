# docs — 决策与用户文档

本项目采用**「代码即真相」**文档模式（2026-08-30 起）：渲染 / 逆向 / 根因知识直接内联在
对应实现文件的代码注释中（sf 标记），docs/ 只保留决策与用户文档。

## 用户文档（中英双语，中文在前）

| 文档 | 内容 |
|---|---|
| [UPGRADING.md](./UPGRADING.md) | **升级指南**——前置条件（内核 / better-sidebar 版本要求）、兼容矩阵、正确更新顺序与「顺序反了怎么恢复」 |
| [CHANGELOG.md](./CHANGELOG.md) | **变更记录**——逐版本功能与修复（新版在前） |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | **工作原理**——**两条渲染路线**（WebWallGL 实时渲染 + 静态帧链）、宿主 / 客户端分工、主要 HTTP 路由表 |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | **排障**——安装失败排查（pnpm / `github:` 直装）与「症状 → 先看哪里」速查 |

**分层约定（2026-09 起）**：门面 `README.md` / `README.en.md` 只放**不随版本变化、且新访客决策必需**的事实
（定位、支持的壁纸类型、安装、使用手册、已知限制）；任何**带版本号 / issue 号 / 性能数字 / 排障步骤 /
实现细节**的内容一律进上表或 `CHANGELOG.md` —— 避免首页随版本迭代腐烂（本次拆分即源于 README 里
7 处 `localStorage` 陈述在 v0.4.0 后集体失真）。

## 工程文档

| 文档 | 内容 |
|---|---|
| [ROBUSTNESS-AUDIT.md](./ROBUSTNESS-AUDIT.md) | **健壮性审计记录**——发布包完整性/编码/跨平台/运行时容错/依赖兼容审计结果与重跑方法 |
| [RENDER-FALLBACK-MODES.md](./RENDER-FALLBACK-MODES.md) | **回退形态设计（2026-09-24 定稿）**——两层模型（live = T/F 开关；回退链 = 全局唯一枚举 `mp4 → static → maintex → art`）、逐壁纸 pin 的 id 表与兼容规则、UI 循环顺序、失败与"不渲染"终端、`preview` 级的删除范围、陈条后台清理，以及「静态帧渲染」开关的删除 |
| [awesome-dsh-plugin-pr-guide.md](./awesome-dsh-plugin-pr-guide.md) | 向 awesome-dsh-plugin 收录目录提交的一次性发布指南（应作者要求保留原版，直接从 awesome-dsh-plugin 仓库复制，勿改） |

## 已归档：已退役的场景渲染路线（2026-09-26）

**为什么归档**：以下两条路线**将被移除 / 已移除**，其渲染器实现均在**独立仓库**维护 ——
[`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)（把场景离线渲染成一张 PNG，可当库或
CLI 用、不依赖任何宿主）与 [`YV3507/webwallgl`](https://github.com/YV3507/webwallgl)（浏览器端场景渲染器，
npm / CDN，MIT）。本仓库只保留历史记录：下列文档整体移入 `archive/`，**不再反映本仓库的现行实现**，也不再维护。

### 静态帧渲染线（`/scene-frame`，将被移除）

| 文档 | 内容 |
|---|---|
| [SCENE-FRAME-PERF.md](./archive/static-frame/SCENE-FRAME-PERF.md) | **静态帧冷渲染成本实测 + 渲染器优化记录**（38 节；基线 `pr97` / `sf35a`）——哪些渲染可以砍、哪些假设被数据推翻 |
| [DEFAULT-SCENE-RENDER-AUDIT.md](./archive/static-frame/DEFAULT-SCENE-RENDER-AUDIT.md) | **官方默认壁纸渲染审计**（2026-10-03）——「无损渲染」的纯数学取证（场景数据 / 插桩量 / preview 画像 / 宿主反编译），只记可复现的量与能指到行号的根因 |
| [RENDERER-FEASIBILITY.md](./archive/static-frame/RENDERER-FEASIBILITY.md) | 渲染器三路线可行性 + 方向决策 + §7 重构执行记录（该方向决策的终点即**迁往独立仓库**） |
| [NATIVE-SCENE-EVIDENCE.md](./archive/static-frame/NATIVE-SCENE-EVIDENCE.md) | **原生场景引擎取证（WE 2.8.42）**——静态帧路径的几何依据：y 轴朝向、角度单位与合成顺序（`Rz(−z)·Ry(y)·Rx(−x)`）、puppet = 蒙皮网格，以及取证确定的合成器缺陷 D-1/D-2/D-3 |
| [TODO.md](./archive/static-frame/TODO.md) | **渲染引擎现状与 TODO**（迁出前的已实现组件、验证基线与本机环境；原在仓库根） |
| [`evidence/`](./archive/static-frame/evidence/) | 上述文档的实测证据脚本（9 个；跑法 `node docs/archive/static-frame/evidence/<name>.mjs`） |

> ⚠️ 新仓库 `we-static-frame` 有它自己的 `docs/perf-report.md` 与 `docs/perf-and-gpu-notes.md`；
> 本目录的文件是**插件侧历史**，**没有**被迁往那里，两边内容不重复。
>
> 保留在本目录的文档里仍指向它们的链接已改为 `archive/static-frame/...`；
> 文中涉及静态帧的**正文段落尚未摘除**（`HOW-IT-WORKS.md`、`RENDER-FALLBACK-MODES.md`、
> `CHANGELOG.md`、`TROUBLESHOOTING.md`、`UPGRADING.md`），留待后续整理。

### 场景动画线（`/scene-anim`，已移除）

| 文档 | 内容 |
|---|---|
| [SCENE-ANIMATION-HANDOFF.md](./archive/scene-animation/SCENE-ANIMATION-HANDOFF.md) | **场景动画交接手记**——beta 场景动画（`betaSceneAnim` 开关 + 宿主 `/scene-anim`、`/scene-anim-progress` 路由 + 客户端升级队列 / 进度轮询 / 探针 `<video>` + worker 多帧渲染与 APNG 输出）**已整体移除**，WebWallGL 实时渲染是其上位替代。文中存：放弃决策与理由、复刻必读的技术要点（含 NSL 脚本时间轴的根因 A）、已实现又删除的资产清单、三条推荐复刻路线，以及知识落点索引 |

> 该线的可复用资产与静态帧线同源（§3.2：「静态帧渲染器 = 动画渲染器的地基」），
> 故其数据与实测一并见上方 `archive/static-frame/`。

## 其它

- 现状/TODO：原仓库根 `TODO.md` 已随静态帧线移入 `archive/static-frame/TODO.md`（其主体是迁走的渲染器，不再维护）。
- 开发/发布指南：仓库根 `CONTRIBUTING.md`（从本地源码安装、构建验证、热挂载/编码铁律；收录提交速查见其附录，完整版见上表原版指南）。
- 用户门面：仓库根 `README.md` / `README.en.md` / `README.beginner.md`（小白向）。
- `images/`：README 引用的截图。

已溶解文档（2026-08-30，代码即真相）：
- WE-REVERSE.md / WE-REVERSE-CAMERA-MATH.md → camera.js / image.js / puppet.js / scene/transform.js / scene/animation.js 等注释
- RENDERER-OFFICIAL-STRUCTURE.md → effects/registry.js / materials/compile.js 注释 + FEASIBILITY §6 结论
- RENDER-ISSUES-ANALYSIS.md / REFACTOR-ROUND-2026-08-28.md → 代码 sf 标记 + TODO.md
- REFACTOR-STATIC-FRAME.md → FEASIBILITY §7
- dev-notes-bom-and-dsh-boot.md → CONTRIBUTING.md
- HOOK-PROGRESS.md / V6-DUMP-ANALYSIS.md / EYE-PREDICTION.md / FIX-PLAN-AMYA.md /
  AMYA-CAMERA-ANALYSIS.md / RENDER-ISSUES-PROGRESS.md → 废弃方向，删除（重构前备份可找回）
