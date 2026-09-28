#!/usr/bin/env node
/**
 * compat-harness-pages.mjs —— 档位 2：无头浏览器**逐页 DOM / 样式断言**（compat 层，
 * 不进 `npm run verify` 链；由 `.github/workflows/harness-compat.yml` 在真 harness 上调用）。
 *
 * 与档位 1（compat-harness-surfaces：包级清单棘轮）的分工：包名没变、**包内结构变了**
 * 导致我们的美化失效，清单查不出来 —— 本脚本把页面真正渲染出来，对**计算样式**下判据。
 *
 * 走的页面与判据：
 *   ① 首页（引导弹窗消完、会话未开）：插件 client 活着（主样式标签在场、内容是当前
 *      CSS）、body 玻璃锚点与 --we-* 变量落位、我们自己的 UI 入口（拉绳）在场；
 *   ② 会话页：点得到「新建会话」且 `main.conversation` / `rightbar` slot 真的挂出来
 *      （第二页可达），插件样式与错误卫生在换页后仍成立；
 *   ③ 设置页（**核心探针**）：设置 dialog 的 `:has([data-slot="settings.section"])`
 *      锚点在场，且它身上的**计算样式是我们的** —— backdrop blur、独有 sheen 渐变、
 *      `--dsw-alias-bg-layer-1` 被我们替换成 --we-glass-color 的值。harness 改了
 *      dialog 结构 / slot 改名 ⇒ 锚点选择器落空 ⇒ 三条全红（#107 型回归的页面级抓手）；
 *   ④ 设置五个分区逐个点（通用/模型/插件/Agent 预设/Wallpaper Engine）：每页 dialog
 *      仍开、我们的样式仍在场、不新增指向本插件的运行期错误；
 *   ⑤ 右栏 panel：由 harness 内部状态门控（会话态下占据者仍可能不渲染），**在场才判**
 *      （展开 → open 属性 → 开态玻璃），缺席只记信息不判红 —— 包级/页面级两条线已覆盖它。
 *
 * 鉴权：dsh web 是 token → 303 + Set-Cookie；浏览器自带 cookie 处理，直接导航 token URL。
 * 弹窗：启动期挡路 dialog 用**结构化消法**（单按钮 dialog 直接点；多按钮按跳过型白名单
 * 文案点，`--lang=zh-CN` 钉住文案），并排除设置 dialog（点它的「关闭」会把设置关掉）。
 *
 * 前置：已安装的 harness（沿用隔离 HOME / DSH_WE_DATA_DIR 约定）+ Chromium 系浏览器。
 * 缺浏览器 = 默认红（`--allow-skip` 显式接受不跑，P3-13 口径）。
 * `--dump` = 探查模式：把页面原始观测全打出来（写断言前先看这里，不判红绿）。
 * CDP 走 Node ≥22 的全局 WebSocket，零依赖（消息 = JSON 文本帧）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CACHE = join(ROOT, '.test-cache', 'compat');
const ISO_HOME = join(CACHE, 'home');
const DATA_DIR = join(ISO_HOME, '.dsh-wallpaper-engine');
const BROWSER_LOG = join(CACHE, 'pages-browser.log');
const HARNESS_LOG = join(CACHE, 'pages-harness.log');
const PROFILE_DIR = join(CACHE, 'pages-chrome-profile');
const STYLE_SEL = 'style[data-plugin-css="dsh-wallpaper-engine/styles-v3"]';
const SETTINGS_DIALOG = '[role="dialog"]:has([data-slot="settings.section"])';

const argv = process.argv.slice(2);
const DUMP = argv.includes('--dump');
const ALLOW_SKIP = argv.includes('--allow-skip');
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', process.env.DSH_WE_COMPAT_PAGES_PORT || 5200));

const childEnv = {
  ...process.env,
  HOME: ISO_HOME,
  USERPROFILE: ISO_HOME,
  DSH_WE_DATA_DIR: DATA_DIR,
  DSH_WE_UPLOAD_DIR: join(CACHE, 'upload'),
  DSH_WE_CACHE_DIR: join(CACHE, 'cache'),
  DSH_WE_STEAM_ROOT: join(CACHE, 'steam'),
  DSH_WE_MEDIA_LEGACY: '1',
};

const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  return Boolean(ok);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 25) => String(s).split('\n').slice(-n).join('\n');

// win32：`dsh` / 浏览器都是 .cmd / .exe 垫片链，Node ≥18 在 shell:false 下拒绝启动 .cmd。
const spawnTool = (cmd, args, opts = {}) =>
  spawn(cmd, args, { ...opts, shell: process.platform === 'win32' });

function get(url) {
  return new Promise((res) => {
    const u = new URL(url);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 5000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => res({ status: 0, body: String(e.message) }));
    req.on('timeout', () => { req.destroy(); res({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

async function waitUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }
  }
  await waitUntil(async () => child.exitCode !== null || child.signalCode !== null, 10000, 200);
  if (child.exitCode === null && child.signalCode === null && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
  }
}

async function runTool(cmd, args, { timeoutMs = 300000 } = {}) {
  const child = spawnTool(cmd, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let settled = false;
  return new Promise((res) => {
    const done = (code) => { if (!settled) { settled = true; clearTimeout(t); res({ code, out }); } };
    const t = setTimeout(() => {
      out += '\n[timeout]\n';
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done(124);
    }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('error', (e) => { out += String(e.stack || e); done(127); });
    child.on('exit', (code) => done(code ?? 1));
  });
}

// ── 零依赖 CDP 客户端 ────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => this.#on(JSON.parse(String(ev.data)));
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new Cdp(ws));
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败：' + url));
    });
  }
  #on(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej, hint } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(hint + ': ' + msg.error.message));
      else res(msg.result);
    } else if (msg.method) {
      for (const fn of this.listeners) fn(msg);
    }
  }
  onEvent(fn) { this.listeners.push(fn); }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, hint: method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

// ── 浏览器候选（与 e2e-web-media-origin 同源的清单）──────────────────────────
const CANDIDATES = process.platform === 'win32' ? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
] : process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] : [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

const TOKEN_RE = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s'"<>]+)/;

// 挡路弹窗的跳过型白名单（--lang=zh-CN 钉住文案；绝不能包含「保存并继续」这类
// 把流程带进配置向导的按钮）。
const DISMISS_EXPR = `(() => {
  const SETTINGS = '${SETTINGS_DIALOG}';
  const SAFE = ['稍后配置', '继续', '知道了', '关闭', '跳过', 'Got it', 'Continue', 'Skip', 'Later', 'Configure later', 'Close'];
  for (const d of [...document.querySelectorAll('[role="dialog"]')]) {
    if (d.matches(SETTINGS) || d.querySelector('[data-slot="settings.section"]')) continue;
    const btns = [...d.querySelectorAll('button')];
    if (btns.length === 1) { btns[0].click(); return 1; }
    const safe = btns.find((b) => SAFE.includes((b.textContent || '').trim()));
    if (safe) { safe.click(); return 1; }
  }
  return 0;
})()`;

async function main() {
  for (const d of [ISO_HOME, DATA_DIR, childEnv.DSH_WE_UPLOAD_DIR, childEnv.DSH_WE_CACHE_DIR, childEnv.DSH_WE_STEAM_ROOT, CACHE]) {
    mkdirSync(d, { recursive: true });
  }

  const browserPath = CANDIDATES.find((p) => existsSync(p));
  if (!check('Chromium 系浏览器可定位', Boolean(browserPath),
    browserPath || '未找到（本地可加 --allow-skip 显式接受不跑）')) {
    if (ALLOW_SKIP) { console.log('  ⛔ 页面断言未执行（--allow-skip）'); process.exit(0); }
    process.exit(1);
  }

  // 隔离先于一切：不成立绝不继续（否则 dsh plugin add 会改到真实 ~/.dsh）。
  const iso = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'],
    { env: childEnv, encoding: 'utf8' });
  if (!check('隔离 HOME 对子进程生效', iso.status === 0 && resolve(String(iso.stdout)) === resolve(ISO_HOME),
    iso.status === 0 ? String(iso.stdout) : '退出 ' + iso.status)) return;

  const add = await runTool('dsh', ['plugin', '--profile', 'web', 'add', 'link:' + ROOT]);
  if (!check('dsh plugin add 装载本插件（退出码 0）', add.code === 0,
    add.code === 0 ? undefined : '退出 ' + add.code + '\n' + tail(add.out))) return;

  // ── 起 harness（port 默认 5200，与 live 探活错开）──────────────────────────
  const harness = spawnTool('dsh', ['--profile', 'web', '--no-open', '--port', String(PORT)], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let hout = '';
  const hsink = createWriteStream(HARNESS_LOG, { flags: 'w' });
  harness.stdout.on('data', (b) => { hout += b; hsink.write(b); });
  harness.stderr.on('data', (b) => { hout += b; hsink.write(b); });
  harness.on('error', (e) => { hout += String(e.stack || e); });

  const tokenHit = await waitUntil(async () => {
    if (harness.exitCode !== null || harness.signalCode !== null) return 'dead';
    const m = hout.match(TOKEN_RE);
    return m ? m : null;
  }, 120000);
  if (!tokenHit || tokenHit === 'dead') {
    check('harness 启动并输出 token URL', false,
      tokenHit === 'dead' ? '进程提前退出\n' + tail(hout) : '120s 未见 token URL\n' + tail(hout));
    await killTree(harness);
    return;
  }
  const pageUrl = `http://127.0.0.1:${tokenHit[1]}/?token=${tokenHit[2]}`;
  check('harness 启动并输出 token URL', true, 'port=' + tokenHit[1]);

  // ── 起无头浏览器（CDP 端口 0 → DevToolsActivePort 文件回读，免端口抢占）─────
  rmSync(PROFILE_DIR, { recursive: true, force: true });
  mkdirSync(PROFILE_DIR, { recursive: true });
  // 浏览器是真 .exe ⇒ **绝不走 shell**：win32 上 shell:true 会把命令交给 cmd 解析，
  // `C:/Program Files/...` 在空格处被切断（CI 实测 'C:/Program' is not recognized）。
  // shell:true 只为 dsh 的 .cmd 垫片保留（本文件其余 spawnTool 调用都是它）。
  const browser = spawn(browserPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE_DIR}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-ping',
    '--enable-unsafe-swiftshader',
    '--lang=zh-CN',
    '--window-size=1440,900',
    'about:blank',
  ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const bsink = createWriteStream(BROWSER_LOG, { flags: 'w' });
  browser.stdout.on('data', (b) => bsink.write(b));
  browser.stderr.on('data', (b) => bsink.write(b));
  browser.on('error', (e) => bsink.write(String(e.stack || e)));

  const portFile = join(PROFILE_DIR, 'DevToolsActivePort');
  const portHit = await waitUntil(async () => {
    if (browser.exitCode !== null || browser.signalCode !== null) return 'dead';
    if (!existsSync(portFile)) return null;
    const first = readFileSync(portFile, 'utf8').split('\n')[0];
    return first && /^\d+$/.test(first) ? Number(first) : null;
  }, 20000, 300);
  if (!check('浏览器 CDP 端口就绪（DevToolsActivePort）', Boolean(portHit) && portHit !== 'dead',
    portHit === 'dead' ? '浏览器进程提前退出\n' + tail(existsSync(BROWSER_LOG) ? readFileSync(BROWSER_LOG, 'utf8') : '')
      : portHit ? 'port=' + portHit : '20s 未见端口文件')) {
    await killTree(browser);
    await killTree(harness);
    return;
  }

  let cdp = null;
  let sessionId = '';
  const pageErrors = [];
  try {
    const ver = await get(`http://127.0.0.1:${portHit}/json/version`);
    const wsUrl = JSON.parse(ver.body).webSocketDebuggerUrl;
    cdp = await Cdp.connect(wsUrl);
    cdp.onEvent((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        pageErrors.push(String((d.exception && d.exception.description) || d.text || 'exception'));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        pageErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Runtime.enable', {}, sessionId);

    const ev = async (expression) => {
      try {
        const r = await cdp.send('Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) {
          return { error: String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text) };
        }
        return { value: r.result.value };
      } catch (e) { return { error: String(e.message) }; }
    };
    const evS = async (expression) => { const r = await ev(expression); return r.error === undefined ? r.value : null; };
    const waitEv = (expression, timeoutMs = 10000, intervalMs = 300) =>
      waitUntil(async () => {
        const v = await evS(expression);
        return v ? { v } : null;
      }, timeoutMs, intervalMs);
    const dismissBlockers = async (rounds) => {
      let total = 0;
      for (let i = 0; i < rounds; i++) {
        const n = await evS(DISMISS_EXPR);
        total += Number(n) || 0;
        if (!n) break;
        await sleep(700);
      }
      return total;
    };

    // ── 导航：浏览器自带 cookie 处理（token → 303 → 应用）───────────────────
    // 就绪判据必须锚在 http: 文档上 —— about:blank 的 readyState 也是 complete，
    // 只看 readyState 会在导航提交前就误判就绪。
    await cdp.send('Page.navigate', { url: pageUrl }, sessionId);
    const ready = await waitEv('location.protocol === "http:" && document.readyState === "complete" ? 1 : 0', 30000, 500);
    if (!check('应用页面加载完成（readyState=complete）', Boolean(ready), '30s 超时\n' + tail(hout))) return;
    await sleep(2500); // SPA 挂载与插件 effect 挂载的沉降

    // ── 首页原始观测 ────────────────────────────────────────────────────────
    const observed = await ev(`(() => {
      const body = document.body;
      const ourTag = document.querySelector(${JSON.stringify(STYLE_SEL)});
      return {
        url: location.href,
        title: document.title,
        bodyAttrs: [...body.attributes].map((a) => a.name + '=' + a.value),
        ourStyle: Boolean(ourTag),
        ourStyleLen: ourTag ? (ourTag.textContent || '').length : 0,
        cssVars: {
          weAccent: getComputedStyle(body).getPropertyValue('--we-accent').trim().slice(0, 40),
          weGlassColor: getComputedStyle(body).getPropertyValue('--we-glass-color').trim().slice(0, 40),
        },
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
          text: (d.textContent || '').trim().slice(0, 60),
          buttons: [...d.querySelectorAll('button')].map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 16)),
        })),
        rope: Boolean(document.querySelector('.we-rope')),
        headings: [...document.querySelectorAll('h1, h2')].slice(0, 6).map((h) => h.textContent.trim().slice(0, 30)),
      };
    })()`);
    if (observed.error) console.log('观测表达式出错：' + observed.error);
    const o = (observed && observed.value) || {};

    // ── 交互链 A：消启动弹窗 → 选会话 → 会话页（换页后样式/错误仍成立）────────
    const flow = {};
    flow.noticeDismissed = await evS(
      `(() => { const b = document.querySelector('.we-update-notice__btn'); if (b) b.click(); return b ? 1 : 0; })()`);
    flow.blockersBeforeSession = await dismissBlockers(3);
    flow.sessionPicked = await evS(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) =>
        /newSession/.test(String(x.className))
        || (x.getAttribute('aria-label') || '').includes('新建会话')
        || (x.textContent || '').trim() === '新建会话');
      if (!b) return 0; b.click(); return 1;
    })()`);
    // 会话页到达的判据 = slot 锚点（比视觉元素稳定）：main.conversation 挂出即第二页可达。
    flow.conversationOpen = Boolean(await waitEv(`(() => {
      const slots = new Set([...document.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot')));
      return slots.has('main.conversation') && slots.has('rightbar') ? 1 : 0;
    })()`, 12000, 400));
    flow.blockersAfterSession = await dismissBlockers(2);

    // 右栏 panel（在场才判）：harness 内部状态门控，缺席只记信息。
    flow.panelMounted = await evS(`document.querySelector('[data-sidebar-right-panel]') ? 1 : 0`) === 1;
    if (flow.panelMounted) {
      // 展开入口挂在会话头部、**异步后到** —— 快照取样会抢在按钮渲染之前（CI 实测 expand=0
      // 假红）。改成轮询：等到「已开 / 找到 expand 并点掉」之一才继续；8s 仍等不到才是真改入口。
      const opener = await waitEv(`(() => {
        const p = document.querySelector('[data-sidebar-right-panel]');
        if (!p) return 0;
        if (p.hasAttribute('data-sidebar-right-open')) return 'open';
        const b = document.querySelector('[data-sidebar-right-expand]');
        if (b) { b.click(); return 'clicked'; }
        return 0;
      })()`, 8000, 400);
      flow.expandFound = opener ? opener.v : 0;
      if (opener && opener.v === 'open') {
        flow.opened = true;
      } else if (opener) {
        flow.opened = Boolean(await waitEv(
          `document.querySelector('[data-sidebar-right-panel]') && document.querySelector('[data-sidebar-right-panel]').hasAttribute('data-sidebar-right-open') ? 1 : 0`,
          8000, 300));
      } else {
        flow.opened = false;
        // 入口缺席的归因：展开按钮住在 conversation.session.header.corner ——
        // 头部槽位整个没渲染 = 视图态（判据不取样、记信息）；头部在而按钮不在 = 锚点改名（判红）。
        flow.openerDiag = await evS(`(() => {
          const slots = [...document.querySelectorAll('[data-slot]')].map((el) => el.getAttribute('data-slot'));
          return {
            headerCorner: slots.includes('conversation.session.header.corner'),
            slotTail: slots.filter((s) => /conversation|header|hero/.test(s)),
            expandInDoc: document.querySelectorAll('[data-sidebar-right-expand]').length,
            panelButtons: document.querySelectorAll('[data-sidebar-right-toggle], [data-sidebar-right-mode]').length,
          };
        })()`);
      }
      if (flow.opened) {
        flow.panelGlass = await evS(`(() => {
          const p = document.querySelector('[data-sidebar-right-panel]');
          if (!p) return null;
          const cs = getComputedStyle(p);
          return { backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '', bg: (cs.backgroundImage || '').slice(0, 300) };
        })()`);
      }
    }

    // ── 交互链 B：设置页（核心玻璃探针）+ 五分区走查 ─────────────────────────
    flow.settingsOpened = await evS(
      `(() => { const b = document.querySelector('[aria-label="设置"]'); if (!b) return 0; b.click(); return 1; })()`);
    flow.settingsDialog = Boolean(await waitEv(
      `document.querySelector('${SETTINGS_DIALOG}') ? 1 : 0`, 8000, 400));
    let settingsGlass = null;
    if (flow.settingsDialog) {
      settingsGlass = await evS(`(() => {
        const dlg = document.querySelector('${SETTINGS_DIALOG}');
        const cs = getComputedStyle(dlg);
        return {
          backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
          bg: (cs.backgroundImage || '').slice(0, 300),
          layer1: cs.getPropertyValue('--dsw-alias-bg-layer-1').trim().slice(0, 80),
        };
      })()`);
    }

    const SECTIONS = ['通用设置', '模型', '插件', 'Agent 预设', 'Wallpaper Engine'];
    const walk = [];
    for (const sec of SECTIONS) {
      const clicked = await evS(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(sec)});
        if (!b) return 0; b.click(); return 1;
      })()`);
      await sleep(600);
      const snap = await evS(`(() => {
        const dlg = document.querySelector('${SETTINGS_DIALOG}');
        if (!dlg) return null;
        return {
          textLen: (dlg.textContent || '').length,
          ourStyle: Boolean(document.querySelector(${JSON.stringify(STYLE_SEL)})),
        };
      })()`);
      walk.push({ section: sec, clicked: Number(clicked) || 0, snap, ourErrors: countOurErrors(pageErrors) });
    }

    if (DUMP) {
      console.log('── 首页观测 ──');
      console.log(JSON.stringify(o, null, 2));
      console.log('── 交互链 ──');
      console.log(JSON.stringify(flow, null, 2));
      console.log('── 设置玻璃计算样式 ──');
      console.log(JSON.stringify(settingsGlass, null, 2));
      console.log('── 分区走查 ──');
      console.log(JSON.stringify(walk, null, 2));
      console.log('── 运行期错误（前 10 条）──');
      console.log(JSON.stringify(pageErrors.slice(0, 10), null, 2));
      return;
    }

    // ── 判据 ────────────────────────────────────────────────────────────────
    check('应用页面真的加载了（有标题）',
      Boolean(o.title || (o.headings && o.headings.length)),
      o.title || (o.headings && o.headings[0]) || 'title/headings 皆空');

    check('插件 client 在真实 harness 页面里活着（主样式标签在场且非空）',
      Boolean(o.ourStyle) && o.ourStyleLen > 1000,
      o.ourStyle ? 'len=' + o.ourStyleLen : '未找到 ' + STYLE_SEL);

    const cssIsOurs = await evS(
      `(document.querySelector(${JSON.stringify(STYLE_SEL)}) || {textContent:''}).textContent.includes('data-we-sidebar-glass')`);
    check('样式标签内容确系我们的当前 CSS（含 data-we-sidebar-glass 规则）',
      cssIsOurs === true, String(cssIsOurs));

    check('默认玻璃开关与变量落到了页面（body 锚点 + --we-accent/--we-glass-color）',
      Array.isArray(o.bodyAttrs) && o.bodyAttrs.some((a) => a.startsWith('data-we-sidebar-glass'))
        && Boolean(o.cssVars && o.cssVars.weAccent && o.cssVars.weGlassColor),
      (o.bodyAttrs || []).filter((a) => a.startsWith('data-we-')).join(' ')
        + ' / accent=' + (o.cssVars ? o.cssVars.weAccent : '?')
        + ' glassColor=' + (o.cssVars ? o.cssVars.weGlassColor : '?'));

    check('我们自己的选择器入口在 DOM（壁纸仓库拉绳 .we-rope）',
      o.rope === true || await evS(`Boolean(document.querySelector('.we-rope'))`));

    check('会话页可达（新建会话点得到，main.conversation + rightbar slot 挂出）',
      flow.sessionPicked === 1 && flow.conversationOpen === true,
      'sessionPicked=' + flow.sessionPicked + ' conversationOpen=' + flow.conversationOpen);

    if (flow.panelMounted) {
      const openerMissing = !flow.opened && flow.expandFound === 0;
      if (openerMissing && flow.openerDiag && !flow.openerDiag.headerCorner) {
        // 视图态：会话头部（展开按钮的宿主槽位）整个没渲染 —— 无从取样，记信息不判红。
        console.log('  ℹ️ 会话头部未渲染（视图态），展开/玻璃判据本轮不取样 —— slot 尾部：'
          + JSON.stringify(flow.openerDiag.slotTail));
      } else {
        check('右栏在场：展开机制可用（expand → open 属性）', flow.opened === true,
          'expand=' + String(flow.expandFound)
          + (flow.openerDiag ? ' diag=' + JSON.stringify(flow.openerDiag) : ''));
        if (flow.opened) {
          check('右栏在场：开态玻璃是我们的（backdrop blur + sheen 渐变）',
            Boolean(flow.panelGlass && /blur\(/.test(flow.panelGlass.backdrop)
              && /linear-gradient/.test(flow.panelGlass.bg) && /rgba?\(255, ?255, ?255/.test(flow.panelGlass.bg)),
            flow.panelGlass ? 'backdrop=' + String(flow.panelGlass.backdrop).slice(0, 70) : '取不到 computed');
        }
      }
    } else {
      console.log('  ℹ️ 右栏 panel 本次未被 harness 渲染（内部状态门控）—— 包级与页面级判据已覆盖，此条不判红');
    }

    check('设置页打开且锚点在场（:has([data-slot="settings.section"]) 选得到 dialog）',
      flow.settingsOpened === 1 && flow.settingsDialog === true,
      'opened=' + flow.settingsOpened + ' dialog=' + flow.settingsDialog);

    if (flow.settingsDialog) {
      check('设置窗口玻璃·计算样式是我们的（backdrop blur 在场）',
        Boolean(settingsGlass && /blur\(/.test(settingsGlass.backdrop)),
        settingsGlass ? 'backdrop=' + String(settingsGlass.backdrop).slice(0, 90) : '取不到 computed');
      // sheen 渐变两档（0.1 = 浅色规则 / 0.07 = 深色规则）都是我们 styles.js 里的层，
      // 断言按「白色起步 + 38% 中间停」认族，主题无关。
      check('设置窗口玻璃·独有 sheen 渐变在场（白色三层渐变、38% 中间停）',
        Boolean(settingsGlass && /linear-gradient/.test(settingsGlass.bg)
          && /rgba\(255, 255, 255, (0\.07|0\.1)\)/.test(settingsGlass.bg)
          && /38%/.test(settingsGlass.bg)),
        settingsGlass ? 'bg=' + String(settingsGlass.bg).slice(0, 120) : '取不到 computed');
      check('设置窗口 token 被我们接管（--dsw-alias-bg-layer-1 = --we-glass-color 的值）',
        Boolean(settingsGlass && settingsGlass.layer1
          && (settingsGlass.layer1.includes(String(o.cssVars ? o.cssVars.weGlassColor : '#ffffff').slice(0, 7))
            || settingsGlass.layer1.includes('color-mix'))),
        settingsGlass ? 'layer1=' + settingsGlass.layer1 : '取不到 computed');
    }

    const walkBroken = walk.filter((w) => w.clicked !== 1 || !w.snap || !w.snap.ourStyle || w.snap.textLen <= 100);
    check('设置五分区逐页走查（每页 dialog 仍开 + 我们样式仍在场）',
      flow.settingsDialog === true && walk.length === SECTIONS.length && walkBroken.length === 0,
      walk.map((w) => w.section + ':' + (w.snap ? w.snap.textLen : 'lost')).join(' ')
        + (walkBroken.length ? ' 断点=' + walkBroken.map((w) => w.section).join(',') : ''));

    const ours = countOurErrors(pageErrors);
    check('页面运行期错误不含指向本插件的异常', ours === 0,
      ours === 0 ? '共 ' + pageErrors.length + ' 条宿主侧错误（不拦）'
        : oursErrorDetail(pageErrors));
  } finally {
    if (cdp) { try { cdp.ws.close(); } catch { /* 已关闭 */ } }
    await killTree(browser);
    await killTree(harness);
  }
}

function countOurErrors(list) {
  return list.filter((e) => /wallpaper-engine|dsh-wallpaper-engine|we-picker|we-rope|data-we-/.test(e)).length;
}
function oursErrorDetail(list) {
  return list.filter((e) => /wallpaper-engine|dsh-wallpaper-engine|we-picker|we-rope|data-we-/.test(e))
    .slice(0, 2).join(' | ').slice(0, 300);
}

main().then(() => {
  const failed = results.filter((ok) => !ok).length;
  if (DUMP) { console.log('\nDUMP 完成（探查模式不判红绿）'); process.exitCode = 0; return; }
  if (failed) console.log(`\nHARNESS PAGES FAILED — ${failed}/${results.length} 条判据不成立`);
  else console.log(`\nHARNESS PAGES PASSED — ${results.length} 条判据全部成立`);
  process.exitCode = failed ? 1 : 0;
}).catch((err) => {
  console.error('compat-harness-pages 未捕获异常：', err);
  process.exitCode = 1;
});
