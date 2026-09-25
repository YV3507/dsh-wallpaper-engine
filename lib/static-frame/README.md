# we-static-frame

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![CI](https://github.com/YV3507/we-static-frame/actions/workflows/ci.yml/badge.svg)](https://github.com/YV3507/we-static-frame/actions/workflows/ci.yml)
[![Wallpaper Engine](https://img.shields.io/badge/Wallpaper%20Engine-scene.pkg-1b2838.svg)](https://www.wallpaperengine.io/)

把 Wallpaper Engine 的场景壁纸（`scene.pkg` / 场景目录）**离线渲染成一张 PNG** 的独立实现。
从 [`dsh-plugin-wallpaper-engine`](https://github.com/YV3507/dsh-wallpaper-engine) 的静态帧链整块搬出，
**不依赖任何宿主**（无 DSH、无插件、无 HTTP 服务）：既能当库调用，也能当命令行工具用。

> **为什么存在**：实时渲染（[`webwallgl`](https://github.com/oneincase/webwallgl)）在**有 GPU** 的机器上是主路径；
> 静态帧的定位是**虚拟机 / 远程端 / 无 WebGL2** 时的取舍方案 —— 也就是"没有实时渲染可用"时的兜底。
> 把它独立出来，是为了让渲染器本身能独立发版、独立评测，同时让主插件不必继续内嵌这 1MB 实现。

## 依赖

- **Node ≥ 18**（ESM）。
- **Wallpaper Engine 安装**：渲染器需要官方 `assets/`（shader / material / model / particle / scripts）才能还原效果链。
  用 `--we-assets <WE 安装目录>/assets` 指定，或让 CLI 自动定位（环境变量 `WE_ASSETS` / `DSH_WE_ASSETS`、
  `DSH_WE_STEAM_ROOT`，以及各平台 Steam 默认库 + `libraryfolders.vdf`：Windows 盘符、
  Linux `~/.steam` / `~/.local/share/Steam` / Flatpak / snap、macOS `~/Library/Application Support/Steam`）。
  **这些资产是 WE 自带的，不随本仓库分发。**
- 可选：`supreium-headless-gl`（x64）—— 效果链走 WebGL 的 GPU 加速（`--gpu`）。缺失、架构不符或驱动异常即自动回退 CPU。
- 可选：场景内嵌**视频纹理**需要调用方先抽帧（主插件用 ffmpeg），通过库参数 `videoFrames` 传入；CLI 暂不支持，
  这类场景会渲染成**空白帧**（见下方"已知限制"）。

## 用法

```bash
# 命令行
npx we-sf render "/path/to/scene.pkg" -o frame.png --w 3840 --h 2160 --t 2.5
npx we-sf render ./my-scene-dir -o frame.png --we-assets ".../wallpaper_engine/assets"
npx we-sf locate          # 只打印自动定位到的 assets 路径
npx we-sf render <scene> -o out.png --log      # 把效果编译失败 / 缺纹理 / 降级上报打到 stderr
npx we-sf render <scene> -o out.png --strict   # 有降级或空白帧时退出码 3（批量出图建议开）
```

降级与空白帧**默认就会报到 stderr**（不再静默）：`--json` 里另有结构化的
`degraded: [{object, feature, action}]` 与 `blank` / `meanLuma` 字段。
退出码：`0` 干净出图 / `1` 渲染失败 / `2` 参数错误 / `3` 出图但有降级或空白（仅 `--strict`）。

```js
// 库
import { renderFrame, renderToFile, locateWeAssets } from 'we-static-frame';

const { png, width, height, ms, degraded, blank } = await renderFrame({
  input: 'C:/.../431960/3486806915/scene.pkg',
  width: 3840, height: 2160, time: 2.5,
  weAssetsDir: locateWeAssets(),        // <WE>/assets 或 <WE> 本身都接受
  gpuAccel: false,
  onDegraded: ({ object, feature, action }) => console.warn(feature, action), // 可选：实时回调
});
if (blank || degraded.length) console.warn('画面与官方不一致', degraded);
```

## 目录结构 / 代码来源契约

```
src/**                  ← 渲染器本体：搬自主插件 dsh-plugin-wallpaper-engine 的静态帧链（64 文件）
src/render.js           ← 本仓库的库入口（renderFrame / renderToFile / locateWeAssets）
src/cli.js              ← 本仓库的 CLI（we-sf）
test/smoke.mjs          ← 冒烟：能拿到场景就渲染一张并校验 PNG 头（拿不到则 SKIP）
test/survey.mjs         ← 普查：本机全库逐个渲染，汇总空白帧 / 降级 / 耗时（人读表格 + JSON）
test/gpu-parity.mjs     ← CPU/GPU 对拍：`gpu:'auto'` + 全部效果 `gpu-only`，
                          用 decisions[] 测出「哪些效果 GPU 能跑、哪些跑不了及原因」
```

**`src/**` 的约定（vendored + 本地补丁）**：这部分代码**来源**是主插件的静态帧链，但本仓库是它的
**唯一发布源**——允许在此直接修 bug 并独立发版。改动请遵守两条：

1. **保持接口与语义与主插件一致**：这里的修复应当能被主插件反向取用（改动落点尽量小而集中，
   并在提交信息里写清"修的是什么、怎么验证"）。
2. **不要在两边各写一份实现**：主插件若要覆盖式同步 `src/**`，必须把本仓库的新提交一并带走
   （历史契约见主插件 `scripts/sync-webwallgl.mjs` 与 `.upstream.json` 的 `repo / name / version / commit / dirty / files`）。

反向约束不变：**本仓库不反向依赖主插件**，`src/**` 里不允许出现主插件专有模块的 import。

## 下游决策接口（逐效果 / GPU）

渲染器把**决策权**交给调用方：哪些效果应用、用哪条后端、GPU 开不开，都能逐条指定，
并且每条决策都有**可解释的记录**（谁被跳过、依据是什么）。

```js
const { png, decisions, gpuStats } = await renderFrame({
  input: 'scene.pkg', weAssetsDir, time: 2.5,
  // GPU：'auto'（默认）| 'off'（永不探测）| 'force'（重探，含已熔断的进程）
  //      也可以是对象：{ mode, failStreakLimit, allowEffects, denyEffects }
  //      failStreakLimit: 0 = 永不熔断（"宁可慢也要 GPU"）
  gpu: { mode: 'auto', failStreakLimit: 0, denyEffects: ['godrays'] },
  effects: {
    deny: ['filmgrain'],                     // 黑名单：跳过（对象保留）
    allow: ['waterwaves', 'bloom'],          // 白名单（给定时 = 只允许这些）
    backend: { waterwaves: 'cpu', godrays: 'gpu-only' },
    //   'cpu'      → 该效果禁用 GPU，只走 CPU 内核/解释器
    //   'gpu'      → 优先 GPU（失败仍回退 CPU）
    //   'gpu-only' → GPU 未产出就**跳过**该效果（不静默回退，便于 CPU/GPU 严格对拍）
    skipDegenerate: true,                    // 是否启用"输出退化就丢弃"的保护
    onDecision: (d) => log(d),               // 实时回调，也可从返回值 decisions 里拿
  },
  // 自由度最高的一层：钩子优先级高于名单与 backend 表
  policy: {
    decideEffect: ({ effect, layer, index }) =>
      effect === 'bloom' && layer === '天空' ? { action: 'skip', reason: '业务规则' } : 'apply',
    decideBackend: ({ effect }) => (effect.startsWith('water') ? 'cpu' : 'gpu'),
  },
  // 逐着色器源码覆写（借鉴 webwallgl 的 __shaderPatch，但这里是官方接口）
  shaderPatch: { waterwaves: (src, { stage }) => src.replace('0.05', '0.02') },
});

console.log(decisions.byAction, decisions.byBackend);
// decisions.items[] = { effect, layer, index, action, backend, reason, source }
//   source ∈ hook | hook-error | backend-map | backend-hook | deny | allow | default
console.log(gpuStats); // { state: 'unknown'|'ok'|'off', failStreak, used, failed, fallback, unavailable }
```

CLI 对应开关：

```bash
we-sf render scene.pkg -o out.png --gpu off            # 或 --gpu auto / --gpu force
we-sf render scene.pkg -o out.png --skip-effect bloom  # 可重复；--no-effect 同义
we-sf render scene.pkg -o out.png --only-effect waterwaves   # 白名单（可重复）
we-sf render scene.pkg -o out.png --effect-backend waterwaves:cpu
we-sf render scene.pkg -o out.png --list-decisions     # 把决策记录打到 stderr
npm run gpu-parity -- --only 3461168300 --out parity.json   # CPU/GPU 逐效果能力边界
```

**GPU 能力边界（实测）**：GPU 适配层目前只覆盖**按名字猜到的单 pass GLSL 效果**；
`effect.json` 数据通路的多 pass 效果（如 `bloom`、`blurprecise`、`bokeh_blur`）不会被 GPU 接手。
用 `gpu-only` 可以把这个边界显式化：拿不到 GPU 产出的效果会被**跳过并记录原因**，
而不是静默回退 CPU —— 下游据此决定"这个效果是只走 CPU、还是干脆不要"。

设计约定（与实时渲染路线 `webwallgl` 的对比）：

- webwallgl 对宿主只暴露 `quality.{antiAliasing,particles,postProcessing}` 三个粗档位
  （`postProcessing:"off"` 是"图层效果链 + 整屏后期 + bloom"三合一总闸），逐效果开关只有
  场景数据里的 `effect.visible`，着色器编译失败则**静默跳过**。本仓库提供的是**逐效果、
  可解释、可回放**的决策接口。
- **任何非法配置都不抛错**：逐键回落到安全默认（渲染是长任务，不该因配置崩）。
- **未提供策略时零开销**：`policy` 为空时决策点直接短路，行为与不带该功能时逐位一致。
- 钩子抛错不牵连渲染：按默认放行并记 `source: 'hook-error'`。
- `shaderPatch` 抛错或返回非字符串 → 保持原样。

## 已知限制（会静默影响画面，务必先读）

这些都会让"渲染成功"的图与官方不一致。**现在都会上报**：CLI 打到 stderr 且进
`--json` 的 `degraded` / `blank`，库调用方从 `renderFrame()` 的返回值或 `onDegraded`
拿到同样的结构化条目；需要硬性拦截就用 `--strict`（退出码 3）或自行判断
`blank || degraded.length`。

- **内嵌视频纹理** → 整层被跳过。若主图层就是视频纹理，整帧会是纯黑（`blank: true`）。
  库调用方需自行抽帧并传 `videoFrames`；CLI 不支持，`--strict` 下会以 3 退出。
- **效果编译/执行失败**（GLSL 报错、缺纹理、缺 combo 支持等）→ **该效果被丢弃**，对象保留，
  画面缺效果（`degraded` 里 feature 形如 `effect:<名字>`）。
- **`--gpu` 的熔断**：同一进程内连续若干次 GPU 效果失败后，本次渲染剩余效果链全部回退 CPU，
  此时 `--gpu` 可能反而更慢（实测有 0.57×–1.0× 的场景）。

## 明确不做（边界）

- 不做缓存 / 变体档位 / `.fb.` 兜底 / 预热调度 / 设置与 UI —— 那些是**宿主职责**，留在主插件。
- 不做进程派发与 IPC（worker / fork / GPU node 探测）—— 同上。
  （`src/scene-render-worker.mjs`、`src/scene-prewarm.js` 是随镜像带过来的宿主侧文件，本仓库不调用它们。）
- 不做"用 WebWallGL 实时渲染器截帧"（那是另一条路线：GPU 侧由 webwallgl + 主插件的缓存回填承担）。

## 现状与待办

- 采样时刻选点（"t=2.5 可能是空白帧 ⇒ 试更晚时刻"）与度量口径目前仍在主插件的 worker 里；
  将来若确认它属于"渲染"而非"宿主策略"，可迁移到这里（迁移前不要在两处各写一份）。
- `--gpu` 的实际收益只在**效果链**上，且**取决于场景**：效果占比高的场景实测 1.8×–4.4×，
  效果少或触发熔断的场景会持平甚至变慢 —— 非效果段仍是 CPU。
- **已知残余降级**（本地 16 场景实测，2026-02；都已上报，不会静默）：
  - 内嵌视频纹理场景 2/16 输出空白帧（设计限制，见上）。
  - `auto_sway`：`main is not defined` —— shader 用 `#if AA_VERSION == 1/2/3` 分出三份 `main`，
    而 `AA_VERSION`/`NODE_COUNT` 未在 shader/材质/effect.json 里给出默认值 ⇒ 三个分支全被裁掉。
    需要在 combo 注入侧补"场景材质实例 → pass combos"的传递。
  - `lens_flare_sun`：`x.map is not a function` —— 进入其 `noise()` 后返回了非数值；待最小复现。
  - `bokeh_blur` / `bloom`：`Cannot read properties of undefined (reading '0')`；待最小复现。
  - `3582367840` 的某个效果：预处理器在 `#endif` 报 `Expected control line`（`#if` 结构不被
    shaderfrog 预处理器接受）。
  用 `--log` 或 `DSH_WE_FX_TRACE=1`（会打印生成的 JS 出错行）可定位。
  逐 pass 取证用 `DSH_WE_FX_DUMP=1`（打印每个 pass 产出的尺寸与像素摘要 ——
  找"哪一个 pass 先变成常量"）；配合 `effects: { skipDegenerate: false }` 保留退化输出。
- 更多缺陷与修复进度见 [Issues](https://github.com/YV3507/we-static-frame/issues)。

## 许可证

[MIT](LICENSE)。渲染器实现取自 [`dsh-plugin-wallpaper-engine`](https://github.com/YV3507/dsh-wallpaper-engine)（同为 MIT）。
