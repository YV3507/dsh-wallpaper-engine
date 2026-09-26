# 排障 / Troubleshooting

> 本文件承接原先放在 README 首页的**安装失败排查**。README 只保留一行链接。
> 面向新手的常见问题见 [`../README.beginner.md`](../README.beginner.md) 的 FAQ；
> 功能边界见 `../README.md` 的「已知限制」；升级顺序问题见 [`UPGRADING.md`](./UPGRADING.md)。

## 中文

### 安装失败：`ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`

`dsh plugin --profile web add ...` 会把命令转发给 **pnpm**。如果你遇到下面的错误：

```text
[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE] Unexpected virtual store location
dsh: pnpm failed in profile directory C:\Users\xxx\.dsh-desktop\profiles\web
```

**这不是插件本身的问题**（换任何一个插件安装都会失败），而是该 profile 目录的 pnpm 依赖状态失效了：
pnpm 在 `node_modules\.modules.yaml` 里记录了安装时的虚拟存储位置（绝对路径），一旦 profile 目录被
**移动 / 复制 / 备份恢复**过，或 pnpm 版本 / `virtual-store-dir` 配置发生变化，记录值与当前路径不一致，
pnpm 就会拒绝继续安装任何插件。

**修复（Windows PowerShell）：**

```powershell
# 1) 先退出 DSH 桌面端
# 2) 删除该 profile 的依赖目录（只删 node_modules 即可，配置/已装插件名不会丢）
Remove-Item "$env:USERPROFILE\.dsh-desktop\profiles\web\node_modules" -Recurse -Force
# 3) 重新安装本插件
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

> 只删除 `node_modules\.modules.yaml` 一个文件也能修复（pnpm 会自动重建并继续），删除整个
> `node_modules` 更彻底。如果 `.dsh-desktop` 被 OneDrive / 云同步 / 迁移工具动过，建议把它加入同步排除，避免复发。

### 安装失败：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

```text
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ... The git-hosted package "dsh-plugin-wallpaper-engine@0.6.8"
needs to execute build scripts but is not in the "allowBuilds" allowlist.
```

**说明你用了 `github:` 形式的安装命令**（例如 `dsh plugin --profile web add github:elysia395/dsh-wallpaper-engine`）。
pnpm 11 出于供应链安全，默认拒绝从 git 安装的包执行构建脚本，而本插件的 git checkout 需要 `prepare`
脚本构建 client，因此 `github:` 直装必然失败。请改用 **npm 包名**安装（npm 发布包已预构建，无需安装时编译）：

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

> 如果你的插件中心（dsh-plugin-hub）生成的是 `github:` 命令，请把它升级到 **v1.4.1+**——新版会自动反查
> npm 包名并切到 npm 通道。

### 症状 → 先看哪里

| 症状 | 先检查 |
|---|---|
| 选择壁纸弹窗是空的 | WE 是否装好并下载过壁纸；重启一次 `dsh web`（详见 [`../README.beginner.md`](../README.beginner.md) FAQ 1） |
| 视频壁纸黑屏 / 冻在首帧 | 卡片上的播放按钮与提示文案：显示「播放」即未真正播放，点它重试；提示无法解码则换 **H.264** 编码的 MP4 |
| 网页（Web）壁纸一片空白 / 只剩底色 | 网页壁纸默认走**实时渲染**（渲染页加载 `/scene-live/`，子资源经 `/scene-files/<token>/…` 取回）。**先刷新页面**；仍是空白就重启一次 `dsh web`（宿主端路由在插件加载时注册）。若怀疑是实时渲染路径的问题，可在「效果」页签关掉「**网页实时渲染**」验证**兼容路径**（`/wallpaper-engine/web/<token>/…`，多文件 HTML 应用的相对引用按入口所在目录解析）。两种路径下都用 DevTools 看 Network：子资源应当 200，出现 404/403 请附上该请求路径反馈 |
| 自己上传的壁纸看不到 | 弹窗上方的**内容分级**筛选（默认 Everyone；未标注分级的自上传内容按 Everyone 处理） |
| 场景壁纸是静止画面 | **默认不该如此** —— 场景壁纸默认由 WebWallGL **实时渲染**（粒子 / 脚本 / 视差都会动）。先看「效果」页签的「**场景实时渲染**」是否被关掉、以及开关下方是否显示失败原因（首帧超时 / 运行中断）：重开该开关会清空失败记忆并重试。只有实时渲染不可用时才会走「作者内嵌 MP4 → 静态帧」旧链；松散 `scene.json` 目录（没有 `scene.pkg`）与不支持 WebGL2 的浏览器**必然**走静态帧 —— 那种情况可用「出图来源」换一种出图方式，或导入「自定义画面」（见 [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)） |
| 场景 / 网页壁纸黑屏，约 15 秒后跳成静态帧（或只剩垫底画面） | 这是实时渲染的**看护降级**：首帧 15 秒无画面 ⇒ 记入失败记忆并自动降级。先确认能访问外网/磁盘读取正常、显卡驱动可用（需要 WebGL2）；重开「场景实时渲染」/「网页实时渲染」开关可清空记忆重试。**另一条已修的成因**：静态帧链与实时渲染**抢 CPU/GPU** —— ① 客户端曾把静态帧当 live 的垫底图（渲染一开始就要跑一次 4K 冷渲染）；② 宿主「空闲预热」不区分实时渲染是否在用。两者都会让首帧超时进而降级（并留下失败记忆，此后该壁纸一直不实时渲染）。**下一版已修**：静态帧降级为**缓存兜底** —— 垫底图只在**已缓存**时显示（`/scene-frame?cached=1`，只命中不渲染，未命中就留空，**首次加载可能短暂为空是预期取舍**）；预热推迟到动画起来之后，且**当前正在实时渲染的那张不进预热名单**；旧版本可先关掉「空闲预热」缓解 |
| 关掉「静态帧渲染」后场景就不动了 | 预期行为：该开关是静态帧链的总开关，关掉后不再出渲染帧（有作者内嵌 MP4 仍会播它；否则显示「自定义画面」或作者预览图） |
| 帧率上限没效果 | 需要 ffmpeg 与 NVIDIA NVENC；无 ffmpeg / 无 N 卡时该功能自动关闭（见 `../README.md` 的「已知限制」） |
| 右栏关闭后，对话区右侧出现一块中灰 / 浅色板 | harness 0.1.7 上 0.7.5 的已知缺陷（上游 [#107](https://github.com/elysia395/dsh-wallpaper-engine/issues/107)）：0.1.7 把右栏容器改成"保留宽度、只隐藏子元素"，而插件给该容器刷的玻璃底在关闭态也生效。**下一版已修**；临时办法：关掉「侧栏液态玻璃」总开关，或把该会话的右栏宽度拖到 0 |
| 设置改完重启又变回去 | 先分清是哪一类：① **画面档位（「出图来源」/「自定义画面」）** —— 0.7.5 有缺陷，档位与自定义画面标记在下一次加载时会丢，**下一版已修**，升级即可；② **有损路线 / GPU 渲染加速 / 空闲预热 / 预热整个库** —— 这四个开关在 0.7.5 上从未真正保存过（宿主永远读到默认值），**下一版已修**；③ 其它设置：v0.4.0 起存宿主端文件，确认 `~/.dsh-wallpaper-engine/config.json` 可写、且未回滚到旧版本。另：宿主日志里出现「settings PUT 丢弃了白名单外的键」说明客户端与宿主的字段清单不一致，请附上该行反馈 |

---

## English

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
| The wallpaper picker is empty | Wallpaper Engine installed with at least one wallpaper; restart `dsh web` (see [`../README.beginner.md`](../README.beginner.md), FAQ 1 — Chinese) |
| Video wallpaper is black / frozen | The card's play button and message: 「播放」 means it is not actually playing — click to retry; an "cannot decode" hint means re-export as **H.264** MP4 |
| A Web (HTML) wallpaper shows nothing but the page background | Web wallpapers render **live** by default (the renderer page loads `/scene-live/` and pulls sub-resources via `/scene-files/<token>/…`). **Refresh the page first**; if it is still blank, restart `dsh web` once (the host route is registered when the plugin loads). To rule the live path out, turn off 「网页实时渲染」 in the effects tab and check the **compatibility path** (`/wallpaper-engine/web/<token>/…`, where a multi-file HTML app's relative references resolve against the entry's own directory). On either path, check DevTools → Network: sub-resources should be 200 — report the failing request path if you see 404/403 |
| A custom upload is not visible | The **content rating** filter above the grid (defaults to Everyone; unrated uploads count as Everyone) |
| Scene wallpaper shows a still image | **It should not by default** — scene wallpapers are rendered **live** by WebWallGL (particles / scripts / parallax all animate). First check whether 「场景实时渲染」 on the effects tab was turned off, and whether a failure reason (first-frame timeout / runtime stall) is shown under that switch: re-enabling it clears the failure memory and retries. Only when live rendering is unavailable does it fall back to the older chain (author-embedded MP4 → static frame); a loose `scene.json` directory (no `scene.pkg`) and browsers without WebGL2 **always** take that chain — there, use 「出图来源」 to pick another frame source or import a 「自定义画面」 (see [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)) |
| Scene / web wallpaper is black, and ~15 s later it falls back to a static frame (or just the poster) | That is the live renderer's **watchdog degrading**: no first frame within 15 s ⇒ the failure is remembered and it degrades automatically. Check that the file is readable and the GPU driver works (WebGL2 is required); re-enabling 「场景实时渲染」/「网页实时渲染」 clears the memory and retries. **A second, now-fixed cause**: the static-frame chain **competing for CPU/GPU** — ① the client used to use the static frame as live's poster (so a cold 4K render started the moment live rendering did), and ② the host's 「空闲预热」 ignored whether live rendering was in use. Either one makes the first frame time out, which degrades and leaves failure memory behind (so that wallpaper never live-renders again). **Fixed in the next version** — the static frame is now a **cache fallback**: a poster appears only when the frame **is already cached** (`/scene-frame?cached=1` hits the cache and never renders; a miss leaves it blank, so **a briefly blank first load is the expected trade-off**), prewarming is pushed back until the animation is up, and the wallpaper currently being **live-rendered** is excluded from the prewarm list; on older builds, turning 「空闲预热」 off mitigates it |
| Turning 「静态帧渲染」 off stops a scene from animating | Expected: that switch is the static-frame chain's master switch. With it off no frame is rendered (a scene with an author-embedded MP4 still plays it; otherwise the custom frame or the author's preview is shown) |
| The frame-rate cap does nothing | It needs ffmpeg + NVIDIA NVENC; without either, the feature disables itself (see 「Limitations」 in `../README.en.md`) |
| A mid-grey / light slab appears to the right of the conversation area once the right sidebar is closed | Known defect of 0.7.5 on harness 0.1.7 (upstream [#107](https://github.com/elysia395/dsh-wallpaper-engine/issues/107)): 0.1.7 keeps the right-panel container's width and only hides its children, while the plugin's frosted background was applied to that container in every state. **Fixed in the next version**; workaround: turn off the 「侧栏液态玻璃」 master switch, or drag that session's right-sidebar width to 0 |
| Settings revert after a restart | First work out which kind: ① **frame source (「出图来源」 / 「自定义画面」)** — 0.7.5 has a defect where the chosen tier and the custom-frame flag are dropped on the next load; **fixed in the next version**, just update; ② **lossy route / GPU acceleration / idle prewarm / prewarm whole library** — those four switches were never actually saved on 0.7.5 (the host always read the default); **fixed in the next version**; ③ anything else: since v0.4.0 settings live in a host file — check `~/.dsh-wallpaper-engine/config.json` is writable and that you did not roll back to an older version. Also: a host log line reading 「settings PUT 丢弃了白名单外的键」 means the client's and host's field lists have drifted — please report that line |
