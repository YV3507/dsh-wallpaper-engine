// WE 渲染引擎 — effects 聚合入口
// 各效果实现拆分在 effects/ 子目录 (按效果 1 文件), 此文件仅保留 applyEffects 分派
import path from 'path';
import { getVal } from './math.js';
import { fx as fxGodrays } from './effects/godrays.js';
import { fx as fxScroll } from './effects/scroll.js';
import { fx as fxTint } from './effects/tint.js';
import { fx as fxPulse } from './effects/pulse.js';
import { fx as fxFilmgrain } from './effects/filmgrain.js';
import { fx as fxOpacity } from './effects/opacity.js';
import { fx as fxSkew } from './effects/skew.js';
import { fx as fxIris } from './effects/iris.js';
import { fx as fxLightshafts } from './effects/lightshafts.js';
import { fx as fxCloudmotion } from './effects/cloudmotion.js';
import { fx as fxShimmer } from './effects/shimmer.js';
import { fx as fxBlurradial } from './effects/blurradial.js';
import { fx as fxBlur } from './effects/blur.js';
import { fx as fxDepthParallax } from './effects/depthparallax.js';
import { fx as fxWaterCaustics } from './effects/watercaustics.js';
import { fx as fxBlend } from './effects/blend.js';
import { fx as fxGlitter } from './effects/glitter.js';
import { fx as fxClouds } from './effects/clouds.js';
import { fx as fxSwing } from './effects/swing.js';
import { fx as fxWaterflow } from './effects/waterflow.js';
import { fx as fxFoliageSway } from './effects/foliagesway.js';
import { fx as fxWaterwaves } from './effects/waterwaves.js';
import { fx as fxWaterripple } from './effects/waterripple.js';
import { fx as fxShake } from './effects/shake.js';
// 原生 texture_override (solidlayer 的实际画面来源; 依赖它否则退化为纯色块)
import { fx as fxTextureOverride } from './effects/texture-override.js';
// P0-6 泄漏修复: 效果内核借出的 scratch 缓冲在抛错路径的归还守卫
import { scratchScopeBegin, scratchScopeRelease, scratchScopeEnd } from './effects/_scratch.js';

const allFx = Object.assign({}, fxGodrays, fxScroll, fxTint, fxPulse, fxFilmgrain, fxOpacity, fxSkew, fxIris, fxLightshafts, fxCloudmotion, fxShimmer, fxBlurradial, fxBlur, fxDepthParallax, fxWaterCaustics, fxBlend, fxGlitter, fxClouds, fxSwing, fxWaterflow, fxFoliageSway, fxWaterwaves, fxWaterripple, fxShake, fxTextureOverride);

// 实时组件启发式 (原 core.js _isLiveComponent, P1-2 改为逐效果跳过): 音频条/
// 频谱类效果无实时音频输入 → 跳过该效果, 对象照常渲染 (旧: 整对象被过滤)。
// 时间文本另有 _isLiveText (text.js) 单独跳过。
const LIVE_FX_RE = /audio|bars|oscilloscope|visualizer|equalizer|spectrum/i;

// 效果链"是否真的产出了内容"的判据 (仅 instanced 纯色层调用方索取, 见 image.js
// _renderSolidLayer): 输出与输入**逐字节不同**才算该效果真正塑形 (尺寸变化视为不同)。
// 只看"效果被派发过"不够 — dock 的 user_texture_alpha_overwrite_workaround 每次都
// 被派发, 但它是恒等变换 (mask=1, g_UserAlpha=1), 输出内容与输入完全一致。
function fxContentDiffers(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return true;
  const x = a.rgba, y = b.rgba;
  if (!x || !y || x.length !== y.length) return true;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return true;
  return false;
}

export function installEffects(proto) {
  Object.assign(proto, {
    // status: 可选上报对象 {produced} — 调用方传入时记录"本链是否有任一效果产出内容"
    // (instanced 纯色层的占位块防护用); 不传则零额外开销。
    applyEffects(o, tex, t, status) {
        let img = tex;
        for (const ef of o.effects || []) {
          if (getVal(ef, 'visible', true) === false) continue;
          const file = ef.file || '';
          if (!file) continue;
          const name = path.basename(path.dirname(file)); // effects/waterwaves → waterwaves
          // P1-2: 实时音频类效果只跳过该效果 (对象保留), 记 onDegraded
          if (LIVE_FX_RE.test(name)) {
            this.log('跳过实时效果 ' + name + ' (无音频输入): ' + (o.name || o.id));
            this._degraded(o.name != null ? String(o.name) : null, 'effect:' + name, '音频/频谱实时效果无音频输入，已跳过该效果（对象保留）');
            continue;
          }
          const passes = ef.passes || [];
          const pass = passes[0] || {};
          const c = pass.constantshadervalues || {};
          const combos = pass.combos || {};
          const __before = img; // 退化保护基准 (见下方 catch 之后的检测)
          // P0-6 泄漏修复: 本效果从 scratch 池借出的缓冲全部登记, 抛错时统一归还
          // (blur/godrays/glitter 等 24 个内核只在正常路径 scratchPut, 中途抛错
          //  会让借出的整帧缓冲永久停在 out 状态 → 每帧滞留一块整帧内存)
          const __scope = scratchScopeBegin();
          try {
            if (name === 'waterwaves') {
              img = this.effectWaterwaves(img, c, t, pass);
            } else if (name === 'waterflow') {
              img = this.effectWaterflow(img, c, t, pass);
            } else if (name === 'foliagesway') {
              img = this.effectFoliageSway(img, c, t, pass);
            } else if (name === 'skew') {
              img = this.effectSkew(img, c, t, pass);
            } else if (name === 'iris') {
              img = this.effectIris(img, c, t, pass);
            } else if (name === 'lightshafts') {
              img = this.effectLightshafts(img, c, t, pass);
            } else if (name === 'cloudmotion') {
              img = this.effectCloudmotion(img, c, t, pass);
            } else if (name === 'shimmer') {
              img = this.effectShimmer(img, c, t, pass);
            } else if (name === 'blurradial') {
              img = this.effectBlurradial(img, c, t, pass);
            } else if (name === 'clouds') {
              img = this.effectClouds(img, c, t, pass);
            } else if (name === 'swing') {
              img = this.effectSwing(img, c, t, pass);
            } else if (name === 'waterripple') {
              img = this.effectWaterripple(img, c, t, ef, pass);
            } else if (name === 'shake') {
              img = this.effectShake(img, c, t, pass);
            } else if (name === 'scroll') {
              img = this.effectScroll(img, c, t);
            } else if (name === 'tint') {
              img = this.effectTint(img, c, t, combos, pass);
            } else if (name === 'pulse') {
              img = this.effectPulse(img, c, t, combos, pass);
            } else if (name === 'filmgrain') {
              img = this.effectFilmgrain(img, c, t, combos, pass);
            } else if (name === 'godrays') {
              img = this.effectGodrays(img, passes, t);
            } else if (name === 'texture_override') {
              // solidlayer 的实际画面: 用 pass.textures[1] 覆盖本层贴图 (原生实现,
              // 不依赖 GLSL 解释器) —— 见 effects/texture-override.js
              img = this.effectTextureOverride(img, c, t, combos, pass);
            } else if (name === 'glitter') {
              img = this.effectGlitter(img, passes, t);
            } else if (name === 'opacity') {
              // 官方 shader (effects/opacity.frag): albedo.a *= mask.r
              // (g_Texture1 = mask, 默认 util/white); mask UV 按纹理比缩放 (简化用 uv)
              img = this.effectOpacity(img, c, t, pass);
            } else if (name === 'blur') {
              // 官方 4-pass 高斯模糊链 (downsample4 → gaussian_x → gaussian_y → combine)
              img = this.effectBlur(img, passes, c, t, pass);
            } else if (name === 'depthparallax') {
              // 官方交互式视差 (QUALITY 0/1/2; 静态帧鼠标居中 → 近似恒等)
              img = this.effectDepthParallax(img, c, t, pass);
            } else if (name === 'watercaustics') {
              // 官方水焦散 (4 噪声纹理卷动 + voronoi 图案 + chromatic)
              img = this.effectWaterCaustics(img, c, t, pass);
            } else if (name === 'blend') {
              // 官方 blend (blend 纹理按 BLENDMODE/WRITEALPHA 混合)
              img = this.effectBlend(img, passes, c, t, pass);
            } else {
              // 第三方 workshop 效果 / 官方未实现 (含 blurprecise — P1-5: 旧实现
              // 空 no-op 无条件跳过且阻断 GLSL 兜底; 删除后统一走 GLSL 解释执行)
              // → GLSL 解释执行 (读 pkg/全局 shader); 失败回退原图 (不崩溃) 并记降级
              const out = this._applyGlslEffect(img, ef, name, t);
              if (out === img) {
                this._degraded(o.name != null ? String(o.name) : null, 'effect:' + name, '效果无 CPU 移植且 GLSL 兜底失败，已跳过该效果（对象保留）');
              }
              img = out;
            }
          } catch (e) {
            // P0-6: 抛错路径归还本效果借出的池缓冲 (成功路径由内核自行归还)
            scratchScopeRelease(__scope);
            this.log('效果 ' + name + ' 失败: ' + e.message);
            this._degraded(o.name != null ? String(o.name) : null, 'effect:' + name, '效果渲染失败，已跳过该效果（对象保留）: ' + e.message);
          } finally {
            scratchScopeEnd(__scope);
          }
          // ── 退化保护 (fail-safe): 效果抛错/输出垃圾时**不要替换图层**, 保留原图 ——
          // 这样至少贴图本身还在 (组件可见), 而不是整层消失或整幅报废。
          // 判据 (任一成立即丢弃该效果):
          //   ① 输出变整幅单色而输入不是 (实测 Angel Mail 全屏纯蓝 #075CB6);
          //   ② 输出**覆盖度塌陷** (非透明像素骤减/全透明) 而输入有覆盖 —— pure-color 层
          //      输入本就是单色 RGB (靠 alpha 显形), ① 检不到这种情况, 会整层不可见。
          if (img && img !== __before) {
            const stat = (m) => {
              if (!m || !m.rgba || !m.width || !m.height) return null;
              const n = m.width * m.height, st = Math.max(1, Math.floor(n / 256));
              let cov = 0, tot = 0, uniRgb = true;
              const r = m.rgba[0], g = m.rgba[1], b = m.rgba[2];
              for (let i = 0; i < n; i += st) {
                const q = i * 4; tot++;
                if (m.rgba[q + 3] > 8) cov++;
                if (uniRgb && (m.rgba[q] !== r || m.rgba[q + 1] !== g || m.rgba[q + 2] !== b)) uniRgb = false;
              }
              return { cov: cov / Math.max(1, tot), uniRgb };
            };
            const sb = stat(__before), sa = stat(img);
            if (sb && sa) {
              // texture_override 是**定义图层形状**的效果 (用它把 PNG 贴上 pure-color 层),
              // 其"覆盖度下降"是正确语义 (底色占位被 alpha 形状取代) ⇒ 豁免覆盖度判据,
              // 只保留"整幅单色"判据。否则会被误回退成白块 (实测)。
              const shapeDefining = name === 'texture_override' || name === 'custom_user_texture';
              const collapsed = !shapeDefining && sb.cov > 0.05 && sa.cov < Math.max(0.01, sb.cov * 0.25);
              const flat = sa.uniRgb && !sb.uniRgb;
              if (collapsed || flat) {
                this.log('效果 ' + name + ': 输出退化 (' + (flat ? '整幅单色' : '覆盖度 ' + (sb.cov * 100).toFixed(0) + '%→' + (sa.cov * 100).toFixed(0) + '%') + '), 已丢弃并保留原图');
                this._degraded(o.name != null ? String(o.name) : null, 'effect:' + name, '效果输出退化，已丢弃并保留原图');
                img = __before;
              }
            }
          }
          // 内容产出上报 (status 只在 instanced 纯色层调用时传入): 本效果真正改变了图像
          // 内容才算"产出" — 被上方退化保护丢弃的效果 (img 已还原成 __before) 不算。
          if (status && !status.produced && img && fxContentDiffers(__before, img)) status.produced = true;
        }
        // _rt_ 图层合成: 若本对象被其它层以 _rt_imageLayerComposite_<id>_a 引用, 保留其
        // 合成结果 (含全部效果后的最终图) 供后续层采样 —— 窗户等"合成组件"靠它拼画面
        this._retainComposite(o, img);
        return img;
      },
    ...allFx,
  });
}
