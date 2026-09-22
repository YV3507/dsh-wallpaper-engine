// Rotation prepare/commit smoke for the WebWallGL live staging path.
// 场景壁纸走「live 渲染页 staged 预载 → 首帧确认 → 领养进新层」通道：
// mock iframe 自带 __wpStats 心跳读数（running && fps>0 = 首帧已出），
// 断言 staged iframe 被新层领养（不重建）、we-live-on 立即点亮、staging
// 容器随提交移除、旧层进入渐变淡出。间隔走开发覆盖钩子
// localStorage.weRotationTestSec=10（秒），与生产路径共用同一条定时器武装逻辑。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const React = { Fragment:'Fragment', useState:(i)=>[i,()=>{}], useEffect:()=>{}, useRef:(v)=>({current:v}),
  createElement:(t,p,...c)=>typeof t==='function'?t(p||{}):({type:t,props:p||null,children:c}) };

let byId = {};
const timers = [];
const iframeEls = [];
const videoEls = [];

function makeEl(tag) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {},
    style: { _props:{}, cssText:'', setProperty(k,v){this._props[k]=v;}, removeProperty(k){delete this._props[k];} },
    className: '',
    appendChild(c){ this.children.push(c); if (c.id) byId[c.id]=c; c._parent=this; return c; },
    remove(){ if (this._parent){ const i=this._parent.children.indexOf(this); if(i>=0)this._parent.children.splice(i,1); } if (this.id) delete byId[this.id]; },
    setAttribute(k,v){ this.attributes[k]=v; },
    removeAttribute(k){ delete this.attributes[k]; },
    getAttribute(k){ return this.attributes[k] ?? null; },
    querySelector(sel){
      // 支持 'tag' 与 'tag.class' 两种简单选择器（深度优先）。
      const m = /^([a-z]+)(?:\.(.+))?$/.exec(sel) || [];
      const want = m[1] ? m[1].toUpperCase() : null;
      const wantCls = m[2] || '';
      const walk=(n)=>{ for (const c of n.children){ if (c.tagName===want && (!wantCls || String(c.className).includes(wantCls))) return c; const r=walk(c); if(r)return r; } return null; };
      return walk(this);
    },
    contains(n){ let cur=n; while(cur){ if(cur===this)return true; cur=cur._parent; } return false; },
    addEventListener(ev,fn){ (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev,fn){ const l=listeners[ev]; if(l){const i=l.indexOf(fn); if(i>=0)l.splice(i,1);} },
    __fire(ev){ (listeners[ev]||[]).slice().forEach(f=>f()); },
    play(){ return Promise.resolve(); },
    pause(){},
    load(){},
  };
  // mock getElementById 的 byId 映射跟随 id 赋值实时同步（真实 DOM 语义：
  // 节点级领养会给 staging 容器事后赋 LAYER_ID）。
  let _id = '';
  Object.defineProperty(el, 'id', {
    get: () => _id,
    set: (v) => { if (_id) delete byId[_id]; _id = v || ''; if (v) byId[v] = el; },
  });
  el.classList = {
    add(c){ const parts = el.className ? el.className.split(' ') : []; if (!parts.includes(c)) { parts.push(c); el.className = parts.join(' '); } },
    remove(c){ const parts = el.className ? el.className.split(' ') : []; const i = parts.indexOf(c); if (i >= 0) { parts.splice(i, 1); el.className = parts.join(' '); } },
  };
  if (tag === 'iframe') {
    // live 渲染页控制面/心跳读数：首帧已出（running && fps>0）。
    el.contentWindow = {
      __wpStats: { frame: () => ({ fps: 30, running: true }) },
      __wp: { resume(){}, pause(){}, setVolume(){}, setFit(){}, pushPointer(){}, pointerLeave(){} },
    };
  }
  return el;
}

const bodyEl = makeEl('body');
const document = {
  createElement: (t) => { const el = makeEl(t); if (t==='iframe') iframeEls.push(el); if (t==='video') videoEls.push(el); return el; },
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

const localStorage = {
  _store: { 'dsh-wallpaper-engine:selection': JSON.stringify({
    id:'v', rotationGroupId:'g1', rotationEnabled:true,
    rotationGroups:[{id:'g1',name:'L',interval:5,order:'sequence',wallpaperIds:['v','s']}],
  }), weRotationTestSec: '10' },
  getItem(k){ return this._store[k] ?? null; }, setItem(k,v){ this._store[k]=v; }, removeItem(k){ delete this._store[k]; },
};
const fetch = (url) => Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve(
  String(url).includes('/settings') ? { ok:true, betterSidebar:false } :
  String(url).includes('/media-info') ? { info:null } :
  { installDir:'D:/we', total:2, portableCount:2, playlists:[], wallpapers:[
    { id:'v', title:'V', type:'video', playable:true, media:'/wallpaper-engine/media/vvv', preview:'/wallpaper-engine/preview/vvv', contentrating:'Everyone' },
    { id:'s', title:'S', type:'scene', playable:false, media:null, frameUrl:'/wallpaper-engine/scene-frame/sss',
      sceneLive:true, sceneLiveSrc:'tok-sss', preview:'/wallpaper-engine/preview/sss', contentrating:'Everyone' },
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
  document, localStorage, fetch, React,
  location: { origin: 'http://localhost' },
  setTimeout:(fn,ms)=>{ const t={fn,ms,cleared:false}; timers.push(t); return t; },
  clearTimeout:(t)=>{ if(t)t.cleared=true; },
};
vm.createContext(sandbox);
new vm.Script(code,{filename:'client.js'}).runInContext(sandbox);
const exportsObj = cap.handoff.factory((spec)=> spec==='react'?React:{createPortal:(n)=>n});
const effects = [];
exportsObj.apply({ slots:{inject:(k,cb)=>cb(),register:()=>{}}, effect(fn){ effects.push(fn); fn(); return fn; } });

const fire = (t) => { if (t && !t.cleared) { t.cleared = true; t.fn(); } };
const flushPersist = () => timers.filter(t=>!t.cleared && t.ms===200).forEach(fire);
const stagingDivs = () => bodyEl.children.filter(c => String(c.className).includes('we-layer--staging'));

setTimeout(async () => {
  await Promise.resolve();
  console.log('== boot done ==');
  const rot = timers.find(t=>!t.cleared && t.ms===10000);
  console.log('10s rotation timer armed:', !!rot);
  if (!rot) { console.log('FAIL: no rotation timer'); process.exit(1); }

  console.log('-- fire rotation timer (prepare scene S via live staging) --');
  try { fire(rot); } catch(e){ console.log('EXCEPTION on rotation fire:', e && e.stack || e); process.exit(1); }
  console.log('staged iframes created:', iframeEls.length);
  const staged = iframeEls[iframeEls.length-1];
  console.log('staging div in body:', stagingDivs().length);
  console.log('staged iframe src is scene-live:', String(staged.src).includes('/wallpaper-engine/scene-live/index.html'));
  console.log('staged iframe src carries token:', String(staged.src).includes('tok-sss'));
  const poll = timers.find(t=>!t.cleared && t.ms===300);
  console.log('first-frame poll armed:', !!poll);
  const stagingDiv = stagingDivs()[0] || null;
  console.log('-- fire first-frame poll (stats alive) --');
  try { fire(poll); } catch(e){ console.log('EXCEPTION on poll fire:', e && e.stack || e); process.exit(1); }
  const layer = byId['dsh-wallpaper-engine-layer'];
  console.log('layer rebuilt (fadein):', layer && layer.className);
  console.log('staging container became the layer (node-level adoption):', !!stagingDiv && layer === stagingDiv);
  console.log('layer iframe is staged (never reparented):', layer && layer.querySelector('iframe.we-live-iframe') === staged && staged._parent === layer);
  console.log('adopted iframe lit immediately (we-live-on):', String(staged.className).includes('we-live-on'));
  console.log('staging class gone after commit:', stagingDivs().length === 0);
  flushPersist();
  console.log('persisted id:', JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id);
  console.log('re-armed 10s timer:', timers.some(t=>!t.cleared && t.ms===10000));

  console.log('-- second cycle: back to video V (live → video 渐变) --');
  const rot2 = timers.find(t=>!t.cleared && t.ms===10000);
  fire(rot2);
  const probe = videoEls[videoEls.length-1];
  probe.__fire('canplay');
  const layer2 = byId['dsh-wallpaper-engine-layer'];
  console.log('second commit layer video is probe (adopted):', layer2 && layer2.querySelector('video') === probe);
  console.log('scene layer now fading (weFading):', layer.dataset.weFading === '1');
  flushPersist();
  console.log('persisted id after wrap:', JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id);
  console.log('SMOKE DONE');
}, 50);
