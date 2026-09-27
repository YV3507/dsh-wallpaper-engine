# docs — 决策与用户文档

本项目采用**「代码即真相」**文档模式：渲染 / 逆向 / 根因知识直接内联在对应实现文件的代码注释里，
`docs/` 只保留**决策**（含验收判据）与**用户文档**。

## 用户文档（中英双语，中文在前）

| 文档 | 内容 |
|---|---|
| [UPGRADING.md](./UPGRADING.md) | **升级指南** —— 前置条件、兼容矩阵、正确更新顺序与「顺序反了怎么恢复」 |
| [CHANGELOG.md](./CHANGELOG.md) | **变更记录** —— 逐版本功能与修复（新版在前） |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | **工作原理** —— 观看链（WebWallGL 实时渲染 → 内嵌 MP4 → 实时抓帧 → 自定义画面 → 空态）、宿主 / 客户端分工、HTTP 路由表 |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | **排障** —— 安装失败排查与「症状 → 先看哪里」速查 |

**分层约定**：门面 `README.md` / `README.en.md` 只放**不随版本变化、且新访客决策必需**的事实；
任何**带版本号 / issue 号 / 性能数字 / 排障步骤 / 实现细节**的内容一律进上表或 `CHANGELOG.md`
（起因：首页曾有 7 处 `localStorage` 陈述在 v0.4.0 后集体失真）。

## 工程文档

| 文档 | 内容 |
|---|---|
| [REFACTOR-ASSESSMENT.md](./REFACTOR-ASSESSMENT.md) | **重构与设计落实账本（活文档）** —— 只留**决策、顺序、验收判据**：现状基线、风险归口、P0/P1/P2/P3 计划（**§5 的状态列是唯一进度真源**，由 `verify-ledger` 机器核对）。**机制不在这里** —— 在代码注释里 |
| [MODULE-LAYOUT.md](./MODULE-LAYOUT.md) | `lib/` 与 `src/` 的分工规范与目录约定（含 `test/` 的职责划分） |
| [ROUTE-INDEX.md](./ROUTE-INDEX.md) | 宿主路由的**生成索引**（由 `test/tools/host-route-index.mjs` 重算并逐字节比对 —— 手写必烂） |
| [ROBUSTNESS-AUDIT.md](./ROBUSTNESS-AUDIT.md) | 健壮性审计（**已收口**）—— 结论已归口为账本 §5 的 P3-1 … P3-22 |
| [F0-THEME-SERVICE-CHECKLIST.md](./F0-THEME-SERVICE-CHECKLIST.md) | F0 真机确认（**已关闭**）—— 结论（`V1–V10` 约束）在账本 §9.1；原始证据在本地未跟踪目录 |
| [awesome-dsh-plugin-pr-guide.md](./awesome-dsh-plugin-pr-guide.md) | 向 awesome-dsh-plugin 收录目录提交的一次性发布指南（应作者要求保留原版，勿改） |

## 已归档：已退役的渲染路线

**为什么归档**：这些路线的实现已在**独立仓库**维护 ——
[`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)（离线渲染成 PNG）与
[`YV3507/webwallgl`](https://github.com/YV3507/webwallgl)（浏览器端实时渲染器）。
本仓库**只保留历史记录**：下列文档在 `archive/` 下，**不反映现行实现**，也不再维护。

### 静态帧渲染线（`/scene-frame` 的离线渲染，**已随 P2-12 整体移除**）

| 文档 | 内容 |
|---|---|
| [SCENE-FRAME-PERF.md](./archive/static-frame/SCENE-FRAME-PERF.md) | 静态帧冷渲染成本实测 + 渲染器优化记录（哪些渲染可以砍、哪些假设被数据推翻） |
| [DEFAULT-SCENE-RENDER-AUDIT.md](./archive/static-frame/DEFAULT-SCENE-RENDER-AUDIT.md) | 官方默认壁纸渲染审计 —— 「无损渲染」的纯数学取证 |
| [RENDERER-FEASIBILITY.md](./archive/static-frame/RENDERER-FEASIBILITY.md) | 渲染器三路线可行性 + 方向决策（终点即迁往独立仓库） |
| [NATIVE-SCENE-EVIDENCE.md](./archive/static-frame/NATIVE-SCENE-EVIDENCE.md) | 原生场景引擎取证（WE 2.8.42）—— 几何依据与合成器缺陷 D-1/D-2/D-3 |
| [WE-REVERSE.md](./archive/static-frame/WE-REVERSE.md) | 官方引擎逆向的技术细节（以官方引擎为事实基准的复刻取证） |
| [TODO.md](./archive/static-frame/TODO.md) | 渲染引擎现状与 TODO（迁出前） |
| [`evidence/`](./archive/static-frame/evidence/) | 上述文档的实测证据脚本（跑法 `node docs/archive/static-frame/evidence/<name>.mjs`） |

### 场景动画线（`/scene-anim`，已移除）

| 文档 | 内容 |
|---|---|
| [SCENE-ANIMATION-HANDOFF.md](./archive/scene-animation/SCENE-ANIMATION-HANDOFF.md) | 场景动画交接手记 —— 放弃决策与理由、复刻必读的技术要点、已实现又删除的资产清单 |

## 其它

- 现状/TODO：仓库根 `TODO.md` **本机专用**（在 `.git/info/exclude` 里，不随仓库走；归口见账本 **P3-10**）。
- 开发/发布：仓库根 `CONTRIBUTING.md`；用户门面：`README.md` / `README.en.md` / `README.beginner.md`；测试目录说明：`test/README.md`。
- `images/`：README 引用的截图。
- **已溶解进代码**的文档（结论进注释，文件本身按上表处置）：`RENDERER-OFFICIAL-STRUCTURE.md`、
  `RENDER-ISSUES-ANALYSIS.md`、`REFACTOR-ROUND-2026-08-28.md`、`REFACTOR-STATIC-FRAME.md`、
  `dev-notes-bom-and-dsh-boot.md`；废弃方向（`HOOK-PROGRESS` / `V6-DUMP-ANALYSIS` / `EYE-PREDICTION` /
  `FIX-PLAN-AMYA` / `AMYA-CAMERA-ANALYSIS` / `RENDER-ISSUES-PROGRESS`）已删除。
