/**
 * 大 DXT 纹理的「块行并行预解码」pass —— docs/SCENE-FRAME-PERF.md §二十九。
 *
 * 为什么必须是一个独立 pass: `loadTexture`/`loadTexImage` 是**完全同步**的, 被
 * 同步渲染循环直接调用, 而 worker_threads 只能**异步**回收结果。所以并行只能
 * 放在"整帧渲染之前"做一次, 结果塞进纹理缓存, 渲染时同步命中。
 * 这解释了此前 parallel.js "写了却接不上"的结构性原因。
 *
 * 安全性质 (不变量, 由 scripts/verify-band-parallel.mjs 守护):
 *   本模块**只提前把同一个解码器的结果放进缓存**, 不改变渲染路径。
 *   未命中/失败/覆盖不全的纹理一律不插入, 原样留给同步路径解码。
 *   因此"关掉预解码"与"它从未运行"在像素上完全等价。
 *
 * §二十九 教训 (两条, 都是实测抓出来的):
 *   1) 解码必须用 **mip0 存储尺寸**, 不是逻辑尺寸 —— 用错会让块行逐行漂移,
 *      第 0 块行看着正常而其后全错, 目视几乎发现不了。
 *   2) 候选筛选**绝不能解压**: mip0 解压是顺序的且很贵 (60.8Mpx ≈ 250ms),
 *      而 `parseTexInternal` 是在 mipmap 循环里内联解压的。所以这里用
 *      `metaOnly` 只读元数据, 并把"整容器解析 + 解压"一起搬进 worker 并行。
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { texMip0Info, TexFormat } from '../pkg-extract.js';

const MIN_PIXELS = 2 * 1024 * 1024;
const MAX_WORKERS = 8;          // 实测 8 worker = 3.91x (占 24 核的 33%)
const CORE_FRACTION = 0.34;     // 低端机: 4 核 → max(2, 1) = 2 worker, 强留 2 核

export function predecodeWorkerBudget() {
  const cores = os.cpus().length || 4;
  return Math.max(2, Math.min(MAX_WORKERS, Math.floor(cores * CORE_FRACTION)));
}

export function predecodeEnabled() {
  if (process.env.DSH_WE_NO_PREDECODE) return false;
  return predecodeWorkerBudget() >= 2;
}

const DXT_BLOCK_BYTES = new Map([[TexFormat.DXT1, 8], [TexFormat.DXT3, 16], [TexFormat.DXT5, 16]]);

/**
 * 选出预解码候选: pkg 内、未缓存、**非动画**(动画图集走 §二十七 的按帧路径)、
 * DXT 压缩、且不小于 minPixels 的纹理。
 *
 * 只做 **metaOnly 解析**(不解压)。内嵌 JPEG/PNG payload 的判定需要解压后的
 * 前几个字节, 故那一步移到 worker 里做(见 decode-worker 的 isPayload)。
 * 候选带上 `raw`(容器字节) 而不是 `bytes`(mip0) —— 解压交给 worker。
 */
export function collectPredecodeCandidates(pkg, textureCache, minPixels = MIN_PIXELS) {
  const out = [];
  for (const e of pkg.entries()) {
    if (!/\.tex$/i.test(e.name)) continue;
    if (textureCache.has(e.name)) continue;
    let raw = null;
    try { raw = pkg.read(e.name); } catch { continue; }
    if (!raw) continue;
    let info = null;
    try { info = texMip0Info(raw, { metaOnly: true }); } catch { continue; }
    if (!info || info.isAnimated || info.frames > 1) continue;
    const blockBytes = DXT_BLOCK_BYTES.get(info.format);
    if (!blockBytes) continue;
    if (info.width * info.height < minPixels) continue;
    // 块/行跨距按 **mip0 存储尺寸** 算 (与 decodeTex 一致), 不是逻辑尺寸
    const sw = info.storageWidth || info.width;
    const sh = info.storageHeight || info.height;
    const blocksX = Math.ceil(sw / 4);
    const blocksY = Math.ceil(sh / 4);
    if ((info.payloadLength || 0) < blocksX * blocksY * blockBytes) continue;
    out.push({
      path: e.name,
      width: info.width, height: info.height,           // 逻辑尺寸 = 输出尺寸
      storageWidth: sw, storageHeight: sh,              // 存储尺寸 = 解码跨距
      format: info.format, blockBytes, blocksX, blocksY, raw,
    });
  }
  return out;
}

/** 把候选切成块行带任务 (任务数 ≈ 2×worker 数, 便于负载均衡)。 */
function buildTasks(candidates, budget) {
  const totalBlocks = candidates.reduce((a, c) => a + c.blocksY, 0) || 1;
  const tasks = [];
  candidates.forEach((c, srcIndex) => {
    const want = Math.max(1, Math.round((budget * 2) * (c.blocksY / totalBlocks)));
    const bands = Math.max(1, Math.min(want, c.blocksY));
    const per = Math.ceil(c.blocksY / bands);
    for (let by0 = 0; by0 < c.blocksY; by0 += per) {
      tasks.push({ srcIndex, by0, by1: Math.min(c.blocksY, by0 + per) });
    }
  });
  return tasks;
}

/**
 * 并行解码候选纹理, 并逐条插入纹理缓存。
 * 任何 worker 失败都只是少插入若干条目 —— 调用方无需回滚, 同步路径会照常解码。
 */
export async function predecodeTextures(candidates, cacheFn, opts = {}) {
  const budget = Math.min(opts.workers || predecodeWorkerBudget(), MAX_WORKERS);
  if (!candidates.length || budget < 2) return { textures: 0, tasks: 0, workers: 0, ms: 0, inserted: 0 };
  const t0 = performance.now();

  // 源 = **整个容器** (共享给 worker; worker 自己解析+解压, 解压因此也并行)
  const srcs = candidates.map((c) => {
    const sab = new SharedArrayBuffer(c.raw.length);
    new Uint8Array(sab).set(c.raw);
    return sab;
  });
  const metas = candidates.map((c) => ({
    blockBytes: c.blockBytes, blocksX: c.blocksX,
  }));
  const tasks = buildTasks(candidates, budget);

  // 轮转分配任务, 每个 worker 一条 workerData
  const buckets = Array.from({ length: budget }, () => []);
  tasks.forEach((t, i) => buckets[i % budget].push(t));

  const workerUrl = new URL('./predecode-worker.mjs', import.meta.url);
  const parts = await Promise.all(buckets.filter((b) => b.length).map((b) => new Promise((resolve) => {
    let w = null;
    try {
      w = new Worker(workerUrl, { workerData: { srcs, metas, tasks: b } });
    } catch { resolve([]); return; }
    w.once('message', (m) => { resolve(Array.isArray(m) ? m : []); w.terminate().catch(() => { }); });
    w.once('error', () => { resolve([]); });
  })));

  // 组装: 每张纹理一次性分配**逻辑尺寸**的 RGBA, 各带按块行写入。
  // 带的行跨距 = 存储宽 (worker 按存储宽解码), 每行裁到逻辑宽 —— 与
  // loadTexImage 的 "逻辑尺寸裁剪 (DXT padding)" 完全同一套语义。
  const outs = new Map();
  const coverage = new Map();
  for (const part of parts) {
    for (const r of part) {
      const c = candidates[r.srcIndex];
      if (!c) continue;
      if (!outs.has(r.srcIndex)) outs.set(r.srcIndex, new Uint8Array(c.width * c.height * 4));
      const buf = outs.get(r.srcIndex);
      const rowBytes = Math.min(r.width, c.width) * 4;
      const rows = Math.min(r.height, Math.max(0, c.height - r.by0 * 4));
      for (let y = 0; y < rows; y++) {
        const s = y * r.width * 4;
        buf.set(r.rgba.subarray(s, s + rowBytes), (r.by0 * 4 + y) * c.width * 4);
      }
      coverage.set(r.srcIndex, Math.max(coverage.get(r.srcIndex) || 0, r.by0 * 4 + rows));
    }
  }

  let inserted = 0;
  candidates.forEach((c, i) => {
    const buf = outs.get(i);
    if (!buf) return;                                  // 无产出 (payload/解析失败) → 交给同步路径
    if ((coverage.get(i) || 0) < c.height) return;     // 覆盖不全 → 一律不插入
    cacheFn(c.path, { width: c.width, height: c.height, rgba: buf, frames: null });
    inserted++;
  });

  return { textures: candidates.length, tasks: tasks.length, workers: budget, ms: performance.now() - t0, inserted };
}

/**
 * 生产入口: 为一次即将进行的同步渲染预热纹理缓存。
 * scene-render-worker.mjs 与诊断 harness 都调用**这一段**, 保证测的就是跑的那段。
 * 返回 null 表示未启用 (kill switch 或核数不足)。
 */
export async function warmSceneTextures(renderer, opts) {
  if (!predecodeEnabled()) return null;
  const candidates = collectPredecodeCandidates(renderer.pkg, renderer.textureCache);
  return predecodeTextures(candidates, (p, img) => renderer._cacheTexture(p, img), opts);
}
