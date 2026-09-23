// 场景单帧渲染 —— 分阶段耗时剖析入口 (诊断工具)
//
// 用法: node scripts/profile-scene.mjs <workshopId> [宽] [高] [时间秒] [--gpu|--cpu]
//   例: node scripts/profile-scene.mjs 3554161528                 # 4K 默认, CPU 路径
//       node scripts/profile-scene.mjs 3554161528 1920 1080 2.5 --gpu
// 环境: DSH_WE_SCENE_ROOT 覆盖场景库根目录 (默认 E:\SteamLibrary\...\431960)
//       DSH_WE_ASSETS     可选, WE 全局 assets 目录
//       DSH_PROFILE_DUMP=1 额外导出渲染结果 PNG 供人工核对
//
// 为什么一个进程只测一个场景: 纹理解码与 pkg 读取都有进程内缓存 —— 只有**冷渲染**
// (首个场景帧) 才代表用户第一次看到该壁纸时的真实等待, 复用渲染器会把成本测没。
// 需要多场景就多跑几次进程 (调用方循环)。
//
// 输出: 构建耗时 / 整帧墙钟 / 各阶段·各对象·各效果耗时表 (lib/we-renderer/profile.js)。
process.env.DSH_WE_PROFILE = '1'; // 必须在 import 渲染器之前 (profile.js 在模块加载时读)

import fs from 'node:fs';
import path from 'node:path';

const OUT = (...a) => { try { process.stdout.write(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') + '\n'); } catch { /* ignore */ } };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.filter((a) => !a.startsWith('--'));
const id = pos[0];
if (!id) {
  OUT('用法: node scripts/profile-scene.mjs <workshopId> [宽] [高] [时间秒] [--gpu|--cpu]');
  process.exit(2);
}
const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const W = parseInt(pos[1] || '3840', 10);
const H = parseInt(pos[2] || '2160', 10);
const T = parseFloat(pos[3] || '2.5');
// 默认 CPU: 实测日志里 gpuBackend 254/349 为 false, CPU 才是多数壁纸的真实路径
const gpuAccel = flags.has('--gpu');

const src = path.join(ROOT, id, 'scene.pkg');
if (!fs.existsSync(src)) { OUT('找不到场景: ' + src); process.exit(2); }
const weAssets = process.env.DSH_WE_ASSETS && fs.existsSync(process.env.DSH_WE_ASSETS) ? process.env.DSH_WE_ASSETS : undefined;

const { SceneRenderer, encodePng } = await import('../lib/scene-renderer.js');
const { profFormat } = await import('../lib/we-renderer/profile.js');

// A/B: DSH_WE_NO_FX_GPU=1 把效果全部赶到 CPU 路径 (只在测试脚本里包装原型方法,
// 产品代码零改动)。用来按效果名对照 GPU 与 CPU 的真实耗时。
if (process.env.DSH_WE_NO_FX_GPU === '1') {
  const proto = SceneRenderer.prototype;
  proto._tryEffectGpu = function () { return null; };
  OUT('DSH_WE_NO_FX_GPU=1: 效果链已强制走 CPU');
}

const logs = [];
const log = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

OUT(`场景 ${id}  ${W}x${H}  t=${T}s  加速=${gpuAccel ? 'gpu' : 'cpu'}  assets=${weAssets || '(无)'}`);

let r = null, canvas = null, constructMs = 0, renderMs = 0;
try {
  const tc0 = Date.now();
  r = new SceneRenderer(src, { width: W, height: H, time: T, weAssetsDir: weAssets, gpuAccel, log });
  constructMs = Date.now() - tc0;
  const tr0 = Date.now();
  canvas = r.render();
  renderMs = Date.now() - tr0;
} catch (e) {
  OUT('渲染失败: ' + (e && (e.stack || e.message) || e));
  process.exit(1);
}

const gpuBackend = r._getGpuBackend ? !!r._getGpuBackend() : 'n/a';
OUT(`构建(pkg/场景解析) ${constructMs}ms   渲染 ${renderMs}ms   合计 ${constructMs + renderMs}ms`);
OUT(`对象数 ${r.objects ? r.objects.length : '?'}  渲染序 ${r.renderOrder ? r.renderOrder.length : '?'}  gpuBackend=${gpuBackend}  日志=${logs.length}`);
if (gpuAccel) {
  // GPU 诊断: 适配层状态 + 与 GPU 相关的渲染日志 (失败原因在这里)
  try {
    const { gpuAdapterStats } = await import('../lib/we-renderer/gpu-gl/adapter.js');
    const st = gpuAdapterStats();
    OUT(`GPU 适配层: state=${st.state}  走GPU效果数=${st.used}  失败=${st.failed}  不可用=${st.unavailable}`);
  } catch { /* ignore */ }
  const gl = logs.filter((l) => /GPU|GLSL|熔断/.test(l));
  if (gl.length) { OUT('GPU 相关日志:'); for (const l of gl.slice(0, 10)) OUT('  ' + l); }
}

// PNG 编码 + 落盘: worker 单帧路径必做 (encodePng → 临时文件 → 宿主读回), 4K 整帧
// 原始 RGBA 33MB。worker 日志里的「单帧完成 ms=」把这段也算在内 —— 必须单独量出来,
// 否则会把编码/IO 成本误当成渲染成本。
let encodeMs = 0, writeMs = 0, pngBytes = 0;
try {
  const te0 = Date.now();
  const png = encodePng(canvas.w, canvas.h, canvas.data);
  encodeMs = Date.now() - te0;
  pngBytes = png.length;
  const tmp = path.join(process.env.TEMP || '.', `dsh-profile-${process.pid}.png`);
  const tw0 = Date.now();
  fs.writeFileSync(tmp, png);
  writeMs = Date.now() - tw0;
  fs.unlinkSync(tmp);
} catch (e) { OUT('(PNG 编码测量失败: ' + e.message + ')'); }
OUT(`PNG 编码 ${encodeMs}ms (${(pngBytes / 1048576).toFixed(1)}MB)   落盘 ${writeMs}ms   用户可见总计 ${constructMs + renderMs + encodeMs + writeMs}ms`);
OUT('');
OUT(profFormat(renderMs));

// 效果清单 (对象用了哪些效果, 便于对照效果耗时表)
const fxCount = new Map();
for (const o of r.objects || []) {
  for (const ef of o.effects || []) {
    if (!ef || !ef.file) continue;
    const n = path.basename(path.dirname(ef.file));
    fxCount.set(n, (fxCount.get(n) || 0) + 1);
  }
}
if (fxCount.size) {
  OUT('');
  OUT('── 场景效果清单 (效果名 × 对象数) ──');
  for (const [n, c] of [...fxCount.entries()].sort((a, b) => b[1] - a[1])) OUT(`  ${n.padEnd(20)} ${c}`);
}

if (process.env.DSH_PROFILE_DUMP === '1' && canvas) {
  try {
    fs.writeFileSync(`.tmp-profile-${id}.png`, encodePng(canvas.w, canvas.h, canvas.data));
    OUT(`\n(已写 .tmp-profile-${id}.png ${canvas.w}x${canvas.h})`);
  } catch (e) { OUT('(写 PNG 失败: ' + e.message + ')'); }
}
