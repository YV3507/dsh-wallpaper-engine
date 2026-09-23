#!/usr/bin/env node
/**
 * 块行并行解码的逐位一致守卫 —— docs/SCENE-FRAME-PERF.md §二十九。
 *
 * 这条优化的全部合法性就是「按块行切开分别解码再拼装 == 整幅解码」。
 * 这里用纯数学对照证明它, 不依赖素材、不依赖目视。
 *
 * ★ 血的教训 (第一版真的踩了): 解码必须用 **mip0 存储尺寸** (storageWidth/Height),
 *   不是逻辑尺寸。`pkg-extract.js` 的 `decodeTex` 里是 `let {width,height,bytes}=mip0`,
 *   而 `loadTexImage` 之后再把结果裁到逻辑尺寸。二者不同时 (真实例: 逻辑 3281 /
 *   存储 3280) 块行跨距算错 → **第 0 块行看着正常, 其后每行漂移一个块**。
 *   当时本守卫只比"块对齐尺寸", 所以漏掉了。下面专门有负对照抓这一类。
 */
import fs from 'node:fs';
import {
  decodeDxt1, decodeDxt3, decodeDxt5, TexFormat,
} from '../lib/pkg-extract.js';
import { collectPredecodeCandidates } from '../lib/we-renderer/predecode.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  — ' + detail : ''));
}

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
function eqBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 与 loadTexImage 完全同一套语义: 按存储尺寸解码, 再逐行裁到逻辑尺寸 */
function wholeDecode(src, sw, sh, lw, lh, decode) {
  const full = decode(src, sw, sh);
  if (sw === lw && sh === lh) return full;
  const out = new Uint8Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) out.set(full.subarray(y * sw * 4, y * sw * 4 + lw * 4), y * lw * 4);
  return out;
}

/** 与 predecode-worker + predecode 主线程组装**完全相同**的切分/拼装数学 */
function bandedDecode(src, sw, sh, lw, lh, blockBytes, decode, nBands, shift = 0) {
  const blocksX = Math.ceil(sw / 4);
  const blocksY = Math.ceil(sh / 4);
  const out = new Uint8Array(lw * lh * 4);
  const per = Math.ceil(blocksY / nBands);
  for (let by0 = 0; by0 < blocksY; by0 += per) {
    const s0 = Math.min(blocksY, by0 + shift);
    const by1 = Math.min(blocksY, by0 + per);
    if (by1 <= s0) continue;
    const sub = src.subarray(s0 * blocksX * blockBytes, by1 * blocksX * blockBytes);
    const band = decode(sub, sw, (by1 - s0) * 4);
    const rowBytes = Math.min(sw, lw) * 4;
    const rows = Math.min((by1 - s0) * 4, lh - s0 * 4);
    for (let y = 0; y < rows; y++) {
      out.set(band.subarray(y * sw * 4, y * sw * 4 + rowBytes), (s0 * 4 + y) * lw * 4);
    }
  }
  return out;
}

const CASES = [
  { name: 'DXT5 64x48 (存储=逻辑)', sw: 64, sh: 48, lw: 64, lh: 48, fmt: TexFormat.DXT5, bb: 16, dec: decodeDxt5 },
  { name: 'DXT1 64x48 (存储=逻辑)', sw: 64, sh: 48, lw: 64, lh: 48, fmt: TexFormat.DXT1, bb: 8, dec: decodeDxt1 },
  { name: 'DXT3 64x48 (存储=逻辑)', sw: 64, sh: 48, lw: 64, lh: 48, fmt: TexFormat.DXT3, bb: 16, dec: decodeDxt3 },
  // ★ 真实形态: 存储宽 3284 (821 块) 而逻辑宽 3281 → 块列数相同, 行跨距差 4 像素。
  //   (逻辑宽必然 <= 存储宽; 反过来不可能出现, 故夹具不能造 3280/3281)
  { name: 'DXT5 存储3284/逻辑3281', sw: 3284, sh: 2160, lw: 3281, lh: 2160, fmt: TexFormat.DXT5, bb: 16, dec: decodeDxt5 },
  // 存储宽 68 (17 块) 而逻辑宽 64 (16 块) → 块列数真的不同
  { name: 'DXT5 存储68/逻辑64', sw: 68, sh: 52, lw: 64, lh: 48, fmt: TexFormat.DXT5, bb: 16, dec: decodeDxt5 },
  // 存储高非 4 倍数
  { name: 'DXT5 存储34x18/逻辑33x16', sw: 34, sh: 18, lw: 33, lh: 16, fmt: TexFormat.DXT5, bb: 16, dec: decodeDxt5 },
];

for (const c of CASES) {
  const blocksX = Math.ceil(c.sw / 4);
  const blocksY = Math.ceil(c.sh / 4);
  const src = makeBytes(blocksX * blocksY * c.bb, 0x9e37 + c.bb + c.sw);
  const whole = wholeDecode(src, c.sw, c.sh, c.lw, c.lh, c.dec);
  for (const n of [2, 3, 5, 7, blocksY]) {
    if (n > blocksY || n < 2) continue;
    const banded = bandedDecode(src, c.sw, c.sh, c.lw, c.lh, c.bb, c.dec, n);
    check(`${c.name} 带宽${n} == 整幅`, eqBytes(banded, whole), `${banded.length} 字节`);
  }
  // 负对照 A: 带起点错位 → 必须不同
  const shifted = bandedDecode(src, c.sw, c.sh, c.lw, c.lh, c.bb, c.dec, 2, 1);
  check(`${c.name} 负对照: 带起点错位必须不同`, !eqBytes(shifted, whole), '证明比较有区分力');
  // 负对照 B: 用**逻辑尺寸**当解码尺寸 → 在存储≠逻辑且块列数不同时必须不同
  const wrongBlocksX = Math.ceil(c.lw / 4);
  if (wrongBlocksX !== blocksX) {
    const wrong = new Uint8Array(c.lw * c.lh * 4);
    const per = Math.ceil(Math.ceil(c.lh / 4) / 2);
    const wrongBlocksY = Math.ceil(c.lh / 4);
    for (let by0 = 0; by0 < wrongBlocksY; by0 += per) {
      const by1 = Math.min(wrongBlocksY, by0 + per);
      const sub = src.subarray(by0 * blocksX * c.bb, by1 * blocksX * c.bb);
      const band = c.dec(sub, c.lw, (by1 - by0) * 4);
      const rows = Math.min((by1 - by0) * 4, c.lh - by0 * 4);
      for (let y = 0; y < rows; y++) {
        wrong.set(band.subarray(y * c.lw * 4, y * c.lw * 4 + c.lw * 4), (by0 * 4 + y) * c.lw * 4);
      }
    }
    check(`${c.name} 负对照: 用逻辑尺寸解码块列数会错 → 必须不同`,
      !eqBytes(wrong, whole), `块列 ${wrongBlocksX} vs 正确 ${blocksX}`);
  }
}

// ── 候选筛选健壮性 (假 pkg, 不依赖素材) ─────────────────────────
const fakePkg = {
  entries: () => ([
    { name: 'materials/garbage.tex', offset: 0, size: 8 },
    { name: 'materials/empty.tex', offset: 0, size: 0 },
    { name: 'materials/missing.tex', offset: 0, size: 4 },
    { name: 'scene.json', offset: 0, size: 4 },
  ]),
  read: (p) => {
    if (p === 'materials/garbage.tex') return Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    if (p === 'materials/empty.tex') return Buffer.alloc(0);
    return null;
  },
};
let threw = null;
let cands = null;
try { cands = collectPredecodeCandidates(fakePkg, new Map()); } catch (e) { threw = e.message; }
check('候选筛选: 不可解析条目被静默跳过而非抛错', threw === null, threw || '未抛错');
check('候选筛选: 跳过非 .tex 与缺失/空条目', Array.isArray(cands) && cands.length === 0,
  Array.isArray(cands) ? `${cands.length} 个候选` : 'null');

// ── 结构性检查 ─────────────────────────────────────────────────
const preSrc = fs.readFileSync(new URL('../lib/we-renderer/predecode.js', import.meta.url), 'utf8');
const workerSrc = fs.readFileSync(new URL('../lib/we-renderer/predecode-worker.mjs', import.meta.url), 'utf8');
const pkgSrc = fs.readFileSync(new URL('../lib/pkg-extract.js', import.meta.url), 'utf8');
check('predecode: 块跨距按存储尺寸算 (不是逻辑尺寸)',
  /Math\.ceil\(sw \/ 4\)/.test(preSrc), '第一版 bug 的直接回归护栏');
check('predecode: 候选筛选用 metaOnly 解析 (绝不解压)',
  /metaOnly: true/.test(preSrc), '扫描时解压 60.8Mpx 会白花 ~250ms');
check('worker: 自己解析容器 (解压随带宽一起并行)',
  /texMip0Info\(new Uint8Array\(srcs/.test(workerSrc), '把解压搬出主线程');
check('worker: 用 storageWidth 解码', /info\.storageWidth/.test(workerSrc), '行跨距必须用存储宽');
check('texMip0Info 暴露 storageWidth/storageHeight',
  /storageWidth: mip0\.width/.test(pkgSrc) && /storageHeight: mip0\.height/.test(pkgSrc), '单一事实来源');
check('predecode: 覆盖不全一律不插入 (残缺交给同步路径)',
  /coverage\.get\(i\) \|\| 0\) < c\.height/.test(preSrc), '宁可不用也不给半张图');
check('predecode: 排除动画图集', /info\.isAnimated \|\| info\.frames > 1/.test(preSrc), '交给 §二十七 按帧路径');
check('predecode: 排除非 DXT',
  /DXT_BLOCK_BYTES\.get\(info\.format\)/.test(preSrc), '不可块切分的不碰');
check('worker: 排除内嵌 JPEG/PNG payload',
  /0xff && b\[1\] === 0xd8/.test(workerSrc), 'payload 非块流, 需解压后才能判定');
check('parseTexInternal: metaOnly 下不读 mip0.bytes (否则整个筛选静默失败)',
  /const embedded = !mip0\.bytes/.test(pkgSrc), '实测踩过: 每张纹理都抛 null.length');
check('predecode: worker 数有上限且不占满核心',
  /MAX_WORKERS = 8/.test(preSrc) && /CORE_FRACTION = 0\.34/.test(preSrc), '低端机留核');
check('predecode worker: 只做解码并回传, 不改渲染路径',
  !/textureCache|render\(/.test(workerSrc), '不变量');

console.log(`\n块行并行守卫: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
