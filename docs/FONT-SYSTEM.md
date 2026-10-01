# src/font/ —— 字体系统（F / G 轨道）

> **English**: [`en/FONT-SYSTEM.md`](./en/FONT-SYSTEM.md)（与本文同源：改一处请同步另一处）
>
> **本文是索引，不是机制说明。** 字体系统的实现、不变量与取值口径住在
> [`src/font/`](../src/font/) 各文件的头注释里（本仓纪律：能写在代码旁的规则不单写文档）。
> 本文只回答两件事：**三个通道各是什么、以及改字体要动哪几个地方**。
> 决策与取舍见 [`adr/0002`](./adr/0002-settings-schema-single-source.md)（值的单一真源）
> 与账本 §9.1 的 `V1–V10` 令牌层约束（[`wip/OPEN-ITEMS.md`](./wip/OPEN-ITEMS.md)）。

这个目录是**字体系统的全部实现**。之所以单独成目录：字体有三个**互不相同的作用通道**，
如果不放在一起，改动时很容易用错通道（症状是"改了没反应"，且在真机上才看得出来）。

**目录里的文件分两类**：多数是**纯计算**（角色表 / 令牌 / 钩子生成，不碰 DOM），
`apply.js` 是**唯一碰 DOM 的那个**（宿主默认值快照 + 组件作用域样式表）。效果应用层
（`src/effects.js`）只调用它的入口，不再夹带任何字体实现。

## 三个通道（用哪个，取决于"字体从哪来"）

| 通道 | 代码 | 覆盖对象 | 机制 | 守卫 |
|---|---|---|---|---|
| ① **角色令牌** | [`color-roles.js`](../src/font/color-roles.js) · [`typography.js`](../src/font/typography.js) | DSH 的**角色**（正文 / 次要 / 弱化 / 标题 / 代码 / 表格…） | DSH `theme` 服务的 `overrideTokens`（body 内联，**免 `!important`**） | `test/verify-theme-layer.mjs` |
| ② **官方组件钩子** | [`components.js`](../src/font/components.js) 的 `DSL_FONT_HOOKS` | 代码块 / 终端 | 官方 `--dsl-*` 钩子，**作用域 = 该钩子在样式表里的定义点**（`scanHookScopes` 推导） | `test/verify-component-fonts.mjs` |
| ③ **模块名直接命中** | 同上，`COMPONENT_FONT_TARGETS` 的白名单项 | CSS-module 前缀可命中的组件 | `body [class*="_<模块名>_"]` 直接命中（**等特异性**，不用 `!important`） | 同上 |

> **①②③ 的机制、失效模式与不变量全部写在 [`components.js`](../src/font/components.js) 与
> [`apply.js`](../src/font/apply.js) 的文件头** —— 包括"为什么模块名必须实测"、
> "为什么 ② 不许按模块名生成作用域"、"为什么真实属性通道必须跳过 hooks 组件"。
> 改通道前先读那两份头注释；本文不重复它们。

**路由规则（用哪个通道，来自静态分析，不是偏好）**：字体的值来自 **DSH 角色令牌** ⇒ ①；
字体来自**后代元素上的 `font:` 简写** ⇒ 只有 ② 的钩子这条腿有效（在容器上写 `font-size` 无效，
简写压过继承）；字体是组件自己写死的声明且无 `font:` 简写 ⇒ ③。
每个目标的 `route` 字段（`tokens` / `hooks` / `props`）就是这条判断的落地，判据见 `components.js` 头注释。

## 值的真源在哪（与三个通道正交）

三个通道回答"**怎么把值投到页面上**"；值本身住在哪是另一件事：

- **真源 = `fontsets/<活动 id>.json`**：**随包层** `lib/fontsets/`（只读）+ **用户层**
  `<pluginDataDir>/fontsets/`，同 id **用户层胜**；改随包那份会**写时复制**成用户层的一份，
  删掉它即"恢复原样"。
- `config.json` 里只留根字段（活动字体集 id 与自定义项）—— **六个字体键不在 settings 的持久化
  白名单里**：它们由 `lib/settings-schema.js` 的 `FONTSET_KEYS` 定义 kind 元数据，
  客户端 [`src/fontset-store.js`](../src/fontset-store.js) 与宿主
  [`lib/routes/fontsets.js`](../lib/routes/fontsets.js) **共用同一份**做消毒。
- **写回是设计的一部分**：面板里改任何一个字体项都只落到**当前这一套**；导入导出按整份 `.json` 走
  （导出用宿主响应头 + 普通链接 ⇒ 桌面端即系统"另存为"）。

## 加一个新角色 / 新组件时要动的地方

**三处必须同时改**（守卫会要求它们一致）：

| 想加什么 | 改哪里 | 必须同步 |
|---|---|---|
| 排版角色 | `typography.js` 的 `THEME_TYPE_ROLES`（表达式**照抄 DSH**） | `lib/settings-schema.js` 的 `THEME_TYPE_ROLE_IDS`（两份必须一致） |
| 颜色角色 | `color-roles.js` 的 `THEME_COLOR_ROLES` | schema 的 `THEME_COLOR_ROLE_IDS` |
| 组件 | `components.js` 的 `COMPONENT_FONT_TARGETS`（`id` + **实测** `prefix` + `source` + `route`/`dslHooks`） | schema 的 `COMPONENT_FONT_KEYS`（比对的是 **id**，不是模块名） |

**加组件的三步**（细节与判据见 `components.js` 头注释）：

1. 在 `@deepseek-ai/dsh-client-ui-primitives` 的 `*.module.css` 里**实测**模块名，
   把那个文件路径填进 `source`（本机装了 DSH 时守卫会打开它核对 `prefix` 真的在里面）；
2. 加白名单项并**同步 schema 键**；
3. 想清 `route` —— 只有 `hooks` 那条腿能盖住"后代 `font:` 简写"的情形。

> ⚠️ 白名单**有条数上限**（棘轮），且 `source` 必须非空并以 `.module.css` 结尾 ——
> **上限与当前条数以守卫和 `COMPONENT_FONT_TARGETS` 为准，本文不写死它们**。

DSH 升级后**重取角色表**的命令写在 [`typography.js`](../src/font/typography.js) 文件头（跑一遍即可核对基准值有没有变）。

## 这些模块怎么进浏览器包

目录内模块都由 [`scripts/build-client.mjs`](../scripts/build-client.mjs) 的 `INLINE_MODULES`
**构建期内联**进 `lib/client.js`（浏览器半没有本地模块解析器，只能内联）。构建对每个模块断言
"浏览器安全 / 结构标记齐全 / 机器提取的注入名不与 `src/client.js` 重复"——**缺标记即构建失败**。

> ⚠️ **漏登记 `INLINE_MODULES` 不会报错**，只是那个文件永远不进产物（本仓真发生过：
> `src/api-client.js` 一度是孤儿）。`verify-component-fonts.mjs` 有一节就是按
> 「模块在位 + 已内联 + **不在**正文」三件套断言 `apply.js` 的 —— 抽模块时照抄这个形状。
> 目录语义与准入门槛见 [`CODE-STRUCTURE.md`](./CODE-STRUCTURE.md) §4。
