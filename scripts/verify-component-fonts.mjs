/**
 * verify-component-fonts.mjs — G4 组件字体通道的守卫。
 *
 * 这条通道抓的是 DSH 的 CSS-module 类名（`_模块_哈希_行`），**是打包器产物而非官方 API**
 * ⇒ 守卫的重点不是"功能对不对"，而是"**不许越界**"：
 *   · 选择器只能是 `body [class*="_<白名单前缀>_"]` 这一种形态（不许裸类名/标签/`:has()`/祖先关联）；
 *   · 只写白名单前缀、只写三个字体属性；
 *   · 不许把**哈希**写进代码（写死哈希 = DSH 一升级就静默失效）；
 *   · 未命中的组件整条不启用（自探测降级）；
 *   · 空配置不生成任何规则（**官方值作初始值**：不设置 = 回官方）。
 *
 * Usage:  node scripts/verify-component-fonts.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(new URL('../src/component-fonts.js', import.meta.url).href);
const { COMPONENT_FONT_TARGETS, COMPONENT_FONT_PROPS, probeComponentTargets, buildComponentCss, selectorFor } = mod;

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
const section = (t) => console.log('\n' + t);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ALL = COMPONENT_FONT_TARGETS.map((t) => t.prefix);
const MARKDOWN = 'markdown';

// ── ① 选择器形态（唯一合法模板） ────────────────────────────────────────────
section('① 选择器形态：只许 `body [class*="_前缀_"]`');
{
  const sel = selectorFor(MARKDOWN);
  check('形态正确', sel === 'body [class*="_markdown_"]', sel);
  check('拒绝裸类名形态', (() => { try { selectorFor('.markdown'); return false; } catch { return true; } })());
  check('拒绝不在白名单的前缀', (() => { try { selectorFor('evilTarget'); return false; } catch { return true; } })());
  check('拒绝带特殊字符的前缀', (() => { try { selectorFor('a b'); return false; } catch { return true; } })());
  const css = buildComponentCss({ markdown: { size: 15 } }, ALL);
  check('生成的 CSS 里每个选择器都符合唯一形态',
    css.split('\n').filter((l) => l.includes('{')).every((l) => /^body \[class\*="_[A-Za-z][A-Za-z0-9]*_"\] \{$/.test(l.trim())),
    css.split('\n').filter((l) => l.includes('{')).join(' | '));
  check('负对照：形态判据对越界写法有牙',
    !/^body \[class\*="_[A-Za-z][A-Za-z0-9]*_"\] \{$/.test('.markdown {')
    && !/^body \[class\*="_[A-Za-z][A-Za-z0-9]*_"\] \{$/.test('body :has(.markdown) {')
    && !/^body \[class\*="_[A-Za-z][A-Za-z0-9]*_"\] \{$/.test('body .markdown {'));
}

// ── ② 只写白名单前缀 + 三个字体属性 ─────────────────────────────────────────
section('② 白名单与前缀/属性边界');
{
  const css = buildComponentCss(
    { markdown: { size: 15, weight: 600, family: '"KaiTi"' }, evilTarget: { size: 99 } }, ALL);
  check('只出现白名单内前缀', !css.includes('evilTarget'));
  const props = [...css.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
  const bad = props.filter((p) => !COMPONENT_FONT_PROPS.includes(p));
  check('只写 font-size / font-weight / font-family', bad.length === 0, bad.join(' ') || '（无越界属性）');
  check('负对照：属性判据能抓到越界属性', !COMPONENT_FONT_PROPS.includes('line-height'));
}

// ── ③ 自探测降级 ────────────────────────────────────────────────────────────
section('③ 自探测：未命中整条不启用');
{
  const fake = (hits) => ({ querySelectorAll: (sel) => ({ length: hits.some((h) => sel.includes('_' + h + '_')) ? 1 : 0 }) });
  const hit = probeComponentTargets(fake(['markdown', 'table']));
  check('只返回命中的前缀', JSON.stringify(hit.slice().sort()) === JSON.stringify(['markdown', 'table']), hit.join(' '));
  const none = probeComponentTargets(fake([]));
  check('全不命中 ⇒ 空数组（打包器改名时整条降级）', none.length === 0);
  check('没有 document 也不炸', probeComponentTargets(null).length === 0);
  const css = buildComponentCss({ markdown: { size: 15 }, table: { size: 14 } }, ['markdown']);
  check('只给命中的组件生成规则', css.includes('_markdown_') && !css.includes('_table_'));
  check('负对照：全命中时两个都该生成',
    buildComponentCss({ markdown: { size: 15 }, table: { size: 14 } }, ['markdown', 'table']).includes('_table_'));
}

// ── ④ "官方值作初始值"：空配置不生成 ────────────────────────────────────────
section('④ 空 = 回官方（不生成规则）');
{
  check('空配置 ⇒ 空串', buildComponentCss({}, ALL) === '');
  check('缺键 ⇒ 空串', buildComponentCss({ markdown: {} }, ALL) === '');
  check('0 / 空串 ⇒ 不覆盖该项',
    buildComponentCss({ markdown: { size: 0, weight: 0, family: '' } }, ALL) === '');
  const partial = buildComponentCss({ markdown: { size: 15 } }, ALL);
  check('只设字号 ⇒ 只写 font-size（其余保持官方）',
    partial.includes('font-size: 15px') && !partial.includes('font-weight') && !partial.includes('font-family'));
  check('越界值被忽略（字重 50 / 字号 -3）',
    buildComponentCss({ markdown: { weight: 50 } }, ALL) === ''
    && buildComponentCss({ markdown: { size: -3 } }, ALL) === '');
  check('负对照：合法边界值必须被接受（字重 100/900、字号 1）',
    buildComponentCss({ markdown: { weight: 100 } }, ALL).includes('font-weight: 100')
    && buildComponentCss({ markdown: { weight: 900 } }, ALL).includes('font-weight: 900')
    && buildComponentCss({ markdown: { size: 1 } }, ALL).includes('font-size: 1px'));
}

// ── ⑤ 源码不变量 ────────────────────────────────────────────────────────────
section('⑤ 源码不变量');
{
  const code = strip(readFileSync(join(root, 'src/component-fonts.js'), 'utf8'));
  check('零 !important（写死的声明里 315/319 无 !important ⇒ 等特异性即可）', !/!\s*important/.test(code));
  // 判据只针对**生成的 CSS**（源码里的 `length > 0` 是 JS 比较符，不是 CSS 子组合器 ——
  // 对源码做 `\s>\s` 匹配是假阳性）。
  check('零 :has() / 祖先关联选择器（白闪红线 1）',
    !/:has\(/.test(code)
    && !buildComponentCss({ markdown: { size: 15 } }, ALL).includes('>')
    && !buildComponentCss({ markdown: { size: 15 } }, ALL).includes('~'));
  check('**不把哈希写进代码**（写死哈希 = DSH 一升级就静默失效）',
    !/_[A-Za-z0-9]+_[a-z0-9]{5,}_\d+/.test(code));
  check('不碰 katex 与 @font-face', !/katex/i.test(code) && !/@font-face/.test(code));
  check('负对照：哈希判据对真实哈希类名有牙', /_[A-Za-z0-9]+_[a-z0-9]{5,}_\d+/.test('_wordmark_u7vgf_31'));
  check('属性白名单就是三项', JSON.stringify(COMPONENT_FONT_PROPS) === JSON.stringify(['font-size', 'font-weight', 'font-family']));
  check('首期白名单 3–8 个模块（避免一次放开过宽）',
    COMPONENT_FONT_TARGETS.length >= 3 && COMPONENT_FONT_TARGETS.length <= 8, String(COMPONENT_FONT_TARGETS.length));
  check('每个白名单项都有 label/group/probe',
    COMPONENT_FONT_TARGETS.every((t) => t.label && t.group && t.probe));
}

// ── ⑥ G3：官方 `--dsl-*` 组件钩子 ───────────────────────────────────────────
section('⑥ G3 官方钩子（--dsl-*，必须写进组件作用域）');
{
  const HOOKS = mod.DSL_FONT_HOOKS.map((h) => h.name);
  check('钩子白名单就是官方那三个（不多不少）',
    JSON.stringify(HOOKS.sort()) === JSON.stringify([
      '--dsl-code-block-banner-font', '--dsl-code-block-content-font', '--dsl-terminal-font'].sort()),
    HOOKS.join(' '));
  // 防漂移主线：route=hooks 的组件声明的钩子必须全在官方白名单里
  const declared = COMPONENT_FONT_TARGETS.flatMap((t) => t.dslHooks || []);
  check('所有声明的钩子都在官方白名单内（防漂移）', declared.every((h) => HOOKS.includes(h)), declared.join(' '));
  check('每个组件都标了 route（tokens/hooks/props）',
    COMPONENT_FONT_TARGETS.every((t) => ['tokens', 'hooks', 'props'].includes(t.route)));
  check('route=hooks 的组件必须声明至少一个钩子',
    COMPONENT_FONT_TARGETS.filter((t) => t.route === 'hooks').every((t) => (t.dslHooks || []).length > 0));

  const css = mod.buildDslBlocks({ codeBlock: { size: 14, family: '"KaiTi"' } }, ['codeBlock', 'terminal'], () => true);
  check('写进组件作用域（而不是 body 全局）',
    css.includes('[class*="_codeBlock_"]') && !/^body\s*\{/m.test(css), css.split('\n')[0]);
  check('用官方钩子名，且组合式取自 DSH 细粒度令牌',
    css.includes('--dsl-code-block-content-font:') && css.includes('var(--dsw-font-markdown-code-block-font-weight)')
    && css.includes('var(--dsw-font-markdown-code-block-line-height)'), css.split('\n')[1]);
  check('只动用户改的两项（字号/字族），字重与行高沿用 DSH 令牌',
    css.includes('14px') && css.includes('"KaiTi"') && !css.includes('font-weight:'));
  check('零 !important（等特异性即可 —— 简写在组件根作用域上）', !/!\s*important/.test(css));
  check('未命中的组件不生成（自探测降级）',
    mod.buildDslBlocks({ terminal: { size: 13 } }, ['codeBlock'], () => true) === '');
  check('空配置不生成（官方值作初始值）', mod.buildDslBlocks({}, ['codeBlock'], () => true) === '');
  check('四令牌缺一 ⇒ 跳过该钩子（与 F2 同一规则）',
    mod.buildDslBlocks({ codeBlock: { size: 14 } }, ['codeBlock'],
      (t) => t !== '--dsw-font-markdown-code-block-line-height') === '');
  check('负对照：四令牌齐全时必须生成',
    mod.buildDslBlocks({ codeBlock: { size: 14 } }, ['codeBlock'], () => true).includes('--dsl-code-block-content-font'));
  check('负对照：钩子名判据能抓到拼错的钩子（防手滑）',
    !HOOKS.includes('--dsl-codeblock-content-font'));
}

// ── ⑦ 设置侧一致性（跨文件，机械核对） ──────────────────────────────────────
section('⑦ schema 白名单与模块一致');
{
  const schema = await import(new URL('../lib/settings-schema.js', import.meta.url).href);
  const modPrefixes = COMPONENT_FONT_TARGETS.map((t) => t.prefix);
  check('组件前缀白名单两份一致（宿主只 import schema，浏览器只带模块）',
    JSON.stringify(modPrefixes) === JSON.stringify(schema.COMPONENT_FONT_PREFIXES),
    'module=' + modPrefixes.join(',') + ' schema=' + schema.COMPONENT_FONT_PREFIXES.join(','));
  check('负对照：多塞一个前缀会被判出',
    JSON.stringify([...modPrefixes, 'ghost']) !== JSON.stringify(schema.COMPONENT_FONT_PREFIXES));
  // 值必须能安全进 CSS：字族消毒（防设置文件里的字符串变成任意 CSS）
  const dirty = schema.sanitizeFromSchema(
    { componentFonts: { markdown: { size: 15, weight: 600, family: 'KaiTi; } body { display:none' } } }, 'client');
  check('字族消毒：分号/花括号被剔除',
    !/[;{}]/.test(dirty.componentFonts.markdown.family), JSON.stringify(dirty.componentFonts.markdown.family));
  const bad = schema.sanitizeFromSchema(
    { componentFonts: { markdown: { size: 999, weight: 42 }, nope: { size: 12 } } }, 'client');
  check('越界值与未知组件被丢弃', JSON.stringify(bad.componentFonts) === '{}', JSON.stringify(bad.componentFonts));
  check('宿主侧也有该键（白名单自动派生）', 'componentFonts' in schema.sanitizeFromSchema({}, 'host'));
}

console.log('');
if (failed) { console.log(`COMPONENT FONT CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL COMPONENT FONT CHECKS PASSED');
