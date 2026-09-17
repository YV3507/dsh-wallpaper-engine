# 问题留档：solid layer 不透明方块（已定位并修复）

状态：**已修复** ｜ 修复提交：`d9beac6` ｜ 原档名 `ISSUE-particle-white-square.md`（当初误判为粒子问题）

## 症状（用户报告）

多张 Wallpaper Engine 场景壁纸渲染出**硬边、近纯白的不透明方块**，用户描述为"粒子白方块"，
并因为 Angel Mail 的粒子最大而认为在它上面最明显。

## 根因（实测归因，非推断）

第三方 dock 组件（workshop `3573886911`）的 Launcher 层是
`models/workshop/3573886911/solid_instance_model_2ddfb9d9.json` =
`{"instanced":true,"material":"materials/util/solidlayer_instance_4.json","solidlayer":true}`：

1. `lib/we-renderer/image.js:88` 把 `solidlayer:true` 的模型交给 `_renderSolidLayer`；
2. `_renderSolidLayer` 用对象 `color`（默认 `1 1 1`）**填满四边形并硬写 `alpha = 255`**，然后整块 blit；
3. 唯一能给它塑形的 `custom_user_texture` 效果被 `lib/we-renderer/effects.js:46` 的
   `visible === false` **跳过** —— 它声明 `visible = {"user":"appdockapplyusertextureN","value":false}`，
   而 Angel Mail 的 `project.json` 里没有这个键（只有 `app`/`app1`）；
4. ⇒ alpha 从未被塑形，于是平铺出一块不透明纯白方块。

**直接证明（不是推断）**：

| 实验 | 结果 |
|---|---|
| 把 Launcher 的 `color` 改成 `"1 0 0"` | 方块**恰好**变成 `rgba(255,0,0,255)`，bbox 不变 ⇒ 方块就是该 solid layer 的颜色填充 |
| 强制 `custom_user_texture.visible = true` | 方块**归零** |
| `DSH_RT_ALL=1` 看 Launcher 自身合成图 | 100% 不透明、均匀 `255,255,255,255` |
| 隐藏容器 `App Launcher Dock`(object 412) | 纯白像素 8712 → **0** |

**与粒子无关**（原假设被证伪）：隐藏全部 4 个粒子对象后缺陷仍在；
强制打开 `3629379075` 的 `appdockenabled` **同样复现** ⇒ 缺陷跟随**第三方组件**分发，
"粒子大更明显"只是同一批中文壁纸恰好都带这个 dock 的相关性巧合。

## 修复

| 位置 | 改动 |
|---|---|
| `image.js:233-235,244` | `model.instanced === true` 且效果链**实际未产出内容**时，`_renderSolidLayer` 直接 `return`，不 blit（对齐同文件既有的音频条占位块守卫 `image.js:191-195`） |
| `effects.js:45,57,192` | 新增 `fxContentDiffers(a,b)` + `applyEffects` 可选第 4 参 `status`：仅当某效果**输出与输入逐字节不同**才算真正塑形 |
| `canvas.js:11` | 顺带修独立缺陷：`clear(r,g,b,a)` 原先无条件 `fill(0)`、参数被完全忽略 ⇒ 场景 `clearcolor` 从未生效；现在全 0 参数保持原行为逐字节不变，其余按参数 round+clamp 填充 |

**为什么用"内容级"而不是"是否派发"**：实测效果 2 `user_texture_alpha_overwrite_workaround`
**确实被派发但恒等**（frag 里 `mask=1.0`、`g_UserAlpha=1`，输出与输入逐字节相同）。
若按"派发即算"，方块**依然会留下**。

## 验证（可复现）

```bash
node scripts/tmp-rect-detect.mjs 3641860575 960 540 2.5   # 检测器: 量化+连通域+fill≈1+边缘落差+硬度比
```

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `3641860575` 严格纯白矩形计数 (t=0/2.5/6) | **3 / 2 / 2** | **0 / 0 / 0** |
| `3641860575` 缺陷命中 (bbox 491,457 57×57, fill=1.000, step1=112.7) | 存在 | 消失 |
| `3629379075`（强制开 dock） | 2 个 31×31 白块 | 0 |
| `3640755971` / `3629379075` / `3660962877` / `3461168300` 原始帧 | 基线 | **逐字节等同** |
| 作者手工 `models/util/solidlayer.json`（`instanced` 未定义）色块 | 正常 blit | **正常 blit，像素不变** |
| `3641860575` 差异范围 | — | 仅限 launcher 列 bbox (491,312)-(547,539) |

`clear()` 修复实测（`3640755971`，clearcolor 0.30588）：角点 `(0,0,0,0) → (78,78,78,255)`，
原 47% 透明区被 clearcolor 填满，不透明占比 53% → 100%。

`npm run verify` 六套全过；`node --check` 3/3 通过。

## 残留（已知，未处理）

1. `produced` 是**粘性**的：若某效果改了内容、后续效果又把它还原成完全相同的平铺填充，该层仍会绘制；
2. 整帧恰好等于**非黑** clearcolor 的壁纸，现在会命中"空帧门禁"走主纹理回退（5 张实测未出现）；
3. `DSH_RT_ALL=1` 下 `obj:Launcher*` 仍会保留白缓冲（守卫只抑制最终 blit，最终帧 0 方块）。

## 方法学备忘（下次归因直接复用）

- **"逐个隐藏对象"的朴素二分法会失败**：这些 Launcher 的 `visible` 是**脚本驱动**的，单独隐藏子对象会被脚本重新打开；必须隐藏**容器**（`App Launcher Dock`）才归零。先确认 `visible` 是不是脚本态。
- **检测器判据**：颜色量化(>>3, 含 alpha 桶) → 4-连通域 → `area ≥0.3%` + `alpha ≥250` + `fill=area/bboxArea ≥0.85` + 内部通道极差 ≤12 + **边缘落差 ≥25** + **硬度比 step1/step(4px) ≥0.85**；只有 `fill≈1.000 / range 255-255` 才是真矩形。否则会把发光角色（如 `3690417937`：mean 254 但 fill 0.47–0.65）误报。
- **反向实验要能改写可观测值**：把 `color` 换成红色并检查像素值是否精确匹配，比"隐藏后消失"更硬（后者可能被别的图层补上）。

## 现场遗留脚本（`scripts/tmp-*.mjs`，gitignore，未提交）

`tmp-rect-detect`（检测器）、`tmp-rect-bisect`、`tmp-obj-contrast`、`tmp-find-drawer`、
`tmp-dock-attrib`、`tmp-dock-fix`、`tmp-dock-mech`、`tmp-dock-cross`、`tmp-dock-enable`、
`tmp-white-origin`、`tmp-k0-repro`、`tmp-obj-list`、`tmp-dump-scene`、`tmp-scan-component`、
`tmp-global-pollute`。

> 注意：场景脚本引擎会替换全局 `console`，临时脚本输出必须用 `process.stdout.write`。
