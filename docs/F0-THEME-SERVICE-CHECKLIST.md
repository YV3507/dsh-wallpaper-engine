# F0 真机确认清单（字体系统 · `theme` 令牌层）

> **状态：F0 已关闭（2026-09-26 真机实测完成）。** 本文**保留为 F0 记录**：§A 静态结论 → §C 步骤与探针代码
> （可复跑）→ **§C3 已填的实测表** → **§C4 结论（含锁定的 F1 实现形态与对旧结论的修正）**。
> 结论已并入 [`REFACTOR-ASSESSMENT.md`](./REFACTOR-ASSESSMENT.md) **§9.1 的 V1–V10** 与 **§5 F0（✅）**。
>
> **原始证据**（本地未跟踪）：`.integration-notes/scratch-scripts/` 下 `tmp-f0-theme-cdp.mjs`（可复跑采集脚本）、
> `f0-probe.json`、`f0-tokens-dark.json`、`f0-tokens-light.json`；诊断留痕在
> `~/.dsh-wallpaper-engine/diag/http.jsonl` 的 `"event":"F0-early"` / `"event":"F0"` 两组。
> **收口状态**：探针已从 `src/client.js` 删除，`lib/client.js` 已重建（`git status` 与 C0-3 基线一致）。
> **危险等级（复跑时）**：C1 只读、零风险；C2/C3 会临时改一次令牌（有 `dispose` + 刷新兜底）；
> **不碰**任何持久化、不新增用户可见开关、不改 `inject`。

---

> ### ✅ 执行状态：**已执行完毕（2026-09-26）—— F0 关闭**
>
> C0 / C1（**两套配色都采了**）/ C2（含三条语义边界与往返）**全部实测完成**：结果见 **§C3**，
> 结论与对 §A 的三处修正见 **§C4-A**，F1 实现形态已按判定分支锁定见 **§C4-B**。
>
> 探针已按 §C4 第 1 步删除，`src/client.js` 工作区 diff **已归零**（`git status` 只剩原有四项）。
> 实测做法（为什么要另起临时宿主、怎么取的数）见 **§C2.5**。
> 原始证据见上方状态块（`.integration-notes/scratch-scripts/`）。

---

## A. 已由静态侦察确认（**不要重跑**，直接引用）

侦察对象是本机实装：`D:\DSH Desktop\resources\app`（DSH **0.1.7-rc.1** / `@deepseek-ai/cordis` **4.0.4**）。

| # | 结论 | 证据（实装路径） |
|---|---|---|
| A1 | `theme` 是**客户端 Cordis 服务**，由 `@deepseek-ai/dsh-client-ui-theme` 提供 | `ctx.provide("theme", theme)` — `dsh-client-ui-theme/lib/client.js:1574` |
| A2 | **`overrideTokens(source, tokens)` 语义**：一个 source 一层；层按 `seq` **叠加、后者按令牌取胜**；**同 source 再调 = 替换该层并重新置顶**；返回 disposer；**传裸字符串抛教学错误**；值**必须是 `{ light, dark }` 两个字符串** | 同上 `:1450-1544` |
| A3 | **生效方式 = `body` 内联样式**（presenter 先摘掉上次写入的令牌，再逐条 `setProperty`）⇒ **内联胜过主题样式表，令牌层不需要 `!important`，也不用 DOM 选择器**（⚠️ 实测：机制面成立，但**当前 0 个 `--dsw-*` 走内联** —— 见 §C4-A·B2） | `dsh-client-ui-layout/lib/client.js:549-565` |
| A4 | **只读盘点有官方 API**：`exportInspectTokens()`（**不读 DOM、不读计算样式**，返回 JSON 安全的令牌描述）＋ `getTheme()`（快照，含 `active.tokens` 的**当前配色已合成值**、`preference`、`fontSize`、`revision`）（⚠️ 实测修正：`active.tokens` 是**空表**、`exportInspectTokens()` 仅 **14** 条 —— 见 §C4-A·B3） | `dsh-client-ui-theme/lib/client.js:1382-1394` |
| A5 | **你的实例跑的是工作区代码**（`link:` 安装，非快照）：`profiles/web` 是 **Junction → `D:\dsh-wallpaper-engine`**（v1.0.1）；`profiles/desktop` 是**旧快照 v0.7.3**（2026-09-19）。权威证据：`~/.dsh-wallpaper-engine/build-stamp.json` 的 `hostFile` 指向工作区 | C0-1 复核 |
| A6 | ⚠️ **与蓝图不同的一点**：若插件走**动态包**（市场包）通道，`overrideTokens` 的 source 会被**强制**为 `<pluginId>.<packageId>`（包无法冒名顶替别的 source）；**bundle 包**（我们这种 `dsh.profile.bundles` 条目）不受此限。C2 会实测我们走哪条（⚠️ 本轮**未直接判定**：我们的链路确实是 `bundle` 条目、按上文应免强制，但探针两次用的是**同一个** source，即使被强制也仍会得到 `replaced`，无法据此区分 —— 若 F1 需要确认，用**两个不同** source 名各写一次、再看 `t.overrides` 的键名即可一次性定论） | `dsh-cordis-client-runner/lib/client.js:300-318` |
| A7 | ⚠️ **一条设计修正**：**不要**把 `"theme"` 硬加进 `inject`。`inject` 是**必需**依赖 ⇒ 服务缺失时 fiber 会一直 pending（插件整体不挂载）；而 `ctx.get(name)` 是**可选查找**（运行时明文如此规定）⇒ 应走 `ctx.get("theme")` + 能力探测 + 回落今天的 `/style` 路径 | `dsh-cordis-client-runner/lib/client.js:322-333` |
| A8 | ⚠️ **现有诊断通道装不下令牌清单**：`reportClientDiag` 的 `detail` 在**客户端与宿主两端各截断到 300 字符** ⇒ 蓝图里"把当前 DSH 有哪些角色/值打进 live 诊断日志"**不能直接实现**（要么只记紧凑摘要，要么 F1 另开通道） | `src/client.js:3338`、`lib/index.js:3890` |

**⇒ 因此真机只剩三件事**：① 冻结环境事实；② 盘点当前令牌（数值以真机为准）；③ 实测服务可达性与
`overrideTokens` 的**往返**（写 → 生效 → 撤销 → 还原）与三条语义边界。

---

## C0. 冻结环境（1 分钟）

```powershell
# C0-1 权威：当前跑的是哪份宿主代码（期望 hostFile = D:\dsh-wallpaper-engine\lib\index.js）
Get-Content "$env:USERPROFILE\.dsh-wallpaper-engine\build-stamp.json"

# C0-2 theme 包版本（期望 0.1.7-rc.1；若不同，把实际值记进 R 表）
node -e "console.log(require('D:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/package.json').version)"

# C0-3 工作区插件版本 + 客户端产物是否与源码同步（期望输出为空 = 同步）
Select-String -Path .\package.json -Pattern '"version"'
node scripts/build-client.mjs; git status --porcelain lib/client.js
```

**记录**：`build-stamp.json` 的 `hostFile` / `at`、theme 包版本、插件版本、`git status` 是否干净。

> 若 `hostFile` **不是**工作区路径（而是 `profiles\desktop\node_modules\...`），先别继续 ——
> 说明当前窗口跑的是旧快照 v0.7.3，探针结论无效。请改用工作区所在的 profile 再跑。

---

## C1. 令牌盘点（**纯 DevTools，无代码改动**）

打开运行界面（桌面端窗口内 DevTools，或直接在 Chrome / Edge 打开 `http://127.0.0.1:43120`），
在 **Console** 粘贴：

```js
// F0-C1：令牌盘点（只读；不改 DOM、不改设置）
(() => {
  const cs = getComputedStyle(document.body);
  const names = new Set();
  const scan = (rules) => {
    for (const r of rules) {
      if (r.style) for (const p of r.style) if (p.startsWith('--dsw-') || p.startsWith('--dsh-content-')) names.add(p);
      if (r.cssRules) { try { scan(r.cssRules); } catch { /* @media 内层可能跨源，跳过 */ } }
    }
  };
  for (const sheet of document.styleSheets) { let rules; try { rules = sheet.cssRules; } catch { continue; } scan(rules); }
  const all = [...names].sort();
  const rows = all.map((n) => ({ token: n, value: cs.getPropertyValue(n).trim() }));
  const roles = rows.filter((r) => r.token.startsWith('--dsw-alias-label-'));
  const fonts = rows.filter((r) => /^--dsw-font|^--ds-font|^--dsh-content-font/.test(r.token));
  const report = {
    bootRev: (window.__DSH_BOOT__ || {}).rev || null,
    scheme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
    themeSource: document.documentElement.getAttribute('data-ds-theme-source'),
    tokenCount: all.length, roleCount: roles.length, fontCount: fonts.length,
    bodyInlineTokenCount: document.body.style.length,   // presenter 写进 body 内联的令牌数（>0 即证实 A3）
    roles, fonts, all,
  };
  console.log('F0-C1 摘要', { bootRev: report.bootRev, scheme: report.scheme, themeSource: report.themeSource,
    tokenCount: report.tokenCount, roleCount: report.roleCount, fontCount: report.fontCount,
    bodyInlineTokenCount: report.bodyInlineTokenCount });
  console.table(roles); console.table(fonts);
  try { copy(JSON.stringify(report)); console.log('已复制完整 JSON 到剪贴板'); }
  catch { console.log('copy() 不可用：右键上面这行对象 → Copy object'); }
  return report;
})()
```

**C1b（需要两套配色值，务必都采）**：跑到上面输出后 →
设置 → 外观切到**浅色**，重跑一次，存成 `f0-tokens-light.json`；再切回**深色**，重跑，存成 `f0-tokens-dark.json`。
（`getComputedStyle` 只能看到**当前生效**的那一套，所以必须切换配色各采一次。）

**记录**：`tokenCount` / `roleCount` / `fontCount` / `bodyInlineTokenCount`，以及 5 个 label 角色在两套配色下的值。

---

## C2. 服务可达性 + 机制往返（**需临时插桩**）

### C2a 插入探针

> ⚠️ **历史记录（已还原）**：本步骤已于 2026-09-26 执行并**回滚** —— `src/client.js` 现在**不含**该探针。
> 下方代码块保留为可复核的探针原文；实际执行时 ② 段被加强为「**每 250ms 轮询、最多 6s**」，
> 并额外记录 `ctx.get(name, false)`（non-strict）与 `ctx.root.get`，以区分「启动竞态」与「不可达」；
> ③ 段增加 `sampleTokens` / `themes` 输出。最终结果见 §C3 与 §C4-A·B1。

在 [`src/client.js`](../src/client.js) 的 `function apply(ctx) {`（第 9949 行）**紧随其后**插入一行：

```js
  probeThemeServiceF0(ctx); // F0 探针（临时，确认后删除）
```

并在 `function apply(ctx) {` **之前**插入下面整段（原样复制；它自身只读，只有 C2b 那一次可回滚往返会写）：

```js
// ══ F0 探针：确认 theme 令牌层是否可用（临时；F0 关闭后整段删除）══════════
function probeThemeServiceF0(ctx) {
  const out = { probe: 'F0', rev: (window.__DSH_BOOT__ || {}).rev || null };
  const brief = (e) => String((e && e.message) || e).slice(0, 80);
  // ① 直接访问（需要 fiber 声明 theme；A7 说不要这么做，这里只测「能不能」）
  try { out.direct = ctx.theme ? 'object' : String(ctx.theme); } catch (e) { out.direct = 'throw:' + brief(e); }
  // ② 可选查找 —— 推荐路径（不声明依赖，缺服务也不 park）
  let theme = null;
  try {
    if (typeof ctx.get === 'function') { theme = ctx.get('theme') || null; out.get = theme ? 'object' : 'null'; }
    else out.get = 'no-ctx.get';
  } catch (e) { out.get = 'throw:' + brief(e); }
  const t = theme || (out.direct === 'object' ? ctx.theme : null);
  if (!t) { out.verdict = 'unreachable'; console.warn('[F0]', out); reportClientDiag('F0', JSON.stringify(out).slice(0, 290)); return; }
  // ③ 只读盘点 API（A4）
  out.members = Object.keys(t).sort().join(',').slice(0, 150);
  try { out.inspect = typeof t.exportInspectTokens === 'function' ? t.exportInspectTokens().length : -1; }
  catch (e) { out.inspect = 'throw:' + brief(e); }
  try {
    const snap = t.getTheme();
    out.scheme = snap.active.colorScheme; out.pref = snap.preference; out.contentPx = snap.fontSize;
    out.tokenCount = Object.keys(snap.active.tokens).length;
  } catch (e) { out.snapErr = brief(e); }
  // ④ 机制往返（TOKEN_A）：读原值 → 写 → 立刻读 → 400ms 再读 → 撤销 → 再读
  const A = '--dsw-alias-label-primary';
  const readA = () => ({ inline: document.body.style.getPropertyValue(A).trim(),
                         computed: getComputedStyle(document.body).getPropertyValue(A).trim() });
  out.before = readA().computed;
  let disposeA = null;
  try { disposeA = t.overrideTokens('f0-probe', { [A]: { light: '#ff00ff', dark: '#00ffff' } }); out.now = readA().inline; }
  catch (e) { out.applyErr = brief(e); }
  // ⑤ 语义边界（TOKEN_B，**刻意换令牌**以免与 ④ 的层互相覆盖）
  const B = '--dsw-alias-label-tertiary';
  try { t.overrideTokens('f0-bad', { [B]: '#ffffff' }); out.bareString = 'NO-THROW(意外)'; }
  catch (e) { out.bareString = 'throws:' + brief(e).slice(0, 40); }
  try { const d = t.overrideTokens('f0-unknown', { '--dsw-f0-nonexistent': { light: '#fff', dark: '#000' } }); d(); out.unknownToken = 'silent-ok'; }
  catch (e) { out.unknownToken = 'throws:' + brief(e).slice(0, 40); }
  try {
    const d3 = t.overrideTokens('f0-replace', { [B]: { light: '#111111', dark: '#222222' } });
    const a = document.body.style.getPropertyValue(B).trim();
    const d4 = t.overrideTokens('f0-replace', { [B]: { light: '#333333', dark: '#444444' } });
    const b = document.body.style.getPropertyValue(B).trim();
    d3(); d4();
    out.replace = a !== b ? 'replaced' : 'same-value?';
  } catch (e) { out.replace = 'throw:' + brief(e); }
  reportClientDiag('F0-early', JSON.stringify(out).slice(0, 290)); // 先落一条：即使 400ms 后没再看也有记录
  setTimeout(() => {
    const later = readA(); out.later = later.inline; out.laterComputed = later.computed;
    try { if (typeof disposeA === 'function') disposeA(); } catch (e) { out.disposeErr = brief(e); }
    setTimeout(() => {
      const after = readA(); out.after = after.inline; out.afterComputed = after.computed;
      // 关键判定：撤销后是否**真的还原**（漏还原 = 需要刷新页面，也说明 dispose 语义要在 F1 里另加兜底）
      out.leftover = (out.after === '#00ffff' || out.after === '#ff00ff') ? 'YES-需刷新' : 'no';
      out.verdict = (out.now && out.later) ? 'mechanism-ok' : (out.applyErr ? 'override-threw' : 'not-applied');
      console.info('[F0] 完整结果（请整份回贴）', out);
      reportClientDiag('F0', JSON.stringify({ v: out.verdict, get: out.get, direct: out.direct,
        inspect: out.inspect, bare: out.bareString, unk: out.unknownToken, rep: out.replace,
        before: out.before, now: out.now, later: out.later, after: out.after, leftover: out.leftover }).slice(0, 290));
    }, 150);
  }, 400);
}
// ══ F0 探针结束 ══════════════════════════════════════════════════════════
```

### C2b 构建 + 刷新

```powershell
node scripts/build-client.mjs      # 或 npm run build
```

然后**刷新页面**（F5；桌面端内若没生效，重启窗口/`dsh web`）。探针能打印出 `[F0] 完整结果` 即说明新代码已生效。

**期望观察**（深色配色下）：
- 令牌层写入 `#00ffff` → 正文主色**短暂变青**（约 0.4–0.55 秒），随后**自动回到原色**。
  这是**预期**行为，不是故障；若一直不回，刷新页面即可（`dispose` 兜底 + 页面重载都会还原）。
- 控制台同时出现 `[F0] 完整结果`。

> 本探针已按 §A2/§A3 的**忠实模拟**（层按 `seq` 叠加 + presenter 摘旧值后重放快照）冒烟跑通：
> 能正确区分「写进去了」「撤销后**真的还原**」与「漏还原（`leftover=YES`）」三种结果，
> 三条语义边界也各自独立命中。**你实机拿到的 `after` 就是权威答案** —— 它同时验证了
> F1 能否依赖 `dispose` 还原，还是必须自己维护兜底。

### C2c 取回结果（两条通道）

```powershell
# 通道 1（首选）：控制台那份 JSON 直接复制回贴
# 通道 2（留痕）：诊断文件里筛 F0（detail 截断到 300 字符，只作旁证）
Select-String -Path "$env:USERPROFILE\.dsh-wallpaper-engine\diag\http.jsonl" -Pattern '"event":"F0' | Select-Object -Last 4 | ForEach-Object { $_.Line }
```

---

### C2.5 采集环境与方法（本次实测实际怎么做的）

- **宿主**：桌面端窗口跑在 `mode: advanced`，普通浏览器访问 `http://127.0.0.1:43120` 会被
  `decideDesktopBrowserAccess` 直接 **403 forbidden**（这道门闸在 Connection 鉴权**之前**，
  所以本地复算 Connection cookie 也进不去）。因此改用**临时 `DSH_HOME`** 起了一个**真实的 web
  profile 宿主**（`desktop-cli.js --profile web --port 45919`）；插件仍是 `link:D:/dsh-wallpaper-engine`
  ⇒ **被测的就是工作区那份 `lib/client.js`**，与 C0-1 的 `hostFile` 指向一致。
- **通道**：headless Edge + CDP —— `Runtime.evaluate` 跑 §C1 同源代码；`Runtime.callFunctionOn`
  **按值**取回控制台对象（CDP 对非原始值默认只给 RemoteObject 预览，必须再取一次）；
  `Network.setExtraHTTPHeaders` 带官方 `?token=` 交换出的会话 cookie。只读、不改宿主、不改设置、
  不写任何持久化；临时宿主用完即停、临时目录已删。
- **可复现脚本**：`.integration-notes/scratch-scripts/tmp-f0-theme-cdp.mjs`（`c1` / `c2` 两个模式）。
- **必须记住的副作用**：宿主偏好是**异步下发**的。探针在 ~7ms 就进 `apply()`、~325ms 才拿到服务，
  那一刻配色还是**默认浅色**、`preference` 还是 `system`，约 400–500ms 才翻到 profile 里配的 `dark`。
  C2 的 `now` / `later` 差异正是这次翻转造成的（见 §C4-A·B4），**不是**别的层抢写。
- **`pluginMounted` 显示 `unknown` 不代表没挂载**：web profile 下本插件的 DOM 标记与桌面端不同。
  正证据是 `/wallpaper-engine/settings`、`/wallpaper-engine/inventory` 均 **200**、
  `/wallpaper-engine/client-diag` **204**，且 body 内联挂着 22 个 `--we-*`。

---

## C3. 结果表（已填）

| 编号 | 项目 | 期望 | 实测 | 判定 |
|---|---|---|---|---|
| C0-1 | `build-stamp.json` → `hostFile` | `D:\dsh-wallpaper-engine\lib\index.js` | `D:\dsh-wallpaper-engine\lib\index.js`（`at 2026-09-26T05:57:14.865Z`） | ✅ 命中 |
| C0-2 | theme 包版本 | `0.1.7-rc.1` | `0.1.7-rc.1` | ✅ 命中 |
| C0-3 | `git status lib/client.js` | 空（构建与源码同步） | 空（插件 v1.0.1）。全仓：` M docs/README.md` / `D  docs/RENDER-FALLBACK-MODES.md` / `?? docs/F0-THEME-SERVICE-CHECKLIST.md` / `?? docs/REFACTOR-ASSESSMENT.md` | ✅ 命中 |
| C1-1 | `bootRev` / `scheme` | 记录值 | `3f584bcc020c`；dark 与 light **各采一次**（`themeSource` 同步为 `dark` / `light`） | ✅ |
| C1-2 | `tokenCount` / `roleCount` / `fontCount` | 记录值 | 两套配色**均为** `377` / `10` / `184` | ✅ |
| C1-3 | `bodyInlineTokenCount` | **> 0** | `23`，但**其中 0 个是 `--dsw-*`** —— 全是 `--dsh-content-font-size` + 22 个本插件 `--we-*` | ⚠️ 数值命中、**语义需修正**（§C4-A·B2） |
| C1-4 | 5 个 label 角色 light / dark 值 | 两个 json 已存 | 见下方「C1-4 令牌值」；`f0-tokens-light.json` / `f0-tokens-dark.json` | ✅ |
| C2-1 | `get`（可选查找） | `object` | 首次（`apply()` 后 **7ms**）`strict/loose/root` **三者全空** → **325ms 转为 `object`** | ⚠️ 有条件成立：**是启动竞态，必须延后/轮询**（§C4-A·B1） |
| C2-2 | `direct`（未声明 inject 直接访问） | `object` 或 `undefined` | **`throw: cannot get property "theme" without inject`** | ✅ 命中 A7（第三种形态：**抛错**） |
| C2-3 | `inspect` 与 C1-2 的 `tokenCount` **同量级** | 同量级 | `exportInspectTokens()` = **14**；`getTheme().active.tokens` = **0**；`themes` = `light:light:0 dark:dark:0`；样式表里 `--dsw-*` = **377** | ❌ **同量级不成立**，A4 需修正（§C4-A·B3） |
| C2-4 | `before`（撤销前的原值） | 非空 | `#0f1115`（此刻仍在浅色样式表上） | ✅ |
| C2-5 | `now` / `later` | `now = later`（染色生效） | `now=#ff00ff`（light 值）、`later=#00ffff`（dark 值） | ⚠️ 不等，但**不是被别的层顶掉**：窗口内配色 light→dark 翻转，层内双值各自正确解析（§C4-A·B4） |
| C2-6 | `after` / `leftover` | `after = before` 且 `leftover = no` | `after=""`（内联已摘净）、`afterComputed=#f9fafb`（= C1-dark 的 `-primary`，即样式表值）、`leftover=no` | ✅ 命中：**撤销真的还原** |
| C2-7 | `bareString` | `throws:` | `throws: theme override "--dsw-alias-label-tertia…` | ✅ |
| C2-8 | `unknownToken` | `silent-ok` | `silent-ok` | ✅ |
| C2-9 | `replace` | `replaced` | `replaced(#111111→#333333)` | ✅ |
| C2-10 | 令牌层生效时是否**闪白/闪黑** | 无异常（只有一次颜色切换） | headless 无肉眼；往返在 0.55s 内完成，`afterComputed` 回到原值、`leftover=no` | ⚠️ 无法目视，以 `leftover=no` 旁证 |

**C1-4 令牌值**（`--dsw-alias-label-*`，两套配色；`roleCount` 恰好 10 条）：

| 令牌 | light | dark |
|---|---|---|
| `--dsw-alias-label-caption` | `rgb(110, 114, 120)` | `#81858c` |
| `--dsw-alias-label-dimmed` | `rgb(50, 52, 56)` | `#43454a` |
| `--dsw-alias-label-document-preview` | `#e1e5ee` | `#cfd3d6` |
| `--dsw-alias-label-primary` | `rgb(0, 0, 0)` | `#f9fafb` |
| `--dsw-alias-label-primary-bluish` | `#0e3074` | `#f9fafb` |
| `--dsw-alias-label-primary-dimmed` | `rgb(10, 10, 12)` | `#ebeef2` |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |
| `--dsw-alias-label-primary-inverted` | `#fff` | `#353638` |
| `--dsw-alias-label-secondary` | `rgb(40, 42, 46)` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `rgb(70, 73, 79)` | `#adb2b8` |

> 注：`--dsw-alias-label-primary-bluish` 与 `-primary` 在 **dark 下同值**（`#f9fafb`），
> 而 light 下完全不同（`#0e3074` vs 纯黑）—— 这类「dark 下重合」的角色做字体色时要留意。

---

## C4. 收口

### C4-0 三步状态

| 步骤 | 状态 | 证据 |
|---|---|---|
| 1. 删掉探针 → `npm run build` → 确认 `git status` 只剩预期改动 | ✅ 已完成 | `git diff --stat -- src/client.js` **为空**（源码逐字还原）；`lib/client.js` 构建后回到提交态；`git status --porcelain lib/client.js` **为空**，全仓与 C0-3 基线四项一致 |
| 2. 回贴 §C3 表（连两份 `f0-tokens-*.json`） | ✅ 已完成 | §C3 已填；原始证据留在 `.integration-notes/scratch-scripts/`（`f0-tokens-light.json` / `f0-tokens-dark.json` / `f0-probe.json`） |
| 3. 结论进账本 | ✅ 已完成 | 已并入 [`REFACTOR-ASSESSMENT.md`](./REFACTOR-ASSESSMENT.md) **§9.1 的 V1–V10** 与 **§5 F0（✅）**；**本文按用户要求保留为 F0 记录**（含可复跑步骤与探针代码，不再删除） |

### C4-A 结论：判定分支走了哪条 + 对 §A 的修正

**命中判定分支第 1 条（主路径成立）**：`get` 最终为 `object` 且 `verdict = mechanism-ok`
⇒ **F1 走「`ctx.get('theme')` 可选查找 → 令牌层」，不改 `inject`，`/style` 路径留作回落。**
但主路径带**三个附带条件**（B1 时序、B3 清单来源、B4 配色翻转），下面逐条落账。

**B1（新增，最重要）`ctx.get('theme')` 是启动竞态，不能只调一次。**
实测 `apply()` 后 **7ms** 时 `strict` / non-strict / `ctx.root.get` **三者全空**，**325ms** 时三者同时可用。
7ms 时连 **non-strict 也为空** ⇒ 不是「fiber 未 active」，而是**服务还没进 store**
（`_getImpl` 的前置条件是 `key && store[key]`），所以**等 fiber 状态也没用**，只能等注册。
⇒ F1 必须在 `apply()` 之后**延迟 + 轮询**（如 250ms × 24）或走 cordis 的服务就绪事件；
拿到之前保持今天的 `/style` 路径。**不能**同步取一次就定论 —— 这一条如果漏了，F1 在真机上会静默失效。

**B2 修正 A3 的“当前有多少令牌走内联”。** `bodyInlineTokenCount = 23 > 0` 成立，但**其中 0 个是 `--dsw-*`**：
23 个全是 `--dsh-content-font-size`（presenter 自己写的字号）+ 22 个本插件的 `--we-*`。
A3 的**机制面成立**（`now` 一写，body 内联与计算值**同时**变，立刻压过样式表），
但「令牌走内联」这件事**当前并没有发生** —— 因为快照里没有令牌可写（见 B3）。

**B3 修正 A4：快照令牌表是空的，清单必须另找来源。**
`getTheme().active.tokens` 长度 = **0**；`themes` = `light:light:0 dark:dark:0`（两套内置主题各 0 条令牌）；
`exportInspectTokens()` = **14** 条，而样式表里 `--dsw-*` 有 **377** 条 —— 差 27 倍，**不是同量级**。
⇒ ① A4 里「快照含 `active.tokens` 的当前配色已合成值」在 **0.1.7-rc.1 上不成立**；
② 令牌**清单与取值**的权威来源仍是**样式表 + `getComputedStyle`**（即 §C1 那套）；
③ `overrideTokens` 的底座其实是**空表** ⇒ 我们写多少就生效多少，不存在「与内置令牌表合并」。

**B4 修正判定表里 `now ≠ later` 的读法。** 二者不等**不是**「另有 layer 压在同一个令牌上」：
测量窗口内配色从浅色翻到了深色（宿主偏好异步下发），层内 `{light,dark}` 两值**各自被正确解析**
（`now=#ff00ff` 是 light 值、`later=#00ffff` 是 dark 值）。
这反过来是**正面证据**：一个层注册**一次**即可**随配色自动换值** ⇒ F1 不需要监听配色变化重注册。

**B5 A7 实机确认（且是第三种形态）。** `ctx.theme` 不是 `undefined`，而是**抛错**
`cannot get property "theme" without inject` ⇒ 绝不把它加进 `inject`（会 park），
也不要用 `ctx.theme` 裸访问；必须 `ctx.get` + `try/catch`。

**B6 `dispose()` 干净还原，F1 可放心依赖。** `after = ""`（内联摘净）、
`afterComputed = #f9fafb`（= C1-dark 的 `--dsw-alias-label-primary`，即回落样式表值）、`leftover = no`。

**B7 三条语义边界全部按 A2 命中。** 裸字符串 `throws:`；未知令牌 `silent-ok`（不抛，
但也**不会生效** ⇒ F1 必须自己校验令牌名是否在那 377 条里）；同 source 再调 `replaced(#111111→#333333)`。

**B8 A8 保留。** `reportClientDiag` 的 `detail ≤ 300 字符` 是硬约束：令牌清单**不能**走 live 诊断通道。
本次实测也印证了 —— 探针的完整对象只能靠控制台**按值**取回。

### C4-B F1 实现形态（锁定）

1. `apply(ctx)` 内**不**声明 `theme` 依赖；启动后台轮询 `ctx.get('theme')`（250ms × N，拿到即停），
   拿到前不做任何令牌相关动作，`/style` 路径照旧可用。**（B1）**
2. 拿到服务后，用**固定 source 名**（建议 `wallpaper-engine`）注册**一层**覆盖，值一律给
   `{ light, dark }` 双值 —— 配色切换会自动换值，**不要**监听配色变化重注册。**（B4/B7）**
3. 令牌**清单与取值**：用 §C1 那套样式表扫描（`document.styleSheets` + `getComputedStyle`），
   **不要**依赖 `getTheme().active.tokens`（为空）或 `exportInspectTokens()`（仅 14 条）；
   写入前做「令牌名 ∈ 377 清单」的白名单校验。**（B3/B7）**
4. 不需要 `!important`、不需要 DOM 选择器：body 内联即刻压过样式表。**（B2）**
5. 生命周期：把 disposer 交给 `ctx.effect` / 卸载钩子；实测 `dispose()` 干净，可放心依赖。**（B6）**
6. 诊断：**不要**把令牌清单塞进 `client-diag`（300 字符），只记紧凑摘要或另开通道。**（B8）**

### C4-C 判定分支（原文保留，逐条标注命中）

| 实测 | 结论 | F1 的实现形态 | 本轮命中 |
|---|---|---|---|
| `get=object` 且 `verdict=mechanism-ok` | **主路径成立** | `ctx.get('theme')` 可选查找 → 令牌层；**不改 `inject`**；`/style` 路径留作回落 | ✅ **命中**（附 B1 时序条件） |
| `get=null` 但 `direct=object` | 该 channel 下服务只在 ctx 属性上可见 | 直连 + `try/catch` 包裹，仍不声明 `inject`（避免 A7 的 park 风险） | ✖（`get` 最终为 `object`；`direct` 是**抛错**不是 `object`） |
| 两者皆不可达 | 令牌层暂不可用 | F1 降级为「继续用 `/style`」，并把「为什么不可达」作为下一轮问题 | ✖ |
| `now` 有值但 `later` 变成了**别的颜色** | 另有 layer 压在同一个令牌上 | 需先确认 source 优先级（`seq` 顺序）再改令牌 | ✖（差异来自配色翻转，见 B4） |
| `bodyInlineTokenCount = 0` | A3 不成立 | 整套「令牌层免 `!important`」的论证要重做 | ✖（= 23 > 0；但见 B2 的语义修正） |

> ⚠️ 无论走哪条：**A8 那条约束要带进 F1** —— 现有 `client-diag` 通道 `detail ≤ 300 字符`，
> 所以「把令牌清单持续写进 live 诊断日志」需要**另开通道或只记紧凑摘要**，不能照搬蓝图。

---

## F0 关闭小结（一句话版）

`theme` 令牌层**可用**，`ctx.get('theme')` 是正确入口（**但必须在启动后轮询，7ms 时还没注册，325ms 才有**）；
`overrideTokens` 写入 **body 内联即刻生效、免 `!important`**，`dispose()` **干净还原**，
`{light,dark}` **随配色自动换值**；三条语义边界与 A2 一致。
两处要修正的旧结论：**A4**（快照令牌表为空、`exportInspectTokens()` 仅 14 条 ⇒ 清单/取值权威来源是样式表，共 377 条）、
**A3 的推论**（当前 0 个 `--dsw-*` 走内联，因为没令牌可写）。**F1 实现形态见 §C4-B。**
