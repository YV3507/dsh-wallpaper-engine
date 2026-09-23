// Rotation prepare/commit smoke with browser-ish media mocks.
// 间隔走正式版的开发覆盖钩子 localStorage.weRotationTestSec=10（秒），与生产
// 路径（组间隔分钟制）共用同一条定时器武装逻辑。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const React = { Fragment:'Fragment', useState:(i)=>[i,()=>{}], useEffect:()=>{}, useRef:(v)=>({current:v}),
  createElement:(t,p,...c)=>typeof t==='function'?t(p||{}):({type:t,props:p||null,children:c}) };

let byId = {};
const timers = [];
const mediaEls = [];

function makeEl(tag) {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {},
    style: { _props:{}, cssText:'', setProperty(k,v){this._props[k]=v;}, removeProperty(k){delete this._props[k];} },
    className: '',
    appendChild(c){ this.children.push(c); if (c.id) byId[c.id]=c; c._parent=this; return c; },
    remove(){ if (this._parent){ const i=this._parent.children.indexOf(this); if(i>=0)this._parent.children.splice(i,1); } },
    setAttribute(k,v){ this.attributes[k]=v; },
    removeAttribute(k){ delete this.attributes[k]; },
    getAttribute(k){ return this.attributes[k] ?? null; },
    hasAttribute(k){ return k in this.attributes; },
    querySelector(sel){
      const want = sel === 'video' ? 'VIDEO' : sel.includes('canvas') ? 'CANVAS' : null;
      const walk=(n)=>{ for (const c of n.children){ if (c.tagName===want) return c; const r=walk(c); if(r)return r; } return null; };
      return walk(this);
    },
    contains(n){ let cur=n; while(cur){ if(cur===this)return true; cur=cur._parent; } return false; },
    addEventListener(ev,fn){ (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev,fn){ const l=listeners[ev]; if(l){const i=l.indexOf(fn); if(i>=0)l.splice(i,1);} },
    __fire(ev){ (listeners[ev]||[]).slice().forEach(f=>f()); if (ev==='load'&&this.onload) this.onload(); if(ev==='error'&&this.onerror)this.onerror(); },
    play(){ return Promise.resolve(); },
    pause(){},
    load(){},
  };
}

const bodyEl = makeEl('body');
const document = {
  createElement: (t) => { const el = makeEl(t); if (t==='video') mediaEls.push(el); return el; },
  getElementById: (id) => byId[id] || null,
  querySelector: () => null,
  head: { appendChild: () => {} },
  body: bodyEl,
  hidden: false,
  hasFocus: () => true,
  addEventListener(){},
  removeEventListener(){},
  documentElement: makeEl('html'),
};

const imageEls = [];
class ImageMock { constructor(){ this.tagName='IMG'; imageEls.push(this); } }

const localStorage = {
  _store: { 'dsh-wallpaper-engine:selection': JSON.stringify({
    id:'a', rotationGroupId:'g1', rotationEnabled:true,
    rotationGroups:[{id:'g1',name:'L',interval:5,order:'sequence',wallpaperIds:['a','b']}],
  }), weRotationTestSec: '10' },
  getItem(k){ return this._store[k] ?? null; }, setItem(k,v){ this._store[k]=v; }, removeItem(k){ delete this._store[k]; },
};
const fetch = (url) => Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(
  String(url).includes('/settings') ? { ok:true, betterSidebar:false } :
  String(url).includes('/media-info') ? { info:null } :
  { installDir:'D:/we', total:2, portableCount:2, playlists:[], wallpapers:[
    { id:'a', title:'A', type:'video', playable:true, media:'/wallpaper-engine/media/aaa', preview:'/wallpaper-engine/preview/aaa', contentrating:'Everyone' },
    { id:'b', title:'B', type:'video', playable:true, media:'/wallpaper-engine/media/bbb', preview:'/wallpaper-engine/preview/bbb', contentrating:'Everyone' },
  ] }) });

const code = readFileSync(new URL('../lib/client.js', import.meta.url),'utf8');
const cap = { handoff:null };
const sandbox = {
  window: {
    __ModuleLoader__: { load:(h)=>{ cap.handoff=h; } },
    setTimeout:(fn,ms)=>{ const t={fn,ms,cleared:false}; timers.push(t); return t; },
    clearTimeout:(t)=>{ if(t)t.cleared=true; },
    addEventListener(){}, innerWidth:1920, innerHeight:1080, devicePixelRatio:1,
  },
  document, localStorage, fetch, React, Image: ImageMock,
  setTimeout:(fn,ms)=>{ const t={fn,ms,cleared:false}; timers.push(t); return t; },
  clearTimeout:(t)=>{ if(t)t.cleared=true; },
};
vm.createContext(sandbox);
new vm.Script(code,{filename:'client.js'}).runInContext(sandbox);
const exportsObj = cap.handoff.factory((spec)=> spec==='react'?React:{createPortal:(n)=>n});
const effects = [];
exportsObj.apply({ slots:{inject:(k,cb)=>cb(),register:()=>{}}, effect(fn){ effects.push(fn); fn(); return fn; } });

const fire = (t) => { if (t && !t.cleared) { t.cleared = true; t.fn(); } };

// 真失败通道：断言失败 → 非零退出（评审指出此前全是 console.log，打断功能
// 仍会 exit 0，"全过"不可证伪）。
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label + (detail ? ' — ' + detail : ''));
  else { failures++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
};
const persistedId = () => JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id;

setTimeout(async () => {
  await Promise.resolve();
  const rot = timers.find(t=>!t.cleared && t.ms===10000);
  check('轮换定时器已武装（5 分钟组间隔 → 测试钩子 10s）', !!rot);
  if (!rot) { console.log('\n' + failures + ' CHECK(S) FAILED'); process.exit(1); }
  try { fire(rot); } catch(e){ console.log('EXCEPTION on rotation fire:', e && e.stack || e); process.exit(1); }
  check('准备阶段创建了探测 video', mediaEls.length >= 1, 'count=' + mediaEls.length);
  const probe = mediaEls[mediaEls.length-1];
  check('探测 video 指向下一张壁纸且带 preview 海报',
    String(probe.attributes.src || probe.src).includes('/wallpaper-engine/media/bbb') && !!probe.poster,
    'src=' + (probe.attributes.src || probe.src));
  try { probe.__fire('canplay'); } catch(e){ console.log('EXCEPTION on canplay:', e && e.stack || e); failures++; }
  const layer = byId['dsh-wallpaper-engine-layer'];
  check('提交后新层带渐变类', !!layer && String(layer.className).includes('we-layer--fadein'),
    layer ? String(layer.className) : 'no layer');
  check('新层里的 video 就是准备好的探测元素（领养而非重建）',
    !!layer && layer.querySelector('video') === probe);
  // 持久化有 200ms 防抖：先冲掉写盘定时器再断言落库。
  timers.filter(t=>!t.cleared && t.ms===200).forEach(fire);
  check('提交已持久化到下一张（b）', persistedId() === 'b', 'id=' + persistedId());
  check('提交后重新武装轮换定时器', timers.some(t=>!t.cleared && t.ms===10000));

  // 第二轮：准备超时回退（不触发 canplay，直接打 20s 准备超时）
  const rot2 = timers.find(t=>!t.cleared && t.ms===10000);
  fire(rot2);
  const probe2 = mediaEls[mediaEls.length-1];
  const t20 = timers.find(t=>!t.cleared && t.ms===20000);
  check('准备超时定时器已武装（20s）', !!t20);
  try { fire(t20); } catch(e){ console.log('EXCEPTION on prep timeout:', e && e.stack || e); failures++; }
  const layer2 = byId['dsh-wallpaper-engine-layer'];
  check('超时回退也领养了准备好的元素并提交',
    !!layer2 && layer2.querySelector('video') === probe2);
  timers.filter(t=>!t.cleared && t.ms===200).forEach(fire);
  check('第二轮提交持久化回绕到 a', persistedId() === 'a', 'id=' + persistedId());

  console.log('');
  console.log(failures === 0 ? 'SMOKE PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}, 50);

