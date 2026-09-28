#!/usr/bin/env node
/**
 * verify-contracts.mjs — **声明出来的契约必须与代码一致**（本轮审计把两类"没人守的契约"归到
 * 账本 P3-12 与 P3-21）。
 *
 * ① **运行时下限**：`package.json` 的 `engines.node`。宿主代码用了全局 `fetch`（Node ≥18）与
 *    `AbortSignal.timeout`（≥17.3），而这两个 API 缺失时的失败**是被吞掉的**（回落成"没有封面"，
 *    用户永远看不到原因）⇒ 没有 `engines` 时 npm 既不警告也不拒绝，降级是静默的。这里断言：
 *    声明存在，且声明的**最低版本不低于代码真实用到的 API 所要求的下限**。
 *
 * ② **跨半边契约**：同一个词表在浏览器半边与宿主半边各写一份，而两边都由同一个用户操作驱动：
 *    · `BASE`（路径前缀）—— `lib/index.js` 与 `src/api-client.js` 各一份。不一致时**每一条**
 *      客户端请求 404（失败很响，但排查成本高）。
 *    · **上传 MIME** —— 客户端 `UPLOAD_TYPES` / 自定义画面的 accept 列表 vs 宿主 `UPLOAD_EXT` /
 *      `CUSTOM_FRAME_EXT`。不一致时选择器会收下一个宿主映射不出扩展名的文件 ⇒ **静默失败**。
 *
 * 口径（都是"读两边源码比对"）：**不是** import 一边再与自己比 —— 那对"两边一致"是同源比较，
 * 永远为真。这一条是 P1-5「设置键四处镜像」同一个教训的推广。
 *
 * 每条断言都配一条负对照（把坏输入喂给**同一个**判据函数并断言它判坏），并带覆盖断言
 * （集合必须非空 —— 否则"两个空集相等"会让相等断言恒真）。退出码 0/1。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
/** 集合相等（用于词表比对）。 */
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
const uniq = (xs) => [...new Set(xs)];
/** 从一个 JS 字面量串里抠出所有带引号的字符串。 */
const quoted = (s) => [...s.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

// ── ① 运行时下限 ────────────────────────────────────────────────────────────
console.log('\n① 运行时下限（engines 与代码真实用到的 API 对齐）');

/** 代码里真正用到的、有最低 Node 版本要求的 API → 所需最低版本。 */
const API_FLOORS = [
  { name: 'global fetch', re: /(^|[^.\w$])fetch\s*\(/gm, since: 18 },
  { name: 'AbortSignal.timeout', re: /AbortSignal\.timeout\s*\(/g, since: 17.3 },
];

/** 扫一份源码，返回它要求的最低 Node 版本（没有命中则 0）。 */
function requiredFloor(src) {
  let floor = 0;
  for (const api of API_FLOORS) {
    api.re.lastIndex = 0;
    if (api.re.test(src)) floor = Math.max(floor, api.since);
  }
  return floor;
}
/** 从一个 semver range 里取"最低被提到的版本"（`>=18` → 18；`^22.19.0 || >=24` → 22.19）。 */
function rangeFloor(range) {
  const nums = [...String(range).matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)]
    .map((m) => Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0));
  return nums.length ? Math.min(...nums) : 0;
}

const pkg = JSON.parse(read('package.json'));
/** 声明里是否给出了 node 下限（同一个判据也用于负对照）。 */
const hasNodeEngine = (p) => Boolean(p && p.engines && p.engines.node);
{
  // 只扫会被发布的宿主代码（浏览器半边不跑在 Node 上，不能拿它推下限）
  const hostSrc = ['lib/index.js', 'lib/media/legacy.js', 'lib/media/index.js', 'lib/media/supervisor.js']
    .map((f) => { try { return read(f); } catch { return ''; } }).join('\n');
  const need = requiredFloor(hostSrc);
  const declared = pkg.engines && pkg.engines.node;
  check('宿主代码里确实用到了有版本要求的 API（判据非空转）', need >= 18,
    '推导出的下限 = ' + need);
  check('package.json 声明了 engines.node', hasNodeEngine(pkg), declared ? String(declared) : '缺失');
  check('声明的下限不低于代码真实下限', declared ? rangeFloor(declared) >= need : false,
    '声明 ' + declared + ' → ' + (declared ? rangeFloor(declared) : '?') + ' / 需要 ' + need);

  // 负对照：把坏输入喂给**同一个**判据
  check('negative control: 过低的声明会被判不合格', rangeFloor('>=16') < need);
  check('negative control: 缺失声明会被判不合格',
    hasNodeEngine({}) === false && hasNodeEngine({ engines: {} }) === false && hasNodeEngine(pkg) === true);
  check('negative control: 不含版本要求的源码推导出 0（证明判据依赖真实命中）',
    requiredFloor('const x = 1; function f() {}') === 0);
}

// ── ② 跨半边契约 ────────────────────────────────────────────────────────────
console.log('\n② 跨半边契约（读两边源码比对，不是 import 一边自己比）');

/** `BASE` 的单一字面量。 */
function baseOf(src) {
  const m = /const\s+BASE\s*=\s*['"]([^'"]+)['"]/.exec(src);
  return m ? m[1] : null;
}
/** `const NAME = { 'mime': 'ext', … }` 的键集合。 */
function hostMimeKeys(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\{([^}]*)\\}').exec(src);
  if (!m) return null;
  return uniq([...m[1].matchAll(/['"]([^'"]+)['"]\s*:/g)].map((x) => x[1]));
}
/** 客户端 `const NAME = ["mime", …]`。 */
function clientMimeList(src, name) {
  const m = new RegExp('const\\s+' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(src);
  return m ? uniq(quoted(m[1])) : null;
}
/** 客户端所有 `accept: "a,b,c"` 列表。 */
function acceptLists(src) {
  return [...src.matchAll(/accept:\s*['"]([^'"]+)['"]/g)]
    .map((m) => uniq(m[1].split(',').map((s) => s.trim()).filter(Boolean)));
}

const hostSrc = read('lib/index.js');
const apiSrc = read('src/api-client.js');
const clientSrc = read('src/client.js');
const tabsSrc = read('src/panel-tabs.js');

{
  const a = baseOf(hostSrc);
  const b = baseOf(apiSrc);
  check('BASE 两边都能解析出字面量（判据非空转）', Boolean(a) && Boolean(b), 'host=' + a + ' client=' + b);
  check('BASE 两侧一致', a !== null && a === b, a + ' vs ' + b);
  // 负对照：把不一致的输入喂给同一个比较
  check('negative control: BASE 不一致会被判出',
    baseOf("const BASE = '/a';") !== baseOf("const BASE = '/b';"));
}

{
  const clientUp = clientMimeList(clientSrc, 'UPLOAD_TYPES');
  const hostUp = hostMimeKeys(hostSrc, 'UPLOAD_EXT');
  const clientFrame = acceptLists(tabsSrc);
  const hostFrame = hostMimeKeys(hostSrc, 'CUSTOM_FRAME_EXT');

  // 覆盖断言：两个集合都必须非空 —— 否则"两个空集相等"会让下面的相等断言恒真
  check('上传 MIME：两侧都解析出非空集合（判据非空转）',
    Boolean(clientUp && clientUp.length >= 3) && Boolean(hostUp && hostUp.length >= 3),
    'client=' + (clientUp || []).length + ' host=' + (hostUp || []).length);
  check('上传 MIME：客户端 UPLOAD_TYPES 与宿主 UPLOAD_EXT 键集一致',
    Boolean(clientUp && hostUp) && sameSet(clientUp, hostUp),
    (clientUp || []).join(',') + ' vs ' + (hostUp || []).join(','));

  const match = clientFrame.find((l) => hostFrame && sameSet(l, hostFrame));
  check('自定义画面 MIME：客户端有一个 accept 列表与宿主 CUSTOM_FRAME_EXT 键集一致',
    Boolean(hostFrame && hostFrame.length >= 3) && Boolean(match),
    'host=' + (hostFrame || []).join(',') + ' client=' + clientFrame.map((l) => l.join(',')).join(' | '));

  // 负对照：喂给同一个比较
  check('negative control: 上传 MIME 单边加一种类型会被判出',
    !sameSet(['image/jpeg', 'image/png', 'video/mp4', 'image/webp'], ['image/jpeg', 'image/png', 'video/mp4']));
  check('negative control: 自定义画面 accept 少一种会被判出',
    !sameSet(['image/png', 'image/jpeg'], ['image/jpeg', 'image/png', 'image/webp']));
}

{
  // F3 阶段 4：字体集文件的"能读什么"由**同一个 `$schema`** 定义 —— 客户端拿它做本地预检
  // （给一句可判定文案），宿主拿它做权威校验。两边必须引用**同一个常量**，谁也不许手抄字面量
  // （手抄就会漂：客户端放行、宿主拒收，反之亦然 —— 那是最难查的一类"看起来没反应"）。
  const kernel = read('lib/settings-schema.js');
  const storeSrc = read('src/fontset-store.js');
  const editorSrc = read('src/fontset-editor.js');
  const routeSrc = read('lib/routes/fontsets.js');
  const tag = /const\s+FONTSET_SCHEMA_TAG\s*=\s*'([^']+)'\s*\+\s*FONTSET_SCHEMA_VERSION/.exec(kernel);
  check('版本标记 = 前缀 + 版本常量，且定义在共享内核（判据非空转）',
    Boolean(tag) && /const\s+FONTSET_SCHEMA_VERSION\s*=\s*\d+/.test(kernel), tag ? tag[1] + 'N' : '(没解析到)');
  // 字面量只许出现在共享内核：其余会 import 的两半都只能写常量名。
  const literalSites = ['lib/index.js', 'lib/routes/fontsets.js', 'src/fontset-store.js',
    'src/fontset-editor.js', 'src/client.js', 'src/api-client.js']
    .filter((f) => /dsh-we\/fontset@/.test(read(f)));
  check('字体集的版本字面量只出现在共享内核（两半都引用常量名，不手抄）',
    literalSites.length === 0, literalSites.join(',') || '零处手抄');
  check('客户端预检与宿主校验用的是同一个常量名',
    /FONTSET_SCHEMA_TAG/.test(storeSrc) && /FONTSET_SCHEMA_TAG/.test(routeSrc));
  check('导入走宿主那条路由（客户端 POST 到 /fontsets/import）',
    /fontSetsUrl\(\)\s*\+\s*"\/import"/.test(storeSrc),
    '客户端侧路由拼接');
  check('导入入口的 accept 只提示 .json（真正的门是 $schema，不是扩展名）',
    /accept:\s*"\.json,application\/json"/.test(editorSrc) && /\.json/.test(editorSrc));
  // 负对照：同一判据对"某处手抄了版本字面量"有牙
  check('negative control: 手抄的版本字面量会被判出',
    /dsh-we\/fontset@/.test("const X = 'dsh-we/fontset@1';") && !/dsh-we\/fontset@/.test('const X = FONTSET_SCHEMA_TAG;'));
}

console.log('');
if (failed) { console.log('CONTRACT CHECKS FAILED — ' + failed + ' failed'); process.exit(1); }
console.log('ALL CONTRACT CHECKS PASSED');
