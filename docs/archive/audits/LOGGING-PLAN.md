# 日志分级与提示通道（计划）

> **状态：已收口（G0 + P1–P5 全部交付），本文只作过程记录，不复述结论。**
> 它是开工前后的**决策与顺序**（含 G0 的两项前置实测），不是现行实现的说明。
>
> **权威来源**：机制与不变量在代码里 —— `lib/log.js`（三档 + 终端镜像 + `DSH_WE_LOG_LEVEL`）、
> `lib/notice.js`（成功提示通道 + `DSH_WE_NOTICE` 三态闸门）、`lib/routes/diag.js`（失败模式表与
> `/client-diag` 分流）的文件头；机器判据在 `test/verify-logging.mjs`（N1–N7 与 R1–R5，每条带可失败对照）。
>
> **落地时相对本文的三处偏差（均在代码旁写明，此处只作索引）**：
> ① 提示行按用户要求与日志行统一成 `[wallpaper-engine] <文案> ✔`（本文 §3.1 写的是 `✔ <文案>`）；
> ② 失败模式表的两处收紧 —— `失败` 后紧跟计数 `0` 不算、`ERR` 要词首（否则
> `bake: 后台补烘完成 0 张（失败 0，…）` 这类纯统计行会被误升级成问题，而"默认终端只报问题"会被它自己破坏）；
> ③ 本文 §1.1 把渲染页上报当作"只能靠文案猜"的前提**不成立**：上游其实已算好级别（只是当初没随请求发出），
> 于是先由本地补丁把它打到产物里（`test/tools/sync-webwallgl.mjs` 的 `applyDiagLevelPatch`；**该补丁已随上游实现
> 删除** —— 上游 `renderer/src/diag-level.ts` 自己声明，宿主照读）—— 渲染页**明文声明** `&lvl=`，
> 模式表退化为纯兜底（旧产物 / 其它写入者）。判据 N7 钉的是"产物自带级别 + 本地补丁零残留"。
>
> 本文只写**决策、顺序、验收判据、证据锚点**；机制与不变量写进对应文件头（见 §4）。
> 锚定口径同账本：**以符号名 / 目录名锚定，不写行号、不写编年史**。写作纪律见 [`../../README.md`](../../README.md) §写作纪律。

---

## 0. 目标与已定决策

**目标**：把 DSHWE 目前直接打到命令行终端的大量输出，收敛成一套**三档日志**加一条**独立的成功提示通道**，使默认终端只出现「问题」。

已定决策（不再讨论）：

| # | 决策 | 理由锚点 |
|---|---|---|
| D1 | 日志三档 = `error` / `warn` / `info`，**默认 `warn`**（`info` 不进终端） | `info` 是纯排障细节，不面向用户 |
| D2 | 分档判据：`error` = 会导致插件 / DSH / 系统出问题；`warn` = 降级 / 回退 / 围栏拒绝 / 首帧超时等**影响显示效果**的非正常表现；其余全部 `info` | §2.1 |
| D3 | **档位名就是 `ctx.logger` 的方法名**，不自建数值等级表、不新增设置项 | §1.4 的实测：自建阈值无法与平台语义对齐 |
| D4 | 另起**输出系统（提示通道）**，只发两条成功提示：`ensureMediaOrigin` 的「壁纸媒体源已监听」与客户端 `first-frame-ok`（「场景壁纸已就绪」）。**正常输出不产生日志**；**投递失败才算 `warn`** | §3 |
| D5 | 媒体子系统的两条成功行（中间件就绪 / 启动内置媒体实现）**降为 `info`**，不进提示通道 | 懒启动产物，不是启动期提示 |
| D6 | 本期只做 sink 甲（终端提示行）；GUI（`shell.overlay` slot）与 `commands` 查询通道**划出范围** | §1.6 |
| D7 | 非 TTY **静默且不报**（策略性不输出）；只有投递失败才 `warn` | §3.2 |

---

## 1. 现状（可核对的取证）

### 1.1 终端噪音只有一个单点源头

`lib/routes/diag.js` 的 `registerDiagRoutes(webServer, c)` 里，`/diag` 与 `${BASE}/diag` **共用 `handleDiag`**，它对每条 `msg` 既有 `appendDiagLine('renderer', …)` 落盘，也有一次 `console.log` 直打终端。

这条通道同时被两方使用：

- `lib/webwallgl/assets/renderer-*.js`（上游 vendored 产物）的 `diag:` 回调 → 渲染器自报（逐张贴图的 `tex` 行、`autosize gate`、`resources R=`、`particles live`、`bake` 等）；
- `src/live-layer.js` 的 `liveLog()` 像素请求 → 客户端事件（`play-state` / `beat` / `first-frame-ok` / 各种 bail）。

⇒ **把 `handleDiag` 的 `console.log` 改走 `log.info`，终端当场安静**；本条不依赖任何其它决策。

### 1.2 体量与速率（实测）

对 `~/.dsh-wallpaper-engine/diag/http.jsonl` 尾部 2 万条按 `kind` 统计：

| kind | 条数 | 说明 |
|---|---|---|
| `renderer` | 14,023 | 走 `/diag` 的两方合计 |
| `client` | 5,901 | 走 `/client-diag`（**本来就不打终端**） |
| `req` | 34 | 10 秒同键折叠后 |
| `media-origin` / `media-fallback` | 11 | — |

`renderer` 通道内部按消息签名归类：`play-state` + `beat` 心跳**占约 92%**，渲染器自报约占 8%。
按时间戳跨度换算，两路合计约 **18 行/分钟**（约 26k 行/天）。该文件**当前无上限、无轮转**，实际体量已到 **69.8 MB**。

### 1.3 宿主侧的打印点清单（改造对象的全集）

| 位置 | 符号 | 现行为 |
|---|---|---|
| `lib/routes/diag.js` | `handleDiag` | `console.log` 渲染器/客户端上报（§1.1 的单点） |
| `lib/routes/now-playing.js` | `registerNowPlayingRoutes` 注入的 `log` | `console.log('[wallpaper-engine][media] ' + m)` |
| `lib/index.js` | `ensureMediaOrigin` | 2 处 `console.log`（媒体源已监听 / 不可用） |
| `lib/index.js` | `handleSceneFiles` | 1 处 `console.log`（scene-files fenced） |
| `lib/routes/scene-serve.js` | 该族注册 | 1 处 `console.log`（scene-live fenced） |
| `lib/media/{index,legacy,provision,supervisor}.js` | 注入的 `log` 回调 | **17 个调用点**，全部无级别 |

`lib/media/*` 的 17 处已收敛到各自的 `log` 注入点，**加一个可选级别参数即可**，不需要逐处改打印方式。

### 1.4 `ctx.logger` 的等级语义（实测，D3 的依据）

对仓内 `@deepseek-ai/cordis` 逐档实跑，实际通过的消息集合是：

```
阈值 0 -> error
阈值 1 -> error + info
阈值 2 -> error + info + warn
阈值 3 -> error + info + warn + debug
```

源码口径：`LoggerLevel { ERROR = 0, INFO = 1, WARN = 2, DEBUG = 3 }`，判定式 `阈值 >= 消息级别`，阈值 = `exporter.levels[名字] ?? exporter.levels.default ?? logger.level ?? INFO`。

两条结论：

1. **各档是包含关系**（`error ⊂ +info ⊂ +warn ⊂ +debug`），不是 Python 那种「严重度 ≥ 阈值」。因此**「只显示 warn、不显示 info」在 `ctx.logger` 里表达不出来** —— 这正是 D3 放弃自建数值表的理由。
2. **`warn` 在没有自带 `levels` 的 exporter 上默认被丢掉**（阈值 1 < 2）。⇒ 插件里把「必须被看到的问题」打成 `.warn` 是陷阱；平台侧要不要抬天花板见 §5 的 G0 步骤。

`ctx.logger` 在 `dsh web` 下**有服务、无消费者**：`ctx.logger.exporter()` 是官方扩展点，但本 profile 未挂 console exporter（§1.5）。因此**档位切换只对「终端镜像」这一件事有意义**，我们不再依赖平台阈值做默认策略。

### 1.5 `dsh web` 没有挂 console exporter（实测）

- `@deepseek-ai/cordis-plugin-logger-console` 在 DSH 检出内只出现在 `session-telemetry-otel` 的**测试夹具**里，`dsh-base` / `dsh-web-app` 的 `cordis.patch.yml` 都没有 logger 行；
- ConsoleExporter 的输出形状恒为 `[I] <时间戳> <name> <msg>`（见其 `render()`），而 DSHWE 的终端输出里没有一条是这个形状；
- 终端里那些「看起来像日志」的行，全部可归因到**各插件自己的 `console.log`**：`dsh web: <url>` 与 `dsh web: opening the default browser…` 都来自 web-app 的裸 `console.log`。

**推论（也是 D4/D6 的依据）**：DSH 自己对「面向人的成功提示」的做法就是裸 `console.log` —— 不进 logger、不带级别、不落档。提示通道照此实现，是与平台**同构**，而不是另立一套 IO。

### 1.6 DSH 没有一等的提示设施（四张表都查过）

| 查了什么 | 结果 |
|---|---|
| host 服务目录（`agents` `approval` `commands` `connection` `inspector` `settings` `webServer` `timer` … 共 79 个 key） | **无 notice / notification / toast / output 服务** |
| host 事件目录（`agent/*` `session/*` `plugin-manager/*` `workflow/*` …） | **无面向用户的提示事件** |
| client 服务目录（`layout` `locale` `slots` `theme` `workspaces` …） | 同上 |
| client 事件目录（仅 `connection/reset` `locale/change` `slots/changed` `theme/change`） | 同上 |

能「用上 DSH 本身」的点只有三个，本期全部划出范围（D6）：

| 能力 | 判定 |
|---|---|
| `ctx.logger` / `ctx.logger.exporter()` | ❌ 语义就是日志；**只用于提示投递失败 → `log.warn`** |
| `ctx.commands.register()` | ⭕ 契约明确 *"execute a known command without sending it to the model"*，可做「按需查询」（如 `/we-status`）；但执行会向会话日志追加 `command/run` + `command/done`，且是「拉」不是「推」 |
| client slot `shell.overlay` | ⭕ 官方浮层座位（`kind: list`、`scope: root`、`replaceRisk: none`），是将来补 sink 乙的落点 |
| `webserver/index-inject` / `tapIndex` | ❌ 只在 index 渲染时注入，不适合运行时提示 |

---

## 2. 三档分级

### 2.1 判据

| 档 | 判据（一句话） | 终端默认 |
|---|---|---|
| `error` | 会导致**插件 / DSH / 系统**出问题：核心能力起不来、数据/进程被破坏、需要用户处理 | ✅ |
| `warn` | **影响显示效果**的非正常表现：降级、回退、围栏拒绝、首帧超时、重试、被拒绝的请求 | ✅ |
| `info` | 其余全部（诊断细节、逐帧统计、运行信息、成功事实的**日志侧**留痕） | ❌ |

### 2.2 归类表（逐条落到现有输出）

| 现有输出（符号 / 文案） | 档 |
|---|---|
| `ensureMediaOrigin` 的「壁纸媒体源不可用（网页壁纸回落应用源；Desktop 上会 403）」 | `error` |
| `lib/media/index.js` 的「回落到内置媒体实现」「内置媒体实现启动失败」 | `warn` |
| `lib/media/supervisor.js` 的「中间件报错」「中间件退出，N ms 后重启」「中间件启动失败」 | `warn` |
| `liveFail`（`src/live-layer.js`） | `warn` |
| `stall-rescue`（`src/live-layer.js`） | `warn` |
| 首帧超时 → 本会话改用 sceneVideo/静态帧（`src/media-prep.js` 的 `console.info`） | `warn` |
| `handleSceneFiles` 的「scene-files fenced」 | `warn` |
| `scene-serve` 族的「scene-live fenced」 | `warn` |
| 渲染器上报里的失败类（`失败` / `不可用` / `黑屏` / `fallback` / `ERR`） | `warn`（模式表升级） |
| **其余全部渲染器上报**（`tex` / `autosize gate` / `resources R=` / `particles live` / `bake` / `quality` / `mountScene` …） | `info`（**默认落档**） |
| `[we-live]` 的 `play-state` / `beat` / `tick` / `watch-start` / `build-live` / `prep-live-*` | `info` |
| `[we-live]` 的 `first-frame-ok` | `info` **日志侧** + 一条提示（§3.4） |
| `lib/media/provision.js` 的「下载系统媒体中间件」「系统媒体中间件就绪」 | `info`（D5） |
| `lib/media/legacy.js` 的「启动内置媒体实现（音频频谱 + Now Playing）」 | `info`（D5） |
| `lib/media/supervisor.js` 的「系统媒体中间件就绪：<provider>」 | `info`（D5） |
| `ensureMediaOrigin` 的「壁纸媒体源已监听 …」 | **不发日志** + 一条提示（§3.4） |

### 2.3 边界个案（开工时确认，不留模糊）

1. **「壁纸媒体源不可用」定 `error`**：它不是优雅降级，而是网页壁纸在 Desktop 上直接 403（核心能力不可用）。若认为它仍属「降级」，改判 `warn` 只动一行常量，不影响结构。
2. **无级别的渲染器上报默认落 `info`**：这是**有意**的 —— 未知消息宁可安静也不误报。代价是渲染器新增一种真正的失败文案时不会自动升级，须补进模式表。

---

## 3. 输出系统（提示通道 · sink 甲）

### 3.1 契约

- 落点：新文件 `lib/notice.js`（宿主侧，随包发布），API `notice(kind, text)`。
- `kind` 走**编译期白名单**；`text` 允许传函数（非输出场景不白构造字符串，与 `src/live-layer.js` 的 `detail` 惰性求值同一手法）。
- 输出：`process.stdout.write('✔ ' + text + '\n')` —— **不经 logger、不带级别、不落 `http.jsonl`、不进会话**。
- **`notice` 只用于成功事实**；异常一律走日志（D4）。任何「失败也要提示」的诉求都是把 `error`/`warn` 写进日志，而不是加第三种提示。

### 3.2 闸门三态（D7 的落地）

| 情形 | 行为 |
|---|---|
| `DSH_WE_NOTICE=0` | 静默，**不报**（用户主动关） |
| `process.stdout.isTTY !== true` 且未显式开启 | 静默，**不报**（策略性不输出） |
| `DSH_WE_NOTICE=1` | 强制输出（非 TTY 的显式 opt-in） |
| 写入抛错 / 回调 err / EPIPE | **`log.warn('notice', …)`** —— 唯一日志出口 |

`DSH_WE_NOTICE=1` 这一档是必需的：`pnpm dsh web` 若在转发时把 stdout 变成管道，`isTTY` 为假会让通道**静默死掉且不报**——正是 D7 最危险的失败模式。⇒ §5 的 G0 含一次 `isTTY` 实测。

### 3.3 幂等与预算

- `noticeSeen: Set<kind>`，随 `apply(ctx)` 重建 ⇒ **每 kind 每会话至多一条**，HMR 重挂不重发。
- 直接后果：`first-frame-ok` 只在本次会话**第一张**壁纸上成为提示，后续轮换静默 —— 符合「极其少量」。
- 「极其少量」必须有机器判据，否则会退化成第二份日志：见 §7 的 N2/N3。

### 3.4 两条提示的来源与通道

| kind | 触发点（符号） | 通道 |
|---|---|---|
| 媒体源 | `ensureMediaOrigin` 监听成功后 | host 直接 `notice()` |
| 场景就绪 | `src/live-layer.js` 的 `first-frame-ok` | 客户端经**既有** `/client-diag` POST 上行（body 已有 `event`/`type` 字段），宿主按 `type` 分流到提示通道而**不是**日志通道 |

第二条**不新增路由、不改客户端协议**。注意 `registerDiagRoutes` 的 `/client-diag` 有三条早退（非 POST 405 / 超 64 KB 413 / 早退不落盘）被 `test/verify-scene-live.mjs` 的 Level E 以真实请求钉住 ⇒ 分流分支不得动这三条。

---

## 4. 不变量（写进文件头，不写在这里）

以下各条**随实现写进对应文件头**，本计划不复制（规则 3：能写在代码旁的规则不单写文档）：

1. `lib/log.js`：三档与 `ctx.logger` 方法名一一对应；**不自建数值等级表**；终端只镜像 `error` / `warn` 两档；`info` 永远不面向用户。
2. `lib/log.js` 与 `lib/notice.js`：**仅这两个宿主模块允许直接调用 `console.*` / `process.stdout`**。其余 `lib/**` 一律经它们。
3. `lib/notice.js`：成功不产生日志；只有投递失败产生 `warn`；非 TTY 是策略性静默，**不是**投递失败。
4. `lib/routes/diag.js`：`handleDiag` 的落盘（`appendDiagLine`）、内存环形缓冲与 `/diag-log` 契约不变；只在打印处改走分档。
5. `lib/routes/diag.js`：无级别的渲染器上报**默认 `info`**（未知消息宁可安静不误报）。

---

## 5. 实施顺序与每步验收

每一步都**独立可验收**，且都在跑通 `npm run verify` 之后才进入下一步。

### G0 · 前置实测（不开工，先拿两个事实）

| # | 做 | 看什么 |
|---|---|---|
| G1 | 在 `pnpm dsh web` 下打印一次 `process.stdout.isTTY` | 决定 §3.2 的闸门是否可用；为假则依赖 `DSH_WE_NOTICE=1` |
| G2 | 在 Desktop 的运行日志里打一条 `.info` 与一条 `.warn` | 决定是否需要在 `inject` 里抬 `logger.level` 到 2（§1.4 结论 2）。**若 `.warn` 本来就能落地，就不动 `inject`** |

**实测结果（两条都按"读源码 + 读现场档案"取证，未改任何代码）：**

- **G1 = 假**：DSH Desktop 的宿主由 Electron 以 `utilityProcess.fork(..., { stdio: "pipe" })`
  fork（`dsh-plugin-desktop` 的 `startIsolatedDesktopHost`）⇒ 宿主进程里的
  `process.stdout.isTTY` 为假。⇒ §3.2 的闸门**照原样实现**，桌面端默认安静，
  `DSH_WE_NOTICE=1` 是显式 opt-in（写在 `lib/notice.js` 的文件头与 `TROUBLESHOOTING.md`）。
- **G2 = `.warn` 本来就能落地**：同一宿主把 `FileExporter` 挂在 `ctx.logger` 上，它自带
  `levels = { default: 3 }`（⇒ 平台侧阈值判定对 `warn` 放行）且自身 threshold 为 `info`；
  现场档案里也确实有 `[W]` 行（`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.error.log`）。
  ⇒ **不动 `inject`**，`lib/types/index.d.ts` 的 `inject: string[]` 无需同步。

### P1 · 日志模块 + 收口单点（**终端噪音归零**）

- 新增 `lib/log.js`（三档 API + 终端镜像 + `DSH_WE_LOG_LEVEL` 三值，默认 `warn`）；
- `handleDiag` 的打印改走 `log.info`（模式表升级项见 §2.2）；
- `package.json` 的 `files` 加 `lib/log.js`。
- 验收：启动到壁纸出图，终端只出现 `error` / `warn`；`/diag-log` 与 `http.jsonl` 内容不变。

### P2 · 宿主调用点分级

- `lib/index.js` 的 `ensureMediaOrigin`（2 处）、`handleSceneFiles`（1 处）；
- `lib/routes/scene-serve.js`（1 处）；
- `lib/routes/now-playing.js` 的注入 `log` → `log(msg, level)`；
- `lib/media/{index,legacy,provision,supervisor}.js` 的 **17 个调用点**按 §2.2 标注级别。
- 验收：§2.2 表逐行对得上；`info` 档内容在开 `DSH_WE_LOG_LEVEL=info` 时完整出现。

### P3 · 客户端分级 + 重建产物

- `src/live-layer.js`：`liveLog(tag, detail, level)`；URL 加 `&lvl=`；按 §2.2 逐条标档；
- `src/media-prep.js` 的裸 `console.info` 并入 `liveLog`（`warn`）；
- `pnpm run build` 并**同提交**带上 `lib/client.js`。
- 验收：`test/verify-client-sync.mjs` 的逐字节比对绿；宿主对未知 / 缺失的 `lvl` 落 `info`。

### P4 · 输出系统（甲）

- 新增 `lib/notice.js`；`ensureMediaOrigin` 与 `/client-diag` 分流各接一条；
- `files` 加 `lib/notice.js`。
- 验收：见 §9。

### P5 · 诊断文件收敛 + 文档

- `http.jsonl` 加**大小轮转**（本次实测 69.8 MB / 约 18 行/分钟为上限依据）；`/diag-log` 契约不变；
- 文档：`docs/TROUBLESHOOTING.md` 加「终端默认只报问题 → 开 `DSH_WE_LOG_LEVEL=info` 看细节」，`docs/CHANGELOG.md` 记本次变更。
- 验收：轮转后 `/diag-log` 仍返回最近 80 条。

---

## 6. 守卫耦合清单（**开工前必须知道的代价**）

| 守卫 | 为什么会被牵连 | 处理 |
|---|---|---|
| `test/verify-package-files.mjs` P1 | 新文件必须被 `package.json` 的 `files` 覆盖 | P1/P4 各加一行 |
| **`test/verify-ledger.mjs` §2 基线表：`lib/**` 文件数取等号** | 加 `lib/log.js` + `lib/notice.js` ⇒ `lib/**` 文件数 **22 → 24**（行数只设上界，需同步抬高） | 账本 §2 那一行必须与代码**同提交**修改 |
| 同上：**守卫计数 == verify 链条数** | 若新增 `test/verify-logging.mjs`（§7）⇒ `27 → 28` | 同上 |
| `test/verify-types.mjs` | 若 G2 判定要抬 `logger.level` ⇒ `inject` 由数组改为对象形式，`lib/types/index.d.ts` 的 `inject: string[]` 必须同步 | 仅在 G2 需要时做 |
| `test/verify-client-sync.mjs` + CI | `src/**` 改动必须重建产物并同提交 | P3 内完成 |
| `test/verify-reachability.mjs` | `lib/log.js` / `lib/notice.js` 必须真的从 `lib/index.js` 可达 | 由 P1/P4 的接线保证 |
| `test/verify-comment-discipline.mjs`（棘轮域） | 注释禁日期、禁「曾经 / 旧实现」框定 | §4 的不变量按此口径写 |
| 同上：**`CEIL` 覆盖表必须覆盖全部 `test/**/*.mjs`** | 新增 `test/verify-logging.mjs` ⇒ 必须在 `CEIL` 里以 `0` 起钉，否则该守卫直接判红 | §7 的守卫落地时同提交 |
| 同上：棘轮域 = `src/**/*.js` + `lib/routes/*.js` + `test/**/*.mjs` + `scripts/**/*.mjs` | **`lib/log.js` / `lib/notice.js` 不在域内**（它们是 `lib/` 根模块，不是 `lib/routes/*`），无需登记 | 无操作 |
| `docs/ROUTE-INDEX.md` + `lib/types/index.d.ts` 的条数散文 | **本次不改路由**（提示经既有 `/client-diag` 上行）⇒ 31 条不变 | 无操作，但不得新增路由 |
| `test/verify-scene-live.mjs` Level E | `/client-diag` 的三条早退被真实请求钉住 | P4 的分流分支不得动它们 |

> 结论：**本次改动的真实成本主要在 §6，而不在写 logger。** 尤其 `verify-ledger` 的「文件数取等号」是一条容易被忽略的红线。

---

## 7. 建议新增的守卫（`test/verify-logging.mjs`，入 verify 链）

每条规则都配**可失败对照**（本仓守卫的既有形态）。

| # | 断言 | 判据 |
|---|---|---|
| N1 | `lib/**` 里除 `lib/log.js` / `lib/notice.js` 外**零 `console.*`** | 剥注释后扫描；这把「单一收口」变成机器事实 |
| N2 | `notice(` 的调用点 ⊆ 白名单，且总数 ≤ 常量上限（当前 2） | 防「极其少量」退化成第二份日志 |
| N3 | 每个 `kind` 在源码里**只出现一次** | 会话内幂等由运行时 `Set` 保证，源码级不重复由本条保证 |
| N4 | `lib/notice.js` 的成功路径不调用任何日志函数（只有失败路径调用 `warn`） | 落实 D4 |
| N5 | 热路径（`src/live-layer.js` 的 tick 段、`lib/routes/scene-serve.js` 的请求段）内零 `notice(` | 提示只许出现在里程碑位置 |
| N6 | 宿主与客户端对**三个档位名**的集合相同 | 两侧字面量各自存在（见下），本条防漂 |

**为什么不给三个档位名做共享内核**（`lib/settings-schema.js` 那种形态）：共享内核会触发 `test/verify-module-layout.mjs` ③ 的白名单变更与 `scripts/build-client.mjs` 的 `INLINE_MODULES` 登记，成本高于收益。理由是**两侧不一致是安全的**：宿主对未知 / 缺失的 `lvl` 一律落 `info`（§4 不变量 5），所以客户端多一个档位名最多让那批消息变安静，不会出错。代价是三处字符串字面量，由 N6 兜住。

> 未挂判据的约定明写「无守卫」：`info` 档的**内容归类**（哪条算细节）无法机械判定，只由 §2.2 表 + 评审保证。

---

## 8. 风险与未决项

| # | 风险 / 未决 | 处置 |
|---|---|---|
| R1 | `pnpm` 转发 stdout 使 `isTTY` 为假 ⇒ 提示通道静默失效**且不报** | G1 实测；`DSH_WE_NOTICE=1` 作为显式退路 |
| R2 | Desktop 运行日志可能吞掉 `.warn`（§1.4 结论 2） | G2 实测；需要时抬 `inject` 的 `logger.level` |
| R3 | 默认安静之后，「壁纸黑屏」在终端**完全无声** | 文件通道（`http.jsonl`）与 `/diag-log` 不动；`docs/TROUBLESHOOTING.md` 明写开闸命令 |
| R4 | `notice` 顺序是「媒体源 → 场景就绪」；若媒体源先失败（`error`），不会再有第二条提示 | 属预期：`error` 已在终端可见，不需要提示补位 |
| R5 | §2.3 的两个边界个案 | 开工时逐条确认，只动常量不动结构 |

---

## 9. 收口判据（全部机器可验）

1. `npm run verify` 全绿（含 §6 要求的账本与 `files` 同步）。
2. 冷启动到出图，终端除 `error` / `warn` 外**只出现最多两条 `✔` 提示**；连续两次启动、以及 HMR 重挂后，提示**不重复**。
3. `DSH_WE_LOG_LEVEL=info` 时，§2.2 中标 `info` 的全部内容在终端可见；不设时不可见。
4. `DSH_WE_NOTICE=0` 与非 TTY 两种情形下无提示、**且无 `warn`**；人为制造写失败（关闭 stdout）时恰好出现一条 `notice` 的 `warn`。
5. `/diag-log` 与 `http.jsonl` 的内容语义不变（新增轮转除外）。
6. `test/verify-logging.mjs` 的 N1–N5 各带可失败对照并在 CI 链条内。

完成后：本文整体移入 `docs/archive/`，并把 §4 的不变量留在代码里。
