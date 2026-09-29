#!/usr/bin/env node
/**
 * verify-logging.mjs —— 日志分级的**结构判据**：收口、预算、成功路径与热路径。
 *
 * 这一族规则回答的不是"文案对不对"，而是四个**结构性**问题 —— 它们全都能用文本判据钉住，
 * 所以不该只靠评审：
 *   N1 **单一收口**：`lib/**` 里除 `lib/log.js` 与 `lib/notice.js` 外零 `console.*`。
 *      没有这条，"默认终端只出问题"就退化成几十处各自为政的打印。
 *   N2 **提示预算**：`notice(` 的调用点必须落在编译期白名单里，且总量不超过预算。
 *      没有这条，成功提示会退化成第二份日志（"极其少量"就只是一句愿望）。
 *   N3 **源码级不重复**：每个 `kind` 在调用点里恰好出现一次（会话内幂等另由运行时 Set 保证）。
 *   N4 **成功不发日志**：`lib/notice.js` 的日志出口只有失败路径那一条 `warn`。
 *   N5 **热路径零提示**：逐请求 / 逐帧的代码段里不许出现 `notice(` —— 提示只许在里程碑位置。
 *   N6 **两侧档位名同集合**：宿主与客户端各自声明三个档位名，集合必须一致（两侧不共享内核，
 *      所以"一致"这件事本身需要判据）。
 *   N7 **渲染页明文级别与宿主模式表同源**：本地补丁把 `FAIL_REPORT_RE` 打进 vendored 渲染页，
 *      让它自己按同一张表给 `/diag` 带 `&lvl=`（补丁在位 / 逐字相同 / 真随 URL 上行，三件都要）。
 *
 * N1–N6 是**静态**判据（代码长什么样）；R1–R4 是**运行期**判据（真的跑一遍两个宿主模块）——
 * 闸门三态、幂等与"投递失败才 warn"这三件事在源码上看不出来，只能跑：
 *   R1 `DSH_WE_LOG_LEVEL` 三值真的决定终端镜像哪些档位（默认 `warn`；非法值按默认）。
 *   R2 一个 kind 每会话**至多一条**提示（同一实例内重复调用不再投递）。
 *   R3 `DSH_WE_NOTICE` 三态：`0` 静默不报、`1` 强制输出、未设且非 TTY 静默不报。
 *   R4 投递失败**恰好一条** `warn`（同步抛错与回调 err 两条失败路径）。
 *   R5 宿主侧分流：`/diag` 按失败模式表分档、`&lvl=` 三档优先、`/client-diag` 的
 *      `live-ready`+`scene` 进提示通道，且三条早退与落盘契约不变。
 *
 * 出口形态与其余守卫一致：每条判据都配**可失败对照**（合成输入上必须判红），否则一条
 * 恒真断言看起来和一条真判据没有区别。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 剥注释：共享的字符串感知实现（test/tools/js-text.mjs）。
import { stripComments } from './tools/js-text.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
}

const read = (rel) => readFileSync(ROOT + rel, 'utf8');
/** 判据只针对**代码**：剥注释走共享实现（test/tools/js-text.mjs），
 *  否则散文里举例的 `console.log` 会把守卫自己判红。 */

/** 两个允许直接写终端的宿主模块（`lib/log.js` 的终端镜像 + `lib/notice.js` 的提示行）。 */
const SINKS = ['lib/log.js', 'lib/notice.js'];
/** 不在这条判据扫描面里的东西及其理由（口径写在判据旁，不靠"约定"）。 */
const NOT_OURS = [
  [/^lib\/client\.js$/, '构建产物（源在 src/**，由 build-client 内联生成）'],
  [/^lib\/webwallgl\//, '上游 vendored 渲染页（自带 WebWallGL 的 console logger）'],
  [/^lib\/vendor\//, '第三方副本（jpeg-js）'],
];

function walkLib(dir, out = []) {
  for (const e of readdirSync(ROOT + dir, { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) walkLib(rel, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const LIB_FILES = walkLib('lib').sort();
/** N1 的扫描面：全量 `lib/**.{js,mjs}` 减去两个 sink 与三类非自研文件。 */
const N1_FILES = LIB_FILES.filter((f) => !SINKS.includes(f) && !NOT_OURS.some(([rx]) => rx.test(f)));

// ── 判据（纯函数，主扫描与可失败对照共用同一份）──────────────────────────────
/** `console.xxx(` 与 `console[...]` 两种写法都算（括号写法是最省事的绕开方式）。 */
const CONSOLE_CALL = /(?<![\w$.])console\s*(?:\.\s*[A-Za-z_$][\w$]*|\[)/g;
const consoleCalls = (src) => (stripComments(src).match(CONSOLE_CALL) || []).length;

/** `notice(<字面量>, …)` 的调用点：返回字面量 kind 列表。 */
const NOTICE_CALL = /\bnotice\(\s*(['"])([^'"]+)\1/g;
const noticeLiteralKinds = (src) => [...stripComments(src).matchAll(NOTICE_CALL)].map((m) => m[2]);
const noticeCallCount = (src) => (stripComments(src).match(/\bnotice\s*\(/g) || []).length;

/** 提示预算：**常量的家在这里**（判据就是"提示极其少量"这句话本身）。 */
const NOTICE_BUDGET = 2;
/** 预算判据：白名单不超预算、调用点不超预算、每个调用点都在白名单里、且没有非字面量调用。 */
const noticeBudgetOk = (kinds, calls, nonLiteral = 0) =>
  Array.isArray(kinds) && kinds.length > 0 && kinds.length <= NOTICE_BUDGET
  && calls.length <= NOTICE_BUDGET && nonLiteral === 0
  && calls.every((k) => kinds.includes(k));

/** 提示白名单从 `lib/notice.js` 的 `KINDS` **读出来**，守卫不抄第二份。 */
function noticeKinds(src) {
  const block = (stripComments(src).match(/const KINDS = \[([^\]]*)\]/) || [])[1];
  return block === undefined ? null : [...block.matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2]);
}

/** 按大括号配对取一个函数体（把"热路径"钉成一段真的代码，而不是一句形容）。 */
function functionBody(src, header) {
  const at = src.indexOf(header);
  if (at < 0) return null;
  const open = src.indexOf('{', at + header.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** 三档名在源码里出现的集合（字面量口径；两侧各写一份，N6 只判集合相等）。 */
const LEVEL_NAMES = ['error', 'warn', 'info'];
const levelNamesIn = (src) => LEVEL_NAMES.filter((l) => src.includes("'" + l + "'") || src.includes('"' + l + '"'));

// ── N1 单一收口 ─────────────────────────────────────────────────────────────
{
  const offenders = [];
  for (const f of N1_FILES) {
    const n = consoleCalls(read(f));
    if (n) offenders.push(f + '=' + n);
  }
  check('N1 `lib/**` 里除 log.js / notice.js 外零 console.*（终端只有一个收口）',
    N1_FILES.length >= 12 && offenders.length === 0,
    offenders.length ? '命中：' + offenders.join(' ')
      : N1_FILES.length + ' 个模块干净（扫描面 = lib/**.{js,mjs} 减去 ' + SINKS.length
        + ' 个 sink 与 ' + NOT_OURS.length + ' 类非自研文件）');
  check('N1 negative control: 合成源码里的 console 调用会被判出，注释里的不会',
    consoleCalls("console.log('x')") === 1 && consoleCalls("console['warn']('x')") === 1
    && consoleCalls("x.console.log('x')") === 0
    && consoleCalls('// console.log("x")') === 0 && consoleCalls('/* console.log("x") */') === 0);
}

// ── N2 提示预算（调用点 ⊆ 白名单，且总量不超预算）────────────────────────────
const KINDS = noticeKinds(read('lib/notice.js'));
/** N2/N3 的调用点扫描面 = 我们自己的宿主模块（vendored / 生成的产物不可能调用宿主 `notice`）。 */
const CALLERS = N1_FILES.filter((f) => f !== 'lib/notice.js');
{
  const calls = [];
  let nonLiteral = 0;
  for (const f of CALLERS) {
    const src = read(f);
    nonLiteral += noticeCallCount(src) - noticeLiteralKinds(src).length;
    calls.push(...noticeLiteralKinds(src));
  }
  check('N2 `notice(` 调用点都在编译期白名单里，且总量不超预算（防退化成第二份日志）',
    noticeBudgetOk(KINDS, calls, nonLiteral),
    '白名单=' + JSON.stringify(KINDS) + ' 调用点=' + calls.length + ' 非字面量=' + nonLiteral
      + ' 预算=' + NOTICE_BUDGET);
  check('N2 negative control: 超预算的白名单 / 未登记的 kind / 非字面量调用都会被判出',
    noticeBudgetOk(['a', 'b', 'c'], ['a', 'b', 'c']) === false
    && noticeBudgetOk(['a', 'b'], ['a', 'b', 'z']) === false
    && noticeBudgetOk(['a', 'b'], ['a', 'b'], 1) === false
    && noticeBudgetOk(['a', 'b'], ['a', 'b']) === true);
}

// ── N3 源码级不重复（每个 kind 的调用点恰好一处）──────────────────────────────
{
  const counts = new Map((KINDS || []).map((k) => [k, 0]));
  for (const f of CALLERS) {
    for (const k of noticeLiteralKinds(read(f))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bad = [...counts.entries()].filter(([, n]) => n !== 1);
  check('N3 每个 kind 在调用点里恰好出现一次（会话内幂等由运行时 Set 负责）',
    counts.size > 0 && bad.length === 0,
    bad.length ? '次数不为 1：' + bad.map(([k, n]) => k + '=' + n).join(' ')
      : [...counts].map(([k, n]) => k + '=' + n).join(' '));
  check('N3 negative control: 同一 kind 的第二个调用点会让计数变成 2',
    noticeLiteralKinds("a(); notice('media-origin', 'x'); notice('media-origin', 'y');")
      .filter((k) => k === 'media-origin').length === 2);
}

// ── N4 成功不发日志（lib/notice.js 的日志出口只有失败路径的那一个处理器）──────
const LOG_CALL = /log\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
/**
 * 成功路径不碰日志：文件里**所有** `log.<方法>(` 都必须落在失败处理器
 * （`function reportFailure(kind, err)`）的函数体之内，且只许用 `warn`。
 * 位置在文件里怎么排都不影响判据 —— 判的是"在不在成功路径上"。
 */
function noticeSuccessSilent(src) {
  const s = stripComments(src);
  const body = functionBody(s, 'function reportFailure(kind, err)');
  if (body === null) return false;
  const all = [...s.matchAll(LOG_CALL)];
  return all.length > 0 && all.every((m) => m[1] === 'warn')
    && [...body.matchAll(LOG_CALL)].length === all.length;
}
{
  check('N4 `lib/notice.js` 成功路径不调用日志；唯一的日志出口是失败处理器的 warn',
    noticeSuccessSilent(read('lib/notice.js')),
    '日志调用=' + JSON.stringify([...stripComments(read('lib/notice.js')).matchAll(LOG_CALL)]
      .map((m) => m[1])) + ' 失败处理器=' + (functionBody(stripComments(read('lib/notice.js')), 'function reportFailure(kind, err)') !== null));
  check('N4 negative control: 成功路径上的 warn / info，以及别处的 warn 都会被判出',
    noticeSuccessSilent("process.stdout.write('x'); log.info('ok');\nfunction reportFailure(kind, err) { log.warn('bad'); }") === false
    && noticeSuccessSilent("process.stdout.write('x'); log.warn('ok');\nfunction reportFailure(kind, err) { log.warn('bad'); }") === false
    && noticeSuccessSilent("process.stdout.write('x');\nfunction reportFailure(kind, err) { log.warn('bad'); }") === true);
}

// ── N5 热路径零提示 ─────────────────────────────────────────────────────────
{
  // 逐请求 / 逐帧的代码段（"热路径"在这里是可定位的代码，不是一句形容）：
  //   ① `lib/routes/scene-serve.js` 整个文件（每条语句都在请求路径上）；
  //   ② `src/live-layer.js` 整个文件（客户端半边：成功提示只能经 /client-diag 上行）；
  //   ③ `lib/index.js` 的 handleSceneFiles 函数体（每个壁纸子资源请求都过它）。
  const hot = [
    ['lib/routes/scene-serve.js', read('lib/routes/scene-serve.js')],
    ['src/live-layer.js', read('src/live-layer.js')],
    ['lib/index.js:handleSceneFiles', functionBody(read('lib/index.js'), 'function handleSceneFiles(req, res, mount)')],
  ];
  const missing = hot.filter(([, body]) => body === null).map(([n]) => n);
  const hits = hot.filter(([, body]) => body !== null && noticeCallCount(body) > 0).map(([n]) => n);
  check('N5 热路径（请求段 / 客户端半边 / 壁纸文件处理器）里零 notice(',
    missing.length === 0 && hits.length === 0,
    missing.length ? '定位不到代码段：' + missing.join(' ') : (hits.length ? '命中：' + hits.join(' ') : '三段都干净'));
  check('N5 negative control: 同一个计数与同一段提取器在合成热路径上都会命中',
    noticeCallCount("function h(){ notice('scene-ready', 'x'); }") === 1
    && functionBody("function h(){ notice('scene-ready', 'x'); }", 'function h(') !== null
    && functionBody("function h(){ return 1; }", 'function h(') !== null);
}

// ── N6 两侧档位名同集合 ─────────────────────────────────────────────────────
{
  const host = levelNamesIn(read('lib/log.js'));
  const client = levelNamesIn(read('src/live-layer.js'));
  check('N6 宿主与客户端声明的三个档位名集合相同（两侧不共享内核，靠判据防漂）',
    host.length === LEVEL_NAMES.length && client.length === LEVEL_NAMES.length
    && LEVEL_NAMES.every((l) => host.includes(l) && client.includes(l)),
    'host=[' + host.join(',') + '] client=[' + client.join(',') + ']');
  check('N6 negative control: 少一个档位名的合成文本会被判出',
    levelNamesIn("const X = { 'error': 1, 'warn': 1 };").length !== LEVEL_NAMES.length
    && levelNamesIn("const X = { 'error': 1, 'warn': 1, 'info': 1 };").length === LEVEL_NAMES.length);
}

// ── N7 渲染页的"明文级别"与宿主模式表**同源**（本地补丁的产物侧牙齿）────────────
// `test/tools/sync-webwallgl.mjs` 把 FAIL_REPORT_RE 打进 vendored 渲染页，让它自己按同一张表
// 给 `/diag` 上报带 `&lvl=`。这条判据核对三件事：补丁**在位**、正则源与宿主**逐字相同**、
// 级别真的**随 URL 上行**。少任何一件，渲染页就退回"宿主靠文案猜"。
const URL_TAIL = '`)}&lvl=${__weLvl}`';
function rendererLevelPatchOk(src, hostRe) {
  const m = src.match(/const __weLvl=\/(.+?)\/\.test\(n\)\?"warn":"info"/);
  return Boolean(m) && m[1] === hostRe && src.includes(URL_TAIL);
}
{
  const hostRe = (read('lib/routes/diag.js').match(/export const FAIL_REPORT_RE = \/(.+?)\/;/) || [])[1];
  const assets = LIB_FILES.filter((f) => /^lib\/webwallgl\/assets\/.*\.js$/.test(f));
  const hit = assets.filter((f) => rendererLevelPatchOk(read(f), hostRe));
  const html = read('lib/webwallgl/index.html');
  // 补丁改了内容就必须换 URL：`/scene-live` 给哈希资源发 immutable（一年），
  // 原地改同名文件等于让老访客一直拿旧产物 ⇒ 产物名带后缀、且 index.html 指向它。
  const renamed = hit.length === 1 && hit[0].endsWith('-welvl1.js')
    && html.includes('/assets/' + hit[0].split('/').pop())
    && !assets.some((f) => f !== hit[0] && /renderer-.*\.js$/.test(f) && !f.endsWith('-welvl1.js'));
  check('N7 渲染页带明文级别：补丁在位、正则与宿主模式表逐字相同、级别随 `/diag` 上行',
    Boolean(hostRe) && hostRe.length > 0 && hit.length === 1 && assets.length >= 1,
    '宿主正则=' + JSON.stringify(hostRe) + ' 补丁命中=' + hit.length + '/' + assets.length);
  check('N7 换名与引用一致：产物名带补丁后缀、index.html 指向它、旧名不留存（immutable 缓存不失效）',
    renamed, '产物=' + (hit[0] || '(无)') + ' index.html=' + (hit.length === 1 && html.includes('/assets/' + hit[0].split('/').pop())));
  check('N7 negative control: 少斜杠 / 换一张表 / 不带 lvl / 留着旧名 四种坏补丁都会被判出',
    rendererLevelPatchOk('const __weLvl=' + hostRe + '.test(n)?"warn":"info";' + URL_TAIL, hostRe) === false
    && rendererLevelPatchOk('const __weLvl=/onlythis/.test(n)?"warn":"info";' + URL_TAIL, hostRe) === false
    && rendererLevelPatchOk('const __weLvl=/' + hostRe + '/.test(n)?"warn":"info";', hostRe) === false
    && rendererLevelPatchOk('const __weLvl=/' + hostRe + '/.test(n)?"warn":"info";' + URL_TAIL, hostRe) === true
    && ['lib/webwallgl/assets/renderer-AAAA.js', 'lib/webwallgl/assets/renderer-AAAA-welvl1.js']
      .filter((f) => /renderer-.*\.js$/.test(f) && !f.endsWith('-welvl1.js')).length === 1);
}

// ── 接线在位：两个宿主模块必须真的被入口 import（否则上面六条可以在死代码上全绿）──
const wiredUp = (src) => /from\s*'\.\/log\.js'/.test(src) && /from\s*'\.\/notice\.js'/.test(src)
  && /createNotice\(/.test(src) && consoleCalls(src) === 0;
{
  check('接线在位：lib/index.js 真的 import 并用上了 log.js / notice.js，且自己零 console.*',
    wiredUp(read('lib/index.js')));
  check('接线在位 negative control: 少一个 import 或自己打一行 console 都会被判出',
    wiredUp("import { createLog } from './log.js';\ncreateNotice(") === false
    && wiredUp("import { createLog } from './log.js';\nimport { createNotice } from './notice.js';\ncreateNotice(1);\nconsole.log('x');") === false);
}

// ── R1–R4 运行期行为（直接跑 lib/log.js 与 lib/notice.js 这两个宿主模块）──────
{
  const { createLog } = await import('../lib/log.js');
  const { createNotice } = await import('../lib/notice.js');

  /**
   * 捕获终端输出：`console.warn` / `console.error` 走 stderr，`console.info` 走 stdout ——
   * 两条都要接住，否则"只有 warn 可见"这类判据会假绿。捕获期间**不得**调用 console（会被吞掉），
   * 所以所有测量先攒进结果，恢复流之后再 check。
   */
  function capture(failWith) {
    const out = [];
    const so = process.stdout.write;
    const se = process.stderr.write;
    const patch = (stream, tag) => {
      stream.write = (chunk, ...rest) => {
        out.push(tag + ':' + String(chunk));
        const cb = rest.find((x) => typeof x === 'function');
        if (typeof cb === 'function') cb(failWith || null);
        return true;
      };
    };
    patch(process.stdout, 'out');
    patch(process.stderr, 'err');
    return {
      out,
      restore() { process.stdout.write = so; process.stderr.write = se; },
    };
  }
  function withTTY(value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.stdout, 'isTTY');
    const before = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true, writable: true });
    try { return fn(); } finally {
      if (had) Object.defineProperty(process.stdout, 'isTTY', { value: before, configurable: true, writable: true });
      else delete process.stdout.isTTY;
    }
  }
  function withEnv(name, value, fn) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    try { return fn(); } finally {
      if (before === undefined) delete process.env[name]; else process.env[name] = before;
    }
  }
  /** 一次镜像测量：返回 [终端行, 平台收到的档位]。 */
  function mirrorLines(level) {
    const platform = [];
    const logger = { error: (m) => platform.push('error:' + m), warn: (m) => platform.push('warn:' + m), info: (m) => platform.push('info:' + m) };
    const log = createLog(logger, 'probe');
    const cap = capture();
    try {
      log.error('E'); log.warn('W'); log.info('I');
    } finally { cap.restore(); }
    return { terminal: cap.out, platform, level };
  }

  const defaultGate = withEnv('DSH_WE_LOG_LEVEL', undefined, () => withTTY(false, () => mirrorLines('default')));
  const infoGate = withEnv('DSH_WE_LOG_LEVEL', 'info', () => mirrorLines('info'));
  const errorGate = withEnv('DSH_WE_LOG_LEVEL', 'error', () => mirrorLines('error'));
  const bogusGate = withEnv('DSH_WE_LOG_LEVEL', 'chatty', () => mirrorLines('chatty'));
  const seen = (r) => r.terminal
    .map((l) => l.replace(/^[a-z]+:\[probe\] /, '').trim())
    .sort().join(',');
  check('R1 `DSH_WE_LOG_LEVEL` 三值真的决定终端镜像哪些档位（默认 warn、非法值按默认）',
    seen(defaultGate) === 'E,W' && seen(infoGate) === 'E,I,W' && seen(errorGate) === 'E'
    && seen(bogusGate) === 'E,W'
    && defaultGate.platform.length === 3,
    'default=' + seen(defaultGate) + ' info=' + seen(infoGate) + ' error=' + seen(errorGate)
      + ' 非法=' + seen(bogusGate) + '（平台通道始终三档全收）');
  check('R1 negative control: 同一个判据能区分三档（判据不是恒真）',
    seen(infoGate) !== seen(defaultGate) && seen(errorGate) !== seen(defaultGate) && seen(infoGate) !== seen(errorGate));

  const noticeRun = (gateValue, tty, failWith, calls = 1) => {
    const logs = [];
    const log = { warn: (m) => logs.push(m), error: (m) => logs.push('ERR' + m), info: (m) => logs.push('INF' + m) };
    const notice = createNotice(log, 'wallpaper-engine');
    const cap = capture(failWith);
    try {
      withTTY(tty, () => withEnv('DSH_WE_NOTICE', gateValue, () => {
        for (let i = 0; i < calls; i++) notice('media-origin', () => 'ok' + i);
      }));
    } finally { cap.restore(); }
    return { terminal: cap.out, logs };
  };
  const forced = noticeRun('1', false, null);
  const silentOff = noticeRun('0', true, null);
  const silentPipe = noticeRun(undefined, false, null);
  const ttyOn = noticeRun(undefined, true, null);
  const twice = noticeRun('1', false, null, 3);
  const failedSync = (() => {
    const logs = [];
    const log = { warn: (m) => logs.push(m) };
    const notice = createNotice(log, 'wallpaper-engine');
    const so = process.stdout.write;
    process.stdout.write = () => { throw new Error('EPIPE'); };
    try { withEnv('DSH_WE_NOTICE', '1', () => notice('scene-ready', 'x')); } finally { process.stdout.write = so; }
    return logs;
  })();
  const failedCallback = (() => {
    const logs = [];
    const log = { warn: (m) => logs.push(m) };
    const notice = createNotice(log, 'wallpaper-engine');
    const cap = capture(new Error('EPIPE'));
    try { withEnv('DSH_WE_NOTICE', '1', () => notice('scene-ready', 'x')); } finally { cap.restore(); }
    return logs;
  })();
  const isNotice = (r) => r.terminal.filter((l) => /^\S*\[wallpaper-engine\] .* ✔\n$/.test(l)).length;
  check('R2 一个 kind 每会话至多一条提示（同一实例内重复调用不再投递）',
    isNotice(forced) === 1 && isNotice(twice) === 1 && twice.terminal.length === forced.terminal.length,
    '一次=' + isNotice(forced) + ' 三次=' + isNotice(twice));
  check('R2 negative control: 换个 kind 会照常投递（幂等键是 kind 而不是"发过了"）',
    isNotice((() => {
      const notice = createNotice({ warn: () => {} }, 'wallpaper-engine');
      const cap = capture();
      try { withEnv('DSH_WE_NOTICE', '1', () => { notice('media-origin', 'a'); notice('scene-ready', 'b'); }); } finally { cap.restore(); }
      return { terminal: cap.out };
    })()) === 2);
  check('R3 `DSH_WE_NOTICE` 三态：`0` 与未设+非 TTY 都静默**且不报**，`1` 强制输出',
    isNotice(forced) === 1 && forced.logs.length === 0
    && forced.terminal.some((l) => l.endsWith('ok0 ✔\n'))
    && isNotice(silentOff) === 0 && silentOff.logs.length === 0 && silentOff.terminal.length === 0
    && isNotice(silentPipe) === 0 && silentPipe.logs.length === 0 && silentPipe.terminal.length === 0
    && isNotice(ttyOn) === 1,
    '强制=' + isNotice(forced) + ' 关=' + isNotice(silentOff) + ' 非TTY=' + isNotice(silentPipe) + ' TTY=' + isNotice(ttyOn));
  check('R3 提示行与日志行同形：`[<name>] <文案> ✔`（前缀同名、`✔` 在后）',
    forced.terminal.length === 1 && forced.terminal[0] === 'out:[wallpaper-engine] ok0 ✔\n',
    JSON.stringify(forced.terminal));
  check('R3 negative control: 旧的 `✔ <文案>` 形状不再被认作提示行',
    isNotice({ terminal: ['out:✔ ok0\n'] }) === 0 && isNotice({ terminal: ['out:[wallpaper-engine] ok0 ✔\n'] }) === 1);
  check('R3 negative control: 静默两态确实一条输出都没有（不是"写了但没认出来"）',
    silentOff.terminal.length === 0 && silentPipe.terminal.length === 0);
  check('R4 投递失败（同步抛错 / 回调 err）恰好一条 warn，成功路径零日志',
    failedSync.length === 1 && /投递失败/.test(failedSync[0])
    && failedCallback.length === 1 && /投递失败/.test(failedCallback[0])
    && forced.logs.length === 0 && ttyOn.logs.length === 0,
    '同步=' + failedSync.length + ' 回调=' + failedCallback.length + ' 成功路径=' + forced.logs.length);
  check('R4 negative control: 投递成功的三条路径都没有日志（判据不是"只要有日志就算"）',
    forced.logs.length === 0 && silentOff.logs.length === 0 && silentPipe.logs.length === 0
    && failedSync.length > 0);

  // ── R5 宿主侧分流（真的跑一遍 registerDiagRoutes）──────────────────────────
  // §2.2 的失败模式表与 §3.4 的 `/client-diag` 分流都只在**路由处理器内部**，静态看不出来。
  {
    const { registerDiagRoutes } = await import('../lib/routes/diag.js');
    const { EventEmitter } = await import('node:events');
    const routes = [];
    const diagLines = [];
    const platformLevels = [];
    const notices = [];
    const logger = {
      error: (m) => platformLevels.push('error:' + m),
      warn: (m) => platformLevels.push('warn:' + m),
      info: (m) => platformLevels.push('info:' + m),
    };
    const log = createLog(logger, 'wallpaper-engine');
    registerDiagRoutes(
      { register: (entry) => { routes.push(entry); return () => {}; } },
      {
        disposers: [],
        appendDiagLine: (kind, obj) => diagLines.push(kind + ':' + JSON.stringify(obj)),
        base: '/wallpaper-engine',
        log,
        notice: (kind) => notices.push(kind),
      },
    );
    const mkRes = () => {
      const res = new EventEmitter();
      res.setHeader = () => {};
      res.end = () => {};
      res.statusCode = 200;
      return res;
    };
    const getDiag = (query) => {
      const route = routes.find((r) => r.path === '/diag');
      getDiagRes = mkRes();
      route.handler({ method: 'GET', url: '/diag?' + query, headers: {} }, getDiagRes);
    };
    let getDiagRes = null;
    const postClientDiag = (body, size = 0) => {
      const route = routes.find((r) => r.path === '/wallpaper-engine/client-diag');
      const req = new EventEmitter();
      req.method = 'POST';
      req.url = '/wallpaper-engine/client-diag';
      req.headers = {};
      const res = mkRes();
      route.handler(req, res);
      if (size > 64 * 1024) req.emit('data', Buffer.alloc(size));
      else req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
      return res;
    };
    const shortLvl = () => platformLevels.map((l) => l.slice(0, l.indexOf(':')));

    // 整段测量都在捕获里跑：这条链路的终端镜像会真的写 stderr，不该污染守卫自己的输出。
    const cap = capture();
    let rendererLevels;
    let rendererLines;
    let okStatus;
    let noNoticeForWeb;
    let otherEventStatus;
    let badMethod;
    let tooBig;
    let clientLines;
    try {
      withTTY(false, () => withEnv('DSH_WE_LOG_LEVEL', 'warn', () => withEnv('DSH_WE_NOTICE', undefined, () => {
        getDiag('msg=' + encodeURIComponent('reload 失败'));
        getDiag('msg=' + encodeURIComponent('tex 12'));
        getDiag('msg=' + encodeURIComponent('tex 13') + '&lvl=warn');
        getDiag('msg=' + encodeURIComponent('tex 14') + '&lvl=bogus');
        getDiag('msg=' + encodeURIComponent('tex 15') + '&lvl=info');
        // 零失败的完成行与"词内 ERR"都不算问题（否则纯统计行会把终端刷出噪音）。
        getDiag('msg=' + encodeURIComponent('bake: 后台补烘完成 0 张（失败 0，产物 0.0MB，耗时 0ms）'));
        getDiag('msg=' + encodeURIComponent('tex TERRAIN 512'));
        getDiag('msg=' + encodeURIComponent('bake: 后台补烘完成 2 张（失败 1，产物 1.2MB）'));
      })));
      rendererLevels = shortLvl();
      rendererLines = diagLines.slice();
      platformLevels.length = 0;
      diagLines.length = 0;
      okStatus = postClientDiag({ event: 'live-ready', type: 'scene', id: 'w1', detail: 'firstFrame ok' }).statusCode;
      noNoticeForWeb = postClientDiag({ event: 'live-ready', type: 'web', id: 'w2' }).statusCode;
      otherEventStatus = postClientDiag({ event: 'live-build', type: 'scene', id: 'w3' }).statusCode;
      badMethod = (() => {
        const route = routes.find((r) => r.path === '/wallpaper-engine/client-diag');
        const req = new EventEmitter();
        req.method = 'GET';
        req.url = '/wallpaper-engine/client-diag';
        req.headers = {};
        const res = mkRes();
        route.handler(req, res);
        return res.statusCode;
      })();
      tooBig = postClientDiag({ event: 'x' }, 65 * 1024).statusCode;
      clientLines = diagLines.slice();
    } finally { cap.restore(); }

    check('R5 `/diag` 按失败模式表分档：失败类 ⇒ warn，其余 ⇒ info；`&lvl=` 三档优先、未知回落模式表',
      rendererLevels.join(',') === 'warn,info,warn,info,info,info,info,warn'
      && rendererLines.length === 8 && rendererLines.every((l) => l.startsWith('renderer:')),
      '档位=' + rendererLevels.join(',') + ' 落盘=' + rendererLines.length + ' 条（落盘与分级互不影响）');
    check('R5 `/client-diag` 的 `live-ready`+`scene` 走提示通道，且只此一条',
      notices.length === 1 && notices[0] === 'scene-ready' && okStatus === 204
      && noNoticeForWeb === 204 && otherEventStatus === 204
      && clientLines.length === 3 && clientLines.every((l) => l.startsWith('client:')),
      '提示=' + JSON.stringify(notices) + '；落盘 ' + clientLines.length + ' 条（网页类型 / 其它事件都不触发提示）');
    check('R5 三条早退不变：非 POST ⇒ 405、超 64KB ⇒ 413（且都不落盘、不提示）',
      badMethod === 405 && tooBig === 413 && notices.length === 1,
      '405=' + badMethod + ' 413=' + tooBig + ' 提示仍为 ' + notices.length);
    check('R5 negative control: 失败模式表之外的文案不会被升级成 warn，非 `scene` 类型不会触发提示',
      rendererLevels[1] === 'info' && rendererLevels[3] === 'info' && rendererLevels[4] === 'info'
      && rendererLevels[5] === 'info' && rendererLevels[6] === 'info'
      && rendererLevels.filter((l) => l === 'warn').length === 3
      && notices.length === 1 && noNoticeForWeb === 204);
  }
}

const failed = results.filter((r) => !r).length;
console.log('\n' + (failed ? 'LOGGING FAIL — ' + failed + ' check(s) failed' : 'ALL LOGGING CHECKS PASSED'));
process.exit(failed ? 1 : 0);
