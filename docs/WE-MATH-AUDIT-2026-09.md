# WE 逆向数学审计 — Plana 下巴 / Amiya 偏上 (2026-09)

> 方法: 纯数学对比 `lib/we-renderer` 与官方 wallpaper64.exe 逆向 (decompiled/*.c + *.asm) 与
> linux-wallpaperengine (lwe) 独立实现。视觉对比不可靠 (用户确认), 以算法差异为根因依据。
> 官方逆向文件: `C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\decompiled\`

---

## 一、结论速览

| 壁纸 | 症状 | 根因 (已确认/待确认) | 状态 |
|---|---|---|---|
| Plana (3461168300) | 下巴异常扭曲 (脸型变化) | **模型 pos 顶点流下巴短** (嘴-眼 32-55 单位 vs 纹理 150px = 3-4.7 倍压缩); MDLV 尾部 12B "参考位置" 散开 (非官方顶点, ref 蒙皮已回退); 官方正常机制未明 (候选: GPU 顶点缓冲/scale 语义/793B 每骨偏移表) | ⚠️ 回退后待继续 |
| Amiya (3486806915) | 全体组件偏上 | 待实机确认: 数学上 viewShift/锚点/链乘全部与官方一致; 剩余嫌疑 = viewShift y 符号 (未经实机验证) 或 桌面比例 letterbox | ⚠️ 待定 |

---

## 二、已确认的官方算法事实 (逆向证据)

### 2.1 骨骼局部矩阵含 scale — asm 证实 (C 反编译有损)
- `FUN_140267580` 的 C 反编译**只读通道 0-6** (平移+四元数), 但 asm 明确读取**通道 7/8/9**:
  - L713216-713225: `lea eax,[r15+rbx]`(ch8) / `[r12+rbx]`(ch9) / `[r14+rbx]`(ch7) → movss 载入
  - L713343 起: ch7 (sx) 存入栈 → 后续 `mulss` 乘入矩阵线性部分
- 结论: 官方局部矩阵 = `[Rz·S | T]` (行向量, 平移在行 3) — 与我们 `_sampleAnimRT` 一致 ✅
- 推论: **scale 经链乘传播** (world = local×parent 含父 scale) — 眨眼时眼睑骨骼的子链 (含下巴) 会随父 scale 压缩, 这是官方行为, 不是 bug。

### 2.2 动画层混合函数对**所有层** (含 additive) 混合 scale 通道
- `FUN_1401f89a0` (blend=1 替换) / `FUN_1401f9020` (普通混合) / `FUN_1401f9820` (additive):
  - asm L373071-373098 (9020) 与 L373399-373443 (9820): 通道 7/8/9 与 0-2 用**同一套 lerp 公式**
  - `uVar25=param_4*7, uVar24=param_4*8, uVar12=param_4*9` — additive 路径同样处理 scale
- 结论: **官方 additive 层贡献 scale**; 我们 434b31c ("additive layers do not composite scale") 与官方相悖。

### 2.3 骨骼链乘顺序
- `FUN_140267580` 循环: `new = acc × M_current`, 自骨骼向上到根 → world = M_bone×M_parent×…×M_root (行向量, 局部先乘) = 我们的 `local × world[parent]` ✅ 一致
- 蒙皮: 官方 shader `mul(vec4(pos,1), g_Bones[...])` (行向量) = 我们的 `p·gBone` ✅ 一致

### 2.4 MDLA 帧 = 局部坐标, 帧0 = bind (Plana 实测)
- 眼动画 432 帧0 与 bind 局部矩阵逐骨骼差 = 0 ✅
- 眼动画 432 只改骨骼 22/24/31/33 的 sy (1.0→0.003) 与骨骼 23/32 微小 sx/sy — **眨眼 = 纯 scale 动画**

### 2.5 相机 viewShift (Amiya 关键)
- 官方 0x1401ED0D0: eye x@0x178 / y@0x17c 两轴 `subss` → 视图平移两轴
- 推导 (含 y-flip): 屏幕偏移 = `[(-eye.x)·ps, (+eye.y)·ps]` — 与 `camera.js _viewShift` 一致 ✅
- lwe (验证过的独立实现): `projection = ortho + translate(eye)` — 转换到屏幕后与上述一致 ✅
- 2D 定位基准: 官方 = `origin×ps + viewShift` (无画布中心项; "0.5" = 场景→画布固定缩放) — 与 `_orthoZoomCenter`/`renderPuppet` 一致 ✅
- ⚠️ 注意: we-official-pipeline.md §3.3 明确记录 "viewShift 公式…**未经实机最终确认**"

### 2.6 MDAT 锚点 / 对象 transform
- 官方: 子世界 = 父世界 × (锚点矩阵 · 子局部) — 与我们 `resolveTransform` 一致 ✅
- 锚点 = 骨骼最终世界位姿 + 锚点矩阵 (旋角 0 → 平移相加) ✅

---

## 三、Plana 下巴 — 根因与修复

### 根因链
1. 人物 (id 53) 两个动画层: 呼吸 (4327, normal, blend=1, rate=0.76) + **眼 (432, additive, blend=1, rate=1.15)**。
2. 眼动画 = 眨眼: 骨骼 22/24/31/33 的 **sy 1.0→0.003** (纯 scale, 无旋转/平移)。
3. 旧实现 (4e900b3) 支持 scale, additive 按比值合成 → 眼睑闭合, 但下巴随链乘压缩 (用户反馈"下巴压缩")。
4. 434b31c 因此**完全移除** additive 的 scale → 眼睑永不闭合 → 脸型与官方不符 (眼/嘴正确、眼睑张开 = 面部比例错误)。
5. 反汇编证明 434b31c 的前提 (additive 不混合 scale) 是**错的**: 官方对 additive 层同样混合通道 7-9。
6. 下巴随眼睑压缩是链乘传播的**官方行为** (scale 在局部矩阵中必然传播到子链), 不是 bug。

### 修复 (已实施)
`lib/we-renderer/puppet.js` + `lib/we-renderer/scene/transform.js`: additive 层恢复 scale 比值合成
```js
final[b].sx *= Math.pow(lw[b].sx / ref.sx, layer.blend);
final[b].sy *= Math.pow(lw[b].sy / ref.sy, layer.blend);
```
- ref = 层动画帧0 世界 (眼动画帧0 = bind, sx=sy=1 → 比值 = lw 全量)
- blend=1 (Plana 眼层) → 眼睑 sy 精确 = 0.003 (闭合) ✅
- 与官方"局部通道 lerp 后链乘"在 Plana 数据上等价 (呼吸层无 scale, 1×(lw/ref) = 链乘结果)

### 验证
- t=0.87 (眼帧 60, sy=0.003): 面部区域 vs t=2.5 差异 19.5% — 眼睛闭合 ✅
- t=2.5 (静态帧, 眼帧 172): 仅 2.07% 像素微变 (骨骼 23/32 的 0.1% scale 修正, 官方数据如此) ✅
- Amiya (有 additive 层但无 scale): 0.02% 像素变化 (舍入) — 无回归 ✅
- Angel Mail: 渲染成功 (其 additive 层无 scale 时比值=1, 数学不变) ✅

---

## 三-b、Plana 下巴 — 真正根因: MDLV 参考位置蒙皮 (2026-09 补充)

### 复盘
上一轮把根因归为"additive 不合成 scale"并实施比值合成 (用户判定"修错位置" — 实际是
pos 蒙皮下巴贴眼的错误补偿)。本轮穷尽验证后定位到**真正的根因**: 蒙皮顶点数据用错。

### 数学证据 (Plana vs 3554161528)
| 指标 | Plana (下巴贴眼) | 3554161528 (正常) |
|---|---|---|
| 顶点流 pos 嘴-眼间距 (UV 分区) | 23 单位 | 79.5 单位 |
| 纹理嘴-眼间距 (UV v×纹理高) | 150px (3550×3750) | 81px (1405×2013) |
| pos/纹理 比值 | **0.15 (6.6 倍压缩)** | 0.99 ✅ |
| MDLV 尾部 ref 嘴-眼 | **154.6 单位** | 94.2 单位 |
| ref/纹理 比值 | **1.03 ✅** | 1.16 |
- 顶点流 pos: 绑定用坐标 (下巴短); MDLV0023 尾部参考位置 (ref): 渲染用坐标 (下巴正常)。
- 官方蒙皮 = `Σ w × (ref × gBones[b])`, gBones = `finalWorld × bindInv` (64B bind) —
  静态 (gBones=I) 顶点 = ref (下巴 154.6 ✓); 我们用 pos → 下巴 23 (贴眼)。

### ref 数据定位
- 结构: `[索引区结束][9B 头][每顶点 12B xyz × vertexCount]` (9B 头 = `[u32 0x0101][u32 ?][u8 0]`)
- Plana: ref @56170 (634 顶点 × 12B); 3554161528: ref @44298 (497 顶点 × 12B)

### 修复 (已实施)
`lib/we-renderer/puppet.js`:
1. `_parseMdl`: 解析 MDLV 尾部 refPositions (索引区结束+9, 每顶点 12B), 校验有限性/量级。
2. `_skinPuppet`: 蒙皮顶点数据 = `mesh.refPositions || mesh.positions`; 静态回退同样用 base。

### 验证
- Plana t=2.5: 嘴-眼 146.3 (纹理 150 ✓); bbox 3606×3735 (≈ size 3550×3750, 更合理)。
- 3554161528 t=2.5: 嘴-眼 94.2-118.8 (纹理 ~100, 无回归)。
- f60 眨眼: 骨 31 sy=0.01 (眼睑压扁) → 嘴部 (绑定骨 31) 移动 ~500 — 官方链乘行为 (scale 传播), 与 additive-scale 修复 (§三) 共同构成完整官方语义。

---

## 三-c、MDLV 尾部参考位置 — 假线索 (2026-09 复盘追加)

### 本轮实验 (已回退)
把 MDLV0023 尾部 (8410B) 按 "[9B 头][每顶点 12B xyz]" 解析为 refPositions 并用于蒙皮,
实测**人体组件完全拆散** (用户实机确认), 已回退。

### 数学证伪
| 检验 | 结果 |
|---|---|
| ref 三角形边长度 vs pos | **相同** (中位 54.1, p90 426.9) — ref 与 pos 形状同构 (每骨平移变体) |
| ref 顶点密集点云 | **完全散开** (182×186 网格无 人形轮廓) — 非模型空间人形坐标 |
| ref × bindWorld[主骨] vs pos | 不匹配 (散开, bbox 4537×5217) — ref ≠ pos × bindInv |
| ref 差值 vs bindWorld76−bindWorld64 | 全 no — ref 非 76B bind 锚点差 |
| ref 每顶点最佳匹配骨 | 97/100 顶点最佳骨 = 47 (异常) — ref 非每顶点骨骼局部 |
| pos × (bindWorld64×bindInv76) / pos × bindInv76 | bbox 6131/3749, 嘴-眼 -1232/-605 — 全错 |

### MDLV 尾部真实结构 (已确认)
- `[9B 头: u32 0x0101][u32 0x001DB800][u8 0]` + `634×12B` (散开顶点, 官方蒙皮不用) + `793B 尾`
- 793B 尾 = **每骨顶点偏移表**: u32 值 /32 = 递增顶点索引 (96,120,144,184,200,216,224,240...),
  差值 = 每骨顶点数 (96,24,24,40,16,16,8,8...) — 共 53 骨记录

### 剩余矛盾 (未解)
- **pos 下巴短**: 嘴-眼 32-55 单位 vs 纹理 150px (3-4.7 倍压缩) — 模型 pos 顶点流数据
- **官方正常** (用户实机确认) → 官方蒙皮顶点 ≠ pos 且 ≠ MDLV 尾部 12B
- 官方主渲染 (445300-445444): 帧插值 lerp + 链乘 → 每骨 64B 矩阵 → 静态 = bind = pos (下巴短)
- additive scale 官方 = 加法 (FUN_1401f9820, out += delta×blend) — blend=1 时与 pow 比值等价

**下一步候选**: 逆向官方 GPU 蒙皮的顶点缓冲 (shader 输入, 可能非 pos); 验证官方 CImage 渲染
puppet 的 scale 语义 (autosize → size 缩放?); 793B 每骨顶点偏移表的使用。

---

## 四、Amiya 偏上 — 调查记录 (未定论)

### 已验证一致 (数学)
1. viewShift = [(-eye.x)·ps, (+eye.y)·ps], eye = (-360, -269.56) → (90, -67.4) @960×540 (上移 67px) — 与官方 0x1401ED0D0 subss 推导一致。
2. 相机对象 (id 1297271, script origin (2434, 725, 500)) **不是** eye — 若作 eye, 人物会出屏 (已数值验证), 官方不可能如此。
3. 骨架/锚点链: 身体骨架 (鼻子_puppet, 7 骨) 动画 537 (blend 0.73) 帧0 = bind, 锚点世界位姿与渲染位置自洽 (头 (371,160)、身体 (289,362) 与上一轮基线完全一致)。
4. 头 (id 697) 动画 374+690 (additive 0.74) **无 scale** — additive-scale 修复不影响 Amiya。
5. 2D 定位公式 (无画布中心) 与 lwe 独立实现一致。

### 剩余嫌疑 (需桌面实机确认)
1. **viewShift y 符号**: 公式 `[(-eye.x)·ps, (+eye.y)·ps]` 推导自反编译, 但 we-official-pipeline.md §3.3 自认"未经实机最终确认"。若官方实为 `-eye.y·ps` (下移), 人物应比我们低 ~135px — 与"偏上"吻合。
2. **桌面比例 letterbox**: 官方桌面 16:10 (2560×1600) 对 16:9 场景 (3840×2160) 上下加黑边, 人物相对画面下移; 我们渲染 16:9 无黑边 → 人物相对偏高。这是**对比方法差异**, 非渲染器 bug。
3. 五官/头发锚点 (五官头发 bone=2) 的相对合理性已验证 (上一轮结论), 非本症状根因。

### 建议验证步骤
1. 在 16:9 (3840×2160) 桌面实机打开 Amiya, 与插件 3840×2160 静态帧逐像素对比人物整体偏移。
2. 若实机人物比我们低 ~135px → 翻转 `_viewShift` 的 y 符号 (`+eye.y·ps` → `-eye.y·ps`)。
3. 若实机一致 → 症状来自桌面比例/对比方法, 关闭此单。

---

## 五、诊断脚本 (本次生成, 可删)
`scripts/diag-plana-math.mjs` / `diag-plana-math2.mjs` / `diag-plana-skin.mjs` / `diag-plana-blink.mjs` /
`diag-plana-breath.mjs` / `diag-plana-face.mjs` / `diag-plana-face2.mjs` / `diag-plana-var.mjs` /
`diag-plana-ascii.mjs` / `diag-plana-chin.mjs` / `diag-plana-chinsym.mjs` / `diag-plana-faceverts.mjs` /
`diag-amiya-scene.mjs` / `diag-amiya-pos.mjs` / `diag-amiya-png.mjs` / `diag-amiya-skel.mjs` /
`diag-amiya-head.mjs` / `diag-amiya-head2.mjs` / `diag-render.mjs` / `diag-png.mjs` /
`diag-official-screen.mjs` / `diag-capture-official.mjs`
