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

// 真失败通道：断言失败 → 非零退出（评审指出此前只有打印，把节点级领养改回
// 元素级（即 0.7.7 修掉的那个 iframe 重载 bug）也能 exit 0）。
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + label + (detail ? ' — ' + detail : ''));
  else { failures++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
};
const persistedId = () => JSON.parse(localStorage._store['dsh-wallpaper-engine:selection']).id;

setTimeout(async () => {
  await Promise.resolve();
  const rot = timers.find(t=>!t.cleared && t.ms===10000);
  check('轮换定时器已武装（测试钩子 10s）', !!rot);
  if (!rot) { console.log('\n' + failures + ' CHECK(S) FAILED'); process.exit(1); }

  try { fire(rot); } catch(e){ console.log('EXCEPTION on rotation fire:', e && e.stack || e); process.exit(1); }
  const staged = iframeEls[iframeEls.length-1];
  const stagingDiv = stagingDivs()[0] || null;
  check('准备阶段创建了 staging 容器', !!stagingDiv, 'staging=' + stagingDivs().length);
  check('staged iframe 指向 scene-live 且带 token',
    String(staged.src).includes('/wallpaper-engine/scene-live/index.html') && String(staged.src).includes('tok-sss'),
    String(staged.src));
  const poll = timers.find(t=>!t.cleared && t.ms===300);
  check('首帧轮询定时器已武装（300ms）', !!poll);
  try { fire(poll); } catch(e){ console.log('EXCEPTION on poll fire:', e && e.stack || e); process.exit(1); }
  const layer = byId['dsh-wallpaper-engine-layer'];
  check('提交后新层带渐变类', !!layer && String(layer.className).includes('we-layer--fadein'),
    layer ? String(layer.className) : 'no layer');
  // 核心回归：节点级领养 —— staging 容器直接变成 layer，iframe 从未被搬动
  //（元素级 appendChild 会让 Chromium 重载 browsing context → 首帧超时）。
  check('staging 容器原地成为 layer（节点级领养）', !!stagingDiv && layer === stagingDiv);
  check('iframe 未被重新挂载（父节点就是 layer）',
    !!layer && layer.querySelector('iframe.we-live-iframe') === staged && staged._parent === layer);
  check('领养后立即点亮 we-live-on', String(staged.className).includes('we-live-on'),
    String(staged.className));
  check('提交后 staging 类名已消失', stagingDivs().length === 0, 'staging=' + stagingDivs().length);
  flushPersist();
  check('提交已持久化到 scene（S）', persistedId() === 's', 'id=' + persistedId());
  check('提交后重新武装轮换定时器', timers.some(t=>!t.cleared && t.ms===10000));

  // 第二轮：live → video，验证渐变退役路径。
  const rot2 = timers.find(t=>!t.cleared && t.ms===10000);
  fire(rot2);
  const probe = videoEls[videoEls.length-1];
  probe.__fire('canplay');
  const layer2 = byId['dsh-wallpaper-engine-layer'];
  check('第二个提交领养了准备好的 video', !!layer2 && layer2.querySelector('video') === probe);
  check('被换下的 scene 层标记为渐变中（weFading）', layer.dataset.weFading === '1',
    'weFading=' + layer.dataset.weFading);
  flushPersist();
  check('第二轮提交持久化回绕到 v', persistedId() === 'v', 'id=' + persistedId());

  console.log('');
  console.log(failures === 0 ? 'SMOKE PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}, 50);
