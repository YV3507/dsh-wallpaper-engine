/**
 * fontset-store.js — 字体集的**客户端通道**（F3 阶段 2）：活动集的值住宿主文件，
 * 与设置（src/persistence.js）**平行但另一条**通道。
 *
 * 为什么另立一条而不是并进 persistence.js：两者的**真源不同**（settings blob ↔
 * `fontsets/<id>.json`）、**键集不同**（那六个字体键已退出 settings 的持久化白名单）、
 * **失败语义也不同**（设置丢一次是回退，字体集读不出来必须"整套不采用"）。
 * 合成一条会让"这个值到底存哪"再次变成要通读两处才能回答的问题 —— 那正是 P2-10 拆掉的东西。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   selection                      ← 共享 store（本文件**只读写那六个字体键** + 两个瞬态字段）
 *   FONTSET_KEYS / FONTSET_MIGRATED_ID / isFontSetId / sanitizeFontset ← lib/settings-schema.js
 *   BASE / apiFetch / apiJson      ← src/api-client.js（宿主 API 唯一出入口；BASE 只在调用期读）
 *   hostFailureReason              ← src/client.js（"失败到底哪一步不对"的唯一一句文案）
 *   applyEffects                   ← src/effects.js
 *   emit                           ← 单向重渲染
 * 提供的入口：
 *   readCachedFontSetValues()      同步读本地缓存（**client.js 的 store 初始化要用**）
 *   loadFontSet()                  启动加载：活动 id + 正文 → 原子灌进 selection → 必要时重应用
 *   setFontValues(patch)           改字体值并落盘（**唯一入口**，与 setSetting 同形）
 *   persistFontSet()               单独安排一次落盘（"恢复默认"那种整批赋值用）
 *   flushFontSet() / onPageHideFlushFontSet() / onVisibilityResyncFontSet() / cancelPendingFontSet()
 *
 * 不变量：
 *   · **整套采用或整套不动**：只有拿到宿主那份完整正文（`sanitizeFontset` 出来的六个键）才写进
 *     selection，且是**一次** `Object.assign`。失败时保留现状（本地缓存那份）——绝不"改了一半"。
 *   · **localStorage 只是缓存**：启动时先同步读它（首帧就用上次的值，避免默认值→用户值跳变），
 *     宿主回了真值再覆盖。
 *   · **在途 GET 不许覆盖用户的新写**：`fontSetWrites` 计数器是这条的判据（与设置同形）。
 *   · **写只写活动集**：`PUT /fontsets/<活动 id>`；活动 id 未知时用 `FONTSET_MIGRATED_ID`
 *     （宿主那边迁移也认它 —— 两端同一个字面量，来自共享内核）。
 *   · 与设置同形：debounce 200ms、非 2xx 留脏标记并在页面重新可见时重试、pagehide 立即落盘。
 *   · 本文件必须保持浏览器安全（无 import / Node API），且**不得有顶层可执行语句**读外层 const
 *     （会被内联到 bundle 顶部，撞 TDZ）—— 因此 BASE 只在函数体里读，缓存也在函数里读。
 */

/** 活动集正文的本地缓存键（与设置缓存分开：两者真源不同，混在一起会互相顶掉）。 */
const FONTSET_CACHE_KEY = "we-fontset-active";

function fontSetsUrl() { return BASE + "/fontsets"; }
function fontSetUrl(id) { return fontSetsUrl() + "/" + encodeURIComponent(id); }

/** 读本地缓存那份 → `{ id, values }`（形状不合就当作没有）。 */
function readCachedFontSet() {
  try {
    const raw = localStorage.getItem(FONTSET_CACHE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== "object" || !isFontSetId(doc.id)) return null;
    return { id: doc.id, values: sanitizeFontset(doc.values) };
  } catch {
    return null;
  }
}
/**
 * 六个键的**兜底**值（空对象 / 空 map = 不覆盖官方外观），**一定齐全、一定是对象**。
 *
 * 为什么 selection 初始化必须用它：这六个键已不在 settings 白名单里 ⇒ `readPersisted()` 不再提供它们，
 * 而字体集是**异步**载入的、还可能失败。少了这份兜底，`selection` 会**根本没有这几个键**，
 * 于是面板那份 `fontCustom` 门控的「文字颜色角色」区（`sel.themeColors[role.id]`）在**打开总开关的
 * 那一刻**抛 TypeError —— React 渲染期抛 = 整个面板崩掉（症状：点「字体自定义」当场白屏）。
 * 兜底必须发生在**同步**的初始化里，且排在缓存之前（有缓存时用缓存那份）。
 */
function fontValueDefaults() { return sanitizeFontset({}); }
/** 启动初始化用：缓存里的六个值（没有就给兜底那份）。 */
function readCachedFontSetValues() {
  const doc = readCachedFontSet();
  return doc ? doc.values : fontValueDefaults();
}
function writeFontSetCache(id, values) {
  try { localStorage.setItem(FONTSET_CACHE_KEY, JSON.stringify({ id, values })); } catch { /* 缓存写失败不影响真源 */ }
}

// 活动集 id：宿主回的为准；未知时留空，落盘时退回 FONTSET_MIGRATED_ID。
let activeFontSetId = "";
let fontSetTimer = null;
// 脏标记：非 2xx / 不可达都算"没写进去"，下次编辑或页面回到前台时重试（否则宿主那份会变旧，
// 而宿主是真源 ⇒ 下次加载会把用户刚改的字体**回滚**）。
let fontSetDirty = false;
// 在途 GET 的竞态守卫（与 persistence.js 的 persistWrites 同形）。
let fontSetWrites = 0;

/** 当前 selection 里的六个字体值（消毒后）—— 落盘与"值有没有变"的比较共用它。 */
function pickFontValues() {
  const out = {};
  for (const key of FONTSET_KEYS) out[key] = selection[key];
  return sanitizeFontset(out);
}

/** 立即写本地缓存（真源是宿主，缓存只是下次启动的同步起点）。 */
function cacheFontValues() {
  writeFontSetCache(activeFontSetId || FONTSET_MIGRATED_ID, pickFontValues());
}

async function pushFontSet() {
  const id = activeFontSetId || FONTSET_MIGRATED_ID;
  const values = pickFontValues();
  try {
    const res = await apiFetch(fontSetUrl(id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
      keepalive: true, // 让挂起的落盘活过 pagehide/close
    });
    fontSetDirty = !res.ok;
    if (res.ok) {
      activeFontSetId = id;
      writeFontSetCache(id, values);
      selection.fontSetError = "";
    } else {
      selection.fontSetError = hostFailureReason(res);
    }
  } catch {
    fontSetDirty = true;
  }
}
function flushFontSet() {
  fontSetTimer = null;
  cacheFontValues();
  pushFontSet();
}
function scheduleFontSet() {
  if (fontSetTimer) return;
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") {
    flushFontSet();
    return;
  }
  fontSetTimer = window.setTimeout(flushFontSet, 200);
}

/**
 * 改字体值（**唯一入口**，与 `setSetting` 同形）：赋值 + 落盘。
 * `patch` 给几个键就改几个；其余保持不动。
 */
function setFontValues(patch) {
  if (patch && typeof patch === "object") {
    for (const key of FONTSET_KEYS) if (key in patch) selection[key] = patch[key];
  }
  fontSetWrites++;
  scheduleFontSet();
}

/** 单独安排一次落盘（"恢复默认"那种直接改 selection 后调用）。 */
function persistFontSet() {
  fontSetWrites++;
  scheduleFontSet();
}

function onPageHideFlushFontSet() {
  if (fontSetTimer && typeof window.clearTimeout === "function") {
    window.clearTimeout(fontSetTimer);
    flushFontSet();
  }
}
function onVisibilityResyncFontSet() {
  if (!document.hidden && fontSetDirty && !fontSetTimer) scheduleFontSet();
}

/**
 * 启动加载（**原子**）：宿主 → 活动 id → 正文 → 一次 `Object.assign` 灌进 selection。
 * 失败时**不动任何字体值**（selection 保持"同步缓存那份" = 用户上次所见），
 * 并把**可判定原因**写进 `selection.fontSetError`（面板据此显示；绝不静默）。
 * @returns 是否拿到了宿主那份正文
 */
async function loadFontSet() {
  const writesAtStart = fontSetWrites;
  const before = JSON.stringify(pickFontValues());
  let values = null;
  let id = "";
  let why = "";
  try {
    const listRes = await apiJson(fontSetsUrl());
    const active = listRes.ok && !listRes.error && listRes.data ? listRes.data.active : null;
    if (!listRes.ok || listRes.error) {
      why = hostFailureReason(listRes);
    } else if (!isFontSetId(active)) {
      why = "宿主没有活动字体集";
    } else {
      id = active;
      const oneRes = await apiJson(fontSetUrl(active));
      if (oneRes.ok && !oneRes.error && oneRes.data && oneRes.data.values) {
        values = sanitizeFontset(oneRes.data.values);
      } else {
        why = hostFailureReason(oneRes);
      }
    }
  } catch {
    why = "宿主不可达（请求未完成）";
  }

  if (values) {
    activeFontSetId = id;
    // 用户在 GET 在途时改过 ⇒ 他的值更新，别覆盖（但活动 id 必须记下：写目标要对）。
    if (fontSetWrites === writesAtStart) {
      Object.assign(selection, values); // 六个键一次写完 —— 这就是"整套采用"
      writeFontSetCache(id, values);
    }
    selection.fontSetError = "";
  } else {
    selection.fontSetError = why || "字体集不可用";
  }
  selection.fontSetLoaded = true;
  if (values && JSON.stringify(pickFontValues()) !== before) applyEffects();
  emit();
  return Boolean(values);
}

/**
 * 取消挂起的 debounce 写入（卸载路径调用）。与 `cancelPendingPersist` 同理：
 * 模块级 timer 不属于 fiber，不清掉的话 200ms 后仍会对已卸载的插件写一次。
 */
function cancelPendingFontSet() {
  if (fontSetTimer && typeof window !== "undefined" && typeof window.clearTimeout === "function") {
    window.clearTimeout(fontSetTimer);
  }
  fontSetTimer = null;
}

export {
  fontValueDefaults, readCachedFontSetValues, loadFontSet, setFontValues, persistFontSet,
  flushFontSet, onPageHideFlushFontSet, onVisibilityResyncFontSet, cancelPendingFontSet,
};
