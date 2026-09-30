# test/ —— 验证与开发工具（不进发布包）

本目录是**开发面**：`package.json` 的 `files` 不收它，`verify-package-publish` 也会断言发布集里
不出现 `test/`。目录语义见 [`docs/MODULE-LAYOUT.md`](../docs/MODULE-LAYOUT.md) §4。

## 三层，各管一件事

| 层 | 内容 | 谁跑 |
|---|---|---|
| **`test/*.mjs`（守门）** | `verify-*.mjs` —— 结构性守卫：断言代码/文档/发布面与声明一致，**正负对照成对** | 见下「两档」：硬档 `npm run verify` · 软档 `npm run verify:docs` |
| **`test/*-smoke.mjs`（冒烟）** | 节点级行为冒烟：轮换、实时帧回填、身份校验 | `npm run smoke`（在 `verify:all` 里） |
| **`test/e2e-*.mjs`（端到端）** | 真浏览器路径（需本机 Chromium 系浏览器） | `npm run verify:e2e`（不进 verify 链） |
| **`test/compat-*.mjs`（适配）** | 真 harness 集成面，三个入口：`compat-harness-live` —— link 插件进真实 `@deepseek-ai/dsh` 并启动，断言宿主路由注册可达 / 落盘诊断出现探活标记 / 插件树无加载失败（自带 HOME 隔离与 `DSH_WE_MEDIA_LEGACY=1`，媒体桥等第三方全程不拉起）；`compat-harness-surfaces` —— UI 面清单棘轮（已装 harness 的 `dsh-client-ui-*` 与 `test/fixtures/harness-ui-surfaces.json` 做差，**新表面未登记即红**）+ sidebar 源码活判据（属性锚点 / 隐藏机制 allowlist 对真源码）；`compat-harness-pages` —— 无头浏览器**逐页 DOM/样式断言**（零依赖 CDP 走计算样式探针：首页 / 会话页 slot 锚点 / 设置窗口玻璃三条 + 五分区走查；`--dump` 为探查模式） | `.github/workflows/harness-compat.yml`（需网络、`dsh` CLI 与 Chromium 系浏览器，不进 verify 链；本地 `node test/compat-harness-live.mjs` / `…-surfaces.mjs` / `…-pages.mjs [--dump]`） |
| **`test/tools/`（工具）** | 诊断 / 分析 / 生成 —— **没有 CI 消费者**，靠手敲（**逐个清单见下**） | 手动 |

### 两档：硬档挡 PR，软档只出声

判据多少不是问题，**所有判据共用同一种红**才是问题：一次文档排版改动与"发布面漏一个文件"
此前会让同一条命令失败，于是改一行的合规成本等于改发布面。现在按**失败的含义**分两档：

| 档 | 什么时候红 | 谁跑 | 清单 |
|---|---|---|---|
| **硬档** | 失败意味着**用户会撞上**：真机行为、发布面、平台契约、打包面 | `npm run verify`（在 `verify:all` 与 CI 里） | `verify-client-sync` · `verify-client` · `verify-transcode-state` · `verify-playback-controls` · `verify-scene` · `verify-scene-live` · `verify-adapter` · `verify-theme-follow` · `verify-logging` · `verify-media-bridge`（经 `test/warn-only.mjs --probe-spawn`，环境起不了子进程时显式 SKIP）· `verify-softrender` · `verify-readability` · `verify-glass-compositing` · `verify-package-files` · `verify-package-publish` · `verify-contracts` · `verify-types` · `verify-host-paint-scope` · `verify-route-index` · `verify-theme-layer` · `verify-api-client` · `verify-component-fonts` · `verify-fontset` · `verify-picker-upload` · `verify-picker-model` · `verify-picker-props` |
| **软档** | 失败意味着**仓库内务 / 账本自洽 / 一次性清理的验收判据**不准了 —— 要人回来看，但不该拦住别人的改动 | `npm run verify:docs`（在 `verify:all` 与 CI 的一条 `continue-on-error` 步骤里） | `verify-comment-discipline` · `verify-ledger` · `verify-module-layout` · `verify-reachability` · `verify-retired-lines` · `verify-dead-declarations` |

软档**照跑、照打印 `✓/✗`**，只是退出码被 `test/warn-only.mjs` 这层包装降级：
原码打在末尾的 `[warn-only] 软档守卫原退出码 = N` 行上，并写进 `DSH_WARN_ONLY_EXIT`。
这不是"静默跳过"（跳过不得与通过同形，见 `docs/README.md` §写作纪律 6）—— 判据一字未改，
想让它重新拦下改动，直接 `node test/verify-ledger.mjs` 跑它。
> 为什么是"跑子进程"而不是 `node --import …`：**实测** `npm run` 会把 `--import` 参数吞掉
> （npm 自己解析选项），于是降级没生效、链条当场断在第一条软档守卫上。转一手子进程与 npm
> 的参数解析无关，跨 npm 版本稳定。

**分档的判据**（新守卫放哪一档，按这个问）：
1. 失败时用户会不会看到错的行为 / 拿到坏的包？会 ⇒ **硬档**。
2. 它守的是"规则本身的形式"（账本状态列、棘轮基线、注释措辞）？是 ⇒ **软档**。
3. 拿不准 ⇒ **软档**：硬档的门槛是"能说出用户侧后果"，说不出的先别挡人。

**明确不做的四件事**（免得下次重新讨论）：
1. **不删守卫** —— 分档只改"谁决定红绿"，一条判据都不下线；软档照跑、照打印 `✓/✗`。
2. **不改判据内容** —— 要改判据是另一件事（改完走 `npm run verify:all`），不搭分档的车。
3. **不动 harness-compat 工作流** —— `test/compat-*` 与 `harness-compat.yml` 保持原样：需网络与真浏览器，
   本来就不在 verify 链里，分档管不着它。
4. **不给归档文档加新判据** —— `docs/archive/**` 只作记录、不反映现行实现，不为它新增守卫。

**动机一句话**：机制根因是**所有判据共用同一种红** —— "用户会撞上"与"仓库内务失真"这两种失败长得一样，
合规成本就被最贵的那条判据决定；分档只拆开"谁决定红绿"，判据本身一字未动。

### `test/tools/` 清单（9 个，都没有 CI 消费者）

| 工具 | 回答什么 | 怎么跑 |
|---|---|---|
| `analyze-host-apply.mjs` | 宿主 `apply(ctx)` 的拆分评估取证（路由数 / 按首段归组 / 巨石体量）—— 账本 §3.5、§7-6 的复算工具 | `node test/tools/analyze-host-apply.mjs` |
| `audit-fixture-coverage.mjs` | **夹具是不是把被测行为中和掉了**（P3-23 的候选清单） | `node test/tools/audit-fixture-coverage.mjs` |
| `audit-guard-teeth.mjs` | 守卫"牙齿"普查 A–F（对照没被评估 / log 式伪判据 / 零引用判据 / 恒真 / 无红出口 / 朴素剥注释吃代码）—— **只给候选** | `node test/tools/audit-guard-teeth.mjs` |
| `audit-import-closure.mjs` | `lib/` 的**运行时导入闭包** vs `package.json` 的 `files`（缺文件 ⇒ registry 装上就崩） | `node test/tools/audit-import-closure.mjs` |
| `branch-notify.mjs` | **分支级**"改了 store 却没通知"（与 `verify-client` ①i **同源**） | `node test/tools/branch-notify.mjs audit` |
| `diagnose-web-blank.mjs` | 网页壁纸「白屏」排查台（无头真浏览器） | `node test/tools/diagnose-web-blank.mjs` |
| `host-route-index.mjs` | 生成 / 核对**宿主路由索引**（产出 `docs/ROUTE-INDEX.md`） | `node test/tools/host-route-index.mjs [--write]` |
| `js-text.mjs` | JS/TS 源码的**文本级**工具（字符串/正则感知的剥注释） | `node test/tools/js-text.mjs selftest` |
| `sync-webwallgl.mjs` | 从本地 `webwallgl-github` 仓库构建 WebWallGL 渲染页（vendored 同步） | 见文件头 |

> 其中 `host-route-index.mjs` / `js-text.mjs` / `branch-notify.mjs` **同时是守卫的库**（分别被
> `verify-route-index` / 多个守卫 / `verify-client` ①i 复用）⇒ 改它们等于改判据，走 `npm run verify:all`。
> 本清单不缺项由 `verify-module-layout` ⑧ 断言（每个 `test/tools/*.mjs` 都必须在这里出现）。
> 另有 **`test/warn-only.mjs`**（不在本清单里）：两档共用的**入口包装** —— 降级退出码
> （`node test/warn-only.mjs <守卫>`）与"本环境起不了子进程就显式 SKIP"（`--probe-spawn`）。
> 它自己不是判据，所以没有独立守卫覆盖它。

## 约定（守卫会判）

1. **新写的守卫放 `test/`，手动工具放 `test/tools/`，harness 适配探活放 `test/compat-*`** —— 别放回
   `scripts/`：那里只留「用户与发布流程真的会跑」的脚本（`build-client.mjs` / `prepare.mjs` /
   CI 基线读写 `harness-compat-baseline.mjs`）。
2. **`test/tools/` 比 `test/` 深一层** ⇒ 用 `import.meta.url` 推仓库根时必须退**两层**
   （退一层会把根解析成 `test/`，症状是"文件没了"的 ENOENT）。`verify-module-layout` ④ 有断言。
3. **守卫的判据先剥注释再判**：本目录里大量存在说明"夹具长什么样"的散文，而夹具本身就是
   合成的 `import … from '…'` 字符串 —— 不剥注释的判据会被自己的负对照绊倒。
4. **新守卫只按"域"判定，没有登记动作**：注释纪律（禁日期 + 禁编年史/复盘腔）的域是
   `src/**/*.js` + `lib/routes/*.js` + `test/**/*.mjs` + `scripts/**/*.mjs` —— **从磁盘枚举**、
   判据是**全局零残留** ⇒ 新文件自动在域内，不必再去哪张表里补一行。
   此前那张"按文件封顶"的棘轮表是纯粹的税：忘登记只会让该文件静默脱离判据，而它换来的
   定位精度，命中清单本来就给。
   ⚠️ 唯独 `test/tools/*.mjs` 与 `test/compat-*.mjs` **仍要在本文档点名**（`verify-module-layout` ⑧）。
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
8. **怎么验证"判据本身有效"**：把判据**中和**成"永远说没问题"，对应的负对照**必须变红** ——
   此时正判据会照过（空转），所以负对照是唯一能抓这类失效的那条。
