// 验证 evaluateNumericIfs 修复: 两个失败 shader 预处理后应无残留条件指令
import { SceneRenderer } from '../lib/scene-renderer.js';
import { evaluateNumericIfs } from '../lib/we-renderer/glsl/preprocess.js';
import fs from 'node:fs';

const WE = 'C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine';
const cases = [
  ['3641860575', 'shaders/workshop/3573886911/effects/frame_builder_by_gariam'],
  ['3554161528', 'shaders/workshop/3083593512/effects/rounded_mask'],
];
let fail = 0;
for (const [id, stem] of cases) {
  const r = new SceneRenderer('C:/Program Files (x86)/Steam/steamapps/workshop/content/431960/' + id + '/scene.pkg', { width: 100, height: 100, time: 0, weAssetsDir: WE, log: () => {} });
  let src = r.pkg.readText(stem + '.frag') || '';
  const incCache = {};
  const resolveInc = (inc) => {
    if (incCache[inc] !== undefined) return incCache[inc];
    let o = '';
    const p = WE + '/assets/shaders/' + inc;
    if (fs.existsSync(p)) o = fs.readFileSync(p, 'utf8');
    else o = r.pkg.readText('shaders/' + inc) || '';
    incCache[inc] = o;
    return o;
  };
  const expand = (s, seen = new Set()) => s.replace(/^\s*#\s*include\s+"([^"]+)"/gm, (mm, inc) => {
    if (seen.has(inc)) return '';
    seen.add(inc);
    return expand(resolveInc(inc), seen);
  });
  const expanded = expand(src).replace(/\r/g, '');
  const out = evaluateNumericIfs(expanded, {});
  const residual = (out.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/gm) || []).length;
  const ok = residual === 0;
  if (!ok) fail++;
  console.log((ok ? '✅' : '❌') + ' ' + id + ' ' + stem.split('/').pop() + ': 残留条件指令 ' + residual);
  if (!ok) {
    // 复刻判定逻辑找出不可判定条件 (仅诊断)
    const defines = {};
    const srcDefs = {};
    {
      let depth = 0;
      for (const l of expanded.split('\n')) {
        const t = l.trim();
        if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) { depth++; continue; }
        if (/^#\s*endif\b/.test(t)) { depth = Math.max(0, depth - 1); continue; }
        if (depth === 0) { const dm = /^#\s*define\s+([A-Za-z_]\w*)\s+(\S+)/.exec(t); if (dm) srcDefs[dm[1]] = dm[2]; }
      }
    }
    const resolve = (n) => {
      const v = defines[n];
      if (v !== undefined && v !== null && v !== '') return String(v).replace(/^["']|["']$/g, '');
      if (srcDefs[n] !== undefined) return String(srcDefs[n]);
      return null;
    };
    const isDef = (n) => resolve(n) !== null;
    function evalCond(cond) {
      let c = String(cond).trim();
      for (;;) {
        if (!c.startsWith('(')) break;
        let dep = 0, closed = false;
        for (let i = 0; i < c.length; i++) { if (c[i] === '(') dep++; else if (c[i] === ')') { dep--; if (dep === 0) { closed = i === c.length - 1; break; } } }
        if (closed) c = c.slice(1, -1).trim(); else break;
      }
      let dm = /^(!?)\s*defined\s*\(\s*([A-Za-z_]\w*)\s*\)$/.exec(c);
      if (dm) return dm[1] ? !isDef(dm[2]) : isDef(dm[2]);
      const top = (op) => { let dep = 0; for (let i = 0; i < c.length; i++) { if (c[i] === '(') dep++; else if (c[i] === ')') dep--; else if (dep === 0 && c.startsWith(op, i)) return i; } return -1; };
      const oi = top('||'); if (oi >= 0) { const a = evalCond(c.slice(0, oi)), b = evalCond(c.slice(oi + 2)); if (a === null || b === null) return null; return a || b; }
      const ai = top('&&'); if (ai >= 0) { const a = evalCond(c.slice(0, ai)), b = evalCond(c.slice(ai + 2)); if (a === null || b === null) return null; return a && b; }
      let m = /^(!?)\s*([A-Za-z_]\w*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?|[A-Za-z_]\w*)$/.exec(c);
      if (m) {
        const lv = resolve(m[2]) ?? '0';
        let rv = /^-?\d/.test(m[4]) ? m[4] : (resolve(m[4]) !== null ? resolve(m[4]) : m[4]);
        const ln = parseFloat(lv), rn = parseFloat(rv);
        if (isFinite(ln) && isFinite(rn)) { let rr; switch (m[3]) { case '==': rr = ln === rn; break; case '!=': rr = ln !== rn; break; case '>=': rr = ln >= rn; break; case '<=': rr = ln <= rn; break; case '>': rr = ln > rn; break; case '<': rr = ln < rn; break; } return m[1] ? !rr : rr; }
        return null;
      }
      m = /^(!?)\s*([A-Za-z_]\w*)$/.exec(c);
      if (m) { const s = resolve(m[2]) ?? '0'; const t = s !== '0' && s.toLowerCase() !== 'false' && s !== ''; return m[1] ? !t : t; }
      return null;
    }
    expanded.split('\n').forEach((l, i) => {
      const t = l.trim();
      let m = /^#\s*(?:if|elif)\s+(.+)$/.exec(t);
      if (m && evalCond(m[1]) === null) console.log('    不可判定 L' + (i + 1) + ': ' + t.slice(0, 110));
    });
  }
}
process.exit(fail ? 1 : 0);
