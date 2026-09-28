# F3 计划：字体集文件化（`fontsets/<id>.json`）

> **状态：草案 —— 未开工。** 本文只回答三件事：开工前的事实核对、先决断言清单、按什么顺序改与每步怎么算改完。
> **它与 P3-11-PLAN 同形**（那也是先有工作底稿、做完再归档）：**结论不复述，判据不降级**——
> 做不出来的判据如实记成差额，不许变成 `console.log`。
>
> **权威来源**：设计要点在账本 §9.5 与 §9.6（红线）；三个通道与 9 条不变量在
> [`docs/FONT-SYSTEM.md`](../FONT-SYSTEM.md)；进度真源是账本 §5 的 `F3` 行。
> **本文件是 `docs/wip/` 里的进行中过程记录**，收口后按 P3-11 的先例移入 `docs/archive/` 并把结论回填账本。
>
> **两条待拍板决策写在 §3 阶段 0**（字体值的真源归属 / 导出通道选型）——它们决定后面所有阶段的形状，
> 不先定就别动手。

## 1. 事实核对（先核账本的前提，再谈方案）

账本 §9.5 与 F3 行写下的前提，逐条对照**实测**：

| 账本原话 | 实测 | 依据 |
|---|---|---|
| "导入导出复用 `/upload` + 数据目录 + 文件选择器的现有基建" | **只有一半成立**：**导入**有两处真实先例；**导出在 `src/` 里零命中**（`createObjectURL` / `showSaveFilePicker` / `.download=` / `new Blob` / `saveAs(` 全零）⇒ 导出要么新开宿主通道，要么引入客户端此前不用的 blob API | 导入先例：`src/panel-tabs.js:438-451`（可见 `input.we-picker__file` → `uploadWallpaperFile`）、`:1058-1064`（隐藏 input + `.click()` → `onCustomFrameFile`）；处理点 `src/client.js:1065-1128` / `:2772-2794` |
| "宿主白名单漏键会**静默丢弃**（= R4）" | **成立且已定位**：宿主与客户端都只按 `KINDS` 的键集取值/序列化 ⇒ **不在 `KINDS` 里的键在两端都被无声丢掉**，不报错、不进日志 | `sanitizeFromSchema` `lib/settings-schema.js:536-548`（遍历 `KINDS`）；`serializeSettings` `:551-559`；宿主调用点 `lib/index.js:3438`（PUT 白名单化） |
| "带 `$schema` 版本，加载时按版本迁移" | **全仓无先例**：没有任何 schemaVersion / 迁移函数；`config.json` 也没有"老键 → 新键"的迁移先例 | 相近先例只有"双形态读取"（`metaEntry` `lib/index.js:2016-2031`）与"一次性搬运"（localStorage→宿主 `src/persistence.js:158-167`）；版本号先例是 `LIVE_FRAME_KEY_VERSION`（`lib/index.js:1642`，**不匹配即弃**）与 `PROTOCOL_VERSION`（`lib/media/supervisor.js:22`，不匹配回落而非迁移） |
| "F3 依赖 P2-9 + P2-10" | **已兑现**（两者均 ✅）⇒ 顺序不再是约束 | 账本 §5 P2-9 / P2-10 |
| "localStorage 只有 5MB；滑杆每次回调同步写 settings 太重" | 成立（`SETTINGS_MAX_BYTES` 上限在 `lib/index.js:3395`；写路径是 PUT 全量 JSON 体 `src/persistence.js:75-89`） | — |

三条对方案有决定性影响的实测：

1. **字体键现在是 6 个持久化键 + 2 个视图开关**：`themeColors` / `themeDarkSeparate` / `themeSize` /
   `themeWeight` / `themeFamily` / `componentFonts` 在 `KINDS` 里（`lib/settings-schema.js:313-329`，DEFAULTS 在 `:226-235`）；
   `fontAdvanced` / `themeTypeOnly` 只在 `DEFAULTS_ONLY`（`:243`）⇒ **不持久化**。总开关 `fontCustom` 在 `:204` / `:313`。
2. **"字体键真的能经 `/settings` 往返"这件事今天零断言**：`verify-theme-layer` 只断 schema 里键还在
   （`test/verify-theme-layer.mjs:395-398`），`verify-component-fonts` **完全不触持久化**（只到纯函数层）。
   最接近的一条是 `verify-client.mjs:1594-1607` 的 P1-5 前快照 golden —— 那是"逐键一致"，不是"往返"。
   ⇒ **阶段 0 的第一张网就在这里**。
3. **数据目录有个现成的坑**：`pluginDataDir()`（`lib/index.js:557-560`）认 `DSH_WE_DATA_DIR`（测试靠它隔离，
   `test/verify-scene-live.mjs:45` / `test/verify-route-index.mjs:137`），但 `customFrameDir()`（`:1872`）与
   `DEFAULT_UPLOAD_DIR`（`:1538`）**直接用了 `homedir()`** ⇒ 不跟随覆写。`fontsets/` 必须走前者，否则守卫
   会在真机上写用户的真目录。

## 2. 覆盖图：先补哪张网（实读，不猜）

**已有的网**（都与字体有关，但都在"取值/生成"侧，不在"存到哪"侧）：令牌载荷与白名单
（`verify-theme-layer.mjs:72-142` / `241-374` / `413-417`）、组件选择器与定义点扫描
（`verify-component-fonts.mjs:65-77` / `228-289` / `308-323`）、schema 一致性（`:331-350`）、
"模块在位 + 已内联 + 正文没有"三件套（`:360-376`）。

**零覆盖（就是阶段 0 的清单）**：

- **字体键的持久化往返**：经 `PUT /settings` 写进 `config.json` 再读回 ⇒ 今天没有任何判据。
- **"不在 `KINDS` 的键会被静默丢弃"**：这条机制没有任何断言 —— 而它正是 `fontSetId` 的护栏，
  也是本项最可能"改完看起来对、实际什么都没存"的地方。
- **迁移等价**：老 `config.json`（6 个键内联）→ 默认字体集，渲染结果必须逐字不变。
- **`fontsets/` 的路径安全**：id 白名单与目录包含性（先例是 `resolveUploadFile` `lib/index.js:2128-2148`
  与自定义画面 id 白名单 `lib/routes/scene-frame.js:228`），**新代码没有网**。
- **导入导出的往返**：导出字节 → 导入读回（今天导出根本不存在）。

## 3. 顺序与策略

**明确不做**（都是本仓踩过的形状）：

- **不把字体集塞进 settings blob**：那会在 `config.json` 与 `fontsets/<id>.json` 之间造出**两个真源**，
  滑块一拖必有一份是旧的 —— 这正是 P1-5/P1-6 花两刀消掉的那类病。
- **不引入第二个共享内核**：字体集的键集与消毒规则**复用它**（见阶段 1），所以
  `verify-module-layout` ③ 的"共享内核白名单恰好 1 条"不动。
- **不引入 blob 下载**：导出走宿主响应头（见阶段 0 决策），客户端不新增 DOM 面，守卫不必为此加 mock。
- **不做"按未知版本猜"的静默兼容**：读不懂的版本要**拒绝并说明**，不许静默降级成"看起来正常"。

### 阶段 0：先决断言 + 两条决策（动手之前必须先有网）

(i) **补持久化往返的网**（落在 `test/verify-theme-layer.mjs` 或 `verify-client.mjs` 的既有夹具上）：
6 个字体键 → `serializeSettings` → 宿主 `sanitizeSettings` → `config.json` → 读回 ⇒ 逐键相等；
并配**两条负对照**：① 手工删掉 `KINDS` 里某个字体键 ⇒ 该键在往返后消失（钉住"静默丢弃"这条路，
它同时是 `fontSetId` 的护栏）；② 合法往返必须成功（否则①是恒真的空转）。

(ii) **录"当前外观"golden**：从**迁移前**的产物录一份渲染取值（令牌载荷 + 排版/组件取值），
迁移后必须逐字相同。形态照 P3-11 阶段 2 的做法：DFS + 稳定序列 + 绝对锚点 + 负对照
（含"只挪一层"）；**判据自身也要有可达性探针**（把绝对锚点改一位 ⇒ 必须立刻红）。

(iii) **两条决策**（写进本文档的回填处，再动手）：

- **D1 字体值的真源归属**。推荐按 §9.5 的**字面**执行：`config.json` 只留 `{ fontSetId, fontCustom }`，
  6 个字体键**退出 `KINDS`**，活动集的 6 个值由 `fontsets/<id>.json` 提供，`selection` 只做**运行期**载体。
  代价与必须一并处理的后果（不许留暗坑）：① 老 `config.json` 的内联值要**一次性迁移**成默认集，
  迁移判据就是 (ii) 的 golden；② 宿主不可达时的回落路径要重新定义（`localStorage` 缓存
  `serializeSettings` 只挑 `KINDS` 键 ⇒ 字体值会一起消失）—— 推荐把"活动集正文"另存一个**独立缓存键**，
  而不是让它混进设置 blob；③ `test/fixtures/settings-sanitize-golden.json` 与
  `verify-client.mjs:1594-1607` 会随之改（这是**同交**项，不是顺手改）。
  *备选*：字体集只当"命名快照库"，真源仍在 settings。**不推荐** —— 拖一次滑块就让"集"与"实际外观"分叉，
  而分叉后"切换集"的语义无解（用户到底想扔掉还是保留这次微调？）。
- **D2 导出通道**。推荐 `GET /fontsets/<id>/export` 带 `Content-Disposition: attachment`，
  客户端只放一个普通链接/导航（**复用宿主文件通道，不碰 blob**）。备选是客户端 `Blob` + `createObjectURL`
  —— 那要给两个挂载台新增 mock 面，且是本仓第一次引入该 API。

### 阶段 1：共享内核 + 宿主通道（先做宿主侧，风险最低且判据最硬）

- **键集与消毒复用既有共享内核**：`lib/settings-schema.js` 增 `FONTSET_KEYS`（= 那 6 个键）与
  `sanitizeFontset(raw)`（复用 `readOne` 的逐 kind 分支，`lib/settings-schema.js:496-521`）+
  `FONTSET_SCHEMA_VERSION`。**不新建 `lib/**` 共享模块** ⇒ 白名单不动。
- **新 `lib/routes/fontsets.js`**（`registerFontsetsRoutes(webServer, c)`）：list / get / put / delete /
  import / export。**必须第一天就是族模块**：账本 §7-6 的触发线是"族 ≥3 条路由即拆"，6 条路由
  要是先写进 `lib/index.js`，就是一边还 P2-11 的账、一边亲手记新债。
  id 白名单（参照 `^[A-Za-z0-9_-]{1,64}$`，`lib/routes/scene-frame.js:228`）+ 目录包含性
  （参照 `resolveUploadFile`，`lib/index.js:2142-2143`）；目录走 `pluginDataDir()`（见 §1 第 3 条）。
- **写 config.json 只经既有串行化**：`enqueueConfigWrite`（`lib/index.js:637-643`）的三个消费者
  已有先例（`writeSettings` `:651-658`）⇒ fontset 的 `fontSetId` 写入**必须**走同一条队列，不许自己 `writeFileSync`。
- **一次性迁移**：读到"老形状"（6 个键内联、无 `fontSetId`）⇒ 生成一份默认集并写回 id，
  再按 D1 决定是否从 `config.json` 摘掉那 6 个键。

**验收/棘轮**：① 往返逐键相等；② 路径穿越负对照**逐条**（`../x` / `..\\x` / 绝对路径 / 含 `:` / 超长 id
⇒ 拒绝且**不落盘**）+ "合法 id 必须成功"（否则判据恒真）；③ 迁移等价（= 阶段 0 (ii) 的 golden）；
④ `docs/ROUTE-INDEX.md` 重生成（`node test/tools/host-route-index.mjs --write`）+ `verify-route-index` 绿。

### 阶段 2：客户端消费（`fontSetId` 进 schema 是**承重**的一步）

- `fontSetId` 进 `KINDS`（否则两端静默丢弃 —— 由阶段 0 的负对照①钉住：把它删掉必须有一条判据变红）。
- 启动链：`loadPersisted()` 落定后载入活动集正文 → 灌进 `selection` → `applyEffects()`。
  **载入失败不许半套用**：要么整套生效、要么整套保留现状并显式报错（原子性）。
- 编辑落盘：拖动滑块时写**活动集文件**（复用 `persistence.js` 的 debounce + 脏标记 + 重试形状，
  或另立一条同形状的通道 —— 二选一写进契约头，不许两条并存）。
- **不变量必须继续成立**："空配置 = 不生成任何规则"（`verify-component-fonts.mjs:120-133`）、
  "未知令牌静默忽略 ⇒ 必须白名单校验"（`THEME_COLOR_ROLES[].tokens` `src/font/color-roles.js:36-42`
  与 `readThemeColors` `lib/settings-schema.js:340-352`）—— 字体集是**配置搬运**，不新增通道。

### 阶段 3：编辑器面板

- 落点：`renderAppearanceTab`（`src/panel-tabs.js:485-723`）里"全局字体"区（`:519-722`）之下，
  沿用**已有的子分支形态**（"高级字体设置" `:648-715`：一行总开关 + 条件渲染）。
- 功能：新建 / 另存为 / 重命名 / 删除 / 切换活动集；删除要 **confirm 门控**（先答 false 再答 true，
  与轮换列表同形，`src/client.js:1006-1014`）；"当前默认值 = DSH 官方值"继续走既有三路来源
  （颜色快照 `src/font/apply.js:127-142`、排版 `src/font/typography.js:77-91`、组件 `componentFontDefaults()` `:98-100`）。
- 面板是**同一组件的两份挂载**（设置页 `settings.section` 与拉绳抽屉 `RopeDock`）⇒ 判据要在两处都成立，
  或明确只挂一处并说明理由。

### 阶段 4：导入导出

- 导入：复用既有文件选择器形态（`we-picker__file`），POST 到 `fontsets/import`；扩展名/MIME 白名单
  **跨半边同交** `test/verify-contracts.mjs:130-148`（上传 MIME 一致性的既有判据群）。
- 导出：按 D2 走宿主响应头；判据是**往返**（导出的字节能导入读回同一份，不比对时间戳这类不稳定字段）。
- 失败态：可判定文案（不是"什么都没发生"）—— 形态照 picker 的错误态 + 「重试」写法。

### 每阶段的三交（缺一不算完成）

| 交什么 | 本项的具体落点 |
|---|---|
| ① 结构 | 新文件进 `INLINE_MODULES`（`scripts/build-client.mjs:46-153` 的 `file` + `why` + `markers` 三件套）；新路由族进 `docs/ROUTE-INDEX.md`（重生成，不可手改） |
| ② 规则 | 契约写在**文件头**（需要的外界 / 对外提供什么 / 不变量）；注释纪律的 CEIL 表（`test/verify-comment-discipline.mjs:205-296`，真实键形状如 `'src/font/apply.js': 0,`）按新文件补键 |
| ③ 守卫 | 新判据挂进 `npm run verify`（`package.json:74`）；正/负对照成对；**并同交账本 §2 的"构建期内联模块 N 个"**（`verify-ledger.mjs:255-300` 会拿它与实测比对，不同交必红） |

**关项时的账本维护**：`verify-ledger.mjs` 的 `EVIDENCE` **现在没有 `F3` 键** ⇒ 不补，"已完成"只是散文
（P3-11 踩过同一课：修前那条 `⬜` 不是机器可核的）。补键 + 账本 §5 翻 ✅ + 本文档移入 `docs/archive/`。

## 4. 顺带记下的小账（不属本项，别夹带）

- [`docs/MODULE-LAYOUT.md:128`](../MODULE-LAYOUT.md) 的散文写着"其余 **13** 个内联模块都是 `src/`"，
  而实测是 **16**（`INLINE_MODULES` 共 17 条 = 16 个 `src/` + 1 个共享 `lib/settings-schema.js`，
  与账本 §2 的 17 一致）⇒ **常青文档里一处无人钉住的过期数字**。本项**不动它**（另一把刀），
  但阶段 1 会碰 `INLINE_MODULES`，届时别把它一起改进来。

## 5. 开工前的自检（照本次核账的教训）

- 账本 §9.5 那句"导入导出复用现有基建"已被实测**改掉一半** ⇒ 计划里凡引用账本原话处，
  都要像 §1 那样给 `file:line` 复算依据，**不转抄**。
- 本项最大的"看起来对"风险是 **D1 选错**（两个真源）与 **`fontSetId` 没进 `KINDS`**（静默丢弃）
  —— 这两条各自都要有一条**会失败的**判据，而不是"连跑几次都绿"。
