#!/usr/bin/env node
/**
 * sync-static-frame.mjs — 从独立仓库 YV3507/we-static-frame vendor 静态帧
 * 渲染库进 lib/static-frame/。
 *
 * 为什么单独一个仓库：静态帧渲染（场景 → 单帧 PNG）与本插件的实时渲染
 * 是两条独立能力，独立仓库可以自己迭代/自测（test/、webui/、docs/）而不
 * 牵动插件。插件侧只 vendored 它的运行时（package.json 的 files 字段，
 * 默认只有 src/），不 vendor test/ scripts/ webui/ 这类开发件。
 *
 * 产物目录结构保持上游原样：lib/static-frame/src/**（含 src/ 一层），
 * 这样上游内部的相对 import 不需要重写；插件侧按 lib/static-frame/
 * .upstream.json 里记录的 entry 字段去 require 入口。
 *
 * 用法：
 *   node scripts/sync-static-frame.mjs                 # 默认 ../we-static-frame
 *   WE_STATIC_FRAME_REPO=/path/to/repo node scripts/sync-static-frame.mjs
 *   node scripts/sync-static-frame.mjs --check         # 只比对，不写入
 *
 * 同步后写 lib/static-frame/.upstream.json（上游 commit / 版本 / 入口 /
 * 文件清单）。上游更新后重跑本脚本；手动改 lib/static-frame/ 会被下次
 * 同步覆盖 —— 需要的改动应做在上游（本插件不做 local patch，原因是静态
 * 帧是纯库，插件只做调用方）。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'lib', 'static-frame');
const UPSTREAM_URL = 'https://github.com/YV3507/we-static-frame';
const CHECK = process.argv.includes('--check');

const repo = resolve(process.env.WE_STATIC_FRAME_REPO || join(ROOT, '..', 'we-static-frame'));
const pkgPath = join(repo, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[sync-static-frame] 上游仓库不存在或缺少 package.json：${repo}`);
  console.error('                   可用 WE_STATIC_FRAME_REPO 环境变量指定仓库路径；');
  console.error(`                   或先克隆：git clone ${UPSTREAM_URL} ../we-static-frame`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.name !== 'we-static-frame') {
  console.error(`[sync-static-frame] ${repo} 不是 we-static-frame 仓库（name=${pkg.name}）。`);
  process.exit(1);
}

// 1. vendored 集合完全由上游 package.json 的 files 决定：上游调整发布面
//    （例如以后拆出 runtime/ 子目录）本脚本自动跟随，不需要改这里。缺省
//    为 src/（上游历史上没有 files 字段时的兜底）。
const entries = Array.isArray(pkg.files) && pkg.files.length ? pkg.files : ['src'];
for (const rel of entries) {
  if (!existsSync(join(repo, rel))) {
    console.error(`[sync-static-frame] 上游 files 声明的 ${rel} 不存在，上游布局可能已变。`);
    process.exit(1);
  }
}

// 2. 入口契约：插件按 .upstream.json 的 entry/bin 调用，上游改名必须在这里
//    硬失败，而不是悄悄 vendor 一个没人认识的目录树。
const relEntry = typeof pkg.main === 'string' ? pkg.main : (pkg.exports && typeof pkg.exports === 'string' ? pkg.exports : null);
if (!relEntry) {
  console.error('[sync-static-frame] 上游 package.json 没有字符串形式的 main/exports，无法确定入口。');
  process.exit(1);
}
if (!existsSync(join(repo, relEntry))) {
  console.error(`[sync-static-frame] 上游 main/exports 指向的 ${relEntry} 不存在。`);
  process.exit(1);
}
const relBin = pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin)[0] : (typeof pkg.bin === 'string' ? pkg.bin : null);
if (relBin && !existsSync(join(repo, relBin))) {
  console.error(`[sync-static-frame] 上游 bin 指向的 ${relBin} 不存在。`);
  process.exit(1);
}

// 3. 上游 commit / 是否带未提交改动（本地的"快速迭代"工作区通常是脏的，
//    此时 vendor 进来的是未发布代码，记录在案以便对不上时能溯源）。
//    先走 git，失败时退回直接读 .git —— 受限沙箱里子进程的管道 stdio 会
//    EPERM，如果只信 spawnSync 会把 commit 记成 null、把脏工作区记成干净。
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
function gitDirOf(r) {
  const p = join(r, '.git');
  if (!existsSync(p)) return null;
  if (statSync(p).isDirectory()) return p;
  const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(p, 'utf8'));
  return m ? resolve(r, m[1].trim()) : null;
}
function commitOf(r) {
  const res = git(['rev-parse', 'HEAD']);
  const out = res.status === 0 ? (res.stdout || '').trim() : '';
  if (out) return out;
  const gd = gitDirOf(r);
  if (!gd) return null;
  const head = readFileSync(join(gd, 'HEAD'), 'utf8').trim();
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return head || null; // detached HEAD
  const refPath = join(gd, m[1]);
  if (existsSync(refPath)) return readFileSync(refPath, 'utf8').trim() || null;
  const packed = join(gd, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (ref === m[1] && sha) return sha;
    }
  }
  return null;
}
const commit = commitOf(repo);
const statusRes = git(['status', '--porcelain']);
const dirty = statusRes.status === 0
  ? (statusRes.stdout || '').trim().split('\n').filter(Boolean).length
  : null; // null = 无法判定（不是"干净"）
const version = typeof pkg.version === 'string' ? pkg.version : null;

// 4. 收集文件清单（跳过 .git / node_modules，大小写不敏感，Windows 开发）。
function walk(dir, base = '') {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const abs = join(dir, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(abs, rel));
    else if (ent.isFile()) out.push({ rel, size: statSync(abs).size });
  }
  return out;
}
const files = [];
for (const rel of entries) {
  const abs = join(repo, rel);
  if (statSync(abs).isDirectory()) files.push(...walk(abs, rel));
  else files.push({ rel, size: statSync(abs).size });
}
files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
const totalBytes = files.reduce((n, f) => n + f.size, 0);

const meta = {
  upstream: UPSTREAM_URL,
  name: pkg.name,
  version,
  commit,
  dirty,
  entry: relEntry,
  bin: relBin,
  files: files.map((f) => f.rel),
};

// 5. --check：只比对当前 vendored 状态与上游是否一致。
if (CHECK) {
  const curPath = join(OUT_DIR, '.upstream.json');
  if (!existsSync(curPath)) {
    console.log('[sync-static-frame] --check：lib/static-frame/ 尚未 vendor（缺 .upstream.json）。');
    process.exit(1);
  }
  const cur = JSON.parse(readFileSync(curPath, 'utf8'));
  const changed =
    cur.commit !== meta.commit ||
    JSON.stringify(cur.files) !== JSON.stringify(meta.files) ||
    cur.entry !== meta.entry;
  if (changed) {
    console.log(`[sync-static-frame] --check：与上游不一致（vendored ${cur.commit} / ${cur.files.length} 文件 → 上游 ${meta.commit} / ${meta.files.length} 文件）。`);
    process.exit(1);
  }
  console.log(`[sync-static-frame] --check：一致（${meta.commit}，${meta.files.length} 文件）。`);
  process.exit(0);
}

// 6. 整目录覆盖替换：先删后拷，避免上游删掉的文件在插件里留成孤儿。
console.log(`[sync-static-frame] vendor ${repo} → lib/static-frame/`);
console.log(`[sync-static-frame] 上游 ${pkg.name}@${version} ${commit ? commit.slice(0, 8) : '(no git)'}${dirty > 0 ? ` +${dirty} 未提交改动` : ''}`);
if (dirty > 0) console.log('[sync-static-frame] 注意：上游工作区是脏的，本次 vendor 的是未提交代码。');
if (dirty === null) console.log('[sync-static-frame] 提示：未能执行 git（受限环境下子进程管道不可用），未提交改动状态未知。');

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
for (const rel of entries) {
  const from = join(repo, rel);
  const to = join(OUT_DIR, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
writeFileSync(join(OUT_DIR, '.upstream.json'), JSON.stringify(meta, null, 2) + '\n');

console.log(`[sync-static-frame] 完成：${files.length} 文件 / ${(totalBytes / 1024).toFixed(1)} KB（entry=${relEntry}${relBin ? `, bin=${relBin}` : ''}）。`);
console.log('[sync-static-frame] lib/static-frame/ 是构建产物，勿手改；改动请提到上游仓库后重跑本脚本。');
process.exit(0);
