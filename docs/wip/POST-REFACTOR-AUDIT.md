# 重构收官后的审计：待修项、判据缺口与残留（**审计记录**）

> **本文不是进度真源。** 它是 2026-09-29 重构主动部分结项之后的一次**只读审计**的过程记录 ——
> 每条只写：现象 / 证据 / 影响 / 修法方向 / 判据缺口。**本文不设状态列、不设进度标记** ——
> 落地情况一律记进 [`OPEN-ITEMS.md`](./OPEN-ITEMS.md) §5（唯一进度真源）；条目全部收口后，
> 按 [`docs/README.md`](../README.md) §目录的寿命规则整体移入 `docs/archive/`。
>
> **审计时的基线**：HEAD `1ff0887` · `npm run verify` 与 `npm run smoke` **全绿**（exit 0）·
> 账本自检 **46 已落地 / 1 未完成** · 可达性 **0 文件 / 0 行** · 重建后 `git status` 干净 ·
> npm 上 `latest` 仍是 `1.0.1`。⇒ **下面每一条都是现有 32 条守卫全部放过的。**
>
> ⚠️ **正文里的 `文件:行号` 锚点都属 1ff0887 那一版**，之后被动过的文件（尤其 `lib/index.js`、
> `src/client.js`）行号已漂。要按行号复算请先 `git checkout 1ff0887`，否则请**按内容**定位。
>
> **收录范围（有意为之一刀）**：本文**只收工程债** —— 正确性缺陷、数据损坏 / 丢失、资源泄漏、
> 注释与文档失真、判据缺口、死码残留、覆盖盲区。**与安全相关的那一类不进本文**（越界读取、
> 缺失的来源校验、以及任何对宿主内部机制的分析）；那一部分已整体移出本仓库，见 §11。
>
> **方法**：只读 + 复跑仓库自带工具（`analyze-host-apply` / `host-route-index` / `verify-reachability` /
> `audit-import-closure`）+ 若干**本机未跟踪**的一次性探针（`.test-cache/`，清单与命令见 §9）。
> 审计本身**没有改动任何文件**。

## 0. 一句话结论

**结构收口是真的，"判据面"和"文档面"各漏了一批**：宿主有**三条路由没有请求体上限**、一处无界状态、
一处中断泄漏与一处并发删兄弟产物；客户端启动链可能被一次未保护的 `localStorage` 读整体 reject；
而文档侧最重的一条是**三份 README 把「默认关」的开关说成"没有开关、行为即自动"**。
更深层的原因集中在 §7：**守卫只核"个数"不核"行数/分支数"**、**同一数字的多份副本只钉一份**、
**散文里的现状断言无人看守**。

---

## 1. 修复优先级（建议顺序，不是进度列）

| 组 | 内容 | 为什么排这里 |
|---|---|---|
| **P0-a** | §5.1 用户可见文档失真 | 收益最大、零风险：用户按 README 找不到开关 |
| **P0-b** | §3.1 启动链 reject · §3.2 音乐开关高亮反了 | 用户直接撞得到，改动都很小 |
| **P1-a** | §2.1 请求体无上限 + §2.2 UTF-8 损坏 + §2.4 中断泄漏（同一根因） | 没有上限 ⇒ 异常大的请求体把宿主堆无界撑大 / 静默写坏用户数据 / 磁盘垃圾累积 |
| **P1-b** | §2.3 无界 `reqLogSeen` · §2.5 转码删兄弟产物 · §2.6 meta 丢更新 | 宿主加固；各配一条能钉住它的守卫 |
| **P1-c** | §6.1 删 `pkg-extract` 死半边 + vendored `jpeg-js` | 本轮重构**唯一**明确没删干净的结构残留 |
| **P2-a** | §4 注释时效性 · §5.2 账本数字 | 一次性对齐；并把行数类指标改成**工具现算** |
| **P2-b** | §6.5 悬空锚点守卫 · §4.9 BOM 判据覆盖面 | 守卫自身的洞，分钟级 |

> 纪律照旧：一次提交只切一刀 · `verify:all` 未绿不得提交 · **修复必须配一条能钉住它的守卫**。

---

## 2. Bug —— 宿主半


### 2.1 三条路由的请求体**没有大小上限**

**证据**：[`lib/index.js`](../../lib/index.js#L3388)（`/we-assets-dir`）、
[`lib/routes/upload.js`](../../lib/routes/upload.js#L220)（`/remove`）、
[`lib/routes/upload.js`](../../lib/routes/upload.js#L256)（`/upload-dir`）都是
`req.on('data', (c) => { body += c; })`，**全文没有任何 `body.length` 比较**；`/upload-dir` 另缺
`armBodyIdleTimeout`。同族其它收 body 的路由全都有闸：`/settings` 64KB、`/fontsets` 256KB、
`/client-diag` 64KB、`/live-frame` 4MB、`/custom-frame` 30MB、`/scene-frame-cache` 32MB、
`/upload` 直接落盘（512MB）。

**实测**（本机探针 `audit-body-caps.mjs`，驱动真实处理器）：

```text
/remove  (cap?)                status after 8MB = 0 | responded = false
/upload-dir (cap?)             status after 8MB = 0 | responded = false
/we-assets-dir (cap?)          status after 8MB = 0 | responded = false
/settings (control: 64KB cap)  status after 8MB = 413 | responded = true
```

**影响**：异常大的请求体会让宿主堆无界增长 → OOM / 进程死亡。默认只听 loopback，但 DSH webserver
配置允许 `host: 0.0.0.0`，且这三条是 POST。

**修法方向**：把三条换成与同族一致的 `readBody(req, res, { max })`（见 §6.2）；至少要补
`MAX_BODY_BYTES` + `lingerClose`。

**判据缺口**：没有任何守卫要求"收 body 的路由必须有上限"；同族已有的闸全靠人记得抄。

### 2.2 同一批路由用 `body += chunk` 拼 Buffer ⇒ **多字节 UTF-8 静默损坏**

**证据**：`chunk` 是 `Buffer`，逐块 `toString()` 解码 ⇒ 落在两个 TCP 分片之间的码点变成 U+FFFD。
同一探针实测：`PUT /settings` 发送 `{"id":"壁"}` 并在 3 字节字符内部切分 ⇒

```text
utf8 split → sent id "壁" (bytes 12) → persisted id = "���" | status 200
```

**影响**：用户可见字符串（壁纸 id / 字体名 / 字体族）会被无声写坏，客户端永远不知道写失败。
（`/live-frame`、`/scene-frame-cache`、`/client-diag` 先 `Buffer.concat` 再解码，是正确的。）

**修法方向**：`req.setEncoding('utf8')`（StringDecoder 会处理边界），或收 Buffer 后一次性解码。

**判据缺口**：无。这类"编码正确性"没有任何断言。

### 2.3 `reqLogSeen` 是无上限、无回收的每-URL 映射 ⇒ 会话期内存单向增长

**证据**：[`lib/index.js:1997`](../../lib/index.js#L1997) 声明；全文对它的操作**只有 `get` / `set`**
（`:2012` / `:2014`），**没有任何 `delete`**、没有容量上限、没有清扫。键里带请求可控的路径：
`lib/index.js:3007`（`/scene-files` 子路径）、`:3247`（`/live-frame` token）、
[`lib/routes/scene-serve.js:54`](../../lib/routes/scene-serve.js#L54)（`/scene-live` pathname）。
10s TTL 只抑制**写入**，不清理条目。

**实测**（本机探针 `audit-reqlog-growth.mjs`）：20 万个互不相同的 `/live-frame/<random>` 请求把
`heapUsed` 从 32.2MB 抬到 **72.4MB**（~200 B/条）且不释放。

**修法方向**：给一个上界（照 `SCENE_VIDEO_PROBE_MAX` 的写法）或按去重窗口定期清扫。

### 2.4 `POST /custom-frame` 中途放弃 ⇒ 泄漏写流 + 永久孤儿 `.tmp`

**证据**：[`lib/routes/scene-frame.js:287`](../../lib/routes/scene-frame.js#L287) 的 `cleanupTmp` 只能从
`ws.on('close')`（且 `failed` 为真）到达，而 `failed` 只由 `fail()`（413 / 408 / ws error）设置 ——
**没有 `req.once('close', …)`**。对照组 [`lib/routes/upload.js:107`](../../lib/routes/upload.js#L107)
把同一场景处理得明明白白，且文件头写了这条不变量。
`sweepTranscodeArtifacts`（`lib/index.js:1165`）只扫 transcode / ffmpeg / video-preview 三个目录，
`customFrameDir()` **从不被清扫**，`dispose()` 也不扫。

**实测**（本机探针 `audit-custom-frame-abort.mjs`，真实处理器 + HOME 重定向）：

```text
A: response sent      = false
A: overrides listing  = ["auditprobe.png.tmp"]
after dispose         = ["auditprobe.png.tmp","auditprobe2.png.tmp"]
```

**影响**：用户关掉弹窗 / 离开页面就留下一个未关闭的 fd（直到 GC）+ 一个最多 30MB 的 `.tmp`；
`customFramePath` / `listCustomFrameIds` 只匹配 `.png|.jpg|.webp`，所以它是**看不见的垃圾**，只会累积。

**修法方向**：补 `req.once('close', …)` → destroy `ws` + `cleanupTmp()`（照 `upload.js`）；或在
`customFrameDir()` 里清扫 `*.tmp`。

### 2.5 转码取消可能删掉**兄弟任务**正在写的临时文件

**证据**：[`lib/index.js:1563`](../../lib/index.js#L1563-L1582)：`cancel()` 立刻
`TRANSCODE_INFLIGHT.delete(cachePath)`，而临时名是确定性的 `cachePath + '.tmp' + process.pid`，
并发闸放行 2 个（`TRANSCODE_MAX_CONCURRENT`）⇒ 同一 `abs|mtime|fps` 的新任务在同一路径重写，
旧任务的 `catch` 再 `unlinkSync(tmp)` 就把新任务的产物删了。

**影响**：POSIX 上新任务 `renameSync` ENOENT → `/transcoded` 502、客户端静默回退原片；
Windows 上 unlink 失败被吞 ⇒ 反而无害。触发场景："切走再切回同一张壁纸"（或两个客户端）。
**机制由代码确证，精确交错未在本机复现。**

**修法方向**：临时名带上 job / attempt id —— `atomicTmpPath`（`lib/index.js:611`）已经是这个模式。

### 2.6 `uploads/.meta.json` 读-改-写未串行化 ⇒ 丢更新，并**破坏内容去重**

**证据**：[`lib/index.js:2126`](../../lib/index.js#L2126)（`setUploadMeta`）与
[`:2135`](../../lib/index.js#L2135)（`removeUploadMeta`）读整份 → 改 → 原子写，但**不走**
`enqueueConfigWrite`（`lib/index.js:648`）；调用点来自上传完成回调与 `/remove`，可以交错。

**影响**：丢掉的若是 `sha256`，按内容去重（`upload.js:139`）再也匹配不上 ⇒ 同一文件被反复堆成副本。

---

## 3. Bug —— 浏览器半

### 3.1 启动链可能被一次未保护的 `localStorage` 读**整体 reject** ⇒ 选择器永久卡在「扫描 Wallpaper Engine…」

**证据**：[`src/persistence.js:167`](../../src/persistence.js#L167) 的迁移分支在 try 之外裸读
`localStorage.getItem(SETTINGS_KEY)`；同文件 `readPersisted()`（`:40-48`）是保护的，而且 `:164-166`
的注释**正好写着这个坑曾经修过一次**（"a corrupted localStorage payload used to reject
loadPersisted(), which broke the loadPersisted().then(loadInventory) boot chain and left the picker
stuck…"）。启动链 [`src/client.js:4147`](../../src/client.js#L4147)
`loadPersisted().then(loadFontSet).then(loadInventory)` **没有终止 `.catch`**。

**实测**（本机探针 `probe-boot-chain.mjs`，宿主回 200 且无已存设置、`localStorage.getItem` 抛
SecurityError）：

```text
boot chain REJECTED at loadPersisted: SecurityError: The operation is insecure.
loadInventory reached? false
selection.hostLoaded = undefined
```

**影响**：与注释里描述的旧故障**同一形态**（inventory 永不加载、选择器永久卡住、一次性提示不收敛）。
触发条件：站点数据被禁 / 不透明源嵌入 —— 正是 `readPersisted()` 存在的理由。

**修法方向**：迁移那一次改走 `readPersisted()`；并给启动链补一个终止 `.catch`。

**判据缺口**：没有任何冒烟覆盖"存储被拒"这条腿（挂载台的 localStorage 替身不会抛）。

### 3.2 音乐开关的高亮判定是**反的**（用户可见）

**证据**：[`src/panel-tabs.js:106`](../../src/panel-tabs.js#L106)

```js
className: "we-picker__btn" + (weAudioVolume() > 0 || sel.videoAudioEnabled === false ? "" : " is-on"),
```

化简即"**只有开关开着且音量为 0** 时才 `is-on`"。而 [`src/styles.js:939`](../../src/styles.js#L939)
写明该类的语义：「音乐开关处于「开」时用 accent 色描边」。出厂默认是
`videoVolume: 0` + `videoAudioEnabled: true`（[`lib/settings-schema.js:234`](../../lib/settings-schema.js#L234-L236)）
⇒ 壁纸是哑的、按钮却是亮的；用户一开声音，高亮反而消失。旁边 `:113` 的文案（`🔊 音乐开` /
`🔇 音乐关`）又只看 `videoAudioEnabled` ⇒ **文案与高亮自相矛盾**。

**修法方向**：`sel.videoAudioEnabled !== false && weAudioVolume() > 0`。

### 3.3 模块作用域监听与定时器没有拆除路径 ⇒ 禁用 / HMR 后**每 60 秒继续打宿主**

**证据**：[`src/live-layer.js:211`](../../src/live-layer.js#L211-L233) 顶层注册 `focus` / `blur`
（`:212-213`）、`visibilitychange`（`:216`）与 **60s `setInterval` 心跳**（`:225-231`，回调里
`liveLog("beat", …)` 会发 `new Image().src = "/diag?…"`）。唯一的拆除入口
[`stopLiveWatch()`](../../src/live-layer.js#L501) 只清 `liveWatch.timer`。
[`ensureLivePointer`](../../src/live-layer.js#L782-L804) 再叠 4 个 window 监听（`:783` / `:787` /
`:791` / `:797`），全仓**没有一处 `removeEventListener`**。

**影响**：禁用插件 / HMR 之后页面每 60 秒继续请求宿主（无休止），每次重挂再叠监听，每个闭包都被钉住。
这与 [`src/persistence.js:107`](../../src/persistence.js#L107) 声明的纪律和
`src/client.js:3935-3951` 的实现相矛盾。

**修法方向**：把心跳 / 这几个监听收进由 `apply` 的 `ctx.effect` 拥有的"只注册一次 + 可拆除"结构。

### 3.4 留存帧字节在卸载路径不释放

**证据**：`liveFrameBytes`（≤ `FRAME_BYTES_MAX` = 8 条，每条一个整张 PNG 的 object URL + 已解码
`Image`，[`src/live-layer.js:829`](../../src/live-layer.js#L829)）只在换 token（`:708`）、
选择变更（`:1127`）与 LRU 淘汰（`:850`）时释放；卸载 / dispose 路径（`src/client.js:3974-4040`）
**不调 `releaseFrameBytes`**。

**影响**：有界（≤8 个 blob + 解码位图），但禁用 / HMR 后会一直留到刷新。

### 3.5 代码块**标题条**钩子被覆盖，而上游那条是刻意的字面量

**证据**：`src/font/components.js:69` 的 `dslHooks` 含 `--dsl-code-block-banner-font`。上游
`@deepseek-ai/dsh-client-ui-primitives/lib/markdown/CodeBlock.module.css:7-10`：

```css
/* Local 11/18 instead of the shared --dsw-font-xs-13: the banner scales
   with the markdown 0.875 ladder without shrinking every other xs-13 use. */
--dsl-code-block-banner-font: 11px/18px var(--dsw-font-family);
--dsl-code-block-content-font: var(--dsw-font-markdown-code-block);
```

即 **banner 是字面量、content 才指回角色令牌**；模块自己的门（`:250-256`）只查 `meta.role` 与令牌可用性，
**从不查钩子原值是否指回角色**。

**影响**：面板里调"代码块"字号会把标题条一起改（行高 18→19、并注入字重），丢掉上游刻意的本地值。

**修法方向**：只对"原值指回角色令牌"的钩子生效，或把 `--dsl-code-block-banner-font` 移出 `dslHooks`。

### 3.6 低优先两处

- [`src/media-prep.js:588`](../../src/media-prep.js#L588)：处在 `if (sel.type === "video")` 内，条件里的
  `sel.type !== "video"` **恒假** ⇒ 整条语句是死的（注释还在解释"为什么不该设 poster"）。
- [`src/transcode.js:174`](../../src/transcode.js#L174)：同文件 `:62-64` 特意为 `AbortController` 缺失
  兜底并注释了原因，这里却裸 `new AbortController()` ⇒ 在那个自认支持的环境里会从 `syncLayers` 抛出去。

---

## 4. 注释时效性（都是"注释与紧邻代码互相矛盾"）

| # | 位置 | 注释说 | 代码是 |
|---|---|---|---|
| 4.1 | [`src/client.js:709`](../../src/client.js#L709) | 「默认 **5 分钟**」 | `DEFAULTS.rotationInterval = **30**`（[`lib/settings-schema.js:60`](../../lib/settings-schema.js#L60)） |
| 4.2 | [`src/live-layer.js:68`](../../src/live-layer.js#L68)（**用户可见文案**）+ `:240` | 「运行中断（**20 秒**无帧）」 | 20s 只是单次 `resume()` 自救；`liveFail("stall")` 在 `LIVE_STALL_TICKS * 2` = **40s**（`:242` / `:487` / `:497`） |
| 4.3 | [`src/theme-follow.js:27`](../../src/theme-follow.js#L27-L28) | 「阈值取中灰 `#808080`（≈**0.2159**）」 | `:52` 是 `**0.40**`，且 `:48-51` 明确写"这里**不取**中灰" ⇒ 同文件头尾打架（守卫断言的是 0.4） |
| 4.4 | [`src/effects.js:28`](../../src/effects.js#L28) | 「**只读** selection、不写它」 | `clearEffects()` 写 5 个字段（`:318-327`） |
| 4.5 | [`src/client.js:179`](../../src/client.js#L179) + [`src/fontset-editor.js:13`](../../src/fontset-editor.js#L13) | 契约里有 `fontSetNewName` / `newName` | 两者**都不存在**（store 字面量 `:180-185` 无此键、`fontSetCtx()` 从不下发）；只有 `verify-fontset.mjs:1011/1013` 还在喂它 ⇒ **死夹具管线** |
| 4.6 | [`lib/index.js:2765`](../../lib/index.js#L2765) | 「`/media-info` 必须注册在 `/media` 之前，否则被前缀吞掉」 | 宿主匹配是**分段锚定 + 最长前缀胜出**（`dsh-host-webserver` 的 `match()`）⇒ 注册顺序不承重（`/scene-frame` ↔ `/scene-frame-cache` 同理） |
| 4.7 | [`lib/index.js:1711`](../../lib/index.js#L1711) | 「**预热写盘**与 `/scene-frame` 必须走同一构造点」 | 预热写盘**已随 P2-12 删除**（`lib/` 里零命中）；同目录现在有三个生产者（GPU 抓帧 / `sv1_` / `sa1_`） |
| 4.8 | [`lib/types/index.d.ts:48`](../../lib/types/index.d.ts#L48) | 「用户静态帧是否**替换了提取帧**」 | 提取线已删（`lib/routes/scene-frame.js:50-54` 自述）；该字段实义是"存在用户导入的自定义画面"（`hasCustomFrame`，`lib/index.js:2488`） |
| 4.9 | [`lib/routes/fontsets.js`](../../lib/routes/fontsets.js) | —— | **文件带 UTF-8 BOM**（`git hash-object` == `HEAD:lib/routes/fontsets.js` ⇒ 确实入库）。Node ESM 会剥 BOM，**今天不炸**；但 BOM 判据 [`test/verify-comment-discipline.mjs:390`](../../test/verify-comment-discipline.mjs#L390) 的覆盖面是**硬编码 5 个文件**，`lib/routes/**` 天生在盲区 |

---

## 5. 文档时效性

### 5.1 用户可见（**最该先修**）

| # | 位置 | 文档说 | 实测 |
|---|---|---|---|
| 5.1.1 | [`README.md:177`](../../README.md#L177) | 「主题随壁纸 …**无开关，行为即自动** \| 自动」（另见 `:150`） | **有开关且默认关**：[`lib/settings-schema.js:243`](../../lib/settings-schema.js#L243) `themeFollow: false`、`:360-361` 写明"默认关"、UI 在 [`src/panel-tabs.js:523`](../../src/panel-tabs.js#L523)（tooltip：「关（默认）时这个功能整体不生效」）。仓库自己的 [`docs/CHANGELOG.md:26`](../CHANGELOG.md#L26) 写得是对的 ⇒ README 是 v1.1.0 之前的 |
| 5.1.2 | [`README.en.md:186`](../../README.en.md#L186) | 「**No switch — the behaviour is the feature** \| automatic」 | 同上 |
| 5.1.3 | [`README.beginner.md:141`](../../README.beginner.md#L141) / `:312` | 以"界面怎么自己变浅色了"作答，不提开关与默认关 | 同上 —— 新手文档里这句最误导 |
| 5.1.4 | [`docs/HOW-IT-WORKS.md:168`](../HOW-IT-WORKS.md#L168) / `:363` | 「（`src/theme-follow.js`，**没有开关**）」 | 同上（这条最重：它把"没有开关"写成了设计事实） |
| 5.1.5 | [`docs/HOW-IT-WORKS.md:163`](../HOW-IT-WORKS.md#L163) | 「`src/**` 里**还剩 4 处** `window.confirm`…`verify-fontset` 里有条棘轮**只许它们减少**」 | 代码命中 **0**（4 处全是注释）；棘轮是**终态 `== 0`**（`verify-fontset.mjs:1416`、`verify-client.mjs:1334`）⇒ **两句都错** |
| 5.1.6 | [`docs/HOW-IT-WORKS.md:93`](../HOW-IT-WORKS.md#L93) / `:310` | 「**共 31 条**路由」 | [`docs/ROUTE-INDEX.md:13`](../ROUTE-INDEX.md#L13) = **32**；同页 `:99` 还声明"权威清单见 ROUTE-INDEX"，`:115` 刚讲完 `fontsets` 族（恰是漏掉的那条）。**这类漂移在账本里被修过一次并加了守卫**（`verify-ledger.mjs:855` 的注释记着），只是没扩到这份文档。**已修**：31 → 32 |
| 5.1.7 | [`docs/HOW-IT-WORKS.md:201`](../HOW-IT-WORKS.md#L201) / `:394`、[`docs/UPGRADING.md:59`](../UPGRADING.md#L59)、[`docs/TEST-LAYOUT.md:10`](../TEST-LAYOUT.md#L10) | 「**24 条链**」/「**五套**冒烟」/「**31 条链** = 31 个 `verify-*`」 | **32** 条 verify、**6** 套 smoke（`package.json:78` / `:81`；漏了 `fontset-load-smoke`）。账本的同一数字**有守卫**（`verify-ledger` 的"守卫计数 == verify 链条数"），这三份没有 |
| 5.1.8 | [`CONTRIBUTING.md:31`](../../CONTRIBUTING.md#L31) / `:40` | 「`lib/client.js` = 正文 + `INLINE_MODULES` 里那 **14 个**模块」 | **21**（`docs/MODULE-LAYOUT.md`、账本都对）⇒ 教"产物到底是什么"的那份文档错了三分之一 |
| 5.1.9 | [`docs/HOW-IT-WORKS.md:121`](../HOW-IT-WORKS.md#L121)、[`docs/FONT-SYSTEM.md:56`](../FONT-SYSTEM.md#L56) | 「决策见**账本 §9.5**」 | 活账本**没有 §9.5**（已归档到 `docs/archive/REFACTOR-ASSESSMENT.md`；账本 `:224-228` 与 FONT-SYSTEM 自己的头部 `:10-12` 都这么说） |
| 5.1.10 | [`docs/CHANGELOG.md:31`](../CHANGELOG.md#L31) | 「换壁纸过场动画（**7 种可选**）：…条带 / **百叶窗**」 | `SWITCH_TRANSITIONS` 是 7 条**含默认的硬切**；`bars` 只有一项、标签就是「条带」，"百叶窗"是它的描述 ⇒ 同一项数了两次（README 是对的） |
| 5.1.11 | [`docs/CHANGELOG.md:7`](../CHANGELOG.md#L7) / `:18` | 「未发布 = 与上游 `origin/main` 的差异 —— **（无）**」 | `git rev-list --count origin/main..HEAD` = **2**（含 `6d557b8` 那条真实修复）；同一句还给了"v1.1.0 之后"第二种定义，**两种定义互相矛盾**。**已修**：该节现在列的是实际条目 |
| 5.1.12 | [`docs/TEST-LAYOUT.md:11`](../TEST-LAYOUT.md#L11) | 冒烟层覆盖「轮换、实时帧回填、身份校验」 | 第 6 套 `fontset-load-smoke` 不在任何一句里（未声明条数，属摘要缺口） |

### 5.2 账本自身的数字（`docs/wip/OPEN-ITEMS.md`）

| # | 位置 | 账本写 | 实测 |
|---|---|---|---|
| 5.2.1 | §2 `:57` | 32 个 `verify-*`（**16770 行**）+ 6 smoke（**3616 行**） | **16879** / **3856**（口径与同表 `lib/client.js` 的 14187 一致） |
| 5.2.2 | §2 `:58` | vendored 12 文件 / **6950 行** | 12 ✓ / **7045** |
| 5.2.3 | §3.1 `:75` | `apply(ctx)` **1,203 行**，分支代理 **219**；巨石 137/65/49/42 | 工具打印 **1259 行 / 232**；巨石 138/66/49/**45** |
| 5.2.4 | §3.1 `:74` | `WallpaperPicker` **722 行** | **816**（`src/client.js:2457-3272`；同表 P3-11 用的就是含首尾行口径：1033 = 3428−2396+1 自洽） |
| 5.2.5 | §7-7 `:203` | 「**22 个**共享可变闭包状态」 | `analyze-host-apply` 打印「闭包状态 **30 个**」 |
| 5.2.6 | §7-6 `:200` | 「下一个满足它的是 `now-playing`（**2 条，未达线**）」 | `now-playing` **早已拆成** [`lib/routes/now-playing.js`](../../lib/routes/now-playing.js)（4 条注册，`ROUTE-INDEX` 第 16–19 行）⇒ 这句"现状断言"已过期 |
| 5.2.7 | §3.3 `:94` vs §7-1 `:194` | 同一指标：「平均每次提交动约 **7.5** 个文件」/「现在均值 **7.09**」 | 复算：**7.04**（423 提交）/ **7.45**（400 非 merge）⇒ 同文档两个数，且都不等于任一实测口径 |
| 5.2.8 | §0 `:17-18` | 「§2 规模数字…仍由 `verify-ledger` 机器核对」 | 这句话**高估了覆盖**：守卫只核**文件数**（相等）与少数行数的**上界**，5.2.1–5.2.4 全都越过了自己声明的上界却全绿 |

### 5.3 行数类数字的漂移（P2-a 的对象）

**另**：后续那次改动给 `lib/index.js` / `src/client.js` 加了行 ⇒ §5.2.1（verify / smoke 行数）与
§5.2.3（`apply` 行数 / 分支代理）写的数字**又**偏小了一截。
这两行正是 P2-a「改成工具现算」的对象；在那之前，**不要**把它们当成可引用的现状。
同理 [`docs/TEST-LAYOUT.md:10`](../TEST-LAYOUT.md#L10) 的「31 条链 = 31 个 `verify-*`」（实际 **32**）
是**既存**漂移，属 §5.1.7 那一组。
账本 §2 里**被守卫看着**的两行（`src/client.js` 行数、`lib/**` 文件数/行数）已同步到实测值。

---

## 6. 残留的重构价值（都有判据，不是感觉）

### 6.1 `lib/pkg-extract.js` 的纹理 / JPEG 半边已成死码，却把 vendored `jpeg-js` 一起拖着发布

**证据**（导出面与调用图实测）：

- `decodeTex`（`lib/pkg-extract.js:406`）**仍被** [`lib/scene-manifest.js`](../../lib/scene-manifest.js#L30)
  使用 ⇒ **这条是活的**（不是死码，别误删）。
- `decodeTexToRgba`（`:633`）与 `extractTexVideoMp4`（`:524`）**零调用者**。
- vendored `jpeg-js` 的静态 import（`:45`）只被 `decodeTexToRgba`（`:637` 的 `decodeJpeg`）使用
  ⇒ SCENE 音频 / 视频每次 `await import('./pkg-extract.js')` 都在为一个**死函数**加载整份 vendored 解码器。
- **它为什么活到今天**：[`test/verify-ledger.mjs:362`](../../test/verify-ledger.mjs#L362) 的
  "活依赖存活"断言检查的正是字符串 `function extractTexVideoMp4(` —— **一条守卫把一个没有调用者的
  函数钉成了"活依赖"**。而 `verify-reachability` 明确排除 `lib/vendor/**`（`test/verify-reachability.mjs:44`），
  所以可达性棘轮也看不见它。

**可删**：约 600 行 + `lib/vendor/jpeg-js/`（7 文件 / ~2200 行 / ~100KB，随 `files` 发布）。
**顺带**：两个 `await import('./pkg-extract.js')` 可改指 `./pkg-read.js`（`parsePkg` / `readPkgEntry`
本来就是从那里 re-export 的），并改掉 `verify-ledger` 那条断言。

### 6.2 八条路由各写一份"收 body / 落盘"管道 —— 这是 §2.1 / §2.2 / §2.4 的**共同成因**

三种形态各有多份副本：字符串收集 + 上限（settings `lib/index.js:3596`、fontsets `:217`，另有 2.1 里
那三条**没有上限**的）；分片数组 + 字节上限（live-frame `:3266`、scene-frame-cache
`scene-frame.js:175`、client-diag `diag.js:71`）；流式落盘（`upload.js:83`、`custom-frame`
`scene-frame.js:271` —— **只有前者处理了客户端中断**）。
**修法方向**：收敛成一个 `readBody(req,res,{max})` + 一个 `streamBodyToFile(...)`
（注意 `verify-module-layout` 有 `lib/**` 共享内核白名单要同步）。

### 6.3 `src/panel-tabs.js` 的页签渲染器违背自己的模块头契约

模块头 `:16` 写「页签**不得**写 selection / 不得 emit」，而 `:77`（`emit()`）、`:228`
（`editing.name = …; emit()`，`editing` 就是 `selection.editing`）、`:266-269`（splice 列表）、
`:285`（`setTransient`）、`:75`（模块级 `propsPanelOpen`）都在写 store / emit。
同一刀拆出来的 `picker-modal.js` / `picker-props-panel.js` 全都经 ctx ⇒ **这是真接缝缺口，不是风格**。

### 6.4 `sceneFrameSlot` 的三条路径与 variant 参数已无生产 / 消费方

`lib/index.js:1737-1739` 返回 `pngPath` / `jpgPath` / `gifPath`（只有 `gpuPath` 有人在用），
`:1732` 拼 `_v<variant>` 而所有活调用点都传 0；`v=4` 路径（`scene-frame.js:76`）算完 slot 直接丢弃，
却仍为此做一次 `statSync` + `ensureCacheDir`。`:1724` 的注释已经写明"唯一产物是 `<key>_gpu.png`"。

### 6.5 守卫牙齿：悬空锚点让 P1-6 的切片退化成全文件

[`test/verify-scene.mjs:705`](../../test/verify-scene.mjs#L705)：
`hostSrc.slice(indexOf('function sceneFrameSlot('), indexOf('function sceneFrameSlotFile('))` ——
**`sceneFrameSlotFile` 全仓不存在**（唯一命中就是这一行）⇒ `indexOf` 返回 −1 ⇒ `slice(start, -1)`
扫的是 `lib/index.js` 余下 ~1900 行，今天只是因常量恰好声明在 1726 之前才绿。
同源判据 [`test/verify-ledger.mjs:203`](../../test/verify-ledger.mjs#L203) 的锚法是对的
（`indexOf('\n}', at)`）。这是 P3-16 那类"判据空转"的新实例。

### 6.6 明确**不需要**做的（免得下次又讨论一遍）

`P2-11` 的触发线**确实没过**：`node test/tools/analyze-host-apply.mjs` 显示 `lib/index.js` 内 14 条注册、
按路径首段归组**最大组 1 < 3**。继续拆族只会加间接层 —— 这个判断站得住；
唯一毛病是 §7-6 旁边那句有关 `now-playing` 的描述已过期（§5.2.6）。

`docs/wip/OPEN-ITEMS.md` §7.1 登记的两条行为缺口仍然有效，且**不驱动结构改动**：
①帧请求"挂住"时旧层留在屏上（要不要给有界兜底待定夺）；②裸 `iframe.we-iframe`（web 旧链）不在切层
闸门的信号表内（账本自己写明"这一档可以覆盖"）。

---

## 7. 判据缺口 —— 这类问题为什么没被拦住

1. **只核"个数"，不核"行数 / 分支数"**：§2 的 verify / smoke 行数、§3.1 的行数与分支代理、
   §3.3/§7-1 的均值，全都在机器可见范围之外。
2. **同一数字的多份副本只钉一份**：内联模块数（MODULE-LAYOUT 钉了，CONTRIBUTING 没钉）、
   verify 链条数（账本钉了，TEST-LAYOUT / HOW-IT-WORKS / UPGRADING 没钉）、
   路由数（索引 + 类型 + 账本钉了，HOW-IT-WORKS 没钉）。
   ⇒ 方向：数字**从单一真源派生**，而不是每处手抄。
3. **散文里的现状断言无人看守**：`⬜/🟡` 标记有守卫（`verify-ledger` 的"§0/§5 之外零进度标记"），
   但"还剩 4 处 X"、"下一个是 Y"、"没有开关"这类句子没有 —— 在 `wip/` 里尤其危险。
4. **覆盖面硬编码**：BOM 判据 5 个文件（§4.9）、`verify-scene` 的切片锚点（§6.5）、
   并发的 body 上限"靠抄"（§2.1），都是"名单 / 锚点漂了却没人发现"的同一形状。
   本仓已有的正确姿势是**从磁盘枚举**（P3-8）与**正负对照喂同一条判据**（TEST-LAYOUT 约定 5）。
5. **"活依赖"断言可以反向钉住死码**：§6.1 —— 断言一个函数名存在，于是没人敢删那个函数。
   ⇒ 方向：存活断言要断言**调用边**（谁 import 谁），不是字符串。
6. **没有任何判据看着"发布包被真实安装"这条路径**（2026-09 由用户回执暴露，见 §8 末条）：
   CI 只跑 `dsh plugin add link:<ROOT>`（`test/compat-harness-live.mjs:173`），
   而 `verify-package-publish` 只核**发布面**（`files` / 可达闭包 / `dependencies`），
   **从不用安装器装一遍 `npm pack` 出来的产物** ⇒ 插件的 `peerDependencies` 是否真能在**安装闭包**里
   解析出来，全仓**零断言**。**症状**：`Packages: +1`（只装了插件自己）→
   `generation … already exists, reusing` → `generation peer validation failed:
   @deepseek-ai/dsh-client-runtime does not resolve from the installation closure`。
   **修法方向**（两条都还没做）：① 在 compat 层补一步"装 tarball 而不是 `link:`"的断言
   （需真 `dsh` + 网络，属 CI 专属层，与本仓"不进 verify 链"的既有划法一致）；
   ② 把 `peerDependencies` 里"宿主提供的包"改成不会失败的声明形态（见 §8 的 peer 口径错位那一条）。
7. **失败行不肯说子进程说了什么**（media-bridge 的引导段）：`lib/media/supervisor.js` 的启动失败路径
   只报 `中间件启动失败：<插件自己的错>`，把 `lastStderr` 与"进程是否还活着"**丢掉了** ⇒ CI 上
   只剩一句 `hello 超时` 时，无法区分「起来了但不吭声」与「起来了、报了错」这两种完全不同的故障。
   **已补**：失败行与 `media-boot-failed` diag 现在带 `budgetMs` / `alive` / `stderr`；
   引导预算同时改成**可覆盖**（`DSH_WE_MEDIA_BOOT_MS`，现场默认仍 25s）—— 实测同一个产物
   （`media-bridge-win32-x64.exe` v0.1.5，`--provider mock`）在 windows-latest 上 25s 拿不到 `hello`，
   在本机 <25s 就绪。**同族教训**：测试的等待预算写死成 `200×150ms = 30s`，只比引导预算多 5s
   ⇒ 两个数字必须从同一个源派生，否则放宽任何一个、另一个就会抢在前头判失败。

---

## 8. 覆盖盲区

- **CI 只有 `windows-latest`**（`verify.yml:35`、`harness-compat.yml:35` 都是）⇒ verify 自己打印的
  「来自 posix 分支的 5 条（500 unlink-failed / 帧仍在盘上 / 重试可用 …）在 win32 上没有任何覆盖」
  是**真的零覆盖**：POSIX 专属分支目前没有任何地方跑。
- **`lib/vendor/**` 在可达性扫描面之外**（`verify-reachability.mjs:44` 的 EXCLUDE）⇒ §6.1 那类
  "vendored 副本其实已经没人用"的问题结构性地看不见。
- **"存储被拒"这条腿零覆盖**（§3.1）：挂载台的 `localStorage` 替身不会抛异常。
- **"从 registry 装发布包"这条路径零覆盖**（§7-6）：`verify` 链不装包，compat CI 只走 `link:`。
  同一条路径上还摊着一处**口径错位**：`peerDependencies` 里的
  `@deepseek-ai/dsh-client-runtime: ">=0.1.0-rc.6"` 是**按那个包自己的版本线**写的，而 DSH 的插件准入
  是拿 **`@deepseek-ai/dsh`（harness）的版本**去比**每一条** `@deepseek-ai/dsh` /
  `@deepseek-ai/dsh-*` 范围 —— DSH 自己的插件作者文档原话：

  > Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and
  > `@deepseek-ai/dsh-*` against **the single runtime version** returned by `getDshRuntimeVersion()`.
  > Every declared range must match; **prereleases participate in range matching**.
  > **Missing DSH peers impose no constraint**; invalid ranges are incompatible.

  ⇒ 两套版本线（harness `0.1.5-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` ↔ client 包 `0.1.0-rc.8`）
  被同一张范围表同时约束，而**这条准入闸的开/关不看 `engines.dsh`**。附带两条实测：
  ① 该闸以 `includePrerelease: true` 比较（所以 `>=0.1.0-rc.6` **能**匹配 `0.2.0-rc.1`，
  这一条**不是**本次故障的原因）；② 该闸把**空字符串范围**也判为不兼容 ⇒ `""` 不是"不约束"的写法，
  真要"不约束"只能**不声明**（文档原话：missing ⇒ no constraint）。
  **本刀处置**：把这三个宿主提供的 `@deepseek-ai/dsh-*` peer 标成
  `peerDependenciesMeta.*.optional = true`（`@deepseek-ai/cordis` 与 `react` 保持必填）。
  依据：这三个包由**宿主**提供、本仓代码里**零 import**（客户端运行时靠 `dsh.client.inject`
  声明接线），而市场的 peer 模型是「**optional 解析不到只是 warning，必填才是确认的不兼容**」
  （`dsh-market` 的 `check.js:1021` 与 `compatibility.js:17`），市场自己也这么标它的 DSH peer。
  ⚠️ **这不等于修好了"解析不到"**：它只把「阻止安装」降级为「警告」，让包真正到位是宿主那侧的事。
  **同时记一条宿主侧缺陷（本机可复现）**：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-runtime`
  是指向 `…\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\…` 的 **junction，
  而该目标根本不存在**（整层 `app.asar.unpacked` 缺失）；`~/.dsh/profiles/web/node_modules/@deepseek-ai`
  则是**空目录**。⇒ 凡是必须从 profile 闭包解析 `@deepseek-ai/*` 的路径，在这种 host 上都会失败。
- **"本机证明不了、只能看 CI"这句话本身就把排查方向挡在门外**（§7-6 / §7-7 的同族）：
  media-bridge 那条 E2E 被打上"本机证明不了（下载被挡 / 沙箱里 spawn 是 EPERM）⇒ 别再试图在本机复现"，
  而实测**下载那一半是错的** —— `lib/media/provision.js` 用 `fetch` 下得下来，还校验 sha256 + 体积下限；
  只有"**受限沙箱**里带管道的 spawn 是 EPERM"成立。把那道边界放开后，`verify:bridge` 在本机
  **30 通过 / 0 失败**。⇒ 本仓凡写「只有 CI 能给出这条覆盖」的地方，都要先自己验一遍：
  它是不是**沙箱**的限制被误写成了**机器**的限制。

---

## 9. 复现命令与证据锚点

**仓库自带、可直接复算的**：

```powershell
npm run verify ; npm run smoke                       # 审计时两者全绿（exit 0）
node test/tools/analyze-host-apply.mjs               # §5.2.3 / §5.2.5 / §6.6 的数字来源
node test/tools/host-route-index.mjs                 # §5.1.6 的 32 条
node test/verify-reachability.mjs                    # 「lib 扫描面」= §5.2.1/§5.2.2 的口径
git rev-list --count origin/main..HEAD               # §5.1.11 => 2（1ff0887 时）
git log --name-only --format=C:%h                    # §5.2.7 的均值复算
```

**本机未跟踪的一次性探针**（住在 `.test-cache/`，**不入库**；要入库得先按
[`docs/TEST-LAYOUT.md`](../TEST-LAYOUT.md) 的规则收编进 `test/tools/` 并进注释棘轮表）：

| 探针 | 支撑的条目 |
|---|---|
| `audit-body-caps.mjs` | §2.1（8MB 无上限）+ §2.2（UTF-8 静默损坏） |
| `audit-reqlog-growth.mjs` | §2.3（20 万请求 → +40MB 不释放） |
| `audit-custom-frame-abort.mjs` | §2.4（孤儿 `.tmp` 在 dispose 后仍在） |
| `probe-boot-chain.mjs` | §3.1（启动链 reject、inventory 未达） |
| `probe-live-layer-scope.mjs` / `probe-pointer.mjs` | §3.3（模块作用域监听 / 定时器无拆除） |
| `probe-music-toggle.mjs` | §3.2（`is-on` 三种状态组合） |
| `probe-dsl-blocks.mjs` | §3.5（banner 钩子被改写） |
| `measure-wp.mjs` / `pkg-extract-usage.mjs` / `mean-files.mjs` | §5.2.4 / §6.1 / §5.2.7 |

---

## 10. 与其它文档的关系

- **进度与状态**：唯一真源是 [`OPEN-ITEMS.md`](./OPEN-ITEMS.md) §5；本文**不重复也不替代**它。
- **本文落地后**：按 [`docs/README.md`](../README.md) §目录的寿命规则整体移入 `docs/archive/`
  （它是"某一轮审计的过程记录"，不是常青规范）。
- **写作纪律**：本文遵守 [`docs/README.md`](../README.md) §写作纪律 —— 不写编年史、
  「实测」标出处、能写在代码旁的规则不在这里复述。

---

## 11. 安全类条目的去向（**不在此复述**）

原稿里与安全相关的那一部分（越界读取、缺失的来源校验、以及任何对宿主内部机制的分析）
**已整体移出本仓库**，本文不复述、也不保留指向它的锚点。这里只记**过程性**的落点：

- 与它们相关的一次代码改动**已经落地**：`/scene-files` 的目录围栏补了第二层、场景载荷改走宿主
  自建的独立 loopback 媒体源。用户可见的结论记在 [`docs/CHANGELOG.md`](../CHANGELOG.md) 的
  「未发布」一节；两处的判据在 [`test/verify-scene-live.mjs`](../../test/verify-scene-live.mjs)。
- **明确未动**的一条**同类加固残留**：[`lib/scene-manifest.js`](../../lib/scene-manifest.js) 的
  `dirSceneAccess` 与上面那处属同一类，本次**没有连带改** —— 它属另一条路由族
  （`/scene-video` / `/scene-audio`），应在**它自己的那一刀**里处理。
  记账在此，免得"围栏已补"被读成"这类问题都没了"。（技术细节随移出的那一部分走，不在本文。）

