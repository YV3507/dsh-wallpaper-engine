# dsh-plugin-wallpaper-engine · 小白向使用指南 / Beginner guide

[English README](README.en.md) | [中文 README（完整版）](README.md) | [English section ↓](#english) | **小白向指南（你正在看）**

> 这是一份**给完全没用过命令行的人**看的简化说明。
> 想看完整的功能细节和技术原理，请看上面的「中文 README（完整版）」。
>
> 📦 **上手需要的东西全在本页**，不需要再跳出去。本插件的 npm 包只带三份 README，`docs/` 目录**不随包发布** —— 本页若提到 `docs/…`，请到**源码仓库** <https://github.com/elysia395/dsh-wallpaper-engine> 的同名路径阅读（那是上游仓库，本插件的源码与完整文档都在那里）。

---

## 中文

### 这是什么？

一句话：**把你 Steam 里的 Wallpaper Engine 壁纸，搬到 DeepSeek Harness（DSH）的网页聊天界面背景上。**

- 装好之后，打开 `dsh web`，你的聊天界面后面就会显示一张动态壁纸（视频 / 网页 / 场景都由插件实时渲染）。
- 壁纸上面还会盖一层 **iOS 风格的「液态玻璃」**，让文字依然看得清。
- 你可以随时换壁纸、调透明度、调颜色，甚至上传自己的图片/视频当壁纸。
- **所有设置从 v0.4.0 起保存在你电脑上的一个文件里**，重启、换浏览器、清缓存都不会丢。

### 开始前，请确认你有

- ✅ 一台 **Windows** 电脑（Mac 用户请看本页最后的「Mac 用户」一节）。
- ✅ 已经装好并打开过一次 **Wallpaper Engine**（Steam 上的那个壁纸软件），且里面至少有一张壁纸。
- ✅ 已经装好 **DSH**（DeepSeek Harness），并能跑起 `dsh web`。
- ✅ 知道怎么打开「**命令提示符**」或「**PowerShell**」（在开始菜单里搜就行）。

> 没有 Wallpaper Engine？这个插件依赖它来扫描壁纸，没有它就用不了 WE 自带的壁纸。不过你**仍然可以**只用「自定义壁纸」功能上传自己的图片/视频当背景。

> ⚠️ **升级顺序很重要（v0.7.2 起）**：更新本插件之前，要先满足**两个前置条件**——① **DSH 桌面版（DSH Desktop）为最新版**（至少 v2.0.7），② **dsh-better-sidebar 侧边栏插件为最新版**（0.19.0+，装了的话）。两个条件都满足之前，请不要更新本插件；顺序反了也不用怕，把 DSH 桌面版和侧边栏插件各自更到最新就能恢复正常。

### 第一步：安装

打开命令提示符 / PowerShell，**复制粘贴**下面这一行，回车：

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

看到安装成功的提示后，**重启 `dsh web`**（关掉重新打开就行）。

> 💡 看到一行命令就慌？别怕——这一行的意思是：「给 DSH 的网页模式装上 Wallpaper Engine 这个插件」。**复制 → 粘贴 → 回车**，三步搞定。

### 第二步：打开壁纸设置页

1. 打开 `dsh web`，进入聊天界面。
2. 点界面里的 **设置**（一般在左下角或左侧栏）。
3. 在设置页的**左侧导航**里，找到一项叫 **「Wallpaper Engine」**，点它。

你会看到一个漂亮的**液态玻璃卡片**，里面就是所有壁纸相关的开关。

### 第三步：选一张壁纸

1. 点卡片里的 **「选择壁纸」** 按钮，会弹出一个**缩略图网格**窗口。
2. 窗口里列出了你 Wallpaper Engine 里的所有壁纸（带预览图）。**点一张你喜欢的**，它就会出现在聊天界面背景上。
3. 点空白处、按 `ESC`、或点「关闭」就能收起这个窗口。

🎉 **搞定！** 现在你的聊天界面后面应该有壁纸了。

> 选不到壁纸？看下面「常见问题」第 1 条。

### 常用功能速查

| 想做什么 | 在哪里点 | 备注 |
|---|---|---|
| **换壁纸** | 选择壁纸 → 弹窗里点一张 | Video / Web / 上传的图视频都行 |
| **关掉壁纸** | 当前壁纸卡片 → 「关闭」 | 壁纸消失，但设置还在 |
| **暂停视频** | 当前壁纸卡片 → ⏸ 按钮 | 只对视频壁纸有用 |
| **调玻璃透明度** | 顶部「外观」→ 玻璃透明度滑条 | 越高越透，越低越实；文字面有可读性下限压底，调不糊 |
| **换主题色** | 顶部「外观」→ 配色 | 6 种预设 + 自定义取色 |
| **换玻璃底色** | 顶部「外观」→ 玻璃颜色 | 决定玻璃本身的色调 |
| **视频调速** | 「效果」→ 倍速 | 0.5x ~ 2x |
| **镜像翻转** | 「效果」→ 水平翻转 | 视频/网页/图片都行 |
| **上传自己的壁纸** | 「自定义壁纸」→ 上传 | 支持 JPG / PNG / MP4 |
| **隐藏不喜欢的壁纸** | 弹窗里卡片右上角「隐藏」 | 软删除，不碰源文件，可恢复 |
| **自动轮换壁纸** | 「轮播列表」→ 新建列表 | 可设切换间隔和顺序 |
| **改上传文件存哪** | 「自定义壁纸」→ 存储「更改」 | 默认存 C 盘，可改到其他盘 |
| **插件跑在哪个壳里**（一般不用动） | 「高级」→ 适配 → 适配目标 | 默认「自动检测」并显示「检测到：…」；只有网页壁纸变黑 / 403 时才需要手选 |

### 画面滑条怎么调？

壁纸激活后，「**效果**」页签有**六个滑条**；另有 **边框** 与 **雾化** 在「**外观**」页签的「细节」段。**它们都是即时生效的，不用刷新页面**：

| 滑条 | 干什么用 | 默认值 |
|---|---|---|
| **壁纸模糊** | 把壁纸本身变模糊 | 0（清楚） |
| **亮度 / 对比度 / 饱和度** | 壁纸画面的明暗与浓淡 | 都是 100% |
| **壁纸透明度** | 把壁纸整层调淡、融进页面底色 | 0% |
| **暗化** | 加深壁纸和文字之间的遮罩 | 25% |
| **边框**（外观页签） | 让边框/分割线更醒目 | 35% |
| **雾化**（外观页签） | 玻璃面板（输入栏、气泡、设置窗口）的模糊半径 | 16 px |

> 👀 **如果文字看不清**：先把「暗化」（效果页签）与「边框」（外观页签）两个滑条往右拉（调高），还不够就稍微加点「壁纸模糊」。也可以试试切换 DSH 的**浅色 / 深色**主题——不同壁纸适合的模式不一样。

### 我的设置存在哪？

**从 v0.4.0 起，全部设置都保存在电脑上的一个文件里**（Windows：`C:\Users\<你的用户名>\.dsh-wallpaper-engine\config.json`；
Mac / Linux：`~/.dsh-wallpaper-engine/config.json`）—— 重启、换端口、清浏览器数据都不丢，从老版本升级会**自动迁移**。

> 为什么改、多设备共享同一份设置、读写与防抖行为见 [`docs/UPGRADING.md`](docs/UPGRADING.md) 的「设置持久化」。

### 常见问题（FAQ）

> **装不上怎么办？** 本节的条目是**使用**层面的问题。安装失败（pnpm 报错，如 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` / `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）先试这一条：**用已发布版本安装**（`dsh plugin --profile web add dsh-plugin-wallpaper-engine`，就是本页第 1 步的写法），它不涉及 `github:` / `link:` 来源的构建脚本与虚拟存储差异。逐步处置见 [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)（**在 GitHub 源码仓库里**，npm 包不带 `docs/`）。

**1. 打开选择壁纸，里面是空的 / 一张都没有？**
- 确认 Wallpaper Engine 装好并至少下载过一张壁纸。
- 确认 Steam 没装在特别奇怪的位置（一般默认位置没问题；非默认盘插件也会自动找）。
- 重启一次 `dsh web`。

**2. 视频壁纸不播放 / 是黑的？**
- 现代浏览器要求视频**静音**才能自动播放——本插件的视频壁纸本来就是静音的，正常应该能播。
- 试试换一张壁纸，或者点一下「暂停」再「播放」。
- 「当前壁纸」卡片现在会直接写明原因（[#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)）：如果播放按钮显示的是「播放」而不是「暂停」，说明视频并没有真的在播，点它即可重试；若提示「无法解码这段视频」，说明这个文件的编码浏览器解不了，换成 **H.264 编码的 MP4** 即可（例如重新导出一次）。
- 自己上传的壁纸如果「看不到 / 应用后一片空白」：检查弹窗上方的**内容分级**下拉框——默认是 Everyone，未标注分级的自上传壁纸现在按 Everyone 处理，不会再被默认过滤藏起来。

**3. 场景（Scene）壁纸为什么是静止的图片？**
- 正常情况下**它应该是动的** —— 插件内置的实时渲染引擎会在浏览器里重放场景（粒子 / 脚本 / 视差 / 包内音频）。
- 若看到的是静止画面，说明实时渲染**降级**了（首帧超时或运行中断，按壁纸记了失败记忆）：此时显示的是**实时抓帧**；重开「场景实时渲染」开关可清空记忆重试。
- **第一次**打开一张场景壁纸时，实时渲染还在启动，屏幕上先垫的是**作者的预览图**（就是你在 Wallpaper Engine 里看到的那张缩略图）—— 出首帧之前不留黑屏。等你**下次再切回**这张壁纸，垫的就是上一轮抓下来的**实时帧**了。
- 连作者预览图都没有时，插件才会**诚实地留空**并说明原因 —— 它**不再**"替作者猜一张图"（那会是一张糊图），这是 1.0 之后的有意行为。

**4. 我想让壁纸自动换，怎么做？**
- 在「轮播列表」里点「新建」，给列表起个名，勾选你想轮换的壁纸，设置**切换间隔**（比如每 30 分钟），勾上「自动轮转」就行。每个列表至少要 2 张壁纸。

**5. 上传的壁纸存在 C 盘，我想挪到 D 盘？**
- 「自定义壁纸」区有个「更改」按钮，点它选一个新文件夹（比如 `D:\wallpapers`），已有的文件会**自动搬过去**，不用手动复制。

**6. 设置改了没生效 / 重启后又变回去了？**
- v0.4.0 已经不存在这个问题了（设置存文件里）。如果你还在用老版本，升级到 0.4.0 即可：重新跑一次第一步的安装命令。

**7. 这个插件会不会让 AI 变笨 / 多花 token？**
- **不会。** 插件不向模型暴露任何工具或提示文本，对 agent 是零 token 开销。它纯粹是个界面美化。

**8. 它会把我电脑里的文件传到网上吗？**
- **不会。** 壁纸文件全是从你本机的 Wallpaper Engine 目录读取的，自定义上传的也只存在你电脑上，不往任何服务器发送。

### Mac 用户

macOS 没有 Wallpaper Engine 客户端，所以本插件的 Windows 版用不了。不过社区维护者 **Jerry** 做了一个 macOS 专用版本（支持 WaifuX 和散装媒体）：

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine-mac
```

仓库地址：https://github.com/ruijiaang-lab/dsh-wallpaper-engine

### 名词表

| 词 | 意思 |
|---|---|
| **DSH** | DeepSeek Harness，就是跑 `dsh web` 的那个东西。 |
| **`dsh web`** | DSH 的网页版界面，你在浏览器里聊天的那个。 |
| **Wallpaper Engine** | Steam 上的壁纸软件，里面存着你买的/下载的壁纸。 |
| **Video 壁纸** | 本质就是一个 `.mp4` 视频文件，可以直接在网页里播。 |
| **Web 壁纸** | 用 HTML 网页做的壁纸；插件默认用内置渲染页**实时渲染**它，失败才退回 iframe 加载。 |
| **Scene（场景）壁纸** | Wallpaper Engine 用 3D 引擎实时渲染的壁纸；插件用内置引擎在浏览器里实时重放它（不是截一张图）。 |
| **液态玻璃** | iOS 那种半透明、带模糊和光泽的玻璃效果。 |
| **轮播** | 让几张壁纸按时间间隔自动轮流切换。 |
| **软删除（隐藏）** | 把壁纸从列表里藏起来，但**不删源文件**，随时能恢复。 |
| **localStorage** | 浏览器自己存数据的地方——**v0.4.0 起插件不再用它存设置了**，改存电脑上的文件。 |
| **`config.json`** | 插件保存设置的文件，在你用户目录的 `.dsh-wallpaper-engine` 文件夹里。 |

### 还想看更详细的？

👉 回到 [中文 README（完整版）](README.md)，里面有工作原理、四类壁纸各自的渲染路径与降级、开发者构建说明等等。

用得开心！🎉

---

## English

> A simplified walkthrough for people who have **never used a command line**.
> For full feature details and how it works, see the [English README](README.en.md).
>
> 📦 **Everything you need to get started is on this page** — no need to jump elsewhere. The npm package ships **only the three READMEs**; the `docs/` directory is **not published with it**, so if this page mentions `docs/…`, read it in the **source repository** <https://github.com/elysia395/dsh-wallpaper-engine> (the upstream repo — the plugin's source and full documentation live there).

### What is this?

In one sentence: **it puts your Steam Wallpaper Engine wallpapers behind the DeepSeek Harness (DSH) web chat interface.**

- Once installed, open `dsh web` and a live wallpaper appears behind your chat (video / web / scene all render live through the plugin).
- An **iOS-style "liquid glass"** layer sits on top of it, so your text stays readable.
- You can switch wallpapers, tune transparency and colors, or even upload your own images/videos as wallpapers.
- **Since v0.4.0 every setting is stored in one file on your computer** — restarting, switching browsers or clearing browser data no longer loses it.

### Before you start, make sure you have

- ✅ A **Windows** PC (macOS users: see the "macOS users" section at the end).
- ✅ **Wallpaper Engine** installed and opened at least once (the Steam wallpaper app), with at least one wallpaper in it.
- ✅ **DSH** (DeepSeek Harness) installed, and `dsh web` working.
- ✅ A way to open **Command Prompt** or **PowerShell** (just search for it in the Start menu).

> No Wallpaper Engine? This plugin relies on it to scan wallpapers, so WE's own wallpapers won't work without it. You **can** still use the **custom wallpaper** feature to upload your own images/videos as a background.

> ⚠️ **The update order matters (since v0.7.2)**: before updating this plugin, satisfy **two prerequisites** — ① **DSH Desktop is up to date** (at least v2.0.7), and ② **dsh-better-sidebar is up to date** (0.19.0+, if you have it installed). Do not update this plugin until both are met; if you got the order wrong, don't panic — bringing DSH Desktop and the sidebar plugin each up to their latest versions restores everything.

### Step 1: install

Open Command Prompt / PowerShell, **copy-paste** this line and press Enter:

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine
```

Once it reports success, **restart `dsh web`** (close it and open it again).

> 💡 Scared of that command line? It just means: "install the Wallpaper Engine plugin into DSH's web profile." **Copy → paste → Enter** — three steps, done.

### Step 2: open the wallpaper settings page

1. Open `dsh web` and go to the chat interface.
2. Click **Settings** (usually bottom-left or in the left sidebar).
3. In the settings page's **left navigation**, find the entry called **"Wallpaper Engine"** and click it.

You will see a **liquid-glass card** holding every wallpaper-related control.

### Step 3: pick a wallpaper

1. Click the **「选择壁纸」 (choose wallpaper)** button on that card — a **thumbnail grid** window opens.
2. It lists every wallpaper in your Wallpaper Engine (with preview images). **Click one you like** and it appears behind the chat interface.
3. Click outside, press `ESC`, or click 「关闭」 (close) to dismiss the window.

🎉 **Done!** There should now be a wallpaper behind your chat interface.

> Can't pick anything? See FAQ 1 below.

### Cheat sheet

| I want to… | Where to click | Notes |
|---|---|---|
| **Change the wallpaper** | 选择壁纸 → click one in the modal | Video / Web / your own uploaded image or video all work |
| **Turn the wallpaper off** | current-wallpaper card → 「关闭」 | The wallpaper disappears, the setting is kept |
| **Pause a video** | current-wallpaper card → ⏸ | Video wallpapers only |
| **Tune glass transparency** | 「外观」 tab → the glass-transparency slider | Higher = clearer, lower = more solid; text surfaces carry a readability floor, so it never becomes unreadable |
| **Change the accent color** | 「外观」 tab → 配色 | 6 presets + a custom color picker |
| **Change the glass base tint** | 「外观」 tab → 玻璃颜色 | Sets the glass's own tint |
| **Change playback speed** | 「效果」 tab → 倍速 | 0.5x – 2x |
| **Mirror the picture** | 「效果」 tab → 水平翻转 | Video / web / images alike |
| **Upload your own wallpaper** | 「自定义壁纸」 → upload | JPG / PNG / MP4 |
| **Hide wallpapers you don't want** | 「隐藏」 in a card's top-right corner | A soft delete — source files are untouched and it is restorable |
| **Rotate wallpapers automatically** | 「轮播列表」 → create a list | Per-list interval and order |
| **Move where uploads are stored** | 「自定义壁纸」 → storage 「更改」 | Defaults to the C: drive; any drive works |
| **Which shell the plugin runs in** (rarely needed) | 「高级」 tab → 适配 → 适配目标 | Defaults to 自动检测 and shows what it detected; only touch it when a web wallpaper goes black / answers 403 |

### How do I tune the picture sliders?

With a wallpaper active, the **「效果」 (effects)** tab has **six sliders**; **边框 (border)** and **雾化 (glass blur)** live in the **「外观」 (appearance)** tab's 「细节」 group. **All of them apply instantly — no page refresh**:

| Slider | What it does | Default |
|---|---|---|
| **壁纸模糊** (wallpaper blur) | Blurs the wallpaper itself | 0 (sharp) |
| **亮度 / 对比度 / 饱和度** (brightness / contrast / saturation) | The wallpaper picture's brightness and richness | all 100% |
| **壁纸透明度** (wallpaper opacity) | Fades the whole wallpaper layer toward the page base color | 0% |
| **暗化** (scrim) | Darkens the overlay between wallpaper and text | 25% |
| **边框** (border, appearance tab) | Makes borders / dividers stand out | 35% |
| **雾化** (glass blur, appearance tab) | Blur radius of the glass panels (composer, bubbles, settings window) | 16 px |

> 👀 **If text is hard to read**: raise the 「暗化」 (effects tab) and 「边框」 (appearance tab) sliders first; if that is not enough, add a little 「壁纸模糊」. You can also switch DSH between its **light / dark** themes — different wallpapers suit different modes.

### Where are my settings stored?

**Since v0.4.0 every setting lives in one file on your computer** (Windows: `C:\Users\<your-name>\.dsh-wallpaper-engine\config.json`;
macOS / Linux: `~/.dsh-wallpaper-engine/config.json`) — restarts, port changes and cleared browser data do not lose it, and upgrading from an older version **migrates automatically**.

> Why it changed, multi-device sharing, and the read/write (debounced) behaviour: see the 「设置持久化」 section of [`docs/UPGRADING.md`](docs/UPGRADING.md).

### FAQ

> **Can't install it?** The entries below are **usage** questions. For install failures (pnpm errors such as `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` / `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`), try this first: **install the published version** (`dsh plugin --profile web add dsh-plugin-wallpaper-engine`, exactly what step 1 above does) — it avoids the `github:` / `link:` sources' build-script and virtual-store pitfalls. Step-by-step recovery is in [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) (**in the GitHub source repo**; the npm package does not include `docs/`).

**1. The wallpaper picker is empty — not a single wallpaper?**
- Make sure Wallpaper Engine is installed and you have downloaded at least one wallpaper.
- Make sure Steam is not installed somewhere truly unusual (the default location is fine; the plugin also auto-detects non-default drives).
- Restart `dsh web` once.

**2. A video wallpaper does not play / is black?**
- Modern browsers require a **muted** video for autoplay — this plugin's video wallpapers are muted anyway, so they should play.
- Try another wallpaper, or click 「暂停」 (pause) and then 「播放」 (play) again.
- The current-wallpaper card now states the reason directly ([#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)): if the play button reads 「播放」 instead of 「暂停」, the video is not actually playing — click it to retry; if it says "cannot decode this video", the browser cannot handle that encoding — re-export it as an **H.264 MP4**.
- If a wallpaper you uploaded is "invisible / comes up blank": check the **content-rating** dropdown above the grid — the default is Everyone, and an unrated upload now counts as Everyone instead of being filtered away.

**3. Why is my Scene wallpaper a still image?**
- **It should be moving** — the plugin's built-in live renderer replays the scene in the browser (particles / scripts / parallax / packaged audio).
- A still picture means live rendering **degraded** (first-frame timeout or a stalled runtime, remembered per wallpaper): what you see is the **live-captured frame**. Re-toggling 「场景实时渲染」 clears that memory and retries.
- The **first** time you open a scene wallpaper, live rendering is still starting up, so what stands in is the **author's preview image** (the very thumbnail you see in Wallpaper Engine) — no black screen before the first frame. **Switch back** to that wallpaper later and the stand-in is the **live frame** captured last time.
- Only when not even the author's preview is available does the plugin leave the area **honestly empty** and say why — it **no longer** "guesses an image on the author's behalf" (which would be a blurry one). That is deliberate behaviour since 1.0.

**4. How do I make wallpapers rotate automatically?**
- In 「轮播列表」 click 「新建」 (new), name the list, tick the wallpapers you want, set a **switch interval** (say every 30 minutes) and enable 「自动轮转」. Each list needs at least 2 wallpapers.

**5. My uploads are on the C: drive — how do I move them to D:?**
- The 「自定义壁纸」 area has a 「更改」 (change) button: pick a new folder (e.g. `D:\wallpapers`) and existing files are **migrated automatically** — no manual copying.

**6. My settings don't stick / revert after a restart?**
- That problem no longer exists since v0.4.0 (settings live in a file). If you are still on an older version, update to 0.4.0 by re-running the install command from step 1.

**7. Will this plugin make the AI dumber / cost more tokens?**
- **No.** It exposes no tools or prompt text to the model — zero token cost for the agent. It is purely cosmetic.

**8. Will it upload files from my computer?**
- **No.** Wallpapers are read from your local Wallpaper Engine directory, and your own uploads stay on your machine — nothing is sent to any server.

### macOS users

macOS has no Wallpaper Engine client, so this plugin's Windows build cannot be used. The community maintainer **Jerry** publishes a macOS-specific version (WaifuX + loose-media support):

```sh
dsh plugin --profile web add dsh-plugin-wallpaper-engine-mac
```

Repo: https://github.com/ruijiaang-lab/dsh-wallpaper-engine

### Glossary

| Term | Meaning |
|---|---|
| **DSH** | DeepSeek Harness — the thing that runs `dsh web`. |
| **`dsh web`** | DSH's web interface — the one you chat with in a browser. |
| **Wallpaper Engine** | The Steam wallpaper app that holds the wallpapers you bought/downloaded. |
| **Video wallpaper** | Essentially an `.mp4` file that plays directly in the page. |
| **Web wallpaper** | A wallpaper built from an HTML page; the plugin loads it in an iframe (or renders it live). |
| **Scene wallpaper** | A wallpaper Wallpaper Engine renders with its 3D engine; the plugin replays it live in the browser with a bundled engine (it does **not** just take a screenshot). |
| **Liquid glass** | The translucent, blurred, glossy glass look iOS uses. |
| **Rotation** | Letting several wallpapers switch automatically on a timer. |
| **Soft delete (hide)** | Hiding a wallpaper from the list **without deleting the source file**; restorable at any time. |
| **localStorage** | Where browsers keep their own data — **since v0.4.0 the plugin no longer stores settings there**, it uses a file instead. |
| **`config.json`** | The file the plugin saves its settings in, inside the `.dsh-wallpaper-engine` folder in your user directory. |

### Want more detail?

👉 Go back to the [English README](README.en.md) for how it works, the render path and degradation for each of the four wallpaper types, developer build instructions and more.

Enjoy! 🎉
