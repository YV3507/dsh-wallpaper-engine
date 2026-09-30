# docs — 决策与用户文档

本项目采用**「代码即真相」**文档模式：渲染 / 逆向 / 根因知识直接内联在对应实现文件的代码注释里。
`docs/` 只保留**决策**（含验收判据）、**规范**与**用户文档**；实现机制不在这里。

## 目录的寿命规则（新增文档前先读这一节）

| 类别 | 放哪 | 判据 |
|---|---|---|
| **常青** —— 用户文档 / 规范 / 参考 | `docs/` 根 | 描述**当前**行为或长期约定，随版本更新而不是随工作项结束 |
| **进行中** —— 某项工作的过程记录 | `docs/wip/` | 描述**尚未完成**的工作，或作为它唯一的进度真源。**完成即整体移入 `docs/archive/`**，不要就地改写成常青文档 |
| **历史** —— 已退役 / 已完成 | `docs/archive/` | 只作为记录存在，**不反映现行实现**；顶部必须有状态横幅 |

## 写作纪律（**注释 / 守卫 / 文档**三处的共同底线）

> 本仓的成文纪律只有这 6 条 —— 它们的**家在这里**（入库），不借住在任何本机专用的文件里。
> 每条尽量挂在能机器判定的地方（第三列）；还没挂上的**明写"无守卫"**，不含糊过去。

| # | 规则 | 判据 / 机制 |
|---|---|---|
| 1 | **注释写不变量，不写编年史** —— 日期、「曾经 / 旧实现」框定、实测症状与踩坑记录一律不进代码注释 | `test/verify-comment-discipline.mjs`（棘轮，只许下调） |
| 2 | **「实测 X ≈ Y」是出处，不是编年史** —— 给经验值与浏览器行为标出处的句子必须留，否则读者分不清「测出来的」与「猜的」 | 同上（棘轮**不数**「实测」） |
| 3 | **能写在代码旁的规则不单写文档** —— 机制 / 不变量 / 契约写在**文件头**；文档只留决策、顺序、验收判据与证据锚点 | 无守卫（写作约定）；落点规范见 [`MODULE-LAYOUT.md`](./MODULE-LAYOUT.md) |
| 4 | **退役线只许缩小** —— 反向探针先于删除；基线只许收紧，删完清空即为「零残留」 | `test/verify-retired-lines.mjs` |
| 5 | **守卫判据只针对代码，不针对散文** —— 断言「源码里不再有 X」之前先剥注释 | [`TEST-LAYOUT.md`](./TEST-LAYOUT.md) §约定 |
| 6 | **跳过不得与通过同形** —— 缺前置要么红，要么要求显式 `--allow-skip`；静默跳过等于悄悄失去覆盖 | `test/verify-media-bridge.mjs`（`--provision` / `--allow-skip`） |

**入库文档不得引用本机专用的未跟踪路径** —— 读者打不开的东西不要指向它。唯一豁免是 `docs/archive/`
（历史记录，顶部已声明不反映现行实现）与其取证线索；判据在 `test/verify-comment-discipline.mjs`，
豁免是否仍然有据也由它核对。

## 用户文档（中英双语，中文在前）

| 文档 | 内容 |
|---|---|
| [UPGRADING.md](./UPGRADING.md) | **升级指南** —— 前置条件、兼容矩阵、正确更新顺序与「顺序反了怎么恢复」 |
| [CHANGELOG.md](./CHANGELOG.md) | **变更记录** —— 逐版本功能与修复（新版在前） |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | **工作原理** —— 出图来源链（实时渲染 → 内嵌 MP4 → 实时抓帧 → 自定义画面 → 空态）、宿主 / 客户端分工、**字体集通道**、遮挡暂停与客户端异常留痕、HTTP 路由表 |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | **排障** —— 安装失败排查与「症状 → 先看哪里」速查 |

**分层约定**：门面 `README.md` / `README.en.md` 只放**不随版本变化、且新访客决策必需**的事实；
任何**带版本号 / issue 号 / 性能数字 / 排障步骤 / 实现细节**的内容一律进上表或 `CHANGELOG.md`
（起因：首页曾有 7 处 `localStorage` 陈述在 v0.4.0 后集体失真）。

## 规范与参考（常青）

| 文档 | 内容 |
|---|---|
| [MODULE-LAYOUT.md](./MODULE-LAYOUT.md) | `lib/` 与 `src/` 的分工规范、目录约定、开发面（`test/` / `scripts/`）的职责与深度陷阱 |
| [TEST-LAYOUT.md](./TEST-LAYOUT.md) | 测试目录说明：守卫 / 冒烟 / 工具各自放哪、为什么 `test/tools/` 要多数一层 `..` |
| [FONT-SYSTEM.md](./FONT-SYSTEM.md) | 字体系统的通道分工、9 条不变量、扩展步骤、进浏览器包的约束 |
| [ROUTE-INDEX.md](./ROUTE-INDEX.md) | 宿主路由的**生成索引**（由 `test/tools/host-route-index.mjs` 重算并逐字节比对 —— 手写必烂） |
| [dev-notes-bom-and-dsh-boot.md](./dev-notes-bom-and-dsh-boot.md) | BOM 与 DSH 启动的两个坑（结论已进 `CONTRIBUTING.md`） |
| [awesome-dsh-plugin-pr-guide.md](./awesome-dsh-plugin-pr-guide.md) | 向 awesome-dsh-plugin 收录目录提交的一次性发布指南（应作者要求保留原版，勿改） |

## 进行中（`wip/`）

| 文档 | 内容 |
|---|---|
| [POST-REFACTOR-AUDIT.md](./wip/POST-REFACTOR-AUDIT.md) | **收官后审计（过程记录，不含进度列）** —— 2026-09-29 重构结项后的只读复核，**只收工程债**：宿主的请求体上限 / 编码正确性 / 无界状态 / 中断泄漏 / 并发删产物、客户端启动链与状态拆除、注释与文档失真、残留的重构价值，以及**判据缺口**（为什么 32 条守卫全绿却漏掉这些）。每条只写现象 / 证据 / 影响 / 修法方向；**状态一律记在 `OPEN-ITEMS.md` §5**，条目收口后整体移入 `archive/` |
| [OPEN-ITEMS.md](./wip/OPEN-ITEMS.md) | **重构账本 · 未完成项与触发线（活文档）** —— **唯一的进度真源**：§2 现状基线（上界棘轮）、§3.1–§3.3 现状锚点、§5 状态列（**唯一进度真源**，由 `verify-ledger` 机器核对）、§7 触发线（第 6、7 条）、§9.1 令牌层约束。**本轮重构的主动部分已结项**（46 已落地 / 1 未完成）：唯一未完成项 P2-11 **未过触发线**、且**已机器化**（过线时那一行会变红逼人回来裁决）。历史半边（§1 / §3.4–§3.6 / §4 / §6 / §8 / §9.5–§9.7）已进 [archive/REFACTOR-ASSESSMENT.md](./archive/REFACTOR-ASSESSMENT.md)；**该线全部收口后本文件才整份移入 `archive/`** |

## 已归档（`archive/`，只作记录）

### 已退役的渲染路线

**为什么归档**：这些路线的实现已在**独立仓库**维护 ——
[`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)（离线渲染成 PNG）与
[`YV3507/webwallgl`](https://github.com/YV3507/webwallgl)（浏览器端实时渲染器）。
本仓库**只保留历史记录**：下列文档**不反映现行实现**，也不再维护。

| 文档 | 内容 |
|---|---|
| [static-frame/SCENE-FRAME-PERF.md](./archive/static-frame/SCENE-FRAME-PERF.md) | 静态帧冷渲染成本实测 + 渲染器优化记录（**该线已随 P2-12 整体移除**） |
| [static-frame/DEFAULT-SCENE-RENDER-AUDIT.md](./archive/static-frame/DEFAULT-SCENE-RENDER-AUDIT.md) | 官方默认壁纸渲染审计 —— 「无损渲染」的纯数学取证 |
| [static-frame/RENDERER-FEASIBILITY.md](./archive/static-frame/RENDERER-FEASIBILITY.md) | 渲染器三路线可行性 + 方向决策（终点即迁往独立仓库） |
| [static-frame/NATIVE-SCENE-EVIDENCE.md](./archive/static-frame/NATIVE-SCENE-EVIDENCE.md) | 原生场景引擎取证（WE 2.8.42）—— 几何依据与合成器缺陷 D-1/D-2/D-3 |
| [static-frame/WE-REVERSE.md](./archive/static-frame/WE-REVERSE.md) | 官方引擎逆向的技术细节（以官方引擎为事实基准的复刻取证） |
| [static-frame/TODO.md](./archive/static-frame/TODO.md) | 渲染引擎现状与 TODO（迁出前） |
| [static-frame/evidence/](./archive/static-frame/evidence/) | 上述文档的实测证据脚本（跑法 `node docs/archive/static-frame/evidence/<name>.mjs`） |
| [scene-animation/SCENE-ANIMATION-HANDOFF.md](./archive/scene-animation/SCENE-ANIMATION-HANDOFF.md) | 场景动画交接手记（`/scene-anim` 已整体移除） |

### 已完成的审计、真机记录与工作项计划

| 文档 | 内容 |
|---|---|
| [REFACTOR-ASSESSMENT.md](./archive/REFACTOR-ASSESSMENT.md) | **重构与设计落实账本（历史半边）** —— 一次重构与设计落实的完整评估：决策（§1）、四组维护难度指标（§3）、风险清单（§4）、静态帧线移除后的形态（§6）、度量方法与复现（§8）、F 轨设计要点与 `V1–V10` 令牌层实测结论（§9）、与其它文档的关系。**不反映现行实现**；仍活着的部分（基线 / 状态列 / 触发线 / 唯一未完成项）在 [`wip/OPEN-ITEMS.md`](./wip/OPEN-ITEMS.md) |
| [audits/ROBUSTNESS-AUDIT.md](./archive/audits/ROBUSTNESS-AUDIT.md) | 健壮性审计（已收口）—— 结论已归口为账本 §5 的 P3-1 … P3-22 |
| [audits/F0-THEME-SERVICE-CHECKLIST.md](./archive/audits/F0-THEME-SERVICE-CHECKLIST.md) | F0 真机确认（已关闭）—— 结论（`V1–V10` 约束）在账本 §9.1；原始证据在本地未跟踪目录 |
| [audits/P3-11-PLAN.md](./archive/audits/P3-11-PLAN.md) | `WallpaperPicker` 拆分的过程记录（**已完成**：模型 / 模态框 / 属性面板三块都搬走）—— 开工前的事实核对、先决断言清单与收口时的牙齿证明；结论在账本 §5 的 `P3-11` 行，判据在守卫本身 |
| [audits/LOGGING-PLAN.md](./archive/audits/LOGGING-PLAN.md) | 日志分级与提示通道的过程记录（**已完成**：G0 + P1–P5）—— 三档 `error` / `warn` / `info`（默认 `warn`）+ 一条独立的成功提示通道；含 G0 两项前置实测的结果、`ctx.logger` 等级语义实测与守卫耦合清单。**机制与不变量已留在 `lib/log.js` / `lib/notice.js` / `lib/routes/diag.js` 的文件头**，判据在 `test/verify-logging.mjs` |
| [audits/F3-PLAN.md](./archive/audits/F3-PLAN.md) | 字体集文件化的过程记录（**已完成**：阶段 0–4）—— 随包预设 · 两层存储（同 id 用户层胜 + 写时复制、「恢复随包原样」）· 人工切换 · 导入导出；含三条决策（D1 真源归属 / D2 导出通道 / D3 写时复制）、一次真机崩溃的根因与修法、各阶段"如实记下的差额"。**机制与不变量已留在 `lib/routes/fontsets.js` / `src/fontset-store.js` / `src/fontset-editor.js` / `lib/settings-schema.js` 的文件头**，判据在 `test/verify-fontset.mjs` + `test/fontset-load-smoke.mjs` |

## 其它

- 现状 / 进度：[`wip/OPEN-ITEMS.md`](./wip/OPEN-ITEMS.md)（**唯一进度真源**：唯一未完成项 + 触发线 + 基线）；历史评估在 [`archive/REFACTOR-ASSESSMENT.md`](./archive/REFACTOR-ASSESSMENT.md)（**不反映现行实现**）；写作纪律见本文档 §写作纪律。
  **本机专用的临时待办不入库**，也不被任何入库文档引用 —— 读者打不开的东西不指向它。
- 开发/发布：仓库根 `CONTRIBUTING.md`（含「`lib/client.js` 到底是什么」）；用户门面：`README.md` / `README.en.md` / `README.beginner.md`。
- `images/`：README 引用的截图。
- **已溶解进代码**的文档（结论进注释）：`RENDERER-OFFICIAL-STRUCTURE.md`、`RENDER-ISSUES-ANALYSIS.md`、
  `REFACTOR-ROUND-2026-08-28.md`、`REFACTOR-STATIC-FRAME.md`；
  废弃方向（`HOOK-PROGRESS` / `V6-DUMP-ANALYSIS` / `EYE-PREDICTION` / `FIX-PLAN-AMYA` /
  `AMYA-CAMERA-ANALYSIS` / `RENDER-ISSUES-PROGRESS`）已删除。
