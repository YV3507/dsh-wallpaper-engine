#!/usr/bin/env node
/**
 * 「按 DXT 块区域解码动画图集单帧」的逐字节等价守卫。
 *
 * 该优化的唯一合法性来源是：结果必须与「整图解码后再裁剪」完全相同 —— 不是
 * 近似、不是目视相似。这里用纯数学对照来证明它（不依赖任何真实素材、不依赖
 * 目视判断）：
 *
 *   1. decodeDxtRegion(整块流, rect)  ===  crop(decodeDxt*(整块流), rect)
 *      覆盖 DXT1/DXT3/DXT5，含块对齐、非块对齐、跨块、右下角、整图五种矩形。
 *   2. 负对照：把矩形错位 1px，结果必须**不**相等 —— 证明上面的比较不是空转。
 *   3. 越界矩形 / 非压缩格式必须返回 null（调用方据此回退整图解码，绝不近似）。
 *   4. atlasFrameRect 与原 image.js 内联帧选择公式逐字段相同 —— 两条路径
 *      （加载时只解码该帧 / 加载整图后裁剪）共用同一帧矩形。
 *
 * 覆盖范围说明：本脚本不构造 TEX 容器，因此不覆盖「容器解析 → isAnimatedGif
 * 门控 → 图集像素阈值门控」这一段；那部分由真实场景的渲染对照负责
 * （docs/SCENE-FRAME-PERF.md §二十七）。
 */
import fs from 'node:fs';
import {
  decodeDxt1, decodeDxt3, decodeDxt5, decodeDxtRegion, TexFormat,
} from '../lib/pkg-extract.js';
import { atlasFrameRect } from '../lib/we-renderer/textures.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  — ' + detail : ''));
}

// 确定性伪随机 (xorshift32)，保证可复现
function makeBytes(n, seed) {
  let x = seed >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= (x << 13) >>> 0; x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function crop(rgba, srcWidth, rect) {
  const out = new Uint8Array(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y++) {
    const s = ((rect.y + y) * srcWidth + rect.x) * 4;
    out.set(rgba.subarray(s, s + rowBytes), y * rowBytes);
  }
  return out;
}

function eqBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── 1/2/3. 块区域解码 vs 整图裁剪 ────────────────────────────────
const W = 64;
const H = 48;
const FORMATS = [
  { name: 'DXT5', fmt: TexFormat.DXT5, dec: decodeDxt5, blockBytes: 16 },
  { name: 'DXT1', fmt: TexFormat.DXT1, dec: decodeDxt1, blockBytes: 8 },
  { name: 'DXT3', fmt: TexFormat.DXT3, dec: decodeDxt3, blockBytes: 16 },
];
const RECTS = [
  { x: 0, y: 0, width: 4, height: 4, label: '单块' },
  { x: 4, y: 8, width: 20, height: 12, label: '块对齐' },
  { x: 2, y: 6, width: 21, height: 13, label: '非对齐+跨块' },
  { x: W - 4, y: H - 4, width: 4, height: 4, label: '右下角' },
  { x: 0, y: 0, width: W, height: H, label: '整图' },
];
for (const f of FORMATS) {
  const blocksX = Math.ceil(W / 4);
  const blocksY = Math.ceil(H / 4);
  const src = makeBytes(blocksX * blocksY * f.blockBytes, 0x51ed + f.blockBytes);
  const full = f.dec(src, W, H);
  for (const r of RECTS) {
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    const got = decodeDxtRegion(src, W, H, rect, f.fmt);
    const want = crop(full, W, rect);
    check(`${f.name} 区域解码 == 整图裁剪 (${r.label} ${r.width}x${r.height}@${r.x},${r.y})`,
      eqBytes(got, want), got ? got.length + ' 字节' : '返回 null');
  }
  // 负对照：错位 1px 必须不相等，否则说明比较本身没有区分力
  const shifted = decodeDxtRegion(src, W, H, { x: 8, y: 8, width: 16, height: 16 }, f.fmt);
  const wrong = crop(full, W, { x: 9, y: 8, width: 16, height: 16 });
  check(`${f.name} 负对照: 错位 1px 必须不相等`, !eqBytes(shifted, wrong), '证明比较有区分力');
  // 回退条件：越界 → null（调用方回退整图解码，绝不夹取近似）
  check(`${f.name} 越界矩形返回 null`,
    decodeDxtRegion(src, W, H, { x: W - 2, y: 0, width: 8, height: 4 }, f.fmt) === null, '回退整图');
  check(`${f.name} 负坐标矩形返回 null`,
    decodeDxtRegion(src, W, H, { x: -4, y: 0, width: 8, height: 4 }, f.fmt) === null, '回退整图');
  check(`${f.name} 零面积矩形返回 null`,
    decodeDxtRegion(src, W, H, { x: 0, y: 0, width: 0, height: 4 }, f.fmt) === null, '回退整图');
}
check('非压缩格式返回 null（不允许区域解码）',
  decodeDxtRegion(makeBytes(1024, 7), W, H, { x: 0, y: 0, width: 4, height: 4 }, 9999) === null, '回退整图');

// ── 4. atlasFrameRect 与原内联公式等价 ──────────────────────────
// 原 image.js 内联逻辑（重构前逐行照抄），作为对照基准
function legacyRect(texWidth, texHeight, frames, t) {
  const count = frames.length;
  const duration = frames[0].frametime || 0.1;
  const frameIdx = Math.floor(t / duration) % count;
  const f = frames[frameIdx];
  const fw = f.width || Math.floor(texWidth / count);
  const fh = f.height || texHeight;
  const fx = f.x || frameIdx * fw;
  const fy = f.y || 0;
  return { index: frameIdx, x: fx, y: fy, width: fw, height: fh };
}

// 情形 A：真实形态（鸟_00020 型）——显式帧尺寸 + 显式图集偏移
const atlasW = 7680;
const atlasH = 7920;
const framesA = [];
for (let i = 0; i < 56; i++) {
  framesA.push({ imageId: i, frametime: 0.0333, x: (i % 4) * 1920, y: Math.floor(i / 4) * 720, width: 1920, height: 720 });
}
// 情形 B：无帧尺寸/无偏移/无 frametime —— 走全部兜底分支
const framesB = [];
for (let i = 0; i < 5; i++) framesB.push({ imageId: i });

for (const [label, frames, info] of [
  ['显式帧元数据', framesA, { width: atlasW, height: atlasH, frames: framesA }],
  ['兜底帧元数据', framesB, { width: 500, height: 100, frames: framesB }],
]) {
  for (const t of [0, 0.02, 0.1, 0.35, 1, 3.7, 123.456]) {
    const got = atlasFrameRect(info, t);
    const want = legacyRect(info.width, info.height, frames, t);
    const ok = !!got && got.index === want.index && got.x === want.x && got.y === want.y &&
      got.width === want.width && got.height === want.height;
    check(`atlasFrameRect 等价原公式 (${label}, t=${t})`, ok,
      got ? `idx=${got.index} ${got.width}x${got.height}@${got.x},${got.y}` : '返回 null');
  }
}
check('单帧/无帧元数据返回 null',
  atlasFrameRect({ width: 64, height: 64, frames: [{ imageId: 0 }] }, 0) === null &&
  atlasFrameRect({ width: 64, height: 64, frames: null }, 0) === null &&
  atlasFrameRect(null, 0) === null, '不触发按帧解码');

// ── 5. 落盘门控（这一段正是曾经漏掉、导致静默损坏的那一类） ────────
// 事故复盘: 区域解码返回 1920x720, 但 loadTexImage 的「逻辑尺寸裁剪 (DXT
// padding)」把它当成 padding 重新按图集 7680x7920 解读并补零 —— 产出损坏纹理,
// 且没有任何报错。当时本守卫只测解码器, 所以全绿通过。以下检查补上这一层。
const texSrc = fs.readFileSync(new URL('../lib/we-renderer/textures.js', import.meta.url), 'utf8');
const coreSrc = fs.readFileSync(new URL('../lib/we-renderer/core.js', import.meta.url), 'utf8');
const PAD_GATE = /if \(!frameDecoded && \(width !== info\.width/;
const FRAMES_GATE = /if \(!frameDecoded && info\.frames/;

check('loadTexImage: padding 裁剪被 frameDecoded 门控', PAD_GATE.test(texSrc), '防止把帧缓冲当图集重新解读');
check('loadTexImage: 按帧解码后不再暴露 frames', FRAMES_GATE.test(texSrc), '防止上层二次裁剪');
check('loadTexImage: 尺寸不符时抛错而非静默损坏', /按帧解码结果尺寸不符/.test(texSrc), '运行时兜底');
check('core.js: 帧索引进入缓存键', /cacheKey = texPath \+ '#' \+ rect\.index/.test(coreSrc), '防止多帧复用串帧');
check('core.js: 区域解码结果被计数核验', /_atlasFrameDecodes/.test(coreSrc), '可取证是否真的生效');

// 负对照: 把门控从源码里剥掉后, 上面的判据必须变假 —— 证明检查器有区分力
const stripped = texSrc.replace(/!frameDecoded && /g, '');
check('负对照: 剥掉门控后判据变假 (检查器非恒真)',
  !PAD_GATE.test(stripped) && !FRAMES_GATE.test(stripped), '证明能抓到回归');

// ── 6. parseTex 复用 (省掉一次整容器解压) ───────────────────────
// 压缩容器的解压是顺序的且很贵 (60.8Mpx 图集约 250ms)。此前同一个容器被解压
// 三遍: core 算帧矩形一次 + loadTexImage 一次 + decodeTex 内部一次。
check('loadTexImage 接受调用方已解析的 info (避免重复解压)',
  /export function loadTexImage\(raw, opts, infoPre\)/.test(texSrc), '压缩容器解压很贵');
check('core.js 复用 parseTex 结果并留 A/B 开关',
  /DSH_WE_NO_TEX_PARSE_REUSE/.test(coreSrc) && /loadTexImage\(raw, frameOpts, reuse/.test(coreSrc),
  '可回归验证');
check('core.js: 帧表元数据按 texPath 记忆 (避免每个实例都解压整容器)',
  /this\._atlasMeta/.test(coreSrc) && /if \(!meta\) \{/.test(coreSrc),
  '实测: 6 个实例各解压 60.8Mpx ≈ 1500ms 纯浪费');
check('core.js: 记忆的是帧表元数据而非整容器解析结果 (不留 60.8MB)',
  /meta = \{ width: info\.width, height: info\.height, frames:/.test(coreSrc),
  '常驻内存不可接受');

console.log(`\n动画图集按帧解码守卫: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
