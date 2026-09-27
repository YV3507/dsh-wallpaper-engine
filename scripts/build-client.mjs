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
 *         <inlined settings schema (lib/settings-schema.js)>
 *         <src/client.js body, indent-normalized>
 *         return module.exports;
 *       }
 *     });
 *
 * The body must end in `return module.exports` (it does). This script is a
 * deterministic, dependency-free stand-in for `tsdown bundle`: it produces the
 * same single-file `window.__ModuleLoader__.load(...)` envelope without a
 * bundler, which keeps the out-of-tree package buildable with plain Node.
 *
 * **Settings schema inlining**: the browser half cannot `import` the host's
 * `lib/settings-schema.js` (the bundle has no local-module resolver — only the
 * loader's `require` for external packages), so the schema would otherwise have
 * to be duplicated. Instead it is inlined here as a **prelude** in the same
 * factory scope: the schema stays the single source and `src/client.js` just
 * uses its names (`DEFAULTS`, `KINDS`, `sanitizeFromSchema`, …). Failing to
 * find the expected shape is a **hard build failure** (never a silent empty
 * prelude), which is what keeps "one definition" honest.
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

const src = readFileSync(resolve(root, 'src', 'client.js'), 'utf8');
const body = stripHeader(src).replace(/\r\n/g, '\n').replace(/\n+$/, '');
const prelude = readSchemaPrelude();

const outline = [
  'window.__ModuleLoader__.load({',
  `\tid: ${JSON.stringify(id)},`,
  '\tfactory: (require) => {',
  '\t\tvar module = { exports: {} };',
  '\t\tvar exports = module.exports;',
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  '\t\t// ── 设置唯一真源（lib/settings-schema.js，构建期内联；勿手改本段）──────────',
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
console.log(`built ${target} (${output.length} bytes, prelude ${prelude.split('\n').length} lines)`);

function indent(text) {
  return text.split('\n').map((line) => (line.trim() === '' ? '' : '\t\t' + line)).join('\n');
}

/**
 * 读取 lib/settings-schema.js 并转成可内联的 prelude：
 *   · 断言它是**浏览器安全**的（无 import/require/Node API 依赖），否则本地就报错；
 *   · 断言形状符合预期（KINDS / sanitizeFromSchema / export 块都在）；
 *   · 剥掉 `export {...}` 块与声明前的 `export ` 关键字（内联后同作用域，不需要导出）；
 *   · 断言 src/client.js **没有**重复声明这些名字（重复 = 运行时 SyntaxError）。
 */
function readSchemaPrelude() {
  const schemaPath = resolve(root, 'lib', 'settings-schema.js');
  const schemaSrc = readFileSync(schemaPath, 'utf8').replace(/\r\n/g, '\n');

  for (const [re, what] of [
    [/^\s*import\s/m, 'import 语句'],
    [/\brequire\s*\(/, 'require()'],
    [/^\s*export\s+default/m, 'export default'],
    [/\bprocess\.\w/, 'process.*'],
    [/\b__dirname\b|\b__filename\b/, 'CommonJS 路径全局量'],
  ]) {
    if (re.test(schemaSrc)) {
      console.error(`[build-client] lib/settings-schema.js 必须浏览器安全，但含${what}`);
      process.exit(1);
    }
  }
  for (const marker of ['const KINDS = {', 'function sanitizeFromSchema(', 'function settingsDefaults(',
    'function serializeSettings(', 'const DEFAULTS = {', '^export {']) {
    const hit = marker.startsWith('^') ? new RegExp(marker, 'm').test(schemaSrc) : schemaSrc.includes(marker);
    if (!hit) {
      console.error(`[build-client] lib/settings-schema.js 缺少预期标记：${marker}（结构变了？请同步本脚本）`);
      process.exit(1);
    }
  }

  // 客户端正文不得重复声明 prelude 已提供的名字
  const INJECTED = ['DEFAULTS', 'KINDS', 'settingsDefaults', 'sanitizeFromSchema', 'serializeSettings',
    'clampNum', 'readRotationGroups', 'readUserProps', 'readLiveFailures', 'readOne', 'CONSTS',
    'RATING_VALUES', 'TYPE_VALUES', 'OBJECT_FIT_VALUES', 'AUDIO_SOURCE_VALUES', 'PICKER_LAYOUT_VALUES',
    'ROPE_FORM_VALUES', 'ROPE_SCALE_MIN', 'ROPE_SCALE_MAX', 'FONT_FAMILY_VALUES',
    'FPS_CAP_VALUES', 'SCENE_LIVE_FPS_VALUES', 'SWITCH_TRANSITION_VALUES', 'SWITCH_DIRS', 'SWITCH_SPEED_VALUES'];
  const clashes = INJECTED.filter((name) =>
    new RegExp('^(?:const|let|var|function)\\s+' + name + '\\b', 'm').test(body));
  if (clashes.length) {
    console.error('[build-client] src/client.js 重复声明了 prelude 提供的常量/函数：' + clashes.join(', '));
    process.exit(1);
  }

  return schemaSrc.replace(/^export \{[\s\S]*?\n\};\s*$/m, '').replace(/^export /gm, '').trim();
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
