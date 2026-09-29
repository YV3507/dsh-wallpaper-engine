/**
 * routes/scene-serve.js — **场景载荷服务族**路由：live 渲染页（`/scene-live`）、壁纸自有文件
 * （`/scene-files`）与媒体源诊断（`/media-origin`）。P2-11 的第五族（账本 §3.5 的四步模板）。
 *
 * 为什么值得独立成文件：这三条路由回答同一个问题 —— **渲染页与壁纸载荷从哪个源、经哪条路径出去**
 * （同源应用源 / 我们自监听的第二个 loopback 端口）。它们与媒体源服务的构造交织在同一个闭包里，
 * 改一条路径要先在几千行里找齐三四段。独立成文件后，"哪条路径服务什么、围栏在哪"都在一处，
 * 而**依赖写在签名上**（`c`）。
 *
 * 契约：`registerSceneServeRoutes(webServer, c)`；`c` 里是这一族**用到但不属于它**的东西：
 *   · `disposers` / `base`            ← 清理句柄数组与路径前缀
 *   · `WEBWALLGL_DIR`                  ← vendored 渲染页根目录（`/scene-live` 的目录围栏基准）
 *   · `traceRequests`                  ← 逐请求记录（应用源；媒体源那条在 handleSceneFiles 内）
 *   · `serveFile`                      ← 静态发送器（Range / HEAD / 缓存头）
 *   · `appendDiagLine`                 ← 围栏拒绝的落盘留痕
 *   · `log`                            ← `lib/log.js` 的宿主日志入口（围栏拒绝按 `warn` 分级）
 *   · `handleSceneFiles`               ← `/scene-files` 的**共用处理函数**（两处挂载：应用源 + 媒体源）
 *   · `mediaOriginInfo`                ← 媒体源地址与端口的**访问器**
 * 媒体源服务本身（`handleSceneFiles` / `ensureMediaOrigin` / `mediaOrigin*`）留在 `lib/index.js`：
 * `/inventory` 也消费 `mediaOriginBase()`（给网页壁纸拼 media/preview 前缀），而 `mediaOrigin`
 * 是那个作用域的**可变量** ⇒ 只能以函数/访问器形式出去，传值就是陈旧快照。
 *
 * 不变量：
 *   · **两处挂载共用同一段处理逻辑**（`handleSceneFiles(req, res, mount)`）：应用源与媒体源的行为
 *     必须一致（目录围栏 / CORS / shim+seed 注入 / Range）；`mount` **只**影响请求记录 ——
 *     应用源逐请求全记（量小），媒体源只记文档型请求与错误（网页壁纸子资源太多，全量会冲掉诊断环）。
 *   · **目录围栏**：`/scene-live` 只在 `WEBWALLGL_DIR` 内、`/scene-files` 只在壁纸目录内解析目标；
 *     越界一律 403 **且带自解释文案 + appendDiagLine 留痕**（用户截图即可定位，不必先看日志）。
 *   · **缓存头分型**：`/scene-live` 的哈希名资源 immutable（一年），`index.html` 必须 no-store
 *     —— 上游同步会换掉它携带的哈希引用；`/scene-files` 一律 no-store（壁纸内容随时可被用户改）。
 *   · `OPTIONS` 由 `handleSceneFiles` 直接放行（媒体源上的跨源 fetch + Range 预检）。
 *   · 注册返回值必须推进 `c.disposers`，否则卸载 / HMR 后路由仍挂着已释放的处理器。
 */

import { resolve, sep } from 'node:path';

export function registerSceneServeRoutes(webServer, c) {
  const {
    disposers, base: BASE, WEBWALLGL_DIR, appendDiagLine, traceRequests, serveFile,
    handleSceneFiles, mediaOriginInfo, log,
  } = c;

  // 3c-2. WebWallGL live renderer page, vendored into lib/webwallgl/ by
  //       test/tools/sync-webwallgl.mjs (built with --base=/wallpaper-engine/
  //       scene-live/ so its absolute asset references resolve under this
  //       prefix). Same-origin and NOT sandboxed: the parent page drives it
  //       through frame.contentWindow.__wp / __wpStats, and backdrop-filter
  //       (liquid glass) can sample the composited output. Scene scripts stay
  //       confined inside WebWallGL's own SceneScript sandbox.
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/scene-live`,
    handler: (req, res) => {
      traceRequests(res, 'scene-live', new URL(req.url || '/', 'http://x').pathname);
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      let rest = '';
      try {
        rest = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname.slice(`${BASE}/scene-live`.length));
      } catch {
        res.statusCode = 400; res.end('bad request'); return;
      }
      rest = rest.replace(/^\/+/, '');
      if (!rest || rest.endsWith('/')) rest += 'index.html';
      const abs = resolve(WEBWALLGL_DIR, rest);
      // Directory fence: nothing outside the vendored tree is ever served.
      if (abs === WEBWALLGL_DIR || !abs.startsWith(WEBWALLGL_DIR + sep)) {
        // 自解释的 403：谁被拦、从哪来。这行文字会直接显示在壁纸层上 —— 用户
        // 截图即可定位（历史上「网页壁纸黑屏、左上角 forbidden」就是这条）。
        appendDiagLine('fence', { route: 'scene-live', rest: rest.slice(0, 160), referer: String(req.headers.referer || '').slice(0, 120), dest: req.headers['sec-fetch-dest'] || '' });
        // 围栏拒绝 = 有请求被挡下 ⇒ 影响显示效果的非正常表现 ⇒ warn。
        log.warn(`scene-live fenced: rest="${rest}" referer="${req.headers.referer || '-'}" ua-iframe=${req.headers['sec-fetch-dest'] || '-'}`);
        res.setHeader('Cache-Control', 'no-store');
        res.statusCode = 403; res.end(`forbidden-scene-live[${rest}]`); return;
      }
      // Hash-named assets are immutable; index.html must revalidate (an
      // upstream sync changes the hashed references it carries).
      res.setHeader('Cache-Control', rest === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
      serveFile(abs, req, res, method === 'HEAD');
    },
  }));

  // 3c-3. 应用源挂载：渲染页（同源非沙箱 frame）取 scene.pkg / project.json。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/scene-files`,
    handler: (req, res) => handleSceneFiles(req, res, 'app'),
  }));

  // 3c-3b. 诊断：上报媒体源地址（verify 脚本与用户截图都能一眼看出网页壁纸
  //        到底从哪个源加载）。端口来自 `lib/index.js` 的可变量 ⇒ 只经访问器取。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/media-origin`,
    handler: (req, res) => {
      mediaOriginInfo().then((info) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(info));
      });
    },
  }));
}
