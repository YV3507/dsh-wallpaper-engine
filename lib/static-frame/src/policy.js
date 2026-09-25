/**
 * 下游决策层（policy）—— 让调用方决定**哪些效果应用、用哪条后端、GPU 开不开**。
 *
 * 为什么单独一层：webwallgl（实时渲染路线）对宿主只暴露 `quality.{antiAliasing,
 * particles,postProcessing}` 三个粗档位，`postProcessing:"off"` 是"图层效果链 + 整屏
 * 后期层 + 内置 bloom"三合一的总闸；逐效果的唯一开关是场景数据里的 `effect.visible`，
 * 而着色器编译失败会被缓存成 null 哨兵后**静默跳过**（其官方文档原话："效果静默消失、
 * 无报错"）。本仓库要的是相反的东西：**逐效果、可解释、可回放**的决策权交给下游。
 *
 * 沿用 webwallgl 里值得抄的模式：
 *   · `normalize*` 逐键回落、**任何非法输入都不抛错**（渲染是长任务，不该因配置崩）；
 *   · `'off'` 哨兵语义 = "跳过该阶段"，`'auto'` = 尽力而为；
 *   · 能力探测返回 `null`，由**调用方**决定怎么回退（不替调用方做决定）。
 *
 * 用法（库）：
 *   renderFrame({
 *     effects: {
 *       deny: ['bloom', 'filmgrain'],              // 黑名单
 *       allow: ['waterwaves'],                     // 白名单（给定时=只允许这些）
 *       backend: { waterwaves: 'cpu', godrays: 'gpu-only' },
 *       onDecision: (d) => console.log(d),
 *     },
 *     gpu: 'auto' | 'off' | 'force' | { mode, failStreakLimit, denyEffects, allowEffects },
 *     policy: {
 *       decideEffect: ({ effect, layer, index }) => 'apply' | 'skip' | { action, backend, reason },
 *     },
 *     shaderPatch: { 'waterwaves': (src, { stage }) => src.replace(...) },  // 逐着色器源码覆写
 *   })
 *
 * 决策记录（`decisions[]`）形状：
 *   { effect, layer, index, action: 'apply'|'skip', backend: 'auto'|'cpu'|'gpu'|'gpu-only',
 *     reason, source: 'hook'|'backend-map'|'deny'|'allow'|'gpu-policy'|'scene'|'default' }
 */

export const EFFECT_ACTIONS = ['apply', 'skip'];
export const EFFECT_BACKENDS = ['auto', 'cpu', 'gpu', 'gpu-only'];
export const GPU_MODES = ['auto', 'off', 'force'];

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : v instanceof Set ? [...v] : [v]);
const asSet = (v) => new Set(asArray(v).filter((x) => typeof x === 'string' && x).map((x) => x.trim()));

/**
 * `gpu` 选项 → `{ mode, failStreakLimit, allowEffects, denyEffects }`（非法值回落到默认，不抛错）。
 * mode 语义：`'auto'`（默认，探测一次、失败回退 CPU）| `'off'`（永不探测/永不使用）| `'force'`（重探，含已熔断的进程）。
 * `failStreakLimit`：连续失败多少次后熔断本次进程的 GPU；**0 表示永不熔断**
 * （下游"宁可慢也要 GPU"时用），非法值回落默认 3。
 */
export function normalizeGpu(gpu) {
  const out = { mode: 'auto', failStreakLimit: 3, allowEffects: null, denyEffects: null };
  if (gpu === true) out.mode = 'auto';
  else if (gpu === false) out.mode = 'off';          // 显式关；未提供（undefined/null）= 不表态 = 'auto'
  else if (typeof gpu === 'string') {
    const m = String(gpu).toLowerCase();
    out.mode = m === 'on' || m === 'true' || m === 'auto' ? 'auto' : m === 'force' ? 'force' : 'off';
  } else if (typeof gpu === 'object') {
    const m = gpu.mode != null ? String(gpu.mode).toLowerCase() : (gpu.enabled === true ? 'auto' : gpu.enabled === false ? 'off' : 'auto');
    out.mode = GPU_MODES.includes(m) ? m : (m === 'on' ? 'auto' : 'off');
    if (Number.isFinite(gpu.failStreakLimit)) out.failStreakLimit = gpu.failStreakLimit > 0 ? Math.floor(gpu.failStreakLimit) : Infinity;
    if (gpu.allowEffects != null) out.allowEffects = asSet(gpu.allowEffects);
    if (gpu.denyEffects != null) out.denyEffects = asSet(gpu.denyEffects);
  }
  return out;
}

/**
 * 归一整个 policy（`effects` / `policy` / `gpu` / `onDecision` / `shaderPatch` 可分散传，
 * 也可统一放在 `policy` 下）。任何字段非法都回落到安全默认。
 */
export function normalizePolicy(opts = {}) {
  if (!opts || typeof opts !== 'object') opts = {};
  const eff = opts.effects && typeof opts.effects === 'object' ? opts.effects : {};
  const pol = opts.policy && typeof opts.policy === 'object' ? opts.policy : {};
  return {
    gpu: normalizeGpu(opts.gpu !== undefined ? opts.gpu : pol.gpu),
    allow: asSet(eff.allow),
    deny: asSet(eff.deny),
    backend: (eff.backend && typeof eff.backend === 'object') ? { ...eff.backend } : {},
    skipDegenerate: eff.skipDegenerate !== false,      // 默认开：保留既有"输出退化就丢弃"保护
    // 退化效果的**负缓存**阈值（默认 0 = 关闭，行为与从前逐位一致）：
    // 某效果连续 N 次渲染都被退化保护判定丢弃，之后直接跳过不再计算。
    // 为什么：实测 auto_sway 每帧逐像素跑完 1.27Mpx 再被丢弃，占整帧 42%（3486806915 省 9333ms），
    // 而像素逐字节不变 —— 长驻渲染（WebUI / 多帧）纯属白做。单次渲染的调用方保持默认即可。
    skipDegenerateAfter: Number.isInteger(eff.skipDegenerateAfter) && eff.skipDegenerateAfter > 0
      ? eff.skipDegenerateAfter : 0,
    decideEffect: typeof (pol.decideEffect || eff.decideEffect) === 'function' ? (pol.decideEffect || eff.decideEffect) : null,
    decideBackend: typeof pol.decideBackend === 'function' ? pol.decideBackend : null,
    onDecision: typeof (opts.onDecision || eff.onDecision || pol.onDecision) === 'function'
      ? (opts.onDecision || eff.onDecision || pol.onDecision) : null,
    shaderPatch: (opts.shaderPatch && typeof opts.shaderPatch === 'object') ? { ...opts.shaderPatch }
      : (pol.shaderPatch && typeof pol.shaderPatch === 'object' ? { ...pol.shaderPatch } : {}),
  };
}

const isNoopPolicy = (p) => !p || !p.gpu || (
  p.gpu.mode === 'auto' && !(p.allow && p.allow.size) && !(p.deny && p.deny.size) && !Object.keys(p.backend || {}).length
  && !p.decideEffect && !p.decideBackend && !p.onDecision && !Object.keys(p.shaderPatch || {}).length
);
export { isNoopPolicy };

/** 后端取值归一；非法值回落 'auto'。 */
export function normalizeBackend(b) {
  if (b == null) return 'auto';
  const s = String(b).toLowerCase();
  if (s === 'off' || s === 'skip' || s === 'none') return null;   // 显式"不走这条后端"
  return EFFECT_BACKENDS.includes(s) ? s : 'auto';
}

/**
 * 单个效果的决策。优先级：钩子 > 逐效果 backend 表 > 黑名单 > 白名单 > 默认。
 * 钩子可以返回字符串（'apply'/'skip'）或对象（{action, backend, reason}）；
 * 抛错时**不牵连渲染**，按默认放行并记录原因。
 */
export function decideEffect(policy, ctx) {
  const p = policy || normalizePolicy({});
  const name = ctx && ctx.effect ? String(ctx.effect) : '';
  const rec = { effect: name, layer: ctx && ctx.layer != null ? ctx.layer : null, index: ctx && ctx.index, action: 'apply', backend: 'auto', reason: '', source: 'default' };

  if (p.decideEffect) {
    let r;
    try { r = p.decideEffect({ ...ctx, policy: p }); } catch (e) {
      rec.reason = 'decideEffect 钩子抛错，按默认放行: ' + (e && e.message ? e.message : e);
      rec.source = 'hook-error';
      return rec;
    }
    if (r != null) {
      if (typeof r === 'string') {
        if (EFFECT_ACTIONS.includes(r)) { rec.action = r; rec.source = 'hook'; }
        else if (EFFECT_BACKENDS.includes(r)) { rec.backend = r; rec.source = 'hook'; }
        else if (r === 'off' || r === 'skip') { rec.action = 'skip'; rec.source = 'hook'; }
      } else if (typeof r === 'object') {
        if (EFFECT_ACTIONS.includes(r.action)) rec.action = r.action;
        const b = normalizeBackend(r.backend);
        if (r.backend !== undefined) rec.backend = b === null ? 'cpu' : b; // 钩子里 backend:null = 明确要求 CPU
        if (typeof r.reason === 'string') rec.reason = r.reason;
        rec.source = 'hook';
      }
      if (rec.source === 'hook') return rec;
    }
  }

  const b = normalizeBackend(p.backend[name]);
  if (p.backend[name] !== undefined) {
    if (b === null) { rec.action = 'skip'; rec.reason = 'backend 表显式置为 off/none'; rec.source = 'backend-map'; return rec; }
    rec.backend = b; rec.source = 'backend-map';
  }

  if (p.decideBackend) {
    try {
      const bb = normalizeBackend(p.decideBackend({ ...ctx, policy: p }));
      if (bb) { rec.backend = bb; if (rec.source === 'default') rec.source = 'backend-hook'; }
    } catch { /* 忽略：不影响渲染 */ }
  }

  if (p.deny.has(name)) { rec.action = 'skip'; rec.reason = '在 effects.deny 名单里'; rec.source = 'deny'; return rec; }
  if (p.allow.size && !p.allow.has(name)) { rec.action = 'skip'; rec.reason = '不在 effects.allow 名单里'; rec.source = 'allow'; return rec; }
  return rec;
}

/** GPU 是否允许用于该效果（mode=off / 名单外 → false）。 */
export function gpuAllowsEffect(policy, name) {
  const p = policy;
  if (!p || p.gpu.mode === 'off') return false;
  if (p.gpu.denyEffects && p.gpu.denyEffects.has(name)) return false;
  if (p.gpu.allowEffects && p.gpu.allowEffects.size && !p.gpu.allowEffects.has(name)) return false;
  return true;
}
