import fs from 'node:fs';
import path from 'node:path';
import { decodeTex } from '../../lib/pkg-extract.js';
import { decodePngBuffer } from '../../lib/we-renderer/canvas.js';

const ROOT = 'E:/SteamLibrary/steamapps/common/wallpaper_engine/projects/defaultprojects';
const worst = []; let n = 0, ok = 0, mismatch = 0;
for (const name of fs.readdirSync(ROOT)) {
  const mats = path.join(ROOT, name, 'materials');
  if (!fs.existsSync(mats)) continue;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(mats);
  for (const png of files.filter((f) => f.toLowerCase().endsWith('.png'))) {
    const tex = png.replace(/\.png$/i, '.tex');
    if (!fs.existsSync(tex)) continue;
    let a, b;
    try { a = decodePngBuffer(fs.readFileSync(png)); b = decodeTex(fs.readFileSync(tex)); } catch { continue; }
    if (!b || !b.rgba || a.width !== b.width || a.height !== b.height) { mismatch++; continue; }
    const s = [0, 0, 0, 0]; const N = a.width * a.height;
    for (let i = 0; i < N; i++) for (let c = 0; c < 4; c++) s[c] += Math.abs(a.rgba[i * 4 + c] - b.rgba[i * 4 + c]);
    const d = s.map((v) => v / N); n++;
    if (Math.max(...d) <= 2) ok++;
    worst.push({ name: name + '/' + path.basename(png), d: d.map((v) => v.toFixed(1)) });
  }
}
worst.sort((x, y) => Math.max(...y.d.map(Number)) - Math.max(...x.d.map(Number)));
console.log('同尺寸对照对数=' + n + '  逐通道平均差≤2 的=' + ok + '  尺寸不同(跳过)=' + mismatch);
console.log('最差 12 对 (ΔR,ΔG,ΔB,ΔA):');
for (const w of worst.slice(0, 12)) console.log('  ' + w.name.padEnd(46), w.d.join(','));

