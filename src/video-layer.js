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
 */

/** 海报预算：拿不到海报图时的兜底（到期放行 ⇒ 旧壁纸让位，最坏是黑一下再进正片）。 */
const VIDEO_POSTER_BUDGET_MS = 4000;

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
