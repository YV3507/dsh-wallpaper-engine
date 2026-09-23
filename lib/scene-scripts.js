// WE scene scripts 运行时: 执行 {script, value} 对象的 JS 脚本 (NSL)
// 支持: export function update(value) — 每帧更新 (返回新值)
//       export function applyUserProperties(changed) — 用户属性变化更新
//       export function init(value) — 初始化一次 (返回新值; NSL init(value))
// 提供 WEColor / createScriptProperties / engine.canvasSize / Vec3 等引擎 API (vm 沙箱)
// 用户属性 (project.json general.properties) 注入 scriptProperties (user 映射)
//
// 关键设计 (sf35 重构): 脚本**编译一次、状态跨帧保留** — 旧实现每帧重编译导致
// NSL 脚本内部状态 (计数器/动画调度器) 每帧重置、大型脚本每帧编译 CPU 爆表,
// 且 init() 每帧重复调用。现在:
//   - createScriptCache() 持有 {map: Map<源码, 编译条目>, shared}
//   - 每个 SceneRenderer 实例一个 cache (scene-anim 多帧复用实例 → 状态跨帧保留)
//   - 同一源码只编译一次; init() 只在首次执行; 每帧只调 update(value)
//   - thisObject/thisLayer 通过 ownerRef 代理指向"当前脚本所属对象" (缓存共享
//     时对象不串); 读写真实渲染对象 (origin/scale/visible/alpha/animationlayers)
//   - engine API 补全 (isRunningInEditor 等) — NSL 库 (如 Mutsumi 788) 缺失
//     方法时中途抛错 → 后续 shared 赋值全部丢失 → 整个动画框架失效
//
// ── 通用场景脚本 API 补全 (第一手证据: 官方 scenescript64.dll 绑定表 + 官方 JS 类库) ──
// 官方把绑定表打在 scenescript64.dll.c:5772401-5772532 (thisScene 模板) 与
// 5789008-5789683 (globals: console/engine/input/localStorage/thisScene/Vec*/...):
//   thisScene: getLayer getLayerByID getLayerCount enumerateLayers destroyLayer
//              createLayer sortLayer getLayerIndex getInitialLayerConfig
//              getCameraTransforms setCameraTransforms getAnimation
//              createModelData destroyModelData
//   engine   : isRunningInEditor isPortrait isLandscape registerAudioBuffers
//              registerAsset setTimeout setInterval clearTimeout isMobileDevice
//              isDesktopDevice isWallpaper isScreensaver isObjectValid
//              openUserShortcut + 属性 screenResolution canvasSize userProperties
//              timeOfDay frametime runtime AUDIO_RESOLUTION_16/32/64
//   input    : cursorWorldPosition cursorScreenPosition cursorLeftDown
//   localStorage: get set delete clear keys + LOCATION_GLOBAL/LOCATION_SCREEN
// 旧实现只有 thisScene.getLayer/getSceneObject + engine.registerAsset 桩:
//   · 官方默认壁纸 dino_run (scene.json objects[22].visible 主控脚本) 的 init()
//     第一句 `thisScene.getLayerIndex('postprocess')` → TypeError → 吞进 catch →
//     entry.initialized 永不置位 → update() 同样永不执行 → 25 个图层可见性/
//     动画/金币逻辑全死 (只显示 scene.json 里静态 visible 的 11 个对象)。
//   · localStorage 缺失 → dino_run init 第 4 句 `localStorage.get('highscore', ...)` 抛错。
// applyUserProperties 语义 (官方文档 docs.wallpaperengine.io/en/scene/scenescript/
// reference/event/applyUserProperties.html + UI 内联帮助 ui/dist/scripts/scripts.js:
// "...only includes user properties that were recently changed!"):
//   "It will be called once initially when the wallpaper is loaded." — 首次调用带
//   **全部**用户属性; 之后仅带变化项。旧实现首次就传 `{}` → `if (userProperties.level)`
//   类判断全假 → dino_run 的关卡/恐龙选择、razer_vortex 的 colormode 全部不生效。
import vm from 'node:vm';
import { WEColor, WEMath, WEVector, Vec2, Vec3, ScriptPropertiesBuilder } from './scene-script-apis.js';

// ── 脚本运行期错误收集 (诊断; 旧实现静默吞掉) ──────────────────────────────
// worker/探针可通过 collectScriptErrors() 取出, 定位"某脚本为何全无效果"。
const _scriptErrors = [];
export function collectScriptErrors() { return _scriptErrors.slice(); }
export function clearScriptErrors() { _scriptErrors.length = 0; }
function _noteScriptError(where, phase, err) {
  if (_scriptErrors.length < 300) {
    _scriptErrors.push(`[${phase}] ${where}: ${err && err.message ? err.message : String(err)}`);
  }
}

// ── localStorage (官方 scenescript64.dll.c:5789595-5789666 绑定) ────────────
// 官方是"每个壁纸一份持久化键值" (workshop 目录下 storage 文件)。本地渲染为
// 单进程单帧, 用内存 Map 实现同语义; 值可为字符串/Vec3 (写入时取 toConfigString)。
const _localStorageMem = new Map();
const localStorageApi = {
  LOCATION_GLOBAL: 0,
  LOCATION_SCREEN: 1,
  global: 0,
  screen: 1,
  get(key) {
    const v = _localStorageMem.get(String(key));
    return v === undefined ? undefined : v;
  },
  set(key, value) {
    let v = value;
    if (v && typeof v === 'object' && typeof v.toConfigString === 'function') v = v.toConfigString();
    _localStorageMem.set(String(key), v);
  },
  delete(key) { _localStorageMem.delete(String(key)); },
  clear() { _localStorageMem.clear(); },
  keys() { return [..._localStorageMem.keys()]; },
  enumerate() { return [..._localStorageMem.entries()]; },
};
// 测试/工具用途: 直接访问内存后端
export function _localStorageBackend() { return _localStorageMem; }

// asset 句柄 (engine.registerAsset 的返回值): 官方返回可交给 thisScene.createLayer
// 的素材引用。这里保留路径 + 素材 JSON (供 createLayer 生成渲染对象)。
function makeAssetToken(path) {
  const token = {
    __assetPath: path,
    __assetKind: /\.particle$/i.test(path) || /^particles\//i.test(path) ? 'particle'
      : /^sounds?\//i.test(path) ? 'sound' : 'image',
    getAsset: () => token,
    getName: () => path,
  };
  return token;
}

// 解析 createLayer 的入参: 字符串路径 / asset 句柄 / 已解析对象
function assetPathOf(asset) {
  if (!asset) return null;
  if (typeof asset === 'string') return asset;
  if (typeof asset.__assetPath === 'string') return asset.__assetPath;
  if (typeof asset.getAsset === 'function') {
    try { return assetPathOf(asset.getAsset()); } catch { return null; }
  }
  if (typeof asset.path === 'string') return asset.path;
  if (typeof asset.file === 'string') return asset.file;
  return null;
}

// NSL thisScene: getLayer(name) → 图层包装, 读写真实场景对象属性
// origin/scale/size 字符串 "x y z" ↔ Vec3; visible/alignment 直接读写
// 脚本对象 {script, value} 取 value (715 读 Launcher scale 时其脚本可能尚未
// 执行/已执行 — 读最终 value 而非原始 {script,value} 对象)
export function makeSceneRef(objects) {
  const rawVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const parseV = (s, def) => {
    const v = rawVal(s);
    const p = String(v == null ? '' : v).trim().split(/\s+/).map(Number);
    return new Vec3(p[0] ?? def[0], p[1] ?? def[1], p[2] ?? def[2]);
  };
  const setV = (holder, key, v) => {
    if (v == null) return;
    const x = v.x != null ? v.x : v[0];
    const y = v.y != null ? v.y : v[1];
    const z = v.z != null ? v.z : v[2];
    holder[key] = `${Number(x ?? 0).toFixed(6)} ${Number(y ?? 0).toFixed(6)} ${Number(z ?? 0).toFixed(6)}`;
  };
  const layer = (obj) => ({
    // 反向引用: destroyLayer/getLayerIndex 需要识别"图层包装"对应的真实对象
    get __obj() { return obj; },
    get visible() { return obj.visible !== false; },
    set visible(v) { obj.visible = !!v; },
    get alignment() { return obj.alignment; },
    set alignment(v) { obj.alignment = v; },
    get size() { return parseV(obj.size, [0, 0, 0]); },
    set size(v) { setV(obj, 'size', v); },
    get scale() { return parseV(obj.scale, [1, 1, 1]); },
    set scale(v) { setV(obj, 'scale', v); },
    get origin() { return parseV(obj.origin, [0, 0, 0]); },
    set origin(v) { setV(obj, 'origin', v); },
    get alpha() { return obj.alpha != null ? Number(obj.alpha) : 1; },
    set alpha(v) { obj.alpha = Number(v); },
    // 文本图层 (thisScene.getLayer('label_coins').text = ...): 官方 CText 直接写文本
    get text() { return rawVal(obj.text); },
    set text(v) { obj.text = v; },
    get name() { return obj.name || ''; },
    get id() { return obj.id; },
    // 声音图层的播放控制 (dino_run: thisScene.getLayer('jump').play())
    play: () => {}, stop: () => {}, pause: () => {}, resume: () => {},
    // 动画层 (骨骼) 引用
    getAnimationLayer: () => null,
    getAnimation: () => makeSceneRef.animStub(obj),
    getParent: () => makeSceneRef.getParentOf(objList, obj),
    clicked: false,
    cursorDetected: false,
  });
  const objList = Array.isArray(objects) ? objects : [];
  return {
    getLayer: (name) => {
      const obj = objList.find((o) => o && o.name === name);
      return obj ? layer(obj) : layer({ name, origin: '0 0 0', scale: '1 1 1', size: '0 0 0', visible: true, id: -1 });
    },
    getSceneObject: (id) => {
      const obj = objList.find((o) => o && o.id === id);
      return obj ? layer(obj) : null;
    },
    // 官方 thisScene.getLayerByID / getLayerCount / enumerateLayers / getLayerIndex
    getLayerByID: (id) => {
      const obj = objList.find((o) => o && o.id === id);
      return obj ? layer(obj) : null;
    },
    getLayerCount: () => objList.length,
    enumerateLayers: () => objList.map((o) => layer(o)),
    // getLayerIndex: 对象在渲染顺序中的下标 (dino_run 用它取后处理层序号做 sortLayer)
    getLayerIndex: (name) => {
      if (name && typeof name === 'object') {
        const idx = objList.indexOf(name.__obj || name);
        return idx;
      }
      return objList.findIndex((o) => o && o.name === name);
    },
    getInitialLayerConfig: () => ({}),
    // createLayer(asset): 官方按素材生成新图层 (dino_run 的金币/粒子)。
    // 生成的图层登记进渲染对象数组 (renderObjects), 可被 origin/scale/visible
    // 正常读写; 删除见 destroyLayer。
    createLayer: (asset) => {
      const p = assetPathOf(asset);
      const id = _nextScriptLayerId--;
      const rec = {
        id,
        name: 'script_layer_' + Math.abs(id),
        origin: '0 0 0',
        scale: '1 1 1',
        visible: true,
        _scriptLayer: true,
      };
      if (p) {
        if (/^particles?\//i.test(p)) { rec.particle = p; rec._renderType = 'particle'; }
        else if (/^sounds?\//i.test(p)) { rec.sound = [p]; rec._renderType = 'sound'; }
        else if (/^models\//i.test(p) || /\.json$/i.test(p)) { rec.image = p; rec._renderType = 'image'; }
        else { rec.image = p; rec._renderType = 'image'; }
      } else {
        rec._renderType = 'image';
      }
      rec.__obj = rec;
      objList.push(rec);
      return layer(rec);
    },
    destroyLayer: (l) => {
      const o = l && l.__obj ? l.__obj : l;
      const i = objList.indexOf(o);
      if (i >= 0) objList.splice(i, 1);
      return true;
    },
    // sortLayer(layer, index): 创建图层的绘制次序 (金币需排在 postprocess 之前)
    sortLayer: () => true,
    getCameraTransforms: () => null,
    setCameraTransforms: () => {},
    getAnimation: () => null,
    createModelData: () => ({}),
    destroyModelData: () => {},
  };
}
let _nextScriptLayerId = -100000;
// ILayer.getAnimation(name) 的动画句柄桩 (官方 ILayerAnimation; 骨骼/关键帧播放
// 未实现 → 各 setter/play 为空操作, 但**必须存在**: 缺失会让 init() 抛 TypeError)
makeSceneRef.animStub = (obj) => ({
  play: () => {}, pause: () => {}, stop: () => {}, resume: () => {},
  onFinish: () => {}, addEndedCallback: () => {},
  setFrame: () => {}, setTime: () => {}, setFps: () => {}, setRate: () => {},
  setFrameCount: () => {}, getFrame: () => 0, getFrameCount: () => 0,
  isPlaying: () => false,
});
// getParent 需要对象表: 用一个静态辅助挂到 makeSceneRef 上 (避免每个 layer 闭包重复)
makeSceneRef.getParentOf = (objList, obj) => {
  const parent = obj && obj.parent != null ? objList.find((x) => x && x.id === obj.parent) : null;
  const rawVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const parseV = (s, def) => {
    const v = rawVal(s);
    const p = String(v == null ? '' : v).trim().split(/\s+/).map(Number);
    return new Vec3(p[0] ?? def[0], p[1] ?? def[1], p[2] ?? def[2]);
  };
  const target = parent || { origin: '0 0 0', scale: '1 1 1', visible: true, id: -1, name: '' };
  return {
    get origin() { return parseV(target.origin, [0, 0, 0]); },
    set origin(v) {
      if (!parent || v == null) return;
      const x = v.x != null ? v.x : v[0], y = v.y != null ? v.y : v[1], z = v.z != null ? v.z : v[2];
      target.origin = `${Number(x ?? 0).toFixed(6)} ${Number(y ?? 0).toFixed(6)} ${Number(z ?? 0).toFixed(6)}`;
    },
    get scale() { return parseV(target.scale, [1, 1, 1]); },
    set scale(v) {
      if (!parent || v == null) return;
      const x = v.x != null ? v.x : v[0], y = v.y != null ? v.y : v[1], z = v.z != null ? v.z : v[2];
      target.scale = `${Number(x ?? 0).toFixed(6)} ${Number(y ?? 0).toFixed(6)} ${Number(z ?? 0).toFixed(6)}`;
    },
    get visible() { return target.visible !== false; },
    set visible(v) { if (parent) target.visible = !!v; },
    get name() { return target.name || ''; },
    get id() { return target.id; },
    getParent: () => ({ origin: new Vec3(0, 0, 0), scale: new Vec3(1, 1, 1), visible: true, name: '', id: -1 }),
  };
};

// 当前脚本所属对象代理: thisObject/thisLayer 通过它指向"当前对象",
// 使缓存共享的编译条目在多个对象间不串 (每次 update 前 ownerRef.current 更新)。
function makeOwnerRef(objects) {
  const ref = { current: null };
  const objList = Array.isArray(objects) ? objects : [];
  const rawVal = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
  const parseV = (s, def) => {
    const v = rawVal(s);
    const p = String(v == null ? '' : v).trim().split(/\s+/).map(Number);
    return new Vec3(p[0] ?? def[0], p[1] ?? def[1], p[2] ?? def[2]);
  };
  const setV = (holder, key, v, raw) => {
    if (v == null) return;
    const x = v.x != null ? v.x : v[0];
    const y = v.y != null ? v.y : v[1];
    const z = v.z != null ? v.z : v[2];
    holder[key] = raw
      ? `${x} ${y} ${z}`
      : `${Number(x ?? 0).toFixed(6)} ${Number(y ?? 0).toFixed(6)} ${Number(z ?? 0).toFixed(6)}`;
  };
  const animRef = (obj) => ({
    play: () => {}, pause: () => {}, stop: () => {}, resume: () => {},
    onFinish: () => {}, addEndedCallback: () => {},
    setFrame: () => {}, setTime: () => {}, setFps: () => {},
    setVisible: () => {}, setBlend: () => {}, setRate: () => {}, setScale: () => {},
    setOrigin: () => {}, setAngles: () => {}, setAlpha: () => {}, setColor: () => {},
    setSize: () => {}, setParallaxDepth: () => {}, setPosition: () => {}, setBrightness: () => {},
    setColorBlendMode: () => {}, getAnimationLayerCount: () => (obj && obj.animationlayers ? obj.animationlayers.length : 1),
    setFrameCount: () => {},
    getFrame: () => 0, getFrameCount: () => 0, isPlaying: () => false,
  });
  const layerRef = () => {
    const obj = ref.current;
    return {
      getAnimationLayer: (i) => animRef(obj),
      // getAnimation(name): ILayer 动画句柄 (Mutsumi 背景层脚本
      // `thisLayer.getAnimation("beijingdonghua").play()` — 缺失 → init 抛 TypeError,
      // 该层开场动画永不播放)
      getAnimation: () => animRef(obj),
      // getParent: 官方返回父图层 (可读写 origin/visible/scale); 旧实现返回一次性
      // 快照对象 → `parent.origin = x` 写进垃圾对象 (Mutsumi App Dock 拖拽逻辑失效)
      getParent: () => (obj ? makeSceneRef.getParentOf(objList, obj) : { origin: new Vec3(0, 0, 0), visible: true }),
      get visible() { return obj ? obj.visible !== false : true; },
      set visible(v) { if (obj) obj.visible = !!v; },
      get origin() { return obj ? parseV(obj.origin, [0, 0, 0]) : new Vec3(0, 0, 0); },
      set origin(v) { if (obj) setV(obj, 'origin', v); },
      get scale() { return obj ? parseV(obj.scale, [1, 1, 1]) : new Vec3(1, 1, 1); },
      set scale(v) { if (obj) setV(obj, 'scale', v); },
      get size() { return obj ? parseV(obj.size, [0, 0, 0]) : new Vec3(0, 0, 0); },
      set size(v) { if (obj) setV(obj, 'size', v); },
      get alignment() { return obj ? obj.alignment : undefined; },
      set alignment(v) { if (obj) obj.alignment = v; },
      get alpha() { return obj ? (obj.alpha != null ? Number(obj.alpha) : 1) : 1; },
      set alpha(v) { if (obj) obj.alpha = Number(v); },
      get text() { return obj ? rawVal(obj.text) : ''; },
      set text(v) { if (obj) obj.text = v; },
      get angles() { return obj ? parseV(obj.angles, [0, 0, 0]) : new Vec3(0, 0, 0); },
      set angles(v) { if (obj) setV(obj, 'angles', v); },
      get name() { return obj ? obj.name || '' : ''; },
      get id() { return obj ? obj.id : 0; },
      play: () => {}, stop: () => {}, pause: () => {},
      cursorDetected: false,
      clicked: false,
    };
  };
  const objectRef = () => {
    const obj = ref.current;
    return {
      getMaterial: () => ({}),
      getAnimation: () => animRef(obj),
      get origin() { return obj ? parseV(obj.origin, [0, 0, 0]) : new Vec3(0, 0, 0); },
      set origin(v) { if (obj) setV(obj, 'origin', v, true); },
      get scale() { return obj ? parseV(obj.scale, [1, 1, 1]) : new Vec3(1, 1, 1); },
      set scale(v) { if (obj) setV(obj, 'scale', v, true); },
      get visible() { return obj ? obj.visible !== false : true; },
      set visible(v) { if (obj) obj.visible = !!v; },
      get name() { return obj ? obj.name || '' : ''; },
      get id() { return obj ? obj.id : 0; },
    };
  };
  return {
    ref,
    makeLayer: layerRef,
    makeObject: objectRef,
    setOwner(o) { ref.current = o; },
  };
}

// 编译脚本: 返回 { update, applyUserProperties, init, ... } 函数 (vm 沙箱)
// opts: { canvasSize, userProps, shared, thisScene, ownerRef, runtime }
// NSL 模块映射: import * as X from 'WEColor'/'WEMath'/'WEVector' → 对应全局对象
// (旧转译把一切 import * as 映射到 __WEColor — WEMath 模块的函数全部丢失,
//  726 Launcher 报 "WEMath.smoothStep is not a function" → update 失败;
//  WEVector 同样丢失 → 3449579583 音乐封面脚本 "WEVector.angleVector2 is not a function")
const _MODULES = { WEColor: '__WEColor', WEMath: '__WEMath', WEVector: '__WEVector' };
function _moduleGlobal(name) { return _MODULES[name] || '__WEColor'; }
function compileScript(source, opts = {}) {
  // 转译 ESM 导入/导出为 CommonJS
  let code = source;
  code = code.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g, (m, name, mod) => {
    return `const ${name} = ${_moduleGlobal(mod)};`;
  });
  code = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g, (m, names, mod) => {
    const src = _moduleGlobal(mod);
    return `const { ${names} } = ${src};`;
  });
  code = code.replace(/export\s+function\s+(\w+)\s*\(/g, '__exports.$1 = function (');
  code = code.replace(/export\s+var\s+scriptProperties\s*=\s*([^;]+);/g, '__scriptProps = $1;');
  code = code.replace(/export\s+let\s+([\w$]+)\s*=\s*([^;]+);/g, '__exports.$1 = $2;');
  code = code.replace(/export\s+const\s+([\w$]+)\s*=\s*([^;]+);/g, '__exports.$1 = $2;');
  code = code.replace(/export\s*\{([^}]+)\}/g, (m, names) => {
    return names.split(',').map((n) => {
      const nn = n.trim();
      const [orig, alias] = nn.includes(' as ') ? nn.split(' as ').map((s) => s.trim()) : [nn, nn];
      return `__exports.${alias} = ${orig};`;
    }).join('\n');
  });
  // scriptProperties 使用: 脚本内 `scriptProperties.x` 需指向构建的属性对象
  code = code.replace(/\bscriptProperties\b/g, '__scriptProperties');
  const shared = opts.shared || {};
  const ownerRef = opts.ownerRef || makeOwnerRef(opts.renderObjects);
  const context = {
    __WEColor: WEColor,
    __WEMath: WEMath,
    __WEVector: WEVector,
    __exports: {},
    __scriptProps: null, // export var scriptProperties = ... 写入
    __scriptProperties: null, // 脚本内 scriptProperties 引用
    Date, Math, console, JSON, Number, String, Boolean, Object, Array, Set, Map, Promise,
    Float32Array, Float64Array, Int32Array, Uint8Array, ArrayBuffer,
    parseFloat, parseInt, isNaN, isFinite, Infinity, NaN, undefined,
    Vec2,
    Vec3,
    // NSL 数学工具 (726 Launcher 等用 WEMath.mix/clamp/smoothStep)
    WEMath,
    // 鼠标/输入 (本地无鼠标 → 画布中心, 静止): NSL Dock 逻辑 (715 L126
    // input.cursorWorldPosition) 缺失 → update 抛错 → shared 值不计算
    input: {
      cursorWorldPosition: new Vec3((opts.canvasSize || { x: 3840 }).x / 2, (opts.canvasSize || { y: 2160 }).y / 2, 0),
      cursorScreenPosition: new Vec2((opts.canvasSize || { x: 3840 }).x / 2, (opts.canvasSize || { y: 2160 }).y / 2),
      cursorDelta: new Vec3(0, 0, 0),
      cursorVelocity: 0,
      mousePressed: false,
      cursorLeftDown: false,
      mouseDelta: new Vec3(0, 0, 0),
    },
    createScriptProperties: () => new ScriptPropertiesBuilder(opts.userProps),
    // thisScene: NSL 场景引用 — getLayer(name) 返回图层包装 (读写真实场景对象)
    thisScene: opts.thisScene || makeSceneRef([]),
    localStorage: localStorageApi,
    engine: {
      registerAsset: (p) => makeAssetToken(p),
      canvasSize: opts.canvasSize || { x: 3840, y: 2160 },
      screenResolution: opts.canvasSize || { x: 3840, y: 2160 },
      runtime: opts.runtime || 0,
      frametime: opts.frametime || 1 / 60,
      timeOfDay: 0,
      userProperties: opts.userProps || {},
      // NSL 库 (Mutsumi 788 等) 依赖编辑器环境探测; 缺失此方法 → 脚本中途抛错,
      // 后续 shared 赋值全部丢失 → 整个动画框架失效
      isRunningInEditor: () => false,
      isPortrait: () => false,
      isLandscape: () => true,
      isWallpaper: () => true,
      isScreensaver: () => false,
      isMobileDevice: () => false,
      isDesktopDevice: () => true,
      isObjectValid: () => true,
      // 音频分辨率常量 (官方 scenescript64.dll.c:5789425-5789447: 16/32/64)
      AUDIO_RESOLUTION_16: 16,
      AUDIO_RESOLUTION_32: 32,
      AUDIO_RESOLUTION_64: 64,
      // registerAudioBuffers(resolution) → AudioBuffers (官方文档
      // docs.wallpaperengine.io/en/scene/scenescript/reference/class/AudioBuffers.html:
      // `average`/`left`/`right` 为 Float32Array, 长度 = resolution, 取值 ~0..1, 每帧更新)。
      // **必须在全局作用域可用**: 工坊脚本惯例在模块顶层注册
      // (`export var audioBuffer = engine.registerAudioBuffers(engine.AUDIO_RESOLUTION_16);`
      //  — Mutsumi 3629379075 的 68 个 NSL 脚本如此), 缺失 → vm 全局作用域抛
      // TypeError → __exports 里的 init/update 全部未赋值 → 脚本彻底失效
      // (实测: 该壁纸全部时钟/日期/星期文本层 0 像素)。
      // 本地静态帧无音频输入 → 官方"静音"取值 = 全 0 (非伪造数据)。
      registerAudioBuffers: (resolution) => {
        const n = Math.max(1, Math.min(256, Number(resolution) || 16));
        return { average: new Float32Array(n), left: new Float32Array(n), right: new Float32Array(n), resolution: n };
      },
      // openUserShortcut: 官方返回 Boolean (未执行任何动作 → false)
      openUserShortcut: () => false,
      // setTimeout 必须异步延迟 — 旧实现立即同步执行回调, NSL 库的调度递归
      // (动画推进/节流) 会同步无限递归卡死主线程
      setTimeout: (fn, ms) => {
        // 修复: 定时器句柄登记到 _pendingTimers, 由 clearScriptTimers() 帧末清理
        const t = setTimeout(() => { _pendingTimers.delete(t); try { fn(); } catch { /* ignore */ } }, Math.max(0, Number(ms) || 0));
        _pendingTimers.add(t);
        return () => clearTimeout(t);
      },
      clearTimeout: (t) => { try { clearTimeout(t); } catch { /* ignore */ } },
      setInterval: (fn, ms) => {
        const t = setInterval(() => { try { fn(); } catch { /* ignore */ } }, Math.max(1, Number(ms) || 1));
        _pendingTimers.add(t);
        return () => clearInterval(t);
      },
      clearInterval: (t) => { try { clearInterval(t); } catch { /* ignore */ } },
    },
    shared,
    thisObject: ownerRef.makeObject(),
    thisLayer: ownerRef.makeLayer(),
  };
  context.globalThis = context;
  vm.createContext(context);
  try {
    vm.runInContext(code, context, { timeout: 2000 });
  } catch (e) {
    return { error: e.message, exports: context.__exports, scriptProps: context.__scriptProps, ownerRef };
  }
  // scriptProperties 构建: __scriptProps 是 builder 或对象
  let props = null;
  if (context.__scriptProps instanceof ScriptPropertiesBuilder) {
    props = context.__scriptProps.finish();
  } else if (context.__scriptProps && typeof context.__scriptProps === 'object') {
    props = context.__scriptProps;
  }
  context.__scriptProperties = props;
  return { exports: context.__exports, scriptProps: props, context, ownerRef };
}

// value → 脚本可操作对象 (Vec3 / number / 原样)
// 注意: 只有"纯数字"字符串才转 Vec3 (如 "0.5 0.5 0") — 文本类脚本的 value
// 是多词字符串 (如 "Text Layer"、"Good day!"), 误转 Vec3 会让 update 返回
// 的文本被 formatResult 格式化破坏 (FPS 计数器实测 "Text Layer" → "0.000000 ...")
function toValueObj(value) {
  if (typeof value === 'string') {
    const parts = value.trim().split(/\s+/);
    if (parts.length >= 2 && parts.every((p) => p !== '' && isFinite(Number(p)))) {
      const nums = parts.map(Number);
      return new Vec3(nums[0], nums[1], nums[2] || 0);
    }
    return value; // 非纯数字字符串 → 保持原样 (文本)
  }
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') return value;
  return value;
}
// 脚本返回值 → 存储值 (Vec3/{x,y,z} → "x y z")
function formatResult(result) {
  if (result instanceof Vec3 || (typeof result === 'object' && !Array.isArray(result) && 'x' in result && 'y' in result && 'z' in result)) {
    return `${Number(result.x).toFixed(6)} ${Number(result.y).toFixed(6)} ${Number(result.z).toFixed(6)}`;
  }
  return result;
}

// 创建脚本运行时: 缓存 Map + shared 对象 (每个 SceneRenderer 实例一个)
export function createScriptCache() {
  return { map: new Map(), shared: {} };
}

// 修复 (LOW 泄漏): 脚本 engine.setTimeout 建的真实定时器原先无人清理 — 渲染结束后
// 仍挂在事件循环上 (worker 退出被拖住 / 长驻进程逐帧累积句柄)。
// 登记后由 clearScriptTimers() 在每帧脚本阶段结束统一清理; 渲染是同步的, 定时器
// 不可能在渲染期间被触发 → 清理不影响任何一帧的像素。
const _pendingTimers = new Set();
export function clearScriptTimers() {
  for (const t of _pendingTimers) {
    try { clearTimeout(t); clearInterval(t); } catch { /* ignore */ }
  }
  _pendingTimers.clear();
}

// 运行一个回调并把异常记入 _scriptErrors (官方对 init/applyUserProperties/update
// 是**三个独立回调**, 互不影响; 旧实现把三者放在同一个 try 里 → init 抛错会让
// update 永不执行, 且因 initialized 未置位而每帧重试抛错)。
function runPhase(phase, where, fn, onError) {
  try { fn(); } catch (e) {
    _noteScriptError(where, phase, e);
    if (typeof onError === 'function') { try { onError(`[${phase}] ${where}: ${e.message}`); } catch { /* ignore */ } }
  }
}

// 执行脚本值 (缓存模式): 编译一次, init 一次, 每帧 update(value) → 写回 obj.value
// opts: { canvasSize, userProps, shared, sceneObjects, thisScene, cache, runtime, frametime, ownerRef }
function runScriptValueCached(scriptVal, time, opts = {}) {
  if (!scriptVal || typeof scriptVal !== 'object' || !('script' in scriptVal)) return;
  const src = scriptVal.script;
  const cache = opts.cache;
  let entry = cache ? cache.get(src) : null;
  if (!entry) {
    const compiled = compileScript(src, {
      canvasSize: opts.canvasSize,
      userProps: opts.userProps,
      shared: opts.shared,
      thisScene: opts.thisScene,
      ownerRef: opts.ownerRef,
      renderObjects: opts.renderObjects,
      runtime: opts.runtime != null ? opts.runtime : time,
      frametime: opts.frametime,
    });
    entry = {
      exports: compiled.exports || {},
      error: compiled.error,
      scriptProps: compiled.scriptProps,
      context: compiled.context || null,
      initialized: false,
      ownerRef: compiled.ownerRef,
    };
    if (cache) cache.set(src, entry);
  }
  const exports = entry.exports;
  if (entry.error && !exports.update && !exports.applyUserProperties && !exports.init) {
    _noteScriptError(opts.currentObject && (opts.currentObject.name || opts.currentObject.id) || '(编译期)', 'compile', { message: entry.error });
    return; // 脚本编译失败且无可用导出 → 保持静态 value
  }
  // 对象级 scriptproperties 覆盖 (WE 编辑器保存的用户调整 + user 属性绑定):
  // scene.json 对象上的 scriptproperties 是设计器存盘值, 格式 {name: value} 或
  // {name: {user: 用户属性名, value: 默认}} — 运行时读 userProps 当前值 (用户
  // 在 project.json 改过则生效), 无该键回退 value。脚本编译期 createScriptProperties
  // 只含脚本内声明的默认, 不含对象存盘覆盖 → 不应用则时钟 12/24h、分隔符等
  // 全用脚本默认 (用户调整丢失)。缓存按 src 共享, context.__scriptProperties
  // 每次按当前对象重新覆盖 (同脚本多对象不同覆盖不串)。
  if (scriptVal.scriptproperties && entry.context) {
    const props = Object.assign({}, entry.scriptProps || {});
    for (const [k, v] of Object.entries(scriptVal.scriptproperties)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v.user === 'string' && v.user) {
          const uv = (opts.userProps || {})[v.user];
          props[k] = uv !== undefined && uv !== null ? uv : v.value;
        } else if ('value' in v) {
          props[k] = v.value;
        } else {
          props[k] = v;
        }
      } else {
        props[k] = v;
      }
    }
    entry.context.__scriptProperties = props;
  }
  // ownerRef 是首次编译时创建的共享代理 (entry 持有); setOwner 指向当前脚本
  // 所属对象 — 缓存共享条目在多个对象间不串
  const ownerRef = entry.ownerRef;
  if (ownerRef && ownerRef.setOwner) ownerRef.setOwner(opts.currentObject || null);
  const where = (opts.currentObject && (opts.currentObject.name || opts.currentObject.id)) || '(无宿主对象)';
  const valueObj = toValueObj(scriptVal.value);
  if (!entry.initialized && typeof exports.init === 'function') {
    // 先置位 (官方 init 只调一次): 抛错也不每帧重试, 且 update 仍会执行
    entry.initialized = true;
    runPhase('init', where, () => {
      const r = exports.init(valueObj);
      if (r != null) scriptVal.value = formatResult(r);
    }, opts.onError);
  }
  // applyUserProperties: 官方语义 (docs.wallpaperengine.io .../applyUserProperties.html):
  //   首次 (wallpaper 载入) 调用携带**全部**用户属性; 之后仅携带变化项。
  // 旧实现恒传 `{}` → `if (userProperties.level)`/`hasOwnProperty` 全假。
  if (!entry.userPropsApplied && typeof exports.applyUserProperties === 'function') {
    entry.userPropsApplied = true;
    runPhase('applyUserProperties', where, () => {
      exports.applyUserProperties(opts.userProps || {});
    }, opts.onError);
  }
  if (typeof exports.update === 'function') {
    runPhase('update', where, () => {
      const result = exports.update(valueObj);
      if (result != null) scriptVal.value = formatResult(result);
    }, opts.onError);
  }
}

// 扫描并执行场景所有 {script, value} 对象 (更新到原对象树)
// opts: { canvasSize, userProps, scriptCache, renderObjects, runtime }
export function applySceneScripts(scene, time, opts = {}) {
  const cache = opts.scriptCache && opts.scriptCache.map ? opts.scriptCache : null;
  const shared = (cache ? cache.shared : null) || opts.shared || {};
  // 渲染对象列表 (this.objects, 已烘焙) — 脚本写这些对象 → 渲染直接生效
  const sceneObjects = opts.renderObjects || (scene.objects || []).map((o) => o);
  const thisScene = makeSceneRef(sceneObjects);
  const ownerRef = makeOwnerRef(sceneObjects);
  const walk = (obj, owner) => {
    if (!obj || typeof obj !== 'object') return;
    if ('script' in obj && 'value' in obj && typeof obj.script === 'string') {
      runScriptValueCached(obj, time, {
        canvasSize: opts.canvasSize,
        userProps: opts.userProps,
        shared,
        sceneObjects,
        renderObjects: sceneObjects,
        thisScene,
        cache: cache ? cache.map : null,
        ownerRef,
        currentObject: owner || null,
        runtime: opts.runtime,
        frametime: opts.frametime,
        onError: opts.onError,
      });
      return; // script 对象内部不再含 script 子对象
    }
    if (Array.isArray(obj)) {
      // 数组元素 owner = 元素自身 (script 常挂在对象属性上, 其 thisObject = 对象)
      obj.forEach((x) => walk(x, x));
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k], obj);
  };
  walk(scene, null);
  // 修复: 帧末清掉脚本创建的 vm 定时器 (见 _pendingTimers 注释)
  clearScriptTimers();
  return shared;
}
