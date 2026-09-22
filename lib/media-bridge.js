/**
 * media-bridge.js — 「系统正在播放」的两路数据源（宿主侧），供壁纸消费：
 *
 *   1. 音频频谱（64 段）：macOS 走随包分发的 CoreAudio Process Tap 小工具
 *      （lib/audio-tap.swift，首次使用用 swiftc -O 编译并缓存；采集的是**系统输出**
 *      的 loopback，不是麦克风）；Linux/Windows 走 ffmpeg + monitor/虚拟设备。
 *      统一输出 64 段（0-255），由宿主 /audio-spectrum 提供。
 *   2. Now Playing（歌名/歌手/专辑/播放态/进度/封面）：macOS 用 media-control
 *      （系统级 MediaRemote）；Linux 用 playerctl（MPRIS）。Windows 留待二期。
 *
 * 设计约束：
 *   - **懒启动**：宿主第一次被问到数据时才启动（macOS 首次会触发「音频录制」授权
 *     弹窗；没人用就不该弹、也不该花几十秒编译）。
 *   - **全程可降级**：任何一环不可用都只改 status/hint（供设置界面引导），
 *     绝不影响壁纸本身 —— 渲染页在没有数据时仍用内置模拟源。
 *   - Linux / Windows 未安装依赖时**回落模拟源**（status=unavailable + 安装引导），
 *     符合「有则用、无则回落」的产品约定。
 */
import { spawn, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, renameSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BANDS = 64;
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

// ── 迷你 radix-2 FFT（Linux/Windows 的 ffmpeg 源用；macOS 的 Swift 工具自带 vDSP）──
/** 原地复数 FFT（长度必须是 2 的幂）。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

/**
 * PCM（Float32，长度 2 的幂）→ 64 段（0-255）。
 * 分箱与 dB 映射和 Swift 端一致，保证 macOS 与 ffmpeg 两路观感相同。
 */
function bandsFromPcm(samples, out) {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Hann 窗
    re[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  fft(re, im);
  const half = n / 2;
  const usable = half * 0.72; // 截掉最高频段（能量极微）
  const lo = 2;
  for (let b = 0; b < BANDS; b++) {
    const f0 = lo + Math.floor(usable * (b / BANDS) ** 2);
    const f1 = Math.max(f0 + 1, lo + Math.floor(usable * ((b + 1) / BANDS) ** 2));
    let peak = 0;
    for (let f = f0; f < f1 && f < half; f++) {
      const mag = Math.sqrt(re[f] * re[f] + im[f] * im[f]) / n;
      if (mag > peak) peak = mag;
    }
    const db = 20 * Math.log10(Math.max(peak, 1e-7));
    const norm = Math.max(0, Math.min(1, (db + 70) / 70));
    out[b] = Math.round(norm * 255);
  }
  return out;
}

/** 平台默认的系统音频采集方式（Linux/Windows）。返回 { args, hint } 或 null。 */
function detectFfmpegSource(platform) {
  if (platform === 'linux') {
    let monitor = '@DEFAULT_MONITOR@'; // PipeWire / PA 的 ffmpeg pulse 后端支持该别名
    try {
      const r = spawnSync('pactl', ['info'], { encoding: 'utf8', timeout: 3000 });
      const sink = r.status === 0 ? (/Default Sink:\s*(\S+)/.exec(r.stdout || '') || [])[1] : null;
      if (sink) monitor = sink + '.monitor';
    } catch { /* 用别名兜底 */ }
    return {
      args: ['-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', monitor,
             '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
      hint: '需要 ffmpeg 与 PulseAudio/PipeWire（monitor 源）',
    };
  }
  if (platform === 'win32') {
    let dev = null;
    try {
      const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { encoding: 'utf8', timeout: 5000 });
      const text = (r.stdout || '') + (r.stderr || '');
      const m = /"([^"]*(?:Stereo Mix|立体声混音|CABLE Output|VB-Audio)[^"]*)"/i.exec(text);
      if (m) dev = m[1];
    } catch { /* ignore */ }
    if (!dev) {
      return {
        args: null,
        hint: '未检测到系统音频采集设备：请在「声音设置 → 录制」启用「立体声混音」，或安装 VB-Cable 虚拟声卡后重试（未启用时壁纸回落模拟频谱）',
      };
    }
    return {
      args: ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${dev}`,
             '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
      hint: String(dev),
    };
  }
  return null;
}

export function createMediaBridge({ dataDir, log = () => {} }) {
  const state = {
    audio: { status: 'idle', hint: '' },       // idle|compiling|running|denied|unavailable
    nowPlaying: { status: 'idle', hint: '' },  // idle|running|unavailable
  };
  let spectrum = new Uint8Array(BANDS);
  let np = null;          // setMedia 的 wire（无播放时 null）
  let artworkFile = null; // 封面缓存文件（供 /now-playing/artwork）
  let artworkMime = '';   // 封面实际 MIME（路由按它回 Content-Type）
  let artworkKey = '';
  // 封面后缀白名单：媒体源给的 MIME 决定存什么后缀（存错后缀 = 浏览器按错误
  // 类型解码，PNG 会直接不显示）。
  const ARTWORK_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  };
  /** 写封面缓存并清掉其它后缀的旧文件（否则路由可能继续发上一条封面）。 */
  function writeArtwork(buf, mime) {
    try {
      const ext = ARTWORK_EXT[String(mime || '').toLowerCase()] || 'jpg';
      const dir = join(dataDir, 'cache', 'artwork');
      mkdirSync(dir, { recursive: true });
      for (const e of new Set(Object.values(ARTWORK_EXT))) {
        if (e !== ext) { try { unlinkSync(join(dir, 'now-playing.' + e)); } catch { /* ignore */ } }
      }
      const f = join(dir, 'now-playing.' + ext);
      writeFileSync(f, buf);
      artworkFile = f;
      artworkMime = mime || 'image/jpeg';
      return true;
    } catch {
      return false;
    }
  }
  let audioProc = null;
  let npTimer = null;
  let started = false;
  let stopped = false;

  const setAudio = (status, hint = '') => { state.audio = { status, hint }; };

  // ── macOS：Swift 工具（编译缓存 + 64 字节帧解析）────────────────────────────
  function ensureTapBinary() {
    const src = join(SELF_DIR, 'audio-tap.swift');
    const bin = join(dataDir, 'bin', 'we-audio-tap');
    try {
      if (existsSync(bin) && statSync(bin).mtimeMs >= statSync(src).mtimeMs) return bin;
    } catch { /* 继续编译 */ }
    mkdirSync(dirname(bin), { recursive: true });
    const r = spawnSync('swiftc', ['-O', src, '-o', bin + '.tmp'], { timeout: 180000 });
    if (r.error || r.status !== 0) {
      setAudio('unavailable', '未找到 Swift 编译器（Xcode Command Line Tools）—— 安装后重试；当前回落模拟频谱');
      return null;
    }
    try { renameSync(bin + '.tmp', bin); } catch { /* ignore */ }
    return bin;
  }

  function spawnTap(bin) {
    let acc = Buffer.alloc(0);
    audioProc = spawn(bin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    audioProc.stdout.on('data', (c) => {
      acc = Buffer.concat([acc, c]);
      while (acc.length >= BANDS) {
        spectrum = new Uint8Array(acc.subarray(0, BANDS));
        acc = acc.subarray(BANDS);
      }
    });
    audioProc.stderr.on('data', (c) => {
      const m = String(c);
      if (/tap-create-failed/.test(m)) {
        setAudio('denied', '未获得「音频录制」权限：请在「系统设置 → 隐私与安全性 → 音频录制」中勾选 DSH Desktop（或你的终端/DSH 宿主），然后重试');
      } else if (/ready/.test(m)) {
        setAudio('running');
      } else if (/failed/.test(m)) {
        setAudio('unavailable', m.trim().slice(0, 200));
      }
    });
    audioProc.on('exit', (code) => {
      audioProc = null;
      if (!stopped && state.audio.status === 'running') setAudio('unavailable', `采集进程退出（code ${code}）`);
    });
  }

  // ── Linux/Windows：ffmpeg + monitor/虚拟设备 ───────────────────────────────
  function spawnFfmpeg(spec) {
    const pcm = Buffer.alloc(0);
    let carry = Buffer.alloc(0);
    const N = 1024; // 16k 采样 → 64ms 窗口（bin ≈ 15.6Hz）
    audioProc = spawn('ffmpeg', spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    setAudio('running', spec.hint);
    audioProc.stdout.on('data', (c) => {
      carry = Buffer.concat([carry, c]);
      const need = N * 2; // s16le
      while (carry.length >= need) {
        const chunk = carry.subarray(0, need);
        carry = carry.subarray(need);
        const f = new Float32Array(N);
        for (let i = 0; i < N; i++) f[i] = chunk.readInt16LE(i * 2) / 32768;
        bandsFromPcm(f, spectrum);
      }
      void pcm;
    });
    audioProc.stderr.on('data', (c) => {
      const m = String(c).trim();
      if (m) log('ffmpeg: ' + m.slice(0, 200));
    });
    audioProc.on('exit', (code) => {
      audioProc = null;
      if (!stopped && state.audio.status === 'running') setAudio('unavailable', `ffmpeg 退出（code ${code}）`);
    });
  }

  function startAudio() {
    const platform = process.platform;
    if (platform === 'darwin') {
      const bin = ensureTapBinary();
      if (!bin) return;
      setAudio('compiling');
      spawnTap(bin);
      return;
    }
    if (platform === 'linux' || platform === 'win32') {
      const spec = detectFfmpegSource(platform);
      if (!spec || !spec.args) {
        setAudio('unavailable', spec ? spec.hint : '当前平台不支持系统音频采集，回落模拟频谱');
        return;
      }
      spawnFfmpeg(spec);
      return;
    }
    setAudio('unavailable', '当前平台不支持系统音频采集，回落模拟频谱');
  }

  // ── Now Playing ────────────────────────────────────────────────────────────
  // 例行轮询是否支持 --no-artwork：新版 media-control 默认会把封面 base64 一起吐出来
  //（每秒几百 KB JSON），例行心跳只需要曲目信息；换曲那次才连封面一起取。
  // 老版本没有这个开关 → 失败后回退成不带参数，只回退一次。
  let npNoArtwork = true;

  function pollNowPlaying() {
    if (stopped) return;
    if (process.platform === 'darwin') {
      const args = npNoArtwork ? ['get', '--no-artwork'] : ['get'];
      execFile('media-control', args, { timeout: 3000 }, (err, stdout) => {
        if (err && npNoArtwork) {
          // 老版本不认这个 flag：关掉它重试一次（本次先当失败处理，下个 tick 就好）
          npNoArtwork = false;
          return;
        }
        if (stopped) return;
        if (err) {
          state.nowPlaying = { status: 'unavailable', hint: '需要 media-control（brew install media-control）' };
          np = null;
          return;
        }
        try {
          const o = JSON.parse(stdout);
          const has = Boolean(o && (o.title || o.artist));
          np = has ? {
            hasMedia: true,
            title: String(o.title || ''),
            artist: String(o.artist || ''),
            album: String(o.album || ''),
            playing: Boolean(o.playing),
            state: o.playing ? 1 : 2,
            position: Number(o.elapsedTime) || 0,
            duration: Number(o.duration) || 0,
            thumbnail: artworkFile ? '/wallpaper-engine/now-playing/artwork' : undefined,
          } : null;
          state.nowPlaying = { status: 'running', hint: '' };
          if (has) takeArtworkMac(o);
        } catch { /* 非 JSON：忽略本次 */ }
      });
      return;
    }
    if (process.platform === 'linux') {
      execFile('playerctl', ['metadata', '--format', '{{title}}\t{{artist}}\t{{album}}\t{{status}}\t{{mpris:artUrl}}'],
        { timeout: 3000 }, (err, stdout) => {
          if (stopped) return;
          if (err) {
            state.nowPlaying = { status: 'unavailable', hint: '需要 playerctl（apt/dnf/pacman 安装后重试）' };
            np = null;
            return;
          }
          const [title, artist, album, status, art] = String(stdout).trim().split('\t');
          const has = Boolean(title);
          // MPRIS 的 artUrl 可能是 http(s) 远端地址：下载到本地缓存，宿主统一用
          // 自己的 /now-playing/artwork 提供（远端 URL 在沙箱壁纸里既跨源、又可能
          // 需要 Referer）。
          const artKey = `${title || ''}|${artist || ''}|${art || ''}`;
          if (has && artKey !== artworkKey) {
            artworkKey = artKey;
            if (/^https?:/i.test(String(art || ''))) {
              fetch(String(art), { signal: AbortSignal.timeout(5000) })
                .then((r) => r.arrayBuffer().then((buf) => ({ buf, type: r.headers.get('content-type') || 'image/jpeg' })))
                .then(({ buf, type }) => { writeArtwork(Buffer.from(buf), type); })
                .catch(() => { artworkFile = null; artworkMime = ''; });
            } else if (/^file:/i.test(String(art || ''))) {
              try { writeArtwork(readFileSync(String(art).replace(/^file:\/\//, '')), 'image/jpeg'); }
              catch { artworkFile = null; artworkMime = ''; }
            }
          }
          np = has ? {
            hasMedia: true, title: title || '', artist: artist || '', album: album || '',
            playing: status === 'Playing', state: status === 'Playing' ? 1 : 2,
            thumbnail: art || undefined,
          } : null;
          state.nowPlaying = { status: 'running', hint: '' };
        });
      return;
    }
    state.nowPlaying = { status: 'unavailable', hint: 'Windows 的媒体集成在二期提供' };
  }

  /**
   * macOS 封面获取。**通用路径是 media-control 自己带的 `artworkData`**（base64 +
   * `artworkMimeType`，来自系统 MediaRemote）—— 任何播放器都有封面：实测汽水音乐
   *（com.soda.music）、Music.app、Spotify、浏览器里的音乐页都能拿到。旧实现只问
   * Spotify 的 AppleScript，非 Spotify 播放器一律没封面（用户反馈「不显示歌曲封面」
   * 就是这个）。
   *
   * 流程：例行轮询用 `--no-artwork` 省流量 → 发现换曲（key 变化）时再取一次带封面的
   * `media-control get`，解 base64 落盘；失败才回退 Spotify 的 AppleScript（老版本
   * media-control 无 artworkData 时仍然有封面）。
   */
  function takeArtworkMac(o) {
    const key = String(o.contentItemIdentifier || `${o.title || ''}|${o.artist || ''}|${o.album || ''}`);
    if (!key || key === artworkKey) return;
    artworkKey = key;
    if (process.platform !== 'darwin') return;
    execFile('media-control', ['get'], { timeout: 4000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (stopped) return;
      let b64 = '';
      let mime = '';
      if (!err) {
        try {
          const full = JSON.parse(stdout);
          b64 = typeof full.artworkData === 'string' ? full.artworkData : '';
          mime = String(full.artworkMimeType || '');
        } catch { /* 忽略：走兜底 */ }
      }
      if (b64 && writeArtwork(Buffer.from(b64, 'base64'), mime)) return;
      fetchSpotifyArtwork();
    });
  }

  /** 兜底：Spotify 的 artwork url（media-control 没给封面数据时）。 */
  function fetchSpotifyArtwork() {
    execFile('osascript', ['-e', 'tell application "Spotify" to if it is running then return artwork url of current track'],
      { timeout: 3000 }, (err, stdout) => {
        const url = !err && /^https?:/.test(String(stdout).trim()) ? String(stdout).trim() : '';
        if (!url) { artworkFile = null; artworkMime = ''; return; }
        fetch(url, { signal: AbortSignal.timeout(5000) })
          .then((r) => r.arrayBuffer().then((buf) => ({ buf, type: r.headers.get('content-type') || 'image/jpeg' })))
          .then(({ buf, type }) => { writeArtwork(Buffer.from(buf), type); })
          .catch(() => { artworkFile = null; artworkMime = ''; });
      });
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      log('启动媒体桥（音频频谱 + Now Playing）');
      startAudio();
      pollNowPlaying();
      npTimer = setInterval(pollNowPlaying, 1000);
    },
    stop() {
      stopped = true;
      if (npTimer) { try { clearInterval(npTimer); } catch { /* ignore */ } npTimer = null; }
      if (audioProc) { try { audioProc.kill(); } catch { /* ignore */ } audioProc = null; }
    },
    spectrum: () => spectrum,
    nowPlaying: () => np,
    artworkFile: () => artworkFile,
    artworkMime: () => artworkMime,
    status: () => ({ audio: { ...state.audio }, nowPlaying: { ...state.nowPlaying } }),
  };
}
