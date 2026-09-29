# src/font/ —— 字体系统（F / G 轨道）

这个目录是**字体系统的全部实现**。之所以单独成目录：字体有三个**互不相同的作用通道**，
如果不放在一起，改动时很容易用错通道（症状是"改了没反应"，且在真机上才看得出来）。

**目录里的四个文件分两类**：前三个是**纯计算**（角色表 / 令牌 / 钩子生成，不碰 DOM），
`apply.js` 是**唯一碰 DOM 的那个**（宿主默认值快照 + 组件作用域样式表）。效果应用层
（`src/effects.js`）只调用它的入口，不再夹带任何字体实现。

> 设计文档在 [`docs/wip/REFACTOR-ASSESSMENT.md`](./wip/REFACTOR-ASSESSMENT.md) §9（F 轨道设计要点）；
> 真机确认记录在 [`docs/archive/audits/F0-THEME-SERVICE-CHECKLIST.md`](./archive/audits/F0-THEME-SERVICE-CHECKLIST.md)。

## 三个通道（用哪个，取决于"字体从哪来"）

| 通道 | 里的文件 | 覆盖对象 | 机制 | 守卫 |
|---|---|---|---|---|
| ① **角色令牌** | `color-roles.js`、`typography.js` | DSH 的**角色**（正文/次要/弱化/极小/禁用；标题 1–4/正文/小字/代码/表格…） | DSH `theme` 服务的 `overrideTokens`（body 内联，**免 `!important`**） | `test/verify-theme-layer.mjs` |
| ② **官方组件钩子** | `components.js`（`DSL_FONT_HOOKS`） | 代码块 / 终端 | 官方 `--dsl-*` 钩子，**作用域 = 该钩子在样式表里的定义点**（`scanHookScopes` 推导，不靠模块名） | `test/verify-component-fonts.mjs` |
| ③ **模块名直接命中** | `components.js` | 首期 4 个组件（markdown / codeBlock / terminal / table） | `body [class*="_<模块名>_"]` 直接命中（**等特异性**，不用 `!important`） | 同上 |

> ①②③ 的结果都由 `apply.js` 落到 DOM（①走 DSH 服务的令牌层，②③ 拼成 `#we-font-scope` 的 CSS）。
>
> ⚠️ **③ 的模块名必须是实测值**（在 `@deepseek-ai/dsh-client-ui-primitives` 的 `*.module.css`
> 里核对，出处登记在每个目标的 `source` 字段上、守卫强制非空并在本机装了 DSH 时**逐个打开核对**），
> 不许按"组件叫什么"猜 —— 本仓踩过：`codeBlock` / `table` / `sidebar` 三个猜出来的名字在 DSH 里
> **一个都不存在**，那 3 行曾是"看得见、填了没用"。
> 每个目标的 `id`（= 设置键，稳定）与 `prefix`（= 实测模块名，会随 DSH 变）因此是**两件事**。
>
> ⚠️ **② 反过来不用模块名**：代码块与终端的模块名**都是 `.block`**（同名的还有搜索块 / 网页块），
> 按模块名生成作用域会一起命中 —— 改"代码块"会连带改终端正文，面板的"当前默认值"也只能读到
> 同一个元素。钩子的**定义点**天然区分它们（`--dsl-code-block-*` 只在代码块的规则上、
> `--dsl-terminal-font` 只在终端的规则上，文件级哈希不同）⇒ 扫样式表取定义点，
> 与 ① 取令牌清单的口径一致：**样式表是权威来源**。

**路由规则（三个通道的选择依据，来自静态分析，不是偏好）**

- 字体的值来自 **DSH 角色令牌**（`var(--dsw-font-<角色>)`）⇒ 走 **①**。
- 字体来自**后代元素上的 `font:` 简写**（代码块/终端）⇒ 在容器上写 `font-size` **无效**
  （简写压过继承），**只有 ② 的钩子这条腿有效**。
- 字体是组件自己的写死声明、且元素没有自带 `font:` 简写 ⇒ 走 **③**。
- `components.js` 里每个目标的 `route` 字段就是这条判断的落地（`tokens` / `hooks` / `props`）。

## 值的真源在哪（与上面三个通道正交）

上面三个通道回答"**怎么把值投到页面上**"；值本身住在哪是另一件事，别混：

- **真源 = `fontsets/<活动 id>.json`**（随包层 `lib/fontsets/` 只读 + 用户层 `<pluginDataDir>/fontsets/`，
  同 id **用户层胜**；改随包那份会**写时复制**成用户层的一份，删掉它即"恢复原样"）。`config.json`
  里只留根字段 `{ fontSetId, fontCustom }` —— **六个字体键不在 settings 的持久化白名单里**
  （`lib/settings-schema.js` 的 `FONTSET_KEYS` 由客户端 `src/fontset-store.js` 与宿主
  `lib/routes/fontsets.js` 共用同一份 kind 元数据消毒）。
- **写回是设计的一部分**：面板里改任何一个字体项都只落到**当前这一套**；导入导出按整份 `.json` 走
  （导出用宿主响应头 + 普通链接 ⇒ 桌面端即系统"另存为"）。
- 决策与验收判据见账本 §9.5，过程记录见归档计划 [`archive/audits/F3-PLAN.md`](./archive/audits/F3-PLAN.md)；
  机制与不变量在各文件头（`lib/routes/fontsets.js` / `src/fontset-store.js` / `src/fontset-editor.js`）。

## 不变量（每个都有守卫断言）

1. **令牌层与组件层都不写 `!important`** —— DSH 写死的字体声明里 `!important` 只占 4/319
   （字重 0/71），等特异性就能压过。
2. **不写 `--dsh-content-font-size`**（那是 DSH 自己的「通用 → 字号」）。未设过的角色沿用
   DSH 的基准表达式（含 `--dsh-content-font-delta` 叠加，照旧跟随 DSH 的字号缩放）；
   **设过绝对字号的角色不再随它缩放** —— 这是收口时明确接受的取舍。
3. **不用 `:has()` / 祖先关联选择器**（白闪红线 1）；③ 只允许 `body [class*="_<白名单模块名>_"]`
   一种形态，且选择器**只能由组件 id 推出**（模块名不许从外部传进来）。
4. **不碰 katex（数学排版自带度量）与 `@font-face`**。
5. **不把哈希写进代码**（`_wordmark_u7vgf_31` 这类哈希每次构建都变 ⇒ 写死即静默失效）。
6. **空配置 = 不生成任何规则**：所有可调项都以 **DSH 官方值作初始值**，清空即回官方。
7. **打包器产物不是官方 API**：③ 依赖 CSS-module 的 `_<模块名>_<哈希>_<行>` 命名 ⇒
   启动时**自探测**（`probeComponentTargets`），未命中就整条降级，不误伤。
8. **hooks 通道的作用域只能来自"定义点扫描"**：它写的是 `--dsl-*` **自定义属性**，
   但**不许**按模块名生成作用域 —— 泛模块名（代码块 / 终端 / 搜索块 / 网页块都是 `.block`）
   会一起命中，且终端**也消费**代码块的内容钩子 ⇒ 改一个会动两个。查不到定义点就整条降级
   （不退回泛命中），扫描结果还必须过"单类选择器"形态校验才允许注入。
9. **真实属性通道不得用泛模块名**（`buildComponentCss` 必须跳过 hooks 组件）：那里写的是
   `font-size/weight/family`，打到同名的搜索块 / 网页块上就是误伤 —— 这条有守卫。

## 加一个新角色 / 新组件时要动的地方

| 想加什么 | 改哪里 | 守卫会要求你同步 |
|---|---|---|
| 排版角色 | `typography.js` 的 `THEME_TYPE_ROLES`（表达式**照抄 DSH**） | `lib/settings-schema.js` 的 `THEME_TYPE_ROLE_IDS`（两份必须一致） |
| 颜色角色 | `color-roles.js` 的 `THEME_COLOR_ROLES` | schema 的 `THEME_COLOR_ROLE_IDS` |
| 组件（③/②） | `components.js` 的 `COMPONENT_FONT_TARGETS`（`id` + **实测** `prefix` + `source` + `route`/`dslHooks`） | schema 的 `COMPONENT_FONT_KEYS`（比对的是 **id**，不是模块名）；`source` 必须非空且以 `.module.css` 结尾；白名单上限 3–5 是**棘轮** |

加组件时的三步：① 在 `@deepseek-ai/dsh-client-ui-primitives` 的 `*.module.css` 里**实测**
模块名，并把那个文件路径填进 `source`（本机装了 DSH 时守卫会打开它核对 `.prefix` 真的在里面）；
② 加白名单项并**同步 schema 键**；③ 想清 `route` —— 字体来自后代 `font:` 简写的只有 `hooks`
一条腿有效（而它的作用域由扫描推导，与 `prefix` 无关）。

DSH 升级后**重取角色表**的命令写在 `typography.js` 文件头（跑一遍即可核对基准值有没有变）。

## 这些模块怎么进浏览器包

四个文件都由 [`scripts/build-client.mjs`](../scripts/build-client.mjs) 的 `INLINE_MODULES`
**构建期内联**进 `lib/client.js`（浏览器半没有本地模块解析器，只能内联）。构建对每个模块断言
"浏览器安全 / 结构标记齐全 / 机器提取的注入名不与 `src/client.js` 重复"——**缺标记即构建失败**，
所以拆分不会悄悄变成重复定义。

> ⚠️ **漏登记 `INLINE_MODULES` 不会报错**，只是那个文件永远不进产物（本仓真发生过：
> `src/api-client.js` 一度是孤儿）。`verify-component-fonts.mjs` ⑧ 就是按
> 「模块在位 + 已内联 + **不在**正文」三件套断言 `apply.js` 的 —— 抽模块时照抄这个形状。

> 注：守卫脚本按本仓目录约定放在 **`test/`**（`verify-theme-layer.mjs` 覆盖 ① 与角色级字重，
> `verify-component-fonts.mjs` 覆盖 ②③ 与跨文件一致性）；**`test/tools/`** 留给没有 CI 消费者的
> 手动工具（诊断 / 分析 / 生成）；`scripts/` 只放构建与发布期脚本。目录语义见 `docs/MODULE-LAYOUT.md` §4。
