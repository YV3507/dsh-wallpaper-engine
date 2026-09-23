/**
 * survey-default-scenes.mjs — 把 WE 全部 defaultprojects 的 2D 图层布局摊平成表:
 * 正交尺寸 / 相机 eye / 每个 image 对象的 origin、sprite 尺寸、相对正交矩形的
 * 归一化中心位置（x/W, y/H 与 (x-W/2)/W 两种约定各算一遍）。
 * 目的: 用**数据**判定官方正交坐标约定（原点在左下 vs 原点在中心）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\projects\\defaultprojects';
const rows = [];
for (const name of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const sp = path.join(dir, 'scene.json');
  if (!fs.existsSync(sp)) continue;
  let sc;
  try { sc = JSON.parse(fs.readFileSync(sp, 'utf8')); } catch { continue; }
  const gen = sc.general || {};
  const ortho = gen.orthogonalprojection;
  const eye = sc.camera ? String(sc.camera.eye || '').trim().split(/\s+/).map(Number) : null;
  const objs = (sc.objects || []).filter((o) => o.image || o.model);
  console.log(`\n=== ${name}  ortho=${ortho ? ortho.width + 'x' + ortho.height : 'none'}  eye=${sc.camera ? sc.camera.eye : '-'}  objs=${objs.length}`);
  for (const o of objs) {
    const ref = o.image || o.model;
    let ow = 0, oh = 0, shader = '';
    const mp = path.join(dir, ref);
    if (fs.existsSync(mp) && ref.endsWith('.json')) {
      try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        ow = m.width || 0; oh = m.height || 0;
        if (m.material) {
          const mat = path.join(dir, m.material);
          if (fs.existsSync(mat)) { const mj = JSON.parse(fs.readFileSync(mat, 'utf8')); shader = ((mj.passes || [])[0] || {}).shader || ''; }
        }
        if (!ow && m.fullscreen) { ow = ortho ? ortho.width : 0; oh = ortho ? ortho.height : 0; shader += ' [fullscreen]'; }
        if (m.puppet) shader += ' [puppet]';
      } catch { /* */ }
    }
    const org = String(o.origin || '0 0 0').trim().split(/\s+/).map(Number);
    const scl = String(o.scale || '1 1 1').trim().split(/\s+/).map(Number);
    const W = ortho ? ortho.width : 0, H = ortho ? ortho.height : 0;
    const dw = ow * (scl[0] || 1), dh = oh * (scl[1] || 1);
    const convBL = W ? `BL(${(org[0] / W).toFixed(3)},${(org[1] / H).toFixed(3)})` : '-';
    const convC = W ? `C(${(org[0] / W + 0.5).toFixed(3)},${(org[1] / H + 0.5).toFixed(3)})` : '-';
    // 覆盖判定: 在"原点=左下"约定下, 图层是否正好覆盖整屏 (中心≈W/2,H/2 且尺寸≈W,H)
    const coversBL = W ? (Math.abs(dw - W) / W < 0.15 && Math.abs(dh - H) / H < 0.15 && Math.abs(org[0] / W - 0.5) < 0.1 && Math.abs(org[1] / H - 0.5) < 0.1) : false;
    console.log(`   ${String(o.name || o.id).padEnd(22)} ${String(shader).padEnd(16)} origin=${String(o.origin).padEnd(26)} sprite=${ow}x${oh} scaled=${Math.round(dw)}x${Math.round(dh)} 位置(左下约定)=${convBL} (中心约定)=${convC}${coversBL ? '  ←整屏覆盖' : ''}`);
    rows.push({ name, obj: o.name, shader, ow, oh, org, scl, W, H });
  }
}
const cov = rows.filter((r) => r.W && Math.abs(r.ow * r.scl[0] - r.W) / r.W < 0.15 && Math.abs(r.oh * r.scl[1] - r.H) / r.H < 0.15);
console.log(`\n整屏尺寸图层 ${cov.length} 个; 其 origin 归一化(左下约定) x 均值=${(cov.reduce((s, r) => s + r.org[0] / r.W, 0) / (cov.length || 1)).toFixed(3)} y 均值=${(cov.reduce((s, r) => s + r.org[1] / r.H, 0) / (cov.length || 1)).toFixed(3)}`);
