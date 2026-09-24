/**
 * verify-scene.mjs — fixture self-test for the scene static-frame pipeline.
 *
 * Levels:
 *   A. pkg-extract unit: real workshop scene.pkg files must extract the MAIN
 *      colorful texture (never a mask), as JPEG passthrough or PNG, with sane
 *      dims. Synthetic PKG/TEX exercises the raw-RGBA decode + PNG encoder and
 *      the "no decodable texture" 422 path.
 *   B. Host route integration: a mock webServer captures the scene-frame route;
 *      the handler is invoked with real req/res shims to assert 200 + bytes,
 *      on-disk mtime cache creation and cache-hit reuse.
 *
 * Real fixtures are probed when present (Steam workshop + skin-center import
 * store); synthetic fixtures always run, so the script passes without Steam.
 *
 * Usage:  node scripts/verify-scene.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync, deflateSync } from 'node:zlib';
import { Writable, Readable } from 'node:stream';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Point the frame cache at a workspace-relative dir so the suite passes under
// sandboxes that cannot write outside the workspace (the real host has no
// such restriction).
const TEST_CACHE_DIR = join(root, '.test-cache', 'frames');
process.env.DSH_WE_CACHE_DIR = TEST_CACHE_DIR;
const pkgExtract = await import(pathToFileURL(resolve(root, 'lib', 'pkg-extract.js')).href);

let passed = 0;
let failed = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) passed++;
  else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function pngInfo(bytes) {
  const b = Buffer.from(bytes);
  return {
    isPng: b.length > 24 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG',
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  };
}

function jpegInfo(bytes) {
  const b = Buffer.from(bytes);
  let p = 2;
  let dims = null;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1];
    if (marker === 0xd8) { p += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      dims = { width: ((b[p + 7] << 8) | b[p + 8]) & 0xffff, height: ((b[p + 5] << 8) | b[p + 6]) & 0xffff };
      break;
    }
    const segLen = ((b[p + 2] << 8) | b[p + 3]) & 0xffff;
    if (segLen < 2) break;
    p += 2 + segLen;
  }
  return { isJpeg: b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9, ...(dims || {}) };
}

/** Very small PNG decoder (filter types 0-4) returning {width,height,rgba}. */
function pngToRgba(bytes) {
  const b = Buffer.from(bytes);
  if (!(b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG')) return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bpp = 4;
  const stride = width * bpp + 1;
  // WE embedded PNGs are split into many IDAT chunks — collect them all.
  const idats = [];
  let iend = -1;
  let p = 8;
  while (p < b.length) {
    if (p + 12 > b.length) return null;
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    if (p + 12 + len > b.length) return null;
    if (type === 'IDAT') idats.push(b.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') { iend = p; break; }
    p += 12 + len;
  }
  if (!idats.length || iend < 0) return null;
  const raw = Buffer.from(inflateSync(Buffer.concat(idats)));
  if (raw.length < stride * height) return null;
  const out = Buffer.alloc(width * height * bpp);
  for (let y = 0; y < height; y++) {
    const f = raw[y * stride];
    const line = raw.subarray(y * stride + 1, (y + 1) * stride);
    for (let x = 0; x < width * bpp; x++) {
      const a = x >= bpp ? out[y * width * bpp + x - bpp] : 0;
      const pr = y > 0 ? out[(y - 1) * width * bpp + x] : 0;
      const pc = y > 0 && x >= bpp ? out[(y - 1) * width * bpp + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + pr) & 255;
      else if (f === 3) v = (v + ((a + pr) >> 1)) & 255;
      else if (f === 4) { const p = a + pr - pc, pa = Math.abs(p - a), pb = Math.abs(p - pr), pcv = Math.abs(p - pc); v = (v + (pa <= pb && pa <= pcv ? a : pb <= pcv ? pr : pc)) & 255; }
      out[y * width * bpp + x] = v;
    }
  }
  return { width, height, rgba: out };
}

/** Minimal PNG chunk writer for synthetic embedded-PNG tests. */
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  let crc = 0xffffffff;
  const bytes = out.subarray(4, 8 + data.length);
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return out;
}

/** Build a tiny packed scene.pkg with raw (uncompressed) entries. */
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
  header.writeInt32LE(8, p); p += 4; // magic length
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
  const mip = Buffer.alloc(4 * 5 + rgbaBytes.length);
  mip.writeInt32LE(width, 0);
  mip.writeInt32LE(height, 4);
  mip.writeInt32LE(0, 8); // isLz4
  mip.writeInt32LE(0, 12); // decompressedCount
  mip.writeInt32LE(rgbaBytes.length, 16); // storedLen
  rgbaBytes.copy(mip, 20);
  // Consecutive NUL-terminated strings (the real TEX header layout).
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2 + 4);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4; // format RGBA8888
  header.writeInt32LE(0, p); p += 4; // flags
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(width, p); p += 4;
  header.writeInt32LE(height, p); p += 4;
  header.writeInt32LE(0, p); p += 4; // unknown
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4; // imageCount
  header.writeInt32LE(1, p); p += 4; // mipmapCount
  return Buffer.concat([header.subarray(0, p), mip]);
}

// A0: 图集 padding（四周纯黑）必须裁掉。
//
// 用户口径：「加载期的抽帧图没铺满屏幕」—— 真实场景的主纹理常是 2048²/4096² 的
// 2 的幂次方图集，画面只占其中一条带、其余纯黑；原样当静态帧时客户端 cover 以
// 图集**中心**铺满，屏幕上一大片黑。这里两种 padding 形态都覆盖：只在下方的
// （真实样本）与四周的（顺带覆盖左右裁列）。
//
// 这个用例同时是「裁切不得吞掉候选」的闸门：cropRgba 曾在 Uint8Array 上用
// Buffer#copy 抛错，候选循环把异常当「该贴图不可用」跳过 —— 结果整张静态帧被换成
// 另一张贴图（实测 4096² 作者原画变成 256² 水波法线贴图）。
{
  const mk = (w, h, bandTop, bandBottom, left = 0, right = w) => {
    const rgba = Buffer.alloc(w * h * 4, 0); // 全黑底（含 alpha=0 → 也算 padding）
    for (let y = bandTop; y < bandBottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * w + x) * 4;
        // 棋盘：保证有真实方差，能过 colorfulness/flatness 门禁
        const red = (x + y) % 2 === 0;
        rgba[i] = red ? 220 : 30;
        rgba[i + 1] = red ? 30 : 30;
        rgba[i + 2] = red ? 30 : 220;
        rgba[i + 3] = 255;
      }
    }
    return rgba;
  };
  const sceneJson = Buffer.from(JSON.stringify({ objects: [{ image: 'materials/main.json' }] }));
  const imgJson = Buffer.from(JSON.stringify({ material: 'materials/main.tex' }));
  try {
    // ① 只在下方的 padding：512x512 图集，画面是顶部 512x288
    const pkg1 = buildPkg([
      { path: 'scene.json', bytes: sceneJson },
      { path: 'materials/main.json', bytes: imgJson },
      { path: 'materials/main.tex', bytes: buildTexRgba(512, 512, mk(512, 512, 0, 288)) },
    ]);
    const r1 = pkgExtract.extractSceneMainImage(new Uint8Array(pkg1));
    const i1 = pngInfo(r1.bytes);
    check('图集下方黑边裁掉（512x512 → 512x288）',
      r1.mime === 'image/png' && i1.width === 512 && i1.height === 288,
      `${i1.width}x${i1.height} mime=${r1.mime} path=${String(r1.texturePath || '').split('/').pop()}`);
  } catch (e) {
    check('图集下方黑边裁掉（512x512 → 512x288）', false, e.message);
  }
  try {
    // ② 四周 padding：画面是中间 384x288 的窗口（左右也要内缩，才能真正覆盖裁列）
    const pkg2 = buildPkg([
      { path: 'scene.json', bytes: sceneJson },
      { path: 'materials/main.json', bytes: imgJson },
      { path: 'materials/main.tex', bytes: buildTexRgba(512, 512, mk(512, 512, 112, 400, 64, 448)) },
    ]);
    const r2 = pkgExtract.extractSceneMainImage(new Uint8Array(pkg2));
    const i2 = pngInfo(r2.bytes);
    check('图集四周黑边裁掉（左右列同样要裁）',
      r2.mime === 'image/png' && i2.width === 384 && i2.height === 288,
      `${i2.width}x${i2.height}`);
  } catch (e) {
    check('图集四周黑边裁掉（左右列同样要裁）', false, e.message);
  }
}

// ── Level A: pkg-extract ────────────────────────────────────────────────────
console.log('Level A — pkg-extract unit');

// A1: synthetic RGBA8888 scene → PNG path (exercises TEX parse + decode + PNG).
{
  // Checkerboard red/blue so the frame has real variance (a solid fill would
  // be rejected by the flatness gate).
  const rgba = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 4 * 4; i++) {
    const red = (i + ((i / 4) | 0)) % 2 === 0;
    rgba[i * 4] = red ? 220 : 30;
    rgba[i * 4 + 1] = red ? 30 : 30;
    rgba[i * 4 + 2] = red ? 30 : 220;
    rgba[i * 4 + 3] = 255;
  }
  const tex = buildTexRgba(4, 4, rgba);
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: tex },
  ]);
  try {
    const r = pkgExtract.extractSceneMainImage(new Uint8Array(pkg));
    const info = pngInfo(r.bytes);
    check('synthetic RGBA8888 → PNG ' + info.width + 'x' + info.height, r.mime === 'image/png' && info.isPng && info.width === 4 && info.height === 4 && r.texturePath === 'main.tex');
    const px = pngToRgba(r.bytes);
    const colorful = px && (() => { let c = 0; for (let i = 0; i < px.rgba.length; i += 4) { if (Math.max(px.rgba[i], px.rgba[i + 1], px.rgba[i + 2]) - Math.min(px.rgba[i], px.rgba[i + 1], px.rgba[i + 2]) > 40) c++; } return c > 10; })();
    check('synthetic PNG is colorful (not a gray mask)', colorful === true);
  } catch (e) {
    check('synthetic RGBA8888 → PNG', false, e.message);
  }
}

// A2: synthetic scene with no textures → descriptive throw.
{
  const pkg = buildPkg([{ path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [] })) }]);
  try {
    pkgExtract.extractSceneMainImage(new Uint8Array(pkg));
    check('empty scene throws', false, 'no error raised');
  } catch (e) {
    check('empty scene throws', /no texture candidates/.test(e.message), e.message);
  }
}

// A2b: embedded-PNG texture → passthrough (WE stores photographic art as PNG).
{
  // Build a tiny 2x2 RGBA PNG by hand (IHDR + IDAT + IEND).
  const raw = Buffer.alloc(2 * 4 * 4 + 3);
  for (let y = 0; y < 2; y++) {
    raw[y * 9] = 0; // filter 0
    raw.set([220, 30, 30, 255, 30, 220, 30, 255], y * 9 + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  // Wrap the PNG as the TEX mip payload (format RGBA8888 header, payload PNG).
  const mip = Buffer.alloc(20 + png.length);
  mip.writeInt32LE(2, 0); mip.writeInt32LE(2, 4);
  mip.writeInt32LE(0, 8); mip.writeInt32LE(0, 12);
  mip.writeInt32LE(png.length, 16);
  png.copy(mip, 20);
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4; header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(2, p); p += 4; header.writeInt32LE(2, p); p += 4;
  header.writeInt32LE(2, p); p += 4; header.writeInt32LE(2, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4; header.writeInt32LE(1, p); p += 4;
  const tex = Buffer.concat([header.subarray(0, p), mip]);
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: tex },
  ]);
  try {
    const r = pkgExtract.extractSceneMainImage(new Uint8Array(pkg));
    const same = Buffer.from(r.bytes).equals(Buffer.from(png));
    check('embedded PNG → passthrough', r.mime === 'image/png' && same, r.mime + ' ' + r.bytes.length + 'B');
  } catch (e) {
    check('embedded PNG → passthrough', false, e.message);
  }
}

// A2c: embedded MP4 payload → rejected (animation/video texture).
{
  // [u32 boxSize=24]['ftypmp42'][12 zero bytes] — 24 bytes total, boxSize sane.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(12)]);
  const mip = Buffer.alloc(20 + mp4.length);
  mip.writeInt32LE(2, 0); mip.writeInt32LE(2, 4);
  mip.writeInt32LE(0, 8); mip.writeInt32LE(0, 12);
  mip.writeInt32LE(mp4.length, 16);
  mp4.copy(mip, 20);
  const header = Buffer.alloc(9 + 9 + 4 * 8 + 9 + 4 * 2);
  let p = 0;
  header.write('TEXV0005\0', p, 'ascii'); p += 9;
  header.write('TEXI0001\0', p, 'ascii'); p += 9;
  header.writeInt32LE(0, p); p += 4; header.writeInt32LE(0, p); p += 4;
  header.writeInt32LE(2, p); p += 4; header.writeInt32LE(2, p); p += 4;
  header.writeInt32LE(2, p); p += 4; header.writeInt32LE(2, p); p += 4;
  header.writeInt32LE(0, p); p += 4;
  header.write('TEXB0002\0', p, 'ascii'); p += 9;
  header.writeInt32LE(1, p); p += 4; header.writeInt32LE(1, p); p += 4;
  const tex = Buffer.concat([header.subarray(0, p), mip]);
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: tex },
  ]);
  try {
    pkgExtract.extractSceneMainImage(new Uint8Array(pkg));
    check('embedded MP4 → rejected', false, 'no error raised');
  } catch (e) {
    check('embedded MP4 → rejected', /embedded mp4/.test(e.message), e.message);
  }
}

// A2d: grayscale-only scene → quality gate rejects → caller falls back.
{
  const gray = Buffer.alloc(4 * 4 * 4);
  for (let i = 0; i < 4 * 4; i++) {
    gray[i * 4] = 128; gray[i * 4 + 1] = 128; gray[i * 4 + 2] = 128; gray[i * 4 + 3] = 255;
  }
  const tex = buildTexRgba(4, 4, gray);
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: tex },
  ]);
  try {
    pkgExtract.extractSceneMainImage(new Uint8Array(pkg));
    check('grayscale texture → quality gate rejects', false, 'no error raised');
  } catch (e) {
    check('grayscale texture → quality gate rejects', /frame rejected|no decodable/.test(e.message), e.message);
  }
}

// A3: real workshop fixtures (probed; skipped when not installed).
const FIXTURES = [
  { file: process.env.DSH_WE_FIXTURE_1 || 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\3345141364\\scene.pkg', expect: 'materials/wallhaven-vqkme8.tex' },
  { file: process.env.DSH_WE_FIXTURE_2 || 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\3575109244\\scene.pkg', expect: 'materials/360albumviewer_imgproc_1242125.tex' },
];
for (const fx of FIXTURES) {
  if (!existsSync(fx.file)) { console.log('  (skip fixture ' + fx.file + ' — not present)'); continue; }
  try {
    const r = pkgExtract.extractSceneMainImage(new Uint8Array(readFileSync(fx.file)));
    const okMime = r.mime === 'image/jpeg' || r.mime === 'image/png';
    const okTex = r.texturePath === fx.expect;
    const okDims = r.width > 100 && r.height > 100;
    check('fixture ' + fx.file.split('\\').slice(-2).join('/'), okMime && okTex && okDims, r.mime + ' ' + r.width + 'x' + r.height + ' ← ' + r.texturePath);
  } catch (e) {
    check('fixture ' + fx.file.split('\\').slice(-2).join('/'), false, e.message);
  }
}

// ── Offline fixture: synthetic Steam library for Level B ────────────────────
// Level B used to depend on a real workshop scene being installed (dev boxes
// often have none → 'no scene wallpaper with frameUrl on this machine'). A
// synthetic library wired through DSH_WE_STEAM_ROOT makes the route pipeline
// testable anywhere: the pkg ships one 32×32 noise RGBA texture (noise keeps
// the PNG payload above the >1000B assertion and passes the colorful-main-
// texture gate that a flat fill would trip).
const fixtureLib = join(root, '.test-cache', 'scene-fixture', 'steamlib');
const fixtureItemDir = join(fixtureLib, 'steamapps', 'workshop', 'content', '431960', '990002');
{
  rmSync(join(root, '.test-cache', 'scene-fixture'), { recursive: true, force: true });
  mkdirSync(fixtureItemDir, { recursive: true });
  // A library root is only scanned when steamapps/common/wallpaper_engine
  // exists (owningLibrariesP) — create it so the workshop content is found.
  mkdirSync(join(fixtureLib, 'steamapps', 'common', 'wallpaper_engine'), { recursive: true });
  const W = 32;
  const rgba = Buffer.alloc(W * W * 4);
  let seed = 0x12345678;
  for (let i = 0; i < W * W; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba[i * 4] = seed & 0xff;
    rgba[i * 4 + 1] = (seed >> 8) & 0xff;
    rgba[i * 4 + 2] = (seed >> 16) & 0xff;
    rgba[i * 4 + 3] = 255;
  }
  const pkg = buildPkg([
    { path: 'scene.json', bytes: Buffer.from(JSON.stringify({ objects: [{ image: 'main.tex' }] })) },
    { path: 'main.tex', bytes: buildTexRgba(W, W, rgba) },
  ]);
  writeFileSync(join(fixtureItemDir, 'scene.pkg'), pkg);
  writeFileSync(join(fixtureItemDir, 'project.json'), JSON.stringify({
    title: 'Synthetic Fixture Scene', type: 'scene', file: 'scene.pkg', preview: 'preview.jpg',
    contentrating: 'Everyone',
  }));
  writeFileSync(join(fixtureItemDir, 'preview.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  // Env roots are additive: a real Steam library on this machine still scans.
  process.env.DSH_WE_STEAM_ROOT = [process.env.DSH_WE_STEAM_ROOT, fixtureLib].filter(Boolean).join(',');
}

// ── Level B: host route integration (mock webServer) ────────────────────────
console.log('Level B — scene-frame route (mock webServer)');
const routes = [];
const mockCtx = {
  webServer: {
    register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
    tapIndex() { return () => {}; },
  },
};
const hostMod = await import(pathToFileURL(resolve(root, 'lib', 'index.js')).href);
const host = hostMod.default || hostMod;
// Build a minimal real-ish ctx for the plugin's apply (only webServer is used
// for route registration; uploads config writes are guarded by try/catch).
const apply = host.apply || (host.inject && host.apply);
const dispose = apply(mockCtx);
const sceneRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame');
check('scene-frame route registered', Boolean(sceneRoute), sceneRoute ? 'kind=' + sceneRoute.kind : 'missing');

// Route requires a token that mediaMap knows; tokens are minted during
// inventory. Emulate by calling the inventory route first with a req shim.
const invRoute = routes.find((r) => r.path === '/wallpaper-engine/inventory');
function fakeReq(url) { return { url, headers: {}, method: 'GET' }; }
function fakeRes() {
  const state = { status: 200, headers: {}, body: Buffer.alloc(0), ended: false };
  // A real Writable so createReadStream(...).pipe(res) completes; the test
  // awaits 'finish' to collect the full payload.
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
/** Run a handler and wait for either its returned promise or the response
 *  stream to finish (the scene-frame handler kicks off an async IIFE that
 *  pipes a file stream into res). */
async function runHandler(route, url) {
  const res = fakeRes();
  const done = route.handler(fakeReq(url), res);
  if (done && typeof done.then === 'function') await done;
  if (!res.__state.ended) {
    await new Promise((resolveFn) => {
      const t = setTimeout(resolveFn, 8000);
      res.on('finish', () => { clearTimeout(t); resolveFn(); });
    });
  }
  return res;
}

let token = null;
let invBody = null;
{
  const res = await runHandler(invRoute, '/wallpaper-engine/inventory');
  invBody = JSON.parse(res.__state.body.toString('utf8'));
  // The synthetic fixture (id 990002) is what Level B exercises; a real
  // workshop scene on this machine would still be listed alongside it.
  const scene = (invBody.wallpapers || []).find((w) => w.id === '990002' && w.frameUrl);
  token = scene ? scene.frameUrl.split('/').pop() : null;
  check('inventory exposes the fixture scene frameUrl', Boolean(token), token ? 'frame token minted' : 'fixture scene missing from inventory');
}

if (token) {
  const firstRes = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token);
  const okFirst = firstRes.__state.status === 200 && firstRes.__state.body.length > 1000;
  const ctype = firstRes.__state.headers['Content-Type'] || firstRes.__state.headers['content-type'] || '';
  check('scene-frame 200 + payload', okFirst, 'status=' + firstRes.__state.status + ' ' + firstRes.__state.body.length + 'B ' + ctype);
  check('scene-frame mime', /image\/(jpeg|png)/.test(ctype), ctype);
  // cache file written under the plugin data dir (env-overridden for tests)
  const cacheDir = TEST_CACHE_DIR;
  // 缓存键版本从源码读（别写死：升版本时这里会静默测到旧文件，等于假通过）
  const keyVersion = (/SCENE_FRAME_KEY_VERSION = '([^']+)'/.exec(
    readFileSync(resolve(root, 'lib', 'index.js'), 'utf8')) || [])[1] || 'sf';
  const cached = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.startsWith(keyVersion + '_' + token + '_')) : [];
  check('frame cached on disk', cached.length >= 1, cacheDir + ' [' + cached.join(', ') + ']');

  // Second call must hit the cache (handler still returns the payload).
  const secondRes = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token);
  check('scene-frame cache-hit returns payload', secondRes.__state.status === 200 && secondRes.__state.body.equals(firstRes.__state.body), secondRes.__state.body.length + 'B');

  // ── GPU 抓帧回填端点（HEAD 探测 + PUT 写入 + 唯一性/结构校验 + 清除通道）──
  // 槽位此刻已被上面的 GET 提取填充（无 GPU 帧）→ PUT 应能写入。
  const gpuRoute = routes.find((r) => r.path === '/wallpaper-engine/scene-frame-cache');
  check('scene-frame-cache route registered', Boolean(gpuRoute), gpuRoute ? 'kind=' + gpuRoute.kind : 'missing');
  // 结构合法的 PNG 构造器：签名 + IHDR + IDAT + IEND（host 只做结构校验，不解码）。
  const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), payload]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2;
  const pngHead = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
  ]);
  const pngTail = pngChunk('IEND', Buffer.alloc(0));
  const makePng = (payloadBytes, fill = 7) => Buffer.concat([pngHead, pngChunk('IDAT', Buffer.alloc(payloadBytes, fill)), pngTail]);
  const gpuPng = makePng(4096);
  const runPut = async (url, body) => {
    const req = new Readable({ read() {} });
    req.url = url; req.method = 'PUT'; req.headers = { 'content-type': 'image/png' };
    const res = fakeRes();
    gpuRoute.handler(req, res);
    req.push(body); req.push(null);
    await new Promise((resolveFn) => {
      const t = setTimeout(resolveFn, 8000);
      res.on('finish', () => { clearTimeout(t); resolveFn(); });
      if (res.__state.ended) { clearTimeout(t); resolveFn(); }
    });
    return res;
  };
  const runClear = async (url, method = 'DELETE') => {
    const req = { url, headers: {}, method };
    const res = fakeRes();
    gpuRoute.handler(req, res);
    await new Promise((r) => setTimeout(r, 20));
    return res;
  };
  const runHead = async (url) => {
    const req = { url, headers: {}, method: 'HEAD' };
    const res = fakeRes();
    const done = sceneRoute.handler(req, res);
    if (done && typeof done.then === 'function') await done;
    return res;
  };
  if (gpuRoute) {
    // 精确匹配本次运行的 key（含 fixture mtime）—— 目录里可能有历史运行
    // 残留的其它 key 文件，不算失败。版本取自上面从源码读出的 keyVersion，
    // 写死字面量会在宿主升键后静默测到旧文件（第 514 行的注释即此意）。
    const curKey = keyVersion + '_' + token + '_' + Math.round(statSync(join(fixtureItemDir, 'scene.pkg')).mtimeMs);
    const head0 = await runHead('/wallpaper-engine/scene-frame/' + token);
    check('HEAD: occupied slot without GPU frame → 204 + X-WE-GPU=0',
      head0.__state.status === 204 && head0.__state.headers['X-WE-GPU'] === '0',
      'status=' + head0.__state.status + ' gpu=' + head0.__state.headers['X-WE-GPU']);
    // 结构校验：只有魔数的 9 字节 / 有魔数无 IHDR-IEND / 结构合法但过短 → 全 415。
    const putMagicOnly = await runPut('/wallpaper-engine/scene-frame-cache/' + token,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([1])]));
    check('PUT 9 字节假 PNG → 415（不再永久占槽）', putMagicOnly.__state.status === 415, 'status=' + putMagicOnly.__state.status);
    const putNoChunks = await runPut('/wallpaper-engine/scene-frame-cache/' + token,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]));
    check('PUT 魔数正确但无 IHDR/IEND → 415', putNoChunks.__state.status === 415, 'status=' + putNoChunks.__state.status);
    const putTooSmall = await runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(10));
    check('PUT 结构合法但过小（< 1KB 地板）→ 415', putTooSmall.__state.status === 415, 'status=' + putTooSmall.__state.status);
    check('以上三次拒绝都没有落盘', !existsSync(join(cacheDir, curKey + '_gpu.png')), 'ok');
    const put1 = await runPut('/wallpaper-engine/scene-frame-cache/' + token, gpuPng);
    check('PUT 合法 PNG → 200', put1.__state.status === 200, 'status=' + put1.__state.status);
    const gpuFiles = readdirSync(cacheDir).filter((f) => f === curKey + '_gpu.png');
    check('GPU frame stored as <key>_gpu.png (文件名即标记，可直接打开)',
      gpuFiles.length === 1, gpuFiles.join(', ') || 'missing');
    check('CPU 提取帧未被 GPU 写入覆盖（留作对照）', existsSync(join(cacheDir, curKey + '.png')), 'ok');
    const head1 = await runHead('/wallpaper-engine/scene-frame/' + token);
    check('HEAD after PUT → X-WE-GPU=1', head1.__state.status === 204 && head1.__state.headers['X-WE-GPU'] === '1',
      'status=' + head1.__state.status + ' gpu=' + head1.__state.headers['X-WE-GPU']);
    const getGpu = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token);
    check('GET now serves the GPU-captured bytes', getGpu.__state.status === 200 && getGpu.__state.body.equals(gpuPng),
      getGpu.__state.body.length + 'B');
    const getGpuV3 = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/' + token + '?v=3');
    check('GET ?v=3 also serves the GPU frame (跨档位全局优先)', getGpuV3.__state.status === 200 && getGpuV3.__state.body.equals(gpuPng),
      getGpuV3.__state.body.length + 'B');
    const headV3 = await runHead('/wallpaper-engine/scene-frame/' + token + '?v=3');
    check('HEAD ?v=3 → X-WE-GPU=1', headV3.__state.status === 204 && headV3.__state.headers['X-WE-GPU'] === '1',
      'status=' + headV3.__state.status + ' gpu=' + headV3.__state.headers['X-WE-GPU']);
    const put2 = await runPut('/wallpaper-engine/scene-frame-cache/' + token, gpuPng);
    check('second PUT rejected → 409 (每壁纸一份)', put2.__state.status === 409, 'status=' + put2.__state.status);
    // 并发写入（评审用真 socket 复现过 TOCTOU）：同 key 串行 → 恰好一 200 一 409。
    await runClear('/wallpaper-engine/scene-frame-cache/' + token);
    const raced = await Promise.all([
      runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(4096, 1)),
      runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(4096, 2)),
      runPut('/wallpaper-engine/scene-frame-cache/' + token, makePng(4096, 3)),
    ]);
    const codes = raced.map((r) => r.__state.status).sort().join(',');
    check('三个并发 PUT 只有一个成功（唯一性闸串行化）', codes === '200,409,409', 'codes=' + codes);
    const survivor = readdirSync(cacheDir).filter((f) => f === curKey + '_gpu.png').length;
    check('并发后磁盘上仍只有一份 GPU 帧', survivor === 1, 'count=' + survivor);
    const noTmpLeft = readdirSync(cacheDir).filter((f) => f.startsWith(curKey + '_gpu.png.tmp')).length;
    check('并发写入未残留 .tmp 垃圾', noTmpLeft === 0, 'tmp=' + noTmpLeft);
    // 清除通道：DELETE（以及 POST ?clear=1）→ 可重新抓取。
    const clr = await runClear('/wallpaper-engine/scene-frame-cache/' + token);
    check('DELETE 清除 GPU 帧 → 200 + removed=true',
      clr.__state.status === 200 && /"removed":true/.test(String(clr.__state.body)), 'status=' + clr.__state.status);
    const clr2 = await runClear('/wallpaper-engine/scene-frame-cache/' + token, 'POST');
    check('POST 无 clear 参数 → 405（不误触发清除）', clr2.__state.status === 405, 'status=' + clr2.__state.status);
    const clr3 = await runClear('/wallpaper-engine/scene-frame-cache/' + token + '?clear=1', 'POST');
    check('POST ?clear=1 清除路径 → 200',
      clr3.__state.status === 200 && /"removed":false/.test(String(clr3.__state.body)), 'status=' + clr3.__state.status);
    const headAfterClear = await runHead('/wallpaper-engine/scene-frame/' + token);
    check('清除后 HEAD → 204 + X-WE-GPU=0（回到 CPU 帧）',
      headAfterClear.__state.status === 204 && headAfterClear.__state.headers['X-WE-GPU'] === '0',
      'status=' + headAfterClear.__state.status + ' gpu=' + headAfterClear.__state.headers['X-WE-GPU']);
    const put3 = await runPut('/wallpaper-engine/scene-frame-cache/' + token, gpuPng);
    check('清除后可重新写入 → 200（坏帧不再是死结）', put3.__state.status === 200, 'status=' + put3.__state.status);
    // ── P2-L：unlink 失败（权限/占用）必须报错 ────────────────────────────
    // 回 200 + removed:false 会让客户端把「清除」当成功（面板行消失、提示已清除），
    // 而宿主照旧发 GPU 帧 —— 画面纹丝不动且没有任何反馈。ENOENT 仍算幂等成功。
    {
      const mode = statSync(cacheDir).mode & 0o777;
      chmodSync(cacheDir, 0o555); // 目录不可写 → unlinkSync EACCES
      let locked = null;
      try {
        locked = await runClear('/wallpaper-engine/scene-frame-cache/' + token);
      } finally {
        chmodSync(cacheDir, mode); // 立刻恢复，后续用例照常
      }
      check('unlink 失败 → 500（不得假成功）',
        locked && locked.__state.status === 500 && /unlink-failed/.test(String(locked.__state.body)),
        'status=' + (locked && locked.__state.status) + ' body=' + String(locked && locked.__state.body).slice(0, 90));
      check('unlink 失败后 GPU 帧仍在盘上（清除确实没发生）',
        readdirSync(cacheDir).filter((f) => f === curKey + '_gpu.png').length === 1);
      const headLocked = await runHead('/wallpaper-engine/scene-frame/' + token);
      check('unlink 失败后 HEAD 仍报 X-WE-GPU=1（与客户端所见一致）',
        headLocked.__state.status === 204 && headLocked.__state.headers['X-WE-GPU'] === '1',
        'gpu=' + headLocked.__state.headers['X-WE-GPU']);
      const afterUnlock = await runClear('/wallpaper-engine/scene-frame-cache/' + token);
      check('恢复可写后重试清除 → 200 + removed=true（失败不是死结）',
        afterUnlock.__state.status === 200 && /"removed":true/.test(String(afterUnlock.__state.body)),
        'status=' + afterUnlock.__state.status);
    }
    const putBad = await runPut('/wallpaper-engine/scene-frame-cache/' + token, Buffer.from('not-an-image'));
    check('PUT bad magic → 415', putBad.__state.status === 415, 'status=' + putBad.__state.status);
    const putUnknown = await runPut('/wallpaper-engine/scene-frame-cache/not-a-real-token', gpuPng);
    check('PUT unknown token → 404', putUnknown.__state.status === 404, 'status=' + putUnknown.__state.status);
    const headUnknown = await runHead('/wallpaper-engine/scene-frame/not-a-real-token');
    check('HEAD unknown token → 404', headUnknown.__state.status === 404, 'status=' + headUnknown.__state.status);
    // HEAD 契约（评审指出的盲区）：空槽 → 404，且纯探测绝不写盘。
    await runClear('/wallpaper-engine/scene-frame-cache/' + token);
    for (const ext of ['png', 'jpg', 'gif']) { rmSync(join(cacheDir, curKey + '.' + ext), { force: true }); }
    const before = readdirSync(cacheDir).length;
    const headEmpty = await runHead('/wallpaper-engine/scene-frame/' + token);
    check('HEAD 空槽 → 404（纯探测不触发提取）', headEmpty.__state.status === 404, 'status=' + headEmpty.__state.status);
    check('HEAD 空槽未写盘（文件数不变）', readdirSync(cacheDir).length === before,
      before + ' → ' + readdirSync(cacheDir).length);
  }
}

// C: error paths
{
  const res = await runHandler(sceneRoute, '/wallpaper-engine/scene-frame/not-a-real-token');
  check('unknown token → 404', res.__state.status === 404, 'status=' + res.__state.status);
}

// D: 真 socket 端到端 —— 错误应答必须真的送到客户端。
// mock res 无法暴露「res.end() 后立刻 req.destroy() 会丢掉写缓冲」这类问题
//（评审实测：33MB 超限请求客户端只拿到 ECONNRESET 而不是 413），所以这里起
// 一个真 http server，按框架语义（最长前缀优先）分发到同一个 handler。
if (token) {
  const http = await import('node:http');
  const routesForHttp = routes.filter((r) => r.path.startsWith('/wallpaper-engine/'));
  const server = http.createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://x').pathname;
    const hit = routesForHttp
      .filter((r) => path === r.path || path.startsWith(r.path + '/'))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!hit) { res.statusCode = 404; res.end('no route'); return; }
    try { hit.handler(req, res); } catch (err) { res.statusCode = 500; res.end(String(err)); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const sendOver = (method, path, body) => new Promise((resolveFn) => {
    // agent:false + Connection:close —— 413 路径会主动断开连接（设计如此），
    // 复用 keep-alive 套接字会让后续请求假性 ECONNRESET。
    const req = http.request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { 'Content-Type': 'image/png', Connection: 'close' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolveFn({ status: res.statusCode }));
      res.on('close', () => resolveFn({ status: res.statusCode }));
    });
    // 连接被对端掐断（旧实现的症状）→ 状态记 0，便于断言区分。
    req.on('error', () => resolveFn({ status: 0 }));
    if (body) req.write(body);
    req.end();
  });
  const overLimit = await sendOver('PUT', '/wallpaper-engine/scene-frame-cache/' + token, Buffer.alloc(33 * 1024 * 1024, 5));
  check('真 socket：超限 PUT 收到 413（而不是连接被掐断）', overLimit.status === 413, 'status=' + overLimit.status);
  const badBody = await sendOver('PUT', '/wallpaper-engine/scene-frame-cache/' + token, Buffer.from('not-an-image'));
  check('真 socket：非法载荷收到 415', badBody.status === 415, 'status=' + badBody.status);
  const cleared = await sendOver('DELETE', '/wallpaper-engine/scene-frame-cache/' + token);
  check('真 socket：DELETE 清除通道可达', cleared.status === 200, 'status=' + cleared.status);
  const headOver = await new Promise((resolveFn) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'HEAD', path: '/wallpaper-engine/scene-frame/' + token }, (res) => {
      res.resume();
      resolveFn({ status: res.statusCode, gpu: res.headers['x-we-gpu'] });
    });
    req.on('error', () => resolveFn({ status: 0 }));
    req.end();
  });
  check('真 socket：HEAD 探测可达且报 X-WE-GPU', headOver.status === 204 || headOver.status === 404,
    'status=' + headOver.status + ' gpu=' + headOver.gpu);
  await new Promise((r) => server.close(r));
}
if (typeof dispose === 'function') dispose();
delete process.env.DSH_WE_STEAM_ROOT;
rmSync(join(root, '.test-cache', 'scene-fixture'), { recursive: true, force: true });

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
