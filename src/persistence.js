/**
 * persistence.js — 设置持久化层：**宿主文件是真源，localStorage 是同步缓存 + 迁移源 + 回滚**。
 *
 * 为什么单独一个文件：这一族是"用户改了设置之后到底存到哪、什么时候存、失败了怎么办"的**全部答案**
 * （194 行）：debounce 写、脏标记与重试、页面隐藏时 flush、启动时的宿主→本地迁移、以及
 * "用户在这次 GET 在途时改了设置 ⇒ 宿主的答案已过期，不许覆盖"的竞态守卫。此前它散在
 * src/client.js 的头部与中段（读 localStorage 的助手在 store 定义之前、其余在 store 之后），
 * 读的时候要跳两处；抽出来之后"设置为什么丢了"只需读一个文件。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域"=
 * 同一 prelude / src/client.js 的顶层。依赖见下方逐条列举，此处不写死数量）：
 *   selection        ← 设置/选中项的唯一 store（本文件读它、并在启动时**合并**宿主/本地值）
 *   SETTINGS_KEY     ← localStorage 键（client.js 顶层 const）
 *   SETTINGS_URL     ← 宿主设置路由（client.js 顶层 const）
 *   sanitizeSettings / serializeSettings / DEFAULTS ← lib/settings-schema.js（消毒 / 白名单 / 默认值）
 *   emit             ← 单向重渲染（启动加载完成后通知一次）
 *   applyEffects     ← src/effects.js（设置落地到 DOM）
 *   setAdapterFromHost ← src/adapter.js（宿主上报的适配目标观测值）
 *   apiJson / apiFetch ← src/api-client.js（宿主 API 唯一出入口）
 * 提供的入口：
 *   persistSelection()      改动后调用（debounce 200ms；无定时器设施时立即写）
 *   loadPersisted()         启动加载：宿主优先 → 无存档时把本地迁移上去 → 宿主不可达时回落本地
 *   flushPersist()          立即写（绕过 debounce）
 *   onPageHideFlush()       pagehide 时把挂起的写落地（由 client 的 ctx.effect 注册）
 *   onVisibilityResyncPersist() 页面重新可见时重试失败的写（同上）
 *   cancelPendingPersist()  卸载时取消挂起的写（模块级 timer 不属于 fiber）
 *   readPersisted()         读 localStorage 缓存（**client.js 的 store 初始化要用**）
 *
 * 不变量：
 *   · **宿主文件是真源**，localStorage 只是"同步可读的缓存 + 迁移源 + 回滚"。任何"以本地覆盖宿主"
 *     的路径都必须有明确理由（目前只有一条：宿主还没有任何存档时做一次性迁移）。
 *   · **写必须 debounce 且可重试**：滑块每格都 JSON.stringify + 同步写 localStorage 会拖垮拖动；
 *     非 2xx 要留下脏标记（否则宿主文件变旧，下次加载会把用户的设置**回滚**）。
 *   · **在途 GET 不许覆盖用户的新写**：`persistWrites` 计数器是这条的判据 —— 快照 → 比对 → 跳过合并。
 *   · 定时器只经 `window.*`（带守卫）：无定时器设施的验证环境退化为立即写，而不是抛。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 */

function readPersisted() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { id: "", ...DEFAULTS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { id: "", ...DEFAULTS };
  }
}
// 持久化白名单（宿主文件 + localStorage 缓存携带的字段）：同样派生自 schema。
// id 放在最前，保持既有形状；键集由 schema 决定，两端一致。
function serializeSelection() {
  return serializeSettings(selection);
}

// Host persistence: debounced PUT to /wallpaper-engine/settings (same origin;
// the host writes ~/.dsh-wallpaper-engine/config.json — port-independent).
// localStorage stays a synchronous-read cache + migration source + rollback,
// never the source of truth — and its WRITE is debounced together with the
// PUT: slider drags used to trigger a full JSON.stringify + synchronous
// localStorage write on every input tick (dozens per drag). Timers go through
// window.* (guarded) like the rotation timer below, so headless verify
// environments without a timer facility fall back to an immediate write.
let persistTimer = null;
// Dirty flag: a failed/非-2xx PUT must not be silently dropped — the host file
// would go stale and the NEXT load (host = source of truth) would roll the
// user's settings back. Retried on the next persistSelection or when the page
// becomes visible again.
let persistDirty = false;
// Write counter: loadPersisted() snapshots it before its GET and skips the
// host→selection merge when the user edited settings while the GET was in
// flight (the user's pending PUT is newer than the host's answer).
let persistWrites = 0;
function writeLocalCache() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(serializeSelection())); } catch { /* ignore */ }
}
async function pushPersisted() {
  try {
    const res = await apiFetch(SETTINGS_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serializeSelection()),
      keepalive: true, // let a pending flush survive pagehide/close
    });
    // 「非 2xx」与「宿主不可达」对调用点是同一件事（都要重试）⇒ 这里只看 ok。
    persistDirty = !res.ok;
  } catch {
    // 只剩 serializeSelection() 自己抛这一条路径（apiFetch 不抛，见其契约）。
    persistDirty = true;
  }
}
function flushPersist() {
  persistTimer = null;
  writeLocalCache();
  pushPersisted();
}
function schedulePersist() {
  if (persistTimer) return;
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") {
    flushPersist();
    return;
  }
  persistTimer = window.setTimeout(flushPersist, 200);
}

// Flush a pending write when the page goes away (tab close / navigate), and
// retry a failed PUT when the page becomes visible again.
// 监听器改为具名函数, 由 apply 的 ctx.effect 注册/注销: 模块作用域注册的监听器
// 每次 client-plugin 重载/HMR 重新求值 bundle 都会再叠一对, 且永远无法移除。
function onPageHideFlush() {
  if (persistTimer && typeof window.clearTimeout === "function") {
    window.clearTimeout(persistTimer);
    flushPersist();
  }
}
function onVisibilityResyncPersist() {
  if (!document.hidden && persistDirty && !persistTimer) schedulePersist();
}

function persistSelection() {
  persistWrites++;
  schedulePersist();
}

// ── Host-sourced settings (load once at startup) ────────────────────────────
// GET /wallpaper-engine/settings: the host file is the source of truth (it
// survives DSH Desktop's random --port 0 restarts and browser data clears;
// localStorage is origin-scoped). Migration: when the host has nothing yet but
// localStorage does, upload it once so the host becomes the truth. On any host
// failure fall back to localStorage so a plain web load keeps working.
async function loadPersisted() {
  let hostSettings = null;
  let hostOk = false;
  // Race guard: if the user edits settings while this GET is in flight, the
  // response is STALE (their pending PUT is newer) and must not overwrite the
  // live selection.
  const writesAtStart = persistWrites;
  try {
    const res = await apiJson(SETTINGS_URL);
    // ⚠️ `!res.error` 不能省（不变量）：**"宿主回了 200 但体不是 JSON" 与 "宿主没有存档"
    // 必须分开** —— 前者按"宿主不可达"回落本地，后者要把本地副本 PUT 上去；只看 `ok` 会把
    // 前者读成后者（多一次写盘、语义也不同）。`error` 是 apiFetch 为"成功但解析失败"留的信号。
    if (res.ok && !res.error) {
      const data = res.data;
      hostSettings = data && data.settings;
      // 侧栏玻璃控制组只在 dsh-better-sidebar 已安装且启用时显示（host 检测）。
      selection.sidebarPresent = !!(data && data.betterSidebar);
      // 适配目标的宿主观测值（能力头栅栏 + 桌面壳 UA）。缺字段时 adapter.js 保持
      // null ⇒ 回落本地判定，不能因为响应里没有 adapter 就抛。
      setAdapterFromHost(data && data.adapter);
      hostOk = true;
    }
  } catch { /* 宿主不可达：apiFetch 已不抛，这里兜住赋值/消毒期的异常 */ }

  const stale = persistWrites !== writesAtStart;
  if (hostOk && hostSettings && typeof hostSettings === "object") {
    // Host is the truth: apply it and refresh the local cache copy — unless the
    // user edited settings during the fetch (their write wins).
    if (!stale) {
      Object.assign(selection, sanitizeSettings(hostSettings));
      writeLocalCache();
    }
  } else if (hostOk) {
    // Host has nothing saved yet: migrate any existing localStorage data once.
    // JSON.parse MUST be guarded here: a corrupted localStorage payload used to
    // reject loadPersisted(), which broke the loadPersisted().then(loadInventory)
    // boot chain and left the picker stuck on "扫描 Wallpaper Engine…" forever.
    const local = localStorage.getItem(SETTINGS_KEY);
    let parsedLocal = null;
    try { parsedLocal = local ? JSON.parse(local) : null; } catch { /* corrupted cache: treat as absent */ }
    if (!stale) Object.assign(selection, parsedLocal ? sanitizeSettings(parsedLocal) : { id: "", ...DEFAULTS });
    if (parsedLocal) pushPersisted();
  } else {
    // Host unreachable (route missing / static load): localStorage fallback.
    if (!stale) Object.assign(selection, readPersisted());
  }

  // Settings applied (host or fallback). Mark loaded so gated UI — the one-time
  // notice — knows the persisted noticeSeen is final before it renders.
  selection.hostLoaded = true;
  applyEffects();
  emit();
}

/**
 * 取消挂起的 debounce 写入（卸载路径调用）。
 * 模块级 timer 不属于 fiber：不清掉的话 200ms 后仍会跑一次 flushPersist()，
 * 对已卸载的插件写入状态（并且会重新武装 timer）。
 */
function cancelPendingPersist() {
  if (persistTimer && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(persistTimer);
  }
  persistTimer = null;
}
export {
  persistSelection, loadPersisted, flushPersist, onPageHideFlush, onVisibilityResyncPersist,
  cancelPendingPersist, readPersisted,
};
