// 临时判定 (可删): 离线运行真实 SceneRenderer 并采集其日志 —— 查"为什么只剩背景蓝"。
//   用法: node scripts/tmp-render-diag.mjs [id] [w] [h] [t]
//   注意: 场景脚本引擎可能改写全局 console ⇒ 一律用 process.stdout.write 输出。
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer, encodePng } from '../lib/scene-renderer.js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2] || '3641860575';
const W = parseInt(process.argv[3] || '960', 10);
const H = parseInt(process.argv[4] || '540', 10);
const T = parseFloat(process.argv[5] || '2.5');
const abs = path.join(ROOT, id, 'scene.pkg');
const assets = process.argv[6] && fs.existsSync(process.argv[6]) ? process.argv[6] : undefined;
const out = (...a) => { try { process.stdout.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n'); } catch { /* ignore */ } };

const logs = [];
const t0 = Date.now();
const r = new SceneRenderer(abs, { width: W, height: H, time: T, weAssetsDir: assets, log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) });
let canvas;
try {
  // 诊断用: DSH_DIAG_SKIP=名字子串[,名字...] → 渲染前把这些对象置为不可见 (A/B 定位)
  const skip = (process.env.DSH_DIAG_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (skip.length && r.objects) {
    for (const o of r.objects) if (skip.some((s) => String(o.name || '').includes(s))) o.visible = false;
    out(`(诊断: 已隐藏 ${skip.join('/')})`);
  }
  canvas = r.render();
} catch (e) { out(`渲染抛异常: ${e && (e.stack || e.message)}`); process.exit(1); }
out(`渲染完成 ${canvas.w}x${canvas.h} 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  日志条数=${logs.length}`);

const color = new Map();
let n = 0, sr = 0, sg = 0, sb = 0;
for (let i = 0; i < canvas.w * canvas.h; i += Math.max(1, Math.floor(canvas.w * canvas.h / 40000))) {
  const o = i * 4;
  sr += canvas.data[o]; sg += canvas.data[o + 1]; sb += canvas.data[o + 2]; n++;
  const k = (canvas.data[o] >> 3) << 10 | (canvas.data[o + 1] >> 3) << 5 | (canvas.data[o + 2] >> 3);
  color.set(k, (color.get(k) || 0) + 1);
}
out(`均值 rgb(${(sr / n).toFixed(0)},${(sg / n).toFixed(0)},${(sb / n).toFixed(0)})  抽样唯一色=${color.size}`);
for (const [k, c] of [...color.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  out(`   rgb(${((k >> 10) & 31) << 3},${((k >> 5) & 31) << 3},${(k & 31) << 3}) ${(c / n * 100).toFixed(1)}%`);
}

const pat = new Map();
for (const l of logs) {
  const key = l.replace(/\d+(\.\d+)?/g, 'N').replace(/'[^']*'/g, "'X'").slice(0, 150);
  if (!pat.has(key)) pat.set(key, { c: 0, ex: l });
  pat.get(key).c++;
}
out(`\n=== 日志模式 (${pat.size} 种) ===`);
out('RT 表: ' + (r._rtTex ? r._rtTex.size + ' 项 [' + [...r._rtTex.keys()].slice(0, 8).join(', ') + ']' : 'n/a'));
// 诊断: DSH_DUMP_OBJ=<对象名> → 导出该对象合成后的图像为 PNG + 统计其形状
if (process.env.DSH_DUMP_OBJ && r._rtTex) {
  const hit = r._rtTex.get('obj:' + process.env.DSH_DUMP_OBJ);
  if (!hit) { out(`DSH_DUMP_OBJ ${process.env.DSH_DUMP_OBJ}: RT 表中无此对象 (仅 DSH_RT_ALL=1 时收集)`); }
  else {
    let cov = 0, n2 = 0; const set = new Set();
    for (let i = 0; i < hit.width * hit.height; i++) { const q = i * 4; n2++; if (hit.rgba[q + 3] > 8) cov++; set.add(`${hit.rgba[q] >> 3},${hit.rgba[q + 1] >> 3},${hit.rgba[q + 2] >> 3},${hit.rgba[q + 3] >> 6}`); }
    out(`DSH_DUMP_OBJ ${process.env.DSH_DUMP_OBJ}: ${hit.width}x${hit.height} alpha覆盖=${(cov / n2 * 100).toFixed(1)}% 抽样色组=${set.size}`);
    try { const { encodePng } = await import('../lib/scene-renderer.js'); fs.writeFileSync('.tmp-obj.png', encodePng(hit.width, hit.height, hit.rgba)); out('(已写 .tmp-obj.png)'); } catch (e) { out('(写 .tmp-obj.png 失败: ' + e.message + ')'); }
  }
}
for (const [k, v] of [...pat.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, 30)) {
  out(`  ${String(v.c).padStart(4)}x  ${k}`);
  out(`        例: ${String(v.ex).slice(0, 190)}`);
}
// 输出画布 PNG (便于人工核对)
try {
  const { encodePng } = await import('../lib/scene-renderer.js');
  fs.writeFileSync('.tmp-render-diag.png', encodePng(canvas.w, canvas.h, canvas.data));
  out(`(画布已写 .tmp-render-diag.png ${canvas.w}x${canvas.h})`);
} catch (e) { out(`(写 PNG 失败: ${e && e.message})`); }
// 诊断: DSH_DIAG_TEX=<模型 json 路径> → 用渲染器自己的 loadModelTexture 取贴图并统计
// (渲染器的取纹理路径可能与离线 decodeTex 不同, 需以它为准)
if (process.env.DSH_DIAG_TEX) {
  try {
    const tex = r.loadModelTexture(process.env.DSH_DIAG_TEX);
    if (!tex) { out(`DSH_DIAG_TEX ${process.env.DSH_DIAG_TEX}: loadModelTexture 返回 null`); }
    else {
      const set = new Map();
      let a0 = 0, n2 = 0, sr2 = 0, sg2 = 0, sb2 = 0;
      for (let i = 0; i < tex.width * tex.height; i += Math.max(1, Math.floor(tex.width * tex.height / 20000))) {
        const o = i * 4;
        if (tex.rgba[o + 3] < 8) a0++;
        sr2 += tex.rgba[o]; sg2 += tex.rgba[o + 1]; sb2 += tex.rgba[o + 2]; n2++;
        const k = (tex.rgba[o] >> 3) << 10 | (tex.rgba[o + 1] >> 3) << 5 | (tex.rgba[o + 2] >> 3);
        set.set(k, (set.get(k) || 0) + 1);
      }
      const top2 = [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      out(`DSH_DIAG_TEX ${process.env.DSH_DIAG_TEX}: ${tex.width}x${tex.height} 抽样唯一色=${set.size} 透明占比=${(a0 / n2 * 100).toFixed(1)}% 均值 rgb(${(sr2 / n2).toFixed(0)},${(sg2 / n2).toFixed(0)},${(sb2 / n2).toFixed(0)})`);
      for (const [k, c] of top2) out(`   主色 rgb(${((k >> 10) & 31) << 3},${((k >> 5) & 31) << 3},${(k & 31) << 3}) ${(c / n2 * 100).toFixed(1)}%`);
    }
  } catch (e) { out(`DSH_DIAG_TEX 失败: ${e && e.message}`); }
}

