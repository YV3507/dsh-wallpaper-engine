#!/usr/bin/env node
/**
 * e2e-web-media-origin.mjs — 真浏览器端到端：网页壁纸跑在独立媒体源上。
 *
 * 为什么要有这一层（verify-scene-live.mjs 覆盖不到的部分）：
 *   C4 证明媒体源在真实 socket 上服务正确，但它不证明**渲染页真的能把它挂进沙箱
 *   iframe 并跑起来**。这条链路只有真浏览器说得清，而它恰恰是「网页壁纸全黑」事故
 *   的现场：DSH Desktop 的能力头（x-dsh-desktop-renderer）栅栏只放行同源 frame，
 *   严格沙箱 iframe 是不透明源 → 插件路由一律 403 → 载荷必须由 host 自建的独立
 *   loopback 源提供（见 lib/index.js 的 ensureMediaOrigin）。
 *
 * 做法：迷你 host（node:http 实现 DSH 的 webServer 契约：exact / prefix 路由）
 *   + 合成蒸汽库里的一个网页壁纸 + 真实 Chromium 系浏览器加载渲染页。
 *   所有判据都由**页面自己**经 `/diag` 信标回传（无需 CDP）：
 *     ran=1        壁纸文档里的脚本真的执行了
 *     shim=1       宿主注入的 WE shim 在位（严格沙箱下 shim 必须随文档到达）
 *     propsCalls≥1 宿主注入的属性种子到达作者（漏掉它 = 依赖属性的壁纸画成默认/黑屏）
 *     fps=15       渲染页经 postMessage 通道下发的 setFps 到达作者（跨源控制通道活着）
 *
 * 不属于 npm run verify —— 它需要本机有 Chromium 系浏览器。
 * Usage: node scripts/e2e-web-media-origin.mjs
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_ROOT = join(root, '.test-cache', 'e2e-media-origin');
const STEAM_ROOT = join(TEST_ROOT, 'steamlib');
process.env.DSH_WE_STEAM_ROOT = STEAM_ROOT;
process.env.DSH_WE_CACHE_DIR = join(TEST_ROOT, 'cache');
process.env.DSH_WE_UPLOAD_DIR = join(TEST_ROOT, 'uploads');

const DIAG_FILE = join(process.env.HOME || '', '.dsh-wallpaper-engine', 'diag', 'http.jsonl');
const DEBUG = process.env.E2E_DEBUG === '1';   // 打印迷你 host 的每条请求与本次新增的全部诊断行
const MARKER = 'E2E-WEB-' + process.pid;

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}

// ── 合成蒸汽库：一个网页壁纸（project.json + index.html + preview）──────────
const webDir = join(STEAM_ROOT, 'steamapps', 'workshop', 'content', '431960', '990101');
rmSync(TEST_ROOT, { recursive: true, force: true });
mkdirSync(webDir, { recursive: true });
mkdirSync(join(STEAM_ROOT, 'steamapps', 'common', 'wallpaper_engine'), { recursive: true });
writeFileSync(join(webDir, 'project.json'), JSON.stringify({
  title: 'E2E Web Wallpaper',
  type: 'web',
  file: 'index.html',
  preview: 'preview.jpg',
  contentrating: 'Everyone',
  // 属性种子：host 必须把它注入 HTML（严格沙箱下渲染页无法运行时补推）
  general: { properties: { color0: { order: 0, type: 'color', value: '0.2 0.7 0.4' } } },
}));
writeFileSync(join(webDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

// ── 迷你 host：实现 DSH 的 webServer 契约（exact / prefix）───────────────────
const routes = [];
const ctx = {
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    tapIndex() { return () => {}; },
  },
};
const hostMod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
const host = hostMod.default || hostMod;
const dispose = (host.apply || host.inject)(ctx);

const matchRoute = (pathname) => routes.find((r) => (
  r.kind === 'exact' ? r.path === pathname : (pathname === r.path || pathname.startsWith(r.path + '/'))
));
const appServer = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (DEBUG) console.log(`[host] ${req.method} ${pathname}${req.url.indexOf('?') >= 0 ? '?…' : ''}`);
  const route = matchRoute(pathname);
  if (!route) { res.statusCode = 404; res.end('no route'); return; }
  Promise.resolve(route.handler(req, res)).catch(() => { try { res.statusCode = 500; res.end('handler error'); } catch { /* ignore */ } });
});
await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
const appPort = appServer.address().port;
const APP = `http://127.0.0.1:${appPort}`;
console.log(`迷你 host 监听 ${APP}（${routes.length} 条路由）`);

// 壁纸 HTML：把判据回传给宿主的 /diag（<img> 信标，免 CORS）。
writeFileSync(join(webDir, 'index.html'), [
  '<!doctype html><html><head><meta charset="utf-8"><title>e2e</title>',
  '<style>html,body{margin:0;background:#123}</style></head><body>',
  '<script>',
  '  window.__e2e = { propsCalls: 0, fps: null, vol: null, keys: [], frames: 0 };',
  '  window.wallpaperPropertyListener = {',
  '    applyUserProperties: function (p) {',
  '      window.__e2e.propsCalls++;',
  '      window.__e2e.keys = Object.keys(p || {});',
  '    },',
  '    applyGeneralProperties: function (p) {',
  '      if (p && typeof p.fps === "number") window.__e2e.fps = p.fps;',
  '      if (p && typeof p.volume === "number") window.__e2e.vol = p.volume;',
  '    },',
  '  };',
  '  window.__e2e.iv = [];',
  '  (function loop() {',
  '    var t = performance.now();',
  '    var iv = window.__e2e.iv;',
  '    if (window.__e2e.last) { iv.push(t - window.__e2e.last); if (iv.length > 60) iv.shift(); }',
  '    window.__e2e.last = t;',
  '    window.__e2e.frames++;',
  '    requestAnimationFrame(loop);',
  '  })();',
  '  function pct(a, q) {',
  '    if (!a.length) return 0;',
  '    var c = a.slice().sort(function (x, y) { return x - y; });',
  '    return Math.round(c[Math.min(c.length - 1, Math.floor(c.length * q))]);',
  '  }',
  '  function beacon(tag) {',
  '    var e = window.__e2e;',
  '    var img = new Image();',
  `    img.src = "${APP}/wallpaper-engine/diag?msg=" + encodeURIComponent(`,
  `      "${MARKER} " + tag`,
  '      + " ran=1 shim=" + (typeof window.__weSeedProps === "function" ? 1 : 0)',
  '      + " propsCalls=" + e.propsCalls + " fps=" + e.fps + " vol=" + e.vol',
  '      + " frames=" + e.frames + " keys=" + e.keys.join(",")',
  '      + " p50=" + pct(e.iv, 0.5) + " p95=" + pct(e.iv, 0.95) + " n=" + e.iv.length);',
  '  }',
  '  window.addEventListener("load", function () {',
  '    setTimeout(function () { beacon("load"); }, 900);',
  '    setTimeout(function () { beacon("late"); }, 3200);',
  '  });',
  '</script></body></html>',
].join('\n'));

// ── 拿 inventory → 组出与 client 完全一致的渲染页 URL ────────────────────────
const invRes = await fetch(`${APP}/wallpaper-engine/inventory`, { cache: 'no-store' });
const inv = await invRes.json();
const web = (inv.wallpapers || []).find((w) => w.id === '990101') || null;
check('inventory 列出网页壁纸且 webLiveSrc 是绝对 URL',
  Boolean(web && web.webLive === true && /^http:\/\/127\.0\.0\.1:\d+\//.test(String(web.webLiveSrc || ''))),
  web ? String(web.webLiveSrc || '').slice(0, 60) : 'not found');
if (!web) { try { dispose && dispose(); } catch { /* ignore */ } appServer.close(); process.exit(1); }

const rendererUrl = `${APP}/wallpaper-engine/scene-live/index.html?type=web&webSandbox=strict`
  + `&fit=cover&sceneFps=15&muted=true`
  + `&src=${encodeURIComponent(web.webLiveSrc)}`
  + `&mediaBase=${encodeURIComponent(`${APP}/wallpaper-engine/scene-files`)}`;
console.log(`渲染页 URL: ${rendererUrl.slice(0, 140)}…`);

// ── 起浏览器（Chromium 系；Edge 兜底）──────────────────────────────────────
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.log('  ! 未找到 Chromium 系浏览器，跳过（本脚本不进 npm run verify）');
  try { dispose && dispose(); } catch { /* ignore */ }
  appServer.close();
  process.exit(0);
}
console.log(`浏览器: ${browser}`);

// /diag 落盘位置（先记录起始偏移，只读本次新增的行）
const diagStart = existsSync(DIAG_FILE) ? readFileSync(DIAG_FILE, 'utf8').length : 0;

const profileDir = join(TEST_ROOT, 'chromium-profile');
mkdirSync(profileDir, { recursive: true });
const child = spawn(browser, [
  '--headless=new',
  '--enable-unsafe-swiftshader',   // 无头下要软件 WebGL2，渲染页才能起来
  '--disable-extensions', '--no-first-run', '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  `--user-data-dir=${profileDir}`,
  '--window-size=1280,720',
  rendererUrl,
], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 9000));
try { child.kill('SIGKILL'); } catch { /* ignore */ }
await new Promise((r) => setTimeout(r, 400));

// ── 读回信标（按本次运行的标记过滤）────────────────────────────────────────
const lines = existsSync(DIAG_FILE) ? readFileSync(DIAG_FILE, 'utf8').slice(diagStart).split('\n') : [];
const mine = [];
for (const line of lines) {
  if (!line.trim()) continue;
  try { mine.push(JSON.parse(line)); } catch { /* ignore */ }
}
// 信标按本次运行的标记过滤（诊断文件是多个实例共用的）；媒体源请求与渲染页自身
// 的诊断不携带标记，按「本次运行新增」这个时间窗来认。
const beacons = mine.filter((d) => d.kind === 'renderer' && String(d.msg || '').indexOf(MARKER) === 0);
const mediaReqs = mine.filter((d) => d.kind === 'req' && d.route === 'scene-files@media');
const rendererDiag = mine.filter((d) => d.kind === 'renderer' && String(d.msg || '').indexOf(MARKER) !== 0);
const lastBeacon = beacons.length ? String(beacons[beacons.length - 1].msg || '') : '';
const g = (k) => (new RegExp('(?:^|\\s)' + k + '=([^\\s]+)').exec(lastBeacon) || [])[1] || '';

console.log('');
if (DEBUG) {
  console.log('本次运行新增的诊断行：');
  for (const line of lines) if (line.trim()) console.log('    | ' + line.slice(0, 200));
}
console.log(`信标 ${beacons.length} 条 / 媒体源文档请求 ${mediaReqs.length} 条`);
for (const b of beacons) console.log('    · ' + String(b.msg || '').slice(0, 160));
for (const r of mediaReqs.slice(0, 6)) console.log(`    · media ${r.status} ${String(r.path || '').slice(0, 70)} dest=${r.dest || '-'}`);
for (const d of rendererDiag.slice(-6)) console.log('    · renderer ' + String(d.msg || '').slice(0, 150));

// 渲染页对跨源入口的处理是「fetch HTML → 运行时注入 shim → blob + <base href> 挂载」，
// 所以媒体源上看到的是 fetch（dest=empty）而不是 iframe 导航；关键是入口 HTML 真的
// 从媒体源取到了，且取到之后壁纸脚本真的跑起来了（下面几条）。
check('媒体源把壁纸入口 HTML 交给了渲染页', mediaReqs.some((r) => r.status === 200 && /\.html?$/i.test(String(r.path || ''))),
  mediaReqs.map((r) => r.status + ' ' + String(r.path || '')).join(' | ').slice(0, 120) || '无请求');
check('壁纸文档里的脚本真的执行了（信标 ran=1）', g('ran') === '1', lastBeacon.slice(0, 80));
check('宿主注入的 shim 在位（shim=1）', g('shim') === '1', 'shim=' + (g('shim') || '?'));
check('属性种子到达作者（propsCalls≥1，含 color0）',
  Number(g('propsCalls') || 0) >= 1 && String(g('keys') || '').indexOf('color0') !== -1,
  'propsCalls=' + (g('propsCalls') || '?') + ' keys=' + (g('keys') || '?'));
check('跨源控制通道活着（渲染页下发的 sceneFps=15 到达作者）', g('fps') === '15',
  'fps=' + (g('fps') || '?'));
// 帧率上限的实现质量：sceneFps=15 → 目标间隔 66.7ms。旧实现用 setTimeout(1000/fps)
// 之后再 rAF，回调落在刷新的任意相位上 → 间隔抖动（17/33/50ms 混排，用户观感就是
// 「限了 30 反而更卡」）。现在是跳帧：每帧都对齐 vsync，只交付第 n 帧。
const p50 = Number(g('p50') || 0);
const p95 = Number(g('p95') || 0);
check('15fps 上限下帧间隔落在目标附近（跳帧生效）', p50 >= 45 && p50 <= 100,
  `p50=${p50}ms（目标 67ms）n=${g('n') || '?'}`);
check('帧间隔均匀（无定时器抖动）', p50 > 0 && (p95 - p50) <= 25,
  `p50=${p50} p95=${p95} 抖动=${p95 - p50}ms`);

// ── teardown ────────────────────────────────────────────────────────────────
try { dispose && dispose(); } catch { /* ignore */ }
try { appServer.close(); } catch { /* ignore */ }
delete process.env.DSH_WE_STEAM_ROOT;
delete process.env.DSH_WE_UPLOAD_DIR;
rmSync(TEST_ROOT, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`E2E FAILED — ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL E2E CHECKS PASSED (${passed})`);
