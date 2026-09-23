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
  // 选项 (如壁纸画面刷新档位 variant), 故只锚定 signal: ctrl.signal 这一必需项。
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
      /ensure:\s*\(abs, o\) => ensureSceneFrame\(abs, o\)/.test(idx)],
    ['R15 队列随插件 dispose 停止 (disposers 按函数调用)',
      /disposers\.push\(\(\) => prewarmQueue\.stop\(\)\)/.test(idx)],
  ];
  for (const [name, ok] of checks) check(name, ok);

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

  check('R19 sanitizeSettings 收纳 sceneFrameSource, 且不再直接照抄输入值 (经总开关解析)',
    /sceneFrameSource: effectiveFrameSource\(o\)/.test(idx)
    && !/sceneFrameSource: o\.sceneFrameSource === 'maintexture'/.test(idx));

  // ⚠️ 兼容性是这条断言的核心: 默认模式必须**沿用旧键格式** (只在非默认模式追加后缀),
  // 否则升级会让用户已缓存的全部帧失效 —— 用户回退 0.7.3 的头号原因就是这个。
  check('R20 缓存键: 默认模式沿用旧格式 (不失效既有缓存), 非默认模式才加后缀',
    /PIPELINE_VERSION \+ '_' \+ gpuFlag \+ srcSuffix \+ '_'/.test(idx)
    && /srcSuffix = readSettings\(\)\.sceneFrameSource === 'maintexture' \? 'm' : ''/.test(idx)
    && /if \(srcSuffix === 'm'\)/.test(idx));

  check('R21 maintexture 分支存在并用 isMainTextureUsable 决定回退真实渲染',
    /isMainTextureUsable\(mainTexFrame\)/.test(idx)
    && /主纹理不适用 → 回退真实渲染/.test(idx)
    && /主纹理提取失败 → 回退真实渲染/.test(idx));

  check('R22 hasPuppet 判据在提取侧实现并附加到两条返回路径 (打包/目录)',
    /function sceneHasPuppet\(scene, access\)/.test(pkg)
    && (pkg.match(/hasPuppet: sceneHasPuppet\(/g) || []).length === 2);

  check('R23 客户端: UI 行 + 默认值均进入构建产物, 且文案如实说明不含骨骼/粒子/效果',
    /使用主纹理近似画面/.test(cli)
    && /sceneFrameSource:\s*"render"/.test(cli)
    && /不含角色骨骼合成/.test(cli));

  // ── R33–R37 有损路线总开关 (真值表 / 迁移 / 与 GPU 加速解耦) ──────────────
  // 语义 (用户确认): 总开关默认关; 关闭时附属项**强制失效**; 打开时附属项**默认开**;
  // 旧配置只设过 maintexture 的自动打开总开关; GPU 渲染加速**不在**其内。
  // 这里直接 import 宿主导出做**真实行为**断言, 而不是正则匹配表达式。
  const { lossyRouteOn, effectiveFrameSource } = await import('../lib/index.js');

  check('R33 有损路线总开关: 宿主用单一事实来源 + 客户端默认关闭 + UI 行进入产物',
    /sceneLossyRoute: lossyRouteOn\(o\)/.test(idx)
    && /sceneFrameSource: effectiveFrameSource\(o\)/.test(idx)
    && /sceneLossyRoute:\s*false/.test(cli)
    && /有损路线/.test(cli));

  // [输入, lossyRouteOn, effectiveFrameSource]
  const TABLE = [
    [{}, false, 'render'],
    [{ sceneFrameSource: 'render' }, false, 'render'],
    [{ sceneFrameSource: 'maintexture' }, true, 'maintexture'],              // 迁移
    [{ sceneLossyRoute: false }, false, 'render'],
    [{ sceneLossyRoute: false, sceneFrameSource: 'maintexture' }, false, 'render'], // 显式关 ⇒ 强制失效
    [{ sceneLossyRoute: true }, true, 'maintexture'],                        // 打开 ⇒ 附属项默认开
    [{ sceneLossyRoute: true, sceneFrameSource: 'render' }, true, 'render'], // 显式改回仍尊重
    [{ sceneLossyRoute: true, sceneFrameSource: 'maintexture' }, true, 'maintexture'],
  ];
  let bad = 0;
  for (const [inp, on, src] of TABLE) {
    if (lossyRouteOn(inp) !== on || effectiveFrameSource(inp) !== src) bad++;
  }
  check('R34 真值表 (含迁移 + "关闭即强制失效" + "打开默认开")', bad === 0,
    `${TABLE.length} 组合, 失败 ${bad}`);

  // 负对照: 两种"看起来对"的错误实现必须被真值表抓到
  const wrongKeep = (o) => (o.sceneFrameSource === 'render' ? 'render' : 'maintexture'); // 不做强制失效
  const wrongMigrate = (o) => (o.sceneFrameSource === 'maintexture' ? true : o.sceneLossyRoute === true); // 无条件迁移
  let passKeep = 0;
  let passMig = 0;
  for (const [inp, on, src] of TABLE) {
    if (wrongKeep(inp) === src) passKeep++;
    if (wrongMigrate(inp) === on) passMig++;
  }
  check('R34b 负对照: 去掉"关闭即强制失效"会被抓到', passKeep < TABLE.length,
    `错误实现通过 ${passKeep}/${TABLE.length}`);
  check('R34c 负对照: 无条件迁移(会重新打开用户显式关掉的总开关)会被抓到', passMig < TABLE.length,
    `错误实现通过 ${passMig}/${TABLE.length}`);

  check('R35 客户端镜像与宿主同式 (字段缺失 + maintexture ⇒ 打开)',
    /o\.sceneLossyRoute === undefined && o\.sceneFrameSource === "maintexture"/.test(cli)
    && /o\.sceneFrameSource === "render" \? "render" : "maintexture"/.test(cli));

  check('R36 总开关打开时 UI 把附属项预设为 maintexture',
    /selection\.sceneFrameSource = on \? "maintexture" : "render"/.test(cli));

  check('R37 GPU 渲染加速未被并入有损路线 (仍是独立开关)',
    /sceneGpuAccel: o\.sceneGpuAccel === true/.test(idx)
    && !/sceneGpuAccel[\s\S]{0,80}sceneLossyRoute/.test(idx)
    && !/sceneLossyRoute[\s\S]{0,200}sceneGpuAccel/.test(idx)
    && /GPU 渲染加速/.test(cli));

  // ── R38 出图来源档位 + 三级级联 ────────────────────────────────────────────
  // 存的是**档位 id**（不是下标）, 否则一旦数组顺序调整, 已保存的选择就会指向别的档。
  // 同时守住：①档位集合**恰好**是自动/主纹理/作者原画/自定义画面（"合成"与"预览图"
  // 是自动链自己的第 2/3 步, 不许作为手动档重新出现）；②「自定义画面」在数组末尾
  // （frameVariantCount 用它算"未导入自定义画面时的档位数"）；③宿主只认 1..4；
  // ④三级级联的门控；⑤关闭「静态帧渲染」时不再请求渲染产物。
  {
    const ids = [...cli.matchAll(/\{\s*id:\s*(\d+),\s*label:/g)].map((m) => Number(m[1]));
    const uniq = new Set(ids).size === ids.length;
    const customLast = /id:\s*4,\s*label:\s*"自定义画面"\s*\},?\s*\];/.test(cli);
    const usesId = /FRAME_VARIANTS\[\(curIdx \+ 1\) % total\]\.id/.test(cli)
      && /map\[wid\] = CUSTOM_FRAME_ID/.test(cli);
    const hostOk = /vParsed >= 1 && vParsed <= 4/.test(idx)
      && !/forceRender/.test(idx)
      && /const vSuffix = variant \? '_v' \+ variant : ''/.test(idx)
      && /variant === 1 \|\| variant === 2/.test(idx)
      && !/variant === 6/.test(idx);
    // 三级级联：实时渲染没在生效（父关 / 该壁纸已自动降级）→ 出现子「静态帧渲染」；
    // 子打开 → 才出现「静态帧兜底（回退）」组（出图来源 + 调优项都在其中）。
    const cascade = /&& !liveRenderEnabled\(sel\)[\s\S]{0,60}switchRow\("静态帧渲染", sel\.sceneFrameRender !== false/.test(cli)
      && /sel\.sceneFrameRender !== false\s*\n\s*&& React\.createElement\("div", \{ className: "we-picker__section" \}/.test(cli)
      && /frameRenderOff \? \(hasCustom \? CUSTOM_FRAME_ID : 3\) : savedVariant/.test(cli)
      && /sceneFrameRender: o\.sceneFrameRender !== false/.test(idx)
      && /st\.scenePrewarm === true && st\.sceneFrameRender !== false/.test(idx);
    check('R38 出图来源档位 + 三级级联: 档位恰好 [0,1,2,4]（不含链上已有的 合成/预览图）/ 自定义档在末尾 / 宿主只认 1..4；实时渲染未生效 且 静态帧渲染开 才出现兜底组',
      ids.join(',') === '0,1,2,4' && uniq && customLast && usesId && hostOk && cascade,
      'ids=[' + ids.join(',') + '] unique=' + uniq + ' customLast=' + customLast
        + ' clientUsesId=' + usesId + ' host=' + hostOk + ' cascade=' + cascade);
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
