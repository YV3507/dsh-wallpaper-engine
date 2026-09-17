// 临时诊断 (可删): 检测渲染帧中的"硬边近均匀不透明矩形"(用户报告的白方块)。
//   用法: node scripts/tmp-rect-detect.mjs <id> [w] [h] [t] [weAssetsDir]
//   环境: DSH_RECT_SHIFT=3   每通道量化位移(默认 3 → 每通道 8 级)
//         DSH_RECT_MIN=0.30 最小面积占比%(默认 0.30)
//         DSH_RECT_JSON=1   额外输出一行 'RECTJSON {...}' 便于批量扫描
//         DSH_RECT_TOPN=6   最多打印几个命中(默认 6)
//   注意: 场景脚本引擎会改写全局 console ⇒ 只用 process.stdout.write。
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer, encodePng } from '../lib/scene-renderer.js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2] || '3641860575';
const W = parseInt(process.argv[3] || '960', 10);
const H = parseInt(process.argv[4] || '540', 10);
const T = parseFloat(process.argv[5] || '2.5');
const assetsArg = process.argv[6];
const assets = assetsArg && fs.existsSync(assetsArg) ? assetsArg : undefined;
const SHIFT = parseInt(process.env.DSH_RECT_SHIFT || '3', 10);
const MINPCT = parseFloat(process.env.DSH_RECT_MIN || '0.30');
const TOPN = parseInt(process.env.DSH_RECT_TOPN || '6', 10);
const out = (...a) => { try { process.stdout.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n'); } catch { /* ignore */ } };
const rgb = (r, g, b) => `rgb(${r},${g},${b})`;

const abs = path.join(ROOT, id, 'scene.pkg');
if (!fs.existsSync(abs)) { out(`无 scene.pkg: ${abs}`); process.exit(2); }

// ---- 渲染 ----
const r = new SceneRenderer(abs, { width: W, height: H, time: T, weAssetsDir: assets, log: () => {} });
let cv;
try { cv = r.render(); }
catch (e) { out(`渲染抛异常: ${e && (e.stack || e.message)}`); process.exit(1); }

const w = cv.w, h = cv.h, d = cv.data, n = w * h;

// ---- 帧整体统计 ----
let aOpaque = 0, sr = 0, sg = 0, sb = 0;
for (let i = 0; i < n; i++) { const o = i * 4; if (d[o + 3] >= 250) aOpaque++; sr += d[o]; sg += d[o + 1]; sb += d[o + 2]; }
out(`== id=${id} ${w}x${h} t=${T} shift=${SHIFT} ==`);
out(`帧: 不透明(a>=250)=${(aOpaque / n * 100).toFixed(1)}%  全帧均值 ${rgb((sr / n) | 0, (sg / n) | 0, (sb / n) | 0)}`);

// ---- 量化 + 4 邻域连通域 ----
// key 同时包含 alpha 桶, 因此只有"同一量化色 + 同一 alpha 桶"才连通。
const key = new Int32Array(n);
const seen = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const o = i * 4;
  key[i] = (d[o] >> SHIFT) << 15 | (d[o + 1] >> SHIFT) << 10 | (d[o + 2] >> SHIFT) << 5 | (d[o + 3] >> 5);
}
const stack = new Int32Array(n);
const minArea = Math.max(16, Math.ceil(n * MINPCT / 100));
const comps = [];

for (let s = 0; s < n; s++) {
  if (seen[s]) continue;
  const k = key[s];
  let sp = 0; stack[sp++] = s; seen[s] = 1;
  let area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  let asr = 0, asg = 0, asb = 0, aa = 0, amin = 255, amax = 0;
  const members = [];
  while (sp > 0) {
    const i = stack[--sp];
    area++; members.push(i);
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    const o = i * 4;
    asr += d[o]; asg += d[o + 1]; asb += d[o + 2]; aa += d[o + 3];
    const a = d[o + 3]; if (a < amin) amin = a; if (a > amax) amax = a;
    if (x > 0 && !seen[i - 1] && key[i - 1] === k) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !seen[i + 1] && key[i + 1] === k) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && !seen[i - w] && key[i - w] === k) { seen[i - w] = 1; stack[sp++] = i - w; }
    if (y < h - 1 && !seen[i + w] && key[i + w] === k) { seen[i + w] = 1; stack[sp++] = i + w; }
  }
  if (area < minArea) continue;
  const mR = asr / area, mG = asg / area, mB = asb / area, mA = aa / area;
  // 内部均匀度: 每通道 max-min (未量化)
  let lo = 255, hi = 0;
  for (const i of members) { const o = i * 4; for (let c = 0; c < 3; c++) { const v = d[o + c]; if (v < lo) lo = v; if (v > hi) hi = v; } }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const fill = area / (bw * bh);
  // 边界: 从 bbox 向外第 k 像素层(chebyshev 距离 k)的平均色; 由它算台阶与"硬度"
  const ringK = (k) => {
    let cnt = 0, s1 = 0, s2 = 0, s3 = 0;
    const ax0 = x0 - k, ax1 = x1 + k, ay0 = y0 - k, ay1 = y1 + k;
    for (let y = ay0; y <= ay1; y++) {
      if (y < 0 || y >= h) continue;
      for (let x = ax0; x <= ax1; x++) {
        if (x < 0 || x >= w) continue;
        if (x > ax0 && x < ax1 && y > ay0 && y < ay1) continue; // 只留扩展框的周界
        const o = (y * w + x) * 4; cnt++; s1 += d[o]; s2 += d[o + 1]; s3 += d[o + 2];
      }
    }
    if (!cnt) return null;
    const mr = s1 / cnt, mg = s2 / cnt, mb = s3 / cnt;
    return { cnt, mr, mg, mb, step: (Math.abs(mr - mR) + Math.abs(mg - mG) + Math.abs(mb - mB)) / 3 };
  };
  const prof = [1, 2, 3, 4].map(ringK);
  const r1 = prof[0], r2 = prof[1];
  // 硬度 = 全部色差中落在第 1 像素层的比例 (硬边 → 接近 1); 总差 < 3 视为无台阶
  const far = prof[3] || prof[2] || prof[1];
  const totalDiff = far ? (Math.abs(far.mr - mR) + Math.abs(far.mg - mG) + Math.abs(far.mb - mB)) / 3 : 0;
  const hardness = totalDiff > 3 && r1 ? Math.min(1, r1.step / totalDiff) : 0;
  comps.push({
    area, x0, y0, x1, y1, bw, bh, fill, mR, mG, mB, mA, amin, amax, lo, hi,
    r1, r2, prof, totalDiff, hardness, touches: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1,
  });
}

// 排序: 优先"硬边台阶大 + 硬度高 + 填充率高 + 不透明 + 面积大"
const score = (c) => (c.r1 ? Math.min(c.r1.step, 120) : 0) * Math.pow(c.fill, 2) * Math.sqrt(c.area) * (c.mA >= 250 ? 1 : 0.05) * (0.25 + 0.75 * c.hardness);
comps.sort((a, b) => score(b) - score(a));

out(`命中(area>=${MINPCT}% = ${minArea}px, 按 [台阶×fill²×硬度×√面积] 排序, 共 ${comps.length}):`);
if (!comps.length) out('  (无)');
const json = [];
for (const c of comps.slice(0, TOPN)) {
  const st = c.r1 ? c.r1.step.toFixed(1) : 'n/a';
  const st2 = c.r2 ? c.r2.step.toFixed(1) : 'n/a';
  const ringTxt = c.r1 ? rgb(c.r1.mr | 0, c.r1.mg | 0, c.r1.mb | 0) : 'edge';
  out(`  bbox=(${c.x0},${c.y0})-(${c.x1},${c.y1}) ${c.bw}x${c.bh} area=${(c.area / n * 100).toFixed(2)}% ` +
      `mean=${rgb(c.mR | 0, c.mG | 0, c.mB | 0)} a=${c.mA.toFixed(0)} fill=${c.fill.toFixed(3)} ` +
      `inRange=${c.lo}-${c.hi} step1=${st} step2=${st2} hard=${c.hardness.toFixed(2)} tot=${c.totalDiff.toFixed(1)} ` +
      `ring1=${ringTxt}${c.touches ? ' [触边]' : ''}`);
  json.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, bw: c.bw, bh: c.bh, areaPct: +(c.area / n * 100).toFixed(3), fill: +c.fill.toFixed(3), mean: [c.mR | 0, c.mG | 0, c.mB | 0], alpha: +c.mA.toFixed(0), step1: c.r1 ? +c.r1.step.toFixed(1) : null, step2: c.r2 ? +c.r2.step.toFixed(1) : null, hardness: +c.hardness.toFixed(2), totalDiff: +c.totalDiff.toFixed(1), prof: c.prof.map((p) => (p ? [(p.mr | 0), (p.mg | 0), (p.mb | 0)] : null)), inRange: [c.lo, c.hi], touches: c.touches });
}
if (process.env.DSH_RECT_JSON) out('RECTJSON ' + JSON.stringify({ id, w, h, t: T, opaquePct: +(aOpaque / n * 100).toFixed(1), hits: json }));
// ASCII 纯度图: 每个格子 = 纯白(>=t)像素占比 0-9
if (process.env.DSH_RECT_MAP) {
  const thr = parseInt(process.env.DSH_RECT_MAP, 10) || 250;
  const CHARS = ' .:-=+*#%@';
  const CW = Math.max(1, Math.round(w / 96)), CH = Math.max(1, Math.round(h / 30));
  const rows = [];
  for (let by = 0; by < h; by += CH) {
    let line = '';
    for (let bx = 0; bx < w; bx += CW) {
      let c = 0, t = 0;
      for (let y = by; y < Math.min(h, by + CH); y++) for (let x = bx; x < Math.min(w, bx + CW); x++) { const o = (y * w + x) * 4; t++; if (d[o] >= thr && d[o + 1] >= thr && d[o + 2] >= thr && d[o + 3] >= 250) c++; }
      let idx = ((c * 10) / t) | 0; if (idx < 0) idx = 0; if (idx > 10) idx = 10;
      line += CHARS.charAt(idx);
    }
    rows.push(String(by).padStart(4) + '|' + line);
  }
  out(`纯白图 (>=${thr}, x轴 0..${w} 每格${CW}px, y轴每格${CH}px):`);
  for (const l of rows) out(l);
}
if (process.env.DSH_RECT_PNG) {
  try { fs.writeFileSync(process.env.DSH_RECT_PNG, encodePng(w, h, d)); out(`(PNG 已写 ${process.env.DSH_RECT_PNG})`); }
  catch (e) { out('(写 PNG 失败: ' + e.message + ')'); }
}
