// 验证 stride 80/84 puppet MDL 解析修复:
// 对 27 个已安装 puppet MDL 全部跑 parseMdlPuppet + puppet.js _parseMdl 骨架,
// 检查解析成功率、顶点/索引合理性。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePkg, readPkgEntry } from '../lib/scene-manifest.js';
import { parseMdlPuppet } from '../lib/we-renderer/mdl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', '.tmp-diag2', 'verify-mdl-fix.txt');
const lines = [];
const log = (s) => lines.push(s);

const WS = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960';
const { readdirSync } = await import('node:fs');
const dirs = readdirSync(WS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

let total = 0, ok = 0, fail = 0;
for (const id of dirs) {
  const pkgPath = join(WS, id, 'scene.pkg');
  let data, entries;
  try { data = readFileSync(pkgPath); entries = parsePkg(data); } catch { continue; }
  for (const e of entries.filter((x) => /_puppet\.mdl$/i.test(x.path))) {
    let buf;
    try { buf = readPkgEntry(data, e); } catch { log(`读取失败 ${e.path}`); continue; }
    total++;
    const mesh = parseMdlPuppet(buf);
    if (!mesh) { fail++; log(`FAIL ${id} ${e.path}`); continue; }
    ok++;
    // 合理性: pos 有限, uv 有限, 索引 < vc
    let posBad = 0, uvBad = 0, idxBad = 0;
    for (let i = 0; i < Math.min(mesh.vertexCount, 2000); i++) {
      const p = mesh.positions[i];
      if (!p.every((v) => isFinite(v) && Math.abs(v) < 1e6)) posBad++;
      const u = mesh.uvs[i];
      if (!u.every((v) => isFinite(v) && v >= -0.5 && v <= 8)) uvBad++;
    }
    for (let i = 0; i < Math.min(mesh.indexCount, 5000); i++) {
      if (mesh.indices[i] >= mesh.vertexCount) idxBad++;
    }
    const flag = (() => {
      const matIdx = buf.indexOf(Buffer.from('materials/', 'ascii'), 8);
      let p = matIdx; while (p < buf.length && buf[p] !== 0) p++;
      return buf.readUInt32LE(p + 29) >>> 0;
    })();
    const stride = (flag >>> 16) === 0x0181 ? 84 : 80;
    log(`OK ${id} ${e.path}: stride=${stride} vc=${mesh.vertexCount} ic=${mesh.indexCount} posBad=${posBad} uvBad=${uvBad} idxBad=${idxBad}`);
  }
}
log(`\n== 汇总: ${total} MDL, 成功 ${ok}, 失败 ${fail} ==`);
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('done ->', OUT, `(${ok}/${total} ok)`);
