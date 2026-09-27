/**
 * font/components.js — 按**组件**细化字体（G4）：模块前缀通道 + 启动自探测 + 白名单。
 *
 * ══ 为什么是这条通道（静态分析结论，2026-09-27）══════════════════════════════════
 * DSH 组件 CSS 里字体绝大多数是**写死**的：39 个 CSS 文件中 `font-size` 走令牌仅 8 处、
 * 写死 212 处；`font-weight` 写死 71 处（值分布 500×24/400×19/600×12/700×11/300×1/inherit×4）。
 * 关键数字：写死的那些里 **`!important` 只有 4 处**（字重 0 处）⇒ 我们的覆盖**等特异性即可**，
 * 不需要 `!important`。
 *
 * 抓手是 CSS-module 的类名形态 `_<模块名>_<哈希>_<行号>`（如 `_wordmark_u7vgf_31`）：
 * 哈希每次构建都变，但**模块名前缀不变** ⇒ `[class*="_<模块名>_"]` 可以稳定命中。
 * 实测：309 个唯一哈希类 → 归出 **238 个模块前缀**。本仓已有先例（src/effects.js 里的
 * `body :is([class*="_markdown_"], ...)`）。
 *
 * ⚠️ **这是打包器产物，不是官方 API**：DSH 换打包器/命名策略会一次性失效。所以本模块
 * **启动时自探测**（采样白名单前缀，命中才启用该组件），而不是写死选择器当契约 ——
 * 失效时只是"这个组件不可调"，不会误伤别处。
 *
 * ══ 契约 ══════════════════════════════════════════════════════════════════════════
 * 需要的外界：**无**（document 由调用方传入，便于单测）。
 * 对外提供：COMPONENT_FONT_TARGETS（白名单）/ probeComponentTargets / buildComponentCss /
 *          COMPONENT_FONT_PROPS。
 *
 * 不变量（守卫逐条断言）：
 *   · 生成的选择器**只能是** `[class*="_<白名单前缀>_"]` 形态 —— 不许裸类名、不许标签、
 *     不许 `:has()`/祖先关联（白闪红线 1：作用域只能"直接命中"）。
 *   · 只写**白名单内**的前缀；只允许 `font-size` / `font-weight` / `font-family` 三个属性。
 *   · 两态：官方值作初始值 ⇒ 配置里为空/0 的项**不生成**任何规则（等于回官方）。
 *   · 不碰 katex（数学排版自带度量）与 `@font-face`。
 */

/** 允许覆盖的属性白名单（三项，都是"字体"的本义；不碰 line-height 之类布局属性）。 */
const COMPONENT_FONT_PROPS = ['font-size', 'font-weight', 'font-family'];

/**
 * 首期白名单：只放开**确认值得调、且命中面可控**的模块前缀。
 * `probe` 是启动自探测用的样例类名（写死不重要：只在探测里用一次）。
 * `label` 用于面板；`group` 用于折叠分组。
 */
const COMPONENT_FONT_TARGETS = [
  { prefix: 'markdown', label: '对话正文（markdown 容器）', group: '对话', probe: '_markdown_',
    // markdown 的字号由各元素自己的 `font: var(--dsw-font-markdown-h1)` 决定 ⇒ 直接在容器上
    // 写 font-size 会被那些简写盖掉；这里的正解是 F2 的角色令牌（已实现）。
    route: 'tokens' },
  { prefix: 'codeBlock', label: '代码块', group: '代码', probe: '_codeBlock_',
    // 代码块的字号来自后代 `font: var(--dsl-code-block-content-font)`（官方钩子）。
    // 在后代上写的简写**压过**祖先继承 ⇒ 只有在组件作用域改这个钩子才有效。
    route: 'hooks', dslHooks: ['--dsl-code-block-content-font', '--dsl-code-block-banner-font'] },
  { prefix: 'terminal', label: '终端块', group: '代码', probe: '_terminal_',
    route: 'hooks', dslHooks: ['--dsl-terminal-font'] },
  { prefix: 'table', label: '表格', group: '对话', probe: '_table_', route: 'tokens' },
  { prefix: 'sidebar', label: '侧栏', group: '界面', probe: '_sidebar_', route: 'props' },
  // 首期就这 5 个（目标口径 3–5）。刻意**不放开** `label` / `tab` / `input` 这类泛前缀：
  // 它们在多个模块里重名（`[class*="_label_"]` 会命中一堆无关模块），命中面不可控。
];

const PREFIX_RE = /^[A-Za-z][A-Za-z0-9]*$/;
/** 选择器形态的唯一合法模板：模块前缀必须来自白名单，且必须是子串属性选择器。 */
function selectorFor(prefix) {
  if (!PREFIX_RE.test(prefix)) throw new Error('component-fonts: 非法模块前缀 ' + prefix);
  if (!COMPONENT_FONT_TARGETS.some((t) => t.prefix === prefix)) {
    throw new Error('component-fonts: 前缀不在白名单内 ' + prefix);
  }
  return 'body [class*="_' + prefix + '_"]';
}

/**
 * 启动自探测：采样每个白名单前缀在当前 DOM 里是否命中。
 * @returns {string[]} 命中的前缀（未命中的组件整条不启用 —— 失效即降级，不误伤）
 */
function probeComponentTargets(doc, targets) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const list = targets || COMPONENT_FONT_TARGETS;
  if (!d || typeof d.querySelectorAll !== 'function') return [];
  const hit = [];
  for (const t of list) {
    try {
      if (d.querySelectorAll('[class*="_' + t.prefix + '_"]').length > 0) hit.push(t.prefix);
    } catch { /* 选择器不受支持：当作未命中 */ }
  }
  return hit;
}

/**
 * 生成组件级字体覆盖 CSS。
 * @param config 形如 `{ markdown: { size: 15, weight: 600, family: '...' }, ... }`；
 *               缺项/0/空串 = 不覆盖该项（**初始值即官方值**）。
 * @param available 命中的前缀（来自 probeComponentTargets）；不在其中的组件不生成规则
 * @returns {string} CSS 文本（空串 = 什么都不做）
 */
function buildComponentCss(config, available) {
  const cfg = config && typeof config === 'object' ? config : {};
  const avail = Array.isArray(available) ? available : [];
  const blocks = [];
  for (const target of COMPONENT_FONT_TARGETS) {
    if (!avail.includes(target.prefix)) continue;
    const c = cfg[target.prefix];
    if (!c || typeof c !== 'object') continue;
    const decls = [];
    if (typeof c.size === 'number' && Number.isFinite(c.size) && c.size > 0) {
      decls.push('  font-size: ' + Math.round(c.size) + 'px;');
    }
    if (typeof c.weight === 'number' && Number.isFinite(c.weight) && c.weight >= 100 && c.weight <= 900) {
      decls.push('  font-weight: ' + Math.round(c.weight) + ';');
    }
    if (typeof c.family === 'string' && c.family.trim()) {
      decls.push('  font-family: ' + c.family.trim() + ';');
    }
    if (!decls.length) continue; // 全空 ⇒ 回官方，不生成
    blocks.push(selectorFor(target.prefix) + ' {\n' + decls.join('\n') + '\n}');
  }
  return blocks.length ? blocks.join('\n') + '\n' : '';
}

/**
 * G3：官方的**组件级字体钩子**（`--dsl-*`）—— 全仓只有 13 个，其中与字体相关的就这三个。
 *
 * ⚠️ 关键结论（静态分析 2026-09-27）：它们**不是全局覆盖点**。
 *   定义在组件**自己的根类**上（源码 CSS 的 `.block`；打包后是 `._block_15pgz_1`），
 *   由后代消费（`.banner` / `.block :where(pre)` / `._prompt_15pgz_70`）。
 *   自定义属性按元素级联 ⇒ 在 `body` 上写没用（后代取的是祖先 `.block` 上的声明）；
 *   而 `.block` 又是**泛类名**（多个不同模块共用），直接用会命中无关元素。
 *   ⇒ 正解：**写进 G4 的组件作用域**（`body [class*="_block_"]`），而不是当全局钩子用。
 *
 * 另一条同样重要的结论：**后代上的 `font:` 简写压过祖先继承**。所以对"字体来自后代简写"的
 * 组件（代码块 / 终端），在容器上写 `font-size` **无效**，只有改这些钩子才有效 ——
 * 这正是角色表里 `route` 字段要区分 `tokens` / `hooks` / `props` 的原因。
 */
const DSL_FONT_HOOKS = [
  { name: '--dsl-code-block-content-font', label: '代码块正文', role: 'markdown-code-block' },
  { name: '--dsl-code-block-banner-font', label: '代码块标题条', role: 'markdown-code-block' },
  { name: '--dsl-terminal-font', label: '终端', role: 'markdown-code-block' },
];
const DSL_HOOK_NAMES = DSL_FONT_HOOKS.map((h) => h.name);

/**
 * 用官方钩子生成覆盖：把钩子值重新组合成 `<字重> <字号>/<行高> <字族>`，
 * 其中字重/行高/字族**取自 DSH 自己的细粒度令牌**（不重写），只把字号按配置调整 ——
 * 与 F2 的组合式同构，区别只是**写在组件作用域**而非角色令牌上。
 *
 * 钩子的原值形如 `var(--dsw-font-markdown-code-block)`（指回角色令牌）或
 * `11px/18px var(--dsw-font-family)`（字面量）。两种形态都用同一种组合方式覆盖：
 * 角色令牌那份取自 `role` 的细粒度令牌，字面量那份只改字号会丢行高 —— 因此这里
 * **只对"指回角色令牌"的钩子启用**（`role` 字段存在且四个令牌可用）。
 */
function buildDslBlocks(config, available, isAvailable) {
  const cfg = config && typeof config === 'object' ? config : {};
  const avail = Array.isArray(available) ? available : [];
  const ok = typeof isAvailable === 'function' ? isAvailable : () => true;
  const blocks = [];
  for (const target of COMPONENT_FONT_TARGETS) {
    if (!target.dslHooks || !avail.includes(target.prefix)) continue;
    const c = cfg[target.prefix];
    if (!c || typeof c !== 'object') continue;
    const decls = [];
    for (const hook of target.dslHooks) {
      const meta = DSL_FONT_HOOKS.find((h) => h.name === hook);
      if (!meta) continue;
      const t = (n) => '--dsw-font-' + meta.role + '-' + n;
      // 四个细粒度令牌缺一就跳过该钩子 —— 与 F2 同一条规则：组合式缺项会写出坏 font
      //（整条字体失效），宁可不覆盖（保持官方值）。
      if (![t('font-size'), t('line-height'), t('font-family'), t('font-weight')].every((n) => ok(n))) continue;
      const size = typeof c.size === 'number' && Number.isFinite(c.size) && c.size > 0
        ? Math.round(c.size) + 'px' : 'var(' + t('font-size') + ')';
      const family = typeof c.family === 'string' && c.family.trim()
        ? c.family.trim() : 'var(' + t('font-family') + ')';
      // 字重与行高一律沿用 DSH 自己的令牌 —— 我们只动用户改的那两项。
      decls.push('  ' + hook + ': var(' + t('font-weight') + ') ' + size
        + ' / var(' + t('line-height') + ') ' + family + ';');
    }
    if (!decls.length) continue;
    blocks.push(selectorFor(target.prefix) + ' {\n' + decls.join('\n') + '\n}');
  }
  return blocks.length ? blocks.join('\n') + '\n' : '';
}

export {
  COMPONENT_FONT_TARGETS, COMPONENT_FONT_PROPS, DSL_FONT_HOOKS, DSL_HOOK_NAMES,
  probeComponentTargets, buildComponentCss, buildDslBlocks, selectorFor,
};
