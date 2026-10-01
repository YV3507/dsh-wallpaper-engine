#!/usr/bin/env node
/**
 * verify-version-sync.mjs — **版本号四处同步**的守卫。
 *
 * 发版时版本号写在四个地方，缺一处都不报错、只是"悄悄说谎"：
 *   ① `package.json` 的 `version`                        —— 真源（npm 发布物用它）
 *   ② `docs/CHANGELOG.md` 头部的「当前发布版本」        —— 明说"与 package.json 一致"
 *   ③ `docs/UPGRADING.md` 的「当前版本」               —— 用户升级前读的那份
 *   ④ `src/client.js` 的 `NOTICE_VERSION`               —— 插件里那屏一次性更新说明的触发键
 *
 * 判据（每条都配负对照）：
 *   V1 `version` 是 semver；CHANGELOG 里有对应的 `### vX` 小节。
 *   V2 CHANGELOG 头部那句「当前发布版本：`vX`」== package.json 的版本。
 *   V3 UPGRADING 的「当前版本 X」== package.json 的版本。
 *   V4 `NOTICE_VERSION` 是 semver、**不高于** package 版本，且**它对应的 CHANGELOG 小节存在**
 *      —— 允许"小补丁不复播"（NOTICE 停在上一版是合法的），但**不许**复播一个没发布过的版本
 *      （那屏文案会对着一个不存在的版本说话）。
 *
 * Usage:  node test/verify-version-sync.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const SEMVER = /^\d+\.\d+\.\d+$/;
/** 版本比较：只认 `X.Y.Z`（本仓口径）。负数 = a < b。 */
const cmp = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

// ── 解析器（每条都能被负对照喂合成输入）──────────────────────────────────────
const versionOfPkg = (json) => {
  try { return JSON.parse(json).version || ''; } catch { return ''; }
};
const changelogHeaderVersion = (md) => (String(md).match(/\*\*当前发布版本：`v([^`]+)`\*\*/) || [])[1] || '';
const changelogSections = (md) => [...String(md).matchAll(/^### v([0-9]+\.[0-9]+\.[0-9]+)/gm)].map((m) => m[1]);
const upgradingVersion = (md) => (String(md).match(/\*\*当前版本 ([0-9]+\.[0-9]+\.[0-9]+)\*\*/) || [])[1] || '';
const noticeVersion = (js) => (String(js).match(/const NOTICE_VERSION = "([^"]+)"/) || [])[1] || '';

// ── 真值 ────────────────────────────────────────────────────────────────────
const pkgRaw = read('package.json');
const changelog = read('docs/CHANGELOG.md');
const upgrading = read('docs/UPGRADING.md');
const clientSrc = read('src/client.js');

const version = versionOfPkg(pkgRaw);
const header = changelogHeaderVersion(changelog);
const sections = changelogSections(changelog);
const upVersion = upgradingVersion(upgrading);
const notice = noticeVersion(clientSrc);

console.log('① 解析（非空转）');
check('package.json 能解析出版本号', SEMVER.test(version), version);
check('CHANGELOG 头部能解析出「当前发布版本」', Boolean(header), header || '(未命中)');
check('CHANGELOG 能列出各版本小节', sections.length >= 10, sections.length + ' 节');
check('UPGRADING 能解析出「当前版本」', SEMVER.test(upVersion), upVersion || '(未命中)');
check('client.js 能解析出 NOTICE_VERSION', SEMVER.test(notice), notice || '(未命中)');

console.log('\n② 四处一致');
check('CHANGELOG 里有当前版本的小节 `### v' + version + '`', sections.includes(version),
  '有：' + sections.slice(0, 4).join(' / '));
check('CHANGELOG 头部「当前发布版本」== package.json 的 version', header === version, header + ' vs ' + version);
check('UPGRADING「当前版本」== package.json 的 version', upVersion === version, upVersion + ' vs ' + version);
check('NOTICE_VERSION 不高于 package 版本（写在那个版本之后的说不通）', cmp(notice, version) <= 0,
  notice + ' <= ' + version);
check('NOTICE_VERSION 对应的 CHANGELOG 小节存在（复播的必须是个真发布过的版本）', sections.includes(notice),
  notice + (sections.includes(notice) ? '' : '（CHANGELOG 里没有这一版）'));

console.log('\n③ 负对照（判据对改坏的四份输入都必须判红）');
check('负对照：header 与 version 不同会被判出',
  changelogHeaderVersion('**当前发布版本：`v9.9.9`**') !== version);
check('负对照：UPGRADING 写别的版本会被判出', upgradingVersion('**当前版本 0.0.1**') !== version);
check('负对照：NOTICE_VERSION 指向没发布过的版本会被判出',
  !sections.includes(noticeVersion('const NOTICE_VERSION = "9.9.9";')));
check('负对照：NOTICE_VERSION 高于 package 版本会被判出',
  cmp(noticeVersion('const NOTICE_VERSION = "99.0.0";'), version) > 0);
check('负对照：小节解析器对"看起来像版本但不是"的标题不误判',
  !changelogSections('### v1.1（少一段）\n### vNext\n### v2.1.0').includes('1.1')
    && changelogSections('### v1.1（少一段）\n### vNext\n### v2.1.0').includes('2.1.0'));
check('negative control: 解析器对空输入返回空（不是恒真）',
  versionOfPkg('{}') === '' && changelogHeaderVersion('') === '' && upgradingVersion('') === ''
    && noticeVersion('') === '');

console.log('\n' + (failed === 0 ? 'VERSION SYNC CHECKS PASSED' : 'VERSION SYNC CHECKS FAILED') + ` (${passed})`);
process.exit(failed === 0 ? 0 : 1);
