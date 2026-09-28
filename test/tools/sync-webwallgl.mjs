#!/usr/bin/env node
/**
 * sync-webwallgl.mjs — 从本地 webwallgl-github 仓库构建 WebWallGL 渲染页
 * 产物并 vendor 进 lib/webwallgl/。
 *
 * 产物只包含 dist/renderer/index.html + 它引用的 dist/assets/*（约 0.9MB；
 * bench 与库产物不进来）。构建使用 --base=/wallpaper-engine/scene-live/，使
 * 产物内的绝对资源引用对齐本插件的 HTTP 前缀（serve 见 lib/index.js 的
 * /scene-live 路由）——默认 base 是 "/"，挂在子路径下会 404。
 *
 * 用法：
 *   node test/tools/sync-webwallgl.mjs                 # 默认上游 ../webwallgl-github
 *   WEBWALLGL_REPO=/path/to/webwallgl node test/tools/sync-webwallgl.mjs
 *   node test/tools/sync-webwallgl.mjs --patches-only   # 不碰上游，只把本地补丁重打到现有产物
 *                                                       （上游仓库不在本机 / 只想重打补丁时用）
 *
 * 同步后写 lib/webwallgl/.upstream.json（上游 commit / 版本 / 文件清单）。
 * 上游更新渲染器后重跑本脚本即可；手动改 lib/webwallgl/ 会被下次同步
 * 覆盖 —— 需要的改动应做在上游。唯一例外是下面的两个本地补丁函数：
 * 它们在上游修好前于同步末尾自动重打（上游修复后连同那两个函数与说明一起删）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 失败模式表的**唯一真源**（宿主侧同一条判据）：补丁把它打进渲染页，渲染页据此给
// `/diag` 上报带 `&lvl=` —— 于是渲染页的"明文级别"与宿主的模式表覆盖完全等价。
import { FAIL_REPORT_RE } from '../../lib/routes/diag.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件在 test/tools/ 下 ⇒ 仓库根要退两层（这一行在目录重整时最容易漏改）。
const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'lib', 'webwallgl');
/** 必须与 lib/index.js 的 /scene-live 路由前缀一致（BASE + '/scene-live'）。 */
const BASE_PATH = '/wallpaper-engine/scene-live';
/** 只重打本地补丁：跳过上游仓库检查 / 构建 / 拷贝，直接改现有产物。 */
const PATCHES_ONLY = process.argv.includes('--patches-only');

/** 现有产物（`--patches-only` 下没有上游清单，补丁只需要这一列）。
 *  顺序照 `index.html` 的引用顺序 —— 与上游同步得到的清单同形，换名不会打乱 `files` 列。 */
function existingAssets() {
  const htmlPath = join(OUT_DIR, 'index.html');
  if (!existsSync(htmlPath)) return [];
  return [...readFileSync(htmlPath, 'utf8').matchAll(/\/assets\/([^"']+)/g)]
    .map((m) => ({ out: join(OUT_DIR, 'assets', m[1]) }))
    .filter((a) => existsSync(a.out));
}

/** 溯源清单里的相对路径：正斜杠（该文件随包发布，不该带平台分隔符）。 */
const relPosix = (p) => p.slice(OUT_DIR.length + 1).replace(/\\/g, '/');

/** 上游仓库 → 构建 → 解析产物清单；返回 `{ repo, pkg, assets }`。 */
function loadUpstream() {
  const repo = resolve(process.env.WEBWALLGL_REPO || join(ROOT, '..', 'webwallgl-github'));
  const pkgPath = join(repo, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(`[sync-webwallgl] 上游仓库不存在或缺少 package.json：${repo}`);
    console.error('                可用 WEBWALLGL_REPO 环境变量指定 webwallgl 仓库路径，');
    console.error('                或加 --patches-only 只重打本地补丁。');
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== 'webwallgl') {
    console.error(`[sync-webwallgl] ${repo} 不是 webwallgl 仓库（name=${pkg.name}）。`);
    process.exit(1);
  }

  // 1. 构建（跳过上游 npm run build 里的 tsc —— 类型检查属于上游自己的
  //    `npm run check`，这里只要产物）。
  console.log(`[sync-webwallgl] 构建上游 ${repo} (base=${BASE_PATH}/) …`);
  const buildArgs = ['exec', 'vite', 'build', `--base=${BASE_PATH}/`];
  let built = spawnSync('pnpm', buildArgs, { cwd: repo, stdio: 'inherit' });
  if (built.error || built.status !== 0) {
    console.log('[sync-webwallgl] pnpm 不可用或失败，回退 npx …');
    built = spawnSync('npx', buildArgs, { cwd: repo, stdio: 'inherit' });
  }
  if (built.error || built.status !== 0) {
    console.error('[sync-webwallgl] 上游构建失败。');
    process.exit(1);
  }

  // 2. 从 dist/renderer/index.html 提取以 BASE_PATH 为前缀的资源引用，
  //    映射回 dist 内的真实文件。出现非前缀引用说明 base 没生效，直接失败。
  const htmlPath = join(repo, 'dist', 'renderer', 'index.html');
  if (!existsSync(htmlPath)) {
    console.error(`[sync-webwallgl] 缺少 ${htmlPath} —— 上游构建输出结构变化？`);
    process.exit(1);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => r.startsWith('/'));
  if (!refs.length) {
    console.error('[sync-webwallgl] index.html 中没有解析到任何资源引用（结构变化？）');
    process.exit(1);
  }
  const assets = [];
  for (const ref of refs) {
    if (!ref.startsWith(BASE_PATH + '/')) {
      console.error(`[sync-webwallgl] 发现未带 base 前缀的绝对引用：${ref}（base 未生效）`);
      process.exit(1);
    }
    const rel = ref.slice(BASE_PATH.length + 1); // e.g. assets/renderer-xxx.js
    const src = join(repo, 'dist', rel);
    if (!existsSync(src)) {
      console.error(`[sync-webwallgl] 产物引用的文件不存在：${src}`);
      process.exit(1);
    }
    assets.push({ ref, src, out: join(OUT_DIR, rel) });
  }

  // 3. 覆盖式写出（先清空目录，旧 hash 文件名不累积）。
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(htmlPath, join(OUT_DIR, 'index.html'));
  for (const a of assets) {
    mkdirSync(dirname(a.out), { recursive: true });
    copyFileSync(a.src, a.out);
  }
  // web-shim.js 原文：宿主把它注入**网页壁纸**的 HTML 响应（见 lib/index.js 的
  // /scene-files 路由）—— 严格沙箱下渲染页与壁纸 iframe 不同源，shim 只能这样
  // 进入作者页面（渲染页内的 ?raw 版本是给 WallpaperEM 的注入路径用的）。
  const shimSrc = join(repo, 'renderer', 'src', 'web-shim.js');
  if (!existsSync(shimSrc)) {
    console.error(`[sync-webwallgl] 缺少 ${shimSrc} —— 上游 web shim 位置变化？`);
    process.exit(1);
  }
  copyFileSync(shimSrc, join(OUT_DIR, 'web-shim.js'));
  return { repo, pkg, assets };
}

// 3b. 本地补丁（上游修好后删掉本段 + 头部说明）。
//   [webwallgl#9] interactive 效果（x-ray 等）的精灵贴图极小化采样退化：
//   程序化/位图原始贴图上传函数把 MIN_FILTER 设为 LINEAR_MIPMAP_LINEAR。
//   x-ray 类效果按 1/size（size≈0.07 → 约 14 倍）缩放采样 halo 精灵，极小化
//   采样落到小 mip 层级后精灵被平均成一层灰 ——「精灵外 = 透明」的语义丢失，
//   混合铺满全屏（用户可见：x-ray 范围扩张到整张壁纸）。改成 LINEAR（只用
//   base level）后精灵外采样回到透明边缘，范围收在光标附近。
//   复现/验证：壁纸 3475149989「Lumen—凝-蓝线稿」（effects/xray，size=0.07）
//   —— 修补前深色叠加铺满全图，修补后仅光标附近。壁纸图层贴图走 cl() 那条
//   路径（保留 mipmap），不受影响。
//   **锚点用签名而不是压缩名**：该函数的 minified 名每换一版 bundle 就轮换
//   （webwallgl 1.4.1 的 Jy / 1.4.2 的 Wy / 1.4.2+ 的 Vw…），钉名字等于每次
//   同步都失败一次再手改。签名 + `createTexture()` 前缀在已见的各版里稳定。
function applyLocalPatches() {
  const from = 't.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR)';
  const to = 't.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR)';
  const sig = '(t,e,n=!1,r=null){const i=t.createTexture()';
  let patched = 0;
  let already = 0;
  for (const a of assets) {
    if (!/\.js$/.test(a.out)) continue;
    let s = readFileSync(a.out, 'utf8');
    const sigAt = s.indexOf(sig);
    if (sigAt < 0) continue;
    const start = s.lastIndexOf('function ', sigAt);
    const end = s.indexOf('function ', sigAt + sig.length);
    if (start < 0 || end < 0) continue;
    const body = s.slice(start, end);
    // 幂等：已打过（目标函数体里只剩 LINEAR）就跳过 —— `--patches-only` 会被重复跑。
    if (!body.includes(from)) { if (body.includes(to)) already++; continue; }
    s = s.slice(0, start) + body.split(from).join(to) + s.slice(end);
    writeFileSync(a.out, s);
    patched++;
  }
  if (!patched && !already) {
    console.error('[sync-webwallgl] 本地补丁未命中（Jy 的 MIN_FILTER 模式变化）—— 请核对上游是否已修复 webwallgl#9');
    process.exit(1);
  }
  console.log(`[sync-webwallgl] 本地补丁已应用（xray 精灵采样，${patched} 个产物`
    + (already ? `，${already} 个已是` : '') + '）');
}

/**
 * [日志分级] 让渲染页**自己声明** `/diag` 上报的级别（宿主据此分档，不必再靠文案猜）。
 *
 * 上游 `pe(t,e,n)` 已经把级别算出来了 —— `/fail|error|失败|ERROR/.test(n) ? "error" : "info"`
 * —— 但只喂给 `onDiagnostic`（浏览器控制台），构造像素请求时把它丢了，于是宿主只能拿关键字
 * 去猜。本补丁做两件事，**点位各一处**：
 *   ① 在函数首行按 `FAIL_REPORT_RE`（与宿主同一真源）算出 `__weLvl`；
 *   ② 把 `/diag?msg=…` 改成 `/diag?msg=…&lvl=…`。
 *
 * 级别取 **`warn` / `info`** 而不是上游的 `error`：上游那张网判的是"有没有出错"，
 * 而本条通道的档位判据是"会不会影响显示效果"（渲染页脚本失败属于后者，不是插件 / DSH 出问题）。
 * `onDiagnostic` 那条（上游自己的两档语义）**不动**。
 *
 * 幂等：已打过（首行已有 `__weLvl`）就跳过，所以 `--patches-only` 可以重复跑。
 *
 * **改了内容就必须换 URL**：`/scene-live` 给哈希资源发 `immutable`（一年），原地改一个
 * 同名文件等于让老访客一直拿旧产物 ⇒ 补丁顺带给产物名加 `PATCH_SUFFIX`，并把
 * `index.html` 里的引用一起改掉（该文件本身是 no-store，改完即生效）。
 */
const PATCH_SUFFIX = '-welvl1';

function applyDiagLevelPatch() {
  const from = 'function pe(t,e,n){try{t.onDiagnostic?.(n,';
  const to = 'function pe(t,e,n){const __weLvl=/' + FAIL_REPORT_RE.source + '/.test(n)?"warn":"info";try{t.onDiagnostic?.(n,';
  const urlFrom = '${n.slice(0,500)}`)}`';
  const urlTo = '${n.slice(0,500)}`)}&lvl=${__weLvl}`';
  const htmlPath = join(OUT_DIR, 'index.html');
  let patched = 0;
  let already = 0;
  let renamed = 0;
  for (const a of assets) {
    if (!/\.js$/.test(a.out)) continue;
    let s = readFileSync(a.out, 'utf8');
    // 认产物：待打的（`from`）与已打过的（`to`）都算，其余文件不碰。
    if (!s.includes(from) && !s.includes(to)) continue;
    if (s.includes(from)) {
      if (!s.includes(urlFrom)) {
        console.error('[sync-webwallgl] 级别补丁的 URL 锚点未命中（reportDiag 的 /diag?msg= 模板变了）');
        process.exit(1);
      }
      s = s.replace(from, to).replace(urlFrom, urlTo);
      writeFileSync(a.out, s);
      patched++;
    } else {
      already++;
    }
    // 内容变了：保证 URL 与内容一一对应（否则 immutable 缓存会继续发旧产物）。
    if (!a.out.endsWith(PATCH_SUFFIX + '.js')) {
      const next = a.out.replace(/\.js$/, PATCH_SUFFIX + '.js');
      renameSync(a.out, next);
      if (existsSync(htmlPath)) {
        writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8')
          .split('/assets/' + basename(a.out)).join('/assets/' + basename(next)));
      }
      a.out = next;
      renamed++;
    }
  }
  if (!patched && !already) {
    console.error('[sync-webwallgl] 级别补丁未命中（diag 上报函数 pe() 的形态变了）—— 请核对上游 reportDiag');
    process.exit(1);
  }
  console.log(`[sync-webwallgl] 本地补丁已应用（diag 级别随请求上行，${patched} 个产物`
    + (already ? `，${already} 个已是` : '') + (renamed ? `，${renamed} 个换名（${PATCH_SUFFIX}）` : '') + '）');
}

// 入口：`--patches-only` 不碰上游，只对现有产物重打补丁。
let repo = null;
let pkg = null;
let assets = [];
if (PATCHES_ONLY) {
  assets = existingAssets();
  if (!assets.length) {
    console.error(`[sync-webwallgl] --patches-only 找不到现有产物：${join(OUT_DIR, 'assets')}`);
    process.exit(1);
  }
  console.log(`[sync-webwallgl] --patches-only：对 ${assets.length} 个现有产物重打本地补丁 …`);
} else {
  ({ repo, pkg, assets } = loadUpstream());
}
applyLocalPatches();
applyDiagLevelPatch();

/** `.upstream.json` 的 `files` 列：盘上真实存在的名字（换名后不改就是指向不存在的东西）。 */
const fileList = () => ['index.html', 'web-shim.js', ...assets.map((a) => relPosix(a.out))];

function refreshUpstreamFileList() {
  const p = join(OUT_DIR, '.upstream.json');
  if (!existsSync(p)) return;
  const cur = JSON.parse(readFileSync(p, 'utf8'));
  writeFileSync(p, JSON.stringify({ ...cur, files: fileList() }, null, 2) + '\n');
}

// 4. 溯源信息。
if (!PATCHES_ONLY) {
  // ⚠️ **不写本机的仓库路径**：这个文件随包发布（`files` 含 `lib/webwallgl/`），
  //    写进去等于把同步机器的绝对路径发给每个用户（本仓被发布面守卫抓到过一次）。
  //    `name` + `commit` + `version` 已足够复现"哪一版上游"，路径对复现没有价值。
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  writeFileSync(join(OUT_DIR, '.upstream.json'), JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    commit: commit.status === 0 ? commit.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
    base: BASE_PATH,
    syncedAt: new Date().toISOString(),
    files: fileList(),
  }, null, 2) + '\n');

  console.log(`[sync-webwallgl] 完成：webwallgl@${pkg.version} → lib/webwallgl/`);
  for (const a of assets) console.log(`  + ${a.out.slice(ROOT.length + 1)}`);
  console.log('  + index.html / web-shim.js / .upstream.json');
} else {
  refreshUpstreamFileList();
}
