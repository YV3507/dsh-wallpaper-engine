# 变更记录 / Changelog

> 本文件承接原先堆在 README 首页的**版本公告与功能清单**。门面（`../README.md` / `../README.en.md`）
> 只保留与版本无关的亮点；带版本号、issue 号、性能数字的内容一律记在这里。
>
> **当前发布版本：`v1.0.1`**（与 `package.json` 的 `version` 一致；上游最新 release 亦是 v1.0.1）。
> 顶部 `### 未发布（下一版）` 记的是**相对 v1.0.1 的增量**（即本仓库与上游 `origin/main` 的差异）。
>
> **归档说明**：本仓库从 **v0.6.8** 起才有 git tag，更早的版本没有独立标签。早于 v0.6.8 的条目
> 按**原 README 原文的版本标注**归档；原文未标注小版本的条目放进区间桶，不臆造版本号。
> 完整逐提交历史见 GitHub Commits / Releases；升级前置条件见 [`UPGRADING.md`](./UPGRADING.md)。

## 中文

### 未发布（下一版）

> 相对已发布的 **v1.0.1** 的增量（与上游 `origin/main` 的差异，逐提交可查）。

**界面**

- **设置页签重组**：四个域职责归位 —— 「外观 / 效果 / 声音 / 高级」；「玻璃」改名「**雾化**」。
- **换壁纸过场动画（7 种可选）**：交叉淡化 / 推移 / 擦除 / 光圈 / 缩放 / 条带 / 百叶窗；**默认硬切**，手动点选与自动轮播共用同一套；类型 / 方向 / 速度档**走白名单**（未知值回落默认）。「条带」本轮改为真·百叶窗（原实现与「擦除」肉眼分辨不出）。
- **实时帧行**不再受「实时渲染」开关限制（随时可重新截帧），并显示当前壁纸的实时帧**微缩预览**。
- 过场动画选项改为**下拉菜单**，删去两行冗余面板提示。

**修复**

- **修复 harness 0.1.7 下「右栏关闭态露出玻璃底板」（上游 issue #107）**：宿主右栏面板容器在**关闭态**仍占宽度、且自身没有背景，而插件无条件给它刷玻璃底 ⇒ 对话区右侧露出一块中灰板（控制台零报错，易被误判成主题问题）。现在**所有**给该容器上色的规则（含 `.cm-editor` / `.xterm` 内容面与软件渲染兜底）都限定在 `[data-sidebar-right-open]`，并补一条关闭态显式清底；护栏 `verify-host-paint-scope`。
- **移除「beta 场景动画」**：`betaSceneAnim` 开关、宿主 `/scene-anim` 与 `/scene-anim-progress` 路由、客户端动画升级队列 / 进度轮询 / 探针 `<video>`、worker 多帧渲染与 APNG 输出**整体删除**（WebWallGL 实时渲染已是其上位替代）；`verify-client` 增**反向探针**，断言该路线不会复活。
- **资源泄漏修复（审计 12 项）**：scene-anim 析构、探针视频、监听器、定时器、轮询守卫；宿主侧资源与缓存上限一并修复。
- **`sceneVideo` 字段诚实化**：仅在壁纸真含内嵌 MP4 时输出；补时序拉取，且 live 期间不进层 key。
- **壁纸透明度拉高时垫底静态帧透出**：淡出底色改为原生纯黑 / 纯白。
- **未闭合的 CSS 注释吞掉 `.we-layer` 规则**（视频壁纸掉到页面底部 / 场景壁纸盖住文字层）。
- **extended 模式壁纸被外壳画布盖住**：清掉 `.dshDesktopFrame` 的不透明底。
- **增强模式左侧工作区在 Win10（无 Mica）下的兜底**（上游 #73）。
- **软件渲染下玻璃不兜底**（上游 issue #95）：`@supports not (backdrop-filter)` 这类**语法**检测在「语法支持但渲染不发生」时仍为真 ⇒ 兜底永不触发、面板过透。新增 `detectSoftwareRender()`（取不到 WebGL 上下文即判软件，并按 `UNMASKED_RENDERER_WEBGL` / `VENDOR` 匹配 swiftshader / llvmpipe 等）与 `?we-glassfallback=on|off` 手动覆盖；兜底同时覆盖 composer 卡片的 `::before` 载体。
- **玻璃可读性下限**（#82）：给承载文字的面压一层主题底色（`--we-readability-floor`，明 0.45 / 暗 0.59）—— 壁纸可被压暗混淡，正文保持 ≥4.5:1。
- **输入框卡片的模糊改由 `::before` 承载**（#89 / #94），恢复 fixed 后代的视口定位。
- **ffmpeg 子进程 cwd 跨平台修复** + 健壮性审计。

**依赖与护栏**

- 以最小形式采纳上游 PR #87 的 `js-yaml` 约束（非可达漏洞）。
- 打包白名单回归断言（`verify-package-files`），并补上 `lib/scene-script-apis.js`。

**文档与仓库整理**

- 规划文档入库（`docs/`）；**静态帧渲染线归档**到 `docs/archive/static-frame/` —— 该线与 beta 场景动画线的渲染器实现均已迁往独立仓库 [`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)（把场景离线渲染成一张 PNG，可当库或 CLI 用），**将由其它贡献者在下次更新移除**。

### v1.0.1（里程碑 · 2026-09-25）

> 本安装包含 **0.7.6 + 0.7.7 + 0.7.8 + 1.0.1**。

- **「扩展模式」兼容修复**：修复扩展模式下壁纸不显示、以及壁纸「正常几秒后失效成静态图 / 预览图」的问题 —— **兼容 / 增强 / 扩展三种窗口模式下壁纸与全部效果均可用**，无需再切换窗口模式。
- 应用内公告升级至 1.0.1：移除「扩展模式暂不支持」窗口模式警告；新增 Tips：设置面板中部分暂未生效的选项为后续版本的待更新内容，会随更新逐步开放。

### v0.7.8（场景壁纸实时渲染全面上线）

- **场景壁纸实时渲染引擎**：接入 WebWallGL 实时渲染，90% 以上的场景效果都能完整实时呈现；个别渲染不动的壁纸自动回落静态帧管线（毫秒级出图 + 后台预热），不会黑屏。
- **鼠标视差 / 鼠标透视**：场景层次随鼠标移动产生位移；透视 / 景深随鼠标位置实时变化。
- **动态粒子 + 水波纹 + 鼠标点击交互**：粒子系统实时运行（质量档位可在效果页签调整）；水面 / 液体波纹；光标脚本、粒子锁点等点击响应（左键）。
- **音频检测（音乐频谱律动）**：Windows 走系统音频（WASAPI 回环 + GSMTC），**无需 Stereo Mix / 虚拟声卡 / 任何额外接线**；同时带 Now Playing —— 曲目 / 歌手 / 封面直达壁纸。
- **帧率上限与播放态管理**：15 / 30 / 60 fps 上限自由设定；窗口隐藏 / 最小化 / 失焦自动暂停；电池供电自动暂停（均可在效果页签关闭）。
- **dsh-desktop 2.0.14 全面适配**：修复升级后的插件加载失败、右栏玻璃关闭态露灰板、增强模式左栏灰面板遮挡壁纸等问题；建议搭配 dsh-desktop 2.0.14 及以上版本。

### v0.7.6 / v0.7.7

- **壁纸属性面板**：作者属性热更新 + 卡片在抽屉里的窄布局；抽屉名称行居中等 UI 修正。
- **轮换升级**：就绪后切换 + 交叉渐变（统一放慢到 1.8s：轮换 / GPU 静帧→首帧淡入 / 手动换壁纸同一套渐变）+ live / web 节点级领养。
- **媒体三平台**：media-bridge 接入（macOS / Windows / Linux），中间件版本钉 v0.1.5（频谱口径修正 + 采集跟随默认输出设备）；歌曲封面（Now Playing artwork）通用取源。
- **网页壁纸修复**：独立壁纸媒体源提供载荷（修 Desktop 全黑）、跨源重复注入 shim 导致帧率被限两次、渲染页同步 webwallgl 1.4.2（含两类网页壁纸白屏修复）。
- **GPU 抓帧回填 + 几何校验**：实时帧缓存回填静态帧缓存、面板状态 / 清除入口、CPU 渲染严格门禁；存帧视比与当前视口不符自动清掉重抓。
- **视频类壁纸恢复 0.7.5「选中即播」**（去掉 preview 海报与预热探测链）；官方资源路径（WE assets 目录，宿主半边 + 客户端半边）。
- **排查台**：网页壁纸「白屏」排查（无头真浏览器截图 + 控制台报错）；渲染链路黑匣子（客户端关键步骤上报 + 宿主落盘）。

### v0.7.5

> 上游 v0.7.5 的内容（`#91` 字体重做与画面刷新档位、`#99` 视频壁纸音轨、玻璃饱和度不再随模糊上涨 `#98` 等）+ 本仓库 **0.7.4 全部内容**（见下节）。
> ⚠️ **WebWallGL 实时渲染（`#103`）与 `lib/webwallgl/` 发布白名单不在本版内** —— 它们是上面「未发布」桶里的追版合并成果；本版发布时的管线前缀是 `sf33_`。

### v0.7.4（未发布 — 内容并入 v0.7.5）

> npm 上的 0.7.3 已被更早的提交占用且不可覆盖，故版本上调；0.7.4 = 0.7.3 内容 + #88（场景静态帧系列修复）+ 下列两条。**该版本号从未发布到 npm**（`0.7.3 → 0.7.5`），其内容随 v0.7.5 一起出货。

- **输入框玻璃定位修复**（[#89](https://github.com/elysia395/dsh-wallpaper-engine/issues/89)，社区 PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)）：`[data-composer-card]` 内含 `position:fixed` 后代（`@dsh-external/dsh-webui` 把「AI 浏览器」座位挂在卡片内部），而卡片上的 `backdrop-filter` 按规范会成为这些 fixed 后代的**包含块** —— 座位不再相对视口定位、多出数百 px 幽灵溢出，输入框滚到底时被留在上方。现在模糊改由 `::before` 伪元素承载（伪元素没有 DOM 后代，永远不会成为包含块），模糊半径 / `--we-*` 变量 / 圆角全部沿用，视觉等价。
- **场景内嵌视频字段诚实化**（[#92](https://github.com/elysia395/dsh-wallpaper-engine/issues/92)，社区 PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)）：过去 inventory 用「静态帧可用」冒充「内嵌 MP4」，对几乎所有场景壁纸都输出 `sceneVideo` URL，客户端请求 `/scene-video` 必然 404。现在按「pkg 路径 + mtime」缓存真实探测结果（有界 LRU + 后台补齐 + 真实请求回填，未知一律 `null`、绝不猜），只有确认内嵌 MP4 才给地址。

### v0.7.3

- **自定义上传壁纸可用性 + 播放状态如实显示**（[#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)）：
  - ① 自上传内容在 `uploads/.meta.json` 里从不写 `contentrating`，过去算「未分级」而内容分级默认是 **Everyone**，于是**所有自上传壁纸默认被过滤掉**（网格里看不到、被上传流程自动应用时直接拒绝 → 壁纸层空白 + 播放按钮变灰）。现在未标注分级的自上传内容按 **Everyone** 处理，自己的文件开箱即用，显式标注 G / PG13 / R 的照常过滤。
  - ② 视频 `play()` 被拒（自动播放策略、浏览器解不了的编码如 HEVC/10-bit、被紧接着的 src 切换打断）时过去**静默吞掉**：面板继续写「播放中」、卡片上只有「暂停」，壁纸冻在首帧却无「继续」可点。现在按 `<video>` 的**真实状态**显示，按钮回到「播放」可重试并给出原因（如「无法解码这段视频，建议改用 H.264」），并在媒体就绪后**自动补一次播放**。
  - ③ 被过滤条件丢弃的当前壁纸不再是无解释的空白，卡片上会写明是哪一项过滤挡住的。
- **壁纸透明度**（[#82](https://github.com/elysia395/dsh-wallpaper-engine/issues/82)）：「效果」区新增滑动条（0–90 %，越大越透）——把壁纸整层淡出、融向页面底色，即 IDEA 背景图式的「看得见但不喧宾夺主」；与暗化互补，文字可读性不受影响。
- **输入光标颜色**（[#83](https://github.com/elysia395/dsh-wallpaper-engine/issues/83)）：「字体」页签新增 **输入光标** 分区——光标颜色与壁纸相近看不清时，可从 6 种预设或自定义取色器里挑一个高对比颜色（也可选「自动」恢复 dsh 原生表现）；作用于所有输入框与可编辑区域，独立于字体自定义开关。

### v0.7.2

- **前置条件升级**：适配 DeepSeek Harness **0.1.5-rc.1**（DSH Desktop ≥ 2.0.7），并要求 **dsh-better-sidebar ≥ 0.19.0**。升级顺序与回退方式见 [`UPGRADING.md`](./UPGRADING.md)。
- **修复「右侧栏完全透明」并把玻璃扩展到官方原生右侧栏**：harness 0.1.5 的官方原生右侧栏面板直接绘制 `--dsw-alias-bg-base`——这正是本插件为露出壁纸设成透明的 token，且官方面板没有自己的毛玻璃，导致升级 better-sidebar 0.19 后右侧栏整体透明。v0.7.2 起官方原生右侧栏纳入「侧栏液态玻璃」适配：同一组**侧栏模糊 / 透明度 / 玻璃颜色**滑杆生效，总开关关闭时回退主题面板色（不再透明）。
- 追补修复：侧栏颜色调节与内容面在官方原生右侧栏失效；侧栏颜色混入强度改为独立于透明度的可见性曲线。

### v0.7.1

- **适配 DeepSeek Harness 0.1.2-rc.1**，并在 **DSH Desktop v2.0.5** 上完成实测：壁纸宿主路由（inventory / media / scene-frame）、设置一级分区、选择器弹窗、视频与场景壁纸播放、拉绳抽屉、液态玻璃在「兼容模式」与「增强模式」下均正常。本插件依赖的 slots / webserver / 主题变量等 API 在 0.1.2-rc.1 → 0.1.5-rc.1 之间经实测同样稳定。
- **修复 rc.1 的「色板 / 黑胶唱片变圆角矩形」**（[#74](https://github.com/elysia395/dsh-wallpaper-engine/issues/74)）：rc.1 主题层新增 `corner-shape.css`，给**所有元素**统一加了 `corner-shape: superellipse(1.5)`（方圆形角），任何 `border-radius:50%` 的正圆都被渲染成圆角矩形。插件现已对自身绘制的全部正圆 / 胶囊控件（色板、黑胶唱片、滑杆圆点、开关滑块、字体 chip 等）显式重置 `corner-shape: round`，在旧版 harness 上该声明会被自动忽略、无副作用。

### v0.6.8

- 场景渲染管线的稳定化修复批次（solid layer 白方块 / JPEG 回退 alpha / clearcolor / `#86` 残留 / 资源泄漏回归护栏）；发布包 `files` 白名单回归由 `scripts/verify-package-files.mjs` 长期看护。

### v0.6.7

- **字体自定义**：设置新增「字体」分区——总开关默认关闭（即 dsh 原生外观），开启后可调 **字体颜色 / 字重(100–900) / 字体族**（默认 · 雅黑 · 楷体 · 宋体 · 黑体 · 行楷 · 等宽，选项按钮以各自字体实时预览）；报错红字不受染色影响，关闭总开关即一键恢复默认。

### v0.6.4

- **优化「沉浸式全屏窗口偶尔全屏闪白」**（保留完整毛玻璃）：早期版本在**桌面快捷方式打开的沉浸式全屏窗口**（独立应用 / kiosk 窗口）里，点击对话或输入文字时**可能整屏闪白一下**——这是该窗口 + 硬件加速下，Chromium 合成器对壁纸重绘时偶发把整屏画白。v0.6.4 继续按「减少合成层」处理：仓库面板关闭时懒加载、拉绳无永久滤镜、壁纸媒体默认下不再强制一个变换合成层——同时**完整保留毛玻璃**；普通浏览器标签页完全不受影响，保持完整毛玻璃与硬件加速。插件更新后会弹一次提示，告知此优化（每个新版本仅出现一次）。

### v0.6.3 前后

- **吉祥物（聊天顶部拉绳）**：一条可拖拽的拉绳沿顶部吸附，向下拉即拉出**壁纸仓库**抽屉；可切换形态（小女仆 / 鲸御姐）与大小（0.5×–2.5×）。
- **壁纸效果调节条扩充**（v0.6.x）：「壁纸效果」区新增 **亮度 / 对比度 / 饱和度** 三个滑动条（作用于壁纸媒体滤镜），与壁纸模糊 / 暗化等配合，任意壁纸都能调到与界面融合舒服的状态；全部即时生效、持久保存。

### v0.6.0

- **场景壁纸完整场景帧**：Scene 壁纸由纯 JS 场景渲染器完整重放（对象树 / 纹理 / 粒子 / shader 效果），不再是主纹理静态帧。实现细节见 [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)。

### v0.5.x

- **遮挡暂停（省电三档）**：类似 Wallpaper Engine 的「被遮挡时暂停」——最小化 / 切页、窗口失焦、使用电池供电时自动暂停视频壁纸，**解码引擎直接归零**；回到界面 / 接通电源自动继续（网页壁纸仅随页面隐藏被浏览器节流）。三档开关均持久保存。
- **解码帧率上限（抽帧转码）**：高帧率源（如 4K120 H.264）的硬解是 GPU 占用大头（4060 实测 1.0x 达 ~60% Video Decode）。宿主端用 ffmpeg 一次性重编码为上限帧率（时间线保持 1.0x **正常速度**、与倍速完全解耦），输出 **4K 保留 + AV1**，带下载 / 转码实时进度条；实测 4K120→24fps 后占用从 ~60% 降至 **~15%**。ffmpeg 三档供给：显式指定 → 自动下载（npmmirror + GitHub 双源竞速）→ 系统 PATH。

### v0.4.1

- **媒体流句柄修复 + 扫描提速**：媒体 / 预览 / 场景帧流在客户端断开时**立即释放文件句柄**（修复反复切壁纸 / 刷新累积句柄、Windows 上壁纸文件被锁无法删除 / 移动的问题）；壁纸库扫描改**全异步**（fs.promises 线程池），不再阻塞事件循环（WSL / 大壁纸库下启动明显更快）。
- **WSL 支持**：自动探测 `/mnt/<盘符>` 挂载的 Windows Steam 库，WSL 里也能发现壁纸。

### v0.4.0

- **设置持久化到宿主端文件**：全部设置（已选壁纸、配色、透明度、布局、轮播、隐藏、倍速 / 翻转等）改存 `~/.dsh-wallpaper-engine/config.json`，不再依赖浏览器 localStorage —— **重启、换端口（含 DSH Desktop 的随机端口）、清浏览器数据、换浏览器都不再丢失**；旧版 localStorage 配置首次启动自动迁移。
- **Edge 兼容渲染**：Edge（且仅 Edge）会在页面里任何「可见的 `<video>`」上绘制浏览器自带的「下载 / 投屏」悬浮工具栏，且没有官方开关可以关闭；插件因此在 Edge 中默认把视频壁纸改为 **canvas 渲染**来规避。「紧凑布局」同一行右侧新增「**Edge 兼容**」开关（默认开启），关闭后所有浏览器一律回退到原生 `<video>`。

### v0.3.1–v0.3.6

- **液态玻璃设置页**（v0.3.1）：设置页升级为**一级设置页**（参照 dsh-web-ui-all 皮肤中心的设计），整页是可自定义的液态玻璃卡片 —— **配色**（6 种预设 + 自定义取色）与**玻璃透明度**（0–60 %）即时生效、持久保存。
- **整个设置窗口液态玻璃化**（v0.3.2）：一键把 **DSH 原生设置窗口整体**（对话框 + 左侧导航 + General / 模型 / 插件等**全部原生分区**）换成液态玻璃 + 自定义配色；关闭则恢复原生样式。
- **玻璃调节统一**（v0.3.3–v0.3.5）：设置窗口的玻璃模糊与**对话栏共用同一套调节参数**（「玻璃」滑动条 0–60 px 同时控制设置窗口与输入栏 / 气泡的模糊半径，饱和度 / 亮度 / 对比度配方一致）；新增「**玻璃颜色**」—— 设置窗口玻璃的**底色色调**可自定义（6 预设 + 自定义取色，默认浅色白 / 深色深夜蓝，选定后两种主题统一使用该色），与「配色」分工：**配色管控件、玻璃颜色管玻璃本身**。
- **卡片样式与黑胶唱片**：「紧凑布局」开关（CD 架式纵向层叠）与旋转黑胶唱片标签效果。

### v0.2

- **壁纸选择弹窗**：缩略图网格收纳进独立弹窗，设置页不再被长列表占满。
- **隐藏 / 恢复**：不想看的壁纸一键隐藏（软删除），随时恢复，不碰源文件。
- **视频倍速**：0.5x – 2x 六档原生调速，即时生效、不重载。
- **水平翻转**：镜像画面（视频 / 网页 / 上传图片均适用）。
- **自定义壁纸**：直接上传本地 JPG / PNG / MP4 当壁纸，可选存储位置与画面适配模式；上传的 MP4 自动生成抽帧缩略图。

---

## English

### Unreleased (next version)

> Increment over the published **v1.0.1** (the diff against upstream `origin/main`, verifiable commit by commit).

**UI**

- **Settings tabs reorganised**: the four domains are now where they belong — 「外观」/「效果」/「声音」/「高级」; 「玻璃」 was renamed to 「**雾化**」.
- **Wallpaper-switch transitions (7 options)**: cross-fade / push / wipe / iris / zoom / strip / blinds; **hard cut by default**, shared by manual selection and automatic rotation; type / direction / speed tier are **whitelisted** (unknown values fall back to the default). 「条带」 (strip) became a real venetian blind this round — the previous implementation was visually indistinguishable from 「擦除」 (wipe).
- **The live-frame row** is no longer gated by the live-rendering switch (you can re-capture at any time) and shows a **thumbnail of the current wallpaper's live frame**.
- The transition options moved into a **dropdown**, and two redundant panel hints were removed.

**Fixes**

- **Fixed the "collapsed right sidebar still shows a glass plate on harness 0.1.7" bug (upstream issue #107)**: the host's right-panel container keeps its **width while collapsed** and paints no background of its own, while the plugin painted it unconditionally ⇒ a mid-grey slab across the right of the conversation area (zero console errors, easily mistaken for a theme problem). Every rule that paints that container (including the `.cm-editor` / `.xterm` content surfaces and the software-render fallback) is now scoped to `[data-sidebar-right-open]`, plus an explicit closed-state clear; guard `verify-host-paint-scope`.
- **Removed "beta scene animation"**: the `betaSceneAnim` switch, the host `/scene-anim` and `/scene-anim-progress` routes, the client-side upgrade queue / progress polling / probe `<video>`, and the worker's multi-frame rendering and APNG output are **all deleted** (WebWallGL live rendering supersedes it); `verify-client` gained a **reverse probe** asserting that route never comes back.
- **Resource leaks fixed (12 findings from the audit)**: scene-anim teardown, probe videos, listeners, timers, polling guards; host-side resources and cache caps too.
- **`sceneVideo` made honest**: only emitted when the wallpaper really embeds an MP4; added a follow-up fetch for ordering, and it no longer enters the layer key while live rendering.
- **The poster static frame showing through at high wallpaper opacity**: the fade-out backing colour is now native pure black / white.
- **An unterminated CSS comment swallowing the `.we-layer` rule** (video wallpapers dropping to the bottom of the page / scene wallpapers covering the text layer).
- **The wallpaper being covered by the shell canvas in extended mode**: the opaque background on `.dshDesktopFrame` is cleared.
- **Fallback for the enhanced-mode left workspace on Win10 (no Mica)** (upstream #73).
- **Glass did not fall back under software rendering** (upstream issue #95): a *syntax* check such as `@supports not (backdrop-filter)` stays true when the syntax is supported but rasterisation never happens ⇒ the fallback never fired and panels stayed too transparent. Added `detectSoftwareRender()` (no WebGL context ⇒ software; otherwise match `UNMASKED_RENDERER_WEBGL` / `VENDOR` against swiftshader / llvmpipe / …) and a `?we-glassfallback=on|off` manual override; the fallback now also covers the composer card's `::before` carrier.
- **Text-surface readability floor** (#82): text-bearing surfaces get a theme base colour layered on top (`--we-readability-floor`, 0.45 light / 0.59 dark) — the wallpaper may be dimmed and faded, the body text stays at ≥4.5:1.
- **The input-card blur moved onto `::before`** (#89 / #94), restoring viewport positioning for fixed descendants.
- **Cross-platform fix for the ffmpeg child process cwd** plus a robustness audit.

**Dependencies & guards**

- Adopted upstream PR #87's `js-yaml` constraint in minimal form (a non-reachable vulnerability).
- Packaging-whitelist regression assertions (`verify-package-files`), and `lib/scene-script-apis.js` added back.

**Docs & repo housekeeping**

- Planning documents brought into the repo (`docs/`); the **static-frame rendering line is archived** under `docs/archive/static-frame/` — that line's renderer, like the beta scene-animation line's, now lives in the standalone repo [`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame) (offline scene → a single PNG, usable as a library or CLI) and **will be removed by other contributors in the next update**.

### v1.0.1 (milestone · 2026-09-25)

> This install contains **0.7.6 + 0.7.7 + 0.7.8 + 1.0.1**.

- **"Extended mode" compatibility fix**: fixed wallpapers not showing in extended mode, and wallpapers that "work for a few seconds and then fall back to a static image / preview image" — **wallpapers and every effect now work in all three window modes** (compatible / enhanced / extended), with no need to switch modes.
- The in-app notice was bumped to 1.0.1: the "extended mode not supported yet" warning is gone; a new Tip states that some settings-panel options not yet in effect are upcoming work that will open up as updates land.

### v0.7.8 (scene-wallpaper live rendering goes fully live)

- **Scene-wallpaper live rendering engine**: WebWallGL live rendering is wired in, and 90 %+ of scene effects render fully in real time; the rare wallpaper that cannot render live automatically falls back to the static-frame pipeline (millisecond output + background prewarming) — no black screen.
- **Mouse parallax / mouse perspective**: scene layers shift as the mouse moves; perspective / depth of field change with the pointer in real time.
- **Live particles + water ripples + click interaction**: the particle system runs live (quality tier adjustable on the effects tab); water / liquid ripples; cursor scripts, particle anchors and other click responses (left button).
- **Audio detection (music spectrum)**: on Windows it taps system audio (WASAPI loopback + GSMTC) — **no Stereo Mix, no virtual audio device, no extra wiring**; it also brings Now Playing — track / artist / artwork straight into the wallpaper.
- **Frame-rate cap & playback-state management**: pick 15 / 30 / 60 fps; auto-pause when the window is hidden / minimised / unfocused; auto-pause on battery (all switchable on the effects tab).
- **Full dsh-desktop 2.0.14 adaptation**: fixes plugin load failures after the upgrade, the right-sidebar glass showing a grey plate when collapsed, and the enhanced-mode left grey panel covering the wallpaper; pairing with dsh-desktop 2.0.14 or newer is recommended.

### v0.7.6 / v0.7.7

- **Wallpaper properties panel**: live author-property updates + a narrow card layout inside the drawer; centred name row and other UI corrections.
- **Rotation upgrade**: switch when ready + cross-fade (slowed to a uniform 1.8 s: rotation / GPU still frame → first-frame fade-in / manual wallpaper switches all share one recipe) + node-level adoption for live / web.
- **Media on three platforms**: media-bridge integrated (macOS / Windows / Linux), middleware pinned at v0.1.5 (spectrum semantics corrected + capture follows the default output device); Now Playing artwork with a generic source.
- **Web wallpaper fixes**: a dedicated wallpaper media origin serves the payload (fixes an all-black Desktop), a cross-origin duplicate shim injection that capped the frame rate twice, and the renderer page synced to webwallgl 1.4.2 (including both classes of web-wallpaper white-screen fix).
- **GPU frame capture backfill + geometry validation**: live frames backfilled into the static-frame cache, panel state / clear entry points, a strict gate for CPU rendering; a stored frame whose aspect ratio does not match the viewport is dropped and re-captured.
- **Video wallpapers got 0.7.5's "play on selection" back** (the preview poster and the prewarm probe chain are gone); official asset path (the WE assets directory, host half + client half).
- **Diagnostics workbench**: web-wallpaper "white screen" triage (headless real-browser screenshot + console errors); a render-path black box (client step reporting + host-side log dump).

### v0.7.5

> Upstream v0.7.5's content (`#91` font rework + frame-refresh tiers, `#99` video-wallpaper track volume, glass saturation no longer rising with blur `#98`, …) plus **all of this repository's 0.7.4 content** (see the next section).
> ⚠️ **WebWallGL live rendering (`#103`) and the `lib/webwallgl/` publishing allowlist are NOT in this version** — they came in with the catch-up merge listed under "Unreleased" above; this release's pipeline prefix was `sf33_`.

### v0.7.4 (unpublished — its content shipped inside v0.7.5)

> The 0.7.3 name on npm was already taken by an earlier set of commits and cannot be overwritten, so the version was bumped; 0.7.4 = the 0.7.3 content + #88 (scene static-frame fix series) + the two entries below. **This version number was never published to npm** (`0.7.3 → 0.7.5`); its content shipped with v0.7.5.

- **Composer glass positioning fix** ([#89](https://github.com/elysia395/dsh-wallpaper-engine/issues/89), community PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)) — `[data-composer-card]` contains `position:fixed` descendants (`@dsh-external/dsh-webui` mounts the "AI browser" seat inside the card), and a `backdrop-filter` on the card becomes a **containing block** for those fixed descendants per spec — the seat stopped being viewport-anchored, gained hundreds of px of phantom overflow, and the composer was left stranded above the bottom of the scroll. The blur now lives on a `::before` pseudo-element (no DOM descendants → it can never become a containing block), keeping the same radius / `--we-*` tokens — visually identical.
- **Honest sceneVideo field** ([#92](https://github.com/elysia395/dsh-wallpaper-engine/issues/92), community PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)) — the inventory used to pass off "static frame available" as "embedded MP4", emitting a `sceneVideo` URL for nearly every Scene wallpaper, so the client's `/scene-video` request was a guaranteed 404. The real probe is now cached by "pkg path + mtime" (bounded LRU, background fill, opportunistic backfill from real requests; unknown stays `null` and is never guessed), and the URL is emitted only when an embedded MP4 is confirmed.

### v0.7.3

- **Custom uploads usable + honest playback state** ([#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)):
  - ① `uploads/.meta.json` never recorded a `contentrating`, so uploads used to read as **unrated** while the rating filter defaults to **Everyone** — every custom upload was filtered out by default (absent from the grid, and rejected when the upload flow auto-applied it → blank wallpaper layer + a disabled 播放 button). An upload without a rating now counts as **Everyone**, so your own files work out of the box, while an explicit G / PG13 / R tag still filters normally.
  - ② A refused `video.play()` (autoplay policy, a codec the browser cannot decode such as HEVC/10-bit, or a play() interrupted by the next src swap) used to be swallowed silently: the panel kept saying 「播放中」 and the only control was 「暂停」 — a wallpaper frozen on its first frame with no way to resume. The control now reflects the `<video>` element's REAL state, so it returns to 「播放」 (a working retry) with a readable reason, e.g. "cannot decode this video — use H.264", and it re-issues play() automatically once the media becomes ready.
  - ③ A wallpaper dropped by a filter now says which filter excluded it instead of leaving an unexplained blank.
- **Wallpaper opacity** ([#82](https://github.com/elysia395/dsh-wallpaper-engine/issues/82)) — a new slider in the effects tab (0–90 %, higher = more transparent): fades the whole wallpaper layer toward the page base colour — the IDEA background-image style of "visible but not overpowering". Complements the scrim, keeping text readable.
- **Input caret color** ([#83](https://github.com/elysia395/dsh-wallpaper-engine/issues/83)) — a new **输入光标** section on the typography tab: when the caret is hard to see against the wallpaper, pick a high-contrast color from 6 presets or the custom picker (or **自动** to restore the native dsh caret). Applies to every text input and editable area, independent of the typography master switch.

### v0.7.2

- **Prerequisite bump**: targets DeepSeek Harness **0.1.5-rc.1** (DSH Desktop ≥ 2.0.7) and requires **dsh-better-sidebar ≥ 0.19.0**. Update order and rollback: see [`UPGRADING.md`](./UPGRADING.md).
- **Fixes the "right sidebar fully transparent" regression and extends the glass to the native right sidebar**: the harness 0.1.5 native sidebar panel paints `var(--dsw-alias-bg-base)` — the exact token this plugin sets to transparent while a wallpaper is active — and the native panel ships no frosted glass of its own, so after moving to better-sidebar 0.19 the whole right column went see-through. From v0.7.2 the native right sidebar is covered by the「侧栏液态玻璃」adaptation: the same **侧栏模糊 / 透明度 / 玻璃颜色** sliders drive it, and with the master switch off it falls back to the theme's opaque panel colour (no longer transparent).
- Follow-up fixes: sidebar colour controls and the content surface had no effect on the official native right sidebar; the sidebar colour mix strength is now a visibility curve independent of transparency.

### v0.7.1

- **Adapted to DeepSeek Harness 0.1.2-rc.1** and verified on **DSH Desktop v2.0.5**: host routes (inventory / media / scene-frame), the first-level settings section, the picker modal, video & scene wallpaper playback, the rope-dock drawer, and the liquid-glass effects all work in both Compatibility and Enhanced desktop modes. The APIs this plugin relies on (slots / webserver / theme variables) were verified unchanged on harness 0.1.5-rc.1 as well.
- **Fixes the rc.1 "swatches / vinyl record render as rounded rectangles" regression** ([#74](https://github.com/elysia395/dsh-wallpaper-engine/issues/74)): rc.1's theme layer ships a new `corner-shape.css` that applies `corner-shape: superellipse(1.5)` (squircle-ish corners) to **every element**, so any `border-radius:50%` circle renders as a rounded rectangle. The plugin now explicitly resets `corner-shape: round` on every circle / pill control it draws (swatches, vinyl record, slider thumbs, toggle knobs, font chips, …); on older harness builds the declaration is ignored, with no side effects.

### v0.6.8

- A stabilization batch for the scene rendering pipeline (solid-layer white boxes / JPEG fallback alpha / clearcolor / `#86` residue / resource-leak regression guards). The `files` allowlist regression that silently dropped a runtime module is now guarded permanently by `scripts/verify-package-files.mjs`.

### v0.6.7

- **Custom typography** — a new **字体** section in settings. The master switch defaults to off (stock dsh look); once enabled you can tune **font color / weight (100–900) / family** (default · YaHei · KaiTi · SimSun · SimHei · 行楷 Xingkai · monospace, each chip previewed in its own font). Error/danger/warning text keeps its system red; toggling the switch off restores defaults in one click.

### v0.6.4

- **Improved: occasional full-screen white flash in immersive windows** (keeps full frosted glass). Older builds could flash the **whole window white** when you clicked the dialog or typed in an **immersive fullscreen window** opened via a **desktop shortcut** (standalone / kiosk) — under **hardware acceleration**, Chromium's compositor occasionally paints the backdrop white while it re-composites over the wallpaper. **v0.6.4 keeps reducing the compositing layers**: the repo panel is lazy-mounted when closed, the rope has no permanent filter, and the wallpaper media no longer forces a transform compositing layer by default — whilst **keeping the full frosted glass**. Normal browser tabs are unaffected and keep the full frosted glass + hardware acceleration. The plugin shows a one-time notice (once per version) about this.

### Around v0.6.3

- **Mascot (chat pull-cord)** — a draggable cord that snaps along the top edge; pull it down to reveal the **wallpaper library** drawer, with two character forms (maid / orca) and a 0.5×–2.5× size control.
- **Wallpaper-effect tuning sliders** (v0.6.x) — the **壁纸效果** area gains three new sliders: **亮度 / 对比度 / 饱和度** (wallpaper media filter), alongside wallpaper blur / scrim etc., so any wallpaper can be blended comfortably with the UI. All apply instantly and persist.

### v0.6.0

- **Scene full-scene frames** — Scene wallpapers are fully replayed by a pure-JS scene renderer (object tree / textures / particles / shader effects) instead of a main-texture static frame. Implementation details: [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md).

### v0.5.x

- **Occlusion pause (battery-saving trio)** — like Wallpaper Engine's "pause when covered": pause the video wallpaper on minimize / tab-switch, on window focus loss, and/or on battery power, dropping the decoder engine to zero; it resumes automatically when you come back (web/iframe wallpapers are only throttled by the browser while hidden). Each toggle persists.
- **Decode frame-rate cap (frame-skip transcode)** — high-fps sources (e.g. 4K120 H.264) are the dominant GPU cost (~60% Video Decode at 1.0x on a 4060). The host re-encodes the wallpaper ONCE with ffmpeg to the capped fps (timeline stays 1.0x normal speed, fully decoupled from 倍速) as **4K-preserving AV1**, with a **live download/transcode progress bar**; measured 4K120→24fps drops GPU from ~60% to **~15%**. ffmpeg is provisioned in three tiers: explicit path → auto-download (npmmirror + GitHub dual-source race) → system PATH.

### v0.4.1

- **Media-stream handle fix + async scan** — media/preview/scene-frame streams now release their file handles immediately when the client disconnects (fixes handles accumulating with every wallpaper switch/refresh, and Windows locking that prevented deleting/moving a wallpaper file). The wallpaper-library scan is fully async (fs.promises thread pool), so it no longer blocks the event loop (noticeably faster startup on WSL / big libraries).
- **WSL support** — Steam roots mounted under `/mnt/<drive>` are auto-detected, so a Harness running inside WSL can discover a Windows Wallpaper Engine install.

### v0.4.0

- **Settings persisted to a host file** — all settings (selected wallpaper, accent, transparency, layout, rotation, hidden, speed/flip, …) are now stored in `~/.dsh-wallpaper-engine/config.json` instead of browser localStorage, so they survive restarts, port changes (including DSH Desktop's random `--port 0` loopback port), browser-data clears and browser switches. Legacy localStorage config is migrated automatically on first launch.
- **Edge-compatible rendering** — Edge (and only Edge) paints its built-in "download / cast" media-overlay toolbar over any *visible* `<video>` element, and there is no official switch to disable it. On Edge, video wallpapers are therefore rendered onto a `<canvas>` by default to keep that toolbar away. A new「Edge 兼容」toggle (right-aligned on the 紧凑布局 row, on by default) turns this off and falls back to the native `<video>` in every browser.

### v0.3.1–v0.3.6

- **Liquid-glass settings page** (v0.3.1) — the settings UI is now a **first-level settings page** (following the dsh-web-ui-all skin-center design): the whole page is a customizable liquid-glass card with **accent color** (6 presets + a custom color picker) and **glass transparency** (0–60 %). Both apply instantly and persist.
- **Whole-settings-window liquid glass** (v0.3.2) — one click turns the **entire native DSH settings window** (dialog + left nav + ALL native sections: General / Models / Plugins / …) into liquid glass with your custom accent + transparency. Off restores the stock look.
- **Unified glass tuning** (v0.3.3–v0.3.5) — the settings-window glass blur shares the SAME adjustment as the conversation bar: the **玻璃** (glass) slider (0–60 px) drives the blur radius of both the settings window and the composer/bubbles, with an identical saturation/brightness/contrast recipe. A new **玻璃颜色** (glass color) control lets you tint the glass BASE itself (6 presets + custom picker; defaults white in light / deep navy in dark; once picked, both themes use that color) — **配色** styles the interactive elements, **玻璃颜色** styles the glass itself.
- **Card style & vinyl record** — the 紧凑布局 (compact CD-rack stacking) toggle and the spinning vinyl-record artwork label.

### v0.2

- **Modal wallpaper picker** — the thumbnail grid lives in a popup modal, so the settings page stays compact.
- **Hide / restore (soft delete)** — hide wallpapers you don't want, restore them anytime; no source files are touched.
- **Playback speed** — six native presets from 0.5x to 2x, instant, no media reload.
- **Horizontal flip** — mirror the image (video / web / uploaded images).
- **Custom uploads** — use your own local JPG / PNG / MP4 as a wallpaper, with a configurable storage location, fit modes, and automatic thumbnails for uploaded MP4s.
