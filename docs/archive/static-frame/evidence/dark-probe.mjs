/**
 * dark-probe.mjs — "过暗/全黑"归因: 区分
 *   (a) 贴图本身解出来就是黑 (解码缺陷)
 *   (b) 材质常数把亮度压到 0 (Bright/Power/Alpha 未接)
 *   (c) 光照/环境项为 0 (场景 ambient/skylight=0 且没有灯, 官方靠自发光)
 *   (d) HDR/bloom 后处理写线性值而缺 sRGB 编码 (整帧变暗)
 * 用法: node docs/archive/static-frame/evidence/dark-probe.mjs [scene...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer } from '../../../../lib/scene-renderer.js';
import { parseTex, decodeTex } from '../../../../lib/pkg-extract.js';

const WE = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine';
const ROOT = path.join(WE, 'projects', 'defaultprojects');
const ALL = ['arsenal', 'beach', 'deep_space', 'dna_fragment', 'razer_bedroom', 'retro', 'ricepod', 'shimmering_particles'];
const argv = process.argv.slice(2);
const list = argv.filter((a) => ALL.includes(a));

function texStats(img) {
  let sr = 0, sg = 0, sb = 0, sa = 0, n = 0, black = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const o = i * 4;
    sr += img.rgba[o]; sg += img.rgba[o + 1]; sb += img.rgba[o + 2]; sa += img.rgba[o + 3]; n++;
    if (img.rgba[o] + img.rgba[o + 1] + img.rgba[o + 2] === 0) black++;
  }
  return { mean: [sr / n, sg / n, sb / n, sa / n].map((v) => Math.round(v * 10) / 10), blackPct: black / n * 100 };
}

for (const name of list) {
  const dir = path.join(ROOT, name);
  if (!fs.existsSync(dir)) continue;
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const main = pj.file && pj.file.endsWith('.json') && fs.existsSync(path.join(dir, pj.file)) ? path.join(dir, pj.file) : dir;
  console.log(`\n${'='.repeat(72)}\n### ${name}`);
  let r;
  try { r = new SceneRenderer(main, { width: 480, height: 270, time: 2.5, weAssetsDir: WE }); } catch (e) { console.log('  构造失败: ' + e.message); continue; }
  const gen = r.scene.general || {};
  const lights = (r.scene.objects || []).filter((o) => o.light);
  console.log(`  ambient=${gen.ambientcolor || '-'} skylight=${gen.skylightcolor || '-'} hdr=${gen.hdr === true} bloom=${gen.bloom === true} lights=${lights.length}${lights.length ? ' ' + JSON.stringify(lights.map((l) => ({ i: l.intensity, r: l.radius, c: l.color }))) : ''}`);
  // 材质 → 纹理 → 贴图统计
  for (const o of r.objects) {
    const ref = o.image || o.model;
    if (!ref || !String(ref).endsWith('.json')) continue;
    let m = null;
    try { m = r.readJsonAny(ref); } catch { /* */ }
    if (!m) continue;
    const matRel = m.material || (m.materials && m.materials[0]);
    if (!matRel) continue;
    let mat = null;
    try { mat = r.readJsonAny(matRel); } catch { /* */ }
    const pass = mat && mat.passes && mat.passes[0];
    if (!pass) continue;
    const csv = pass.constantshadervalues || {};
    const texNames = pass.textures || [];
    const texes = texNames.map((tn) => {
      let raw = null;
      try { raw = r.pkg.read(String(tn).endsWith('.tex') ? tn : 'materials/' + tn + '.tex'); } catch { /* */ }
      if (!raw) return `${tn}=<缺>`;
      try {
        const info = parseTex(raw);
        const img = decodeTex(raw);
        const st = texStats(img);
        return `${tn}=${img.width}x${img.height} fmt=${info.format} mean(${st.mean.join(',')}) black=${st.blackPct.toFixed(1)}%`;
      } catch (e) { return `${tn}=<解码失败 ${e.message}>`; }
    });
    console.log(`  · ${String(o.name || o.id).padEnd(20)} shader=${String(pass.shader).padEnd(16)} csv=${JSON.stringify(csv)}`);
    for (const t of texes) console.log(`      ${t}`);
  }
}
