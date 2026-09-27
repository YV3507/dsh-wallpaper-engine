/**
 * theme-typography.js — 按角色调整**排版**（字号/行高的偏移），走 DSH theme 令牌层（F2）。
 *
 * ══ 为什么是这套令牌（静态分析结论，2026-09-27；不是猜的）══════════════════════════
 *
 * ① **组件消费的是 shorthand，不是细粒度令牌。**
 *    DSH 组件里 `font:` 用的全是简写，例如
 *      node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/markdown/MarkdownText.module.css:17
 *        font: var(--dsw-font-markdown-h1);
 *    全仓 *.css 扫下来：`font: var(--dsw-font-<角色>)` 共 **24 处**（MarkdownText 的
 *    base/h1-h4/base-strong/code/table/table-head、CodeCard、DiffBlock、SearchBlock、
 *    TerminalBlock、WebBlock）；而细粒度里**只有** `-font-family` 有 1 处消费者
 *    （user-text.module.css:31），`-font-size` / `-font-weight` / `-font-style` **零消费者**。
 *    ⇒ 只改 `--dsw-font-<角色>-font-size` **必然无效**（那条路是诱饵）。
 *
 * ② **shorthand 是字面量、不由细粒度令牌组合。**
 *    定义在 @deepseek-ai/dsh-client-ui-theme/lib/client.js 的 design-platform CSS 串里，三种形态：
 *      A. 带 delta 的基准：  `markdown-h1: 700 calc(21px + var(--dsh-content-font-delta)) / calc(30px + …) var(--dsw-font-family)`
 *      B. 用 DSH 正文字号：  `markdown-base: var(--dsh-content-font-size,14px) / calc(24px + var(--dsh-content-font-delta)) …`
 *      C. 纯字面量（不随 DSH 字号缩放）：`markdown-small: 12px/20px …`、`markdown-code: 12px/19px …`
 *    ⇒ 本模块**逐角色保留 DSH 原本的 size/line-height 表达式**（照抄，不"统一化"），
 *      只在其后追加我们的偏移 —— 于是 C 类照旧不缩放、B 类继续跟随 DSH 字号，语义不变。
 *
 * ③ **DSH 自己的「通用 → 字号」是这么进来的**：宿主半
 *    (dsh-client-ui-theme/lib/index.js:56) 往 body 写 `--dsh-content-font-size`；CSS 里定义
 *      `--dsh-content-font-delta: calc(var(--dsh-content-font-size,14px) - 14px)`
 *    （自带 14px 兜底，所以 shorthand 不会 invalid）。**本模块从不写 `--dsh-content-font-size`**
 *    —— 那是 DSH 自己的设置（红线 3），我们只在角色级叠加偏移，用户的 DSH 字号照常生效。
 *
 * ④ **重取角色表的方法**（DSH 升级后基准值变了就重跑这一条，然后核对下表）：
 *    node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');for(const m of s.matchAll(/--dsw-font-([a-z0-9-]+?):([^;{}\\"]+)/g))if(!/-font-|-line-height$|-font$/.test(m[1]))console.log(m[1],'=',m[2].trim().slice(0,90))"
 *      "D:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js"
 *
 * ══ 契约 ══════════════════════════════════════════════════════════════════════════
 * 需要的外界：**无**（纯计算；令牌可用性由调用方给的判据决定）。
 * 对外提供：THEME_TYPE_ROLES / buildTypePayload / THEME_TYPE_SOURCE / 偏移上下限。
 *   建层与轮询复用 src/theme-layer.js 的 createThemeLayer / pollThemeService ——
 *   **必须用不同的 source**：同 source 再注册会整层替换，会把 F1 的颜色层顶掉。
 *
 * 不变量（有守卫）：
 *   · 每个被调整的角色写 **3 个令牌**（`-font-size` / `-line-height` / shorthand），
 *     且**四个令牌全部存在**才接管该角色（缺一个就会写出坏 shorthand ⇒ 整条字体失效）。
 *   · 只追加偏移，**不重写** DSH 的表达式、不碰字重/字族（它们在 shorthand 里走 DSH 自己的
 *     细粒度令牌：`var(--dsw-font-<角色>-font-family)`）。
 *   · 值一律 `{light, dark}` 且**两侧同值**（排版与配色无关）。
 */

const THEME_TYPE_SOURCE = 'wallpaper-engine-typography';

/** 偏移范围（px）。上限故意保守：排版是"微调层次"，不是重做字阶。 */
const THEME_TYPE_MIN = -6;
const THEME_TYPE_MAX = 12;

const DELTA = 'var(--dsh-content-font-delta)';
const DELTA_2 = 'var(--dsh-content-font-delta-secondary)';
const BODY_SIZE = 'var(--dsh-content-font-size,14px)';
const BODY_SIZE_2 = 'var(--dsh-content-font-size-secondary,13px)';

/**
 * 角色表：`id` = DSH 的令牌角色名（令牌名由它派生），表达式**照抄 DSH 原文**。
 * prefix 是 shorthand 里字号之前的那一段（字重/斜体），同样照抄。
 */
const THEME_TYPE_ROLES = [
  // —— 对话区 markdown（MarkdownText.module.css 消费）——
  { id: 'markdown-h1', label: '标题 1', prefix: '700', size: `calc(21px + ${DELTA})`, lh: `calc(30px + ${DELTA})` },
  { id: 'markdown-h2', label: '标题 2', prefix: '700', size: `calc(19px + ${DELTA})`, lh: `calc(28px + ${DELTA})` },
  { id: 'markdown-h3', label: '标题 3', prefix: '700', size: `calc(18px + ${DELTA})`, lh: `calc(26px + ${DELTA})` },
  { id: 'markdown-h4', label: '标题 4', prefix: '600', size: BODY_SIZE, lh: `calc(24px + ${DELTA})` },
  { id: 'markdown-base', label: '对话正文', prefix: '', size: BODY_SIZE, lh: `calc(24px + ${DELTA})` },
  { id: 'markdown-small', label: '小字说明', prefix: '', size: '12px', lh: '20px' },
  { id: 'markdown-code', label: '行内代码', prefix: '', size: '12px', lh: '19px' },
  { id: 'markdown-code-block', label: '代码块', prefix: '', size: '11px', lh: '19px' },
  { id: 'markdown-table', label: '表格', prefix: '', size: BODY_SIZE_2, lh: `calc(22px + ${DELTA_2})` },
  { id: 'markdown-table-head', label: '表头', prefix: '500', size: BODY_SIZE_2, lh: `calc(22px + ${DELTA_2})` },
  // —— 界面通用阶梯（SearchBlock / WebBlock / TerminalBlock 消费 xs-13）——
  { id: 'xs-13', label: '界面小字', prefix: '', size: '13px', lh: '20px' },
  { id: 'xxs-12', label: '界面极小字', prefix: '', size: '12px', lh: '18px' },
];

const typeTokenNames = (role) => ({
  size: `--dsw-font-${role}-font-size`,
  lineHeight: `--dsw-font-${role}-line-height`,
  family: `--dsw-font-${role}-font-family`,
  shorthand: `--dsw-font-${role}`,
});

/** 偏移是否可用（整数、在范围内、非 0）。0 = 不接管该角色（回到 DSH 原样）。 */
function isTypeOffset(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
    && v >= THEME_TYPE_MIN && v <= THEME_TYPE_MAX && v !== 0;
}

/**
 * 把「角色 → 偏移(px)」编译成 overrideTokens 载荷。
 * @param offsets 形如 `{ 'markdown-h1': 2, 'markdown-small': -1 }`（可缺键/可脏）
 * @param isAvailable `(token) => boolean` —— 四个令牌全可用才接管该角色
 * @returns {{ payload: object, roles: string[] }}
 */
function buildTypePayload(offsets, isAvailable) {
  const src = offsets && typeof offsets === 'object' ? offsets : {};
  const ok = typeof isAvailable === 'function' ? isAvailable : () => true;
  const payload = {};
  const roles = [];
  for (const role of THEME_TYPE_ROLES) {
    const off = src[role.id];
    if (!isTypeOffset(off)) continue;
    const t = typeTokenNames(role.id);
    // 四个令牌缺一不可：缺 -line-height 或 -font-family 会写出坏 shorthand（整条 font 失效）。
    if (![t.size, t.lineHeight, t.family, t.shorthand].every((n) => ok(n))) continue;
    const size = `calc(${role.size} + ${off}px)`;
    const lh = `calc(${role.lh} + ${off}px)`;
    // 字重/字族不重写：走 DSH 自己的细粒度令牌（它们本来就在）。
    const prefix = role.prefix ? role.prefix + ' ' : '';
    const shorthand = `${prefix}var(${t.size}) / var(${t.lineHeight}) var(${t.family})`;
    // 排版与配色无关 ⇒ 两侧同值（服务要求成对，给不同值会让深浅配色下字阶不一致）。
    payload[t.size] = { light: size, dark: size };
    payload[t.lineHeight] = { light: lh, dark: lh };
    payload[t.shorthand] = { light: shorthand, dark: shorthand };
    roles.push(role.id);
  }
  return { payload, roles };
}

export {
  THEME_TYPE_SOURCE, THEME_TYPE_ROLES,
  THEME_TYPE_MIN, THEME_TYPE_MAX,
  isTypeOffset, typeTokenNames, buildTypePayload,
};
