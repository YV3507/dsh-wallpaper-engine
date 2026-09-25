// 预解码 worker: 自己解析容器 (含解压) 并只解自己拿到的块行带, 结果 transferable
// 回主线程。块之间无依赖 (DXT1/3/5 均以 4x4 块为单位独立编解码), 故行带拼接与
// 整幅解码应当**逐位一致** —— 由 scripts/verify-band-parallel.mjs 断言。
//
// 为什么解析放在这里而不是主线程: mip0 解压是顺序的且很贵 (60.8Mpx ≈ 250ms),
// 放进来就能随带宽一起并行, 且主线程的候选筛选可以只做 metaOnly 解析 (不解压)。
import { parentPort, workerData } from 'node:worker_threads';

const { srcs, metas, tasks } = workerData;
const { decodeDxt1, decodeDxt3, decodeDxt5, texMip0Info, TexFormat } = await import('../pkg-extract.js');

const pick = (fmt) => {
  if (fmt === TexFormat.DXT1) return decodeDxt1;
  if (fmt === TexFormat.DXT3) return decodeDxt3;
  return decodeDxt5;
};

// 内嵌 JPEG/PNG payload 的容器格式可能仍标着 DXT, 但载荷不是块流, 不可块切分。
// 判定需要解压后的前几个字节, 所以只能在这一层做。
const isPayload = (b) => b.length >= 4 && (
  (b[0] === 0xff && b[1] === 0xd8) ||
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47));

// 同一张纹理的多个带共享一次解析/解压 (每个 worker 内部缓存)
const parsed = new Map();
function infoFor(srcIndex) {
  if (!parsed.has(srcIndex)) {
    let v = null;
    try { v = texMip0Info(new Uint8Array(srcs[srcIndex])); } catch { v = null; }
    parsed.set(srcIndex, v);
  }
  return parsed.get(srcIndex);
}

const out = [];
const transfers = [];
for (const t of tasks) {
  const info = infoFor(t.srcIndex);
  if (!info || !info.bytes) continue;
  const bytes = info.bytes;
  if (isPayload(bytes)) continue;
  const m = metas[t.srcIndex];
  const nby = t.by1 - t.by0;
  const sub = bytes.subarray(t.by0 * m.blocksX * m.blockBytes, t.by1 * m.blocksX * m.blockBytes);
  // 必须用 **mip0 存储宽** (info.storageWidth) 解码: 它决定块/行跨距。逻辑宽
  // 不同时 (如存储 3284 而逻辑 3281) 用逻辑宽会让块行逐行漂移 —— 第 0 块行看着
  // 正常, 其后全错。裁剪到逻辑尺寸由主线程组装时完成 (与 loadTexImage 同一套语义)。
  const rgba = pick(info.format)(sub, info.storageWidth, nby * 4);
  out.push({ srcIndex: t.srcIndex, by0: t.by0, width: info.storageWidth, height: nby * 4, rgba });
  transfers.push(rgba.buffer);
}
parentPort.postMessage(out, transfers);
