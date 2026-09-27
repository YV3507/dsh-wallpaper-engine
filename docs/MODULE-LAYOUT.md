# `lib/` 与 `src/` 的分工（模块布局规范 · **草案**）

> 本文只回答一件事：**新文件放哪、两侧怎么互通、什么算越界**。
> **状态：草案** —— 冻结条件见 §6；在那之前本文的规则与守卫同步补齐。
> 进度真源是 `docs/REFACTOR-ASSESSMENT.md` §5，本文不重复它。
> 更新纪律与账本同口径：以**符号名 / 目录名**锚定，不写行号、不写编年史。

---

## 1. 一条轴，不是两条

分工不是"`lib` = 服务端 / `src` = 客户端"，而是两个**正交**属性：

| 属性 | 判据 | 它决定什么 |
|---|---|---|
| **跑在哪个进程** | 要在浏览器里跑吗？ | 放 `src/` 还是 `lib/` |
| **是否随包发布** | 在 `package.json` 的 `files` 里吗？ | 能不能留死码 / 能不能放只给开发用的东西 |

组合出的四格，就是本仓的全部落点：

| | **随包发布** | **不发布（开发面）** |
|---|---|---|
| **浏览器进程** | `lib/client.js` —— **生成物，全仓唯一一个** | `src/**` —— 浏览器侧的**唯一真源** |
| **宿主进程**（Node / Electron main） | `lib/index.js` ＋ 它 import 的 `lib/**` 模块 ＋ `lib/vendor/`、`lib/webwallgl/`（第三方副本） ＋ `lib/types/` | `scripts/`、`test/`、`docs/`、`.integration-notes/`、`_refs/` |

**关键推论**：`files` 是发布面的唯一定义，而 `verify-package-files` 的 **P1** 断言「`lib/` 下每个运行期 `.js/.mjs` 都被 `files` 覆盖」⇒ **留在 `lib/` 的任何文件都会被打进发布包**。所以死码**不许**留在 `lib/`：要么删，要么移出发布面（`docs/archive/`、`assets/`）。这条不是洁癖，是"8,590 行不可达代码目前在 `files` 里、正在发给每个用户"的直接后果（账本 §3.2、§5 P2-12）。

---

## 2. 两种运行形态（决定了各自能写什么）

| | **宿主半** | **浏览器半** |
|---|---|---|
| 入口 | `lib/index.js`（`package.json` 的 `main`；DSH 插件 `apply(ctx)`） | `lib/client.js`（`exports["./client"]`；由 DSH 客户端加载器 `window.__ModuleLoader__.load({ id, factory })` 消费，见 `dsh.client.immediately`） |
| 源码在哪 | **就是 `lib/*.js` 本身**（手写、直接发布） | **`src/**`**：`src/client.js` 是正文，其余是构建期内联的模块 |
| 可用什么 | `node:*`、`worker_threads`、`child_process`、`fs` | `document`、`fetch`、DSH 客户端 ctx 服务；**无 `node:`、无 `import`** |
| 改完怎么生效 | **必须重启 DSH**（`lib/*.js` 启动时加载，不热更） | `npm run build` 重新生成 `lib/client.js` |

> ⚠️ 浏览器 bundle **没有本地模块解析器**（加载器的 `require` 只服务外部包）⇒ 从 `src/client.js` 拆出来的模块**不能在运行时 import**，只能由 `scripts/build-client.mjs` 的 `INLINE_MODULES` 在**构建期**按序内联进同一个工厂作用域，`src/client.js` 直接用它们的名字。**清单就是唯一的接线图。**

---

## 3. 硬约束（都由构建期/打包期断言兜住，不是建议）

1. **内联模块必须浏览器安全**：不得出现 `import` / `require(` / `export default` / `process.*` / `__dirname` / `__filename`（`build-client.mjs` 逐条断言，且**先剥注释再判**）。
2. **内联模块不得有顶层可执行语句去读宿主状态**：它们被注入在 bundle 顶部（早于 `src/client.js` 正文），顶层读正文里的 `const` 会撞 TDZ。
3. **名字必须唯一**：内联后与 `src/client.js` 同作用域 ⇒ 重复声明的名字会被构建**机器提取**后断言，冲突即构建失败。
4. **`src/` 模块之间不得 `import`**：它们靠"同一作用域"协作，靠模块头写下的**契约**（需要的外界、对外提供什么）而不是显式依赖。
5. **导出形态**：`src/` 模块用 `export { … }` 列出对外名字；构建剥掉 `export` 关键字与 `export {}` 块。**导出清单同时是守卫的接口**（守卫直接 `import` 模块做行为断言）。
6. **产物入库**：`lib/client.js` 是生成物但**提交**；CI 断言「重建后 `git diff --exit-code -- lib/client.js` 干净」。**永不手改 `lib/client.js`。**
7. **打包面**：`files` 覆盖 `lib/` 全部运行期文件（P1）；具名入口既存在又被发布（P3）；`dependencies` 每条都真的被 `lib/` import（P4）；build/verify/smoke 链**零裸依赖**（P5）。
8. **发布面必须"装上就能跑、且不多带东西"**（npm 方向的四条，见 `verify-package-publish`）：
   ① 活的代码所需文件（从 `lib/index.js` 出发的**可达闭包**）必须全在 `files` 里；
   ② 发布集里不得出现 `src/` `scripts/` `test/` `docs/` 等开发目录；
   ③ 发布文本里不得带**同步机器**的用户目录路径（占位符不算）—— 那是不可复现的元数据；
   ④ `dependencies` 每一条都必须被**可达闭包**加载（死码 import 不算 ⇒ 否则是白下载）。

---

## 4. 新文件放哪（决策程序）

按顺序问四句，第一句命中就停：

1. **要在浏览器里跑吗？**
   → `src/**`，**并且必须登记进 `scripts/build-client.mjs` 的 `INLINE_MODULES`**（含 `markers` 锚点）。
   ⚠️ 忘了登记**不会报错**，只是这个文件永远不进产物 —— 见 §5 偏离 2。
2. **两侧都要用吗？**（同一份数据/规则同时被宿主与客户端消费）
   → 放 `lib/`（宿主 ES `import`）**并**登记进 `INLINE_MODULES`（客户端构建期内联）。
   这就是 `lib/settings-schema.js` 的形态（P1-5 的设置键单一真源），因此它同时受 §3 全部约束（浏览器安全）。**这是唯一被允许的共享形态**，第二个共享内核要显式登记（§7 最后一行）。
3. **是宿主自己的实现吗？**
   → `lib/<语义名>.js` **并加进 `files`**。按职责分子目录（现状：`lib/media/`）。门面 `lib/index.js` 只做注册与协议聚合，**不装新逻辑**（P2-11 的目标形态）。
4. **是第三方副本 / 类型声明吗？**
   → vendored 放 `lib/vendor/`（内联副本）或 `lib/webwallgl/`（按文本注入的 shim），**不许改**，同步走 `scripts/sync-webwallgl.mjs`；
   → 类型放 `lib/types/*.d.ts`，**必须与代码一致**。

**一句话版**：*浏览器手写 → `src/` 且登记内联；两侧共用 → `lib/` 且登记内联；只有宿主 → `lib/` 且登记 `files`；第三方 → vendored 子目录。*

**反例（不要这么做）**
- 把"顺手拆出来的工具函数"放 `lib/`，然后又内联进浏览器 —— 边界就从这里开始烂。
- 在 `src/` 建一个文件却不登记 —— 它静默不生效（今天正有一例）。
- 为了少改一个 import，把宿主模块搬进 `src/` 或反向搬 —— 两侧的**依赖方向是单向**的（§7）。
- 手改 `lib/client.js` 让产物"看起来对"。

---

## 5. 当前偏离（冻结前必须收敛）

| # | 偏离 | 证据锚点 | 归口 |
|---|---|---|---|
| 1 | **死码在发布面里**：`font-render.js` / `scene-scripts.js` / `scene-script-apis.js` / `scene-renderer.js` / `scene-render-worker.mjs` 与 `we-renderer/`（**活下来的只有 `textures.js` 及其依赖 `canvas.js` / `math.js` / `jpeg.js`**）构成一个自相引用、但整体只从一个**零调用点**的函数进门的簇（`renderSceneFrameInWorker` → `new Worker('./scene-render-worker.mjs')`），而它们**全在 `files` 里 ⇒ 真的发给用户** | 账本 §3.2、§6.5；**§3.6 的实测更正了口径**：`as-is` 口径下 `lib/` **65 个文件全部可达**，剪掉两个"假活锚点"（`lib/index.js:67` 未调用的 `readPkg` import、`lib/index.js:915` 零调用点函数里的 `new Worker`）后才是 **48 个文件 / 9,618 行 = 24.6%** | P2-12（动手）· **P3-3/P3-4**（把它变成机器事实） |
| 2 | ~~**`src/` 孤儿**：`src/api-client.js` 既不在 `INLINE_MODULES` 也不被任何文件 import ⇒ **不进产物**~~ **已收敛**：已登记进 `INLINE_MODULES`（P2-9 第一批调用点改写同时落地），并由 `verify-api-client.mjs` ⑥ 断言「已登记 + 已在产物里 + 产物里只有一份」——**它曾经是孤儿**这件事本身说明"漏登记不报错"是真陷阱 | `verify-api-client.mjs` ⑥（含负对照） | ✅ |
| 3 | `lib/types/index.d.ts` 与代码矛盾（称"暴露三条路由"、把 `webServer` 当可选，实际 **31** 条且硬注入；**该文件第 66 行还自相矛盾**；同一句假话另抄在 `lib/index.js:22-24` 与 `cordis.patch.yml:18-19`），且 `WallpaperDescriptor` 缺 10 个字段、`Inventory` 缺 3 个、`client.d.ts` 零值导出 | 账本 §3.4、§3.6 | **P3-1** |
| 4 | 账本 §2 基线表仍写 `lib/client.js` 与 `src/client.js` **逐字节一致**；自内联模块引入后产物多了前奏（`window.__ModuleLoader__.load({…})` + 15 个内联模块），二者已不可能逐字节一致（该指标现在的正确表述是"重建后 `git status` 干净"） | 实测 `lib/client.js` 11,749 行 / 1,157,072 B vs `src/client.js` 4,261 行 / 770,874 B | **P3-2** |

> **可达性分析的两个已知例外**（写守卫时必须特判，否则会把活代码判成死码）：`lib/webwallgl/web-shim.js` 是**按文本注入**（`fs.readFile` + 塞进 HTML），`lib/vendor/**` 与部分产物是**按字符串 require**。账本 §8 已把这条记为度量方法的一部分。

---

## 6. 冻结条件

本文从"草案"升为"规范"，需要同时满足：

1. §5 四条偏离全部收敛；
2. §7 的三条缺口守卫全部在位，**且各带负对照**；
3. P2-12 完成 ⇒ 发布面只剩活代码，`files` 与可达闭包一致。
   ⚠️ **不能拿 `scripts/audit-import-closure.mjs` 当这条的判据**：它只验"被导入的文件都在 `files` 里"，
   今天**就已经打印 ✅**（而 48 个死文件全在 `files` 里）⇒ 该条件会**在动手前就成立**，等于没有条件。
   正确判据是有可达性棘轮（**P3-3**），口径见账本 §3.6 与 §8。

---

## 7. 守卫（规则只有机器可判定才算数）

| 规则 | 现状 | 缺口 |
|---|---|---|
| 内联模块浏览器安全 / `markers` 在位 / 名字不与正文冲突 | ✅ `scripts/build-client.mjs`（构建期硬失败） | — |
| `files` 覆盖 `lib/`；具名入口在位；依赖无死声明；工具链零裸依赖 | ✅ `scripts/verify-package-files.mjs` P1–P5（各带负对照） | — |
| **发布面自洽（npm 方向）**：可达闭包 ⊆ `files`；发布集无开发目录；发布文本无**同步机器**的用户目录路径；`dependencies` 每条都被**活的代码**加载（不是"lib/ 里某处 import 过"）；入口/导出目标都在包里；发布出去的 `lib/client.js` 是加载器形态且可解析；安装期脚本不得引用未随包发布的文件 | ✅ `scripts/verify-package-publish.mjs`（七组，各带负对照） | — |
| `lib/client.js` 与 `src/` 同步 | ✅ CI（重建后 `git diff --exit-code`） | — |
| **`src/` 无孤儿**：除 `src/client.js` 外每个文件都必须在 `INLINE_MODULES` 里 | 🟡 **部分**：`verify-api-client.mjs` ⑥ 只钉住 `src/api-client.js` 这一个（含"已内联 + 产物里只有一份"）。实测今天孤儿 **0 个**（13/13 全登记），所以缺的只是守卫 | **P3-5**：通用的 `src/**/*.js` 全量孤儿扫描 |
| **依赖方向单向**：`lib/**` 不得 import `src/**` | ❌（今天为 **0 处**） | **P3-6**。零容忍，不需要棘轮 |
| **共享内核白名单**：允许被内联进浏览器的 `lib/**` 文件只许来自一张显式清单（今天**恰好 1 条**：`lib/settings-schema.js`；其余 13 个内联模块都是 `src/`） | ❌ | **P3-7**。再加一条必须改清单 ⇒ 共享是**决策**而不是顺手 |
| **类型面与代码同源**：`lib/types/*.d.ts` 必须与实现一致 | ❌（无 tsconfig、无类型检查、无 devDependencies；两份 `.d.ts` 已明显漂移） | **P3-1** |
