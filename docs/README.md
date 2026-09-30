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

> 本仓的成文纪律只有这几条 —— 它们的**家在这里**（入库），不借住在任何本机专用的文件里。
>
> **纪律靠约定，不靠守卫。** 这里此前挂着一批"机器判定"的文档类守卫，已按
> [`adr/0006`](./adr/0006-comment-discipline-as-written-convention.md) 决定撤除（**决策已生效；
> 守卫文件的下线仍待执行** —— 在那之前它们照旧在 `npm run verify:docs` 里跑，其判据不算数）：
> 写作纪律判断的是「读者会不会被误导」，把它降级成正则匹配只会让作者去躲词表，
> 而且守卫自身会腐化与自相矛盾。
> 因此下表第三列**只写"由什么兜住"**，且**没有就是没有** —— 不许用一条恒真的判据冒充覆盖。
>
> 撤除的**只**是文档 / 注释 / 账本散文类；守**代码**问题的守卫（可达性、退役线、声明孤儿、
> 模块布局）**保留**，且不因本次撤除而放松。

| # | 规则 | 由什么兜住 |
|---|---|---|
| 1 | **注释写不变量，不写编年史** —— 日期、「曾经 / 旧实现」框定、实测症状与踩坑记录一律不进代码注释 | 无守卫（写作约定）。历史价值的内容进 `CHANGELOG.md` 或 git 历史 |
| 2 | **「实测 X ≈ Y」是出处，不是编年史** —— 给经验值与浏览器行为标出处的句子必须留，否则读者分不清「测出来的」与「猜的」 | 无守卫（写作约定）。出处**留在被实测的那个代码位置附近**，不搬进常青文档散文 |
| 3 | **能写在代码旁的规则不单写文档** —— 机制 / 不变量 / 契约写在**文件头**；文档只留决策、顺序、验收判据与证据锚点 | 无守卫（写作约定）；落点规范见 [`MODULE-LAYOUT.md`](./MODULE-LAYOUT.md) |
| 4 | **常青文档不写会漂的数值** —— 默认值 / 范围 / 枚举清单 / 条数 / 行数 / 体积 / 耗时阈值一律改为**符号引用**或**复算命令**。真源：设置 → `lib/settings-schema.js`，路由 → [`ROUTE-INDEX.md`](./ROUTE-INDEX.md) | 无守卫（写作约定，见 ADR-0006）。**例外**：`CHANGELOG.md` 与 `docs/archive/**` 是账本，其中数值**保持原样**，改了就是伪造记录 |
| 5 | **退役线只许缩小** —— 反向探针先于删除；基线只许收紧，删完清空即为「零残留」 | `test/verify-retired-lines.mjs` |
| 6 | **守卫判据只针对代码，不针对散文** —— 断言「源码里不再有 X」之前先剥注释 | [`TEST-LAYOUT.md`](./TEST-LAYOUT.md) §约定 |
| 7 | **跳过不得与通过同形** —— 缺前置要么红，要么要求显式 `--allow-skip`；静默跳过等于悄悄失去覆盖 | `test/verify-media-bridge.mjs`（`--provision` / `--allow-skip`） |
| 8 | **决策进 ADR，机制进文件头** —— 有备选方案、有人付了代价的取舍写成 [`adr/`](./adr/)；"怎么实现的"写在对应实现文件的头注释 | 无守卫（写作约定）；格式见 [`adr/README.md`](./adr/README.md) |

**入库文档不得引用本机专用的未跟踪路径** —— 读者打不开的东西不要指向它。唯一豁免是 `docs/archive/`
（历史记录，顶部已声明不反映现行实现）与其取证线索。

## 用户文档（中英双语，中文在前）

| 文档 | 内容 |
|---|---|
| [UPGRADING.md](./UPGRADING.md) | **升级指南** —— 前置条件、兼容矩阵、正确更新顺序与「顺序反了怎么恢复」 |
| [CHANGELOG.md](./CHANGELOG.md) | **变更记录** —— 逐版本功能与修复（新版在前） |
| [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) | **工作原理** —— 出图来源链（实时渲染 → 内嵌 MP4 → 实时抓帧 → 自定义画面 → 空态）、宿主 / 客户端分工、**字体集通道**、遮挡暂停与客户端异常留痕、HTTP 路由表 |
| [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) | **排障** —— 安装失败排查与「症状 → 先看哪里」速查 |

**分层约定**：门面 `README.md` / `README.en.md` 只放**不随版本变化、且新访客决策必需**的事实；
任何**带版本号 / issue 号 / 性能数字 / 排障步骤 / 实现细节**的内容一律进上表或 `CHANGELOG.md`
（起因：首页曾有一批 `localStorage` 陈述在某次持久化改造后**集体失真** —— 这正是本文 §写作纪律 4 的由来）。

## 规范与参考（常青）

| 文档 | 内容 |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | **架构总览** —— 两个半边（宿主插件 / 浏览器插件）、分层与路由族、构建期内联、启动与卸载生命周期、一次壁纸的数据流、**状态真源清单**、扩展点落点、边界表。只画结构，不写机制与数值 |
| [MODULE-LAYOUT.md](./MODULE-LAYOUT.md) | `lib/` 与 `src/` 的分工规范、目录约定、开发面（`test/` / `scripts/`）的职责与深度陷阱 |
| [DEV-GUIDE.md](./DEV-GUIDE.md) | **二次开发指南** —— "怎么加一个 X"的配方：加路由 / 加设置项 / 加浏览器端代码 / 加守卫，每节给落点、必须同步改的地方、以及**改错了会怎样** |
| [TEST-LAYOUT.md](./TEST-LAYOUT.md) | 测试目录说明：守卫 / 冒烟 / 工具各自放哪、为什么 `test/tools/` 要多数一层 `..` |
| [FONT-SYSTEM.md](./FONT-SYSTEM.md) | 字体系统的通道分工、不变量、扩展步骤、进浏览器包的约束 |
| [ROUTE-INDEX.md](./ROUTE-INDEX.md) | 宿主路由的**生成索引**（由 `test/tools/host-route-index.mjs` 重算并逐字节比对 —— 手写必烂） |
| [dev-notes-bom-and-dsh-boot.md](./dev-notes-bom-and-dsh-boot.md) | BOM 与 DSH 启动的两个坑（结论已进 `CONTRIBUTING.md`） |
| [awesome-dsh-plugin-pr-guide.md](./awesome-dsh-plugin-pr-guide.md) | 向 awesome-dsh-plugin 收录目录提交的一次性发布指南（应作者要求保留原版，勿改） |

## 决策记录（`adr/`）

**只记取舍**：有备选方案、有人付了代价、后人可能想推翻的那个决定。机制与不变量**不进这里** ——
它们住在对应实现文件的头注释里（本仓的成文纪律：能写在代码旁的规则不单写文档）。

写新 ADR 前先读 [`adr/README.md`](./adr/README.md)：那里有该写什么 / 不该写什么、
头部格式、以及**为什么不写会漂的数值**（与本文 §写作纪律 同口径）。

| ADR | 决定 |
|---|---|
| [0001](./adr/0001-webwallgl-in-tree-live-renderer.md) | 场景壁纸用内嵌 WebWallGL **实时渲染**，而不是离线成帧 / 转码 / 依赖 WE 常驻 |
| [0002](./adr/0002-settings-schema-single-source.md) | 设置的**唯一真源**收进一个共享文件，宿主与客户端都从它派生 |
| [0003](./adr/0003-build-time-module-inlining.md) | 浏览器半边靠**构建期内联**拆分，不用运行时模块 |
| [0004](./adr/0004-two-tier-guard-verification.md) | 守卫按**失败的含义**分硬 / 软两档 |
| [0005](./adr/0005-media-loopback-origin.md) | 壁纸媒体由宿主自建的**独立 loopback 源**提供 |
| [0006](./adr/0006-comment-discipline-as-written-convention.md) | 注释与文档纪律改为**纯写作约定**，撤除文档类机器守卫 |

## 进行中（`wip/`）

| 文档 | 内容 |
|---|---|
| [POST-REFACTOR-AUDIT.md](./wip/POST-REFACTOR-AUDIT.md) | **收官后审计（过程记录，不含进度列）** —— 2026-09-29 重构结项后的只读复核，**只收工程债**：宿主的请求体上限 / 编码正确性 / 无界状态 / 中断泄漏 / 并发删产物、客户端启动链与状态拆除、注释与文档失真、残留的重构价值，以及**判据缺口**（为什么 32 条守卫全绿却漏掉这些）。每条只写现象 / 证据 / 影响 / 修法方向；**状态一律记在 `OPEN-ITEMS.md` §5**，条目收口后整体移入 `archive/` |
| [OPEN-ITEMS.md](./wip/OPEN-ITEMS.md) | **重构账本 · 未完成项与触发线** —— §2 现状基线（上界棘轮）、§3.1–§3.3 现状锚点、§5 状态列、§7 触发线（第 6、7 条）、§9.1 令牌层约束。**本轮重构的主动部分已结项**（46 已落地 / 1 未完成）：唯一未完成项 P2-11 **未过触发线**（"等触发条件"，不是在做）。⚠️ **状态列不再有机器兜底** —— 逐行核对的账本守卫已随 [`adr/0006`](./adr/0006-comment-discipline-as-written-convention.md) 下线，读它请按"未经核对的记录"对待。历史半边（§1 / §3.4–§3.6 / §4 / §6 / §8 / §9.5–§9.7）已进 [archive/REFACTOR-ASSESSMENT.md](./archive/REFACTOR-ASSESSMENT.md) |

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

- 现状 / 进度：[`wip/OPEN-ITEMS.md`](./wip/OPEN-ITEMS.md)（未完成项 + 触发线 + 基线；⚠️ **状态列已无机器核对**）；历史评估在 [`archive/REFACTOR-ASSESSMENT.md`](./archive/REFACTOR-ASSESSMENT.md)（**不反映现行实现**）；写作纪律见本文档 §写作纪律。
  **本机专用的临时待办不入库**，也不被任何入库文档引用 —— 读者打不开的东西不指向它。
- 开发/发布：仓库根 `CONTRIBUTING.md`（含「`lib/client.js` 到底是什么」）；用户门面：`README.md` / `README.en.md` / `README.beginner.md`。
- `images/`：README 引用的截图。
- **已溶解进代码**的文档（结论进注释）：`RENDERER-OFFICIAL-STRUCTURE.md`、`RENDER-ISSUES-ANALYSIS.md`、
  `REFACTOR-ROUND-2026-08-28.md`、`REFACTOR-STATIC-FRAME.md`；
  废弃方向（`HOOK-PROGRESS` / `V6-DUMP-ANALYSIS` / `EYE-PREDICTION` / `FIX-PLAN-AMYA` /
  `AMYA-CAMERA-ANALYSIS` / `RENDER-ISSUES-PROGRESS`）已删除。
