# test/ —— 验证与开发工具（不进发布包）

本目录是**开发面**：`package.json` 的 `files` 不收它，`verify-package-publish` 也会断言发布集里
不出现 `test/`。目录语义见 [`docs/MODULE-LAYOUT.md`](../docs/MODULE-LAYOUT.md) §4。

## 三层，各管一件事

| 层 | 内容 | 谁跑 |
|---|---|---|
| **`test/*.mjs`（守门）** | `verify-*.mjs` —— 结构性守卫：断言代码/文档/发布面与声明一致，**正负对照成对** | `npm run verify`（23 条链）与 CI |
| **`test/*-smoke.mjs`（冒烟）** | 节点级行为冒烟：轮换、实时帧回填、身份校验 | `npm run smoke` |
| **`test/e2e-*.mjs`（端到端）** | 真浏览器路径（需本机 Chromium 系浏览器） | `npm run verify:e2e`（不进 verify 链） |
| **`test/tools/`（工具）** | 诊断 / 分析 / 生成 —— **没有 CI 消费者**，靠手敲；其中 `host-route-index.mjs` 同时是 `verify-route-index` 的库（生成 `docs/ROUTE-INDEX.md`） | 手动 |

## 约定（守卫会判）

1. **新写的守卫放 `test/`，手动工具放 `test/tools/`** —— 别放回 `scripts/`：那里只留「用户与发布
   流程真的会跑」的脚本（`build-client.mjs` / `prepare.mjs`）。
2. **`test/tools/` 比 `test/` 深一层** ⇒ 用 `import.meta.url` 推仓库根时必须退**两层**
   （退一层会把根解析成 `test/`，症状是"文件没了"的 ENOENT）。`verify-module-layout` ④ 有断言。
3. **守卫的判据先剥注释再判**：本目录里大量存在说明"夹具长什么样"的散文，而夹具本身就是
   合成的 `import … from '…'` 字符串 —— 不剥注释的判据会被自己的负对照绊倒。
4. **新文件必须进 `verify-comment-discipline.mjs` 的棘轮表**（域 = `src/**/*.js` +
   `lib/routes/*.js` + `test/**/*.mjs` + `scripts/**/*.mjs`），否则该文件从注释纪律里消失。
