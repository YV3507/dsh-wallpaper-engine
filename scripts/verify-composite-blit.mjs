// 守卫: pkg-extract.js 的单趟带缩放合成 (blitLayerScaled) 必须与它取代的旧两趟路径
// (resizeBilinear → blitLayer) **逐字节等价**。
//
// 背景: 旧路径对每一层要 ① 分配一份整层尺寸的中间 RGBA 缓冲并写满 ② 再读一遍做 alpha
// 合成, 且遍历整层(画外白算)。blitLayerScaled 把重采样结果直接就地合成、只遍历与画布
// 相交的区域 —— 这是个"零观感代价"的纯性能改动, 前提就是输出一个像素都不能变。
//
// 旧实现已从 lib/ 删除, 故此处保留一份**冻结参照**(REF_*), 与 lib 的实现无关:
// lib 侧若再改采样公式/舍入/合成次序, 本脚本会失败。
//
// 用法: node scripts/verify-composite-blit.mjs
import { blitLayerScaled } from '../lib/pkg-extract.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// ── 冻结参照: 移除前的两份实现逐字复制 ────────────────────────────────────────
function REF_resizeBilinear(rgba, w, h, outW, outH) {
  const out = new Uint8Array(outW * outH * 4);
  const xRatio = w / outW;
  const yRatio = h / outH;
  for (let y = 0; y < outH; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = Math.min(Math.max(sy - y0, 0), 1);
    for (let x = 0; x < outW; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = Math.min(Math.max(sx - x0, 0), 1);
      const di = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const p00 = rgba[(y0 * w + x0) * 4 + c];
        const p10 = rgba[(y0 * w + x1) * 4 + c];
        const p01 = rgba[(y1 * w + x0) * 4 + c];
        const p11 = rgba[(y1 * w + x1) * 4 + c];
        out[di + c] = Math.round(
          p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy)
          + p01 * (1 - fx) * fy + p11 * fx * fy,
        );
      }
    }
  }
  return out;
}

function REF_blitLayer(canvas, cw, ch, rgba, w, h, x0, y0, alpha) {
  for (let y = 0; y < h; y++) {
    const cy = y0 + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < w; x++) {
      const cx = x0 + x;
      if (cx < 0 || cx >= cw) continue;
      const si = (y * w + x) * 4;
      const sa = (rgba[si + 3] / 255) * alpha;
      if (sa <= 0) continue;
      const di = (cy * cw + cx) * 4;
      const da = canvas[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      canvas[di] = Math.round((rgba[si] * sa + canvas[di] * da * (1 - sa)) / outA);
      canvas[di + 1] = Math.round((rgba[si + 1] * sa + canvas[di + 1] * da * (1 - sa)) / outA);
      canvas[di + 2] = Math.round((rgba[si + 2] * sa + canvas[di + 2] * da * (1 - sa)) / outA);
      canvas[di + 3] = Math.round(outA * 255);
    }
  }
}

/** 旧路径整体: 先重采样出整层缓冲, 再合成。 */
function referenceComposite(canvas, cw, ch, src, w, h, outW, outH, x0, y0, alpha) {
  const pixels = (outW === w && outH === h) ? src : REF_resizeBilinear(src, w, h, outW, outH);
  REF_blitLayer(canvas, cw, ch, pixels, outW, outH, x0, y0, alpha);
}

// ── 确定性 PRNG (mulberry32) — 用例可复现 ────────────────────────────────────
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(cw, ch, rng) {
  const c = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < c.length; i++) c[i] = (rng() * 256) | 0;
  return c;
}

function makeSrc(w, h, rng) {
  const s = new Uint8Array(w * h * 4);
  for (let i = 0; i < s.length; i++) s[i] = (rng() * 256) | 0;
  // 刻意混入全透明/全不透明像素, 覆盖 sa<=0 与 outA<=0 两条提前 continue 分支
  for (let p = 0; p < w * h; p += 7) s[p * 4 + 3] = 0;
  for (let p = 3; p < w * h; p += 11) s[p * 4 + 3] = 255;
  return s;
}

/** 跑一个用例, 返回 {same, diffAt} */
function runCase(cw, ch, w, h, outW, outH, x0, y0, alpha, seed) {
  const rng = makeRng(seed);
  const src = makeSrc(w, h, rng);
  const canvasRef = makeCanvas(cw, ch, rng);
  const canvasNew = Uint8Array.from(canvasRef); // 同一初始画布
  referenceComposite(canvasRef, cw, ch, src, w, h, outW, outH, x0, y0, alpha);
  blitLayerScaled(canvasNew, cw, ch, src, w, h, outW, outH, x0, y0, alpha);
  for (let i = 0; i < canvasRef.length; i++) {
    if (canvasRef[i] !== canvasNew[i]) return { same: false, diffAt: i };
  }
  return { same: true, diffAt: -1 };
}

// ── R1: 随机用例 ────────────────────────────────────────────────────────────
{
  const rng = makeRng(20260920);
  let cases = 0, bad = 0, firstBad = null;
  for (let k = 0; k < 400; k++) {
    const cw = 1 + ((rng() * 40) | 0), ch = 1 + ((rng() * 30) | 0);
    const w = 1 + ((rng() * 64) | 0), h = 1 + ((rng() * 64) | 0);
    const outW = 1 + ((rng() * 80) | 0), outH = 1 + ((rng() * 80) | 0);
    const x0 = -20 + ((rng() * (cw + 40)) | 0), y0 = -20 + ((rng() * (ch + 40)) | 0);
    const alpha = [0, 0.25, 0.5, 1][(rng() * 4) | 0];
    const r = runCase(cw, ch, w, h, outW, outH, x0, y0, alpha, 1000 + k);
    cases++;
    if (!r.same) { bad++; if (!firstBad) firstBad = `cw=${cw} ch=${ch} src=${w}x${h} out=${outW}x${outH} pos=(${x0},${y0}) α=${alpha} 首差@${r.diffAt}`; }
  }
  check(`R1 随机 ${cases} 例: blitLayerScaled 与旧两趟路径逐字节一致`,
    bad === 0, bad === 0 ? `${cases}/${cases} 一致` : `${bad} 例不一致 · 首例: ${firstBad}`);
}

// ── R2: 边界用例 ────────────────────────────────────────────────────────────
{
  const cases = [
    ['无缩放 (out == src)', 40, 30, 16, 16, 16, 16, 5, 5, 1],
    ['放大 2x', 40, 30, 8, 8, 16, 16, 4, 4, 1],
    ['缩小 4x', 40, 30, 32, 32, 8, 8, 2, 2, 1],
    ['单像素源 → 大目标', 40, 30, 1, 1, 20, 20, 3, 3, 1],
    ['目标 1x1', 40, 30, 16, 16, 1, 1, 10, 10, 1],
    ['完全在画布左上外侧', 40, 30, 8, 8, 16, 16, -100, -100, 1],
    ['完全在画布右下外侧', 40, 30, 8, 8, 16, 16, 100, 100, 1],
    ['部分越界 (左上)', 40, 30, 8, 8, 16, 16, -8, -8, 1],
    ['部分越界 (右下)', 40, 30, 8, 8, 16, 16, 32, 22, 1],
    ['正好铺满画布', 40, 30, 16, 12, 40, 30, 0, 0, 1],
    ['alpha = 0', 40, 30, 8, 8, 16, 16, 5, 5, 0],
    ['alpha = 0.5', 40, 30, 8, 8, 16, 16, 5, 5, 0.5],
    ['极端放大 64x', 40, 30, 1, 1, 64, 64, -12, -12, 1],
    ['极端缩小 64x', 40, 30, 64, 64, 1, 1, 20, 15, 1],
    ['非整数缩放比', 40, 30, 37, 23, 19, 11, 7, 6, 0.75],
  ];
  let bad = 0, firstBad = null;
  for (let i = 0; i < cases.length; i++) {
    const [label, cw, ch, w, h, outW, outH, x0, y0, alpha] = cases[i];
    const r = runCase(cw, ch, w, h, outW, outH, x0, y0, alpha, 7000 + i);
    if (!r.same) { bad++; if (!firstBad) firstBad = `${label} 首差@${r.diffAt}`; }
  }
  check(`R2 边界 ${cases.length} 例 (缩放/越界/alpha/单像素) 逐字节一致`,
    bad === 0, bad === 0 ? `${cases.length}/${cases.length} 一致` : `${bad} 例不一致 · 首例: ${firstBad}`);
}

// ── R3: 负控制 — 证明这个断言真的会 FAIL ────────────────────────────────────
// 故意把 fx/fy 互换的变体必须**不**等于参照 (否则说明比对逻辑是空转的)。
{
  function mutatedBlit(canvas, cw, ch, rgba, w, h, outW, outH, x0, y0, alpha) {
    if (outW === w && outH === h) { REF_blitLayer(canvas, cw, ch, rgba, w, h, x0, y0, alpha); return; }
    const xRatio = w / outW, yRatio = h / outH;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const cx = x0 + x, cy = y0 + y;
        if (cx < 0 || cx >= cw || cy < 0 || cy >= ch) continue;
        // 故意错: 用 yRatio 覆盖 xRatio
        const sx = (x + 0.5) * yRatio - 0.5;
        const X0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
        const X1 = Math.min(w - 1, X0 + 1);
        const fx = Math.min(Math.max(sx - X0, 0), 1);
        const di = (cy * cw + cx) * 4;
        const si = (X0 * w + X0) * 4;
        void X1; void fx;
        canvas[di] = rgba[si]; canvas[di + 1] = rgba[si + 1];
        canvas[di + 2] = rgba[si + 2]; canvas[di + 3] = rgba[si + 3];
      }
    }
  }
  const rng = makeRng(99);
  const cw = 20, ch = 16, w = 13, h = 9, outW = 31, outH = 22;
  const src = makeSrc(w, h, rng);
  const cRef = makeCanvas(cw, ch, rng);
  const cMut = Uint8Array.from(cRef);
  referenceComposite(cRef, cw, ch, src, w, h, outW, outH, -3, -2, 0.8);
  mutatedBlit(cMut, cw, ch, src, w, h, outW, outH, -3, -2, 0.8);
  let differs = false;
  for (let i = 0; i < cRef.length; i++) if (cRef[i] !== cMut[i]) { differs = true; break; }
  check('R3 负控制: 故意写错的变体被判为不一致 (断言非空转)', differs,
    differs ? '错误变体已检出' : '错误变体竟然"通过" — 比对逻辑失效');
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL COMPOSITE BLIT CHECKS PASSED'
  : failed.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
