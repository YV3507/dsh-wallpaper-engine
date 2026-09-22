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
 * Usage:  node scripts/verify-scene-live.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';

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
check('vendored shim throttles by vsync frame-skip (not setTimeout)',
  /Math\.ceil\(1000 \/ fps \/ nativeMs/.test(vendoredShim),
  '跳过帧的节流（旧实现 setTimeout 会产出 17/33/50ms 抖动）');
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
  general: { properties: { color0: { order: 0, type: 'color', value: '1 0 0' }, fpslock: { order: 1, type: 'bool', value: true } } },
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
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory');
  const body = JSON.parse(res.__state.body.toString('utf8'));
  fixture = (body.wallpapers || []).find((w) => w.type === 'scene' && w.title === 'Live Fixture Scene') || null;
  check('fixture scene listed in inventory', Boolean(fixture), fixture ? fixture.id : 'not found');
  check('inventory marks fixture sceneLive=true with sceneLiveSrc',
    Boolean(fixture && fixture.sceneLive === true && typeof fixture.sceneLiveSrc === 'string' && fixture.sceneLiveSrc),
    fixture ? 'src len=' + String(fixture.sceneLiveSrc || '').length : '-');
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

  // Fence: encoded parent hops aiming at a file OUTSIDE the wallpaper dir
  // (5 hops up from …/431960/990001 to the fixture root; literal ../ would be
  // normalised away by `new URL()` before the handler ever sees it).
  const fenceUrl = `/wallpaper-engine/scene-files/${token}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt`;
  const fenceRes = await runHandler(filesRoute, fenceUrl);
  check('encoded ../../ escape fenced (403)', fenceRes.__state.status === 403, 'status=' + fenceRes.__state.status);

  const unknownRes = await runHandler(filesRoute, '/wallpaper-engine/scene-files/bm90LWF0b2tlbg/scene.pkg');
  check('unknown token → 404', unknownRes.__state.status === 404, 'status=' + unknownRes.__state.status);

  const nosubRes = await runHandler(filesRoute, `/wallpaper-engine/scene-files/${token}/`);
  check('missing subpath → 404', nosubRes.__state.status === 404, 'status=' + nosubRes.__state.status);
}

// ── Level C3: web wallpapers over /scene-files ──────────────────────────────
// The strict-sandbox web path needs three host duties: inject the vendored WE
// shim into the HTML entry, serve subresources with correct MIME types (a CSS
// file as application/octet-stream is rejected by the browser), and allow
// opaque-origin fetches via CORS.
console.log('Level C3 — web wallpaper files (shim injection / MIME / CORS)');
let mediaEntry = '';   // C4 复用：C3 里从 inventory 拿到的那条入口 URL
{
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory');
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
    }
  }
}

// ── Level C2: custom storage (uploads) — WE project directories ─────────────
// The reported bug: pointing 存储位置 at a WallpaperEM-style downloads folder
// found none of its scene wallpapers (the old scanner only matched `up-*.ext`
// single files). The fixture (created before import) holds one WE project dir
// plus one legacy single-file upload.
console.log('Level C2 — custom storage scan (WE project dirs under uploads)');
{
  const sceneFrameRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame');
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory');
  const body = JSON.parse(res.__state.body.toString('utf8'));
  const dirScene = (body.wallpapers || []).find((w) => w.id === 'up-dir-my-scene-1') || null;
  check('uploads WE project dir listed as scene', Boolean(dirScene), dirScene ? dirScene.type : 'not found');
  check('custom-storage scene takes its project.json title',
    Boolean(dirScene && dirScene.title === 'Custom Dir Scene'), dirScene ? dirScene.title : '-');
  check('custom-storage scene marked sceneLive + sceneLiveSrc',
    Boolean(dirScene && dirScene.sceneLive === true && dirScene.sceneLiveSrc),
    dirScene ? 'src len=' + String(dirScene.sceneLiveSrc || '').length : '-');
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
    const ctype = h(frameRes, 'Content-Type');
    check('custom-storage scene frame extracted (real pkg decode)',
      frameRes.__state.status === 200 && /image\/(jpeg|png)/.test(ctype),
      'status=' + frameRes.__state.status + ' ' + ctype + ' ' + frameRes.__state.body.length + 'B');
  }
}

// ── Level D: client source contract ─────────────────────────────────────────
console.log('Level D — client source wiring (src/client.js)');
const src = readFileSync(join(root, 'src', 'client.js'), 'utf8');
const clientChecks = [
  ['live is the top priority for scenes and web', /const isLive = \(sel\.type === "scene" \|\| sel\.type === "web"\) && liveRenderEnabled\(sel\)/.test(src)],
  ['sceneVideo yields to live', /Boolean\(sel\.sceneVideo\) && !isLive/.test(src)],
  ['web wallpapers force the strict sandbox', /webSandbox=strict/.test(src)],
  ['heartbeat watchdog exists', /function startLiveWatch/.test(src) && /LIVE_FIRST_FRAME_MS/.test(src)],
  ['failure memory persists', /sceneLiveFailures/.test(src) && /function liveFail/.test(src)],
  ['audio mux honours live', /!selLike\.sceneLiveActive/.test(src)],
  ['syncLayers key carries live state', /"live\\u0000" \+ \(selection\.sceneLiveSrc \|\| selection\.webLiveSrc\)/.test(src)],
  ['pointer injection wired', /__wp\.pushPointer|wp\.pushPointer/.test(src) && /pointerLeave/.test(src)],
  ['fit mapping table present', /SCENE_LIVE_FIT = \{ cover: "cover"/.test(src)],
  // 实测踩坑回归（2026-09-22）：渲染页 resume() 会 resetFrameMeter，心跳若
  // 每秒无条件调 resume 会永远读到 fps=0 → 15s 误降级。控制必须去重下发，
  // 且 tick 内先读统计再应用控制。
  ['controls are deduped before dispatch', /liveApplied\.playing !== playing/.test(src)],
  ['heartbeat reads stats before applying controls', /const stats = liveStats\(frame\);\s*\n\s*applyLiveControls\(frame\);/.test(src)],
  ['upload management list excludes project dirs', /isUploadedWallpaper\(w\) && !isDirWallpaper\(w\)/.test(src)],
  // 帧率取证（「限了 30 还卡」时唯一能分清「壁纸自身掉帧」与「整页掉帧」的手段）
  ['live fps probe reports ui / web / rnd to the diag channel',
    src.includes('function reportLiveFps') && src.includes('"live-fps"')
      && src.includes('function takeUiFps') && src.includes('wstate.webFps')],
  // 网页壁纸的 src 直用 host 给的绝对 URL（媒体源）；相对形态仅作回落。
  ['web live src reuses the absolute media-origin URL', src.includes('const webEntry = String(selLike.webLiveSrc || "")')
    && src.includes('/^https?:\\/\\//i.test(webEntry)')],
];
for (const [name, ok] of clientChecks) check(name, ok);
// 实测踩坑回归（2026-09-22）：host 的 sanitizeSettings 是白名单，漏加
// sceneLiveFailures 会让 PUT 上来的失败记忆被丢弃、刷新后记忆消失。
const hostSrc = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
check('host settings whitelist keeps sceneLiveFailures', /sceneLiveFailures: \(o\.sceneLiveFailures && typeof o\.sceneLiveFailures === 'object'/.test(hostSrc));
check('host injects the vendored shim into web HTML', /data-we-shim="host"/.test(hostSrc) && /readWebShim\(\)/.test(hostSrc));
check('host sends CORS for opaque-origin fetches', /Access-Control-Allow-Origin', '\*'/.test(hostSrc));
check('inventory derives webLive via webFieldsFor', /webFieldsFor\(w, hasMedia, webMediaBase\)/.test(hostSrc));
// 2026-09-23 黑屏事故回归：Desktop 的能力头栅栏（宿主 lib/webserver.js →
// decideDesktopBrowserAccess）只放行同源 frame，不透明源的沙箱 iframe 永远拿不到
// x-dsh-desktop-renderer → 插件路由一律 403。网页壁纸载荷因此必须走 host 自建的
// 独立 loopback 源，两处挂载共用同一段处理函数。
check('host 自建壁纸媒体源（独立 loopback 监听）',
  /let mediaOrigin = null/.test(hostSrc) && /function ensureMediaOrigin\(\)/.test(hostSrc)
    && /server\.listen\(0, '127\.0\.0\.1'/.test(hostSrc) && /function mediaOriginBase\(\)/.test(hostSrc));
check('scene-files 处理函数被双挂载（应用源 + 媒体源）',
  /function handleSceneFiles\(req, res, mount\)/.test(hostSrc)
    && hostSrc.includes("handleSceneFiles(req, res, 'media')")
    && hostSrc.includes("handleSceneFiles(req, res, 'app')")
    && hostSrc.includes('function traceMediaRequests('));
check('媒体源只服务 /scene-files 前缀', hostSrc.includes("pathname.startsWith(`${BASE}/scene-files/`)"));

// 封面（Now Playing artwork）：实测用户反馈「不显示歌曲封面」的根因是只问 Spotify。
// 现在通用路径是 media-control 自带的 artworkData（系统 MediaRemote，任何播放器都有），
// 且缓存后缀按 MIME 决定（PNG 存成 .jpg 会按错误类型解码）。
const bridgeSrc = readFileSync(join(root, 'lib', 'media-bridge.js'), 'utf8');
check('封面走 media-control 的 artworkData（通用，不限 Spotify）',
  bridgeSrc.includes('artworkData') && bridgeSrc.includes('artworkMimeType')
    && bridgeSrc.includes('function takeArtworkMac('));
check('例行轮询 --no-artwork（封面 base64 每秒几百 KB），换曲才取',
  bridgeSrc.includes("'get', '--no-artwork'") && bridgeSrc.includes('npNoArtwork'));
check('封面缓存按 MIME 定后缀并清旧文件',
  bridgeSrc.includes('ARTWORK_EXT') && bridgeSrc.includes('function writeArtwork(')
    && bridgeSrc.includes('writeArtwork') && bridgeSrc.includes("'artwork'"));
check('Spotify AppleScript 降为兜底', bridgeSrc.includes('function fetchSpotifyArtwork('));
check('媒体桥暴露 artworkMime', bridgeSrc.includes('artworkMime: () => artworkMime'));
check('host 按扩展名回封面 Content-Type', hostSrc.includes("bmp: 'image/bmp'"));
// 客户端：封面必须转成**自包含 data URL** —— 宿主给的是插件路由，
// 沙箱壁纸在 Desktop 上取不到（能力头栅栏只放行同源 frame）。
check('client 把封面降采样成 data URL 再推给壁纸',
  src.includes('async function fetchArtworkDataUrl(') && src.includes('createImageBitmap(')
    && src.includes('toDataURL("image/jpeg"') && src.includes('thumbnail: mediaArtData || undefined'));
check('client 按曲目缓存封面并重试（宿主下载封面是异步的）',
  src.includes('function scheduleArtworkFetch(') && src.includes('MEDIA_ART_MAX_TRIES'));
check('host builds the property seed from project.json', /function buildSeedScript\(entryAbs\)/.test(hostSrc));
check('renderer diagnostics sink registered at /diag', /path: '\/diag'/.test(hostSrc) && /diag-log/.test(hostSrc));
// 实测踩坑（2026-09-23）：同一份渲染页产物里还有一条走 ${BASE}/diag 的告警通道，
// 只挂根路径会让「壁纸黑屏」时最关键的渲染页告警全部 404 静默丢掉。
check('renderer diagnostics also accepted at ${BASE}/diag', hostSrc.includes('path: `${BASE}/diag`'));
// 自定义存储位置的目录型条目：up-dir- 前缀（用户自己的内容 / 不参与 /remove）
check('uploads scan tags project dirs with up-dir- prefix', /id: `up-dir-\$\{name\}`/.test(hostSrc));
check('uploads scan resolves scene.pkg for declared scene.json', /resolveSceneMainFileP\(abs, proj\.file\)/.test(hostSrc));

// ── teardown ────────────────────────────────────────────────────────────────
try { dispose && dispose(); } catch { /* ignore */ }
delete process.env.DSH_WE_STEAM_ROOT;
delete process.env.DSH_WE_UPLOAD_DIR;
rmSync(fixtureRoot, { recursive: true, force: true });
rmSync(TEST_UPLOAD_DIR, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`SCENE-LIVE CHECKS FAILED — ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`ALL SCENE-LIVE CHECKS PASSED (${passed})`);
