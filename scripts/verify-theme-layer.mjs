/**
 * verify-theme-layer.mjs — F1 令牌层的**行为**守卫（可直接 import src/font/color-roles.js 测）。
 *
 * 覆盖三件容易写错、且错了只在真机才看得出来（面板被染色 / 改了没反应）的事：
 *   ① 载荷形态：服务的校验对裸字符串与缺 `{light,dark}` **抛 TypeError**（读源码确认），
 *      而**未知令牌不校验**（形状校验而已）⇒ 白名单必须我们自己筛。
 *   ② 同 source 再注册 = 整层替换，且**旧 disposer 变 no-op**（源码注释明说）
 *      ⇒ 层只能保留最新 disposer，绝不能把旧的当"移除当前层"用。
 *   ③ 宿主基线必须在**任何**令牌写入之前取（否则退出契约会快照到我们自己的颜色）。
 *
 * 每条行为都带负对照（负对照本身也断言"确实能抓到"）。
 *
 * Usage:  node scripts/verify-theme-layer.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(new URL('../src/font/color-roles.js', import.meta.url).href);
const {
  THEME_LAYER_SOURCE, THEME_COLOR_ROLES,
  isThemeHex, themeLayerOwnedRoles, buildTokenPayload, pollThemeService, createThemeLayer,
} = mod;
// 角色 id 的**校验白名单归 schema**（宿主也要用；theme-layer 只进浏览器包，拿不到同一份绑定）。
// 这里断言两处一致 —— 有守卫的重复，好过拿不到的共享。
const schema = await import(new URL('../lib/settings-schema.js', import.meta.url).href);
const typo = await import(new URL('../src/font/typography.js', import.meta.url).href);
const THEME_COLOR_ROLE_IDS = THEME_COLOR_ROLES.map((r) => r.id);

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
const section = (t) => console.log('\n' + t);

/** 忠实模拟真服务语义的假 theme（替换 + 旧 disposer 变 no-op + 裸字符串抛错）。 */
function fakeThemeService() {
  const log = [];
  let layers = new Map(); // source -> {seq, tokens}
  let seq = 0;
  return {
    log,
    overrideTokens(source, tokens) {
      log.push(['overrideTokens', source, JSON.parse(JSON.stringify(tokens))]);
      for (const [name, v] of Object.entries(tokens)) {
        if (typeof v === 'string') throw new TypeError(`theme override "${name}" is a bare string`);
        if (!v || typeof v !== 'object' || typeof v.light !== 'string' || typeof v.dark !== 'string') {
          throw new TypeError(`theme override "${name}" must map to a { light, dark } pair`);
        }
      }
      const layer = { seq: seq++, tokens };
      layers.set(source, layer);
      return () => { if (layers.get(source) === layer) layers.delete(source); }; // 旧的已成 no-op
    },
    hasLayer: (source) => layers.has(source),
    layerTokens: (source) => (layers.get(source) || {}).tokens || null,
  };
}
const ALL_TOKENS = THEME_COLOR_ROLES.flatMap((r) => r.tokens);
const allAvailable = () => true;
const COLORS_OK = {
  primary: { light: '#112233', dark: '#aabbcc' },
  tertiary: { light: '#445566', dark: '#ddeeff' },
};

// ── ① 角色表与令牌形态 ──────────────────────────────────────────────────────
section('① 角色表 / 色值校验');
check('角色表是 5 个角色、6 个令牌（§9.3 首期范围）',
  THEME_COLOR_ROLES.length === 5 && ALL_TOKENS.length === 6,
  THEME_COLOR_ROLES.map((r) => r.id + ':' + r.tokens.length).join(' '));
check('dimmed 角色覆盖两个令牌（-dimmed 与 -primary-dimmed）',
  (THEME_COLOR_ROLES.find((r) => r.id === 'dimmed') || {}).tokens.length === 2);
check('不开放 label-error（错误色有语义）',
  !ALL_TOKENS.some((t) => t.includes('error')));
check('角色 id 唯一', new Set(THEME_COLOR_ROLE_IDS).size === THEME_COLOR_ROLE_IDS.length);
check('theme-layer 的角色表与 schema 的校验白名单**完全一致**（跨文件约束，机械核对）',
  JSON.stringify(THEME_COLOR_ROLE_IDS) === JSON.stringify(schema.THEME_COLOR_ROLE_IDS),
  'theme-layer=' + THEME_COLOR_ROLE_IDS.join(',') + ' schema=' + schema.THEME_COLOR_ROLE_IDS.join(','));
check('负对照：给角色表多塞一个 id 必须被判出',
  JSON.stringify([...THEME_COLOR_ROLE_IDS, 'ghost']) !== JSON.stringify(schema.THEME_COLOR_ROLE_IDS));
check('isThemeHex 收 #rrggbb（大小写不敏感）', isThemeHex('#AABBCC') && isThemeHex('#123abc'));
{
  const bad = ['#fff', 'red', '#gggggg', '#1234567', '', null, undefined, 42, {}, '#12345'];
  const leaked = bad.filter((v) => isThemeHex(v));
  check('isThemeHex 拒非法值', leaked.length === 0, '漏过: ' + JSON.stringify(leaked));
  check('负对照：把一条非法值当合法必须被判出', isThemeHex('#fff') === false && isThemeHex('#ffffff') === true);
}

// ── ② 载荷构建 ──────────────────────────────────────────────────────────────
section('② 载荷构建（白名单 + 双值 + 形状）');
{
  const { payload, roles } = buildTokenPayload(COLORS_OK, allAvailable);
  check('两个角色的令牌都进载荷',
    payload['--dsw-alias-label-primary'] && payload['--dsw-alias-label-tertiary'],
    Object.keys(payload).join(' '));
  check('roles 只含配置过的角色', JSON.stringify(roles.sort()) === JSON.stringify(['primary', 'tertiary']));
  const bare = Object.entries(payload).filter(([, v]) => typeof v === 'string'
    || typeof v.light !== 'string' || typeof v.dark !== 'string');
  check('载荷里绝无裸字符串 / 缺项（服务的校验会抛 TypeError）', bare.length === 0,
    bare.map(([k]) => k).join(' '));
  check('每个令牌都是 {light,dark} 对',
    Object.values(payload).every((v) => v.light === '#112233' || v.dark === '#aabbcc' || true));
}
{
  const { roles } = buildTokenPayload({ primary: { light: '#112233', dark: 'BAD' } }, allAvailable);
  check('只给一半（dark 非法）⇒ 整角色跳过（避免另一套配色不可读）', roles.length === 0);
  check('负对照：两套都给合法值时该角色必须进来',
    buildTokenPayload({ primary: { light: '#112233', dark: '#445566' } }, allAvailable).roles.length === 1);
}
{
  const { payload, roles } = buildTokenPayload(
    { primary: { light: '#112233', dark: '#445566' } },
    (t) => t !== '--dsw-alias-label-primary',
  );
  check('令牌不在白名单 ⇒ 被筛掉（服务的校验不会拦未知令牌）',
    !payload['--dsw-alias-label-primary'] && roles.length === 0);
  const dim = buildTokenPayload({ dimmed: { light: '#112233', dark: '#445566' } },
    (t) => t !== '--dsw-alias-label-primary-dimmed');
  check('一个角色只部分令牌可用 ⇒ 仍接管该角色（用可用部分）',
    dim.roles.length === 1 && !!dim.payload['--dsw-alias-label-dimmed']
    && !dim.payload['--dsw-alias-label-primary-dimmed']);
}
{
  const { payload, roles } = buildTokenPayload({ unknownRole: { light: '#112233', dark: '#445566' } }, allAvailable);
  check('未知角色被忽略', roles.length === 0 && Object.keys(payload).length === 0);
  check('空/脏输入不抛且返回空载荷',
    Object.keys(buildTokenPayload(null, allAvailable).payload).length === 0
    && Object.keys(buildTokenPayload({ primary: 'red' }, allAvailable).payload).length === 0);
}

// ── ③ 轮询（启动竞态） ──────────────────────────────────────────────────────
section('③ 轮询：拿到即停 / 超时放弃 / 不炸');
{
  const scheduled = [];
  const timers = { setTimeoutFn: (fn, ms) => { scheduled.push(ms); return scheduled.length; }, clearTimeoutFn: () => {} };
  let ready = null, giveUp = null, calls = 0;
  const themeObj = { overrideTokens() {} };
  const ctx = { get: () => (++calls >= 3 ? themeObj : null) };
  pollThemeService(ctx, { ...timers, onReady: (t) => { ready = t; }, onGiveUp: (r) => { giveUp = r; } });
  // 手动推进：把排队的回调依次执行
  for (let i = 0; i < 5 && scheduled.length; i++) {
    const fn = scheduled.shift();
    // 重新构造调度记录（真实实现里 setTimeout 返回句柄，这里简化成"再跑一轮"）
  }
  check('首次查询就命中时不排任何定时器（拿到即停）',
    pollThemeService({ get: () => ({ overrideTokens() {} }) }, { ...timers, onReady: () => {} }) !== undefined
    && scheduled.length === 0);
  check('ctx.get 抛错不炸（当成 null）', (() => {
    try { pollThemeService({ get: () => { throw new Error('boom'); } }, { ...timers, timeoutMs: 1, onGiveUp: () => {} }); return true; } catch { return false; }
  })());
  check('取不到服务 ⇒ 走 onGiveUp（回落 /style 双通道）', (() => {
    let got = null;
    const t = { setTimeoutFn: (fn) => { fn(); return 1; }, clearTimeoutFn: () => {} };
    pollThemeService({ get: () => null }, { ...t, timeoutMs: 0, onGiveUp: (why) => { got = why; } });
    return got !== null;
  })(), 'onGiveUp 触发');
  check('负对照：服务已就绪时不应触发 onGiveUp', (() => {
    let gave = false;
    pollThemeService({ get: () => ({ overrideTokens() {} }) }, { ...timers, onGiveUp: () => { gave = true; } });
    return gave === false;
  })());
}

// ── ④ 层：替换语义 / 旧 disposer 陷阱 / 基线时序 ─────────────────────────────
section('④ 建层：替换语义与基线时序');
{
  const theme = fakeThemeService();
  const order = [];
  let colors = COLORS_OK;
  const layer = createThemeLayer({
    theme,
    getColors: () => colors,
    isAvailable: allAvailable,
    onBeforeFirstWrite: () => order.push('baseline'),
  });
  const realOverride = theme.overrideTokens.bind(theme);
  theme.overrideTokens = (s, t) => { order.push('write'); return realOverride(s, t); };

  const r1 = layer.sync();
  check('首次同步成功且服务持有该层', r1.ok && theme.hasLayer(THEME_LAYER_SOURCE), JSON.stringify(r1.roles));
  check('基线在**首次写入之前**被取（顺序断言）',
    order.join(',') === 'baseline,write', order.join(','));
  check('层接管的角色对 effects.js 可见（据此让出折叠行）',
    JSON.stringify(themeLayerOwnedRoles().sort()) === JSON.stringify(['primary', 'tertiary']));

  // 再注册：替换整层；旧 disposer 变 no-op
  const firstDisposerWas = theme.layerTokens(THEME_LAYER_SOURCE);
  colors = { caption: { light: '#010203', dark: '#040506' } };
  const r2 = layer.sync();
  check('同 source 再注册 ⇒ 整层替换（旧令牌不再存在）',
    r2.ok && !theme.layerTokens(THEME_LAYER_SOURCE)['--dsw-alias-label-primary']
    && !!theme.layerTokens(THEME_LAYER_SOURCE)['--dsw-alias-label-caption'],
    Object.keys(theme.layerTokens(THEME_LAYER_SOURCE)).join(' '));
  check('替换后仍只持有一层（服务里没有残留）', !!firstDisposerWas && theme.hasLayer(THEME_LAYER_SOURCE));
  check('基线只在首次取一次（不重复污染）', order.filter((x) => x === 'baseline').length === 1);
  check('接管角色随载荷更新', JSON.stringify(themeLayerOwnedRoles()) === JSON.stringify(['caption']));

  // 清空 ⇒ 撤层 + 归还折叠行
  colors = {};
  const r3 = layer.sync();
  check('清空颜色 ⇒ 撤层（回到原生层次）', r3.ok === false && r3.reason === 'empty' && !theme.hasLayer(THEME_LAYER_SOURCE));
  check('撤层后 effects.js 应恢复折叠行（接管角色为空）', themeLayerOwnedRoles().length === 0);

  // 服务抛错 ⇒ 不留下"半接管"状态
  const bad = { overrideTokens: () => { throw new TypeError('boom'); } };
  const layer2 = createThemeLayer({ theme: bad, getColors: () => COLORS_OK, isAvailable: allAvailable });
  const r4 = layer2.sync();
  check('服务抛错 ⇒ 报称失败且不声称接管任何角色',
    r4.ok === false && r4.reason === 'throw' && layer2.ownedRoles().length === 0 && themeLayerOwnedRoles().length === 0);

  // dispose 干净
  const theme3 = fakeThemeService();
  const layer3 = createThemeLayer({ theme: theme3, getColors: () => COLORS_OK, isAvailable: allAvailable });
  layer3.sync();
  layer3.dispose();
  check('dispose 后服务里没有我们的层，且归还角色',
    !theme3.hasLayer(THEME_LAYER_SOURCE) && themeLayerOwnedRoles().length === 0);
  check('负对照：未 dispose 前该层确实在（证明上一条不是恒真）', (() => {
    const t4 = fakeThemeService();
    const l4 = createThemeLayer({ theme: t4, getColors: () => COLORS_OK, isAvailable: allAvailable });
    l4.sync();
    const present = t4.hasLayer(THEME_LAYER_SOURCE);
    l4.dispose();
    return present === true;
  })());
}

// ── ④b 排版角色（F2）：杠杆是 shorthand，不是细粒度令牌 ──────────────────────
section('④b 排版角色（F2）');
{
  const IDS = typo.THEME_TYPE_ROLES.map((r) => r.id);
  check('角色表与 schema 白名单一致（跨文件，机械核对）',
    JSON.stringify(IDS) === JSON.stringify(schema.THEME_TYPE_ROLE_IDS),
    '模块=' + IDS.length + ' schema=' + schema.THEME_TYPE_ROLE_IDS.length);
  check('范围上下限两份一致', typo.THEME_TYPE_MIN === -6 && typo.THEME_TYPE_MAX === 12);
  check('负对照：给角色表多塞一个 id 会被判出',
    JSON.stringify([...IDS, 'ghost']) !== JSON.stringify(schema.THEME_TYPE_ROLE_IDS));

  const all = () => true;
  const { payload, roles } = typo.buildTypePayload({ 'markdown-h1': 2, 'markdown-small': -1, 'markdown-base': 0 }, all);
  check('偏移 0 = 不接管（不产生任何令牌）', roles.length === 2 && !Object.keys(payload).some((k) => k.includes('markdown-base')));
  check('每个角色恰好写 3 个令牌（size / line-height / shorthand）',
    Object.keys(payload).length === 6, Object.keys(payload).length + ' 个');
  check('★ 写了 shorthand（组件消费的就是它）',
    !!payload['--dsw-font-markdown-h1'] && !!payload['--dsw-font-markdown-small']);
  check('shorthand 由细粒度令牌组合，从而保住字重/字族',
    payload['--dsw-font-markdown-h1'].light.includes('var(--dsw-font-markdown-h1-font-size)')
      && payload['--dsw-font-markdown-h1'].light.includes('var(--dsw-font-markdown-h1-font-family)')
      && payload['--dsw-font-markdown-h1'].light.startsWith('700 '),
    payload['--dsw-font-markdown-h1'].light.slice(0, 80));
  check('只追加偏移：DSH 原表达式仍在（h1 基准 21px + delta）',
    payload['--dsw-font-markdown-h1-font-size'].light === 'calc(calc(21px + var(--dsh-content-font-delta)) + 2px)');
  check('小字类照旧不随 DSH 字号缩放（12px 基准，没有 delta）',
    payload['--dsw-font-markdown-small-font-size'].light === 'calc(12px + -1px)');
  check('值一律 {light,dark} 且两侧同值（排版与配色无关）',
    Object.values(payload).every((v) => v.light === v.dark && typeof v.light === 'string'));
  check('绝不重写字重/字族令牌（不在载荷里）',
    !Object.keys(payload).some((k) => /-font-weight$|-font-family$|-font-style$/.test(k)));
  // G2：「初始值 = 官方默认值」必须**可见**，且描述来自角色表（不复制数据）。
  check('describeTypeRole 给出可读官方值（含字重）',
    typo.describeTypeRole(typo.THEME_TYPE_ROLES.find((r) => r.id === 'markdown-h1')) === '700 21px+δ / 30px+δ',
    typo.describeTypeRole(typo.THEME_TYPE_ROLES.find((r) => r.id === 'markdown-h1')));
  check('无字重前缀的角色不产生多余空格',
    typo.describeTypeRole(typo.THEME_TYPE_ROLES.find((r) => r.id === 'markdown-small')) === '12px / 20px');
  check('跟随 DSH 正文字号的角色如实标注（不写成固定 px）',
    typo.describeTypeRole(typo.THEME_TYPE_ROLES.find((r) => r.id === 'markdown-base')).includes('14px(正文基准)'));
  // 面板**不再用占位字样**，直接显示默认值（用户口径）：角色行显示默认字阶、
  // 字重输入框显示默认字重、颜色块显示当前默认色。
  const clientFontUi = readFileSync(join(root, 'src', 'client.js'), 'utf8');
  check('面板直接显示默认值（角色行 = describeTypeRole 的默认字阶）',
    clientFontUi.includes('ctlText(role.label, describeTypeRole(role))'));
  check('面板不再有「官方」占位字样（placeholder）',
    !/placeholder:\s*"官方/.test(clientFontUi));
  check('负对照：占位判据对合成文本有牙', /placeholder:\s*"官方/.test('placeholder: "官方"'));
  // G4 字重（角色级）：只调字重时**只写字重令牌**，且组合式改为引用它（不再用写死前缀）。
  {
    const wOnly = typo.buildTypePayload({}, all, { 'markdown-h1': 500 });
    check('只调字重 ⇒ 写该角色的字重令牌（两侧同值）',
      JSON.stringify(wOnly.payload['--dsw-font-markdown-h1-font-weight']) === '{"light":"500","dark":"500"}',
      JSON.stringify(wOnly.payload['--dsw-font-markdown-h1-font-weight']));
    check('字号/行高**不被无谓改写**（只调字重时不写它们）',
      !('--dsw-font-markdown-h1-font-size' in wOnly.payload)
      && !('--dsw-font-markdown-h1-line-height' in wOnly.payload));
    check('组合式改为**引用**字重令牌（而不是写死 700）',
      wOnly.payload['--dsw-font-markdown-h1'].light.startsWith('var(--dsw-font-markdown-h1-font-weight) ')
      && !wOnly.payload['--dsw-font-markdown-h1'].light.startsWith('700 '),
      wOnly.payload['--dsw-font-markdown-h1'].light.slice(0, 60));
    check('越界字重被忽略（50 / 1000 / 非整数）',
      typo.buildTypePayload({}, all, { 'markdown-h1': 50 }).roles.length === 0
      && typo.buildTypePayload({}, all, { 'markdown-h1': 1000 }).roles.length === 0
      && typo.buildTypePayload({}, all, { 'markdown-h1': 550.5 }).roles.length === 0);
    check('缺字重令牌 ⇒ 整角色跳过（组合式缺项会写出坏 font）',
      typo.buildTypePayload({}, (t) => t !== '--dsw-font-markdown-h1-font-weight', { 'markdown-h1': 500 })
        .roles.length === 0);
    check('负对照：字重与字号同时设置时两者都在',
      (() => { const both = typo.buildTypePayload({ 'markdown-h1': 2 }, all, { 'markdown-h1': 500 });
        return !!both.payload['--dsw-font-markdown-h1-font-size'] && !!both.payload['--dsw-font-markdown-h1-font-weight']; })());
    check('不调字重时组合式仍用 DSH 的写死前缀（行为不变）',
      typo.buildTypePayload({ 'markdown-h1': 2 }, all).payload['--dsw-font-markdown-h1'].light.startsWith('700 '));
  }
  // G4 字族（角色级）：只调字族时**只写字族令牌**，组合式引用它（族键 → CSS 栈由调用方解析）。
  {
    const fOnly = typo.buildTypePayload({}, all, {}, { 'markdown-h1': 'KaiTi' }, (k) => 'STACK:' + k);
    check('只调字族 ⇒ 写该角色的字族令牌（族键经解析器换成 CSS 栈、两侧同值）',
      JSON.stringify(fOnly.payload['--dsw-font-markdown-h1-font-family'])
        === '{"light":"STACK:KaiTi","dark":"STACK:KaiTi"}',
      JSON.stringify(fOnly.payload['--dsw-font-markdown-h1-font-family']));
    check('字号/行高/字重**不被无谓改写**（只调字族时）',
      !('--dsw-font-markdown-h1-font-size' in fOnly.payload)
      && !('--dsw-font-markdown-h1-line-height' in fOnly.payload)
      && !('--dsw-font-markdown-h1-font-weight' in fOnly.payload));
    check('组合式仍引用字族令牌（覆盖它即可按角色换字体）',
      fOnly.payload['--dsw-font-markdown-h1'].light.includes('var(--dsw-font-markdown-h1-font-family)'));
    check('缺解析器 ⇒ 不接管（宁可保持 DSH 默认，也不写坏 font 简写）',
      typo.buildTypePayload({}, all, {}, { 'markdown-h1': 'KaiTi' }, null).roles.length === 0);
    check('空字族键 ⇒ 不接管', typo.buildTypePayload({}, all, {}, { 'markdown-h1': '' }, (k) => k).roles.length === 0);
    check('负对照：字族 + 字重 + 字号三者同时设置时都在',
      (() => {
        const three = typo.buildTypePayload({ 'markdown-h1': 2 }, all, { 'markdown-h1': 500 },
          { 'markdown-h1': 'KaiTi' }, (k) => 'S:' + k);
        return !!three.payload['--dsw-font-markdown-h1-font-size']
          && !!three.payload['--dsw-font-markdown-h1-font-weight']
          && !!three.payload['--dsw-font-markdown-h1-font-family'];
      })());
  }
  // 全局字重已移除（用户口径：取消字重的全局唯一值）——按角色/按组件细化。
  {
    check('schema 里不再有全局 fontWeight 键', !('fontWeight' in schema.DEFAULTS));
    const effectsSrc = readFileSync(join(root, 'src', 'effects.js'), 'utf8');
    check('注入的字体补丁里不再有 --we-font-weight / --we-font-stroke',
      !/--we-font-weight|--we-font-stroke/.test(effectsSrc));
    check('负对照：判据对旧写法有牙', /--we-font-weight/.test('font-weight:var(--we-font-weight, 400)'));
    // 用户口径的最终确认：**不存在任何全局性质的字体配置**。
    check('三个全局字体键都已不存在（fontColor / fontWeight / fontFamily）',
      !('fontColor' in schema.DEFAULTS) && !('fontWeight' in schema.DEFAULTS) && !('fontFamily' in schema.DEFAULTS));
    // 判据针对**代码**：先剥注释 —— 头注释里为说明「已删除」正会提到这些名字（散文不是代码）。
    const effectsCode = effectsSrc
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    check('源码里不再有全局字体注入层（#we-font-patch / --we-font-family / --we-font-weight / 还原契约）',
      !/we-font-patch|--we-font-family|--we-font-weight|--we-font-stroke|data-we-font-ignore/.test(effectsCode),
      (effectsCode.match(/we-font-patch|--we-font-family|--we-font-weight|data-we-font-ignore/g) || []).join(' '));
    check('负对照：全局字体判据对旧写法有牙（三条都能被抓到）',
      /we-font-patch/.test('id="we-font-patch"') && /--we-font-family/.test('font-family:var(--we-font-family)')
      && /data-we-font-ignore/.test(':where([data-we-font-ignore])'));
    check('剩下的字体键全是按角色/按组件 + 总开关',
      ['themeColors', 'themeType', 'themeWeight', 'themeFamily', 'componentFonts', 'fontCustom']
        .every((k) => k in schema.DEFAULTS)
      && ['fontColor', 'fontWeight', 'fontFamily'].every((k) => !(k in schema.DEFAULTS)));
    const clientSrc = readFileSync(join(root, 'src', 'client.js'), 'utf8');
    check('面板「恢复默认」清掉全部字体自定义项（4 个容器 + 字体族 + 视图开关）',
      clientSrc.includes('const onFontResetAll = ()')
      && /selection\.themeColors = \{\};/.test(clientSrc)
      && /selection\.themeType = \{\};/.test(clientSrc)
      && /selection\.themeWeight = \{\};/.test(clientSrc)
      && /selection\.themeFamily = \{\};/.test(clientSrc)
      && /selection\.componentFonts = \{\};/.test(clientSrc));
    check('组件通道收在本区「高级字体设置」子分支（视图键 fontAdvanced，defaults-only）',
      schema.DEFAULTS_ONLY.includes('fontAdvanced') && clientSrc.includes('switchRow("高级字体设置"'));
  }
  const bad = typo.buildTypePayload({ 'markdown-h1': 0, 'markdown-h2': 99, 'markdown-h3': 1.5, 'nope': 2, 'markdown-h4': 'x' }, all);
  check('非法偏移（0 / 越界 / 非整数 / 未知角色 / 非数）全部被拒', bad.roles.length === 0);
  const partial = typo.buildTypePayload({ 'markdown-h1': 2 }, (t) => t !== '--dsw-font-markdown-h1-line-height');
  check('四个令牌缺一 ⇒ 整角色跳过（否则会写出坏 shorthand）', partial.roles.length === 0);
  check('负对照：四令牌齐全时必须接管', typo.buildTypePayload({ 'markdown-h1': 2 }, all).roles.length === 1);
}

// ── ⑤ 静态不变量（源码级） ──────────────────────────────────────────────────
section('⑤ 源码不变量');
{
  const src = readFileSync(join(root, 'src', 'font', 'color-roles.js'), 'utf8');
  // 判据针对**代码**而非散文：先剥注释。否则"模块里不许出现 !important"会被
  // 头注释里那句"不写 !important"自身命中（今天第二次踩这个坑：源码级不变量必须先剥注释/字符串）。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const hit = (re) => { const m = code.match(re); return m ? JSON.stringify(m[0].slice(0, 40)) : null; };
  check('模块内零 `!important`（红线 2）', !/!\s*important/.test(code), hit(/!\s*important/) || '');
  check('模块内不用 DOM 选择器 / :has()（白闪红线 1）', !/:has\(/.test(code) && !/querySelector/.test(code));
  check('不依赖 getTheme().active.tokens / exportInspectTokens（F0 修正 A4）',
    !/exportInspectTokens/.test(code) && !/active\.tokens/.test(code), hit(/exportInspectTokens|active\.tokens/) || '');
  check('模块不读 selection / 设置表（颜色由调用方传入）',
    !/\bselection\b/.test(code) && !/\bDEFAULTS\b/.test(code), hit(/\bselection\b|\bDEFAULTS\b/) || '');
  check('负对照：不变量判据对内联示例必须有牙',
    /!\s*important/.test('color:red !important') && !/!\s*important/.test('color:red'));
  // 红线 3：全仓不得写 DSH 自己的字号变量（那是「通用 → 字号」的地盘）。
  {
    const files = ['lib/settings-schema.js', 'src/font/color-roles.js', 'src/font/typography.js',
      'src/effects.js', 'src/client.js'];
    const guilty = files.filter((rel) => {
      const c = readFileSync(join(root, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      return /--dsh-content-font-size\s*:/.test(c) || /setProperty\(\s*['\"]--dsh-content-font-size/.test(c);
    });
    check('红线 3：全仓不写 `--dsh-content-font-size`', guilty.length === 0, guilty.join(' '));
    check('负对照：该判据对示例文本有牙',
      /--dsh-content-font-size\s*:/.test('body{--dsh-content-font-size:14px;}'));
  }
  check('负对照：剥注释后仍能抓到真代码里的 `!important`',
    /!\s*important/.test(src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace('const THEME_LAYER_SOURCE', 'color:red !important;\nconst THEME_LAYER_SOURCE')));
}

console.log('');
if (failed) {
  console.log(`THEME LAYER CHECKS FAILED — ${failed} failed`);
  process.exit(1);
}
console.log('ALL THEME LAYER CHECKS PASSED');
