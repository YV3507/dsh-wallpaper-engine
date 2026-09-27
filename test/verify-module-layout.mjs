/**
 * verify-module-layout.mjs — `lib/` 与 `src/` 的分工守卫（docs/MODULE-LAYOUT.md §7 的三条缺口）。
 *
 * 三条规则各回答一个"边界画在哪"的问题，且都机器可判定：
 *
 *   ① `src/` 无孤儿 —— 除 `src/client.js`（正文，由构建脚本直接读入）外，`src/` 下每个
 *      `.js` 都必须登记进 `scripts/build-client.mjs` 的 `INLINE_MODULES`。
 *      为什么：浏览器 bundle 没有本地模块解析器，从 `src/client.js` 拆出来的模块只能由构建期
 *      按清单内联进同一个工厂作用域。**漏登记不会报错**，只是那个文件永远不进产物，
 *      调用点一多就在运行期变成 ReferenceError。清单就是唯一接线图 ⇒ 清单必须与目录一一对上。
 *      不变量：orphans == 0；登记的路径都真实存在；登记表每项都带 `file` / `why` / `markers`。
 *
 *   ② 依赖方向单向 —— `lib/` 下的运行期模块不得 import 任何解析到 `src/` 的路径。
 *      为什么：宿主半（从 `lib/index.js` 起）随包发布、由 Node 直接加载；浏览器半（`src/`）
 *      不进发布集。宿主一旦拉上 `src/`，发布包就缺文件（装上即崩），两侧也从"单向可分层"
 *      退化成互相引用。零容忍，不需要棘轮。
 *      覆盖的边形态：静态 `import … from`、副作用 `import '…'`、动态 `import(…)`、
 *      `require(…)`，外加同类的 `export … from`；判据作用在**剥掉注释后**的代码上。
 *      不变量：lib → src 的边数 == 0。
 *
 *   ③ 共享内核白名单 —— `INLINE_MODULES` 里允许不来自 `src/` 的只有 `lib/settings-schema.js`
 *      （宿主与客户端共用的设置真源）。
 *      为什么：两侧共用是**决策**，不是顺手 —— 被内联的 `lib/` 文件同时受 `src/` 的全部浏览器
 *      安全约束（无 import / 无 require / 无 process）。白名单写在下面那个数组里，再加一个
 *      共享内核必须显式改它，于是"多一个共享模块"永远会留下一次可见的改动。
 *      不变量：登记表中非 `src/` 的项 == 白名单；白名单每一项都真的在册（不许空转）。
 *
 * 每条规则都配**负对照**：把合成输入喂给**同一个判据函数**，断言它给出"坏"的裁决。
 * 只断言"今天干净"是不够的 —— 解析器一旦静默返回空表，正断言会恒绿。
 * 覆盖面断言（`src` 树 ≥13 个 `.js`、登记表 ≥10 条、`lib` ≥20 个模块且 ≥10 条依赖边）正是为此存在。
 *
 * Usage:  node test/verify-module-layout.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};

/**
 * 共享内核白名单：允许出现在 `INLINE_MODULES` 里、但**不**来自 `src/` 的文件。
 * 这是本守卫唯一需要人改的清单 —— 再加一个"两侧共用"的模块时，在这里加一条。
 */
const SHARED_KERNEL_WHITELIST = ['lib/settings-schema.js'];

/** 规则 ① 的判据：这些 `src/` 文件没有出现在登记表里（`src/client.js` 是正文，豁免）。 */
function findSrcOrphans(srcFiles, registered) {
  return srcFiles.filter((rel) => rel !== 'src/client.js' && !registered.has(rel)).sort();
}

/** 规则 ③ 的判据：登记表里不来自 `src/`、又不在白名单里的项。 */
function findUnlistedSharedKernels(registeredFiles, whitelist) {
  return registeredFiles.filter((rel) => !rel.startsWith('src/') && !whitelist.includes(rel)).sort();
}

/** 规则 ③ 的反向判据：白名单里登记表却没收的项（防白名单变成僵尸清单）。 */
function findStaleWhitelistEntries(registeredFiles, whitelist) {
  return whitelist.filter((rel) => !registeredFiles.includes(rel)).sort();
}

/**
 * 规则 ② 的边扫描：从**剥掉注释后**的代码里取出所有模块说明符及其形态。
 * 四种必须覆盖的形态（静态 / 副作用 / 动态 / require）外加同类的 export…from。
 */
const EDGE_PATTERNS = [
  { form: '静态 import…from', re: /\bimport\b[^;'"()]*?\bfrom\s*['"]([^'"]+)['"]/g },
  { form: '副作用 import', re: /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/gm },
  { form: '动态 import()', re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  { form: 'require()', re: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  { form: 'export…from', re: /\bexport\b[^;'"()]*?\bfrom\s*['"]([^'"]+)['"]/g },
];

function scanEdges(code) {
  const out = [];
  for (const { form, re } of EDGE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) out.push({ form, spec: m[1] });
  }
  return out;
}

/** 相对说明符 → 仓库根相对路径（posix）；非相对（node: / 裸包名 / 绝对路径）返回 null。 */
function resolveRelative(spec, fromRel) {
  // Windows 上 CommonJS 的 require 允许反斜杠，统一成正斜杠再解析。
  const s = spec.replace(/\\/g, '/');
  if (!s.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(fromRel), s));
}

/**
 * 规则 ② 的判据：sources = [{ rel, text }]（`lib/` 下的运行期模块），
 * 返回所有解析到 `src/` 的依赖边。
 */
function findLibToSrcEdges(sources) {
  const out = [];
  for (const { rel, text } of sources) {
    for (const { form, spec } of scanEdges(stripComments(text))) {
      const resolved = resolveRelative(spec, rel);
      if (resolved && (resolved === 'src' || resolved.startsWith('src/'))) {
        out.push({ rel, form, spec, resolved });
      }
    }
  }
  return out;
}

/** 递归列出 dir 下的文件（仓库根相对的 posix 路径，已排序）。 */
function walkFiles(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const abs = join(dir, name);
    let st = null;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkFiles(abs, out);
    else if (st.isFile()) out.push(relative(ROOT, abs).split(sep).join('/'));
  }
  return out.sort();
}

/** 判据针对**代码**：先剥注释，否则模块头里一句 `// 见 src/x.js` 会被判成一条依赖边。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 从构建脚本里解析 `INLINE_MODULES`，并顺带数出每项的 `why` / `markers` 字段。 */
function parseInlineModules(buildText) {
  const region = buildText.match(/const INLINE_MODULES = \[([\s\S]*?)\n\];/);
  if (!region) return { found: false, files: [], whys: 0, markers: 0 };
  return {
    found: true,
    files: [...region[1].matchAll(/file:\s*(['"])([^'"]+)\1/g)].map((m) => m[2]),
    whys: (region[1].match(/\bwhy:/g) || []).length,
    markers: (region[1].match(/\bmarkers:/g) || []).length,
  };
}

// ── 输入集：三份扫描结果，全部来自磁盘 ───────────────────────────────────────
const srcFiles = walkFiles(join(ROOT, 'src')).filter((rel) => rel.endsWith('.js'));
const libSources = walkFiles(join(ROOT, 'lib'))
  .filter((rel) => /\.(js|mjs|cjs)$/.test(rel))
  .map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), 'utf8') }));
const inline = parseInlineModules(readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8'));
const registeredSet = new Set(inline.files);

// ═══ ① `src/` 无孤儿 ══════════════════════════════════════════════════════════
console.log('\n① `src/` 无孤儿：除 src/client.js 外每个 .js 都在 INLINE_MODULES 里');
{
  // 覆盖面：解析器/扫描器静默返回空表时，下面的正断言会变成空对空。
  check('覆盖面：src 树扫到 ≥13 个 .js（防 walker 返回空表）', srcFiles.length >= 13,
    srcFiles.length + ' 个：' + srcFiles.join(' '));
  const srcEntries = inline.files.filter((rel) => rel.startsWith('src/'));
  check('覆盖面：INLINE_MODULES 解析出 ≥10 条登记', inline.found && inline.files.length >= 10,
    inline.found ? inline.files.length + ' 条（' + srcEntries.length + ' src + '
      + (inline.files.length - srcEntries.length) + ' lib）' : '数组区段没找到（构建脚本结构变了？）');
  check('登记表结构完整：每项都有 file / why / markers（防解析器只认到一部分项）',
    inline.found && inline.files.length === inline.whys && inline.files.length === inline.markers,
    'entries=' + inline.files.length + ' why=' + inline.whys + ' markers=' + inline.markers);
  check('负对照：解析器认得出合成登记项（不是把文件名硬编码进去）',
    JSON.stringify(parseInlineModules(
      "const INLINE_MODULES = [\n  { file: 'src/z.js', why: 'x', markers: [] },\n  { file: 'src/y.js', why: 'y', markers: [] },\n];\n"
    ).files) === JSON.stringify(['src/z.js', 'src/y.js']));

  const absent = inline.files.filter((rel) => !srcFiles.includes(rel) && !libSources.some((s) => s.rel === rel));
  check('登记的每个 file 都真实存在', absent.length === 0,
    inline.files.length + ' 条登记；缺文件=[' + absent.join(', ') + ']');

  const orphans = findSrcOrphans(srcFiles, registeredSet);
  check('除 src/client.js 外零孤儿', orphans.length === 0,
    srcFiles.length - 1 + ' 个待登记文件，孤儿=[' + orphans.join(', ') + ']');

  // 负对照 1（合成输入 → 同一个判据）：漏一个必须判孤儿，登记齐了必须放行。
  const probeSet = new Set(['src/a.js', 'src/b.js']);
  const probeFiles = ['src/client.js', 'src/a.js', 'src/b.js'];
  check('负对照：合成输入里漏登记的文件被判孤儿、登记齐时放行',
    JSON.stringify(findSrcOrphans(['src/client.js', 'src/a.js', 'src/b.js'], new Set(['src/a.js'])))
      === JSON.stringify(['src/b.js'])
    && findSrcOrphans(probeFiles, probeSet).length === 0
    && findSrcOrphans(['src/client.js'], new Set()).length === 0);

  // 负对照 2（扰动真实输入）：把真实登记集去掉一个成员，同一判据必须正好报出它 ——
  // 这条同时证明"真实输入确实流过了判据"，而不只是合成数据能过。
  const victim = inline.files.find((rel) => rel.startsWith('src/') && rel !== 'src/client.js');
  const perturbed = new Set([...registeredSet].filter((rel) => rel !== victim));
  const perturbedOrphans = findSrcOrphans(srcFiles, perturbed);
  check('负对照：真实登记集少一条时，判据精确报出那个文件', !!victim
    && srcFiles.includes(victim)
    && JSON.stringify(perturbedOrphans) === JSON.stringify([victim]),
    'victim=' + victim + ' 扰动后孤儿=[' + perturbedOrphans.join(', ') + ']');
}

// ═══ ② 依赖方向单向：lib → src 零处 ═════════════════════════════════════════
console.log('\n② 依赖方向单向：lib/ 不得 import 任何解析到 src/ 的路径');
{
  const edgeCount = libSources.reduce((n, s) => n + scanEdges(stripComments(s.text)).length, 0);
  check('覆盖面：lib 运行期模块 ≥20 个（防 walker 返回空表）', libSources.length >= 20,
    libSources.length + ' 个 .js/.mjs/.cjs');
  check('覆盖面：扫出的依赖边 ≥10 条（防解析器静默返回空表）', edgeCount >= 10, edgeCount + ' 条');
  check('覆盖面：宿主入口 lib/index.js 在扫描集里',
    libSources.some((s) => s.rel === 'lib/index.js') && libSources.some((s) => s.rel === 'lib/client.js'));

  const offenders = findLibToSrcEdges(libSources);
  check('lib/ 里零条指向 src/ 的依赖边', offenders.length === 0,
    offenders.length + ' 处 [' + offenders.map((o) => o.rel + ' -> ' + o.spec).join(', ') + ']');

  // 负对照 1（合成输入 → 同一个判据）：四种形态各造一条越界边，外加 export…from。
  const synthetic = [{
    rel: 'lib/deep/mod.js',
    text: [
      "import a from '../../src/a.js';",
      "import '../../src/b.js';",
      "const c = await import('../../src/c.js');",
      "const d = require('../../src/d.js');",
      "export { e } from '../../src/e.js';",
      "import local from './sibling.js';",
      "import fs from 'node:fs';",
      // 裸包名在**运行时拼出来**：写成字面量会被 verify-package-files 的 P5 文本扫描当成
      // 本链里真的裸依赖，把守卫链自己判红（P5 对它自己的负对照也是这么处理的）。
      "import x from '" + ['re', 'act'].join('') + "';",
      "// import ghost from '../../src/only-in-comment.js';",
      "const prose = 'see ../../src/only-in-prose.js for details';",
    ].join('\n'),
  }];
  const syntheticHits = findLibToSrcEdges(synthetic);
  check('负对照：四种形态 + export…from 各一条都被判越界',
    JSON.stringify(syntheticHits.map((h) => h.form + ':' + h.resolved)) === JSON.stringify([
      '静态 import…from:src/a.js', '副作用 import:src/b.js', '动态 import():src/c.js',
      'require():src/d.js', 'export…from:src/e.js',
    ]),
    syntheticHits.map((h) => h.form + '->' + h.resolved).join(' ') || '（一条都没抓到）');
  check('负对照：lib 内部相对 import / node: 内置 / 裸包名 / 注释与字符串里的 src 提及都不误报',
    !syntheticHits.some((h) => /sibling|only-in-comment|only-in-prose/.test(h.spec)));

  // 负对照 2（扰动真实输入）：在真实 lib 文件列表上注入一条越界边，同一判据必须报 1 处。
  const injected = findLibToSrcEdges([...libSources,
    { rel: 'lib/__control__/injected.js', text: "import { x } from '../../src/client.js';" }]);
  check('负对照：真实 lib 扫描集里注入一条到 src 的边，判据报出恰好 1 处',
    injected.length === 1 && injected[0].resolved === 'src/client.js',
    injected.map((h) => h.rel + ' -> ' + h.spec + ' => ' + h.resolved).join(' ') || '（注入的边没被报出来）');
}

// ═══ ③ 共享内核白名单 ════════════════════════════════════════════════════════
console.log('\n③ 共享内核白名单：INLINE_MODULES 里非 src/ 的项只许是 lib/settings-schema.js');
{
  const unlisted = findUnlistedSharedKernels(inline.files, SHARED_KERNEL_WHITELIST);
  const registeredNonSrc = inline.files.filter((rel) => !rel.startsWith('src/'));
  check('登记表里非 src/ 的项都在白名单里', unlisted.length === 0,
    registeredNonSrc.length + ' 项 [' + registeredNonSrc.join(', ') + ']；越界=[' + unlisted.join(', ') + ']');
  check('白名单不空转：每一项都真的在登记表里', findStaleWhitelistEntries(inline.files, SHARED_KERNEL_WHITELIST).length === 0,
    '白名单=' + SHARED_KERNEL_WHITELIST.length + ' 项；未在册=['
      + findStaleWhitelistEntries(inline.files, SHARED_KERNEL_WHITELIST).join(', ') + ']');

  // 负对照 1（合成输入 → 同一个判据）：多一个共享内核必须被判越界，在册的项与 src 项必须放行。
  check('负对照：合成登记集里多一个 lib/ 内核会被判越界，白名单内与 src 项放行',
    JSON.stringify(findUnlistedSharedKernels(
      ['src/a.js', 'lib/settings-schema.js', 'lib/another-kernel.js'], SHARED_KERNEL_WHITELIST))
      === JSON.stringify(['lib/another-kernel.js'])
    && findUnlistedSharedKernels(['src/a.js', 'lib/settings-schema.js'], SHARED_KERNEL_WHITELIST).length === 0);
  check('负对照：白名单少了在册项时，反向判据会报出来（防白名单放行一切）',
    findStaleWhitelistEntries(['src/a.js'], SHARED_KERNEL_WHITELIST).length === SHARED_KERNEL_WHITELIST.length);

  // 负对照 2（扰动真实输入）：真实登记表 + 一个假的 lib/ 内核，同一判据必须报出它。
  const injected = findUnlistedSharedKernels([...inline.files, 'lib/telemetry.js'], SHARED_KERNEL_WHITELIST);
  check('负对照：真实登记表里注入 lib/telemetry.js 会被判越界',
    JSON.stringify(injected) === JSON.stringify(['lib/telemetry.js']),
    '注入后越界=[' + injected.join(', ') + ']');
}

console.log('');
if (failed) {
  console.log('MODULE LAYOUT CHECKS FAILED — ' + failed + ' failed');
  process.exit(1);
}
console.log('ALL MODULE LAYOUT CHECKS PASSED');
process.exit(0);
