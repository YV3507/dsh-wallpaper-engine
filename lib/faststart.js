/**
 * faststart.js — **faststart 变体子系统**：把 moov 在文件尾部的视频壁纸源一次性
 * `-c copy -movflags +faststart` 挪到文件头，并按「源路径 + 大小 + mtime」缓存复用。
 *
 * 为什么需要它：Chromium 的媒体加载器对 `Range: bytes=0-` 的响应会**顺流整读**，而这几张源的
 * moov 在文件尾部 ⇒ 元数据（duration/尺寸）要读到文件末尾才出来，耗时 ∝ 文件大小。真机
 * `media-req` 取证（官方壳）：
 *   iris2 764,688,296B / 1761ms · lv_0 501,752,315B / 1250ms · kei 155,604,213B / 357ms
 *   · ahq 101,749,329B / 324ms（≈430MB/s），而**同一个 iris2** 在"页面刚加载后的第一张"
 *   那条路上只要 149–233ms —— 两者差别正是 moov 在不在前面。
 * 修法：一次性 `-c copy -movflags +faststart` 把 moov 挪到文件头（**不重编码**，几秒），
 * 按"源路径+大小+mtime"缓存复用 ⇒ 播放器第一段就能拿到 moov，与文件大小无关。
 * 取不到/生成失败一律照旧服务原片：这条是优化，绝不允许它让壁纸播不出来。
 *
 * 契约：`createFaststartKit(c)` → `{ faststartCacheDir, faststartVariant,
 *   pinnedFaststartVariant, warmFaststartFavorites }`（只回**被外面用到**的那几个；变体路径 /
 *   `needsFaststart` / `kickFaststart` 是本文件内部件）。另有模块级导出
 *   `FASTSTART_CACHE_MAX_BYTES` —— 缓存上限，只被门面的启动清扫读（是常量，与 `apply()` 无关）。
 *   `c` 里是这一族**用到但不属于它**的东西（实现仍留在 `lib/index.js`，与本族之外的调用点共享）：
 *   · `extOf` / `getMediaInfo`   ← 扩展名判定与容器探测（`needsFaststart` 的依据）
 *   · `cacheBaseDir` / `ensureDirOnce` ← 变体缓存目录取 `cacheBaseDir()/faststart`
 *     （**不**按 `configPath()` 的父目录写死 —— 缓存根可由用户在设置页改，见 `cacheBaseDir()`）
 *   · `atomicTmpPath` / `resolveFfmpeg` / `spawnFfmpeg` ← 落盘与 ffmpeg 供给（同一套转码设施）
 *   · `appendDiagLine`           ← 生成成功落一行诊断（桌面壳默认安静档，否则真机无从核对）
 *   · `readConfig` / `mediaMap`  ← 预热器：轮换列表读设置，token → 磁盘绝对路径
 *
 * ⚠️ **状态刻意住在模块作用域**（不在工厂里）：`FASTSTART_INFLIGHT`（在途任务，预热器要串行
 *   等它）/ `FASTSTART_FAILED`（失败不重试）/ `FASTSTART_TOUCH`（顶 mtime 的节流表）/
 *   `MEDIA_CHOICE_PIN`（**字节布局钉子**，见下）的寿命本就该跨 `apply()` —— 放进工厂会让插件
 *   重载时把在途任务与"这一份播放用哪份字节"一次性丢掉。**唯一的 per-apply 状态**是预热器的
 *   `faststartWarmStarted`（"每次宿主加载只排一次"），故只有它在工厂闭包里。
 *
 * 不变量：
 *   · **同一次播放必须是同一份字节**：原片与 faststart 变体的媒体数据偏移不同，中途换文件会让
 *     解复用器按旧偏移读新布局 ⇒ 花屏 / 解码失败。所以"这一份播放用哪个文件"只由**第一次**
 *     请求决定（`pinnedFaststartVariant`），命中还会**续期**（循环壁纸一次播放远超 TTL）。
 *   · **绝不为了"下次快"去动正在播的那一份**：变体没缓存 ⇒ 本次照旧发原片，后台生成。
 *   · 生成失败一律记下不再重试（避免反复起 ffmpeg），且**绝不抛出**——见 `kickFaststart` 的 ⚠️。
 */

import { existsSync, renameSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

// ── 模块作用域状态（跨 apply() 存活，见文件头 ⚠️）─────────────────────────────
const FASTSTART_INFLIGHT = new Map();
const FASTSTART_FAILED = new Set();
const FASTSTART_TIMEOUT_MS = 5 * 60 * 1000;
/** 变体缓存上限（每个 100MB–1GB 量级）—— 只被门面的启动清扫按 mtime-LRU 收敛。 */
export const FASTSTART_CACHE_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** 预热时最多为多少字节的源排队生成变体（见 warmFaststartFavorites）。 */
const FASTSTART_WARM_MAX_BYTES = 6 * 1024 * 1024 * 1024;
/** 命中变体时"顶 mtime"（LRU 按使用而非创建时间淘汰）——**不必每个请求都写一次盘**，节流。 */
const FASTSTART_TOUCH = new Map();
const FASTSTART_TOUCH_MIN_MS = 5 * 60 * 1000;
/**
 * **每个 token 在一次宿主运行里钉住"用哪份字节"**。
 *
 * 为什么必须有：原片与变体的**字节偏移不同**（moov 从头挪到尾）。若同一次播放里第一次请求
 * 拿到原片、第二次请求（变体刚生成完）拿到变体，解复用器就按旧偏移去读新布局 ⇒ 花屏/解码失败。
 * 所以"这一份播放用哪个文件"只由**第一次**请求决定，之后一直用它；命中会**续期**（循环壁纸
 * 一次播放远超 TTL，固定窗口会在会话中途换字节布局），TTL 只兜底回收早已无人问津的钉子。
 */
const MEDIA_CHOICE_PIN = new Map();
const MEDIA_PIN_TTL_MS = 10 * 60 * 1000;

export function createFaststartKit(c) {
  const {
    extOf, getMediaInfo, cacheBaseDir, ensureDirOnce, atomicTmpPath,
    resolveFfmpeg, spawnFfmpeg, appendDiagLine, readConfig, mediaMap,
  } = c;

  function faststartCacheDir() {
    return ensureDirOnce(join(cacheBaseDir(), 'faststart'));
  }
  function faststartPath(abs) {
    const st = statSync(abs);
    const key = createHash('sha256')
      .update(abs + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|fs1')
      .digest('hex').slice(0, 20);
    return join(faststartCacheDir(), 'fs_' + key + '.mp4');
  }
  /** 需要 faststart 吗：mp4/m4v/mov 且 moov 不在头部附近（>1MB）。判不了就 false（保守）。 */
  function needsFaststart(abs) {
    const ext = extOf(abs);
    if (ext !== 'mp4' && ext !== 'm4v' && ext !== 'mov') return false;
    let info = null;
    try { info = getMediaInfo(abs); } catch { return false; }
    if (!info || !Number.isFinite(info.moovStart)) return false;
    return info.moovStart > 1024 * 1024;
  }
  /**
   * 这一份播放该用哪个文件：**第一次请求定音**，之后一直用它（见 MEDIA_CHOICE_PIN）。
   * 变体已缓存 ⇒ 用它；没有 ⇒ 本次用原片并后台生成（绝不为了"下次快"去动正在播的那一份）。
   */
  function pinnedFaststartVariant(abs, token, logFn) {
    if (!abs) return null;
    const key = String(token || abs);
    const pin = MEDIA_CHOICE_PIN.get(key);
    const now = Date.now();
    if (pin && now - pin.at < MEDIA_PIN_TTL_MS) {
      pin.at = now;                             // 命中即续期：播放会话内绝不换字节布局
      // 钉住的若是变体，说明它还在缓存里（被 LRU 删掉就退回原片，宁可这次慢也不要换布局）。
      if (!pin.variant) return null;
      if (existsSync(pin.variant)) { touchFaststart(pin.variant); return pin.variant; }
      pin.variant = null;                       // 变体没了 ⇒ 钉成原片
      return null;
    }
    const variant = faststartVariant(abs, logFn);   // 内部：命中就返回，否则后台起、返回 null
    MEDIA_CHOICE_PIN.set(key, { variant, at: now });
    // 上限保护：钉子只是短命状态，别让它随库增长。
    if (MEDIA_CHOICE_PIN.size > 200) {
      const oldest = [...MEDIA_CHOICE_PIN.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) MEDIA_CHOICE_PIN.delete(oldest[0]);
    }
    return variant;
  }
  /** 命中即"用过一次"：顶 mtime 让 LRU 按使用而不是创建时间淘汰；同一份 5 分钟内只写一次盘。 */
  function touchFaststart(file) {
    const now = Date.now();
    if (now - (FASTSTART_TOUCH.get(file) || 0) < FASTSTART_TOUCH_MIN_MS) return;
    FASTSTART_TOUCH.set(file, now);
    try { const d = new Date(now); utimesSync(file, d, d); } catch { /* ignore */ }
  }
  /** 已缓存的 faststart 变体（没有就后台生成并返回 null，本次照旧服务原片）。 */
  function faststartVariant(abs, logFn) {
    if (!abs) return null;
    let out = null;
    try {
      if (!needsFaststart(abs)) return null;
      out = faststartPath(abs);
      if (existsSync(out)) {
        touchFaststart(out);
        return out;
      }
    } catch { return null; }
    kickFaststart(abs, out, logFn);
    return null;
  }
  /**
   * 后台生成（同一份只跑一次；失败记下不再重试，避免反复起 ffmpeg）。
   *
   * ⚠️ **这一族拿不到 `apply()` 里的 `log`** —— 真机事故：失败分支里
   * 写了 `log.warn(...)` ⇒ `ReferenceError: log is not defined` ⇒ 抛在 catch 里 ⇒ 这个 async
   * 任务以 reject 收场且无人接管 ⇒ Node 24 按**未处理拒绝**杀掉宿主进程（崩溃日志：
   * `dsh: fatal load failure: ReferenceError: log is not defined at lib/index.js:1235`）⇒ DSH
   * 反复重启宿主、壁纸一直出不来（用户看到的就是"开屏纯色帧 + 切几张后 DSH 崩溃重启"）。
   * 所以：日志一律经参数注入的 `say`（可缺省），并且给任务挂一个**兜底 catch**，任何异常都不许
   * 让宿主进程死掉。
   */
  function kickFaststart(abs, out, logFn) {
    if (!out || FASTSTART_INFLIGHT.has(out) || FASTSTART_FAILED.has(out)) return;
    const say = (level, msg) => { try { if (logFn && typeof logFn[level] === 'function') logFn[level](msg); } catch { /* 日志绝不许反过来影响流程 */ } };
    const job = (async () => {
      const tmp = atomicTmpPath(out);
      try {
        const ff = await resolveFfmpeg(null);
        await spawnFfmpeg(ff, ['-y', '-hide_banner', '-nostdin', '-i', abs,
          '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp], FASTSTART_TIMEOUT_MS, {});
        renameSync(tmp, out);
        // info：一次性成本 + 以后每次切换都受益 ⇒ 成功事实走 info 档。
        say('info', '视频壁纸 faststart 变体已生成：' + basename(abs));
        // 同时落一份诊断行：桌面壳默认安静档，没有它这条成功事实在真机上无从核对。
        try { appendDiagLine('faststart', { file: basename(abs), size: statSync(abs).size }); } catch { /* ignore */ }
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        FASTSTART_FAILED.add(out);
        say('warn', '视频壁纸 faststart 变体生成失败（照旧服务原片）：'
          + String((err && err.message) || err));
      } finally {
        FASTSTART_INFLIGHT.delete(out);
      }
    })();
    // 兜底：即便上面还漏了什么，也绝不让它变成"未处理拒绝"把宿主带走。
    job.catch(() => { /* 见本函数的 ⚠️ */ });
    FASTSTART_INFLIGHT.set(out, job);
  }

  // 视频壁纸的 faststart 变体预热：**轮换列表优先**，然后是库里其余视频 —— 目标是"第一次切就快"，
  // 而不是"用过一次才快"。串行（同一时刻只跑一个 ffmpeg）、每次宿主加载只排一次、单张失败不影响
  // 其它；总量按**源字节**卡在上限内，库很大时自然退化成只做掉轮换列表（真机库实测：6 张视频 /
  // 1.56GB，远在 6GB 预算内）。懒生成（/media-info 与 /media 命中时起的后台任务）仍然是兜底
  // —— 新加的壁纸不可能等下一次重启才快。
  // ⚠️ `started` 是**工厂闭包**状态（per-apply）—— 插件重载后允许再排一次。
  let started = false;
  async function warmFaststartFavorites(wallpapers, logFn) {
    if (started) return;
    started = true;
    let favIds = [];
    try {
      const cfg = readConfig();
      const groups = (cfg && cfg.settings && Array.isArray(cfg.settings.rotationGroups))
        ? cfg.settings.rotationGroups : [];
      favIds = groups.flatMap((g) => (g && Array.isArray(g.wallpaperIds) ? g.wallpaperIds : [])).map(String);
    } catch { /* 读不到设置就只有"其余视频"这一档 */ }
    const videos = wallpapers.filter((w) => w.type === 'video' && w.media);
    const picked = [
      ...videos.filter((w) => favIds.includes(String(w.id))),
      ...videos.filter((w) => !favIds.includes(String(w.id))),
    ];
    let budget = FASTSTART_WARM_MAX_BYTES;
    for (const w of picked) {
      try {
        const abs = mediaMap.get(String(w.media).split('/').pop());
        if (!abs || !needsFaststart(abs)) continue;
        const size = statSync(abs).size;
        if (size > budget) continue;          // 预算用完：剩下的交给懒生成
        budget -= size;                       // 已缓存的也算占位（它就在盘上）
        const out = faststartPath(abs);
        if (existsSync(out)) continue;
        kickFaststart(abs, out, logFn);
        await FASTSTART_INFLIGHT.get(out);    // 串行：等这一份做完再排下一份
      } catch { /* 单张失败不影响其它 */ }
    }
  }

  return { faststartCacheDir, faststartVariant, pinnedFaststartVariant, warmFaststartFavorites };
}
