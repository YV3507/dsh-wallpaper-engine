/**
 * verify-ledger.mjs — 账本自检（P1-8）：断言 docs/wip/REFACTOR-ASSESSMENT.md §5 的
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
 *   · **两条触发线判据**（P2-11）：§7-6 的「同一族 ≥3 条路由」与「每个族模块都被 `apply` 调用」
 *     各一条 —— 过线或出现孤儿族模块时这一行会**自己翻红**，不靠人记得回来复评。两条判据的枚举
 *     只认 `test/tools/host-route-index.mjs` 的 `buildIndex()`，且正/负对照与判据本体共用同一份函数。
 *   · **进度标记只许住在 §0 的状态图例与 §5 的状态列** —— "未完成"的声明出现在别的节里，就是
 *     第二份、无人核对的进度真源（其余判据都只解析 §5，发现不了它）。`✅` 不在此列：§4 的归口
 *     列与 §7 的守卫表用它作**闭合标记**，那是追踪信息，不是对某一步进度的复述。
 *   · 负对照的**评估**必须排在所有 `controls.push` 之后 —— 判据块会继续往 `controls` 里推，
 *     排序写错就会让后推的对照"构造了、推了、没人看"。
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

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 剥注释：共享的字符串感知实现（test/tools/js-text.mjs）。
import { stripComments } from './tools/js-text.mjs';
// 路由枚举：与 `analyze-host-apply.mjs` ② 组、`verify-route-index.mjs` 同一处解析器。
import { buildIndex } from './tools/host-route-index.mjs';

const root = resolve0();
function resolve0() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

const LEDGER = join(root, 'docs', 'wip', 'REFACTOR-ASSESSMENT.md');

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const has = (rel) => existsSync(join(root, rel));

/** ── P2-11 的两条触发线判据（判据本体与正/负对照**共用同一份**）────────────────────
 *  ① §7-6：`lib/index.js` 内的路由按**路径首段**归组，最大组 `< 3` ⇒ 触发线未过（维持不拆）。
 *  ② 族接线：每个 `lib/routes/*.js` 都有 `register<族>Routes` 导出、且 `apply` 调用了它（族数 ≥ 6）。
 *  枚举**只认** `test/tools/host-route-index.mjs` 的 `buildIndex()`（与 `analyze-host-apply.mjs`
 *  ② 组、`verify-route-index.mjs` 同一口径）：循环注册展开成逐条路由、族模块的路由也回到索引里。
 *  「按首段归组」在 `analyze-host-apply.mjs` ② 组里是内联打印的、**没有导出** ⇒ 按同一口径在
 *  这里最小重写（10 行内）；路由枚举仍只认 `buildIndex()`，本文件不另写解析器。 */
const INDEX_NOW = buildIndex();
/** 磁盘上的族文件（裸文件名；与索引里的 rel 比对时取 basename）。 */
const FAMILY_FILES = readdirSync(join(root, 'lib', 'routes')).filter((f) => f.endsWith('.js')).sort();

/** ① 的归组：入参 = 路径数组，返回 { total, segs, max, topSeg }。 */
function firstSegmentGroups(paths) {
  const fam = new Map();
  for (const p of paths) {
    // 动态路径与 `analyze-host-apply.mjs` ② 组同口径：单列一个 `(动态)` 组，不静默丢掉。
    const seg = p === '(动态路径)' ? '(动态)' : (String(p).split('/').filter(Boolean)[0] || '/');
    fam.set(seg, (fam.get(seg) || 0) + 1);
  }
  let max = 0, topSeg = '';
  for (const [k, n] of fam) if (n > max) { max = n; topSeg = k; }
  return { total: paths.length, segs: fam.size, max, topSeg };
}

/** ① 的裁决。三项输入都显式传入 ⇒ 正/负对照喂合成值即可走**同一条**判据。
 *  下限 `indexTotal > 20` 防"解析器返回空表 ⇒ 最大组 0 ⇒ 恒真"；主文件内还有注册字面量时归组
 *  必须非空，而全部拆完之后这一条允许空集（那时"族还没到线"已无对象可判）。 */
function triggerNotCrossed(ownPaths, indexTotal, hasRegistrations) {
  const g = firstSegmentGroups(ownPaths);
  return { g, ok: indexTotal > 20 && g.max < 3 && (ownPaths.length > 0 || !hasRegistrations) };
}

/** 族模块接线比对：返回"对不上"的清单（空数组 = 一一对应）。 */
function unwiredFamilies(files, modules, orphanRels) {
  const bad = [];
  for (const f of files) {
    const own = modules.filter((m) => m.rel.split('/').pop() === f);
    const regs = own.filter((m) => /^register[A-Za-z0-9]*Routes$/.test(m.fnName));
    if (!regs.length) { bad.push(f + '（没有 register<族>Routes 导出）'); continue; }
    for (const m of regs) if (orphanRels.includes(m.rel)) bad.push(f + '（' + m.fnName + ' 在 lib/index.js 里没有被调用）');
  }
  return bad;
}

/** ② 的裁决：族数下限 + 接线一一对应。 */
function familiesWired(files, modules, orphanRels) {
  const unwired = unwiredFamilies(files, modules, orphanRels);
  return { unwired, ok: files.length >= 6 && unwired.length === 0 };
}

/** 现算 ① 的三项输入（全部取自索引，不另解析源码）。 */
function inlineRoutesNow() {
  const own = INDEX_NOW.routes.filter((r) => r.src === 'lib/index.js');
  // 注册**字面量**数用 `verify-route-index.mjs` ② 的同一口径：只为把"循环展开"讲清楚。
  const literals = (read('lib/index.js').match(/webServer\.register\(\{/g) || []).length;
  return { own, paths: own.map((r) => r.path), indexTotal: INDEX_NOW.routes.length, literals };
}

/** 计数类判据只认**代码**：剥注释走共享实现（test/tools/js-text.mjs），
 *  否则散文里的 `fetch(` 字样会造出假阳性。 */

/** 证据判据：每条返回 true 表示"这件事在仓库里已经成立"。 */
const EVIDENCE = {
  'F3': [
    // ① 键集与版本标记只有共享内核一处真源；两半都引用常量名（手抄就会漂成"客户端放行、宿主拒收"）
    ['字体集键集/版本在共享内核、两半都引用常量名', () => {
      const k = read('lib/settings-schema.js');
      return k.includes('const FONTSET_KEYS = [') && k.includes('const FONTSET_SCHEMA_TAG =')
        && read('src/fontset-store.js').includes('FONTSET_SCHEMA_TAG')
        && read('lib/routes/fontsets.js').includes('FONTSET_SCHEMA_TAG')
        && !/dsh-we\/fontset@/.test(read('src/fontset-store.js'))
        && !/dsh-we\/fontset@/.test(read('lib/routes/fontsets.js'));
    }],
    // ② D1：六个字体键退出 settings 持久化白名单，但 kind 元数据与默认值仍在（sanitizeFontset 用）
    ['六个字体键不在持久化白名单、kind 元数据与默认值仍在', () => {
      const s = read('lib/settings-schema.js');
      return /FONTSET_KEYS\.includes\(key\)\) continue;/.test(s)
        && s.includes('function sanitizeFontset(') && s.includes('const FONTSET_MIGRATED_ID =');
    }],
    // ③ 两层存储：随包层随包发布（files 覆盖）+ 只读写时复制（restored 语义）+ 惰性迁移 + 迁移前护栏
    ['两层存储（写时复制 + 惰性迁移 + 迁移前护栏）在位', () => {
      const r = read('lib/routes/fontsets.js');
      const h = read('lib/index.js');
      const files = JSON.parse(read('package.json')).files.join('|');
      return has('lib/fontsets/compact.json') && files.includes('lib/fontsets')
        && r.includes('fontSetsBuiltinDir') && r.includes("restored: 'builtin'")
        && h.includes('function withLegacyFontValues(') && h.includes('function commitFontSetMigration(')
        && !h.slice(h.indexOf('function apply(')).includes('migrateLegacyFontSet(');
    }],
    // ④ 客户端：另一条通道 + 纯渲染编辑器，两者都进了构建期内联清单
    ['客户端通道与编辑器面板在位且已内联', () => {
      const b = read('scripts/build-client.mjs');
      return b.includes("file: 'src/fontset-store.js'") && b.includes("file: 'src/fontset-editor.js'")
        && read('src/fontset-store.js').includes('function fontValueDefaults(');
    }],
    // ⑤ 导入导出闭环：宿主两侧 + 客户端两侧
    ['导入导出闭环（宿主 export/import + 客户端两者）', () => {
      const r = read('lib/routes/fontsets.js');
      const s = read('src/fontset-store.js');
      return r.includes("second === 'export'") && r.includes("first === 'import'")
        && r.includes('Content-Disposition') && s.includes('function importFontSet(')
        && s.includes('function exportFontSetUrl(');
    }],
    // ⑥ 判据在两条链上
    ['字体集的守卫与冒烟都在链上', () => {
      const pkg = JSON.parse(read('package.json'));
      return pkg.scripts.verify.includes('verify-fontset.mjs')
        && pkg.scripts.smoke.includes('fontset-load-smoke.mjs');
    }],
    // ⑦ 过程记录已归档（收口动作本身也是可核的）
    ['过程记录已归档', () => has('docs/archive/audits/F3-PLAN.md') && !has('docs/wip/F3-PLAN.md')],
  ],
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
      return !h.slice(at, end).includes('LIVE_FRAME_KEY_VERSION');
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
  'F0': [
    ['真机清单已归档（结论并入 §9.1 的 V1–V10）',
      () => has('docs/archive/audits/F0-THEME-SERVICE-CHECKLIST.md')],
    ['账本 §9.1 的 V 表在册（首尾两行都查）', () => {
      const l = read('docs/wip/REFACTOR-ASSESSMENT.md');
      return l.includes('| V1 |') && l.includes('| V10 |');
    }],
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
  'G1': [
    // 四条 !important 折叠 + 全局墨色覆盖 + 三个全局字体键都已删除；判据在主题层守卫里，
    // 这里只断言"那两条判据在册"（不在两处各写一份）。
    ['legacy 全局字体键的删除有判据（三个键 + 零 !important）', () => {
      const g = read('test/verify-theme-layer.mjs');
      return g.includes('三个全局字体键都已不存在（fontColor / fontWeight / fontFamily）')
        && g.includes('模块内零 `!important`（红线 2）');
    }],
    ['设置真源里这三个键确实不在默认值里', () => {
      const d = read('lib/settings-schema.js');
      return !/'fontColor'/.test(d) && !/^\s*fontWeight:/m.test(d) && !/^\s*fontFamily:/m.test(d);
    }],
  ],
  'G2': [
    // 「初始值 = 官方默认值」必须**可见**且来自角色表（不复制数据）。
    ['面板直接显示角色表里的官方默认值（字号 / 字重 / 角色默认字号各一条判据）', () => {
      const g = read('test/verify-theme-layer.mjs');
      return g.includes('面板直接显示默认值（字号输入框未填时取 role.defaultPx）')
        && g.includes('面板直接显示默认字重（未填时取 role.prefix，缺省 400）')
        && g.includes('每个角色都带**可见的官方默认字号**（面板显示它）');
    }],
  ],
  'G3': [
    ['官方 --dsl-* 钩子白名单在位（通道的唯一真源）',
      () => read('src/font/components.js').includes('const DSL_FONT_HOOKS = [')],
    ['钩子通道的作用域判据在册（泛模块名只许走 route=hooks）', () => {
      const g = read('test/verify-component-fonts.mjs');
      return g.includes('const genericOnlyInHooks =') && g.includes("t.route === 'hooks'");
    }],
  ],
  'G4': [
    ['组件字体模块在位（id 与实测模块名分离 + 启动自探测）', () => {
      const m = read('src/font/components.js');
      return m.includes('const COMPONENT_FONT_TARGETS = [') && m.includes('function probeComponentTargets(')
        && m.includes('function buildComponentCss(');
    }],
    ['守卫逐条钉住 id/prefix/route 与自探测返回值', () => {
      const g = read('test/verify-component-fonts.mjs');
      return g.includes('每个白名单项都有 id/label/group/prefix 且 route 合法')
        && g.includes('只返回命中的组件 id');
    }],
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
    // §7-6 触发线①：`lib/index.js` 内路由按首段归组、最大组 < 3 ⇒ 触发线未过（这一行维持"不拆"）。
    // 某族长到 3 条 ⇒ 这条判红，逼人回来重新裁决（拆族 或 改 §7-6 的线），不让它悄悄过期。
    ['§7-6 触发线未过：lib/index.js 内路由按路径首段归组、最大组 < 3', () => {
      const t = inlineRoutesNow();
      return triggerNotCrossed(t.paths, t.indexTotal, t.literals > 0).ok;
    }],
    // 族模块与 `apply` 调用一一对应：完成态之后若出现孤儿族模块（写了却没接），这一行仍会被判红。
    ['族模块与 apply 调用一一对应（每个 lib/routes/*.js 都有 register<族>Routes 且被调用，族数 ≥ 6）',
      () => familiesWired(FAMILY_FILES, INDEX_NOW.modules, INDEX_NOW.orphanModules.map((m) => m.rel)).ok],
  ],
  'P2-12': [
    // 注意方向：这是"**做完**才成立"的证据。未完成时它们**必须不成立** ——
    // 若把"未做的前置条件"写成证据，非 ✅ 行反而会全部命中，判据就成了反向的。
    // 删除面只到 §6.13 阶段 2 的范围：图像链 + 离线渲染器 + P0-3 遗留的无消费者构建器。
    ['静态帧图像链与离线渲染器已删除',
      () => !has('lib/we-renderer/core.js') && !read('lib/index.js').includes('extractSceneMainImage')],
    ['manifest/resource 构建器已随无消费者的 /scene-resource/ URL 一并删除',
      () => !read('lib/scene-manifest.js').includes('/wallpaper-engine/scene-resource/')],
    ['退役行守卫的静态帧棘轮已翻成零残留（产品侧零残留；名单只剩点名检验者）', () => {
      const block = (read('test/verify-retired-lines.mjs').match(/const SF_BASELINE = \[([\s\S]*?)\];/) || [])[1] || '';
      const entries = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return entries.length === 1 && entries[0] === 'test/verify-ledger.mjs';
    }],
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
  'P3-1': [
    ['类型守卫在位且已入链', () => has('test/verify-types.mjs')
      && JSON.parse(read('package.json')).scripts.verify.includes('verify-types.mjs')],
    ['类型面两条判据在册（必需字段 + 值导出各一条）', () => {
      const g = read('test/verify-types.mjs');
      return g.includes('钉住的必需字段全部已声明，且没有多出的字段')
        && g.includes('每个 `exports.X =` 都有对应的值导出声明');
    }],
  ],
  'P3-2': [
    // 指标表述的**正确说法**住在入库位置，且 CI 真的按它判。
    ['指标表述已收口（MODULE-LAYOUT 记着"重建后 git status 干净"）',
      () => read('docs/MODULE-LAYOUT.md').includes('重建后 `git status` 干净')],
    ['CI 按该口径判（重建后 diff 必须干净）',
      () => read('.github/workflows/verify.yml').includes('git diff --exit-code -- lib/client.js')],
    // §2 是"当前基线"表 ⇒ 表里的派生计数必须等于**现算值**（结构变了就必须改账本）。
    ['§2 基线表：内联模块计数 == 构建清单条数', () => {
      const n = (read('scripts/build-client.mjs').match(/file:\s*['"]/g) || []).length;
      return n >= 10 && read('docs/wip/REFACTOR-ASSESSMENT.md').includes('| 构建期内联模块 | **' + n + ' 个**');
    }],
    ['§2 基线表：守卫计数 == verify 链条数', () => {
      const chain = JSON.parse(read('package.json')).scripts.verify;
      const n = new Set(chain.match(/verify-[a-z-]+\.mjs/g) || []).size;
      const stated = Number((read('docs/wip/REFACTOR-ASSESSMENT.md')
        .match(/\*\*(\d+) 个 `verify-\*`/) || [])[1] || 0);
      return n >= 20 && stated === n;
    }],
    ['§2 基线表：冒烟计数 == smoke 链条数', () => {
      const chain = JSON.parse(read('package.json')).scripts.smoke;
      const n = new Set(chain.match(/[a-z-]+-smoke\.mjs/g) || []).size;
      const stated = Number((read('docs/wip/REFACTOR-ASSESSMENT.md')
        .match(/\+ (\d+) 个 smoke（/) || [])[1] || 0);
      return n >= 3 && stated === n;
    }],
    // 规模类只设**上限**（棘轮）：表里的数字只许比实测大，不许比实测小 —— 重构后基线悄悄变大
    // 会被判红，而"实际比表里小"是安全的（表是上界，不是精确值）。
    ['§2 基线表：src/client.js 行数仍是上界（棘轮）', () => {
      const stated = Number(String((read('docs/wip/REFACTOR-ASSESSMENT.md')
        .match(/浏览器正文 `src\/client\.js` \| \*\*([\d,]+) 行\*\*/) || [])[1] || '').replace(/,/g, ''));
      const actual = read('src/client.js').replace(/\n$/, '').split('\n').length;
      return stated > 0 && actual <= stated;
    }],
    ['§2 基线表：lib 扫描面（文件数 / 行数）与守卫口径一致', () => {
      // 口径 = `verify-reachability` 打印的「lib 扫描面」一行：`lib/**.{js,mjs}` **全量**
      //（vendored 与生成物都算）、行数含末尾空行。文件数取等号（加一个 lib 模块就该改账本），
      // 行数只设上限（生成物每次重建都会变）。
      const walk = (dir, out = []) => {
        for (const n of readdirSync(dir)) {
          const p = join(dir, n);
          if (statSync(p).isDirectory()) walk(p, out);
          else if (/\.(js|mjs)$/.test(n)) out.push(p);
        }
        return out;
      };
      const files = walk(join(root, 'lib'));
      const total = files.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0);
      const m = read('docs/wip/REFACTOR-ASSESSMENT.md')
        .match(/`lib\/\*\*`（[^\n|]*）\s*\|\s*\*\*([\d,]+) 文件 \/ ([\d,]+) 行\*\*/) || [];
      const statedFiles = Number(String(m[1] || '').replace(/,/g, ''));
      const statedLines = Number(String(m[2] || '').replace(/,/g, ''));
      return statedFiles === files.length && statedLines > 0 && total <= statedLines;
    }],
  ],
  'P3-3': [
    ['可达性守卫在位且已入链', () => has('test/verify-reachability.mjs')
      && JSON.parse(read('package.json')).scripts.verify.includes('verify-reachability.mjs')],
    ['棘轮基线已收到 0 文件 / 0 行（只许收紧）',
      () => read('test/verify-reachability.mjs').includes('const BASELINE = { files: 0, lines: 0 };')],
  ],
  'P3-4': [
    ['死 import 已删（lib/index.js 不再有裸 readPkg；readPkgEntry 是活依赖）',
      () => !/\breadPkg\b/.test(stripComments(read('lib/index.js')))],
    ['两口径与假活锚点的建模写进脚本头（as-is / pruned / 假活锚点）', () => {
      const g = read('test/verify-reachability.mjs');
      return g.includes('假活锚点') && g.includes('as-is') && g.includes('pruned');
    }],
  ],
  'P3-5': [
    ['孤儿扫描判据在册（除 client.js 外每个 src/**/*.js 都必须登记）', () => {
      const g = read('test/verify-module-layout.mjs');
      return g.includes('function findSrcOrphans(') && g.includes("rel !== 'src/client.js'");
    }],
  ],
  'P3-6': [
    ['依赖方向判据在册（lib → src 零条边，零容忍）', () => {
      const g = read('test/verify-module-layout.mjs');
      return g.includes('function findLibToSrcEdges(') && g.includes('lib/ 里零条指向 src/ 的依赖边');
    }],
  ],
  'P3-7': [
    ['共享内核白名单在册（当前恰好一条）', () => {
      const g = read('test/verify-module-layout.mjs');
      return g.includes("const SHARED_KERNEL_WHITELIST = ['lib/settings-schema.js'];")
        && g.includes('function findUnlistedSharedKernels(');
    }],
  ],
  'P3-8': [
    ['CEIL 键存在性 + 覆盖面从磁盘枚举两条判据在册', () => {
      const g = read('test/verify-comment-discipline.mjs');
      return g.includes('ghostsOf(Object.keys(CEIL))')
        && g.includes('棘轮覆盖全部 src/**/*.js、lib/routes/*.js、test/**/*.mjs 与 scripts/**/*.mjs（新文件必须进表）');
    }],
  ],
  'P3-9': [
    ['P2-9 / P2-10 / P2-11 三条都已有机器证据（本条自己的产物）', () => {
      const g = read('test/verify-ledger.mjs');
      return ["'P2-9': [", "'P2-10': [", "'P2-11': ["].every((k) => g.includes(k));
    }],
  ],
  'P3-10': [
    // 判据与守卫**同源**：不在这里复制第二份路径清单，只断言守卫自己的判据在册；方向也不能反
    // —— 是"搬走了"才成立，不是"还指着"才成立。
    ['常青入库文档的"本机专用路径"扫描在守卫里（含正/负对照）', () => {
      const g = read('test/verify-comment-discipline.mjs');
      return g.includes('常青文档不引用本机专用路径')
        && g.includes('negative control: 合成文本里的每条被禁路径都被判出')
        && g.includes('positive control: 入库的同名文件不被误伤');
    }],
    ['写作纪律已住进入库位置（docs/README.md 有该章节）',
      () => read('docs/README.md').includes('## 写作纪律')],
    // 本机待办在 CI 的检出里本就不存在 ⇒ 两种情形都算达成（不存在 = 更彻底）。
    // 判据盯**规则正文**（第 6 条那句只住在这里过），不盯"归并原则"这个词 —— 本机待办里
    // 会留一句"这个家搬去哪了"的历史说明，用词做判据会被它自己绊倒。
    ['本机待办不再承载写作纪律（规则正文已搬走）',
      () => !has('TODO.md') || !read('TODO.md').includes('跳过不得与通过同形')],
  ],
  'P3-11': [
    // 三个拆出去的模块都在构建清单里（漏登记不会报错，只会让那个文件永不进产物）。
    ['模型 / 模态框 / 属性面板三个模块都在 INLINE_MODULES 里（含 why + markers）', () => {
      const b = read('scripts/build-client.mjs');
      return ['src/picker-model.js', 'src/picker-modal.js', 'src/picker-props-panel.js']
        .every((f) => b.includes("file: '" + f + "'"));
    }],
    // 属性面板的渲染器**真的搬走了**（留在 client.js 的只有组装用的那层适配）。
    ['属性面板渲染器住在 src/picker-props-panel.js（client.js 里只剩接线）', () => {
      const c = read('src/client.js');
      const m = read('src/picker-props-panel.js');
      return m.includes('function renderPickerPropsPanel(ctx)')
        && m.includes('function renderUserPropRow(p, onPropInput)')
        && !c.includes('function renderUserPropRow(')
        && c.includes('renderPickerPropsPanel({');
    }],
    // 可达性 + 标记等价：守卫在册、已入链，且判据带 golden / 绝对锚点 / 负对照。
    ['属性面板守卫在册（可达性 + golden + 负对照 + 绝对锚点）且已入 verify 链', () => {
      const g = read('test/verify-picker-props.mjs');
      const chain = JSON.parse(read('package.json')).scripts.verify;
      return chain.includes('verify-picker-props.mjs')
        && g.includes('EXPECTED_PROPS_GOLDEN') && g.includes('EXPECTED_PROPS_LENGTH')
        && g.includes('负对照：只把一个节点的层级挪一格')
        && g.includes("'/wallpaper-engine/props/'");
    }],
    ['接缝判据覆盖属性面板（零 selection / 零 emit）',
      () => read('test/verify-client.mjs').includes("'../src/picker-props-panel.js'")],
    ['计划文件已归档（wip 里不再有 P3-11-PLAN.md）',
      () => !has('docs/wip/P3-11-PLAN.md') && has('docs/archive/audits/P3-11-PLAN.md')],
  ],
  'P3-12': [
    ['package.json 声明 engines.node = 代码真实下限', () => {
      const p = JSON.parse(read('package.json'));
      return Boolean(p.engines && p.engines.node === '>=18');
    }],
    ['守卫 ① 断言 engines 与真实用到的 API 对齐', () => {
      const g = read('test/verify-contracts.mjs');
      return g.includes('const hasNodeEngine =') && g.includes('package.json 声明了 engines.node');
    }],
  ],
  'P3-13': [
    // 已完成的一半：缺前置**默认红**，要接受"不跑"必须在命令行上显式写出来。
    ['缺前置默认红、要接受不跑必须显式 --allow-skip', () => {
      const g = read('test/verify-media-bridge.mjs');
      return g.includes('function blockedBy(') && g.includes("process.argv.includes('--allow-skip')");
    }],
    // 残留项（已接上）：CI 另起一步 `npm run verify:bridge`（带 `--provision`）。本机证明不了
    // 这条通道（下载被挡 / 沙箱里 spawn 是 EPERM）⇒ 覆盖只能由 CI 提供。
    ['CI 已给 media-bridge 端到端接上 --provision',
      () => read('.github/workflows/verify.yml').includes('verify:bridge')],
  ],
  'P3-14': [
    ['四处"过滤集变空即恒真"都补了下限或单独计数', () => {
      // 判据针对**代码**：四个守卫都先剥注释 —— 否则判据会被解释这些阈值的散文满足
      //（实测：`fbRules.length >= 5` 在 softrender 的一条注释里也出现 ⇒ 不剥注释时
      // 把真断言删掉，这条证据照样绿）。
      const theme = stripComments(read('test/verify-theme-layer.mjs'));
      const soft = stripComments(read('test/verify-softrender.mjs'));
      const pkg = stripComments(read('test/verify-package-files.mjs'));
      const scene = stripComments(read('test/verify-scene.mjs'));
      return theme.includes('followBody.length > 0')
        && soft.includes('fbRules.length >= 5') && soft.includes('supportsRules.length >= 4')
        && pkg.includes('const CHAIN_FLOOR = {') && pkg.includes('below floor')
        && scene.includes('platform-skipped');
    }],
  ],
  'P3-15': [
    ['EVIDENCE 键必须被查到（防"证据成了死代码却仍按类数报可核"）',
      () => read('test/verify-ledger.mjs').includes('EVIDENCE keys never matched')],
    ['F 轨（F1/F2/F3 这类无横线 ID）行能被账本解析并匹配', () => {
      const g = read('test/verify-ledger.mjs');
      return g.includes('(?:-\\d+)?') && g.includes("'F1': [") && g.includes("'F2': [");
    }],
    ['`|| typeof fetch` 逃生口已拆成两条都无门的断言', () => {
      // 判据针对**代码**：先剥注释 —— 那段散文本就解释着"旧断言长什么样"。
      const g = stripComments(read('test/verify-api-client.mjs'));
      return g.includes("check('fetch: null（非函数）⇒ 回退到全局 fetch")
        && g.includes('环境里也没有 fetch 时给出结构化失败而不是抛')
        && !g.includes("typeof fetch === 'function'");
    }],
    ['退役键扫描面已扩到 5 个可能承载设置键的文件',
      () => read('test/verify-comment-discipline.mjs')
        .includes("const SETTING_OWNERS = ['lib/index.js', 'src/client.js', 'lib/settings-schema.js', 'src/panel-tabs.js', 'src/persistence.js'];")],
    ['apply 抛错是硬断言（不是打印后继续）',
      () => read('test/verify-client.mjs').includes("assert.equal(thrown, null, 'apply(ctx) 不得抛")],
  ],
  'P3-16': [
    // 判据与守卫**同源**：不在这里复制判据，只断言"命名判据在位 + 旧的恒真写法已消失"。
    ['两个残留文件的判据已抽成命名函数/命名正则（正负对照共用同一份）', () => {
      const cf = read('test/verify-component-fonts.mjs');
      const pp = read('test/verify-package-publish.mjs');
      return ['const SELECTOR_SHAPE =', 'const HASHED_CLASS =', 'const offendingProps =',
        'const genericOnlyInHooks =', 'const allHaveModuleCssSource =', 'const hooksAllKnown =']
        .every((s) => cf.includes(s))
        && pp.includes('function usedByClosure(');
    }],
    ['旧的恒真写法已消失（只断言"某个常量/数组不含 X"）', () => {
      const cf = read('test/verify-component-fonts.mjs');
      return !cf.includes("!COMPONENT_FONT_PROPS.includes('line-height')")
        && !cf.includes("!HOOKS.includes('--dsl-codeblock-content-font')");
    }],
    ['形态规则写进了守卫约定的家（TEST-LAYOUT §约定）',
      () => read('docs/TEST-LAYOUT.md').includes('负对照必须把变异输入喂进「同一条判据」')],
  ],
  'P3-27': [
    ['剥注释已统一到字符串感知实现（规则 ⑦ 在位）', () => {
      const g = read('test/verify-module-layout.mjs');
      return g.includes('代码里零"朴素块注释正则"') && g.includes('白名单条目不空转')
        && read('test/tools/js-text.mjs').includes('function stripComments');
    }],
    ['store 写入契约两侧都有判据（瞬态 ①d/①e · 持久化 ①g）', () => {
      const g = read('test/verify-client.mjs');
      return g.includes('非持久化字段必须经 setTransient 写')
        && g.includes('持久化字段的直写必须与落盘配对');
    }],
    ['"改了 store 却不通知"钉到处理器级 + 分支级，且扫描面派生自 INLINE_MODULES', () => {
      const g = read('test/verify-client.mjs');
      return g.includes('面板处理器写 store 却不会通知') && g.includes('build-client.mjs')
        && read('test/tools/branch-notify.mjs').includes('export function pathNotifications');
    }],
    ['工具清单进文档（规则 ⑧ 在位）', () => read('test/verify-module-layout.mjs').includes('都在 TEST-LAYOUT 里点名')],
    ['harness 基线"追尾"修复在位（按内容身份判重）', () => {
      const s = read('scripts/harness-compat-baseline.mjs');
      return s.includes('function pluginRevision(') && s.includes('plugin.revision');
    }],
  ],
  'P3-23': [
    ['审计工具在位且带自检（必须抓到已知实例 `liveBootDelay`，否则非零退出）', () => {
      const t = read('test/tools/audit-fixture-coverage.mjs');
      return t.includes('已知实例 liveBootDelay 被列为 A 类') && t.includes('process.exitCode = 1');
    }],
    ['A/B 两族候选都落成了守卫（R1–R6 在册）', () => {
      const s = read('test/rotation-prepared-leak-smoke.mjs');
      return ["'R1.", "'R2.", "'R3.", "'R3b.", "'R4.", "'R4b.", "'R5.", "'R6."].every((tag) => s.includes(tag));
    }],
    ['挂载台保真：焦点可切换 + play/pause 同步真 DOM 的 `paused`', () => {
      const s = read('test/rotation-prepared-leak-smoke.mjs');
      return s.includes('setFocus(v)') && s.includes('this.paused = true;') && s.includes('this.paused = false;');
    }],
  ],
  'P3-17': [
    // 验收判据三条里的前两条：**导出点唯一** + **上限常量唯一**（此前上限只长在副本上）。
    ['容器原语只有一份实现（lib/pkg-read.js）', () => {
      const defines = (f, n) => new RegExp('^(?:export\\s+)?(?:async\\s+)?(?:function|const|class)\\s+' + n + '\\b', 'm').test(read(f));
      return defines('lib/pkg-read.js', 'parsePkg') && defines('lib/pkg-read.js', 'readPkgEntry')
        && defines('lib/pkg-read.js', 'lz4DecompressBlock') && defines('lib/pkg-read.js', 'probeCompressedEntry')
        && !defines('lib/pkg-extract.js', 'parsePkg') && !defines('lib/pkg-extract.js', 'lz4DecompressBlock')
        && !defines('lib/scene-manifest.js', 'parsePkg') && !defines('lib/scene-manifest.js', 'lz4DecompressBlock');
    }],
    ['分配上限唯一（不再"只长在副本上"）', () => {
      const hit = (f) => (read(f).match(/^const MAX_DECOMPRESSED_BYTES\b/m) || []).length;
      return hit('lib/pkg-read.js') === 1 && hit('lib/pkg-extract.js') === 0 && hit('lib/scene-manifest.js') === 0;
    }],
    ['两个消费者都从共享模块取（不是各自又长回一份）', () =>
      read('lib/pkg-extract.js').includes("'./pkg-read.js'")
      && read('lib/scene-manifest.js').includes("'./pkg-read.js'")],
  ],
  'P3-18': [
    ['lib/index.js 的死 readPkg import 已删（不再有第 3 份 PKG 解析器；readPkgEntry 不算）',
      () => !/\breadPkg\b/.test(stripComments(read('lib/index.js')))],
  ],
  'P3-19': [
    ['活依赖存活的两条反向判据在册（挂在 P2-12 的证据里）', () => {
      const g = read('test/verify-ledger.mjs');
      return g.includes('活依赖存活：lib/index.js 仍从 scene-manifest 取 extractSceneVideo*')
        && g.includes('活依赖存活：/scene-audio 的 TEX 视频提取落点仍在 lib/pkg-extract.js');
    }],
    ['scene-manifest 仍然存活（收窄机器退出条件的依据）', () => has('lib/scene-manifest.js')],
  ],
  'P3-20': [
    ['复制度结论写明了作用域（单边结论不得当全仓不变量）', () => {
      const l = read('docs/wip/REFACTOR-ASSESSMENT.md');
      return l.includes('只对浏览器半边成立') && l.includes('已限定作用域');
    }],
  ],
  'P3-21': [
    ['跨半边词汇表由守卫**读两边源码**比对（BASE + 上传 MIME + 自定义画面 MIME）', () => {
      const g = read('test/verify-contracts.mjs');
      return g.includes('跨半边契约（读两边源码比对，不是 import 一边自己比）')
        && g.includes('BASE 两侧一致')
        && g.includes('上传 MIME：客户端 UPLOAD_TYPES 与宿主 UPLOAD_EXT 键集一致')
        && g.includes('自定义画面 MIME：客户端有一个 accept 列表');
    }],
  ],
  'P3-22': [
    ['413 用例接受两种合法结果，且"恰好 limit+1"那条仍在（精确 413 由它钉死）', () => {
      const g = read('test/verify-scene.mjs');
      return g.includes('或连接被主动掐断') && g.includes('恰好 limit+1（超限块即最后一块）仍收到 413');
    }],
  ],
  'P3-24': [
    // 判据盯**口径**（轮询/触发面 + 第三方排除 + 基线落点），不盯实现细节：
    // 工作流与脚本怎么重构都行，"跑什么、不跑什么、基线何时写"这三件事不能变。
    ['适配工作流口径：轮询 latest + push main、跑 verify:all、不跑 verify:bridge、基线落点在册', () => {
      const y = read('.github/workflows/harness-compat.yml');
      return y.includes('npm view @deepseek-ai/dsh dist-tags.latest')
        && y.includes('branches: [main]')
        && y.includes('npm run verify:all')
        && !y.includes('npm run verify:bridge')
        && y.includes('.github/harness-baseline.json');
    }],
    ['真 harness 探活脚本在位（隔离 HOME + 媒体桥禁用 + 落盘/日志判据）', () => {
      const g = read('test/compat-harness-live.mjs');
      return g.includes('DSH_WE_MEDIA_LEGACY') && g.includes('USERPROFILE')
        && g.includes('plugin tree failed to load') && g.includes('diag-log');
    }],
    ['基线读写脚本两子命令在位（check 判跳过 / record 只在全绿后被调用）', () => {
      const s = read('scripts/harness-compat-baseline.mjs');
      return s.includes("cmd === 'check'") && s.includes("cmd === 'record'")
        && s.includes('should_run');
    }],
    ['适配 CI 的新文件都进了注释棘轮表（新文件必须进表的那条判据的实证）', () => {
      const g = read('test/verify-comment-discipline.mjs');
      return g.includes("'scripts/harness-compat-baseline.mjs': 0")
        && g.includes("'test/compat-harness-live.mjs': 0");
    }],
  ],
  'P3-25': [
    // 判据盯「机制在位」：枚举差集 + 真源码锚点 + 工作流接线。清单内容的对错由
    // compat CI 对着真 harness 实跑裁定，这里只钉结构与关键项。
    ['UI 面清单棘轮在位（枚举 dsh-client-ui-* 差集 + 缺前置默认红）', () => {
      const g = read('test/compat-harness-surfaces.mjs');
      return g.includes('没有未登记的新 UI 表面') && g.includes('DSH_WE_HARNESS_ROOT')
        && g.includes('默认红');
    }],
    ['清单 fixture 在位且按 latest 播种（sidebar-right = covered，其余带合法 verdict）', () => {
      const f = JSON.parse(read('test/fixtures/harness-ui-surfaces.json'));
      const names = Object.keys(f.known);
      return names.length >= 41 && String(f.meta.seededFrom).includes('0.1.7')
        && f.known['dsh-client-ui-sidebar-right'] && f.known['dsh-client-ui-sidebar-right'].verdict === 'covered'
        && Object.values(f.known).every((v) => ['covered', 'native', 'exempt'].includes(v.verdict));
    }],
    ['sidebar 活判据核真源码：两个属性锚点 + 隐藏机制 allowlist', () => {
      const g = read('test/compat-harness-surfaces.mjs');
      return g.includes('data-sidebar-right-panel') && g.includes('data-sidebar-right-open')
        && g.includes('translate(100%)') && g.includes('visibility:hidden');
    }],
    ['工作流在装好 harness 后跑棘轮，且该文件已进注释棘轮表', () => {
      const y = read('.github/workflows/harness-compat.yml');
      const c = read('test/verify-comment-discipline.mjs');
      return y.includes('compat-harness-surfaces.mjs')
        && c.includes("'test/compat-harness-surfaces.mjs': 0");
    }],
  ],
  'P3-26': [
    // 判据盯「探针在位 + 接线」：页面断言的牙齿由页面脚本自己的变异实证给出
    //（锚点改名 ⇒ 玻璃三条变红），这里只钉结构。
    ['页面断言脚本在位（零依赖 CDP + 设置玻璃计算样式探针 + 分区走查）', () => {
      const g = read('test/compat-harness-pages.mjs');
      return g.includes('new WebSocket(') && g.includes('Runtime.evaluate')
        && g.includes('settings.section') && g.includes('Wallpaper Engine')
        && g.includes('--lang=zh-CN');
    }],
    ['启动弹窗结构化消法与会话页判据在册（slot 锚点，不靠视觉元素）', () => {
      const g = read('test/compat-harness-pages.mjs');
      return g.includes('we-update-notice__btn') && g.includes('main.conversation')
        && g.includes('稍后配置');
    }],
    ['工作流接入页面断言，且该文件已进注释棘轮表', () => {
      const y = read('.github/workflows/harness-compat.yml');
      const c = read('test/verify-comment-discipline.mjs');
      return y.includes('compat-harness-pages.mjs')
        && c.includes("'test/compat-harness-pages.mjs': 0");
    }],
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
  controls.push([`负对照：把已完成的 ${doneRow.id} 谎报成 ⬜`, mutated !== ledgerText && audit(mutated).problems.length > 0]);
}
if (openRow) {
  const mutated = ledgerText.replace(openRow.line, flipStatus(openRow.line, '✅'));
  controls.push([`负对照：把未完成的 ${openRow.id} 谎报成 ✅`, mutated !== ledgerText && audit(mutated).problems.length > 0]);
}
// ⚠️ 负对照的**评估**排在文件末（所有 `controls.push` 之后）：下面的判据块还会往里推对照，
//    评估循环若排在这里，那些对照就是"构造了、推了、没人看" —— 等于没有对照。

// ── 账本里的"条路由"是**现状断言**：必须与生成的索引一致（数字只许复算）──────────────
// 本次时效性审计实测：账本 §3 写着"宿主 31 条路由"，而同文件 §3.1 已经写 32 —— 一份文档里
// 两个数，没有任何守卫看着它们。这里只**现算**：索引条数来自生成物、族数/已拆出条数来自源码。
{
  const idxCount = Number((/共 \*\*(\d+)\*\* 条路由/.exec(read('docs/ROUTE-INDEX.md')) || [])[1]);
  const ledger = read('docs/wip/REFACTOR-ASSESSMENT.md');
  const famFiles = readdirSync(join(root, 'lib', 'routes')).filter((f) => f.endsWith('.js'));
  const famRegs = famFiles.reduce((n, f) => n + ((read('lib/routes/' + f).match(/register\(/g) || []).length), 0);
  const row = /\*\*([\d,]+) 行 = `lib\/index\.js` 的 \d+%\*\*，分支代理 \d+，(\d+) 条路由（\*\*(\d+) 族 \/ (\d+) 条已拆出/.exec(ledger);
  const sentence = /宿主 \*\*(\d+)\*\* 条路由注册/.exec(ledger);
  const routeProblems = [];
  if (!idxCount) routeProblems.push('索引里读不到"共 N 条路由"');
  if (!row) routeProblems.push('找不到 §3.1 那句（改写句子会让判据失效，请同步判据）');
  if (!sentence) routeProblems.push('找不到 §3 那句"宿主 N 条路由注册"');
  if (row && Number(row[2]) !== idxCount) routeProblems.push('§3.1 路由总数 ' + row[2] + ' ≠ 索引 ' + idxCount);
  if (row && Number(row[3]) !== famFiles.length) routeProblems.push('§3.1 族数 ' + row[3] + ' ≠ lib/routes/ 文件数 ' + famFiles.length);
  if (row && Number(row[4]) !== famRegs) routeProblems.push('§3.1 已拆出 ' + row[4] + ' ≠ 族内注册数 ' + famRegs);
  if (sentence && Number(sentence[1]) !== idxCount) routeProblems.push('§3 的 N ' + sentence[1] + ' ≠ 索引 ' + idxCount);
  console.log('  ' + (routeProblems.length ? '✗' : '✓') + ' 账本里的路由数字与实测一致（索引 ' + idxCount
    + ' / 族 ' + famFiles.length + ' / 族内注册 ' + famRegs + '）' + (routeProblems.length ? ' — ' + routeProblems.join('；') : ''));
  if (routeProblems.length) problems.push(...routeProblems);
  // 负对照：喂一份被改坏的账本，同一判据必须判出不一致
  const mutated = ledger.replace(/，(\d+) 条路由（/, '，17 条路由（');
  const mutatedRow = /\*\*([\d,]+) 行 = `lib\/index\.js` 的 \d+%\*\*，分支代理 \d+，(\d+) 条路由（/.exec(mutated);
  controls.push(['负对照：账本里的路由条数被改坏', Boolean(mutatedRow) && Number(mutatedRow[2]) !== idxCount]);
}

// ── P2-11 的两条触发线：过线 / 孤儿族模块都由机器判出，不靠人记得复评 ───────────────────
// 判据本体与 EVIDENCE 的 `P2-11` 两条**同源**：同一份 `triggerNotCrossed` / `familiesWired`，
// 正/负对照也走它们（喂合成输入）。
{
  const t = inlineRoutesNow();
  const trigger = triggerNotCrossed(t.paths, t.indexTotal, t.literals > 0);
  const wiring = familiesWired(FAMILY_FILES, INDEX_NOW.modules, INDEX_NOW.orphanModules.map((m) => m.rel));
  console.log('  ' + (trigger.ok ? '✓' : '✗') + ' §7-6 触发线①：`lib/index.js` 内 ' + trigger.g.total
    + ' 条注册 / ' + trigger.g.segs + ' 个首段 / 最大组 ' + trigger.g.max
    + (trigger.g.max >= 3 ? '（≥3 ⇒ /' + trigger.g.topSeg + ' 族该拆，或改 §7-6 的线）' : '（< 3 ⇒ 维持不拆）')
    + '；索引 ' + t.indexTotal + ' 条 = 内联 ' + t.own.length + ' + 族模块 ' + (t.indexTotal - t.own.length)
    + '（' + t.literals + ' 条注册字面量，循环展开 +' + (trigger.g.total - t.literals) + '）');
  if (!trigger.ok) problems.push('§7-6 触发线①不再成立：最大组 ' + trigger.g.max + '（首段 /' + trigger.g.topSeg + '）');
  console.log('  ' + (wiring.ok ? '✓' : '✗') + ' 族模块与 apply 调用一一对应：' + FAMILY_FILES.length
    + ' 个 `lib/routes/*.js` / ' + INDEX_NOW.modules.length + ' 个 `register<族>Routes` 导出'
    + (wiring.unwired.length ? ' — 对不上：' + wiring.unwired.join('；') : '（全部有调用点；族数 ≥ 6）'));
  if (!wiring.ok) problems.push('族模块接线对不上：' + (wiring.unwired.join('；') || '族数 ' + FAMILY_FILES.length + ' < 6'));
  // 正对照：合法合成输入（首段各不相同 + 六个合成族都接上了）两条判据都不许报。
  const posFiles = ['alpha.js', 'beta.js', 'gamma.js', 'delta.js', 'epsilon.js', 'zeta.js'];
  const posModules = posFiles.map((f) => ({ rel: 'lib/routes/' + f, fnName: 'register' + f[0].toUpperCase() + f.slice(1, -3) + 'Routes' }));
  controls.push(['正对照：两条判据对合法合成输入都不报（同一份判据）',
    triggerNotCrossed(['/alpha', '/beta', '/gamma/one'], 32, true).ok
    && familiesWired(posFiles, posModules, []).ok]);
  // 负对照 1：合成"3 条同族"必须被同一个 `< 3` 判据判出（判据会翻面的实证）。
  const sameFam = triggerNotCrossed(['/alpha', '/alpha/one', '/alpha/two'], 32, true);
  controls.push(['§7-6：合成「3 条同族」会被判出（最大组 ' + sameFam.g.max + '）',
    sameFam.ok === false && sameFam.g.topSeg === 'alpha']);
  // 负对照 2：索引空转（0 条路由）不许当"没到线" ⇒ 同一判据仍必须报（防空对空）。
  controls.push(['§7-6：索引空转（0 条路由）会被判出', triggerNotCrossed([], 0, false).ok === false]);
  // 负对照 3：合成"孤儿族模块"（写了却没接）必须被判出。
  controls.push(['族接线：合成「孤儿族模块」会被判出',
    familiesWired(['orphan.js'], [{ rel: 'lib/routes/orphan.js', fnName: 'registerOrphanRoutes' }], ['lib/routes/orphan.js']).ok === false]);
  // 负对照 4：合成"没有 register<族>Routes 导出"的族文件必须被判出。
  controls.push(['族接线：合成「没有 register<族>Routes 导出」会被判出',
    familiesWired(['odd.js'], [{ rel: 'lib/routes/odd.js', fnName: 'setupOdd' }], []).ok === false]);
  // 负对照 5：合成族数不足 6 必须被判出（下限本身有牙）。
  controls.push(['族接线：合成族数不足 6 会被判出',
    familiesWired(['only.js'], [{ rel: 'lib/routes/only.js', fnName: 'registerOnlyRoutes' }], []).ok === false]);
}

// ── 进度标记只许住在状态列：别的节里的 ⬜/🟡 是**第二份、无人核对的进度真源** ──────────────
// 实测：§1 还写着 `F3 ⬜`、§3.2 把早已合并的 PKG/TEX 重复列为"仍在办"、§9.7 写着"F3 是唯一未做
// 的部分" —— 而 §5 的状态列早已 ✅。其余判据都只解析 §5，**发现不了这类漂移**，而它误导的正是
// "还要不要做、能不能提交"这个判断本身。
// 规则：`⬜` / `🟡`（= 未完成标记）只许出现在两处 —— §0 的状态取值图例、§5 的状态列。
// ⚠️ **不连 `✅` 一起禁**：§4 的归口列（`P0-1 ✅`）与 §7 的守卫表都用它作**闭合标记**，
//    那是"这条风险归到哪、那条规则谁在钉"的追踪信息，不是对某一步进度的复述。
{
  /** §0 与 §5 之外的正文（判据与负对照共用同一个函数）。 */
  const outsideStatusSections = (text) => text.split(/^## /m)
    .filter((sec) => !/^0\./.test(sec) && !/^5\./.test(sec)).join('\n');
  const strayMarkers = (text) => outsideStatusSections(text).match(/⬜|🟡/g) || [];
  const stray = strayMarkers(ledgerText);
  console.log('  ' + (stray.length ? '✗' : '✓') + ' §0/§5 之外零进度标记（⬜/🟡）'
    + (stray.length ? ' — 命中 ' + stray.length + ' 处' : ''));
  if (stray.length) {
    problems.push('§0/§5 之外出现进度标记 ' + stray.length + ' 处（进度只许住在 §5 的状态列）');
  }
  // 防空转：§0 的图例与 §5 的状态列里**确实**有这两种标记 —— 否则"零命中"可能只是全文压根没
  // 有标记（判据退化成恒真）。这一条与下面的负对照一起，把"判据真的在读真文本"钉住。
  if (!/⬜/.test(ledgerText) || !/🟡/.test(ledgerText)) {
    problems.push('账本里读不到 ⬜/🟡：§0 图例或 §5 状态列被改写了 ⇒ 本条判据会退化成恒真');
  }
  // 负对照（只测**判据**本身，且判**增量**）：塞进一行"还没做" ⇒ 命中数必须恰好 +2。
  // 判增量而不是判绝对值：真文本一旦脏了，绝对值对照会跟着失败 ⇒ 同一个根因同时报"不一致"
  // 与"对照失效"，归因变糊。
  const injected = '\n**注**：这一条 ⬜ 还没做，另有 🟡 一条在做。\n';
  controls.push(['负对照：§5 之外的正文里塞进进度标记',
    strayMarkers(ledgerText + injected).length === stray.length + 2]);
}

// ── 对照的评估（**必须**在所有 `controls.push` 之后：本文件有十处 push，分布在四个判据块里）──
// 把评估循环排在中间 ⇒ 后推的对照（路由条数、§5 之外的进度标记、P2-11 的触发线）从没被判过
// —— **排序即判据**。标签自带"正对照 / 负对照"，两类共用这一条出口。
let controlFailed = 0;
for (const [what, ok] of controls) {
  console.log(`  ${ok ? '✓' : '✗'} ${what}`);
  if (!ok) controlFailed++;
}
if (!controls.length) { console.log('  ⚠️ 对照无法构造（账本里没有既带证据又状态可翻转的条目）'); controlFailed++; }

if (problems.length || controlFailed) {
  for (const p of problems) console.log('  ✗ ' + p);
  console.log(`\nLEDGER SELF-CHECK FAILED — ${problems.length} 个不一致，${controlFailed} 个对照失效`);
  process.exit(1);
}
console.log('ALL LEDGER SELF-CHECKS PASSED');
