/**
 * effects.js — 把设置**应用到 DOM**（CSS 变量、内联样式、字体/光标、scrim）（P1-7 后半）。
 *
 * 为什么单独一个文件：这是"设置 → 界面"的唯一落点，约 460 行里同时有 scrim 即时性优化、
 * 玻璃/雾化合成、字体与光标注入、壁纸淡出底色选择五件事。它与设置表、求值器一样属于
 * "看得懂的单元"，此前埋在 src/client.js 中段，任何改动都要在 9,600 行里定位。
 *
 * 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，因此"外部作用域"= src/client.js 的顶层。依赖是**机械清点**出来的，不是印象）：
 *   selection                    ← 设置/选中项的唯一 store（顶层 const，定义于 client.js 前部）
 *   SCRIM_ID                     ← scrim 元素的固定 id（顶层 const）
 *   GLASS_SATURATE               ← 玻璃饱和度耦合常量（顶层 const）
 *   fontFamilyStack(v)           ← 字体族 → CSS 字体栈（顶层 function）
 *   syncSceneAudio(selLike)      ← 场景音轨同步（顶层 function）
 *   detectMicaSupport()          ← 惰性探针：Mica 支持
 *   detectSoftwareRender()       ← 惰性探针：软件渲染回退
 *   useLegacySaturateCoupling()  ← 惰性探针：旧版饱和度耦合
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
// ── 字体自定义样式注入 ──────────────────────────────────────────────────────
// <style id="we-font-patch"> 应用「字体自定义」三项（#91 修复，方案A升级版）：
// 旧实现 body * { color/weight/family !important } 会 ① 强制覆盖其它插件
// 自带的文字颜色（白字白底"字消失"，#91）；② 压平全页加粗（DSH 标题的
// 700 也被抹成设置值）；③ 失效范围遍布整棵 DOM。新语义是「改默认墨色 +
// 主题文本令牌」，不再碰任何自带声明：
// - body 级只设继承默认 —— 自己声明过 color/font-weight 的元素（第三方
//   挂件、DSH 标题加粗）保持自己的声明；
// - 颜色经 --dsw-alias-label-* 中性白名单映射为用户字体色（DSH 核心约 90%
//   的文字颜色走这几个令牌，含聊天正文 label-primary），核心 UI 覆盖不缩水；
//   state-* 与 link 令牌刻意排除 → 报错红字/链接色天然保住（替代旧规则 2 的
//   revert —— 实测 revert 回滚整个 author 源，会把宿主自己的错误色声明一并
//   取消，见 #91 讨论）；
// - 注入前把宿主原值快照进 --we-host-*（只取一次，防自我污染），供
//   [data-we-font-ignore] 子树契约「还原宿主原值」使用：自定义属性可被子树
//   遮蔽，第三方一行属性即可声明「这块我自管颜色」（#91 建议 2）；
// - 聊天 markdown 容器用 font: var(--dsw-font-markdown-base) 简写同时声明
//   font-family/weight，body 级继承压不过它 —— 需要定向接管族与字重，
//   否则用户的字族/字重在对话区"看起来没生效"；
// - 面板铬字（原规则 3）改读快照值 —— 令牌已被映射，不能直接读。
// 总开关 fontCustom 关闭时注入整体清空（含快照），页面回到 dsh 原生字体外观。
// 白闪红线（v0.6.4 起）：不要引入 :has() 或祖先相关选择器——祖先失效集
// 会把点击/输入的样式重算扩大到整棵 DOM，是 kiosk 窗口整屏刷白的点火条件。
const WE_HOST_TOKENS = [
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-label-dimmed",
];

/**
 * 折叠行（把四个文字角色压成同一个用户色）：**只对令牌层没接管的角色输出**。
 *
 * 为什么必须让位：这四行带 `!important`，而「作者样式表的 !important」在级联上**高于**
 * 「普通内联声明」—— 令牌层写的正是 body 内联。照旧输出的话，用户在面板里按角色设的颜色
 * 会被这四行原样压回去，表现就是"改了没反应"。没被接管的角色照旧折叠（回落通道的行为不变）。
 */
function themeCollapseLines() {
  const owned = typeof themeLayerOwnedRoles === "function" ? themeLayerOwnedRoles() : [];
  const prefix = "--dsw-alias-label-";
  return WE_HOST_TOKENS
    .filter((t) => !owned.includes(t.slice(prefix.length)))
    .map((t) => "  " + t + ":var(--we-font-color) !important;");
}

function snapshotHostFontDefaults() {
  // applyFontStyles 每次滑杆回调都会执行：若已快照则跳过，否则会把上一轮
  // 注入后的自家映射值当成宿主原值写进快照（自我污染）。removeFontStyles
  // 会清空快照，重新开启时再取一次（期间若宿主切了主题，取到的就是新主题
  // 的墨色 —— 快照在开启期间不跟随主题切换，属已知边界）。
  // 读取范围是 body 而不是 :root —— 宿主把 --dsw-alias-* 定义在 body 层
  // （body / body[data-ds-dark-theme]），:root 上算出来是空串。
  // 防污染关键：若 patch 样式已存在（上次注入留下的），先清空其内容再读。
  // 否则「首次快照时宿主 CSS 未就绪 → 令牌读空跳过 → 下次重试时自家映射
  // 已生效 → 读回 #ffffff 自我污染」这条链必然发生（getComputedStyle 是
  // 惰性的，清空后同步读会强制按干净级联重算）。调用方随后会重写
  // st.textContent，中间不会发生绘制。
  try {
    const es = document.documentElement.style;
    let need = !es.getPropertyValue("--we-host-body-color");
    for (const t of WE_HOST_TOKENS) {
      if (!es.getPropertyValue("--we-host-" + t.slice(2))) { need = true; break; }
    }
    if (!need) return;
    const st = document.getElementById("we-font-patch");
    const prevCss = st ? st.textContent : null;
    if (st) st.textContent = "";
    const bodyCs = getComputedStyle(document.body);
    for (const t of WE_HOST_TOKENS) {
      const v = bodyCs.getPropertyValue(t).trim();
      if (v) es.setProperty("--we-host-" + t.slice(2), v);
    }
    es.setProperty("--we-host-body-color", bodyCs.color);
    es.setProperty("--we-host-body-weight", bodyCs.fontWeight);
    es.setProperty("--we-host-body-family", bodyCs.fontFamily);
    if (st) st.textContent = prevCss;
  } catch { /* ignore */ }
}

function applyFontStyles() {
  try {
    snapshotHostFontDefaults();
    let st = document.getElementById("we-font-patch");
    if (!st) {
      st = document.createElement("style");
      st.id = "we-font-patch";
      (document.head || document.documentElement).appendChild(st);
    }
    st.textContent = [
      /* 1) 默认墨色/字重/字族：只设 body 继承默认（声明 > 继承，所以任何
            自带声明的元素——包括第三方挂件与 DSH 标题——都不再被碰）。 */
      'body {',
      '  color:var(--we-font-color, #000) !important;',
      '  font-weight:var(--we-font-weight, 400) !important;',
      '  font-family:var(--we-font-family, inherit) !important;',
      // 伪粗描边跟随字重滑条（见 applyEffects 的映射）；宿主从不声明
      // text-stroke，这里作为继承默认即可，不用 !important。
      '  -webkit-text-stroke-width:var(--we-font-stroke, 0px);',
      '}',
      /* 1b) 聊天正文定向映射：DSH 的 markdown 容器用 font: var(--dsw-font-
            markdown-base) 简写同时声明 font-family/weight，body 级继承压不过
            它 —— 用户选的字族/字重在对话区会"看起来没生效"（颜色经令牌映射
            已生效，但暗色主题下白字与主题墨色接近，更看不出差别）。对宿主
            自己的聊天文本面定向接管族与字重（font 简写里的字号/行高不碰），
            仍是单属性声明级覆盖，不是 body * 全局强制（#91 边界不变）。 */
      'body :is([class*="_markdown_"], [class*="markdownPayload"], [class*="markdownPreview"]) {',
      '  font-family:var(--we-font-family, inherit) !important;',
      '  font-weight:var(--we-font-weight, 400) !important;',
      '}',
      /* 2) 主题文本令牌白名单映射：中性 label 层级跟用户字体色走（覆盖核心
            UI 与聊天正文）；state-* 与 link 令牌不在白名单（报错红字/链接色保
            留主题设计）。声明在 body 而非 :root —— 宿主令牌就定义在 body 层
            （body / body[data-ds-dark-theme] 特异性更高），且 --we-font-* 变量
            也挂在 body 上（:root 读不到子元素变量会 invalid）。!important 压过
            宿主的同名正常声明；第三方/插件面板在自己子树重新声明同名令牌即可
            遮蔽（自定义属性按元素级联，body 的 !important 不影响子树自身声明）。 */
      'body {',
      // 角色色被令牌层接管的那些让位（见 themeCollapseLines 的注释）。
      ...themeCollapseLines(),
      '}',
      /* 3) 退出契约（#91 建议 2）：data-we-font-ignore 子树还原宿主原值。
            :where() 零特异性 —— 还原声明足以压过 body 继承（声明 > 继承），
            但子树内自带的任何颜色/字重声明仍按正常级联压过还原值（即"我自管"
            的部分照常生效）。不用 revert：实测 revert 回滚整个 author 源，会把
            子树自己的声明一并取消（Chrome 实测）。 */
      ':where([data-we-font-ignore]) {',
      '  color:var(--we-host-body-color, inherit);',
      '  font-weight:var(--we-host-body-weight, 400);',
      '  font-family:var(--we-host-body-family, inherit);',
      '  -webkit-text-stroke-width:0;',
      '  --dsw-alias-label-primary:var(--we-host-dsw-alias-label-primary, inherit);',
      '  --dsw-alias-label-secondary:var(--we-host-dsw-alias-label-secondary, inherit);',
      '  --dsw-alias-label-tertiary:var(--we-host-dsw-alias-label-tertiary, inherit);',
      '  --dsw-alias-label-dimmed:var(--we-host-dsw-alias-label-dimmed, inherit);',
      '}',
      /* 4) 插件面板铬字：调节面板（设置页 / 壁纸仓库抽屉 / 选择弹窗）是控件
            而非内容 —— 标签/读数/页签保持主题墨色（可读性优先），用户的字体
            「颜色」只作用于聊天内容。容器级令牌还原（普通声明压过 body 的继
            承值，且容器内任何 --we-ink 消费者一并回到宿主原值）+ 下方两条对
            显式铬字类名的直接染色（读宿主快照，令牌此时已被规则 2 映射）。 */
      'body :is(.we-picker, .we-picker__modal, .we-repo-panel) {',
      '  --dsw-alias-label-primary:var(--we-host-dsw-alias-label-primary, inherit);',
      '  --dsw-alias-label-secondary:var(--we-host-dsw-alias-label-secondary, inherit);',
      '  --dsw-alias-label-tertiary:var(--we-host-dsw-alias-label-tertiary, inherit);',
      '  --dsw-alias-label-dimmed:var(--we-host-dsw-alias-label-dimmed, inherit);',
      '}',
      'body :is(.we-picker, .we-picker__modal, .we-repo-panel) '
        + ':is(.we-picker__ctl-label,.we-picker__card-name,.we-picker__current-title,'
        + '.we-picker__btn,.we-picker select,.we-picker__text,.we-tabs__tab,'
        + '.we-repo-panel__title,.we-picker__mascot-name,.we-picker__empty-title) {',
      '  color: var(--we-host-dsw-alias-label-primary, inherit) !important;',
      '}',
      'body :is(.we-picker, .we-picker__modal, .we-repo-panel) '
        + ':is(.we-picker__hint,.we-picker__ctl-hint,.we-picker__value,'
        + '.we-picker__section-label,.we-picker__card-desc,.we-picker__card-badge,'
        + '.we-picker__current-meta,.we-picker__uploads-name,.we-picker__uploads-path) {',
      '  color: var(--we-host-dsw-alias-label-tertiary, rgba(128, 128, 128, 0.75)) !important;',
      '}',
    ].join('\n');
  } catch { /* ignore */ }
}

function removeFontStyles() {
  const st = document.getElementById("we-font-patch");
  if (st) st.remove();
  // 宿主原值快照随开关一起清掉：下次开启重新取（可能已切主题）。
  try {
    const es = document.documentElement.style;
    for (const t of WE_HOST_TOKENS) es.removeProperty("--we-host-" + t.slice(2));
    es.removeProperty("--we-host-body-color");
    es.removeProperty("--we-host-body-weight");
    es.removeProperty("--we-host-body-family");
  } catch { /* ignore */ }
}

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
  //   60% → ~0.03 (nearly invisible glass). The 12% default ≈ the previous
  //   hardcoded look (~0.15–0.2 white overlay).
  const glassAlpha = Math.max(0.03, 0.25 - (selection.glassAlpha / 60) * 0.22);
  s.setProperty("--we-glass-alpha", String(glassAlpha));
  // - --we-glass-color: glass base tint of the settings window. The stock
  //   defaults live in CSS (white glass light / deep navy dark); once the user
  //   picks a color (玻璃颜色), both themes use it.
  s.setProperty("--we-glass-color", selection.glassColor);
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
  // 侧栏玻璃颜色的混入强度（%）：独立于 alpha 的可见性曲线。alpha 在高透档
  // 趋近 0，若混色跟着 alpha 走，颜色滑杆在最高档等于失效（0.4%–1% 不可感知，
  // v0.7.2 首版 6%–8% 下限仍被反馈"非常不明显"）。改为随透明度滑杆线性映射
  // 20%–48%：最透档也有可感知色染，往实调颜色越来越浓。
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

  // 字体自定义（#57 精简回归版）：开关关闭 → 清空变量与样式表，恢复原生外观。
  if (selection.fontCustom) {
    s.setProperty("--we-font-color", selection.fontColor);
    s.setProperty("--we-font-weight", String(selection.fontWeight));
    // 字重滑条的伪粗描边：中文系统字体（黑体/宋体/楷体等）大多只有单一字面，
    // Chrome 字体匹配对 <600 一律落回常规面、≥600 一律合成粗体 —— 滑条在
    // 视觉上塌成两档。按超出 400 的比例线性映射 -webkit-text-stroke-width
    // （继承属性，覆盖路径与 font-family 一致：正文 + 聊天区），让每一档都有
    // 可感知的粗细差。低于 400 无法把单字面变细，描边为 0；多字重/可变字体
    // 则由真实字面与少量描边叠加生效。900 档 0.045em 在 15px 正文约 0.68px。
    const strokeEm = selection.fontWeight > 400
      ? ((selection.fontWeight - 400) / 500) * 0.045 : 0;
    s.setProperty("--we-font-stroke", strokeEm.toFixed(4) + "em");
    s.setProperty("--we-font-family", fontFamilyStack(selection.fontFamily));
    applyFontStyles();
  } else {
    s.removeProperty("--we-font-color");
    s.removeProperty("--we-font-weight");
    s.removeProperty("--we-font-stroke");
    s.removeProperty("--we-font-family");
    removeFontStyles();
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
  document.body.removeAttribute("data-we-glass-window");
  s.removeProperty("--we-sidebar-blur");
  s.removeProperty("--we-sidebar-saturate");
  s.removeProperty("--we-sidebar-alpha");
  s.removeProperty("--we-sidebar-sheen");
  s.removeProperty("--we-sidebar-color");
  s.removeProperty("--we-sidebar-tint");
  document.body.removeAttribute("data-we-sidebar-glass");
  document.body.removeAttribute("data-we-mica"); // #73 Mica 能力钩子随 fiber 注销
  document.body.removeAttribute("data-we-glass-fallback"); // #95 软件渲染回退钩子同上
  s.removeProperty("--we-content-surface-alpha");
  s.removeProperty("--we-content-surface-color");
  s.removeProperty("--we-font-color");
  s.removeProperty("--we-font-weight");
  s.removeProperty("--we-font-stroke");
  s.removeProperty("--we-font-family");
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
  applyFontStyles, removeFontStyles, applyCaretStyles, removeCaretStyles,
  resolveWallpaperFadeBg, snapshotHostFontDefaults,
};
