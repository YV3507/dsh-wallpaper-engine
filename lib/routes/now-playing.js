/**
 * routes/now-playing.js — **媒体状态族**路由：媒体后端健康探针（`/media-status`）、
 * 系统音频频谱（`/audio-spectrum`）、当前曲目信息（`/now-playing`）与封面字节
 * （`/now-playing/artwork`）。P2-11 的第二族（账本 §3.5 的四步模板）。
 *
 * 为什么值得独立成文件：这四条路由共用同一个**懒启动**的媒体后端实例与它的一次性启动决策
 * —— `mediaBackend` 与 `ensureMedia` 只被这一族引用（全仓无其它消费者），此前它们散落在
 * `apply(ctx)` 的同一个闭包里，"谁负责启动、谁负责停"只能靠通读整个函数得出。独立成文件后，
 * 后端的生命周期就是本文件的两个局部量，而**依赖写在签名上**（`c`）。
 *
 * 契约：`registerNowPlayingRoutes(webServer, c)`；`c` 里是这一族**用到但不属于它**的东西：
 *   · `disposers`      ← `apply` 的清理句柄数组；注册返回值与后端停止都要推进去
 *   · `base`           ← 路径前缀 `BASE`（宿主唯一的定义处；这里以别名 BASE 使用）
 *   · `appendDiagLine` ← `lib/index.js` 的模块级落盘函数（多族共用，留在原地）
 *   · `configPath`     ← 模块级：数据目录里的 `config.json` 路径（后端的 `dataDir` 取它的父目录）
 *   · `readConfig`     ← 模块级：读取设置（启动决策读 `audioSource` / `mediaIntegration` / `mediaLyricsOnline`）
 *   · `serveFile`      ← `apply` 作用域的静态文件发送器（11 条路由共用，留在原地，以引用进 context）
 * 族内状态（`mediaBackend` / `ensureMedia`）随族搬走 —— 只被这一族使用，**不经过 context**。
 *
 * 不变量：
 *   · **懒启动**：后端只在第一次被问到数据时才启动 —— 没人用就不该去下产物、不起子进程、
 *     更不该申请系统音频权限。启动决策**每次现读设置**（改完设置下一次请求即生效）。
 *   · `audioSource === 'off'` 且媒体集成关闭 ⇒ **完全不启动**（`ensureMedia` 直接返回）。
 *   · `DSH_WE_MEDIA_NO_AUDIO=1` ⇒ 只取元数据、永不碰系统音频采集（与 `DSH_WE_DATA_DIR` /
 *     `DSH_WE_CACHE_DIR` 同一套测试隔离约定：端到端脚本靠它免掉「音频录制」授权弹窗）。
 *   · `/audio-spectrum` 的 `running` 是**客户端契约**：为 false 时客户端不装音频桥 —— 渲染页
 *     一旦装了桥就跳过场景 BGM 的分析器接线，喂一屏 0 会把音频反应从「内置模拟源」变成一条死线。
 *   · `/now-playing/artwork` **每次**都读当前快照的路径：中间件的封面文件名带内容指纹（换曲即换名），
 *     缓存文件名会在换曲后继续发上一张封面。
 *   · 注册顺序按原样：`/media-status` → `/audio-spectrum` → `/now-playing` → `/now-playing/artwork`。
 *   · 注册返回值与 `mediaBackend.stop()` 都必须推进 `c.disposers`，否则插件卸载 / HMR 之后
 *     路由仍挂着已释放的处理器，子进程与系统音频采集也继续存活。
 */

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMediaBackend } from '../media/index.js';

export function registerNowPlayingRoutes(webServer, c) {
  const { disposers, base: BASE, appendDiagLine, configPath, readConfig, serveFile } = c;

  // 3c-5. 媒体后端（Now Playing + 系统音频频谱）。首选 media-bridge 子进程
  //       （macOS MediaRemote/CoreAudio、Windows GSMTC/WASAPI、Linux MPRIS/PipeWire，
  //       三平台同一套能力）；取不到产物或起不来时由门面自动回落到 lib/media/legacy.js
  //       （macOS Swift tap + ffmpeg 路径），回落原因在 status.fallback 里。
  const mediaBackend = createMediaBackend({
    dataDir: dirname(configPath()),
    log: (m) => console.log('[wallpaper-engine][media] ' + m),
    diag: appendDiagLine,
  });
  disposers.push(() => mediaBackend.stop());
  const ensureMedia = () => {
    let st = {};
    try {
      const cfg = readConfig();
      st = cfg && cfg.settings ? cfg.settings : {};
    } catch { /* 读不到配置就按默认启用 */ }
    if (st.audioSource === 'off' && st.mediaIntegration === false) return;
    mediaBackend.start({
      // DSH_WE_MEDIA_NO_AUDIO=1：只取元数据、永不碰系统音频采集（不申请授权）。
      audio: st.audioSource !== 'off' && process.env.DSH_WE_MEDIA_NO_AUDIO !== '1',
      online: st.mediaLyricsOnline === true,
    });
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/media-status`,
    handler: (req, res) => {
      ensureMedia();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ ok: true, ...mediaBackend.status() }));
    },
  }));
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/audio-spectrum`,
    handler: (req, res) => {
      ensureMedia();
      const st = mediaBackend.status();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      // running=false 时客户端**不装**音频桥：渲染页一旦装了桥就跳过场景 BGM 的
      // 分析器接线（renderer 的 L2 开头即 `if(t.audioBridge) return`），喂一屏 0
      // 会把壁纸的音频反应从「内置模拟源」变成「一条死线」。让渲染页继续用自己的
      // 模拟源 / 包内音频分析，比喂 0 正确。
      res.end(JSON.stringify({
        ok: true,
        bands: Array.from(mediaBackend.spectrum()),
        running: st.audio.status === 'running',
      }));
    },
  }));
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/now-playing`,
    handler: (req, res) => {
      ensureMedia();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        ok: true,
        media: mediaBackend.nowPlaying(),
        hasArtwork: Boolean(mediaBackend.artworkFile()),
      }));
    },
  }));
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/now-playing/artwork`,
    handler: (req, res) => {
      // 中间件的封面文件名带内容指纹（换曲即换名），所以每次都要读当前快照的路径，
      // 不能缓存文件名 —— 缓存了会在换曲后继续发上一张封面。
      const f = mediaBackend.artworkFile();
      if (!f || !existsSync(f)) { res.statusCode = 404; res.end('no-artwork'); return; }
      res.setHeader('Cache-Control', 'no-store');
      serveFile(f, req, res, false);
    },
  }));
}
