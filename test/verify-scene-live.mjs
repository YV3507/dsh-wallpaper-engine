#!/usr/bin/env node
/**
 * verify-scene-live.mjs — WebWallGL live render pipeline self-test.
 *
 * Levels:
 *   A. Vendor artifacts: lib/webwallgl/ carries the renderer page with
 *      /wallpaper-engine/scene-live/-prefixed asset refs and an .upstream.json
 *      whose file list actually exists (sync-webwallgl.mjs output).
 *   B. /scene-live route (mock webServer): index.html + hashed assets serve
 *      with the right mime/cache headers, the directory fence rejects escapes
 *      (encoded ../), and non-GET is 405.
 *   C. /scene-files route: a synthetic Steam library fixture (DSH_WE_STEAM_ROOT
 *      → temp dir with steamapps/common/wallpaper_engine + workshop content)
 *      drives the real inventory so a token gets minted; asserts scene pkg /
 *      project.json byte-for-byte serving, the fence, unknown-token 404,
 *      missing-subpath 404 and Range/206.
 *   D. Client source contract: src/client.js exposes the live pieces
 *      (priority chain, heartbeat, audio mux, key extension) — cheap static
 *      assertions that fail loudly when a refactor drops the wiring.
 *
 * Runs anywhere (no Steam needed — the fixture is synthetic).
 *
 * Usage:  node test/verify-scene-live.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
// 剥注释：共享的字符串感知实现（`verify-module-layout` ⑦ 钉住"不许再用朴素正则"）。
import { stripComments } from './tools/js-text.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep every cache/config write inside the workspace (same stance as
// verify-scene.mjs) — apply() may sweep/purge caches on startup.
const TEST_CACHE_DIR = join(root, '.test-cache', 'scene-live');
process.env.DSH_WE_CACHE_DIR = TEST_CACHE_DIR;
// Custom-storage fixture, created BEFORE lib/index.js is imported: UPLOAD_DIR
// is resolved at module load, and the inventory scan must see the fixture from
// its very first call (the scan result is TTL-cached for 3 s).
const TEST_UPLOAD_DIR = join(TEST_CACHE_DIR, 'uploads-fixture');
process.env.DSH_WE_UPLOAD_DIR = TEST_UPLOAD_DIR;
// 设置文件（config.json）也挪进来：本脚本会 PUT 设置来验证「覆盖值 → HTML 种子」
// 这条链路，绝不能碰用户真实的那份（pluginDataDir 认这个变量，不设时行为不变）。
const TEST_DATA_DIR = join(TEST_CACHE_DIR, 'data');
process.env.DSH_WE_DATA_DIR = TEST_DATA_DIR;
// POSIX 读 $HOME、Windows 读 %USERPROFILE%，两个都覆盖。
const TEST_HOME = join(TEST_CACHE_DIR, 'home');
mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

/** Minimal PKGV writer (raw entries) — mirrors the synthetic builder in
 *  verify-scene.mjs so the static-frame extractor has something real to chew on. */
function buildPkg(entries) {
  const parts = [];
  const index = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    index.push({ path, offset, length: bytes.length });
    parts.push(bytes);
    offset += bytes.length;
  }
  const headerSize = 12 + 8 + index.reduce((n, e) => n + 4 + Buffer.byteLength(e.path, 'utf8') + 8, 0);
  const header = Buffer.alloc(headerSize);
  let p = 0;
  header.writeInt32LE(8, p); p += 4;
  header.write('PKGV0001', p, 'ascii'); p += 8;
  header.writeInt32LE(index.length, p); p += 4;
  for (const e of index) {
    header.writeInt32LE(Buffer.byteLength(e.path, 'utf8'), p); p += 4;
    header.write(e.path, p, 'utf8'); p += Buffer.byteLength(e.path, 'utf8');
    header.writeUInt32LE(e.offset, p); p += 4;
    header.writeUInt32LE(e.length, p); p += 4;
  }
  return Buffer.concat([header.subarray(0, p), ...parts]);
}
function buildTexRgba(width, height, rgbaBytes) {
  const mip = Buffer.alloc(20 + rgbaBytes.length);
  mip.writeInt32LE(width, 0);
  mip.writeInt32LE(height, 4);
  mip.writeInt32LE(0, 8);
  mip.writeInt32LE(0, 12);
  mip.writeInt32LE(rgbaBytes.length, 16);
  rgbaBytes.copy(mip, 20);
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4;  // RGBA8888
  header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4;
  header.writeInt32LE(1, p); p += 4;
  return Buffer.concat([header.subarray(0, p), mip]);
}
/** 32×32 noise RGBA (noise survives the extractor's flatness/color gates). */
function noiseRgba(w) {
  const rgba = Buffer.alloc(w * w * 4);
  let seed = 0x12345678;
  for (let i = 0; i < w * w; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba[i * 4] = seed & 0xff;
    rgba[i * 4 + 1] = (seed >> 8) & 0xff;
    rgba[i * 4 + 2] = (seed >> 16) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
function writeUploadsFixture() {
  rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
  // A WE project directory, exactly the shape a WallpaperEM downloads folder
  // has: project.json declaring scene.json while only scene.pkg ships.
  const projDir = join(TEST_UPLOAD_DIR, 'my-scene-1');
  mkdirSync(projDir, { recursive: true });
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: buildTexRgba(32, 32, noiseRgba(32)) },
  ]);
  writeFileSync(join(projDir, 'scene.pkg'), pkg);
  writeFileSync(join(projDir, 'project.json'), JSON.stringify({
    title: 'Custom Dir Scene', type: 'scene', file: 'scene.json', preview: 'preview.jpg',
    contentrating: 'Everyone',
    // 作者配色：这条属性既是垫底图的底色兜底，也是「主题随壁纸」的优先级①。
    // 目录形态的上传一旦在 inventory 里把它丢掉，优先级①对这些壁纸就不生效、只能退到
    // 画面主色 —— 实测那会把作者标了 0 0 0 的暗色壁纸判成浅色（本夹具就是那条判据）。
    general: { properties: { schemecolor: { order: 0, text: 'ui_browse_properties_scheme_color', type: 'color', value: '0.114 0.220 0.329' } } },
  }));
  writeFileSync(join(projDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  // A legacy single-file upload must keep working alongside directories.
  writeFileSync(join(TEST_UPLOAD_DIR, 'up-fixture-image.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
}
writeUploadsFixture();

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}

// ── Level A: vendor artifacts ────────────────────────────────────────────────
console.log('Level A — vendored WebWallGL renderer page');
const vendorDir = join(root, 'lib', 'webwallgl');
const vendorHtmlPath = join(vendorDir, 'index.html');
check('lib/webwallgl/index.html exists', existsSync(vendorHtmlPath));
const vendorHtml = existsSync(vendorHtmlPath) ? readFileSync(vendorHtmlPath, 'utf8') : '';
const assetRefs = [...vendorHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
check('renderer html references assets under /wallpaper-engine/scene-live/',
  assetRefs.length > 0 && assetRefs.every((r) => r.startsWith('/wallpaper-engine/scene-live/')),
  assetRefs.length + ' refs');
const upstreamPath = join(vendorDir, '.upstream.json');
check('.upstream.json present', existsSync(upstreamPath));
if (existsSync(upstreamPath)) {
  const up = JSON.parse(readFileSync(upstreamPath, 'utf8'));
  const missing = (up.files || []).filter((f) => !existsSync(join(vendorDir, f)));
  check('.upstream.json files all exist on disk', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : (up.name || '') + '@' + (up.version || '?'));
}

// 网页壁纸帧率上限的实现质量与 shim 幂等性 —— 这两条都是实测踩过的坑，且都藏在
// vendor 产物里：升级上游后若忘记重新 vendor，断言会直接指出。
const vendoredShim = existsSync(join(vendorDir, 'web-shim.js'))
  ? readFileSync(join(vendorDir, 'web-shim.js'), 'utf8') : '';
/** `installRafThrottle` 的函数体（大括号配对）—— 节流实现只在这段里算数。 */
function shimThrottleBody(src) {
  const at = src.indexOf('function installRafThrottle');
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}
/**
 * 节流判据：**每帧都挂原生 rAF（保 vsync 相位），交付只看经过的时间**。
 * 三种坏形态都判红：
 *   · 定时器节流（`setTimeout(1000/fps)` 后再 rAF）—— 定时器落在刷新的任意相位上，
 *     30fps 上限产出 17/33/50ms 抖动，观感是「限了 30 反而更卡」；
 *   · 按**回调次数**跳帧（旧 `slot % n`）—— 长任务后浏览器一个 vsync 只补发一个回调，
 *     间隔被放大成「饿死时长 + 最多 (n-1)×vsync」，尾部呈目标间隔的整数倍；
 *   · 只在链首判相位（相位基准挂在链内）—— 作者回调普遍自递归登记下一帧，每次交付都换
 *     新链，饿死恰好落在链首时链内什么都看不到。
 * 判据作用在**剥掉注释**的代码上：这段的注释里就写着 `setTimeout(1000/fps)`。
 * 上游在 b11e839 把判据从「数回调次数」改成「比时间戳」（#8），本条随之更新。
 */
function shimThrottleOk(body) {
  if (typeof body !== 'string') return false;
  const code = stripComments(body);
  return code.includes('origRaf(step)')            // 每帧都挂原生 rAF（与 vsync 同相位）
    && /nowMs\s*-\s*lastDeliverNow/.test(code)     // 交付按**经过的时间**判，不看回调次数
    && /target\s*-\s*slack/.test(code)             // 目标间隔 1000/fps + 测量噪声容差
    && !/\bsetTimeout\s*\(/.test(code);            // 定时器节流 = 抖动
}
const shimBody = shimThrottleBody(vendoredShim);
check('vendored shim throttles by vsync frame-skip (not setTimeout)',
  shimThrottleOk(shimBody),
  '每帧挂原生 rAF + 按时间戳交付（旧的 setTimeout 节流与数回调次数两种实现都判红）');
check('vendored shim throttle negative control: 定时器 / 数回调次数 / 链内相位 三种坏实现都被判出',
  shimThrottleOk('{ rafMap[id] = { kind: "native", id: origRaf(step) }; setTimeout(function () { cb(now); }, 1000 / fps); }') === false
  && shimThrottleOk('{ slot++; if (slot % n !== 0) { rafMap[id] = { kind: "native", id: origRaf(step) }; return; } cb(now); }') === false
  && shimThrottleOk('{ var lastNow = 0; var nowMs = now; var target = 1000 / fps; var slack = 0; if (nowMs - lastNow < target - slack) return; rafMap[id] = { kind: "native", id: origRaf(step) }; }') === false
  && shimThrottleOk('{ var nowMs = 1; var target = 2; var slack = 0; if (nowMs - lastDeliverNow < target - slack) {} rafMap[id] = { kind: "native", id: origRaf(step) }; }') === true);
check('vendored shim installs only once (idempotent guard)',
  /__weShimInstalled/.test(vendoredShim),
  '双 shim 会让 rAF 节流叠加：15fps 上限实测变成 7.5fps');
const vendoredBundle = assetRefs
  .filter((r) => r.endsWith('.js'))
  .map((r) => { try { return readFileSync(join(vendorDir, r.replace('/wallpaper-engine/scene-live/', '')), 'utf8'); } catch { return ''; } })
  .join('\n');
check('renderer rewrite recognises any data-we-shim value (host-injected shim)',
  vendoredBundle.includes('data-we-shim(?:-src)?'),
  '宿主注入的是 data-we-shim="host"，按值匹配会重复注入');

// ── shared mock webServer + req/res shims ───────────────────────────────────
const routes = [];
const mockCtx = {
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    tapIndex() { return () => {}; },
  },
};
const hostMod = await import(pathToFileURL(resolve(root, 'lib', 'index.js')).href);
const host = hostMod.default || hostMod;
const apply = host.apply || (host.inject && host.apply);
const dispose = apply(mockCtx);

// 本脚本全程模拟**带能力头栅栏的桌面端**：社区壳（DSH Desktop.app）会给每条插件
// 路由注入 x-dsh-desktop-renderer，观测到它宿主才把网页壁纸载荷放进独立媒体源 ——
// 下面那条「webLiveSrc 是媒体源绝对 URL」的事故闸门正是这个形态的回归门。裸请求
//（原生浏览器，载荷走应用源相对路径）那一档由 test/verify-adapter.mjs 另行断言。
const FENCE_HEADERS = { 'x-dsh-desktop-renderer': '1', 'user-agent': 'Electron/33.2.0' };

function fakeReq(url, headers) {
  return { url, headers: headers || {}, method: 'GET' };
}
function fakeRes() {
  const state = { status: 200, headers: {}, body: Buffer.alloc(0), ended: false };
  const res = new Writable({
    write(chunk, enc, cb) { state.body = Buffer.concat([state.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]); cb(); },
    final(cb) { state.ended = true; cb(); },
  });
  res.setHeader = (k, v) => { state.headers[k] = v; };
  res.writeHead = (s, h) => { state.status = s; if (h) Object.assign(state.headers, h); };
  Object.defineProperty(res, 'statusCode', { get: () => state.status, set: (v) => { state.status = v; } });
  res.__state = state;
  return res;
}
/** 带请求体的 fake 请求（settings PUT）：handler 里是 req.on('data'/'end')，用 Readable 即可。 */
function fakeReqBody(url, method, obj) {
  const r = Readable.from([Buffer.from(JSON.stringify(obj))]);
  r.url = url;
  r.method = method;
  r.headers = { 'content-type': 'application/json' };
  return r;
}
/** 等响应 end/finish（PUT 的应答在写盘之后才发，等它就是等持久化完成）。 */
function waitRes(res) {
  return new Promise((resolveFn) => {
    if (res.__state.ended) { resolveFn(); return; }
    const t = setTimeout(resolveFn, 5000);
    res.on('finish', () => { clearTimeout(t); resolveFn(); });
  });
}
async function runHandler(route, url, headers) {
  const res = fakeRes();
  const done = route.handler(fakeReq(url, headers), res);
  if (done && typeof done.then === 'function') await done;
  if (!res.__state.ended) {
    await new Promise((resolveFn) => {
      const t = setTimeout(resolveFn, 8000);
      res.on('finish', () => { clearTimeout(t); resolveFn(); });
    });
  }
  return res;
}
const h = (res, k) => res.__state.headers[k] || res.__state.headers[k.toLowerCase()] || '';

// ── Level B: /scene-live static route ────────────────────────────────────────
console.log('Level B — /scene-live route (mock webServer)');
const liveRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-live');
check('scene-live route registered', Boolean(liveRoute), liveRoute ? 'kind=' + liveRoute.kind : 'missing');
if (liveRoute) {
  const idxRes = await runHandler(liveRoute, '/wallpaper-engine/scene-live/index.html');
  check('index.html 200 + text/html', idxRes.__state.status === 200 && /text\/html/.test(h(idxRes, 'Content-Type')),
    'status=' + idxRes.__state.status + ' ' + h(idxRes, 'Content-Type'));
  check('index.html no-store', /no-store/.test(h(idxRes, 'Cache-Control')), h(idxRes, 'Cache-Control'));

  // Serve one referenced asset (hashed name → immutable long cache).
  const assetRef = assetRefs.find((r) => r.endsWith('.js'));
  const assetRes = assetRef ? await runHandler(liveRoute, assetRef) : null;
  check('hashed asset 200 + js mime + immutable',
    assetRes && assetRes.__state.status === 200 && /javascript/.test(h(assetRes, 'Content-Type'))
      && /immutable/.test(h(assetRes, 'Cache-Control')),
    assetRes ? h(assetRes, 'Content-Type') + ' ' + h(assetRes, 'Cache-Control') : 'no js asset ref found');

  // Bare prefix serves index.html (the client loads /scene-live/index.html, but
  // the directory form must not 404).
  const dirRes = await runHandler(liveRoute, '/wallpaper-engine/scene-live/');
  check('directory form serves index.html', dirRes.__state.status === 200 && /text\/html/.test(h(dirRes, 'Content-Type')),
    'status=' + dirRes.__state.status);

  // Encoded ../ escape must be fenced. NOTE: literal ../ (or %2e%2e) segments
  // are normalised away by `new URL()` itself and never reach the handler;
  // the %2e%2e%2f form (encoded slash) survives normalisation, decodes to a
  // real parent hop inside the handler and MUST be stopped by the fence.
  const escRes = await runHandler(liveRoute, '/wallpaper-engine/scene-live/%2e%2e%2findex.js');
  check('encoded ../ escape fenced (403)', escRes.__state.status === 403, 'status=' + escRes.__state.status);

  const postRes = fakeRes();
  liveRoute.handler({ url: '/wallpaper-engine/scene-live/index.html', headers: {}, method: 'POST' }, postRes);
  check('POST rejected (405)', postRes.__state.status === 405, 'status=' + postRes.__state.status);
}

// ── Level C: /scene-files via synthetic Steam fixture ────────────────────────
console.log('Level C — /scene-files route (synthetic Steam library)');
const fixtureRoot = join(root, '.test-cache', 'scene-live', 'steamlive-fixture');
const workshopDir = join(fixtureRoot, 'steamapps', 'workshop', 'content', '431960', '990001');
rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(workshopDir, { recursive: true });
// A library root is only counted when steamapps/common/wallpaper_engine exists
// (see owningLibrariesP) — create it so enumerate picks the workshop content up.
mkdirSync(join(fixtureRoot, 'steamapps', 'common', 'wallpaper_engine'), { recursive: true });
const pkgBytes = Buffer.concat([
  Buffer.from('PKGV0023', 'latin1'),
  Buffer.alloc(4096, 0x5a),
]);
writeFileSync(join(workshopDir, 'scene.pkg'), pkgBytes);
writeFileSync(join(workshopDir, 'project.json'), JSON.stringify({
  title: 'Live Fixture Scene',
  type: 'scene',
  file: 'scene.pkg',
  preview: 'preview.jpg',
  contentrating: 'Everyone',
}));
// preview only needs to exist for the inventory probe; content is irrelevant.
writeFileSync(join(workshopDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
// A file OUTSIDE the wallpaper dir, targeted by the fence test.
const secretPath = join(fixtureRoot, 'secret.txt');
writeFileSync(secretPath, 'top-secret');
// A web-wallpaper fixture directory (project.json + HTML entry + subresources):
// drives the /scene-files HTML shim injection, subresource MIME and CORS asserts.
const webDir = join(fixtureRoot, 'steamapps', 'workshop', 'content', '431960', '990003');
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, 'project.json'), JSON.stringify({
  title: 'Fixture Web Wallpaper', type: 'web', file: 'index.html', preview: 'preview.jpg',
  contentrating: 'Everyone',
  // 用户属性：host 必须把它转成 seed 脚本注入 HTML（严格沙箱下渲染页无法运行时补推）
  general: {
    properties: {
      color0: { order: 0, type: 'color', value: '1 0 0' },
      fpslock: { order: 1, type: 'bool', value: true },
      // order 用浮点（真实壁纸拿它做细分排序）
      size: { order: 2.5, type: 'slider', value: 0.5, min: 0, max: 2, step: 0.05, precision: 2, text: 'Size' },
      // combo 选项值类型混用：必须原样保留（字符串化会让壁纸里的 === 失配）
      mode: { order: 3, type: 'combo', value: 1, options: [{ label: 'One', value: 1 }, { label: 'Two', value: '2' }] },
      tip: { order: 4, type: 'text', text: 'Section' },
      // 条件只影响面板显隐，值照常下发
      extra: { order: 5, type: 'bool', value: true, condition: 'fpslock.value == true' },
      // 作者标记「用户不可编辑」：面板隐藏，值照常下发
      internal: { order: 6, type: 'slider', value: 1, editable: false },
    },
    localization: { 'zh-chs': { tip: '分节标题', size: '尺寸' } },
  },
}));
writeFileSync(join(webDir, 'index.html'), [
  '<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>',
  '<link rel="stylesheet" href="style.css"></head>',
  '<body><div id="app"></div><script src="app.js"></script></body></html>',
].join('\n'));
writeFileSync(join(webDir, 'style.css'), '#app{color:#fff}');
writeFileSync(join(webDir, 'app.js'), 'window.__fixtureWeb=true;');
writeFileSync(join(webDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
process.env.DSH_WE_STEAM_ROOT = fixtureRoot;

const invRoute = routes.find((r) => r.path === '/wallpaper-engine/inventory');
const filesRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-files');
check('scene-files route registered', Boolean(filesRoute), filesRoute ? 'kind=' + filesRoute.kind : 'missing');
let fixture = null;
if (invRoute) {
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory', FENCE_HEADERS);
  const body = JSON.parse(res.__state.body.toString('utf8'));
  fixture = (body.wallpapers || []).find((w) => w.type === 'scene' && w.title === 'Live Fixture Scene') || null;
  check('fixture scene listed in inventory', Boolean(fixture), fixture ? fixture.id : 'not found');
  check('inventory marks fixture sceneLive=true with sceneLiveSrc',
    Boolean(fixture && fixture.sceneLive === true && typeof fixture.sceneLiveSrc === 'string' && fixture.sceneLiveSrc),
    fixture ? 'src len=' + String(fixture.sceneLiveSrc || '').length : '-');
  // 场景载荷的源由**宿主**给出（桌面形态下 = 自建媒体源的 origin）。这一条钉住"客户端
  // 不再自己拼 location.origin"的前提：宿主必须先把它端出来，空串才是"回落应用源"的合法值。
  check('inventory 给场景载荷端出宿主自己的源（sceneMediaBase）',
    typeof body.sceneMediaBase === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(body.sceneMediaBase || ''),
    'sceneMediaBase=' + (body.sceneMediaBase || '(空)'));
}
if (filesRoute && fixture && fixture.sceneLiveSrc) {
  const token = fixture.sceneLiveSrc;
  const pkgRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/scene.pkg`);
  check('scene.pkg 200 + octet-stream + byte-identical',
    pkgRes.__state.status === 200 && h(pkgRes, 'Content-Type') === 'application/octet-stream'
      && pkgRes.__state.body.equals(pkgBytes),
    'status=' + pkgRes.__state.status + ' ' + pkgRes.__state.body.length + 'B');

  const pjRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/project.json`);
  let pjOk = false;
  try { pjOk = pjRes.__state.status === 200 && JSON.parse(pjRes.__state.body.toString('utf8')).file === 'scene.pkg'; } catch { /* leave false */ }
  check('project.json 200 + parses', pjOk, 'status=' + pjRes.__state.status);

  const rangeRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/scene.pkg`, { range: 'bytes=0-99' });
  check('Range request → 206 + Content-Range + 100B',
    rangeRes.__state.status === 206 && /^bytes 0-99\//.test(h(rangeRes, 'Content-Range'))
      && rangeRes.__state.body.length === 100,
    'status=' + rangeRes.__state.status + ' ' + h(rangeRes, 'Content-Range'));

  // ── 大包的传输代价：可重验证缓存 + 载荷账本 ────────────────────────────────
  // 实测 `scene.pkg` 到 336MB，而每次重建 live 层都会重新拉一整遍；内容由 size+mtime
  // 唯一确定 ⇒ 给 ETag/Last-Modified（304 无体 = 复用手上的字节）。判据必须**两半都钉**：
  // ① 头在（缓存可用）；② 命中条件时真的 304 且零体（不是"带了头但仍然全量重传"）。
  const pkgEtag = h(pkgRes, 'ETag');
  const pkgCc = h(pkgRes, 'Cache-Control');
  check('scene.pkg 可重验证缓存（ETag + Last-Modified + must-revalidate，且**不是** no-store）',
    Boolean(pkgEtag) && Boolean(h(pkgRes, 'Last-Modified')) && /must-revalidate/.test(pkgCc) && !/no-store/.test(pkgCc),
    'etag=' + pkgEtag + ' cc=' + pkgCc);
  const notMod = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/scene.pkg`, { 'if-none-match': pkgEtag });
  check('条件 GET 命中 ⇒ 304 + 零体（真的省掉一次几百 MB 的读盘与传输）',
    notMod.__state.status === 304 && notMod.__state.body.length === 0,
    'status=' + notMod.__state.status + ' ' + notMod.__state.body.length + 'B');
  // 负对照：换一个 ETag ⇒ 必须回 200 全量（否则"凡带 if-none-match 就 304"也能过）
  const staleEtag = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/scene.pkg`, { 'if-none-match': 'W/"0-0"' });
  check('负对照：ETag 不匹配 ⇒ 200 全量（缓存判据有牙）',
    staleEtag.__state.status === 200 && staleEtag.__state.body.equals(pkgBytes),
    'status=' + staleEtag.__state.status + ' ' + staleEtag.__state.body.length + 'B');
  // 只带 If-Modified-Since（没有 ETag 的客户端）同样要能 304
  const imsRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/scene.pkg`, { 'if-modified-since': h(pkgRes, 'Last-Modified') });
  check('只带 If-Modified-Since ⇒ 同样 304 零体',
    imsRes.__state.status === 304 && imsRes.__state.body.length === 0,
    'status=' + imsRes.__state.status);
  // 目录围栏/404 这些**错误**响应仍必须 no-store（见下面 unknown token → 404 旁的判据）

  // ── 载荷传输账本（客户端首帧看护的"到底还在不在下载"）──────────────────────
  const progressRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-payload-progress');
  check('载荷进度路由已注册', Boolean(progressRoute), progressRoute ? 'kind=' + progressRoute.kind : 'missing');
  if (progressRoute) {
    const progRes = await runHandler(progressRoute, `/wallpaper-engine/scene-payload-progress?token=${encodeURIComponent(token)}`);
    let prog = null;
    try { prog = JSON.parse(progRes.__state.body.toString('utf8')); } catch { prog = null; }
    // 上面已经真的拉过整包（200 全量 + Range）⇒ 账本必须记下"传过多少字节、走完几次"。
    check('账本记下这次传输（served ≥ 整包字节、completed ≥ 1、active 归零）',
      Boolean(prog) && prog.ok === true && prog.served >= pkgBytes.length && prog.completed >= 1 && prog.active === 0,
      prog ? JSON.stringify(prog) : 'bad json');
    check('账本带上整包体积（客户端据此把预算按包大小放大）',
      Boolean(prog) && prog.size >= pkgBytes.length, prog ? 'size=' + prog.size : '-');
    const unknownProg = await runHandler(progressRoute, '/wallpaper-engine/scene-payload-progress?token=bm90LWEtdG9rZW4');
    let unknownBody = null;
    try { unknownBody = JSON.parse(unknownProg.__state.body.toString('utf8')); } catch { unknownBody = null; }
    check('未知 token ⇒ ok:false（"没记账" ≠ "没在动"，客户端据此回落墙钟）',
      Boolean(unknownBody) && unknownBody.ok === false, unknownBody ? JSON.stringify(unknownBody) : 'bad json');
    // 老宿主没有这条路由时客户端必须静默退回墙钟：这里只钉"路由缺失不是崩溃源"的判据形态
    check('负对照：账本对"零传输"的 token 不给假进展（served=0）',
      Boolean(unknownBody) && unknownBody.served === 0 && unknownBody.completed === 0,
      unknownBody ? 'served=' + unknownBody.served : '-');
  }

  // Fence: encoded parent hops aiming at a file OUTSIDE the wallpaper dir
  // (5 hops up from …/431960/990001 to the fixture root; literal ../ would be
  // normalised away by `new URL()` before the handler ever sees it).
  const fenceUrl = `/wallpaper-engine/scene-files/${token}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt`;
  const fenceRes = await runHandler(filesRoute, fenceUrl);
  check('encoded ../../ escape fenced (403)', fenceRes.__state.status === 403, 'status=' + fenceRes.__state.status);

  const unknownRes = await runHandler(filesRoute, '/wallpaper-engine/scene-files/bm90LWF0b2tlbg/scene.pkg');
  check('unknown token → 404', unknownRes.__state.status === 404, 'status=' + unknownRes.__state.status);
  // 负对照：可重验证缓存**不得**把错误响应也放行（否则 Electron 会缓存住 404 错误页，
  // 之后即使文件到位也一直显示旧错误文本 —— 那是这条缓存策略唯一的已知风险）。
  check('负对照：404 仍 no-store',
    /no-store/.test(h(unknownRes, 'Cache-Control') || ''), h(unknownRes, 'Cache-Control'));

  // ── 目录围栏的第二层：**字面围栏不认识链接** ────────────────────────────────
  // `resolve()` + `startsWith` 只挡 `..`，而 `serveFile` 会跟随链接 ⇒ 只有第一层时
  // 目标并没有被真正钉在壁纸目录里。上面那条 encoded-escape 测的是**第一层**（字面路径），
  // 这里测**第二层**（`lstatSync` 拒链接 + `realpathSync.native` 包含性），两层各一条。
  // 真实建链接：Windows 用 junction（**不需要**开发者模式 / 管理员，故这一层在 CI 的
  // windows-latest 上真有覆盖），POSIX 用 dir 链接；file 链接两边都要权限，建不出来就
  // **显式记为平台跳过** —— 绝不静默当成通过。
  const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  // (a) 最终组件是链接：普通文件名，字面路径完全在界内，只有链接它才越界。
  const fileLinkName = 'escape-link.pkg';
  let fileLinkMade = false;
  try { symlinkSync(secretPath, join(workshopDir, fileLinkName), 'file'); fileLinkMade = true; } catch { /* 平台不允许 */ }
  if (fileLinkMade) {
    const linkRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/${fileLinkName}`);
    const linkBody = linkRes.__state.body.toString('utf8');
    check('指向界外的**文件链接** ⇒ 403（且没有读出 secret.txt）',
      linkRes.__state.status === 403 && linkBody.indexOf('top-secret') === -1,
      'status=' + linkRes.__state.status);
  } else {
    console.log('  ~ 平台跳过：本机不允许创建文件符号链接（该层在此平台零覆盖）');
  }
  // (b) **中间目录**是链接：字面路径全在界内（没有 `..`），只有 realpath 能判出越界 ——
  // 这一条才是第二层的真牙齿：删掉 realpath 比对，它必然变红。
  const dirLinkName = 'escape-dir';
  let dirLinkMade = false;
  try { symlinkSync(fixtureRoot, join(workshopDir, dirLinkName), dirLinkType); dirLinkMade = true; } catch { /* 平台不允许 */ }
  if (dirLinkMade) {
    const viaDir = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/${dirLinkName}/secret.txt`);
    const viaBody = viaDir.__state.body.toString('utf8');
    check('中间目录是**指向界外的链接** ⇒ 403（字面路径全在界内，只有 realpath 判得出）',
      viaDir.__state.status === 403 && viaBody.indexOf('top-secret') === -1,
      'status=' + viaDir.__state.status);
    // 负对照（防空转）：同一目录里的**普通文件**照旧 200 ⇒ 上面两条 403 不是"一律拒绝"，
    // 新增的这一层没有把整个 /scene-files 变成 403。
    const plainRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/project.json`);
    check('负对照：同目录的普通文件不受新围栏影响（200）',
      plainRes.__state.status === 200, 'status=' + plainRes.__state.status);
  } else {
    console.log('  ~ 平台跳过：本机不允许创建目录链接 / junction（realpath 那层在此平台零覆盖）');
  }

  const nosubRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/`);
  check('missing subpath → 404', nosubRes.__state.status === 404, 'status=' + nosubRes.__state.status);
}

// ── Level C3: web wallpapers over /scene-files ──────────────────────────────
// The strict-sandbox web path needs three host duties: inject the vendored WE
// shim into the HTML entry, serve subresources with correct MIME types (a CSS
// file as application/octet-stream is rejected by the browser), and allow
// opaque-origin fetches via CORS.
{
  // 回归闸门：道具入口必须在**场景**壁纸上也在。踩过的坑：inventory 条目先展开
  // sceneFieldsFor 再展开 webFieldsFor，两者都返回 propsUrl，后者的 null 把场景
  // 的值盖掉 —— 表现就是「场景壁纸没有壁纸属性按钮」。
  const inv = JSON.parse((await runHandler(invRoute, '/wallpaper-engine/inventory', FENCE_HEADERS)).__state.body.toString('utf8'));
  const sc = (inv.wallpapers || []).find((w) => w.id === '990001') || null;
  check('场景壁纸也带 propsUrl（属性入口不被 web 分支覆盖）',
    Boolean(sc && sc.propsUrl && sc.propsUrl.indexOf('/props/') > 0),
    sc ? String(sc.propsUrl || '(空)').slice(0, 52) : 'scene not found');
}

console.log('Level C3 — web wallpaper files (shim injection / MIME / CORS)');
let mediaEntry = '';   // C4 复用：C3 里从 inventory 拿到的那条入口 URL
{
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory', FENCE_HEADERS);
  const body = JSON.parse(res.__state.body.toString('utf8'));
  const web = (body.wallpapers || []).find((w) => w.id === '990003') || null;
  check('web wallpaper listed with webLive + webLiveSrc',
    Boolean(web && web.webLive === true && web.webLiveSrc),
    web ? 'type=' + web.type + ' src=' + String(web.webLiveSrc || '').length + 'ch' : 'not found');
  // 入口 URL 必须是**媒体源绝对 URL**（host 自建的第二个 loopback 监听），
  // 而不是插件路由：Desktop 的能力头（x-dsh-desktop-renderer）栅栏拒绝不透明源
  //（严格沙箱 iframe）对插件路由的请求，网页壁纸载荷因此整体挪到我们自己的源；
  // 这条断言就是那次「网页壁纸全黑」事故的回归闸门。
  mediaEntry = String((web && web.webLiveSrc) || '');
  check('webLiveSrc 是媒体源绝对 URL（不再落回插件路由）',
    /^http:\/\/127\.0\.0\.1:\d+\/wallpaper-engine\/scene-files\//.test(mediaEntry),
    mediaEntry.slice(0, 76) || '(空)');
  if (web && web.webLiveSrc) {
    // 应用源挂载仍然存在（场景 pkg / 媒体源不可用时的回落）：去掉源后用同一条
    // 路径把同样的断言跑一遍，保证两处挂载行为一致。
    const entryUrl = mediaEntry.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    const baseUrl = entryUrl.replace(/\/[^/]*$/, '');
    const htmlRes = await runHandler(filesRoute, entryUrl);
    const html = htmlRes.__state.body.toString('utf8');
    check('HTML entry served with shim injected',
      htmlRes.__state.status === 200 && /text\/html/.test(h(htmlRes, 'Content-Type'))
        && html.indexOf('data-we-shim="host"') !== -1,
      'status=' + htmlRes.__state.status + ' shim=' + (html.indexOf('data-we-shim') !== -1));
    // 属性 seed：严格沙箱下渲染页读不到 iframe（无法运行时补推 __weApplyProps），
    // 属性只能由宿主随 HTML 注入 —— 漏掉它依赖属性的壁纸会画成默认（实测黑屏）。
    check('HTML entry carries the property seed from project.json',
      html.indexOf('data-we-seed="host"') !== -1 && html.indexOf('__weSeedProps') !== -1
        && html.indexOf('color0') !== -1,
      'seed=' + (html.indexOf('data-we-seed') !== -1));
    check('HTML entry advertises CORS for opaque origins',
      h(htmlRes, 'Access-Control-Allow-Origin') === '*', h(htmlRes, 'Access-Control-Allow-Origin'));
    const cssRes = await runHandler(filesRoute, `${baseUrl}/style.css`);
    check('stylesheet served as text/css (not octet-stream)',
      cssRes.__state.status === 200 && /text\/css/.test(h(cssRes, 'Content-Type')),
      h(cssRes, 'Content-Type'));
    const jsRes = await runHandler(filesRoute, `${baseUrl}/app.js`);
    check('script served as javascript',
      jsRes.__state.status === 200 && /javascript/.test(h(jsRes, 'Content-Type')),
      h(jsRes, 'Content-Type'));
  }
}

// ── Level C4: wallpaper media origin (real loopback listener) ───────────────
// C3 打的是 mock 出来的「应用源挂载」；这一层对**真实 socket** 打一轮：不透明源
//（Origin: null）能否取到入口、子资源 MIME、OPTIONS 预检、目录围栏、非本路由
// 404。Desktop 上网页壁纸能不能显示，完全取决于这个源。
console.log('Level C4 — 壁纸媒体源（真实 loopback 监听）');
{
  const moRoute = routes.find((r) => r.path === '/wallpaper-engine/media-origin');
  check('media-origin 诊断路由已注册', Boolean(moRoute));
  if (moRoute) {
    const moRes = await runHandler(moRoute, '/wallpaper-engine/media-origin');
    const mo = JSON.parse(moRes.__state.body.toString('utf8') || '{}');
    const base = String(mo.base || '');
    check('media-origin 上报可用源（127.0.0.1 + 随机端口）',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'base=' + (base || '(空)'));
    if (base && mediaEntry) {
      const entryPath = mediaEntry.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
      const dirPath = entryPath.replace(/\/[^/]*$/, '');
      // 不透明源（严格沙箱 iframe）真实发出的请求就长这样：Origin: null。
      const opaque = await fetch(base + entryPath, { headers: { Origin: 'null' }, cache: 'no-store' });
      const opaqueHtml = await opaque.text();
      check('Origin: null 下入口 HTML 200 + shim/seed 注入 + CORS *',
        opaque.status === 200 && opaque.headers.get('access-control-allow-origin') === '*'
          && opaqueHtml.indexOf('data-we-shim="host"') !== -1
          && opaqueHtml.indexOf('data-we-seed="host"') !== -1,
        'status=' + opaque.status + ' acao=' + opaque.headers.get('access-control-allow-origin'));
      // 载荷改成可重验证缓存之后，入口 HTML 必须**仍然** no-store：它带注入的
      // shim + 用户属性种子，缓存住 = 把旧种子喂给壁纸。
      const htmlCc = opaque.headers.get('cache-control') || '';
      check('入口 HTML 仍 no-store（可重验证缓存只放行载荷本身）', /no-store/.test(htmlCc), htmlCc);
      const css = await fetch(base + dirPath + '/style.css', { cache: 'no-store' });
      check('子资源经媒体源可达（text/css）',
        css.status === 200 && /text\/css/.test(css.headers.get('content-type') || ''),
        'status=' + css.status + ' ' + css.headers.get('content-type'));
      const pre = await fetch(base + entryPath, { method: 'OPTIONS', cache: 'no-store' });
      check('OPTIONS 预检放行（204 + ACAO *）',
        pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*',
        'status=' + pre.status + ' acao=' + pre.headers.get('access-control-allow-origin'));
      const fenced = await fetch(base + dirPath + '/%2e%2e%2f%2e%2e%2fsecret.txt', { cache: 'no-store' });
      const fencedBody = await fenced.text();
      check('媒体源同样受目录围栏保护（403 + 自解释体）',
        fenced.status === 403 && fencedBody.indexOf('forbidden-scene-files[') === 0,
        'status=' + fenced.status + ' body=' + fencedBody.slice(0, 32));
      const off = await fetch(base + '/wallpaper-engine/media-status', { cache: 'no-store' });
      check('媒体源只服务 /scene-files（其它路径 404）', off.status === 404, 'status=' + off.status);
      // ── 隐藏耦合：**mediaBase 同时是诊断信标的 origin** ─────────────────────────
      // 渲染页的 reportDiag() 打的是 `{mediaBase origin}/diag`（根路径，见 routes/diag.js
      // 引的 Kg()）。场景壁纸的 mediaBase 改成指向本媒体源之后，这个根路径若不在媒体源上
      // 也有落点，"大场景 pkg 首帧超时"时渲染页的告警会以 404 **静默丢掉** —— 而那正是
      // 排查现场唯一的内窗。所以这里对**真实 socket** 打一发信标，并要求它出现在
      // `/diag-log` 的**同一份**环形缓冲里（不是另起一份）。
      const beaconMsg = 'verify-scene-live: media-origin diag sink';
      const beacon = await fetch(base + '/diag?msg=' + encodeURIComponent(beaconMsg) + '&lvl=warn', { cache: 'no-store' });
      check('媒体源根路径 /diag 可达并收下信标（204）', beacon.status === 204, 'status=' + beacon.status);
      const logRoute = routes.find((r) => r.path === '/wallpaper-engine/diag-log');
      if (logRoute) {
        const logRes = await runHandler(logRoute, '/wallpaper-engine/diag-log', FENCE_HEADERS);
        let entries = [];
        try { entries = JSON.parse(logRes.__state.body.toString('utf8')).entries || []; } catch { /* 留空 = 判据变假 */ }
        check('媒体源上的告警落进**同一份**诊断缓冲（/diag-log 可回读）',
          entries.some((e) => String(e.msg || '').indexOf(beaconMsg) !== -1),
          'entries=' + entries.length);
        // 负对照（防空转）：没打过的信标不许被读到 ⇒ 上面那条不是"任何串都算命中"。
        check('负对照：未上报的信标读不到（判据不是恒真）',
          !entries.some((e) => String(e.msg || '').indexOf('never-reported-beacon') !== -1));
      } else {
        check('diag-log 路由已注册（否则上一条无从读取）', false, 'missing');
      }
    }
  }
}

// ── Level C5: 壁纸属性（project.json general.properties → 面板 / 种子）───────
// 「壁纸属性」面板读这条路由；写入走 settings（userProps），再由 buildSeedScript
// 并进 HTML 种子 —— 这里把整条链路验证到底。
console.log('Level C5 — 壁纸属性解析 / 覆盖值 → HTML 种子');
{
  const propsRoute = routes.find((r) => r.path === '/wallpaper-engine/props');
  const settingsRoute = routes.find((r) => r.path === '/wallpaper-engine/settings');
  check('props 路由已注册', Boolean(propsRoute));
  let token = '';
  {
    const inv = JSON.parse((await runHandler(invRoute, '/wallpaper-engine/inventory', FENCE_HEADERS)).__state.body.toString('utf8'));
    const web = (inv.wallpapers || []).find((w) => w.id === '990003') || null;
    token = String((web && web.propsUrl) || '').split('/').pop();
    check('inventory 给场景/网页壁纸带 propsUrl', Boolean(web && web.propsUrl), web ? String(web.propsUrl).slice(0, 48) : 'not found');
  }
  const pres = await runHandler(propsRoute, `/wallpaper-engine/props/${encodeURIComponent(token)}`);
  const pdata = JSON.parse(pres.__state.body.toString('utf8') || '{}');
  const byName = Object.fromEntries((pdata.props || []).map((p) => [p.name, p]));
  check('属性面板数据可取（含全部类型）',
    pres.__state.status === 200 && pdata.ok === true && (pdata.props || []).length === 6,
    'count=' + ((pdata.props || []).length) + ' status=' + pres.__state.status);
  check('editable:false 从面板隐藏（值照常下发）', !byName.internal);
  check('order 按浮点排序（2.5 落在 2 与 3 之间）',
    (pdata.props || []).map((p) => p.name).join(',') === 'color0,fpslock,size,mode,tip,extra',
    (pdata.props || []).map((p) => p.name).join(','));
  check('slider 带 min/max/step/precision',
    byName.size && byName.size.min === 0 && byName.size.max === 2 && byName.size.step === 0.05 && byName.size.precision === 2);
  check('combo 选项保留声明类型（数字 / 字符串混用）',
    byName.mode && byName.mode.options[0].value === 1 && byName.mode.options[1].value === '2',
    byName.mode ? JSON.stringify(byName.mode.options.map((o) => o.value)) : 'missing');
  check('文案逐键本地化回退 zh-chs',
    byName.size && byName.size.text === '尺寸' && byName.tip && byName.tip.text === '分节标题',
    byName.size ? byName.size.text : 'missing');
  check('text 类型是静态说明（无值）', byName.tip && byName.tip.value === null);
  check('condition 只随定义带出（面板按当前值求值）', byName.extra && byName.extra.condition === 'fpslock.value == true');

  // 覆盖值 → 种子：PUT 设置后，同一份 HTML 应当带上被改过的值
  const entryPath = '/wallpaper-engine/scene-files/' + token + '/index.html';
  const putRes = fakeRes();
  await settingsRoute.handler(fakeReqBody('/wallpaper-engine/settings', 'PUT', {
    userProps: { [token]: { color0: '0 1 0', size: 1.25 } },
  }), putRes);
  await waitRes(putRes);   // 「响应即已持久化」：等应答再读种子
  check('设置接受 userProps 覆盖值（白名单）', putRes.__state.status === 200, 'status=' + putRes.__state.status);
  const html2 = (await runHandler(filesRoute, entryPath)).__state.body.toString('utf8');
  check('覆盖值并进 HTML 种子（host 侧合并，网页壁纸不闪默认值）',
    html2.includes('__weSeedProps') && html2.includes('0 1 0') && html2.includes('1.25'),
    'seed=' + html2.includes('__weSeedProps'));
  const pdata2 = JSON.parse((await runHandler(propsRoute, `/wallpaper-engine/props/${encodeURIComponent(token)}`)).__state.body.toString('utf8'));
  const byName2 = Object.fromEntries((pdata2.props || []).map((p) => [p.name, p]));
  check('覆盖值在面板数据里标记为 overridden',
    byName2.color0 && byName2.color0.overridden === true && byName2.color0.value === '0 1 0');
  // 还原（同一份临时 config 后续断言还用它）
  const putBack = fakeRes();
  await settingsRoute.handler(fakeReqBody('/wallpaper-engine/settings', 'PUT', { userProps: {} }), putBack);
  await waitRes(putBack);
  const html3 = (await runHandler(filesRoute, entryPath)).__state.body.toString('utf8');
  check('清空覆盖值后种子回到默认（1 0 0）',
    html3.includes('1 0 0') && !html3.includes('0 1 0'));
}

// ── Level C2: custom storage (uploads) — WE project directories ─────────────
// The reported bug: pointing 存储位置 at a WallpaperEM-style downloads folder
// found none of its scene wallpapers (the old scanner only matched `up-*.ext`
// single files). The fixture (created before import) holds one WE project dir
// plus one legacy single-file upload.
console.log('Level C2 — custom storage scan (WE project dirs under uploads)');
{
  const sceneFrameRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame');
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory', FENCE_HEADERS);
  const body = JSON.parse(res.__state.body.toString('utf8'));
  const dirScene = (body.wallpapers || []).find((w) => w.id === 'up-dir-my-scene-1') || null;
  check('uploads WE project dir listed as scene', Boolean(dirScene), dirScene ? dirScene.type : 'not found');
  check('custom-storage scene takes its project.json title',
    Boolean(dirScene && dirScene.title === 'Custom Dir Scene'), dirScene ? dirScene.title : '-');
  check('custom-storage scene marked sceneLive + sceneLiveSrc',
    Boolean(dirScene && dirScene.sceneLive === true && dirScene.sceneLiveSrc),
    dirScene ? 'src len=' + String(dirScene.sceneLiveSrc || '').length : '-');
  // 回归：目录形态的上传必须把作者配色带进 inventory（见夹具里 schemecolor 的注释）。
  // 值走的是与 Steam 扫描同一条 schemeToCss（0–1 浮点三元组 → rgb()）。
  check('custom-storage scene carries the author scheme color (regression)',
    Boolean(dirScene && dirScene.schemeColor === 'rgb(29, 56, 84)'),
    dirScene ? String(dirScene.schemeColor) : '-');
  check('custom-storage scene has frameUrl + preview',
    Boolean(dirScene && dirScene.frameUrl && dirScene.preview),
    dirScene ? 'frameUrl=' + Boolean(dirScene.frameUrl) + ' preview=' + Boolean(dirScene.preview) : '-');
  const fileUp = (body.wallpapers || []).find((w) => w.id === 'up-fixture-image') || null;
  check('single-file upload still scanned alongside',
    Boolean(fileUp && fileUp.type === 'image' && fileUp.playable === true),
    fileUp ? fileUp.type + ' playable=' + fileUp.playable : 'not found');

  if (dirScene && dirScene.sceneLiveSrc) {
    const pkgRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${dirScene.sceneLiveSrc}/scene.pkg`);
    check('custom-storage scene.pkg served via /scene-files',
      pkgRes.__state.status === 200 && pkgRes.__state.body.length > 1000,
      'status=' + pkgRes.__state.status + ' ' + pkgRes.__state.body.length + 'B');
  }
  if (dirScene && dirScene.frameUrl && sceneFrameRoute) {
    const frameRes = await runHandler(sceneFrameRoute, dirScene.frameUrl);
    // P2-12 之后 `/scene-frame` 只剩「实时抓帧 → 自定义画面 → 空」三级：这个 fixture 既没被
    // 抓过帧、也没导入自定义画面 ⇒ 必须是**诚实的空态**（404），而不是"替作者猜一张图"
    //（旧语义会在这里 CPU 解包一张静态帧并回 200）。
    check('custom-storage scene frame：无抓帧且无自定义画面 ⇒ 404 空态（不猜图）',
      frameRes.__state.status === 404,
      'status=' + frameRes.__state.status + ' ' + frameRes.__state.body.length + 'B');
  }
}

// ── Level D: client source contract ─────────────────────────────────────────
console.log('Level D — client source wiring (src/client.js + 抽出的模块)');
// 客户端源码现在是**三个文件**：逻辑（src/client.js）、注入的样式表（src/styles.js）、
// 实时渲染管线（src/live-layer.js）。Level D 的判据里既有 JS 结构断言、也有样式规则断言、
// 还有"跨文件的接线"断言（如"面板调用 + 被调函数里的门禁"）—— 所以三个来源都读出来，
// **各自用在对应的判据上**（不图省事拼成一个字符串：那样一个文件的文本就能满足另一个文件的
// 结构断言，判据会失去牙）。
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8');
const stylesSrc = readFileSync(join(root, 'src', 'styles.js'), 'utf8');
const liveSrc = readFileSync(join(root, 'src', 'live-layer.js'), 'utf8');
const prepSrc = readFileSync(join(root, 'src', 'media-prep.js'), 'utf8');
const tabsSrc = readFileSync(join(root, 'src', 'panel-tabs.js'), 'utf8');
/** `function name() { … }` 的函数体源码（用于按内容而非脆弱的跨行正则断言）。 */
function fnBody(source, name) {
  const i = source.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = source.indexOf('\n}', i);
  return j < 0 ? source.slice(i) : source.slice(i, j);
}
// resolveWallpaperFadeBg 自 P1-7 后半起住在 src/effects.js —— 断言改读该模块
// （函数体判据本身不变；同时钉住它**不在** src/client.js，防两边各留一份）。
const effectsSrc = readFileSync(join(root, 'src', 'effects.js'), 'utf8');
const fadeBgBody = fnBody(effectsSrc, 'resolveWallpaperFadeBg');
check('效果应用层已抽成独立模块并被内联',
  effectsSrc.includes('function applyEffects()') && effectsSrc.includes('function clearEffects()')
    && readFileSync(join(root, 'lib', 'client.js'), 'utf8').includes('function applyEffects()')
    && !src.includes('function applyEffects()'));
const clientChecks = [
  // live 优先与 sceneVideo 让位都发生在 **buildMedia** 里（已抽到 media-prep.js）。
  ['live is the top priority for scenes and web', /const isLive = \(sel\.type === "scene" \|\| sel\.type === "web"\) && liveRenderEnabled\(sel\)/.test(prepSrc)],
  ['sceneVideo yields to live', /Boolean\(sel\.sceneVideo\) && !isLive/.test(prepSrc)],
  ['web wallpapers force the strict sandbox', /webSandbox=strict/.test(liveSrc)],
  ['heartbeat watchdog exists', /function startLiveWatch/.test(liveSrc) && /LIVE_FIRST_FRAME_MS/.test(liveSrc)],
  ['failure memory persists', /sceneLiveFailures/.test(tabsSrc) && /function liveFail/.test(liveSrc)],
  ['audio mux honours live', /!selLike\.sceneLiveActive/.test(src)],
  ['syncLayers key carries live state', /"live\\u0000" \+ \(selection\.sceneLiveSrc \|\| selection\.webLiveSrc\)/.test(liveSrc)],
  // sceneVideo 只在**非 live** 形态下进 key：live 生效时 buildMedia 已把 isSceneVideo
  // 短路，把 sceneVideo 算进 key 会让「sceneVideo 诚实化的时序补拉」
  //（scheduleSceneVideoResync 落地时 sceneVideo 由 null 变 URL）在 live 播放中
  // 冷启动一次渲染页 —— 无意义重建，用户会看到画面重新加载。
  ['sceneVideo stays out of the layer key while live renders',
    /\(layerLive \? "" : \(selection\.sceneVideo \|\| ""\)\)/.test(liveSrc)],
  // 垫底静态帧是 iframe 的**下层**：只要 iframe 半透明（壁纸透明度一高），它就会以
  // a(1−a) 的强度透出来（实测「壁纸透明度高时显现静态帧」）。首帧点亮后必须整块退场，
  // 且必须**串行**——延迟到 iframe 淡入（1.8s）完成后再快收。若退回与 iframe 同步
  // 双淡出，两个半透明层互换会让黑底在中点漏出 ~25%（层底是原生纯黑/纯白），实测
  // 症状「切换完成后整屏呼吸式变暗后恢复」会复发。
  ['the static-frame underlay retires once the live frame is on',
    /:has\(\.we-live-iframe\.we-live-on\) \.we-live-poster\s*\{[^}]*opacity:\s*0/.test(stylesSrc)
    && /:has\(\.we-live-iframe\.we-live-on\) \.we-live-poster\s*\{[^}]*transition:\s*opacity\s+0\.3s\s+ease\s+1\.8s/.test(stylesSrc)],
  // 淡出底色必须是**原生外观**（纯黑/纯白），不能是主题面板色 —— 否则拉高「壁纸
  // 透明度」会露出一块与原生外观不符的主题色（用户实测反馈）。
  ['the wallpaper fade base is the native black/white, not the panel token',
    fadeBgBody.includes('--dsw-alias-bg-base')
    && /"#000000" : "#ffffff"/.test(fadeBgBody)
    && !fadeBgBody.includes('--dsw-alias-bg-layer-1')],
  // 画面来源选项的三条门禁：
  // - 「壁纸画面刷新」换的是 **CPU 静态帧**，实时画面在跑时它没有任何作用 → 只在
  //   live 未生效时渲染；
  // - 「实时帧」（GPU 抓帧：重新截 / 清除 / 微缩预览）与「自定义画面」**live 开着时
  //   同样显示** —— 那张静帧正是切换途中与 live 首帧前给用户看的画面，构图不对时
  //   必须能立刻重抓，而不是先关掉实时渲染；导入截图与 live 也互不干扰。
  ['CPU frame-variant row shows only while live is not effective',
    /sel\.type === "scene" && sel\.sceneFrameUrl && !liveRenderEnabled\(sel\)/.test(tabsSrc)],
  ['live-frame (GPU capture) row is NOT gated on the live switch',
    /sceneWithFrame && \(gpuPinnedHere \|\| liveRenderEnabled\(sel\)\)/.test(tabsSrc)],
  ['custom-frame row is NOT gated on the live switch',
    /sel\.type === "scene" && React\.createElement\("div", \{ className: "we-picker__ctl" \}/.test(tabsSrc)],
  // 「重新截」= force 重抓：必须走「先抓帧 + 内容门禁 → 成功后才清旧帧」的安全顺序，
  // 抓不到时不许把原来那张删掉（面板上给失败原因）。
  ['manual re-capture forces a fresh capture through the safe path',
    // 跨文件接线：面板（client.js）发起 force 重抓；"先抓帧 + 内容门禁 → 成功后才清旧帧"
    // 的安全顺序在被调的 scheduleLiveFrameBackfill 里（live-layer.js）。
    /scheduleLiveFrameBackfill\(live, \{ force: true \}\)/.test(src)
    && /const stale = force \|\| \(hasGpu && arRef > 0/.test(liveSrc)],
  // 微缩预览必须指向层里正在用的那个 URL（同档位）+ 缓存破坏参数。
  ['frame preview points at the live layer URL',
    /function framePreviewSrc\(selLike\)[\s\S]{0,500}?frameUrlWithVariant\(selLike && selLike\.sceneFrameUrl, v\)[\s\S]{0,200}?we-prev=/.test(src)],
  ['pointer injection wired', /__wp\.pushPointer|wp\.pushPointer/.test(liveSrc) && /pointerLeave/.test(liveSrc)],
  ['fit mapping table present', /SCENE_LIVE_FIT = \{ cover: "cover"/.test(liveSrc)],
  // **实测**：渲染页 resume() 会 resetFrameMeter，心跳若每秒无条件调 resume 会永远读到
  // fps=0 → 15s 误降级。控制必须去重下发，且 tick 内先读统计再应用控制。
  ['controls are deduped before dispatch', /liveApplied\.playing !== playing/.test(liveSrc)],
  ['heartbeat reads stats before applying controls', /const stats = liveStats\(frame\);\s*\n\s*applyLiveControls\(frame\);/.test(liveSrc)],
  ['upload management list excludes project dirs', /isUploadedWallpaper\(w\) && !isDirWallpaper\(w\)/.test(src)],
  // 帧率取证（「限了 30 还卡」时唯一能分清「壁纸自身掉帧」与「整页掉帧」的手段）
  ['live fps probe reports ui / web / rnd to the diag channel',
    liveSrc.includes('function reportLiveFps') && liveSrc.includes('"live-fps"')
      && liveSrc.includes('function takeUiFps') && liveSrc.includes('wstate.webFps')],
  // 网页壁纸的 src 直用 host 给的绝对 URL（媒体源）；相对形态仅作回落。
  ['web live src reuses the absolute media-origin URL', liveSrc.includes('const webEntry = String(selLike.webLiveSrc || "")')
    && liveSrc.includes('/^https?:\\/\\//i.test(webEntry)')],
  // **实测**症状：「场景类壁纸正常几秒就失效」「网页也是」「失效以后是静态的」
  // 「只有扩展模式」「网页类是预览图」。成因是 extended 的「首帧后延迟 8000ms 换元」自救：
  // 换元后的新元素为防白闪被摘掉 `we-live-on`，层回落垫底图（场景=静态帧、网页=预览图），
  // 而渲染页照旧出声；日志上 first-frame-ok 后**正好 +8s** 出现 live-frame-rebuilt。
  // 该 workaround 的前提（启动期 iframe 永不上屏）已不成立 ⇒ 改成 **opt-in**。
  ['extended frame swap is opt-in (default off) — it is the "几秒后失效" 病因',
    /function useExtendedFrameSwap\(\)/.test(liveSrc)
    && /extendedFrameSwap = String\(rawFlag\)\.toLowerCase\(\) === "1";/.test(liveSrc)
    && /if \(desktopWindowMode\(\) === "extended" && !liveFrameRebuildTimer && useExtendedFrameSwap\(\)\) \{/.test(liveSrc)],
];
for (const [name, ok] of clientChecks) check(name, ok);
// 负对照：**没有开关的**换元调用点（旧写法）喂给同一判据必须被判不合格 —— 否则这条断言
// 只要文件里出现 `we-ext-swap` 字样就会通过，等于没有牙。
{
  const swapIsOptIn = (s) => /if \(desktopWindowMode\(\) === "extended" && !liveFrameRebuildTimer && useExtendedFrameSwap\(\)\) \{/.test(s);
  const ungated = 'if (desktopWindowMode() === "extended" && !liveFrameRebuildTimer) {';
  check('negative control: the ungated extended swap call site is rejected', swapIsOptIn(ungated) === false);
  check('positive control: the current client gates the extended swap', swapIsOptIn(liveSrc) === true);
}
// ── Level D3: 首帧看护的"按进展判超时" + 载荷延迟/暂停 + 失败分因（2026-09 大包事故）──
// 现场（本机真实诊断日志）：320MB/94MB 的 `scene.pkg` 在**三个客户端实例**同时挂载时
// 传输被饿死，可见那个实例 15s 后 `stats={"fps":0,"running":false}`（一帧都没出）→ 被判
// 「首帧超时」并写进**共享**失败记忆（所有窗口一起降级），而渲染器单独跑同一份包只要 1–2s。
// 四条修正各配一条判据 + 负对照；判据只看真实代码行（注释由共享 stripComments 剥掉）。
{
  const code = stripComments(liveSrc);
  // ① 预算由包大小放大 + 有硬上限（不是固定 15s 墙钟）
  check('首帧预算按 scenePkgBytes 放大，且封顶 LIVE_FIRST_FRAME_MAX_MS',
    /function liveFirstFrameBudget\(/.test(code) && /scenePkgBytes/.test(code)
      && /Math\.min\(LIVE_FIRST_FRAME_MAX_MS, scaled\)/.test(code)
      && /const LIVE_FIRST_FRAME_MAX_MS = \d+/.test(code));
  // ② 传输有进展 ⇒ 每拍重置计时（与"暂停期不计时"同一条纪律）
  check('载荷有进展就不计超时（loadingTicks + startedAt 重置）',
    /if \(livePayloadFlowing\(watch\)\) \{\s*\n\s*watch\.loadingTicks \+= 1;\s*\n\s*watch\.startedAt = Date\.now\(\);/.test(code)
      && /function livePayloadFlowing\(watch\)/.test(code)
      && /LIVE_PAYLOAD_STALL_MS/.test(code));
  // ③ 账本未知（旧宿主 / 没记过账）⇒ 退回墙钟，绝不把"没记账"当"没在动"
  check('账本未知一律退回墙钟（ok:false / 请求失败都当未知）',
    /d\.ok !== true\) \{ watch\.payload = null; return; \}/.test(code)
    && /\.catch\(\(\) => \{ watch\.payloadPolling = false; \}\)/.test(code)
    && /SCENE_PAYLOAD_PROGRESS_PATH/.test(code));
  // ④ 隐藏/不播时不拉载荷：建层延迟 + 中途摘 src + 可见时补回（三条都在）
  check('隐藏/不播的实例不拉载荷（建层延迟 + 中途暂停 + 可见时补回）',
    /if \(liveFrameShouldDefer\(\)\) \{\s*\n\s*frame\.dataset\.weLiveSrc = url;/.test(code)
      && /function suspendLivePayload\(frame, watch\)/.test(code)
      && /frame\.src = "about:blank";/.test(code)
      && /function armDeferredLiveFrame\(frame\)/.test(code)
      && /armDeferredLiveFrame\(liveFrame\);/.test(code));
  // ⑤ 延迟载荷的帧不得被"空白文档的 load"武装心跳（那会白烧一个预算窗口 → 误判超时）
  check('空白文档（载荷暂停）不武装心跳：load 与三处直接武装都过 liveFrameDeferred',
    /if \(frame\.isConnected && !liveFrameDeferred\(frame\)\) startLiveWatch\(frame, sel\.id\);/.test(code)
      && /if \(!liveFrameDeferred\(frame\)\) \{ try \{ startLiveWatch\(frame, sel\.id\); \} catch/.test(code)
      && (code.match(/!liveFrameDeferred\(/g) || []).length >= 4);
  // ⑥ 失败分因：传输未完成只进会话内软记忆 + 自动重试，**不写共享设置**
  check('传输类失败不落盘（liveSessionFailures + 自动重试 + 冷却/上限）',
    /function liveFailCauseOf\(watch\)/.test(code)
      && /if \(p\.active > 0\) return "transfer";/.test(code)
      && /if \(p\.completed <= 0\) return "transfer";/.test(code)
      && /if \(p\.transfers <= 0\) return "";/.test(code)
      && /liveSessionFailures\.set\(wid, "transfer"\)/.test(code)
      && /function scheduleLiveTransferRetry\(wid, attempts\)/.test(code)
      && /LIVE_TRANSFER_RETRY_LIMIT/.test(code)
      && /LIVE_TRANSFER_RETRY_DELAY_MS/.test(code));
  check('出首帧即清软失败与重试计数（否则一次抖动会永久压着这张壁纸）',
    /liveSessionFailures\.delete\(watch\.wid\);/.test(code) && /liveTransferAttempts\.delete\(watch\.wid\);/.test(code));
  // ⑦ 层键带 mediaBase：宿主把媒体源端出来之后必须重建（否则旧渲染页一直用陈旧的源）
  check('层键含 sceneMediaBase（源变化 ⇒ 重建到媒体源）',
    /selection\.inventory\.sceneMediaBase\) \|\| ""\)/.test(code));
  // ⑧ 软失败重试前刷库存（本实例的 inventory 可能粘在"媒体源起来之前"的空串上）
  check('软失败重试前刷库存（粘住的空串是传输饿死的常见成因）',
    /if \(!\(selection\.inventory && selection\.inventory\.sceneMediaBase\)\) \{\s*\n\s*try \{ loadInventory\(\); \}/.test(code));
  // ⑨ client-boot 必须延迟一拍（顶层读 selection 会撞 TDZ，实测 0 行落盘）
  check('client-boot 延迟一拍上报（顶层读 selection 会被 TDZ 静默吞掉）',
    /setTimeout\(function \(\) \{\s*\n\s*try \{\s*\n\s*liveLog\("client-boot"/.test(code));
  // ⑩ 显式重试（面板重开开关）必须把会话内软失败一起清掉 —— 否则「重开开关可重试」
  //    这条逃生门对传输类失败不成立（它不在设置里，页面上看不见却拦着 live）。
  check('显式重试同时清会话内软失败（跨文件接线：面板 → clearLiveSessionFailures）',
    /function clearLiveSessionFailures\(\)/.test(code)
      && /liveSessionFailures\.clear\(\)/.test(code)
      && /clearLiveSessionFailures\(\);/.test(tabsSrc));
  // ⑪ 失败记忆的**管线身份**：旧管线的 timeout 断言不许跨管线复用 —— 它是面板那行
  //    「实时渲染失败（…）」的唯一来源，实测会让"宿主半没重载 + 客户端已更新"看起来毫无作用。
  check('失败记忆带管线身份，换管线作废一次（bundle 变 / 媒体源从无到有）',
    /function migrateStaleLiveFailures\(\)/.test(code)
      && /migrateStaleLiveFailures\(\);/.test(code)
      && /function livePipelineChanged\(\)/.test(code)
      && /String\(prev\.build \|\| ""\) !== now\.build\) return "build"/.test(code)
      && /Number\(prev\.media\) === 0 && now\.media === 1\) return "media"/.test(code)
      && /rememberLivePipeline\(\)/.test(code)
      && /LIVE_DIAG_BUILD = "d8"/.test(code));
  // 记录失败时必须**记住管线身份**，否则下次启动会把这条管线自己挣来的记忆当陌生管线清掉。
  check('记录失败时写下管线身份（否则自己的记忆会被下一次启动清掉）',
    /map\[wid\] = reason === "stall" \? "stall" : "timeout";[\s\S]{0,400}?rememberLivePipeline\(\);/.test(code));
  // 负对照：把"单向"改成双向（媒体源消失也清）⇒ 同一条判据变假。
  const oneWayPredicate = (s) => /Number\(prev\.media\) === 0 && now\.media === 1\) return "media"/.test(s)
    && !/Number\(prev\.media\) === 1 && now\.media === 0/.test(s);
  const twoWay = code.replace('Number(prev.media) === 0 && now.media === 1',
    'Number(prev.media) === 1 && now.media === 0');
  check('负对照：把单向判据改成双向（源一抖动就抹掉真实失败记忆）会被判红',
    twoWay !== code && oneWayPredicate(twoWay) === false && oneWayPredicate(code) === true);
  // 负对照：把"按进展重置"那两行换成旧的固定墙钟写法 ⇒ 同一条判据变假
  const flowingOk = (s) => /if \(livePayloadFlowing\(watch\)\) \{\s*\n\s*watch\.loadingTicks \+= 1;/.test(s);
  const degraded = code.replace(/if \(livePayloadFlowing\(watch\)\) \{\s*\n\s*watch\.loadingTicks \+= 1;\s*\n\s*watch\.startedAt = Date\.now\(\);\s*\n\s*\}/,
    '/* 旧写法：照常计时 */');
  check('负对照：退回固定墙钟（不看进展）会被同一条判据判红',
    degraded !== code && flowingOk(degraded) === false && flowingOk(code) === true);
}
// ── Level D2: 实时管线抽模块的结构契约（抽出来之后钉住）─────────────────────
// 契约的可核对形式：
//   · 管线**只在 live-layer.js 里**（client.js 不得再留一份同名实现）；
//   · 它对 client.js 的跨模块**写**为零 —— 唯一一处曾被外部翻转的状态（liveDiagOn）
//     必须走 toggleLiveDiag() 入口；
//   · 必须登记进 INLINE_MODULES **且真的进了产物**（防孤儿：文件在却不进 bundle）。
{
  const build = readFileSync(join(root, 'scripts', 'build-client.mjs'), 'utf8');
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
  const MOVED = ['function startLiveWatch(', 'function syncLayers()', 'function scheduleLiveFrameBackfill(',
    'function liveLog(', 'function createLiveFrame('];
  const stillInClient = MOVED.filter((m) => src.includes(m));
  check('实时管线只在 src/live-layer.js（client.js 不留第二份）', stillInClient.length === 0,
    stillInClient.join(' ') || '搬走了 ' + MOVED.length + ' 个入口');
  check('client.js 对管线状态零跨模块写（liveDiagOn 必须走入口）',
    !/^\s*liveDiagOn\s*=/m.test(src) && !/^\s*liveDiagOn\s*=/m.test(tabsSrc)
    && /toggleLiveDiag\(\)/.test(tabsSrc));
  check('live-layer.js 已登记进 INLINE_MODULES 且在产物里只有一份',
    /file:\s*'src\/live-layer\.js'/.test(build)
    && (bundle.match(/function syncLayers\(\)/g) || []).length === 1);
  check('negative control: 未登记的模块名会被判出', !/file:\s*'src\/nope\.js'/.test(build));
  // ── 面板页签（C）：渲染器只在 panel-tabs.js，且**只从一个参数取外界** ──
  const TAB_FNS = ['renderWallpaperTab', 'renderAppearanceTab', 'renderAudioTab',
    'renderMascotTab', 'renderEffectsTab', 'renderAdvancedTab'];
  check('页签渲染器只在 src/panel-tabs.js（client.js 不留第二份）',
    TAB_FNS.every((n) => !new RegExp('function ' + n + '\\s*\\(').test(src))
    && TAB_FNS.every((n) => tabsSrc.includes('function ' + n + '(ctx) {')));
  // 每个渲染器的**首行**必须是 `const { … } = ctx;` —— "要什么"写在签名处，
  // 而不是靠闭包默默捕获（这正是这一刀的意义；也防止后来人图省事把捕获加回去）。
  const tabBodies = tabsSrc.split(/^  function (render\w+Tab)\(ctx\) \{$/m).slice(1);
  const noCtxLine = [];
  for (let i = 0; i < tabBodies.length; i += 2) {
    const fn = tabBodies[i], body = tabBodies[i + 1] || '';
    if (!/^\s*\n\s*const \{[^}]*\} = ctx;/.test(body)) noCtxLine.push(fn);
  }
  check('每个页签首行都从 ctx 解构（不许再靠闭包捕获）', noCtxLine.length === 0,
    noCtxLine.join(' ') || TAB_FNS.length + ' 个页签都显式取外界');
  check('panel-tabs.js 已登记进 INLINE_MODULES 且在产物里只有一份',
    /file:\s*'src\/panel-tabs\.js'/.test(build)
    && (bundle.match(/function renderEffectsTab\(ctx\)/g) || []).length === 1);
}

// **实测**：host 的 sanitizeSettings 是白名单，漏加 sceneLiveFailures 会让 PUT 上来的
// 失败记忆被丢弃、刷新后记忆消失。
// ── Level E: 三条此前"守卫零提及"的宿主路由（P2-11 前置 2）──────────────────
// 补守卫之前，`docs/ROUTE-INDEX.md` 把这三条标成 **0 提及**（该节现已收缩为「（无）」）⇒ 拆分
// `apply(ctx)` 之前必须补上真实行为断言，否则动它们等于没有安全网。三条都只断言**无副作用的
// 失败路径**：不写宿主持久化配置、不落盘、不依赖本机是否真有封面（否则 CI 会随环境飘）。
{
  const byPath = (p) => routes.find((r) => r.path === '/wallpaper-engine' + p);
  const clientDiag = byPath('/client-diag');
  const uploadDir = byPath('/upload-dir');
  const artwork = byPath('/now-playing/artwork');
  check('/client-diag 已注册（kind=exact）', Boolean(clientDiag) && clientDiag.kind === 'exact');
  check('/upload-dir 已注册（kind=exact）', Boolean(uploadDir) && uploadDir.kind === 'exact');
  check('/now-playing/artwork 已注册（kind=exact）', Boolean(artwork) && artwork.kind === 'exact');
  if (clientDiag) {
    const wrongMethod = await runHandler(clientDiag, '/wallpaper-engine/client-diag', {});
    check('/client-diag 非 POST ⇒ 405（早退，不落盘）', wrongMethod.__state.status === 405,
      'status=' + wrongMethod.__state.status);
    // 超限体 ⇒ 413：与客户端半的 64KB 上限对齐，同时钉住"不会把大体读进内存"。
    const big = Readable.from([Buffer.alloc(70 * 1024, 0x41)]);
    big.url = '/wallpaper-engine/client-diag';
    big.method = 'POST';
    big.headers = { 'content-type': 'application/json' };
    const resBig = fakeRes();
    clientDiag.handler(big, resBig);
    await waitRes(resBig);
    check('/client-diag 超 64KB ⇒ 413', resBig.__state.status === 413, 'status=' + resBig.__state.status);
  }
  if (uploadDir) {
    const wrongMethod = await runHandler(uploadDir, '/wallpaper-engine/upload-dir', {});
    check('/upload-dir 非 POST ⇒ 405（不改宿主持久化配置）', wrongMethod.__state.status === 405,
      'status=' + wrongMethod.__state.status);
  }
  if (artwork) {
    const r = await runHandler(artwork, '/wallpaper-engine/now-playing/artwork', {});
    const st = r.__state.status;
    check('/now-playing/artwork 无封面 ⇒ 404 no-artwork；有封面 ⇒ 2xx（绝不 5xx）',
      (st === 404 && r.__state.body.toString('utf8') === 'no-artwork') || (st >= 200 && st < 300),
      'status=' + st);
  }
}

const hostSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
/**
 * 宿主半的**全部注册面** = `lib/index.js` + `lib/routes/*.js`。
 * 路由族拆出 `apply(ctx)` 是 P2-11 的正常动作 ⇒ 凡断言"宿主仍实现某契约"的判据必须覆盖那个目录，
 * 否则"已搬走"会被误报成"契约丢了"。⚠️ 反过来，断言"某路由**已不在正文**"（如 /diag）的判据
 * 必须继续只用 `hostSrc` —— 拿扩面集合去检查"不在"，会把搬走的代码判成还在。
 */
const hostHalfSrc = [hostSrc, ...readdirSync(join(root, 'lib', 'routes')).filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(root, 'lib', 'routes', f), 'utf8'))].join('\n');
// 宿主设置白名单已改为**派生**（唯一真源 lib/settings-schema.js，P1-5）。因此这几条不再
// 抠实现里的字面量，而是把值喂给宿主的规范化函数看它收不收 —— 断言的是**行为**。
const schemaMod = await import(pathToFileURL(join(root, 'lib', 'settings-schema.js')).href);
const sanitizeHost = (raw0) => schemaMod.sanitizeFromSchema(raw0, 'host');
const hostKeeps = (k, v) => JSON.stringify(sanitizeHost({ [k]: v })[k]) === JSON.stringify(v);
check('host settings whitelist keeps sceneLiveFailures', hostKeeps('sceneLiveFailures', { w1: 'timeout' }));
check('host injects the vendored shim into web HTML', /data-we-shim="host"/.test(hostSrc) && /readWebShim\(\)/.test(hostSrc));
check('host sends CORS for opaque-origin fetches', /Access-Control-Allow-Origin', '\*'/.test(hostSrc));
check('inventory derives webLive via webFieldsFor', /webFieldsFor\(w, hasMedia, webMediaBase\)/.test(hostSrc));
// 黑屏事故的**成因**：Desktop 的能力头栅栏（**外部宿主** `@deepseek-ai/dsh-host-webserver`
// 的 decideDesktopBrowserAccess —— 本仓没有该文件）只放行同源 frame，不透明源的沙箱 iframe 永远拿不到
// x-dsh-desktop-renderer → 插件路由一律 403。网页壁纸载荷因此必须走 host 自建的
// 独立 loopback 源，两处挂载共用同一段处理函数。
check('host 自建壁纸媒体源（独立 loopback 监听）',
  /let mediaOrigin = null/.test(hostSrc) && /function ensureMediaOrigin\(\)/.test(hostSrc)
    && /server\.listen\(0, '127\.0\.0\.1'/.test(hostSrc) && /function mediaOriginBase\(\)/.test(hostSrc));
check('scene-files 处理函数被双挂载（应用源 + 媒体源）',
  /function handleSceneFiles\(req, res, mount\)/.test(hostHalfSrc)
    && hostHalfSrc.includes("handleSceneFiles(req, res, 'media')")
    && hostHalfSrc.includes("handleSceneFiles(req, res, 'app')")
    && hostHalfSrc.includes('function traceMediaRequests('));
check('媒体源只服务 /scene-files 前缀', hostSrc.includes("pathname.startsWith(`${BASE}/scene-files/`)"));
// ── 场景载荷改走自建源：三处必须同时成立（少一处就退化成"静默回落"，或更糟：告警丢失）──
// 背景：`scene.pkg` 实测到 336MB，走应用源那条路挤不过首帧预算（那里还要买纹理解码与
// shader 编译），故场景载荷改走自建 loopback 源。三条判据把这次改动的**每个接缝**都钉住：
//   ① 宿主端出这个源，且门控按"库里真有可实时渲染的场景"（不是无条件起监听）；
//   ② 客户端消费宿主给的值，**不再自己拼 location.origin**（否则改动无声失效）；
//   ③ 媒体源接住 `/diag`，且用的是诊断族**同一个** handleDiag（否则渲染页告警 404 静默丢失）。
//
// ⚠️ 2026-09 修正：① 的**形态门控**被拿掉了 —— `mediaOriginBase()` 在原生浏览器形态下
// 恒返空串（它门控的是"网页壁纸的能力头栅栏"），而场景载荷要独立源的理由是**带宽**，
// 与宿主形态无关。旧断言（`await mediaOriginBase()`）因此钉住的是一个**已知会饿死**的写法，
// 现在改成钉 `ensureSceneMediaOrigin()`，并加负对照：退回旧写法必须被判红。
check('宿主端出场景载荷的源，且按 sceneLive 门控（没有场景不多起监听）',
  /const sceneMediaBase = wallpapers\.some\(\(w\) => w\.sceneLive\) \? await ensureSceneMediaOrigin\(\) : ''/.test(hostSrc)
    && /^\s*sceneMediaBase,$/m.test(hostSrc));
{
  // 同一判据喂"改回旧写法"的源码：必须变假（旧写法在浏览器形态下恒空串 ⇒ 大包回落应用源）。
  const scenePinned = (s) => /const sceneMediaBase = wallpapers\.some\(\(w\) => w\.sceneLive\) \? await ensureSceneMediaOrigin\(\) : ''/.test(s)
    && !/sceneMediaBase = wallpapers\.some\(\(w\) => w\.sceneLive\) \? await mediaOriginBase\(\) : ''/.test(s);
  const mutated = hostSrc.replace('? await ensureSceneMediaOrigin()', '? await mediaOriginBase()');
  check('负对照：把调用点改回 mediaOriginBase() ⇒ 同一条判据变假',
    mutated !== hostSrc && scenePinned(mutated) === false && scenePinned(hostSrc) === true,
    'mutated=' + (mutated !== hostSrc));
}
{
  // `ensureSceneMediaOrigin` 里不得出现 mediaOriginNeeded / adapterOverride：
  // 那就是把形态门控偷偷加回来（判据只取该函数体，取不到就显式报缺）。
  const fn = (hostSrc.match(/function ensureSceneMediaOrigin\(\) \{[\s\S]{0,240}?\n  \}/) || [''])[0];
  check('ensureSceneMediaOrigin 只做懒启动（不读 mediaOriginNeeded / adapterOverride）',
    fn.includes('ensureMediaOrigin()') && !fn.includes('mediaOriginNeeded') && !fn.includes('adapterOverride'),
    fn ? 'body=' + fn.replace(/\s+/g, ' ').slice(0, 80) : 'function 未找到');
}
// 判据必须钉在**赋值表达式**上，而不是"文件里出现过 sceneMediaBase"：后者在"读进变量却
// 不用它"的写法下照样为真（实测：把 mediaBase 改成无条件 location.origin 时它不变红 ⇒
// 那是恒真式判据，属于 P3-16 点名的形态）。所以抠出 mediaBase 的赋值再断言它消费宿主值。
const mbAssign = (liveSrc.match(/const mediaBase = [\s\S]{0,220}?;/) || [''])[0];
check('客户端场景 mediaBase 的**赋值表达式**消费宿主给的源（不是无条件 location.origin）',
  /hostSceneBase/.test(mbAssign) && !/const mediaBase = location\.origin/.test(mbAssign),
  mbAssign.replace(/\s+/g, ' ').slice(0, 90));
check('该源来自宿主载荷 inventory.sceneMediaBase',
  /const hostSceneBase = selection\.inventory && selection\.inventory\.sceneMediaBase/.test(liveSrc));
check('negative control: 老的硬编码写法会被上一条判出',
  !liveSrc.includes('location.origin + "/wallpaper-engine/scene-files"'));
check('媒体源的 /diag 走诊断族同一个 handleDiag（同一份缓冲，且先于 scene-files 分派）',
  (() => {
    const diagAt = hostSrc.indexOf("pathname === '/diag'");
    const callAt = hostSrc.indexOf('mediaDiagHandler(req, res)');
    const sceneAt = hostSrc.indexOf('pathname.startsWith(`${BASE}/scene-files/`)');
    return diagAt > 0 && callAt > diagAt && sceneAt > diagAt
      && hostSrc.includes('onHandleDiag: (fn) => { mediaDiagHandler = fn; }')
      && /if \(onHandleDiag\) onHandleDiag\(handleDiag\)/.test(hostHalfSrc)
      && /let mediaDiagHandler = null/.test(hostSrc);
  })());
check('negative control: 调用点保持语句形态（加赋值前缀会被路由索引判成孤儿族模块）',
  /^\s*registerDiagRoutes\(webServer, \{$/m.test(hostSrc)
    && !/^\s*\w+\s*=\s*registerDiagRoutes\(/m.test(hostSrc));

// 封面（Now Playing artwork）：实测用户反馈「不显示歌曲封面」的根因是只问 Spotify。
// 现在通用路径是 media-control 自带的 artworkData（系统 MediaRemote，任何播放器都有），
// 且缓存后缀按 MIME 决定（PNG 存成 .jpg 会按错误类型解码）。
// 这套现为**回落实现**（lib/media/legacy.js），首选是 media-bridge 子进程（lib/media/*）
// —— 断言因此两边都盯：回落能力不能退化，新链路的接缝要在。
const legacyBridgeSrc = readFileSync(join(root, 'lib', 'media', 'legacy.js'), 'utf8');
check('回落实现住在 lib/media/legacy.js（回落路径还在）',
  existsSync(join(root, 'lib', 'media', 'legacy.js')) && !existsSync(join(root, 'lib', 'media-bridge.js')));
check('封面走 media-control 的 artworkData（通用，不限 Spotify）',
  legacyBridgeSrc.includes('artworkData') && legacyBridgeSrc.includes('artworkMimeType')
    && legacyBridgeSrc.includes('function takeArtworkMac('));
check('例行轮询 --no-artwork（封面 base64 每秒几百 KB），换曲才取',
  legacyBridgeSrc.includes("'get', '--no-artwork'") && legacyBridgeSrc.includes('npNoArtwork'));
check('封面缓存按 MIME 定后缀并清旧文件',
  legacyBridgeSrc.includes('ARTWORK_EXT') && legacyBridgeSrc.includes('function writeArtwork(')
    && legacyBridgeSrc.includes("'artwork'"));
check('Spotify AppleScript 降为兜底', legacyBridgeSrc.includes('function fetchSpotifyArtwork('));
check('回落实现暴露 artworkMime 与 backend 标记',
  legacyBridgeSrc.includes('artworkMime: () => artworkMime') && legacyBridgeSrc.includes("backend: 'legacy'"));
check('回落实现尊重「音频已关」（不会偷偷开采集/申请权限）',
  legacyBridgeSrc.includes('if (audio) startAudio();'));
check('host 按扩展名回封面 Content-Type', hostSrc.includes("bmp: 'image/bmp'"));

// ── media-bridge 中间件的接缝（首选路径）────────────────────────────────────
const provSrc = readFileSync(join(root, 'lib', 'media', 'provision.js'), 'utf8');
const supSrc = readFileSync(join(root, 'lib', 'media', 'supervisor.js'), 'utf8');
const facadeSrc = readFileSync(join(root, 'lib', 'media', 'index.js'), 'utf8');
check('产物表：darwin 通用包 / linux x64 musl / win32 双架构',
  provSrc.includes("'media-bridge-darwin-universal'")
    && provSrc.includes("'media-bridge-linux-x64-musl'") && provSrc.includes("'media-bridge-win32-x64.exe'"));
check('产物 sha256 全部固定（宁可回落也不执行未校验的二进制）',
  // ≥5：win32-arm64 是可选产物，Release 里没有时它能没有哈希（靠 x64 回落链）
  (provSrc.match(/[0-9a-f]{64}/g) || []).length >= 5 && provSrc.includes('MEDIA_BRIDGE_SHA256'));
check('魔数识别包含 macOS universal 的 fat 头', provSrc.includes('0xca') && provSrc.includes('0xfe'));
// win32-arm64 在 CI 里是可选产物（windows-11-arm runner 会卡）：没有它时 Windows ARM64
// 必须能回落到 x64（系统自带模拟），否则那台机器会直接掉到 legacy 实现。
check('Windows ARM64 有 x64 产物回落链',
  /MEDIA_BRIDGE_FALLBACKS/.test(provSrc)
    && /'media-bridge-win32-arm64\.exe': \['media-bridge-win32-x64\.exe'\]/.test(provSrc));
check('产物解析链：环境变量 → 插件 bin/ → 下载缓存 → Release 下载',
  provSrc.includes('DSH_WE_MEDIA_BRIDGE') && provSrc.includes("join(PLUGIN_ROOT, 'bin', asset)")
    && provSrc.includes('cacheDirFor(dataDir, tag)') && provSrc.includes('releases/download/'));
check('协议握手校验 hello.protocol（版本不符不硬来）',
  supSrc.includes('hello.protocol') && supSrc.includes('PROTOCOL_VERSION'));
check('事件与响应按字段分流（不能假设下一行是响应）',
  supSrc.includes('if (msg.event)') && supSrc.includes('pending.has(msg.id)'));
check('频谱走订阅推送（50ms），不是每帧去问', supSrc.includes('SPECTRUM_INTERVAL_MS') && supSrc.includes("events.push('spectrum')"));
check('音频关时用 --no-audio（连音频授权都不会弹）', supSrc.includes("'--no-audio'"));
check('位置外推用 updatedAtMs + rate（暂停不外推）',
  supSrc.includes('playing && pb.positionSource !== ') && supSrc.includes('Date.now() - ref'));
check('事件里已外推的位置不重复外推（参考时刻改写成事件时刻）',
  supSrc.includes("pb.positionSource === 'interpolated'") && supSrc.includes('pb.updatedAtMs = refMs'));
check('歌词换算成渲染页要的 [[秒, 文本], …]（含 LRC offset）',
  supSrc.includes('export function lyricsToTuples') && supSrc.includes('offsetMs'));
// 状态缓存兜底：中间件的 status 事件此前只在元数据源报错时发（v0.1.3），音频源
// idle→preparing→running 的变化不通知 —— 消费端只在启动时读一次 status，会永远停在
// preparing（Linux 实测：频谱有数据、客户端却拿不到）。v0.1.4 补了事件，插件这层
// 兜底刷新也保留：两层互不依赖。
check('supervisor 兜底刷新 status（不依赖中间件的事件是否齐全）',
  /const STATUS_REFRESH_MS = /.test(supSrc) && /function refreshStatusSoon\(/.test(supSrc)
    && /refreshStatusSoon\(\);/.test(supSrc));
check('崩溃退避重启 + 超预算回落（onFatal）',
  supSrc.includes('MAX_RESTARTS') && supSrc.includes('onUnexpectedExit') && supSrc.includes('onFatal'));
check('空闲停进程 + 下次访问自动唤醒', supSrc.includes('IDLE_STOP_MS') && supSrc.includes('asleep'));
// Windows 黑框回归：GUI 宿主（DSH Desktop / Electron）spawn 控制台子进程时必须带
// windowsHide（= Win32 CREATE_NO_WINDOW），否则会弹出/闪一个黑框。中间件与 ffmpeg
// 的每一处 spawn 都要带上；macOS/Linux 专属的调用（media-control/playerctl/xattr 等）
// 不在 Windows 上跑，但一并带上也无害。
const winHideSites = [
  { file: 'lib/media/supervisor.js', spawn: /spawn\(binPath[\s\S]{0,80}\.\.\.a\.opts/, minFlags: 2 },
  { file: 'lib/index.js', spawn: /spawn\(a\.file[\s\S]{0,80}\.\.\.a\.opts/, minFlags: 2 },
  { file: 'lib/media/legacy.js', spawn: /spawnSync\('ffmpeg'[\s\S]{0,220}windowsHide: true/, minFlags: 1 },
];
const winHideBad = [];
for (const site of winHideSites) {
  const body = readFileSync(join(root, site.file), 'utf8');
  const flags = (body.match(/windowsHide: true/g) || []).length;
  if (!site.spawn.test(body) || flags < site.minFlags) winHideBad.push(site.file);
}
check('平台 spawn 点都带 windowsHide（GUI 宿主在 Windows 上不出黑框）',
  winHideBad.length === 0, winHideBad.join(', ') || '已覆盖中间件 / ffmpeg 转码 / 回落路径');
check('门面：中间件优先，失败回落 legacy 并留下原因',
  facadeSrc.includes('fallBackTo(') && facadeSrc.includes("backend: live ? 'bridge'"));
check('门面支持 DSH_WE_MEDIA_LEGACY=1 强制走 legacy 回落', facadeSrc.includes('DSH_WE_MEDIA_LEGACY'));
check('门面把「音频已关」传给回落实现（不让回落偷偷开采集）',
  facadeSrc.includes('createLegacy({ dataDir, log, audio: optsRef.audio })'));
// 媒体状态族已搬到 lib/routes/now-playing.js（P2-11）。判据按 diag 族的同一形态翻成三条：
// ① URL 形状由**真实注册表**（mock webServer 跑一遍 apply 的结果）断言 —— 与代码住在哪个文件无关；
// ② 该路由的实现契约在**它现在所在的文件**里断言；③ 正文侧钉住"已搬走"（零路径字面量 + 一次调用）。
const nowPlayingSrc = readFileSync(join(root, 'lib', 'routes', 'now-playing.js'), 'utf8');
const nowPlayingPaths = ['/media-status', '/audio-spectrum', '/now-playing', '/now-playing/artwork'];
const missingNowPlaying = nowPlayingPaths.filter((p) => !routes.some((r) => r.path === '/wallpaper-engine' + p));
check('host 路由形状不变（客户端/渲染页无需感知后端切换）',
  missingNowPlaying.length === 0, missingNowPlaying.join(', ') || '四条都在');
check('negative control: 同一条判据能点出没注册的路径',
  ['/media-status', '/not-registered'].filter((p) => !routes.some((r) => r.path === '/wallpaper-engine' + p)).join() === '/not-registered');
check('spectrum 路由回报 running（客户端据此决定装不装音频桥）',
  nowPlayingSrc.includes('running: st.audio.status ===') && nowPlayingSrc.includes('mediaBackend.status()'));
check('媒体状态族已搬出 lib/index.js（正文零路径字面量 + 一次调用）',
  !/path: `\$\{BASE\}\/(media-status|audio-spectrum|now-playing)/.test(hostSrc)
    && /registerNowPlayingRoutes\(webServer, \{/.test(hostSrc));
check('settings 白名单保留 mediaLyricsOnline（否则开关会被丢）', hostKeeps('mediaLyricsOnline', true));

// 客户端：封面必须转成**自包含 data URL** —— 宿主给的是插件路由，
// 沙箱壁纸在 Desktop 上取不到（能力头栅栏只放行同源 frame）。
check('client 把封面降采样成 data URL 再推给壁纸',
  src.includes('async function fetchArtworkDataUrl(') && src.includes('createImageBitmap(')
    && src.includes('toDataURL("image/jpeg"') && src.includes('thumbnail: mediaArtData || undefined'));
check('client 按曲目缓存封面并重试（宿主下载封面是异步的）',
  src.includes('function scheduleArtworkFetch(') && src.includes('MEDIA_ART_MAX_TRIES'));
check('client 透传歌词与 albumArtist（[[秒, 文本]] 原样给渲染页）',
  src.includes('lyrics: Array.isArray(m.lyrics) && m.lyrics.length ? m.lyrics : undefined')
    && src.includes('albumArtist: m.albumArtist || ""'));
check('client 的 push key 带歌词版本（歌词晚到也要再推一帧）',
  src.includes('const lyrRev =') && src.includes('lyrRev].join('));
check('音频桥按宿主 running 装卸（装了桥 = 渲染页放弃自带音频源）',
  src.includes('function syncAudioBridge(frame, running)') && src.includes('syncAudioBridge(frame, d.running === true)'));
check('「在线歌词」开关默认关（外发请求要用户点头）',
  schemaMod.DEFAULTS.mediaLyricsOnline === false && Boolean(schemaMod.KINDS.mediaLyricsOnline)
    && tabsSrc.includes('在线歌词'));
// 场景/网页实时渲染**默认开** —— 这是用户可见的默认值，三处一起钉：DEFAULTS 的值、
// KINDS 的类型（boolTrue = 缺键读作开）、以及面板/活层的判据形态（`!== false`，
// truthy 判断会在缺键时静默变成"关"）。缺键必须两侧都读作开。
{
  const countOf = (s, needle) => s.split(needle).length - 1;
  check('「场景实时渲染」默认开（DEFAULTS + KINDS boolTrue + 缺键两侧读作开）',
    schemaMod.DEFAULTS.sceneLive === true && schemaMod.KINDS.sceneLive.kind === 'boolTrue'
      && schemaMod.sanitizeFromSchema({}, 'client').sceneLive === true
      && sanitizeHost({}).sceneLive === true,
    'DEFAULTS.sceneLive=' + String(schemaMod.DEFAULTS.sceneLive));
  check('面板/活层判据是 `!== false` 形态（面板 ≥4 处 + live 层 ≥1 处）',
    countOf(tabsSrc, 'sel.sceneLive !== false') >= 4
      && countOf(liveSrc, 'selLike.sceneLive !== false') >= 1,
    'panel=' + countOf(tabsSrc, 'sel.sceneLive !== false') + ' live=' + countOf(liveSrc, 'selLike.sceneLive !== false'));
  // 负对照：默认翻成关，同一条判据必须变假 —— 证明上面两条不是恒真。
  const savedSceneLiveDefault = schemaMod.DEFAULTS.sceneLive;
  schemaMod.DEFAULTS.sceneLive = false;
  const flipped = schemaMod.DEFAULTS.sceneLive === true
    && schemaMod.sanitizeFromSchema({}, 'client').sceneLive === true;
  schemaMod.DEFAULTS.sceneLive = savedSceneLiveDefault;
  check('负对照：默认改成关 ⇒ 同一条判据变假', flipped === false && schemaMod.DEFAULTS.sceneLive === true);
}
check('host builds the property seed from project.json + 覆盖值',
  /function buildSeedScript\(entryAbs, token\)/.test(hostSrc) && /parseUserPropDefs\(pj, overrides/.test(hostSrc)
    && /userPropsFor\(token\)/.test(hostSrc));
check('host 侧属性解析模块（order 浮点 / combo 保类型 / 逐键本地化 / condition）',
  existsSync(join(root, 'lib', 'we-props.js'))
    && /parseUserPropDefs/.test(readFileSync(join(root, 'lib', 'we-props.js'), 'utf8')));
check('settings 白名单保留 userProps（按 token 存标量）',
  JSON.stringify(sanitizeHost({ userProps: { tok: { c: 'x', n: 1, obj: { bad: 1 } } } }).userProps)
    === '{"tok":{"c":"x","n":1}}');
check('「壁纸属性」按钮：仅场景/网页壁纸 + 绿色样式',
  tabsSrc.includes('we-picker__btn--props') && tabsSrc.includes('(current.type === "scene" || current.type === "web") && sel.propsUrl'));
check('属性面板热更新走 __wp.updateWebProps',
  src.includes('function applyUserProps(') && src.includes('wp.updateWebProps(wire)'));
check('属性面板值以渲染页实时表为准（getProperties）',
  src.includes('wp.getProperties()') && src.includes('function loadUserPropDefs('));
// 求值器自 P1-7 起是**独立模块** src/we-cond.js（构建期内联回客户端作用域）。
// 断言改为三件事：模块在位、产物里确实有它、client.js 不再自带实现 —— 免得抽出去之后
// 两边各留一份（那正是要防的漂移）。
const weCondSrc = readFileSync(join(root, 'src', 'we-cond.js'), 'utf8');
const bundleSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
check('条件求值器已抽成独立模块并被内联（fail open）',
  /\(function weEvalCondition|function weEvalCondition\(/.test(weCondSrc)
    && weCondSrc.includes('function weCondParse(')
    && bundleSrc.includes('function weEvalCondition(')
    && !src.includes('function weEvalCondition('));
check('场景就绪后回放覆盖值（无 HTML 种子通道）',
  // 声明留在 client.js（用户属性域），调用点在实时管线的挂载路径里（live-layer.js）。
  src.includes('function applyStoredUserProps(') && liveSrc.includes('applyStoredUserProps(selection)'));
// 用户口径：选择壁纸页只保留**顶部**关闭按钮（底部那个是重复的）。
// 计数口径：closePicker 的绑定 = 顶部按钮 + 点击遮罩，共 2 处。
// P3-11 阶段 2：模态框标记已搬到 src/picker-modal.js ⇒ 这三条文本断言跟着**所属文件**走
// （同下面诊断族那批"按所属文件分家"的口径）。计数口径仍覆盖**整个客户端半**
// （client.js + picker-modal.js），所以在别处再加一个关闭按钮照样会被判出。
const modalSrc = readFileSync(join(root, 'src', 'picker-modal.js'), 'utf8');
const clientHalf = src + '\n' + modalSrc;
check('选择壁纸弹窗只留顶部关闭按钮（底部不再有）',
  (clientHalf.match(/onClick: closePicker/g) || []).length === 2
    && modalSrc.includes('we-picker__modal-foot" },')
    && modalSrc.includes('ESC / 点击遮罩关闭'),
  'closePicker 绑定数=' + ((clientHalf.match(/onClick: closePicker/g) || []).length));
check('抽屉里名称行文字居中', stylesSrc.includes('.we-repo-panel .we-picker__current-title { grid-area: title; text-align: center; }'));
check('标题里的类型/播放态在抽屉内联并加括号（整行省略）',
  tabsSrc.includes('className: "we-picker__current-meta" }') && stylesSrc.includes('.we-repo-panel .we-picker__current-meta {')
    && stylesSrc.includes('.we-repo-panel .we-picker__current-meta::before { content: "（"; }')
    && stylesSrc.includes('.we-repo-panel .we-picker__current-meta::after { content: "）"; }'));
check('抽屉窄容器：标题独占首行 + 按钮上下排列（8px）',
  stylesSrc.includes('.we-repo-panel .we-picker__current {') && stylesSrc.includes('grid-template-areas:')
    && stylesSrc.includes('.we-repo-panel .we-picker__current-actions {')
    && /grid-area: actions; flex-direction: column; align-items: stretch; gap: 8px;/.test(stylesSrc));
// ── 诊断族（P2-11 第一族）：注册已搬到 lib/routes/diag.js ⇒ 文本断言按**所属文件**分家 ──
// 行为断言（上面的 Level E 405/413）走 mock webServer，搬去哪个文件都照样有效；这里钉的是
// "这一族只在那个文件里注册"—— 两边各留一份会让同一路径被重复挂载，而卸载只放掉一份。
const diagSrc = readFileSync(join(root, 'lib', 'routes', 'diag.js'), 'utf8');
check('renderer diagnostics sink registered at /diag', /path: '\/diag'/.test(diagSrc) && /diag-log/.test(diagSrc));
// **实测**：同一份渲染页产物里还有一条走 ${BASE}/diag 的告警通道，只挂根路径会让
// 「壁纸黑屏」时最关键的渲染页告警全部 404 静默丢掉。
check('renderer diagnostics also accepted at ${BASE}/diag', diagSrc.includes('path: `${BASE}/diag`'));
check('诊断族只在 lib/routes/diag.js 注册（lib/index.js 只留一次调用）',
  !/path: '\/diag'/.test(hostSrc) && !/path: `\$\{BASE\}\/diag/.test(hostSrc)
  && !/const diagLog = \[\]/.test(hostSrc) && !/const handleDiag = /.test(hostSrc)
  && /registerDiagRoutes\(webServer, \{/.test(hostSrc));
// 负对照：把注册塞回主文件那种写法必须被判出（否则上面这条只是"主文件恰好没这几个字"
const diagBackInMain = "disposers.push(webServer.register({ kind: 'exact', path: '/diag', handler: handleDiag }));";
check('negative control: diag 注册回流 lib/index.js 会被判出', /path: '\/diag'/.test(diagBackInMain));
// 自定义存储位置的目录型条目：up-dir- 前缀（用户自己的内容 / 不参与 /remove）
check('uploads scan tags project dirs with up-dir- prefix', /id: `up-dir-\$\{name\}`/.test(hostSrc));
check('uploads scan resolves scene.pkg for declared scene.json', /resolveSceneMainFileP\(abs, proj\.file\)/.test(hostSrc));

// ── Level E: WE 官方素材（local-assets）端点 + 目录设置 ─────────────────────
// 契约对齐上游 renderer/src/local-assets.ts 的四种请求形；素材 fixture 是
// 合成字节（端点不解析 .tex，只透传字节）。
console.log('Level E — WE local-assets endpoint + assets-dir setting');
const weAssetsFixture = join(TEST_CACHE_DIR, 'we-assets');
rmSync(weAssetsFixture, { recursive: true, force: true });
mkdirSync(join(weAssetsFixture, 'materials', 'util'), { recursive: true });
mkdirSync(join(weAssetsFixture, 'materials', 'particle'), { recursive: true });
mkdirSync(join(weAssetsFixture, 'materials', 'gradient'), { recursive: true });
mkdirSync(join(weAssetsFixture, 'fonts'), { recursive: true });
const NOISE_BYTES = Buffer.from('synthetic-util-noise-tex-bytes');
writeFileSync(join(weAssetsFixture, 'materials', 'util', 'noise.tex'), NOISE_BYTES);
writeFileSync(join(weAssetsFixture, 'materials', 'particle', 'halo.tex'), Buffer.from('synthetic-halo'));
writeFileSync(join(weAssetsFixture, 'materials', 'gradient', 'gradient_0.tex'), Buffer.from('synthetic-gradient'));
const FONT_BYTES = Buffer.from('synthetic-font-bytes');
writeFileSync(join(weAssetsFixture, 'fonts', 'NotoSans.ttf'), FONT_BYTES);

const laRoute = routes.find((r) => r.path === '/api/local-assets');
const weDirRoute = routes.find((r) => r.path === '/wallpaper-engine/we-assets-dir');
check('/api/local-assets route registered as prefix', Boolean(laRoute) && laRoute.kind === 'prefix',
  laRoute ? 'kind=' + laRoute.kind : 'missing');
check('we-assets-dir route registered', Boolean(weDirRoute) && weDirRoute.kind === 'exact');

function fakePostReq(url, body) {
  const listeners = {};
  const req = {
    url, method: 'POST', headers: {},
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return req; },
  };
  queueMicrotask(() => {
    for (const fn of listeners.data || []) fn(Buffer.from(body));
    for (const fn of listeners.end || []) fn();
  });
  return req;
}
async function postJson(route, url, obj) {
  const res = fakeRes();
  const done = route.handler(fakePostReq(url, JSON.stringify(obj)), res);
  if (done && typeof done.then === 'function') await done;
  if (!res.__state.ended) {
    await new Promise((resolveFn) => {
      const t = setTimeout(resolveFn, 8000);
      res.on('finish', () => { clearTimeout(t); resolveFn(); });
    });
  }
  return res;
}

if (laRoute && weDirRoute) {
  // 未配置素材：探测 ok:false（渲染页静默回落，不是错误）。
  const probe0 = await runHandler(laRoute, '/api/local-assets');
  const probe0Body = JSON.parse(probe0.__state.body.toString('utf8'));
  check('probe before configure → ok:false', probe0.__state.status === 200 && probe0Body.ok === false);

  // POST 校验：不存在的目录 / 缺 materials/ 都 400。
  const badPost = await postJson(weDirRoute, '/wallpaper-engine/we-assets-dir', { dir: join(TEST_CACHE_DIR, 'no-such-dir') });
  check('POST with missing materials/ rejected', badPost.__state.status === 400,
    'status=' + badPost.__state.status);
  const relPost = await postJson(weDirRoute, '/wallpaper-engine/we-assets-dir', { dir: 'relative/path' });
  check('POST with relative path rejected', relPost.__state.status === 400,
    'status=' + relPost.__state.status);

  // 配置合法素材目录 → available + 贴图计数。
  const okPost = await postJson(weDirRoute, '/wallpaper-engine/we-assets-dir', { dir: weAssetsFixture });
  const okBody = JSON.parse(okPost.__state.body.toString('utf8'));
  check('POST valid assets dir accepted (with texture count)',
    okPost.__state.status === 200 && okBody.available === true && okBody.textures === 3,
    'status=' + okPost.__state.status + ' textures=' + okBody.textures);

  const probe1 = await runHandler(laRoute, '/api/local-assets');
  const probe1Body = JSON.parse(probe1.__state.body.toString('utf8'));
  check('probe after configure → ok + roots[0].id=local',
    probe1Body.ok === true && probe1Body.roots && probe1Body.roots[0] && probe1Body.roots[0].id === 'local');

  const idxRes = await runHandler(laRoute, '/api/local-assets/local/materials/index.json');
  const idxBody = JSON.parse(idxRes.__state.body.toString('utf8'));
  check('materials index lists engine names (posix, ext stripped)',
    Array.isArray(idxBody.names)
      && idxBody.names.includes('util/noise')
      && idxBody.names.includes('particle/halo')
      && idxBody.names.includes('gradient/gradient_0'),
    (idxBody.names || []).join(','));

  const texRes = await runHandler(laRoute, '/api/local-assets/local/materials/util/noise.tex');
  check('tex bytes served verbatim', texRes.__state.status === 200
    && texRes.__state.body.equals(NOISE_BYTES), 'status=' + texRes.__state.status);

  const fontRes = await runHandler(laRoute, '/api/local-assets/local/fonts/NotoSans.ttf');
  check('arbitrary file served (fonts fallback path)', fontRes.__state.status === 200
    && fontRes.__state.body.equals(FONT_BYTES), 'status=' + fontRes.__state.status);

  // 安全与错误面：越界 → 403；未知素材源 → 404；缺失文件 → 404。
  // 注意：%2e%2e 会被 WHATWG URL 解析器在 pathname 阶段直接归并掉（到不了
  // 路由），真正能触达路径限定的是编码斜杠（..%2f 在 pathname 里保持编码，
  // 经 decodeURIComponent 后才变成 '/'）—— 用后者测围栏。
  const travRes = await runHandler(laRoute, '/api/local-assets/local/..%2f..%2fetc%2fpasswd');
  check('encoded-slash traversal fenced (403)', travRes.__state.status === 403,
    'status=' + travRes.__state.status);
  const badIdRes = await runHandler(laRoute, '/api/local-assets/nope/materials/index.json');
  check('unknown source id → 404', badIdRes.__state.status === 404, 'status=' + badIdRes.__state.status);
  const missRes = await runHandler(laRoute, '/api/local-assets/local/materials/util/missing.tex');
  check('missing file → 404', missRes.__state.status === 404, 'status=' + missRes.__state.status);

  // 清除（空串）→ 探测回落 ok:false。
  const clearPost = await postJson(weDirRoute, '/wallpaper-engine/we-assets-dir', { dir: '' });
  const clearBody = JSON.parse(clearPost.__state.body.toString('utf8'));
  check('POST empty dir clears the setting', clearPost.__state.status === 200 && clearBody.available === false);
  const probe2 = await runHandler(laRoute, '/api/local-assets');
  check('probe after clear → ok:false', JSON.parse(probe2.__state.body.toString('utf8')).ok === false);
}

// Level D 增补：local-assets 接线的静态契约（防重构丢线）。
check('client gates localAssets=1 on inventory availability',
  /weAssetsAvailable \? "&localAssets=1"/.test(liveSrc));
check('syncLayers key carries local-assets availability',
  /weAssetsAvailable \? "la1"/.test(liveSrc));
check('client posts assets dir to host route',
  /we-assets-dir/.test(src) && /function changeWeAssetsDir/.test(src));
check('host inventory reports weAssets availability',
  /weAssetsAvailable: weAssetsAvailable\(\)/.test(hostSrc));
check('host fences local-assets file paths',
  /未知素材源/.test(hostSrc) && /target\.startsWith\(root \+ sep\)/.test(hostSrc));

// ── teardown ────────────────────────────────────────────────────────────────
try { dispose && dispose(); } catch { /* ignore */ }
delete process.env.DSH_WE_STEAM_ROOT;
delete process.env.DSH_WE_UPLOAD_DIR;
rmSync(fixtureRoot, { recursive: true, force: true });
rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });
rmSync(weAssetsFixture, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`SCENE-LIVE CHECKS FAILED — ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL SCENE-LIVE CHECKS PASSED (${passed})`);
