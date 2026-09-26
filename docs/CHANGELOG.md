# 变更记录 / Changelog

> 本文件承接原先堆在 README 首页的**版本公告与功能清单**。门面（`../README.md` / `../README.en.md`）
> 只保留与版本无关的亮点；带版本号、issue 号、性能数字的内容一律记在这里。
>
> **归档说明**：本仓库从 **v0.6.8** 起才有 git tag，更早的版本没有独立标签。早于 v0.6.8 的条目
> 按**原 README 原文的版本标注**归档；原文未标注小版本的条目放进区间桶，不臆造版本号。
> 完整逐提交历史见 GitHub Commits / Releases；升级前置条件见 [`UPGRADING.md`](./UPGRADING.md)。

## 中文

### 未发布（下一版）

- **追版合并上游的 WebWallGL 实时渲染（上游 `#103`）**：scene / web 壁纸新增**实时渲染**（`/scene-live` + `/scene-files`，vendored `lib/webwallgl/`，UI 文案「场景实时渲染」/「网页实时渲染」，默认开）。两条渲染路线**并存**：实时渲染优先，失败（首帧 15 秒超时 / 运行期约 40 秒无帧）按壁纸记入失败记忆并自动降级到静态帧链。同批追版还补了上游遗漏的 `lib/webwallgl/` 发布白名单项、把 `svKnown` 诚实化门控补回上游重构后的 `sceneFieldsFor()`、移除了上游那套写 `sf33_` 键而产物无人读取的 `sceneFramePrewarm`，并把 `PIPELINE_VERSION` 提到 `sf45`（**旧帧全部失效、首次显示重新冷渲染，属预期**）。
- **移除「beta 场景动画」**：`betaSceneAnim` 开关、宿主 `/scene-anim` 与 `/scene-anim-progress` 路由、客户端动画升级队列 / 进度轮询 / 探针 `<video>`、worker 多帧渲染与 APNG 输出（含 `lib/apng-encode.js`）**整体删除**。理由：WebWallGL 实时渲染已是它的上位替代（粒子 / 脚本 / 视差 / 包内音频在渲染页内实时执行），而它本身默认关闭、实验性、且旧产物缓存无人回收。用户可见的显示优先级为 **实时渲染 → 场景作者内嵌 MP4（`/scene-video`）→ 静态帧（`/scene-frame`，失败回退主纹理近似）→ 作者预览图 / 自定义画面**。磁盘上遗留的 `san_*.apng|mp4` 仍会被启动清扫回收。
- **静态帧侧 UI 改为三级级联**：「场景实时渲染」（父）→「**静态帧渲染**」（静态帧链**总开关**，默认开）→「**静态帧兜底与调优**」（子分组）。三者都只在上一级"没在生效"时才出现。
  - 「壁纸画面刷新」改名为「**出图来源**」（按钮「换一种」，状态行 `N/M 档  当前：<来源>`）。它只列**自动链没有用到的替代来源**（主纹理单张 / 作者原画 / 自定义画面）——「合成（分层）」与「预览图」正是自动链自己的第 2/3 步，摆出来等于让用户重试刚失败的那一步，故不再作为手动档位；历史档位 5（曾被误当成「静态帧渲染」）与档位 6（合成）**退役**，宿主只认 `?v=1..4`。
  - 「静态帧渲染」关闭时**不再请求渲染产物**：静态帧槽位改由「自定义画面」（档 4）或作者预览图（档 3）填充，并停止空闲预热。
  - 「有损路线」「空闲预热」「GPU 渲染加速」三项仍是调优项，**行为与默认值一律不变**；GPU 开关不再触发已删除的动画升级，改为给 `scene-frame` URL 加 `?gpu=0/1` 强制重取（宿主按新配置算缓存键）。
- **修复两处"设置存不住"（设置字段清单漂移）**：持久化设置由**三份手工维护的清单**描述 —— 客户端
  `serializeSelection()`（发送）、宿主 `sanitizeSettings()`（白名单，PUT 用其结果**整个覆盖** config.json）、
  客户端 `sanitizeSettings()`（读回）。任一份漏字段都会让用户的改动**静默丢失**（界面显示"保存成功"，
  下次打开却回默认值）：
  - **出图来源档位 / 自定义画面存不住**（0.7.5 用户反馈）：宿主白名单缺 `frameVariants` / `customFrames`，
    客户端每次都发、宿主每次都丢 ⇒ 选好的档位与导入的自定义画面刷新即失效。补齐并加校验：档位只接受
    `0..4`（退役的 5/6 丢弃）、键名必须是壁纸 id 形状、`customFrames` 只认字面 `true`、条数上限 200。
  - **四个调优开关从未持久化**（同族反向漂移，`serializeSelection()` 漏发）：`sceneLossyRoute` /
    `sceneGpuAccel` / `scenePrewarm` / `scenePrewarmScope` 在宿主白名单与客户端读回清单里都有，
    只有"写"这一份漏了 —— 其中**空闲预热最严重**：宿主永远读到 `false`，整条预热链从 UI 不可达。
  - **让漂移可观测**：PUT 时若请求带了白名单不认的键，记一行日志列出键名（静默丢弃正是这次难排查的原因）。
  - 护栏：新增 `verify-settings-keys`（真函数往返 + 档位/自定义画面校验 + 三份清单一致 + 反向漂移，
    每条带负对照）与 `verify-sampling`（把此前只存在于 `tmp-*` 探索脚本里的 `blitScaled` 采样证据固化：
    缩小走盒式面积平均、放大走双线性、缩放比 1:1 逐字节不变，负对照用最近邻实现证明判据能区分二者）。
- **修复静态帧 worker 的历史编码乱码**：`lib/scene-render-worker.mjs` 里 **67 行**中文（51 行注释 + 16 行 `gpuDiag` 文案）是历史编码事故留下的乱码。成因已定位：一次被中断的 `main ← catchup-v0.7.5` 合并把乱码带了进来，该次合并的冲突中间态仍以**不可达 blob**（`19070f44`）留在对象库，其中 `main` 一侧就是干净原文（乱码版本还挂在 `catchup-v0.7.5` 分支上，故再次合并可能复发）。67 行**全部还原**：28 行按"转码恒等"判据从干净来源（上述 blob 干净侧 / 早期干净版本 / 遗留的干净工作副本）逐字取回，其余按逆变换碎片与上下文补齐并逐行机械自检；代码骨架逐行比对证明**只动了注释与字符串内容**（零逻辑改动）。新增 `verify-encoding` 护栏：全仓乱码扫描 + 正对照（历史样本必须判红）+ 负对照（专治把 U+9000–U+9FFF 当"生僻区"的误判 —— 道/都/里/重 等常用字都在该区间）。
- **静态帧降级为「缓存兜底」，实时渲染优先**（修「实时渲染在用、静态帧仍在算」的卡顿与黑屏）：场景 / 网页壁纸默认走实时渲染，但此前有两条**多余的静态帧计算**在跟它抢 CPU/GPU ——
  ① **客户端**把静态帧当 live 的**垫底图**（`poster`）：实时渲染一启动就要为这张过渡图跑一次 4K 冷渲染（worker + GPU，数百 ms~数秒）；
  ② **宿主「空闲预热」**不区分实时渲染是否在用，也不区分"当前这张是不是正在实时渲染"，用户空闲时照样为它跑冷渲染。
  两者都能把实时渲染的首帧挤到 15 秒超时之外 ⇒ 看护降级，并把该壁纸写进**失败记忆**（此后一直不实时渲染）；图还没渲染出来时就是**黑屏**。
  现行规则（静态帧的本意 = 场景类壁纸出不了好效果时的取舍方案）：
  - **只命中、不渲染**：新增 `GET /scene-frame/…?cached=1` —— 宿主只查缓存，命中就返回真帧，未命中回 404，**绝不进入渲染路径**（护栏 `verify-prewarm` R11c）。
  - **垫底图只在缓存命中时摆**：客户端 live 分支用 `?cached=1` 取静态帧，未命中就摘掉留空 —— **首次加载可以为空**（宁可牺牲它，也不为过渡图抢实时渲染的资源）；作者预览图**不再**当垫底（画质太差被否）；「静态帧渲染」总开关关掉时连缓存也不摆。
  - **预热改为"为切换 / 轮换攒缓存"**：`/scene-live` + `/scene-files` 的流量算用户活动 ⇒ 预热自动推迟到动画起来之后；当前**正在实时渲染**的那张**不进预热名单**、也不提升队首（判据 `liveSuppressesPrewarm`，与客户端 `liveRenderEnabled` 同口径；`verify-prewarm` R11b 真值表 + 四条负对照）。
  - 实时渲染关掉（`sceneLive === false`）或该壁纸已判失败时，「静态帧就是显示形态」的旧口径照常生效（那时才渲染、才预热）。
  - 护栏另含 `verify-scene-live` 的垫底图断言（缓存优先 + 未命中自摘除）与三个对照（两条负对照 + 一条正对照）。
- **废弃 WebGPU/Dawn 后端（GPU 只保留 WebGL 一条）**：删除 `lib/we-renderer/gpu-dawn/backend.js`（21KB；无人 import，但因为 `files` 收录整个 `lib/we-renderer/` 而**随包出货**）与仅为它服务的 `lib/we-renderer/glsl/wgsl.js`（GLSL→WGSL），并清掉 `render/passes.js` 的 `_dawnEffectCache` 死钩子与相关注释。理由：① **原生崩溃**（同进程二次 `create()` / `unmap` 后立即重建 pipeline，只能每进程一实例）；② 现有 WebGL 路径**尚未榨干**（GPU 效果段现由"每效果一次上传 + `readPixels` 回读"主导，`runEffectChainOnGL` 批处理还能再砍）；③ 依赖更重（WGSL 转译 + 全平台 prebuild）；④ **适用面错位** —— 需要静态帧的机器是没有可用 GPU 的虚拟机 / 远程端。护栏：`verify-fx-chain` 新增 4 条（文件确已删除 / 全仓无残留标识 / 两条负对照）。**注意：并没有对应的 UI 开关可删** —— 全仓唯一的 GPU 行「GPU 渲染加速」驱动的是 **WebGL** 效果适配层（`gpu-gl/adapter.js`），不是 Dawn。另：是否"接入 WebWallGL 同款加速"（用实时渲染器截帧喂静态帧缓存）的权衡与建议见 `docs/RENDERER-FEASIBILITY.md` §8.2。
- 回归护栏：`verify-resource-lifecycle` 的 S7 由「fiber dispose 调用 `cancelSceneAnimUpgrade()`」改为「**beta 场景动画路径在 client 与 host 中都已不存在**，且 dispose 仍清理存活的长命定时器」；新增 `verify-prewarm` R38/R38b（档位集合 / 三级级联 / 分组标题与行序）、`verify-docs`（文档与注释不得停留在旧世界）、`verify-settings-keys`、`verify-sampling`、`verify-encoding`。

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

- **Caught up with upstream's WebWallGL live rendering (upstream `#103`)**: scene / web wallpapers gain **live rendering** (`/scene-live` + `/scene-files`, vendored `lib/webwallgl/`; UI labels 「场景实时渲染」/「网页实时渲染」, on by default). The two render routes **coexist**: live rendering first, degrading automatically to the static-frame chain on failure (15 s without a first frame / ~40 s without a frame at runtime), with the failure remembered per wallpaper. The same catch-up restored the `lib/webwallgl/` entry upstream omitted from the published `files` list, put the `svKnown` honesty gate back into upstream's refactored `sceneFieldsFor()`, dropped upstream's `sceneFramePrewarm` (it wrote `sf33_` keys nothing ever read), and bumped `PIPELINE_VERSION` to `sf45` (**every cached frame is invalidated and re-rendered cold on first display — expected**).
- **Removed "beta scene animation"**: the `betaSceneAnim` switch, the host `/scene-anim` and `/scene-anim-progress` routes, the client-side upgrade queue / progress polling / probe `<video>`, the worker's multi-frame rendering and APNG output (including `lib/apng-encode.js`) are **all deleted**. Rationale: WebWallGL live rendering supersedes it (particles / scripts / parallax / packaged audio run inside the renderer page), while it shipped off-by-default, experimental, and its on-disk artifacts were never reclaimed. The user-visible display priority is **live render → the scene's author-embedded MP4 (`/scene-video`) → static frame (`/scene-frame`, falling back to main-texture approximation) → the author's preview image / a custom frame**. Leftover `san_*.apng|mp4` files on disk are still reclaimed by the startup sweep.
- **The static-frame side is now a three-level cascade**: 「场景实时渲染」 (parent) → 「**静态帧渲染**」 (the static-frame chain's **master switch**, on by default) → 「**静态帧兜底与调优**」 (child group). Each level only appears when the one above it is not in effect.
  - 「壁纸画面刷新」 was renamed to 「**出图来源**」 (button 「换一种」, status line `N/M 档  当前：<来源>`). It lists only the alternatives the automatic chain does **not** already use (主纹理单张 / 作者原画 / 自定义画面) — 「合成（分层）」 and 「预览图」 are that chain's own steps 2/3, so offering them again would just retry the step that failed; legacy tiers 5 (「静态帧渲染」 mistakenly treated as a tier) and 6 (composite) are **retired**, and the host accepts only `?v=1..4`.
  - With 「静态帧渲染」 off, **no render artifact is requested at all**: the static-frame slot is filled by a 「自定义画面」 (tier 4) or the author's preview (tier 3), and idle prewarming stops.
  - 「有损路线」 / 「空闲预热」 / 「GPU 渲染加速」 remain tuning options with **unchanged behaviour and defaults**; the GPU switch no longer triggers the deleted animation upgrade — it appends `?gpu=0/1` to the `scene-frame` URL to force a re-fetch under the new cache key.
- **Fixed two "settings don't stick" bugs (settings-key drift)**: persisted settings are described by **three hand-maintained lists** — the client's `serializeSelection()` (what it sends), the host's `sanitizeSettings()` (the whitelist; the PUT **overwrites** `config.json` with its result), and the client's read-back `sanitizeSettings()`. Any one of them missing a field makes the user's change **silently vanish** (the UI says "saved", the next load returns the default):
  - **Frame-source tier / custom frame never persisted** (0.7.5 user report): the host whitelist lacked `frameVariants` / `customFrames`, so the client sent them on every PUT and the host dropped them on every PUT — the chosen tier and an imported custom frame were lost on refresh. Now whitelisted **with validation**: tiers only `0..4` (the retired 5/6 are dropped), key names must look like wallpaper ids, `customFrames` accepts only literal `true`, and there is a 200-entry cap.
  - **Four tuning switches were never persisted at all** (the same drift, in the opposite direction — `serializeSelection()` never sent them): `sceneLossyRoute` / `sceneGpuAccel` / `scenePrewarm` / `scenePrewarmScope` existed in the host whitelist *and* in the client's read-back list, but not in the client's write list. Idle prewarming was the worst: the host always read `false`, so the whole prewarm chain was unreachable from the UI.
  - **Drift is now observable**: a PUT carrying a key the whitelist does not recognise logs the key names (silent dropping is exactly what made this hard to diagnose).
  - Guards: new `verify-settings-keys` (round-trip through the real function + tier/custom-frame validation + three-list consistency + reverse drift, each with a negative control) and `verify-sampling` (turns the `blitScaled` sampling evidence that used to live only in `tmp-*` exploration scripts into assertions: box-average downscale, bilinear upscale, byte-identical 1:1 path, with a nearest-neighbour negative control).
- **Fixed the static-frame worker's historical encoding mojibake**: **67 lines** of Chinese in `lib/scene-render-worker.mjs` (51 comments + 16 `gpuDiag` strings) were leftovers from an encoding accident. The cause is now pinned down: an interrupted `main ← catchup-v0.7.5` merge brought the mojibake in, and that merge's conflicted working state still sits in the object database as an **unreachable blob** (`19070f44`) whose `main` side is the clean original (the mangled version is still on the `catchup-v0.7.5` branch, so another merge could reintroduce it). All 67 lines are **restored**: 28 taken verbatim from clean sources (that blob's clean side / earlier clean revisions / a surviving clean working copy) under a "re-encode identity" criterion, the rest reconstructed from the inverse-transform fragments plus context, each line machine-checked; a line-by-line code-skeleton comparison proves **only comments and string contents changed** (zero logic change). New `verify-encoding` guard: a repo-wide mojibake scan with a positive control (a historical sample must be flagged) and a negative control (guarding against the "treat U+9000–U+9FFF as a rare block" false positive — 道/都/里/重 are all in that range).
- **The static frame is now a *cache fallback*; live rendering comes first** (fixes the stutter and black screen caused by static-frame work still running while live rendering was in use): scene / web wallpapers render live by default, but two redundant static-frame computations competed with it for CPU/GPU —
  ① the **client** used the static frame as live's **poster**, so starting live rendering also kicked off a cold 4K render (worker + GPU, hundreds of ms to seconds) for a purely transitional image;
  ② the host's **idle prewarming** neither knew whether live rendering was in use nor whether the wallpaper it was warming was the one being live-rendered.
  Either one can push live's first frame past the 15-second watchdog ⇒ guarded degradation, the wallpaper is written into the **failure memory** (so it never live-renders again), and the screen is **black** until the image finally exists.
  Current rules (the static frame's purpose is a trade-off for scenes that cannot render well):
  - **Hit only, never render**: new `GET /scene-frame/…?cached=1` — the host answers from the cache, returns 404 on a miss, and **never enters the render path** (guard: `verify-prewarm` R11c).
  - **A poster is shown only on a cache hit**: the client's live branch requests `?cached=1` and drops the poster on a miss, leaving it blank — **a blank first load is accepted** rather than stealing CPU/GPU from live rendering's first frame; the author preview image is **no longer** used as a poster (quality rejected), and with the 「静态帧渲染」 master switch off not even a cached frame is shown.
  - **Prewarming now exists to build the cache for switching / rotation**: `/scene-live` + `/scene-files` traffic counts as user activity, so prewarming is pushed back until the animation is up, and the wallpaper currently being **live-rendered** is excluded from the candidate list and never promoted (`liveSuppressesPrewarm`, the same criterion as the client's `liveRenderEnabled`; guard: `verify-prewarm` R11b, truth table + four negative controls).
  - The old rule ("the static frame *is* the display form") still applies when live rendering is off (`sceneLive === false`) or that wallpaper has already failed — only then does it render and prewarm.
  - Guards also include `verify-scene-live`'s poster assertions (cache-first + self-removal on a miss) with three controls (two negative, one positive).
- **WebGPU/Dawn backend dropped (WebGL is now the only GPU backend)**: deleted `lib/we-renderer/gpu-dawn/backend.js` (21 KB; nothing imported it, yet it *shipped* because `files` includes all of `lib/we-renderer/`) and `lib/we-renderer/glsl/wgsl.js` (GLSL→WGSL, only Dawn used it), plus Dawn's dead `_dawnEffectCache` hook and comments in `render/passes.js`. Reasons: ① **native crashes** (a second `create()` in the same process, or rebuilding a pipeline right after `unmap`, takes the process down — one instance per process); ② the existing WebGL path is **not yet squeezed** (its GPU effects stage is now dominated by one upload + `readPixels` readback per effect, which `runEffectChainOnGL` batching can still cut); ③ heavier dependencies (WGSL transpile + prebuilds everywhere); ④ **audience mismatch** — the machines that need static frames are VMs / remote sessions with no usable GPU. Guards: four new checks in `verify-fx-chain` (files gone / no references repo-wide / two negative controls). **Note: there was no UI switch to remove** — the only GPU row, 「GPU 渲染加速」, drives the **WebGL** effects adapter (`gpu-gl/adapter.js`), not Dawn. The weighing of "reuse WebWallGL's acceleration" (capture a frame from the live renderer into the static-frame cache) is in `docs/RENDERER-FEASIBILITY.md` §8.2.
- Regression guards: `verify-resource-lifecycle` S7 changed from "fiber dispose calls `cancelSceneAnimUpgrade()`" to "**the beta scene-anim path is gone from both client and host**, while dispose still cleans the surviving long-lived timers"; new `verify-prewarm` R38/R38b (tier set / three-level cascade / group heading and row order), `verify-docs` (docs and comments must not stay in the old world), `verify-settings-keys`, `verify-sampling` and `verify-encoding`.

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
