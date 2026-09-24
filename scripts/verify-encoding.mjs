#!/usr/bin/env node
/**
 * 编码护栏（mojibake guard）
 *
 * 背景：`lib/scene-render-worker.mjs` 里约 67 行中文（51 行注释 + 16 行 `gpuDiag` 文案）
 * 曾是"双编码乱码"。成因已定位：一次被中断的 `main ← catchup-v0.7.5` 合并把乱码带了进来
 * ——该次合并的冲突中间态仍以**不可达 blob**（`19070f44`）留在对象库里，其中 `main` 一侧
 * 是干净原文。乱码版本还挂在 `catchup-v0.7.5` 分支上，**再次合并/rebase 就可能把它带回来**，
 * 故在此固化护栏。
 *
 * 断言：
 *   E1 发布源（lib/ src/ scripts/ docs/）中不含成片乱码：一行内出现 ≥2 个**不同**的
 *      GBK 乱码典型字，即判红（正常中文几乎不会这样）。
 *   E2 worker 的 67 行已可读：抽查若干句式存在（含 `候选只取 >`、`唯一可见层是`、
 *      `与宿主同一门禁` 等），且文件头保留成因与还原来源说明。
 *   E3 正对照：一段真实的历史乱码样本必须被判红（否则判据恒真，等于没护栏）。
 *   E4 负对照（这条是踩过的坑）：**U+9000–U+9FFF 不是"生僻区"** —— 道/都/里/重/问/间
 *      等常用字都在该区间；第一版判据"一行 ≥2 个该区间汉字即乱码"会把这些正常中文判红。
 *      本判据必须**放行**这类干净文本。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS | ' + name + (detail ? ' | ' + detail : ''));
  else { console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); failed++; }
}

// GBK 乱码典型产物字（正常中文里几乎不出现的组合）
const MARK = '锛鈥鍦閸锟鏄鐨鎶娓绾缂鍙鑳鏈璺瀹鏁鏂鏃宸鍚鐢鏉鐗鍏瀛甯闇鍥鎵绛鏌澹佺焊';
const isMojibakeLine = (line) => {
  const seen = new Set();
  for (const ch of line) if (MARK.includes(ch)) seen.add(ch);
  return seen.size >= 2;
};

// ---- E1 全仓扫描 ----
const files = [];
const walk = (dir, depth) => {
  if (depth > 6) return;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p, depth + 1); continue; }
    if (/\.(mjs|js|md)$/.test(e.name) && !/^tmp-/.test(e.name)) {
      // 本文件按设计含有乱码样本（E3 正对照）与标记字清单，故自我豁免；
      // 它的断言仍覆盖其余全部文件。
      if (p.endsWith('verify-encoding.mjs')) continue;
      files.push(p);
    }
  }
};
for (const d of ['lib', 'src', 'scripts', 'docs']) walk(d, 0);
const offenders = [];
for (const f of files) {
  let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  const bad = txt.split(/\r?\n/).filter(isMojibakeLine).length;
  if (bad) offenders.push(`${f}(${bad})`);
}
check('E1 发布源与文档中无成片乱码行', offenders.length === 0,
  `扫描 ${files.length} 文件 · 命中 ${offenders.length}${offenders.length ? ': ' + offenders.slice(0, 5).join(' ') : ''}`);

// ---- E2 已还原的句式仍在 ----
const worker = readFileSync('lib/scene-render-worker.mjs', 'utf8');
const samples = [
  '把 SceneRenderer 的同步 CPU 渲染',
  '候选只取 > 请求时刻的',
  '唯一可见层是 `dust motes` 粒子系统',
  '与宿主同一门禁',
  '场景主文件名补回:',
  '渲染完成/失败后释放 GPU 纹理',
  'A race between the merge', // 负对照用（不应存在）
];
const present = samples.slice(0, 6).filter((s) => worker.includes(s));
check('E2 worker 的还原句式齐备（抽查 6 条）', present.length === 6, `${present.length}/6 命中`);
check('E2b 文件头保留成因与来源说明（blob 19070f44）', worker.slice(0, 1200).includes('19070f44'));

// ---- E3 正对照：真实历史乱码样本必须判红 ----
const realMojibake = '// 鍦烘櫙甯ф覆鏌?worker: 鎶?SceneRenderer 鐨勫悓姝?CPU 娓叉煋绉诲埌 worker 绾跨▼,';
check('E3 正对照：历史乱码样本被判红', isMojibakeLine(realMojibake));

// ---- E4 负对照：U+9000–U+9FFF 里的常用字不得误判 ----
const cleanCommon = '// 都道里重问间部长集难点零需雨（这些字都在 U+9000–U+9FFF 区间，但完全正常）';
const cleanText = '// 场景帧渲染 worker: 把 SceneRenderer 的同步 CPU 渲染移到 worker 线程,';
check('E4 负对照：含 U+9000–U+9FFF 常用字的正常中文被放行',
  !isMojibakeLine(cleanCommon) && !isMojibakeLine(cleanText));

console.log(failed === 0 ? '\nverify-encoding: OK' : `\nverify-encoding: ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
