/**
 * verify-ledger.mjs — 账本自检（P1-8）：断言 docs/REFACTOR-ASSESSMENT.md §5 的
 * **状态列与仓库实际一致**，防止账本说谎（"✅ 但代码里没有" / "⬜ 但其实已经做了"）。
 *
 * 为什么需要：账本自己写着"状态列是唯一进度真源"。真源一旦能写错，后面所有基于它的
 * 判断（还要不要做、能不能提交）都会跟着错。所以把每个条目的**可核证据**写成断言，
 * 让状态列变成机器可核的事实。
 *
 * 判据：
 *   · 行状态 ✅ ⇒ 该条目的**全部**证据必须成立；
 *   · 行状态 ⬜/🚧 ⇒ 证据必须**不全部**成立（否则就是"做完了没翻状态"）。
 *   没有写证据的条目（还没有可核产物）会被列出并在输出里标注 —— 宁可显式承认"未覆盖"，
 *   也不做一条恒真的假断言。
 *
 * 自带负对照：对"篡改过的账本文本"跑同一套判据，必须能报出问题（否则判据没牙）。
 *
 * Usage:  node scripts/verify-ledger.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve0();
function resolve0() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

const LEDGER = join(root, 'docs', 'REFACTOR-ASSESSMENT.md');

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const has = (rel) => existsSync(join(root, rel));

/** 证据判据：每条返回 true 表示"这件事在仓库里已经成立"。 */
const EVIDENCE = {
  'P0-1': [
    ['CI 工作流在位', () => has('.github/workflows/verify.yml')],
    ['CI 里确实跑 verify + 产物同步检查', () => {
      const y = read('.github/workflows/verify.yml');
      return y.includes('npm run verify') && y.includes('git diff --exit-code -- lib/client.js');
    }],
  ],
  'P0-2': [
    ['死依赖 jpeg-js 已移除', () => !('jpeg-js' in JSON.parse(read('package.json')).dependencies)],
    ['吉祥物源资产已归档（不是删除）', () => has('assets/mascot') && has('assets/mascot/README.md')],
  ],
  'P0-3': [
    ['旧场景播放器已删除', () => !has('lib/scene-player.js')],
    ['三条孤儿路由已下线', () => {
      const h = read('lib/index.js');
      return !h.includes('scene-runtime') && !h.includes('scene-manifest\')');
    }],
  ],
  'P0-4': [
    ['退役行守卫在位', () => has('scripts/verify-retired-lines.mjs')],
    ['退役行守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-retired-lines')],
  ],
  'P1-5': [
    ['设置唯一真源在位', () => has('lib/settings-schema.js')],
    ['宿主改为派生（不再手写逐键白名单）', () => {
      const h = read('lib/index.js');
      return h.includes("sanitizeFromSchema(raw, 'host')") && !/clampNum\(o\./.test(h);
    }],
    ['客户端改为派生', () => {
      const c = read('src/client.js');
      return c.includes('sanitizeFromSchema(o, "client")') && c.includes('serializeSettings(selection)')
        && !/clampNum\(o\./.test(c);
    }],
    ['schema 已被内联进产物', () => read('lib/client.js').includes('const KINDS = {')],
  ],
  'P1-6': [
    ['缓存键只剩一个构造点（sceneFrameSlot 不再自带版本前缀）', () => {
      const h = read('lib/index.js');
      const at = h.indexOf('function sceneFrameSlot(');
      if (at < 0) return false;
      const end = h.indexOf('\n}', at);
      return !h.slice(at, end).includes('SCENE_FRAME_KEY_VERSION');
    }],
  ],
  'P1-7': [
    ['条件求值器已抽成独立模块', () => has('src/we-cond.js')],
    ['求值器已内联进产物', () => read('lib/client.js').includes('function weEvalCondition(')],
    ['求值器不再留在 src/client.js', () => !read('src/client.js').includes('function weEvalCondition(')],
    ['效果应用也已抽成独立模块（本条完成才算整项完成）', () => has('src/effects.js')],
  ],
  'P1-8': [
    ['账本自检守卫在位', () => has('scripts/verify-ledger.mjs')],
    ['账本自检守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-ledger')],
  ],
  'F1': [
    ['令牌层模块在位', () => has('src/theme-layer.js')],
    ['令牌层已内联进产物', () => read('lib/client.js').includes('function createThemeLayer(')],
    ['设置侧已派生（宿主也认这两个新键）', () => {
      const s = read('lib/settings-schema.js');
      return s.includes('themeColors') && s.includes('themeDarkSeparate') && s.includes('THEME_COLOR_ROLE_IDS');
    }],
    ['面板可设置（角色色 UI 在位）', () => read('src/client.js').includes('文字颜色角色')],
    ['F1 守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-theme-layer')],
  ],
  'P2-12': [
    // 注意方向：这是"**做完**才成立"的证据。未完成时它们**必须不成立** ——
    // 若把"未做的前置条件"写成证据，非 ✅ 行反而会全部命中，判据就成了反向的。
    ['静态帧提取链已删除（manifest/资源构建器不再存在）', () => !has('lib/scene-manifest.js')],
    ['退役行守卫的静态帧棘轮已翻成零残留', () => /SF_BASELINE[^=]*=\s*\[\s*\]/.test(read('scripts/verify-retired-lines.mjs'))],
  ],
};

/** 解析 §5 表格：返回 [{ id, status }]（ID 可能被 ** 加粗）。 */
function parseLedger(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*\*{0,2}((?:P[0-2]|F)-\d+)\*{0,2}\s*\|/);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    // 末列（去掉首尾空串后）是状态
    const status = cells[cells.length - 2] || '';
    rows.push({ id: m[1], status, line });
  }
  return rows;
}

/** 审核一段账本文本：返回问题清单。 */
function audit(text) {
  const problems = [];
  const noEvidence = [];
  let done = 0, open = 0;
  for (const { id, status } of parseLedger(text)) {
    const claims = EVIDENCE[id];
    if (!claims) { noEvidence.push(id); continue; }
    const results = claims.map(([what, fn]) => [what, fn()]);
    const allOk = results.every(([, ok]) => ok);
    const isDone = /✅/.test(status);
    if (isDone) {
      done++;
      for (const [what, ok] of results) if (!ok) problems.push(`${id} 标为 ✅，但「${what}」不成立`);
    } else {
      open++;
      if (allOk) problems.push(`${id} 标为未完成（${status || '空'}），但其证据全部成立 —— 状态列该翻了`);
    }
  }
  return { problems, noEvidence, done, open };
}

const ledgerText = readFileSync(LEDGER, 'utf8');
const { problems, noEvidence, done, open } = audit(ledgerText);

console.log(`账本自检：${done} 条已完成 / ${open} 条未完成（可核 ${Object.keys(EVIDENCE).length} 类条目）`);
if (noEvidence.length) console.log(`  未覆盖（尚无机器可核产物，显式承认而不假断言）：${noEvidence.join(', ')}`);

// 负对照：篡改账本，判据必须报错。两条对照**从账本自身推导**（不写死某个条目），
// 这样账本增删条目后对照依然有效。
const flipStatus = (line, to) => line.replace(/\|\s*(?:✅|⬜|🚧[^|]*)\s*\|\s*$/, '| ' + to + ' |');
const rows = parseLedger(ledgerText);
const doneRow = rows.find((r) => /✅/.test(r.status) && EVIDENCE[r.id]);
const openRow = rows.find((r) => !/✅/.test(r.status) && EVIDENCE[r.id]);
const controls = [];
if (doneRow) {
  const mutated = ledgerText.replace(doneRow.line, flipStatus(doneRow.line, '⬜'));
  controls.push([`把已完成的 ${doneRow.id} 谎报成 ⬜`, mutated !== ledgerText && audit(mutated).problems.length > 0]);
}
if (openRow) {
  const mutated = ledgerText.replace(openRow.line, flipStatus(openRow.line, '✅'));
  controls.push([`把未完成的 ${openRow.id} 谎报成 ✅`, mutated !== ledgerText && audit(mutated).problems.length > 0]);
}
let controlFailed = 0;
for (const [what, ok] of controls) {
  console.log(`  ${ok ? '✓' : '✗'} 负对照：${what} 会被判据抓到`);
  if (!ok) controlFailed++;
}
if (!controls.length) { console.log('  ⚠️ 负对照无法构造（账本里没有既带证据又状态可翻转的条目）'); controlFailed++; }

if (problems.length || controlFailed) {
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(`\nLEDGER SELF-CHECK FAILED — ${problems.length} 个不一致，${controlFailed} 个负对照失效`);
  process.exit(1);
}
console.log('ALL LEDGER SELF-CHECKS PASSED');
