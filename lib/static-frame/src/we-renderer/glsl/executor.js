// WE GLSL 效果执行器 — 编译 shader → 逐像素渲染
// 流程: include 展开 + combo 宏 → preprocess → parse → transpile → new Function
//       vert 4 角跑 varying → 双线性插值 → frag 逐像素 main() → RGBA
// 显式 index.js：该包 package.json 没有 main/exports，裸包名 import 会触发
// Node 的 DEP0151 弃用警告（每次运行都打到 stderr，与 --log 的诊断混在一起）。
import { parse } from '@shaderfrog/glsl-parser/index.js';
import { transpile } from './transpile.js';
import { preprocessShader, parseMeta, expandIncludes, renameReservedSample } from './preprocess.js';
import { runtimeObject, DISCARD } from './runtime.js';

// A/B 开关 (issue #2): 关掉"顶点没写 v_TexCoord 时用全屏 quad 角点播种"的兜底, 回到
// 接线前行为 —— 用于**同一会话内**量出该兜底修好了什么 (跨会话的机器负载不同, 不可比)。
// **每次调用读取**（非模块加载期），便于宿主/WebUI 逐请求切换。
const noSeedTexCoord = () => process.env.DSH_WE_NO_SEED_VTEXCOORD === '1';

// vec 类型 → 分量数。**必须声明在所有使用点之前**：`seedTexCoord`/`renderGlsl` 都在
// 模块顶层函数里引用它，而 const 有 TDZ —— 若声明晚于这些函数体所在位置，调用时会抛
// ReferenceError，被上层 catch 吞掉后表现为"播种值总是 4 元"（issue #2 的
// offset is out of bounds 就是这么来的：vec2 缓冲收到 4 元 src）。
const VEC_LEN = { vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, bvec2: 2, bvec3: 3, bvec4: 4 };

export function compileGlsl({ fragSource, vertSource = null, combos = {}, resolveInclude = null, onWarn = null }) {
  // GLS-22: 先展开 include 再取 meta — 头文件内声明的 uniform/元注释不再丢失。
  // 展开后立刻做保留字改名：shaderfrog 把 sample/buffer/shared/patch/precise/subroutine
  // 当保留字（GLSL ES 1.0 里合法），以它们命名的变量会让整个 shader 解析失败 ⇒ 效果
  // 被整条丢弃。材质路径 (material.js) 早已启用，效果路径此前漏了（见 preprocess.js 注释）。
  const fragX = renameReservedSample(resolveInclude ? expandIncludes(fragSource, resolveInclude, { onWarn }) : fragSource);
  const vertX = vertSource && resolveInclude
    ? renameReservedSample(expandIncludes(vertSource, resolveInclude, { onWarn }))
    : (vertSource ? renameReservedSample(vertSource) : vertSource);
  const metaF = parseMeta(fragX);
  const metaV = vertX ? parseMeta(vertX) : { combos: {}, uniforms: {} };
  const meta = {
    combos: { ...metaF.combos, ...metaV.combos },
    uniforms: { ...metaF.uniforms, ...metaV.uniforms },
  };
  // P2-23: 已解析的 meta 透传给 preprocessShader — 免其对同一源码再跑一次
  // parseMeta 全文正则扫描 (此前本函数 + preprocess.js 各跑一遍)
  const fragPre = preprocessShader(fragX, { defines: combos, meta: metaF });
  const fragAst = parse(fragPre, { stage: 'fragment', quiet: true });
  const fragCode = transpile(fragAst, 'fragment');
  assertHasMain(fragCode, fragX, combos, meta.combos, 'fragment');
  let vertFn = null;
  let varyings = [];
  let vertPre = null;
  let vertCode = null;
  if (vertX) {
    vertPre = preprocessShader(vertX, { defines: combos, meta: metaV });
    const vertAst = parse(vertPre, { stage: 'vertex', quiet: true });
    vertCode = transpile(vertAst, 'vertex');
    assertHasMain(vertCode, vertX, combos, metaV.combos, 'vertex');
    vertFn = new Function('__u', '__v', '__a', '__rt', vertCode);
    varyings = collectVaryings(vertAst);
  }
  const fragFn = new Function('__u', '__v', '__a', '__rt', fragCode);
  // ── 引擎隐式 varying: v_TexCoord ──────────────────────────────────────────
  // WE 的效果着色器可以直接在**片元**里使用 v_TexCoord（当前片元的纹理坐标），而顶点侧
  // 既不声明也不写它（实测 bloom / lens_flare_sun / bokeh_blur 的 vert 完全没有 varying）。
  // 此前 __v.v_TexCoord 根本不存在 ⇒ 片元读 `__v.v_TexCoord[0]` 抛
  // "Cannot read properties of undefined (reading '0')" ⇒ 整个效果被丢弃。
  // 这里补一条 implicit 条目，由 renderGlsl 用全屏 quad 的角点 uv 兜底
  // （顶点若自己声明并写了同名的 varying，会被它覆盖，语义仍然是"引擎提供默认值"）。
  if (/\bv_TexCoord\b/.test(fragCode) && !varyings.some((v) => v.name === 'v_TexCoord')) {
    varyings = [{ name: 'v_TexCoord', type: 'vec4', implicit: true }, ...varyings];
  }
  // fragPre/vertPre 一并返回: GPU 路径 (gpu-gl/adapter.js) 需要**同一份**预处理源码。
  // 与 CPU 解释器共用预处理 ⇒ 两侧跑的是同一个程序 (include 展开 / combo 宏 / meta
  // 兜底都不会分叉), 这是 GPU 输出能与 CPU 对齐的前提。
  return { fragFn, vertFn, varyings, uniforms: meta.uniforms, combos: meta.combos, fragPre, vertPre, vertCode, fragCode };
}

/**
 * 顶点阶段的生成代码里是否**写过**某个 varying —— 用于决定要不要用"全屏 quad 角点"给它
 * 播种默认值（见 renderGlsl 的 v_TexCoord 兜底）。
 *
 * 只按"有没有出现写入"判断，不区分整变量/分量：`v_TexCoord.xy = a_TexCoord`（工坊
 * geometric_transform 的写法）会转译成 `__v.v_TexCoord[0] = …` 两条分量写入，只匹配
 * `__v.name.set(` / `__v.name =` 会漏判 ⇒ 误播种 ⇒ 播下的 4 元值又被插值进按声明类型
 * 分配的缓冲（vec2 = 2 元）⇒ `Float32Array.set` 抛 offset is out of bounds（issue #2）。
 * 反之，只要顶点碰过这个 varying 就以顶点为准（哪怕只写了部分分量）：顶点是权威，
 * 引擎默认值只在顶点**完全没写**时提供。
 */
function vertWritesVarying(vertCode, name) {
  if (!vertCode) return false;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // __v.name[…]= / __v.name = / __v.name.set( / __v.name.x = / __v.name.x *= …
  return new RegExp('__v\\.' + n + '\\s*(\\.\\s*set\\s*\\(|\\[[^\\]]*\\]\\s*[-+*/]?=|\\.[xyzwrgba]{1,4}\\s*[-+*/]?=|[-+*/]?=)').test(vertCode);
}

/**
 * v_TexCoord 的默认角点值。**返回数组的长度必须等于编译器为该 varying 预分配的缓冲长度**
 * —— `__v[name].set(src)` 在 src 比缓冲长时抛 `RangeError: offset is out of bounds`。
 * 注意 `[u, v, cond ? u : 0, cond ? v : 0]` 这种写法**永远**是 4 元（条件只决定元素值，
 * 不改变数组长度），给声明成 `vec2` 的 varying 播种就会越界 —— issue #2 的
 * "offset is out of bounds" 正是这么来的（geometric_transform / bokeh_blur）。
 * 这里按声明类型精确取长：vec2 → (u,v)、vec3 → (u,v,0)、vec4 → (u,v,u,v)
 * （vec4 的 zw 同 uv，与引擎/默认顶点着色器的约定一致）。
 */
function seedTexCoord(vn, corner) {
  const u = corner.uv[0], v = corner.uv[1];
  const n = VEC_LEN[vn.type] || 4;
  const out = new Array(n);
  out[0] = u;
  if (n > 1) out[1] = v;
  if (n > 2) out[2] = n === 4 ? u : 0;
  if (n > 3) out[3] = v;
  return out;
}

/**
 * 编译期断言：预处理后的源码里必须还有 `main`。
 *
 * 为什么要提前拦：工坊 shader 常用 `#if <COMBO> == n` 分出多份 `main`（实测 auto_sway
 * 有 AA_VERSION==1/2/3 三份）。若该 combo 既不在场景实例里、也不在 shader 元注释里，
 * 三份 main 会被一起裁掉 —— 转译仍然"成功"，直到运行期才抛一句
 * `ReferenceError: main is not defined`，完全看不出原因（本仓库 issue #1）。
 * 现在报错直接给出**缺失的 combo 名单**，便于判断是"组合没传进来"还是"壁纸本身缺默认值"。
 */
function assertHasMain(code, preprocessedSrc, combos, metaCombos, stage) {
  if (/\bfunction\s+main\s*\(/.test(code)) return;
  const missing = [];
  for (const m of String(preprocessedSrc).matchAll(/#\s*if\s+([A-Za-z_]\w*)/g)) {
    const n = m[1];
    if (combos && combos[n] !== undefined) continue;
    if (n === 'defined' || n === 'GL_ES') continue;
    // 带上"元注释里有没有默认值"：只由 require 间接引用、没有 default 的 combo
    // （实测 auto_sway 的 AA_VERSION）会被当成 0，正是裁掉全部 main 的元凶。
    const mc = metaCombos && metaCombos[n];
    const tag = mc === undefined ? '(无声明)' : '(元注释默认 ' + JSON.stringify(mc && mc.default !== undefined ? mc.default : mc) + ')';
    const item = n + tag;
    if (!missing.includes(item)) missing.push(item);
  }
  throw new Error('预处理后没有 main（' + stage + '）：`#if` 组合分支把 main 整段裁掉了'
    + (missing.length ? '；未提供且无默认值的 combo: ' + missing.join(', ') : '')
    + '（工坊 shader 可能依赖编辑器侧的 combo 默认值，而壁纸包内没有声明）');
}

function collectVaryings(ast) {
  const out = [];
  const typeOfSpec = (spec) => {
    let s = spec;
    while (s && typeof s === 'object' && !s.token && s.specifier) s = s.specifier;
    return s && s.token ? s.token : null;
  };
  for (const node of ast.program || []) {
    if (node.type !== 'declaration_statement') continue;
    const dl = node.declaration;
    if (!dl || dl.type !== 'declarator_list') continue;
    const quals = (dl.specified_type.qualifiers || []).map((q) => q.token);
    if (!quals.includes('varying')) continue;
    const type = typeOfSpec(dl.specified_type);
    for (const d of dl.declarations || []) {
      if (d.type !== 'declaration') continue;
      // 数组 varying (工坊 shader 常见: `varying vec2 v_TexCoord[4];` 做 4 抽头降采样):
      // 必须带上数组长度 —— 否则 renderGlsl 按标量分配 Float32Array(2)，
      // 片元里 `v_TexCoord[i]`（i≥2）取到 undefined ⇒ texSample2D 抛
      // "Cannot read properties of undefined (reading '0')" ⇒ 整个 pass 失败
      // （实测 bloom / bokeh_blur / lens_flare_sun 的 down_sample、light_map、downsample）。
      const q = d.quantifier;
      let arrayLen = 0;
      if (q && q.length) {
        const e = q[0].expression;
        arrayLen = Number(e && (e.token !== undefined ? e.token : e.literal)) || 0;
      }
      out.push({ name: d.identifier.identifier, type: arrayLen ? type + '[]' : type, arrayLen });
    }
  }
  return out;
}
function makeVarying(name, type) {
  return { name, type };
}

// 值转换: 场景 constantshadervalues / 引擎值 → uniform 需要的 JS 表示
function convertUniform(type, value) {
  if (value === undefined || value === null) return null;
  if (type === 'sampler2D') return value; // 纹理对象
  if (type === 'mat4' || type === 'mat3') {
    if (Array.isArray(value) && value.length === 16) return Float32Array.from(value);
    return value;
  }
  const v = typeof value === 'object' && value !== null && 'value' in value ? value.value : value;
  if (type.startsWith('vec')) {
    if (typeof v === 'number') {
      const n = { vec2: 2, vec3: 3, vec4: 4 }[type];
      return Float32Array.from(Array(n).fill(v));
    }
    if (Array.isArray(v)) return Float32Array.from(v);
    const parts = String(v).trim().split(/\s+/).map(Number);
    return Float32Array.from(parts);
  }
  if (type === 'float' || type === 'int') {
    if (typeof v === 'object' && v !== null && 'value' in v) return Number(v.value);
    return Number(v);
  }
  if (type === 'bool') {
    // F-11: csv 字符串 "false"/"0"/"" 必须为 false (此前 !!v 把一切字符串当 true)
    if (typeof v === 'string') return !['false', '0', ''].includes(v.trim());
    if (typeof v === 'number') return v !== 0;
    return v === true;
  }
  return v;
}

// 组装 __u: 场景值 + 引擎注入 + 元注释 default 兜底
export function buildUniforms(uniformMeta, constants, engine) {
  const u = {};
  for (const [name, info] of Object.entries(uniformMeta)) {
    let val = null;
    if (info.material) {
      val = convertUniform(info.type, constants[info.material]);
    }
    if (val === null || val === undefined) {
      val = engineInject(info.type, name, engine);
    }
    // P1-38/P1-44: 材质缺值时落 shader 元注释 default (parseMeta 现保留该字段)
    if ((val === null || val === undefined) && info.default !== undefined && info.type !== 'sampler2D') {
      val = convertUniform(info.type, info.default);
    }
    if (val !== null && val !== undefined) u[name] = val;
  }
  return u;
}

function engineInject(type, name, e) {
  const eng = e || {};
  switch (name) {
    case 'g_Time': return eng.time || 0;
    case 'g_UserAlpha': return eng.userAlpha !== undefined ? eng.userAlpha : 1;
    // WE 内建 uniform 缺省 (此前未提供 → 运行时按 0 处理):
    //   g_Alpha = 图层不透明度。texture_override 等 shader 直接用它乘 alpha
    //   (blendColors.a *= g_Alpha * u_Opacity) ⇒ 未绑定时输出**整幅透明**, 表现为
    //   窗户/窗帘等 pure-color 层退化成纯色块 (实测 Angel Mail 覆盖度 100%→0%)。
    case 'g_Alpha': return eng.userAlpha !== undefined ? eng.userAlpha : 1;
    case 'g_Color4': return Float32Array.from([1, 1, 1, 1]);
    case 'g_Color': return Float32Array.from([1, 1, 1]);
    case 'g_ParallaxPosition': return eng.parallaxPosition ? Float32Array.from(eng.parallaxPosition) : Float32Array.from([0.5, 0.5]);
    case 'g_ModelViewProjectionMatrix': return identityMat4();
    case 'g_LayerModelMatrix': return identityMat4();
    case 'g_EffectTextureProjectionMatrix': return identityMat4();
    case 'g_EffectTextureProjectionMatrixInverse': return identityMat4();
    case 'g_TextureReductionScale': return 1;
    default: break;
  }
  // g_TextureNResolution
  const m = /^g_Texture(\d+)Resolution$/.exec(name);
  if (m) {
    const idx = Number(m[1]);
    const tex = eng.textures && eng.textures[idx];
    if (tex && tex.width) {
      // P0-17/§9.2 裁决: (mip0宽, mip0高, header宽, header高)。当前纹理无独立 header
      // 尺寸 → zw=xy; 此前 (objW,objH,texW,texH) 是判别实验①明确排除的约定 (b)
      const w = tex.width, h = tex.height;
      return Float32Array.from([w, h, w, h]);
    }
    // 缺纹理: 槽位 0 = **输入帧缓冲** (effect chain 的链输入 = 本层渲染结果), 其尺寸
    // 就是输入图尺寸 (WE: g_Texture0Resolution.xy = 输入 RT 大小)。实测 texture_override
    // 用 scale = g_Texture0Resolution / g_Texture1Resolution 推覆盖贴图 UV —— 取 [1,1,1,1]
    // 会让 .zw 落进图集空白像素 → alpha 0 → 整层透明 (窗户/窗帘/云 退化成纯色块)。
    // 槽位 >0 仍按 §9.2 裁决取 [1,1,1,1] (mask 类槽位缺纹理时分辨率缩放恒 1)。
    if (idx === 0 && eng.objW && eng.objH) {
      return Float32Array.from([eng.objW, eng.objH, eng.objW, eng.objH]);
    }
    return Float32Array.from([1, 1, 1, 1]);
  }
  // 常量 (M_PI 等由 __rt 提供, 此处不处理)
  return null;
}

function identityMat4() {
  return Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// 双线性插值: 数组写 out 缓冲 (预分配复用), 标量直接返回
function bilinearTo(corners, u, v, out) {
  const a0 = corners[0], a1 = corners[1], b0 = corners[2], b1 = corners[3];
  if (a0 == null) return null;
  if (typeof a0 === 'number') {
    const top = a0 + (a1 - a0) * u;
    const bot = b0 + (b1 - b0) * u;
    return top + (bot - top) * v;
  }
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const top = a0[i] + (a1[i] - a0[i]) * u;
    const bot = b0[i] + (b1[i] - b0[i]) * u;
    out[i] = top + (bot - top) * v;
  }
  return out;
}

// 纹理采样器 (注入 runtime): 双线性 + clamp
export function makeSampler(sampleFn) {
  // sampleFn(tex, u, v) → [r,g,b,a] 0-1 (现有 _texSample 封装)
  return (tex, u, v) => {
    if (!tex) return [0, 0, 0, 0];
    return sampleFn(tex, u, v);
  };
}

// 渲染入口: compiled + uniforms + 纹理 → RGBA
// F-10: textures/time 是死参, 已删除 (sampler/u 由调用方组装)
export function renderGlsl(compiled, { width, height, u, sampler }) {
  const rt = runtimeObject(sampler);
  // 全屏 quad 的四角 (uv 与 NDC 位置一一对应) —— 顶点程序与隐式 varying 都用它
  const corners = [
    { uv: [0, 0], pos: [-1, -1, 0] },
    { uv: [1, 0], pos: [1, -1, 0] },
    { uv: [0, 1], pos: [-1, 1, 0] },
    { uv: [1, 1], pos: [1, 1, 0] },
  ];
  // ── vert 4 角 → varying 角值 ──
  const cornerVals = {};
  if (compiled.vertFn) {
    for (const vn of compiled.varyings) cornerVals[vn.name] = [];
    // P1-39: 4 角给真实角点 — a_Position = 全屏 quad NDC 角 (与 a_TexCoord 角一一对应,
    // 此前恒 [0,0,0] → 依赖 a_Position 的 vert 全部塌缩到单点)
    for (const c of corners) {
      const __a = { a_TexCoord: c.uv, a_Position: c.pos };
      // 预初始化 varying 数组 (vert 里 swizzle 写分量需要已存在)
      const __v = {};
      for (const vn of compiled.varyings) {
        // 数组 varying: 容器 = 每元素一个 Float32Array（顶点可能只写元素的某个分量）
        __v[vn.name] = vn.arrayLen
          ? Array.from({ length: vn.arrayLen }, () => new Float32Array(VEC_LEN[vn.type.replace('[]', '')] || 4))
          : new Float32Array(VEC_LEN[vn.type] || 4);
      }
      // 引擎隐式 varying (v_TexCoord): 先用全屏 quad 的角点 uv 兜底 —— 顶点若自己声明并写
      // 了同名 varying, 会在 main() 里覆盖掉这个默认值 (与官方引擎"引擎提供默认值"一致)。
      //
      // ⚠️ 只能给**顶点侧真的没写**的 v_TexCoord 播种。issue #2 round18 的教训: 早先这里
      // 判的是 `vn.implicit`（只有"片元用了但顶点没声明"才置位），于是 pass6(gaussian_y)
      // 这种"vert 声明了 v_TexCoord 但分支里没写"的情形整段角点恒为 (0,0) —— 采样永远命中
      // 同一个点, 输出整幅常量 (实测 colors=1/mean=0.0)。判据放宽成"顶点侧没写就播种"后
      // 又踩到另一头: 顶端已算好的角点被这次播种**整个覆盖** ⇒ 顶点程序形同虚设。
      // 正确判据 = **顶点侧有没有写**: 写了就一律不碰 (顶点是权威), 没写才补默认值。
      for (const vn of compiled.varyings) {
        if (noSeedTexCoord() || vn.arrayLen || vn.name !== 'v_TexCoord') continue;
        if (vertWritesVarying(compiled.vertCode, 'v_TexCoord')) continue;
        __v[vn.name].set(seedTexCoord(vn, c));
      }
      const vertCtx = compiled.vertFn(u, __v, __a, rt);
      if (vertCtx.__initGlobals) vertCtx.__initGlobals(); // GLS-26: 逐角重置全局
      vertCtx.main();
      for (const vn of compiled.varyings) cornerVals[vn.name].push(__v[vn.name]);
    }
  }
  // 隐式 varying 的角点值**不能依赖顶点程序存在**：效果链里大量 pass 只有 .frag
  // (bloom / bokeh_blur / lens_flare_sun 的 down_sample、light_map 等)，
  // 此时上面那段角点循环根本不执行 ⇒ __v.v_TexCoord 缺失 ⇒ 片元读 __v.v_TexCoord[0]
  // 抛 "Cannot read properties of undefined (reading '0')" ⇒ 整个 pass 失败。
  // 同上：只补"顶点侧没写"的那些 (有顶点程序且它写了 v_TexCoord 时 cornerVals 已有值)。
  for (const vn of compiled.varyings) {
    if (noSeedTexCoord() || vn.arrayLen || vn.name !== 'v_TexCoord') continue;
    if (cornerVals[vn.name]) continue;
    if (compiled.vertCode && vertWritesVarying(compiled.vertCode, 'v_TexCoord')) continue;
    cornerVals[vn.name] = corners.map((c) => Float32Array.from(seedTexCoord(vn, c)));
  }
  // ── frag 装配 (__v 必须与像素循环共享同一对象 — 模块闭包引用构造时传入的引用) ──
  const __v = {};
  const fragCtx = compiled.fragFn(u, __v, {}, rt);
  const fragMain = fragCtx.main;
  const gl_FragColor = fragCtx.gl_FragColor;
  const initGlobals = fragCtx.__initGlobals || null;
  const out = new Uint8Array(width * height * 4);
  // 预分配 varying 插值缓冲 (数组型 varying 复用)
  const vbufs = {};
  for (const vn of compiled.varyings) {
    const c0 = cornerVals[vn.name] && cornerVals[vn.name][0];
    if (c0 && typeof c0 === 'object') vbufs[vn.name] = new Float32Array(c0.length);
  }
  let pixelErrors = 0;   // F-12: 逐像素异常隔离计数
  let lastError = null;
  // P1-8⑤: 循环不变量外提 — varying 角值/插值缓冲预取成局部数组;
  // 数组型 varying 的 __v 槽只绑定一次 (frag 侧只读 __v, bilinearTo 就地写
  // 复用缓冲), 免逐像素 for..of 遍历 + 三重键查找
  const arrV = [], sclV = [], arrElems = [];
  for (const vn of compiled.varyings) {
    if (vn.arrayLen) {
      // 数组 varying: 逐元素插值, 就地写回容器 (frag 读的是同一个 __v[name][e])
      const elemLen = VEC_LEN[vn.type.replace('[]', '')] || 4;
      if (!__v[vn.name]) __v[vn.name] = Array.from({ length: vn.arrayLen }, () => new Float32Array(elemLen));
      const c4 = cornerVals[vn.name]; // [corner0容器, corner1容器, corner2容器, corner3容器]
      const elems = [];
      for (let e = 0; e < vn.arrayLen; e++) {
        const buf = new Float32Array(elemLen);
        __v[vn.name][e] = buf;
        if (c4) elems.push({ corner: c4.map((c) => c[e]), buf });
      }
      if (elems.length) arrElems.push(elems);
      continue;
    }
    const buf = vbufs[vn.name];
    if (buf) { __v[vn.name] = buf; arrV.push([cornerVals[vn.name], buf]); }
    else sclV.push([vn.name, cornerVals[vn.name]]);
  }
  const nArr = arrV.length, nScl = sclV.length, nArrE = arrElems.length;
  for (let y = 0; y < height; y++) {
    const fv = (y + 0.5) / height; // 行不变量外提 (纯除法, 结果逐位不变)
    for (let x = 0; x < width; x++) {
      const fu = (x + 0.5) / width;
      for (let k = 0; k < nArr; k++) { const p = arrV[k]; bilinearTo(p[0], fu, fv, p[1]); }
      for (let k = 0; k < nArrE; k++) {
        const elems = arrElems[k];
        for (let e = 0; e < elems.length; e++) bilinearTo(elems[e].corner, fu, fv, elems[e].buf);
      }
      for (let k = 0; k < nScl; k++) { const p = sclV[k]; __v[p[0]] = bilinearTo(p[1], fu, fv, null); }
      if (initGlobals) initGlobals(); // GLS-26: 全局逐像素重置 (GLSL 语义; const 全局已在转译期排除)
      // P0-15: 重置残留 (discard/早退像素不泄漏到下一像素) — P1-8⑤: 显式赋值替代 fill(0) 方法调用
      gl_FragColor[0] = 0; gl_FragColor[1] = 0; gl_FragColor[2] = 0; gl_FragColor[3] = 0;
      try {
        fragMain();
      } catch (e) {
        if (e === DISCARD) continue; // P0-15/P1-32: discard → 本像素不写色
        pixelErrors++;
        lastError = e;
        if (pixelErrors > 1024) throw e; // 大面积异常 → 整帧失败 (交给上层回退, 不做百万次 catch)
        continue;
      }
      const di = (y * width + x) * 4;
      // P1-8⑤: Math.min/max 三连 (12 次 Math 调用/像素) → 比较运算 (每像素 1 次
      // Math.round); NaN 与 ±∞ 的归约路径与 Math.min(1, Math.max(0, x)) 逐位一致
      let c = gl_FragColor[0];
      out[di] = Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255);
      c = gl_FragColor[1];
      out[di + 1] = Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255);
      c = gl_FragColor[2];
      out[di + 2] = Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255);
      c = gl_FragColor[3];
      out[di + 3] = Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255);
    }
  }
  return { width, height, rgba: out, pixelErrors, lastError: lastError ? String((lastError && lastError.message) || lastError) : null };
}

// 便捷: 一次调用编译 + 渲染 (测试用)
export function compileAndRender({ fragSource, vertSource, combos, constants, width, height, textures, time, resolveInclude, sampler }) {
  const compiled = compileGlsl({ fragSource, vertSource, combos, resolveInclude });
  const u = buildUniforms(compiled.uniforms, constants || {}, {
    time, textures, objW: width, objH: height,
  });
  // 纹理绑定: uniforms 里 sampler2D 类型 → 从 textures 按序取 (官方语义: g_TextureN ↔ textures[N])
  for (const [name, info] of Object.entries(compiled.uniforms)) {
    if (info.type === 'sampler2D' && u[name] === undefined) {
      const idx = Number(/g_Texture(\d+)/.exec(name)?.[1] || 0);
      u[name] = textures && textures[idx];
    }
  }
  return renderGlsl(compiled, { width, height, u, sampler });
}
