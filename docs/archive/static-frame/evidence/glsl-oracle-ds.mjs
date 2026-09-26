/**
 * glsl-oracle-ds.mjs — retro / deep_space / dna_fragment 涉及的全部着色器:
 * **官方源码独立直译成 JS 的 oracle** vs 插件实现, 逐点对照 (范式同 tmp-3dsh-oracle.mjs，该脚本未随仓库保留)。
 *
 * 覆盖 (file:line 为官方 <project>/shaders/ 行号):
 *   retro/shaders/bg.{vert,frag}           → _shadeBgRetro   (retro 的 bgfade 层)
 *   dna_fragment/shaders/bg.{vert,frag}    → _shadeBg        (dna 的 bg / bgfade 层)
 *   retro/shaders/retro.{vert,frag}        → _retroImage     (retro / retro_dots 层)
 *   dna_fragment/shaders/curve.{vert,frag} → _shadeCurve
 *   dna_fragment/shaders/dna.{vert,frag}   → _shadeDna (片元) + _dnaVertex (顶点位移)
 *   deep_space/shaders/flowimage.{vert,frag} → _shadeFlowImage (多层变体)
 *
 * 方法: 在**真实渲染**里包一层, 给插件与 oracle 喂完全相同的输入 (u,v,纹理采样结果,
 * 屏幕尺寸), 逐点比较 0-1 通道值; 采样器两边共用 (采样器本身由 _texSample /
 * loadTexImage 提供, 不在本次审查范围)。比较口径 = 8bit UNORM 目标写入 (逐通道 clamp)。
 *
 * 用法: node docs/archive/static-frame/evidence/glsl-oracle-ds.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer } from '../../../../lib/scene-renderer.js';

const WE = 'E:\\SteamLibrary\\steamapps\\common\\wallpaper_engine';
const ROOT = path.join(WE, 'projects', 'defaultprojects');
Date.now = () => 1700000123456;
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// ── GLSL 语义原语 ────────────────────────────────────────────────
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sat = (x) => clamp(x, 0, 1);
const mix = (a, b, t) => a + (b - a) * t;
const frac = (x) => x - Math.floor(x);
const step = (e, x) => (x >= e ? 1 : 0);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const powv = (v, e) => [Math.pow(Math.max(0, v[0]), e), Math.pow(Math.max(0, v[1]), e), Math.pow(Math.max(0, v[2]), e)];
// common.h:9-14 hsv2rgb / common.h:16-26 rgb2hsv (逐行直译)
function hsv2rgb(c) {
  const K = [1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0];
  const p = [0, 1, 2].map((i) => Math.abs(frac(c[0] + K[i]) * 6.0 - K[3]));
  return [0, 1, 2].map((i) => c[2] * mix(K[0], clamp(p[i] - K[0], 0, 1), c[1]));
}
function rgb2hsv(RGB) {
  const P = (RGB[1] < RGB[2]) ? [RGB[2], RGB[1], -1.0, 2.0 / 3.0] : [RGB[1], RGB[2], 0.0, -1.0 / 3.0];
  const Q = (RGB[0] < P[0]) ? [P[0], P[1], P[3], RGB[0]] : [RGB[0], P[1], P[2], P[0]];
  const C = Q[0] - Math.min(Q[3], Q[1]);
  const H = Math.abs((Q[3] - Q[1]) / (6.0 * C + 1e-10) + Q[2]);
  const HCV = [H, C, Q[0]];
  const S = HCV[1] / (HCV[2] + 1e-10);
  return [HCV[0], S, HCV[2]];
}

// ── 官方源码直译 ─────────────────────────────────────────────────
// retro/shaders/bg.vert:16-35 + bg.frag:19-55
function orRetroBg(ctx, vs, u, v, W, H) {
  const tint = vs.uniforms.tint || [0.95, 0.85, 0.7];      // bg.frag:4 默认
  const texelRatio = W / H;                                // vert:25 g_TexelSize.y/g_TexelSize.x
  // vert
  const grungeUV = [(u * 2 - 1) * 0.75 * texelRatio, (v * 2 - 1) * 0.75];   // vert:29-30 (w = 1)
  const patUV = [u * 50 * texelRatio, v * 50];                              // vert:32
  const noiseXY = [vs.t * 0.001, 0];                                        // vert:34
  const noiseZW = [frac(noiseXY[0] * 64.0), texelRatio];                    // vert:35
  // frag
  const circleScroll = vs.t * 0.3;                                          // frag:19
  const blendTime = frac(circleScroll);                                     // frag:20
  const off = 1.0 / 50.0;                                                   // frag:21
  const align = [Math.floor(patUV[0] + circleScroll - blendTime) / 50.0,
    Math.floor(patUV[1] + circleScroll - blendTime) / 50.0];                // frag:22
  const clouds0 = mix(ctx._texA(vs.textures[0], align[0], align[1]),
    ctx._texA(vs.textures[0], align[0] + off, align[1] + off), blendTime);  // frag:24
  let clouds = smoothstep(0.4, 0.7, clouds0);                               // frag:26
  const vignette = smoothstep(1, 0, Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)); // frag:28
  let pattern = ctx._texA(vs.textures[1], patUV[0], patUV[1]);              // frag:30
  const nz = ctx._texSample(vs.textures[3], noiseXY[0], noiseXY[1]);        // frag:34 (.rg)
  const center = [nz[0] * 50, nz[1] * 50];
  let distToCenter = Math.sqrt((center[0] - Math.floor(patUV[0])) ** 2 + (center[1] - Math.floor(patUV[1])) ** 2) / 50.0; // frag:36
  distToCenter = distToCenter * 60 - 20 * noiseZW[0];                        // frag:37
  const ring = [Math.sin(Math.max(0, distToCenter)), Math.sin(noiseZW[0] * 3.141)]; // frag:39
  clouds -= ring[0] * step(distToCenter, 3.141) * 0.5 * ring[1];             // frag:40
  clouds = Math.max(0.2, clouds);                                            // frag:41
  pattern = smoothstep(clouds - 0.1, clouds, pattern);                       // frag:46
  let albedo = powv([0, 1, 2].map((i) => mix(tint[i], tint[i] * 0.9, pattern)), 1.0 / vignette); // frag:48
  const grunge = ctx._texA(vs.textures[2], grungeUV[0], grungeUV[1]);        // frag:52
  albedo = albedo.map((a) => a - sat(grunge - a));                           // frag:53
  return [albedo[0], albedo[1], albedo[2], 1.0];                             // frag:50/55
}

// dna_fragment/shaders/bg.vert:14-26 + bg.frag:14-32
function orDnaBg(ctx, vs, u, v, W, H) {
  const tint = vs.uniforms.tint || [0.5, 0.5, 0.5];
  const tint2 = vs.uniforms.tint2 || [0.5, 0.5, 0.5];
  const texelRatio = W / H;
  const cloudUV = [u + vs.t * 0.03, v + vs.t * 0.03, u * 2 - vs.t * 0.0111, v * 2 - vs.t * 0.0111]; // vert:24
  const patUV = [u * 50 * texelRatio, v * 50];                              // vert:25
  const clouds = Math.pow(ctx._texA(vs.textures[0], cloudUV[0], cloudUV[1]) *
    ctx._texA(vs.textures[0], cloudUV[2], cloudUV[3]) * 1.4, 2);            // frag:16-17
  const vignette = smoothstep(1.2, 0, Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)) * 2; // frag:18
  let pattern = ctx._texA(vs.textures[1], patUV[0], patUV[1]) * 0.1;        // frag:20
  pattern *= smoothstep(0.1, 0.7, Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2)); // frag:21
  const albedo = [0, 1, 2].map((i) => mix(tint[i], tint2[i], v * v) * (clouds + pattern) * vignette); // frag:23
  let alpha = 1.0;
  if (vs.combos && vs.combos.GRADIENT_FADE) alpha = smoothstep(0.2, 0.45, Math.abs(v - 0.5)); // frag:28
  return [albedo[0], albedo[1], albedo[2], alpha];
}

// retro/shaders/retro.vert:16-27 + retro.frag:13-41
// grungeUV(aU,aV) 由调用方给出: 官方 v_TexCoordGrunge 是**屏幕 clip 空间**
// (vert:19-20), 而 _retroImage 是纹理空间预处理 ⇒ 插件用 quad 局部 NDC 近似。
// 对照时两边共用同一近似, 差异因此只反映"被审查的数学"。
function orRetroPixel(ctx, vs, x, y, grungeUV, dots) {
  const w = vs.textures[0].width, h = vs.textures[0].height;
  const aU = (x + 0.5) / w, aV = (y + 0.5) / h;
  const tc = [aU * 0.997, aV * 0.997];                                       // vert:17
  if (dots) tc[0] *= 2;                                                      // vert:26
  const baseUV = [dots ? tc[0] - vs.t * 0.02 : tc[0], tc[1]];                // frag:14-18
  const col = ctx._texSample(vs.textures[0], baseUV[0], baseUV[1]);          // frag:20
  const guv = grungeUV(aU, aV);
  const grunge = ctx._texA(vs.textures[1], guv[0], guv[1]);                  // frag:21
  const base = rgb2hsv(vs.tint);                                             // vert:22-23
  const hsv = [base[0] + col[1] * 0.11, base[1], base[2] * col[2]];          // frag:26-27
  const rgb = hsv2rgb(hsv);                                                  // frag:28
  const albedo = [0, 1, 2].map((i) => rgb[i] - sat(grunge - rgb[i]));        // frag:30
  let a = col[3];                                                            // frag:22 vec4 albedo = col
  if (dots) {
    const stepOffset = Math.ceil(tc[1] * 4) * 0.24;                          // frag:33
    a *= step(tc[0], 1.1 + stepOffset);                                      // frag:34
    const kernelSize = smoothstep(0.1, 1.0, tc[0] - stepOffset) * 1.1;        // frag:36
    a *= smoothstep(kernelSize - 0.15, kernelSize, col[0]);                   // frag:37
  }
  return [albedo[0], albedo[1], albedo[2], a];                               // frag:40
}

// dna_fragment/shaders/curve.vert:15-18 + curve.frag:10-15
function orCurve(ctx, vs, u, v, t) {
  const freq = vs.uniforms.Freq != null ? vs.uniforms.Freq : 0;              // vert:6 默认 0
  const speed = vs.uniforms['Scroll speed'] != null ? vs.uniforms['Scroll speed'] : 0; // vert:5 默认 0
  const uv = [u, v * freq + t * speed * 0.1];                                // vert:17
  const op = ctx._texA(vs.textures[0], uv[0], uv[1]);                        // frag:11
  const tint = vs.uniforms.tint && vs.uniforms.tint.length ? vs.uniforms.tint : [0.5, 0.5, 0.5];
  return [tint[0] * op, tint[1] * op, tint[2] * op, 1];                      // frag:13
}

// dna_fragment/shaders/dna.vert:19-43 + dna.frag:12-22
function orDnaVertex(pos, t) {
  const timeOffset = frac(t * 0.1);                                          // vert:23
  const p = [pos[0], pos[1] + timeOffset * 0.5, pos[2]];                     // vert:24
  const rot2 = [Math.cos(timeOffset * 3.1416), Math.sin(timeOffset * 3.1416)]; // vert:27 (字面量 3.1416)
  return [p[0] * rot2[0] - p[2] * rot2[1], p[1], p[0] * rot2[1] + p[2] * rot2[0]]; // vert:28-29
}
function orDna(ctx, vs, u, v, n, viewDir) {
  const tint = vs.uniforms.tint && vs.uniforms.tint.length ? vs.uniforms.tint : [0.5, 0.5, 0.5];
  const tex = ctx._texSample(vs.textures[0], u, v);                          // frag:14
  const albedo = [0, 1, 2].map((i) => tint[i] * tex[i]);
  const nl = Math.hypot(viewDir[0], viewDir[1], viewDir[2]) || 1;
  const view = [viewDir[0] / nl, viewDir[1] / nl, viewDir[2] / nl];
  const nn = Math.hypot(n[0], n[1], n[2]) || 1;
  const nor = [n[0] / nn, n[1] / nn, n[2] / nn];
  const rimlight = 1.0 - (view[0] * nor[0] + view[1] * nor[1] + view[2] * nor[2]); // frag:18
  const k = 1.0 + rimlight;                                                  // frag:20
  return [albedo[0] * k, albedo[1] * k, albedo[2] * k, 1];                   // frag:14/21
}

// deep_space/shaders/flowimage.vert:25-45 + flowimage.frag:19-49 (多层变体 A)
function orFlowImage(ctx, vs, u, v, t) {
  const U = vs.uniforms;
  const bright = U.Bright != null ? U.Bright : 1;                            // frag:11
  const amp = U.Amount != null ? U.Amount : 1;                               // frag:12
  const sp = [U.Speed0 != null ? U.Speed0 : 0.01, U.Speed1 != null ? U.Speed1 : 0.01, U.Speed2 != null ? U.Speed2 : 0.01];
  const cyc = [
    [frac(t * sp[0]), frac(t * sp[0] + 0.5)],                                // vert:32
    [frac(t * sp[1]), frac(t * sp[1] + 0.5)],                                // vert:35
    [frac(t * sp[2] + 0.3333), frac(t * sp[2] + 0.5 + 0.3333)],              // vert:37
  ];
  const blend = [2 * Math.abs(cyc[0][0] - 0.5), 2 * Math.abs(cyc[1][0] - 0.5), 2 * Math.abs(cyc[2][0] - 0.5)]; // vert:33,36,38
  const fc = ctx._texSample(vs.textures[0], u, v);                           // frag:20
  const mask = [(fc[0] - 0.5) * 2.0, (fc[1] - 0.5) * 2.0];                   // frag:21
  const off = [
    [mask[0] * amp * 0.1 * cyc[0][0], mask[1] * amp * 0.1 * cyc[0][0], mask[0] * amp * 0.1 * cyc[0][1], mask[1] * amp * 0.1 * cyc[0][1]],
    [mask[0] * amp * 0.1 * cyc[1][0], mask[1] * amp * 0.1 * cyc[1][0], mask[0] * amp * 0.1 * cyc[1][1], mask[1] * amp * 0.1 * cyc[1][1]],
    [mask[0] * amp * 0.1 * cyc[2][0], mask[1] * amp * 0.1 * cyc[2][0], mask[0] * amp * 0.1 * cyc[2][1], mask[1] * amp * 0.1 * cyc[2][1]],
  ];
  const s01 = ctx._texSample(vs.textures[1], u + off[0][0], v + off[0][1]);  // frag:27
  const s02 = ctx._texSample(vs.textures[1], u + off[0][2], v + off[0][3]);
  const albedo = s01.map((x, i) => mix(x, s02[i], blend[0]));                // frag:27-29
  const layers = [[vs.textures[2], off[1], blend[1]], [vs.textures[3], off[2], blend[2]]];
  for (const [tex, o, b] of layers) {
    const a1 = ctx._texSample(tex, u + o[0], v + o[1]);                      // frag:31-38
    const a2 = ctx._texSample(tex, u + o[2], v + o[3]);
    const samp = a1.map((x, i) => mix(x, a2[i], b));
    for (let i = 0; i < 3; i++) albedo[i] = mix(albedo[i], samp[i], samp[3]); // blendLayers:14
    albedo[3] = Math.max(albedo[3], samp[3]);                                 // blendLayers:15
  }
  return [sat(albedo[0] * bright), sat(albedo[1] * bright), sat(albedo[2] * bright), albedo[3]]; // frag:47-49
}

// ── 对照执行 ────────────────────────────────────────────────────
const stats = new Map();
function note(shader, kind, exp, got, at) {
  let s = stats.get(shader + '|' + kind);
  if (!s) { s = { n: 0, max: 0, sum: 0, over: 0, worst: null }; stats.set(shader + '|' + kind, s); }
  s.n++;
  // 比较口径 = 8bit UNORM 目标写入 (官方 gl_FragColor 落目标时逐通道 clamp 到 [0,1])
  let d = 0;
  for (let i = 0; i < Math.min(exp.length, got.length); i++) {
    d = Math.max(d, Math.abs(sat(exp[i]) - sat(got[i])));
  }
  s.sum += d;
  if (d > s.max) { s.max = d; s.worst = { at, exp: exp.map((v) => +v.toFixed(4)), got: got.map((v) => +v.toFixed(4)) }; }
  if (d > 1e-9) s.over++;
}
function report() {
  out('官方源码直译 (oracle) vs 插件实现 —— 逐点最大/平均绝对差 (0-1 通道值):');
  let bad = 0;
  for (const [k, s] of [...stats.entries()].sort()) {
    const [sh, kind] = k.split('|');
    out(`  ${sh.padEnd(20)} ${kind.padEnd(13)} n=${String(s.n).padStart(9)}  max=${s.max.toExponential(3)}  mean=${(s.sum / s.n).toExponential(3)}  >1e-9 的点=${s.over} (${(s.over / s.n * 100).toFixed(3)}%)`);
    if (s.max > 1e-9 && s.worst) out(`      最差点 @(${s.worst.at})  exp=[${s.worst.exp}]  got=[${s.worst.got}]`);
    // pixel 是浮点对照 (残差上界 = 0.5 LSB, 插件输出是 UNORM8); pixel8 是逐字节对照
    const tol = kind === 'pixel8' ? 1 / 255 + 1e-9 : kind === 'pixel' ? 0.5 / 255 + 1e-9 : 1e-9;
    if (s.max > tol) bad++;
  }
  out(bad ? `\n⚠ 有 ${bad} 组对照超出容差` : '\n✅ 全部对照通过 (浮点组 max|Δ| ≤ 1e-9 或 ≤ 0.5 LSB; 8bit 组逐字节相同)');
}

for (const name of ['retro', 'deep_space', 'dna_fragment']) {
  const dir = path.join(ROOT, name);
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  const r = new SceneRenderer(path.join(dir, pj.file), { width: 240, height: 135, time: 2.5, weAssetsDir: WE, log: () => {} });
  const W = r.W, H = r.H;
  const ctx = {
    _texSample: (...a) => r._texSample(...a),
    _texR: (...a) => r._texR(...a),
    _texA: (...a) => r._texA(...a),
  };
  // 1) retro 覆盖层: _retroImage (整图 CPU 预处理) —— 逐像素对照
  const proto = Object.getPrototypeOf(r);
  const origRetro = proto._retroImage;
  proto._retroImage = function (tex, gTex, uniforms, pass, t, Wp, Hp) {
    const got = origRetro.call(this, tex, gTex, uniforms, pass, t, Wp, Hp);
    if (Wp === W && Hp === H) {
      const combos = (pass && pass.combos) || {};
      const dots = !!(combos.DOTS || combos.dots);
      const vsx = { textures: [tex, gTex], tint: uniforms.tint || [0.95, 0.05, 0.1], uniforms, t };
      const texelRatio = Wp / Hp;   // 官方 g_TexelSize.y/g_TexelSize.x
      const grungeUV = (aU, aV) => [((aU - 0.5) * 2) * 0.75 * texelRatio, ((aV - 0.5) * 2) * 0.75];
      const w = tex.width, h = tex.height;
      const tag = 'retro(frag)' + (dots ? '[DOTS]' : '');
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const exp = orRetroPixel(ctx, vsx, x, y, grungeUV, dots);
          const di = (y * w + x) * 4;
          const gotPx = [got.rgba[di] / 255, got.rgba[di + 1] / 255, got.rgba[di + 2] / 255, got.rgba[di + 3] / 255];
          note(tag, 'pixel', exp, gotPx, x + ',' + y);
          // 8bit 量化后逐字节对照 (插件输出本就是 UNORM8 纹理; 浮点对照的残差上界
          // 恰好是 0.5 LSB = 1.96e-3, 即"只差舍入")
          const expQ = exp.map((v) => Math.round(sat(v) * 255));
          const gotQ = [got.rgba[di], got.rgba[di + 1], got.rgba[di + 2], got.rgba[di + 3]];
          note(tag, 'pixel8', expQ.map((v) => v / 255), gotQ.map((v) => v / 255), x + ',' + y);
        }
      }
    }
    return got;
  };
  // 2) model 分派: bg / curve / dna / flowimage
  const origMake = r._makeShadeFn.bind(r);
  r._makeShadeFn = (vs) => {
    const f = origMake(vs);
    const sh = vs.shaderName;
    const isRetroBg = sh === 'bg' && (!!(vs.tex2 && vs.tex3) || (vs.textureNames || []).length >= 4);
    if (!['bg', 'curve', 'dna', 'flowimage'].includes(sh)) return f;
    return (u, v, wp, n, eye, u2, v2, su, sv, tbn, vv) => {
      const got = f(u, v, wp, n, eye, u2, v2, su, sv, tbn, vv);
      let exp = null;
      if (sh === 'bg') exp = isRetroBg ? orRetroBg(ctx, vs, u, v, W, H) : orDnaBg(ctx, vs, u, v, W, H);
      else if (sh === 'curve') exp = orCurve(ctx, vs, u, v, vs.t);
      else if (sh === 'dna') exp = orDna(ctx, vs, u, v, n || [0, 0, 1], [eye[0] - wp[0], eye[1] - wp[1], eye[2] - wp[2]]);
      else if (sh === 'flowimage') exp = orFlowImage(ctx, vs, u, v, vs.t);
      if (exp) note(sh + (sh === 'bg' ? (isRetroBg ? '(retro)' : '(dna)') : ''), 'frag', exp, got, u.toFixed(5) + ',' + v.toFixed(5));
      return got;
    };
  };
  // 3) dna 顶点位移
  const origLocal = r._modelVertexLocal.bind(r);
  r._modelVertexLocal = (sh, local, uv, t, uniforms, normal) => {
    const got = origLocal(sh, local, uv, t, uniforms, normal);
    if (sh === 'dna') note('dna', 'vert-displace', orDnaVertex(local, t), got, uv.join(','));
    return got;
  };
  try { r.render(); } finally { proto._retroImage = origRetro; }
}

report();
process.exit(0);
