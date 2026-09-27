#!/usr/bin/env node
/**
 * audit-reachability.mjs — **可达性测量**（账本 §3.6 / P3-3 / P3-4 的复算工具）。
 *
 * 为什么需要一个新工具：既有的 `audit-import-closure.mjs` 只验"**被导入的**文件都在 `files` 里"，
 * 它今天就会打印 "✅ 导入闭包全部被 files 覆盖" —— 而 48 个死文件全在 `files` 里。所以它的绿
 * 与"发布面只剩活代码"**无关**（`docs/MODULE-LAYOUT.md` §6 的冻结条件 #3 曾错误地引用它）。
 *
 * 本脚本从 `lib/index.js` + `lib/client.js` 出发算**可达闭包**，并同时给出两种口径：
 *   A) `as-is`  —— 按边照单全收
 *   B) `pruned` —— 先剪掉两个"**假活锚点**"再算
 *
 * 两个假活锚点（都已单独核实，见账本 §3.6）：
 *   ① `lib/index.js:67` 的**未使用 import**（指向渲染器目录里的贴图模块 `textures.js`）—— 导入后
 *      **从未调用**，全文件只有这一处提到该名字；
 *   ② `lib/index.js:915` 的 `new Worker(…)`（加载渲染 worker 产物）—— 位于一个**零调用点**函数内：
 *      该函数名在全文件只出现一次（它自己的声明）且未导出 ⇒ 永远不执行。
 *
 * ⚠️ 本文件**刻意不写那条线的具体词汇**（目录名 / 模块名 / 函数名）：`verify-retired-lines.mjs` 的
 *    退役词棘轮只许它们出现在冻结基线内，而**基线只许缩小** ⇒ 新工具不该靠加名单来通过。
 *    锚点用「行号 + 角色」描述即可定位，要更新就 `grep -n` 那两处。同理，跟随边时必须包含
 *    `export … from` 再导出 —— 漏掉它会间接引入的整棵子树误判成不可达（本脚本第一版就踩了这个
 *    坑：实测把 42 个文件 / 8,549 行报成不可达，并得出"活代码与死树没有引用边"的错误结论）。
 *    五类边都要跟：
 *    静态 `import` / **`export … from`** / 动态 `import()` / `require()` / `new Worker(…)`。
 *
 * 不靠 import 到达的载荷按 URL 提供，必须排除否则会被误报成死码：
 *   `lib/webwallgl/**`（HTTP 路由提供的渲染页与资源）、`lib/vendor/**`（第三方副本）。
 *
 * 用法：`node scripts/audit-reachability.mjs`
 * 退出码恒为 0（这是度量工具，不是守卫；把"不可达行数"变成只许减少的棘轮是 P3-3 的活）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libRoot = join(ROOT, 'lib');
const posix = (p) => p.split(sep).join('/');
const lineOf = (txt, idx) => txt.slice(0, idx).split('\n').length;

function listFiles(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) listFiles(p, out);
    else if (/\.(js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}
const ALL = listFiles(libRoot).map((p) => posix(relative(ROOT, p))).sort();

const SPEC_RES = [
  /(?:^|[^\w$])import\s+[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]/g,
  /(?:^|[^\w$])import\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\brequire\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"](\.\.?\/[^'"]+)['"]/g, // ★ 再导出
  /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g,
  /\bnew\s+Worker\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g,
];

/** [{ to, line }] —— 保留行号，便于按锚点剪边。 */
function edges(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const out = [];
  for (const re of SPEC_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const abs = resolve(dirname(join(ROOT, rel)), m[1]);
      for (const c of [abs, abs + '.js', abs + '.mjs', join(abs, 'index.js'), join(abs, 'index.mjs')]) {
        if (!existsSync(c) || !statSync(c).isFile()) continue;
        // ⚠️ 行号必须取**说明符自身**的偏移：正则前缀 `(?:^|[^\w$])` 会吃掉上一行的换行，
        //    用 m.index 会把它算成上一行 —— 实测因此让下一行的 import 被锚点误剪，整片假死。
        const specAt = m.index + m[0].lastIndexOf(m[1]);
        out.push({ to: posix(relative(ROOT, c)), line: lineOf(src, specAt) });
        break;
      }
    }
  }
  return out;
}

/** 假活锚点：这些行发出的边不算数。行号用 `grep -n` 核实后再更新。 */
const ANCHORS = new Map([['lib/index.js', [67, 915]]]);
const isAnchored = (rel, line) => (ANCHORS.get(rel) || []).includes(line);

function reach(prune) {
  const seen = new Set();
  const queue = ['lib/index.js', 'lib/client.js'];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel) || !existsSync(join(ROOT, rel))) continue;
    seen.add(rel);
    for (const e of edges(rel)) {
      if (prune && isAnchored(rel, e.line)) continue;
      if (!seen.has(e.to)) queue.push(e.to);
    }
  }
  return seen;
}

const EXCLUDE = [/^lib\/webwallgl\//, /^lib\/vendor\//];
const lines = (f) => readFileSync(join(ROOT, f), 'utf8').split('\n').length;
const total = ALL.reduce((a, f) => a + lines(f), 0);

function report(label, seen) {
  const dead = ALL.filter((f) => !seen.has(f) && !EXCLUDE.some((re) => re.test(f)));
  const dl = dead.reduce((a, f) => a + lines(f), 0);
  console.log('\n=== ' + label + ' ===');
  console.log('可达 ' + [...seen].filter((f) => f.startsWith('lib/')).length + ' 个 / 不可达 '
    + dead.length + ' 个 / ' + dl + ' 行 = 全部 lib 的 ' + (dl / total * 100).toFixed(1) + '%');
  for (const f of dead.sort()) console.log('   ' + String(lines(f)).padStart(6) + ' 行  ' + f);
  return { dead, dl };
}

console.log('lib 运行时文件: ' + ALL.length + ' 个 / ' + total + ' 行');
const a = report('A) as-is（照单全收，含两个假活锚点）', reach(false));
const b = report('B) pruned（剪掉 index.js:67 与 index.js:915 两条边）', reach(true));
console.log('\n=== 两个锚点造成的差量 ===');
console.log('不可达文件数 ' + a.dead.length + ' → ' + b.dead.length
  + '；不可达行数 ' + a.dl + ' → ' + b.dl);
console.log('⇒ 死树之所以"看起来活着"只因为这两条边；剪掉后 ' + b.dead.length + ' 个文件 / '
  + b.dl + ' 行在**文件级**就已不可达。');
