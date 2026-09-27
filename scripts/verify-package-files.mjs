// Verify the PUBLISHED package's `files` allowlist actually ships every file
// under lib/ — this packaging regression shipped TWICE (PR #61 fixed it, v0.7.2
// lost it again): lib/scene-script-apis.js was dropped from `files`, so the
// tarball was missing it, lib/scene-scripts.js threw on import inside the render
// worker, and EVERY Scene wallpaper silently fell back to 回退主纹理 (upstream
// #86: the 8K / 146MB-decoded main texture).
//
// The checkout always runs, so nothing in the repo notices a gap — only the
// PUBLISHED package breaks. This guard asserts the allowlist directly:
//   P1 every file under lib/ is covered by a `files` entry. Entries resolve as
//      exact paths, directories (with or without the trailing slash, e.g.
//      "lib/we-renderer/") and globs; the uncovered files are PRINTED, never
//      silently ignored.
//   P2 the resolver itself distinguishes covered from uncovered (a guard that
//      cannot fail is worthless) — positive + negative controls.
//   P3 the named runtime entry points exist on disk AND are covered, so deleting
//      lib/scene-render-worker.mjs (or its entry) fails loudly instead of merely
//      shrinking P1's input set.
//
// Usage: node scripts/verify-package-files.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { builtinModules } from 'node:module';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
function assert(cond, name, detail) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + name + (detail ? ' — ' + detail : ''));
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ── lib/ 文件枚举 + `files` 条目覆盖判定 ────────────────────────────────────
/** 递归列出 dir 下的文件 (相对 ROOT 的 posix 路径, 已排序)。 */
function walkFiles(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const abs = join(dir, name);
    let st = null;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkFiles(abs, out);
    else if (st.isFile()) out.push(relative(ROOT, abs).split(sep).join('/'));
  }
  return out.sort();
}

/** npm `files` 条目里的 glob → 正则: `*` 不跨 `/`, `**` 跨。 */
function globRe(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+.[]{}()|'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

/** 条目 entry 是否覆盖相对路径 rel。目录条目可写 "lib/we-renderer/" 或
 *  "lib/we-renderer" (后者按磁盘上是否为目录判定), 其余支持精确路径与 glob。 */
function coveredBy(rel, entry) {
  const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!e) return false;
  let isDir = String(entry).endsWith('/');
  if (!isDir) {
    try { isDir = statSync(join(ROOT, e)).isDirectory(); } catch { /* 非目录/不存在 */ }
  }
  if (isDir) return rel.startsWith(e + '/');
  if (/[*?]/.test(e)) return globRe(e).test(rel);
  return rel === e;
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert(Array.isArray(pkg.files), 'package.json must declare a files allowlist');
  const files = pkg.files;
  const libFiles = walkFiles(join(ROOT, 'lib'));
  // 运行时载荷 = .js/.mjs/.cjs (worker/模块图); 其余 lib/ 文件同样必须随包发布
  // (.d.ts 由 package.json types/exports 指向, .h 是 glsl 参考头) —— 一并断言,
  // 这样任何 lib/ 文件都不会被静静漏掉。
  const runtime = libFiles.filter((rel) => /\.(js|mjs|cjs)$/.test(rel));
  const uncovered = libFiles.filter((rel) => !files.some((e) => coveredBy(rel, e)));

  // ── P1: `files` 覆盖 lib/ 下的每一个文件 ────────────────────────────────────
  check('P1 package.json `files` covers every file under lib/ (' + runtime.length + ' runtime .js/.mjs)',
    libFiles.length > 0 && uncovered.length === 0,
    libFiles.length + ' lib file(s) vs ' + files.length + ' `files` entr(ies)'
      + '; missing=[' + uncovered.join(', ') + ']');

  // ── P2: 解析器正/负控制 (证明这条断言真的会 FAIL) ───────────────────────────
  {
    const controls = [
      [coveredBy('lib/index.js', 'lib/index.js'), 'exact file'],
      [coveredBy('lib/we-renderer/bloom.js', 'lib/we-renderer/'), 'dir entry (trailing slash)'],
      [coveredBy('lib/we-renderer/bloom.js', 'lib/we-renderer'), 'dir entry (no trailing slash)'],
      [coveredBy('lib/we-renderer/glsl/common.h', 'lib/we-renderer/**'), 'glob entry'],
      [!coveredBy('lib/__absent__.js', 'lib/index.js'), 'negative: unlisted file'],
      [!coveredBy('lib/we-renderer/__absent__.js', 'lib/index.js'), 'negative: wrong prefix'],
      [!coveredBy('lib/scene-render-worker.mjs', 'lib/we-renderer'), 'negative: dir must not match sibling'],
      [!coveredBy('lib/__absent__/x.js', 'lib/we-renderer/'), 'negative: outside the dir entry'],
    ];
    const bad = controls.filter(([ok]) => !ok).map(([, label]) => label);
    check('P2 coverage resolver separates covered from uncovered (positive + negative controls)',
      bad.length === 0,
      controls.length + ' controls, failed=[' + bad.join(', ') + ']');
  }

  // ── P3: 具名运行时入口必须在磁盘上且被收录 (防文件被删后 P1 空转通过) ────────
  {
    const required = [
      'lib/index.js', 'lib/client.js', 'lib/scene-render-worker.mjs',
      'lib/pkg-extract.js', 'lib/scene-scripts.js', 'lib/scene-script-apis.js',
    ];
    const absent = required.filter((rel) => !libFiles.includes(rel));
    const unlisted = required.filter((rel) => libFiles.includes(rel) && !files.some((e) => coveredBy(rel, e)));
    check('P3 named runtime entry points exist under lib/ AND are shipped by `files`',
      absent.length === 0 && unlisted.length === 0,
      'required=' + required.length + ' absent=[' + absent.join(', ') + '] unlisted=[' + unlisted.join(', ') + ']');
  }

  // ── P4: 声明的依赖必须有消费者 (防"死声明") ──────────────────────────────────
  // 本仓库的运行时策略是**自带副本**（lib/vendor/jpeg-js、lib/webgl…），因此
  // package.json 里每一条 `dependencies` 都必须在 lib/ 里真的被 import ——
  // 否则它只是给用户装了一个永远不会被 require 的包（jpeg-js 就是这样的一种情况：
  // 代码只 import './vendor/jpeg-js/index.js'，裸包名在 link: 安装下根本解析不到）。
  // 注意口径：这里只断言"声明有消费者"，**不断言可达**（可达性属 P2-12 的活）。
  {
    const deps = Object.keys(pkg.dependencies || {});
    const libSrc = walkFiles(join(ROOT, 'lib'))
      .filter((rel) => /\.(js|mjs|cjs)$/.test(rel))
      .map((rel) => readFileSync(join(ROOT, rel), 'utf8'))
      .join('\n');
    const consumers = deps.filter((d) => new RegExp(
      '(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)[\'"]' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/[\'"]|[\'"])'
    ).test(libSrc));
    const orphans = deps.filter((d) => !consumers.includes(d));
    check('P4 every declared dependency is imported by lib/ (no dead declaration)',
      orphans.length === 0,
      'deps=' + deps.length + ' consumers=[' + consumers.join(', ') + '] orphans=[' + orphans.join(', ') + ']');
    check('P4 negative control: a synthetic dependency name is reported unconsumed',
      !new RegExp('(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*)[\'"]' +
        'dsh-definitely-not-a-real-dep' + '[\'"\\)]').test(libSrc));
  }

  // ── P5: 构建 / 校验链保持"零裸依赖"(CI 不装依赖的前提) ───────────────────────
  // .github/workflows/verify.yml 故意**不跑 npm ci**：build + verify + smoke 只用
  // node: 内置模块与相对路径，因此整条流水线对 registry / peer 解析完全免疫。
  // 这是一条真不变量，不是偶然 —— 一旦有人在守卫里 import 一个裸包，CI 会红在
  // "command not found" 而不是给出可读原因，所以在这里显式钉住。
  {
    const builtins = new Set(builtinModules || []);
    const chainNames = ['build', 'verify', 'smoke', 'prepare'];
    const scripts = [];
    for (const n of chainNames) {
      const cmd = (pkg.scripts || {})[n] || '';
      for (const m of cmd.matchAll(/node\s+([\w./-]+\.mjs)/g)) scripts.push(m[1]);
    }
    const offenders = [];
    for (const rel of [...new Set(scripts)]) {
      let src = '';
      try { src = readFileSync(join(ROOT, rel), 'utf8'); } catch { offenders.push(rel + '(缺文件)'); continue; }
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)[\'"]([^\'"]+)[\'"]/g)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) continue;
        const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (builtins.has(root)) continue;
        offenders.push(rel + ' -> ' + spec);
      }
    }
    check('P5 build/verify/smoke/prepare chain has NO bare-package import (CI installs nothing)',
      offenders.length === 0,
      scripts.length + ' script(s) referenced; offenders=[' + offenders.join(', ') + ']');
    check('P5 negative control: the detector catches a bare import and ignores builtins/relative',
      (() => {
        const probe = (src) => {
          const out = [];
          for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)[\'"]([^\'"]+)[\'"]/g)) {
            const spec = m[1];
            if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) continue;
            const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            if (builtins.has(root)) continue;
            out.push(spec);
          }
          return out;
        };
        // 假包名在运行时拼出来 —— 否则这条负对照的**字符串字面量**会被上面的扫描
        // 当成真的裸依赖，把守卫自己判红（本守卫也在被扫的链里）。
        const fake = ['left', 'pad'].join('-');
        return probe('import x from "' + fake + '"').length === 1
          && probe("import fs from 'fs'").length === 0
          && probe("import p from 'node:path'").length === 0
          && probe("import q from './local.mjs'").length === 0;
      })());
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL PACKAGE FILE CHECKS PASSED'
    : failed.length + ' CHECK(S) FAILED'));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
