# src/font/ —— 字体系统（F / G 轨道）

这个目录是**字体系统的全部实现**。之所以单独成目录：字体有三个**互不相同的作用通道**，
如果不放在一起，改动时很容易用错通道（症状是"改了没反应"，且在真机上才看得出来）。

> 设计文档在 [`docs/REFACTOR-ASSESSMENT.md`](../../docs/REFACTOR-ASSESSMENT.md) §9（F 轨道设计要点）；
> 真机确认记录在 [`docs/F0-THEME-SERVICE-CHECKLIST.md`](../../docs/F0-THEME-SERVICE-CHECKLIST.md)。

## 三个通道（用哪个，取决于"字体从哪来"）

| 通道 | 里的文件 | 覆盖对象 | 机制 | 守卫 |
|---|---|---|---|---|
| ① **角色令牌** | `color-roles.js`、`typography.js` | DSH 的**角色**（正文/次要/弱化/极小/禁用；标题 1–4/正文/小字/代码/表格…） | DSH `theme` 服务的 `overrideTokens`（body 内联，**免 `!important`**） | `scripts/verify-theme-layer.mjs` |
| ② **官方组件钩子** | `components.js`（`DSL_FONT_HOOKS`） | 代码块 / 终端 | 官方 `--dsl-*` 钩子，**写进组件作用域** | `scripts/verify-component-fonts.mjs` |
| ③ **模块前缀** | `components.js` | 首期 5 个组件（markdown / codeBlock / terminal / table / sidebar） | `body [class*="_<前缀>_"]` 直接命中（**等特异性**，不用 `!important`） | 同上 |

**路由规则（三个通道的选择依据，来自静态分析，不是偏好）**

- 字体的值来自 **DSH 角色令牌**（`var(--dsw-font-<角色>)`）⇒ 走 **①**。
- 字体来自**后代元素上的 `font:` 简写**（代码块/终端）⇒ 在容器上写 `font-size` **无效**
  （简写压过继承），**只有 ② 的钩子这条腿有效**。
- 字体是组件自己的写死声明、且元素没有自带 `font:` 简写 ⇒ 走 **③**。
- `components.js` 里每个目标的 `route` 字段就是这条判断的落地（`tokens` / `hooks` / `props`）。

## 不变量（每个都有守卫断言）

1. **令牌层与组件层都不写 `!important`** —— DSH 写死的字体声明里 `!important` 只占 4/319
   （字重 0/71），等特异性就能压过。
2. **不写 `--dsh-content-font-size`**（那是 DSH 自己的「通用 → 字号」）；我们只叠加偏移，
   让 DSH 的字号继续生效。
3. **不用 `:has()` / 祖先关联选择器**（白闪红线 1）；③ 只允许 `body [class*="_<白名单前缀>_"]` 一种形态。
4. **不碰 katex（数学排版自带度量）与 `@font-face`**。
5. **不把哈希写进代码**（`_wordmark_u7vgf_31` 这类哈希每次构建都变 ⇒ 写死即静默失效）。
6. **空配置 = 不生成任何规则**：所有可调项都以 **DSH 官方值作初始值**，清空即回官方。
7. **打包器产物不是官方 API**：③ 依赖 CSS-module 的 `_<模块>_<哈希>_<行>` 命名 ⇒
   启动时**自探测**（`probeComponentTargets`），未命中就整条降级，不误伤。

## 加一个新角色 / 新组件时要动的地方

| 想加什么 | 改哪里 | 守卫会要求你同步 |
|---|---|---|
| 排版角色 | `typography.js` 的 `THEME_TYPE_ROLES`（表达式**照抄 DSH**） | `lib/settings-schema.js` 的 `THEME_TYPE_ROLE_IDS`（两份必须一致） |
| 颜色角色 | `color-roles.js` 的 `THEME_COLOR_ROLES` | schema 的 `THEME_COLOR_ROLE_IDS` |
| 组件（③/②） | `components.js` 的 `COMPONENT_FONT_TARGETS`（含 `route`/`dslHooks`） | schema 的 `COMPONENT_FONT_PREFIXES`；白名单上限 3–5 是**棘轮** |

DSH 升级后**重取角色表**的命令写在 `typography.js` 文件头（跑一遍即可核对基准值有没有变）。

## 这些模块怎么进浏览器包

三个文件都由 [`scripts/build-client.mjs`](../../scripts/build-client.mjs) 的 `INLINE_MODULES`
**构建期内联**进 `lib/client.js`（浏览器半没有本地模块解析器，只能内联）。构建对每个模块断言
"浏览器安全 / 结构标记齐全 / 机器提取的注入名不与 `src/client.js` 重复"——**缺标记即构建失败**，
所以拆分不会悄悄变成重复定义。

> 注：守卫脚本本身仍按本仓既有约定平铺在 `scripts/`（`verify-theme-layer.mjs` 覆盖 ① 与
> 角色级字重，`verify-component-fonts.mjs` 覆盖 ②③ 与跨文件一致性）。等结构整体规划时再一并归置。
