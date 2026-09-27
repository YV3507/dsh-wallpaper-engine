/**
 * verify-api-client.mjs — 宿主 API 客户端（P2-9）的守卫。
 *
 * 两件事：
 *   ① **棘轮**：`src/client.js` 里的裸 `fetch(` 只许减少。P2-9 的终态是零裸 fetch
 *      （全部走 src/api-client.js），但 25 处调用点分批改写 —— 于是先用棘轮把"只许减少"
 *      钉住（与 P0-4 的"反向探针防蔓延"同手法）：**新代码必须走本模块**。
 *   ② **行为**：用注入的假 fetch 测本模块自己的契约（前缀、no-store、HEAD/DELETE 不解析、
 *      非 2xx 不改判、网络中断不抛、JSON 解析失败不吞 ok、POST 序列化）。
 *      每条带负对照。
 *
 * Usage:  node scripts/verify-api-client.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = await import(new URL('../src/api-client.js', import.meta.url).href);
const { BASE, apiUrl, apiFetch, apiJson, apiHead, apiPostJson, apiDelete } = api;

/**
 * 裸 fetch 的**棘轮基线**：只许减少。
 * 改写一处调用点后把这个数字改小（守卫会告诉你当前实际值）。
 * 终态 0 —— 届时本常量归零，断言变成"业务代码零裸 fetch"。
 */
const CLIENT_FETCH_BASELINE = 26;   // 实测基线（P2-9 调用点改写尚未开始，只许减少）

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++; }
};
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// ── ① 棘轮 ──────────────────────────────────────────────────────────────────
console.log('\n① 裸 fetch 棘轮（业务代码只许减少）');
{
  const count = (rel) => (strip(readFileSync(join(root, rel), 'utf8')).match(/\bfetch\s*\(/g) || []).length;
  const client = count('src/client.js');
  check(`src/client.js 裸 fetch ≤ 基线 ${CLIENT_FETCH_BASELINE}`, client <= CLIENT_FETCH_BASELINE,
    `当前 ${client}`);
  for (const rel of ['src/effects.js', 'src/font/color-roles.js', 'src/font/typography.js', 'src/we-cond.js']) {
    check(`${rel} 零裸 fetch`, count(rel) === 0, `当前 ${count(rel)}`);
  }
  check('src/api-client.js 存在且是出入囗模块',
    readFileSync(join(root, 'src/api-client.js'), 'utf8').includes('async function apiFetch'));
  // 负对照：判据对合成文本必须有牙
  check('负对照：棘轮判据能数出合成文本里的裸 fetch',
    (strip("const r = await fetch('/x'); // fetch( in comment").match(/\bfetch\s*\(/g) || []).length === 1);
}

// ── ② 前缀与默认值 ──────────────────────────────────────────────────────────
console.log('\n② URL 前缀 / 默认值');
{
  check('相对路径补前缀', apiUrl('/settings') === BASE + '/settings');
  check('不带斜杠也补', apiUrl('settings') === BASE + '/settings');
  check('已带前缀不重复补', apiUrl(BASE + '/settings') === BASE + '/settings');
  check('绝对 URL 原样返回', apiUrl('https://x/y') === 'https://x/y');
  check('空值不炸', apiUrl(null) === BASE + '/' && apiUrl(undefined) === BASE + '/');

  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '{"a":1}' }; };
  await apiJson('/stats', { fetch: fake });
  check('默认 no-store', calls[0].init.cache === 'no-store', JSON.stringify(calls[0].init.cache));
  check('默认 GET', calls[0].init.method === 'GET');
  check('路径经前缀', calls[0].url === BASE + '/stats');
  check('负对照：显式覆盖 cache 时必须尊重', await apiFetch('/x', { fetch: fake, cache: 'force-cache' })
    .then(() => calls[calls.length - 1].init.cache === 'force-cache'));
}

// ── ③ 语义：不吞错、不误判 ──────────────────────────────────────────────────
console.log('\n③ 语义（非 2xx / 网络中断 / 解析失败）');
{
  const mk = (status, text) => async () => ({ status, text: async () => text });
  const okRes = await apiJson('/a', { fetch: mk(200, '{"v":1}') });
  check('2xx + JSON ⇒ ok 且解析出 data', okRes.ok === true && okRes.data.v === 1);
  const notFound = await apiJson('/a', { fetch: mk(404, '') });
  check('404 ⇒ ok=false 且 status 保留（由调用点决定语义）',
    notFound.ok === false && notFound.status === 404);
  const boom = await apiJson('/a', { fetch: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } });
  check('网络/中断 ⇒ 不抛，error 记下名字（调用点可区分 AbortError）',
    boom.ok === false && boom.status === 0 && boom.error === 'AbortError');
  const badJson = await apiJson('/a', { fetch: mk(200, 'not-json') });
  check('JSON 解析失败 ⇒ 仍是 ok（成功但无体/非 JSON），只置 error',
    badJson.ok === true && badJson.data === null && String(badJson.error).startsWith('parse:'));
  const headRes = await apiHead('/a', { fetch: mk(200, '{"should":"not parse"}') });
  check('HEAD 不解析体', headRes.data === null);
  const delRes = await apiDelete('/a', { fetch: mk(200, '{"should":"not parse"}') });
  check('DELETE 默认不解析体（很多接口 204/空体）', delRes.data === null && delRes.ok === true);
  check('无 fetch 可用时给出结构化失败而不是抛', (await apiFetch('/a', { fetch: null })).error === 'no-fetch'
    || typeof fetch === 'function');
}

// ── ④ POST：序列化与头 ─────────────────────────────────────────────────────
console.log('\n④ POST 序列化');
{
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '{}' }; };
  await apiPostJson('/x', { a: 1 }, { fetch: fake });
  check('POST 序列化 JSON 体', calls[0].init.body === '{"a":1}');
  check('POST 带 Content-Type',
    calls[0].init.headers && calls[0].init.headers['Content-Type'] === 'application/json');
  check('method 默认 POST', calls[0].init.method === 'POST');
  await apiPostJson('/x', undefined, { fetch: fake });
  check('空体 ⇒ 空对象而不是 undefined', calls[calls.length - 1].init.body === '{}');
  check('负对照：body 不是字符串化的东西（防"忘了序列化"回归）',
    calls[0].init.body !== '[object Object]');
}

// ── ⑤ 源码不变量 ────────────────────────────────────────────────────────────
console.log('\n⑤ 源码不变量');
{
  const code = strip(readFileSync(join(root, 'src/api-client.js'), 'utf8'));
  check('模块内零 !important', !/!\s*important/.test(code));
  check('模块不读 selection / DOM（纯网络出入口）', !/\bselection\b/.test(code) && !/querySelector/.test(code));
  check('不硬编码宿主地址（只走相对前缀）',
    !/https?:\/\/[a-z0-9]/i.test(code) && !/localhost|127\.0\.0\.1/i.test(code));
}

console.log('');
if (failed) { console.log(`API CLIENT CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL API CLIENT CHECKS PASSED');
