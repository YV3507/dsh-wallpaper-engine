/**
 * index.js — 媒体后端门面：**首选 media-bridge 子进程，失败自动回落旧实现**。
 *
 * 对宿主只暴露与旧实现同名的一小组方法（start/stop/spectrum/nowPlaying/
 * artworkFile/artworkMime/status），所以 lib/index.js 的路由层不需要知道底下是谁
 * 在供数 —— 这是刻意留的接缝：换后端不动路由形状，回滚也不需要改路由。
 *
 * 选择逻辑（每次会话只决定一次，之后靠 bridge.ready() 判断中间件是否还活着）：
 *   1. `DSH_WE_MEDIA_LEGACY=1`            → 直接用旧实现（排查/对比用）
 *   2. 产物解析成功 + spawn + 握手通过     → 中间件（三平台同一套能力）
 *   3. 任一步失败（取不到产物/起不来/协议不符/连续崩溃）→ 旧实现 + 原因进 status
 */
import { join } from 'node:path';
import { createMediaBridge as createLegacy } from './legacy.js';
import { createBridgeSupervisor } from './supervisor.js';
import { provisionMediaBridge } from './provision.js';

export function createMediaBackend({ dataDir, log = () => {}, diag = () => {} }) {
  const cacheDir = join(dataDir, 'cache', 'media-bridge');

  let started = false;
  let useBridge = false;         // 中间件可用（握手通过且没被判死）
  let fallback = '';             // 回落原因（空 = 没回落）
  let note = '';                 // 准备中的说明（设置界面可见）
  let booting = null;
  let sup = null;
  let legacy = null;
  const optsRef = { audio: true, online: false };
  const forceLegacy = String(process.env.DSH_WE_MEDIA_LEGACY || '').trim() === '1';

  /** 旧实现按需构造（音频开关要跟着用户设置走，不能构造时就定死）。 */
  function legacyBackend() {
    if (!legacy) legacy = createLegacy({ dataDir, log, audio: optsRef.audio });
    return legacy;
  }

  /** 当前真正在供数的后端（中间件没就绪/已判死时都落到旧实现）。 */
  function active() {
    if (useBridge && sup && sup.ready()) return sup;
    return legacyBackend();
  }

  function fallBackTo(reason) {
    if (fallback) return;
    fallback = reason || '中间件不可用';
    useBridge = false;
    note = '';
    log('回落到内置媒体实现：' + fallback);
    diag('media-fallback', { reason: String(fallback).slice(0, 200) });
    try { legacyBackend().start(); } catch (err) { log('内置媒体实现启动失败：' + err); }
  }

  function bootBridge() {
    if (booting) return booting;
    booting = (async () => {
      note = '正在准备系统媒体中间件…';
      const prov = await provisionMediaBridge({ dataDir, log });
      if (!prov.path) { fallBackTo(prov.error || '中间件产物不可用'); return; }
      sup = createBridgeSupervisor({
        binPath: prov.path,
        cacheDir,
        log,
        diag,
        onFatal: (why) => fallBackTo(why),
      });
      const ok = await sup.start({ audio: optsRef.audio, online: optsRef.online });
      if (!ok) { fallBackTo(sup.lastError() || '中间件启动失败'); return; }
      useBridge = true;
      note = '';
      log(`媒体数据源：系统媒体中间件（${prov.source}${prov.tag ? ', ' + prov.tag : ''}）`);
    })().catch((err) => {
      fallBackTo('中间件准备出错：' + String(err && err.message ? err.message : err));
    }).finally(() => { booting = null; });
    return booting;
  }

  return {
    /** 懒启动（与旧实现一样由路由第一次被访问时触发；重复调用无副作用）。 */
    start(opts = {}) {
      if (started) return;
      started = true;
      Object.assign(optsRef, { audio: opts.audio !== false, online: opts.online === true });
      if (forceLegacy) {
        fallback = '按 DSH_WE_MEDIA_LEGACY=1 使用内置实现';
        log('媒体数据源：内置实现（DSH_WE_MEDIA_LEGACY=1）');
        legacyBackend().start();
        return;
      }
      bootBridge();
    },
    stop() {
      try { if (sup) sup.stop(); } catch { /* ignore */ }
      try { if (legacy) legacy.stop(); } catch { /* ignore */ }
    },
    spectrum: () => active().spectrum(),
    nowPlaying: () => active().nowPlaying(),
    artworkFile: () => active().artworkFile(),
    artworkMime: () => active().artworkMime(),
    status() {
      const live = useBridge && sup && sup.ready();
      const st = active().status();
      return {
        ...st,
        backend: live ? 'bridge' : st.backend,
        fallback,
        note,
      };
    },
    /** 当前是否中间件在供数（自检与设置界面用）。 */
    usingBridge: () => Boolean(useBridge && sup && sup.ready()),
    bridgeInfo: () => (sup ? sup.info() : null),
  };
}
