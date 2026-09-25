// WE GLSL 预处理: #include 展开 + combo 宏注入 + uniform material 映射解析
import preprocess from '@shaderfrog/glsl-parser/preprocessor/index.js';

// 花括号平衡扫描 (字符串字面量感知): 元注释 JSON 可含嵌套对象
// ("options":{...} / "range":{...}), 非贪婪正则会在首个 } 截断 → JSON.parse 失败 → 静默丢失。
// parseMetaGL 已用此法 (P0-14 回移), parseMeta 与之共用。
function readBalancedJson(source, openIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(openIdx, i + 1);
    }
  }
  return null;
}

// 解析 shader 源码里的元注释:
//   // [COMBO|COMBO_OFF] {"material":"...","combo":"KERNEL","default":0,...} → combos 默认值
//   uniform <type> <name>; // {"material":"xxx",...}                          → material→uniform 映射
// combos:   combo 名 → { default, comboOff?, textureUniform? } (GLS-20: [COMBO_OFF] + 纹理派生 combo)
// uniforms: uniform 名 → { material, type, default?, ...元注释全字段 } (GLS-15/P1-44: default 保留,
//           executor buildUniforms 在材质缺值时落该默认)
export function parseMeta(source) {
  const combos = {}; // combo 名 → { default, comboOff?, textureUniform? }
  const uniforms = {}; // uniform 名 → { material, type, default?, ... }
  let m;
  const comboRe = /\/\/\s*\[(COMBO|COMBO_OFF)\]\s*\{/g;
  while ((m = comboRe.exec(source))) {
    const raw = readBalancedJson(source, m.index + m[0].length - 1);
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw);
      if (meta.combo && meta.default !== undefined) {
        combos[meta.combo] = { default: String(meta.default), comboOff: m[1] === 'COMBO_OFF' };
      }
    } catch { /* 坏注释忽略 */ }
  }
  // GLS-23: 精度限定 (uniform highp sampler2D) 可选
  const unifRe = /uniform\s+(?:(?:lowp|mediump|highp)\s+)?([\w]+)\s+([\w]+)\s*;\s*\/\/\s*\{/g;
  while ((m = unifRe.exec(source))) {
    const raw = readBalancedJson(source, m.index + m[0].length - 1);
    let meta = {};
    if (raw) { try { meta = JSON.parse(raw); } catch { /* keep {} */ } }
    uniforms[m[2]] = { ...meta, material: meta.material || null, type: m[1] };
    // GLS-20: 纹理派生 combo (MASK 等) — uniform 带 combo+opacitymask 且无 [COMBO] 默认注释
    if (meta.combo && !combos[meta.combo]) {
      combos[meta.combo] = { default: '0', textureUniform: meta.mode === 'opacitymask' ? m[2] : null };
    }
  }
  // 无注释的 uniform 也收集 (引擎注入类, material=null)
  const unifPlain = /uniform\s+(?:(?:lowp|mediump|highp)\s+)?([\w]+)\s+([\w]+)\s*;/g;
  while ((m = unifPlain.exec(source))) {
    if (!uniforms[m[2]]) uniforms[m[2]] = { material: null, type: m[1] };
  }
  return { combos, uniforms };
}

// include 展开: resolveInclude(rel) → 源码字符串
// P1-37/GLS-21/F-13: 行首锚定 (注释内不展开) + 按位置拼接 (重复文本不错位);
// seen 语义修正: 只做展开栈防环, 不再跨兄弟吞并合法重复 include;
// P1-36: 缺失 include 经 opts.onWarn 上报 (不再静默删除)
export function expandIncludes(source, resolveInclude, opts = {}) {
  const onWarn = opts.onWarn || null;
  const stack = opts.stack || [];
  const re = /^[ \t]*#include\s+"([^"]+)"/gm; // 行首锚定: 注释内的 #include 不匹配
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(source))) {
    out += source.slice(last, m.index);
    last = m.index + m[0].length;
    const inc = m[1];
    let src = '';
    try { src = resolveInclude ? resolveInclude(inc) : ''; } catch {}
    if (!src) {
      if (onWarn) onWarn(`#include "${inc}" 未解析, 已删除`);
      continue;
    }
    if (stack.includes(inc)) {
      if (onWarn) onWarn(`#include "${inc}" 循环包含, 跳过`);
      continue;
    }
    out += '\n' + expandIncludes(src, resolveInclude, { onWarn, stack: stack.concat([inc]) }) + '\n';
  }
  out += source.slice(last);
  return out;
}

// WE 专有预处理指令 `#require <Feature>` (LightingV1/LightingV2/...): 引擎用它选择
// shader 变体 (运行时特性门), 对源码文本没有任何贡献。shaderfrog 预处理器不认识它 ⇒
// 报 `Expected control line ... but "#" found` **并把错误位置指到下一个 #if 行**
// (实测 genericparticle.frag: 真正成因是展开后第 685 行的 `#require LightingV1`,
//  报错位置却是第 246 行的 `#if LIGHTING` —— 逐行留一法定位, 见
//  scripts/tmp-glsl-mat-survey.mjs)。删除该行是纯文本等价: 19 个 defaultprojects 的
// 全部 shader (project shaders/ + assets/shaders 可达闭包) 都不含 #require, 故对
// 既有场景零影响; 它解锁的是 workshop 壁纸大量使用的 generic4/genericimage4/
// genericparticle/chroma4/foliage4/fur4。
const REQUIRE_RE = /^[ \t]*#require\b[^\n]*$/gm;

// shaderfrog 的词法器把一些 GLSL ES 1.0 里**合法**的标识符当成保留字，任何以此命名的
// 变量都会让整个 shader 解析失败，且报错位置回溯到外层语句（实测
// `vec4 sample = …` 报在 for 行、`vec4 result = CAST4(0.0), sample;` 报在列 28）。
// 逐个实测（node -e "parse('void main(){ float X; }')"，见 test/units.mjs 的同类断言）：
//   sample / buffer / shared / patch / precise / subroutine  → 解析失败
//   image / input / output / filter / active / cast / namespace / using → 均正常
// 改名是纯文本等价：只替换独立标识符（词边界），不碰 texSample2D / sampleCount /
// sampler2D；同一份源码内一致替换，语义不变。
//
// 覆盖到的真实语料：pulse_.frag `vec4 sample = texSample2D(…)`、
// down_sample.frag / light_map.frag `vec4 sample;`、bokeh 的 downsample.frag
// `vec4 result = CAST4(0.0), sample;`。此前只在材质路径启用，效果路径没启用 ⇒
// 这些效果被整条丢弃（pulse_ / bloom / bokeh_blur 等）。
const PARSER_RESERVED = ['sample', 'buffer', 'shared', 'patch', 'precise', 'subroutine'];
export function renameReservedSample(src) {
  let out = src;
  for (const w of PARSER_RESERVED) out = out.replace(new RegExp('\\b' + w + '\\b', 'g'), w + '__');
  return out;
}

/**
 * 条件编译指令配平 —— 真实语料里的 `#if/#endif` 并不总是配对。
 *
 * 实测 issue #3（场景 3582367840 的 vert）：文件里**多了一个 `#endif`**
 * （展开后第 109 行，深度被压到 -1），shaderfrog 的预处理器直接抛
 *   `Expected control line, end of input, or text but "#" found.  --> location:109:1`
 * 整个效果因此被丢弃；而 WE 自带的编译器容忍这种写法（壁纸在 WE 里是正常的）。
 *
 * 处理方式（与"容忍"对齐，只动已经坏掉的地方）：
 *   · 深度为 0 时出现的 `#endif` → 丢弃该行；
 *   · 深度为 0 时出现的 `#else`/`#elif` → 丢弃该行；
 *   · 文件结束时深度 > 0 → 补齐 `#endif`。
 * 若源码本来就配平，本函数**逐字节不改**（等价于 no-op），并可用 onWarn 留痕。
 */
export function balanceConditionals(src, onWarn) {
  const lines = String(src).split('\n');
  const out = [];
  let depth = 0;
  let dropped = 0;
  let added = 0;
  for (const line of lines) {
    const m = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif)\b/.exec(line);
    const kw = m ? m[1] : null;
    if (kw === 'if' || kw === 'ifdef' || kw === 'ifndef') { depth++; out.push(line); continue; }
    if (kw === 'endif') {
      if (depth === 0) { dropped++; continue; }   // 多余的 #endif
      depth--; out.push(line); continue;
    }
    if (kw === 'else' || kw === 'elif') {
      if (depth === 0) { dropped++; continue; }   // 无主 #else/#elif
      out.push(line); continue;
    }
    out.push(line);
  }
  for (let i = 0; i < depth; i++) { out.push('#endif'); added++; }
  if ((dropped || added) && typeof onWarn === 'function') {
    try { onWarn('条件指令配平: 丢弃 ' + dropped + ' 行、补齐 ' + added + ' 个 #endif'); } catch { /* ignore */ }
  }
  return dropped || added ? out.join('\n') : src;
}

// 完整预处理: include 展开 → combo defines 注入 → shaderfrog preprocess
// P2-23: opts.meta — 调用方 (executor.compileGlsl) 已对同一源码跑过 parseMeta 时
// 直接复用, 免此处再全文正则扫描一遍
export function preprocessShader(source, { defines = {}, resolveInclude = null, onWarn = null, meta = null } = {}) {
  let src = source;
  if (resolveInclude) src = expandIncludes(src, resolveInclude, { onWarn });
  // `#require` 是 WE 变体选择指令, 对源码文本无贡献 (见 REQUIRE_RE 注释)
  if (src.indexOf('#require') >= 0) src = src.replace(REQUIRE_RE, '');
  // 若 combo 无默认且未注入 → 显式补默认值避免 #if 未定义 (shaderfrog 求值为 0)
  const m = meta || parseMeta(src);
  const allDefines = {};
  for (const [k, v] of Object.entries(m.combos)) {
    if (defines[k] === undefined) allDefines[k] = String(v && v.default !== undefined ? v.default : v);
  }
  // combo 值一律归一为**字符串**: 材质 `passes[].combos` 常是数值 (官方 JSON 里
  // `"lightmap": 1`), 而 shaderfrog 的预处理器在 `#if A || B` 这类表达式里遇到**数值**
  // 宏会丢 token (报语法错/静默丢掉分支) —— 效果链线程实测复现。数值与字符串对本
  // 引擎语义等价 (combo 只参与 #if 的整型比较), 归一后两侧走同一条路径。
  for (const [k, v] of Object.entries(defines)) {
    allDefines[k] = v === undefined || v === null ? '0' : String(v);
  }
  // 条件指令配平：真实壁纸里存在多余/缺失的 #if/#endif（WE 自带编译器容忍），
  // 不配平会让 shaderfrog 预处理器整条报错 —— 见 balanceConditionals 注释。
  src = balanceConditionals(src, onWarn);
  return preprocess(src, { defines: allDefines });
}

// ---- GL 路径专用（scene-gl）：客户端拼 define 头用，host 绝不求值 #if ----
// parseMetaGL 与 CPU 路径 parseMeta 并存：保留 mode/combo/default/direction/conversion
// 全字段 + [COMBO_OFF] + 纹理派生 combo（MASK 无默认元注释 → default '0' + textureUniform）。
// 附录 §6.3 全文定稿。
//
// 嵌套花括号修复（sf: foliagesway MODE / shake NOISE+DIRECTION）：元注释 JSON 可含
// 嵌套对象（"options":{"Vertex":1,"UV":0}），非贪婪正则 (\{[\s\S]*?\}) 会在首个 }
// 截断 → JSON.parse 失败 → combo 静默丢失 → 客户端 #define 缺失 → #if MODE 编译错。
// 改用花括号平衡扫描（字符串字面量感知）— 函数已上移与 CPU 路径 parseMeta 共用。

export function parseMetaGL(source) {
  const combos = {};   // name -> { default, comboOff?, textureUniform? }
  const uniforms = {}; // name -> { material, type, mode?, combo?, default?, direction?, conversion? }
  let m;
  const comboRe = /\/\/\s*\[(COMBO|COMBO_OFF)\]\s*\{/g;
  while ((m = comboRe.exec(source))) {
    const raw = readBalancedJson(source, m.index + m[0].length - 1);
    if (!raw) continue;
    try {
      const meta = JSON.parse(raw);
      if (meta.combo && meta.default !== undefined)
        combos[meta.combo] = { default: String(meta.default), comboOff: m[1] === 'COMBO_OFF' };
    } catch { /* 坏注释忽略 */ }
  }
  const unifRe = /uniform\s+([\w]+)\s+(\w+)\s*;\s*\/\/\s*\{/g;
  while ((m = unifRe.exec(source))) {
    const raw = readBalancedJson(source, m.index + m[0].length - 1);
    let meta = {};
    if (raw) { try { meta = JSON.parse(raw); } catch { /* keep {} */ } }
    uniforms[m[2]] = { material: meta.material || null, type: m[1], ...meta };
    if (meta.combo && !combos[meta.combo])
      combos[meta.combo] = { default: '0', textureUniform: meta.mode === 'opacitymask' ? m[2] : null };
  }
  const plain = /uniform\s+([\w]+)\s+(\w+)\s*;/g;
  while ((m = plain.exec(source))) if (!uniforms[m[2]]) uniforms[m[2]] = { material: null, type: m[1] };
  return { combos, uniforms };
}

// ---- shake.frag 旧版锯齿数学修正（sf35）─────────────────────────────────────
// 背景: 2023 前后 pkg 捆绑的 shake.frag 把相位裁到 [0, π/2):
//   offset = sin(frac(time / M_PI_2) * M_PI_2)   ← sin 在段边界从 ~1 跳回 0
// 每 π/2/speed 秒产生一次硬跳变（本机实测 1080p 人物区 ~2.7px 瞬移 = "闪动"）。
// 官方已在后续引擎版本修复（Steam 讨论帖, WE 作者 Biohazard 确认的最终形态）:
// 时间切片 frac(T·w)·6.28 — 相位走完整 2π, sin(0)=sin(2π) 回绕连续 → 平滑往返。
// 官方翻译新增 ui_editor_properties_shake_phase 亦证实现行 shader ≠ 旧快照。
// 本函数: 检测旧版特征 → 替换为 2π 连续公式; 已是新版（含 6.28 切片/phase）不动。
const SHAKE_OLD_NOISE0 = /\bfloat\s+time\s*=\s*g_Speed\s*\*\s*g_Time\s*\+\s*flowPhase\s*;[\s\S]*?\boffset\s*=\s*sin\s*\(\s*frac\s*\(\s*time\s*\/\s*M_PI_2\s*\)\s*\*\s*M_PI_2\s*\)/;
const SHAKE_OLD_NOISE1 = /vec4\s+sines\s*=\s*flowPhase\s*\+\s*frac\s*\(\s*g_Speed\s*\*\s*g_Time\s*\/\s*M_PI_2\s*\*\s*vec4\s*\(/;
export function patchShakeFrag(frag) {
  let out = frag, patched = [];
  // NOISE=0 路径: time 切片 6.28 + sin(time) 完整正弦
  if (SHAKE_OLD_NOISE0.test(out)) {
    out = out.replace(
      /\bfloat\s+time\s*=\s*g_Speed\s*\*\s*g_Time\s*\+\s*flowPhase\s*;/,
      'float time = frac(g_Speed * g_Time / 6.28) * 6.28 + flowPhase; // sf35: 2π 切片 (官方修复, 回绕连续)',
    );
    out = out.replace(
      /\boffset\s*=\s*sin\s*\(\s*frac\s*\(\s*time\s*\/\s*M_PI_2\s*\)\s*\*\s*M_PI_2\s*\)\s*;/,
      'offset = sin(time); // sf35: 完整正弦 (sin(0)=sin(2π) 连续)',
    );
    patched.push('noise0');
  }
  // NOISE=1 路径: 同款 6.28 切片 (各分量 sin 回绕连续)
  if (SHAKE_OLD_NOISE1.test(out)) {
    out = out.replace(
      /vec4\s+sines\s*=\s*flowPhase\s*\+\s*frac\s*\(\s*g_Speed\s*\*\s*g_Time\s*\/\s*M_PI_2\s*\*\s*(vec4\s*\([^)]*\))\s*\)\s*\*\s*M_PI_2\s*;/,
      'vec4 sines = flowPhase + frac(g_Speed * g_Time * $1) * 6.28; // sf35: 2π 切片 (官方修复)',
    );
    patched.push('noise1');
  }
  return { frag: out, patched };
}
