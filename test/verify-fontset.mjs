#!/usr/bin/env node
/**
 * verify-fontset.mjs — F3「字体集文件化」的守卫（阶段 0 的前置网 + 阶段 1 的宿主侧判据）。
 *
 * 覆盖三件容易"看起来对、实际什么都没发生"的事：
 *   ① **键集（承重）**：六个字体键当前在 `KINDS` 里；共享内核的 `FONTSET_KEYS` 与本文件列出的
 *      键集逐字一致（单一真源，不是两份清单）。D1 把它们移出 `KINDS` 时本判据会变红
 *      ⇒ 那次改动不可能静默发生（键集变更必须与之一同改写本文件）。
 *   ② **往返**：真 `PUT /settings` → `config.json` → 读回，逐键相等。
 *   ③ **一次性迁移 + 迁移前外观 golden**：老 `config.json`（六个键内联、无 `fontSetId`）
 *      经惰性迁移后，文件里的值必须**逐键不变**、且由它算出的外观与录下的 golden
 *      **逐锚点相同**；再叠**路径安全**的逐条负对照与"合法 id 必须成功"的配对项。
 *
 * 需要的外界：无 —— mock `webServer` + 真实 `apply(ctx)`；数据目录经 `DSH_WE_DATA_DIR`
 *   等变量整体挪进工作区（与 verify-scene-live.mjs 同一套隔离约定），不碰用户真目录。
 *   ⚠️ 正因为宿主半有些守卫**没有**隔离 `DSH_WE_DATA_DIR`（`verify-scene.mjs` 就是），
 *   迁移必须是**惰性**的 —— 本文件断言 `apply()` 本身一个字节都不写。
 * 对外提供：无（可执行守卫）。
 *
 * 不变量（本文件断言的对象）：
 *   · **持久化白名单 = `KINDS` 的键集**：不在其中的键在客户端序列化与宿主消毒两侧都被丢弃，
 *     不报错、不进日志（`fontSetId` 是 config.json 的根字段，故意不在键集里）。
 *   · 六个字体键经 `PUT /settings` 往返后**逐键取值不变**。
 *   · 负载构建是「值 → 载荷」的纯函数：同一份配置必须给出逐字相同、锚点路径相同的载荷。
 *   · 字体集 id 只认单段白名单；任何非法 id 的请求在读/写之前就被拒，目录内容不变。
 *
 * Usage:  node test/verify-fontset.mjs [--record]
 *   `--record` 只打印 ② 的当前取值（供 golden 更新），不判定、不按失败退出。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = process.argv.includes('--record');

// ── 隔离：设置 / 缓存 / 上传 / 素材根全部挪进工作区 ─────────────────────────
// 必须在 import lib/index.js **之前**设好：那两处路径在模块加载期解析一次。
const ISO = join(root, '.test-cache', 'fontset');
const DATA_DIR = join(ISO, 'data');
const FONTSETS_DIR = join(DATA_DIR, 'fontsets');
const ISO_HOME = join(ISO, 'home');
mkdirSync(ISO_HOME, { recursive: true });
mkdirSync(join(ISO, 'steam'), { recursive: true });
process.env.DSH_WE_DATA_DIR = DATA_DIR;
process.env.DSH_WE_CACHE_DIR = join(ISO, 'cache');
process.env.DSH_WE_UPLOAD_DIR = join(ISO, 'uploads');
process.env.DSH_WE_STEAM_ROOT = join(ISO, 'steam');
// POSIX 读 $HOME、Windows 读 %USERPROFILE%，两个都覆盖。
process.env.HOME = ISO_HOME;
process.env.USERPROFILE = ISO_HOME;

// ── 字体键集（承重判据的一部分：键集变更必须改这里）────────────────────────
/** 六个持久化字体键。D1 若把它们移出 `KINDS`，① 与 ④ 会一起变红。 */
const FONT_KEYS = ['themeColors', 'themeDarkSeparate', 'themeSize', 'themeWeight', 'themeFamily', 'componentFonts'];

/** 往返用的取值：每一项都**非默认**，否则"丢掉了"与"存的是默认值"分不开。 */
const FONT_VALUES = {
  themeColors: {
    primary: { light: '#112233', dark: '#aabbcc' },
    dimmed: { light: '#010203', dark: '#040506' },
  },
  themeDarkSeparate: true,
  themeSize: { 'markdown-h1': 24, 'markdown-small': 11 },
  themeWeight: { 'markdown-h1': 700, 'markdown-table-head': 600 },
  themeFamily: { 'markdown-h1': 'SimSun', 'markdown-base': 'monospace' },
  componentFonts: { markdown: { size: 15, weight: 600 }, table: { family: 'Georgia' } },
};

/** 规范 JSON（对象键排序）—— 值比较不能依赖键的书写顺序。 */
const canon = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.fromEntries(Object.keys(val).sort().map((x) => [x, val[x]]))
  : val));

// ── 外观夹具与展开（纯计算，不需要宿主）────────────────────────────────────
const colorRoles = await import(pathToFileURL(join(root, 'src', 'font', 'color-roles.js')).href);
const typo = await import(pathToFileURL(join(root, 'src', 'font', 'typography.js')).href);
const comps = await import(pathToFileURL(join(root, 'src', 'font', 'components.js')).href);

const COLOR_IN = {
  primary: { light: '#112233', dark: '#aabbcc' },
  secondary: { light: '#223344', dark: '#bbccdd' },
  tertiary: { light: '#334455', dark: '#ccddee' },
  caption: { light: '#445566', dark: '#ddeeff' },
  dimmed: { light: '#556677', dark: '#eeff00' },
};
const TYPE_SIZES = { 'markdown-h1': 24, 'markdown-base': 16, 'markdown-code': 13 };
const TYPE_WEIGHTS = { 'markdown-h1': 800, 'markdown-base': 400 };
const TYPE_FAMILIES = { 'markdown-h1': 'SimSun', 'markdown-base': 'monospace' };
const COMPONENT_IN = {
  markdown: { size: 15, weight: 600 },
  table: { family: 'Georgia, serif' },
  codeBlock: { size: 13 },
  terminal: { family: 'Menlo, monospace' },
};
const AVAILABLE = ['markdown', 'table', 'codeBlock', 'terminal'];
/** 钩子定义点：形态照 `scanHookScopes` 的产出（单类选择器）。 */
const HOOK_SCOPES = {
  '--dsl-code-block-content-font': '._block_aaaaaa_1',
  '--dsl-code-block-banner-font': '._block_aaaaaa_2',
  '--dsl-terminal-font': '._block_bbbbbb_3',
};
/** 族键 → CSS 栈（真机上由客户端解析；这里固定一份，让载荷可复现）。 */
const FAMILY_STACKS = {
  SimSun: '"SimSun", serif',
  monospace: 'Menlo, Consolas, monospace',
};
const resolveFamily = (key) => FAMILY_STACKS[key] || '';

/**
 * 老 `config.json` 的形状：六个字体键内联在 settings 里、没有 `fontSetId`。
 * 取值**就是** ② 的夹具 ⇒ 迁移等价可以直接拿 ② 的 golden 当判据，不必再录一份。
 */
const LEGACY_SETTINGS = {
  themeColors: COLOR_IN,
  themeDarkSeparate: true,
  themeSize: TYPE_SIZES,
  themeWeight: TYPE_WEIGHTS,
  themeFamily: TYPE_FAMILIES,
  componentFonts: COMPONENT_IN,
};

/** 四个纯计算的载荷（② 的被测对象）。 */
function buildAppearance(over = {}) {
  const colors = colorRoles.buildTokenPayload(over.colors || COLOR_IN, () => true);
  const types = typo.buildTypePayload(over.sizes || TYPE_SIZES, () => true,
    over.weights || TYPE_WEIGHTS, over.families || TYPE_FAMILIES, resolveFamily);
  const componentCfg = over.components || COMPONENT_IN;
  return {
    'colors.roles': colors.roles,
    'colors.tokens': colors.payload,
    'type.roles': types.roles,
    'type.tokens': types.payload,
    'components.css': comps.buildComponentCss(componentCfg, AVAILABLE),
    'components.dslHooks': comps.buildDslBlocks(componentCfg, AVAILABLE, () => true, HOOK_SCOPES),
  };
}

/** 字体集正文（6 个键）→ 外观夹具。迁移等价用它把"文件里的值"接回 ② 的 golden。 */
function appearanceInputs(values) {
  const v = values || {};
  return {
    colors: v.themeColors, sizes: v.themeSize, weights: v.themeWeight,
    families: v.themeFamily, components: v.componentFonts,
  };
}

/**
 * 把载荷展开成**绝对锚点**的稳定序列：对象键排序（与插入顺序无关），叶子行形如
 * `colors.tokens.--dsw-alias-label-primary.light = "#112233"`。
 * 锚点路径本身就是判据的一部分 —— 结构下移一层（值不变、路径变深）必须被判出。
 */
function flatten(node, path = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => flatten(v, path + '[' + i + ']', out));
    return out;
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node).sort();
    if (!keys.length) { out.push(path + ' = {}'); return out; }
    for (const k of keys) flatten(node[k], path + (path ? '.' : '') + k, out);
    return out;
  }
  out.push(path + ' = ' + JSON.stringify(node));
  return out;
}

/** 逐行比对（含长度差）；空数组 = 逐锚点一致。 */
function diffLines(now, want) {
  const out = [];
  const n = Math.max(now.length, want.length);
  for (let i = 0; i < n; i++) {
    if (now[i] !== want[i]) out.push('#' + i + ' 现在=' + now[i] + ' golden=' + want[i]);
  }
  return out;
}

const GOLDEN_LINES = [
  "colors.roles[0] = \"primary\"",
  "colors.roles[1] = \"secondary\"",
  "colors.roles[2] = \"tertiary\"",
  "colors.roles[3] = \"caption\"",
  "colors.roles[4] = \"dimmed\"",
  "colors.tokens.--dsw-alias-label-caption.dark = \"#ddeeff\"",
  "colors.tokens.--dsw-alias-label-caption.light = \"#445566\"",
  "colors.tokens.--dsw-alias-label-dimmed.dark = \"#eeff00\"",
  "colors.tokens.--dsw-alias-label-dimmed.light = \"#556677\"",
  "colors.tokens.--dsw-alias-label-primary.dark = \"#aabbcc\"",
  "colors.tokens.--dsw-alias-label-primary.light = \"#112233\"",
  "colors.tokens.--dsw-alias-label-primary-dimmed.dark = \"#eeff00\"",
  "colors.tokens.--dsw-alias-label-primary-dimmed.light = \"#556677\"",
  "colors.tokens.--dsw-alias-label-secondary.dark = \"#bbccdd\"",
  "colors.tokens.--dsw-alias-label-secondary.light = \"#223344\"",
  "colors.tokens.--dsw-alias-label-tertiary.dark = \"#ccddee\"",
  "colors.tokens.--dsw-alias-label-tertiary.light = \"#334455\"",
  "components.css = \"body [class*=\\\"_markdown_\\\"] {\\n  font-size: 15px;\\n  font-weight: 600;\\n}\\nbody [class*=\\\"_tableScroll_\\\"] {\\n  font-family: Georgia, serif;\\n}\\n\"",
  "components.dslHooks = \"._block_aaaaaa_1 {\\n  --dsl-code-block-content-font: var(--dsw-font-markdown-code-block-font-weight) 13px / var(--dsw-font-markdown-code-block-line-height) var(--dsw-font-markdown-code-block-font-family);\\n  --dsl-code-block-banner-font: var(--dsw-font-markdown-code-block-font-weight) 13px / var(--dsw-font-markdown-code-block-line-height) var(--dsw-font-markdown-code-block-font-family);\\n}\\n._block_bbbbbb_3 {\\n  --dsl-terminal-font: var(--dsw-font-markdown-code-block-font-weight) var(--dsw-font-markdown-code-block-font-size) / var(--dsw-font-markdown-code-block-line-height) Menlo, monospace;\\n}\\n\"",
  "type.roles[0] = \"markdown-h1\"",
  "type.roles[1] = \"markdown-base\"",
  "type.roles[2] = \"markdown-code\"",
  "type.tokens.--dsw-font-markdown-base.dark = \"var(--dsw-font-markdown-base-font-weight) 16px / var(--dsw-font-markdown-base-line-height) var(--dsw-font-markdown-base-font-family)\"",
  "type.tokens.--dsw-font-markdown-base.light = \"var(--dsw-font-markdown-base-font-weight) 16px / var(--dsw-font-markdown-base-line-height) var(--dsw-font-markdown-base-font-family)\"",
  "type.tokens.--dsw-font-markdown-base-font-family.dark = \"Menlo, Consolas, monospace\"",
  "type.tokens.--dsw-font-markdown-base-font-family.light = \"Menlo, Consolas, monospace\"",
  "type.tokens.--dsw-font-markdown-base-font-size.dark = \"16px\"",
  "type.tokens.--dsw-font-markdown-base-font-size.light = \"16px\"",
  "type.tokens.--dsw-font-markdown-base-font-weight.dark = \"400\"",
  "type.tokens.--dsw-font-markdown-base-font-weight.light = \"400\"",
  "type.tokens.--dsw-font-markdown-code.dark = \"13px / var(--dsw-font-markdown-code-line-height) var(--dsw-font-markdown-code-font-family)\"",
  "type.tokens.--dsw-font-markdown-code.light = \"13px / var(--dsw-font-markdown-code-line-height) var(--dsw-font-markdown-code-font-family)\"",
  "type.tokens.--dsw-font-markdown-code-font-size.dark = \"13px\"",
  "type.tokens.--dsw-font-markdown-code-font-size.light = \"13px\"",
  "type.tokens.--dsw-font-markdown-h1.dark = \"var(--dsw-font-markdown-h1-font-weight) 24px / var(--dsw-font-markdown-h1-line-height) var(--dsw-font-markdown-h1-font-family)\"",
  "type.tokens.--dsw-font-markdown-h1.light = \"var(--dsw-font-markdown-h1-font-weight) 24px / var(--dsw-font-markdown-h1-line-height) var(--dsw-font-markdown-h1-font-family)\"",
  "type.tokens.--dsw-font-markdown-h1-font-family.dark = \"\\\"SimSun\\\", serif\"",
  "type.tokens.--dsw-font-markdown-h1-font-family.light = \"\\\"SimSun\\\", serif\"",
  "type.tokens.--dsw-font-markdown-h1-font-size.dark = \"24px\"",
  "type.tokens.--dsw-font-markdown-h1-font-size.light = \"24px\"",
  "type.tokens.--dsw-font-markdown-h1-font-weight.dark = \"800\"",
  "type.tokens.--dsw-font-markdown-h1-font-weight.light = \"800\""
];

if (RECORD) {
  const lines = flatten(buildAppearance());
  console.log(JSON.stringify(lines, null, 2).replace(/^\[/, 'const GOLDEN_LINES = [').replace(/\]$/, '];'));
  process.exit(0);
}

// ── 判定脚手架 ──────────────────────────────────────────────────────────────
let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};
const section = (t) => console.log('\n' + t);

// 老形状的 config.json 必须在 apply 之前落好：迁移读的是启动时那份。
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify({ settings: LEGACY_SETTINGS }, null, 2));

// ── mock webServer + req/res shims（与 verify-scene-live.mjs 同形）──────────
const routes = [];
const mockCtx = {
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    tapIndex() { return () => {}; },
  },
};
const schema = await import(pathToFileURL(join(root, 'lib', 'settings-schema.js')).href);
const hostMod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
const host = hostMod.default || hostMod;
const apply = host.apply || (host.inject && host.apply);
const dispose = apply(mockCtx);

function fakeRes() {
  const state = { status: 200, headers: {}, body: Buffer.alloc(0), ended: false };
  const res = new Writable({
    write(chunk, enc, cb) { state.body = Buffer.concat([state.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); cb(); },
    final(cb) { state.ended = true; cb(); },
  });
  res.setHeader = (k, v) => { state.headers[k] = v; };
  res.writeHead = (s, h) => { state.status = s; if (h) Object.assign(state.headers, h); };
  Object.defineProperty(res, 'statusCode', { get: () => state.status, set: (v) => { state.status = v; } });
  res.__state = state;
  return res;
}
function fakeReq(url, method = 'GET') {
  const r = Readable.from([]);
  r.url = url;
  r.method = method;
  r.headers = {};
  return r;
}
function fakeReqBody(url, method, obj) {
  const r = Readable.from([Buffer.from(JSON.stringify(obj))]);
  r.url = url;
  r.method = method;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
/** 等响应 end/finish：PUT 的应答在写盘之后才发，等它就是等持久化完成。 */
function waitRes(res) {
  return new Promise((resolveFn) => {
    if (res.__state.ended) { resolveFn(); return; }
    const t = setTimeout(resolveFn, 5000);
    res.on('finish', () => { clearTimeout(t); resolveFn(); });
  });
}
/** 发一个请求并等它结束（宿主处理可能是 async ⇒ 先把 promise 等掉）。 */
async function callRoute(route, req) {
  const res = fakeRes();
  const done = route.handler(req, res);
  if (done && typeof done.then === 'function') await done;
  await waitRes(res);
  return res;
}
const bodyJson = (res) => {
  try { return JSON.parse(res.__state.body.toString('utf8')); } catch { return null; }
};
/** 目录快照（用于"非法 id 一个字节都没写"的断言）。 */
const dirSnapshot = (dir) => {
  try { return readdirSync(dir).sort().join(','); } catch { return ''; }
};

/**
 * 往返后**没保住**的字体键（空数组 = 全部保住）。
 * 正判据与两条负对照共用同一个函数 —— 负对照若另抄一份判据，生产侧改了也不会红。
 */
function fontKeysNotRoundTripped(back) {
  const out = [];
  for (const k of FONT_KEYS) {
    if (!back || !(k in back)) { out.push(k + ':missing'); continue; }
    if (canon(back[k]) !== canon(FONT_VALUES[k])) out.push(k + ':value');
  }
  return out;
}

const SETTINGS_URL = '/wallpaper-engine/settings';
const FONTSETS_URL = '/wallpaper-engine/fontsets';
const settingsRoute = routes.find((r) => r.path === SETTINGS_URL);
const fontsetsRoute = routes.find((r) => r.path === FONTSETS_URL);

// ── ① 字体键集（承重）───────────────────────────────────────────────────────
section('① 字体键集（承重：把某个键移出 KINDS 时本判据必须变红）');
const persistedKeys = Object.keys(schema.serializeSettings({}));
check('六个字体键都在持久化白名单 KINDS 里',
  FONT_KEYS.every((k) => k in schema.KINDS),
  '缺失=[' + FONT_KEYS.filter((k) => !(k in schema.KINDS)).join(',') + ']');
check('六个字体键都不在 CLIENT_ONLY 里（宿主必须收得下）',
  FONT_KEYS.every((k) => !schema.CLIENT_ONLY.includes(k)),
  'CLIENT_ONLY 里: ' + FONT_KEYS.filter((k) => schema.CLIENT_ONLY.includes(k)).join(','));
check('六个字体键都进序列化白名单（客户端 PUT 的体由它派生）',
  FONT_KEYS.every((k) => persistedKeys.includes(k)),
  '缺失: ' + FONT_KEYS.filter((k) => !persistedKeys.includes(k)).join(','));
check('字体键都不在 DEFAULTS_ONLY 里（那不是持久化字段）',
  FONT_KEYS.every((k) => !schema.DEFAULTS_ONLY.includes(k)),
  'DEFAULTS_ONLY 里: ' + FONT_KEYS.filter((k) => schema.DEFAULTS_ONLY.includes(k)).join(','));
check('负对照：键集判据对"漏登记的键"有牙（fontSetId 不是字体集正文的键 ⇒ 被判出）',
  [...FONT_KEYS, 'fontSetId'].filter((k) => !(k in schema.KINDS)).join() === 'fontSetId');
check('共享内核的 FONTSET_KEYS 与本文件列出的键集逐字一致（单一真源，不是两份清单）',
  JSON.stringify(schema.FONTSET_KEYS) === JSON.stringify(FONT_KEYS),
  'kernel=' + schema.FONTSET_KEYS.join(','));
check('FONTSET_KEYS 的每个键都在 KINDS 里（sanitizeFontset 要按它的 kind 消毒）',
  schema.FONTSET_KEYS.every((k) => k in schema.KINDS));
check('字体集正文不含总开关 fontCustom（它留在 settings 里）',
  !schema.FONTSET_KEYS.includes('fontCustom') && 'fontCustom' in schema.KINDS);

// ── ② 迁移前外观 golden ─────────────────────────────────────────────────────
section('② 迁移前外观 golden（绝对锚点逐条比对）');
{
  const now = flatten(buildAppearance());
  const drift = diffLines(now, GOLDEN_LINES);
  // 正判据：合法外观必须逐锚点一致（它同时是下面两条负对照的配对项 —— 没有它，负对照是恒真空转）。
  check('四个纯计算的载荷与录下的 golden 逐锚点一致',
    drift.length === 0, drift.slice(0, 3).join(' | ') || now.length + ' 个锚点');

  // 负对照①：改一个输入值 ⇒ 必须出现差异。
  const changed = diffLines(flatten(buildAppearance({ sizes: Object.assign({}, TYPE_SIZES, { 'markdown-h1': 25 }) })), GOLDEN_LINES);
  check('负对照：改一个输入值 ⇒ 判据变红（对字号有牙）', changed.length > 0, changed[0] || '');

  // 负对照②：把 light/dark 对**原样包一层**（值不变、锚点路径变深一层）⇒ 必须被判出。
  // 若判据只收集"值的集合"而不比锚点路径，这一条会被放过。
  const anchor = GOLDEN_LINES.find((l) => l.startsWith('colors.tokens.--dsw-alias-label-primary.light'));
  const app = buildAppearance();
  app['colors.tokens']['--dsw-alias-label-primary'] = { pair: app['colors.tokens']['--dsw-alias-label-primary'] };
  const shifted = flatten(app);
  check('负对照：只挪一层（锚点路径变深）也必须被判出',
    Boolean(anchor) && diffLines(shifted, GOLDEN_LINES).length > 0 && !shifted.some((l) => l === anchor),
    anchor || '锚点不在 golden 里');

  // 判据自身的可达性探针：把 golden 上的那个锚点改一位 ⇒ 比对必须立刻红。
  // 它证明该锚点真的在被逐字比较，而不是一条永远成立的装饰。
  const oneCharOff = GOLDEN_LINES.map((l) => (l === anchor ? l.replace('#112233', '#112234') : l));
  check('可达性探针：golden 改一位 ⇒ 判据立刻红（该锚点确实在被比）',
    oneCharOff.join() !== GOLDEN_LINES.join() && diffLines(now, oneCharOff).length > 0);
}

// ── ③ 一次性迁移（惰性）────────────────────────────────────────────────────
section('③ 一次性迁移（老 config.json → fontsets/default.json，判据 = ② 的 golden）');
check('settings 路由已注册（否则 ④ 的往返是空转）', Boolean(settingsRoute), settingsRoute ? settingsRoute.kind : 'missing');
check('字体集路由族已注册（一个 prefix 覆盖六个端点）', Boolean(fontsetsRoute), fontsetsRoute ? fontsetsRoute.kind : 'missing');
check('apply() 本身一个字节都不写字体集（启动期零写盘 ⇒ 未隔离 DSH_WE_DATA_DIR 的守卫不会被污染）',
  !existsSync(FONTSETS_DIR), existsSync(FONTSETS_DIR) ? 'fontsets/ 已存在' : '');

if (fontsetsRoute) {
  const listRes = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL));
  const listed = bodyJson(listRes);
  check('GET /fontsets 触发惰性迁移，并把 default 记为活动集',
    listRes.__state.status === 200 && listed && listed.active === 'default' && listed.migrated === true,
    'status=' + listRes.__state.status + ' body=' + JSON.stringify(listed));
  const defaultFile = join(FONTSETS_DIR, 'default.json');
  check('迁移把 default 集落盘（fontsets/default.json）', existsSync(defaultFile), defaultFile);

  const gotRes = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/default'));
  const got = bodyJson(gotRes);
  check('迁移把老 config.json 的六个内联值原样搬进默认集（逐键 canon 相等）',
    gotRes.__state.status === 200 && got && canon(got.values) === canon(schema.sanitizeFontset(LEGACY_SETTINGS)),
    got ? 'file=' + canon(got.values).slice(0, 120) : 'status=' + gotRes.__state.status);

  // 迁移等价的**接线**：由文件里的值算出的外观，必须与 ② 那份 golden 逐锚点相同。
  const fromFile = flatten(buildAppearance(appearanceInputs(got && got.values)));
  check('迁移等价：由文件里的值算出的外观与 ② 的 golden 逐锚点一致（迁移没有改变外观）',
    diffLines(fromFile, GOLDEN_LINES).length === 0, diffLines(fromFile, GOLDEN_LINES).slice(0, 2).join(' | '));
  // 配对项：把迁移产物改一个值 ⇒ 同一条判据必须变红（否则"等价"是空转）。
  const tampered = Object.assign({}, got && got.values,
    { themeSize: Object.assign({}, got && got.values && got.values.themeSize, { 'markdown-h1': 25 }) });
  check('负对照：改掉迁移产物的一个值 ⇒ 等价判据立刻红',
    diffLines(flatten(buildAppearance(appearanceInputs(tampered))), GOLDEN_LINES).length > 0);

  // 阶段 1 的窗口：客户端还没迁到字体集，六个内联键必须原样留在 config.json 里。
  const cfgNow = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
  check('窗口不变量：迁移后 config.json 仍保留那六个内联键（键退出 KINDS 是阶段 2 的事）',
    FONT_KEYS.every((k) => k in (cfgNow.settings || {})),
    '缺: ' + FONT_KEYS.filter((k) => !(k in (cfgNow.settings || {}))).join(','));
  check('活动 id 记在 config.json 的**根字段**（不是 settings 的键集里）',
    cfgNow.fontSetId === 'default' && !FONT_KEYS.includes('fontSetId'));
}

// ── ④ 持久化往返（真 PUT → config.json → 读回）──────────────────────────────
section('④ 字体键的持久化往返（PUT /settings → config.json → 读回）');
if (settingsRoute) {
  // 客户端 PUT 的体就是 serializeSettings(selection)（P2-9 之后唯一出入口）—— 这里照抄那条形态。
  const body = schema.serializeSettings(Object.assign({ id: 'roundtrip-probe' }, FONT_VALUES));
  const res = await callRoute(settingsRoute, fakeReqBody(SETTINGS_URL, 'PUT', body));
  const accepted = res.__state.status === 200;
  check('PUT /settings 接受这份体（200）', accepted, 'status=' + res.__state.status);

  const cfgPath = join(DATA_DIR, 'config.json');
  let back = null;
  let cfgErr = '';
  try { back = JSON.parse(readFileSync(cfgPath, 'utf8')).settings; } catch (e) { cfgErr = String(e.message || e); }
  check('config.json 里读得到 settings（落盘位置由 DSH_WE_DATA_DIR 决定）',
    Boolean(back), cfgErr || cfgPath);

  const notKept = fontKeysNotRoundTripped(back);
  check('六个字体键经往返后逐键取值不变（同一个判据函数）', notKept.length === 0, notKept.join(' '));

  // 负对照①：把一个字体键从 KINDS 摘掉。键**不在 KINDS 里就在两端都被静默丢弃**
  //（不报错、不进日志）—— 这正是 fontSetId 漏登记时会走的形状。
  const savedMeta = schema.KINDS.themeSize;
  try {
    delete schema.KINDS.themeSize;
    const mutatedBody = schema.serializeSettings(Object.assign({ id: 'roundtrip-probe' }, FONT_VALUES));
    const mutatedHost = schema.sanitizeFromSchema(mutatedBody, 'host');
    check('负对照：键移出 KINDS 后，客户端序列化不再带它', !('themeSize' in mutatedBody));
    check('负对照：同一份输入经宿主消毒后也不再有它（静默丢弃，不报错）', !('themeSize' in mutatedHost));
    check('负对照：往返判据对这次丢弃必须失败（否则正判据是空转）',
      fontKeysNotRoundTripped(mutatedHost).includes('themeSize:missing'),
      fontKeysNotRoundTripped(mutatedHost).join(' '));
  } finally {
    schema.KINDS.themeSize = savedMeta;
  }
  check('负对照收尾：KINDS 已复原（后续判据不跑在被污染的模块上）',
    schema.KINDS.themeSize === savedMeta && 'themeSize' in schema.serializeSettings({}));
  // 负对照②（正判据那一半）：复原后同一份往返必须重新成立。
  check('负对照配对：复原后合法往返必须成功',
    schema.KINDS.themeSize === savedMeta
    && fontKeysNotRoundTripped(schema.sanitizeFromSchema(
      schema.serializeSettings(Object.assign({ id: 'roundtrip-probe' }, FONT_VALUES)), 'host')).length === 0);
}

// ── ⑤ 字体集的路径安全与往返 ────────────────────────────────────────────────
section('⑤ 字体集存取的路径安全与往返（id 白名单 / 不落盘 / 合法 id 必须成功）');
if (fontsetsRoute) {
  // 5a. 白名单**逐条**（单元级）：URL 规范化会先把 `..` 一类点段吃掉，所以两种口径都要测 ——
  //     这一层测的是"就算它到了分派处也仍然进不去"。
  const BAD_IDS = ['../x', '..\\x', '/abs', 'C:', 'C:\\x', '', '.', '..', 'a/b', 'a\\b',
    'x'.repeat(65), 'import', 'export', 'a b', 'a.json', '%2e%2e', 'con:', 'a\0b', 'default.json'];
  const leaked = BAD_IDS.filter((v) => schema.isFontSetId(v));
  check('id 白名单逐条拒绝（穿越 / 绝对路径 / 盘符 / 空 / 点段 / 保留段 / 超长 / 非法字符）',
    leaked.length === 0, leaked.length ? '漏过: ' + JSON.stringify(leaked) : BAD_IDS.length + ' 个用例');
  check('负对照：合法 id 必须过白名单（否则上面那条恒真）',
    ['default', 'my-set_1', 'A'.repeat(64)].every((v) => schema.isFontSetId(v))
    && !schema.isFontSetId('A'.repeat(65)));

  // 5b. 行为级：非法 id 的请求必须被拒，且目录内容**一个字节都不变**。
  const snapBefore = dirSnapshot(FONTSETS_DIR);
  const BAD_URLS = [
    FONTSETS_URL + '/a%2F..%2Fb',      // 编码斜杠 ⇒ 解码后含 '/' ⇒ 白名单拒
    FONTSETS_URL + '/a%5Cb',           // 编码反斜杠
    FONTSETS_URL + '/' + 'x'.repeat(80),
    FONTSETS_URL + '/a.json',
    FONTSETS_URL + '/C%3A',
    FONTSETS_URL + '/%2e%2e%2Fx',      // 点段：URL 规范化会吃掉它 ⇒ 落到别的分支（仍被拒）
    FONTSETS_URL + '//evil',
    FONTSETS_URL + '/%00',
    FONTSETS_URL + '/export',
  ];
  const seen = [];
  for (const url of BAD_URLS) {
    for (const method of ['PUT', 'DELETE']) {
      const res = await callRoute(fontsetsRoute,
        method === 'PUT' ? fakeReqBody(url, 'PUT', { values: {} }) : fakeReq(url, method));
      if (![400, 404, 405, 409, 413].includes(res.__state.status)) seen.push(method + ' ' + url + '→' + res.__state.status);
    }
  }
  check('非法 id / 非法路径的写删请求全部被拒（400 / 404 / 405）',
    seen.length === 0, seen.slice(0, 3).join(' | ') || BAD_URLS.length * 2 + ' 个请求');
  check('非法请求之后目录内容一个字节都没变（判据落在"没落盘"，不只看状态码）',
    dirSnapshot(FONTSETS_DIR) === snapBefore, 'now=' + dirSnapshot(FONTSETS_DIR));

  // 5c. 合法 id 必须成功 —— 否则上面整组负对照是恒真的空转。
  const probeId = 'probe-set_1';
  const putEmpty = await callRoute(fontsetsRoute,
    fakeReqBody(FONTSETS_URL + '/' + probeId, 'PUT', { name: '探针' }));
  check('PUT 缺 values ⇒ 400（清空必须显式给 {}，不许被静默当成清空）',
    putEmpty.__state.status === 400, 'status=' + putEmpty.__state.status);
  const putRes = await callRoute(fontsetsRoute,
    fakeReqBody(FONTSETS_URL + '/' + probeId, 'PUT', { name: '探针', values: FONT_VALUES }));
  check('合法 id + 合法 body ⇒ 200（负对照组的配对项）',
    putRes.__state.status === 200, 'status=' + putRes.__state.status);
  check('写入后文件出现在目录里', existsSync(join(FONTSETS_DIR, probeId + '.json')));

  const getRes = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/' + probeId));
  const gotProbe = bodyJson(getRes);
  check('写进去的值能逐键读回（canon 相等）',
    getRes.__state.status === 200 && gotProbe && canon(gotProbe.values) === canon(FONT_VALUES),
    gotProbe ? '' : 'status=' + getRes.__state.status);

  // 导出的字节必须能再导入读回同一份值（导出正文由读到的值重建）。
  const expRes = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/' + probeId + '/export'));
  const exported = bodyJson(expRes);
  check('export 带 attachment 头且正文是当前版本',
    expRes.__state.status === 200
    && /attachment/.test(String(expRes.__state.headers['Content-Disposition'] || ''))
    && exported && exported.$schema === schema.FONTSET_SCHEMA_TAG,
    String(expRes.__state.headers['Content-Disposition'] || 'no header'));
  const impRes = await callRoute(fontsetsRoute, fakeReqBody(FONTSETS_URL + '/import', 'POST', exported));
  const imported = bodyJson(impRes);
  check('导入导出的字节 ⇒ 分配到新 id（不与既有集撞名）',
    impRes.__state.status === 200 && imported && imported.id && imported.id !== probeId,
    'id=' + (imported && imported.id));
  const impGet = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/' + (imported && imported.id)));
  const impValues = bodyJson(impGet);
  check('导入读回的值与导出前逐键相同（往返闭合）',
    impGet.__state.status === 200 && impValues && canon(impValues.values) === canon(FONT_VALUES));

  // 读不懂的版本必须**拒绝并说明**，不猜、不静默降级成空集。
  writeFileSync(join(FONTSETS_DIR, 'broken.json'),
    JSON.stringify({ $schema: 'dsh-we/fontset@99', id: 'broken', name: 'x', values: {} }));
  const brokenRes = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/broken'));
  const broken = bodyJson(brokenRes);
  check('版本读不懂 ⇒ 422 + 可判定原因（不猜、不降级成空集）',
    brokenRes.__state.status === 422 && broken && broken.reason === 'bad-version',
    'status=' + brokenRes.__state.status + ' reason=' + (broken && broken.reason));
  const list2 = bodyJson(await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL)));
  const brokenRow = (list2 && list2.fontsets || []).find((f) => f.id === 'broken');
  check('列表把读不懂的文件标成 broken（不静默隐藏，也不当成正常集）',
    Boolean(brokenRow) && brokenRow.broken === 'bad-version', JSON.stringify(brokenRow));

  // 活动集不可删（"正在用的那份被删掉"没有可判定的正确结果）。
  const delActive = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/default', 'DELETE'));
  check('删除活动集 ⇒ 400 且文件仍在',
    delActive.__state.status === 400 && existsSync(join(FONTSETS_DIR, 'default.json')),
    'status=' + delActive.__state.status);

  const unknown = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/no-such-set'));
  check('未知 id ⇒ 404', unknown.__state.status === 404, 'status=' + unknown.__state.status);

  // 切换活动集：切换前必须读得懂（否则拒绝），切成功之后"删不动/删得动"的界限要跟着移动。
  const actUnknown = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/no-such-set/activate', 'POST'));
  check('切换到不存在的集 ⇒ 404', actUnknown.__state.status === 404, 'status=' + actUnknown.__state.status);
  const actBroken = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/broken/activate', 'POST'));
  check('切换到读不懂的集 ⇒ 422（不把外观切到说不清的状态）',
    actBroken.__state.status === 422, 'status=' + actBroken.__state.status);
  const actProbe = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/' + probeId + '/activate', 'POST'));
  const actBody = bodyJson(actProbe);
  check('切换到合法集 ⇒ 200 且 active 跟着变',
    actProbe.__state.status === 200 && actBody && actBody.active === probeId,
    'status=' + actProbe.__state.status + ' active=' + (actBody && actBody.active));
  const cfgAfter = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
  check('活动 id 落在 config.json 根字段上（切换真的持久化了，不只是响应里说了一句）',
    cfgAfter.fontSetId === probeId, 'fontSetId=' + cfgAfter.fontSetId);
  const listAfter = bodyJson(await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL)));
  check('列表的 active 与切换结果一致（列表是真源，不是客户端自己的记忆）',
    listAfter && listAfter.active === probeId
    && (listAfter.fontsets || []).filter((f) => f.active).map((f) => f.id).join() === probeId,
    JSON.stringify((listAfter && listAfter.fontsets || []).map((f) => f.id + (f.active ? '*' : ''))));

  // 界限是会移动的：**前**活动集（default）现在删得掉，**当前**活动集删不掉。
  const delFormer = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/default', 'DELETE'));
  check('切走之后，前活动集可删 ⇒ 200 且文件消失',
    delFormer.__state.status === 200 && !existsSync(join(FONTSETS_DIR, 'default.json')),
    'status=' + delFormer.__state.status);
  const delCurrent = await callRoute(fontsetsRoute, fakeReq(FONTSETS_URL + '/' + probeId, 'DELETE'));
  check('当前活动集仍不可删 ⇒ 400 且文件仍在（同一条规则在另一个集上同样成立）',
    delCurrent.__state.status === 400 && existsSync(join(FONTSETS_DIR, probeId + '.json')),
    'status=' + delCurrent.__state.status);
}

// ── teardown ────────────────────────────────────────────────────────────────
try { dispose && dispose(); } catch { /* ignore */ }
delete process.env.DSH_WE_STEAM_ROOT;
delete process.env.DSH_WE_UPLOAD_DIR;
rmSync(ISO, { recursive: true, force: true });

console.log('');
if (failed) {
  console.log(`FONTSET CHECKS FAILED — ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL FONTSET CHECKS PASSED (${passed})`);
