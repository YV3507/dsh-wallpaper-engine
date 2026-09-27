// 验证 cat11/RW0 蒙皮: 用 _parseMdl 解析 + _skinPuppet 蒙皮, 检查蒙皮后包围盒
// 是否合理 (blendIndices/blendWeights 偏移错误会炸飞顶点)
//
// ⚠️ 路径**不能硬编码**：此前写死 `C:/Program Files (x86)/Steam/...`，而本机（及多数用户）
// 的库在 E: 等非默认盘 ⇒ 脚本直接 ENOENT、跑不起来却没人发现。现在按候选列表探测，
// 并允许环境变量覆盖：DSH_WE_WS / DSH_WE_WE / DSH_WE_DIAG_OUT。
import { SceneRenderer } from '../lib/scene-renderer.js';
import fs from 'node:fs';
import path from 'node:path';

const firstExisting = (cands) => cands.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
const WS = process.env.DSH_WE_WS || firstExisting([
  'E:/SteamLibrary/steamapps/workshop/content/431960',
  'D:/SteamLibrary/steamapps/workshop/content/431960',
  'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960',
  'C:/Program Files/Steam/steamapps/workshop/content/431960',
]);
const WE = process.env.DSH_WE_WE || firstExisting([
  'E:/SteamLibrary/steamapps/common/wallpaper_engine',
  'D:/SteamLibrary/steamapps/common/wallpaper_engine',
  'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine',
  'C:/Program Files/Steam/steamapps/common/wallpaper_engine',
]);
const OUT = path.resolve(process.env.DSH_WE_DIAG_OUT || '.test-cache/angel-diag');
if (!WS || !WE) {
  console.error('找不到 Wallpaper Engine 库 / 安装目录；用 DSH_WE_WS 与 DSH_WE_WE 指定后重跑。');
  console.error('  WS=' + WS + '  WE=' + WE);
  process.exit(1);
}
const scenePkg = path.join(WS, '3641860575', 'scene.pkg');
if (!fs.existsSync(scenePkg)) {
  console.error('缺少 Angel Mail（工坊 3641860575）: ' + scenePkg);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const logs = [];
const r = new SceneRenderer(scenePkg, { width: 480, height: 270, time: 8.033, weAssetsDir: WE, log: (m) => logs.push(String(m)) });
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
