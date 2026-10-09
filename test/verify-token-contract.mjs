#!/usr/bin/env node
/**
 * verify-token-contract.mjs — `--dsw-*` 令牌契约**不许烂掉**（共存审计 S2 的守卫）。
 *
 * 守什么：本插件把宿主设计令牌层整层改写成玻璃配方，是全仓最大的隐式耦合面
 * （DSH 官方规范让插件作者用 `--dsw-alias-*` 上色 ⇒ 按规范写的第三方 UI 插件
 * 自动继承我们的玻璃 —— 共存审计 M1）。契约由 `test/tools/token-contract.mjs`
 * 从 `src/styles.js` 现算，本守卫：
 *
 *   ① `docs/TOKEN-CONTRACT.md` 与现算契约**逐字节一致**（增删令牌忘了重算 ⇒ 红）；
 *   ② 覆盖面地板（声明 >100、令牌 >30 —— 解析器静默返回空表时 ① 变成空对空）；
 *   ③ **无门控白名单封闭**：没有门控的 `--dsw-*` 声明只允许落在两处已知语义
 *      （`body[data-we-thinking-native]` 思考块自带开关、`.we-layer` 插件自有元素）；
 *      **新增任何一条无门控改写 ⇒ 红**（这正是审计 M1 说的"看不见的耦合"的止损线）；
 *   ④ `--dsw-alias-bg-base` 必须**全部**挂壁纸门控 —— 壁纸可见性的关键前提归壁纸半边
 *      （审计 §三.3：这是玻璃/壁纸解耦能干净落地的既成事实，钉死防回退）；
 *   ⑤ 解析口径的负对照（注释掩蔽 / var() 读不计 / 跨行声明 / 归桶正确性）——
 *      每条判据都配一个"能失败"的探针，防止判据本身空转。
 *   ⑥ **门控计数自洽**：产物里每个 `标签(N)` 的 N 必须 > 0、N 之和 = 该令牌条数、
 *      组数 = 归并出的桶数。旧版工具拿声明对象比桶名字符串 ⇒ 每格恒 0，而 ① 的逐字节
 *      比对把这个 0 永久冻绿（见 §11 A1-3）。
 *
 * 红了怎么办：令牌集合的**有意**变更跑 `node test/tools/token-contract.mjs --write`
 * 重新生成契约并随代码提交；③ ④ 变红说明出现**新的无门控改写**或 bg-base 挪了门控 ——
 * 先回答"为什么这条可以不挂门控"，再改白名单（改白名单 = 一次可见的评审）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContract, scanTokenDecls, bucketOf, ungatedReason } from './tools/token-contract.mjs';
import { stripComments } from './tools/js-text.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};

console.log('\n① 契约与代码一致');
const { decls, tokens, buckets, text } = buildContract();
const doc = readFileSync(join(ROOT, 'docs', 'TOKEN-CONTRACT.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
check('docs/TOKEN-CONTRACT.md 与现算的契约一致', doc === text.trimEnd(),
  doc === text.trimEnd()
    ? decls.length + ' 条声明 / ' + tokens.length + ' 个令牌'
    : '不一致 ⇒ 跑 `node test/tools/token-contract.mjs --write`');
// 负对照：把改动后的文本喂给同一条判据，证明它能失败（同源比较的自证）
const sameAsDoc = (t) => t.trimEnd() === text.trimEnd();
const mutated = text.replace(/共 \*\*\d+\*\* 条声明/, '共 **0** 条声明');
check('负对照：契约数字被改动会被判不一致', mutated !== text && sameAsDoc(mutated) === false);
// 覆盖面地板：解析器静默返回空表时 ① 会变成空对空
check('覆盖面地板：声明 >100 且令牌 >30',
  decls.length > 100 && tokens.length > 30,
  decls.length + ' 条 / ' + tokens.length + ' 个');

console.log('\n② 无门控白名单封闭（M1 的止损线）');
{
  const strays = buckets.ungated.filter((d) => !ungatedReason(d.chain));
  check('无门控声明全部落在白名单（thinking-native / .we-layer）', strays.length === 0,
    strays.length ? strays.map((d) => 'styles.js:' + d.line + ' ' + d.token + ' @ ' + d.chain).join(' | ')
      : buckets.ungated.length + ' 条（' + new Set(buckets.ungated.map((d) => d.token)).size + ' 个令牌）');
  // 负对照 1：构造一条无门控声明 ⇒ 分类器必须把它报成白名单外（否则 ② 永远绿）
  const stray = scanTokenDecls('const CSS = `\n  body { --dsw-probe-stray: red; }\n`;\n');
  check('负对照：新增无门控声明会被判出白名单',
    stray.length === 1 && bucketOf(stray[0].chain) === 'ungated' && ungatedReason(stray[0].chain) === null,
    stray.map((d) => d.token + '@' + d.chain).join(','));
  // 负对照 2：挂在玻璃门控下的探针归玻璃桶 —— 证明 ② 不是"把所有声明都当 stray"
  const gated = scanTokenDecls('const CSS = `\n  body[data-we-glass-page] { --dsw-probe-gated: red; }\n`;\n');
  check('负对照：玻璃门控下的声明归玻璃桶（不误伤）',
    gated.length === 1 && bucketOf(gated[0].chain) === 'glass',
    gated.map((d) => d.chain).join(','));
  // 负对照 3：白名单内的探针（thinking-native）判过
  const thinking = scanTokenDecls('const CSS = `\n  body[data-we-thinking-native] [x] { --dsw-probe-think: red; }\n`;\n');
  check('负对照：thinking-native 门控在白名单内（白名单不是空的）',
    thinking.length === 1 && ungatedReason(thinking[0].chain) !== null);
}

console.log('\n③ `--dsw-alias-bg-base` 归壁纸半边（审计 §三.3 的关键前提）');
{
  const bg = decls.filter((d) => d.token === '--dsw-alias-bg-base');
  check('bg-base 声明存在且全部挂壁纸门控',
    bg.length > 0 && bg.every((d) => bucketOf(d.chain) === 'wallpaper'),
    bg.map((d) => 'styles.js:' + d.line).join(' + ') + ' → ' +
    bg.map((d) => bucketOf(d.chain)).join(' + '));
  // 负对照：bg-base 若出现在无门控下，必须被判红
  const probe = scanTokenDecls('const CSS = `\n  html { --dsw-alias-bg-base: transparent; }\n`;\n');
  check('负对照：bg-base 出现在无门控下会被判出',
    probe.length === 1 && bucketOf(probe[0].chain) === 'ungated');
}

console.log('\n④ 解析口径负对照（契约的两条根基规则）');
{
  const inComment = scanTokenDecls('const CSS = `\n  body[data-we-glass-page] { /* --dsw-in-comment: red; */ }\n`;\n');
  check('注释里的 `--dsw-…` 声明不计', inComment.length === 0, '实测 ' + inComment.length + ' 条');
  const reads = scanTokenDecls('const CSS = `\n  body { color: var(--dsw-alias-bg-base, #fff); }\n`;\n');
  check('值里的 var(--dsw-…) 是读不是写，不计', reads.length === 0, '实测 ' + reads.length + ' 条');
  const real = scanTokenDecls('const CSS = `\n  body { --dsw-probe-real: red; }\n`;\n');
  check('属性位的真实声明会抓到',
    real.length === 1 && real[0].token === '--dsw-probe-real' && real[0].value === 'red',
    real.map((d) => d.token + '=' + d.value).join(','));
  const multi = scanTokenDecls('const CSS = `\n  body {\n    --dsw-probe-multi: color-mix(in srgb,\n      red, blue);\n  }\n`;\n');
  check('跨行声明计 1 条且起始行正确',
    multi.length === 1 && typeof multi[0].line === 'number',
    '实测 ' + multi.length + ' 条 @ line ' + (multi[0] && multi[0].line));
}

console.log('\n⑤ 口径完整性：CSS 模板外不许有漏网的属性位声明');
{
  const src = readFileSync(join(ROOT, 'src', 'styles.js'), 'utf8');
  // extractCss 的前提：全文件恰好一个 `const CSS = \`` 模板。第二个模板出现时，
  // 工具只会扫第一个 ⇒ 契约静默漏掉新模板里的一切（这条钉住那个前提）。
  const count = (src.match(/const CSS = `/g) || []).length;
  check('styles.js 只有一个 CSS 模板（多模板 ⇒ 契约会静默漏扫）', count === 1, count + ' 个');
  // 模板外（JS 正文 / 字符串）再出现属性位声明，契约口径就漏了它 —— 今天必须为 0。
  const templateOutside = (s) => {
    const open = s.indexOf('const CSS = `');
    const start = open + 'const CSS = `'.length;
    let i = start;
    for (; i < s.length; i++) { if (s[i] === '\\') { i++; continue; } if (s[i] === '`') break; }
    return stripComments(s.slice(0, start) + s.slice(i));
  };
  const strays = templateOutside(src).match(/--dsw-[a-z0-9-]+/g) || [];
  check('CSS 模板外没有 `--dsw-` 提及（声明/写入都会漏出口径）',
    strays.length === 0, strays.length ? strays.slice(0, 3).join(' | ') : '0 处');
  // 负对照：把一条声明放进模板外（甚至行中形态），同一条判据必须判出（否则这条永远绿）
  const probe = templateOutside('const CSS = `body {}`;\nconst extra = `\n  body { --dsw-probe-outside: red; }\n`;');
  const pStrays = probe.match(/--dsw-[a-z0-9-]+/g) || [];
  check('负对照：模板外的 `--dsw-` 会被这条判据判出',
    pStrays.length === 1 && pStrays[0] === '--dsw-probe-outside', '实测 ' + pStrays.length + ' 处');
}

console.log('\n⑥ 门控计数自洽（A1-3：工具曾把每格算成 0，而被 ① 冻绿）');
{
  // 从**产物文本**反解每行：第二格 = 条数，第三格 = `标签(N) [+ 标签(N)]`。判据不认标签，
  // 只认括号里的数 —— 这样工具改了归并口径也不会和这条守卫串通。
  const rowsOf = (docText) => {
    const rows = new Map();
    for (const line of docText.split('\n')) {
      const m = /^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|/.exec(line);
      if (m) rows.set(m[1], { count: Number(m[2]), gates: m[3] });
    }
    return rows;
  };
  const gateProblems = (docText, tokenList) => {
    const problems = [];
    const rows = rowsOf(docText);
    for (const t of tokenList) {
      const row = rows.get(t.token);
      if (!row) { problems.push(t.token + ': 全量表里没有它'); continue; }
      if (row.count !== t.decls.length) {
        problems.push(t.token + ': 条数 ' + row.count + ' ≠ 归并出的 ' + t.decls.length);
      }
      const nums = [...row.gates.matchAll(/\((\d+)\)/g)].map((m) => Number(m[1]));
      if (nums.length !== t.buckets.size) {
        problems.push(t.token + ': 门控组数 ' + nums.length + ' ≠ 归并桶数 ' + t.buckets.size);
      }
      if (nums.some((n) => n <= 0)) problems.push(t.token + ': 出现 0 计数（' + row.gates + '）');
      const sum = nums.reduce((a, b) => a + b, 0);
      if (sum !== t.decls.length) {
        problems.push(t.token + ': 门控计数之和 ' + sum + ' ≠ 条数 ' + t.decls.length);
      }
    }
    return problems;
  };
  const problems = gateProblems(text, tokens);
  check('产物里每格门控计数 > 0、之和 = 条数、组数 = 桶数', problems.length === 0,
    problems.length ? problems.slice(0, 3).join(' | ') : tokens.length + ' 个令牌全部自洽');
  // 负对照：把某一格改成 0 —— 同一条判据必须判出（否则它只是"恒真的空转"）
  const nonzero = text.match(/\(([1-9]\d*)\)/);
  const doctored = nonzero ? text.replace(nonzero[0], '(0)') : text;
  check('负对照：某一格计数被改成 0 会被判出自洽性失败',
    nonzero !== null && gateProblems(doctored, tokens).length > 0,
    nonzero ? '探针 ' + nonzero[0] + ' → 判出 ' + gateProblems(doctored, tokens).length + ' 处' : '产物里找不到非零计数');
}

console.log('');
if (failed) { console.log(`TOKEN CONTRACT CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL TOKEN CONTRACT CHECKS PASSED');
process.exit(0);
