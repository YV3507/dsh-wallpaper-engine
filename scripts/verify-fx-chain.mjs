#!/usr/bin/env node
/**
 * GPU 链式效果执行的守卫 —— docs/SCENE-FRAME-PERF.md §三十五。
 *
 * 链式执行把连续的同尺寸效果放进**一次 GL 会话**(FBO 乒乓, 中间结果不读回 CPU)。
 * 它的合法性来自两条, 本守卫各查一部分:
 *
 *   A. **严格加法**: `_tryEffectGpu` 必须一行未改。§三十一 的教训是, 为了复用
 *      program/uniform 而拆分 `_tryEffectGpu`, 会让走 GPU 的效果数从 25 掉到 21、
 *      像素随之改变, 机制至今未查明。所以这里断言: 链式方法**自包含**, 且
 *      `_tryEffectGpu` 体内**不出现**对 `_prepareEffectGpu` 之类抽取物的调用。
 *   B. 链式结果与"逐效果单独走 GPU"逐位一致 —— 由运行期自检
 *      (DSH_WE_CHAIN_VERIFY=1) 在真实场景上断言, 无法在 verify 里离线复现
 *      (需要 GPU)。本脚本只能断言**自检机制存在且可被触发**。
 *
 * 离线可查的还有: 白名单制 (不是"凡是 GPU 能跑的都串")、上限、A/B 开关、
 * 每一步的跳过判据与主循环同源(保守方向: 最多少串一条链, 不会改单效果行为)。
 */
import fs from 'node:fs';

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : ' FAIL ') + name + (detail ? '  — ' + detail : ''));
}

const fxSrc = fs.readFileSync(new URL('../lib/we-renderer/effects.js', import.meta.url), 'utf8');
const adSrc = fs.readFileSync(new URL('../lib/we-renderer/gpu-gl/adapter.js', import.meta.url), 'utf8');

// ── A. 严格加法 ────────────────────────────────────────────────
check('_tryEffectGpu 未被拆分 (体内不出现抽取出来的 _prepareEffectGpu)',
  /proto\._tryEffectGpu = function[\s\S]*?\n  \};/.test(adSrc) &&
  !/_prepareEffectGpu/.test(adSrc),
  '§三十一 的回归护栏: 拆分曾让 GPU 效果数 25 → 21');
const tryGpuBody = (adSrc.match(/proto\._tryEffectGpu = function[\s\S]*?\n  \};/) || [''])[0];
check('_tryEffectGpu 体内自行组装 uniform (自包含, 不依赖链式方法)',
  /buildUniforms\(/.test(tryGpuBody) && /runEffectOnGL\(/.test(tryGpuBody),
  '链式方法可以重复这段, 但反过来不行');
check('链式方法独立存在且走 runEffectChainOnGL',
  /proto\._tryEffectChainGpu = function/.test(adSrc) && /runEffectChainOnGL\(/.test(adSrc),
  'runEffectChainOnGL 此前是未接线遗留, 现已接线');
check('链式与逐效果都做"尺寸必须一致"检查',
  /out\.width !== img\.width \|\| out\.height !== img\.height/.test(adSrc),
  '尺寸改变的效果一律不接手');

// ── 白名单与开关 ───────────────────────────────────────────────
check('白名单制 (不是"凡是 GPU 能跑的都串")',
  /const GPU_CHAIN_EFFECTS = new Set\(/.test(fxSrc), '进白名单必须带实测数字');
check('白名单有实测依据注释 (opacity/color_grading, 栏杆 7.09Mpx)',
  /栏杆/.test(fxSrc) && /655ms/.test(fxSrc), '不许凭"看起来能串"添加');
check('单次会话有上限', /const GPU_CHAIN_MAX = \d+/.test(fxSrc), '限制 FBO 乒乓复杂度');
check('A/B 开关存在 (可回归对照)', /DSH_WE_NO_FX_CHAIN/.test(fxSrc), '对照实验用');
check('运行期逐位自检机制存在且可触发',
  /DSH_WE_CHAIN_VERIFY/.test(fxSrc) && /_verifyChain\(/.test(fxSrc) && /_verifyChain\(baseImg/.test(fxSrc),
  '需要 GPU, 故只能离线断言"机制存在"');

// ── 跳过判据: 保守方向 ─────────────────────────────────────────
// 前视用的判据若与主循环不同步, 后果只是**少串一条链**, 不会改变单效果行为 ——
// 这是刻意选择的保守方向 (主循环仍是唯一的行为决定者)。
check('前视遇到"不可见/无文件/实时效果"即中断 (保守)',
  /getVal\(e2, 'visible', true\) === false/.test(fxSrc) && /LIVE_FX_RE\.test\(n2\)/.test(fxSrc),
  '判据不同步只会少串, 不会串错');
check('已被会话消费的效果在主循环里被跳过',
  /chainSkip/.test(fxSrc) && /if \(chainSkip > 0\)/.test(fxSrc), '避免重复执行');
check('主循环其余行为未改 (仍逐个效果计时)',
  /profAdd\('效果:' \+ name, performance\.now\(\) - __te\)/.test(fxSrc),
  '不改剖析口径');

console.log(`\nGPU 链式执行守卫: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
