#!/usr/bin/env node
/**
 * analyze-host-apply.mjs — 宿主 `apply(ctx)` 的**拆分评估取证**（账本 §3.5 / §7 的复算工具）。
 *
 * 为什么有这个脚本：账本里"P2-11 做到哪一步、还剩几族、什么条件下继续拆"的结论必须**可复算**，
 * 否则过一段时间就只能靠印象判断。跑一次就得到三组数：
 *   ① `apply(ctx)` 的体量（行 / 分支代理 / 占 lib/index.js 比例）；
 *   ② 路由总数与**按族分布**（族内 ≥3 条 = 账本 §7 触发条件 6 的火苗）；
 *   ③ 闭包状态量（apply 自己声明的局部 = 拆分时要显式传的东西）与各路由的守卫覆盖。
 *
 * ⚠️ 路由枚举**只认 `host-route-index.mjs` 的 `buildIndex()`**：本脚本早期自己数
 * `path:` 字面量，于是同时踩了两个坑 —— 按路径去重（两条 `/diag` 折叠成一条）与丢弃参数化
 * 路径（`for (const seg of ['media','preview'])` 注册的两条全丢），报出"25 条"而索引是 31 条。
 * 度量工具与设计稿给出两个不同的路由数，比不度量更坏 —— 现在只有一处枚举。
 *
 * 用法：node test/tools/analyze-host-apply.mjs
 * 退出码恒为 0（这是度量工具，不是守卫）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './host-route-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = buildIndex();
const { routes, stateNames, applyStart, applyEnd, giants } = INDEX;

const L = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8').split('\n');
const body = L.slice(applyStart - 1, applyEnd).join('\n');
const branches = (body.match(/if\s*\(|for\s*\(|while\s*\(|case\s|catch\s*\(|&&|\|\||\?\?/g) || []).length;

// ── ① apply 的体量 ──────────────────────────────────────────────────────────
console.log('== ① apply(ctx) 体量 ==');
console.log(`   lib/index.js        ${L.length} 行`);
console.log(`   apply(ctx)          ${applyStart}-${applyEnd}（${applyEnd - applyStart + 1} 行 / 分支代理 ${branches}）`);
console.log(`   占全文件            ${((applyEnd - applyStart + 1) / L.length * 100).toFixed(0)}%`);
console.log(`   拆出去的族          ${INDEX.modules.length} 个文件`
  + (INDEX.modules.length ? '（' + INDEX.modules.map((m) => m.rel.split('/').pop() + ' ' + m.routes.length + ' 条').join(' · ') + '）' : ''));

// ── ② 路由与族分布（枚举口径 = 路由索引，单一真源）───────────────────────────
const fam = new Map();
for (const r of routes) {
  const seg = r.path === '(动态路径)' ? '(动态)' : (r.path.split('/').filter(Boolean)[0] || '/');
  if (!fam.has(seg)) fam.set(seg, []);
  fam.get(seg).push(r);
}
console.log(`\n== ② 路由 ${routes.length} 条（按首段归族；` +
  `「同一族 ≥3 条」是账本 §7 触发条件 6 的火苗）==`);
for (const [k, v] of [...fam.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const where = [...new Set(v.map((r) => r.src.split('/').pop()))].join('/');
  console.log('   ' + String(v.length).padStart(2) + ' 条  /' + k.padEnd(20)
    + ' ' + (v.length >= 3 ? '⚠ ' : '  ') + v.map((r) => r.path).join(' '));
  console.log('   ' + ' '.repeat(8) + where);
}

// ── ③ 闭包状态 ──────────────────────────────────────────────────────────────
console.log(`\n== ③ 闭包状态 ${stateNames.length} 个（拆分时要显式传的东西）==`);
console.log('   ' + stateNames.join(' '));

// 巨石：尺寸由索引按**配花括号**算出（早期用"到下一个同级声明的距离"量，把 293 行量成 1,795 行）
if (giants.some((g) => g.lines)) {
  console.log('\n   apply 内的巨石（索引按配花括号计）：');
  for (const g of giants) {
    if (!g.lines) { console.log('     ?? ' + g.name + '（没找到声明）'); continue; }
    console.log('     ' + String(g.lines).padStart(5) + ' 行  行' + g.from + '  ' + g.name
      + '  捕获 ' + g.deps.length + ' 个');
  }
}

// ── ④ 守卫覆盖（零命中 = 拆分时没有安全网）───────────────────────────────────
// 口径与索引表格**同源**（r.mentions，带尾边界）：`/media` 不会被 `/media-info` 误算成已覆盖。
console.log('\n== ④ 路由的守卫覆盖 ==');
console.log('   （口径：路由片段在守卫/冒烟源码里被**提到**的次数 —— 覆盖的代理指标，'
  + '提到不等于有断言）');
for (const r of routes) {
  console.log('   ' + r.path.padEnd(24) + String(r.mentions).padStart(3)
    + '  ' + (r.src === 'lib/index.js' ? '' : r.src.replace('lib/', '')));
}
const uncovered = routes.filter((r) => !r.mentions).map((r) => r.path);
console.log('\n   零命中（拆分前必须先补守卫）: ' + (uncovered.join(' ') || '（无）'));
if (INDEX.orphanModules.length) {
  console.log('   ⚠️ 孤儿路由模块（apply 里没有调用）: ' + INDEX.orphanModules.map((m) => m.rel).join(' '));
}
