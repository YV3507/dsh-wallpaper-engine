// 归档基准: 量 _texSampleInto 的原始吞吐, 判断"内核微优化"有多少无损空间。
// 对照实测: blurradial 494ms/Mpx 且每像素 8 次采样 ⇒ 线上约 62ns/采样。
// 若裸采样远快于 62ns → 内核是采样受限, 微优化有收益; 若接近 → 只能靠并行/GPU。
import { SceneRenderer } from '../../../../lib/scene-renderer.js';

const proto = SceneRenderer.prototype;
const sample = proto._texSampleInto; // 不引用 this, 可直接 call(null,...)

const W = 4096, H = 4096;
const tex = { width: W, height: H, rgba: new Uint8Array(W * H * 4) };
for (let i = 0; i < tex.rgba.length; i++) tex.rgba[i] = (i * 37) & 255;

const out = [0, 0, 0, 0];
const N = 20_000_000;

// 预热 (让 V8 优化)
for (let i = 0; i < 2_000_000; i++) sample.call(null, tex, (i % 1000) / 1000, (i % 777) / 777, true, out);

function bench(label, fn, n) {
  const t0 = performance.now();
  fn(n);
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)}ms   ${(ms * 1e6 / n).toFixed(1)} ns/采样`);
  return ms * 1e6 / n;
}

// 每次采样坐标都不同 —— 防止 JIT/缓存把重复坐标折叠掉
for (const clamp of [true, false]) {
  const a = bench(`current clamp=${clamp}`, (n) => {
    for (let i = 0; i < n; i++) sample.call(null, tex, (i % 4096) / 4096 + 0.0001, (i % 4093) / 4093, clamp, out);
  }, N);
  console.log(`   → 对照线上 62ns/采样: 微优化天花板 ≈ ${(62 / a).toFixed(2)}x`);
}

// 手写展开版 (4 通道不循环) —— 估算"内核微优化"能到多少
function sampleUnrolled(tex, u, v, clamp, out) {
  let x, y;
  if (clamp) {
    x = u < 0 ? 0 : u > 0.999999 ? 0.999999 : u;
    y = v < 0 ? 0 : v > 0.999999 ? 0.999999 : v;
  } else {
    x = ((u % 1) + 1) % 1;
    y = ((v % 1) + 1) % 1;
  }
  const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
  const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
  const x1 = x0 + 1 < tex.width ? x0 + 1 : tex.width - 1;
  const y1 = y0 + 1 < tex.height ? y0 + 1 : tex.height - 1;
  const tx = fx - x0, ty = fy - y0;
  const w = tex.width, d = tex.rgba;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const itx = 1 - tx, ity = 1 - ty;
  const a0 = d[i00], a1 = d[i10], b0 = d[i01], b1 = d[i11];
  out[0] = ((a0 * itx + a1 * tx) * ity + (b0 * itx + b1 * tx) * ty) / 255;
  const c0 = d[i00 + 1], c1 = d[i10 + 1], d0 = d[i01 + 1], d1 = d[i11 + 1];
  out[1] = ((c0 * itx + c1 * tx) * ity + (d0 * itx + d1 * tx) * ty) / 255;
  const e0 = d[i00 + 2], e1 = d[i10 + 2], f0 = d[i01 + 2], f1 = d[i11 + 2];
  out[2] = ((e0 * itx + e1 * tx) * ity + (f0 * itx + f1 * tx) * ty) / 255;
  const g0 = d[i00 + 3], g1 = d[i10 + 3], h0 = d[i01 + 3], h1 = d[i11 + 3];
  out[3] = ((g0 * itx + g1 * tx) * ity + (h0 * itx + h1 * tx) * ty) / 255;
  return out;
}
for (let i = 0; i < 2_000_000; i++) sampleUnrolled(tex, (i % 1000) / 1000, (i % 777) / 777, true, out);
const b = bench('unrolled clamp=true', (n) => {
  for (let i = 0; i < n; i++) sampleUnrolled(tex, (i % 4096) / 4096 + 0.0001, (i % 4093) / 4093, true, out);
}, N);
console.log(`   → 展开版相对现版提速 ≈ ${(62 / b / (62 / 62)).toFixed(2)}x (绝对值对比看上面两行)`);

// 校验展开版与现版数值一致 (抽样)
let mism = 0;
const e1 = [0, 0, 0, 0], e2 = [0, 0, 0, 0];
for (let i = 0; i < 200000; i++) {
  const u = (i % 4096) / 4096 + 0.0001, v = (i % 4093) / 4093;
  sample.call(null, tex, u, v, true, e1);
  sampleUnrolled(tex, u, v, true, e2);
  for (let c = 0; c < 4; c++) if (Math.abs(e1[c] - e2[c]) > 1e-12) mism++;
}
console.log(`数值一致性: 20 万次抽样中不一致通道数 = ${mism}`);

// ── wrap 路径: ((u%1)+1)%1  vs  u - Math.floor(u) ────────────────────────────
console.log('');
console.log('── wrap 归一化替换对照 ──');
function wrapOld(u) { return ((u % 1) + 1) % 1; }
function wrapNew(u) { return u - Math.floor(u); }
// 等价性: 覆盖负数/整数/大值/小数 —— 并定位不等出现在哪个量级
function wrapEqTest(lo, hi, label) {
  let bad = 0, worst = 0, ex = [];
  for (let i = lo; i < hi; i++) {
    for (const f of [0.1, 0.5, 0.9, 0.0001, 0.9999]) {
      const u = i + f;
      const a = wrapOld(u), b = wrapNew(u);
      if (a !== b) {
        bad++;
        const d = Math.abs(a - b);
        if (d > worst) worst = d;
        if (ex.length < 4) ex.push(`u=${u} old=${a} new=${b} Δ=${d}`);
      }
    }
  }
  console.log(`${label}: 不等 ${bad} 组` + (bad ? `  最大Δ=${worst.toExponential(2)}  例: ${ex.join(' | ')}` : ''));
}
wrapEqTest(-5000, 5000, '|u| ≤ 5000');
wrapEqTest(-100, 100, '|u| ≤ 100');
wrapEqTest(-10, 10, '|u| ≤ 10 (UV 实际量级)');
wrapEqTest(-3, 3, '|u| ≤ 3');

function benchWrap(label, fn, n) {
  const t0 = performance.now();
  fn(n);
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(28)} ${ms.toFixed(0).padStart(6)}ms   ${(ms * 1e6 / n).toFixed(1)} ns/次`);
}
for (let i = 0; i < 5_000_000; i++) { wrapOld(i * 0.00013 - 100); wrapNew(i * 0.00013 - 100); }
benchWrap('旧 ((u%1)+1)%1', (n) => { let s = 0; for (let i = 0; i < n; i++) s += wrapOld(i * 0.00013 - 100); return s; }, N);
benchWrap('新 u-Math.floor(u)', (n) => { let s = 0; for (let i = 0; i < n; i++) s += wrapNew(i * 0.00013 - 100); return s; }, N);
