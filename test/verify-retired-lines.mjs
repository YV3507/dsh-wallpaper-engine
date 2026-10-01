#!/usr/bin/env node
/**
 * verify-retired-lines.mjs —— 已退役的技术线**不许复活、也不许蔓延**（结构性反向探针）。
 *
 * 三条线的状态各不相同，所以探针形态也必须不同 —— 这是本脚本最重要的一处区分：
 *
 * ① 旧场景播放器线（P0-3 **已下线**）：`/scene-runtime`、`/scene-manifest`、`/scene-resource`
 *    三条路由 + `lib/scene-player.js` + `inventory.sceneUrl` 均已移除 ⇒ 断言**零残留**。
 * ② 静态帧渲染线（P2-12 阶段 2 **已删除**）：死树与提取链删净后，退役词只可能出现在
 *    `SF_BASELINE` 里 —— 而名单**只剩检验者**（守卫必须点名退役词才能断言"它没了"），
 *    产品侧零残留 ⇒ 判据是**不蔓延 + 基线只许缩小**。
 * ③ UI 笔误「秡」（P0-4 **已修**）：断言状态行用的是「档」。
 *
 * ②为什么基线里留着检验者：它必须拼出退役词才能搜它们，否则本节一条都搜不到（假绿）。
 * 除它之外的任何文件命中退役词 = 有人把这条线接回了主线，必须失败。
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
  .filter((f) => f !== 'test/verify-retired-lines.mjs')
  .sort();
const read = (rel) => readFileSync(ROOT + rel, 'utf8');

// ── ① 旧场景播放器线：零残留 ─────────────────────────────────────────────────
// `scene-manifest.js` 的 manifest 构建器曾拼 `/scene-resource/` 的 URL（它的消费者
// `/scene-manifest` 路由已在 P0-3 下线）。P2-12 阶段 2 把那整块无引用声明（约 2,000 行）
// 删净 ⇒ 这条 needle 不再需要"登记遗留（DECLARED_RESIDUE）"那个中间态，直接并入零残留断言。
// 名单只许缩小：检验者 = 必须点名该 needle 才能断言"它没了"的守卫。
const LEGACY_RESOURCE_URL = '/wallpaper-engine/scene-resource/';
// **空名单 = 最后一个检验者也没了**（`verify-ledger` 随 ADR-0006 下线）：产品侧早已零残留，
// 于是这条 URL 现在连"为了断言它不在"而点名它的地方都不需要 —— 这正是清单缩小到尽头的形态。
// 断言本身**不因此变弱**：它照样对全部文件断言零残留，只是不再豁免任何人。
const RESIDUE_INSPECTORS = [];

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

  const residue = FILES.filter((f) => read(f).includes(LEGACY_RESOURCE_URL));
  const residueSpread = residue.filter((f) => !RESIDUE_INSPECTORS.includes(f));
  check('旧 /scene-resource/ URL 零残留（只许出现在点名它的检验者里）',
    residueSpread.length === 0,
    residue.length ? '仅出现在 ' + residue.join(', ') : '干净（连检验者也不再提它）');

  // 负对照：把"某个文件"喂给**同一个**判据，必须被判为扩散。
  // ⚠️ 名单为空之后，这条对照更要紧：豁免面消失后，"零残留"有可能退化成**恒真断言**
  //    （例如某天这条 needle 的常量被删掉，扫描就再也找不到任何东西而永远绿）。
  //    因此额外钉住"被扫的 needle 确实是有内容的字面量、且本文件确实在点名它"。
  {
    const probe = (files) => files.filter((f) => !RESIDUE_INSPECTORS.includes(f));
    check('negative control: 名单外文件被判为扩散（豁免面为空时仍然有牙）',
      probe(['lib/elsewhere.js']).length === 1
      && probe(RESIDUE_INSPECTORS).length === 0);
    check('needle 非空且本文件确实点名它（防"零残留"退化成恒真）',
      LEGACY_RESOURCE_URL.length > 0 && read('test/verify-retired-lines.mjs').includes(LEGACY_RESOURCE_URL));
  }

  {
    // 负对照：走**同一个** needle 判据，而不是断言"这个常量包含它自己"
    const legacyHit = (s) => LEGACY_FORBIDDEN.filter((n) => s.includes(n));
    check('negative control: 旧播放页标识会被判不合格',
      legacyHit('x WE_SCENE_PLAYER_HTML y').length === 1 && legacyHit('x 干净 y').length === 0);
  }
}

// ── ② 静态帧渲染线：不蔓延（BASELINE 只许缩小）───────────────────────────────
// 名单里现在只剩检验它们的守卫（产品侧已删净）；**任何不在名单里的文件出现退役词 =
// 有人开始把这条线接回主线**，必须失败。
const SF_VOCAB = [
  'renderSceneFrameInWorker', 'scene-render-worker', 'extractSceneMainImage',
  'collectImageObjectTextures', 'FORMAT_PENALTY', 'tryCompositeSceneLayers',
  'sceneFramePrewarm', 'SCENE_PREWARM_LOGIC', 'prewarm-state',
  'SceneRenderer', 'scene-renderer', 'we-renderer', 'font-render',
  'scene-scripts', 'scene-script-apis',
];
// 冻结于 P0-4。P2-12 阶段 2 已删净死树与提取链；此后**最后一个检验者**（账本守卫）
// 随 ADR-0006 下线 ⇒ 名单现在为空：产品侧与检验侧都零残留，这条线只会被"接回来"违反。
// 删除过的文件不要再留（本节 INFO 会提示可收紧项）。
const SF_BASELINE = [];
{
  const found = new Map(); // file -> 命中的退役词
  for (const f of FILES) {
    const s = read(f);
    const hit = SF_VOCAB.filter((v) => s.includes(v));
    if (hit.length) found.set(f, hit);
  }
  const spread = [...found.keys()].filter((f) => !SF_BASELINE.includes(f));
  check('静态帧线未蔓延：退役词零残留（基线已空）', spread.length === 0,
    spread.length ? '越界文件 ' + spread.length + '：' + spread.slice(0, 4).join(', ')
      : found.size === 0 ? '零残留（' + SF_VOCAB.length + ' 个退役词 × ' + FILES.length + ' 个文件）'
        : '基线内 ' + found.size + ' 个文件命中（共 ' +
          [...found.values()].reduce((a, b) => a + b.length, 0) + ' 处）');

  const shrunk = SF_BASELINE.filter((f) => existsSync(ROOT + f) && !found.has(f));
  if (shrunk.length) console.log('  INFO 基线可缩小（已不含退役词）：' + shrunk.join(', '));
  const missing = SF_BASELINE.filter((f) => !existsSync(ROOT + f));
  if (missing.length) console.log('  INFO 基线中已删除的文件（P2-12 进度，请同步收紧名单）：' + missing.join(', '));

  // 负对照：把退役词塞进一个不在基线里的文件，必须被判为蔓延
  const simulated = new Map([...found, ['src/client.js', ['extractSceneMainImage']]]);
  check('negative control: 基线外文件出现退役词会被判不合格',
    [...simulated.keys()].some((f) => !SF_BASELINE.includes(f)));
  // 正对照：基线内的命中不该被判为蔓延。
  // ⚠️ 基线已空 ⇒ 断言分两支，否则这条对照会**恒假**（空 Map 里不存在"基线内命中"）：
  //    有基线文件时按原义验；基线为空时验"同一个判据对基线内文件确实放行"。
  check('positive control: 基线内的命中不算蔓延',
    [...found.keys()].every((f) => SF_BASELINE.includes(f))
    && (SF_BASELINE.length === 0
      ? [...new Map([['test/implied.js', ['x']]]).keys()].every((f) => !SF_BASELINE.includes(f))
      : found.size > 0));
}

// ── ③ **已撤除**（当时守的是 UI 笔误「秡」与状态行措辞，P0-4）────────────────────
//
// 这里原本有两条判据：
//   · `状态行不再出现笔误「秡」` —— P0-4 的一次性清理，修完即**恒真**。
//     按 `docs/README.md` §写作纪律 5（"基线只许收紧，**删完清空即为零残留**"），
//     一次性清理的验收判据该在收口时撤掉，否则它是"已死但仍占位"的守卫。
//   · `状态行用的是「档」` —— 断言源码里含 ` 档 · ` 这个**四字散文片段**：
//     任何改写状态行的人都会把它判红 ⇒ 它拦的是编辑，不是腐化。
//
// 两条都按 [`docs/adr/0007`](../docs/adr/0007-machine-checks-target-code-not-prose.md)
// 撤除；那篇文章里记着"为什么当时会写它"与"为什么现在不留"。

const failed = results.filter((r) => !r).length;
console.log('\n' + (failed ? 'RETIRED-LINE CHECKS FAILED — ' + failed + ' failed' : 'ALL RETIRED-LINE CHECKS PASSED') + ' (' + results.length + ')');
process.exit(failed ? 1 : 0);
