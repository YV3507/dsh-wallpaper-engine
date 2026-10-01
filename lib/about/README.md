# 联系方式二维码（随包发布的运行时资源）

「关于」页签里那两张二维码的**运行时字节**。与本目录并列的 `lib/fontsets/`（随包预设）、
`lib/webwallgl/`（随包渲染页）同一口径：**随包发布、由插件自己的路由提供**。

- 提供方：`lib/routes/about-qr.js`（`GET/HEAD <BASE>/about-qr/<文件名>`，白名单 + ETag/304）。
  客户端只存路径（`src/about-assets.js`），`<img src>` 直接指过来。
- **为什么不用内联 base64**：那版把两张图压进 `lib/client.js`（+240KB，每次冷启动都要解析这串
  字符），而它们与面板逻辑毫无关系 —— 拆成静态文件后 bundle 回到原大小，换码也只需要替换这里的
  PNG（不必重建客户端产物）。
- 本目录**进 npm 包**（`package.json` 的 `files` 里 `lib/about/`；`verify-package-files` 盯这件事）。
  **源资产**（未裁剪的原始截图）在仓库的 `assets/about/`，那一份**不进包**。
- **README 也引用这两张图**（中英两份的联系方式段）——展示的就是插件里真用的同一份字节，
  不另存副本。

## 这两张图是什么

| 文件 | 内容 | 派生自 |
|---|---|---|
| `qq-group.png` | QQ 群「DSHWE \| LLM 讨论群」二维码（520×517） | `assets/about/qq-group-dshwe-llm-702x852.png` |
| `douyin-group.png` | 抖音群「dsh 交流群」（群号 252729465001）二维码（520×520） | `assets/about/douyin-group-dsh-1044x1026.png` |

派生口径（只取码区 + 缩到 520px 宽 + 128 色调色板）与验证方式（逐像素比对 + macOS Vision 扫码）
见 [`assets/about/README.md`](../../assets/about/README.md) —— 那里是**怎么生成**，这里是**发布什么**。
