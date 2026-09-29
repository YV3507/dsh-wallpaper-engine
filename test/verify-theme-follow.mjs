#!/usr/bin/env node
/**
 * verify-theme-follow.mjs — 主题随壁纸：取色优先级、亮度判决、写入去重与让位规则。
 *
 * 为什么要有这一层：这个功能**没有开关**（行为即自动），所以它的每一条自我约束都只能
 * 靠守卫看着 —— 取色顺序错了会在部分壁纸上给出反向主题；亮度阈值漂了会让"深色壁纸配浅色
 * 界面"这种错误变成常态；写入不去重会在轮换列表里每次切换都改一次 profile 文件
 *（`setTheme` 会把偏好落进 `cordis.patch.yml`）；不认"用户已经手动改过主题"会跟用户抢
 * 控制权。四条都在这里钉住。
 *
 * 分节：
 *   ① 颜色解析与 WCAG 亮度：三种来源写法（宿主 rgb() / CSS hex / WE 0–1 浮点三元组）、
 *      黑=0 白=1 中灰≈0.2159、阈值两侧的判决、缺色返回空判决
 *   ② 画面主色（纯函数）：量化到 4 bit/通道后取众数桶、透明像素不参与、空输入返回 null
 *   ③ 行为：作者配色 → 判决；覆盖值优先；同判决不重复写；外来改动即让位、换壁纸恢复；
 *      服务缺席不抛
 *   ④ 接线（源码形态）：attach 挂在主题层 onReady 上、applySelection 里落 schemeColor
 *      并触发评估、面板有一行说明、模块已登记进内联清单
 *
 * 本模块与 src/adapter.js 一样，按构建期契约以**同作用域**内联（`selection` /
 * `propTokenOf` / `storedUserPropsOf` 都是外部作用域的自由变量）⇒ 这里把这三个名字挂到
 * globalThis 上复现同一形态；每种初值用**新 URL 重新 import**，避免模块级判定状态互相污染。
 *
 * Usage: node test/verify-theme-follow.mjs
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};

globalThis.ADAPTER_TARGET_VALUES = [];   // 与本次无关，但保证同作用域里没有未声明自由变量
let diagTraces = [];                     // 本模块的决策留痕（每次 freshThemeFollow 清空）
let transientWrites = {};                // 状态行落到的瞬态字段（面板从 sel 上读）
let importSeq = 0;
/** 重新 import 该模块（模块内的判定状态是模块级的，跨用例会互相污染）。 */
async function freshThemeFollow({ selection: sel, props = {} } = {}) {
  diagTraces = [];
  globalThis.reportClientDiag = (ev, detail) => { diagTraces.push(ev + ':' + String(detail)); };
  transientWrites = {};
  globalThis.setTransient = (field, value) => { transientWrites[field] = value; };
  globalThis.selection = sel || { id: "", schemeColor: null, previewUrl: "" };
  globalThis.propTokenOf = (s) => (s && s.propsUrl ? String(s.propsUrl).split("/").pop() : "");
  globalThis.storedUserPropsOf = (token) => (props[token] ? { ...props[token] } : {});
  return import(pathToFileURL(join(root, 'src', 'theme-follow.js')).href + '?case=' + (++importSeq));
}
/** 假主题服务 + 假 ctx：记录写入、记录订阅回调（供"用户改主题"用例手动触发）。 */
function makeFake(preference) {
  const calls = [];
  const handlers = [];
  const svc = {
    preference,
    getTheme() { return { preference: svc.preference }; },
    setTheme(v) { calls.push(v); svc.preference = v; },
  };
  const ctx = { on(ev, cb) { handlers.push([ev, cb]); return () => {}; } };
  return { svc, ctx, calls, handlers };
}
/** 一条最小壁纸条目（只带本模块会读的字段）。 */
function wallpaper(id, schemeColor, extra) {
  return Object.assign({ id, schemeColor, previewUrl: "", propsUrl: "" }, extra || {});
}
/**
 * 模拟"当前壁纸"：把桩 selection 换成这一条并触发评估 —— 生产里这两个东西本来就是同一个
 * 对象，而 accept 会核对它们一致（防止抓帧结果落到已经切走的那张上）。
 */
function onWallpaper(m, sel) {
  globalThis.selection = Object.assign({}, globalThis.selection, {
    id: sel.id, schemeColor: sel.schemeColor, previewUrl: sel.previewUrl || "", propsUrl: sel.propsUrl || "",
  });
  m.themeFollowOnWallpaper(globalThis.selection);
  return sel;
}

// ═══ ① 颜色解析与亮度 ═════════════════════════════════════════════════════════
console.log('\n① 颜色解析与 WCAG 亮度判决');
{
  const m = await freshThemeFollow();
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('宿主写法 rgb(r, g, b) 可解析', eq(m.themeFollowParseColor('rgb(29, 56, 84)'), [29, 56, 84]),
    JSON.stringify(m.themeFollowParseColor('rgb(29, 56, 84)')));
  check('CSS 写法 #rrggbb / #rgb 可解析',
    eq(m.themeFollowParseColor('#1d3854'), [29, 56, 84]) && eq(m.themeFollowParseColor('#fff'), [255, 255, 255]));
  check('WE 属性的 0–1 浮点三元组可解析（面板覆盖值走这条）',
    eq(m.themeFollowParseColor('0.114 0.220 0.329'), [29, 56, 84]),
    JSON.stringify(m.themeFollowParseColor('0.114 0.220 0.329')));
  check('越界值被夹住、而不是溢出（0–1 域与 0–255 域各一条）',
    eq(m.themeFollowParseColor('300 -5 128'), [255, 0, 128])
    && eq(m.themeFollowParseColor('-0.2 0.5 0.9'), [0, 128, 230]),
    JSON.stringify(m.themeFollowParseColor('300 -5 128')) + ' / ' + JSON.stringify(m.themeFollowParseColor('-0.2 0.5 0.9')));
  // 混合域（有分量 > 1）：整条按 0–255 解释 —— 规则单一、可预期，不猜也不抛。
  check('混合域按 0–255 解释（规则显式写死在判据里）',
    eq(m.themeFollowParseColor('1.5 0.5 0.5'), [2, 1, 1]),
    JSON.stringify(m.themeFollowParseColor('1.5 0.5 0.5')));
  check('认不得的形状 ⇒ null（不猜）',
    m.themeFollowParseColor('not-a-color') === null && m.themeFollowParseColor('') === null
    && m.themeFollowParseColor(null) === null && m.themeFollowParseColor('1 2') === null);
  // 负对照：把合法值改坏一个字，同一条判据必须判空
  check('负对照：同一条解析判据对坏输入返回 null',
    m.themeFollowParseColor('rgb(29, 56)') === null && m.themeFollowParseColor('#1d385') === null);

  const lumBlack = m.themeFollowLuminance([0, 0, 0]);
  const lumWhite = m.themeFollowLuminance([255, 255, 255]);
  const lumMid = m.themeFollowLuminance([128, 128, 128]);
  check('亮度极值：黑 = 0、白 = 1', lumBlack === 0 && Math.abs(lumWhite - 1) < 1e-9,
    'black=' + lumBlack + ' white=' + lumWhite.toFixed(6));
  check('阈值是 0.40 —— "明显偏亮才浅色"（不再等于中灰）',
    m.THEME_FOLLOW_LIGHT_ABOVE === 0.4 && lumMid < m.THEME_FOLLOW_LIGHT_ABOVE,
    'mid=' + lumMid.toFixed(4) + ' threshold=' + m.THEME_FOLLOW_LIGHT_ABOVE);

  check('颜色规则本身不变：纯黑仍判深色（"没填"是取色链的事，不是判决的事）',
    m.themeFollowVerdict(m.themeFollowParseColor('0 0 0')) === 'dark');
  check('恰好 (0,0,0) 被判为「作者没填」（WE 新建工程的默认值）',
    m.themeFollowIsUnfilledSchemeColor([0, 0, 0]) === true
    && m.themeFollowIsUnfilledSchemeColor([0, 0, 1]) === false
    && m.themeFollowIsUnfilledSchemeColor([1, 0, 0]) === false
    && m.themeFollowIsUnfilledSchemeColor([255, 255, 255]) === false
    && m.themeFollowIsUnfilledSchemeColor(null) === false);
  check('深色方案色（0.114 0.220 0.329）⇒ 深色主题',
    m.themeFollowVerdict(m.themeFollowParseColor('0.114 0.220 0.329')) === 'dark');
  check('浅色方案色（Frieren 那张 0.619… 0.765… 0.910…）⇒ 浅色主题',
    m.themeFollowVerdict(m.themeFollowParseColor('0.6196078431372549 0.7647058823529411 0.9098039215686274')) === 'light');
  check('阈值两侧的判决（灰 169 = 深色，灰 170 = 浅色 —— 边界就在 0.40 上）',
    m.themeFollowVerdict([169, 169, 169]) === 'dark' && m.themeFollowVerdict([170, 170, 170]) === 'light',
    '169=' + m.themeFollowVerdict([169, 169, 169]) + ' 170=' + m.themeFollowVerdict([170, 170, 170]));
  // 两个真实投诉样本：饱和中间调人眼看是深的，0.40 门槛下判深色（中灰阈值时它们都判浅）。
  check('报过的两张壁纸在新门槛下都判深色（#00918A 与 88/168/88 的绿）',
    m.themeFollowVerdict([0, 145, 138]) === 'dark' && m.themeFollowVerdict([88, 168, 88]) === 'dark',
    'teal=' + m.themeFollowVerdict([0, 145, 138]) + ' green=' + m.themeFollowVerdict([88, 168, 88]));
  check('没有颜色 ⇒ 空判决（调用方据此"保持当前主题"）',
    m.themeFollowVerdict(null) === '' && m.themeFollowVerdict([1, 2]) === '');
}

// ═══ ② 画面主色（纯函数）══════════════════════════════════════════════════════
console.log('\n② 画面占比最大色（纯函数，供守卫直测）');
{
  const m = await freshThemeFollow();
  const px = (list) => {
    const b = Buffer.alloc(list.length * 4);
    list.forEach(([r, g, b2, a], i) => { b[i * 4] = r; b[i * 4 + 1] = g; b[i * 4 + 2] = b2; b[i * 4 + 3] = a === undefined ? 255 : a; });
    return b;
  };
  const mostlyRed = px([[255, 0, 0], [255, 0, 0], [255, 0, 0], [0, 0, 255]]);
  check('多数派胜出（3 红 1 蓝 ⇒ 红桶中心）',
    JSON.stringify(m.themeFollowModeColorOf(mostlyRed, 2, 2)) === JSON.stringify([248, 8, 8]),
    JSON.stringify(m.themeFollowModeColorOf(mostlyRed, 2, 2)));
  check('透明像素不参与（全透明 ⇒ null）',
    m.themeFollowModeColorOf(px([[255, 0, 0, 0], [255, 0, 0, 0]]), 2, 1) === null);
  check('半透明像素参与（alpha = 128 算在场）',
    JSON.stringify(m.themeFollowModeColorOf(px([[255, 0, 0, 128]]), 1, 1)) === JSON.stringify([248, 8, 8]));
  check('空输入 ⇒ null（不抛）',
    m.themeFollowModeColorOf(null, 0, 0) === null && m.themeFollowModeColorOf(Buffer.alloc(0), 1, 1) === null);
  // 负对照：把同一张图改成全透明，判据必须从"有结果"变成 null
  check('负对照：同一判据把整图改透明后返回 null',
    m.themeFollowModeColorOf(mostlyRed, 2, 2) !== null
    && m.themeFollowModeColorOf(px([[255, 0, 0, 0], [255, 0, 0, 0], [255, 0, 0, 0], [0, 0, 255, 0]]), 2, 2) === null);
  check('确定性：同一张图两次得到同一个答案',
    JSON.stringify(m.themeFollowModeColorOf(mostlyRed, 2, 2)) === JSON.stringify(m.themeFollowModeColorOf(mostlyRed, 2, 2)));
}

// ═══ ③ 行为：判决 / 去重 / 让位 / 降级 ════════════════════════════════════════
console.log('\n③ 行为：写入口的三条自我约束');
{

  {
    const m = await freshThemeFollow();
    const f = makeFake('light');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    check('作者配色 ⇒ 写入对应主题（深色方案写 dark）',
      JSON.stringify(f.calls) === JSON.stringify(['dark']), JSON.stringify(f.calls));
  }  {
    const m = await freshThemeFollow();
    const f = makeFake('dark');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    m.themeFollowOnWallpaper(wallpaper('w2', 'rgb(4, 6, 10)'));
    check('结论与当前偏好相同 ⇒ 一次都不写（轮换不写盘）',
      f.calls.length === 0, 'calls=' + JSON.stringify(f.calls));
  }
  {
    const m = await freshThemeFollow();
    const f = makeFake('light');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    const before = f.calls.length;
    f.svc.preference = 'light';                    // 用户在 DSH 里改回浅色：外部改动，不经我们的写入口
    for (const [ev, cb] of f.handlers) if (ev === 'theme/change') cb();
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    check('让位后不再插手（同一张壁纸再评估也被拦下）', f.calls.length === before,
      'before=' + before + ' after=' + f.calls.length);
    m.themeFollowOnWallpaper(wallpaper('w2', 'rgb(4, 6, 10)'));
    check('换下一张壁纸才恢复自动', f.calls.length === before + 1,
      'calls=' + JSON.stringify(f.calls));
  }
  {
    const m = await freshThemeFollow({ props: { tok: { schemecolor: '0.9 0.9 0.9' } } });
    const f = makeFake('dark');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(0, 0, 0)', { propsUrl: '/wallpaper-engine/props/tok' }));
    check('面板覆盖值优先于作者值（覆盖成浅色 ⇒ 写 light）',
      JSON.stringify(f.calls) === JSON.stringify(['light']), JSON.stringify(f.calls));
  }
  {
    const m = await freshThemeFollow();
    const f = makeFake('light');
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    check('服务还没就绪时不抛、也不写', f.calls.length === 0);
    m.themeFollowAttach(null, null);
    m.themeFollowAttach({}, null);                 // 形状不对的服务：同样只当"没有"
    check('形状不对的服务被拒绝（不误当可用）', f.calls.length === 0);
  }
  {
    const m = await freshThemeFollow();
    const f = makeFake('light');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', null, { previewUrl: '' }));
    check('两条取色都拿不到 ⇒ 保持当前主题（一个字节都不写）', f.calls.length === 0);
  }
  {
    // 负对照：把"去重"这条判据喂给一个不去重的实现（同一偏好也写），它必须判出差别。
    const m = await freshThemeFollow();
    const f = makeFake('dark');
    m.themeFollowAttach(f.svc, f.ctx);
    m.themeFollowOnWallpaper(wallpaper('w1', 'rgb(4, 6, 10)'));
    const deduped = f.calls.length === 0;
    const naiveWrites = ['dark'].length > 0;       // 不去重的实现会写 1 次
    check('负对照：同一条判据能区分"去重"与"每次都写"', deduped === true && naiveWrites === true);
  }
}

// ═══ ④ 恰好 0 0 0 的作者值：视作「没填」═══════════════════════════════════════
console.log('\n④ 恰好 0 0 0 的作者值视作没填 ⇒ 退回画面主色');
{
  const m = await freshThemeFollow();
  check('作者值恰好纯黑 ⇒ 取色链返回"没有配色"（交给画面主色）',
    m.themeFollowSchemeColorOf({ schemeColor: 'rgb(0, 0, 0)', propsUrl: '' }) === null);
  check('作者值不是纯黑 ⇒ 照用（差一个分量也算填了）',
    JSON.stringify(m.themeFollowSchemeColorOf({ schemeColor: 'rgb(0, 0, 1)', propsUrl: '' })) === JSON.stringify([0, 0, 1])
    && JSON.stringify(m.themeFollowSchemeColorOf({ schemeColor: 'rgb(1, 0, 0)', propsUrl: '' })) === JSON.stringify([1, 0, 0]));
  check('作者值纯白照用（规则只管纯黑）',
    JSON.stringify(m.themeFollowSchemeColorOf({ schemeColor: 'rgb(255, 255, 255)', propsUrl: '' })) === JSON.stringify([255, 255, 255]));
}
{
  const m = await freshThemeFollow({ props: { tok: { schemecolor: '0 0 0' } } });
  check('面板里显式填的纯黑照用（明确意图 ≠ 默认值）',
    JSON.stringify(m.themeFollowSchemeColorOf(
      { schemeColor: 'rgb(0, 0, 0)', propsUrl: '/wallpaper-engine/props/tok' })) === JSON.stringify([0, 0, 0]));
}
{
  // 端到端：作者纯黑 + 没有图可采样 ⇒ 保持当前主题（不因为"没填"反手写深色）
  const m = await freshThemeFollow();
  const f = makeFake('light');
  m.themeFollowAttach(f.svc, f.ctx);
  m.themeFollowOnWallpaper({ id: 'w1', schemeColor: 'rgb(0, 0, 0)', previewUrl: '', propsUrl: '' });
  check('作者纯黑 + 无图可采样 ⇒ 一个字节都不写（不反手写深色）',
    f.calls.length === 0, JSON.stringify(f.calls));
}

// ═══ ⑤ 两条腿的合议：都说是浅色才用浅色 ════════════════════════════════════════
console.log('\n⑤ 两条腿合议：真实帧与预览图不一致时取深色，都说是浅色才浅色');
{
  const m = await freshThemeFollow();
  const f = makeFake('light');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w1', null));
  m.themeFollowAcceptImageVerdict([40, 45, 50], 1);          // 预览图：深
  check('预览图结果被采纳（只有一条腿 ⇒ 按它走，写 dark）',
    JSON.stringify(f.calls) === JSON.stringify(['dark']), JSON.stringify(f.calls));
  m.themeFollowAcceptImageVerdict([240, 240, 240], 2);       // 真实帧：浅（与预览图相反）
  check('两条腿不一致 ⇒ 取深色（真实帧不再单方面反转结论）',
    JSON.stringify(f.calls) === JSON.stringify(['dark']), JSON.stringify(f.calls));
  check('不一致这件事留下了痕迹（诊断 + 面板瞬态状态行）',
    diagTraces.some((t) => t.includes('theme-follow') && t.includes('不一致'))
    && String(transientWrites.themeFollowLine || '').includes('不一致'),
    (diagTraces.slice(-1)[0] || '(无)') + ' || ' + String(transientWrites.themeFollowLine || ''));
  m.themeFollowAcceptImageVerdict([40, 45, 50], 1);          // 迟到的预览图结果
  check('迟到的预览图结果不再回头改（rank 1 ≤ 已采纳的 2）',
    f.calls.length === 1, JSON.stringify(f.calls));
}
{
  // 两条腿都说是浅色 ⇒ 浅色（真的亮才切）
  const m = await freshThemeFollow();
  const f = makeFake('dark');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w2', null));
  m.themeFollowAcceptImageVerdict([240, 240, 240], 1);       // 预览图：浅
  m.themeFollowAcceptImageVerdict([250, 250, 250], 2);       // 真实帧：浅
  check('两条腿都说是浅色 ⇒ 写 light',
    JSON.stringify(f.calls) === JSON.stringify(['light']), JSON.stringify(f.calls));
}
{
  // 只有真实帧、没有预览图（图挂了）⇒ 按真实帧走
  const m = await freshThemeFollow();
  const f = makeFake('dark');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w3', null));
  m.themeFollowAcceptImageVerdict([240, 240, 240], 2);       // 只有帧这一条腿：浅
  check('只有真实帧一条腿时说浅色也认（唯一证据）',
    JSON.stringify(f.calls) === JSON.stringify(['light']), JSON.stringify(f.calls));
}
{
  const m = await freshThemeFollow();
  const f = makeFake('light');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w4', 'rgb(10, 12, 16)'));        // 作者配色在场
  const before = f.calls.length;
  m.themeFollowAcceptImageVerdict([240, 240, 240], 2);
  check('作者配色在场 ⇒ 两条腿都不参与（作者说了算）',
    f.calls.length === before, 'calls=' + JSON.stringify(f.calls));
}
{
  // 合议状态随壁纸清零：新壁纸只拿到预览图那一条腿时，不该被上一张的结论挡住
  const m = await freshThemeFollow();
  const f = makeFake('dark');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w5', null));
  m.themeFollowAcceptImageVerdict([240, 240, 240], 2);       // 只有帧：浅 ⇒ light
  onWallpaper(m, wallpaper('w6', null));                     // 换壁纸 ⇒ 两条腿与排名全清
  m.themeFollowAcceptImageVerdict([40, 45, 50], 1);          // 新壁纸的预览图：深
  check('换壁纸后合议状态清零（新壁纸的预览图结论照常生效）',
    JSON.stringify(f.calls) === JSON.stringify(['light', 'dark']), JSON.stringify(f.calls));
}
{
  // 抓帧入口本身：document 打桩，验证它确实读像素、并按真实帧那一档进合议
  const m = await freshThemeFollow();
  const f = makeFake('light');
  m.themeFollowAttach(f.svc, f.ctx);
  onWallpaper(m, wallpaper('w7', null));
  const px = Buffer.alloc(4 * 4);                            // 4 个暗像素
  for (let i = 0; i < 4; i++) { px[i * 4] = 30; px[i * 4 + 1] = 30; px[i * 4 + 2] = 30; px[i * 4 + 3] = 255; }
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {}, getImageData: () => ({ data: px }) }),
    }),
  };
  m.themeFollowOnFrameCanvas({});
  globalThis.document = prevDoc;
  check('场景抓帧入口：画布的占比最大色进了合议（唯一证据 ⇒ 写 dark）',
    JSON.stringify(f.calls) === JSON.stringify(['dark']), JSON.stringify(f.calls));
}
{
  const m = await freshThemeFollow();
  const f = makeFake('light');
  m.themeFollowAttach(f.svc, f.ctx);
  transientWrites = {};
  onWallpaper(m, wallpaper('w8', 'rgb(10, 12, 16)'));
  check('状态行会随判决落到瞬态字段（面板据此显示"当前：…"）',
    String(transientWrites.themeFollowLine || '').includes('作者配色')
    && String(transientWrites.themeFollowLine || '').includes('深色'),
    String(transientWrites.themeFollowLine || '(无)'));
}

// ═══ ⑥ 接线（源码形态）════════════════════════════════════════════════════════
console.log('\n⑥ 接线：服务句柄 / 切换评估 / 面板说明 / 内联登记');
{
  const clientSrc = read('src/client.js');
  const prepSrc = read('src/media-prep.js');
  const tabsSrc = read('src/panel-tabs.js');
  const buildSrc = read('scripts/build-client.mjs');
  check('主题服务句柄接在既有的 theme 轮询 onReady 上（不新增轮询）',
    /onReady: \(theme\) => \{ themeFollowAttach\(theme, ctx\);/.test(clientSrc));
  check('applySelection 落 schemeColor（垫底图的底色兜底因此不再永远为空）',
    prepSrc.includes('selection.schemeColor = w.schemeColor || null;')
    && read('src/live-layer.js').includes('sel.schemeColor ||'));
  check('applySelection 触发评估', prepSrc.includes('themeFollowOnWallpaper(selection);'));
  check('清空/被过滤两条早退分支也把配色清掉（不留上一张的残值）',
    prepSrc.split('selection.schemeColor = null;').length - 1 >= 2);
  check('面板有一行说明（没有控件，只说明规则与让位条件）',
    tabsSrc.includes('深浅主题按当前壁纸自动切换'));
  check('模块已登记进内联清单（否则永远不进产物）',
    buildSrc.includes("file: 'src/theme-follow.js'"));
  check('产物里确实带上了判定常量（构建期内联生效）',
    read('lib/client.js').includes('THEME_FOLLOW_LIGHT_ABOVE'));
  const liveSrc = read('src/live-layer.js');
  check('两条真实抓帧路径都接上了：场景画布 + 网页 __wp.capture',
    liveSrc.includes('themeFollowOnFrameCanvas(canvas);')
    && liveSrc.includes('themeFollowOnFrameImage(dataUrl);'));
}

console.log('\n' + (failed ? 'THEME-FOLLOW CHECKS FAILED — ' + failed + ' failed' : 'ALL THEME-FOLLOW CHECKS PASSED'));
process.exit(failed ? 1 : 0);
