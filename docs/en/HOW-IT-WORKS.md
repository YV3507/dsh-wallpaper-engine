# How it works

> **中文**: [`../HOW-IT-WORKS.md`](../HOW-IT-WORKS.md)（与本文同源：改一处请同步另一处）
>
> This document covers **user-visible behaviour** (why a wallpaper renders the way it does, and what
> happens when it fails). **Code structure** is in [`CODE-STRUCTURE.md`](../CODE-STRUCTURE.md);
> **why it was designed that way** is in [`adr/`](../adr/). It deliberately **carries no drifting
> numbers** — counts, sizes and timeout thresholds point at the implementation or give a way to
> recompute them (see [`README.md`](../README.md) §写作纪律 4).

### The default form for scene / web wallpapers: WebWallGL live rendering

**Scene and web wallpapers render live by default** (setting `sceneLive`, UI labels 「场景实时渲染」 /
「网页实时渲染」, on by default) — the renderer is the **upstream WebWallGL page** (version pinned in `lib/webwallgl/.upstream.json`), vendored under
`lib/webwallgl/` and mounted by the host with `/wallpaper-engine/scene-live/` as its base (asset
references resolve under that prefix); the wallpaper's own files (`scene.pkg` / web project files) are
served through `/wallpaper-engine/scene-files/`. For web wallpapers the host injects the WE API shim
(`lib/webwallgl/web-shim.js`) and the `project.json` property seed into the returned HTML — under the
strict sandbox the renderer page cannot reach into the wallpaper iframe, so the shim must ride along
with the document.

- **When live rendering is skipped**: the wallpaper switch is off, the wallpaper is in the **failure
  memory** (first-frame timeout, or **no frames for a sustained run** at runtime — the heartbeat ticks
  once per second, auto-`resume()`s once at `LIVE_STALL_TICKS` ticks as a self-rescue, and only declares
  `stall` at twice that), or the scene is a **loose `scene.json` directory**. It then falls back to the **out-figure
  chain** below (which is allowed to come up honestly empty).
  **The first-frame timeout is not a fixed wall clock** (the large-package fix): the first
  frame **cannot exist before the whole package has arrived**, so the budget is computed from the
  **package size** by `liveFirstFrameBudget()` (`src/live-layer.js`) and carries a ceiling; and the host
  keeps a **payload ledger**
  (`GET /wallpaper-engine/scene-payload-progress?token=…`, see [`ROUTE-INDEX.md`](../ROUTE-INDEX.md))
  that resets the clock every tick while bytes are still arriving — "still downloading" is no longer
  read as "cannot render". **Hidden / non-playing instances never pull the payload at all** (the
  iframe gets its `src` late, and going to the background swaps it for `about:blank`, which aborts the
  in-flight request): such an instance cannot produce frames anyway (Chromium freezes rAF of hidden
  pages) and it would otherwise compete for bandwidth and decoders with the instance that *is* visible.
  **When there really is no first frame, the cause decides the bookkeeping**: the ledger saying
  "transferred but never completed" ⇒ only a **session-local** soft failure (never the shared failure
  memory every window reads), with an automatic retry after a cooldown and a bounded number of attempts
  (both are constants in `src/live-layer.js`: `LIVE_TRANSFER_RETRY_DELAY_MS` / `LIVE_TRANSFER_RETRY_LIMIT`); only a
  renderer that genuinely never produces a frame, or loses its heartbeat, is persisted.
- **Out-figure sources (the one authoritative order; code in `lib/routes/scene-frame.js`)**:
  ① live-render iframe → ② the author-embedded MP4 (`sceneVideo`) → ③ **live-captured frame**
  (`<key>_gpu.png`, PUT back by the live page once the first frame lands) → ④ **custom frame** (a
  screenshot the user imported) → ⑤ **empty state** (404 with a machine-readable reason).
  **No black screen before the first frame**: the placeholder still is chosen as **live-captured frame →
  the author's packaged project preview → the theme colour** (`buildLivePoster`) — on a wallpaper's
  **first** activation the captured frame does not exist yet (this live session has to backfill it), so
  the author's preview stands in and is displaced the moment the live first frame lands. It is only a
  placeholder and is **never treated as "this wallpaper's out-figure"**.
  `?v=4` forces the custom frame and is **exempt** from the captured frame (an explicit pin is never
  displaced by a capture); `?v=1/2/3` are retired and clamped to 0.
- **Why there is no CPU fallback image any more (the P2-12 design decision)**: 0.6–0.7.x fell back to an
  offline scene renderer / main-texture extraction / the workshop preview image. All three could
  **"succeed" by producing a poor image** — bypassing the quality gate, caching a blurry frame, and
  turning a decidable fact ("this wallpaper has no usable picture") into something that looks like a
  normal frame. The whole line (renderer + extraction + compositor, ~10k lines) is gone; the contract
  now is **either a real picture or an honest blank** (the status row names the reason).
  ⚠️ **That ruling governs the server-side "out-figure"**: `/scene-frame` never produces a guessed
  image. The client's **pre-first-frame / empty-frame placeholder** still uses the **author's packaged
  preview** (the author's own image, not one this plugin synthesised) — it only holds until the live
  first frame or a user-imported custom frame appears.
- **Frame rate**: 「实时渲染帧率」 (15 / 30 / 60 fps) is passed through the iframe query.
- Guards: `test/verify-scene-live.mjs` (live chain), `test/verify-scene.mjs` (out-figure chain + cache).

### Scene rendering: how it works

Scenes are rendered live by the bundled **WebWallGL engine** (vendored under `lib/webwallgl/`; it parses
`scene.pkg` / loose `scene.json` itself and replays the object tree, textures, particles and shaders,
preferring the GPU and falling back to software): in WebGL2 it renders every image layer in real time
(shader effects such as waterwaves / waterripple translated from HLSL and executed on the GPU), puppet
skeletal models, particle systems and text objects, and runs the scene's own SceneScript — mouse
movement drives parallax / cursor interaction, and packaged audio (BGM / SFX) plays under the shared
volume / audio-switch settings and drives the audio-reactive effects.

The scene card's **type** badge in the picker reads 「场景」; `/scene-live` + `/scene-files` are its data
plane. The host contract is just two things: **feed the scene files to the render page on demand**, and
**keep the frame it captures** (③ above).

### Web wallpapers: implementation details & known limits

**Web wallpapers** go through WebWallGL too: the host injects the **WE API shim**
(`wallpaperRegisterAudioListener` / `wallpaperPropertyListener` / media listeners, from upstream
`web-shim.js`, injected into the entry HTML by `/scene-files`) and hands the page to the renderer — so
workshop web wallpapers that depend on the WE API (audio visualizers, property-driven and
pointer-tracking pages) actually run instead of rendering blank or erroring. **Security**: the wallpaper
iframe is forced into `sandbox="allow-scripts"` (strict sandbox) so the third-party HTML can never
inherit the DSH origin (it cannot call host APIs or read host storage as the app). Cross-origin control
and pointer injection go through the renderer page's `postMessage` channel. On load failure or a stalled
runtime the wallpaper is remembered and degrades to the legacy plain iframe (no WE API).

> **Payload origin (separate media origin)**: **a web wallpaper's entry HTML plus all of its subresources**,
> and **a scene wallpaper's `scene.pkg` (measured at 336 MB on the reporter's machine; the earlier
> "often 70–90 MB" is out of date)**, are served by a **dedicated loopback media
> origin the host opens itself** (a random port on `127.0.0.1`, reported by
> `GET /wallpaper-engine/media-origin`) — *not* by the plugin's HTTP routes (the app origin stays the
> fallback for when that origin cannot start). Why: DSH Desktop
> wraps every plugin route in a capability-header fence (`x-dsh-desktop-renderer`, injected only into
> requests issued by same-origin frames), and a strict-sandbox iframe is an opaque origin that can never
> carry that header — the wallpaper entry would always answer `403 Forbidden` (symptom: the preview frame
> looks fine, then the wallpaper goes fully black). The media origin bypasses that fence, and third-party
> HTML no longer shares the host origin at all, so the sandbox gets a second layer of isolation.
> **A scene wallpaper takes it for payload speed**: a large `scene.pkg` cannot fit the first-frame budget
> on the app-origin path (which must also buy texture decode and shader compile), so the host points its
> payload at the media origin **unconditionally**. **`scene.pkg` is also revalidatable-cacheable**: the
> response carries `ETag` (size+mtime) + `Last-Modified`, and a matching conditional request answers `304`
> with no body — re-reading a few hundred MB from disk on every live-layer rebuild is exactly what this
> removes (the entry HTML stays `no-store`: it carries the injected shim and the property seed).
>
> **When that second listener is actually opened** (adapter mode, set under 「高级 → 适配」): **the scene
> payload is independent of the adapter form** — its reason for a separate origin is **bandwidth**, which
> holds in a plain browser too, so `inventory.sceneMediaBase` no longer collapses to an empty string just
> because the surface looks like a browser (that old behaviour sent big packages down the path that
> starves; fixed 2026-09). The **web wallpaper** half is still gated on the capability header (the fence
> only exists on desktop shells): the host observes
> the **capability header** and **`Electron/` in the UA** per request — either one marks a desktop surface and
> the media origin starts as before; when neither is present (**a plain web browser**) there is no fence, so the
> web payload is served from the app origin as a **relative path**. The same mount handler serves both, so the two
> forms differ only in the URL. It starts **lazily, on demand**: when the library holds a
> web wallpaper, or when it holds a **live-renderable scene** (`sceneLive`); the scene origin reaches the client
> as `inventory.sceneMediaBase` (**an empty string now means only "it could not start" ⇒ fall back to the app
> origin**; the layer key carries this value, so the renderer page is rebuilt once the host manages to offer it).
> A manually picked
> adapter target forces either direction, and
> `GET /wallpaper-engine/media-origin` is an explicit probe that starts it on demand without going through
> this gate.

> **Frame cap and "it still stutters"**: the wallpaper's rAF cap is implemented by **frame skipping** —
> every vsync is kept so the delivered frame stays phase-aligned with the display and only every n-th
> frame reaches the page (a `setTimeout`-based cap yields 17/33/50 ms jitter, which looks worse). While
> live, a `live-fps` line is written to the diagnostics file every 5 s: `ui=` whole-page fps, `web=` the
> wallpaper's own fps, `rnd=` renderer-page fps, `cap=` the current cap. If it still feels heavy, that
> line tells you whether the wallpaper itself is slow (`web` low) or the whole page is (`ui` low too —
> e.g. the sidebar's `backdrop-filter` re-sampling the wallpaper every frame; try lowering the blur to
> confirm).

> **Known limits**: author `fetch`/`XHR` carries `Origin: null` under the opaque origin (the host answers
> with `Access-Control-Allow-Origin: *`, so ordinary resources load); `wallpaperMediaIntegration` (system
> Now Playing / cover art) **is** supplied by the host; CSS `:hover` interaction driven by the browser's
> own hit-test cannot be triggered by external pointer injection (as documented upstream).

### Host / client split

- **Host half** (`lib/index.js` + `lib/routes/*.js`): a Cordis plugin that
  1. locates the Wallpaper Engine install by reading Steam's `libraryfolders.vdf` (so it works even when Steam is on a non-default drive),
  2. enumerates wallpapers from `projects/defaultprojects`, `projects/myprojects`, and `steamapps/workshop/content/431960/*`,
  3. registers same-origin HTTP routes on the DSH webserver so the browser half can fetch data and stream media directly. They are grouped by responsibility — **assets** · **transcode** · **live rendering** · **out-figure & capture** · **settings & system**.
     **The authoritative list (each route's source line, registration shape and context contract) is [`ROUTE-INDEX.md`](../ROUTE-INDEX.md)** — this file no longer hand-writes the path table *or a route count* (hand-writing always rots: that table long listed `/scene-runtime`, `/scene-manifest` and `/scene-resource`, **all three deleted**, while missing most of the routes that existed; the count drifted the same way).
- **Client half** (`lib/client.js`): a browser module that fetches the inventory and renders the selected
  wallpaper into a fixed layer *behind* the app columns, plus a **first-level settings page**
  "Wallpaper Engine" (liquid-glass card, picker modal, hide/restore, playback speed / flip, accent color +
  glass transparency, and custom-upload management).
- **Custom-upload storage**: uploaded files are written to a plugin-managed local directory (default
  `~/.dsh-wallpaper-engine/uploads`, changeable from the settings UI) and served through the same
  `/media` + `/preview` routes as WE media — identical pipeline, survives restarts, no browser quota limits.

> Development details (build artifacts, hot-mount rules, cache-key prefixes) live in
> [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

### Font sets: where a whole look lives

A font set is **one `.json` file that describes the entire typography look** — role tokens (body /
secondary / dimmed / headings / code / table …), per-component overrides and the caret. Switching a set
switches all of them at once, which is what "one look" means here.

- **Two layers, and the user layer wins**: a set ships **with the package** under `lib/fontsets/`
  (read-only), and edits are written to the **user layer** under the plugin data directory. Editing a
  shipped set is **copy-on-write**: the user layer gets its own copy, and deleting that copy restores the
  shipped original — there is no "reset" command, because deleting *is* the reset.
- **Import / export is a plain `.json` round trip**: export goes through a host response header plus an
  ordinary link, so on desktop it is the system's own "Save as".
- **What is *not* persisted in settings**: the per-item font values. `config.json` keeps only the root
  fields (which set is active, plus the free-form custom entries); the keys themselves are defined once in
  `lib/settings-schema.js` and shared by the client and the host, so both sides sanitise the same way.
- **Guards**: `test/verify-fontset.mjs` (the whole feature) + `test/fontset-load-smoke.mjs` (loading).
  The three font channels and their invariants live in the file headers under `src/font/` — see
  [`FONT-SYSTEM.md`](../FONT-SYSTEM.md) for the index.

### Captured-frame geometry validation (viewport aspect ratio)

A captured frame is "the composition of the renderer viewport at the moment of capture" — the renderer
frames by canvas ratio (within 2 % of the scene's design ratio it shows the whole design, otherwise it
covers by canvas ratio), and the frame is then laid out through CSS `object-fit: cover` again. So a frame
captured in **another window / an older session** gets cropped a second time on screen: measured, a
1440×960 (3:2) frame in a 2488×1376 viewport shows only 84.5 % of the scene's design width (from a
best-match fit against a CPU frame), with subjects ~19 % larger than live and cut off on all sides. The
host therefore attaches `X-WE-GPU-W/H/AR` to `HEAD /scene-frame/<token>` (read from the PNG's IHDR, pure
file header, no extraction), and the client compares it with the current viewport: a relative difference
> 2 % (the same tolerance the renderer uses for its own fit) or an unknown geometry (old host / unreadable
file) triggers **capture → content gate → clear the slot → PUT** (clearing after capturing, because a
capture failure that left an empty slot would fall back to a CPU frame — worse than keeping an
old-composition frame). Once stored, the still frame is re-mounted in place and a `gpu-frame-stale` /
`gpu-frame-recaptured` diagnostics line is written. Old frames therefore heal themselves on the next
mount / rotation; no manual cleanup is needed.

### Empty-frame gate & clear channels

A byte-size threshold is unreliable (measured black PNGs from a headless run: 960×540 ≈ 12 KB,
1080p ≈ 44 KB, 4K ≈ 165 KB — all far above any fixed gate), so before storing a capture the canvas is
downsampled to `LIVE_FRAME_SAMPLE` and its brightness distribution inspected: near-black or almost no
contrast means "nothing has been rendered yet" and the capture is abandoned (the CPU frame stays), plus a
resolution-scaled size floor.
**The sampling edge and the four thresholds are constants in `src/live-layer.js`**
(`LIVE_FRAME_SAMPLE` · `LIVE_FRAME_LIT_RATIO` · `LIVE_FRAME_MIN_VARIANCE` · `LIVE_FRAME_BYTES_PER_PX`);
this document does not copy their values — they are **tunable parameters**, and a copy here would drift
away from the implementation. When a capture is unsatisfactory there are three entries under
**Settings → Effects → Picture → 「实时帧」**: the **thumbnail preview** (the very still shown during a
switch / before the live first frame, same URL as the one in use — with its pixel dimensions),
**「重新截」** (re-capture the **current** picture and replace the cache; if it fails the old frame stays,
with the reason shown inline), and **「清除 GPU 帧」** (equivalent to
`DELETE /wallpaper-engine/scene-frame-cache/<token>`, or `POST …?clear=1` — afterwards HEAD reports
`X-WE-GPU: 0`, the current tier takes effect immediately, and the next live session captures again).

> **This row is not gated on the live-rendering switch**: that live frame is exactly what is on screen
> during a switch and before the live first frame, so a wrong composition (black frame / old viewport /
> captured mid-transition) must be re-capturable **immediately** rather than after turning live rendering
> off and back on. By the same argument **「自定义画面」 is always shown** (an imported screenshot and live
> rendering do not interfere). Only **「出图来源」** (switching capture tiers) is hidden while live
> rendering is effective — changing tiers has no effect then, so showing it would only mislead.

### Occlusion pause: the verdict does **not** come from events alone

Pausing on occlusion is driven by `visibilitychange` / `blur` / `focus` events — and that has a hole
caused by **native modals**: `window.confirm` / `alert` hand focus to their own window, and the `focus`
event on the way back **is not guaranteed to arrive**. The verdict would then rest permanently on "not
visible", i.e. a wallpaper that never resumes. The host therefore runs an **idempotent timer poll as a
second leg**: if the page is the visible document and its `visibilityState` says so, the verdict goes
back to "playing" even when no event ever arrived — and while the occlusion pause is in force the poll
interval is deliberately short so a missed resume is corrected within a beat rather than after minutes.

- The three switches (minimize / switch tab, window focus loss, on battery) are defaults in
  `lib/settings-schema.js` — **the panel is the source of truth for their current values**, this document
  does not copy them.
- 「窗口失焦时暂停」 is **only offered when the adapter target is a plain browser**: a desktop shell keeps
  the wallpaper visible while unfocused, so pausing on blur would freeze a picture the user can still see.
  The stored value is not deleted when the target changes — switching back re-enables it.
- On a hit, video wallpapers **stop decoding outright** (not merely throttled by the browser: the decoder
  goes idle), and a live scene stops its render loop. Coming back to the foreground / plugging in resumes
  automatically — except a wallpaper the user paused by hand, which is never auto-resumed.

### Theme follows the wallpaper: colour chain and the yield rule

After a switch the plugin decides the global light/dark theme (`src/theme-follow.js`, **no switch**). Colour order:

1. **The wallpaper's own scheme colour** — `general.properties.schemecolor.value` in `project.json`
   (a 0–1 float triple; in the WE editor its `text` is `ui_browse_properties_scheme_color`). The host's
   inventory already converts it to `rgb()` (`schemeColor`); an override you set in the **壁纸属性** panel
   wins over the author's value. **Almost every wallpaper in a real library carries the property** ⇒ almost
   none of them need any image work. An author value of exactly `0 0 0` counts as **unfilled** (the WE editor's
   default for new projects, and a substantial share of a real library) and falls through to ②; a pure black
   picked by hand in the panel is still honoured.
   > The hit rate is **not written down here**: it varies with *which wallpapers you have installed*, i.e. it
   > is a different number for every reader. To recompute it, tally the `schemeColor` field (the inventory
   > builder is the reference implementation).
2. **The most-occupied colour of the picture** — only when ① is missing: downsample the picture to
   `LIVE_FRAME_SAMPLE` and take the modal bucket after **4 bits/channel** quantisation (the quantisation
   rule and bucket count live in the colour-picking code in `src/theme-follow.js`; same
   downsample precedent as `liveFrameLooksUsable`). Two sources **vote**: the author's `preview` and a real rendered frame (scene wallpapers sample the frame the
   live renderer just captured, reusing that same read; web wallpapers use their `__wp.capture` result),
   and **a disagreement resolves to dark** — light only when both agree (a capture may land on a frame that has
   not settled yet). Neither ever overrides ①. Absolute URLs use `crossOrigin="anonymous"` (the media origin sends
   `Access-Control-Allow-Origin: *`), so the canvas is never tainted.
3. **Neither available ⇒ leave the theme alone** — no switch, no thrashing.

Verdict: WCAG relative luminance (the same coefficients as `test/verify-readability.mjs`) with a threshold of
**0.40** — "only clearly bright colours get a light UI" (not mid grey 0.2159: the author colours in this
library have a median luminance of 0.214, so that threshold cuts through the densest part of the distribution
and calls saturated mid-tones light while the eye reads them as dark).

The write goes through the host's client Cordis service `theme` (`setTheme('dark' | 'light')`, same API on the
official and community clients) and uses **the same handle** as our token layer (both come from that one
`ctx.get('theme')` poll; deliberately no `inject` declaration, see the token-layer block in src/client.js).
Three self-imposed rules live in the module header: **nothing is written when the verdict already matches**
(`setTheme` persists the preference into the profile's `cordis.patch.yml`), **a manual change makes it yield**
(re-evaluating the same wallpaper will not take it back; the next switch resumes), and **no theme service ⇒
the whole feature stays inert**.

### Client-side errors also leave a trace (`client-error`)

A failure that only happens in someone's browser leaves nothing behind on the host — so the client reports
the chain it actually walked to the host's diagnostics file. Anything that drives a downgrade (a live
renderer that never produced a frame, a capture that failed, a preview that could not be read) writes a
`client-error` line with the branch taken and the step it stopped at, which is why "it went black on my
machine" can be answered from the log instead of by guessing. This is a **diagnostics channel only**: it
never changes what the user sees, and it is the same ring the host's own `diag` family writes to (see
[`ROUTE-INDEX.md`](../ROUTE-INDEX.md)).

### Tests

`npm run verify` (the client / transcode / playback-control / scene / scene-live entries among others) plus
`npm run smoke` (rotation, rotation live node-level adoption, zero leftovers during rotation preparation,
GPU frame backfill, capture identity). Every assertion has a failure channel (a non-zero exit when it does
not hold); `npm run verify:all` = build + both suites + the soft tier.
**How many entries each chain has is not written here**: the source of truth is the `verify` / `smoke` /
`verify:docs` scripts in `package.json` (this line used to carry a hard-coded number, and it drifted).
