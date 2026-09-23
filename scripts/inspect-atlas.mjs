#!/usr/bin/env node
/**
 * 诊断: 列出场景内所有「动画图集」纹理的**真实帧表**, 用来判定
 * 「只解码当前帧」优化的实际适用面 (docs/SCENE-FRAME-PERF.md §二十八)。
 *
 * 要回答的问题:
 *   帧矩形是否落在 parseTex 报告的图集范围内? 若大量帧的 x+w / y+h 超出
 *   图集宽高, 说明容器是多页 (imageCount > 1) 或帧坐标不在 mip0 空间 ——
 *   此时 decodeDxtRegion 会安全回退整图解码, 收益按**在范围内**的帧数缩水。
 *
 * 用法: node scripts/inspect-atlas.mjs <workshopId> [--scan-all]
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPkg } from '../lib/we-renderer/textures.js';
import { parseTex, TexFormat } from '../lib/pkg-extract.js';

const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const argv = process.argv.slice(2);
const scanAll = argv.includes('--scan-all');
const ids = argv.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  console.log('用法: node scripts/inspect-atlas.mjs <workshopId> [...] [--scan-all]');
  process.exit(2);
}

const fmtName = (v) => {
  for (const [k, n] of Object.entries(TexFormat || {})) if (n === v) return k;
  return 'fmt#' + v;
};

function inspectTex(name, raw) {
  const info = parseTex(raw);
  const frames = info.frames || [];
  if (frames.length <= 1) return null;
  const count = frames.length;
  let inRange = 0;
  let minX = Infinity; let minY = Infinity; let maxR = 0; let maxB = 0;
  const sizes = new Map();
  for (const f of frames) {
    const w = f.width || Math.floor(info.width / count);
    const h = f.height || info.height;
    const x = f.x || 0;
    const y = f.y || 0;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxR = Math.max(maxR, x + w); maxB = Math.max(maxB, y + h);
    if (x >= 0 && y >= 0 && x + w <= info.width && y + h <= info.height) inRange++;
    const k = w + 'x' + h;
    sizes.set(k, (sizes.get(k) || 0) + 1);
  }
  const frameMpx = (() => {
    // 取出现次数最多的帧尺寸
    let best = null; let n = -1;
    for (const [k, c] of sizes) if (c > n) { n = c; best = k; }
    const [w, h] = best.split('x').map(Number);
    return w * h / 1e6;
  })();
  return {
    name, bytes: raw.length, format: fmtName(info.format),
    atlasW: info.width, atlasH: info.height,
    atlasMpx: info.width * info.height / 1e6,
    frameCount: count, sizes: [...sizes.entries()].map(([k, c]) => k + '×' + c).join(', '),
    inRange, maxR, maxB, frameMpx,
    imageCount: info.imageCount, mipLevels: info.mipLevels,
    savingsX: inRange ? (info.width * info.height) / (sizes.size ? frameMpx * 1e6 : 1) : 0,
  };
}

for (const id of ids) {
  const src = path.join(ROOT, id, 'scene.pkg');
  if (!fs.existsSync(src)) { console.log(`场景 ${id}: 找不到 ${src}`); continue; }
  const pkg = readPkg(src);
  const texEntries = pkg.entries().filter((e) => /\.tex$/i.test(e.name));
  console.log(`\n=== 场景 ${id} ===  (共 ${texEntries.length} 个 .tex)`);
  let atlasCount = 0;
  for (const e of texEntries) {
    let raw = null;
    try { raw = pkg.read(e.name); } catch { continue; }
    if (!raw) continue;
    let r = null;
    try { r = inspectTex(e.name, raw); } catch { continue; }
    if (!r) { if (!scanAll) continue; console.log(`  ${e.name}: 非动画`); continue; }
    atlasCount++;
    const fits = r.inRange === r.frameCount;
    console.log(`  ${e.name}`);
    console.log(`    格式 ${r.format}  mip=${r.mipLevels}  imageCount=${r.imageCount}`);
    console.log(`    图集 ${r.atlasW}x${r.atlasH} = ${r.atlasMpx.toFixed(1)} Mpx   帧数 ${r.frameCount}   帧尺寸 ${r.sizes}`);
    console.log(`    帧表范围: x∈[${r.maxR === 0 ? 0 : 0}, ${r.maxR}) y∈[0, ${r.maxB})  vs 图集 ${r.atlasW}x${r.atlasH}`);
    console.log(`    **落在图集内的帧: ${r.inRange}/${r.frameCount}**  ${fits ? '(全部)'
      : '<-- 越界帧会安全回退整图解码, 收益缩水'}`);
    const ratio = r.frameMpx / r.atlasMpx;
    console.log(`    单帧占图集 ${(ratio * 100).toFixed(2)}%  ⇒ 理论解码倍数 ${(1 / ratio).toFixed(1)}×`
      + `  (实际可用 ${(r.inRange / r.frameCount / ratio).toFixed(1)}×)`);
  }
  console.log(`  动画图集数: ${atlasCount}`);
}
