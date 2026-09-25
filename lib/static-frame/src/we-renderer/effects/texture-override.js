// WE 渲染引擎 — 效果 texture_override (原生 CPU 实现)
// 依据: 场景条目 effects/workshop/3224559305/texture_override/effect.json 的 pass 数据
//       + pkg 内 shader 语义 (shaders/workshop/3224559305/effects/texture_override.frag):
//         blendColors = texSample2D(g_Texture1, <uv>); blendColors.a *= g_Alpha * u_Opacity;
//         gl_FragColor = blendFg/blendBg(originalTex, blendColors)  ← 与输入图混合
// 用途: solidlayer (纯色层) 靠它显示真实画面 —— 窗户/窗帘/云/树等; GLSL 解释器失败时
//       若不做原生实现, 这些组件会退化成纯色块 (白块)。
import { applyBlending } from '../math.js';

export const fx = {
      effectTextureOverride(tex, c, t, combos, pass) {
        const p = pass || {};
        const c1 = p.constantshadervalues || {};
        const pt = p.textures || [];
        let ref = null;
        for (let i = 1; i < pt.length; i++) if (pt[i] && pt[i] !== 'null') { ref = pt[i]; break; }
        if (!ref) return tex; // 无覆盖贴图 → 不应用 (保留原图层)
        const ov = this.loadTexture(ref);
        if (!ov || !ov.rgba) return tex;
        // 遮罩 (textures[2], 官方 OPACITYMASK): 决定"覆盖贴在哪些像素" —— 窗帘/树叶等靠它
        // 形成褶皱/叶形; 缺失会把整块矩形贴上画面 (观感 = 矩形纯色块)。官方按**图层自身 UV**
        // 采其红通道: blendColors *= texSample2D(g_Texture2, v_TexCoord.xy).r
        let mask = null;
        for (let i = 2; i < pt.length; i++) if (pt[i] && pt[i] !== 'null') { mask = this.loadTexture(pt[i]); if (mask) break; }
        const W = tex.width, H = tex.height, src = tex.rgba;
        // 从**输入拷贝**开始: 官方语义是"在输入之上混合", 覆盖无贡献的像素必须保持原值
        // (此前用全零缓冲 + continue ⇒ 覆盖度塌陷 100%→2% ⇒ 被退化保护回退 ⇒ 又成底色矩形)
        const out = new Uint8Array(src);
        const num = (v, d) => { const n = typeof v === 'string' ? v.trim().split(/\s+/).map(Number) : [Number(v)]; return isFinite(n[0]) ? n : d; };
        // 缺省 [0.5, 0.5] = WE shader 元注释声明的默认值 (uniform vec2 g_offset
        // {"default":"0.5 0.5"}) ⇒ 未设置时等价于恒等映射 (旧代码缺省 [0,0] 会把内容
        // 平移 -0.5、一半移出图层 ⇒ 变暗/被切, 实测皓风琦两实例均未设置 uvOffset)。
        const uvOffset = num(c1.uvOffset, [0.5, 0.5]);
        const scale = num(c1.scale, [1, 1]);
        const opacity = isFinite(Number(c1.opacity)) ? Number(c1.opacity) : 1;
        const aThr = isFinite(Number(c1.alphaThreshold)) ? Number(c1.alphaThreshold) : 0;
        // 官方 NORMAL_OFFSET=1 时 uvOffset 为归一化值 (0..1), 否则为像素值 → 归一
        const normalOffset = Number((combos || {}).NORMAL_OFFSET || 0) === 1;
        const ang = isFinite(Number(c1.angle)) ? Number(c1.angle) : 0;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        // 官方 UV 式 (按 pkg 内 texture_override.vert 逐步 transcription):
        //   aspect = g_Texture0Resolution.z / .w            (输入图宽高比)
        //   scaleUV = g_Texture0Resolution / g_Texture1Resolution  (输入尺寸 / 覆盖图尺寸)
        //   offset  = 0.5 - g_offset ;  rotationCenter = 0.5 - offset = g_offset
        //   d = uv - rotationCenter ; d.x *= aspect ; d = rotate(d, ±angle) ; d.x /= aspect
        //   d = d * scaleUV / g_TexScale ;  final = d + rotationCenter + offset = d + 0.5
        const inW = tex.width, inH = tex.height;
        const aspect = inH > 0 ? inW / inH : 1;
        // ⚠️ 不使用 (输入尺寸/覆盖图尺寸) 作为 UV 缩放: 该比值在 WE 里取决于内部 RT 尺寸,
        //   我方纯色层表面尺寸=四边形尺寸后它会改变, 导致同一壁纸出现**单方向拉伸**
        //   (实测皓风琦回归)。语义上覆盖贴图应"铺满该层", UV = 图层uv × 材质scale + uvOffset。
        const scaleUV = [1, 1];
        const rc = uvOffset; // = g_offset (NORMAL_OFFSET=1 时 g_offset 即归一化 uvOffset)
        const thr255 = aThr * 255;
        // 官方是**混合而非替换** (frag 第 31-39 行 blendFg/blendBg):
        //   rgb = mix(original, ApplyBlending(BLENDMODE, original, over, g_Alpha*u_Opacity), over.a)
        //   a   = max(original.a, over.a * g_Alpha * u_Opacity)
        // 一个对象常挂**多个** texture_override (窗户 ×3 / 窗帘 / 树叶), 逐层混合才能拼出
        // 窗框+窗格+玻璃等; 覆盖式实现只会剩最后一张图 = 矩形纯色块。
        const mode = Number((combos || {}).BLENDMODE != null ? (combos || {}).BLENDMODE : 2);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const di = (y * W + x) * 4;
            const u = (x + 0.5) / W, v = (y + 0.5) / H;
            // 语义 (实测 12/12 实例): 覆盖贴图的 alpha 内容包围盒 ≈ 整张贴图 (0.98~1.0),
            // g_TexScale(材质 scale) 恒为 "1 1" ⇒ 该贴图应**1:1 铺满该层** (identity)。
            // uvOffset 若当位移使用, 会把内容推出四边形 ⇒ 组件被**水平/垂直边切割**
            // (用户反馈); 当作原点位移则表现为纯位置错误。故只在有缩放/旋转时绕中心变换,
            // 默认即恒等映射。
            let dx = u - 0.5, dy = v - 0.5;
            if (ang) { const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca; dx = rx; dy = ry; }
            const su = dx * (scale[0] || 1) + 0.5;
            const sv = dy * (scale[1] || 1) + 0.5;
            const s = this._texSample(ov, su, sv, true);
            let oa = s[3]; // 0..1
            if (mask) oa *= this._texSample(mask, u, v, true)[0]; // 遮罩红通道 (图层 UV)
            const amt = oa * opacity; // g_Alpha(=1) * u_Opacity
            if (oa * 255 <= thr255 || amt <= 0) {
              // 覆盖贴图在此处无贡献 ⇒ 该层**透明** (solidlayer 的白底只是占位; 否则组件
              // 背后会留一块白色矩形 —— 实测用户反馈"组件可见但背后是白色方块")
              out[di + 3] = 0;
              continue;
            }
            const or0 = src[di], og0 = src[di + 1], ob0 = src[di + 2];
            const bl = applyBlending(mode, [or0 / 255, og0 / 255, ob0 / 255], [s[0], s[1], s[2]], amt);
            // mix(original, blended, over.a)
            out[di] = Math.round(Math.min(255, Math.max(0, (or0 / 255 + (bl[0] - or0 / 255) * oa) * 255)));
            out[di + 1] = Math.round(Math.min(255, Math.max(0, (og0 / 255 + (bl[1] - og0 / 255) * oa) * 255)));
            out[di + 2] = Math.round(Math.min(255, Math.max(0, (ob0 / 255 + (bl[2] - ob0 / 255) * oa) * 255)));
            // alpha 由**覆盖贴图**决定 (乘以本层已有 alpha): solidlayer 的底色是占位白块,
            // 若用 max(输入a, 覆盖a) 会保留整块不透明白底 ⇒ 组件背后出现白色方块
            // (实测用户反馈)。WE 里该层就是"这张 PNG + 它的 alpha 形状"。
            out[di + 3] = Math.round(Math.min(1, oa * opacity) * (src[di + 3] / 255) * 255);
          }
        }
        return { width: W, height: H, rgba: out };
      }
};
