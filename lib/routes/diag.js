/**
 * routes/diag.js — **诊断族**路由：客户端渲染链路的落盘上报（`/client-diag`）与宿主的
 * 渲染页告警通道 / 读取（`/diag`、`/diag-log`）。P2-11 的第一族（账本 §3.5 的四步模板）。
 *
 * 为什么值得独立成文件：这一族与其余注册共享 `apply(ctx)` 的同一个闭包 —— 那里二十余个可变量
 * 交织在一起，"这条路由依赖什么"只能靠通读整个函数得出。独立成文件后，改诊断上报只需读这一个
 * 文件，而**依赖写在签名上**（`c`）。
 *
 * 契约：`registerDiagRoutes(webServer, c)`；`c` 里是这一族**用到但不属于它**的东西：
 *   · `disposers`       ← `apply` 的清理句柄数组；注册返回值必须推进去
 *   · `appendDiagLine`  ← `lib/index.js` 的模块级落盘函数（10 处调用，留在原地）
 *   · `base`            ← 路径前缀 `BASE`（宿主唯一的定义处；这里以别名 BASE 使用）
 * 族内状态（`diagLog` / `handleDiag`）随族搬走 —— 只被这一族使用，**不经过 context**。
 *
 * 不变量：
 *   · 注册顺序按原样：`/client-diag` → `/diag`（根路径）→ `/diag`（前缀）→ `/diag-log`；
 *   · `/diag` 两条**共用同一个 handleDiag**：渲染页按 `{mediaBase origin}/diag` 上报（根路径），
 *     而同一份产物里还有一条走前缀的通道，只挂一条会让"壁纸黑屏"时最关键的渲染页告警
 *     以 404 静默丢掉；
 *   · 注册返回值必须推进 `c.disposers`，否则卸载后路由仍挂着一个已释放的处理器；
 *   · `/client-diag` 的三条早退（非 POST 405 / 超 64KB 413 / 早退不落盘）由
 *     `scripts/verify-scene-live.mjs` 的 Level E 以真实请求钉住。
 */

export function registerDiagRoutes(webServer, c) {
  const { disposers, appendDiagLine, base: BASE } = c;
  // 3c-6. 客户端（浏览器半）行为上报：渲染链路的关键步骤落盘 —— 排查只在
  //       某个宿主环境出现的问题时，「走了哪条分支、在哪一步停下」比事后猜有用。
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/client-diag`,
    handler: (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') { res.statusCode = 405; res.end(); return; }
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > 64 * 1024) { done = true; res.statusCode = 413; res.end(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          appendDiagLine('client', {
            event: String(body.event || ''),
            type: String(body.type || ''),
            id: String(body.id || ''),
            detail: String(body.detail || '').slice(0, 300),
            src: String(body.src || '').slice(0, 200),
          });
        } catch { /* 坏 payload 忽略 */ }
        res.statusCode = 204;
        res.end();
      });
    },
  }));

  // 3c-7. Renderer diagnostics sink. WebWallGL's reportDiag() fires a pixel
  //       request at `{mediaBase origin}/diag?msg=…` — i.e. the ROOT path, not
  //       under BASE. Those messages are the only window into what happens
  //       inside the renderer page (shim injection failures, fallbacks to a
  //       bare iframe, sound-layer errors, …), which is exactly what a
  //       "wallpaper goes black" report needs. Keep a bounded ring buffer and
  //       mirror to the host log; a debug route lets us read it back.
  const diagLog = [];
  const handleDiag = (req, res) => {
    try {
      const u = new URL(req.url || '/diag', 'http://x');
      const msg = u.searchParams.get('msg') || '';
      if (msg) {
        diagLog.push({ t: Date.now(), msg });
        if (diagLog.length > 200) diagLog.shift();
        // 落盘：DSH Desktop 的运行日志不收录 host 的 stdout，而渲染页的内部告警
        //（shim 未注入 / 退回裸 iframe / 声音层失败…）是排查「壁纸黑屏」的关键，
        // 必须与 4xx 记录写进同一个可事后读取的文件。
        appendDiagLine('renderer', { msg: msg.slice(0, 300) });
        console.log(`[wallpaper-engine][renderer] ${msg}`);
      }
    } catch { /* ignore malformed */ }
    res.statusCode = 204;
    res.end();
  };
  // 渲染页按 `{mediaBase origin}/diag` 上报（根路径）；但同一份产物里还有一条
  // 走 `${BASE}/diag` 的通道 —— 两条都接上，否则「壁纸黑屏」时最关键的渲染页告警
  // 会以 404 静默丢掉（实测：排查本机黑屏时它们全部打在 ${BASE}/diag 上）。
  disposers.push(webServer.register({ kind: 'exact', path: '/diag', handler: handleDiag }));
  disposers.push(webServer.register({ kind: 'exact', path: `${BASE}/diag`, handler: handleDiag }));
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/diag-log`,
    handler: (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ entries: diagLog.slice(-80) }));
    },
  }));
}
