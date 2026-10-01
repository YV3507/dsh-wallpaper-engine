/**
 * verify-package-publish.mjs — **发布面**守卫（npm 方向）。
 *
 * 与 verify-package-files.mjs 的分工：那一份管"打包元数据有没有漂移"（files 覆盖 lib/、
 * 入口在位、依赖无死声明、工具链零裸依赖）；这一份管**装到用户机器上会不会坏 / 会不会多带东西**，
 * 四类失效各自独立：
 *   ① **该进的没进** ⇒ 用户装完跑不起来：按 `lib/index.js` 的**可达闭包**逐个核对是否被 `files` 覆盖；
 *      闭包里的每个相对导入目标还必须**真实存在于磁盘** —— 指向不存在文件的 import 在仓库里是
 *      死路径、没人撞得上，装到用户机器上才炸成 `ERR_MODULE_NOT_FOUND`；
 *   ② **不该进的进了** ⇒ 体积与源码外泄：发布集里不得出现 src/scripts/test/docs 等开发目录；
 *      白名单恰有一条 `scripts/prepare.mjs`：`prepare` 在 git 直装、或把包装成根项目执行时真的会跑，
 *      它不随包 = 一跑就 `MODULE_NOT_FOUND`；
 *   ③ **带了同步机器的东西** ⇒ 不可复现 + 隐私：发布文本里不得出现真实的用户目录路径
 *      （占位符 `<你的用户名>` / `xxx` / `%USERPROFILE%` 不算）；
 *   ④ **白下载的运行时依赖** ⇒ 声明了但**活代码从不加载**：`dependencies` 每一条都必须被
 *      可达闭包 import（"lib/ 里某处 import 过"不够 —— 死码也算 import，见账本 §3.2）。
 *
 * 不调 npm：`files` 的展开语义在这里复刻（目录条目 / `*` 不跨 `/` / `**` 跨），
 * 于是 CI 与本机沙箱都能跑；tarball 的权威清单仍以 `npm pack --dry-run` 为准。
 * 注：这里核对的是 **`files` 驱动的集合**；npm 还会自动带上 `package.json` / `LICENSE` /
 * `README*` 等，所以真实 tarball 的条目数会比这里略多（差额即这些自动附带项）。
 * 需要精确条目数时以本机 `npm pack --dry-run` 的输出为准 —— 此处不写死数字。
 *
 * **负对照的形态规则（P3-16）**：变异输入必须喂进**同一条判据** —— 本文件里就是那几个命名实体
 * （`publishSet` / `resolveRelative` / `isDevLeak` / `DEV` / `PLACEHOLDER` / `unshippedRefs` /
 * `usedByClosure` / `vm.Script`），正判据与负对照都调它。只断言"某个常量不含 X"不算（判据没被执行）；在对照里另抄一份判据
 * 也不算（生产侧改了也不会红）。规则全文见 [`docs/DEV-GUIDE.md`](../docs/DEV-GUIDE.md) §约定 5。
 *
 * Usage:  node test/verify-package-publish.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
const section = (t) => console.log('\n' + t);
const rel = (abs) => relative(ROOT, abs).split(sep).join('/');

/** npm `files` 条目里的 glob → 正则：`*` 不跨 `/`，`**` 跨。 */
function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.[]{}()|'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** 条目 entry 是否覆盖相对路径 rel（目录条目可写 `lib/x/` 或 `lib/x`）。 */
function coveredBy(r, entry) {
  const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!e) return false;
  let isDir = String(entry).endsWith('/');
  if (!isDir) {
    try { isDir = statSync(join(ROOT, e)).isDirectory(); } catch { /* 非目录/不存在 */ }
  }
  if (isDir) return r === e || r.startsWith(e + '/');
  if (/[*?]/.test(e)) return globRe(e).test(r);
  return r === e;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];
const publishSet = (r) => files.some((entry) => coveredBy(r, entry));

/** 遍历仓库文件；跳过永远不可能"被发布"的重目录（否则本机要白走一遍 .git 与 node_modules）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.test-cache', '_refs', '.integration-notes']);
const walk = (dir, out = []) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st = null;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push(rel(abs));
  }
  return out;
};

// ── ① 该进的没进：可达闭包 ⊆ 发布集 ─────────────────────────────────────────
// 说明：`lib/webwallgl/**`（按文本注入 HTML）与 `lib/vendor/**`（按字符串 require）不走
// import 图，它们由下面的"目录条目覆盖"断言兜住，不在这张图里假装可达。
section('① 可达闭包（活的代码所需文件）是否都被 `files` 覆盖');

/** 判据：相对说明符 → 磁盘上的目标文件；候选一个都不存在返回 null。
 *  主扫描与负对照都走它 —— 否则"找不到"这条判据没有被真正执行过（P3-16）。 */
function resolveRelative(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec.split('?')[0]);
  for (const cand of [base, base + '.js', base + '.mjs', base + '.cjs', join(base, 'index.js')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const seen = new Set();
const queue = [join(ROOT, 'lib', 'index.js')];
const bare = new Set();
const unresolved = [];
while (queue.length) {
  const abs = queue.pop();
  if (seen.has(abs) || !existsSync(abs) || !/\.(js|mjs|cjs)$/.test(abs)) continue;
  seen.add(abs);
  const text = readFileSync(abs, 'utf8');
  const specs = [];
  for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const s of specs) {
    if (s.startsWith('node:')) continue;
    if (!s.startsWith('.')) { bare.add(s); continue; }
    const target = resolveRelative(abs, s);
    if (target === null) { unresolved.push(rel(abs) + ' → ' + s); continue; }
    queue.push(target);
  }
}
const closure = [...seen].map(rel).sort();

/** 判据：某条声明依赖是否被**可达闭包**加载（正判据与负对照都走它；`list` 可注入）。 */
function usedByClosure(dep, list = bare) {
  // `bare` 是 Set、对照注入的却是数组 ⇒ **先摊开再判**：`Set` 上没有 `.some`，
  // 早先直接 `list.some(...)` 的写法一旦声明了任何依赖就会 `TypeError`
  // （当时 `dependencies` 为空，这条路径从不执行 ⇒ 恒绿而看不出来）。
  return [...list].some((s) => s === dep || s.startsWith(dep + '/'));
}
const uncovered = closure.filter((r) => !publishSet(r));
check('可达闭包里的每个文件都被 `files` 覆盖', uncovered.length === 0,
  uncovered.length ? '未覆盖：' + uncovered.join(', ') : closure.length + ' 个文件');
check('负对照：覆盖判据对包外路径有牙', !publishSet('src/client.js') && publishSet('lib/index.js'));
check('可达闭包里的每个相对导入目标都在磁盘上（指向不存在的文件 = 装上一加载就 ERR_MODULE_NOT_FOUND）',
  unresolved.length === 0,
  unresolved.length ? '找不到：' + unresolved.join(', ') : closure.length + ' 个文件全部解析到实体');
check('负对照：目标解析判据对缺文件返回 null、对在位与省略扩展名的说明符返回路径',
  resolveRelative(join(ROOT, 'lib', 'index.js'), './definitely-absent.js') === null
  && resolveRelative(join(ROOT, 'lib', 'index.js'), './__absent__') === null
  && resolveRelative(join(ROOT, 'lib', 'index.js'), './pkg-extract') === join(ROOT, 'lib', 'pkg-extract.js')
  && resolveRelative(join(ROOT, 'lib', 'index.js'), './index.js') === join(ROOT, 'lib', 'index.js'));
// 本 fork 保留：`usedByClosure` 的 `Set` 形态崩溃修复（上游与本仓库基线都仍是 `list.some`）。
// 它与分包模型无关，且上游那份同样有崩溃点 ⇒ 保留修法 + 保留这条对照。
check('负对照：依赖判据在 Set 与数组两种形态下都成立（防 `.some` 崩）',
  usedByClosure('some-dep', new Set(['some-dep'])) === true
  && usedByClosure('some-dep', ['some-dep/sub']) === true
  && usedByClosure('nope', new Set(['some-dep'])) === false);

// ── ② 不该进的进了 ──────────────────────────────────────────────────────────
section('② 发布集里没有开发目录');
const DEV = /^(src|scripts|test|docs|node_modules|\.test-cache|\.integration-notes|_refs|\.github|\.git)(\/|$)/;
/** 恰有一条白名单：`scripts/prepare.mjs` 必须随包 —— `prepare` 在 git 直装、或把包装成
 *  根项目执行时真的会跑，不随包就是执行即 `MODULE_NOT_FOUND`。其余开发面文件一律算泄漏。
 *  正判据（两个 check）与负对照都走 `isDevLeak`。 */
const SHIPPED_DEV_FILES = new Set(['scripts/prepare.mjs']);
const isDevLeak = (p) => {
  const e = String(p).replace(/^\.\//, '');
  return DEV.test(e) && !SHIPPED_DEV_FILES.has(e);
};
const devEntries = files.filter((e) => isDevLeak(e));
check('`files` 条目本身不指向开发目录（白名单只放行 `scripts/prepare.mjs`）', devEntries.length === 0,
  devEntries.join(', ') || '无');
// 展开后的实测清单（防"某条目其实是个通配符/根目录"）
const published = walk(ROOT).filter(publishSet);
const devLeak = published.filter((r) => isDevLeak(r));
check('展开后的发布集里没有开发目录文件（白名单只放行 `scripts/prepare.mjs`）', devLeak.length === 0,
  devLeak.length ? devLeak.slice(0, 5).join(', ') + (devLeak.length > 5 ? ` … 共 ${devLeak.length}` : '') : published.length + ' 个文件');
check('白名单是棘轮（只许这一条，且该文件确实在库）',
  SHIPPED_DEV_FILES.size === 1 && SHIPPED_DEV_FILES.has('scripts/prepare.mjs')
  && existsSync(join(ROOT, 'scripts', 'prepare.mjs')),
  [...SHIPPED_DEV_FILES].join(', ') || '空');
check('负对照：开发目录判据对 src/ 与 scripts/ 有牙、白名单外的 scripts/ 文件仍被判出',
  isDevLeak('src/client.js') && isDevLeak('scripts/build-client.mjs') && !isDevLeak('lib/index.js')
  && !isDevLeak('scripts/prepare.mjs'));

// ── ③ 同步机器路径（不可复现 + 隐私）────────────────────────────────────────
section('③ 发布文本里没有真实的用户目录路径');
// 占位符不算：`<你的用户名>` / `<your-user>` / `xxx` / `%USERPROFILE%` / `$HOME` 之类。
const PLACEHOLDER = /^(<.*>|x{2,}|your[-_]?user|yourname|username|user|name|%[A-Za-z_]+%|\$\{?[A-Za-z_]+\}?)$/i;
const pathHits = [];
for (const r of published) {
  if (!/\.(js|mjs|cjs|json|yml|yaml|md|swift|ts)$/.test(r)) continue;
  if (r === 'package.json') continue;
  const text = readFileSync(join(ROOT, r), 'utf8');
  for (const m of text.matchAll(/[A-Za-z]:\\Users\\([^\\\s"']+)|\/Users\/([^/\s"']+)|\/home\/([^/\s"']+)/g)) {
    const who = m[1] || m[2] || m[3] || '';
    if (PLACEHOLDER.test(who)) continue;
    pathHits.push(r + ' → ' + who);
  }
}
check('发布文本里没有真实用户目录路径（占位符不算）', pathHits.length === 0,
  pathHits.length ? [...new Set(pathHits)].join('; ') : '干净');
check('负对照：路径判据放行占位符、拦住真实用户名',
  PLACEHOLDER.test('<你的用户名>') && PLACEHOLDER.test('xxx') && PLACEHOLDER.test('%USERPROFILE%')
  && !PLACEHOLDER.test('some-real-user'));

// ── ④ 白下载的运行时依赖 ────────────────────────────────────────────────────
section('④ 每个 dependencies 都被**可达闭包**用到');
// 棘轮：只许缩小。白名单为空 —— 任何"声明了但活代码从不加载"的依赖都必须当场删掉，
// 而不是登记在这里（白名单一旦有人加条目，这条断言就要求它确实仍未被使用）。
const DEP_UNUSED_ALLOW = {};
const deps = Object.keys(pkg.dependencies || {});
const unused = deps.filter((d) => !usedByClosure(d));
const unexpected = unused.filter((d) => !(d in DEP_UNUSED_ALLOW));
check('没有"声明了但活代码从不加载"的依赖', unexpected.length === 0,
  unexpected.join(', ') || deps.join(', ') || '（无声明）');
check('棘轮只许缩小：白名单里的依赖必须仍未被使用（删干净后请一并清掉本条）',
  Object.keys(DEP_UNUSED_ALLOW).every((d) => deps.includes(d) && unused.includes(d)),
  '白名单 ' + Object.keys(DEP_UNUSED_ALLOW).length + ' 条');
check('负对照：依赖使用判据对合成输入有牙',
  usedByClosure('left-pad', ['left-pad/sub'])     // 子路径算用到
  && !usedByClosure('left-pad', ['left-padx'])    // 近失：前缀必须落在路径边界上
  && !usedByClosure('left-pad', ['node:fs']));    // 不相关的内置不是它

// ── ⑤ 入口 / 导出目标都在包里 ───────────────────────────────────────────────
section('⑤ 入口与导出目标都被发布');
const entries = [
  ['main', pkg.main],
  ["exports['.'].default", pkg.exports?.['.']?.default],
  ["exports['.']  .types", pkg.exports?.['.']?.types],
  ["exports['./client'].default", pkg.exports?.['./client']?.default],
  ["exports['./client'].types", pkg.exports?.['./client']?.types],
  ['types', pkg.types],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ['dsh.client 平台/即时加载', pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true ? 'lib/index.js' : null],
];
const badEntries = entries.filter(([, p]) => !p || !existsSync(join(ROOT, String(p).replace(/^\.\//, '')))
  || !publishSet(String(p).replace(/^\.\//, '')));
check('每个入口/导出目标都真实存在且被发布', badEntries.length === 0,
  badEntries.map(([k, p]) => k + '=' + p).join(', ') || entries.length + ' 项');
check('`files` 里声明的每个条目都存在（否则 npm 会静默少发）',
  files.every((e) => existsSync(join(ROOT, String(e).replace(/\/+$/, '')))),
  files.filter((e) => !existsSync(join(ROOT, String(e).replace(/\/+$/, '')))).join(', ') || files.length + ' 条');
check('type=module（.js 按 ESM 解析）与 publishConfig.access', pkg.type === 'module'
  && pkg.publishConfig?.access === 'public');

// ── ⑥ 客户端产物形态（用户拿到的那一份）────────────────────────────────────
section('⑥ 发布出去的客户端产物可解析、是加载器形态');
const clientRel = String(pkg.exports?.['./client']?.default || 'lib/client.js').replace(/^\.\//, '');
const clientSrc = readFileSync(join(ROOT, clientRel), 'utf8');
check('产物是 DSH 客户端加载器形态（自注册 + factory）',
  clientSrc.startsWith('window.__ModuleLoader__.load({') && clientSrc.includes('factory: (require) => {'));
check('产物可解析（vm.Script —— 与构建同一道网）', (() => {
  try { new Script(clientSrc, { filename: clientRel }); return true; } catch { return false; }
})());
check('负对照：语法网对坏产物有牙', (() => {
  try { new Script('window.__ModuleLoader__.load({ factory: (require) => { ) }', { filename: 'bad.js' }); return false; }
  catch { return true; }
})());

// ── ⑦ 安装期脚本不得引用未随包发布的文件（否则每个用户"装完就炸"）──────────────
// npm 为**依赖**运行 `preinstall` / `install` / `postinstall`；`prepare` 另有两个真的会跑的
// 时刻 —— git 直装（pnpm/npm 先装它的依赖再跑 prepare），以及把包装成**根项目**执行
// （解包后 `pnpm install` / 仓库里的 `npm install`）。所以 `prepare` 不算开发期脚本：
// 它引用的文件必须随包（② 的白名单就是为此开的），而 `prepublishOnly` / `build` /
// `verify` / `smoke` 只在仓库里跑，引用 `src/` `test/` 是允许的。
section('⑦ 安装期脚本不得引用未随包发布的文件');
{
  const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
  const DEV_ONLY = ['prepublishOnly', 'prepack', 'postpack', 'prepublish',
    'build', 'verify', 'verify:docs', 'verify:all', 'verify:bridge', 'verify:e2e', 'smoke'];
  const unshippedRefs = (cmd) => [...String(cmd)
    .matchAll(/(?:^|\s)((?:scripts|src|test|docs|\.test-cache)\/[\w./-]+)/g)]
    .map((m) => m[1]).filter((p) => !publishSet(p));
  const offending = Object.entries(pkg.scripts || {})
    .filter(([name, cmd]) => unshippedRefs(cmd).length > 0 && !DEV_ONLY.includes(name));
  check('引用未随包发布文件的脚本只能是开发期脚本', offending.length === 0,
    offending.map(([n, c]) => n + ' → ' + unshippedRefs(c).join(',')).join('; ')
    || Object.keys(pkg.scripts || {}).length + ' 个脚本全部合规');
  check('负对照：安装期脚本引用 scripts/ 会被判出',
    unshippedRefs('node scripts/thing.mjs').length === 1
    && unshippedRefs('node lib/index.js').length === 0
    && unshippedRefs('node myscripts/thing.mjs').length === 0); // 近失：前缀必须落在路径边界上
  // 安装期钩子是**用户侧**会跑的：谁把它塞进 DEV_ONLY（为了让上面那条闭嘴）就等于放行"装完就炸"
  check('负对照：安装期钩子不得被 DEV_ONLY 放行',
    INSTALL_HOOKS.every((h) => !DEV_ONLY.includes(h)), INSTALL_HOOKS.join(' '));
  // `prepare` 同理：它被塞进 DEV_ONLY 就等于放行"git 直装 / 根项目安装时引用一个没随包的文件"
  check('`prepare` 不在 DEV_ONLY 里（它真的会跑，引用的文件必须随包）',
    !DEV_ONLY.includes('prepare'));
}

console.log('');
if (failed) { console.log(`PACKAGE PUBLISH CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL PACKAGE PUBLISH CHECKS PASSED');
