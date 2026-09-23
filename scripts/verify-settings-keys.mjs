#!/usr/bin/env node
/**
 * 设置字段三份清单的漂移护栏 (settings key drift guard)
 *
 * 背景：持久化设置被**三份手工维护的清单**描述，任何一份漏字段都会导致**静默丢设置**：
 *   ① 客户端 `serializeSelection()`（src/client.js）—— 真正 PUT 上去的键；
 *   ② 宿主 `sanitizeSettings()`（lib/index.js）—— 白名单，**不在里面的键在 PUT 时被丢弃**
 *      （PUT 用 sanitize 结果整个覆盖 config.json）；
 *   ③ 客户端 `sanitizeSettings()`（src/client.js）—— 从宿主读回时再过滤一遍。
 * 已经发生过两次同类事故：`sceneLiveFailures`（0.7.x，代码注释里留了教训）与
 * `frameVariants` / `customFrames`（0.7.5 用户反馈：**画面档位永远存不住**）。
 * 这类 bug 靠人工对清单很难发现、用户侧也完全看不出原因，故机械断死。
 *
 * 断言：`serializeSelection()` 的每个键都必须同时存在于 ② 与 ③。
 * 负对照：把宿主白名单里删掉一个键，必须被判红（证明断言不是恒真）。
 *
 * 注意：解析的是**源码**（src/client.js）而不是构建产物 —— 产物是 bundle，缩进假设不成立，
 * 第一版就在这里把无关的 `title/value/disabled` 当成了设置键（假失败）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
let failed = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS | ' + name + (detail ? ' | ' + detail : ''));
  else { console.log('FAIL | ' + name + (detail ? ' | ' + detail : '')); failed++; }
}

/** 取 `return { ... };` 的字面量文本（缩进 4 格的键）。 */
function returnLiteral(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const body = src.slice(i);
  const s = body.indexOf('return {');
  if (s < 0) return '';
  const e = body.indexOf('\n  };', s);
  return body.slice(s, e < 0 ? body.length : e);
}
/** 白名单键：`key:` 与 ES6 简写 `key,` 两种写法都要认（宿主用了 `rotationGroups,`）。 */
const keyRe = /^ {4}([A-Za-z_$][\w$]*)\s*[:,]/gm;
function whitelistKeys(src, sig) {
  return [...returnLiteral(src, sig).matchAll(keyRe)].map((m) => m[1]);
}
function clientSentKeys(src) {
  return [...returnLiteral(src, 'function serializeSelection()').matchAll(/^ {4}([A-Za-z_$][\w$]*):\s*selection\./gm)]
    .map((m) => m[1]);
}

const cli = read('src/client.js');
const idx = read('lib/index.js');
const sent = clientSentKeys(cli);
const host = new Set(whitelistKeys(idx, 'function sanitizeSettings(raw)'));
const clientBack = new Set(whitelistKeys(cli, 'function sanitizeSettings(o)'));

const missingHost = sent.filter((k) => !host.has(k));
const missingBack = sent.filter((k) => !clientBack.has(k));

// ── S1 往返测试（**真函数**，不是文本比对）──────────────────────────────────
// 客户端 PUT 的每个键，都必须能从宿主 sanitizeSettings 的输出里取到。
// 负对照：同一个判定喂一个**白名单里不存在**的键（bogusKey / 已退役的 sceneFramePrewarm），
// 必须报缺失 —— 否则"全都通过"可能只是因为断言恒真。
const { sanitizeSettings } = await import('../lib/index.js');
const outEmpty = sanitizeSettings({});
const roundTripMissing = sent.filter((k) => !(k in outEmpty));
const bogus = ['bogusKey', 'sceneFramePrewarm'];
const bogusCaught = bogus.filter((k) => !(k in outEmpty));

check('S1 往返：客户端 PUT 的每个键都能从宿主 sanitizeSettings 的输出里取到',
  sent.length >= 20 && roundTripMissing.length === 0
  && bogusCaught.length === bogus.length && bogus.every((k) => !sent.includes(k)),
  `serializeSelection ${sent.length} 键 · 输出 ${Object.keys(outEmpty).length} 键` +
  `${roundTripMissing.length ? ' · 取不到: ' + roundTripMissing.join(', ') : ''}` +
  ` · 负对照 白名单外的键被判缺 ${bogusCaught.length}/${bogus.length}`);

// ── S1b 两个按壁纸映射的白名单行为（0.7.5 反馈里的 Bug 1 正是它们漏了）──────────
const rt = sanitizeSettings({ frameVariants: { '3669681034': 4 }, customFrames: { '3669681034': true } });
const rtOk = rt.frameVariants['3669681034'] === 4 && rt.customFrames['3669681034'] === true;
const dirty = sanitizeSettings({
  frameVariants: { '3669681034': 5, up_1: -1, 'up-dir-x': 2, 'bad/key': 3, 'ok-1': 0, 'ok-2': 3 },
  customFrames: { 'ok-1': 'yes', 'ok-2': true, 'bad key': true },
});
const dirtyOk =
  // 越界档位（含退役的 5）与非法键名一律丢弃
  !('3669681034' in dirty.frameVariants) && !('up_1' in dirty.frameVariants)
  && !('bad/key' in dirty.frameVariants)
  // 合法项保留（0 与 3 都合法）
  && dirty.frameVariants['ok-1'] === 0 && dirty.frameVariants['ok-2'] === 3
  && dirty.frameVariants['up-dir-x'] === 2
  // customFrames 只认字面 true
  && !('ok-1' in dirty.customFrames) && dirty.customFrames['ok-2'] === true
  && !('bad key' in dirty.customFrames);
const big = sanitizeSettings({
  frameVariants: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['w' + i, 1])),
});
const cappedOk = Object.keys(big.frameVariants).length === 200;

check('S1b 出图来源档位 / 自定义画面：合法值原样往返，越界档位·非法键·非 true 一律丢弃，条数有上限',
  rtOk && dirtyOk && cappedOk,
  `往返 ${rtOk ? 'ok' : 'FAIL'} · 脏数据 ${dirtyOk ? 'ok' : 'FAIL'}` +
  ` · 条数上限 ${Object.keys(big.frameVariants).length}/200`);

// 负对照：删掉宿主白名单里一个真实存在的键，必须**新增恰好一个**缺失键。
// ⚠️ 必须减去基线缺失集：直接用"缺失总数"会把它与真实漏字段混在一起（第一版就在这里
// 报出 "抓到 3/1" —— 3 = 注入的 id + 真实漏掉的 frameVariants/customFrames）。
const victim = sent.find((k) => host.has(k));
const mutated = victim ? idx.replace(new RegExp('^ {4}' + victim + '\\s*[:,]', 'm'), '') : idx;
const hostMut = new Set(whitelistKeys(mutated, 'function sanitizeSettings(raw)'));
const caughtNew = victim ? sent.filter((k) => !hostMut.has(k) && !missingHost.includes(k)) : [];

check('S2 文本清单一致：客户端 PUT 的键都在宿主白名单里，且都在客户端读回白名单里',
  sent.length >= 20 && host.size >= 20 && clientBack.size >= 20
  && missingHost.length === 0 && missingBack.length === 0
  && victim !== undefined && caughtNew.length === 1 && caughtNew[0] === victim,
  `宿主白名单 ${host.size} 键 / 客户端读回 ${clientBack.size} 键` +
  `${missingHost.length ? ' · 宿主缺: ' + missingHost.join(', ') : ''}` +
  `${missingBack.length ? ' · 读回缺: ' + missingBack.join(', ') : ''}` +
  ` · 负对照 删掉 "${victim}" 后新增缺失 ${caughtNew.length}/1`);

// ── S3 反向漂移：客户端**读得到**却**从不发送**的键 = 保证"改了存不住"──────
// 判定规则：宿主白名单 ∩ 客户端读回白名单 − 客户端发送 = 必须为空。
// 理由：一个键若两端都认、只有"写"这一份漏了，用户改了它下次加载必然回默认值 ——
// 这不是"宿主比客户端支持得多"的正常差异，而是 bug。
// 本地实测抓到 4 个：sceneLossyRoute / sceneGpuAccel / scenePrewarm / scenePrewarmScope
// （空闲预热因此在宿主侧永远读不到 true ⇒ 整条预热链从 UI 不可达）。
const readButNeverSent = [...clientBack].filter((k) => host.has(k) && !sent.includes(k));
// 负对照：从客户端**发送清单**里删掉一个键，S3 必须报出来（证明断言不是恒真）。
// ⚠️ 模式必须锚定 `selection.xxx` 这一形式：同名的行在客户端读回清单里也有一份
// （`scenePrewarm: o.scenePrewarm === true`），非全局 replace 只会换掉**第一处** ——
// 第一版就替换错了位置，于是负对照恒不触发（"抓到 0/1"），而正例仍然是绿的。
const sentMutant = clientSentKeys(cli.replace(/^ {4}scenePrewarm: selection\.scenePrewarm,$/m, ''));
const caughtReverse = [...clientBack].filter((k) => host.has(k) && !sentMutant.includes(k));
check('S3 反向漂移：两端都认的键，客户端必须发送（否则改了存不住）',
  readButNeverSent.length === 0
  && sentMutant.length === sent.length - 1 && caughtReverse.includes('scenePrewarm'),
  (readButNeverSent.length ? '读得到但从不发送: ' + readButNeverSent.join(', ') : '无') +
  ` · 负对照 注入后发送清单 ${sentMutant.length}/${sent.length}、抓到 ` +
  `${caughtReverse.includes('scenePrewarm') ? 1 : 0}/1`);

// S4：只在宿主白名单里、客户端连读都不读的键 —— 仅报告（宿主可能兼容旧前端）。
const hostOnly = [...host].filter((k) => !clientBack.has(k) && !sent.includes(k));
console.log('INFO | S4 只在宿主白名单里的键（仅报告）: ' + (hostOnly.length ? hostOnly.join(', ') : '无'));

console.log(failed === 0 ? '\nverify-settings-keys: OK' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
