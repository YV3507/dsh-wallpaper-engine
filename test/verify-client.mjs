// Verify the emitted client bundle materializes + drives the DOM correctly
// under the DSH module-loader contract. Exercises apply(), syncLayers(), and
// confirms: wallpaper + scrim layers are `<body>` children (no shell.overlay),
// the four effect knobs (wallpaper blur/scrim/border/glass blur) push CSS
// variables, the picker renders, and automatic rotation is scoped to a
// user-defined rotation group (list) with its own interval.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const React = {
  Fragment: 'Fragment',
  // Function initializers are invoked (lazy useState), matching real React.
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  // Minimal-but-real renderer: invoke function components so the picker tree
  // actually materializes (descriptors only for host elements).
  createElement: (type, props, ...children) =>
    typeof type === 'function' ? type(props || {}) : ({ type, props: props || null, children }),
};

let byId = {};
const rotationTimers = [];
const sceneFrameHeadCalls = [];
const sceneFrameDeleteCalls = [];
// 已删除的 CPU 动画渲染（scene-anim / APNG）的**反向**探针：任何 <video>.src
// 指向 /scene-anim/<token> 都说明那条路线复活了 —— 断言必须恒为空。
const animProbeSrcs = [];
// 同一个 src 赋值也记录**元素**：用于区分「探测视频」与「上屏的层内视频」
// （层内视频的 _parent 是 LAYER_ID 那个层节点）。
const animVideoEls = [];
const imgEls = [];
// 真 DOM 语义：`document.activeElement` 是**元素自己** `focus()` 的结果。焦点陷阱
// （trapModalTab）与模态框初始焦点（modalInitialFocus）都读它 ⇒ 挂载台必须真的实现，
// 否则这两条判据结构上不可达（同 pauseOnBlur 那次的修法：补语义，不把断言写弱）。
let activeEl = null;
function makeEl(tag) {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    style: { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } },
    className: "",
    appendChild(c) { this.children.push(c); c._parent = this; if (c.id) byId[c.id] = c; return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } if (this.id) delete byId[this.id]; },
    setAttribute(k, v) { this.attributes[k] = v; },
    removeAttribute(k) { delete this.attributes[k]; },
    focus() { activeEl = this; },
    blur() { if (activeEl === this) activeEl = null; },
    querySelector(sel) { return null; },
  };
}

const bodyEl = makeEl("body");
activeEl = bodyEl;
const document = {
  get activeElement() { return activeEl; },
  createElement: (t) => {
    const el = makeEl(t);
    if (t === 'video') {
      let _src = '';
      Object.defineProperty(el, 'src', {
        get: () => _src,
        set: (v) => {
          _src = String(v || '');
          if (_src.includes('/scene-anim/')) { animProbeSrcs.push(_src); animVideoEls.push({ el, src: _src }); }
        },
      });
    }
    if (t === 'img') {
      // 静态帧层（buildMedia 的 img 分支）的 src：用于锁定「回退静态帧必须带画面档位」。
      let _src = '';
      Object.defineProperty(el, 'src', {
        get: () => _src,
        set: (v) => { _src = String(v || ''); imgEls.push({ el, src: _src }); },
      });
    }
    return el;
  },
  getElementById: (id) => byId[id] || null,
  querySelector: () => null,
  // makeEl so injected <style id="we-font-patch"/"we-caret-patch"> elements are
  // tracked in byId and their textContent is assertable below.
  head: makeEl("head"),
  body: bodyEl,
};

const localStorage = {
  // Select a wallpaper and enable rotation over a user-defined group; omit
  // effect knobs so the new DEFAULTS (scrim 0.25, border 0.35, blur 24) apply.
  _store: { 'dsh-wallpaper-engine:selection': JSON.stringify({
    id: 'a',
    rotationGroupId: 'g1',
    rotationEnabled: true,
    rotationGroups: [
      { id: 'g1', name: 'My list', interval: 5, order: 'sequence', wallpaperIds: ['a', 'b'] },
    ],
    // 场景 C 记着画面档位 3：锁定「静态帧必须按该壁纸记住的档位加载」。
    frameVariants: { c: 3 },
  }) },
  getItem(k) { return this._store[k] ?? null; },
  setItem(k, v) { this._store[k] = v; },
  removeItem(k) { delete this._store[k]; },
};
// 槽位是否已有 GPU 抓帧（场景 C）：DELETE 后翻假，模拟真宿主的磁盘状态。
let cccGpuPinned = true;
// P2-L：宿主 unlink 失败时回 200 + removed:false（文件其实还在磁盘上）。
let cccClearUnlinkFails = false;
// 库存加载失败的模拟开关（P3-11 0b：错误态 + 「重试」恢复的往返断言用）。与 `cccClearUnlinkFails`
// 同款：测试里翻它，然后走**真实**的重载路径（页签的「刷新」按钮 → onRefresh → loadInventory）。
let inventoryFails = false;
const inventoryCalls = []; // /inventory 请求次数（sceneVideo 时序补拉断言用）
const fetch = (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  if (u.includes('/wallpaper-engine/inventory')) {
    inventoryCalls.push(u);
    if (inventoryFails) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: '测试用宿主故障' }) });
    }
  }
  // GPU 抓帧缓存的 HEAD 探测 / DELETE 清除（面板提示与清除入口）：
  // 场景 C（/scene-frame/ccc）假装缓存里已有 _gpu.png。
  if (method === 'HEAD') {
    sceneFrameHeadCalls.push(u);
    return Promise.resolve({
      ok: true, status: 204,
      headers: { get: (k) => {
        const key = String(k).toLowerCase();
        const pinned = u.includes('/scene-frame/ccc') && cccGpuPinned;
        if (key === 'x-we-gpu') return pinned ? '1' : '0';
        // 预览窗口要显示实时帧的像素尺寸（宿主从 PNG 的 IHDR 读）。
        if (key === 'x-we-gpu-w') return pinned ? '2488' : null;
        if (key === 'x-we-gpu-h') return pinned ? '1376' : null;
        if (key === 'x-we-gpu-ar') return pinned ? '1.8081' : null;
        return null;
      } },
    });
  }
  if (method === 'DELETE') {
    sceneFrameDeleteCalls.push(u);
    if (cccClearUnlinkFails) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, removed: false, error: 'unlink-failed' }),
      });
    }
    // 真宿主语义：DELETE 删掉 <key>_gpu.png → 之后 HEAD 回到 X-WE-GPU=0。
    if (u.includes('/scene-frame-cache/ccc')) cccGpuPinned = false;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, removed: true }) });
  }
  // 已删除路线的进度端点：这里保留一个应答，用来**证明客户端从不请求它**
  // （真请求了就会在 animProbeSrcs 之外留下痕迹，故一并把它当作陷阱）。
  if (u.includes('/scene-anim-progress/')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ percent: 100 }) });
  }
  // Route the settings GET: host reports dsh-better-sidebar as installed +
  // enabled (→ the 侧栏玻璃 control group must render), while keeping settings
  // empty so loadPersisted takes the "host has nothing yet → migrate the
  // localStorage seed" path the rest of the harness relies on.
  if (u.includes('/wallpaper-engine/settings')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, betterSidebar: true }) });
  }
  return Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({
    installDir: "D:/we", total: 34, portableCount: 33,
    playlists: [
      { id: "p1", name: "Test playlist", order: "sequence", wallpaperIds: ["a", "b", "c"], total: 3, portableCount: 2 },
    ],
    wallpapers: [
      // 30 synthetic videos force pagination (33 playable cards → 2 pages at 24/page).
      // All carry contentrating "Everyone" so they stay visible under the
      // default Everyone filter.
      ...Array.from({ length: 30 }, (_, i) => ({
        id: "w" + i, title: "Wall " + i, type: "video", playable: true, media: "/wallpaper-engine/media/w" + i, preview: null,
        contentrating: "Everyone",
      })),
      { id: "a", title: "Video A", type: "video", playable: true, media: "/wallpaper-engine/media/xyz", preview: null, contentrating: "Everyone" },
      { id: "b", title: "Video B", type: "video", playable: true, media: "/wallpaper-engine/media/def", preview: null, contentrating: "Everyone" },
      { id: "c", title: "Scene C", type: "scene", playable: false, media: null, preview: "/wallpaper-engine/preview/ccc", frameUrl: "/wallpaper-engine/scene-frame/ccc", contentrating: "Everyone" },
      { id: "d", title: "Scene D (no frame)", type: "scene", playable: false, media: null, preview: null, frameUrl: null, contentrating: "Everyone" },
      // e is PG13 and must be excluded under the default Everyone filter.
      { id: "e", title: "PG13 E", type: "web", playable: true, media: "/wallpaper-engine/media/pg", preview: null, contentrating: "PG13" },
    ],
  }),
  });
};

// 变异测试钩子：默认读构建产物，DSH_MUT_LIB 指向变异副本时读它。
const code = readFileSync(process.env.DSH_MUT_LIB || new URL('../lib/client.js', import.meta.url), 'utf8');
const independentSidebarSelector = 'body[data-we-sidebar-glass] [data-dsh-better-sidebar] [class*="_panel"]';
const wallpaperGatedSidebarSelector = 'body[data-we-sidebar-glass][data-we-wallpaper] [data-dsh-better-sidebar]';
assert.ok(code.includes(independentSidebarSelector), 'sidebar glass must not require an active wallpaper');
assert.ok(!code.includes(wallpaperGatedSidebarSelector), 'legacy wallpaper-gated sidebar selector must be removed');
assert.ok(
  code.includes('body[data-we-sidebar-glass] [data-dsh-better-sidebar] .cm-editor'),
  'sidebar content surfaces must follow the sidebar master switch',
);
assert.ok(code.includes('body[data-we-wallpaper] {'), 'non-sidebar wallpaper effects must remain wallpaper-gated');
console.log('sidebar glass selectors are wallpaper-independent: true');
const cap = { handoff: null };
const sandbox = {
  window: {
    __ModuleLoader__: { load: (h) => { cap.handoff = h; } },
    setTimeout: (fn, ms) => {
      const token = { fn, ms, cleared: false };
      rotationTimers.push(token);
      return token;
    },
    clearTimeout: (token) => { if (token) token.cleared = true; },
  },
  document, localStorage, fetch, React,
  // 浏览器里裸 setTimeout/setInterval 就是 window 上的 —— 沙箱必须同样提供：
  // 只用裸全局的代码路径（live 心跳、转码进度轮询）否则会静默抛错，
  // 让这类行为断言变成假绿。
  setTimeout: (fn, ms) => {
    const token = { fn, ms, cleared: false };
    rotationTimers.push(token);
    return token;
  },
  clearTimeout: (token) => { if (token) token.cleared = true; },
  setInterval: (fn, ms) => {
    const token = { fn, ms, cleared: false, interval: true };
    rotationTimers.push(token);
    return token;
  },
  clearInterval: (token) => { if (token) token.cleared = true; },
};
// 事件监听表：客户端把未聚焦/遮挡与 ESC 处理器注册在 window/document 上。挂载台默认**没有**
// `addEventListener`，加上它（纯追加、不影响既有断言）才能让"注册了没有 / 派发后行为"可判。
// 注意处理器本身注册在 `useEffect` 里，而 mock React 的 `useEffect` 是空实现 ⇒ 需要那类断言的
// 用例要**临时**把它换成收集器（见 ESC 那段），跑完立刻还原。
const winListeners = {};
const docListeners = {};
const addListenerTo = (reg) => (ev, fn) => { (reg[ev] ||= []).push(fn); };
const removeListenerFrom = (reg) => (ev, fn) => {
  const a = reg[ev]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
};
sandbox.window.addEventListener = addListenerTo(winListeners);
sandbox.window.removeEventListener = removeListenerFrom(winListeners);
document.addEventListener = addListenerTo(docListeners);
document.removeEventListener = removeListenerFrom(docListeners);

// 可控时钟：「帧率上限」按钮只有走到门禁的**冷缓存**分支（probeGpuFramePin 的
// 30s TTL 过期）才能被行为断言测出是否真的走了门禁 —— 否则按钮路径与「选壁纸」
// 路径共用同一条 gpuFramePins 缓存命中，改回直调也照样绿。
const RealDate = Date;
let nowOffset = 0;
const FakeDate = function (...a) { return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + nowOffset); };
FakeDate.now = () => RealDate.now() + nowOffset;
FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC; FakeDate.prototype = RealDate.prototype;
sandbox.Date = FakeDate;
vm.createContext(sandbox);
new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);

const { id, factory } = cap.handoff;
console.log('registered id:', id);

const requireMock = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react-dom') return { createPortal: (node) => node }; // modal renders inline in the mock
  throw new Error('unexpected require: ' + spec);
};
const exportsObj = factory(requireMock);
console.log('factory keys:', Object.keys(exportsObj));
console.log('inject:', JSON.stringify(exportsObj.inject));
console.log('Symbol.toStringTag:', Object.prototype.toString.call(exportsObj));

const registrations = [];
const effects = [];
const pickerRenders = [];
const slots = {
  inject: (key, cb) => cb(),
  register: (opts, render) => { registrations.push({ key: opts.name, id: opts.id, label: opts.label, order: opts.order }); pickerRenders.push(render); },
};
const ctx = { slots, effect(fn) { effects.push(fn); fn(); return fn; } };

// apply(ctx) 在这个夹具里必须跑通：ctx 已提供 slots / effect / document / fetch，任何抛出都会
// 让后面的注册与层断言在"什么都没挂上"的空跑上继续绿下去（此前只 console.log，throw 完仍 exit 0）。
let thrown = null;
try { exportsObj.apply(ctx); } catch (e) { thrown = (e && (e.stack || e.message)) || String(e); }
assert.equal(thrown, null, 'apply(ctx) 不得抛（夹具已给 slots/effect/document/fetch）：' + thrown);
console.log('apply threw: (none)');
console.log('slot registrations:', JSON.stringify(registrations));

const sectionReg = registrations.find((r) => r.key === 'settings.section');
console.log('registered as first-level settings.section:', !!sectionReg);
console.log('section id:', sectionReg ? sectionReg.id : '(missing)');
console.log('section label:', sectionReg ? sectionReg.label : '(missing)');
assert.ok(!registrations.some((r) => r.key === 'settings.general.item'), 'no longer registered as general item:');

setTimeout(async () => {
  console.log('body children ids:', JSON.stringify(bodyEl.children.map((c) => c.id)));
  console.log('has wallpaper layer:', !!document.getElementById('dsh-wallpaper-engine-layer'));
  console.log('has scrim:', !!document.getElementById('dsh-wallpaper-engine-scrim'));
  console.log('body[data-we-wallpaper]:', JSON.stringify(bodyEl.attributes['data-we-wallpaper']));
  const p = bodyEl.style._props;
  console.log('--we-scrim-color:', JSON.stringify(p['--we-scrim-color']));
  console.log('--we-border-alpha:', JSON.stringify(p['--we-border-alpha']));
  console.log('--we-blur:', JSON.stringify(p['--we-blur']));
  console.log('--we-wallpaper-blur:', JSON.stringify(p['--we-wallpaper-blur']));
  console.log('--we-wallpaper-scale:', JSON.stringify(p['--we-wallpaper-scale']));
  console.log('--we-wallpaper-opacity (default 0% → unset):', JSON.stringify(p['--we-wallpaper-opacity']));
  assert.equal(p['--we-wallpaper-opacity'], undefined, 'wallpaper opacity must stay untouched by default (no identity-opacity compositing layer)');
  console.log('--we-accent:', JSON.stringify(p['--we-accent']));
  console.log('--we-glass-alpha:', JSON.stringify(p['--we-glass-alpha']));
  console.log('--we-glass-color:', JSON.stringify(p['--we-glass-color']));
  console.log('body[data-we-glass-window] (default on):', JSON.stringify(bodyEl.attributes['data-we-glass-window']));
  // ── 轮换「就绪后切换 + 渐变」断言 ─────────────────────────────────
  // mock 环境无 addEventListener/Image → 准备管线特性探测失败即同步直通提交。
  // 按 5 分钟（300000ms）定位真正的轮换定时器，绕开 persist 防抖的 200ms
  // 定时器；提交结果同步看新层 dataset.weKey（含 selection.url），持久化
  // 需再手动 flush 200ms 的 persist 写。
  // 断言走 assert.ok：任何一条不成立 → 非零退出（评审指出此前全是
  // console.log，把轮换打回元素级领养也能 exit 0）。
  const rotCheck = (label, cond) => { assert.ok(cond, label); console.log('  ✓ ' + label); };
  const flushPersistWrites = () => {
    for (const t of rotationTimers.filter((item) => !item.cleared && !item.fired && item.ms === 200)) {
      t.fired = true;
      try { t.fn(); } catch (e) { console.log('persist flush threw:', e && e.message); }
    }
  };
  const findRotTimer = () => rotationTimers.find((item) => !item.cleared && !item.fired && item.ms === 5 * 60 * 1000);
  const fireRot = (t) => { t.fired = true; t.fn(); };
  // 切换过场（#112）：默认是「硬切」，所以下面这组轮换断言先经 UI 选成
  // 「交叉淡化」才有过渡路径；硬切与动画型过场各有专门断言（见本节末尾）。
  const findAriaBtn = (label) => {
    const tree = pickerRenders[0]();
    let hit = null;
    (function walk(node) {
      if (hit || !node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.props && node.props['aria-label'] === label) { hit = node; return; }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    })(tree);
    return hit;
  };
  // 过场动画是**下拉菜单**（过场会持续增加，平铺按钮迟早挤爆）——
  // 断言集中在「选项集合 + 选中值驱动」两件事上，新增过场只需扩这张表。
  const TRANSITION_IDS = { 硬切: 'cut', 交叉淡化: 'fade', 推移: 'push', 擦除: 'wipe', 光圈: 'iris', 缩放: 'zoom', 条带: 'bars' };
  const findTransitionSelect = () => findAriaBtn('过场动画');
  const pickTransition = (label) => {
    const el = findTransitionSelect();
    assert.ok(el, '「过场动画」下拉必须存在');
    const id = TRANSITION_IDS[label];
    assert.ok(id, '测试用的过场名必须在这张表里：' + label);
    assert.ok(Array.isArray(el.children) && el.children.some((o) => o && o.props && o.props.value === id),
      '下拉里必须有这个过场选项：' + label);
    el.props.onChange({ target: { value: id } });
  };
  const preLayer = document.getElementById('dsh-wallpaper-engine-layer');
  const rotTimer = findRotTimer();
  rotCheck('rotation timer scheduled (5min)', !!rotTimer);
  rotCheck('切换过场 renders a dropdown with all seven transitions',
    (() => {
      const el = findTransitionSelect();
      if (!el || el.type !== 'select' || !Array.isArray(el.children)) return false;
      const ids = el.children.map((o) => o.props && o.props.value);
      const labels = el.children.map((o) => (o.children || [])[0]);
      return Object.keys(TRANSITION_IDS).length === ids.length
        && Object.values(TRANSITION_IDS).every((v) => ids.includes(v))
        && Object.keys(TRANSITION_IDS).every((l) => labels.includes(l))
        && el.props.value === 'cut'; // 默认硬切
    })());
  rotCheck('默认过场是硬切（未设置时）',
    JSON.parse(localStorage._store['dsh-wallpaper-engine:selection'] || '{}').switchTransition === undefined
      || JSON.parse(localStorage._store['dsh-wallpaper-engine:selection'] || '{}').switchTransition === 'cut');
  pickTransition('交叉淡化');
  if (rotTimer) {
    fireRot(rotTimer); // a → b（直通提交）
    const postLayer = document.getElementById('dsh-wallpaper-engine-layer');
    const weKey1 = postLayer && postLayer.dataset ? postLayer.dataset.weKey : '';
    rotCheck('rotation prepare: ready-commit switches layer to next (b/media/def)',
      !!postLayer && postLayer !== preLayer && weKey1.indexOf('/wallpaper-engine/media/def') !== -1);
    rotCheck('rotation fade: old layer marked weFading', !!preLayer && preLayer.dataset.weFading === '1');
    rotCheck('rotation fade: old layer yielded LAYER_ID', !!preLayer && preLayer.id === '');
    rotCheck('rotation fade: new layer carries the switch classes', !!postLayer
      && postLayer.className.indexOf('we-layer--switch') !== -1);
    rotCheck('rotation fade: 交叉淡化基准 = ROTATION_FADE_MS (1800ms)', !!postLayer
      && postLayer.style._props['--we-switch-ms'] === '1800ms');
    flushPersistWrites();
    rotCheck('rotation prepare: commit persisted (id b)',
      JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id === 'b');
    // 第二次 fire（wrap）：上一份 fading 层被即时退役，选择绕回 a。
    const rotTimer2 = findRotTimer();
    rotCheck('rotation prepare: timer re-armed after commit', !!rotTimer2);
    if (rotTimer2) {
      fireRot(rotTimer2);
      const layer2 = document.getElementById('dsh-wallpaper-engine-layer');
      const weKey2 = layer2 && layer2.dataset ? layer2.dataset.weKey : '';
      rotCheck('rotation prepare: second ready-commit wraps (a/media/xyz)',
        !!layer2 && layer2 !== postLayer && weKey2.indexOf('/wallpaper-engine/media/xyz') !== -1);
      rotCheck('rotation fade: second switch also animates', !!layer2
        && layer2.className.indexOf('we-layer--switch') !== -1);
      rotCheck('rotation fade: previous fading layer retired immediately',
        bodyEl.children.indexOf(preLayer) === -1);
      flushPersistWrites();
      // ── 动画型过场：推移（方向默认左）+ 旧层同时退场 ──
      pickTransition('推移');
      const pushTimer = findRotTimer();
      rotCheck('rotation timer re-armed for the 推移 case', !!pushTimer);
      if (pushTimer) {
        const beforePush = document.getElementById('dsh-wallpaper-engine-layer');
        fireRot(pushTimer);
        const pushLayer = document.getElementById('dsh-wallpaper-engine-layer');
        rotCheck('推移：新层带 switch 类（入场层走通用 transition）', !!pushLayer
          && pushLayer !== beforePush
          && pushLayer.className.indexOf('we-layer--switch') !== -1);
        rotCheck('推移：基准 700ms 写入 --we-switch-ms', !!pushLayer
          && pushLayer.style._props['--we-switch-ms'] === '700ms');
        rotCheck('推移：新层终态回到 translate3d(0,0,0)', !!pushLayer
          && pushLayer.style.transform === 'translate3d(0, 0, 0)');
        rotCheck('推移：旧层同时位移出场并被压到新层之下', !!beforePush
          && beforePush.className.indexOf('we-layer--switch-out') !== -1
          && beforePush.style.transform === 'translate3d(-100%, 0, 0)'
          && beforePush.style.zIndex === '-3');
        // 收尾：过场结束必须把新层的临时样式清干净（否则满屏视频永久占合成层）。
        const cleanup = rotationTimers.find((t) => !t.cleared && !t.fired && t.ms === 760);
        rotCheck('推移：过场结束后清理定时器已排（ms+60）', !!cleanup);
        if (cleanup) {
          cleanup.fired = true; cleanup.fn();
          rotCheck('推移：收尾后新层回到干净的 we-layer（内联样式清空）',
            pushLayer.className === 'we-layer'
            && pushLayer.style.transform === '' && pushLayer.style.clipPath === ''
            && pushLayer.style._props['--we-switch-ms'] === undefined);
        }
        flushPersistWrites();
        // ── 条带（百叶窗）：终态必须是满屏矩形，且 N 块板都从进入侧（右侧）长出来 ──
        // 两个易错点都在终态里可判：① 方向反了 → 封闭边/板会跑到左侧；
        // ② 退回「锯齿扫过」那版（板塌成一条直边、与擦除无异）→ N 块板的深度点消失。
        pickTransition('条带');
        const barsTimer = findRotTimer();
        rotCheck('rotation timer re-armed for the 条带 case', !!barsTimer);
        if (barsTimer) {
          fireRot(barsTimer);
          const barsLayer = document.getElementById('dsh-wallpaper-engine-layer');
          const clip = barsLayer ? barsLayer.style.clipPath : '';
          rotCheck('条带：终态覆盖满屏且封闭边在右侧（方向 left）',
            !!clip && clip.indexOf('polygon(100.00% 0.00%') === 0
            && clip.indexOf('0.00% 0.00%') !== -1
            && clip.indexOf('100.00% 100.00%') !== -1);
          // 板数从产物里读，断言按 4N+1 算 —— 改板数不会误报，但**几何退回
          // 「锯齿扫过」那版**（点数公式不同）会翻红。
          const barsN = Number((code.match(/const SWITCH_BARS_TEETH = (\d+)/) || [])[1]);
          rotCheck('条带：N 块板的深度点都在（百叶窗，不是锯齿擦除）—— 点数 = 4N+1',
            !!clip && barsN >= 2 && (clip.match(/%/g) || []).length / 2 === 4 * barsN + 1);
          // 中段「板 + 缝」的几何在下面的单元级断言里直接算产物函数验证（终态看不出）。
          flushPersistWrites();
          // ── 硬切：默认值，旧层立即拆除、不排任何过场 ──
        pickTransition('硬切');
        const cutTimer = findRotTimer();
        rotCheck('rotation timer re-armed for the 硬切 case', !!cutTimer);
        if (cutTimer) {
          const beforeCut = document.getElementById('dsh-wallpaper-engine-layer');
          fireRot(cutTimer);
          const cutLayer = document.getElementById('dsh-wallpaper-engine-layer');
          rotCheck('硬切：旧层立即拆除（不进过渡路径）', !!beforeCut
            && bodyEl.children.indexOf(beforeCut) === -1);
          rotCheck('硬切：新层没有任何 switch 类或临时样式', !!cutLayer
            && cutLayer !== beforeCut
            && cutLayer.className.indexOf('we-layer--switch') === -1
            && cutLayer.style.transform === undefined
            && cutLayer.dataset.weFading === undefined);
          flushPersistWrites();
          // 下面的「手动点选也必须过渡」回归断言走的是交叉淡化这条腿
          // （历史 bug：只有轮换 commit 才淡、手动点选硬切），这里把过场选回去。
          pickTransition('交叉淡化');
        }
      }
      }
    }
  }
  assert.ok(pickerRenders.length > 0, 'picker 至少被渲染一次');
  if (pickerRenders.length) {
    // ── Tabbed IA: the picker splits into six tabs (壁纸/外观/吉祥物/效果/声音/
    //    高级 —— 「字体」已并入「外观」). Each WallpaperPicker instance keeps its
    //    active tab in localStorage; mock React's useState returns the initializer
    //    value, so re-seeding the key + re-rendering switches tabs deterministically. ──
    const TAB_KEY = 'dsh-wallpaper-engine:picker-tab';
    const setTab = (id) => localStorage.setItem(TAB_KEY, id);
    const renderPicker = () => {
      try { return pickerRenders[0](); } catch (e) { console.log('picker render threw:', e && e.message); return null; }
    };
    const countMatches = (root, re) => (JSON.stringify(root).match(re) || []).length;
    // Find the .we-picker__ctl row whose subtree mentions `text`, then the
    // first input with onChange inside it — the pill-switch input is nested
    // inside label.we-picker__switch within that SAME row.
    const findCtlInput = (root, text) => {
      let row = null;
      (function walk(node) {
        if (row || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__ctl') && JSON.stringify(node).includes(text)) { row = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      let hit = null;
      (function find(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(find); return; }
        if (node.type === 'input' && node.props && typeof node.props.onChange === 'function') { hit = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(find);
      })(row);
      return hit;
    };
    const findSliderRow = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        const children = Array.isArray(node.children) ? node.children : [];
        const lbl = children.find((c) => c && typeof c === 'object' && Array.isArray(c.children) && c.children.includes(label));
        if (cls.includes('we-picker__slider-row') && lbl) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const sliderMax = (row) => (row ? JSON.stringify(row).match(/"max":"(\d+)"/)?.[1] : null);
    const findRangeInput = (row) =>
      (Array.isArray(row?.children) ? row.children : [])
        .find((c) => c && typeof c === 'object' && c.type === 'input');

    // ── 壁纸 tab (default): card head + tab bar + wallpaper controls. ──
    localStorage.removeItem(TAB_KEY);
    let tree = renderPicker();
    let treeText = JSON.stringify(tree);
    assert.ok(countMatches(tree, /"role":"tab"/g) === 6, 'tab bar renders (6 tabs):');
    assert.ok(treeText.includes('"we-tabs__tab we-tabs__tab--active"') && treeText.includes('自动轮播'), 'default tab is 壁纸:');
    assert.ok(treeText.includes('"选择壁纸"'), 'wallpaper tab has 选择壁纸:');
    assert.ok(treeText.includes('自定义壁纸'), 'wallpaper tab has 自定义壁纸:');
    console.log('other tabs keep their controls out of the tree:',
      !treeText.includes('玻璃透明度') && !treeText.includes('字体自定义') && !treeText.includes('吉祥物大小'));

    // ── 设置页签重组：六个页签 = 壁纸 / 外观 / 吉祥物 / 效果 / 声音 / 高级 ──
    //    「字体」并入「外观」；「声音」从「效果」里独立出来与「效果」平级。
    {
      const tabButtons = [];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.props && node.props.role === 'tab') tabButtons.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(tree);
      const labels = tabButtons.map((b) => String((b.children || [])[0] || ''));
      assert.deepEqual(labels, ['壁纸', '外观', '吉祥物', '效果', '声音', '高级'],
        'tab bar must render exactly 壁纸/外观/吉祥物/效果/声音/高级');
    }

    // ── 外观 tab: swatches / sliders / sidebar-glass group. ──
    setTab('appearance');
    tree = renderPicker();
    treeText = JSON.stringify(tree);
    assert.ok(treeText.includes('"we-tabs__tab we-tabs__tab--active"'), 'appearance tab active:');
    assert.equal((treeText.match(/"aria-label":"配色 /g) || []).length, 6, '配色预设应有 6 个色板');
    assert.equal((treeText.match(/"aria-label":"玻璃颜色 /g) || []).length, 6, '玻璃颜色预设应有 6 个色板');
    assert.ok(treeText.includes('自定义玻璃颜色'), 'glass color custom input present:');
    assert.ok(treeText.includes('type":"color"'), 'custom color input present:');
    assert.ok(treeText.includes('玻璃透明度'), 'glass transparency slider row present:');
    assert.ok(treeText.includes('侧栏液态玻璃'), 'sidebar-glass master switch present:');
    assert.ok(treeText.includes('侧栏模糊'), 'sidebar blur slider present:');
    assert.ok(treeText.includes('侧栏透明度'), 'sidebar alpha slider present:');
    assert.equal((treeText.match(/"aria-label":"侧栏玻璃颜色 /g) || []).length, 6, '侧栏玻璃颜色预设应有 6 个色板');
    assert.ok(treeText.includes('自定义侧栏玻璃颜色'), 'sidebar glass color custom input present:');
    // The three detail knobs (侧栏模糊 / 侧栏透明度 / 侧栏玻璃颜色) are
    // conditional on the 侧栏液态玻璃 master switch: off → hidden, on →
    // restored, in the SAME render pass (the toggle re-emits synchronously).
    const sidebarSwitch = findCtlInput(tree, '侧栏液态玻璃');
    if (sidebarSwitch) {
      sidebarSwitch.props.onChange({ target: { checked: false } });
      assert.equal(bodyEl.attributes['data-we-sidebar-glass'], undefined, 'sidebar master off must restore native surfaces');
      tree = renderPicker();
      const offText = JSON.stringify(tree);
      console.log('switch off hides the three detail knobs:',
        !offText.includes('侧栏模糊') && !offText.includes('侧栏透明度') && !offText.includes('侧栏玻璃颜色'));
      assert.ok(offText.includes('侧栏液态玻璃'), 'switch itself stays visible when off:');
      sidebarSwitch.props.onChange({ target: { checked: true } });
      assert.equal(bodyEl.attributes['data-we-sidebar-glass'], 'on', 'sidebar master on must re-arm sidebar surfaces');
      tree = renderPicker();
      console.log('switch back on restores the detail knobs:',
        JSON.stringify(tree).includes('侧栏模糊') && JSON.stringify(tree).includes('侧栏透明度') && JSON.stringify(tree).includes('侧栏玻璃颜色'));
    } else {
      console.log('switch off hides the three detail knobs: false (switch not found)');
    }
    assert.equal(sliderMax(findSliderRow(tree, '侧栏模糊')), '200', '侧栏模糊上限必须是 200px');
    assert.equal(sliderMax(findSliderRow(tree, '侧栏透明度')), '200', '侧栏透明度上限必须是 200');
    assert.ok(treeText.includes('设置窗口液态玻璃'), 'whole-window glass master switch present:');
    assert.ok(treeText.includes('整个设置窗口'), 'window glass tooltip present:');

    // ── 「字体」已并入「外观」：老的 localStorage 页签值必须迁移过去（不能把用户
    //    甩回「壁纸」），且字体三件套 + 输入光标都在「外观」里。 ──
    setTab('font');
    tree = renderPicker();
    treeText = JSON.stringify(tree);
    assert.ok(treeText.includes('玻璃透明度'),
      'legacy "font" tab value must migrate to 外观 (its own rows must be on screen)');
    assert.ok(treeText.includes('字体自定义'), '外观 must host the 字体自定义 switch');
    assert.ok(treeText.includes('玻璃透明度') && treeText.includes('字体自定义'), 'legacy font tab migrates into 外观:');
    const fontSwitch = findCtlInput(tree, '字体自定义');
    if (fontSwitch) {
      fontSwitch.props.onChange({ target: { checked: true } });
      tree = renderPicker();
      treeText = JSON.stringify(tree);
      assert.ok(/文字颜色角色/.test(code) && /排版角色/.test(code) && /恢复默认/.test(code),
    '外观 tab 必须揭示字体控件组（角色色组 + 排版角色组 + 恢复默认）—— 单一「字体颜色」行与全局字重/字族都已移除');
      fontSwitch.props.onChange({ target: { checked: false } });
      tree = renderPicker();
      treeText = JSON.stringify(tree);
    }

    // ── 输入光标（#83）: caret color swatches live alongside the font controls
    //    (same 外观 tab now) and are INDEPENDENT of the 字体自定义 master switch. ──
    assert.ok(treeText.includes('输入光标'), '外观 must host the 输入光标 section');
    assert.ok(treeText.includes('输入光标'), 'appearance tab has 输入光标 section:');
    assert.equal((treeText.match(/"aria-label":"光标颜色 /g) || []).length, 7, '光标颜色应有 7 个色板（自动 + 6 预设）');
    assert.ok(treeText.includes('自定义光标颜色'), 'caret custom color input present:');
    const findSwatch = (root, aria) => {
      let hit = null;
      (function walk(node) {
        if (hit || !node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.props && node.props['aria-label'] === aria) { hit = node; return; }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const caretWhite = findSwatch(tree, '光标颜色 #ffffff');
    const caretAuto = findSwatch(tree, '光标颜色 自动');
    console.log('caret 白 preset + 自动 buttons present:', !!caretWhite && !!caretAuto);
    if (caretWhite && caretAuto) {
      caretWhite.props.onClick();
      tree = renderPicker();
      assert.equal(p['--we-caret-color'], '#ffffff', 'picking a caret color must arm --we-caret-color');
      const caretSt = document.getElementById('we-caret-patch');
      console.log('caret style injected with caret-color rule:',
        !!caretSt && String(caretSt.textContent || '').includes('caret-color: var(--we-caret-color) !important'));
      assert.ok(caretSt, 'we-caret-patch style element must exist while a caret color is set');
      caretAuto.props.onClick();
      tree = renderPicker();
      assert.equal(p['--we-caret-color'], undefined, '自动 must clear --we-caret-color');
      assert.equal(document.getElementById('we-caret-patch'), null, '自动 must remove the caret style element');
      console.log('caret 自动 restores native caret: true');
    }

    // ── 吉祥物 tab: rope toggle + form cards (live preview) + size slider. ──
    setTab('mascot');
    tree = renderPicker();
    const ropeToggle = findCtlInput(tree, '显示吉祥物');
    console.log('mascot rope toggle present:', !!ropeToggle);
    if (ropeToggle) {
      assert.ok(ropeToggle.props.checked === true, 'rope toggle checked by default:');
      ropeToggle.props.onChange({ target: { checked: false } });
      tree = renderPicker();
      const ropeOff = findCtlInput(tree, '显示吉祥物');
      assert.ok(!!ropeOff && ropeOff.props.checked === false, 'unchecking hides the rope (checkbox off):');
      ropeToggle.props.onChange({ target: { checked: true } });
      tree = renderPicker();
      const ropeOn = findCtlInput(tree, '显示吉祥物');
      assert.ok(!!ropeOn && ropeOn.props.checked === true, 're-checking restores the rope (checkbox on):');
    } else {
      console.log('mascot rope toggle: false (not found)');
    }
    // Mascot form is now a pair of live-preview cards (aria-pressed = active).
    const findMascotCards = (root) => {
      const found = [];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__mascot-card')) found.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return found;
    };
    const activeForm = (cards) => cards.find((c) => String(c.props.className).includes('--active'));
    let mascotCards = findMascotCards(tree);
    assert.ok(mascotCards.length === 2, 'mascot form cards (expect 2):');
    assert.ok(!!activeForm(mascotCards) && activeForm(mascotCards).props.title === '小女仆', 'default form is maid:');
    const whaleCard = mascotCards.find((c) => c.props.title === '鲸御姐');
    if (whaleCard) { whaleCard.props.onClick(); tree = renderPicker(); }
    mascotCards = findMascotCards(tree);
    assert.ok(!!activeForm(mascotCards) && activeForm(mascotCards).props.title === '鲸御姐', 'form switches to whale:');
    const maidCard = mascotCards.find((c) => c.props.title === '小女仆');
    if (maidCard) { maidCard.props.onClick(); tree = renderPicker(); }
    mascotCards = findMascotCards(tree);
    assert.ok(!!activeForm(mascotCards) && activeForm(mascotCards).props.title === '小女仆', 'form switches back to maid:');
    const ropeScaleSlider = findSliderRow(tree, '吉祥物大小');
    console.log('mascot rope size slider present:', !!ropeScaleSlider);
    if (ropeScaleSlider) {
      const ri = findRangeInput(ropeScaleSlider);
      console.log('rope size slider min/max (0.5/2.5):',
        ri && String(ri.props.min) === '0.5' && String(ri.props.max) === '2.5');
      assert.ok(ri && String(ri.props.value) === '1', 'rope size default scale (1):');
      if (ri) ri.props.onInput({ target: { value: '1.5' } });
      tree = renderPicker();
      const ri2 = findRangeInput(findSliderRow(tree, '吉祥物大小'));
      assert.ok(ri2 && String(ri2.props.value) === '1.5', 'rope size slider updates to 1.5:');
      if (ri2) ri2.props.onInput({ target: { value: '1' } });
      tree = renderPicker();
    } else {
      console.log('mascot rope size slider: false (not found)');
    }

    // ── 「边框」「玻璃(→雾化)」已从「效果」移到「外观」的「细节」段：
    //    在新家要能在、在旧家必须不在（否则就是搬了个寂寞）。 ──
    setTab('appearance');
    tree = renderPicker();
    assert.equal(sliderMax(findSliderRow(tree, '雾化')), '60', '雾化（原「玻璃」）必须在「外观」里，上限 60px');
    assert.equal(sliderMax(findSliderRow(tree, '边框')), '90', '边框必须在「外观」里，上限 90%');
    assert.equal(findSliderRow(tree, '玻璃'), null, '「玻璃」这个行名必须已改掉（避免与玻璃颜色/玻璃透明度撞车）');
    setTab('effects');
    tree = renderPicker();
    assert.equal(findSliderRow(tree, '雾化'), null, '雾化 不得再留在「效果」');
    assert.equal(findSliderRow(tree, '边框'), null, '边框 不得再留在「效果」');
    console.log('边框 / 雾化 已迁到外观（效果里不再有）: ok');
    // 注意：效果页签的 tooltip 里仍会出现「玻璃」二字（壁纸透明度那条），所以这里
    // 用**结构化**判定（slider-row 的标签），不能用 treeText.includes('玻璃')。

    // ── 壁纸透明度（#82）: slider max 90; 60% → layer opacity 0.4; 0% unsets. ──
    const wpOpacityRow = findSliderRow(tree, '壁纸透明度');
    assert.equal(sliderMax(wpOpacityRow), '90', '壁纸透明度上限必须是 90%');
    const wpOpacityInput = findRangeInput(wpOpacityRow);
    if (wpOpacityInput) {
      wpOpacityInput.props.onInput({ target: { value: '60' } });
      tree = renderPicker();
      assert.equal(p['--we-wallpaper-opacity'], '0.4', '壁纸透明度 60% must drive layer opacity 0.4');
      const wpReset = findRangeInput(findSliderRow(tree, '壁纸透明度'));
      if (wpReset) wpReset.props.onInput({ target: { value: '0' } });
      tree = renderPicker();
      assert.equal(p['--we-wallpaper-opacity'], undefined, '壁纸透明度 0% must unset the variable (identity opacity)');
      console.log('壁纸透明度 drives --we-wallpaper-opacity (0.4 @60%, unset @0%): true');
    }

    // ── 壁纸 tab again: modal / pagination / close card / sidebar stays armed.
    setTab('wallpaper');
    tree = renderPicker();
    // The thumbnail grid lives inside the picker MODAL now (settings page
    // shows only the summary + "选择壁纸" trigger). Open the modal by
    // invoking the trigger button's onClick, re-render, then count cards.
    const openBtn = [];
    (function walk(node) {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      const cls = typeof node.props?.className === 'string' ? node.props.className : '';
      if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1 && node.children[0] === '选择壁纸') openBtn.push(node);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    })(tree);
    if (openBtn.length && typeof openBtn[0].props.onClick === 'function') {
      try { openBtn[0].props.onClick(); } catch (e) { console.log('open modal onClick threw:', e && e.message); }
    }
    tree = renderPicker();
    const collectCards = (root) => {
      const cards = [];
      (function walk2(node) {
        if (Array.isArray(node)) { node.forEach(walk2); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        // 按**class 令牌**匹配，不是精确串：卡片有多个修饰态（`--selected` 当前播放、
        // `--checked` 批量勾选），枚举式精确匹配会把 `--checked` 的卡片整批漏掉。
        // 令牌匹配同时排除 `we-picker__card-wrap` 这类近似名（它不是 `we-picker__card`）。
        if (cls.split(/\s+/).includes('we-picker__card')) cards.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk2);
      })(root);
      return cards;
    };
    const clickPager = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1 && node.children[0] === label) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      if (hit && typeof hit.props.onClick === 'function') { try { hit.props.onClick(); } catch (e) { console.log('pager click threw:', e && e.message); } }
      return hit;
    };
    // Page 1: 33 playable wallpapers → 2 pages @ 24; grid = close card + 24.
    // 判据必须**真断言**：整块 `console.log` 只在日志里像断言、不判真假（形态规则见
    // docs/TEST-LAYOUT.md §约定 5）—— 分页器这条路径此前就是这么被漏掉的。
    let cards = collectCards(tree);
    rotCheck('分页：第 1 页 25 张卡（关闭卡 + 24）', cards.length === 25);
    rotCheck('分页：页数 > 1 时渲染分页器', JSON.stringify(tree).includes('we-picker__pager'));
    const page1Text = JSON.stringify(cards);
    rotCheck('分页：第 1 页含首张（Wall 0）', page1Text.includes('Wall 0'));
    rotCheck('分页：第 1 页不含第 2 页的项（Wall 30）', !page1Text.includes('Wall 30'));
    rotCheck('筛选：无 frameUrl 的场景（Scene D）不进网格', !page1Text.includes('Scene D'));
    rotCheck('筛选：默认 Everyone 下 PG13 不进网格', !page1Text.includes('PG13 E'));
    // Flip to page 2 → 33 - 24 = 9 wallpapers + close card = 10.
    const pagerHit = clickPager(tree, '下一页 ›');
    rotCheck('分页：找得到「下一页」按钮（找不到时不得静默通过）', !!pagerHit);
    tree = renderPicker();
    cards = collectCards(tree);
    rotCheck('分页：第 2 页 10 张卡（关闭卡 + 9）', cards.length === 10);
    const page2Text = JSON.stringify(cards);
    rotCheck('分页：第 2 页含末张（Wall 29）', page2Text.includes('Wall 29'));
    rotCheck('分页：翻页后不再含第 1 页的项（Wall 0）', !page2Text.includes('Wall 0'));
    rotCheck('筛选：有 frameUrl 的场景（Scene C）进网格', page2Text.includes('Scene C'));
    // 负对照：把**变异输入**喂进**同一条判据**，证明这两条判据真能失败
    const mutated = { props: { className: 'we-picker__card' },
      children: [{ props: { className: 'we-picker__card-wrap' }, children: [] }] };
    rotCheck('负对照：卡片判据不把近似类名算进去（多算一张就会被判出）',
      collectCards(mutated).length === 1 && collectCards({}).length === 0);
    rotCheck('负对照：两页内容确实不同（否则「翻页换了内容」这条判据恒真）',
      !page1Text.includes('Wall 29') && page2Text.includes('Wall 29'));

    // ── 0b：搜索 / 类型筛选 / 批量 / 隐藏页 / 卡片头计数（这些区域此前零判据）──
    // 判据只在**一处**定义，正判据与负对照都调它（形态规则见 docs/TEST-LAYOUT.md §约定 5）。
    const cardTexts = (root) => collectCards(root).map((c) => JSON.stringify(c));
    // 关闭卡也是 `we-picker__card`（分页计数里它一直算一张）⇒ 判"只剩匹配项"时必须先摘掉它。
    const wallpaperCardTexts = (root) => cardTexts(root).filter((s) => !s.includes('✕ 关闭'));
    const onlyMatching = (root, needle) => {
      const t = wallpaperCardTexts(root);
      return t.length > 0 && t.every((s) => s.includes(needle));
    };
    const synthCards = (texts) => texts.map((t) => ({ props: { className: 'we-picker__card' }, children: [t] }));
    const findByProp = (root, name, value) => { let hit = null; (function walk(n) {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.props && n.props[name] === value) hit = n;
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return hit; };
    const findByClass = (root, cls) => { let hit = null; (function walk(n) {
      if (hit) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const c = typeof n.props?.className === 'string' ? n.props.className : '';
      if (c.split(/\s+/).includes(cls)) { hit = n; return; }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return hit; };
    const textOf = (root) => { let out = ''; (function walk(n) {
      if (typeof n === 'string') { out += n; return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return out; };
    // 徽标只在**卡片头**里找：壁纸卡片自己也有 `we-picker__card-badge`（如「静态帧」），
    // 不限定范围会取到卡片上那个。
    const badgeOf = (root) => {
      const head = findByClass(root, 'we-picker__card-head');
      const b = head ? findByClass(head, 'we-picker__card-badge') : null;
      return b ? textOf(b) : null;
    };
    const persisted = () => JSON.parse(localStorage._store['dsh-wallpaper-engine:selection'] || '{}');

    // 卡片头徽标 = 当前（过滤后）**全量**可播放数；网格只渲染**当页** —— 两者是"全量与分页"
    // 的关系（上一步翻到了第 2 页，先翻回来让状态确定）。
    clickPager(tree, '‹ 上一页');
    tree = renderPicker();
    assert.equal(badgeOf(tree), '33', '卡片头徽标显示当前可播放数（全量）');
    assert.equal(collectCards(tree).length, 25, '第 1 页渲染关闭卡 + 24 张（全量 33 ⇒ 分两页）');
    assert.ok(textOf(tree).includes('1 / 2'), '分页器显示 1 / 2（页数 = ceil(全量 / 24)）');

    // ── P3-11 阶段 2 交付物 A：模态框**标记等价**（搬迁前后逐字未变）──────────────
    // 模态框那棵子树被 116 个 `.we-picker__*` 选择器按**层级 / 相邻关系**选元素
    // （src/styles.js 586–1603），test/e2e-web-media-origin.mjs 里另有一份**手抄**的
    // picker DOM 镜像 —— 标记只要改一个类名、或只挪一层嵌套，CSS 与那份镜像都会**静默**漂，
    // 所以"搬走这段渲染"必须证明逐字未变。判据：以 `we-picker__modal` 为根深度优先遍历，
    // 把每个元素的 class 令牌按「深度:令牌」摊平成序列，与搬迁前录下的 golden 逐项相等。
    // 深度进序列 ⇒「增删一个类名」与「改一个层级」都会让判据变假（负对照实测）。
    // 三个状态各录一份：普通视图 / 批量模式（批量条 + 勾选标记）/ 隐藏页。
    const modalClassSequence = (root) => {
      const modal = findByClass(root, 'we-picker__modal');
      if (!modal) return [];
      const out = [];
      (function walk(node, depth) {
        if (Array.isArray(node)) { node.forEach((c) => walk(c, depth)); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        for (const token of cls.split(/\s+/).filter(Boolean)) out.push(depth + ':' + token);
        if (Array.isArray(node.children)) node.children.forEach((c) => walk(c, depth + 1));
      })(modal, 0);
      return out;
    };
    // 判据只有这一处：正判据与全部负对照都调它（形态规则见 docs/TEST-LAYOUT.md §约定 5）。
    const classSequenceMatches = (seq, golden) =>
      seq.length === golden.length && seq.every((t, i) => t === golden[i]);
    // 只把**第一个**壁纸卡的深度 +1：序列长度不变，只有层级变 —— 用来证明逐项比较真在比内容。
    const bumpFirstCardDepth = (seq) => {
      const out = seq.slice();
      const i = out.findIndex((t) => t.startsWith('3:we-picker__card'));
      if (i >= 0) out[i] = '4:' + out[i].slice(2);
      return out;
    };
    const EXPECTED_NORMAL = [
      '0:we-picker__modal 1:we-picker__modal-head 2:we-picker__modal-head-left 3:we-vinyl 3:we-vinyl--playing 3:we-vinyl--sm 4:we-vinyl__cover 5:we-vinyl__empty',
      '4:we-vinyl__hole 3:we-picker__modal-title 2:we-picker__btn 1:we-picker__modal-tabs 2:we-picker__btn 2:we-picker__tab 2:we-picker__tab--active 2:we-picker__btn',
      '2:we-picker__tab 1:we-picker__modal-body 2:we-picker__row 3:we-picker__hint 3:we-picker__btn 2:we-picker__row 2:we-picker__filter-row 3:we-picker__text',
      '3:we-picker__search 3:we-picker__hint 3:we-picker__label 3:we-picker__playlist-select 3:we-picker__hint 3:we-picker__label 3:we-picker__playlist-select 2:we-picker__grid',
      '3:we-picker__card 4:we-picker__card-close 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card',
      '4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title',
      '4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder',
      '4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type',
      '4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card',
      '4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title',
      '4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder',
      '4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type',
      '4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card',
      '4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title',
      '4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder',
      '4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-type',
      '4:we-picker__card-title 4:we-picker__card-hide 2:we-picker__pager 3:we-picker__hint 3:we-picker__btn 3:we-picker__btn 1:we-picker__modal-foot 2:we-picker__hint',
    ].join(' ').split(' ');
    const EXPECTED_BATCH = [
      '0:we-picker__modal 1:we-picker__modal-head 2:we-picker__modal-head-left 3:we-vinyl 3:we-vinyl--playing 3:we-vinyl--sm 4:we-vinyl__cover 5:we-vinyl__empty',
      '4:we-vinyl__hole 3:we-picker__modal-title 2:we-picker__btn 1:we-picker__modal-tabs 2:we-picker__btn 2:we-picker__tab 2:we-picker__tab--active 2:we-picker__btn',
      '2:we-picker__tab 1:we-picker__modal-body 2:we-picker__row 3:we-picker__hint 3:we-picker__btn 2:we-picker__row 2:we-picker__batch-bar 3:we-picker__hint',
      '3:we-picker__btn 3:we-picker__btn 2:we-picker__row 2:we-picker__filter-row 3:we-picker__text 3:we-picker__search 3:we-picker__hint 3:we-picker__label',
      '3:we-picker__playlist-select 3:we-picker__hint 3:we-picker__label 3:we-picker__playlist-select 2:we-picker__grid 3:we-picker__card 4:we-picker__card-close 3:we-picker__card',
      '3:we-picker__card--checked 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check 3:we-picker__card 4:we-picker__card-placeholder 4:we-picker__card-title 4:we-picker__card-check',
      '2:we-picker__pager 3:we-picker__hint 3:we-picker__btn 3:we-picker__btn 1:we-picker__modal-foot 2:we-picker__hint',
    ].join(' ').split(' ');
    const EXPECTED_HIDDEN = [
      '0:we-picker__modal 1:we-picker__modal-head 2:we-picker__modal-head-left 3:we-vinyl 3:we-vinyl--playing 3:we-vinyl--sm 4:we-vinyl__cover 5:we-vinyl__empty',
      '4:we-vinyl__hole 3:we-picker__modal-title 2:we-picker__btn 1:we-picker__modal-tabs 2:we-picker__btn 2:we-picker__tab 2:we-picker__btn 2:we-picker__tab',
      '2:we-picker__tab--active 1:we-picker__modal-body 2:we-picker__grid 3:we-picker__row 4:we-picker__hint 4:we-picker__btn 3:we-picker__card 3:we-picker__card--hidden',
      '4:we-picker__card-placeholder 4:we-picker__card-type 4:we-picker__card-title 4:we-picker__card-hide 1:we-picker__modal-foot 2:we-picker__hint',
    ].join(' ').split(' ');
    const modalRoot = findByClass(tree, 'we-picker__modal');
    const seqNormal = modalClassSequence(tree);
    // 绝对锚点（不读 golden）：否则"两边都空"也算相等。
    assert.equal(seqNormal.length, 160, '绝对锚点：普通视图的 class 令牌数（空序列不得算通过）');
    assert.ok(collectCards(modalRoot).length >= 25, '绝对锚点：模态框里的卡片数 ≥ 25（关闭卡 + 当页 24 张）');
    assert.ok(classSequenceMatches(seqNormal, EXPECTED_NORMAL), '普通视图：模态框标记序列与搬迁前逐字一致');
    // 负对照：把**变异输入**喂进**同一条判据**
    assert.ok(!classSequenceMatches(seqNormal.filter((_, i) => i !== 7), EXPECTED_NORMAL),
      '负对照：删掉一个类名 ⇒ 判据变假');
    assert.ok(!classSequenceMatches(seqNormal.concat(['0:we-picker__fake']), EXPECTED_NORMAL),
      '负对照：插入一个类名 ⇒ 判据变假');
    assert.ok(!classSequenceMatches(bumpFirstCardDepth(seqNormal), EXPECTED_NORMAL),
      '负对照：只把一个节点的层级挪一格（长度不变）⇒ 判据变假');
    assert.ok(!classSequenceMatches([], EXPECTED_NORMAL), '负对照：空序列不得算作"一致"');

    // 搜索：标题过滤（输入即过滤）+ 瞬态不落盘
    const searchInput = findByClass(tree, 'we-picker__search');
    assert.ok(searchInput && typeof searchInput.props.onInput === 'function', '搜索框必须存在且可输入');
    searchInput.props.onInput({ target: { value: 'Wall 3' } });
    tree = renderPicker();
    assert.ok(onlyMatching(tree, 'Wall 3'), '搜索 Wall 3 ⇒ 网格只剩匹配项');
    assert.ok(collectCards(tree).length < 25, '命中数必须真的变少（不是换页）');
    assert.equal(Number(badgeOf(tree)), collectCards(tree).length - 1, '跨层对拍（搜索后）：徽标数 == 网格卡片数');
    assert.ok(!JSON.stringify(persisted()).includes('"search"'), '搜索是瞬态字段，不得落盘');
    // 负对照：把**变异输入**喂进同一条判据
    assert.ok(onlyMatching(synthCards(['Wall 3', 'Wall 30']), 'Wall 3'), '负对照：全匹配时判据为真');
    assert.ok(!onlyMatching(synthCards(['Wall 3', 'Wall 40']), 'Wall 3'), '负对照：混入一张不匹配 ⇒ 判据变假');
    assert.ok(!onlyMatching(synthCards([]), 'Wall 3'), '负对照：空网格不得算作「只剩匹配项」');
    // 搜不到 ⇒ 只剩关闭卡（网格空态），徽标归 0
    searchInput.props.onInput({ target: { value: '不存在的标题 zzz' } });
    tree = renderPicker();
    assert.equal(collectCards(tree).length, 1, '搜不到时网格只剩关闭卡');
    assert.equal(badgeOf(tree), '0', '搜不到时徽标显示 0');
    searchInput.props.onInput({ target: { value: '' } });
    tree = renderPicker();

    // 类型筛选：持久化设置（走 setSetting），且真的换掉网格内容
    const typeSel = findByProp(tree, 'aria-label', '类型');
    assert.ok(typeSel && typeof typeSel.props.onChange === 'function', '类型筛选必须存在且可切换');
    assert.ok(typeSel.children.some((o) => o && o.props && o.props.value === 'scene'), '类型筛选必须有「场景」档');
    typeSel.props.onChange({ target: { value: 'scene' } });
    tree = renderPicker();
    assert.ok(onlyMatching(tree, 'Scene'), '类型=场景 ⇒ 网格只剩场景卡');
    assert.equal(findByProp(tree, 'aria-label', '类型').props.value, 'scene', '类型筛选落到状态（重渲染后的值）');
    // 落盘是 200ms 去抖 ⇒ 读 localStorage 前必须先把在途的 persist 放掉（同 rotation 段的做法）
    for (const t of rotationTimers.filter((x) => !x.cleared && !x.fired && x.ms === 200)) { t.fired = true; t.fn(); }
    assert.equal(persisted().typeFilter, 'scene', '类型筛选是持久化设置（setSetting 落盘）');
    typeSel.props.onChange({ target: { value: 'all' } });
    tree = renderPicker();
    assert.equal(collectCards(tree).length, 25, '类型切回全部 ⇒ 网格恢复满页');

    // 批量模式：进入/勾选/计数/退出不留痕
    assert.ok(clickPager(tree, '批量'), '批量按钮必须存在');
    tree = renderPicker();
    const batchBar = findByClass(tree, 'we-picker__batch-bar');
    assert.ok(batchBar, '进入批量 ⇒ 出现批量条');
    assert.ok(textOf(batchBar).includes('已选 0 张'), '批量条初始计数为 0');
    const pickCard = collectCards(tree).find((c) => JSON.stringify(c).includes('Wall 0'));
    assert.ok(pickCard && typeof pickCard.props.onClick === 'function', '批量模式下卡片仍可点');
    pickCard.props.onClick();
    tree = renderPicker();
    assert.ok(textOf(findByClass(tree, 'we-picker__batch-bar')).includes('已选 1 张'), '点一张卡 ⇒ 计数变 1');
    const seqBatch = modalClassSequence(tree);
    assert.ok(classSequenceMatches(seqBatch, EXPECTED_BATCH),
      '批量模式：模态框标记序列与搬迁前逐字一致（多出批量条与勾选标记）');
    // 勾选标记是批量模式下卡片里的 `we-picker__card-check`（选中显示 ✓，未选为空字符串）
    const checkOf = (root, title) => {
      const card = collectCards(root).find((c) => JSON.stringify(c).includes(title));
      const span = card ? findByClass(card, 'we-picker__card-check') : null;
      return span ? textOf(span) : null;
    };
    assert.equal(checkOf(tree, 'Wall 0'), '✓', '被选中的卡片带 ✓ 勾选标记');
    assert.equal(checkOf(tree, 'Wall 1'), '', '未选中的卡片勾选标记为空（不是所有卡都算选中）');
    assert.ok(clickPager(tree, '取消'), '批量条必须有「取消」');
    tree = renderPicker();
    assert.equal(findByClass(tree, 'we-picker__batch-bar'), null, '退出批量 ⇒ 批量条消失');
    assert.equal(checkOf(tree, 'Wall 0'), null, '退出批量 ⇒ 勾选标记消失（零残留）');
    assert.ok(findByClass(tree, 'we-picker__card-hide'), '退出批量 ⇒ 卡片恢复「隐藏」按钮');
    // 负对照：批量条计数判据对变异输入有牙
    const fakeBar = { props: { className: 'we-picker__batch-bar' }, children: ['已选 9 张'] };
    assert.ok(!textOf(fakeBar).includes('已选 0 张') && textOf(fakeBar).includes('已选 9 张'),
      '负对照：计数判据读的是渲染值（换个数字就不再命中）');

    // 隐藏页：真隐藏一张 ⇒ hiddenIds +1 ⇒ 页签计数与隐藏页文案同步（跨状态一致）
    const flushPersistTimers = () => {
      for (const t of rotationTimers.filter((x) => !x.cleared && !x.fired && x.ms === 200)) { t.fired = true; t.fn(); }
    };
    const findHiddenTab = (root) => { let hit = null; (function walk(n) {
      if (hit) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const c = typeof n.props?.className === 'string' ? n.props.className : '';
      if (c.split(/\s+/).includes('we-picker__tab') && textOf(n).includes('已隐藏')) { hit = n; return; }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return hit; };
    const hiddenCountMatches = (text, n) => text.includes('已隐藏 ' + n + ' 张');
    const beforeHidden = persisted().hiddenIds.length;
    const hideBtn = findByClass(tree, 'we-picker__card-hide');
    assert.ok(hideBtn && typeof hideBtn.props.onClick === 'function', '普通视图的卡片上必须有「隐藏」按钮');
    hideBtn.props.onClick({ stopPropagation() {} });
    tree = renderPicker();
    flushPersistTimers();
    assert.equal(persisted().hiddenIds.length, beforeHidden + 1, '隐藏一张 ⇒ hiddenIds 增 1（且被持久化）');
    assert.ok(findHiddenTab(tree) && textOf(findHiddenTab(tree)).includes('已隐藏（' + (beforeHidden + 1) + '）'),
      '页签上的已隐藏计数跟随 hiddenIds');
    assert.ok(!wallpaperCardTexts(tree).some((s) => s.includes('"Wall 0"')),
      '被隐藏的壁纸不再出现在普通网格里');
    findHiddenTab(tree).props.onClick();
    tree = renderPicker();
    assert.ok(hiddenCountMatches(textOf(tree), beforeHidden + 1),
      '隐藏页标题的计数与 hiddenIds 一致（当前 ' + (beforeHidden + 1) + '）');
    const seqHidden = modalClassSequence(tree);
    assert.ok(classSequenceMatches(seqHidden, EXPECTED_HIDDEN),
      '隐藏页：模态框标记序列与搬迁前逐字一致');
    // 负对照：把**变异输入**喂进同一条「计数一致」判据
    assert.ok(!hiddenCountMatches('已隐藏 7 张', 3) && hiddenCountMatches('已隐藏 3 张', 3),
      '负对照：计数对不上号判为假、对得上为真（判据不是恒真）');
    // 复原（否则后面依赖 Wall 0 在网格里的断言会红）：隐藏页里的按钮是"恢复此壁纸"
    // —— 与普通视图的"隐藏"**同类名**（`we-picker__card-hide`），靠 title 区分。
    const restoreBtn = findByClass(tree, 'we-picker__card-hide');
    assert.ok(restoreBtn && restoreBtn.props.title === '恢复此壁纸', '隐藏页卡片的按钮是「恢复此壁纸」');
    restoreBtn.props.onClick({ stopPropagation() {} });
    tree = renderPicker();
    flushPersistTimers();
    assert.equal(persisted().hiddenIds.length, beforeHidden, '恢复那张 ⇒ hiddenIds 回到原值');
    assert.ok(textOf(findHiddenTab(tree)).includes('已隐藏（' + beforeHidden + '）'), '页签计数随之回落');
    // 回到普通视图（后续段落假定它在普通视图）
    findByClass(tree, 'we-picker__tab').props.onClick();
    tree = renderPicker();

    // ── 0b：模态框键盘可达性（Tab 陷阱 + 初始焦点）──────────────────────────
    const fakeButton = () => { const el = makeEl('button'); el.disabled = false; el.tabIndex = 0; el.getClientRects = () => [1]; return el; };
    const modalNode = findByClass(tree, 'we-picker__modal');
    assert.ok(modalNode && typeof modalNode.props.onKeyDown === 'function', '模态框必须挂着 onKeyDown（Tab 陷阱）');
    // 判据只在**一处**：跑一次 Tab/Shift+Tab，回"是否拦下 + 焦点落到第几个"（正负共用）
    const tabTrap = (shift, activeIndex, count) => {
      const els = Array.from({ length: count }, fakeButton);
      if (count) els[activeIndex].focus();
      let prevented = false;
      modalNode.props.onKeyDown({
        key: 'Tab', shiftKey: shift, preventDefault: () => { prevented = true; },
        currentTarget: { querySelectorAll: () => els },
      });
      return { prevented, active: els.findIndex((el) => document.activeElement === el) };
    };
    assert.deepEqual(tabTrap(false, 2, 3), { prevented: true, active: 0 }, 'Tab 在最后一个 ⇒ 拦下并绕回第一个');
    assert.deepEqual(tabTrap(true, 0, 3), { prevented: true, active: 2 }, 'Shift+Tab 在第一个 ⇒ 拦下并绕回最后一个');
    assert.deepEqual(tabTrap(false, 1, 3), { prevented: false, active: 1 }, 'Tab 在中间 ⇒ 不拦（否则焦点被锁死）');
    assert.deepEqual(tabTrap(false, 0, 0), { prevented: false, active: -1 }, '没有可聚焦元素 ⇒ 不拦也不炸（负对照）');
    // 初始焦点：面板在打开 picker 时置 `pickerFocusPending`，模态框关闭按钮的 ref 消费它（一次性）
    const findCloseBtn = (root) => { let hit = null; (function walk(n) {
      if (hit) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const c = typeof n.props?.className === 'string' ? n.props.className : '';
      if (c.split(/\s+/).includes('we-picker__btn') && textOf(n) === '关闭' && typeof n.props.ref === 'function') { hit = n; return; }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return hit; };
    const closeBtn = findCloseBtn(tree);
    assert.ok(closeBtn, '模态框的关闭按钮必须挂 ref（初始焦点落点）');
    const fakeClose = fakeButton();
    closeBtn.props.ref(fakeClose);
    assert.equal(document.activeElement, fakeClose, '打开模态框后初始焦点落在关闭按钮上');
    const elsewhere = fakeButton(); elsewhere.focus();
    closeBtn.props.ref(fakeButton());
    assert.equal(document.activeElement, elsewhere, 'ref 只消费一次（第二次不得把焦点抢回来）');

    // ── 0b：轮换列表编辑器（选项文案 / 改间隔 / 删除组，confirm 门控）────────
    // 挂载台没有 `window.confirm`，而客户端写的是 `window.confirm(...)`（属性访问）⇒ 直接给
    // 沙箱的 window 挂一个**可切换答案**的实现即可（无需改挂载台），顺带解锁批量隐藏与
    // 「全部恢复」这两条 confirm 门控路径。
    let confirmAnswer = true;
    const confirmCalls = [];
    sandbox.window.confirm = (msg) => { confirmCalls.push(String(msg)); return confirmAnswer; };
    const groupSel = findByProp(tree, 'aria-label', '轮播列表');
    assert.ok(groupSel && typeof groupSel.props.onChange === 'function', '轮播列表下拉必须存在');
    const groupOptionText = (sel) => sel.children.filter((o) => o && o.props && o.props.value !== undefined)
      .map((o) => textOf(o)).join(' | ');
    assert.ok(groupOptionText(groupSel).includes('My list（2 可播放 · 5 分钟）'),
      '每个列表的选项文案 = 名称（可播放数 · 间隔分钟）：' + groupOptionText(groupSel));
    // 改间隔：写进**当前活动列表**（无 confirm）
    const intervalSel = findByProp(tree, 'aria-label', '轮转间隔');
    assert.ok(intervalSel && typeof intervalSel.props.onChange === 'function', '轮转间隔下拉必须存在');
    intervalSel.props.onChange({ target: { value: '30' } });
    tree = renderPicker();
    flushPersistTimers();
    const activeGroup = () => persisted().rotationGroups.find((x) => x.id === persisted().rotationGroupId);
    assert.equal(activeGroup().interval, 30, '改间隔 ⇒ 写进活动列表（并落盘）');
    assert.equal(findByProp(tree, 'aria-label', '轮转间隔').props.value, '30', '下拉回读新间隔');
    // 删除列表：confirm 门控 —— 先答 false（不删），再答 true（真删，且不留悬空 id）
    const findBtnByText = (root, label) => { let hit = null; (function walk(n) {
      if (hit) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      const c = typeof n.props?.className === 'string' ? n.props.className : '';
      if (c.split(/\s+/).includes('we-picker__btn') && textOf(n) === label && typeof n.props.onClick === 'function') { hit = n; return; }
      if (Array.isArray(n.children)) n.children.forEach(walk);
    })(root); return hit; };
    const groupsBefore = persisted().rotationGroups.length;
    // 判据读**渲染出的**状态，不读 localStorage：`deleteGroup` 直接改内存（splice）而不落盘，
    // 拿 localStorage 比会得到一条恒真的空转判据（取消也"通过"）。
    const groupOptionCount = (t) => findByProp(t, 'aria-label', '轮播列表').children
      .filter((o) => o && o.props && o.props.value).length;
    confirmAnswer = false;
    findBtnByText(tree, '删除').props.onClick();
    tree = renderPicker();
    assert.equal(confirmCalls.length, 1, '删除前必须先问一次（confirm）');
    assert.equal(groupOptionCount(tree), groupsBefore, 'confirm=false ⇒ 不删（取消就是取消）');
    confirmAnswer = true;
    findBtnByText(tree, '删除').props.onClick();
    tree = renderPicker();
    assert.equal(groupOptionCount(tree), groupsBefore - 1, 'confirm=true ⇒ 真删（下拉里少一个列表）');
    assert.equal(findByProp(tree, 'aria-label', '轮播列表').props.value, '', '删掉活动列表 ⇒ 选择回落为空（不留悬空 id）');
    assert.ok(textOf(findByProp(tree, 'aria-label', '轮播列表')).includes('暂无轮播列表'),
      '删光之后下拉显示「暂无轮播列表」（而不是一个空下拉）');

    // 新建 / 保存：此刻列表已被删空 ⇒ 保存后应恰好回到 1 个（断言是确定的）
    assert.ok(findBtnByText(tree, '新建'), '轮播列表必须有「新建」');
    findBtnByText(tree, '新建').props.onClick();
    tree = renderPicker();
    const nameInput = findByProp(tree, 'aria-label', '轮播列表名称');
    assert.ok(nameInput && typeof nameInput.props.onInput === 'function', '新建 ⇒ 打开编辑页（名称输入框）');
    assert.ok(findByProp(tree, 'aria-label', '轮播间隔'), '编辑页要有间隔档');
    assert.ok(findByProp(tree, 'aria-label', '轮播顺序'), '编辑页要有顺序档');
    const editorCard = findByClass(tree, 'we-picker__editor-card');
    assert.ok(editorCard && typeof editorCard.props.onClick === 'function', '编辑页要列出候选壁纸');
    editorCard.props.onClick();
    tree = renderPicker();
    assert.ok(textOf(tree).includes('已选 1 个'), '点候选 ⇒ 草稿里已选 1 个');
    nameInput.props.onInput({ target: { value: '新列表' } });
    tree = renderPicker();
    assert.equal(findByProp(tree, 'aria-label', '轮播列表名称').props.value, '新列表', '名称输入回写草稿');
    assert.equal(groupOptionCount(tree), 0, '保存之前下拉里仍是 0 个（判据能区分保存前后）');
    findBtnByText(tree, '保存').props.onClick();
    tree = renderPicker();
    assert.equal(groupOptionCount(tree), 1, '保存 ⇒ 轮播列表从 0 变成 1');
    assert.ok(groupOptionText(findByProp(tree, 'aria-label', '轮播列表')).includes('新列表'),
      '新列表以草稿里的名字出现在下拉里');
    assert.equal(findByProp(tree, 'aria-label', '轮播列表名称'), null, '保存后编辑页关闭');
    // 负对照：把变异输入喂进同一条"下拉里出现该名字"判据
    assert.ok(!groupOptionText({ children: ['别的列表（1 可播放 · 5 分钟）'] }).includes('新列表'),
      '负对照：同一条判据对不含该名字的选项文案为假');
    // 切换活动列表：再造一个（夹具只有一个 ⇒ 要测"切到另一个"就得先造第二个）
    const optionIds = (t) => findByProp(t, 'aria-label', '轮播列表').children
      .filter((o) => o && o.props && o.props.value).map((o) => o.props.value);
    assert.equal(optionIds(tree).length, 1, '此刻恰好一个列表');
    findBtnByText(tree, '新建').props.onClick();
    tree = renderPicker();
    findByProp(tree, 'aria-label', '轮播列表名称').props.onInput({ target: { value: '第二个' } });
    tree = renderPicker();
    findByClass(tree, 'we-picker__editor-card').props.onClick();
    tree = renderPicker();
    findBtnByText(tree, '保存').props.onClick();
    tree = renderPicker();
    assert.equal(optionIds(tree).length, 2, '再保存一个 ⇒ 两个列表');
    const activeNow = findByProp(tree, 'aria-label', '轮播列表').props.value;
    const other = optionIds(tree).find((id) => id !== activeNow);
    findByProp(tree, 'aria-label', '轮播列表').props.onChange({ target: { value: other } });
    tree = renderPicker();
    assert.equal(findByProp(tree, 'aria-label', '轮播列表').props.value, other,
      'onGroupChange ⇒ 活动列表真的切过去了（下拉值跟着变）');

    // ── 0b：批量隐藏（confirm 门控）+ 隐藏页「全部恢复」──────────────────────
    // 先答 false（不隐藏、且不退批量），再答 true（隐藏并从网格消失、自动退批量），最后用
    // 隐藏页的「全部恢复」把状态收回去 —— 三步都读**渲染出的**证据。
    // （放在轮换块之后：`confirmAnswer` 与 `findBtnByText` 都在那里声明。）
    assert.ok(clickPager(tree, '批量'), '批量按钮必须存在');
    tree = renderPicker();
    const batchPick = collectCards(tree).find((c) => JSON.stringify(c).includes('Wall 0'));
    assert.ok(batchPick && typeof batchPick.props.onClick === 'function', '批量模式下卡片可点');
    batchPick.props.onClick();
    tree = renderPicker();
    confirmAnswer = false;
    findBtnByText(tree, '批量隐藏').props.onClick();
    tree = renderPicker();
    assert.ok(wallpaperCardTexts(tree).some((s) => s.includes('"Wall 0"')), 'confirm=false ⇒ 不隐藏（取消就是取消）');
    assert.ok(findByClass(tree, 'we-picker__batch-bar'), 'confirm=false ⇒ 仍留在批量模式（选择没被清掉）');
    confirmAnswer = true;
    findBtnByText(tree, '批量隐藏').props.onClick();
    tree = renderPicker();
    assert.ok(!wallpaperCardTexts(tree).some((s) => s.includes('"Wall 0"')), 'confirm=true ⇒ 被隐藏的壁纸退出网格');
    assert.equal(findByClass(tree, 'we-picker__batch-bar'), null, '隐藏成功后自动退出批量模式');
    findHiddenTab(tree).props.onClick();
    tree = renderPicker();
    assert.ok(textOf(tree).includes('已隐藏 ' + (beforeHidden + 1) + ' 张'),
      '隐藏页计数 +1（批量隐藏走的是同一条隐藏路径）');
    assert.ok(findBtnByText(tree, '全部恢复'), '隐藏页必须有「全部恢复」');
    findBtnByText(tree, '全部恢复').props.onClick();
    tree = renderPicker();
    assert.ok(textOf(findHiddenTab(tree)).includes('已隐藏（' + beforeHidden + '）'), '全部恢复 ⇒ 计数回到零基');
    findByClass(tree, 'we-picker__tab').props.onClick();
    tree = renderPicker();
    assert.ok(wallpaperCardTexts(tree).some((s) => s.includes('"Wall 0"')), '全部恢复 ⇒ 那张壁纸回到网格');

    // ── 0b：库存加载失败的错误态 + 「重试」恢复（WallpaperPicker 的两条早退分支）──
    // 进错误态的唯一入口是"重载库存失败"⇒ 先用页签里的「刷新」把它打失败（真实路径，不是注入状态）。
    const showsInventoryError = (t) => textOf(t).includes('未检测到 Wallpaper Engine：');
    inventoryFails = true;
    findBtnByText(tree, '刷新').props.onClick();
    await new Promise((r) => setTimeout(r, 80)); // 等 loadInventory 的 promise 落定
    tree = renderPicker();
    assert.ok(showsInventoryError(tree), '库存加载失败 ⇒ 显示「未检测到 Wallpaper Engine：<原因>」');
    assert.ok(findBtnByText(tree, '重试'), '错误态必须给「重试」按钮（否则用户无路可走）');
    assert.equal(findBtnByText(tree, '刷新'), null, '错误态下整块面板被替换（不是叠在面板上）');
    // 负对照：把变异输入喂进同一条判据
    assert.ok(showsInventoryError({ children: ['未检测到 Wallpaper Engine：合成'] }),
      '负对照：合成文本必须被判为错误态（判据读的是渲染文本，不是常量）');
    // 重试：开关放回成功 ⇒ 点「重试」⇒ 面板与网格都应回来
    inventoryFails = false;
    findBtnByText(tree, '重试').props.onClick();
    await new Promise((r) => setTimeout(r, 80));
    tree = renderPicker();
    assert.ok(!showsInventoryError(tree), '重试成功 ⇒ 错误态消失');
    assert.ok(findByProp(tree, 'aria-label', '类型'), '恢复后回到正常面板（类型筛选下拉回来了）');

    // ── 0b：ESC 关闭 picker（处理器住在 useEffect 里 ⇒ 必须让 effect 跑一次才可达）──────
    // 做法：**临时**把 mock 的 `useEffect` 换成收集器 ⇒ 渲染一次拿到注册函数 ⇒ 立刻还原 ⇒
    // 再跑收集到的 effect（它们只做注册）⇒ 派发 keydown。全程不改全局行为，所以不会牵动既有
    // 断言里的定时器与监听时序（把 useEffect 永久改成"会跑"会打开一堆路径，那是另一件事）。
    if (!findByClass(tree, 'we-picker__modal')) {
      const reopener = findBtnByText(tree, '选择壁纸');
      assert.ok(reopener, '前置：模态框关着时必须能找到「选择壁纸」入口');
      reopener.props.onClick();
      tree = renderPicker();
    }
    assert.ok(findByClass(tree, 'we-picker__modal'), '前置：模态框当前是打开的');
    const collectedEffects = [];
    const realUseEffect = React.useEffect;
    React.useEffect = (fn) => { collectedEffects.push(fn); };
    tree = renderPicker();
    React.useEffect = realUseEffect;
    assert.ok(collectedEffects.length >= 1, '渲染期必须注册 effect（ESC 处理器就住在里面）');
    const keydownBefore = (winListeners['keydown'] || []).length;
    for (const fn of collectedEffects) { try { fn(); } catch { /* 依赖挂载台没有的宿主接口的 effect，忽略 */ } }
    assert.ok((winListeners['keydown'] || []).length > keydownBefore,
      '窗口上必须因此多一个 keydown 处理器（capture 注册）');
    const dispatchKey = (key) => {
      const beforeOpen = !!findByClass(renderPicker(), 'we-picker__modal');
      for (const fn of [...(winListeners['keydown'] || [])]) {
        fn({ key, type: 'keydown', stopPropagation() {}, preventDefault() {} });
      }
      return { beforeOpen, afterOpen: !!findByClass(renderPicker(), 'we-picker__modal') };
    };
    assert.deepEqual(dispatchKey('Enter'), { beforeOpen: true, afterOpen: true },
      '负对照：非 Escape 键不得关闭（与下一条共用同一条判据）');
    assert.deepEqual(dispatchKey('Escape'), { beforeOpen: true, afterOpen: false },
      'Escape ⇒ 关闭 picker（模态框从渲染树里消失）');

    // Turn the active wallpaper off through the real picker callback. Sidebar
    // theming must remain armed because it is an independent feature; only
    // wallpaper-owned layers and the data-we-wallpaper marker disappear.
    const closeCard = cards.find((card) => JSON.stringify(card).includes('✕ 关闭'));
    assert.ok(closeCard && typeof closeCard.props.onClick === 'function', 'close-wallpaper card must be available');
    closeCard.props.onClick();
    assert.equal(bodyEl.attributes['data-we-wallpaper'], undefined, 'wallpaper marker must clear');
    assert.equal(bodyEl.attributes['data-we-sidebar-glass'], 'on', 'sidebar glass must remain enabled');
    assert.equal(typeof p['--we-sidebar-color'], 'string', 'sidebar color variable must remain available');
    assert.equal(typeof p['--we-sidebar-alpha'], 'string', 'sidebar alpha variable must remain available');
    assert.equal(typeof p['--we-sidebar-blur'], 'string', 'sidebar blur variable must remain available');
    console.log('sidebar glass remains armed without an active wallpaper: true');
  }

  // ── GPU 抓帧缓存：状态提示 + 清除入口（面板）──────────────────────────
  // 按用户决策：_gpu.png 存在时优先于「出图来源」全部档位，所以切档位
  // 的前置动作是先清除。这里验证完整链路：选中场景 → HEAD 探测 → 面板出现
  // 「清除 GPU 帧」→ 点击 → DELETE 打到 host → 提示行消失。
  {
    // 与上文 setTab 同款：mock 的 useState 每次渲染都取 initializer，
    // 重新种 localStorage 再渲染即可确定性地切到目标 tab。
    // 「画面」section（出图来源 + GPU 帧行）在「效果」tab 里。
    localStorage.setItem('dsh-wallpaper-engine:picker-tab', 'effects');
    assert.ok(pickerRenders.length > 0, 'picker render 回调必须已注册');
    // 等 boot 的 promise 链（loadPersisted → loadInventory →
    // revalidateSelection）全部落定：它会按持久化 id 覆盖选择。
    await new Promise((r) => setTimeout(r, 80));
    const renderPicker = () => {
      try { return pickerRenders[0](); } catch (e) { console.log('picker render threw:', e && e.message); return null; }
    };
    const reopenPicker = () => {
      let tree2 = renderPicker();
      const openBtn = [];
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1
          && node.children[0] === '选择壁纸') openBtn.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(tree2);
      if (openBtn.length) { try { openBtn[0].props.onClick(); } catch { /* ignore */ } }
      return renderPicker();
    };
    const findBtn = (root, label) => {
      let hit = null;
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls.includes('we-picker__btn') && Array.isArray(node.children) && node.children.length === 1
          && node.children[0] === label) hit = node;
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return hit;
    };
    const findCard = (root, text) => {
      const cards = [];
      (function walk(node) {
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node || typeof node !== 'object') return;
        const cls = typeof node.props?.className === 'string' ? node.props.className : '';
        if (cls === 'we-picker__card' || cls.startsWith('we-picker__card ')) cards.push(node);
        if (Array.isArray(node.children)) node.children.forEach(walk);
      })(root);
      return cards.find((card) => JSON.stringify(card).includes(text));
    };
    let tree3 = reopenPicker();
    // 前置：先点选一张视频壁纸把层建出来（上文「无活动壁纸」用例清掉了层），
    // 否则 scene C 是首层、无旧层可淡，手动淡出的断言失去对象。Wall 0 在
    // 第 1 页：往前翻（上一页）找，翻到首页必现。
    let seedCard = findCard(tree3, 'Wall 0');
    for (let i = 0; i < 6 && !seedCard; i++) {
      const prev = findBtn(tree3, '‹ 上一页');
      if (!prev || prev.props.disabled) break;
      prev.props.onClick();
      tree3 = reopenPicker();
      seedCard = findCard(tree3, 'Wall 0');
    }
    assert.ok(seedCard && typeof seedCard.props.onClick === 'function', 'video card (Wall 0) must be clickable');
    seedCard.props.onClick(); // 建首层（existing=null → 本步不淡，正常）
    // 场景 C 落在第 2 页（上文翻页后 sel.page 就停在那里）——若不在，翻页找。
    let sceneCard = findCard(tree3, 'Scene C');
    for (let i = 0; i < 4 && !sceneCard; i++) {
      const next = findBtn(tree3, '下一页 ›');
      if (!next || next.props.disabled) break;
      next.props.onClick();
      tree3 = reopenPicker();
      sceneCard = findCard(tree3, 'Scene C');
    }
    assert.ok(sceneCard && typeof sceneCard.props.onClick === 'function', 'scene C card must be clickable');
    const manualPreLayer = document.getElementById('dsh-wallpaper-engine-layer');
    sceneCard.props.onClick(); // 选中场景壁纸 → syncLayers → HEAD 探测
    await new Promise((r) => setTimeout(r, 20)); // 等 HEAD 探测的 promise 回来
    // 「画面」section（含 GPU 提示行）在 tab 面板里，模态框只渲染网格 →
    // 选中后关掉模态框再断言（模态框关闭按钮文案恰为「关闭」）。
    const modalClose = findBtn(renderPicker(), '关闭');
    assert.ok(modalClose, '模态框应有「关闭」按钮');
    modalClose.props.onClick();
    assert.ok(sceneFrameHeadCalls.some((u) => u.includes('/scene-frame/ccc')),
      '选中场景壁纸后必须 HEAD 探测 GPU 帧状态（面板据此提示）');
    // ── 手动切换（非轮换）也是交叉淡化：此前只有轮换 commit 置 pendingRotationFade
    //    才淡，手动点选硬切 —— 旧层即拆、下一张的静态帧缓存直接上屏。改为按
    //    weWid 判定（层上 weWid ≠ 当前选择 id → 淡出）。syncLayers 在 onClick
    //    内同步完成，无需再等待。
    const manualPostLayer = document.getElementById('dsh-wallpaper-engine-layer');
    assert.ok(manualPreLayer && manualPreLayer.dataset.weFading === '1',
      '手动切换：旧壁纸层必须标记 weFading 淡出保留（不得即拆）');
    assert.ok(manualPreLayer.id === '',
      '手动切换：旧层必须让出 LAYER_ID');
    assert.ok(manualPostLayer && manualPostLayer !== manualPreLayer
      && manualPostLayer.className.indexOf('we-layer--switch') !== -1,
      '手动切换：新层必须带 switch 过场类（交叉淡化，不是硬切）');
    assert.ok(manualPostLayer.dataset.weWid === 'c',
      '新层必须记录 weWid（后续重建按它判定是否换壁纸）');
    tree3 = renderPicker(); // 模态框已关：此时渲染的是 tab 面板（含「画面」section）
    // 画面来源三行的门禁（2026-09-26 按用户反馈调整）：
    // 「出图来源」换的是 CPU 静态帧 → 只在 live 未生效时出现；「实时帧」（GPU 抓帧
    // 的重新截 / 清除 / 微缩预览）与「自定义画面」**不受实时渲染开关影响** —— 那张静帧
    // 正是切换途中与 live 首帧前给用户看的画面，构图不对时必须能立刻重抓。
    assert.ok(JSON.stringify(tree3).includes('出图来源'), '选中场景壁纸后面板应出现「出图来源」行');
    assert.ok(JSON.stringify(tree3).includes('自定义画面'),
      '「自定义画面」行必须可见（live 开着时也要能导入截图）');
    assert.ok(JSON.stringify(tree3).indexOf('出图来源') > JSON.stringify(tree3).indexOf('场景实时渲染'),
      '「出图来源」必须排在「场景实时渲染」开关注下方');
    // ── 实时帧：重新截 + 微缩预览（当前壁纸实时帧） ──
    {
      const gpuText = JSON.stringify(tree3);
      assert.ok(gpuText.includes('"重新截"'), '面板必须给出「重新截」（实时渲染开着时也能重抓当前帧）');
      assert.ok(gpuText.includes('实时帧'), '「实时帧」分组必须存在');
      const shot = (function find(n) {
        if (!n || typeof n !== 'object') return null;
        if (Array.isArray(n)) { for (const c of n) { const r = find(c); if (r) return r; } return null; }
        if (n.type === 'img' && String(n.props && n.props.className).includes('we-picker__frame-shot')) return n;
        if (Array.isArray(n.children)) { for (const c of n.children) { const r = find(c); if (r) return r; } }
        return null;
      })(tree3);
      assert.ok(shot, '槽里有实时帧时必须给出「当前壁纸实时帧」微缩预览');
      assert.ok(String(shot.props.src).indexOf('/scene-frame/ccc') !== -1
        && String(shot.props.src).indexOf('we-prev=') !== -1,
        '预览必须指向层里正在用的那个 scene-frame URL（+ 缓存破坏参数），否则预览与实屏不一致');
      assert.ok(gpuText.includes('2488×1376'),
        '预览旁必须显示实时帧的像素尺寸（宿主 X-WE-GPU-W/H）');
      // 「重新截」在**没有实时渲染**时的行为：给出可读原因，且**不许**动现有缓存。
      const deletesBefore = sceneFrameDeleteCalls.length;
      const recaptureBtn = findBtn(tree3, '重新截');
      assert.ok(recaptureBtn && typeof recaptureBtn.props.onClick === 'function', '「重新截」必须可点');
      recaptureBtn.props.onClick();
      tree3 = renderPicker();
      assert.ok(JSON.stringify(tree3).includes('拿不到实时画面'),
        '没有实时渲染时点「重新截」必须说明原因（而不是静默无事发生）');
      assert.equal(sceneFrameDeleteCalls.length, deletesBefore,
        '没有实时画面时「重新截」不得删除现有缓存（安全顺序：先抓到才清旧）');
      console.log('实时帧：重新截 + 微缩预览: ok');
    }
    assert.equal(animProbeSrcs.length, 0,
      '槽位已有 GPU 帧时不得启动任何 CPU 动画渲染（scene-anim 已删除）');
    // ── 高级页签：省电三档 + 实时渲染诊断（都从「效果」移来） ──
    {
      localStorage.setItem('dsh-wallpaper-engine:picker-tab', 'advanced');
      const adv = JSON.stringify(renderPicker());
      assert.ok(adv.includes('省电') && adv.includes('最小化/切页时暂停')
        && adv.includes('窗口失焦时暂停') && adv.includes('使用电池时暂停'),
        '高级 must host the 省电 group');
      assert.ok(adv.includes('实时渲染诊断'), '高级 must host the live 诊断 group');
      localStorage.setItem('dsh-wallpaper-engine:picker-tab', 'effects');
      const eff = JSON.stringify(renderPicker());
      assert.ok(!eff.includes('最小化/切页时暂停'), '省电 must not stay in 效果');
      assert.ok(!eff.includes('实时渲染诊断'), '实时渲染诊断 must not stay in 效果');
      console.log('省电 / live 诊断已迁到高级（效果里不再有）: ok');
    }
    const clearBtn = findBtn(tree3, '清除 GPU 帧');
    assert.ok(clearBtn, 'HEAD 报 X-WE-GPU=1 时面板必须给出「清除 GPU 帧」入口');
    // ── P2-L：宿主回 200 但 removed:false（unlink 失败）时不得当清除成功 ──
    // 只判 r.ok 会把「假成功」当清除：面板行消失、提示已清除，而宿主照旧发 GPU
    // 帧 —— 画面纹丝不动、档位怎么点都不变、且没有任何反馈。
    cccClearUnlinkFails = true;
    const probesBeforeFail = animProbeSrcs.length;
    clearBtn.props.onClick();
    await new Promise((r) => setTimeout(r, 40));
    tree3 = renderPicker();
    assert.ok(findBtn(tree3, '清除 GPU 帧'),
      'P2-L：宿主回 200 + removed:false 时必须保留清除入口（不得当清除成功）');
    assert.ok(JSON.stringify(tree3).includes('清除失败'),
      'P2-L：清除失败必须给出提示，而不是静默显示成功');
    assert.equal(animProbeSrcs.slice(probesBeforeFail).length, 0,
      'P2-L：没真删掉就不能恢复 CPU 渲染（否则与仍在生效的 GPU 帧叠加）');
    cccClearUnlinkFails = false;
    const clearBtn2 = findBtn(renderPicker(), '清除 GPU 帧');
    assert.ok(clearBtn2, 'P2-L：失败后必须还能重试清除');
    clearBtn2.props.onClick();
    await new Promise((r) => setTimeout(r, 40)); // 等 DELETE + 清除后的 HEAD 判据回来
    assert.ok(sceneFrameDeleteCalls.some((u) => u.includes('/scene-frame-cache/ccc')),
      '点击清除必须 DELETE /scene-frame-cache/<token>');
    tree3 = renderPicker();
    assert.ok(!findBtn(tree3, '清除 GPU 帧'), '清除成功后提示行必须消失');
    // 目标形态：场景动画只保留 WebWallGL live 一条路线，回退链是
    // MP4 → 静态帧 → 单张大图 → 内嵌图；**没有 CPU 动画渲染**（scene-anim / APNG
    // 已删除）。清除 GPU 抓帧后画面回落静态帧链即可，不得再启动分钟级的 CPU 渲染。
    assert.equal(animProbeSrcs.length, 0,
      '清除 GPU 帧后不得启动 CPU scene-anim 渲染（该路线已删除）');
    console.log('GPU 帧提示 + 清除入口链路: ok');
    console.log('GPU 帧优先于静态帧（清除后回落静态帧链，不再有 CPU 渲染）: ok');

    // ── CPU 动画渲染路线已删除：这里改为**钉死删除** ──────────────────────
    // 目标形态：场景动画只保留 WebWallGL live 一条路线，回退链是
    // MP4 → 静态帧 → 单张大图 → 内嵌图；**没有 CPU 动画渲染**（scene-anim / APNG，
    // 分钟级 CPU 渲染且会把 live 抓帧的静帧覆盖掉）。原先这一段逐条断言「点帧率档位
    // 会启动 CPU 重渲染、产物上屏、有 GPU 帧时被门禁挡住」，那些能力连同 /scene-anim
    // 路由一起删了 —— 现在反过来把这些入口钉死，删掉的东西不得悄悄复活。
    for (const [what, needle] of [
      ['queueSceneAnimUpgrade', 'queueSceneAnimUpgrade'],
      ['maybeQueueSceneAnimUpgrade', 'maybeQueueSceneAnimUpgrade'],
      ['cancelSceneAnimUpgrade', 'cancelSceneAnimUpgrade'],
      ['/scene-anim 路由', '/scene-anim/'],
      ['sceneAnimProgress 状态', 'sceneAnimProgress'],
      ['betaSceneAnim 开关', 'betaSceneAnim'],
    ]) {
      assert.ok(!code.includes(needle), 'CPU 动画渲染路线已删除，不得复活：' + what);
    }


    // ⑤ 抓帧回填落地必须校验「发起时那张壁纸」，不得把状态记到当前壁纸头上。
    assert.ok(code.includes('if (String(selection.id || "") !== backfillWid) return;'),
      'GPU 抓帧回填落地必须校验壁纸身份（否则切走后会给新壁纸误标「已有 GPU 帧」）');

    // ⑤b 抓帧回填必须校验存帧**几何**（视口宽高比），不只是「槽位有没有帧」：
    // 抓帧是「抓帧那一刻视口的构图」，别的窗口/旧会话留下的帧拿到当前窗口上屏
    // 会被 CSS object-fit: cover 再裁一次 —— 实测 1440x960 的帧在 2488x1376
    // 视口里只显示设计宽度的 84.5%（对 CPU 帧做最佳匹配拟合），人物比 live 大
    // 约 19% 且四周被切。判据来自宿主的 X-WE-GPU-AR（读 PNG 的 IHDR）。
    assert.ok(code.includes('GPU_FRAME_ASPECT_TOL') && code.includes('"x-we-gpu-ar"'),
      'GPU 抓帧回填必须校验存帧视比（不符 → 清掉按当前视口重抓），行为级见 live-frame-backfill-smoke 的 G/H/I/J');

    // ⑤c 两条渐变链路的时长必须各自与常量同步（独立常量，不合并）：
    // - 轮换/手动切壁纸的过场（.we-layer--switch）= 类型基准 × 速度档；其中
    //   「交叉淡化」的基准直接引用 ROTATION_FADE_MS（1800ms），所以这两者对齐由
    //   SWITCH_TRANSITIONS 保证（下面按源码断言），CSS 只认内联 --we-switch-ms；
    // - GPU 静帧 → live 首帧（.we-live-iframe）= LIVE_FIRST_FADE_MS（1800ms）：
    //   手动切换壁纸时「静帧 → 实时画面」的缓慢过渡正是这条腿。0.8s 短窗口
    //   实测过渡太急，按用户明确要求回到与轮换同口径的 1.8s。
    const liveIframeCss = code.match(/\.we-layer \.we-live-iframe\s*\{[^}]*\}/);
    assert.ok(code.includes('ROTATION_FADE_MS = 1800') && code.includes('LIVE_FIRST_FADE_MS = 1800')
      && liveIframeCss && /transition:\s*opacity 1\.8s ease/.test(liveIframeCss[0]),
      '渐变时长必须与常量同步（live 首帧=LIVE_FIRST_FADE_MS 1.8s），改常量时同步 CSS');
    // 过场：时长由内联 --we-switch-ms 驱动（类型基准 × 速度档），CSS 侧三属性都读它 ——
    // 既保证「改基准只动一处」，也避免再出现「常量改了 CSS 忘改」的漂移。
    const switchCss = code.match(/\.we-layer--switch\s*\{[^}]*\}/);
    assert.ok(switchCss
      && ['transform', 'opacity', 'clip-path'].every((pv) =>
        new RegExp(pv + '\\s+var\\(--we-switch-ms').test(switchCss[0])),
      '过场必须只动 transform / opacity / clip-path，且时长统一取 --we-switch-ms（合成器友好 + 单一真源）');
    assert.ok(/\{ id: "fade", label: "交叉淡化", ms: ROTATION_FADE_MS \}/.test(code),
      '「交叉淡化」的基准必须直接引用 ROTATION_FADE_MS（不写死 1800）');

    // ⑤d 设置键**两端一致**（#106 那类「宿主白名单漏键 → 客户端设置被静默丢弃」的漂移）。
    // 旧实现是"从两边源码文本里抠键名"对账。P1-5 起两侧都改为**派生**（唯一真源
    // lib/settings-schema.js），源码里已无手写键列表可抠，而且抠名字也证明不了
    // "宿主真的会接受"。现在改成 ①键集派生 ②结构上必须委托 ③**行为**与重构前逐键一致。
    {
      const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
      const persistSrc = readFileSync(new URL('../src/persistence.js', import.meta.url), 'utf8');
      const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
      const schemaMod = await import(new URL('../lib/settings-schema.js', import.meta.url).href);
      const { sanitizeFromSchema, serializeSettings, CLIENT_ONLY, DEFAULTS_ONLY, KINDS, DEFAULTS } = schemaMod;

      const persisted = Object.keys(serializeSettings({}));
      const clientSan = Object.keys(sanitizeFromSchema({}, 'client'));
      const hostSan = Object.keys(sanitizeFromSchema({}, 'host'));

      // ① 键集恒等式（全部派生，无手写清单）
      assert.deepEqual(persisted.slice().sort(), clientSan.slice().sort(),
        '持久化白名单必须与客户端 sanitize 键集完全相同');
      assert.deepEqual(hostSan.slice().sort(),
        clientSan.filter((k) => !CLIENT_ONLY.includes(k)).sort(),
        '宿主接受的键集 = 客户端键集 − CLIENT_ONLY');
      for (const k of CLIENT_ONLY) {
        assert.ok(clientSan.includes(k) && !hostSan.includes(k), 'CLIENT_ONLY 必须只存在于客户端：' + k);
      }
      for (const k of DEFAULTS_ONLY) {
        assert.ok(!clientSan.includes(k) && !hostSan.includes(k) && k in DEFAULTS,
          'DEFAULTS_ONLY 必须只在默认值里：' + k);
      }
      assert.ok(clientSan.includes('id') && hostSan.includes('id') && !('id' in DEFAULTS),
        'id 必须在两侧白名单里但不在 DEFAULTS 里（它是选中项，不是设置项）');

      // ② 结构：两侧都必须**委托**给 schema，宿主不得再有手写逐键白名单。
      //    ⚠️ `serializeSelection` 已随持久化层抽到 src/persistence.js（P2-9 后半）⇒ 那一条按
      //    文件归属分源；`sanitizeSettings` 仍在 client.js，不动。
      assert.ok(/sanitizeFromSchema\(o, "client"\)/.test(src), '客户端 sanitizeSettings 必须委托给 schema');
      assert.ok(/serializeSettings\(selection\)/.test(persistSrc),
        '客户端 serializeSelection 必须委托给 schema（现在住在 src/persistence.js）');
      assert.ok(/sanitizeFromSchema\(raw, 'host'\)/.test(host), '宿主 sanitizeSettings 必须委托给 schema');
      const handWritten = (host.match(/clampNum\(o\.|clampStr\(o\./g) || []).length;
      assert.equal(handWritten, 0,
        '宿主不得再手写逐键白名单（发现 ' + handWritten + ' 处）—— 手抄正是漂移的来源');

      // ③ golden：P1-5 之前从**旧实现**采下来的行为快照。夹具体积小、人可读，
      //    任何"顺手改了某个范围/默认值"的改动都会在这里现形；确属有意修改时，
      //    连同夹具一起更新（更新动作本身就是一次评审点）。
      const golden = JSON.parse(readFileSync(
        new URL('../test/fixtures/settings-sanitize-golden.json', import.meta.url), 'utf8'));
      const canon = (o) => JSON.stringify(o && typeof o === 'object' && !Array.isArray(o)
        ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]])) : o);
      const goldenDrift = [];
      for (const c of golden.cases) {
        const want = c.host === '__null__' ? null : c.host;
        if (canon(sanitizeFromSchema(c.input, 'host')) !== canon(want)) goldenDrift.push(c.name);
      }
      assert.deepEqual(goldenDrift, [],
        '宿主设置规范化必须与 P1-5 前的实现逐键一致（漂移用例：' + goldenDrift.join(', ') + '）');

      // ④ 共有键上 client 与 host 必须逐键相同 —— 这就是"两侧不会再漂"的定义。
      //    （历史差异只剩非对象输入：host 返回 null、client 返回默认值，见 schema 头注释。）
      const sharedDrift = [];
      for (const c of golden.cases) {
        if (!c.input || typeof c.input !== 'object') continue;
        const cl = sanitizeFromSchema(c.input, 'client') || {};
        const ho = sanitizeFromSchema(c.input, 'host') || {};
        for (const k of hostSan) {
          if (JSON.stringify(cl[k]) !== JSON.stringify(ho[k])) sharedDrift.push(c.name + ':' + k);
        }
      }
      assert.deepEqual(sharedDrift, [],
        '共有键上 client 与 host 必须给出相同结果（漂移：' + sharedDrift.slice(0, 5).join(', ') + '）');

      // 切换过场三键仍必须三处都在（#106 的当事键，单独钉一次）
      for (const k of ['switchTransition', 'switchTransitionDir', 'switchTransitionSpeed']) {
        assert.ok(persisted.includes(k) && hostSan.includes(k) && KINDS[k],
          '切换过场的设置键必须在 schema + 两侧白名单里：' + k);
      }
      // 方向映射钉死：left = 新画面自右进入（擦除从右侧长出来 / 条带从右端长出）。
      // 这条是纯源码契约 —— 终态看不出方向（起点被 reflow 后的终态覆盖），但方向
      // 反了用户一眼就能看出，所以必须锁住映射本身。
      assert.ok(/if \(dir === "up"\) return "inset\(100% 0 0 0\)";/.test(code)
        && /const fromEnd = dir === "left" \|\| dir === "up";/.test(code)
        && /const inward = fromEnd \? -1 : 1;/.test(code),
        '方向映射必须保持「left = 画面向左移动 / 新画面自右进入」（擦除与条带同语义）');

      // 条带几何（单元级）：DOM 里只能看到终态，而「中段有没有板缝」才是百叶窗的
      // 关键 —— 直接从产物里取出 barsPolygon 在 p=0.5 求值。板缝一旦合并（例如
      // slat 恒等于 period），中段就退化成一块实心矩形，肉眼看与「擦除」无异
      // （用户实测反馈：擦除和条带分不出来）。这里把那个退化钉死。
      {
        const i = code.indexOf('function barsPolygon(');
        assert.ok(i >= 0, 'barsPolygon 必须存在');
        let depth = 0, started = false, srcFn = '';
        for (let j = i; j < code.length; j++) {
          if (code[j] === '{') { depth++; started = true; }
          else if (code[j] === '}') { depth--; if (started && depth === 0) { srcFn = code.slice(i, j + 1); break; } }
        }
        const n = Number((code.match(/const SWITCH_BARS_TEETH = (\d+)/) || [])[1]);
        const fn = new Function('const SWITCH_BARS_TEETH = ' + n + ';\n' + srcFn + '\nreturn barsPolygon;')();
        const xsOf = (poly) => [...new Set([...poly.matchAll(/([\d.]+)% ([\d.]+)%/g)].map((m) => Number(m[1])))];
        const ptsOf = (poly) => [...poly.matchAll(/([\d.]+)% ([\d.]+)%/g)].map((m) => [Number(m[1]), Number(m[2])]);
        for (const p of [0.3, 0.5]) {
          const pts = ptsOf(fn('left', p));
          const depthX = 100 * (1 - p);            // dir=left：板从右侧伸进来 p
          assert.ok(pts.some((q) => Math.abs(q[0] - depthX) < 0.01),
            '条带 p=' + p + ' 必须有「板深」点 x≈' + depthX.toFixed(1) + '（实际 x：' + JSON.stringify(xsOf(fn('left', p))) + '）');
          // 缝里那条「脊」必须是有长度的线段：板厚 slat = p/N < 周期 period 时缝才存在。
          // 板厚一旦等于周期（缝合并），脊上的相邻点 y 相同 → 长度归零 → 中段就是一块
          // 实心矩形，肉眼与「擦除」无异（用户实测反馈的原始问题）。这条把该退化钉死。
          const spineYs = pts.filter((q) => q[0] > 99 && q[0] < 100).map((q) => q[1]);
          // 脊上的点是**成对**发出的（每条缝一对：缝起点 → 缝终点），所以必须成对相减。
          // 跨缝相减会得到「周期」而恒定非零，那样板厚等于周期也测不出来。
          const gapLens = [];
          for (let k = 0; k + 1 < spineYs.length; k += 2) gapLens.push(Math.abs(spineYs[k + 1] - spineYs[k]));
          assert.ok(gapLens.some((g) => g > 0.5),
            '条带 p=' + p + ' 的缝必须有非零长度（缝存在 → 百叶窗而非实心擦除）；缝长：' + JSON.stringify(gapLens.slice(0, 6)));
        }
        // 两端必须退化：p=0 零面积（什么都没露出）、p=1 满屏（块缝闭合）。
        const xs0 = xsOf(fn('left', 0)).map(Number);
        const xs1 = xsOf(fn('left', 1)).map(Number);
        assert.ok(xs0.every((v) => v > 99.9), '条带 p=0 必须零面积（不能一开始就露出板）');
        assert.ok(xs1.some((v) => v < 0.1) && xs1.some((v) => v > 99.9),
          '条带 p=1 必须覆盖满屏（从进入侧一路铺到对侧）');
        console.log('条带几何（板 + 缝 · 两端退化）: ok');
      }
      // 默认 = 硬切（用户裁决：先上零成本零风险，等「最帅的」定了再改这一处）。
      // 断在**被测产物**（code）上，这样 DSH_MUT_LIB 变异也能验到这条有牙。
      assert.ok(/switchTransition: "cut"/.test(code), '默认过场必须是硬切（DEFAULTS.switchTransition）');
      assert.ok(persisted.length > 0 && hostSan.length > 0 && golden.cases.length > 0,
    '设置键两端对账：三份来源都非空（客户端 ' + persisted.length + ' / 宿主 ' + hostSan.length + ' / golden ' + golden.cases.length + '）');
    }

    // ⑥ 行为级不变量：整条流程（选中 → HEAD 探测 → 抓帧回填 → 清除 → 后续重建）
    // 里 animProbeSrcs 必须恒为 0 —— 一帧 CPU 动画渲染都不许启动（回退走静态帧链）。
    // 这条替代了原先「点帧率档位会启动 CPU 重渲染 / 关 beta场景动画按档位回退」的
    // 用例：那些开关与整条 CPU 渲染路线一起删了，留下的不变量是「不再有 CPU 渲染」。
    tree3 = renderPicker();
    assert.equal(animProbeSrcs.length, 0,
      'CPU 动画渲染已删除：全流程不得出现任何 /scene-anim 请求');
    console.log('CPU 动画渲染路线已删除（源码钉死 + 行为级零请求）: ok');

    // ── sceneVideo 诚实化的时序补拉 ────────────────────────────────────────
    // 宿主对 sceneVideo 改为「按 pkg 真探测」：未命中缓存时先给 null（不猜）并把探测
    // 投到后台，而客户端启动时那次 inventory 必然早于定论 ⇒ 必须有一次延迟补拉，
    // 否则真正内嵌 MP4 的场景首屏会掉到静态帧（本机实测 3/35 个场景）。
    {
      const before = inventoryCalls.length;
      const tick = rotationTimers.filter((t) => !t.cleared && t.ms === 3000);
      assert.ok(tick.length >= 1,
        '启动加载完 inventory 后必须安排一次 sceneVideo 时序补拉（3000ms 定时器）');
      for (const t of tick) { t.cleared = true; t.fn(); }
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(inventoryCalls.length, before + 1,
        'sceneVideo 补拉必须真的重拉一次 inventory');
      assert.ok(!rotationTimers.some((t) => !t.cleared && t.ms === 3000),
        'sceneVideo 补拉只做一次：补拉自身不得再排定时器（否则变成轮询）');
      console.log('sceneVideo 时序补拉（一次 · 不自触发）: ok');
    }
  }
  assert.ok(effects.length > 0, '效果链至少要跑过一次（effects 记录 ' + effects.length + ' 条）');
  
// ⑦ P1-7：条件求值器已抽成独立模块（src/we-cond.js），因此可以直接 import 做**行为**测试
// —— 这是抽模块的核心收益（此前只能对 src/client.js 做文本断言）。
// 期望值是 P1-7 **搬移前**从实现里采下来的快照：搬移只允许"行为不动"。
// ⚠️ 已知语义：本求值器把 `===` / `!==` 也走**宽松**比较（实现如此，P1-7 逐字搬移未改）。
//    若将来要改成严格比较，必须同步本表并评估对真实壁纸 condition 的影响。
{
  const { weEvalCondition, weCondTokenize, weCondParse } = await import(
    new URL('../src/we-cond.js', import.meta.url).href);

  const CASES = [
    // [说明, 表达式, values, 期望]
    ['无条件（空串）', '', undefined, true],
    ['空白条件', '   ', undefined, true],
    ['数值相等命中', 'x == 1', { x: 1 }, true],
    ['字符串同值也算相等（宽松）', 'x == 1', { x: '1' }, true],
    ['数值不等', 'x == 1', { x: 2 }, false],
    ['=== 目前也是宽松比较', 'x === 1', { x: '1' }, true],
    ['!= 取反', 'x != 1', { x: 1 }, false],
    ['与运算真', 'a && b', { a: 1, b: 1 }, true],
    ['与运算假', 'a && b', { a: 1, b: 0 }, false],
    ['或运算', 'a || b', { a: 0, b: 1 }, true],
    ['取反', '!a', { a: 0 }, true],
    ['取反带括号', '!(a)', { a: 0 }, true],
    ['浮点大于命中', 'a > 1.5', { a: 2 }, true],
    ['浮点大于不满足', 'a > 1.5', { a: 1 }, false],
    ['大于等于', 'a >= 2', { a: 2 }, true],
    ['字符串字面量比较', 'str == "hi"', { str: 'hi' }, true],
    ['成员访问', 'obj.prop == 1', { obj: { prop: 1 } }, true],
    ['括号组合', '(a == 1) && (b != 2)', { a: 1, b: 3 }, true],
    ['嵌套成员 + 与运算', 'p.mode == 1 && p.on', { p: { mode: 1, on: true } }, true],
    ['枚举字符串比较', 'mode == "auto"', { mode: 'auto' }, true],
    ['三元素（不支持）→ fail open 可见', 'a ? 1 : 0', { a: 1 }, true],
    ['赋值（不支持）→ fail open 可见', 'a = 1', { a: 1 }, true],
    ['垃圾表达式 → fail open 可见', '@@@', {}, true],
    ['values 缺失 → fail open 可见', 'a == 1', undefined, true],
  ];
  const wrong = [];
  for (const [label, expr, values, want] of CASES) {
    let got;
    try { got = weEvalCondition(expr, values); } catch (e) { got = 'THREW:' + e.message; }
    if (got !== want) wrong.push(label + '（期望 ' + want + ' 实得 ' + got + '）');
  }
  assert.deepEqual(wrong, [], '条件求值器行为必须与搬移前一致：' + wrong.join(' / '));

  // 负对照：故意植入一条**错期望**，检测器必须恰好抓到它（证明上面的比较真在比，
  // 而不是恒真）。
  const planted = CASES.concat([['植入的错期望', 'x == 1', { x: 2 }, true]]);
  const plantedWrong = planted.filter(([label, expr, values, want]) => {
    let got;
    try { got = weEvalCondition(expr, values); } catch { got = 'THREW'; }
    return got !== want;
  });
  assert.deepEqual(plantedWrong.map((c) => c[0]), ['植入的错期望'],
    '负对照：植入的那条错期望必须被抓到（且只抓到它）');

  // 编译结果按表达式缓存（拖动滑块时每帧要过数百项）—— 同表达式两次必须是同一函数
  const f1 = weCondParse(weCondTokenize('a == 1'));
  const f2 = weCondParse(weCondTokenize('a == 1'));
  assert.equal(typeof f1, 'function', 'weCondParse 必须返回可调用函数');
  assert.equal(f1({ a: 1 }), true, '编译出的函数必须可直接求值');
  assert.equal(typeof f2, 'function', '重复编译必须同样可用');
  assert.ok(CASES.length >= 20, '条件求值器用例表不得被清空（当前 ' + CASES.length + ' 例）');
}

// ── P2-10 后半：store 写入的单一入口 ─────────────────────────────────────────
// "赋值 + persistSelection()" 这两件事此前被手抄 50+ 次：漏掉 persist 就是"改了不生效/
// 刷新后回退"，而没有任何判据会红。现在收成 `setSetting(field, value)`（写 + 落盘）与
// `setTransient(field, value)`（只写），并断言：
//   · **页签**（src/panel-tabs.js）连 `selection` 都不许提 —— 只能经 ctx 的两个入口；
//   · client.js 里"赋值 + 紧跟 persistSelection()"的手抄形态为 **0**（棘轮只许减少）；
//   · 两个入口本身是唯一的"写 + 落盘"实现处（反查：入口体内必须有 selection[field] = 与
//     persistSelection()，否则判据是空转）。
{
  const tabsSrc2 = readFileSync(new URL('../src/panel-tabs.js', import.meta.url), 'utf8');
  const storeSrc = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
  const tabRefs = (tabsSrc2.match(/(^|[^.\w$])selection\.|persistSelection/g) || []).length;
  assert.equal(tabRefs, 0,
    '页签不得直接读写 selection / persistSelection（必须走 ctx 的 setSetting / setTransient）');
  const pairs = (storeSrc.match(/selection\.[A-Za-z_$][\w$]*\s*=[^=][^\n]*persistSelection\(\);/g) || []).length;
  assert.equal(pairs, 0, 'client.js 里不许再有手抄的"赋值 + persistSelection()"（当前 ' + pairs + ' 处）');
  assert.ok(/function setSetting\(field, value\) \{\s*\n\s*selection\[field\] = value;\s*\n\s*persistSelection\(\);/.test(storeSrc),
    'setSetting 必须是"写 store + 落盘"的唯一实现处');
  assert.ok(/function setTransient\(field, value\) \{\s*\n\s*selection\[field\] = value;/.test(storeSrc),
    'setTransient 必须是"只写 store"的实现处（瞬态字段不落盘）');
  // 负对照：判据对合成文本有牙（手抄形态 / 页签直写都必须被判出）
  assert.ok(/selection\.[A-Za-z_$][\w$]*\s*=[^=][^\n]*persistSelection\(\);/
    .test('selection.x = 1; persistSelection();'), '负对照：手抄形态必须能被判出');
  assert.ok(((('selection.y = 2;').match(/(^|[^.\w$])selection\.|persistSelection/g) || []).length) === 1,
    '负对照：页签直写必须能被判出');
}

// ── P3-11 阶段 2/3：搬出去的渲染器都只经 ctx（不写 selection / 不自发通知）──────
// 两次搬迁的契约同口径：模态框 → `src/picker-modal.js`（那 11 处原本内联改 `selection.*`
// 的箭头都成了 ctx 里的具名回调，动作体留在组件里）；属性面板 → `src/picker-props-panel.js`
// （面板状态与「改一个属性」的动作同样留在组件里，渲染器只拿值 + 回调）。
// 判据只有这一处：数"越过接缝直呼"的次数 —— **按代码判**（先剥注释，否则这些文件的头注
// 自己提到这两个词就会被误伤）。
{
  // 唯一判据。剥注释的口径与 scripts/build-client.mjs 的"浏览器安全"扫描一致
  //（本仓已在同类假阳性上踩过三次）。
  const seamCrossings = (text) => {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    return {
      selection: (code.match(/(^|[^.\w$])selection\b/g) || []).length,
      notify: (code.match(/\bemit\s*\(/g) || []).length,
      readsCtx: /\}\s*=\s*ctx;/.test(code),
    };
  };
  // 每条都带一个**非空转锚点**：那串必须在文件里真的存在，否则"零次越界"只是扫了个空文件。
  const RENDERERS = [
    { file: '../src/picker-modal.js', user: '模态框',
      anchor: ['function renderPickerModal(ctx)', 'we-picker__modal-overlay'] },
    { file: '../src/picker-props-panel.js', user: '属性面板',
      anchor: ['function renderPickerPropsPanel(ctx)', 'we-picker__props-row'] },
  ];
  for (const r of RENDERERS) {
    const src = readFileSync(new URL(r.file, import.meta.url), 'utf8');
    const got = seamCrossings(src);
    assert.ok(r.anchor.every((a) => src.includes(a)),
      r.file + ' 必须真的含有' + r.user + '渲染器（否则下面的零次判据是空转）');
    assert.ok(got.readsCtx, r.user + '渲染器必须从 `ctx` 解构取外界（唯一入参）');
    assert.equal(got.selection, 0, r.user + '渲染器不得直接读写 selection（当前 ' + got.selection + ' 处）');
    assert.equal(got.notify, 0, r.user + '渲染器不得自己发通知（当前 ' + got.notify + ' 处）');
  }
  // 负对照：把**变异输入**喂进同一条判据 —— 两种越界各一例，且正常文本不得被误伤。
  const planted = seamCrossings('const onX = () => { selection.modalView = "normal"; emit(); };');
  assert.equal(planted.selection, 1, '负对照：直写 selection 必须被判出');
  assert.equal(planted.notify, 1, '负对照：自己发通知必须被判出');
  assert.equal(seamCrossings('  // 契约：不写 selection、不自己发通知\n  const a = 1;\n').selection, 0,
    '负对照：注释里提到这两个词不得被误伤（注释先剥掉）');
  assert.equal(seamCrossings('function f(ctx) { const { sel } = ctx; return sel; }').readsCtx, true,
    '正对照：从 ctx 解构的文本必须被认出来');
  assert.equal(seamCrossings('function f() { const { sel } = ctx; return sel; }').readsCtx, true,
    '正对照：解构本身被判据认作"经 ctx 取外界"（判据盯的是解构形态）');
}

// ── 判据纪律：本文件不许有"log 形式的伪判据" ─────────────────────────────────
// `console.log('x (expect 1):', n === 1)` 在日志里**像**断言，实际不判真假 —— 产品改坏了
// 它照样 exit 0（分页器那一整块就是这么漏掉的）。棘轮**已归零**：本文件必须一处都没有；
// `catch` 里的错误上报不是判据，排除在外。
{
  const selfSrc = readFileSync(new URL(import.meta.url), 'utf8');
  // 判据只认**以 `console.log(` 开头的语句**：伪判据都是这种形态，而本段自己的负对照行以
  // `assert.equal(` 开头（它的字符串字面量里正是带着 `console.log(… === …)` 样本）——
  // 不收紧就会被自己的对照绊倒（同 `docs/TEST-LAYOUT.md` §约定 3 那条陷阱）。
  const isFakeJudgement = (line) => {
    const t = line.trim();
    if (!/^console\.log\(/.test(t)) return false;      // 不是 log 语句
    if (/catch|threw|\.message/.test(t)) return false; // 错误上报不是判据
    return /(===|!==|\.includes\(|\.length|\.some\(|\.every\()/.test(t) || /expect|应该|必须|不得/.test(t);
  };
  const fakeJudgements = (src) => src.split('\n')
    .map((line, i) => ({ n: i + 1, line }))
    .filter((x) => isFakeJudgement(x.line));
  const found = fakeJudgements(selfSrc);
  assert.equal(found.length, 0,
    'log 形式的伪判据必须为 0（39 处已清零，不许再出现）：行 ' + found.map((x) => x.n).join(','));
  // 负对照：把**变异输入**喂进同一条判据
  assert.equal(fakeJudgements("  console.log('x (expect 1):', n === 1);").length, 1,
    '负对照：log 形式的伪判据必须能被判出');
  assert.equal(fakeJudgements("  assert.equal(n, 1, 'x');").length, 0,
    '负对照：真断言不得被误伤');
  assert.equal(fakeJudgements("  catch (e) { console.log('threw:', e && e.message); }").length, 0,
    '负对照：catch 里的错误上报不得被当成判据');
}

console.log('\nALL CLIENT CHECKS DONE');
}, 50);
