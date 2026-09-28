// fontset-load-smoke.mjs — F3 阶段 2：客户端**从活动字体集载入**这条通道的节点级冒烟。
//
// 为什么值得单独一条：`src/fontset-store.js` 是"字体值到底存哪"的另一半答案，而它的失败形态
// 与设置不同 —— 设置丢一次只是回退，字体集读不出来必须**整套不采用**（半套用会让外观说不清）。
// 本冒烟把可观察的三件事钉住：
//   ① 启动链真的按 **settings → 字体集（list → 活动那份）→ 库存** 的顺序取数；
//   ② 宿主那份值被**整套**采用（证据 = 本地缓存 `we-fontset-active` 与宿主逐键相同 ——
//      缓存与 `Object.assign(selection, values)` 在同一个分支里写，缓存对 = 采用过）；
//   ③ 宿主读不出来时**不写回、不编造**：本地缓存保持原样（先前的值），不会退化成默认值。
//
// 判据的边界（如实记下，不假装）：**"失败时 selection 逐字段未被改动"没有在本冒烟里直接观察到**
// —— selection 是 bundle 内部状态，本挂载台只暴露 apply/inject。可观察的是它上面的不变量
// （缓存不被覆盖、没有发起任何写），以及源码里那条"要么整套 Object.assign、要么什么都不动"的分支。
// 「点滑块 → PUT 到活动集」的写路径要等阶段 3 的面板（那时才有可驱动的 UI），届时在同一挂载台上补。
//
// Usage: node test/fontset-load-smoke.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label + (detail ? ' — ' + detail : ''));
  else { failures++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
};

const React = { Fragment: 'Fragment', useState: (i) => [i, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }),
  createElement: (t, p, ...c) => (typeof t === 'function' ? t(p || {}) : { type: t, props: p || null, children: c }) };

/** 宿主那份活动集（六个键齐全 —— 宿主永远给全）。 */
const HOST_VALUES = {
  themeColors: { primary: { light: '#112233', dark: '#aabbcc' } },
  themeDarkSeparate: true,
  themeSize: { 'markdown-h1': 24 },
  themeWeight: { 'markdown-h1': 900 },
  themeFamily: { 'markdown-h1': 'SimSun' },
  componentFonts: { markdown: { size: 15 } },
};
/** 本地缓存里"上次那份"（与宿主那份**明显不同**，才能分辨谁赢了）。 */
const CACHED_VALUES = {
  themeColors: {}, themeDarkSeparate: false, themeSize: { 'markdown-h1': 19 },
  themeWeight: {}, themeFamily: {}, componentFonts: {},
};
const CACHE_KEY = 'we-fontset-active';

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {},
    style: { _props: {}, cssText: '', setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } },
    className: '', textContent: '',
    appendChild(c) { this.children.push(c); c._parent = this; return c; },
    remove() { if (this._parent) { const i = this._parent.children.indexOf(this); if (i >= 0) this._parent.children.splice(i, 1); } },
    setAttribute(k, v) { this.attributes[k] = v; },
    removeAttribute(k) { delete this.attributes[k]; },
    getAttribute(k) { return this.attributes[k] ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    get isConnected() { return true; },
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { const l = listeners[ev]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    __fire(ev) { (listeners[ev] || []).slice().forEach((f) => f()); },
    play() { return Promise.resolve(); }, pause() {}, load() {},
  };
  el.classList = { add() {}, remove() {} };
  return el;
}

/**
 * 挂一个客户端实例。
 * @param fetchImpl (url, init) => Promise<Response 形态>
 * @param store     跨挂载共享的 localStorage 后备（第二个场景要看得见第一个写下的缓存）
 */
function mount({ fetchImpl, store }) {
  const bodyEl = makeEl('body');
  const document = {
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: () => null,
    head: { appendChild: () => {} },
    body: bodyEl,
    hidden: false,
    hasFocus: () => true,
    addEventListener() {},
    removeEventListener() {},
    documentElement: makeEl('html'),
  };
  const localStorage = {
    _store: store,
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = v; },
    removeItem(k) { delete this._store[k]; },
  };
  const requests = [];
  const fetch = (url, init) => {
    const o = init || {};
    requests.push({ method: (o.method || 'GET').toUpperCase(), url: String(url), body: o.body || null });
    return fetchImpl(String(url), o);
  };
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const cap = { handoff: null };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { cap.handoff = h; } },
      setTimeout: (fn, ms) => ({ fn, ms, cleared: false }),
      clearTimeout: () => {},
      addEventListener() {}, removeEventListener() {},
      innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    },
    document, localStorage, fetch, React,
    location: { origin: 'http://localhost' },
    setTimeout: (fn, ms) => ({ fn, ms, cleared: false }),
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);
  const exportsObj = cap.handoff.factory((spec) => (spec === 'react' ? React : { createPortal: (n) => n }));
  exportsObj.apply({ slots: { inject: (k, cb) => cb(), register: () => {} }, effect(fn) { fn(); return fn; } });
  return { requests, store: localStorage._store };
}

/** 一个"正常的宿主"：/settings + /fontsets（活动集是 compact）+ /inventory。 */
const goodHost = (url) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
  url.includes('/fontsets/') ? { ok: true, id: 'compact', name: '紧凑', values: HOST_VALUES }
    : url.includes('/fontsets') ? { fontsets: [{ id: 'compact', name: '紧凑', origin: 'builtin', active: true }], active: 'compact', migrated: false, adopted: false }
      : url.includes('/settings') ? { ok: true, betterSidebar: false, settings: { id: 'v', blur: 7 } }
        : { installDir: 'D:/we', total: 1, portableCount: 1, playlists: [], wallpapers: [
          { id: 'v', title: 'V', type: 'video', playable: true, media: '/wallpaper-engine/media/vvv', preview: null, contentrating: 'Everyone' },
        ] }) });

/** 一个"字体集**本体**读不出来"的宿主：清单正常（活动集是 compact），那一份是 422。 */
const brokenFontSetHost = (url) => Promise.resolve(
  url.includes('/fontsets/')
    ? { ok: false, status: 422, json: () => Promise.resolve({ error: 'fontset file is unreadable', reason: 'bad-version' }) }
    : goodHost(url));

/** 一个"字体集清单都拿不到"的宿主（整条通道不可用）。 */
const noFontSetHost = (url) => Promise.resolve(
  url.includes('/fontsets')
    ? { ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) }
    : goodHost(url));

const waitBoot = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  // ── 场景 A：正常宿主 —— 值被整套采用，顺序正确 ──────────────────────────────
  console.log('A. 正常宿主：settings → 字体集(list → 活动那份) → 库存');
  const shared = {}; // 跨场景共享的 localStorage（第二个场景要看得见第一个写下的缓存）
  const a = mount({ fetchImpl: goodHost, store: shared });
  await waitBoot();
  const order = a.requests.map((r) => r.method + ' ' + r.url.replace('http://localhost', ''));
  const iSettings = order.findIndex((x) => x.includes('/settings'));
  const iList = order.findIndex((x) => x.endsWith('/wallpaper-engine/fontsets'));
  const iOne = order.findIndex((x) => x.includes('/fontsets/compact'));
  const iInv = order.findIndex((x) => x.includes('/inventory'));
  check('启动链取了 /fontsets 与活动那份', iList >= 0 && iOne >= 0, order.join(' | '));
  check('顺序 = settings → 字体集清单 → 活动那份 → 库存',
    iSettings >= 0 && iSettings < iList && iList < iOne && iOne < iInv, 'idx=' + [iSettings, iList, iOne, iInv].join(','));
  const cacheA = JSON.parse(shared[CACHE_KEY] || 'null');
  check('宿主那份被整套采用（本地缓存 = 活动 id + 六个键，与宿主逐键相同）',
    cacheA && cacheA.id === 'compact'
    && JSON.stringify(Object.keys(cacheA.values).sort()) === JSON.stringify(Object.keys(HOST_VALUES).sort())
    && JSON.stringify(cacheA.values) === JSON.stringify(HOST_VALUES),
    JSON.stringify(cacheA && { id: cacheA.id, size: cacheA.values && cacheA.values.themeSize }));
  check('启动期不发生任何字体集写入（载入 ≠ 落盘）',
    a.requests.every((r) => !(r.method === 'PUT' && r.url.includes('/fontsets'))), order.filter((x) => x.startsWith('PUT')).join(' | '));
  check('启动期的 PUT /settings 体里没有字体键（那六个键已不走这条通道）',
    a.requests.filter((r) => r.method === 'PUT' && r.url.includes('/settings'))
      .every((r) => !/themeColors|themeSize|themeWeight|themeFamily|componentFonts|themeDarkSeparate/.test(String(r.body || ''))),
    a.requests.filter((r) => r.method === 'PUT').map((r) => r.url).join(' | ') || '(无 PUT)');

  // ── 场景 B：宿主读不出来 —— 不写回、不编造（缓存保持上次那份）────────────────
  console.log('B. 字体集读不出来：保留上次那份，不写回、不编造');
  const b = mount({ fetchImpl: brokenFontSetHost, store: shared });
  await waitBoot();
  const cacheB = JSON.parse(shared[CACHE_KEY] || 'null');
  check('读失败后本地缓存**仍是上次那份**（没有被清成默认值）',
    cacheB && cacheB.id === 'compact' && JSON.stringify(cacheB.values) === JSON.stringify(HOST_VALUES),
    JSON.stringify(cacheB && cacheB.id));
  check('读失败也不发起任何字体集写入（不拿默认值去覆盖宿主）',
    b.requests.every((r) => !(r.method === 'PUT' && r.url.includes('/fontsets'))));
  check('失败是"取过、被拒"而不是"没取"（请求记录里看得到那次 422）',
    b.requests.some((r) => r.url.includes('/fontsets/compact')), b.requests.map((r) => r.url.replace('http://localhost', '')).join(' | '));

  // ── 场景 C：全新安装 + 整条通道不可用 —— 不凭空造一份缓存 ────────────────────
  //    ⚠️ 这里刻意带上**设置缓存**（= 升级后的真实状态：localStorage 里有设置、但没有字体集缓存）。
  //    那正是"点『字体自定义』白屏"复现所需的条件：`readPersisted()` 走消毒分支 ⇒ 不再提供那六个
  //    字体键，而字体集又读不出来 ⇒ 靠 selection 初始化里的兜底顶着。挂载不抛 = 兜底在位。
  console.log('C. 有设置缓存 + 没有字体集缓存 + 清单都拿不到：挂载不抛、不凭空造缓存');
  const fresh = {
    'dsh-wallpaper-engine:selection': JSON.stringify({ id: 'v', fontCustom: true, blur: 9 }),
  };
  let mountThrew = '';
  try { mount({ fetchImpl: noFontSetHost, store: fresh }); } catch (e) { mountThrew = String((e && e.message) || e); }
  await waitBoot();
  check('没有缓存时不写出任何缓存（也就不会把"默认值"伪装成用户的那份）',
    fresh[CACHE_KEY] === undefined, String(fresh[CACHE_KEY]));
  check('挂载/启动不抛（六个键的兜底在位 ⇒ 面板与令牌层的取值路径拿到的都是对象）',
    mountThrew === '', mountThrew || 'fontCustom=true + 无字体集缓存 + 宿主读不出来');

  console.log('');
  if (failures) { console.log('FONTSET LOAD SMOKE FAILED — ' + failures + ' failed'); process.exit(1); }
  console.log('FONTSET LOAD SMOKE PASSED');
})();
