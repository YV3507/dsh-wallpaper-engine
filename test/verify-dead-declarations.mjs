#!/usr/bin/env node
/**
 * verify-dead-declarations.mjs — **独立脚本面**（`test/verify-*.mjs` + `test/*-smoke.mjs` +
 * `test/compat-*.mjs`）里不得有**零引用的顶层声明**（"声明孤儿"）。
 *
 * 为什么只扫这些文件：它们都是**独立脚本**（不 import 彼此的业务符号）⇒ 一个顶层声明在本文件里
 * 只出现一次，就真的没人用。反过来 `src/**` **不适用**：那里的模块被构建期内联进**同一个作用域**，
 * `client.js` 里只出现一次的名字（`trapModalTab` / `VinylRecord` / `renderConfirmRow` …）正由
 * `panel-tabs.js` / `picker-modal.js` 在用 —— 按"本文件只出现一次"判会得到 **44 处假阳性**（实测）。
 * `lib/client.js` 同理（它是生成物，名字与 `src/` 各模块成对出现）。
 * `test/tools/` 也不扫：那里的模块**导出**给守卫用，跨文件引用是正常的。
 *
 * `test/compat-*.mjs`（harness 适配层，需网络 / 真 harness / Chromium，因此**不进 `verify` 链**）
 * 同样满足"独立脚本"这个前提 ⇒ 一并纳进来。加这条面时要先复核这个前提：它们**只能**引用
 * node 内置模块或彼此 import 的导出（后者在本文件里出现 ≥2 次，不会被误判）。
 *
 * 为什么需要：**死代码不会自己变红**。实测 `test/verify-scene.mjs` 在 P2-12「静态帧线整体移除」
 * 时失去了三个 PNG/JPEG 字节解析助手的调用点（`pngInfo` / `jpegInfo` / `pngToRgba`，68 行），
 * 而它们一直留到现在 —— 它们是那批**被删断言的遗留物**，而当时没有任何判据看得见。
 * 与守卫 ① 的"文件孤儿"是同一族：① 管"没人 import 的文件"，本判据管"没人调用的声明"。
 *
 * 判据口径（与 `test/tools/audit-guard-teeth.mjs` 的判据 C 一致）：
 *   · 声明只认**代码行**上、行首的 `function NAME(` 与 `const NAME = (`；
 *   · 计数用**原文**，**不剥注释** —— 剥注释会被夹具里当字符串用的注释语法带跑（那个坑见
 *     audit-guard-teeth 判据 F：实测一个行注释里的 `scripts/**` 会吃掉 95 行真实代码，
 *     于是 `devSpecifiers` 原文 4 次、剥完只剩 1 次 ⇒ 被误判成死代码）。
 *     代价：名字只出现在注释里就算"用过"（宁可漏报，不误报）。
 *
 * Usage:  node test/verify-dead-declarations.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failed++;
};

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const DECL_RES = [
  /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
];

/** 判据：这些顶层声明在本文件里只出现一次（= 没有任何调用点）。生产扫描与正/负对照共用它。 */
function deadDeclarations(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (isComment(line)) return;
    for (const re of DECL_RES) {
      const m = re.exec(line);
      if (!m) continue;
      if ((src.match(new RegExp('\\b' + m[1] + '\\b', 'g')) || []).length === 1) out.push({ n: i + 1, name: m[1] });
    }
  });
  return out;
}

// 扫描面 = 独立脚本面（`test/tools/` 不扫：那里的模块**导出**给守卫用，跨文件引用是正常的）
const GUARDS = readdirSync(join(ROOT, 'test'), { withFileTypes: true })
  .filter((e) => e.isFile() && /^(verify-.*|.*-smoke|compat-.*)\.mjs$/.test(e.name))
  .map((e) => 'test/' + e.name)
  .sort();

// 覆盖面：判据完全可能"因为扫描面为空而恒真"（没有文件 ⇒ 没有违规）
check('覆盖面：扫到 ≥30 个独立脚本（防 walker 返回空表）', GUARDS.length >= 30, GUARDS.length + ' 个');

const offenders = [];
for (const rel of GUARDS) {
  for (const d of deadDeclarations(readFileSync(join(ROOT, rel), 'utf8'))) {
    offenders.push(rel + ':' + d.n + ' → ' + d.name);
  }
}
check('独立脚本面零引用顶层声明 == 0（死代码不会自己变红，所以要有判据看着）', offenders.length === 0,
  offenders.length ? offenders.join(' | ') : GUARDS.length + ' 个脚本干净');

// 正/负对照：把合成输入喂给**同一个判据函数**
check('negative control: 零调用点的声明会被判出',
  deadDeclarations('function neverCalled() {}\n').length === 1);
check('negative control: 声明之后没有任何引用的也判出',
  deadDeclarations('function lonely() {}\nconst x = 1;\n').length === 1);
check('positive control: 有调用点就不报（判据不是恒真）',
  deadDeclarations('function used() {}\nused();\n').length === 0);
check('positive control: 注释行上的"声明"不算声明（口径与实现一致）',
  deadDeclarations('// function ghost() {}\n').length === 0);

console.log('');
if (failed) {
  console.log('DEAD-DECLARATION CHECKS FAILED — ' + failed + ' failed');
  process.exit(1);
}
console.log('ALL DEAD-DECLARATION CHECKS PASSED');
