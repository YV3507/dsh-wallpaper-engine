# 问题留档：粒子白方块（未解决）

状态：**开放** ｜ 记录时间：本轮会话 ｜ 相关提交：`b6ce99b`（该提交未修复此问题）

## 症状

- 多张壁纸上都会出现**白方块 / 白色矩形块**，不是个别壁纸的问题。
- 用户描述：Angel Mail（`3641860575`）**最明显**，因为它的粒子最大。
- 视觉特征：硬边、方形、接近纯白（非软边光晕）。

## 已排除项（全部为实测，非推断）

复现命令一律在仓库根执行；`WE` = `E:\SteamLibrary\steamapps\common\wallpaper_engine`。

| 怀疑点 | 实测结论 | 证据 |
|---|---|---|
| 精灵表容器解析错（TEXV0005 / TEXS 序列） | **正常** | `fog1.tex` = `TEXB0003` 1024×1024、`debris1.tex` = `TEXB0002` 1024×128，mip 链完整 1024→2 |
| LZ4 解压出全零 ⇒ 不透明方块 | **证伪** | mip0 `declen=1048576 stored=494381`，解压后非零 **43.8%**（mip1 44.1%、mip2 45.8%） |
| 文件 680,757 B 却有 1 MB 数据 ⇒ 走错区段 | **自洽** | `stored` 是压缩块、`bytes` 是解压结果；`deriveDims`/DXT 回退分支**本就不该触发** |
| TEXS 帧元数据缺失 ⇒ 整张表当一帧画 | **证伪** | `loadTexImage`：fog1 `frames=64`(128×128, frametime 0.015625)、debris1 `frames=8`、`notes_sprite_sheet_130x258_41` `frames=41` |
| R8 解码硬写 `alpha=255` ⇒ 白方块 | **对粒子无害** | `_drawParticles` 按官方 `genericparticle.frag` 采样 **red** 通道（`tex.r`），不用 alpha |
| `opacity` 效果取错通道 | **否** | `lib/we-renderer/effects/opacity.js:29` 用 `_texR`（red），语义正确 |
| 应用与离线走不同渲染路径 | **否** | `lib/we-renderer/core.js:56` 的 `this.gpuAccel` 只赋值、**从未被读** |

### 关键量化：粒子层对画布的真实贡献

`node scripts/tmp-particle-ab.mjs 3641860575 960 540 <t> <WE>`（有粒子 vs `DSH_DIAG_NOPARTICLE=1` 逐像素差分，阈值 `|Δ|>2`）

```
Angel Mail 960x540
  t=0 / 0.05 / 0.1 / 0.5 → 差异像素 = 0        (应用预览用的正是 time=0，lib/index.js:3072)
  t=1   →    36 px (0.01%)
  t=4   →  2282 px (0.44%)   bbox 856x251
  t=8   →    25 px
  t=12  →  1561 px (0.30%)
  t=20  →   585 px (0.11%)
```

同一时刻 `DSH_WE_DEBUG_PARTICLE=1` 显示粒子系统确实在画：

```
Long wind trail : 存活12 通过alpha11 写入像素=92478 texR=0.01~0.31 尺寸653 纹理1024x1024
Wind particles  : 存活 5 通过alpha 4 写入像素=2     texR=1.00~1.00 尺寸19  纹理1024x128
notes1_simple   : 存活 2 通过alpha 2 写入像素=0
```

⇒ 写入 92478 px 但最终只改变 ≤0.44% 画布：这些写入**被后续图层覆盖**或 alpha 极低。

## 结论

白方块**不是**"粒子贴图解码错"这一类局部 bug，而更像**图层级**现象：某一层被当成不透明矩形整层铺出。
旁证：`皓风琦[3640755971]` 的 `opacity` 遮罩曾测得覆盖率 100%（同一族症状），且该问题在多张壁纸出现、**层/粒子越大越明显** —— 与用户"普遍性问题，Angel Mail 最明显因为粒子最大"的描述一致。

## 下一步（计划）

1. 写"硬边不透明矩形检测器"批量扫 `E:\SteamLibrary\steamapps\workshop\content\431960`：找大面积、近常量、直边、满不透明的区域，按面积排名。
2. 对命中壁纸做归因 A/B：逐个关掉对象/效果（`DSH_DIAG_SKIP`、`DSH_DIAG_NOPARTICLE`、逐效果降级日志），锁定产生方块的那一层。
3. 若确认为"整层不透明"，重点查：`opacity`/`texture_override` 的遮罩采样尺寸比（`mSx/mSy`）、R8 遮罩在 `blendFg`/`applyBlending` 路径中的通道语义、以及 `texture_override` 输出 `alpha` 的构造（`min(1, oa*opacity) * (src.a/255)`）。

## 现场遗留（未提交、均为环境变量门控）

- `lib/pkg-extract.js`：`DSH_WE_DEBUG_TEX=1` → `[TEX-HDR]` / `[TEX-MIP]` 容器与解压诊断。
- `lib/we-renderer/particles.js`：`DSH_WE_DEBUG_PARTICLE=1` → 精灵 red 直方图 + 每系统绘制量 + quad 5×5 red 网格；`DSH_DIAG_NOPARTICLE=1` → A/B 关粒子。
- 临时脚本：`scripts/tmp-particle-ab.mjs`（A/B 差分）、`scripts/tmp-sprite-probe.mjs`（贴图形态/帧元数据）、`scripts/tmp-particle-tex.mjs`。

> 注意：场景脚本引擎会替换全局 `console`，临时脚本输出必须用 `process.stdout.write`。
