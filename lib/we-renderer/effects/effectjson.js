// WE 渲染引擎 — 数据驱动的 effect.json 执行器 (effects/ 层)
//
// 背景 (取证: .test-cache/fix-effects-data.md §2):
//   WE 壁纸对"用什么效果、效果怎么跑"的**全部**声明都在壁纸文件里:
//     scene.json objects[].effects[]            → 实例: { file, id, visible, passes[].constantshadervalues }
//     <effectdir>/effect.json                   → passes[].material / target / bind, fbos[].scale+format,
//                                                  commands, dependencies
//     <material>.json passes[].shader            → 真正的 shader 词干 + combos + constantshadervalues
//     shaders/<shader>.frag|vert                 → 源码 (// [COMBO] 默认值, uniform // {...} 元注释)
//   旧的 GLSL 通路 (glsl/integration.js `_readGlslShader`) 只用**效果目录名**去猜
//   `shaders/effects/<name>.frag`, 猜不中就记 degraded。Mutsumi(3629379075) 的
//   `effects/blurprecise` 正是这种情况: 效果目录叫 blurprecise, 而它声明的 shader 是
//   `effects/blur_precise_gaussian` → 猜名 miss → 35 条 `effect:blurprecise` degraded。
//   壁纸里源码**是齐的** (pkg 内 shaders/effects/blur_precise_gaussian.frag|vert)。
//
// 本模块按 effect.json 的声明把多 pass 链在 CPU 上跑完:
//   passes[] (material→shader, target→FBO scale, bind→纹理槽) → glsl/executor 逐 pass 渲染。
// 它是**补充**通路: effects.js 只在注册表内核未命中且猜名 GLSL 通路失败时才走这里,
// 因此既有场景的像素不受影响 (逐场景 SHA 对照见 §5)。
import path from 'node:path';
import fs from 'node:fs';
import { compileGlsl, buildUniforms, renderGlsl } from '../glsl/executor.js';
import { parseMeta, expandIncludes } from '../glsl/preprocess.js';

// GPU 链式白名单外的"大对象降采样"阈值 —— 与 glsl/integration.js 的 MAX_GLSL_PIXELS 同值,
// 保证静态帧以外的多帧动画有同样的成本上界 (静态帧不降采样, 用户要求)。
const MAX_JSON_GLSL_PIXELS = 65536;

// A/B 开关 (与 DSH_WE_NO_FX / DSH_WE_NO_FX_CHAIN 同风格): 关掉数据驱动通路, 回到
// "猜名 GLSL + 记 degraded" 的旧行为。默认开 —— 仅用于逐帧 SHA 对照取证。
const JSON_FX_OFF = process.env.DSH_WE_NO_FXJSON === '1';

/** combo 值一律转字符串: shaderfrog 预处理对**数值** 0 会删 token (`#if MASK || X` → `#if  || X`)。
 *  取证: scripts/tmp-blurprecise-probe3.mjs (number 0 FAIL / string "0" OK)。 */
export function comboStr(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  return typeof v === 'string' ? v : String(v);
}

function asNumber(v) {
  const s = comboStr(v);
  if (s === null) return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

/** pkg → WE 全局 assets 的复合读取: 同名相对路径在两处都试, 并额外试 `effects/<name>/` 前缀
 *  (WE 全局效果以"整包"形式放在 assets/effects/<name>/ 下, 其内部相对路径也相对该包)。 */
function makeReader(renderer, name) {
  const read = (rel) => {
    if (!rel) return null;
    try { const b = renderer.pkg.read(rel); if (b && b.length) return { buf: b, where: 'pkg' }; } catch { /* */ }
    const assets = renderer.weAssetsDir;
    if (!assets) return null;
    const cands = [
      path.join(assets, 'assets', rel),
      path.join(assets, 'assets', 'effects', name, rel),
    ];
    for (const p of cands) {
      try { if (fs.existsSync(p)) return { buf: fs.readFileSync(p), where: 'assets' }; } catch { /* */ }
    }
    return null;
  };
  const readText = (rel) => {
    const hit = read(rel);
    return hit ? { text: hit.buf.toString('utf8'), where: hit.where } : null;
  };
  return { read, readText };
}

function installEffectJson(proto) {
  // ── effect.json → 可执行 pass 描述 (实例级缓存, key = ef.file) ───────────────
  proto._fxJsonDef = function (ef, name) {
    if (!ef || !ef.file) return null;
    if (!this._fxJsonCache) this._fxJsonCache = new Map();
    const key = ef.file;
    if (this._fxJsonCache.has(key)) return this._fxJsonCache.get(key);
    let def = null;
    try { def = this._fxJsonResolve(ef, name); } catch (e) { this.log('effect.json 解析失败 ' + ef.file + ': ' + e.message); def = null; }
    this._fxJsonCache.set(key, def);
    return def;
  };

  proto._fxJsonResolve = function (ef, name) {
    const R = makeReader(this, name);
    const jh = R.readText(ef.file);
    if (!jh) return null;
    let json;
    try { json = JSON.parse(jh.text); } catch (e) { this.log('effect.json 解析失败 ' + ef.file + ': ' + e.message); return null; }
    const fbos = {};
    for (const f of json.fbos || []) {
      if (!f || !f.name) continue;
      // WE: fbos[].scale = 分辨率除数 (blur → 4 = 1/4 分辨率; godrays → 2); 缺省 = 全分辨率
      const sc = f.scale != null ? Number(f.scale) : 1;
      fbos[f.name] = { scale: Number.isFinite(sc) && sc > 0 ? sc : 1, format: f.format || null };
    }
    const resolveInclude = (inc) => {
      // 与 glsl/integration.js `_resolveGlslInclude` 同序: 全局 assets/shaders → pkg shaders
      try {
        if (this.weAssetsDir) {
          const p = path.join(this.weAssetsDir, 'assets', 'shaders', inc);
          if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
        }
      } catch { /* */ }
      try { return this.pkg.readText('shaders/' + inc) || ''; } catch { return ''; }
    };
    const passes = [];
    const problems = [];
    for (const [i, p] of (json.passes || []).entries()) {
      const rec = { index: i, material: p.material || null, target: p.target || null, bind: p.bind || null,
        targetscale: p.targetscale ?? null, shaderStem: null, fragRel: null, vertRel: null,
        frag: null, vert: null, fragWhere: null, vertWhere: null, meta: null,
        materialCombos: null, materialConstants: null, materialTextures: null, name };
      if (p.material) {
        const mh = R.readText(p.material);
        if (!mh) problems.push('pass ' + i + ' 材质缺失: ' + p.material);
        else {
          let mj = null;
          try { mj = JSON.parse(mh.text); } catch { problems.push('pass ' + i + ' 材质 JSON 损坏: ' + p.material); }
          const mp = (mj && mj.passes && mj.passes[0]) || {};
          if (!mp.shader) problems.push('pass ' + i + ' 材质未声明 shader: ' + p.material);
          else {
            const stem = 'shaders/' + String(mp.shader).replace(/^shaders\//, '');
            rec.shaderStem = stem;
            rec.fragRel = stem + '.frag';
            rec.vertRel = stem + '.vert';
            const fh = R.readText(rec.fragRel);
            if (fh) { rec.frag = fh.text; rec.fragWhere = fh.where; }
            const vh = R.readText(rec.vertRel);
            if (vh) { rec.vert = vh.text; rec.vertWhere = vh.where; }
            if (!fh) problems.push('pass ' + i + ' shader 源码缺失: ' + rec.fragRel);
          }
          rec.materialCombos = mp.combos || null;
          rec.materialConstants = mp.constantshadervalues || null;
          rec.materialTextures = mp.textures || null;
        }
      } else if (p.shader) {
        // 少数 effect.json 直接在 pass 上写 shader
        const stem = 'shaders/' + String(p.shader).replace(/^shaders\//, '');
        rec.shaderStem = stem; rec.fragRel = stem + '.frag'; rec.vertRel = stem + '.vert';
        const fh = R.readText(rec.fragRel); if (fh) { rec.frag = fh.text; rec.fragWhere = fh.where; }
        const vh = R.readText(rec.vertRel); if (vh) { rec.vert = vh.text; rec.vertWhere = vh.where; }
      } else {
        problems.push('pass ' + i + ' 既无 material 也无 shader');
      }
      if (rec.frag) {
        // include 先展开再取 meta (与 compileGlsl 内部同序, GLS-22)
        const warns = [];
        try {
          rec.fragX = expandIncludes(rec.frag, resolveInclude, { onWarn: (w) => warns.push(w) });
          if (rec.vert) rec.vertX = expandIncludes(rec.vert, resolveInclude, { onWarn: (w) => warns.push(w) });
        } catch (e) { problems.push('pass ' + i + ' include 展开失败: ' + e.message); rec.fragX = rec.frag; rec.vertX = rec.vert; }
        rec.meta = { frag: parseMeta(rec.fragX), vert: rec.vertX ? parseMeta(rec.vertX) : { combos: {}, uniforms: {} } };
        rec.includeWarns = warns;
      }
      passes.push(rec);
    }
    return { file: ef.file, name, where: jh.where, json, fbos, passes, problems, resolveInclude };
  };

  /** 声明来源标注: 每个 pass 的 combo 有效值 + 它来自"壁纸声明"还是"shader 默认"。
   *  壁纸声明 = 实例 (scene.json passes[i].combos) > 材质 (material passes[0].combos) > 纹理派生 (MASK)
   *  其余落到 shader `// [COMBO]` 的 default。 */
  proto._fxJsonCombos = function (def, ef) {
    const out = [];
    if (!def) return out;
    for (const p of def.passes) {
      const metaCombos = { ...(p.meta ? p.meta.frag.combos : {}), ...(p.meta ? p.meta.vert.combos : {}) };
      const val = {}, src = {};
      for (const [k, v] of Object.entries(metaCombos)) {
        if (v && v.default !== undefined) { val[k] = comboStr(v.default); src[k] = 'shader-default'; }
      }
      // 纹理派生 combo (MASK 等): uniform 元注释带 combo + opacitymask
      const texRefs = this._fxJsonTextures(def, ef, p.index).refs;
      for (const m of [p.meta ? p.meta.frag : null, p.meta ? p.meta.vert : null]) {
        if (!m) continue;
        for (const info of Object.values(m.uniforms)) {
          if (!info.combo || !info.textureUniform) continue;
          const mm = /^g_Texture(\d+)$/.exec(info.textureUniform);
          if (!mm) continue;
          const bound = !!(texRefs[Number(mm[1])] && texRefs[Number(mm[1])] !== 'null');
          val[info.combo] = bound ? '1' : '0';
          src[info.combo] = bound ? 'texture-bound' : 'texture-unbound';
        }
      }
      for (const [k, v] of Object.entries(p.materialCombos || {})) { const s = comboStr(v); if (s !== null) { val[k] = s; src[k] = 'material'; } }
      const sceneP = (ef.passes && ef.passes[p.index]) || {};
      for (const [k, v] of Object.entries(sceneP.combos || {})) { const s = comboStr(v); if (s !== null) { val[k] = s; src[k] = 'scene'; } }
      out.push({ combos: val, source: src, metaCombos });
    }
    return out;
  };

  /** pass 的纹理槽引用表: index → 相对纹理路径 ('previous' 由调用方处理) */
  proto._fxJsonTextures = function (def, ef, passIndex) {
    const p = def.passes[passIndex];
    const refs = [];
    const binds = [];
    if (p && p.bind) for (const b of p.bind) binds.push(b);
    for (const b of binds) if (b && b.index != null) refs[Number(b.index)] = b.name;
    const sceneP = (def.json.passes || [])[passIndex] || {};
    const sceneTex = (ef.passes && ef.passes[passIndex] && ef.passes[passIndex].textures) || null;
    const list = sceneTex || p.materialTextures || sceneP.textures || null;
    if (list) for (const [i, t] of list.entries()) if (refs[i] === undefined) refs[i] = t;
    if (refs[0] === undefined) refs[0] = 'previous';
    return { refs, binds };
  };

  /**
   * 按 effect.json 执行整条效果链。返回新图像, 或**原图** (不可执行/失败)。
   * 失败原因写入 this._fxJsonLastError (供 effects.js 精确记 degraded)。
   */
  proto._applyEffectJsonEffect = function (img, ef, name, t) {
    this._fxJsonLastError = null;
    const def = this._fxJsonDef(ef, name);
    if (!def) { this._fxJsonLastError = '壁纸未携带 effect.json (' + (ef && ef.file) + ')'; return img; }
    if (!def.passes.length) { this._fxJsonLastError = 'effect.json 未声明任何 pass'; return img; }
    const bad = def.passes.find((p) => !p.frag);
    if (bad) {
      this._fxJsonLastError = 'effect.json pass ' + bad.index + ' 声明的 shader 源码在此壁纸与 WE 全局 assets 中均不存在 ('
        + (bad.fragRel || bad.material || '?') + ')';
      return img;
    }
    const W = img.width, H = img.height;
    const rts = new Map();
    let result = null;
    const chains = this._fxJsonCombos(def, ef);
    for (const p of def.passes) {
      const rtDef = p.target ? def.fbos[p.target] : null;
      const div = rtDef ? rtDef.scale : 1;
      const pw = Math.max(1, Math.round(W / div)), ph = Math.max(1, Math.round(H / div));
      const out = this._fxJsonRenderPass(img, ef, def, p, chains[p.index], pw, ph, rts, t, name);
      if (!out) return img; // 单 pass 失败 → 整个效果不应用 (与 GLSL 通路同策略)
      if (p.target) rts.set(p.target, out);
      else result = out;
    }
    if (!result) {
      // 全部 pass 都写了 target → 取最后一个 target 的结果
      const last = def.passes[def.passes.length - 1];
      result = last && last.target ? rts.get(last.target) : null;
    }
    if (!result) { this._fxJsonLastError = 'effect.json 全部 pass 均无产出'; return img; }
    if (result.width !== W || result.height !== H) result = this._upsampleRgba(result, W, H);
    return result;
  };

  proto._fxJsonRenderPass = function (img, ef, def, p, chain, w, h, rts, t, name) {
    const combos = {};
    for (const [k, v] of Object.entries(chain.combos)) combos[k] = comboStr(v);
    const warn = [];
    let compiled;
    try {
      compiled = compileGlsl({
        fragSource: p.fragX,
        vertSource: p.vertX || null,
        combos,
        resolveInclude: def.resolveInclude,
        onWarn: (x) => warn.push(x),
      });
    } catch (e) {
      this._fxJsonLastError = 'pass ' + p.index + ' (' + p.shaderStem + ') 编译失败: ' + e.message;
      this.log('effect.json ' + name + ' pass ' + p.index + ' 编译失败: ' + e.message);
      return null;
    }
    for (const x of warn) this.log('effect.json ' + name + ' include 警告: ' + x);
    if (p.includeWarns) for (const x of p.includeWarns) this.log('effect.json ' + name + ' include 警告: ' + x);
    // ── 纹理槽 ──
    const texInfo = this._fxJsonTextures(def, ef, p.index);
    const sceneP = (ef.passes && ef.passes[p.index]) || {};
    const constants = Object.assign({}, p.materialConstants || {}, sceneP.constantshadervalues || {});
    const textures = [];
    for (let k = 0; k < 8; k++) {
      const ref = texInfo.refs[k];
      if (ref === undefined || ref === null) { textures[k] = null; continue; }
      if (ref === 'previous') { textures[k] = img; continue; }
      if (rts.has(ref)) { textures[k] = rts.get(ref); continue; }
      textures[k] = (typeof ref === 'string' && ref) ? this.loadTexture(ref) : null;
    }
    let u;
    try {
      u = buildUniforms(compiled.uniforms, constants, {
        time: t || 0,
        textures,
        objW: img.width, objH: img.height,
        userAlpha: 1,
        parallaxPosition: this.optsMouse ? [this.optsMouse.x, this.optsMouse.y] : [0.5, 0.5],
      });
      for (const [un, info] of Object.entries(compiled.uniforms)) {
        if (info.type === 'sampler2D' && u[un] === undefined) {
          const idx = Number((/g_Texture(\d+)/.exec(un) || [])[1] || 0);
          u[un] = textures[idx] || null;
        }
      }
    } catch (e) {
      this._fxJsonLastError = 'pass ' + p.index + ' uniform 组装失败: ' + e.message;
      return null;
    }
    // 环绕: 槽位 0 (本 pass 的输入) CLAMP, 其余 (位移/噪声/遮罩) REPEAT —— 与
    // glsl/integration.js `_renderGlslEffect` 的槽位裁决一致
    for (let k = 1; k < textures.length; k++) if (textures[k]) textures[k].__glslRepeat = true;
    if (textures[0]) textures[0].__glslRepeat = false;
    let out;
    try {
      out = renderGlsl(compiled, {
        width: w, height: h, u,
        sampler: (tex, uu, vv) => this._texSample(tex, uu, vv, !(tex && tex.__glslRepeat)),
      });
    } catch (e) {
      this._fxJsonLastError = 'pass ' + p.index + ' 渲染异常: ' + e.message;
      return null;
    }
    if (out.pixelErrors) {
      this._fxJsonLastError = 'pass ' + p.index + ' 逐像素异常 ' + out.pixelErrors + ' 处: ' + (out.lastError || '');
      return null;
    }
    return out;
  };

  // 大对象降采样 (多帧动画路径): 与 glsl/integration.js 同口径 —— 静态帧不降采样。
  proto._applyEffectJsonEffectScaled = function (img, ef, name, t) {
    if (JSON_FX_OFF) { this._fxJsonLastError = 'DSH_WE_NO_FXJSON=1 (A/B 对照, 数据驱动通路关闭)'; return img; }
    const total = img.width * img.height;
    if (!this.staticFrame && total > MAX_JSON_GLSL_PIXELS) {
      const s = Math.sqrt(MAX_JSON_GLSL_PIXELS / total);
      const sw = Math.max(1, Math.round(img.width * s)), sh = Math.max(1, Math.round(img.height * s));
      const small = { width: sw, height: sh, rgba: this._downsampleRgba(img, sw, sh) };
      const prev = img;
      const out = this._applyEffectJsonEffect(small, ef, name, t);
      if (out === small) { this._fxJsonLastError = this._fxJsonLastError || '降采样执行失败'; return prev; }
      return this._upsampleRgba(out, prev.width, prev.height);
    }
    return this._applyEffectJsonEffect(img, ef, name, t);
  };

  proto._downsampleRgba = function (img, w, h) {
    const out = new Uint8Array(w * h * 4);
    const sw = img.width, sh = img.height;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / h));
      for (let x = 0; x < w; x++) {
        const sx = Math.min(sw - 1, Math.floor((x * sw) / w));
        const si = (sy * sw + sx) * 4, di = (y * w + x) * 4;
        out[di] = img.rgba[si]; out[di + 1] = img.rgba[si + 1]; out[di + 2] = img.rgba[si + 2]; out[di + 3] = img.rgba[si + 3];
      }
    }
    return out;
  };

  /**
   * 声明 vs 实现 的 combo 差异表 (数据驱动, 供手写内核自证"按数据执行")。
   * @param implemented { COMBO名: 本内核实现的取值 }
   * @returns { found, values: {combo: {value, source}}, bad: [{pass, combo, value, source, implemented}] }
   *   found = 壁纸声明的 shader 里确实存在这些 combo (证明读取成功);
   *   bad   = 有效值 ≠ 本内核实现值 —— 来源可能是壁纸显式声明 (material/scene),
   *           也可能是 shader 自身默认值 (此时本内核在近似官方默认变体)。
   */
  proto._fxJsonComboAudit = function (ef, name, implemented) {
    const def = this._fxJsonDef(ef, name);
    const res = { ok: false, found: false, values: {}, bad: [], reason: null, def };
    if (!def) { res.reason = 'effect.json 缺失'; return res; }
    const chains = this._fxJsonCombos(def, ef);
    for (let i = 0; i < chains.length; i++) {
      const c = chains[i];
      for (const [k, v] of Object.entries(implemented)) {
        if (!(k in c.combos)) continue;
        res.found = true;
        const val = asNumber(c.combos[k]);
        if (res.values[k] === undefined) res.values[k] = { value: c.combos[k], source: c.source[k], pass: i };
        if (val !== null && val !== Number(v)) {
          res.bad.push({ pass: i, combo: k, value: c.combos[k], source: c.source[k], implemented: v });
        }
      }
    }
    res.ok = res.found && res.bad.length === 0;
    return res;
  };
}

export { installEffectJson };
