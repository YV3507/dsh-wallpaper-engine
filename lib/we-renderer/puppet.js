// WE 渲染引擎 — puppet (从 core.js 拆分, 逻辑不变)
import { getVal, v3sub, v3cross, v3dot, v3norm } from './math.js';

// 在 MDLA 数据区后扫描下一个"有效动画头"。
// 动画段之间可能有附加数据 (绑定姿态矩阵表等, 如 Plana 动画[0] 后 451B 绑定矩阵,
// 3486806915 动画[0] 后 51B), 不能依赖 segBytes×boneCount 精确跳过。
// 头结构: [u32 id][u32 0]["名字\0"]["loop\0"][f32 fps][u32 帧数][u32 0][u32 骨骼数][u32 0][u32 段字节]
// 强签名: segBytes == 36×(帧数+1) (每帧每骨骼 36B + 每骨绑定 36B) — 4 个动画 (Plana/3486806915) 全部吻合
function findNextAnimationHeader(buf, dv, from, to) {
  const LOOP_MODES = new Set(['loop', 'single', 'mirror', 'step', 'startpaused', '']);
  for (let q = from; q + 45 < to; q++) {
    if (dv.getUint32(q + 4, true) !== 0) continue; // u32 0
    const nameEnd = buf.indexOf(0, q + 8);
    if (nameEnd < 0 || nameEnd - (q + 8) < 1 || nameEnd - (q + 8) > 64) continue;
    let nameOk = true;
    for (let i = q + 8; i < nameEnd; i++) {
      const c = buf[i];
      if (c > 0 && c < 0x20) { nameOk = false; break; } // 控制字符
    }
    if (!nameOk) continue;
    const loopEnd = buf.indexOf(0, nameEnd + 1);
    if (loopEnd < 0 || loopEnd - (nameEnd + 1) > 16) continue;
    if (!LOOP_MODES.has(buf.toString('utf8', nameEnd + 1, loopEnd))) continue;
    const fps = dv.getFloat32(loopEnd + 1, true);
    if (!(fps >= 0.5 && fps <= 240)) continue;
    const frameCount = dv.getUint32(loopEnd + 5, true);
    if (frameCount === 0 || frameCount > 100000) continue;
    if (dv.getUint32(loopEnd + 9, true) !== 0) continue;
    const boneCount = dv.getUint32(loopEnd + 13, true);
    if (boneCount === 0 || boneCount > 512) continue;
    if (dv.getUint32(loopEnd + 17, true) !== 0) continue;
    const segBytes = dv.getUint32(loopEnd + 21, true);
    if (segBytes === 0 || segBytes > 200000) continue;
    // 官方逐骨块 = (frameCount+1) 帧 × ≤9 float (36B 满通道; flags 稀疏时更小)。
    // 旧判据 segBytes == 36×(帧数+1) 只覆盖"满通道"模型 → 稀疏块模型被误弃。
    if (segBytes % 4 !== 0 || segBytes > 36 * (frameCount + 1)) continue;
    const dataStart = loopEnd + 25;
    if (dataStart + 8 + segBytes > to) continue;
    return q;
  }
  return -1;
}

// ── 动画层可见性 (官方语义) ────────────────────────────────────────────────
// animationlayers[].visible 有三种形态: true/false、{value: bool}、以及
// **脚本/动画驱动** — 官方场景脚本 (NSL) 返回布尔, 例如皓风琦【羽】:
//   {"additive":true,"animation":888,"blend":0.8,"rate":0.8,"blendtime":0.5,
//    "visible":{"script":"'use strict'; ..."}}
// 旧实现只认 true / {value:true} → 脚本驱动的层被**整层丢弃** (该壁纸 N 7 层、
// 十字架 3 层、nv 8 层全部如此) → 只渲染基础层, 多层 additive 效果缺失。
// 现语义: 显式 boolean / `{value:bool}` 照办; 脚本/动画驱动在无脚本求值结果时
// **默认可见** (宁可叠加官方层, 也不整层丢失; 显式 false 仍隐藏)。
export function isLayerVisible(l) {
  const v = l && l.visible;
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if (typeof v.value === 'boolean') return v.value;
    return true; // {script} / {animation} 驱动 → 默认可见
  }
  return true;
}

// ── puppet mixin (从 core.js 拆分, 逻辑零改动) ──
export function installPuppet(proto) {
  Object.assign(proto, {
    renderPuppet(o, model, tr, t) {
        const mdlRaw = this.pkg.read(model.puppet);
        if (!mdlRaw) { this.log('跳过 puppet ' + (o.name || o.id) + ': 无 MDL'); return; }
        // MDL 解析缓存: 多帧渲染避免每帧重新解析 (骨骼/动画段引用原 buffer)
        if (!this._mdlCache) this._mdlCache = new Map();
        let mesh = this._mdlCache.get(model.puppet);
        if (!mesh) {
          mesh = this._parseMdl(mdlRaw);
          if (!mesh) { this.log('跳过 puppet ' + (o.name || o.id) + ': MDL 解析失败'); return; }
          this._mdlCache.set(model.puppet, mesh);
        }
        const tex = this.loadModelTexture(o.image);
        if (!tex) { this.log('跳过 puppet ' + (o.name || o.id) + ': 无纹理'); return; }
        // 骨骼蒙皮 (动画) 或绑定姿态 — 不用 cropoffset: 官方引擎忽略 cropoffset
        // (wallpaper64.exe 无该字符串), MDL raw bbox 对称 (中心=原点)
        // animationlayers 动画选择: 官方按动画层 (visible=true 层) 选动画, 且全部 visible 层
        // 参与合成: 普通层 final=mix(final, anim, blend), additive 层 final+=(anim−bind)×blend。
        // (旧实现只取第一个 visible 层 → 多 visible 层壁纸缺层错位: 眼(眨眼+高光运动)、
        //  上半身(呼吸1+呼吸2)/嘴巴/眼睛、N(7层)/十字架(3层)/nv(8层))
        // 层名匹配 MDLA 动画名; 名字匹配失败 (部分模型 MDLA 名字解析空) 时
        // fallback 按层在 animationlayers 中的索引 → 对应 MDL 动画索引
        let animLayers = null;
        if (mesh.animations && mesh.animations.length > 1 && o.animationlayers && o.animationlayers.length) {
          const layers = o.animationlayers
            .filter(isLayerVisible)
            .map((l) => {
              const blend = typeof l.blend === 'number' && l.blend >= 0 && l.blend <= 1 ? l.blend : 1;
              const rate = typeof l.rate === 'number' && l.rate > 0 ? l.rate : 1;
              let idx = mesh.animations.findIndex((a) => a.name && l.name && a.name === l.name);
              if (idx < 0 && l.name) {
                // 数字后缀: "动画 N" → MDL 第 N 个动画 (层名带编号、动画本身无名时,
                // 名字不匹配按索引回退会选错动画 → 角色蒙皮飞走)
                const m = String(l.name).match(/(\d+)/);
                if (m) {
                  const n = parseInt(m[1], 10);
                  if (n >= 1 && n <= mesh.animations.length) idx = n - 1;
                }
              }
              // 层 animation 字段 = MDLA 动画 ID (如 4327) → 直接按 id 匹配
              if (idx < 0 && l.animation != null) {
                const lid = Number(l.animation);
                const byId = mesh.animations.findIndex((a) => a.id === lid);
                if (byId >= 0) idx = byId;
              }
              if (idx < 0) {
                const layerIdx = o.animationlayers.indexOf(l);
                if (layerIdx >= 0 && layerIdx < mesh.animations.length) idx = layerIdx;
              }
              if (idx < 0) idx = 0;
              return { animIdx: idx, blend, rate, additive: !!l.additive };
            });
          if (layers.length) animLayers = layers;
        }
        let skinned = mesh.positions;
        if (mesh.bones && mesh.bones.length && mesh.animations && mesh.animations.length) {
          skinned = this._skinPuppet(mesh, t, 0, 0, animLayers);
        } else {
          skinned = mesh.positions;
        }
        const rawBounds = this._meshBounds(skinned);
        const W = Math.ceil(rawBounds.maxX - rawBounds.minX) + 1;
        const H = Math.ceil(rawBounds.maxY - rawBounds.minY) + 1;
        const flipY = (y) => rawBounds.maxY - y;
        const img = this._rasterizeMesh(mesh, tex, skinned, rawBounds, W, H, flipY);
        // 定位: puppet 网格顶点是相对对象中心的局部坐标 (lwe CImage.cpp:536 size/2+raw)。
        // 保持原实现 (origin + rawBounds, 用户实测 scale=1 正确), 仅修复 scale≠1
        // 的定位偏移 (sf39d): 官方模型矩阵 scale 同时缩放位置, 网格左/上边界应乘
        // scale — 旧实现 dx = origin + minX 未乘 scale → scale≠1 时整体偏移。
        const orthoP = this.scene.general && this.scene.general.orthogonalprojection;
        const ps = orthoP && orthoP.width ? [this.W / orthoP.width, this.H / (orthoP.height || 1080)] : null;
        const psx = ps ? ps[0] : 1, psy = ps ? ps[1] : 1;
        const vs = this._viewShift(o, [W, H], ps);
        // ── 声明 size 归一化 (默认关闭, 便于 A/B: 设 DSH_WE_PUPPET_SIZE=1 开启) ──
        // 证据 (离线, scripts/tmp-size-semantics2.mjs):
        //  · 网格顶点处于**纹理像素空间** — 铁证: Mutsumi 嘴巴 size=134x113 与
        //    "UV 跨度×网格 bbox 反推的纹理" 134x113 **精确相等**;
        //  · 多数 puppet 的网格 bbox ≠ 声明 size 且**逐轴比例不同** (皓风琦 N: bbox
        //    1833x1941 vs size 3334x2501 → 非均匀 1.76x/1.28x = 1.41x 单方向拉伸;
        //    nv 1.73x/1.70x; 十字架 1.08x/1.02x ≈ 无差异)。实测症状"单方向拉伸、
        //    无均匀等比例变换"与此一致 → 官方按 size 逐轴铺满, 我方按 bbox 原样绘制。
        //  · 用**稳健范围**(2%~98% 分位) 而非 min/max, 避免离群顶点把比例算歪
        //    (如 08眼组 bbox 被撑大 → 原样绘制反而是对的)。
        const sizeNorm = (() => {
          // ⚠️ 默认关闭 (回退): 实测"按 size 铺满"使大部分壁纸整体放大、组件与背景出屏,
          // 且皓风琦的单方向拉伸并未消失 ⇒ 官方对 autosize/size 的用法不是"拉伸模型到 size"。
          // 保留为实验开关, 待逆向官方读取 autosize/size/cropoffset 的真实语义后再定实现。
          const force = process.env.DSH_WE_PUPPET_SIZE;
          if (force !== '1') return null;
          const rawSz = getVal(o, 'size', null);
          const sz = typeof rawSz === 'string' ? rawSz.trim().split(/\s+/).map(Number)
            : (Array.isArray(rawSz) ? rawSz.map(Number) : null);
          if (!sz || !(sz[0] > 0) || !(sz[1] > 0)) return null;
          const ext = this._robustExtent(mesh.positions);
          if (!ext) return null;
          // 铺满的是**纹理内容**而非网格 bbox → 乘 UV 跨度。铁证 (纯离线):
          //   Mutsumi 嘴巴 (size 134x113 / 网格 49x31) × UV 跨度 (0.366, 0.274) = (1.00, 1.00)
          //   ⇒ 本就正确, 因子恒 1; 而皓风琦 N (UV≈满幅) 仍得 (1.76, 1.28) 修正单方向拉伸。
          let uvw = 1, uvh = 1;
          if (mesh.uvs && mesh.uvs.length) {
            let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
            for (const uv of mesh.uvs) { if (!uv) continue; a = Math.min(a, uv[0]); b = Math.max(b, uv[0]); c = Math.min(c, uv[1]); d = Math.max(d, uv[1]); }
            if (isFinite(a) && isFinite(b) && b > a) uvw = b - a;
            if (isFinite(c) && isFinite(d) && d > c) uvh = d - c;
          }
          const clamp = (v) => Math.max(0.2, Math.min(5, v));
          return { sx: clamp((sz[0] / ext.w) * uvw), sy: clamp((sz[1] / ext.h) * uvh), bcx: ext.cx, bcy: ext.cy };
        })();
        const sxN = sizeNorm ? sizeNorm.sx : 1, syN = sizeNorm ? sizeNorm.sy : 1;
        const dw = W * psx * tr.scale[0] * sxN, dh = H * psy * tr.scale[1] * syN;
        // 归一化时以**稳健网格中心**为四边形中心 (官方 CImage 以 origin 为中心);
        // 关闭时与原实现逐位一致。
        const offX = sizeNorm ? (rawBounds.minX - sizeNorm.bcx) : rawBounds.minX;
        const offY = sizeNorm ? (rawBounds.maxY - sizeNorm.bcy) : rawBounds.maxY;
        const leftX = tr.origin[0] + tr.scale[0] * sxN * offX;
        const topY = tr.origin[1] + tr.scale[1] * syN * offY;
        const dx = leftX * psx + vs[0];
        const dy = this.H - topY * psy + vs[1];
        // brightness: 官方 CImage 有 brightness (lwe CImage.cpp:952), puppet 是
        // image 子类 — 缺 brightness 导致暗色/过曝 puppet 组件颜色不对 (sf39f)
        const alpha = getVal(o, 'alpha', 1) * getVal(o, 'brightness', 1);
        // 官方语义 (第一手证据: we-shaders/base/model_vertex_v1.h:147-153 蒙皮后
        // worldPosition = mul(vec4(position,1), g_ModelMatrix); passthroughblend.vert:19-32):
        //   world = origin + R·S·蒙皮顶点  →  R 绕**对象原点**旋转, 而不是绕网格包围盒中心。
        // 旧实现完全忽略 tr.angle (含祖先累积 Z 角) → 带旋转的 puppet 组件姿态错误。
        // canvas = world×ps (+ viewShift): 支点 = origin 的 canvas 位置; 旋转方向沿用
        // blitRotated 的 Y-flip 约定 (与 image.js:165-168 同一套)。
        if (tr.angle) {
          const pivotX = tr.origin[0] * psx + vs[0];
          const pivotY = this.H - tr.origin[1] * psy + vs[1];
          this.canvas.blitRotated(img, dx + dw / 2, dy + dh / 2, dw, dh, tr.angle, alpha, pivotX, pivotY);
        } else {
          this.canvas.blitScaled(img, dx, dy, dw, dh, alpha);
        }
      }
    
      // 骨骼蒙皮: 时间 → 动画帧 → 骨骼世界矩阵 → 顶点 × Σ w × (finalWorld × bindWorld⁻¹)
      // 引擎 model_vertex_v1.h ApplySkinningPosition: pos' = Σ w·(pos × g_Bones[bi])
      // 动画层合成 (官方 animationlayers 语义, 全部 visible 层参与):
      //   普通层: final = mix(final, layerWorld, blend)   (blend=1 → 替换)
      //   additive层: final += (layerWorld − refWorld) × blend, refWorld = 动画帧0世界 = bind 世界
      //   (已验证: 动画帧0 局部姿势链乘后 = bind 世界姿势)
      // 世界空间合成 (非局部空间 lerp): 多 additive 层各层 delta 在各自骨骼上叠加,
      // 丢失任何一层即组件错位 (眼/上半身/嘴/呼吸层等)
,
    // 稳健网格范围 (2%~98% 分位): 与 min/max 相比不受离群顶点影响,
    // 供"声明 size 归一化"计算逐轴比例与四边形中心。
    _robustExtent(positions, frac = 0.02) {
        if (!positions || !positions.length) return null;
        const xs = [], ys = [];
        for (const p of positions) { xs.push(p[0]); ys.push(p[1]); }
        xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
        const lo = Math.floor(xs.length * frac);
        const hi = Math.max(lo, Math.min(xs.length - 1, Math.ceil(xs.length * (1 - frac)) - 1));
        const minX = xs[lo], maxX = xs[hi], minY = ys[lo], maxY = ys[hi];
        return {
          w: Math.max(1e-6, maxX - minX),
          h: Math.max(1e-6, maxY - minY),
          cx: (minX + maxX) / 2,
          cy: (minY + maxY) / 2,
        };
      }
    
,
    _skinPuppet(mesh, t, cxs, cys, layers = null) {
        const bones = mesh.bones;
        if (!layers || !layers.length) layers = [{ animIdx: 0, blend: 1, rate: 1, additive: false }];
        const anim0 = mesh.animations[layers[0].animIdx] || mesh.animations[0];
        if (!anim0) return mesh.positions.map((p) => [p[0] + cxs, p[1] + cys, p[2]]);
        const nb = bones.length;
        // 蒙皮数据兼容性: 权重须 0..1 且索引 < 骨骼数 (部分 MDL 顶点布局不同, 蒙皮数据不可靠
        // → 回退绑定姿态, 避免垃圾权重把顶点炸飞)
        let skinOK = true;
        for (let i = 0; i < mesh.positions.length; i++) {
          for (let k = 0; k < 4; k++) {
            const w = mesh.blendWeights[i][k];
            const bi = mesh.blendIndices[i][k];
            if (w < -0.001 || w > 1.001 || !isFinite(w) || bi >= nb) { skinOK = false; break; }
          }
          if (!skinOK) break;
        }
        if (!skinOK) return mesh.positions.map((p) => [p[0] + cxs, p[1] + cys, p[2]]);
        // 绑定世界矩阵 (MDLS 层级累积, 行主序) + 逆
        const bindWorld = new Array(nb);
        const bindInv = new Array(nb);
        for (let b = 0; b < nb; b++) {
          const parent = bones[b].parent;
          const local = bones[b].bind; // 行主序 4x4 (平移在行3)
          // 行向量语义 (平移在行 3, 顶点变换 p·M): 顶点先变到父空间, 再乘父世界矩阵
          // ⇒ M_world = M_local · M_world_parent。旧写法 _matMulRow(world_parent, local)
          // 得到 M_parent·M_local (相反顺序): 旋转非 0 的骨骼世界位姿全错 ⇒ t=0 蒙皮
          // 无法复现 bind (实测皓风琦 N 偏 18%/nv 56%, 全零旋转的 Mutsumi 嘴/眉精确 0)。
          bindWorld[b] = parent >= 0 && parent < nb && bindWorld[parent] ? this._matMulRow(local, bindWorld[parent]) : local;
        }
        for (let b = 0; b < nb; b++) bindInv[b] = this._matInvertRow(bindWorld[b]);
        // bind 世界 {angle, tx, ty} (additive 参考姿势 = 动画帧0世界 = bind 世界)
        const bindRT = new Array(nb);
        for (let b = 0; b < nb; b++) {
          const m = bindWorld[b];
          bindRT[b] = { angle: Math.atan2(m[1], m[0]), tx: m[12], ty: m[13], sx: 1, sy: 1 };
        }
        // final 世界 = bind, 逐层合成
        const final = bindRT.map((r) => ({ angle: r.angle, tx: r.tx, ty: r.ty, sx: 1, sy: 1 }));
        // 帧率: 官方 frame = t × 动画fps (MDLA fps 字段, 30/60 均有; 旧硬编码 30 让
        // 60fps 动画 (Plana 等) 半速播放 — 用每动画自身 fps)
        // additive 参考姿势缓存: 每动画帧0 世界 (部分模型骨骼帧0≠bind 数十单位,
        // 用 bind 作 ref 会让 additive 在帧0 就有常数偏移 → 角色蒙皮飞走数百单位;
        // 正确 ref = 层动画自己的帧0, 帧0=bind 的模型等价)
        const refCache = new Map();
        const animRef = (anim) => {
          if (!refCache.has(anim)) refCache.set(anim, this._sampleAnimRT(mesh, anim, 0, nb, bones));
          return refCache.get(anim);
        };
        for (const layer of layers) {
          const anim = mesh.animations[layer.animIdx] || mesh.animations[0];
          if (!anim) continue;
          // 帧: 动画 fps 循环; 层 rate 加速播放 (高光层 rate>1, 呼吸层 rate<1)
          // **不在此处取模**: loop 模式判定移到 _sampleAnimRT (single=一次性播完保持末帧,
          // 末帧 = 帧0 = 静止姿态; 在此取模会把"一次性"当无限循环 ⇒ 静态帧停在形变中途,
          // 实测 Mutsumi 嘴巴的 additive 一次性层 (636, sy 帧75=0.213) 把嘴压成细条并偏上)。
          const fps = anim.fps > 0 ? anim.fps : 30;
          const frame = Math.floor(t * fps * layer.rate);
          const lw = this._sampleAnimRT(mesh, anim, frame, nb, bones);
          const refRT = animRef(anim);
          for (let b = 0; b < nb; b++) {
            if (layer.additive) {
              // additive: final += (layerWorld − 层帧0)×blend (ref = 层动画帧0 世界)
              // scale 按矩阵 delta 比值合成: 官方动画层混合函数 (FUN_1401f89a0/
              // 9020/9820, 见 wallpaper64.exe.asm 373071-373098/373399-373443)
              // 对**所有**层 (含 additive) 混合通道 7-9 (sx/sy/sz) — 与平移/旋转
              // 通道同一套 lerp 公式; additive 层的 scale 变化 (如眨眼 sy→0.003)
              // 必须参与合成, 否则眼睑永不闭合 (Plana 眼层 432 实测)。
              // 比值语义: final.sx *= (lw.sx/ref.sx)^blend — 帧0 ref = bind (sx=sy=1)
              // 时退化为 lw.sx^blend; blend=1 时 = lw.sx 全量。
              const ref = refRT[b];
              let da = lw[b].angle - ref.angle;
              while (da > Math.PI) da -= 2 * Math.PI;
              while (da < -Math.PI) da += 2 * Math.PI;
              final[b].angle += da * layer.blend;
              final[b].tx += (lw[b].tx - ref.tx) * layer.blend;
              final[b].ty += (lw[b].ty - ref.ty) * layer.blend;
              // 官方 additive = **加法差量**, 对**所有通道 (含 scale 7-9)** 同一套公式
              // (FUN_1401f9820: out += (layer − ref) × blend; 见 docs/WE-OFFICIAL-TRANSFORM-NOTES.md)。
              // 旧实现的 pow 比值仅在 blend=1 时等价, 而 blend≠1 (皓风琦 0.27~0.8) 会系统性
              // 扭曲组件; 且旧代码 final.sx 未初始化 → NaN → 被 `|| 1` 吞掉, 等于**完全丢弃缩放**。
              final[b].sx += ((lw[b].sx != null ? lw[b].sx : 1) - (ref.sx != null ? ref.sx : 1)) * layer.blend;
              final[b].sy += ((lw[b].sy != null ? lw[b].sy : 1) - (ref.sy != null ? ref.sy : 1)) * layer.blend;
            } else {
              // 普通层: final = mix(final, layerWorld, blend)
              let da = lw[b].angle - final[b].angle;
              while (da > Math.PI) da -= 2 * Math.PI;
              while (da < -Math.PI) da += 2 * Math.PI;
              final[b].angle += da * layer.blend;
              final[b].tx += (lw[b].tx - final[b].tx) * layer.blend;
              final[b].ty += (lw[b].ty - final[b].ty) * layer.blend;
              final[b].sx += ((lw[b].sx != null ? lw[b].sx : 1) - final[b].sx) * layer.blend;
              final[b].sy += ((lw[b].sy != null ? lw[b].sy : 1) - final[b].sy) * layer.blend;
            }
          }
        }
        // 蒙皮矩阵: g_Bones[b] = finalWorld[b] × bindInv[b]
        const gBones = new Array(nb);
        for (let b = 0; b < nb; b++) {
          const c = Math.cos(final[b].angle), s = Math.sin(final[b].angle);
          // 官方局部/世界矩阵 = **[Rz·S | T]** (行主序, 平移在行 3) — 含 scale 通道 7/8/9:
          // 缩放必须进矩阵, 否则纯缩放动画 (Plana 眨眼 sy→0.003) 与多层缩放合成 (皓风琦)
          // 全部丢失 → 组件姿态/比例错误 (实测"单方向拉伸")。旧实现只构造 [Rz | T]。
          const sx = (final[b].sx != null && isFinite(final[b].sx)) ? final[b].sx : 1;
          const sy = (final[b].sy != null && isFinite(final[b].sy)) ? final[b].sy : 1;
          const m = [c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, 1, 0, final[b].tx, final[b].ty, 0, 1];
          // 蒙皮矩阵 (行向量): v_world = v_bind · bindInv · finalWorld ⇒ bindInv · finalWorld。
          // 旧写法 _matMulRow(m, bindInv) 得到 finalWorld·bindInv (相反顺序) ⇒ 即使 final
          // == bind 也不等于恒等矩阵 → 绑定姿态本身就被扭曲 (实测 t=0 偏差与动画无关)。
          gBones[b] = this._matMulRow(bindInv[b], m);
        }
        // 顶点蒙皮
        const out = new Array(mesh.positions.length);
        for (let i = 0; i < mesh.positions.length; i++) {
          const p = mesh.positions[i];
          const bi = mesh.blendIndices[i];
          const bw = mesh.blendWeights[i];
          let x = 0, y = 0, z = 0;
          for (let k = 0; k < 4; k++) {
            const w = bw[k];
            if (w === 0) continue;
            const m = gBones[bi[k]] || gBones[0];
            // 行向量右乘: [x,y,z,1] × M
            const px = p[0] * m[0] + p[1] * m[4] + p[2] * m[8] + m[12];
            const py = p[0] * m[1] + p[1] * m[5] + p[2] * m[9] + m[13];
            const pz = p[0] * m[2] + p[1] * m[6] + p[2] * m[10] + m[14];
            x += px * w; y += py * w; z += pz * w;
          }
          out[i] = [x + cxs, y + cys, z];
        }
        return out;
      }
    
      // 采样动画帧 → 每骨骼世界姿势 {angle, tx, ty}
      // MDLA 段布局 (逆向自 Plana 53 骨骼等模型, 9 列循环交错, sf40g):
      //   骨骼 b 的 (tx, ty, rot) = 段 b 内 float 位置 (2b, 2b+1, 2b+2),
      //   帧偏移 floor(P/9), 列 P%9 (col9 跨下一帧; tx@2b/ty@2b+1/rot@2b+2
      //   经 Plana 53骨/后发 6骨/鼻子 7骨/头 3骨/右眼 16骨/上半身 8骨/眼睛部件 44骨
      //   全量验证命中。旧公式 rot@(2b+5) 对 53 骨骼读到 scale 常量 1.0 → 末梢
      //   骨骼全部"旋转 1 弧度"导致身体组件错位)
      //   段帧循环 (frameCount+1) 帧; rot 为弧度 (bind 矩阵旋转角一致)
      // 2D 世界链乘: 角度相加, 平移 = 父平移 + Rz(父角度)·局部平移
,
    _sampleAnimRT(mesh, anim, frame, nb, bones) {
        const out = new Array(nb);
        const dv = new DataView(mesh.raw.buffer, mesh.raw.byteOffset, mesh.raw.byteLength);
        const totalFrames = Math.max(1, anim.frameCount);
        // 官方段数据布局 (第一手证据: wallpaper64.exe 加载器 .c:437664 逐骨
        // [u32 flags][u32 size][data]; 消费端 FUN_140267580 .c:440186; 真实数据判别
        // 见 scripts/verify-mdla.mjs):
        //   每骨块 = (frameCount+1) 帧 × 9 float, **帧直读** — 帧 f → 偏移 f*36:
        //   [tx, ty, tz, r0, r1, r2, sx, sy, sz] (2D 场景用 rz = 索引 5)
        //   帧0 = bind (r*=0, s*=1); 末帧 = 帧0 (循环闭合)。
        // 旧实现按"9 列交错 2b/2b+2"读 (rot 取列 (2b+2)%9) — 与真实数据不符,
        // 是 Plana/Amiya 姿态错位的根因。稀疏块 (flags 非 0 → 每帧 float 数 < 9)
        // 按 segPer 缺省补 0/1。
        const bindFallback = (b) => {
          const bm = bones[b].bind;
          const parent = bones[b].parent;
          if (parent >= 0 && parent < nb && out[parent]) {
            const pa = out[parent].angle, pc = Math.cos(pa), ps = Math.sin(pa);
            return {
              angle: pa + Math.atan2(bm[1], bm[0]),
              tx: out[parent].tx + bm[12] * pc - bm[13] * ps,
              ty: out[parent].ty + bm[12] * ps + bm[13] * pc,
              sx: (out[parent].sx != null ? out[parent].sx : 1),
              sy: (out[parent].sy != null ? out[parent].sy : 1),
            };
          }
          return { angle: Math.atan2(bm[1], bm[0]), tx: bm[12], ty: bm[13], sx: 1, sy: 1 };
        };
        for (let b = 0; b < nb; b++) {
          const segStart = anim.segs && anim.segs[b];
          if (segStart == null) { out[b] = bindFallback(b); continue; }
          const per = (anim.segPer && anim.segPer[b] > 0) ? Math.round(anim.segPer[b]) : 9;
          // loop 模式: single/step/startpaused = **一次性 → 播完保持末帧** (数据含
          // frameCount+1 帧, 索引 0..frameCount; 末帧 = 帧0 = 静止姿态);
          // loop / 其它 = 循环取模。旧实现一律取模 ⇒ 一次性动画 (如 Mutsumi 嘴巴的
          // 636 层) 在静态帧时刻停在形变中途。
          const loopMode = String(anim.loop == null ? 'loop' : anim.loop);
          const once = (loopMode === 'single' || loopMode === 'step' || loopMode === 'startpaused');
          // 静态帧 (单帧输出): 一次性动画直接取**末帧**(= 保持态 = 静止姿态, 官方
          // "播完保持末帧" 语义) —— 与 t 无关, 判据来自 MDL 自带的 loop 字段。
          // 视频路径 (this.staticFrame=false) 仍按真实时间钳制, 保留入场运动。
          // 帧号边界保护 (数据驱动: 用该骨块的**真实字节数** segSize 推可用帧数):
          // 一次性动画保持末帧时 f 会取到 frameCount, 但各模型块内帧数并不都是 frameCount+1
          // (segPer 有小数时 Math.round 后尤其如此) — 越界会读到**下一骨块的头** (flags/size
          // 当 float) ⇒ 顶点爆炸、整幅退化单色 (实测 Angel Mail b1/b2/鸟1/鸟2: t=5 偏差
          // 900%+ 对角)。钳到块内最后一帧。
          const blockFrames = (process.env.DSH_WE_BLOCKGUARD !== '0' && anim.segSize && anim.segSize[b] && per > 0)
            ? Math.floor(anim.segSize[b] / (per * 4)) : 0;
          let f = once
            ? (this.staticFrame ? totalFrames : Math.min(frame, totalFrames))
            : (totalFrames > 1 ? (frame % totalFrames) : 0);
          if (blockFrames > 0 && f > blockFrames - 1) f = blockFrames - 1;
          const o = segStart + f * per * 4;
          const rd = (i, d) => (per > i && o + i * 4 + 4 <= mesh.raw.byteLength ? dv.getFloat32(o + i * 4, true) : d);
          const px = rd(0, 0), py = rd(1, 0);
          const rotZ = rd(5, 0);          // 2D: 旋转 z (索引 5)
          const sx = rd(6, 1), sy = rd(7, 1);
          // 合理性校验 (有限 + 量级), 异常则用绑定局部矩阵 (绑定姿态, 不炸)
          const parent = bones[b].parent;
          if (isFinite(px) && isFinite(py) && Math.abs(px) < 10000 && Math.abs(py) < 10000 && isFinite(rotZ)) {
            if (parent >= 0 && parent < nb && out[parent]) {
              const pa = out[parent].angle, pc = Math.cos(pa), ps = Math.sin(pa);
              out[b] = {
                angle: pa + rotZ,
                tx: out[parent].tx + px * pc - py * ps,
                ty: out[parent].ty + px * ps + py * pc,
                sx: (out[parent].sx != null ? out[parent].sx : 1) * sx,
                sy: (out[parent].sy != null ? out[parent].sy : 1) * sy,
              };
            } else {
              out[b] = { angle: rotZ, tx: px, ty: py, sx, sy };
            }
          } else {
            out[b] = bindFallback(b);
          }
        }
        return out;
      }
    
      // 行主序 4x4 矩阵乘法 a × b
,
    _matMulRow(a, b) {
        const o = new Array(16);
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            o[r * 4 + c] = a[r * 4 + 0] * b[0 * 4 + c] + a[r * 4 + 1] * b[1 * 4 + c] + a[r * 4 + 2] * b[2 * 4 + c] + a[r * 4 + 3] * b[3 * 4 + c];
          }
        }
        return o;
      }
    
      // 行主序 4x4 仿射逆 (旋转转置 + 平移取反)
,
    _matInvertRow(m) {
        const o = new Array(16);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 4 + c] = m[c * 4 + r];
        o[3] = 0; o[7] = 0; o[11] = 0; o[15] = 1;
        o[12] = -(m[12] * o[0] + m[13] * o[4] + m[14] * o[8]);
        o[13] = -(m[12] * o[1] + m[13] * o[5] + m[14] * o[9]);
        o[14] = -(m[12] * o[2] + m[13] * o[6] + m[14] * o[10]);
        return o;
      }
    
,
    _parseMdl(buf) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        let mdlsOffset = buf.length;
        for (let off = 9; off + 4 < buf.length; off++) {
          if (buf[off] === 0x4d && buf[off+1] === 0x44 && buf[off+2] === 0x4c && buf[off+3] === 0x53) { mdlsOffset = off; break; }
        }
        let found = null;
        for (let offset = 9; offset + 12 < mdlsOffset; offset++) {
          // 顶点 stride: 块头 u32 的**高 16 位**编码布局 (数据驱动, 非猜测):
          //   0x0180 → 80B (pos/normal/tangent/blendIdx/blendW/uv)
          //   0x0181 → 84B (blendIdx 前多 4B) —— 实测 Angel Mail 3641860575 的
          //           cat11_puppet.mdl (块头 0x181000e) 与 RW0_puppet.mdl 属此类;
          //           旧实现硬编码 80 且只收 vertexBytes%80==0 ⇒ 二者解析为 null 被静默跳过。
          // 两种 stride 的字段偏移都从**尾部**推导: uv@S-8, blendW@S-24, blendIdx@S-40。
          const strideFlag = dv.getUint32(offset, true);
          // 顶点 stride (数据驱动): 块头高 16 位 = 0x0181 → 84B (blendIdx 前多 4B), 否则 80B;
          // 字段偏移一律从尾部推导 (uv@S-8 / blendW@S-24 / blendIdx@S-40)。曾因"开启 84B 后
          // 整屏纯蓝"临时门控 DSH_WE_MDL_84 —— 现已定位纯蓝来自 GLSL 栈 (非本解析, 且已加
          // 兜底), 故恢复默认开启: 否则 Angel Mail 的 cat11/RW0 整件不可见。
          const stride = (strideFlag >>> 16) === 0x0181 ? 84 : 80;
          const vertexBytes = dv.getUint32(offset + 4, true);
          const verticesOffset = offset + 8;
          if (vertexBytes === 0 || vertexBytes % stride !== 0) continue;
          const indexLenOffset = verticesOffset + vertexBytes;
          if (indexLenOffset + 4 > mdlsOffset) continue;
          const indexBytes = dv.getUint32(indexLenOffset, true);
          const indicesOffset = indexLenOffset + 4;
          if (indexBytes === 0 || indexBytes % 2 !== 0 || indicesOffset + indexBytes > mdlsOffset) continue;
          // 顶点合理性: 前若干顶点的 pos 必须有限且量级合理 (部分 MDL 有垃圾候选块,
          // 选错会把顶点炸到 1e28 导致渲染崩溃)
          const vc = vertexBytes / stride;
          let sane = true;
          for (let i = 0; i < Math.min(vc, 64); i++) {
            const vo = verticesOffset + i * stride;
            for (let k = 0; k < 3; k++) {
              const v = dv.getFloat32(vo + k * 4, true);
              if (!isFinite(v) || Math.abs(v) > 1e6) { sane = false; break; }
            }
            if (!sane) break;
          }
          if (!sane) continue;
          // 索引范围: 前若干索引必须 < 顶点数 (部分 MDL 索引与顶点块不匹配)
          const ic = indexBytes / 2;
          if (ic > 0) {
            let idxOk = 0;
            for (let k = 0; k < Math.min(ic, 400); k++) {
              if (dv.getUint16(indicesOffset + k * 2, true) < vc) idxOk++;
            }
            if (idxOk < Math.min(ic, 400) * 0.98) continue;
          }
          found = { verticesOffset, vertexBytes, indicesOffset, indexBytes, stride };
          break;
        }
        if (!found) return null;
        const vertexCount = found.vertexBytes / found.stride;
        const indexCount = found.indexBytes / 2;
        // 字段偏移从 stride 尾部推导 (84B = 80B + blendIdx 前插入 4B)
        const uvOff = found.stride - 8;
        const bwOff = found.stride - 24;
        const biOff = found.stride - 40;
        const positions = [], uvs = [], blendIndices = [], blendWeights = [];
        for (let i = 0; i < vertexCount; i++) {
          const vo = found.verticesOffset + i * found.stride;
          positions.push([dv.getFloat32(vo, true), dv.getFloat32(vo + 4, true), dv.getFloat32(vo + 8, true)]);
          uvs.push([dv.getFloat32(vo + uvOff, true), dv.getFloat32(vo + uvOff + 4, true)]);
          blendIndices.push([dv.getUint32(vo + biOff, true), dv.getUint32(vo + biOff + 4, true), dv.getUint32(vo + biOff + 8, true), dv.getUint32(vo + biOff + 12, true)]);
          blendWeights.push([dv.getFloat32(vo + bwOff, true), dv.getFloat32(vo + bwOff + 4, true), dv.getFloat32(vo + bwOff + 8, true), dv.getFloat32(vo + bwOff + 12, true)]);
        }
        const indices = [];
        for (let i = 0; i < indexCount; i++) indices.push(dv.getUint16(found.indicesOffset + i * 2, true));
        // 骨骼 (MDLS) + 动画 (MDLA): puppet 蒙皮
        let bones = [], animations = [];
        if (mdlsOffset < buf.length) {
          try {
            let p = mdlsOffset + 9;
            p += 4; // 段字节
            const boneCount = dv.getUint32(p, true); p += 4;
            for (let b = 0; b < boneCount && p + 12 < buf.length; b++) {
              // 骨骼头变体: 大部分 tmp 为 u8 (9 字节头); 个别骨骼 (带旋转/特殊) tmp 为 u16 (10 字节头)
              // 用 entryLen 合理性 (0 < len <= 4096) 判断; 不合法则按 u16 tmp 重读
              let headExtra = 0;
              let tmp = buf[p];
              let type = dv.getUint32(p + 1, true);
              let parent = dv.getInt32(p + 5, true);
              let len = dv.getUint32(p + 9, true);
              if (len === 0 || len > 4096) {
                tmp = dv.getUint16(p, true);
                type = dv.getUint32(p + 2, true);
                parent = dv.getInt32(p + 6, true);
                len = dv.getUint32(p + 10, true);
                headExtra = 1;
                if (len === 0 || len > 4096) break; // 无法对齐
              }
              p += 9 + headExtra; // tmp + type + parent 之后 (len 字段起点)
              p += 4; // len 字段本身
              const m = new Array(16);
              for (let i = 0; i < 16; i++) m[i] = dv.getFloat32(p + i * 4, true);
              p += len;
              let je = p;
              while (je < buf.length && buf[je] !== 0) je++;
              p = je + 1;
              bones.push({ index: b, type, parent: parent === -1 ? -1 : parent, bind: m });
            }
          } catch { bones = []; }
          // MDLA 动画
          const mdla = buf.indexOf('MDLA');
          if (mdla >= 0) {
            try {
              let p = mdla + 9;
              p += 4; // 总字节
              const animCount = dv.getUint32(p, true); p += 4;
              for (let a = 0; a < animCount && p + 12 < buf.length; a++) {
                const animId = dv.getUint32(p, true); p += 4; // 动画 ID (animationlayers.animation 引用)
                p += 4; // u32 0
                const nameEnd = buf.indexOf(0, p);
                if (nameEnd < 0) break;
                const animName = buf.toString('utf8', p, nameEnd);
                p = nameEnd + 1;
                const loopEnd = buf.indexOf(0, p);
                if (loopEnd < 0) break;
                const loopMode = buf.toString('utf8', p, loopEnd);
                p = loopEnd + 1;
                // 数据头: u32 帧率(float) + u32 帧数 + u32 0 + u32 骨骼数 + u32 0 + u32 段字节
                // (旧实现按字节搜索 [f0 41]=30.0f 前缀 — 60fps 动画 (0x42700000) 不匹配导致解析失败)
                const animFps = dv.getFloat32(p, true); p += 4;
                const frameCount = dv.getUint32(p, true); p += 4;
                p += 4; // u32 0
                const boneCount = dv.getUint32(p, true); p += 4;
                p += 4; // u32 0
                const segBytes = dv.getUint32(p, true); p += 4;
                // 合理性校验 (防垃圾段): 帧数/骨骼数/段字节量级
                // 段字节 = 每骨骼每帧数据 × 帧数 (Plana 132帧×53骨 → segBytes 可 >4096)
                if (frameCount === 0 || frameCount > 100000 || boneCount === 0 || boneCount > 512 || segBytes === 0 || segBytes > 200000) break;
                // 官方逐骨块布局 (第一手: wallpaper64.exe 加载器 .c:437664 逐骨
                // [u32 flags][u32 size][size 字节 data]; 消费端 FUN_140267580 .c:440186):
                //   骨0 的 [flags][size] 即上面已读的 u32 0 + segBytes → 数据从 p 起;
                //   其后每骨: [u32 flags][u32 size][data]。**块长逐骨可变** (flags 稀疏)。
                //   旧实现按统一步长 segs[b] = p + b*segBytes 定位 → 骨 b 累计偏移 8·b
                //   字节 (骨30 ≈ 6.7 帧错位) — "部分模型错位"的根因。
                const segs = [], segPer = [], segFlags = [], segSize = [];
                let cursor = p;
                for (let b = 0; b < boneCount; b++) {
                  let size = segBytes, flags = 0;
                  if (b > 0) {
                    if (cursor + 8 > buf.length) break;
                    flags = dv.getUint32(cursor, true);
                    size = dv.getUint32(cursor + 4, true);
                    cursor += 8;
                  }
                  if (size <= 0 || cursor + size > buf.length) break;
                  segs.push(cursor);
                  segFlags.push(flags);
                  // 每帧 float 数 (满通道 9; 稀疏块按 flags 变小)
                  segPer.push(size / (frameCount + 1) / 4);
                  segSize.push(size);
                  cursor += size;
                }
                animations.push({ id: animId, name: animName, loop: loopMode, fps: animFps, frameCount, boneCount, segBytes, segs, segPer, segFlags, segSize });
                // 跳过动画数据到下一动画头: 用逐骨走完的真实结束位置 cursor
                // (动画段间可能有绑定姿态表等附加数据 — 仍需扫描下一个"有效动画头")
                const scanStart = cursor;
                p = findNextAnimationHeader(buf, dv, scanStart, buf.length);
                if (p < 0) break;
              }
            } catch { animations = []; }
          }
          // MDLE0002 (骨骼扩展矩阵, 每骨骼 64B, IK/约束相关 — 逆向自 wallpaper64.exe)
          // 结构: [MDLE0002\0][u32 段尾偏移][u32 骨骼矩阵字节 = 骨数×64][每骨骼 64B 矩阵×骨数]
          const mdle = buf.indexOf('MDLE');
          if (mdle >= 0) {
            try {
              const tail = dv.getUint32(mdle + 9, true);
              const matBytes = dv.getUint32(mdle + 13, true);
              const n = matBytes > 0 ? matBytes / 64 : 0;
              const mats = [];
              for (let b = 0; b < Math.min(n, 256); b++) {
                const mo = mdle + 17 + b * 64;
                const m = new Array(16);
                for (let i = 0; i < 16; i++) m[i] = dv.getFloat32(mo + i * 4, true);
                mats.push(m);
              }
              bones.forEach((b, i) => { if (mats[i]) b.extend = mats[i]; });
            } catch { /* 扩展段解析失败不影响 */ }
          }
        }
        return { positions, uvs, indices, vertexCount, indexCount, blendIndices, blendWeights, bones, animations, raw: buf };
      }
    
      // ── 静态 MDL (MDLV0014 非 puppet 变体) 解析 ────────────────────────
      // 结构: "MDLV0014" + 头部 + "materials/....json\0" + u32 标志 + u32 顶点字节数
      //       + 顶点流 (stride 32: pos/normal/uv; stride 64: pos/normal/tangent/uv)
      //       + u32 索引字节数 + u16 索引流
,
    _parseMdlStatic(buf) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        // MDLV0004 / MDLV0014 等版本均适用 (布局相同, 仅版本号不同)
        if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'MDLV') return null;
        const matStart = this._indexOfBytes(buf, 'materials/', 8);
        if (matStart < 0) return null;
        let matEnd = matStart;
        while (matEnd < buf.length && buf[matEnd] !== 0) matEnd++;
        const materialPath = buf.toString('utf8', matStart, matEnd);
        const f0 = dv.getUint32(matEnd + 1, true);
        const vertBytes = dv.getUint32(matEnd + 5, true);
        const vertStart = matEnd + 9;
        if (vertBytes <= 0 || vertBytes > buf.length || vertStart + vertBytes > buf.length) return null;
        // stride 探测: 优先 64/32 (pos+normal+uv); 无法线布局 (如 bgfade: pos+uv, stride 20) 走宽松回退
        const cands = [];
        for (const stride of [64, 48, 32, 40, 44, 56]) {
          if (vertBytes % stride !== 0) continue;
          const vc = vertBytes / stride;
          if (vc < 3 || vc > 100000) continue;
          let normOk = 0, n = 0;
          for (let i = 0; i < Math.min(vc, 300); i++) {
            const o = vertStart + i * stride;
            const nx = dv.getFloat32(o + 12, true), ny = dv.getFloat32(o + 16, true), nz = dv.getFloat32(o + 20, true);
            const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (Math.abs(l - 1) < 0.1) normOk++;
            n++;
          }
          if (normOk < n * 0.6) continue;
          // 索引范围检查
          const idxBytesPos = vertStart + vertBytes;
          const idxBytesT = dv.getUint32(idxBytesPos, true);
          const idxStartT = idxBytesPos + 4;
          let idxAllOk = false;
          if (idxBytesT > 0 && idxBytesT % 2 === 0 && idxStartT + idxBytesT <= buf.length + 1) {
            const ic = idxBytesT / 2;
            if (ic > 0 && ic % 3 === 0 && ic < 300000) {
              let ok = 0;
              for (let k = 0; k < Math.min(ic, 400); k++) {
                if (dv.getUint16(idxStartT + k * 2, true) < vc) ok++;
              }
              idxAllOk = ok > Math.min(ic, 400) * 0.98;
            }
          }
          // 法线-面法线对齐 (平滑网格判别)
          let align = 0, an = 0;
          if (idxAllOk) {
            for (let k = 0; k + 2 < Math.min(idxBytesT / 2, 3000); k += 3) {
              const a = dv.getUint16(idxStartT + k * 2, true), b = dv.getUint16(idxStartT + k * 2 + 2, true), c = dv.getUint16(idxStartT + k * 2 + 4, true);
              if (a >= vc || b >= vc || c >= vc) continue;
              const pa = [dv.getFloat32(vertStart + a * stride, true), dv.getFloat32(vertStart + a * stride + 4, true), dv.getFloat32(vertStart + a * stride + 8, true)];
              const pb = [dv.getFloat32(vertStart + b * stride, true), dv.getFloat32(vertStart + b * stride + 4, true), dv.getFloat32(vertStart + b * stride + 8, true)];
              const pc = [dv.getFloat32(vertStart + c * stride, true), dv.getFloat32(vertStart + c * stride + 4, true), dv.getFloat32(vertStart + c * stride + 8, true)];
              const e1 = v3sub(pb, pa), e2 = v3sub(pc, pa);
              const fn = v3norm(v3cross(e1, e2));
              const vn = [dv.getFloat32(vertStart + a * stride + 12, true), dv.getFloat32(vertStart + a * stride + 16, true), dv.getFloat32(vertStart + a * stride + 20, true)];
              const vl = Math.sqrt(v3dot(vn, vn)) || 1;
              align += Math.abs(v3dot(fn, [vn[0] / vl, vn[1] / vl, vn[2] / vl]));
              an++;
            }
            if (an > 0) align /= an;
          }
          cands.push({ stride, vc, idxAllOk, align });
        }
        cands.sort((a, b) => (b.idxAllOk - a.idxAllOk) || (b.align - a.align));
        let chosen = cands[0];
        // 无法线回退: pos+uv 布局 (stride 20 等), 用位置界 + 索引范围 + UV 覆盖率判别
        if (!chosen) {
          const idxBytesPos = vertStart + vertBytes;
          const idxBytesT = dv.getUint32(idxBytesPos, true);
          const idxStartT = idxBytesPos + 4;
          let ic = 0;
          if (idxBytesT > 0 && idxBytesT % 2 === 0 && idxStartT + idxBytesT <= buf.length + 1) ic = idxBytesT / 2;
          for (const stride of [20, 16, 24, 28, 36, 40, 44, 48, 56]) {
            if (vertBytes % stride !== 0) continue;
            const vc = vertBytes / stride;
            if (vc < 3 || vc > 100000) continue;
            if (ic === 0 || ic % 3 !== 0) continue;
            let idxOk = 0;
            for (let k = 0; k < Math.min(ic, 400); k++) if (dv.getUint16(idxStartT + k * 2, true) < vc) idxOk++;
            if (idxOk < Math.min(ic, 400) * 0.98) continue;
            // UV 覆盖率 (uv 在 stride 末尾)
            const uvOff = stride - 8;
            let uvOk = 0, uvN = 0;
            let minX = 1e9, maxX = -1e9;
            for (let i = 0; i < Math.min(vc, 300); i++) {
              const o = vertStart + i * stride;
              const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
              if (!isFinite(x) || !isFinite(y) || !isFinite(z) || Math.abs(x) > 10000 || Math.abs(y) > 10000) continue;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              const u = dv.getFloat32(o + uvOff, true), v = dv.getFloat32(o + uvOff + 4, true);
              if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) uvOk++;
              uvN++;
            }
            if (uvN > 0 && uvOk > uvN * 0.6) { chosen = { stride, vc, hasNormals: false }; break; }
          }
        }
        if (!chosen) return null;
        const { stride, vc, hasNormals } = chosen;
        const positions = [], normals = [], uvs = [], uv2s = [];
        const hasN = hasNormals !== false;
        // UV 布局 (引擎 vertex): 主纹理 UV1 在 stride 末尾 (stride-8);
        // 第 2 UV (lightmap) 仅 stride 56 有 (pos12+normal12+uv2 8+uv1 8+tangent16 → uv2@stride-16)
        const uvOff = stride === 64 ? 36 : stride - 8;
        let uv2Off = -1;
        if (stride === 56) {
          const p = stride - 16;
          let ok = 0, n = 0;
          for (let i = 0; i < Math.min(vc, 150); i++) {
            const o = vertStart + i * stride;
            const u = dv.getFloat32(o + p, true), v = dv.getFloat32(o + p + 4, true);
            if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) ok++;
            n++;
          }
          if (ok / n > 0.7) uv2Off = p;
        }
        for (let i = 0; i < vc; i++) {
          const o = vertStart + i * stride;
          positions.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]);
          normals.push(hasN ? [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)] : null);
          uvs.push([dv.getFloat32(o + uvOff, true), dv.getFloat32(o + uvOff + 4, true)]);
          uv2s.push(uv2Off >= 0 ? [dv.getFloat32(o + uv2Off, true), dv.getFloat32(o + uv2Off + 4, true)] : null);
        }
        const idxBytesPos = vertStart + vertBytes;
        const idxBytes = dv.getUint32(idxBytesPos, true);
        const idxStart = idxBytesPos + 4;
        if (idxBytes <= 0 || idxBytes % 2 !== 0 || idxStart + idxBytes > buf.length + 1) return null;
        const indices = [];
        for (let i = 0; i < idxBytes / 2; i++) indices.push(dv.getUint16(idxStart + i * 2, true));
        return { positions, normals, uvs, uv2s, indices, materialPath, stride, vertexCount: vc, indexCount: indices.length };
      }
    
,
    _indexOfBytes(buf, str, from) {
        const needle = Buffer.from(str, 'ascii');
        for (let i = from; i + needle.length <= buf.length; i++) {
          let ok = true;
          for (let k = 0; k < needle.length; k++) if (buf[i + k] !== needle[k]) { ok = false; break; }
          if (ok) return i;
        }
        return -1;
      }
    
      // ── Model 对象渲染: MDL 静态网格 + 相机 + 光照 + CPU shader ────────
,
    _meshBounds(positions) {
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (const p of positions) {
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
        return { minX, maxX, minY, maxY };
      }
    
,
    _rasterizeMesh(mesh, tex, skinned, bounds, W, H, flipY) {
        const { uvs, indices } = mesh;
        const tw = tex.width, th = tex.height, tdata = tex.rgba;
        const ALPHA_CUTOFF = 8;
        const sample = (u, v) => {
          const fx = u * tw - 0.5, fy = v * th - 0.5;
          const x0 = Math.max(0, Math.min(tw - 1, Math.floor(fx)));
          const y0 = Math.max(0, Math.min(th - 1, Math.floor(fy)));
          const x1 = Math.min(tw - 1, x0 + 1), y1 = Math.min(th - 1, y0 + 1);
          const tx = fx - x0, ty = fy - y0;
          const i00 = (y0 * tw + x0) * 4, i10 = (y0 * tw + x1) * 4;
          const i01 = (y1 * tw + x0) * 4, i11 = (y1 * tw + x1) * 4;
          const pm = [
            [tdata[i00] * tdata[i00+3], tdata[i00+1] * tdata[i00+3], tdata[i00+2] * tdata[i00+3], tdata[i00+3]],
            [tdata[i10] * tdata[i10+3], tdata[i10+1] * tdata[i10+3], tdata[i10+2] * tdata[i10+3], tdata[i10+3]],
            [tdata[i01] * tdata[i01+3], tdata[i01+1] * tdata[i01+3], tdata[i01+2] * tdata[i01+3], tdata[i01+3]],
            [tdata[i11] * tdata[i11+3], tdata[i11+1] * tdata[i11+3], tdata[i11+2] * tdata[i11+3], tdata[i11+3]],
          ];
          const out = [0, 0, 0, 0];
          for (let c = 0; c < 4; c++) {
            const top = pm[0][c] * (1 - tx) + pm[1][c] * tx;
            const bot = pm[2][c] * (1 - tx) + pm[3][c] * tx;
            out[c] = top * (1 - ty) + bot * ty;
          }
          if (out[3] < ALPHA_CUTOFF) return [0, 0, 0, 0];
          const a = out[3];
          return [Math.min(255, Math.round(out[0] / a)), Math.min(255, Math.round(out[1] / a)), Math.min(255, Math.round(out[2] / a)), Math.round(a)];
        };
        const rgba = new Uint8Array(W * H * 4);
        for (let t = 0; t < indices.length; t += 3) {
          const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
          const a = [skinned[i0][0] - bounds.minX, flipY(skinned[i0][1])];
          const b = [skinned[i1][0] - bounds.minX, flipY(skinned[i1][1])];
          const c = [skinned[i2][0] - bounds.minX, flipY(skinned[i2][1])];
          const bx0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
          const bx1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
          const by0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
          const by1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
          if (bx1 < bx0 || by1 < by0) continue;
          const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (Math.abs(area) < 1e-9) continue;
          const w0 = uvs[i0], w1 = uvs[i1], w2 = uvs[i2];
          for (let y = by0; y <= by1; y++) {
            for (let x = bx0; x <= bx1; x++) {
              const px = x + 0.5, py = y + 0.5;
              const la = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
              const lb = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
              const lc = ((a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px)) / area;
              if (la < -1e-4 || lb < -1e-4 || lc < -1e-4) continue;
              const di = (y * W + x) * 4;
              const u = la * w0[0] + lb * w1[0] + lc * w2[0];
              const v = la * w0[1] + lb * w1[1] + lc * w2[1];
              const s = sample(u, v);
              const srcA = s[3] / 255;
              if (srcA <= 0) continue;
              const dstA = rgba[di + 3] / 255;
              const outA = srcA + dstA * (1 - srcA);
              if (outA <= 0) continue;
              rgba[di] = Math.round((s[0] * srcA + rgba[di] * dstA * (1 - srcA)) / outA);
              rgba[di + 1] = Math.round((s[1] * srcA + rgba[di + 1] * dstA * (1 - srcA)) / outA);
              rgba[di + 2] = Math.round((s[2] * srcA + rgba[di + 2] * dstA * (1 - srcA)) / outA);
              rgba[di + 3] = Math.round(outA * 255);
            }
          }
        }
        return { width: W, height: H, rgba };
      }
    
      // ── 效果链 (CPU 实现 shader) ──────────────────────────────────────
  });
}
