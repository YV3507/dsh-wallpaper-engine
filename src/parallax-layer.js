/**
 * parallax-layer.js — 「3D 效果」的**视差层**：光标移动时把壁纸 / 吉祥物挪一小段。
 *
 * ══ 为什么是这样一个角色 ══════════════════════════════════════════════════════
 * 它是**基座模块**（见 docs/CODE-STRUCTURE.md §3.1）：不吃 ctx、直接读扁平设置 store
 * `selection`，和 `video-layer` / `effects` / `fx-layer` 同层 —— 因为它的
 * 驱动源不是某次渲染，而是**输入事件**（pointermove）与一个 rAF 缓动循环。渲染器给它传 ctx
 * 反而要把每个设置项穿一遍，而"光标一动就有反应"这件事必须当场发生。
 *
 * ══ 它怎么动 ═════════════════════════════════════════════════════════════════
 *   · **单位量**：光标相对屏幕中心偏移 u = (光标 − 中心)，则该层的目标位移是
 *     `PARALLAX_DIRECTION × u × pct/100`（pct 是这个层的"缓动距离"）。
 *     光标走完整整一条**最长对角线**（Δu = 对角线 d）时，位移正好改变 `pct% × d` ——
 *     这就是用户口径里那个百分比的定义。方向 `PARALLAX_DIRECTION = -1`：**关于屏幕中心
 *     对称**（光标在右上，整块往左下走）。改成跟随光标只需把它写成 +1。
 *   · **缓动**：位移不直接等于目标，而是按 `parallaxSmooth` 每帧朝目标逼近一截
 *     （指数逼近；按真实 dt 折算 ⇒ 掉帧时跟手程度不变）⇒ 光标停下后影子还会飘一小段才归位。
 *   · **写什么**：每帧把**最终位移**直接写进那几层自己的 CSS 独立属性 `translate`
 *     （与壁纸过场内联写的 `transform` 叠加而不互相清掉）；**每帧一个自定义属性都不写** ——
 *     自定义属性是继承的，写一次就会让整棵子树重算样式，而"光标一动就写一次"正是这条链路上
 *     最贵的一笔。各层的系数（`.we-layer` 用 `parallaxBg`、`.we-rope` 用 `parallaxMascot`，
 *     关掉时为 0）在 JS 里乘完再写；壁纸补边的静态 `scale` 仍由样式表用 body 上的
 *     `--we-parallax-bg` 算（那个变量只在设置变了时写一次，不在帧里）。
 *   · **跟随真实刷新率**：不再人工封顶 60Hz（高刷屏上原来隔帧跑 —— 位移一样但看着不够连贯）。
 *     缓动本来就按真实 dt 折算，所以手感与封顶时一致。
 *   · **帧里零测量**：帧内不读 `window.innerWidth`、不 `querySelectorAll`、更不碰
 *     `getBoundingClientRect` / `getComputedStyle` —— 视口只在起帧与 resize 时读一次，
 *     目标重扫挪到起帧路径（节流 `PARALLAX_TARGETS_MS`）与"跟踪的节点掉出文档"那种罕见路径上。
 *   · **页面不可见就不排帧**：`document.hidden` 时 `parallaxKick()` 直接返回，
 *     `visibilitychange` 回来再接上（后台标签页一帧、一次写入都没有）。
 *   · **开销**（这一层整个长在输入路径上，省下来的都是手感）：写入只落在**要动的那几层
 *     自己**身上；"到位"按**看得见的位移**判（屏上剩余量 < 0.25px，光标静下来 180ms 之后
 *     放宽到 1px）⇒ 一次手势的帧数大约减半；系数全 0 时一帧都不排；帧循环在跑的这段时间给
 *     那几层加一个类提成合成层（每帧只挪现成的纹理、不整屏重绘），到位收工立刻摘掉
 *     （本仓刻意不留常驻合成层）。视口尺寸只在 resize 时读。
 *   · **壁纸要补边**：位移最大为 `pct/100 × 视口宽 / 2`（横向）、`pct/100 × 视口高 / 2`（纵向），
 *     而 `.we-layer` 正好是视口大小 ⇒ 不补边就会在边上露出底色。所以壁纸层同时放大
 *     `1 + pct/100`（见 src/styles.js 的视差段）—— 恰好多出"最大位移 × 2"那点余量。
 *   · **各层各自的百分比**：壁纸走 `parallaxBg`；吉祥物跟着壁纸（`parallaxMascot` 可关）。
 *   · **点击与拖尾效果（`src/fx-layer.js` 那一层）刻意不参与**（用户口径第 3 条）：那层画的是"屏上的笔迹"，
 *     跟着挪会让落点与光效错位。
 *   · **自检开关**：`localStorage.weParallaxDebug = '1'` ⇒ 记每帧的回调耗时、写入次数与帧间隔，
 *     一次手势收工（或停用）时打一行 p50 / p95 / max + 长帧（≥ 8ms）计数，并挂在
 *     `window.__weParallaxStats` 上。默认关；读它本身是有成本的，所以最多每秒重读一次。
 *
 * 契约：
 *   需要的外界：`selection`（设置 store，只读）、`document.body`（写 1 个"壁纸补边系数"与一个
 *   开关属性）、还有**那几层元素自己**（`.we-layer` / `.we-rope`：写 `translate` 与
 *   临时的合成层提示）。
 *   对外提供：`syncParallaxLayer()`（设置变了就调一次）、`disposeParallaxLayer()`（卸载清理）。
 *   设置项（`parallax*`，真源 lib/settings-schema.js）：总开关 / 背景距离 /
 *   吉祥物是否跟随 / 缓动平滑。
 *
 * 不变量：
 *   · **一个 DOM 节点都不建**：屏上那几层（壁纸 / 吉祥物）本来就存在，本层只写样式 ——
 *     1 个"壁纸补边系数"写在 `document.body` 上（只在设置变了时写一次），位移写在
 *     **要动的那几层自己**身上（每帧写，但作用域只有那几个元素），另加一个开关属性
 *     `data-we-parallax`。于是**关掉时屏上一点痕迹都没有**（属性摘掉 ⇒ 补边那条规则不命中，
 *     位移也被 removeProperty 收干净）。
 *     ⚠️ 位移**不能**写成 `transform`：`.we-layer` 的过场（层切换）与 `.we-layer--repaint`
 *     会内联写 / 清 `transform`（见 src/live-layer.js 的 resetLayerSwitchStyles）—— 用 CSS 的
 *     **独立属性** `translate` / `scale` 才与它们叠加而不互相清掉。
 *   · **只读 `selection`**：一个字节都不写（裸写棘轮只留给 media-prep / effects / live-layer）。
 *     拖动滑块时的即时反馈靠"每帧重读设置"，不靠写回。
 *   · **零顶层可执行语句**：本文件的顶层只有声明 —— 读 `selection` / 碰 `document` / 读
 *     `localStorage` 的语句一律在函数里（内联后 prelude 早于 `src/client.js` 正文求值，
 *     顶层读它必撞 TDZ）。
 *   · **不接管输入**：只读 document 上的 pointermove / visibilitychange 与 window 上的 resize
 *     （都 passive），一个事件都不拦；屏上也没有属于本层的元素。
 *   · **挂了才活、到位就停**：`parallaxEnabled` 关掉 ⇒ 立刻停 rAF、摘掉临时的合成层与
 *     位移、摘掉属性。帧循环是**收敛驱动**的：剩下的位移在屏上已经看不出来（口径见上面"开销"
 *     那条的两个阈值）就画完这帧收工（`parallaxRaf = 0`），下一次 pointermove 再用
 *     `parallaxKick()` 起一帧 —— 光标不动时零帧、零 CPU。
 *   · **没有 rAF 的环境连 DOM 都不碰**（无头/测试沙箱）：这一层是装饰，宁可不画，
 *     也不要在没有帧时钟的地方留半截状态。
 *   · 事件与变量都走幂等的 `parallaxBind()` / `parallaxUnbind()`，重复 sync 不会叠监听。
 */

/** 1 = 跟随光标，-1 = 关于屏幕中心对称（用户口径："沿中心对称方向缓动"）。改这一个数就能换向。 */
const PARALLAX_DIRECTION = -1;
/** 百分比是"最长对角线的百分之几"：壁纸 0..10（它同时决定补边放大的倍数 1 + pct/100）、
 *  平滑 0..98（100% 等于永远不动）。 */
const PARALLAX_BG_MIN = 0;
const PARALLAX_BG_MAX = 10;
const PARALLAX_SMOOTH_MIN = 0;
const PARALLAX_SMOOTH_MAX = 98;
/** 位移步长的最小"到位"距离（px / 每 1%）：兜底阈值，常态用的是下面按可见位移折算的那个。 */
const PARALLAX_SETTLE_PX = 0.02;
/** 缓动按 60fps 一帧折算；掉帧时最多按 64ms 补（再长就直接到位，别放大成一次跳跃）。
 *  ⚠️ 这只是**折算基准**，不是帧率上限：帧率跟随显示器真实刷新率（高刷屏上不再隔帧跑）。 */
const PARALLAX_FRAME_MS = 1000 / 60;
const PARALLAX_DT_MAX = 64;
/** "到位"看的是**屏上还剩多少位移**：位移 = 步长 × 系数 ⇒ 剩余位移 = 剩余步长 × 最大系数。
 *  0.25px 已经在感知之外；光标静下来 180ms 之后放宽到 1px —— 尾巴上那十几帧一次收掉
 *  （抹平那一刻的位移不足 1px，看不出来）。 */
const PARALLAX_SETTLE_VISIBLE_PX = 0.25;
const PARALLAX_IDLE_MS = 180;
const PARALLAX_IDLE_VISIBLE_PX = 1;
/** 要动的那几层（与 src/styles.js 视差段的规则一一对应）：壁纸层与吉祥物。 */
const PARALLAX_TARGET_SELECTOR = '.we-layer, .we-rope';
/** 帧循环在跑的这段时间加在目标上的类（样式段只在开关属性下给它 will-change）—— 收工即摘。 */
const PARALLAX_MOVING_CLASS = 'we-parallax--moving';
/** 目标重扫间隔：壁纸层会换节点，所以起帧路径上定期重扫一次（**不在帧里**）。 */
const PARALLAX_TARGETS_MS = 250;
/** 光标在屏幕外 / 还没动过时的位移：读不到真实尺寸时的兜底中心，也是"零位移"的那一点。 */
const PARALLAX_BG_DEFAULT = 1;
const PARALLAX_SMOOTH_DEFAULT = 85;
/** 每帧写下去的那条 CSS 独立属性（不能用 transform：壁纸过场会内联写 / 清它）。 */
const PARALLAX_TRANSLATE = 'translate';
/** 只写一次的那个"壁纸补边系数"（与 src/styles.js 的 `scale: calc(1 + 变量 / 100)` 逐字对应）：
 *  它落 body，是因为补边放大整层只与总设置有关、与光标无关。 */
const PARALLAX_VAR_BG = '--we-parallax-bg';
/** body 上的总开关属性：只有它在时补边那条规则才命中（关掉 ⇒ 壁纸连 scale 都不带）。 */
const PARALLAX_ATTR = 'data-we-parallax';
/** 自检开关（localStorage 键）与"最多每秒重读一次"的节流；长帧阈值取 8ms（60Hz 一帧的预算）。 */
const PARALLAX_DEBUG_KEY = 'weParallaxDebug';
const PARALLAX_DEBUG_REREAD_MS = 1000;
const PARALLAX_LONG_FRAME_MS = 8;
/** 自检只留最近这些帧的样本（百分位是"开自检之后的前 600 帧"，够看一次手势了）。 */
const PARALLAX_DEBUG_SAMPLES = 600;

let parallaxOn = false;
let parallaxBound = false;
let parallaxRaf = 0;
let parallaxX = 0;
let parallaxY = 0;
let parallaxSeen = false;
/** 当前位移步长（px / 每 1% 的百分比）与上一帧的时间戳。 */
let parallaxStepX = 0;
let parallaxStepY = 0;
let parallaxLastMs = 0;
let parallaxRatioKey = '';
/** 视口尺寸（只在起帧、resize 与"冷路径补读"时读一次：帧里不再问 window，省掉每帧那次布局查询）。 */
let parallaxVw = 0;
let parallaxVh = 0;
/** 最近一次 pointermove 的时刻（判"光标静下来了"）与要动的那几层的记录（见 parallaxTargetsRefresh）。 */
let parallaxMoveMs = 0;
let parallaxTargets = [];
let parallaxTargetsMs = 0;
/** 本帧在写入时发现"跟踪的节点已经不在文档里"（壁纸换节点）—— 记下来，下一帧重扫一次。 */
let parallaxStale = false;
/** 自检：开关状态、上次重读时刻、样本桶与上一次 rAF 时间戳（算帧间隔）。 */
let parallaxDebugOn = false;
let parallaxDebugCheckMs = 0;
let parallaxDebugStats = null;
let parallaxDebugLastMs = 0;

function parallaxNow() {
  return window.performance && typeof window.performance.now === 'function'
    ? window.performance.now() : Date.now();
}

function parallaxClamp(v, lo, hi, fallback) {
  const n = typeof v === 'number' && isFinite(v) ? v : Number(v);
  if (!isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 设置快照（每帧现读 ⇒ 拖滑块不需要 emit 就能看到反馈）。
 * 数值范围是**常量**、与本文件外的白名单同值（改范围要同时看 lib/settings-schema.js ——
 * 那份是唯一真源）：本文件要能被单独 import（test/verify-scene-live.mjs 就是这么测的），
 * 引那份 schema 会在单文件环境里 ReferenceError。
 */
function parallaxSettings() {
  return {
    on: selection.parallaxEnabled === true,
    bg: parallaxClamp(selection.parallaxBg, PARALLAX_BG_MIN, PARALLAX_BG_MAX, PARALLAX_BG_DEFAULT),
    mascot: selection.parallaxMascot !== false,
    smooth: parallaxClamp(selection.parallaxSmooth, PARALLAX_SMOOTH_MIN, PARALLAX_SMOOTH_MAX,
      PARALLAX_SMOOTH_DEFAULT),
  };
}

/** 写样式 / 属性的落点。没有 DOM 的环境（无头沙箱、SSR 探测）一律返回 null ⇒ 全链静默。 */
function parallaxBody() {
  if (typeof document === 'undefined' || !document || !document.body) return null;
  return document.body;
}

/** 写一条**元素级**的样式（只在真的变了的时候写，比的是自己攒的快照，不读回 DOM）。
 *  两个能力都先探再调：挂载台（`test/verify-client.mjs`）的 style 只实现了 setProperty。 */
function parallaxVarOn(el, prop, value) {
  const style = el && el.style;
  if (!style || typeof style.setProperty !== 'function') return;
  if (typeof style.getPropertyValue === 'function' && style.getPropertyValue(prop) === value) return;
  style.setProperty(prop, value);
}

/** 视口尺寸：帧里要用（中心 = 视口 / 2），但只在起帧、resize 与冷路径补读时读一次 ——
 *  每帧问 window 是白花的，而且"读窗口尺寸"和样式写入交错还有把布局刷出来的风险。 */
function parallaxReadViewport() {
  const win = typeof window === 'undefined' ? null : window;
  const w = win ? Math.round(Number(win.innerWidth)) : 0;
  const h = win ? Math.round(Number(win.innerHeight)) : 0;
  parallaxVw = isFinite(w) && w > 0 ? w : 0;
  parallaxVh = isFinite(h) && h > 0 ? h : 0;
}

/** 页面是否不可见（后台标签页 / 最小化）：不可见时一帧都不排 —— 那点位移没人看，
 *  而 rAF、合成层与样式写入本身都是有成本的。取不到就当作可见。 */
function parallaxHidden() {
  if (typeof document === 'undefined' || !document) return false;
  return document.hidden === true || document.visibilityState === 'hidden';
}

/** 提合成层的提示（只提示 translate：scale 是静态的，不掺和栅格化倍率）。已经在身上时
 *  add 是空操作；壁纸层的过场会把类整条抹掉（`resetLayerSwitchStyles` 重置 className），
 *  所以帧里每次写位移都补一次。 */
function parallaxTargetLift(el, on) {
  const list = el && el.classList;
  if (!list) return;
  if (on) {
    if (typeof list.add === 'function') list.add(PARALLAX_MOVING_CLASS);
    return;
  }
  if (typeof list.remove === 'function') list.remove(PARALLAX_MOVING_CLASS);
}

/** 这一层是壁纸（走 `parallaxBg`）还是吉祥物（走 `parallaxMascot`）：按类名认，
 *  认不出来就按壁纸算（位移最小、最不惹眼的那一档）。 */
function parallaxTargetKind(el) {
  const list = el && el.classList;
  if (list && typeof list.contains === 'function') {
    if (list.contains('we-layer')) return 'bg';
    if (list.contains('we-rope')) return 'mascot';
  }
  const cls = ' ' + String((el && el.className) || '') + ' ';
  if (cls.indexOf(' we-layer ') >= 0) return 'bg';
  if (cls.indexOf(' we-rope ') >= 0) return 'mascot';
  return 'bg';
}

/** 各层这一帧的系数：壁纸恒为 `parallaxBg`；吉祥物跟随（`parallaxMascot` 关掉时为 0）。 */
function parallaxTargetRatio(rec, st) {
  if (rec.kind === 'mascot') return st.mascot ? st.bg : 0;
  return st.bg;
}

/** 从一个目标身上收掉本层留下的一切（合成层提示 + 位移）。 */
function parallaxTargetClear(rec) {
  const el = rec && rec.el;
  if (!el) return;
  parallaxTargetLift(el, false);
  const style = el.style;
  if (style && typeof style.removeProperty === 'function') {
    try { style.removeProperty(PARALLAX_TRANSLATE); } catch (e) { /* 已卸载 */ }
  }
  rec.key = '';
}

function parallaxTargetsClear() {
  for (let i = 0; i < parallaxTargets.length; i += 1) parallaxTargetClear(parallaxTargets[i]);
  parallaxTargets = [];
  parallaxTargetsMs = 0;
  parallaxStale = false;
}

/**
 * 重扫那几层（**不在帧里**：起帧路径每隔 PARALLAX_TARGETS_MS 一次，外加"帧里发现有节点掉出
 * 文档"那种罕见路径）。走掉的**当场**把类与位移收干净，新来的补进记录并让下一帧整批重写一遍
 * （新元素身上还没有位移）。
 */
function parallaxTargetsRefresh(now) {
  if (typeof document === 'undefined' || !document
    || typeof document.querySelectorAll !== 'function') return;
  const found = document.querySelectorAll(PARALLAX_TARGET_SELECTOR);
  const prev = parallaxTargets;
  const next = [];
  for (let i = 0; i < found.length; i += 1) {
    const el = found[i];
    let rec = null;
    for (let j = 0; j < prev.length; j += 1) {
      if (prev[j].el === el) { rec = prev[j]; prev[j].kept = true; break; }
    }
    if (!rec) rec = { el: el, key: '', kind: parallaxTargetKind(el) };
    next.push(rec);
  }
  for (let j = 0; j < prev.length; j += 1) {
    if (prev[j].kept) { prev[j].kept = false; continue; }
    parallaxTargetClear(prev[j]);
  }
  parallaxTargets = next;
  parallaxTargetsMs = now;
  parallaxStale = false;
}

/** 起帧路径上的重扫（节流）：`parallaxTargetsMs === 0` 表示还没扫过 ⇒ 立刻扫。 */
function parallaxTargetsEnsure(now) {
  if (parallaxTargetsMs && now - parallaxTargetsMs < PARALLAX_TARGETS_MS) return;
  parallaxTargetsRefresh(now);
}

/** 收工：把合成层提示摘掉（本仓刻意不留常驻合成层）；位移留着，下次 pointermove 直接续上。 */
function parallaxTargetsSettle() {
  for (let i = 0; i < parallaxTargets.length; i += 1) parallaxTargetLift(parallaxTargets[i].el, false);
}

/** 壁纸补边的系数（只在设置变了时写一次，落在 body 上）：位移由 JS 算，这条只喂
 *  `scale: calc(1 + 变量 / 100)`。 */
function parallaxRatios(st) {
  const body = parallaxBody();
  if (!body) return;
  const key = String(st.bg);
  if (key === parallaxRatioKey) return;
  parallaxRatioKey = key;
  parallaxVarOn(body, PARALLAX_VAR_BG, key);
}

/** 把补边系数从 body 上收掉（停用后 body 上不留本层的任何痕迹）。 */
function parallaxRatioClear() {
  const body = parallaxBody();
  const style = body && body.style;
  if (!style || typeof style.removeProperty !== 'function') return;
  try { style.removeProperty(PARALLAX_VAR_BG); } catch (e) { /* 已卸载 */ }
}

/**
 * 把这一帧的位移写下去（每帧一次，**只写要动的那几层自己**）：两位小数够用 —— 再细也看不出来，
 * 而"值没变就不写"这一条让静止的那些帧一次样式写入都没有。
 * 返回写了几次；顺带记下"有节点掉出文档"（壁纸换节点），由调用方决定何时重扫。
 */
function parallaxApply(st) {
  if (!parallaxTargets.length) return 0;
  let writes = 0;
  for (let i = 0; i < parallaxTargets.length; i += 1) {
    const rec = parallaxTargets[i];
    const el = rec.el;
    if (!el || el.isConnected === false) { parallaxStale = true; continue; }
    const ratio = parallaxTargetRatio(rec, st);
    const value = (parallaxStepX * ratio).toFixed(2) + 'px '
      + (parallaxStepY * ratio).toFixed(2) + 'px';
    if (value === rec.key) continue;
    rec.key = value;
    parallaxTargetLift(el, true);
    parallaxVarOn(el, PARALLAX_TRANSLATE, value);
    writes += 1;
  }
  return writes;
}

/** 总开关属性：开了才让补边那条规则命中（关掉时屏上不留任何痕迹）。 */
function parallaxAttr(on) {
  const body = parallaxBody();
  if (!body) return;
  if (on) {
    if (typeof body.setAttribute === 'function') body.setAttribute(PARALLAX_ATTR, 'on');
    return;
  }
  if (typeof body.removeAttribute === 'function') body.removeAttribute(PARALLAX_ATTR);
}

/**
 * 自检（`localStorage.weParallaxDebug = '1'`）：读开关本身有成本，所以只在起帧路径上
 * **最多每秒重读一次**；打开时开新样本桶，关掉即丢。任何读取异常（隐私模式、被禁的存储）
 * 一律当作关。
 */
function parallaxDebugSync(now) {
  if (parallaxDebugOn && now - parallaxDebugCheckMs < PARALLAX_DEBUG_REREAD_MS) return;
  parallaxDebugCheckMs = now;
  let on = false;
  try {
    const ls = typeof localStorage === 'undefined' ? null : localStorage;
    if (ls && typeof ls.getItem === 'function') on = ls.getItem(PARALLAX_DEBUG_KEY) === '1';
  } catch (e) { on = false; }
  parallaxDebugOn = on;
  parallaxDebugStats = on
    ? { frames: 0, writes: 0, long: 0, costs: [], gaps: [] }
    : null;
  parallaxDebugLastMs = 0;
}

function parallaxPercentile(list, p) {
  if (!list.length) return 0;
  const sorted = list.slice().sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return Math.round(sorted[at] * 100) / 100;
}

/** 攒一帧的样本：回调耗时（t0 由帧入口取）、写了几个元素、与上一帧 rAF 时间戳的间隔。 */
function parallaxDebugFrame(t0, now, writes) {
  const stats = parallaxDebugStats;
  if (!parallaxDebugOn || !t0 || !stats) return;
  const cost = parallaxNow() - t0;
  stats.frames += 1;
  stats.writes += writes;
  if (cost >= PARALLAX_LONG_FRAME_MS) stats.long += 1;
  if (stats.costs.length < PARALLAX_DEBUG_SAMPLES) stats.costs.push(cost);
  if (parallaxDebugLastMs && now > parallaxDebugLastMs
    && stats.gaps.length < PARALLAX_DEBUG_SAMPLES) {
    stats.gaps.push(now - parallaxDebugLastMs);
  }
  parallaxDebugLastMs = now;
}

/** 一次手势收工（或停用）时打一行结论，并把同一份对象挂到 `window.__weParallaxStats` 上。 */
function parallaxDebugReport() {
  const stats = parallaxDebugStats;
  if (!parallaxDebugOn || !stats || !stats.frames) return;
  const report = {
    frames: stats.frames,
    writes: stats.writes,
    longFrames: stats.long,
    costMs: {
      p50: parallaxPercentile(stats.costs, 0.5),
      p95: parallaxPercentile(stats.costs, 0.95),
      max: parallaxPercentile(stats.costs, 1),
    },
    gapMs: {
      p50: parallaxPercentile(stats.gaps, 0.5),
      p95: parallaxPercentile(stats.gaps, 0.95),
      max: parallaxPercentile(stats.gaps, 1),
    },
  };
  parallaxDebugStats = { frames: 0, writes: 0, long: 0, costs: [], gaps: [] };
  parallaxDebugLastMs = 0;
  try {
    const win = typeof window === 'undefined' ? null : window;
    if (win) win.__weParallaxStats = report;
  } catch (e) { /* 只读宿主 */ }
  try {
    if (typeof console !== 'undefined' && console && typeof console.info === 'function') {
      console.info('[we-parallax] 帧 ' + report.frames + ' · 写入 ' + report.writes
        + ' · 长帧(≥' + PARALLAX_LONG_FRAME_MS + 'ms) ' + report.longFrames
        + ' · 回调耗时 p50/p95/max ' + report.costMs.p50 + '/' + report.costMs.p95 + '/'
        + report.costMs.max + 'ms · 帧间隔 p50/p95/max ' + report.gapMs.p50 + '/'
        + report.gapMs.p95 + '/' + report.gapMs.max + 'ms');
    }
  } catch (e) { /* 没有控制台 */ }
}

function parallaxOnPointerMove(e) {
  if (!parallaxOn) return;
  parallaxX = e.clientX;
  parallaxY = e.clientY;
  parallaxSeen = true;
  parallaxMoveMs = parallaxNow();
  parallaxKick();
}

/** 换窗口大小 ⇒ 中心跟着变（同一次光标位置的目标位移不同）：重读视口、再算一帧。 */
function parallaxOnResize() {
  if (!parallaxOn) return;
  parallaxReadViewport();
  parallaxKick();
}

/** 页面切到后台就停帧（并丢掉时间基准，回来时不会攒出一次大跳跃），切回前台再接上。 */
function parallaxOnVisibility() {
  if (!parallaxOn) return;
  if (parallaxHidden()) {
    if (parallaxRaf) {
      try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(parallaxRaf); } catch (e) { /* 已卸载 */ }
      parallaxRaf = 0;
    }
    parallaxLastMs = 0;
    parallaxDebugReport();
    return;
  }
  parallaxKick();
}

function parallaxBind() {
  if (parallaxBound) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  // passive：只读事件，绝不拦指针（屏上也没有属于本层的元素）。
  document.addEventListener('pointermove', parallaxOnPointerMove, { passive: true });
  document.addEventListener('visibilitychange', parallaxOnVisibility, { passive: true });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', parallaxOnResize, { passive: true });
  }
  parallaxBound = true;
}

function parallaxUnbind() {
  if (!parallaxBound) return;
  try {
    document.removeEventListener('pointermove', parallaxOnPointerMove);
    document.removeEventListener('visibilitychange', parallaxOnVisibility);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', parallaxOnResize);
    }
  } catch (e) { /* 已卸载 */ }
  parallaxBound = false;
}

/**
 * 起一帧（已经在跑就不重复排）：由 pointermove / resize / visibilitychange 与自己的帧尾调用。
 * 这里做的都是**帧外**的事：补读一次视口（只到读出来为止）、重读自检开关（≤1 次/秒）、
 * 节流重扫那几层 —— 于是帧里可以一个测量 API 都不碰。
 */
function parallaxKick() {
  if (parallaxRaf) return;
  if (typeof requestAnimationFrame !== 'function') return;
  if (parallaxHidden()) return;
  const now = parallaxNow();
  if (parallaxVw <= 0 || parallaxVh <= 0) parallaxReadViewport();
  if (parallaxVw <= 0 || parallaxVh <= 0) return;
  parallaxDebugSync(now);
  parallaxTargetsEnsure(now);
  parallaxRaf = requestAnimationFrame(parallaxFrame);
}

/**
 * 一帧：把步长朝目标逼近一截、写下去，没到位就再排一帧。
 * 目标只看"光标相对中心的偏移"与视口尺寸 —— 视口就是那条对角线的两端，光标走完对角线时
 * 位移正好改变 pct% 个对角线（用户口径的那个定义）。
 */
function parallaxFrame(ms) {
  parallaxRaf = 0;
  if (!parallaxOn) return;
  const t0 = parallaxDebugOn ? parallaxNow() : 0;
  const st = parallaxSettings();
  if (!st.on) { parallaxStop(); return; }
  const now = typeof ms === 'number' ? ms : parallaxNow();
  // 视口未知 ⇒ 这一帧什么都不做（**不在帧里补读**）：下一次 kick 在帧外补读。
  if (parallaxVw <= 0 || parallaxVh <= 0) return;
  const vw = parallaxVw;
  const vh = parallaxVh;
  const cx = parallaxSeen ? parallaxX : vw / 2;
  const cy = parallaxSeen ? parallaxY : vh / 2;
  const targetX = PARALLAX_DIRECTION * (cx - vw / 2) / 100;
  const targetY = PARALLAX_DIRECTION * (cy - vh / 2) / 100;
  // 一层都不动（系数全 0）⇒ 屏上什么都不会变：一次落位、收工，一帧都不多排。
  const pctMax = st.bg;
  let writes = 0;
  if (pctMax <= 0) {
    parallaxStepX = targetX;
    parallaxStepY = targetY;
    writes = parallaxApply(st);
    parallaxTargetsSettle();
    parallaxDebugFrame(t0, now, writes);
    parallaxDebugReport();
    return;
  }
  // 指数逼近：a = 每 16.7ms 吃掉剩余距离的比例（smooth=0 ⇒ a=1 ⇒ 直接落位，像贴在光标上）。
  const a = 1 - st.smooth / 100;
  const dt = parallaxLastMs ? Math.min(PARALLAX_DT_MAX, Math.max(1, now - parallaxLastMs))
    : PARALLAX_FRAME_MS;
  parallaxLastMs = now;
  const f = a <= 0 ? 1 : 1 - Math.pow(1 - a, dt / PARALLAX_FRAME_MS);
  parallaxStepX += (targetX - parallaxStepX) * f;
  parallaxStepY += (targetY - parallaxStepY) * f;
  // 到位判据按**屏上还剩多少位移**算（剩余步长 × 最大系数）；光标静下来一会儿之后放宽
  // —— 尾巴上那点位移早看不出来了，与其再画十几帧，不如一次抹平收工。
  const idle = parallaxMoveMs > 0 && now - parallaxMoveMs >= PARALLAX_IDLE_MS;
  const settle = Math.max(PARALLAX_SETTLE_PX,
    (idle ? PARALLAX_IDLE_VISIBLE_PX : PARALLAX_SETTLE_VISIBLE_PX) / pctMax);
  const doneX = Math.abs(targetX - parallaxStepX) <= settle;
  const doneY = Math.abs(targetY - parallaxStepY) <= settle;
  if (doneX) parallaxStepX = targetX;
  if (doneY) parallaxStepY = targetY;
  parallaxRatios(st);
  writes = parallaxApply(st);
  // 罕见路径：壁纸换了节点（写的时候发现它已经掉出文档）⇒ 重扫一次再补写，
  // 否则这一帧的位移就落在了一个没人看的节点上。
  if (parallaxStale) {
    parallaxTargetsRefresh(now);
    writes += parallaxApply(st);
  }
  if (!doneX || !doneY) parallaxKick();
  else parallaxTargetsSettle();
  parallaxDebugFrame(t0, now, writes);
  if (doneX && doneY) parallaxDebugReport();
}

/**
 * 起（幂等）。**没有 rAF 的环境连 DOM 都不碰**：这一层是装饰，宁可不画，
 * 也不要在没有帧时钟的地方留半截状态（无头/测试沙箱走的就是这条）。
 */
function parallaxStart() {
  if (typeof requestAnimationFrame !== 'function') return;
  parallaxOn = true;
  parallaxAttr(true);
  parallaxReadViewport();
  parallaxRatios(parallaxSettings());
  parallaxBind();
  parallaxKick();
}

/** 全停（rAF、事件、临时合成层、位移、补边系数、开关属性）。 */
function parallaxStop() {
  parallaxOn = false;
  if (parallaxRaf) {
    try { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(parallaxRaf); } catch (e) { /* 已卸载 */ }
    parallaxRaf = 0;
  }
  parallaxUnbind();
  parallaxTargetsClear();
  parallaxRatioClear();
  parallaxStepX = 0;
  parallaxStepY = 0;
  parallaxSeen = false;
  parallaxLastMs = 0;
  parallaxMoveMs = 0;
  parallaxRatioKey = '';
  parallaxVw = 0;
  parallaxVh = 0;
  parallaxDebugReport();
  parallaxDebugOn = false;
  parallaxDebugStats = null;
  parallaxDebugCheckMs = 0;
  parallaxAttr(false);
}

/**
 * 设置变了就调一次（由 `src/client.js` 的 `subscribe(syncParallaxLayer)` 驱动）。
 * 它只决定"该不该活"，不碰具体参数 —— 那些每帧现读。
 */
function syncParallaxLayer() {
  const st = parallaxSettings();
  if (!st.on) {
    parallaxStop();
    return;
  }
  parallaxStart();
}

/** 卸载：本模块拥有的一切都收掉（监听、rAF、位移、补边系数、开关属性）。 */
function disposeParallaxLayer() {
  parallaxStop();
}

export { syncParallaxLayer, disposeParallaxLayer };
