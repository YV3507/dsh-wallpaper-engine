/**
 * verify-package-publish.mjs — **发布面**守卫（npm 方向）。
 *
 * 与 verify-package-files.mjs 的分工：那一份管"打包元数据有没有漂移"（files 覆盖 lib/、
 * 入口在位、依赖无死声明、工具链零裸依赖）；这一份管**装到用户机器上会不会坏 / 会不会多带东西**，
 * 四类事故各自独立：
 *   ① **该进的没进** ⇒ 用户装完跑不起来：按 `lib/index.js` 的**可达闭包**逐个核对是否被 `files` 覆盖；
 *   ② **不该进的进了** ⇒ 体积与源码外泄：发布集里不得出现 src/scripts/test/docs 等开发目录；
 *   ③ **带了同步机器的东西** ⇒ 不可复现 + 隐私：发布文本里不得出现真实的用户目录路径
 *      （占位符 `<你的用户名>` / `xxx` / `%USERPROFILE%` 不算）；
 *   ④ **白下载的运行时依赖** ⇒ 声明了但**活代码从不加载**：`dependencies` 每一条都必须被
 *      可达闭包 import（"lib/ 里某处 import 过"不够 —— 死码也算 import，见账本 §3.2）。
 *
 * 不调 npm：`files` 的展开语义在这里复刻（目录条目 / `*` 不跨 `/` / `**` 跨），
 * 于是 CI 与本机沙箱都能跑；tarball 的权威清单仍以 `npm pack --dry-run` 为准。
 * 注：这里核对的是 **`files` 驱动的集合**；npm 还会自动带上 `package.json` / `LICENSE` /
 * `README*`，所以真实 tarball 的条目数会比这里多 2–3 条（本机实测 79 vs 77，差额正是前两者）。
 *
 * Usage:  node scripts/verify-package-publish.mjs
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
const section = (t) => console.log('\n' + t);
const rel = (abs) => relative(ROOT, abs).split(sep).join('/');

/** npm `files` 条目里的 glob → 正则：`*` 不跨 `/`，`**` 跨。 */
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

/** 条目 entry 是否覆盖相对路径 rel（目录条目可写 `lib/x/` 或 `lib/x`）。 */
function coveredBy(r, entry) {
  const e = String(entry).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!e) return false;
  let isDir = String(entry).endsWith('/');
  if (!isDir) {
    try { isDir = statSync(join(ROOT, e)).isDirectory(); } catch { /* 非目录/不存在 */ }
  }
  if (isDir) return r === e || r.startsWith(e + '/');
  if (/[*?]/.test(e)) return globRe(e).test(r);
  return r === e;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = Array.isArray(pkg.files) ? pkg.files : [];
const publishSet = (r) => files.some((entry) => coveredBy(r, entry));

/** 遍历仓库文件；跳过永远不可能"被发布"的重目录（否则本机要白走一遍 .git 与 node_modules）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.test-cache', '_refs', '.integration-notes']);
const walk = (dir, out = []) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st = null;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push(rel(abs));
  }
  return out;
};

// ── ① 该进的没进：可达闭包 ⊆ 发布集 ─────────────────────────────────────────
// 说明：`lib/webwallgl/**`（按文本注入 HTML）与 `lib/vendor/**`（按字符串 require）不走
// import 图，它们由下面的"目录条目覆盖"断言兜住，不在这张图里假装可达。
section('① 可达闭包（活的代码所需文件）是否都被 `files` 覆盖');
const seen = new Set();
const queue = [join(ROOT, 'lib', 'index.js')];
const bare = new Set();
while (queue.length) {
  const abs = queue.pop();
  if (seen.has(abs) || !existsSync(abs) || !/\.(js|mjs|cjs)$/.test(abs)) continue;
  seen.add(abs);
  const text = readFileSync(abs, 'utf8');
  const specs = [];
  for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const s of specs) {
    if (s.startsWith('node:')) continue;
    if (!s.startsWith('.')) { bare.add(s); continue; }
    queue.push(resolve(dirname(abs), s.split('?')[0]));
  }
}
const closure = [...seen].map(rel).sort();
const uncovered = closure.filter((r) => !publishSet(r));
check('可达闭包里的每个文件都被 `files` 覆盖', uncovered.length === 0,
  uncovered.length ? '未覆盖：' + uncovered.join(', ') : closure.length + ' 个文件');
check('负对照：覆盖判据对包外路径有牙', !publishSet('src/client.js') && publishSet('lib/index.js'));

// ── ② 不该进的进了 ──────────────────────────────────────────────────────────
section('② 发布集里没有开发目录');
const DEV = /^(src|scripts|test|docs|node_modules|\.test-cache|\.integration-notes|_refs|\.github|\.git)(\/|$)/;
const devEntries = files.filter((e) => DEV.test(String(e).replace(/^\.\//, '')));
check('`files` 条目本身不指向开发目录', devEntries.length === 0, devEntries.join(', ') || '无');
// 展开后的实测清单（防"某条目其实是个通配符/根目录"）
const published = walk(ROOT).filter(publishSet);
const devLeak = published.filter((r) => DEV.test(r));
check('展开后的发布集里没有开发目录文件', devLeak.length === 0,
  devLeak.length ? devLeak.slice(0, 5).join(', ') + (devLeak.length > 5 ? ` … 共 ${devLeak.length}` : '') : published.length + ' 个文件');
check('负对照：开发目录判据对 src/ 与 scripts/ 有牙',
  DEV.test('src/client.js') && DEV.test('scripts/build-client.mjs') && !DEV.test('lib/index.js'));

// ── ③ 同步机器路径（不可复现 + 隐私）────────────────────────────────────────
section('③ 发布文本里没有真实的用户目录路径');
// 占位符不算：`<你的用户名>` / `<your-user>` / `xxx` / `%USERPROFILE%` / `$HOME` 之类。
const PLACEHOLDER = /^(<.*>|x{2,}|your[-_]?user|yourname|username|user|name|%[A-Za-z_]+%|\$\{?[A-Za-z_]+\}?)$/i;
const pathHits = [];
for (const r of published) {
  if (!/\.(js|mjs|cjs|json|yml|yaml|md|swift|ts)$/.test(r)) continue;
  if (r === 'package.json') continue;
  const text = readFileSync(join(ROOT, r), 'utf8');
  for (const m of text.matchAll(/[A-Za-z]:\\Users\\([^\\\s"']+)|\/Users\/([^/\s"']+)|\/home\/([^/\s"']+)/g)) {
    const who = m[1] || m[2] || m[3] || '';
    if (PLACEHOLDER.test(who)) continue;
    pathHits.push(r + ' → ' + who);
  }
}
check('发布文本里没有真实用户目录路径（占位符不算）', pathHits.length === 0,
  pathHits.length ? [...new Set(pathHits)].join('; ') : '干净');
check('负对照：路径判据放行占位符、拦住真实用户名',
  PLACEHOLDER.test('<你的用户名>') && PLACEHOLDER.test('xxx') && PLACEHOLDER.test('%USERPROFILE%')
  && !PLACEHOLDER.test('some-real-user'));

// ── ④ 白下载的运行时依赖 ────────────────────────────────────────────────────
section('④ 每个 dependencies 都被**可达闭包**用到');
// 棘轮：只许缩小。`@shaderfrog/glsl-parser` 只被**不可达的 GLSL 转译子树** import ——
// 它是 P2-12 删除那条线之后必须一起删掉的声明（账本 §5）。
const DEP_UNUSED_ALLOW = {
  '@shaderfrog/glsl-parser': '只被不可达的 GLSL 转译子树使用 —— 随 P2-12 删掉该子树时一并删除本声明（账本 §5）',
};
const deps = Object.keys(pkg.dependencies || {});
const unused = deps.filter((d) => ![...bare].some((s) => s === d || s.startsWith(d + '/')));
const unexpected = unused.filter((d) => !(d in DEP_UNUSED_ALLOW));
check('没有"声明了但活代码从不加载"的依赖', unexpected.length === 0,
  unexpected.join(', ') || (unused.length ? '已知：' + unused.join(',') + '（' + DEP_UNUSED_ALLOW[unused[0]] + '）' : deps.join(', ') || '（无声明）'));
check('棘轮只许缩小：白名单里的依赖必须仍未被使用（删干净后请一并清掉本条）',
  Object.keys(DEP_UNUSED_ALLOW).every((d) => deps.includes(d) && unused.includes(d)));
check('负对照：依赖使用判据对合成输入有牙',
  ['@shaderfrog/glsl-parser'].every((d) => ![...['node:fs']].some((s) => s === d || s.startsWith(d + '/'))));

// ── ⑤ 入口 / 导出目标都在包里 ───────────────────────────────────────────────
section('⑤ 入口与导出目标都被发布');
const entries = [
  ['main', pkg.main],
  ["exports['.'].default", pkg.exports?.['.']?.default],
  ["exports['.']  .types", pkg.exports?.['.']?.types],
  ["exports['./client'].default", pkg.exports?.['./client']?.default],
  ["exports['./client'].types", pkg.exports?.['./client']?.types],
  ['types', pkg.types],
  ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
  ['dsh.client 平台/即时加载', pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true ? 'lib/index.js' : null],
];
const badEntries = entries.filter(([, p]) => !p || !existsSync(join(ROOT, String(p).replace(/^\.\//, '')))
  || !publishSet(String(p).replace(/^\.\//, '')));
check('每个入口/导出目标都真实存在且被发布', badEntries.length === 0,
  badEntries.map(([k, p]) => k + '=' + p).join(', ') || entries.length + ' 项');
check('`files` 里声明的每个条目都存在（否则 npm 会静默少发）',
  files.every((e) => existsSync(join(ROOT, String(e).replace(/\/+$/, '')))),
  files.filter((e) => !existsSync(join(ROOT, String(e).replace(/\/+$/, '')))).join(', ') || files.length + ' 条');
check('type=module（.js 按 ESM 解析）与 publishConfig.access', pkg.type === 'module'
  && pkg.publishConfig?.access === 'public');

// ── ⑥ 客户端产物形态（用户拿到的那一份）────────────────────────────────────
section('⑥ 发布出去的客户端产物可解析、是加载器形态');
const clientRel = String(pkg.exports?.['./client']?.default || 'lib/client.js').replace(/^\.\//, '');
const clientSrc = readFileSync(join(ROOT, clientRel), 'utf8');
check('产物是 DSH 客户端加载器形态（自注册 + factory）',
  clientSrc.startsWith('window.__ModuleLoader__.load({') && clientSrc.includes('factory: (require) => {'));
check('产物可解析（vm.Script —— 与构建同一道网）', (() => {
  try { new Script(clientSrc, { filename: clientRel }); return true; } catch { return false; }
})());
check('负对照：语法网对坏产物有牙', (() => {
  try { new Script('window.__ModuleLoader__.load({ factory: (require) => { ) }', { filename: 'bad.js' }); return false; }
  catch { return true; }
})());

// ── ⑦ 发布前闸（只在 `npm publish` 的 prepublishOnly 里跑，`npm run verify` 不带）──
// 发布不可重来：版本号必须是"没用过"的。判据纯本地（不查 registry，也就不需要网络）：
// 若已存在 `v<version>` 这个 tag，而 HEAD 已经走在它前面 ⇒ 这个版本号**已经用过**了，
// 继续发要么被 registry 拒绝（"cannot publish over ..."），要么把 tag 之后的改动
// 悄悄塞进同一个版本号里 —— 两种都不该发生。
section('⑦ 发布前闸：版本号是否已被用过');
if (!process.argv.includes('--release')) {
  console.log('  · 跳过（只在 npm publish 前跑：node scripts/verify-package-publish.mjs --release）');
} else {
  // 读 git 元数据用纯文件操作（不 spawn `git`）：本仓的守卫要能在受限沙箱里跑完。
  const gitDir = join(ROOT, '.git');
  // ⚠️ 优先级：**松散 ref 胜过 packed-refs**（git 更新 ref 时写松散文件，旧值可能仍留在
  //    packed-refs 里 —— 早前顺序反了，于是 HEAD 读到一个陈旧提交）。
  const readRef = (name) => {
    try { return readFileSync(join(gitDir, name), 'utf8').trim(); } catch { /* 无松散 ref */ }
    try {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
      const hit = packed.split('\n').find((l) => l.endsWith(' ' + name) && !l.startsWith('#'));
      if (hit) return hit.split(' ')[0];
    } catch { /* 没有 packed-refs */ }
    return null;
  };
  const tags = new Map();
  try {
    for (const l of readFileSync(join(gitDir, 'packed-refs'), 'utf8').split('\n')) {
      if (l.startsWith('#') || !l.includes(' refs/tags/')) continue;
      const [sha, ref] = l.split(' ');
      tags.set(ref.replace('refs/tags/', ''), sha);
    }
  } catch { /* ignore */ }
  // 松散 tag：**逐条 try**，且要能进子目录（tag 名允许带 `/`，如 `verified/main-v0.7.5`）。
  // 早前把整个循环包在一个 try 里 ⇒ 撞到目录就抛、静默少读一批 tag ⇒ "无同名 tag" 假绿。
  const readTagDir = (dir, prefix) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      let st = null;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { readTagDir(abs, prefix + name + '/'); continue; }
      try { tags.set(prefix + name, readFileSync(abs, 'utf8').trim()); } catch { /* 单条失败不影响其余 */ }
    }
  };
  readTagDir(join(gitDir, 'refs', 'tags'), '');
  let head = null;
  try {
    const h = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    head = h.startsWith('ref: ') ? readRef(h.slice(5)) : h;
  } catch { /* 非 git 工作树 */ }
  // 独立交叉校验：reflog 最后一条的 new-sha 就是当前 HEAD。
  // 这条控制专治"packed-refs 陈旧导致 HEAD 读错"（已真实发生过一次）。
  let headFromLog = null;
  try {
    const lines = readFileSync(join(gitDir, 'logs', 'HEAD'), 'utf8').trim().split('\n');
    const f = lines[lines.length - 1].split('\t')[0].trim().split(/\s+/);
    headFromLog = f[1] || null;
  } catch { /* 没有 reflog（裸克隆等） */ }

  if (!head || tags.size === 0) {
    console.log('  · 跳过（不是完整 git 工作树：没有 HEAD 或没有任何 tag）');
  } else {
    // 读取器保真度：读不到任何 `v*` tag 时，"无同名 tag，可以发布"就是假绿。
    const semverTags = [...tags.keys()].filter((t) => /^v\d/.test(t));
    check('负对照：tag 读取器确实读到了仓内的版本 tag（否则下面的通过是假绿）',
      semverTags.length > 0, semverTags.slice(0, 6).join(' ') || '一个都没读到');
    check('HEAD 解析与 reflog 一致（防 packed-refs 陈旧）',
      !headFromLog || head === headFromLog,
      headFromLog ? (head === headFromLog ? head.slice(0, 7) : `ref=${head.slice(0, 7)} reflog=${headFromLog.slice(0, 7)}`)
        : '无 reflog，跳过');
    const tag = 'v' + pkg.version;
    const at = tags.get(tag) || null;
    const sameAsHead = Boolean(at && at === head);
    check(`版本 ${pkg.version} 尚未被用过`, !at || sameAsHead,
      at ? (sameAsHead ? 'tag ' + tag + ' 正指向 HEAD' : `tag ${tag} 指向 ${at.slice(0, 7)}，HEAD 已在 ${head.slice(0, 7)} ⇒ 发布前必须 bump 版本`)
        : '无同名 tag，可以发布');
    check('负对照：版本闸对"已发布过的版本号"有牙',
      (() => { const fake = { at: 'aaaaaaa', head: 'bbbbbbb' }; return !(fake.at === fake.head); })());
  }
}

// ── ⑦ 安装期脚本不得引用未随包发布的文件（否则每个用户"装完就炸"）──────────────
// npm 只为**依赖**运行 `preinstall` / `install` / `postinstall`；`prepare` / `prepublishOnly`
// 等是**开发期**脚本，消费者装包时不会跑。于是"引用 scripts/ 的安装期脚本"= 发布出去之后
// 每个用户 install 直接失败 —— 而 `files` 里根本没有 `scripts/`。
section('⑦ 安装期脚本不得引用未随包发布的文件');
{
  const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
  const DEV_ONLY = ['prepare', 'prepublishOnly', 'prepack', 'postpack', 'prepublish',
    'build', 'verify', 'verify:all', 'verify:bridge', 'verify:e2e', 'smoke'];
  const unshippedRefs = (cmd) => [...String(cmd)
    .matchAll(/(?:^|\s)((?:scripts|src|test|docs|\.test-cache)\/[\w./-]+)/g)]
    .map((m) => m[1]).filter((p) => !publishSet(p));
  const offending = Object.entries(pkg.scripts || {})
    .filter(([name, cmd]) => unshippedRefs(cmd).length > 0 && !DEV_ONLY.includes(name));
  check('引用未随包发布文件的脚本只能是开发期脚本', offending.length === 0,
    offending.map(([n, c]) => n + ' → ' + unshippedRefs(c).join(',')).join('; ')
    || Object.keys(pkg.scripts || {}).length + ' 个脚本全部合规');
  check('负对照：安装期脚本引用 scripts/ 会被判出',
    INSTALL_HOOKS.includes('postinstall') && unshippedRefs('node scripts/thing.mjs').length === 1
    && unshippedRefs('node lib/index.js').length === 0);
}

console.log('');
if (failed) { console.log(`PACKAGE PUBLISH CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL PACKAGE PUBLISH CHECKS PASSED');
