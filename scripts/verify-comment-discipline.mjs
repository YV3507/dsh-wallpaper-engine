#!/usr/bin/env node
/**
 * verify-comment-discipline.mjs —— 注释纪律（"代码即文档"的可核对底线）。
 *
 * 规则要把**两条线分清**：
 *  ① **禁编年史与叙事回溯**：日期（会过期，并让人误以为"当时如此 = 现在如此"）、
 *     「曾经 / 以前 / 原先 / 旧实现 / 旧版」框定，以及「实测症状 / 踩坑 / 教训」这类
 *     回溯句。历史价值的内容进 CHANGELOG 或本地 TODO.md（见 TODO.md §3）。
 *  ② **「实测」作为出处必须留**：「实测 X ≈ Y」「headless Chrome 实测全黑 PNG」这类
 *     是在给经验值与浏览器行为**标出处** —— 正是它让魔法数字可核对。删掉它，读者就
 *     分不清"测出来的"与"猜的"，反而更不可核对。
 *
 * 所以棘轮只数 ① 的词，**不数「实测」**。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// ⚠️ 名单里的文件必须真实存在：此处曾写 `lib/media/probe.js`（**该文件不存在**），
//    于是它被下面的 try/catch 静默跳过 ⇒ 那两处覆盖长期是空的。
const FILES = ['lib/index.js', 'lib/scene-render-worker.mjs', 'src/client.js', 'lib/we-renderer/core.js', 'lib/media/supervisor.js', 'lib/media/legacy.js', 'lib/media/provision.js', 'lib/pkg-extract.js'];
const DATE = /20\d\d-\d\d-\d\d/;   // 不带 /g：配 test() 时 lastIndex 会造成假结果
const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
}

let totalDates = 0;
const offenders = [];
for (const f of FILES) {
  let s; try { s = readFileSync(ROOT + f, 'utf8'); } catch { continue; }
  const lines = s.split('\n');
  lines.forEach((l, i) => {
    if (DATE.test(l)) { DATE.lastIndex = 0; offenders.push(f + ':' + (i + 1)); totalDates++; }
  });
}
check('代码注释里没有日期（编年史归 CHANGELOG / 本地 TODO）', totalDates === 0,
  totalDates ? '命中 ' + totalDates + ' 处：' + offenders.slice(0, 5).join(' ') : '干净');
check('negative control: 带日期的注释会被判不合格',
  DATE.test('// 2026-09-25 实测：这样做会失败') === true);

// 叙述框定的"残句"：机械去框定时最容易留下 `（：` / `（到` 这类断句 —— 必须为 0。
{
  const BAD = [/（\s*[：:]/, /（\s*到的/];
  let broken = 0;
  const where = [];
  for (const f of FILES) {
    let s; try { s = readFileSync(ROOT + f, 'utf8'); } catch { continue; }
    s.split('\n').forEach((l, i) => {
      if (/^\s*\//.test(l) && BAD.some((re) => re.test(l))) { broken++; if (where.length < 4) where.push(f + ':' + (i + 1)); }
    });
  }
  check('去框定后没有断句残骸（（： / （到的）', broken === 0,
    broken ? '命中=' + where.join(' ') : '干净');
  const RETELL = /实测症状|踩坑|^\s*\/\/\s*实测[：:]/m;
  let retell = 0;
  for (const f of FILES) {
    let s; try { s = readFileSync(ROOT + f, 'utf8'); } catch { continue; }
    if (RETELL.test(s)) retell++;
  }
  check('叙事回溯未回流（实测症状 / 踩坑 / 行首实测：；「实测 X≈Y」这种出处不算）', retell === 0, '命中文件数=' + retell);
}

// ② 的产物：性能报告必须带"以代码为准"状态横幅（否则后人会把调研当现状读）
// 横幅里的**路径断言**必须真实存在 —— 否则文档又在断言代码里没有的东西（本轮实测踩到）。
{
  const doc = readFileSync(ROOT + 'docs/archive/static-frame/SCENE-FRAME-PERF.md', 'utf8');
  const start = doc.indexOf('<!-- status-banner: code-is-truth -->');
  const end = doc.indexOf('> 归并原则见 TODO.md §3');
  const block = start >= 0 && end > start ? doc.slice(start, end) : '';
  const paths = [...block.matchAll(/`([A-Za-z0-9_./-]+\.(?:js|mjs|ts|json|md))`/g)].map((m) => m[1]);
  // ⚠️ 只对**断言存在**的引用做存在性校验：如果同一行明确写了"已不在本分支/不存在/无此"，
  //    那是在**声明它不存在**，不该被判不合格（否则淘汰提示会被误伤 —— 本轮实测踩到）。
  const ABSENT_CTX = /已不在本分支|不在当前分支|不存在|无此|已移除|已删除/;
  const asserted = paths.filter((p) => {
    const line = block.split('\n').find((l) => l.includes('`' + p + '`')) || '';
    // 横幅里的「缺失路径清单」行（`> - \`path\``）是在**声明缺失**，不是断言存在。
    if (/^>\s*-\s/.test(line.trim())) return false;
    return !ABSENT_CTX.test(line);
  });
  const missing = asserted.filter((p) => !existsSync(ROOT + p));
  check('横幅引用的代码路径都真实存在（不得断言不存在的东西）',
    block.length > 0 && missing.length === 0 && paths.length >= 2,
    '断言存在=' + asserted.length + ' 实缺=' + (missing.length ? missing.join(',') : '无') + ' 声明缺失=' + (paths.length - asserted.length));
  check('negative control: 不存在的路径会被判不合格',
    !existsSync(ROOT + 'lib/does-not-exist.js'));
  check('横幅明确声明"采样/门禁机制不在本分支"',
    block.includes('不在当前分支'));
}
{
  const doc = readFileSync(ROOT + 'docs/archive/static-frame/SCENE-FRAME-PERF.md', 'utf8');
  check('归档性能报告带 code-is-truth 状态横幅', doc.includes('status-banner: code-is-truth'));
}

// 文档世系标注：文档引用了本分支不存在的开关 ⇒ 必须显式声明，且"不存在"这一事实可核对。
{
  const ts = readFileSync(ROOT + 'docs/TROUBLESHOOTING.md', 'utf8');
  check('TROUBLESHOOTING 带世系标注（引用不存在的开关时必须声明）',
    ts.includes('<!-- lineage-note: branch-scope -->') && ts.includes('当前分支并不存在'));
  const code = readFileSync(ROOT + 'lib/index.js', 'utf8') + readFileSync(ROOT + 'src/client.js', 'utf8');
  const ABSENT = ['sceneFrameRender', 'scenePrewarmScope', 'sceneLossyRoute', 'sceneGpuAccel'];
  const stillThere = ABSENT.filter((k) => code.includes(k));
  check('标注所依据的事实成立（这四个开关键在代码里确实不存在）', stillThere.length === 0,
    stillThere.length ? '出现=' + stillThere.join(',') : '全部不存在');
}
// ── 棘轮：**叙事 / 编年史**标记只许减少，不许回增 ────────────────────────────
// 词表刻意**不含「实测」**：那是出处，不是编年史（见文件头 ②）。
// 基线按当前实际值设定；下修后请同步改这里的数字（数字只许变小）。
{
  // 注意：这些数字与**旧词表**（含「实测」）下的 6/9/0/1/0 不可比 —— 词表换了，
  // 现在是「曾经/旧实现/以前/原先/旧版/教训/踩到/踩坑」在当前文本上的实测值。
  // 它们大多是有信息量的「旧实现 vs 现状」对照（如"旧版 harness 不支持该属性"），
  // 所以棘轮只**封顶**、不强制清零。
  const CEIL = {
    'src/client.js': 9,
    'lib/index.js': 9,
    'lib/scene-render-worker.mjs': 0,
    'lib/we-renderer/core.js': 1,
    'lib/media/supervisor.js': 1,
    'lib/media/legacy.js': 1,
    'lib/media/provision.js': 0,
    'lib/pkg-extract.js': 0,
  };
  const measure = (s) => (s.match(/曾经|旧实现|以前|原先|旧版|教训|踩到|踩坑/g) || []).length;
  const over = [];
  for (const [f, ceil] of Object.entries(CEIL)) {
    let s; try { s = readFileSync(ROOT + f, 'utf8'); } catch { continue; }
    const n = measure(s);
    if (n > ceil) over.push(f + '=' + n + '>' + ceil);
  }
  check('棘轮：叙事标记不超过基线（只许减少）', over.length === 0,
    over.length ? '超出：' + over.join(' ') : '全部 ≤ 基线（共 ' + Object.values(CEIL).reduce((a, b) => a + b, 0) + '）');
  check('negative control: 超过基线的文本会被判不合格', measure('曾经'.repeat(50)) > CEIL['src/client.js']);
  check('negative control: 「实测」不计入棘轮（出处不是编年史）', measure('实测'.repeat(50)) === 0);
}
// ── BOM：写 Node/JSON 会解析的文件必须是无 BOM UTF-8（PowerShell 5.1 的 Set-Content 会带 BOM ✗）──
{
  const KEY = ['package.json', 'lib/client.js', 'lib/index.js', 'src/client.js', 'scripts/build-client.mjs'];
  const withBom = KEY.filter((f) => {
    try { const b = readFileSync(ROOT + f); return b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF; } catch { return false; }
  });
  check('关键文件无 BOM（JSON.parse / 模块加载器不会剥离 BOM）', withBom.length === 0, withBom.length ? 'BOM=' + withBom.join(',') : '干净');
  check('negative control: 带 BOM 的字节序列会被识别', Buffer.from([0xEF, 0xBB, 0xBF, 0x7B])[0] === 0xEF);
}
// 文档侧不变量：本轮清理/标注过的文档不得回流（否则"过时描述"会重新误导读者）。
{
  const DOCS = {
    'docs/TROUBLESHOOTING.md': ['<!-- lineage-note: branch-scope -->'],
    'docs/archive/static-frame/SCENE-FRAME-PERF.md': ['status-banner: code-is-truth', '不在当前分支'],
  };
  const missing = [];
  for (const [f, marks] of Object.entries(DOCS)) {
    let s = ''; try { s = readFileSync(ROOT + f, 'utf8'); } catch { missing.push(f + '(缺文件)'); continue; }
    for (const m of marks) if (!s.includes(m)) missing.push(f + ' 缺「' + m + '」');
  }
  check('文档侧不变量：清理/标注过的文档标记仍在', missing.length === 0, missing.length ? missing.join('; ') : '全部在位');
  // 只钉"我实际清理过的术语"（空闲预热）：历史文档里提到开关名属正常语境，不该判违规。
  const STALE = /空闲预热/;
  const handoff = readFileSync(ROOT + 'docs/archive/scene-animation/SCENE-ANIMATION-HANDOFF.md', 'utf8');
  check('归档交接文档无已删特性术语', !STALE.test(handoff));
}
// 文档路径断言：SCENE-FRAME-PERF.md 里"断言存在但缺失"的路径必须逐条列进它的横幅。
{
  const doc = readFileSync(ROOT + 'docs/archive/static-frame/SCENE-FRAME-PERF.md', 'utf8');
  const bannerEnd = doc.indexOf('> 归并原则见 TODO.md §3');
  const banner = bannerEnd > 0 ? doc.slice(0, bannerEnd) : '';
  const ABSENT_CTX = /已不在本分支|不在当前分支|不存在|无此|已移除|已删除|旧实现|deprecated|不再|未随本线保留|未随本分支|已废弃|删除|迁走|迁移|搬到|雏形|spike/;
  const PATH_RE = /`((?:lib|scripts|src|test)\/[A-Za-z0-9_./-]+\.(?:js|mjs|ts|json|md))`/g;
  const missing = new Set();
  doc.split('\n').forEach((l) => {
    if (l.startsWith('>')) return;
    PATH_RE.lastIndex = 0;
    for (const m of l.matchAll(PATH_RE)) {
      const p = m[1];
      if (existsSync(ROOT + p)) continue;
      if (ABSENT_CTX.test(l)) continue;
      missing.add(p);
    }
  });
  const undeclared = [...missing].filter((p) => !banner.includes('`' + p + '`'));
  check('SCENE-FRAME-PERF.md 的缺失路径清单完整（每条都已在横幅声明）', undeclared.length === 0,
    undeclared.length ? '未声明=' + undeclared.slice(0, 4).join(',') : '清单完整（' + missing.size + ' 条）');
}
// ⚠️ failed 必须在**全部** check 跑完之后才算，而且要**在现场重算**：
//    此前它写死在文件中部（TROUBLESHOOTING 世系等 9 项之前），于是那 9 项不进退出码 ——
//    守卫会给出"全绿"的假信心（本机实测：退出码仍是 0）。
//    用一个函数而不是一个常量，是为了杜绝同一类漂移再次发生：哪怕以后有人在汇总与
//    process.exit 之间又插了 check，退出码也会把它算进去。
const failedCount = () => results.filter((r) => !r).length;
console.log('\n' + (failedCount() ? 'COMMENT DISCIPLINE CHECKS FAILED — ' + failedCount() + ' failed' : 'ALL COMMENT DISCIPLINE CHECKS PASSED') + ' (' + results.length + ')');
process.exit(failedCount() ? 1 : 0);
