# Troubleshooting

> **中文**: [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)（与本文同源：改一处请同步另一处）

### Install failure: `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`

`dsh plugin --profile web add ...` forwards the command to **pnpm**. If you see this error:

```text
[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] Unexpected virtual store location
dsh: pnpm failed in profile directory C:\Users\xxx\.dsh-desktop\profiles\web
```

**This is not a problem with the plugin itself** (any plugin would fail the same way) — the pnpm
dependency state of that profile directory has gone stale. pnpm stores the virtual-store path
(an absolute path) in `node_modules\.modules.yaml`; if the profile directory was **moved / copied /
restored from a backup**, or the pnpm version / `virtual-store-dir` config changed, the recorded path
no longer matches, so pnpm refuses to install anything into that profile.

**Fix (Windows PowerShell):**

```powershell
# 1) Quit the DSH desktop app first
# 2) Remove the profile's dependency directory (only node_modules — config / installed plugin names are kept)
Remove-Item "$env:USERPROFILE\.dsh-desktop\profiles\web\node_modules" -Recurse -Force
# 3) Reinstall this plugin
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

> Deleting just `node_modules\.modules.yaml` also works (pnpm recreates it and continues); removing
> the whole `node_modules` is more thorough. If `.dsh-desktop` is touched by OneDrive / cloud sync /
> migration tools, add it to the sync exclusion list to avoid a recurrence.

### Install failure: `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

```text
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... The git-hosted package "dsh-plugin-wallpaper-engine@0.6.8"
needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

**You used a `github:` install form** (e.g. `dsh plugin --profile web add github:elysia395/dsh-wallpaper-engine`).
pnpm 11 blocks build scripts of git-hosted packages by default for supply-chain safety, and this
plugin's git checkout needs the `prepare` script to build the client — so `github:` direct installs
always fail. Use the **npm package name** instead (the published npm package is pre-built, no
compile-time build needed):

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

> If your plugin hub (dsh-plugin-hub) generated a `github:` command, upgrade it to **v1.4.1+** — the
> new version auto-resolves the npm package name and switches to the npm channel.

### Symptom → where to look first

| Symptom | Check first |
|---|---|
| The panel shows 「宿主里没有字体集路由…」 or 「宿主返回 404 / 405」 | The host is stale: **host-side code loads once at startup**, so a page refresh only swaps the client bundle. **Restart DSH** (`dsh web` again, or quit and reopen the desktop app). Two self-checks: ① `~/.dsh-wallpaper-engine/build-stamp.json`'s `at` must be later than `lib/index.js`'s mtime; ② search `diag/http.jsonl` for `fontsets` — **zero hits** means the request never reached the plugin (a bare status code can only come from another layer) |
| The settings panel suddenly goes blank / the whole UI whites out | Search the client-exception trace first: `client-error` (the message plus the first three stack frames, all in one diagnostics line). One known class is **React #31** (an array of objects rendered as a child); fixed on the current branch — the `client-error` text points straight at the line |
| After confirming something (a delete / hide) the wallpaper stays paused and inputs stop responding | A native `confirm` hands focus to its own window, so with "pause on window blur" the wallpaper stops; the modal also blocks the render thread, and the `focus` event on dismissal is not guaranteed to arrive (on older builds only a reload recovered). **Current branch**: the occlusion decision is re-checked every 3 s and logs an `occlusion-recheck` line (a lost event heals itself), and deleting a font set uses an in-panel confirmation. On older builds, click the window or switch away and back |
| The wallpaper picker is empty | Wallpaper Engine installed with at least one wallpaper; restart `dsh web` (see [`../../README.beginner.md`](../../README.beginner.md), FAQ 1 — Chinese only) |
| Video wallpaper is black / frozen | The card's play button and message: 「播放」 means it is not actually playing — click to retry; an "cannot decode" hint means re-export as **H.264** MP4 |
| A Web (HTML) wallpaper shows nothing but the page background | Web wallpapers render **live** by default (the renderer page loads `/scene-live/` and pulls sub-resources via `/scene-files/<token>/…`). **Refresh the page first**; if it is still blank, restart `dsh web` once (the host route is registered when the plugin loads). To rule the live path out, turn off 「网页实时渲染」 in the effects tab and check the **compatibility path** (`/wallpaper-engine/media/<token>` — the plain-iframe fallback loading the same entry HTML). On either path, check DevTools → Network: sub-resources should be 200 — report the failing request path if you see 404/403 |
| A web wallpaper turned black / 403 after picking an adapter target | The manual pick in 「高级 → 适配」 **wins over detection**: picking 「原生浏览器」 while running in a desktop client that enforces the capability-header fence makes the web payload switch to the app origin and get rejected with `403`. Switch back to 「自动检测」 (or any desktop target) to recover; the section's status line states what was detected and warns directly when the pick contradicts it |
| A custom upload is not visible | The **content rating** filter above the grid (defaults to Everyone; unrated uploads count as Everyone) |
| Scene wallpaper shows a still image | **It should not by default** — scene wallpapers are rendered **live** by WebWallGL (particles / scripts / parallax all animate). First check whether 「场景实时渲染」 on the effects tab was turned off, and whether a failure reason (first-frame timeout / runtime stall) is shown under that switch: re-enabling it clears the failure memory and retries. Only when live rendering is unavailable does it fall back to the chain (author-embedded MP4 → live capture → custom frame → empty state; before the first frame it shows the **author's preview**, so there is no black screen); a loose `scene.json` directory (no `scene.pkg`) and browsers without WebGL2 **always** take that chain — there, use 「出图来源」 to pick another frame source or import a 「自定义画面」 (see [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)) |
| Scene / web wallpaper is black, and ~15 s later it falls back to a static frame (or just the poster) | That is the live renderer's **watchdog degrading**: no first frame within 15 s ⇒ the failure is remembered and it degrades automatically. Check that the file is readable and the GPU driver works (WebGL2 is required); re-enabling 「场景实时渲染」/「网页实时渲染」 clears the memory and retries. **A second, older cause (fixed in 0.7.x)**: the static-frame chain **competing for CPU/GPU** — the client used to use the static frame as live's poster (so a cold 4K render started the moment live rendering did), and the host's 「空闲预热」 ignored whether live rendering was in use; either one makes the first frame time out, which degrades and leaves failure memory behind. **Current behaviour**: that extraction/compositing chain is gone entirely — the host **only serves a frame that already exists** (otherwise an honest 404 empty state; it neither generates nor prewarms anything) — and the client's pre-first-frame poster takes **live-captured frame → the author's preview → the theme colour**, so **even a wallpaper that never captures a frame is not black before the first frame**. If you still see nothing but a flat colour for a long time, **not even the author's preview** could be read (no preview in the project, or a read failure) — please attach the diagnostics lines |
| The frame-rate cap does nothing | It needs ffmpeg (the encoder prefers NVENC, falling back to libx264 software encoding without an NVIDIA GPU); with no ffmpeg at all the feature disables itself (see 「Limitations」 in `../README.en.md`) |
| A mid-grey / light slab appears to the right of the conversation area once the right sidebar is closed | Known defect of 0.7.5 on harness 0.1.7 (upstream [#107](https://github.com/elysia395/dsh-wallpaper-engine/issues/107)): 0.1.7 keeps the right-panel container's width and only hides its children, while the plugin's frosted background was applied to that container in every state. **Fixed on the current branch** (guarded by `verify-host-paint-scope`); workaround: turn off the 「侧栏液态玻璃」 master switch, or drag that session's right-sidebar width to 0 |
| Settings revert after a restart | First work out which kind: ① **frame source (「出图来源」 / 「自定义画面」)** — 0.7.5 has a defect where the chosen tier and the custom-frame flag are dropped on the next load; **fixed** (update to a build that carries the fix); ② **lossy route / GPU acceleration / idle prewarm / prewarm whole library** — those four switches were never actually saved on 0.7.5 (the host always read the default); **fixed**; ③ anything else: since v0.4.0 settings live in a host file — check `~/.dsh-wallpaper-engine/config.json` is writable and that you did not roll back to an older version. Also: a host log line reading 「settings PUT 丢弃了白名单外的键」 means the client's and host's field lists have drifted — please report that line |

### Terminal output: problems only by default

Host output has three levels whose names are the logger method names:

| Level | Criterion | Shown on the terminal by default |
|---|---|---|
| `error` | breaks the **plugin / DSH / system** (a core capability fails to start, data or processes are damaged, the user must act) | ✅ |
| `warn` | an abnormal condition that **affects what you see** (degradation, fallback, a fence rejection, first-frame timeout, retry, rejected request) | ✅ |
| `info` | everything else (diagnostic detail, per-frame stats, runtime information, the log-side trace of a success) | ❌ |

**Only the first two levels are shown by default** — so "the wallpaper goes black" is silent on the
terminal, while the on-disk record keeps being written. To see the detail (per-texture lines,
heartbeats, the autosize gate, preparation probes…):

```powershell
# Windows PowerShell (this launch only)
$env:DSH_WE_LOG_LEVEL = "info"; dsh web
```

```sh
# macOS / Linux
DSH_WE_LOG_LEVEL=info dsh web
```

Accepted values are `error` / `warn` / `info` (default `warn`; anything else falls back to it).

The **on-disk** channel is still the first place to look (it is unaffected by the terminal gate and
survives the terminal closing):

- `~/.dsh-wallpaper-engine/diag/http.jsonl` — request records, path fences, renderer and client
  reports; at 8 MiB it rotates to `http.jsonl.1` (one generation only, so the directory has a hard cap);
- `GET http://127.0.0.1:<port>/wallpaper-engine/diag-log` — the last 80 renderer / client reports.

Success notices ("wallpaper media origin listening", "scene wallpaper ready") travel on a **separate
channel**: one terminal line, `[wallpaper-engine] … ✔` — the **same prefix as the log lines**, with the
`✔` merely marking "this is a success, not a problem". Not through the logger, without a level, and not
written to disk. It only appears when **stdout is a terminal** — the DSH Desktop host is started by
Electron over a pipe, so `isTTY` is false and Desktop stays quiet by default. To see notices on Desktop,
opt in:

```powershell
$env:DSH_WE_NOTICE = "1"   # set before launching DSH; "0" silences it permanently (including the warn for a failed delivery)
```

