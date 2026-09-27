#!/usr/bin/env node
/**
 * host-route-index.mjs — 生成/核对**宿主路由索引**（P2-11 的前置 1，账本 §3.5）。
 *
 * 为什么要它：`apply(ctx)` 里 29 条 `webServer.register` 挤在同一个闭包里，"这条路由依赖
 * 哪些闭包状态"只能靠读代码。这份索引把三件事机械地列出来：
 *   ① 路由 → 行号 → 处理器形态（箭头/函数、是否 async）；
 *   ② 该处理器的块里**引用了哪些 apply 作用域的状态**（= 将来 context 对象的字段候选）；
 *   ③ 哪条路由在守卫/冒烟里被提到过（提到 ≠ 有断言，但零提及 = 拆分时没有安全网）。
 *
 * 用法：
 *   node scripts/host-route-index.mjs            # 打印索引（守卫用它比对）
 *   node scripts/host-route-index.mjs --write    # 写入 docs/ROUTE-INDEX.md
 *   node scripts/host-route-index.mjs --deps     # 额外打印四个巨石的闭包状态清单（前置 3）
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 剥掉一行里的字符串/注释（行内粒度，够用于"找声明/配对花括号"）。 */
const stripLine = (l) => l
  .replace(/\/\*.*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/, '$1 ')
  .replace(/`[^`]*`/g, '``')
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''");

export function buildIndex() {
const raw = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const L = raw.split('\n');

// 剥字符串/注释（保住换行，否则行号错位）
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .split('\n');
const braceEnd = (from) => {
  let d = 0;
  for (let i = from; i <= L.length; i++) {
    for (const c of stripped[i - 1] || '') { if (c === '{') d++; else if (c === '}') d--; }
    if (d <= 0 && i >= from) return i;
  }
  return L.length;
};

// apply 的作用域：缩进 ≤2 的声明（与 analyze-host-apply.mjs 同口径）
let applyStart = -1;
for (let i = 0; i < L.length; i++) if (/^(export\s+)?(async\s+)?function apply\s*\(/.test(L[i])) { applyStart = i + 1; break; }
const applyEnd = braceEnd(applyStart);
const declRe = /^(\s*)(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const stateNames = [];
for (let i = applyStart + 1; i <= applyEnd; i++) {
  const m = declRe.exec(L[i - 1]);
  if (m && m[1].length <= 2) stateNames.push(m[2]);
}

// 每条路由：从 `webServer.register({` 到其闭合
const routes = [];
L.forEach((l, i) => {
  if (!/webServer\.register\(\{/.test(l)) return;
  const start = i + 1;
  const end = braceEnd(start);
  const block = L.slice(start - 1, end).join('\n');
  const pm = /path:\s*['"`]((?:\$\{BASE\})?\/[^'"`]*)['"`]/.exec(block);
  // 动态路径（含 BASE 之外的插值）也要**出现在索引里** —— 否则"索引覆盖全部 register"这条
  // 断言会因为少一条而红，而真正该记的是"这一条是参数化的"。实测踩到过（30 登记 vs 29 索引）。
  const dynamic = !pm || /\$\{(?!BASE\})/.test(pm[1]);
  const path = dynamic ? '(动态路径)' : pm[1].replace(/^\$\{BASE\}/, '');
  const hm = /handler:\s*(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|handler:\s*(async\s*)?function/.exec(block);
  const deps = [...new Set(stateNames.filter((n) => new RegExp('(^|[^.\\w$])' + n + '\\b').test(block)))];
  routes.push({
    path, line: start, end, dynamic,
    kind: (hm && hm[1]) ? 'async 箭头' : '箭头', deps,
  });
});

// 守卫覆盖（口径：路由片段在守卫/冒烟源码里被提到）
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.mjs$/.test(n) && !/host-route-index|analyze-host-apply/.test(n)) out.push(abs);
  }
  return out;
};
const guardTexts = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'test'))]
  .map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')]);

const md = [];
md.push('# 宿主路由索引（P2-11 前置 1 · 自动生成，勿手改）');
md.push('');
md.push('> 生成：`node scripts/host-route-index.mjs --write`；核对：`node scripts/verify-route-index.mjs`');
md.push('> （守卫会在索引与代码不一致时失败 —— 索引因此不会烂掉）。');
md.push('>');
md.push('> `闭包状态` = 该处理器的块里引用到的 `apply` 作用域声明（缩进 ≤2）= **将来 context 对象的字段候选**；');
md.push('> 同一列里反复出现的名字，就是该提出来的字段。');
md.push('');
md.push(`共 **${routes.length}** 条路由。`);
md.push('');
md.push('| # | 路径 | 行 | 形态 | 闭包状态（引用了哪些） | 守卫提及 |');
md.push('|---|---|---|---|---|---|');
routes.forEach((r, i) => {
  const hits = guardTexts.filter(([, t]) => t.includes(r.path)).length;
  const deps = r.deps.length > 6 ? r.deps.slice(0, 6).join(' ') + ` …(+${r.deps.length - 6})` : r.deps.join(' ');
  md.push(`| ${i + 1} | \`${r.path}\` | ${r.line} | ${r.kind} | ${deps || '—'} | ${hits || '**0**'} |`);
});
md.push('');
const uncovered = routes.filter((r) => guardTexts.every(([, t]) => !t.includes(r.path)));
md.push(`**零提及（拆分前必须先补守卫）**：${uncovered.length ? uncovered.map((r) => '`' + r.path + '`').join('、') : '（无）'}`);
md.push('');
// 出现最多的闭包状态 = context 字段的优先级
const freq = new Map();
for (const r of routes) for (const d of r.deps) freq.set(d, (freq.get(d) || 0) + 1);
md.push('**被最多路由引用的闭包状态（context 字段优先级）**：');
md.push('');
md.push([...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, n]) => '`' + k + '`×' + n).join(' · '));
md.push('');
const text = md.join('\n');
// ── 前置 3：四大巨石的闭包状态清单 ──────────────────────────────────────────
// ⚠️ 必须在**整份剥好的源码**（stripped）里找声明与配花括号：逐行剥字符串会把跨行模板
//    字面量里的花括号算进深度，巨石会被切成几十行（实测 ensureMediaOrigin 被切成 42 行）。
const GIANTS = ['ensureMediaOrigin', 'serveFile', 'buildInventory', 'handleSceneFiles'];
const giants = GIANTS.map((g) => {
  let at = -1;
  for (let i = applyStart + 1; i <= applyEnd; i++) {
    const s = stripped[i - 1] || '';
    // 函数声明形态与"常量 + 箭头/函数表达式"形态都要认
    if (new RegExp('(^|\\s)(?:async\\s+)?function\\s+' + g + '\\s*\\(').test(s)
      || new RegExp('(^|\\s)(?:const|let|var)\\s+' + g + '\\s*=').test(s)) { at = i; break; }
  }
  if (at < 0) return { name: g, from: 0, to: 0, lines: 0, deps: [] };
  const end = braceEnd(at);
  const body = stripped.slice(at - 1, end).join('\n');
  const deps = stateNames.filter((n) => n !== g && new RegExp('(^|[^.\\w$])' + n + '\\b').test(body));
  return { name: g, from: at, to: end, lines: end - at + 1, deps };
});
return { text, routes, stateNames, applyStart, applyEnd, giants };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { text, routes, giants } = buildIndex();
  if (process.argv.includes('--deps')) {
    console.log('\n== 四个巨石的闭包状态清单（前置 3）==');
    for (const g of giants) {
      if (!g.lines) { console.log('  ?? ' + g.name + '（没找到声明）'); continue; }
      console.log(`  ${g.name}  ${g.from}-${g.to}（${g.lines} 行）捕获 ${g.deps.length} 个: ${g.deps.join(' ')}`);
    }
  } else if (process.argv.includes('--write')) {
    writeFileSync(join(ROOT, 'docs', 'ROUTE-INDEX.md'), text + '\n');
    console.log('已写入 docs/ROUTE-INDEX.md（' + routes.length + ' 条路由）');
  } else {
    process.stdout.write(text + '\n');
  }
}
