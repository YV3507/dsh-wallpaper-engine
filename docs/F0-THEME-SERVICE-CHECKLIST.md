# F0 真机确认 —— 记录入口（结论已并入账本）

> **状态：F0 已关闭（2026-09-26 真机实测完成），F1 已落地。**

- **结论**（`V1–V10`，含对旧结论的两处修正）在 [`REFACTOR-ASSESSMENT.md`](./REFACTOR-ASSESSMENT.md) **§9.1** ——
  那是**约束**，实现必须继续满足（例：`ctx.get("theme")` 是启动竞态 ⇒ 必须延迟 + 轮询）。
- **实现**在 `src/font/`：三个**纯计算**文件（角色表 / 令牌 / 钩子生成，不碰 DOM）+ 唯一碰 DOM 的 `apply.js`；
  通道分工、9 条不变量、扩展步骤、进浏览器包的约束见 [`src/font/README.md`](../src/font/README.md)。
- **原始证据**（探针代码、两套配色的 377 条令牌取值、逐条实测表）**本地未跟踪**、不随仓库分发：
  `.integration-notes/scratch-scripts/`（`tmp-f0-theme-cdp.mjs` / `f0-probe.json` / `f0-tokens-dark.json` /
  `f0-tokens-light.json`）+ `~/.dsh-wallpaper-engine/diag/http.jsonl` 里 `"event":"F0-early"` 与 `"event":"F0"` 两组。
  需要复跑时按那份记录来。
- **收口状态**：探针已从 `src/client.js` 删除，`lib/client.js` 已重建。
