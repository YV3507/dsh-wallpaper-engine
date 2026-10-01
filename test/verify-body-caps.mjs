#!/usr/bin/env node
/**
 * verify-body-caps.mjs — 「**收 body 的路由必须有上限**」的结构守卫。
 *
 * ── 为什么需要它（这条判据的来历）────────────────────────────────────────────
 * 宿主侧有若干条 POST/PUT 路由把请求体收进内存。**没有上限**时，异常大的请求体让宿主堆无界
 * 增长（OOM / 进程死亡）；而上限**不会**因为"同族其它的路都有"就自动出现 —— 它靠人记得抄。
 * 本仓实测过一次完整的因果链：
 *   ① 一次只读审计发现三条路由没有上限，并明确记下判据缺口 ——「没有任何守卫要求'收 body 的
 *      路由必须有上限'；同族已有的闸全靠人记得抄」；
 *   ② 之后新增的一条路由（`/media-control`）**又忘了抄**，于是缺口从三条变成四条。
 * 同一条链上还有第二个静默缺陷：逐块 `body += chunk` 再逐块 `toString()`，会把落在两个 TCP
 * 分片之间的多字节码点切成 U+FFFD，而用户可见字符串（壁纸 id / 字体名 / 字体族）被写坏了
 * 客户端永远不知道。正确形态是**边收边计字节、收完只解码一次**。
 *
 * ⇒ 所以这条判据**从磁盘枚举**每一个 `req.on('data')` 站点，而不是维护一份"该有闸的路由名单"：
 * 名单会漂，枚举不会。新增路由只要写了 `req.on('data')` 就自动进面。
 *
 * ── 判据形态（为什么是它）──────────────────────────────────────────────────
 * `req.on('data', cb)` 的 `cb` 分两类：
 *   · **收集器**（collector）：内联函数字面量，闭包一个累加变量。**必须**在回调**体内**出现
 *     一次字节/长度比较（`size > CONTROL_JSON_MAX_BYTES`、`body.length > SETTINGS_MAX_BYTES`、
 *     `size > 4 * 1024 * 1024` …）。
 *   · **非收集器**（non-collector）：回调是**裸标识符**（本仓唯一实例是 `req.on('data', arm)`，
 *     `armBodyIdleTimeout` 里那个只顾重置 idle 计时器的函数）。它不闭包累加器 ⇒ 没有"上限"
 *     可言。这条豁免是**结构性**的（裸标识符 vs 内联闭包），不是一份名字白名单 ——
 *     收集器必须内联才能闭包累加变量，所以这个区分不会漏掉任何真实的收集器。
 *
 * ── 判据必须有牙（正/负对照喂**同一个**判据函数）──────────────────────────────
 * 只断言"今天干净"不够：解析器一旦静默返回空表，正断言会恒绿。因此下面成对断言：
 *   · 覆盖面地板（站点数 ≥ 8）—— 空表/解析退化 ⇒ 当场红；
 *   · 负对照：无上限的内联回调必须被判**不合格**；
 *   · 负对照：上限写在回调**外面**（同一文件别处有一句 `size > 1024`）必须**仍然**判不合格
 *     —— 这条钉的是"判据作用域 = 回调体内"，防止判据退化成全文件扫描；
 *   · 负对照：`findBodyReadSites` 对合成源码认出站点（抽取器本身可判非空）。
 *
 * 剥注释用共享的**字符串感知**实现（`tools/js-text.mjs`）：朴素正则会被注释/字符串里的块注释
 * 起始带跑，一路吃掉真实代码 ⇒ 判据静默失效（本仓规则 ⑦ 就是钉这件事的）。
 *
 * Usage:  node test/verify-body-caps.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './tools/js-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');

/** 扫描面排除：vendored 第三方（不归我们维护）与本半边的生成物。 */
const EXCLUDE_DIRS = new Set(['vendor', 'webwallgl']);
const EXCLUDE_FILES = new Set(['client.js']);

/**
 * 上限判据：一次把"字节/长度计数器"与某个限值/常量比大小的比较。
 * 认这些左值：`.length` / `size` / `bytes` / `len` / `count`（本仓既有的闸都用其中之一）。
 */
const CAP_RE = /(?:\.length|\bsize\b|\bbytes\b|\blen\b|\bcount\b)\s*>\s*(?:[A-Za-z_$][\w$]*|\d)/;

/** `req.on('data'` / `req.once('data'` —— 两种写法都算收 body 的站点。 */
const SITE_RE = /req\.(?:on|once)\(\s*['"]data['"]\s*,\s*/g;

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(p, out);
    } else if (entry.name.endsWith('.js') && !EXCLUDE_FILES.has(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 1-based 行号：`index` 是**剥注释后**文本里的偏移（等长替换 ⇒ 与原文一致）。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * 引号感知的花括号配对：从 `open`（必须是 `{`）开始找配对的 `}`。
 * 字符串/模板里的花括号不计数（剥注释保留了字符串，所以这里必须自己跳过它们）。
 * 找不到配对返回 -1（调用方按"判据不可判定"处理，宁可红）。
 */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 判据核心：抽出源码里每一个 `req.on('data', …)` 站点。
 * 返回 [{ line, kind, callback }]，kind ∈ {'collector','non-collector'}。
 * 合成源码与真实源码走**同一个**函数（负对照因此证明的是同一条判据）。
 */
function findBodyReadSites(src) {
  const sites = [];
  SITE_RE.lastIndex = 0;
  let m;
  while ((m = SITE_RE.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const line = lineAt(src, m.index);
    const rest = src.slice(start);
    // 非收集器：回调是裸标识符，形如 `arm)`（本仓唯一实例见文件头）。
    const bare = /^([A-Za-z_$][\w$]*)\s*\)/.exec(rest);
    if (bare) {
      sites.push({ line, kind: 'non-collector', name: bare[1], callback: '' });
      continue;
    }
    // 收集器：内联箭头/函数字面量 —— 取到回调体的配对 `}`。
    const braceIdx = src.indexOf('{', start);
    if (braceIdx === -1) {
      sites.push({ line, kind: 'unparsable', callback: '' });
      continue;
    }
    const end = matchBrace(src, braceIdx);
    if (end === -1) {
      sites.push({ line, kind: 'unparsable', callback: '' });
      continue;
    }
    sites.push({ line, kind: 'collector', callback: src.slice(braceIdx, end + 1) });
  }
  return sites;
}

/** 一条判据：收集器必须在**回调体内**出现上限比较。 */
const hasCap = (callback) => CAP_RE.test(callback);

// ── ① 判据自身的正/负对照（先证明它有牙，再看真实代码）──────────────────────
check('负对照：无上限的内联回调被判不合格',
  hasCap('{ body += c; }') === false, 'snippet={ body += c; }');
check('正对照：字节计上限被判合格',
  hasCap('{ size += c.length; if (size > CONTROL_JSON_MAX_BYTES) { return; } chunks.push(c); }') === true,
  'snippet=size > CONTROL_JSON_MAX_BYTES');
check('正对照：`.length` 形式的闸也被认',
  hasCap('{ body += c; if (body.length > SETTINGS_MAX_BYTES) fail(413); }') === true);

// ── ② 抽取器的正/负对照 ─────────────────────────────────────────────────────
{
  const synth = "req.on('data', (c) => { body += c; });\n"
    + "req.on('data', (c) => { size += c.length; if (size > 1024) return; chunks.push(c); });\n"
    + "req.on('data', arm);\n";
  const found = findBodyReadSites(synth);
  check('负对照：抽取器认出内联收集器', found.filter((s) => s.kind === 'collector').length === 2,
    'collectors=' + found.filter((s) => s.kind === 'collector').length);
  check('负对照：裸标识符回调归为非收集器（豁免是结构性的）',
    found.some((s) => s.kind === 'non-collector' && s.name === 'arm'));
  check('负对照：抽取器对合成源码能判出上限的有无',
    hasCap(found[0].callback) === false && hasCap(found[1].callback) === true);
  check('负对照：抽取器返回空表时判据会失败（覆盖面地板有牙）',
    findBodyReadSites('const x = 1;').length === 0);
}

// ── ②b 判据作用域：上限必须在**回调体内**，不是"同一文件里出现过比较" ─────────
// 这条是必须的：判据若退化成"全文件搜一次大小比较"，任何文件只要别处有一句 `size > N`
// 就会把无上限的收集器一起放过 —— 那正是本仓最不想要的静默通过形态。
{
  const outside = "req.on('data', (c) => { body += c; });\nconst limit = size > 1024;\n";
  const found = findBodyReadSites(outside);
  check('负对照：上限在回调**外** ⇒ 该站点仍判不合格（作用域 = 回调体内）',
    found.length === 1 && found[0].kind === 'collector'
      && hasCap(found[0].callback) === false && CAP_RE.test(outside) === true,
    '文件级有比较、回调级没有');
}

// ── ③ 真实代码：从磁盘枚举 ─────────────────────────────────────────────────
const files = walk(LIB).sort();
const sites = [];
for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const site of findBodyReadSites(text)) {
    sites.push({ ...site, file: relative(ROOT, file).split('\\').join('/') });
  }
}

const collectors = sites.filter((s) => s.kind === 'collector');
const uncapped = collectors.filter((s) => !hasCap(s.callback));
const unparsable = sites.filter((s) => s.kind === 'unparsable');

console.log(`\n  扫描面：lib/**/*.js（排除 ${[...EXCLUDE_DIRS].join(' / ')} 与 ${[...EXCLUDE_FILES].join(' / ')}）`
  + ` —— ${files.length} 个文件`);
console.log(`  收 body 站点：${sites.length}（收集器 ${collectors.length} · 非收集器 ${sites.length - collectors.length - unparsable.length}）`);
for (const s of collectors) {
  console.log(`    ${hasCap(s.callback) ? '✓' : '✗'} ${s.file}:${s.line}`);
}
console.log('');

// 覆盖面地板：解析器静默返回空表 / 站点被改名 ⇒ 当场红，而不是"全绿通过"。
check('覆盖面：收集器站点数 ≥ 8（空表或解析退化即失败）', collectors.length >= 8,
  `实测 ${collectors.length}`);
check('判据可判定：没有配对失败的站点（宁可红，不可静默跳过）', unparsable.length === 0,
  unparsable.map((s) => `${s.file}:${s.line}`).join(', ') || '无');
check('每一个收 body 的站点都有上限', uncapped.length === 0,
  uncapped.map((s) => `${s.file}:${s.line}`).join(', ') || '全部有闸');

console.log('');
if (failed) {
  console.log(`BODY-CAP CHECKS FAILED — ${failed} 条不合格`);
  console.log('修法：按 lib/routes/upload.js 文件头的两条不变量改 —— 边收边计字节（size += chunk.length）、'
    + '超限即 413 早退、收完只 Buffer.concat(...).toString("utf8") 解码一次。');
  process.exit(1);
}
console.log('BODY-CAP CHECKS PASSED');
