// 静态帧诊断: 渲染 4 张问题壁纸 + 1 张参考, 存 PNG + 采集错误/日志
import { SceneRenderer, encodePng } from '../lib/scene-renderer.js';
import fs from 'node:fs';
import path from 'node:path';

const WS = 'C:/Program Files (x86)/Steam/steamapps/workshop/content/431960';
const WE = 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine';
const OUT = path.resolve('D:/dsh-wallpaper-engine/.tmp-diag');
fs.mkdirSync(OUT, { recursive: true });

// 复刻 lib/index.js sceneStaticFrameTime (静止态时间)
function staticTime(abs) {
  try {
    const buf = fs.readFileSync(abs);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let pos = 16, count = dv.getInt32(pos - 4, true), sj = null;
    for (let i = 0; i < count; i++) {
      const nameLen = dv.getInt32(pos, true); pos += 4;
      const name = buf.toString('utf8', pos, pos + nameLen); pos += nameLen;
      const off = dv.getUint32(pos, true); const size = dv.getUint32(pos + 4, true); pos += 8;
      if (name === 'scene.json') sj = { off, size };
    }
    if (!sj) return 2.5;
    const sc = JSON.parse(buf.subarray(pos + sj.off, pos + sj.off + sj.size).toString('utf8'));
    const ANIM_KEYS = ['alpha','scale','origin','angles','visible','color','size','brightness','parallaxDepth','zoom'];
    let animEnd = 0, hasSingle = false;
    for (const o of sc.objects || []) for (const k of ANIM_KEYS) {
      const v = o && o[k];
      if (!v || typeof v !== 'object' || !v.animation || !v.animation.options) continue;
      const fps = v.animation.options.fps || 30;
      let last = 0;
      for (const ch of ['c0','c1','c2']) for (const f of (v.animation[ch]||[])) if (f && f.frame > last) last = f.frame;
      if (last > 0) animEnd = Math.max(animEnd, last / fps);
      const m = String(v.animation.options.mode || '');
      if (m !== 'loop' && m !== 'wraploop' && m !== 'mirror') hasSingle = true;
    }
    return hasSingle ? Math.min(Math.max(animEnd + 1/30, 0.1), 60) : 2.5;
  } catch { return 2.5; }
}

const scenes = [
  ['3655429099', '[Luo tianyi]Christmas snow'],
  ['3640755971', '皓风琦电竞【羽】'],
  ['3641860575', '天使の邮件/Angel Mail'],
  ['3486806915', 'Amiya 阿米娅 淡蓝の梦'],
  ['3554161528', '参考: 雪景 (已知渲染良好)'],
];

for (const [id, label] of scenes) {
  const pkg = path.join(WS, id, 'scene.pkg');
  const logs = [];
  let t = 2.5;
  try { t = staticTime(pkg); } catch {}
  let r = null;
  try { r = new SceneRenderer(pkg, { width: 960, height: 540, time: t, weAssetsDir: WE, log: (m) => logs.push(m) }); }
  catch (e) { console.log(`\n=== ${id} ${label} === 构造异常: ${e.message.slice(0, 200)}`); continue; }
  const t0 = Date.now();
  try {
    const c = r.render();
    const png = encodePng(c.w, c.h, c.data);
    const f = path.join(OUT, id + '.png');
    fs.writeFileSync(f, png);
    // 非透明像素 + 颜色统计
    let nz = 0, sum = [0,0,0];
    for (let i = 0; i < c.data.length; i += 4) { if (c.data[i+3] > 10) { nz++; sum[0]+=c.data[i]; sum[1]+=c.data[i+1]; sum[2]+=c.data[i+2]; } }
    console.log(`\n=== ${id} ${label} ===`);
    console.log(`  t=${t.toFixed(2)} 渲染 ${Date.now()-t0}ms, 960x540, 非透明 ${(nz/(960*540)*100).toFixed(1)}%, 平均色 RGB(${(sum[0]/nz|0)},${(sum[1]/nz|0)},${(sum[2]/nz|0)})`);
    console.log(`  脚本错误 ${(r._scriptErrors||[]).length}: ${[...new Set(r._scriptErrors||[])].slice(0,4).map(e=>String(e).slice(0,90)).join(' | ')}`);
    const bad = logs.filter(l => /MDL|跳过|失败|error|Error/.test(String(l)));
    if (bad.length) console.log(`  日志(异常): ${[...new Set(bad)].slice(0,4).map(String).join(' | ')}`);
    console.log(`  PNG: ${f}`);
  } catch (e) {
    console.log(`\n=== ${id} ${label} === 渲染异常: ${e.message.slice(0, 200)}`);
  }
}
