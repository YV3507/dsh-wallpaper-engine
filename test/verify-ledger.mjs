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
 *   · 行状态 ⬜/🚧/🟡 ⇒ 证据必须**不全部**成立（否则就是"做完了没翻状态"）。
 *   · `EVIDENCE` 的**每一个键**都必须真的在 §5 里被查到 —— ID 一改名，证据就静默变成
 *     死代码，而摘要仍按 `EVIDENCE` 的键数报"可核 N 类"。被查集合必须有下限。
 *   没有写证据的条目（还没有可核产物）会被列出并在输出里标注 —— 宁可显式承认"未覆盖"，
 *   也不做一条恒真的假断言。
 *
 * 解析范围：只解析 §5。别的节里也有同 ID 的表（如 §9.8 的顺序约束表同样以 `F1` / `F3` 起行），
 * 全文扫描会把它们的末列当成状态读 —— 而状态列的真源只有 §5。
 *
 * 自带负对照：对"篡改过的账本文本"跑同一套判据，必须能报出问题（否则判据没牙）。
 *
 * Usage:  node test/verify-ledger.mjs
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

/** 计数类判据只认**代码**：先剥注释，否则散文里的 `fetch(` 字样会造出假阳性。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

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
    ['退役行守卫在位', () => has('test/verify-retired-lines.mjs')],
    ['退役行守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-retired-lines')],
  ],
  'P1-5': [
    ['设置唯一真源在位', () => has('lib/settings-schema.js')],
    ['宿主改为派生（不再手写逐键白名单）', () => {
      const h = read('lib/index.js');
      return h.includes("sanitizeFromSchema(raw, 'host')") && !/clampNum\(o\./.test(h);
    }],
    ['客户端改为派生', () => {
      // `serializeSelection` 已随持久化层抽到 src/persistence.js（P2-9 后半）⇒ 证据按文件分源。
      const c = read('src/client.js');
      const p = read('src/persistence.js');
      return c.includes('sanitizeFromSchema(o, "client")') && p.includes('serializeSettings(selection)')
        && !/clampNum\(o\./.test(c) && !/clampNum\(o\./.test(p);
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
    ['账本自检守卫在位', () => has('test/verify-ledger.mjs')],
    ['账本自检守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-ledger')],
  ],
  'F1': [
    ['令牌层模块在位', () => has('src/font/color-roles.js')],
    ['令牌层已内联进产物', () => read('lib/client.js').includes('function createThemeLayer(')],
    ['设置侧已派生（宿主也认这两个新键）', () => {
      const s = read('lib/settings-schema.js');
      return s.includes('themeColors') && s.includes('themeDarkSeparate') && s.includes('THEME_COLOR_ROLE_IDS');
    }],
    ['面板可设置（角色色 UI 在位）', () => read('src/panel-tabs.js').includes('文字颜色角色')],
    ['F1 守卫已入链', () => JSON.parse(read('package.json')).scripts.verify.includes('verify-theme-layer')],
  ],
  'F2': [
    ['排版模块在位', () => has('src/font/typography.js')],
    ['排版模块已内联进产物', () => read('lib/client.js').includes('function buildTypePayload(')],
    ['设置侧已派生（themeType 进 schema 与宿主白名单）', () => read('lib/settings-schema.js').includes('THEME_TYPE_ROLE_IDS')],
    ['面板可设置（排版角色 UI 在位）', () => read('src/panel-tabs.js').includes('排版角色')],
  ],
  'P2-9': [
    // 判据与 `test/verify-api-client.mjs` ① **同源**：那份守卫的 `CLIENT_MODULES` 是模块清单的
    // 真源，这里现读它（不在两处各维护一份清单）。`>= 13` 是覆盖面下限 —— 清单读空时不许假绿。
    ['客户端全模块零裸 fetch（P2-9 终态）', () => {
      const guard = read('test/verify-api-client.mjs');
      const body = (guard.match(/const CLIENT_MODULES = \[([\s\S]*?)\];/) || [, ''])[1];
      const modules = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      if (modules.length < 13) return false;
      return modules.every((rel) => has(rel) && !/\bfetch\s*\(/.test(stripComments(read(rel))));
    }],
    ['宿主 API 出入口模块在位（宿主 API 的唯一出入口）',
      () => read('src/api-client.js').includes('async function apiFetch(')],
    ['出入口已登记进构建清单（否则不进产物）',
      () => /file:\s*'src\/api-client\.js'/.test(read('scripts/build-client.mjs'))],
    ['产物里恰好一份 apiFetch 实现（防孤儿，也防正文自带一份旧的）',
      () => (read('lib/client.js').match(/async function apiFetch\(/g) || []).length === 1],
    ['持久化层在位，且序列化委托设置真源',
      () => has('src/persistence.js') && read('src/persistence.js').includes('serializeSettings(selection)')
        && read('lib/settings-schema.js').includes('function serializeSettings(')],
    ['fetch 只在出入口模块内部被取用（业务代码零调用点）',
      () => read('src/api-client.js').includes('const doFetch = pickFetch(o.fetch);')],
  ],
  'P2-10': [
    // 三条判据与 `test/verify-client.mjs` 的 P2-10 后半保持一致（同一组正则）；
    // 两个入口的**实现体**必须被反查到，否则判据是空转。
    ['页签不碰 store（零 selection. / persistSelection 引用）', () => {
      const tabs = read('src/panel-tabs.js');
      return (tabs.match(/(^|[^.\w$])selection\.|persistSelection/g) || []).length === 0;
    }],
    ['client.js 里"赋值 + persistSelection()"手抄形态为 0', () => {
      const src = read('src/client.js');
      return (src.match(/selection\.[A-Za-z_$][\w$]*\s*=[^=][^\n]*persistSelection\(\);/g) || []).length === 0;
    }],
    ['两个 store 写入入口在位：setSetting 写+落盘 / setTransient 只写', () => {
      const src = read('src/client.js');
      return /function setSetting\(field, value\) \{\s*\n\s*selection\[field\] = value;\s*\n\s*persistSelection\(\);/.test(src)
        && /function setTransient\(field, value\) \{\s*\n\s*selection\[field\] = value;/.test(src);
    }],
  ],
  'P2-11': [
    // 已完成的那一半：第一族（diag）搬出 `apply` 成独立模块，并由 `apply` 调用。
    ['第一族（diag）已落地：路由模块在位且 apply 调用了它',
      () => has('lib/routes/diag.js') && read('lib/index.js').includes('registerDiagRoutes')],
    // 未完成的那一半：其余族仍内联在 `apply` 里 ⇒ 这条断言当前必须为假（否则状态列该翻了）。
    // 判据与 `test/verify-route-index.mjs` ② 同一形态。
    ['所有路由族都已拆出 lib/routes/（lib/index.js 内零注册）',
      () => !read('lib/index.js').includes('webServer.register({')],
  ],
  'P2-12': [
    // 注意方向：这是"**做完**才成立"的证据。未完成时它们**必须不成立** ——
    // 若把"未做的前置条件"写成证据，非 ✅ 行反而会全部命中，判据就成了反向的。
    // 删除面只到 §6.13 阶段 2 的范围：图像链 + 离线渲染器 + P0-3 遗留的无消费者构建器。
    ['静态帧图像链与离线渲染器已删除',
      () => !has('lib/we-renderer/core.js') && !read('lib/index.js').includes('extractSceneMainImage')],
    ['manifest/resource 构建器已随无消费者的 /scene-resource/ URL 一并删除',
      () => !read('lib/scene-manifest.js').includes('/wallpaper-engine/scene-resource/')],
    ['退役行守卫的静态帧棘轮已翻成零残留',
      () => /SF_BASELINE[^=]*=\s*\[\s*\]/.test(read('test/verify-retired-lines.mjs'))],
    // 反向：**活依赖必须活下来**。`/scene-video` 与库存视频探测走这两个出口，
    // 整文件删除会把活路由弄坏 —— 断言要把它们钉成"必须存在"，不是"必须消失"。
    ['活依赖存活：lib/index.js 仍从 scene-manifest 取 extractSceneVideo*', () => {
      const host = read('lib/index.js');
      return has('lib/scene-manifest.js')
        && /import\s*\{[^}]*extractSceneVideo[^}]*\}\s*from\s*'\.\/scene-manifest\.js'/.test(host);
    }],
    ['活依赖存活：/scene-audio 的 TEX 视频提取落点仍在 lib/pkg-extract.js',
      () => read('lib/pkg-extract.js').includes('function extractTexVideoMp4(')],
  ],
};

/**
 * §5 是状态列的唯一真源，所以只在这一节里找行：别的节里也有以同 ID 起行的表
 * （§9.8 的顺序约束表就同样以 `F1` / `F3` 起行），全文扫描会把它们的末列当成状态读。
 */
function section5(text) {
  const at = text.indexOf('\n## 5.');
  if (at < 0) return text;
  const end = text.indexOf('\n## 6.', at);
  return end < 0 ? text.slice(at) : text.slice(at, end);
}

/** 行 ID 形态：`P0-1` / `P2-12` 与 `F1` / `G4` 都要认（ID 可能被 ** 加粗）。 */
const ROW_ID = /^\|\s*\*{0,2}([A-Z][A-Z0-9]*(?:-\d+)?)\*{0,2}\s*\|/;

/** 解析 §5 表格：返回 [{ id, status, line }]（ID 可能被 ** 加粗）。 */
function parseLedger(text) {
  const rows = [];
  for (const line of section5(text).split(/\r?\n/)) {
    const m = line.match(ROW_ID);
    if (!m) continue;
    // 只按**未转义**的 `|` 切分。注意不能简单用 `(?<!\\)\|`：在 `\|\|`（转义后的两个字面竖线）
    // 里，第二个竖线前面是竖线而不是反斜杠，仍会被当成列分隔符 ⇒ 列数错位、"末列 = 状态"
    // 读到描述里的碎片。做法是先把 `\|` 换成占位符、切分、再还原。
    const cells = line.replace(/\\\|/g, '\u0000').split('|')
      .map((c) => c.replace(/\u0000/g, '|').trim());
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
  const consulted = new Set();
  let done = 0, open = 0;
  for (const { id, status } of parseLedger(text)) {
    const claims = EVIDENCE[id];
    if (!claims) { noEvidence.push(id); continue; }
    consulted.add(id);
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
  // 覆盖面：`EVIDENCE` 的每个键都必须被本轮真的查到。ID 改名或行被删掉时，证据就成了死代码
  // —— 而摘要仍按 `EVIDENCE` 的键数报"可核 N 类"，等于把"没查"报成"查了"。
  const total = Object.keys(EVIDENCE);
  const unmatched = total.filter((id) => !consulted.has(id));
  for (const id of unmatched) {
    problems.push(`EVIDENCE keys never matched：${id}（§5 里没有对应行 ⇒ 这条证据永不生效）`);
  }
  return { problems, noEvidence, done, open, checked: consulted.size, total: total.length };
}

const ledgerText = readFileSync(LEDGER, 'utf8');
const { problems, noEvidence, done, open, checked, total } = audit(ledgerText);

console.log(`账本自检：${done} 条已完成 / ${open} 条未完成（可核 ${checked} 类条目 / EVIDENCE 共 ${total} 类）`);
if (noEvidence.length) console.log(`  未覆盖（尚无机器可核产物，显式承认而不假断言）：${noEvidence.join(', ')}`);

// 负对照：篡改账本，判据必须报错。两条对照**从账本自身推导**（不写死某个条目），
// 这样账本增删条目后对照依然有效。
// 翻转**最后一个表格单元格**（= 状态列），不枚举状态符号：状态不止 ✅/⬜（还有 🚧/🟡 等
// 进行中形态），枚举一旦漏掉某个符号，负对照就会因为"文本没变"而自己失效。
const flipStatus = (line, to) => line.replace(/\|\s*[^|]*\s*\|\s*$/, '| ' + to + ' |');
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
