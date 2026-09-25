// ══════════════════════════════════════════════════════════════════════════
// WE 数据驱动材质着色器解释器 (顶点程序 + 片元程序)
//
// 用户方向: **渲染行为由壁纸自带的文件决定** —— 不按 shader 名写 CPU 移植。本模块把
// 容器里的 `shaders/<name>.{vert,frag}` 编译成 JS, 接到 model.js 既有的光栅化器上:
//   · 顶点阶段: 每个顶点跑官方 vert 程序 (attribute 来自 MDL 顶点流, uniform 来自材质 +
//     引擎注入), 得到 gl_Position 与各 varying;
//   · 光栅化:   复用 `_rasterizeMesh3D` 的 z-buffer / 透视校正插值 / blend / depth 状态,
//     varying 走它既有的 "自定义 varying 块" (varBase/varCount) 通道;
//   · 片元阶段: 每像素把插值后的 varying 写进 __v, 跑官方 frag 程序, 取 gl_FragColor。
//
// **一切输入都来自壁纸文件本身**:
//   shader 源码   ← pkg.readText('shaders/<name>.frag|vert')  (缺失才回退引擎资产目录)
//   #include      ← pkg 内 shaders/<inc>, 再回退 weAssetsDir/assets/shaders
//   combos        ← pass.combos ∪ shader 内 [COMBO] 默认值 ∪ 纹理槽派生的 *_MAP/combo
//   材质常数      ← pass.constantshadervalues ∪ pass.usershadervalues (经 uniform 元注释
//                   的 "material" 字段映射) ∪ uniform 元注释 default
//   纹理槽        ← pass.textures[i] → g_Texture{i} (含 _rt_* 渲染目标)
//   顶点属性      ← MDL 顶点流 (a_Position/a_Normal/a_TexCoord/a_TexCoordVec4/a_Tangent4)
//   引擎 uniform  ← 场景/相机/灯/屏幕尺寸 (见 engineUniforms; 名字全部取自 shader 自身)
//   渲染状态      ← pass.blending / depthwrite (调用方读取, 不在此模块内硬编码)
//
// 失败**可诊断**: 每个失败点返回 reason 字符串 (缺哪个语法点/attribute/uniform), 由调用方
// 经既有 onDegraded 通道记录 (生产落 gpu-diag)。
// ══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { compileGlsl } from './executor.js';
import { expandIncludes, parseMeta, renameReservedSample } from './preprocess.js';
import { runtimeObject, DISCARD } from './runtime.js';

// ── 编译缓存 (模块级, 跨渲染器实例; key = shader + combos + 源码位置) ─────────
const CACHE_MAX = 32;
const _compileCache = new Map();
const _includeCache = new Map();
export function materialCacheStats() {
  return { compile: _compileCache.size, include: _includeCache.size };
}

const ATTR_LEN = {
  vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4,
  uvec2: 2, uvec3: 3, uvec4: 4, bvec2: 2, bvec3: 3, bvec4: 4,
  float: 1, int: 1, uint: 1, bool: 1,
};
const MAT4_ID = () => { const a = new Float32Array(16); for (let i = 0; i < 4; i++) a[i * 4 + i] = 1; return a; };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// 未绑定纹理槽的替身: 1×1 白。WE 引擎对未赋值 sampler 的缺省是 util/white, 且插件
// 自身的 _texSample(null) 也返回 [1,1,1,1]; runtime.makeTexSample 对 null 返回
// [0,0,0,0] (黑) ⇒ 若直接让槽位为 null, 官方 shader 里"缺图即不着色"的层会整体变黑。
const WHITE_TEX = { width: 1, height: 1, rgba: Uint8Array.from([255, 255, 255, 255]), format: 0 };
// `_rt_*` 渲染目标的 V 翻转 (平台约定; 见 bindMaterialProgram 内注释)。
// 消融开关: DSH_WE_MAT_RTFLIP=0 关闭, 用于 A/B 取证。
const RT_FLIP_V = process.env.DSH_WE_MAT_RTFLIP !== '0';

// ── 源码解析 (壁纸容器优先) ─────────────────────────────────────────────────
/**
 * 读材质 shader 源码。解析顺序 (与引擎一致: 项目 shaders/ 覆盖引擎资产):
 *   ① pkg 内 `shaders/<name>.frag` (workshop scene.pkg / 松散目录)
 *   ② weAssetsDir/assets/shaders/<name>.frag (defaultprojects 不自带 shader 时)
 */
export function readWallpaperShader(pkg, name, weAssetsDir) {
  const readText = (p) => {
    try { return (pkg && pkg.readText ? pkg.readText(p) : null) || null; } catch { return null; }
  };
  let frag = readText('shaders/' + name + '.frag');
  let fragAt = frag ? 'shaders/' + name + '.frag' : null;
  let vert = readText('shaders/' + name + '.vert');
  let vertAt = vert ? 'shaders/' + name + '.vert' : null;
  if ((!frag || !vert) && weAssetsDir) {
    const dir = path.join(weAssetsDir, 'assets', 'shaders');
    if (!frag) {
      const p = path.join(dir, name + '.frag');
      try { const t = fs.readFileSync(p, 'utf8'); if (t) { frag = t; fragAt = p; } } catch { /* none */ }
    }
    if (!vert) {
      const p = path.join(dir, name + '.vert');
      try { const t = fs.readFileSync(p, 'utf8'); if (t) { vert = t; vertAt = p; } } catch { /* none */ }
    }
  }
  return { frag, vert, fragAt, vertAt };
}

/** #include 解析: 先容器 `shaders/<inc>`, 再引擎资产目录。进程级 memoize。
 *  `log` (可选) 记录每条 include 的解析结果 —— 供"解释器到底解析了什么"取证。 */
function makeIncludeResolver(pkg, weAssetsDir, log) {
  const memo = new Map();
  return (inc) => {
    if (memo.has(inc)) {
      if (log) log.push({ include: inc, found: memo.get(inc) ? 'cache' : 'MISSING' });
      return memo.get(inc);
    }
    let out = '';
    let from = null;
    try {
      const t = pkg && pkg.readText ? pkg.readText('shaders/' + inc) : null;
      if (t) { out = t; from = 'pkg:shaders/' + inc; }
    } catch { out = ''; }
    if (!out && weAssetsDir) {
      const p = path.join(weAssetsDir, 'assets', 'shaders', inc);
      let rec = _includeCache.get(p);
      if (rec === undefined) {
        rec = null;
        try { if (fs.existsSync(p)) rec = fs.readFileSync(p, 'utf8'); } catch { /* none */ }
        _includeCache.set(p, rec);
      }
      if (rec !== null) { out = rec; from = 'assets:shaders/' + inc; }
    }
    if (log) log.push({ include: inc, found: out ? from + ' (' + out.length + 'B)' : 'MISSING' });
    memo.set(inc, out);
    return out;
  };
}

// `#require <Feature>` 指令清单 (WE 引擎特性门)。**纯取证**: 引擎用它挂载内置函数库
// (LightingV1/V2 提供 PerformLighting_V1 / CASTF 等, 源码不在任何 .h 里); 解释器只能
// 删掉该行 —— 若该 shader 真用到那些函数, 转译后会报 "X is not defined" 而整条通路拒绝。
export function scanRequires(expandedSrc) {
  const out = [];
  const re = /^[ \t]*#require\s+(\S+)/gm;
  let m;
  while ((m = re.exec(expandedSrc))) out.push(m[1]);
  return out;
}

// ── combos ────────────────────────────────────────────────────────────────
/**
 * 组装 combos (全部来自壁纸文件):
 *   · shader 内 `// [COMBO] {...}` 的 default                  → 基础值
 *   · pass.combos                                              → 覆盖 (WE combo 名大小写
 *     不敏感: 材质写 `lightmap`, shader 用 `#if LIGHTMAP`)
 *   · uniform 元注释带 combo 的 sampler2D                       → 绑定即 1, 未绑定即 0
 *   · TEX0FORMAT/TEX1FORMAT                                    → 纹理实际格式
 *     (common_fragment.h DecompressNormal 按它选通道; 官方也是引擎烘焙的 combo)
 */
export function combosForPass(pass, meta, textures) {
  const out = {};
  const up = (k) => String(k).toUpperCase();
  for (const [k, v] of Object.entries((meta && meta.combos) || {})) {
    out[up(k)] = String(v && v.default !== undefined ? v.default : 0);
  }
  const explicit = {};
  for (const [k, v] of Object.entries((pass && pass.combos) || {})) {
    out[up(k)] = String(v);
    explicit[up(k)] = true;
  }
  for (const [un, info] of Object.entries((meta && meta.uniforms) || {})) {
    if (!info || !info.combo) continue;
    const c = up(info.combo);
    if (explicit[c]) continue;
    const mm = /^g_Texture(\d+)$/.exec(un);
    if (!mm) continue;
    out[c] = textures && textures[Number(mm[1])] ? '1' : '0';
  }
  const fmt = (i) => {
    const tt = textures && textures[i];
    return tt && Number.isFinite(tt.format) ? String(tt.format) : null;
  };
  const f0 = fmt(0), f1 = fmt(1);
  if (f0 !== null && !explicit.TEX0FORMAT) out.TEX0FORMAT = f0;
  if (f1 !== null && !explicit.TEX1FORMAT) out.TEX1FORMAT = f1;
  return out;
}

/** meta = 展开 include 后的 frag+vert 元注释合并 (combos 默认值 + uniform material 映射) */
export function materialMeta(pkg, weAssetsDir, shaderName) {
  const src = readWallpaperShader(pkg, shaderName, weAssetsDir);
  if (!src.frag) return { src, meta: { combos: {}, uniforms: {} }, rinc: makeIncludeResolver(pkg, weAssetsDir) };
  const rinc = makeIncludeResolver(pkg, weAssetsDir);
  let meta = { combos: {}, uniforms: {} };
  try {
    const mf = parseMeta(expandIncludes(src.frag, rinc));
    let mv = { combos: {}, uniforms: {} };
    if (src.vert) mv = parseMeta(expandIncludes(src.vert, rinc));
    meta = { combos: { ...mv.combos, ...mf.combos }, uniforms: { ...mv.uniforms, ...mf.uniforms } };
  } catch { /* compile 阶段会报具体原因 */ }
  return { src, meta, rinc };
}

/** 转 3×3 法线矩阵 = 模型矩阵左上 3×3 的逆转置 (列主序 flat 9) */
function normalMatrix3(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const q = 1 / det;
  // inverse(列主序) 的转置 = 余子式矩阵 / det, 余子式直接按列主序写即转置
  return Float32Array.from([
    A * q, B * q, C * q,
    -(b * i - c * h) * q, (a * i - c * g) * q, -(a * h - b * g) * q,
    (b * f - c * e) * q, -(a * f - c * d) * q, (a * e - b * d) * q,
  ]);
}

/**
 * 引擎 uniform 注入 — 名字全部取自 shader 自身, 值来自场景/相机/渲染目标:
 *   矩阵   ← 对象变换 (worldM) + 相机 (camVP)
 *   光照   ← scene.general.ambientcolor/skylightcolor + objects[].light
 *   屏幕   ← 渲染目标尺寸 (W/H)
 */
export function engineUniforms(r, worldM, extra) {
  const W = r.W, H = r.H;
  const lights = r.lights || [];
  const pos = [], cr = [], premul = [];
  for (let i = 0; i < 4; i++) {
    const L = lights[i];
    const col = L ? L.color : [0, 0, 0];
    const inten = L ? (L.intensity != null ? L.intensity : 1) : 0;
    const rad = L ? (L.radius != null ? L.radius : 0) : 0;
    pos.push(Float32Array.from(L ? L.origin : [0, 0, 0]));
    cr.push(Float32Array.from([col[0] * inten, col[1] * inten, col[2] * inten, rad]));
    // g_LightsColorPremultiplied: WE 的 PBR 光色预乘项 (common_pbr.h ComputePBRLight)。
    // ⚠ 官方预乘系数无源码取证 ⇒ 取 color·intensity (与 g_LightsColorRadius.rgb 同值);
    //   只影响 LIGHTING=1 的 PBR 分支, 已记入报告未决点。
    premul.push(Float32Array.from([col[0] * inten, col[1] * inten, col[2] * inten, rad]));
  }
  const eye = r.camEye || [0, 0, 0];
  const vp = r.camVP || MAT4_ID();
  const model = worldM || MAT4_ID();
  const mvp = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += vp[k * 4 + row] * model[c * 4 + k];
      mvp[c * 4 + row] = s;
    }
  }
  const u = {
    g_Time: extra && extra.t != null ? extra.t : 0,
    g_Alpha: 1, g_UserAlpha: 1, g_Brightness: 1, g_Opacity: 1,
    g_Color: Float32Array.from([1, 1, 1]), g_Color4: Float32Array.from([1, 1, 1, 1]),
    g_TintColor: Float32Array.from([1, 1, 1]), g_Multiply: 1, g_AlphaMultiply: 1,
    g_ModelMatrix: model, g_ViewProjectionMatrix: vp,
    g_ModelViewProjectionMatrix: mvp,
    g_ModelMatrixInverse: MAT4_ID(), g_ViewMatrix: MAT4_ID(), g_ProjectionMatrix: MAT4_ID(),
    g_AltModelMatrix: model, g_AltViewProjectionMatrix: vp,
    g_NormalModelMatrix: normalMatrix3(model), g_NormalMatrix: normalMatrix3(model),
    g_AltNormalModelMatrix: normalMatrix3(model),
    g_EyePosition: Float32Array.from(eye), g_EyeDirection: Float32Array.from([0, 0, -1]),
    g_LightsPosition: pos, g_LightsColorRadius: cr, g_LightsColorPremultiplied: premul,
    g_LightAmbientColor: Float32Array.from(r.ambientColor || [0, 0, 0]),
    g_LightSkylightColor: Float32Array.from(r.skylightColor || [0, 0, 0]),
    g_LightColor: lights[0]
      ? Float32Array.from([lights[0].color[0], lights[0].color[1], lights[0].color[2], lights[0].radius])
      : Float32Array.from([0, 0, 0, 0]),
    g_LightPosition: Float32Array.from(lights[0] ? lights[0].origin : [0, 0, 0]),
    g_ScreenSize: Float32Array.from([W, H, 1 / W, 1 / H]),
    g_TexelSize: Float32Array.from([1 / W, 1 / H, W, H]),
    g_TexelSizeHalf: Float32Array.from([0.5 / W, 0.5 / H]),
    g_Texture0Rotation: Float32Array.from([1, 0, 0, 1]),
    g_Texture0Translation: Float32Array.from([0, 0]),
    g_Texture3MipMapInfo: 0, g_Reflectivity: 1, g_EmissiveBrightness: 1,
    g_EmissiveColor: Float32Array.from([1, 1, 1]),
    g_AudioSpectrum16Left: new Float32Array(16), g_AudioSpectrum16Right: new Float32Array(16),
    g_AudioSpectrum32Left: new Float32Array(32), g_AudioSpectrum32Right: new Float32Array(32),
    g_AudioSpectrum64Left: new Float32Array(64), g_AudioSpectrum64Right: new Float32Array(64),
  };
  const sp = r.audioSpectrum;
  if (sp) {
    const L = sp.left || sp.left16 || [], R = sp.right || sp.right16 || [];
    for (let i = 0; i < 16; i++) { u.g_AudioSpectrum16Left[i] = L[i] || 0; u.g_AudioSpectrum16Right[i] = R[i] || 0; }
  }
  for (let i = 0; i < 8; i++) {
    const tt = extra && extra.textures ? extra.textures[i] : null;
    if (tt && tt.width) u['g_Texture' + i + 'Resolution'] = Float32Array.from([tt.width, tt.height, tt.width, tt.height]);
  }
  return u;
}

function convertUniform(type, value) {
  if (value === undefined || value === null) return null;
  if (type === 'sampler2D') return value;
  if (type === 'mat4' || type === 'mat3') {
    if (Array.isArray(value) && value.length === 16) return Float32Array.from(value);
    return value;
  }
  const v = typeof value === 'object' && value !== null && 'value' in value ? value.value : value;
  if (type && type.startsWith('vec')) {
    const n = { vec2: 2, vec3: 3, vec4: 4 }[type] || 4;
    if (typeof v === 'number') return Float32Array.from(Array(n).fill(v));
    if (Array.isArray(v)) return Float32Array.from(v);
    return Float32Array.from(String(v).trim().split(/\s+/).map(Number));
  }
  if (type === 'float' || type === 'int' || type === 'uint') return Number(v);
  if (type === 'bool') {
    if (typeof v === 'string') return !['false', '0', ''].includes(v.trim());
    if (typeof v === 'number') return v !== 0;
    return v === true;
  }
  return v;
}

/**
 * 按 shader 的 uniform 元注释组装 __u:
 *   引擎注入 → 材质常数 (constantshadervalues 直名 / usershadervalues 经 material 映射)
 *   → 元注释 default → sampler2D 绑定 (g_TextureN ↔ textures[N])
 * 数组 uniform (如 `uniform vec3 g_LightsPosition[4]`) 的声明正则匹配不到 `;`, 因此不在
 * meta.uniforms 里 —— 它们只能按**名字**从引擎注入 (engineUniforms 已覆盖官方全部数组槽)。
 */
export function buildMaterialUniforms({ meta, constants, userValues, engine, textures, primaryTex }) {
  const u = { ...engine };
  for (const [name, info] of Object.entries((meta && meta.uniforms) || {})) {
    if (info.type === 'sampler2D') continue;
    let val = null;
    if (info.material && constants && constants[info.material] !== undefined) {
      val = convertUniform(info.type, constants[info.material]);
    }
    if (val === null && constants && constants[name] !== undefined) {
      val = convertUniform(info.type, constants[name]);
    }
    if (val === null && userValues && userValues[name] !== undefined) {
      val = convertUniform(info.type, userValues[name]);
    }
    if (val === null && info.default !== undefined) val = convertUniform(info.type, info.default);
    if (val !== null && val !== undefined) u[name] = val;
  }
  for (const [name, info] of Object.entries((meta && meta.uniforms) || {})) {
    if (info.type !== 'sampler2D') continue;
    if (u[name] !== undefined && u[name] !== null) continue;
    const idx = Number((/g_Texture(\d+)/.exec(name) || [])[1] || 0);
    const bound = idx === 0
      ? (primaryTex || (textures && textures[0]) || null)
      : (textures && textures[idx]) || null;
    u[name] = bound || WHITE_TEX;
  }
  return u;
}

// ── attribute 收集 (fallback: 需要 **#if 求值后** 的文本才有意义) ──────────
// 注意: 主路径用编译产物自带的 AST attribute 清单 (transpile.js 从求值后 AST 收集);
// 本函数只在需要从文本侧核对时使用 (raw 源码会带上未启用分支的属性)。
const UNSUPPORTED_ATTR = /^a_(BlendIndices|BlendWeights|BoneIndices|BoneWeights)$/;
export function collectAttributes(vertSrc) {
  const out = [];
  const re = /^[ \t]*attribute\s+(?:lowp\s+|mediump\s+|highp\s+)?([\w]+)\s+([\w]+)\s*;/gm;
  let m;
  while ((m = re.exec(vertSrc))) out.push({ type: m[1], name: m[2] });
  return out;
}

// ── 编译 (带缓存) ─────────────────────────────────────────────────────────
function compileCached({ pkg, weAssetsDir, shaderName, combos, rinc, src, extraKey }) {
  const key = shaderName + '\x00' + JSON.stringify(combos) + '\x00' + (src.fragAt || '') + '\x00' + (src.vertAt || '') + (extraKey || '');
  if (_compileCache.has(key)) {
    const hit = _compileCache.get(key);
    _compileCache.delete(key); _compileCache.set(key, hit);
    return hit;
  }
  if (!src.frag) return { ok: false, reason: 'GLSL 材质 shader 源码不在容器内: shaders/' + shaderName + '.frag' };
  let compiled = null;
  let reason = null;
  const warns = [];
  try {
    compiled = compileGlsl({
      // `sample` 是 shaderfrog 的保留字 (HLSL sampler state) ⇒ 独立标识符改名后再解析
      fragSource: renameReservedSample(src.frag),
      vertSource: src.vert ? renameReservedSample(src.vert) : null,
      combos,
      resolveInclude: rinc,
      onWarn: (w) => warns.push(w),
    });
  } catch (e) {
    reason = 'GLSL 转译失败: ' + String((e && e.message) || e).split('\n')[0];
  }
  const rec = { ok: !!compiled, compiled, reason, warns };
  _compileCache.set(key, rec);
  if (_compileCache.size > CACHE_MAX) _compileCache.delete(_compileCache.keys().next().value);
  return rec;
}

// ── 顶点 attribute 数据源 ─────────────────────────────────────────────────
function attrFillsFor(prog, mesh, tangent, uv2) {
  const names = prog.attributes.map((a) => a.name);
  const uv2Of = (i) => (uv2 && uv2[i]) || (mesh.uv2s && mesh.uv2s[i]) || [0, 0];
  const fills = [];
  for (const name of names) {
    if (name === 'a_Position') fills.push((i, arr) => { const p = mesh.positions[i]; arr[0] = p[0]; arr[1] = p[1]; arr[2] = p[2]; });
    else if (name === 'a_Normal') fills.push((i, arr) => { const p = mesh.normals[i] || [0, 0, 1]; arr[0] = p[0]; arr[1] = p[1]; arr[2] = p[2]; });
    else if (name === 'a_TexCoord') fills.push((i, arr) => { const p = mesh.uvs[i] || [0, 0]; arr[0] = p[0]; arr[1] = p[1]; });
    else if (name === 'a_TexCoordVec4') fills.push((i, arr) => {
      const p = mesh.uvs[i] || [0, 0], q = uv2Of(i);
      arr[0] = p[0]; arr[1] = p[1]; arr[2] = q[0]; arr[3] = q[1];
    });
    else if (name === 'a_TexCoord2') fills.push((i, arr) => { const q = uv2Of(i); arr[0] = q[0]; arr[1] = q[1]; });
    else if (name === 'a_Tangent4') {
      if (!tangent) return { ok: false, reason: 'GLSL 顶点程序需要 a_Tangent4, MDL 顶点流里没有可校验的切线数据 (NORMALMAP 无法生效)' };
      fills.push((i, arr) => { const T = tangent.t[i]; arr[0] = T[0]; arr[1] = T[1]; arr[2] = T[2]; arr[3] = tangent.w[i]; });
    }
    else if (name === 'a_Color' || name === 'a_ColorTint') fills.push((i, arr) => { arr[0] = 1; arr[1] = 1; arr[2] = 1; arr[3] = 1; });
    else if (name === 'a_TexCoordRotation') fills.push((i, arr) => { arr[0] = 1; arr[1] = 0; arr[2] = 0; arr[3] = 1; });
    else return { ok: false, reason: 'GLSL 顶点程序需要未知 attribute ' + name + ' (本解释器没有数据源)' };
  }
  return { ok: true, names, fills };
}

// ── 绑定 ─────────────────────────────────────────────────────────────────
/**
 * 把材质 shader 绑定到一次具体绘制。
 * 返回 { ok:true, ...program } 或 { ok:false, reason } (调用方按既有路径回退并记 degraded)。
 */
export function bindMaterialProgram(renderer, {
  shaderName, pass, constants, userValues, textures, texturePaths, t, worldM, tangent, mesh, uv2, trace,
}) {
  const incLog = trace ? [] : null;
  const src = readWallpaperShader(renderer.pkg, shaderName, renderer.weAssetsDir);
  if (!src.frag) return { ok: false, reason: 'GLSL 材质 shader 源码不在容器内: shaders/' + shaderName + '.frag' };
  // 下游 shaderPatch：材质着色器同样允许覆写（key = 材质 shader stem）。
  // 注意 compileCached 的缓存键含源码路径而不含源码内容 ⇒ 打补丁时把补丁后的文本
  // 计入键（见下方 patchedKey），避免不同补丁之间互相命中缓存。
  let patchedKey = '';
  if (renderer._applyShaderPatch) {
    const pf = renderer._applyShaderPatch(shaderName, src.frag, 'fragment');
    const pv = src.vert ? renderer._applyShaderPatch(shaderName, src.vert, 'vertex') : null;
    if (pf !== src.frag || (pv && pv !== src.vert)) {
      patchedKey = '\x00P' + pf.length + ':' + (pv ? pv.length : 0);
      src.frag = pf;
      if (pv) src.vert = pv;
    }
  }
  const rinc = makeIncludeResolver(renderer.pkg, renderer.weAssetsDir, incLog);
  let meta = { combos: {}, uniforms: {} };
  try {
    const mf = parseMeta(expandIncludes(src.frag, rinc));
    let mv = { combos: {}, uniforms: {} };
    if (src.vert) mv = parseMeta(expandIncludes(src.vert, rinc));
    meta = { combos: { ...mv.combos, ...mf.combos }, uniforms: { ...mv.uniforms, ...mf.uniforms } };
  } catch { /* compile 阶段报具体原因 */ }
  const combos = combosForPass(pass, meta, textures);
  const rec = compileCached({ pkg: renderer.pkg, weAssetsDir: renderer.weAssetsDir, shaderName, combos, rinc, src, extraKey: patchedKey });
  if (!rec.ok) return { ok: false, reason: rec.reason };
  const compiled = rec.compiled;
  if (!compiled.vertFn) return { ok: false, reason: 'GLSL 材质 shader 缺少顶点程序 (shaders/' + shaderName + '.vert)' };
  // 解释器"解析了什么"取证: #require 清单 + include 解析结果 + 转译告警
  if (trace) {
    const fragX = expandIncludes(src.frag, rinc);
    const vertX = src.vert ? expandIncludes(src.vert, rinc) : '';
    trace.shader = shaderName;
    trace.fragAt = src.fragAt; trace.vertAt = src.vertAt;
    trace.requires = [...scanRequires(fragX), ...scanRequires(vertX)];
    trace.includes = incLog;
    trace.warns = rec.warns;
  }

  const engine = engineUniforms(renderer, worldM, { t, textures });
  const u = buildMaterialUniforms({ meta, constants, userValues, engine, textures, primaryTex: textures && textures[0] });
  // ── `_rt_*` 渲染目标的 V 轴约定 ─────────────────────────────────────────
  // 官方 shader 的屏幕 UV 是 **GL 约定 (y 向上)**: `screenUV = (v_ScreenPos.xy/v_ScreenPos.z)*0.5+0.5`,
  // 而本插件的 `_rt_*` 纹像是**画布自上而下**的副本 (core.js 的 `_reflCanvas` 就是
  // `new Canvas(W,H)`, 行 0 = 顶部; 与手写 `_shadeGeneric`/`_shadeGrid` 用的
  // `(px/W, py/H)` 同一约定 —— 见 model.js:_shadeGrid 注释)。官方在 D3D 平台上也是靠
  // `#ifdef HLSL v_ScreenPos.y = -v_ScreenPos.y;` 自己翻, 说明"屏幕 UV 需要一次 V 翻转"
  // 是**平台约定**而不是 shader 数学。这里在采样 `_rt_*` 槽位时做同一件事:
  // 把 GL 的 y 向上 UV 翻到插件的 y 向下画布空间。
  const rtSet = new Set();
  if (texturePaths) {
    texturePaths.forEach((p, i) => { if (p && String(p).startsWith('_rt_') && textures[i]) rtSet.add(textures[i]); });
  } else {
    // 调用方没给路径: 用纹理对象上的插件标记 (loadTexture 的 _rt_ 分支产物) 兜底
    for (const tex of textures || []) if (tex && tex.__isRenderTarget) rtSet.add(tex);
  }
  const rt = runtimeObject((tex, uu, vv) => {
    const v2 = (RT_FLIP_V && rtSet.has(tex)) ? (1 - vv) : vv;
    return renderer._texSample(tex, uu, v2, false);
  });

  // attribute 清单必须取自 **#if 求值后的 AST** (raw 源码扫描会把 SKINNING 分支里
  // 的 a_BlendIndices 也算进来 → genericimage2 等 shader 被误判为不支持)。
  // vertFn 装配期只读 __a 不跑 main, 故可用空 __a 先探一次。
  let attrs = [];
  try {
    attrs = compiled.vertFn(u, {}, {}, rt).attributes || [];
  } catch (e) {
    return { ok: false, reason: 'GLSL 顶点程序装配失败: ' + (e && e.message) };
  }
  const bad = attrs.find((a) => UNSUPPORTED_ATTR.test(a.name));
  if (bad) return { ok: false, reason: 'GLSL 顶点程序使用不支持的 attribute ' + bad.type + ' ' + bad.name + ' (蒙皮/实例流未实现)' };
  const unknownType = attrs.find((a) => !ATTR_LEN[a.type]);
  if (unknownType) return { ok: false, reason: 'GLSL 顶点程序使用不支持的 attribute 类型 ' + unknownType.type + ' ' + unknownType.name };
  const scalar = attrs.find((a) => ATTR_LEN[a.type] === 1);
  if (scalar) return { ok: false, reason: 'GLSL 顶点程序使用标量 attribute ' + scalar.type + ' ' + scalar.name + ' (只支持向量 attribute: 标量在模块装配期被值捕获, 无法逐顶点更新)' };
  const arrAttr = attrs.find((a) => a.array);
  if (arrAttr) return { ok: false, reason: 'GLSL 顶点程序使用数组 attribute ' + arrAttr.name + ' (未实现)' };

  const layout = [];
  let offset = 0;
  for (const v of compiled.varyings) {
    const len = ATTR_LEN[v.type] || 4;
    layout.push({ name: v.name, type: v.type, len, offset });
    offset += len;
  }
  const varyingCount = offset;

  const aObj = {};
  for (const a of attrs) aObj[a.name] = new Float32Array(ATTR_LEN[a.type]);
  const vObj = {};
  for (const L of layout) vObj[L.name] = new Float32Array(L.len);

  let vctx, fctx;
  try {
    vctx = compiled.vertFn(u, vObj, aObj, rt);
    fctx = compiled.fragFn(u, vObj, {}, rt);
  } catch (e) {
    return { ok: false, reason: 'GLSL 程序装配失败: ' + (e && e.message) };
  }
  const vMain = vctx.main;
  const vOut = vctx.__out;
  const fMain = fctx.main;
  const fCol = fctx.gl_FragColor;
  const fInit = fctx.__initGlobals || null;

  const prog = {
    ok: true, shaderName, combos, meta, layout, varyingCount, attributes: attrs,
    uniforms: u, fragAt: src.fragAt, vertAt: src.vertAt, warns: rec.warns,
    aObj, vObj,
  };

  const clipOut = new Float64Array(4);
  prog.runVertex = (i) => {
    try {
      if (vctx.__initGlobals) vctx.__initGlobals();
      if (i != null) prog.__filler(i);
      vMain();
    } catch (e) {
      return { err: 'GLSL 顶点程序执行异常: ' + (e && e.message) };
    }
    const gp = vOut.gl_Position;
    if (!gp || gp.length === undefined || gp.length < 4) return { err: 'GLSL 顶点程序未写出 gl_Position' };
    clipOut[0] = gp[0]; clipOut[1] = gp[1]; clipOut[2] = gp[2]; clipOut[3] = gp[3];
    return { clip: clipOut };
  };
  prog.flushVaryings = (out, base) => {
    for (let k = 0; k < layout.length; k++) {
      const L = layout[k], arr = vObj[L.name];
      for (let j = 0; j < L.len; j++) out[base + L.offset + j] = arr[j];
    }
  };
  let pixelErrors = 0;
  prog.shadeFn = (uu, vv, wp, n, eye, u2, v2, su, sv, tbn, vvArr) => {
    for (let k = 0; k < layout.length; k++) {
      const L = layout[k], arr = vObj[L.name];
      for (let j = 0; j < L.len; j++) arr[j] = vvArr[L.offset + j];
    }
    if (fInit) fInit();
    fCol[0] = 0; fCol[1] = 0; fCol[2] = 0; fCol[3] = 0;
    try {
      fMain();
    } catch (e) {
      if (e === DISCARD) return null;
      if (++pixelErrors > 64) throw e;
      return null;
    }
    // 8-bit UNORM 目标钳位 (GPU 写 8bit RT 时的固有行为; 官方 shader 的输出是**未钳位**
    // 的 HDR 值 —— 8bit 目标上会被钳到 [0,1], 而 canvas.data 是 Uint8Array, 不钳位会
    // 模 256 回绕 ⇒ 高光变暗斑)。手写移植同样返回 sat(...)。
    return [clamp01(fCol[0]), clamp01(fCol[1]), clamp01(fCol[2]), clamp01(fCol[3])];
  };

  // 网格 attribute 填充器
  const filler = attrFillsFor(prog, mesh, tangent, uv2);
  if (!filler.ok) return { ok: false, reason: filler.reason };
  prog.__filler = (i) => { for (let k = 0; k < filler.names.length; k++) filler.fills[k](i, aObj[filler.names[k]]); };

  // 合成输入预检: 失败即整体拒绝 (避免"画了一半才崩"留下半成品像素)
  const smoke = smokeProgram(prog);
  if (smoke) return { ok: false, reason: smoke };
  return prog;
}

/** 合成输入预检: 顶点 + 片元各跑几组良性输入, 任一步异常/非有限 → 返回原因 */
function smokeProgram(prog) {
  const synthPos = [[0.25, 0.25, 0.1], [0.5, 0.5, 0.2], [0.75, 0.25, 0.3], [0.1, 0.9, 0.4]];
  const saved = {};
  for (const a of prog.attributes) saved[a.name] = prog.aObj[a.name].slice(0);
  try {
    const base = prog.aObj;
    const savedFiller = prog.__filler;
    prog.__filler = (i) => {
      for (const a of prog.attributes) {
        const arr = base[a.name];
        for (let j = 0; j < arr.length; j++) arr[j] = a.name === 'a_Tangent4' && j === 3 ? 1 : 0.25 + 0.1 * j;
      }
      const p = synthPos[i % synthPos.length];
      if (base.a_Position) { base.a_Position[0] = p[0]; base.a_Position[1] = p[1]; base.a_Position[2] = p[2]; }
    };
    for (let i = 0; i < 4; i++) {
      const r = prog.runVertex(i);
      if (r.err) return r.err;
    }
    prog.__filler = savedFiller;
    const vv = new Float64Array(prog.varyingCount);
    for (let i = 0; i < prog.varyingCount; i++) vv[i] = 0.3;
    const grid = [[0.25, 0.25], [0.5, 0.5], [0.75, 0.25], [0.1, 0.9]];
    for (const [uu, vv2] of grid) {
      const c = prog.shadeFn(uu, vv2, [0, 0, 0], [0, 0, 1], [0, 0, 5], uu, vv2, uu, vv2, null, vv);
      if (!c) continue; // discard
      if (!isFinite(c[0]) || !isFinite(c[1]) || !isFinite(c[2]) || !isFinite(c[3])) {
        return 'GLSL 片元程序在合成输入下产生非有限输出 (NaN/Inf) → 整条通路拒绝';
      }
    }
  } catch (e) {
    return 'GLSL 程序执行异常: ' + (e && e.message);
  } finally {
    for (const a of prog.attributes) prog.aObj[a.name].set(saved[a.name]);
  }
  return null;
}
