/**
 * routes/settings.js — **插件设置**族路由：`GET/PUT /settings`。
 *
 * 端口无关的持久化，替代 localStorage：GET 回已存设置（从未存过则 null）＋ 两个**随响应带出**的
 * 旁路观测值；PUT 把规范化副本写进 `~/.dsh-wallpaper-engine/config.json`。这正是设置能跨
 * DSH Desktop 重启（新随机 `--port 0` 回环端口）与同机多浏览器 / 多设备存活的原因。
 *
 * 契约：`registerSettingsRoutes(webServer, c)`；`c` 里是这一族**用到但不属于它**的东西：
 *   · `disposers`            ← 清理句柄数组
 *   · `base`                 ← `/wallpaper-engine` 前缀
 *   · `ctx`                  ← 插件上下文（透传给 `isBetterSidebarLoaded(ctx)`）
 *   · `mediaOriginApi`       ← 适配器形态观测（GET 时 `observeAdapter` + `adapterState`）
 *   · `readSettings`         ← 读 `config.json` 现值
 *   · `isBetterSidebarLoaded`← 侧栏插件是否安装且启用（`betterSidebar` 字段）
 *   · `sanitizeSettings`     ← 白名单 / 派生校验（唯一真源见 `../settings-schema.js`）
 *   · `withLegacyFontValues` ← 字体迁移期护栏（磁盘老字体值不得被这次写入抹掉）
 *   · `writeSettings`        ← 串行化落盘（响应即已持久化）
 *   · `armBodyIdleTimeout`   ← 60s 无数据即超时（收体防挂）
 *   · `lingerClose`          ← 应答先发、排空后再断
 * 收体的 `bodyReader` 由本模块**自己 import**（不经 `c`，见 verify-body-caps 的逐文件断言）。
 *
 * 不变量：
 *   · **写路径只认 PUT**，其余非 GET 一律 405。
 *   · 收体三条：**有上限**（`SETTINGS_MAX_BYTES`）、**超时断开**（`armBodyIdleTimeout`）、
 *     **一次性解码**（`bodyReader.text()`，不逐块 `+=`）。
 *   · 落盘的永远是**规范化后**的值；非对象体 ⇒ 400，连 JSON 都解析不了 ⇒ 400。
 *   · `withLegacyFontValues` 是迁移期护栏，迁移落定后它自动失效（理由见其自身注释）——
 *     在本族里它必须**在** `writeSettings` 之前，不能绕过。
 */

import { bodyReader } from '../http-body.js';
// JSON 应答的**唯一实现**（状态码 + 两个头 + end）—— 见 lib/json-response.js。
import { sendJson } from '../json-response.js';

/** PUT body 上限：设置体是小的 JSON 对象，64KB 远超正常值。 */
const SETTINGS_MAX_BYTES = 64 * 1024;

export function registerSettingsRoutes(webServer, c) {
  const {
    disposers, base: BASE, ctx, mediaOriginApi,
    readSettings, isBetterSidebarLoaded, sanitizeSettings, withLegacyFontValues, writeSettings,
    armBodyIdleTimeout, lingerClose,
  } = c;

  // 7. Plugin settings (port-independent persistence replacing localStorage).
  //    GET returns the persisted settings (null when never saved); PUT stores
  //    a sanitized copy in ~/.dsh-wallpaper-engine/config.json. This is what
  //    keeps every setting across DSH Desktop restarts with a new random
  //    --port 0 loopback port, and across browsers/devices on the same host.
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/settings`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      // 薄别名：保留调用点写法，实现收敛到 lib/json-response.js（默认带 no-store）。
      const json = (code, payload) => sendJson(res, code, payload);
      if (method === 'GET') {
        // betterSidebar: 侧栏玻璃控制组是否显示（dsh-better-sidebar 已安装且
        // 启用）。挂在 settings 响应上，客户端 loadPersisted 时一次取回。
        // adapter: 本页面跑在哪种宿主形态里（观测值 fence/detected + 手选后的生效值），
        // 客户端据此挂 body[data-we-adapter]、门控外壳材质与失焦暂停。见 3c-0。
        mediaOriginApi.observeAdapter(req);
        json(200, {
          settings: readSettings(),
          betterSidebar: isBetterSidebarLoaded(ctx),
          adapter: mediaOriginApi.adapterState(),
        });
        return;
      }
      if (method !== 'PUT') {
        res.statusCode = 405; res.end('method not allowed'); return;
      }
      let tooLarge = false;
      // 中途放弃（超限 / 超时）走**同一处**断开收口：应答先写，再排空、等应答刷完才断。
      const fail = (code, payload) => {
        if (tooLarge) return;
        tooLarge = true;
        json(code, payload);
        lingerClose(req, res);
      };
      // 60s 无数据即超时（见 armBodyIdleTimeout）。
      armBodyIdleTimeout(req, () => fail(408, { error: 'request timeout' }));
      // 字节计上限 + 收完一次性解码 —— 唯一实现见 `lib/http-body.js`。
      // `fail()` 自己会置 `tooLarge`（见它的定义），`end` 那条早退因此保持不变。
      const reader = bodyReader(req, {
        maxBytes: SETTINGS_MAX_BYTES,
        onOverflow: () => fail(413, { error: 'settings payload too large' }),
      });
      req.on('data', reader.onData);
      req.on('end', () => {
        if (tooLarge) return;
        const body = reader.text();
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch {
          json(400, { error: 'invalid JSON body' }); return;
        }
        const sanitized = sanitizeSettings(parsed);
        if (!sanitized) {
          json(400, { error: 'settings must be a JSON object' }); return;
        }
        // 迁移前的护栏：字体值还没进字体集时，这次写入不得抹掉磁盘上的老字体值
        //（`withLegacyFontValues` 的完整理由见它的注释）。迁移落定后它自动失效。
        const persisted = withLegacyFontValues(sanitized);
        // 写已串行化（enqueueConfigWrite），等写盘完成再应答，保持原有
        // 「响应即已持久化」的语义。
        writeSettings(persisted).then(
          () => json(200, { ok: true, settings: persisted }),
          (err) => json(500, { error: String(err && err.message ? err.message : err) }),
        );
      });
      req.on('error', () => { if (!tooLarge) json(400, { error: 'request error' }); });
    },
  }));
}
