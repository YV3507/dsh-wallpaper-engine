#!/usr/bin/env node
/**
 * blitScaled 采样质量护栏 (scaling sampler guard)
 *
 * 背景：`lib/we-renderer/canvas.js` 的 `blitScaled` 注释曾写 "bilinear"，实现却是
 * `Math.round()` 取整的**点采样**（用户 0.7.x 反馈 Bug 3，附 PSNR 实测：1920×1080 目标
 * 34.60 dB → 改后 40.23 dB；4× 缩小 31.21 → 64.37）。修复见 `e68c1a9`：放大走双线性、
 * 缩小走盒式（面积权重），且**缩放比恰好 1:1 时保持原最近邻路径逐字节不变**。
 * 但当时的数值证据只留在 `scripts/tmp-*` 探索脚本里 —— 本文件把它固化成护栏。
 *
 * 断言（对合成图案做数值判定，不依赖任何真实壁纸）：
 *   P1 缩小：8×8 黑白棋盘 → 2×2 必须是**中灰**（盒式面积平均）而不是纯黑/纯白（点采样）
 *   P2 放大：2×2 黑白四角 → 8×8 的中心区域必须是**插值灰**，且只允许角落附近为纯色
 *   P3 1:1 不变式：blitScaled 在原始尺寸下必须与 blit **逐字节相同**（旧路径被刻意保留）
 *   P4 负对照：同一图案喂给一个"最近邻"参考实现，P1/P2 的判据必须判它不合格
 *      （证明上面两条断言真的能区分"滤波"与"点采样"，而不是恒真）
 */
import { Canvas } from '../lib/we-renderer/canvas.js';

let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS | ' + name + (detail ? ' | ' + detail : ''));
  else { console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); failed++; }
}

/**
 * 造一张 w×h 的黑白棋盘（cell 像素一格）。
 * ⚠️ 源必须是**图像对象**形状 `{ width, height, rgba }` —— `blitScaled` 读的是
 * `img.rgba / img.width / img.height`（`Canvas` 是 `data / w / h`）。第一版这里传了
 * `Canvas`，`img.width` 为 undefined ⇒ 函数在 `if (!(SW > 0)) return` 处静默返回，
 * 于是"什么都没画"却被 P3 的逐字节比较判成"相等"（两边都是 0）——典型的假绿。
 */
function checker(w, h, cell) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((x / cell | 0) + (y / cell | 0)) % 2 === 0;
      const v = on ? 255 : 0;
      const i = (y * w + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}
/** 造一张纯图像对象（用于放大测试：左上白、其余黑）。 */
function corners(w, h) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba[i * 4 + 3] = 255;
  rgba[0] = rgba[1] = rgba[2] = 255;
  return { width: w, height: h, rgba };
}
/** 取目标画布 (x,y) 的灰度。 */
const gray = (c, x, y) => c.data[(y * c.w + x) * 4];

// ── P1 缩小：盒式必须给出中灰 ────────────────────────────────────────────────
{
  const src = checker(8, 8, 1);           // 8×8 棋盘 → 每 2×2 目标像素正好覆盖 4×4 源
  const dst = new Canvas(2, 2);
  dst.blitScaled(src, 0, 0, 2, 2);
  const vals = [gray(dst, 0, 0), gray(dst, 1, 0), gray(dst, 0, 1), gray(dst, 1, 1)];
  const boxed = vals.every((v) => v >= 121 && v <= 134);
  console.log('INFO | P1 缩小结果: ' + vals.join(',') + '（盒式应≈127，点采样会是 0/255）');
  check('P1 缩小 8×8 棋盘 → 2×2 得到中灰（盒式面积滤波，而非点采样）',
    boxed, 'vals=[' + vals.join(',') + ']');
}

// ── P2 放大：双线性必须插值，纯色只允许出现在角落附近 ─────────────────────────
{
  const src = corners(2, 2);              // 左上白，其余黑
  const dst = new Canvas(8, 8);
  dst.blitScaled(src, 0, 0, 8, 8);
  // 中心 4×4 区域应全部是"介于黑白之间"的插值结果（既不 0 也不 255）
  let midInterpolated = 0, midTotal = 0;
  for (let y = 2; y < 6; y++) {
    for (let x = 2; x < 6; x++) {
      midTotal++;
      const v = gray(dst, x, y);
      if (v > 0 && v < 255) midInterpolated++;
    }
  }
  console.log('INFO | P2 中心插值像素: ' + midInterpolated + '/' + midTotal);
  check('P2 放大 2×2 → 8×8：中心区域全部为插值灰（双线性，而非块状点采样）',
    midInterpolated === midTotal && midTotal === 16,
    midInterpolated + '/' + midTotal);
}

// ── P3 1:1 不变式：与 blit 逐字节相同 ────────────────────────────────────────
{
  const src = checker(9, 7, 1);
  const a = new Canvas(9, 7);
  const b = new Canvas(9, 7);
  a.blitScaled(src, 0, 0, 9, 7);
  b.blit(src, 0, 0);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++;
  // ⚠️ 必须同时断言"确实画上了"：否则两个空画布也能判成逐字节相同（本文件第一版就假绿过）。
  let painted = 0;
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] === 255) painted++;
  check('P3 缩放比 1:1 时 blitScaled 与 blit 逐字节相同（旧路径被刻意保留）',
    diff === 0 && painted === 63,
    '不同字节 ' + diff + ' · 已绘制像素 ' + painted + '/63');
}

// ── P4 负对照：最近邻参考实现必须被判不合格 ──────────────────────────────────
{
  /** 与"修复前"等价的点采样：目标像素取最近源像素（源同样是图像对象形状）。 */
  function nearest(src, dw, dh) {
    const out = new Canvas(dw, dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(src.height - 1, Math.round((y + 0.5) * src.height / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(src.width - 1, Math.round((x + 0.5) * src.width / dw));
        const si = (sy * src.width + sx) * 4, di = (y * dw + x) * 4;
        out.data[di] = src.rgba[si]; out.data[di + 1] = src.rgba[si + 1];
        out.data[di + 2] = src.rgba[si + 2]; out.data[di + 3] = 255;
      }
    }
    return out;
  }
  const small = nearest(checker(8, 8, 1), 2, 2);
  const vals = [gray(small, 0, 0), gray(small, 1, 0), gray(small, 0, 1), gray(small, 1, 1)];
  const boxedVerdict = vals.every((v) => v >= 121 && v <= 134); // P1 的判据
  const up = nearest(corners(2, 2), 8, 8);
  let interp = 0;
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) { const v = gray(up, x, y); if (v > 0 && v < 255) interp++; }
  check('P4 负对照：同一判据下点采样被判不合格（说明断言能区分滤波与最近邻）',
    !boxedVerdict && interp === 0,
    '点采样缩小 vals=[' + vals.join(',') + '] 合格=' + boxedVerdict + ' · 放大中心插值=' + interp + '/16');
}

console.log(failed === 0 ? '\nverify-sampling: OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
