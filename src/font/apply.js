/**
 * font/apply.js — 字体自定义的**落地点**（设置 → DOM）：宿主默认值快照 + 组件作用域样式表。
 *
 * 为什么单独一个文件：字体系统的其它三个模块都是**纯计算**（角色表 / 令牌 / 钩子生成），
 * 只有这里碰 DOM。把它从 src/effects.js 里分出来，"效果应用层"（scrim / 玻璃 / 光标 / 淡出底色）
 * 就不再夹带字体代码 —— 读一处就够。
 *
 * ══ 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，因此"外部作用域"= 同一 prelude / src/client.js 的顶层）══════════════════════
 * 需要的外界：
 *   COMPONENT_FONT_TARGETS   ← src/font/components.js（用组件总数判"命中集不全"）
 *   probeComponentTargets()  ← 同上（启动自探测）
 *   componentScopeSelector() ← 同上（id → 作用域选择器；**id→模块名的映射只有那一处**）
 *   buildComponentCss()      ← 同上（tokens 通道：写真实属性）
 *   buildDslBlocks()         ← 同上（hooks 通道：写官方 --dsl-* 钩子）
 *   selection                ← src/client.js 的设置/选中项 store（**只读**）
 * 对外提供：componentFontDefaults（面板显示默认值）/ snapshotHostFontDefaults /
 *          removeFontStyles / applyComponentFonts / removeComponentFonts。
 *
 * 不变量：
 *   · **只读 selection、不写它** —— 写设置是 UI 处理器与 apply(ctx) 的事。
 *   · 只碰两处 DOM：`#we-font-scope` 这个 `<style>`，以及 documentElement 上的 `--we-host-*`；
 *     两者都必须能成对清除（`removeComponentFonts` / `removeFontStyles`）。
 *   · 出错一律咽掉：字体自定义是增强，任何异常都不该影响主路径。
 *   · 本文件必须浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     —— 它被内联到 bundle 顶部（早于 client.js 正文），顶层读正文里的 const 会撞 TDZ。
 *   · 作用域选择器**只能**由 `componentScopeSelector(id)` 给出：这里不得自己拼模块名。
 */

// ── 宿主角色色快照（面板要显示「当前默认色」）──────────────────────────────
// 这个数组与 snapshotHostFontDefaults 只服务一件事：把**宿主此刻的角色色**记进 --we-host-*，
// 供面板显示「当前默认色」。它不注入任何规则，也没有"还原契约"
//（[data-we-font-ignore] 全仓没有消费者，已随全局字体层一起删除）。
// 白闪红线（v0.6.4 起）：不要引入 :has() 或祖先相关选择器 —— 祖先失效集会把点击/输入的
// 样式重算扩大到整棵 DOM，是 kiosk 窗口整屏刷白的点火条件。
const WE_HOST_TOKENS = [
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-label-dimmed",
];

/**
 * 组件级字体：把 `body [class*="_<模块名>_"]` 的覆盖写进 `#we-font-scope`。
 *
 * 分工：这里管的是**单个组件**（对话正文 / 代码块 / 终端 / 表格），不是全局角色。
 * 三条规矩来自静态分析（详见 src/font/components.js 文件头）：
 *   · 命中靠**启动自探测**（结果缓存；打包器改名 ⇒ 整条降级，不误伤）；
 *   · 字体来自后代 `font:` 简写的组件（代码块 / 终端）**只有官方 `--dsl-*` 钩子这条腿有效**；
 *   · 空配置 = 不生成任何规则（**官方值作初始值**）。
 * 探测结果缓存，但**可重试**：命中集不全时（组件后来才出现在页面上）超过 2s 就重探一次 ——
 * 既不必刷新页面，也不会每次输入都去读 computed 样式（那是布局抖动）。
 * UI 显示（componentFontDefaults）与 CSS 生成（applyComponentFonts）走同一份结果。
 */
let componentFontProbe = null;
let componentFontProbeAt = 0;
function componentFontAvailability() {
  const stale = componentFontProbe !== null
    && componentFontProbe.ids.length < COMPONENT_FONT_TARGETS.length
    && Date.now() - componentFontProbeAt > 2000;
  if (componentFontProbe === null || stale) {
    const ids = probeComponentTargets(document);
    // 顺带把"当前 DSH 默认值"读回来：面板直接显示它（而不是"官方"占位字样）——
    // 取该组件作用域命中的第一个元素读 computed 的字号/字重/字族。探测只做一次。
    // ⚠️ 两个组件共用同一个模块名时（代码块 / 终端块都是 `block`），两行会读到**同一个**
    //    元素 ⇒ 显示值可能相同。作用域选择器只能由 componentScopeSelector 给出（id→模块名
    //    的映射只有一处），这里不得自己拼模块名。
    const defaults = {};
    for (const id of ids) {
      try {
        const scope = componentScopeSelector(id);
        const el = scope ? document.querySelector(scope) : null;
        if (!el) continue;
        const cs = getComputedStyle(el);
        defaults[id] = {
          size: Math.round(parseFloat(cs.fontSize) || 0) || 0,
          weight: parseInt(cs.fontWeight, 10) || 0,
          family: cs.fontFamily || "",
        };
      } catch { /* 读不到就不显示默认值，不影响覆盖能力 */ }
    }
    componentFontProbeAt = Date.now();
    componentFontProbe = {
      ids,
      defaults,
      hasToken: (t) => {
        try { return getComputedStyle(document.body).getPropertyValue(t).trim() !== ""; } catch { return false; }
      },
    };
  }
  return componentFontProbe;
}
/** 面板显示用的"当前 DSH 默认值"（按组件）。 */
function componentFontDefaults() {
  return componentFontAvailability().defaults;
}
function fontScopeEl() {
  let st = document.getElementById("we-font-scope");
  if (!st) {
    st = document.createElement("style");
    st.id = "we-font-scope";
    (document.head || document.documentElement).appendChild(st);
  }
  return st;
}
function applyComponentFonts() {
  try {
    const cfg = selection.componentFonts && typeof selection.componentFonts === "object"
      ? selection.componentFonts : {};
    const { ids, hasToken } = componentFontAvailability();
    const css = buildComponentCss(cfg, ids) + buildDslBlocks(cfg, ids, hasToken);
    const st = fontScopeEl();
    if (st.textContent !== css) st.textContent = css;
  } catch { /* 组件字体是增强：任何异常都不该影响主路径 */ }
}
function removeComponentFonts() {
  try {
    const st = document.getElementById("we-font-scope");
    if (st) st.textContent = "";
  } catch { /* ignore */ }
}

function snapshotHostFontDefaults() {
  // 已快照则跳过；removeFontStyles 会清空，重开时再取。
  try {
    const es = document.documentElement.style;
    let need = false;
    for (const t of WE_HOST_TOKENS) {
      if (!es.getPropertyValue("--we-host-" + t.slice(2))) { need = true; break; }
    }
    if (!need) return;
    const bodyCs = getComputedStyle(document.body);
    for (const t of WE_HOST_TOKENS) {
      const v = bodyCs.getPropertyValue(t).trim();
      if (v) es.setProperty("--we-host-" + t.slice(2), v);
    }
  } catch { /* ignore */ }
}

function removeFontStyles() {
  // 全局字体配置已不存在 ⇒ 这里只清角色色快照（下次开启重新取；期间可能切了主题）。
  try {
    const es = document.documentElement.style;
    for (const t of WE_HOST_TOKENS) es.removeProperty("--we-host-" + t.slice(2));
  } catch { /* ignore */ }
}

export {
  WE_HOST_TOKENS, componentFontAvailability, componentFontDefaults, fontScopeEl,
  applyComponentFonts, removeComponentFonts, snapshotHostFontDefaults, removeFontStyles,
};
