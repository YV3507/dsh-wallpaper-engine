// 全场景渲染验证: 4 问题壁纸 + 参考, 记录 puppet/MDL 相关日志
import { SceneRenderer, encodePng } from '../lib/scene-renderer.js';
import fs from 'node:fs';
import path from 'node:path';

const WS = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960';
const WE = 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine';
const OUT = path.resolve('D:/dsh-wallpaper-engine/.tmp-diag2');
const scenes = [
  ['3655429099', '[Luo tianyi]Christmas snow'],
  ['3640755971', '皓风琦电竞【羽】'],
  ['3641860575', '天使の邮件/Angel Mail'],
  ['3486806915', 'Amiya 阿米娅 淡蓝の梦'],
  ['3554161528', '参考: 雪景'],
];
const lines = [];
for (const [id, label] of scenes) {
  const logs = [];
  const pkg = path.join(WS, id, 'scene.pkg');
  let r;
  try {
    r = new SceneRenderer(pkg, { width: 480, height: 270, time: 2.5, weAssetsDir: WE, log: (m) => logs.push(String(m)) });
  } catch (e) {
    lines.push(`${id} ${label}: 构造异常 ${String(e.message || e).slice(0, 150)}`);
    continue;
  }
  const t0 = Date.now();
  try {
    const c = r.render();
    let nz = 0, sum = [0, 0, 0];
    for (let i = 0; i < c.data.length; i += 4) { if (c.data[i+3] > 10) { nz++; sum[0]+=c.data[i]; sum[1]+=c.data[i+1]; sum[2]+=c.data[i+2]; } }
    const errs = [...new Set(r._scriptErrors || [])];
    const bad = [...new Set(logs.filter((l) => /MDL|puppet|跳过/.test(l)))];
    lines.push(`${id} ${label}: 渲染${Date.now()-t0}ms 非透明${(nz/(480*270)*100).toFixed(1)}% 平均RGB(${(sum[0]/nz|0)},${(sum[1]/nz|0)},${(sum[2]/nz|0)}) 脚本错误${errs.length}`);
    if (errs.length) lines.push(`  脚本错误: ${errs.slice(0, 3).map(String).join(' | ')}`);
    if (bad.length) lines.push(`  puppet/MDL日志: ${bad.slice(0, 8).join(' | ')}`);
    else lines.push(`  puppet/MDL日志: (无跳过)`);
    const mdlCache = r._mdlCache ? [...r._mdlCache.keys()] : [];
    lines.push(`  _mdlCache(${mdlCache.length}): ${mdlCache.join(', ')}`);
  } catch (e) {
    lines.push(`${id} ${label}: 渲染异常 ${String(e.message || e).slice(0, 200)}`);
    lines.push((e.stack || '').split('\n').slice(0, 5).join('\n'));
  }
}
fs.writeFileSync(path.join(OUT, 'all-scenes.txt'), lines.join('\n'), 'utf8');
console.log('done');
