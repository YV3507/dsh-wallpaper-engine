# 问题留档：GPU 占用居高不下 / 暂停不归零（未解决）

状态：**调查中** ｜ 相关提交：尚未改动代码

## 症状

- DSH Desktop 的 GPU 占用长期偏高，不随壁纸类型/状态回落。
- **视频壁纸暂停后占用不归零**（用户已实测确认视频确实被暂停）。

## 已实测结论

采样方式：`Get-Counter '\GPU Engine(*)\Utilization Percentage'`（逐 pid × 引擎类型）+ `\Process(*)\IO Read Bytes/sec`。

### 1. 无残留子进程

`node` / `ffmpeg` / `ffprobe` 全部为空 —— 宿主 fork 的渲染 worker、转码 ffmpeg 都正常退出，**不是**子进程泄漏。

### 2. GPU 归属（重要：有无关大户）

| pid | 进程 | 引擎 | 占用 |
|---|---|---|---|
| 7936 | `GameViewerServer` | videoencode | **17%**（屏幕串流编码，与本插件无关） |
| 28292 | `msedge` | videodecode | **28%**（Edge 播放视频，与本插件无关） |
| 25548 | `msedgewebview2` | 3d | 2% |
| **10596** | **DSH Desktop（GPU 进程）** | **3d** | **14–45%** |
| **10596** | 同上 | **videodecode** | **7–19%** |

### 3. 遮挡暂停 A/B（证伪：暂停对 GPU 无影响）

配置 `pauseOnBlur: true`；用记事本抢焦点自动触发遮挡暂停，三态采样：

```
基线(有焦点)  3d avg=15.5%   videodecode avg=7.6%
失焦(应暂停)  3d avg=17.5%   videodecode avg=8.0%   ← 无任何下降
恢复焦点      3d avg=16.1%   videodecode avg=7.6%
```

代码层面暂停链路本身是完整的（`src/client.js`）：
`window` 的 `visibilitychange`/`blur`/`focus` → `emit()`（:5457）→ `syncLayers()` → `isEffectivelyPlaying()`（:1506）→ `video.pause()`（:1814）；
Edge 画布回环在暂停时停掉 rAF（:1226）；切换壁纸有 `releaseLayerMedia()`（pause + 清 src 再摘除，:1180）。

用户也已实测确认：**视频确实处于暂停状态**。

### 4. 当前壁纸

id `3377742614` = 普拉娜，`type=video`，729 MB MP4，`fpsCap=24`，`sceneGpuAccel=false`，`blur=15`，`ropeShown=true`。

## 结论（已定案，2026-09-17）

**"GPU 占用居高不下、暂停不归零"不是本插件的泄漏**，而是第三方屏幕捕获工具 `GameViewerServer`。

60 秒逐秒采样（每秒聚合 `\GPU Engine(*)\Utilization Percentage`）：

```
12:00:22  DSH 3d= 3.0   DSH decode= 4.1   GameViewer= 73.2
12:00:32  DSH 3d= 3.9   DSH decode= 8.6   GameViewer= 95.5
12:00:54  DSH 3d= 3.8   DSH decode= 7.5   GameViewer= 89.0
12:01:07  DSH 3d= 3.8   DSH decode= 7.7   GameViewer= 98.3
12:01:14  DSH 3d=       DSH decode=       GameViewer=107.6
```

- **DSH Desktop 稳态 `3d ≈ 3.7%`**（偶发 20% / 26.4% 为界面重绘尖峰，与聊天流式输出同拍）；
- **`GameViewerServer` 稳定 73–108%**（3d + videoencode 合计），全程满载；
- DSH `videodecode ≈ 7.7%` = 4K 壁纸视频（已由 `fpsCap: 24` 转码限帧）；**用户实测暂停后归零** ✓。

用户观察到的"3D 0→90+%、看不出规律、与暂停无关"= `GameViewerServer` 的数字（屏幕捕获要求桌面合成器持续出帧，故与壁纸状态无关）。

### 已排除（均有实测凭证）

| 怀疑 | 凭证 |
|---|---|
| 解码器泄漏 / 隐藏 `<video>` | DOM 探针 `gpuprb-1`：`videoCount = 1` |
| 无限 CSS 动画叠 backdrop-filter | 同一探针：`animCount = 0` |
| 残留 ffmpeg / worker 子进程 | `Get-Process ffmpeg,node` 为空 |
| 抽帧转码一直跑 | 同时段无 ffmpeg（缓存中 `tc_*.mp4` 为历史产物） |
| 暂停链路失效 | 暂停后 `videodecode → 0` |
| 宿主与离线路径不一致 | `this.gpuAccel` 只赋值、从未被读 |

视频解码 7–8% 属上游 issue #31 记录的"4K 视频解码固有成本"，已由 `fpsCap`（抽帧转码）压过一次，非缺陷。

### 追加 A/B：壁纸播放 vs 暂停，对 UU远程 的影响（用户现场）

用户实际在用**网易UU远程**（其服务进程即 `GameViewerServer`），不可停。60 秒采样中用户切换了壁纸播放/暂停：

```
12:02:18  UU-encode=14.1  UU-3d=33.5  DSH-decode=0    ← 壁纸暂停
12:02:22  UU-encode=16.5  UU-3d=98.7  DSH-decode=0    ← 壁纸暂停
12:02:35  UU-encode=16.7  UU-3d=69.1  DSH-decode=7.9  ← 壁纸播放
12:02:48  UU-encode=16.0  UU-3d=49.6  DSH-decode=0    ← 壁纸暂停
12:03:04  UU-encode=18.9  UU-3d=65.0  DSH-decode=11.2 ← 壁纸播放
```

- `UU-encode` 全程 **14–21% 基本恒定**，与壁纸播放/暂停**无关**（壁纸暂停也没让它降下来）；
- `UU-3d` 在 **33–99% 之间剧烈跳变**，同样与壁纸状态无关；
- `DSH-decode` 在 0 与 7–8% 之间随暂停切换 ✓（暂停链路再次确认正常）。

⇒ 用户看到的"3D 0→90+、无规律、与暂停无关"**就是 UU远程 自身**的占用；壁纸的边际成本只有 `3d ≈ 3.7%` + `decode ≤ 8%`。**暂停壁纸并不能减轻 UU远程 的编码负担**（负结果，值得记录）。

### 副产物：动态 Cordis 客户端沙箱的能力边界（实测）

- `document` **可用**（可 `querySelectorAll` 读到真实节点属性）；
- `ctx.timer.interval` **能注册但回调永不回火**（`hasTimer: true`、`tick` 恒为 1）；
- DOM 事件监听（`video` 的 `play/pause/timeupdate`）**不触发**；
- `MutationObserver` **可用**（能触发回调并成功 `host.call`），但页面无变化时不产生回调；
- 结论：动态客户端插件只能做**一次性采样**，连续观测必须改插件自身源码用真实 `setInterval`。

---

## 原始结论（排查中，保留）

暂停生效但 GPU 不降 ⇒ 仍存在以下之一：

1. **隐藏的 `<video>` 在后台继续解码**（历史切换/升级留下的元素；代码注释 :1177 记录过这类"每切一次多一个后台解码器"的问题）；
2. **无限 CSS 动画叠加在 backdrop-filter 玻璃上**——每帧强制重算全屏模糊。当前唯一的 `infinite` 动画是 `.we-vinyl`（`we-vinyl-spin 8s`，:4677），依赖"仓库面板未打开时暂停"（:4678）；
3. 那 7.8% `videodecode` **不是壁纸视频**，而 3d 占比主要来自 DSH 壳自身的玻璃合成（非本插件）。

## 下一步（已定方案）

客户端专用诊断（宿主无 DOM 服务，动态 Cordis 客户端插件也拿不到 `document`，只能改插件自身源码）：

1. `src/client.js`：新增受设置项控制的探针，每 1 s 采集
   `document.querySelectorAll('video').length`、每个 video 的 `paused / readyState / currentTime / webkitDecodedFrameCount / src 尾段`、
   `document.hidden`、`document.hasFocus()`；
2. `lib/index.js`：新增 `/wallpaper-engine/client-diag` 路由，追加写入 `~/.dsh-wallpaper-engine/gpu-diag.log`；
3. 重建客户端（`npm run build`）+ 刷新 DSH 页面 → 复现"暂停"→ 直接读日志定因。

## 环境备注

- 插件宿主日志：`~/.dsh-wallpaper-engine/gpu-diag.log`（UTF-8 被控制台按 GBK 解码，读时注意）。
- 场景渲染走 `worker_threads`（`gpuNode=null`、`gpuAccel=false`），即在 DSH 进程内做 3840×2160 CPU 光栅化；单次渲染 4–26 s（日志中可见 22 MB PNG 回读）。
