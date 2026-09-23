// WE GPU 效果适配层 —— 把 gpu-gl 的 WebGL 执行器接回 SceneRenderer 的**热路径**。
//
// 为什么需要这个文件: `_tryEffectGpu` / `_getGpuBackend` 这两个挂载点随
// "移除 scene-anim 动画方向, 聚焦静态帧" 重构一起消失, 只留下引用方
// (死文件 render/passes.js 的存在性判断 + worker 里的诊断守卫), 于是
// `gpu-gl/` 那一整套实现成了无法抵达的代码 —— 实测 254/349 次 `gpuBackend=false`
// 根因在此 (不是"驱动不稳"), 详见 docs/SCENE-FRAME-PERF.md §八。
//
// 实测依据 (identity shader, 4096x4096): runEffectOnGL 正确性 maxΔ=0, 单 pass
// 13–24ms (含 FBO + readPixels 回读); CPU 同尺寸单次采样需 250–450ms。
//
// 开关与回退 (设计约束):
//   - 开关: `SceneRenderer.gpuAccel` (opts.gpuAccel === true)。**默认关闭** ——
//     GPU 输出与 CPU 存在浮点/采样实现差异, 必须由用户显式选择, 且帧缓存键里
//     已含 gpuFlag (index.js), 两种模式不会互相命中。
//   - 回退: 任何一步失败 (无 supreium-headless-gl / 无驱动 / 上下文创建失败 /
//     shader 编译失败 / 尺寸不符) 一律返回 null, 调用方继续走 CPU 内核 ——
//     **GPU 不可用绝不能影响渲染可用性**。
//   - 熔断: 连续失败达阈值后锁定为不可用, 不再逐效果付异常开销。
//
// 已知语义差异 (有意保留, 未在本层修正):
//   CPU GLSL 解释器对**辅助槽纹理**用 REPEAT 采样 (integration.js 的 __glslRepeat),
//   而 gpu-gl 的 uploadTextureData 对所有纹理统一 CLAMP_TO_EDGE。对位移/遮罩类
//   采样跨 [0,1] 的效果 (waterripple 等) 两者可能产生可见差异。修它需要按槽位
//   区分 wrap, 而纹理在 gpu-gl 里按 texData 对象全局缓存 —— 同一张纹理可能同时
//   当主图 (CLAMP) 与辅助槽 (REPEAT), 简单改会串。**先量化差异再决定是否值得动。**
import { getWebGL } from './gl-core.js';
import { runEffectOnGL, runEffectChainOnGL } from './gl-effect.js';
import { buildUniforms } from '../glsl/executor.js';

// ── 后端状态 (进程内) ────────────────────────────────────────────────────────
// unknown: 未探测; ok: 可用; off: 已判定不可用 (不再尝试)
let _gpuState = 'unknown';
let _gpuFailStreak = 0;
const GPU_FAIL_STREAK_LIMIT = 3;

// 诊断计数 (gpu-diag.log / profile 报告用)
const stats = { used: 0, failed: 0, fallback: 0, unavailable: 0 };

export function gpuAdapterStats() {
  return { state: _gpuState, failStreak: _gpuFailStreak, ...stats };
}

/** 测试/LRU 用: 复位探测与熔断状态。 */
export function resetGpuAdapter() {
  _gpuState = 'unknown';
  _gpuFailStreak = 0;
  stats.used = 0; stats.failed = 0; stats.fallback = 0; stats.unavailable = 0;
}

export function installGpuAdapter(proto) {
  /**
   * 返回后端标识 ('webgl') 或 null。首次调用做真实探测 (getWebGL(true)),
   * 不可用则熔断为 off —— 后续调用零成本直接返回 null。
   */
  proto._getGpuBackend = function () {
    if (this.gpuAccel !== true) return null;
    if (_gpuState === 'off') return null;
    if (_gpuState === 'unknown') {
      let ok = false;
      try { ok = getWebGL(true) !== null; } catch { ok = false; }
      _gpuState = ok ? 'ok' : 'off';
      if (!ok) { stats.unavailable++; this.log('GPU 不可用 (无 headless-GL/驱动), 效果链继续走 CPU'); }
    }
    return _gpuState === 'ok' ? 'webgl' : null;
  };

  /** 记一次 GPU 失败; 达阈值即熔断。 */
  proto._noteGpuFailure = function (e) {
    stats.failed++;
    _gpuFailStreak++;
    this.log('GPU 效果失败 (' + _gpuFailStreak + '/' + GPU_FAIL_STREAK_LIMIT + '): ' + (e && e.message ? e.message : e));
    if (_gpuFailStreak >= GPU_FAIL_STREAK_LIMIT) {
      _gpuState = 'off';
      this.log('GPU 连续失败达阈值 → 熔断, 本次进程内效果链全部回退 CPU');
    }
  };

  /**
   * 用 GPU 执行单个效果。成功返回 {width,height,rgba}, 任何失败返回 null
   * (调用方继续走 CPU 内核 / GLSL 解释器)。
   *
   * @param {object} img  链输入图 (作为 g_Texture0)
   * @param {object} ef   效果对象 (ef.file / ef.passes)
   * @param {string} name 效果名 (effects/<name>)
   * @param {object} c    constantshadervalues
   * @param {object} pass pass 定义 (textures / combos)
   * @param {number} t    场景时间
   */
  proto._tryEffectGpu = function (img, ef, name, c, pass, t) {
    if (!this._getGpuBackend()) return null;
    if (!img || !img.width || !img.height || !img.rgba) return null;
    let compiled;
    try { compiled = this._compileWorkshopEffect(ef); } catch { return null; }
    // fragPre 缺失 = CPU 侧也没能产出预处理源码 ⇒ 本层不接手 (保守, 宁可走 CPU)
    if (!compiled || !compiled.fragPre) return null;
    try {
      const pass0 = pass || (ef.passes && ef.passes[0]) || {};
      const constants = c || pass0.constantshadervalues || {};
      const texRefs = pass0.textures || [];
      const textures = texRefs.map((p) => (p && p !== 'null' ? this.loadTexture(p) : null));
      // uniform 组装与 CPU 路径**完全同一套** (executor.buildUniforms + 同一 engine 注入)
      const u = buildUniforms(compiled.uniforms, constants, {
        time: t || 0,
        textures,
        objW: img.width,
        objH: img.height,
        userAlpha: 1,
        parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
      });
      // sampler2D 绑定: g_Texture0 = 链输入 img, g_TextureN = textures[N] (官方槽位语义)
      for (const [un, info] of Object.entries(compiled.uniforms)) {
        if (info.type === 'sampler2D' && u[un] === undefined) {
          const idx = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
          u[un] = idx === 0 ? img : (textures[idx] || null);
        }
      }
      // wrap 语义标记: 与 CPU 解释器 (integration.js::_renderGlslEffect) 同一套约定 ——
      // 辅助槽纹理 REPEAT, 主图 g_Texture0 CLAMP (当 img 自身也是辅助槽时同样 REPEAT)。
      // gl-effect 的 wrapFor 依赖这两个标记, 否则采样跨 [0,1] 的位移/遮罩效果会产生
      // 可见差异。用普通属性标记 (与 CPU 侧共用同一字段名, 便于对照排查)。
      for (const tx of textures) if (tx) tx.__glslRepeat = true;
      img.__glslRepeat = textures.includes(img);
      const out = runEffectOnGL({
        fragPre: compiled.fragPre,
        vertPre: compiled.vertPre,
        u,
        width: img.width,
        height: img.height,
      });
      // 尺寸必须一致: 不一致说明该效果会改变图层尺寸, GPU 单 pass 不适用 → 回退 CPU
      if (!out || !out.rgba || out.width !== img.width || out.height !== img.height) return null;
      stats.used++;
      _gpuFailStreak = 0; // 成功即清零 (偶发失败不累积)
      return out;
    } catch (e) {
      this._noteGpuFailure(e);
      return null;
    }
  };

  /**
   * 连续效果链在**一次 GL 会话**内执行 (FBO 乒乓, 中间结果不读回 CPU) —— §三十五。
   *
   * ★ 与 `_tryEffectGpu` **完全独立**: 本方法不改动它任何一行。
   *   §三十一 的教训: 那次为了复用 program/uniform 而拆分 `_tryEffectGpu`,
   *   结果走 GPU 的效果数从 25 掉到 21、像素随之改变, 机制至今未查明。
   *   这里宁可重复约 20 行 uniform 组装, 也不碰那条路径 —— 重复只可能造成
   *   "少串一条链"(错过优化), 不可能改变单效果路径的行为。
   *   两条路径产出是否一致, 由 effects.js 的 DSH_WE_CHAIN_VERIFY=1 自检直接断言。
   */
  proto._tryEffectChainGpu = function (img, items) {
    if (!this._getGpuBackend()) return null;
    if (!img || !img.width || !img.height || !img.rgba) return null;
    if (!items || items.length < 2) return null;
    try {
      const prepared = [];
      for (const it of items) {
        const compiled = this._compileWorkshopEffect(it.ef);
        if (!compiled || !compiled.fragPre) return null;
        const pass0 = it.pass || (it.ef.passes && it.ef.passes[0]) || {};
        const constants = it.c || pass0.constantshadervalues || {};
        const texRefs = pass0.textures || [];
        const textures = texRefs.map((p) => (p && p !== 'null' ? this.loadTexture(p) : null));
        const u = buildUniforms(compiled.uniforms, constants, {
          time: it.t || 0,
          textures,
          objW: img.width,
          objH: img.height,
          userAlpha: 1,
          parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
        });
        for (const [un, info] of Object.entries(compiled.uniforms)) {
          if (info.type === 'sampler2D' && u[un] === undefined) {
            const idx = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
            u[un] = idx === 0 ? img : (textures[idx] || null);
          }
        }
        for (const tx of textures) if (tx) tx.__glslRepeat = true;
        img.__glslRepeat = textures.includes(img);
        prepared.push({ fragPre: compiled.fragPre, vertPre: compiled.vertPre, u });
      }
      const out = runEffectChainOnGL(prepared, img.width, img.height);
      if (!out || !out.rgba || out.width !== img.width || out.height !== img.height) return null;
      stats.used += items.length;
      _gpuFailStreak = 0;
      return out;
    } catch (e) {
      this._noteGpuFailure(e);
      return null;
    }
  };
}
