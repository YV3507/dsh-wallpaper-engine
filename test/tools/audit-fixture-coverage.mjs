#!/usr/bin/env node
/**
 * audit-fixture-coverage.mjs — **候选盲点**清单：夹具是不是把被测行为中和掉了？
 *
 * 为什么需要：`liveBootDelay` 的默认值是 3，而**所有**冒烟夹具都写成 0 ——
 * 于是"启动等待"那条路径不会被跑过，它的两个缺陷（延迟期切走不释放、挂载后不武装心跳）
 * 也就没人看得见。守卫覆盖不到的地方，只能靠**问对问题**：这个设置键在**行为夹具**
 * 里出现过哪些取值？**默认值那条分支**有人跑吗？
 *
 * 两个面刻意分开：
 *   · **行为面** = `test/*.mjs`（守卫与冒烟，不含 `test/tools/`）—— 这里的取值才算"跑过某分支"；
 *   · **数据面** = `test/fixtures/**`（如设置键对账的 golden）—— 只喂给 sanitize 对账，
 *     **不代表**那条运行时分支被跑过（区别就在这里：`3` 只在 golden 里出现时，运行时那条分支仍未被跑）。
 *
 * ⚠️ **只给候选，不下判决**，且有**三个已知局限**（都会造成假警报）：
 *   ① 取值经**变量**传入时看不见（`{ liveBootDelay: secs }`）；
 *   ② 默认值经**省略**生效时也算"没出现"（夹具不写该键 ⇒ 走默认，但工具只认字面量）；
 *   ③ 「行为面零取值」大多是"该键只在 golden 对账夹具里出现、行为由守卫直接调函数覆盖"，
 *      所以 C/D 两族只列**计数与样例**，不逐条铺开。
 *   确认是真盲点之后按仓库纪律走：**先补一条能失败的守卫，再谈改实现**。
 *
 * 自检：本工具**必须**把 `liveBootDelay` 列为 A 类 —— 抓不到就说明启发式
 * 退化了，此时退出码非零（工具宁可吵，也不要静默漏掉它唯一被验证过的那条）。
 *
 * Usage:  node test/tools/audit-fixture-coverage.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本文件在 test/tools/ 下 ⇒ 仓库根退**两层**（退一层会把根解析成 test/；`verify-module-layout` 的『相对说明符必须解析到真实文件』有断言）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { DEFAULTS } = await import(pathToFileURL(join(ROOT, 'lib', 'settings-schema.js')).href);
/** `--all`：把 C/D 两族也逐条列出（默认只给计数与样例）。 */
const ALL = process.argv.includes('--all');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) { if (name !== 'tools') walk(abs, out); continue; }
    if (/\.(mjs|js|json)$/.test(name)) out.push(abs);
  }
  return out;
}
const testDir = join(ROOT, 'test');
const behavior = walk(testDir).filter((abs) => /\.(mjs|js)$/.test(abs));
const data = walk(testDir).filter((abs) => abs.endsWith('.json'));

const LITERAL = String.raw`(?:-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|true|false|null)`;
// ⚠️ 只认**对象字面量里的属性**（前一个非空字符是 `{` 或 `,`）。更宽松的写法会把**散文**当成设置：
// `check('… scrim: ' + x)` 里的 `scrim: '` 会被匹配成一个空字符串取值（与 DEV-GUIDE §4.7 约定 3 同一条陷阱）。
const hitsOf = (text, key) => [
  ...[...text.matchAll(new RegExp(`[{,]\\s*"?${key}"?\\s*:\\s*(${LITERAL})`, 'g'))].map((m) => m[1]),
];

const surfaces = [
  { label: '行为面', files: behavior.map((abs) => ({ abs, text: readFileSync(abs, 'utf8') })) },
  { label: '数据面', files: data.map((abs) => ({ abs, text: readFileSync(abs, 'utf8') })) },
];
const rel = (abs) => abs.slice(ROOT.length + 1).split('\\').join('/');

const rows = [];
for (const [key, def] of Object.entries(DEFAULTS)) {
  const defLit = JSON.stringify(def);
  const collect = (surface) => {
    const seen = new Map();
    for (const f of surface.files) {
      for (const v of hitsOf(f.text, key)) {
        if (!seen.has(v)) seen.set(v, []);
        if (seen.get(v).length < 3) seen.get(v).push(rel(f.abs));
      }
    }
    return seen;
  };
  const inBehavior = collect(surfaces[0]);
  const inData = collect(surfaces[1]);
  // 取值按**归一化后**比较：字符串字面量在夹具里可能是 `'x'` 也可能是 `"x"`，
  // 直接拿 `JSON.stringify(默认值)` 比会产出假阳性（实测：`rotationGroupId` 空串）。
  const norm = (v) => String(v).replace(/^['"]|['"]$/g, '');
  const values = [...inBehavior.keys()].map(norm);
  let kind = null;
  if (!values.length) kind = inData.size ? 'C 只在数据面出现（行为面零取值）' : 'D 两个面都没出现';
  else if (!values.includes(norm(defLit))) kind = 'A 默认值分支可能零覆盖（行为面都是别的取值）';
  else if (new Set(values).size === 1) kind = 'B 行为面只跑过默认值（其余取值可能零覆盖）';
  if (kind) rows.push({ key, def: defLit, kind, inBehavior, inData });
}

const fmt = (m) => (m.size ? [...m].map(([v, at]) => `${v}@${at.join(',')}`).join(' | ') : '—');
console.log(`行为面 ${behavior.length} 个文件 · 数据面 ${data.length} 个文件 · 设置键 ${Object.keys(DEFAULTS).length} 个`);
console.log('');
for (const p of ['A', 'B', 'C', 'D']) {
  const group = rows.filter((r) => r.kind.startsWith(p));
  // A/B 是**可行动**的两族（行为面有取值、但默认值或其余取值没跑过）⇒ 逐条列出；
  // C/D 多为"只在 golden 里出现"的噪声 ⇒ 只给计数与样例，避免把清单淹没。
  const full = ALL || p === 'A' || p === 'B';
  console.log(`── ${p}：${group.length} 个候选 ──`);
  for (const r of (full ? group : group.slice(0, 5))) {
    console.log(`  ${r.key}（默认 ${r.def}）  行为面 ${fmt(r.inBehavior)}   数据面 ${fmt(r.inData)}`);
  }
  if (!full && group.length > 5) console.log(`  …（其余 ${group.length - 5} 个同族，见 docs/… 或直接加 --all）`);
  console.log('');
}
console.log('提示：A 最危险（P3-23 的实例在这里）；C/D 要先确认"是否有守卫直接调函数覆盖"。');

const caught = rows.some((r) => r.key === 'liveBootDelay' && r.kind.startsWith('A'));
console.log('');
console.log(caught
  ? '✓ 自检：已知实例 liveBootDelay 被列为 A 类（P3-23）'
  : '⚠️ 自检失败：已知实例 liveBootDelay 没被列为 A 类 —— 启发式退化了，先查这个工具再看清单');
if (!caught) process.exitCode = 1;
