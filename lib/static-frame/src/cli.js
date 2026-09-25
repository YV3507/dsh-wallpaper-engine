#!/usr/bin/env node
/**
 * we-sf —— 独立 CLI：把 Wallpaper Engine 场景（scene.pkg / 场景目录）渲染成一张 PNG。
 *
 * 用法：
 *   we-sf render <scene.pkg|场景目录> -o out.png [--w 3840] [--h 2160] [--t 2.5]
 *               [--we-assets <WE>/assets] [--gpu] [--no-warm] [--json] [--log] [--strict]
 *   we-sf locate                 # 只打印自动定位到的 WE assets 路径
 *
 * `--log` 会把渲染器的诊断（效果编译失败 / include 未解析 / 粒子精灵缺失 / 降级上报）
 * 打到 stderr —— 排查"画面缺效果 / 部件乱"时先开它。
 *
 * `--strict` 把"出图了但画面与官方不一致"也当成失败：有任何降级项或空白帧时退出码 3
 * （0 = 干净出图，1 = 渲染失败，2 = 参数错误，3 = 有降级/空白）。批量出图建议开它。
 * 降级项与空白判定始终会打到 stderr，`--json` 里也有结构化的 `degraded` / `blank`。
 *
 * 无子命令时等价于 `render`。输出走 `process.stdout.write` + 显式退出码
 * （console.log 在某些 Windows shell 自然退出时会丢，实测）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderFrame, locateWeAssets, resolveSceneMainFile } from './render.js';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'render';
const rest = cmd === argv[0] ? argv.slice(1) : argv;

const opt = {
  width: 3840, height: 2160, time: 2.5, weAssets: null, gpu: false, warm: true, out: null,
  json: false, logOn: false, strict: false, input: null,
  gpuMode: null, allowEffects: [], denyEffects: [], effectBackend: {}, listDecisions: false, badArgs: [],
};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  const next = () => rest[++i];
  if (a === '-o' || a === '--out') opt.out = next();
  else if (a === '--w' || a === '--width') opt.width = Number(next());
  else if (a === '--h' || a === '--height') opt.height = Number(next());
  else if (a === '--t' || a === '--time') opt.time = Number(next());
  else if (a === '--we-assets') opt.weAssets = next();
  else if (a === '--gpu') opt.gpu = true;
  else if (a === '--no-warm') opt.warm = false;
  else if (a === '--json') opt.json = true;
  else if (a === '--log') opt.logOn = true;
  else if (a === '--strict') opt.strict = true;
  // ── 下游决策（逐效果 / GPU）──────────────────────────────────────────────
  else if (a === '--gpu') {
    // `--gpu` 单独出现 = auto；`--gpu off|auto|force` = 指定模式
    const v = rest[i + 1];
    if (v && !v.startsWith('-')) { opt.gpuMode = String(next()).toLowerCase(); }
    else opt.gpuMode = 'auto';
  }
  else if (a === '--only-effect') opt.allowEffects.push(String(next()));
  else if (a === '--skip-effect' || a === '--no-effect') opt.denyEffects.push(String(next()));
  else if (a === '--effect-backend') {
    const v = String(next());
    const at = v.lastIndexOf(':');
    if (at <= 0) { opt.badArgs.push('--effect-backend 需要 <效果名>:<auto|cpu|gpu|gpu-only>'); }
    else opt.effectBackend[v.slice(0, at).trim()] = v.slice(at + 1).trim().toLowerCase();
  }
  else if (a === '--list-decisions') opt.listDecisions = true;
  else if (a.startsWith('-')) { process.stderr.write('未知参数: ' + a + '\n'); process.exit(2); }
  else opt.input = a;
}

if (opt.badArgs.length) { for (const m of opt.badArgs) process.stderr.write('参数错误: ' + m + '\n'); process.exit(2); }

if (cmd === 'locate') {
  const p = locateWeAssets();
  process.stdout.write((p || '(未找到；请用 --we-assets 指定 <WE 安装目录>/assets)') + '\n');
  process.exit(p ? 0 : 1);
}

if (!opt.input) {
  process.stderr.write('缺少输入：we-sf render <scene.pkg|场景目录> -o out.png\n');
  process.exit(2);
}
const out = resolve(opt.out || 'frame.png');
const weAssets = opt.weAssets || locateWeAssets();
const log = opt.logOn ? (m) => process.stderr.write('[we-sf] ' + m + '\n') : () => {};

// ── stdout 守卫 ─────────────────────────────────────────────────────────────
// 渲染期间**任何**写 stdout 的东西都导流到 stderr：渲染器内部已把场景脚本的
// console.* 接到 log 上（见 scene-scripts.js makeSandboxConsole），这里是第二道闸 ——
// 保证 `--json` 的 stdout 只有末尾那一行 JSON，不会被第三方影子输出破坏。
const _realStdoutWrite = process.stdout.write.bind(process.stdout);
let _diverting = false;
process.stdout.write = function divertedWrite(chunk, enc, cb) {
  if (_diverting) return process.stderr.write(chunk, enc, cb);
  return _realStdoutWrite(chunk, enc, cb);
};
async function withStdoutDiverted(fn) {
  _diverting = true;
  try { return await fn(); } finally { _diverting = false; }
}

const t0 = Date.now();
try {
  const res = await withStdoutDiverted(() => renderFrame({
    input: opt.input,
    width: opt.width, height: opt.height, time: opt.time,
    weAssetsDir: weAssets, gpuAccel: opt.gpu, warm: opt.warm, log,
    // 下游决策：GPU 模式 + 逐效果白/黑名单 + 逐效果后端
    ...(opt.gpuMode ? { gpu: opt.gpuMode } : {}),
    ...((opt.allowEffects.length || opt.denyEffects.length || Object.keys(opt.effectBackend).length)
      ? { effects: { allow: opt.allowEffects, deny: opt.denyEffects, backend: opt.effectBackend } }
      : {}),
  }));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, res.png);

  // ── 静默错误上报 ───────────────────────────────────────────────────────
  // 渲染"成功"不等于画面正确：缺纹理 / 视频纹理 / 效果编译失败都会让画面与官方不一致，
  // 极端情况（主图层是内嵌视频）就是整帧空白。这里把渲染器收集到的降级项打到 stderr，
  // 并给可执行的下一步；`--strict` 时以退出码 3 表示"出图了但有降级/空白"。
  const degraded = res.degraded || [];
  const warn = (s) => process.stderr.write(s + '\n');
  if (res.blank) {
    warn('⚠ 输出疑似空白帧（抽样平均亮度 ' + res.meanLuma + '/255）');
  }
  if (!weAssets) warn('⚠ 未定位到 WE assets（效果链会退化）—— 用 WE_ASSETS=<WE>/assets 指定');
  if (degraded.length) {
    const videoTex = degraded.some((d) => /视频纹理/.test(d.action) || /embedded mp4/i.test(d.action));
    warn(`⚠ 有 ${degraded.length} 项降级（画面与官方不一致，对象保留）：`);
    const seen = new Set();
    for (const d of degraded) {
      const key = (d.object || '') + '|' + d.feature;
      if (seen.has(key)) continue;
      seen.add(key);
      const act = d.action.length > 110 ? d.action.slice(0, 110) + '…' : d.action;
      warn('   · [' + d.feature + (d.object ? ' @' + d.object : '') + '] ' + act);
      if (seen.size >= 6) { warn(`   · …其余 ${degraded.length - seen.size} 项用 --log 查看`); break; }
    }
    if (videoTex) {
      warn('   提示：内嵌视频纹理需要调用方用 ffmpeg 抽帧后经库参数 videoFrames 传入（CLI 暂不支持）；');
      warn('        主图层是视频纹理时，当前输出会是空白帧。');
    }
  }

  const info = {
    ok: true, out, bytes: res.png.length, width: res.width, height: res.height,
    time: res.time, ms: res.ms, totalMs: Date.now() - t0,
    sceneSrc: resolveSceneMainFile(opt.input), weAssets: weAssets || null, gpu: opt.gpu,
    blank: !!res.blank, meanLuma: res.meanLuma,
    degraded: degraded.map((d) => ({ object: d.object || null, feature: d.feature, action: d.action })),
    // 下游决策记录（谁被跳过/强制走哪条后端）+ GPU 计数
    decisions: res.decisions || { total: 0, items: [] },
    gpuStats: res.gpuStats || null,
  };
  if (opt.listDecisions && res.decisions && res.decisions.items.length) {
    warn('决策记录 ' + res.decisions.total + ' 条：');
    for (const d of res.decisions.items) {
      warn('   ' + d.action.padEnd(5) + ' ' + String(d.effect).padEnd(24) + ' backend=' + d.backend
        + '  [' + d.source + '] ' + (d.reason || ''));
    }
  }
  process.stdout.write((opt.json
    ? JSON.stringify(info)
    : `✓ ${out}  ${res.width}x${res.height}  ${(res.png.length / 1024).toFixed(0)} KB  ${res.ms}ms`
      + (res.blank ? '  ⚠ 空白帧' : '')
      + (degraded.length ? `  ⚠ 降级 ${degraded.length} 项（见 stderr）` : '')) + '\n');
  process.exit(opt.strict && (res.blank || degraded.length) ? 3 : 0);
} catch (e) {
  const err = { ok: false, error: String(e && e.message ? e.message : e) };
  if (opt.json) process.stdout.write(JSON.stringify(err) + '\n');
  else process.stderr.write('✗ 渲染失败: ' + err.error + '\n');
  process.exit(1);
}
