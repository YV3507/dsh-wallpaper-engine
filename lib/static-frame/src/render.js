/**
 * we-static-frame —— 独立可用的静态帧渲染入口（库）。
 *
 * 这是**新写的适配层**，不属于从主插件镜像过来的 `src/**`（那部分是逐字节搬运的
 * 渲染器本体，禁止手改；见 README 的"搬运契约"）。
 *
 * 契约：
 *   renderFrame({ input, width, height, time, weAssetsDir, videoFrames, gpuAccel, warm })
 *     → { png, width, height, time, sceneSrc, ms }
 *   · input          `scene.pkg` 路径，或含 scene.json/project.json 的场景目录
 *   · weAssetsDir    Wallpaper Engine 的官方 assets（shader / material / model / particle
 *                    / scripts）。**两种写法都接受**：`<WE 安装目录>/assets`（locateWeAssets()
 *                    的返回形式，推荐）或 `<WE 安装目录>` 本身 —— 内部按内容自动归一。
 *                    不提供也能渲染，但官方效果链会退化（见 README「已知限制」）。
 *   · videoFrames    可选：场景内嵌视频纹理的预抽帧 { [纹理路径]: Uint8Array }，由调用方负责
 *                    抽帧（主插件用 ffmpeg；独立使用时可以不传 ⇒ 跳过视频纹理）
 *   · gpuAccel       可选：效果链走 WebGL（需要 supreium-headless-gl + x64）。
 *                    等价于 gpu:'auto'；更细的控制见下。
 *   · gpu            可选：'auto'（默认）| 'off' | 'force' | { mode, failStreakLimit,
 *                    allowEffects, denyEffects }。'force' 会重新探测（含此前已熔断的进程）。
 *   · effects        可选：逐效果决策 ——
 *                    { allow: [], deny: [], backend: { <效果名>: 'auto'|'cpu'|'gpu'|'gpu-only' },
 *                      skipDegenerate: bool, onDecision(d) }
 *                    · deny 命中 / 不在 allow（allow 非空时）→ 跳过该效果（对象保留）
 *                    · backend 'cpu'  → 该效果禁用 GPU，只走 CPU 内核/解释器
 *                    · backend 'gpu-only' → GPU 未产出就跳过（不静默回退 CPU，便于严格对拍）
 *   · policy         可选：{ decideEffect(ctx), decideBackend(ctx), gpu, shaderPatch, onDecision }
 *                    decideEffect 优先级最高，可返回 'apply'|'skip'|'cpu'|'gpu'|{action,backend,reason}
 *   · onDecision     可选：实时接收每条决策 {effect, layer, index, action, backend, reason, source}
 *   · shaderPatch    可选：{ <效果名|材质 stem>: (src, {stage}) => newSrc } 逐着色器源码覆写
 *                    （借鉴 webwallgl 的 __shaderPatch，但这是官方接口；抛错/非字符串则保持原样）
 *
 * 返回的 `decisions` 是**结构化决策记录**（谁被跳过、为什么、用了哪条后端），
 * `gpuStats` 是 GPU 适配层计数（used/failed/fallback/unavailable/state）。
 * 未提供任何策略时，整条决策链零开销、行为与旧版逐位一致。
 */
import { statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SceneRenderer, encodePng } from './scene-renderer.js';
import { gpuAdapterStats } from './we-renderer/gpu-gl/adapter.js';

/** 目录入参 → 真实场景主文件（project.json 的 `file` 字段，回退目录本身）。 */
export function resolveSceneMainFile(src) {
  try {
    if (!statSync(src).isDirectory()) return src;
  } catch { return src; }
  try {
    const pj = JSON.parse(readFileSync(join(src, 'project.json'), 'utf8'));
    const f = pj && typeof pj.file === 'string' ? pj.file : null;
    if (f && /\.json$/i.test(f) && f !== 'scene.json' && existsSync(join(src, f))) return join(src, f);
  } catch { /* 无 project.json / 解析失败 → 保持目录入参 */ }
  return src;
}

/**
 * 渲染一帧。
 *
 * 返回值里的 `degraded` / `blank` 是**给"静默错误"用的**：渲染器在缺纹理、效果编译失败、
 * 视频纹理无法静态解码等情况下仍然会"成功"返回一张图（甚至整帧空白），
 * 以前这些只走 log 回调，调用方默认看不见。现在一律结构化返回：
 *   · degraded: [{object, feature, action}]  —— 每一项都说明"哪一层/哪个效果被跳过了"
 *   · blank:    true 表示抽样后判定为空白/纯色帧（内嵌视频纹理场景的典型结果）
 * 需要严格模式时（例如批量出图不允许空白），用 `blank || degraded.length` 自行判定。
 *
 * @param {object} opts 见文件头
 * @returns {Promise<{png: Uint8Array, width: number, height: number, time: number,
 *   sceneSrc: string, ms: number, weAssetsDir: string|null,
 *   degraded: Array<{object: string|null, feature: string, action: string}>,
 *   blank: boolean, meanLuma: number}>}
 */
export async function renderFrame(opts = {}) {
  const {
    input, width = 3840, height = 2160, time = 2.5,
    weAssetsDir = null, videoFrames = null, gpuAccel = false,
    warm = true, log = () => {}, onDegraded = null,
    gpu, effects = null, policy = null, onDecision = null, shaderPatch = null,
    sceneKey = null,
  } = opts;
  if (!input) throw new Error('renderFrame: input 必填（scene.pkg 路径或场景目录）');

  const sceneSrc = resolveSceneMainFile(input);
  const t0 = Date.now();
  // 始终挂自己的收集器；调用方的 onDegraded 仍会逐个收到（收集器不吞掉它）
  const degraded = [];
  const collectDegraded = (d) => {
    degraded.push(d);
    if (typeof onDegraded === 'function') {
      try { onDegraded(d); } catch { /* 调用方回调失败不影响渲染 */ }
    }
  };
  // gpuAccel 是历史开关（等价 gpu:'auto'）；显式给了 gpu/effects/policy 时以策略层为准。
  const policyOpts = { gpu: gpu !== undefined ? gpu : (gpuAccel === true ? 'auto' : 'off'), effects, policy, onDecision, shaderPatch };
  const renderer = new SceneRenderer(sceneSrc, {
    width, height, time, weAssetsDir, videoFrames,
    gpuAccel: gpuAccel === true || gpu === 'auto' || gpu === 'force'
      || (gpu && typeof gpu === 'object' && gpu.mode !== 'off' && gpu.enabled !== false),
    log, onDegraded: collectDegraded,
    // 可选: 场景稳定标识（与文件路径无关）—— 让"同一场景的不同副本"（如解包后的目录）
    // 跑出逐像素一致的结果；不传则按旧行为用场景路径推导粒子随机种子。
    sceneKey,
    ...policyOpts,
  });

  // 块行并行预解码（与主插件 worker 同序：构造 → 预热 → render）。
  // 失败/未启用只是少预热若干纹理，像素不变。
  if (warm) {
    try {
      const { warmSceneTextures } = await import('./we-renderer/predecode.js');
      const st = await warmSceneTextures(renderer);
      if (st) log(`预热 ${st.textures} 张 / ${st.workers} worker / ${Math.round(st.ms)}ms`);
    } catch (e) {
      log('预热跳过: ' + (e && e.message ? e.message : e));
    }
  }

  const canvas = renderer.render();
  const png = encodePng(canvas.w, canvas.h, canvas.data);
  const frame = sampleFrame(canvas.data, canvas.w, canvas.h);
  return {
    png, width: canvas.w, height: canvas.h, time: time == null ? 0 : time, sceneSrc,
    ms: Date.now() - t0,
    // 归一后的实际生效值（入参可能是 <WE>/assets，而内部按 <WE> 根拼 assets/）
    weAssetsDir: renderer.weAssetsDir || null,
    degraded,
    blank: frame.blank,
    meanLuma: frame.meanLuma,
    // 下游决策记录 + GPU 计数（无策略时 decisions.total = 0）
    decisions: renderer.decisionReport ? renderer.decisionReport() : { total: 0, items: [] },
    gpuStats: gpuAdapterStats(),
  };
}

/**
 * 空白帧粗判（抽样，4K 下 < 1ms）：
 * 纯黑/单一颜色占比 > 95%，或抽样到的颜色种类 ≤ 4 ⇒ 判定 blank。
 * 只用于**告警**，不参与任何像素决策。
 */
export function sampleFrame(data, w, h) {
  const STEP = 53; // 质数步长，避免与常见行宽共振
  let sum = 0, n = 0, black = 0;
  const colors = new Set();
  for (let i = 0; i < w * h; i += STEP) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    sum += lum; n++;
    if (r === 0 && g === 0 && b === 0) black++;
    colors.add(r + ',' + g + ',' + b);
  }
  const meanLuma = +(sum / Math.max(1, n)).toFixed(1);
  const blank = colors.size <= 4 || black / Math.max(1, n) > 0.95;
  return { meanLuma, blank, colors: colors.size, blackShare: +(black / Math.max(1, n)).toFixed(3) };
}

/** 便捷：渲染并写出 PNG 文件。 */
export async function renderToFile(input, outPath, opts = {}) {
  const { writeFileSync } = await import('node:fs');
  const res = await renderFrame({ ...opts, input });
  writeFileSync(outPath, res.png);
  return { ...res, outPath };
}

/**
 * 候选 Steam 根目录（按平台）。环境变量 `DSH_WE_STEAM_ROOT` 优先（`;`/`,` 分隔多个）。
 *
 * 为什么单独导出：`locateWeAssets()` 与 test/ 下的场景发现都要用它；此前三处各写一份
 * 且**只探测 Windows 盘符**，Linux / macOS 上自动定位必然失败（现在补上默认路径）。
 */
export function steamRootCandidates() {
  const roots = [];
  const env = process.env.DSH_WE_STEAM_ROOT;
  if (env) roots.push(...env.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
  if (process.platform === 'win32') {
    for (const d of ['C', 'D', 'E', 'F', 'G']) {
      roots.push(`${d}:\\SteamLibrary`, `${d}:\\Steam`, `${d}:\\Program Files (x86)\\Steam`);
    }
  } else if (process.platform === 'darwin') {
    roots.push(join(homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    // Linux：发行版/Flatpak/Snap 的常见位置
    roots.push(
      join(homedir(), '.steam', 'steam'),
      join(homedir(), '.steam', 'root'),
      join(homedir(), '.local', 'share', 'Steam'),
      join(homedir(), '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
      join(homedir(), 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
    );
  }
  return [...new Set(roots)];
}

/** WE 安装目录下的 assets 定位（独立实现；主插件有更完整的 Steam 库解析，见其 locateWallpaperEngineP）。 */
export function locateWeAssets() {
  const env = process.env.WE_ASSETS || process.env.DSH_WE_ASSETS;
  if (env && existsSync(join(env, 'shaders'))) return env;
  for (const r of steamRootCandidates()) {
    const p = join(r, 'steamapps', 'common', 'wallpaper_engine', 'assets');
    if (existsSync(join(p, 'shaders'))) return p;
    // libraryfolders.vdf 里的其它库
    const vdf = join(r, 'steamapps', 'libraryfolders.vdf');
    if (!existsSync(vdf)) continue;
    try {
      for (const m of readFileSync(vdf, 'utf8').matchAll(/"path"\s*"([^"]+)"/g)) {
        const q = join(m[1].replace(/\\\\/g, '\\'), 'steamapps', 'common', 'wallpaper_engine', 'assets');
        if (existsSync(join(q, 'shaders'))) return q;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export default { renderFrame, renderToFile, resolveSceneMainFile, locateWeAssets, sampleFrame, steamRootCandidates };
