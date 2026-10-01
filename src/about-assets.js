/**
 * about-assets.js — 「关于」页签用到的**静态数据**（仓库地址 + 两张二维码的路径）。
 *
 * 二维码**不再内联 base64**（2026-10-01 用户要求改成 PNG 引入）：那版把两张图压进
 * `lib/client.js`（+240KB，每次冷启动都要连同 bundle 一起解析），而它们与面板逻辑毫无关系。
 * 现在图是随包资源 `lib/about/*.png`，由宿主路由 `GET <BASE>/about-qr/<文件名>` 直出
 * （白名单 + ETag/304，见 lib/routes/about-qr.js）；本文件只留**路径**，`<img src>` 经
 * `apiUrl()` 拼前缀，换码只要替换那两个 PNG，不必重建客户端产物。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域）：纯数据、零依赖，
 * 必须保持浏览器安全（无 import / require / Node API）。
 */

// 项目仓库（README / package.json 的同一条地址）：关于页的按钮与可复制文本都用它。
const ABOUT_REPO_URL = "https://github.com/elysia395/dsh-wallpaper-engine";

// 两张二维码的**路由路径**（相对 BASE，交给 apiUrl 拼前缀）：
//   · QQ 群「DSHWE | LLM 讨论群」     → lib/about/qq-group.png
//   · 抖音群「dsh 交流群」            → lib/about/douyin-group.png
// 文件名与 lib/routes/about-qr.js 的白名单**逐字相同**（守卫两边对账）。
const ABOUT_QR_QQ_PATH = "/about-qr/qq-group.png";
const ABOUT_QR_DOUYIN_PATH = "/about-qr/douyin-group.png";
