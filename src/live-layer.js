/**
 * live-layer.js — **实时渲染管线**：live 渲染与控制、看护心跳、判失败、抓帧回填、指针转发、
 * poster/挂载/抓首帧，以及壁纸层的构建（syncLayers）与过场过渡。
 *
 * 为什么单独一个文件：这是"壁纸层从建到退"的整条链路（**约 1,130 行**），此前散在
 * src/client.js 的多个不相邻区段里 —— 中间还夹着**别的域**（媒体集成、GPU 帧槽助手、
 * 用户属性、diag 上报），改一处 live 行为要先在 7,300 行里找齐四五段。抽出来之后，
 * "画面为什么没出来"这类问题只需读一个文件；client.js 那边留了一段指路注释。
 *
 * 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，"外部作用域"= 同一 prelude / src/client.js 的顶层。依赖是**机械清点**出来的：
 * 53 个，按下表分组）：
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
 *   播放与音频        applyVideoPlayback · isEffectivelyPlaying · weAudioVolume · startMediaSync ·
 *                     stopMediaSync · mediaTimer · weStartDraw · weStopDraw · weDrawCtx ·
 *                     applyEffects/clearEffects（prelude）· reportClientDiag · emit ·
 *                     persistSelection · applySelection · applyStoredUserProps ·
 *                     apiFetch/apiHead（prelude）
 * 提供的入口（25 个；被 client.js 或守卫引用，其余是同族助手）：
 *   syncLayers · startLiveWatch · stopLiveWatch · liveFail · liveRenderEnabled · liveRenderUrl ·
 *   liveFailReasonOf · liveLog · liveStateBrief · liveDiagVerbose · liveStats · applyLiveControls ·
 *   scheduleLiveFrameBackfill · cancelLiveFrameBackfill · liveFrameEl · buildLivePoster ·
 *   scheduleLiveMount · createLiveFrame · retireFadingLayer · toggleLiveDiag
 *   ＋ 供外部**读**的状态：liveWatch · livePointerFrame · liveApplied · liveDiagOn ·
 *     LIVE_FIRST_FRAME_MS · bootRestore
 *
 * 不变量：
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
const LIVE_DIAG_BUILD = "d6";   // d4→d6：GPU 静帧几何校验（存帧视比不符 → 清除按当前视口重抓）
const LIVE_PAGE_ID = (function () { try { return Math.random().toString(36).slice(2, 7); } catch { return "?"; } })();
// 面板开关（本会话有效、不落盘）：给「打不开 DevTools」的环境留的入口 ——
// DSH web 的根路径鉴权是 303 跳到干净的 `/`，URL 上的查询参数到不了客户端，
// 所以不能靠 ?weLiveDebug=1 传参。
let liveDiagOn = false;
function liveDiagVerbose() {
  if (liveDiagOn) return true;
  try { return typeof localStorage !== "undefined" && localStorage.getItem(LIVE_DIAG_KEY) === "1"; } catch { return false; }
}
function liveLog(tag, detail, verboseOnly) {
  if (verboseOnly && !liveDiagVerbose()) return;
  // detail 支持传函数：热路径（每秒 tick）在开关关闭时不构造那串注定被丢弃的字符。
  const text = typeof detail === "function" ? detail() : detail;
  const line = "[we-live " + LIVE_DIAG_BUILD + "\u00b7p" + LIVE_PAGE_ID + "] " + tag + (text ? " · " + text : "");
  try { if (typeof console !== "undefined" && console.info) console.info(line); } catch { /* ignore */ }
  // 同源像素请求 → host /diag 环形缓冲（与渲染页 reportDiag 同一条通路；
  // 无 host（单测 sandbox）时 Image 不存在，静默跳过）。
  try {
    if (typeof Image === "function") {
      const img = new Image();
      img.src = "/diag?msg=" + encodeURIComponent(line);
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
    if (!frame.isConnected) { liveLog("watch-stop", "iframe 已从文档移除", true); stopLiveWatch(); return; }
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
      + " first=" + watch.firstFrame + " stall=" + watch.stall + " held=" + watch.heldPaused), true);
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
      liveLog("stall-rescue", "wid=" + watch.wid + " 连续 " + watch.stall + "s 无帧 → 试 resume()");
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
    + " 帧率档=" + selection.sceneLiveFps);
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
// - 空槽（404）或 CPU 提取/预览帧（204+0）→ 抓帧 PUT 回填：GPU 帧升级覆盖
//   CPU 提取的残破帧（host 每壁纸只接受一次，见 /scene-frame-cache）。
// 失败路径会清 token，于是下一次 live 首帧（通常来自重新挂载）可以重试；
// 成功/已被别人写入则保留 token，避免同一壁纸反复抓帧。
const LIVE_FRAME_BACKFILL_DELAY_MS = 2500;
const LIVE_FRAME_BACKFILL_MIN_BYTES = 4096;
// 空帧门禁（内容判定）：体积不可靠 —— headless Chrome 实测全黑 PNG：
// 960×540=12KB / 1080p=44KB / 4K=165KB，全都远超任何固定的字节阈值。改为把
// canvas 降采样到 64×64 看亮度分布：近全黑或几乎无对比度 → 判为「还没渲染
// 出画面」，放弃回填（宁可继续用 CPU 帧，也不要写一张坏帧被 409 永久固化）。
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
        if (arStored <= 0) liveLog("gpu-frame-keep-unknown", "wid=" + backfillWid + " 存帧视比未知 → 保留", true);
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
      // 内容门禁：黑帧/纯色帧判为未渲染 → 放弃（保留 CPU 帧）。
      if (!liveFrameLooksUsable(canvas, blob)) {
        if (force) forceFail("抓到的画面还没有内容（全黑/纯色）→ 已保留原来那张");
        return false;
      }
      // 清旧帧放在抓帧+门禁**之后**：先清后抓一旦抓帧失败（画面没出来/网络断）就
      // 只剩空槽 → 退回 CPU 帧，比留一张旧构图的帧更糟（旧的至少是同一张壁纸）。
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
      if (!ok && force) forceFail("写入失败（宿主返回 " + (put && put.status) + "）");
      if (ok && arRef > 0) gpuFrameAspectKnown.set(token, arRef);
      return ok;
    })().then((settled) => {
      // 抓帧 + 上传是异步的（多 MB PNG 要 0.1–1s），期间用户可能已经切走：
      // 状态更新只对发起时那张壁纸有效 —— 否则会给**当前**壁纸打上「已有 GPU 帧」
      // 的假标记（面板提示错、CPU 渲染门禁在 30s 内误判为 pinned）。host 侧写入
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
function buildLivePoster(sel) {
  const poster = document.createElement("div");
  poster.className = "we-media we-live-poster";
  // 底色兜底：壁纸没写 schemecolor 时用主题面板色打底 —— 无抽帧图、无主题色时
  // 加载期也必须是「一层安静的颜色」，不能是纯黑或透明。
  poster.style.backgroundColor = sel.schemeColor || "var(--dsw-alias-bg-layer-1, #101418)";
  // 网页壁纸优先用 live 抽帧（真实渲染画面，见 maybeCaptureLiveFrame），还没抽到
  // 时退回项目预览图；场景壁纸用静态帧 URL（含 ?v= 档位）。都没有 → 只留主题色。
  const src = sel.type === "web" ? (sel.liveFrame || sel.previewUrl || null) : sel.url;
  if (src) {
    poster.dataset.weFrameSrc = src;
    // 与 prepareSceneStaticStage 同一约定：无 Image 的环境（headless 验收 /
    // 只给部分 DOM 的测试宿主）跳过预载，保留主题色兜底 —— 否则建 live 层时
    // 会直接抛 ReferenceError。
    if (typeof Image !== "function") return poster;
    const probe = new Image();
    probe.onload = () => {
      if (poster.isConnected) poster.style.backgroundImage = "url(" + src + ")";
    };
    probe.src = src; // 失败静默：保留主题色
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
let liveMountTimer = 0;
// 延迟挂载：计时到点 + 首屏空闲后再把渲染 iframe 插进图层（期间显示占位图）。
// 到点时校验壁纸没被换掉、live 仍启用、层还在 —— 任一不满足就放弃（syncLayers
// 会负责当前状态的正确渲染）。
function scheduleLiveMount(sel, frame, delayMs) {
  if (liveMountTimer) { try { clearTimeout(liveMountTimer); } catch { /* ignore */ } liveMountTimer = 0; }
  liveMountTimer = setTimeout(() => {
    liveMountTimer = 0;
    const mount = () => {
      if (selection.id !== sel.id || !liveRenderEnabled(selection)) return;
      const layer = document.getElementById(LAYER_ID);
      if (!layer || frame.isConnected) return;
      layer.appendChild(frame);
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(mount, { timeout: 2000 });
    } else {
      setTimeout(mount, 300);
    }
  }, delayMs);
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
    fetch(dataUrl).then((r) => r.blob()).then((blob) => fetch(sel.liveFrame, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    })).then(() => {
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

function syncLayers() {
  // 轮换渐变标记在入口消费：commitRotationSwitch 置位后首个 syncLayers 即
  // applySelection 的 emit；无旧层可淡（首壁纸/已清除）时自然作废，绝不
  // 滞留到下一次无关重建。
  const rotationFade = pendingRotationFade;
  pendingRotationFade = false;
  // 1. Wallpaper element.
  const existing = document.getElementById(LAYER_ID);
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
    const gotKey = existing && existing.dataset.weKey;
    let startFade = false;
    if (existing && gotKey !== wantKey) {
      liveLog("layer-rebuild", layerKeyDiff(gotKey, wantKey) + " " + liveStateBrief());
      // 交叉淡化判定：**换壁纸**（手动点选/轮换提交，层上 weWid ≠ 当前选择 id）
      // 一律淡出 —— 旧层保留被新层盖过去（真交叉淡化）；**同一张壁纸的内部重建**
      // （live 降级/fps 档/画面刷新/live 开关，weWid 相同）保持硬切：重建前后是
      // 同一条 BGM，淡出 + 音频闸会让它断 ~2s，反而更糟。rotationFade（轮换
      // commit 的显式标记）作为兜底保留 —— 覆盖 weWid 缺失或轮换同 wid 极端角落。
      const widChanged = String(existing.dataset.weWid || "") !== String(selection.id || "");
      // 过场类型为「硬切」时根本不进过渡路径：直接拆旧层（下车的 else 分支），
      // 音频闸也不开 —— 这正是硬切该有的零延迟表现。（switchTr 在本函数上部算好。）
      startFade = (rotationFade || widChanged) && switchTr.id !== "cut";
      if (startFade) {
        // 交叉淡化：旧层不立即拆除 —— 标记淡出保留（旧视频/旧 live 渲染页
        // 继续播放，真交叉淡化），新层淡入结束后由定时器移除。任何时刻
        // 最多 2 层：上一份 fading 层先即时退役。音频闸（下方
        // openRotationAudioGate）对新层静音到旧层退场 —— 换壁纸的两条 BGM
        // 不在渐变期重叠（轮换与手动切换同一套闸）。
        retireFadingLayer();
        existing.dataset.weFading = "1";
        try { existing.id = ""; } catch { /* ignore */ }
        fadingLayerNode = existing;
        // 旧 live 心跳退役（iframe 本身保活续播）；新层的 watch 由 buildMedia
        // （fresh load 或领养路径）重启。
        stopLiveWatch();
      } else {
        stopLiveWatch();
        releaseLayerMedia(existing);
        existing.remove();
        // Release the previous draw loop: without this, switching from an Edge
        // canvas video to a non-canvas wallpaper (image/web/scene, or Edge 兼容
        // turned off) would keep the old hidden <video> referenced and playing
        // forever — CPU/GPU/battery + memory leak per switch (rotation mixes
        // types). weStartDraw() re-initialises when a canvas exists again.
        weStopDraw();
      }
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
      if (startFade && fadingLayerNode) {
        startLayerTransition(node, fadingLayerNode, switchTr);
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
      if (startFade && fadingLayerNode === existing) {
        // 过场：新层在旧层之上入场（旧层保持不透明垫着，玻璃 backdrop-filter
        // 依赖不透明背景）；旧层退场 / 音频放行 / 收尾清理都在
        // startLayerTransition 里统一处理。
        startLayerTransition(node, existing, switchTr);
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
  scheduleLiveMount, createLiveFrame, retireFadingLayer, toggleLiveDiag,
  liveWatch, livePointerFrame, liveApplied, liveDiagOn, LIVE_FIRST_FRAME_MS, bootRestore,
};
