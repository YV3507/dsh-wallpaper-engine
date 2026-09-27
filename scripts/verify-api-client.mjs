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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = await import(new URL('../src/api-client.js', import.meta.url).href);
const { BASE, apiUrl, apiFetch, apiJson, apiHead, apiPostJson, apiDelete } = api;

/**
 * 裸 fetch 的**棘轮基线**：只许减少。
 * 改写一处调用点后把这个数字改小（守卫会告诉你当前实际值）。
 * 终态 0 —— 届时本常量归零，断言变成"业务代码零裸 fetch"。
 *
 * 进度：26 → 20 → 16 → **13**（第一批：帧缓存 / 帧探测 6 处 —— `probeGpuFramePin`、
 * `clearGpuFrameSlot`、live 回填的 HEAD 与 PUT、`probeGpuFrameState`、面板「清除 GPU 帧」；
 * 第二批：轮询 / 上报 4 处 —— `audio-spectrum`、`now-playing`、`client-diag`、`transcode-progress`；
 * 第三批：设置 / 库存 3 处 —— 设置 GET/PUT、库存 GET）。
 */
const CLIENT_FETCH_BASELINE = 8;   // 只许减少；每批改写后同步下调
/**
 * 抽出来的客户端模块各自的裸 fetch 基线（只许减少）。**覆盖面必须跟着代码走**：
 * 把带裸 fetch 的代码搬进新模块时，若判据只盯 client.js，棘轮就会因为"搬走"而变绿。
 */
const MODULE_FETCH_BASELINE = {
  'src/live-layer.js': 2,   // 转码 Range 探测 / live 帧探测之外的遗留调用点
  'src/media-prep.js': 1,
  'src/transcode.js': 2,    // 转码 Range 探测 + 首帧探测（P2-9 剩余）
};
/** 客户端裸 fetch **总计**只许减少 —— 搬动代码改不了总计，这条骗不过。 */
const TOTAL_FETCH_BASELINE = 13;

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
  // ⚠️ **覆盖面必须跟着代码走**：把带裸 fetch 的代码搬进新模块，如果判据只盯 client.js，
  //    棘轮就会"因为搬走而变绿"（把裸 fetch 藏起来）。所以：每个客户端模块各有基线，
  //    并且额外断言**总计**只许减少 —— 搬动改不了总计，这条骗不过。
  let total = client;
  for (const [rel, base] of Object.entries(MODULE_FETCH_BASELINE)) {
    const n = count(rel);
    total += n;
    check(`${rel} 裸 fetch ≤ 基线 ${base}`, n <= base, `当前 ${n}`);
  }
  check(`客户端裸 fetch 总计 ≤ 基线 ${TOTAL_FETCH_BASELINE}（搬动骗不过这条）`,
    total <= TOTAL_FETCH_BASELINE, `当前 ${total}`);
  for (const rel of ['src/api-client.js', 'src/effects.js', 'src/font/apply.js',
    'src/font/color-roles.js', 'src/font/typography.js', 'src/we-cond.js', 'src/styles.js']) {
    check(`${rel} 零裸 fetch`, count(rel) === 0, `当前 ${count(rel)}`);
  }
  check('src/api-client.js 存在且是出入囗模块',
    readFileSync(join(root, 'src/api-client.js'), 'utf8').includes('async function apiFetch'));
  // 负对照：判据对合成文本必须有牙
  check('负对照：棘轮判据能数出合成文本里的裸 fetch',
    (strip("const r = await fetch('/x'); // fetch( in comment").match(/\bfetch\s*\(/g) || []).length === 1);
  check('负对照：总计判据对"搬进新模块"的裸 fetch 有牙',
    count('src/live-layer.js') > 0 && MODULE_FETCH_BASELINE['src/live-layer.js'] >= count('src/live-layer.js'));
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

// ── ⑥ 出入口必须真的在产物里（"孤儿模块"防线，P2-9 的教训）──────────────────
// `src/api-client.js` 一度是**孤儿**：文件在、守卫在逐条测它，但它既不在 `INLINE_MODULES`
// 里、也没有被任何文件 import ⇒ **从不进 bundle**。那时调用点一改用它就会 ReferenceError，
// 而没有任何守卫会红 —— 浏览器半的模块只有登记进构建清单才存在。
console.log('\n⑥ 出入口已登记进构建清单、并真的进了产物');
{
  const build = readFileSync(join(root, 'scripts/build-client.mjs'), 'utf8');
  const bundle = readFileSync(join(root, 'lib/client.js'), 'utf8');
  check('INLINE_MODULES 登记了 src/api-client.js',
    /file:\s*'src\/api-client\.js'/.test(build));
  check('产物里确有 apiFetch 实现（已内联，不是只登记）',
    bundle.includes('async function apiFetch('));
  check('产物里只有**一份**实现（防"正文自带一份旧的"两处漂移）',
    (bundle.match(/async function apiFetch\(/g) || []).length === 1);
  check('负对照：登记判据对未登记的模块名有牙',
    !/file:\s*'src\/not-registered\.js'/.test(build));
}

// ── ⑦ Response 替身必须给出 `status`（`ok` 的唯一来源）──────────────────────
// 教训（P2-9 第一次改写**回退的真因**）：`api-client` 的 `ok` 由 `response.status` 推出；
// 替身若只写 `{ ok: true, json }`（没有 status），status 被读成 0 ⇒ **一律判失败**。
// 症状却是"清单加载失败 → picker 按钮不渲染"，与网络层完全看不出关系，上次为此回退了一整批改写。
// 所以把"替身形态"钉在这里：**同时带 `ok:` 与 `json:` 的替身对象必须带 `status:`**。
console.log('\n⑦ Response 替身必须带 status');
{
  const walk = (dir, out = []) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return out; }
    for (const n of names) {
      const abs = join(dir, n);
      let st = null;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, out);
      else if (st.isFile() && /\.mjs$/.test(n)) out.push(relative(root, abs).split('\\').join('/'));
    }
    return out;
  };
  const stubFiles = [...walk(join(root, 'scripts')), ...walk(join(root, 'test'))];
  const offenders = [];
  for (const rel of stubFiles) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '{') continue;
      // 只认"像替身对象"的花括号：紧跟 Promise.resolve( / => ( / return
      const head = text.slice(Math.max(0, i - 16), i);
      if (!/(Promise\.resolve\(|=>\s*\(|return\s*)$/.test(head)) continue;
      let depth = 0; let j = i;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (!depth) break; }
      }
      const block = text.slice(i, j + 1);
      if (/\bok\s*:/.test(block) && /\bjson\s*:/.test(block) && !/\bstatus\s*:/.test(block)) {
        offenders.push(rel + ':' + (text.slice(0, i).split('\n').length));
      }
    }
  }
  check('所有 Response 替身都带 status（ok 只能由 status 推出）', offenders.length === 0,
    offenders.length ? offenders.join(', ') : stubFiles.length + ' 个 mjs 文件干净');
  // **覆盖面断言**：上面那句"都带 status"在扫不到文件时也会绿（本仓踩过：walk 里少导入
  // readdirSync，异常被吞 ⇒ 0 个文件、假绿）。所以先钉住"真的扫到了文件"。
  check('负对照：扫描确实覆盖到文件（>20 个 mjs，防 walker 静默返回空表）',
    stubFiles.length > 20, stubFiles.length + ' 个');
  const mk = (o, j, s) => `${o ? '{ ok: true, ' : '{ '}${j ? 'json: () => x, ' : ''}${s ? 'status: 200, ' : ''}}`;
  check('负对照：判据对"缺 status 的替身"有牙、对合规替身放行',
    /\bok\s*:/.test(mk(true, true, false)) && !/\bstatus\s*:/.test(mk(true, true, false))
    && /\bstatus\s*:/.test(mk(true, true, true)));
}

console.log('');
if (failed) { console.log(`API CLIENT CHECKS FAILED — ${failed} failed`); process.exit(1); }
console.log('ALL API CLIENT CHECKS PASSED');
