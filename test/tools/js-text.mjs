#!/usr/bin/env node
/**
 * js-text.mjs — JS/TS 源码的**文本级**工具（守卫读源码时用）。
 *
 * 目前只有一个入口：`stripComments(src)` —— 把注释替换成**等长空格**（换行原样保留）。
 *
 * ── 为什么不许用朴素正则 ─────────────────────────────────────────────────────
 * 朴素写法（块注释正则 + 行注释正则，本仓此前在 16 处各抄了一份）**不认字符串与行注释**：
 * 只要注释或字符串里出现"块注释起始"那两个字符（把 `scripts/**`、`test/**`、`docs/*.md`
 * 写进一句行注释就够了），它就会从那里**开一个块注释**，一路吃到下一个结束标记 ——
 * 把中间的真实代码**静默删掉**。实测（`test/tools/audit-guard-teeth.mjs` 判据 F）：
 *   · `test/verify-module-layout.mjs` 被吃掉 **L343→L437（95 行）**；
 *   · `test/verify-scene-live.mjs` 被吃掉 **L829→L1159（331 行）**；
 *   · 全仓 9 个文件共 12 处。
 * 那些判据因此**看不见**这段代码，却照样报绿 —— 静默失效，正是本仓最不想要的失败形态。
 *
 * ── 这个实现的性质 ───────────────────────────────────────────────────────────
 *   · **字符串感知**：`'…'` / `"…"` / 模板字面量里的 `//`、`/*` 都不算注释（`https://x` 因此
 *     不再被当成注释；模板里的 `/*` 也不再开块注释）。
 *   · **等长 + 保留换行**：删掉的注释按字符数换成空格、换行原样留 ⇒ 行号与列偏移不变
 *     （按列定位的消费者，如 `test/tools/host-route-index.mjs`，依赖这一点）。
 *   · **正则字面量按启发式识别**：上一个有意义字符是运算符/分隔符（`=` `(` `,` `:` `[` `!` `&` `|`
 *     `?` `{` `}` `;` `+` `-` `*` `%` `<` `>` `~` `^`）时，`/` 视为正则字面量的开始，整段跳到收尾的
 *     `/`（认 `\` 转义与 `[…]` 字符类）。**这一步必需**：正则里可以出现 `\/\/`、`[/*]` 这类内容，
 *     不跳过就会被当成注释吃掉 —— 实测以 `\//` 收尾的正则会让**该行后半段静默变成空格**
 *     （本仓 4 个文件里都有这种写法）。
 *     边界：`return /re/` 这类"上一个字符是字母"的位置按除号处理 ⇒ 代价只是**不跳**该正则（最多
 *     一行内少剥），不会多吃；正则若在行内未闭合则收手，**绝不跨行吞**。
 *   · **模板的 `${…}` 内部不另做词法**：整段按字符串处理 ⇒ 插值里的注释不会被剥掉。
 *     方向是安全的（宁可少剥，不可多吃）：少剥最多让某条判据**变红**（响亮），多吃是静默失效。
 *
 * ── 为什么不给 CSS 用 ───────────────────────────────────────────────────────
 * CSS 的注释语法只有块注释一种（没有 `//`），且 `url(...)`、转义与字符串规则与 JS 不同 ⇒
 * 套 JS 词法会误删 `url(//host/x)` 这类内容。CSS 侧继续用自己的、只剥块注释的实现。
 *
 * 自检：`node test/tools/js-text.mjs selftest`（正/负对照成对，含"朴素实现会吃掉真代码"的
 * **反面参照** ⇒ 修法与缺陷在同一处对照）。
 */
import { pathToFileURL } from 'node:url';

const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

/**
 * 把 JS 源码里的注释替换成等长空格（换行保留）。
 * 字符串与模板字面量里的注释标记**不**算注释。
 */
function stripComments(src) {
  const text = String(src);
  const n = text.length;
  const out = [];
  /** 注释字符 → 空格；换行原样保留（保证行号/列偏移不变）。 */
  const blank = (ch) => out.push(ch === '\n' ? '\n' : ' ');
  /** 上一个**有意义**字符（注释与空白之外）—— 用来粗判 `/` 是除号还是正则字面量的开始。 */
  let prev = '';
  const isValueEnd = (ch) => ch !== '' && /[\w$)\]}'"`]/.test(ch);
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    // 行注释：// … 到行尾（`//` 在 JS 里总是注释，先判它，避免与正则字面量混淆）
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') { blank(text[i]); i++; }
      continue;
    }
    // 块注释：到下一个结束标记
    if (c === '/' && c2 === '*') {
      blank(c); blank(c2); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(text[i]); i++; }
      if (i < n) { blank(text[i]); blank(text[i + 1]); i += 2; }
      continue;
    }
    // 字符串 / 模板字面量：整段原样保留（内部不认注释）
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out.push(c); i++;
      while (i < n) {
        const d = text[i];
        if (d === '\\') { out.push(d); if (i + 1 < n) out.push(text[i + 1]); i += 2; continue; }
        out.push(d); i++;
        if (d === quote) break;
      }
      prev = quote;
      continue;
    }
    // 正则字面量：整段原样跳过（`\` 转义、`[…]` 字符类都认；行内未闭合就收手，绝不跨行）
    if (c === '/' && !isValueEnd(prev)) {
      out.push(c); i++;
      let inClass = false;
      while (i < n) {
        const d = text[i];
        if (d === '\\') { out.push(d); if (i + 1 < n) out.push(text[i + 1]); i += 2; continue; }
        if (d === '\n') break;
        out.push(d); i++;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
      }
      prev = '/';
      continue;
    }
    out.push(c); i++;
    if (!isSpace(c)) prev = c;
  }
  return out.join('');
}

/** 自检：正/负对照成对；并含一条"朴素实现会吃掉真代码"的**反面参照**。 */
function selftest() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, cond: Boolean(cond), detail });
  // ⚠️ 这是**反面参照**（不是生产路径）：朴素写法**故意**留在这里当对照，用来证明上面那个缺陷真实存在。
  const naive = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  // ① 行注释里的"块注释起始"不得开块注释。
  //    真实形态：把 `scripts/**` 写进一句行注释，**后面还有一条真块注释** ⇒ 朴素实现会从前者
  //    一路吃到后者的结束标记，把中间的真实代码静默删掉（实测 95 / 331 行那种）。
  const caseLine = '// 面 = `scripts/**` 与 `test/**`\nconst a = 1;\n/** 真注释 */\nconst b = 2;\n';
  ok('正判据：行注释里的 `/**` 不吃掉后面的代码',
    stripComments(caseLine).includes('const a = 1;') && stripComments(caseLine).includes('const b = 2;'));
  ok('反面参照：朴素实现会吃掉中间的代码（证明缺陷真实）',
    !naive(caseLine).includes('const a = 1;'), '朴素输出=' + JSON.stringify(naive(caseLine).slice(0, 44)));

  // ② 字符串里的"块注释起始"同样不得开块注释（真实形态：'test/tools/*.mjs'）
  const caseStr = "const p = 'test/tools/*.mjs';\nconst q = 1;\n/* z */\nconst r = 2;\n";
  ok('正判据：字符串里的 `/*` 不吃掉后面的代码',
    stripComments(caseStr).includes("'test/tools/*.mjs'")
    && stripComments(caseStr).includes('const q = 1;') && stripComments(caseStr).includes('const r = 2;'));
  ok('反面参照：朴素实现会吃掉中间的代码',
    !naive(caseStr).includes('const q = 1;'), '朴素输出=' + JSON.stringify(naive(caseStr).slice(0, 44)));

  // ③ 真块注释仍要剥掉，且不影响后续代码
  const caseBlock = '/* c */ const a = 1;';
  ok('正判据：真块注释被剥掉、代码保留',
    !stripComments(caseBlock).includes('/*') && stripComments(caseBlock).includes('const a = 1;'));

  // ④ 行注释里的 `//` 仍要剥掉（含"URL 不算注释"的负对照）
  ok('正判据：行注释被剥掉', !stripComments('const a = 1; // hi\n').includes('hi'));
  ok('负对照：字符串里的 URL 不算注释',
    stripComments("const u = 'https://x/y';").includes('https://x/y'));

  // ⑤ 等长 + 换行保留（行号/列偏移不变的判据）
  const sample = '/* a\nb */ x\n// tail\ny\n';
  const got = stripComments(sample);
  ok('正判据：剥后与原文**等长**', got.length === sample.length, `${got.length} vs ${sample.length}`);
  ok('正判据：行数不变（换行原样保留）', got.split('\n').length === sample.split('\n').length);
  ok('正判据：未被注释的字符原样在', got.includes('x') && got.includes('y'));

  // ⑥ 模板字面量与转义
  ok('正判据：模板里的 `/*` 不算注释', stripComments('const t = `a/*b`;\nconst z = 1;\n').includes('const z = 1;'));
  ok('正判据：转义引号不会提前结束字符串', stripComments("const s = 'a\\'/*b';\nconst z = 1;\n").includes('const z = 1;'));

  // ⑦ 正则字面量（这一步是必需的：正则里会合法地出现 `/*`、`//`）
  //    真实形态 a：字符类里带 `/*`（守卫搜源码里的块注释标记时就会这么写）
  const caseReClass = String.raw`const r = /[/*]/g;` + '\nconst a = 1;\n/* z */\nconst b = 2;\n';
  ok('正判据：正则字符类里的 `/*` 不算注释（后面的代码保留）',
    stripComments(caseReClass).includes('const a = 1;') && stripComments(caseReClass).includes('const b = 2;'));
  ok('反面参照：朴素实现会从正则里那个 `/*` 一路吃到后面的块注释结束',
    !naive(caseReClass).includes('const a = 1;'), '朴素输出=' + JSON.stringify(naive(caseReClass).slice(0, 44)));
  //    真实形态 b：以 `\//` 收尾的正则（本仓 4 个文件这么写）—— 不识别就会把该行后半段当行注释
  const caseReTail = String.raw`const r = /\/\//g; const a = 1;` + '\nconst b = 2;\n';
  ok('正判据：以 `\\//` 收尾的正则不被当成行注释（该行原样保留）',
    stripComments(caseReTail).includes('const a = 1;') && stripComments(caseReTail).includes(String.raw`/\/\//g`));
  ok('负对照：除号不会被当成正则（`a / b / c` 原样保留）',
    stripComments('const x = a / b / c;\nconst y = 1;\n').includes('a / b / c;'));

  let failed = 0;
  for (const r of results) {
    console.log((r.cond ? '✓ ' : '✗ ') + r.name + (r.detail ? ' — ' + r.detail : ''));
    if (!r.cond) failed++;
  }
  console.log('');
  if (failed) {
    console.log(`js-text selftest FAILED — ${failed}/${results.length}`);
    process.exit(1);
  }
  console.log(`js-text selftest PASSED (${results.length})`);
}

export { stripComments, selftest };

// 作为脚本直接跑时才执行自检（被 `import` 时**不得**有副作用 —— 守卫要 import 这个模块）
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly && process.argv[2] === 'selftest') selftest();
