// Verify the resource-lifecycle invariants that were just fixed, so a leak can
// never silently regress again (this project's leaks have regressed repeatedly,
// so they must be ASSERTED, not merely observed).
//
// Static source assertions (cheap, robust) plus real runtime assertions against
// the actual modules:
//
//   S1 lib/we-renderer/core.js render() must CALL scratchRecallAll() — the
//      historical bug was "defined and imported but never called anywhere", so
//      every effect object stranded one full-frame scratch buffer per frame
//      (4K = 33MB × 240 frames).
//   S2 lib/we-renderer/gpu-gl/gl-core.js must destroy headless-gl contexts via
//      STACKGL_destroy_context from a destroy helper, and that helper must be
//      reached from the reset/dispose paths (contexts used to be dropped on the
//      floor and only GC could reclaim them — upstream requires manual destroy).
//   S3 lib/index.js disposer must clearInterval() the event-loop monitor and
//      ensuredDirs.clear() (a module-level interval + an unbounded memo Set
//      survived every unload / HMR re-apply).
//   S4 lib/index.js upload route must register a req 'close' handler that
//      destroys the write stream and unlinks the .tmp (an aborted upload used to
//      leak an fd + up to 512MB of .tmp).
//   S5 lib/index.js must have a size-capped cache sweep and must CALL it (the
//      transcode / scene-frame caches were append-only → unbounded GB growth).
//   S6 lib/index.js spawnFfmpeg must re-check signal.aborted right after
//      spawn() (an abort landing between the check and the spawn respawned an
//      untracked encoder that ran to the 15-minute timeout).
//   S7 the beta scene-anim path (betaSceneAnim / scene-anim) must be fully gone from
//      client AND host — it used to own timers (1.5s poll / 15min maxWait / 60s delay)
//      and a probe <video> that outlived the fiber. The surviving long-lived timers
//      (transcode upgrade poll + module-level persistTimer) must still be cleaned in
//      the fiber dispose block.
//   S8 src/client.js must remove its pagehide / visibilitychange listeners in
//      cleanup (module-scope listeners stacked on every reload).
//   S9 src/client.js every fetch-based progress poller must carry an in-flight
//      guard (a slow host used to accumulate one fetch per tick, forever). The
//      scene-anim progress poller was removed with the beta path, so the surviving
//      fetch poller is the transcode one — the check is "all fetch pollers guarded,
//      and at least one exists", not a fixed count.
//      Non-fetch timers (the WebWallGL live heartbeat) are out of scope — their
//      lifecycle is covered by stopLiveWatch()'s clearInterval.
//   R1 lib/we-renderer/effects/_scratch.js pool: borrow → "out", return/recall →
//      free again, next borrow reuses the same buffer (帧首召回 reclaims it).
//   R2 lib/pkg-extract.js scene-frame fallback cannot return an image wider than
//      the FALLBACK_MAX_WIDTH = 3840 cap (upstream issue #86). Exercised through
//      the real exported entry point on a tiny synthetic scene fixture.
//
// Usage: node scripts/verify-resource-lifecycle.mjs
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { extractSceneMainImageFromDir } from '../lib/pkg-extract.js';
import { SCRATCH_U8, scratchGet, scratchPut, scratchRecallAll, isScratch } from '../lib/we-renderer/effects/_scratch.js';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
function assert(cond, name, detail) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + name + (detail ? ' — ' + detail : ''));
}

const REPO = new URL('../', import.meta.url);
function read(rel) { return readFileSync(new URL(rel, REPO), 'utf8'); }
function lineOf(text, idx) { return idx < 0 ? -1 : text.slice(0, idx).split('\n').length; }
function countMatches(text, re) { return (text.match(re) || []).length; }

// ── Minimal zero-dependency PNG encoder (RGBA8, filter 0) ────────────────────
// The fallback-cap fixture needs a real, decodable PNG payload; node:zlib is
// built in, so no new dependency is introduced for the guard.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Colourful (never grayscale, always high-variance) RGBA PNG so the extractor's
 *  quality gate accepts it deterministically — no Math.random dependence. */
function makePng(width, height) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 4;
      raw[o] = (x * 251) & 0xff;
      raw[o + 1] = (y * 97 + 11) & 0xff;
      raw[o + 2] = 200;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
/** Weave an embedded-PNG payload into a minimal WE TEX container (TEXV0005 /
 *  TEXI0001 / TEXB0001, format 0 = RGBA8888, one image / one mip). */
function makeTex(png, width, height) {
  const nstr = (s) => Buffer.from(s + '\0', 'latin1');
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v, 0); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
  return Buffer.concat([
    nstr('TEXV0005'), nstr('TEXI0001'),
    i32(0), i32(0), i32(width), i32(height), i32(width), i32(height), u32(0),
    nstr('TEXB0001'), i32(1), i32(1),
    i32(width), i32(height), i32(png.length), png,
  ]);
}

const FALLBACK_CAP = 3840; // lib/pkg-extract.js FALLBACK_MAX_WIDTH
const FIXTURE_W = 4096; // deliberately wider than the cap
const FIXTURE_H = 16;

async function main() {
  const files = {
    core: read('lib/we-renderer/core.js'),
    glcore: read('lib/we-renderer/gpu-gl/gl-core.js'),
    gleffect: read('lib/we-renderer/gpu-gl/gl-effect.js'),
    glmultipass: read('lib/we-renderer/gpu-gl/gl-multipass.js'),
    index: read('lib/index.js'),
    pkg: read('lib/pkg-extract.js'),
    client: read('src/client.js'),
  };

  // ── S1: render() CALLS scratchRecallAll (import alone is the historical bug) ─
  {
    const start = files.core.indexOf('\n  render() {');
    const end = start < 0 ? -1 : files.core.indexOf('\n  }', start);
    const body = start >= 0 && end > start ? files.core.slice(start, end) : '';
    const callIdx = body.search(/scratchRecallAll\s*\(/);
    check('S1 lib/we-renderer/core.js render() CALLS scratchRecallAll (not merely imported)',
      callIdx >= 0,
      callIdx >= 0 ? 'call at core.js:' + lineOf(files.core, start + callIdx) : 'no scratchRecallAll(...) call inside render()');
  }

  // ── S2: STACKGL_destroy_context in the destroy helper, reached from both paths
  {
    const def = files.glcore.indexOf('export function destroyGLContext');
    const close = def < 0 ? -1 : files.glcore.indexOf('\n}', def);
    const helper = def >= 0 && close > def ? files.glcore.slice(def, close) : '';
    const helperUsesExt = /STACKGL_destroy_context/.test(helper);
    const resetUses = /for \(const gl of Array\.from\(_contexts\)\)\s*destroyGLContext\(gl\)/.test(files.glcore);
    const disposePaths = /destroyGLContext\(_gl\)/.test(files.gleffect) && /destroyGLContext\(_gl\)/.test(files.glmultipass);
    check('S2 gl-core.js destroy helper calls STACKGL_destroy_context and is reached from resetGPU + dispose paths',
      helperUsesExt && resetUses && disposePaths,
      'helperExt=' + helperUsesExt + ' resetGPU=' + resetUses + ' dispose(gl-effect,gl-multipass)=' + disposePaths);
  }

  // ── S3: plugin disposer clears the event-loop interval + ensuredDirs memo ────
  {
    const idx = files.index.indexOf('for (const d of disposers)');
    const tail = idx < 0 ? '' : files.index.slice(idx);
    const clearsInterval = /clearInterval\(evtLagTimer\)/.test(tail);
    const clearsDirs = /ensuredDirs\.clear\(\)/.test(tail);
    check('S3 lib/index.js disposer clearInterval()s the event-loop monitor AND ensuredDirs.clear()',
      clearsInterval && clearsDirs,
      'clearInterval=' + clearsInterval + ' ensuredDirs.clear=' + clearsDirs);
  }

  // ── S4: aborted upload → req 'close' destroys the stream + unlinks the .tmp ──
  {
    const idx = files.index.indexOf("const tmpAbs = fileAbs + '.tmp'");
    const win = idx < 0 ? '' : files.index.slice(idx, idx + 6000);
    const onClose = /req\.once\(\s*'close'/.test(win);
    const destroys = /ws\.destroy\(\)/.test(win);
    const unlinks = /unlinkSync\(tmpAbs\)/.test(win) && /cleanupTmp\(\)/.test(win);
    check('S4 upload path registers a req close handler that destroys the write stream and unlinks the .tmp',
      onClose && destroys && unlinks,
      'reqClose=' + onClose + ' ws.destroy=' + destroys + ' cleanupTmp+unlink=' + unlinks);
  }

  // ── S5: size-capped cache sweep exists AND is called ────────────────────────
  {
    const sweepDef = /function pruneCacheDirBySize\s*\(/.test(files.index);
    const caps = /const TRANSCODE_CACHE_MAX_BYTES\s*=\s*\d/.test(files.index)
      && /const FRAME_CACHE_MAX_BYTES\s*=\s*\d/.test(files.index);
    const calledTranscode = /pruneCacheDirBySize\(\s*transcodeCacheDir\(\)/.test(files.index);
    const calledFrame = /pruneCacheDirBySize\(\s*frameCacheDir\(\)/.test(files.index);
    check('S5 lib/index.js size-capped cache sweep exists and is CALLED for the transcode + scene-frame caches',
      sweepDef && caps && calledTranscode && calledFrame,
      'def=' + sweepDef + ' caps=' + caps + ' called(transcode,frame)=' + calledTranscode + ',' + calledFrame);
  }

  // ── S6: after spawning ffmpeg the abort signal is RE-checked ────────────────
  {
    const def = files.index.indexOf('function spawnFfmpeg(');
    const body = def < 0 ? '' : files.index.slice(def, def + 6000);
    const tracked = body.indexOf('ACTIVE_FFMPEG.add(proc)');
    const tail = tracked < 0 ? '' : body.slice(tracked);
    const recheck = /if\s*\(\s*signal\s*&&\s*signal\.aborted\s*\)/.test(tail);
    const kills = /proc\.kill\(\)/.test(tail);
    check('S6 spawnFfmpeg re-checks signal.aborted after spawn() and kills the untracked child',
      tracked >= 0 && recheck && kills,
      tracked < 0 ? 'ACTIVE_FFMPEG.add(proc) not found in spawnFfmpeg' : 'postSpawnRecheck=' + recheck + ' proc.kill=' + kills);
  }

  // ── S7: the beta scene-anim path is fully gone; the surviving timers are still cleaned ──
  // beta 场景动画 (betaSceneAnim / scene-anim) 曾有一整套比 fiber 活得更久的资源
  // (1.5s 轮询 / 15min maxWait / 60s 延迟 timer + 探针 <video>), 靠 fiber dispose 里的
  // cancelSceneAnimUpgrade() 清理。该路线已随 WebWallGL 实时渲染移除 —— 这里既守住
  // "不再复活", 也要求 dispose 仍清理剩余的长命资源 (转码升级轮询 + 模块级 persistTimer)。
  {
    const effStart = files.client.indexOf('const unsub = subscribe(syncLayers);');
    const disposeIdx = files.client.indexOf('disposed = true;');
    const disposeBody = effStart >= 0 && disposeIdx > effStart ? files.client.slice(disposeIdx, disposeIdx + 3000) : '';
    const inFiberDispose = effStart >= 0 && disposeIdx > effStart;
    const cleansTranscode = /abortTranscodeUpgrade\(\)/.test(disposeBody);
    const cleansPersist = /clearTimeout\(persistTimer\)/.test(disposeBody);
    // 只看**代码模式**, 不看注释 —— 允许在注释里记述这段历史 (如缓存清扫那条)。
    const clientGone = !/sceneAnim|cancelSceneAnimUpgrade|queueSceneAnimUpgrade|betaSceneAnim/.test(files.client);
    const hostGone = !/\$\{BASE\}\/scene-anim/.test(files.index)
      && !/^\s*betaSceneAnim\s*:/m.test(files.index);
    check('S7 beta scene-anim path removed (client + host); fiber dispose still cleans abortTranscodeUpgrade + persistTimer',
      inFiberDispose && cleansTranscode && cleansPersist && clientGone && hostGone,
      'fiberDispose=' + inFiberDispose + ' abortTranscodeUpgrade=' + cleansTranscode
        + ' persistTimer=' + cleansPersist + ' clientClean=' + clientGone + ' hostClean=' + hostGone);
  }

  // ── S8: pagehide / visibilitychange listeners are REMOVED in cleanup ────────
  {
    const effStart = files.client.indexOf('const unsub = subscribe(syncLayers);');
    const disposeIdx = files.client.indexOf('disposed = true;');
    const effectBody = effStart >= 0 && disposeIdx > effStart ? files.client.slice(effStart, disposeIdx) : '';
    const disposeBody = effStart >= 0 && disposeIdx > effStart ? files.client.slice(disposeIdx, disposeIdx + 3000) : '';
    const addsPerFiber = /addEventListener\(\s*["']pagehide["']/.test(effectBody)
      && /addEventListener\(\s*["']visibilitychange["']/.test(effectBody);
    const removesPagehide = /removeEventListener\(\s*["']pagehide["']/.test(disposeBody);
    const removesVis = /removeEventListener\(\s*["']visibilitychange["']/.test(disposeBody);
    check('S8 src/client.js pagehide + visibilitychange listeners are removed in cleanup',
      addsPerFiber && removesPagehide && removesVis,
      'addedInFiber=' + addsPerFiber + ' removedPagehide=' + removesPagehide + ' removedVisibility=' + removesVis);
  }

  // ── S9: fetch-based progress pollers carry an in-flight guard ───────────────
  // 判据按「该轮询是否发 fetch」划分, 而不是写死站点数量 —— 上游 #103 的
  // WebWallGL 心跳 (startLiveWatch) 是第 3 个 setInterval, 但它是同步 tick、
  // 不发 fetch, 不适用 in-flight 守卫 (其计时器由 stopLiveWatch 清理)。
  {
    const re = /setInterval\s*\(/g;
    const sites = [];
    let m;
    while ((m = re.exec(files.client))) sites.push(m.index);
    let pollers = 0;
    let guarded = 0;
    const names = new Set();
    for (const i of sites) {
      const win = files.client.slice(Math.max(0, i - 2000), i + 2000);
      if (!/fetch\s*\(/.test(win)) continue; // 非 fetch 轮询 (live 心跳) 不适用
      pollers++;
      const decl = win.match(/let\s+(\w*[Pp]ending)\s*=\s*false/);
      if (decl && new RegExp('if\\s*\\(\\s*' + decl[1] + '\\s*\\)\\s*return').test(win)) {
        guarded++;
        names.add(decl[1]);
      }
    }
    check('S9 src/client.js every fetch-based progress poller carries an in-flight (pending) guard',
      pollers >= 1 && guarded === pollers,
      guarded + '/' + pollers + ' fetch pollers guarded' + (names.size ? ' (' + [...names].join(', ') + ')' : '') + ' (>=1: 至少抽帧进度轮询必须在)');
  }

  // ── R1: scratch pool really reclaims borrowed buffers ───────────────────────
  {
    const a = scratchGet(SCRATCH_U8, 64);
    const b = scratchGet(SCRATCH_U8, 64);
    const bothOut = isScratch(a) && isScratch(b) && a !== b; // never alias an "out" buffer
    scratchPut(a);
    const putFreed = !isScratch(a);
    scratchRecallAll();
    const recallFreed = !isScratch(b);
    const c = scratchGet(SCRATCH_U8, 64);
    const reused = c === a || c === b; // pooled memory actually came back
    check('R1 _scratch pool: borrow → out, put/recall → free, next borrow REUSES the buffer (frame recall)',
      bothOut && putFreed && recallFreed && reused,
      'borrowed=2/2 distinctOut len=' + a.length
        + ' putFree=' + putFreed + ' recallFree=' + recallFreed + ' recallReused=' + reused);
  }

  // ── R2: scene-frame fallback is capped at FALLBACK_MAX_WIDTH (upstream #86) ─
  {
    const capConst = new RegExp('const FALLBACK_MAX_WIDTH = ' + FALLBACK_CAP + ';').test(files.pkg);
    const capArgs = countMatches(files.pkg, /,\s*FALLBACK_MAX_WIDTH\)/g);
    const capGuard = /!\(frame\.width > maxWidth\)/.test(files.pkg);
    const staticOk = capConst && capArgs === 2 && capGuard;

    let dir = null;
    let fixtureErr = null;
    let frame = null;
    let frameErr = null;
    try {
      dir = mkdtempSync(join(tmpdir(), 'we-lifecycle-'));
      writeFileSync(join(dir, 'scene.json'), JSON.stringify({ objects: [{ image: 'main.tex' }] }));
      writeFileSync(join(dir, 'main.tex'), makeTex(makePng(FIXTURE_W, FIXTURE_H), FIXTURE_W, FIXTURE_H));
    } catch (e) {
      fixtureErr = e;
    }
    if (dir && !fixtureErr) {
      try { frame = extractSceneMainImageFromDir(dir); } catch (e) { frameErr = e; }
    }
    // Always remove the fixture, including the failed-extraction path.
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

    if (fixtureErr || !dir) {
      // No writable temp area: fall back to the static cap path and SAY SO.
      check('R2 scene-frame fallback is capped at FALLBACK_MAX_WIDTH=' + FALLBACK_CAP + ' (upstream #86)',
        staticOk,
        'static-only (temp fixture unavailable: ' + (fixtureErr && fixtureErr.message) + ')'
          + '; capConst=' + capConst + ' capCallSites=' + capArgs + ' guard=' + capGuard);
    } else if (frameErr) {
      check('R2 scene-frame fallback is capped at FALLBACK_MAX_WIDTH=' + FALLBACK_CAP + ' (upstream #86)',
        false,
        'extractor threw: ' + (frameErr && frameErr.message));
    } else {
      const runtimeOk = !!frame && frame.width <= FALLBACK_CAP && frame.width < FIXTURE_W
        && String(frame.downscaledFrom || '') === FIXTURE_W + 'x' + FIXTURE_H;
      check('R2 scene-frame fallback is capped at FALLBACK_MAX_WIDTH=' + FALLBACK_CAP + ' (upstream #86)',
        staticOk && runtimeOk,
        FIXTURE_W + 'x' + FIXTURE_H + ' → ' + frame.width + 'x' + frame.height
          + ' downscaledFrom=' + (frame.downscaledFrom || '(none)')
          + ' capConst=' + capConst + ' capCallSites=' + capArgs + ' guard=' + capGuard);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL RESOURCE LIFECYCLE CHECKS PASSED'
    : failed.length + ' CHECK(S) FAILED'));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
