# issue ≥148 本地验证汇总 + 总修复计划

> 状态：**草案（未跟踪，未落库）** —— 本文件是一次只读核查的交付物。按 `docs/README.md` 的写作约定（§56 常青文档不写会漂的数值、§62 入库文档不引本机路径），若要把结论留在仓库里，应把「机制」归到实现文件头注释、「判据」归到 `test/`、「取舍」归到 `adr/`，本文件只在 `docs/wip/` 暂存。

核查对象：仓库 HEAD `111816a`（`v1.3.1` 之后、**尚未打 `v1.3.2` tag**），工作树 clean，`npm run verify` exit 0。
宿主：DSH 桌面 **0.2.0-rc.2**（与全部 10 位报告者所用版本一致）。
范围：`state=all` 的 85 条非 PR issue 中 **≥148 的 10 条**：`148 150 152 154 156 157 158 159 160 161`（OPEN = 148/156/157/158/159/161，CLOSED = 150/152/154/160）。

---

## 0. 方法、证据分级与能力边界

**三条腿交叉**，缺一不下"确认"结论：

1. **源码静态断言** —— 本仓 `src/`、`lib/` 逐行读。
2. **宿主真实产物逐字核对** —— 读 asar 内 `@deepseek-ai/dsh-client-ui-*` 的 JSX 与 CSS Modules。这一条是本次的关键：报告者贴的是哈希类名，只有对着宿主产物才能判定"我们的选择器命中的到底是不是同一个元素"（#161 就是靠它定的案）。
3. **本机可执行复现** —— 两份一次性复现脚本（未入库、跑完即弃；焦点围栏 6/6 PASS、主题缓存失效 4/4 PASS）+ 已入库的 `test/verify-*.mjs`。

**证据等级**：`A` = 可执行复现通过；`B` = 宿主产物逐字对上（含行/偏移）；`C` = 仅静态阅读；`D` = 本机不可验证。

**做不到的四件事（结论的边界，请连结论一起读）**：

- 无 Windows / Steam / Wallpaper Engine 运行时 ⇒ **#150、#152 不能真机跑 WE**，只能靠"提交是 `HEAD` 的祖先 + 守卫已绿"。
- 无浏览器自动化 ⇒ 所有"观感"类是**静态充分**（规则的确会产生该视觉结果），不是像素复现。
- `dependencies` 与 `devDependencies` 均为 `{}` ⇒ 不能临时引入 jsdom/puppeteer；复现脚本一律 `node:vm` 假 realm 跑**真源码**。
- ~~宿主启动序列不可验证~~ —— 已由第二轮回归：在已装 `app.asar` 上做**二进制 grep**确实命中了宿主自己的启动代码（见 §2 #158(a)），#158 ① 的机制从"引报告者观察"升级为"宿主产物逐字确认"。仍未验证的是**感知到的启动延迟量级**（需要"禁用插件前后各重启一次"的 A/B，报告者与本地都没做）。

---

## 1. 结论速览

| # | 一句话 | 远端 | 本地判定 | 等级 |
|---|---|---|---|---|
| **148** | 网页壁纸周期性抢焦点（0.9–3.6s 一次） | OPEN | **部分修复** —— 帧级围栏已在位且已接线；元素级无围栏；**报告的症状未被现有围栏解释** | A + C |
| **150** | 全屏时右栏被会话层盖住 | CLOSED | **已修，在 HEAD 里** | C |
| **152** | 新版 WE（`distribution/` 布局）装不上 | CLOSED | **已修，在 HEAD 里** | A |
| **154** | 思考行宽度塌成 0 | CLOSED | **已修，在 HEAD 里** | A |
| **156** | 玻璃面失去底板（弹窗无模糊 / 代码块吸顶条透明 / 统计行无底 / 侧栏透明）四条 | OPEN | **全部 CONFIRMED，未修** | A(数学) + B |
| **157** | 滚动条观感（太粗/太亮/轨道留白…） | OPEN | **真缺口**，现存规则只覆盖约 1/3 | B + C |
| **158** | 客户端包重 + `/inventory` 冷扫 1.9s / 1.86MB | OPEN | **CONFIRMED**（性能类，无功能错） | A + B |
| **159** | ① 切主题后玻璃底色不跟随 ② 玻璃色不能分深浅 | OPEN | ① **CONFIRMED 缺陷** ② **CONFIRMED 能力缺口** | A + C |
| **160** | 推广（GithubStarMate） | CLOSED | **invalid**（非本插件问题，关闭正确） | — |
| **161** | Tooltip 被 `[class*="_bubble"]` 误伤 | OPEN | **CONFIRMED**（根因在宿主共享类名） | B + C |

**要点**：10 条里 4 条（150/152/154/160）**不需要动手**；6 条（148/156/157/158/159/161）需要在 HEAD 上真改，其中 **#156 / #161 / #159① 是"小改动、高可见收益"**，#148 是唯一"机制尚未完全解释、需要先加观测"的一条。

---

## 2. 逐条核查

### #148 网页壁纸周期性抢焦点 —— 部分修复（等级 A + C）

**报告诉求**：播某些网页壁纸时，输入框 / 下拉 / 左下角账号菜单"每点一次就丢焦点"，周期约 0.9–3.6 s。

**已在位的东西**：`lib/we-focus-guard.js`（73 行）已经吃掉了**帧级** `window.focus()`：幂等安装（只装一次）、计数 `{calls, blocked, allowed, installed, allow}`、逃生门 `__weFocusGuard.allow = true`、**绝不抛**、赋值失败时退到 `defineProperty`。注入点唯一，在 `/scene-files` 的 HTML 分支内，顺序被守卫钉死为 **site-root → shim → focus-guard → seed**（都早于作者脚本）。`test/verify-scene-live.mjs:1945-2024` 用**真源码**在假 realm 里钉了 6 条（含负对照），并显式写下设计边界：

> 围栏吞掉**帧级** window.focus() 并留计数；**元素级 focus 放行（壁纸自己的编辑框照常工作）**。

**我复现出来的洞**：一次性焦点围栏复现脚本 6/6 通过；额外再测：壁纸里 `setInterval(() => input.focus(), 2000)` 这种**元素级**抢焦 **10/10 次全部穿透**（不是"没测到"，是根本没拦）。全库 grep `activeElement|focusin|focusout|relatedTarget` 于 `src/` + `lib/` ⇒ **0 命中**，即宿主侧**没有任何焦点交还逻辑**。

**判定与差距**：
- 报告的症状（**周期 0.9–3.6 s**）是**定时器**特征，不是"每点一次"——两者指同一现象里的不同触发路径，报告人自己也没给出壁纸名。
- 现有围栏只堵**帧级** `window.focus()`；元素级 `HTMLElement.prototype.focus` 是**有意放行**的（注释明说为保壁纸自带编辑框）。所以现有围栏**不足以解释**报告的症状。
- 本机**无法**真机复现（没有出问题的那个壁纸，也没有浏览器自动化）。

**所以 #148 的正确下一步不是"照着报告改代码"，而是"先加观测再收口"**（详见 §3.4）。

---

### #150 全屏穿透 —— 已修（等级 C，远端已 CLOSED，关闭正确）

- 提交 `c04de05`（"③ #150 右栏全屏穿透"）是 `HEAD` 的祖先（`git merge-base --is-ancestor c04de05 HEAD` → 0），并随 `8299ea1` 进入 1.3.1。
- 根因：面板上的 `backdrop-filter` 自建层叠上下文，把宿主的 `--dsh-dockkit-dock-layer`（普通 10 / 全屏 40）关在里头 ⇒ 面板掉到 `z=auto`，被会话层（hero 卡 z=1 / composerSeat z=7）盖掉，**只在全屏时**发生。
- 修法：`src/styles.js:1324` 在 `body[data-sidebar-right-open] [data-sidebar-right-panel]` 上显式 `z-index: var(--dsh-dockkit-dock-layer, 10)`（理由写在 `:1299-1309`）。
- 判据：`test/verify-host-paint-scope.mjs` H4（`:176`、`:218`）→ `npm run verify` 绿。
- **本机无法真机验证**（需要 Windows + 全屏），但"修复在 HEAD 里且守卫绿"是确定的。

---

### #152 新版 WE 安装布局 —— 已修（等级 A）

- `lib/index.js:386-392` 的 `WE_INSTALL_MARKERS` 已含 `wallpaper32.exe` / `wallpaper64.exe` / `join('distribution','wallpaper32.exe')` / `join('distribution','wallpaper64.exe')` / `join('distribution','version.json')`；`:399-404` 的 `isWallpaperEngineRootP(dir)` 逐个 `pathExistsP`；`:426` **返回根目录本身，不再返回 `distribution/`**。
- `node test/verify-we-install-probe.mjs` → **exit 0，20 passed / 0 failed**，其中两条正是本 issue：
  - `✓ B1 distribution/ 布局的安装被认出来（旧判据：installDir=null）`
  - `✓ B2 installDir 保留安装根本身`
- 修它的提交 `bfbc07b` 是 `HEAD` 祖先（→ 0）。
- **本机无 Windows**，但这条判据是纯路径逻辑，测试即为充分证据。

---

### #154 思考行宽度塌 0 —— 已修（等级 A）

- `src/styles.js:3132-3133`：
  ```css
  body[data-we-avatar="on"] [data-we-avatar-row] > :not(.we-avatar),
  body[data-we-avatar="on"] [data-we-avatar-row] > [data-slot] > :not(.we-avatar) { flex: 1 1 auto; min-width: 0; }
  ```
  锚点用的是**通用** `[data-slot]` 而不是写死 `div[data-slot="conversation.chat.node"]`（宿主字面量记在注释 `:3117-3129`）—— 这一点是对的，别再"优化"回写死。
- `node test/verify-scene-live.mjs` → **exit 0，`ALL SCENE-LIVE CHECKS PASSED (503)`**；锚点被 `test/verify-scene-live.mjs:4632` 的 `AV_GROW_RULE` 钉住。
- 提交 `6f5ee84` 是 `HEAD` 祖先（→ 0）。

---

### #156 玻璃面失去底板（四条）—— 全部 CONFIRMED，**未修**（等级 A + B）

这是本次最值得动手的一条。四条子症状各自独立，根因统一为：**插件把宿主的面板底色令牌改成半透明/透明，但没有给"浮在壁纸之上、没有父级底板"的那几类表面补偿**。

**先给准确数字（避免把严重度说过头）**：`--we-readability-floor` = `calc(基础值 × --we-glass-fidelity)`（消费于 `src/styles.js:481`、`:502`）；基础值 `src/styles.js:56` = **0.45**（浅色）、`:57` = **0.59**（深色）；`--we-glass-fidelity` 由 `src/effects.js:321-323` 写入。`--we-glass-alpha` 的曲线在 `src/effects.js:309`：
```js
const glassAlpha = Math.max(0.10, 0.25 - (selection.glassAlpha / 100) * 0.15);
```
⇒ 玻璃透明度滑杆 0 → 0.25、**30 → 0.205**、100 → 0.10。报告者设在 30%，保真度 100% ⇒ 面板令牌 alpha = `0.45 + 0.55 × 0.205` ≈ **0.563**（深色 ≈ 0.674）。**即"半透明"而非"全透明/看不见"**。

**症状① 弹窗没有背景模糊（宿主 Modal）**
- 宿主 CSS：`@deepseek-ai/dsh-client-ui-primitives/lib/Modal.module.css` —— `.root{position:fixed;inset:0;z-index:1000}`、`.mask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}`、`.dialog{…background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent)}` —— **模糊只在 `.mask` 上，`.dialog` 上没有**。
- **关键发现**：宿主 JSX（同包 `lib/index.js` @201593）在调用方**没传 `backdropBlur`** 时，直接给遮罩写**行内**样式：
  ```js
  jsx("div", { style: backdropBlur ? void 0 : { backdropFilter: "none" }, "aria-hidden": "true", onClick: onClose })
  ```
  行内样式胜过任何样式表 ⇒ **只把 `--dsw-mask-blur` 恢复成模糊值是无效的**，补偿规则必须 `!important`（或直接打到 `[aria-hidden="true"]` 这个遮罩元素上）。
- 而 `--dsw-mask-blur:none` 的**唯一**定义处在 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` @71744，选择器是**裸 `body`** ⇒ 我们在 `body[data-we-glass-page]` 上重声明即可胜出（特异度高一级）。
- 稳健结构钩子（宿主自用同一套）：宿主自己的 `const modalSelector = "[role=\"dialog\"][aria-modal=\"true\"], [role=\"menu\"]"`（`lib/index.js` @143223）⇒ `[role="dialog"][aria-modal="true"]` 是宿主自己都在用的稳定锚点。容器式选择器：`:has(> [role="dialog"][aria-modal="true"]) > [aria-hidden="true"]`。
- 另有一处独立的浮层实现（图片灯箱，同包 `lib/index.js` @477193）：`createPortal(… className: css$32.backdrop, role:"dialog", "aria-modal":"true" …)` 内含 `css$32.mask` + `css$32.image` ⇒ 补偿规则要能同时覆盖它。
- 附带发现：宿主**自带**半透明菜单通道 —— `data-menu-material="translucent"`（同包 `lib/index.js:148771`）+ 主题里 `[data-menu-material]{--dsw-menu-backdrop-filter:blur(40px) saturate(150%)}`。但插件管理器 registry 面板**没走**这条（该包 `data-menu-material` 计数 = 0、`backdrop-filter` 0 处）⇒ 症状②的根因是"面板自己不带模糊也不带 `data-menu-material`"，我们的 `background` 覆盖把它唯一的底板也拿掉了。

**症状③ 底部统计行没有底板**
- 宿主 `StatsPills` 自身确实**无底板**（`@deepseek-ai/dsh-client-ui-chat/lib/client.js` @357651）：`.OpZ85W_root{…display:flex}`、`.OpZ85W_anchor{display:inline-flex}`、`.OpZ85W_pill{…background:0 0;border:none…}`，只有 hover 才有 `--dsw-alias-interactive-bg-hover`。
- 它唯一的底板来自**座位**：`@deepseek-ai/dsh-client-ui-conversation/lib/client.js` @587082/@587151
  ```css
  .ST7X_W_root[data-phase=active] .ST7X_W_composerSeat,
  .ST7X_W_embeddedBody[data-content-phase=active] .ST7X_W_composerSeat {
    z-index: 7;
    background: linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px, var(--dsw-alias-bg-base) 36px);
    position: sticky; bottom: 0;
  }
  ```
  而 `--dsw-alias-bg-base` 正是被插件在 `body[data-we-wallpaper]` 上置成 `transparent` 的那个令牌 ⇒ 渐变两端全透明 ⇒ 统计行悬浮。
- **稳定锚点已实测存在**：座位 `"data-composer-seat": ""` + `"data-conversation-region":"composer"`（conversation 包 @620411）、统计行 `"data-composer-stats": true`（chat 包 @358381，两个调用点）、输入卡 `data-composer-card`（另有 `data-composer-input/placeholder/chip/text-ref/composing`）。插件 `src/` 里这些属性 **0 命中**（完全没碰过，所以是新引入的依赖，要进 §5 的棘轮与台账）。

**症状② / ④ 侧栏与代码块吸顶条**
- 代码块宿主结构（`@deepseek-ai/dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css`）：`.block{--dsl-code-block-background:var(--dsw-alias-markdown-code-block);--dsl-code-block-banner-background-color:var(--dsw-alias-markdown-code-block-banner);…}`、`.bannerWrap{position:sticky;top:0;z-index:6;background-color:var(--dsw-alias-bg-base)}`、`.banner{background:var(--dsl-code-block-banner-background-color)}` ⇒ 吸顶条**两层**依赖同时被拿走（`--dsw-alias-bg-base` 置透明 + 插件把 `--dsl-*` 改写成玻璃配方）⇒ 必然穿透。
- 插件侧对应规则：`src/styles.js:836-839`（`[data-chat-flow] .md-code-block` 两个 `--dsl-*` 置 transparent）与 `:840-847`（`[data-code-block-banner]` / `pre` / `pre > code` 一律 `background:transparent!important` + `backdrop-filter:none!important`），`:849-853` 用户气泡内同理。
- 侧栏/面板令牌：浅色 `--dsw-alias-bg-layer-1/2: var(--dsw-static-neutral-bluish-00)`，深色 layer-1 = bluish-875、layer-2 = bluish-850（`@deepseek-ai/dsh-client-ui-theme/lib/client.js` @55087 / @61928）。

**为什么四条同时发生（根因一句话）**：`src/glass.js:46` 挂 `data-we-glass-page`、`:143` 挂 `data-we-glass-chat`（注释 `:136-142` 明说**恒挂**）、`:145` 挂 `data-we-glass-window`；而 `body[data-we-glass-page]` 上的令牌改写是**无条件**的（`src/styles.js:235-333`，layer1/2/3 `:248-256`、bg-overlay `:266-268`、markdown 族 `:308-313`），只在皮肤让位（`src/glass.js:33-39`）与 `clearEffects`（`src/effects.js:480`）两处撤销。**没有任何地方**把 `--dsw-alias-bg-base` 恢复成不透明（`0` 命中）。

**已有兜底为何不足**：`@supports not (backdrop-filter)` 分支（`src/styles.js:1511-1540`）把 layer-1/2/3 + markdown 族钉到 `--we-panel-color`，并把 `--we-readability-floor` 置 0（`:3217`）—— **能力门控**，DSH 支持 `backdrop-filter` 所以不走；`src/styles.js:890-915` 只在 `[data-we-thinking-native]`（opt-in，`src/effects.js:348-350`）内恢复不透明 banner 令牌 ⇒ 默认档不生效。

**⚠️ 修这条的硬约束（会踩红总门）**：`test/verify-client.mjs:235-285` 用**单层**抽块函数（`blockBodyOf` = needle 后第一个 `{` 到其后第一个 `}`）从构建产物里断言：
```js
assert.ok(pageGlassBlock.includes('--dsw-alias-bg-layer-1') && pageGlassBlock.includes('--dsw-alias-markdown-code-block'),
  'page-glass token mapping must sit on body[data-we-glass-page] (glass works without a wallpaper)');
assert.ok(wallpaperBlock.includes('--dsw-alias-bg-base: transparent') && !wallpaperBlock.includes('--dsw-alias-bg-layer-1'),
  'the page-let-the-wallpaper-through block stays wallpaper-only (no glass mapping inside)');
```
另有 `test/verify-readability.mjs:330-379` 的 `surfaceSpecs` 把每个令牌钉到**精确的选择器字符串**，`test/fixtures/harness-ui-surfaces.json` 的 `meta.tokenScope.mapped` 声明这些改写是**有意**的（含 `--dsw-alias-markdown-code-block-banner`，注"原 declined 改判"），`test/compat-harness-pages.mjs` 断言 `isGlassMix(after) && !isGlassMix(before)`。
⇒ **只能"加规则"，不能"移规则/收窄选择器"**：那个 `--dsw-alias-bg-base: transparent` 字面量必须留在**第一个** `body[data-we-wallpaper] {` 块内；在文件**后面**追加第二个 `body[data-we-glass-page] { … }` 块是安全的（单层抽块只看第一个块）。

---

### #157 滚动条观感 —— 真缺口，现存规则只覆盖约 1/3（等级 B + C）

**诉求**：滚动条观感（太粗/太亮/轨道留白/圆角…）。

**现存**：仅 `src/styles.js:826`（`body[data-we-glass-page][data-we-thinking-glass] [data-conversation-scroll]::-webkit-scrollbar-thumb` 用 `--we-capsule-tint-rgb` + `--we-inline-code-alpha`）与 `:829-830` 的 hover/active。全库无 `scrollbar-width`、无裸 `::-webkit-scrollbar`、无 `scrollbar-color`；`scrollbar-gutter:stable` 出现在 `src/styles.js:2200,2470,2640,2689,2776`。⇒ 只有**思考玻璃开启 + 会话滚动区**这一种组合被照顾。

**宿主侧的关键发现（同时也是更正确的修法）**：宿主有一套**全局、令牌驱动**的滚动条体系，在 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` @70565 / @70895：
```css
@supports not selector(::-webkit-scrollbar) { body, body * { scrollbar-width: thin; scrollbar-color: var(--dsh-scrollbar-thumb) transparent } }
::-webkit-scrollbar { width: var(--dsh-scrollbar-width); height: var(--dsh-scrollbar-width) }
::-webkit-scrollbar-track { margin-block: var(--dsh-scrollbar-track-margin); background: 0 0 }
::-webkit-scrollbar-thumb { border: var(--dsh-scrollbar-thumb-border) solid transparent; corner-shape: round; background: var(--dsh-scrollbar-thumb); background-clip: content-box; border-radius: 999px }
::-webkit-scrollbar-thumb:hover { background-color: var(--dsh-scrollbar-thumb-hover) }
::-webkit-scrollbar-corner { background: 0 0 }
```
根级变量：`--dsh-scrollbar-thumb`（默认取 `--dsw-alias-scrollbar-bg-l1/l2`）、`--dsh-scrollbar-thumb-hover`、`--dsh-scrollbar-thumb-border:0px`、`--dsh-scrollbar-track-margin:0px`、`--dsh-scrollbar-width:5px`。

**推论（这条推翻了上一轮的方案）**：DSH 是 Chromium ⇒ `@supports not selector(::-webkit-scrollbar)` 为**假** ⇒ `scrollbar-color` 通道**不生效**，真正生效的是 webkit 那一支。所以：
- ❌ 上一轮 subagent 建议的 `scrollbar-color` 方案在 DSH 里**无效**。
- ✅ 正确修法：在 `body[data-we-glass-page]` 内覆写 `--dsh-scrollbar-thumb` / `--dsh-scrollbar-thumb-hover`（可选 `--dsh-scrollbar-thumb-border`、`--dsh-scrollbar-track-margin`、`--dsh-scrollbar-width`）—— **一处令牌改动覆盖所有滚动容器**（侧栏 / 弹窗 / 设置 / 菜单 / 会话 / 灯箱），零选择器耦合。
- ⚠️ **但有一个必须提前知道的限制**：宿主有**十几处局部重声明** `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` / `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`（agent-preset 的 guidePanel 与 viewerCode、approval、attachment、commands、conversation ×3、cordis、directory-picker-browse、input-trigger、jobs、model-selection、plugin-manager、primitives 的 `Menu.module.css` 与 `HoverCard.module.css`、schedule ×4）。自定义属性按**元素**解析 ⇒ **只挂在 `body` 上覆盖不到那些自带局部值的容器**。
  ⇒ 落地时必须：① 先在 `body[data-we-glass-page]` 声明；② 对上述锚点（至少 `[data-conversation-scroll]`、plugin-manager registry、`Menu`/`HoverCard`）补声明；③ 需要一次**真机核对清单**（本机无法做视觉核对）。
- 保留 `src/styles.js:826` 那条旧规则（它是被 `[data-we-thinking-glass]` 门控的既有行为，别删）。

---

### #158 客户端包重 + 冷扫 1.9 s —— CONFIRMED（性能类，无功能错，等级 A + B）

**(a) 启动路径（机制已由宿主产物确认）**：`package.json:80` 有 `"immediately": true`（同段 `platform:"web"`、`inject:["@deepseek-ai/dsh-client-runtime"]`）。
- **宿主启动序列已确认**：在已装 `app.asar` 上二进制 grep 命中宿主自己的代码
  ```js
  prefetchImmediateTier(){ await Promise.all(this.manifest.plugins.filter(e => e.immediately).map(e => this.modules.prefetch(e.id).catch(n => {}))) };
  // 启动调用点：
  const a = this.prefetchImmediateTier(), u = new Ge; … , await a, await JS({ ctx: u, modules: this.modules, … })
  ```
  ⇒ **挂载前的 `await` 确实会等 immediately 档的传输**（`prefetch → arriveGraphRow → arrive → loadShared`，经 `__ModuleLoader__.load` 注册工厂）。这条不再是"引报告者观察"。
- 已实测产物：`lib/client.js` = **2,332,806 B**；`gzip -9` = **1,013,133 B（43.4%）**；是第二大插件（dshmarket ≈0.72 MB）的 **3.1 倍**。
- 内联 CSS 实测：`const CSS = \`` 起于 `lib/client.js:1350`、止于 `:4562`，**236,310 B（230.8 KB）/ 3,213 行 / 476 条规则块**（gz 63,524 B），由 `ensurePluginCss()`（定义 `lib/client.js:25914`，`tag.textContent = CSS` `:25924`）在**工厂顶层 `lib/client.js:25928` 同步注入**（源码侧即 `src/client.js:5101` 定义、`:5115` 顶层调用；另 `:5375` 再调，卸载按代移除 `:5479-5482`）。
- 该产物自身的 CPU/IO 成本（本机热态）：读 0.4 ms + gunzip 4.7 ms + `vm.Script` 解析 6.9 ms ≈ **12 ms**。
- **未验证**：感知到的启动延迟量级（需要"禁用插件前后各重启一次"的 A/B，报告者与本地都没做）。
- 两条官方口径要说清楚：宿主 `practices.md` 对 `dsh.client.platform/immediately/inject` 明说 **"They change without notice"**（`docs/DSH-UI-INTERFACES.md` §2.4 已录，`:91` 记录这个键），且宿主自带插件文档**没有**给出 `immediately` 的时序语义。
- **⚠️ 隐藏的守卫成本**：`test/verify-package-publish.mjs:229` **断言** `pkg.dsh?.client?.immediately === true` ⇒ 任何"摘掉 immediately"的方案都必须同步改这条断言（否则总门红）。
- `git log -S"immediately" -- package.json` → 只有初始提交 `d34c061`；近 30 个提交全是 docs/i18n/重构 ⇒ **上游没有在做这件事**，不存在"等下一版就好"。
- 报告者 GitHub 账号 `oneincase`（与本仓 fork 同名）2026-10-09 已在 issue 下回复："非常棒的建议，将在下个版本优化"。

**(b) `/inventory` 冷扫**：`lib/inventory.js`（301 行）是修复面。
- `const INVENTORY_TTL_MS = 3000;` 在 **`lib/inventory.js:134`**；`let inventoryCache = null` `:135`；TTL 短路 `:137-139`。
- 一次全量 = `locateWallpaperEngineP()` `:140` → `owningLibrariesP()` `:141` → `enumerateWallpapersAsync(...)` `:142` → `Promise.all(all.map(...))` `:146-192`，**每个条目 3 个并发 fs 探测**：`pathExistsP(w.fileAbs)`、`pathExistsP(w.previewAbs)`、`mtimeOrNullP(w.fileAbs)` `:148-157`（网页条目再加 `mediaOriginBase()` `:160`）；自建存储**再扫一遍**、同样 3 个探测 `:202-245`。
- ⇒ 2588 条目规模下，**每次 TTL 过期 ≈ 5000–7800 次 fs 探测**，而 TTL 只有 3 秒（报告者实测冷 TTFB 1980 ms / 二次冷 1625–1631 ms / TTL 内命中 16–20 ms）。
- **载荷**：`payload` 组装在 `:272-292`（`installDir` / `uploadDir` / `cacheDir` / `weAssetsDir` / `weAssetsAvailable` / `sceneMediaBase` / `total` / `portableCount` / `wallpapers` / `playlists`），报告者实测 1,857,941 B ≈ 718 B/条目。
- **仓库里完全没有响应压缩**：`lib/` 全目录 grep `gzip|content-encoding|Content-Encoding|zlib` **0 命中**（唯一命中在 vendored 的 `lib/webwallgl/assets/renderer-AJkjEL9i.js` 的 MP4 muxer 里）⇒ `/inventory` 的 JSON **未压缩**，加压缩是合法且低风险的杠杆。
- 相关常量：`lib/index.js:524 const SCAN_CHUNK = 24;`（用于 `lib/index.js:551-552` 与 `:2501-2502`）。
- **响应是"等扫完才回"**：路由 `lib/index.js:2925-2941`，其中 `:2931` 就是 `const payload = JSON.stringify(await buildInventory()); res.end(payload)`（另有 `:526 enumerateWallpapersAsync`、`:546-549` 逐条 `await isDirectoryP`、`:551-553` 分块 `readProjectP`）。
- **缓存是纯内存、重启即失**：`lib/inventory.js` 内**没有任何 `writeFile`** ⇒ 索引不落盘；而且是**整批 TTL**，**零"按目录 mtime 失效"**。
- **本机实测（Mac / Node v24.18.0，用字节复制的 `lib/inventory.js` + N=2600 合成目录：2095 video / 500 scene / 5 web）**：冷 **224 / 161 / 135 ms**（enumerate 150–188、探测扇出 18–30、stringify 2–3），TTL 内命中 **0 ms**，TTL 过期后 **167 ms**；载荷 **1,695,383 B = 652 B/条目**。规模：**N=2600 均值 162 ms vs N=5200 均值 282 ms**（目录数 ×2 → 时间 ×1.74）。
- **事件循环**：enumerate 期间最大间隔 **5.1–5.3 ms**（= 5 ms 探测周期，确实在让出）；**13.7–42 ms** 出现在 `lib/inventory.js:146` 那个**无上限**的 `Promise.all(all.map(...))`；全局最坏 42 ms。**没有秒级阻塞**。路径上唯一同步 fs 是 `statSync` `lib/inventory.js:94`（每 scene.pkg 一次）。
- **⚠️ 报告者的绝对耗时不成立**：报告者是 Windows 11，其 1,625 / 1,980 ms 在本机**复现不出来**（本机低约 10 倍）。**可确认的是"冷调用全量重扫"这个机制与随规模增长的趋势，不是那个绝对值。** 另外：报告者的冷调用是否包含冷 OS 文件缓存，也无法确认。

---

### #159 主题跟随 + 分主题玻璃色 —— ①缺陷 CONFIRMED ②能力缺口 CONFIRMED（等级 A + C）

**① 切主题后玻璃底色不跟随（真缺陷）**
`--we-wallpaper-fade-bg` 的解析与缓存：`src/effects.js:48` `let lastFadeBg = ""`；解析器 `:92-100` 读 `getComputedStyle(document.body)` 的 `--dsw-alias-bg-base`，透明则退回 `document.body.hasAttribute("data-ds-dark-theme") ? "#000000" : "#ffffff"`；应用 `:183`；**唯一重算点**是 `:276-279`：
```js
if (!live || !lastFadeBg) lastFadeBg = resolveWallpaperFadeBg();
s.setProperty("--we-wallpaper-fade-bg", lastFadeBg);
```
清除在 `:283`（else 分支）与 `:454`（`clearEffects`）。
⇒ 缓存只在**插件自己的 `applyEffects` 被调用**时失效。而 `src/` 里**唯一**的主题订阅是 `src/theme-follow.js:446 ctx.on("theme/change", …)`，且被 `themeFollowEnabled()` = `selection.themeFollow === true` 门控（默认 `boolFalse`，`src/theme-follow.js:83`）；全库唯一的 `MutationObserver` 在 `src/client.js:536`，只监听 `attributeFilter:["data-dsh-skin"]`。
⇒ **宿主切深浅主题时，缓存不会被失效**。
**爆炸半径**：唯一消费者是 `src/styles.js:96` 的 `.we-layer { background-color: var(--we-wallpaper-fade-bg, transparent) }` —— 那是 z-index −2 的**衬底**，用来给 `backdrop-filter` 提供底色 ⇒ 一个过期变量会**给每一面玻璃上色**。
**复现**：一次性脚本（用真源码的等价转录）4/4 PASS：透明+暗属性→`#000000`；透明+无属性→`#ffffff`；`rgba(0,0,0,0)`+暗→`#000000`；非透明 `#123456`→原样透传。顺带验证了 `weClampSurfaceColor`（未导出，转录）在保真度 1 时的行为：`#0d1524` → 浅 `#e8e9ea` / 深 `#0d1524`；`#ffffff` → 浅 `#ffffff` / 深 `#1c1c1c` —— 与 issue 里那张表逐格吻合。

**② 玻璃色不能分深浅（能力缺口）**
`lib/settings-schema.js:869` `glassColor: { kind: 'hex' }`（标量）；对照 `:918` `themeColors: { kind: 'themeColors' }`，其校验在 `:1002-1014`（`{light, dark}`），开关 `:920` `themeDarkSeparate: { kind: 'boolFalse' }`，UI 在 `src/panel-tabs.js:678` 的 `switchRow(weT("深色单独设置"), …)`；玻璃色板行在 `src/glass-panel.js:322`。全库无 `glassColorDark` / `glassColorLight` / `glassDarkSeparate`。
⇒ 现成可抄的形态就在同一个文件里（`themeColors` 那一套），改动是"镜像一份"，不是新发明。

---

### #160 推广 issue —— invalid（等级 —）

`GithubStarMate` 的推广贴，与本插件无关，远端已 CLOSED，关闭正确。

---

### #161 Tooltip 被 `[class*="_bubble"]` 误伤 —— CONFIRMED（等级 B + C）

**根因（一句话）**：我们的选择器按**类名后缀**匹配 `_bubble`，而 `_bubble` 这个后缀在宿主里**同时属于聊天气泡和宿主 Tooltip**；Tooltip 是 `position:fixed` 且 portal 到 `body`，不在 `[data-chat-flow]` 内，于是被当成聊天气泡刷上半透明底 + 白釉面渐变，近白色文字直接看不清。

**插件侧规则**：`src/styles.js:574-576`（`body[data-we-glass-page][data-we-thinking-glass] [class*="_bubble"] { background-color: var(--we-chat-glass-fill) !important }`）；`:580-581`（`…[data-we-glass-chat][data-we-glass-page] [data-composer-card], …:not([data-we-thinking-native]) [class*="_bubble"]`）与 `:599-604` 的**白色釉面渐变 + `backdrop-filter:blur(var(--we-blur,16px)) saturate(1.8) brightness(1.04) contrast(1.01)`** 同声明。`--we-chat-glass-fill` 定义在 `src/styles.js:560`：`rgba(var(--we-surface-tint-rgb-light,255,255,255), var(--we-glass-alpha,0.15))`。其余同后缀命中：`:574`、`:581`、`:849`（已带 `[data-chat-flow]`）、`:3021`。`src/parallax-layer.js:147` 的注释说明气泡只能靠 `data-chat-*` 认（类名是构建哈希），这正是这类选择器的由来。

**宿主侧实测（本条定案的关键）**：`@deepseek-ai/dsh-client-ui-primitives/lib/Tooltip.module.css`
```css
.bubble { display:inline-flex; align-items:center; gap:8px; position:fixed; z-index:100; width:max-content; max-width:50vw;
          padding:3px 7px; border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-tooltip-bg);
          color:var(--dsw-static-neutral-bluish-00); font-size:13px; line-height:20px; white-space:pre-line;
          overflow-wrap:break-word; pointer-events:none; animation:tooltip-in 150ms var(--ds-ease-in-out) }
.bubble[data-portal] { z-index:1100 }
.bubble[data-pinned] { pointer-events:auto }
.label { min-width:0 }
```
主题里 `--dsw-alias-tooltip-bg` = `--dsw-static-neutral-bluish-850`（暗）/ `bluish-750`，文字 `bluish-00`（写死近白）。源码注释："Anchor-preserving tooltips; an optional body portal escapes clipping containers and stacking contexts that cap the bubble's z-index."
⇒ 类名 `.bubble` 经 CSS Modules 编成 `_bubble_12mhf_1`，**我们的子串选择器必然命中**。

**精确修法（C2）**：宿主那个元素的 JSX 在 `@deepseek-ai/dsh-client-ui-primitives/lib/index.js` @187495：
```js
jsxs("span", { ref: bubble, id: openOnClick ? id : void 0, className: css$16.bubble,
  "data-side": side, "data-portal": portal || void 0, "data-pinned": pinned || void 0, "data-align": align,
  "data-has-shortcut": shortcutKeys?.length ? true : void 0,
  style: { left: pos.x, top: y, visibility: "hidden", … }, role: "tooltip", "aria-label": … })
```
⇒ 元素带 **`role="tooltip"`**。所以把四处命中改成排除式即可：`[class*="_bubble"]:not([role="tooltip"])`。
（宿主另有 `ShortcutKeys` 的 `variant:"tooltip"`，走 `css$12.tooltip`，与 `_bubble` 无关，不受影响。）

**副产物（文档债）**：`docs/DSH-UI-INTERFACES.md` §2.3 记录了 `_bubble` 后缀 ✅ 存在，但**没有记录它同时属于宿主 Tooltip**——这正是本 issue 的根因，台账必须补一行，否则这类误伤会重演。

---

## 3. 总修复计划

分三档。**P0 是"一轮做完、用户可见回归"**；P1 是行为/性能；P2 是功能。

### 3.1 排序总览

| 序 | 项 | 档 | 改动量 | 文件 | 风险 |
|---|---|---|---|---|---|
| 1 | #161 气泡排除式 | P0 | 4 行 | `src/styles.js` | 低 |
| 2 | #156① 弹窗遮罩模糊 | P0 | ~6 行 | `src/styles.js` | 低 |
| 3 | #156③ 输入座位底板 | P0 | ~6 行 | `src/styles.js` | 低 |
| 4 | #156②④ 面板/吸顶条底板 | P0 | ~10 行 | `src/styles.js` | 中（踩 `verify-readability`） |
| 5 | #159① 主题缓存失效 | P0 | ~6 行 | `src/effects.js` | 低 |
| 6 | #157 滚动条令牌接管 | P1 | ~8 行 + 真机清单 | `src/styles.js` | 中 |
| 7 | #148 元素级围栏 + 焦点交还 | P1 | ~40 行 + 测试 | `lib/we-focus-guard.js`、`src/client.js`、`test/verify-scene-live.mjs` | 中 |
| 8 | #158 冷扫与启动开销 | P1 | 中 | `lib/inventory.js`、`src/client.js`、（可选）`package.json` + `test/verify-package-publish.mjs` | 中 |
| 9 | #159② 分主题玻璃色 | P2 | 中 | `lib/settings-schema.js`、`src/glass-panel.js`、i18n | 低 |

### 3.2 P0 —— 玻璃面补偿 + 气泡 + 主题缓存（一轮交付）

**统一原则：只加规则，不动被守卫钉死的选择器。** 全部加在 `src/styles.js` **文件后部的一个新 `body[data-we-glass-page] { … }` 块**（单层抽块只看第一个匹配块，所以安全）。

**P0-1 #161**：把 `src/styles.js:574`、`:581`、`:3021`（以及 `:849` 那条顺带统一）的 `[class*="_bubble"]` 改成 `[class*="_bubble"]:not([role="tooltip"])`。`:849` 已有 `[data-chat-flow]` 作用域，但仍建议统一带上排除式（双保险，且是零成本的语义修正）。
- 判据：`test/verify-glass-surfaces.mjs` 里加/改一条负对照——断言 `[class*="_bubble"]` 的每一处命中都带 `:not([role="tooltip"])`。
- 台账：`docs/DSH-UI-INTERFACES.md` §2.3 补一行"`_bubble` 与宿主 `dsh-client-ui-primitives` 的 Tooltip 共享后缀，必须排除 `role="tooltip"`"。

**P0-2 #156①（弹窗没有模糊）**：
```css
body[data-we-glass-page] { --dsw-mask-blur: blur(var(--we-blur, 16px)); }
/* 宿主在未传 backdropBlur 时给遮罩写行内 backdropFilter:none ⇒ 必须 !important 才能盖过行内 */
body[data-we-glass-page] :has(> [role="dialog"][aria-modal="true"]) > [aria-hidden="true"],
body[data-we-glass-page] [role="dialog"][aria-modal="true"] > [aria-hidden="true"] {
  -webkit-backdrop-filter: blur(var(--we-blur, 16px)) !important;
  backdrop-filter: blur(var(--we-blur, 16px)) !important;
}
```
- `--dsw-mask-blur` 的唯一定义在裸 `body` 上 ⇒ 我们在 `body[data-we-glass-page]` 上声明即胜出。
- 第二条同时覆盖宿主的两种浮层实现（Modal 的 `.mask`、图片灯箱的 `css$32.mask`）。
- ⚠️ 用 `:has()` 前确认目标 Chromium 版本支持（DSH 桌面是现代 Chromium，`@supports` 分支的写法说明宿主自己就在用 `:has`）。
- 判据：`test/verify-readability.mjs` 加一条"遮罩补偿在 `!important` 下存在"；`test/compat-harness-surfaces.mjs` 会因为新引入 `[role="dialog"]`/`[aria-modal]` 而要求它们在 harness 里存在（**实测都在**）。

**P0-3 #156③（统计行无底板）**：在座位上重声明令牌，让宿主自己的渐变取到插件颜色（零布局改动）：
```css
body[data-we-glass-page] [data-composer-seat] { --dsw-alias-bg-base: var(--we-panel-color); }
body[data-we-glass-page] [data-composer-stats] { position: relative; z-index: 1; }
```
- 座位的渐变规则是 (0,3,0)，但**自定义属性按元素解析**，我们直接在元素上重声明就是胜出，不需要比特异度。
- `[data-composer-stats]` 那条只是保险（它自身 `background:0 0`，不需要动）；**不要**给统计行加背景，否则会和宿主 hover 态打架。
- 判据：`test/verify-glass-surfaces.mjs` 的 `anchors` 或 `test/compat-harness-surfaces.mjs` 第③组会自然带上 `data-composer-seat` / `data-composer-stats`（实测宿主里都有）。

**P0-4 #156②④（面板与吸顶条）**：只加"兜底不透明层"，不改现有透明改写。
```css
/* 吸顶条只有宿主自己那一层，插件不给它底板就必然穿透 */
body[data-we-glass-page] [data-chat-flow] .md-code-block > :has(> [data-code-block-banner]) {
  background-color: var(--we-panel-color) !important;
}
/* 面板类浮层（plugin-manager registry 等）在没有父级底板时补一层 */
body[data-we-glass-page] [role="dialog"][aria-modal="true"] { background-color: var(--we-panel-color); }
```
- ⚠️ 这两条**最容易踩红** `test/verify-readability.mjs:330-379` 的 `surfaceSpecs` 与 `test/compat-harness-pages.mjs` 的 `isGlassMix` 断言：落地时必须先跑一次，按报错把选择器改到"新增层"上去，**绝不去改 `pageGlassBlock` 里的既有令牌赋值**。
- 建议这条单独一个提交，方便二分。

**P0-5 #159①（切主题后底色不跟随）**：在 `src/effects.js` 里加一个**只做失效、不做重算**的观察者：
```js
const themeWatch = new MutationObserver(() => { lastFadeBg = ""; });
themeWatch.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
```
- 关键取舍：**只清缓存，不直接调 `applyEffects`** —— 让下一次正常的 `applyEffects` 自行重算，避免和 `src/theme-follow.js` 的主题订阅互相打架（那一条是 `themeFollow` 开关的职责，默认关）。
- 拆除：在 `clearEffects`（`src/effects.js:454` 附近）里 `themeWatch.disconnect()`，并把 `lastFadeBg` 归零。
- 判据：`test/verify-theme-layer.mjs` / `test/verify-client.mjs`（`src/effects.js` 的守卫面）加一条"翻转 `data-ds-dark-theme` 后缓存被清"。

### 3.3 P1 —— 行为与性能

**P1-1 #157 接管宿主滚动条令牌**（推荐，替代逐个伪元素规则）
```css
body[data-we-glass-page] {
  --dsh-scrollbar-thumb: rgba(var(--we-capsule-tint-rgb, 255,255,255), var(--we-inline-code-alpha, 0.10));
  --dsh-scrollbar-thumb-hover: rgba(var(--we-capsule-tint-rgb, 255,255,255), calc(var(--we-inline-code-alpha, 0.10) * 1.6));
  --dsh-scrollbar-thumb-border: 1px;      /* 决定视觉粗细：border-box 内缩 */
  --dsh-scrollbar-track-margin: 2px;
}
/* 宿主有十几处局部重声明，只挂 body 覆盖不到 ⇒ 对已知自带局部值的锚点补声明 */
body[data-we-glass-page] [data-conversation-scroll],
body[data-we-glass-page] [role="dialog"][aria-modal="true"],
body[data-we-glass-page] [role="menu"] { --dsh-scrollbar-thumb: …同上…; }
```
- 保留 `src/styles.js:826-830` 的既有规则（它被 `[data-we-thinking-glass]` 门控，是已发布的既有行为，删了会翻守卫）。
- **必须附一份真机核对清单**：本机无法目视核对；至少覆盖 侧栏 / 会话滚动区 / 设置页 / plugin-manager registry / Menu / HoverCard / 命令面板 / 灯箱。
- ⚠️ `--dsh-*` 令牌**可能不在** `test/compat-harness-surfaces.mjs` 的抽取口径内（它只收 `--dsw-*`）⇒ 要么把抽取正则放宽到 `--dsh-*`，要么在 `docs/DSH-UI-INTERFACES.md` 里单列一条（推荐后者 + 前面放宽都做，因为放宽后棘轮覆盖面更大）。

**P1-2 #148 元素级围栏 + 焦点交还** —— **分两步，先观测后收口**
- **第一步（先观测，独立可发布）**：给 `lib/we-focus-guard.js` 的元素级 `focus` 加**只计数不改行为**的探针（`elCalls` / `elBlocked` 计数 + 最近一次调用点的 `new Error().stack` 头几帧），写进 `window.__weFocusGuard`。宿主侧（`src/client.js`）在 `document` 上挂 `focusin` 监听，记录"焦点从 iframe 进来 / 从宿主离开"的换手序列与时间戳。这样即使本机复现不出报告者的壁纸，下一个报告也能直接给数据。
- **第二步（收口）**：
  1. **手势窗口式元素围栏**：在壁纸文档里记录"最近一次真实交互"（pointerdown/mousedown/keydown，由 shim 合成、`isTrusted===false` 也算），**只在窗口内（如 1000 ms）放行** `element.focus()`，窗口外吞掉并计数。这样壁纸自带编辑框（用户点它）照常工作，而 `setInterval(()=>input.focus(),2000)` 这类**无手势**的周期性夺焦被拦。
  2. **宿主侧焦点交还**：在 `src/client.js` 记录宿主最后一个获得焦点的可编辑元素；当 `focusin` 显示焦点落进壁纸 iframe 且**不是**由真实用户手势触发时，把焦点交还回去。
- ⚠️ **会翻现有绿断言**：`test/verify-scene-live.mjs:1952` 的注释与 ①–⑥ 六条断言建立在"元素级 focus 放行"之上（`:1969-1973` 等）。改行为必须**同时改这些断言并保留负对照**（`docs/README.md` §29-32 的口径：判据归 `test/`）。这是本计划里唯一一处"要改既有守卫"的地方，必须单独一个提交 + 说明理由。
- 文档漂移顺手修：`lib/we-focus-guard.js` 文件头与 `CHANGELOG.md` 都把注入点写成 `lib/index.js`，实现里是 `lib/serve.js`（`:460` 门控、`:485` 注入）。

**P1-3 #158 冷扫与启动开销** —— 分两半，互不依赖。**先看一个反直觉的实测结论**：本机跑出来**没有秒级阻塞**（事件循环最坏 42 ms），报告者的 1.6–2.0 s 是"冷调用要等整轮扫描"的**总延迟**，不是卡死。所以修复目标是**减少"必须等"的量**，不是"消除卡顿"。
- **(b) `/inventory`（优先，风险低、收益确定）**：四档，按代价从小到大
  1. **响应压缩**：`lib/` 全目录 grep `gzip|content-encoding|zlib` **0 命中** ⇒ 1.86 MB 的 JSON 目前裸传；加 `Accept-Encoding` 协商（gzip/brotli）是最低风险的一刀，预期载荷降一个数量级（参照内联 CSS 的 gzip 比 ≈ 3.7×）。
  2. **落盘索引 + stale-while-revalidate**（**主修**，对应上游最可能的做法）：把 3 秒整批 TTL 换成 `cacheBaseDir` 下的**磁盘索引**，键为「项目目录 mtimeMs + size」；命中就**立刻回旧载荷**、后台重扫，变了才替换。这同时解决"**重启即失**"（现在纯内存、无 `writeFile`）与"改了 1 个壁纸也要重扫 2600 个"。
  3. **逐条目探测记忆化**：把 `pathExistsP` / `mtimeOrNullP` 的结果随索引一起缓存，使重扫只重探**变了**的条目（现状每轮 TTL 过期 ≈5000–7800 次 fs 探测全量重来，`lib/inventory.js:146-192`）。
  4. **TTL 拉长 / 载荷瘦身**（省略空字段）——收益最小，可与 2、3 合并。
  - 顺带一个可做的小改进：`lib/inventory.js:146` 那个**无上限**的 `Promise.all(all.map(...))` 是全路径唯一的高延迟点（13.7–42 ms），按 `SCAN_CHUNK = 24` 的同一纪律分块即可拉平。
- **(a) 启动路径**：两个方案互斥，且**都必须改一条既有断言**（`test/verify-package-publish.mjs:229` 断言 `immediately === true`）。
  1. **最小改动（保守，推荐先做）**：保留 `immediately`，把 230.8 KB / 476 条内联 CSS 从**工厂顶层同步注入**（`src/client.js:5115`）拆成"关键子集同步 + 余量在首帧后（`requestAnimationFrame` / `requestIdleCallback`）注入"。产物热态解析成本只有 ≈12 ms，所以 CSS 那一刀的真实收益主要是**首帧的样式计算**而不是解析 —— 需要真机核对"不闪"。
  2. **摘 `immediately`**：产物离开"挂载前 `await`"的路径，改为打开壁纸 UI 时加载。代价是**槽贡献（侧栏 / 设置页）会晚出现**，可能闪一下；且要同步改上面那条断言。**需要真机 A/B 才能拍板**（禁用插件前后各重启一次，测到首帧/可交互时间），本机给不出这个数。
- 判据：`lib/inventory.js` 的守卫是 `test/verify-scene-live.mjs` + `test/verify-types.mjs`（见 `docs/GUARD-MAP.md`）；另**必须新增**守卫，否则这几条优化会静默退化：
  - ① 断言响应压缩开启（有 `Accept-Encoding: gzip` 时响应带 `Content-Encoding`）；
  - ② 断言 `/inventory` 在**强制重扫完成前**就能应答（stale-while-revalidate），且磁盘索引文件存在；
  - ③ 断言**只**把一个项目目录的 mtime 改动 ⇒ 只有那一条条目的探测被重做（负对照：其余条目命中记忆化）。

### 3.4 P2 —— 功能

**P2-1 #159② 分主题玻璃色**：镜像 `themeColors` 那一套（`lib/settings-schema.js:918` + 校验 `:1002-1014` + 开关 `:920` + UI `src/panel-tabs.js:678` 的 `switchRow` 形态 + 色板 `src/glass-panel.js:322`），再加必要的 i18n 键（`test/verify-i18n.mjs` 会强制补齐）。设 `glassColor: {light, dark}` + `glassDarkSeparate: boolFalse` 是与既有形态一致的方案，优于新增两个独立 hex 字段。
- 迁移：老配置是标量 hex ⇒ 需要一次性升级逻辑（`lib/settings-schema.js` 的迁移段）；这一步**必须有守卫**，否则老用户配置会静默变白。

### 3.5 不要做的事

- **不要**"修 #156 就把 `body[data-we-glass-page]` 里的令牌改写搬走/收窄" —— `test/verify-client.mjs:235-285`、`test/verify-readability.mjs:330-379`、`test/fixtures/harness-ui-surfaces.json` 的 `meta.tokenScope.mapped` 三处会红，且 `meta` 里明确写了这是**有意**的（让玻璃在没有壁纸时也成立）。
- **不要**给 #157 用 `scrollbar-color`（DSH 是 Chromium，那条 `@supports` 分支为假，纯属无效改动）。
- **不要**为了 #148 把元素级 `focus` 一刀切掉 —— 会毁掉壁纸自带的编辑框（注释里写明了）。要按"有无用户手势"区分。
- **不要**动 `[data-slot]` 那条 #154 的通用锚点（写死具体 slot 值会随宿主槽注册表漂）。

---

## 4. 验收与不变量（每次改动都要过）

**交付门（唯一权威）**：
```
npm run verify:all      # = build → verify(35) → verify:docs(4) → smoke(6)
```
必须 **exit 0**。

**四条机械约束**：

1. **改 `src/` 必须重建产物**：`npm run build`（`node scripts/build-client.mjs`）。`test/verify-client-sync.mjs` 是 `verify` 的第一步，产物不同步会直接红。
2. **加/删源模块后重算守卫地图**：`node test/tools/guard-targets.mjs --write`，`test/verify-guard-map.mjs` 逐字比对（`docs/GUARD-MAP.md` 是生成物，**勿手改**）。本次预计新增/改动 `src/styles.js`、`src/effects.js`、`lib/we-focus-guard.js`、`lib/inventory.js`、`lib/settings-schema.js`。
3. **新引入的宿主锚点会进接口棘轮**：`test/compat-harness-surfaces.mjs` 第③组从**我们自己源码**抽 `--dsw-*` 令牌 / `[data-*]` 属性 / `[class*="_x"]` 后缀 / `data-slot` 取值，逐条在已装 harness 里找。本次新引入的 `[data-composer-seat]`、`[data-composer-stats]`、`[role="tooltip"]`、`[role="dialog"]`、`[aria-modal]` **实测宿主里都在**（不会因"不存在"变红）；但 `--dsh-scrollbar-*` 属 `--dsh-*`，**可能不在抽取口径内** ⇒ 需明确决定"放宽抽取正则"还是"只在 `docs/DSH-UI-INTERFACES.md` 记一条"。
4. **`docs/DSH-UI-INTERFACES.md` 是台账，改动宿主依赖就要同步**：本次至少两处 —— §2.3 补 `_bubble` 与宿主 Tooltip 共享后缀（#161 根因）；§2.2/§2.3 补 `[data-composer-seat]` / `[data-composer-stats]` / `[role="dialog"][aria-modal="true"]` / `--dsh-scrollbar-*`（#156/#157 的新依赖）。

**判据归属**（照 `docs/README.md` §29-32 的口径）：机制 → 实现文件头注释；判据 → `test/`；取舍 → `adr/`。本次有两处值得一条 ADR：
- #156：「宿主面板令牌改写是**无条件**的，补偿必须由插件显式给出」——为什么不做"按表面白名单改写"。
- #148：「元素级 focus 围栏按用户手势窗口放行」——为什么不做一刀切。

---

## 5. 建议的提交切分

| 提交 | 内容 | 可独立回滚 |
|---|---|---|
| `C1` | #161 气泡排除式 + 台账补行 | ✅ 纯 CSS |
| `C2` | #156① 遮罩模糊补偿（`!important`） | ✅ |
| `C3` | #156③ 输入座位底板 | ✅ |
| `C4` | #156②④ 面板/吸顶条兜底层 | ✅ 单独提交便于二分 |
| `C5` | #159① 主题缓存失效 | ✅ |
| `C6` | #157 滚动条令牌 + 真机清单 | ✅ |
| `C7` | #159② 分主题玻璃色（含迁移 + 守卫） | ✅ |
| `C8` | #158(b) inventory 响应压缩 | ✅ |
| `C9` | #158(b) 落盘索引 + stale-while-revalidate + 探测记忆化（+ 三叉守卫） | ✅ |
| `C10` | #158(a) CSS 注入分帧（保留 `immediately`） | ✅ |
| `C13` | #158(a) 摘 `immediately`（**可选**，需真机 A/B + 改 `verify-package-publish.mjs:229`） | ✅ |
| `C11` | #148 第一步：观测探针（不改行为） | ✅ |
| `C12` | #148 第二步：手势窗口围栏 + 焦点交还（**含改既有守卫**） | ✅ |

`C1–C5` 建议合成一个版本（用户可见回归最集中）；`C11` 可以先于 `C12` 单独发布。

---

## 6. P0 实施记录（C1–C5 已落盘）

改动文件：`src/styles.js`、`src/effects.js`、`test/verify-readability.mjs`、`test/verify-glass-surfaces.mjs`、`test/verify-client.mjs`、`docs/DSH-UI-INTERFACES.md`（`lib/client.js` 是重建的产物）。

| 项 | 落点 | 判据 |
|---|---|---|
| C1 #161 | 四条 `[class*="_bubble"]` 规则（fill 接管 / 恒挂霜釉 / 气泡内代码块 / fallback 摘霜）统一加 `:not([role="tooltip"])` | `verify-readability` F2dN（下界 4 条 + 每条带排除式或 chat-flow 作用域） |
| C2 #156① | `body[data-we-glass-page]` 令牌块重声明 `--dsw-mask-blur`（宿主 `.mask{backdrop-filter:var(--dsw-mask-blur)}`；主题只在裸 `body` 上写 `none`） | 现有令牌层判据（不新增锚点） |
| C3 #156③ | 两个令牌块各加 `--we-composer-seat-fill`（走**全局** `--we-readability-base`/`--we-readability-floor`，避开 `chatBaseUses === 4`）+ 座位 `background-image` 规则（只给底色、不给霜） | `verify-readability` / `verify-glass-surfaces`（该规则体不匹配 `isGlassCarrier` ⇒ 不是玻璃面，无需登记） |
| C4a #156② | `[data-install-registry]` 霜 + 同一锚点的无模糊内核孪生；`SURFACES` 的 `glass-child-floaters` 行补认领 | `verify-glass-surfaces`（未登记锚点会被第②组抓出） |
| C4b #156④ | `.md-code-block > :has(> [data-code-block-banner])` 在**既有清底规则之后**重铺底板（+ 深色 / 无模糊内核孪生） | `verify-readability` F2e（作用域与门控）+ 接口棘轮（该锚点已在册） |
| C5 #159① | `src/effects.js`：`armFadeBgThemeWatch()` / `disarmFadeBgThemeWatch()`（MutationObserver 只认 `data-ds-dark-theme`、幂等、无 `MutationObserver` 时静默退化），在 `wallpaperOpacity > 0` 分支挂、归零分支与 `clearEffects` 断 | `verify-client` 行为判据（真 `src/effects.js` + `with(__scope)` 挂载台）：冷启动 `#ffffff` → 属性翻转但不派发仍 `#ffffff`（负对照）→ 派发后 `#000000` → `clearEffects` 已断开 |

**实施中推翻/修正的两条 recon 结论**（都已在代码注释里写明理由）：

1. **R-4「重铺 `--dsw-alias-markdown-code-block-banner`」不成立**：真正的 sticky 载体是**外层 `.bannerWrap`**，其底板读 `--dsw-alias-bg-base`（被插件置成 `transparent`），且既有清底规则对同一载体写了 `background: transparent !important` ⇒ 改内层令牌铺不出板。修法改成对 `.bannerWrap` 直接重铺 `background-color` + 霜（同特异度、同 `!important`、后写胜）。
2. **`--we-floaters-blur` 不许带内层兜底**：写 `var(--we-floaters-blur, var(--we-blur, 16px))` 会撞 `verify-glass-surfaces` 的「零兜底（消费族）」判据（`glass.js` 无条件写这个令牌）⇒ 用裸 `var(--we-floaters-blur)`。

**踩红记录（都已修）**：`src/styles.js` 的 CSS 注释里出现 markdown 反引号 ⇒ 构建报 `[build-client] 产物语法错误：Unexpected identifier 'background'`（模板字面量被截断，`verify-host-paint-scope` H0 有同名判据）；同一处注释里的 `{…}` 花括号也一并去掉（避免按"第一个 `{` 到第一个 `}`"切规则体的解析器误判）。

**门禁**：`npm run verify`（35 脚本）、`npm run verify:docs`、`npm run smoke` 全部 exit 0；C5 的新判据做过变异验证（把 `armFadeBgThemeWatch()` 调用删掉 ⇒ `verify-client` 立刻红，随后按字节还原）。

**未做**：C6 及之后的 P1/P2；本轮改动**尚未提交**（按 §5 的切分，`C1–C5` 合成一个提交）。

---

## 7. P1 实施记录（C6 + C11/C12 已落盘）

改动文件：`src/styles.js`、`src/effects.js`（P0 遗留）、`src/focus-handback.js`（**新增**）、`lib/we-focus-guard.js`、`src/client.js`、`scripts/build-client.mjs`、`test/verify-glass-surfaces.mjs`、`test/verify-scene-live.mjs`、`test/verify-client.mjs`、`docs/GUARD-MAP.md`（`node test/tools/guard-targets.mjs --write` 重算）、`lib/client.js`（重建产物）。

| 项 | 落点 | 判据 |
|---|---|---|
| C6 #157 | `body[data-we-glass-page]` 与深色孪生块各追加 4 条 `--dsw-alias-scrollbar-{bg,hover}-l{1,2}` 重声明，值 = `color-mix(in srgb, var(--we-surface-tint-light\|dark) 40%, var(--dsw-static-neutral-XXX) 60%)` | `verify-glass-surfaces` 新增第 ⑮ 组（4 令牌 × 2 主题块 = 8 条都要"存在 + 是 `color-mix(` + 掺了玻璃底色"，附三形态负对照） |
| C11+C12 #148 | ① `lib/we-focus-guard.js` 注入体新增**元素级**围栏：`HTMLElement.prototype.focus` 只在"最近一次真实交互"的 `gestureWindowMs`（默认 1000 ms）窗口内放行，窗口外吞掉并记 `elCalls/elAllowed/elBlocked/elLastBlockedAt/elLastBlockedStack`；② 新模块 `src/focus-handback.js` 在**宿主文档**里把被搬走的焦点交还（`focusout` 来自记住的元素 + `document.activeElement` 是 `iframe.we-iframe` + 最近 1000 ms 无真实手势，另加 `STALE_MS`/`MIN_GAP_MS` 两道保险）；③ `scripts/build-client.mjs` 登记新模块，`src/client.js` 的 2e 段挂 `ctx.effect` | `verify-scene-live` 第 ⑦–⑨ 组（元素级两侧 + 两个负对照 + 装不上时的退化）；`verify-client` 宿主半行为判据（真 `src/focus-handback.js` + `with(__scope)` 挂载台，三条判据各配负对照、两道保险各配阳性对照、拆除/幂等/环境能力） |

**设计决定与理由**（都写进了源码注释）：

1. **帧级与元素级分开对待**：帧级继续无条件吞掉（壁纸拿不到任何键盘，帧级焦点对它毫无用处）；元素级必须留"用户手势窗口"——壁纸层是 `pointer-events:none`，用户真去点壁纸时 shim 会**合成** pointer/mouse（`isTrusted === false`，但确实是用户的手），作者页的编辑框靠这次点击拿焦点是正当行为。一刀切掉元素级 focus 会毁掉壁纸自带编辑框（§3.5 明列"不要做"）。
2. **宿主半不能省**：`lib/we-focus-guard.js` 住在壁纸文档里，改不了跨源 WindowProxy 上的 `top.focus()`/`parent.focus()`，也拦不住不经过 JS 的内部聚焦路径（`autofocus`、`dialog.showModal()`、`label` 转发）。所以补一个住在宿主文档里的"搬回来"机制，两侧共用同一个 1000 ms 手势窗口。
3. **C11 未单独发布，与 C12 合并**：审计原计划第一步是"只计数不改行为"的观测探针，但那套计数现在**就长在围栏里**（`elCalls/elBlocked/elAllowed/elLastBlockedStack` + `window.__weFocusGuard`，宿主侧另有 `window.__weFocusHandback.{handbacks,skipped}`）——先发一个"只观测"的版本等于同一个行为面发两遍，而真机诊断能力并不少。单独发布的价值要看作者页是否复现，而本机没有那个壁纸 ⇒ 合并发布、把诊断留给控制台。

**与审计原方案的偏离（两条）**：

- **#157 不再逐锚点补 `--dsh-scrollbar-thumb`**：宿主 ~17 处局部重声明写的都是 `var(--dsw-alias-scrollbar-bg-l2)` 这层**间接**，自定义属性按**元素**解析 ⇒ 在 `body` 上换掉底层 4 个 `--dsw-*` 令牌即可一处覆盖全应用，零锚点耦合。原方案（覆写 `--dsh-scrollbar-thumb` + 逐个补锚点）随之作废。也不动 `--dsh-scrollbar-width/-thumb-border/-track-margin`（几何不碰）。
- **`docs/CHANGELOG.md` / `docs/en/CHANGELOG.md` 里的"由 `lib/index.js` 注入"不改**：`docs/README.md` 把 CHANGELOG 当账本（原文保持原样、不入常青面同步），且那句话写作时 `lib/index.js` 确实是注入点（路由拆分是同一开发周期内后来的事）⇒ 只改 `lib/we-focus-guard.js` 文件头这一处漂移。

**踩红记录（都已修）**：

1. **`src/focus-handback.js` 必须在"宿主 DOM 能力不全"时安静退场**：首版只判 `typeof document === "undefined"`，而 `test/verify-transcode-state.mjs` 的挂载台给的是 stub `document`（只有 `body`/`style`，没有 `addEventListener`）⇒ `TypeError: document.addEventListener is not a function` 直接把那条守卫打断（`ctx.effect` 里抛会中断整条 `apply`）。修法：能力检查四个方法，缺一个就 `return null`；`verify-client` 补一条同形态判据（stub document ⇒ 返回 null、不抛、不留半个监听器）。
2. **`verify-client` 的宿主半判据首版是"假绿"**：交还频率下限是 300 ms，而整个块跑完远不到 300 ms ⇒ 第一条"记住项过期不交还"的断言其实是被 `MIN_GAP_MS` 拦下的（看着绿、测的不是那条），而紧接着的阳性对照直接红了。修法：该步之前先真睡 320 ms，并在阳性对照之后再补一条"睡够 320 ms 必须恢复交还"的负对照。**教训：带时间下限的判据必须让前置间隔明确，否则绿得没有意义。**

**门禁**：`npm run build`、`npm run verify`（35 脚本）、`npm run verify:docs`（含重算后的 `docs/GUARD-MAP.md`）、`npm run smoke` 全部 exit 0。变异验证：元素级围栏删掉手势判定/落点判定 ⇒ `verify-scene-live` 对应判据红；宿主半摘掉手势判定/落点判定 ⇒ `verify-client` 对应判据红。

**未做**：P1-3（#158 的 C8/C9/C10）与 P2；`C6` 与 `C11+C12` 均**尚未提交**（建议 `C6` 单独一个提交、`C11+C12` 合成一个，理由见上）。

---

## 8. P1-3 实施记录（C9 已落盘；C8 / C10 推迟，理由在下）

改动文件：`lib/index.js`（新增 `scanRootsP` / `scanSignatureP`，`enumerateWallpapersAsync` 复用前者、条目上多一个 `dirAbs`）、`lib/inventory.js`（三级缓存重写）、`test/verify-types.mjs`（`INVENTORY_FUNCS` 加 `assembleInventory`）、**新增** `test/verify-inventory-index.mjs`（20 条判据）、`package.json`（verify 链插入新守卫）、`docs/GUARD-MAP.md` + `docs/ROUTE-INDEX.md`（生成物重算）、`docs/CODE-STRUCTURE.md`（派生缓存那条注记改写）。

### C9 —— 扫描索引（(b)②③）

机制：`cacheBaseDir()` 下 `inventory-index.json`（`INDEX_VERSION` + `sig` + `builtAt` + 扫描原料 `we` + 逐条目探测记忆 `probes`）。**签名** = `sha1(版本 + installDir + 排序后的 libraryDirs + 各扫描根的 `mtimeMs:size`)`，`locateWallpaperEngineP`/`owningLibrariesP` 复用既有 60 s TTL 缓存 ⇒ 十几格 `stat`。

四条纪律：

1. **索引里存扫描原料，不存载荷**。载荷里的 `media`/`preview`/`frameUrl` 都是 `tokenFor()` 的产物（绝对路径的 base64url），而 `mediaMap` 是**进程内**的 ⇒ 回放旧载荷会让重启后每个 URL 都 404。回放时照常走 `assembleInventory` 重组：token 重新铸造、`mediaMap` 重播，字段形状也仍只有一处实现。
2. **签名命中 ⇒ 零 fs**（含零 `stat`）：直接复用整张探测记忆表重组。
3. **签名对不上 ⇒ 不等待**这一条**不成立**，且是有意为之：签名对不上等于**库本身**变了（换 Steam 根、增删项目目录），回旧载荷就是把上一个库的清单端给用户 —— `test/verify-we-install-probe.mjs` 的四个夹具共用一个 `cacheDir`，B6/B8 正是这么红的。所以签名对不上与冷启动都**等这一次重扫**，并发请求共用同一次在途扫描（`rescanOnce`）。**stale-while-revalidate 只服务"签名没变、内容可能变了"**（索引老过 `INVENTORY_REVALIDATE_MS`）：本次照旧应答、后台重扫。
4. **逐条目失效键 = 项目目录 mtime**（`enumerateWallpapersAsync` 新给的 `dirAbs`）：重扫时逐条 `stat` 一次目录，只有目录 mtime 变了的条目才重探 —— "库里新增一张壁纸"只探测新的那一条。索引里已不在库里的条目会被丢掉（不随删除无限长）；索引损坏 / 版本不符 ⇒ 当成没有索引，退回冷启动，绝不抛。

判据（`test/verify-inventory-index.mjs`，计数桩驱动真 `createInventoryBuilder`；每个 case 新建 builder ≡ 宿主重启，因此不必 sleep 过内存 TTL）：

| 组 | 判据 |
|---|---|
| ① 冷启动 | 2 条 ⇒ 4 次存在性探测；索引落盘；索引里只有扫描原料（无载荷字段、无任何 token）；带 `sig`/`builtAt` |
| ② 重启、库没动 | **存在性探测 0 次、`stat` 0 次**；载荷与冷启动逐字一致 |
| ③ 库新增一条 | 只探测新增的那一条（`exists = 2`）；重扫时逐条核对目录 mtime（`stat = 3`） |
| ④ 只有一个项目目录变了（负对照） | 变了的 + 新增的被重探，其余命中记忆（证明记忆**按条目**失效，不是整表作废） |
| ⑤ 索引容错 | 坏 JSON / 老版本 ⇒ 不抛、退回冷启动全部重探 |
| ⑥ 索引 GC | 删掉的项目从 `probes` 与 `we` 里都消失 |

变异验证：把 `revalidate` 支改成"直接复用"⇒ 判据 ④ 立刻红（19/1）。

- 与审计的偏离：审计的三条新守卫里，②"`/inventory` 在**强制重扫完成前**就能应答且磁盘索引存在"被改成"**签名命中时零 I/O** 应答 + 磁盘索引存在"（理由见上第 3 条）；③保持原口径（已实现为第 ④ 组）。
- 净效果（相对改前）：改前是"TTL 一过（3 s）就整轮全扫 + 重启即失"；改后**重启后库没变 ⇒ 零 I/O 即时**，会话内最多每 30 s 后台复核一次，库变了的那一次与改前同样是**一次**同步全扫（无回归）。

### C8（响应压缩）推迟 —— 有实测依据

本机合成 2600 条载荷（1,570,693 B）：`identity` 端到端 6.8 ms / `gzip-6` 11.1 ms（线宽 101,682 B，15.4×）/ `gzip-1` 8.4 ms / `brotli-4` 9.1 ms（78,799 B，19.9×）。**回环上压缩净亏时间**（1.23×–1.64×），而压缩发生在扫描**之后**、不影响 TTFB，而 #158 的症状是**冷 TTFB**。⇒ 收益集中在"少扫"（C9 已做），压缩留到有真机远程/慢链路证据时再开（届时 `test/verify-json-response.mjs` 的 `isPureJsonBody` 口径与 `CALL_SITE_FLOOR` 都要一并考虑）。

### C10（启动路径 / (a)）推迟 —— 需要真机 A/B，且本地可测的部分收益很小

- 产物自身成本实测：读 0.4 ms + gunzip 4.7 ms + `vm.Script` 解析 6.9 ms ≈ **12 ms**；内联 CSS 236 KB / 476 条规则由 `ensurePluginCss()` 在工厂顶层同步注入。**收益在首帧样式计算**，不在解析。
- 拆"关键子集同步 + 余量首帧后注入"的**风险不对称**：样式表插入会触发全文档重算，插入得晚一帧就是"玻璃晚一帧出现"的**可见**闪动，而收益只有那 12 ms 与一次重算的差值。这需要真机（至少是能看到首帧的浏览器）A/B 才能判断，本地跑不出来。
- 因此本轮**不动** `immediately`（也不动 `test/verify-package-publish.mjs` 的 `immediately === true` 断言）。要做的话，验收口径应当是：① `window.__weCssGen`（或等价物）在首帧前已就绪、② 余量在 `requestAnimationFrame`/`requestIdleCallback` 后落地且**无可见闪动**（录屏或帧比对）、③ 摘 `immediately` 的那条路必须同改 `test/verify-package-publish.mjs`。

**门禁**：`npm run verify`（现 36 条脚本，新增 `verify-inventory-index`）与 `npm run verify:docs` exit 0（生成物 `docs/GUARD-MAP.md`（模块 83 / 守卫 53）、`docs/ROUTE-INDEX.md` 已重算）。**未提交**。

---

## 9. P2 实施记录（C7 已落盘）

改动文件：`lib/settings-schema.js`、`src/effects.js`、`src/glass.js`、`src/glass-panel.js`、`src/client.js`、`src/quick-panel.js`、`src/i18n-copy.js`、`test/verify-client.mjs`、`test/verify-glass-surfaces.mjs`、`test/verify-presets.mjs`、`test/verify-scene-live.mjs`、`test/fixtures/settings-sanitize-golden.json`（重录）、`docs/ROUTE-INDEX.md`（生成物重算）、`lib/client.js`（重建产物）。

| 项 | 落点 | 判据 |
|---|---|---|
| C7 #159② 数据形态 | `glassColor` 由标量 hex 改为 `{light, dark}`（`KINDS.glassColor.kind = 'glassColors'`、`DEFAULTS.glassColor = GLASS_COLOR_DEFAULTS`）；新增 `glassDarkSeparate: boolFalse`；`SETTINGS_VERSION` 5 → **6** | `verify-client` ③ 夹具（逐键快照）+ ③b 形状判据（标量/显式一对/半对/坏侧/双非法/非字符串/带空白/默认） |
| C7 #159② 归一 | 新增 `readGlassColors(raw)`：**永远**返回完整一对、永不抛；字符串合法 hex ⇒ 两侧同值；对象 ⇒ 坏侧由好侧补齐 | 同上（含"当前版本号的档 + 标量"那条 = 读容忍的真实入口） |
| C7 #159② 迁移 | `migrateSettings` 末尾加 v5→v6 一步：`typeof out.glassColor === 'string'` ⇒ 两侧同值 | `verify-client` ③c **结构棘轮**（行为不可观测，理由见下）+ 两条负对照 |
| C7 #159② 取色 | `src/effects.js` 新增模块级 `glassColorOf(selection, theme)`（字符串原样、对象取本主题侧、缺则借另一侧、都没有回 `""` 让 `weClampSurfaceColor` 按主题兜底）；`--we-surface-tint-{light,dark}` 与 `-rgb-{light,dark}` 四条各取自己那一半；`--we-glass-color` 仍是**浅色**标量 | `verify-glass-surfaces` ⑫b：全局两侧各自只随自己那一半变（因果判据）+ rgb 对都写出且不等 + `--we-glass-color === light` |
| C7 #159② 对话栏 | `src/glass.js` 的对话栏底色按主题各取一半 | `verify-glass-surfaces` ⑫b：对话栏（跟随全局档）同样因果判据 + rgb 分开 |
| C7 #159② 侧栏 | **有意不分主题**：`src/glass.js` 只取浅色那一侧 | `verify-glass-surfaces` ⑫b 显式钉住（写成"分主题的例外"，免得被当成漏做） |
| C7 #159② 面板 | `src/glass-panel.js`：`panelGlassPair(sel)`（自带归一，见踩红 1）+ `panelThemeIsDark()`；新增 `switchRow("深色单独设置")`，浅色行 + 开关开着才出现的深色行；侧栏档只有一个色板，写当前主题那一侧（所见即所改） | `verify-client` 面板行为守卫（默认关 ⇒ 深色行不存在；开 ⇒ 6 色板；点浅色不改深色、点深色不改浅色；关开关 ⇒ 深色行消失且再开时已收敛）；`verify-scene-live` 三档页签标签序列 |
| C7 #159② i18n / 快捷面板 | 新增 `"玻璃颜色 · 深色"` 词条（复用既有 `"深色单独设置"` 与 tooltip 文案）；`src/quick-panel.js` 的 `QP_CTX_SETTINGS_ONLY` 加 `onGlassDarkSeparate`（开关与深色行只在设置页） | `verify-i18n`（新词条双向对账） |

**设计决定与理由**（都写进了源码注释）：

1. **`{light, dark}` 一对 + 一个布尔开关，而不是两个独立 hex 字段**：镜像 `themeColors`/`themeDarkSeparate` 那一套 —— 一块数据一处真源，且"出厂就是一个颜色管两套"这件事由**开关默认关 + 两侧同值**同时表达，老档迁移进来观感逐位不变。
2. **读容忍与迁移是两层，不是二选一**：删读容忍 ⇒ 出厂预设正文（`lib/glass-presets/*.json` 是标量 + 盖当前版本号，**不过迁移段**）与手改档立刻变白釉；删迁移 ⇒ 旧档永久停在标量形态。注意两者的可观测性**不对等**：读容忍有行为入口（带当前版本号的档），迁移没有（读出口两者逐字节等价）⇒ 迁移只能钉存在性。
3. **侧栏不做深浅分离**：`--we-sidebar-color` 是写在 `body` 上的行内样式，压不过样式表里的重声明；且它的消费者没有 `data-ds-dark-theme` 孪生。这是取舍不是漏做，判据里显式钉住。
4. **开关关着时内部仍存两套值**：开关只决定深色那一行露不露；关掉的瞬间把两侧收敛到浅色那一侧，这样"关掉再打开"不会跳回上一个深色值（判据覆盖）。
5. **面板的归一必须自带**（`panelGlassPair`）：`test/verify-scene-live.mjs` 把 `src/glass-panel.js` 当**真模块 import**，作用域里只有全局替身 ⇒ 引用 `client.js`/`effects.js` 的兄弟绑定就是渲染期 `ReferenceError`（踩红 1）。
6. **`readGlassColors` 只 trim、不小写**：沿用既有 hex 校验口径（`HEX_RE` 大小写都收），判据不写"输出必小写"这种假断言。

**踩红记录（都已修）**：

1. `verify-scene-live` 渲染期报 `appearance: glassColorPairOf is not defined`：面板文件先引用了 `src/client.js` 里的助手（模块间绑定在"真模块 import"台架里不存在）⇒ 改成文件内自带的 `panelGlassPair`。
2. `verify-client` 面板判据首版直接 `SyntaxError: Identifier 'findSwatch' has already been declared`（同一作用域后方已有同名助手）⇒ 改名 `findGlassSwatch`。
3. **golden 夹具 18 个用例漂移**：真因不是玻璃色，而是 `settingsVersion: got=6 want=5`（用例输入**不带**版本号 ⇒ 迁移本来就会跑，本次多出的只是标量→一对那一步）。重录走**机械变换**（只改 `glassColor`/`glassDarkSeparate`/`settingsVersion` 三键，其余逐用例逐字节零漂移 —— 整份"按现行 schema 现算"会连带吞掉别处的漂移）。
4. **"两个值不相等"型分主题判据是假绿**：把 dark 那一侧误读成 light 时，两侧仍各自经过**不同的两道亮度钳制**，输出**仍然不相等** ⇒ 改成因果判据（拿"两侧同色"的两份基准比，要求浅色输出只等于 light 基准、深色输出只等于 dark 基准），负对照才判得出。
5. 分主题行为判据首版断言 `--we-surface-tint-light === PAIR.light` 反而**假红**：沙箱里真正的 `weClampSurfaceColor` 声明会遮蔽恒等 stub（按主题改亮度）⇒ 判据不能假设钳制是恒等。
6. **迁移守卫第一版是假绿**：删掉 `migrateSettings` 里 v6 那一步，`verify-client` 仍 exit 0（读容忍把读出口盖住了）。补法 = ③c 结构棘轮（钉"那一步在场"）+ 找到读容忍的**真实入口**（带当前版本号的档 + 标量）做成行为判据，两条都配负对照；变异验证：删迁移 ⇒ ③c 红、删标量分支 ⇒ ③b 红。
7. `docs/ROUTE-INDEX.md` 生成物漂移：`/glass-presets` 的"守卫提及数" 1 → 2（新断言多提了一次该路径）⇒ 用 `node test/tools/host-route-index.mjs --write` 重算（属于预期动作，提交要带上它）。
8. **`panelThemeIsDark()` 的 `document` 守卫不够**：`test/verify-fontset.mjs` 给的是**能力不全的 stub document**（有 `body`、没有 `hasAttribute`）⇒ 渲染期 `TypeError: document.body.hasAttribute is not a function`，把 appearance 页签整条渲染打断（同一类坑见 §7 踩红 1）。修法：逐个查能力（`!body || typeof body.hasAttribute !== "function"` ⇒ 当"不是深色"）。这条是**既有守卫抓到的**（`verify-fontset` 的 ⑧ 组"面板渲染回归"），不需要新判据。

**门禁**：`npm run build`、`npm run verify`（36 脚本）、`npm run verify:docs`、`npm run smoke` 全部 exit 0。变异验证四条：删 v6 迁移步 ⇒ `verify-client` 红；删 `readGlassColors` 标量分支 ⇒ `verify-client` 红；`glassColorOf(selection, "dark")` 两处全替换成 `"light"` ⇒ `verify-glass-surfaces` ⑫b 红；面板开关不生效/深浅行联动错 ⇒ `verify-client` 面板判据红。

**未做（有意）**：C8（响应压缩）与 C10（启动路径 / (a)）继续推迟，理由与实测数据见 §8；`#148` 的真机部分仍待作者页复现。本轮改动**尚未提交**（按 §5 切分，`C7` 单独一个提交）。


