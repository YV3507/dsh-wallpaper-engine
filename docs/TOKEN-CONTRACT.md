# `--dsw-*` 令牌契约（自动生成，勿手改）

> 生成：`node test/tools/token-contract.mjs --write`；核对：`node test/verify-token-contract.mjs`
> （守卫在契约与代码不一致时失败 —— 令牌集合因此不会烂掉）。
>
> **口径**：只计 `src/styles.js` CSS 模板里**属性位**的 `--dsw-*` 声明（值里的
> `var(--dsw-…)` 是读不是写，不计）；门控归属按花括号栈上的**选择器链**判定。
> **玻璃** = 链上有 `[data-we-glass-*]`；**壁纸** = 只有 `[data-we-wallpaper]`；
> **无门控** = 两者都不挂（共存审计 M1 的全部暴露面 —— 白名单见下表，新增一条守卫即红）。
> JS 侧的令牌写入（`src/font/apply.js` 的 label 族等）不在本契约口径内，见 `docs/DSH-UI-INTERFACES.md`。

共 **162** 条声明 / **54** 个不同令牌。门控归属：
玻璃 **131** 条 · 壁纸 **12** 条 · 无门控 **19** 条。

## 无门控声明（白名单 —— M1 的全部暴露面）

除下列两处封闭白名单外，**任何新的无门控 `--dsw-*` 声明都会让 `verify-token-contract` 变红**
（按宿主规范消费 token 的第三方插件无法区分「玻璃开/关」，只能拿到配方本身 —— 见 `docs/COEXISTENCE.md`）。

| 令牌 | 行 | 选择器链 | 归属 |
|---|---|---|---|
| `--dsw-alias-bg-layer-1` | styles.js:96 | `.we-layer` | .we-layer（插件自有元素，卸载即消失） |
| `--dsw-specific-bubble` | styles.js:1011 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block` | styles.js:1012 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block-banner` | styles.js:1013 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-inline-code` | styles.js:1014 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-tag` | styles.js:1015 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-unselected` | styles.js:1016 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-selected` | styles.js:1017 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-citation` | styles.js:1018 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-placeholder` | styles.js:1019 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-specific-bubble` | styles.js:1025 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block` | styles.js:1026 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block-banner` | styles.js:1027 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-inline-code` | styles.js:1028 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-tag` | styles.js:1029 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-unselected` | styles.js:1030 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-selected` | styles.js:1031 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-citation` | styles.js:1032 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-placeholder` | styles.js:1033 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |

## 全量令牌表

| 令牌 | 条数 | 门控 | 行号 | 消费者注记 |
|---|---|---|---|---|
| `--dsw-alias-bg-base` | 2 | 壁纸(0) | 222, 343 | 页面基底 —— 壁纸可见性的关键前提（transparent） |
| `--dsw-alias-bg-layer-1` | 11 | 玻璃(0) + 无门控(0) | 96, 248, 349, 1549, 1610, 1632, 1637, 1646, 3132, 3139, 3150 | 面板层次 1（宿主对话框/侧栏底）；better-sidebar 亦按它上色 |
| `--dsw-alias-bg-layer-2` | 11 | 玻璃(0) | 251, 352, 842, 1552, 1613, 1633, 1638, 1647, 3133, 3140, 3151 | 面板层次 2 |
| `--dsw-alias-bg-layer-3` | 10 | 玻璃(0) | 254, 355, 1555, 1616, 1634, 1639, 1648, 3134, 3141, 3152 | 面板层次 3 |
| `--dsw-alias-bg-module-platform` | 2 | 玻璃(0) | 269, 365 |  |
| `--dsw-alias-bg-multi-select` | 2 | 玻璃(0) | 272, 368 |  |
| `--dsw-alias-bg-overlay` | 2 | 玻璃(0) | 266, 362 | 弹层/浮出层底（issue #71 全表面玻璃） |
| `--dsw-alias-border-l1` | 2 | 玻璃(0) | 330, 414 | 边框强调 L1（「边框」滑条） |
| `--dsw-alias-border-l2` | 2 | 玻璃(0) | 331, 415 | 边框强调 L2 |
| `--dsw-alias-border-l2-darkmode-thin` | 2 | 玻璃(0) | 332, 416 | 深色细边框 |
| `--dsw-alias-border-l3` | 1 | 玻璃(0) | 1119 |  |
| `--dsw-alias-brand-primary` | 3 | 玻璃(0) | 1127, 1231, 1568 |  |
| `--dsw-alias-brand-text` | 3 | 玻璃(0) | 1128, 1232, 1569 |  |
| `--dsw-alias-button-elevated-fill` | 4 | 玻璃(0) | 257, 358, 1649, 3153 | 抬高按钮实色（侧栏「新建会话」等） |
| `--dsw-alias-button-floating-fill` | 3 | 玻璃(0) | 275, 371, 844 |  |
| `--dsw-alias-button-floating-hover` | 1 | 玻璃(0) | 845 |  |
| `--dsw-alias-button-ghost-active-fill` | 2 | 玻璃(0) | 278, 374 |  |
| `--dsw-alias-button-primary-dimmed` | 1 | 玻璃(0) | 1572 |  |
| `--dsw-alias-button-primary-fill` | 1 | 玻璃(0) | 1570 |  |
| `--dsw-alias-button-primary-hover` | 1 | 玻璃(0) | 1571 |  |
| `--dsw-alias-button-tool-bar-fill` | 2 | 玻璃(0) | 281, 377 |  |
| `--dsw-alias-interactive-bg-active` | 2 | 玻璃(0) | 284, 380 |  |
| `--dsw-alias-interactive-bg-hover` | 6 | 玻璃(0) | 843, 1124, 1152, 1228, 1266, 1561 |  |
| `--dsw-alias-interactive-bg-hover-accent` | 3 | 玻璃(0) | 1125, 1229, 1562 |  |
| `--dsw-alias-interactive-bg-hover-solid` | 2 | 玻璃(0) | 287, 383 |  |
| `--dsw-alias-label-caption` | 1 | 壁纸(0) | 447 |  |
| `--dsw-alias-label-dimmed` | 1 | 壁纸(0) | 448 |  |
| `--dsw-alias-label-primary` | 1 | 壁纸(0) | 443 | 正文灰阶（壁纸激活时压暗提对比） |
| `--dsw-alias-label-primary-dimmed` | 1 | 壁纸(0) | 444 |  |
| `--dsw-alias-label-primary-foreground` | 1 | 玻璃(0) | 1579 |  |
| `--dsw-alias-label-secondary` | 1 | 壁纸(0) | 445 | 次要文字灰阶 |
| `--dsw-alias-label-tertiary` | 1 | 壁纸(0) | 446 |  |
| `--dsw-alias-markdown-citation` | 4 | 玻璃(0) + 无门控(0) | 290, 386, 1018, 1032 |  |
| `--dsw-alias-markdown-code-block` | 6 | 玻璃(0) + 无门控(0) | 308, 396, 878, 1012, 1026, 1652 | markdown 代码块底 |
| `--dsw-alias-markdown-code-block-banner` | 6 | 玻璃(0) + 无门控(0) | 311, 399, 879, 1013, 1027, 1653 | markdown 代码条幅底 |
| `--dsw-alias-markdown-code-segment-selected` | 5 | 玻璃(0) + 无门控(0) | 325, 411, 1017, 1031, 1657 | 代码卡分段（选中） |
| `--dsw-alias-markdown-code-segment-unselected` | 5 | 玻璃(0) + 无门控(0) | 320, 408, 1016, 1030, 1656 | 代码卡分段（未选中） |
| `--dsw-alias-markdown-inline-code` | 6 | 玻璃(0) + 无门控(0) | 314, 402, 805, 1014, 1028, 1654 | 行内代码底 |
| `--dsw-alias-markdown-placeholder` | 4 | 玻璃(0) + 无门控(0) | 293, 389, 1019, 1033 |  |
| `--dsw-alias-markdown-tag` | 5 | 玻璃(0) + 无门控(0) | 317, 405, 1015, 1029, 1655 | markdown 标签底 |
| `--dsw-alias-scrollbar-bg-l1` | 2 | 玻璃(0) | 588, 602 |  |
| `--dsw-alias-scrollbar-bg-l2` | 2 | 玻璃(0) | 589, 603 |  |
| `--dsw-alias-scrollbar-hover-l1` | 2 | 玻璃(0) | 590, 604 |  |
| `--dsw-alias-scrollbar-hover-l2` | 2 | 玻璃(0) | 591, 605 |  |
| `--dsw-alias-state-business-primary` | 3 | 玻璃(0) | 1126, 1230, 1573 |  |
| `--dsw-alias-turn-trigger-bg` | 3 | 玻璃(0) | 674, 684, 3164 |  |
| `--dsw-alias-turn-trigger-bg-hover` | 3 | 玻璃(0) | 677, 687, 3165 |  |
| `--dsw-mask-blur` | 1 | 玻璃(0) | 579 |  |
| `--dsw-specific-bubble` | 4 | 玻璃(0) + 无门控(0) | 543, 553, 1011, 1025 |  |
| `--dsw-specific-input-major` | 2 | 玻璃(0) | 540, 550 |  |
| `--dsw-specific-selector` | 1 | 玻璃(0) | 3154 |  |
| `--dsw-specific-sidebar-fill` | 4 | 壁纸(0) | 223, 344, 432, 1048 | 侧栏填充（宿主 Mica/深色主题各有一份） |
| `--dsw-specific-sidebar-nav-item-active` | 2 | 玻璃(0) | 1559, 1619 |  |
| `--dsw-specific-sidebar-nav-item-hover` | 2 | 玻璃(0) | 1560, 1620 |  |
