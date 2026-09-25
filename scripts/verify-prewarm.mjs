// 守卫: 排队预热队列的调度语义 + "预热与按需共用同一函数"的结构断言。
//
// 为什么需要它: 预热是**后台**行为, 出问题的方式很难被人工发现 ——
// 并发跑飞会拖慢前台、空闲门控失效会在用户操作时抢 CPU、退避失效会变成
// CPU 黑洞反复重渲同一个失败场景。这些都必须由断言钉住。
//
// R10 专门防"路由与预热各自实现"的漂移: 本项目已因此吃过两次亏
// (pkg-extract.js 与 scene-manifest.js 的 composite 各一份且已分叉, 见
// docs/SCENE-FRAME-PERF.md §十一)。
//
// 用法: node scripts/verify-prewarm.mjs
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createPrewarmQueue, prewarmDisabledByEnv } from '../lib/scene-prewarm.js';
import { liveSuppressesPrewarm } from '../lib/index.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// ── 假时钟 + 手动定时器 (让空闲门控可确定性测试) ─────────────────────────────
function makeClock() {
  let t = 1000000;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeoutFn(fn, ms) { const id = { fn, at: t + ms }; timers.push(id); return id; },
    clearTimeoutFn(id) { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      t += ms;
      for (let guard = 0; guard < 100; guard++) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await settle();
      }
    },
  };
  return clock;
}
async function settle(n = 8) { for (let i = 0; i < n; i++) await Promise.resolve(); }

function makeQueue(ensure, extra = {}) {
  const clock = makeClock();
  const q = createPrewarmQueue({
    ensure, idleMs: 30000, tickMs: 1000,
    now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    ...extra,
  });
  q.start(); // 建立调度循环 (真实宿主里由插件启动时调用)
  return { q, clock };
}

const okResult = (servedFrom) => async () => ({ fileAbs: '/x/' + servedFrom + '.png', servedFrom });

// ── R1 去重: 同一场景重复入队只处理一次 ──────────────────────────────────────
{
  const calls = [];
  const { q, clock } = makeQueue(async (abs, o) => { calls.push(abs); return { servedFrom: 'render' }; });
  q.setEnabled(true);
  q.setCandidates(['/a', '/a', '/b', '/b']);
  await clock.advance(31000);
  await clock.advance(31000);
  check('R1 队列去重: 重复候选只处理一次', calls.length === 2 && new Set(calls).size === 2,
    `ensure 调用 ${calls.length} 次 (期望 2): ${calls.join(',')}`);
}

// ── R2 并发严格 = 1 ─────────────────────────────────────────────────────────
{
  let inFlight = 0, maxInFlight = 0;
  const { q, clock } = makeQueue(async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 0)); // 模拟耗时渲染
    inFlight--;
    return { servedFrom: 'render' };
  });
  q.setEnabled(true);
  q.setCandidates(['/a', '/b', '/c', '/d', '/e']);
  // 反复推进多个 tick, 期间并发峰值必须恒为 1
  for (let i = 0; i < 6; i++) await clock.advance(31000);
  await settle(50);
  check('R2 并发严格 = 1 (避免低端机多核占满)', maxInFlight === 1,
    `并发峰值 ${maxInFlight}`);
}

// ── R3 空闲门控: 未满 idleMs 不出队 ─────────────────────────────────────────
{
  const calls = [];
  const { q, clock } = makeQueue(async (abs) => { calls.push(abs); return { servedFrom: 'render' }; });
  q.setEnabled(true);
  q.setCandidates(['/a']);
  await clock.advance(5000);
  const before = calls.length;
  await clock.advance(26000); // 累计 31s > 30s
  check('R3 空闲门控: 30s 内不出队, 超过后才出队', before === 0 && calls.length === 1,
    `5s 时 ${before} 次, 31s 时 ${calls.length} 次`);
}

// ── R4 任何交互重置空闲计时 (即暂停预热) ────────────────────────────────────
{
  const calls = [];
  const { q, clock } = makeQueue(async (abs) => { calls.push(abs); return { servedFrom: 'render' }; });
  q.setEnabled(true);
  q.setCandidates(['/a']);
  await clock.advance(20000);
  q.noteActivity();          // 用户操作 → 计时归零
  await clock.advance(20000); // 距上次操作仍只有 20s
  const paused = calls.length === 0;
  await clock.advance(11000); // 累计 31s
  check('R4 交互重置空闲计时: 操作期间不预热, 之后恢复', paused && calls.length === 1,
    `暂停期 ${paused ? '未出队' : '出队了'}, 恢复后 ${calls.length} 次`);
}

// ── R5 失败退避: 失败场景不反复重试 ─────────────────────────────────────────
{
  const calls = [];
  const { q, clock } = makeQueue(async (abs) => { calls.push(abs); throw new Error('render failed'); });
  q.setEnabled(true);
  q.setCandidates(['/bad']);
  await clock.advance(31000);
  for (let i = 0; i < 5; i++) await clock.advance(31000);
  check('R5 失败退避: 同一失败场景不在退避期内重试', calls.length === 1,
    `ensure 调用 ${calls.length} 次 (期望 1)`);
}

// ── R6 始终以 allowFallback:false 调用 (绝不把 .fb. 当预热结果) ──────────────
{
  let sawFallbackFalse = true, anyCall = false;
  const { q, clock } = makeQueue(async (abs, o) => {
    anyCall = true;
    if (o.allowFallback !== false) sawFallbackFalse = false;
    return { servedFrom: 'render' };
  });
  q.setEnabled(true);
  q.setCandidates(['/a', '/b']);
  await clock.advance(31000);
  await clock.advance(31000);
  check('R6 预热始终 allowFallback:false (不产 .fb. 兜底帧)', anyCall && sawFallbackFalse,
    `调用 ${anyCall ? '发生' : '未发生'}, allowFallback 恒 false = ${sawFallbackFalse}`);
}

// ── R7 计数: warmed / skipped / failed 分类正确 ──────────────────────────────
{
  const seq = { '/w': 'render', '/s': 'cache' };
  const { q, clock } = makeQueue(async (abs) => {
    if (abs === '/f') throw new Error('boom');
    return { servedFrom: seq[abs] || 'render' };
  });
  q.setEnabled(true);
  q.setCandidates(['/w', '/s', '/f']);
  await clock.advance(31000);
  await clock.advance(31000);
  await clock.advance(31000);
  const st = q.status();
  check('R7 计数: warmed/skipped/failed 分类正确',
    st.warmed === 1 && st.skipped === 1 && st.failed === 1,
    `warmed=${st.warmed} skipped=${st.skipped} failed=${st.failed}`);
}

// ── R8 promote: 刚切到的场景提到队首 ────────────────────────────────────────
{
  const order = [];
  const { q, clock } = makeQueue(async (abs) => { order.push(abs); return { servedFrom: 'render' }; });
  q.setEnabled(true);
  q.setCandidates(['/a', '/b', '/c']);
  q.promote('/c');
  await clock.advance(31000);
  check('R8 promote 把场景提到队首', order[0] === '/c', `首个处理: ${order[0]}`);
}

// ── R9 环境逃生门 ───────────────────────────────────────────────────────────
{
  process.env.DSH_WE_NO_PREWARM = '1';
  const calls = [];
  const { q, clock } = makeQueue(async (abs) => { calls.push(abs); return { servedFrom: 'render' }; });
  q.setEnabled(true);
  q.setCandidates(['/a']);
  await clock.advance(31000);
  const envFlag = prewarmDisabledByEnv();
  const envOk = envFlag === true && calls.length === 0;
  delete process.env.DSH_WE_NO_PREWARM;
  check('R9 DSH_WE_NO_PREWARM=1 强制关闭预热', envOk, `envDisabled=${envFlag} 出队 ${calls.length} 次`);
}

// ── R10 结构: 缓存路径只在 ensureSceneFrame 内构造 (路由与预热共用同一函数) ──
{
  const src = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  // 断言必须**精确指向缓存键构造**, 不能用 "PIPELINE_VERSION +" 泛匹配 ——
  // 启动清扫的键前缀正则也在拼接它 ([PIPELINE_VERSION + '_', ...]), 泛匹配会数到 2。
  // 键的组成会随后续功能增加 (gpuFlag → +srcFlag …), 故只锚定不变的前缀部分。
  const keyExpr = /PIPELINE_VERSION \+ '_' \+ gpuFlag/g;
  const keySites = (src.match(keyExpr) || []).length;
  const defined = /async function ensureSceneFrame\(/.test(src);
  // 路由必须**调用** ensureSceneFrame (与预热共用同一条路径)。调用点可携带更多
  // 选项 (如「出图来源」档位 variant), 故只锚定 signal: ctrl.signal 这一必需项。
  const routeCalls = /await ensureSceneFrame\(abs, \{ signal: ctrl\.signal[^}]*\}\)/.test(src);
  check('R10 结构: 缓存键只在 ensureSceneFrame 内构造一次, 路由调用它',
    keySites === 1 && defined && routeCalls,
    `缓存键构造点=${keySites} (期望 1), ensureSceneFrame 定义=${defined}, 路由调用=${routeCalls}`);
}

// ── R11–R15 接线断言: 开关必须真实生效, 不能是"空开关" ──────────────────────
// (本项目已有一个空开关的教训: sceneGpuAccel 曾被 betaSceneAnim 门控到永远传不出值,
//  切换它只作废缓存、毫无效果 —— 见 docs/SCENE-FRAME-PERF.md §十四。)
{
  const idx = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  const checks = [
    ['R11 /settings PUT 驱动预热开关 (setEnabled + 候选刷新 + 提升队首)',
      /prewarmQueue\.setEnabled\(prewarmWanted\(\)\)/.test(idx)
      && /refreshPrewarmCandidates\(curAbs\)/.test(idx)
      && /prewarmQueue\.promote\(curAbs\)/.test(idx)],
    ['R12 scene-frame 路由上报用户活动 (前台请求暂停预热)',
      /prewarmQueue\.noteActivity\(\)/.test(idx)],
    ['R13 sanitizeSettings 收纳 scenePrewarm / scenePrewarmScope',
      /scenePrewarm:\s*o\.scenePrewarm === true/.test(idx)
      && /scenePrewarmScope:\s*o\.scenePrewarmScope === 'all' \? 'all' : 'recent'/.test(idx)],
    ['R14 预热队列以 allowFallback 透传给 ensureSceneFrame (共用同一函数)',
      /ensure:\s*async\s*\(abs, o\) => \{[\s\S]{0,240}?return ensureSceneFrame\(abs, o\);[\s\S]{0,60}?\}/.test(idx)],
    // 与上游提取式预热互斥（用户 2026-09-25 定）：上游那轮在跑时渲染队列原地等待，
    // 上游优先。三处必须同时在：运行标志、让路轮询、上游函数进出标志。
    ['R14b 两套预热互斥：上游提取式预热期间渲染队列让路（上游优先）',
      /let extractionPrewarmRunning = false;/.test(idx)
      && /async function sceneFramePrewarm\(\)[\s\S]{0,400}?extractionPrewarmRunning = true;[\s\S]{0,300}?finally \{[\s\S]{0,120}?extractionPrewarmRunning = false;/.test(idx)
      && /while \(extractionPrewarmRunning\)/.test(idx)
      && /await waitForExtractionPrewarm\(o && o\.signal\)/.test(idx)],
    ['R15 队列随插件 dispose 停止 (disposers 按函数调用)',
      /disposers\.push\(\(\) => prewarmQueue\.stop\(\)\)/.test(idx)],
  ];
  for (const [name, ok] of checks) check(name, ok);

  // ── R11b 实时渲染在用 ⇒ 预热必须停摆 (用户报告的黑屏/卡顿根因) ──────────────
  // 为什么必须测: 预热是满载 CPU/GPU 的冷渲染 (4K, 数百 ms~数秒), 而屏幕上可能正在跑
  // 实时渲染(动画)。两者抢资源 ⇒ 卡顿; 实时渲染首帧超时被判失败并写进失败记忆后,
  // 该壁纸此后一直不实时渲染; 图还没渲染出来时的黑屏也来自同一条链。
  {
    const sceneAbs = 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\123\\scene.pkg';
    const base = { scenePrewarm: true, sceneFrameRender: true, sceneLive: true, id: '123', sceneLiveFailures: {} };
    check('R11b 实时渲染在用 (场景 pkg + 总开关开 + 无失败记忆) ⇒ 抑制预热',
      liveSuppressesPrewarm(base, sceneAbs) === true);
    check('R11b-1 负对照: 该壁纸已判实时渲染失败 ⇒ 不抑制 (它正需要静态帧)',
      liveSuppressesPrewarm({ ...base, sceneLiveFailures: { 123: 'timeout' } }, sceneAbs) === false);
    check('R11b-2 负对照: 实时渲染总开关关掉 ⇒ 不抑制 (此时静态帧才是显示形态)',
      liveSuppressesPrewarm({ ...base, sceneLive: false }, sceneAbs) === false);
    check('R11b-3 负对照: 非 pkg (图片/视频/网页) ⇒ 不抑制',
      liveSuppressesPrewarm(base, 'E:\\x\\a.jpg') === false);
    check('R11b-4 负对照: abs 解析不到 (null) ⇒ 不抑制 (宁可预热也不误停)',
      liveSuppressesPrewarm(base, null) === false);
    check('R11b-5 现行接线：当前正在实时渲染的那张不进候选名单 + 不提升 + prewarmWanted 不整体停摆',
      /skipCurrent = Boolean\(currentAbs\) && liveSuppressesPrewarm\(readSettings\(\), currentAbs\)/.test(idx)
      && /if \(currentAbs && !skipCurrent\) list\.push\(currentAbs\)/.test(idx)
      && /if \(!liveSuppressesPrewarm\(sanitized, curAbs\)\) prewarmQueue\.promote\(curAbs\)/.test(idx)
      && /return st\.scenePrewarm === true;/.test(idx));
  }

  // ── R11c 只命中、不渲染 (?cached=1) ─────────────────────────────────────────
  // 静态帧是"缓存兜底"：live 的垫底图必须只查缓存（有就白得一张真帧，没有就空着），
  // 绝不能为过渡图触发 4K 冷渲染去抢实时渲染的 CPU/GPU。
  {
    const cachedGate = idx.indexOf('opts.cachedOnly === true');
    const renderGate = idx.indexOf('SCENE_FRAME_INFLIGHT.get(key)');
    check('R11c-1 cachedOnly 在渲染路径之前短路 (抛 not-cached, 不进 in-flight/worker)',
      cachedGate > 0 && renderGate > cachedGate);
    check('R11c-2 路由解析 ?cached=1 并回 404 (未命中是正常结果, 不是渲染失败)',
      /searchParams\.get\('cached'\) \|\| ''\) === '1'/.test(idx)
      && /const cachedOnly = /.test(idx)
      && /res\.statusCode = err && err\.notCached \? 404 : 422;/.test(idx));
    check('R11c-3 实时渲染流量算用户活动 ⇒ 预热推迟到动画起来之后 (前台路由 + /scene-live + /scene-files)',
      (idx.match(/prewarmQueue\.noteActivity\(\);/g) || []).length >= 3);
  }

  // 客户端侧: UI 行 + 默认值必须真的落到构建产物里
  const cli = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
  const hasUiRow = /空闲预热/.test(cli);
  const hasScopeRow = /预热整个库/.test(cli);
  const hasDefault = /scenePrewarm:\s*false/.test(cli);
  check('R16 客户端: 开关 UI 行 + 范围行 + 默认值均进入构建产物',
    hasUiRow && hasScopeRow && hasDefault,
    `UI行=${hasUiRow} 范围行=${hasScopeRow} 默认值=${hasDefault}`);

  // 打包白名单: 缺文件会让发布版直接崩 (此守卫曾抓到过真实回归)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const shipped = Array.isArray(pkg.files) && pkg.files.includes('lib/scene-prewarm.js');
  check('R17 package.json files 收录 lib/scene-prewarm.js', shipped,
    shipped ? '已收录' : '缺失 — 发布版会因缺文件崩溃');
}

// ── R18 持久化: 重启后队列续跑 (目标第 6 条) ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prewarm-'));
  const statePath = join(dir, 'q.json');
  const mk = () => {
    const clock = makeClock();
    const q = createPrewarmQueue({
      ensure: async () => ({ servedFrom: 'render' }), statePath,
      now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    });
    return { q, clock };
  };
  const { q: q1, clock: c1 } = mk();
  q1.setCandidates(['/a', '/b', '/c']);
  q1.stop();                      // 触发去抖保存
  await c1.advance(2000);         // 越过 1s 去抖 (保存挂在注入的假时钟上)
  const { q: q2 } = mk();         // 模拟重启
  const st = q2.status();
  check('R18 队列持久化: 重启后候选恢复 (重启续跑)', st.queueLength === 3,
    `恢复 ${st.queueLength} 项 (期望 3)`);
  q2.stop();
  rmSync(dir, { recursive: true, force: true });
}

// ── R19–R23 画面来源模式 (maintexture) 的接线与隔离断言 ─────────────────────
// 目标: 开关真实生效、两模式缓存互不污染、无产物/puppet 场景回退真实渲染。
{
  const idx = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  const pkg = readFileSync(join(ROOT, 'lib/pkg-extract.js'), 'utf8');
  const cli = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');

  // ── R19–R37（已退役）：有损路线总开关 / 画面来源模式 ──────────────────────
  // 这两者表达的正是链上的 static / maintex 两档，现由「出图来源」直接选
  //（docs/RENDER-FALLBACK-MODES.md §6：两者退役）。旧的一组断言（白名单解析、缓存键
  // 后缀、全局主纹理分支、UI 行、真值表与迁移）随功能一起删除 —— 这里改为把「删干净 +
  // 兜底路径不受影响」钉死，并保留与它们无关的两条（hasPuppet / GPU 加速独立）。
  check('R19 有损路线 / 画面来源模式已从两端删净（含缓存键后缀与全局主纹理分支）',
    // 只断**代码用法**（属性访问 / 键名 / 内部标识符），不断全文 —— 注释里正当地记着
    // "已退役"，全文否定会咬到注释（本轮已在 R38 踩过同类坑）。
    !/\.sceneLossyRoute\b/.test(idx) && !/sceneLossyRoute\s*:/.test(idx)
    && !/\.sceneFrameSource\b/.test(idx) && !/sceneFrameSource\s*:/.test(idx)
    && !/srcSuffix/.test(idx)
    // ⚠️ 只断**函数定义已删**：注释里仍会提到这两个名字（"与 lossyRouteOn 同一惯例"），
    // 裸词否定会咬到注释 —— 与 R38 的 sceneFrameRender 是同一个坑。
    && !/function lossyRouteOn\(/.test(idx) && !/function effectiveFrameSource\(/.test(idx)
    && !/\.sceneLossyRoute\b/.test(cli) && !/sceneLossyRoute\s*:/.test(cli)
    && !/\.sceneFrameSource\b/.test(cli) && !/sceneFrameSource\s*:/.test(cli)
    && !/switchRow\("有损路线/.test(cli));
  check('R19b 缓存键不再带模式后缀（默认格式不变），渲染失败的兜底帧路径不受影响',
    /const key = PIPELINE_VERSION \+ '_' \+ gpuFlag \+ '_' \+ Buffer/.test(idx)
    && /variant !== 8 \? '_v' \+ variant/.test(idx)
    // 兜底路径：真实渲染失败后 `mainTexFrame` 由提取填充并复用（不再有全局主纹理模式，
    // 所以 isMainTextureUsable 也随之删除 —— 这里断的是兜底本身还在）。
    && /const frame = mainTexFrame \|\|/.test(idx)
    && /\.fb\.png/.test(idx));
  check('R22 hasPuppet 判据在提取侧实现并附加到两条返回路径 (打包/目录)',
    /function sceneHasPuppet\(scene, access\)/.test(pkg)
    && (pkg.match(/hasPuppet: sceneHasPuppet\(/g) || []).length === 2);
  check('R37 GPU 渲染加速仍是独立开关 (不再有"有损路线"这层容器)',
    /sceneGpuAccel: o\.sceneGpuAccel === true/.test(idx)
    && /GPU 渲染加速/.test(cli)
    && !/function lossyRouteOn\(/.test(idx));

  // ── R38 出图来源档位 + 三级级联 ────────────────────────────────────────────
  // 存的是**档位 id**（不是下标）, 否则一旦数组顺序调整, 已保存的选择就会指向别的档。
  // 同时守住：①档位集合**恰好**是自动/主纹理/作者原画/自定义画面（"合成"与"预览图"
  // 是自动链自己的第 2/3 步, 不许作为手动档重新出现）；②「自定义画面」在数组末尾
  // （frameVariantCount 用它算"未导入自定义画面时的档位数"）；③宿主只认 1..4；
  // ④三级级联的门控；⑤关闭「静态帧渲染」时不再请求渲染产物。
  {
    // 档位表用常量写 id（CUSTOM_FRAME_ID / MP4_FRAME_ID / STATIC_FRAME_ID），所以先把
    // 常量名解析成数字再断言**链序**（§1/§2）：auto → custom → mp4 → static → maintex → art。
    const ID_OF = { CUSTOM_FRAME_ID: 4, MP4_FRAME_ID: 7, STATIC_FRAME_ID: 8 };
    const ids = [...cli.matchAll(/\{\s*id:\s*([A-Z_][A-Z0-9_]*|\d+),\s*label:/g)]
      .map((m) => (/^\d+$/.test(m[1]) ? Number(m[1]) : ID_OF[m[1]]));
    const uniq = new Set(ids).size === ids.length;
    const constsOk = /const CUSTOM_FRAME_ID = 4;/.test(cli) && /const MP4_FRAME_ID = 7;/.test(cli)
      && /const STATIC_FRAME_ID = 8;/.test(cli);
    const chainOrder = ids.join(',') === '0,4,7,8,1,2';
    // 状态行（「出图来源」按钮右侧那枚胶囊）**必须短**：旧格式把档名全塞进去
    //（「第 N/M 档 · 自动（逐级回退 · 当前：完整渲染） · 共 3 种」）, 而该行是
    // justify-content: space-between 且右侧 flex: 0 0 auto —— 胶囊一长就把左侧
    // 「出图来源」标题挤成省略号。故断死：只许 `N/M 档  当前：<短名>`。
    // ⚠️ 负向断言只咬**带引号的字符串字面量**（`" 档 · "` / `" · 共 "`）——
    // 源码注释里正当地引用了旧格式做对照, 若直接搜裸文本会咬到注释而假失败。
    const statusShort = /\+ "\/" \+ avail\.length \+ " 档  当前：" \+ short/.test(cli)
      && !/" 档 · "/.test(cli)
      && !/" · 共 "/.test(cli)
      // auto 报**链头解析到的那一项**（sceneFrameSource 已退役，不再参与状态行）
      && /chainHeadIdFor\(selLike, wid\)/.test(cli)
      && /id:\s*1,[^}]*short:\s*"单张大图"/.test(cli)
      && /id:\s*2,[^}]*short:\s*"内嵌 JPEG\/PNG"/.test(cli)
      && /id:\s*CUSTOM_FRAME_ID,[^}]*short:\s*"自定义画面"/.test(cli)
      && /id:\s*MP4_FRAME_ID,[^}]*short:\s*"内嵌 MP4"/.test(cli)
      && /id:\s*STATIC_FRAME_ID,[^}]*short:\s*"静态帧"/.test(cli);
    // 循环在**该壁纸实际存在的项**之间转（§3），「回到链头」由 avail 的模运算表达。
    const usesId = /const next = avail\[\(curIdx \+ 1\) % avail\.length\]/.test(cli)
      && /function availableFrameVariantIds\(selLike, wid\)/.test(cli)
      && /map\[wid\] = next/.test(cli);
    const hostOk = /const FRAME_VARIANT_IDS = new Set\(\[0, 1, 2, 4, 7, 8\]\)/.test(idx)
      && /function clampFrameVariant\(v\)/.test(idx)
      && /const variant = clampFrameVariant\(vParsed\)/.test(idx)
      && !/forceRender/.test(idx)
      // 档位后缀与键构造已收敛到单一构造点 sceneFrameCachePaths（P0-0 合并时合并
      // 上游 GPU 槽与渲染产物键，避免两处各自拼键而错位）—— 断言新位置的同一语义；
      // 显式 static(8) 与 auto(0) **同槽**（§8）。
      && /const key = PIPELINE_VERSION \+ '_' \+ gpuFlag \+ '_' \+ Buffer/.test(idx)
      && /\(variant && variant !== 8 \? '_v' \+ variant : ''\)/.test(idx)
      && /variant === 1 \|\| variant === 2/.test(idx)
      && !/variant === 6/.test(idx);
    // §8 新增：显式来源档（maintex/art）不被 GPU 抓帧顶掉；形态 → 媒体分支的映射。
    const gpuGate = /if \(variant === 1 \|\| variant === 2\) return null;/.test(idx);
    const mediaTier = /const wantStatic = tierId === STATIC_FRAME_ID/.test(cli)
      && /const wantVideo = tierId === MP4_FRAME_ID \? Boolean\(w\.sceneVideo\)/.test(cli)
      && /selection\.url = mp4Tier \? w\.sceneVideo/.test(cli);
    // 二级级联（§7）：live 没在生效 ⇒ **直接**出现「静态帧兜底与调优」组（中间那级
    // 「静态帧渲染」总开关已删除 —— live 关掉必定落在链上某一档，不存在"不渲染"态）。
    const cascade = /\(sel\.type === "scene" \|\| sel\.type === "web"\) && !liveRenderEnabled\(sel\)\s*\n\s*&& React\.createElement\("div", \{ className: "we-picker__section" \}/.test(cli)
      && !/switchRow\("静态帧渲染"/.test(cli)
      // 只断「代码里不再使用它」：属性访问与键名都不许在。**不能**用 `!/sceneFrameRender/`
      // —— 注释里正当地记着"该开关已删除（§7）"，全文否定会咬到注释而假失败（本轮踩到）。
      && !/\.sceneFrameRender\b/.test(cli) && !/sceneFrameRender\s*:/.test(cli)
      && /st\.scenePrewarm === true;/.test(idx);
    check('R38 回退链档位 + 二级级联: 链序恰好 [0,4,7,8,1,2]（auto→custom→mp4→static→maintex→art，不含已删的预览图/合成）/ 宿主值域 {0,1,2,4,7,8} 且显式 static 与 auto 同槽 / 显式来源档不被抓帧顶掉 / 形态→媒体分支 / 状态行保持短格式；实时渲染没生效即出现兜底组（中间那级总开关已删）',
      chainOrder && constsOk && uniq && usesId && hostOk && gpuGate && mediaTier && statusShort && cascade,
      'ids=[' + ids.join(',') + '] unique=' + uniq + ' consts=' + constsOk + ' chainOrder=' + chainOrder
        + ' clientUsesId=' + usesId + ' host=' + hostOk + ' gpuGate=' + gpuGate + ' media=' + mediaTier
        + ' statusShort=' + statusShort + ' cascade=' + cascade);

    // ── R38b 分组标题与行序（信息架构, 不是功能）────────────────────────────
    // 本组横跨两条轴：**来源/回退**（出图来源）与**调优**（有损/预热/GPU 加速）。两条
    // 断言把这次的整理固定下来：
    //  ①标题**只占一行** —— 原「调优项」那行不是开关、不承载任何值, 纯粹给下面的行加
    //    语义前缀, 已并进标题行右侧的 `.we-picker__hint` 说明；标题写"兜底与调优"是因为
    //    出图来源**不属于调优**（它不拿观感换速度）, 只叫"调优项"会误导。
    //  ②行序：**出图来源必须是本组第一个控件**（来源在前、调优在后）—— 画面不对时第一
    //    反应是换来源；若某个 switchRow 被插到它前面, 用户会先撞上速度旋钮。
    // 两条都带负对照：把标题改回旧名、把「调优项」行加回来、以及把一个 switchRow 插到
    // 出图来源之前, 必须分别被抓到。
    const SCOPE_HINT = 'React.createElement("span", { className: "we-picker__hint" }, "只作用于上面的静态帧渲染")';
    // ⚠️ 正则里的 `" \)` 不能写成 `" \)` 带空格 —— 构建产物里是 `..."静态帧兜底与调优"),`
    // （右括号紧贴引号）。第一版多写了一个空格, 正例恒 false, 而负对照照样"全抓到"
    // （因为恒 false 时任何变体都 false）—— 那种负对照是空的, 必须靠正例为真才有意义。
    const groupHead = (t) => /we-picker__section-label" \}, "静态帧兜底与调优"\)[\s\S]{0,200}?we-picker__hint" \}, "只作用于上面的静态帧渲染"\)/.test(t)
      && !/ctlText\("调优项"/.test(t);
    const srcFirst = (t) => {
      const i = t.indexOf('"静态帧兜底与调优"');
      const j = t.indexOf('ctlText("出图来源"');
      if (i < 0 || j < 0 || j < i) return false;
      return !/switchRow\(/.test(t.slice(i, j)); // 两者之间不得出现任何开关行
    };
    const headMutations = [
      cli.replace('"静态帧兜底与调优"', '"静态帧兜底（回退）"'),
      cli.replace(SCOPE_HINT, 'ctlText("调优项", "只作用于上面的静态帧渲染")'),
    ];
    const headCaught = headMutations.filter((t) => t !== cli && !groupHead(t)).length;
    const orderMutations = [
      cli.replace('ctlText("出图来源"', 'switchRow("GPU 渲染加速", false, () => {}, { key: "x" }),\n          ctlText("出图来源"'),
    ];
    const orderCaught = orderMutations.filter((t) => t !== cli && !srcFirst(t)).length;
    check('R38b 组标题只占一行（「调优项」占位行已并进标题）+ 出图来源是本组第一个控件（来源在前、调优在后）',
      groupHead(cli) && srcFirst(cli)
      && headCaught === headMutations.length && orderCaught === orderMutations.length,
      'head=' + groupHead(cli) + ' srcFirst=' + srcFirst(cli)
        + ' 负对照: 标题 ' + headCaught + '/' + headMutations.length
        + ' · 行序 ' + orderCaught + '/' + orderMutations.length);
  }

  // ── R39 渲染 worker 冒烟: 代码级错误必须立刻暴露 ────────────────────────────
  // 场景渲染 worker 是**默认静态帧路径**的执行者。它一旦抛 ReferenceError / TypeError
  // 这类代码级错误, 宿主会毫秒级失败并**静默回退主纹理提取**（画面"缺件"），而
  // verify-scene 的 `200 + body>1000B` 断言照样通过（回退帧也是合法 PNG）——
  // 648f502 删多帧分支时漏掉一处 `times` 引用就造成了这种"整条渲染链是死的"的静默失效。
  // 这里用不存在的 src 启动它: 期望报**场景/资源类**错误, 而不是代码级错误。
  {
    const { Worker } = await import('node:worker_threads');
    const wUrl = new URL('../lib/scene-render-worker.mjs', import.meta.url);
    const verdict = await new Promise((resolve) => {
      let w = null;
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; try { if (w) w.terminate(); } catch { /* ignore */ } resolve(v); };
      try {
        w = new Worker(wUrl, { type: 'module', workerData: { src: 'X-does-not-exist', width: 8, height: 8, time: 0 } });
      } catch (e) { done('spawn threw: ' + ((e && e.message) || e)); return; }
      w.on('message', (m) => done(m && m.ok === false ? String(m.error) : 'unexpected ok:' + JSON.stringify(m && Object.keys(m))));
      w.on('error', (e) => done(String((e && e.message) || e)));
      w.on('exit', (c) => { if (c !== 0) done('exit ' + c); });
      setTimeout(() => done('timeout'), 30000);
    });
    const codeBug = /ReferenceError|TypeError|SyntaxError|is not defined|is not a function/i.test(verdict);
    check('R39 场景渲染 worker 可启动: 只报场景/资源错误, 不抛代码级错误 (渲染链是活的)',
      !codeBug, String(verdict).slice(0, 130));
  }
}

// ── R24–R26 isMainTextureUsable: **行为**断言 (不止正则) ────────────────────
// 覆盖"无产物 ⇒ 回退"与"含 puppet ⇒ 回退"两条生产判据。
{
  const { isMainTextureUsable } = await import('../lib/pkg-extract.js');
  // ⚠️ 夹具必须在**压缩率上真实**: 早期版本用 Buffer.from([1])(bpp≈0.0002),
  // 在加入"近乎纯色"判据后会被**正确地**判为不可用 —— 那不是回归, 是夹具失真。
  const mk = (w, h, bpp, extra = {}) => ({
    mime: 'image/png', bytes: Buffer.alloc(Math.max(1, Math.round(w * h * bpp))),
    width: w, height: h, hasPuppet: false, ...extra,
  });
  const good = mk(1920, 1080, 0.8);
  check('R24 isMainTextureUsable: 正常帧 (bpp 0.8) → 可用', isMainTextureUsable(good) === true);
  check('R25 isMainTextureUsable: 含 puppet (图集) → 不可用 (回退真实渲染)',
    isMainTextureUsable(mk(1920, 1080, 0.8, { hasPuppet: true })) === false);
  check('R26 isMainTextureUsable: 无产物/残缺 → 不可用 (回退真实渲染)',
    isMainTextureUsable(null) === false
    && isMainTextureUsable(undefined) === false
    && isMainTextureUsable({ width: 10, height: 10, hasPuppet: false }) === false
    && isMainTextureUsable(mk(1920, 1080, 0.8, { width: 0 })) === false);
  // R31/R32 压缩率判据: 阈值 0.05 由本地库 16 个真实产物的实测分布定出
  // (2934788040 实际整屏黑 = 0.0063, 次小 = 0.1776, 最大 = 2.1037 ⇒ 28 倍余量)
  check('R31 近乎纯色/黑屏 (bpp 0.0063, 实测值) → 不可用 (回退真实渲染)',
    isMainTextureUsable(mk(2304, 1296, 0.0063)) === false);
  check('R32 判据有余量: 次小真实值 0.1776 通过, 0.04 拒收 (阈值不误伤真画面)',
    isMainTextureUsable(mk(1920, 1080, 0.1776)) === true
    && isMainTextureUsable(mk(1920, 1080, 0.04)) === false);
}

// ── R27–R30 泄漏与解耦 (行为断言) ───────────────────────────────────────────
// "切换壁纸 / 调整开关导致资源不释放" 是用户明确点出的问题, 必须实测行为而非读源码。
{
  // R27 关闭开关 → 中止在飞渲染 (不是只停止排新任务)
  let sig1 = null;
  const a = makeQueue((abs, o) => new Promise(() => { sig1 = o.signal; }));
  a.q.setEnabled(true);
  a.q.setCandidates(['/a']);
  await a.clock.advance(31000);
  const started1 = sig1 !== null;
  a.q.setEnabled(false);
  check('R27 关闭预热开关会中止**在飞**渲染 (否则关掉后 CPU 仍在烧)',
    started1 && sig1 && sig1.aborted === true,
    `已启动=${started1} 关闭后 aborted=${sig1 ? sig1.aborted : 'n/a'}`);

  // R28 stop() → 同样中止在飞渲染
  let sig2 = null;
  const b = makeQueue((abs, o) => new Promise(() => { sig2 = o.signal; }));
  b.q.setEnabled(true);
  b.q.setCandidates(['/b']);
  await b.clock.advance(31000);
  const started2 = sig2 !== null;
  b.q.stop();
  check('R28 插件停止 (stop) 会中止在飞渲染',
    started2 && sig2 && sig2.aborted === true,
    `已启动=${started2} 停止后 aborted=${sig2 ? sig2.aborted : 'n/a'}`);

  // R29 失败退避的真实机制: 失败后该场景被移出队列 (不会自旋重试);
  // "重新入列"发生在候选刷新时 (切壁纸 → setCandidates), 此时退避期阻止立刻重试,
  // 越过窗口后才恢复。断言必须照这个机制写, 而不是假设"到期自动重试"。
  const calls = [];
  const c = makeQueue(async (abs) => { calls.push(abs); throw new Error('render failed'); });
  c.q.setEnabled(true);
  c.q.setCandidates(['/bad']);
  await c.clock.advance(31000);                 // 第一次尝试 → 失败, 移出队列
  const afterFail = calls.length;
  for (let i = 0; i < 3; i++) await c.clock.advance(31000);
  const noSpin = calls.length === afterFail;    // 不在退避期内自旋
  c.q.setCandidates(['/bad']);                  // 重新入列 (退避期内)
  await c.clock.advance(31000);
  const blockedByBackoff = calls.length === afterFail;
  await c.clock.advance(31 * 60 * 1000);        // 越过 30 分钟
  c.q.setCandidates(['/bad']);
  await c.clock.advance(31000);
  check('R29 失败后不自旋; 退避期内重新入列不重试, 到期后恢复',
    noSpin && blockedByBackoff && calls.length > afterFail,
    `失败后 ${afterFail} 次, 退避期内重入列后 ${afterFail}(${blockedByBackoff}), 到期后 ${calls.length} 次`);
}

// R30 三项全局设置不得再被"当前壁纸是否场景"门控
{
  const src = readFileSync(join(ROOT, 'src/client.js'), 'utf8');
  const cli = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
  const gated = [
    'sel.type === "scene" && switchRow("空闲预热"',
    'sel.type === "scene" && switchRow("GPU 渲染加速"',
    'sel.type === "scene" && sel.scenePrewarm === true && switchRow("预热整个库"',
    'sel.type === "scene" && switchRow("使用主纹理近似画面"',
  ].filter((p) => src.includes(p) || cli.includes(p));
  check('R30 空闲预热/预热整个库/GPU 加速/主纹理 与"当前是否场景壁纸"解耦',
    gated.length === 0,
    gated.length ? ('仍被门控: ' + gated.length + ' 处') : '四处均已解耦 (源码 + 构建产物)');
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL PREWARM CHECKS PASSED'
  : failed.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
