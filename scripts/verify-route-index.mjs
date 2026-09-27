#!/usr/bin/env node
/**
 * verify-route-index.mjs — **路由索引不许烂掉**（P2-11 前置 1 的守卫）。
 *
 * 账本 §3.5 把"路由索引"列为 P2-11 的前置 1：它既是导航表，也是将来 context 对象的**设计稿**。
 * 但手写索引一定会烂 —— 所以索引由 `scripts/host-route-index.mjs` 生成，本守卫**重算并逐字节比对**
 * `docs/ROUTE-INDEX.md`：路由增删、路径改名、处理器换了形态而忘了重新生成，这里都会红。
 *
 * 三条断言 + 两条负对照：
 *   ① 索引文件与"从 lib/index.js 现算的索引"一致；
 *   ② 索引覆盖了**全部** `webServer.register`（不漏一条，也没有多出来的幽灵路由）；
 *   ③ 覆盖面：路由条数 > 20（防解析器静默返回空表 ⇒ ① 变成空对空）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from './host-route-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};

console.log('\n① 路由索引与代码一致');
const { text, routes } = buildIndex();
const file = readFileSync(join(ROOT, 'docs', 'ROUTE-INDEX.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
check('docs/ROUTE-INDEX.md 与 lib/index.js 现算的索引一致', file === text.trimEnd(),
  file === text.trimEnd() ? routes.length + ' 条路由' : '不一致 ⇒ 跑 `node scripts/host-route-index.mjs --write`');
// 覆盖面：解析器若静默返回空表，上面那条会变成空对空
check('负对照：解析器确实抓到了路由（>20 条）', routes.length > 20, routes.length + ' 条');
const host = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const registrations = (host.match(/webServer\.register\(\{/g) || []).length;
check('索引覆盖全部 webServer.register（不漏也不多）', registrations === routes.length,
  `登记 ${registrations} / 索引 ${routes.length}`);
// 负对照：改一个路径必须被抓到
const mutated = text.replace(/(\| `\/inventory` \|)/, '| `/inventory-typo` |');
check('负对照：索引里的路径被改动会被判不一致', mutated !== text);
check('索引里列了"零提及"的路由（拆分前必须先补守卫）', /零提及/.test(text));

console.log('');
if (failed) { console.log(`ROUTE INDEX CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL ROUTE INDEX CHECKS PASSED');
