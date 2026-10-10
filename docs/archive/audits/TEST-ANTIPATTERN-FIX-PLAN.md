# 现在还有什么问题 / 遗留与风险

> 本文只记**尚未解决、仍有风险、需要人决定**的事：不记过程，也不重复逐条改法。
> 106 条发现的逐条现状（每条现在守什么、牙齿如何、`file:line` 证据）见 `docs/archive/audits/TEST-ANTIPATTERN-AUDIT.md`。
> 本文出现的 `file:line` 都在最终工作树上现场核对过。

## 0. 现状一句话

- 审计覆盖的 `test/` 全量（72 个 `.mjs` + 2 份夹具）共 **106 条**发现（95 条本体 + 11 条来自其余 6 个文件）**已全部定案并实施**：
  **R（重写）47 · H（加固）33 · D（删除）19 · 不改（裁决）/声明 5（L3、F4、F5、L52、M32）· 取消（未找到）2（L53、L55）**；待议（P）为 **0**。
- 守卫全绿（在最终工作树上重跑实测）：`npm run verify` exit 0（44 个守卫）· `npm run verify:docs` exit 0（末尾 `ALL GUARD MAP CHECKS PASSED`）· `npm run smoke` exit 0。
- 改动面：`test/`（含 `test/fixtures/settings-sanitize-golden.json`）+ 两个生成物 `docs/GUARD-MAP.md`、`docs/ROUTE-INDEX.md`
  + 文档 `docs/README.md`、`docs/en/README.md`（登记这两份审计文档）、`docs/DEV-GUIDE.md`（§4.5 / §4.7 判定与写作约定）、
  `docs/CHANGELOG.md`、`docs/en/CHANGELOG.md`（v1.3.1 段各一条）；`src/`、`lib/`、`scripts/`、`package.json` **零改动**。
- 本地 CI（即 `.github/workflows/verify.yml` 的步骤序列）在最终工作树上实跑过一遍，逐步实测：
  `platform=0` · `build=0` · `verify=0` · **`verify:bridge=1`** · `smoke=0` · `verify:docs=0` ·
  `git diff --exit-code -- lib/client.js`=0（`npm run build` 幂等，跑完 `lib/client.js` 仍与 HEAD 逐字节一致）·
  `git diff --check`=0。**唯一非 0 的 `verify:bridge`（`node test/verify-media-bridge.mjs --provision`）是本机环境限制**，见 §1.2。
- **未提交**：HEAD 仍是 `1d38c09`；`git status --short` 58 项（56 个已改 + 本文件与 `TEST-ANTIPATTERN-AUDIT.md` 两份未跟踪）。
  唯一被"改动"触及的产品侧文件是 `lib/client.js`，但只是 `npm run build` 重写后的 stat 缓存陈旧：其内容与 HEAD **逐字节一致**
  （`git hash-object --no-filters` == `HEAD:lib/client.js` == `05870c0d4d56ba3819f43ccdbcaea1cf8b2d681c`，`git diff` 为空）。

---

## 1. 仍未解决 / 仍有风险

### 1.1 两个"人读工具"不进 CI（F4 / F5）

| 项 | 问题 | 现状与触发条件 | 建议 |
| --- | --- | --- | --- |
| F4 `test/tools/branch-notify.mjs` | 正常路径**恒 exit 0**：只有 `audit` 之外的用法分支才 `process.exit(1)`（`test/tools/branch-notify.mjs:199-201`），末行只是打印候选（`:210`） | 自述「输出是**候选**：要人读」（`:26`、`:28`）；`package.json` 里没有任何调用；其 `pathNotifications` 被 `test/verify-client.mjs:14` import，真判据在那边 | 保持手动工具定位；**若要接进 CI，必须先给它一条能红的判据** |
| F5 `test/tools/sync-webwallgl.mjs` | `BASE_PATH = '/wallpaper-engine/scene-live'`（`:41`）**只自比**（拼 `--base=`、判前缀、写回产物都在本文件内），与产品真值 `lib/routes/scene-serve.js:55` 的 `path: \`${BASE}/scene-live\`` **没有对齐判据** | 纯手动 vendoring rig（文件头写明手动同步、手工改动会被覆盖）；默认上游 `../webwallgl-github`（即 `D:\webwallgl-github`）在本机不存在，实跑即以上述文案退出 —— **环境缺失，不是缺陷** | 接入 CI 前补一条「`BASE_PATH` 必须与产品路由前缀逐字一致」的判据 |

### 1.2 harness / e2e 一族的覆盖空洞

- **`test/compat-harness-surfaces.mjs` 的依赖名地板本机测不到（L41）**：`exemptHit`（`:212`）与被豁免项地板
  `tokens.length + attrs.length + suffixes.length + slots.length - exemptNames.size >= 20`（`:263`）都在「已装 harness」之后才跑，
  而本机 `node_modules/@deepseek-ai/` 下**没有 `dsh`**、`DSH_WE_HARNESS_ROOT` 也未设 ⇒ 守卫在 `:140-142` 就
  `HARNESS SURFACES FAILED` 退出，**这段代码在本机从未执行过**。
  - 影响：这条地板"是否既不空转也不误红"在本机无法验证；触发条件是"只有装了 harness 的机器才跑到"。
  - 建议：在有 harness 的环境跑一次，或用 `DSH_WE_HARNESS_ROOT` 指向一份真装好的包目录。
- **`test/e2e-web-media-origin.mjs` 的浏览器段本机跑不完**：能起 Edge，但中间件产物下载 `fetch failed` ⇒ 后端回落 legacy，该段大量红。
  它**不在** `npm run verify` 里（另设 `verify:e2e`）。
  - 仍可用的部分：浏览器前置判据与产品源码判据能真跑（抽屉主操作区、快速面板的计数）。
  - 建议：在能下到中间件产物的机器上跑完整段。
- **`test/verify-media-bridge.mjs` 在本环境无覆盖**：中间件 `ready` 始终 false，该守卫现在如实报
  `✗ 中间件就绪（握手通过、子进程在跑）`、exit 1（判据在 `:301`，退出码 `:480`）。本机根因有两层：产物没缓存时是下载
  `fetch failed`，产物已缓存（`.test-cache/verify-media-bridge/bin/`）时是 `spawn EPERM`。
  - 在 `npm run verify` 里它还是**软档**：`test/warn-only.mjs` 把守卫失败降级成警告并以 0 退出（见该文件 `:74` 打印的
    `软档守卫原退出码`）⇒ **它的红不改变 `npm run verify` 的红绿**；本沙箱起不了带管子进程时，它会先打印**具名 SKIP**
    （「这不是"通过"：该自检在本环境**没有覆盖**」）。
  - 建议：把它当"本机环境缺口"记账；真要跑这一族用 `verify:bridge`（带 `--provision`）。
  - **本地 CI 实测同一条根因**：`npm run verify:bridge` 在本沙箱 exit 1 —— 守卫自报 `失败：环境性失败：detached: spawn EPERM; plain: spawn EPERM`
    （受限模式不能开命名管道 ⇒ 带管道 stdio 的 `child_process.spawn` 一律 EPERM），同时印出"产物 = 可信、sha256 与发布产物一致"、
    记录"环境跳过（环境性失败）"并**点名本次该通道没有断言覆盖**；退出码仍 1（`test/verify-media-bridge.mjs:480` 只看 `failed`）。
    这条 CI 步骤要在 GitHub runner 上才真跑（那里 `spawn` 可用）。
- **结构性问题**：`compat-harness-*` 与 e2e **都不在** `npm run verify` 的主链上，`.github/workflows/harness-compat.yml` 又只有
  `workflow_dispatch` 触发 ⇒ 这一族守卫**默认不随改动跑**，动到它们时必须手动跑一次。

### 1.3 M16：那条契约现在只有正判据

- 「每个 `kind` 在调用点恰好出现一次」这条契约只有正判据（`test/verify-logging.mjs:159` 起）撑着，没有配套的负对照。
- 风险：计数口径或抽取器哪天退化，不会有守卫报警。
- 建议：若要加固，补一条喂**变异调用点文本**、走同一个计数判据的负对照，而不是再回测一遍抽取器。

### 1.4 设置夹具是"漂移棘轮"，不是正确性判据

- `test/fixtures/settings-sanitize-golden.json` 的期望值录自**录制那一刻实现的实际输出**，只证明「宿主/客户端两侧的规范化输出
  **没有无理由地变化**」，**不证明这些取值本身正确**。
- 它的重生成脚本住在 `.test-cache/`、被 `.gitignore` 排除、**不在仓库里** ⇒ 补键只能人工比对 diff，并自行确认「除新键外零漂移」。
- 键的**存在性**另有 `test/verify-glass-surfaces.mjs` 的 ⑥ 键集快照管（漏补键在那里红）；值的一致性由 `test/verify-client.mjs`
  的棘轮断言管（文案已按"漂移棘轮"口径写）。
- 建议（可选，需要产品知识）：按每个键的**设计意图**重录并把重生成脚本入库；否则至少坚持"改夹具必须写明意图"的人工约定。

### 1.5 记账口径

- 严重度以报告为准：**9 high / 37 medium / 60 low = 106**（逐条标签累加与报告 §7 的分组累加两处都成立）。

---

## 2. 需要你决定 / 环境限制

1. **是否提交**：这批改动（`test/` + 两个生成物 + 五份文档）尚未提交 —— HEAD `1d38c09`，`git status --short` 58 项。
2. ~~是否补 `docs/CHANGELOG.md` 条目~~ **已补**：`docs/CHANGELOG.md` 与 `docs/en/CHANGELOG.md` 的 `### v1.3.1（未发布）` / `### v1.3.1 (unreleased)`
   段各加一条（测试框架反模式审计与加固），并已按"改动一处同步另一处"的口径对齐；两份审计文档也已登记进 `docs/README.md` 与 `docs/en/README.md`。
3. **本机跑不了 CI 的一步**：`npm run verify:bridge` 在本沙箱恒 exit 1（`spawn EPERM`，见 §1.2）；CI 里这一步要靠 GitHub runner。
4. **删不掉的临时产物**（都在真实 `%TEMP%`、不在仓库内；`Remove-Item` / `unlinkSync` 均 EPERM）：
   `dsh-body.mjs`、`dsh-find-bad.mjs`、`dsh-pristine-check\`、`x1-harness-probe\` ⇒ 需要有权限的会话代删。
5. **仓库内已清理**：`test/.tmp*` 计数 0，本地 CI 日志 `ci-local.log` 已删，无遗留探针。

---

## 3. 怎么复核现状

```powershell
npm run verify                       # 期望 exit 0（44 个守卫）
npm run verify:docs                  # 期望 exit 0，末尾 ALL GUARD MAP CHECKS PASSED
npm run smoke                        # 期望 exit 0
npm run build                        # 期望 exit 0；跑完 lib/client.js 内容仍与 HEAD 一致（只是 stat 变新）
npm run verify:bridge                # 本机期望 exit 1（spawn EPERM）—— 环境缺口，不是回归
git status --short                   # 期望 58 项；src/ lib/ scripts/ package.json 不应出现内容改动
node test/verify-media-bridge.mjs    # 本机期望 exit 1（缺中间件产物）—— 环境缺口，不是回归
node test/verify-fontset.mjs         # 期望 ALL FONTSET CHECKS PASSED (157)
```
