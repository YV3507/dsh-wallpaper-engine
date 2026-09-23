// WE 渲染引擎 — particles (从 core.js 拆分, 逻辑不变)
import { parseVec3, getVal, mat4TransformPoint } from './math.js';
import { linLight } from './canvas.js';

// HDR 加性通道的逐粒子线性光 LUT 暂存 (3×256: R/G/B 各一份, 按纹理 red 的 8bit 量化值索引)。
// 每颗粒子重建内容但不重新分配数组 —— 粒子数可达数千, 避免每颗一次分配。
const _addLut = new Float32Array(3 * 256);

// ── 壁纸自带粒子着色器: 数据驱动解析 + 直译 ───────────────────────────────────
// 官方 shader 解析顺序 = **壁纸包内 `shaders/<name>.frag` 优先, 找不到才用引擎内建**。
// 因此"该用哪一份"由两条**数据**决定, 而不是场景名/白名单:
//   ① 材质 `passes[].shader` 声明的着色器名 (壁纸文件);
//   ② 该名字的源码是否真的在**这个壁纸包**里 (`pkg.readText('shaders/<name>.frag')`)。
// 本解析器只做**特征抽取** (从源码文本里读出常量与分支), 不做通用 GLSL 解释器:
// 任一期望构造缺失/不匹配 ⇒ 返回 null ⇒ 退回本仓库内建 genericparticle 语义 (逐字节同
// 修改前) 并记一条 degraded。支持的最小子集 = 官方 WE 粒子着色器家族在语料里实际使用的写法:
//   frag: `float albedo = texSample2D(g_Texture0, v_TexCoord).r;`
//         `#if WORLDBLUR` → `blurAmount = v_Blur * <k>; albedo = smoothstep(<a>-blurAmount, <b>+blurAmount, albedo);`
//         `#else` 同形; `gl_FragColor = v_Color * albedo;`
//   vert: `v_Blur = smoothstep(<z0>,<z1>, a_Position.z)` (或 `worldPos.z`) + 可选 `pow(v_Blur,<p>)`;
//         `v_Color.a *= <f>;` / `v_Color.rgb = mix(g_Color1, g_Color2, v_Color.r);`
export function parseWallpaperParticleShader(frag, vert) {
  if (typeof frag !== 'string' || !frag.length) return null;
  // 输出式必须是 `gl_FragColor = v_Color * albedo;` (标量 albedo 同时乘 rgb 与 a)
  if (!/gl_FragColor\s*=\s*v_Color\s*\*\s*albedo\s*;/.test(frag)) return null;
  // 形状取自纹理 red (frag:11 `...texSample2D(g_Texture0, v_TexCoord).r`)
  if (!/texSample2D\s*\(\s*g_Texture0\s*,\s*v_TexCoord\s*\)\s*\.\s*r/.test(frag)) return null;
  const steps = [];
  const reStep = /smoothstep\s*\(\s*([0-9.]+)\s*-\s*blurAmount\s*,\s*([0-9.]+)\s*\+\s*blurAmount\s*,\s*albedo\s*\)/g;
  let m;
  while ((m = reStep.exec(frag)) !== null) steps.push({ a: parseFloat(m[1]), b: parseFloat(m[2]), at: m.index });
  const reK = /blurAmount\s*=\s*v_Blur\s*\*\s*([0-9.]+)\s*;/g;
  const ks = [];
  while ((m = reK.exec(frag)) !== null) ks.push({ k: parseFloat(m[1]), at: m.index });
  if (!steps.length || steps.length !== ks.length) return null;
  // 分支归属: `#if WORLDBLUR` 之后的第一个 smoothstep = WORLDBLUR 支, `#else` 之后 = 普通支。
  // `blurAmount = v_Blur * k;` 写在 smoothstep **之前** ⇒ 取"位于该 smoothstep 之前最近的 k"。
  const iIf = frag.search(/#if\s+WORLDBLUR\b/);
  const iElse = iIf >= 0 ? frag.indexOf('#else', iIf) : -1;
  const make = (s) => {
    let k = null;
    for (const x of ks) if (x.at < s.at && (k === null || x.at > k.at)) k = x;
    if (k === null) k = ks[0];
    return { a: s.a, b: s.b, k: k ? k.k : NaN };
  };
  let worldblur = null, plain = null;
  if (iIf >= 0 && iElse > iIf) {
    for (const s of steps) { if (s.at > iIf && s.at < iElse) worldblur = make(s); else if (s.at > iElse) plain = make(s); }
  } else {
    for (const s of steps) plain = make(s);
  }
  if (!plain || !isFinite(plain.a) || !isFinite(plain.b) || !isFinite(plain.k)) return null;
  if (worldblur && (!isFinite(worldblur.a) || !isFinite(worldblur.b) || !isFinite(worldblur.k))) worldblur = null;
  const spec = { worldblur, plain, alphaFactor: 1, userColorBlend: false, plainZ: null, worldZ: null, worldZPow: null, needsZ: false };
  if (typeof vert === 'string' && vert.length) {
    const mAlpha = /v_Color\.a\s*\*=\s*([0-9.]+)\s*;/.exec(vert);
    if (mAlpha) spec.alphaFactor = parseFloat(mAlpha[1]);
    spec.userColorBlend = /v_Color\.rgb\s*=\s*mix\s*\(\s*g_Color1\s*,\s*g_Color2\s*,\s*v_Color\.r\s*\)/.test(vert);
    const mPlain = /v_Blur\s*=\s*smoothstep\s*\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*a_Position\.z\s*\)/.exec(vert);
    const mWorld = /v_Blur\s*=\s*smoothstep\s*\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*worldPos\.z\s*\)/.exec(vert);
    if (mPlain) spec.plainZ = [parseFloat(mPlain[1]), parseFloat(mPlain[2])];
    if (mWorld) spec.worldZ = [parseFloat(mWorld[1]), parseFloat(mWorld[2])];
    const mPow = /v_Blur\s*=\s*pow\s*\(\s*v_Blur\s*,\s*([0-9.]+)\s*\)/.exec(vert);
    if (mPow) spec.worldZPow = parseFloat(mPow[1]);
  }
  if (!isFinite(spec.alphaFactor)) spec.alphaFactor = 1;
  // WORLDBLUR 支需要 worldPos.z 的来源; 普通支需要 a_Position.z 的来源 —— 缺一即视为不可识别
  if (worldblur && !spec.worldZ) return null;
  if (!spec.plainZ) return null;
  spec.needsZ = true;
  return spec;
}

// GLSL smoothstep (不钳制分母: 与官方写法逐位一致; 本语料的 a<b 恒成立)
function glslSmoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// 官方 particle.vert:74-80 的 v_Blur 直译 (localZ = a_Position.z, worldZ = worldPos.z)
export function wallpaperParticleBlur(spec, useWorldblur, localZ, worldZ) {
  if (useWorldblur && spec.worldZ) {
    const t = glslSmoothstep(spec.worldZ[0], spec.worldZ[1], worldZ);
    return spec.worldZPow == null ? t : Math.pow(t, spec.worldZPow);
  }
  return glslSmoothstep(spec.plainZ[0], spec.plainZ[1], localZ);
}

// 官方 particle.frag:11-22 的直译: albedo = smoothstep(阈值(±v_Blur), tex.r)
export function wallpaperParticleAlbedo(spec, useWorldblur, red, vBlur) {
  const br = (useWorldblur && spec.worldblur) ? spec.worldblur : spec.plain;
  const b = vBlur * br.k;
  return glslSmoothstep(br.a - b, br.b + b, red);
}

// 官方纹理采样口径 (与 model.js `_texSample` 同一 texel 中心约定):
//   interp=true  → 双线性 (texel 中心 (i+0.5)/W; GL_LINEAR = 引擎默认)
//   interp=false → 最近邻 floor(u*W) (GL_NEAREST; 仅当 `<tex>.tex-json` 有 nointerpolation)
//   clamp=true   → CLAMP_TO_EDGE (sidecar `clampuvs`); 否则 REPEAT (GL 默认地址模式)
// 只取 R 通道: 粒子片元用 `.r` 作形状 (particle.frag:11) / 内建口径的 tex.r。
export function sampleTexRed(tex, u, v, interp, clamp) {
  const W = tex.width, H = tex.height, px = tex.rgba;
  let x, y;
  if (!isFinite(u) || !isFinite(v)) return 0;
  if (clamp) {
    x = u < 0 ? 0 : (u > 0.999999 ? 0.999999 : u);
    y = v < 0 ? 0 : (v > 0.999999 ? 0.999999 : v);
  } else {
    x = ((u % 1) + 1) % 1;
    y = ((v % 1) + 1) % 1;
  }
  if (!interp) {
    const ix = Math.min(W - 1, Math.max(0, Math.floor(x * W)));
    const iy = Math.min(H - 1, Math.max(0, Math.floor(y * H)));
    return px[(iy * W + ix) * 4] / 255;
  }
  const fx = x * W - 0.5, fy = y * H - 0.5;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(fy)));
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
  const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  const top = px[i00] * (1 - tx) + px[i10] * tx;
  const bot = px[i01] * (1 - tx) + px[i11] * tx;
  return (top * (1 - ty) + bot * ty) / 255;
}

// ── particles mixin (从 core.js 拆分, 逻辑零改动) ──
export function installParticles(proto) {
  Object.assign(proto, {
    renderParticleSystem(o, t) {
        // 读取粒子定义 (文件或内联)
        let def = null;
        const particleVal = o.particle;
        if (typeof particleVal === 'string') {
          def = this.pkg.readJson(particleVal);
        } else if (typeof particleVal === 'object') {
          def = particleVal;
        }
        if (!def) return;
        const sys = this._buildParticleSystem(o, def);
        if (!sys) return;
        // 模拟期也使用确定性 RNG (发射/初始器), 保证同场景帧可复现
        const origRandom = Math.random;
        Math.random = sys.rng;
        try {
          this._simulateParticleSystem(sys, t);
          this._drawParticles(sys);
        } finally {
          Math.random = origRandom;
        }
      }
    
,
    _buildParticleSystem(o, def) {
        const tr = this.resolveTransform(o);
        const origin = tr.origin;
        const scale = tr.scale;
        const angle = tr.angle;
        const inst = o.instanceoverride || {};
        // 官方 instanceoverride 是逐粒子系统的倍率 (CParticle.cpp): alpha=:495/:644,
        // rate=:371/:523, size=:496/:645 与 :738 (sizerandom 出口), lifetime=:497/:646
        // 与 :761 (lifetimerandom 出口), count=:59-60 (池容量倍率)。
        const alphaMul = this._instNum(inst, 'alpha', 1);
        const rateMul = this._instNum(inst, 'rate', 1);
        const sizeMul = this._instNum(inst, 'size', 1);
        const lifetimeMul = this._instNum(inst, 'lifetime', 1);
        const countMul = this._instNum(inst, 'count', 1);
        // maxcount = **粒子池大小(存活上限)**, 不是累计发射数:
        //   CParticle.cpp:58-65 把 maxCount×instanceoverride.count 当池容量
        //   (m_particles.resize(m_maxParticles)), 发射门是 count < particles.size()
        //   (:395/:461), 死亡后按序压缩 :307-320 让 count 回落 ⇒ 发射自动恢复。
        // 0/缺失 → 官方 DEFAULT_MAX_PARTICLES=1000 (CParticle.h:23); JSON 完全缺字段时
        // 官方的默认填充值是 10 (wallpaper64.exe.c:330442 "maxcount" 默认 10)。
        const baseMax = def.maxcount != null ? def.maxcount : 10;
        const adjustedMax = Math.round(baseMax * countMul);
        const maxCount = adjustedMax > 0 ? adjustedMax : 1000;
        // 确定性伪随机: 粒子生成期间替换 Math.random, 保证同场景渲染可复现 (缓存一致)
        const rng = this._particleRng(o);
        const origRandom = Math.random;
        Math.random = rng;
        try {
          const sys = this._buildParticleSystemInner(o, def, { tr, origin, scale, angle, inst, alphaMul, rateMul, sizeMul, lifetimeMul, maxCount, rng });
          return sys;
        } finally {
          Math.random = origRandom;
        }
      }
    
,
    _buildParticleSystemInner(o, def, ctx) {
        const { tr, origin, scale, angle, inst, alphaMul, rateMul, sizeMul, lifetimeMul, maxCount, rng } = ctx;
        const emitters = (def.emitter || []).map((e) => this._parseEmitter(e, scale, angle));
        const initializers = (def.initializer || []).map((i) => this._parseInitializer(i)).filter(Boolean);
        const operators = (def.operator || []).map((op) => this._parseOperator(op)).filter(Boolean);
        // 纹理 + 材质属性 (blending / usershadervalues)
        let tex = null;
        let blending = 'translucent';
        let color1 = [1, 1, 1], color2 = [1, 1, 1];
        // 材质 `passes[0]` 的 shader 名 / combos / 第一张纹理的采样标志 —— 全部来自壁纸文件
        let shaderName = null, combos = null, texInterp = true, texClamp = false, texFlags = null;
        if (def.material) {
          const mat = this.pkg.readJson(def.material);
          const pass = mat && mat.passes && mat.passes[0] ? mat.passes[0] : null;
          if (pass) {
            shaderName = typeof pass.shader === 'string' ? pass.shader : null;
            combos = (pass.combos && typeof pass.combos === 'object') ? pass.combos : {};
            if (pass.textures && pass.textures.length) {
              tex = this.loadTexture(pass.textures[0]);
              const fl = this._particleTexFlags(pass.textures[0]);
              texInterp = fl.interp; texClamp = fl.clamp; texFlags = fl.sidecar;
              // 诊断: 精灵 alpha 直方图 (0/中间/255) + 全部贴图槽 + 着色值
              let hist = 'null';
              if (tex) {
                let a0 = 0, am = 0, af = 0, n = 0;
                const st = Math.max(1, Math.floor((tex.width * tex.height) / 2000));
                for (let i = 0; i < tex.width * tex.height; i += st) {
                  const a = tex.rgba[i * 4 + 3]; n++;
                  if (a === 0) a0++; else if (a < 250) am++; else af++;
                }
                hist = `a0=${(a0 / n * 100).toFixed(0)}% aMid=${(am / n * 100).toFixed(0)}% a255=${(af / n * 100).toFixed(0)}%`;
              }
              this.log('粒子精灵 ' + JSON.stringify(pass.textures[0]) + ' → '
                + (tex ? tex.width + 'x' + tex.height + ' ' + hist : 'null')
                + ' 槽=' + JSON.stringify(pass.textures)
                + ' usv=' + JSON.stringify(pass.usershadervalues || null)
                + ' csv=' + JSON.stringify(pass.constantshadervalues || null)
                + ' 采样=' + (texInterp ? 'LINEAR' : 'NEAREST') + (texClamp ? '+CLAMP' : '+REPEAT')
                + ' sidecar=' + JSON.stringify(texFlags));
            }
            if (pass.blending) blending = pass.blending;
            const usv = pass.usershadervalues;
            if (usv) for (const [prop, uniform] of Object.entries(usv)) {
              const v = this.userProps[prop];
              if (uniform === 'color1') color1 = typeof v === 'string' ? parseVec3(v, [1, 1, 1]) : color1;
              else if (uniform === 'color2') color2 = typeof v === 'string' ? parseVec3(v, [1, 1, 1]) : color2;
            }
          }
        }
        // 壁纸自带粒子着色器 (有源码且可识别 → 按它执行; 否则 null → 内建 genericparticle 语义)
        const shaderSpec = this._resolveParticleShader(shaderName);
        // 正交投影缩放: 场景单位 → 画布像素 (原生 ortho(-w/2,w/2,-h/2,h/2) 投影)
        let projScale = null;
        const ortho = this.scene.general && this.scene.general.orthogonalprojection;
        if (ortho && ortho.width) {
          projScale = [this.W / ortho.width, this.H / (ortho.height || 1080)];
        }
        return {
          o, origin, scale, angle, alphaMul, rateMul, sizeMul, lifetimeMul, maxCount,
          emitters, initializers, operators, tex, blending, color1, color2, projScale,
          // 壁纸自带粒子着色器 (数据驱动; null = 走本仓库内建 genericparticle 语义):
          //   shaderSpec = shaders/<name>.frag|.vert 的解析结果;  combos = 材质 passes[].combos
          //   texInterp/texClamp = 第一张纹理的 *.tex-json 采样标志 (nointerpolation/clampuvs)
          shaderName, combos: combos || {}, shaderSpec, texInterp, texClamp,
          // 粒子系统 flags (粒子 json 顶层, 官方 sphererandom 的 2D 圆盘 / 3D 球壳分支依据)
          sysFlags: def.flags || 0,
          animFrames: def.animationmode === 'sequence' ? (def.sequencemultiplier || 1) : 0,
          // 官方粒子 starttime 单位 = 秒 (引擎二进制解析为 float, 官方预设
          // rain=1/fog=2/ember=3/snow=15 均秒级延迟; 0.8s 预设证实) — 粒子系统
          // 在场景时间 starttime 后才开始发射, 与 scene-anim loop 计算一致。
          starttime: def.starttime || 0,
          particles: [],
          // count = **存活数(池占用)**, 随死亡回落 (官方压缩后的 m_particleCount);
          // emittedTotal = 累计发射数 (仅诊断, 不参与门控)
          acc: 0, count: 0, emittedTotal: 0, t0: this.time,
          // 确定性伪随机 (mulberry32): 种子来自场景路径, 保证同场景渲染可复现 (缓存一致)
          rng: this._particleRng(o),
        };
      }
    
      // instanceoverride 数值: 支持内联数值 / {value} / {user,value} (后者优先取用户在
      // project.json 里设置的值, 与 _isVisibleSelf 的 user 语义一致)
,
    _instNum(inst, key, def) {
        const v = inst ? inst[key] : undefined;
        if (v == null) return def;
        let raw = v;
        if (typeof v === 'object') {
          if (typeof v.user === 'string' && this.userProps && this.userProps[v.user] != null) raw = this.userProps[v.user];
          else if ('value' in v) raw = v.value;
        }
        const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
        return Number.isFinite(n) ? n : def;
      }
    
      // 壁纸自带粒子着色器解析 (官方解析顺序: 壁纸 shaders/<name>.frag 优先, 否则引擎内建)。
      // 判定"该用哪一份"的三条数据依据: ① 材质声明的 shader 名; ② 该源码是否在**本壁纸包**内;
      // ③ 源码能否被本解析器识别。任一条不满足 ⇒ null ⇒ 内建路径 (与修改前逐字节相同)。
      // DSH_WE_PARTICLE_SHADER=builtin 可强制退回内建实现 (诊断/对照用)。
,
    _resolveParticleShader(name) {
        if (typeof name !== 'string' || !name) return null;
        if (process.env.DSH_WE_PARTICLE_SHADER === 'builtin') return null;
        if (name === 'genericparticle') return null;   // 引擎内建粒子着色器: 无壁纸自带源码时走本仓库实现
        const frag = this.pkg.readText('shaders/' + name + '.frag');
        if (!frag) return null;
        const vert = this.pkg.readText('shaders/' + name + '.vert');
        const spec = parseWallpaperParticleShader(frag, vert);
        if (!spec) {
          const key = 'particle-shader:' + name;
          if (!this._degradedSeen) this._degradedSeen = new Set();
          if (!this._degradedSeen.has(key)) {
            this._degradedSeen.add(key);
            this._degraded(key, 'particle:shader',
              '壁纸自带 shaders/' + name + '.frag 存在但未被解析器识别 → 退回内建 genericparticle 语义');
          }
          return null;
        }
        return spec;
      }
    
      // 纹理采样标志 (来自 `<tex>.tex-json`; 官方逐纹理字段, 见 wallpaper64.exe.c:365612/365648)
      //   缺字段 ⇒ 默认 LINEAR + REPEAT (GL/D3D 默认地址模式; nointerpolation 的语义即"关闭插值")
      //   DSH_WE_PARTICLE_INTERP=nearest 可强制最近邻 (诊断/对照用)。
,
    _particleTexFlags(texName) {
        const forceNearest = process.env.DSH_WE_PARTICLE_INTERP === 'nearest';
        const def = { interp: !forceNearest, clamp: false, sidecar: null };
        if (typeof texName !== 'string' || !texName) return def;
        let j = null;
        try { j = this.pkg.readJson('materials/' + texName + '.tex-json'); } catch { j = null; }
        if (!j || typeof j !== 'object') return def;
        return { interp: !forceNearest && j.nointerpolation !== true, clamp: j.clampuvs === true, sidecar: j };
      }
    
      // 归一化寿命位置 (官方 ParticleInstance::getLifetimePos, CParticle.h:77):
      //   lifetime > 0 ? age / lifetime : 1 —— 权威字段名是 lifetime, 由 lifetimerandom 写
      //   (官方 LifetimeRandomInitializer, CParticle.cpp:755-765)
,
    _lifePos(p) {
        return p.lifetime > 0 ? p.age / p.lifetime : 1;
      }
    
      // 加性通道是否走 HDR 浮点累积 —— 门控条件 = **引擎真实条件**, 不是 `hdr` 一个键:
      //   `wallpaper64.exe.c:200813-200849` 实测: 先要求 `general.bloom === true` 且
      //   `general.hdr === true`, 再读 `general.postprocessing` (缺省 = **空串**,
      //   `FUN_140086de0(...,"postprocessing","")`) 并与 "ultra"(旗标 0x2000) /
      //   "displayhdr"(0x6000) 比较 —— 只有命中才进 HDR 后处理链 (combine_hdr + HDR bloom)。
      //   本机语料 16 场景**都没有 `postprocessing` 键** ⇒ 全部走 LDR 链 (combine.frag:10-15,
      //   无 lin/曝光/编码 ⇒ 显示空间 8bit 目标) ⇒ 加性混合按硬件规则**饱和**, 与修改前的
      //   逐片元硬裁剪一致。故默认路径不启用浮点层 (只有真 HDR 链场景才启用)。
      //   DSH_WE_HDR_ADD=always 可强制启用 (诊断/三态对照); =off 可整体关闭。
,
    _hdrAdditive() {
        const mode = process.env.DSH_WE_HDR_ADD;
        if (mode === 'off') return false;
        if (mode === 'always' || mode === 'all') return true;
        const gen = this.scene && this.scene.general;
        if (!gen || gen.bloom !== true || gen.hdr !== true) return false;
        const pp = gen.postprocessing;
        return pp === 'ultra' || pp === 'displayhdr';
      }
    
      // mulberry32 确定性 RNG (种子 = 对象 id + 场景路径 hash)
,
    _particleRng(o) {
        let seed = 0x9e3779b9;
        const str = String(this.pkgPath) + '|' + (o.id != null ? o.id : o.name || '') + '|' + (o.origin || '');
        for (let i = 0; i < str.length; i++) {
          seed = (seed ^ str.charCodeAt(i)) * 16777619 >>> 0;
        }
        return () => {
          seed = (seed + 0x6D2B79F5) >>> 0;
          let t = seed;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
    
,
    _parseEmitter(e, scale, angle) {
        const name = e.name || 'boxrandom';
        return {
          name,
          // 官方 emitter 的 rate 默认 10 **仅在字段缺失时**填充
          // (wallpaper64.exe.c:324895-324918: 只在 FUN_140087490 返回"缺失"时写入
          //  0x4024000000000000 = 10.0), 显式 rate:0 必须保持 0 ——
          //  纯瞬时爆发型发射器 (官方 dino_run/particles/coinget.json: rate=0,
          //  instantaneous=10) 用 `|| 10` 会被错当成 10/s 连续发射。
          rate: e.rate != null ? e.rate : 10,
          instantaneous: e.instantaneous || 0,
          delay: e.delay || 0,
          duration: e.duration || 0,
          origin: parseVec3(e.origin, [0, 0, 0]),
          directions: parseVec3(e.directions, [1, 1, 0]),
          distanceMin: parseVec3(e.distancemin, [0, 0, 0]),
          distanceMax: parseVec3(e.distancemax, [256, 256, 0]),
          sign: parseVec3(e.sign, [0, 0, 0]).map((x) => (typeof x === 'number' ? x : 0)),
          speedMin: e.speedmin || 0,
          speedMax: e.speedmax || 0,
          cone: e.cone || 0,
          controlPoint: e.controlpoint != null ? e.controlpoint : -1, // 仅记录: rope/trail/控制点类发射器未实现 (本地库 0 使用)
          flags: e.flags || 0,
          scale, angle,
        };
      }
    
,
    _parseInitializer(i) {
        const name = i.name || '';
        return { name, params: i };
      }
    
,
    _parseOperator(op) {
        const name = op.name || '';
        return { name, params: op };
      }
    
,
    _simulateParticleSystem(sys, t) {
        // 引擎 starttime: 粒子系统从 starttime 后启动 (t < starttime → 无粒子)
        const st = sys.starttime || 0;
        // 从 0 开始模拟到 t-starttime (静态帧渲染: 一次性推进)
        if (sys._simulatedTo == null) sys._simulatedTo = 0;
        let simT = sys._simulatedTo;
        const target = Math.max(0, t - st);
        let guard = 0;
        while (simT < target && guard < 2000) {
          const dt = Math.min(0.05, target - simT);
          this._stepParticles(sys, dt, simT);
          simT += dt;
          guard++;
        }
        sys._simulatedTo = target;
      }
    
,
    _stepParticles(sys, dt, simT) {
        // 发射 (官方 CParticle::update:258-266: 先发射, 再 age += dt)
        for (const em of sys.emitters) {
          if (em.delay > 0 && simT < em.delay) continue;
          let toEmit = 0;
          if (em.instantaneous > 0 && !em._emitted) {
            toEmit = em.instantaneous;
            em._emitted = true;
          }
          sys.acc += dt * em.rate * sys.rateMul;
          toEmit += Math.floor(sys.acc);
          sys.acc -= Math.floor(sys.acc);
          const cap = em.flags & 2 ? 1 : toEmit;
          // 池门控: 官方 emitter 的 `count >= particles.size()` (:395/:461) —— count 是
          // **存活数**, 死亡压缩后回落 ⇒ 发射自动恢复。旧实现用单调递增的累计发射数
          // 门控, 池满后**永久停止发射** (长寿命系统永不回收 ⇒ 最后一批死后画面永久空白)。
          for (let k = 0; k < cap && sys.particles.length < sys.maxCount; k++) {
            const p = this._spawnParticle(sys, em);
            sys.particles.push(p);
            sys.count++;
            sys.emittedTotal++;
          }
        }
        // 更新
        for (const p of sys.particles) p.age += dt;
        for (const op of sys.operators) this._applyOperator(sys, op, dt, simT);
        // 移除死亡 (官方 :307-320: age >= lifetime 即死亡 → 按序压缩, 存活数回落)
        for (let i = sys.particles.length - 1; i >= 0; i--) {
          const p = sys.particles[i];
          if (!(p.age < p.lifetime)) {
            sys.particles.splice(i, 1);
            sys.count--;
          }
        }
      }
    
,
    _spawnParticle(sys, em) {
        // 官方语义 (第一手: we-shaders/genericparticle.vert gl_Position = mul(localPos,
        // g_ModelViewProjectionMatrix); ModelMatrix 由 CPU 组装 = T(origin)·R·S):
        //   世界 = 对象 origin + R(angle)·S(scale)·(emitter 原点 + 发射偏移)
        // 即: ① emitter 原点与发射偏移同属粒子局部空间, 必须先 S 后 R (旧实现只把
        //     偏移过 R, emitter 原点既没过 R 又被当成"对象原点"乘 S → 双重错误);
        //     ② 对象 origin 是平移项, **不参与 S/R**。
        // needZ: 仅当壁纸自带粒子着色器需要 v_Blur (源码里有 a_Position.z / worldPos.z) 时
        // 才抽取 z —— 这样其余粒子场景的 RNG 流与粒子布局一字不变 (改动面最小)。
        const needZ = !!(sys.shaderSpec && sys.shaderSpec.needsZ);
        let px, py, pz = 0;
        if (em.name === 'sphererandom') {
          const minR = em.distanceMin[0], maxR = em.distanceMax[0];
          if (needZ && (sys.sysFlags & 4) !== 0) {
            // 官方 3D 球壳 (lwe CParticle.cpp:596-611): 方向球面均匀 + 半径均匀体积 (cbrt)
            const theta = Math.random() * Math.PI * 2;
            const cosT = Math.random() * 2 - 1;
            const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
            const r = Math.cbrt(minR * minR * minR + Math.random() * (maxR * maxR * maxR - minR * minR * minR));
            px = sinT * Math.cos(theta) * r * em.directions[0];
            py = sinT * Math.sin(theta) * r * em.directions[1];
            pz = cosT * r * em.directions[2];
          } else {
            const angle = Math.random() * Math.PI * 2;
            const r = minR + Math.random() * (maxR - minR);
            px = Math.cos(angle) * r * em.directions[0];
            py = Math.sin(angle) * r * em.directions[1];
            // 官方 2D 圆盘分支仍带一个随机 z 偏移 U(-maxR, maxR) (lwe CParticle.cpp:589-592),
            // 它经 directions.z 缩放后成为 a_Position.z ⇒ 决定 particle.vert 的 v_Blur
            if (needZ) pz = (Math.random() * 2 - 1) * maxR * em.directions[2];
          }
        } else {
          // boxrandom: 每轴在 [distancemin, distancemax] 范围内随机距离 + 随机翻转符号
          // (官方 emitter 字段 distancemin/max 实测; min>max 时交换容错)
          // speedmin/max (发射初速) 与 sign (每轴符号) 语义未从官方确认 → 暂不实现
          const randRange = (a, b) => (Math.min(a, b) + Math.random() * Math.abs(b - a));
          const rx0 = randRange(em.distanceMin[0], em.distanceMax[0]);
          const ry0 = randRange(em.distanceMin[1], em.distanceMax[1]);
          px = (Math.random() < 0.5 ? -rx0 : rx0) * em.directions[0];
          py = (Math.random() < 0.5 ? -ry0 : ry0) * em.directions[1];
          if (needZ) {
            const rz0 = randRange(em.distanceMin[2], em.distanceMax[2]);
            pz = (Math.random() < 0.5 ? -rz0 : rz0) * em.directions[2];
          }
        }
        // 局部向量 (emitter 原点 + 发射偏移) → S → R (Y-flip 约定: R(-angle))
        const lx = (em.origin[0] + px) * em.scale[0];
        const ly = (em.origin[1] + py) * em.scale[1];
        const cos = Math.cos(-em.angle), sin = Math.sin(-em.angle);
        const rx = lx * cos - ly * sin;
        const ry = lx * sin + ly * cos;
        const wx = sys.origin[0] + rx;   // 世界 x (场景坐标)
        const wy = sys.origin[1] + ry;   // 世界 y (场景坐标, y 向上)
        // 局部 z (a_Position.z) 与经对象变换的 worldPos.z —— 只喂 particle.vert 的 v_Blur。
        // 对象变换在本渲染器里只有 Z 旋转 + 各轴缩放 (无 x/y 旋转耦合), 故 world z = origin.z + local z × scale.z
        const wz = (sys.origin[2] || 0) + pz * (sys.scale[2] != null ? sys.scale[2] : 1);
        const p = {
          // 画布像素 (y 向下) — 无正交投影 (ps=null) 时使用
          pos: [wx, this.H - wy, 0],
          // 绝对场景坐标 (y 向上) — 正交投影场景经 ps 映射
          scenePos: [wx, wy, 0],
          z: pz, worldZ: wz,
          vel: [0, 0, 0], angVel: 0, rot: 0,
          // 官方 emitter 出生态 (CParticle.cpp:494-500 与 :643-649):
          //   color=1×色覆盖, alpha=1×alpha覆盖, size=20×size覆盖, lifetime=1×寿命覆盖
          alpha: 1, size: 20 * sys.sizeMul, color: [1, 1, 1],
          lifetime: 1 * sys.lifetimeMul, age: 0, alive: true,
          oscAlpha: null, oscSize: null, oscPos: null,
        };
        for (const init of sys.initializers) this._applyInitializer(p, init, sys);
        return p;
      }
    
,
    _applyInitializer(p, init, sys) {
        const pr = init.params;
        // 注: 官方的 random 初始器还带 "exponent" 字段 (wallpaper64.exe.c:325498 的 JSON
        // 默认填充 = 1.0, 编译器把它存进粒子数据 :340081-340089; 独立实现
        // _refs/linux-wallpaperengine/CParticle.cpp:737 用 min + pow(t,exp)·(max-min))。
        // 本机语料里 dna_fragment(sizerandom exp=3) / small_motes(exp=2/6) 显式用到它,
        // 但"pow(t,exp) 还是 pow(t,1/exp)"没有第一手依据 (只有独立实现一侧), 且它会
        // 3× 缩小 dna_fragment 的粒子足迹 —— 属**未经证实就改变画面尺寸**, 故本次
        // 刻意不实施, 见 .test-cache/fix-particle-life.md 未决点 3 (含 A/B 数字)。
        switch (init.name) {
          case 'sizerandom': {
            const min = getVal(pr, 'min', 1), max = getVal(pr, 'max', 20);
            p.size = (min + Math.random() * (max - min)) * (sys ? sys.sizeMul : 1);
            p._initSize = p.size;
            break;
          }
          case 'alpharandom': {
            const min = getVal(pr, 'min', 0.05), max = getVal(pr, 'max', 1);
            p.alpha = min + Math.random() * (max - min);
            p._initAlpha = p.alpha;
            break;
          }
          case 'lifetimerandom': {
            // 官方 LifetimeRandomInitializer 写的是 **p.lifetime** (CParticle.cpp:755-765),
            // 与死亡判据 (isAlive: age < lifetime, :79) / getLifetimePos (:77) 同一字段。
            const min = getVal(pr, 'min', 0), max = getVal(pr, 'max', 1);
            p.lifetime = (min + Math.random() * (max - min)) * (sys ? sys.lifetimeMul : 1);
            break;
          }
          case 'velocityrandom': {
            const min = parseVec3(getVal(pr, 'min'), [-32, -32, -32]);
            const max = parseVec3(getVal(pr, 'max'), [32, 32, 32]);
            p.vel = [
              min[0] + Math.random() * (max[0] - min[0]),
              min[1] + Math.random() * (max[1] - min[1]),
              min[2] + Math.random() * (max[2] - min[2]),
            ];
            break;
          }
          case 'rotationrandom': {
            const min = parseVec3(getVal(pr, 'min'), [0, 0, 0]);
            const max = parseVec3(getVal(pr, 'max'), [0, 0, Math.PI * 2]);
            p.rot = min[2] + Math.random() * (max[2] - min[2]);
            break;
          }
          case 'angularvelocityrandom': {
            const min = parseVec3(getVal(pr, 'min'), [0, 0, -5]);
            const max = parseVec3(getVal(pr, 'max'), [0, 0, 5]);
            p.angVel = min[2] + Math.random() * (max[2] - min[2]);
            break;
          }
          case 'colorrandom': {
            const min = parseVec3(getVal(pr, 'min'), [0, 0, 0]);
            const max = parseVec3(getVal(pr, 'max'), [1, 1, 1]);
            // 引擎初始器值域 0-255, 着色器内归一化到 0..1 (v_Color.r 参与 mix)
            const k = (max[0] > 1 || max[1] > 1 || max[2] > 1 || min[0] > 1 || min[1] > 1 || min[2] > 1) ? 1 / 255 : 1;
            p.color = [
              (min[0] + Math.random() * (max[0] - min[0])) * k,
              (min[1] + Math.random() * (max[1] - min[1])) * k,
              (min[2] + Math.random() * (max[2] - min[2])) * k,
            ];
            break;
          }
        }
      }
    
,
    _applyOperator(sys, op, dt, t) {
        const pr = op.params;
        for (const p of sys.particles) {
          switch (op.name) {
            case 'movement': {
              const gravity = parseVec3(getVal(pr, 'gravity'), [0, 0, 0]);
              const drag = getVal(pr, 'drag', 0);
              p.pos[0] += p.vel[0] * dt;
              p.pos[1] += p.vel[1] * dt;
              p.vel[0] += gravity[0] * dt;
              p.vel[1] += -gravity[1] * dt; // Y flip
              const df = Math.max(0, 1 - drag * dt);
              p.vel[0] *= df; p.vel[1] *= df;
              if (p.scenePos) {
                // 场景坐标 (y 向上): x 同向, y 与画布 y-down 反向
                p.scenePos[0] += p.vel[0] * dt;
                p.scenePos[1] += -p.vel[1] * dt;
              }
              break;
            }
            case 'angularmovement': {
              const force = parseVec3(getVal(pr, 'force'), [0, 0, 0]);
              const drag = getVal(pr, 'drag', 0);
              p.rot += p.angVel * dt;
              p.angVel += force[2] * dt;
              p.angVel *= Math.max(0, 1 - drag * dt);
              break;
            }
            case 'alphafade': {
              const fadeIn = getVal(pr, 'fadeintime', 0.5);
              const fadeOut = getVal(pr, 'fadeouttime', 0.5);
              const lifePos = this._lifePos(p);   // 官方 getLifetimePos (权威字段 = lifetime)
              const base = p._initAlpha ?? 1;
              // 原生: fade = fadeValue(life, 0, fadeIn, 0, 1) = smoothstep
              let fade;
              if (lifePos <= fadeIn) {
                const tt = fadeIn > 0 ? Math.min(1, Math.max(0, lifePos / fadeIn)) : 1;
                fade = tt * tt * (3 - 2 * tt);
              } else if (lifePos > fadeOut) {
                const tt = 1 - fadeOut > 0 ? Math.min(1, Math.max(0, (lifePos - fadeOut) / (1 - fadeOut))) : 1;
                fade = 1 - tt * tt * (3 - 2 * tt);
              } else fade = 1;
              p.alpha = base * fade;
              // 原生每帧刷新振荡器基数 (oscillateAlpha 与 alphafade 组合的关键)
              if (p.oscAlpha) p.oscAlpha.base = p.alpha;
              break;
            }
            case 'sizechange': {
              const st = getVal(pr, 'starttime', 0), et = getVal(pr, 'endtime', 1);
              const sv = getVal(pr, 'startvalue', 1), ev = getVal(pr, 'endvalue', 0);
              const lifePos = this._lifePos(p);   // 官方 getLifetimePos (权威字段 = lifetime)
              const t01 = et > st ? Math.max(0, Math.min(1, (lifePos - st) / (et - st))) : 1;
              const tt = t01 * t01 * (3 - 2 * t01);
              p.size = (p._initSize ?? 20) * (sv + (ev - sv) * tt);
              if (p.oscSize) p.oscSize.base = p.size;
              break;
            }
            case 'alphachange': {
              const st = getVal(pr, 'starttime', 0), et = getVal(pr, 'endtime', 1);
              const sv = getVal(pr, 'startvalue', 1), ev = getVal(pr, 'endvalue', 0);
              const lifePos = this._lifePos(p);   // 官方 getLifetimePos (权威字段 = lifetime)
              const t01 = et > st ? Math.max(0, Math.min(1, (lifePos - st) / (et - st))) : 1;
              const tt = t01 * t01 * (3 - 2 * t01);
              p.alpha = (p._initAlpha ?? 1) * (sv + (ev - sv) * tt);
              if (p.oscAlpha) p.oscAlpha.base = p.alpha;
              break;
            }
            case 'turbulence': {
              const scale = getVal(pr, 'scale', 0.005);
              const speedMin = getVal(pr, 'speedmin', 500), speedMax = getVal(pr, 'speedmax', 1000);
              const mask = parseVec3(getVal(pr, 'mask'), [1, 1, 0]);
              const sp = speedMin + Math.random() * (speedMax - speedMin);
              const phase = Math.random() * Math.PI * 2;
              const nx = Math.sin(p.pos[0] * scale * 2 + phase + t * 0.1);
              const ny = Math.sin(p.pos[1] * scale * 2 + phase + t * 0.13);
              p.vel[0] += nx * sp * dt * mask[0];
              p.vel[1] += ny * sp * dt * mask[1];
              break;
            }
            case 'oscillatealpha': {
              const fMin = getVal(pr, 'frequencymin', 0), fMax = getVal(pr, 'frequencymax', 10);
              const sMin = getVal(pr, 'scalemin', 0), sMax = getVal(pr, 'scalemax', 1);
              if (!p.oscAlpha) {
                p.oscAlpha = { f: fMin + Math.random() * (fMax - fMin), ph: Math.random() * Math.PI * 2, base: p.alpha };
              }
              const cosVal = (Math.cos(p.oscAlpha.f * p.age + p.oscAlpha.ph) + 1) * 0.5;
              p.alpha = p.oscAlpha.base * (sMin + (sMax - sMin) * cosVal);
              break;
            }
            case 'oscillatesize': {
              const fMin = getVal(pr, 'frequencymin', 0), fMax = getVal(pr, 'frequencymax', 10);
              const sMin = getVal(pr, 'scalemin', 0.8), sMax = getVal(pr, 'scalemax', 1.2);
              if (!p.oscSize) {
                p.oscSize = { f: fMin + Math.random() * (fMax - fMin), ph: Math.random() * Math.PI * 2, base: p.size };
              }
              const cosVal = (Math.cos(p.oscSize.f * p.age + p.oscSize.ph) + 1) * 0.5;
              p.size = p.oscSize.base * (sMin + (sMax - sMin) * cosVal);
              break;
            }
            case 'oscillateposition': {
              const fMin = getVal(pr, 'frequencymin', 0), fMax = getVal(pr, 'frequencymax', 5);
              const sMin = getVal(pr, 'scalemin', 0), sMax = getVal(pr, 'scalemax', 10);
              const mask = parseVec3(getVal(pr, 'mask'), [1, 1, 0]);
              if (!p.oscPos) {
                p.oscPos = {
                  f: [0, 0, 0].map(() => fMin + Math.random() * (fMax - fMin)),
                  ph: [0, 0, 0].map(() => Math.random() * Math.PI * 2),
                  sc: [0, 0, 0].map(() => sMin + Math.random() * (sMax - sMin)),
                };
              }
              for (let a = 0; a < 2; a++) {
                const w = 2 * Math.PI * p.oscPos.f[a] / (2 * Math.PI);
                const move = -p.oscPos.sc[a] * w * Math.sin(w * p.age + p.oscPos.ph[a]) * dt;
                p.pos[a] += move * mask[a];
                if (p.scenePos) p.scenePos[a] += (a === 0 ? move : -move) * mask[a];
              }
              break;
            }
          }
        }
      }
    
,
    _drawParticles(sys) {
        const tex = sys.tex;
        const alphaMul = sys.alphaMul;
        const W = this.W, H = this.H;
        const canvas = this.canvas;
        const additive = sys.blending === 'additive';
        // ── 加性通道: HDR 浮点累积 (仅引擎真 HDR 链场景; 见 _hdrAdditive 的门控依据) ──
        // 命中门控的场景走 HDR 管线: 加性片元写进 HDR 缓冲, 浮点累加**不逐片元裁剪**,
        // 链尾 combine_hdr.frag:40-44 才 `saturate(lin(albedo)) × 曝光` 并 linear→sRGB 编码
        // (见 canvas.js 的 addLight/additiveCommit)。未命中 (本机语料全部) 走 LDR 链
        // (combine.frag:10-15 无 lin/曝光/编码 → 8bit 显示目标) ⇒ 保持逐片元硬裁剪,
        // 与原生一致 (原生在此链下同样饱和)。
        const hdrAdd = additive && this._hdrAdditive();
        if (hdrAdd) canvas.additiveEnable();
        // ── 壁纸自带粒子着色器 (数据驱动; 见 parseWallpaperParticleShader 的注释) ──
        const spec = sys.shaderSpec;
        const combos = sys.combos || {};
        const useWorldblur = !!combos.WORLDBLUR;
        const texInterp = sys.texInterp !== false;
        const texClamp = sys.texClamp === true;
        // 官方 particle.vert:117 `v_Color.a *= 0.5` (只有壁纸自带 particle 着色器有;
        // 内建 genericparticle.vert:112 是 `v_Color = a_Color` 无衰减 ⇒ alphaFactor = 1)
        const alphaFactor = spec ? spec.alphaFactor : 1;
        // 官方 particle.vert:118 `v_Color.rgb = mix(g_Color1, g_Color2, v_Color.r)` 只在
        // 壁纸自带着色器里; 内建 genericparticle 无此式 (但本仓库历史行为恒做恒等 mix,
        // 语料里只有 shimmering 的粒子材质绑 color1/color2 ⇒ 两种写法当前同像素)
        const useColorBlend = spec ? spec.userColorBlend !== false : true;
        // 原生 genericparticle.vert: v_Color.a *= 0.5; v_Color.rgb = mix(color1, color2, v_Color.r)
        // (USERCOLORBLEND); 正交场景按投影缩放场景单位→像素
        const ps = sys.projScale;
        // 透视场景 (无 general.orthogonalprojection): 官方 genericparticle.vert:88-89
        // 把粒子中心与尺寸一并过 MVP (gl_Position = mul(vec4(position,1), MVP),
        // position 已含 size 偏移, common_particles.h:54-59) —— 本渲染器必须用与
        // model.js 同一条 camVP 投影。旧实现只在正交场景映射, 其余情况把世界坐标
        // (场景单位, ±O(1)~O(100)) 直接当画布像素 ⇒ 透视场景 (dna_fragment) 粒子
        // 全部越界、0 像素产出 (取证: .test-cache/audit-zero-contribution.md §2)。
        const camVP = this.camVP || null;
        const camProj = this.camProj || null;
        for (const p of sys.particles) {
          const lifePos = this._lifePos(p);   // 官方 getLifetimePos (权威字段 = lifetime)
          if (lifePos >= 1) continue;
          // 官方 particle.vert:116-118: v_Color = a_Color; v_Color.a *= 0.5; rgb = mix(c1,c2,v_Color.r)
          // 内建 genericparticle.vert:112 没有 0.5 衰减, 故 alphaFactor 只对壁纸自带着色器生效。
          const a = Math.max(0, p.alpha) * alphaMul * alphaFactor;
          if (a <= 0.002) continue;
          // v_Blur (仅壁纸自带着色器需要): local z = a_Position.z, world z = worldPos.z
          const vBlur = spec ? wallpaperParticleBlur(spec, useWorldblur, p.z || 0, p.worldZ || 0) : 0;
          // 官方 genericparticle.vert: textureRatio = g_Texture0Resolution.y / x,
          // ComputeParticlePosition: up×(v-0.5)×textureRatio — 垂直尺寸乘纹理纵横比
          // (高/宽)。旧实现忽略 ratio → 非正方形粒子纹理 (流星 256×794/drop 32×128
          // 等 12 个) 被拉伸成正方形 (sf39g)。
          const ratio = tex && tex.width > 0 ? tex.height / tex.width : 1;
          let x, y, halfX, halfY;
          if (ps) {
            // 正交场景: 既有的场景单位→像素映射 (语义保持不变)
            const sz = Math.max(0.5, p.size);
            x = p.scenePos ? p.scenePos[0] * ps[0] : p.pos[0] * ps[0];
            y = p.scenePos ? this.H - p.scenePos[1] * ps[1] : p.pos[1] * ps[1];
            halfX = (sz * ps[0]) / 2;
            halfY = ((sz * ps[1]) / 2) * ratio;
          } else if (camVP && camProj) {
            // 透视场景: camVP 投影 + 透视除法 (mat4TransformPoint 已除 w,
            // 返回 [ndcX, ndcY, ndcZ, w], 与 model.js:88-92 同一口径)
            const sp = p.scenePos || [p.pos[0], this.H - p.pos[1], 0];
            const clip = mat4TransformPoint(camVP, [sp[0], sp[1], 0]);
            if (!(clip[3] > 0)) continue; // 相机背面 (GPU 会剪裁): 不绘制
            x = (clip[0] * 0.5 + 0.5) * this.W;
            y = (0.5 - clip[1] * 0.5) * this.H;
            // 世界尺寸→像素: 视深度 clip[3] 处, 单位世界长度跨 NDC = proj[5]/w,
            // NDC→像素 = ×H/2。proj[5]=f (透视) / 2/高度 (正交, 与 ps[1] 同量级)。
            // 钳制只作用于**投影后**的像素值 (世界尺寸钳制无意义, 会退化成 0.5px 方块)。
            const pxSize = Math.max(0.5, (p.size * Math.abs(camProj[5]) * this.H) / (2 * Math.abs(clip[3])));
            halfX = pxSize / 2;
            halfY = halfX * ratio;
          } else {
            // 无相机矩阵 (未走 setupCameraMatrices 的极简调用): 保持旧行为
            const sz = Math.max(0.5, p.size);
            x = p.pos[0];
            y = p.pos[1];
            halfX = sz / 2;
            halfY = (sz / 2) * ratio;
          }
          if (tex) {
            // 官方 genericparticle.vert SPRITESHEET: currentFrame = floor(lifetime×numFrames),
            // 采样对应帧区域 (TEXS 帧元数据 x/y/width/height)。旧实现无 SPRITESHEET
            // → 精灵表粒子 (notes_sprite_sheet 41帧 等) 显示整张表 (sf39g)。
            let frameUV = null;
            if (tex.frames && tex.frames.count > 1 && tex.frames.items) {
              const fr = tex.frames;
              const lt = this._lifePos(p);
              const idx = Math.min(fr.count - 1, Math.floor(lt * fr.count));
              const f = fr.items[idx];
              if (f) frameUV = { x: f.x, y: f.y, w: f.width || fr.count > 0 ? Math.floor(tex.width / fr.count) : tex.width, h: f.height || tex.height };
            }
            const tw = tex.width, th = tex.height;
            const colorR = useColorBlend ? sys.color1[0] + (sys.color2[0] - sys.color1[0]) * p.color[0] : p.color[0];
            const colorG = useColorBlend ? sys.color1[1] + (sys.color2[1] - sys.color1[1]) * p.color[0] : p.color[1];
            const colorB = useColorBlend ? sys.color1[2] + (sys.color2[2] - sys.color1[2]) * p.color[0] : p.color[2];
            // HDR 加性通道: 线性光 LUT (按纹理 red 的 8bit 量化值索引; 采样为双线性时按小数部分插值)
            //   c = color × alpha × albedo, 线性光 L = lin(c) (官方 lin, combine_hdr.frag:12-16)
            // **产品级解码** (对 c 整体解码, 而不是逐因子解码) 的选择依据: 单层像素因此
            // toSrgb(lin(c)) ≡ c 逐字节保持原值, 改动只发生在"多层叠加被裁剪"的区域 ——
            // 另两种口径 (因子级 lin(color)·α·lin(tex) 与"颜色视作线性 color·α·lin(tex)")
            // 的实测对照见 .test-cache/fix-hdr-accum.md §5.1: 前者 t=60 结构明显更弱,
            // 后者 t=60 仍近乎糊 (唯一色低于修前), 故均未采用。
            const kR = colorR * a, kG = colorG * a, kB = colorB * a;
            if (hdrAdd) {
              for (let t8i = 0; t8i < 256; t8i++) {
                const tv = t8i / 255;
                _addLut[t8i] = linLight(kR * tv);
                _addLut[256 + t8i] = linLight(kG * tv);
                _addLut[512 + t8i] = linLight(kB * tv);
              }
            }
            const x0 = Math.floor(x - halfX), y0 = Math.floor(y - halfY);
            const x1 = Math.ceil(x + halfX), y1 = Math.ceil(y + halfY);
            // 采样器口径 (与导出函数 sampleTexRed 同一数学; 逐像素内联 + y 抽头按行提出:
            // 热路径上每像素只做 4 次读 + 3 次 lerp, 避免逐像素函数调用/分支):
            //   LINEAR = texel 中心双线性 (引擎默认); NEAREST = floor(u*W) (nointerpolation)
            //   REPEAT = GL 默认地址模式; CLAMP = sidecar `clampuvs`
            const pxRgba = tex.rgba;
            for (let py = y0; py <= y1; py++) {
              if (py < 0 || py >= H) continue;
              const ny = (py - y) / halfY;
              if (ny < -1 || ny > 1) continue;
              const v = (ny + 1) / 2;
              const tvv = frameUV ? (frameUV.y / th + v * (frameUV.h / th)) : v;
              let yN;                                 // NEAREST: 行起点像素索引
              let rowA = 0, rowB = 0, tyRow = 0;      // LINEAR: 两行 texel 起点 + 行间权重
              if (texInterp) {
                let yy;
                if (texClamp) yy = tvv < 0 ? 0 : (tvv > 0.999999 ? 0.999999 : tvv);
                else yy = tvv - Math.floor(tvv);
                const fy = yy * th - 0.5;
                const iy0 = Math.max(0, Math.min(th - 1, Math.floor(fy)));
                const iy1 = Math.min(th - 1, iy0 + 1);
                tyRow = fy - iy0;
                rowA = iy0 * tw; rowB = iy1 * tw;
              } else {
                let yy;
                if (texClamp) yy = tvv < 0 ? 0 : (tvv > 0.999999 ? 0.999999 : tvv);
                else yy = tvv - Math.floor(tvv);
                yN = Math.min(th - 1, Math.max(0, Math.floor(yy * th))) * tw;
              }
              for (let px = x0; px <= x1; px++) {
                if (px < 0 || px >= W) continue;
                const nx = (px - x) / halfX;
                if (nx < -1 || nx > 1) continue;
                const u = (nx + 1) / 2;
                const tuu = frameUV ? (frameUV.x / tw + u * (frameUV.w / tw)) : u;
                let red;
                if (texInterp) {
                  let xx;
                  if (texClamp) xx = tuu < 0 ? 0 : (tuu > 0.999999 ? 0.999999 : tuu);
                  else xx = tuu - Math.floor(tuu);
                  const fx = xx * tw - 0.5;
                  const ix0 = Math.max(0, Math.min(tw - 1, Math.floor(fx)));
                  const ix1 = Math.min(tw - 1, ix0 + 1);
                  const tx = fx - ix0;
                  const a0 = pxRgba[(rowA + ix0) * 4], a1 = pxRgba[(rowA + ix1) * 4];
                  const b0 = pxRgba[(rowB + ix0) * 4], b1 = pxRgba[(rowB + ix1) * 4];
                  const top = a0 * (1 - tx) + a1 * tx;
                  const bot = b0 * (1 - tx) + b1 * tx;
                  red = (top * (1 - tyRow) + bot * tyRow) / 255;
                } else {
                  let xx;
                  if (texClamp) xx = tuu < 0 ? 0 : (tuu > 0.999999 ? 0.999999 : tuu);
                  else xx = tuu - Math.floor(tuu);
                  const ix = Math.min(tw - 1, Math.max(0, Math.floor(xx * tw)));
                  red = pxRgba[(yN + ix) * 4] / 255;
                }
                // 片元形状 albedo: 壁纸自带 particle.frag:11-22 有 smoothstep 阈值;
                // 内建 genericparticle.frag:82 直接 `v_Color * tex` ⇒ albedo = red
                const albedo = spec ? wallpaperParticleAlbedo(spec, useWorldblur, red, vBlur) : red;
                if (!(albedo > 1 / 255)) continue;   // 对应旧判据 texR <= 0.004
                // 官方混合 = additive (SRC_ALPHA, ONE) / translucent (SRC_ALPHA, INV_SRC_ALPHA)
                //   (lwe Effects/CPass.cpp:130-137), 片元输出 = v_Color × tex (内建) 或
                //   v_Color × albedo (壁纸自带 particle.frag:22 的**标量** albedo 同时乘 rgb 与 a)
                //   ⇒ srcA = a × albedo, src.rgb = color × (壁纸路径再乘一次 albedo)
                const a2 = a * albedo;
                const rgbScale = spec ? albedo : 1;
                const di = (py * W + px) * 4;
                const sr = colorR * rgbScale * a2 * 255, sg = colorG * rgbScale * a2 * 255, sb = colorB * rgbScale * a2 * 255;
                if (hdrAdd) {
                  // HDR 加性: 浮点线性光累加 (不裁剪); 链尾 additiveCommit() 统一
                  // saturate ×曝光 + linear→sRGB 编码写回 8bit 画布
                  const rf = red * 255;
                  const i0 = rf >= 255 ? 255 : rf | 0, fr = rf - i0, i1 = i0 < 255 ? i0 + 1 : 255;
                  canvas.addLight(px, py,
                    _addLut[i0] + (_addLut[i1] - _addLut[i0]) * fr,
                    _addLut[256 + i0] + (_addLut[256 + i1] - _addLut[256 + i0]) * fr,
                    _addLut[512 + i0] + (_addLut[512 + i1] - _addLut[512 + i0]) * fr);
                  continue;
                }
                if (additive) {
                  // additive (LDR 管线): dst += src.rgb*src.a (clamp) — 原生同链同样饱和
                  canvas.data[di] = Math.min(255, canvas.data[di] + sr);
                  canvas.data[di + 1] = Math.min(255, canvas.data[di + 1] + sg);
                  canvas.data[di + 2] = Math.min(255, canvas.data[di + 2] + sb);
                  canvas.data[di + 3] = 255;
                } else {
                  const dstA = canvas.data[di + 3] / 255;
                  const outA = a2 + dstA * (1 - a2);
                  if (outA <= 0) continue;
                  canvas.data[di] = Math.round((sr + canvas.data[di] * dstA * (1 - a2)) / outA);
                  canvas.data[di + 1] = Math.round((sg + canvas.data[di + 1] * dstA * (1 - a2)) / outA);
                  canvas.data[di + 2] = Math.round((sb + canvas.data[di + 2] * dstA * (1 - a2)) / outA);
                  canvas.data[di + 3] = Math.round(outA * 255);
                }
              }
            }
          } else {
            // 无纹理: 圆形占位 (additive)
            const r = Math.max(1, (halfX + halfY) / 2);
            // HDR 加性: 贡献是灰度 a ⇒ 线性光 = lin(a) (逐粒子常量, 循环外算一次)
            const linA = hdrAdd ? linLight(a) : 0;
            for (let py = Math.floor(y - r); py <= Math.ceil(y + r); py++) {
              for (let px = Math.floor(x - r); px <= Math.ceil(x + r); px++) {
                if (px < 0 || py < 0 || px >= W || py >= H) continue;
                if ((px - x) ** 2 + (py - y) ** 2 > r * r) continue;
                const di = (py * W + px) * 4;
                const sr = a * 255;
                if (hdrAdd) {
                  canvas.addLight(px, py, linA, linA, linA);
                } else if (additive) {
                  canvas.data[di] = Math.min(255, canvas.data[di] + sr);
                  canvas.data[di + 1] = Math.min(255, canvas.data[di + 1] + sr);
                  canvas.data[di + 2] = Math.min(255, canvas.data[di + 2] + sr);
                  canvas.data[di + 3] = 255;
                } else {
                  const dstA = canvas.data[di + 3] / 255;
                  const outA = a + dstA * (1 - a);
                  canvas.data[di] = Math.round((sr + canvas.data[di] * dstA * (1 - a)) / outA);
                  canvas.data[di + 1] = Math.round((sr + canvas.data[di + 1] * dstA * (1 - a)) / outA);
                  canvas.data[di + 2] = Math.round((sr + canvas.data[di + 2] * dstA * (1 - a)) / outA);
                  canvas.data[di + 3] = Math.round(outA * 255);
                }
              }
            }
          }
        }
        // 链尾: 官方 combine_hdr.frag 的 saturate(lin(albedo))×曝光 + linear→sRGB 编码。
        // 本渲染器的链尾在 core.js render() 内 (不可改), 故在本次加性绘制的末尾提交;
        // commit 是**增量**的 (addE 记录已写入的光), 多次 commit 不会重复叠加。
        if (hdrAdd) canvas.additiveCommit();
      }
  });
}
