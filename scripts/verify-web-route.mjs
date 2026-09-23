// 守卫: **web (HTML) 壁纸的子资源必须可达**。
//
// 真实缺陷 (2026-09-20 用户报「网页壁纸全是空白/黑屏」): 一张 web 壁纸是多文件
// HTML 应用 (官方 CORSAIR Collection / Corsair-O-Tron 都是 Angular / bundler 产物),
// 入口 index.html 里全是相对路径。iframe 的 src 决定相对解析基准, 旧实现用
// `/wallpaper-engine/media/<入口 token>` —— 该 URL 没有尾斜杠, 基准因此是
// `/wallpaper-engine/media/`, 于是每一个子资源都变成
// `/wallpaper-engine/media/<文件名>`, 而 /media 只按「单文件 token」查表
// (mediaMap: token = base64url(abs 路径)), `<文件名>` 永远不是键 ⇒ 全部 404
// ⇒ JS/CSS 永远下不来 ⇒ 应用不 bootstrap ⇒ iframe 里什么都没有 (深色底透出来,
// 用户看到的就是"黑屏")。
//
// 实测存量: corsair_collection 6/6、corsair_o_tron 4/4 相对资源不可达。
//
// 本脚本分四层, 前三层**不依赖本机是否装了 Wallpaper Engine** (全部在临时目录里
// 造夹具), 第四层用真实官方项目做端到端取证 (找不到就显式 SKIP, 绝不静默放过):
//
//   A1–A15 resolveWebAsset 真值表: 正常/点段/内部 .. 必须 ok;
//           `../`、反斜杠 `..\`、绝对路径、盘符相对路径**必须被拒**;
//           非 html 入口 / 空子路径 / NUL 必须被拒; 目录必须被拒 (不能当文件serve)。
//   A16 负控制: 被拒的 `../secret.txt` 在磁盘上**确实存在** —— 证明拦住它的是包含性
//           检查而不是"文件不存在", 即断言有分辨力 (照 verify-composite-blit 的 R3)。
//   B1–B3 相对解析链: 同一份 index.html, 用**旧基准** (/media/<token>) 解析 ⇒ 每个
//           子资源都落在 /web/ 之外 (故 /web 路由救不了它, 也解释了为什么必须换基准);
//           用**新基准** (/web/<token>/<入口>) 解析 ⇒ 每个子资源都落在 /web/ 前缀内,
//           取出子路径喂给 resolveWebAsset ⇒ 必须命中真实文件。这一条就是"修好了"的
//           机器可判定定义。
//   C1–C4 接线断言: 路由注册、inventory 新字段、构建产物里客户端优先用它 (且保留
//           老宿主的 media 回退)、mimeFor 必须给 CSS/SVG 正确类型 (Chromium 拒收
//           MIME 不是 text/css 的样式表, 这一条不满足则"修了路由还是没样式")。
//   D1–D2 真实项目端到端 (有官方项目时): 默认项目里的每个 web 壁纸, 其入口的每个
//           相对资源都必须能解析到真实文件。向上越出项目目录的引用会**显式 WARN**
//           (已知边界: 资源根 = 入口所在目录), 不计失败。
//
// 用法: node scripts/verify-web-route.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { resolveWebAsset, locateWallpaperEngineP } from '../lib/index.js';

const BASE = '/wallpaper-engine';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
function skip(name, detail) {
  results.push({ name, ok: true, skipped: true });
  console.log('SKIP' + ' | ' + name + (detail ? ' | ' + detail : ''));
}
function warn(name, detail) {
  console.log('WARN' + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const root = mkdtempSync(join(tmpdir(), 'dsh-we-webroute-'));
try {
  // ── 夹具: 一个"多文件 HTML 壁纸"项目 ────────────────────────────────────────
  const proj = join(root, 'proj');
  const files = [
    ['index.html', '<!doctype html><html><head><base href="."><link rel="stylesheet" href="css/style.css"></head><body><app-root></app-root><script src="runtime.abc.js"></script><script src="js/main.js"></script><img src="images/我 的 图.svg"></body></html>'],
    ['js/main.js', 'document.body.dataset.booted = "1";\n'],
    ['css/style.css', 'body { margin: 0; background: #000; }\n'],
    ['images/我 的 图.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>\n'],
    ['runtime.abc.js', '/* runtime */\n'],
    ['sub/keep.txt', 'dir marker\n'],
  ];
  for (const [rel, body] of files) {
    const p = join(proj, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  const entry = join(proj, 'index.html');
  const outside = join(root, 'secret.txt');       // 资源根**之外**的真实文件 (负控制用)
  writeFileSync(outside, 'TOP SECRET\n', 'utf8');
  const notHtml = join(proj, 'nothtml.pkg');
  writeFileSync(notHtml, 'PKGV0001', 'utf8');

  // ── A. resolveWebAsset 真值表 ───────────────────────────────────────────────
  const okCase = (sub, expectAbs, label) => {
    const r = resolveWebAsset(entry, sub);
    check('A: ' + label, r.ok === true && r.abs === expectAbs,
      `sub=${JSON.stringify(sub)} → ${r.ok ? r.abs : 'REJECT ' + r.reason}`);
  };
  const rejectCase = (sub, reason, label, entryAbs = entry) => {
    const r = resolveWebAsset(entryAbs, sub);
    check('A: ' + label, r.ok === false && (reason === null || r.reason === reason),
      `sub=${JSON.stringify(sub)} → ${r.ok ? 'ACCEPTED(' + r.abs + ')' : 'REJECT ' + r.reason}`);
  };

  okCase('js/main.js', join(proj, 'js', 'main.js'), '普通子路径 → 命中');
  okCase('./js/main.js', join(proj, 'js', 'main.js'), '带 ./ 前缀 → 命中');
  okCase('js/../js/main.js', join(proj, 'js', 'main.js'), '内部 .. 归一化后仍在根内 → 命中');
  okCase('images/我 的 图.svg', join(proj, 'images', '我 的 图.svg'), '非 ASCII / 空格文件名 → 命中');
  okCase('index.html', entry, '入口自身 → 命中 (iframe src 走同一条路)');

  rejectCase('../secret.txt', 'escape', '`../` 越界 → 拒 (escape)');
  rejectCase('..\\secret.txt', 'escape', '反斜杠 `..\\` 越界 → 拒');
  rejectCase('js/../../secret.txt', 'escape', '先下后上越界 → 拒');
  rejectCase(outside, 'escape', '绝对路径 → 拒');
  rejectCase('', 'bad-subpath', '空子路径 → 拒');
  rejectCase('js/main.js\0.png', 'bad-subpath', '子路径含 NUL → 拒');
  rejectCase('sub', 'not-a-file', '目录 → 拒 (不能把目录当文件 serve)');
  rejectCase('.', 'not-a-file', '资源根本身 → 拒');
  rejectCase('missing.js', 'not-found', '不存在 → 拒 (not-found)');
  rejectCase('js/main.js', 'bad-entry', '非 html 入口 → 拒 (安全边界①)', notHtml);
  rejectCase('js/main.js', 'bad-entry', 'null 入口 → 拒', null);

  // A16 负控制: 被拒的那个文件确实存在 ⇒ 拦住它的是包含性检查, 不是文件缺失。
  const secretExists = existsSync(outside);
  const escaped = resolveWebAsset(entry, '../secret.txt');
  check('A: 负控制 — 越界目标文件确实存在 (证明拦截来自包含性检查, 而非 not-found)',
    secretExists && escaped.ok === false && escaped.reason === 'escape',
    `exists=${secretExists} reason=${escaped.ok ? 'ACCEPTED' : escaped.reason}`);

  // ── B. 相对解析链 (同一份 HTML, 两种基准) ──────────────────────────────────
  const token = Buffer.from(entry, 'utf8').toString('base64url');
  const oldBaseUrl = `http://x${BASE}/media/${token}`;
  const newBaseUrl = `http://x${BASE}/web/${token}/index.html`;

  const html = readFileSync(entry, 'utf8');
  // `<base href>` 自身不是资源, 它只决定基准 —— 必须先从候选里剔除, 否则会被当成
  // 一个子路径去解析 (真实项目 corsair_collection 就带 `<base href=".">`)。
  const baseTag = /<base\s+href\s*=\s*"([^"]*)"/i.exec(html);
  const refs = [...html.replace(/<base\b[^>]*>/gi, '').matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)]
    .map((m) => m[1]);
  // 三类引用分开处理: 外链/内联跳过; **根绝对路径** (`/x.js`) 与**向上越出项目目录**
  // (`../x.js`) 都超出"入口所在目录 = 资源根"这个模型, 且浏览器会把它们归一化到本
  // 前缀之外 —— 服务端无法在不改写 HTML 的前提下兜住, 故记为已知边界 (WARN), 不计失败。
  const external = (r) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r);
  const rootAbsolute = (r) => !external(r) && r.startsWith('/');
  const oldDocBase = baseTag ? new URL(baseTag[1], oldBaseUrl).href : oldBaseUrl;
  const newDocBase = baseTag ? new URL(baseTag[1], newBaseUrl).href : newBaseUrl;

  const oldRelative = refs.filter((r) => !external(r) && !rootAbsolute(r));
  const oldOutside = oldRelative.filter((r) => !new URL(r, oldDocBase).pathname.startsWith(`${BASE}/web/`));
  check('B: 旧基准 (/media/<token>) 无法把任何相对资源带进 /web 前缀',
    oldRelative.length > 0 && oldOutside.length === oldRelative.length,
    `${oldOutside.length}/${oldRelative.length} 落在 /web/ 之外 ⇒ 旧实现的 404 是结构性的`);

  let resolved = 0;
  let failedRef = '';
  for (const ref of oldRelative) {
    const p = new URL(ref, newDocBase).pathname;
    if (!p.startsWith(`${BASE}/web/${token}/`)) { failedRef = ref; continue; }
    const sub = decodeURIComponent(p.slice(`${BASE}/web/${token}/`.length));
    const r = resolveWebAsset(entry, sub);
    if (r.ok) resolved++; else failedRef = `${ref} (${r.reason})`;
  }
  check('B: 新基准 (/web/<token>/<入口>) 下每个相对资源都解析到真实文件',
    resolved === oldRelative.length,
    resolved === oldRelative.length
      ? `${resolved}/${oldRelative.length} 命中`
      : `停在 ${JSON.stringify(failedRef)}`);
  check('B: `<base href=".">` 这类写法在新基准下仍指向资源根 (无需改写 HTML)',
    !baseTag || newDocBase === `http://x${BASE}/web/${token}/`,
    `base=${baseTag ? baseTag[1] : '(无)'} → docBase=${newDocBase}`);

  const entryViaRoute = new URL(`${BASE}/web/${token}/index.html`, 'http://x').pathname;
  const entrySub = decodeURIComponent(entryViaRoute.slice(`${BASE}/web/${token}/`.length));
  const entryResolved = resolveWebAsset(entry, entrySub);
  check('B: iframe 入口自身也经同一路由解析 (目录型基准, 无需改写 HTML)',
    entryResolved.ok === true && entryResolved.abs === entry,
    `${entryViaRoute} → ${entryResolved.ok ? entryResolved.abs : 'REJECT ' + entryResolved.reason}`);

  // ── C. 接线 ────────────────────────────────────────────────────────────────
  const idx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  check('C: 宿主注册了 `${BASE}/web` 前缀路由 (token + 子路径)',
    /kind:\s*'prefix'[\s\S]{0,80}path:\s*`\$\{BASE\}\/web`/.test(idx)
    && idx.includes("pathname.slice(`${BASE}/web/`.length)"),
    'lib/index.js');
  check('C: inventory 为 web 类型输出 webView (与单文件 media 分开)',
    /webView:\s*w\.type === 'web'/.test(idx) && /`\$\{BASE\}\/web\/\$\{tokenFor\(w\.fileAbs\)\}/.test(idx),
    'lib/index.js');
  check('C: 客户端优先用 webView, 且老宿主仍回退 media',
    bundle.includes('w.webView') && /:\s*w\.media;/.test(bundle),
    'lib/client.js (构建产物)');
  check('C: mimeFor 给 CSS/SVG 正确类型 (样式表 MIME 不对会被 Chromium 直接拒收)',
    /css:\s*'text\/css'/.test(idx) && /svg:\s*'image\/svg\+xml'/.test(idx),
    'lib/index.js');

  // ── D. 真实官方项目端到端 (没有就显式 SKIP) ────────────────────────────────
  let installDir = null;
  try { installDir = await locateWallpaperEngineP(); } catch { installDir = null; }
  const defaultProjects = installDir ? join(installDir, 'projects', 'defaultprojects') : null;
  const realWebs = [];
  if (defaultProjects && existsSync(defaultProjects)) {
    for (const name of readdirSync(defaultProjects)) {
      const dir = join(defaultProjects, name);
      const pj = join(dir, 'project.json');
      if (!existsSync(pj)) continue;
      let j;
      try { j = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
      if (!j || typeof j.file !== 'string') continue;
      if (j.type === 'web' || /\.html?$/i.test(j.file)) realWebs.push({ name, dir, file: j.file });
    }
  }
  if (realWebs.length === 0) {
    skip('D: 真实 web 项目端到端', `未找到 Wallpaper Engine 默认项目 (installDir=${installDir || 'null'})`);
  } else {
    let totalRefs = 0;
    let totalOk = 0;
    let totalUp = 0;
    const broken = [];
    for (const w of realWebs) {
      const e = resolve(w.dir, w.file);
      if (!existsSync(e)) { broken.push(`${w.name}: 入口不存在`); continue; }
      const t = Buffer.from(e, 'utf8').toString('base64url');
      const h = readFileSync(e, 'utf8');
      const b = /<base\s+href\s*=\s*"([^"]*)"/i.exec(h);
      const docBase = b ? new URL(b[1], `http://x${BASE}/web/${t}/${w.file}`).href
        : `http://x${BASE}/web/${t}/${w.file}`;
      for (const m of h.replace(/<base\b[^>]*>/gi, '').matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)) {
        const ref = m[1];
        if (external(ref)) continue;
        totalRefs++;
        const p = new URL(ref, docBase).pathname;
        // 根绝对路径 / 向上越出项目目录: 都超出"资源根 = 入口所在目录"的模型 (已知边界)。
        if (rootAbsolute(ref) || !p.startsWith(`${BASE}/web/${t}/`)) { totalUp++; continue; }
        const sub = decodeURIComponent(p.slice(`${BASE}/web/${t}/`.length));
        const r = resolveWebAsset(e, sub);
        if (r.ok) totalOk++; else broken.push(`${w.name}: ${ref} → ${r.reason}`);
      }
    }
    check('D: 真实官方 web 壁纸的每个相对资源都可达',
      broken.length === 0, `${realWebs.length} 个项目, ${totalOk}/${totalRefs} 资源命中` +
      (totalUp > 0 ? `, ${totalUp} 个越出资源根` : '') +
      (broken.length ? ` — 失败: ${broken.slice(0, 4).join('; ')}` : ''));
    if (totalUp > 0) {
      warn('D: 根绝对路径 / 向上越出项目目录的引用 (已知边界)',
        `${totalUp} 个 —— 资源根 = 入口所在目录; 打包器产物一律向下、相对引用, 这类写法不在覆盖范围内`);
    }
    const names = realWebs.map((w) => w.name).join(', ');
    console.log(`     (真实项目: ${names})`);
  }
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL WEB-ROUTE CHECKS PASSED'
  : failed.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
