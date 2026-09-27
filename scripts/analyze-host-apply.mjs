#!/usr/bin/env node
/**
 * analyze-host-apply.mjs — 宿主 `apply(ctx)` 的**拆分评估取证**（账本 §3.5 / §7 的复算工具）。
 *
 * 为什么有这个脚本：账本里"P2-11 现在不做、什么条件下做"的结论必须**可复算**，
 * 否则过一段时间就只能靠印象判断"是不是该拆了"。跑一次就得到三组数：
 *   ① `apply(ctx)` 的体量（行 / 分支代理 / 占 lib/index.js 比例）与它内部的巨石函数；
 *   ② 闭包状态量（apply 自己声明的局部：拆分时要显式传的东西）；
 *   ③ 30 条路由各自的**守卫覆盖**（零命中的路由 = 拆分时没有安全网）。
 *
 * 用法：node scripts/analyze-host-apply.mjs
 * 退出码恒为 0（这是度量工具，不是守卫）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const L = raw.split('\n');

// 剥字符串/注释做结构度量（块注释替换保住换行，否则行号错位）
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .split('\n');

// ── ① apply 的边界与体量 ────────────────────────────────────────────────────
let start = -1;
for (let i = 0; i < L.length; i++) {
  if (/^(export\s+)?(async\s+)?function apply\s*\(/.test(L[i])) { start = i + 1; break; }
}
if (start < 0) { console.error('找不到 apply(ctx)；宿主结构变了，请更新本脚本'); process.exit(0); }
let depth = 0; let end = start;
for (let i = start; i <= L.length; i++) {
  for (const ch of stripped[i - 1] || '') { if (ch === '{') depth++; else if (ch === '}') depth--; }
  if (depth <= 0) { end = i; break; }
}
const body = L.slice(start - 1, end).join('\n');
const branches = (body.match(/if\s*\(|for\s*\(|while\s*\(|case\s|catch\s*\(|&&|\|\||\?\?/g) || []).length;

console.log('== ① apply(ctx) 体量 ==');
console.log(`   lib/index.js        ${L.length} 行`);
console.log(`   apply(ctx)          ${start}-${end}（${end - start + 1} 行 / 分支代理 ${branches}）`);
console.log(`   占全文件            ${((end - start + 1) / L.length * 100).toFixed(0)}%`);

// ── ② 路由与闭包状态 ────────────────────────────────────────────────────────
const routes = [];
L.forEach((l, i) => {
  // 宿主写成 `path: \`${BASE}/inventory\``（模板字面量）；只过滤掉**除 BASE 之外**还带
  // 插值的动态路由（那些是参数化路径，不参与"一族几个"的统计）。
  const m = /(?:route|register)\(\s*['"`]((?:\$\{BASE\})?\/[^'"`]*)['"`]|path:\s*['"`]((?:\$\{BASE\})?\/[^'"`]*)['"`]/.exec(l);
  if (!m) return;
  const p = m[1] || m[2];
  if (/\$\{(?!BASE\})/.test(p)) return;
  routes.push({ at: i + 1, p });
});
const seen = new Set();
const uniq = routes.filter((r) => (seen.has(r.p) ? false : (seen.add(r.p), true)));
routes.length = 0;
routes.push(...uniq);
const fam = new Map();
for (const r of routes) {
  const seg = r.p.replace(/^\$\{BASE\}/, '').split('/').filter(Boolean)[0] || '/';
  if (!fam.has(seg)) fam.set(seg, []);
  fam.get(seg).push(r);
}
console.log(`\n== ② 路由 ${routes.length} 条（按首段归族）==`);
for (const [k, v] of [...fam.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log('   ' + String(v.length).padStart(2) + ' 条  /' + k.padEnd(20) + ' 行 ' + v.map((r) => r.at).join(', '));
}

const declRe = /^(\s*)(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const locals = [], nested = [];
for (let i = start; i <= end; i++) {
  const m = declRe.exec(L[i - 1]);
  if (!m) continue;
  if (m[1].length <= 2) locals.push(m[2]);
  else if (/function/.test(L[i - 1])) nested.push({ name: m[2], at: i, indent: m[1].length });
}
console.log(`\n== ③ 闭包状态 ${locals.length} 个（拆分时要显式传的东西）==`);
console.log('   ' + locals.join(' '));
const big = nested.map((n) => {
  const next = nested.slice(nested.indexOf(n) + 1).find((x) => x.indent <= n.indent);
  return { ...n, size: (next ? next.at : end + 1) - n.at };
}).filter((n) => n.size >= 60).sort((a, b) => b.size - a.size);
if (big.length) {
  console.log('\n   apply 内 ≥60 行的嵌套函数：');
  for (const n of big) console.log('     ' + String(n.size).padStart(5) + ' 行  行' + n.at + '  ' + n.name);
}

// ── ④ 守卫覆盖（零命中 = 拆分时没有安全网）───────────────────────────────────
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.mjs$/.test(n)) out.push(abs);
  }
  return out;
};
const guards = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'test'))]
  .filter((f) => !f.endsWith('analyze-host-apply.mjs'));
const texts = guards.map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);
const uncovered = [];
console.log('\n== ④ 路由的守卫覆盖 ==');
console.log('   （口径：路由片段在守卫/冒烟源码里被**提到**的次数 —— 是覆盖的代理指标，'
  + '提到不等于有断言）');
for (const r of routes.map((x) => x.p)) {
  const needle = r.replace(/^\$\{BASE\}/, '');
  const hits = texts.filter(([, t]) => t.includes(needle));
  if (hits.length === 0) uncovered.push(needle);
  console.log('   ' + needle.padEnd(24) + String(hits.length).padStart(3) + '  ' + hits.slice(0, 2).map(([f]) => f.split(/[\\/]/).pop()).join(', '));
}
console.log('\n   零命中（拆分前必须先补守卫）: ' + (uncovered.join(' ') || '（无）'));
