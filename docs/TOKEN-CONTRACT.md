# `--dsw-*` 令牌契约（自动生成，勿手改）

> 生成：`node test/tools/token-contract.mjs --write`；核对：`node test/verify-token-contract.mjs`
> （守卫在契约与代码不一致时失败 —— 令牌集合因此不会烂掉）。
>
> **口径**：只计 `src/styles.js` CSS 模板里**属性位**的 `--dsw-*` 声明（值里的
> `var(--dsw-…)` 是读不是写，不计）；门控归属按花括号栈上的**选择器链**判定。
> **玻璃** = 链上有 `[data-we-glass-*]`；**壁纸** = 只有 `[data-we-wallpaper]`；
> **无门控** = 两者都不挂（共存审计 M1 的全部暴露面 —— 白名单见下表，新增一条守卫即红）。
> JS 侧的令牌写入（`src/font/apply.js` 的 label 族等）不在本契约口径内，见 `docs/DSH-UI-INTERFACES.md`。

共 **153** 条声明 / **49** 个不同令牌。门控归属：
玻璃 **122** 条 · 壁纸 **12** 条 · 无门控 **19** 条。

## 无门控声明（白名单 —— M1 的全部暴露面）

除下列两处封闭白名单外，**任何新的无门控 `--dsw-*` 声明都会让 `verify-token-contract` 变红**
（按宿主规范消费 token 的第三方插件无法区分「玻璃开/关」，只能拿到配方本身 —— 见 `docs/COEXISTENCE.md`）。

| 令牌 | 行 | 选择器链 | 归属 |
|---|---|---|---|
| `--dsw-alias-bg-layer-1` | styles.js:96 | `.we-layer` | .we-layer（插件自有元素，卸载即消失） |
| `--dsw-specific-bubble` | styles.js:904 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block` | styles.js:905 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block-banner` | styles.js:906 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-inline-code` | styles.js:907 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-tag` | styles.js:908 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-unselected` | styles.js:909 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-selected` | styles.js:910 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-citation` | styles.js:911 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-placeholder` | styles.js:912 | `body[data-we-thinking-native] [data-chat-flow], body[data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-specific-bubble` | styles.js:918 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block` | styles.js:919 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-block-banner` | styles.js:920 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-inline-code` | styles.js:921 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-tag` | styles.js:922 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-unselected` | styles.js:923 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-code-segment-selected` | styles.js:924 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-citation` | styles.js:925 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |
| `--dsw-alias-markdown-placeholder` | styles.js:926 | `body[data-ds-dark-theme][data-we-thinking-native] [data-chat-flow], body[data-ds-dark-theme][data-we-thinking-native] [data-vcp-rawhtml]` | thinking-native（思考块自带开关） |

## 全量令牌表

| 令牌 | 条数 | 门控 | 行号 | 消费者注记 |
|---|---|---|---|---|
| `--dsw-alias-bg-base` | 2 | 壁纸(0) | 222, 343 | 页面基底 —— 壁纸可见性的关键前提（transparent） |
| `--dsw-alias-bg-layer-1` | 11 | 玻璃(0) + 无门控(0) | 96, 248, 349, 1442, 1503, 1525, 1530, 1539, 3004, 3011, 3022 | 面板层次 1（宿主对话框/侧栏底）；better-sidebar 亦按它上色 |
| `--dsw-alias-bg-layer-2` | 11 | 玻璃(0) | 251, 352, 767, 1445, 1506, 1526, 1531, 1540, 3005, 3012, 3023 | 面板层次 2 |
| `--dsw-alias-bg-layer-3` | 10 | 玻璃(0) | 254, 355, 1448, 1509, 1527, 1532, 1541, 3006, 3013, 3024 | 面板层次 3 |
| `--dsw-alias-bg-module-platform` | 2 | 玻璃(0) | 269, 365 |  |
| `--dsw-alias-bg-multi-select` | 2 | 玻璃(0) | 272, 368 |  |
| `--dsw-alias-bg-overlay` | 2 | 玻璃(0) | 266, 362 | 弹层/浮出层底（issue #71 全表面玻璃） |
| `--dsw-alias-border-l1` | 2 | 玻璃(0) | 330, 414 | 边框强调 L1（「边框」滑条） |
| `--dsw-alias-border-l2` | 2 | 玻璃(0) | 331, 415 | 边框强调 L2 |
| `--dsw-alias-border-l2-darkmode-thin` | 2 | 玻璃(0) | 332, 416 | 深色细边框 |
| `--dsw-alias-border-l3` | 1 | 玻璃(0) | 1012 |  |
| `--dsw-alias-brand-primary` | 3 | 玻璃(0) | 1020, 1124, 1461 |  |
| `--dsw-alias-brand-text` | 3 | 玻璃(0) | 1021, 1125, 1462 |  |
| `--dsw-alias-button-elevated-fill` | 4 | 玻璃(0) | 257, 358, 1542, 3025 | 抬高按钮实色（侧栏「新建会话」等） |
| `--dsw-alias-button-floating-fill` | 3 | 玻璃(0) | 275, 371, 769 |  |
| `--dsw-alias-button-floating-hover` | 1 | 玻璃(0) | 770 |  |
| `--dsw-alias-button-ghost-active-fill` | 2 | 玻璃(0) | 278, 374 |  |
| `--dsw-alias-button-primary-dimmed` | 1 | 玻璃(0) | 1465 |  |
| `--dsw-alias-button-primary-fill` | 1 | 玻璃(0) | 1463 |  |
| `--dsw-alias-button-primary-hover` | 1 | 玻璃(0) | 1464 |  |
| `--dsw-alias-button-tool-bar-fill` | 2 | 玻璃(0) | 281, 377 |  |
| `--dsw-alias-interactive-bg-active` | 2 | 玻璃(0) | 284, 380 |  |
| `--dsw-alias-interactive-bg-hover` | 6 | 玻璃(0) | 768, 1017, 1045, 1121, 1159, 1454 |  |
| `--dsw-alias-interactive-bg-hover-accent` | 3 | 玻璃(0) | 1018, 1122, 1455 |  |
| `--dsw-alias-interactive-bg-hover-solid` | 2 | 玻璃(0) | 287, 383 |  |
| `--dsw-alias-label-caption` | 1 | 壁纸(0) | 447 |  |
| `--dsw-alias-label-dimmed` | 1 | 壁纸(0) | 448 |  |
| `--dsw-alias-label-primary` | 1 | 壁纸(0) | 443 | 正文灰阶（壁纸激活时压暗提对比） |
| `--dsw-alias-label-primary-dimmed` | 1 | 壁纸(0) | 444 |  |
| `--dsw-alias-label-primary-foreground` | 1 | 玻璃(0) | 1472 |  |
| `--dsw-alias-label-secondary` | 1 | 壁纸(0) | 445 | 次要文字灰阶 |
| `--dsw-alias-label-tertiary` | 1 | 壁纸(0) | 446 |  |
| `--dsw-alias-markdown-citation` | 4 | 玻璃(0) + 无门控(0) | 290, 386, 911, 925 |  |
| `--dsw-alias-markdown-code-block` | 6 | 玻璃(0) + 无门控(0) | 308, 396, 803, 905, 919, 1545 | markdown 代码块底 |
| `--dsw-alias-markdown-code-block-banner` | 6 | 玻璃(0) + 无门控(0) | 311, 399, 804, 906, 920, 1546 | markdown 代码条幅底 |
| `--dsw-alias-markdown-code-segment-selected` | 5 | 玻璃(0) + 无门控(0) | 325, 411, 910, 924, 1550 | 代码卡分段（选中） |
| `--dsw-alias-markdown-code-segment-unselected` | 5 | 玻璃(0) + 无门控(0) | 320, 408, 909, 923, 1549 | 代码卡分段（未选中） |
| `--dsw-alias-markdown-inline-code` | 6 | 玻璃(0) + 无门控(0) | 314, 402, 730, 907, 921, 1547 | 行内代码底 |
| `--dsw-alias-markdown-placeholder` | 4 | 玻璃(0) + 无门控(0) | 293, 389, 912, 926 |  |
| `--dsw-alias-markdown-tag` | 5 | 玻璃(0) + 无门控(0) | 317, 405, 908, 922, 1548 | markdown 标签底 |
| `--dsw-alias-state-business-primary` | 3 | 玻璃(0) | 1019, 1123, 1466 |  |
| `--dsw-alias-turn-trigger-bg` | 3 | 玻璃(0) | 635, 645, 3036 |  |
| `--dsw-alias-turn-trigger-bg-hover` | 3 | 玻璃(0) | 638, 648, 3037 |  |
| `--dsw-specific-bubble` | 4 | 玻璃(0) + 无门控(0) | 543, 553, 904, 918 |  |
| `--dsw-specific-input-major` | 2 | 玻璃(0) | 540, 550 |  |
| `--dsw-specific-selector` | 1 | 玻璃(0) | 3026 |  |
| `--dsw-specific-sidebar-fill` | 4 | 壁纸(0) | 223, 344, 432, 941 | 侧栏填充（宿主 Mica/深色主题各有一份） |
| `--dsw-specific-sidebar-nav-item-active` | 2 | 玻璃(0) | 1452, 1512 |  |
| `--dsw-specific-sidebar-nav-item-hover` | 2 | 玻璃(0) | 1453, 1513 |  |
