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
| [RENDERER-FEASIBILITY.md](./RENDERER-FEASIBILITY.md) | 渲染器三路线可行性 + 方向决策 + §7 重构执行记录（唯一决策文档） |
| [DEFAULT-SCENE-RENDER-AUDIT.md](./DEFAULT-SCENE-RENDER-AUDIT.md) | **官方默认壁纸渲染审计**（2026-10-03）——「无损渲染」的纯数学取证（场景数据 / 插桩量 / preview 画像 / 宿主反编译），只记可复现的量与能指到行号的根因 |
| [SCENE-FRAME-PERF.md](./SCENE-FRAME-PERF.md) | **静态帧冷渲染成本实测 + 渲染器优化记录**（基线 `pr97` / `sf35a`；当前管线 `sf45`）——哪些渲染可以砍。⚠️ §十四 起含**现行**实现决策；涉及 `scene-anim` 多帧动画的部分对应**已移除**的路线（文首已逐节标注被取代的小节） |
| [SCENE-ANIMATION-HANDOFF.md](./SCENE-ANIMATION-HANDOFF.md) | ~~**场景动画交接手记**~~ **已归档**——beta 场景动画（`/scene-anim`）已随 WebWallGL 实时渲染落地整体移除；本文件仅存历史决策、技术要点与已删资产清单（供考古） |
| [ROBUSTNESS-AUDIT.md](./ROBUSTNESS-AUDIT.md) | **健壮性审计记录**——发布包完整性/编码/跨平台/运行时容错/依赖兼容审计结果与重跑方法 |
| [NATIVE-SCENE-EVIDENCE.md](./NATIVE-SCENE-EVIDENCE.md) | **原生场景引擎取证（WE 2.8.42）**——静态帧路径的几何依据：场景 y 轴朝向的首方证明、角度单位与合成顺序（`Rz(−z)·Ry(y)·Rx(−x)`）、puppet = 蒙皮网格，以及由取证确定的合成器缺陷 D-1/D-2/D-3（只裁决静态帧回退路径，不涉完整动画渲染） |
| [RENDER-FALLBACK-MODES.md](./RENDER-FALLBACK-MODES.md) | **回退形态设计（2026-09-24 定稿）**——两层模型（live = T/F 开关；回退链 = 全局唯一枚举 `mp4 → static → maintex → art`）、逐壁纸 pin 的 id 表与兼容规则、UI 循环顺序、失败与"不渲染"终端、`preview` 级的删除范围、陈条后台清理，以及「静态帧渲染」开关的删除 |
| [awesome-dsh-plugin-pr-guide.md](./awesome-dsh-plugin-pr-guide.md) | 向 awesome-dsh-plugin 收录目录提交的一次性发布指南（应作者要求保留原版，直接从 awesome-dsh-plugin 仓库复制，勿改） |

- 活的现状/TODO：仓库根 `TODO.md`（**当前未入库**，按需本地维护；含关键事实备忘、回归场景集、sceneVideo 修复记录）。
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
