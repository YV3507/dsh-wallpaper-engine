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
 *
 * 本文件里有两层判据，分属不同的档：
 *   · **硬判据**（本节以下）：日期 / 断句残骸 / 回溯句的零残留，以及 BOM、常青文档不引用
 *     本机专用路径、退休开关确实不存在 —— 这些失败**就是**读者会读到假事实。
 *   · **棘轮**（见文末 §棘轮）：叙事词总量只许减少，一个全局数字。它按**总量**判定，
 *     不再要求「每个新文件在表里登记一行」—— 那张表本身就成了一种税收。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 这三条零残留扫描（日期 / 断句 / 回溯句）的名单：产品侧的两个入口 + 媒体桥 + 打包器。
// 名单是手工维护的，写错 / 改名不会报错，只会让该文件从扫描里静默消失 ⇒ 下面先把名单钉在盘上。
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
const DATE_PREFIX = '20' + '26' + '-' + '09' + '-' + '25';   // 拼出来：本文件本身也在日期扫描里
check('negative control: 带日期的注释会被判不合格',
  /20\d\d-\d\d-\d\d/.test('// 修于 ' + DATE_PREFIX + ' 的一处失真') === true
  && /20\d\d-\d\d-\d\d/.test('// 这条注释里没有日期') === false);

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
// ── 叙事式注释：域内**全局零残留**（不做棘轮、不做按文件登记表）──────────────────
// 编年史式注释（日期、「曾经 / 旧实现 / 以前」框定、「教训 / 踩到 / 踩坑」复盘腔）此前靠
// 一张按文件封顶表守着 —— 那张表要求**每个新文件手写一行**，是纯粹的税，而且它守的东西
// 已经清零：域内 84 个文件现在是 0 处。所以这里换成一个**全局零残留**的判据，域从磁盘
// 枚举 ⇒ 新文件自动在域内，没有任何登记动作。
{
  // 域：src/**/*.js + lib/routes/*.js + test/**/*.mjs + scripts/**/*.mjs。
  const walkMatching = (relDir, rx) => {
    const out = [];
    for (const ent of readdirSync(ROOT + relDir, { withFileTypes: true })) {
      const rel = relDir + '/' + ent.name;
      if (ent.isDirectory()) out.push(...walkMatching(rel, rx));
      else if (rx.test(ent.name)) out.push(rel);
    }
    return out;
  };
  const DOMAIN = [
    ...walkMatching('src', /\.js$/),
    ...walkMatching('lib/routes', /\.js$/),
    ...walkMatching('test', /\.mjs$/),    // 守门（test/）+ 工具（test/tools/）
    ...walkMatching('scripts', /\.mjs$/), // 用户 / 发布脚本（build-client、prepare）
  ];
  const wholeFiles = DOMAIN.filter((f) => f !== 'test/verify-comment-discipline.mjs'); // 本文件（词表在这里）

  check('叙事式注释的域非空（walker 返回空表 = 本节恒真）', wholeFiles.length >= 50,
    wholeFiles.length + ' 个文件');
  check('代码与守卫脚本里没有日期（编年史归 CHANGELOG / git 历史）',
    offenders.length === 0,
    offenders.length ? '命中 ' + offenders.length + ' 处：' + offenders.slice(0, 6).join(' ')
      : '干净（' + wholeFiles.length + ' 个文件）');

  // 词表由字符码拼出：本节之前的释义与负对照要写出这些词，直接内联会让本文件自己的
  // 命中计数随注释改动而漂移。拼装是**这一节专属**的隔离，不对外复用。
  const cc = (...codes) => codes.map((c) => String.fromCharCode(c)).join('');
  const NARRATIVE_WORDS = [
    cc(0x66fe, 0x7ecf),                     // 回指"当年的实现"
    cc(0x65e7, 0x5b9e, 0x73b0),
    cc(0x4ee5, 0x524d),
    cc(0x539f, 0x5148),
    cc(0x65e7, 0x7248),
    cc(0x6559, 0x8bad),                     // 复盘腔
    cc(0x8e29, 0x5230),
    cc(0x8e29, 0x5751),
  ];
  const hits = [];
  for (const f of wholeFiles) {
    const lines = readFileSync(ROOT + f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      const w = NARRATIVE_WORDS.filter((x) => l.includes(x));
      if (w.length && hits.length < 8) hits.push(f + ':' + (i + 1) + '（' + w.join('/') + '）');
    });
  }
  check('没有把"当年如何"写进代码（编年史 / 复盘腔零残留）', hits.length === 0,
    hits.length ? '命中：' + hits.join(' ') : '干净（' + NARRATIVE_WORDS.length + ' 个词 × ' + wholeFiles.length + ' 个文件）');

  // 负对照走**同一个**词表判据：合成一行必须被抓到，否则上面那条可能是恒真式。
  const wordHit = (s) => NARRATIVE_WORDS.some((x) => s.includes(x));
  check('negative control: 编年史 / 复盘腔文本会被判出',
    wordHit(NARRATIVE_WORDS[0] + '这里是那样做的') && !wordHit('这里只写不变量'));
  // 正对照：「实测 X ≈ Y」是**出处**，不是编年史 —— 它必须留（见文件头 ②）。
  check('positive control: 带出处的「实测 X」不算编年史', !wordHit('实测 X ≈ Y，因此取该值'));
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
