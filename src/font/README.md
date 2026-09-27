# src/font/ —— 字体系统（F / G 轨道）

这个目录是**字体系统的全部实现**。之所以单独成目录：字体有三个**互不相同的作用通道**，
如果不放在一起，改动时很容易用错通道（症状是"改了没反应"，且在真机上才看得出来）。

**目录里的四个文件分两类**：前三个是**纯计算**（角色表 / 令牌 / 钩子生成，不碰 DOM），
`apply.js` 是**唯一碰 DOM 的那个**（宿主默认值快照 + 组件作用域样式表）。效果应用层
（`src/effects.js`）只调用它的入口，不再夹带任何字体实现。

> 设计文档在 [`docs/REFACTOR-ASSESSMENT.md`](../../docs/REFACTOR-ASSESSMENT.md) §9（F 轨道设计要点）；
> 真机确认记录在 [`docs/F0-THEME-SERVICE-CHECKLIST.md`](../../docs/F0-THEME-SERVICE-CHECKLIST.md)。

## 三个通道（用哪个，取决于"字体从哪来"）

| 通道 | 里的文件 | 覆盖对象 | 机制 | 守卫 |
|---|---|---|---|---|
| ① **角色令牌** | `color-roles.js`、`typography.js` | DSH 的**角色**（正文/次要/弱化/极小/禁用；标题 1–4/正文/小字/代码/表格…） | DSH `theme` 服务的 `overrideTokens`（body 内联，**免 `!important`**） | `scripts/verify-theme-layer.mjs` |
| ② **官方组件钩子** | `components.js`（`DSL_FONT_HOOKS`） | 代码块 / 终端 | 官方 `--dsl-*` 钩子，**写进组件作用域** | `scripts/verify-component-fonts.mjs` |
| ③ **模块名直接命中** | `components.js` | 首期 4 个组件（markdown / codeBlock / terminal / table） | `body [class*="_<模块名>_"]` 直接命中（**等特异性**，不用 `!important`） | 同上 |

> ①②③ 的结果都由 `apply.js` 落到 DOM（①走 DSH 服务的令牌层，②③ 拼成 `#we-font-scope` 的 CSS）。
>
> ⚠️ **③ 的模块名必须是实测值**（在 DSH 产物 / `@deepseek-ai/dsh-client-ui-primitives` 的
> `*.module.css` 里核对），不许按"组件叫什么"猜 —— 本仓踩过：`codeBlock` / `table` / `sidebar`
> 三个猜出来的名字在 DSH 里**一个都不存在**，那 3 行曾是"看得见、填了没用"。
> 每个目标的 `id`（= 设置键，稳定）与 `prefix`（= 实测模块名，会随 DSH 变）因此是**两件事**。

**路由规则（三个通道的选择依据，来自静态分析，不是偏好）**

- 字体的值来自 **DSH 角色令牌**（`var(--dsw-font-<角色>)`）⇒ 走 **①**。
- 字体来自**后代元素上的 `font:` 简写**（代码块/终端）⇒ 在容器上写 `font-size` **无效**
  （简写压过继承），**只有 ② 的钩子这条腿有效**。
- 字体是组件自己的写死声明、且元素没有自带 `font:` 简写 ⇒ 走 **③**。
- `components.js` 里每个目标的 `route` 字段就是这条判断的落地（`tokens` / `hooks` / `props`）。

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
8. **泛模块名（跨模块重名）只许出现在 `route: 'hooks'` 通道**：那里写的是 `--dsl-*`
   **自定义属性**，非消费方元素上惰性 ⇒ 共用作用域安全（代码块与终端都是 `.block`，
   同名的还有搜索块 / 网页块）。反过来，写**真实属性**的通道一旦用泛名就会误伤同名块 ——
   所以 `buildComponentCss` 必须跳过 hooks 组件，这条有守卫。

## 加一个新角色 / 新组件时要动的地方

| 想加什么 | 改哪里 | 守卫会要求你同步 |
|---|---|---|
| 排版角色 | `typography.js` 的 `THEME_TYPE_ROLES`（表达式**照抄 DSH**） | `lib/settings-schema.js` 的 `THEME_TYPE_ROLE_IDS`（两份必须一致） |
| 颜色角色 | `color-roles.js` 的 `THEME_COLOR_ROLES` | schema 的 `THEME_COLOR_ROLE_IDS` |
| 组件（③/②） | `components.js` 的 `COMPONENT_FONT_TARGETS`（`id` + **实测** `prefix` + `route`/`dslHooks`） | schema 的 `COMPONENT_FONT_KEYS`（比对的是 **id**，不是模块名）；白名单上限 3–5 是**棘轮** |

加组件时的三步：① 在 DSH 产物 / `*.module.css` 里**实测**模块名（记进 `components.js` 文件头
的口径）；② 加白名单项并**同步 schema 键**；③ 想清 `route` —— 字体来自后代 `font:` 简写的
只有 `hooks` 一条腿有效，而泛模块名也只许用在 `hooks` 上。

DSH 升级后**重取角色表**的命令写在 `typography.js` 文件头（跑一遍即可核对基准值有没有变）。

## 这些模块怎么进浏览器包

四个文件都由 [`scripts/build-client.mjs`](../../scripts/build-client.mjs) 的 `INLINE_MODULES`
**构建期内联**进 `lib/client.js`（浏览器半没有本地模块解析器，只能内联）。构建对每个模块断言
"浏览器安全 / 结构标记齐全 / 机器提取的注入名不与 `src/client.js` 重复"——**缺标记即构建失败**，
所以拆分不会悄悄变成重复定义。

> ⚠️ **漏登记 `INLINE_MODULES` 不会报错**，只是那个文件永远不进产物（本仓真发生过：
> `src/api-client.js` 一度是孤儿）。`verify-component-fonts.mjs` ⑧ 就是按
> 「模块在位 + 已内联 + **不在**正文」三件套断言 `apply.js` 的 —— 抽模块时照抄这个形状。

> 注：守卫脚本本身仍按本仓既有约定平铺在 `scripts/`（`verify-theme-layer.mjs` 覆盖 ① 与
> 角色级字重，`verify-component-fonts.mjs` 覆盖 ②③ 与跨文件一致性）。等结构整体规划时再一并归置。
