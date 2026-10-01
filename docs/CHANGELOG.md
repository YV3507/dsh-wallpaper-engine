# 变更记录 / Changelog

> 本文件承接原先堆在 README 首页的**版本公告与功能清单**。门面（`../README.md` / `../README.en.md`）
> 只保留与版本无关的亮点；带版本号、issue 号、性能数字的内容一律记在这里。
>
> **当前发布版本：`v1.1.0`**（与 `package.json` 的 `version` 一致；上游最新 release 仍是 v1.0.1）。
> `### 未发布（下一版）` 记的是 **v1.1.0 之后**的增量（本仓库与上游 `origin/main` 的差异）—— 已有条目，
> 见下；**`### v1.1.0`** 一节收拢的是 **1.0.1 之后至 1.1.0** 的全部内容（打包修复 + 本仓库相对上游的追版成果）。
>
> **归档说明**：本仓库从 **v0.6.8** 起才有 git tag，更早的版本没有独立标签。早于 v0.6.8 的条目
> 按**原 README 原文的版本标注**归档；原文未标注小版本的条目放进区间桶，不臆造版本号。
> 完整逐提交历史见 GitHub Commits / Releases；升级前置条件见 [`UPGRADING.md`](./UPGRADING.md)。

## 中文

### 未发布（下一版）

> v1.1.0 之后的增量（与上游 `origin/main` 的差异，逐提交可查）：

- **界面多语言（跟随 DSH 的语言设置）**：插件界面接进宿主的 `locale` 服务（`@deepseek-ai/dsh-client-locale`，随 dsh-web-app 一起来），**语言目录与 dsh web 完全一致**（内置 `zh` / `en`，语言包通过官方 `addLanguage` 追加后也一并跟随）—— 用户在「设置 → 通用 → 语言」里切一次，插件界面**即时**跟着换，不需要重载页面。实现口径：`src/i18n.js`（取词层，可选服务 + 短轮询，缺服务时停在中文）+ `src/i18n-copy.js`（中文原文即键的英文词表）；语言变了由顶层组件的 `useWeLocale()` 订阅触发重渲染，DOM 补丁（设置 nav 图标、设置入口锚点）由 `weOnLocaleChange` 重放，宿主的 slot / tab / shortcut 注册面用 thunk 标签现读现算。宿主半返回给界面显示的文案（上传 / 字体集 / 素材路径等路由应答）由客户端在显示处按同一张表置换 —— 宿主路由契约零改动；宿主那种**运行时拼接**的消息（`不支持的格式：` + 扩展名）不在覆盖内。新增守卫 `test/verify-i18n.mjs`（零裸中文 / 词表双向对账 / 值纪律 / 运行期跟随 / 顶层订阅契约，逐条配负对照）与迁移共用的扫描器 `test/tools/i18n-scan.mjs`，`npm run verify` 链新增这一环。
- **`verify:bridge` 的「环境跳过」（CI 修红）**：windows-latest 上这条端到端会出现「产物 sha256 正确、进程活着、`hello` 不回、两条流都空」——它与"中间件/协议回归"表现**完全一样**，处置却相反（前者是环境差异，后者必须红），而把引导预算从 25s 抬到 90s 已被实测证伪（runner 上 90s 也拿不到）。现在自检在握手失败时先跑一条**主动探针**（对同一份产物发一次平凡调用，看它是否响应）并**校验产物可信度**（sha256 是否就是发布产物）：只有「探针也说这个环境执行不了它 **且** 产物可信」才记**环境跳过**，并在日志末尾点名"这条通道本次没有断言覆盖"（不冒充通过）；探针说执行得了、或产物不可信，照旧判红 —— 于是"环境跑不了"不再挡住无关 PR，而真回归跑不掉。宿主侧的失败行同时补上**子进程 stdout 的首行非协议输出**与**实际用到的 spawn 姿势**（失败行的两路输出此前只带 stderr 与一句"hello 超时"，而那种现场里 stdout 才是唯一还可能说话的一条流）。
- **失败记忆带「管线身份」（旧断言不再跨管线复用）**：`sceneLiveFailures` 说的是"这张壁纸在**当时那条管线**上出不了帧"，而它偏偏是面板那行「实时渲染失败（…）已自动回退」的**唯一**来源。换了 bundle、或宿主终于把场景媒体源端出来（`sceneMediaBase` 从空串变成 loopback origin）之后，旧断言就该作废一次 —— 现在客户端把管线身份（`LIVE_DIAG_BUILD` + 有无媒体源）记在 `localStorage.weLivePipeline`，启动时**在设置落地之后**核对，不一致就清空那批记忆并重建回 live（不必再手动重开「场景实时渲染」开关）。判据**单向**：只有"bundle 变了 / 媒体源从无到有"才清，反向不清（源一抖动就把真实失败记忆抹掉更糟）。**实测动机**：宿主半没重载时留下的 `timeout` 会让"客户端已更新、宿主是旧的"看起来像是修复完全无效。
- **大场景壁纸的「首帧超时」误判修掉（可用性 · 本机实测驱动）**：现场诊断显示 `scene.pkg` 实测到 **336MB**（不是文档假设的 70–90MB），而**首帧必须等整包到齐** —— 三个客户端实例同时挂载同一份包时传输互相饿死，可见那个实例 15s 后 `stats={"fps":0,"running":false}`（一帧都没出）就被判「首帧超时」，并写进**所有窗口共用**的失败记忆。五处修正：① 首帧预算改成 `15s + 包大小 ÷ 8MB/s`（封顶 90s，包大小由 `/inventory` 的新字段 `scenePkgBytes` 给）；② 宿主加一本**载荷传输账本**（新路由 `GET /wallpaper-engine/scene-payload-progress?token=…`），客户端每拍问一次，**字节还在涨就不计超时**（账本未知/旧宿主一律退回墙钟）；③ **隐藏 / 未播放的实例根本不拉载荷**（建层时延迟赋 `src`、切到后台把 `src` 摘成 `about:blank` 中止在飞请求、可见时补回；层键不含这个状态 ⇒ 不重建、垫底图全程在位）；④ **失败分因**：账本说"传过但没传完"⇒ 只记**会话内**软失败（不落盘）+ 冷却 45s 自动重试（至多 2 次），只有渲染页真的不出帧 / 运行期失联才写共享记忆；⑤ **`scene.pkg` 可重验证缓存**（`ETag`(size+mtime) + `Last-Modified`，命中即 304 无体；入口 HTML 仍 no-store）—— 几百 MB 的包每次重建 live 层都重读一遍盘，靠这一条消掉。
- **场景载荷不再按适配器形态门控（性能修正）**：`mediaOriginNeeded()` 门控的是**网页壁纸的能力头栅栏**，而场景要独立源的理由是**带宽** —— 于是原生浏览器形态下 `sceneMediaBase` 曾恒为空串、大包必然走那条会饿死的应用源（本机日志：同一份 336MB 包在媒体源上 0.6s 到齐，应用源上出现过 15–74s 与永不返回）。现在场景载荷无条件懒起媒体源（起不来才回落应用源），客户端层键带上这一格 ⇒ 宿主把它端出来之后会重建一次渲染页；传输类软失败重试前还会刷一次库存，专治"本实例的 inventory 粘在媒体源起来之前"。
- **诊断补的两处硬伤**：`client-boot`（唯一带页 id / 窗口模式、能回答"同一时刻有几个客户端实例在跑"的那一行）**从来没有落过盘** —— 它在 bundle 顶部调 `liveStateBrief()` → `selection`（`const`，还在 TDZ），异常被外层 `catch{}` 静默吞掉（实测两份诊断文件 2495 行里 0 次）；现改成延迟一拍上报。`liveFail` 的现场也补齐了**载荷账本读数 / 媒体源 origin / 首帧预算 / 传输中 tick 数**，下次再有这类问题不必靠推理。
- **大场景壁纸的载荷改走宿主自建媒体源（性能）**：**场景载荷（`scene.pkg`，常 70–90MB）也走宿主自建的独立 loopback 媒体源**（网页壁纸早就走它）。`/inventory` 新增 `sceneMediaBase`（按"库里**真有**可实时渲染的场景"门控、媒体源不可用时落空串），客户端 `liveRenderUrl` 消费它而**不再自己拼 `location.origin`**。**两点别读错**：① 渲染页自身仍在应用源上（它**必须同源** —— 父页要 `frame.contentWindow.__wp` 直接驱动它），所以提速有上限；② 这是**传输路径的改善，不是安全修复**。
- **媒体源接住根路径 `/diag`（可观测性）**：渲染页的诊断信标打的是 `{mediaBase origin}/diag` —— `mediaBase` 一改指向，这个根路径若不在媒体源上也有落点，"场景首帧超时"时渲染页的告警会以 404 **静默丢掉**。诊断族因此把 `handleDiag` 经出参交给媒体源，两边共用**同一份**环形缓冲（`/diag-log` 读到的是一份）。
- **`/scene-files` 目录围栏补第二层（安全加固）**：目标文件的**真实路径**必须仍落在壁纸目录内 —— `lstatSync` 拒链接 + **`realpathSync.native`** 包含性比对，且该层 **fail-closed**（除"不存在"外一律围栏）。实测确认 **JS 版 `realpathSync` 在 Windows 上不解析 junction**（`.native` 才解析），故这一层必须用 `.native`。（**残留**：`lib/scene-manifest.js` 的 `dirSceneAccess` 仍是 junction 盲的，属另一条路由族，本次未动。）
- **启动等待期的预热渲染页泄漏修掉（与上面 ③ 互补）**：`boot-mount-cancel`（启动等待窗口内重新选择壁纸）对**分离态** iframe 赋 `src=about:blank` **不会提交导航** —— 预热页带着整个 WebWallGL 引擎常驻到会话结束（本机实测一次泄漏 **9 个 4K 引擎**存活 1 小时，是"切了几张之后大包首帧全变慢"的放大器；③ 管的是**已挂载**层的可见性暂停，管不到这条**从未挂载**的预热页）。改为先隐身挂进文档让导航真实提交、再移除空壳；已连接（被领养）的帧照旧绝不动。

### v1.1.0（1.0.1 → 1.1.0 · 2026-09-29）

> 本安装包含 **1.0.1 之后至 1.1.0** 的全部内容（自 v1.0.1 `6ba2fae` 起落地的提交）。

**界面**

- **主题随壁纸（自动深 / 浅切换）**：换壁纸后插件按壁纸决定全局深色 / 浅色 —— 取色顺序 **① 壁纸自己声明的配色**（`project.json` 的 `schemecolor` / `ui_browse_properties_scheme_color`；你在「壁纸属性」面板里改过的覆盖值优先；**作者填的恰好 `0 0 0` 视作"没填"** —— 那是 WE 新建工程的默认值，本机实测 360 张里 124 张是它，照用会把三分之一壁纸一律钉成深色；面板里显式填的纯黑不受这条影响）**→ ② 画面占比最大色**（64×64 下采样、4 bit/通道量化后取众数桶，只在 ① 缺席时跑；**两个来源合议** —— 作者预览图与真实渲染帧（场景抓帧 / 网页 `__wp.capture`）各判一次，**不一致时取深色**，只有都说是浅色才用浅色（抓帧有落在画面未稳定时刻的风险，而"该深却给浅色"肉眼最容易看见））**→ ③ 两条都拿不到就保持不动**（不抖）；判定用 WCAG 相对亮度，阈值 **0.40**（语义是"**明显偏亮**才配浅色界面"；不取中灰 0.2159 —— 实测本机库作者配色的亮度中位数是 0.214，中灰阈值正好切在分布最密处、±0.05 内 27 张，饱和中间调会被判浅而人眼看是深的）。**默认关**（「外观 → 主题」段最上方的开关，设置键 `themeFollow`；开启后行为即自动，关闭时六个入口全空转 —— 不取色、不判决、不写主题，也不留让位痕记，并清掉它此前留下的合议排名与状态行）。三条自我约束：**结论与当前偏好相同就不写**（`setTheme` 会把偏好落进 profile 的 `cordis.patch.yml`，轮换列表混着亮暗两派时不去重就是每次切换写一次盘）；**你在 DSH 设置里手动改过主题 ⇒ 本张壁纸不再自动**（同一张被重复评估也不会抢回来），**换下一张恢复**；宿主没提供主题服务（`theme`）时整体不生效、绝不抛。顺带修好一处哑管道：宿主早就发了 `schemeColor`，客户端从没接 —— 场景 / 网页壁纸首帧的垫底图因此一直走 CSS 变量兜底，现在按作者配色打底。
- **适配器模式（「适配目标」）**：「高级」页签新增「**适配**」段 —— 自动识别插件跑在 **原生浏览器 / 非官方桌面端 / 官方桌面端** 哪一种里，显示「检测到：… · 有 / 无能力头栅栏」，并可手选覆盖（**手选优先于检测**，是检测不准时的自救）。判定**与操作系统无关**：宿主按**请求头与 UA** 观测 —— 能力头 `x-dsh-desktop-renderer` ⇒ 非官方桌面端（实测只有社区壳 `DSH Desktop.app` 注入，官方 `DeepSeek Harness.app` 的 `app.asar` 里该字面量零命中）、UA 含 `Electron/` ⇒ 桌面壳、两者皆无 ⇒ 原生浏览器；观测用**只增不减的闩锁**，首帧前的探活请求不会把已判明的桌面端改回浏览器（错判成浏览器的代价是网页壁纸 403）。它同时决定四处行为：① **网页壁纸载荷**走独立媒体源还是应用源 —— 原生浏览器没有栅栏就不再多开一个 loopback 监听，该形态的相对路径由守卫单独断言；② **外壳材质规则**（`data-dsh-desktop-mode` / `data-we-mica`）一律经 `[data-we-adapter^="desktop-"]` 门控，浏览器形态不吃壳层材质；③ **「窗口失焦时暂停」只在浏览器目标下提供**（桌面壳失焦时壁纸多半仍整块可见，暂停会定格**可见**画面；已保存的值不删，切回浏览器目标即恢复生效）；④ **面板按目标显隐并说明原因**，手选与检测冲突时给出可执行警示（手选浏览器却观测到栅栏 ⇒ 明说网页壁纸会 403）。
- **设置页签重组**：「字体」页签并入「**外观**」，「玻璃」改名「**雾化**」，调节项按用途归位（外观 / 效果 / 声音 / 高级）—— 页签仍是六个（壁纸 / 外观 / 吉祥物 / 效果 / 声音 / 高级）。
- **字体集（整套字体外观的预设）**：字体自定义从此以**一整套**为单位 —— 随包自带预设，可**新建（以当前外观）/ 重命名 / 删除**；改任何字体项都只落到**当前这一套**，随时可以「恢复原样」回到它本来的样子（改过之后那一套会标注「已改」，点「使用」即整份读回来）。支持**导出 / 导入**一份 `.json`（导出走系统「另存为」对话框，导入前先校验文件里的版本标记，坏文件会给出具体原因）。界面只说"哪一套在用"，不区分随包还是自建。
- **「只看改过的」默认开启**：排版角色表默认只列改过字号 / 字重 / 字族的角色（一行都没改时会给一行提示），并挂成「字体自定义」的一部分 —— 总开关关掉时整块收起。
- **换壁纸过场动画（7 种可选）**：交叉淡化 / 推移 / 擦除 / 光圈 / 缩放 / 条带 / 百叶窗；**默认硬切**，手动点选与自动轮播共用同一套；类型 / 方向 / 速度档**走白名单**（未知值回落默认）。「条带」本轮改为真·百叶窗（原实现与「擦除」肉眼分辨不出）。
- **实时帧行**不再受「实时渲染」开关限制（随时可重新截帧），并显示当前壁纸的实时帧**微缩预览**。
- 过场动画选项改为**下拉菜单**，删去两行冗余面板提示。
- **「启动延迟」改名「启动最长等待时间」，语义改为上限**：延迟期照常预加载（首帧先热起来），**首帧一就绪就换上**、到上限仍未出帧也换上；选项写成 `立即 / ≤3s / ≤5s / ≤10s`。

**日志与提示**

- **终端默认只报问题**：宿主输出收敛成三档（档位名就是日志方法名）—— `error`（会导致插件 / DSH / 系统出问题）、`warn`（降级 / 回退 / 围栏拒绝 / 首帧超时等**影响显示效果**的非正常表现）、`info`（其余全部：逐张贴图、心跳、autosize gate、准备期探测、成功事实的日志侧留痕）。**终端默认只镜像 `error` + `warn`**，`info` 只在 `DSH_WE_LOG_LEVEL=info` 时可见（取值 `error` / `warn` / `info`，默认 `warn`）。此前每一行渲染器上报与心跳都直接打到终端（实测约 18 行/分钟）。
- **成功提示改走独立通道**：终端上的一行 `[wallpaper-engine] … ✔`（「壁纸媒体源已监听」「场景壁纸已就绪」，**与日志行同前缀**，`✔` 只标记"这是成功提示、不是问题"），**每条每会话至多一条**（HMR 重挂不重发）；不经日志、不带级别、不落档。它只在 stdout 是终端时出现 —— DSH 桌面端的宿主由 Electron 以管道启动（`isTTY` 为假）⇒ 桌面端默认安静，`DSH_WE_NOTICE=1` 可显式打开、`=0` 永久静默；**投递失败**才产生一条 `warn`。
- **每个上报端点都自己声明级别**：客户端 `[we-live]` 的诊断行随同源像素请求带上 `&lvl=`（宿主对未知 / 缺失一律落 `info`）；**渲染页**（随包的 WebWallGL 产物）原先只把级别喂给浏览器控制台、请求里丢掉 —— 渲染页同步到 **2.0.2 后自带 `&lvl=`**（按与宿主一致的失败模式表判定），宿主侧 `levelForReport` 一律**以发送端声明为准**、只在声明缺失时才退回那张表；期间曾用过的本地补丁已随 2.0.2 删除。轮换准备期的首帧连续超时从裸 `console.info` 并入同一条通道并标 `warn`。
- **诊断档案加上限**：`~/.dsh-wallpaper-engine/diag/http.jsonl` 写到 8 MiB 时轮转为 `http.jsonl.1`（只留一代）；`/diag-log` 与每行 JSON 的形状不变。
- **客户端异常也留痕**：面板的渲染期异常此前只表现为"界面白掉"——而那台机器打不开 DevTools，诊断缓冲里什么都没有。现在 `error` 与 `unhandledrejection` 会把消息与栈前三行写进同一条诊断通道（标签 `client-error`，级别 `error`），排查时先 `Select-String 'client-error'`。
- 详情与开闸命令见 [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) 的「终端输出：默认只报问题」。

**修复**

- **原生确认弹窗会让壁纸停住、且不再自己恢复**（上游无 issue，实测复现）：`window.confirm` 把焦点交给它自己的窗口 ⇒ 若开着「窗口失焦时暂停」（`pauseOnBlur`），弹窗一出现壁纸就停；模态期间渲染线程被**同步阻塞**（输入框收不到键）；关闭时回来的 `focus` 事件**不保证送达** ⇒ 遮挡判定永久卡在"窗口失焦"，只能重载页面。现在遮挡判定除事件外还做**低频复核**（3s，只在判定变化时 emit 并留一行 `occlusion-recheck` 诊断），并把字体集里的删除改成**面板内确认**（不再使用原生对话框）。
- **按钮与链接不再大小不一**：「重命名」（`<button>`）与「导出」（`<a>`）共用那枚类名，而它原先只钉住了 `<button>` 的盒子 —— `<a>` 默认 `inline`（**行内盒忽略 `height`**）、`content-box`、不继承字体，还带下划线。现在该类名对两种元素都成立（`display` / `box-sizing` / `font` / `line-height` / `text-decoration` 全部写明）。
- **启动等待期切下一张会卡**：延迟期那个未上屏的 iframe 是**正在跑的渲染页**（不是普通元素），换壁纸时无人终止 ⇒ 它留在后台继续拉 pkg / 解码纹理 / 上传，与新壁纸的启动叠在同一主线程上。现在 `applySelection` 与卸载都会清定时器并把它 `src=about:blank` **中止**；挂载处另补一次心跳武装（`load` 回调只在已挂载时武装，而延迟路径的文档可能在挂载前就 load 完 ⇒ `we-live-on` 会永远不加上）。护栏 `rotation-prepared-leak-smoke` 的 Q1 / Q2 / Q3（各带可失败对照）。
- **首次激活场景壁纸不再黑屏**：新壁纸**第一次**激活时实时抓帧还不存在（要等这一轮 live 回填），而垫底画面当时只试「抓帧」一级、失败后**静默保留近黑主题色** ⇒ 首帧前是一块黑屏。现在垫底画面按 **实时抓帧 → 作者随包发布的预览图 → 主题色** 取：预览图**只作占位**（不算"替作者猜一张图"，`/scene-frame` 的空态语义**不变**、服务端一个字节没改），live 首帧一到即被顶掉；护栏 `rotation-prepared-leak-smoke` 的 P / P2（正 / 负对照成对）。
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
- 打包白名单回归断言（`verify-package-files`），覆盖 `lib/**` 全部运行时模块。
- **发布面三处补强（v1.1.0）**：
  - **`scripts/prepare.mjs` 进入 `files`**：`prepare` 在 git 直装、或把包装成**根项目**执行（解包后 `pnpm install`）时真的会跑 —— 脚本不随包就是执行即 `MODULE_NOT_FOUND`（把发布包解开当根项目跑 `pnpm install` 可稳定复现）。配套：`verify-package-publish` ⑦ 不再把 `prepare` 当开发期脚本（它的引用必须随包），② 只为这一个文件开白名单，其余 `src/` `scripts/` `test/` `docs/` 照旧一律判红。
  - **可达闭包的相对导入目标必须在磁盘上在位**（`verify-package-publish` ① 新增断言 + 负对照）：指向不存在文件的 import 在仓库里是死路径、本地没人撞得上，装到用户机器上才炸成 `ERR_MODULE_NOT_FOUND` —— npm 上的 1.0.1 正是这么残缺的（`lib/scene-scripts.js` 引用的 `./scene-script-apis.js` 从未进过发布物）。同一口径再落到 `verify-package-files` 的新 **P7**：扫 `lib/**` 全部运行时模块（不只 `lib/index.js` 的可达闭包），相对导入目标缺失即判红。
  - **版本 `1.0.1 → 1.1.0`**：npm 上的 1.0.1 已发布且不可覆盖，仓库与它内容不同步，只能靠新版本把当前代码带上去。

**文档与仓库整理**

- 规划文档入库（`docs/`）；**静态帧渲染线归档**到 `docs/archive/static-frame/` —— 该线与 beta 场景动画线的渲染器实现均已迁往独立仓库 [`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame)（把场景离线渲染成一张 PNG，可当库或 CLI 用），**将由其它贡献者在下次更新移除**。

**移除 / 行为变更**

- **静态帧线整体移除**：离线场景渲染器 / 主纹理提取 / 合成器，以及「静态帧」后台预热**全部删除**（约 1 万行）。场景壁纸的**出图来源**现在只有两级 —— **实时画面**（实时抓帧，优先）与**自定义画面**（你导入的截图）；两者都没有时**诚实留空**，不再"替作者猜一张图"（那会产出一张糊图，把"这张壁纸没有可用画面"这个**可判定事实**掩盖掉）。
  配套：`?v=1/2/3` 档位退役（旧配置按"自动"处理，**无需迁移**）；帧缓存键改名升值（旧缓存自动失效重建，代价只是重抓几张实时帧）；面板上「壁纸画面刷新」改名为「**出图来源**」（两档）。

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
- **媒体三平台**：media-bridge 接入（macOS / Windows / Linux），中间件版本钉 v0.1.5（频谱口径修正 + 采集跟随默认输出设备）；歌曲封面（Now Playing artwork）通用取源；新增**在线歌词**（本地 `.lrc` / 已缓存优先，本地没有才向 lrclib.net 查一次 —— 该请求会外发歌名 / 歌手 / 专辑，因此默认关闭）。
- **网页壁纸修复**：独立壁纸媒体源提供载荷（修 Desktop 全黑）、跨源重复注入 shim 导致帧率被限两次、渲染页同步 webwallgl 1.4.2（含两类网页壁纸白屏修复）。
- **GPU 抓帧回填 + 几何校验**：实时帧缓存回填静态帧缓存、面板状态 / 清除入口、CPU 渲染严格门禁；存帧视比与当前视口不符自动清掉重抓。
- **视频类壁纸恢复 0.7.5「选中即播」**（去掉 preview 海报与预热探测链）；官方资源路径（WE assets 目录，宿主半边 + 客户端半边）。
- **排查台**：网页壁纸「白屏」排查（无头真浏览器截图 + 控制台报错）；渲染链路黑匣子（客户端关键步骤上报 + 宿主落盘）。

### v0.7.5

> 上游 v0.7.5 的内容（`#91` 字体重做与画面刷新档位、`#99` 视频壁纸音轨、玻璃饱和度不再随模糊上涨 `#98` 等）+ 本仓库 **0.7.4 全部内容**（见下节）。
> ⚠️ **WebWallGL 实时渲染（`#103`）与 `lib/webwallgl/` 发布白名单不在本版内** —— 它们是**追版合并**的成果（后来随 `v1.1.0` 一并发布）；本版发布时的管线前缀是 `sf33_`。

### v0.7.4（未发布 — 内容并入 v0.7.5）

> npm 上的 0.7.3 已被更早的提交占用且不可覆盖，故版本上调；0.7.4 = 0.7.3 内容 + #88（场景静态帧系列修复）+ 下列两条。**该版本号从未发布到 npm**（`0.7.3 → 0.7.5`），其内容随 v0.7.5 一起出货。

- **输入框玻璃定位修复**（[#89](https://github.com/elysia395/dsh-wallpaper-engine/issues/89)，社区 PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)）：`[data-composer-card]` 内含 `position:fixed` 后代（`@dsh-external/dsh-webui` 把「AI 浏览器」座位挂在卡片内部），而卡片上的 `backdrop-filter` 按规范会成为这些 fixed 后代的**包含块** —— 座位不再相对视口定位、多出数百 px 幽灵溢出，输入框滚到底时被留在上方。现在模糊改由 `::before` 伪元素承载（伪元素没有 DOM 后代，永远不会成为包含块），模糊半径 / `--we-*` 变量 / 圆角全部沿用，视觉等价。
- **场景内嵌视频字段诚实化**（[#92](https://github.com/elysia395/dsh-wallpaper-engine/issues/92)，社区 PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)）：过去 inventory 用「静态帧可用」冒充「内嵌 MP4」，对几乎所有场景壁纸都输出 `sceneVideo` URL，客户端请求 `/scene-video` 必然 404。现在按「pkg 路径 + mtime」缓存真实探测结果（有界 LRU + 后台补齐 + 真实请求回填，未知一律 `null`、绝不猜），只有确认内嵌 MP4 才给地址。

### v0.7.3

- **自定义上传壁纸可用性 + 播放状态如实显示**（[#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)）：
  - ① 自上传内容在 `uploads/.meta.json` 里从不写 `contentrating`，过去算「未分级」而内容分级默认是 **Everyone**，于是**所有自上传壁纸默认被过滤掉**（网格里看不到、被上传流程自动应用时直接拒绝 → 壁纸层空白 + 播放按钮变灰）。现在未标注分级的自上传内容按 **Everyone** 处理，自己的文件开箱即用，显式标注 G / PG13 / R 的照常过滤。
  - ② 视频 `play()` 被拒（自动播放策略、浏览器解不了的编码如 HEVC/10-bit、被紧接着的 src 切换打断）时过去**静默吞掉**：面板继续写「播放中」、卡片上只有「暂停」，壁纸冻在首帧却无「继续」可点。现在按 `<video>` 的**真实状态**显示，按钮回到「播放」可重试并给出原因（如「无法解码这段视频，建议改用 H.264」），并在媒体就绪后**自动补一次播放**。
  - ③ 被过滤条件丢弃的当前壁纸不再是无解释的空白，卡片上会写明是哪一项过滤挡住的。
- **壁纸透明度**（[#82](https://github.com/elysia395/dsh-wallpaper-engine/issues/82)）：「效果」区新增滑动条（0–90 %，越大越透，默认 0 %）——把壁纸整层淡出、融向页面底色，即 IDEA 背景图式的「看得见但不喧宾夺主」；与暗化互补，文字可读性不受影响。
- **输入光标颜色**（[#83](https://github.com/elysia395/dsh-wallpaper-engine/issues/83)）：「字体」页签新增 **输入光标** 分区——光标颜色与壁纸相近看不清时，可从 6 种预设或自定义取色器里挑一个高对比颜色（也可选「自动」恢复 dsh 原生表现，默认即为「自动」）；作用于所有输入框与可编辑区域，独立于字体自定义开关。

### v0.7.2

- **前置条件升级**：适配 DeepSeek Harness **0.1.5-rc.1**（DSH Desktop ≥ 2.0.7），并要求 **dsh-better-sidebar ≥ 0.19.0**。升级顺序与回退方式见 [`UPGRADING.md`](./UPGRADING.md)。
- **修复「右侧栏完全透明」并把玻璃扩展到官方原生右侧栏**：harness 0.1.5 的官方原生右侧栏面板直接绘制 `--dsw-alias-bg-base`——这正是本插件为露出壁纸设成透明的 token，且官方面板没有自己的毛玻璃，导致升级 better-sidebar 0.19 后右侧栏整体透明。v0.7.2 起官方原生右侧栏纳入「侧栏液态玻璃」适配：同一组**侧栏模糊 / 透明度 / 玻璃颜色**滑杆生效，总开关关闭时回退主题面板色（不再透明）。这组滑杆是：**侧栏液态玻璃**（总开关，默认开）· **侧栏模糊**（0–200 px，默认 16）· **侧栏透明度**（0–200 %，默认 120 %，越大越透）· **侧栏玻璃颜色**（6 预设 + 自定义取色，默认 `#ffffff`）。
- 追补修复：侧栏颜色调节与内容面在官方原生右侧栏失效；侧栏颜色混入强度改为独立于透明度的可见性曲线。

### v0.7.1

- **适配 DeepSeek Harness 0.1.2-rc.1**，并在 **DSH Desktop v2.0.5** 上完成实测：壁纸宿主路由（inventory / media / scene-frame）、设置一级分区、选择器弹窗、视频与场景壁纸播放、拉绳抽屉、液态玻璃在「兼容模式」与「增强模式」下均正常。本插件依赖的 slots / webserver / 主题变量等 API 在 0.1.2-rc.1 → 0.1.5-rc.1 之间经实测同样稳定。
- **修复 rc.1 的「色板 / 黑胶唱片变圆角矩形」**（[#74](https://github.com/elysia395/dsh-wallpaper-engine/issues/74)）：rc.1 主题层新增 `corner-shape.css`，给**所有元素**统一加了 `corner-shape: superellipse(1.5)`（方圆形角），任何 `border-radius:50%` 的正圆都被渲染成圆角矩形。插件现已对自身绘制的全部正圆 / 胶囊控件（色板、黑胶唱片、滑杆圆点、开关滑块、字体 chip 等）显式重置 `corner-shape: round`，在旧版 harness 上该声明会被自动忽略、无副作用。

### v0.6.8

- 场景渲染管线的稳定化修复批次（solid layer 白方块 / JPEG 回退 alpha / clearcolor / `#86` 残留 / 资源泄漏回归护栏）；发布包 `files` 白名单回归由 `test/verify-package-files.mjs` 长期看护。

### v0.6.7

- **字体自定义**：设置新增「字体」分区——总开关默认关闭（即 dsh 原生外观），开启后可调 **字体颜色 / 字重(100–900) / 字体族**（默认 · 雅黑 · 楷体 · 宋体 · 黑体 · 行楷 · 等宽，选项按钮以各自字体实时预览）；报错红字不受染色影响，关闭总开关即一键恢复默认。

### v0.6.4

- **优化「沉浸式全屏窗口偶尔全屏闪白」**（保留完整毛玻璃）：早期版本在**桌面快捷方式打开的沉浸式全屏窗口**（独立应用 / kiosk 窗口）里，点击对话或输入文字时**可能整屏闪白一下**——这是该窗口 + 硬件加速下，Chromium 合成器对壁纸重绘时偶发把整屏画白。v0.6.4 继续按「减少合成层」处理：仓库面板关闭时懒加载、拉绳无永久滤镜、壁纸媒体默认下不再强制一个变换合成层——同时**完整保留毛玻璃**；普通浏览器标签页完全不受影响，保持完整毛玻璃与硬件加速。插件更新后会弹一次提示，告知此优化（每个新版本仅出现一次）。

### v0.6.3 前后

- **吉祥物（聊天顶部拉绳）**：一条可拖拽的拉绳沿顶部吸附，向下拉即拉出**壁纸仓库**抽屉；可切换形态（小女仆 / 鲸御姐）与大小（0.5×–2.5×）。
- **壁纸效果调节条扩充**（v0.6.x）：「壁纸效果」区新增 **亮度 / 对比度 / 饱和度** 三个滑动条（**亮度 40–160 % / 对比度 40–200 % / 饱和度 0–200 %**，默认均 100 %；作用于壁纸媒体滤镜），与壁纸模糊 / 暗化等配合，任意壁纸都能调到与界面融合舒服的状态；全部即时生效、持久保存。

### v0.6.0

- **场景壁纸完整场景帧**：Scene 壁纸由纯 JS 场景渲染器完整重放（对象树 / 纹理 / 粒子 / shader 效果），不再是主纹理静态帧。实现细节见 [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md)。

### v0.5.x

- **遮挡暂停（省电三档）**：类似 Wallpaper Engine 的「被遮挡时暂停」——最小化 / 切页、窗口失焦、使用电池供电时自动暂停视频壁纸，**解码引擎直接归零**；回到界面 / 接通电源自动继续（网页壁纸仅随页面隐藏被浏览器节流）。三档开关均持久保存，分别是「最小化 / 切页时暂停」（默认开）、「窗口失焦时暂停」（默认关）、「使用电池时暂停」（默认关）；场景实时渲染同样会在这些时机暂停渲染循环。
- **解码帧率上限（抽帧转码）**：高帧率源（如 4K120 H.264）的硬解是 GPU 占用大头（4060 实测 1.0x 达 ~60% Video Decode）。宿主端用 ffmpeg 一次性重编码为上限帧率（时间线保持 1.0x **正常速度**、与倍速完全解耦），输出 **4K 保留 + AV1**，带下载 / 转码实时进度条；实测 4K120→24fps 后占用从 ~60% 降至 **~15%**。ffmpeg 三档供给：显式指定 → 自动下载（npmmirror + GitHub 双源竞速）→ 系统 PATH。档位为 无限制 / 60 / 48 / 30 / 24 fps，源帧率已在上限内自动跳过；按「路径 + mtime + 上限」缓存，轮转里每张只付一次成本；转码优先 **NVENC**（`av1_nvenc` → `h264_nvenc`），无 NVIDIA 显卡时回落 **libx264 软件编码**；只有拿不到 ffmpeg 时才自动关闭、壁纸保持原片。

### v0.4.1

- **媒体流句柄修复 + 扫描提速**：媒体 / 预览 / 场景帧流在客户端断开时**立即释放文件句柄**（修复反复切壁纸 / 刷新累积句柄、Windows 上壁纸文件被锁无法删除 / 移动的问题）；壁纸库扫描改**全异步**（fs.promises 线程池），不再阻塞事件循环（WSL / 大壁纸库下启动明显更快）。
- **WSL 支持**：自动探测 `/mnt/<盘符>` 挂载的 Windows Steam 库，WSL 里也能发现壁纸。

### v0.4.0

- **设置持久化到宿主端文件**：全部设置（已选壁纸、配色、透明度、布局、轮播、隐藏、倍速 / 翻转等）改存 `~/.dsh-wallpaper-engine/config.json`，不再依赖浏览器 localStorage —— **重启、换端口（含 DSH Desktop 的随机端口）、清浏览器数据、换浏览器都不再丢失**；旧版 localStorage 配置首次启动自动迁移。
- **Edge 兼容渲染**：Edge（且仅 Edge）会在页面里任何「可见的 `<video>`」上绘制浏览器自带的「下载 / 投屏」悬浮工具栏，且没有官方开关可以关闭；插件因此在 Edge 中默认把视频壁纸改为 **canvas 渲染**来规避。「紧凑布局」同一行右侧新增「**Edge 兼容**」开关（默认开启），关闭后所有浏览器一律回退到原生 `<video>`。

### v0.3.1–v0.3.6

- **液态玻璃设置页**（v0.3.1）：设置页升级为**一级设置页**（参照 dsh-web-ui-all 皮肤中心的设计），整页是可自定义的液态玻璃卡片 —— **配色**（6 种预设 + 自定义取色）与**配色**（默认经典蓝 `#4f8cff`）与**玻璃透明度**（0–60 %，默认 12 %）即时生效、持久保存。
- **整个设置窗口液态玻璃化**（v0.3.2）：一键把 **DSH 原生设置窗口整体**（对话框 + 左侧导航 + General / 模型 / 插件等**全部原生分区**）换成液态玻璃 + 自定义配色；关闭则恢复原生样式。
- **玻璃调节统一**（v0.3.3–v0.3.5）：设置窗口的玻璃模糊与**对话栏共用同一套调节参数**（「玻璃」滑动条 0–60 px 同时控制设置窗口与输入栏 / 气泡的模糊半径，饱和度 / 亮度 / 对比度配方一致）；新增「**玻璃颜色**」—— 设置窗口玻璃的**底色色调**可自定义（6 预设 + 自定义取色，默认浅色白 / 深色深夜蓝，选定后两种主题统一使用该色），与「配色」分工：**配色管控件、玻璃颜色管玻璃本身**。
- **卡片样式与黑胶唱片**：「紧凑布局」开关（CD 架式纵向层叠）与旋转黑胶唱片标签效果。

### v0.2

- **壁纸选择弹窗**：缩略图网格收纳进独立弹窗，设置页不再被长列表占满。
- **隐藏 / 恢复**：不想看的壁纸一键隐藏（软删除），随时恢复，不碰源文件。
- **视频倍速**：0.5x – 2x 六档原生调速，即时生效、不重载。
- **水平翻转**：镜像画面（视频 / 网页 / 上传图片均适用）。
- **自定义壁纸**：直接上传本地 JPG / PNG / MP4 当壁纸，可选存储位置（默认 `~/.dsh-wallpaper-engine/uploads`，可改到任意盘符并自动迁移已有文件）与画面适配模式（覆盖 / 填充 / 居中 / 拉伸）；上传的 MP4 自动生成抽帧缩略图。

---

## English

### Unreleased (next version)

> Increment after **v1.1.0** (the diff against upstream `origin/main`, verifiable commit by commit):

- **Large scene wallpapers now take the host's own media origin (performance)**: **Scene payloads (`scene.pkg`, often 70–90 MB) now use the host's own dedicated loopback media origin too** (web wallpapers already did). `/inventory` gained `sceneMediaBase` (gated on "the library really holds a live-renderable scene"; an empty string when the media origin is unavailable), and the client's `liveRenderUrl` consumes it instead of **hard-coding `location.origin`**. **Two things not to misread**: ① the renderer page itself stays on the app origin (it **must** be same-origin — the parent drives it through `frame.contentWindow.__wp`), so the speed-up has a ceiling; ② this is a **transport-path improvement, not a security fix**.
- **The media origin now answers the root `/diag` (observability)**: the renderer's diagnostic beacon posts to `{mediaBase origin}/diag` — once `mediaBase` points elsewhere, that root path must exist on the media origin too, otherwise a first-frame-timeout report loses the renderer's warnings to a silent 404. The diag family therefore hands `handleDiag` to the media origin through an out-parameter, so both mounts share **one** ring buffer (there is a single `/diag-log`).
- **`/scene-files` gained a second fence layer (security hardening)**: the target file's **real path** must now still be inside the wallpaper directory — `lstatSync` rejects links plus a **`realpathSync.native`** containment check, and that layer is **fail-closed** (anything other than "does not exist" is fenced). Measurement confirmed that **JS `realpathSync` does not resolve junctions on Windows** (`.native` does), which is why this layer must use `.native`. (**Residual**: `dirSceneAccess` in `lib/scene-manifest.js` is still junction-blind; it belongs to a different route family and was left alone.)

### v1.1.0 (1.0.1 → 1.1.0 · 2026-09-29)

> This install contains everything after **1.0.1** up to **1.1.0** (the commits landed since v1.0.1 `6ba2fae`).

**UI**

- **Theme follows the wallpaper (automatic light/dark)**: after a switch the plugin picks the global theme from the wallpaper — colour order **① the wallpaper's own scheme colour** (`project.json` `schemecolor` / `ui_browse_properties_scheme_color`; an override you set in the **壁纸属性** panel wins, and an author value of exactly `0 0 0` counts as **unfilled** — that is the WE editor's default for new projects and 124 of 360 wallpapers here carry it, so taking it at face value would pin a third of the library to dark; a hand-picked pure black in the panel is still honoured) **→ ② the most-occupied colour of the picture** (64×64 downsample, 4 bits/channel quantisation, modal bucket — only when ① is missing; the author preview and a **real rendered frame** (scene capture / web `__wp.capture`) each vote, and **a disagreement resolves to dark** — light only when both agree; a capture can land on a not-yet-settled frame, and "should be dark but came out light" is the error the eye notices) **→ ③ neither available ⇒ leave the theme alone** (no thrashing). The verdict is a WCAG relative-luminance threshold of **0.40** ("only clearly bright colours get a light UI"; not mid grey 0.2159 — the author colours in this library have a median luminance of 0.214, so a mid-grey threshold cuts through the densest part of the distribution (27 wallpapers within ±0.05), and saturated mid-tones end up "light" while the eye reads them as dark). **Off by default** — a switch at the top of the "Appearance → Theme" section (setting key `themeFollow`); when on, the behaviour *is* the feature; when off, all six entry points idle (no colour sampling, no verdict, no theme write, no bookkeeping) and the yield marker / vote ranking / status line it had written are cleared. Three self-imposed rules: **nothing is written when the verdict already matches the current preference** (`setTheme` persists the preference into the profile's `cordis.patch.yml`, so without de-duplication a rotation list mixing light and dark wallpapers would rewrite that file on every switch); **changing the theme by hand in DSH stops it for the current wallpaper** (re-evaluating the same wallpaper will not take it back) and **the next switch resumes it**; when the host provides no `theme` service the whole thing stays inert and never throws. Along the way a dead pipe got fixed: the host had been sending `schemeColor` all along while the client never consumed it, so the first-frame poster fell back to a CSS variable — it now uses the author's colour.
- **Adapter mode (「适配目标」)**: the **高级** tab gained an **「适配」** section that works out which of **a plain web browser / the unofficial desktop client / the official desktop client** the plugin is running in, shows 「检测到：… · capability header present / absent」, and lets you override it — **a manual pick wins over detection**. Detection is **OS-independent**: the host observes **request headers and the UA** (the `x-dsh-desktop-renderer` header ⇒ unofficial desktop client — measured to be injected only by the community shell `DSH Desktop.app`, with zero hits for that literal in the official `DeepSeek Harness.app` `app.asar`; `Electron/` in the UA ⇒ desktop shell; neither ⇒ plain browser) and latches what it sees **without ever unwinding it**, so a health probe before the first frame cannot demote a known desktop back to the browser (a wrong "browser" verdict is what makes a web wallpaper answer 403). It drives four behaviours: ① whether a **web wallpaper payload** uses the dedicated media origin or the app origin — a plain browser has no fence, so no second loopback listener is opened, and that relative-path shape is asserted by its own guard; ② **desktop-shell material rules** (`data-dsh-desktop-mode` / `data-we-mica`) are gated on `[data-we-adapter^="desktop-"]`, so a browser session never inherits them; ③ **「窗口失焦时暂停」 is only offered on the browser target** (a desktop shell that lost focus usually still shows the wallpaper, and pausing would freeze a **visible** picture; the stored value survives and resumes when you switch back); ④ **panel rows appear per target with a stated reason**, and a manual pick that contradicts detection spells out the consequence (browser picked while a header is observed ⇒ 403).
- **Settings tabs reorganised**: the 「字体」 tab merged into 「**外观**」, 「玻璃」 was renamed to 「**雾化**」, and the adjustment controls were regrouped by purpose (appearance / effects / sound / advanced) — the six tabs stay 壁纸 / 外观 / 吉祥物 / 效果 / 声音 / 高级.
- **Font sets (a whole typography look as one preset)**: custom typography is now organised in **sets** — a preset ships with the plugin, and you can **create (from the current look) / rename / delete**; editing any font item lands **only in the current set**, and 「restore」 puts that set back the way it was (a set you edited is marked 「已改」 and "use" reads the whole set back). **Export / import** a `.json` (export opens the system **Save as** dialog; import validates the version tag first and names the reason for a bad file). The UI only says *which* set is in use — it never reveals whether a set shipped with the plugin.
- **「Only modified」 is on by default**: the typography-role table initially lists just the roles whose size / weight / family you changed (with an explicit line when nothing is modified yet), and the whole block is now part of "custom typography" — turning the master switch off collapses it.
- **Wallpaper-switch transitions (7 options)**: cross-fade / push / wipe / iris / zoom / strip / blinds; **hard cut by default**, shared by manual selection and automatic rotation; type / direction / speed tier are **whitelisted** (unknown values fall back to the default). 「条带」 (strip) became a real venetian blind this round — the previous implementation was visually indistinguishable from 「擦除」 (wipe).
- **The live-frame row** is no longer gated by the live-rendering switch (you can re-capture at any time) and shows a **thumbnail of the current wallpaper's live frame**.
- The transition options moved into a **dropdown**, and two redundant panel hints were removed.
- **「启动延迟」 renamed to 「启动最长等待时间」, and the value is now a cap**: the delay period still preloads (so the first frame warms up), the live picture is swapped in **the moment the first frame is ready**, and at the cap it is swapped in regardless; the options read `立即 / ≤3s / ≤5s / ≤10s`.

**Logging & notices**

- **The terminal reports problems only by default**: host output is folded into three levels (the level
  name *is* the logger method name) — `error` (breaks the plugin / DSH / system), `warn` (degradation,
  fallback, a fence rejection, a first-frame timeout — anything that **affects what you see**) and
  `info` (everything else: per-texture lines, heartbeats, the autosize gate, preparation probes, the
  log-side trace of a success). **Only `error` + `warn` are mirrored to the terminal**; `info` appears
  only with `DSH_WE_LOG_LEVEL=info` (values `error` / `warn` / `info`, default `warn`). Before this,
  every renderer report and heartbeat went straight to the terminal (measured at ~18 lines/minute).
- **Success notices moved to their own channel**: one terminal line, `[wallpaper-engine] … ✔` ("wallpaper
  media origin listening", "scene wallpaper ready") — the **same prefix as the log lines**, with the `✔`
  merely marking "this is a success, not a problem". **At most once per kind per session** (an HMR remount
  does not resend it); not through the logger, without a level, not written to disk. It only appears when
  stdout is a terminal — the DSH Desktop host is started by Electron over a pipe (`isTTY` is false), so
  Desktop is quiet by default; `DSH_WE_NOTICE=1` turns it on, `=0` silences it permanently, and only a
  **failed delivery** produces one `warn`.
- **Every reporting endpoint now declares its own level**: client `[we-live]` diagnostic lines carry
  `&lvl=` on the same-origin pixel request (an unknown or missing value falls back to `info`); the
  **renderer page** (the shipped WebWallGL artifact) used to feed its level to the browser console only
  and drop it from the request; as of the renderer 2.0.2 sync the page declares `&lvl=` itself (computed
  from the **same failure table the host uses**), and the host's `levelForReport` always takes the
  sender's declaration, falling back to that table only when it is missing. The local patch used in
  between was removed with 2.0.2. The rotation-prep
  first-frame timeout moved from a bare `console.info` onto the same channel and is tagged `warn`.
- **The diagnostics file has a cap**: `~/.dsh-wallpaper-engine/diag/http.jsonl` rotates to
  `http.jsonl.1` at 8 MiB (one generation only); `/diag-log` and the per-line JSON shape are unchanged.
- **Client-side exceptions are traced too**: a render-time exception in the panel used to show up only as
  a blank UI — and on that machine DevTools cannot be opened, so the diagnostics buffer held nothing.
  `error` and `unhandledrejection` now write the message plus the first three stack frames into the same
  diagnostics channel (tag `client-error`, level `error`); search for `client-error` first when triaging.
- Details and the gate commands are in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md), "Terminal output:
  problems only by default".

**Fixes**

- **A native confirmation dialog left the wallpaper paused for good** (no upstream issue; reproduced on
  the real machine): `window.confirm` hands focus to its own window, so with "pause on window blur"
  (`pauseOnBlur`) enabled the wallpaper stopped the moment the dialog appeared; the modal also **blocks
  the render thread** (an input box receives no keys), and the `focus` event on dismissal is **not
  guaranteed to arrive** ⇒ the occlusion decision stuck on "window blurred" and only a page reload
  recovered it. The decision is now also **re-checked on a low-frequency timer** (3 s, emitting and
  logging one `occlusion-recheck` line only when the decision changes), and deleting a font set moved to
  an **in-panel confirmation** (no native dialog).
- **Buttons and links are no longer different sizes**: the class shared by 「rename」 (`<button>`) and
  「export」 (`<a>`) used to pin only the `<button>` box — an `<a>` defaults to `inline` (an **inline box
  ignores `height`**), `content-box`, a non-inherited font, and an underline. The class now holds for
  both element kinds (`display` / `box-sizing` / `font` / `line-height` / `text-decoration` all spelled out).
- **Stutter when switching away during the boot wait**: the not-yet-mounted iframe is a **running renderer page**, not a plain element — nothing terminated it on a wallpaper switch, so it kept fetching the package / decoding textures / uploading in the background, on the same main thread as the new wallpaper's own startup. `applySelection` and unload now clear its timer and **abort** it (`src=about:blank`); the mount path also arms the heartbeat once (the `load` handler only arms it when mounted, and a delayed frame's document may finish loading before that — which would leave `we-live-on` off forever). Guard: `rotation-prepared-leak-smoke` cases Q1 / Q2 / Q3 (each with a failing control).
- **No more black screen when a scene wallpaper is activated for the first time**: on a wallpaper's **first** activation the live-captured frame does not exist yet (this live session has to backfill it), while the placeholder tried 「captured frame」 as its only source and **silently kept a near-black theme colour** on failure ⇒ a black screen until the first frame. The placeholder now takes **live-captured frame → the author's packaged preview image → the theme colour**: the preview is **only a stand-in** (never "guessing a picture on the author's behalf" — `/scene-frame`'s empty-state semantics are **unchanged**, not a byte on the host side) and is displaced the moment the live first frame lands; guard `rotation-prepared-leak-smoke` cases P / P2 (positive / negative controls paired).
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
- Packaging-whitelist regression assertions (`verify-package-files`), covering every runtime module under `lib/**`.
- **Three publish-face strengthenings (v1.1.0)**:
  - **`scripts/prepare.mjs` is now shipped**: `prepare` really does run when the plugin is installed from git, or when the packed artifact is executed as a *root project* (unpack, then `pnpm install`) — shipping the script without it means `MODULE_NOT_FOUND` the moment it runs (reproducible by unpacking the published package and running `pnpm install` in it). Follow-ups: `verify-package-publish` ⑦ no longer treats `prepare` as a repo-only script (its target must ship), and ② opens its dev-directory allowlist for exactly this one file — `src/` `scripts/` `test/` `docs/` are still rejected everywhere else.
  - **Every relative import target of the reachable closure must exist on disk** (new assertion + negative control in `verify-package-publish` ①): an import pointing at a file that is not there is a dead path locally — nobody trips over it until it is installed on a user's machine and blows up as `ERR_MODULE_NOT_FOUND`. The npm **1.0.1** artifact was exactly that (`./scene-script-apis.js`, imported by `lib/scene-scripts.js`, never shipped). The same rule now also runs as **P7** in `verify-package-files`: every runtime module under `lib/**` is scanned, not just the closure reachable from `lib/index.js`.
  - **Version `1.0.1 → 1.1.0`**: the published 1.0.1 cannot be overwritten and no longer matches this repository, so only a new version carries the current code to npm.

**Docs & repo housekeeping**

- Planning documents brought into the repo (`docs/`); the **static-frame rendering line is archived** under `docs/archive/static-frame/` — that line's renderer, like the beta scene-animation line's, now lives in the standalone repo [`YV3507/we-static-frame`](https://github.com/YV3507/we-static-frame) (offline scene → a single PNG, usable as a library or CLI) and **will be removed by other contributors in the next update**.

**Removals / behaviour changes**

- **The static-frame line is gone**: the offline scene renderer, main-texture extraction, the compositor and
  the "static frame" prewarming job were **deleted** (~10k lines). A scene wallpaper now has only two
  out-figure sources — **live frame** (captured from the running render, preferred) and **custom frame**
  (a screenshot you imported); with neither, it stays **honestly empty** instead of guessing an image (a
  guessed image is blurry and hides the decidable fact that this wallpaper has no usable picture).
  Also: `?v=1/2/3` tiers are retired (old values simply mean "auto" — **no migration needed**); the frame
  cache key was renamed/bumped (old caches expire; the only cost is re-capturing a few live frames); the
  panel row "wallpaper picture refresh" became "**out-figure source**" (two tiers).

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
- **Media on three platforms**: media-bridge integrated (macOS / Windows / Linux), middleware pinned at v0.1.5 (spectrum semantics corrected + capture follows the default output device); Now Playing artwork with a generic source. Online lyrics were added too: a local `.lrc` / cached copy comes first, and only a missing lyric triggers one lrclib.net query, which sends title / artist / album — hence off by default.
- **Web wallpaper fixes**: a dedicated wallpaper media origin serves the payload (fixes an all-black Desktop), a cross-origin duplicate shim injection that capped the frame rate twice, and the renderer page synced to webwallgl 1.4.2 (including both classes of web-wallpaper white-screen fix).
- **GPU frame capture backfill + geometry validation**: live frames backfilled into the static-frame cache, panel state / clear entry points, a strict gate for CPU rendering; a stored frame whose aspect ratio does not match the viewport is dropped and re-captured.
- **Video wallpapers got 0.7.5's "play on selection" back** (the preview poster and the prewarm probe chain are gone); official asset path (the WE assets directory, host half + client half).
- **Diagnostics workbench**: web-wallpaper "white screen" triage (headless real-browser screenshot + console errors); a render-path black box (client step reporting + host-side log dump).

### v0.7.5

> Upstream v0.7.5's content (`#91` font rework + frame-refresh tiers, `#99` video-wallpaper track volume, glass saturation no longer rising with blur `#98`, …) plus **all of this repository's 0.7.4 content** (see the next section).
> ⚠️ **WebWallGL live rendering (`#103`) and the `lib/webwallgl/` publishing allowlist are NOT in this version** — they came in with the catch-up merge (shipped later in `v1.1.0`); this release's pipeline prefix was `sf33_`.

### v0.7.4 (unpublished — its content shipped inside v0.7.5)

> The 0.7.3 name on npm was already taken by an earlier set of commits and cannot be overwritten, so the version was bumped; 0.7.4 = the 0.7.3 content + #88 (scene static-frame fix series) + the two entries below. **This version number was never published to npm** (`0.7.3 → 0.7.5`); its content shipped with v0.7.5.

- **Composer glass positioning fix** ([#89](https://github.com/elysia395/dsh-wallpaper-engine/issues/89), community PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)) — `[data-composer-card]` contains `position:fixed` descendants (`@dsh-external/dsh-webui` mounts the "AI browser" seat inside the card), and a `backdrop-filter` on the card becomes a **containing block** for those fixed descendants per spec — the seat stopped being viewport-anchored, gained hundreds of px of phantom overflow, and the composer was left stranded above the bottom of the scroll. The blur now lives on a `::before` pseudo-element (no DOM descendants → it can never become a containing block), keeping the same radius / `--we-*` tokens — visually identical.
- **Honest sceneVideo field** ([#92](https://github.com/elysia395/dsh-wallpaper-engine/issues/92), community PR [#94](https://github.com/elysia395/dsh-wallpaper-engine/pull/94)) — the inventory used to pass off "static frame available" as "embedded MP4", emitting a `sceneVideo` URL for nearly every Scene wallpaper, so the client's `/scene-video` request was a guaranteed 404. The real probe is now cached by "pkg path + mtime" (bounded LRU, background fill, opportunistic backfill from real requests; unknown stays `null` and is never guessed), and the URL is emitted only when an embedded MP4 is confirmed.

### v0.7.3

- **Custom uploads usable + honest playback state** ([#84](https://github.com/elysia395/dsh-wallpaper-engine/issues/84)):
  - ① `uploads/.meta.json` never recorded a `contentrating`, so uploads used to read as **unrated** while the rating filter defaults to **Everyone** — every custom upload was filtered out by default (absent from the grid, and rejected when the upload flow auto-applied it → blank wallpaper layer + a disabled 播放 button). An upload without a rating now counts as **Everyone**, so your own files work out of the box, while an explicit G / PG13 / R tag still filters normally.
  - ② A refused `video.play()` (autoplay policy, a codec the browser cannot decode such as HEVC/10-bit, or a play() interrupted by the next src swap) used to be swallowed silently: the panel kept saying 「播放中」 and the only control was 「暂停」 — a wallpaper frozen on its first frame with no way to resume. The control now reflects the `<video>` element's REAL state, so it returns to 「播放」 (a working retry) with a readable reason, e.g. "cannot decode this video — use H.264", and it re-issues play() automatically once the media becomes ready.
  - ③ A wallpaper dropped by a filter now says which filter excluded it instead of leaving an unexplained blank.
- **Wallpaper opacity** ([#82](https://github.com/elysia395/dsh-wallpaper-engine/issues/82)) — a new slider in the effects tab (0–90 %, higher = more transparent, default 0 %): fades the whole wallpaper layer toward the page base colour — the IDEA background-image style of "visible but not overpowering". Complements the scrim, keeping text readable.
- **Input caret color** ([#83](https://github.com/elysia395/dsh-wallpaper-engine/issues/83)) — a new **输入光标** section on the typography tab: when the caret is hard to see against the wallpaper, pick a high-contrast color from 6 presets or the custom picker (or **自动** to restore the native dsh caret — 自动 is the default). Applies to every text input and editable area, independent of the typography master switch.

### v0.7.2

- **Prerequisite bump**: targets DeepSeek Harness **0.1.5-rc.1** (DSH Desktop ≥ 2.0.7) and requires **dsh-better-sidebar ≥ 0.19.0**. Update order and rollback: see [`UPGRADING.md`](./UPGRADING.md).
- **Fixes the "right sidebar fully transparent" regression and extends the glass to the native right sidebar**: the harness 0.1.5 native sidebar panel paints `var(--dsw-alias-bg-base)` — the exact token this plugin sets to transparent while a wallpaper is active — and the native panel ships no frosted glass of its own, so after moving to better-sidebar 0.19 the whole right column went see-through. From v0.7.2 the native right sidebar is covered by the「侧栏液态玻璃」adaptation: the same **侧栏模糊 / 透明度 / 玻璃颜色** sliders drive it, and with the master switch off it falls back to the theme's opaque panel colour (no longer transparent). The group is: **侧栏液态玻璃** (master switch, on by default) · **侧栏模糊** (0–200 px, default 16) · **侧栏透明度** (0–200 %, default 120 %, higher = clearer) · **侧栏玻璃颜色** (6 presets + custom picker, default `#ffffff`).
- Follow-up fixes: sidebar colour controls and the content surface had no effect on the official native right sidebar; the sidebar colour mix strength is now a visibility curve independent of transparency.

### v0.7.1

- **Adapted to DeepSeek Harness 0.1.2-rc.1** and verified on **DSH Desktop v2.0.5**: host routes (inventory / media / scene-frame), the first-level settings section, the picker modal, video & scene wallpaper playback, the rope-dock drawer, and the liquid-glass effects all work in both Compatibility and Enhanced desktop modes. The APIs this plugin relies on (slots / webserver / theme variables) were verified unchanged on harness 0.1.5-rc.1 as well.
- **Fixes the rc.1 "swatches / vinyl record render as rounded rectangles" regression** ([#74](https://github.com/elysia395/dsh-wallpaper-engine/issues/74)): rc.1's theme layer ships a new `corner-shape.css` that applies `corner-shape: superellipse(1.5)` (squircle-ish corners) to **every element**, so any `border-radius:50%` circle renders as a rounded rectangle. The plugin now explicitly resets `corner-shape: round` on every circle / pill control it draws (swatches, vinyl record, slider thumbs, toggle knobs, font chips, …); on older harness builds the declaration is ignored, with no side effects.

### v0.6.8

- A stabilization batch for the scene rendering pipeline (solid-layer white boxes / JPEG fallback alpha / clearcolor / `#86` residue / resource-leak regression guards). The `files` allowlist regression that silently dropped a runtime module is now guarded permanently by `test/verify-package-files.mjs`.

### v0.6.7

- **Custom typography** — a new **字体** section in settings. The master switch defaults to off (stock dsh look); once enabled you can tune **font color / weight (100–900) / family** (default · YaHei · KaiTi · SimSun · SimHei · 行楷 Xingkai · monospace, each chip previewed in its own font). Error/danger/warning text keeps its system red; toggling the switch off restores defaults in one click.

### v0.6.4

- **Improved: occasional full-screen white flash in immersive windows** (keeps full frosted glass). Older builds could flash the **whole window white** when you clicked the dialog or typed in an **immersive fullscreen window** opened via a **desktop shortcut** (standalone / kiosk) — under **hardware acceleration**, Chromium's compositor occasionally paints the backdrop white while it re-composites over the wallpaper. **v0.6.4 keeps reducing the compositing layers**: the repo panel is lazy-mounted when closed, the rope has no permanent filter, and the wallpaper media no longer forces a transform compositing layer by default — whilst **keeping the full frosted glass**. Normal browser tabs are unaffected and keep the full frosted glass + hardware acceleration. The plugin shows a one-time notice (once per version) about this.

### Around v0.6.3

- **Mascot (chat pull-cord)** — a draggable cord that snaps along the top edge; pull it down to reveal the **wallpaper library** drawer, with two character forms (maid / orca) and a 0.5×–2.5× size control.
- **Wallpaper-effect tuning sliders** (v0.6.x) — the **壁纸效果** area gains three new sliders: **亮度 / 对比度 / 饱和度** (wallpaper media filter — **亮度 40–160 % / 对比度 40–200 % / 饱和度 0–200 %**, all defaulting to 100 %), alongside wallpaper blur / scrim etc., so any wallpaper can be blended comfortably with the UI. All apply instantly and persist.

### v0.6.0

- **Scene full-scene frames** — Scene wallpapers are fully replayed by a pure-JS scene renderer (object tree / textures / particles / shader effects) instead of a main-texture static frame. Implementation details: [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md).

### v0.5.x

- **Occlusion pause (battery-saving trio)** — like Wallpaper Engine's "pause when covered": pause the video wallpaper on minimize / tab-switch, on window focus loss, and/or on battery power, dropping the decoder engine to zero; it resumes automatically when you come back (web/iframe wallpapers are only throttled by the browser while hidden). Each toggle persists, and the trio is 「最小化/切页时暂停」 (on by default), 「窗口失焦时暂停」 (off by default) and 「使用电池时暂停」 (off by default); the scene live render pauses its render loop on the same conditions.
- **Decode frame-rate cap (frame-skip transcode)** — high-fps sources (e.g. 4K120 H.264) are the dominant GPU cost (~60% Video Decode at 1.0x on a 4060). The host re-encodes the wallpaper ONCE with ffmpeg to the capped fps (timeline stays 1.0x normal speed, fully decoupled from 倍速) as **4K-preserving AV1**, with a **live download/transcode progress bar**; measured 4K120→24fps drops GPU from ~60% to **~15%**. ffmpeg is provisioned in three tiers: explicit path → auto-download (npmmirror + GitHub dual-source race) → system PATH. The tiers are unlimited / 60 / 48 / 30 / 24 fps, and a source already at or below the cap is skipped; the cache key is "path + mtime + cap", so rotation pays once per wallpaper; transcoding prefers **NVENC** (`av1_nvenc` → `h264_nvenc`) and falls back to **libx264 software encoding** without an NVIDIA GPU; only a missing ffmpeg auto-disables it and leaves the wallpaper on the original.

### v0.4.1

- **Media-stream handle fix + async scan** — media/preview/scene-frame streams now release their file handles immediately when the client disconnects (fixes handles accumulating with every wallpaper switch/refresh, and Windows locking that prevented deleting/moving a wallpaper file). The wallpaper-library scan is fully async (fs.promises thread pool), so it no longer blocks the event loop (noticeably faster startup on WSL / big libraries).
- **WSL support** — Steam roots mounted under `/mnt/<drive>` are auto-detected, so a Harness running inside WSL can discover a Windows Wallpaper Engine install.

### v0.4.0

- **Settings persisted to a host file** — all settings (selected wallpaper, accent, transparency, layout, rotation, hidden, speed/flip, …) are now stored in `~/.dsh-wallpaper-engine/config.json` instead of browser localStorage, so they survive restarts, port changes (including DSH Desktop's random `--port 0` loopback port), browser-data clears and browser switches. Legacy localStorage config is migrated automatically on first launch.
- **Edge-compatible rendering** — Edge (and only Edge) paints its built-in "download / cast" media-overlay toolbar over any *visible* `<video>` element, and there is no official switch to disable it. On Edge, video wallpapers are therefore rendered onto a `<canvas>` by default to keep that toolbar away. A new「Edge 兼容」toggle (right-aligned on the 紧凑布局 row, on by default) turns this off and falls back to the native `<video>` in every browser.

### v0.3.1–v0.3.6

- **Liquid-glass settings page** (v0.3.1) — the settings UI is now a **first-level settings page** (following the dsh-web-ui-all skin-center design): the whole page is a customizable liquid-glass card with **accent color** (6 presets + a custom color picker, default classic blue `#4f8cff`) and **glass transparency** (0–60 %, default 12 %). Both apply instantly and persist.
- **Whole-settings-window liquid glass** (v0.3.2) — one click turns the **entire native DSH settings window** (dialog + left nav + ALL native sections: General / Models / Plugins / …) into liquid glass with your custom accent + transparency. Off restores the stock look.
- **Unified glass tuning** (v0.3.3–v0.3.5) — the settings-window glass blur shares the SAME adjustment as the conversation bar: the **玻璃** (glass) slider (0–60 px) drives the blur radius of both the settings window and the composer/bubbles, with an identical saturation/brightness/contrast recipe. A new **玻璃颜色** (glass color) control lets you tint the glass BASE itself (6 presets + custom picker; defaults white in light / deep navy in dark; once picked, both themes use that color) — **配色** styles the interactive elements, **玻璃颜色** styles the glass itself.
- **Card style & vinyl record** — the 紧凑布局 (compact CD-rack stacking) toggle and the spinning vinyl-record artwork label.

### v0.2

- **Modal wallpaper picker** — the thumbnail grid lives in a popup modal, so the settings page stays compact.
- **Hide / restore (soft delete)** — hide wallpapers you don't want, restore them anytime; no source files are touched.
- **Playback speed** — six native presets from 0.5x to 2x, instant, no media reload.
- **Horizontal flip** — mirror the image (video / web / uploaded images).
- **Custom uploads** — use your own local JPG / PNG / MP4 as a wallpaper, with a configurable storage location (default `~/.dsh-wallpaper-engine/uploads`, movable to any drive, existing files migrated) and fit modes (cover / contain / center / fill), plus automatic thumbnails for uploaded MP4s.
