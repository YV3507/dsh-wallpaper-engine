#!/usr/bin/env node
/**
 * 文档一致性护栏 (docs & comments drift guard)
 *
 * 背景：本仓库是"代码即真相"模式（docs/README.md 的约定）—— 渲染 / 逆向 / 根因知识内联
 * 在代码注释里，docs/ 只留决策与用户文档。但正因如此，**大重构之后 docs/ 与注释最容易
 * 停留在旧世界**：beta 场景动画整体移除、WebWallGL 实时渲染成为默认显示形态、
 * 「壁纸画面刷新」改名「出图来源」、「调优项」占位行并入组标题 …… 这些改动都不会
 * 让任何一条既有验收链变红（它们只断言代码行为，不读文档）。
 *
 * 本脚本只断死**可机械判定**的四类漂移，不试图评价文风：
 *   G1 相对链接 / 图片指向仓库里不存在的文件（含"检查数下限"，防止空转）
 *   G2 docs/README.md（索引）漏列实际存在的 docs/*.md
 *   G3 已删除/已改名的功能以"现有功能"的口气出现在**面向当前版本**的文档里
 *      （允许写历史 —— 同一行有历史标记即可）
 *   G4 面向当前版本的文档缺失最关键的现状事实（默认显示形态 = 实时渲染；路由表含两条链）
 *   G5 构建产物里不得再出现旧 UI 名字符串（注释里作为历史引用是允许的）
 *
 * 每条断言都带**负对照**：把同一段判定逻辑喂给人工改坏的文本，必须被判红 ——
 * 否则断言可能只是恒真/恒假（见 CATCHUP 五之十四记的"负对照空转"教训）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS | ' + name + (detail ? ' | ' + detail : ''));
  else { console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); failed++; }
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── 文档清单 ────────────────────────────────────────────────────────────────
// 面向**当前版本**的文档：用户看的门面 + 排障/升级/架构说明 + 文档索引。
// 允许写历史的：CHANGELOG（变更记录本身就是历史）、archived 的交接手记、
// AUDIT/PERF/FEASIBILITY 这类当时状态的快照 —— 它们**不在**本清单里。
const CURRENT_DOCS = [
  'README.md',
  'README.en.md',
  'README.beginner.md',
  'docs/README.md',
  'docs/HOW-IT-WORKS.md',
  'docs/TROUBLESHOOTING.md',
  'docs/UPGRADING.md',
];
const LINK_DOCS = [...CURRENT_DOCS, 'CONTRIBUTING.md', 'docs/CHANGELOG.md',
  'docs/DEFAULT-SCENE-RENDER-AUDIT.md', 'docs/RENDERER-FEASIBILITY.md',
  'docs/ROBUSTNESS-AUDIT.md', 'docs/SCENE-FRAME-PERF.md',
  'docs/SCENE-ANIMATION-HANDOFF.md', 'docs/awesome-dsh-plugin-pr-guide.md'];

// ── G1 相对链接必须存在 ─────────────────────────────────────────────────────
// 死链是最典型的"文档腐烂"，且完全可机械判定。只在**仓库内**相对链接上断言
// （http(s) / mailto / 纯锚点 / 以 / 开头的绝对 URL 一律跳过）。
function badLinks(rel, text) {
  const bad = [];
  const base = dirname(rel);
  const re = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(text))) {
    let t = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(t)) continue;
    if (t.startsWith('/') || t.startsWith('<')) continue;
    const hash = t.indexOf('#');
    if (hash >= 0) t = t.slice(0, hash);
    if (!t) continue;
    try { t = decodeURIComponent(t); } catch { /* 保留原样 */ }
    const abs = resolve(ROOT, base, t);
    if (!existsSync(abs)) bad.push(m[1]);
  }
  return bad;
}
{
  const bad = [];
  let checked = 0;
  for (const rel of LINK_DOCS) {
    const text = read(rel);
    checked += [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].length;
    for (const b of badLinks(rel, text)) bad.push(rel + ' → ' + b);
  }
  // 负对照：死链必须被抓到；真链（docs/UPGRADING.md 里确实存在的那个）不能被误判。
  const decoy = '# t\n\n[真](./CHANGELOG.md) [假](./NO-SUCH-DOC.md)\n';
  const badDecoy = badLinks('docs/README.md', decoy);
  check('G1 文档相对链接全部指向仓库内存在的文件',
    bad.length === 0 && checked >= 20 && badDecoy.length === 1 && badDecoy[0] === './NO-SUCH-DOC.md',
    `检查 ${checked} 条链接, 死链 ${bad.length}${bad.length ? ': ' + bad.join(', ') : ''}` +
    ` · 负对照 ${badDecoy.length}/1`);
}

// ── G2 索引不能漏列文档 ─────────────────────────────────────────────────────
// docs/README.md 是唯一入口；新文档不入索引 = 没人会读到它（也无法被审阅）。
function missingFromIndex(indexText, files) {
  return files.filter((f) => !indexText.includes(f));
}
{
  const indexText = read('docs/README.md');
  const files = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const missing = missingFromIndex(indexText, files);
  const missingDecoy = missingFromIndex(indexText, [...files, 'GHOST-DOC.md']);
  check('G2 docs/README.md 索引收录全部 docs/*.md',
    missing.length === 0 && missingDecoy.length === 1 && missingDecoy[0] === 'GHOST-DOC.md',
    `docs/*.md 共 ${files.length} 份${missing.length ? ', 漏列: ' + missing.join(', ') : ''}` +
    ` · 负对照 ${missingDecoy.length}/1`);
}

// ── G3 已删除 / 已改名的功能不得以现状口径出现 ───────────────────────────────
// 同一行带历史标记（已删除/已改名/原名/退役/历史/removed…）时放行 —— 文档理应能记述历史。
const HIST = /已删除|已移除|已退役|已归档|已改名|已并入|原名|旧名|历史|存档|移除|退役|removed|retired|archived|legacy|renamed/i;
const FORBIDDEN = [
  ['beta 场景动画（整体移除）', /scene-anim|betaSceneAnim|sceneAnimProgress|sceneAnimLoop|apng-encode|framesDir|frameDelayMs/],
  ['「壁纸画面刷新」旧名（现名「出图来源」）', /壁纸画面刷新/],
  ['「调优项」占位行（已并入组标题）', /调优项/],
];
function vocabHits(rel, text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [what, re] of FORBIDDEN) {
      if (re.test(line) && !HIST.test(line)) out.push(`${rel}:${i + 1} ${what} :: ${line.trim().slice(0, 80)}`);
    }
  });
  return out;
}
{
  const hits = [];
  for (const rel of CURRENT_DOCS) hits.push(...vocabHits(rel, read(rel)));
  // 负对照：现状口径的旧名字必须被抓到；带历史标记的同一句必须放行。
  const decoyBad = vocabHits('X.md', '用 /scene-anim 路由渲染动画，并点「调优项」调优。\n');
  const decoyOk = vocabHits('X.md', '`/scene-anim`（已删除）与「调优项」（原名，已并入组标题）。\n');
  check('G3 面向当前版本的文档不把已删除/已改名的功能写成现状（带历史标记的记述放行）',
    hits.length === 0 && decoyBad.length === 2 && decoyOk.length === 0,
    `${CURRENT_DOCS.length} 份文档, 命中 ${hits.length}${hits.length ? ': ' + hits.join(' | ') : ''}` +
    ` · 负对照 应当抓 ${decoyBad.length}/2, 应当放 ${decoyOk.length}/0`);
}

// ── G4 关键现状事实必须出现在对应文档里 ─────────────────────────────────────
// 只保留"少了就是误导"的事实，不做文风要求：
//   · 门面（中英）：场景壁纸的默认显示形态是**实时渲染**（旧定位是"提取静态帧"）
//   · 架构文档：两条渲染路线的路由都要在（/scene-live 与 /scene-frame）
const REQUIRED = [
  ['README.md', /实时渲染/, '场景壁纸默认走 WebWallGL 实时渲染'],
  ['README.en.md', /live[- ]?render|real-?time render/i, '场景壁纸默认走 WebWallGL 实时渲染'],
  ['docs/HOW-IT-WORKS.md', /\/scene-live/, '实时渲染路由'],
  ['docs/HOW-IT-WORKS.md', /\/scene-frame/, '静态帧路由'],
];
{
  const miss = [];
  for (const [rel, re, what] of REQUIRED) if (!re.test(read(rel))) miss.push(`${rel} 缺 ${what}`);
  // 负对照：把 REQUIRED 的判据喂给删掉该词的文本，必须报缺。
  const decoyMiss = REQUIRED.filter(([rel, re]) => !re.test(read(rel).replace(/实时渲染|\/scene-live|\/scene-frame|live[- ]?render|real-?time render/gi, '')));
  check('G4 关键现状事实在对应文档中存在（门面提实时渲染；架构文档含两条路由）',
    miss.length === 0 && decoyMiss.length === REQUIRED.length,
    `${REQUIRED.length} 条事实${miss.length ? ', 缺: ' + miss.join('; ') : ''}` +
    ` · 负对照 应当全缺 ${decoyMiss.length}/${REQUIRED.length}`);
}

// ── G5 构建产物里不得残留旧 UI 名字符串 ─────────────────────────────────────
// 只咬**字符串字面量**（`"壁纸画面刷新` / `"调优项`）：注释里作为历史对照引用是
// 正当的（本仓库大量注释这样做），故不能用裸词判定 —— 与 verify-prewarm R38b 同规矩。
{
  const cli = read('lib/client.js');
  const bad = ['"壁纸画面刷新', '"调优项'].filter((s) => cli.includes(s));
  const decoy = ['const a = "壁纸画面刷新";', 'const b = "调优项";']
    .filter((s) => ('x ' + s).includes('"壁纸画面刷新') || s.includes('"调优项'));
  check('G5 构建产物中不再出现旧 UI 名字符串（注释里的历史引用不受影响）',
    bad.length === 0 && decoy.length === 2,
    bad.length ? '残留: ' + bad.join(', ') : '无残留 · 负对照 ' + decoy.length + '/2');
}

// ── G6 路由表不能腐烂 ───────────────────────────────────────────────────────
// docs/HOW-IT-WORKS.md 的宿主/客户端分工表是唯一的 HTTP 路由总览。路由增删**不会**
// 让任何行为断言变红 —— 文档只会悄悄变成谎言（上游删掉 /scene-anim 后文档还在介绍它，
// 而 /scene-live、/scene-files 这两条**现行主路径**曾经完全不在表里）。故双向断死：
//   ①文档里写出的每条 /wallpaper-engine/<seg> 都必须在 lib/index.js 里有对应注册；
//   ②关键路由必须在文档里被列出（缺了就是"看不懂现在的架构"）。
const REQUIRED_ROUTES = [
  'scene-live', 'scene-files', 'scene-frame', 'scene-video', 'scene-audio',
  'custom-frame', 'scene-manifest', 'scene-resource', 'settings', 'inventory',
  'web', 'media', 'preview', 'video-preview', 'upload', 'remove', 'upload-dir',
  'transcoded', 'transcode-progress', 'media-info',
];
// 历史行（提到已删路由）放行，规则同 G3。
function docRouteSegs(text) {
  const out = new Set();
  text.split(/\r?\n/).forEach((line) => {
    if (HIST.test(line)) return;
    for (const m of line.matchAll(/\/wallpaper-engine\/([a-z][a-z0-9-]*)/g)) out.add(m[1]);
  });
  return [...out];
}
function phantomRoutes(docText, hostText) {
  // 宿主侧两种写法都算注册：`${BASE}/<seg>` 与白名单数组里的 '<seg>'（media/preview）。
  return docRouteSegs(docText).filter((seg) => !hostText.includes('${BASE}/' + seg) && !hostText.includes(`'${seg}'`));
}
function undocumentedRoutes(docText, required) {
  // ⚠️ 必须匹配**路由形式** `/wallpaper-engine/<seg>`，不能用裸词 includes ——
  // 裸词会被同名文件命中（例如 `scripts/verify-scene-live.mjs` 里有 "scene-live"），
  // 那样的负对照是空的（改坏文档也照样通过）。
  return required.filter((seg) => !docText.includes('/wallpaper-engine/' + seg));
}
{
  const doc = read('docs/HOW-IT-WORKS.md');
  const host = read('lib/index.js');
  const phantom = phantomRoutes(doc, host);
  const missing = undocumentedRoutes(doc, REQUIRED_ROUTES);
  // 负对照：①凭空插入一条不存在的路由必须被抓到；②从文档里删掉一条关键路由必须报缺。
  const phantomDecoy = phantomRoutes(doc.replace('/wallpaper-engine/inventory', '/wallpaper-engine/ghost-route'), host);
  const missingDecoy = undocumentedRoutes(doc.replace(/\/scene-live/g, '/scene-liv'), REQUIRED_ROUTES);
  check('G6 路由表双向一致: 文档写出的路由都存在, 关键路由都在文档里',
    phantom.length === 0 && missing.length === 0
    && phantomDecoy.includes('ghost-route') && missingDecoy.includes('scene-live'),
    `文档路由 ${docRouteSegs(doc).length} 条${phantom.length ? ', 幽灵路由: ' + phantom.join(', ') : ''}` +
    `${missing.length ? ' · 未记录: ' + missing.join(', ') : ''}` +
    ` · 负对照 幽灵 ${phantomDecoy.includes('ghost-route') ? 1 : 0}/1 · 漏记 ${missingDecoy.includes('scene-live') ? 1 : 0}/1`);
}

console.log(failed === 0 ? '\nverify-docs: OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
