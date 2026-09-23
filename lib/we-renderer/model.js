// WE 渲染引擎 — model (从 core.js 拆分, 逻辑不变)
import { v3sub, v3add, v3cross, v3dot, v3norm, mat4FromTRS, mat4TransformPoint, mat4TransformVec3, sat, smoothstepFn } from './math.js';
// 静态 .mdl 多子网格解析器 (mdl.js)。注意: 历史上这里调用的是 puppet.js 里另一份
// _parseMdlStatic 副本 —— 那一份**没有**多子网格支持, 且只在本文件被调用。
// 两份实现已在 26 个本地 MDL 上逐字段对比为**完全等价** (scripts/tmp-mdlsplit3.mjs),
// 因此改用 mdl.js 版本对单块文件是零行为差异; 解析失败时仍回退旧副本兜底。
import { parseMdlStatic } from './mdl.js';
// 场景图修正版 (去重键 = 对象身份, 见 installModel 注释)
import { installSceneGraph } from './scene/graph.js';
// 数据驱动材质着色器解释器: 未被手写移植覆盖的材质 shader 直接用**壁纸自带的**
// .vert/.frag 编译执行 (见 glsl/material.js)
import { bindMaterialProgram, readWallpaperShader } from './glsl/material.js';

// 数据驱动材质通路: 手写移植 (MODEL_SHADERS) 保留为快路径; 其余材质 shader 走解释器。
// DSH_WE_MAT_INTERP 是诊断开关 (逗号分隔的 shader 名, 或 `all`) —— 用于把**已手写**的
// shader 也强制走解释器做对拍 (生产不设 ⇒ 手写快路径逐位不变)。
const MAT_INTERP_FORCE = (process.env.DSH_WE_MAT_INTERP || '').trim();
const MAT_INTERP_ALL = MAT_INTERP_FORCE === 'all' || MAT_INTERP_FORCE === '1';
const MAT_INTERP_OFF = MAT_INTERP_FORCE === 'none' || MAT_INTERP_FORCE === 'off' || MAT_INTERP_FORCE === '-';
const MAT_INTERP_CLIPNEAR = process.env.DSH_WE_MAT_CLIPNEAR !== '0';
// 诊断消融 (生产不设): 手写快路径的世界坐标改用透视校正插值 (GPU 语义)
const PERSP_WP = process.env.DSH_WE_PERSP_WP === '1';
// 诊断消融 (生产不设): 手写快路径的 `generic` 也启用近裁剪面 —— 用于把
// "亮度差"拆成"着色公式差"与"近裁剪差"两部分 (见报告 §10)
const CLIPNEAR_ALL = process.env.DSH_WE_CLIPNEAR_ALL === '1';
const MAT_INTERP_NAMES = new Set(
  MAT_INTERP_FORCE && !MAT_INTERP_ALL ? MAT_INTERP_FORCE.split(',').map((s) => s.trim()).filter(Boolean) : [],
);
// 解释器通路的顶点位置由官方 vert 程序给出 ⇒ 与 GPU 一样做近裁剪面裁剪
// (clipNearPlane; 手写移植仍按 CUSTOM_3D_SHADERS 逐 shader 限定, 见其注释)
// image 图层上**已有手写通道**的 shader (image.js 内实现): 保持为快路径, 不进解释器。
//   genericimage → _genericImagePlan/_genericImageApply (纹理空间移植)
//   swayimage    → _swayImage       flag → _flagImage        retro → _retroImage
//   flat/flatalpha → _renderSolidLayer
// 其余 (dino_run/razer_* 的 genericimage2、workshop 的 genericimage4 等) 走数据驱动解释器。
const IMAGE_PORT_SHADERS = new Set([
  'genericimage', 'swayimage', 'flag', 'retro', 'flat', 'flatalpha', 'passthrough',
]);

function matInterpWanted(name) {
  if (!name || MAT_INTERP_OFF) return false;
  if (MAT_INTERP_ALL) return true;
  if (MAT_INTERP_NAMES.has(name)) return true;
  // 手写移植 (MODEL_SHADERS) 是快路径; 其余一律**先试数据驱动** —— 包括 generic 族
  // (它们此前落 _shadeGeneric 近似, 属"按 shader 名手写"的同一模式, 本轮改由壁纸
  //  自带的 generic.frag/vert 决定; 解释器不可用时才回退 _shadeGeneric)。
  return !MODEL_SHADERS.has(name);
}

// ── 模块级常量 / 小工具 ──────────────────────────────────────────────
// generic 族的官方着色器 (generic/generic2/generic3/generic4): 落 _shadeGeneric 是
// **设计内**的近似回退 (有源码依据, 见 _shadeGeneric 注释), 不算"未实现着色器"。
const FALLBACK_SHADERS = new Set(['generic', 'generic2', 'generic3', 'generic4']);
// model 分派 (_makeShadeFn) 已实现的着色器集合 —— 未列出的才会走通用回退并记 degraded
const MODEL_SHADERS = new Set([
  'core', 'backgroundsphere', 'dna', 'bg', 'curve', 'neonsun', 'neongrid', 'cloudsbg', 'flowimage',
  // 壁纸自带自定义着色器 (本文件逐行 CPU 复刻)
  'skybox', 'ricepod', 'ricepodjet', 'ricepodorbitalaurora', 'ricepodorbitalthunder',
  // 官方 3D 默认壁纸 techno / audiophile / fantasticcar 的自带着色器
  // (官方源码: <project>/shaders/*.{vert,frag}; 影响面见 .test-cache/fix-3d-shaders.md §1)
  'technoglow', 'technohex', 'technoorbit',
  'audiophile', 'audiophileflow', 'audiophileglow',
  'grid', 'car', 'dome', 'shadow',
]);
const isModelShaderImplemented = (name) => MODEL_SHADERS.has(name) || FALLBACK_SHADERS.has(name);
// 顶点以相机为原点 (a_Position + g_EyePosition, **不用** g_ModelMatrix) 的自定义 shader:
// 官方 skybox.vert:11 / ricepodorbitalaurora.vert:20 / ricepodorbitalthunder.vert:10。
const EYE_CENTERED_SHADERS = new Set(['skybox', 'ricepodorbitalaurora', 'ricepodorbitalthunder']);
// gl_Position 只用 g_ViewProjectionMatrix (**不含** g_ModelMatrix) 的着色器:
// 官方 grid.vert:21 `gl_Position = mul(vec4(a_Position, 1.0), g_ViewProjectionMatrix)`。
const NO_MODEL_MATRIX_SHADERS = new Set(['grid']);
// 逐顶点 varying 数量 (透视校正插值后传给片元): 官方 vert 里无法用 UV 仿射表达的量。
//   technohex.vert:20-26 v_Dot  (依赖 a_Position/a_Normal 的点乘, 非线性)
//   audiophile.vert:17-30 color (依赖 g_AudioSpectrum16 查表 + 法线点乘)
//   car.vert:28-35     v_Var0/v_Var1 (切线空间光/视方向, 共 6 个)
//   grid.vert:22-27    v_WorldPosition.xy + v_HalfDir.xyz (共 5 个)
const MODEL_VARYINGS = { technohex: 1, audiophile: 3, car: 6, grid: 5 };
// 常量光向 (官方 grid.vert:18 / car.vert:25 / car.frag:42 的 vec3(0.577350259) = 1/√3)
const LIGHT_DIR_111 = [0.577350259, 0.577350259, 0.577350259];
// 本轮新实现的三个官方 3D 壁纸的自带着色器 (techno/audiophile/fantasticcar) ——
// 只有这些走近裁剪面裁剪 (见 clipNearPlane 注释: 不改变其它场景的像素)
const CUSTOM_3D_SHADERS = new Set([
  'technoglow', 'technohex', 'technoorbit',
  'audiophile', 'audiophileflow', 'audiophileglow',
  'grid', 'car', 'dome', 'shadow',
]);

// 降级留痕 (去重: 同一对象 × 同一功能只报一次; 无 onDegraded 时零行为)
function degradedOnce(r, o, feature, action) {
  if (typeof r._degraded !== 'function') return;
  const key = String(o && o.name != null ? o.name : (o && o.id)) + '|' + feature;
  if (!r._degradedSeen) r._degradedSeen = new Set();
  if (r._degradedSeen.has(key)) return;
  r._degradedSeen.add(key);
  r._degraded(o && o.name != null ? String(o.name) : null, feature, action);
}

// 字节搜索 (仅本文件用; mdl.js 的同名实现未导出)
function indexOfBytes(buf, str, from) {
  const pat = Buffer.from(str, 'utf8');
  for (let i = from || 0; i + pat.length <= buf.length; i++) {
    if (buf[i] !== pat[0]) continue;
    let ok = true;
    for (let k = 1; k < pat.length; k++) if (buf[i + k] !== pat[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

// 剥 JSON 的行注释 (`//...`) 与块注释 (`/*...*/`), 字符串字面量内不剥。
// 官方材质 JSON 允许注释 (fantasticcar/materials/car/glass.json:6 即含 `//`),
// 严格 JSON.parse 会抛错。此函数对**不含注释**的文本返回逐字节相同的 JSON 语义。
function stripJsonComments(txt) {
  let out = '';
  let inStr = false, esc = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && txt[i + 1] === '/') {
      while (i < txt.length && txt[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && txt[i + 1] === '*') {
      i += 2;
      while (i < txt.length && !(txt[i] === '*' && txt[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

// 近裁剪面裁剪 (齐次空间 w ≥ wMin) —— GPU 管线固有步骤, CPU 光栅化器原先**缺失**:
// 跨相机平面的三角形被直接投影成垃圾屏幕坐标 (w<0 的顶点翻到画面另一侧), 覆盖整屏并
// 造成巨量过绘。实测 techno 的球罩 (800 三角形) 经此路径产生 1436953 次着色
// (画布仅 129600 像素 ⇒ 11 倍过绘), 整帧被加亮到均值 194/255。
//
// 只做"投影后屏幕坐标"→"齐次坐标"的还原再插值: 屏幕 xy 先还原为 clip.xy = ndc·w,
// 与 w / ndc.z·w / uv / 各顶点属性一起按同一 t 线性插值 (GPU 裁剪语义: 裁剪插值与
// clipless 线性插值同 t), 再重新投影。**完全在前的三角形逐位复用原顶点** ⇒ 不改变像素。
//
// ⚠ 仅在调用方显式要求时启用 (ext.clipNear): 官方 19 个 defaultprojects 里
// arsenal(generic) / demon_core(backgroundsphere) / ricepod(skybox 族) 也存在跨面
// 三角形 (scripts/tmp-3dsh-nearclip.mjs), 全局启用会改变这 3 个**与本任务无关**的
// 场景的像素 —— 验收要求"只有 techno/audiophile/fantasticcar 允许变化", 故本次把
// 裁剪限定在本任务新实现的自带着色器上。全域启用是后续工作 (见报告未决点)。
function clipNearPlane(indices, vp, sd, stride, wMin, W, H) {
  const outIdx = [];
  const outVp = [];
  const outSd = [];
  const cache = new Map();
  const wOf = (i) => vp[i * 6 + 2];
  const copyIn = (i) => {
    let k = cache.get(i);
    if (k !== undefined) return k;
    k = outVp.length / 6;
    for (let j = 0; j < 6; j++) outVp.push(vp[i * 6 + j]);
    for (let j = 0; j < stride; j++) outSd.push(sd[i * stride + j]);
    cache.set(i, k);
    return k;
  };
  const lerpIn = (ia, ib, t) => {
    const k = outVp.length / 6;
    const wa = wOf(ia), wb = wOf(ib);
    const w = wa + (wb - wa) * t;
    const iw = w || 1e-9;
    const ax = (vp[ia * 6] / W * 2 - 1) * wa, bx = (vp[ib * 6] / W * 2 - 1) * wb;
    const ay = (1 - vp[ia * 6 + 1] / H * 2) * wa, by = (1 - vp[ib * 6 + 1] / H * 2) * wb;
    const az = vp[ia * 6 + 3] * wa, bz = vp[ib * 6 + 3] * wb;
    const cx = ax + (bx - ax) * t, cy = ay + (by - ay) * t, cz = az + (bz - az) * t;
    const ndcX = cx / iw, ndcY = cy / iw, ndcZ = cz / iw;
    outVp.push((ndcX * 0.5 + 0.5) * W, (0.5 - ndcY * 0.5) * H, w, ndcZ,
      vp[ia * 6 + 4] + (vp[ib * 6 + 4] - vp[ia * 6 + 4]) * t,
      vp[ia * 6 + 5] + (vp[ib * 6 + 5] - vp[ia * 6 + 5]) * t);
    for (let j = 0; j < stride; j++) {
      const a = sd[ia * stride + j], b = sd[ib * stride + j];
      outSd.push(a + (b - a) * t);
    }
    return k;
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const poly = [indices[t], indices[t + 1], indices[t + 2]];
    const outPoly = [];
    for (let i = 0; i < 3; i++) {
      const cur = poly[i], nxt = poly[(i + 1) % 3];
      const wc = wOf(cur), wn = wOf(nxt);
      const inC = wc >= wMin, inN = wn >= wMin;
      if (inC) outPoly.push(copyIn(cur));
      if (inC !== inN) outPoly.push(lerpIn(cur, nxt, (wMin - wc) / (wn - wc)));
    }
    for (let i = 1; i + 1 < outPoly.length; i++) outIdx.push(outPoly[0], outPoly[i], outPoly[i + 1]);
  }
  const nVp = new Float64Array(outVp);
  const nSd = new Float64Array(outSd);
  return { indices: outIdx, vp: nVp, sd: nSd };
}

// ── model mixin (从 core.js 拆分, 逻辑零改动) ──
export function installModel(proto) {
  // 场景图 (_resolveObjects) 在 core.js 里仍有一份**旧副本** (scene/graph.js 的版本
  // 从未被 install ⇒ 死代码)。旧副本按 `o.id` 去重, 而官方手写 scene JSON
  // (techno.json / audiophile.json) 的 objects **没有 id** ⇒ 键全是 undefined
  // ⇒ 只有第一个对象进入 renderOrder (实测 techno: objects=4 → renderOrder=1,
  // 3 个对象永不渲染)。core.js 正被其它改动占用, 故在此 (类定义之后的 mixin 安装点)
  // 装回 graph.js 的修正版 —— 除去重键外与 core.js 副本逐行相同。
  installSceneGraph(proto);
  Object.assign(proto, {
    renderModel(o, t) {
        const mdlRaw = this.pkg.read(o.model);
        if (!mdlRaw) { this.log('跳过 model ' + (o.name || o.id) + ': 无 MDL'); return; }
        // MDL 静态网格解析缓存 (多帧渲染避免每帧重新解析)。键含 skin —— 多 skin 的
        // .mdl (audiophile models/grid/grid.mdl: 2 个材质串 + 1 个几何块) 同一模型
        // 不同 skin 会用不同材质 JSON, 不能共用一个缓存项。
        if (!this._mdlStaticCache) this._mdlStaticCache = new Map();
        const mkey = o.model + '#' + (o.skin ?? '');
        let mesh = this._mdlStaticCache.get(mkey);
        if (!mesh) {
          // 解析链: mdl.js 多子网格解析 → 本文件的兜底解析 (MDLV0023 AABB 块头 /
          // MDLV0004 多 skin 材质串) → puppet.js 旧单块副本兜底 (行为与从前一致)
          mesh = parseMdlStatic(mdlRaw) || this._parseMdlExtra(mdlRaw, o) || this._parseMdlStatic(mdlRaw);
          if (!mesh) { this.log('跳过 model ' + (o.name || o.id) + ': MDL 解析失败'); return; }
          this._mdlStaticCache.set(mkey, mesh);
        }
        // 对象变换 → 世界 (所有子网格共用同一个 g_ModelMatrix)
        const tr = this.resolveTransform(o);
        const worldM = mat4FromTRS(tr.origin, tr.angles || [tr.angleX || 0, tr.angleY || 0, tr.angleZ ?? tr.angle ?? 0], tr.scale);
        // 逐子网格渲染: **每块各有自己的材质 JSON / 纹理 / blending / depthwrite**,
        // 共享同一 worldM + camVP + z-buffer (不合并成一个大网格, 否则会用一个
        // 材质画完所有块 —— 官方 pistols.mdl 6 块 6 个材质, 合并就丢材质)。
        const subs = Array.isArray(mesh.submeshes) && mesh.submeshes.length ? mesh.submeshes : [mesh];
        for (const sm of subs) this._renderStaticSubmesh(sm, o, t, worldM);
      }
    ,
    // 单个静态子网格: 材质 → 顶点变换 + 逐顶点着色 → 光栅化
    // (原 renderModel 主体, 逐块调用; 单块时与改动前逐位一致)
    _renderStaticSubmesh(mesh, o, t, worldM) {
        // 材质 (容错读, 见 _readJsonLoose: 官方材质 JSON 允许 `//` 注释)
        const mat = mesh.materialPath ? this._readJsonLoose(mesh.materialPath) : null;
        const pass = mat && mat.passes && mat.passes[0] ? mat.passes[0] : null;
        const shaderName = pass ? pass.shader : 'generic3';
        const uniforms = this._materialUniforms(mat, pass);
        // textures 数组**可能整个缺失** (官方 fantasticcar/materials/dome/dome.json 与
        // util/shadow.json 都没有 textures 键)。旧写法 `pass && pass.textures[1]` 在
        // pass 有值而 textures 为 undefined 时抛 TypeError → 整个对象一个像素都不画
        // (实测 Dome/Shadow 均因此失败)。这里统一取安全数组。
        const texPaths = pass && Array.isArray(pass.textures) ? pass.textures : [];
        const textures = texPaths.map((p) => this.loadTexture(p));
        const tex = textures[0] || null;
        const tex1 = textures[1] || null;
        const tex2 = textures[2] || null;
        const tex3 = textures[3] || null;
        // 未实现的自定义着色器留痕 (缺陷 2): 未知 shader 落通用受光分支, 若场景
        // ambient/skylight 又恒为 0 且无灯 ⇒ 逐像素乘 0 = 静默全黑。官方壁纸的
        // 自定义 shader (ricepod 族/第三方) 多半自带光照或自发光, 通用分支并不等价。
        // 这里**只记降级**(onDegraded 通道, 生产由 scene-render-worker 落 gpu-diag),
        // 不改变任何像素 —— 未实现就是未实现, 不做没有源码依据的"提亮补丁"。
        if (shaderName && !isModelShaderImplemented(shaderName)) {
            degradedOnce(this, o, 'shader:' + shaderName,
                '未实现的自定义着色器 → 通用受光分支 (ambient/skylight 为 0 且无灯时输出纯黑)');
        }
        // ── 数据驱动材质通路 (顶点程序 + 片元程序, 全部来自壁纸文件) ──────────
        // 手写移植 (MODEL_SHADERS) 是快路径, 先于解释器; 其余材质 shader 不再落
        // "按名字手写 / 未知即通用回退", 而是直接编译容器里的 .vert/.frag。
        if (matInterpWanted(shaderName)) {            let prog = null;
            try {
                prog = this._bindMaterialInterpreter(mesh, o, shaderName, pass, uniforms, textures, t, worldM, texPaths);
            } catch (e) {
                prog = { ok: false, reason: 'GLSL 解释器绑定异常: ' + (e && e.message) };
            }
            if (prog && prog.ok) {
                // 诊断留痕 (生产不读; 供 scripts/tmp-glsl-mat-*.mjs 统计接手面)
                (this._matInterpUsed = this._matInterpUsed || []).push(shaderName + '|' + (mesh.materialPath || ''));
                this._drawSubmeshViaProgram(mesh, o, pass, shaderName, prog);
                return;
            }
            if (prog && prog.reason) {
                (this._matInterpFail = this._matInterpFail || []).push(shaderName + '|' + (mesh.materialPath || '') + '|' + prog.reason);
                // 可诊断留痕: 缺哪个语法点/attribute/uniform (生产由 onDegraded 落 gpu-diag)
                degradedOnce(this, o, 'shader:' + shaderName, '数据驱动解释器不可用 → 回退: ' + prog.reason);
            }
        }
        // 顶点变换 + 逐顶点着色 (worldM 由 renderModel 按对象算一次, 各子网格共用)
        const { positions, normals, uvs, uv2s, indices } = mesh;
        const n = positions.length;
        // 切线空间 (官方 generic.vert:63-69 / car.vert:29 BuildTangentSpace): 数据源是
        // MDL 顶点流里的 a_Tangent4。generic 族只有 stride 56 有取证 (行为不变);
        // car 族 (fantasticcar body.mdl 等) 是 stride 48, tangent 同样在 +24
        // (scripts/tmp-3dsh-tangent.mjs: |xyz| 单位 100%, |w|=1 100%, uv1@40 100% 在 [0,1])。
        const combos = (pass && pass.combos) || {};
        const useNormalMap = !!(combos.NORMALMAP || combos.normalmap);
        const wantTangent = useNormalMap && (shaderName === 'generic' || shaderName === 'car');
        const tangent = wantTangent
          ? this._meshTangent4(mesh, o, shaderName === 'car' ? [48, 56] : [56])
          : null;
        // 片元是否需要 TBN 块 (只有 generic 用它世界化切线法线; car 用 v_Var0/v_Var1 varying)
        const useTbnBlock = !!tangent && shaderName === 'generic';
        // 逐顶点 varying 数量 (无法用 UV 仿射表达的量 → 官方插值语义) 见 MODEL_VARYINGS
        const varCount = MODEL_VARYINGS[shaderName] || 0;
        const tanBase = useTbnBlock ? 8 : -1;
        const varBase = useTbnBlock ? 14 : 8;
        const SD = varBase + varCount; // 8 = normal(3)/world(3)/uv2(2); 14 = +tangent(3)+bitangent(3)
        const vp = new Float64Array(n * 6); // x,y,w(ndc), depth(ndc.z), u, v
        const shadeData = new Float64Array(n * SD); // normal(r,g,b), lightScale, worldX, worldY, uv2(u,v)
        const vs = { shaderName, uniforms, tex, tex1, tex2, tex3, textures, textureNames: texPaths, t, combos };
        // 无法线网格: 用位移后顶点重算平滑法线 (neongrid 等)
        let meshNormals = normals;
        const displaced = new Array(n);
        if (!normals[0]) {
          meshNormals = new Array(n).fill(null).map(() => [0, 0, 0]);
          for (let i = 0; i < n; i++) {
            displaced[i] = this._modelVertexLocal(shaderName, positions[i], uvs[i], t, uniforms, meshNormals[i]);
          }
          for (let k = 0; k + 2 < indices.length; k += 3) {
            const a = indices[k], b = indices[k + 1], c = indices[k + 2];
            const pa = displaced[a], pb = displaced[b], pc = displaced[c];
            const e1 = v3sub(pb, pa), e2 = v3sub(pc, pa);
            const fn = v3cross(e1, e2);
            meshNormals[a][0] += fn[0]; meshNormals[a][1] += fn[1]; meshNormals[a][2] += fn[2];
            meshNormals[b][0] += fn[0]; meshNormals[b][1] += fn[1]; meshNormals[b][2] += fn[2];
            meshNormals[c][0] += fn[0]; meshNormals[c][1] += fn[1]; meshNormals[c][2] += fn[2];
          }
          for (let i = 0; i < n; i++) meshNormals[i] = v3norm(meshNormals[i]);
        }
        for (let i = 0; i < n; i++) {
          const local = this._modelVertexLocal(shaderName, positions[i], uvs[i], t, uniforms, meshNormals[i]);
          let clip;
          if (shaderName === 'bg') {
            // bg.vert: gl_Position = vec4(uv*2-1, 0.5, 1) — 由 UV 生成, 忽略模型/相机
            clip = [uvs[i][0] * 2 - 1, uvs[i][1] * 2 - 1, 0.5, 1];
          } else if (shaderName === 'cloudsbg') {
            // cloudsbg.vert: gl_Position = vec4(a_Position, 1.0) — 网格位置即 clip 坐标
            clip = [local[0], local[1], 0.5, 1];
          } else if (EYE_CENTERED_SHADERS.has(shaderName)) {
            // 相机为原点: 官方 skybox.vert / ricepodorbitalaurora.vert /
            // ricepodorbitalthunder.vert 都是 `mul(vec4(a_Position + g_EyePosition,1), g_ViewProjectionMatrix)`
            // —— **不用 g_ModelMatrix**, 顶点在相机局部空间偏移后直接乘 VP。
            const wp = v3add(local, this.camEye || [0, 0, 0]);
            clip = mat4TransformPoint(this.camVP, wp);
            shadeData[i * SD + 3] = wp[0]; shadeData[i * SD + 4] = wp[1]; shadeData[i * SD + 5] = wp[2];
          } else if (NO_MODEL_MATRIX_SHADERS.has(shaderName)) {
            // grid.vert:21 —— gl_Position 只用 g_ViewProjectionMatrix (顶点已是世界坐标)
            clip = mat4TransformPoint(this.camVP, local);
            shadeData[i * SD + 3] = local[0]; shadeData[i * SD + 4] = local[1]; shadeData[i * SD + 5] = local[2];
          } else {
            const wp = mat4TransformPoint(worldM, local);
            clip = mat4TransformPoint(this.camVP, wp); // 已做透视除法: [ndcX, ndcY, ndcZ, w]
            shadeData[i * SD + 3] = wp[0]; shadeData[i * SD + 4] = wp[1]; shadeData[i * SD + 5] = wp[2];
          }
          const sx = (clip[0] * 0.5 + 0.5) * this.W;
          const sy = (0.5 - clip[1] * 0.5) * this.H;
          vp[i * 6] = sx; vp[i * 6 + 1] = sy; vp[i * 6 + 2] = clip[3]; vp[i * 6 + 3] = clip[2];
          vp[i * 6 + 4] = uvs[i][0]; vp[i * 6 + 5] = uvs[i][1];
          const srcN = meshNormals[i];
          const wn = srcN ? v3norm(mat4TransformVec3(worldM, srcN)) : [0, 0, 1];
          shadeData[i * SD] = wn[0]; shadeData[i * SD + 1] = wn[1]; shadeData[i * SD + 2] = wn[2];
          // 第 2 UV 通道 (lightmap) — 透视校正插值
          if (uv2s && uv2s[i]) {
            shadeData[i * SD + 6] = uv2s[i][0]; shadeData[i * SD + 7] = uv2s[i][1];
          }
          // 世界空间切线基 (官方 BuildTangentSpace: t=a_Tangent4.xyz, b=cross(n,t)*w,
          // 两者再过模型矩阵; 片元里把切线法线用 TBN 变回世界 —— 与官方"把光/视
          // 方向变换进切线空间再点乘"在正交基下恒等)
          if (tanBase >= 0) {
            const tw = v3norm(mat4TransformVec3(worldM, tangent.t[i]));
            const sw = tangent.w[i];
            const bw = v3norm(mat4TransformVec3(worldM, v3cross(srcN || [0, 0, 1], tangent.t[i])));
            shadeData[i * SD + tanBase] = tw[0]; shadeData[i * SD + tanBase + 1] = tw[1]; shadeData[i * SD + tanBase + 2] = tw[2];
            shadeData[i * SD + tanBase + 3] = bw[0] * sw; shadeData[i * SD + tanBase + 4] = bw[1] * sw; shadeData[i * SD + tanBase + 5] = bw[2] * sw;
          }
          // 逐顶点 varying (官方 .vert 里 nonlinear 的量): 用**未位移**的 a_Position /
          // a_Normal (官方 vert 拿到的就是原始 attribute), 见各 _*VertexVaryings
          if (varCount) {
            const vv = this._modelVertexVaryings(shaderName, positions[i], uvs[i], srcN, t, uniforms, {
              worldM, eye: this.camEye, combos, tangent, index: i,
            });
            for (let k = 0; k < varCount; k++) shadeData[i * SD + varBase + k] = vv[k];
          }
        }
        // 光栅化 (z-buffer + 透视校正插值 + 每像素 shader)
        const blending = pass ? (pass.blending || 'opaque') : 'opaque';
        // depthwrite 键名: 官方语料 91 处用 `depthwrite`(83 处 `depthtest`), 但 ricepod
        // 的 3 个轨道材质用 `depthwriting`/`depthtesting`(= "disabled", additive 发光层)。
        // 独立实现 linux-wallpaperengine 的 MaterialParser.cpp:50 只认 `depthwrite` 且
        // **缺省即 disabled**; 官方客户端显然也把这三个 additive 层按不写深度渲染 (否则
        // 半径 1 的相机中心环会写满 z 缓冲把飞船整块挡掉)。故两种拼写都接受 disabled。
        const depthWrite = !(pass && (pass.depthwrite === 'disabled' || pass.depthwriting === 'disabled'));
        // 近裁剪面: 官方相机 near (camera.js:_setupCameraMatrices 用 gen.nearz ?? 0.01)
        const gen = this.scene.general || {};
        const wMin = gen.nearz != null ? Number(gen.nearz) : 0.01;
        this._rasterizeMesh3D(indices, vp, shadeData, vs, blending, depthWrite, SD,
          { tanBase, varBase, varCount, clipNear: CUSTOM_3D_SHADERS.has(shaderName) || (CLIPNEAR_ALL && shaderName === 'generic'), wMin });
      }

      // ── 数据驱动材质通路: 绑定 / 绘制 ────────────────────────────────────
      // 绑定: 从容器读 shaders/<name>.{vert,frag} → 编译 → attribute/uniform/varying
      // 布局 → 合成输入预检。返回 { ok } 或 { ok:false, reason } (调用方记 degraded)。
      // a_Tangent4 只在官方 vert 声明了它时才取 (取不到即整条通路拒绝, 不做近似)。
,
    _bindMaterialInterpreter(mesh, o, shaderName, pass, uniforms, textures, t, worldM, texPaths) {
        // 顶点程序是否声明 a_Tangent4 → 需不需要从 MDL 顶点流取切线
        // (源码解析必须与解释器同一路径: 容器没有 shaders/ 时回退引擎资产目录)
        const src = readWallpaperShader(this.pkg, shaderName, this.weAssetsDir);
        const needTangent = !!(src.vert && /^[ \t]*attribute\s+\w+\s+a_Tangent4\s*;/m.test(src.vert));
        const needUv2 = !!(src.vert && /^[ \t]*attribute\s+\w+\s+a_TexCoordVec4\s*;/m.test(src.vert));
        // stride 56/48 两种官方布局都自校验 (pos/normal/uv1 逐位核对), 取不到返回 null
        const tangent = needTangent ? this._meshTangent4(mesh, o, [56, 48]) : null;
        // 第 2 UV 通道 (lightmap): parseMdlStatic 不填 uv2s ⇒ 从顶点流自校验提取
        const uv2 = needUv2 ? this._meshUV2(mesh, o) : null;
        return bindMaterialProgram(this, {
          shaderName, pass, textures, texturePaths: texPaths, t, worldM, tangent, mesh,
          uv2: uv2 || mesh.uv2s || null,
          constants: uniforms || {}, userValues: uniforms || {},
        });
      }
,
      // 绘制: 逐顶点跑官方 vert 程序 → vp(screen/w/depth/uv) + sd(varying 块) →
      // 既有光栅化器 (z-buffer / 透视校正插值 / blending / depthwrite 全部沿用)
    _drawSubmeshViaProgram(mesh, o, pass, shaderName, prog) {
        const positions = mesh.positions, normals = mesh.normals, uvs = mesh.uvs, indices = mesh.indices;
        const n = positions.length;
        const vc = prog.varyingCount;
        const SD = 8 + vc;
        const vp = new Float64Array(n * 6);
        const sd = new Float64Array(n * SD);
        for (let i = 0; i < n; i++) {
          const r = prog.runVertex(i);
          if (r.err) {
            degradedOnce(this, o, 'shader:' + shaderName, '顶点程序逐顶点执行失败 → 本对象不绘制: ' + r.err);
            return; // 尚未写入任何像素 (vp/sd 是本地缓冲) ⇒ 安全放弃
          }
          const c = r.clip;
          const iw = c[3] !== 0 ? 1 / c[3] : 0;
          vp[i * 6] = (c[0] * iw * 0.5 + 0.5) * this.W;
          vp[i * 6 + 1] = (0.5 - c[1] * iw * 0.5) * this.H;
          vp[i * 6 + 2] = c[3];
          vp[i * 6 + 3] = c[2] * iw;
          const uv = uvs[i];
          vp[i * 6 + 4] = uv ? uv[0] : 0;
          vp[i * 6 + 5] = uv ? uv[1] : 0;
          // 光栅化器自身要用法线做背面翻转 (backface two-sided lighting); 解释器的
          // 着色数学只读 varying, 不读这两个槽 —— 填顶点属性值即可 (非 NaN 且确定性)
          const srcN = normals[i] || [0, 0, 1];
          sd[i * SD] = srcN[0]; sd[i * SD + 1] = srcN[1]; sd[i * SD + 2] = srcN[2];
          const lp = positions[i];
          sd[i * SD + 3] = lp[0]; sd[i * SD + 4] = lp[1]; sd[i * SD + 5] = lp[2];
          prog.flushVaryings(sd, i * SD + 8);
        }
        const blending = pass ? (pass.blending || 'opaque') : 'opaque';
        const depthWrite = !(pass && (pass.depthwrite === 'disabled' || pass.depthwriting === 'disabled'));
        const gen = this.scene.general || {};
        const wMin = gen.nearz != null ? Number(gen.nearz) : 0.01;
        this._rasterizeMesh3D(indices, vp, sd, { shaderName }, blending, depthWrite, SD, {
          tanBase: -1, varBase: 8, varCount: vc,
          shadeFn: prog.shadeFn,
          // 顶点位置由官方 vert 程序给出 ⇒ 与 GPU 一样裁剪 w<near 的三角形
          // (诊断开关 DSH_WE_MAT_CLIPNEAR=0 可关, 用于消融)
          clipNear: MAT_INTERP_CLIPNEAR, wMin,
        });
      }
,
      // ── 数据驱动材质通路 (image 图层): 绑定 / 绘制 ─────────────────────────
      // image.js 的 renderImage 在自己的手写通道 (genericimage/swayimage/flag/retro/
      // _customShaders) 之外调用本方法; 顶点程序只在 4 个 quad 角求 varying, gl_Position
      // 由 image.js 既有的对象矩形几何给出 (那条几何已被逐角核对过官方 MVP 链)。
    _bindImageProgram(o, pass, shaderName, t, img) {
        const uvs4 = [[0, 0], [1, 0], [0, 1], [1, 1]];
        const mesh = {
          positions: [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]],
          normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]],
          uvs: uvs4, uv2s: uvs4, indices: [0, 2, 1, 2, 3, 1],
        };
        // 官方 image quad 是面向相机的平面 ⇒ 切线基 = (1,0,0,1); 只在 vert 声明时使用
        const src = readWallpaperShader(this.pkg, shaderName, this.weAssetsDir);
        const needTangent = !!(src.vert && /^[ \t]*attribute\s+\w+\s+a_Tangent4\s*;/m.test(src.vert));
        const tangent = needTangent ? { t: [[1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], w: [1, 1, 1, 1] } : null;
        // g_Texture0 = 本层效果链输出 (官方链输入语义); 槽 1.. 取自材质 textures[1..]
        const paths = (pass && pass.textures) || [];
        const textures = [img];
        for (let i = 1; i < Math.max(paths.length, 1); i++) textures.push(paths[i] ? this.loadTexture(paths[i]) : null);
        const constants = this._materialUniforms(o.passMat || null, pass);
        return bindMaterialProgram(this, {
          shaderName, pass, textures, t, worldM: null, tangent, mesh,
          constants, userValues: constants,
        });
      }
,
      // 纹理空间执行官方片元程序 (与 _genericImageApply 同一形态): 顶点程序只在 4 角
    // 求 varying, 片元逐 texel 采样 **效果链输出图**, 结果交给既有 blit/旋转/视差/混合。
    // 这样既走数据驱动, 又完整保留 image.js 的对象级绘制语义 (旋转/视差/colorBlend)。
    _applyImageProgram(img, o, shaderName, prog) {
        const w = img.width, h = img.height;
        const vc = prog.varyingCount;
        const corners = [];
        for (let i = 0; i < 4; i++) {
          const r = prog.runVertex(i);
          if (r.err) { this._matInterpDegrade(o, shaderName, '顶点程序逐角执行失败: ' + r.err); return null; }
          const c = new Float64Array(vc);
          prog.flushVaryings(c, 0);
          corners.push(c);
        }
        const out = new Uint8Array(w * h * 4);
        const vv = new Float64Array(vc);
        const c0 = corners[0], c1 = corners[1], c2 = corners[2], c3 = corners[3];
        for (let y = 0; y < h; y++) {
          const v = (y + 0.5) / h;
          for (let x = 0; x < w; x++) {
            const u = (x + 0.5) / w;
            // 4 角双线性 (与 executor.renderGlsl 的 varying 插值同一语义)
            for (let k = 0; k < vc; k++) {
              const top = c0[k] + (c1[k] - c0[k]) * u;
              const bot = c2[k] + (c3[k] - c2[k]) * u;
              vv[k] = top + (bot - top) * v;
            }
            const col = prog.shadeFn(u, v, [0, 0, 0], [0, 0, 1], this.camEye, u, v, u, v, null, vv);
            const di = (y * w + x) * 4;
            if (!col) { out[di + 3] = 0; continue; }
            for (let c = 0; c < 4; c++) out[di + c] = Math.round(col[c] * 255);
          }
        }
        return { width: w, height: h, rgba: out };
      }
,
    _imageShaderHandled(shaderName) {
        if (!shaderName) return true;
        if (this._customShaders.has(shaderName)) return true;
        return IMAGE_PORT_SHADERS.has(shaderName);
      }
,
    // (旧的 6 参 _bindImageProgram / _drawImageViaProgram 已删除 —— 对象字面量同名键
    //  会静默覆盖, 曾导致 shaderName 收到 mat 对象; 现只保留上面的 (o,pass,shaderName,t,img) 版)
      // 4 角跑官方顶点程序 → varying 块 → 既有光栅化器 (对象矩形几何由调用方给)
    _drawImageViaProgram(indices, vp, n, prog, blending, depthWrite, o, shaderName) {
        const vc = prog.varyingCount;
        const SD = 8 + vc;
        const sd = new Float64Array(n * SD);
        for (let i = 0; i < n; i++) {
          const r = prog.runVertex(i);
          if (r.err) {
            this._matInterpDegrade(o, shaderName, '顶点程序逐角执行失败 → 本图层不绘制: ' + r.err);
            return;
          }
          sd[i * SD] = 0; sd[i * SD + 1] = 0; sd[i * SD + 2] = 1;
          prog.flushVaryings(sd, i * SD + 8);
        }
        this._rasterizeMesh3D(indices, vp, sd, { shaderName }, blending, depthWrite, SD,
          { tanBase: -1, varBase: 8, varCount: vc, shadeFn: prog.shadeFn, clipNear: false });
      }
,
    _matInterpDegrade(o, shaderName, action) {
        (this._matInterpFail = this._matInterpFail || []).push(shaderName + '|' + (o && o.name ? o.name : '') + '|' + action);
        degradedOnce(this, o, 'shader:' + shaderName, action);
      }
,
      // 顶点位移统一入口 (两处顶点循环共用; 未列出的 shader 原样返回)
    _modelVertexLocal(shaderName, local, uv, t, uniforms, normal) {
        if (shaderName === 'core') return this._coreVertex(local, uv, t);
        if (shaderName === 'dna') return this._dnaVertex(local, t);
        if (shaderName === 'neongrid') return this._neonGridVertex(local, uv, t, uniforms.mountainscale ?? 1);
        if (shaderName === 'ricepodjet') return this._ricepodJetVertex(local, uv, t);
        if (shaderName === 'ricepodorbitalaurora') return this._auroraVertex(local, uv, t);
        // 官方 audiophile.vert:25-27 —— 频谱驱动的竖条高度 (无音频输入时 audio=0)
        if (shaderName === 'audiophile') {
          const audio = this._audioSpectrumAt(uv[0], local[0]);
          const y = local[1] * audio;
          return [local[0], y + (local[1] - y) * uv[1], local[2]];
        }
        // 官方 audiophileflow.vert:18-20 —— 正弦扰动顶点
        if (shaderName === 'audiophileflow') {
          return [
            local[0] + Math.sin(local[1] + t * 0.1) * 0.1,
            local[1] + Math.cos(local[0] + t * 0.05) * 0.1,
            local[2],
          ];
        }
        // 官方 audiophileglow.vert:17-19 —— xy 按频谱缩放 (无音频输入时 audio=0 ⇒ 退化)
        if (shaderName === 'audiophileglow') {
          const audio = Math.min(1, this._audioBin(0)[0]);
          return [local[0] * audio, local[1] * audio, local[2]];
        }
        return local;
      }

      // 逐顶点 varying (官方 .vert 里写入 varying 的 nonlinear 部分)。
      // 只在这里算 —— 片元里凡是能用 UV 仿射表达的 (technoglow/technoorbit/dome/
      // shadow/audiophileflow/grid 的 UV 变换) 一律按官方等式在片元重算, 不做插值。
,
    _modelVertexVaryings(shaderName, attrPos, uv, attrN, t, uniforms, ctx) {
        const n = attrN || [0, 0, 1];
        const eye = (ctx && ctx.eye) || [0, 0, 0];
        // technohex.vert:20-26 —— v_Dot = pow(dot·0.5+0.5,4)·|dot|·12, dot = dot(eyeDir, a_Normal)
        if (shaderName === 'technohex') {
          const eyeDir = v3norm(v3sub(eye, attrPos));
          const dp = v3dot(eyeDir, n);
          let d = dp * 0.5 + 0.5;
          d = Math.pow(d, 4);
          d *= Math.abs(dp);
          return [d * 12];
        }
        // audiophile.vert:15-30 —— color = g_Tint · min(1, audio·0.8+0.2) · max(0, dot(a_Normal, (0,.707,.707))·.5+.5)
        if (shaderName === 'audiophile') {
          const tint = uniforms.tint || [1, 1, 1];
          const audio = this._audioSpectrumAt(uv[0], attrPos[0]);
          const k = Math.min(1, audio * 0.8 + 0.2);
          const nd = Math.max(0, v3dot(n, [0, 0.707, 0.707]) * 0.5 + 0.5);
          return [tint[0] * k * nd, tint[1] * k * nd, tint[2] * k * nd];
        }
        // car.vert:20-35 —— v_Var0/v_Var1
        //   NORMALMAP: 世界化切线基三列 (BuildTangentSpace, common_vertex.h:8-15) 上的光/视方向
        //   否则:      v_Var0 = 世界法线, v_Var1 = lightDir + viewDir (未归一化)
        if (shaderName === 'car') {
          const worldM = ctx && ctx.worldM;
          const wp = worldM ? mat4TransformPoint(worldM, attrPos) : attrPos;
          const L = LIGHT_DIR_111;
          const viewDir = v3sub(eye, wp); // car.vert:26 (未归一化)
          const useNM = !!(ctx && ctx.combos && (ctx.combos.NORMALMAP || ctx.combos.normalmap));
          if (useNM && ctx.tangent) {
            const i = ctx.index;
            const T = v3norm(mat4TransformVec3(worldM, ctx.tangent.t[i]));
            const B = v3norm(mat4TransformVec3(worldM, v3cross(n, ctx.tangent.t[i]))).map((x) => x * ctx.tangent.w[i]);
            const N = v3norm(mat4TransformVec3(worldM, n));
            return [
              v3dot(T, L), v3dot(B, L), v3dot(N, L),
              v3dot(T, viewDir), v3dot(B, viewDir), v3dot(N, viewDir),
            ];
          }
          const wn = worldM ? mat4TransformVec3(worldM, n) : n;
          return [wn[0], wn[1], wn[2], L[0] + viewDir[0], L[1] + viewDir[1], L[2] + viewDir[2]];
        }
        // grid.vert:22-27 —— v_WorldPosition = a_Position.xz; v_HalfDir = lightDir + viewDir
        if (shaderName === 'grid') {
          const wx = attrPos[0], wz = attrPos[2];
          const viewDir = v3norm(v3sub(eye, [wx, 0, wz]));
          return [wx, wz, LIGHT_DIR_111[0] + viewDir[0], LIGHT_DIR_111[1] + viewDir[1], LIGHT_DIR_111[2] + viewDir[2]];
        }
        return [];
      }

      // 音频频谱 (引擎 g_AudioSpectrum16Left/Right): 渲染器未注入音频时**恒为 0**
      // (官方 uniform 语义 = 当前音量包络, 静音即 0; 这里不做任何"默认值填充")。
,
    _audioBin(i) {
        const s = this.audioSpectrum;
        if (!s) return [0, 0];
        const L = s.left || s.left16 || [];
        const R = s.right || s.right16 || [];
        return [L[i] || 0, R[i] || 0];
      }

      // 官方 audiophile.vert:17-23 —— 由 a_TexCoord.x 查 16 段频谱并取左右声道
,
    _audioSpectrumAt(uvx, posx) {
        const i0 = Math.trunc(uvx * 16 + 0.01);
        const i1 = Math.trunc(uvx * 16 + 0.51);
        const a = this._audioBin(i0), b = this._audioBin(i1);
        const left = a[0] + b[0];
        const right = a[1] + b[1];
        // mix(audioLeft, audioRight, step(0, a_Position.x)) — step 结果只有 0/1
        const audio = posx >= 0 ? right : left;
        return sat(audio * 0.5);
      }

      // 材质 JSON 容错读: 官方材质文件允许 `//` 行注释
      // (fantasticcar/materials/car/glass.json:6 就是 `//"cullmode": "nocull",`),
      // 官方客户端能解析; pkg.readJson 走严格 JSON.parse ⇒ 抛错 ⇒ 该对象后续子网格
      // 全部丢失 (Car 的 glass/interior/matte/taillights/wheel 5 块不渲染)。
      // 只剥注释 (字符串字面量内的 // 不动), 不改变任何合法 JSON 的解析结果。
,
    _readJsonLoose(p) {
        try {
          const txt = this.pkg.readText ? this.pkg.readText(p) : null;
          if (txt == null) return this.pkg.readJson(p);
          return JSON.parse(stripJsonComments(txt));
        } catch {
          try { return this.pkg.readJson(p); } catch { return null; }
        }
      }

      // ── MDL 兜底解析: mdl.js (被其它改动占用) 尚未支持的两种块头 ──
      // 只在 parseMdlStatic 失败时调用 ⇒ 对当前能解析的文件**零影响**。
      // 官方格式依据: _refs/linux-wallpaperengine/docs/rendering/MDL_FILES.md
      //   MDLVHEADER { CHAR header[]; DWORD first, second, third; CHAR json[];
      //                DWORD fourth, fifth, vertexByteLength; VERTEX[]; DWORD idx; u16[] }
      // 实测的两种变体 (scripts/tmp-3dsh-mdlscan.mjs / tmp-3dsh-tangent.mjs):
      //   A) MDLV0023: 材质串 NUL 后多了 **AABB(6 float) + u32(9)** 共 28 字节 ⇒ 顶点流
      //      起点 = matNul + 37。判据: 头里的 AABB 必须与「按 stride 20 解析出的顶点包围盒」
      //      逐分量相等 (techno glow/orbitsmall/rays 三个文件 100% 相等, 见取证脚本)。
      //   B) 多 skin 模型 (MDLV0004): **连续 N 个材质串** (skin 0..N-1) 之后才是一个几何块
      //      ⇒ 顶点流起点 = 最后一个材质串 NUL + 9, 材质取 matPaths[skin]
      //      (audiophile models/grid/grid.mdl: 2 串 grid.json/grid2.json, 场景 skin:1)。
      // 另: MDLV0023 的 orbitsmall.mdl 是**多子网格链** (4 个材质串, 每串后跟自己的几何块),
      //      与 MDLV0014 一样按链解析 → submeshes 各自带材质。
,
    _parseMdlExtra(buf, o) {
        try {
          if (!buf || buf.length < 32 || buf.toString('ascii', 0, 4) !== 'MDLV') return null;
          const ver = buf.toString('ascii', 0, 8);
          const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
          // 收集全部材质串
          const mats = [];
          for (let at = 8; at < buf.length; ) {
            const i = buf.indexOf('materials/', at, 'utf8');
            if (i < 0) break;
            let e = i;
            while (e < buf.length && buf[e] !== 0) e++;
            mats.push({ start: i, end: e, path: buf.toString('utf8', i, e) });
            at = e + 1;
          }
          if (!mats.length) return null;
          const deltas = ver === 'MDLV0023' ? [37] : [9, 37];
          // 只接受**有实证的**引擎顶点布局 (官方 generic/ricepod/car 顶点流实测):
          //   20 = pos(3f)+uv1(2f) | 32 = +normal(3f) | 48 = +tangent4 | 56 = +uv2 | 64
          // 不猜 16/24/28/40/44 (旧副本里的猜测项) —— 它们会与 20 同时"通过"索引自检
          // 而在无 AABB 校验的 MDLV0004/0014 上给出错位顶点。
          const LAYOUTS = [64, 56, 48, 32, 20];
          // 解析 mat 之后的几何块 (delta 字节块头); 自检: 索引全量 < vc 且文件尾对齐
          const blockAt = (mat, delta) => {
            const vertStart = mat.end + delta;
            if (vertStart - 4 < 0 || vertStart + 4 > buf.length) return null;
            const vertBytes = dv.getUint32(vertStart - 4, true);
            if (vertBytes <= 0 || vertStart + vertBytes + 4 > buf.length) return null;
            const idxPos = vertStart + vertBytes;
            const idxBytes = dv.getUint32(idxPos, true);
            if (idxBytes <= 0 || idxBytes % 6 !== 0) return null;
            const idxStart = idxPos + 4;
            if (idxStart + idxBytes > buf.length) return null;
            const ic = idxBytes / 2;
            // 先求索引上界, 再据此淘汰"stride 猜大了"的布局 (vc 必须 > maxIdx 且贴合)
            let maxIdx = 0;
            for (let k = 0; k < ic; k++) {
              const id = dv.getUint16(idxStart + k * 2, true);
              if (id > maxIdx) maxIdx = id;
            }
            for (const stride of LAYOUTS) {
              if (vertBytes % stride !== 0) continue;
              const vc = vertBytes / stride;
              if (vc < 3 || vc > 200000) continue;
              if (maxIdx >= vc) continue;
              // 索引必须用满顶点 (否则 stride 猜大了): 允许最后 2 个顶点不被引用
              if (maxIdx < vc - 3) continue;
              const positions = [], normals = [], uvs = [], uv2s = [];
              const hasN = stride !== 20;
              const uvOff = stride === 64 ? 36 : stride - 8;
              const uv2Off = stride === 56 ? stride - 16 : -1;
              let finite = true;
              for (let i = 0; i < vc; i++) {
                const off = vertStart + i * stride;
                const p = [dv.getFloat32(off, true), dv.getFloat32(off + 4, true), dv.getFloat32(off + 8, true)];
                if (!isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]) || Math.abs(p[0]) > 1e5 || Math.abs(p[1]) > 1e5 || Math.abs(p[2]) > 1e5) { finite = false; break; }
                positions.push(p);
                normals.push(hasN ? [dv.getFloat32(off + 12, true), dv.getFloat32(off + 16, true), dv.getFloat32(off + 20, true)] : null);
                uvs.push([dv.getFloat32(off + uvOff, true), dv.getFloat32(off + uvOff + 4, true)]);
                uv2s.push(uv2Off >= 0 ? [dv.getFloat32(off + uv2Off, true), dv.getFloat32(off + uv2Off + 4, true)] : null);
              }
              if (!finite) continue;
              // MDLV0023: 块头 AABB 必须与顶点包围盒逐分量相等 (强判据, 由官方写文件时生成)
              if (ver === 'MDLV0023') {
                const aabb = [];
                for (let k = 0; k < 6; k++) aabb.push(dv.getFloat32(vertStart - 32 + k * 4, true));
                const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
                for (const p of positions) {
                  for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k]; }
                }
                const box = [mn[0], mn[1], mn[2], mx[0], mx[1], mx[2]];
                let boxOk = true;
                for (let k = 0; k < 6; k++) {
                  if (!isFinite(aabb[k]) || Math.abs(aabb[k] - box[k]) > 1e-3 * Math.max(1, Math.abs(box[k]))) { boxOk = false; break; }
                }
                if (!boxOk) continue;
              }
              const indices = [];
              for (let k = 0; k < ic; k++) indices.push(dv.getUint16(idxStart + k * 2, true));
              return {
                mesh: { positions, normals, uvs, uv2s, indices, materialPath: mat.path, stride, vertexCount: vc, indexCount: indices.length },
                end: idxStart + idxBytes,
              };
            }
            return null;
          };
          // ① 多子网格链: 每个材质串后都有合法几何块 (单串文件也走这里)
          const chain = [];
          let chainOk = true;
          for (const m of mats) {
            const b = blockAt(m, deltas[0]);
            if (!b) { chainOk = false; break; }
            chain.push(b);
          }
          // 链自检: 末块必须落在文件尾 (允许 ≤8 字节尾垫); 多块时块间衔接紧密
          if (chainOk) {
            const tail = buf.length - chain[chain.length - 1].end;
            if (tail >= 0 && tail <= 8) {
              const single = { ...chain[0].mesh, submeshes: chain.map((c) => c.mesh) };
              if (chain.length === 1) return single;
              const skin = Math.max(0, Math.min(chain.length - 1, (o && o.skin) | 0));
              return { ...single, materialPath: chain[skin].mesh.materialPath };
            }
          }
          // ② 多 skin (材质串列表 + 唯一的几何块): 几何块跟在**最后一个**材质串之后
          for (let d = 0; d < deltas.length; d++) {
            const b = blockAt(mats[mats.length - 1], deltas[d]);
            if (!b) continue;
            const tail = buf.length - b.end;
            if (tail < 0 || tail > 8) continue;
            const skin = Math.max(0, Math.min(mats.length - 1, (o && o.skin) | 0));
            const mesh = { ...b.mesh, materialPath: mats[skin].path };
            return { ...mesh, submeshes: [mesh] };
          }
          return null;
        } catch { return null; }
      }

      // ── a_Tangent4 提取 (官方 generic.vert:20/64 / car.vert:12 的 attribute vec4 a_Tangent4) ──
      // MDL 顶点流布局 (实测: |xyz|=1.0000、|w|=1.0000 100% 命中):
      //   stride 56: +0 pos(3f) +12 normal(3f) +24 **tangent(4f)** +40 uv2(2f) +48 uv1(2f)
      //   stride 48: +0 pos(3f) +12 normal(3f) +24 **tangent(4f)** +40 uv1(2f)
      //     (fantasticcar models/car/body.mdl: scripts/tmp-3dsh-tangent.mjs →
      //      @24 |xyz| 单位 100.0%、|w|≈1 100.0%、uv@40 100% 落在 [0,1])
      // mdl.js (被其它改动占用) 只暴露 pos/normal/uv1/uv2, 故这里独立定位顶点流:
      //   块起点 = 材质路径后的 NUL + 9 (与 mdl.js:79 `vertStart = matEnd + 9` 同一算式),
      //   并**逐顶点核对** pos/normal/uv1 与已解析网格逐位相等才采用 (自校验, 不容错)。
      // `strides` 由调用方给出 —— generic 族只允许 56 (行为与从前逐位一致),
      // car 族额外允许 48。缓存按 stride 集合分键, 避免同一网格两种布局互相污染。
      // 任一步不符 → 返回 null ⇒ 该网格的 NORMALMAP 保持旧行为 (无切线数据), 由调用方记 degraded。
,
    _meshTangent4(mesh, o, strides) {
        const allow = strides || [56];
        const key = 'tg:' + allow.join(',');
        try {
          if (!mesh || !allow.includes(mesh.stride) || !mesh.positions || !mesh.positions.length) return null;
          if (!mesh._tangent4ByKey) mesh._tangent4ByKey = new Map();
          if (mesh._tangent4ByKey.has(key)) return mesh._tangent4ByKey.get(key);
          const raw = this.pkg && o && o.model ? this.pkg.read(o.model) : null;
          if (!raw) { mesh._tangent4ByKey.set(key, null); return null; }
          const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const stride = mesh.stride;
          const vc = mesh.vertexCount || mesh.positions.length;
          const path = mesh.materialPath || '';
          const verifyN = Math.min(8, vc);
          let found = null;
          for (let from = 8; ; ) {
            const at = indexOfBytes(raw, path, from);
            if (at < 0) break;
            from = at + 1;
            const matEnd = at + Buffer.byteLength(path, 'utf8');
            if (matEnd >= raw.length || raw[matEnd] !== 0) continue;
            if (dv.getUint32(matEnd + 5, true) !== stride * vc) continue; // vertBytes 必须自洽
            const vertStart = matEnd + 9;
            if (vertStart + stride * vc > raw.length) continue;
            let ok = 0;
            for (let i = 0; i < verifyN; i++) {
              const off = vertStart + i * stride;
              const p = mesh.positions[i], nn = mesh.normals[i], uv = mesh.uvs[i];
              const eq = (a, b) => Math.abs(a - b) < 1e-6;
              if (!p || !nn || !uv) break;
              if (eq(dv.getFloat32(off, true), p[0]) && eq(dv.getFloat32(off + 4, true), p[1]) && eq(dv.getFloat32(off + 8, true), p[2])
                && eq(dv.getFloat32(off + 12, true), nn[0]) && eq(dv.getFloat32(off + 16, true), nn[1]) && eq(dv.getFloat32(off + 20, true), nn[2])
                && eq(dv.getFloat32(off + stride - 8, true), uv[0]) && eq(dv.getFloat32(off + stride - 4, true), uv[1])) ok++;
            }
            if (ok === verifyN) { found = vertStart; break; }
          }
          if (found == null) { mesh._tangent4ByKey.set(key, null); return null; }
          // 取 tangent.xyz + tangent.w, 并做单位性抽检 (不达标即整体放弃)
          const t = new Array(vc), w = new Array(vc);
          let unitOk = 0, wOk = 0;
          const step = Math.max(1, Math.floor(vc / 200));
          let sampled = 0;
          for (let i = 0; i < vc; i++) {
            const off = found + i * stride + 24;
            const x = dv.getFloat32(off, true), y = dv.getFloat32(off + 4, true), z = dv.getFloat32(off + 8, true), sw = dv.getFloat32(off + 12, true);
            t[i] = [x, y, z]; w[i] = sw;
            if (i % step === 0) {
              sampled++;
              const L = Math.sqrt(x * x + y * y + z * z);
              if (Math.abs(L - 1) < 0.05) unitOk++;
              if (Math.abs(Math.abs(sw) - 1) < 0.05) wOk++;
            }
          }
          if (sampled === 0 || unitOk < sampled * 0.9 || wOk < sampled * 0.9) {
            mesh._tangent4ByKey.set(key, null);
            degradedOnce(this, o, 'tangent:unverified', 'a_Tangent4 单位性抽检未通过 → NORMALMAP 退回旧行为 (切线空间未生效)');
            return null;
          }
          const out = { t, w };
          mesh._tangent4ByKey.set(key, out);
          if (stride === 56) mesh._tangent4 = out; // 兼容旧字段 (stride 56 路径)
          return out;
        } catch { return null; }
      }
    
      // ── 第 2 UV 通道 (lightmap UV) 自校验提取 ─────────────────────────────
      // 事实 (本轮取证): `parseMdlStatic` (mdl.js) **不填** uv2s —— 实测
      // arsenal/models/pistols/pistols.mdl 的 6 个子网格 `uv2s` 全是 null; 而它又是
      // renderModel 的首选解析器 (`_parseMdlExtra` 只在它失败时才跑) ⇒ 真实渲染里
      // `mesh.uv2s` = [null…]。官方 `generic.vert` 在 LIGHTMAP combo 下把
      // `a_TexCoordVec4` 整体写进 `v_TexCoord`, 片元用 `.zw` 采光照片 ⇒ zw=0 时
      // 光照片按 (0,0) 取样 (该处是黑的) ⇒ **整条漫反射被乘 0**。这是 Arsenal 全帧均值
      // 从 51.3 掉到 5.6 的直接成因 (逐项归因见 .test-cache/fix-glsl-materials.md §10)。
      // 取法与 `_meshTangent4` 完全同款 (自校验, 不容错): 定位顶点流 → pos/normal/uv1
      // 逐位核对 → 读 +40 的两分量, 并抽检"不是整块全 0"。
      // 布局依据 (与 _meshTangent4 同一取证): stride 56 = pos@0 normal@12 tangent4@24
      // **uv2@40** uv1@48; stride 48 无 uv2 (只有 uv1@40) ⇒ 只处理 stride 56。
,    
    _meshUV2(mesh, o) {
        try {
          if (!mesh || mesh.stride !== 56 || !mesh.positions || !mesh.positions.length) return null;
          if (mesh._uv2State === 'none') return null;
          if (mesh._uv2State === 'ok') return mesh._uv2;
          const raw = this.pkg && o && o.model ? this.pkg.read(o.model) : null;
          if (!raw) return null;
          const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const stride = mesh.stride;
          const vc = mesh.vertexCount || mesh.positions.length;
          const path = mesh.materialPath || '';
          const verifyN = Math.min(8, vc);
          let found = null;
          for (let from = 8; ; ) {
            const at = indexOfBytes(raw, path, from);
            if (at < 0) break;
            from = at + 1;
            const matEnd = at + Buffer.byteLength(path, 'utf8');
            if (matEnd >= raw.length || raw[matEnd] !== 0) continue;
            if (dv.getUint32(matEnd + 5, true) !== stride * vc) continue;
            const vertStart = matEnd + 9;
            if (vertStart + stride * vc > raw.length) continue;
            let ok = 0;
            for (let i = 0; i < verifyN; i++) {
              const off = vertStart + i * stride;
              const p = mesh.positions[i], nn = mesh.normals[i], uv = mesh.uvs[i];
              const eq = (a, b) => Math.abs(a - b) < 1e-6;
              if (!p || !nn || !uv) break;
              if (eq(dv.getFloat32(off, true), p[0]) && eq(dv.getFloat32(off + 4, true), p[1]) && eq(dv.getFloat32(off + 8, true), p[2])
                && eq(dv.getFloat32(off + 12, true), nn[0]) && eq(dv.getFloat32(off + 16, true), nn[1]) && eq(dv.getFloat32(off + 20, true), nn[2])
                && eq(dv.getFloat32(off + stride - 8, true), uv[0]) && eq(dv.getFloat32(off + stride - 4, true), uv[1])) ok++;
            }
            if (ok === verifyN) { found = vertStart; break; }
          }
          if (found == null) { mesh._uv2State = 'none'; return null; }
          const out = new Array(vc);
          let nonZero = 0;
          for (let i = 0; i < vc; i++) {
            const off = found + i * stride + 40;
            const u = dv.getFloat32(off, true), v = dv.getFloat32(off + 4, true);
            out[i] = [u, v];
            if (u !== 0 || v !== 0) nonZero++;
          }
          // 整块全 0 ⇒ 该模型确实没有 lightmap 通道 (保持旧行为, 不伪造)
          if (!nonZero) { mesh._uv2State = 'none'; return null; }
          mesh._uv2 = out; mesh._uv2State = 'ok';
          return out;
        } catch { return null; }
      }
    
      // core.vert 顶点位移 (audio=0, g_Time=t): localPos += localPos * step(0,uv.x) * anims.y * 0.5
,
    _coreVertex(local, uv, t) {
        const period = Math.PI * 4;
        const a = t * 0.4, cs = Math.cos(a), sn = Math.sin(a);
        const rx = cs * uv[0] - sn * uv[1], ry = sn * uv[0] + cs * uv[1];
        const animsY = sat(Math.sin((rx + ry) * period + t));
        const stepX = uv[0] >= 0 ? 1 : 0;
        return [local[0] + local[0] * stepX * animsY * 0.5, local[1] + local[1] * stepX * animsY * 0.5, local[2] + local[2] * stepX * animsY * 0.5];
      }
    
      // dna.vert: y 偏移 + xz 旋转 (螺旋动画)
      // ★ 官方 dna.vert:27 的角度字面量是 `3.1416` (不是 M_PI): 用 Math.PI 会带来
      //   |Δrot| = 7.35e-6 rad ⇒ 顶点位移最大 3.67e-7 (oracle 实测; 对 float32 管线
      //   是舍入级, 但"逐行直译"要求照抄字面量)。
,
    _dnaVertex(local, t) {
        const timeOffset = (t * 0.1) % 1;
        const y = local[1] + timeOffset * 0.5;
        const rot = timeOffset * 3.1416;
        const c = Math.cos(rot), s = Math.sin(rot);
        return [local[0] * c - local[2] * s, y, local[0] * s + local[2] * c];
      }
    
      // neongrid.vert: fbm 山体位移 (完全照搬 shader 数学)
,
    _neonGridVertex(local, uv, t, mountainScale) {
        const fract = (x) => x - Math.floor(x);
        const rand = (n0, n1) => {
          const d = n0 * 12.9898 + n1 * 4.1414;
          return fract(Math.sin(d) * 43758.5453);
        };
        const noise2 = (px, py) => {
          const ipx = Math.floor(px), ipy = Math.floor(py);
          let ux = px - ipx, uy = py - ipy;
          ux = ux * ux * (3 - 2 * ux);
          uy = uy * uy * (3 - 2 * uy);
          const a = rand(ipx, ipy) + (rand(ipx + 1, ipy) - rand(ipx, ipy)) * ux;
          const b = rand(ipx, ipy + 1) + (rand(ipx + 1, ipy + 1) - rand(ipx, ipy + 1)) * ux;
          const res = a + (b - a) * uy;
          return res * res;
        };
        const fbm = (x0, y0) => {
          let v = 0, a = 0.5, px = x0, py = y0;
          const c = Math.cos(0.5), s = Math.sin(0.5);
          for (let i = 0; i < 5; i++) {
            v += a * noise2(px, py);
            const nx = (c * px - s * py) * 2 + 100;
            const ny = (s * px + c * py) * 2 + 100;
            px = nx; py = ny;
            a *= 0.5;
          }
          return v;
        };
        const speed = t * 2;
        const gridPosX = Math.floor(uv[0] * 50);
        const gridPosY = Math.floor(uv[1] * 50 + speed);
        const dampenDistance = Math.abs(uv[0] * 2 - 1);
        const fallOffSides = Math.pow(1.05 - dampenDistance, 0.5);
        const fallOffCenter = 0.2 + 0.8 * Math.pow(dampenDistance, 2);
        const speedFrac = fract(speed) / 50;
        const dampenY = uv[1] - speedFrac;
        const clipCenter = sat(0.8 - dampenDistance);
        const ms = mountainScale != null ? mountainScale : 1;
        let offsetY = Math.max(0, fbm(gridPosX * 0.1, gridPosY * 0.1) * 2 - clipCenter) * fallOffCenter * ms;
        offsetY = offsetY * fallOffSides * dampenY + Math.pow(dampenDistance, 2) * 0.02;
        return [local[0], local[1] + offsetY, local[2] - speedFrac * 2];
      }
    
      // ── 3D 光栅化: 透视校正 UV/法线/世界坐标 + z-buffer + 每像素 CPU shader ──
,
    _rasterizeMesh3D(indices, vp, sd, vs, blending, depthWrite = true, sdStride = 8, ext = null) {
        const W = this.W, H = this.H;
        const canvas = this.canvas;
        const zbuf = canvas.zbuf;
        // 近裁剪面裁剪 (仅本轮新实现的自带着色器, 见 clipNearPlane 注释)
        if (ext && ext.clipNear) {
          const cl = clipNearPlane(indices, vp, sd, sdStride, ext.wMin > 0 ? ext.wMin : 0.01, W, H);
          indices = cl.indices; vp = cl.vp; sd = cl.sd;
        }
        const shade = (ext && ext.shadeFn) || this._makeShadeFn(vs);
        // 切线块 / 自定义 varying 块的位置由调用方显式给出 (不能再用 sdStride>=14 判定:
        // 自带着色器的 varying 也会把 stride 撑到 14 以上)
        const tanBase = ext && ext.tanBase != null ? ext.tanBase : (sdStride >= 14 ? 8 : -1);
        const varBase = ext && ext.varBase != null ? ext.varBase : -1;
        const varCount = (ext && ext.varCount) || 0;
        const varOut = varCount ? new Float64Array(varCount) : null;
        for (let tIdx = 0; tIdx + 2 < indices.length; tIdx += 3) {
          // vp 每顶点 6 值, sd 每顶点 sdStride 值 — 分开索引
          const vi0 = indices[tIdx] * 6, vi1 = indices[tIdx + 1] * 6, vi2 = indices[tIdx + 2] * 6;
          const i0 = indices[tIdx] * sdStride, i1 = indices[tIdx + 1] * sdStride, i2 = indices[tIdx + 2] * sdStride;
          const x0 = vp[vi0], y0 = vp[vi0 + 1], w0 = vp[vi0 + 2], d0 = vp[vi0 + 3], u0 = vp[vi0 + 4], v0 = vp[vi0 + 5];
          const x1 = vp[vi1], y1 = vp[vi1 + 1], w1 = vp[vi1 + 2], d1 = vp[vi1 + 3], u1 = vp[vi1 + 4], v1 = vp[vi1 + 5];
          const x2 = vp[vi2], y2 = vp[vi2 + 1], w2 = vp[vi2 + 2], d2 = vp[vi2 + 3], u2 = vp[vi2 + 4], v2 = vp[vi2 + 5];
          // 双面渲染: 不按绕序剔除 (不同模型文件绕序约定不一致, 且引擎对无 cullmode
          // 材质默认不剔除); 背面三角的法线翻转以保证光照方向正确 (two-sided lighting)
          const e1x = x1 - x0, e1y = y1 - y0, e2x = x2 - x0, e2y = y2 - y0;
          const cross = e1x * e2y - e1y * e2x;
          if (Math.abs(cross) < 1e-9) continue;
          const backface = cross < 0;
          const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
          const bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
          const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
          const by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
          if (bx1 < bx0 || by1 < by0) continue;
          // 顶点着色属性 (法线/世界坐标) 用于透视校正插值
          for (let py = by0; py <= by1; py++) {
            for (let px = bx0; px <= bx1; px++) {
              const pxc = px + 0.5, pyc = py + 0.5;
              const la = ((x1 - pxc) * (y2 - pyc) - (y1 - pyc) * (x2 - pxc)) / cross;
              const lb = ((x2 - pxc) * (y0 - pyc) - (y2 - pyc) * (x0 - pxc)) / cross;
              const lc = ((x0 - pxc) * (y1 - pyc) - (y0 - pyc) * (x1 - pxc)) / cross;
              if (la < -1e-4 || lb < -1e-4 || lc < -1e-4) continue;
              // 透视校正: 插值 1/w, u/w, v/w
              const iw0 = 1 / w0, iw1 = 1 / w1, iw2 = 1 / w2;
              const iw = la * iw0 + lb * iw1 + lc * iw2;
              const u = (la * u0 * iw0 + lb * u1 * iw1 + lc * u2 * iw2) / iw;
              const v = (la * v0 * iw0 + lb * v1 * iw1 + lc * v2 * iw2) / iw;
              const depth = la * d0 + lb * d1 + lc * d2;
              const di = py * W + px;
              if (depth >= zbuf[di]) continue;
              // 插值法线/世界坐标
              // ⚠ 诊断开关 DSH_WE_PERSP_WP=1: 世界坐标**透视校正**插值 (GPU 语义)。
              // 默认 0 = 历史行为 (线性插值, 对大而倾斜的三角形是错的) —— 用于消融
              // "手写快路径的亮度到底来自公式还是来自这个插值 bug" (见
              // .test-cache/fix-glsl-materials.md §10)。
              let nx = la * sd[i0] + lb * sd[i1] + lc * sd[i2];
              let ny = la * sd[i0 + 1] + lb * sd[i1 + 1] + lc * sd[i2 + 1];
              let nz = la * sd[i0 + 2] + lb * sd[i1 + 2] + lc * sd[i2 + 2];
              const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
              nx /= nl; ny /= nl; nz /= nl;
              if (backface) { nx = -nx; ny = -ny; nz = -nz; }
              let wx = la * sd[i0 + 3] + lb * sd[i1 + 3] + lc * sd[i2 + 3];
              let wy = la * sd[i0 + 4] + lb * sd[i1 + 4] + lc * sd[i2 + 4];
              let wz = la * sd[i0 + 5] + lb * sd[i1 + 5] + lc * sd[i2 + 5];
              if (PERSP_WP) {
                wx = (la * sd[i0 + 3] * iw0 + lb * sd[i1 + 3] * iw1 + lc * sd[i2 + 3] * iw2) / iw;
                wy = (la * sd[i0 + 4] * iw0 + lb * sd[i1 + 4] * iw1 + lc * sd[i2 + 4] * iw2) / iw;
                wz = (la * sd[i0 + 5] * iw0 + lb * sd[i1 + 5] * iw1 + lc * sd[i2 + 5] * iw2) / iw;
              }
              // 第 2 UV (lightmap): 透视校正插值 (若 mesh 无 uv2, sd 为 0 → 用 uv1 兜底)
              const lmU0 = sd[i0 + 6] || 0, lmV0 = sd[i0 + 7] || 0;
              const lmU1 = sd[i1 + 6] || 0, lmV1 = sd[i1 + 7] || 0;
              const lmU2 = sd[i2 + 6] || 0, lmV2 = sd[i2 + 7] || 0;
              const hasUv2 = lmU0 !== 0 || lmU1 !== 0 || lmU2 !== 0 || lmV0 !== 0 || lmV1 !== 0 || lmV2 !== 0;
              const lmU = hasUv2 ? (la * lmU0 * iw0 + lb * lmU1 * iw1 + lc * lmU2 * iw2) / iw : u;
              const lmV = hasUv2 ? (la * lmV0 * iw0 + lb * lmV1 * iw1 + lc * lmV2 * iw2) / iw : v;
              // 世界空间切线基 (仅 tanBase ≥ 0 的 generic+NORMALMAP 网格有)
              let tbn = null;
              if (tanBase >= 0) {
                let tx = la * sd[i0 + tanBase] + lb * sd[i1 + tanBase] + lc * sd[i2 + tanBase];
                let ty = la * sd[i0 + tanBase + 1] + lb * sd[i1 + tanBase + 1] + lc * sd[i2 + tanBase + 1];
                let tz = la * sd[i0 + tanBase + 2] + lb * sd[i1 + tanBase + 2] + lc * sd[i2 + tanBase + 2];
                const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
                tx /= tl; ty /= tl; tz /= tl;
                let bx = la * sd[i0 + tanBase + 3] + lb * sd[i1 + tanBase + 3] + lc * sd[i2 + tanBase + 3];
                let by = la * sd[i0 + tanBase + 4] + lb * sd[i1 + tanBase + 4] + lc * sd[i2 + tanBase + 4];
                let bz = la * sd[i0 + tanBase + 5] + lb * sd[i1 + tanBase + 5] + lc * sd[i2 + tanBase + 5];
                const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
                bx /= bl; by /= bl; bz /= bl;
                // nGeomUnflipped = 未翻转的插值几何法线 (官方 generic.vert:77 的
                // 环境混合用它; 切线基的 N 轴也用它)
                tbn = {
                  t: [tx, ty, tz], b: [bx, by, bz],
                  n: backface ? [-nx, -ny, -nz] : [nx, ny, nz],
                  flip: backface,
                };
              }
              // 自定义 varying: 与法线/世界坐标同一套透视校正权重 (官方 varying 语义)
              if (varCount) {
                for (let k = 0; k < varCount; k++) {
                  varOut[k] = (la * sd[i0 + varBase + k] * iw0 + lb * sd[i1 + varBase + k] * iw1 + lc * sd[i2 + varBase + k] * iw2) / iw;
                }
              }
              const col = shade(u, v, [wx, wy, wz], [nx, ny, nz], this.camEye, lmU, lmV, px / W, py / H, tbn, varCount ? varOut : null);
              if (!col || col[3] <= 0.003) continue;
              const di4 = di * 4;
              if (blending === 'opaque') {
                if (depthWrite) zbuf[di] = depth;
                canvas.data[di4] = Math.round(col[0] * 255);
                canvas.data[di4 + 1] = Math.round(col[1] * 255);
                canvas.data[di4 + 2] = Math.round(col[2] * 255);
                canvas.data[di4 + 3] = 255;
              } else if (blending === 'additive') {
                // additive: dst += src*srcA (D3D SRC_ALPHA / ONE), 不覆盖已有颜色
                if (depthWrite) zbuf[di] = depth;
                const sa = Math.min(1, col[3]);
                canvas.data[di4] = Math.min(255, canvas.data[di4] + Math.round(col[0] * 255 * sa));
                canvas.data[di4 + 1] = Math.min(255, canvas.data[di4 + 1] + Math.round(col[1] * 255 * sa));
                canvas.data[di4 + 2] = Math.min(255, canvas.data[di4 + 2] + Math.round(col[2] * 255 * sa));
                canvas.data[di4 + 3] = Math.max(canvas.data[di4 + 3], 255);
              } else {
                const a = Math.min(1, col[3]);
                const dstA = canvas.data[di4 + 3] / 255;
                const outA = a + dstA * (1 - a);
                if (outA <= 0) continue;
                if (depthWrite) zbuf[di] = depth;
                canvas.data[di4] = Math.round((col[0] * 255 * a + canvas.data[di4] * dstA * (1 - a)) / outA);
                canvas.data[di4 + 1] = Math.round((col[1] * 255 * a + canvas.data[di4 + 1] * dstA * (1 - a)) / outA);
                canvas.data[di4 + 2] = Math.round((col[2] * 255 * a + canvas.data[di4 + 2] * dstA * (1 - a)) / outA);
                canvas.data[di4 + 3] = Math.round(outA * 255);
              }
            }
          }
        }
      }
    
      // CPU shader 分派: 返回 (u, v, worldPos, normal, eye) => [r,g,b,a]
,
    _makeShadeFn(vs) {
        const { shaderName, uniforms, tex, tex1, tex2, tex3, t } = vs;
        if (shaderName === 'core') return (u, v, wp, n, eye) => this._shadeCore(u, v, wp, n, eye, uniforms, t);
        if (shaderName === 'backgroundsphere') return (u, v, wp, n, eye) => this._shadeBgSphere(u, v, uniforms, tex, tex1, tex2, t);
        if (shaderName === 'dna') return (u, v, wp, n, eye) => this._shadeDna(u, v, wp, n, eye, uniforms, tex, t);
        // `bg` 在官方 19 个 defaultprojects 里被 **两个项目** 各自实现 (同名不同源,
        // 引擎按项目 shaders/ 目录优先解析):
        //   dna_fragment/shaders/bg.frag  : 2 张纹理 (clouds_blurred, bgpattern)
        //   retro/shaders/bg.frag         : 4 张纹理 (+retro_grunge, +noise2d) ⇒ g_Texture2/3
        // 用一个实现覆盖两者会让 retro 的背景整层走错的公式 (实测整帧暗 4.2×)。
        if (shaderName === 'bg') {
          const retroBg = !!(tex2 && tex3) || (vs.textureNames || []).length >= 4;
          if (retroBg) return (u, v, wp, n, eye) => this._shadeBgRetro(u, v, uniforms, tex, tex1, tex2, tex3, t);
          return (u, v, wp, n, eye) => this._shadeBg(u, v, uniforms, tex, tex1, t, vs.combos);
        }
        if (shaderName === 'curve') return (u, v, wp, n, eye) => this._shadeCurve(u, v, uniforms, tex, t);
        if (shaderName === 'neonsun') return (u, v, wp, n, eye) => this._shadeNeonSun(u, v, uniforms, t);
        if (shaderName === 'neongrid') return (u, v, wp, n, eye) => this._shadeNeonGrid(u, v, wp, n, uniforms, t);
        if (shaderName === 'cloudsbg') return (u, v, wp, n, eye) => this._shadeCloudsBg(u, v, uniforms, tex1, t);
        if (shaderName === 'flowimage') return (u, v, wp, n, eye) => this._shadeFlowImage(u, v, uniforms, vs.textures, vs.textureNames, t);
        // ── 壁纸自带的自定义着色器 (源码: 场景目录 shaders/*.frag, 逐行 CPU 复刻) ──
        if (shaderName === 'skybox') return (u, v, wp, n, eye) => this._shadeSkybox(u, v, vs.textures);
        if (shaderName === 'ricepod') return (u, v, wp, n, eye) => this._shadeRicepod(u, v, wp, n, eye, uniforms, vs.textures, vs.combos);
        if (shaderName === 'ricepodjet') return (u, v, wp, n, eye) => this._shadeRicepodJet(u, v, vs.textures, t);
        if (shaderName === 'ricepodorbitalaurora') return (u, v, wp, n, eye) => this._shadeRicepodAurora(u, v, vs.textures, t);
        if (shaderName === 'ricepodorbitalthunder') return (u, v, wp, n, eye) => this._shadeRicepodThunder(u, v, vs.textures, t);
        // ── 官方 3D 默认壁纸 techno / audiophile / fantasticcar 的自带着色器 ──
        // (源码: <project>/shaders/*.vert|frag, 逐行 CPU 复刻; 对照表见
        //  .test-cache/fix-3d-shaders.md §1; 逐像素 oracle 对照见 §4)
        if (shaderName === 'technoglow') return (u, v, wp, n, eye) => this._shadeTechnoGlow(u, v, uniforms, vs.textures, t);
        if (shaderName === 'technohex') return (u, v, wp, n, eye, u2, v2, su, sv, tbn, vv) => this._shadeTechnoHex(u, v, uniforms, vs.textures, t, vv);
        if (shaderName === 'technoorbit') return (u, v, wp, n, eye) => this._shadeTechnoOrbit(u, v, uniforms, vs.textures, t, vs.combos);
        if (shaderName === 'audiophile') return (u, v, wp, n, eye, u2, v2, su, sv, tbn, vv) => this._shadeAudiophile(u, v, vv);
        if (shaderName === 'audiophileflow') return (u, v, wp, n, eye) => this._shadeAudiophileFlow(u, v, uniforms, vs.textures, t);
        if (shaderName === 'audiophileglow') return (u, v, wp, n, eye) => this._shadeAudiophileGlow(u, v, uniforms, vs.textures);
        if (shaderName === 'grid') return (u, v, wp, n, eye, u2, v2, su, sv, tbn, vv) => this._shadeGrid(u, v, vs.textures, su, sv, vv);
        if (shaderName === 'car') return (u, v, wp, n, eye, u2, v2, su, sv, tbn, vv) => this._shadeCar(u, v, uniforms, vs.textures, vv, vs.combos);
        if (shaderName === 'dome') return (u, v, wp, n, eye) => this._shadeDome(u, v, uniforms);
        if (shaderName === 'shadow') return (u, v, wp, n, eye) => this._shadeShadow(u, v);
        return (u, v, wp, n, eye, u2, v2, su, sv, tbn) => this._shadeGeneric(u, v, wp, n, eye, uniforms, vs.textures, t, vs.combos, u2, v2, su, sv, tbn);
      }
    ,
      // flowimage: 官方有**两个变体**（都取自壁纸自带的 shaders/flowimage.frag）:
      //   A) 多层 (deep_space): textures=[flowmask, layer2, layer1, layer0]
      //      mask 中心 (0.5,0.5); 基准层 = g_Texture1; 再逐层按官方 blendLayers 合成
      //      (rgb 以该层 alpha 混合、alpha 取 max); 第 3 层相位 +0.3333 (见 .vert)
      //   B) 单层 (beach): textures=[base, flowmask]
      //      mask 中心 (0.506,0.482); mix(tex0(uv+o1), tex0(uv+o2), blend) * Bright
      // 旧实现只按 A 的排布过滤 (`i !== (flowIdx === 0 ? -1 : 0)`) ⇒ flowIdx=1 时
      // 把 base(0) 也一起排除 ⇒ layers=[] ⇒ 返回 [0,0,0,1] ⇒ **beach 背景整幅
      // 纯黑且 100% 覆盖画面** (960x540 隔离实测: 非清屏 100.00%，纯黑 100.00%；
      // 官方参考平均亮度 180.7/255)。取证与量化见 .test-cache/audit-shaders.md §1.2。
    _shadeFlowImage(u, v, uniforms, textures, texNames, t) {
        const bright = uniforms.Bright != null ? uniforms.Bright : 1;
        const amp = uniforms.Amount != null ? uniforms.Amount : 1;
        const alpha = uniforms.Alpha != null ? uniforms.Alpha : 1;
        const names = texNames || [];
        const flowIdx = names.findIndex((n) => n && n.toLowerCase().includes('flowmask'));
        // flowIdx > 0 ⇒ 变体 B (mask 在第 1 张, base 在第 0 张); 否则按变体 A (mask 在第 0 张)
        const single = flowIdx > 0;
        const flowTex = flowIdx >= 0 ? textures[flowIdx] : (textures[1] || textures[0]);
        if (!flowTex) return [0, 0, 0, 0];
        const f = this._texSample(flowTex, u, v);
        const cx = single ? 0.506 : 0.5, cy = single ? 0.482 : 0.5;
        const maskX = (f[0] - cx) * 2, maskY = (f[1] - cy) * 2;
        // 双相位混合采样 (两个变体共用): cycles = frac(t·speed+phase), frac(t·speed+0.5+phase)
        const sampleFlow = (tex, speed, phase) => {
          const ph = phase || 0;
          const cyc1 = ((t * speed + ph) % 1 + 1) % 1, cyc2 = ((t * speed + 0.5 + ph) % 1 + 1) % 1;
          const blend = 2 * Math.abs(cyc1 - 0.5);
          const s1 = this._texSample(tex, u + maskX * amp * 0.1 * cyc1, v + maskY * amp * 0.1 * cyc1);
          const s2 = this._texSample(tex, u + maskX * amp * 0.1 * cyc2, v + maskY * amp * 0.1 * cyc2);
          return [
            s1[0] + (s2[0] - s1[0]) * blend,
            s1[1] + (s2[1] - s1[1]) * blend,
            s1[2] + (s2[2] - s1[2]) * blend,
            s1[3] + (s2[3] - s1[3]) * blend,
          ];
        };
        if (single || flowIdx < 0) {
          // 变体 B: 单层, 速度键 = Speed (该材质没有 Speed0/1/2); alpha 取纹理 alpha
          const base = textures[0];
          if (!base) return [0, 0, 0, alpha];
          const c = sampleFlow(base, uniforms.Speed != null ? uniforms.Speed : 0.01, 0);
          return [sat(c[0] * bright), sat(c[1] * bright), sat(c[2] * bright), c[3]];
        }
        // 变体 A: 图层 = textures[1..3], 各自速度与相位 (第 3 层 +0.3333)
        const speeds = [uniforms.Speed0, uniforms.Speed1, uniforms.Speed2];
        const phases = [0, 0, 0.3333];
        let r = 0, g = 0, b = 0, a = 0, first = true;
        for (let i = 0; i < 3; i++) {
          const tex = textures[i + 1];
          if (!tex) continue;
          const speed = speeds[i] != null ? speeds[i] : (uniforms.Speed != null ? uniforms.Speed : 0.01);
          const s = sampleFlow(tex, speed, phases[i]);
          if (first) { r = s[0]; g = s[1]; b = s[2]; a = s[3]; first = false; }
          else {
            // 官方 blendLayers: albedo.rgb = mix(albedo.rgb, samp.rgb, samp.a); albedo.a = max(albedo.a, samp.a)
            r += (s[0] - r) * s[3];
            g += (s[1] - g) * s[3];
            b += (s[2] - b) * s[3];
            a = Math.max(a, s[3]);
          }
        }
        if (first) return [0, 0, 0, alpha];
        return [sat(r * bright), sat(g * bright), sat(b * bright), a];
      }
    
      // dna.frag: albedo = tint * tex; rimlight = 1 - dot(V,N); albedo *= 1 + rimlight
,
    _shadeDna(u, v, wp, n, eye, uniforms, tex, t) {
        const tint = uniforms.tint ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint) : [0.5, 0.5, 0.5];
        // dna.frag:14 `texSample2D(g_Texture0, v_TexCoord.xy).rgb` —— 官方采样器是
        // LINEAR (dna.tex 无 tex-json sidecar ⇒ 默认插值; 只有 nointerpolation:true
        // 才是 NEAREST)。旧实现用 floor(u*width) 的**最近邻**取值, 在 32×32 的
        // dna.tex 被放大到屏幕后逐像素偏色 (oracle 实测 max|Δ|=0.117 / 12.3% 像素)。
        const t0 = tex ? this._texSample(tex, u, v) : [1, 1, 1, 1];
        const texRgb = [t0[0], t0[1], t0[2]];
        const viewDir = v3norm(v3sub(eye, wp));
        const rim = 1 - Math.max(-1, Math.min(1, v3dot(viewDir, v3norm(n))));
        const f = 1 + rim;
        return [sat(tint[0] * texRgb[0] * f), sat(tint[1] * texRgb[1] * f), sat(tint[2] * texRgb[2] * f), 1];
      }
    
      // bg.frag (dna_fragment/shaders/bg.frag) : 云 + 暗角 + 图案 (全屏背景)
,
    _shadeBg(u, v, uniforms, tex0, tex1, t, combos) {
        const tint = uniforms.tint ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint) : [0.5, 0.5, 0.5];
        const tint2 = uniforms.tint2 ? (typeof uniforms.tint2 === 'number' ? [uniforms.tint2, uniforms.tint2, uniforms.tint2] : uniforms.tint2) : [0.5, 0.5, 0.5];
        const sm = (e0, e1, x) => { const tx = sat((x - e0) / (e1 - e0)); return tx * tx * (3 - 2 * tx); };
        const cA = this._texA(tex0, u + t * 0.03, v + t * 0.03);
        const cB = this._texA(tex0, u * 2 - t * 0.0111, v * 2 - t * 0.0111);
        const clouds = Math.pow(cA * cB * 1.4, 2);
        // smoothstep(1.2, 0, d): HLSL/GLSL 实现 t=clamp((d-1.2)/(0-1.2)) → d=0 时 1 (递减 edge 的 clamp 语义)
        const vignette = sm(1.2, 0, Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)) * 2;
        // ★ bg.vert:25 `float texelRatio = g_TexelSize.y / g_TexelSize.x;`
        //   官方 g_TexelSize = vec2(1/sceneWidth, 1/sceneHeight)
        //   (linux-wallpaperengine CPass.cpp:883) ⇒ texelRatio = **画布** W/H,
        //   与 g_Texture0 的贴图尺寸无关。旧实现取 tex0.height/tex0.width
        //   (clouds_blurred 128×128 ⇒ 1.0), 在 16:9 画布上把图案的频率在 x 上
        //   压缩了 1.78×。仅 dna_fragment 使用本变体 (retro 的 bg 走 _shadeBgRetro)。
        const texelRatio = this.W / this.H;
        const pattern = this._texA(tex1, u * 50 * texelRatio, v * 50) * 0.1 * sm(0.1, 0.7, Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2));
        const mixF = v * v;
        const r = (tint[0] + (tint2[0] - tint[0]) * mixF) * (clouds + pattern) * vignette;
        const g = (tint[1] + (tint2[1] - tint[1]) * mixF) * (clouds + pattern) * vignette;
        const b = (tint[2] + (tint2[2] - tint[2]) * mixF) * (clouds + pattern) * vignette;
        // GRADIENT_FADE combo: alpha 随高度渐变 (bgfade 淡出层, 中部透明)
        let alpha = 1;
        if (combos && combos.GRADIENT_FADE) {
          alpha = sm(0.2, 0.45, Math.abs(v - 0.5));
        }
        return [sat(r), sat(g), sat(b), alpha];
      }
    
      // bg (retro/shaders/bg.{vert,frag}) —— 与 dna_fragment 的 bg 同名不同源。
      // 逐行对照 (file:line 为官方 retro/shaders/ 行号):
      //   vert:16-17  pos2D = a_TexCoord*2-1 → 全屏 quad (与本文件 model.js:276 的
      //               bg 分派一致: clip = [uv*2-1, uv*2-1, 0.5, 1])
      //   vert:19     v_TexCoordGrunge = gl_Position.xy/w*0.75*vec2(texelRatio,1)
      //   vert:25-26  texelRatio = g_TexelSize.y/g_TexelSize.x = W/H (CPass.cpp:883)
      //   vert:27-30  v_TexCoord = a_TexCoord
      //   vert:32     v_TexCoordsPattern = a_TexCoord*50*vec2(texelRatio,1)
      //   vert:34-35  v_TexCoordNoise.xy = (g_Time*0.001, 0); .zw = (frac(.x*64), texelRatio)
      //   frag:19-24  clouds = mix(tex0(floor(pattern+scroll-blend)/50)(+1/50), blend)
      //               → smoothstep(0.4,0.7,·)
      //   frag:26     vignette = smoothstep(1, 0, length(v_TexCoord-0.5))
      //   frag:30     pattern = tex1(pattern).a
      //   frag:34-41  noise 驱动中心环 (distToCenter, ringMapBlend, max(0.2,·))
      //   frag:46-48  pattern = smoothstep(clouds-0.1, clouds, pattern);
      //               albedo = pow(mix(tint, tint*0.9, pattern), 1/vignette)
      //   frag:50-53  alpha = 1; albedo -= saturate(grunge - albedo)
,
    _shadeBgRetro(u, v, uniforms, tex0, tex1, tex2, tex3, t) {
        const sm = (e0, e1, x) => { const tx = sat((x - e0) / (e1 - e0)); return tx * tx * (3 - 2 * tx); };
        const tint = uniforms.tint
          ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint)
          : [0.95, 0.85, 0.7];                              // bg.frag:4 声明默认
        // g_TexelSize = (1/W, 1/H) ⇒ texelRatio = W/H
        const texelRatio = this.W / this.H;
        // ── vertex (bg.vert) ──
        const patU = u * 50 * texelRatio, patV = v * 50;    // vert:32
        const grungeU = (u * 2 - 1) * 0.75 * texelRatio;    // vert:29-30 (w = 1)
        const grungeV = (v * 2 - 1) * 0.75;
        const noiseX = t * 0.001;                           // vert:34
        const noiseZ = (noiseX * 64.0) % 1;                 // vert:35 frac()
        const noiseW = texelRatio;                          // vert:35 (未参与 frag)
        void noiseW;
        // ── fragment (bg.frag) ──
        const circleScroll = t * 0.3;                       // frag:19
        const blendTime = circleScroll % 1;                 // frag:20 frac()
        const au = Math.floor(patU + circleScroll - blendTime) / 50;  // frag:22
        const av = Math.floor(patV + circleScroll - blendTime) / 50;
        const cA = this._texA(tex0, au, av);                // frag:24
        const cB = this._texA(tex0, au + 1 / 50, av + 1 / 50);
        let clouds = cA + (cB - cA) * blendTime;
        clouds = sm(0.4, 0.7, clouds);                      // frag:26
        const du = u - 0.5, dv = v - 0.5;
        const vignette = sm(1, 0, Math.sqrt(du * du + dv * dv));      // frag:28
        let pattern = this._texA(tex1, patU, patV);         // frag:30
        const nz = this._texSample(tex3, noiseX, 0);        // frag:34 (.rg)
        const centerX = nz[0] * 50, centerY = nz[1] * 50;
        let distToCenter = Math.sqrt((centerX - Math.floor(patU)) ** 2 + (centerY - Math.floor(patV)) ** 2) / 50; // frag:36
        distToCenter = distToCenter * 60 - 20 * noiseZ;     // frag:37
        const ringX = Math.sin(Math.max(0, distToCenter));  // frag:39
        const ringY = Math.sin(noiseZ * 3.141);
        // step(distToCenter, 3.141) = 1 ⟺ 3.141 ≥ distToCenter (GLSL step(edge,x))
        clouds -= ringX * (distToCenter <= 3.141 ? 1 : 0) * 0.5 * ringY;  // frag:40
        clouds = Math.max(0.2, clouds);                     // frag:41
        pattern = sm(clouds - 0.1, clouds, pattern);        // frag:46
        const grunge = this._texA(tex2, grungeU, grungeV);  // frag:52
        const e = vignette > 0 ? 1 / vignette : Infinity;   // frag:48
        const out = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const mixed = tint[i] + (tint[i] * 0.9 - tint[i]) * pattern;  // mix(tint, tint*0.9, pattern)
          let a = Math.pow(Math.max(0, mixed), e);
          a = Math.max(0, a - sat(grunge - a));             // frag:53
          out[i] = a;
        }
        return [out[0], out[1], out[2], 1];                 // frag:50 alpha = 1
      }
    
      // curve.frag: tint * tex.a (additive) ; curve.vert:17 v = uv*(1,Freq) + t*Speed*0.1
,
    _shadeCurve(u, v, uniforms, tex, t) {
        const tint = uniforms.tint ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint) : [0.5, 0.5, 0.5];
        // 官方 curve.vert:6 `g_CurveFreq // {"material":"Freq","default":0,...}` —— 默认
        // 0 (旧实现写 1; dna_fragment 的材质显式给 Freq=1, 故行为不变, 只对齐字面量)。
        const freq = uniforms.Freq != null ? uniforms.Freq : 0;
        const speed = uniforms['Scroll speed'] != null ? uniforms['Scroll speed'] : 0;
        const op = this._texA(tex, u, v * freq + t * speed * 0.1);
        return [tint[0] * op, tint[1] * op, tint[2] * op, 1];
      }
    
      // neonsun.frag: 程序化霓虹太阳 (渐变 + 滚动切条 + 光晕)
,
    _shadeNeonSun(u, v, uniforms, t) {
        const top = uniforms.colorsuntop ? (typeof uniforms.colorsuntop === 'number' ? [uniforms.colorsuntop, uniforms.colorsuntop, uniforms.colorsuntop] : uniforms.colorsuntop) : [1, 0.85, 0.05];
        const bot = uniforms.colorsunbottom ? (typeof uniforms.colorsunbottom === 'number' ? [uniforms.colorsunbottom, uniforms.colorsunbottom, uniforms.colorsunbottom] : uniforms.colorsunbottom) : [1, 0, 0.35];
        const sm = (e0, e1, x) => { const tx = sat((x - e0) / (e1 - e0)); return tx * tx * (3 - 2 * tx); };
        const vx = (u * 2 - 1) * 0.3, vy = (v * 2 - 1) * 0.3;
        const sunSize = 0.05, sunSizeSqrt = Math.sqrt(sunSize);
        const blendSunColor = (vy + sunSize * 2.5) / sunSizeSqrt;
        const colorSunR = top[0] + (bot[0] - top[0]) * blendSunColor;
        const colorSunG = top[1] + (bot[1] - top[1]) * blendSunColor;
        const colorSunB = top[2] + (bot[2] - top[2]) * blendSunColor;
        const sunRadius = vx * vx + vy * vy;
        const colorSunA = 1 - (sunRadius >= 0.05 ? 1 : 0);
        const glowAlpha = Math.pow(sm(0.08, 0.045, sunRadius), 2);
        const barPos = vy + 0.1;
        const sunCutOut = 1 - sat(sm(0, 0.005, barPos) * sm(1 - barPos * 9, 1 - barPos * 8, Math.sin(barPos * 200 + t)));
        const sunCutOutSmooth = 1 - sat(sm(0, 0.05, barPos) * sm(-1 - barPos * 8, 1 - barPos * 8, Math.sin(barPos * 200 + t)));
        const mixA = colorSunA * sunCutOut;
        const r = bot[0] + (colorSunR - bot[0]) * mixA;
        const g = bot[1] + (colorSunG - bot[1]) * mixA;
        const b = bot[2] + (colorSunB - bot[2]) * mixA;
        const a = Math.max(glowAlpha * sunCutOutSmooth, mixA);
        return [sat(r), sat(g), sat(b), a];
      }
    
      // neongrid.frag: 程序化霓虹网格 (格线 + 山体着色)
,
    _shadeNeonGrid(u, v, wp, n, uniforms, t) {
        const cNear = uniforms.gridnear ? (typeof uniforms.gridnear === 'number' ? [uniforms.gridnear, uniforms.gridnear, uniforms.gridnear] : uniforms.gridnear) : [1, 0, 0.49];
        const cFar = uniforms.gridfar ? (typeof uniforms.gridfar === 'number' ? [uniforms.gridfar, uniforms.gridfar, uniforms.gridfar] : uniforms.gridfar) : [0, 0.7, 1];
        const cBg = uniforms.gridbackground ? (typeof uniforms.gridbackground === 'number' ? [uniforms.gridbackground, uniforms.gridbackground, uniforms.gridbackground] : uniforms.gridbackground) : [0.102, 0, 0.102];
        const shadingAmt = uniforms.shading != null ? uniforms.shading : 1;
        const sm = (e0, e1, x) => { const tx = sat((x - e0) / (e1 - e0)); return tx * tx * (3 - 2 * tx); };
        const fract = (x) => x - Math.floor(x);
        const grid = [Math.abs(fract(u * 50) - 0.5), Math.abs(fract(v * 50) - 0.5)];
        // v_Vars.yz (近似, maskUVSmoothing≈0): 0.45 - uv.y * vec2(0.05, 0.75 - dampen*0.7)
        const dampenDist = Math.abs(u * 2 - 1);
        const dampenUVSmoothing = sat(Math.abs(u - 0.5) * 2);
        const varsY = 0.45 - v * 0.05;
        const varsZ = 0.45 - v * (0.75 - dampenUVSmoothing * 0.7);
        let gridAlpha = sm(varsY, 0.5, grid[0]) + sm(varsZ, 0.5, grid[1]);
        gridAlpha += (sm(0, 1, grid[0]) + sm(0, 1, grid[1])) * sat(0.3 - v);
        const alphaDistanceFade = sm(1.0, 0.9, v);
        const colorDistanceBlend = Math.pow(Math.max(0, v), 0.8);
        const nn = v3norm(n);
        const lightDir = v3norm([0 - wp[0], -0.15 - wp[1], -2 - wp[2]]);
        const shadingNear = Math.max(0, nn[2]);
        const shadingFar = Math.max(0, v3dot(lightDir, nn));
        const shadingColor = [
          shadingNear * cNear[0] * (1 - colorDistanceBlend) + shadingFar * cFar[0],
          shadingNear * cNear[1] * (1 - colorDistanceBlend) + shadingFar * cFar[1],
          shadingNear * cNear[2] * (1 - colorDistanceBlend) + shadingFar * cFar[2],
        ];
        const colorGrid = [
          cBg[0] + shadingColor[0] * shadingAmt,
          cBg[1] + shadingColor[1] * shadingAmt,
          cBg[2] + shadingColor[2] * shadingAmt,
        ];
        const mixNear = [
          cNear[0] + (cFar[0] - cNear[0]) * colorDistanceBlend,
          cNear[1] + (cFar[1] - cNear[1]) * colorDistanceBlend,
          cNear[2] + (cFar[2] - cNear[2]) * colorDistanceBlend,
        ];
        const ga = sat(gridAlpha * alphaDistanceFade);
        const res = [
          colorGrid[0] + (mixNear[0] - colorGrid[0]) * ga,
          colorGrid[1] + (mixNear[1] - colorGrid[1]) * ga,
          colorGrid[2] + (mixNear[2] - colorGrid[2]) * ga,
        ];
        return [sat(res[0]), sat(res[1]), sat(res[2]), alphaDistanceFade];
      }
    
      // cloudsbg.frag: 程序化云层背景 (云 + 水平线光晕)
,
    _shadeCloudsBg(u, v, uniforms, tex1, t) {
        const c1 = uniforms.clouds ? (typeof uniforms.clouds === 'number' ? [uniforms.clouds, uniforms.clouds, uniforms.clouds] : uniforms.clouds) : [0.027, 0.066, 0.086];
        const cH = uniforms.horizon ? (typeof uniforms.horizon === 'number' ? [uniforms.horizon, uniforms.horizon, uniforms.horizon] : uniforms.horizon) : [0.055, 0.306, 0.42];
        const sm = (e0, e1, x) => { const tx = sat((x - e0) / (e1 - e0)); return tx * tx * (3 - 2 * tx); };
        const aspect = tex1 ? tex1.height / tex1.width : 1;
        // v_TexCoordClouds: xy = (uv + t*sp0)*sc0; zw = (uv + t*sp1)*sc1; xz *= aspect; zw = (-w, z)
        const cxy0 = ((u + t * 0.0007) % 1 + 1) % 1 * 1.1;
        const cxy1 = ((v + t * 0.0007) % 1 + 1) % 1 * 1.1;
        let cz0 = ((u + t * -0.0011) % 1 + 1) % 1 * 0.7 * aspect;
        let cw0 = ((v + t * -0.0011) % 1 + 1) % 1 * 0.7;
        const cloud0 = this._texR(tex1, cxy0, cxy1);
        const cloud1 = this._texR(tex1, -cw0, cz0);
        const cloudBlend = cloud0 * cloud1;
        const lift = Math.pow(sm(0.5, 0.0, v), 2) * 2.0;
        const horizonBend = 1 - Math.cos(sat(u * 2.0 - 0.5) * 2 * Math.PI);
        const hdx = (u - 0.5) * 0.5;
        const hdy = (v - 0.6) * (1.5 - horizonBend * 0.3);
        const distanceToCenter = Math.sqrt(hdx * hdx + hdy * hdy);
        const horizonGlow = Math.pow(sm(0.5, 0.0, distanceToCenter), 2) * 2.0;
        const r = c1[0] * cloudBlend + (c1[0] * 0.5 + c1[0] * cloudBlend) * lift + cH[0] * horizonGlow;
        const g = c1[1] * cloudBlend + (c1[1] * 0.5 + c1[1] * cloudBlend) * lift + cH[1] * horizonGlow;
        const b = c1[2] * cloudBlend + (c1[2] * 0.5 + c1[2] * cloudBlend) * lift + cH[2] * horizonGlow;
        return [sat(r), sat(g), sat(b), 1];
      }
    
      // core.frag: albedo=tint, 光照 = ComputeLightSpecular(light[0]) + ambient 混合, 乘 v_LightScale
,
    _shadeCore(u, v, wp, n, eye, uniforms, t) {
        const tint = uniforms.tint ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint) : [1, 1, 1];
        const roughness = uniforms.Rough != null ? uniforms.Rough : 0;
        const metallic = uniforms.Metal != null ? uniforms.Metal : 0;
        const gLight = uniforms.Light != null ? uniforms.Light : 0;
        const specPower = (1.01 - roughness) * (400 + (250 - 400) * metallic);
        const specStrength = (0.5 + metallic * 0.5) * (1.0 - roughness * 0.9);
        const viewDir = v3norm(v3sub(eye, wp));
        // v_LightScale (core.vert, audio=0)
        const period = Math.PI * 4;
        const a = t * 0.4, cs = Math.cos(a), sn = Math.sin(a);
        const rx = cs * u - sn * v, ry = sn * u + cs * v;
        const animsZ = sat(Math.sin((u + v + 1) * period + t));
        const stepX = u >= 0 ? 1 : 0;
        let audioAvg = 1.0 - (u <= 0 ? 1 : 0) * animsZ * 0.4;
        const lightScale = sat(stepX + audioAvg);
        let light = [0, 0, 0];
        let spec = [0, 0, 0];
        const lights = this.lights;
        for (let li = 0; li < Math.min(lights.length, 4); li++) {
          const L = lights[li];
          const lv = v3sub(L.origin, wp);
          const dist = Math.sqrt(v3dot(lv, lv)) || 1;
          const ldir = [lv[0] / dist, lv[1] / dist, lv[2] / dist];
          const attn = sat((L.radius - dist) / L.radius);
          const h = v3norm(v3add(viewDir, ldir));
          const specDot = Math.max(0, v3dot(h, n));
          const c = [L.color[0] * L.intensity, L.color[1] * L.intensity, L.color[2] * L.intensity];
          const specTerm = Math.pow(specDot, specPower) * specStrength * attn;
          spec = [spec[0] + specTerm * c[0], spec[1] + specTerm * c[1], spec[2] + specTerm * c[2]];
          const lightDot = v3dot(ldir, n);
          const hl = lightDot * 0.5 + 0.5;
          const ld = lightDot + (hl - lightDot) * gLight;
          const a2 = attn * attn;
          light = [light[0] + c[0] * sat(ld) * a2, light[1] + c[1] * sat(ld) * a2, light[2] + c[2] * sat(ld) * a2];
        }
        const upMix = v3dot(n, [0, 1, 0]) * 0.5 + 0.5;
        const amb = [
          this.skylightColor[0] + (this.ambientColor[0] - this.skylightColor[0]) * upMix,
          this.skylightColor[1] + (this.ambientColor[1] - this.skylightColor[1]) * upMix,
          this.skylightColor[2] + (this.ambientColor[2] - this.skylightColor[2]) * upMix,
        ];
        const total = [
          tint[0] * (light[0] + amb[0]) * lightScale + spec[0],
          tint[1] * (light[1] + amb[1]) * lightScale + spec[1],
          tint[2] * (light[2] + amb[2]) * lightScale + spec[2],
        ];
        return [sat(total[0]), sat(total[1]), sat(total[2]), 1];
      }
    
      // backgroundsphere.frag: 程序化钻石+噪点+云 (完全照搬 shader 数学)
,
    _shadeBgSphere(u, v, uniforms, tex0, tex1, tex2, t) {
        const tint = uniforms.tint ? (typeof uniforms.tint === 'number' ? [uniforms.tint, uniforms.tint, uniforms.tint] : uniforms.tint) : [1, 1, 1];
        const tint2 = uniforms.tint2 ? (typeof uniforms.tint2 === 'number' ? [uniforms.tint2, uniforms.tint2, uniforms.tint2] : uniforms.tint2) : [0, 0, 0];
        const sm = (edge0, edge1, x) => { const tx = sat((x - edge0) / (edge1 - edge0)); return tx * tx * (3 - 2 * tx); };
        const smRev = (e0, e1, x) => sm(e1, e0, x);
        const pux = u * 200 + t * 0.2, puy = v * 100;
        const diamond = this._texR(tex0, pux, puy);
        const nux1 = u * 2 + t * 0.007, nuy1 = v * 2 + t * 0.007;
        const nux2 = u * 4 - t * 0.005, nuy2 = v * 4 - t * 0.005;
        const noiseA = this._texR(tex1, nux1, nuy1);
        const noiseB = this._texR(tex1, nux2, nuy2);
        const diamondBlend0 = Math.abs(v - 0.5) * 0.8;
        const diamondBlend = sm(0.2, 0.0, diamondBlend0);
        const coreNoise = sm(noiseA, noiseB, 0.3);
        const noise = sm(0.25, 0.3, noiseA * noiseB) * smRev(0.25, 0.3, noiseA * noiseB);
        const noiseV = coreNoise * noise * 4;
        const cloudA = this._texR(tex1, u + t * 0.01, v + t * 0.01);
        const cloudB = this._texR(tex1, u - t * 0.005, v - t * 0.005);
        const cloudLevel = cloudA * cloudB * 1.1;
        const cl = cloudLevel * (0.5 - Math.abs(v - 0.5));
        const hash = this._texA(tex2, pux, puy);
        let albedoR = cl + tint2[0], albedoG = cl + tint2[1], albedoB = cl + tint2[2];
        const mixF = sm(0.2, 0.02, cl);
        const ar = albedoR + ((cl + 0.5) * tint[0] - albedoR) * mixF;
        const ag = albedoG + ((cl + 0.5) * tint[1] - albedoG) * mixF;
        const ab = albedoB + ((cl + 0.5) * tint[2] - albedoB) * mixF;
        const db = diamondBlend * diamond * noiseV + diamondBlend * noiseV * 0.2;
        const fr = ar + (db * tint[0] * 10 - ar) * db;
        const fg = ag + (db * tint[1] * 10 - ag) * db;
        const fb = ab + (db * tint[2] * 10 - ab) * db;
        const hf = sm(0.2, 0.02, cl) * sm(0.02, 0.2, cl);
        return [sat(fr + hash * 0.1), sat(fg + hash * 0.1), sat(fb + hash * 0.1), 1];
      }
    
      // 通用材质 (generic*): 官方 generic.frag/vert 逐项复刻
      //   光源项: common_fragment.h:61-81 ComputeLightSpecular (无阴影/无衰减以外的修正)
      //   法线:   generic.vert:63-69 BuildTangentSpace 把光/视方向变换进切线空间
      //           (等价形式: 用 TBN 把切线法线变回世界空间 —— 正交基下点乘恒等)
      //   环境:   generic.vert:77 mix(g_LightSkylightColor, g_LightAmbientColor,
      //           dot(**顶点法线**, up)*0.5+0.5)  ← 用顶点法线, 不是法线贴图法线
      //   贴图:   generic.frag:85-89 lightmap 只乘**第 0 盏**灯 (此后 1-3 盏相加, 环境最后加)
,
    _shadeGeneric(u, v, wp, n, eye, uniforms, textures, t, combos, u2, v2, su, sv, tbn) {
        const tex0 = textures && textures[0];
        let albedo = this._texSample(tex0, u, v);
        if (!tex0) albedo = [1, 1, 1, 1];
        if (combos && combos.DIFFUSETINT) {
          const tint = uniforms.tint || uniforms.Color || [1, 1, 1];
          albedo[0] *= tint[0]; albedo[1] *= tint[1]; albedo[2] *= tint[2];
        }
        if (combos && combos.DETAILINALPHA && tex0) {
          const d = this._texA(tex0, u * 3, v * 3) * 2.0;
          albedo[0] *= d; albedo[1] *= d; albedo[2] *= d;
        }
        const useNormalMap = !!(combos && (combos.NORMALMAP || combos.normalmap) && textures[1]);
        // 顶点世界法线 (generic.vert:44 的 v_Normal): 无法线贴图时它就是光照法线;
        // **无论如何**环境混合 (generic.vert:77) 都用它。
        const nGeom = v3norm(n);
        // 切线空间法线 (common_fragment.h:19-32 DecompressNormal, 按 TEX1FORMAT 选通道)
        let normal, nMapTS = null;
        if (useNormalMap) {
          const nm = this._texSample(textures[1], u, v);
          const fmt = textures[1].format;
          let nx, ny;
          if ((fmt >= 3 && fmt <= 7) || fmt === 12) { // ETC1..DXT1 / BC7: x←w, y←y(0.965 缩放)
            nx = nm[3] * 2 - 1.0;
            ny = nm[1] * 2 - 0.965;
          } else if (fmt === 8) {                     // RG88: x←r, y←g
            nx = nm[0] * 2 - 1.0;
            ny = nm[1] * 2 - 1.0;
          } else {                                    // 默认 (RGBA8888 等): x←w, y←y
            nx = nm[3] * 2 - 1.0;
            ny = nm[1] * 2 - 1.0;
          }
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          nMapTS = [nx, ny, nz];
          if (tbn && tbn.t) {
            // TBN 世界化: n_world = nx·T + ny·B + nz·N (与官方切线空间点乘等价)
            const T = tbn.t, B = tbn.b, N = tbn.n;
            normal = v3norm([
              nx * T[0] + ny * B[0] + nz * N[0],
              nx * T[1] + ny * B[1] + nz * N[1],
              nx * T[2] + ny * B[2] + nz * N[2],
            ]);
          } else {
            // 无 a_Tangent4 数据 ⇒ 保持旧行为 (切线法线当世界法线), 并留痕
            normal = v3norm([nx, ny, nz]);
          }
        } else {
          normal = nGeom;
        }
        const viewDir = v3norm(v3sub(eye, wp));
        const roughness = uniforms.Rough != null ? uniforms.Rough : 0.5;
        const metallic = uniforms.Metal != null ? uniforms.Metal : 0;
        const gLight = uniforms.Light != null ? uniforms.Light : 0;
        const specPower = (1.01 - roughness) * (400 + (250 - 400) * metallic);
        const specStrength = (0.5 + metallic * 0.5) * (1.0 - roughness * 0.9);
        // 烘焙光照贴图 (generic.vert v_TexCoord.zw = 第 2 UV 通道)
        let lm = null;
        if (combos && (combos.LIGHTMAP || combos.lightmap)) {
          const lmTex = textures[useNormalMap ? 2 : 1];
          if (lmTex) {
            const lu = u2 != null ? u2 : u;
            const lv = v2 != null ? v2 : v;
            lm = this._texSample(lmTex, lu, lv);
          }
        }
        let light = [0, 0, 0], spec = [0, 0, 0];
        const lights = this.lights;
        for (let li = 0; li < Math.min(lights.length, 4); li++) {
          const L = lights[li];
          const lv = v3sub(L.origin, wp);
          const dist = Math.sqrt(v3dot(lv, lv)) || 1;
          const ldir = [lv[0] / dist, lv[1] / dist, lv[2] / dist];
          const attn = sat((L.radius - dist) / L.radius);
          const h = v3norm(v3add(viewDir, ldir));
          const specDot = Math.max(0, v3dot(h, normal));
          const c = [L.color[0] * L.intensity, L.color[1] * L.intensity, L.color[2] * L.intensity];
          const st = Math.pow(specDot, specPower) * specStrength * attn;
          let sr = st * c[0], sg = st * c[1], sb = st * c[2];
          const lightDot = v3dot(ldir, normal);
          const hl = lightDot * 0.5 + 0.5;
          const ld = lightDot + (hl - lightDot) * gLight;
          const rim = metallic * 2;
          const rimTerm = Math.pow(Math.max(0, 1 - Math.max(0, v3dot(normal, viewDir))) * Math.pow(hl, 0.25), 6 - rim) * rim;
          const a2 = attn * attn;
          const dl = sat(ld) + rimTerm;
          let dr = c[0] * dl * a2, dg = c[1] * dl * a2, db = c[2] * dl * a2;
          // ── 官方 generic.frag:83-95: lightmap 只乘第 0 盏灯的 diffuse 与 specular;
          //    第 1-3 盏灯在 lightmap **之后**相加 (旧实现把 4 盏全部乘 lightmap →
          //    arsenal 刀片亮度中位数 3.4 而非 5.1, 见 .test-cache/audit-arsenal.md §4)
          if (li === 0 && lm) {
            dr *= lm[0]; dg *= lm[1]; db *= lm[2];
            sr *= lm[0]; sg *= lm[1]; sb *= lm[2];
          }
          light[0] += dr; light[1] += dg; light[2] += db;
          spec[0] += sr; spec[1] += sg; spec[2] += sb;
        }
        // 环境: generic.vert:77 用**顶点法线**做 sky/ambient 混合; frag:97 在 lightmap 之外相加
        const upMix = v3dot(nGeom, [0, 1, 0]) * 0.5 + 0.5;
        const amb = [
          this.skylightColor[0] + (this.ambientColor[0] - this.skylightColor[0]) * upMix,
          this.skylightColor[1] + (this.ambientColor[1] - this.skylightColor[1]) * upMix,
          this.skylightColor[2] + (this.ambientColor[2] - this.skylightColor[2]) * upMix,
        ];
        light = [light[0] + amb[0], light[1] + amb[1], light[2] + amb[2]];
        let r = albedo[0] * light[0] + spec[0];
        let g = albedo[1] * light[1] + spec[1];
        let b = albedo[2] * light[2] + spec[2];
        // REFLECTION (generic.frag:100-106): 偏移用的是**切线空间**法线的 xy
        // (官方此处 normal 仍是 DecompressNormal 的切线法线, 未世界化)
        if (combos && (combos.REFLECTION || combos.reflection) && textures[3]) {
          const suv = su != null ? su : u;
          const svv = sv != null ? sv : v;
          const offN = nMapTS || normal;
          const ref = this._texSample(textures[3], suv + offN[0] * 0.01, svv + offN[1] * 0.01);
          r += ref[0] * 0.35;
          g += ref[1] * 0.35;
          b += ref[2] * 0.35;
        }
        return [sat(r), sat(g), sat(b), albedo[3]];
      }

      // ── ricepod 族自定义着色器 (源码: <project>/shaders/*.vert|frag, 逐行复刻) ──
      // 这些 shader **不使用场景 ambient/skylight/灯** —— 光向是 shader 里的常量,
      // 官方画面靠自发光/常量光照。落到通用受光分支时 (ambient=0, 无灯) 必然全黑,
      // 这就是 ricepod 全帧均值 0.3/255 的成因 (.test-cache/fix-particles-light.md)。
,
    _shadeSkybox(u, v, textures) {
        // skybox.frag: gl_FragColor = vec4(texSample2D(g_Texture0, v_TexCoord).rgb, 1.0)
        const c = this._texSample(textures && textures[0], u, v);
        return [c[0], c[1], c[2], 1];
      }

      // ricepod.frag (含 SELFILLUM combo)
,
    _shadeRicepod(u, v, wp, n, eye, uniforms, textures, combos) {
        const c = this._texSample(textures && textures[0], u, v);
        const selfillum = !!(combos && (combos.selfillum || combos.SELFILLUM));
        if (selfillum) {
          // #if SELFILLUM  float lighting = 1.5;  → color *= 1.5
          return [sat(c[0] * 1.5), sat(c[1] * 1.5), sat(c[2] * 1.5), 1];
        }
        // 常量光向 (ricepod.vert:14 / frag:8-9) —— 与场景灯/环境无关
        const LD = [-0.577350259, 0.577350259, 0.577350259];
        const SKY = [0, -3, 0];
        const nn = v3norm(n);
        let dirl = Math.max(0, v3dot(nn, LD));
        const skyL = Math.max(0, v3dot(nn, SKY));
        const viewDir = v3norm(v3sub(eye, wp));
        const halfDir = v3norm(v3add(LD, viewDir));
        const spec = Math.max(0, v3dot(halfDir, nn));
        // smoothstep(0.3, 0.15, color.r) = 1 - smoothstep(0.15, 0.3, r)
        const t1 = sat((c[0] - 0.15) / (0.3 - 0.15));
        const sstep = 1 - (t1 * t1 * (3 - 2 * t1));
        dirl += Math.pow(spec, 25 + 100 * sstep) * 2;
        // v_BoostColor: 三个喷口位置附近的邻近提亮 (ricepod.vert:31-35 常量)
        let boost = 0;
        for (const J of [[-0.592, 0.396, -1.412], [0.592, 0.396, -1.412], [0, -0.608, -1.412]]) {
          const dx = J[0] - wp[0], dy = J[1] - wp[1], dz = J[2] - wp[2];
          boost += 1 - Math.min(1, 2 * Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
        const lighting = [
          dirl * 1.15 + skyL * 0.4 + 15 * boost,
          dirl * 1.1 + skyL * 0.45 + 6 * boost,
          dirl * 1.0 + skyL * 0.55 + 1 * boost,
        ];
        return [sat(c[0] * lighting[0]), sat(c[1] * lighting[1]), sat(c[2] * lighting[2]), 1];
      }

      // ricepodjet.vert 顶点脉冲 (v_TexCoord.y × v_Alpha 亮度)
,
    _ricepodJetVertex(local, uv, t) {
        const outside = uv[0] >= 0.5 ? 1 : 0;
        const pulseSpeed = 5.0 + outside * 10.0;
        const pulseAmount = 1.0 - uv[1];
        const pulseStrong = Math.sin(t * pulseSpeed);
        const s = 1.0 + (pulseStrong * 0.05) * pulseAmount;
        return [
          local[0] * s,
          local[1] * s,
          local[2] + pulseAmount * (Math.cos(t * pulseSpeed) * 0.02 + 0.02),
        ];
      }
,
    _shadeRicepodJet(u, v, textures, t) {
        // ricepodjet.frag: color *= v_TexCoord.y * v_Alpha; v_Alpha = pulseStrong*0.25+0.75
        const c = this._texSample(textures && textures[0], u, v);
        const outside = u >= 0.5 ? 1 : 0;
        const pulseStrong = Math.sin(t * (5.0 + outside * 10.0));
        const alpha = pulseStrong * 0.25 + 0.75;
        const k = v * alpha;
        return [sat(c[0] * k), sat(c[1] * k), sat(c[2] * k), 1];
      }

      // ricepodorbitalaurora.vert 顶点摆动
,
    _auroraVertex(local, uv, t) {
        return [
          local[0] + Math.sin(0.1 * t + uv[0] * 5) * 0.05,
          local[1] + Math.sin(0.1 * t + uv[0] * 3) * 0.02,
          local[2],
        ];
      }
,
    _shadeRicepodAurora(u, v, textures, t) {
        // ricepodorbitalaurora.frag + vert 的 v_TexCoord 变换 (逐行复刻)
        const frac = (x) => x - Math.floor(x);
        const tex = textures && textures[0];
        const xy = [u * 5.7 + frac(t * 0.05), v];
        const w = v * 8.3 - frac(t * 0.03);
        const z = u * 0.5 + frac(t * 0.04);
        const c1 = this._texSample(tex, xy[0], xy[1]);
        const c2 = this._texSample(tex, w, xy[1]);
        const cb = this._texSample(tex, z, xy[1]);
        const mixR = cb[0];
        const s0 = (e0, e1, x) => { const k = sat((x - e0) / (e1 - e0)); return k * k * (3 - 2 * k); };
        const alpha = s0(0.0, 0.1, u) * s0(1.0, 0.9, u) * 0.6;
        return [
          c1[0] * c2[0] + (cb[0] - c1[0] * c2[0]) * mixR,
          c1[1] * c2[1] + (cb[1] - c1[1] * c2[1]) * mixR,
          c1[2] * c2[2] + (cb[2] - c1[2] * c2[2]) * mixR,
          alpha,
        ];
      }
,
    _shadeRicepodThunder(u, v, textures, t) {
        // ricepodorbitalthunder.frag + vert 的 v_TexCoord 变换
        const tex = textures && textures[0];
        const amt = this._texR(tex, u * 0.777, v * 0.777) * this._texR(tex, u * 0.3 + Math.sin((1.7 + t) * 0.1), v * 0.3 + Math.cos(t * 0.22));
        const lo = [0.6, 0.5, 0.4], hi = [0.1, 0.3, 1.0];
        return [
          lo[0] + (hi[0] - lo[0]) * amt,
          lo[1] + (hi[1] - lo[1]) * amt,
          lo[2] + (hi[2] - lo[2]) * amt,
          amt,
        ];
      }
    
      // ══════════════════════════════════════════════════════════════════════
      // 官方 3D 默认壁纸自带着色器 (techno / audiophile / fantasticcar)
      // 源码: E:\...\defaultprojects\<场景>\shaders\<name>.{vert,frag}
      //       公共头 E:\...\wallpaper_engine\assets\shaders\common_*.h
      // 全部逐行复刻; 每条标注「官方 file:line」→ 本文件对应语句。
      // 这些 shader **不使用场景 ambient/skylight/灯** (光向是源码里的常量),
      // 落到通用受光分支时 (fantasticcar: ambient/skylight 均为 0 且无灯) 必然全黑 ——
      // 这就是三场景"平色帧"的直接成因 (.test-cache/fix-3d-shaders.md §2.1)。
      // ══════════════════════════════════════════════════════════════════════

      // technoglow (techno/glow.mdl)
      //   vert:13-17 → v_TexCoord = a_TexCoord; v_Color = g_Tint·(sin(g_Time)·0.5+0.5)
      //   frag:9-13  → glow = pow(tex.r, 5); result = mix(v_Color·glow, vec3(glow), glow)
      // g_Tint 默认 "1 1 1" (technoglow.vert:11 注释), techno 场景 project.json 用
      // schemecolor("0.1 0.2 0.7") 覆盖 → 材质 usershadervalues {schemecolor: tint}。
,
    _shadeTechnoGlow(u, v, uniforms, textures, t) {
        const tint = uniforms.tint || [1, 1, 1];
        const c = this._texSample(textures && textures[0], u, v);
        const glow = Math.pow(c[0], 5);                      // frag:9-10
        const s = Math.sin(t) * 0.5 + 0.5;                   // vert:15
        const out = [];
        for (let i = 0; i < 3; i++) {
          const a = tint[i] * s * glow;                      // v_Color · glow
          out.push(a + (glow - a) * glow);                   // frag:11 mix(a, vec3(glow), glow)
        }
        out.push(1);                                         // frag:13
        return out;
      }

      // technohex (techno/sphere.mdl) —— 顶点 varying v_Dot 见 _modelVertexVaryings
      //   vert:17    v_TexCoord = a_TexCoord·2 + g_Time·0.03
      //   vert:28-29 v_TexCoordAnim.xy = 0.1·a_TexCoord + g_Time·0.2
      //              v_TexCoordAnim.zw = 0.4·a_TexCoord.yx − g_Time·0.133
      //   frag:16    albedo = tex0(v_TexCoord).rgb
      //   frag:17    albedo.r += step(0.01, albedo.r)·step(albedo.r, 0.9)·5·v_Dot
      //   frag:19    result = albedo.rrr · g_Tint
      //   frag:21    accent = pow(albedo.g, 1.5)
      //   frag:22-23 modulate = smoothstep(0.05, 0.12, tex1(xy).r · tex1(zw).r)·2
      //   frag:25-26 flash = smoothstep(0.19, 0.2, tex1(xy·2).r − tex1(zw).r)·albedo.r
      //   frag:28    result += modulate·accent·g_Tint
      //   frag:30    result = mix(result, g_TintAccent·1.5, flash)
      //   frag:35    gl_FragColor = vec4(result · v_Dot, 1.0)
,
    _shadeTechnoHex(u, v, uniforms, textures, t, vv) {
        const tint = uniforms.tint || [1, 1, 1];             // 默认 "1 1 1"
        const accent = uniforms.tintaccent || [1, 1, 1];     // 默认 "1 1 1"
        const tex0 = textures && textures[0], tex1 = textures && textures[1];
        const dotv = vv ? vv[0] : 0;
        const c = this._texSample(tex0, u * 2 + t * 0.03, v * 2 + t * 0.03);   // vert:17
        const ar = c[0] + (c[0] >= 0.01 ? 1 : 0) * (c[0] <= 0.9 ? 1 : 0) * 5 * dotv; // frag:17
        const ag = c[1];
        const axy0 = 0.1 * u + t * 0.2, axy1 = 0.1 * v + t * 0.2;              // vert:28
        const azw0 = 0.4 * v - t * 0.133, azw1 = 0.4 * u - t * 0.133;          // vert:29
        let modulate = this._texR(tex1, axy0, axy1) * this._texR(tex1, azw0, azw1); // frag:22
        modulate = smoothstepFn(0.05, 0.12, modulate) * 2;                      // frag:23
        let flash = this._texR(tex1, axy0 * 2, axy1 * 2) - this._texR(tex1, azw0, azw1); // frag:25
        flash = smoothstepFn(0.19, 0.2, flash) * ar;                            // frag:26
        const acc = Math.pow(ag, 1.5);                                          // frag:21
        const out = [];
        for (let i = 0; i < 3; i++) {
          const base = ar * tint[i] + modulate * acc * tint[i];                 // frag:19,28
          const hi = accent[i] * 1.5;                                          // frag:30
          out.push((base + (hi - base) * flash) * dotv);                        // frag:30,35
        }
        out.push(1);
        return out;
      }

      // technoorbit (techno/orbitsmall.mdl 4 块 + rays.mdl) —— 三个 combo 分支
      //   vert:15-41 v_TexCoord.xy/.zw 的动画 + v_Color
      //     CLOUDS&&!RAYS: v_Color *= 1−|y·2−1|; v_TexCoord *= 1.2; x += t·0.01; x *= 10;
      //                    z = z·10 − t·0.01; y += t·0.2; w += t·0.3
      //     !CLOUDS&&RAYS: z −= t·speed·0.77; x += t·speed
      //     !CLOUDS&&!RAYS: x += t·speed
      //   frag:10-29 glow = tex0(xy).r
      //     CLOUDS&&!RAYS: result = glow · tex1(zw·0.5).r · v_Color
      //     !CLOUDS&&RAYS: result = v_Color · glow · tex0(zy).r
      //     !CLOUDS&&!RAYS: result = v_Color · pow(glow, 2)
      // g_Speed 默认 0.3 (technoorbit.vert:12); 三个材质用 constantshadervalues 覆盖。
      // UV 变换全是 a_TexCoord 的仿射函数 ⇒ 片元里用插值后的 uv 重算即官方等价。
,
    _shadeTechnoOrbit(u, v, uniforms, textures, t, combos) {
        const tint = uniforms.tint || [1, 1, 1];
        const speed = uniforms.speed != null ? uniforms.speed : 0.3;  // vert:12 默认
        const clouds = !!(combos && (combos.clouds || combos.CLOUDS));
        const rays = !!(combos && (combos.rays || combos.RAYS));
        const tex0 = textures && textures[0], tex1 = textures && textures[1];
        let x = u, y = v, z = u, w = v;                                // vert:15-16
        const color = [tint[0], tint[1], tint[2]];                     // vert:18
        if (clouds && !rays) {
          for (let i = 0; i < 3; i++) color[i] *= 1 - Math.abs(v * 2 - 1); // vert:21
          x *= 1.2; y *= 1.2; z *= 1.2; w *= 1.2;                      // vert:23
          x += t * 0.01; x *= 10;                                      // vert:24-25
          z = z * 10 - t * 0.01;                                       // vert:26
          y += t * 0.2;                                                // vert:27
          w += t * 0.3;                                                // vert:28
        } else if (!clouds && rays) {
          z -= t * speed * 0.77;                                       // vert:31
          x += t * speed;                                              // vert:32
        } else {
          x += t * speed;                                              // vert:38
        }
        if (clouds && !rays) {
          const gl = this._texR(tex0, x, y) * this._texR(tex1, z * 0.5, w * 0.5); // frag:10,14,20
          return [color[0] * gl, color[1] * gl, color[2] * gl, 1];
        }
        if (!clouds && rays) {
          const gl = this._texR(tex0, x, y) * this._texR(tex0, z, y);  // frag:10,23-25
          return [color[0] * gl, color[1] * gl, color[2] * gl, 1];
        }
        const gl = Math.pow(this._texR(tex0, x, y), 2);                // frag:10,28
        return [color[0] * gl, color[1] * gl, color[2] * gl, 1];
      }

      // audiophile (audiophile/bars.mdl) —— 顶点 varying color 见 _modelVertexVaryings,
      // 顶点位移 (y 按频谱缩放) 见 _modelVertexLocal
      //   vert:15-30 color = g_Tint · min(1, audio·0.8+0.2) · max(0, dot(a_Normal,(0,.707,.707))·.5+.5)
      //   frag:5     gl_FragColor = vec4(color, 1.0)
,
    _shadeAudiophile(u, v, vv) {
        if (!vv) return [0, 0, 0, 1];
        return [vv[0], vv[1], vv[2], 1];                     // frag:5
      }

      // audiophileflow (audiophile/flow.mdl)
      //   vert:14    fade = 1 − |(a_TexCoord.x − 0.5)·2|
      //   vert:16    color = g_Tint · fade · 0.25
      //   vert:23-30 v_TexCoord.xy = (a_TexCoord.x, a_TexCoord.y·15 + t·0.006)
      //              v_TexCoord.zw = (a_TexCoord.x − t·0.007, a_TexCoord.y·14 − t·0.0133)
      //   frag:8-9   threshold = 0.3, thresholdScale = 0.1
      //   frag:13-20 f0 = tex0(xy).r; f1 = tex1(zw).r; mixed = step 窗口乘积;
      //              refract = tex0(xy + f0·f1·0.6 + mixed).r;
      //              f1 += smoothstep(0.4,0.35,refract)·smoothstep(0.4,0.45,f1)
      //   frag:25    result = f0 · f1 · color
      // (color 是 a_TexCoord.x 的仿射函数 ⇒ 片元按插值 uv 重算 = 官方插值等价)
,
    _shadeAudiophileFlow(u, v, uniforms, textures, t) {
        const tint = uniforms.tint || [1, 1, 1];
        const fade = 1 - Math.abs((u - 0.5) * 2);            // vert:14
        const color = [tint[0] * fade * 0.25, tint[1] * fade * 0.25, tint[2] * fade * 0.25]; // vert:16
        const x = u, y = v * 15 + t * 0.006;                 // vert:26-27 (xy.y 被改写)
        const z = u - t * 0.007;                             // vert:30
        const w = v * 14 - t * 0.0133;                       // vert:28-29
        const tex0 = textures && textures[0], tex1 = textures && textures[1];
        const f0 = this._texR(tex0, x, y);                    // frag:13
        let f1 = this._texR(tex1, z, w);                      // frag:14
        const TH = 0.3, TS = 0.1;                             // frag:8-9
        const stepF = (e, s) => (s >= e ? 1 : 0);
        const mixed = stepF(TH - TS, f0) * stepF(f0, TH + TS)
                    * stepF(TH - TS, f1) * stepF(f1, TH + TS); // frag:16-17
        const refr = f0 * f1;                                  // frag:19
        const refr2 = this._texR(tex0, x + refr * 0.6 + mixed, y + refr * 0.6 + mixed); // frag:20 (vec2 逐分量同加)
        f1 += smoothstepFn(0.4, 0.35, refr2) * smoothstepFn(0.4, 0.45, f1);             // frag:21
        const k = f0 * f1;                                     // frag:25
        return [color[0] * k, color[1] * k, color[2] * k, 1];
      }

      // audiophileglow (audiophile/glow.mdl)
      //   vert:17-19 audio = min(1, g_AudioSpectrum16Left[0]); position.xy *= audio
      //   vert:21    color = g_Tint · audio · 0.2
      //   frag:9-11  result = tex0(v_TexCoord).rgb; gl_FragColor = vec4(result · color, 1.0)
      // ⚠ audio = 0 (渲染器无音频输入) ⇒ position.xy·0 使 4 顶点退化, 该层**正确地**
      //   不产生像素 (官方同一公式; 见报告"音频依赖"节, 不做任何默认值填充)。
,
    _shadeAudiophileGlow(u, v, uniforms, textures) {
        const tint = uniforms.tint || [1, 1, 1];
        const audio = Math.min(1, this._audioBin(0)[0]);      // vert:17-18
        const c = this._texSample(textures && textures[0], u, v); // frag:9
        return [c[0] * tint[0] * audio * 0.2, c[1] * tint[1] * audio * 0.2, c[2] * tint[2] * audio * 0.2, 1];
      }

      // grid (audiophile/grid.mdl skin1=grid2 + fantasticcar/grid.mdl)
      // 顶点 varying (v_WorldPosition.xz + v_HalfDir) 见 _modelVertexVaryings
      //   vert:21    gl_Position = mul(vec4(a_Position,1), g_ViewProjectionMatrix)  ← 无 Model 矩阵
      //   vert:26-27 viewDir = normalize(g_EyePosition − vec3(wx, 0, wz)); v_HalfDir = lightDir + viewDir
      //   frag:17    blend = 1 − length(v_WorldPosition)/3
      //   frag:18-20 bump = tex0(v_TexCoord).rgb; bump.yz = bump.yz·2 − 1
      //   frag:22    screenUV = (v_ScreenPos.xy / v_ScreenPos.z)·0.5 + 0.5 = NDC·0.5+0.5
      //   frag:27    albedo = tex1(screenUV + bump.yz·0.02).rgb      ← tex1 = _rt_Reflection
      //   frag:30    bump.x += 1
      //   frag:35-36 specular = pow(max(dot(normalize(v_HalfDir), normalize(vec3(−bump.y,1,bump.z))),0), 100)·0.2
      //   frag:38    blend = saturate(blend)   ← **仅 fantasticcar 的 grid.frag 有这一行**
      //   frag:39    gl_FragColor = vec4(albedo·bump.x + specular, blend)
      // 两版差异 (audiophile 无 saturate) 在本光栅化器里等价: 未 saturate 时 blend<0 的
      // 像素被 `col[3] <= 0.003` 丢弃, saturate 后 blend=0 同样丢弃; blend>1 不可能
      // (length ≥ 0)。故统一取 saturate。
      // screenUV → 本实现: v_ScreenPos.xy/v_ScreenPos.z 就是 NDC; 官方 RT 纹理 v 轴向上,
      // 而插件 _rt_ 快照是画布的**自上而下**副本, 故等价坐标是 (su+0.5/W, sv+0.5/H)
      // (即"取本像素"—— 官方反射缓冲里画的正是镜像场景, 本插件无反射 pass, 见报告未决点)。
,
    _shadeGrid(u, v, textures, su, sv, vv) {
        const p = vv || [0, 0, 0, 1, 0];
        const wx = p[0], wz = p[1];
        const blendRaw = 1 - Math.sqrt(wx * wx + wz * wz) / 3;        // frag:17
        const bump = this._texSample(textures && textures[0], u, v);  // frag:18
        const by = bump[1] * 2 - 1, bz = bump[2] * 2 - 1;             // frag:20
        const bx = bump[0] + 1;                                       // frag:30
        const sU = (su != null ? su : 0) + 0.5 / this.W;              // frag:22 (NDC→窗口)
        const sV = (sv != null ? sv : 0) + 0.5 / this.H;
        const albedo = this._texSample(textures && textures[1], sU + by * 0.02, sV + bz * 0.02); // frag:27
        const H = v3norm([p[2], p[3], p[4]]);                         // frag:35 normalize(v_HalfDir)
        const N = v3norm([-by, 1, bz]);
        let spec = Math.max(0, v3dot(H, N));                          // frag:35
        spec = Math.pow(spec, 100) * 0.2;                             // frag:36
        const blend = sat(blendRaw);                                  // frag:38
        return [albedo[0] * bx + spec, albedo[1] * bx + spec, albedo[2] * bx + spec, blend]; // frag:39
      }

      // car (fantasticcar/models/car/body.mdl 6 块) —— 顶点 varying v_Var0/v_Var1 见
      // _modelVertexVaryings; 切线数据 a_Tangent4 见 _meshTangent4 (stride 48)
      //   vert:21-22 worldPos = mul(vec4(a_Position,1), g_ModelMatrix); gl_Position = worldPos·g_ViewProjectionMatrix
      //   vert:28-34 NORMALMAP: v_Var0/v_Var1 = 切线空间的光/视方向; 否则世界法线 + lightDir+viewDir
      //   frag:30-31 albedo = tex0(v_TexCoord); alpha = 0.4
      //   frag:35    normal = DecompressNormal(tex1(v_TexCoord))  (common_fragment.h:19-32)
      //   frag:47-50 lighting = max(0, dot(lightDir, normal)); lighting²·0.9
      //   frag:52-58 specular = pow(max(dot(normalize(halfDir), normal),0), g_SpecularPower)
      //              METAL: ×smoothstep(0, 0.1, sin(specular·g_SpecularSineScale))
      //              ×g_SpecularStrength; SPECULARALPHA: ×albedo.a
      //   frag:64-72 PAINTWORK: albedo.rgb = mix(g_PaintColor, g_PaintColorStripes, albedo.r)·albedo.g
      //              MASKPAINTCOLOR: albedo.rgb *= mix(vec3(1), g_PaintColor, step(0.5, albedo.a))
      //              否则 albedo.rgb *= g_PaintColor
      //   frag:74-75 gl_FragColor.rgb = (g_AmbientColor·0.2 + lighting)·albedo.rgb + specular; a = alpha
      // uniform 默认值取自官方注释: specularstrength 1 / specularpower 6 /
      // specularsinescale 15 / paintcolor "1 1 1" / paintcolorstripes "0 0 0" /
      // ambientcolor "1 1 1" (car.frag:22-27)。
,
    _shadeCar(u, v, uniforms, textures, vv, combos) {
        const cb = combos || {};
        const tex0 = textures && textures[0], tex1 = textures && textures[1];
        const useNM = !!(cb.NORMALMAP || cb.normalmap) && !!tex1;
        const albedo = this._texSample(tex0, u, v);                    // frag:30
        const alpha = 0.4;                                             // frag:31
        let normal, lightDir, halfDir;
        if (useNM) {
          const nTS = this._decompressNormal(tex1, u, v);               // frag:35
          lightDir = v3norm([vv[0], vv[1], vv[2]]);                     // frag:38
          const viewDir = v3norm([vv[3], vv[4], vv[5]]);                // frag:39
          halfDir = v3norm(v3add(lightDir, viewDir));                   // frag:40
          normal = nTS;
        } else {
          lightDir = LIGHT_DIR_111;                                     // frag:42
          normal = v3norm([vv[0], vv[1], vv[2]]);                       // frag:43
          halfDir = v3norm([vv[3], vv[4], vv[5]]);                      // frag:44
        }
        let lighting = Math.max(0, v3dot(lightDir, normal));            // frag:47-48
        lighting *= lighting;                                           // frag:49
        lighting *= 0.9;                                                // frag:50
        let specular = Math.max(0, v3dot(halfDir, normal));             // frag:52 (两者均已归一化)
        specular = Math.pow(specular, uniforms.specularpower != null ? uniforms.specularpower : 6); // frag:54
        if (cb.metal || cb.METAL) {                                     // frag:56
          const sss = uniforms.specularsinescale != null ? uniforms.specularsinescale : 15;
          specular = specular * smoothstepFn(0.0, 0.1, Math.sin(specular * sss));
        }
        specular *= uniforms.specularstrength != null ? uniforms.specularstrength : 1; // frag:58
        if (cb.specularalpha || cb.SPECULARALPHA) specular *= albedo[3]; // frag:61
        const pc = uniforms.paintcolor || [1, 1, 1];
        let rgb;
        if (cb.paintwork || cb.PAINTWORK) {                             // frag:65
          const ps = uniforms.paintcolorstripes || [0, 0, 0];
          rgb = [0, 1, 2].map((i) => (pc[i] + (ps[i] - pc[i]) * albedo[0]) * albedo[1]);
        } else if (cb.maskpaintcolor || cb.MASKPAINTCOLOR) {            // frag:68
          const k = albedo[3] >= 0.5 ? 1 : 0;
          rgb = [0, 1, 2].map((i) => albedo[i] * (1 + (pc[i] - 1) * k));
        } else {                                                        // frag:70
          rgb = [0, 1, 2].map((i) => albedo[i] * pc[i]);
        }
        const amb = uniforms.ambientcolor || [1, 1, 1];                 // 默认 "1 1 1"
        return [
          (amb[0] * 0.2 + lighting) * rgb[0] + specular,                 // frag:74
          (amb[1] * 0.2 + lighting) * rgb[1] + specular,
          (amb[2] * 0.2 + lighting) * rgb[2] + specular,
          alpha,                                                        // frag:75
        ];
      }

      // dome (fantasticcar/models/dome/dome.mdl)
      //   vert:12-13 gl_Position = MVP·pos; domeColor = mix(g_Tint·0.333, g_Tint, a_TexCoord.y)
      //   frag:5     gl_FragColor = vec4(domeColor, 1.0)
      // g_Tint 默认 "0.315, 0.135, 0.1125" (dome.vert:9 注释); fantasticcar 场景
      // schemecolor("0.5725 0.7098 0.8078") 经 usershadervalues 覆盖。
      // (a_TexCoord.y 的线性混合 ⇒ 片元按插值 v 重算即官方等价)
,
    _shadeDome(u, v, uniforms) {
        const tint = uniforms.tint || [0.315, 0.135, 0.1125];
        const out = [];
        for (let i = 0; i < 3; i++) {
          const lo = tint[i] * 0.333;                     // vert:13 g_Tint·0.333
          out.push(lo + (tint[i] - lo) * v);
        }
        out.push(1);
        return out;
      }

      // shadow (fantasticcar/models/util/shadow.mdl)
      //   vert:10-11 gl_Position = MVP·pos; shadowAlpha = pow(1 − a_TexCoord.y, 2)·0.8
      //   frag:5     gl_FragColor = vec4(0, 0, 0, shadowAlpha)
      // (pow(1−v, 2) 是插值 v 的函数; 用片元插值 v 重算 = 官方插值等价)
,
    _shadeShadow(u, v) {
        return [0, 0, 0, Math.pow(1 - v, 2) * 0.8];        // vert:11 + frag:5
      }

      // DecompressNormal (官方 common_fragment.h:19-32): 按纹理容器格式选通道。
      // 与 _shadeGeneric 内联分支逐字相同, 抽出后两处共用 (TEX1FORMAT 由引擎在编译期
      // 从实际纹理格式推出 ⇒ 这里用 loadTexture 得到的 tex.format 等价)。
,
    _decompressNormal(tex, u, v) {
        const nm = this._texSample(tex, u, v);
        const fmt = tex && tex.format;
        let nx, ny;
        if ((fmt >= 3 && fmt <= 7) || fmt === 12) {   // ETC1..DXT1 / BC7: x←w, y←y(0.965 缩放)
          nx = nm[3] * 2 - 1.0;
          ny = nm[1] * 2 - 0.965;
        } else if (fmt === 8) {                      // RG88: x←r, y←g
          nx = nm[0] * 2 - 1.0;
          ny = nm[1] * 2 - 1.0;
        } else {                                     // 默认 (RGBA8888 等): x←w, y←y
          nx = nm[3] * 2 - 1.0;
          ny = nm[1] * 2 - 1.0;
        }
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        return [nx, ny, nz];
      }

      // 纹理采样 (wrap, 双线性 — 与 GPU texSample2D 默认一致)
,
    _texR(tex, u, v) {
        if (!tex) return 0.5;
        const x = ((u % 1) + 1) % 1, y = ((v % 1) + 1) % 1;
        const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
        const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
        const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * tex.width + x0) * 4, i10 = (y0 * tex.width + x1) * 4;
        const i01 = (y1 * tex.width + x0) * 4, i11 = (y1 * tex.width + x1) * 4;
        const top = tex.rgba[i00] * (1 - tx) + tex.rgba[i10] * tx;
        const bot = tex.rgba[i01] * (1 - tx) + tex.rgba[i11] * tx;
        return (top * (1 - ty) + bot * ty) / 255;
      }
,
    _texA(tex, u, v) {
        if (!tex) return 0;
        const x = ((u % 1) + 1) % 1, y = ((v % 1) + 1) % 1;
        const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
        const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
        const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * tex.width + x0) * 4 + 3, i10 = (y0 * tex.width + x1) * 4 + 3;
        const i01 = (y1 * tex.width + x0) * 4 + 3, i11 = (y1 * tex.width + x1) * 4 + 3;
        const top = tex.rgba[i00] * (1 - tx) + tex.rgba[i10] * tx;
        const bot = tex.rgba[i01] * (1 - tx) + tex.rgba[i11] * tx;
        return (top * (1 - ty) + bot * ty) / 255;
      }
,
      // 写入式采样 (零分配热路径; dev 线 GLSL/效果栈移植所需):
  //   _texSampleInto(tex, u, v, wrap, out) → 采样写入 out[0..3], 返回 out
  //   _texRG(tex, u, v, wrap, out)         → 只取 R/G 两通道
_texSampleInto(tex, u, v, clamp = false, out) {
        if (!tex) { out[0] = 1; out[1] = 1; out[2] = 1; out[3] = 1; return out; }
        // 非有限坐标 (效果数学透视溢出等) → 返回 0, 避免 NaN 传播到输出 (黑斑)
        if (!isFinite(u) || !isFinite(v)) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0; return out; }
        let x, y;
        if (clamp) {
          x = Math.min(0.999999, Math.max(0, u));
          y = Math.min(0.999999, Math.max(0, v));
        } else {
          x = ((u % 1) + 1) % 1;
          y = ((v % 1) + 1) % 1;
        }
        const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
        const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
        const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * tex.width + x0) * 4, i10 = (y0 * tex.width + x1) * 4;
        const i01 = (y1 * tex.width + x0) * 4, i11 = (y1 * tex.width + x1) * 4;
        for (let c = 0; c < 4; c++) {
          const top = tex.rgba[i00 + c] * (1 - tx) + tex.rgba[i10 + c] * tx;
          const bot = tex.rgba[i01 + c] * (1 - tx) + tex.rgba[i11 + c] * tx;
          out[c] = (top * (1 - ty) + bot * ty) / 255;
        }
        return out;
      },

_texRG(tex, u, v, clamp = false, out2) {
        if (!tex) { out2[0] = 1; out2[1] = 1; return out2; }
        if (!isFinite(u) || !isFinite(v)) { out2[0] = 0; out2[1] = 0; return out2; }
        let x, y;
        if (clamp) {
          x = Math.min(0.999999, Math.max(0, u));
          y = Math.min(0.999999, Math.max(0, v));
        } else {
          x = ((u % 1) + 1) % 1;
          y = ((v % 1) + 1) % 1;
        }
        const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
        const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
        const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * tex.width + x0) * 4, i10 = (y0 * tex.width + x1) * 4;
        const i01 = (y1 * tex.width + x0) * 4, i11 = (y1 * tex.width + x1) * 4;
        const topR = tex.rgba[i00] * (1 - tx) + tex.rgba[i10] * tx;
        const botR = tex.rgba[i01] * (1 - tx) + tex.rgba[i11] * tx;
        out2[0] = (topR * (1 - ty) + botR * ty) / 255;
        const topG = tex.rgba[i00 + 1] * (1 - tx) + tex.rgba[i10 + 1] * tx;
        const botG = tex.rgba[i01 + 1] * (1 - tx) + tex.rgba[i11 + 1] * tx;
        out2[1] = (topG * (1 - ty) + botG * ty) / 255;
        return out2;
      },

_texSample(tex, u, v, clamp = false) {
        if (!tex) return [1, 1, 1, 1];
        // 非有限坐标 (效果数学透视溢出等) → 返回 0, 避免 NaN 传播到输出 (黑斑)
        if (!isFinite(u) || !isFinite(v)) return [0, 0, 0, 0];
        let x, y;
        if (clamp) {
          x = Math.min(0.999999, Math.max(0, u));
          y = Math.min(0.999999, Math.max(0, v));
        } else {
          x = ((u % 1) + 1) % 1;
          y = ((v % 1) + 1) % 1;
        }
        const fx = x * tex.width - 0.5, fy = y * tex.height - 0.5;
        const x0 = Math.max(0, Math.min(tex.width - 1, Math.floor(fx)));
        const y0 = Math.max(0, Math.min(tex.height - 1, Math.floor(fy)));
        const x1 = Math.min(tex.width - 1, x0 + 1), y1 = Math.min(tex.height - 1, y0 + 1);
        const tx = fx - x0, ty = fy - y0;
        const i00 = (y0 * tex.width + x0) * 4, i10 = (y0 * tex.width + x1) * 4;
        const i01 = (y1 * tex.width + x0) * 4, i11 = (y1 * tex.width + x1) * 4;
        const out = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++) {
          const top = tex.rgba[i00 + c] * (1 - tx) + tex.rgba[i10 + c] * tx;
          const bot = tex.rgba[i01 + c] * (1 - tx) + tex.rgba[i11 + c] * tx;
          out[c] = (top * (1 - ty) + bot * ty) / 255;
        }
        return out;
      }
    
  });
}
