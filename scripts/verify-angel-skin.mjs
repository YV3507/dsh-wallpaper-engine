// 验证 cat11/RW0 蒙皮: 用 _parseMdl 解析 + _skinPuppet 蒙皮, 检查蒙皮后包围盒
// 是否合理 (blendIndices/blendWeights 偏移错误会炸飞顶点)
import { SceneRenderer } from '../lib/scene-renderer.js';
import fs from 'node:fs';
import path from 'node:path';

const WS = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960';
const WE = 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine';
const OUT = path.resolve('D:/dsh-wallpaper-engine/.tmp-diag2');
const logs = [];
const r = new SceneRenderer(path.join(WS, '3641860575', 'scene.pkg'), { width: 480, height: 270, time: 8.033, weAssetsDir: WE, log: (m) => logs.push(String(m)) });
const out = [];

for (const name of ['models/cat11_puppet.mdl', 'models/RW0_puppet.mdl']) {
  const mdlRaw = r.pkg.read(name);
  const mesh = r._parseMdl(mdlRaw);
  if (!mesh) { out.push(`${name}: 解析失败`); continue; }
  // 蒙皮 (默认动画层, 绑定姿态或动画0)
  let skinned;
  try {
    skinned = r._skinPuppet(mesh, 8.033, 0, 0, null);
  } catch (e) {
    out.push(`${name}: 蒙皮异常 ${String(e.message || e).slice(0, 120)}`);
    continue;
  }
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, bad = 0;
  for (const p of skinned) {
    if (!isFinite(p[0]) || !isFinite(p[1])) { bad++; continue; }
    if (Math.abs(p[0]) > 5000 || Math.abs(p[1]) > 5000) { bad++; continue; }
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  out.push(`${name}: raw=[${mesh._rawBounds || '?'}] 蒙皮后 bbox=[${minX.toFixed(1)},${minY.toFixed(1)}]..[${maxX.toFixed(1)},${maxY.toFixed(1)}] 异常顶点=${bad}/${skinned.length}`);
  // 采样顶点权重和 (blendWeights 偏移正确性)
  let wSumOk = 0, n = 0;
  for (let i = 0; i < Math.min(mesh.vertexCount, 300); i++) {
    const w = mesh.blendWeights[i];
    const s = w[0] + w[1] + w[2] + w[3];
    if (Math.abs(s - 1) < 0.2) wSumOk++;
    n++;
  }
  out.push(`  blendWeights 和≈1: ${wSumOk}/${n}`);
  const biSample = mesh.blendIndices.slice(0, 5).map((b) => b.join(','));
  out.push(`  blendIndices 前5: ${biSample.join(' | ')}  (bones=${mesh.bones.length})`);
  const animNames = (mesh.animations || []).map((a) => `${a.name}(${a.frameCount}f@${a.fps})`).slice(0, 6).join(' ');
  out.push(`  动画: ${animNames}`);
}
fs.writeFileSync(path.join(OUT, 'angel-skin.txt'), out.join('\n'), 'utf8');
console.log('done');
