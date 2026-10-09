/**
 * 宿主侧**焦点交还**（#148「网页壁纸周期性抢焦点」第二步的后半）。
 *
 * 为什么需要它：`lib/we-focus-guard.js` 只能拦**壁纸文档里**的两条程序化路径
 * （帧级 `window.focus()` 与元素级 `element.focus()`）。还有几条路它够不着：
 *  - 跨源 WindowProxy 上的 `top.focus()` / `parent.focus()`（同源策略允许调用、禁止改写）；
 *  - 不经过 JS 的**内部**聚焦路径：`autofocus` 属性、`dialog.showModal()`、`label` 转发点击等。
 * 这几条一旦把焦点搬进壁纸帧，宿主这边唯一能做的就是把焦点**交还**给用户本来在用的元素。
 *
 * 交还的判据（三条同时成立，缺一不可 —— 少一条就会和用户拉锯）：
 *  ① 焦点**从我们记住的那个宿主元素**离开（`focusout` 的 target 就是它），
 *  ② 它落进了**壁纸帧**（`document.activeElement` 是 `iframe.we-iframe`），
 *  ③ 这件事**不是用户手势引起的**：最近 `GESTURE_WINDOW_MS` 内没有真实 pointer/mouse/key/touch
 *     按下。用户真去点壁纸（或壁纸自己的编辑框）时窗口刚被刷新 ⇒ 不交还，照他点的来。
 *
 * 另外两道保险：记住的元素超过 `STALE_MS` 没被打过焦点就不交还（否则半天前点过的输入框会被
 * 翻出来抢焦点）；两次交还之间至少隔 `MIN_GAP_MS`（壁纸若以极高频率夺焦，不至于把主线程拖成
 * 焦点乒乓）。
 *
 * 自证手段：`window.__weFocusHandback = { lastEl, lastAt, gestureAt, handbacks, skipped, active }`
 * —— 在 DSH 控制台里一眼能看到"交还了几次、跳过了几次"，与 `__weFocusGuard` 同一套纪律。
 * `handbacks` 一直不涨而症状仍在 ⇒ 夺焦路径不在本模块射程内（见上）。
 *
 * 与 `lib/we-focus-guard.js` 的分工：那一半住在**壁纸文档**里、负责"别让它是主动作恶的一方"；
 * 这一半住在**宿主文档**里、负责"就算被搬走了也把它搬回来"。两侧的手势窗口取同一个 1000 ms。
 */
let focusHandbackDispose = null;

/** 壁纸帧的判据：`iframe.we-iframe`（live 帧与 compat 帧都带这个类，见 src/live-layer.js:1590
 *  与 src/media-prep.js:303）。用类名而不是某个 data-* 锚点：它随元素本身走，不依赖宿主 DOM。 */
function weIsWallpaperFrame(el) {
  if (!el || el.tagName !== "IFRAME") return false;
  const cls = typeof el.className === "string" ? el.className : "";
  return /(^|\s)we-iframe(\s|$)/.test(cls);
}

/**
 * 装上焦点交还监听器，返回**拆除函数**（挂 `ctx.effect` 用：宿主每次 revision 变化都会
 * tearDownEntryFiber 后重跑，不交还拆除函数就会一份实例一套监听器 —— 与 2e 段同一条理由）。
 * 已在装时重复调用返回同一个拆除函数（幂等）。
 */
function installFocusHandback() {
  if (typeof document === "undefined" || !document || typeof window === "undefined" || !window) return null;
  if (focusHandbackDispose) return focusHandbackDispose;
  // 环境能力检查：真实 DOM 一定有这四个方法；但本仓的 verify 挂载台用的是 stub `document`
  // （只有 body / style），少一个方法不能抛出去 —— `ctx.effect` 里抛会中断整条 apply（实测
  // verify-transcode-state 就是被这个打断的）。装不上就当作"这个环境没有宿主 DOM"。
  if (typeof document.addEventListener !== "function" || typeof document.removeEventListener !== "function"
    || typeof window.addEventListener !== "function" || typeof window.removeEventListener !== "function") return null;

  const GESTURE_WINDOW_MS = 1000; // 与 lib/we-focus-guard.js 的 gestureWindowMs 同值
  const STALE_MS = 120000;
  const MIN_GAP_MS = 300;
  const state = { lastEl: null, lastAt: 0, gestureAt: 0, handbacks: 0, skipped: 0, active: true };
  let lastHandBackAt = 0;

  const onFocusIn = (e) => {
    const el = e.target;
    // body/html 拿到焦点说明"宿主这边本来就没有焦点"，没有可交还的对象。
    if (!el || el === document.body || el === document.documentElement) return;
    if (weIsWallpaperFrame(el)) return;
    state.lastEl = el;
    state.lastAt = Date.now();
  };
  const onGesture = () => { state.gestureAt = Date.now(); };
  const handBack = () => {
    const el = state.lastEl;
    if (!el) return;
    const active = document.activeElement;
    if (!weIsWallpaperFrame(active) || !active.isConnected) return; // ② 焦点得真的在壁纸帧里
    const now = Date.now();
    if (now - state.gestureAt <= GESTURE_WINDOW_MS) { state.skipped += 1; return; } // ③ 是用户自己点的
    if (now - state.lastAt > STALE_MS) { state.skipped += 1; return; }
    if (now - lastHandBackAt < MIN_GAP_MS) { state.skipped += 1; return; }
    if (!el.isConnected) { state.skipped += 1; return; }
    lastHandBackAt = now;
    state.handbacks += 1;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      try { el.focus(); } catch (err2) { /* 交还失败只体现为没交还，绝不抛 */ }
    }
  };
  const onFocusOut = (e) => {
    // ① 只有"焦点从我们记住的那个元素离开"才管 —— 否则任何一次 blur 都会触发一轮判断。
    if (!state.lastEl || e.target !== state.lastEl) return;
    // `document.activeElement` 在 focusout 之后才更新，所以挪到下一拍再判。
    setTimeout(handBack, 0);
  };

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  // 手势源与壁纸文档那一侧同集合：pointer/mouse/touch 按下 + 按键。
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("mousedown", onGesture, true);
  window.addEventListener("touchstart", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  try { window.__weFocusHandback = state; } catch (err) { /* 只读 window：只是少了自证手段 */ }

  focusHandbackDispose = () => {
    state.active = false;
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    window.removeEventListener("pointerdown", onGesture, true);
    window.removeEventListener("mousedown", onGesture, true);
    window.removeEventListener("touchstart", onGesture, true);
    window.removeEventListener("keydown", onGesture, true);
    focusHandbackDispose = null;
  };
  return focusHandbackDispose;
}

export { installFocusHandback };
