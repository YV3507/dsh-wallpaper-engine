// WE 渲染引擎 — 画布 (RGBA 缓冲 + 合成操作) 与 PNG 编解码
import zlib from 'node:zlib';
import { applyBlending } from './math.js';
import { profAdd, profPx } from './profile.js';

// 绘制内核剖析开关 (DSH_WE_PROFILE=1)。与 profile.js 同一判据, 关闭时全部零开销。
const PROF = process.env.DSH_WE_PROFILE === '1';

// ── 缩放采样权重 (blitScaled 用) ──────────────────────────────────────────────
// c     = 目标像素中心在"源矩形局部"的坐标 (texel 边界单位: 0 = 矩形左边界, n = 右边界)
// n     = 该轴源 texel 数
// scale = n / |d| = 1 个源 texel 覆盖多少目标像素
// 放大 (scale ≤ 1): 双线性 2 抽头 (texel 中心约定 — 与 GPU GL_LINEAR 一致)
// 缩小 (scale > 1): 盒式 —— footprint [c-scale/2, c+scale/2] 与 texel [i, i+1] 的面积重叠,
//   权重归一化 ⇒ 越界面积折回边缘 texel (CLAMP_TO_EDGE, 绝不环绕)。
// 抽头数 = O(ceil(scale)+1), 所以整体代价上界 ≈ 源纹理面积。
// 返回抽头数, 结果写入 idx[]/wt[] 自 off 起的位置。
function sampleAxisWeights(c, n, scale, idx, wt, off) {
  if (scale <= 1) {
    const p = c - 0.5;
    const i0 = Math.floor(p);
    const f = p - i0;
    let a = i0, b = i0 + 1;
    if (a < 0) a = 0; else if (a > n - 1) a = n - 1;
    if (b < 0) b = 0; else if (b > n - 1) b = n - 1;
    idx[off] = a; wt[off] = 1 - f;
    idx[off + 1] = b; wt[off + 1] = f;
    return 2;
  }
  const h = scale * 0.5;
  const lo = c - h, hi = c + h;
  let i0 = Math.floor(lo), i1 = Math.ceil(hi) - 1;
  if (i0 < 0) i0 = 0;
  if (i1 > n - 1) i1 = n - 1;
  let k = 0, sum = 0;
  for (let i = i0; i <= i1; i++) {
    const ov = (hi < i + 1 ? hi : i + 1) - (lo > i ? lo : i);
    if (ov <= 0) continue;
    idx[off + k] = i; wt[off + k] = ov; sum += ov; k++;
  }
  if (k === 0) {
    // footprint 完全落在纹理外 (极端相位) → 退化为取最近 texel, 避免空权重
    let i = Math.floor(c + 0.5);
    if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
    idx[off] = i; wt[off] = 1;
    return 1;
  }
  for (let j = 0; j < k; j++) wt[off + j] /= sum;
  return k;
}

// y 轴逐行权重的模块级暂存 (blitScaled 不支持重入调用, 无并发 → 可安全复用)
let _wyIdx = new Int32Array(64), _wyW = new Float64Array(64);
function ensureYWTaps(n) {
  if (_wyIdx.length < n) { _wyIdx = new Int32Array(n); _wyW = new Float64Array(n); }
}

// ── HDR 加性累积层 (hdr=true 场景的 additive 通道) ────────────────────────────
// 官方对 `general.hdr=true` 的场景走 **HDR 管线**: 对象画进 HDR 缓冲, 加性混合在
// 缓冲里以浮点精度累加 (不逐片元裁剪), 链尾由 combine_hdr.frag **一次**做
//   `saturate(lin(albedo)) * g_RenderVar0.x`  (combine_hdr.frag:40-44, SDR 输出分支)
// 再 linear→sRGB 显示编码 (官方由 sRGB 帧缓冲/显示阶段完成; 本渲染器的画布就是交付的
// 8bit sRGB 帧, 故必须显式编码 —— 同一结论见 .test-cache/fix-bloom-srgb.md §1.2)。
// 对照 LDR 管线: combine.frag:10-15 只有 `albedo + bloom`, 没有 lin()/曝光/编码
//   ⇒ 官方 LDR 目标就是显示空间 8bit (加性混合按硬件规则饱和) —— 本渲染器现有行为一致,
//     所以这块浮点层**只对 hdr=true 场景启用** (见 particles.js 的 gate)。
// 本渲染器没有整帧 HDR 缓冲 (那需要 core.js 协作), 因此这里只给**加性通道**一块
// Float32 线性光累加层:
//   addLight()  逐片元把线性光累加进层 (浮点, 不裁剪)
//   additiveCommit() 按官方链尾一次性 saturate×曝光 + linear→sRGB 写回 8bit 画布
// 接口按"以后可接整帧 HDR 缓冲"的形状留 (enable/add/commit, 帧首 _addReset)。
//
// 曝光 g_RenderVar0.x: 渲染器无该 uniform 来源 (全库无读取点; bloom.js 同样按 1 处理,
// 见 fix-bloom-srgb.md §2 的 R3), 故取 1 —— 与 bloom 的 HDR 分支保持同一取值。
export const HDR_ADD_EXPOSURE = 1;
// 链尾映射曲线: 默认严格照官方 `saturate(lin(albedo)) * g_RenderVar0.x` (combine_hdr.frag:43)。
// DSH_WE_HDR_CURVE=exp 是**对照/回退**开关: 用 1-exp(-x) 软饱和替换 saturate —— 它是本
// 任务书提到的备选, 保留开关用于在真实链路上给出两条曲线的可复现对照数字
// (见 .test-cache/fix-hdr-accum.md "曲线选择"), 默认不启用。
const HDR_ADD_CURVE = process.env.DSH_WE_HDR_CURVE === 'exp' ? 'exp' : 'saturate';
// 官方 lin() (combine_hdr.frag:12-16, chilliant 近似) —— 显示值 → 线性光
export function linLight(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
// 8bit 显示值 → 线性光 查表 (commit 的"底层线性光")
const LIN8 = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN8[i] = linLight(i / 255);
// 线性光 → 显示值 查表 (linear→sRGB; 官方由显示阶段做, 这里显式编码)
const SRGB_N = 4096;
const SRGB_T = new Float32Array(SRGB_N + 2);
for (let i = 0; i <= SRGB_N + 1; i++) {
  const v = i / SRGB_N;
  SRGB_T[i] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
// 线性光 [0,1] → 显示 8bit (查表 + 线性插值; 表下沿是线性段, 无零点误差)
function srgb255(l) {
  if (!(l > 0)) return 0;
  if (l >= 1) return 255;
  const f = l * SRGB_N, i = f | 0, t = f - i;
  const v = SRGB_T[i] + (SRGB_T[i + 1] - SRGB_T[i]) * t;
  return v >= 1 ? 255 : (v * 255 + 0.5) | 0;
}

export class Canvas {
  constructor(w, h) {
    this.w = w; this.h = h; this.data = new Uint8Array(w * h * 4); this.zbuf = new Float32Array(w * h); this.zbuf.fill(Infinity);
    // HDR 加性累积层 (惰性分配: 非 hdr / 无 additive 的场景一个字节都不分配)
    this.addL = null;          // 线性光累加 (per-pixel RGB)
    this.addE = null;          // 已写进画布的"加性光"显示档 (增量重算: base = data - addE)
    this.addEnabled = false;   // 本场景是否启用 (由 particles.js 按 general.hdr 决定)
    this.addDirty = null;      // [x0,y0,x1,y1] 自上次 commit 以来被累加的区域
    this.addUsed = null;       // [x0,y0,x1,y1] 本帧被用到的区域 (帧首 _addReset 清理范围)
    this.addCommits = 0;       // 诊断: 本帧 commit 次数
  }

  // 启用 HDR 加性累积层 (幂等)
  additiveEnable() {
    if (!this.addL) {
      this.addL = new Float32Array(this.w * this.h * 3);
      this.addE = new Uint8Array(this.w * this.h * 3);
    }
    this.addEnabled = true;
  }

  // 逐片元累加**线性光** (官方 HDR 缓冲里的加性混合语义: 不裁剪)
  addLight(px, py, lr, lg, lb) {
    const q = py * this.w + px, i3 = q * 3;
    const L = this.addL;
    L[i3] += lr; L[i3 + 1] += lg; L[i3 + 2] += lb;
    // 加性通道保持不透明 (与旧 8bit 硬裁剪路径一致: dstA 不参与)
    this.data[q * 4 + 3] = 255;
    const d = this.addDirty;
    if (d === null) this.addDirty = [px, py, px, py];
    else {
      if (px < d[0]) d[0] = px;
      if (py < d[1]) d[1] = py;
      if (px > d[2]) d[2] = px;
      if (py > d[3]) d[3] = py;
    }
  }

  // 官方链尾 (combine_hdr.frag:40-44): saturate(lin(albedo)) × 曝光 → linear→sRGB → 8bit
  //   albedo = 底层线性光 + 本帧累加的加性线性光
  // 增量重算: 已写入的加性光记在 addE, 故底层 = data - addE; 重复 commit 不会重复叠加。
  additiveCommit() {
    const d = this.addDirty;
    if (!this.addEnabled || d === null) return;
    const w = this.w, data = this.data, L = this.addL, E = this.addE;
    for (let y = d[1]; y <= d[3]; y++) {
      const row = y * w;
      for (let x = d[0]; x <= d[2]; x++) {
        const q = row + x, i3 = q * 3, i4 = q * 4;
        for (let k = 0; k < 3; k++) {
          const e = E[i3 + k];
          let base = data[i4 + k] - e;      // 去掉本层已写入的光 → 底层显示值 (整数)
          if (base < 0) base = 0;
          let l = LIN8[base] + L[i3 + k];   // 底层线性光 + 加性线性光
          // 官方 saturate (combine_hdr.frag:43); exp = 对照曲线 1-exp(-x)
          if (HDR_ADD_CURVE === 'exp') l = 1 - Math.exp(-l);
          else if (l > 1) l = 1;
          l *= HDR_ADD_EXPOSURE;            // 官方 g_RenderVar0.x (无来源 → 1)
          const byte = srgb255(l);
          data[i4 + k] = byte;
          E[i3 + k] = byte > base ? byte - base : 0;
        }
        data[i4 + 3] = 255;
      }
    }
    // 记录本帧已用区域 (帧首清理用), 并清空 dirty
    const u = this.addUsed;
    if (u === null) this.addUsed = d.slice();
    else {
      if (d[0] < u[0]) u[0] = d[0];
      if (d[1] < u[1]) u[1] = d[1];
      if (d[2] > u[2]) u[2] = d[2];
      if (d[3] > u[3]) u[3] = d[3];
    }
    this.addDirty = null;
    this.addCommits++;
  }

  // 帧首清理 (clear() 调用): 只清本帧用到的区域 → 与画布同步回到"底层 + 零加性光"
  _addReset() {
    const u = this.addUsed;
    if (this.addL === null || u === null) return;
    const w = this.w, L = this.addL, E = this.addE;
    for (let y = u[1]; y <= u[3]; y++) {
      const x0 = y * w + u[0], x1 = y * w + u[2];
      L.fill(0, x0 * 3, (x1 + 1) * 3);
      E.fill(0, x0 * 3, (x1 + 1) * 3);
    }
    this.addUsed = null;
    this.addDirty = null;
  }
  // 修复: 原实现忽略全部参数 (恒 this.data.fill(0)) — 场景 general.clearcolor 经
  // core.js render() 的 this.canvas.clear(r*255, g*255, b*255, 255) 传进来后被直接丢弃,
  // 背景只剩默认透明黑 (clearcolor 永远不生效)。无参调用 (render() 帧首那次) 保持逐字节
  // 不变 (仍走 fill(0)); 有参时按 0-255 输入四舍五入 + 钳位到 [0,255] 后填充。
  clear(r = 0, g = 0, b = 0, a = 0) {
    // 帧首: HDR 加性累积层与画布一起回到"底层 + 零加性光" (只清本帧用到的区域)
    this._addReset();
    this.addCommits = 0;
    if (r === 0 && g === 0 && b === 0 && a === 0) {
      this.data.fill(0);
    } else {
      const ch = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
      const cr = ch(r), cg = ch(g), cb = ch(b), ca = ch(a);
      const d = this.data;
      for (let i = 0; i < d.length; i += 4) { d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = ca; }
    }
    this.zbuf.fill(Infinity);
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (y * this.w + x) * 4;
    return [this.data[i], this.data[i+1], this.data[i+2], this.data[i+3]];
  }
  set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = r; this.data[i+1] = g; this.data[i+2] = b; this.data[i+3] = a;
  }
  // source-over 合成一个已解码纹理 (直接像素拷贝, 无缩放)
  // ★ 采样修复说明: blit **没有**缩放参数 (1:1 逐像素拷贝, 目标位置只做 floor(dx/dy)),
  // 因此不存在最近邻/双线性的取舍 —— 不加改动即为正确 (且满足"缩放比 1 逐字节不变")。
  blit(img, dx, dy, alpha = 1) {
    const x0 = Math.floor(dx), y0 = Math.floor(dy);
    for (let ty = y0; ty < y0 + img.height; ty++) {
      if (ty < 0 || ty >= this.h) continue;
      for (let tx = x0; tx < x0 + img.width; tx++) {
        if (tx < 0 || tx >= this.w) continue;
        const sx = tx - x0, sy = ty - y0;
        const si = (sy * img.width + sx) * 4;
        const a = img.rgba[si + 3] / 255 * alpha;
        if (a <= 0) continue;
        const di = (ty * this.w + tx) * 4;
        const dstA = this.data[di + 3] / 255;
        const outA = a + dstA * (1 - a);
        this.data[di] = Math.round((img.rgba[si] * a + this.data[di] * dstA * (1 - a)) / outA);
        this.data[di+1] = Math.round((img.rgba[si+1] * a + this.data[di+1] * dstA * (1 - a)) / outA);
        this.data[di+2] = Math.round((img.rgba[si+2] * a + this.data[di+2] * dstA * (1 - a)) / outA);
        this.data[di+3] = Math.round(outA * 255);
      }
    }
  }
  // 带缩放的 blit (放大 = 双线性, 缩小 = 盒式面积平均; 支持负 dw/dh = 水平/垂直镜像, scale.x<0)
  // blendMode > 0 → 用官方 ApplyBlending(mode, 画布色A, 源色B, 源alpha) 颜色混合 (colorBlendMode)
  // srcRect = [sx0, sy0, sw, sh] (源像素坐标子矩形) — 缺省 = 全图; puppet 按对象 size
  // 四边裁切用 (只绘制 quad 内网格区域)。
  //
  // ★ 采样修复 (背景马赛克): 旧实现对每个目标像素只做一次 Math.round() 源坐标取整
  //   (最近邻) 且不做任何 mip/预滤波, 而背景层恰是缩放倍数最大的层 —— 实测
  //   beach/models/clouds.json 面积放大 58.6× (7.66×7.66)、razer_bedroom/backgroundclear
  //   6772× (110×61.5) ⇒ 输出是大色块; 缩小层 (new_wall_combined4k 3840×2160→1920×1080、
  //   retro 2048²→832×1092) 则完全无预滤波 ⇒ 高频走样。官方采样是
  //   **双线性 + 三线性 mip + 各向异性 8** (assets/shaders 的 texSample2D 语义 + 引擎默认
  //   采样器)。CPU 等价实现:
  //     * 目标像素中心 → 源矩形局部坐标 u = (px + 0.5 - rectLeft) * SW/|dw| (texel 边界单位)
  //     * 放大 (SW/|dw| ≤ 1): 双线性 (texel 中心约定, 与 GPU LINEAR / blitRotated 的 tent 一致)
  //     * 缩小 (SW/|dw| > 1): 盒式 —— footprint 与每个 texel 的面积重叠作权重并归一化,
  //       这正是 mip 选级要达到的预滤波效果, 且**无需生成/缓存 mip 链**: 效果链每帧的
  //       临时缓冲来自 scratch 池会被复用, 按对象身份缓存 mip 会读到上一帧内容;
  //       盒式的抽头数上界 = 源纹理面积 (不会失控), 也省掉 mip 的 +33% 显存。
  //     * 边缘一律 CLAMP_TO_EDGE (越界权重折回边缘 texel, 绝不环绕) ⇒ 平铺/重复纹理
  //       (beach clouds、shimmering_particles grad) 放大时不出现接缝; srcRect (puppet
  //       网格 quad) 的采样也不越出子矩形, 与旧实现同一边界语义。
  //   ★ 硬约束: 缩放比恰好 1 (|dw|==SW && |dh|==SH) 走原最近邻分支, **逐字节不变**
  //     (新采样用"目标像素中心"约定, 与旧的 round(左边界) 在非整数相位下相差半个 texel,
  //      因此两者不能合并; 改这一条会让所有 1:1 图层发生亚像素偏移)。
  blitScaled(img, dx, dy, dw, dh, alpha = 1, blendMode = 0, srcRect = null) {
    if (dw === 0 || dh === 0) return;
    const flipX = dw < 0, flipY = dh < 0;
    const SX0 = srcRect ? srcRect[0] : 0;
    const SY0 = srcRect ? srcRect[1] : 0;
    const SW = srcRect ? srcRect[2] : img.width;
    const SH = srcRect ? srcRect[3] : img.height;
    if (!(SW > 0) || !(SH > 0)) return;
    const adw = Math.abs(dw), adh = Math.abs(dh);
    const x0 = Math.floor(flipX ? dx + dw : dx), y0 = Math.floor(flipY ? dy + dh : dy);
    const x1 = Math.ceil(flipX ? dx : dx + dw), y1 = Math.ceil(flipY ? dy : dy + dh);
    const src = img.rgba, IW = img.width, dst = this.data, CW = this.w, CH = this.h;
    const invDw = SW / adw, invDh = SH / adh;
    const srcOffX = SX0 + (x0 - dx) * invDw, srcOffY = SY0 + (y0 - dy) * invDh;
    if (adw === SW && adh === SH) {
      // ── 原最近邻路径 (缩放比恰好 1: 逐字节不变 — 与修前代码逐字相同) ──
      for (let ty = y0; ty < y1; ty++) {
        if (ty < 0 || ty >= CH) continue;
        const sy = Math.min(SY0 + SH - 1, Math.max(SY0, Math.round(srcOffY + (ty - y0) * invDh)));
        const rowBase = sy * IW;
        for (let tx = x0; tx < x1; tx++) {
          if (tx < 0 || tx >= CW) continue;
          let sx = Math.min(SX0 + SW - 1, Math.max(SX0, Math.round(srcOffX + (tx - x0) * invDw)));
          if (flipX) sx = SX0 + (SW - 1) - (sx - SX0);
          const si = (rowBase + sx) * 4;
          const a = src[si + 3] / 255 * alpha;
          if (a <= 0) continue;
          const di = (ty * CW + tx) * 4;
          if (blendMode > 0) {
            // 官方 passthroughblend: ApplyBlending(mode, screen.rgb, albedo.rgb, albedo.a)
            const A = [dst[di] / 255, dst[di + 1] / 255, dst[di + 2] / 255];
            const B = [src[si] / 255, src[si + 1] / 255, src[si + 2] / 255];
            const blended = applyBlending(blendMode, A, B, a);
            const dstA = dst[di + 3] / 255;
            const outA = a + dstA * (1 - a);
            dst[di] = Math.round(blended[0] * 255);
            dst[di + 1] = Math.round(blended[1] * 255);
            dst[di + 2] = Math.round(blended[2] * 255);
            dst[di + 3] = Math.round(outA * 255);
            continue;
          }
          const dstA = dst[di + 3] / 255;
          const outA = a + dstA * (1 - a);
          dst[di] = Math.round((src[si] * a + dst[di] * dstA * (1 - a)) / outA);
          dst[di + 1] = Math.round((src[si + 1] * a + dst[di + 1] * dstA * (1 - a)) / outA);
          dst[di + 2] = Math.round((src[si + 2] * a + dst[di + 2] * dstA * (1 - a)) / outA);
          dst[di + 3] = Math.round(outA * 255);
        }
      }
      return;
    }
    // ── 新采样路径 (放大 = 双线性, 缩小 = 盒式面积平均; CLAMP_TO_EDGE) ──
    // x 轴采样权重表: 按可见列预计算 (内存 ≈ 源宽 × 抽头数, 与目标面积无关)
    const nx0 = x0 < 0 ? 0 : x0;
    const nx1 = x1 > CW ? CW : x1;
    if (nx1 <= nx0) return;
    const n = nx1 - nx0;
    const Kx = invDw <= 1 ? 2 : Math.ceil(invDw) + 1;
    const xI = new Int32Array(n * Kx), xW = new Float64Array(n * Kx), xN = new Int32Array(n);
    const rectL = flipX ? dx + dw : dx;
    for (let i = 0; i < n; i++) {
      let u = (nx0 + i + 0.5 - rectL) * invDw;
      if (flipX) u = SW - u;
      xN[i] = sampleAxisWeights(u, SW, invDw, xI, xW, i * Kx);
    }
    // y 轴权重 (逐行算一次; 抽头数上界 = 源高, 用模块级暂存避免每行分配)
    const rectT = flipY ? dy + dh : dy;
    ensureYWTaps(Math.min(invDh <= 1 ? 2 : Math.ceil(invDh) + 1, SH + 2));
    // 两轴都是 2 抽头 (放大 / 混合) → 双线性专用内层 (省掉通用权重循环的每次查表)
    const fastBilinear = invDw <= 1 && invDh <= 1;
    const SX04 = SX0 * 4;
    for (let ty = y0; ty < y1; ty++) {
      if (ty < 0 || ty >= CH) continue;
      let ky = 0, rowA4 = 0, rowB4 = 0, u0 = 0, u1 = 0;
      let v = (ty + 0.5 - rectT) * invDh;
      if (flipY) v = SH - v;
      ky = sampleAxisWeights(v, SH, invDh, _wyIdx, _wyW, 0);
      if (fastBilinear) {
        rowA4 = ((SY0 + _wyIdx[0]) * IW) * 4;
        rowB4 = ((SY0 + _wyIdx[1]) * IW) * 4;
        u0 = _wyW[0]; u1 = _wyW[1];
      }
      for (let tx = x0; tx < x1; tx++) {
        if (tx < 0 || tx >= CW) continue;
        let sr, sg, sb, sa8;
        if (fastBilinear) {
          // ── 双线性 2×2 抽头 (放大; 与 GPU GL_LINEAR 同一 texel 中心约定) ──
          const xb = (tx - nx0) * 2;
          const w0 = xW[xb], w1 = xW[xb + 1];
          const a4 = SX04 + xI[xb] * 4, b4 = SX04 + xI[xb + 1] * 4;
          const p00 = rowA4 + a4, p10 = rowA4 + b4, p01 = rowB4 + a4, p11 = rowB4 + b4;
          const f00 = w0 * u0, f10 = w1 * u0, f01 = w0 * u1, f11 = w1 * u1;
          sr = src[p00] * f00 + src[p10] * f10 + src[p01] * f01 + src[p11] * f11;
          sg = src[p00 + 1] * f00 + src[p10 + 1] * f10 + src[p01 + 1] * f01 + src[p11 + 1] * f11;
          sb = src[p00 + 2] * f00 + src[p10 + 2] * f10 + src[p01 + 2] * f01 + src[p11 + 2] * f11;
          sa8 = src[p00 + 3] * f00 + src[p10 + 3] * f10 + src[p01 + 3] * f01 + src[p11 + 3] * f11;
        } else {
          // ── 通用加权 (缩小的盒式面积平均 / 放大×缩小混合轴) ──
          const ci = tx - nx0, xb = ci * Kx, kx = xN[ci];
          let ar = 0, ag = 0, ab = 0, aa = 0;
          for (let j = 0; j < ky; j++) {
            const rowBase = (SY0 + _wyIdx[j]) * IW + SX0, wy = _wyW[j];
            for (let i = 0; i < kx; i++) {
              const wgt = xW[xb + i] * wy;
              const si = (rowBase + xI[xb + i]) * 4;
              ar += src[si] * wgt; ag += src[si + 1] * wgt; ab += src[si + 2] * wgt; aa += src[si + 3] * wgt;
            }
          }
          sr = ar; sg = ag; sb = ab; sa8 = aa;
        }
        const a = sa8 / 255 * alpha;
        if (a <= 0) continue;
        const di = (ty * CW + tx) * 4;
        if (blendMode > 0) {
          // 官方 passthroughblend: ApplyBlending(mode, screen.rgb, albedo.rgb, albedo.a)
          const A = [dst[di] / 255, dst[di + 1] / 255, dst[di + 2] / 255];
          const B = [sr / 255, sg / 255, sb / 255];
          const blended = applyBlending(blendMode, A, B, a);
          const dstA = dst[di + 3] / 255;
          const outA = a + dstA * (1 - a);
          dst[di] = Math.round(blended[0] * 255);
          dst[di + 1] = Math.round(blended[1] * 255);
          dst[di + 2] = Math.round(blended[2] * 255);
          dst[di + 3] = Math.round(outA * 255);
          continue;
        }
        const dstA = dst[di + 3] / 255;
        const outA = a + dstA * (1 - a);
        dst[di] = Math.round((sr * a + dst[di] * dstA * (1 - a)) / outA);
        dst[di + 1] = Math.round((sg * a + dst[di + 1] * dstA * (1 - a)) / outA);
        dst[di + 2] = Math.round((sb * a + dst[di + 2] * dstA * (1 - a)) / outA);
        dst[di + 3] = Math.round(outA * 255);
      }
    }
  }
  // 带缩放 + 旋转的 blit: 以中心 (cx, cy) 旋转 angle 弧度 (逆时针), 目标尺寸 dw×dh
  // 反向映射: 目标像素 → 逆旋转 → 源矩形 → 双线性采样 (引擎 CImage 角度语义)
  // 旋转 blit: 图像矩形中心 = (cx, cy), 尺寸 (dw, dh);
  // 旋转支点默认 = 图像中心 (pivotX/pivotY 可指定, 用于"绕对象 origin 旋转" —
  // 官方 world = origin + R·S·v: R 绕对象原点, 而对象原点通常不是网格包围盒中心)。
  // 待核对: 非 90° 旋转的符号/矩阵一致性尚未与官方实机渲染逐像素比对 (当前符号沿用
  // Y-flip 约定, 与 blitScaled 的 flip 语义同源) — 改符号前先做官方对齐实验。
  blitRotated(img, cx, cy, dw, dh, angle, alpha = 1, pivotX = cx, pivotY = cy) {
    // 负 dw/dh = 绕中心镜像 (负 scale 语义, 与 blitScaled 的 flipX/flipY 等价)。
    // 先把负尺寸归一化为正 + 镜像标记, 再旋转 — 避免负 invDw 导致源 UV 翻转
    // 且包围盒错误 (旧实现负尺寸完全不渲染: sx 越界被 continue 跳过)。
    const flipX = dw < 0, flipY = dh < 0;
    const adw = Math.abs(dw), adh = Math.abs(dh);
    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    const halfW = adw / 2, halfH = adh / 2;
    // 图心相对旋转支点的偏移 (支点=图心时为 0 → 与旧实现逐位一致)
    const mx = cx - pivotX, my = cy - pivotY;
    // 旋转后包围盒 (保守扫描范围, 以支点为中心)
    const absC = Math.abs(cos), absS = Math.abs(sin);
    const rw = halfW * absC + halfH * absS, rh = halfW * absS + halfH * absC;
    const x0 = Math.floor(pivotX - rw), y0 = Math.floor(pivotY - rh);
    const x1 = Math.ceil(pivotX + rw), y1 = Math.ceil(pivotY + rh);
    const invDw = img.width / adw, invDh = img.height / adh;
    for (let ty = y0; ty < y1; ty++) {
      if (ty < 0 || ty >= this.h) continue;
      for (let tx = x0; tx < x1; tx++) {
        if (tx < 0 || tx >= this.w) continue;
        // 逆旋转到未旋转坐标 (相对支点), 再移回"以图心为原点"的坐标系
        const ox = tx - pivotX, oy = ty - pivotY;
        const ux = ox * cos - oy * sin - mx;
        const uy = ox * sin + oy * cos - my;
        // 未旋转矩形内 → 源 UV (负尺寸: 翻转 ux/uy 实现镜像)
        let sux = ux, suy = uy;
        if (flipX) sux = -sux;
        if (flipY) suy = -suy;
        const sx = (sux + halfW) * invDw;
        const sy = (suy + halfH) * invDh;
        if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
        const si0 = Math.min(img.width - 1, sx | 0);
        const sj0 = Math.min(img.height - 1, sy | 0);
        const fx = sx - si0, fy = sy - sj0;
        const i0 = (sj0 * img.width + si0) * 4;
        const i1 = (sj0 * img.width + Math.min(img.width - 1, si0 + 1)) * 4;
        const i2 = (Math.min(img.height - 1, sj0 + 1) * img.width + si0) * 4;
        const i3 = (Math.min(img.height - 1, sj0 + 1) * img.width + Math.min(img.width - 1, si0 + 1)) * 4;
        const a = (img.rgba[i0 + 3] * (1 - fx) * (1 - fy) + img.rgba[i1 + 3] * fx * (1 - fy)
          + img.rgba[i2 + 3] * (1 - fx) * fy + img.rgba[i3 + 3] * fx * fy) / 255 * alpha;
        if (a <= 0) continue;
        const r = img.rgba[i0] * (1 - fx) * (1 - fy) + img.rgba[i1] * fx * (1 - fy)
          + img.rgba[i2] * (1 - fx) * fy + img.rgba[i3] * fx * fy;
        const g = img.rgba[i0 + 1] * (1 - fx) * (1 - fy) + img.rgba[i1 + 1] * fx * (1 - fy)
          + img.rgba[i2 + 1] * (1 - fx) * fy + img.rgba[i3 + 1] * fx * fy;
        const b = img.rgba[i0 + 2] * (1 - fx) * (1 - fy) + img.rgba[i1 + 2] * fx * (1 - fy)
          + img.rgba[i2 + 2] * (1 - fx) * fy + img.rgba[i3 + 2] * fx * fy;
        const di = (ty * this.w + tx) * 4;
        const dstA = this.data[di + 3] / 255;
        const outA = a + dstA * (1 - a);
        if (outA <= 0) continue;
        this.data[di] = Math.round((r * a + this.data[di] * dstA * (1 - a)) / outA);
        this.data[di + 1] = Math.round((g * a + this.data[di + 1] * dstA * (1 - a)) / outA);
        this.data[di + 2] = Math.round((b * a + this.data[di + 2] * dstA * (1 - a)) / outA);
        this.data[di + 3] = Math.round(outA * 255);
      }
    }
  }
}

// ── PNG 编码 (filter 0) ────────────────────────────────────────
// 修复: CRC32 256 项表提到模块作用域 (原先每次 crc32() 调用都重建一遍表)
// §三十三 取证: 三个绘制内核的**总耗时** (无论谁调用)。用包装而不是改函数体,
// 避免碰热路径逻辑; 关闭剖析时完全不安装。
if (PROF) {
  for (const m of ['blit', 'blitScaled', 'blitRotated']) {
    const orig = Canvas.prototype[m];
    if (typeof orig !== 'function') continue;
    Canvas.prototype[m] = function wrappedBlit(...args) {
      const t0 = performance.now();
      try { return orig.apply(this, args); } finally { profAdd('绘制:' + m, performance.now() - t0); }
    };
  }
}

const CRC32_TABLE = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[n] = c;
}
function crc32(b) {
  let crc = 0xffffffff;
  for (let i = 0; i < b.length; i++) crc = CRC32_TABLE[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ── PNG 解码 (最小: 支持 RGBA/RGB 8bit, filter 0-4) ─────────────
export function decodePngBuffer(b) {
  if (b.length < 8 || b[0] !== 0x89 || b[1] !== 0x50) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idatChunks = [];
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8) throw new Error('unsupported bit depth ' + bitDepth);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 4;
  if (colorType === 3) throw new Error('palette png unsupported');
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const bb = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + bb) & 0xff;
      else if (filter === 3) v = (v + ((a + bb) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? bb : c);
        v = (v + pr) & 0xff;
      }
      out[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      if (channels === 4) {
        rgba[di] = out[x * 4]; rgba[di + 1] = out[x * 4 + 1]; rgba[di + 2] = out[x * 4 + 2]; rgba[di + 3] = out[x * 4 + 3];
      } else if (channels === 3) {
        rgba[di] = out[x * 3]; rgba[di + 1] = out[x * 3 + 1]; rgba[di + 2] = out[x * 3 + 2]; rgba[di + 3] = 255;
      } else {
        rgba[di] = out[x]; rgba[di + 1] = out[x]; rgba[di + 2] = out[x]; rgba[di + 3] = 255;
      }
    }
    prev.set(out);
  }
  return { width, height, rgba };
}
