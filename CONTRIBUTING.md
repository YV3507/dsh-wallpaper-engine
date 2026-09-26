# Contributing / 参与贡献

Thanks for helping improve `dsh-wallpaper-engine`. Please keep each pull request focused on one clear problem and include the platform and verification results in its description.

感谢你参与改进 `dsh-wallpaper-engine`。请让每个 Pull Request 聚焦一个明确问题，并在说明中写清适用平台和验证结果。

## Choose the target branch / 选择目标分支

| Change / 改动 | Pull request base / PR 目标分支 |
|---|---|
| Windows, WSL, and shared cross-platform behavior / Windows、WSL 与跨平台公共功能 | `main` |
| macOS, WaifuX, loose-media discovery, and the macOS package / macOS、WaifuX、松散媒体扫描与 macOS 包 | `dsh-wallpaper-engine-mac` |

The macOS line is maintained by [Jerry (@ruijiaang-lab)](https://github.com/ruijiaang-lab). Keeping platform-specific work on the macOS branch lets the Windows-first `main` line and the WaifuX integration evolve without overwriting each other.

macOS 版本由 [Jerry（@ruijiaang-lab）](https://github.com/ruijiaang-lab)维护。将平台专属改动提交到 macOS 分支，可以避免 Windows-first `main` 与 WaifuX 适配在同步时互相覆盖。

## Build from the canonical source / 从唯一源码构建

- `src/client.js` is the canonical browser source. Edit it, then run `npm run build` to regenerate `lib/client.js`.
- `lib/client.js` is generated and tracked for distribution. Do not edit it by hand.
- Host-side changes live directly in `lib/index.js` and the other `lib/*.js` host modules.
- Restart DSH after host-side edits: `lib/*.js` is loaded at startup and is never hot-updated in a running instance.
- Install a local dev build with the application **fully closed** (`dsh plugin --profile desktop add link:<path>`), then start it. Installing while the app is running leaves the plugin in `startup-unconfirmed`, which the recovery state rolls back on the next start.
- Use the Node.js version required by the target branch and your DSH profile. The macOS package currently requires Node.js 24 or newer.

- `src/client.js` 是浏览器端唯一源码。修改后运行 `npm run build` 重新生成 `lib/client.js`。
- `lib/client.js` 是随包分发的构建产物，请勿手改。
- 宿主端代码直接位于 `lib/index.js` 和其他 `lib/*.js` 模块中。
- 改完宿主端代码需**重启 DSH**：`lib/*.js` 在启动时加载，运行中的实例不会热更新。
- 安装本地 dev 构建请**先完全关闭应用**（`dsh plugin --profile desktop add link:<path>`）再启动；应用运行期间安装会停在 `startup-unconfirmed`，恢复状态会在下次启动时自动回滚。
- 请使用目标分支与 DSH profile 要求的 Node.js 版本；当前 macOS 包要求 Node.js 24 或更高版本。

## Install a local dev build / 从本地源码安装（开发者）

### 1. Get the code (`checkout`) / 取得源码

> *checkout* simply means "get a copy of the source code into a folder on your machine": click **Code → Download ZIP** on the GitHub page and unzip it, or clone it with Git:
>
> ```sh
> git clone https://github.com/elysia395/dsh-wallpaper-engine.git
> ```
>
> You then have a folder containing `package.json`, `lib/`, `src/` and `cordis.patch.yml` — called **the plugin folder** below.

> *checkout* 的意思很简单：把源代码下载 / 复制一份到你电脑的某个文件夹里。通常在这个 GitHub 页面点 **Code → Download ZIP** 下载并解压，或用 Git 克隆：
>
> ```sh
> git clone https://github.com/elysia395/dsh-wallpaper-engine.git
> ```
>
> 完成后你会得到一个包含 `package.json`、`lib/`、`src/`、`cordis.patch.yml` 的文件夹。下文把这个文件夹称作**插件文件夹**。

### 2. Install it using its folder path (`link:`) / 用文件夹路径安装（`link:`）

> `link:` tells `dsh` (which forwards the command to `pnpm`) to make a *link* to your local plugin folder instead of downloading a package from the internet — so edits + `npm run build` take effect without reinstalling.
>
> `link:` 表示：告诉 `dsh`（它会把命令转发给 pnpm）去**连接你本地那个插件文件夹**，而不是从网上下载一个包。好处是改完代码并重新构建后，改动能直接生效，不用反复重装。

Replace `<插件文件夹绝对路径>` with the **full path of your plugin folder** (the "address bar" path you see when you open that folder in Explorer / your file manager):

把命令里的 `<插件文件夹绝对路径>` **替换成你插件文件夹的完整路径**（就是资源管理器地址栏里显示的那串路径）：

```sh
dsh plugin --profile web add link:<插件文件夹绝对路径>
```

**Concrete example** —假设你的插件文件夹路径像 `D:\dev\dsh-wallpaper-engine` 这样：

```sh
dsh plugin --profile web add link:D:\dev\dsh-wallpaper-engine
```

You can also use a relative path if your shell is already in the folder's parent / 如果你已经 `cd` 到了插件文件夹的上一级，也可以用相对路径：

```sh
dsh plugin --profile web add link:./dsh-wallpaper-engine
```

> **Which exact path to fill in?** It must be the **folder that contains `package.json`** — not the path to `package.json` itself, and not any file inside. It is the same value you would paste into Explorer's address bar.
>
> **该填哪个确切的路径？** 必须是**包含 `package.json` 的那个文件夹**——不是 `package.json` 文件本身的路径，也不是它里面任何单个文件的路径。

> Why prefer `link:` over `file:`? `link:` creates a live link to your source folder, so edits to `src/client.js` + `npm run build` take effect without reinstalling; `file:` packs a static snapshot, which needs a re-add after every change. Both work for a first install.
>
> 为什么推荐 `link:` 而不用 `file:`？`link:` 是和你的源码文件夹**建立实时连接**，改完 `src/client.js` 并 `npm run build` 后直接生效，无需重装；`file:` 则是打包成一份静态快照，每次改动都要重新 add。首次安装两者都可以。

### 3. Restart / 重启确认

Then restart `dsh web`. The host plugin becomes a bundle layer and the client plugin auto-loads (`dsh.client.immediately: true`).

然后重启 `dsh web`。host 端会成为 bundle 层，client 端会自动加载（`dsh.client.immediately: true`）。

If Steam is installed in a non-standard location, the host auto-detects it via `libraryfolders.vdf` — nothing further is required. / 如果 Steam 装在非标准位置，host 会通过 `libraryfolders.vdf` 自动探测，无需额外配置。

> **注意 profile 与「应用必须先关闭」**：上面的示例用 `--profile web`；若目标是桌面端 profile，请改成 `--profile desktop`，并务必**先完全关闭应用**再安装（应用运行期间安装会停在 `startup-unconfirmed`，恢复状态会在下次启动时自动回滚，见上文「从唯一源码构建」）。

## Verify before opening a PR / 提交 PR 前验证

```sh
npm ci              # 本地取工具链（CI 不装依赖，见下）
npm run verify:all  # = build + verify + smoke
```

**提交前必须全绿。** `.github/workflows/verify.yml` 在每次 push / PR 上跑同一套
（build + verify + smoke），并额外断言两件事：`lib/client.js` 与 `src/client.js` 同步，
以及 `git diff --check` 无尾随空白 / 冲突标记。

> CI **故意不执行 `npm ci`**：build / verify / smoke 只用 `node:` 内置模块与相对路径，
> 整条链对 registry 与 peer 解析完全免疫 —— 这条不变量由 `scripts/verify-package-files.mjs`
> 的 P5 断言钉住。本地开发仍需 `npm ci` 取工具链。

For UI changes, also describe the real DSH surface you tested, including browser or DSH Desktop mode. For platform-specific changes, call out the source layout used in the test—for example Wallpaper Engine, WSL, WaifuX, or loose media.

UI 改动还应说明实际测试过的 DSH 界面、浏览器或 DSH Desktop 模式。平台专属改动请注明测试数据来源，例如 Wallpaper Engine、WSL、WaifuX 或松散媒体文件。

## Pull request checklist / PR 检查清单

- The PR targets the correct branch for its platform.
- Source and generated client output are both included when `src/client.js` changes.
- Existing platform behavior is preserved or the intentional change is explained.
- Build and verification commands pass.
- The PR contains no credentials, local media, generated caches, or unrelated cleanup.

- PR 已选择正确的平台分支。
- 修改 `src/client.js` 时同时包含重新生成的客户端产物。
- 现有平台行为已保留，或正文已解释有意变更。
- 构建与验证命令全部通过。
- PR 不含凭据、本地媒体、生成缓存或无关清理。
