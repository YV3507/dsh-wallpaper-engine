#!/usr/bin/env node
// 直接对真实纹理验证「按帧解码」是否真的生效 —— 不经过渲染器, 排除上层干扰。
// 用法: node scripts/tmp-atlas-direct.mjs <workshopId> <pkg内tex路径> [时间秒]
import fs from 'node:fs';
import path from 'node:path';
import { readPkg } from '../lib/we-renderer/textures.js';
import { parseTex, decodeTex, TexFormat } from '../lib/pkg-extract.js';
import { atlasFrameRect } from '../lib/we-renderer/textures.js';

const P = (s) => process.stdout.write(s + '\n');
const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2];
const texPath = process.argv[3] || 'materials/鸟_00020.tex';
const t = parseFloat(process.argv[4] || '2.5');

const pkg = readPkg(path.join(ROOT, id, 'scene.pkg'));
const raw = pkg.read(texPath);
if (!raw) { P('读不到 ' + texPath); process.exit(2); }

const info = parseTex(raw);
const idx = Object.entries(TexFormat).find(([, v]) => v === info.format);
P(`tex=${texPath}`);
P(`容器字节=${raw.length}  图集=${info.width}x${info.height}  format=${idx ? idx[0] : info.format}`);
P(`isAnimatedGif=${info.isAnimatedGif}  帧数=${(info.frames || []).length}  mipLevels=${info.mipLevels}  imageCount=${info.imageCount}`);

// DXT5/DXT1/DXT3 的 mip0 期望字节数
const bx = Math.ceil(info.width / 4);
const by = Math.ceil(info.height / 4);
P(`mip0 期望字节(DXT5)=${bx * by * 16}  (DXT1)=${bx * by * 8}`);
P(`容器字节 - 期望 = ${raw.length - bx * by * 16}  (>0 说明容器比单页 mip0 还大)`);

const rect = atlasFrameRect(info, t);
P(`t=${t} → 帧矩形=${JSON.stringify(rect)}`);

const dec = decodeTex(raw, rect ? { frameRect: rect } : undefined);
P(`decodeTex(frameRect) → kind=${dec.kind} 尺寸=${dec.width}x${dec.height}`);
P(dec.width === (rect && rect.width) && dec.height === (rect && rect.height)
  ? '**按帧解码生效**' : '**按帧解码未生效(已回退整图)**');

// 逐位一致校验: 整图解码 → 裁 rect, 与区域解码对比
if (rect) {
  const full = decodeTex(raw);
  if (full.kind === 'rgba' && full.width === info.width && full.height === info.height) {
    let diff = 0;
    const rowBytes = rect.width * 4;
    for (let y = 0; y < rect.height && diff === 0; y++) {
      const s = ((rect.y + y) * full.width + rect.x) * 4;
      const want = full.rgba.subarray(s, s + rowBytes);
      const got = dec.rgba.subarray(y * rowBytes, y * rowBytes + rowBytes);
      for (let i = 0; i < rowBytes; i++) if (want[i] !== got[i]) { diff++; break; }
    }
    P(`逐位一致(区域解码 vs 整图裁剪): ${diff === 0 ? '一致 ✓' : '不一致 ✗ 差异行=' + diff}`);
  } else {
    P(`整图解码对照不可用: kind=${full.kind} ${full.width}x${full.height}`);
  }
}
