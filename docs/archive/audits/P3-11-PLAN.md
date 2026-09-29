# P3-11 计划：客户端最后一个巨石（`WallpaperPicker`）

> **状态：已收口（阶段 0b / 1 / 2 / 3 全部交付），本文只作过程记录，不复述结论。**
> 它是开工前后的**判断与顺序**（含那些被实测推翻的账本原话），不是现行实现的说明。
>
> **权威来源**：完成情况看账本 [`REFACTOR-ASSESSMENT.md`](../../wip/OPEN-ITEMS.md) §5 的
> `P3-11` 行（由 `test/verify-ledger.mjs` 机器核对）；行为与结构判据看守卫本身 ——
> `test/verify-picker-props.mjs`（属性面板：可达性 + 每个 ptype 的控件分支 + 标记等价 golden）、
> `test/verify-picker-model.mjs`（模型层 + 跨层对拍）、`test/verify-picker-upload.mjs`（上传区），
> 以及 `test/verify-client.mjs` 结尾那两段"搬出去的渲染器只经 ctx"的接缝判据。
>
> **本文里那两处 `⬜`**（首载期「扫描 Wallpaper Engine…」的截取渲染；`verify-ledger` 缺 `P3-11` 键）
> 的处理：后者已补（EVIDENCE 在册，见收口回填）；前者当时**没有**降级成打印，而是如实记成差额
> （见下方"阶段 3 交付"一段）—— **后续也已补**：挂载台给 `/inventory` 的**应答投递**加了闸门，
> 做"启动期截取渲染"，判据落在 `test/verify-client.mjs`（正/负对照 + 产物侧牙齿证明）。

> 账本 §5 的 `P3-11` 曾指向这里。本文件是当时的**工作底稿**：开工前的事实核对、先决断言清单、
> 拆分策略与顺序、验收与棘轮。做完后已归档到 `docs/archive/audits/`，结论回填了账本那一行。

## 1. 事实核对（先核账本的前提，再谈方案）

账本原描述与**实测**的差异（逐条可复算）：

| 账本原话 | 实测 | 依据 |
|---|---|---|
| `src/client.js` 2396–3446，1,051 行 | **2396–3428，1,033 行** | 3428 体闭合；3435–3441 是另一个函数 `WallpaperPickerSection`，被原区间误框进来 |
| "体内最大嵌套单元仅 6 行" | **不可复现**：最大花括号深度 **5**；直方图 `{1:365, 2:441, 3:161, 4:59, 5:6}`；最长 `depth≥4` 段 9 行；真正抬升一层的最长块是 `if (selection.rotationEnabled) {`（2502–2514，13 行），最长箭头体是 `onClearGpuFrame` 的 `.then`（2753–2788，36 行） | 借 `test/tools/host-route-index.mjs` 的 `stripSource` + `braceEnd` 口径复算；缩进口径不可用（体内 31 行缩进为 0） |
| 需换策略（拆子组件 / 状态机提模块） | **方向成立** | 真实形态是**宽而浅**：处理器区 2417–2891（**469 行 / 45%**，其中 **53 个 `on*` 回调**）+ 顶层 return 单条 281 行表达式（27%，零控制流）+ 365 行停在深度 1 |

三条对方案有决定性影响的实测结论：

1. **体内没有任何子组件** —— 101 处 `createElement` 全内联，体内唯一的大写具名函数就是 `WallpaperPicker` 自己。
   ⇒ "拆子组件"不是"把已有单元搬出去"，而是**从零新建一层**。
2. **六个页签渲染器早已搬走**（`src/panel-tabs.js`，24/485/800/848/894/1173 行，1,240 行，由
   `scripts/build-client.mjs` 内联）。留在 `client.js` 的是**模态框那一份网格**。
3. **接缝成本高**：出向 **84 个**跨边界名字（61 个来自 `client.js` 模块作用域 + 23 个来自 8 个内联模块）；
   props 只有一个 `repoPanel`，**没有任何回调经 props 传入** —— 全靠隐式模块作用域。
   CSS 契约是 **116 个 `.we-picker__*` 选择器**（`src/styles.js` 586–1603，**层级敏感**）。

## 2. 覆盖图：先补哪张网（实读，不猜）

守卫读的是**产物** `lib/client.js`（`test/verify-client.mjs:177`，另有 `DSH_MUT_LIB` 手工变异钩子）；
断言风格是 `node:assert` + 本地 `rotCheck(label, cond)`。

**已有的**：关闭卡、卡片可点/应用、内容分级筛选、页签标签、外观/吉祥物/过场文本与上限。

**零断言的区域**（就是"先补行为断言"的清单）：

- **分页器**：`verify-client.mjs:747–764` **整块是 `console.log`，没有任何断言**，且 `clickPager`
  （`:744`）把异常吞进 `console.log` ⇒ 这是**假覆盖**：在测试日志里长得像断言，实际不判真假。
  （同一处 `:286` 的注释显示"全是 `console.log`"这个问题被评审抓过一次并修了一部分 —— 这里是漏网。）
- 搜索框、类型筛选、**隐藏页全部**、批量模式与 `--checked` 高亮、卡片头计数、空/错误态（2926–2937）。
- **上传区全部**（含两个目录编辑器与移除）。
- **轮换列表编辑器全部**（新建/保存/删除组）。
- **模态框 ESC / 焦点陷阱 / 焦点归还**（`trapModalTab`、`modalInitialFocus` 零引用）。
- `renderUserPropRow` 的各控件分支。

## 3. 顺序与策略（混合 C）

**明确不搬**：处理器区（2417–2891 的 53 个 `on*`）。它们是 ctx 的**供给方**，搬它们等于把接缝从
2 条变成 60 条 —— 这正是 `P2-10` 抽出页签时保留在面板组件里的那一层。

### 阶段 0：先决行为断言（动手之前必须先有网）

**框定修正（实读之后）**：假覆盖不止分页器一处 —— 实测 `test/verify-client.mjs` 里有 **39 处
"log 形式的伪判据"**（`console.log('x (expect 1):', n === 1)`：在日志里像断言、实际不判真假），
而该文件真断言（`assert.*` + `rotCheck`）共 146 条 ⇒ **约 24% 的"判据"是伪的**。
所以阶段 0 分成两半，先做 (i) 再做 (ii)：

(i) **清零伪判据 + 落地棘轮 —— 已完成（棘轮 = 0）**。棘轮在 `verify-client.mjs` 末尾的"判据纪律"段：
断言 **必须为 0**；`catch` 里的错误上报不算判据；判据只认**以 `console.log(` 开头的语句**
（本段自己的负对照行以 `assert.equal(` 开头，其字符串字面量里正带着伪判据样本 —— 不收紧就会被
自己的对照绊倒，同 `TEST-LAYOUT` §约定 3）。**牙齿证明**：插入一条新伪判据 ⇒ 红并报出行号。
清零过程（39 → 0）：机械转换 35 处（布尔表达式 → `assert.ok`）+ 人工 11 处；人工那批里有三个坑：
① 本文件的 `assert` 是 **`node:assert/strict`** ⇒ `sliderMax()` 返回**字符串**，`assert.equal(x, 200)` 必红
（三条改成 `'200'`/`'90'`）；② 标签写着 `expect 6` 但表达式含 `||`，机械转换只给了"非零"的真值断言
⇒ 收成 `assert.equal(…, 6)`；③ 三处汇总行（"…: ok（N 例）"）本身不判真假 ⇒ 改成有内容的断言。

(ii) **给从未有判据的区域写新断言**（下表 1–12）。其中：
- **1 分页器** ✅（0a，11 条真断言 + 2 条负对照，牙齿证明见上）。
- **2 搜索 / 3 类型筛选 / 4 批量勾选 / 5 隐藏页 / 6 卡片头计数** ✅（本轮）—— 全部落在
  `verify-client.mjs`，判据抽成命名助手（`onlyMatching` / `checkOf` / `hiddenCountMatches` / `badgeOf`）
  供正负共用。牙齿证明：把搜索过滤置空 ⇒ 搜索批红；把隐藏动作改成不写 `hiddenIds` ⇒ 隐藏批红。
  过程中修掉了三处**判据自身**的问题（都不是产品缺陷）：
  ① `collectCards` 用**精确** className 匹配 ⇒ 勾选态（`we-picker__card--checked`）的卡片整批漏收
  —— 改成按 class **令牌**匹配（`we-picker__card-wrap` 这类近似名仍被排除）；
  ② 关闭卡也是 `we-picker__card`，"只剩匹配项"必须先把「✕ 关闭」摘掉；
  ③ 徽标是**全量**可播放数、网格是**当页** ⇒ 跨层对拍只在单页状态成立（搜索后那条就是它）。
  另：落盘是 200ms 去抖 ⇒ 读 `localStorage` 前必须放掉在途 persist（`rotationTimers` 里 `ms === 200`）。
- **9/10 上传与目录编辑器** ✅ —— 见下（新守卫）。
- **8 模态框键盘可达性**：
  - ✅ **Tab 陷阱**（4 条，共用命名判据 `tabTrap`）：末端 Tab ⇒ 拦下并绕回第一个；首个 Shift+Tab ⇒
    绕回最后一个；**中间 Tab ⇒ 不拦**（否则焦点锁死）；无可聚焦元素 ⇒ 不拦也不炸。牙齿证明：
    中和 `trapModalTab` ⇒ 第一条红。
  - ✅ **初始焦点**（2 条）：面板打开 picker 时置 `pickerFocusPending`，模态框关闭按钮的 `ref`
    消费它 ⇒ 焦点落在关闭按钮上；且**只消费一次**（第二次不得把焦点抢回来）。牙齿证明：去掉
    `src/panel-tabs.js` 里的置位 ⇒ 「初始焦点落在关闭按钮上」红（证明这个跨模块标志是承重的）。
  - 挂载台为此补了**真 DOM 焦点语义**：`document.activeElement`（getter）+ 元素 `focus()` / `blur()`。
    注意 `pickerFocusPending` 的置位点在 **`src/panel-tabs.js`**（页签抽出后挪过去了）——只 grep
    `src/client.js` 会误判成"死标志"。
  - ✅ **ESC**（本轮）：挂载台补了 `window` / `document` 的 `addEventListener` **监听表**（纯追加），
    并**临时**把 mock 的 `useEffect` 换成收集器 ⇒ 渲染一次拿到注册函数 ⇒ 立刻还原 ⇒ 跑收集到的
    effect（它们只做注册）⇒ 派发 keydown。断言：窗口上必须因此多一个 keydown 处理器；`Enter` 不关
    （负对照，与下一条共用同一条判据）；`Escape` ⇒ 模态框从渲染树里消失。牙齿证明（建立侧：不跑
    收集到的 effect）⇒ 「必须多一个 keydown 处理器」红。
    **故意没有**把 `useEffect` 永久改成"会跑" —— 那会同时打开这条 1,600 行守卫里所有注册监听的
    路径、牵动既有断言的时序，是另一件事（本项只需那一条路径可达）。
- **7 空 / 错误态**：✅ **错误态 + 「重试」恢复**（4 条）—— 挂载台加一个与 `cccClearUnlinkFails` 同款的
  **可变开关** `inventoryFails`，然后走**真实路径**：点页签「刷新」→ 库存 503 → 断言
  「未检测到 Wallpaper Engine：<原因>」+ 有「重试」按钮 + 整块面板被替换（不是叠在面板上）→ 开关放回
  成功 → 点「重试」→ 错误态消失且面板回来。牙齿证明（**建立侧**）：把失败分支短路 ⇒ 「显示错误」立即红
  （证明这条断言挂在真实失败路径上，而不是碰巧通过）；产品侧的变异（改 `client.js` 那段早退文案）
  待阶段 1 的子代理交付后补跑 —— 避免与它对同一文件的编辑互踩。
  ⬜ 仍缺**首载**那条 `!sel.loaded` 的「扫描 Wallpaper Engine…」：它只在库存 promise 落定**之前**可见，
  而挂载台的启动链是 await 过的 ⇒ 要另做一次"启动期截取渲染"。**（已补 —— 见文首横幅。）**
- **11 轮换列表编辑器** ✅（本轮）：选项文案 = 名称（可播放数 · 间隔分钟）；改间隔写进**活动**列表
  并落盘；删除列表 **confirm 门控** —— 先答 false（不删）再答 true（真删）；删光后选择回落为空、
  下拉显示「暂无轮播列表」。牙齿证明：去掉 `onDeleteGroup` 的 confirm ⇒ 「删除前必须先问一次」红。
  两个过程发现：
  ① **一条我自己的空转判据**：`deleteGroup` 只改内存（`splice`）**不落盘** ⇒ 拿 `localStorage` 比会
  得到恒真的结论（"取消"也"通过"）⇒ 判据必须读**渲染出的**状态（同 §约定 5 的同一类毛病）。
  ② 挂载台没有 `window.confirm`，但客户端写的是 `window.confirm(...)`（**属性访问**）⇒ 测试里给沙箱
  `window` 挂一个**可切换答案**的实现即可，**无需改挂载台**；顺带解锁批量隐藏与「全部恢复」两条门控路径。
  仍缺：无（本轮补齐）—— **新建 / 保存**（编辑页：名称 / 间隔 / 顺序 / 候选卡 / 「保存」）与
  **切换活动列表**（夹具只有一个列表 ⇒ 先再造一个，再切回去）都已断言。
- **`isUploadedWallpaper` 与 `isDirWallpaper` 的重叠语义**（搬迁时才发现，值得记）：
  `'up-dir-2'.indexOf('up-') === 0` ⇒ **目录项目也算"上传"**；排除它们靠的是
  `isUploadedWallpaper(w) && !isDirWallpaper(w)` 这个**合取**。所以：
  ① 该表达式**必须留在 `client.js`**（`verify-scene-live` 对它做源码文本匹配，搬走会静默搞红）；
  ② 任何"负对照"若只断言 `!isUploadedWallpaper(dirItem)` 都是**错的**（它会返回 true）。
- **阶段 1 完成**（✅）：模型落 `src/picker-model.js`（170 行含契约头，行首声明、顶层零可执行语句）；
  守卫 `test/verify-picker-model.mjs`（**99 条 = 51 正 + 48 负对照**），模型段是**从产物 `lib/client.js`
  里切出来的内联段**再求值（判的是入库产物，不是 src 副本）。跨层对拍两个状态（未过滤第 1 页 24/24、
  搜索单页 1/1），并配**绝对锚点**（24 张 / 2 页）与"分页器文案与模型同源"〔33,1,2〕防"空对空"。
  **牙齿证明（产品侧）**：① 改产物 `PICKER_PAGE_SIZE 24→25` ⇒ 9 条红，而**跨层那条仍绿**（两侧共用
  同一常量 ⇒ 这正是绝对锚点存在的理由）；② 把接缝处 `search: sel.search` 改成 `search: ""` ⇒
  跨层红（**模型 1 / 渲染 24**）。登记四处齐全（INLINE_MODULES / CEIL×2 / verify 链 25→26 / 产物重建）。
- **批量隐藏 + 隐藏页「全部恢复」** ✅（顺手补上，不在原计划表里但属同两个区域）：`confirm=false`
  ⇒ 不隐藏**且仍留在批量模式**（选择没被清掉）；`confirm=true` ⇒ 退出网格、自动退批量、隐藏页计数 +1；
  「全部恢复」⇒ 计数回到零基且那张壁纸回到网格。牙齿证明（**建立侧**：把 confirm 模拟强制成 true）
  ⇒ 首条红的是**轮换列表**的「取消就是取消」（同类判据、同一机制；批量那条因 `assert` 首错即停
  未单独观察到）。产品侧的变异待阶段 1 子代理交付后补跑。

**本轮新记的挂载台缺口**（与 `pauseOnBlur` 同类，都是"判据不可达"）：
- `window.confirm` **没有模拟** ⇒ 批量隐藏（3289–3302）与「全部恢复」（3236）两条路当前跑不到；
- 单张恢复**有**独立按钮（隐藏卡里的"恢复"，与普通视图的"隐藏"**同类名** `we-picker__card-hide`，
  靠 `title` 区分）⇒ 无需 confirm 即可测，已用它做起止状态还原。
- 顺手发现一处**文案与行为不符**（非本轮范围）：隐藏卡的 `aria-label` 写着"恢复并应用"，但它的
  `onClick` 只是 `applySelection(w.id)` —— **不会**解除隐藏（真正的恢复是卡内那个按钮）。

0a 已完成：`verify-client.mjs:747–764` 的分页器整块（18 行纯 `console.log`）已换成
**11 条真断言 + 2 条负对照**，并做了牙齿证明（改产品 `PAGE_SIZE` 24→25 ⇒ 断言红；
改前这种变异只会多打一行日志、`exit 0`）。
0b. 补下面 12 条先决断言（每条都要配负对照；负对照的形态规则见 `docs/TEST-LAYOUT.md` §约定 5）：
| # | 断言（可判真假） | 落点 |
|---|---|---|
| 1 | 33 张可播 ⇒ 第 1 页 `25` 张卡（关闭卡 + 24），第 2 页 `10` 张 | `verify-client.mjs` |
| 2 | 搜索 `Wall 3` 后 `page` 归 0，且结果集只剩匹配项 | 同上 |
| 3 | 类型筛选"场景" ⇒ 网格里只剩场景卡 | 同上 |
| 4 | 批量勾选数 == `batchSelected.length`；隐藏后归零 | 同上 |
| 5 | 隐藏 1 张 ⇒ "已隐藏(N)" 减 1；"全部恢复" ⇒ 0 | 同上 |
| 6 | 卡片头计数文本 == 可播放数 | 同上 |
| 7 | `inventory.error` / `loaded === false` 两条早退文案 | 同上 |
| 8 | 打开后 `activeElement` 是"关闭"；Escape 关模态且 `stopPropagation` | 同上 |
| 9 | 上传：File 选中 → 上传中 → "已上传 N 个"；失败显 `uploadError` | **新** `test/verify-picker-upload.mjs` |
| 10 | 目录编辑器保存 ⇒ 触发**一次** `/inventory` 重拉；失败显 `weAssetsError` | `verify-picker-upload.mjs` |
| 11 | 新建/保存/删除组改变 `rotationGroups`；`confirm === false` 时**不**删 | `verify-client.mjs` |
| 12 | 棘轮三件套：新文件进 `INLINE_MODULES`（why + markers）+ 进 `verify-comment-discipline.mjs` 的 CEIL（基线 0）+ `test/tools/` 的根退**两层** | 结构守卫 |

### 阶段 1：B —— 状态机提纯（先做，风险最低）

新 `src/picker-model.js`（≈190 行）：派生数据 + 分页，**必须连带搬走过滤判定**
（`ratingOf` 448 / `isPlayableType` 475 / `isRotatableWallpaper` 485 / `isHiddenWallpaper` 1079 /
`isUploadedWallpaper` 1116 / `isDirWallpaper` 1124）—— 它们与派生数据是同一套语义，分开搬会留下两处真源。

- **契约**（照 `src/panel-tabs.js` 的既有样子）：纯函数 + 显式入参；**零 `selection` 引用、零 DOM、零 emit**；
  浏览器安全（无 import/require/Node API）；**顶层无可执行语句**（内联到 bundle 顶部会撞 TDZ）。
- **验收/棘轮**：新 `test/verify-picker-model.mjs`（用例表 + 负对照 + **跨层对拍**：
  "模型算出的卡片数 == 渲染出的 `.we-picker__card` 数"）。
  跨层对拍就是 `P2-11` 那条"结构等价断言"的手法，它保证提纯不是自证。

### 阶段 2：A —— 只搬模态框

新 `src/picker-modal.js`（≈470 行）。风险最高的一项 —— 风险已**量化**：

- `src/styles.js` 里 `.we-picker__*` 选择器共 **256 次 / 116 个不同类名**（与盘点数字对上）；
  其中模态框骨架族 **19 个**（`modal`/`modal-head`/`modal-body`/`modal-tabs`/`modal-overlay`/
  `modal--panel`/`grid`/`pager`/`batch-bar`/`filter-row`/`search`/`empty*`/`error`/`card-head`/
  `section-head`…）、卡片族 **15 个**；
- **含层级/相邻组合的选择器 26 条**（`.we-picker__X … .we-picker__Y` 形式）⇒ 这才是"改一层嵌套就静默漂"的真身。
- **事实更正**：`test/e2e-web-media-origin.mjs` 里那份**手抄 markup 镜像**覆盖的是**面板的
  "当前壁纸"区块**（`we-picker__section` / `__current*` / `__btn--props` / `__btn--primary`），
  **不是模态框** ⇒ 阶段 2 不触碰它（此前"镜像要同步"的说法不准确）。
- 交付要证明"逐字未变"：以 `we-picker__modal` 为根 DFS，把每个元素的 class 令牌按「深度:令牌」
  摊平成序列，与**搬迁前**录下的 golden 逐项相等；三个状态各一份（普通 160 / 批量 142 / 隐藏页 30
  个令牌），并配 3 条负对照（删一个类名 / 插一个类名 / **只挪一层**）与绝对锚点（160 令牌 + 卡片数 ≥25）。
- **判据自身也会烂**（实录）：golden 生成器给每行补了行尾空格再 `join(' ')` ⇒ token 间出现双空格 ⇒
  `split(' ')` 产出空令牌，判据当场判假；修生成器后绿。复核判据是否真在执行，用的是"把锚点 160 改 161
  ⇒ 立即红"的可达性探针。

### 阶段 3：属性面板

新 `src/picker-props-panel.js`（≈180 行）。最后做，因为它的 ctx 形状取决于阶段 2 定下来的那份。

**边界已探明（阶段 2 期间只读核对）**：`renderUserPropRow(p)` @2934、`renderUserPropsPanel()` @3008；
它用到的 13 个类名（`we-picker__props-{section,row,head,title,label,dot,check,color,select,text,value,hint,note}`）
在 `client.js` 里共出现 14 次 —— 搬迁后这些字符串应整批挪进新文件，而**类名多重集不变**（同阶段 2 的核对口径）。
`selection.userProps` 的读写助手住在 1637–1750（属**处理器层**）⇒ 按契约**不搬**，只把值与回调经 ctx 传进去。

**⚠️ 先决条件未满足：属性面板在现有挂载台里渲染不出来**（阶段 2 期间实测）——
`test/verify-client.mjs` 对 `userProps` / `propsUrl` / `propsState` **零引用** ⇒ "标记等价判据"没有可渲染的对象。
渲染闸门在 `src/client.js:3008–3030`，三道缺一不可：

1. **`propsPanelOpen === true`** —— 模块级 `let`（约 `client.js:1700`），由面板里的
   `we-picker__btn--props`（「壁纸属性」）按钮切换；
2. **`propTokenOf(sel)` 有 token** —— 选中的壁纸要带 `propsUrl`（网页壁纸那条路）；
3. **`propsState.props` 已加载** —— 首次会走 `loadUserPropDefs(token, true)`（异步）⇒ 挂载台的
   `fetch` 模拟要能为该 URL 应答属性定义数组（`{ name, ptype, value, … }`；`ptype` 决定渲染出
   `we-picker__props-{check,color,select,text}` 里的哪一个）。

**因此阶段 3 的正确起手是"先做可达性"**：① 夹具加一个带 `propsUrl` 的网页壁纸 + `fetch` 分支；
② 先断言"面板确实渲染出来了"（`we-picker__props-head` 存在、行数 > 0）作为**防空跑锚点**；
③ 再从**搬迁前**的当前产物录 golden（DFS +「深度:令牌」+ 负对照（含"只挪一层"）+ 字面量绝对锚点）；
④ 最后才搬 `src/picker-props-panel.js` 并登记三处。若这三道闸门在挂载台里做不出来，**如实报告差什么**，
不要把判据写弱、更不要把 `console.log` 当判据。

**阶段 3 交付（收口回填，2026-09 快照）**：

- 起手按上面这条走：**另建** `test/verify-picker-props.mjs`（734 行 / 61 条 = 44 正 + 17 负对照），
  自带一套更小的挂载台（同 `verify-picker-upload.mjs` 的做法）—— 夹具给一张带 `propsUrl` 的**网页壁纸**、
  给 `/props/<token>` 一条**可控**应答（在途 / 成功 / 非 2xx / 2xx 但体说 not-ok 四态），三道渲染闸门因此都可达。
  在 `verify-client.mjs` 那套夹具上动刀（加带 `propsUrl` 的壁纸会顶掉"33 张 / 2 页 / 160 令牌"这组
  绝对锚点）反而会把阶段 2 的 golden 变成"照现状重录"，得不偿失。
- 模块落 `src/picker-props-panel.js`（144 行含契约头；`client.js` 只留一层组装适配，净少 94 行）；
  golden 是**搬迁前**从入库产物录的（27 个 class 令牌，按节点分组），搬迁后原样通过 ⇒ 标记逐字未变。
- **牙齿证明**（产品侧，`DSH_MUT_LIB` 变异产物，不碰 `src/`）：① 多加一个类名 ⇒ golden + 绝对锚点红；
  ② **只把提示行挪一层**（外面套一个无类名的 `div`，长度不变）⇒ **只有 golden 红** —— 这正是第 2 节
  点名的"改一层嵌套就静默漂"；③ 让属性定义永不重拉 ⇒ 「真的发出一次 `/props` 请求」红（可达性判据挂在
  真实路径上）；④ 把失败文案短路 ⇒ 两条失败腿判据红（面板会改口说"这张壁纸没有用户属性" —— 正是要拦的
  那种"静默说谎"）；⑤ 在模块里写一句 `selection.id` ⇒ `verify-client` 的接缝判据报出 1 处越界。
- **如实报告的差额（没有做成的判据，一条都没降级成打印）**：只剩 `!sel.loaded` 那条
  「扫描 Wallpaper Engine…」首载态（同阶段 0b 记的那条：它只在库存 promise 落定**之前**可见，
  而挂载台的启动链是 await 过的 ⇒ 要另做一次"启动期截取渲染"）。属性面板这一侧的
  `propsState` 四种应答态都已覆盖。
  **（收口后的补记：这条差额已补 —— 见文首横幅。）**

## 4. 顺带记下的两处小账（不属本项，别夹带）

- `selection.hiddenOpen`（`src/client.js:223`）**无任何读者** ⇒ 死字段候选（动它要连带看设置 schema / golden 夹具）。
- `we-picker__chip`：JS 里有、CSS 里没有的**孤儿类名**。

## 5. 与本项一起要补的账本维护

`test/verify-ledger.mjs` 的 EVIDENCE 表**没有 `P3-11` 键** ⇒ 这条的 `⬜` 目前**不是机器可核的**；
关它的时候要一并补 EVIDENCE 条目（否则"已完成"只是散文）。

> **已补（收口回填）**：`P3-11` 键现在在册（5 条判据：三个模块都在 `INLINE_MODULES`、
> 属性面板渲染器真的搬走、守卫在册且入链、接缝判据覆盖属性面板、计划文件已归档）。
> 账本自检因此从"17 条已完成 / 2 条未完成"变成"18 / 1"（剩下的那条是 P2-11：未过触发线）。
