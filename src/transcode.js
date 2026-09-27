/**
 * transcode.js — **源元数据探测 + 抽帧转码升级**的完整生命周期（P2-9 之后的降复杂度拆分）。
 *
 * 为什么单独一个文件：这是一条**有状态的生命周期**（探测 → 决策 → 进度轮询 → 落地/回退），
 * 285 行里同时有"迟到响应必须作废""换上限要打断旧请求""15s 元数据兜底""播完才换源"四件
 * 容易互相踩的事，此前埋在 src/client.js 中段，改动要在 7,600 行里定位。
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
 *     这条不是口号：scripts/verify-transcode-state.mjs 扫两个源文件核对它。
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
  apiFetch(transcodedUrl, { signal: ctrl.signal, headers: { Range: "bytes=0-0" } })
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
