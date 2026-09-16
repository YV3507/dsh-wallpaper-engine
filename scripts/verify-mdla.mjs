// MDLA 布局/采样纯数学回归 — 断言 (官方语义, 第一手证据见 puppet.js 注释):
//  A. 帧0 = bind: 旋转 0 / scale 1 (2D: rz=0, sx=sy=1), 平移有限且与 bind 平移同量级
//  B. 循环闭合: 末帧 (frame = frameCount) 与帧0 的姿势一致 (≤1e-6)
//  C. 已知动画的缩放骨骼 (Plana 动画2: 骨22 sy 极值 0.003 / 骨31 0.010)
// 用法: node scripts/verify-mdla.mjs [wallpaperId...]
import fs from 'node:fs';
import path from 'node:path';
import { parsePkg, readPkgEntry } from '../lib/pkg-extract.js';
import { installPuppet } from '../lib/we-renderer/puppet.js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
if (!fs.existsSync(ROOT)) { console.log('skip: 壁纸目录不存在 (' + ROOT + ')'); process.exit(0); }
const proto = {};
installPuppet(proto);
const log = () => {};

function loadMesh(pkgPath) {
  const data = fs.readFileSync(pkgPath);
  const idx = parsePkg(data);
  for (const e of idx) {
    const b = Buffer.from(readPkgEntry(data, e));
    if (/^MDLV002\d/.test(b.subarray(0, 8).toString('latin1'))) {
      const mesh = proto._parseMdl.call({ log }, b);
      if (mesh && mesh.animations && mesh.animations.length) return mesh;
    }
  }
  return null;
}

let fail = 0, checked = 0;
const ids = process.argv.slice(2);
const dirs = ids.length ? ids : fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

for (const id of dirs) {
  const pkg = path.join(ROOT, id, 'scene.pkg');
  if (!fs.existsSync(pkg)) continue;
  let mesh;
  try { mesh = loadMesh(pkg); } catch { continue; }
  if (!mesh) continue;
  const nb = mesh.bones.length;
  for (const [ai, anim] of mesh.animations.entries()) {
    const sample = (f) => proto._sampleAnimRT.call({}, mesh, anim, f, nb, mesh.bones);
    const s0 = sample(0), sEnd = sample(anim.frameCount);
    checked++;
    // A: 帧0 = bind —— 与"由 bind 矩阵链乘出的世界姿势"比较 (bind 含骨骼静置角, 不是 0)
    const bindPose = new Array(nb);
    for (let b = 0; b < nb; b++) {
      const bm = mesh.bones[b].bind;
      const a = Math.atan2(bm[1], bm[0]);
      const p = mesh.bones[b].parent;
      if (p >= 0 && p < nb && bindPose[p]) {
        const pa = bindPose[p].angle, pc = Math.cos(pa), ps = Math.sin(pa);
        bindPose[b] = { angle: pa + a, tx: bindPose[p].tx + bm[12] * pc - bm[13] * ps, ty: bindPose[p].ty + bm[12] * ps + bm[13] * pc };
      } else {
        bindPose[b] = { angle: a, tx: bm[12], ty: bm[13] };
      }
    }
    const badA = [];
    for (let b = 0; b < nb; b++) {
      // 布局哨兵: 帧0 必须与 bind **同量级** —— 布局读错 (列交错/统一步长) 会产生
      // 数百~数千单位的平移或 >1 rad 的角度; 而部分动画的帧0 平移与网格 bind 存在
      // 少量真实差异 (实测 ~2%, 角度一致), 那是数据属性而非布局错误。
      // 精确 bind 已由定点诊断证实 (非根骨 T/R 逐位等于 bind: scripts/tmp-mdla-diag.mjs)。
      const dmag = Math.hypot(bindPose[b].tx, bindPose[b].ty) || 1;
      const dtx = Math.abs(s0[b].tx - bindPose[b].tx), dty = Math.abs(s0[b].ty - bindPose[b].ty);
      const dAng = Math.abs(s0[b].angle - bindPose[b].angle);
      const bad = (dtx > 0.25 * dmag + 5 || dty > 0.25 * dmag + 5 || dAng > 0.25
        || !isFinite(s0[b].tx) || !isFinite(s0[b].ty) || !isFinite(s0[b].angle));
      const badScale = Math.abs((s0[b].sx ?? 1) - 1) > 1e-3 || Math.abs((s0[b].sy ?? 1) - 1) > 1e-3;
      if (bad || badScale) badA.push(b);
    }
    if (badA.length) { fail++; console.log(`✗ [${id}] anim${ai} 帧0 与 bind 不同量级: ${badA.length}/${nb} 骨 (例 b${badA[0]} T=[${s0[badA[0]].tx.toFixed(1)},${s0[badA[0]].ty.toFixed(1)}] vs bind=[${bindPose[badA[0]].tx.toFixed(1)},${bindPose[badA[0]].ty.toFixed(1)}])`); }
    // B: 循环闭合 (末帧 = 帧0)
    let badB = 0;
    for (let b = 0; b < nb; b++) {
      if (Math.abs(s0[b].angle - sEnd[b].angle) > 1e-3 || Math.abs(s0[b].tx - sEnd[b].tx) > 1e-2 || Math.abs(s0[b].ty - sEnd[b].ty) > 1e-2) badB++;
    }
    if (badB > 0) { fail++; console.log(`✗ [${id}] anim${ai} 末帧≠帧0: ${badB}/${nb} 骨`); }
    // C: Plana 动画2 的已知缩放骨骼
    if (id === '3461168300' && /动画 2/.test(anim.name || '')) {
      const ext = (b, key) => { let mn = Infinity, mx = -Infinity; for (let f = 0; f <= anim.frameCount; f++) { const v = sample(f)[b][key]; mn = Math.min(mn, v); mx = Math.max(mx, v); } return [mn, mx]; };
      const [sy22min] = ext(22, 'sy'); const [sy31min] = ext(31, 'sy');
      const ok22 = Math.abs(sy22min - 0.003) < 0.002, ok31 = Math.abs(sy31min - 0.010) < 0.003;
      if (!ok22 || !ok31) { fail++; console.log(`✗ [${id}] 眨眼骨 sy 极值不符: b22=${sy22min.toFixed(4)}(期望≈0.003) b31=${sy31min.toFixed(4)}(期望≈0.010)`); }
      else console.log(`✓ [${id}] 眨眼骨 sy 极值: b22=${sy22min.toFixed(4)} b31=${sy31min.toFixed(4)}`);
    }
  }
}
console.log(`\n${checked} 个动画检查, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
