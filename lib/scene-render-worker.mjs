// 鍦烘櫙甯ф覆鏌?worker: 鎶?SceneRenderer 鐨勫悓姝?CPU 娓叉煋绉诲埌 worker 绾跨▼,
// 閬垮厤闃诲 DSH 涓昏繘绋嬩簨浠跺惊鐜?(澶у瀷澹佺焊娓叉煋鏁扮~鏁板崄绉?.
// 只渲染**单帧** (workerData.time)。多帧动画 (times 数组 → APNG) 已随 beta 场景动画
// GPU 鏁堟灉鍔犻€?(sf40h): gpuAccel=true 涓?x64 + supreium-headless-gl
// 鍙敤鏃? 鍐呯疆鏁堟灉/GLSL 鏁堟灉璧?WebGL (ANGLE) 鎵ц, 澶辫触鑷姩鍥為€€ CPU銆?
// 鍏ㄥ垎杈ㄧ巼鏃犻檷閲囨牱 (鏃犻┈璧涘厠).
//
// 鍙岃繍琛屾ā寮?(sf41): DSH 瀹夸富鏄?Electron (ABI 148), supreium-headless-gl
// 鐨?prebuilds 鍙湁 Node ABI (93/108/115/127/137/147) 鈫?node-gyp-build 鍦?
// Electron 閲屾姤 No native build found 鈫?GPU 鍚庣涓嶅彲鐢?鈫?鍏?CPU 鏃犲姞閫熴€?
// 鍥犳娓叉煋 worker 鐢卞涓荤敤 **绯荤粺 Node 瀛愯繘绋?* (child_process.fork +
// execPath=绯荤粺 node, ABI 127) 鍚姩, 鑰岄潪 Electron worker_threads銆?
// 涓ょ妯″紡鍏辩敤鏈剼鏈?
//   - fork 妯″紡: 鏃?parentPort, workerData 鐢卞涓诲厛 send({__workerData})
//   - worker_threads 妯″紡: parentPort + workerData (绾?Node 瀹夸富鍥為€€)
import { parentPort, workerData as wdWorkerData } from 'node:worker_threads';
import { SceneRenderer, encodePng, decodePngBuffer } from './scene-renderer.js';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { statSync, readFileSync, existsSync } from 'node:fs';

// fork 瀛愯繘绋?(绯荤粺 Node): 鏃?parentPort 鈫?璧?process.send/on('message');
// worker_threads 妯″紡: parentPort 瀛樺湪 (绾?Node 瀹夸富鍥為€€)銆?
const viaFork = typeof parentPort === 'undefined' || parentPort === null;

// sf41 璇婃柇: 涓庡涓诲悓鍐?~/.dsh-wallpaper-engine/gpu-diag.log (寮傛, 涓嶉樆濉炴覆鏌?
let _gpuDiagBuf = [];
let _gpuDiagTimer = null;
function gpuDiag(...args) {
  try {
    const line = new Date().toISOString() + ' [worker] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    _gpuDiagBuf.push(line);
    if (!_gpuDiagTimer) {
      _gpuDiagTimer = setTimeout(() => {
        _gpuDiagTimer = null;
        const lines = _gpuDiagBuf.join('');
        _gpuDiagBuf = [];
        try {
          const p = join(homedir(), '.dsh-wallpaper-engine', 'gpu-diag.log');
          import('node:fs/promises').then((fsp) => fsp.writeFile(p, lines, { flag: 'a' })).catch(() => {});
        } catch { /* ignore */ }
      }, 200);
    }
  } catch { /* ignore */ }
}
gpuDiag('worker 鍚姩 viaFork=', viaFork, 'node=', process.version, 'modules=', process.versions.modules, 'electron=', process.versions.electron || 'none');
// 璇婃柇: 璁板綍鍙兘褰卞搷 node-gyp-build 鍒ゅ畾鐨?env 鍙橀噺 + 鎺㈡祴 supreium 鍙姞杞芥€?
// (闈為樆濉? 涓?await, 涓嶅欢杩熸秷鎭鐞?
try {
  const sus = {};
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'ELECTRON_INTERNAL_USE_ONLY', 'CHROME_CRASHPAD_PIPE_NAME']) {
    if (process.env[k] !== undefined) sus[k] = String(process.env[k]).slice(0, 60);
  }
  gpuDiag('env 鍙枒鍙橀噺:', sus);
  import('./we-renderer/gpu-gl/gl-core.js').then(({ getWebGL }) => {
    try { gpuDiag('getWebGL(force) =', getWebGL(true) !== null); } catch (e) { gpuDiag('getWebGL 鎺㈡祴寮傚父:', e.message.slice(0, 100)); }
  }).catch((e) => gpuDiag('gl-core import 澶辫触:', e.message.slice(0, 80)));
} catch (e) {
  gpuDiag('env 璇婃柇寮傚父:', e.message.slice(0, 80));
}

function post(msg, transfer) {
  if (viaFork) process.send(msg);
  else parentPort.postMessage(msg, transfer || []);
}

// 鈹€鈹€ 绌哄抚搴﹂噺 + 绮掑瓙鍨嬪绾哥┖甯у鏍?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 涓庡涓诲悓涓€闂ㄧ: lib/index.js:3181 `result.diff < result.checked * 0.0005`
// 鈬?绌虹櫧甯ц瀹夸富鍒ゅけ璐?鈫?鍥為€€缂╃暐鍥俱€傝繖閲岀敤**鍚屼竴绠楀紡**鑷祴, 闃堝€煎悓婧愬悓鍊笺€?
const BLANK_RATIO = 0.0005;

/** 绌哄抚搴﹂噺: step=8 缃戞牸涓婁笌 clearcolor 閫愰€氶亾宸?>24 鐨勯噰鏍风偣鍗犳瘮 (鍘熷疄鐜伴€愬瓧淇濈暀) */
function blankMetrics(canvas, ccv) {
  const cr0 = (ccv[0] || 0) * 255, cg0 = (ccv[1] || 0) * 255, cb0 = (ccv[2] || 0) * 255;
  const step = 8;
  let diff = 0, checked = 0;
  for (let y = 0; y < canvas.h; y += step) {
    for (let x = 0; x < canvas.w; x += step) {
      const i = (y * canvas.w + x) * 4;
      checked++;
      if (Math.abs(canvas.data[i] - cr0) > 24 || Math.abs(canvas.data[i + 1] - cg0) > 24 || Math.abs(canvas.data[i + 2] - cb0) > 24) diff++;
    }
  }
  return { diff, checked };
}

/** 甯ф槸鍚︾┖鐧?(涓庡涓婚棬绂佸悓涓€鍒ゆ嵁) */
const isBlank = (m) => m.checked > 0 && m.diff < m.checked * BLANK_RATIO;

/**
 * 绮掑瓙鍨嬪绾哥殑绌哄抚澶嶆牳鍊欓€夋椂鍒?鈥斺€?鍙敤**澹佺焊鑷甫鏁版嵁**鎺ㄥ, 鏃犻瓟鏁?
 *   瀹樻柟 `shimmering_particles` 鍞竴鍙灞傛槸 `dust motes` 绮掑瓙绯荤粺
 *   (`particles/dustmotes.json`: starttime=50s, lifetimerandom 48鈥?0s), 鍥犳
 *   t=2.5s 鐨勮緭鍑?*纭疄**鏄叏娓呭睆甯?(瀹炴祴 3840脳720 闈為浂鍍忕礌 = 0) 鈥斺€?瀹樻柟鐢婚潰鏄?
 *   璇ョ矑瀛愮郴缁熼殢鏃堕棿绱Н鍒扮ǔ鎬佺殑鏍峰瓙, 涓嶆槸 bug銆傚涓?index.js 鐨勭┖甯ч棬绂佹棤娉曞尯鍒?
 *   "娓叉煋鍣ㄥ潖浜? 涓?"杩欎釜鏃跺埢鏈潵灏辫繕娌″紑濮嬪彂灏?, 鏁呭湪姝ゆ寜鍦烘櫙鏁版嵁閲嶈瘯鏇存櫄鏃跺埢:
 *     路 60                    : 閫氱敤鍏滃簳鏃跺埢 (瀹夸富闈欐€佸抚绾﹀畾鏃跺埢 2.5s 鐨?鍚庢湡绋虫€?瀵圭収)
 *     路 max(60, starttime+L): 鐗╃悊瀛︾ǔ鎬?鈥斺€?鏈€鑰佸彲鑳界矑瀛愬凡姝讳骸, 鍙戝皠閫熺巼宸插～婊?maxcount
 *     路 starttime + 2        : 鍒氬紑濮嬪彂灏勪箣鍚?(鐭鍛?鐬椂鐖嗗彂鐨勫绾?
 *   鍊欓€夊彧鍙?> 璇锋眰鏃跺埢鐨? 鎸変笂杩颁紭鍏堢骇閫愪釜璇曠畻, 鐢ㄥ涓诲悓娆鹃棬绂佸垽瀹? 閲囩敤绗竴涓€氳繃鐨勩€?
 *   瀹炴祴 (shimmering_particles 3840脳720): 60 鈫?diff 98.7% 閫氳繃 (maxSum 765);
 *   max(60,50+70)=120 鈫?diff 0% (绮掑瓙宸插叏閮ㄦ浜′笖 maxcount 璁℃暟宸茶€楀敖, 瑙佹姤鍛婃湭鍐崇偣),
 *   鍥犳"鍏?60 鍐嶇ǔ鎬?鐨勪紭鍏堢骇鏄繀瑕佺殑 鈥斺€?鍗曠敤 starttime+lifetime 浼氬彇鍒扮┖甯с€?
 */
function particleCandidateTimes(renderer, t0) {
  let visibleParticles = 0;
  let stMin = Infinity;
  let settle = 0;
  for (const o of renderer.objects || []) {
    if (!o || !o.particle) continue;
    try { if (!renderer._isVisible(o)) continue; } catch { /* 鍙鎬у垽瀹氬け璐?鈫?璁′负鍙 */ }
    visibleParticles++;
    let def = null;
    try { def = typeof o.particle === 'string' ? renderer.pkg.readJson(o.particle) : o.particle; } catch { def = null; }
    if (!def) continue;
    const st = Number(def.starttime) || 0;
    if (st < stMin) stMin = st;
    let life = 0;
    for (const ini of def.initializer || []) {
      if (!ini || !/^lifetime/i.test(String(ini.name || ''))) continue;
      life = Math.max(life, Number(ini.max) || 0, Number(ini.min) || 0);
    }
    if (life > 0) settle = Math.max(settle, st + life);
  }
  if (!visibleParticles) return [];
  const cands = [60];
  if (settle > 0) cands.push(Math.max(60, settle));
  if (Number.isFinite(stMin)) cands.push(stMin + 2);
  const uniq = [];
  for (const t of cands) {
    if (!Number.isFinite(t) || t <= t0 || uniq.includes(t)) continue;
    uniq.push(t);
  }
  return uniq.slice(0, 3);
}

// 鈹€鈹€ 鏉炬暎椤圭洰鐨勫満鏅富鏂囦欢鍚?(缂洪櫡 2 鐨勭敓浜у墠缃? 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 瀹樻柟 defaultprojects 鐨?*鍦烘櫙涓绘枃浠跺悕涓嶆槸甯搁噺**: project.json 鐨?`file` 瀛楁澹版槑
// ricepod鈫抮icepod.json / audiophile / fantasticcar / techno (鍙︽湁 corsair_*/sheep 鏄?
// web/app 椤圭洰)銆傚涓?lib/index.js:3166 涓轰簡璁?SceneRenderer 鏀跺埌"鐩綍"鍏ュ弬, 鎶?
// `<dir>/<name>.json` 鎹㈡垚浜?dirname 鈬?鏂囦欢鍚嶄俊鎭涪澶?鈬?SceneRenderer 鍥為€€
// scene.json 鈬?鎶?"scene.json 涓嶅瓨鍦? 鈬?**鏁翠釜鍦烘櫙娓叉煋澶辫触**, 鐢熶骇璧板洖閫€閾?(涓荤汗鐞?
// 缂╃暐鍥?鈥斺€?涓庣己闄?1 鍚屼竴绫诲彲瑙佺棁鐘? 缂洪櫡 2 鐨勭潃鑹插櫒淇涔熷氨鏃犱粠鐢熸晥)銆?
// worker 渚у彧璇绘帰娴嬭ˉ鍥炰富鏂囦欢鍚?(涓嶆敼瀹夸富浠ｇ爜): 浠呭綋 project.json 澹版槑鐨?.json
// **瀛樺湪涓斾笉鏄?scene.json** 鏃舵墠鏀逛紶鍏ュ弬 鈬?鐜版湁鍙敤鍦烘櫙鐨勫叆鍙傞€愬瓧鑺備笉鍙樸€?
// ══ 采样时刻选点 (sf42a): 把"静态帧固定取 t=2.5"换成**按内容度量选点** ═══════════
// 背景 (docs/DEFAULT-SCENE-RENDER-AUDIT.md T11): 固定 t=2.5 对"开场暗景 / 长相机
// 路径 / 粒子尚未生成"的场景不具代表性 —— arsenal 的相机路径总长 225s, t=2.5 只走
// 1%, 实测 480×270 全帧均值 4.1/255(生产 4K 3.7/255)、非清屏 5.2%; audiophile 的
// 开场是纯平色渐变 (非清屏 6.3%, 唯一色 27); shimmering_particles 的 t=2.5 是**全
// 清屏空白**。旧实现只对"空白 + 按 condition 可见的粒子系统"这一种组合特殊重试,
// 覆盖不到"不空白但过暗/过平"的场景。
//
// 两段式, 全部确定性 (无 Math.random; 采样步长/候选/阈值/权重只由输入决定):
//   ① 请求时刻**先按生产尺寸渲染一次** —— 与旧代码逐字节同一条路径 (构造 → 预热 →
//      render → blankMetrics)。随后用**尺度无关的内容度量**判定该帧是否健康:
//      健康 ⇒ 直接采用请求时刻, **一个探针都不做**。于是"本来就正常的场景逐字节
//      不变"是**结构保证**, 而不是靠事后比对; 代价只是一次 ~3 万采样点的只读扫描。
//   ② 不健康 ⇒ 在**小尺寸探针帧** (宽 480, 高按生产宽高比) 上量化候选时刻
//      (固定梯 + 相机路径分位 + 循环动画分位 + 粒子 starttime 梯), 用内容评分选点;
//      只有"比请求时刻显著更好" (分差 ≥ MARGIN) 才切换。
//
// 阈值/权重的实测依据 (480×270 探针 + 生产尺寸复测; 全表见 .test-cache/fix-sampling-time.md):
//   生产尺寸 (3840 宽) 实测, 冻结 Date.now:
//     正常场景 t=2.5 下界: 非清屏 53.0%(razer_bedroom) / lit24 15.5% / 网格 33
//     退化场景 t=2.5 上界: arsenal 5.1%/3.4%/12, audiophile 6.3%/12.5%/12,
//                          shimmering_particles 0%/0%/0 (全清屏空白)
//   ⇒ 非清屏阈值 30% = 退化上界(6.3%)与正常下界(53.0%)的算术中点, 两侧余量 4.8×/1.8×;
//     lit24 阈值 10% 位于 3.4%(arsenal) 与 15.5%(razer_bedroom) 中点, 两侧 1.55×;
//     网格阈值 22 位于 12 与 33 之间, 两侧 1.8×/1.5×。
//   过曝糊 (shimmering 的加性饱和) 单独判: 饱和占比 ≥60% 且结构 <3% ⇒ 评分罚 1.5。
const SAMPLING = {
  PROBE_W: 480,                                  // 探针帧宽 (高按生产宽高比等比)
  MAX_PROBE: 8,                                  // 候选上限 (等距抽样保留首尾)
  HEALTH: { nonClear: 0.30, lit24: 0.10, gridFill: 22 },
  WASHED: { sat: 0.60, edgeFrac: 0.03 },
  MARGIN: 0.25,                                  // 切换所需最小评分增益
  FIXED: [8, 30, 60, 120, 200],                  // 与场景数据无关的固定梯 (覆盖长路径场景)
  REFINE_N: 8,                                   // 阶段一局部细扫的采样点数 (自包含)
  CAM_MIN: 32,                                   // 相机路径总长 ≥ 此值才取分位点 (秒)
  LOOP_MIN: 4,                                   // 循环动画时长 ≥ 此值才取分位点 (秒)
};
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const pct1 = (v) => (v * 100).toFixed(1) + '%';

/** 阶段二 (官方 preview 画像校准) **默认关闭**。依据 (`.test-cache/native-oracle-audit.md` §1.3 / §3.1 / C7):
 *  · 9/9 个点名场景的官方 preview 都是**正方形缩略图** (side 207–1080), 而场景
 *    `general.orthogonalprojection` 的宽高比是 1.778 / 2.333 / 5.333 ⇒ preview 与任何原始帧
 *    的几何都不一致, **结构上不是帧**, 不能作行为基准;
 *  · Retro 的 preview 还逐通道超出壁纸自带 `shaders/bg.frag` 导出的解析上界 (184/163/107);
 *  · 用户方针是"行为对照 WE 原生渲染", 而 preview 不是原生输出。
 *  ⇒ 默认决策输入只允许是**壁纸自带数据 + 渲染帧自身的内容度量**; preview 仅作实验:
 *    `DSH_WE_PREVIEW_CAL=1` 开启 (探索用), `DSH_WE_NO_PREVIEW_CAL=1` 强制关闭 (优先级更高)。
 *  关闭时**不读取也不解码 preview**, 阶段二的代码路径完全不进入。 */
function previewCalEnabled() {
  if (process.env.DSH_WE_NO_PREVIEW_CAL === '1') return false;
  return process.env.DSH_WE_PREVIEW_CAL === '1';
}

/** 阶段一的**局部细扫** (全自包含: 候选区间由粗扫候选的相邻间距与相机路径总长给出, 评分只用
 *  渲染帧自身的内容度量)。`DSH_WE_NO_SAMPLING_REFINE=1` 关闭 —— 用于 A/B 对照与用户兜底。 */
function samplingRefineEnabled() { return process.env.DSH_WE_NO_SAMPLING_REFINE !== '1'; }

/**
 * 内容度量 (确定性, 尺度无关): 采样步长 = round(w/240) ⇒ 无论 480 探针还是 4K 生产帧
 * 都取 ~240 列, 因此**同一套阈值**可同时用于探针帧与生产帧, 且不受分辨率影响。
 *   nonClear  与 general.clearcolor 逐通道差 > 24 的采样点占比 (宿主空帧门禁同一算据)
 *   lit24/64  亮度 ≥ 24 / ≥ 64 的占比 (过暗判据: 有实质亮度的内容)
 *   sat       任一通道 ≥ 250 的占比 (加性饱和 = 过曝糊的一半判据)
 *   uniq5     颜色量化到 5bit/通道后的唯一色数 (+uniqRatio 归一化)
 *   edgeFrac  相邻采样点 |Δluma| > 16 的占比 (结构度)
 *   gridFill  8×6 网格中 nonClear 占比 > 8% 的格子数 (内容分布: 避免内容挤在一角)
 */
function contentMetrics(canvas, ccv, rect) {
  const w = canvas.w, h = canvas.h, data = canvas.data;
  const cr = (ccv[0] || 0) * 255, cg = (ccv[1] || 0) * 255, cb = (ccv[2] || 0) * 255;
  // rect (可选) = 只统计的子矩形 (中心方裁口径用); 步长按 **子矩形的宽** 取 ⇒ 与全帧同量级列数
  const rw = rect ? rect.w : w, rh = rect ? rect.h : h;
  const ox = rect ? rect.x0 : 0, oy = rect ? rect.y0 : 0;
  const step = Math.max(1, Math.round(rw / 240));
  const cols = Math.floor((rw - 1) / step) + 1, rows = Math.floor((rh - 1) / step) + 1;
  const lum = new Float64Array(cols * rows);
  const cells = new Float64Array(48), cellN = new Float64Array(48), nbCells = new Float64Array(48);
  const uniq = new Set();
  let n = 0, sum = 0, nonClear = 0, lit24 = 0, lit64 = 0, sat = 0, nearBlack = 0, nb = 0;
  const chSum = [0, 0, 0];
  for (let ry = 0; ry < rows; ry++) {
    const y = oy + ry * step, rowOff = y * w;
    for (let rx = 0; rx < cols; rx++) {
      const i = (rowOff + ox + rx * step) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const l = (r * 299 + g * 587 + b * 114) / 1000;
      lum[ry * cols + rx] = l;
      n++; sum += l; chSum[0] += r; chSum[1] += g; chSum[2] += b;
      if (l < 8) nearBlack++;
      if (l >= 24) lit24++;
      if (l >= 64) lit64++;
      if (r >= 250 || g >= 250 || b >= 250) sat++;
      uniq.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      const nc = (Math.abs(r - cr) > 24 || Math.abs(g - cg) > 24 || Math.abs(b - cb) > 24) ? 1 : 0;
      nonClear += nc;
      const nbv = (r > 8 || g > 8 || b > 8) ? 1 : 0;      // 与官方 preview 同口径的"有内容"判据 (非黑)
      nb += nbv;
      const ci = Math.min(5, Math.floor(ry * 6 / rows)) * 8 + Math.min(7, Math.floor(rx * 8 / cols));
      cells[ci] += nc; cellN[ci]++;
      nbCells[ci] += nbv;
    }
  }
  let edgeSum = 0, edgeCnt = 0, edgeHit = 0;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const l = lum[ry * cols + rx];
      if (rx + 1 < cols) { const d = Math.abs(l - lum[ry * cols + rx + 1]); edgeSum += d; edgeCnt++; if (d > 16) edgeHit++; }
      if (ry + 1 < rows) { const d = Math.abs(l - lum[(ry + 1) * cols + rx]); edgeSum += d; edgeCnt++; if (d > 16) edgeHit++; }
    }
  }
  let gm = 0, filled = 0, gmNb = 0, filledNb = 0;
  const occ = new Float64Array(48);
  for (let i = 0; i < 48; i++) {
    occ[i] = cellN[i] ? cells[i] / cellN[i] : 0;
    gm += occ[i] / 48; if (occ[i] > 0.08) filled++;
    const o = cellN[i] ? nbCells[i] / cellN[i] : 0;
    gmNb += o / 48; if (o > 0.08) filledNb++;
  }
  let v = 0;
  for (let i = 0; i < 48; i++) v += (occ[i] - gm) * (occ[i] - gm) / 48;
  return {
    samples: n, step, cols, rows,
    mean: sum / n, nearBlack: nearBlack / n, nonClear: nonClear / n,
    chMean: [chSum[0] / n, chSum[1] / n, chSum[2] / n],
    lit24: lit24 / n, lit64: lit64 / n, sat: sat / n, nb: nb / n,
    uniq5: uniq.size, uniqRatio: uniq.size / Math.min(32768, n),
    edgeMean: edgeCnt ? edgeSum / edgeCnt : 0, edgeFrac: edgeCnt ? edgeHit / edgeCnt : 0,
    gridFill: filled, gridFillNB: filledNb, gridStd: Math.sqrt(v),
  };
}

/** 过曝糊: 大面积饱和 (加性累积) 且几乎没有结构 —— shimmering 的 t=60/120/200 是原型。
 *  只惩罚"糊"而不惩罚"亮": demon_core 的 t=2.5 sat 76.7% 但 edgeFrac 14.6% (结构充分),
 *  按此判据不算糊 (官方 preview sat 57.4% 同属该场景的固有亮度)。 */
function isWashed(m) { return m.sat >= SAMPLING.WASHED.sat && m.edgeFrac < SAMPLING.WASHED.edgeFrac; }

/** 请求时刻是否"健康" ⇒ 健康则一个探针都不做 (正常场景零影响的结构保证) */
function isHealthy(m) {
  return m.nonClear >= SAMPLING.HEALTH.nonClear
    && m.lit24 >= SAMPLING.HEALTH.lit24
    && m.gridFill >= SAMPLING.HEALTH.gridFill
    && !isWashed(m);
}

/** 不健康的原因 (gpu-diag 可检索的审计文本; 阈值直接引常量, 不会与判定漂移) */
function healthReasons(m) {
  const r = [];
  if (m.nonClear < SAMPLING.HEALTH.nonClear) r.push('非清屏 ' + pct1(m.nonClear) + '<' + pct1(SAMPLING.HEALTH.nonClear));
  if (m.lit24 < SAMPLING.HEALTH.lit24) r.push('lit24 ' + pct1(m.lit24) + '<' + pct1(SAMPLING.HEALTH.lit24));
  if (m.gridFill < SAMPLING.HEALTH.gridFill) r.push('网格 ' + m.gridFill + '<' + SAMPLING.HEALTH.gridFill);
  if (isWashed(m)) r.push('过曝糊 sat ' + pct1(m.sat) + ' 结构 ' + pct1(m.edgeFrac));
  return r;
}

/** 候选时刻评分 (仅在同尺度探针帧之间比较; 值域 ~[0, 5.5]) */
function samplingScore(m) {
  let s = 0;
  s += 2.0 * clamp01(m.lit24 / 0.50);                                  // 亮内容 (用户抱怨的是过暗)
  s += 1.5 * clamp01(m.nonClear / 0.60);                               // 覆盖率
  s += 0.8 * clamp01(m.uniqRatio / 0.25);                              // 色彩丰富度
  s += 0.7 * clamp01(m.edgeFrac / 0.06);                               // 结构度
  s += 0.5 * (m.gridFill / 48);                                        // 内容分布
  if (isWashed(m)) s -= 1.5;                                           // 过曝糊惩罚
  return Math.round(s * 1000) / 1000;
}

/** 相机路径总时长 (秒): 与 we-renderer/camera.js resolveCameraPose 的路径解析同构
 *  (strings→json.paths / {paths} / {transforms}; 每段有效时长 = max(末帧 timestamp, duration))。
 *  只读场景自带数据, 不引用任何时间常数。解析失败 → 0 (退化为固定梯)。 */
function cameraPathTotal(renderer) {
  try {
    const cam = renderer.scene && renderer.scene.camera;
    if (!cam || !Array.isArray(cam.paths)) return 0;
    const readJson = (p) => { try { return renderer.pkg.readJson(p); } catch { return null; } };
    let paths = [];
    for (const p of cam.paths) {
      if (typeof p === 'string') { const j = readJson(p); if (j && Array.isArray(j.paths)) paths = paths.concat(j.paths); }
      else if (p && Array.isArray(p.paths)) paths = paths.concat(p.paths);
      else if (p && Array.isArray(p.transforms)) paths.push(p);
    }
    let total = 0;
    for (const p of paths) {
      let lastT = 0;
      for (const x of p.transforms || []) { const ts = Number(x && x.timestamp); if (Number.isFinite(ts) && ts > lastT) lastT = ts; }
      const dur = Number(p.duration);
      total += Math.max(lastT, Number.isFinite(dur) ? dur : lastT);
    }
    return total;
  } catch { return 0; }
}

/** 最长的**循环类**属性动画时长 (秒)。一次性 (single) 动画不参与 —— 渲染器对单帧输出
 *  已直接取保持态 (core.js _resolveAnimations 的 staticFrame 分支), 与 t 无关。 */
function animationSpan(renderer) {
  const keys = ['alpha', 'scale', 'origin', 'angles', 'visible', 'color', 'size', 'brightness', 'parallaxDepth', 'zoom'];
  let maxSec = 0;
  for (const o of renderer.objects || []) {
    for (const k of keys) {
      const v = o && o[k];
      if (!v || typeof v !== 'object' || !v.animation) continue;
      const opts = v.animation.options || {};
      const mode = String(opts.mode || 'single');
      if (mode !== 'loop' && mode !== 'wraploop' && mode !== 'mirror' && mode !== 'reverse') continue;
      const fps = Number(opts.fps) > 0 ? Number(opts.fps) : 30;
      let last = 0;
      for (const ch of ['c0', 'c1', 'c2']) for (const f of (v.animation[ch] || [])) { const fr = Number(f && f.frame); if (Number.isFinite(fr) && fr > last) last = fr; }
      const sec = Math.max(last, Number(opts.length) || 0) / fps;
      if (sec > maxSec) maxSec = sec;
    }
  }
  return maxSec;
}

/** 等距抽样保留首尾 (确定性: 不依赖随机数, 同一输入同一结果) */
function subsample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = arr[Math.round(i * (arr.length - 1) / (n - 1))];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** 候选时刻: 固定梯 ∪ 相机路径八分位 ∪ 最长循环动画四分位 ∪ 粒子 starttime 梯 */
function candidateTimes(renderer, t0) {
  const set = SAMPLING.FIXED.slice();
  const camTotal = cameraPathTotal(renderer);
  if (camTotal >= SAMPLING.CAM_MIN) for (let i = 1; i <= 7; i++) set.push(camTotal * i / 8);
  const loop = animationSpan(renderer);
  if (loop >= SAMPLING.LOOP_MIN) for (const f of [0.25, 0.5, 0.75]) set.push(loop * f);
  for (const t of particleCandidateTimes(renderer, t0)) set.push(t);
  const uniq = [];
  for (const t of set) {
    if (!Number.isFinite(t) || t <= t0 + 0.5) continue;         // 只前进: 早于/等于请求时刻无意义
    const r = Math.round(t * 100) / 100;
    if (!uniq.includes(r)) uniq.push(r);
  }
  uniq.sort((a, b) => a - b);
  return subsample(uniq, SAMPLING.MAX_PROBE);
}

/**
 * 局部细扫时刻 (阶段一, 全自包含): 在"粗扫最优"两侧的**相邻候选间距**内取 REFINE_N 个点。
 * 区间边界只来自壁纸自身: 下界 0.5s, 上界 = 相机路径总长 (`scripts/camera_00.json` 的 duration
 * 累加, 由 `cameraPathTotal` 读), 无相机路径时取 300s。不含任何外部图画/常数时刻表。
 */
function refineTimes(cands, bestT, renderer) {
  const sorted = cands.slice().sort((a, b) => a - b);
  const i = sorted.findIndex((c) => Math.abs(c - bestT) < 0.01);
  const prev = i > 0 ? sorted[i - 1] : null;
  const next = i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : null;
  let gap = 22;                                             // 兜底 (≈固定梯最小间距)
  if (prev != null && next != null) gap = Math.min(bestT - prev, next - bestT);
  else if (prev != null) gap = bestT - prev;
  else if (next != null) gap = next - bestT;
  if (!(gap > 0)) return [];
  const camTotal = cameraPathTotal(renderer);
  const upper = camTotal >= 12 ? camTotal : 300;
  const lo = Math.max(0.5, bestT - gap), hi = Math.min(upper, bestT + gap);
  if (hi - lo < 0.5) return [];
  const out = [];
  for (let k = 0; k < SAMPLING.REFINE_N; k++) {
    const t = Math.round((lo + (hi - lo) * k / (SAMPLING.REFINE_N - 1)) * 100) / 100;
    if (cands.some((c) => Math.abs(c - t) < 0.01) || out.some((c) => Math.abs(c - t) < 0.01)) continue;
    out.push(t);
  }
  return out;
}

/**
 * 探针选点: 在小尺寸帧上量化候选时刻并按内容评分选点。
 * 两段: ① 粗扫 (`candidateTimes`, ≤8 个) ② **局部细扫** (围绕粗扫最优, 见 `refineTimes`)。
 * 返回 { adopted|null, scores, probeMs, t0Score, reason } —— 任何异常由调用方捕获
 * (异常 ⇒ 保持请求时刻, 与旧行为一致)。probe 实例用完即弃 (不与生产实例共享纹理
 * 缓存, 避免动画图集帧状态互相污染)。
 */
function probeSelect(renderer, sceneSrc, renderOpts, prodW, prodH, t0, content0, ccv) {
  const t0Score = samplingScore(content0);
  const cands = candidateTimes(renderer, t0);
  const res = { adopted: null, scores: [], probeMs: 0, t0Score, t0, cands, refine: [], reason: '' };
  if (!cands.length) { res.reason = '无候选时刻'; return res; }
  const pw = SAMPLING.PROBE_W;
  const ph = Math.max(2, Math.round(pw * prodH / prodW));
  // 计时用 performance.now (单调时钟): Date.now 会被场景脚本改写 (脚本沙箱直接拿到宿主
  // 的 Date 构造器), 而 razer_bedroom 这类场景确实在用它驱动颜色 —— 计时不得受其影响。
  const tStart = performance.now();
  const probe = new SceneRenderer(sceneSrc, {
    ...renderOpts, width: pw, height: ph, time: cands[0],
    log: () => {}, onDegraded: null,
  });
  const measure = (t, phase) => {
    probe.setTime(t);
    const c = probe.render();
    const m = contentMetrics(c, ccv);
    const row = {
      t, phase, score: samplingScore(m), washed: isWashed(m), healthy: isHealthy(m),
      mean: Math.round(m.mean * 100) / 100, nonClear: Math.round(m.nonClear * 1000) / 1000,
      lit24: Math.round(m.lit24 * 1000) / 1000, uniq5: m.uniq5,
      edgeFrac: Math.round(m.edgeFrac * 1000) / 1000, gridFill: m.gridFill,
    };
    res.scores.push(row);
    return row;
  };
  for (const t of cands) measure(t, 'coarse');
  const bestOf = () => { let b = null; for (const s of res.scores) if (!b || s.score > b.score + 1e-9) b = s; return b; };
  let best = bestOf();
  if (samplingRefineEnabled() && best) {
    res.refine = refineTimes(cands, best.t, renderer);
    for (const t of res.refine) measure(t, 'refine');
    best = bestOf();
  }
  res.probeMs = Math.round(performance.now() - tStart);
  res.probeW = pw; res.probeH = ph;
  res.best = best;
  if (best && best.score >= t0Score + SAMPLING.MARGIN) res.adopted = best.t;
  else res.reason = '增益不足 (' + (best ? best.score : 'n/a') + ' vs ' + t0Score + ' + ' + SAMPLING.MARGIN + ')';
  return res;
}

// ══ 阶段二: 用官方 preview 画像校准选点 (sf42b) ═══════════════════════════════
// 动机 (实测): 健康判据只保证"不退化", 不保证"代表性"。arsenal 走完阶段一停在 t=200,
// 中心方裁画像 mean=23.9 / lit24=23.7%, 而官方 preview.jpg (864×864) 是 63.5 / 73.2%;
// 官方取的是 225s 相机路径里**另一个更亮、更接近官方配色**的时刻。
//
// 三条口径纪律 (都由实测教训得来):
//  ① **1:1 中心方裁**: 官方 preview 都是方图, 直接拿它和 16:9 全帧比会误判 ——
//     deep_space 全帧 mean 81.5 vs preview 108.3 (差 25%) 看着"偏暗", 但中心方裁后
//     是 108.1 vs 108.3 (差 0.2%) ⇒ 两台口径必须一致。
//  ② **只在"已过健康门禁但仍远离参考"时才启用**: 触发条件 = |Δmean| > 25% 或 |Δlit24| > 20pp。
//     已经对齐的场景 (beach 12.0%, deep_space 0.2%, dna_fragment 8.4%) 一律不进入 ⇒ 不动。
//  ③ **上界/自洽性防反例**: 官方 preview 未必是本版本源码的输出 —— retro 的 preview
//     逐通道超出其 bg.frag 可证上界 (schemecolor 0.72/0.64/0.42 = 184/163/107; bg.frag 的
//     albedo = pow(mix(T,0.9T,pattern), 1/vignette) 只能把 T 变暗, grunge 只做减法) ——
//     preview 蓝通道均值 141.2 > 107+容差, 而**我们自己**的帧蓝通道均值 72.0 < 107 ⇒
//     该 preview 与默认用户属性不自洽 ⇒ 退回健康判据, 不参与校准。
const PREVIEW_CAL = {
  TRIGGER_DMEAN: 0.25,        // |Δmean|/max(8, refMean) > 25% ⇒ 需要校准
  TRIGGER_DLIT: 0.20,         // |Δlit24| > 20 个百分点 ⇒ 需要校准
  MARGIN: 0.30,               // 校准模式下的切换门槛 (比阶段一的 0.25 更严)
  // 画像距离的归一化尺度与权重 (权重依据见 .test-cache/fix-sampling-time.md §12)
  NORM: { MEAN: 0.35, CH: 0.20, UNIQ: 0.60, LIT: 0.30 },
  W: { MEAN: 2.0, CH: 1.6, UNIQ: 0.3, LIT: 0.9 },
  CEIL_TOL: 4,                // 通道上界容差 (0-255)
  COARSE_MAX: 20,             // 粗扫候选上限
  REFINE_MAX: 8,              // 细扫候选数
  COARSE_MIN_STEP: 6,         // 相机路径粗扫的最小步长 (秒)
  PREVIEW_MAX_BYTES: 16 * 1024 * 1024,
};

/** 1:1 中心方裁矩形 (与官方方图同几何口径) */
function centerSquareRect(canvas) {
  const side = Math.min(canvas.w, canvas.h);
  return { x0: Math.floor((canvas.w - side) / 2), y0: Math.floor((canvas.h - side) / 2), w: side, h: side };
}

/** 场景目录: 松散目录/工坊目录 (scene.pkg 的所在目录) —— preview.jpg 就在那里 */
function sceneProjectDir(sceneSrc) {
  try { if (statSync(sceneSrc).isDirectory()) return sceneSrc; } catch { /* 非目录 */ }
  return dirname(sceneSrc);
}

/** 读场景内文件原始字节 (松散目录用 fs; pkg 用容器读) */
function readSceneRaw(renderer, projDir, ref) {
  try {
    const b = renderer.pkg && renderer.pkg.read ? renderer.pkg.read(ref) : null;
    if (b && b.length) return b;
  } catch { /* 落到 fs */ }
  try { return readFileSync(join(projDir, ref)); } catch { return null; }
}

/** 官方 preview 参考画像 (1:1 中心方裁; 与 contentMetrics 同一套度量)。
 *  来源优先"同目录的 preview.jpg(.jpeg/.png)"; 目录里没有时再退回 pkg 容器内的同名条目
 *  (部分工坊场景把 preview 打进 scene.pkg) —— 两种来源都记录在 file 字段里, 便于审计。 */
async function previewReference(projDir, renderer) {
  const tryDecode = async (f, buf) => {
    if (!buf || buf.length > PREVIEW_CAL.PREVIEW_MAX_BYTES) return null;
    let img = null;
    if (f.endsWith('.png')) {
      const d = decodePngBuffer(buf);
      if (d) img = { w: d.width, h: d.height, data: d.rgba };
    } else {
      const jpeg = (await import('jpeg-js')).default;
      const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      img = { w: d.width, h: d.height, data: d.data };
    }
    if (!img || !img.w || !img.h) return null;
    const canvas = { w: img.w, h: img.h, data: img.data };
    const rect = centerSquareRect(canvas);
    return { ok: true, file: f, w: img.w, h: img.h, side: rect.w, ref: contentMetrics(canvas, [0, 0, 0], rect) };
  };
  for (const f of ['preview.jpg', 'preview.jpeg', 'preview.png']) {
    const p = join(projDir, f);
    if (!existsSync(p)) continue;
    try {
      const r = await tryDecode(f, readFileSync(p));
      if (r) return r;
      return { ok: false, reason: f + ' 解码失败' };
    } catch (e) { return { ok: false, reason: 'preview 解码失败: ' + String(e && e.message ? e.message : e).slice(0, 80) }; }
  }
  for (const f of ['preview.jpg', 'preview.jpeg', 'preview.png']) {
    try {
      const raw = renderer && renderer.pkg && renderer.pkg.read ? renderer.pkg.read(f) : null;
      if (!raw || !raw.length) continue;
      const r = await tryDecode(f + '(pkg)', raw);
      if (r) return r;
    } catch { /* 下一个候选 */ }
  }
  return { ok: false, reason: '无 preview.jpg (目录与 pkg 内都没有)' };
}

/** 场景**声明配色**: 材质 passes[].usershadervalues 把 user 颜色属性绑到着色器 uniform。
 *  .json 引用直接读; .mdl 等二进制容器扫内嵌 "materials/....json" 路径 (与 lib 的
 *  MDL 材质解析同一事实来源: mdl 里材质名是明文)。值取 renderer.userProps (与渲染一致)。 */
function declaredColorBindings(renderer, projDir) {
  const props = renderer.userProps || {};
  const bind = [];
  const seenMat = new Set();
  const addMaterial = (objName, matPath) => {
    if (!matPath || seenMat.has(matPath)) return;
    seenMat.add(matPath);
    const mat = readMatJson(renderer, projDir, matPath);
    for (const pass of (mat && mat.passes) || []) {
      for (const [propName, uniform] of Object.entries(pass.usershadervalues || {})) {
        const raw = props[propName];
        const vec = typeof raw === 'string' ? raw.trim().split(/\s+/).map(Number) : null;
        if (!vec || vec.length < 3 || vec.some((v) => !Number.isFinite(v))) continue;
        bind.push({ object: objName, material: matPath, shader: pass.shader, prop: propName, uniform, value: vec.slice(0, 3) });
      }
    }
  };
  for (const o of renderer.objects || []) {
    for (const ref of [o.image, o.model, o.sprite]) {
      if (typeof ref !== 'string') continue;
      if (/\.json$/i.test(ref)) {
        const j = readMatJson(renderer, projDir, ref);
        if (j && j.material) addMaterial(o.name || String(o.id), j.material);
      } else {
        const raw = readSceneRaw(renderer, projDir, ref);
        if (!raw) continue;
        const txt = raw.toString('latin1');
        const re = /materials\/[A-Za-z0-9_\-./]+\.json/g;
        let m;
        while ((m = re.exec(txt)) !== null) addMaterial(o.name || String(o.id), m[0]);
      }
    }
  }
  const gen = (renderer.scene && renderer.scene.general) || {};
  for (const k of ['ambientcolor', 'skylightcolor', 'clearcolor']) {
    const v = typeof gen[k] === 'string' ? gen[k].trim().split(/\s+/).map(Number) : null;
    if (v && v.length >= 3 && v.every(Number.isFinite)) bind.push({ object: 'general.' + k, material: '-', shader: '-', prop: k, uniform: '-', value: v.slice(0, 3) });
  }
  const ceiling = [0, 0, 0];
  for (const b of bind) for (let c = 0; c < 3; c++) ceiling[c] = Math.max(ceiling[c], b.value[c] * 255);
  return { bind, ceiling, provable: bind.some((b) => b.material !== '-') };
}

function readMatJson(renderer, projDir, p) {
  try {
    if (renderer.pkg && renderer.pkg.readJson) { const j = renderer.pkg.readJson(p); if (j) return j; }
  } catch { /* 落到 fs */ }
  try { return JSON.parse(readFileSync(join(projDir, p), 'utf8')); } catch { return null; }
}

/** 画像距离 (尺度稳健项; 只在**同尺度**帧之间比较) + 触发判据 */
function portraitDistance(cur, ref) {
  const dMean = Math.abs(cur.mean - ref.mean) / Math.max(8, ref.mean);
  const dCh = (Math.abs(cur.chMean[0] - ref.chMean[0]) + Math.abs(cur.chMean[1] - ref.chMean[1]) + Math.abs(cur.chMean[2] - ref.chMean[2])) / 765;
  const dUniq = Math.abs(cur.uniq5 - ref.uniq5) / Math.max(16, ref.uniq5);
  const dLit = Math.abs(cur.lit24 - ref.lit24);
  const N = PREVIEW_CAL.NORM, W = PREVIEW_CAL.W;
  const penalty = W.MEAN * clamp01(dMean / N.MEAN) + W.CH * clamp01(dCh / N.CH)
    + W.UNIQ * clamp01(dUniq / N.UNIQ) + W.LIT * clamp01(dLit / N.LIT);
  // **方向性触发**: 只在"参考画像**显著更亮/更亮堂**"时才向官方靠。理由 (实测反例):
  //   ricepod 的当前方裁均值 60.8 **高于**官方 42.1 (lit24 也基本持平 61.3% vs 63.9%),
  //   按绝对 25% 阈值它会触发并把画面**调暗**到 43.7 —— 而 ricepod 在 t=2.5 本来是健康帧
  //   (要求: 逐字节不变)。用户报告的病是"过暗"; "比官方缩略图更亮"不是要修的病。
  //   判据用相对分档 (>5% / >10pp) 而非 >0.5 的点差: 点差会让 2.6pp 的抖动也算"更亮"。
  const brighter = ref.mean >= cur.mean * 1.05 || ref.lit24 >= cur.lit24 + 0.10;
  return {
    dMean: Math.round(dMean * 1000) / 1000, dCh: Math.round(dCh * 1000) / 1000,
    dUniq: Math.round(dUniq * 1000) / 1000, dLit: Math.round(dLit * 1000) / 1000,
    penalty: Math.round(penalty * 1000) / 1000, brighter,
    trigger: brighter && (dMean > PREVIEW_CAL.TRIGGER_DMEAN || dLit > PREVIEW_CAL.TRIGGER_DLIT),
  };
}

/**
 * 上界/自洽性检查 (防 retro 这类"preview 不是本版本源码输出"的反例)。
 * 返回 { excluded, reason, ceiling, bindings } —— 只有**可证**时才排除 (正面证据),
 * 无可证配色上界 (provable=false) 时不排除, 但会在 gpu-diag 里写明"无法证明"。
 */
function previewGuard(ref, candidates, decl) {
  const out = { excluded: false, reason: '', ceiling: decl.ceiling.map((v) => Math.round(v)), provable: decl.provable, bindings: decl.bind.length };
  if (!decl.provable) { out.reason = '无可证配色上界 (材质未绑定 user 颜色属性) → 不做上界判定'; return out; }
  for (let c = 0; c < 3; c++) {
    const lim = decl.ceiling[c] + PREVIEW_CAL.CEIL_TOL;
    if (ref.chMean[c] > lim) {
      out.excluded = true;
      out.reason = 'preview 通道' + 'RGB'[c] + '均值 ' + ref.chMean[c].toFixed(1) + ' > 声明配色上界 ' + decl.ceiling[c].toFixed(1)
        + ' (+' + PREVIEW_CAL.CEIL_TOL + ') ⇒ preview 与默认用户属性不自洽';
      return out;
    }
  }
  for (const cand of candidates) {
    for (let c = 0; c < 3; c++) {
      const lim = decl.ceiling[c] + PREVIEW_CAL.CEIL_TOL;
      if (cand.chMean[c] > lim) {
        out.excluded = true;
        out.reason = '候选帧(t=' + cand.t + ') 通道' + 'RGB'[c] + '均值 ' + cand.chMean[c].toFixed(1) + ' > 可证上界 ' + decl.ceiling[c].toFixed(1)
          + ' ⇒ 上界不成立, 不参与校准';
        return out;
      }
    }
  }
  return out;
}

/** 校准候选时刻: 覆盖整个相机路径的**粗梯** (可持续平台) ∪ 固定梯 ∪ 当前时刻 */
function calibrationTimes(renderer, camTotal, curTime) {
  const set = [curTime];
  for (const t of [2.5, 8, 15, 30, 45, 60, 90, 120, 150, 180, 210, 240]) set.push(t);
  if (camTotal >= 12) {
    const n = Math.min(24, Math.max(8, Math.round(camTotal / PREVIEW_CAL.COARSE_MIN_STEP)));
    for (let i = 0; i <= n; i++) set.push(camTotal * i / n);
  }
  const loop = animationSpan(renderer);
  if (loop >= SAMPLING.LOOP_MIN) for (const f of [0.25, 0.5, 0.75, 1.5, 1.75]) set.push(loop * f);
  const upper = camTotal >= 12 ? camTotal + 1 : 300;
  const uniq = [];
  for (const t of set) {
    if (!Number.isFinite(t) || t <= 0.5 || t > upper) continue;
    const r = Math.round(t * 100) / 100;
    if (!uniq.includes(r)) uniq.push(r);
  }
  uniq.sort((a, b) => a - b);
  const keep = subsample(uniq, PREVIEW_CAL.COARSE_MAX);
  if (!keep.includes(Math.round(curTime * 100) / 100)) keep.push(Math.round(curTime * 100) / 100);
  return keep;
}

/**
 * 校准选点: 在参考画像距离上做**两段**搜索 (粗梯 → 局部细扫), 评分 = 内容分 − 画像距离惩罚。
 * 返回 { adopted|null, rows, cur, ... } —— 任何异常由调用方捕获 (保持阶段一结果)。
 */
function calibrationSelect(renderer, sceneSrc, renderOpts, prodW, prodH, curTime, curContent, ref, decl, ccv) {
  const camTotal = cameraPathTotal(renderer);
  const pw = SAMPLING.PROBE_W;
  const ph = Math.max(2, Math.round(pw * prodH / prodW));
  const tStart = performance.now();
  const probe = new SceneRenderer(sceneSrc, { ...renderOpts, width: pw, height: ph, time: curTime, log: () => {}, onDegraded: null });
  const rows = [];
  const measure = (t) => {
    probe.setTime(t);
    const c = probe.render();
    const rect = centerSquareRect(c);
    const port = contentMetrics(c, ccv, rect);
    const dist = portraitDistance(port, ref);
    rows.push({
      t, port, dist, score: Math.round((samplingScore(port) - dist.penalty) * 1000) / 1000,
      chMean: port.chMean.map((v) => Math.round(v * 10) / 10),
      mean: Math.round(port.mean * 100) / 100, uniq5: port.uniq5,
      lit24: Math.round(port.lit24 * 1000) / 1000, gridFillNB: port.gridFillNB,
    });
  };
  const coarse = calibrationTimes(renderer, camTotal, curTime);
  for (const t of coarse) measure(t);
  // 上界检查: 任一候选越过可证上界 ⇒ 放弃校准 (交由调用方保持阶段一结果)
  const guard = previewGuard(ref, rows, decl);
  if (guard.excluded) {
    return { adopted: null, rows, guard, probeMs: Math.round(performance.now() - tStart), probeW: pw, probeH: ph, coarse, reason: guard.reason };
  }
  let best = null;
  for (const r of rows) if (!best || r.score > best.score + 1e-9) best = r;
  const step = camTotal >= 12 ? camTotal / Math.max(8, Math.round(camTotal / PREVIEW_CAL.COARSE_MIN_STEP)) : 30;
  const span = Math.max(3, step / 2);
  const refine = [];
  for (let i = 0; i < PREVIEW_CAL.REFINE_MAX; i++) {
    const t = best.t - span + (2 * span) * i / (PREVIEW_CAL.REFINE_MAX - 1);
    if (t > 0.5 && t <= (camTotal >= 12 ? camTotal + 1 : 300)) refine.push(Math.round(t * 100) / 100);
  }
  const refineNew = refine.filter((t) => !rows.some((r) => Math.abs(r.t - t) < 0.01));
  for (const t of refineNew) measure(t);
  for (const r of rows) if (!best || r.score > best.score + 1e-9) best = r;
  const curRow = rows.find((r) => Math.abs(r.t - Math.round(curTime * 100) / 100) < 0.01) || rows[0];
  const improved = best && best.t !== curRow.t && best.score >= curRow.score + PREVIEW_CAL.MARGIN;
  return {
    adopted: improved ? best.t : null, rows, cur: curRow, best, guard, refine: refineNew,
    probeMs: Math.round(performance.now() - tStart), probeW: pw, probeH: ph, coarse,
    reason: improved ? 'score' : '增益不足 (' + (best ? best.score : 'n/a') + ' vs ' + curRow.score + ' + ' + PREVIEW_CAL.MARGIN + ')',
  };
}

function resolveSceneMainFile(src) {
  try {
    if (!statSync(src).isDirectory()) return src;
  } catch { return src; }
  try {
    const pj = JSON.parse(readFileSync(join(src, 'project.json'), 'utf8'));
    const f = pj && typeof pj.file === 'string' ? pj.file : null;
    if (f && /\.json$/i.test(f) && f !== 'scene.json' && existsSync(join(src, f))) {
      gpuDiag('鍦烘櫙涓绘枃浠跺悕琛ュ洖:', f, '(鐩綍鍏ュ弬涓㈠け鏂囦欢鍚?鈫?鍚﹀垯 scene.json 涓嶅瓨鍦?');
      return join(src, f);
    }
  } catch { /* 鏃?project.json / 瑙ｆ瀽澶辫触 鈫?淇濇寔鐩綍鍏ュ弬 */ }
  return src;
}

async function run(workerData) {
  const { src, width, height, time, weAssetsDir, videoFrames, gpuAccel } = workerData;
  const sceneSrc = resolveSceneMainFile(src);
  const renderOpts = { width, height, time, weAssetsDir, videoFrames, gpuAccel: gpuAccel === true, log: () => {} };
  // 娓叉煋闄嶇骇鐣欑棔 (缂洪櫡 2): 鏈疄鐜扮殑鑷畾涔夌潃鑹插櫒 / 闈欓粯涓㈠純鐨勫疄鏃剁粍浠剁瓑鐢?
  // SceneRenderer._degraded 涓婃姤 鈥斺€?瀹夸富榛樿涓嶆帴 (opts.onDegraded 缂虹渷涓?no-op),
  // 杩欓噷鎺ヨ繘 worker 璇婃柇鏃ュ織, 淇濊瘉"鐢婚潰琚潤榛橀檷绾?鍦ㄧ敓浜ц矾寰勪笂鍙煡銆?
  renderOpts.onDegraded = (d) => gpuDiag('degraded', JSON.stringify(d));
  gpuDiag('render 寮€濮?gpuAccel=', renderOpts.gpuAccel, 'src=', src, 'w=', width, 'h=', height, 'times=', times ? times.length : 0);
  const t0 = Date.now();

  try {
    // 鍗曞抚妯″紡 (闈欐€佸抚缂撳瓨)
      const renderer = new SceneRenderer(sceneSrc, renderOpts);
      // 鍧楄骞惰棰勮В鐮?(搂浜屽崄涔?: 娓叉煋鏄悓姝ョ殑, 骞惰鍙兘鏀惧湪瀹冧箣鍓嶃€?
      // 澶辫触/鏈惎鐢ㄩ兘鍙槸灏戦鐑嫢骞茬汗鐞?鈥斺€?鍚屾璺緞鐓у父瑙ｇ爜, 鍍忕礌涓嶅彉銆?
      try {
        const { warmSceneTextures } = await import('./we-renderer/predecode.js');
        const st = await warmSceneTextures(renderer);
        if (st) gpuDiag('棰勮В鐮?ms=', st.ms.toFixed(0), '鍊欓€?', st.textures, '浠诲姟=', st.tasks, 'workers=', st.workers, '宸叉彃鍏?', st.inserted);
      } catch (e) { gpuDiag('棰勮В鐮佸紓甯?蹇界暐):', e.message.slice(0, 120)); }
      const canvas = renderer.render();
      // 绌哄抚闂ㄧ缁熻: 涓?clearcolor 宸紓 < 0.05% 瑙嗕负绌虹櫧 (涓庡涓?lib/index.js:3181 鍚屾)
      const cc = renderer.scene && renderer.scene.general && renderer.scene.general.clearcolor;
      const ccv = typeof cc === 'string' && cc.trim() ? cc.trim().split(/\s+/).map(Number) : [0, 0, 0];
      let metrics = blankMetrics(canvas, ccv);
      let usedTime = time == null ? 0 : time;
      // ── 采样时刻选点 (sf42a, 判据/阈值出处见文件内 SAMPLING 段注释) ────────────
      // 请求时刻的健康判定用**生产帧自身**的度量 (比小探针更权威): 健康 ⇒ 一个探针都不
      // 做, 正常场景的渲染序列与旧代码逐字节相同 (构造 → 预热 → render → blankMetrics),
      // "逐字节不变"因此是结构保证; 不健康才在小探针帧上量化候选时刻选点。
      const tScan = performance.now();
      const content0 = contentMetrics(canvas, ccv);
      const scanMs = Math.round(performance.now() - tScan);
      const healthy = isHealthy(content0);
      const sampling = {
        requested: usedTime,
        adopted: usedTime,
        verdict: healthy ? 'healthy' : 'degenerate',
        reasons: healthy ? [] : healthReasons(content0),
        metrics: {
          mean: Math.round(content0.mean * 100) / 100, nonClear: Math.round(content0.nonClear * 1000) / 1000,
          lit24: Math.round(content0.lit24 * 1000) / 1000, lit64: Math.round(content0.lit64 * 1000) / 1000,
          sat: Math.round(content0.sat * 1000) / 1000, uniq5: content0.uniq5,
          edgeFrac: Math.round(content0.edgeFrac * 1000) / 1000, gridFill: content0.gridFill,
        },
        probeMs: 0, scanMs, scores: [], candidates: [],
      };
      gpuDiag('采样选点: 请求 t=' + usedTime + ' 度量[非清屏=' + pct1(content0.nonClear) + ' lit24=' + pct1(content0.lit24)
        + ' lit64=' + pct1(content0.lit64) + ' 网格=' + content0.gridFill + '/48 sat=' + pct1(content0.sat)
        + ' 结构=' + pct1(content0.edgeFrac) + ' 唯一色=' + content0.uniq5 + ' 均值=' + content0.mean.toFixed(2) + ']'
        + ' 扫描=' + scanMs + 'ms'
        + (healthy ? ' → 判健康, 不探针' : ' → 判退化[' + sampling.reasons.join(' ') + '], 进入探针选点'));
      if (!healthy) {
        try {
          const sel = probeSelect(renderer, sceneSrc, renderOpts, width, height, usedTime, content0, ccv);
          sampling.probeMs = sel.probeMs;
          sampling.probeW = sel.probeW;
          sampling.probeH = sel.probeH;
          sampling.t0Score = sel.t0Score;
          sampling.candidates = sel.cands || [];
          sampling.refine = sel.refine || [];
          sampling.scores = sel.scores || [];
          const candText = (sel.scores || []).map((s) => 't=' + s.t + ':' + s.score + (s.washed ? '(糊)' : '')).join(' ');
          if (sel.adopted != null) {
            renderer.setTime(sel.adopted);
            renderer.render();               // 与既有粒子复核同一模式: 复用同一实例重渲
            metrics = blankMetrics(canvas, ccv);
            usedTime = sel.adopted;
            sampling.adopted = sel.adopted;
            const after = contentMetrics(canvas, ccv);
            sampling.afterMetrics = {
              mean: Math.round(after.mean * 100) / 100, nonClear: Math.round(after.nonClear * 1000) / 1000,
              lit24: Math.round(after.lit24 * 1000) / 1000, sat: Math.round(after.sat * 1000) / 1000,
              uniq5: after.uniq5, edgeFrac: Math.round(after.edgeFrac * 1000) / 1000, gridFill: after.gridFill,
            };
            gpuDiag('采样选点: 采用 t=' + sel.adopted + ' (评分 ' + sel.best.score + ' ≥ ' + sel.t0Score + '+' + SAMPLING.MARGIN + ')'
              + ' 候选[' + candText + ']'
              + ' 采用后[非清屏=' + pct1(after.nonClear) + ' lit24=' + pct1(after.lit24) + ' 网格=' + after.gridFill + '/48 均值=' + after.mean.toFixed(2) + ']'
              + ' 探针=' + sel.probeW + 'x' + sel.probeH + ' 粗扫=' + (sel.cands || []).length + ' 细扫=' + (sel.refine || []).length + ' 探针耗时=' + sel.probeMs + 'ms');
          } else {
            gpuDiag('采样选点: 不切换 (最佳 ' + (sel.best ? 't=' + sel.best.t + ' 评分 ' + sel.best.score : 'n/a') + ', ' + sel.reason + ')'
              + ' 候选[' + candText + '] 粗扫=' + (sel.cands || []).length + ' 细扫=' + (sel.refine || []).length + ' 探针耗时=' + sel.probeMs + 'ms');
          }
        } catch (e) {
          gpuDiag('采样选点异常(保持请求时刻):', String(e && e.message ? e.message : e).slice(0, 160));
        }
      }
      // ── 阶段二: 官方 preview 画像校准 (sf42b, **默认关闭**, 见 previewCalEnabled 注释) ──
      // 只有 `DSH_WE_PREVIEW_CAL=1` 时才进入: 读 preview → 中心方裁画像 → 上界/自洽性检查 →
      // 按与参考画像的距离重选 (粗扫 + 细扫)。默认路径完全不读 preview。
      try {
        if (!previewCalEnabled()) sampling.preview = { ok: false, reason: 'preview 校准默认关闭 (实验开关 DSH_WE_PREVIEW_CAL=1)' };
        else {
        const projDir = sceneProjectDir(sceneSrc);
        const refRes = await previewReference(projDir, renderer);
        if (!refRes.ok) {
          sampling.preview = { ok: false, reason: refRes.reason };
        } else {
          const rect = centerSquareRect(canvas);
          const port = contentMetrics(canvas, ccv, rect);
          const decl = declaredColorBindings(renderer, projDir);
          const guard0 = previewGuard(refRes.ref, [], decl);
          const dist0 = portraitDistance(port, refRes.ref);
          sampling.preview = {
            ok: true, file: refRes.file, size: refRes.w + 'x' + refRes.h,
            ref: {
              mean: Math.round(refRes.ref.mean * 100) / 100, chMean: refRes.ref.chMean.map((v) => Math.round(v * 10) / 10),
              uniq5: refRes.ref.uniq5, lit24: Math.round(refRes.ref.lit24 * 1000) / 1000,
              nb: Math.round(refRes.ref.nb * 1000) / 1000, gridFillNB: refRes.ref.gridFillNB, sat: Math.round(refRes.ref.sat * 1000) / 1000,
            },
            cur: {
              mean: Math.round(port.mean * 100) / 100, chMean: port.chMean.map((v) => Math.round(v * 10) / 10),
              uniq5: port.uniq5, lit24: Math.round(port.lit24 * 1000) / 1000,
              nb: Math.round(port.nb * 1000) / 1000, gridFillNB: port.gridFillNB, sat: Math.round(port.sat * 1000) / 1000,
            },
            dist: dist0, ceiling: guard0.ceiling, provable: guard0.provable, excluded: guard0.excluded, reason: guard0.reason,
          };
          gpuDiag('采样选点(校准): preview=' + refRes.file + ' ' + refRes.w + 'x' + refRes.h + ' 参考[均值=' + refRes.ref.mean.toFixed(1)
            + ' 通道=' + refRes.ref.chMean.map((v) => v.toFixed(1)).join('/') + ' 唯一色=' + refRes.ref.uniq5
            + ' lit24=' + pct1(refRes.ref.lit24) + ' 网格=' + refRes.ref.gridFillNB + '/48]'
            + ' 当前(t=' + usedTime + ')[均值=' + port.mean.toFixed(1) + ' 通道=' + port.chMean.map((v) => v.toFixed(1)).join('/')
            + ' 唯一色=' + port.uniq5 + ' lit24=' + pct1(port.lit24) + ']'
            + ' 距离[Δmean=' + pct1(dist0.dMean) + ' Δ通道=' + dist0.dCh.toFixed(3) + ' Δuniq=' + pct1(dist0.dUniq) + ' Δlit24=' + (dist0.dLit * 100).toFixed(1) + 'pp 惩罚=' + dist0.penalty + ']'
            + ' 上界=' + guard0.ceiling.join('/') + (guard0.provable ? '(可证)' : '(不可证)')
            + (guard0.excluded ? ' → 排除: ' + guard0.reason : ' → 通过'));
          if (!guard0.excluded && dist0.trigger) {
            const cal = calibrationSelect(renderer, sceneSrc, renderOpts, width, height, usedTime, content0, refRes.ref, decl, ccv);
            sampling.calibration = {
              probeMs: cal.probeMs, probeW: cal.probeW, probeH: cal.probeH, coarse: cal.coarse.length,
              rows: cal.rows.length, curScore: cal.cur ? cal.cur.score : null,
              best: cal.best ? { t: cal.best.t, score: cal.best.score, mean: cal.best.mean, uniq5: cal.best.uniq5, lit24: cal.best.lit24, chMean: cal.best.chMean } : null,
              reason: cal.reason, rows_detail: cal.rows.map((r) => ({ t: r.t, score: r.score, mean: r.mean, uniq5: r.uniq5, lit24: r.lit24, chMean: r.chMean, penalty: r.dist.penalty })),
            };
            if (cal.adopted != null) {
              renderer.setTime(cal.adopted);
              renderer.render();
              metrics = blankMetrics(canvas, ccv);
              usedTime = cal.adopted;
              sampling.adopted = cal.adopted;
              const rect2 = centerSquareRect(canvas);
              const port2 = contentMetrics(canvas, ccv, rect2);
              const d2 = portraitDistance(port2, refRes.ref);
              sampling.preview.after = {
                mean: Math.round(port2.mean * 100) / 100, chMean: port2.chMean.map((v) => Math.round(v * 10) / 10),
                uniq5: port2.uniq5, lit24: Math.round(port2.lit24 * 1000) / 1000, gridFillNB: port2.gridFillNB,
              };
              sampling.preview.afterDist = d2;
              gpuDiag('采样选点(校准): 采用 t=' + cal.adopted + ' (评分 ' + cal.best.score + ' ≥ ' + cal.cur.score + '+' + PREVIEW_CAL.MARGIN + ')'
                + ' 采用后[均值=' + port2.mean.toFixed(1) + ' 通道=' + port2.chMean.map((v) => v.toFixed(1)).join('/') + ' 唯一色=' + port2.uniq5
                + ' lit24=' + pct1(port2.lit24) + ' Δmean=' + pct1(d2.dMean) + ' 惩罚=' + d2.penalty + ']'
                + ' 粗扫=' + cal.coarse.length + ' 细扫=' + (cal.rows.length - cal.coarse.length) + ' 探针=' + cal.probeW + 'x' + cal.probeH + ' 探针耗时=' + cal.probeMs + 'ms');
            } else {
              gpuDiag('采样选点(校准): 不切换 (' + (cal.best ? 't=' + cal.best.t + ' 评分 ' + cal.best.score : 'n/a') + ', ' + cal.reason + ')'
                + ' 探针耗时=' + cal.probeMs + 'ms');
            }
          }
        }
        }
      } catch (e) {
        sampling.preview = { ok: false, reason: '校准异常: ' + String(e && e.message ? e.message : e).slice(0, 120) };
        gpuDiag('采样选点(校准)异常(保持当前时刻):', String(e && e.message ? e.message : e).slice(0, 160));
      }
      // 绮掑瓙鍨嬪绾哥┖甯у鏍?(瑙?particleCandidateTimes 娉ㄩ噴): 浠呭綋鍘熷抚**绌虹櫧**涓斿満鏅惈
      // **鍙**绮掑瓙绯荤粺鏃舵墠閲嶆覆鏌?鈫?鏈夊唴瀹圭殑鍦烘櫙涓€寰嬭蛋鍘熻矾寰? 杈撳嚭閫愬瓧鑺備笉鍙樸€?
      // render() 鍘熷湴澶嶇敤 this.canvas 鈬?閲嶆覆鏌撲細瑕嗙洊鍘熷抚, 鏁呮瘡娆￠兘閲嶆柊搴﹂噺骞舵妸
      // diff/checked 涓庢渶缁堢紪鐮佺殑鍍忕礌缁戝湪涓€璧?(缁濅笉涓婃姤涓?PNG 涓嶇鐨勯棬绂侀噺)銆?
      if (isBlank(metrics)) {
        const cands = particleCandidateTimes(renderer, usedTime);
        if (cands.length) {
          const tried = [];
          let adopted = false;
          for (const t2 of cands) {
            renderer.setTime(t2);
            renderer.render();
            const m2 = blankMetrics(canvas, ccv);
            tried.push(t2 + '=' + (m2.checked ? (m2.diff / m2.checked * 100).toFixed(3) : 'n/a') + '%');
            metrics = m2;
            usedTime = t2;
            if (!isBlank(m2)) { adopted = true; break; } // 閲囩敤绗竴涓€氳繃瀹夸富闂ㄧ鐨勬椂鍒?
          }
          if (!adopted) {
            // 鍊欓€夊叏閮ㄤ粛绌虹櫧 鈬?杩樺師璇锋眰鏃跺埢鐨勫儚绱犱笌搴﹂噺 (PNG 涓庝笂鎶ョ殑 diff/checked 濮嬬粓涓€鑷?
            renderer.setTime(time == null ? 0 : time);
            renderer.render();
            metrics = blankMetrics(canvas, ccv);
            usedTime = time == null ? 0 : time;
          }
          gpuDiag('绌哄抚澶嶆牳(绮掑瓙): 璇锋眰 t=' + (time == null ? 0 : time)
            + ' 璇曠畻[' + tried.join(' ') + '] ' + (adopted ? '閲囩敤 t=' : '鏈噰鐢?鍏ㄩ儴绌虹櫧), 杩樺師 t=') + usedTime
            + ' diff=' + metrics.diff + '/' + metrics.checked);
        }
      }
      const png = encodePng(canvas.w, canvas.h, canvas.data);
      gpuDiag('鍗曞抚瀹屾垚 ms=', Date.now() - t0, 'gpuBackend=', renderer._getGpuBackend ? !!renderer._getGpuBackend() : 'n/a');
      // 鍗曞抚 PNG (4K 鍙揪 10-30MB) 涔熻蛋鏂囦欢浼犺緭 (涓庡甯т竴鑷? 閬垮厤 IPC 澶ф秷鎭?
      const pngTmp = join(tmpdir(), 'dsh-we-png-' + process.pid + '-' + Date.now() + '.png');
      const fsp = await import('node:fs/promises');
      // 淇: worker 鑷繁娓呯悊涓存椂鏂囦欢 鈥?瀹夸富鍙湪鎴愬姛璺緞 unlink, 鍙栨秷/琚潃鎴栬鍥?
      // 澶辫触鏃舵暟鐧?MB 鐨?png 鐣欏湪 %TEMP%; finally 瑕嗙洊 ack 鎴愬姛涓庢姏閿欎袱鏉¤矾寰?
      try {
        await fsp.writeFile(pngTmp, png);
        // usedTime = 瀹為檯閲囩敤鐨勬椂鍒?(绮掑瓙绌哄抚澶嶆牳浼氭敼鎴愭洿鏅氭椂鍒? 鏈Е鍙戞椂 === 璇锋眰鏃跺埢)
        post({ ok: true, pngPath: pngTmp, width, height, diff: metrics.diff, checked: metrics.checked, time: usedTime, sampling });
        await waitAck();
      } finally {
        await fsp.unlink(pngTmp).catch(() => {});
      }
      releaseGpu(renderer);
  } catch (e) {
    gpuDiag('render 澶辫触:', e.message);
    post({ ok: false, error: String(e && e.message ? e.message : e) });
    releaseGpu(null);
  }
}

// 绛夊緟瀹夸富纭 (sf41c): 杩涚▼淇濇寔瀛樻椿绛夊涓昏瀹屼复鏃舵枃浠跺悗 send ack, 闃?IPC
// 娑堟伅鍦ㄨ繘绋嬮€€鍑烘椂涓㈠け (姝ゅ墠 exit 134 / ok 涓嶅埌鐨勭粨鏋滀涪澶?銆?
function waitAck() {
  return new Promise((res) => {
    if (!viaFork) { setTimeout(res, 50); return; }
    const timer = setTimeout(() => { gpuDiag('waitAck 瓒呮椂 15s'); res(); }, 15000); // 鍏滃簳
    process.once('message', (m) => {
      if (m && m.__ack) { clearTimeout(timer); gpuDiag('鏀跺埌 ack'); res(); }
    });
  });
}

// 娓叉煋瀹屾垚/澶辫触鍚庨噴鏀?GPU 绾圭悊 (sf41b 鏄惧瓨娉勬紡淇):
// 澶氬抚鍔ㄧ敾 worker 澶嶇敤鍗曚釜 SceneRenderer, GL 涓婁笅鏂囪法甯у瓨娲?鈥?瀹屾垚鍚?
// 涓诲姩 dispose 閲婃斁鏄惧瓨 (杩涚▼鍗冲皢閫€鍑? 浣嗘樉瀛樺強鏃跺綊杩橀伩鍏嶆硠婕忔劅鐭?銆?
function releaseGpu() {
  try {
    import('./we-renderer/gpu-gl/gl-effect.js').then((m) => m.disposeGPU()).catch(() => {});
    // 淇: multipass 鎵ц鍣ㄨ嚜鎸佺殑 GL 涓婁笅鏂囧師鍏堟棤浜洪攢姣?(headless-gl 闇€鏄惧紡閲婃斁)
    import('./we-renderer/gpu-gl/gl-multipass.js').then((m) => { if (m.disposeGL) m.disposeGL(); }).catch(() => {});
  } catch { /* ignore */ }
}

if (viaFork) {
  // fork 瀛愯繘绋? 瀹夸富鍏?send workerData
  process.on('message', (m) => {
    if (m && m.__workerData) {
      run(m.__workerData).then(() => {
        // IPC channel 淇濇寔杩涚▼瀛樻椿 鈥?run 瀹屾垚鍚庝富鍔ㄩ€€鍑?(瀹夸富 finish 涔熶細
        // kill, 浣嗕富鍔ㄩ€€鍑洪伩鍏嶆寕璧?+ 鍙屼繚闄?
        setTimeout(() => process.exit(0), 100);
      }).catch(() => process.exit(1));
    }
  });
} else {
  run(wdWorkerData);
}
