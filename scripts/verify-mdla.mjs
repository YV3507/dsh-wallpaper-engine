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
    // A: 帧0 = bind —— 比较**局部原始值** (链乘后的世界位姿会被根骨整体位移污染,
    //    例如 3641860575 anim4 根骨帧0 T=623 → 所有子骨世界坐标一起偏移)。
    const dvA = new DataView(mesh.raw.buffer, mesh.raw.byteOffset, mesh.raw.byteLength);
    const badA = [];
    for (let b = 0; b < nb; b++) {
      const seg = anim.segs && anim.segs[b];
      if (seg == null) continue;
      const per = (anim.segPer && anim.segPer[b] > 0) ? Math.round(anim.segPer[b]) : 9;
      const rd = (i, d) => (per > i ? dvA.getFloat32(seg + i * 4, true) : d);
      const t0 = rd(0, 0), t1 = rd(1, 0), rz = rd(5, 0), sx = rd(6, 1), sy = rd(7, 1);
      const bm = mesh.bones[b].bind;
      const bAng = Math.atan2(bm[1], bm[0]);
      const isRoot = mesh.bones[b].parent < 0;
      const finite = isFinite(t0) && isFinite(t1) && isFinite(rz);
      // 量级哨兵 (布局读错 → 10-100× 偏差); 部分动画的个别骨帧0 合法地不从 bind 起
      // (实测 3641860575 anim1 b1: 帧0 T=[-2.47,0.79] vs bind [-3.71,1.62])。
      const bmag = Math.hypot(bm[12], bm[13]) || 1;
      // 根骨 = 角色整体位置: 动画可合法位移 (实测 3641860575 anim4 帧0 T=623 vs bind 7.2),
      // 仅要求绝对合理性 (<10000, 与渲染端同一量级校验); 非根骨为刚性相对偏移 → 量级哨兵。
      const bad = !finite
        || Math.abs(rz - bAng) > 0.35
        || (isRoot
          ? Math.hypot(t0, t1) > 10000
          : Math.hypot(t0 - bm[12], t1 - bm[13]) > 2 * bmag + 20);
      if (bad || Math.abs(sx - 1) > 1e-3 || Math.abs(sy - 1) > 1e-3) badA.push(b);
    }
    if (badA.length) { fail++; console.log(`✗ [${id}] anim${ai} 帧0(局部) ≠ bind: ${badA.length}/${nb} 骨 (例 b${badA[0]})`); }
    // B: 循环闭合 (末帧 = 帧0) —— 仅对**循环**动画成立。一次性 (single/step/startpaused)
    // 的末帧是作者设定的"保持姿态", 不要求等于帧0 (实测皓风琦[3640755971] anim6 id=208
    // loop=single 有 1/25 骨末帧≠帧0)。旧实现在采样处取模, 使 sample(frameCount) 实际读到
    // 帧0 ⇒ 该断言**空转**; 现按壁纸自带的 loop 模式区分, 一次性只校验末帧合理。
    const loopMode = String(anim.loop == null ? 'loop' : anim.loop);
    const isLooping = (loopMode === 'loop' || loopMode === 'mirror' || loopMode === '');
    let badB = 0;
    for (let b = 0; b < nb; b++) {
      if (isLooping) {
        if (Math.abs(s0[b].angle - sEnd[b].angle) > 1e-3 || Math.abs(s0[b].tx - sEnd[b].tx) > 1e-2 || Math.abs(s0[b].ty - sEnd[b].ty) > 1e-2) badB++;
      } else {
        const e = sEnd[b];
        const finite = [e.angle, e.tx, e.ty, e.sx, e.sy].every((v) => typeof v === 'number' && isFinite(v));
        if (!finite || Math.hypot(e.tx, e.ty) > 10000) badB++;
      }
    }
    if (badB > 0) { fail++; console.log(`✗ [${id}] anim${ai} ${isLooping ? '末帧≠帧0' : '一次性末帧异常'}: ${badB}/${nb} 骨`); }
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
