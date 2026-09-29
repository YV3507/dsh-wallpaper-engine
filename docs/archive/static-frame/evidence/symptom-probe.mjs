/**
 * symptom-probe.mjs — 把用户报告的三类观感症状转成可判定量:
 *   ① 马赛克  → 每张贴图"已解码像素 vs 本帧实际绘制像素"(渲染器自带 _drawArea 插桩, 需 DSH_WE_PROFILE=1)
 *               并给出该贴图 .tex 的 mip0 真实尺寸 (判断是不是解码到了更小的 mip)
 *   ② 过暗    → 全帧/逐对象均值亮度 + 材质常数 (Bright/Alpha/Power) + 对象 brightness + general.hdr/bloom
 *   ③ 回退    → 复刻 scene-render-worker 的空帧门禁 (抽样 diff%) 与 index.js 的质量门口径
 * 用法: DSH_WE_PROFILE=1 node docs/archive/static-frame/evidence/symptom-probe.mjs [scene...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer } from '../../../../lib/scene-renderer.js';
import { parseTex, texMip0Info } from '../../../../lib/pkg-extract.js';

const WE = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine';
const ROOT = path.join(WE, 'projects', 'defaultprojects');
const ALL = ['arsenal', 'beach', 'deep_space', 'dna_fragment', 'razer_bedroom', 'retro', 'ricepod', 'sheep', 'shimmering_particles'];
const argv = process.argv.slice(2);
const scenes = argv.filter((a) => ALL.includes(a));
const list = scenes.length ? scenes : ALL;
const W = 1920, H = 1080;

function meanBrightness(c) {
  let s = 0, n = 0, dark = 0;
  for (let i = 0; i < c.w * c.h; i++) {
    const v = (c.data[i * 4] + c.data[i * 4 + 1] + c.data[i * 4 + 2]) / 3;
    s += v; n++;
    if (v < 8) dark++;
  }
  return { mean: s / n, darkPct: dark / n * 100 };
}

/** 复刻 scene-render-worker.mjs 的空帧门禁: 抽样步长 8, 与 clearcolor 差 >24 记为"有内容" */
function blankGate(canvas, clearRgb) {
  const [cr, cg, cb] = clearRgb;
  const step = 8;
  let diff = 0, checked = 0;
  for (let y = 0; y < canvas.h; y += step) {
    for (let x = 0; x < canvas.w; x += step) {
      const i = (y * canvas.w + x) * 4;
      checked++;
      if (Math.abs(canvas.data[i] - cr) > 24 || Math.abs(canvas.data[i + 1] - cg) > 24 || Math.abs(canvas.data[i + 2] - cb) > 24) diff++;
    }
  }
  return { diffPct: diff / checked * 100, pass: diff / checked * 100 >= 0.05 };
}

for (const name of list) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) { console.log(`\n### ${name} — 目录不存在`); continue; }
  const pjPath = path.join(dir, 'project.json');
  const pj = fs.existsSync(pjPath) ? JSON.parse(fs.readFileSync(pjPath, 'utf8')) : {};
  const main = pj.file && pj.file.endsWith('.json') && fs.existsSync(path.join(dir, pj.file)) ? path.join(dir, pj.file) : dir;
  console.log(`\n${'='.repeat(72)}\n### ${name}  type=${pj.type || '(no type)'} file=${pj.file}  渲染 ${W}x${H} t=2.5`);
  let r;
  try {
    r = new SceneRenderer(main, { width: W, height: H, time: 2.5, weAssetsDir: WE });
  } catch (e) {
    console.log(`  构造失败 → 必然回退缩略图: ${e.message}`);
    continue;
  }
  const gen = r.scene.general || {};
  const cc = String(gen.clearcolor || '0 0 0').trim().split(/\s+/).map(Number).map((v) => Math.round(v * 255));
  console.log(`  general: hdr=${gen.hdr === true} bloom=${gen.bloom === true} ambient=${gen.ambientcolor || '-'} skylight=${gen.skylightcolor || '-'} clear=rgb(${cc}) ortho=${gen.orthogonalprojection ? gen.orthogonalprojection.width + 'x' + gen.orthogonalprojection.height : 'none'}`);
  let c;
  const t0 = Date.now();
  try { c = r.render(); } catch (e) { console.log(`  渲染抛异常 → 回退缩略图: ${e.message}`); continue; }
  const b = meanBrightness(c);
  const gate = blankGate(c, cc);
  console.log(`  渲染 ${(Date.now() - t0)}ms  均值亮度=${b.mean.toFixed(1)}/255  近黑像素=${b.darkPct.toFixed(1)}%  空帧门禁: diff=${gate.diffPct.toFixed(2)}% → ${gate.pass ? '通过' : '**判为空帧 ⇒ 回退**'}`);
  if (gen.hdr === true) console.log('  ⚠ hdr=true: bloom 后处理是否做 linear→sRGB 会整体决定明暗');

  // ── ① 马赛克: 贴图已解码像素 vs 绘制像素 ──
  const draw = r._drawArea;
  if (draw && draw.size) {
    console.log('  贴图 vs 绘制 (texPx/drawnPx < 1 ⇒ 需要放大 ⇒ 最近邻时呈马赛克):');
    for (const [rel, v] of draw) {
      const ratio = v.drawnPx > 0 ? v.texPx / v.drawnPx : Infinity;
      let real = '';
      try {
        const raw = r.pkg.read(rel.endsWith('.tex') ? rel : rel.replace(/\.json$/, '.tex'));
        if (raw) {
          const mi = texMip0Info(raw, { metaOnly: true });
          if (mi) real = ` .tex mip0=${mi.storageWidth}x${mi.storageHeight} fmt=${mi.format}`;
        }
      } catch { /* */ }
      const flag = ratio < 0.999 ? '  ← 放大 ' + (1 / ratio).toFixed(2) + '×' : '';
      console.log(`    ${String(rel).padEnd(34)} tex=${Math.round(v.texPx).toString().padStart(9)}px drawn=${Math.round(v.drawnPx).toString().padStart(9)}px ratio=${ratio.toFixed(3)}${flag}${real}`);
    }
  } else {
    console.log('  (无 _drawArea: 需 DSH_WE_PROFILE=1 且对象走 image 路径)');
  }
  // ── ② 过暗归因: 逐对象隔离均值 ──
  const rows = [];
  for (const o of r.objects) {
    if (!(o.image || o.model)) continue;
    const r2 = new SceneRenderer(main, { width: 480, height: 270, time: 2.5, weAssetsDir: WE });
    for (const q of r2.objects) if (q.id !== o.id) q.visible = false;
    let c2;
    try { c2 = r2.render(); } catch { continue; }
    const mb = meanBrightness(c2);
    const alpha = o.alpha != null ? (typeof o.alpha === 'object' ? o.alpha.value : o.alpha) : 1;
    const brightness = o.brightness != null ? (typeof o.brightness === 'object' ? o.brightness.value : o.brightness) : 1;
    rows.push({ name: String(o.name || o.id), mb: mb.mean, alpha, brightness });
  }
  rows.sort((a, b2) => a.mb - b2.mb);
  console.log('  逐对象隔离均值亮度 (480×270): ' + rows.slice(0, 10).map((x) => `${x.name}=${x.mb.toFixed(1)}(a=${x.alpha},b=${x.brightness})`).join('  '));
}
