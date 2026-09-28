#!/usr/bin/env node
/**
 * compat-harness-surfaces.mjs —— harness UI 面清单棘轮 + sidebar 源码活判据
 *（compat 层：需要已安装的 `@deepseek-ai/dsh`；由 `.github/workflows/harness-compat.yml`
 *   在装好目标版本 harness 后调用，本地可手动跑，见 docs/TEST-LAYOUT.md。）
 *
 * 回答的问题：**harness 新增了页面/表面，我们的美化没覆盖** —— 插件自指断言查不出这类
 * 回归，必须把 harness 侧事实拉进判据：
 *
 *   ① **清单棘轮**：枚举已装 harness 的 `dsh-client-ui-*` 包集（harness 每个 UI 表面
 *      基本是一个独立包），与提交清单 `test/fixtures/harness-ui-surfaces.json`（每项带
 *      人的裁定 verdict）做差。**新表面未登记 ⇒ 红** —— 机器只判「新东西出现了」，
 *      盖不盖由人裁定，但裁定必须落盘；改名会被这条抓到（新名未登记），纯删除不拦。
 *      已知边界：包没变、包内新增页面这种情况本条查不出（页面级快照属下一档）。
 *
 *   ② **sidebar 活判据**：我们的 CSS 有 25 处选择器直接钉着
 *      `data-sidebar-right-panel` / `data-sidebar-right-open`，以及「收起时面板仍挂载、
 *      translate 滑出」的隐藏机制 —— 这些必须在**实际安装的源码**里仍然存在。
 *      上游 issue #107 那类回归（隐藏机制换代 ⇒ 美化失效）在此从注释里的散文引用
 *      变成对真源码的活断言。
 *
 * 缺前置（找不到已装 harness）= **默认红**（P3-13 口径，不与「通过」同形）：
 * 用 `DSH_WE_HARNESS_ROOT` 指定 dsh 包目录可绕过自动探测。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INVENTORY = join(ROOT, 'test', 'fixtures', 'harness-ui-surfaces.json');
const SURFACE_PREFIX = 'dsh-client-ui-';

// 我们 CSS 依赖的 sidebar 隐藏机制标记（0.1.5：容器 visibility:hidden + translate(100%) 滑出；
// 0.1.7 改为子元素 visibility:hidden，见上游 #107）。两条都不在 = 隐藏机制换代 ⇒ 红。
const HIDE_MARKERS = ['translate(100%)', 'visibility:hidden', 'visibility: hidden'];

const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  return Boolean(ok);
}

function walkJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJs(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 收集一棵子树里所有 `dsh-client-ui-*` 包目录（按包名取集合，去重）。 */
function collectSurfaces(searchRoots) {
  const found = new Map(); // name -> 任一所在路径
  const visit = (dir, depth) => {
    if (!existsSync(dir) || depth > 12) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(SURFACE_PREFIX) && !ent.name.startsWith('.')) {
        if (!found.has(ent.name)) found.set(ent.name, join(dir, ent.name));
      } else if (ent.name === 'node_modules' || ent.name === '@deepseek-ai' || !found.size) {
        visit(join(dir, ent.name), depth + 1);
      }
    }
  };
  for (const r of searchRoots) visit(r, 0);
  return found;
}

function resolveHarnessPkg() {
  const explicit = process.env.DSH_WE_HARNESS_ROOT;
  if (explicit) return explicit;
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return join(globalRoot, '@deepseek-ai', 'dsh');
  } catch (err) {
    return null;
  }
}

// ── 前置：找到已装 harness（找不到 = 红，不静默跳过）───────────────────────────
const harnessPkg = resolveHarnessPkg();
const harnessOk = Boolean(harnessPkg) && existsSync(join(harnessPkg, 'package.json'));
let harnessVersion = '?';
if (harnessOk) {
  try { harnessVersion = JSON.parse(readFileSync(join(harnessPkg, 'package.json'), 'utf8')).version || '?'; } catch { /* 下面的判据会红 */ }
}
if (!check('已装 harness 可定位（DSH_WE_HARNESS_ROOT 或 npm 全局）', harnessOk,
  harnessOk ? `${harnessPkg} @ ${harnessVersion}` : '找不到 @deepseek-ai/dsh —— 装一个或设 DSH_WE_HARNESS_ROOT')) {
  console.log(`\nHARNESS SURFACES FAILED — ${results.filter((ok) => !ok).length}/${results.length} 条判据不成立`);
  process.exit(1);
}

// ── ① 清单棘轮 ────────────────────────────────────────────────────────────────
let inventory = null;
try { inventory = JSON.parse(readFileSync(INVENTORY, 'utf8')); } catch { inventory = null; }
const known = inventory && typeof inventory.known === 'object' && inventory.known ? inventory.known : {};
const inventoryOk = check('提交清单可解析且非空（known 表是裁定的唯一真源）',
  Object.keys(known).length > 0 && inventory.meta && typeof inventory.meta.seededFrom === 'string',
  INVENTORY);
if (inventoryOk) {
  const badKeys = Object.keys(known).filter((k) => !k.startsWith(SURFACE_PREFIX));
  check('清单键全部是 dsh-client-ui-* 表面（命名空间写错 = 那条裁定永不生效）',
    badKeys.length === 0, badKeys.length ? '越界键：' + badKeys.join(', ') : Object.keys(known).length + ' 个键');
  const badVerdicts = Object.entries(known)
    .filter(([, v]) => !v || !['covered', 'native', 'exempt'].includes(v.verdict));
  check('每个裁定都带合法 verdict（covered / native / exempt）',
    badVerdicts.length === 0, badVerdicts.length ? '非法项：' + badVerdicts.map(([k]) => k).join(', ') : '全部合法');
}

// 两个搜索根覆盖 npm 的两种布局：依赖**嵌套**在 dsh 包内（全局安装的常态）时看 root1；
// 依赖被**提升**成兄弟目录（npm --prefix / CI 缓存安装）时看 root2（dsh 所在的 scope 目录）。
const surfaces = collectSurfaces([join(harnessPkg, 'node_modules'), join(harnessPkg, '..')]);
check('已装 harness 里能枚举到 UI 表面（枚举器空转 = 判据失效）',
  surfaces.size >= 10, surfaces.size + ' 个 dsh-client-ui-* 包');

const newSurfaces = [...surfaces.keys()].filter((s) => !(s in known)).sort();
check('没有未登记的新 UI 表面（新表面必须显式裁定：补美化或写豁免）',
  inventoryOk && surfaces.size >= 10 && newSurfaces.length === 0,
  newSurfaces.length ? '未登记：' + newSurfaces.join(', ') : '清单已覆盖全部 ' + surfaces.size + ' 个');
const stale = Object.keys(known).filter((s) => !surfaces.has(s));
if (stale.length) {
  console.log('  ℹ️ 清单里有 ' + stale.length + ' 个表面不在本机已装 harness（版本差集：本机 harness 较旧或上游已删/改名；改名会以「新表面未登记」被抓到）：'
    + stale.slice(0, 6).join(', ') + (stale.length > 6 ? ' …' : ''));
}

// ── ② sidebar 源码活判据（对真源码，不是散文引用）─────────────────────────────
const sidebarDir = surfaces.get(SURFACE_PREFIX + 'sidebar-right');
if (check('dsh-client-ui-sidebar-right 在已装 harness 中（我们 25 处选择器依赖它）',
  Boolean(sidebarDir), sidebarDir || '包缺失 —— 右栏美化所依赖的表面不存在了')) {
  const src = walkJs(sidebarDir).map((f) => readFileSync(f, 'utf8')).join('\n');
  check('属性锚点 data-sidebar-right-panel 仍在源码中（CSS 选择器直接钉它）',
    src.includes('data-sidebar-right-panel'));
  check('属性锚点 data-sidebar-right-open 仍在源码中（开合态选择器直接钉它）',
    src.includes('data-sidebar-right-open'));
  const mechanism = HIDE_MARKERS.filter((m) => src.includes(m));
  check('隐藏机制仍是已知形态之一（translate 滑出 / visibility 切换；都不在 = 机制换代）',
    mechanism.length > 0, mechanism.length ? '命中：' + mechanism.join(' + ')
      : '已知标记全不在 —— 上游换了隐藏机制，美化适配需复核（#107 型回归）');
}

const failed = results.filter((ok) => !ok).length;
if (failed) console.log(`\nHARNESS SURFACES FAILED — ${failed}/${results.length} 条判据不成立`);
else console.log(`\nHARNESS SURFACES PASSED — ${results.length} 条判据全部成立（harness ${harnessVersion}，表面 ${surfaces.size} 个）`);
process.exit(failed ? 1 : 0);
