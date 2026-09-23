/**
 * diag-default-scenes.mjs — 对 WE 官方 defaultprojects（Sheep 除外，非 scene）做
 * **纯数学**诊断：不看图，只输出可判定量。
 *
 *   用法: node scripts/diag-default-scenes.mjs [scene...] [--w 480] [--h 270] [--t 2.5] [--isolate]
 *
 * 输出（每场景）:
 *   - 场景清单: 对象数 / 类型 / 可见性 / 渲染顺序
 *   - 日志分类: 缺纹理 / 缺材质 / 缺 shader / 未支持效果 / 异常
 *   - 全帧: 非清屏色覆盖率 / 唯一色 / 均值 / NaN 数 / 非清屏包围盒
 *   - --isolate: 逐个对象单独渲染（其余隐藏）→ 该对象自身的 alpha 覆盖 / 包围盒 /
 *     均值色 —— 用于把"某对象根本没画出来"与"被遮挡"分开
 *   - --predict: 用场景数据解析预测每个对象的屏幕包围盒（与 isolate 实测对拍）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneRenderer } from '../lib/scene-renderer.js';
import { setupCameraMatrices } from '../lib/we-renderer/camera.js';
import { mat4TransformPoint, parseVec3 } from '../lib/we-renderer/math.js';

const ROOT = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\projects\\defaultprojects';
const WE_DIR = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine';
const ALL = ['razer_bedroom', 'eagleflag', 'dna_fragment', 'deep_space', 'arsenal', 'beach'];

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const scenes = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a) && ALL.includes(a));
const W = parseInt(flag('--w', '480'), 10);
const H = parseInt(flag('--h', '270'), 10);
const T = parseFloat(flag('--t', '2.5'));
const ISOLATE = has('--isolate');
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

function stats(canvas, clearRGB) {
  const { w, h, data } = canvas;
  let n = w * h, nonClear = 0, nan = 0;
  let sr = 0, sg = 0, sb = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const colors = new Set();
  const isClear = (r, g, b) => clearRGB && Math.abs(r - clearRGB[0]) <= 2 && Math.abs(g - clearRGB[1]) <= 2 && Math.abs(b - clearRGB[2]) <= 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) nan++;
      sr += r; sg += g; sb += b;
      colors.add((r >> 3 << 10) | (g >> 3 << 5) | (b >> 3));
      if (!isClear(r, g, b)) {
        nonClear++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return {
    nonClearPct: +(nonClear / n * 100).toFixed(2),
    uniqueColors: colors.size,
    mean: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)],
    nan,
    bbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
  };
}

/** alpha>8 覆盖 / 加权均值 / 包围盒 —— 用于单对象 RT 或隔离帧 */
function alphaStats(canvas) {
  const { w, h, data } = canvas;
  let cov = 0, sr = 0, sg = 0, sb = 0, n = 0, nan = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1, aSum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
      if (!Number.isFinite(r + g + b + a)) nan++;
      if (a > 8) {
        cov++; sr += r; sg += g; sb += b; aSum += a; n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return {
    covPct: +(cov / (w * h) * 100).toFixed(2),
    meanRGB: n ? [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)] : null,
    meanA: n ? Math.round(aSum / n) : 0,
    bbox: maxX < 0 ? null : [minX, minY, maxX, maxY],
    nan,
  };
}

function classifyLog(l) {
  const s = String(l);
  if (/纹理|texture/i.test(s) && /缺|missing|not found|null|失败|fail/i.test(s)) return 'missing-texture';
  if (/材质|material/i.test(s) && /缺|missing|not found|null|失败|fail/i.test(s)) return 'missing-material';
  if (/shader|着色器|GLSL|combo/i.test(s)) return 'shader';
  if (/效果|effect/i.test(s) && /未|unsupported|skip|跳过|缺|degrad/i.test(s)) return 'effect';
  if (/失败|error|异常|throw/i.test(s)) return 'error';
  return 'other';
}

const report = {};
for (const name of scenes) {
  const dir = path.join(ROOT, name);
  const logs = [];
  const degraded = [];
  out(`\n${'='.repeat(70)}\n### ${name}   ${W}x${H} t=${T}`);

  let r;
  try {
    r = new SceneRenderer(dir, {
      width: W, height: H, time: T, weAssetsDir: WE_DIR,
      log: (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
      onDegraded: (d) => degraded.push(d),
    });
  } catch (e) {
    out(`构造失败: ${e.message}`);
    report[name] = { error: e.message };
    continue;
  }

  const gen = r.scene.general || {};
  const cc = gen.clearcolor ? parseVec3(gen.clearcolor, [0, 0, 0]) : [0, 0, 0];
  const clearRGB = gen.clearenabled === false ? null : cc.map((v) => v * 255);
  out(`清单: objects=${r.objects.length} 可见=${r.objects.filter((o) => r._isVisible(o)).length} 顺序=${r.renderOrder.length} gen=${JSON.stringify({ orthogonalprojection: gen.orthogonalprojection || null, fov: gen.fov ?? null, bloom: gen.bloom === true })}`);
  for (const o of r.objects) {
    out(`  #${o.id} ${String(o.name || '?').padEnd(22)} ${String(o._renderType).padEnd(9)} vis=${r._isVisible(o)} zorder=${o.zorder ?? '-'} origin=(${String(o.origin || '').trim()}) scale=(${String(o.scale || '').trim()}) parallax=(${String(o.parallaxDepth || '').trim()}) effects=${(o.effects || []).length}`);
  }

  let canvas;
  const t0 = Date.now();
  try { canvas = r.render(); } catch (e) { out(`渲染抛异常: ${e.stack}`); report[name] = { error: String(e.message) }; continue; }
  const ms = Date.now() - t0;
  const full = stats(canvas, clearRGB);
  out(`\n全帧 (${ms}ms): 非清屏覆盖=${full.nonClearPct}% 唯一色=${full.uniqueColors} 均值=rgb(${full.mean}) NaN=${full.nan} bbox=${JSON.stringify(full.bbox)}`);
  out(`清屏色=rgb(${clearRGB ? clearRGB.map((v) => Math.round(v)) : 'n/a'})`);
  if (r._rtTex && r._rtTex.size) out(`RT 保留: ${[...r._rtTex.keys()].join(', ')}`);

  // 日志分类
  const byClass = new Map();
  for (const l of logs) {
    const c = classifyLog(l);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(l);
  }
  out(`\n日志 ${logs.length} 条, 分类:`);
  for (const [c, arr] of [...byClass.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out(`  [${c}] ${arr.length}`);
    for (const l of arr.slice(0, 6)) out(`      ${String(l).slice(0, 160)}`);
  }
  if (degraded.length) {
    out(`degraded ${degraded.length} 条:`);
    for (const d of degraded.slice(0, 12)) out(`      ${JSON.stringify(d)}`);
  }

  const perObject = {};
  if (ISOLATE) {
    out(`\n逐对象隔离渲染:`);
    for (const target of r.objects) {
      const r2 = new SceneRenderer(dir, {
        width: W, height: H, time: T, weAssetsDir: WE_DIR,
        log: () => {}, onDegraded: () => {},
      });
      for (const o of r2.objects) o.visible = o.id === target.id;
      let c2;
      try { c2 = r2.render(); } catch (e) { out(`  #${target.id} ${target.name}: 异常 ${e.message}`); continue; }
      const s = alphaStats(c2);
      // 与清屏色比较：隔离帧里"与清屏不同"的像素 = 该对象真正的贡献
      const d = stats(c2, clearRGB);
      perObject[target.id] = { ...s, nonClearPct: d.nonClearPct };
      out(`  #${target.id} ${String(target.name || '?').padEnd(22)} ${String(target._renderType).padEnd(9)} 非清屏=${String(d.nonClearPct).padStart(6)}% alpha>8=${String(s.covPct).padStart(6)}% bbox=${JSON.stringify(s.bbox)} 均值=${JSON.stringify(s.meanRGB)} a=${s.meanA} NaN=${s.nan}`);
    }
  }

  report[name] = { ms, full, clearRGB, perObject, logs: logs.slice(0, 200), degraded };
}

const outp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-cache', 'default-scene-diag.json');
try { fs.mkdirSync(path.dirname(outp), { recursive: true }); fs.writeFileSync(outp, JSON.stringify(report, null, 1)); out(`\n(报告已写 ${outp})`); } catch (e) { out(`写报告失败 ${e.message}`); }
