#!/usr/bin/env node
/**
 * 前提测量: 剩余解码时间花在**哪些纹理**上, 以及它们是否可并行 (DXT/raw)。
 * 这是「异步预解码 pass」是否值得做的直接依据 —— 不靠假设。
 * 用法: node scripts/inspect-decode-cost.mjs <workshopId>
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPkg, loadTexImage } from '../lib/we-renderer/textures.js';
import { parseTex, TexFormat } from '../lib/pkg-extract.js';

const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2];
if (!id) { console.log('用法: node scripts/inspect-decode-cost.mjs <workshopId>'); process.exit(2); }
const pkg = readPkg(path.join(ROOT, id, 'scene.pkg'));

const fmtName = (v) => { for (const [k, n] of Object.entries(TexFormat)) if (n === v) return k; return 'fmt#' + v; };

const rows = [];
let total = 0;
for (const e of pkg.entries()) {
  if (!/\.tex$/i.test(e.name)) continue;
  let raw = null;
  try { raw = pkg.read(e.name); } catch { continue; }
  if (!raw) continue;
  let info = null;
  try { info = parseTex(raw); } catch { continue; }
  const t0 = performance.now();
  let img = null;
  let err = null;
  try { img = loadTexImage(raw); } catch (ex) { err = ex.message; }
  const ms = performance.now() - t0;
  total += ms;
  rows.push({
    name: e.name, ms, w: info.width, h: info.height,
    mpx: info.width * info.height / 1e6,
    fmt: err ? 'ERR' : fmtName(info.format),
    frames: (info.frames || []).length,
    err,
  });
}
rows.sort((a, b) => b.ms - a.ms);
console.log(`场景 ${id}: ${rows.length} 个 .tex, 冷解码合计 ${total.toFixed(0)}ms (串行)\n`);
console.log('排名  解码ms   Mpx    尺寸           格式    帧数  路径');
rows.slice(0, 18).forEach((r, i) => {
  console.log(`${String(i + 1).padStart(3)}  ${r.ms.toFixed(0).padStart(6)}  ${r.mpx.toFixed(2).padStart(6)}  `
    + `${(r.w + 'x' + r.h).padEnd(14)} ${r.fmt.padEnd(7)} ${String(r.frames).padStart(4)}  ${r.name}`
    + (r.err ? '  ERR=' + r.err : ''));
});
const top5 = rows.slice(0, 5).reduce((a, r) => a + r.ms, 0);
console.log(`\n前 5 名合计 ${top5.toFixed(0)}ms = 全部解码的 ${(100 * top5 / total).toFixed(1)}%`);
const dxt = rows.filter((r) => /^DXT/.test(r.fmt));
console.log(`DXT 纹理 ${dxt.length}/${rows.length} 个, 合计 ${dxt.reduce((a, r) => a + r.ms, 0).toFixed(0)}ms`
  + ` —— 这部分可块行并行`);
const nonDxt = rows.filter((r) => !/^DXT/.test(r.fmt));
console.log(`非 DXT ${nonDxt.length} 个, 合计 ${nonDxt.reduce((a, r) => a + r.ms, 0).toFixed(0)}ms`
  + ` —— 不可行切分, 留给同步路径`);
const parallel = dxt.filter((r) => r.mpx >= 2);
console.log(`其中 >=2Mpx 的 DXT ${parallel.length} 个, 合计 ${parallel.reduce((a, r) => a + r.ms, 0).toFixed(0)}ms`
  + `  ← 预解码 pass 的目标集合`);
