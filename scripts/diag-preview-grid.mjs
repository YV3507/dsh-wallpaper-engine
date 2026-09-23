/**
 * diag-preview-grid.mjs — 官方 preview 图的**数学画像**（不看图、不靠眼睛）:
 *   - 尺寸 / 与清屏色的接近比例 / 非清屏包围盒
 *   - 8x6 网格占用位图（文本形式, 可逐格比较）
 *   - 每列 / 每行的非清屏占比（一维剖面, 用于判定平移/裁切类错误）
 * 用法: node scripts/diag-preview-grid.mjs [scene...]
 */
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\projects\\defaultprojects';
const ALL = ['razer_bedroom', 'eagleflag', 'dna_fragment', 'deep_space', 'arsenal', 'beach'];
const argv = process.argv.slice(2);
const scenes = argv.filter((a) => ALL.includes(a));
const list = scenes.length ? scenes : ALL;

function decodePreview(dir) {
  for (const f of ['preview.jpg', 'preview.jpeg']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const raw = jpeg.decode(fs.readFileSync(p), { useTArray: true, formatAsRGBA: true });
      return { file: f, w: raw.width, h: raw.height, data: raw.data };
    }
  }
  for (const f of ['preview.gif', 'preview.png']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return { file: f, w: 0, h: 0, data: null, note: '非 JPEG (本脚本不解析 GIF/PNG)' };
  }
  return null;
}

for (const name of list) {
  const dir = path.join(ROOT, name);
  const proj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const scenePath = path.join(dir, proj.file || 'scene.json');
  let clear = [0, 0, 0];
  if (fs.existsSync(scenePath)) {
    const sc = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    const cc = sc.general && sc.general.clearcolor;
    if (cc) clear = cc.trim().split(/\s+/).map((v) => Math.round(parseFloat(v) * 255));
  }
  const d = decodePreview(dir);
  console.log(`\n${'='.repeat(66)}\n### ${name}   preview=${d ? d.file : 'none'}  clear=rgb(${clear})`);
  if (!d || !d.data) { console.log(`  ${d ? d.note : '无 preview'}`); continue; }
  const { w, h, data } = d;
  console.log(`  尺寸 ${w}x${h} aspect=${(w / h).toFixed(3)}`);

  const isClear = (i) => Math.abs(data[i] - clear[0]) <= 6 && Math.abs(data[i + 1] - clear[1]) <= 6 && Math.abs(data[i + 2] - clear[2]) <= 6;
  let clearN = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  const colProf = new Array(w).fill(0), rowProf = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isClear(i)) { clearN++; continue; }
      colProf[x]++; rowProf[y]++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const n = w * h;
  console.log(`  清屏色占比=${(clearN / n * 100).toFixed(2)}%  非清屏 bbox=[${minX},${minY},${maxX},${maxY}] (占比 x:${(minX / w * 100).toFixed(0)}%-${(maxX / w * 100).toFixed(0)}%, y:${(minY / h * 100).toFixed(0)}%-${(maxY / h * 100).toFixed(0)}%)`);

  // 8x6 网格占用
  const GX = 8, GY = 6;
  let grid = '';
  for (let gy = 0; gy < GY; gy++) {
    let row = '    ';
    for (let gx = 0; gx < GX; gx++) {
      const x0 = Math.floor(gx * w / GX), x1 = Math.floor((gx + 1) * w / GX);
      const y0 = Math.floor(gy * h / GY), y1 = Math.floor((gy + 1) * h / GY);
      let c = 0, t = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { t++; if (!isClear((y * w + x) * 4)) c++; }
      const p = c / t;
      row += (p > 0.98 ? '#' : p > 0.75 ? '+' : p > 0.4 ? '-' : p > 0.08 ? '.' : ' ') + ' ';
    }
    grid += row + '\n';
  }
  console.log('  网格占用 (#>98% +>75% ->40% .>8% 空):');
  console.log(grid.trimEnd());

  // 一维剖面（16 段）
  const seg = (prof, len) => Array.from({ length: 16 }, (_, i) => {
    const a = Math.floor(i * len / 16), b = Math.floor((i + 1) * len / 16);
    let c = 0; for (let k = a; k < b; k++) c += prof[k];
    return Math.round(c / (b - a) / h * 100);
  });
  const segY = (prof, len) => Array.from({ length: 16 }, (_, i) => {
    const a = Math.floor(i * len / 16), b = Math.floor((i + 1) * len / 16);
    let c = 0; for (let k = a; k < b; k++) c += prof[k];
    return Math.round(c / (b - a) / w * 100);
  });
  console.log(`  列剖面(左→右, %非清屏): ${seg(colProf, w).join(' ')}`);
  console.log(`  行剖面(上→下, %非清屏): ${segY(rowProf, h).join(' ')}`);
}
