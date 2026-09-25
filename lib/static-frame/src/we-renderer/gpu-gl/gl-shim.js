// WE GLSL → WebGL 方言适配 (shim)
// 现有管线 preprocessShader 已展开 include + combo 宏 (common.h 的
// hsv2rgb/rotateVec2/greyscale 等函数定义已内联), 残留的 WE 引擎方言
// (texSample2D/frac/saturate/CAST/ApplyBlending/mul...) 在这里转成标准
// GLSL ES 1.0 (WebGL1 可编译), 并注入 fragment precision。
// 实测扫描 (21 官方效果): 残留方言仅 6 类 + precision 缺失 16/21。

// WE 内置函数 → GLSL ES 1.0 shim (注入到 shader 头部)
// 注: 不含 ApplyBlending — common_blending.h 随 #include 展开提供
// `ApplyBlending(const int, vec3, vec3, float)` (GLSL ES 1.0 无函数重载,
// shim 若再定义同名不同签名会报 no matching overloaded)。
// 另: common_blending.h 用 `in vec3` 参数 (ES 3.0 语法, WebGL1 不支持) —
// 由 shim 的 floatify 阶段移除 `in ` 限定符 (见 stripInQualifiers)。
const WE_SHIM_SOURCE = `
// ⚠ 常量取值必须与 WE 官方 assets/shaders/common.h 一致：
// WE 的 M_PI_2 是 **2π**（6.28318530718，命名取自"PI 乘 2"），不是标准数学里的 π/2。
// 此前这里注入标准库值 (1.57079632679489661923)，与随后 #include 展开进来的 common.h
// 定义**同名不同值** —— GLSL ES 1.0 规定这是错误，行为取决于编译器实现（可能报错、
// 也可能只用后出现的那个），是 CPU/GPU 输出分歧的隐患。
#define M_PI 3.14159265359
#define M_PI_HALF 1.57079632679
#define M_PI_2 6.28318530718

#define SQRT_2 1.41421356237
#define SQRT_3 1.73205080756

float frac(float x) { return fract(x); }
vec2 frac(vec2 x) { return fract(x); }
vec3 frac(vec3 x) { return fract(x); }
vec4 frac(vec4 x) { return fract(x); }

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
vec4 saturate(vec4 x) { return clamp(x, 0.0, 1.0); }

// 行向量 × 列主序矩阵 (GLSL mul(rowVec, mat) 语义, 与 CPU 引擎 runtime.mul 一致):
//   v * m = 行向量左乘, result[i] = Σ_j v[j]·m[j + i·rows]
vec4 mul(vec4 v, mat4 m) { return v * m; }
vec3 mul(vec3 v, mat3 m) { return v * m; }
vec2 mul(vec2 v, mat2 m) { return v * m; }

vec4 texSample2D(sampler2D s, vec2 uv) { return texture2D(s, uv); }
vec4 texSample2DProj(sampler2D s, vec3 uv) { return texture2DProj(s, uv); }
// texSample2DLod: WE 显式 mip 采样 (clouds/fire/nitro 等用)。
// 不用 texture2DLodEXT (ANGLE 默认禁用该扩展) — 忽略 lod 用 texture2D
// (mip 细节损失小, 低频效果无感)。
vec4 texSample2DLod(sampler2D s, vec2 uv, float lod) { return texture2D(s, uv); }

vec2 CAST2(float x) { return vec2(x); }
vec2 CAST2(vec2 x) { return x; }
vec3 CAST3(float x) { return vec3(x); }
vec3 CAST3(vec3 x) { return x; }
vec4 CAST4(float x) { return vec4(x); }
vec4 CAST4(vec4 x) { return x; }
vec4 CAST4(vec2 x, float z, float w) { return vec4(x, z, w); }
vec4 CAST4(vec3 x, float w) { return vec4(x, w); }
// CAST3X3: mat4 → mat3 (depthparallax 用)
mat3 CAST3X3(mat3 m) { return m; }
mat3 CAST3X3(mat4 m) { return mat3(m[0].xyz, m[1].xyz, m[2].xyz); }

// atan2(y,x): WE 方言 (fisheye 等用); GLSL 是 atan(y,x)
float atan2(float y, float x) { return atan(y, x); }
vec2 atan2(vec2 y, vec2 x) { return atan(y, x); }

// 注: 不含 rotateVec2 — common.h 随 #include 展开提供 (重复定义报
// "function already has a body")。shimmer 的 rotateVec2(vec4) 宽松调用由
// floatify 阶段的 rotateVec2Vec4Fix 转 .xy。
// 注: 不含 max/min/clamp/mix 重载 — GLSL 内置不可重定义 (built-in functions
// cannot be redefined); 标量+vec 混型由 floatify 阶段的 vecScalarPromote 修复。

// inverse(mat3): perspective 等用 (GLSL ES 1.0 无 inverse 内置)
mat3 inverse(mat3 m) {
  float a = m[0][0], b = m[0][1], c = m[0][2];
  float d = m[1][0], e = m[1][1], f = m[1][2];
  float g = m[2][0], h = m[2][1], i = m[2][2];
  float A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  float det = a * A + b * B + c * C;
  if (det == 0.0) return mat3(1.0);
  float inv = 1.0 / det;
  return mat3(A * inv, B * inv, C * inv,
              (c * h - b * i) * inv, (a * i - c * g) * inv, (b * g - a * h) * inv,
              (b * f - c * e) * inv, (c * d - a * f) * inv, (a * e - b * d) * inv);
}
`;

const FRAG_PRECISION = 'precision highp float;\n';

/**
 * 把预处理的 frag/vert 源码转成 WebGL1 可编译。
 * @param {string} source 预处理后 (include 展开 + combo 宏) 的 shader 源码
 * @param {string} stage 'fragment' | 'vertex'
 * @returns {{source: string}}
 */
export function toWebGLSource(source, stage) {
  if (!source) return { source: '' };
  let body = source;
  // GLSL ES 1.0 要求"先声明后使用" (global scope 变量/函数体引用)。
  // 官方多 pass 头文件 (common_blur.h) 的函数体引用 g_Texture0, 而
  // blurradial/shine gaussian 把 `uniform sampler2D g_Texture0;` 写在
  // `#include` 之后 → DX 允许后声明, GLSL 报 undeclared identifier。
  // 把顶层无条件 uniform 声明提到最前 (条件 #if 内不移动)。
  body = hoistTopLevelUniforms(body);
  // 归一到 WebGL 语义: 见 hoistTopLevelUniforms 的说明（保留 varying 声明,
  // 只把"对它的赋值"重定向到一个提升到文件最前的局部别名 —— 采样语义不变）。
  body = normalizeWrittenVaryings(body, stage);
  // 官方 godrays/shine cast: `const int sampleCount = N;` 参与 float 运算
  // (sampleCount - 1 / i / sampleDrop)。GLSL ES 1.0 二元运算无 int→float
  // 隐式转换 → 提升声明为 float, 并同步提升以此为边界的循环计数器
  // (for (int i = 0; i < sampleCount; ++i) → float i)。须在 floatify 前,
  // 这样 `sampleCount - 1` 的 1 由 floatify 补 .0。
  body = promoteConstIntToFloat(body);
  // GLSL ES 1.0 严格类型: WE shader 的 vec×int/vec−int 宽松写法
  // (官方 DX 编译器允许 vec3 * 2, WebGL 报 wrong operand types) →
  // 把纯整数字面量运算数转 float (只影响数值, 语义不变)。
  // 模式: vecN 表达式 与 int 的 * / - + 运算 → int 补 .0
  body = floatifyIntLiterals(body);
  // GLSL ES 1.0 不支持 `in` 参数限定符 (common_blending.h 的
  // `vec3 ApplyBlending(const int, in vec3 A, ...)`) → 移除 `in `。
  body = stripInQualifiers(body);
  // rotateVec2 vec4 宽松调用 (shimmer: rotateVec2(v_TexCoord, ...) 传 vec4) →
  // 取 .xy (DX vec4→vec2 截断语义; common.h 的 rotateVec2 只收 vec2)。
  body = body.replace(/rotateVec2\s*\(\s*(v_TexCoord|v_TexCoord\.[xy]{2})\s*,/g, 'rotateVec2($1.xy,');
  // max/min/clamp/mix 标量+vec 混型 (nitro: max(0.0, albedo.rgb)):
  // 第一参数标量字面量 → 按第二参数 vec swizzle 提升 (GLSL ES 1.0 无标量+vec
  // 重载)。仅当第二参数带明确 vec swizzle (rgb/xyz/xy/rgba/xyzw) 才转换 —
  // 避免误伤 float 第二参数 (vhs: max(0.00001, dblend) 的 dblend 是 float)。
  body = body.replace(/\b(max|min|clamp|mix)\((\s*[0-9.]+)\s*,\s*([a-zA-Z_]\w*\.(?:rgb|xyz|xy|rgba|xyzw))\s*\)/g,
    (m, fn, scalar, second) => {
      let dim = 3;
      if (/\.(rgba|xyzw)$/.test(second)) dim = 4;
      else if (/\.(xy)$/.test(second)) dim = 2;
      return fn + '(vec' + dim + '(' + scalar.trim() + '),' + second + ')';
    });
  // vecN = texSample2D(...) (vec4) → 赋 vec3 需 .rgb (DX vec4→vec3 截断语义;
  // shimmer: vec3 shimmerColor = texSample2D(...) 报 dimension mismatch)。
  // 贪婪匹配整行, 捕获 texSample2D 闭合括号 (最后的 `)`), 在其后加 .rgb
  body = body.replace(/(vec3\s+\w+\s*=\s*texSample2D\(.*\))(\s*;)/g, '$1.rgb$2');
  // DX 宽松向量维度 → GLSL ES 1.0 严格类型（见 truncateToDeclaredDim 注释）。
  // 启用前提: adapter.js::_tryEffectGpu 的 looksDegenerate 兜底已覆盖
  // "整幅同一 RGBA（含全透明）+ 覆盖度塌陷"，用于拦下这类效果的运行期退化。
  body = truncateToDeclaredDim(body, stage);
  // 注入 WE 方言 shim (frag + vert 都需要: mul/frac 等在 vert 也会出现)
  body = WE_SHIM_SOURCE + '\n' + body;
  if (stage === 'fragment') {
    // WebGL1 fragment 必须显式 precision; 源码已有则跳过
    if (!/precision\s+\w+\s+float/.test(body)) {
      body = FRAG_PRECISION + body;
    }
  }
  return { source: body };
}

/** 名字 → 声明的向量维度（只收本文件能静态确定的：uniform / varying / attribute）。 */
function declaredDimOf(src, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:uniform|varying|attribute)\\s+(vec[234])\\s+' + n + '\\b').exec(src);
  return m ? Number(m[1][3]) : 0;
}

/**
 * `vecN x = <更高维表达式>;` 的赋值截断（HLSL/DX 宽松语义 → GLSL ES 1.0 严格类型）。
 *
 * 报错形态（实测 texture_override.vert）:
 *   `vec2 scale = g_Texture0Resolution / g_Texture1Resolution;`   // 两侧都是 vec4
 *   ERROR: '=' : cannot convert from 'highp 4-component vector' to 'highp 2-component vector'
 * DX 允许这种赋值并按目标维度取前 N 分量，WebGL 直接拒绝 ⇒ 整条效果在 GPU 上编译不过、
 * 回退 CPU 逐像素解释器。CPU 解释器（glsl/transpile.js::declInit「P1-35」）就是取前 N 分量，
 * 因此补 `.xy/.rgb` 与 CPU 参考**语义一致**（数值验证: vec4(1,2,3,4)/vec4(1,1,1,1) → (1,1)）。
 */
function truncateToDeclaredDim(src, stage) {
  void stage;
  const lines = src.split('\n');
  const out = lines.map((line) => {
    const m = /^(\s*)(vec[234])\s+([A-Za-z_]\w*)\s*=\s*(.+);(\s*)$/.exec(line);
    if (!m) return line;
    const [, indent, type, name, rhs, tail] = m;
    const want = Number(type[3]);
    if (/\.\s*[xyzwrgba]{1,4}\s*$/.test(rhs)) return line;
    if (new RegExp('^\\s*(vec' + want + '|float)\\s*\\(').test(rhs)) return line;
    let maxDim = 0;
    for (const id of rhs.matchAll(/(?<![\w.])([A-Za-z_]\w*)/g)) {
      const d = declaredDimOf(src, id[1]);
      if (d > maxDim) maxDim = d;
    }
    if (!maxDim || maxDim <= want) return line;
    const sw = want === 2 ? 'xy' : 'rgb';
    return indent + type + ' ' + name + ' = (' + rhs + ').' + sw + ';' + tail;
  });
  return out.join('\n');
}

// 移除 GLSL ES 3.0 的 `in` 参数限定符 (WebGL1 = ES 1.0 不支持):
// `vec3 f(in vec3 A)` → `vec3 f(vec3 A)`; `const in vec3` → `const vec3`。
function stripInQualifiers(src) {
  return src
    .replace(/\bconst\s+in\s+/g, 'const ')
    .replace(/\bin\s+(vec[234]|float|int|bool|mat[234])\b/g, '$1');
}

// GLSL ES 1.0 要求全局声明先于使用。官方多 pass 头 (common_blur.h) 函数体
// 引用 g_Texture0, 而 blurradial/shine gaussian 的 uniform 声明在 #include
// 之后 → 把顶层 (非 #if 条件内) 的 uniform 声明行提到源码最前。
function hoistTopLevelUniforms(src) {
  // 归一换行: 工坊 shader 多为 CRLF。按行处理时行尾残留的 '\r' 会让**锚定**正则
  // （/^…$/）静默失配 —— 本函数原先靠非锚定写法侥幸可用，但任何按行精确匹配的
  // 扩展（例如后续要按声明类型/名字改写 varying）都会踩坑。统一成 '\n' 再处理。
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const decls = [];
  const rest = [];
  let ifDepth = 0;
  for (const line of lines) {
    // 预处理后 #if/#endif 成对; 条件内不移动
    if (/^\s*#\s*(if|ifdef|ifndef)/.test(line)) ifDepth++;
    else if (/^\s*#\s*endif/.test(line)) ifDepth = Math.max(0, ifDepth - 1);
    const m = /^\s*(?:uniform|varying)\s+[\w]+\s+[\w]+\s*;/.exec(line);
    if (m && ifDepth === 0) decls.push(line);
    else rest.push(line);
  }
  if (!decls.length) return src;
  return decls.join('\n') + '\n' + rest.join('\n');
}

/**
 * 片元里**写** varying 的归一（WE/dx 允许，WebGL/ANGLE 拒绝）。
 *
 * 报错形态: `'l-value required (can't modify a varying "v_TexCoord")'`
 * 实例: geometric_transform.frag 先 `v_TexCoord.y += …` 改坐标再采样；
 * 这类效果在 GPU 路径整条编译不过 → 回退 CPU 逐像素解释器。
 *
 * 做法（关键: **不能**把 varying 声明整体降级成局部变量）:
 *   1. 保留 `varying T name;` 声明 —— 它之外的地方仍按插值输入读取；
 *   2. 在文件最前增加局部别名 `T we_v_<name>;`（与 uniform 一同提前）；
 *   3. 在 `main()` 开头插入 `we_v_<name> = name;`（取插值输入作为初值）；
 *   4. 把源码里对 `name` 的**赋值目标**改写成别名（整变量/分量/下标三种形态）。
 * 于是"先改坐标再采样"的语义完全保留（写的是别名，读 `name` 的地方若在写之后
 * 应当读别名 —— 见下方第 4 步的实现说明），而编译不再碰只读 varying。
 *
 * ⚠ 为什么第 1 步不能省: varying 声明原先被 hoistTopLevelUniforms 提到函数之前，
 * 恰好遮住了"helper 函数写在声明之前"的先声明后使用问题。整体降级为局部变量后
 * 它不再被提前，helper 里引用会报 undeclared identifier（本轮实测踩过）。
 */
function normalizeWrittenVaryings(src, stage) {
  if (stage !== 'fragment') return src;
  const body = src.replace(/\r\n?/g, '\n');
  const declRe = /^[ \t]*varying[ \t]+(vec[234]|float|int)[ \t]+([A-Za-z_]\w*)[ \t]*;[ \t]*$/gm;
  const targets = [];
  for (const m of body.matchAll(declRe)) {
    const [, type, name] = m;
    if (varyingWritten(body, name)) targets.push({ type, name, alias: 'we_v_' + name });
  }
  if (!targets.length) return src;
  let out = body;
  // 2) 声明行与"初值赋值行"都要**避开**第 4 步的全局改名：
  //    · 声明行必须保持 varying 原名字（它是与顶点侧配对的插值输入）；
  //    · 初值行的左值是别名、右值是 varying 原名 —— 若被改名就成了 `alias = alias` 自引用。
  //    把两行的整行换成占位符，改名后再还原。
  const MARK = '\u0001';
  const stash = [];
  const stashLine = (line) => { stash.push(line); return MARK + 'S' + (stash.length - 1) + MARK; };
  for (const t of targets) {
    // 声明行：内容不变，仅隐藏
    out = out.replace(new RegExp('^([ \\t]*varying[ \\t]+' + t.type + '[ \\t]+' + t.name + '[ \\t]*;)$', 'm'),
      (mm) => stashLine(mm));
    // 初值行：插到 main 开头，同时隐藏
    out = out.replace(/(\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{)/,
      (mm) => mm + '\n' + stashLine('\t' + t.alias + ' = ' + t.name + ';'));
  }
  // 3) 该 varying 的**全部引用**（读与写）改到别名上，但声明行/初值行已被隐藏。
  //    为什么要连读一起改: 官方写法是"先改坐标、再用改后的坐标采样"（geometric_transform
  //    的写在前、采样在后）。只改赋值左侧的话，采样仍读插值原值 ⇒ 与 WE 语义不符。
  //    别名在 main 开头初始化为同名插值值，因此"写之前"的读同样正确。
  for (const t of targets) {
    const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(?<![\\w.])' + n + '(?![\\w])', 'g'), t.alias);
  }
  // 4) 还原被隐藏的行
  out = out.replace(new RegExp(MARK + 'S(\\d+)' + MARK, 'g'), (mm, i) => stash[Number(i)]);
  const aliasDecls = targets.map((t) => t.type + ' ' + t.alias + ';').join('\n');
  return aliasDecls + '\n' + out;
}

/** 片元源码里某个 varying 是否被赋值（整变量 / 分量 / 下标）。 */
function varyingWritten(src, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![\\w.])' + n + '\\s*(\\.\\s*[xyzwrgba]{1,4}\\s*)?(\\[[^\\]]*\\]\\s*)?[-+*/]?=(?![=])').test(src);
}

// 官方 godrays/shine cast shader: `const int sampleCount = N;` 参与 float 运算
// (sampleCount - 1、i / sampleDrop)。GLSL ES 1.0 二元运算无 int→float 隐式
// 转换 → 把这类"循环边界 const int"提升为 float, 并同步提升其循环计数器。
// 安全门: 仅当该 const int 未用作数组下标 [X], 且循环体变量未作数组下标时
// 才提升 (提升会改变 i 的类型, 数组下标必须是 int)。
function promoteConstIntToFloat(src) {
  let out = src;
  const re = /const int (\w+) = (\d+);/g;
  let m;
  const jobs = [];
  while ((m = re.exec(src))) {
    const name = m[1], num = m[2];
    // 数组下标 [name] → 必须保持 int, 跳过
    if (new RegExp('\\[' + name + '\\]').test(src)) continue;
    // 找以它为边界的 for (int i = 0; i < name; ++i)
    const loopRe = new RegExp('for\\s*\\(\\s*int\\s+(\\w+)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*' + name + '\\s*;\\s*\\+\\+\\1\\s*\\)', 'g');
    let lm;
    const loops = [];
    while ((lm = loopRe.exec(src))) {
      const iv = lm[1];
      if (new RegExp('\\[' + iv + '\\]').test(src)) { loops.length = 0; break; } // 循环体用数组下标 → 不提升
      loops.push(lm[0]);
    }
    if (!loops.length) continue;
    jobs.push({ name, num, loops });
  }
  for (const j of jobs) {
    out = out.replace(new RegExp('const int ' + j.name + ' = ' + j.num + ';'), 'const float ' + j.name + ' = ' + j.num + '.0;');
    for (const l of j.loops) {
      const lm = /for\s*\(\s*int\s+(\w+)\s*=\s*0\s*;/.exec(l);
      if (!lm) continue;
      const iv = lm[1];
      const repl = 'for (float ' + iv + ' = 0.0; ' + iv + ' < ' + j.name + '; ' + iv + ' += 1.0)';
      out = out.replace(l, repl);
    }
  }
  return out;
}

// 把 GLSL 源码里与 vec/float 运算相邻的整数字面量补 .0 (vec3 * 2 → vec3 * 2.0,
// float x = 0 → 0.0, CAST3(0) → CAST3(0.0), int 上下文不碰)。
// GLSL ES 1.0 严格类型: WE 宽松写法 (官方 DX 编译器允许) 报 wrong operand types。
// 规则:
//   - * / 后孤立整数: 恒转 (二元算术)
//   - + - 后孤立整数: 前是 = ( , [ 或类型关键字 (一元/声明) 不转, 否则转
//   - ( 后孤立整数: 后跟 ) 或算术符转 (CAST3(0) / float(2+2.0)), 后跟 , 不转
//     (函数 int 参数 ApplyBlending(31,))
//   - float/vec 声明后的 = 孤立整数: 转 (float x = 0 → 0.0)
// 科学计数法 (1e-10) 全程保护。
function floatifyIntLiterals(src) {
  const sci = [];
  // 1) 提取并占位科学计数法 (含符号 e+/-)
  let s = src.replace(/(\d)([eE][+\-]\d+)/g, (m, d, exp) => {
    sci.push(d + exp);
    return d + '\u0001' + (sci.length - 1) + '\u0002';
  });
  // 2) 保护一元负号/声明上下文的 + - (前是 = , [ 或类型关键字, 允许中间空白):
  //    for (int i = -2) 的 - 2 不得转成 - 2.0 (int 类型错误)。
  //    替换时 pre 已在源中保留, 占位只存 op+num。
  const unary = [];
  s = s.replace(/([=(\[,]|\b(?:int|float|vec[234]|bool))\s*([+\-])\s*(\d+)(?!\.)(?![\w])/g,
    (m, pre, op, num) => {
      unary.push(op + ' ' + num);
      return pre + '\u0003' + (unary.length - 1) + '\u0004';
    });
  // 2b) ( 后正数: CAST3(0) / float(2 + 2.0) / smoothstep(0, 0.5, x) 的 ( 后
  //     整数转 (后跟 ) 或算术符 或 ,)。ApplyBlending 的 int blendMode 参数
  //     (如 ApplyBlending(31, ...)) 在转换后还原 (float→int 不合法)。
  s = s.replace(/\(\s*(\d+)(?!\.)(?![\w])(?=[+\-*\/\s]|\)|,)/g, (m, num) => '( ' + num + '.0');
  // 2b2) 函数参数中的 , 整数, 或 , 整数): smoothstep(feather, 0, dist) 的 0
  //     转 0.0 (int edge 与 float 混型)。排除数组/构造 (用 [ 或 vecN() 内部? 难判 —
  //     保守: 仅当 , 整数 后跟 , 或 ) 且行内前面有非 int 声明)。
  //     vhs.vert: smoothstep(0, 2, 1 + 0.5*sin(...)) — `, 1 +` 的 1 也转
  //     (int + vec3 混型; 仅 int 构造/数组上下文罕见, WE shader 未用)。
  s = s.replace(/,\s*(\d+)(?!\.)(?![\w])(?=\s*,|\s*\)|\s*[+\-*\/])/g, (m, num) => ', ' + num + '.0');
  // 还原 ApplyBlending 的 int 参数: ApplyBlending( 31.0, → ApplyBlending( 31,
  // (仅去掉 .0, 保留原有逗号 — 不能把逗号放进替换, 否则双逗号)
  s = s.replace(/(ApplyBlending\s*\()\s*(\d+)\.0(?=\s*,)/g, (m, pre, num) => pre + ' ' + num);
  // 2c) float/vec 声明后的 = 孤立整数: float x = 0 → 0.0 (int→float 赋值错误)
  s = s.replace(/(\b(?:float|vec[234])\s+\w+\s*=\s*)(\d+)(?!\.)(?![\w])/g, (m, pre, num) => pre + num + '.0');
  // 2c2) 分量/成员赋值孤立整数: v_TexCoord.w = 0 / v_PointDelta.x *= 100 /
  //     v_PointerUVLast.xy += 0.5 → 0.0 (vec 分量是 float, GLSL ES 1.0
  //     int→float 赋值不合法; cursorripple/fluidsimulation/blur gaussian 用)。
  //     仅匹配 `标识符.分量` 形式的赋值目标 (排除数组/构造)。
  s = s.replace(/(\b\w+\.\w+\s*[*\/+\-]?=\s*)(\d+)(?!\.)(?![\w])/g, (m, pre, num) => pre + num + '.0');
  // 3) 转换剩余二元运算符后的孤立整数 (* / + -)
  s = s.replace(/([*\/+\-])\s*(\d+)(?!\.)(?![\w])/g, (m, op, num) => op + ' ' + num + '.0');
  // 4) 还原一元上下文 + 科学计数法
  s = s.replace(/\u0003(\d+)\u0004/g, (m, i) => unary[Number(i)]);
  return s.replace(/\u0001(\d+)\u0002/g, (m, i) => sci[Number(i)]);
}

/**
 * 快速判定 shader 是否含 WE 方言 (需要 shim)。
 */
export function needsShim(source) {
  return /texSample2D|frac\(|saturate|CAST[234]\(|ApplyBlending|PerformBlend|GetUVBlend|mul\(/.test(source);
}
