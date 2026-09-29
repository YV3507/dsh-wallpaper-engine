# test/ —— 验证与开发工具（不进发布包）

本目录是**开发面**：`package.json` 的 `files` 不收它，`verify-package-publish` 也会断言发布集里
不出现 `test/`。目录语义见 [`docs/MODULE-LAYOUT.md`](../docs/MODULE-LAYOUT.md) §4。

## 三层，各管一件事

| 层 | 内容 | 谁跑 |
|---|---|---|
| **`test/*.mjs`（守门）** | `verify-*.mjs` —— 结构性守卫：断言代码/文档/发布面与声明一致，**正负对照成对** | `npm run verify`（29 条链）与 CI |
| **`test/*-smoke.mjs`（冒烟）** | 节点级行为冒烟：轮换、实时帧回填、身份校验 | `npm run smoke` |
| **`test/e2e-*.mjs`（端到端）** | 真浏览器路径（需本机 Chromium 系浏览器） | `npm run verify:e2e`（不进 verify 链） |
| **`test/compat-*.mjs`（适配）** | 真 harness 集成面，三个入口：`compat-harness-live` —— link 插件进真实 `@deepseek-ai/dsh` 并启动，断言宿主路由注册可达 / 落盘诊断出现探活标记 / 插件树无加载失败（自带 HOME 隔离与 `DSH_WE_MEDIA_LEGACY=1`，媒体桥等第三方全程不拉起）；`compat-harness-surfaces` —— UI 面清单棘轮（已装 harness 的 `dsh-client-ui-*` 与 `test/fixtures/harness-ui-surfaces.json` 做差，**新表面未登记即红**）+ sidebar 源码活判据（属性锚点 / 隐藏机制 allowlist 对真源码）；`compat-harness-pages` —— 无头浏览器**逐页 DOM/样式断言**（零依赖 CDP 走计算样式探针：首页 / 会话页 slot 锚点 / 设置窗口玻璃三条 + 五分区走查；`--dump` 为探查模式） | `.github/workflows/harness-compat.yml`（需网络、`dsh` CLI 与 Chromium 系浏览器，不进 verify 链；本地 `node test/compat-harness-live.mjs` / `…-surfaces.mjs` / `…-pages.mjs [--dump]`） |
| **`test/tools/`（工具）** | 诊断 / 分析 / 生成 —— **没有 CI 消费者**，靠手敲；其中 `host-route-index.mjs` 同时是 `verify-route-index` 的库（生成 `docs/ROUTE-INDEX.md`） | 手动 |

## 约定（守卫会判）

1. **新写的守卫放 `test/`，手动工具放 `test/tools/`，harness 适配探活放 `test/compat-*`** —— 别放回
   `scripts/`：那里只留「用户与发布流程真的会跑」的脚本（`build-client.mjs` / `prepare.mjs` /
   CI 基线读写 `harness-compat-baseline.mjs`）。
2. **`test/tools/` 比 `test/` 深一层** ⇒ 用 `import.meta.url` 推仓库根时必须退**两层**
   （退一层会把根解析成 `test/`，症状是"文件没了"的 ENOENT）。`verify-module-layout` ④ 有断言。
3. **守卫的判据先剥注释再判**：本目录里大量存在说明"夹具长什么样"的散文，而夹具本身就是
   合成的 `import … from '…'` 字符串 —— 不剥注释的判据会被自己的负对照绊倒。
4. **新文件必须进 `verify-comment-discipline.mjs` 的棘轮表**（域 = `src/**/*.js` +
   `lib/routes/*.js` + `test/**/*.mjs` + `scripts/**/*.mjs`），否则该文件从注释纪律里消失。
5. **负对照必须把变异输入喂进「同一条判据」**（P3-16）：判据只在**一侧**定义 —— 命名函数、
   或命名的正则常量 —— 正判据与负对照都调它。两种写法不算数：
   - ① **只断言某个常量 / 数组不含 X**：判据根本没被执行，判据空转时它照样绿；
   - ② **在对照里另抄一份判据**（复制正则、复制 `.every(...)`）：生产侧改了它也不会红。
6. **假 React 必须像 React 一样校验子节点**（每个替身的 `createElement` 都插了同一段 `assertChildren`）：
   对象不能作为子节点（React #31）。替身若默默收下，这类错**只能在真机上炸** —— 实测踩过：
   在 `React.createElement(...)` 的参数位置上写赋值表达式，表达式的值（角色对象数组）会变成
   一个子节点；表为空时看不出来，一旦筛出角色整块面板就崩，而当时所有判据全绿。
   加了这段校验之后，同一形状会让 ⑧ 的"渲染得出"当场判红，报的就是真机那条错误。
7. **`test/**` 里不要写 BOM**：`verify-fontset.mjs` 带 shebang，BOM 会让 `node` 在 `#!` 那行报
   `Invalid or unexpected token`。Windows PowerShell 的 `Set-Content -Encoding UTF8` 默认**带**
   BOM ⇒ 批量改写用 `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))`。
   验证方式（本仓实测用法）：把判据**中和**成"永远说没问题"，对应的负对照**必须变红** ——
   而此时正判据会照过（空转），所以负对照是唯一能抓这类失效的那条。
