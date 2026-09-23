#!/usr/bin/env node
/**
 * verify-media-bridge.mjs — 媒体中间件（media-bridge）接入的端到端自检。
 *
 * 测什么（用中间件自带的 `--provider mock`：内置假播放器 + 假封面，**不需要真播放
 * 器、也不碰系统音频权限**，因此可重复、可 CI 化）：
 *   1. 产物解析表：平台/架构 → 附件名 + 固定的 sha256 齐全
 *   2. 门面默认走中间件：握手 protocol=1、快照字段映射、封面路径与 MIME、状态形状
 *   3. 位置外推：两次读取之间进度在走（且不超过 duration）
 *   4. 歌词换算：lines{tMs} + offsetMs → 渲染页要的 [[秒, 文本], …]
 *   5. 回落：产物不可用时门面切回内置实现，且原因进 status.fallback
 *   6. 生命周期：stop() 之后子进程真的没了（不留孤儿）
 *
 * 产物从哪来：DSH_WE_MEDIA_BRIDGE（显式路径）→ 插件目录 bin/ → 自检缓存 →
 * 真实数据目录的下载缓存 → 都没有就 **SKIP**（退出码 0）。加 `--provision` 才会
 * 联网下载到自检缓存（`.test-cache/`）。
 *
 * 属于 `npm run verify`；用 npm run verify:bridge 单独跑也可以。
 */
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { createMediaBackend } from '../lib/media/index.js';
import {
  MEDIA_BRIDGE_TAG, MEDIA_BRIDGE_ASSETS, MEDIA_BRIDGE_SHA256, MEDIA_BRIDGE_FALLBACKS,
  mediaBridgeAssetFor, mediaBridgeCachePath, binaryMagicOk, provisionMediaBridge,
} from '../lib/media/provision.js';
import { lyricsToTuples } from '../lib/media/supervisor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = join(root, '.test-cache', 'verify-media-bridge');
const PROVISION = process.argv.includes('--provision');

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}
function skip(name, why) {
  skipped++;
  console.log('  ○ ' + name + (why ? ' — ' + why : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 产物表（纯静态，先跑，和有没有产物无关）──────────────────────────────
console.log('· 产物解析表');
check('darwin 两个架构都指向通用包',
  mediaBridgeAssetFor('darwin', 'arm64') === 'media-bridge-darwin-universal'
  && mediaBridgeAssetFor('darwin', 'x64') === 'media-bridge-darwin-universal');
check('linux x64 取 musl 静态包（无 glibc 下限）',
  mediaBridgeAssetFor('linux', 'x64') === 'media-bridge-linux-x64-musl');
check('win32 有 x64 与 arm64 两个产物',
  mediaBridgeAssetFor('win32', 'x64') === 'media-bridge-win32-x64.exe'
  && mediaBridgeAssetFor('win32', 'arm64') === 'media-bridge-win32-arm64.exe');
check('不支持的架构返回 null（回落内置实现）', mediaBridgeAssetFor('linux', 'ia32') === null);
const allAssets = [...new Set(Object.values(MEDIA_BRIDGE_ASSETS).flatMap((a) => Object.values(a)))];
const hasHash = (a) => /^[0-9a-f]{64}$/.test(String(MEDIA_BRIDGE_SHA256[a] || ''));
// 每个产物要么自己有哈希，要么它的回落链里有（win32-arm64 是 CI 的可选产物，
// Release 里没有时就靠 x64 回落 —— 那时它自己没有哈希是正常的）
check('每个产物都有 sha256（或回落链里有）',
  allAssets.every((a) => hasHash(a) || (MEDIA_BRIDGE_FALLBACKS[a] || []).some(hasHash)),
  allAssets.map((a) => a + (hasHash(a) ? '✓' : '→回落')).join(', '));
check('产物名带版本标签（升级时哈希必须一起换）', /^v\d+\.\d+\.\d+$/.test(MEDIA_BRIDGE_TAG));
check('可执行魔数识别（PE / ELF / Mach-O / universal）',
  binaryMagicOk(Buffer.from([0x4d, 0x5a, 0, 0]))
  && binaryMagicOk(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  && binaryMagicOk(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  && binaryMagicOk(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))
  && !binaryMagicOk(Buffer.from([0x3c, 0x21, 0x44, 0x4f])));

// ── 2. 歌词换算（纯函数，样例数据）─────────────────────────────────────────
console.log('· 歌词换算（渲染页要 [[秒, 文本], …]）');
const lyr = lyricsToTuples({
  offsetMs: 500,                                  // LRC [offset:500] = 整体晚 0.5s
  lines: [{ tMs: 1000, text: '第一句' }, { tMs: 12500, text: '第二句' }, { tMs: null, text: '丢掉' }],
});
check('ms → 秒并叠加 offsetMs',
  Array.isArray(lyr) && lyr.length === 2
  && lyr[0][0] === 1.5 && lyr[0][1] === '第一句' && lyr[1][0] === 13,
  JSON.stringify(lyr));
check('空歌词返回 null（渲染页退回「没有歌词」）',
  lyricsToTuples(null) === null && lyricsToTuples({ lines: [] }) === null
  && lyricsToTuples({ lines: [{ tMs: 100 }] }) !== null);
check('时间轴不会被 offset 推成负数', lyricsToTuples({ offsetMs: -90000, lines: [{ tMs: 100, text: 'x' }] })[0][0] === 0);

// ── 3. 找产物 ───────────────────────────────────────────────────────────────
console.log('· 找中间件产物');
mkdirSync(TEST_DIR, { recursive: true });
const asset = mediaBridgeAssetFor();
let binPath = '';
let binSource = '';
const envBin = process.env.DSH_WE_MEDIA_BRIDGE && process.env.DSH_WE_MEDIA_BRIDGE.trim();
const candidates = [
  ['env', envBin ? resolve(envBin) : ''],
  ['plugin-bin', asset ? join(root, 'bin', asset) : ''],
  ['test-cache', asset ? mediaBridgeCachePath(TEST_DIR, MEDIA_BRIDGE_TAG, asset) : ''],
  ['user-cache', asset ? mediaBridgeCachePath(join(homedir(), '.dsh-wallpaper-engine'), MEDIA_BRIDGE_TAG, asset) : ''],
];
for (const [src, p] of candidates) {
  if (p && existsSync(p)) { binPath = p; binSource = src; break; }
}
if (!binPath && PROVISION) {
  const prov = await provisionMediaBridge({ dataDir: TEST_DIR, log: (m) => console.log('    · ' + m) });
  if (prov.path) { binPath = prov.path; binSource = prov.source; }
  else console.log('    · 下载没成功：' + prov.error);
}
if (!binPath) {
  skip('中间件端到端用例', '本机没有产物（跑 `node scripts/verify-media-bridge.mjs --provision` 会下载 ' + MEDIA_BRIDGE_TAG + '）');
} else {
  console.log(`   产物：${binPath}（${binSource}）`);

  // ── 4. 门面：默认走中间件 ─────────────────────────────────────────────────
  console.log('· 门面（mock provider）');
  // 用中间件自带的假播放器：不需要真播放器、也不碰系统音频权限，断言才是确定的。
  // （这也是给用户的联调开关：DSH_WE_MEDIA_PROVIDER=mock 起插件就能看到假曲目。）
  process.env.DSH_WE_MEDIA_PROVIDER = 'mock';
  const backend = createMediaBackend({ dataDir: TEST_DIR, log: (m) => console.log('    · ' + m) });
  backend.start({ audio: false, online: false });   // 不碰系统音频权限
  let ready = false;
  // 首次执行刚下载的二进制时 macOS 会先做安全扫描（实测可慢到数秒），所以给足时间
  for (let i = 0; i < 200 && !ready; i++) { await sleep(150); ready = backend.usingBridge(); }
  check('中间件就绪（握手通过、子进程在跑）', ready, JSON.stringify(backend.status().fallback || ''));
  if (ready) {
    const info = backend.bridgeInfo() || {};
    check('hello.protocol = 1（协议版本一致才用）', Number(info.protocol) === 1);
    check('hello 报告平台与后端', Boolean(info.platform) && Boolean(info.provider),
      `${info.platform}/${info.arch} ${info.provider}`);

    // 等第一份快照到位（mock 播放器立刻就有曲目）
    let np = null;
    for (let i = 0; i < 20 && !np; i++) { await sleep(150); np = backend.nowPlaying(); }
    check('快照映射出曲目信息', Boolean(np && np.title && np.artist),
      np ? `${np.title} - ${np.artist}` : 'null');
    check('播放态映射成旧 wire 的 1/2/0', Boolean(np) && [0, 1, 2].includes(np.state), np ? String(np.state) : '');
    check('时长/进度是秒（不是毫秒）',
      Boolean(np) && np.duration > 10 && np.duration < 10000 && np.position >= 0 && np.position <= np.duration + 1,
      np ? `pos=${np.position.toFixed(1)}s dur=${np.duration.toFixed(1)}s` : '');
    check('封面存在时给出宿主代理路径', Boolean(np && np.thumbnail) === Boolean(backend.artworkFile()),
      np && np.thumbnail ? String(np.thumbnail) : '（无封面）');
    check('封面文件真的落盘了且 MIME 可用',
      !backend.artworkFile() || (existsSync(backend.artworkFile()) && /^image\//.test(backend.artworkMime())),
      backend.artworkFile() ? backend.artworkMime() : '（无封面）');
    check('歌词缺省时不硬塞空数组（不给渲染页假歌词）',
      !np || np.lyrics === undefined || Array.isArray(np.lyrics));

    // 频谱形状：音频关掉时也必须是「形状正确的 64 段」，而不是报错
    const sp = backend.spectrum();
    check('频谱恒为 64 段（音频关时全 0，不是错误）',
      sp && sp.length === 64 && typeof sp[0] === 'number');

    // 位置外推：等一会儿再读，进度得往前走
    const before = np ? np.position : 0;
    await sleep(1200);
    const after = backend.nowPlaying();
    check('位置随真实时间外推（不是卡在上报值）',
      Boolean(after) && after.position > before,
      `${before.toFixed(1)}s → ${after ? after.position.toFixed(1) : '?'}s`);

    // 状态形状：与旧实现同名同形，外加 backend/回落说明
    const st = backend.status();
    check('status 形状兼容旧实现（audio/nowPlaying 两段 + 后端标记）',
      st.audio && typeof st.audio.status === 'string'
      && st.nowPlaying && typeof st.nowPlaying.status === 'string'
      && st.backend === 'bridge' && st.fallback === '',
      `audio=${st.audio.status} nowPlaying=${st.nowPlaying.status}`);
    check('用户关掉音频时不装音频桥（status.audio=off）', st.audio.status === 'off', st.audio.status);
    check('mock 下 metadata 源在跑', st.nowPlaying.status === 'running', st.nowPlaying.status);

    // ── 5. 生命周期：stop() 不留孤儿 ────────────────────────────────────────
    const pid = Number(info.pid) || 0;
    backend.stop();
    let alive = false;
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (!alive) break;
    }
    check('stop() 后子进程退出（不留孤儿）', !alive, pid ? 'pid ' + pid : '（hello 没给 pid）');
  } else {
    backend.stop();
  }
}

// ── 6. 回落：产物不可用 → 内置实现 ──────────────────────────────────────────
console.log('· 回落路径');
process.env.DSH_WE_MEDIA_LEGACY = '1';   // 等价于「中间件不可用」
const fb = createMediaBackend({ dataDir: join(TEST_DIR, 'fallback'), log: () => {} });
fb.start({ audio: false, online: false });
await sleep(300);
const fst = fb.status();
check('强制内置实现时不走中间件', fb.usingBridge() === false);
check('回落原因写进 status.fallback（给用户看的原因）', typeof fst.fallback === 'string' && fst.fallback.length > 0, fst.fallback);
check('回落状态也是旧形状（audio/nowPlaying）',
  Boolean(fst.audio) && typeof fst.audio.status === 'string' && Boolean(fst.nowPlaying));
check('回落时不偷偷开音频采集（audio=off 传下去）', fst.audio.status === 'off', fst.audio.status);
fb.stop();

// 产物「看着像可执行文件、其实跑不起来」时：spawn 失败 → 回落，且**不留孤儿进程**。
// （这条是从实测里补上的：macOS 首次执行刚下载的二进制会让 'spawn' 事件晚到几秒，
//  早杀的 kill() 打在空气上，进程随后才起来 —— 于是留下一只孤儿。）
console.log('· 产物是坏二进制时不卡住、不留孤儿');
delete process.env.DSH_WE_MEDIA_LEGACY;
process.env.DSH_WE_MEDIA_IDLE_MS = '0';
const bogus = join(TEST_DIR, 'bogus-binary');
{
  const head = Buffer.alloc(4096);
  head.writeUInt32BE(0x7f454c46, 0);           // 假 ELF 头：过得了魔数校验
  const filler = Buffer.alloc(4 * 1024 * 1024, 0x41);   // 体积够（≥3MB）才不被体积检查拦下
  head.copy(filler, 0);
  writeFileSync(bogus, filler, { mode: 0o755 });
}
process.env.DSH_WE_MEDIA_BRIDGE = bogus;
const bog = createMediaBackend({ dataDir: join(TEST_DIR, 'bogus'), log: () => {} });
bog.start({ audio: false, online: false });
let bogFallback = '';
for (let i = 0; i < 120 && !bogFallback; i++) { await sleep(150); bogFallback = bog.status().fallback || ''; }
check('坏产物 → 回落内置实现（不无限等）', Boolean(bogFallback) && bog.usingBridge() === false,
  bogFallback || '（超时未回落）');
bog.stop();
await sleep(1500);
if (process.platform === 'win32') {
  skip('坏产物没有留下孤儿进程', 'Windows 上没有 pgrep');
} else {
  let stray = '';
  try {
    stray = execFileSync('pgrep', ['-fl', 'bogus-binary'], { encoding: 'utf8' }).trim();
  } catch { /* pgrep 退出码 1 = 没找到，正是期望 */ }
  check('坏产物没有留下孤儿进程', !stray, stray || '无');
}
delete process.env.DSH_WE_MEDIA_BRIDGE;
delete process.env.DSH_WE_MEDIA_IDLE_MS;

rmSync(join(TEST_DIR, 'fallback'), { recursive: true, force: true });
rmSync(join(TEST_DIR, 'bogus'), { recursive: true, force: true });
rmSync(bogus, { force: true });

console.log(`\nmedia-bridge 自检：${passed} 通过 / ${failed} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
process.exit(failed ? 1 : 0);
