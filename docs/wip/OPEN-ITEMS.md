# 重构账本 · 未完成项与触发线（**活文档**）

> **本文是唯一的活文档，也是唯一的进度真源。** 它与
> [`docs/archive/REFACTOR-ASSESSMENT.md`](../archive/REFACTOR-ASSESSMENT.md)（**历史记录，不反映现行实现**）
> 由同一份「重构与设计落实账本」拆分而来；分家规则只有一条：
> **`test/verify-ledger.mjs` 实际读取的节留在 `wip/`，其余整体进 `archive/`**。
>
> **还活着的部分**：§0 用法与状态图例 · §2 规模基线（上界棘轮）· §3.1–§3.3 现状锚点 ·
> §5 状态列（每行都有机器证据）· §7 触发线（第 6、7 条）· §9.1 令牌层约束（`V1–V10`）。
>
> **程序状态：本轮重构的主动部分已结项。** P0–P3 与 F 轨的步骤都已落地 —— §5 现为 **46 已落地 / 1 未完成**，
> 而那一条（**P2-11**）受 §7 第 6、7 条**触发线**管辖：实测 `lib/index.js` 内 14 条注册、首段各不相同、
> 最大族 1 < 3，跨路由的"隔空故障"也未发生 ⇒ 按账本自己的规则**现在不该做**（继续拆只会增加间接层）。
> 两条触发线**已机器化**（见 §5 那一行的证据入口）：过线时那一行会**当场变红**，逼人回来裁决（拆族 或 改线）。
>
> **结项后这份文档怎么用**：① **不再驱动主动的结构改动**（§5 里没有"过了线却没做"的项）；
> ② **判据继续跑** —— §2 规模数字 / §5 状态列 / §7 触发线仍由
> [`test/verify-ledger.mjs`](../../test/verify-ledger.mjs) 机器核对 ⇒"结项"不等于"结项即腐化"；
> ③ **新的结构性机会另起一份账本**（本文件的顺序与验收判据是为这一轮定的）；
> ④ 该线**全部**收口后本文才整份移入 `archive/` —— 现在那一条是"等触发条件"，不是"已收口"。
>
> 状态列由 [`test/verify-ledger.mjs`](../../test/verify-ledger.mjs) 机器核对（谎报状态即红）。
> 写作纪律（不写实现细节 / 不写编年史 / 已完成项每条一句）住在 [`docs/README.md`](../README.md) §写作纪律。

---

## 0. 怎么用这份文档

**状态取值**：`⬜ 未开工` / `🟡 进行中` / `✅ 已落地` / `➖ 已作废`。

**「一步三交」**：每一步必须同时交出三样，缺一不算完成 —— 这条就是本文对"边重构边落实设计"的定义。

| # | 交什么 | 判定 |
|---|---|---|
| ① **结构** | 代码的移动 / 删除 / 抽取本身 | 从 `lib/index.js` / `lib/client.js` 出发的**可达闭包干净**（无悬空 import、无"删了文件守卫还引用") |
| ② **规则** | 该步落地的**不变量**写进代码旁注释 | `verify-comment-discipline` 不因新增注释变红；只描述"必须/不得"，不描述"曾经" |
| ③ **守卫** | 能机器判定的部分加断言，**正/负对照成对**，挂进 `npm run verify` | 负对照必须在场（判据要有牙） |

**执行铁律**：一次提交只切一刀 · `verify:all` 未绿不得提交 · 不做批量文本替换 · **删除先行、重写殿后** ·
**反向探针先于删除** · 守卫判据**先剥注释**再判 · 修复必须配一条能钉住它的守卫 · 只 `git add` 自己的文件。

> ⚠️ **进度标记只许住在 §0 的状态图例与 §5 的状态列** —— 别的节里再写一句"这一步还没做"，就是
> **第二份、无人核对的进度真源**：其余判据都只解析 §5，发现不了它，而它误导的正是"还要不要做、
> 能不能提交"这个判断本身。那条规则同样有守卫（§5 之外零标记 + 负对照）。

---

## 2. 当前基线（复现命令见 §8）

| 指标 | 当前值 |
|---|---|
| 浏览器正文 `src/client.js` | **4135 行**（重构起点 10,119 行） |
| 构建期内联模块 | **21 个**（20 个来自 `src/` + 共享内核 `lib/settings-schema.js`） |
| `lib/**`（`verify-reachability` 打印的「lib 扫描面」：`lib/**.{js,mjs}` **全量**，vendored 与生成物都在内） | **25 文件 / 29199 行** |
| 其中**运行时不可达** | **0 文件 / 0 行**（P2-12 第一半已删净；此前 48 文件 / 9,618 行曾在 `files` 里、真的发给用户） |
| 生成物 `lib/client.js` | 13791 行 / 1.35 MiB（提交；判据是"重建后 `git status` 干净"） |
| 守卫 + 冒烟 | **32 个 `verify-*`（16562 行）+ 6 个 smoke（2834 行）**，均在 `test/`（另有 3 个 `compat-*` 在 CI 专属的 compat 层 + **9 个 `tools/` 手动工具**，都不进 `verify` 链；工具清单在 [`docs/TEST-LAYOUT.md`](../TEST-LAYOUT.md)） |
| vendored | `webwallgl/` + `vendor/` 共 **12 文件 / 6,950 行** |

> 逐阶段的增量对照表（P0 后 / P1 后 / F1 后 / F2 后）已删除：那些数字只在当时有意义，现值以上表为准。

---

## 3. 四组维护难度指标（只留结论）

> §3.4 更新维护难度 / §3.5 `apply(ctx)` 拆分评估 / §3.6 P3 的来源已随历史半边归档 ——
> [`docs/archive/REFACTOR-ASSESSMENT.md`](../archive/REFACTOR-ASSESSMENT.md) §3。
> §3.1–§3.3 留在这里：`verify-ledger` 的规模、复制度作用域与路由条数判据锚的就是它们。

### 3.1 复杂度：集中在 **2 个巨石**

| 巨石 | 体量 | 锚点 |
|---|---|---|
| `WallpaperPicker` 组件 | **722 行**（P3-11 前 1,033 / 原估 1,051 行，分支代理 202 = 当时的 `src/client.js` 的 25%）；模型 / 模态框 / 属性面板已抽到 `src/picker-*.js` | `src/client.js`；六个页签渲染器在 `src/panel-tabs.js`，瞬态字段**零裸直写**（守卫 ①d 钉住：`setTransient` 是唯一入口），其余模块对已知瞬态字段的裸直写 **11 处**（守卫 ①e 上界棘轮，只许下降） |
| `apply(ctx)` 宿主函数 | **1,203 行 = `lib/index.js` 的 34%**，分支代理 219，32 条路由（**6 族 / 18 条已拆出**到 `lib/routes/`） | `lib/index.js`；内含 4 个巨石 `buildInventory`(137) / `handleSceneFiles`(65) / `serveFile`(49) / `ensureMediaOrigin`(42) |

⚠️ **复杂度的分布比总量更值得注意**：`lib/media/` 分层清楚（`lib/we-renderer/` 曾也是一棵干净的树，已随 P2-12 删除）。
**烂的是两个门面文件，不是整个仓库** —— 这决定了 P2 是"拆门面"而非"重写内核"。

### 3.2 冗余度：文本不重复，结构重复很重

- **文本级重复**：`src/**` 8 行窗口 16 簇 / 0.8%、20 行 **0 簇**；**`lib/**` 是 103 簇 / 9.6%、20 行 28 簇**。
  ⇒ §1 那句"代码复制率不足 1%"**只对浏览器半边成立**，已限定作用域。
- **结构级重复**（**已全部结清**；有意保留的那条除外）：jpeg-js vendored 副本 + 死依赖（**已修**）·
  PKG/TEX 读取器两份且都在活路径上（**P3-17 已合并** —— 容器原语收口到唯一实现 `lib/pkg-read.js`，
  取更严格的一侧：带 `MAX_DECOMPRESSED_BYTES` 上限；`pkg-extract.js` / `scene-manifest.js` 都从它 import）·
  ~~设置键 4 处镜像~~（P1-5 ✅）· ~~缓存键两处构造~~（P1-6 ✅）。
  ⇒ **只剩"双媒体后端并存"，那是有意保留的设计选择**，不是待办。

### 3.3 耦合度：**一个真接缝 + 一堆全局变量**

**好**：跨端耦合是 **HTTP 协议**（宿主 **32** 条路由注册 ↔ 客户端所有宿主调用都经 `src/api-client.js` 一个出入口），DSH 平台耦合面很小（`inject = ['webServer']` + `ctx.loader` 1 处）。
**坏**：客户端内部**无强制边界** —— 唯一的强制边界 `emit()` 是**全局 store 广播**，不是选择性接缝。
**共变耦合**（能量化"改一次要动几处"）：平均每次提交动约 **7.5 个文件**（`git log --name-only` 复算）（生成物入库 + 中英双份文档 + 守卫与实现同改所致）。

---

## 5. 工作计划（**状态列是唯一进度真源**）

> **已完成项每条一句**：它的结构 / 规则 / 守卫三样东西的**展开形态在代码与守卫里**（模块头契约、`verify-*` 断言），
> 本文不复述。未完成项写清**验收判据**（怎么算做完）。

### P0 —— 立刻做（纯加固，零新增功能）

| # | 动作 | 状态 |
|---|---|---|
| P0-1 | `.github/workflows/verify.yml`：每次 push / PR 在 windows-latest 跑 build + verify + smoke，并断言产物同步与无尾随空白 | ✅ |
| P0-2 | 删死依赖 `jpeg-js`、lock 的 `js-yaml` 对齐 override、根目录吉祥物源资产**归档**（非删除）到 `assets/mascot/` | ✅ |
| P0-3 | 下线三条孤儿路由（`/scene-runtime` `/scene-manifest` `/scene-resource`）+ `lib/scene-player.js`（1,946 行）+ `inventory.sceneUrl` | ✅ |
| P0-4 | 退役行的**防蔓延**反向探针落地（`verify-retired-lines.mjs`，11 项含 4 条正负对照）；**不删任何静态帧代码** | ✅ |

### P1 —— 收敛单一真源 + 零耦合抽取

| # | 动作 | 状态 |
|---|---|---|
| P1-5 | 设置键收敛到唯一真源 `lib/settings-schema.js`，客户端与宿主两侧全部改为派生（行为由 18 例 golden 夹具钉住） | ✅ |
| P1-6 | 帧缓存键收敛到**单一构造点**（`sceneFrameSlot` 复用 `sceneFrameCacheKey`，不自带版本前缀；注释改写成不变量） | ✅ |
| P1-7 | 抽出 `src/we-cond.js`（条件求值器）与 `src/effects.js`（效果应用层）两个客户端模块 | ✅ |
| P1-8 | 账本自检守卫 `verify-ledger.mjs`：状态列机器可核，负对照**从账本自身推导** | ✅ |

### P2 —— 分批（一次一刀，每刀独立提交）

| # | 动作 | 状态 |
|---|---|---|
| P2-9 | `src/api-client.js` 成为宿主 API **唯一出入口**；客户端 13 个模块**零裸 `fetch`**（棘轮 26 → 0）；持久化层抽出为 `src/persistence.js` | ✅ |
| P2-10 | 六个页签抽出到 `src/panel-tabs.js`（**显式 ctx**）；store 写入收敛到 `setSetting` / `setTransient`（"赋值 + 落盘"手抄 50 → 0，页签零 `selection` 引用） | ✅ |
| P2-11 | 宿主 `apply(ctx)` **按路由族拆分**：第一族 `diag` 已落地 → `lib/routes/diag.js`（4 条注册）。**验收判据**：`lib/index.js` 内零 `webServer.register({`、索引逐字节一致、运行时注册条数 == 索引行数。剩余族按 §3.5 的固定动作推进，触发条件见 §7 第 6、7 条。**§7-6 实测（机器判据，已复评）**：`lib/index.js` 内 **13 条注册字面量展开为 14 条路由，14 个首段各不相同、最大组 1 < 3** ⇒ **没有任何族达到 ≥3 条**，按账本自己的规则**不拆**（待过线，或 §7-7 的跨路由隔空故障把优先级提上来）。**触发线已机器看守**：[`test/verify-ledger.mjs`](../../test/verify-ledger.mjs) 的 `P2-11` 证据①「§7-6 触发线未过：`lib/index.js` 内路由按路径首段归组、最大组 < 3」（某族长到 3 条它当场变红 ⇒ 回来裁决：拆族 或 改 §7-6 的线）+ 证据②「族模块与 `apply` 调用一一对应」（孤儿族模块 / 族数 < 6 判红） | 🟡 6 族已落地；剩余族**未过触发线**（有机器判据，非未做） |
| P2-12 | **静态帧线整体移除（5 阶段）**：删死树 48 文件 / 9,618 行 + 提取链 + 预热，键改名 `lf1`，客户端值域收缩为 `{0,4}`，术语收口。**可达性 0 / 0**。契约与仍在生效的裁定见 §6 | ✅ |

### P3 —— 未归口 / 未声明的需求（与 P2 并列，互不阻塞）

> P2 是"动手拆巨石"；P3 是**让已经写下的声明变成真的**。各条都远小于 P2 的一刀，可在 P2 之间插空做。

| # | 动作 | 状态 |
|---|---|---|
| P3-1 | 类型面与代码对齐：`lib/types/*.d.ts` 补 13 个字段与两个值导出，并新增 `verify-types.mjs` | ✅ |
| P3-2 | 产物同步性指标的表述更正为"重建后 `git status` 干净"（产物是**加载器包装 + 19 个内联模块**，与原文件不可能逐字节一致） | ✅ |
| P3-3 | 可达性守卫入库并挂链：`verify-reachability.mjs`，**不可达行数只许减少**（棘轮已收到 **0 文件 / 0 行**） | ✅ |
| P3-4 | 死 import 已删；`as-is` / `pruned` 两口径与两条"假活锚点"的建模写进脚本头与 §3.6/§8 | ✅ |
| P3-5 | `src/` 通用孤儿扫描（`verify-module-layout.mjs` ①）：除 `client.js` 外每个 `src/**/*.js` 必须已登记 `INLINE_MODULES` | ✅ |
| P3-6 | 依赖方向单向：`lib/**` 不得 import `src/**`（零容忍，同守卫 ②） | ✅ |
| P3-7 | 共享内核白名单（同守卫 ③）：允许被内联的 `lib/**` 只许来自显式清单（当前恰好 1 条） | ✅ |
| P3-8 | 注释纪律棘轮的覆盖面**从磁盘枚举**：CEIL 键存在性 + 每个内联模块必须被覆盖 | ✅ |
| P3-9 | 给 `P2-9` / `P2-10` / `P2-11` 补机器证据，消除"标 ✅ 却无可核产物" | ✅ |
| P3-10 | **本机待办不入库**，其写作纪律与取证配方却被入库文档 / 守卫指向（复算：指向**根**待办的 9 处；原记 17 处把**已入库**的 `docs/archive/static-frame/TODO.md` 也算进来了）。6 条写作纪律已收口到 [`docs/README.md`](../README.md) §写作纪律（其中 5 条本就住在守卫头部 / `TEST-LAYOUT`），并新增"常青入库文档不得引用本机专用路径"断言（正 / 负对照 + 豁免有据）。**验收判据**：常青面零引用 + 该断言入链 | ✅ |
| P3-11 | **客户端最后一个巨石**：`WallpaperPicker` —— 实测 `src/client.js` **2396–3428（1,033 行）**（原记的 3446 / 1,051 行把 3435–3441 的 `WallpaperPickerSection` 一并框进来了），体内**没有任何子组件**（101 处内联 `createElement`），六个页签渲染器早已搬去 `src/panel-tabs.js` ⇒ 留在 `client.js` 的只有**模态框那份网格**；出向 **84 个**跨边界名字（props 只传 `repoPanel`，**没有任何回调经 props**）⇒ 接缝成本高。**"体内最大嵌套单元仅 6 行"不可复现**（实测最大花括号深度 5、直方图 `{1:365,2:441,3:161,4:59,5:6}`、真正抬升一层的最长块 13 行、最长箭头体 36 行），但**结论方向成立**：真实形态是**宽而浅**（处理器区 469 行 / 45%，含 53 个 `on*`；顶层 return 是单条 281 行表达式 / 27%）。**计划见 [`P3-11-PLAN.md`](../archive/audits/P3-11-PLAN.md)**（已归档） —— 阶段 0 先补行为断言：实测 `verify-client.mjs` 有 **39 处"log 形式伪判据"**（`console.log('x (expect 1):', n === 1)`，占该文件判据约 24%）⇒ **已清零**（机械转换 35 + 人工 11；踩到三个坑：本文件 `assert` 是 strict ⇒ `sliderMax()` 的字符串要按 `'200'` 比；标签写 `expect 6` 但表达式含 `\|\|` 只转成了真值断言；三处"…: ok（N 例）"汇总行本身不判真假）并落地**必须为 0 的棘轮**（牙齿证明：插入一条新伪判据 ⇒ 红并报行号）；分页器整块已换成 11 条真断言 + 2 条负对照；**上传与目录编辑器**由新守卫 `test/verify-picker-upload.mjs`（531 行 / 44 条检查 = 23 正 + 21 负对照）覆盖，并已接进 `verify` 链 + 棘轮表 + 重生 `ROUTE-INDEX.md`（守卫提及列位移：`/inventory` 8→9 等 —— 索引与守卫必须同交）。**模态框 ESC/焦点陷阱的先决条件当初不满足**（挂载台没有 `activeElement`/`focus()`/键盘派发，`trapModalTab`、`modalInitialFocus` 零引用）⇒ **阶段 0b 已补**：挂载台补齐这三样语义与 `window.confirm`，Tab 陷阱 / 初始焦点 / ESC 三条判据都已落地（含负对照）；阶段 1 提纯状态机 `src/picker-model.js`（**连带搬走** `ratingOf`/`isPlayableType`/`isRotatableWallpaper`/`isHiddenWallpaper`/`isUploadedWallpaper`/`isDirWallpaper`，配**跨层对拍**）；阶段 2 只搬模态框 `src/picker-modal.js`（主风险 = **116 个 `.we-picker__*` 选择器的层级契约**，另有 e2e 里一份手抄 markup 镜像要同步）；阶段 3 属性面板。**明确不搬处理器区**：53 个 `on*` 是 ctx 的供给方，搬它等于把接缝从 2 条变成 60 条。**验收判据**：跨层对拍成立（模型算出的卡片数 == 渲染出的 `.we-picker__card` 数）；每个新文件进 `INLINE_MODULES`（why + markers）与 `verify-comment-discipline` 的 CEIL（基线 0）；`lib/client.js` 随 `src/**` 重建入库；关闭时补 `verify-ledger` 的 `P3-11` EVIDENCE（**已补** —— 修前该键不存在，所以这条的 `⬜` 当时不是机器可核的） | ✅ **阶段 0b ✅ + 阶段 1 ✅ + 阶段 2 ✅ + 阶段 3 ✅**：0b 把计划表的先决断言全部落地（分页器 / 搜索 / 类型筛选 / 批量勾选与批量隐藏 / 隐藏页与全部恢复 / 卡片头跨层对拍 / 库存错误态与重试 / 模态框 Tab 陷阱·初始焦点·ESC / 轮换列表编辑器全套 / 上传与目录编辑器另建守卫 44 条），并把 `verify-client` 里 **39 处"log 形式伪判据"清零**且设成**必须为 0** 的棘轮；阶段 1 把六个谓词 + 派生数据 + 分页提纯到 `src/picker-model.js`（170 行），`client.js` 净少 72 行，守卫 `test/verify-picker-model.mjs`（99 条，含跨层对拍 + "24 张 / 2 页"绝对锚点）；阶段 2 把模态框整块渲染搬到 `src/picker-modal.js`（271 行，`client.js` 再净少 207 行），**验收证据**：搬迁前后**类名多重集与 HEAD 零差异**（360 次 / 114 类名）、标记清单该走的走了该留的留了、模块里 0 处 `selection`/`emit`/`setSetting`/`import`、**顶层无可执行语句**、**11 个过渡回调仍定义在 `client.js`**（模块内 `on*` 定义数 0）、`verify-client` 的"标记等价"判据（三态 golden + 3 负对照含"只挪一层" + 字面量绝对锚点 160）**牙齿证明成立**（改一处搬过去的标记 ⇒ 判据红）、`verify` 26 条 + `smoke` 全绿、产物逐字节同步。**阶段 3 完成**：属性面板整块渲染搬到 `src/picker-props-panel.js`（144 行含契约头；`client.js` 只留一层组装适配、净少 94 行，`userProps` 的读写助手与面板状态**一行没搬**）。**先做可达性**——原来的阻碍（面板在挂载台里渲染不出来）由新守卫 `test/verify-picker-props.mjs`（734 行 / 61 条 = 44 正 + 17 负对照）解决：夹具给一张带 `propsUrl` 的网页壁纸 + 可控 `/props/<token>` 应答（在途 / 成功 / 非 2xx / 2xx 但体说 not-ok 四态）；断言覆盖入口三态（网页壁纸出按钮，图片壁纸与**无 `propsUrl` 的场景**都不出）、面板真的渲染出来（头部 + 6 行绝对锚点 + 分组标题不占行）、每个 ptype 的控件分支（bool/color/slider/combo/file/textinput + 兜底）、`condition` 显隐、改动落盘（`userProps` 按 token 存 / 滑块拖动中不重渲染 / 「恢复默认」清覆盖）、两条失败腿的文案，以及**标记等价**（27 令牌 golden + 6 条负对照含"只挪一层"）。**牙齿证明（产品侧，经 `DSH_MUT_LIB` 变异产物）**：① 多加一个类名 ⇒ golden + 绝对锚点红；② **只把提示行挪一层（长度不变）⇒ 只有 golden 红**（层级漂移正是 CSS 层级选择器关心的那类改动）；③ 让属性定义永不重拉 ⇒ 「真的发出一次 `/props` 请求」立即红（证明可达性判据挂在真实路径上）；④ 把失败文案短路 ⇒ 失败腿判据红（面板会改口说"没有用户属性"，正是要拦的静默说谎）；⑤ 在模块里写一句 `selection.id` ⇒ `verify-client` 的接缝判据报"属性面板渲染器不得直接读写 selection（当前 1 处）"。登记三处齐全（`INLINE_MODULES` + CEIL 基线 0 + `verify` 链 26→27），`ROUTE-INDEX.md` 随之重生（`/props` 提及 2→3），`verify` + `smoke` 全绿、产物逐字节同步。**闭环**：`verify-ledger.mjs` 补上 `P3-11` EVIDENCE（该键原先不存在，所以这条此前不是机器可核的），计划文件整体移入 `docs/archive/audits/` |
| P3-12 | 补 `engines`（`>=18`，= 代码真实下限） + `verify-contracts.mjs` ① | ✅ |
| P3-13 | 挂链缺失的守卫、缺前置改为**默认红**或显式 `--allow-skip`（不再与"通过"同形）；CI 另起一步 `npm run verify:bridge`（带 `--provision`，失败即红）⇒ media-bridge 端到端在 CI 有覆盖。**本机仍证明不了**（下载被挡 / 沙箱里 spawn 是 EPERM）⇒ 那一段的判据只由 CI 给出 | ✅ |
| P3-14 | 四处"过滤集变空即恒真"的判据补下限或改成单独计数（theme-layer G2 / softrender 两个 gate / package-files P5 / scene 平台跳过） | ✅ |
| P3-15 | 修"断言被写法或环境短路"：F 轨解析、"每个 EVIDENCE 键都必须被查到"、去掉 `\|\| typeof fetch` 逃生口、退役键扫描扩面、`apply` 抛错改硬断言 —— **五项逐条核过并各自挂了机器证据**（见 `verify-ledger` 的 `P3-15`：F 轨 ID 能被账本解析、逃生口已拆成两条无门断言、退役键扫描覆盖 5 个归属文件、`apply` 抛错是 `assert.equal`），状态由账本守卫的"证据全成立 ⇒ 该翻"逼正 | ✅ |
| P3-16 | 替换**恒真式负对照**（名不副实）：route-index / retired-lines / theme-layer / softrender / package-files 已修；两个残留文件已**逐条审计 18 条对照** —— 实测只有 **2 条真恒真**（`verify-component-fonts` 里"只断言常量 / 数组不含 X"），另有 4 条是**判据副本**（对照里另抄一份判据 ⇒ 生产侧改了也不会红），其余本就有牙。判据已抽成命名函数 / 命名正则、正负共用；形态规则写进 [`TEST-LAYOUT.md`](../TEST-LAYOUT.md) §约定 5。**验收判据**：把判据中和成"永远说没问题" ⇒ 对应负对照必须变红（实测两条全红，而正判据此时照过 = 空转） | ✅ |
| P3-17 | ✅ **已合并**（P3-17 那一刀）：容器/压缩原语搬进唯一实现 `lib/pkg-read.js`（270 行），取更严格的一侧（带 `MAX_DECOMPRESSED_BYTES` 上限）；`pkg-extract` 850→644、`scene-manifest` 511→254。详见下方原判据 |
| P3-17（原判据留档） | **同一套 PKG/TEX 读取器两份实现、且两份都在活路径上**（`lib/pkg-extract.js` ↔ `lib/scene-manifest.js`），不受信输入的分配上限**只加在副本上** ⇒ 同一 `scene.pkg` 在 `/scene-video` 被拒、在 `/scene-audio` 却能驱动 ~2GiB 分配；没有任何守卫比较两份。**验收判据**：导出点唯一 + 上限常量唯一 + 同一夹具对两条路由给出一致裁决 | ✅ |
| P3-18 | 删掉 `lib/index.js` 的死 `readPkg` import（不再为它新建第 3 份、语义不同的 PKG 解析器） | ✅ |
| P3-19 | 收窄 P2-12 的机器退出条件（`lib/scene-manifest.js` 必须**存活**，它仍是 `/scene-video` 与库存视频探测的活依赖），并新增两条"活依赖存活"断言 | ✅ |
| P3-20 | 复制度结论写明**作用域**（`src/**` 与 `lib/**` 差别极大，单边结论不得当全仓不变量） | ✅ |
| P3-21 | 跨半边词汇表（`BASE`、上传 / 自定义画面 MIME）由 `verify-contracts.mjs` ② **读两边源码**比对（不是 import 一边的自证） | ✅ |
| P3-22 | ✅ **已修**：病灶是 `verify-scene.mjs` 真 socket 的 **33MB 超限 PUT** —— 413 路径本身会 `res.end()` 后立刻 `req.destroy()`（设计如此），而 33MB 请求体远没写完 ⇒ 客户端可能先拿到 ECONNRESET。按验收判据改为**接受两种合法结果**（413 / 连接被主动掐断），并**保留"恰好 limit+1"那条**（超限块即最后一块、无竞态）把精确 413 语义钉死；判据仍有牙：服务端若不拒绝，拿到的是 200 而不是 0 | ✅ |
| P3-23 | **夹具把被测行为中和掉**（零覆盖类，后续新增）：实例 —— 所有冒烟都把 `liveBootDelay` 钉成 0，于是"启动等待"路径**零覆盖**，它的两个缺陷（延迟期切走不释放 / 挂载后不武装心跳）只能靠用户反馈发现。交付**只给候选、不下判决**的手动工具 `test/tools/audit-fixture-coverage.mjs`（行为面与数据面分开；自带"必须抓到 `liveBootDelay`"的自检；三个已知局限写在工具头）。**验收判据**：A/B 两族候选**逐条**给出"已有守卫覆盖 / 待补"的结论，待补的落成能失败的守卫 | ✅ A 类 5 个 + B 类 2 个**全部裁定并落成守卫**（都在 `rotation-prepared-leak-smoke`）：`liveBootDelay`（Q1–Q3）· `videoVolume`（R1/R1b/R1c）· `rotationEnabled`（R2）· `rotationGroupId`（R3/R3b）· `pauseOnBlur`（R4/R4b）· `sceneLive`（R5）· `playbackRate`（R6）。**`pauseOnBlur` 的缺口比"没写用例"更深**：挂载台把 `hasFocus` 硬编码为 `() => true`，且 `play()/pause()` 不同步真 DOM 的 `paused` ⇒ 两个分支都不可达 —— 故一并修了**挂载台保真**（不修的话"夺回焦点自动恢复"永远走不到 `play()`，与真机分叉）。**牙齿实证四组**：中和 `weAudioVolume` / `syncRotationTimer` 的早退 / `pauseOnBlur` 那一档 / `liveRenderEnabled` + **两处** `playbackRate` ⇒ 每次**恰好**对应断言变红、其余不受影响（`playbackRate` 有两处落地：只中和一处**不红** —— 判据测的是"结果"而非"某处实现"，这正是想要的） |
| P3-24 | **harness 适配 CI（基线制）**：`harness-compat.yml` **只按需运行** —— 触发面只有 `workflow_dispatch`（不挂 schedule / push；派发 `gh workflow run harness-compat.yml [-f harness_version=<版本>] [-f force=true]`），目标对（harness 版本 × 插件 commit）已入基线则秒过；否则装该 harness → 隔离 profile link 本插件 → 起真 harness 探活（`test/compat-harness-live.mjs`：路由 204 / 落盘标记 / 环形缓冲回读 / 日志无 `plugin tree failed to load`）→ `verify:all`。**全绿才写 `.github/harness-baseline.json` 并自动提交**；任一步失败 ⇒ 红且基线保持上一个全绿对，未入基线的目标保持未入账、下次派发时再试（**不自动重试**）。**第三方边界**：不跑 `verify:bridge` / `verify:e2e`，探活 `DSH_WE_MEDIA_LEGACY=1` 只打 diag 族路由。**验收判据**：工作流触发面只有 `workflow_dispatch`（无 schedule / push）、跑 `verify:all` 且不含 `verify:bridge`；探活/基线两脚本在册且进棘轮表（见 `verify-ledger` 的 `P3-24` 四条证据） | ✅ |
| P3-25 | **harness UI 面清单棘轮 + sidebar 源码活判据**（回答「harness 新增页面、美化没盖住能查出来吗」：纯插件自指断言查不出，必须把 harness 侧事实拉进判据）。compat CI 枚举已装 harness 的 `dsh-client-ui-*` 包集，与提交清单 `test/fixtures/harness-ui-surfaces.json`（**52 项裁定**：按 0.1.7-rc.2 latest 播种，sidebar-right=covered、其余 native）做差 ⇒ **新表面未登记即红**：机器只判「新东西出现」，盖不盖由人裁定、裁定必须落盘（改名以「新名未登记」被抓，纯删除不拦；包内新增页面查不出，归下一档页面级快照）。并对**实际安装的** `dsh-client-ui-sidebar-right` 源码断言 `data-sidebar-right-panel` / `data-sidebar-right-open` 两个属性锚点与隐藏机制 allowlist（translate 滑出 / visibility 切换 —— 上游 #107 从注释里的散文引用变成活判据；实测 0.1.7 已无 `translate(100%)`、只剩 visibility，**allowlist 缺一腿就会对基线目标误报红**）。**验收判据**：脚本 / 清单 / 工作流接线三处在册（见 `verify-ledger` 的 `P3-25` 四条证据） | ✅ |
| P3-26 | **逐页 DOM/样式断言（档位 2）**：`test/compat-harness-pages.mjs` 用零依赖 CDP（Node ≥22 全局 WebSocket + `Runtime.evaluate`）驱动无头浏览器进真 harness，走三页下**计算样式**判据：① 首页 —— 插件 client 活着（105KB 主样式 + body 玻璃锚点 + `--we-*` 变量 + 拉绳）；② 会话页 —— 结构化消掉启动弹窗（单按钮 dialog / 跳过型白名单 + `--lang=zh-CN` 钉文案）→ 点「新建会话」→ `main.conversation`+`rightbar` **slot 锚点**挂出（第二页可达）；③ 设置页 —— `:has([data-slot="settings.section"])` 锚点 + **玻璃计算样式按渲染模式取期望**（正常态 = backdrop blur；软件渲染回退态 `data-we-glass-fallback=1` = 显式 none + 平板底 —— 回退是产品在无 GPU 环境的**正确行为**，上游 CI 首跑曾把正确回退判成红，判据已分模式并带 `?we-glassfallback=` 演练钮双态实测）+ 两条模式无关判据（独有 sheen 渐变两档 / `--dsw-alias-bg-layer-1` 被我们接管）+ 五分区逐页走查（每页 dialog 在 + 我们样式在 + 零插件错误）。**牙齿证明**：把锚点选择器改名重编译 ⇒ **恰好玻璃三条变红**（`backdrop=none` / `bg=none` / `layer1=#232324` = harness 原生默认，证明判据挂在「美化是否生效」上），还原后 18/18 绿。右栏 panel 由 harness 内部状态门控 ⇒ **在场才判**、缺席仅记信息（包级 + 页面级两条线已覆盖）。**验收判据**：脚本 / 棘轮表 / 工作流接线三处在册（见 `verify-ledger` 的 `P3-26` 三条证据） | ✅ |


| P3-27 | **本 fork 的硬化刀（10 个提交，已随"追版本"合并上游）**：① 剥注释统一到**字符串感知**实现（`test/tools/js-text.mjs`，16 处迁移）+ 规则 ⑦（禁朴素正则、白名单只许缩小）；② **store 写入契约两侧补齐** —— 瞬态字段经 `setTransient`（属主零裸写 ①d + 跨模块上界棘轮 ①e）、持久化字段必须与落盘配对（①g；并修掉"导入自定义画面在无 `sceneFrameUrl` 时不落盘"那处**真实漏洞**）；③ "改了 store 却不通知"钉到**处理器级**（①h）与**分支级**（①i，与 `test/tools/branch-notify.mjs` 同源），扫描面**派生**自 `INLINE_MODULES`（新模块自动进面）；④ 工具清单进 [`TEST-LAYOUT.md`](../TEST-LAYOUT.md) + 规则 ⑧；⑤ `harness-compat-baseline.mjs` 的**"追尾"修复**（按**内容身份** `plugin.revision` 判重 ⇒ 基线提交不再把插件 commit 推着走，与上游的"推送竞态"修法互补）。**验收判据**：见 `verify-ledger` 的 `P3-27` 五条证据 | ✅ |

> 它要动的东西**正好落在重构的接缝上**：设置模型（P1-5）、效果/样式应用层（P1-7）、面板结构（P2-10）、宿主文件通道（P2-9）。
> 设计与不变量已收口在 [`docs/FONT-SYSTEM.md`](../FONT-SYSTEM.md)（三个通道、9 条不变量、扩展步骤），本文不重复。

| # | 动作 | 状态 |
|---|---|---|
| F0 | `theme` 服务的真机确认（主路径成立 + 两处旧结论被推翻）→ 结论并入 §9.1 的 V1–V10；记录保留在 F0 清单 | ✅ |
| F1 | 颜色角色令牌层 `src/font/color-roles.js` + 设置 `themeColors` / `themeDarkSeparate`（首期只做颜色，5 个角色） | ✅ |
| F2 | 排版角色 `src/font/typography.js` + 设置 `themeType`（只追加偏移、不重写 DSH 表达式、不碰字重字族） | ✅ |
| F3 | **字体集文件化**（**已完成**，四项需求全部落地）：**随包预设** —— `lib/fontsets/` 随包发布、**两层存储**（同 id 用户层胜、写时复制：改发布物那份会自动存成用户层的一份））· **导入导出** —— 宿主响应头导出 + `/fontsets/import` 导入，客户端三道本地预检各给可判定文案 · **人工切换** —— `activate` 是唯一改指针的写原语（将来的条件自动切换是**策略层**、必须调它；**激活必须把那份值读回来采用、并把清单一起更新**（`loadFontSet` 同时承担这两件事 —— 少了清单那一句，新建/切换后界面会留着旧列表，要刷新才好） —— 只挪指针界面不会变）。**语义（真机反馈后定）**：字体集是「字体自定义」的**附属**（总开关关掉即整块收起）· 「使用中」= **值仍与采纳时一致**（手动改过 ⇒ 换标「已改」），`activeId`（指针）只做能力判定 · 「只看改过的」**默认开**且"恢复默认"不动它（视图状态不归重置管）。三条决策：D1 字体值退出 settings blob（`config.json` 只留 `{ fontSetId, fontCustom }`）· D2 导出走宿主响应头 · D3 写时复制。过程记录见 [`archive/audits/F3-PLAN.md`](../archive/audits/F3-PLAN.md)；机制与不变量在 `lib/routes/fontsets.js` / `src/fontset-store.js` / `src/fontset-editor.js` / `lib/settings-schema.js` 的文件头；判据在 `verify-fontset`（125 条）+ `fontset-load-smoke`。⚠️ 真机确认仍在根 `TODO`（字号/字重/字族是否分别生效等 Node 守卫覆盖不到的行为）| ✅ |
| G1 | 删掉 legacy「字体颜色」通路（四条 `!important` 折叠 + 全局墨色覆盖 + schema 键），改为写进 5 个角色 | ✅ |
| G2 | 面板显示 DSH **官方默认值**（单一真源在角色表；"初始值 = 官方值、清空即回官方"） | ✅ |
| G3 | 官方 `--dsl-*` 组件钩子通道，作用域 = **钩子在样式表里的定义点**（不按模块名） | ✅ |
| G4 | 组件字体通道 `src/font/components.js`：4 个组件，`id`（设置键，稳定）与 `prefix`（实测模块名）分离 + 启动自探测 + 泛模块名按 `route` 限定 | ✅ |

---

## 6. 静态帧线移除后的形态

已随 P2-12 执行完毕（可达性 0 / 0）。契约与仍在生效的裁定整体归档在
[`docs/archive/REFACTOR-ASSESSMENT.md`](../archive/REFACTOR-ASSESSMENT.md) §6。

---

## 7. 升级为「立即结构性重构」的触发条件

出现任一条，§1 的结论作废，改为立刻做结构性重构：

1. **单次改动的文件数持续 ≥5** —— 现在**均值 7.09**，已越过该线 ⇒ 因此 P1-5（设置键单一真源）优先于任何抽取。
2. **守卫因文本判据脆弱导致假失败明显增多** —— 改为结构性/行为断言。
3. **要正式支持第二平台或第二渲染后端** —— 届时 `src/client.js` 的隐式边界会成为硬阻塞。
4. **单次会话上下文已无法容纳读懂 `apply(ctx)` 或 `WallpaperPicker`** —— 当前已处于临界。
5. **出现一次无法定位原因的生产级回归** —— 说明守卫的覆盖结构已失效，先补覆盖再谈结构。
6. **宿主某个路由族长到 ≥3 条路由**，或**一次改动要同时动 ≥3 条共享可变状态的路由** ⇒ 按族单独拆（先做 §3.5 的三条前置）。
   判定：`node test/tools/analyze-host-apply.mjs` 的第 ② 组数。✅ **已对 `diag` 族成立**（4 条路由）⇒ P2-11 的第一刀就是这么做的；下一个满足它的是 `now-playing`（2 条，**未达线**）。
   该线的**机器判据**在 [`test/verify-ledger.mjs`](../../test/verify-ledger.mjs) 的 `P2-11` 证据①（`lib/index.js` 内路由按路径首段归组、最大组 `< 3`）：某族到 3 条即红 ⇒ 回来裁决（拆族 或 改本线），不靠人记得复评。
   ⚠️ 判定看的是**注册条数**，而"族"的另一种形态是**一个 `prefix` 注册下挂多个端点**（`scene-serve` 3 条 / `fontsets` 1 条注册 = 6 个端点）⇒ 新族**一律直接写成模块**，别先塞进 `apply` 等它"长到 3 条"。
7. **出现一次跨路由状态的"隔空故障"** ⇒ 说明 22 个共享可变闭包状态已从"读起来长"变成"真的会坏"，此时 P2-11 升级为**立即做**。
   （本线是**事件型**：出现一次才触发，机器判不了；能被机器看守的是第 6 条的"族到 ≥3 条"半边，见其判据入口。）
   ⚠️ 拆 `media` 族前先记住匹配语义（`exact` 与 `prefix` 是两张表，prefix 表**最长前缀胜出**且必须落在路径边界上）⇒ 族内与族间的相对注册顺序都不影响匹配。

---

## 9. 并行轨道 F（**只有 §9.1 的约束仍活着**）

> §9.5 数据与文件 / §9.6 红线 / §9.7 已执行的决定已随历史半边归档 ——
> [`docs/archive/REFACTOR-ASSESSMENT.md`](../archive/REFACTOR-ASSESSMENT.md) §9。
> §9.1 留在这里：`V1–V10` 是**实现必须继续满足**的约束，且 `verify-ledger` 的 `F0` 证据读它的首尾两行。
### 9.1 官方令牌层（F0 实测结论 —— **实现必须继续满足**）

官方扩展面是客户端 Cordis 服务 `theme`（入口 `ctx.get("theme")`，`overrideTokens(source, {令牌:{light,dark}})`）；
presenter 把快照写进 `body` 内联样式 ⇒ 内联胜过主题样式表 ⇒ 不需要 `!important`、不用 DOM 选择器、
不碰白闪路径；同 source 再调 = **替换**该层。**F0/F1 已关闭**，实现收口在 `src/font/`（三个纯计算文件 +
唯一碰 DOM 的 `apply.js`）；通道分工 / 9 条不变量 / 扩展步骤见 [`docs/FONT-SYSTEM.md`](../FONT-SYSTEM.md)。

**F0 真机实测结论**（`V1–V10` 是**约束**，不是编年史）：

| # | 结论 | 对实现的影响 |
|---|---|---|
| V1 | 入口**只能是 `ctx.get("theme")`**：`ctx.theme` 裸访问抛错 | **不改 `inject`**（加进去会在服务缺失时 park 整个插件） |
| V2 | `ctx.get` 是**启动竞态**（同实例实测 3ms 可用 / 7ms 不可用） | 必须**延迟 + 轮询**；同步取一次就定论 = 真机静默失效 |
| V3 | 写入**即刻走 `body` 内联** | 免 `!important`、免 DOM 选择器、不碰白闪路径 |
| V4 | `dispose()` **干净还原**（内联摘净，计算值回落样式表） | `fontCustom` 关 = **真·回到原生** |
| V5 | 一层注册**一次**即可**随配色自动换值** | **不要**监听配色变化重注册 |
| V6 | 快照里**没有令牌表**（`active.tokens` = 0）而样式表里 `--dsw-*` / `--dsh-content-*` = **377** 条 | 令牌清单与取值的权威来源是**样式表扫描 + `getComputedStyle`** |
| V7 | body 上 23 个内联自定义属性里 **0 个 `--dsw-*`** | 「令牌走内联」此前并未发生 ⇒ 我们是**唯一**往 body 写 `--dsw-*` 的层 |
| V8 | 裸字符串**抛错**；未知令牌**不抛也不生效**；同 source 再调 = **替换** | 必须自己按 **377 条白名单**校验令牌名 —— 写错不报错，只静默无效 |
| V9 | `client-diag` 的 `detail` 两端各截断 **300 字符** | "把令牌清单写进 live 诊断日志"需另开通道或只记紧凑摘要 |
| V10 | `--dsw-alias-label-*` 共 **10** 个角色；排版类令牌 **184** 条 | 首期只做颜色是对的；F2 面对的是 184 条排版令牌 |

> 原始证据（探针代码、两套配色的 377 条取值、逐条实测表）是**本地未跟踪**的
> 本机未跟踪的取证脚本目录（不入库）与 `~/.dsh-wallpaper-engine/diag/http.jsonl`；需要时按那份记录复跑。
