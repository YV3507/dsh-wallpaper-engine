// 临时探针 (gitignored): 多层合成路径的分阶段耗时剖析。
// 用法: node docs/evidence/composite-profile.mjs [sceneId...]   (默认扫全库)
process.env.DSH_WE_PROFILE = '1'; // 必须在 import 之前 (profile.js 在模块加载时读)

import fs from 'node:fs';
import path from 'node:path';

const { extractSceneMainImage } = await import('../../lib/pkg-extract.js');
const { profFormat, profReset } = await import('../../lib/we-renderer/profile.js');

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
