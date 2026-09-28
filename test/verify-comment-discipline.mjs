#!/usr/bin/env node
/**
 * verify-comment-discipline.mjs —— 注释纪律（"代码即文档"的可核对底线）。
 *
 * 规则要把**两条线分清**：
 *  ① **禁编年史与叙事回溯**：日期（会过期，并让人误以为"当时如此 = 现在如此"）、
 *     「曾经 / 以前 / 原先 / 旧实现 / 旧版」框定，以及「实测症状 / 踩坑 / 教训」这类
 *     回溯句。历史价值的内容进 CHANGELOG 或 git 历史（写作纪律见 docs/README.md §写作纪律）。
 *  ② **「实测」作为出处必须留**：「实测 X ≈ Y」「headless Chrome 实测全黑 PNG」这类
 *     是在给经验值与浏览器行为**标出处** —— 正是它让魔法数字可核对。删掉它，读者就
 *     分不清"测出来的"与"猜的"，反而更不可核对。
 *
 * 所以棘轮只数 ① 的词，**不数「实测」**。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// ⚠️ 名单里的文件必须真实存在：名单是手工维护的，写错/改名不会报错，只会让该文件
//    从扫描里消失（`catch { continue; }` 静默跳过）⇒ 那几条覆盖长期是空的。
const FILES = ['lib/index.js', 'src/client.js', 'lib/media/supervisor.js', 'lib/media/legacy.js', 'lib/media/provision.js', 'lib/pkg-extract.js'];
/** 存在性判据：名单/覆盖表里的路径必须先在盘上找到 —— 找不到就是"覆盖静默归零"。 */
const ghostsOf = (names) => names.filter((f) => !existsSync(ROOT + f));
const DATE = /20\d\d-\d\d-\d\d/;   // 不带 /g：配 test() 时 lastIndex 会造成假结果
const results = [];
function check(name, ok, detail) {
  results.push(Boolean(ok));
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
}

// 名单先钉在盘上：只要有一个键不存在，下面三条基于 FILES 的扫描（日期 / 断句 / 回溯）
// 就会对那个文件静默空转，而扫描本身仍然全绿。
{
  const ghostFiles = ghostsOf(FILES);
  check('扫描名单的文件都真实存在（幽灵路径 = 那几条扫描对它是空的）', ghostFiles.length === 0,
    ghostFiles.length ? '不存在：' + ghostFiles.join(', ') : FILES.length + ' 个路径都在盘上');
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
check('代码注释里没有日期（编年史归 CHANGELOG / git 历史）', totalDates === 0,
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
  const end = doc.indexOf('> 写作纪律见 ../../README.md');
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

// ── 入库文档不得指向**本机专用**的未跟踪路径（P3-10）─────────────────────────
// 病灶：本仓的写作纪律与取证配方曾只住在一个不入库的根目录待办里，而入库文档与守卫都指向它
// ⇒ 读者（GitHub / npm 上的人）打不开。规则一旦只住在未入库文件里，它对仓库就等于不存在。
// 规矩：**读者打不开的东西，入库文档不指向它**。
//
// 豁免面是**显式且有据**的：`docs/archive/**` 是历史记录（顶部横幅已声明不反映现行实现），
// 其价值正是那些本机取证线索；`docs/wip/**` 是进行中的过程记录。把它们一起判红只会逼人改写
// 历史记录，而不是修好现行面 —— 所以同时也断言这两个目录里**确有**这类提及（豁免为空 = 该删）。
//
// 守卫脚本自己不在扫描面里：它必须把被禁路径**拼出来**才能搜它们（同 verify-retired-lines 对
// 自己的处理）。本条判据只面向**文档**。
{
  const DENIED = [
    ['TODO.md', '仓库根的本地待办（本机 .git/info/exclude）—— 规则必须住在入库位置'],
    ['.integration-notes/', '本机研究与过程记录（不入库）'],
    ['_refs/', '本机逆向参考副本（不入库）'],
    ['.test-cache/', '本机构建 / 取证缓存（不入库）'],
    ['we-static-frame/', '已迁出的独立仓库（本机 .git/info/exclude）'],
    ['scene-layers-out/', '本机渲染验证产物（不入库）'],
    ['scripts/reverse/', '本机逆向工具（.gitignore 覆盖）'],
    ['scripts/out/', '本机渲染输出（.gitignore 覆盖）'],
    ['scripts/lwe-ref/', '本机 lwe 参考实现（.gitignore 覆盖）'],
  ];
  // 只在**根相对**位置命中：`./archive/static-frame/TODO.md` 是另一个（**已入库**的）文件，不算。
  const hit = (text, p) =>
    new RegExp('(?<![\\w./-])' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text);

  const EXPLICIT = ['README.md', 'README.en.md', 'README.beginner.md', 'CONTRIBUTING.md'];
  const SCAN = [...EXPLICIT, ...readdirSync(ROOT + 'docs', { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => 'docs/' + e.name)].filter((f) => existsSync(ROOT + f)).sort();

  const violations = [];
  for (const f of SCAN) {
    const text = readFileSync(ROOT + f, 'utf8');
    for (const [p] of DENIED) if (hit(text, p)) violations.push(f + ' → ' + p);
  }
  check('扫描面覆盖常青入库文档（防 walker 返回空表）', SCAN.length >= 8, SCAN.length + ' 个文档');
  check('常青文档不引用本机专用路径（清单是棘轮，只许缩小）', violations.length === 0,
    violations.length ? '命中 ' + violations.length + ' 处：' + violations.slice(0, 4).join(' | ')
      : '干净（' + SCAN.length + ' 个文档 × ' + DENIED.length + ' 条路径）');

  const walkMd = (dir, out = []) => {
    for (const e of readdirSync(ROOT + dir, { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walkMd(rel, out);
      else if (e.name.endsWith('.md')) out.push(rel);
    }
    return out;
  };
  const exemptFiles = [...walkMd('docs/archive'), ...walkMd('docs/wip')];
  let exemptHits = 0;
  for (const f of exemptFiles) {
    const text = readFileSync(ROOT + f, 'utf8');
    for (const [p] of DENIED) if (hit(text, p)) exemptHits++;
  }
  check('豁免不空转：docs/archive/ 与 docs/wip/ 里确有这类提及（历史 / 过程记录，见上）',
    exemptFiles.length >= 5 && exemptHits > 0,
    exemptFiles.length + ' 个文档 / ' + exemptHits + ' 处提及');

  // 负对照：同一条判据对合成文本有牙。
  const SYNTH = DENIED.map(([p]) => '详见 `' + p + '`。').join('\n');
  check('negative control: 合成文本里的每条被禁路径都被判出', DENIED.every(([p]) => hit(SYNTH, p)));
  // 正对照：**已入库**的同名文件不得被误伤（`docs/archive/static-frame/TODO.md` 真的在库里）。
  check('positive control: 入库的同名文件不被误伤',
    !hit('见 [static-frame/TODO.md](./archive/static-frame/TODO.md)', 'TODO.md'));
  // 横幅指向的章节必须真实存在（否则指针又烂成"指向不存在的东西"）。
  check('归档横幅指向的写作纪律章节真实存在',
    readFileSync(ROOT + 'docs/README.md', 'utf8').includes('## 写作纪律'));
}

// 文档世系标注：文档引用了本分支不存在的开关 ⇒ 必须显式声明，且"不存在"这一事实可核对。
{
  const ts = readFileSync(ROOT + 'docs/TROUBLESHOOTING.md', 'utf8');
  check('TROUBLESHOOTING 带世系标注（引用不存在的开关时必须声明）',
    ts.includes('<!-- lineage-note: branch-scope -->') && ts.includes('当前分支并不存在'));
  // "这四个开关不存在"必须在**所有可能承载设置键的文件**上成立：少扫一个文件，这条断言
  // 在那个文件上就是恒真。设置单一真源是 lib/settings-schema.js，客户端侧还有页签与
  // 持久化层 —— 键只可能在这五处之一（两个入口 + 三个归属文件）。
  const SETTING_OWNERS = ['lib/index.js', 'src/client.js', 'lib/settings-schema.js', 'src/panel-tabs.js', 'src/persistence.js'];
  const present = SETTING_OWNERS.filter((f) => existsSync(ROOT + f));
  check('退休开关的扫描面完整（键可能落在 schema / 页签 / 持久化层，不能只看两个入口）',
    present.length === SETTING_OWNERS.length,
    '扫描 ' + present.length + '/' + SETTING_OWNERS.length + ' 个文件' + (present.length === SETTING_OWNERS.length
      ? '' : '；缺：' + SETTING_OWNERS.filter((f) => !present.includes(f)).join(', ')));
  const code = present.map((f) => readFileSync(ROOT + f, 'utf8')).join('\n');
  const ABSENT = ['sceneFrameRender', 'scenePrewarmScope', 'sceneLossyRoute', 'sceneGpuAccel'];
  const stillThere = ABSENT.filter((k) => code.includes(k));
  check('标注所依据的事实成立（这四个开关键在代码里确实不存在）', stillThere.length === 0,
    stillThere.length ? '出现=' + stillThere.join(',') : '全部不存在（扫了 ' + present.length + ' 个归属文件）');
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
    'src/client.js': 7,
    'lib/index.js': 9,
    // 抽出来的模块按**当前实际值**钉住（只许减少）。styles.js 的 2 处是随样式表逐字搬过来的
    // 既有散文（CSS 注释里的"旧版"对照），不是新写的编年史。
    'src/styles.js': 2,
    'src/transcode.js': 0,
    'src/live-layer.js': 1,
    'src/media-prep.js': 0,
    'src/panel-tabs.js': 0,
    // P3-11 阶段 1：选择器模型层（判定 + 派生 + 分页）拆出去，从 0 起钉。
    'src/picker-model.js': 0,
    // P3-11 阶段 2：选择器模态框的渲染器拆出去，从 0 起钉。
    'src/picker-modal.js': 0,
    // P3-11 阶段 3：「壁纸属性」面板的渲染器拆出去，从 0 起钉。
    'src/picker-props-panel.js': 0,
    'src/persistence.js': 0,
    // F3 阶段 2：字体集通道（新文件从 0 起钉）。
    'src/fontset-store.js': 0,
    // F3 阶段 3：字体集编辑器面板（新文件从 0 起钉）。
    'src/fontset-editor.js': 0,
    'lib/media/supervisor.js': 1,
    'lib/media/legacy.js': 1,
    'lib/media/provision.js': 0,
    'lib/pkg-extract.js': 0,
    // P2-11 拆出去的路由族：新模块从 0 起钉（拆一个补一个，别让新文件落在棘轮之外）。
    'lib/routes/diag.js': 0,
    // F3 阶段 1：字体集族（list/get/put/delete/activate/import/export），从 0 起钉。
    'lib/routes/fontsets.js': 0,
    'lib/routes/now-playing.js': 0,
    'lib/routes/upload.js': 0,
    'lib/routes/scene-frame.js': 0,
    'lib/routes/scene-serve.js': 0,
    // 客户端侧抽出的模块：按**当前实际值**钉住（只许减少）。非零的两处是随源码逐字搬过来的
    // 既有散文（一处讲 json() 优先的由来，一处是饱和度耦合的术语对照），仍是回溯框定、
    // 不是出处，所以基线不为 0；改动那两行时必须同步下修这里的数字。
    'src/api-client.js': 1,
    'src/effects.js': 1,
    'src/we-cond.js': 0,
    'src/font/apply.js': 0,
    'src/font/color-roles.js': 0,
    'src/font/components.js': 0,
    'src/font/typography.js': 0,
    // scripts/**/*.mjs 同样是棘轮的域：守卫脚本里的散文也会被后人当现状读，与源码同口径。
    // 非零的 13 个文件按**实测量**钉住 —— 它们绝大多数是随被测源码逐字搬过来的既有散文
    // 或术语对照，不是新写的编年史 ⇒ 只封顶、不清零；清理后同步下修这里的数字。
    // 非零文件：build-client / e2e-web-media-origin / host-route-index / verify-api-client /
    //   verify-client / verify-comment-discipline（本文件：词表与负对照必须写出那些词）/
    //   verify-component-fonts / verify-contracts / verify-host-paint-scope / verify-media-bridge /
    //   verify-route-index / verify-scene-live / verify-scene。
    'test/tools/analyze-host-apply.mjs': 0,
    'test/tools/audit-import-closure.mjs': 0,
    // P3-23 的手动审计工具（无 CI 消费者）：从 0 起钉
    'test/tools/audit-fixture-coverage.mjs': 0,
    'scripts/build-client.mjs': 1,
    'test/tools/diagnose-web-blank.mjs': 0,
    'test/e2e-web-media-origin.mjs': 5,
    // P3-11 阶段 0b：选择器上传区的守卫（新文件从 0 起钉）
    'test/verify-picker-upload.mjs': 0,
    // P3-11 阶段 1：选择器模型层的守卫（用例表 + 负对照 + 跨层对拍），从 0 起钉。
    'test/verify-picker-model.mjs': 0,
    // P3-11 阶段 3：「壁纸属性」面板的守卫（可达性 + 控件分支 + 标记等价 golden），从 0 起钉。
    'test/verify-picker-props.mjs': 0,
    'test/verify-client-sync.mjs': 0,
    'test/tools/host-route-index.mjs': 1,
    'scripts/prepare.mjs': 0,
    'test/tools/sync-webwallgl.mjs': 0,
    'test/verify-api-client.mjs': 2,
    'test/verify-client.mjs': 4,
    'test/verify-comment-discipline.mjs': 32,
    // 日志分级守卫：从 0 起钉（新文件；它的散文只讲判据，不讲编年史）。
    'test/verify-logging.mjs': 0,
    // F3 字体集守卫（阶段 0 的前置网）：从 0 起钉。
    'test/verify-fontset.mjs': 0,
    'test/verify-component-fonts.mjs': 2,
    'test/verify-contracts.mjs': 1,
    'test/verify-glass-compositing.mjs': 0,
    'test/verify-host-paint-scope.mjs': 3,
    'test/verify-ledger.mjs': 0,
    'test/verify-media-bridge.mjs': 2,
    'test/verify-module-layout.mjs': 0,
    'test/verify-package-files.mjs': 0,
    'test/verify-package-publish.mjs': 0,
    'test/verify-playback-controls.mjs': 0,
    'test/verify-reachability.mjs': 0,
    'test/verify-readability.mjs': 0,
    'test/verify-retired-lines.mjs': 0,
    'test/verify-route-index.mjs': 1,
    'test/verify-scene-live.mjs': 8,
    'test/verify-scene.mjs': 1,
    'test/verify-softrender.mjs': 0,
    'test/verify-theme-layer.mjs': 0,
    'test/verify-transcode-state.mjs': 0,
    'test/verify-types.mjs': 0,
    // `test/` 的节点级冒烟也同域（它此前不在棘轮域里，是这次目录重整才纳进来的）：
    // 按**实测量**钉住，非零的是随被测源码搬过来的既有散文 ⇒ 只封顶，清理后同步下修。
    'test/rotation-smoke.mjs': 1,
    'test/rotation-live-smoke.mjs': 0,
    'test/rotation-prepared-leak-smoke.mjs': 3,
    'test/live-frame-backfill-smoke.mjs': 3,
    'test/live-frame-async-identity-smoke.mjs': 3,
    // F3 阶段 2：客户端字体集载入通道的冒烟（新文件从 0 起钉）。
    'test/fontset-load-smoke.mjs': 0,
  };
  const measure = (s) => (s.match(/曾经|旧实现|以前|原先|旧版|教训|踩到|踩坑/g) || []).length;

  // 覆盖表是手工维护的 ⇒ 两条独立的牙：①表里的键必须在盘上存在且可读；②盘上的文件必须在表里。
  // 缺①：改名/删除后旧键留着，那条覆盖静默归零；缺②：新抽出的模块根本没人量它。
  const ghosts = ghostsOf(Object.keys(CEIL));
  const blind = [];
  const over = [];
  for (const [f, ceil] of Object.entries(CEIL)) {
    let s = null;
    // 读失败必须**记账**（存在性另有一条断言），不许 continue 了事：那正是覆盖静默归零的形态。
    try { s = readFileSync(ROOT + f, 'utf8'); } catch { blind.push(f); continue; }
    const n = measure(s);
    if (n > ceil) over.push(f + '=' + n + '>' + ceil);
  }
  const blindDetail = (ghosts.length ? '不存在：' + ghosts.join(', ') + ' ' : '')
    + (blind.length ? '读不到：' + blind.join(', ') : '');
  check('棘轮名单里的文件都真实存在且可读（幽灵键 / 读不到 = 该条覆盖静默归零）',
    ghosts.length === 0 && blind.length === 0,
    blindDetail || Object.keys(CEIL).length + ' 个键都在盘上且可读');
  check('negative control: 同一个存在性判据能点出幽灵键',
    ghostsOf(['lib/routes/diag.js', 'lib/does-not-exist.js']).join() === 'lib/does-not-exist.js'
    && ghostsOf(['lib/routes/diag.js']).length === 0);

  // 覆盖面**从磁盘枚举**（不是手抄第二份名单）：棘轮的域 = src/**/*.js + lib/routes/*.js
  // + scripts/**/*.mjs，每个文件都必须逐条在表里，否则"棘轮只许减少"对它是空的。
  const walkMatching = (relDir, rx) => {
    const out = [];
    for (const ent of readdirSync(ROOT + relDir, { withFileTypes: true })) {
      const rel = relDir + '/' + ent.name;
      if (ent.isDirectory()) out.push(...walkMatching(rel, rx));
      else if (rx.test(ent.name)) out.push(rel);
    }
    return out;
  };
  const uncoveredIn = (list, table) => list.filter((f) => !(f in table));
  const REQUIRED = [
    ...walkMatching('src', /\.js$/),
    ...walkMatching('lib/routes', /\.js$/),
    ...walkMatching('test', /\.mjs$/),   // 守门（test/）+ 工具（test/tools/）
    ...walkMatching('scripts', /\.mjs$/), // 用户/发布脚本（build-client、prepare）
  ];
  const uncovered = uncoveredIn(REQUIRED, CEIL);
  check('棘轮覆盖全部 src/**/*.js、lib/routes/*.js、test/**/*.mjs 与 scripts/**/*.mjs（新文件必须进表）',
    uncovered.length === 0 && REQUIRED.length >= 50,
    '覆盖 ' + (REQUIRED.length - uncovered.length) + '/' + REQUIRED.length
      + ' 个文件（实测 56 = 14 src + 5 路由 + 35 test + 2 scripts；断言地板 50）'
      + (uncovered.length ? '；未登记：' + uncovered.join(', ') : ''));
  // 负对照用**纯合成**清单（不掺 REQUIRED）：它测的是判据本身，不该因为真实域恰好有漏项而变色。
  check('negative control: 同一个覆盖判据会点名未登记的合成文件',
    uncoveredIn(['src/synthetic-a.js', 'src/synthetic-new-module.js'], { 'src/synthetic-a.js': 0 }).join()
      === 'src/synthetic-new-module.js'
    && uncoveredIn(['src/synthetic-a.js'], { 'src/synthetic-a.js': 0 }).length === 0);

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
  const bannerEnd = doc.indexOf('> 写作纪律见 ../../README.md');
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
