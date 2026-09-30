/**
 * verify-ledger.mjs — 账本自检（P1-8）：断言 docs/wip/OPEN-ITEMS.md §5 的
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

const LEDGER = join(root, 'docs', 'wip', 'OPEN-ITEMS.md');

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

/** 守卫的档位：硬档进 `verify`（挡 PR），软档进 `verify:docs`（照跑照打印，不决定红绿）。
 *  "已入链"必须问**两档之和**，否则每把一条守卫移出硬档都会让账本误报"守卫没入链"。 */
const GUARD_CHAINS = () => {
  const s = JSON.parse(read('package.json')).scripts;
  return String(s.verify || '') + ' ' + String(s['verify:docs'] || '');
};
const inAnyChain = (name) => GUARD_CHAINS().includes(name);

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
    ['退役行守卫已入链（硬档或软档）', () => inAnyChain('verify-retired-lines')],
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
    ['账本自检守卫已入链（硬档或软档）', () => inAnyChain('verify-ledger')],
  ],
  'F0': [
    ['真机清单已归档（结论并入 §9.1 的 V1–V10）',
      () => has('docs/archive/audits/F0-THEME-SERVICE-CHECKLIST.md')],
    ['账本 §9.1 的 V 表在册（首尾两行都查）', () => {
      const l = read('docs/wip/OPEN-ITEMS.md');
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
    // 四条 !important 折叠 + 全局墨色覆盖 + 三个全局字体键都已删除；**判据本体在
    // `test/verify-theme-layer.mjs`**，这里只断言"那三个键真的不在设置真源里"（不在两处各写一份）。
    ['设置真源里这三个键确实不在默认值里', () => {
      const d = read('lib/settings-schema.js');
      return !/'fontColor'/.test(d) && !/^\s*fontWeight:/m.test(d) && !/^\s*fontFamily:/m.test(d);
    }],
  ],
  'G2': [
    // 「初始值 = 官方默认值」必须**可见**且来自角色表（不复制数据）。判据本体在
    // `test/verify-theme-layer.mjs`（三条断言），这里不再复述 —— 读守卫源码找字符串
    // 只能证明"那句话还在文件里"，证明不了判据有效，所以本条目按"无机器可核产物"如实记账。
  ],
  'G3': [
    ['官方 --dsl-* 钩子白名单在位（通道的唯一真源）',
      () => read('src/font/components.js').includes('const DSL_FONT_HOOKS = [')],
  ],
  'G4': [
    ['组件字体模块在位（id 与实测模块名分离 + 启动自探测）', () => {
      const m = read('src/font/components.js');
      return m.includes('const COMPONENT_FONT_TARGETS = [') && m.includes('function probeComponentTargets(')
        && m.includes('function buildComponentCss(');
    }],
  ],
  'P2-9': [
    // 「客户端零裸 fetch」由 `test/verify-api-client.mjs` ① 判（它自带模块清单与覆盖面下限）；
    // 这里只核**结构事实**：出入口在位、进了构建清单、产物里恰好一份、持久化委托真源。
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
    ['类型守卫在位且已入链', () => has('test/verify-types.mjs') && inAnyChain('verify-types')],
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
      return n >= 10 && read('docs/wip/OPEN-ITEMS.md').includes('| 构建期内联模块 | **' + n + ' 个**');
    }],
    ['§2 基线表：守卫计数 == 两档链条数之和（硬档 verify + 软档 verify:docs）', () => {
      const n = new Set(GUARD_CHAINS().match(/verify-[a-z-]+\.mjs/g) || []).size;
      const stated = Number((read('docs/wip/OPEN-ITEMS.md')
        .match(/\*\*(\d+) 个 `verify-\*`/) || [])[1] || 0);
      return n >= 20 && stated === n;
    }],
    ['§2 基线表：冒烟计数 == smoke 链条数', () => {
      const chain = JSON.parse(read('package.json')).scripts.smoke;
      const n = new Set(chain.match(/[a-z-]+-smoke\.mjs/g) || []).size;
      // 表里那句可能被排版改动（加粗 / 换行），所以只认「`+ N 个 smoke`」这个数字骨架，
      // 不绑死紧随其后的括号 —— 绑死了就是"改标点即红"的脆弱判据。
      const stated = Number((read('docs/wip/OPEN-ITEMS.md')
        .match(/\+ (\d+) 个 smoke/) || [])[1] || 0);
      return n >= 3 && stated === n;
    }],
    // 规模类只设**上限**（棘轮）：表里的数字只许比实测大，不许比实测小 —— 重构后基线悄悄变大
    // 会被判红，而"实际比表里小"是安全的（表是上界，不是精确值）。
    ['§2 基线表：src/client.js 行数仍是上界（棘轮）', () => {
      const stated = Number(String((read('docs/wip/OPEN-ITEMS.md')
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
      const m = read('docs/wip/OPEN-ITEMS.md')
        .match(/`lib\/\*\*`（[^\n|]*）\s*\|\s*\*\*([\d,]+) 文件 \/ ([\d,]+) 行\*\*/) || [];
      const statedFiles = Number(String(m[1] || '').replace(/,/g, ''));
      const statedLines = Number(String(m[2] || '').replace(/,/g, ''));
      return statedFiles === files.length && statedLines > 0 && total <= statedLines;
    }],
  ],
  'P3-3': [
    ['可达性守卫在位且已入链（硬档或软档）', () => has('test/verify-reachability.mjs')
      && inAnyChain('verify-reachability')],
  ],
  'P3-4': [
    ['死 import 已删（lib/index.js 不再有裸 readPkg；readPkgEntry 是活依赖）',
      () => !/\breadPkg\b/.test(stripComments(read('lib/index.js')))],
  ],
  'P3-5': [
    // 判据本体在 `test/verify-module-layout.mjs`（它自带"除 client.js 外零孤儿"的扫描）。
    // 本条目按"无机器可核产物"如实记账：读守卫源码找函数名证明不了那条判据有效。
  ],
  'P3-6': [
    // 判据本体在 `test/verify-module-layout.mjs`（lib → src 零条边的零容忍断言）。
  ],
  'P3-7': [
    // 判据本体在 `test/verify-module-layout.mjs`（共享内核白名单 + 未登记内核扫描）。
  ],
  'P3-8': [
    // 判据本体在 `test/verify-comment-discipline.mjs`（域从磁盘枚举 + 日期/编年史两条全局判零）。
  ],
  'P3-9': [
    // 本条说的是"P2-9 / P2-10 / P2-11 三条已有机器证据" —— 那三张表就在上面的 `EVIDENCE` 里，
    // 它们**能跑**就是证据。读本文件自己的源码找表名只是同义反复，已删。
  ],
  'P3-10': [
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
    // 可达性 + 标记等价由 `test/verify-picker-props.mjs` 自己判（golden / 绝对锚点 / 负对照）；
    // 这里只核"它确实在 verify 链里"—— 读它的源码找常量名证明不了判据有效。
    ['属性面板守卫已在 verify 链里', () => inAnyChain('verify-picker-props')],
    ['计划文件已归档（wip 里不再有 P3-11-PLAN.md）',
      () => !has('docs/wip/P3-11-PLAN.md') && has('docs/archive/audits/P3-11-PLAN.md')],
  ],
  'P3-12': [
    ['package.json 声明 engines.node = 代码真实下限', () => {
      const p = JSON.parse(read('package.json'));
      return Boolean(p.engines && p.engines.node === '>=18');
    }],
  ],
  'P3-13': [
    ['CI 已给 media-bridge 端到端接上 --provision',
      () => read('.github/workflows/verify.yml').includes('verify:bridge')],
  ],
  'P3-14': [
    // 判据：那四份守卫里，**每个用来过滤规则的集合都被量过长度**（"过滤集变空即恒真"的防线）。
    // 做法是**结构判据**而不是找某句话：先剥注释（散文里出现同样的词会让判据假绿），
    // 数每个过滤器标识符被 `.length` 量到的次数 —— 有"只用不量"的标识符就判红。
    // 判据：那两份守卫里**非空下限**还在（"过滤集变空 ⇒ 判据恒真"的防线）。
    // 只数**文件级**的下限总数，不逐个过滤器判 —— 逐个判会误伤从不需要量长度的中间数组
    //（`fbText`、`allowed` 这类），那是把"覆盖"变成"噪声"。要更硬就得把守卫跑起来（`verify:all`）。
    ['两份守卫的非空下限还在（过滤集变空即恒真的防线）', () => {
      const floors = (file) => (stripComments(read(file))
        .match(/\.length\s*(?:>=|>|===|!==)\s*[0-9]+/g) || []).length;
      const theme = floors('test/verify-theme-layer.mjs');
      const soft = floors('test/verify-softrender.mjs');
      return theme >= 5 && soft >= 5;
    }],
  ],
  'P3-15': [
    // "EVIDENCE 键必须被查到"这条判据本体就在本文件的 `audit()` 里，每轮都在跑；
    // 读本文件源码找那句错误文案是同义反复，已删。
    ['F 轨与 P 轨的 ID 形态都被账本解析（`F1` / `P2-12` 两种）', () => {
      // 判据本体：解析一段合成账本，两种 ID 都必须被认出来（走**同一个** parseLedger）。
      const synth = ['| F1 | 说明 | ✅ |', '| P2-12 | 说明 | ⬜ |'].join('\n');
      const ids = parseLedger(synth).map((r) => r.id);
      return ids.includes('F1') && ids.includes('P2-12') && ROW_ID.test('| **G4** | 说明 | ✅ |');
    }],
  ],
  'P3-16': [
    ['形态规则写进了守卫约定的家（TEST-LAYOUT §约定）',
      () => read('docs/TEST-LAYOUT.md').includes('负对照必须把变异输入喂进「同一条判据」')],
  ],
  'P3-27': [
    // 五条里四条原本是"读守卫源码找某句话"。保留的两条核的是**产品侧的机制**（判据由
    // `npm run verify` 里的守卫本体执行），其余按"无机器可核产物"如实记账。
    ['harness 基线"追尾"修复在位（按内容身份判重）', () => {
      const s = read('scripts/harness-compat-baseline.mjs');
      return s.includes('function pluginRevision(') && s.includes('plugin.revision');
    }],
    ['规则 ⑦ 的共享实现在位（字符串感知剥注释，被多个守卫 import）', () => {
      const users = ['test/verify-ledger.mjs', 'test/verify-client.mjs', 'test/verify-api-client.mjs',
        'test/verify-module-layout.mjs']
        .filter((f) => read(f).includes("from './tools/js-text.mjs'") || read(f).includes('tools/js-text.mjs'));
      return has('test/tools/js-text.mjs') && users.length >= 3;
    }],
  ],
  'P3-23': [
    // 审计工具的判据由工具自身的自检（`node test/tools/audit-fixture-coverage.mjs`）负责；
    // 这里只核"工具在位"，不再读它的源码找某句话。
    ['夹具覆盖审计工具在位', () => has('test/tools/audit-fixture-coverage.mjs')],
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
    // 「活依赖存活」的两条反向判据挂在 `P2-12` 的证据里（本文件上方），每轮都在跑；
    // 这里只核产品侧的事实：scene-manifest 仍然存活。
    ['scene-manifest 仍然存活（收窄机器退出条件的依据）', () => has('lib/scene-manifest.js')],
  ],
  'P3-20': [
    ['复制度结论写明了作用域（单边结论不得当全仓不变量）', () => {
      const l = read('docs/wip/OPEN-ITEMS.md');
      return l.includes('只对浏览器半边成立') && l.includes('已限定作用域');
    }],
  ],
  'P3-21': [
    // 跨半边契约的判据本体在 `test/verify-contracts.mjs`（读两边源码比对）；这里只核
    // **产品侧的事实**：两边的前缀与 MIME 表真的存在（判据非空转）。
    ['跨半边契约的两侧真源都在（BASE + 上传 MIME + 自定义画面 MIME）', () => {
      const api = read('src/api-client.js');
      const host = read('lib/index.js');
      return /const BASE =/.test(api) && /const BASE =/.test(host)
        && /const UPLOAD_TYPES = \[/.test(read('src/client.js'))
        && /UPLOAD_EXT|CUSTOM_FRAME_EXT/.test(host);
    }],
  ],
  'P3-22': [
    ['413 用例接受两种合法结果，且"恰好 limit+1"那条仍在（精确 413 由它钉死）', () => {
      const g = read('test/verify-scene.mjs');
      return g.includes('或连接被主动掐断') && g.includes('恰好 limit+1（超限块即最后一块）仍收到 413');
    }],
  ],
  'P3-24': [
    // 判据盯**口径**（触发面 + 第三方排除 + 基线落点），不盯实现细节：
    // 工作流与脚本怎么重构都行，"怎么触发、跑什么、不跑什么、基线何时写"这四件事不能变。
    ['适配工作流口径：只手动派发（无常驻触发）、跑 verify:all、不跑 verify:bridge、基线落点在册', () => {
      const y = read('.github/workflows/harness-compat.yml');
      // 「不自动触发」是**缺席断言**，只许对着 `on:` 块判：头部注释里那句「不挂 schedule / push」
      // 同样是这几个字，按全文扫等于拿自己的散文当证据（写作纪律：断言缺席前先剥散文）。
      const triggersOf = (t) => t.slice(t.indexOf('\non:'), t.indexOf('\nconcurrency:'));
      const autoTriggered = (t) => /\n\s+(schedule|push):/.test(triggersOf(t));
      return triggersOf(y).includes('workflow_dispatch')
        && !autoTriggered(y)
        // 负对照：挂了 push 的合成 `on:` 块必须被判出，否则上面那半条判据恒真。
        && autoTriggered('\nname: x\non:\n  push:\n    branches: [main]\nconcurrency:\n  group: x\n')
        && y.includes('npm view @deepseek-ai/dsh dist-tags.latest')
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
  ],
  'P3-25': [
    // 判据盯「机制在位」：枚举差集 + 清单内容 + 工作流接线。清单内容的对错由 compat CI
    // 对着真 harness 实跑裁定；探针脚本自身的行为由 `test/compat-harness-surfaces.mjs` 跑出来。
    ['UI 面清单棘轮脚本在位且接了 compat CI', () => {
      const y = read('.github/workflows/harness-compat.yml');
      return has('test/compat-harness-surfaces.mjs') && y.includes('compat-harness-surfaces.mjs');
    }],
    ['清单 fixture 在位且按 latest 播种（sidebar-right = covered，其余带合法 verdict）', () => {
      const f = JSON.parse(read('test/fixtures/harness-ui-surfaces.json'));
      const names = Object.keys(f.known);
      return names.length >= 41 && String(f.meta.seededFrom).includes('0.1.7')
        && f.known['dsh-client-ui-sidebar-right'] && f.known['dsh-client-ui-sidebar-right'].verdict === 'covered'
        && Object.values(f.known).every((v) => ['covered', 'native', 'exempt'].includes(v.verdict));
    }],
    ['sidebar 面裁定的依据点名真源码锚点（裁定与源码绑在一起，不靠散文）', () => {
      const f = JSON.parse(read('test/fixtures/harness-ui-surfaces.json'));
      const note = String((f.known['dsh-client-ui-sidebar-right'] || {}).note || '');
      // 锚点写作 `data-sidebar-right-panel/-open`（合并式写法），所以这里同时接受两种形态。
      return note.includes('data-sidebar-right-panel')
        && (note.includes('data-sidebar-right-open') || note.includes('-panel/-open'));
    }],
  ],
  'P3-26': [
    // 判据盯「探针在位 + 接线」：页面断言的牙齿由页面脚本自己的变异实证给出
    //（锚点改名 ⇒ 玻璃三条变红），这里只钉"脚本在位、接到工作流、以 CDP 驱动"。
    ['页面断言脚本在位且接了 compat CI', () => {
      const y = read('.github/workflows/harness-compat.yml');
      return has('test/compat-harness-pages.mjs') && y.includes('compat-harness-pages.mjs');
    }],
    ['探针是零依赖 CDP（真浏览器计算样式，不是 DOM 快照）', () => {
      const g = read('test/compat-harness-pages.mjs');
      return g.includes('new WebSocket(') && g.includes('Runtime.evaluate')
        && g.includes('settings.section') && g.includes('--lang=zh-CN');
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
  const ledger = read('docs/wip/OPEN-ITEMS.md');
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
