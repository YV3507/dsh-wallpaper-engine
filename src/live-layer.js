/**
 * live-layer.js — **实时渲染管线**：live 渲染与控制、看护心跳、判失败、抓帧回填、指针转发、
 * poster/挂载/抓首帧，以及壁纸层的构建（syncLayers）与过场过渡。
 *
 * 为什么单独一个文件：这是"壁纸层从建到退"的整条链路（**1,204 行**），此前散在
 * src/client.js 的多个不相邻区段里 —— 中间还夹着**别的域**（媒体集成、GPU 帧槽助手、
 * 用户属性、diag 上报），改一处 live 行为要先在 7,300 行里找齐四五段。抽出来之后，
 * "画面为什么没出来"这类问题只需读一个文件；client.js 那边留了一段指路注释。
 *
 * 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，"外部作用域"= 同一 prelude / src/client.js 的顶层。依赖见下表分组
 * （清单只在这里维护，不在此处写死数量）：
 *   状态 store        selection · gpuFrameUi · liveWatch · livePointerFrame · liveApplied ·
 *                     bootRestore · liveDiagOn · LIVE_FIRST_FRAME_MS（后五个由本文件声明，
 *                     因被外部读取而导出）
 *   DOM 常量/标记      LAYER_ID · SCRIM_ID · ACTIVE_ATTR · IS_EDGE · CSS（prelude）
 *   层与轮换          syncSceneAudio · releaseLayerMedia · fadingLayerNode · pendingRotationFade ·
 *                     ROTATION_FADE_MS · commitRotationSwitch · switchTransitionOf · layerKeyDiff ·
 *                     switchFrames · openRotationAudioGate · releaseRotationAudioGateFor ·
 *                     rotationAudioHoldActive · scheduleSceneVideoResync
 *   live 与帧          livePauseReason · GPU_FRAME_ASPECT_TOL · gpuFrameAspectKnown ·
 *                     liveViewportAspect · probeGpuFrameState · markGpuFramePin · markGpuFrameProbed ·
 *                     clearGpuFrameSlot · refreshStaticFrameNodes · prepareSceneLiveStage ·
 *                     prepareSceneStaticStage · prepareLiveTimeouts · clearPrepareLiveTimeout ·
 *                     disposePreparedMedia · disposeMediaEl · buildMedia
 *   主题随壁纸        themeFollowOnFrameCanvas · themeFollowOnFrameImage（src/theme-follow.js）：抓到的
 *                     真实画面比作者预览图更能代表这张壁纸，用它重判一次全局深/浅（排名更高）
 *   播放与音频        applyVideoPlayback · isEffectivelyPlaying · weAudioVolume · startMediaSync ·
 *                     stopMediaSync · mediaTimer · weStartDraw · weStopDraw · weDrawCtx ·
 *                     applyEffects/clearEffects（prelude）· reportClientDiag · emit ·
 *                     persistSelection · applySelection · applyStoredUserProps ·
 *                     apiFetch/apiHead（prelude）
 * 提供的入口（被 client.js 或守卫引用，其余是同族助手）：
 *   syncLayers · startLiveWatch · stopLiveWatch · liveFail · liveRenderEnabled · liveRenderUrl ·
 *   liveFailReasonOf · liveLog · liveStateBrief · liveDiagVerbose · liveStats · applyLiveControls ·
 *   scheduleLiveFrameBackfill · cancelLiveFrameBackfill · liveFrameEl · buildLivePoster ·
 *   scheduleLiveMount · createLiveFrame · retireFadingLayer · toggleLiveDiag
 *   ＋ 供外部**读**的状态：liveWatch · livePointerFrame · liveApplied · liveDiagOn ·
 *     LIVE_FIRST_FRAME_MS · bootRestore
 *
 * 不变量：
 *   · `liveLog(tag, detail?, level?, verboseOnly?)` 是**客户端上报的唯一出口**：三档
 *     `error` / `warn` / `info`（与宿主 `lib/log.js` 同集合，见 `LIVE_LEVELS`），缺省与未知
 *     一律 `info`；`verboseOnly` 的调用点在 `weLiveDebug` 关闭时**连字符串都不构造**。
 *   · 档位随同源像素请求以 `&lvl=` 上行（宿主对未知 / 缺失落 `info`）；**判据**：影响显示
 *     效果的非正常表现才是 `warn`（判失败、stall 自救、准备期超时降级），其余全 `info`。
 *   · **live 看护只有一条时间线**：`liveWatch` 是唯一的活动看护记录，start/stop 必须成对
 *     （startLiveWatch 自己会停掉上一个；stopLiveWatch 清 timer）。判失败与首帧确认都写它。
 *   · **抓帧回填不得覆盖新壁纸**：scheduleLiveFrameBackfill 的落地回调必须重校验 token/wid
 *     （换壁纸期间挂起的回填是最容易写错的一处）。
 *   · `syncLayers` 是**幂等的**：它可被 emit / 轮换 / 面板反复调用，只按 key 差量改 DOM，
 *     并且在 emit 周期内运行时**不得**再同步 emit（会重入 listener 链直到爆栈）。
 *   · 定时器与 rAF 全部登记在可取消的句柄上（watch.timer / liveMountTimer / livePointerRaf /
 *     backfill.timer）—— 卸载路径逐个取消，漏一个就是"卸载后仍在跑"。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 */

function liveRenderEnabled(selLike) {
  return Boolean(selLike && selLike.sceneLive !== false
    // 失败记忆的值是失败原因（'timeout' / 'stall'）；兼容旧的 true。
    && !(selLike.sceneLiveFailures && selLike.sceneLiveFailures[String(selLike.id)])
    && ((selLike.type === "scene" && selLike.sceneLiveSrc)
      || (selLike.type === "web" && selLike.webLiveSrc)));
}
// 失败原因 → 可读文案（设置面板展示，便于用户反馈「为什么黑」）。
const LIVE_FAIL_LABELS = {
  timeout: "首帧超时（15 秒内无画面）",
  stall: "运行中断（20 秒无帧）",
  load: "壁纸加载失败",
};
function liveFailReasonOf(selLike) {
  const m = selLike && selLike.sceneLiveFailures;
  const v = m ? m[String(selLike && selLike.id)] : null;
  if (!v) return "";
  return LIVE_FAIL_LABELS[v] || "渲染失败";
}
// objectFit（object-fit 语义）→ WebWallGL fit 值。center 无精确对应
//（渲染器的 contain 即完整显示居中，视觉最近似）；fill（拉伸变形）→ stretch。
const SCENE_LIVE_FIT = { cover: "cover", contain: "contain", center: "contain", fill: "stretch" };
function liveRenderUrl(selLike) {
  const isWeb = selLike.type === "web";
  // scene：src 是 mediaBase 下的 token（渲染页用它拼 httpSource）。
  // web：src 必须是**完整入口 URL**（渲染页的 web 形态直接 iframe 加载它，
  // 并从同目录取 project.json）—— 传 token 会被当成相对 URL 而 404。
  //
  // host 给的 webLiveSrc 正常情况下已是**绝对 URL**：网页壁纸的整个载荷
  //（入口 HTML + 全部子资源）由 host 自己的壁纸媒体源（独立 loopback 端口）
  // 提供。原因见 host 的 ensureMediaOrigin：DSH Desktop 给每个插件路由套了
  // 能力头（x-dsh-desktop-renderer）栅栏，而该头只注入给同源 frame 的请求；
  // 严格沙箱 iframe 是不透明源，永远拿不到 —— 于是入口 HTML 一律 403，表现
  // 就是「预览图正常、随后整块黑」。只有旧 host / 媒体源启动失败时才回落成
  // 应用源相对路径（浏览器形态照常可用）。
  const webEntry = String(selLike.webLiveSrc || "");
  const src = isWeb
    ? (/^https?:\/\//i.test(webEntry) ? webEntry : location.origin + webEntry)
    : selLike.sceneLiveSrc;
  const fit = SCENE_LIVE_FIT[selLike.objectFit] || "cover";
  const fps = SCENE_LIVE_FPS_VALUES.includes(selLike.sceneLiveFps) ? selLike.sceneLiveFps : 30;
  const muted = weAudioVolume() > 0 ? "false" : "true";
  return "/wallpaper-engine/scene-live/index.html?type=" + (isWeb ? "web" : "scene")
    // 网页壁纸必须严格沙箱：第三方 workshop HTML 不得继承 DSH 的 origin
    //（否则可冒用宿主身份调宿主 API / 读宿主存储）——只给 allow-scripts，
    // 控制经渲染页的 postMessage 通道下发，shim 由宿主注入 HTML 响应。
    + (isWeb ? "&webSandbox=strict" : "")
    + "&fit=" + fit + "&sceneFps=" + fps + "&muted=" + muted
    // WE 官方素材（local-assets）：host 报告素材目录可用时才打开渲染页的
    // 本地素材通路（探测 /api/local-assets，按名取官方像素）；否则渲染页
    // 静默走程序化复刻，连探测请求都不发。
    + (selection.inventory && selection.inventory.weAssetsAvailable ? "&localAssets=1" : "")
    + "&src=" + encodeURIComponent(src)
    + "&mediaBase=" + encodeURIComponent(location.origin + "/wallpaper-engine/scene-files");
}
// 向 live iframe 的 __wp 控制面收敛播放态/音量/fit。每次 emit 驱动的
// syncLayers 与每秒心跳 tick 都会调用，但**只在目标值变化时真正下发**：
// 渲染页的 resume() 会重置帧计量器（resetFrameMeter），若每秒无条件 resume，
// 紧随其后的心跳读数永远是 fps=0 → 首帧判定永不通过 → 15s 误降级（实测：首帧就绪前那次 in-flight 探针会打断心跳，读数恒为 0）。setVolume/setFit 同理省掉每秒无谓的跨文档调用。
const liveApplied = { frame: null, playing: null, volume: null, fit: null };
function applyLiveControls(frame) {
  if (!frame) return;
  let wp = null;
  try { wp = frame.contentWindow && frame.contentWindow.__wp; } catch { return; }
  if (!wp) return; // 渲染页未就绪：心跳 tick 每秒重试
  // 新 iframe（或渲染页刚就绪）→ 强制全量同步一次。
  if (liveApplied.frame !== frame) {
    liveApplied.frame = frame;
    liveApplied.playing = null;
    liveApplied.volume = null;
    liveApplied.fit = null;
  }
  try {
    const playing = isEffectivelyPlaying();
    if (liveApplied.playing !== playing) {
      if (playing) wp.resume(); else wp.pause();
      liveApplied.playing = playing;
    }
    // 闸内（正在淡入的新层）目标音量为 0：等旧层退场后再由
    // releaseRotationAudioGateFor 恢复。
    const volume = rotationAudioHoldActive() ? 0 : weAudioVolume();
    if (liveApplied.volume !== volume && typeof wp.setVolume === "function") {
      wp.setVolume(volume);
      liveApplied.volume = volume;
    }
    const fit = SCENE_LIVE_FIT[selection.objectFit] || "cover";
    if (liveApplied.fit !== fit && typeof wp.setFit === "function") {
      wp.setFit(fit);
      liveApplied.fit = fit;
    }
  } catch { /* 渲染页内部异常：下一 tick 重试 */ }
}

// ── live 诊断日志 ───────────────────────────────────────────────────────────
// live 这条路原先完全没有痕迹：判失败只写 sceneLiveFailures + 面板一行文案，
// 事后无法回答「为什么 15 秒没出帧」。渲染页内部的问题由它自己的 reportDiag
// 送到 host 的诊断环形缓冲（host 的 /diag 路由 → GET /wallpaper-engine/diag-log），
// 这里把**客户端**事件送到同一个缓冲，两条时间线于是可以对齐着看：
//   curl -s 127.0.0.1:<port>/wallpaper-engine/diag-log
// 逐秒心跳 tick 只在 localStorage.weLiveDebug === "1" 时打（默认关：一秒一条
// 会刷屏，也会给环形缓冲刷出无用的像素请求）。
const LIVE_DIAG_KEY = "weLiveDebug";
// 诊断代码版本 + 页面实例 id：日志里带着它们，事后能回答两个必问的问题 ——
// 「这一行是哪个 bundle 打的」（刷新是否真的生效）和「是哪个页面/窗口在跑引擎」
// （同时开两个 DSH 视图时，两个客户端会各自轮换、互相覆盖设置）。
const LIVE_DIAG_BUILD = "d7";   // d7：上报自带级别（`&lvl=`，宿主按它分档；未知 / 缺失落 info）
const LIVE_PAGE_ID = (function () { try { return Math.random().toString(36).slice(2, 7); } catch { return "?"; } })();
// 面板开关（本会话有效、不落盘）：给「打不开 DevTools」的环境留的入口 ——
// DSH web 的根路径鉴权是 303 跳到干净的 `/`，URL 上的查询参数到不了客户端，
// 所以不能靠 ?weLiveDebug=1 传参。
let liveDiagOn = false;
function liveDiagVerbose() {
  if (liveDiagOn) return true;
  try { return typeof localStorage !== "undefined" && localStorage.getItem(LIVE_DIAG_KEY) === "1"; } catch { return false; }
}
// 三个档位名与宿主侧同集合（`lib/log.js` 的 LEVELS）。两侧**不共享内核**：共享内核会触发
// 构建清单与共享内核白名单的变更，成本高于收益。不一致也是安全的 —— 宿主对未知 / 缺失的
// `lvl` 一律落 `info`，客户端多一个档位名最多让那批消息变安静。防漂由守卫 N6 兜住。
const LIVE_LEVELS = ["error", "warn", "info"];
function liveLog(tag, detail, level, verboseOnly) {
  if (verboseOnly && !liveDiagVerbose()) return;
  // detail 支持传函数：热路径（每秒 tick）在开关关闭时不构造那串注定被丢弃的字符。
  const text = typeof detail === "function" ? detail() : detail;
  // 档位：`error` / `warn` / `info`，缺省与未知一律 `info`（宿主侧的判据同此）。
  const lvl = LIVE_LEVELS.indexOf(level) >= 0 ? level : "info";
  const line = "[we-live " + LIVE_DIAG_BUILD + "\u00b7p" + LIVE_PAGE_ID + "] " + tag + (text ? " · " + text : "");
  try { if (typeof console !== "undefined" && console.info) console.info(line); } catch { /* ignore */ }
  // 同源像素请求 → host /diag 环形缓冲（与渲染页 reportDiag 同一条通路；`lvl` 让宿主
  // 不必靠文案猜档位，字节前缀仍是 `/diag?msg=`；无 host（单测 sandbox）时 Image
  // 不存在，静默跳过）。
  try {
    if (typeof Image === "function") {
      const img = new Image();
      img.src = "/diag?msg=" + encodeURIComponent(line) + "&lvl=" + lvl;
    }
  } catch { /* ignore */ }
}
// 一句话状态尾巴：出帧判定 + 暂停原因 + 首帧/运行期计数。
function liveStateBrief(extra) {
  const hold = livePauseReason();
  return "playing=" + isEffectivelyPlaying() + (hold ? " hold=" + hold : "")
    + " hidden=" + (typeof document !== "undefined" && document.hidden ? 1 : 0)
    + " focus=" + (typeof document !== "undefined" && typeof document.hasFocus === "function" && document.hasFocus() ? 1 : 0)
    + (extra ? " " + extra : "");
}
// 加载即留痕：确认「哪次刷新、哪个 bundle、哪个页面」真的生效了（用户这台机器
// 打不开 DevTools，唯一取证通道是宿主诊断缓冲）。
try { if (typeof document !== "undefined") liveLog("client-boot", "build=" + LIVE_DIAG_BUILD + " page=p" + LIVE_PAGE_ID
    + " mode=" + desktopWindowMode() + " extSwap=" + (useExtendedFrameSwap() ? 1 : 0)
    + " " + liveStateBrief()); } catch { /* ignore */ }
// 失焦/隐藏是「首帧看护为什么不计时」的直接证据 —— 事件级留痕（只在变化时触发）。
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("focus", function () { liveLog("play-state", liveStateBrief("window-focus")); });
    window.addEventListener("blur", function () { liveLog("play-state", liveStateBrief("window-blur")); });
  }
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () {
      liveLog("play-state", liveStateBrief(document.hidden ? "tab-hidden" : "tab-visible"));
    });
  }
} catch { /* ignore */ }
// 心跳留痕（60s 一条，常开）：任何时候事后回看，都能知道「页面在跑吗 / 哪张壁纸 /
// 什么播放态 / 看护进行到哪一步」，不必依赖复现时机。
try {
  if (typeof window !== "undefined" && typeof window.setInterval === "function") {
    window.setInterval(function () {
      const w = liveWatch;
      liveLog("beat", liveStateBrief("id=" + (selection.id || "-")
        + " liveOn=" + (selection.sceneLiveActive ? 1 : 0)
        + (w ? " watch=" + w.wid + " first=" + (w.firstFrame ? 1 : 0) + " held=" + w.heldPaused + " stall=" + w.stall : " watch=-")
        + " fails=" + Object.keys(selection.sceneLiveFailures || {}).length));
    }, 60000);
  }
} catch { /* ignore */ }

// ── live 心跳 ───────────────────────────────────────────────────────────────
// 1s tick 读渲染页 __wpStats.frame()（{fps, running}，最近 500ms 实测窗口）：
// - 首帧：running 且 fps>0 → 记 sceneLiveActive、iframe 淡入（we-live-on）、
//   音频互斥切换（停外置 <audio>）；
// - 首帧超时（15s：大 pkg 下载 + 纹理解码 + shader 编译的合理上限）→ 失败；
// - 运行期：期望播放却连续 20s 无帧（先单次 resume 自救）或页面失联 → 失败。
const LIVE_FIRST_FRAME_MS = 15000;
const LIVE_STALL_TICKS = 20;
let liveWatch = null; // { frame, wid, timer, startedAt, firstFrame, stall, resumed }
function liveStats(frame) {
  try {
    const st = frame.contentWindow && frame.contentWindow.__wpStats;
    if (!st || typeof st.frame !== "function") return null;
    return st.frame();
  } catch { return null; }
}

// 渲染页运行时状态（新渲染页提供 __wp.getState）：网页壁纸很多没有 rAF 帧打点
// （setTimeout 主循环 / 纯静态页），fps 恒为 0 —— 「iframe 已 load」才是可靠的
// 「壁纸就绪」信号。旧渲染页没有该方法时返回 null（退化为「可达即就绪」）。
function liveStateOf(frame) {
  try {
    const wp = frame.contentWindow && frame.contentWindow.__wp;
    if (!wp || typeof wp.getState !== "function") return null;
    return wp.getState();
  } catch { return null; }
}
// 「整页卡不卡」与「壁纸自己卡不卡」是两回事：网页壁纸跑在跨源沙箱 iframe
//（独立渲染进程），它内部掉帧＝壁纸自己的开销；整页同时掉帧＝合成/模糊这类
// 全页代价（例如液态玻璃的 backdrop-filter 每帧重采样壁纸）。判读「限了 30
// 还是卡」必须先分清是哪一种，所以这里用一条**只做计数**的 rAF 链量 UI 帧率，
// 与渲染页上报的壁纸自身帧率（getState().webFps）一起写进诊断。
let uiFpsFrames = 0;
let uiFpsRaf = 0;
let uiFpsSince = 0;
// 计时全局按环境取：UI fps 是诊断探针，不该因为宿主没有 performance / rAF
// 就抛异常、打断实时渲染链（真浏览器恒有这两者，测试宿主可能只给部分 DOM）。
const uiNow = () => (typeof performance !== "undefined" && performance && typeof performance.now === "function")
  ? performance.now() : 0;
function startUiFpsProbe() {
  if (uiFpsRaf || typeof requestAnimationFrame !== "function") return;
  uiFpsFrames = 0;
  uiFpsSince = uiNow();
  const tick = () => { uiFpsFrames += 1; uiFpsRaf = requestAnimationFrame(tick); };
  uiFpsRaf = requestAnimationFrame(tick);
}
function stopUiFpsProbe() {
  if (uiFpsRaf) { try { cancelAnimationFrame(uiFpsRaf); } catch { /* ignore */ } }
  uiFpsRaf = 0;
  uiFpsFrames = 0;
  uiFpsSince = 0;
}
function takeUiFps() {
  const now = uiNow();
  const seconds = uiFpsSince > 0 ? (now - uiFpsSince) / 1000 : 0;
  const frames = uiFpsFrames;
  uiFpsFrames = 0;
  uiFpsSince = now;
  return seconds > 0.2 ? Math.round(frames / seconds) : -1;
}

// 运行时帧率上报：每 5 秒一条，落进 host 的 diag 文件（DSH Desktop 拿不到
// console，只能靠这条通道）。`cap` 是当前上限设置，`web` 是壁纸自身帧率
//（-1 = 渲染页没给，例如纯 CSS 动画的壁纸不靠 rAF），`rnd` 是渲染页线程帧率。
function reportLiveFps(watch, frame, stats, wstate) {
  const secs = Math.max(1, Math.round((Date.now() - (watch.fpsAt || watch.startedAt)) / 1000));
  watch.fpsAt = Date.now();
  const ui = takeUiFps();
  const web = wstate && typeof wstate.webFps === "number" ? wstate.webFps : -1;
  const rnd = stats && typeof stats.fps === "number" ? Math.round(stats.fps) : -1;
  reportClientDiag("live-fps",
    `ui=${ui} web=${web} rnd=${rnd} cap=${selection.sceneLiveFps || "-"}`
    + ` win=${secs}s playing=${isEffectivelyPlaying() ? 1 : 0}`);
}

// 宿主窗口模式（页面 URL 的 dsh-desktop-mode 参数；兼容模式为缺省值）。
function desktopWindowMode() {
  try {
    const m = new URLSearchParams(window.location.search).get("dsh-desktop-mode");
    return m === "extended" || m === "advanced" ? m : "compatibility";
  } catch { return "compatibility"; }
}

// A/B 逃生舱：extended 模式的「首帧后延迟换元」自救开关（与 dsh-desktop-mica /
// we-saturate 同风格，只解析一次并缓存）。
//   ?we-ext-swap=1 → 恢复换元（用于复验"启动期子框架合成层坏死"那个老问题）
//   缺省 / 垃圾值 → **不换元**（现行默认）
// 为什么默认关掉：换元后的新元素为防白闪被刻意摘掉 `we-live-on`（见 rebuildLiveFrame），
// 层随即回落垫底图（场景=静态帧、网页=作者预览图），而渲染页仍照旧出声。实机表现
// 「场景/网页壁纸都正常几秒后失效成静态、只有扩展模式、网页退成预览图」与 8000ms
// 定时器 + first-frame-ok 后正好 +8s 的 live-frame-rebuilt 日志逐条吻合 —— 前提
//（"启动期 iframe 永不上屏"）在当前 2.0.14 上已不成立，换元只剩破坏。
let extendedFrameSwap; // undefined = 未解析 · true = 换元 · false = 不换元
function useExtendedFrameSwap() {
  if (extendedFrameSwap !== undefined) return extendedFrameSwap;
  extendedFrameSwap = false;
  try {
    if (typeof location !== "undefined" && location && typeof location.search === "string") {
      let rawFlag = "";
      if (typeof URLSearchParams === "function") {
        rawFlag = new URLSearchParams(location.search).get("we-ext-swap") || "";
      } else {
        const m = /[?&]we-ext-swap=([^&]*)/.exec(location.search);
        rawFlag = m ? decodeURIComponent(m[1]) : "";
      }
      extendedFrameSwap = String(rawFlag).toLowerCase() === "1";
    }
  } catch { /* 解析异常：保持不换元（现行默认），绝不抛出 */ }
  return extendedFrameSwap;
}

// extended 模式下，启动期创建的 live iframe 合成层坏死（元素级红底都上不了
// 屏、文档 reload 与 reparent 均无效，实测 2.0.14；见 first-frame-ok 处的
// 注释）。唯一有效的自救是换一个全新元素：同 src 新帧由宿主在窗口稳定后重新
// 分配，合成恢复。只做一次（dataset 标记）。
// 两个硬约束（首轮实现漏掉后踩出的坑）：
// ① 只在 extended 触发——advanced 的帧合成正常，重建纯属误伤（切壁纸白闪 +
//    指针/音频接线全断）；
// ② 新元素不得拷贝 we-live-on：先隐藏装载，等它自己的 first-frame-ok 由首帧
//    门点亮（走标准淡入），否则加载中的空白 iframe 直接可见 = 闪白。
// 换元后同步改道三条接线：livePointerFrame（窗口 mousemove → pushPointer 的
// 目标）、startMediaSync（模块级 mediaTimer 闭包锁帧，不重发音频就永远断）、
// watch 状态（firstFrame/stall/startedAt 重走首帧门）。
let liveFrameRebuildTimer = 0;
function rebuildLiveFrame(frame, watch) {
  if (desktopWindowMode() !== "extended") return false;
  try {
    if (!frame || frame.dataset.weRebuilt === "1") return false;
    frame.dataset.weRebuilt = "1";
    const fresh = document.createElement("iframe");
    for (const a of frame.attributes) {
      try { fresh.setAttribute(a.name, a.value); } catch { /* ignore */ }
    }
    fresh.classList.remove("we-live-on"); // 场景活着再由首帧门点亮，杜绝白闪
    fresh.dataset.weRebuilt = "1";
    if (frame.parentNode) frame.parentNode.replaceChild(fresh, frame);
    else if (frame.isConnected) frame.replaceWith(fresh);
    else return false;
    watch.frame = fresh;
    watch.firstFrame = false; // 新帧重走首帧门：alive 分支会补齐媒体接线/回放/回填
    watch.stall = 0;
    watch.startedAt = Date.now();
    ensureLivePointer(fresh); // livePointerFrame 闭包还指着被移除的旧元素
    startMediaSync(fresh);    // mediaTimer 闭包锁的是旧帧，音频/Now Playing 断供
    liveLog("live-frame-rebuilt", "wid=" + watch.wid + " mode=extended"
      + " 启动期子框架合成层坏死 → 换新元素重挂同 src（指针/音频已改道）");
    return true;
  } catch { return false; }
}

function startLiveWatch(frame, wid) {
  stopLiveWatch();
  const watch = { frame, wid: String(wid || ""), timer: 0, startedAt: Date.now(), firstFrame: false, stall: 0, resumed: false, heldPaused: 0 };
  liveLog("watch-start", "wid=" + watch.wid + " " + liveStateBrief());
  watch.timer = setInterval(() => {
    if (!frame.isConnected) { liveLog("watch-stop", "iframe 已从文档移除", "info", true); stopLiveWatch(); return; }
    // 先读统计、后下发控制：虽然 applyLiveControls 已去重（只在变化时
    // resume/pause），保持这个顺序让读数不受任何控制调用的副作用影响。
    const stats = liveStats(frame);
    applyLiveControls(frame);
    const isWeb = selection.type === "web";
    const wstate = isWeb ? liveStateOf(frame) : null;
    // 就绪判定分类型：场景每帧都有 GL 提交 → 要求真出帧；网页壁纸很多没有 rAF
    // 打点（setTimeout 主循环 / 纯静态），只要渲染页可达（或 iframe 已 load）即算
    // 就绪 —— 按 fps 判定会把它们误判失败并降级（实测：一直停在占位图，15 秒后黑屏）。
    const alive = isWeb
      ? (wstate ? wstate.iframeLoaded === true : Boolean(stats))
      : Boolean(stats && stats.running && stats.fps > 0);
    // 渲染页明确记录了 iframe 加载错误 → 立即降级，不必等 15 秒超时。
    if (isWeb && wstate && wstate.iframeLoaded === false && wstate.webError) {
      liveFail("load");
      return;
    }
    liveLog("tick", () => liveStateBrief("fps=" + (stats ? Math.round(stats.fps * 10) / 10 : "null")
      + " running=" + (stats ? stats.running : "null") + " alive=" + alive
      + " first=" + watch.firstFrame + " stall=" + watch.stall + " held=" + watch.heldPaused), "info", true);
    if (!watch.firstFrame) {
      if (alive) {
        watch.firstFrame = true;
        selection.sceneLiveActive = true;
        frame.classList.add("we-live-on");
        startUiFpsProbe();
        // live 真的出首帧 → 清掉准备期超时冷却。手动选择壁纸走的是建层路径、不经过
        // 准备链，所以不在这里清的话，一张「准备期超时过、实际跑得动 live」的壁纸会被
        // 轮换降级成 sceneVideo/静态帧直到页面关闭，而用户手动点开它却是活的。
        clearPrepareLiveTimeout(watch.wid);
        liveLog("first-frame-ok", "wid=" + watch.wid + " 用时 " + (Date.now() - watch.startedAt) + "ms"
          + (watch.heldPaused ? "（其中暂停期跳过 " + watch.heldPaused + " tick 未计时）" : ""));
        try { syncSceneAudio(selection); emit(); } catch { /* ignore */ }
        // 网页壁纸：首帧稳定后抽一帧存到 host（下次加载/重启用它当占位图）。
        maybeCaptureLiveFrame(frame, selection);
        // 「壁纸属性」面板改过的值：网页壁纸随 HTML 种子到达（host 侧合并），
        // 场景壁纸没有种子通道 —— 就绪后在这里回放一次。
        applyStoredUserProps(selection);
        // 媒体桥接线：频谱（拉模式）与 Now Playing 转发。
        startMediaSync(frame);
        // GPU 抓帧回填静态帧缓存（best-effort，见 scheduleLiveFrameBackfill）。
        scheduleLiveFrameBackfill(frame);
        reportClientDiag("live-ready", "firstFrame ok");
        // ── extended 窗口模式：启动期子框架合成层坏死 workaround ──
        //（版本 2.0.14 / 内核 0.1.7-rc.1）：仅 extended 模式下，随页面启动创建的
        // live iframe 无论内容是否在画（toDataURL 有完整帧、GL 无报错），其合成层
        // 永远到不了屏幕——连元素级红底都不显示；而同 URL 的全新 iframe（哪怕含
        // WebGL 子画布）完全正常。兼容/advanced 模式无此问题（advanced 误触发
        // 重建会白闪 + 指针/音频接线全断，用户反馈）。场景链路本身已由
        // first-frame-ok 证明可用，此处把元素整个换成携带同一 src 的新元素：新帧
        // 由渲染进程新 allocations 承载，合成恢复。换元后重置首帧门，让下方
        // alive 分支对新元素再走一遍完整的同步链（媒体接线/属性回放/抓帧回填）。
        // dataset 标记保证只换一次。
        // 重建不在首帧瞬间执行：宿主窗口的合成环境在启动后数秒内仍未稳定
        // （首帧即换，4s 新帧照样坏死，实测），因此先起一次性定时器延后换元。
        // ⚠️ 该前提在当前 2.0.14 上已不成立：live 首帧能正常上屏，而换元把 `we-live-on`
        // 摘掉后层只剩下垫底图（正是"正常几秒后失效"的成因）⇒ **改为 opt-in**，缺省
        // 不换元（见 useExtendedFrameSwap）。
        if (desktopWindowMode() === "extended" && !liveFrameRebuildTimer && useExtendedFrameSwap()) {
          const cursed = frame;
          liveFrameRebuildTimer = setTimeout(() => {
            liveFrameRebuildTimer = 0;
            try {
              if (cursed.isConnected && watch.frame === cursed) rebuildLiveFrame(cursed, watch);
            } catch { /* ignore */ }
          }, 8000);
        }
      } else if (!isEffectivelyPlaying()) {
        // 主动暂停（失焦/隐藏/用户暂停）→ 是我们自己 applyLiveControls 把渲染页
        // pause() 掉的，而暂停中的渲染页 __wpStats.frame() 恒为 {fps:0,running:false}
        // —— 「无帧」是预期行为，不是失败信号：暂停期间不计时（每 tick 重新起算），
        // 恢复播放后再给满一个预算窗口。缺这条守卫时，轮换的**节点级领养**路径
        // （syncLayers 领养分支在同一个任务里就 applyLiveControls → pause）只要碰上
        // 失焦/隐藏/暂停，15s 后就会把这张壁纸持久记成「首帧超时」并降级回
        // sceneVideo/静态帧（要手动重开开关才能恢复）—— 而渲染页其实是好好的。
        // 运行期 stall 规则早就有同款守卫（见下），这里补齐对称性。
        watch.heldPaused += 1;
        watch.startedAt = Date.now();
      } else if (Date.now() - watch.startedAt > LIVE_FIRST_FRAME_MS) {
        liveFail("timeout");
      }
      return;
    }
    // 运行期：场景要求持续出帧；网页只要求渲染页可达（能读到 getState / stats，
    // 静止画面本身是正常状态，不是失联）。
    const responsive = isWeb ? Boolean(wstate || stats) : alive;
    if (responsive || !isEffectivelyPlaying()) {
      watch.stall = 0;
      watch.resumed = false;
      // 帧率取证：每 5 秒一条（只上报，不做任何控制）——「限了 30 还卡」时
      // 这条能立刻分清是壁纸自身帧率低还是整页一起掉。
      watch.fpsTick = (watch.fpsTick || 0) + 1;
      if (watch.fpsTick % 5 === 0) reportLiveFps(watch, frame, stats, wstate);
      return;
    }
    watch.stall += 1;
    if (watch.stall === LIVE_STALL_TICKS && !watch.resumed) {
      // 单次自救：contextlost 恢复后渲染器可能停摆但未上报，先推一把。
      watch.resumed = true;
      liveLog("stall-rescue", "wid=" + watch.wid + " 连续 " + watch.stall + "s 无帧 → 试 resume()", "warn");
      try {
        const wp = frame.contentWindow && frame.contentWindow.__wp;
        if (wp) wp.resume();
      } catch { /* ignore */ }
      return;
    }
    if (watch.stall >= LIVE_STALL_TICKS * 2) liveFail("stall");
  }, 1000);
  liveWatch = watch;
}
function stopLiveWatch() {
  if (!liveWatch) return;
  try { clearInterval(liveWatch.timer); } catch { /* ignore */ }
  stopUiFpsProbe();
  stopMediaSync(liveWatch.frame);
  liveWatch = null;
  // 只重置标志；音频互斥由调用方收敛 —— 重建（fps 切换）时若在这里拉起
  // 外置 <audio>，新一帧 live 又要立刻把它停掉，中间会闪一下双声道。
  selection.sceneLiveActive = false;
}
// 判定失败：按壁纸写入持久失败记忆 → syncLayers key 变化重建为旧播放链
//（sceneVideo / 静态帧）→ 恢复外置音频互斥。本会话不再对该壁纸尝试 live，
// 直到用户重开「场景实时渲染」开关（显式重试入口，清空全部记忆）。
function liveFail(reason) {
  const wid = liveWatch ? liveWatch.wid : String(selection.id || "");
  // 失败前抓一份现场：这是「为什么黑/为什么降级」唯一的事后证据（host 侧
  // /wallpaper-engine/diag-log 与渲染页自己的 reportDiag 对齐时间线）。
  const watched = liveWatch;
  liveLog("liveFail", "reason=" + reason + " wid=" + wid
    + " 运行时长=" + (watched ? Date.now() - watched.startedAt : 0) + "ms"
    + " stats=" + JSON.stringify(watched ? liveStats(watched.frame) : null)
    + " 已确认首帧=" + Boolean(watched && watched.firstFrame)
    + " 暂停期跳过tick=" + (watched ? watched.heldPaused : 0)
    + " " + liveStateBrief()
    + " prepare超时计数=" + (prepareLiveTimeouts.get(String(wid)) || 0)
    + " 帧率档=" + selection.sceneLiveFps, "warn");
  stopLiveWatch();
  if (!wid) return;
  const map = Object.assign({}, selection.sceneLiveFailures || {});
  // 记原因而不是 true：设置面板会把它显示出来（用户能反馈「为什么黑」）
  map[wid] = reason === "stall" ? "stall" : "timeout";
  reportClientDiag("live-fail", "reason=" + reason);
  selection.sceneLiveFailures = map;
  try { persistSelection(); } catch { /* ignore */ }
  try { syncLayers(); } catch { /* ignore */ }
  try { syncSceneAudio(selection); } catch { /* ignore */ }
  try { emit(); } catch { /* ignore */ }
}

// ── live GPU 抓帧回填静态帧缓存 ─────────────────────────────────────────────
// 渲染页的显示 canvas 在 DOM 内（data-webwallgl-gl 标记）且 WebGL2 上下文带
// preserveDrawingBuffer:true —— 父页面同源即可随时 toBlob 抓当前帧，无需渲染
// 页/上游配合。首帧确认后 2.5s（实时画面进稳态）HEAD 探测静态帧槽位：
// - 已有 GPU 帧（X-WE-GPU=1）→ 不动；
// - 空槽（404）或已有自定义画面（204 + X-WE-GPU=0）→ 抓帧 PUT 回填：GPU 帧优先
//   于自定义画面（host 每壁纸只接受一次 GPU 帧写入，见 /scene-frame-cache）。
// 失败路径会清 token，于是下一次 live 首帧（通常来自重新挂载）可以重试；
// 成功/已被别人写入则保留 token，避免同一壁纸反复抓帧。
const LIVE_FRAME_BACKFILL_DELAY_MS = 2500;
const LIVE_FRAME_BACKFILL_MIN_BYTES = 4096;
// 空帧门禁（内容判定）：体积不可靠 —— headless Chrome 实测全黑 PNG：
// 960×540=12KB / 1080p=44KB / 4K=165KB，全都远超任何固定的字节阈值。改为把
// canvas 降采样到 64×64 看亮度分布：近全黑或几乎无对比度 → 判为「还没渲染
// 出画面」，放弃回填（宁可继续用自定义画面，也不要写一张坏帧被 409 永久固化）。
const LIVE_FRAME_SAMPLE = 64;
const LIVE_FRAME_LIT_RATIO = 0.02;   // 亮于阈值(12/255)的像素占比下限
const LIVE_FRAME_MIN_VARIANCE = 4;   // 亮度方差下限（纯色帧≈0）
const LIVE_FRAME_BYTES_PER_PX = 0.02; // 黑帧实测约 0.021 B/px，取作体积地板
function liveFrameLooksUsable(canvas, blob) {
  try {
    const w = Number(canvas.width) || 0;
    const h = Number(canvas.height) || 0;
    // 分辨率相关的体积地板：比固定 4KB 有意义（真实画面远高于此）。
    if (w > 0 && h > 0 && blob.size < Math.max(LIVE_FRAME_BACKFILL_MIN_BYTES, w * h * LIVE_FRAME_BYTES_PER_PX)) {
      return false;
    }
    if (!w || !h) return true; // 尺寸未知：退回调用方的基础体积闸
    const probe = document.createElement("canvas");
    probe.width = LIVE_FRAME_SAMPLE;
    probe.height = LIVE_FRAME_SAMPLE;
    const ctx = probe.getContext && probe.getContext("2d");
    if (!ctx || typeof ctx.drawImage !== "function" || typeof ctx.getImageData !== "function") return true;
    ctx.drawImage(canvas, 0, 0, LIVE_FRAME_SAMPLE, LIVE_FRAME_SAMPLE);
    const px = ctx.getImageData(0, 0, LIVE_FRAME_SAMPLE, LIVE_FRAME_SAMPLE).data;
    let lit = 0, sum = 0, sumSq = 0, n = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
      const lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
      sum += lum; sumSq += lum * lum; n++;
      if (lum > 12) lit++;
    }
    if (!n) return true;
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return lit / n >= LIVE_FRAME_LIT_RATIO && variance >= LIVE_FRAME_MIN_VARIANCE;
  } catch {
    return true; // 采样失败不阻断（基础体积闸已过）
  }
}
let liveFrameBackfill = { token: "", timer: 0 };
function cancelLiveFrameBackfill() {
  if (liveFrameBackfill.timer && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    try { window.clearTimeout(liveFrameBackfill.timer); } catch { /* ignore */ }
  }
  liveFrameBackfill = { token: "", timer: 0 };
}
// 抓一张实时画面回填 <key>_gpu.png。
// opts.force = 用户在面板上点了「重新截」：即使缓存里已有 GPU 帧也重抓一张，
// 且失败原因要**告诉用户**（后台自动回填是静默的）。仍然遵守原有的安全顺序：
// 先抓帧 + 过内容门禁，**成功之后**才清旧帧 —— 抓不到就原样保留，绝不留空槽。
function scheduleLiveFrameBackfill(frame, opts) {
  const force = Boolean(opts && opts.force);
  const src = selection.sceneFrameUrl || "";
  if (!src || src.indexOf("/scene-frame/") === -1 || !frame) {
    if (force) { gpuFrameUi.recapturing = false; gpuFrameUi.error = "拿不到实时画面（这个壁纸没有实时渲染）"; try { emit(); } catch { /* ignore */ } }
    return;
  }
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
  const token = String(src.split("/scene-frame/").pop() || "").split("?")[0];
  // force 要能打断「同一 token 已排队/在途」的去重（否则用户点了没反应）。
  if (!token || (!force && liveFrameBackfill.token === token)) return;
  cancelLiveFrameBackfill();
  liveFrameBackfill.token = token;
  const backfillWid = String(selection.id || "");
  // 本次是否因「存帧几何不符」而重抓（落地后据此刷新屏上静帧 + 留诊断痕迹）。
  let recaptured = false;
  let recaptureSize = "";
  // 手动重抓的失败原因要落到面板上（后台自动回填失败是静默的，只在 liveLog 留痕）。
  const forceFail = (msg) => {
    if (!force) return;
    liveLog("gpu-frame-recapture-fail", "wid=" + backfillWid + " " + msg);
    gpuFrameUi.recapturing = false;
    gpuFrameUi.error = msg;
    try { emit(); } catch { /* ignore */ }
  };
  liveFrameBackfill.timer = window.setTimeout(() => {
    liveFrameBackfill.timer = 0;
    (async () => {
      const head = await apiHead(src);
      const hh = head.response;
      const hasGpu = Boolean(head.ok && hh && hh.headers
        && typeof hh.headers.get === "function" && hh.headers.get("x-we-gpu") === "1");
      const win = frame.contentWindow;
      const doc = win && win.document;
      const canvas = doc && typeof doc.querySelector === "function"
        ? doc.querySelector("canvas[data-webwallgl-gl]") : null;
      // 「当前几何」的基准取**抓帧用的那个 canvas**（存帧的 IHDR 就是它的尺寸）：
      // 渲染器若把画布尺寸夹到某个比例（画布比 ≠ iframe 盒比），拿盒比去对照会
      // 永远判「不符」→ 每次挂载都清写一遍。canvas 读不到时退回 iframe 盒比。
      const canvasW = canvas ? Number(canvas.width) || 0 : 0;
      const canvasH = canvas ? Number(canvas.height) || 0 : 0;
      const arRef = canvasW > 0 && canvasH > 0 ? canvasW / canvasH : liveViewportAspect(frame);
      // 存帧几何：宿主从 PNG 的 IHDR 读（X-WE-GPU-AR）；旧宿主没有这个头时退回
      // 本会话抓帧时记下的比例，两者都没有 = 未知。
      let arStored = 0;
      if (hasGpu) {
        const raw = Number(hh.headers.get("x-we-gpu-ar"));
        arStored = Number.isFinite(raw) && raw > 0 ? raw : (gpuFrameAspectKnown.get(token) || 0);
      }
      // 未知（旧宿主 + 本会话没抓过）→ 按「可能不符」处理：重抓一次必然正确，
      // 留一张别处视口的帧则会让用户一直看到放大且被裁的构图。判不了当前几何
      // （arRef=0，如无头/极简环境）时反过来保守保留，避免无休止清写。
      // 用户手点「重新截」（force）时一律按需要重抓处理 —— 他就是要换一张。
      const stale = force || (hasGpu && arRef > 0
        && (arStored <= 0 || Math.abs(arStored - arRef) > GPU_FRAME_ASPECT_TOL * arRef));
      // 已有 GPU 帧且几何相符（含并发窗口里被别人写入）：无需抓帧，保留 token 免重复。
      if (hasGpu && !stale) {
        // 未知几何的保留要留痕：这是「没有头也没重抓」的唯一解释。
        if (arStored <= 0) liveLog("gpu-frame-keep-unknown", "wid=" + backfillWid + " 存帧视比未知 → 保留", "info", true);
        return true;
      }
      if (stale) {
        liveLog("gpu-frame-stale", "wid=" + backfillWid + " 存帧视比 "
          + (arStored > 0 ? arStored.toFixed(4) : "未知") + " ≠ 当前视口 " + arRef.toFixed(4)
          + " → 清掉按当前视口重抓");
      }
      if (!canvas || typeof canvas.toBlob !== "function") {
        if (force) forceFail("拿不到实时画面（实时渲染没在运行，或渲染页还没画布）");
        return false;
      }
      const blob = await new Promise((resolveBlob) => {
        try { canvas.toBlob(resolveBlob, "image/png"); } catch { resolveBlob(null); }
      });
      if (!blob || blob.size < LIVE_FRAME_BACKFILL_MIN_BYTES) {
        if (force) forceFail("抓到的画面是空的（实时渲染还在启动中？稍等一两秒再试）");
        return false;
      }
      // 内容门禁：黑帧/纯色帧判为未渲染 → 放弃（保留槽里原有的帧）。
      if (!liveFrameLooksUsable(canvas, blob)) {
        if (force) forceFail("抓到的画面还没有内容（全黑/纯色）→ 已保留原来那张");
        return false;
      }
      // 真实渲染帧比作者预览图更能代表这张壁纸 ⇒ 顺手给「主题随壁纸」重判一次
      //（排名 2 会盖过预览图那一档；作者配色在场时它自己会让路）。取色复用同一档
      // 64×64 采样，代价可以忽略。
      themeFollowOnFrameCanvas(canvas);
      // 清旧帧放在抓帧+门禁**之后**：先清后抓一旦抓帧失败（画面没出来/网络断）就
      // 只剩空槽 → 退回自定义画面/空态，比留一张旧构图的帧更糟（旧的至少是同一张壁纸）。
      if (stale) {
        const cleared = await clearGpuFrameSlot(token);
        if (!cleared) {
          // 没删掉（权限/占用/宿主报错）→ PUT 也会 409，本帧没换成；清 token 让下
          // 次挂载重试，并留痕（否则用户只看到构图依旧是旧的，没有任何线索）。
          liveLog("gpu-frame-stale-blocked", "wid=" + backfillWid + " 旧帧未删除 → 本轮放弃，下次挂载重试");
          if (force) forceFail("旧实时帧删不掉（被占用或宿主报错）→ 没有改动它，可稍后重试");
          return false;
        }
        recaptured = true;
        recaptureSize = canvasW + "x" + canvasH;
      }
      const put = await apiFetch("/scene-frame-cache/" + encodeURIComponent(token), {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      // 200 写入成功 / 409 已被写入：两种都算「已定局」，不必重试。
      const ok = Boolean(put && (put.ok || put.status === 409));
      // 槽位内容刚被替换：留存里那份字节已不对应盘上这张帧，撤掉（下一次建层重新取、重新留）。
      if (ok) releaseFrameBytes(token);
      if (!ok && force) forceFail("写入失败（宿主返回 " + (put && put.status) + "）");
      if (ok && arRef > 0) gpuFrameAspectKnown.set(token, arRef);
      return ok;
    })().then((settled) => {
      // 抓帧 + 上传是异步的（多 MB PNG 要 0.1–1s），期间用户可能已经切走：
      // 状态更新只对发起时那张壁纸有效 —— 否则会给**当前**壁纸打上「已有 GPU 帧」
      // 的假标记（面板提示错、30s 内被误判为 pinned）。host 侧写入
      // 仍落在 token 自己的槽位，下次回到这张壁纸时面板探测自然会读到。
      if (settled && force) {
        gpuFrameUi.recapturing = false;
        gpuFrameUi.error = "";
        try { emit(); } catch { /* ignore */ }
      }
      if (String(selection.id || "") !== backfillWid) return;
      if (settled) {
        // 缓存里已有（或刚写入）GPU 帧 → 面板提示「优先于全部档位」。
        markGpuFrameProbed(backfillWid, true);
        markGpuFramePin(token, true); // 该 token 槽位刚写入 GPU 帧：探测缓存同步生效，无需再探
        if (recaptured) {
          liveLog("gpu-frame-recaptured", "wid=" + backfillWid + " 已按当前视口重抓（" + recaptureSize + "）");
          // 屏上若正显示这张静帧（静态帧壁纸 / live 垫底 poster）→ 就地重挂取回新图。
          refreshStaticFrameNodes(token);
        }
        try { emit(); } catch { /* ignore */ }
        return;
      }
      // 未定局（拿不到画面、门禁判定未渲染、网络失败）→ 清 token 允许下次重试。
      if (liveFrameBackfill.token === token) liveFrameBackfill.token = "";
      if (force) forceFail("这次没抓成（拿不到画面或写入失败）→ 原来那张没动");
    }).catch(() => {
      if (liveFrameBackfill.token === token) liveFrameBackfill.token = "";
      forceFail("抓帧过程出错 → 原来那张没动");
    });
  }, LIVE_FRAME_BACKFILL_DELAY_MS);
}

// ── live 指针注入（视差/click 交互场景）────────────────────────────────────
// 壁纸层 pointer-events:none，鼠标事件由 DSH UI 消费；window 级 capture 监听
// 仍能收到全部 mousemove/mousedown/mouseup（capture 阶段先于任何元素），归一
// 化后经 __wp.pushPointer 注入渲染页 —— 视差 / cursor 脚本 / 粒子锁点等
// 指针消费方全部激活。协议同 webwallgl docs/INTEGRATION.md §4：u,v ∈ [0,1]、
// Y 朝下勿翻（shader 内自翻）、buttons bit0=左键、按下态保持 ≥16ms（渲染器
// 按帧检测边缘，同帧内 down+up 会丢 click）。事件只在 DSH 窗口内可得 —— 与
// WallpaperEM 的系统级轮询不同，窗口外不推（pointerLeave 语义由 blur 承担）。
let livePointerFrame = null;
let livePointerPending = null; // { u, v, buttons }
let livePointerRaf = 0;
let livePointerDownAt = 0;
function livePointerFlush() {
  livePointerRaf = 0;
  const p = livePointerPending;
  const frame = livePointerFrame;
  if (!p || !frame || !frame.isConnected || !selection.sceneLiveActive) return;
  try {
    const wp = frame.contentWindow && frame.contentWindow.__wp;
    if (wp && typeof wp.pushPointer === "function") wp.pushPointer(p.u, p.v, p.buttons);
  } catch { /* ignore */ }
}
function livePointerSample(e, buttons) {
  if (!livePointerFrame || !selection.sceneLiveActive) return;
  const iw = window.innerWidth || 1;
  const ih = window.innerHeight || 1;
  livePointerPending = {
    u: Math.max(0, Math.min(1, e.clientX / iw)),
    v: Math.max(0, Math.min(1, e.clientY / ih)), // Y 朝下，归一化即协议值
    buttons: buttons,
  };
  if (!livePointerRaf) livePointerRaf = requestAnimationFrame(livePointerFlush);
}
function ensureLivePointer(frame) {
  livePointerFrame = frame;
  if (ensureLivePointer.attached) return;
  ensureLivePointer.attached = true;
  const opts = { capture: true, passive: true };
  window.addEventListener("mousemove", (e) => {
    // e.buttons 实时位掩码；只取 bit0（渲染器也只消费左键语义）。
    livePointerSample(e, e.buttons & 1);
  }, opts);
  window.addEventListener("mousedown", (e) => {
    livePointerDownAt = Date.now();
    livePointerSample(e, 1);
  }, opts);
  window.addEventListener("mouseup", (e) => {
    // 快速点击边缘保持：down→up < 16ms 时延后一拍再抬，保住一次完整
    // down→up 边缘（否则按帧采样会整段漏掉这次点击）。
    if (Date.now() - livePointerDownAt < 16) setTimeout(() => livePointerSample(e, 0), 20);
    else livePointerSample(e, 0);
  }, opts);
  window.addEventListener("blur", () => {
    const f = livePointerFrame;
    if (!f || !f.isConnected || !selection.sceneLiveActive) return;
    try {
      const wp = f.contentWindow && f.contentWindow.__wp;
      if (wp && typeof wp.pointerLeave === "function") wp.pointerLeave();
    } catch { /* ignore */ }
  }, opts);
}
function liveFrameEl() {
  try {
    const layer = document.getElementById(LAYER_ID);
    return layer ? layer.querySelector("iframe.we-live-iframe") : null;
  } catch {
    return null;
  }
}
// 帧**字节**的留存（URL → 一份可同步上屏的东西）。为什么不能只记 URL：把地址写进
// `background-image`，浏览器仍要从零走一遍取值 + 解码，于是同一张壁纸同一份文件，有时第一帧就是帧、
// 有时先是一块主题色纯色 —— 差别只在这一次浏览器来不来得及把它拿回来、解码出来。这一级记的就是
// 那个"来不来得及"：帧加载成功时把它的字节转成一个 object URL（拿不到时留那个已解码的 Image），
// 命中时同步写上屏 —— 画的是已经在本进程里的东西，关键路径上再没有网络与解码环节，于是同样的输入
// 必然得到同样的第一帧。
//
// **必须有界**（FRAME_BYTES_MAX）：一条 object URL 背后是一整帧的字节。不留上限的话，用户每看过
// 一张壁纸就多留一份，一整个会话下来就是"看过的张数 × 单帧体积"的常驻内存 —— 越用越多，且没有任何
// 一处在回收它。超上限即淘汰表头那一条（插入序最早的 = 最久没被用到的，见 paintFrame 的搬尾），
// 并 URL.revokeObjectURL 释放字节（只删记账不撤 object URL，那部分字节在页面关闭前都收不回来）。
//
// **只在真帧 URL 上留**（frameRank === 0 验收）：预览图不能进这张表 —— 它一旦进来，命中分支就会把
// 作者预览图当成"帧"直接上屏，把"帧可用时不得出现缩略图那一帧"那条契约从背面绕过去。
const FRAME_BYTES_MAX = 8;
const liveFrameBytes = new Map();
// 诊断面：留存表本体（排查"内存为什么涨"时，这是唯一能看出留存条数与当前留下哪几张的地方）。
// 只读用途，写它不会改变行为；不挂它就得为同一件事在别处再抄一份记账。
if (typeof window !== "undefined") {
  try { window.__weFrameBytes = liveFrameBytes; } catch { /* ignore */ }
}
function revokeFrameBytes(entry) {
  if (!entry || !entry.objectUrl) return;
  try {
    const api = typeof URL !== "undefined" ? URL : null;
    if (api && typeof api.revokeObjectURL === "function") api.revokeObjectURL(entry.objectUrl);
  } catch { /* ignore */ }
  entry.objectUrl = "";
}
function retainFrameBytes(src, img) {
  let api = null;
  try { api = typeof URL !== "undefined" ? URL : null; } catch { /* ignore */ }
  const existing = liveFrameBytes.get(src);
  if (existing) { revokeFrameBytes(existing); liveFrameBytes.delete(src); }
  const entry = { objectUrl: "", img: img || null };
  liveFrameBytes.set(src, entry);
  while (liveFrameBytes.size > FRAME_BYTES_MAX) {
    const oldest = liveFrameBytes.keys().next();
    if (oldest.done) break;
    revokeFrameBytes(liveFrameBytes.get(oldest.value));
    liveFrameBytes.delete(oldest.value);
  }
  // 字节的来源是**已经解码好的那个 Image**：画进 canvas 再取回 blob（只走本进程内存，不发新请求）。
  // 取不回来（无 canvas / 无 toBlob / 画布被跨源污染）时不记 object URL，命中时退回逐级探针那条路。
  if (!img || typeof document === "undefined" || typeof document.createElement !== "function") return;
  if (!api || typeof api.createObjectURL !== "function" || typeof Blob !== "function") return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width || 0;
    canvas.height = img.naturalHeight || img.height || 0;
    if (!canvas.width || !canvas.height) return;
    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!ctx || typeof ctx.drawImage !== "function") return;
    ctx.drawImage(img, 0, 0);
    const toBlob = canvas.toBlob || canvas.webkitToBlob;
    if (typeof toBlob !== "function") return;
    toBlob.call(canvas, (blob) => {
      if (!blob) return;
      // 异步回来时这一条可能已被淘汰 / 已被换掉：那时不能再写进去（否则又是一条没人释放的 object URL）。
      if (liveFrameBytes.get(src) !== entry) return;
      let url = "";
      try { url = api.createObjectURL(blob); } catch { return; }
      entry.objectUrl = url;
    }, "image/png");
  } catch { /* ignore */ }
}
// 帧被删掉（用户清除 / 几何不符重抓 / 重新截图）时连同留存一起撤掉：留着就等于继续拿一份已经
// 不存在的帧上屏，屏上是错构图，而且那份字节在页面关闭前不会自己消失。
function releaseFrameBytes(token) {
  const key = String(token || "");
  if (!key) return;
  for (const src of [...liveFrameBytes.keys()]) {
    if (src.indexOf(key) === -1) continue;
    revokeFrameBytes(liveFrameBytes.get(src));
    liveFrameBytes.delete(src);
  }
}
// 从留存上屏（同步）：object URL 优先（写 `background-image`，与逐级探针同一条上屏通道，
// 定位/适应的样式一个字都不用改）；拿不到 object URL 的重宿主退回插入那个**已解码的 Image**
// 本身（元素进 DOM 即可绘制，同样不触发新的取值与解码）。
function paintFrame(poster, src) {
  const entry = liveFrameBytes.get(src);
  if (!entry) return false;
  // 命中 = 这一条**刚被用到**：把它移到表尾，淘汰侧（retainFrameBytes 的 while）才有
  // 「最早出表的是最久没被画过的那一条」这条语义。只读 `get` 不搬尾的话，淘汰顺序退化成
  // 插入顺序，常用的老条目会在"来回切少数几张 + 偶尔来一张新的"下被先淘汰掉。
  liveFrameBytes.delete(src);
  liveFrameBytes.set(src, entry);
  if (entry.objectUrl) {
    poster.dataset.weFrameSrc = src; // 诊断口径不变：记**屏上**那一级
    poster.style.backgroundImage = "url(" + entry.objectUrl + ")";
    return true;
  }
  if (!entry.img || typeof entry.img.cloneNode !== "function") return false;
  // 克隆而不是搬原元素：探针那个 Image 可能还挂在别处，搬走会把它从原位置抽掉。
  const copy = entry.img.cloneNode(false);
  if (copy.style) {
    copy.style.position = "absolute";
    copy.style.inset = "0";
    copy.style.width = "100%";
    copy.style.height = "100%";
    copy.style.objectFit = "cover";
  }
  try { copy.setAttribute("data-we-frame-src", src); } catch { /* ignore */ }
  copy.className = "we-media we-media--fit";
  poster.appendChild(copy);
  poster.dataset.weFrameSrc = src;
  return true;
}
function buildLivePoster(sel) {
  const poster = document.createElement("div");
  poster.className = "we-media we-live-poster";
  // 底色兜底：壁纸没写 schemecolor 时用主题面板色打底 —— 无抽帧图、无主题色时
  // 加载期也必须是「一层安静的颜色」，不能是纯黑或透明。
  poster.style.backgroundColor = sel.schemeColor || "var(--dsw-alias-bg-layer-1, #101418)";
  // 垫底画面的来源（**唯一权威顺序**）：**实时抓帧 → 作者随包发布的工程预览图 → 主题色**。
  //   · 抓帧 = 场景的出图 URL（`?v=` 只剩 0 / 4 两档）或网页的 live 抽帧（见 maybeCaptureLiveFrame）；
  //   · 预览图**只作首帧前的占位**：新壁纸**第一次**激活时抓帧还不存在（要等这一轮 live 首帧
  //     回填），只试一级会 404 —— 而失败若「静默保留主题色」（`#101418`，近黑）就是一块黑屏。
  //   · 预览图是**作者随包发布的那张**，不是本插件合成的"猜图"（与 buildMedia 里 scene 静态
  //     img 的 onerror 回落同源）⇒ 不破「要么给真画面、要么诚实留空」那条裁定。
  // 顺序不能反：抓帧才是当前视口的真实构图，它一到就被顶掉；预览图只是"还没来得及出帧"的占位。
  const candidates = (sel.type === "web" ? [sel.liveFrame, sel.previewUrl] : [sel.url, sel.previewUrl])
    .filter((s) => typeof s === "string" && s);
  if (!candidates.length) return poster;
  poster.dataset.weFrameSrc = candidates[0];
  // 与 prepareSceneStaticStage 同一约定：无 Image 的环境（headless 验收 /
  // 只给部分 DOM 的测试宿主）跳过预载，保留主题色兜底 —— 否则建 live 层时
  // 会直接抛 ReferenceError。
  if (typeof Image !== "function") return poster;
  // 第 1 级（实时帧）究竟是哪个候选：web 支没有 `liveFrame` 时**这一级不存在**（宿主发了这条
  // 字段，客户端却没有它的写入点 ⇒ web 的候选表里实际只剩预览图）。那种情况下不能把
  // `candidates[0]` 当成"实时帧已存在"记进来 —— 记下的会是缩略图，语义就假了。所以下面只认
  // 「rank 0 且确实等于实时帧 URL」的那一个。
  const frameSrc = sel.type === "web" ? (sel.liveFrame || "") : (sel.url || "");
  const frameRank = frameSrc && candidates[0] === frameSrc ? 0 : -1;
  // **图恒盖色**：`background-image` 永远画在同一元素的 `background-color` 之上，且全仓只有
  // 上面那一处写底色 ⇒ 这里不存在"谁遮谁"，只有两件事要定：**谁允许上屏**与**什么时候发请求**。
  // 上屏规则（**存在性闸门**，与请求解耦）：第 r 级只允许在比它更权威的每一级都**已判失败**
  // 之后上屏 —— 高权威级在飞 / 已就绪，低权威级一律不许上屏（缓存实时帧存在时，作者预览图
  // 一次都不该成为屏上那张，哪怕它先解码完）；高权威级判失败 ⇒ 已就绪的低权威级此刻补上
  // （它就是"这一级不存在"的兜底）；全部判失败 ⇒ 停在主题色兜底。级号越小越权威（见 candidates）。
  const loadedRank = candidates.map(() => ""); // 已就绪的候选（可能仍被更权威的级挡在屏外）
  const failedRank = candidates.map(() => false); // 每一级是否已**判失败**（= 这一级不存在）
  const noneAbove = (rank) => {
    for (let i = 0; i < rank; i++) if (!failedRank[i]) return false; // 更权威的级未判失败 ⇒ 挡住
    return true;
  };
  // 这一层「已经有画面 / 已经判定没有画面」的**元素级**记账 —— 建层方在等这个信号
  //（见 syncLayers 的切层内容闸门）。窗口 = 探针发出 → 有图或被判无图，也就是屏上
  // 只有第 0 级纯色的那一段。
  const contentSettled = () => {
    poster.dataset.weContent = "ready";
    noteLayerContent(poster);
  };
  const applyRank = (rank) => {
    const src = loadedRank[rank];
    if (!src || !noneAbove(rank)) return;
    poster.dataset.weFrameSrc = src; // 记录**屏上**那一级（诊断：当前用的是哪一级）
    if (poster.isConnected) poster.style.backgroundImage = "url(" + src + ")";
    contentSettled();
  };
  const probeRank = (rank) => {
    const src = candidates[rank];
    const probe = new Image();
    probe.onload = () => {
      // 第 1 级加载成功 ⇒ 先留下可同步上屏的字节（见 liveFrameBytes），下一次建层就能同步上帧。
      // 其它级（作者预览图）**不留**：留了命中分支就会把预览图当成"帧"直接上屏。
      if (rank === frameRank) retainFrameBytes(src, probe);
      loadedRank[rank] = src;
      applyRank(rank);
    };
    probe.onerror = () => {
      // 判失败 = 这一级**不存在**：低权威级的上屏闸门因此打开（已经就绪的那一级立刻补上）。
      failedRank[rank] = true;
      for (let i = rank + 1; i < candidates.length; i++) applyRank(i);
      // 每一级都判失败、且一张都没上屏 ⇒「这张壁纸没有画面」这个结论已经确定，再等也不会有图：
      // 闸门必须放行，否则守着旧层的那个等待永远等不到信号。终点语义仍是主题色兜底。
      if (failedRank.every(Boolean) && !loadedRank.some(Boolean)) contentSettled();
    };
    probe.src = src;
  };
  if (frameRank === 0 && paintFrame(poster, frameSrc)) {
    // 字节命中：帧同步上屏，**探针一个都不发** —— 连"复核这一级还在不在"都不需要：字节已经在本
    // 进程里，此刻屏上那一张就是可用的。复核反而会把一份完好的帧撤下来退回缩略图。
  } else {
    // 图到手之前这一层不算「有画面」（垫底图此刻只有第 0 级底色）——先记账，出图或
    // 被判无图时由上面两处销账。
    poster.dataset.weContent = "pending";
    // 没有字节在手（首次激活 / 冷启动 / 清帧之后）⇒ 逐级**并行**发请求（退级不依赖彼此的成败、
    // 也不挡发请求），谁上屏仍由上面的存在性闸门说了算。帧这次成功了就在 onload 里留下字节，
    // 下一次建层走上面那条。
    for (let i = 0; i < candidates.length; i++) probeRank(i);
  }
  return poster;
}

// 页面加载后是否仍处于「重启恢复」阶段：true 期间首次挂载 live 会延迟（见
// buildMedia 的 liveBootDelay）；用户一旦有交互（点击/按键）立即置 false ——
// 手动切换壁纸必须即时反馈，不延迟。
let bootRestore = true;
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  for (const ev of ["pointerdown", "keydown"]) {
    window.addEventListener(ev, () => { bootRestore = false; }, { capture: true, passive: true, once: true });
  }
}
// 延迟挂载（只作用于「重启恢复上次壁纸」那一档）：**延迟期照常开始加载** —— iframe 一赋
// `src` 就已经在拉 pkg / 解码纹理 / 编译 shader，这正是这一档存在的理由（让首帧先热起来，
// 上屏时才不至于慢）。延迟只决定**什么时候把它插进图层**。
//
// 两条不变量，缺哪条都会变成用户可见的卡顿：
//   ① **首帧就绪即挂载**：`liveBootDelay` 是**上限**而不是固定等待 —— 读到首帧就立刻换屏，
//      出帧快的壁纸不再白等满 N 秒；到上限仍未出帧也照挂（最坏情况与固定等待一致）。
//   ② **切走必须取消并释放**：未挂载的预热页是一个**正在跑**的渲染页，不是普通元素 ——
//      换壁纸时不显式终止（`src = about:blank`）它就会留在后台继续抢 CPU/GPU，与新壁纸的
//      启动叠在同一主线程上（用户反馈：延迟期切下一张会卡）。这与轮换准备期的 staging 探针
//      是同一条纪律（见 prepareSceneLiveStage 的 bail / 「准备期零驻留」）。
let liveMountPending = null; // { sel, frame, timer, deadline }
const LIVE_MOUNT_POLL_MS = 300;
function cancelLiveMount(reason) {
  const p = liveMountPending;
  if (!p) return;
  liveMountPending = null;
  if (p.timer) { try { clearTimeout(p.timer); } catch { /* ignore */ } }
  // 未挂载 ⇒ 显式中止在途加载并拆掉那个渲染页（WebGL context / rAF / 定时器一起消失）。
  try { if (p.frame && !p.frame.isConnected) p.frame.src = "about:blank"; } catch { /* ignore */ }
  if (reason) liveLog("boot-mount-cancel", "wid=" + p.sel.id + " reason=" + reason);
}
/** 首帧是否已出来。场景与 startLiveWatch 的「活」判据同源（running 且 fps>0）；网页壁纸
 *  常无 rAF 打点，退化为「渲染页可达」（getState 可读）—— 与运行期 watchdog 同口径。 */
function liveFrameReady(frame, sel) {
  if (sel.type === "web") return Boolean(liveStateOf(frame));
  const st = liveStats(frame);
  return Boolean(st && st.running && st.fps > 0);
}
function scheduleLiveMount(sel, frame, delayMs) {
  cancelLiveMount("replaced"); // 同一时刻只允许一个未上屏的预热页
  const entry = { sel, frame, timer: 0, deadline: Date.now() + delayMs };
  liveMountPending = entry;
  const mount = (viaIdle) => {
    if (liveMountPending !== entry) return; // 已被取消 / 被替换
    const layer = document.getElementById(LAYER_ID);
    if (selection.id !== sel.id || !liveRenderEnabled(selection) || !layer) { cancelLiveMount("stale"); return; }
    if (frame.isConnected) { liveMountPending = null; return; } // 已被别的路径挂上（轮换领养）
    // 层里已经有 live 页（轮换的节点级领养）：绝不再插第二个。
    if (layer.querySelector("iframe.we-live-iframe")) { cancelLiveMount("layer-has-live"); return; }
    liveMountPending = null;
    layer.appendChild(frame);
    // ⚠️ 必须在这里补一次武装：`load` 回调只在 `isConnected` 时武装心跳，而延迟路径的文档
    //    很可能**在挂载之前**就 load 完了（那一刻 isConnected=false）⇒ 不补这一次，首帧确认
    //    永远不会发生、`we-live-on` 永远不加上、iframe 一直停在 opacity 0（只有垫底图）。
    //    startLiveWatch 自己会停掉上一个，重复武装是安全的。
    try { startLiveWatch(frame, sel.id); } catch { /* ignore */ }
    liveLog("boot-mount", "wid=" + sel.id + (viaIdle ? " idle" : " ready"));
  };
  const tick = () => {
    if (liveMountPending !== entry) return;
    if (liveFrameReady(frame, sel)) { mount(false); return; } // ① 就绪即挂载，不等上限
    if (Date.now() >= entry.deadline) {
      // 到上限仍未出帧：仍走「等首屏空闲再挂」（最坏情况与固定等待那一版一致）。
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => mount(true), { timeout: 2000 });
      } else {
        setTimeout(() => mount(true), 300);
      }
      return;
    }
    entry.timer = setTimeout(tick, LIVE_MOUNT_POLL_MS);
  };
  entry.timer = setTimeout(tick, Math.min(LIVE_MOUNT_POLL_MS, delayMs)); // 首拍稍早：小 pkg 可能一帧内就绪
}

function createLiveFrame(sel) {
  const frame = document.createElement("iframe");
  frame.src = liveRenderUrl(sel);
  frame.setAttribute("frameborder", "0");
  frame.setAttribute("scrolling", "no");
  // iframe 内音频（HTMLAudioElement / 网页壁纸的媒体）的自动播放授权。
  frame.setAttribute("allow", "autoplay");
  frame.className = "we-media we-iframe we-live-iframe";
  frame.addEventListener("load", () => {
    // onload 只说明文档加载完成（模块还在执行 / pkg 未拉取），真正「活」
    // 由心跳判定；文档若已被重建移除则直接放弃。
    if (frame.isConnected) startLiveWatch(frame, sel.id);
  });
  return frame;
}

// 网页壁纸：live 就绪 3 秒后抽一帧（等动画进入稳定画面）存到 host，
// 之后每次加载/重启先用它占位。抽帧失败静默（占位逻辑不受影响）。
let liveFrameCapturedFor = "";
function maybeCaptureLiveFrame(frame, sel) {
  if (sel.type !== "web" || !sel.liveFrame) return;
  if (liveFrameCapturedFor === String(sel.id)) return;
  liveFrameCapturedFor = String(sel.id);
  setTimeout(() => {
    if (!frame.isConnected || selection.id !== sel.id) return;
    let dataUrl = null;
    try {
      const wp = frame.contentWindow && frame.contentWindow.__wp;
      dataUrl = wp && typeof wp.capture === "function" ? wp.capture(1920) : null;
    } catch { return; }
    if (!dataUrl || dataUrl.indexOf("data:image/") !== 0) return;
    // 网页壁纸的真实帧同样是比作者预览图更好的证据：交给「主题随壁纸」重判一次
    //（排名 2；作者配色在场时它自己会让路）。
    themeFollowOnFrameImage(dataUrl);
    // 两跳都走统一出入口：`data:` URL 是**本地字节转换**（apiUrl 原样放行），POST 才是宿主 API。
    apiFetch(dataUrl).then((r) => r.response.blob()).then((blob) => apiFetch(sel.liveFrame, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    })).then(() => {
      // 帧被换掉了：留存里那份字节属于正被替换掉的那一帧，撤掉（下一次建层按新帧重新留）。
      releaseFrameBytes(sel.liveFrame);
      // 就地换上刚抽的帧（当前会话立刻可见；下次加载由 host 缓存直接提供）
      const layer = document.getElementById(LAYER_ID);
      const poster = layer && layer.querySelector(".we-live-poster");
      if (poster && poster.style && !poster.dataset.weFrameApplied) {
        poster.dataset.weFrameApplied = "1";
        poster.style.backgroundImage = "url(" + sel.liveFrame + "?t=" + Date.now() + ")";
      }
      reportClientDiag("live-capture", "uploaded");
    }).catch((e) => { reportClientDiag("live-capture-fail", String(e && e.message || e)); });
  }, 3000);
}

// ── 切层内容闸门 ─────────────────────────────────────────────────────────────
// 新层一进文档就会被画出来，而它的画面都是**异步**就位的：垫底图要等帧/预览图的探针
// onload，<video> 要等第一帧，Edge 的镜像画布要等 weDrawFrame 的第一笔。于是"切过去"
// 之后最先上屏的其实是**只有第 0 级底色**的新层 —— 一次普通切换里那几帧纯色就是它。
// 深浅主题自动切换只是把这段窗口拉长（它写主题时宿主会重写全量别名令牌并强制读一次
// 样式，都压在同一主线程上，新层的画面要排到它后面），所以把那个开关关掉也仍然看得见。
// 旧层的画面是现成的，于是这里反过来做：**新层有画面之前不撤旧层，也不让新层参与绘制**
// （`we-layer--pending`，见 src/styles.js）。这段窗口里屏上一直是旧壁纸的像素。
// 放行的条件都是**有限**的事件（每一级的成败、视频的 loadeddata/canplay/error、
// 画布的第一笔都会到），不新增等待种类：一张图都没有时仍然停在既有的主题色兜底语义上。
const LAYER_PENDING_CLASS = "we-layer--pending";
let pendingReveal = null; // { node, outgoing, tr, fade, hooks }
// 媒体元素报告"我有画面了"的唯一出口：垫底图的探针与 Edge 的镜像画布各自在落下
// 那一笔时调它（见 buildLivePoster 的 contentSettled 与 weDrawFrame）。
function noteLayerContent(el) {
  if (el && typeof el.__weContent === "function") el.__weContent();
}
// 这一层现在有画面吗（同步判定）。判不了（精简 DOM，没有选择器）时不拦 —— 闸门只用
// 来避免"显示了但没有画面"，不是给所有路径加一道等待。
function layerContentReady(node) {
  if (!node || typeof node.querySelector !== "function") return true;
  // 垫底图（场景 / web 的 live 分支）是这一层里**负责盖住加载窗口**的那一层：
  //   · 它有图 ⇒ 有内容；
  //   · 它已定论"没有图" ⇒ 这一层的内容就是第 0 级兜底（终点语义，见 P2 与 buildLivePoster）；
  //   · 只有"还在等图"时才算没内容 —— 例外是实时渲染页已经出帧：那一刻屏上已经有画面，
  //     垫底图只是被它盖住的下层。
  const poster = node.querySelector("div.we-live-poster");
  if (poster) {
    if (poster.style && String(poster.style.backgroundImage || "")) return true;
    if (poster.dataset && poster.dataset.weContent === "pending") {
      const liveNow = node.querySelector("iframe.we-live-iframe");
      return !!(liveNow && String(liveNow.className).indexOf("we-live-on") !== -1);
    }
    return true;
  }
  const img = node.querySelector("img");
  if (img) {
    // 准备期已经 load 过的元素由 adoptProbe 打上标记；新块的 <img> 看解码结果
    //（`complete` 同时覆盖加载失败，所以还要 naturalWidth —— 失败不算"有画面"）。
    if (img.__weReady === true) return true;
    return img.complete === true && Number(img.naturalWidth) > 0;
  }
  const video = node.querySelector("video");
  if (video) {
    // 作者静帧（poster 属性）本身就是画面。
    if (video.getAttribute && video.getAttribute("poster")) return true;
    if (video.__weReady === true) return true;
    // Edge 把画面画进镜像 canvas，而画布底是写死的 #000：视频有帧还不够，要等
    // weDrawFrame 真的画上去一笔（那一笔落下时 canvas 会来报）。
    if (node.querySelector("canvas.we-media--canvas")) return false;
    return Number(video.readyState) >= 2; // HAVE_CURRENT_DATA = 手上已有一帧
  }
  const live = node.querySelector("iframe.we-live-iframe");
  if (live) return String(live.className).indexOf("we-live-on") !== -1;
  // 裸 iframe（web 旧链）的画面由它自己的文档决定，外面读不到 —— 不拦。
  // 空层没有任何可等的媒体，拦下去就永远放不出来。
  return true;
}
function forgetPendingReveal() {
  const p = pendingReveal;
  pendingReveal = null;
  if (!p) return p;
  for (const el of p.hooks) { try { el.__weContent = null; } catch { /* ignore */ } }
  return p;
}
function revealPendingLayer() {
  const p = forgetPendingReveal();
  if (!p) return;
  try { if (p.node.classList) p.node.classList.remove(LAYER_PENDING_CLASS); } catch { /* ignore */ }
  if (p.fade) {
    // 画面到的这一刻才起过场：新层从透明的初态走到终态，全程都有画面。
    startLayerTransition(p.node, p.outgoing, p.tr);
  } else {
    // 硬切：旧层此刻一次性退场（释放媒体 + 放行新层音频），新层已经可以直接画。
    retireFadingLayer();
  }
  liveLog("layer-reveal", "wid=" + selection.id + " 新层已有画面 → 放行");
}
// 新层还没有画面：旧层继续留在屏上，新层先不参与绘制，画面一到就放行。
function armLayerContentReveal(node, outgoing, tr, fade) {
  const recheck = () => { if (layerContentReady(node)) revealPendingLayer(); };
  // 加载失败同样是「这张壁纸没有画面」的确定结论，必须放行 —— 否则这一层永远换不下去。
  const giveUp = () => revealPendingLayer();
  const hooks = [];
  const poster = node.querySelector("div.we-live-poster");
  if (poster) hooks.push(poster);
  const canvasEl = node.querySelector("canvas.we-media--canvas");
  if (canvasEl) hooks.push(canvasEl);
  for (const el of hooks) { try { el.__weContent = recheck; } catch { /* ignore */ } }
  const img = node.querySelector("img");
  if (img && typeof img.addEventListener === "function") {
    img.addEventListener("load", recheck);
    img.addEventListener("error", giveUp);
  }
  const video = node.querySelector("video");
  if (video && typeof video.addEventListener === "function") {
    // loadeddata / canplay = 浏览器手上已经有一帧（spec 的 readyState ≥ 2 / 3）；
    // Edge 那条路由镜像画布的第一笔补最后一步（layerContentReady 会一起看）。
    const frameReady = () => { try { video.__weReady = true; } catch { /* ignore */ } recheck(); };
    video.addEventListener("loadeddata", frameReady);
    video.addEventListener("canplay", frameReady);
    video.addEventListener("error", giveUp);
  }
  try { if (node.classList) node.classList.add(LAYER_PENDING_CLASS); } catch { /* ignore */ }
  // 新层上屏之前先压住它的音源：旧层还在可见期内出声，两层 BGM 不重叠。
  openRotationAudioGate(node, outgoing);
  pendingReveal = { node, outgoing, tr, fade, hooks };
  liveLog("layer-hold", "wid=" + selection.id + " 新层还没有画面 → 旧层留在屏上（"
    + (fade ? "过场" : "硬切") + "延后到有画面）");
}

function syncLayers() {
  // 轮换渐变标记在入口消费：commitRotationSwitch 置位后首个 syncLayers 即
  // applySelection 的 emit；无旧层可淡（首壁纸/已清除）时自然作废，绝不
  // 滞留到下一次无关重建。
  const rotationFade = pendingRotationFade;
  pendingRotationFade = false;
  // 1. Wallpaper element.
  let existing = document.getElementById(LAYER_ID);
  if (selection.url) {
    // live 是否生效只需算一次：它同时决定「media 种类看不看 sceneVideo」与 live 段本身。
    const layerLive = (selection.type === "scene" || selection.type === "web") && liveRenderEnabled(selection);
    // 本次切换用的过场（类型 + 方向 + 毫秒）也只算一次：startFade 判定与两处调用点共用。
    const switchTr = switchTransitionOf(selection);
    const wantKey = selection.type + "\u0000" + selection.url + "\u0000"
      + (IS_EDGE && selection.edgeCompat !== false ? "canvas" : "video")
      // Scene wallpapers: the media kind depends on sceneVideo (MP4 <video> vs
      // static-frame <img>), and the 404 fallback nulls sceneVideo — the key
      // must reflect it so the fallback rebuilds the layer.
      // ⚠️ live 生效期间不算它：buildMedia 的 isSceneVideo 已被 isLive 短路，此时
      // sceneVideo 只影响「live 失败后的回退」，进 key 只会白白冷启动渲染页 ——
      // 「sceneVideo 诚实化」的时序补拉（scheduleSceneVideoResync）落地时正好会
      // 触发这种无意义重建。live 一失效，下面的 live 段就变化 → 仍会重建，且那一次
      // 会用上当时的 sceneVideo 值（回退路径因此照旧正确）。
      + "\u0000" + (layerLive ? "" : (selection.sceneVideo || ""))
      + "\u0000" + (selection.sceneAudioUrl || "")
      // Scene live render: entering/leaving live（开关切换、按壁纸失败记忆、
      // 帧率档变更 → iframe query 变化）都必须重建层；fit/音量不进 key ——
      // 它们经 __wp.setFit/setVolume 热切，无需重载渲染页。
      + "\u0000" + ((selection.type === "scene" || selection.type === "web")
        ? (layerLive
          // weAssetsAvailable 进 key：素材目录开关切换时 live iframe URL 的
          // localAssets 参数变化，必须重建渲染页才生效。
          ? "live\u0000" + (selection.sceneLiveSrc || selection.webLiveSrc) + "\u0000" + selection.sceneLiveFps
            + "\u0000" + (selection.inventory && selection.inventory.weAssetsAvailable ? "la1" : "")
          : "nolive")
        : "");
    let gotKey = existing && existing.dataset.weKey;
    // 上一跳停在"等新层画面"上、而这一跳要换层：LAYER_ID 在**还没有画面**的那个层手里，
    // 屏上其实是它守着的旧层。那个空层从未上屏，就地拆掉；这一跳的旧层取守着的那个 ——
    // 否则连切两下会各露一次底色。（键相同则不动：那只是同一次切换的又一次 emit。）
    if (pendingReveal && pendingReveal.node === existing && gotKey !== wantKey) {
      const blank = existing;
      existing = pendingReveal.outgoing || null;
      forgetPendingReveal();
      stopLiveWatch();                 // 空层的心跳随它一起停
      releaseLayerMedia(blank);
      try { blank.remove(); } catch { /* ignore */ }
      gotKey = existing && existing.dataset.weKey;
      if (existing) {
        // 守着的那个层全程没有离开过屏，它就是**当前壁纸那一层**：把 LAYER_ID 还给它、
        // 清掉待退役标记（否则下面会当它是废层，再建一个重复的层出来）。它的心跳在
        // 上一跳里停了，按领养路径同一套规则补回。
        try { existing.dataset.weFading = ""; } catch { /* ignore */ }
        fadingLayerNode = null;
        try { existing.id = LAYER_ID; } catch { /* ignore */ }
        const heldLive = existing.querySelector("iframe.we-live-iframe");
        if (heldLive) { try { startLiveWatch(heldLive, selection.id); } catch { /* ignore */ } }
      }
    }
    let startFade = false;
    let outgoing = null;               // 这一跳的旧层（让出 LAYER_ID，留到新层有画面为止）
    if (existing && gotKey !== wantKey) {
      liveLog("layer-rebuild", layerKeyDiff(gotKey, wantKey) + " " + liveStateBrief());
      // 交叉淡化判定：**换壁纸**（手动点选/轮换提交，层上 weWid ≠ 当前选择 id）
      // 一律淡出 —— 旧层保留被新层盖过去（真交叉淡化）；**同一张壁纸的内部重建**
      // （live 降级/fps 档/切换出图来源/live 开关，weWid 相同）保持硬切：重建前后是
      // 同一条 BGM，淡出 + 音频闸会让它断 ~2s，反而更糟。rotationFade（轮换
      // commit 的显式标记）作为兜底保留 —— 覆盖 weWid 缺失或轮换同 wid 极端角落。
      const widChanged = String(existing.dataset.weWid || "") !== String(selection.id || "");
      // 过场类型为「硬切」时根本不进过渡路径 —— 但"不搞过场"不等于"现在就拆"：
      // 旧层的处置统一放在新层建好之后（见下面的切层内容闸门）。
      startFade = (rotationFade || widChanged) && switchTr.id !== "cut";
      outgoing = existing;
      // 旧层让出 LAYER_ID（新层要用它）并标记为待退役；拆/淡都推迟到新层建好之后。
      outgoing.dataset.weFading = "1";
      try { outgoing.id = ""; } catch { /* ignore */ }
      // 任何时刻最多 2 层：更早那一份"守层 / 淡出层"先退役（这一跳接着守的那个不算）。
      if (fadingLayerNode && fadingLayerNode !== outgoing) retireFadingLayer();
      fadingLayerNode = outgoing;
      // 旧 live 心跳退役（iframe 本身保活续播）；新层的 watch 由 buildMedia
      // （fresh load 或领养路径）重启。
      stopLiveWatch();
    }
    let node = document.getElementById(LAYER_ID);
    // 渐变路径旧层已让出 LAYER_ID；mock 环境的 stale byId 命中按 weFading 排除。
    if (node && node.dataset && node.dataset.weFading === "1") node = null;
    if (!node && pendingStagedLayerNode) {
      // live/web 轮换的节点级领养：staging 容器整体转为新层 —— iframe 全程不
      // 移动（同文档 reparent 会重载文档），渲染/加载状态零扰动。
      node = pendingStagedLayerNode;
      pendingStagedLayerNode = null;
      node.id = LAYER_ID;
      node.dataset.weKey = wantKey;
      node.dataset.weWid = String(selection.id || "");
      node.className = "we-layer";
      const adoptedLive = node.querySelector && node.querySelector("iframe.we-live-iframe");
      if (adoptedLive) {
        // 首帧已在准备期确认：立即点亮 + 心跳续跑运行期看护。
        try { adoptedLive.classList.add("we-live-on"); } catch { /* ignore */ }
        // 领养路径的渲染页是**已经在出帧**的热页：紧接着的 applyLiveControls
        // （本函数末尾）若判定「非有效播放」会把它 pause 掉，而暂停中的渲染页
        // __wpStats.frame() 恒为 {fps:0,running:false} —— 首帧看护必须据此暂停
        // 计时（见 startLiveWatch），否则 15s 后误判首帧超时并永久降级。
        liveLog("adopt-live", "wid=" + selection.id + " 节点级领养（渲染页不重载）");
        try { startLiveWatch(adoptedLive, selection.id); } catch { /* ignore */ }
      }
    }
    if (!node) {
      node = document.createElement("div");
      node.id = LAYER_ID;
      node.className = "we-layer";
      node.dataset.weKey = wantKey;
      node.dataset.weWid = String(selection.id || "");
      const built = buildMedia(selection);
      if (Array.isArray(built)) for (const el of built) node.appendChild(el);
      else node.appendChild(built);
      document.body.appendChild(node);
    }
    // ── 旧层处置：新层有画面 ⇒ 立刻按过场 / 硬切换；还没有画面 ⇒ 旧层留在屏上，
    //    新层先不参与绘制，画面一到就放行（见本文件上方的切层内容闸门）。─────────
    //    过场：新层在旧层之上入场（旧层保持不透明垫着，玻璃 backdrop-filter 依赖
    //    不透明背景）；旧层退场 / 音频放行 / 收尾清理都在 startLayerTransition 里统一处理。
    if (outgoing) {
      if (layerContentReady(node)) {
        if (startFade) startLayerTransition(node, outgoing, switchTr);
        else {
          // 硬切：旧层一次性退场（释放媒体 + 放行新层音频），再停掉旧的镜像绘制循环。
          // Release the previous draw loop: without this, switching from an Edge
          // canvas video to a non-canvas wallpaper (image/web/scene, or Edge 兼容
          // turned off) would keep the old hidden <video> referenced and playing
          // forever — CPU/GPU/battery + memory leak per switch (rotation mixes
          // types). weStartDraw() re-initialises when a canvas exists again.
          retireFadingLayer();
          weStopDraw();
        }
      } else {
        armLayerContentReveal(node, outgoing, switchTr, startFade);
      }
    }
    const canvas = node.querySelector("canvas.we-media--canvas");
    const video = node.querySelector("video");
    // Scene live render: 播放态/音量/fit 向渲染页 __wp 收敛（每次 emit 幂等；
    // __wp 未就绪时由心跳 tick 每秒兜底），并挂上指针注入（capture 监听一次
    // 注册，此后只更新目标 frame 引用）。
    const liveFrame = node.querySelector("iframe.we-live-iframe");
    if (liveFrame) {
      applyLiveControls(liveFrame);
      ensureLivePointer(liveFrame);
    }
    // Edge-only: drive the canvas mirror from the hidden decoder video.
    // Incremental guard: every emit (including the 500ms transcode poll) used
    // to run a FULL weStopDraw + weStartDraw — rebuilding the ResizeObserver,
    // re-registering rVFC and forcing a getComputedStyle read each time.
    // Same canvas + same video → the draw loop is already running; skip it.
    // (自定义壁纸的 objectFit 变更由「适配」按钮直接写 weDrawCtx.fit。)
    if (canvas && video) {
      const sameDraw = weDrawCtx && weDrawCtx.canvas === canvas && weDrawCtx.video === video;
      if (!sameDraw) weStartDraw(canvas, video, canvas.className.indexOf("we-media--fit") !== -1);
    }
    if (video) {
      // 播放态收敛（#84）：意图 → 元素真实状态，失败时回写 store 让「播放」
      // 按钮回来（见 applyVideoPlayback）。
      applyVideoPlayback(video);
      // Keep the rate in sync on every layer sync (covers rate changes while
      // the same wallpaper keeps playing — instant, no media reload).
      try { if (video.playbackRate !== selection.playbackRate) video.playbackRate = selection.playbackRate; } catch { /* ignore */ }
      // Frame-skip transcode (帧率上限): play the original now, swap to the
      // capped-fps re-encode when the host finishes it (no-op when cap is 0).
      if (selection.type === "video" && selection.url) {
        maybeUpgradeToTranscoded(video, selection.url.split("/").pop());
      }
    } else if (selection.videoPlaying === false || selection.videoError) {
      // 没有 <video>（图片 / 网页 / 静态帧壁纸）: 上一个视频留下的失败态必须
      // 清掉，否则卡片会继续显示属于上一张壁纸的错误。这里不 emit —— 本次
      // syncLayers 正是由 emit 驱动的，当前渲染会读到清空后的值。
      selection.videoPlaying = true;
      selection.videoError = "";
    }
  } else if (existing) {
    weStopDraw();
    stopLiveWatch();
    // 选择被清除：这一跳的旧层与"守着旧层的待显影层"都要一起退场 —— 壁上无壁纸时
    // 屏上不该留着任何一层的像素。
    forgetPendingReveal();
    retireFadingLayer();
    releaseLayerMedia(existing);
    existing.remove();
  }
  if (!selection.url) {
    disposePreparedMedia(); // 层未建（选择已清除）：滞留就绪元素立即释放
    if (pendingStagedLayerNode) {
      const div = pendingStagedLayerNode;
      pendingStagedLayerNode = null;
      try {
        const f = div.querySelector && div.querySelector("iframe");
        if (f) disposeMediaEl(f);
      } catch { /* ignore */ }
      try { div.remove(); } catch { /* ignore */ }
    }
  }

  // 2. Scrim element (always present while a wallpaper is active).
  const scrim = document.getElementById(SCRIM_ID);
  if (selection.url) {
    if (!scrim) {
      const s = document.createElement("div");
      s.id = SCRIM_ID;
      s.className = "we-scrim";
      document.body.appendChild(s);
    }
    document.body.setAttribute(ACTIVE_ATTR, "on");
  } else {
    if (scrim) scrim.remove();
    document.body.removeAttribute(ACTIVE_ATTR);
  }

  // 3. GPU 抓帧缓存状态（面板提示 + 清除入口）：场景壁纸才可能被抓帧。
  // 带 TTL 去重，syncLayers 调用频繁也不会打爆 HEAD。
  if (selection.type === "scene" && selection.sceneFrameUrl) {
    try { probeGpuFrameState(selection.sceneFrameUrl, false); } catch { /* ignore */ }
  }

  // 4. 元素级领养槽位收尾不变量：槽位寿命 = 一次建层。
  // buildMedia 只在 video / sceneVideo / 静态帧 img 三条分支里收编它，而：
  // ① live 分支自建 iframe（`return frame` / `return [poster, frame]`）——
  //    准备期 live 首帧探测超时会回退出视频/静态帧探针并写进槽位（见
  //    prepareSceneLiveStage 注释：探测放弃刻意不簿记 sceneLiveFailures，因此
  //    随后 buildMedia 的 isLive 仍为 true），两者不一致时槽里那个元素既不上
  //    屏、也没有任何路径能释放它：detached 的 <video> 是解码器根，失去句柄后
  //    仍满速解码到页面关闭（实测 4K ≈35% 单核/个，gc() 收不走），且它属于
  //    **上一张壁纸** —— 之后的非提交重建（liveFail / fps 档位切换等）会按 tag
  //    命中并把它领养进当前层 → 画面串味；
  // ② 节点级领养（pendingStagedLayerNode）整条绕过 buildMedia，同样不收编。
  // 放在函数收尾（本函数无提前 return）：无论走哪条建层/领养路径、无论
  // buildMedia 是否被调用，退出时槽位必空。空槽位调用是 no-op。
  disposePreparedMedia();
}

// ── 轮换渐变：旧层退役 ───────────────────────────────────────────────────────
// retireFadingLayer: 快速连切时上一份 fading 层即时退役（任何时刻最多 2 层）。
// scheduleFadingLayerRemoval: 渐变宽限期后移除旧层并释放其媒体。
function retireFadingLayer() {
  const node = fadingLayerNode;
  if (!node) return;
  fadingLayerNode = null;
  releaseLayerMedia(node);
  try { node.remove(); } catch { /* ignore */ }
  // 旧层已退场 → 放行这次渐变的新层音频（不匹配则说明闸属于另一次渐变）。
  releaseRotationAudioGateFor(node);
}
function scheduleFadingLayerRemoval(node, ms) {
  const hold = (typeof ms === "number" && ms > 0 ? ms : ROTATION_FADE_MS) + 100;
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") {
    retireFadingLayer();
    return;
  }
  window.setTimeout(() => {
    if (fadingLayerNode !== node) return; // 已被快速连切即时退役
    fadingLayerNode = null;
    releaseLayerMedia(node);
    try { node.remove(); } catch { /* ignore */ }
    // 渐变结束、旧层退场 → 新层 BGM 此刻才起播。
    releaseRotationAudioGateFor(node);
    // Edge canvas：只有绘制上下文仍属于旧层时才停（新层已 weStartDraw 接管）。
    if (weDrawCtx && weDrawCtx.canvas && typeof node.contains === "function"
      && node.contains(weDrawCtx.canvas)) weStopDraw();
  }, hold);
}

// ── 切换过场：把「新层入场 + 旧层退场」交给选定的过场动画 ────────────────────
// 只走内联样式 + 一个通用 transition 规则（.we-layer--switch），不写死每种过场的
// ·-on 类，好处是新增过场只需在 switchFrames 里加一条。
// cut 不会走到这里：调用方已把 startFade 置假、走「立即拆旧层」的硬切路径。
function applyInlineStyle(node, style) {
  if (!node || !node.style) return;
  for (const k in style) {
    try { node.style[k] = style[k]; } catch { /* ignore */ }
  }
}
// 过场收尾：新层必须回到「干净」状态 —— 留着内联 transform / clip-path /
// will-change 会让满屏视频永久占一个合成层（applyEffects 特意避免这种开销）。
function resetLayerSwitchStyles(node) {
  if (!node) return;
  try { node.className = "we-layer"; } catch { /* ignore */ }
  try {
    node.style.transform = "";
    node.style.opacity = "";
    node.style.clipPath = "";
    node.style.removeProperty("--we-switch-ms");
  } catch { /* ignore */ }
}
function startLayerTransition(node, outgoing, tr) {
  // 音频闸先开：新层静音，等旧层这次过场结束后才出声（见 openRotationAudioGate）。
  openRotationAudioGate(node, outgoing);
  // 两者默认都是 z-index:-2，谁在上面靠 DOM 顺序（live 的 staging 容器是**提前**
  // 挂到 body 的，顺序不保证）—— 过场期间显式把旧层压到新层之下。两者都仍在
  // scrim(-1) 之下，所以不会盖到界面上。
  try { outgoing.style.zIndex = "-3"; } catch { /* ignore */ }
  const frames = switchFrames(tr.id, tr.dir);
  applyInlineStyle(node, frames.inFrom);
  try { node.style.setProperty("--we-switch-ms", tr.ms + "ms"); } catch { /* ignore */ }
  node.className = "we-layer we-layer--switch";   // 顺带脱掉 we-layer--staging
  // 只有需要旧层同时动起来的过场（推移 / 缩放）才给它挂 switch 类；其余过场旧层
  // 保持不透明静止垫着（玻璃 backdrop-filter 依赖这层不透明背景）。
  if (tr.id !== "fade") outgoing.className = "we-layer we-layer--switch we-layer--switch-out";
  void node.offsetWidth;                          // 强制 reflow：让初态成为 transition 起点
  applyInlineStyle(node, frames.inTo);
  applyInlineStyle(outgoing, frames.outTo);
  scheduleFadingLayerRemoval(outgoing, tr.ms);
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    window.setTimeout(() => resetLayerSwitchStyles(node), tr.ms + 60);
  }
}

/**
 * 开关"逐秒心跳"诊断日志（面板「live 诊断日志」开关）。
 * 留痕也归本函数：**开关本身必须留痕**（强制档不受该开关影响），否则事后无法判断
 * 当时是否在记。返回翻转后的值。
 */
function toggleLiveDiag() {
  liveDiagOn = !liveDiagVerbose();
  liveLog("diag-" + (liveDiagOn ? "on" : "off"),
    liveDiagOn ? "逐秒心跳日志已开启（本会话有效，刷新后失效）" : "逐秒心跳日志已关闭");
  return liveDiagOn;
}
export {
  syncLayers, startLiveWatch, stopLiveWatch, liveFail, liveRenderEnabled, liveRenderUrl,
  liveFailReasonOf, liveLog, liveStateBrief, liveDiagVerbose, liveStats, applyLiveControls,
  scheduleLiveFrameBackfill, cancelLiveFrameBackfill, liveFrameEl, buildLivePoster,
  scheduleLiveMount, cancelLiveMount, createLiveFrame, retireFadingLayer, toggleLiveDiag,
  liveWatch, livePointerFrame, liveApplied, liveDiagOn, LIVE_FIRST_FRAME_MS, bootRestore,
};
