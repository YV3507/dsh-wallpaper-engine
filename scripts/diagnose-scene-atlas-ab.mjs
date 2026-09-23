#!/usr/bin/env node
// A/B 取证: 渲染一次场景, 打印「按帧解码」请求数与真正走区域解码的次数、
// 分阶段耗时、以及画布校验和。用来判定优化是否真的触发 (而不是靠推断)。
//
// 注意: DSH_WE_PROFILE=1 时渲染器会接管 console (profile.js), 故这里一律用
// process.stdout.write 直写。
//
// 用法: node scripts/tmp-atlas-ab.mjs <workshopId> [宽] [高] [时间秒] [--gpu]
import path from 'node:path';
import fs from 'node:fs';
process.env.DSH_WE_PROFILE = '1';

const P = (s) => { try { process.stdout.write(s + '\n'); } catch { /* ignore */ } };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const pos = argv.filter((a) => !a.startsWith('--'));
const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = pos[0];
const W = parseInt(pos[1] || '3840', 10);
const H = parseInt(pos[2] || '2160', 10);
const T = parseFloat(pos[3] || '2.5');
const src = path.join(ROOT, id, 'scene.pkg');
if (!fs.existsSync(src)) { P('找不到场景: ' + src); process.exit(2); }
const weAssets = process.env.DSH_WE_ASSETS && fs.existsSync(process.env.DSH_WE_ASSETS) ? process.env.DSH_WE_ASSETS : undefined;

const { SceneRenderer } = await import('../lib/scene-renderer.js');
const r = new SceneRenderer(src, {
  width: W, height: H, time: T, weAssetsDir: weAssets, gpuAccel: flags.has('--gpu'), log: () => { },
});
const { warmSceneTextures } = await import('../lib/we-renderer/predecode.js');
const tw = Date.now();
let warm = null;
try { warm = await warmSceneTextures(r); } catch (e) { warm = { error: e.message }; }
const warmMs = Date.now() - tw;
// 效果链内部取证 (DSH_WE_TPROF=1): **只在 harness 里包装原型方法**, 一行产品代码
// 都不改 —— 上一轮改热路径导致 GPU 效果数变化的教训。
const tprof = {};
const compileCalls = [];
if (process.env.DSH_WE_TPROF === '1') {
  const proto = Object.getPrototypeOf(r);
  for (const m of ['_compileWorkshopEffect', '_readGlslShader', 'parseMeta', '_tryEffectGpu', 'applyEffects', 'loadModelTexture', 'loadTexture']) {
    const orig = proto[m];
    if (typeof orig !== 'function') { tprof[m] = 'n/a'; continue; }
    proto[m] = function wrappedProf(...a) {
      const t = performance.now();
      try { return orig.apply(this, a); } finally {
        const d = performance.now() - t;
        tprof[m] = (tprof[m] || 0) + d;
        // 逐次记录: 用来判定"编译缓存到底有没有命中"(首次慢、其后应接近 0)
        if (m === '_compileWorkshopEffect') compileCalls.push({ f: (a[0] && a[0].file) || '?', ms: d });
      }
    };
  }
}

// blitRotated 包围盒浪费率取证: 复算 bbox 迭代数 vs 真正落在四边形内的像素数。
// 旋转后包围盒面积 = 四边形的 (|cos|+|sin|)^2 倍 —— 45° 时是 2 倍 (白扫一半)。
const rotCalls = [];
if (process.env.DSH_WE_TPROF === '1' && r.canvas) {
  const cproto = Object.getPrototypeOf(r.canvas);
  const origRot = cproto.blitRotated;
  if (typeof origRot === 'function') {
    cproto.blitRotated = function (img, cx, cy, dw, dh, angle, alpha = 1, pivotX = cx, pivotY = cy) {
      const t = performance.now();
      try { return origRot.apply(this, arguments); } finally {
        const adw = Math.abs(dw), adh = Math.abs(dh);
        const cos = Math.cos(-angle), sin = Math.sin(-angle);
        const halfW = adw / 2, halfH = adh / 2;
        const mx = cx - pivotX, my = cy - pivotY;
        const absC = Math.abs(cos), absS = Math.abs(sin);
        const rw = halfW * absC + halfH * absS, rh = halfW * absS + halfH * absC;
        const x0 = Math.floor(pivotX - rw), y0 = Math.floor(pivotY - rh);
        const x1 = Math.ceil(pivotX + rw), y1 = Math.ceil(pivotY + rh);
        const invDw = img.width / adw, invDh = img.height / adh;
        let bbox = 0, inside = 0;
        for (let ty = Math.max(0, y0); ty < Math.min(this.h, y1); ty++) {
          for (let tx = Math.max(0, x0); tx < Math.min(this.w, x1); tx++) {
            bbox++;
            const ox = tx - pivotX, oy = ty - pivotY;
            const ux = ox * cos - oy * sin - mx, uy = ox * sin + oy * cos - my;
            const sx = (ux + halfW) * invDw, sy = (uy + halfH) * invDh;
            if (sx >= 0 && sy >= 0 && sx < img.width && sy < img.height) inside++;
          }
        }
        rotCalls.push({ ms: performance.now() - t, angle: (angle * 180 / Math.PI).toFixed(1), bbox, inside, dw: Math.round(dw), dh: Math.round(dh) });
      }
    };
  }
}

const t0 = Date.now();
const canvas = r.render();
const renderMs = Date.now() - t0 + warmMs;   // 预解码也属于"用户等待"
if (warm) P(`warm=${JSON.stringify(warm)} warmMs=${warmMs}`);
else P(`warm=disabled warmMs=0`);

if (process.env.DSH_WE_TPROF === '1') {
  P('\n原型方法计时 (包装, 计时含被调用的子方法 ⇒ 有重叠):');
  for (const [k, v] of Object.entries(tprof)) P(`  ${k.padEnd(22)} ${typeof v === 'number' ? v.toFixed(0) + 'ms' : v}`);
  const h = compileCalls.map((c) => c.ms.toFixed(1)).join(', ');
  P(`\n_compileWorkshopEffect 逐次 (${compileCalls.length} 次): ${h}`);
  const byFile = new Map();
  for (const c of compileCalls) {
    const k = c.f.split('/').slice(-2).join('/');
    byFile.set(k, (byFile.get(k) || []).concat(c.ms.toFixed(1)));
  }
  for (const [k, v] of byFile) P(`  ${k.padEnd(46)} ${v.join(', ')}`);
}

// GPU 链式执行自检 (DSH_WE_CHAIN_VERIFY=1 时产生)
if (r._chainVerifyLog && r._chainVerifyLog.length) {
  P('\n链式执行自检:');
  for (const m of r._chainVerifyLog) P('  ' + m);
}

// §三十九 前提取证: 已解码像素 vs 实际绘制像素 (比值 > 1 ⇒ 存在过采样, 才有可压的)
if (r._drawArea && r._drawArea.size) {
  const rows = [...r._drawArea.entries()]
    .map(([k, v]) => ({ k, tex: v.texPx, drawn: v.drawnPx, ratio: v.drawnPx > 0 ? v.texPx / v.drawnPx : 0 }))
    .sort((a, b) => b.ratio - a.ratio);
  const over = rows.filter((x) => x.ratio > 1.05);
  P(`\n纹理过采样: ${rows.length} 个对象, 其中过采样(>1.05×) ${over.length} 个`);
  for (const x of rows.slice(0, 10)) {
    P(`  ${String(x.k).padEnd(28)} 解码 ${(x.tex / 1e6).toFixed(2)}Mpx  绘制 ${(x.drawn / 1e6).toFixed(2)}Mpx  比值 ${x.ratio.toFixed(2)}×`);
  }
}

if (rotCalls.length) {
  const tb = rotCalls.reduce((a, c) => a + c.bbox, 0);
  const ti = rotCalls.reduce((a, c) => a + c.inside, 0);
  P(`\nblitRotated ${rotCalls.length} 次: bbox 迭代 ${tb}  四边形内 ${ti}  `
    + `白扫 ${(100 * (1 - ti / tb)).toFixed(1)}%`);
  for (const c of rotCalls) {
    P(`  角度 ${String(c.angle).padStart(7)}°  ${c.dw}x${c.dh}  bbox=${c.bbox}  内=${c.inside}  `
      + `白扫 ${(100 * (1 - c.inside / c.bbox)).toFixed(1)}%  ${c.ms.toFixed(1)}ms`);
  }
}

// 画布校验和: 用来对照「按帧解码开/关」是否产出**同一张图**(逐位一致)
let sum = 0;
let nonzero = 0;
if (canvas && canvas.data) {
  const d = canvas.data;
  for (let i = 0; i < d.length; i++) { sum = (sum + d[i]) % 1000000007; if (d[i]) nonzero++; }
}
P(`mode=${process.env.DSH_WE_NO_ATLAS_FRAME ? 'off' : 'on'} scene=${id} ${W}x${H} t=${T} 加速=${flags.has('--gpu') ? 'gpu' : 'cpu'}`);
P(`renderMs=${renderMs} frameReqs=${r._atlasFrameReqs || 0} frameDecodes=${r._atlasFrameDecodes || 0}`);
P(`canvasSum=${sum} nonzeroBytes=${nonzero} canvasBytes=${canvas && canvas.data ? canvas.data.length : 0}`);

// 每纹理实际解码耗时 (定位解码预算去向)
if (r._texDecodeMs && r._texDecodeMs.size) {
  const rows = [...r._texDecodeMs.entries()].sort((a, b) => b[1] - a[1]);
  const tot = rows.reduce((a, x) => a + x[1], 0);
  P(`\n解码明细: ${rows.length} 条路径, 合计 ${tot.toFixed(0)}ms`);
  rows.slice(0, 12).forEach(([p, ms], i) => {
    P(`  ${String(i + 1).padStart(2)}  ${ms.toFixed(0).padStart(6)}ms  ${p}`);
  });
  const top5 = rows.slice(0, 5).reduce((a, x) => a + x[1], 0);
  P(`  前 5 名合计 ${top5.toFixed(0)}ms = ${(100 * top5 / tot).toFixed(1)}%`);
}
