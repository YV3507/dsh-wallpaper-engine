// 层可见性回归 (纯数学): 官方 animationlayers 的 visible 三形态 (true/{value}/{script})
// 都必须被判定为可见; 旧实现只认前两种 → 脚本驱动层被整层丢弃。
// 断言: 皓风琦【羽】N=7 / 十字架=3 / nv=8 层可见; 普拉娜人物=2; Christmas snow 各=1。
import fs from 'node:fs';
import path from 'node:path';
import { parsePkg, readPkgEntry } from '../lib/pkg-extract.js';
import { isLayerVisible } from '../lib/we-renderer/puppet.js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
if (!fs.existsSync(ROOT)) { console.log('skip: 壁纸目录不存在'); process.exit(0); }
const EXPECT = {
  3640755971: { N: 7, 十字架: 3, nv: 8 },
  3461168300: { 人物: 2, 后发: 1 },
  3655429099: { 手部组合: 1, '08眼组': 1, '02眉毛': 1 },
};
let fail = 0;
for (const [id, want] of Object.entries(EXPECT)) {
  const data = fs.readFileSync(path.join(ROOT, id, 'scene.pkg'));
  const idx = parsePkg(data);
  const sj = idx.find((e) => /scene[.]json/i.test(e.path));
  const scene = JSON.parse(readPkgEntry(data, sj).toString('utf8'));
  const got = {};
  for (const o of scene.objects) {
    if (!o.animationlayers || !o.animationlayers.length) continue;
    const vis = o.animationlayers.filter(isLayerVisible).length;
    const objName = (o.name || String(o.id)).trim();
    if (objName in want) {
      got[objName] = vis;
      const ok = vis === want[objName];
      if (!ok) fail++;
      console.log(`${ok ? '✓' : '✗'} [${id}] ${objName}: 可见层 ${vis}/${o.animationlayers.length} (期望 ${want[objName]})`);
    }
  }
  for (const k of Object.keys(want)) if (!(k in got)) { fail++; console.log(`✗ [${id}] 未找到层对象 "${k}"`); }
}
console.log(`\n层可见性检查失败 ${fail}`);
process.exit(fail ? 1 : 0);
