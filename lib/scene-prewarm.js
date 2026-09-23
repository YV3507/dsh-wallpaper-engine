// 场景壁纸排队预热 —— 目标 G1: 切换壁纸时立即看到画面。
//
// 规格: docs/SCENE-FRAME-PERF.md §二十末「排队预热设计」。
//
// 三条硬约束 (都来自实测教训, 不是保守偏好):
//   · **并发严格 = 1**。单次渲染本身已是一个 fork 出来的 worker 进程; 用户还在交互。
//     并发 >1 会成倍推高核心占用, 正是"低端机多核占满"的来源。
//     (并行加速曲线亦显示 8/24 核即最优, 见 §十六 —— 少占核心反而更快。)
//   · **只在空闲时跑**。任何用户交互都重置空闲计时并暂停出队。
//   · **只产真实渲染产物**。调用方注入的 ensure 必须以 allowFallback=false 调用上游
//     (见 index.js::ensureSceneFrame), 于是兜底帧 .fb. 不可能被当作预热结果。
//
// 本模块不碰渲染、不做 IO 决策 —— 渲染由注入的 ensure 完成, 便于单测 (见
// scripts/verify-prewarm.mjs)。状态持久化可选 (statePath 为 null 则纯内存)。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_IDLE_MS = 30000;   // 用户无操作多久后开始预热
const DEFAULT_TICK_MS = 5000;    // 调度检查间隔
const FAIL_BACKOFF_MS = 30 * 60 * 1000; // 失败退避: 30 分钟内不重试同一场景

/** 环境逃生门: 强制关闭预热 (低端机/排障)。 */
export function prewarmDisabledByEnv() {
  return process.env.DSH_WE_NO_PREWARM === '1';
}

/**
 * @param {object} opts
 *   ensure(abs, { signal, allowFallback }) → Promise<{fileAbs, servedFrom}>
 *          servedFrom ∈ 'cache' | 'render' | 'fallback' | 'render-failed'
 *   log(msg, ...rest)  可选
 *   statePath          可选, 持久化文件 (null/省略 = 纯内存)
 *   idleMs / tickMs / now / setTimeoutFn / clearTimeoutFn  测试注入口
 */
export function createPrewarmQueue(opts = {}) {
  const ensure = opts.ensure;
  if (typeof ensure !== 'function') throw new Error('createPrewarmQueue: ensure 必填');
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const statePath = opts.statePath || null;
  const idleMs = Number.isFinite(opts.idleMs) ? opts.idleMs : DEFAULT_IDLE_MS;
  const tickMs = Number.isFinite(opts.tickMs) ? opts.tickMs : DEFAULT_TICK_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const setT = typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : setTimeout;
  const clearT = typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : clearTimeout;

  let enabled = opts.enabled === true;
  let running = false;
  let timer = null;
  let stopped = false;
  let currentCtrl = null;           // 在飞渲染的取消句柄 (关闭开关/停止时中止它)
  let candidates = [];              // 有序: 队首 = 最先预热
  const inflightKeys = new Set();   // 去重: 队列中/正在处理的不重复排队
  const failures = new Map();       // abs → 失败时间 (退避用)
  const stats = { warmed: 0, skipped: 0, failed: 0 };

  // ── 持久化 (队列 + 失败退避) ─────────────────────────────────────────────
  function loadState() {
    if (!statePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (Array.isArray(raw.candidates)) candidates = raw.candidates.filter((x) => typeof x === 'string');
      if (raw.failures && typeof raw.failures === 'object') {
        for (const [k, v] of Object.entries(raw.failures)) if (Number.isFinite(v)) failures.set(k, v);
      }
      // 重启续跑: 队列非空时把空闲计时从现在起算 (避免启动瞬间就开跑)
      lastActivityAt = now();
    } catch { /* 无历史/损坏 → 空队列 */ }
  }
  let saveTimer = null;
  function saveState() {
    if (!statePath) return;
    if (saveTimer) return;
    saveTimer = setT(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify({ candidates, failures: Object.fromEntries(failures) }));
      } catch { /* 持久化失败不影响预热本身 */ }
    }, 1000);
  }

  let lastActivityAt = now();

  /** 任何用户交互/渲染请求都调用: 重置空闲计时 (即暂停预热)。 */
  function noteActivity() {
    lastActivityAt = now();
  }

  /** 设置候选名单 (有序)。会剔除已缓存的项留给 ensure 自行判命中, 这里只去重。 */
  function setCandidates(list) {
    if (!Array.isArray(list)) return;
    candidates = list.filter((x) => typeof x === 'string');
    inflightKeys.clear();
    for (const c of candidates) inflightKeys.add(c);
    saveState();
  }

  /** 把某个场景提升到队首 (例如用户刚切到它)。 */
  function promote(abs) {
    if (typeof abs !== 'string' || !abs) return;
    candidates = [abs, ...candidates.filter((c) => c !== abs)];
    inflightKeys.add(abs);
    saveState();
  }

  function backoffActive(abs) {
    const t = failures.get(abs);
    return t !== undefined && (now() - t) < FAIL_BACKOFF_MS;
  }

  async function processOne(abs) {
    running = true;
    const ctrl = new AbortController();
    currentCtrl = ctrl;
    try {
      const res = await ensure(abs, { signal: ctrl.signal, allowFallback: false });
      if (res && res.servedFrom === 'render') { stats.warmed++; failures.delete(abs); }
      else if (res && res.servedFrom === 'cache') { stats.skipped++; failures.delete(abs); }
      else { stats.failed++; failures.set(abs, now()); }
    } catch (e) {
      // 渲染失败: 记退避, 不再反复重试 (预热是后台行为, 不能变成 CPU 黑洞)
      stats.failed++;
      failures.set(abs, now());
      log('预热失败:', abs, String(e && e.message ? e.message : e));
    } finally {
      running = false;
      if (currentCtrl === ctrl) currentCtrl = null;
      inflightKeys.delete(abs);
      candidates = candidates.filter((c) => c !== abs);
      saveState();
    }
  }

  /**
   * 中止在飞渲染 (开关关闭 / 插件停止时)。
   * 没有它的话, "关闭预热"只是不再排新任务, **在飞的那个仍会跑完** ——
   * 用户关掉开关后 CPU 还在烧 2–10s, 属可感知的资源不释放。
   * 取消会经 ensureSceneFrame 的等待者计数传导到 worker 进程。
   */
  function abortInFlight() {
    const c = currentCtrl;
    if (!c) return;
    currentCtrl = null;
    try { c.abort(); } catch { /* ignore */ }
  }

  /** 失败退避表按窗口裁剪 —— 否则随失败场景数单调增长 (scope='all' 时可达全库)。 */
  function pruneFailures() {
    const t = now();
    for (const [k, v] of failures) if (t - v >= FAIL_BACKOFF_MS) failures.delete(k);
  }

  /** 调度一次: 满足全部门控才出队一个。 */
  function tick() {
    if (stopped || !enabled || running) return;
    if (prewarmDisabledByEnv()) return;
    pruneFailures();
    if (now() - lastActivityAt < idleMs) return; // 空闲门控 (含"任何交互暂停")
    for (const abs of candidates) {
      if (backoffActive(abs)) continue;
      void processOne(abs);
      return; // 并发 = 1: 一次只起一个
    }
  }

  function start() {
    if (timer || stopped) return;
    timer = setT(function loop() {
      timer = null;
      try { tick(); } catch (e) { log('预热调度异常:', String(e && e.message ? e.message : e)); }
      if (!stopped) timer = setT(loop, tickMs);
    }, tickMs);
  }

  function stop() {
    stopped = true;
    abortInFlight();                 // 停止即中止在飞渲染, 不让它跑完
    if (timer) { clearT(timer); timer = null; }
    saveState();
  }

  function setEnabled(v) {
    enabled = v === true;
    if (enabled) noteActivity();     // 刚打开不立刻开跑
    // 关闭开关必须**中止在飞渲染** —— 否则只是不再排新任务, 当前那个仍烧 CPU
    else abortInFlight();
    saveState();
  }

  /** 可观测计数 (供 gpu-diag 或设置面板展示)。 */
  function status() {
    return {
      enabled, running, stopped,
      idleMs, lastActivityAt,
      queueLength: candidates.length,
      pendingRetry: candidates.filter(backoffActive).length,
      warmed: stats.warmed, skipped: stats.skipped, failed: stats.failed,
      envDisabled: prewarmDisabledByEnv(),
    };
  }

  loadState();
  return { start, stop, noteActivity, setEnabled, setCandidates, promote, status, isEnabled: () => enabled };
}
