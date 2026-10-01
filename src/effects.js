/**
 * effects.js — 把设置**应用到 DOM**（CSS 变量、内联样式、光标、scrim）（P1-7 后半）。
 *
 * 为什么单独一个文件：这是"设置 → 界面"的落地层，同一层里同时有 scrim 即时性优化、
 * 玻璃/雾化合成、光标注入、壁纸淡出底色选择四件事（**字体自定义不在这里**，见
 * src/font/apply.js）。它与设置表、求值器一样属于"看得懂的单元"，放在这里就不必在
 * client.js 那一大片正文里定位。
 *
 * 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，因此"外部作用域"= 同一 prelude / src/client.js 的顶层。依赖是**机械清点**
 * 出来的，不是印象）：
 *   selection                    ← 设置/选中项的唯一 store（顶层 const，定义于 client.js 前部）
 *   SCRIM_ID                     ← scrim 元素的固定 id（顶层 const）
 *   GLASS_SATURATE               ← 玻璃饱和度耦合常量（顶层 const）
 *   syncSceneAudio(selLike)      ← 场景音轨同步（顶层 function）
 *   detectMicaSupport()          ← 惰性探针：Mica 支持
 *   detectSoftwareRender()       ← 惰性探针：软件渲染回退
 *   adapterCaps()                ← src/adapter.js（适配目标能力矩阵 → body 属性）
 *   useLegacySaturateCoupling()  ← 惰性探针：`?we-saturate=legacy` 那条旧耦合斜坡是否生效
 *   applyComponentFonts()        ← src/font/apply.js（字体：组件作用域）
 *   removeComponentFonts()       ← 同上
 *   snapshotHostFontDefaults()   ← 同上（宿主角色色快照）
 *   removeFontStyles()           ← 同上
 * 提供的入口：applyEffects() / clearEffects()（client.js 各有一处调用；其余 apply* / remove*
 * 助手仅本文件内部使用，导出是为了让守卫能单独取用）。
 *
 * 不变量：
 *   · **只读 selection、不写它** —— 写设置是 UI 处理器与 apply(ctx) 的事，本文件只负责呈现。
 *   · 内联样式只写自己拥有的属性（`--we-*` 与少数原生属性），清理时必须成对（clearEffects）。
 *   · scrim 的"内联写 + 强制 reflow"只在值**真的变化**时跑（lastScrimCss 记忆）——
 *     每次 emit 都跑会变成 forced synchronous layout 风暴（滑块每格两次 + 500ms 转码轮询）。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     —— 它会被内联到 bundle 顶部（早于 client.js 正文），顶层读 body 里的 const 会撞 TDZ。
 */

// Scrim immediacy tracking: the inline-write + forced reflow below only runs
// when the scrim value ACTUALLY changed. It used to run unconditionally on
// every emit — i.e. twice per slider tick (handler + subscribed applyEffects)
// and on every 500ms transcode poll — a forced synchronous layout storm.
let lastScrimCss = "";

// ── 输入光标颜色注入（#83）──────────────────────────────────────────────────
// <style id="we-caret-patch"> 把 body 上的 --we-caret-color 应用到所有文本
// 输入位（textarea / input / contenteditable）。caret-color 可继承，覆盖到
// contenteditable 的子节点无需逐个枚举；!important 压过宿主可能存在的显式
// caret-color 声明。只在用户选了颜色时注入 —— 未设置时连规则都不进 DOM，
// 光标保持 dsh 原生表现（auto 会随主题自动调整，是最不碍事的默认）。
// 与字体自定义（fontCustom）互不依赖：字体染色关闭时本样式照常生效，反之
// 字体开启而光标未设置时也不注入（fontCustom 的 color 不写 caret-color，
// 两者不冲突）。
function applyCaretStyles() {
  try {
    let st = document.getElementById("we-caret-patch");
    if (!st) {
      st = document.createElement("style");
      st.id = "we-caret-patch";
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = [
      'body textarea,',
      'body input,',
      'body [contenteditable="true"],',
      'body [contenteditable="plaintext-only"],',
      'body [contenteditable=""] {',
      '  caret-color: var(--we-caret-color) !important;',
      '}',
    ].join('\n');
  } catch { /* ignore */ }
}

function removeCaretStyles() {
  const st = document.getElementById("we-caret-patch");
  if (st) st.remove();
}

// 壁纸淡出底色 = **原生外观**（浅色纯白 / 深色纯黑）。这是「壁纸透明度」拉高时
// 应该露出来的那一层：垫在 .we-layer 上让透明化壁纸的合成像素保持不透明（见
// applyEffects 内 --we-wallpaper-opacity 注释：透明 backdrop 会让 backdrop-filter
// 失效）。
// ⚠️ 刻意**不**用 --dsw-alias-bg-layer-1：那是面板底色（深色下是深蓝灰），淡出后
// 会留下一块与原生外观不符的主题色（用户反馈：期望露出纯黑 / 纯白）。
// 外壳自己的「页面基色」token 若可用就尊重它（没有壁纸时页面本来就是这个颜色）；
// 插件在壁纸激活时把它置为 transparent，因此正常路径就是下面的纯黑 / 纯白。
function resolveWallpaperFadeBg() {
  try {
    const t = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
    if (t && t !== "transparent" && t !== "rgba(0, 0, 0, 0)" && t !== "#00000000") return t;
  } catch { /* ignore */ }
  try {
    return document.body.hasAttribute("data-ds-dark-theme") ? "#000000" : "#ffffff";
  } catch { return "#000000"; }
}

// ── 染色地板：可读性底色 = 玻璃色经亮度钳制（色相跟随用户） ──────────────────
// 地板色是**玻璃色经亮度钳制后的版本** —— 深色主题过亮就压暗、浅色主题过暗就提亮，
// 色相交给用户；对比度判据与 #82 同一条网格（正文 vs 表面合成到最坏背衬 ≥4.5:1）。
// 主题白/黑（浅 #ffffff / 深 #0d1524）只在**用户没给玻璃色**时当地板缺省值用。
// 钳制口径与 verify-readability 同款、**不含层权重**：
//   深色最坏 = color·(F + 0.10·0.4·(1−F)) + 白·(1 − (F + 0.10·0.4·(1−F)))  （白背衬、最透档，
//   0.4 = 深色主题的 frost 层因子 —— 与浅色不同，深色的玻璃色份额要先乘 0.4）
//   浅色最坏 = color·(F + 0.10·(1−F))                               （黑背衬、同 alpha）
// 其中 0.10 = 玻璃透明度滑杆拉满后的 --we-glass-alpha（见 applyEffects 的曲线），
// 两处数字必须同步改。纯函数：verify-readability 会从 bundle 里抽出本函数复算网格。
function weClampSurfaceColor(hex, theme) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
  if (!m) return theme === "dark" ? "#0d1524" : "#ffffff";
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const s2l = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * s2l(c[0]) + 0.7152 * s2l(c[1]) + 0.0722 * s2l(c[2]);
  const F = theme === "dark" ? 0.59 : 0.45;
  // 最坏 alpha：最透档（滑杆 60 → --we-glass-alpha 0.10）× 深色主题的 0.4 层因子
  //（与样式表深色 composer 卡的 rgba(255,255,255, calc(--we-glass-alpha * 0.4)) 同源）。
  const darkFactor = theme === "dark" ? 0.4 : 1;
  const aMin = F + 0.10 * darkFactor * (1 - F);
  // 钳制目标 4.6 而非 4.5：二分结果要**四舍五入回 hex**（每通道 1/255 量化），
  // 卡着 4.5 收敛的色经量化后会掉到 4.4997 被守卫判红 —— 留 0.1 的舍入余量。
  const passes = (c) => {
    const comp = c.map((v) => v * aMin + (theme === "dark" ? 255 : 0) * (1 - aMin));
    const contrast = theme === "dark"
      ? 1.05 / (lum(comp) + 0.05)
      : (lum(comp) + 0.05) / 0.05;
    return contrast >= 4.6;
  };
  const toHex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  if (passes(rgb)) return toHex(rgb);
  const target = theme === "dark" ? [0, 0, 0] : [255, 255, 255];
  let lo = 0;  // 不合格端
  let hi = 1;  // 合格端（纯黑/纯白必过：深色 5.79:1、浅色 4.67:1）
  for (let i = 0; i < 12; i++) {
    const t = (lo + hi) / 2;
    const c = rgb.map((v, j) => v * (1 - t) + target[j] * t);
    if (passes(c)) hi = t; else lo = t;
  }
  return toHex(rgb.map((v, j) => v * (1 - hi) + target[j] * hi));
}

function applyEffects() {
  const s = document.body.style;
  s.setProperty("--we-scrim-color", "rgba(0,0,0," + selection.scrim + ")");
  // Border emphasis: the border tokens are low-alpha hairlines; raise their
  // alpha via a neutral gray so both light and dark themes stay legible.
  s.setProperty("--we-border-alpha", String(selection.border));
  // Glass blur strength in px (0 disables the frosted-glass effect).
  s.setProperty("--we-blur", selection.blur + "px");
  // iOS liquid glass: the backdrop "colour melt" (saturation) is a CONSTANT
  // material property, DECOUPLED from the blur radius — the 玻璃 slider now
  // drives ONE thing (frost depth, --we-blur) instead of two semantically
  // unrelated ones. Rationale: --we-saturate amplifies whatever chroma the
  // backdrop still carries, and blur is what smears the residual wallpaper text
  // into that chroma. The old coupled ramp therefore magnified exactly the
  // signal the owner reads as 荧光/彩色鬼影 (a fluorescent colour ghost) instead
  // of a neutral haze, worst at the top of the slider where the amplification
  // met the most smearing. A flat value kills the runaway at high radii while
  // keeping the "wet glass" chroma lift at every radius. GLASS_SATURATE is
  // deliberately BELOW the stylesheet's own 1.8 fallback (what applies before
  // this variable is first written), so the steady-state glass is milder than
  // the pre-write default rather than stronger.
  //   blur px:     0      15     30     45     60
  //   old:       1.15   1.57   1.99   2.41   2.83   (1.15 + blur*0.028)
  //   new:       1.30   1.30   1.30   1.30   1.30   (constant; 6.1x less chroma
  //                                                  amplification at 60px)
  // ?we-saturate=legacy restores the old coupled ramp byte-for-byte (A/B
  // escape hatch, see useLegacySaturateCoupling).
  s.setProperty("--we-saturate", useLegacySaturateCoupling()
    ? String(1.15 + selection.blur * 0.028)
    : String(GLASS_SATURATE));
  s.setProperty("--we-glass-brightness", "1.04");
  // Wallpaper blur strength in px (blurs the wallpaper itself).
  s.setProperty("--we-wallpaper-blur", selection.wallpaperBlur + "px");
  // Background media filter: blur() plus the brightness/contrast/saturate
  // knobs, omitting untouched terms. Kept "none" while every knob is at its
  // default (see .we-media above) so no offscreen filter layer is forced on
  // the wallpaper video/canvas.
  const filterTerms = [];
  if (selection.wallpaperBlur > 0) filterTerms.push("blur(" + selection.wallpaperBlur + "px)");
  if (selection.backgroundBrightness !== 100) filterTerms.push("brightness(" + selection.backgroundBrightness + "%)");
  if (selection.backgroundContrast !== 100) filterTerms.push("contrast(" + selection.backgroundContrast + "%)");
  if (selection.backgroundSaturate !== 100) filterTerms.push("saturate(" + selection.backgroundSaturate + "%)");
  s.setProperty("--we-media-filter", filterTerms.length ? filterTerms.join(" ") : "none");
  // Compensate for the fringe the blur reveals by scaling the layer up.
  const scale = (1 + selection.wallpaperBlur * 0.006).toFixed(4);
  s.setProperty("--we-wallpaper-scale", scale);
  // Horizontal mirror: composed with the blur-compensation scale on the same
  // transform (scaleX(-1) is a pure compositor operation).
  s.setProperty("--we-wallpaper-flip", selection.flip ? "-1" : "1");
  // Single transform var, "none" when identity (no blur, no flip): an identity
  // scale(1) scaleX(1) still forces the full-screen wallpaper <video> onto a
  // transform compositing layer at default — one less always-on layer for the
  // kiosk window to glitch on (the previous anti-flicker pass left this).
  s.setProperty("--we-wallpaper-transform",
    (selection.wallpaperBlur > 0 || selection.flip)
      ? ("scale(" + scale + ") scaleX(" + (selection.flip ? "-1" : "1") + ")")
      : "none");
  // Fit mode for the current wallpaper (consumed by .we-media--fit).
  s.setProperty("--we-object-fit", selection.objectFit);
  // 壁纸透明度（#82）：越大越透 —— 0% 时不设变量，保持 identity opacity
  // （Blink 对 opacity:1 不建合成层，设置了反而给 kiosk 窗口多一层常驻合成）。
  // 渲染引擎约束（实测）：DSH 页面底色是透明的，壁纸层一旦整体
  // 半透明，玻璃表面 backdrop-filter 的取样背景出现大面积透明像素，本
  // Electron 合成器在该背景上不再有效模糊 —— 玻璃后文字透出（composer 区
  // 高频能量 +90%）。修复：透明生效时给 .we-layer 垫主题实色（--we-wallpaper-
  // fade-bg），opacity 移到 .we-media 叶子 —— layer 合成像素保持不透明
  // （壁纸向页面底色淡出，语义不变），玻璃模糊恢复（实测锐度回到基线）。
  // 暗化（scrim）叠在壁纸之上：淡出壁纸时它会同时压暗页面底色。
  if (selection.wallpaperOpacity > 0) {
    s.setProperty("--we-wallpaper-opacity", String((100 - selection.wallpaperOpacity) / 100));
    s.setProperty("--we-wallpaper-fade-bg", resolveWallpaperFadeBg());
  } else {
    s.removeProperty("--we-wallpaper-opacity");
    s.removeProperty("--we-wallpaper-fade-bg");
  }

  // Settings-page liquid-glass theming:
  // - --we-accent: plugin-owned accent color; every fallback below that used
  //   the shell's brand token (var(--dsw-alias-brand-primary, #4f8cff)) now
  //   reads --we-accent first, so the 配色 control restyles the whole picker
  //   and glass highlights without touching the shell theme.
  s.setProperty("--we-accent", selection.accent);
  // - --we-glass-alpha: white-overlay alpha of the glass surfaces. The 玻璃透明
  //   度 slider semantics: higher = MORE transparent (clearer wallpaper shows
  //   through), lower = closer to solid. 0% → ~0.25 (frosted, solid-ish),
  //   60% → ~0.10 (轻霜 —— 染色地板下限不再让颜色在拉满端消失，旧值 0.03 会让
  //   玻璃色份额塌到 ~1%、只剩主题底色 = 用户报的"拉满变黑/变白")。
  const glassAlpha = Math.max(0.10, 0.25 - (selection.glassAlpha / 60) * 0.15);
  s.setProperty("--we-glass-alpha", String(glassAlpha));
  // - --we-glass-color: glass base tint of the settings window. The stock
  //   defaults live in CSS (white glass light / deep navy dark); once the user
  //   picks a color (玻璃颜色), both themes use it.
  s.setProperty("--we-glass-color", selection.glassColor);
  // - 染色地板：按主题把玻璃色钳制进可读亮度带，供样式表的
  //   --we-readability-base（地板层）与全部 frost 槽位消费 —— 对话框/侧栏等
  //   宿主表面由此拿到**用户的色相**而非主题白/黑，正文对比度判据不变。
  s.setProperty("--we-surface-tint-light", weClampSurfaceColor(selection.glassColor, "light"));
  s.setProperty("--we-surface-tint-dark", weClampSurfaceColor(selection.glassColor, "dark"));
  // RGB 三元组形式：给 rgba() 槽位用（消息气泡 / 输入框的白釉染色）。
  // ⚠️ 下标 [0,2,4] —— 6 位 hex 不带 '#'，[1,3,5] 是带 '#' 时代的错位写法。
  const toRgbTriple = (hex) => {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(", ") : "255, 255, 255";
  };
  s.setProperty("--we-surface-tint-rgb-light", toRgbTriple(weClampSurfaceColor(selection.glassColor, "light")));
  s.setProperty("--we-surface-tint-rgb-dark", toRgbTriple(weClampSurfaceColor(selection.glassColor, "dark")));
  // - Master switch for the WHOLE native settings window: when on, the dialog
  //   (nav + every native section) becomes liquid glass with the accent +
  //   transparency above. Toggled instantly via a body attribute the scoped
  //   CSS below keys on; off restores the shell's stock look.
  if (selection.glassWindow) document.body.setAttribute("data-we-glass-window", "on");
  else document.body.removeAttribute("data-we-glass-window");

  // dsh-better-sidebar 液态玻璃：一套独立于会话玻璃的细粒度控制（侧栏模糊 /
  // 侧栏透明度 / 侧栏玻璃颜色 + 总开关）。变量只作用于 [data-dsh-better-sidebar]
  // 子树（CSS 见下），关闭总开关时侧栏恢复原生外观。
  s.setProperty("--we-sidebar-blur", selection.sidebarBlur + "px");
  s.setProperty("--we-sidebar-saturate", String(1.15 + Math.min(selection.sidebarBlur, 60) * 0.028));
  // 透明度语义：越大越透。0 → alpha 0.32（最实/最密），200 → alpha 0.015（最透）。
  const sidebarAlpha = Math.max(0.015, 0.32 - (selection.sidebarAlpha / 200) * 0.305);
  s.setProperty("--we-sidebar-alpha", String(sidebarAlpha));
  s.setProperty("--we-sidebar-sheen", String(Math.min(1, sidebarAlpha / 0.2236)));
  s.setProperty("--we-sidebar-color", selection.sidebarColor);
  // 侧栏玻璃颜色的混入强度（%）：**独立于 alpha 的可见性曲线** —— alpha 在高透档
  // 趋近 0，混色若跟着 alpha 走，颜色滑杆在最高档就等于失效（低于可感知阈值）。
  // 因此随透明度滑杆线性映射 20%–48%：最透档也有可感知色染，往实调颜色越来越浓。
  const sidebarTint = 20 + (200 - Math.min(Math.max(selection.sidebarAlpha, 0), 200)) / 200 * 28;
  s.setProperty("--we-sidebar-tint", sidebarTint.toFixed(1) + "%");
  if (selection.sidebarGlass) document.body.setAttribute("data-we-sidebar-glass", "on");
  else document.body.removeAttribute("data-we-sidebar-glass");
  // 内容面（编辑器/终端）近不透明玻璃底：透明度滑块 0–80 → 不透明度 100%–20%
  // （越大越透，与玻璃透明度同语义；低于 ~40% 不透明度注释可读性会再次变差，
  // 留给用户自行权衡）；底色空 = 跟随主题面板色，选定后自定义。
  // 注意 color-mix 的百分比槽位要求带单位的 token —— 变量值必须含 "%"，
  // 否则整个 color-mix 失效、底色规则被丢弃（编辑器回退到纯透明毛玻璃）。
  s.setProperty("--we-content-surface-alpha", Math.max(20, 100 - selection.sidebarContentAlpha) + "%");
  if (selection.sidebarContentColor) s.setProperty("--we-content-surface-color", selection.sidebarContentColor);
  else s.removeProperty("--we-content-surface-color");

  // 适配目标钩子（src/adapter.js）：把最终目标挂到 <body>，外壳材质类选择器
  // 一律经 [data-we-adapter^="desktop-"] 门控 —— 原生浏览器形态永远不吃桌面壳
  // 的材质规则。取值恒为三档之一（auto 在 resolve 里已被消解），手选改动后
  // 下一次 applyEffects 就换值；与其它 body 钩子一样成对清理。
  document.body.setAttribute("data-we-adapter", adapterCaps().target);

  // 左侧工作区（增强模式）的 Mica 能力钩子（#73，见 detectMicaSupport）：Windows
  // 上无 Mica（Win10 / build < 22621 / 探测不到）时挂 data-we-mica="off"，CSS 用
  // 插件自己的近不透明玻璃面接管 .dshDesktopSidebarSurface，替代对系统材质的依赖；
  // 支持或不适用（非 Windows）时移除，保持原生。探测结果缓存，这里只做同步读写。
  if (detectMicaSupport() === false) document.body.setAttribute("data-we-mica", "off");
  else document.body.removeAttribute("data-we-mica");

  // 软件渲染钩子（#95，见 detectSoftwareRender）：@supports 只做语法检查，软件
  // 合成下 backdrop-filter 被静默忽略时它依然为真，所以近不透明回退必须靠运行时
  // 探测来挂载。命中时 CSS（body[data-we-glass-fallback]）让面板/侧栏/内容面/
  // 弹层改用与 @supports 回退完全相同的配方，并显式 backdrop-filter: none。
  if (detectSoftwareRender()) document.body.setAttribute("data-we-glass-fallback", "1");
  else document.body.removeAttribute("data-we-glass-fallback");

  // 字体自定义：**已无任何全局字体配置** —— 只剩「按角色」（颜色/排版/字重/字族，见
  // src/font/color-roles.js 与 typography.js）与「按组件」（src/font/components.js）
  // 两套作用域覆盖。这里只做两件事：取一次宿主角色色快照（面板要显示「当前默认色」）、
  // 同步组件样式表（没配就当没有，清空样式表）。
  if (selection.fontCustom) {
    snapshotHostFontDefaults();
    applyComponentFonts();
  } else {
    removeFontStyles();
    removeComponentFonts();
  }

  // 输入光标颜色（#83）：空 = 跟随 dsh 原生（清空变量 + 不注入样式表）；
  // 选定颜色后经 we-caret-patch 以 !important 覆盖所有文本输入位。与壁纸
  // 是否启用无关 —— 这是独立的可读性设置，壁纸关掉后依然生效。
  if (selection.caretColor) {
    s.setProperty("--we-caret-color", selection.caretColor);
    applyCaretStyles();
  } else {
    s.removeProperty("--we-caret-color");
    removeCaretStyles();
  }
  // 壁纸音轨随设置变化即时生效（音量滑块/总开关），场景包内音频同理。
  syncSceneAudio(selection);

  // Scrim immediacy: some composited/kiosk environments do not repaint a
  // z-index:-1 layer promptly when only an inherited CSS variable changes.
  // Write the resolved color DIRECTLY onto the scrim element's inline style and
  // then force a synchronous layout — but ONLY when the value changed (see
  // lastScrimCss above).
  const scrimCss = "rgba(0,0,0," + selection.scrim + ")";
  if (scrimCss !== lastScrimCss) {
    lastScrimCss = scrimCss;
    const scrim = document.getElementById(SCRIM_ID);
    if (scrim) {
      scrim.style.background = scrimCss;
    }
    // Force reflow so a stalled compositor picks up the new value immediately.
    if (document.body) {
      void document.body.offsetHeight;
    }
  }
}

function clearEffects() {
  const s = document.body.style;
  s.removeProperty("--we-scrim-color");
  s.removeProperty("--we-border-alpha");
  s.removeProperty("--we-blur");
  s.removeProperty("--we-saturate");
  s.removeProperty("--we-glass-brightness");
  s.removeProperty("--we-wallpaper-blur");
  s.removeProperty("--we-media-filter");
  s.removeProperty("--we-wallpaper-scale");
  s.removeProperty("--we-wallpaper-flip");
  s.removeProperty("--we-object-fit");
  s.removeProperty("--we-wallpaper-opacity");
  s.removeProperty("--we-wallpaper-fade-bg");
  s.removeProperty("--we-accent");
  s.removeProperty("--we-glass-alpha");
  s.removeProperty("--we-glass-color");
  s.removeProperty("--we-surface-tint-light");
  s.removeProperty("--we-surface-tint-dark");
  s.removeProperty("--we-surface-tint-rgb-light");
  s.removeProperty("--we-surface-tint-rgb-dark");
  document.body.removeAttribute("data-we-glass-window");
  s.removeProperty("--we-sidebar-blur");
  s.removeProperty("--we-sidebar-saturate");
  s.removeProperty("--we-sidebar-alpha");
  s.removeProperty("--we-sidebar-sheen");
  s.removeProperty("--we-sidebar-color");
  s.removeProperty("--we-sidebar-tint");
  document.body.removeAttribute("data-we-sidebar-glass");
  document.body.removeAttribute("data-we-adapter"); // 适配目标钩子随 fiber 注销
  document.body.removeAttribute("data-we-mica"); // #73 Mica 能力钩子随 fiber 注销
  document.body.removeAttribute("data-we-glass-fallback"); // #95 软件渲染回退钩子同上
  s.removeProperty("--we-content-surface-alpha");
  s.removeProperty("--we-content-surface-color");
  // 画布兜底色写在根元素上（见 src/live-layer.js 的 refreshUnderlayColor）：它不在
  // body 的变量表里，必须显式撤掉 —— 否则禁用插件后根元素会一直带着上一张壁纸的颜色。
  clearUnderlayColor();
  removeFontStyles();
  s.removeProperty("--we-caret-color");
  removeCaretStyles();
  selection.sceneAudioUrl = null;
  selection.sceneHasAudio = false;
  syncSceneAudio(selection);
  const scrim = document.getElementById(SCRIM_ID);
  if (scrim) scrim.style.background = "";
  lastScrimCss = "";
  // 插件卸载（禁用 / HMR）后不该留下上一张壁纸的播放错误 / 被过滤提示（#84）。
  selection.videoPlaying = true;
  selection.videoError = "";
  selection.blockedNote = "";
}
export {
  applyEffects, clearEffects,
  applyCaretStyles, removeCaretStyles, resolveWallpaperFadeBg,
};
