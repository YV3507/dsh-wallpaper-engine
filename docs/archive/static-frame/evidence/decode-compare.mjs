// 归档证据脚本: 在同一批贴图字节上对比"合成路径"与"渲染器路径"的解码耗时。
// 动机: 端到端测量里渲染器 ~47ms/张、合成 ~207ms/张 (4.4x)。若属实, 先修这个比
// 剔除离屏层收益大得多; 若实测相同, 说明之前是"纹理集合不同"导致的误比。
// 用法: node docs/archive/static-frame/evidence/decode-compare.mjs [sceneId] [最多几张]
import fs from 'node:fs';
import path from 'node:path';
import { decode as decodeJpeg } from 'jpeg-js';
import { parsePkg, readPkgEntry, decodeTex } from '../../../../lib/pkg-extract.js';
import { loadTexImage } from '../../../../lib/we-renderer/textures.js';

const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2] || '3486806915';
const LIMIT = parseInt(process.argv[3] || '0', 10);

// 合成路径的 decodeTexToRgba (lib 里未导出, 按可见实现等价复刻; png-pass 分支的
// decodePngPayload 未导出, 此处只统计 rgba/jpeg 两类, 二者覆盖绝大多数场景贴图)
function compositeDecode(bytes) {
  const d = decodeTex(bytes);
  if (d.kind === 'rgba') return d;
  if (d.kind === 'jpeg') {
    const j = decodeJpeg(Buffer.from(d.bytes), { useTArray: true, maxResolutionInMP: 64 });
    return { width: j.width, height: j.height, rgba: j.data };
  }
  return null;
}

const src = path.join(ROOT, id, 'scene.pkg');
const pkgData = new Uint8Array(fs.readFileSync(src));
const entries = parsePkg(pkgData);
let texEntries = entries.filter((e) => e.path.toLowerCase().endsWith('.tex'));
if (LIMIT > 0) texEntries = texEntries.slice(0, LIMIT);
console.log(`场景 ${id}: .tex 条目 ${entries.filter((e) => e.path.toLowerCase().endsWith('.tex')).length} 个, 本次测 ${texEntries.length} 个\n`);
console.log('贴图'.padEnd(52) + '尺寸'.padEnd(14) + '合成解码'.padEnd(12) + '渲染解码'.padEnd(12) + '比值');

let sumC = 0, sumR = 0, n = 0, wall = 0;
for (const e of texEntries) {
  let bytes;
  try { bytes = readPkgEntry(pkgData, e); } catch { continue; }
  if (!bytes || bytes.length < 32) continue;

  let c = null, r = null;
  const t0 = Date.now();
  try { c = compositeDecode(bytes); } catch { c = null; }
  const tc = Date.now() - t0;
  const t1 = Date.now();
  try { r = loadTexImage(bytes); } catch { r = null; }
  const tr = Date.now() - t1;
  if (c) { sumC += tc; wall += tc; }
  if (r) { sumR += tr; wall += tr; }
  if (c || r) n++;
  const dims = c ? `${c.width}x${c.height}` : (r ? `${r.width}x${r.height}` : '?');
  const ratio = tc > 0 && tr > 0 ? (tc / tr).toFixed(2) : '-';
  const name = e.path.replace(/^materials\//, '').slice(0, 50);
  console.log(name.padEnd(52) + dims.padEnd(14) + (tc + 'ms').padEnd(12) + (tr + 'ms').padEnd(12) + ratio);
}

console.log('');
console.log(`可解码 ${n} 张:  合成路径合计 ${sumC}ms (${(sumC / Math.max(1, n)).toFixed(0)}ms/张)   ` +
  `渲染器路径合计 ${sumR}ms (${(sumR / Math.max(1, n)).toFixed(0)}ms/张)   总墙钟 ${wall}ms`);
console.log('注: 两条路径都是 decodeTex 打底; 差异只可能在 jpeg/png 分支的解码参数上。');
