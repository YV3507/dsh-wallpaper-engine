// WE 渲染引擎 — 可选分阶段耗时剖析 (默认完全关闭, 关闭时零计时开销)
//
// 开启: 环境变量 DSH_WE_PROFILE=1
// 用途: 定位单帧冷渲染 (4K 常见 10s~40s) 的成本构成 —— 纹理解码 / 各对象光栅化 /
//       效果链 / bloom 各占多少, 用于判断"哪些渲染阶段可以砍"有实际收益。
// 说明: 纯观测代码, 不改变任何渲染语义与输出像素; 未开启时 profTime 直接透传。
//
// 输出: 由调用方 (如 scripts/profile-scene.mjs) 调 profFormat() 取文本表格。
// 每次调用读取（非模块加载期）：宿主/WebUI 需要能在运行中途开关剖析。
// 调用方一律**当函数用**（`profileEnabled()`），不要缓存成布尔。
export function profileEnabled() { return process.env.DSH_WE_PROFILE === '1'; }

const acc = new Map(); // key → { ms, n }
const pxAcc = new Map(); // key → { px, n } — 效果输入像素数 (成本主因, 与输出分辨率无关)

function add(key, ms) {
  let e = acc.get(key);
  if (!e) { e = { ms: 0, n: 0 }; acc.set(key, e); }
  e.ms += ms;
  e.n++;
}

/** 记一笔耗时 (key 见下方分组前缀约定) */
export function profAdd(key, ms) {
  if (profileEnabled()) add(key, ms);
}

/**
 * 记一笔"效果输入像素数"。
 * 实测结论: 效果内核耗时与**输出画布分辨率无关**, 只随效果输入纹理像素数线性增长
 * (同一场景 960x540 与 3840x2160 的效果耗时几乎相同) —— 故纹理侧降采样才是提速杠杆。
 */
export function profPx(key, px) {
  if (!profileEnabled()) return;
  let e = pxAcc.get(key);
  if (!e) { e = { px: 0, n: 0 }; pxAcc.set(key, e); }
  e.px += px;
  e.n++;
}

/**
 * 计时执行 fn() 并累计到 key。关闭时直接调用 fn(), 不取时钟。
 * 允许嵌套 (如 对象明细 → 对象类型 → 纹理/效果链), 嵌套项在报告中分组展示以免误读。
 */
export function profTime(key, fn) {
  if (!profileEnabled()) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    add(key, performance.now() - t0);
  }
}

export function profReset() {
  acc.clear();
  pxAcc.clear();
}

export function profEntries() {
  return [...acc.entries()]
    .map(([phase, e]) => ({ phase, ms: e.ms, n: e.n }))
    .sort((a, b) => b.ms - a.ms);
}

// 分组前缀 → 显示名。顺序即报告顺序 (顶层在前, 明细在后)。
// 注意: 「阶段:」「对象」两项与「纹理」「效果」是**嵌套关系** (对象渲染内部会读纹理、
// 跑效果链), 故各组不做跨组求和 —— 只给组内小计, 避免重复计数误导。
const GROUPS = [
  ['总渲染', '总'],
  ['阶段:', '顶层阶段'],
  ['对象类型:', '对象 (按类型)'],
  ['纹理:', '纹理'],
  ['效果链:', '效果链'],
  ['效果:', '效果 (按名, 前 25)'],
  ['对象明细:', '对象 (按明细, 前 25)'],
];

function groupOf(phase) {
  for (const [prefix, label] of GROUPS) {
    if (prefix === '总渲染' ? phase === '总渲染' : phase.startsWith(prefix)) return { prefix, label };
  }
  return { prefix: '', label: '其它' };
}

/** 按分组渲染一组行 (供 profFormat 复用, 含"其它"兜底)。 */
function renderGroup(out, items, prefix, label, totalMs) {
  const sub = items.reduce((s, r) => s + r.ms, 0);
  const top = prefix === '对象明细:' || prefix === '效果:' ? 25 : items.length;
  out.push('');
  out.push(`── ${label} ── 小计 ${sub.toFixed(0)}ms`);
  for (const r of items.slice(0, top)) {
    const name = prefix ? r.phase.slice(prefix.length) : r.phase;
    const pct = totalMs ? `  ${((r.ms / totalMs) * 100).toFixed(1).padStart(5)}%` : '';
    out.push(`  ${name.padEnd(38)} ${r.ms.toFixed(0).padStart(8)}ms  n=${String(r.n).padStart(5)}${pct}`);
  }
  if (items.length > top) out.push(`  … 另有 ${items.length - top} 项 (合计 ${(sub - items.slice(0, top).reduce((s, r) => s + r.ms, 0)).toFixed(0)}ms)`);
}

/** 生成文本报告。totalMs 为整帧墙钟耗时 (由调用方测量, 用于算占比)。 */
export function profFormat(totalMs) {
  const rows = profEntries();
  const out = [];
  out.push('=== WE 渲染阶段耗时剖析 (DSH_WE_PROFILE=1) ===');
  if (totalMs) out.push(`整帧墙钟 ${totalMs.toFixed(0)}ms`);
  for (const [prefix, label] of GROUPS) {
    const items = rows.filter((r) => groupOf(r.phase).prefix === prefix);
    if (!items.length) continue;
    renderGroup(out, items, prefix, label, totalMs);
  }
  // 未匹配任何声明分组的 key 单独兜底显示 —— 否则新增埋点会被静默吞掉 (踩过:
  // pkg-extract 的「合成:*」全部消失, 报告看起来"没有数据")。
  const others = rows.filter((r) => groupOf(r.phase).prefix === '');
  if (others.length) renderGroup(out, others, '', '其它 (未声明分组)', totalMs);
  if (!rows.length) out.push('(无样本 — 确认 DSH_WE_PROFILE=1 且确实走了本渲染器)');
  // 效果输入像素数: 成本主因 (与输出分辨率无关), 决定纹理侧降采样该降到多少
  if (pxAcc.size) {
    const pxRows = [...pxAcc.entries()]
      .map(([k, e]) => ({ k, avg: e.px / e.n, n: e.n, tot: e.px }))
      .sort((a, b) => b.tot - a.tot)
      .slice(0, 15);
    out.push('');
    out.push('── 效果输入纹理尺寸 (成本主因, 与输出分辨率无关) ──');
    for (const r of pxRows) {
      out.push(`  ${r.k.padEnd(38)} 均值 ${(r.avg / 1e6).toFixed(2)} Mpx  n=${String(r.n).padStart(4)}  合计 ${(r.tot / 1e6).toFixed(1)} Mpx`);
    }
  }
  return out.join('\n');
}
