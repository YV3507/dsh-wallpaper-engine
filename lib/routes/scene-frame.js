/**
 * routes/scene-frame.js — **场景帧服务族**路由：静态帧 / GPU 抓帧缓存（`/scene-frame`、`/scene-frame-cache`）
 * 与自定义画面管理（`/custom-frame`）。P2-11 的第四族（账本 §3.5 的四步模板）。
 *
 * 为什么值得独立成文件：这三条路由是**帧缓存目录的读写双方** —— 一个写、一个读，且读的一方要按
 * 抓帧几何判"这张帧还是不是当前视口"。它们与其余二十余条注册共享 `apply(ctx)` 的同一个闭包时，
 * "缓存键谁构造、几何谁判定、并发写谁去重"只能靠通读整个函数得出。独立成文件后，这三个问题的答案
 * 都在一处，而**依赖写在签名上**（`c`）。
 *
 * 契约：`registerSceneFrameRoutes(webServer, c)`；`c` 里是这一族**用到但不属于它**的东西。
 * 帧缓存与自定义画面的**服务层**仍留在 `lib/index.js`：它们被 `/inventory`（`buildInventory`）、
 * `/scene-live`、`/scene-files` 与场景帧预热（P2-12 的删除对象）共用，且 `CUSTOM_FRAME_EXT` 是
 * `test/verify-contracts.mjs` 从 `lib/index.js` 读取的**跨半边契约表**。搬它们需要各自单独的一刀。
 *   · `disposers` / `base`        ← 清理句柄数组与路径前缀
 *   · `mediaMap`                   ← token → 绝对路径（12 条路由共用）
 *   · `trackStream` / `serveFile`   ← 流登记与静态发送（后者 10 条路由共用）
 *   · `sceneFrameSlot` / `gpuFrameFileFor` ← 槽位与 GPU 帧定位
 *   · `GPU_FRAME_MAX_BYTES` / `GPU_WRITE_INFLIGHT` ← 抓帧上限与按槽位的写去重
 *   · `pngSizeOf` / `looksLikePng` / `atomicWriteFileP` ← PNG 头解析、魔数校验、原子落盘
 *   · `customFrameDir` / `customFramePath` / `customIdFromAbs` / `CUSTOM_FRAME_EXT` / `CUSTOM_FRAME_MAX_BYTES`
 *   · `armBodyIdleTimeout` / `lingerClose` ← 请求体 idle 超时与"写应答后再断"的收尾
 *
 * 不变量：
 *   · **缓存键只有一处构造点**：`sceneFrameSlot` 复用 `sceneFrameCacheKey`，版本前缀只在后者里出现
 *     ⇒ 升版本才是一次改动（两处各拼一遍会让"写盘的产物"与"读取的路径"错位）。
 *   · **并发写去重**：`GPU_WRITE_INFLIGHT` 按槽位键登记在途写；已有在途写 ⇒ 409 `gpu-frame-exists`，
 *     释放时只删自己那一条（`if (get(key) === write) delete`），否则会把后到的写踢掉。
 *   · **原子发布**：GPU 帧一律经 `atomicWriteFileP` 落盘 —— 半写的 PNG 会被当成有效帧服务出去。
 *   · **几何即新鲜度**：已有 GPU 帧时，命中判定按 PNG 头读出的宽高比（`X-WE-GPU-AR`）与当前视口比
 *     较，不符即视为陈旧并重抓；判不了就当"未知几何"保留并留痕。
 *   · `/custom-frame` 的 id 只接受 `^[A-Za-z0-9_-]{1,64}$`（路径分隔符与 `..` 进不来），
 *     写盘走 `.tmp` + rename，失败路径由 `lingerClose` 收尾（先写应答、再排空、等刷完才断）。
 *   · **更换格式即清兄弟**：写 `id.<ext>` 之前先删同 id 的其它扩展名，否则旧文件会被优先命中。
 *   · 注册返回值必须推进 `c.disposers`，否则卸载 / HMR 后路由仍挂着已释放的处理器。
 */

import { createReadStream, createWriteStream, existsSync, renameSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function registerSceneFrameRoutes(webServer, c) {
  const {
    disposers, base: BASE, mediaMap, trackStream, serveFile,
    GPU_FRAME_MAX_BYTES, GPU_WRITE_INFLIGHT,
    CUSTOM_FRAME_EXT, CUSTOM_FRAME_MAX_BYTES,
    armBodyIdleTimeout, atomicWriteFileP, customFrameDir, customFramePath, customIdFromAbs,
    gpuFrameFileFor, lingerClose, looksLikePng, pngSizeOf, sceneFrameSlot,
  } = c;

  // 出图来源（**唯一权威顺序**，账本 §6.6）：**实时抓帧**（`<key>_gpu.png`，由 live 渲染页
  // PUT 回填）优先；没有抓帧时回落到**用户导入的自定义画面**（`overrides/<id>.*`）；两者都没有
  // ⇒ 404（客户端走「空」态，状态行给出可判定原因）。
  // ⚠️ 这里**没有**「替作者猜一张图」的来源：静态帧提取 / 合成 / 找最大图片 / 预览图都已随 P2-12
  // 移除 —— 它们能"成功"产出一张糊图，比诚实留空更糟（账本 §6.4 的静默回落陷阱）。
  // 档位值域只剩 `{0 = 自动（求链头）, 4 = 强制自定义画面}`；`1/2/3` 与越界值一律 **clamp 到 0**
  //（值域里的洞有意保留：让"哪些档已退役"在数据里可读，且避免值域迁移）。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/scene-frame`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405; res.end('method not allowed'); return;
      }
      const pathname = new URL(req.url || '/', 'http://x').pathname;
      const token = decodeURIComponent(pathname.slice(`${BASE}/scene-frame/`.length));
      const abs = mediaMap.get(token);
      if (!abs) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'unknown-token' }));
        return;
      }
      const vRaw = Number(new URL(req.url || '/', 'http://x').searchParams.get('v') || 0);
      const variant = vRaw === 4 ? 4 : 0;
      const slot = sceneFrameSlot(abs, variant);
      // `v=4` **豁免** GPU 抓帧：它是用户显式 pin 的来源，不被一张抓帧顶掉（§6.2/§6.7）。
      const gpuFile = variant === 4 ? null : gpuFrameFileFor(abs, variant, slot);
      const customFile = () => {
        const p = customFramePath(customIdFromAbs(abs));
        return p && existsSync(p) ? p : null;
      };
      // HEAD：纯磁盘探测（绝不触发任何生成）—— 抓帧回填的客户端按它决定要不要抓帧：
      // 204 + `X-WE-GPU: 1`（已有抓帧，附 W/H/AR 几何头）· 204 + `0`（只有自定义画面）· 404 空槽。
      if (method === 'HEAD') {
        const file = gpuFile || customFile();
        if (!file) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'no-frame' }));
          return;
        }
        res.statusCode = 204;
        res.setHeader('X-WE-GPU', gpuFile ? '1' : '0');
        if (gpuFile) {
          // 抓帧几何（读 PNG 头，见 pngSizeOf）：客户端据此判断这张帧还是不是**当前视口**的构图
          // —— 不是就清掉按当前视口重抓（否则别的窗口/旧会话留下的帧会被 CSS cover 再裁一次）。
          const dim = pngSizeOf(gpuFile);
          if (dim) {
            res.setHeader('X-WE-GPU-W', String(dim.width));
            res.setHeader('X-WE-GPU-H', String(dim.height));
            res.setHeader('X-WE-GPU-AR', (dim.width / dim.height).toFixed(4));
          }
        }
        res.end();
        return;
      }
      const servePath = gpuFile || customFile();
      if (!servePath) {
        // 终端的语义分两种：`v=4` 是用户显式 pin 的来源失效（422，客户端要明示"自定义画面已失效"）；
        // 自动档则是诚实的"空"（404，客户端走 ⑤）。
        res.statusCode = variant === 4 ? 422 : 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: variant === 4 ? 'no-custom-frame' : 'no-frame' }));
        return;
      }
      res.setHeader('Content-Type', servePath.endsWith('.jpg') ? 'image/jpeg'
        : servePath.endsWith('.gif') ? 'image/gif'
          : servePath.endsWith('.webp') ? 'image/webp' : 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      trackStream(createReadStream(servePath), res);
    },
  }));

  // 3a-gpu. Live GPU 抓帧回填：PUT /scene-frame-cache/<token> —— live 渲染页
  //     首帧确认后由客户端抓渲染 canvas（preserveDrawingBuffer:true，父页面同源
  //     直读，无需渲染页配合）写回静态帧缓存。GPU 帧存独立的 <key>_gpu.png
  //     （文件名即标记，可直接打开查看）；serve 优先级高于 CPU 提取帧。
  //     缓存唯一性：_gpu.png 已存在 → 409（每壁纸一份，不反复生成），写入在
  //     同 key 临界区内串行（并发 PUT 不会双双通过）。
  //     清除通道：DELETE（或 POST ?clear=1）删掉 _gpu.png —— 抓到黑帧/想要
  //     重新抓取时的唯一出路，删后 HEAD 回到 X-WE-GPU=0、PUT 可再写一次。
  //     token 白名单 = mediaMap，与 scene-frame 同一缓存键（档 0）。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/scene-frame-cache`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', 'http://x');
      const json = (code, payload) => {
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      };
      let token = '';
      try {
        token = decodeURIComponent(url.pathname.slice(`${BASE}/scene-frame-cache/`.length));
      } catch {
        json(404, { error: 'unknown-token' }); return;
      }
      // DELETE 与 POST ?clear=1 等价（POST 是框架确定放行的方法，DELETE 实测
      // 前缀路由同样可达；两者都提供，避免依赖单一方法的可达性）。
      const wantsClear = method === 'DELETE' || (method === 'POST' && url.searchParams.get('clear') === '1');
      if (wantsClear) {
        const abs = mediaMap.get(token);
        if (!abs) { json(404, { error: 'unknown-token' }); return; }
        const slot = sceneFrameSlot(abs, 0);
        let removed = false;
        try { unlinkSync(slot.gpuPath); removed = true; }
        catch (e) {
          // ENOENT = 本来就没有（幂等成功）；EACCES/EBUSY/EPERM 等 = **真的没删掉**，
          // 必须报错：否则客户端把「清除」当成功（面板行消失、提示已清除），而宿主
          // 照旧发 GPU 帧 —— 画面纹丝不动且没有任何反馈（评审 P2-L）。
          if (!e || e.code !== 'ENOENT') {
            json(500, { ok: false, removed: false, error: 'unlink-failed', code: (e && e.code) || '' });
            return;
          }
        }
        json(200, { ok: true, removed });
        return;
      }
      if (method !== 'PUT') { json(405, { error: 'method not allowed' }); return; }
      const abs = mediaMap.get(token);
      if (!abs) { json(404, { error: 'unknown-token' }); return; }
      const chunks = [];
      let size = 0;
      let failed = false;
      const fail = (code, payload) => {
        if (failed) return;
        failed = true;
        json(code, payload);
        lingerClose(req, res);
      };
      armBodyIdleTimeout(req, () => fail(408, { error: 'request timeout' }));
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (size > GPU_FRAME_MAX_BYTES) { fail(413, { error: 'frame too large' }); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (failed) return;
        const body = Buffer.concat(chunks);
        // GPU 抓帧统一 PNG（客户端 canvas.toBlob('image/png')）：签名 + IHDR +
        // IEND + 长度下限，避免 9 字节假 PNG 永久占槽。
        if (!looksLikePng(body)) { json(415, { error: 'unsupported-format' }); return; }
        const slot = sceneFrameSlot(abs, 0);
        // 唯一性闸与写盘同一临界区（按缓存键串行）：并发 PUT 只有一个能写，
        // 其余拿到 409（评审实测：无锁时两个 24MB PUT 都会 200）。
        const prev = GPU_WRITE_INFLIGHT.get(slot.key) || Promise.resolve();
        const write = prev
          .catch(() => { /* 前序失败不影响本次判定 */ })
          .then(async () => {
            if (existsSync(slot.gpuPath)) return { code: 409, payload: { error: 'gpu-frame-exists' } };
            await atomicWriteFileP(slot.gpuPath, body);
            return { code: 200, payload: { ok: true, bytes: body.length } };
          });
        GPU_WRITE_INFLIGHT.set(slot.key, write);
        write
          .then((r) => json(r.code, r.payload))
          .catch((err) => json(500, { error: String(err && err.message ? err.message : err) }))
          .finally(() => {
            if (GPU_WRITE_INFLIGHT.get(slot.key) === write) GPU_WRITE_INFLIGHT.delete(slot.key);
          });
      });
    },
  }));

  // 自定义画面管理：POST 导入（raw body，MIME 白名单，30MB 上限）/
  // GET 查看 / DELETE 清除；scene-frame ?v=4 消费同一 overrides 目录。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/custom-frame`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      const pathname = new URL(req.url || '/', 'http://x').pathname;
      const id = decodeURIComponent(pathname.slice(`${BASE}/custom-frame/`.length)).replace(/\/+$/, '');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'bad-id' }));
        return;
      }
      if (method === 'GET') {
        const p = customFramePath(id);
        if (!p) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'not-set' }));
          return;
        }
        serveFile(p, req, res, false);
        return;
      }
      if (method === 'DELETE') {
        let removed = false;
        for (const e of ['png', 'jpg', 'webp']) {
          try { unlinkSync(join(customFrameDir(), id + '.' + e)); removed = true; } catch { /* ignore */ }
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, removed }));
        return;
      }
      if (method !== 'POST') {
        res.statusCode = 405; res.end('method not allowed'); return;
      }
      const ctype = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = CUSTOM_FRAME_EXT[ctype];
      if (!ext) {
        res.statusCode = 415;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: '不支持的格式：' + ctype + '（仅支持 JPG / PNG / WebP）' }));
        return;
      }
      const dir = customFrameDir();
      for (const e of ['png', 'jpg', 'webp']) {
        if (e !== ext) { try { unlinkSync(join(dir, id + '.' + e)); } catch { /* ignore */ } }
      }
      const target = join(dir, id + '.' + ext);
      const tmpAbs = target + '.tmp';
      const ws = createWriteStream(tmpAbs);
      let size = 0;
      let failed = false;
      const cleanupTmp = () => { try { unlinkSync(tmpAbs); } catch { /* ignore */ } };
      const fail = (code, payload) => {
        if (failed) return;
        failed = true;
        try { ws.destroy(); } catch { /* ignore */ }
        res.statusCode = code;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
        lingerClose(req, res);
      };
      ws.on('error', () => fail(500, { error: 'write failed' }));
      ws.on('close', () => { if (failed) cleanupTmp(); });
      armBodyIdleTimeout(req, () => fail(408, { error: 'request timeout' }));
      req.on('data', (c) => {
        if (failed) return;
        size += c.length;
        if (size > CUSTOM_FRAME_MAX_BYTES) { fail(413, { error: '图片过大（上限 30MB）' }); return; }
        if (!ws.write(c)) req.pause();
      });
      ws.on('drain', () => { if (!failed) req.resume(); });
      req.on('end', () => {
        if (failed) return;
        ws.end(() => {
          try { renameSync(tmpAbs, target); } catch { fail(500, { error: 'publish failed' }); return; }
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: true, id, bytes: size }));
        });
      });
    },
  }));
}
