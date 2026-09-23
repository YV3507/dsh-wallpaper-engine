// WE 渲染引擎 — SceneRenderer 主体 (core)
// 独立子目录 lib/we-renderer/: 工具层拆分 (math/canvas/textures/mdl),
// 类主体集中于此便于调试; 由 ../scene-renderer.js 兼容再导出
import fs from 'fs';
import path from 'path';
import { parseTex, decodeTex, texMip0Info } from '../pkg-extract.js';
import { parseCffFont, renderText } from '../font-render.js';
import { applySceneScripts, createScriptCache } from '../scene-scripts.js';
// 层可见性判定必须与 renderPuppet **完全一致** (附件锚点姿态 = 实际渲染姿态):
// 旧实现在 _attachmentOffset 内联过滤 (仅 visible===true / {value:true}), 会排除
// 脚本/动画驱动的层 ⇒ 父 puppet 的身体按 N 层渲染、锚点却按 M<N 层计算 → 挂接的
// 子对象 (头/嘴/书/后发) 系统性偏位。统一走 isLayerVisible (与 puppet.js 同一函数)。
import { isLayerVisible } from './puppet.js';
import {
  parseVec3, parseVec2, getVal,
  v3sub, v3add, v3cross, v3dot, v3norm,
  mat4Identity, mat4Mul, mat4Perspective, mat4Ortho, mat4LookAt, mat4FromTRS,
  mat4TransformPoint, mat4TransformVec3, sat,
  applyBlending, _greyscale, _sat3, _frac, rgb2hsv, hsv2rgb, smoothstepFn,
} from './math.js';
import { Canvas, encodePng, decodePngBuffer } from './canvas.js';
import { readPkgDir, readPkg, loadTexImage, loadPngFile, atlasFrameRect } from './textures.js';
import { parseMdlPuppet, parseMdlStatic } from './mdl.js';

import { installBloom } from './bloom.js';
import { installCamera } from './camera.js';
import { installImage } from './image.js';
import { installText } from './text.js';
import { installPuppet } from './puppet.js';
import { installModel } from './model.js';
import { installEffects } from './effects.js';
import { installParticles } from './particles.js';
import { installGlsl } from './glsl/integration.js';
// GPU 效果适配层 (把 gpu-gl/ 接回热路径; gpuAccel=false 时完全不参与)
import { installGpuAdapter } from './gpu-gl/adapter.js';
// P0-5 泄漏修复: 帧首召回效果链借出的整帧 scratch 缓冲 (此前 scratchRecallAll 无调用点)
import { scratchGet, scratchRecallAll, SCRATCH_U8 } from './effects/_scratch.js';
// 可选分阶段耗时剖析 (DSH_WE_PROFILE=1; 默认关闭时 profTime 直接透传, 零开销)
import { profAdd, profTime, profileEnabled } from './profile.js';

export class SceneRenderer {
  constructor(pkgPath, opts = {}) {
    this.pkgPath = pkgPath;
    // 支持: scene.pkg 文件 / 松散场景目录 / **场景主文件路径**
    //
    // 场景主文件的**文件名不是常量**: 官方 defaultprojects 里 audiophile / fantasticcar /
    // ricepod / techno 的主文件分别是 <名字>.json (project.json 的 file 字段声明),
    // 旧实现把名字硬编码成 scene.json ⇒ 这 4 个官方场景连读场景都失败
    // ("scene.json 不存在"), 完整渲染与主纹理提取双双不可用。
    // 现在: 传进来的是 .json 路径就记住它的文件名 (opts.sceneFile 可显式覆盖),
    // 目录入参仍回退 scene.json。
    let isDir = false;
    try { isDir = fs.statSync(pkgPath).isDirectory(); } catch { /* */ }
    let sceneFile = typeof opts.sceneFile === 'string' && opts.sceneFile ? opts.sceneFile : null;
    if (!isDir && String(pkgPath).toLowerCase().endsWith('.json')) {
      // 场景主文件 → 用其所在目录 + 记住真实文件名
      if (!sceneFile) sceneFile = path.basename(String(pkgPath));
      pkgPath = path.dirname(pkgPath);
      isDir = true;
    }
    this.pkg = isDir ? readPkgDir(pkgPath) : readPkg(pkgPath);
    this.log = opts.log || (() => {});
    this.sceneFile = sceneFile || 'scene.json';
    this.scene = this.pkg.readJson(this.sceneFile)
      || (this.sceneFile !== 'scene.json' ? this.pkg.readJson('scene.json') : null);
    if (!this.scene) throw new Error(this.sceneFile + ' 不存在');
    this.W = opts.width || 3840;
    this.H = opts.height || 2160;
    this.fovOverride = opts.fov != null ? opts.fov : null;
    this.time = opts.time ?? 0;
    // GPU 渲染加速 (sf40h): 仅当配置开启 (sceneGpuAccel, 附属 beta场景动画) 时
    // 内置/GLSL 效果走 WebGL (x64 + supreium-headless-gl), 失败自动回退 CPU
    this.gpuAccel = opts.gpuAccel === true;
    // 静态帧 (单帧渲染, scene-frame) 不降采样效果 — 4K 壁纸效果全分辨率保证细腻;
    // 仅 scene-anim 多帧动画 (times 数组) 启用降采样加速 (sf38 性能近似)
    this.staticFrame = !(opts.times && opts.times.length > 1);
    this.canvas = new Canvas(this.W, this.H);
    this.textureCache = new Map();
    // _rt_ 图层合成表 (RETAIN_ORIG / _rt_imageLayerComposite_<id>_a): WE 允许一层把自己
    // 渲染结果保留成 RT 供后续层引用 (窗户等"合成组件"靠它拼画面)。按帧清理 (setTime)。
    this._rtTex = new Map();
    this._rtIds = null;
    this.particleCache = new Map();
    // 缺失纹理 → 外部 PNG 贴图映射 (已从 pkg 提取的粒子贴图)
    this.assetDir = opts.assetDir || null;
    // WE 全局 assets 目录 (util/noise 等全局纹理)
    this.weAssetsDir = opts.weAssetsDir || null;
    // CPU degraded 通道 (与 GL gate mark 同一结构 {object, feature, action}): dev 线
    // GLSL/效果栈移植后其静默降级点会调用 this._degraded(...); 未提供回调时零行为。
    this.onDegraded = typeof opts.onDegraded === 'function' ? opts.onDegraded : null;
    // 视差鼠标位置 (0-1, 默认中心)
    this.optsMouse = opts.mouse || null;
    // 音频频谱 (引擎 g_AudioSpectrum16Left/Right): {left:[16], right:[16]}
    this.audioSpectrum = opts.audioSpectrum || null;
    // 视频纹理静态帧映射 (主线程 ffmpeg 预抽帧): 规范化纹理引用 → PNG 路径
    this.videoFrames = opts.videoFrames || null;
    // NSL 脚本运行时 (跨帧状态保留): 编译缓存 + shared — 每个实例一个
    // (scene-anim 多帧复用同一实例 → 脚本状态跨帧推进, 不再每帧重编译)
    this._scriptCache = createScriptCache();
    this.userProps = this._readUserProps();
    this._resolveObjects();
  }

  // 用户属性 (project.json general.properties): pkg 内 + 外部文件 (pkg 模式下
  // scene.pkg 旁的 project.json 是独立文件, pkg 内没有该条目 → 旧实现读到空
  // → 脚本 scriptProperties 无默认值 → 组件位置/动画参数全错)
  _readUserProps() {
    const props = {};
    const collect = (proj) => {
      if (!proj || !proj.general || !proj.general.properties) return;
      for (const [k, v] of Object.entries(proj.general.properties)) {
        if (v && typeof v === 'object' && 'value' in v) props[k] = v.value;
      }
    };
    try { collect(this.pkg.readJson('project.json')); } catch { /* ignore */ }
    if (this.pkgPath) {
      try {
        // pkgPath 可能是 **场景主文件**(…/scene.json) 也可能是目录 —— 构造时已把
        // .json 入参换成 dirname, 所以这里必须"目录自身优先, 再退回父目录":
        // 旧实现只查 path.dirname(pkgPath), 松散项目会查到**项目目录的父目录**
        // ⇒ project.json 永远读不到 ⇒ general.properties (eagleflag 的旗帜配色、
        // razer_bedroom 的 light_speed 等) 全部丢失。
        const base = String(this.pkgPath);
        const candidates = [path.join(base, 'project.json'), path.join(path.dirname(base), 'project.json')];
        for (const ext of candidates) {
          if (fs.existsSync(ext)) { collect(JSON.parse(fs.readFileSync(ext, 'utf8'))); break; }
        }
      } catch { /* ignore */ }
    }
    return props;
  }

  // 读 JSON: 场景 pkg 优先, 缺失时回退 WE 全局 assets (assets/models/..., assets/materials/...)
  // 读 JSON: 场景 pkg 优先, 缺失时回退 WE 全局 assets (assets/models/..., assets/materials/...)
  // 记录某对象的合成结果供 `_rt_imageLayerComposite_<id>_a` 引用 (仅当场景确实引用该 id)
  _retainComposite(o, img) {
    if (!o || !img || !this._rtTex) return;
    // 诊断: DSH_RT_ALL=1 时保留**每个**对象的合成结果 (按 obj:<名字> 索引), 供脚本导出查看
    if (process.env.DSH_RT_ALL === '1') {
      this._rtTex.set('obj:' + (o.name || String(o.id)), { width: img.width, height: img.height, rgba: img.rgba });
    }
    if (!this._isRtReferenced(o.id)) return;
    this._rtTex.set('_rt_imageLayerComposite_' + o.id + '_a', { width: img.width, height: img.height, rgba: img.rgba });
    this.log('RT 保留 _rt_imageLayerComposite_' + o.id + '_a = ' + img.width + 'x' + img.height + ' (' + (o.name || '') + ')');
  }

  // 该对象是否被其它层以 _rt_imageLayerComposite_<id>_a 引用 (惰性扫描一次)
  _isRtReferenced(id) {
    if (!this._rtIds) {
      this._rtIds = new Set();
      for (const ob of this.objects || []) {
        for (const ef of ob.effects || []) {
          for (const p of ef.passes || []) {
            for (const rf of p.textures || []) {
              const m = /_rt_imageLayerComposite_(\d+)_a/.exec(String(rf || ''));
              if (m) this._rtIds.add(m[1]);
            }
          }
        }
      }
    }
    return this._rtIds.has(String(id));
  }

  // ── 官方反射 pass (`_rt_Reflection`) ────────────────────────────────
  // 取证 (E:\...\decompiled\wallpaper64.exe.c, 行号为该文件):
  //  · RT 实体 286283-286287: 场景 flag&1 时
  //      FUN_1401aadb0(collection, W, H, 1, "_rt_Reflection", 1, fmt, 2, 0)
  //    其中 W/H 与 `_rt_FullFrameBufferMultiSampled`(0x18, 286337) /
  //    `_rt_MipMappedFrameBuffer`(0x1b, 286302) 传的是**同一对** (param_1+0x8c / param_1[0x12])
  //    ⇒ 反射缓冲是**全分辨率**; 第 6 参 flags=1 (夹边, **无 mip 链**; 对照 mipmapped 版是 0xf,
  //    即 1|2|4|8)。第 7 参 fmt 随 param_1[0x25]&1 在 0x16/0x1a 间切换 (与 HDR 开关同源)。
  //    三个 RT 各自独立, `_rt_Reflection` **不是** `_rt_MipMappedFrameBuffer` /
  //    `_rt_FullFrameBuffer` 的别名, 也不从它们派生。
  //  · 时机 285410-285552: 在**主 pass 之前** (主 pass 是 285621/285634 的
  //    FUN_140183550(param_1,0))。步骤: 镜像相机(见 camera.js `_setupReflectionCamera`)
  //    → 把 `_rt_Reflection` 压入渲染目标栈(285517-285522) → FUN_140183550(param_1,1)
  //    → 出栈(285524-285531) → 还原相机向量(285541-285550)。
  //  · 画什么 291744-291780: FUN_140183550(…,1) → FUN_14018aac0(scene,1), 后者
  //    `lVar19 = 0x158; if (param_2 == 1) lVar19 = 0x1c8;` —— **反射对象表 (CScene+0x1c8)**
  //    与主对象表 (CScene+0x158) 是两张不同的表。
  //  · 谁进反射表 295813-295845: 读对象键 "reflected"(立即数拼出的字面量), 规则为
  //    `if (bVar3 && bVar4 && (uVar6 & 8) == 0) add(CScene+0x1c8)`:
  //      bVar4 = 缺省/非布尔 ⇒ **true**, "reflected": false ⇒ false;
  //      bVar3 = 该对象类型分支里被置 false 的那些 (light/sound/camera/shape/sprite)。
  //    ⇒ 可渲染对象 (model/image/particle/text) 默认进反射表, 显式 false 才排除。
  //    旁证: audiophile.json:4 给 bars 写 "reflected": true (镜像内容 = 竖条),
  //    fantasticcar.json:36/45 给 Dome+Car 写 true, 而作为反射面的 grid 三者都没写。
  //  · 采样方式 材质侧: 一律用**主 pass 的屏幕 UV** 取 `_rt_Reflection` —
  //    audiophile/shaders/grid.frag:22-27 `screenUV=(v_ScreenPos.xy/v_ScreenPos.z)*0.5+0.5`
  //    然后 `texSample2D(g_Texture1, screenUV + bump.yz*0.02)`; assets/shaders/generic.frag:101-105
  //    同理 (arsenal planks.json 的 REFLECTION combo)。⇒ 镜像缓冲必须与主画面**同屏幕空间**,
  //    即"世界点 p 出现在主相机下镜像点 M·p 的屏幕位置" (见 camera.js 的等价推导)。
  //
  // 本场景是否真的有材质引用 `_rt_Reflection` (惰性扫一次 materials/*.json)。没有就
  // 整个 pass 不跑 ⇒ 未用该 RT 的场景零开销、零像素变化。官方语料里只有
  // arsenal/materials/pistols/planks.json、audiophile/materials/grid/{grid,grid2}.json、
  // fantasticcar/materials/grid/grid.json 引用它 (assets 里只有 debugrt_reflection.json)。
  _sceneUsesReflection() {
    if (this._usesReflection != null) return this._usesReflection;
    this._usesReflection = false;
    const needle = '_rt_Reflection';
    try {
      const entries = this.pkg.entries ? this.pkg.entries() : [];
      if (entries.length) {
        for (const e of entries) {
          if (!/^materials\//i.test(e.name) || !/\.json$/i.test(e.name)) continue;
          const b = this.pkg.read(e.name);
          if (b && b.toString('utf8').indexOf(needle) >= 0) { this._usesReflection = true; break; }
        }
      } else if (this.pkgPath) {
        // 松散目录: 只递归 materials/ 下的 json (与 pkg 内路径口径一致)。
        // 注意 this.pkgPath 是**构造入参原值** (可能是 …/audiophile.json), 目录要自己求。
        let base = String(this.pkgPath);
        try { if (!fs.statSync(base).isDirectory()) base = path.dirname(base); } catch { /* 不存在 → 下面 readdir 失败即跳过 */ }
        const stack = [path.join(base, 'materials')];
        while (stack.length && !this._usesReflection) {
          const d = stack.pop();
          let ents;
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
          for (const en of ents) {
            const p = path.join(d, en.name);
            if (en.isDirectory()) { stack.push(p); continue; }
            if (!/\.json$/i.test(en.name)) continue;
            try { if (fs.readFileSync(p, 'utf8').indexOf(needle) >= 0) this._usesReflection = true; } catch { /* */ }
          }
        }
      }
    } catch { /* 扫描失败 → 不建反射 pass (退化为旧行为) */ }
    return this._usesReflection;
  }

  // 反射对象判定 (官方 295836-295845): `reflected` 缺省 true, 显式 false 排除;
  // 只有可渲染对象进反射表 (light/sound/camera/shape/sprite 不进)。
  _isReflected(o) {
    if (!o) return false;
    const t = o._renderType;
    if (t !== 'model' && t !== 'image' && t !== 'particle' && t !== 'text') return false;
    const raw = o.reflected;
    const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    // A/B 诊断开关 (与 DSH_WE_NO_* 同款, 不参与生产): 只反射显式 `"reflected": true`
    // 的对象 —— 用来判定"官方缺省 true"这条反编译结论对画幅的实际影响。
    if (this._reflExplicitOnly == null) this._reflExplicitOnly = process.env.DSH_WE_REFLECT_EXPLICIT === '1';
    if (this._reflExplicitOnly) return v === true || v === 'true';
    return !(v === false || v === 'false');
  }

  // 反射 pass 主体: 镜像相机 + 反射对象表 → 全分辨率缓冲 → 登记为 `_rt_Reflection`。
  // `order` = 本帧可见对象 (渲染顺序已解析), 与主 pass 共用同一 _rtTex 语义。
  _renderReflectionPass(order, t) {
    // A/B 诊断开关 (与 DSH_WE_NO_* 同款, 生产不设): =1 时退回改动前的 `_rt_` 快照近似
    if (process.env.DSH_WE_NO_REFLECTION === '1') return;
    if (!this._sceneUsesReflection()) return;
    const objs = order.filter((o) => this._isReflected(o));
    if (!objs.length) return;
    // RT 缓冲跨帧复用 (尺寸固定), 每帧清成透明黑 = 官方"RT 未写区域"
    let rc = this._reflCanvas;
    if (!rc || rc.w !== this.W || rc.h !== this.H) rc = this._reflCanvas = new Canvas(this.W, this.H);
    rc.clear();
    const sCanvas = this.canvas, sEye = this.camEye, sVP = this.camVP, sProj = this.camProj;
    const priorRtKeys = this._rtTex ? [...this._rtTex.keys()] : null;
    this.canvas = rc;
    this._setupReflectionCamera();
    try {
      for (const o of objs) {
        try {
          if (o._renderType === 'image') this.renderImage(o, t);
          else if (o._renderType === 'model') this.renderModel(o, t);
          else if (o._renderType === 'particle') this.renderParticleSystem(o, t);
          else if (o._renderType === 'text') this.renderTextObject(o, t);
        } catch (e) {
          this.log('反射对象 ' + (o.name || o.id) + ' 渲染失败: ' + e.message);
        }
      }
    } finally {
      this.canvas = sCanvas; this.camEye = sEye; this.camVP = sVP; this.camProj = sProj;
      // 反射 pass 里产生的 _rt_imageLayerComposite_* 属于镜像视角, 不能污染主 pass
      if (priorRtKeys && this._rtTex) {
        for (const k of [...this._rtTex.keys()]) {
          if (k !== '_rt_Reflection' && priorRtKeys.indexOf(k) < 0) this._rtTex.delete(k);
        }
      }
    }
    // 登记: 直接交出 `rc.data` —— 该缓冲由本实例独占, pass 之后不再写入, 无需像
    // 旧 `_rt_` 快照那样借 scratch 池复制一份整帧 (4K 下省 33MB/帧的拷贝与常驻)。
    this._rtTex.set('_rt_Reflection', { width: this.W, height: this.H, rgba: rc.data });
  }

  // CPU degraded 通道发射: {object, feature, action} 结构 (宿主可写 gpu-diag.log)。
  // 未提供 onDegraded 时零行为; 回调抛错不影响渲染。
  _degraded(object, feature, action) {
    if (typeof this.onDegraded !== 'function') return;
    try { this.onDegraded({ object, feature, action }); } catch { /* 回调失败不影响渲染 */ }
  }

  readJsonAny(rel) {
    if (!rel) return null;
    let j = this.pkg.readJson(rel);
    if (j || !this.weAssetsDir) return j;
    const gp = path.join(this.weAssetsDir, 'assets', rel);
    try {
      if (fs.existsSync(gp)) return JSON.parse(fs.readFileSync(gp, 'utf8'));
    } catch { /* ignore */ }
    return null;
  }

  // 读原始字节: 场景 pkg 优先, 缺失时回退 WE 全局 assets
  // 读原始字节: 场景 pkg 优先, 缺失时回退 WE 全局 assets
  readAny(rel) {
    if (!rel) return null;
    let b = this.pkg.read(rel);
    if (b || !this.weAssetsDir) return b;
    const gp = path.join(this.weAssetsDir, 'assets', rel);
    try {
      if (fs.existsSync(gp)) return new Uint8Array(fs.readFileSync(gp));
    } catch { /* ignore */ }
    return null;
  }

  // ── 对象树: 依赖/父级排序 (CScene::createObject/addObjectToRenderOrder) ──
  // ── 对象树: 依赖/父级排序 (CScene::createObject/addObjectToRenderOrder) ──
  _resolveObjects() {
    const objects = this.scene.objects || [];
    this.objects = objects.map((o) => ({ ...o, _renderType: this._classify(o) }));
    // 渲染顺序: 依赖前置 + 场景顺序 (防循环依赖栈溢出)
    const order = [];
    const added = new Set();
    const visiting = new Set();
    const add = (o) => {
      if (added.has(o.id)) return;
      if (visiting.has(o.id)) return; // 依赖循环 (A↔B): 已在此链中, 跳过
      visiting.add(o.id);
      for (const dep of o.dependencies || []) {
        const d = this.objects.find((x) => x.id === dep);
        if (d) add(d);
      }
      if (o.parent != null) {
        const p = this.objects.find((x) => x.id === o.parent);
        if (p) add(p);
      }
      visiting.delete(o.id);
      added.add(o.id);
      order.push(o);
    };
    for (const o of this.objects) add(o);
    this.renderOrder = order;
  }

  _classify(o) {
    if (o.image) return 'image';
    if (o.model) return 'model';
    if (o.particle) return 'particle';
    if (o.sound) return 'sound';
    if (o.text) return 'text';
    if (o.light) return 'light';
    return 'unknown';
  }

  // 纹理加载: pkg .tex 优先, 缺失时用 WE 全局 assets, 最后外部 PNG 贴图映射
  // 视频纹理 (MP4/WebM/MOV): 主线程 ffmpeg 预抽帧 PNG 替换 (静态帧模式)
  //
  // 剖析包装 (DSH_WE_PROFILE=1): loadTexture 出口众多 (RT / 视频 / pkg 解码 / 全局
  // assets / 外部 PNG 回退), 故拆出实现体统一计时 —— 记为「纹理解码 + 缓存查询」
  // 总成本, 不改变任何调用语义与像素输出。关闭剖析时直接透传实现体。
  loadTexture(pathOrName, opts) {
    if (!profileEnabled) return this._loadTextureImpl(pathOrName, opts);
    const __t = performance.now();
    try {
      return this._loadTextureImpl(pathOrName, opts);
    } finally {
      profAdd('纹理:解码', performance.now() - __t);
    }
  }

  _loadTextureImpl(pathOrName, opts) {
    // _rt_ 图层合成 (RETAIN_ORIG): 优先查本帧保留的对象合成结果
    if (typeof pathOrName === 'string' && this._rtTex) {
      const rt = this._rtTex.get(pathOrName) || this._rtTex.get(pathOrName.replace(/\.tex$/i, ''));
      if (/^_rt_/.test(pathOrName)) this.log('RT 查询 ' + pathOrName + ' → ' + (rt ? rt.width + 'x' + rt.height : 'miss'));
      if (rt) return rt;
    }
    if (!pathOrName) return null;
    // _rt_ 渲染目标 (反射/帧缓冲): 用当前画布内容近似 (引擎反射缓冲)
    if (String(pathOrName).startsWith('_rt_')) {
      if (this.canvas && this.canvas.data) {
        // 修复: 整帧拷贝改借 scratch 池 (原先每次 new 一份整帧, 4K=33MB);
        // 缓冲保持 'out' 由下一帧 render 开头的 scratchRecallAll 召回 — 提前
        // scratchPut 会让 _rtTex 持有的本帧结果被后续层借走覆写
        const rgba = scratchGet(SCRATCH_U8, this.canvas.w * this.canvas.h * 4);
        rgba.set(this.canvas.data);
        return { width: this.canvas.w, height: this.canvas.h, rgba };
      }
      return null;
    }
    // 视频纹理: 独立媒体文件引用 (须在 .tex 规范化之前识别)
    if (/\.(mp4|m4v|webm|mov)$/i.test(String(pathOrName))) {
      return this._loadVideoTextureFrame(pathOrName);
    }
    let texPath = pathOrName;
    if (!texPath.endsWith('.tex')) texPath = 'materials/' + texPath + '.tex';
    if (this.textureCache.has(texPath)) return this.textureCache.get(texPath);
    let raw = this.pkg.read(texPath);
    // 动画图集按帧解码 (docs/SCENE-FRAME-PERF.md §二十七): 只解码当前帧覆盖的
    // DXT 块。帧索引进入缓存键 —— 否则多帧渲染会复用别的帧的纹理。
    // 缓存查询仍以 texPath 为先: 区域解码只写进带帧索引的键, 普通请求因此
    // 永远不会读到单帧纹理, 语义与从前完全一致。
    let cacheKey = texPath;
    let frameOpts;
    let texInfo = null;
    let texFmt = null;   // 容器像素格式 (官方着色器按 TEX1FORMAT 分支, 见下)
    // 轻量取一次像素格式 (metaOnly: 只解析容器头, 不解压 mip 数据)。放在这里而不是
    // 上面那个 `opts.time` 分支里 —— 法线贴图这类调用**不带** opts.time, 官方
    // DecompressNormal 却必须知道 DXT5 还是 RGBA8888 才能选对通道。
    if (raw) {
      try {
        const mi = texMip0Info(raw, { metaOnly: true });
        if (mi && mi.format != null) texFmt = mi.format;
      } catch { /* 头解析失败 → 交给着色器侧的兜底判据 */ }
    }
    if (raw && opts && opts.time != null) {
      // §三十三 实测: 这一段原先在**帧缓存命中之前**就 parseTex, 而 parseTex 会把
      // 整个容器解压 (鸟_00020 是 60.8Mpx, ≈250ms)。同一纹理的 6 个实例因此各解压
      // 一遍 —— 实测 ~1500ms 纯浪费, 而且它与画布尺寸无关 (分辨率扫描时它不下降,
      // 这是我上一轮"不是填充率受限"结论的真正原因)。
      // 这里只把**帧表元数据**(很小: 尺寸 + 帧数组)按 texPath 记下来复用;
      // 整容器解析结果不留存 (它带 60.8MB 解压缓冲, 常驻内存不可接受)。
      const noMemo = process.env.DSH_WE_NO_ATLAS_META === '1'; // A/B 开关
      let meta = noMemo ? null : (this._atlasMeta && this._atlasMeta.get(texPath));
      if (!meta) {
        const info = parseTex(raw);
        meta = { width: info.width, height: info.height, frames: info.frames || null, format: info.format };
        if (!noMemo) {
          if (!this._atlasMeta) this._atlasMeta = new Map();
          this._atlasMeta.set(texPath, meta);
        }
        texInfo = info; // 仅本次调用复用 (供 loadTexImage 省掉又一次解压)
      }
      if (meta && meta.format != null) texFmt = meta.format;
      const rect = atlasFrameRect(meta, opts.time);
      if (rect) {
        cacheKey = texPath + '#' + rect.index;
        if (this.textureCache.has(cacheKey)) return this.textureCache.get(cacheKey);
        frameOpts = { frameRect: rect };
        this._atlasFrameReqs = (this._atlasFrameReqs || 0) + 1;
      }
    }
    let img = null;
    if (raw) {
      try {
        const _td0 = performance.now();
        // 复用上面那次 parseTex: 压缩容器的解压是顺序的且很贵 (60.8Mpx ≈ 250ms),
        // 同一容器没必要解压两遍。DSH_WE_NO_TEX_PARSE_REUSE=1 可关掉做 A/B。
        const reuse = texInfo && !process.env.DSH_WE_NO_TEX_PARSE_REUSE;
        img = loadTexImage(raw, frameOpts, reuse ? texInfo : undefined);
        // 把容器里的像素格式带给调用方: 官方着色器按 TEX1FORMAT 走不同分支
        // (如 DecompressNormal: DXT5 用 G/A 通道, RGBA8888 用 A/G) —— 没有它就
        // 只能猜分支。只加一个字段, 不改像素。
        if (img && texFmt != null && img.format == null) img.format = texFmt;
        // 每个纹理路径的**实际**解码耗时 (诊断用; 用来定位解码预算真正花在哪)
        {
          const _ms = performance.now() - _td0;
          if (!this._texDecodeMs) this._texDecodeMs = new Map();
          this._texDecodeMs.set(texPath, (this._texDecodeMs.get(texPath) || 0) + _ms);
        }
        if (frameOpts && img && img.width === frameOpts.frameRect.width &&
            img.height === frameOpts.frameRect.height) {
          this._atlasFrameDecodes = (this._atlasFrameDecodes || 0) + 1;
        }
      } catch (e) {
        // TEX 容器内嵌 MP4 (sync 视频纹理): 用主线程预抽帧的 PNG 替代
        if (this.videoFrames && this.videoFrames[texPath]) {
          img = this._readVideoFramePng(texPath);
          if (img) {
            this._cacheTexture(texPath, img);
            return img;
          }
        }
        this.log('纹理解析失败 ' + texPath + ': ' + e.message);
      }
    }
    // WE 全局 assets 回退: assets/materials/util/noise.tex
    if (!img && this.weAssetsDir) {
      const globalPath = path.join(this.weAssetsDir, 'assets', texPath);
      try {
        if (fs.existsSync(globalPath)) {
          const gRaw = fs.readFileSync(globalPath);
          img = loadTexImage(gRaw);
        }
      } catch (e) {
        this.log('全局纹理解析失败 ' + globalPath + ': ' + e.message);
      }
    }
    if (!img && this.assetDir) {
      img = this._loadAssetPng(texPath);
    }
    this._cacheTexture(cacheKey, img);
    return img;
  }

  // 纹理缓存写入 (LOW 修复): 原先无上限 — 大场景数百张 4K 解码纹理 (33MB/张)
  // 常驻; 按字节封顶并淘汰最旧条目 (淘汰只损失一次重解码, 像素不变)
  _cacheTexture(key, img) {
    const bytes = img && img.width && img.height ? img.width * img.height * 4 : 0;
    const prev = this.textureCache.get(key);
    if (prev && prev.width && prev.height) this._textureCacheBytes -= prev.width * prev.height * 4;
    this.textureCache.set(key, img);
    this._textureCacheBytes = (this._textureCacheBytes || 0) + bytes;
    while (this._textureCacheBytes > 256 * 1024 * 1024 && this.textureCache.size > 1) {
      const [k, v] = this.textureCache.entries().next().value;
      if (k === key) break;
      this.textureCache.delete(k);
      this._textureCacheBytes -= v && v.width && v.height ? v.width * v.height * 4 : 0;
    }
  }

  // 视频纹理静态帧: 查主线程 ffmpeg 预抽帧映射, 读 PNG 替代视频
  _loadVideoTextureFrame(ref) {
    if (!this.videoFrames) return null;
    const norm = ref.startsWith('materials/') ? ref : 'materials/' + ref;
    const png = this.videoFrames[norm] || this.videoFrames[ref];
    if (!png) return null;
    const img = this._readVideoFramePng(ref, png);
    if (img) this._cacheTexture(ref, img);
    return img;
  }

  // 读视频预抽帧 PNG (ref 用于日志; pngPath 缺省时从 videoFrames 反查)
  _readVideoFramePng(ref, pngPath) {
    const png = pngPath || (this.videoFrames && this.videoFrames[ref]);
    if (!png) return null;
    try {
      return decodePngBuffer(fs.readFileSync(png));
    } catch (e) {
      this.log('视频纹理帧读取失败 ' + ref + ': ' + e.message);
      return null;
    }
  }

  // 从外部目录加载粒子贴图 (按纹理名匹配)
  // 从外部目录加载粒子贴图 (按纹理名匹配)
  _loadAssetPng(texPath) {
    if (!this.assetDir) return null;
    const name = texPath.split('/').pop().replace('.tex', '');
    const map = {
      'flare_1': 'particle_flare1.png',
      'halo_6': 'particle_halo6.png',
      'halo_9': 'particle_halo6.png',
      'halo_2': 'particle_halo6.png',
      'Untitled': 'particle_leaves.png',
      '图层 44': 'particle_layer44.png',
      '图层 39': 'particle_layer39.png',
      'debris1': 'particle_debris1.png',
    };
    const f = map[name];
    if (!f) return null;
    const p = this.assetDir + '/' + f;
    try { return loadPngFile(p); } catch (e) { return null; }
  }

  // 加载模型 → 材质 → 主纹理
  // 加载模型 → 材质 → 主纹理
  loadModelTexture(modelPath, opts) {
    const model = this.pkg.readJson(modelPath);
    if (!model) return null;
    const mat = model.material ? this.pkg.readJson(model.material) : null;
    if (!mat || !mat.passes || !mat.passes.length) return null;
    const texName = mat.passes[0].textures && mat.passes[0].textures[0];
    return texName ? this.loadTexture(texName, opts) : null;
  }

  // ── 变换解析 (CImage::resolveTransform: 父链 origin/scale/angle 累积) ──
  // lwe CImage.cpp:156-164 语义: 从根到叶, 子 origin × 祖先累积 scale →
  // 旋转(祖先累积角度) → + 祖先 origin; 子 scale 乘入累积 (不含自身 origin 缩放)
  // ── 变换解析 (CImage::resolveTransform: 父链 origin/scale/angle 累积) ──
  // lwe CImage.cpp:156-164 语义: 从根到叶, 子 origin × 祖先累积 scale →
  // 旋转(祖先累积角度) → + 祖先 origin; 子 scale 乘入累积 (不含自身 origin 缩放)
  // MDAT0001 锚点 (官方引擎确认: wallpaper64.exe 解析 MDAT0001 = u16 计数 +
  // [u16 骨骼索引 + 名字\0 + 64B 矩阵] 列表; 场景对象 attachment 字段匹配锚点名字):
  // 子对象 origin 相对父 puppet 命名锚点定位 → 有效子原点 = 锚点偏移 + 自身 origin。
  // (如 attachment="身体：头" 等锚点名字与父 puppet MDL 的 MDAT 锚点精确匹配)
  _mdlAnchors(model) {
    if (!model || !model.puppet) return null;
    if (!this._anchorCache) this._anchorCache = new Map();
    if (this._anchorCache.has(model.puppet)) return this._anchorCache.get(model.puppet);
    const raw = this.pkg.read(model.puppet);
    const out = [];
    if (raw) {
      try {
        const buf = Buffer.from(raw);
        for (let idx = buf.indexOf('MDAT'); idx >= 0; idx = buf.indexOf('MDAT', idx + 4)) {
          if (buf.toString('utf8', idx, idx + 8) !== 'MDAT0001') continue;
          let p = idx + 9 + 4;
          const count = buf.readUInt16LE(p); p += 2;
          for (let e = 0; e < count && e < 64 && p + 2 < buf.length; e++) {
            const boneIdx = buf.readUInt16LE(p); p += 2;
            const ne = buf.indexOf(0, p);
            if (ne < 0 || ne - p > 128) break;
            const name = buf.toString('utf8', p, ne);
            p = ne + 1;
            if (p + 64 > buf.length) break;
            const m = [];
            for (let i = 0; i < 16; i++) m.push(buf.readFloatLE(p + i * 4));
            p += 64;
            out.push({ name, boneIdx, m, tx: m[12], ty: m[13] });
          }
        }
      } catch { /* 解析失败 → 无锚点 */ }
    }
    this._anchorCache.set(model.puppet, out);
    return out;
  }

  // puppet 骨骼最终世界位姿 (绑定 + 动画层合成, 与 _skinPuppet 同逻辑) —
  // attachment 锚点跟随动画骨骼 (锚点矩阵相对骨骼局部, 旋角 0 时直接加平移)
  _puppetBoneFinal(mesh, t, layers = null) {
    const bones = mesh.bones;
    if (!bones || !bones.length) return null;
    const nb = bones.length;
    const bindWorld = new Array(nb);
    for (let b = 0; b < nb; b++) {
      const parent = bones[b].parent;
      const local = bones[b].bind;
      // 行向量语义: M_world = M_local · M_world_parent (与 _skinPuppet 同一修正)
      bindWorld[b] = parent >= 0 && parent < nb && bindWorld[parent] ? this._matMulRow(local, bindWorld[parent]) : local;
    }
    const bindRT = bindWorld.map((m) => ({ angle: Math.atan2(m[1], m[0]), tx: m[12], ty: m[13] }));
    const final = bindRT.map((r) => ({ angle: r.angle, tx: r.tx, ty: r.ty }));
    if (!mesh.animations || !mesh.animations.length) return final;
    if (!layers || !layers.length) layers = [{ animIdx: 0, blend: 1, rate: 1, additive: false }];
    // 帧率: 官方 frame = t × 动画fps (MDLA fps 字段; 旧硬编码 30 让 60fps 动画半速)
    // additive 参考 = 层动画帧0 (帧0≠bind 时用 bind 会让角色飞走; 帧0=bind 的模型等价)
    const refCache = new Map();
    const animRef = (anim) => {
      if (!refCache.has(anim)) refCache.set(anim, this._sampleAnimRT(mesh, anim, 0, nb, bones));
      return refCache.get(anim);
    };
    for (const layer of layers) {
      const anim = mesh.animations[layer.animIdx] || mesh.animations[0];
      if (!anim) continue;
      const fps = anim.fps > 0 ? anim.fps : 30;
      // 帧: 不在此取模 (loop 模式由 _sampleAnimRT 判定; single 需保持末帧 = 帧0 = 静止)
      const frame = Math.floor(t * fps * layer.rate);
      const lw = this._sampleAnimRT(mesh, anim, frame, nb, bones);
      const refRT = animRef(anim);
      for (let b = 0; b < nb; b++) {
        if (layer.additive) {
          const ref = refRT[b];
          let da = lw[b].angle - ref.angle;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          final[b].angle += da * layer.blend;
          final[b].tx += (lw[b].tx - ref.tx) * layer.blend;
          final[b].ty += (lw[b].ty - ref.ty) * layer.blend;
        } else {
          let da = lw[b].angle - final[b].angle;
          while (da > Math.PI) da -= 2 * Math.PI;
          while (da < -Math.PI) da += 2 * Math.PI;
          final[b].angle += da * layer.blend;
          final[b].tx += (lw[b].tx - final[b].tx) * layer.blend;
          final[b].ty += (lw[b].ty - final[b].ty) * layer.blend;
        }
      }
    }
    return final;
  }

  // attachment 锚点偏移: 子对象相对父 puppet 锚点的局部偏移 (骨骼位姿 + 锚点矩阵)
  _attachmentOffset(child, parent) {
    if (!child || !parent || child.attachment == null) return [0, 0];
    const parentModel = parent.image ? this.readJsonAny(parent.image) : null;
    const anchors = this._mdlAnchors(parentModel);
    if (!anchors) return [0, 0];
    const anch = anchors.find((a) => a.name === child.attachment);
    if (!anch) return [0, 0];
    // 骨骼最终世界位姿 (动画后)
    let bx = 0, by = 0, ba = 0;
    if (parentModel && parentModel.puppet) {
      if (!this._mdlCache) this._mdlCache = new Map();
      let mesh = this._mdlCache.get(parentModel.puppet);
      if (!mesh) {
        mesh = this._parseMdl(this.pkg.read(parentModel.puppet));
        if (mesh) this._mdlCache.set(parentModel.puppet, mesh);
      }
      if (mesh && mesh.bones && anch.boneIdx < mesh.bones.length) {
        let layers = null;
        // 与 renderPuppet 的 animLayers 构建保持严格一致 (sf39c):
        // 仅当 多动画 + 有 animationlayers 时做层合成; 单动画时 layers=null →
        // _puppetBoneFinal 用默认动画0 = 父网格蒙皮同款, 否则锚点跟随错误
        // 动画 (layer 选中动画 ≠ 动画0) → 子对象挂载错位
        if (mesh.animations && mesh.animations.length > 1 && parent.animationlayers && parent.animationlayers.length) {
          const ls = parent.animationlayers
            .filter(isLayerVisible)
            .map((l) => {
              const blend = typeof l.blend === 'number' && l.blend >= 0 && l.blend <= 1 ? l.blend : 1;
              const rate = typeof l.rate === 'number' && l.rate > 0 ? l.rate : 1;
              let idx = mesh.animations.findIndex((a) => a.name && l.name && a.name === l.name);
              if (idx < 0 && l.name) {
                // 数字后缀: "动画 N" → MDL 第 N 个动画 (用于层名带编号、动画本身无名的模型)
                const m = String(l.name).match(/(\d+)/);
                if (m) {
                  const n = parseInt(m[1], 10);
                  if (n >= 1 && n <= mesh.animations.length) idx = n - 1;
                }
              }
              // 层 animation 字段 = MDLA 动画 ID (如 4327) → 按 id 匹配
              if (idx < 0 && l.animation != null) {
                const lid = Number(l.animation);
                const byId = mesh.animations.findIndex((a) => a.id === lid);
                if (byId >= 0) idx = byId;
              }
              if (idx < 0) {
                const layerIdx = parent.animationlayers.indexOf(l);
                if (layerIdx >= 0 && layerIdx < mesh.animations.length) idx = layerIdx;
              }
              if (idx < 0) idx = 0;
              return { animIdx: idx, blend, rate, additive: !!l.additive };
            });
          if (ls.length) layers = ls;
        }
        const final = this._puppetBoneFinal(mesh, this.time, layers);
        if (final) {
          bx = final[anch.boneIdx].tx; by = final[anch.boneIdx].ty; ba = final[anch.boneIdx].angle;
        }
      }
    }
    // 锚点矩阵相对骨骼局部: 旋角 0 → 直接加平移; 非 0 旋转后加
    const c = Math.cos(ba), s = Math.sin(ba);
    return [bx + anch.tx * c - anch.ty * s, by + anch.tx * s + anch.ty * c];
  }

  resolveTransform(o) {
    // 收集链 (叶到根)
    const chain = [o];
    let cur = o;
    let guard = 0;
    while (cur.parent != null && guard < 32) {
      const parent = this.objects.find((x) => x.id === cur.parent);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
      guard++;
    }
    const root = chain[chain.length - 1];
    let origin = parseVec3(getVal(root, 'origin'), [0, 0, 0]);
    let scale = parseVec3(getVal(root, 'scale'), [1, 1, 1]);
    let ang = parseVec3(getVal(root, 'angles'), [0, 0, 0]);
    // 从根向下: 子 origin × 当前累积 scale → 旋转(当前累积 Z 角) → + 当前 origin
    for (let i = chain.length - 2; i >= 0; i--) {
      const co = parseVec3(getVal(chain[i], 'origin'), [0, 0, 0]);
      const ca = parseVec3(getVal(chain[i], 'angles'), [0, 0, 0]);
      const cos = Math.cos(ang[2]), sin = Math.sin(ang[2]);
      // attachment 锚点偏移 (子相对父 puppet 锚点): 与子 origin 同空间 (父局部),
      // 受祖先 scale/rotation 影响 — 先加锚点再加自身 origin
      const ao = this._attachmentOffset(chain[i], chain[i + 1]);
      if (ao[0] !== 0 || ao[1] !== 0) {
        const ax = ao[0] * scale[0], ay = ao[1] * scale[1];
        origin = [origin[0] + ax * cos - ay * sin, origin[1] + ax * sin + ay * cos, origin[2] || 0];
      }
      const rx = co[0] * scale[0], ry = co[1] * scale[1];
      const ox = rx * cos - ry * sin;
      const oy = rx * sin + ry * cos;
      origin = [origin[0] + ox, origin[1] + oy, 0];
      const cs = parseVec3(getVal(chain[i], 'scale'), [1, 1, 1]);
      scale = [scale[0] * cs[0], scale[1] * cs[1], scale[2] * cs[2]];
      ang = [ang[0] + ca[0], ang[1] + ca[1], ang[2] + ca[2]];
    }
    return { origin, scale, angle: ang[2], angles: ang };
  }

  // ── 主渲染入口 ────────────────────────────────────────────────────
  // 多帧复用: 构造一次后调 setTime 切换时间, 避免每帧重读 pkg/重解码纹理
  // ── 主渲染入口 ────────────────────────────────────────────────────
  // 多帧复用: 构造一次后调 setTime 切换时间, 避免每帧重读 pkg/重解码纹理
  setTime(t) {
    this.time = t;
    // 每帧重建 _rt_ 合成表 (多帧渲染复用同一实例; 静态帧每次也是新实例)
    if (this._rtTex) this._rtTex.clear();
  }

  // scene scripts ({script,value}) 写回原对象 value — 多帧复用需备份恢复, 避免值累积污染
  // scene scripts ({script,value}) 写回原对象 value — 多帧复用需备份恢复, 避免值累积污染
  _backupScriptValues() {
    if (this._scriptBackup) return;
    this._scriptBackup = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if ('script' in obj && 'value' in obj && typeof obj.script === 'string') {
        this._scriptBackup.push([obj, obj.value]);
        return; // script 对象内部不再含 script 子对象
      }
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object') walk(v);
      }
    };
    for (const o of this.scene.objects || []) walk(o);
    if (this.scene.general) walk(this.scene.general);
    if (this.scene.camera) walk(this.scene.camera);
  }

  _restoreScriptValues() {
    if (!this._scriptBackup) return;
    for (const [obj, v] of this._scriptBackup) obj.value = v;
  }

  // 对象可见性: 官方语义 — visible 可能是 {user: <属性名>, value} 绑定用户属性
  // (可关闭的作者声明/时钟/FPS 等: user 指向 project.json 属性, 用户关闭后
  // 该组件整体不渲染)。scene.json 里的 value 是设计器默认, 运行时须读 userProps
  // 的当前值 (用户改过则生效), userProps 无该键时才回退 scene.json 的 value。
  // 对象自身可见性 (不含父级): visible 可能是 {user: <属性名>, value} 绑定用户属性
  // (可关闭的作者声明/时钟/FPS 等: user 指向 project.json 属性, 用户关闭后
  // 该组件整体不渲染)。scene.json 里的 value 是设计器默认, 运行时须读 userProps
  // 的当前值 (用户改过则生效), userProps 无该键时才回退 scene.json 的 value。
  _isVisibleSelf(o) {
    const v = o && o.visible;
    if (v == null) return true;
    if (typeof v === 'object' && v !== null && 'user' in v) {
      const user = v.user;
      // ── object 形式 (官方 combo 绑定): {user: {name: 'style', condition: '0'}} ──
      // 官方语义: 绑定的用户属性值 == condition ⇒ 该值取真, 否则取假 —— 即
      //   visible ⟺ String(userProps[name]) === String(condition)
      // 取证 (独立实现 linux-wallpaperengine): DynamicValue::update 里
      //   `const bool boolValue = m_condition.value().condition == newValue;`
      //   → 用条件字符串与属性值**字符串比较**后整体转成 bool
      //   (_refs/linux-wallpaperengine/.../Data/Model/DynamicValue.cpp:176-186 与 :213-214;
      //    条件对象形状见 Data/Parsers/UserSettingParser.cpp:13-30 + Data/Model/DynamicValue.h:19)。
      // 旧实现只回退 `v.value` ⇒ `{condition:'1'}` + `value:true` 会被**错误显示**
      // (官方 wallpaper shimmering_particles 的 grad 层即 value:false 蒙对;
      //  small_motes 同样蒙对; 只有 value 与 condition 不一致时暴露)。
      if (user && typeof user === 'object') {
        const name = user.name;
        const cond = user.condition;
        if (typeof name === 'string' && name && cond != null && this.userProps && name in this.userProps) {
          return String(this.userProps[name]) === String(cond);
        }
        // 属性缺失 (或未声明 condition) → 回退设计器默认 value
        return v.value !== false && v.value !== 'false';
      }
      if (typeof user === 'string' && user && this.userProps && user in this.userProps) {
        return this.userProps[user] !== false && this.userProps[user] !== 'false';
      }
      // user 无对应属性 → 回退 value
      return v.value !== false && v.value !== 'false';
    }
    return getVal(o, 'visible', true) !== false;
  }

  // 对象可见性 = 自身可见 AND 祖先链全部可见 (官方场景图语义: 组/容器对象
  // 隐藏时其子对象一并隐藏 — App Launcher Dock 等作者组件用父对象 visible
  // 绑定用户属性开关, 父隐藏后 Launcher 子对象不得独立渲染)
  _isVisible(o) {
    if (!this._isVisibleSelf(o)) return false;
    // 沿 parent 链向上, 任一祖先不可见 → 本对象不可见
    let cur = o;
    let guard = 0;
    while (cur && cur.parent != null && guard < 32) {
      const parent = this.objects.find((x) => x.id === cur.parent);
      if (!parent) break;
      if (!this._isVisibleSelf(parent)) return false;
      cur = parent;
      guard++;
    }
    return true;
  }

  // 实时组件统一跳过 (静态帧无法提供实时数据, 后续解决实时渲染):
  //   1. 音频条/频谱类效果组件 (效果名匹配, 无音频输入 → 渲染无意义)
  //   2. 时间文本已有 _isLiveText (text.js) 单独跳过
  _isLiveComponent(o) {
    if (!o || !Array.isArray(o.effects)) return false;
    for (const ef of o.effects) {
      if (!ef || !ef.file) continue;
      const name = path.basename(path.dirname(ef.file));
      // 音频类效果 (官方效果名均不含这些词, 第三方音频条/频谱全命中)
      if (/audio|bars|oscilloscope|visualizer|equalizer|spectrum/i.test(name)) return true;
    }
    return false;
  }

  render() {
    const t = this.time;
    // 剖析基准 (仅 DSH_WE_PROFILE=1 时取时钟)
    const __t0 = profileEnabled ? performance.now() : 0;
    // P0-5 泄漏修复: 帧首召回 —— 上一帧各效果链的链尾输出无人归还 (state 停在
    // 'out'), 一个效果对象一帧滞留一块整帧缓冲 (4K=33MB, 240 帧动画数 GB)。
    // 安全性: 召回只影响上一帧的缓冲; 本帧内被 _rtTex/链上持有的缓冲保持 'out',
    // 不会被复用 (调用方显示的是 this.canvas, 不持有池缓冲)。
    scratchRecallAll();
    profTime('阶段:清屏', () => this.canvas.clear());
    // 属性动画 {animation} 先烘焙 (相机对象 origin/zoom 依赖烘焙后的值),
    // 再 setupCamera — 官方 camera:"default" 对象的 origin 动画驱动运镜
    profTime('阶段:动画烘焙', () => {
      try {
        this._resolveAnimations(t);
      } catch { /* 动画失败不影响渲染 */ }
    });
    profTime('阶段:相机', () => this._setupCamera());
    // scene scripts: 执行 {script, value} 更新 (彩虹色/visible/bloom 等动态值)
    // 多帧复用: 首次备份原始 value, 每帧先恢复再执行 (避免脚本值跨帧累积污染)
    const __tscript = profileEnabled ? performance.now() : 0;
    this._backupScriptValues();
    this._restoreScriptValues();
    try {
      // engine.canvasSize = 场景正交尺寸 (正交场景坐标, 非渲染分辨率)
      const ortho = this.scene.general && this.scene.general.orthogonalprojection;
      const sceneW = ortho && ortho.width ? ortho.width : this.W;
      const sceneH = ortho && ortho.height ? ortho.height : this.H;
      // shared 对象跨脚本共享 (NSL 框架: 主逻辑写 shared, 其他层读; 每帧持久化,
      // 由 _scriptCache 持有, 跨帧保留 — NSL 动画调度器/状态依赖)
      applySceneScripts(this.scene, t, {
        canvasSize: { x: sceneW, y: sceneH },
        userProps: this.userProps,
        scriptCache: this._scriptCache,
        // 脚本 thisScene/getLayer 写渲染对象 (烘焙后的 this.objects), 直接生效
        renderObjects: this.objects,
        runtime: t,
        frametime: 1 / 60,
      });
    } catch { /* 脚本失败不影响渲染 */ }
    if (profileEnabled) profAdd('阶段:脚本', performance.now() - __tscript);
    // clearColor
    const cc = this.scene.general && this.scene.general.clearcolor;
    if (cc && this.scene.general.clearenabled !== false) {
      const [r, g, b] = parseVec3(cc, [0, 0, 0]);
      profTime('阶段:清屏', () => this.canvas.clear(r * 255, g * 255, b * 255, 255));
    }
    const order = this.renderOrder.filter((o) => this._isVisible(o) && !this._isLiveComponent(o));
    // 官方反射 pass 必须先于主 pass (wallpaper64.exe.c:285410 早于 285621) ——
    // 主 pass 的材质 (grid/generic 的 REFLECTION 分支) 要能取到镜像缓冲。
    profTime('阶段:反射', () => this._renderReflectionPass(order, t));
    const __tobj = profileEnabled ? performance.now() : 0;
    for (const o of order) {
      try {
        // 剖析: 明细 → 类型 双层嵌套 (明细含对象名, 类型用于横向汇总)
        profTime('对象明细:' + String(o.name || o.id || '?') + ' [' + o._renderType + ']', () =>
          profTime('对象类型:' + o._renderType, () => {
            if (o._renderType === 'image') this.renderImage(o, t);
            else if (o._renderType === 'model') this.renderModel(o, t);
            else if (o._renderType === 'particle') this.renderParticleSystem(o, t);
            else if (o._renderType === 'text') this.renderTextObject(o, t);
            else if (o.sprite) {
              // sprite 对象 (官方 sprite.vert/frag: 面向相机的 billboard quad) 未实现 —
              // 旧实现被 _classify 归为 unknown 后**静默丢弃** (ricepod 的 sun 层即此处)。
              // 不静默: 记 degraded (像素不变; 生产由 scene-render-worker 落 gpu-diag)。
              const key = 'obj|sprite:' + (o.name || o.id);
              if (!this._degradedSeen) this._degradedSeen = new Set();
              if (!this._degradedSeen.has(key)) {
                this._degradedSeen.add(key);
                this._degraded(o.name != null ? String(o.name) : null, 'object:sprite',
                  'sprite 对象未实现 (官方 sprite.vert 相机朝向 billboard) → 该层未渲染: ' + String(o.sprite));
              }
            }
          }));
      } catch (e) {
        this.log('对象 ' + (o.name || o.id) + ' 渲染失败: ' + e.message);
      }
    }
    if (profileEnabled) profAdd('阶段:对象循环', performance.now() - __tobj);
    // Bloom 后处理 (WE 场景标配: 亮部提取 → 降采样模糊 → 叠加)
    const gen = this.scene.general || {};
    profTime('阶段:bloom', () => {
      if (gen.bloom === true) {
        this._applyBloom(gen);
      }
    });
    if (profileEnabled) profAdd('总渲染', performance.now() - __t0);
    return this.canvas;
  }

  // WE 属性动画: {animation: {c0: [{frame, value}...], options: {fps, length, mode}}}
  // 按 t 求值 → 写回 o[key] = {value} (线性插值, 引擎 Tween 简化)
  // c0/c1/c2 = 向量 x/y/z 分量动画 (独立通道, 逐通道插值后合并)
  // animation.relative === true → 关键帧值是相对基准的偏移 (最终值 = 基准 + 偏移),
  // 逐分量相加 (scale 例: base=1, c0/c1=[0.3,0.3,0] → 1.3, 官方帧验证)
  // 多帧复用安全: 备份 animation 原对象, 每帧先恢复再烘焙 (避免污染导致后续帧丢失动画)
  _resolveAnimations(t) {
    const animKeys = ['alpha', 'scale', 'origin', 'angles', 'visible', 'color', 'size', 'brightness', 'parallaxDepth', 'zoom'];
    if (!this._animBackup) {
      this._animBackup = [];
      for (const o of this.objects) {
        for (const key of animKeys) {
          const v = o[key];
          if (v && typeof v === 'object' && v.animation) this._animBackup.push([o, key, v]);
        }
      }
    }
    // 恢复 animation 原对象
    for (const [o, key, v] of this._animBackup) o[key] = v;
    // 按当前 t 烘焙
    for (const [o, key, v] of this._animBackup) {
      const a = v.animation;
      const opts = a.options || {};
      const fps = opts.fps || 30;
      const length = opts.length || 0;
      const mode = opts.mode || 'single';
      let frame = t * fps;
      // 静态帧 (单帧输出, this.staticFrame): 一次性属性动画直接取 **保持态** ——
      // 官方 mode=single 语义 = 播完保持末值, 故与 t 无关。判据完全来自壁纸自身的
      // options.mode, 不引入任何时间常数 (实测 Angel Mail 相机对象: zoom 10→1,
      // origin (-650.28,399.36)→(0,0), length 240 @30fps ⇒ 取保持态即稳定取景;
      // 旧行为取 t=2.5s 停在开屏特写)。循环类 (loop/wraploop/mirror/reverse) 不受影响。
      if (this.staticFrame && length > 0
          && mode !== 'loop' && mode !== 'wraploop' && mode !== 'mirror' && mode !== 'reverse') {
        frame = length + 1; // 每通道求值处 frame ≥ 末关键帧 → 取 last.value
      }
      // 播放模式
      if (length > 0) {
        if (mode === 'loop') frame = frame % length;
        else if (mode === 'reverse') {
          const m = frame % (length * 2);
          frame = m <= length ? m : length * 2 - m;
        }
      }
      // 逐通道 (c0/c1/c2 = x/y/z) 求值; 无通道动画的键用 c0
      const evalChannel = (ch) => {
        const frames = (a[ch] || []).filter((f) => f && typeof f.frame === 'number' && f.value != null);
        if (!frames.length) return null;
        frames.sort((x, y) => x.frame - y.frame);
        const last = frames[frames.length - 1];
        let value;
        if (frame <= frames[0].frame) value = frames[0].value;
        else if (frame >= last.frame) value = last.value;
        else {
          for (let i = 0; i < frames.length - 1; i++) {
            const a0 = frames[i], a1 = frames[i + 1];
            if (frame >= a0.frame && frame <= a1.frame) {
              value = this._animValueAt(a0, a1, frame);
              break;
            }
          }
          if (value === undefined) value = last.value;
        }
        return value;
      };
      const hasMulti = ['c1', 'c2'].some((ch) => a[ch] && a[ch].length) || (a.c0 && a.c0.length && typeof (a.c0[0] || {}).value === 'string' && String(a.c0[0].value).trim().split(/\s+/).length > 1);
      let value;
      if (hasMulti) {
        // 多通道: 逐通道求值 → "x y z" 字符串
        const parts = [];
        for (const ch of ['c0', 'c1', 'c2']) {
          const cv = evalChannel(ch);
          parts.push(cv != null ? cv : 0);
        }
        value = parts.join(' ');
      } else {
        value = evalChannel('c0');
        if (value === undefined || value === null) continue;
      }
      // relative: 基准值 + 动画偏移 (逐分量)
      if (a.relative === true && v.value != null) {
        const base = v.value;
        const valStr = typeof value === 'number' ? String(value) : value;
        const pb = typeof base === 'string' ? base.trim().split(/\s+/).map(Number) : [base];
        const pv = typeof valStr === 'string' ? valStr.trim().split(/\s+/).map(Number) : [valStr];
        const out = pv.map((x, i) => x + (pb[i] ?? 0));
        value = out.join(' ');
      }
      o[key] = { value };
    }
  }

  // 数值或 "x y z" 向量线性插值
  _lerpValue(a, b, k) {
    const pa = typeof a === 'string' ? a.trim().split(/\s+/).map(Number) : [a];
    const pb = typeof b === 'string' ? b.trim().split(/\s+/).map(Number) : [b];
    if (pa.length === 1 && pb.length === 1) return pa[0] + (pb[0] - pa[0]) * k;
    const out = pa.map((x, i) => x + ((pb[i] ?? x) - x) * k);
    return out.join(' ');
  }

  // 等比降采样 (box 滤波): 效果/渲染前把大纹理缩到 maxSize, 提速 CPU 逐像素
  // (官方 GPU 并行处理全分辨率; CPU 用降采样近似, 效果是低频扰动损失小)
  _downsample(tex, maxSize) {
    const w = tex.width, h = tex.height;
    const scale = Math.min(1, maxSize / Math.max(w, h));
    if (scale >= 1) return tex;
    const tw = Math.max(1, Math.round(w * scale)), th = Math.max(1, Math.round(h * scale));
    const src = tex.rgba;
    const out = new Uint8Array(tw * th * 4);
    const sx = w / tw, sy = h / th;
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor(y * sy), sy1 = Math.min(h, Math.ceil((y + 1) * sy));
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor(x * sx), sx1 = Math.min(w, Math.ceil((x + 1) * sx));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = sy0; yy < sy1; yy++) {
          const row = yy * w;
          for (let xx = sx0; xx < sx1; xx++) {
            const i = (row + xx) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3];
            n++;
          }
        }
        const di = (y * tw + x) * 4;
        out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
      }
    }
    return { width: tw, height: th, rgba: out };
  }

  // 关键帧贝塞尔插值 (官方动画切线): 每关键帧带 back/front 控制点
  // {back:{x,y},front:{x,y}} — 相对关键帧的偏移 (x=帧, y=值); enabled 时生效。
  // 相邻帧 a0(f0,v0)→a1(f1,v1): P0=(f0,v0), P1=(f0+front.x, v0+front.y),
  // P2=(f1+back.x, v1+back.y), P3=(f1,v1); 解 x(u)=frame 得 u → y(u)。
  // 无切线或值非数值 → 回退线性插值 (原 _lerpValue 语义)。
  _animValueAt(a0, a1, frame) {
    const f0 = a0.frame, f1 = a1.frame;
    const v0 = Number(a0.value), v1 = Number(a1.value);
    if (!isFinite(v0) || !isFinite(v1) || f1 <= f0) {
      return this._lerpValue(a0.value, a1.value, (frame - f0) / (f1 - f0 || 1));
    }
    const ft = a0.front, bt = a1.back;
    const hasTangent = (ft && ft.enabled && (ft.x != null || ft.y != null)) || (bt && bt.enabled && (bt.x != null || bt.y != null));
    if (!hasTangent) return v0 + (v1 - v0) * ((frame - f0) / (f1 - f0));
    const p0x = f0, p0y = v0, p3x = f1, p3y = v1;
    const p1x = ft && ft.enabled && ft.x != null ? f0 + ft.x : f0;
    const p1y = ft && ft.enabled && ft.y != null ? v0 + ft.y : v0;
    const p2x = bt && bt.enabled && bt.x != null ? f1 + bt.x : f1;
    const p2y = bt && bt.enabled && bt.y != null ? v1 + bt.y : v1;
    // x(u) = (1-u)^3·p0x + 3(1-u)^2·u·p1x + 3(1-u)·u^2·p2x + u^3·p3x
    const bx = (u) => {
      const om = 1 - u;
      return om * om * om * p0x + 3 * om * om * u * p1x + 3 * om * u * u * p2x + u * u * u * p3x;
    };
    const dx = (u) => {
      const om = 1 - u;
      return 3 * om * om * (p1x - p0x) + 6 * om * u * (p2x - p1x) + 3 * u * u * (p3x - p2x);
    };
    const by = (u) => {
      const om = 1 - u;
      return om * om * om * p0y + 3 * om * om * u * p1y + 3 * om * u * u * p2y + u * u * u * p3y;
    };
    // 牛顿迭代解 x(u)=frame (u∈[0,1]); 切线 x 越界(时间回退)时退化为线性参数
    let u = (frame - f0) / (f1 - f0);
    let ok = true;
    for (let i = 0; i < 10; i++) {
      const x = bx(u) - frame;
      const d = dx(u);
      if (Math.abs(d) < 1e-9) break;
      const nu = u - x / d;
      if (nu < -0.5 || nu > 1.5) { ok = false; break; }
      u = nu;
      if (Math.abs(x) < 1e-6) break;
    }
    if (!ok || u < 0 || u > 1) u = (frame - f0) / (f1 - f0);
    return by(Math.max(0, Math.min(1, u)));
  }

  // Bloom: 引擎完整链 (downsample_quarter_bloom → combine_hdr)
  // 1. 降采样 1/4: 4 角平均 → saturate(scale-threshold) → 饱和度增强 → ×strength×tint
  // 2. 合成: 原图 + bloom 4 角平均×0.25 → 线性化 lin() → ×曝光
}

installBloom(SceneRenderer.prototype);
installCamera(SceneRenderer.prototype);
installImage(SceneRenderer.prototype);
installText(SceneRenderer.prototype);
installPuppet(SceneRenderer.prototype);
installModel(SceneRenderer.prototype);
installEffects(SceneRenderer.prototype);
installParticles(SceneRenderer.prototype);
installGlsl(SceneRenderer.prototype);
// GPU 效果适配层 (gpuAccel 开启时才生效; 无 GPU/驱动时自身回退, 见该文件注释)
installGpuAdapter(SceneRenderer.prototype);
