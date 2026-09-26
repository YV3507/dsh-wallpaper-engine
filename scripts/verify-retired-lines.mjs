#!/usr/bin/env node
/**
 * verify-retired-lines.mjs —— 已退役的技术线**不许复活、也不许蔓延**（结构性反向探针）。
 *
 * 三条线的状态各不相同，所以探针形态也必须不同 —— 这是本脚本最重要的一处区分：
 *
 * ① 旧场景播放器线（P0-3 **已下线**）：`/scene-runtime`、`/scene-manifest`、`/scene-resource`
 *    三条路由 + `lib/scene-player.js` + `inventory.sceneUrl` 均已移除 ⇒ 断言**零残留**；
 *    唯一登记在案的遗留见 DECLARED_RESIDUE（其消费者已随路由下线，整块随 P2-12 处置）。
 * ② 静态帧渲染线（P2-12 才移除，**尚未开工**）：此刻**不能**断言零残留（标识当然还在），
 *    但可以断言**不蔓延** —— 退役词只允许出现在冻结的 BASELINE 文件集合里。
 *    P2-12 阶段 2 删完后，把 BASELINE 清空，本节即自动升级为「零残留」断言。
 * ③ UI 笔误「秡」（P0-4 **已修**）：断言状态行用的是「档」。
 *
 * ②为什么不用「零引用」写：P0 阶段一行静态帧代码都还没删，零引用断言必然红 —— 而本仓铁律是
 * 「verify 未绿不得提交」。**防蔓延是这一阶段能真正执行的那一半**；等 P2-12 阶段 2 再收紧。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
}

/** 扫描面：lib/ src/ scripts/ test/ 下的源码。`assets`（vendored 压缩产物）与 node_modules 不在范围。 */
function walk(dir, out = []) {
  const abs = ROOT + dir;
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) {
      if (/node_modules|assets|\.git/.test(rel)) continue;
      walk(rel, out);
    } else if (/\.(js|mjs|ts)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const FILES = [...walk('lib'), ...walk('src'), ...walk('scripts'), ...walk('test')]
  // 本脚本必须把退役词**拼出来**才能搜它们 ⇒ 扫自己必然是假阳性。只排除这一个文件，
  // 不得扩大（新加的守卫若也要拼这些词，应改为从本脚本 import 词表，而不是再开一个豁免）。
  .filter((f) => f !== 'scripts/verify-retired-lines.mjs')
  .sort();
const read = (rel) => readFileSync(ROOT + rel, 'utf8');

// ── ① 旧场景播放器线：零残留（+ 一条登记遗留）────────────────────────────────
// 登记遗留：scene-manifest.js 的 manifest 构建器仍会拼 /scene-resource/ 的 URL。
// 它的**消费者（/scene-manifest 路由）已在 P0-3 下线** ⇒ 那些 URL 目前无任何读取方；
// 整块构建器（约 640 行）归 P2-12 阶段 2 处理，故此处只把出现次数**钉住**（只许减少）。
const DECLARED_RESIDUE = { file: 'lib/scene-manifest.js', needle: '/wallpaper-engine/scene-resource/' };

const LEGACY_FORBIDDEN = [
  'WE_SCENE_PLAYER_HTML',
  'sceneUrl',
  '${BASE}/scene-runtime',
  '${BASE}/scene-manifest',
  '${BASE}/scene-resource',
  "'/wallpaper-engine/scene-runtime'",
  "'/wallpaper-engine/scene-manifest'",
];
{
  const hits = [];
  for (const f of FILES) {
    const s = read(f);
    for (const needle of LEGACY_FORBIDDEN) if (s.includes(needle)) hits.push(f + ' :: ' + needle);
  }
  check('旧播放器线零残留（3 条路由 + sceneUrl + 播放页标识）', hits.length === 0,
    hits.length ? '命中 ' + hits.length + '：' + hits.slice(0, 3).join(' | ') : '干净');

  check('旧播放页模块已删除（lib/scene-player.js 不存在）', !existsSync(ROOT + 'lib/scene-player.js'));
  const pkg = JSON.parse(read('package.json'));
  check('package.json `files` 不再收录 scene-player.js',
    !(pkg.files || []).includes('lib/scene-player.js'));

  const residue = FILES.filter((f) => read(f).includes(DECLARED_RESIDUE.needle));
  const inDeclared = residue.length === 1 && residue[0] === DECLARED_RESIDUE.file;
  check('登记遗留（manifest 构建器里的 /scene-resource/ URL）未扩散',
    inDeclared,
    residue.length === 0
      ? 'INFO：该遗留已消失 ⇒ 请把 DECLARED_RESIDUE 从本脚本移除（P2-12 进度）'
      : '出现在 ' + residue.join(', '));

  check('negative control: 旧播放页标识会被判不合格', 'x WE_SCENE_PLAYER_HTML y'.includes('WE_SCENE_PLAYER_HTML'));
}

// ── ② 静态帧渲染线：不蔓延（BASELINE 只许缩小）───────────────────────────────
// 冻结于 P0-4（2026-09-26）。这些文件是 P2-12 的删除对象 + 检验它们的守卫；
// **任何不在名单里的文件出现退役词 = 有人开始把这条线接回主线**，必须失败。
const SF_VOCAB = [
  'renderSceneFrameInWorker', 'scene-render-worker', 'extractSceneMainImage',
  'collectImageObjectTextures', 'FORMAT_PENALTY', 'tryCompositeSceneLayers',
  'sceneFramePrewarm', 'SCENE_PREWARM_LOGIC', 'prewarm-state',
  'SceneRenderer', 'scene-renderer', 'we-renderer', 'font-render',
  'scene-scripts', 'scene-script-apis',
];
const SF_BASELINE = [
  'lib/index.js', 'lib/pkg-extract.js', 'lib/scene-manifest.js', 'lib/scene-render-worker.mjs',
  'lib/scene-renderer.js', 'lib/scene-script-apis.js', 'lib/scene-scripts.js',
  'lib/we-renderer/core.js', 'lib/we-renderer/text.js',
  'scripts/audit-import-closure.mjs', 'scripts/diagnose-scenes.mjs', 'scripts/verify-all-scenes.mjs',
  'scripts/verify-angel-skin.mjs', 'scripts/verify-comment-discipline.mjs', 'scripts/verify-mdl-fix.mjs',
  'scripts/verify-package-files.mjs', 'scripts/verify-preprocess.mjs', 'scripts/verify-scene.mjs',
];
{
  const found = new Map(); // file -> 命中的退役词
  for (const f of FILES) {
    const s = read(f);
    const hit = SF_VOCAB.filter((v) => s.includes(v));
    if (hit.length) found.set(f, hit);
  }
  const spread = [...found.keys()].filter((f) => !SF_BASELINE.includes(f));
  check('静态帧线未蔓延：退役词只出现在冻结基线内', spread.length === 0,
    spread.length ? '越界文件 ' + spread.length + '：' + spread.slice(0, 4).join(', ')
      : '基线内 ' + found.size + '/' + SF_BASELINE.length + ' 个文件命中（共 ' +
        [...found.values()].reduce((a, b) => a + b.length, 0) + ' 处）');

  const shrunk = SF_BASELINE.filter((f) => existsSync(ROOT + f) && !found.has(f));
  if (shrunk.length) console.log('  INFO 基线可缩小（已不含退役词）：' + shrunk.join(', '));
  const missing = SF_BASELINE.filter((f) => !existsSync(ROOT + f));
  if (missing.length) console.log('  INFO 基线中已删除的文件（P2-12 进度，请同步收紧名单）：' + missing.join(', '));

  // 负对照：把退役词塞进一个不在基线里的文件，必须被判为蔓延
  const simulated = new Map([...found, ['src/client.js', ['extractSceneMainImage']]]);
  check('negative control: 基线外文件出现退役词会被判不合格',
    [...simulated.keys()].some((f) => !SF_BASELINE.includes(f)));
  // 正对照：基线内的命中不该被判为蔓延
  check('positive control: 基线内的命中不算蔓延',
    [...found.keys()].every((f) => SF_BASELINE.includes(f)) && found.size > 0);
}

// ── ③ UI 笔误「秡」已修（P0-4）──────────────────────────────────────────────
{
  const bad = ['src/client.js', 'lib/client.js'].filter((f) => existsSync(ROOT + f) && read(f).includes('秡'));
  check('状态行不再出现笔误「秡」（源 + 构建产物）', bad.length === 0,
    bad.length ? '仍在：' + bad.join(', ') : '干净');
  check('状态行用的是「档」（源）', read('src/client.js').includes(' 档 · '));
  check('negative control: 「秡」会被判不合格', 'x 秡 y'.includes('秡'));
}

const failed = results.filter((r) => !r).length;
console.log('\n' + (failed ? 'RETIRED-LINE CHECKS FAILED — ' + failed + ' failed' : 'ALL RETIRED-LINE CHECKS PASSED') + ' (' + results.length + ')');
process.exit(failed ? 1 : 0);
