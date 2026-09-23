#!/usr/bin/env node
/**
 * 前提测量: 块行并行 **DXT5 解码** 的真实加速比。
 *
 * 为什么必须实测而不是引用 §十六 的 2.91x:
 *   那个基准测的是"双线性重采样 + alpha 合成"(内存带宽敏感型), 与 DXT 解码
 *   (整数位运算, 计算敏感 + 243MB 写出) **不是同一个负载**。加速比不可外推。
 *
 * 负载取真实规模: 7680x7920 (60.8Mpx) DXT5 → 1920x1980 块 x 16B = 60.8MB 源,
 * 243MB RGBA 输出 (与 `鸟_00020` 完全同量级)。
 *
 * 判据: 每种 worker 数都必须与单线程**逐位一致** (块独立 ⇒ 行带拼接应当恒等)。
 * 用法: node scripts/bench-dxt-parallel.mjs
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';

const W = 7680;
const H = 7920;
const BLOCKS_X = Math.ceil(W / 4);
const BLOCKS_Y = Math.ceil(H / 4);
const BLOCK_BYTES = 16;
const SRC_BYTES = BLOCKS_X * BLOCKS_Y * BLOCK_BYTES;

if (!isMainThread) {
  const { sabSrc, sabOut, by0, by1 } = workerData;
  const { decodeDxt5 } = await import('../lib/pkg-extract.js');
  const src = new Uint8Array(sabSrc);
  const out = new Uint8Array(sabOut);
  const nby = by1 - by0;
  const sub = src.subarray(by0 * BLOCKS_X * BLOCK_BYTES, by1 * BLOCKS_X * BLOCK_BYTES);
  const decoded = decodeDxt5(sub, BLOCKS_X * 4, nby * 4);
  // 目标偏移: by0 个**块行** × 4 像素行/块行 × W 像素 × 4 字节
  out.set(decoded, by0 * 4 * BLOCKS_X * 4 * 4);
  parentPort.postMessage('done');
} else {
  const cores = os.cpus().length;
  console.log(`逻辑核 ${cores}   源 ${BLOCKS_X}x${BLOCKS_Y} 块 = ${(SRC_BYTES / 1048576).toFixed(1)}MB`
    + `   输出 ${W}x${H} RGBA = ${(W * H * 4 / 1048576).toFixed(0)}MB`);

  const sabSrc = new SharedArrayBuffer(SRC_BYTES);
  const src = new Uint8Array(sabSrc);
  let x = 12345;
  for (let i = 0; i < src.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; src[i] = x & 255; }

  const { decodeDxt5 } = await import('../lib/pkg-extract.js');

  // 单线程基准
  const t0 = performance.now();
  const base = decodeDxt5(src, W, H);
  const baseMs = performance.now() - t0;
  console.log(`\n单线程 ${baseMs.toFixed(0)}ms  (${(W * H / 1000000 / (baseMs / 1000)).toFixed(1)} Mpx/s)`);

  async function run(n) {
    const sabOut = new SharedArrayBuffer(W * H * 4);
    const bandBlocks = Math.ceil(BLOCKS_Y / n);
    const t = performance.now();
    const ws = [];
    for (let i = 0; i < n; i++) {
      const by0 = i * bandBlocks;
      const by1 = Math.min(BLOCKS_Y, by0 + bandBlocks);
      if (by1 <= by0) break;
      const w = new Worker(new URL(import.meta.url), { workerData: { sabSrc, sabOut, by0, by1 } });
      ws.push(new Promise((res, rej) => { w.once('message', res); w.once('error', rej); }));
    }
    await Promise.all(ws);
    return { ms: performance.now() - t, out: new Uint8Array(sabOut) };
  }

  const rows = [];
  for (const n of [2, 4, 8]) {
    if (n > cores) break;
    const { ms, out } = await run(n);
    let firstDiff = -1;
    let diffCount = 0;
    const len = Math.min(out.length, base.length);
    for (let i = 0; i < len; i++) {
      if (out[i] !== base[i]) { if (firstDiff < 0) firstDiff = i; diffCount++; }
    }
    const ident = out.length === base.length && diffCount === 0;
    const diffRow = firstDiff < 0 ? -1 : Math.floor(firstDiff / (W * 4));
    const diffBlockRow = firstDiff < 0 ? -1 : Math.floor(diffRow / 4);
    rows.push({ n, ms, speedup: baseMs / ms, ident });
    console.log(`workers=${String(n).padStart(2)}  ${ms.toFixed(0).padStart(6)}ms  `
      + `加速 ${(baseMs / ms).toFixed(2)}x  逐位一致=${ident}`);
    if (!ident) {
      console.log(`         长度 out=${out.length} base=${base.length}`
        + `  首个差异字节=${firstDiff} (像素行 ${diffRow}, 块行 ${diffBlockRow})  差异字节数=${diffCount}`);
      console.log(`         首个差异处 out=${out[firstDiff]} base=${base[firstDiff]}`
        + `  (像素内偏移 ${firstDiff % 4}, 列 ${Math.floor((firstDiff % (W * 4)) / 4)})`);
    }
  }
  const ok = rows.filter((r) => r.ident);
  const best = ok.reduce((a, b) => (b.speedup > a.speedup ? b : a));
  console.log(`\n最佳: workers=${best.n} → ${best.speedup.toFixed(2)}x (${best.ms.toFixed(0)}ms)`
    + `   占核 ${(100 * best.n / cores).toFixed(0)}%`);
  console.log(`逐位一致: ${ok.length}/${rows.length} 种配置通过`);
}
