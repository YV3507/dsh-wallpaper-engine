// WE 渲染引擎 — image (从 core.js 拆分, 逻辑不变)
import path from 'path';
import { parseVec3, parseVec2, getVal, rgb2hsv, hsv2rgb, smoothstepFn } from './math.js';
// 修复: passthrough 层的整帧拷贝改借 scratch 池 (原先每层每帧 new 一份, 4K=33MB)
import { scratchGet, SCRATCH_U8 } from './effects/_scratch.js';
import { atlasFrameRect } from './textures.js';
import { profAdd, profileEnabled } from './profile.js';

// 顶点着色器**与对象变换无关** (gl_Position 由 a_TexCoord / a_Position 直接生成) 的
// 自带着色器 —— 只有这些可以发全屏 quad:
//   bg.vert:23       gl_Position = vec4(a_TexCoord * 2 - 1, 0.5, 1)
//   cloudsbg.vert:9  gl_Position = vec4(a_Position, 1.0)
// 其余 (flowimage.vert:25 用 g_ModelViewProjectionMatrix) 必须按对象矩形派发。
const FULLSCREEN_QUAD_SHADERS = new Set(['bg', 'cloudsbg']);

// ── image mixin (从 core.js 拆分, 逻辑零改动) ──
export function installImage(proto) {
  Object.assign(proto, {
    _renderFullscreenShader(o, model, mat, pass, shaderName, t) {
        const uniforms = this._materialUniforms(mat, pass);
        const textures = (pass && pass.textures || []).map((p) => this.loadTexture(p));
        const tex = textures[0] || null;
        const tex1 = textures[1] || null;
        const tex2 = textures[2] || null;
        const tex3 = textures[3] || null;
        const W = this.W, H = this.H;
        const positions = [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]];
        const uvs = [[0, 0], [1, 0], [0, 1], [1, 1]];
        const indices = [0, 2, 1, 2, 3, 1]; // CCW (屏幕空间)
        const n = 4;
        const vp = new Float64Array(n * 6);
        const shadeData = new Float64Array(n * 8);
        // ── quad 几何: 全屏 vs 按对象矩形 ──────────────────────────────
        // 官方 image 对象的 quad 由**网格顶点** (`models/*.json` 的 width/height) 经对象
        // origin/scale/angles 与投影落到屏幕 —— 即 CImage 的本地矩形。只有顶点着色器
        // **与对象变换无关**的 shader 才是真全屏 quad:
        //   bg.vert:23       gl_Position = vec4(a_TexCoord * 2 - 1, 0.5, 1)
        //   cloudsbg.vert:9  gl_Position = vec4(a_Position, 1.0)
        // flowimage.vert:13  `gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix)`
        // ⇒ 必须按对象矩形派发。旧实现一律发全屏 quad, 实测:
        //   · deep_space/Background: 丢 origin(928.116,552.332)/scale(1.117)/angles(-0.064 rad
        //     = -3.667°), uv 偏差 Δu≈0.067~0.096 (≈197 texel @2048²);
        //   · beach/beach: 丢 origin(958.708,618.892)/scale(1.285), 可见 uv 域由 [0,1]² 变成
        //     u∈[0.0142,0.9872] × v∈[0.1496,0.9702], 纹理足迹从各向同性
        //     (0.32122 × 0.32125 px/texel) 变成各向异性 (0.31250 × 0.26367, 比 1.1852)
        //     —— 即"横向拉伸 1.1852× / 宽高比失真 0.8438×"。
        // 几何直接验证 (官方 MVP 链投影的 4 角 vs 本函数构造的 4 角 + 逐像素 uv 反解)
        // 与两种语义 (全屏 uv / 对象矩形 uv) 的量化: scripts/tmp-beach-geom.mjs。
        const tr0 = FULLSCREEN_QUAD_SHADERS.has(shaderName) ? null : this.resolveTransform(o);
        const useRect = !!tr0;
        if (useRect) {
          // 尺寸: 官方 image 对象默认尺寸 = model json 的 width/height (缺省才退回贴图)
          let size = parseVec2(getVal(o, 'size'), [0, 0]);
          if ((size[0] === 0 || size[1] === 0) && model && model.width && model.height) size = [model.width, model.height];
          if ((size[0] === 0 || size[1] === 0) && tex) size = [tex.width, tex.height];
          if (model && model.fullscreen) size = [W, H];
          const ortho = this.scene.general && this.scene.general.orthogonalprojection;
          const ps = ortho && ortho.width ? [W / ortho.width, H / (ortho.height || 1080)] : null;
          const vs0 = this._viewShift(o, size, ps);
          const ox = (ps ? tr0.origin[0] * ps[0] : tr0.origin[0]) + vs0[0];
          const dw = size[0] * tr0.scale[0] * (ps ? ps[0] : 1);
          const dh = size[1] * tr0.scale[1] * (ps ? ps[1] : 1);
          let dx = ox - dw / 2;
          let dy = H - (ps ? tr0.origin[1] * ps[1] : tr0.origin[1]) - dh / 2 + vs0[1];
          const align = String(getVal(o, 'alignment', '')).toLowerCase();
          if (align.includes('top')) dy += dh / 2;
          else if (align.includes('bottom')) dy -= dh / 2;
          if (align.includes('left')) dx += dw / 2;
          else if (align.includes('right')) dx -= dw / 2;
          const cx = dx + dw / 2, cy = dy + dh / 2;
          // 旋转与 canvas.blitRotated 同一约定 (canvas.js:418 cos(-angle)): 源点偏移
          // (ux,uy) → 屏幕偏移 (c*ux - s*uy, s*ux + c*uy)
          const ca = Math.cos(tr0.angle), sa = Math.sin(tr0.angle);
          for (let i = 0; i < n; i++) {
            const ux = (uvs[i][0] - 0.5) * dw, uy = (uvs[i][1] - 0.5) * dh;
            vp[i * 6] = cx + ca * ux - sa * uy;
            vp[i * 6 + 1] = cy + sa * ux + ca * uy;
            vp[i * 6 + 2] = 1; vp[i * 6 + 3] = 0.5;
            vp[i * 6 + 4] = uvs[i][0]; vp[i * 6 + 5] = uvs[i][1];
            shadeData[i * 8 + 2] = 1; // 法线 +z
          }
        } else {
          for (let i = 0; i < n; i++) {
            const sx = (positions[i][0] * 0.5 + 0.5) * W;
            const sy = (0.5 - positions[i][1] * 0.5) * H;
            vp[i * 6] = sx; vp[i * 6 + 1] = sy; vp[i * 6 + 2] = 1; vp[i * 6 + 3] = 0.5;
            vp[i * 6 + 4] = uvs[i][0]; vp[i * 6 + 5] = uvs[i][1];
            shadeData[i * 8 + 2] = 1; // 法线 +z
          }
        }
        const vs = { shaderName, uniforms, tex, tex1, tex2, tex3, textures, textureNames: (pass && pass.textures) || [], t, combos: (pass && pass.combos) || {} };
        const blending = pass && pass.blending ? pass.blending : 'opaque';
        const depthWrite = !(pass && pass.depthwrite === 'disabled');
        this._rasterizeMesh3D(indices, vp, shadeData, vs, blending, depthWrite);
      }
    
      // 材质 uniforms: usershadervalues (如 schemecolor→tint) 解析
,
    _materialUniforms(mat, pass) {
        const out = {};
        const usv = pass && pass.usershadervalues;
        if (usv) for (const [prop, uniform] of Object.entries(usv)) {
          const v = this.userProps[prop];
          if (v != null) {
            if (typeof v === 'string' && v.trim().split(/\s+/).length > 1) out[uniform] = parseVec3(v, [1, 1, 1]);
            else out[uniform] = typeof v === 'number' ? v : parseFloat(v);
          }
        }
        const csv = pass && pass.constantshadervalues;
        if (csv) for (const [k, v] of Object.entries(csv)) out[k] = v;
        return out;
      }
    
      // 官方视图平移 (仅前景; 背景 size=场景正交尺寸时不随相机平移) 实现见 camera.js
      // _viewShift: scene.camera.eye 只产生 x 平移 [(-ex)·ps, 0] (用户与官方实机对比确认);
      // 仅 camera:"default" 对象驱动的 eye 用完整 origin [(-ex)·ps, (+ey)·ps] (入场运镜)。
      // sf29 曾按标准 LookAt 推导 vs[1]=+ey·ps 并实施, 实测与官方相反 → 已移除, 勿再加回。
,
    renderImage(o, t) {
        const model = this.readJsonAny(o.image);
        if (!model) return;
        const tr = this.resolveTransform(o);
        // puppet 模型 → MDL 网格渲染
        if (model.puppet) {
          this.renderPuppet(o, model, tr, t);
          return;
        }
        // 自定义 shader 材质 (cloudsbg 等程序化全屏效果) → 全屏 quad 走 3D 光栅化
        const mat = model.material ? this.readJsonAny(model.material) : null;
        const pass = mat && mat.passes && mat.passes[0] ? mat.passes[0] : null;
        const shaderName = pass ? pass.shader : '';
        if (shaderName && this._customShaders.has(shaderName)) {
          this._renderFullscreenShader(o, model, mat, pass, shaderName, t);
          return;
        }
        // passthrough 后处理层 (fullscreenlayer 等): 纹理是 _rt_ 渲染目标 → 读取当前画布内容
        const passthrough = model.passthrough === true
          || (pass && pass.textures && pass.textures[0] && String(pass.textures[0]).startsWith('_rt_'));
        if (passthrough) {
          this._renderPassthroughLayer(o, model, pass, t);
          return;
        }
        // solidlayer (纯色层): 无纹理, 用对象 color 填充矩形 (flat shader)
        if (model.solidlayer === true || shaderName === 'flat' || shaderName === 'flatalpha') {
          this._renderSolidLayer(o, model, tr, t);
          return;
        }
        // 数据驱动材质通路 (image 图层) 的激活判定见下方 "img" 装配之后 —— 必须在
        // 效果链**之后**绑定, 这样片元的 g_Texture0 = 本层效果链输出 (与官方
        // g_Texture0 = 链输入一致), 而不是原始纹理。
        const wantImageProgram = !!shaderName && !this._imageShaderHandled(shaderName);
        // 大动画图集: 加载时只解码当前帧 (无损, docs §二十七)。sway/flag/retro
        // 在裁剪之前使用整张纹理, 故这些着色器保持整图加载语义不变。
        const atlasTime =
          pass && pass.combos && (pass.combos.spritesheet || pass.combos.SPRITESHEET) &&
          shaderName !== 'swayimage' && shaderName !== 'flag' && shaderName !== 'retro'
            ? t : null;
        const __tTex = profileEnabled() ? performance.now() : 0;
        let tex = this.loadModelTexture(o.image, atlasTime != null ? { time: atlasTime } : undefined);
        // §三十三 取证: 取纹理 (含帧解码/缓存命中) 的耗时 —— n 列即为调用次数
        if (profileEnabled()) profAdd('对象内部:取纹理', performance.now() - __tTex);
        if (!tex) {
          this.log('跳过 image ' + (o.name || o.id) + ': 无纹理');
          // 同样要进 degraded 通道: 主图层无纹理 = 整帧空白, 此前只有 log 可见。
          // (纹理为什么缺失由 loadTexture 的 texture: 条目给出具体原因)
          this._degraded(o.name != null ? String(o.name) : null, 'object:image',
            '图层纹理不可用 → 该图层已跳过（画面缺少这一层；主图层时即整帧空白）');
          return;
        }
        // swayimage 摆动 (beach/palms): 纹理级预处理 — swayMask 正弦位移采样
        if (shaderName === 'swayimage') {
          const swayTex = pass && pass.textures && pass.textures[1] ? this.loadTexture(pass.textures[1]) : null;
          tex = this._swayImage(tex, swayTex, this._materialUniforms(mat, pass), t);
        }
        // flag 旗帜飘动: 法线贴图扰动 + 光照
        if (shaderName === 'flag') {
          const nTex = pass && pass.textures && pass.textures[1] ? this.loadTexture(pass.textures[1]) : null;
          const cTex = pass && pass.textures && pass.textures[2] ? this.loadTexture(pass.textures[2]) : null;
          tex = this._flagImage(tex, nTex, cTex, this._materialUniforms(mat, pass), pass, t);
        }
        // retro 霓虹 (retro): HSV 色调 + grunge + DOTS
        if (shaderName === 'retro') {
          const gTex = pass && pass.textures && pass.textures[1] ? this.loadTexture(pass.textures[1]) : null;
          tex = this._retroImage(tex, gTex, this._materialUniforms(mat, pass), pass, t, this.W, this.H);
        }
        // genericimage 材质常数 (Bright/Alpha/Power) + Scroll 1/2 (+ MULTI/SPRITESHEET)
        // —— 官方 assets/shaders/genericimage.{vert,frag}; 见 _genericImagePlan 注释。
        // **只在材质确实声明了非常数/滚动时启用** ⇒ 恒等材质 (deep_space/galaxy_2_base 等)
        // 完全不走这条路径, 逐字节不变。
        let giAlpha = 1;
        let giBlendMaterial = 0;
        const giPlan = this._genericImagePlan(pass, shaderName);
        if (giPlan && tex) {
          const giTex1 = pass && pass.textures && pass.textures[1] ? this.loadTexture(pass.textures[1]) : null;
          const res = this._genericImageApply(tex, giTex1, giPlan, t);
          if (res) { tex = res; giAlpha = giPlan.alpha; }
          // 材质 `blending: additive` → dst += src.rgb * src.a (与 model 光栅化 model.js:853-854
          // 的 additive 同一算式; 复用 applyBlending mode 31 = `A + B*opacity`, opacity = srcA*alpha)。
          // ⚠ 作用域: 只在 genericimage 的这条**已激活**路径上生效 (blending 仍不是全 image 通路
          // 的通用能力, 见报告未决点); 且 blitRotated 无 blendMode 形参 (audit T4) ⇒ 旋转层不生效。
          if (String((pass && pass.blending) || '').toLowerCase() === 'additive') giBlendMaterial = 31;
        }
        // spritesheet 动画: 按时间选帧, 裁剪帧子区域 (引擎 TEXS 帧元数据)
        if (pass && pass.combos && (pass.combos.spritesheet || pass.combos.SPRITESHEET) && tex.frames && tex.frames.count > 1) {
          const fr = tex.frames;
          const frameIdx = Math.floor(t / fr.duration) % fr.count;
          const f = fr.items[frameIdx];
          if (f) {
            // 裁剪帧区域 (帧坐标是像素, 相对纹理)
            const fw = f.width || Math.floor(tex.width / fr.count);
            const fh = f.height || tex.height;
            const fx = f.x || frameIdx * fw;
            const fy = f.y || 0;
            const cropped = new Uint8Array(fw * fh * 4);
            for (let y = 0; y < fh && fy + y < tex.height; y++) {
              cropped.set(tex.rgba.subarray(((fy + y) * tex.width + fx) * 4, ((fy + y) * tex.width + fx + fw) * 4), y * fw * 4);
            }
            tex = { width: fw, height: fh, rgba: cropped };
          }
        }
        // 尺寸: scene size 或纹理尺寸
        let size = parseVec2(getVal(o, 'size'), [0, 0]);
        if ((size[0] === 0 || size[1] === 0) && tex) size = [tex.width, tex.height];
        // model fullscreen → 全屏
        if (model.fullscreen) { size = [this.W, this.H]; }
        const alpha = getVal(o, 'alpha', 1);
        const brightness = getVal(o, 'brightness', 1);
        // 正交投影缩放: 场景单位(ortho width/height) → 画布像素
        const ortho = this.scene.general && this.scene.general.orthogonalprojection;
        const ps = ortho && ortho.width ? [this.W / ortho.width, this.H / (ortho.height || 1080)] : null;
        const vs = this._viewShift(o, size, ps);
        const ox = (ps ? tr.origin[0] * ps[0] : tr.origin[0]) + vs[0];
        const sc = tr.scale;
        // CImage 坐标: 像素左上角 = (origin.x - dw/2, H - origin.y - dh/2), y 向下
        // viewShift 的 vs[1] = 画布 y 偏移 (直接加, 与 renderPuppet 一致):
        // 官方 view 平移 +eye.y 场景单位 → 画布上移; 旧实现把 vs[1] 放进 oy
        // (减号前) 导致 image 与 puppet 的 y 平移方向相反 (差 2×eye.y×ps) —
        // image 组件与 puppet 的 y 平移方向相反 (差 2×eye.y×ps) — 组件相对错位 = "位置相反"
        const dw = size[0] * sc[0] * (ps ? ps[0] : 1), dh = size[1] * sc[1] * (ps ? ps[1] : 1);
        let dx = ox - dw / 2, dy = this.H - (ps ? tr.origin[1] * ps[1] : tr.origin[1]) - dh / 2 + vs[1];
        // alignment 调整 (CImage.cpp:242-256): 默认中心; top/bottom/left/right 使对应边锚定 origin
        // lwe: top → 顶边下移到 origin (矩形在 origin 下方展开); bottom → 底边上移到 origin。
        // 画布 y 向下: top = dy 增大 dh/2, bottom = dy 减小 dh/2 (方向已按 lwe 原文核对)
        const align = String(getVal(o, 'alignment', '')).toLowerCase();
        if (align.includes('top')) dy += dh / 2;
        else if (align.includes('bottom')) dy -= dh / 2;
        // CImage.cpp:250-256: left → m_pos.x += size.x/2 (对象右移, 左边锚定 origin), right → 左移
        if (align.includes('left')) dx += dw / 2;
        else if (align.includes('right')) dx -= dw / 2;
        // §三十九 前提取证: 记录每个纹理"已解码像素 vs 本帧实际绘制像素"。
        // 比值 > 1 才说明存在过采样 ⇒ "按绘制尺寸解码"才有目标。
        if (profileEnabled() && tex && tex.width && o.image) {
          const m = this._drawArea || (this._drawArea = new Map());
          const prev = m.get(o.image) || { texPx: 0, drawnPx: 0 };
          prev.texPx = tex.width * tex.height;
          prev.drawnPx = Math.max(prev.drawnPx, Math.abs(dw) * Math.abs(dh));
          m.set(o.image, prev);
        }
        // 效果链: 先应用 shader 效果到纹理副本 (CPU), 再绘制。
        // 性能 (逆向 lwe 官方): 官方效果是 fragment shader 在 GPU 数千线程并行
        // 处理全分辨率 (4K) 纹理 — CPU 实现逐像素串行, 4K 纹理上每帧 2.7s。
        // sf40f: **删除效果降采样** (旧实现动画帧降采样到显示尺寸再放大 →
        // 全屏波纹/水流在放大后出现马赛克块; 用户要求场景壁纸不得有马赛克)。
        // 全分辨率执行 (CPU 慢但正确; 静态帧 worker 可走 GPU 预计算加速)。
        let img = tex;
        if (o.effects && o.effects.length) {
          img = this.applyEffects(o, img, t);
        }
        // ── 数据驱动材质通路 (image 图层) ──────────────────────────────────
        // 本文件已有的手写通道 (genericimage/swayimage/flag/retro/_customShaders/flat)
        // 保持为快路径; **其余材质 shader** 直接用壁纸自带的 .vert/.frag 编译执行, 片元
        // 在纹理空间逐 texel 求值 (g_Texture0 = 上面的效果链输出), 结果继续走下方
        // 既有 blit/旋转/视差/colorBlend ⇒ 对象级绘制语义零改动。
        // 覆盖: dino_run 的 31 层 genericimage2、razer_bedroom/razer_vortex 的 21 层
        // (此前这些层完全不走材质 shader)。
        if (wantImageProgram && img) {
          let prog = null;
          try {
            prog = this._bindImageProgram(o, pass, shaderName, t, img);
          } catch (e) {
            prog = { ok: false, reason: 'GLSL 解释器绑定异常: ' + (e && e.message) };
          }
          if (prog && prog.ok) {
            (this._matInterpUsed = this._matInterpUsed || []).push(shaderName + '|' + (o.image || o.name || ''));
            const res = this._applyImageProgram(img, o, shaderName, prog);
            if (res) img = res;
          } else if (prog && prog.reason) {
            this._matInterpDegrade(o, shaderName, '数据驱动解释器不可用 → 回退默认 blit: ' + prog.reason);
          }
        }
        if (img && tr.angle !== 0) {
          // 旋转: 以对象中心 (dx+dw/2, dy+dh/2) 旋转 tr.angle 弧度 (引擎 CImage 角度语义)
          const rotated = img.rotated || img;
          this.canvas.blitRotated(rotated, dx + dw / 2, dy + dh / 2, dw, dh, tr.angle, alpha * brightness);
          return;
        }
        // 视差: (depth + amount) * displacement * referenceSize (lwe-CImage.cpp:1111)
        let pdx = 0, pdy = 0;
        if (this.parallaxDisp[0] !== 0 || this.parallaxDisp[1] !== 0) {
          const pd = parseVec2(getVal(o, 'parallaxDepth', '1 1'), [1, 1]);
          const parAmount = getVal((this.scene.camera || {}).parallax, 'amount', 1);
          const ref = this.W;
          pdx = (pd[0] + parAmount) * this.parallaxDisp[0] * ref;
          pdy = (pd[1] + parAmount) * this.parallaxDisp[1] * ref;
        }
        // colorBlendMode: 官方 ApplyBlending(mode, 画布, 对象色, alpha) 颜色混合
        // (lwe CImage.cpp:751 colorBlendMode > 0 → effectpassthrough BLENDMODE pass)
        const cbm = getVal(o, 'colorBlendMode', 0);
        // 材质 `Alpha` (g_UserAlpha) 与**对象** alpha/brightness 语义不同, 两者相乘且互不覆盖:
        //   材质 Alpha → albedo.a *= Alpha (影响覆盖度, 官方 genericimage.frag:26)
        //   对象 alpha/brightness → 层不透明度/亮度 (CImage 属性)
        if (img) this.canvas.blitScaled(img, dx + pdx, dy + pdy, dw, dh, alpha * brightness * giAlpha, cbm > 0 ? cbm : giBlendMaterial);
      }

      // ── genericimage 材质常数 + 滚动 (官方 assets/shaders/genericimage.{vert,frag}) ──
      // vert:9-10,18-19,26-27  `scroll = sign(s)*pow(s,2); v_TexCoord = a_TexCoord + g_Time*scroll`
      //   (Scroll 1 X/Y → g_ScrollX/Y;  #if MULTI: Scroll 2 X/Y → g_Scroll2X/Y, v_TexCoord2)
      // vert:29-34              `#if SPRITESHEET` 走图集 UV 变换 (不做滚动)
      // frag:12-16,21-23        `#if MULTI: albedo *= tex1(v_TexCoord2)`
      // frag:25-27              `albedo.rgb *= g_Brightness; albedo.a *= g_UserAlpha;
      //                          albedo.rgb = pow(albedo.rgb, g_Power)`
      // 材质键名 (来自官方 uniform 注释): Bright / Alpha / Power / Scroll 1 X|Y / Scroll 2 X|Y
      // 返回 null = **无操作** (全部为默认 1/0, 且无 MULTI/SPRITESHEET) ⇒ 调用方保持旧路径。
,
    _genericImagePlan(pass, shaderName) {
        if (shaderName !== 'genericimage') return null;
        const csv = (pass && pass.constantshadervalues) || {};
        const num = (k, d) => (csv[k] != null && isFinite(Number(csv[k])) ? Number(csv[k]) : d);
        const combos = (pass && pass.combos) || {};
        const multi = !!(combos.MULTI || combos.multi);
        const spritesheet = !!(combos.SPRITESHEET || combos.spritesheet);
        const sx = num('Scroll 1 X', 0), sy = num('Scroll 1 Y', 0);
        const s2x = num('Scroll 2 X', 0), s2y = num('Scroll 2 Y', 0);
        const plan = {
          bright: num('Bright', 1), alpha: num('Alpha', 1), power: num('Power', 1),
          scroll: [sx, sy], scroll2: [s2x, s2y], multi, spritesheet,
        };
        const identity = plan.bright === 1 && plan.alpha === 1 && plan.power === 1
          && !sx && !sy && !s2x && !s2y && !multi && !spritesheet;
        return identity ? null : plan;
      }
    
      // 逐像素应用 (纹理级; 采样器 wrap + 双线性 = _texSample 语义)
      // 说明: 官方是在 quad 片元里对**插值后**的 texel 做 Bright/Power; 本实现先在纹理
      // 网格上做 (单次双线性重采样 + 逐 texel 标量运算)。Power==1 时两者恒等;
      // Power≠1 且放大时 bilerp(pow) ≠ pow(bilerp), 属本路径的近似 (见报告未决点)。
,
    _genericImageApply(tex, tex1, plan, t) {
        const w = tex.width, h = tex.height;
        const src = tex.rgba;
        // 官方 `scroll = sign(s) * pow(s, 2)` (逐分量; sign 保号)
        const sgn = (v) => Math.sign(v) * v * v;
        const offX = plan.spritesheet ? 0 : t * sgn(plan.scroll[0]);
        const offY = plan.spritesheet ? 0 : t * sgn(plan.scroll[1]);
        const off2X = plan.spritesheet ? 0 : t * sgn(plan.scroll2[0]);
        const off2Y = plan.spritesheet ? 0 : t * sgn(plan.scroll2[1]);
        const needResample = !!(offX || offY || off2X || off2Y || (plan.multi && tex1));
        const needScalar = plan.bright !== 1 || plan.power !== 1;
        if (!needResample && !needScalar) return null;   // Alpha 由调用方折进 blit alpha
        const out = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w, v = (y + 0.5) / h;
            let c;
            if (needResample) {
              c = this._texSample(tex, u + offX, v + offY);          // frag:19 (MULTI 关) / 或 MULTI 的 tex0
              if (plan.multi && tex1) {
                const c1 = this._texSample(tex1, u + off2X, v + off2Y);  // vert:39 / frag:22
                c = [c[0] * c1[0], c[1] * c1[1], c[2] * c1[2], c[3] * c1[3]];
              }
            } else {
              const si = (y * w + x) * 4;
              c = [src[si] / 255, src[si + 1] / 255, src[si + 2] / 255, src[si + 3] / 255];
            }
            let r = c[0], g = c[1], b = c[2];
            if (plan.bright !== 1) { r *= plan.bright; g *= plan.bright; b *= plan.bright; }  // frag:25
            if (plan.power !== 1) {                                                            // frag:27
              r = Math.pow(Math.max(0, r), plan.power);
              g = Math.pow(Math.max(0, g), plan.power);
              b = Math.pow(Math.max(0, b), plan.power);
            }
            const di = (y * w + x) * 4;
            out[di] = Math.max(0, Math.min(255, Math.round(r * 255)));
            out[di + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
            out[di + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
            out[di + 3] = Math.max(0, Math.min(255, Math.round(c[3] * 255)));
          }
        }
        return { width: w, height: h, rgba: out };
      }
    
      // solidlayer (flat shader): 无纹理纯色填充, 颜色来自对象 color (引擎 flat.frag: uniform color)
,
    _renderSolidLayer(o, model, tr, t) {
        // 带音频条类程序化效果 (未实现) → 跳过, 避免白色占位块覆盖画面
        if (o.effects && o.effects.some((ef) => {
          const n = ef.file ? path.basename(path.dirname(ef.file)) : '';
          return /audio.?bar|audio_bar/i.test(n) || n === 'Simple_Audio_Bars' || n === 'enhanced_simple_audio_bars';
        })) return;
        let size = parseVec2(getVal(o, 'size'), [0, 0]);
        if (size[0] === 0 || size[1] === 0) size = [256, 256];
        if (model.fullscreen) size = [this.W, this.H];
        const alpha = getVal(o, 'alpha', 1);
        const brightness = getVal(o, 'brightness', 1);
        const ortho = this.scene.general && this.scene.general.orthogonalprojection;
        const ps = ortho && ortho.width ? [this.W / ortho.width, this.H / (ortho.height || 1080)] : null;
        const vs = this._viewShift(o, size, ps);
        const ox = (ps ? tr.origin[0] * ps[0] : tr.origin[0]) + vs[0];
        const sc = tr.scale;
        const dw = size[0] * sc[0] * (ps ? ps[0] : 1), dh = size[1] * sc[1] * (ps ? ps[1] : 1);
        // vs[1] 直接加 (与 renderPuppet 一致): 官方 view 平移 y 画布上移
        let dx = ox - dw / 2, dy = this.H - (ps ? tr.origin[1] * ps[1] : tr.origin[1]) - dh / 2 + vs[1];
        const align = String(getVal(o, 'alignment', '')).toLowerCase();
        // lwe CImage.cpp:242-248: top → 顶边下移到 origin; bottom → 底边上移到 origin
        if (align.includes('top')) dy += dh / 2;
        else if (align.includes('bottom')) dy -= dh / 2;
        if (align.includes('left')) dx += dw / 2;
        else if (align.includes('right')) dx -= dw / 2;
        // 颜色: 对象 color (或 model material 无 → 白); flat.frag 直接输出 color
        const col = parseVec3(getVal(o, 'color', '1 1 1'), [1, 1, 1]);
        // ★ 必须按**四边形尺寸**建表面, 不能只造 1×1 像素:
        //   效果是逐像素处理的 (texture_override 的 UV = f(uv, g_offset, 输入/覆盖分辨率);
        //   opacity/waterwaves/sway 的遮罩也按图层 UV 采样)。1×1 输入时所有效果都退化成
        //   单点取值 ⇒ 该层永远是一个**均匀色矩形** (实测: 窗户/窗帘/树叶/云的"矩形纯色块",
        //   且对我方 UV 修正无反应 —— 因为整张图只有 1 个像素)。
        //   官方语义: 该层先渲染到四边形尺寸的 RT, 效果处理后合成。上限 2048 约束成本。
        const iw = Math.max(1, Math.min(2048, Math.round(Math.abs(dw)) || 1));
        const ih = Math.max(1, Math.min(2048, Math.round(Math.abs(dh)) || 1));
        let img = { width: iw, height: ih, rgba: new Uint8Array(iw * ih * 4) };
        for (let i = 0; i < iw * ih; i++) {
          img.rgba[i * 4] = Math.round(col[0] * 255);
          img.rgba[i * 4 + 1] = Math.round(col[1] * 255);
          img.rgba[i * 4 + 2] = Math.round(col[2] * 255);
          img.rgba[i * 4 + 3] = 255;
        }
        // 效果链: status 只对 instanced 纯色层索取 — 需要知道有没有效果真正塑形 (见下)
        const fxStatus = model.instanced === true ? { produced: false } : null;
        if (o.effects && o.effects.length) {
          img = this.applyEffects(o, img, t, fxStatus);
        }
        // instanced 纯色层 (dock 图标位: solid_instance_model_*.json) 的画面**全部**来自
        // 效果链 (custom_user_texture 用用户贴图把纯色四边形"塑形")。整条链一个效果都没
        // 真正产出内容时 (本例 custom_user_texture 绑定用户属性 appdockapplyusertextureN
        // = false 被跳过, 剩下的 user_texture_alpha_overwrite_workaround 是恒等变换),
        // 该层没有任何合法内容 — 直接返回, 否则 blit 出去的就是实测 57×57 的不透明纯白
        // 方块 (与上方 audio bar 同一条防护: 避免白色占位块覆盖画面)。
        // 非 instanced 的作者纯色层 (models/util/solidlayer.json 等) 不受影响。
        if (model.instanced === true && !(fxStatus && fxStatus.produced)) return;
        if (img && tr.angle !== 0) {
          // 旋转 (lwe CImage.cpp:1101-1105: quad 绕中心旋转 -angle; 90° 时 blitRotated 等价)
          this.canvas.blitRotated(img, dx + dw / 2, dy + dh / 2, dw, dh, tr.angle, alpha * brightness);
        } else if (img) {
          // colorBlendMode: 官方 ApplyBlending(mode, 画布, 对象色, alpha) (solidlayer 同样支持)
          const cbm = getVal(o, 'colorBlendMode', 0);
          this.canvas.blitScaled(img, dx, dy, dw, dh, alpha * brightness, cbm > 0 ? cbm : 0);
        }
      }
    
    
,
    _renderPassthroughLayer(o, model, pass, t) {
        const W = this.W, H = this.H;
        // 后处理层 (fullscreenlayer: fullscreen=true, 无 origin/size) → 全屏后处理:
        // 读全帧缓冲 → 效果链 → 全屏 blit。不能按对象定位 (origin 默认 0 → dx=-W/2
        // 偏移 → 全壁纸画面错位/"裁切")。
        if (model.fullscreen) {
          // 修复: 借池缓冲做整帧拷贝 (原 new Uint8Array(canvas.data) 每层每帧
          // 33MB@4K 绕过 scratch 池); 保持 'out' 由下一帧 render 开头的
          // scratchRecallAll 召回 — 这里不 scratchPut: 链尾可能就是本缓冲,
          // 提前归还会被 _rtTex 之后的层借走覆写
          const frame = scratchGet(SCRATCH_U8, W * H * 4);
          frame.set(this.canvas.data);
          const tex = { width: W, height: H, rgba: frame };
          let img = tex;
          if (o.effects && o.effects.length) img = this.applyEffects(o, tex, t);
          if (!img) return;
          this.canvas.blit(img, 0, 0, getVal(o, 'alpha', 1));
          return;
        }
        // 组合层 (composelayer) → 按对象 origin/size 渲染到局部区域
        // (官方: 读 _rt_FullFrameBuffer + 效果链 → 层区域 blit)
        const tr = this.resolveTransform(o);
        let size = parseVec2(getVal(o, 'size'), [0, 0]);
        if (size[0] === 0 || size[1] === 0) size = [W, H];
        const ortho = this.scene.general && this.scene.general.orthogonalprojection;
        const ps = ortho && ortho.width ? [W / ortho.width, H / (ortho.height || 1080)] : null;
        const vs = this._viewShift(o, size, ps);
        const ox = (ps ? tr.origin[0] * ps[0] : tr.origin[0]) + vs[0];
        const sc = tr.scale;
        const dw = size[0] * sc[0] * (ps ? ps[0] : 1), dh = size[1] * sc[1] * (ps ? ps[1] : 1);
        let dx = ox - dw / 2, dy = H - (ps ? tr.origin[1] * ps[1] : tr.origin[1]) - dh / 2 + vs[1];
        // 效果链输入 = 当前全屏帧缓冲 (官方 _rt_FullFrameBuffer, 效果 UV 全屏语义)
        // 修复: 同 fullscreen 分支 — 整帧拷贝借 scratch 池, 由下一帧召回
        const frame = scratchGet(SCRATCH_U8, W * H * 4);
        frame.set(this.canvas.data);
        const tex = { width: W, height: H, rgba: frame };
        let img = tex;
        if (o.effects && o.effects.length) {
          // 组合层上的 blur 效果官方不生效 (blur 需 FBO 链, 组合层上退化输出原画布;
          // 用户实测官方 Mutsumi 无模糊) → 跳过 blur, 其他效果保留
          const effs = (o.effects || []).filter((ef) => {
            const n = ef && ef.file ? path.basename(path.dirname(ef.file)) : '';
            return n !== 'blur';
          });
          if (effs.length) {
            const saved = o.effects;
            o.effects = effs;
            try { img = this.applyEffects(o, tex, t); } finally { o.effects = saved; }
          }
        }
        if (!img) return;
        // 只把对象区域从效果结果中裁剪 → blit 回画布 (局部应用; 不能把全屏结果
        // blitScaled 缩放到局部 — 那会把整屏内容压缩到该区域, 视觉像"裁下中部放大")
        const cx = Math.max(0, Math.floor(dx)), cy = Math.max(0, Math.floor(dy));
        const cx1 = Math.min(W, Math.ceil(dx + dw)), cy1 = Math.min(H, Math.ceil(dy + dh));
        const cw = cx1 - cx, ch = cy1 - cy;
        if (cw <= 0 || ch <= 0) return;
        const alpha = getVal(o, 'alpha', 1);
        const rsrc = img.rgba;
        const region = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) {
          const si = ((cy + y) * W + cx) * 4;
          region.set(rsrc.subarray(si, si + cw * 4), y * cw * 4);
        }
        this.canvas.blit({ width: cw, height: ch, rgba: region }, cx, cy, alpha);
      }
    
      // swayimage (beach/palms): swayMask 纹理正弦位移采样 (引擎 swayimage.frag)
,
    _swayImage(tex, swayMask, uniforms, t) {
        if (!swayMask) return tex;
        const w = tex.width, h = tex.height;
        const src = tex.rgba;
        const out = new Uint8Array(src.length);
        const speed = uniforms.Speed != null ? uniforms.Speed : 1;
        const amp = uniforms.Amount != null ? uniforms.Amount : 1;
        const bright = uniforms.Bright != null ? uniforms.Bright : 1;
        const t30 = t * 30 * speed, t27 = t * 27 * speed, t21 = t * 21 * speed, t7 = t * 7 * speed;
        // 步进 2 (性能): 摆动是低频, 1/2 分辨率计算后平滑
        const step = 2;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w, v = (y + 0.5) / h;
            const sm = this._texSample(swayMask, u, v);
            const phase = u * 10 + sm[2]; // swayMask.b
            const amt = Math.sin(t30 + phase) + Math.sin(t27 + phase) + Math.sin(t21 + phase) + Math.sin(t7 + phase);
            const offU = sm[0] * amt * amp * 0.01;
            const offV = sm[1] * amt * amp * 0.01;
            const s = this._texSample(tex, u + offU, v + offV);
            const di = (y * w + x) * 4;
            out[di] = Math.min(255, Math.round(s[0] * 255 * bright));
            out[di + 1] = Math.min(255, Math.round(s[1] * 255 * bright));
            out[di + 2] = Math.min(255, Math.round(s[2] * 255 * bright));
            out[di + 3] = Math.round(s[3] * 255);
          }
        }
        return { width: w, height: h, rgba: out };
      }
    
      // flag 旗帜: 法线贴图双采样扰动 + cloth + TINT + 光照 (引擎 flag.frag)
,
    _flagImage(tex, nTex, clothTex, uniforms, pass, t) {
        if (!nTex) return tex;
        const w = tex.width, h = tex.height;
        const src = tex.rgba;
        const out = new Uint8Array(src.length);
        const waveSpeed = uniforms.Speed != null ? uniforms.Speed : 0.4;
        const waveStrength = uniforms.Strength != null ? uniforms.Strength : 0.5;
        const combos = (pass && pass.combos) || {};
        const tint = !!(combos.TINT || combos.tint);
        const c1 = parseVec3(uniforms.color1, [0, 0, 0]);
        const c2 = parseVec3(uniforms.color2, [0, 0, 0]);
        const c3 = parseVec3(uniforms.color3, [1, 1, 1]);
        // ── 官方 DecompressNormal (assets/shaders/common_fragment.h:19-32) ──
        //   DXT5/DXT3/ETC1/ETC2/DXT1/BC7 : x = G*2-1, y = A*2-0.965
        //   RG88                         : x = R*2-1, y = G*2-1
        //   其它 (RGBA8888 等)            : x = A*2-1, y = G*2-1
        //   统一 z = sqrt(saturate(1 - x² - y²))
        // 旧实现用 (R,G,B)*2-1 且把第三通道当 z —— 三个通道全错。实测 flag_normal.tex
        // 是 DXT5 (format=4) 且 R≡255、B≡0 ⇒ 旧实现 x≡+1、z≡-1，n.x 的可用变化幅度
        // 只有官方的 1/147 (1.78e-3 vs 0.2618)，旗帜的褶皱/明暗几乎不动。
        const mkDecompress = (mode) => (s) => {
          let x, y;
          if (mode === 'dxt') { x = s[1] * 2 - 1; y = s[3] * 2 - 0.965; }
          else if (mode === 'rg88') { x = s[0] * 2 - 1; y = s[1] * 2 - 1; }
          else { x = s[3] * 2 - 1; y = s[1] * 2 - 1; }
          const zz = 1 - x * x - y * y;
          return [x, y, Math.sqrt(zz > 0 ? zz : 0)];
        };
        // 分支选择: 有纹理 format 就用它; 否则用**法线有效性**判据在两个候选里挑
        // (选错分支会出现大量 x²+y²>1 的非法法线, 官方 z 公式会 saturate 掉它们)。
        let mode;
        const fmt = nTex && nTex.format;
        if (fmt != null) {
          mode = (fmt >= 3 && fmt <= 7) || fmt === 12 ? 'dxt' : (fmt === 8 ? 'rg88' : 'rgba');
        } else {
          const total = nTex.width * nTex.height;
          const step = Math.max(1, Math.floor(total / 4096));
          const bad = { dxt: 0, rgba: 0 };
          let n = 0;
          for (let i = 0; i < total; i += step) {
            const o = i * 4;
            const s = [nTex.rgba[o] / 255, nTex.rgba[o + 1] / 255, nTex.rgba[o + 2] / 255, nTex.rgba[o + 3] / 255];
            for (const m of ['dxt', 'rgba']) {
              const [x, y] = mkDecompress(m)(s);
              if (x * x + y * y > 1) bad[m]++;
            }
            n++;
          }
          mode = bad.dxt <= bad.rgba ? 'dxt' : 'rgba';
        }
        const decompress = mkDecompress(mode);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w, v = (y + 0.5) / h;
            // v_NormalCoord (vert): xy = uv*(1,0.3)*0.7, x -= t*speed; zw = uv*(1,0.7)*0.3, z -= t*speed*0.5
            let n1x = u * 0.7 - t * waveSpeed;
            let n1y = v * 0.3 * 0.7;
            let n2x = u * 0.3 - t * waveSpeed * 0.5;
            let n2y = v * 0.7 * 0.3;
            // frag 修正
            n1x -= ((0.5 - u) * (1 - v)) * 3;
            n1x += 2 * Math.pow(v - 0.1, 3) * Math.pow(u, 2);
            n2x -= ((1 - u) * (1 - v)) * 2;
            const nm1 = decompress(this._texSample(nTex, n1x, n1y));
            const nm2 = decompress(this._texSample(nTex, n2x, n2y));
            let n = [nm1[0] * nm2[0], nm1[1] * nm2[1], nm1[2] * nm2[2]];
            // mix((0,0,1), n, strength)
            n = [n[0] * waveStrength, n[1] * waveStrength, 1 + (n[2] - 1) * waveStrength];
            const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
            n = [n[0] / nl, n[1] / nl, n[2] / nl];
            const bu = u + n[0] * 0.02, bv = v + n[1] * 0.02;
            const albedo = this._texSample(tex, bu, bv);
            const cloth = clothTex ? this._texSample(clothTex, bu * 4, bv * 4)[0] : 1;
            let color;
            if (tint) {
              let col = [
                c1[0] + (c2[0] - c1[0]) * albedo[0],
                c1[1] + (c2[1] - c1[1]) * albedo[0],
                c1[2] + (c2[2] - c1[2]) * albedo[0],
              ];
              col = [
                col[0] + (c3[0] - col[0]) * albedo[1],
                col[1] + (c3[1] - col[1]) * albedo[1],
                col[2] + (c3[2] - col[2]) * albedo[1],
              ];
              col = [col[0] * albedo[2] * cloth, col[1] * albedo[2] * cloth, col[2] * albedo[2] * cloth];
              col = [col[0] + cloth * 0.1, col[1] + cloth * 0.1, col[2] + cloth * 0.1];
              color = col;
            } else {
              color = [albedo[0], albedo[1], albedo[2]];
            }
            // light = 0.2 + dot((0.707,0.707,0), n)*0.5+0.5; +pow(light,5)*0.5
            let light = 0.2 + (0.707 * n[0] + 0.707 * n[1]) * 0.5 + 0.5;
            light += Math.pow(light, 5) * 0.5;
            const lightMul = light + light * Math.max(0, Math.min(1, cloth * 2 - 1));
            const di = (y * w + x) * 4;
            out[di] = Math.min(255, Math.round(color[0] * lightMul * 255));
            out[di + 1] = Math.min(255, Math.round(color[1] * lightMul * 255));
            out[di + 2] = Math.min(255, Math.round(color[2] * lightMul * 255));
            out[di + 3] = 255;
          }
        }
        return { width: w, height: h, rgba: out };
      }
    
      // retro (retro): HSV 色调映射 + grunge + DOTS 霓虹 (引擎 retro.frag)
      // 逐行对照官方 retro/{vert,frag} (行号为官方文件):
      //   vert:17      v_TexCoord = a_TexCoord * 0.997
      //   vert:19-20   v_TexCoordGrunge = gl_Position.xy/w * 0.75 * vec2(texelRatio,1)
      //   vert:22-23   v_BaseColor = rgb2hsv(g_Tint)
      //   vert:25-27   #if DOTS: v_TexCoord.x *= 2      ← 在 0.997 **之后**、取色**之前**
      //   frag:14-18   baseUV = v_TexCoord (#if DOTS: baseUV.x -= g_Time*0.02)
      //   frag:20-21   col = tex0(baseUV); grunge = tex1(v_TexCoordGrunge).a
      //   frag:25-30   hsv = v_BaseColor; hsv.x += col.g*0.11; hsv.z *= col.b;
      //                albedo.rgb = hsv2rgb(hsv); albedo.rgb -= saturate(grunge-albedo.rgb)
      //   frag:32-38   #if DOTS: stepOffset = ceil(v_TexCoord.y*4)*0.24;
      //                a *= step(v_TexCoord.x, 1.1+stepOffset);
      //                a *= smoothstep(ks-0.15, ks, col.r), ks = smoothstep(0.1,1,v_TexCoord.x-stepOffset)*1.1
      //   frag:40      gl_FragColor = albedo
      // 旧实现两处不符 (见 .test-cache/fix-retro-deepspace.md):
      //   (1) texelRatio 用了 grungeTex.height/width (=1), 官方是 g_TexelSize.y/g_TexelSize.x
      //       = **画布** W/H (lwe CPass.cpp:883);
      //   (2) DOTS 分支漏了 vert:26 的 `v_TexCoord.x *= 2`, 且把 *0.997 放在了
      //       `- g_Time*0.02` 之后 ⇒ 采样与 alpha 掩码的 x 全错 (oracle 实测
      //       max|Δalpha| = 1.0, 99.9% 像素不符)。
,
    _retroImage(tex, grungeTex, uniforms, pass, t, W, H) {
        const w = tex.width, h = tex.height;
        const out = new Uint8Array(tex.rgba.length);
        const combos = (pass && pass.combos) || {};
        const dots = !!(combos.DOTS || combos.dots);
        // tint (usershadervalues accentcolor → tint; 未给出时用 retro.vert:6 声明默认)
        const tint = parseVec3(uniforms.tint, [0.95, 0.05, 0.1]);
        const baseHSV = rgb2hsv(tint);
        // g_TexelSize = vec2(1/sceneWidth, 1/sceneHeight) (linux-wallpaperengine CPass.cpp:883)
        const texelRatio = W / H;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const aU = (x + 0.5) / w, aV = (y + 0.5) / h;   // a_TexCoord
            // vert:17 + vert:25-27
            let tcU = aU * 0.997, tcV = aV * 0.997;
            if (dots) tcU *= 2;
            // frag:14-18
            const baseU = dots ? tcU - t * 0.02 : tcU;
            const col = this._texSample(tex, baseU, tcV);
            // v_TexCoordGrunge: 官方是**屏幕 clip 空间** (vert:19-20)。本函数是纹理级
            // 预处理, 拿不到 quad 的屏幕位置, 故按 quad 局部 NDC 近似 —— 量化:
            // grunge.a 均值 0.02、95% 像素为 0 ⇒ 全帧影响 < 0.2/255 (见报告未决点)。
            const gu = ((aU - 0.5) * 2) * 0.75 * texelRatio;
            const gv = ((aV - 0.5) * 2) * 0.75;
            const grunge = grungeTex ? this._texSample(grungeTex, gu, gv)[3] : 0;
            // HSV 色调 (frag:25-28)
            const hsv = [baseHSV[0] + col[1] * 0.11, baseHSV[1], baseHSV[2] * col[2]];
            const rgb = hsv2rgb(hsv);
            // albedo.rgb -= saturate(grunge - albedo.rgb) (frag:30)
            for (let c = 0; c < 3; c++) {
              const g2 = Math.max(0, Math.min(1, grunge - rgb[c]));
              rgb[c] = Math.max(0, rgb[c] - g2);
            }
            let a = col[3];
            if (dots) {                                     // frag:32-38
              const stepOffset = Math.ceil(tcV * 4) * 0.24;
              a *= (tcU <= 1.1 + stepOffset ? 1 : 0);
              const kernelSize = smoothstepFn(0.1, 1.0, tcU - stepOffset) * 1.1;
              a *= smoothstepFn(kernelSize - 0.15, kernelSize, col[0]);
            }
            const di = (y * w + x) * 4;
            out[di] = Math.min(255, Math.round(rgb[0] * 255));
            out[di + 1] = Math.min(255, Math.round(rgb[1] * 255));
            out[di + 2] = Math.min(255, Math.round(rgb[2] * 255));
            out[di + 3] = Math.round(a * 255);
          }
        }
        return { width: w, height: h, rgba: out };
      }
    
      // ── Text 对象渲染: CFF 字体解析 + 位图光栅化 → 画布 blit ───────
  });
  Object.defineProperty(proto, '_customShaders', {
    get() {
          return new Set(['core', 'backgroundsphere', 'dna', 'bg', 'curve', 'neonsun', 'neongrid', 'cloudsbg', 'flowimage']);
    },
    configurable: true,
  });
}
