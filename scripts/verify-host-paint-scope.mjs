#!/usr/bin/env node
/**
 * 宿主容器「上色必须做状态限定」护栏 (host-container paint scope guard)
 *
 * 背景（上游 issue #107，0.1.7 回归）：宿主右栏面板容器 `[data-sidebar-right-panel]`
 * 在**关闭态**仍然占着宽度 —— 0.1.7 把隐藏方式改成"子元素 `visibility:hidden` + 沿
 * `--dsh-sidebar-width` 滑出"，容器自己**没有背景**，靠"没背景所以不显形"这个前提工作。
 * 而本插件无条件给这个容器刷了玻璃底/近不透明底 ⇒ 关闭态在对话区右侧露出一块中灰板
 * （控制台零报错，用户会误判成主题/皮肤问题）。
 *
 * 0.1.5 的隐藏方式不同（容器**自己** `visibility:hidden` + `translate(100%)` 完全滑出，
 * 见本机 `dsh-client-ui-sidebar-right@0.1.5-rc.2` 源码），所以当时刷底看不见 —— 这既是
 * 回归的成因，也说明**加限定是向后兼容的 no-op**：`data-sidebar-right-open` 在 0.1.5-rc.2
 * 上就已存在且语义相同（`expanded || void 0`）。
 *
 * 本护栏把规则固化：**凡是给 `[data-sidebar-right-panel]` 上色的选择器，都必须带
 * `[data-sidebar-right-open]`**。它防的是"类"而不是这一次 —— 新增一条刷底规则忘了限定，
 * 行为断言（`verify-scene-live` / `verify-readability` 等）都不会变红。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 读**构建产物**（与 verify-readability 同源）：它才是实际注入浏览器的字符串。
// 源码侧的选择器同名同形，改 src 后必须 `npm run build` 才会在这里生效（这也顺带
// 断住"改了源码忘了重建"）。
const SRC = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS | ' + name + (detail ? ' | ' + detail : ''));
  else { console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); failed++; }
}

// 注入的样式表：与 verify-readability 同法求值（选择器本身不含插值，但保持同一来源）。
const CSS_BODY = (SRC.match(/const CSS = `([^`]*)`;/) || [])[1] || '';
const num = (re) => Number((SRC.match(re) || [])[1]);
let CSS = '';
try {
  CSS = new Function('READABILITY_FLOOR', 'READABILITY_FLOOR_DARK', 'return `' + CSS_BODY + '`;')(
    num(/const READABILITY_FLOOR = ([\d.]+);/), num(/const READABILITY_FLOOR_DARK = ([\d.]+);/));
} catch { CSS = CSS_BODY; }

const TARGET = '[data-sidebar-right-panel]';
const GATE = '[data-sidebar-right-open]';

/** 取出每个 `[data-sidebar-right-panel]` 出现处所在规则的**选择器原文**（未压空白）。 */
function panelSelectors(css) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(TARGET, from);
    if (at < 0) break;
    from = at + TARGET.length;
    const open = css.indexOf('{', at);
    const close = css.indexOf('}', at);
    // 只在**选择器位置**上判定：该出现处后面必须先遇到 `{`（规则头），而不是先遇到 `}`。
    if (open < 0 || (close >= 0 && close < open)) continue;
    const start = Math.max(css.lastIndexOf('{', at), css.lastIndexOf('}', at)) + 1;
    out.push(css.slice(start, open));
  }
  return out;
}
const NORM = (s) => s.replace(/\s+/g, ' ').trim();

const rawSels = panelSelectors(CSS);
const sels = rawSels.map(NORM);
const unqualified = sels.filter((s) => !s.includes(GATE));
const qualified = sels.filter((s) => s.includes(GATE));

// ── H0 模板完整性：CSS 模板内不得出现反引号 ──────────────────────────────────
// 整段样式表是一个模板字符串；注释里写 markdown 反引号会**提前截断**它，于是所有
// "提取样式表"的护栏（本文件与 verify-readability F1b）都读到空串 —— 而且报错信息
// 只说"css chars=0"，不看源码根本猜不到原因。这条把它变成一句人能看懂的失败。
{
  const start = SRC.indexOf('const CSS = `');
  const endMark = '\n\t\t`;';
  const altEnd = '\n  `;';
  let end = endMark ? SRC.indexOf(endMark, start) : -1;
  if (end < 0 && altEnd) end = SRC.indexOf(altEnd, start);
  const region = start >= 0 ? SRC.slice(start + 'const CSS = `'.length, end < 0 ? undefined : end) : '';
  // 允许转义反引号（奇数个反斜杠前缀），其余一律视为截断风险。
  const rawBackticks = [...region.matchAll(/(^|[^\\])((?:\\\\)*)`/g)].length;
  const mutatedRegion = region + '\n  /* 反引号 ` 注入 */';
  const caughtBacktick = [...mutatedRegion.matchAll(/(^|[^\\])((?:\\\\)*)`/g)].length > rawBackticks;
  check('H0 注入的 CSS 模板内没有裸反引号（注释里写 markdown 反引号会截断模板，让样式表护栏读到空串）',
    region.length > 1000 && rawBackticks === 0 && caughtBacktick,
    `模板长度 ${region.length} 字符 · 裸反引号 ${rawBackticks}` +
    ` · 负对照 注入一个反引号后被抓到 ${caughtBacktick ? 1 : 0}/1`);
}

// 负对照：把**某条真实选择器**（不是注释）里的状态属性删掉，同一判定必须报出未限定。
// ⚠️ 两个坑都踩过：①用"压过空白的选择器"去 replace 原文对不上（静默不生效）；
// ②删"CSS 里第一处 [data-sidebar-right-open]"实际删的是**注释里**那一处。
const firstRaw = rawSels[sels.findIndex((s) => s.includes(GATE))];
const mutated = firstRaw ? CSS.replace(firstRaw, firstRaw.replace(GATE, '')) : CSS;
const unqualifiedAfterMutation = panelSelectors(mutated).map(NORM).filter((s) => !s.includes(GATE));

check('H1 给宿主右栏面板上色的每条规则都限定在展开态（[data-sidebar-right-open]）',
  sels.length >= 6 && unqualified.length === 0 && qualified.length >= 6
  && firstRaw !== undefined && mutated !== CSS && unqualifiedAfterMutation.length >= 1,
  `命中规则 ${sels.length} 条（已限定 ${qualified.length}）` +
  `${unqualified.length ? ' · 未限定: ' + unqualified.join(' | ') : ''}` +
  ` · 负对照 去掉一条选择器的限定后被抓到 ${unqualifiedAfterMutation.length >= 1 ? 1 : 0}/1`);

// ── H2（仅报告）：其它被我们上色的宿主原生容器 ────────────────────────────────
// 判据同上：这些元素是否"留在布局里、只靠子元素隐藏"需要各自核对；本护栏只负责把
// 审计面列出来（#107 的教训是：这类前提一旦被宿主改掉，插件侧就是静默的视觉回归）。
const MARKERS = ['[data-dsh-better-sidebar]', '.dshDesktopSidebarSurface', '[data-composer-card]', '[role="dialog"]'];
const audit = MARKERS.map((m) => {
  let n = 0, from = 0;
  for (;;) {
    const at = CSS.indexOf(m, from);
    if (at < 0) break;
    from = at + m.length;
    const open = CSS.indexOf('{', at);
    const close = CSS.indexOf('}', at);
    if (open >= 0 && (close < 0 || open < close)) n++;
  }
  return m + '×' + n;
});
console.log('INFO | H2 其它被上色的宿主容器（需各自核对"关闭态是否留在布局里"）: ' + audit.join(' · '));

console.log(failed === 0 ? '\nverify-host-paint-scope: OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
