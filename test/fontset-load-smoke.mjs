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

// `useState` 必须支持**惰性初始化**（`useState(readSavedPickerTab)` 传的是函数）：
// 假 React 直接把它当值返回的话，页签永远是默认的「壁纸」——面板内容就驱动不到。
const React = { Fragment: 'Fragment', useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: v }),
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
  // 定时器登记表 + 面板渲染器：写路径的判据要"重渲一次面板（= 真机里 emit() 做的事）
  // → 点滑块 → 跑 200ms debounce → 看发了什么请求"。
  const timers = [];
  const renderers = [];
  const fireTimers = (ms) => timers.filter((t) => !t.cleared && t.ms === ms).forEach((t) => { t.cleared = true; t.fn(); });
  const stubTimeout = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (h) => { cap.handoff = h; } },
      setTimeout: stubTimeout,
      clearTimeout: (t) => { if (t) t.cleared = true; },
      addEventListener() {}, removeEventListener() {},
      innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1,
    },
    document, localStorage, fetch, React,
    location: { origin: 'http://localhost' },
    setTimeout: stubTimeout,
    clearTimeout: (t) => { if (t) t.cleared = true; },
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'client.js' }).runInContext(sandbox);
  const exportsObj = cap.handoff.factory((spec) => (spec === 'react' ? React : { createPortal: (n) => n }));
  exportsObj.apply({
    // 面板由 `slots.inject(名称, () => slots.register(meta, render))` 装配；产出元素树的是
    // **register 的第二个参数**。`apply()` 期就把首次渲染跑一遍（真机也这样），但那时库存还没到
    // （面板停在「扫描…」）⇒ 把 renderer 留下，**启动完成后重渲一次**（= 真机 emit() 触发的那次）。
    slots: {
      inject: (k, cb) => { try { cb(); } catch { /* 首帧渲染失败不影响后续重渲 */ } },
      register: (meta, render) => { if (typeof render === 'function') renderers.push(render); return null; },
    },
    effect(fn) { fn(); return fn; },
  });
  return {
    requests, store: localStorage._store, timers, fireTimers,
    renderPanel: () => renderers.map((r) => r()),
  };
}

/** 展平渲染树里的宿主节点（假 React 已把函数组件展开）。 */
function collectTree(root, out = []) {
  if (Array.isArray(root)) { root.forEach((n) => collectTree(n, out)); return out; }
  if (!root || typeof root !== 'object') return out;
  if (root.type) out.push(root);
  if (Array.isArray(root.children)) root.children.forEach((n) => collectTree(n, out));
  return out;
}

/** 一个"正常的宿主"：/settings + /fontsets（活动集是 compact）+ /inventory。settings 可参数化。 */
const hostWith = (settings) => (url, init) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(
  String(url).includes('/fontsets/import') ? { ok: true, id: 'imported-1', name: '导入的那份' }
    : url.includes('/fontsets/') ? { ok: true, id: 'compact', name: '紧凑', values: HOST_VALUES }
      : url.includes('/fontsets') ? { fontsets: [{ id: 'compact', name: '紧凑', origin: 'builtin', active: true }], active: 'compact', migrated: false, adopted: false }
        : url.includes('/settings') ? { ok: true, betterSidebar: false, settings }
          : { installDir: 'D:/we', total: 1, portableCount: 1, playlists: [], wallpapers: [
            { id: 'v', title: 'V', type: 'video', playable: true, media: '/wallpaper-engine/media/vvv', preview: null, contentrating: 'Everyone' },
          ] }) });
const goodHost = hostWith({ id: 'v', blur: 7 });

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

  // ── 场景 D：写路径（阶段 2 记下的差额，在这里补上）────────────────────────────
  // 面板的初始页签取自 localStorage（`PICKER_TAB_KEY`）⇒ 挂载台可以**直接渲染「外观」页签**，
  // 于是"点一下字号滑块 ⇒ 写活动集、不写 /settings"第一次成为**行为**判据。
  console.log('D. 写路径：改字号 ⇒ PUT 到活动集，且完全不碰 /settings');
  const dStore = {
    'dsh-wallpaper-engine:selection': JSON.stringify({ id: 'v', fontCustom: true }),
    'dsh-wallpaper-engine:picker-tab': 'appearance',
  };
  const d = mount({ fetchImpl: hostWith({ id: 'v', fontCustom: true }), store: dStore });
  await waitBoot();
  // 启动完成后再渲一次面板（= 真机里 emit() 触发的那次重渲）：此时库存与设置都已到位。
  const sizeInputs = d.renderPanel()
    .flatMap((tree) => collectTree(tree))
    .filter((n) => n.type === 'input' && /字号 px/.test(String((n.props || {}).title || '')));
  check('「外观」页签里找得到排版角色的字号输入（写路径的前置：UI 可达）',
    sizeInputs.length > 0, sizeInputs.length + ' 个字号输入');
  // 先把**启动期**挂起的写放掉（真机里 200ms 后自然落的那次）：否则它会被下面这次
  // `fireTimers(200)` 一起释放，混进"改字号之后发了什么"的窗口里（判据就说不清了）。
  d.fireTimers(200);
  await new Promise((r) => setTimeout(r, 10));
  const before = d.requests.length;
  if (sizeInputs.length) sizeInputs[0].props.onChange({ target: { value: '26' } });
  d.fireTimers(200); // 200ms debounce 到点 ⇒ flushFontSet ⇒ PUT
  await new Promise((r) => setTimeout(r, 10));
  const written = d.requests.slice(before);  const fontPuts = written.filter((r) => r.method === 'PUT' && r.url.includes('/fontsets/'));
  const settingsPuts = written.filter((r) => r.method === 'PUT' && r.url.includes('/settings'));
  check('改字号 ⇒ PUT 落到**活动集**（/fontsets/compact）',
    fontPuts.length === 1 && fontPuts[0].url.endsWith('/fontsets/compact'),
    fontPuts.map((r) => r.url.replace('http://localhost', '')).join(' | ') || '(没有 PUT)');
  check('该 PUT 的体里带着刚改的值（markdown-h1 = 26）',
    fontPuts.length === 1 && /"markdown-h1":26/.test(String(fontPuts[0].body || '')),
    String(fontPuts[0] && fontPuts[0].body).slice(0, 96));
  check('同期**完全没有**写 /settings（字体值不走那条通道）',
    settingsPuts.length === 0, settingsPuts.map((r) => r.url).join(' | ') || '零次');

  // ── 场景 E：导入（阶段 4）—— 往返 + 三种失败态都要"说得出为什么" ───────────────
  // 驱动器是**真面板**：先点开「字体集预设」子分支（fire 那个 checkbox 的 onChange），
  // 再把文件喂给隐藏的 .json input —— 与用户操作是同一串。
  /** 点开「字体集预设」子分支：面板里那个 checkbox 的 aria-label 就是行标签。 */
  const openFontSetEditor = (d) => {
    const box = d.renderPanel().flatMap((t) => collectTree(t))
      .find((n) => n.type === 'input' && n.props && n.props['aria-label'] === '字体集预设');
    if (box) box.props.onChange({ target: { checked: true } });
    return Boolean(box);
  };
  /** 面板整棵树的文案（失败态就长在这里）。 */
  const panelText = (d) => d.renderPanel().flatMap((t) => collectTree(t))
    .map((n) => (Array.isArray(n.children) ? n.children.filter((c) => typeof c === 'string').join('') : '')).join(' | ');
  console.log('E. 导入：导出字节 ⇒ 读回同一份；三种坏文件各自给可判定文案');
  const eStore = {
    'dsh-wallpaper-engine:selection': JSON.stringify({ id: 'v', fontCustom: true }),
    'dsh-wallpaper-engine:picker-tab': 'appearance',
  };
  const e = mount({ fetchImpl: hostWith({ id: 'v', fontCustom: true }), store: eStore });
  await waitBoot();
  /** 编辑器（含导入 input）在不在树上；顺带把整棵树的文案拼出来看失败态。 */
  const editorTree = () => {
    const all = e.renderPanel().flatMap((t) => collectTree(t));
    return {
      all,
      text: panelText(e),
      fileInput: all.find((n) => n.type === 'input' && String((n.props || {}).accept || '').includes('.json')),
    };
  };
  check('「字体集预设」开关可驱动（面板上真的有这个 checkbox）', openFontSetEditor(e));
  await new Promise((r) => setTimeout(r, 20)); // 打开会拉一次清单
  const opened = editorTree();
  check('点开后编辑器与导入入口都出现', Boolean(opened.fileInput) && opened.text.includes('导入字体集…'));

  const EXPORTED = JSON.stringify({
    $schema: 'dsh-we/fontset@1', id: 'compact', name: '紧凑', values: HOST_VALUES,
  }, null, 2) + '\n';
  /** 喂一个文件给导入入口；返回这一轮的请求增量与之后的文案。 */
  const feed = async (file) => {
    const at = e.requests.length;
    const input = editorTree().fileInput;
    if (input) input.props.onChange({ target: { files: [file], value: 'x.json' } });
    await new Promise((r) => setTimeout(r, 20));
    return { posted: e.requests.slice(at), text: editorTree().text };
  };

  const good = await feed({ name: 'compact.json', text: () => Promise.resolve(EXPORTED) });
  const importPosts = good.posted.filter((r) => r.method === 'POST' && r.url.includes('/fontsets/import'));
  check('导入成功 ⇒ POST 到 /fontsets/import，且体就是**导出的那份字节**（客户端这一半的往返闭合）',
    importPosts.length === 1 && importPosts[0].body === EXPORTED,
    importPosts.length ? ('body 长度 ' + String(importPosts[0].body).length) : '(没有 POST)');
  check('往返：宿主收到的体解析回来与导出前逐键相同（不比对时间戳这类不稳定字段）',
    importPosts.length === 1
    && JSON.stringify(JSON.parse(String(importPosts[0].body)).values) === JSON.stringify(HOST_VALUES));
  check('导入成功后清单被回读一次（新那一行就是反馈）',
    good.posted.some((r) => r.method === 'GET' && r.url.endsWith('/fontsets'))
    && !good.text.includes('字体集不可用'));

  const noRead = await feed({ name: 'x.json', text: () => Promise.reject(new Error('boom')) });
  check('文件读不出来 ⇒ 文案点明"读不出这个文件"，且**不发请求**',
    noRead.posted.length === 0 && noRead.text.includes('读不出这个文件'), noRead.text.slice(0, 60));
  const badJson = await feed({ name: 'x.json', text: () => Promise.resolve('这不是 JSON') });
  check('不是 JSON ⇒ 文案点明，且不发请求',
    badJson.posted.length === 0 && badJson.text.includes('这不是 JSON 文件'));
  const badTag = await feed({ name: 'x.json', text: () => Promise.resolve('{"$schema":"dsh-we/fontset@99","values":{}}') });
  check('版本不符 ⇒ 文案点明**要哪个标记**，且不发请求（笼统的"导入失败"等于什么都没说）',
    badTag.posted.length === 0 && badTag.text.includes('这不是字体集文件')
    && badTag.text.includes('dsh-we/fontset@1'), badTag.text.slice(0, 80));

  // ── 场景 F：新建（面板不再问名字，名字由客户端生成）──────────────────────────
  console.log('F. 新建：不问名字，客户端生成并立刻切过去');
  {
    const at = e.requests.length;
    const createBtn = editorTree().all.find((n) => n.type === 'button'
      && Array.isArray(n.children) && n.children.join('') === '新建（以当前外观）');
    check('「新建（以当前外观）」按钮在（面板上点得到）', Boolean(createBtn));
    if (createBtn) createBtn.props.onClick();
    await new Promise((r) => setTimeout(r, 30));
    const round = e.requests.slice(at);
    const created = round.filter((r) => r.method === 'PUT' && /\/fontsets\/set-/.test(r.url));
    check('新建 ⇒ PUT 一份新 id 的集，且名字是客户端生成的（面板没问过）',
      created.length === 1 && /"name":"我的字体集/.test(String(created[0].body)),
      created.length ? String(created[0].url).split('/').pop() + ' body 名字=' + (/"name":"([^"]*)"/.exec(String(created[0].body)) || [])[1] : '(没有 PUT)');
    const newId = created.length ? String(created[0].url).split('/').pop() : '';
    check('建完立刻切过去（activate 指向那个新 id）—— 用户的下一步一定是调它',
      Boolean(newId) && round.some((r) => r.method === 'POST' && r.url.endsWith('/fontsets/' + newId + '/activate')),
      'id=' + newId);
  }

  // ── 场景 G：宿主没重挂（真机实测的形态）───────────────────────────────────────
  // 真机形态：页面刷新后**前端是新的、宿主还是旧的**（宿主模块只在启动时 load 一次，
  // bundle 却每次刷新重取）⇒ 请求落到 SPA 兜底：GET 裸 404、非 GET 裸 405，都没有 `{ error }` 信封。
  // 这一段把"文案必须自己说出来"钉住，并且用**成对**的宿主证明判据不是恒真。
  console.log('G. 宿主没有这条路由（裸 404）⇒ 文案自己说出去重启 DSH');
  {
    // 只有字体集那条路 404（别的一律正常，否则面板停在"未检测到 Wallpaper Engine"，
    // 根本走不到外观页签 —— 那测的就不是本段要测的东西了）。
    const bareFontsets = (body) => (url, init) => (String(url).includes('/fontsets')
      ? Promise.resolve({ ok: false, status: 404, json: body })
      : hostWith({ id: 'v' })(url, init));
    const staleHost = bareFontsets(() => Promise.reject(new Error('empty body')));
    const g = mount({ fetchImpl: staleHost, store: {
      'dsh-wallpaper-engine:selection': JSON.stringify({ id: 'v' }),
      'dsh-wallpaper-engine:picker-tab': 'appearance',
    } });
    await waitBoot();
    openFontSetEditor(g);
    await new Promise((r) => setTimeout(r, 20));
    const staleText = panelText(g);
    check('裸 404（无 { error } 信封）⇒ 文案说"宿主里没有字体集路由：重启 DSH 后再试"',
      staleText.includes('重启 DSH 后再试') && staleText.includes('重启 DSH'), staleText.slice(0, 70));

    // 配对项：同一个 404，但**带信封**（= 请求确实到了本族）⇒ 原话照搬，不许混进"宿主没重挂"的猜测。
    const enveloppedHost = bareFontsets(() => Promise.resolve({ error: 'not found' }));
    const h = mount({ fetchImpl: enveloppedHost, store: {
      'dsh-wallpaper-engine:selection': JSON.stringify({ id: 'v' }),
      'dsh-wallpaper-engine:picker-tab': 'appearance',
    } });
    await waitBoot();
    openFontSetEditor(h);
    await new Promise((r) => setTimeout(r, 20));
    const envText = panelText(h);
    check('成对项：带 `{ error }` 的 404 ⇒ 原话照搬（"not found"），**不**出现"重启 DSH"那句',
      envText.includes('not found') && !envText.includes('重启 DSH 后再试'), envText.slice(0, 70));
  }

  console.log('');
  if (failures) { console.log('FONTSET LOAD SMOKE FAILED — ' + failures + ' failed'); process.exit(1); }
  console.log('FONTSET LOAD SMOKE PASSED');
})();
