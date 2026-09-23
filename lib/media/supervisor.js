/**
 * supervisor.js — media-bridge 子进程的守护与协议客户端（宿主侧）。
 *
 * 传输用 **stdio NDJSON**（`media-bridge serve`），不用它的 HTTP 服务：端口分配、
 * 防火墙、孤儿进程都不用管，stdin 一关子进程就干净退出；中间件的 HTTP 面默认
 * CORS `*` 且没有插件路由那道能力头栅栏，对「本机任意进程/页面都能读你在放什么、
 * 还能反向控制」这件事没有必要，不启用。
 *
 * 职责边界（对上层只暴露 legacy 那套同名 API，见 lib/media/index.js）：
 *   - spawn / 握手（校验 `hello.protocol`）/ 订阅事件 / 退避重启 / 空闲停进程
 *   - 把事件流维护成**快照缓存**，`nowPlaying()` / `spectrum()` 只读缓存
 *     —— 消费端不轮询中间件（它自己的 1s 基线轮询 + 控制后突发窗口才是权威）
 *   - 位置外推：快照里的 `positionMs` 是「上报时刻」的值，读的时候按
 *     `positionMs + (now - refMs) * rate` 外推（暂停/停止不外推）
 *
 * 协议约定（media-bridge docs/PROTOCOL.md）：**有 `ok` 是响应、有 `event` 是事件**，
 * 事件会插在任意两条响应之间 —— 所以绝不能用「下一行就是我的响应」这种读法。
 */
import { spawn } from 'node:child_process';

/** 支持的协议版本（`hello.protocol`）；不匹配就回落 legacy，不做猜测性兼容。 */
const PROTOCOL_VERSION = 1;
const BANDS = 64;
/** 频谱推送间隔：与客户端 50ms 拉取节奏对齐（旧实现是 20fps 采集）。 */
const SPECTRUM_INTERVAL_MS = 50;
const CALL_TIMEOUT_MS = 8000;
/**
 * 引导阶段的超时放宽：刚下载下来的二进制第一次执行时，macOS 会先做一遍安全
 * 检查（实测首次启动可慢到数秒），这段时间里 hello 还没回来是正常的，不该
 * 因此判定「中间件起不来」而回落。
 */
const BOOT_CALL_TIMEOUT_MS = 25000;
const SPAWN_TIMEOUT_MS = 15000;
const SHUTDOWN_GRACE_MS = 1500;
const KILL_GRACE_MS = 3000;
/** 崩溃重启预算：窗口内超过这个次数就判定为「跑不起来」，回落 legacy。 */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
/**
 * 空闲停进程：没有任何取数请求这么久就退出（下次访问再自动拉起）。
 * 壁纸实时渲染时客户端 50ms 拉一次，永不触发；没在用的时候不该白占一个
 * 20MB 进程 + 一路系统音频采集。0 = 不停。DSH_WE_MEDIA_IDLE_MS 可覆盖。
 */
/** 状态缓存的兜底刷新间隔：中间件只在「元数据源出错」时推 status 事件，音频源
 *  idle→preparing→running 的变化不主动通知（v0.1.3 实测；已在 v0.1.4 补事件）。
 *  这里定期重问一次，避免消费端一直看到过期的 preparing —— 症状是频谱明明有数据、
 *  客户端却因为 `running===false` 不把音频交给壁纸。 */
const STATUS_REFRESH_MS = 5000;

const IDLE_STOP_MS = (() => {
  const raw = process.env.DSH_WE_MEDIA_IDLE_MS;
  if (raw === undefined || raw === '') return 15 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 15 * 60 * 1000;
})();

/** 播放态 → 旧 wire 的数值约定（0 停止 / 1 播放 / 2 暂停）。 */
function stateCode(state) {
  if (state === 'playing') return 1;
  if (state === 'paused') return 2;
  return 0;
}

/**
 * 中间件歌词 → 渲染页要的 `[[秒, 文本], …]`。
 *
 * 渲染页的 `xd()`/`jA()` 只认这种元组数组（自己按 position 找当前行），而中间件给
 * 的是 `{ lines: [{ tMs, text }], offsetMs }`：这里做单位换算（ms → 秒）并叠加 LRC
 * 头部的 `[offset:]`（正值 = 歌词整体晚出现）。导出成纯函数是为了自检能直接用
 * 样例数据验证换算（真歌词要靠真实播放器，mock provider 不给歌词）。
 */
export function lyricsToTuples(lyr) {
  if (!lyr || !Array.isArray(lyr.lines) || !lyr.lines.length) return null;
  const off = Number(lyr.offsetMs) || 0;
  const out = [];
  for (const ln of lyr.lines) {
    const raw = ln && ln.tMs;
    // 只认「数字 / 能解析成数字的字符串」；null 会被 Number() 变成 0 混进来
    // （那会让一行歌词跑到 0 秒上），所以先按类型挡掉。
    if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'object') continue;
    const ms = Number(raw);
    if (!Number.isFinite(ms)) continue;
    out.push([Math.max(0, (ms + off) / 1000), String(ln.text == null ? '' : ln.text)]);
  }
  return out.length ? out : null;
}

export function createBridgeSupervisor({ binPath, cacheDir, log = () => {}, diag = () => {}, onFatal = null }) {
  let child = null;
  let buf = '';
  let seq = 0;
  const pending = new Map();
  const optsRef = { audio: true, online: false, mock: false };
  const lyricsMemo = { key: '', value: null };

  let started = false;
  let stopping = false;
  let booted = false;        // hello/subscribe/now 已走通
  let asleep = false;        // 空闲停过，下次取数自动唤醒
  let fatal = '';            // 非空 = 不再重启（上层据此回落 legacy）
  let info = null;           // hello 的结果
  let snap = null;           // { hasMedia, track, playback, capabilities }
  let art = { path: '', mime: '' };
  let spectrum = new Uint8Array(BANDS);
  let sources = [];
  let lastError = '';
  let lastStderr = '';
  let lastUsedAt = Date.now();
  let lastStatusAt = 0;
  let statusRefreshing = false;
  const restartAt = [];
  let restartTimer = null;
  let idleTimer = null;
  let booting = null;

  // ── 协议收发 ───────────────────────────────────────────────────────────────
  function onLine(line) {
    let msg = null;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.event) { onEvent(msg); return; }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error((msg.error && (msg.error.code + ': ' + msg.error.message)) || '协议错误'));
    }
  }

  function onEvent(ev) {
    const ts = Number(ev.tsMs) || Date.now();
    switch (ev.event) {
      // 事件顺序有保证：track → playback → artwork。
      case 'track':
      case 'playback':
        if (ev.now) applySnapshot(ev.now, ts);
        break;
      case 'artwork':
        if (ev.artwork) {
          art = { path: String(ev.artwork.path || ''), mime: String(ev.artwork.mime || '') };
          if (snap && snap.track) snap.track.artwork = ev.artwork;
          diag('media-artwork', { mime: art.mime, bytes: Number(ev.artwork.bytes) || 0 });
        }
        break;
      case 'lyrics':
        // 歌词可能晚几秒（在线查询）；只认当前曲目，避免把上一首的歌词贴过来。
        if (snap && snap.track) {
          const cur = snap.track.id;
          if (!ev.trackId || !cur || ev.trackId === cur) snap.track.lyrics = ev.lyrics || null;
        }
        lyricsMemo.key = '';
        break;
      case 'status':
        if (ev.status && Array.isArray(ev.status.sources)) sources = ev.status.sources;
        break;
      case 'spectrum':
        if (ev.frame && Array.isArray(ev.frame.bands)) frameToSpectrum(ev.frame.bands);
        break;
      case 'error':
        lastError = String(ev.message || ev.code || '未知错误');
        log('中间件报错：' + lastError);
        diag('media-error', { source: ev.source || '', code: ev.code || '', message: lastError.slice(0, 200) });
        break;
      default:
        break;
    }
  }

  function frameToSpectrum(bands) {
    const out = new Uint8Array(BANDS);
    const n = Math.min(BANDS, bands.length);
    for (let i = 0; i < n; i++) {
      const v = Number(bands[i]);
      out[i] = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
    }
    spectrum = out;
  }

  /**
   * 归一化快照。事件载荷里的位置是**已经外推到事件时刻**的值
   * （`snapshot_at_now()`，positionSource=interpolated），而 updatedAtMs 仍是轮询
   * 时刻 —— 直接拿它再外推会重复计时。这里把参考时刻改写成事件时刻，之后所有读取
   * 都走同一条外推公式。
   */
  function applySnapshot(now, refMs) {
    snap = now;
    const pb = snap && snap.playback;
    if (pb && pb.positionSource === 'interpolated' && refMs) pb.updatedAtMs = refMs;
    const a = snap && snap.track && snap.track.artwork;
    if (a && a.path) art = { path: String(a.path), mime: String(a.mime || '') };
    lyricsMemo.key = '';
  }

  function call(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) { reject(new Error('中间件未运行')); return; }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' 超时'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  function drainPending(err) {
    for (const [, p] of pending) { clearTimeout(p.timer); try { p.reject(err); } catch { /* ignore */ } }
    pending.clear();
  }

  // ── 进程生命周期 ───────────────────────────────────────────────────────────
  /** 命令行：把宿主设置翻译成中间件开关。 */
  function childArgs() {
    const args = ['serve', '--cache-dir', cacheDir, '--poll-ms', '1000'];
    if (!optsRef.audio) args.push('--no-audio');     // 音频关但元数据要：连授权都不会弹
    args.push(optsRef.online ? '--online' : '--no-online');
    if (optsRef.mock) args.push('--provider', 'mock');
    if (process.env.DSH_WE_MEDIA_DEBUG === '1') args.push('--verbose');
    return args;
  }

  /**
   * 杀掉一个可能**还没真正 spawn 出来**的子进程。
   *
   * 实测踩坑：macOS 首次执行刚下载的二进制时，安全检查会让 'spawn' 事件晚到好几秒；
   * 这时 `awaitSpawn` 超时后立刻 `kill()` 是打在空气上（pid 还没落地），进程随后才
   * 起来并且没人回收 —— 留下一只孤儿（跑完自检后 `pgrep media-bridge` 能看到它）。
   * 所以补一手：无论何时真的 spawn 出来，立刻杀。
   */
  function killWhenSpawned(p) {
    if (!p) return;
    try { p.kill('SIGKILL'); } catch { /* 还没起来，走下面那一手 */ }
    p.once('spawn', () => { try { p.kill('SIGKILL'); } catch { /* ignore */ } });
  }

  /** 等到子进程真的 spawn 出来（或报错）。dsh web 的受限上下文里管道 spawn
   *  失败是以 'error' 事件到达的，不是同步抛异常。 */
  function awaitSpawn(p) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('spawn 超时'));
      }, SPAWN_TIMEOUT_MS);
      p.once('spawn', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      });
      p.once('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** 依次尝试「普通」与「独立进程组」两种 spawn 姿势，错误全留着。 */
  async function spawnChild() {
    // dsh web 的受限 spawn 上下文里出现过「带管道直接 spawn 失败」（ffmpeg 那条
    // 链路踩过），所以两种姿势都试；失败原因写进 diag，别让它看起来像协议问题。
    const attempts = process.platform === 'win32'
      ? [{ name: 'detached', opts: { detached: true, windowsHide: true } }, { name: 'plain', opts: { windowsHide: true } }]
      : [{ name: 'plain', opts: { windowsHide: true } }, { name: 'detached', opts: { detached: true, windowsHide: true } }];
    const errors = [];
    for (const a of attempts) {
      let p = null;
      try {
        p = spawn(binPath, childArgs(), { stdio: ['pipe', 'pipe', 'pipe'], ...a.opts });
        await awaitSpawn(p);
        if (a.name !== attempts[0].name) diag('media-spawn', { via: a.name });
        return p;
      } catch (err) {
        const msg = `${a.name}: ${String(err && err.message ? err.message : err)}`;
        errors.push(msg);
        killWhenSpawned(p);
      }
    }
    throw new Error('无法启动中间件（' + errors.join('; ') + '）');
  }

  function attach(p) {
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
      if (buf.length > 1 << 20) buf = '';   // 防御：半行堆积不该无限增长
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      lastStderr = text.slice(0, 400);
      if (process.env.DSH_WE_MEDIA_DEBUG === '1') log('中间件: ' + lastStderr);
    });
    p.on('exit', (code, signal) => {
      if (child !== p) return;
      child = null;
      booted = false;
      drainPending(new Error('中间件已退出'));
      if (stopping || asleep) return;
      onUnexpectedExit(code, signal);
    });
  }

  function onUnexpectedExit(code, signal) {
    const now = Date.now();
    restartAt.push(now);
    while (restartAt.length && now - restartAt[0] > RESTART_WINDOW_MS) restartAt.shift();
    const reason = `中间件退出（code ${code}${signal ? ', ' + signal : ''}）${lastStderr ? '：' + lastStderr : ''}`;
    lastError = reason;
    diag('media-exit', { code, signal, restarts: restartAt.length });
    if (restartAt.length > MAX_RESTARTS) {
      fatal = `${reason} —— 连续失败 ${restartAt.length} 次，本次会话改用内置实现`;
      log(fatal);
      diag('media-fatal', { reason: fatal.slice(0, 200) });
      if (typeof onFatal === 'function') { try { onFatal(fatal); } catch { /* ignore */ } }
      return;
    }
    const delay = 500 * Math.pow(2, Math.max(0, restartAt.length - 1));
    log(`中间件退出，${delay}ms 后重启（第 ${restartAt.length} 次）`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startBoot();
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  /** 拉起并握手（幂等：并发调用共用同一个 promise）。 */
  function startBoot() {
    if (booting) return booting;
    if (stopping || fatal) return Promise.resolve(false);
    booting = (async () => {
      try {
        buf = '';
        const p = await spawnChild();
        child = p;
        asleep = false;
        attach(p);

        const hello = await call('hello', {}, BOOT_CALL_TIMEOUT_MS);
        if (!hello || Number(hello.protocol) !== PROTOCOL_VERSION) {
          throw new Error(`协议版本不匹配（中间件 protocol=${hello && hello.protocol}，本插件支持 ${PROTOCOL_VERSION}）`);
        }
        info = hello;

        const events = ['track', 'playback', 'artwork', 'lyrics', 'status'];
        if (optsRef.audio) events.push('spectrum');
        await call('subscribe', optsRef.audio
          ? { events, intervalMs: SPECTRUM_INTERVAL_MS }
          : { events }, BOOT_CALL_TIMEOUT_MS);

        // 初始快照用 interpolate:false：拿原始轮询值 + updatedAtMs，外推自己做
        //（服务端外推一次、这里再外推一次 = 进度条跑得比歌快）。
        const now = await call('now', { interpolate: false }, BOOT_CALL_TIMEOUT_MS);
        if (now) applySnapshot(now, Date.now());
        try {
          const st = await call('status', {}, BOOT_CALL_TIMEOUT_MS);
          if (st && Array.isArray(st.sources)) sources = st.sources;
        } catch { /* 状态拿不到不影响取数 */ }

        booted = true;
        lastError = '';
        restartAt.length = 0;
        log(`系统媒体中间件就绪：${hello.provider || ''} ${hello.version || ''}（${hello.platform || ''}/${hello.arch || ''}）`
          + (optsRef.audio ? '，含系统音频' : '，仅元数据'));
        diag('media-ready', {
          version: hello.version, provider: hello.provider, platform: hello.platform,
          arch: hello.arch, audio: optsRef.audio, online: optsRef.online,
        });
        return true;
      } catch (err) {
        lastError = String(err && err.message ? err.message : err);
        log('中间件启动失败：' + lastError);
        diag('media-boot-failed', { reason: lastError.slice(0, 200), bin: binPath });
        hardStop();
        return false;
      } finally {
        booting = null;
      }
    })();
    return booting;
  }

  /** 兜底刷新 status（节流；见 STATUS_REFRESH_MS 的说明）。 */
  function refreshStatusSoon() {
    const now = Date.now();
    if (statusRefreshing || now - lastStatusAt < STATUS_REFRESH_MS) return;
    lastStatusAt = now;
    statusRefreshing = true;
    call('status')
      .then((st) => { if (st && Array.isArray(st.sources)) sources = st.sources; })
      .catch(() => { /* 拿不到就保持旧值 */ })
      .finally(() => { statusRefreshing = false; });
  }

  function touch() {
    lastUsedAt = Date.now();
    if (asleep && !fatal && !stopping) {
      asleep = false;
      startBoot();     // 空闲退出后自动唤醒；本次读到的还是旧快照/空谱，几百毫秒后恢复
    }
  }

  function ensureIdleTimer() {
    if (idleTimer || !IDLE_STOP_MS) return;
    idleTimer = setInterval(() => {
      if (stopping || !child) return;
      if (Date.now() - lastUsedAt < IDLE_STOP_MS) return;
      log('媒体中间件空闲超时，退出（下次被访问时自动拉起）');
      diag('media-idle-stop', { idleMs: Date.now() - lastUsedAt });
      asleep = true;
      hardStop();
    }, Math.min(60 * 1000, Math.max(5000, Math.floor(IDLE_STOP_MS / 4))));
    if (idleTimer.unref) idleTimer.unref();
  }

  /** 关掉子进程；child 置空后 exit 处理器不会再当成崩溃。 */
  function hardStop() {
    const p = child;
    child = null;
    booted = false;
    drainPending(new Error('中间件已停止'));
    if (!p) return;
    try { p.stdin.end(); } catch { /* ignore */ }
    const t1 = setTimeout(() => { try { p.kill('SIGTERM'); } catch { /* ignore */ } }, SHUTDOWN_GRACE_MS);
    // 收尾那一下用 killWhenSpawned：停进程时它可能还在「spawn 中」，早杀等于没杀。
    const t2 = setTimeout(() => killWhenSpawned(p), KILL_GRACE_MS);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
  }

  function statusOf(name) {
    return sources.find((s) => s && s.name === name) || null;
  }

  /** 中间件数据源状态 → 旧 status 形状（设置界面按 status 决定提示）。 */
  function mapSource(name, fallbackStatus) {
    const s = statusOf(name);
    if (!s) return { status: fallbackStatus, hint: '' };
    const st = s.state === 'error' ? 'unavailable' : String(s.state || fallbackStatus);
    return { status: st, hint: String(s.hint || '') };
  }

  /** 歌词换算（带备忘：同一首反复读不该反复构造数组）。 */
  function lyricsFor(track) {
    const lyr = track && track.lyrics;
    const key = lyr && Array.isArray(lyr.lines)
      ? `${track.id || ''}|${lyr.lines.length}|${lyr.offsetMs || 0}|${lyr.source || ''}`
      : '';
    if (!key) return null;
    if (lyricsMemo.key === key) return lyricsMemo.value;
    lyricsMemo.key = key;
    lyricsMemo.value = lyricsToTuples(lyr);
    return lyricsMemo.value;
  }

  return {
    /** 启动并握手。resolve(false) = 起不来（含 spawn 失败/协议不符/超时）。 */
    async start(opts = {}) {
      if (started) return booted;
      started = true;
      stopping = false;
      Object.assign(optsRef, {
        audio: opts.audio !== false,
        online: opts.online === true,
        mock: opts.mock === true || process.env.DSH_WE_MEDIA_PROVIDER === 'mock',
      });
      ensureIdleTimer();
      lastUsedAt = Date.now();
      return startBoot();
    },
    stop() {
      stopping = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
      hardStop();
    },
    /** 子进程活着且握手通过（上层据此决定「当前用谁取数」）。 */
    ready: () => Boolean(child && booted && !fatal),
    fatalReason: () => fatal,
    lastError: () => lastError,
    info: () => (info ? { ...info } : null),

    // ── 与 legacy 同名的取数 API ──────────────────────────────────────────────
    spectrum: () => { touch(); return spectrum; },
    nowPlaying() {
      touch();
      if (!snap || !snap.hasMedia || !snap.track) return null;
      const t = snap.track;
      const pb = snap.playback || {};
      const durMs = Number(pb.durationMs) || Number(t.durationMs) || 0;
      const playing = pb.state === 'playing';
      let posMs = Number(pb.positionMs) || 0;
      if (playing && pb.positionSource !== 'unavailable') {
        const ref = Number(pb.updatedAtMs) || 0;
        const rate = Number.isFinite(Number(pb.rate)) && Number(pb.rate) > 0 ? Number(pb.rate) : 1;
        if (ref) posMs += Math.max(0, Date.now() - ref) * rate;
        if (durMs > 0) posMs = Math.min(posMs, durMs);
      }
      const hasArt = Boolean(art.path);
      const lyrics = lyricsFor(t);
      return {
        hasMedia: true,
        title: String(t.title || ''),
        artist: String(t.artist || ''),
        album: String(t.album || ''),
        albumArtist: String(t.albumArtist || ''),
        playing,
        state: stateCode(pb.state),
        position: Math.max(0, posMs) / 1000,
        duration: durMs / 1000,
        thumbnail: hasArt ? '/wallpaper-engine/now-playing/artwork' : undefined,
        loopMode: String(pb.loopMode || ''),
        shuffle: pb.shuffle === true,
        appName: String((t.source && t.source.appName) || ''),
        ...(lyrics ? { lyrics } : {}),
      };
    },
    artworkFile: () => (art.path || null),
    artworkMime: () => (art.mime || ''),
    status() {
      touch();
      refreshStatusSoon();
      // 用户主动关掉音频时给一个明确的「关了」，而不是中间件那边的环境缺失提示。
      const audio = optsRef.audio
        ? mapSource('audio', 'idle')
        : { status: 'off', hint: '已在设置中关闭「系统音频反应」' };
      const np = mapSource('metadata', 'idle');
      const lyrics = mapSource('lyrics', 'idle');
      return {
        backend: 'bridge',
        bridge: info ? {
          version: info.version, platform: info.platform, arch: info.arch,
          provider: info.provider, protocol: info.protocol, pid: info.pid,
          features: Array.isArray(info.features) ? info.features : [],
        } : null,
        audio: { status: audio.status, hint: audio.hint },
        nowPlaying: { status: np.status, hint: np.hint },
        lyrics: { status: lyrics.status, hint: lyrics.hint },
        sources: sources.slice(),
      };
    },
  };
}

export { PROTOCOL_VERSION, SPECTRUM_INTERVAL_MS, IDLE_STOP_MS, BANDS };
