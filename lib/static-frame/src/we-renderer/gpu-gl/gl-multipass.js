// WE GPU 后端 — 多 pass FBO 链执行器 (bloom 等)
// effect.json 的 fbos/passes 结构: 逐 pass 以 target FBO 分辨率渲染, 输入纹理
// 来自 "previous"(原始) 或已渲染 FBO; 无 target 的 pass 输出最终结果。
// 与 CPU _renderGlslMultiPass 同语义, 差异仅在 WebGL FBO 乒乓 + readPixels。
// 任何失败抛错 → 调用方回退 CPU。
import { createGLContext, destroyGLContext } from './gl-core.js';
import { runEffectOnGL } from './gl-effect.js';

let _gl = null;
function getGL() {
  if (!_gl) {
    _gl = createGLContext(64, 64);
    if (!_gl) throw new Error('WebGL 不可用');
  }
  return _gl;
}

// 修复: 本模块自持的 GL 上下文原先无人销毁 (headless-gl 上下文 GC 回收不及时,
// 上游要求显式 STACKGL_destroy_context) — 渲染收尾/进程退出时由调用方调用。
export function disposeGL() {
  destroyGLContext(_gl);
  _gl = null;
}

/**
 * 执行多 pass 链。
 * @param {object} opts
 * @param {object} opts.ef 合并后 effect 定义 { fbos, passes }
 * @param {{width,height,rgba}} opts.img 输入帧
 * @param {(materialPath) => {fragPre,vertPre,uniforms}} opts.passShader 材质 → 编译结果
 * @param {object} opts.uPerPass 每 pass 的 uniform 组装函数 (pass, compiled, inputTex, bound, outW, outH) => u
 * @param {function} [opts.onPass] 逐 pass 回调 (pass, out, ctx) —— 诊断取证用 (DSH_WE_FX_DUMP)
 * @param {Array} [opts.passTrace] 诊断: 逐 pass 的 {pass, idx, target, binds, src} 记录
 * @returns {{width,height,rgba}} 结果
 */
export function runMultiPassOnGL({ ef, img, passShader, uPerPass, onPass, passTrace }) {
  const W = img.width, H = img.height;
  const fbos = {};
  for (const f of ef.fbos || []) {
    const sc = f.scale || 1;
    fbos[f.name] = { width: Math.max(1, Math.round(W / sc)), height: Math.max(1, Math.round(H / sc)), rgba: null };
  }
  // 取证记录表: pass 对象 → 记录。**必须在循环外先建好** —— passShader 内部要按 pass
  // 写回 src (它与 uPerPass 拿到的 pass 是同一个对象引用, 这样两处都不必猜下标)。
  const recByPass = new Map();
  const recFor = (pass) => {
    if (!passTrace) return null;
    let rec = recByPass.get(pass);
    if (!rec) {
      rec = { pass, idx: passTrace.length, target: pass.target || null, binds: [], src: null };
      recByPass.set(pass, rec);
      passTrace.push(rec);
    }
    return rec;
  };
  let last = img;
  for (const pass of ef.passes || []) {
    recFor(pass); // 先登记, 让 passShader 能写回 src (与 CPU 侧 src= 同一字段)
    const compiled = passShader(pass.material);
    if (!compiled) continue;
    const target = pass.target ? fbos[pass.target] : null;
    const outW = target ? target.width : W;
    const outH = target ? target.height : H;
    // 纹理绑定: bind[i].name → "previous"(原始) 或 FBO 名
    const bound = [];
    for (const b of pass.bind || []) {
      if (b.name === 'previous') bound[b.index] = img;
      else if (fbos[b.name] && fbos[b.name].rgba) bound[b.index] = fbos[b.name];
      else bound[b.index] = null;
    }
    const inputTex = bound[0] || img;
    // sampler uniform 组装 (与 CPU 路径一致): g_TextureN → bound[N]
    const u = uPerPass ? uPerPass(pass, compiled, inputTex, bound, outW, outH) : {};
    const out = runEffectOnGL({
      fragPre: compiled.fragPre,
      vertPre: compiled.vertPre,
      u,
      width: outW, height: outH,
    });
    if (!out) continue;
    if (onPass) onPass(pass, out, { outW, outH, target: pass.target || null, bound, rec: recByPass.get(pass) || null });
    if (target) { target.rgba = out.rgba; target.width = out.width; target.height = out.height; }
    else last = out;
  }
  return last;
}
