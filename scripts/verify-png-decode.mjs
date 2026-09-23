// 守卫: `decodePngPayload`(pkg-extract 私有) 必须与 `decodePngBuffer`(渲染器那份)
// 在同一 PNG payload 上**逐像素一致**。
//
// 为什么需要它: 2026 年那次真实缺陷 —— `decodePngPayload` 把**源字节下标 x** 直接
// 当目标下标用 (`rgba[y*w*4 + x]`)。对 RGBA(channels=4) 恰好等价, 对 **RGB(channels=3)**
// 则把 3 字节/像素紧密排进 4 字节/像素的缓冲区: 每行只填 3/4 = **75%**, 右侧 25% 保持 0
// (透明), 且通道逐像素错位(发灰)。实测 3669681034 的 7680x4320 colorType=2 内嵌 PNG
// 正是此症状, 而同一个 payload 用 decodePngBuffer 解码完全正确 —— 两个解码器分叉了。
//
// 本守卫用**合成 PNG** 而不是真实场景: 不依赖壁纸库, 可在任何机器上跑;
// 且缺陷与尺寸无关(只与 channels 有关), 小图即可完整覆盖。
//
// 用法: node scripts/verify-png-decode.mjs
import zlib from 'node:zlib';
import { decodePngPayload } from '../lib/pkg-extract.js';
import { decodePngBuffer } from '../lib/scene-renderer.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// ── 最小 PNG 编码器 (仅用于造夹具) ─────────────────────────────────────────
let _tbl = null;
function crc32(buf) {
  if (!_tbl) {
    _tbl = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _tbl[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _tbl[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
/**
 * 合成 PNG。channels: 3=RGB(colorType 2) / 4=RGBA(colorType 6)。
 * filter: 0=None / 1=Sub / 2=Up / 3=Average / 4=Paeth —— 覆盖 decodePngPayload 里
 * 被我改过的滤波预测子 (a / pr / pc) 三条路径。
 */
function makePng(w, h, channels, filter = 0) {
  const ct = channels === 4 ? 6 : 2;
  const stride = w * channels + 1;
  const raw = Buffer.alloc(stride * h);
  const src = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        // 有彩色、有梯度、每列都不同 —— 能同时暴露"通道错位"与"右侧未填充"
        src[(y * w + x) * channels + c] = (x * 37 + y * 91 + c * 151 + 7) & 255;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    raw[y * stride] = filter;
    for (let x = 0; x < w * channels; x++) {
      const v = src[y * w * channels + x];
      const a = x >= channels ? src[y * w * channels + x - channels] : 0;
      const b = y > 0 ? src[(y - 1) * w * channels + x] : 0;
      const c = (y > 0 && x >= channels) ? src[(y - 1) * w * channels + x - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pcv = Math.abs(q - c);
        p = pa <= pb && pa <= pcv ? a : pb <= pcv ? b : c;
      }
      raw[y * stride + 1 + x] = (v - p) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ct;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── R1 逐像素一致: RGB (channels=3) —— 本次缺陷的核心通道数 ─────────────────
{
  const W = 24, H = 9;
  const png = makePng(W, H, 3);
  const a = decodePngPayload(png);
  const b = decodePngBuffer(png);
  let ok = !!a && !!b && a.width === W && a.height === H && b.width === W && b.height === H;
  let diff = 0, firstDiff = null, alphaBad = 0;
  if (ok) {
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.rgba[i * 4 + c] - b.rgba[i * 4 + c]);
        if (d !== 0) { diff++; if (!firstDiff) firstDiff = `px${i} ch${c}: payload=${a.rgba[i * 4 + c]} renderer=${b.rgba[i * 4 + c]}`; }
      }
      if (b.rgba[i * 4 + 3] !== 255 || a.rgba[i * 4 + 3] !== 255) alphaBad++;
    }
  }
  check('R1 RGB(3 通道) payload 与渲染器解码器逐像素一致 + alpha 补 255',
    ok && diff === 0 && alphaBad === 0,
    ok ? `差异字节=${diff} alpha 异常像素=${alphaBad}${firstDiff ? ' 首例: ' + firstDiff : ''}` : '解码失败/尺寸不符');
}

// ── R2 列覆盖: 真实缺陷症状 (右侧 25% 未填充 ⇒ 透明) ────────────────────────
{
  const W = 40, H = 8;
  const png = makePng(W, H, 3);
  const a = decodePngPayload(png);
  let emptyCols = 0;
  if (a) {
    for (let x = 0; x < W; x++) {
      let any = false;
      for (let y = 0; y < H; y++) if (a.rgba[(y * W + x) * 4 + 3] > 8) { any = true; break; }
      if (!any) emptyCols++;
    }
  }
  check('R2 RGB 解码后每一列都有内容 (缺陷症状: 右侧 25% 整条透明)',
    !!a && emptyCols === 0,
    a ? `空列 ${emptyCols}/${W} (期望 0)` : '解码失败');
}

// ── R3 RGBA (channels=4) 不得回归 ──────────────────────────────────────────
{
  const W = 16, H = 6;
  const png = makePng(W, H, 4);
  const a = decodePngPayload(png);
  const b = decodePngBuffer(png);
  let diff = 0;
  if (a && b) for (let i = 0; i < W * H * 4; i++) if (a.rgba[i] !== b.rgba[i]) diff++;
  check('R3 RGBA(4 通道) 仍与渲染器解码器逐像素一致 (修复不得回归)',
    !!a && !!b && diff === 0, a && b ? `差异字节=${diff}` : '解码失败');
}

// ── R4 滤波预测子 1/2/3/4 全覆盖 (修复改动了 a/pr/pc 三条索引) ──────────────
{
  let bad = [];
  for (const f of [1, 2, 3, 4]) {
    const W = 12, H = 7;
    const png = makePng(W, H, 3, f);
    const a = decodePngPayload(png);
    const b = decodePngBuffer(png);
    if (!a || !b) { bad.push(`filter ${f}: 解码失败`); continue; }
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) {
        if (a.rgba[i * 4 + c] !== b.rgba[i * 4 + c]) { bad.push(`filter ${f}: 像素 ${i} ch${c}`); i = W * H; break; }
      }
    }
  }
  check('R4 滤波 1(Sub)/2(Up)/3(Average)/4(Paeth) 全部逐像素一致',
    bad.length === 0, bad.length ? bad.join('; ') : '4 种滤波全部一致');
}

// ── R5 负控制: 复现旧实现的"字节下标"写入, 证明断言针对真实效应 ─────────────
// 若这条不成立, 说明我对缺陷机制的理解是错的 (或断言在空转)。
{
  const W = 40, H = 4, channels = 3;
  const src = new Uint8Array(W * H * channels).fill(200); // 全非零源, 排除"源本身透明"
  const old = new Uint8Array(W * H * 4);                  // 零初始化, 模拟旧写法
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W * channels; x++) old[y * W * 4 + x] = src[y * W * channels + x];
  }
  let emptyCols = 0;
  for (let x = 0; x < W; x++) {
    let any = false;
    for (let y = 0; y < H; y++) if (old[(y * W + x) * 4 + 3] > 8) { any = true; break; }
    if (!any) emptyCols++;
  }
  const expect = W - Math.ceil(W * 3 / 4); // 每行只填 3w/4 字节 ⇒ 右侧 1/4 列无内容
  check('R5 负控制: 旧的"字节下标"写入必然留下右侧空列 (断言非空转)',
    emptyCols >= expect && emptyCols > 0,
    `旧写法空列 ${emptyCols}/${W} (期望 ≥${expect})`);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0 ? 'ALL PNG DECODE CHECKS PASSED' : failed.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
