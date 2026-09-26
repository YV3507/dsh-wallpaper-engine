// 临时基准 (gitignored): 行切分多线程的加速曲线 —— 决定 worker 数上限的依据。
// 负载取"逐像素双线性重采样 + alpha 合成"(多层合成 blit 的形状), 属内存带宽敏感型,
// 与效果内核同族。用 SharedArrayBuffer 共享源/目标, 只有行区间通过 postMessage 传参。
// 用法: node docs/evidence/parallel-bench.mjs
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const SRC_W = 4096, SRC_H = 4096;      // 源纹理
const OUT_W = 3840, OUT_H = 2160;      // 目标画布
const CANVAS_INIT = 1;

if (!isMainThread) {
  // worker: 处理 [y0, y1) 行
  const { sabSrc, sabOut, y0, y1 } = workerData;
  const src = new Uint8Array(sabSrc);
  const out = new Uint8Array(sabOut);
  const xRatio = SRC_W / OUT_W, yRatio = SRC_H / OUT_H;
  const alpha = 0.85;
  for (let y = y0; y < y1; y++) {
    const sy = (y + 0.5) * yRatio - 0.5;
    const ay = Math.max(0, Math.min(SRC_H - 1, Math.floor(sy)));
    const by = Math.min(SRC_H - 1, ay + 1);
    const fy = Math.min(Math.max(sy - ay, 0), 1);
    const ify = 1 - fy;
    const rowA = ay * SRC_W * 4, rowB = by * SRC_W * 4;
    for (let x = 0; x < OUT_W; x++) {
      const sx = (x + 0.5) * xRatio - 0.5;
      const ax = Math.max(0, Math.min(SRC_W - 1, Math.floor(sx)));
      const bx = Math.min(SRC_W - 1, ax + 1);
      const fx = Math.min(Math.max(sx - ax, 0), 1);
      const ifx = 1 - fx;
      const a0 = rowA + ax * 4, b0 = rowA + bx * 4, a1 = rowB + ax * 4, b1 = rowB + bx * 4;
      const di = (y * OUT_W + x) * 4;
      const sr = Math.round(src[a0] * ifx * ify + src[b0] * fx * ify + src[a1] * ifx * fy + src[b1] * fx * fy);
      const sg = Math.round(src[a0 + 1] * ifx * ify + src[b0 + 1] * fx * ify + src[a1 + 1] * ifx * fy + src[b1 + 1] * fx * fy);
      const sb = Math.round(src[a0 + 2] * ifx * ify + src[b0 + 2] * fx * ify + src[a1 + 2] * ifx * fy + src[b1 + 2] * fx * fy);
      const sa8 = Math.round(src[a0 + 3] * ifx * ify + src[b0 + 3] * fx * ify + src[a1 + 3] * ifx * fy + src[b1 + 3] * fx * fy);
      const sa = (sa8 / 255) * alpha;
      if (sa <= 0) continue;
      const da = out[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      out[di] = Math.round((sr * sa + out[di] * da * (1 - sa)) / outA);
      out[di + 1] = Math.round((sg * sa + out[di + 1] * da * (1 - sa)) / outA);
      out[di + 2] = Math.round((sb * sa + out[di + 2] * da * (1 - sa)) / outA);
      out[di + 3] = Math.round(outA * 255);
    }
  }
  parentPort.postMessage('done');
} else {
  const cores = os.cpus().length;
  console.log(`逻辑核 ${cores} 个   源 ${SRC_W}x${SRC_H} → 目标 ${OUT_W}x${OUT_H}`);
  console.log(`共享缓冲: 源 ${(SRC_W * SRC_H * 4 / 1048576).toFixed(0)}MB + 目标 ${(OUT_W * OUT_H * 4 / 1048576).toFixed(0)}MB\n`);

  const sabSrc = new SharedArrayBuffer(SRC_W * SRC_H * 4);
  const seed = new Uint8Array(sabSrc);
  for (let i = 0; i < seed.length; i++) seed[i] = (i * 37) & 255;

  async function run(n) {
    const sabOut = new SharedArrayBuffer(OUT_W * OUT_H * 4);
    // 画布初值 (与单线程版一致, 保证可比)
    if (CANVAS_INIT) { const c = new Uint8Array(sabOut); for (let i = 0; i < c.length; i++) c[i] = (i * 11) & 255; }
    const band = Math.ceil(OUT_H / n);
    const t0 = performance.now();
    const ws = [];
    for (let i = 0; i < n; i++) {
      const y0 = i * band, y1 = Math.min(OUT_H, y0 + band);
      if (y1 <= y0) break;
      const w = new Worker(new URL(import.meta.url), { workerData: { sabSrc, sabOut, y0, y1 } });
      ws.push(new Promise((res, rej) => { w.once('message', res); w.once('error', rej); }));
    }
    await Promise.all(ws);
    const ms = performance.now() - t0;
    await Promise.all(ws.map(() => null));
    return { ms, out: sabOut };
  }

  const results = [];
  let base = 0, baseOut = null;
  for (const n of [1, 2, 4, 6, 8, 12, 16, 24]) {
    if (n > cores) break;
    const { ms, out } = await run(n);
    if (n === 1) { base = ms; baseOut = out; }
    let ident = true;
    if (baseOut && n > 1) {
      const a = new Uint8Array(baseOut), b = new Uint8Array(out);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { ident = false; break; }
    }
    results.push({ n, ms, speedup: base / ms, ident });
    console.log(`workers=${String(n).padStart(2)}  ${ms.toFixed(0).padStart(6)}ms  加速 ${(base / ms).toFixed(2)}x  与单线程逐位一致=${n === 1 ? '-' : ident}`);
  }
  const best = results.filter((r) => r.ident !== false).reduce((a, b) => (b.speedup > a.speedup ? b : a));
  console.log(`\n最佳: workers=${best.n} → ${best.speedup.toFixed(2)}x (${best.ms.toFixed(0)}ms)`);
  console.log(`核数 ${cores} 的 ${(100 * best.n / cores).toFixed(0)}% —— 这是"不占满核心"的可行边界参考`);
}
