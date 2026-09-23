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
 *   node scripts/sync-webwallgl.mjs                 # 默认上游 ../webwallgl-github
 *   WEBWALLGL_REPO=/path/to/webwallgl node scripts/sync-webwallgl.mjs
 *
 * 同步后写 lib/webwallgl/.upstream.json（上游 commit / 版本 / 文件清单）。
 * 上游更新渲染器后重跑本脚本即可；手动改 lib/webwallgl/ 会被下次同步
 * 覆盖 —— 需要的改动应做在上游。唯一例外是下面的 applyLocalPatches()：
 * 它在上游修好前于同步末尾自动重打补丁（上游修复后连同该函数与说明一起删）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'lib', 'webwallgl');
/** 必须与 lib/index.js 的 /scene-live 路由前缀一致（BASE + '/scene-live'）。 */
const BASE_PATH = '/wallpaper-engine/scene-live';

const repo = resolve(process.env.WEBWALLGL_REPO || join(ROOT, '..', 'webwallgl-github'));
const pkgPath = join(repo, 'package.json');
if (!existsSync(pkgPath)) {
  console.error(`[sync-webwallgl] 上游仓库不存在或缺少 package.json：${repo}`);
  console.error('                可用 WEBWALLGL_REPO 环境变量指定 webwallgl 仓库路径。');
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

// 3b. 本地补丁（上游修好后删掉本段 + 头部说明）。
//   [webwallgl#9] interactive 效果（x-ray 等）的精灵贴图极小化采样退化：
//   Jy()（程序化/位图原始贴图上传）把 MIN_FILTER 设为 LINEAR_MIPMAP_LINEAR。
//   x-ray 类效果按 1/size（size≈0.07 → 约 14 倍）缩放采样 halo 精灵，极小化
//   采样落到小 mip 层级后精灵被平均成一层灰 ——「精灵外 = 透明」的语义丢失，
//   混合铺满全屏（用户可见：x-ray 范围扩张到整张壁纸）。改成 LINEAR（只用
//   base level）后精灵外采样回到透明边缘，范围收在光标附近。
//   复现/验证：壁纸 3475149989「Lumen—凝-蓝线稿」（effects/xray，size=0.07）
//   —— 修补前深色叠加铺满全图，修补后仅光标附近。壁纸图层贴图走 cl() 那条
//   路径（保留 mipmap），不受影响。
function applyLocalPatches() {
  const from = 't.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR)';
  const to = 't.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR)';
  let patched = 0;
  for (const a of assets) {
    if (!/\.js$/.test(a.out)) continue;
    let s = readFileSync(a.out, 'utf8');
    const start = s.indexOf('function Jy(');
    if (start < 0) continue;
    const end = s.indexOf('function ', start + 12);
    const body = s.slice(start, end);
    if (!body.includes(from)) continue;
    s = s.slice(0, start) + body.split(from).join(to) + s.slice(end);
    writeFileSync(a.out, s);
    patched++;
  }
  if (!patched) {
    console.error('[sync-webwallgl] 本地补丁未命中（Jy 的 MIN_FILTER 模式变化）—— 请核对上游是否已修复 webwallgl#9');
    process.exit(1);
  }
  console.log(`[sync-webwallgl] 本地补丁已应用（xray 精灵采样，${patched} 个产物）`);
}
applyLocalPatches();

// 4. 溯源信息。
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
writeFileSync(join(OUT_DIR, '.upstream.json'), JSON.stringify({
  repo,
  name: pkg.name,
  version: pkg.version,
  commit: commit.status === 0 ? commit.stdout.trim() : null,
  dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
  base: BASE_PATH,
  syncedAt: new Date().toISOString(),
  files: ['index.html', 'web-shim.js', ...assets.map((a) => a.out.slice(OUT_DIR.length + 1))],
}, null, 2) + '\n');

console.log(`[sync-webwallgl] 完成：webwallgl@${pkg.version} → lib/webwallgl/`);
for (const a of assets) console.log(`  + ${a.out.slice(ROOT.length + 1)}`);
console.log('  + index.html / web-shim.js / .upstream.json');
