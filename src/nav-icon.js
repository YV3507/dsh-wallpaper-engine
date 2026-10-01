/**
 * nav-icon.js — 「壁纸引擎」SVG 图标 + 设置导航图标补丁。
 *
 * 为什么单独一个文件：图标有两张消费面 —— ① 设置对话框左 nav（DOM 补丁，官方
 * `settings.section` 注册只收 id/order/label，图标是 shell 里 `navIcon(id)` 的硬编码
 * 映射，未知 section 一律给兜底齿轮，想换只能 DOM 替换）；② 官方右侧栏的 guide
 * 卡片（React 上下文，`icon: ComponentType<IconProps>`）。一个管 DOM 一个管 React，
 * 放在哪个面板渲染器里都别扭，独立成模块，图标的**几何**只在这里维护一份。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   · `WE_ICON_PARTS` 是图标几何的**唯一真源**（零件表）；`renderWeIcon`（React 元素）
 *     与 `weIconSvgString`（DOM innerHTML 字符串）都由它现算 —— 改图标只动那张表。
 *   · `renderWeIcon` 在**调用时**才读 React（同 panel-tabs.js 的口径）：本模块被内联到
 *     prelude，而 `const React = require("react")` 在 client.js 正文顶部，顶层读会撞 TDZ。
 *   · `installWeNavIcon()` 是纯 DOM 补丁：失败（结构变了 / 找不到按钮）的语义是
 *     **保留官方兜底齿轮**，绝不抛、绝不反复重试。返回 disposer（或 null = 没装上）。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 */

// ── 图标几何（唯一真源）──────────────────────────────────────────────────────
// 设计：画框 + 太阳 + 山峦（壁纸 = 一张画），线条风格对齐官方图标族（16px 网格、
// 描边、圆角线帽线接、currentColor 跟随文本色）。描边宽度 1.4：nav 里 16px 实渲染
// 时 1.5 偏糊、1.25 偏弱，1.4 与官方 OutlineMedium 族视觉重量最接近。
const WE_ICON_PARTS = [
  ["rect", { x: "1.7", y: "2.7", width: "12.6", height: "10.6", rx: "2.2" }],
  ["circle", { cx: "5.4", cy: "6.1", r: "1.05" }],
  ["path", { d: "M2.2 11.5l3-2.8 2.2 1.7 2.8-3 3.6 3.9" }],
];
const WE_ICON_VIEW_BOX = "0 0 16 16";

/** React 版图标（官方侧栏 guide 卡片等 React 上下文）：IconProps 形态（size / className）。 */
function renderWeIcon(props) {
  const size = (props && Number(props.size)) || 16;
  return React.createElement("svg", {
    viewBox: WE_ICON_VIEW_BOX,
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.4",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    className: (props && props.className) || undefined,
    "aria-hidden": "true",
    focusable: "false",
  }, WE_ICON_PARTS.map(([tag, attrs]) => React.createElement(tag, attrs)));
}

/** 字符串版图标（DOM 补丁的 innerHTML 用）。 */
function weIconSvgString(size) {
  const attrs = 'viewBox="' + WE_ICON_VIEW_BOX + '" width="' + size + '" height="' + size
    + '" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"'
    + ' stroke-linejoin="round" aria-hidden="true" focusable="false"';
  const inner = WE_ICON_PARTS.map(([tag, attrs2]) => "<" + tag + " "
    + Object.keys(attrs2).map((k) => k + '="' + attrs2[k] + '"').join(" ") + "/>").join("");
  return "<svg " + attrs + ">" + inner + "</svg>";
}

// ── 设置导航图标补丁 ─────────────────────────────────────────────────────────
// 官方设置对话框的 nav 是 body 直接传送门（createPortal(..., document.body)），
// nav 按钮 = [图标元素, label 文本]。补丁在 overlay 挂进 body 时找到文本恰为
// 本插件 nav label 的按钮，把第一个子元素（兜底齿轮）换成同 class 的我们的图标 ——
// class 照抄是为了继承 shell 的 flex/尺寸约束（hash 类名会变，但抄的是**那个元素**
// 当前的 class，不是写死的 hash）。label 文本是我们自己注册的，是最稳定的锚 ——
// 它**随语言变**（en 下是 "Wallpaper Engine"）⇒ 匹配时现取 `weT("壁纸引擎")`；
// 语言切换后由 weOnLocaleChange 重放一次（已是本图标则跳过，见 data-we-nav-icon）。
function installWeNavIcon() {
  if (typeof document === "undefined" || !document.body) return null;
  if (typeof MutationObserver !== "function") return null;
  let patched = new WeakSet();
  const patchIn = (root) => {
    if (!root || typeof root.querySelectorAll !== "function") return;
    let buttons = [];
    try { buttons = root.querySelectorAll("nav button"); } catch { return; }
    const want = weT("壁纸引擎");
    for (const btn of buttons) {
      try {
        if (patched.has(btn)) continue;
        if ((btn.textContent || "").trim() !== want) continue;
        const iconEl = btn.firstElementChild;
        // 结构异常（没有独立图标子元素）= 放弃这枚按钮，保齿轮。
        if (!iconEl || iconEl === btn.lastElementChild && btn.childElementCount < 2) continue;
        // 已经是我们的图标（语言切换触发的重放）⇒ 只登记、不重复替换。
        try { if (iconEl.getAttribute("data-we-nav-icon") === "1") { patched.add(btn); continue; } } catch { /* ignore */ }
        const span = document.createElement("span");
        span.className = iconEl.className;
        span.setAttribute("data-we-nav-icon", "1");
        span.innerHTML = weIconSvgString(16);
        btn.replaceChild(span, iconEl);
        patched.add(btn);
      } catch { /* 单个按钮失败不影响其它 */ }
    }
  };
  // 设置对话框可能已开着（HMR / 插件热重载）：先补一次现况。
  patchIn(document.body);
  // overlay 是 body 的**直接**子节点 ⇒ 只盯 body 的一层 childList，不为子树变动买单。
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n && n.nodeType === 1) { patchIn(n); }
      }
    }
  });
  try { obs.observe(document.body, { childList: true }); } catch { return null; }
  // 语言切换：注册的 label 换了文字，nav 行要按新 label 重新认一次。
  const offLocale = weOnLocaleChange(() => {
    patched = new WeakSet();
    patchIn(document.body);
  });
  return () => {
    try { obs.disconnect(); } catch { /* ignore */ }
    try { offLocale(); } catch { /* ignore */ }
  };
}
