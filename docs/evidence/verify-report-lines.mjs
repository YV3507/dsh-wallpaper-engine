// 逐条回读报告中引用的 lib 行号 (最后复核)
import fs from 'node:fs';
const CITE = [
  ['we-renderer/model.js', [14, 16, 26, 29, 32, 38, 40, 43, 210, 227, 240, 242, 247, 276, 279, 282, 289, 340, 504, 526, 773, 890, 891, 967, 1011, 1020, 1116, 1142, 1143, 1144, 1149, 1150, 1151, 1158, 1189, 1190, 1194, 1217, 1220, 1297, 1298, 1313, 1331, 1359, 1390, 1422, 1563, 1630, 1667, 1778, 1795, 1830, 1846, 1857, 1874, 1889, 1961]],
  ['we-renderer/image.js', [14, 49, 99, 132, 137, 144, 150, 152, 160, 165, 171, 181, 279, 293, 295, 363, 365, 368, 394, 468, 502, 534, 538, 559, 655, 709]],
  ['we-renderer/particles.js', [81, 98, 104, 106, 108, 109, 121]],
  ['we-renderer/effects.js', [44]],
  ['we-renderer/scene/graph.js', [42]],
  ['we-renderer/core.js', [349]],
  ['pkg-extract.js', [1067, 1070, 1085, 1092, 1694]],
  ['scene-manifest.js', [1060, 1078, 1116, 1132, 1184, 1189, 1192, 1195]],
  ['scene-render-worker.mjs', [140, 149, 166, 170, 172, 266, 419, 428]],
  ['scene-player.js', [1318, 1319, 1320, 1321, 1327, 1328, 1475, 1502, 1518, 1732, 1770]],
];
for (const [rel, lines] of CITE) {
  const p = 'lib/' + rel;
  const src = fs.readFileSync(p, 'utf8').split('\n');
  console.log('=== ' + p + '  (total ' + src.length + ')');
  for (const n of lines) console.log('  ' + String(n).padStart(5) + ': ' + (src[n - 1] || '<<超出文件>>').trim().slice(0, 150));
}
