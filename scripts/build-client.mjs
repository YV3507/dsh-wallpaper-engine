/**
 * build-client.mjs — minimal build for the browser half.
 *
 * Reproduces the exact artifact shape the DSH client module loader consumes,
 * the same shape `tsdown` emits for in-box client packages:
 *
 *     window.__ModuleLoader__.load({
 *       id: "<package-name>",
 *       factory: (require) => {
 *         var module = { exports: {} };
 *         var exports = module.exports;
 *         Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *         <inlined modules, in INLINE_MODULES order>
 *         <src/client.js body, indent-normalized>
 *         return module.exports;
 *       }
 *     });
 *
 * The body must end in `return module.exports` (it does). This script is a
 * deterministic, dependency-free stand-in for `tsdown bundle`.
 *
 * **Why inlining**: the browser half cannot `import` a sibling local file — the
 * bundle has no local-module resolver (only the loader's `require` for external
 * packages). So any code split out of `src/client.js` for readability (see
 * INLINE_MODULES) is inlined here as a **prelude** in the same factory scope.
 * The extracted files stay the single source; `src/client.js` just uses their
 * names. Shape mismatches are a **hard build failure**, never a silent empty
 * prelude — that is what keeps the split honest.
 *
 * Usage:  node scripts/build-client.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const id = pkg.name;

/**
 * 内联进客户端 bundle 的模块（顺序即注入顺序）。
 * `markers` 是"结构变了就报错"的锚点 —— 缺任何一个都构建失败，避免内联悄悄变空。
 */
const INLINE_MODULES = [
  {
    file: 'lib/settings-schema.js',
    why: '设置唯一真源（宿主也 import 同一文件，见 P1-5）',
    markers: ['const KINDS = {', 'function sanitizeFromSchema(', 'function settingsDefaults(',
      'function serializeSettings(', 'const DEFAULTS = {'],
  },
  {
    file: 'src/we-cond.js',
    why: 'WE 条件求值器（纯计算、零外界依赖，独立可测，见 P1-7）',
    markers: ['const WE_COND_OPS = [', 'function weEvalCondition(', 'function weCondTokenize('],
  },
];

const src = readFileSync(resolve(root, 'src', 'client.js'), 'utf8');
const body = stripHeader(src).replace(/\r\n/g, '\n').replace(/\n+$/, '');
const prelude = readInlinedPrelude();

const outline = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  indent(prelude),
  '\t\t// ── 客户端正文（src/client.js）────────────────────────────────────────',
];

// Indent the source body by two tabs. Preserve blank-line gaps; never indent
// an already-blank line.
outline.push(indent(body));
outline.push('\t},');
outline.push('});');
outline.push('');

const output = outline.join('\n');

// 产物必须可解析 —— 内联后出现重复声明/括号错配时在这里就红，而不是等到用户页面白屏。
try {
  new Script(output, { filename: 'lib/client.js' });
} catch (err) {
  console.error(`[build-client] 产物语法错误：${err && err.message}`);
  process.exit(1);
}

const target = resolve(root, 'lib', 'client.js');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, output);
const inlined = INLINE_MODULES.map((m) => m.file).join(' + ');
console.log(`built ${target} (${output.length} bytes; inlined: ${inlined})`);

function indent(text) {
  return text.split('\n').map((line) => (line.trim() === '' ? '' : '\t\t' + line)).join('\n');
}

/**
 * 读取 INLINE_MODULES 并拼成可内联的 prelude：
 *   · 断言每个模块**浏览器安全**（无 import/require/Node 全局）；
 *   · 断言形状符合预期（markers 全在）；
 *   · 剥掉 `export {...}` 块与声明前的 `export ` 关键字（内联后同作用域，不需要导出）；
 *   · 断言 src/client.js **没有**重复声明任何一个被注入的名字
 *     （重复 = 运行时 SyntaxError；名字从模块里**机器提取**，不维护手工清单）。
 */
function readInlinedPrelude() {
  const parts = [];
  const injected = new Map(); // name -> file
  for (const mod of INLINE_MODULES) {
    const abs = resolve(root, mod.file);
    const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

    for (const [re, what] of [
      [/^\s*import\s/m, 'import 语句'],
      [/\brequire\s*\(/, 'require()'],
      [/^\s*export\s+default/m, 'export default'],
      [/\bprocess\.\w/, 'process.*'],
      [/\b__dirname\b|\b__filename\b/, 'CommonJS 路径全局量'],
    ]) {
      if (re.test(text)) {
        console.error(`[build-client] ${mod.file} 必须浏览器安全，但含${what}`);
        process.exit(1);
      }
    }
    for (const marker of mod.markers) {
      if (!text.includes(marker)) {
        console.error(`[build-client] ${mod.file} 缺少预期标记：${marker}（结构变了？请同步本脚本）`);
        process.exit(1);
      }
    }

    // 机器提取被注入的名字：声明名 + export 列表
    for (const m of text.matchAll(/^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)) injected.set(m[1], mod.file);
    const exp = text.match(/^export\s*\{([\s\S]*?)\};?\s*$/m);
    if (exp) for (const n of exp[1].split(',').map((s) => s.trim()).filter(Boolean)) injected.set(n, mod.file);

    parts.push(
      `\t\t// ── 内联模块：${mod.file} —— ${mod.why}（构建期注入；勿手改本段）──\n` +
      indent(text.replace(/^export\s*\{[\s\S]*?\};?\s*$/m, '').replace(/^export /gm, '').trim()) + '\n');
  }

  const clashes = [...injected.keys()].filter((name) =>
    new RegExp('^(?:const|let|var|function)\\s+' + name + '\\b', 'm').test(body));
  if (clashes.length) {
    console.error('[build-client] src/client.js 重复声明了内联模块提供的常量/函数：' + clashes.join(', '));
    process.exit(1);
  }
  return parts.join('\n');
}

// Header comments in the source are preserved inside the factory, which is
// harmless, but strip the leading "this is not the artifact / edit src" banner
// so the emitted bundle reads as a compiled artifact.
function stripHeader(srcText) {
  const lines = srcText.split('\n');
  let codeStart = 0;
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^\s*\/\*\*/.test(line)) inBlock = true;
    else if (inBlock && /\*\/\s*$/.test(line)) { codeStart = i + 1; break; }
  }
  return lines.slice(codeStart).join('\n');
}
