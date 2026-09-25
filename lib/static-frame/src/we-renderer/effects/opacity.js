// WE 渲染引擎 — 效果 Opacity (从 effects.js 拆分, 逻辑零改动)
// P0-5: 整帧 out 改 scratch 池借出; mask 采样换单通道 _texR (同数学)
import { getVal } from '../math.js';
import { scratchGet, scratchPut, isScratch, SCRATCH_U8 } from './_scratch.js';

export const fx = {
      // opacity (引擎 shader: effects/opacity.frag): albedo.a *= mask × g_UserAlpha
      //   g_Texture0 = 对象自身纹理, g_Texture1 = mask (默认 util/white)
      //   g_UserAlpha = alpha 参数 (默认 1.0) — 旧实现缺 alpha 且 mask UV 未缩放 (sf39j)

    effectOpacity(tex, c, t, pass) {
        const pt = (pass && pass.textures) || [];
        const maskTex = pt[1] && pt[1] !== 'null' ? this.loadTexture(pt[1]) : this.loadTexture('util/white');
        const userAlpha = getVal(c, 'alpha', 1);
        const W = tex.width, H = tex.height;
        // ⚠️ 回退 dev 线的 "sf35: mSx=mSy=1": 实测皓风琦[3640755971] 的 opacity 遮罩
        //   (包内 materials/masks/opacity_mask_bccc2e54) 在 mSx=1 下采到 0 → 整层 alpha
        //   归零 → 被退化保护回退 ⇒ 该壁纸出现**以前没有过的**渲染结果 (回归)。
        //   恢复"遮罩尺寸/图层尺寸比"的旧语义 (该壁纸多轮实测通过的语义)。
        const mSx = maskTex && maskTex.width > 0 ? maskTex.width / tex.width : 1;
        const mSy = maskTex && maskTex.height > 0 ? maskTex.height / tex.height : 1;
        const src = tex.rgba;
        // P0-5: 整帧 out 改 scratch 池借出
        const out = scratchGet(SCRATCH_U8, src.length);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const u = (x + 0.5) / W, v = (y + 0.5) / H;
            // P0-5: mask 只取 R → _texR; mask 缺失时保持 _texSample(null)[0]=1 契约
            const m = maskTex ? this._texR(maskTex, u * mSx, v * mSy) : 1;
            const di = (y * W + x) * 4;
            out[di] = src[di]; out[di + 1] = src[di + 1]; out[di + 2] = src[di + 2];
            out[di + 3] = Math.round(src[di + 3] * m * userAlpha);
          }
        }
        // P0-5: 输入若为池缓冲 (上一效果输出) 用完归还
        if (isScratch(src)) scratchPut(src);
        return { width: W, height: H, rgba: out };
      }
};
