/*
 * video-layer.js — **视频壁纸通道**：视频档的"有画面了吗" + 它的切换放行策略。
 *
 * 为什么单开一条通道：视频档此前走的是为**实时渲染**设计的那条路（`live-layer.js` 里
  * 的切层内容闸门、垫底图、心跳、载荷、GPU 抓帧…），而这条路上**只有一部分对视频有意义**。
 * 实测后果：闸门的视频判据是"手上已有一帧"（`readyState ≥ 2`），而视频档**故意不设 poster**
 *（WE 的动图预览当 poster 会先播预览）⇒ 整次切换（含过场）被推迟到首个可解码帧：
 * 源越大越久、帧率上限越高越久，从秒级退化到十几秒。
 *
 * 判据（本文件的两条不变量）：
 *   ① **放行 ⇔ 屏上真的有画面**：海报图**已加载**（不是"属性存在"）｜首帧 `readyState ≥ 2`｜
 *      预算到期（兜底，避免拿不到海报就永远换不下去）。
 *   ② **没画面时旧壁纸留在屏上**：绝不露出这一层的底色。
 *      ⚠️ 这条是踩出来的：曾经改成"poster 属性存在即放行"，结果海报是按需抽帧生成的
 *      （与 4K 抽帧转码抢 CPU，十几秒才到）⇒ 那十几秒屏上是一块**纯色**（层底色），
 *      观感比"旧壁纸多留十几秒"更糟。
 *
 * 职责清单（③ 之后的状态）：
 *   ✓ 就绪判据   videoContentReady / probeVideoPoster / VIDEO_POSTER_BUDGET_MS
 *   ✓ 媒体构建   buildVideoMedia（<video> / Edge 镜像画布 / poster / 音轨与 playbackRate / object-fit）
 *   ○ 抽帧换源   （④：从 src/transcode.js 并入）
 *   ○ 切换放行   （⑤/⑥：syncLayers 的视频分支与闸门调用摘除）
 */

/**
 * 海报预算：拿不到海报图时的兜底（到期放行 ⇒ 旧壁纸让位，最坏是黑一下再进正片）。
 *
 * ⚠️ 这个数是**用户感知的延迟上限**，实测调过两次：
 *   · 4000 ms — 诊断里出现 3907/3891/3887 ms 的整簇（全是预算触发的签名）：
 *     按需抽的海报图在 4K 源跑抽帧转码时会被抢 CPU，常常 4 秒内到不了 ⇒ 每次切换
 *     都等到预算；
 *   · 1200 ms — 海报要么很快到（已热时实测 213/215/218/231 ms），要么就让位给视频首帧。
 * 真正的根治不在这个常数上（见文件头"抽帧换源"段的待办：海报预抽/优先级）。
 */
const VIDEO_POSTER_BUDGET_MS = 1200;

/**
 * 探一次海报图（`<video poster>` 的 URL）。
 *
 * 为什么要探：`poster` **属性存在**不等于**图已加载** —— 属性刚设上时 `<video>` 还是透明的，
 * 那一瞬屏上就是层底色。只有 `onload` 才算"有画面"。
 * 返回一个取消函数；`Image` 不可用（精简 DOM / 挂载台）时**立即**回调 `onReady`（不拦）。
 */
function probeVideoPoster(video, onReady, onFail) {
  const url = video && video.getAttribute ? String(video.getAttribute("poster") || "") : "";
  if (video) { try { video.__wePosterReady = false; } catch { /* ignore */ } }
  // 判不了就不拦：没有海报 URL、或环境没有 `Image`（精简 DOM / 挂载台）⇒ 直接当"已就绪"。
  if (!url || typeof Image !== "function") {
    if (video) { try { video.__wePosterReady = true; } catch { /* ignore */ } }
    onReady();
    return () => {};
  }
  let done = false;
  const img = new Image();
  img.onload = () => {
    if (done) return;
    done = true;
    try { video.__wePosterReady = true; } catch { /* ignore */ }
    onReady();
  };
  img.onerror = () => { if (!done) { done = true; onFail(); } };
  try { img.src = url; } catch { if (!done) { done = true; onFail(); } }
  return () => { done = true; };
}

/**
 * 视频层现在"有画面"吗（**通道自己的判据**，与实时那条路的闸门无关）。
 *
 * 顺序即优先级：作者静帧/海报（已加载）> 首帧 > 都没有。Edge 的镜像画布那条腿由调用方
 * 先判（画布底写死 #000，要等真画上一笔）。
 */
function videoContentReady(video) {
  if (!video) return true;
  const hasPoster = !!(video.getAttribute && video.getAttribute("poster"));
  if (hasPoster && video.__wePosterReady === true) return true; // 海报真到了 ⇒ 屏上有图
  if (Number(video.readyState) >= 2) return true;              // HAVE_CURRENT_DATA = 手上有帧
  return false;                                                // 都没有 ⇒ 先别换（旧层留屏）
}

/**
 * 视频档的媒体构建（③：从 src/media-prep.js 迁进视频通道）。
 *
 * 与原分支**逐行等价**，两处必要的语义改写（所以它不是"纯移动"）：
 *   ① 原来写外层函数的 `media` 变量 ⇒ 这里改成局部 `const media` 并**返回**它；
 *   ② Edge 那条腿（镜像画布）原来 `return [media, canvas]` 是**从媒体构建函数**返回的，
 *      这里同样返回该数组，由调用点用 `Array.isArray` 识别。
 * `fitClass` 是调用点所在函数的局部量 ⇒ 作为参数传入（用法原样）。
 */
function buildVideoMedia(sel, fitClass) {
  // 轮换领养：就绪元素（已 canplay/预播中）直接进层，绝不重赋 src（重赋
  // 即使同值也会触发 resource selection 重新加载 = 黑屏闪烁源）。
  const prepared = consumePreparedMedia("VIDEO", sel.url);
  const media = prepared || document.createElement("video");
  if (!prepared) {
    media.src = sel.url;
    // poster=预览图：覆盖初始加载与抽帧转码 swap 的空窗（原黑屏闪烁点）。
    // 视频类壁纸不设 —— WE 视频壁纸的预览常是动图（preview.gif），当 poster
    // 会先播一段预览、再停在视频首帧、最后才进正片，用户看到的是「跑完整
    // 加载流程」；0.7.5 是选中即播（加载期黑帧，由交叉渐变盖住）。场景内嵌
    // MP4 的 poster 是静态帧，是「先静帧后动态」的既有设计，保留。
    // 视频档**只认插件自己的静态缩略图**（`/video-preview/…` 是 ffmpeg 抽的一帧 JPEG，
    // 见宿主 videoPreviewCachePath 的 `pv_*.jpg`）。挂上它有两重收益：
    //   ① 切层内容闸门把 `video[poster]` 直接算作"有画面" ⇒ **立即放行**，不再等首帧
    //     （等首帧实测会把整次切换推到十几秒：源越大 / 帧率上限越高越久）；
    //   ② 加载窗口里屏上是**真缩略图**，而不是无帧 <video> 那块空/黑 ⇒ 闸门要防的
    //     "露出底色"照旧不发生。
    // WE 自带的 `preview.gif` 仍然不设（作者原意：动图当 poster 会"先播预览再进正片"）；
    // 上面那条 URL 是插件自己抽的静态帧，与该顾虑无关 —— 判据见
    // rotation-prepared-leak-smoke.mjs 的 T2 / T2b（无静态缩略图仍必须等帧）。
    const stillPreview = !!sel.previewUrl
      && (sel.type !== "video" || /\/video-preview\//.test(sel.previewUrl));
    if (stillPreview) media.poster = sel.previewUrl;
  }
  media.autoplay = true;
  media.loop = true;
  // 音轨按用户设置应用（见 weApplyAudio）：默认 0 音量 → 行为与原来的
  // muted 一致；调高音量后才有声音。
  media.setAttribute("playsinline", "");
  // Native playbackRate — hardware-decoded, instant, no reload.
  try { media.playbackRate = sel.playbackRate; } catch { /* ignore */ }
  if (IS_EDGE && sel.edgeCompat !== false) {
    // Edge: keep the decoder element out of sight (its floating 下载/投屏
    // toolbar attaches to any VISIBLE <video>), render via <canvas> instead
    // (see weStartDraw / weDrawFrame). Attributes are belt-and-suspenders.
    media.setAttribute("disablepictureinpicture", "");
    media.setAttribute("disableremoteplayback", "");
    media.style.cssText = "position:absolute;left:-100000px;top:0;width:320px;height:180px;opacity:0.01;pointer-events:none;";
    const canvas = document.createElement("canvas");
    canvas.className = "we-media we-media--canvas" + fitClass;
    canvas.style.background = "#000";
    return [media, canvas];
  }
  // ⚠️ 这一行是**尺寸与 object-fit 的来源**（`.we-media` / `.we-media--fit`）。
  // ⑧ 提取 `buildVideoMedia` 时我的切分器末端排他，把原分支**最后一行**切掉了 ⇒
  // 视频元素拿不到类名 ⇒ 只显示左上角、占不满屏（实测回归）。判据见 verify-scene-live
  // 的「两条腿都必须挂类名」。
  media.className = "we-media" + fitClass;
  return media;
}


// ══════════════════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════════════════
// 抽帧换源链路（④：原 src/transcode.js，整份并入视频通道）
//
// 它本来就是**零实时引用**的（媒体信息探测 + 抽帧升级 + 15s 元数据兜底 + 取消），
// 所以是整文件并入而不是挑着搬。内联顺序变了（原来排在 live-layer 之后，现在排到
// media-prep 之前）—— 并入前已量过：它的 16 个模块级绑定**没有任何顶层求值期读取**，
// 因此顺序变化不会撞 TDZ。
// ══════════════════════════════════════════════════════════════════════════════
/**
 * transcode.js — **源元数据探测 + 抽帧转码升级**的完整生命周期（P2-9 之后的降复杂度拆分）。
 *
 * 为什么单独一个文件：这是一条**有状态的生命周期**（探测 → 决策 → 进度轮询 → 落地/回退），
 * 其中同时有"迟到响应必须作废""换上限要打断旧请求""15s 元数据兜底""播完才换源"四件
 * 容易互相踩的事，集中在一处才看得清它们彼此的约束。
 *
 * 契约（本文件是客户端程序的一部分，构建期由 scripts/build-client.mjs 内联进 bundle 的
 * 工厂作用域，"外部作用域"= 同一 prelude / src/client.js 的顶层。依赖是**机械清点**出来的）：
 *   selection                 ← 设置/选中项的唯一 store（读：type/url/fpsCap/…）
 *   LAYER_ID                  ← 壁纸层元素 id
 *   emit()                    ← 单向重渲染（本文件不直接碰 DOM 结构）
 *   isEffectivelyPlaying()    ← "当前是否在播"（换源前判断，避免打断播放）
 *   weDrawFrame()             ← 抓/重绘一帧（换源后立刻上屏）
 *   apiJson(path) / apiFetch(path)  ← src/api-client.js（宿主 API 唯一出入口；探测带 signal 透传）
 * 提供的入口：
 *   refreshMediaInfo(force)              读 /media-info，写 selection.mediaInfo（含"源 fps ≤ 上限 ⇒ 无需转码"）
 *   maybeUpgradeToTranscoded(video, token) 决策并启动/落地抽帧转码（syncLayers 调用）
 *   transcodeUpgradeFailed(video, token)   转码失败回退（含 UI 文案）
 *   abortTranscodeUpgrade()              打断升级：清轮询 + 清兜底 timer + abort 请求
 *   invalidateMediaInfoProbe()           作废"进行中"的探测（迟到的响应不再写 selection）
 *   abortMediaInfoProbe()                断开探测的 AbortController（卸载用）
 *   revertTranscodedVideo(video)         把已换源的 <video> 退回原始源
 *   clearUpgradePoll() / clearUpgradeMeta()  仅供守卫单独取用（内部实现）
 *
 * 不变量：
 *   · 这三个字段的**状态机写入全部在本文件**：`selection.mediaInfo` / `transcodeState` /
 *     `transcodeProgress`。src/client.js 只允许在**换壁纸/切走**时把它们**复位**
 *     （`= null` / `= "idle"`，紧接着 abortTranscodeUpgrade() + refreshMediaInfo() 交接给本文件）
 *     —— 别处改写会绕过状态机，让"旧请求的结果覆盖新请求"重新变成可能。
 *     这条不是口号：test/verify-transcode-state.mjs 扫两个源文件核对它。
 *   · 自己的运行状态（两个探测/升级的 token、AbortController、两个 timer）**不外露**，只经入口操作。
 *   · 定时器与 AbortController 必须成对清理：卸载路径调用 abortTranscodeUpgrade() ——
 *     漏掉就是"卸载后 500ms 轮询永久泄漏"（真实缺陷）。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     —— 它会被内联到 bundle 顶部（早于 client.js 正文），顶层读 body 里的 const 会撞 TDZ。
 */

// ── Source metadata + frame-skip transcode (抽帧转码) ────────────────────────
// The decode-side fps cap (帧率上限) is implemented as a HOST re-encode, NOT as
// playbackRate: playbackRate is a speed multiplier, so capping decode through
// it would slow the motion. The host transcodes the wallpaper once to the cap
// fps (4K120 → 4K60, timeline 1.0x, AV1 via NVENC) and caches it; here we play
// the ORIGINAL immediately (instant first paint) and, while the host runs the
// one-time transcode, swap to the capped-fps file when it is ready — normal
// speed + halved decode. 倍速 (playbackRate) keeps working on top of either.
let mediaInfoToken = "";
// In-flight marker: while the /media-info probe for this token is pending,
// maybeUpgradeToTranscoded must NOT fire a transcode request — the probe may
// come back with fps ≤ cap (no transcode needed). Without this guard every
// wallpaper selection used to trigger a throwaway host-side ffmpeg run.
let mediaInfoInFlight = "";
// 在途探测的 AbortController: token 变更或强制刷新时终止上一次 fetch — 否则被
// 取代的探测会一直跑 (结果只靠 mediaInfoToken 检查丢弃), fiber 卸载时也要 abort。
let mediaInfoAbort = null;
async function refreshMediaInfo(force) {
  const token = selection.type === "video" && selection.url
    ? selection.url.split("/").pop()
    : null;
  if (!token || (!force && token === mediaInfoToken)) return;
  // 旧探测的结果一定没用了 (token 变了, 或被 force 重刷取代) → 立刻断开
  if (mediaInfoAbort) { try { mediaInfoAbort.abort(); } catch { /* ignore */ } mediaInfoAbort = null; }
  // AbortController 可能不存在 (无计时器/无 fetch 设施的验证环境): 为 null 时退化为旧行为
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  mediaInfoAbort = ctrl;
  mediaInfoToken = token;
  mediaInfoInFlight = token;
  try {
    // 探测带 abort：`apiJson` 透传 signal，被取代的探测不写状态（下方 mediaInfoToken 校验）。
    const res = await apiJson("/media-info/" + encodeURIComponent(token), { signal: ctrl ? ctrl.signal : undefined });
    const data = res.data || {};
    if (mediaInfoToken === token) {
      selection.mediaInfo = (data && data.info) || null;
      // Source fps ≤ cap → no transcode needed; cancel an in-flight upgrade.
      const mi = selection.mediaInfo;
      if (mi && mi.fps && mi.fps > 0 && selection.fpsCap > 0 && mi.fps <= selection.fpsCap) {
        abortTranscodeUpgrade();
        // Also drop a swapped transcode from a previous LOWER cap, so the
        // "无需抽帧" hint matches what is actually playing (the original).
        const layer = document.getElementById(LAYER_ID);
        const video = layer && layer.querySelector("video");
        if (video && video.dataset.weTranscoded) revertTranscodedVideo(video);
        selection.transcodeState = "skipped";
      }
    }
  } catch {
    // abort 掉的探测不写状态 (它已被更新的探测取代)
    if (!(ctrl && ctrl.signal.aborted) && mediaInfoToken === token) selection.mediaInfo = null;
  }
  const ownsAbort = mediaInfoAbort === ctrl; // 仍是本次探测 (没被更新的探测取代)
  if (ownsAbort) mediaInfoAbort = null;
  if (ownsAbort && mediaInfoInFlight === token) mediaInfoInFlight = "";
  // Settle → single re-emit so a deferred transcode decision (see
  // mediaInfoInFlight) runs against the final mediaInfo, success or failure.
  if (mediaInfoToken === token) emit();
}

let upgradeAbort = null;
let upgradeToken = "";
// The fps cap the in-flight upgrade request targets (0 = none). The in-flight
// latch is keyed by token ONLY in the old code, so switching 24→48 while the
// 24fps transcode was still running was treated as "already working on it" —
// the stale 24fps request then completed and swapped the video to a 24fps
// re-encode while the picker advertised the new cap ("已切换至 48fps 抽帧版").
// Tracking the cap lets a cap change abort the stale request and start fresh.
let upgradeFps = 0;
let upgradePollTimer = null; // progress poller while the transcode fetch pends
function clearUpgradePoll() {
  if (upgradePollTimer) { clearInterval(upgradePollTimer); upgradePollTimer = null; }
}
// 15s metadata 兜底 timer (见 maybeUpgradeToTranscoded): 必须挂到升级状态上,
// abortTranscodeUpgrade 才能清掉它 — 否则被取代的请求超时后回调仍会跑在已
// detach 的 <video> 上 (重新赋 src, 元素再也释放不掉)。
let upgradeMetaTimer = null;
function clearUpgradeMeta() {
  if (upgradeMetaTimer && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(upgradeMetaTimer);
  }
  upgradeMetaTimer = null;
}
function abortTranscodeUpgrade() {
  clearUpgradePoll();
  clearUpgradeMeta();
  if (upgradeAbort) { upgradeAbort.abort(); upgradeAbort = null; }
  upgradeToken = "";
  upgradeFps = 0;
  selection.transcodeProgress = null;
}
// Revert a video that was swapped to a capped-fps transcode back to the source.
// NOTE: no emit() here — this runs inside syncLayers (already inside an emit
// cycle); emitting synchronously from a subscriber re-enters the listener chain
// and recurses until the stack overflows. UI updates ride the outer emit.
function revertTranscodedVideo(video) {
  if (!video || !video.dataset.weTranscoded) return;
  delete video.dataset.weTranscoded;
  try { video.src = selection.url; video.load(); } catch { /* ignore */ }
}
/**
 * ② 源是否**浏览器原生可解**（直接播，不需要抽帧/换源）。
 *
 * 依据：容器（扩展名）+ 编码（mediaInfo 里有就用）。**保守**为原则 —— 编码未知时
 * 不否决（MP4/WebM + 未知编码 ⇒ 当可解），已知是 HEVC/其它时否决。
 * 为什么要它：帧率上限是"降低解码占用"的优化，代价却是**每次切换后台跑一次整片
 * 重编码**（实测 4K60 数秒、抢 CPU/磁盘 ⇒ 各壁纸之间等待几乎一样长）。原生可解的
 * 源不再因为上限触发它。
 */
const NATIVE_SRC_EXT = /\.(mp4|m4v|webm)([?#]|$)/i;
const NATIVE_CODEC_RE = /^(avc1|avc3|h264|vp8|vp09|vp9|av01|av1|theora|opus|vorbis|mp4a)/i;
function isNativelyPlayableSource(mi, url) {
  if (!NATIVE_SRC_EXT.test(String(url || ""))) return false;
  const codec = mi && (mi.codec || mi.videoCodec || mi.video_codec || "");
  if (!codec) return true;
  return NATIVE_CODEC_RE.test(String(codec));
}

/**
 * ⑤ 视频通道的"建层之后"入口：**转码触发归视频通道**（原来这 3 行在 live-layer 的
 * syncLayers 里，是视频档在那条实时管线里唯一的类型专属逻辑）。
 *
 * 语义与原处**逐字一致**：只负责"要不要起一次抽帧升级"，不做别的。
 */
/**
 * ⑥ 视频档的"押住 → 放行"执行器：**视频通道自己的机器**。
 *
 * 这段原来散在实时管线的 armLayerContentReveal 里，却靠本通道的两个符号工作
 * （probeVideoPoster / VIDEO_POSTER_BUDGET_MS）⇒ 现在把它整段收进来，实时管线只留
 * 一次委托。放行条件与原处逐字一致：海报图**加载出来** / 首帧（loadeddata·canplay）/
 * 出错放行 / 预算到期。返回两个句柄供调用点随待放行状态一起收。
 */
function armVideoChannelReveal(video, recheck, giveUp) {
  let posterGiveUp = 0;
  let cancelPosterProbe = null;
  if (video && typeof video.addEventListener === "function") {
    // Edge 那条路由镜像画布的第一笔补最后一步（layerContentReady 会一起看）。
    const frameReady = () => { try { video.__weReady = true; } catch { /* ignore */ } recheck(); };
    video.addEventListener("loadeddata", frameReady);
    video.addEventListener("canplay", frameReady);
    video.addEventListener("error", giveUp);
    cancelPosterProbe = probeVideoPoster(video, recheck, giveUp);
    if (typeof setTimeout === "function") posterGiveUp = setTimeout(giveUp, VIDEO_POSTER_BUDGET_MS);
  }
  return { cancelProbe: cancelPosterProbe, budget: posterGiveUp };
}

function videoChannelAfterLayerBuild(video, sel) {
  if (!video || !sel || sel.type !== "video" || !sel.url) return;
  maybeUpgradeToTranscoded(video, String(sel.url).split("/").pop());
}

function maybeUpgradeToTranscoded(video, token) {
  if (!video || !video.isConnected) return;
  const cap = selection.fpsCap;
  // Cap off / lowered to 0: revert any swapped video back to the original.
  if (!cap || cap <= 0) {
    abortTranscodeUpgrade();
    if (video.dataset.weTranscoded) {
      revertTranscodedVideo(video);
      selection.transcodeState = "idle";
    }
    return;
  }
  const mi = selection.mediaInfo;
  // ② 延迟治理：**原生可解**的源不再因为帧率上限而整片重编码（实测代价：4K60 数秒，
  // 各壁纸之间等待几乎一样长 = 固定代价）。判据见 verify-scene-live 的 ② 那组。
  if (isNativelyPlayableSource(mi, selection.url)) {
    if (video.dataset.weTranscoded) revertTranscodedVideo(video);
    selection.transcodeState = "skipped";
    return;
  }
  if (mi && mi.fps && mi.fps > 0 && mi.fps <= cap) {
    // Source already at/below the cap — no transcode needed; drop any previously
    // swapped (lower-cap) version. No in-flight reservation is made, so raising
    // the cap later can still start one.
    if (video.dataset.weTranscoded) revertTranscodedVideo(video);
    selection.transcodeState = "skipped";
    return;
  }
  // mediaInfo probe still in flight for THIS token: defer the decision — the
  // probe may come back with fps ≤ cap (transcode unnecessary). The settle
  // emit in refreshMediaInfo re-runs syncLayers and brings us back here.
  if (!mi && mediaInfoInFlight === token) return;
  if (video.dataset.weTranscoded === String(cap)) return; // already on this cap
  // Only an in-flight request for THIS cap counts as "working on it": a request
  // for a different cap would complete and swap in a stale-fps re-encode while
  // the picker advertises the current cap (24→48 direct switch bug). The guard
  // is deliberately NOT conditioned on weTranscoded: the progress poller emits
  // (→ syncLayers → this function), and with the video already on a transcode
  // that emit used to abort + re-start the request forever (page freeze).
  if (upgradeToken === token && upgradeAbort && upgradeFps === cap) return; // already working on this cap
  abortTranscodeUpgrade();
  upgradeToken = token;
  upgradeFps = cap;
  const ctrl = new AbortController();
  upgradeAbort = ctrl;
  selection.transcodeState = "working";
  selection.transcodeProgress = null;
  // Progress poller: 500ms interval reading /transcode-progress (download %,
  // then frame-based transcode % + ETA). Cleared on settle/abort. The timer is
  // ALSO kept in this closure so THIS request's completion only ever clears its
  // OWN timer — a stale request must not kill the newer request's poller.
  let pollPending = false; // 上一 tick 未返回 → 跳过本次 (宿主高负载时避免 fetch 堆积)
  const pollProgress = () => {
    if (ctrl.signal.aborted) return;
    if (pollPending) return;
    pollPending = true;
    apiJson("/transcode-progress/" + encodeURIComponent(token) + "?fps=" + cap)
      .then((res) => {
        const d = res.data || {};
        if (ctrl.signal.aborted) return;
        if (d && d.phase) {
          const changed = !selection.transcodeProgress
            || selection.transcodeProgress.phase !== d.phase
            || selection.transcodeProgress.percent !== d.percent
            || selection.transcodeProgress.eta !== d.eta;
          if (changed) {
            selection.transcodeProgress = {
              phase: d.phase, percent: d.percent || 0, source: d.source || "",
              finalizing: d.finalizing === true, eta: typeof d.eta === "number" ? d.eta : null,
            };
            emit();
          }
        }
      })
      .catch(() => { /* transient poll failure: ignore */ })
      .then(() => { pollPending = false; }); // 成功/失败都释放 in-flight 标记
  };
  clearUpgradePoll();
  const pollTimer = setInterval(pollProgress, 500);
  upgradePollTimer = pollTimer;
  pollProgress();
  const transcodedUrl = "/wallpaper-engine/transcoded/" + encodeURIComponent(token) + "?fps=" + cap;
  // Trigger + completion probe: a tiny Range request that blocks until the host
  // has the transcode cached, then answers 206 with one byte (discarded). The
  // <video> then streams the SAME url via range requests — no full-file blob is
  // ever held in memory and playback starts as soon as the first bytes arrive.
  // 探测响应是 1 字节二进制体 ⇒ `parse: false`（默认路径会先 json() 吃掉 body，
  // 显式的 arrayBuffer() 只能靠 catch 兜住；这里直接不走解析）。
  apiFetch(transcodedUrl, { signal: ctrl.signal, headers: { Range: "bytes=0-0" }, parse: false })
    .then(async (res) => {
      if (ctrl.signal.aborted) return; // superseded by a newer request
      if (pollTimer) clearInterval(pollTimer); // only ever this request's own timer
      if (!res.ok) { transcodeUpgradeFailed(video, token); return; }
      try { await res.response.arrayBuffer(); } catch { /* 1-byte body; discard */ }
      if (ctrl.signal.aborted) return;
      if (selection.fpsCap !== cap || !video.isConnected) {
        // The user changed the cap (or the wallpaper) while this request was in
        // flight: its output is stale. NEVER swap a stale-fps re-encode in —
        // drop the request state and re-decide for the CURRENT cap instead.
        abortTranscodeUpgrade();
        if (video.isConnected && selection.url && token === selection.url.split("/").pop()) {
          const cur = selection.fpsCap;
          if (cur > 0 && video.dataset.weTranscoded === String(cur)) {
            // Already playing exactly the requested cap (the user switched back
            // while this request was in flight): just settle as ready.
            selection.transcodeState = "ready";
            selection.transcodeProgress = null;
            emit();
          } else {
            maybeUpgradeToTranscoded(video, token);
          }
        } else {
          // The layer/video was rebuilt while this request was in flight (e.g.
          // Edge 兼容 render-mode toggle, or a wallpaper switch that raced the
          // abort): re-run syncLayers so the CURRENT video gets its own fresh
          // upgrade decision — otherwise it would sit on the original (full
          // decode) until some unrelated emit happened to re-trigger it.
          emit();
        }
        return;
      }
      if (selection.url && token === selection.url.split("/").pop()) {
        video.dataset.weTranscoded = String(cap);
        const t = video.currentTime;
        const wasPlaying = isEffectivelyPlaying();
        // 兜底超时：转码文件损坏 / 元数据异常时 loadedmetadata 可能永远不来，
        // UI 会永停「转码中」——15s 未就绪按失败回退原片。定时器走 window.*
        //（headless 验证环境无计时器设施时直接跳过超时兜底）。
        let metaTimer = null;
        const clearMetaTimer = () => {
          if (metaTimer && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
            window.clearTimeout(metaTimer);
          }
          // 同步清掉升级状态上的引用 (只清自己的, 否则会抹掉更新请求的 timer)
          if (upgradeMetaTimer === metaTimer) upgradeMetaTimer = null;
          metaTimer = null;
        };
        const onErr = () => {
          clearMetaTimer();
          if (video.dataset.weTranscoded) {
            delete video.dataset.weTranscoded;
            try { video.src = selection.url; video.load(); } catch { /* ignore */ }
            selection.transcodeState = "fallback";
            emit();
          }
        };
        video.addEventListener("error", onErr, { once: true });
        video.src = transcodedUrl;
        video.load();
        const onMeta = () => {
          clearMetaTimer();
          try { if (t > 0 && t < video.duration) video.currentTime = t; } catch { /* ignore */ }
          if (wasPlaying) { try { video.play().catch(() => {}); } catch { /* ignore */ } }
          // Edge canvas：转码 swap 复用同一 <video>，weLoadedOnce 已置位，
          // 暂停态下补一帧避免画布停在旧画面。
          weDrawFrame();
          selection.transcodeState = "ready";
          selection.transcodeProgress = null;
          emit(); // syncLayers re-arms the Edge canvas + re-applies rate/play
        };
        video.addEventListener("loadedmetadata", onMeta, { once: true });
        if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
          metaTimer = window.setTimeout(() => {
            video.removeEventListener("loadedmetadata", onMeta);
            onErr();
          }, 15000);
          upgradeMetaTimer = metaTimer; // 挂到升级状态: abortTranscodeUpgrade 也要能清
        }
      }
    })
    .catch(() => {
      if (ctrl.signal.aborted) return;
      if (pollTimer) clearInterval(pollTimer); // only ever this request's own timer
      transcodeUpgradeFailed(video, token);
    });
}

// A transcode request for the CURRENT cap failed (502 / network / encode
// error): the documented fallback is to play the ORIGINAL, so revert any
// swapped transcode (a request only ever runs when the video is on a DIFFERENT
// cap's transcode or the original, so this restores the honest "原片" state).
// The in-flight latch (upgradeToken/upgradeAbort/upgradeFps) is deliberately
// LEFT set: it is what stops the emit-driven syncLayers re-entry from
// auto-restarting a request that just failed, while a cap change / 无限制
// switch still clears it and allows a retry.
function transcodeUpgradeFailed(video, token) {
  if (video && video.isConnected && video.dataset.weTranscoded) {
    revertTranscodedVideo(video);
  }
  selection.transcodeState = "fallback";
  selection.transcodeProgress = null;
  emit();
}


/**
 * 作废"进行中"的 media-info 探测：把 latch 置空 ⇒ 迟到的响应不再写 selection.mediaInfo，
 * 且同一壁纸下次 refreshMediaInfo 会重新探测。
 * 换壁纸/切走时调用（调用点同时会把 selection.mediaInfo 自己置 null —— 那是**显示状态**，
 * 与本文件的 latch 是两件事）。
 */
function invalidateMediaInfoProbe() {
  mediaInfoToken = "";
}

/**
 * 断开 media-info 探测的 AbortController（卸载时调用：token 可能永远不再变化，
 * 不主动断开会把这次求值的闭包一直钉住）。
 */
function abortMediaInfoProbe() {
  if (mediaInfoAbort) { try { mediaInfoAbort.abort(); } catch { /* ignore */ } mediaInfoAbort = null; }
}
export {
  refreshMediaInfo, maybeUpgradeToTranscoded, transcodeUpgradeFailed, abortTranscodeUpgrade,
  invalidateMediaInfoProbe, abortMediaInfoProbe, revertTranscodedVideo,
  clearUpgradePoll, clearUpgradeMeta,
};
