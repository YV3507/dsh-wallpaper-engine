// 归档证据脚本: 多层合成路径的分阶段耗时剖析。
// 用法: node docs/archive/static-frame/evidence/composite-profile.mjs [sceneId...]   (默认扫全库)
//
// ⚠️ 本脚本在当前仓库**不可运行**：它 import 的 lib/we-renderer/profile.js 已随静态帧渲染器
//    迁往独立仓库 https://github.com/YV3507/we-static-frame，本仓库不再包含该模块。
//    保留于此仅作 SCENE-FRAME-PERF.md §十三「真正的大头：合成路径没有解码缓存」的历史实测证据。
process.env.DSH_WE_PROFILE = '1'; // 必须在 import 之前 (profile.js 在模块加载时读)

import fs from 'node:fs';
import path from 'node:path';

const { extractSceneMainImage } = await import('../../../../lib/pkg-extract.js');
const { profFormat, profReset } = await import('../../../../lib/we-renderer/profile.js');

const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const ids = process.argv.slice(2);
const SCENES = ids.length
  ? ids
  : fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'scene.pkg')))
      .map((d) => d.name).sort();

for (const id of SCENES) {
  const src = path.join(ROOT, id, 'scene.pkg');
  if (!fs.existsSync(src)) continue;
  profReset();
  let frame = null, ms = 0, err = null;
  try {
    const buf = fs.readFileSync(src);
    const t0 = Date.now();
    frame = extractSceneMainImage(new Uint8Array(buf));
    ms = Date.now() - t0;
  } catch (e) { err = e.message; }
  const kind = err ? '提取失败' : (frame ? frame.texturePath : 'null');
  console.log(`\n########## ${id}  ${ms}ms  ${kind}`);
  if (err) { console.log('  ' + err); continue; }
  console.log(profFormat(ms));
}
