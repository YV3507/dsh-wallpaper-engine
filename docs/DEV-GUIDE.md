# 二次开发指南（Dev guide）

> **本文是"怎么加一个 X"的配方**：每节给**落点、必须同步改的地方、以及改错了会怎样**。
> 结构性规则（新文件放哪、边界在哪）在 [`MODULE-LAYOUT.md`](./MODULE-LAYOUT.md) —— 本文不重复，只引用。
> 系统全貌在 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；为什么这么设计在 [`adr/`](./adr/)。

## 目录

- [0. 开工前：命令与环境](#0-开工前命令与环境)
- [1. 加一条宿主路由](#1-加一条宿主路由)
- [2. 加一个设置项](#2-加一个设置项)
- [3. 加一块浏览器端代码](#3-加一块浏览器端代码)
- [4. 加一条守卫](#4-加一条守卫)
- [5. 改文件头注释（任何改动都要做）](#5-改文件头注释任何改动都要做)
- [6. 提交前的自查清单](#6-提交前的自查清单)

---

## 0. 开工前：命令与环境

```sh
npm ci                # 本地取工具链（CI 故意不装依赖，见 CONTRIBUTING.md）
npm run build         # 改过 src/** 之后必须跑：重新生成 lib/client.js
npm run verify        # 硬档（挡 PR）：真机行为 / 发布面 / 平台契约 / 打包面
npm run verify:docs   # 软档（只出声）：模块布局 / 可达性 / 退役线 / 声明孤儿
npm run verify:all    # = build + verify + verify:docs + smoke
npm run smoke         # 节点级行为冒烟
```

**链条每档分别有哪些守卫、失败意味着什么**，真源是 `package.json` 的 `verify` / `verify:docs` /
`smoke` 三个脚本 —— **别把条数记在这里**（会漂）。分档判据见 [`TEST-LAYOUT.md`](./TEST-LAYOUT.md)。

**改 `lib/**` 必须重启 DSH**；改 `src/**` 必须 `npm run build`。这两条不对称，是本仓最常见的操作失误。

---

## 1. 加一条宿主路由

**落点**：`lib/routes/<族>.js`。只有当这一族**已经成规模**时才单独成文件，否则就近放在已有的族里
（准入条件见 `MODULE-LAYOUT.md` §4）。

**形状**（以诊断族为样板 —— 注册返回值必须推进 `disposers`，否则卸载 / HMR 后路由仍挂着）：

```js
export function registerDiagRoutes(webServer, c) {
  const { disposers, appendDiagLine, log, notice, base: BASE } = c;
  disposers.push(webServer.register({
    kind: 'exact',                 // 或 'prefix'
    path: `${BASE}/your-route`,
    handler: (req, res) => { /* … */ },
  }));
}
```

**必须同步改的地方**：

| 改什么 | 为什么 |
|---|---|
| `lib/index.js` 里把依赖传进这个族的 context 对象 | 路由模块**不得继承**门面的 import（守卫 `verify-module-layout` 的『路由模块不得"继承" lib/index.js 的 import』会判） |
| `package.json` 的 `files`（若新增了文件） | 留在 `lib/` 的一切都会被打进包；P1 会判 |
| 文档：**不用手写路径表** | 路由索引是生成物 |

**改错了会怎样**：

- **忘了推进 `disposers`** ⇒ 卸载 / HMR 后路由仍挂着已释放的处理器。没有守卫能替你发现这一条，
  请按样板抄。
- **忘了 `files`** ⇒ 装上就崩（`ERR_MODULE_NOT_FOUND`），`verify-package-files` 会红。
- **在门面里直接写 handler** ⇒ 门面继续膨胀，那条『路由模块不得继承门面 import』的守卫会判。

**路由索引怎么更新**：

```sh
node test/tools/host-route-index.mjs --write   # 重算并写入 docs/ROUTE-INDEX.md
```

它是**生成物**：`test/verify-route-index.mjs` 会重算并逐字节比对，手改必红。
注意索引有一列是**「守卫提及」次数** —— 增删守卫会改变它，此时必须重算（这是**预期**行为，不是回归）。

---

## 2. 加一个设置项

**落点**：`lib/settings-schema.js` —— 它是设置的**唯一真源**，宿主与客户端都从它派生
（见 [`adr/0002`](./adr/0002-settings-schema-single-source.md)）。

**要做两件事，都在同一个文件里**：

1. 把一个默认值加进 `DEFAULTS`（只做默认值、不持久化的加进 `DEFAULTS_ONLY`）；
2. 把校验规则加进 `KINDS`（`num` 带 min/max、`enum` 带枚举表、`boolTrue` / `boolFalse` …）。

枚举白名单也定义在这个文件里（如 `FPS_CAP_VALUES`），**不要**在客户端或宿主各抄一份。

**必须记住的三件事**：

- **这个文件必须浏览器安全**：不得出现 `import` / `require` / Node API / 顶层副作用 ——
  它会被**构建期内联**给浏览器，且构建期逐条断言。
- **`min` / `max` 只在 `KINDS` 里定义一次**。如果滑条的实际可拖范围与 schema 范围不一致（本仓
  确有这种情形），**在实现处用常量**（如 `ROPE_SCALE_MIN` + `CONSTS` 解析表），不要在面板里写死数字。
- **不要另写一张 UI 表**：面板按真源渲染。抄一张表就是多一个会与真源脱钩的副本。

**改错了会怎样**：漏登记一个键 ⇒ 客户端设置被**静默丢弃**（症状是"改了没生效、重启回默认"）。
这是本仓历史上真实发生过的一类 bug，正是单一真源要消掉的东西。

**文档**：设置默认值与范围**一律不写进文档**，只写"见控件本身 / 见 `lib/settings-schema.js`"。

---

## 3. 加一块浏览器端代码

**落点**：`src/<语义名>.js`（默认平铺；建子目录有准入门槛，见 `MODULE-LAYOUT.md` §4）。

**两条硬约束**：

1. **必须登记进 `scripts/build-client.mjs` 的 `INLINE_MODULES`**，并给 `markers` 锚点：

```js
{
  file: 'src/your-module.js',
  why: '一句话说明它为什么独立成文件（给未来的自己看）',
  markers: ['const YOUR_EXPORT = ', 'function yourHelper('],   // 缺任一 ⇒ 构建硬失败
}
```

2. **模块内不得出现** `import` / `require(` / `export default` / `process.*` / `__dirname` / `__filename`
   —— 构建期逐条断言（且**先剥注释再判**）。

**改错了会怎样**：

- **忘了登记** ⇒ **不报错**，只是这个文件永远不进产物，调用点一到运行期就是 `ReferenceError`。
  这是本路线最危险的失效模式（本仓踩过一次）。
- **顶层读宿主状态** ⇒ 你的模块被注入在 bundle **顶部**（早于 `src/client.js` 正文），
  顶层读正文里的 `const` 会撞 **TDZ**。**若你的字符串/模板要引用另一个常量的值，把那个常量声明
  提到使用点之前**（本仓在 `src/live-layer.js` 的 `LIVE_FAIL_LABELS` 上踩过这个坑）。
- **名字与正文或别的模块冲突** ⇒ 构建期机器提取后断言，冲突即失败。

**模块头要写契约**：需要什么外界、对外提供什么。因为这一侧**没有 `import`**，契约注释是唯一的依赖说明。

**`src/**` 的注释会随包发给用户** ⇒ 涉及行数 / 体积这类会漂的量，写**复算命令**而不是写数字。

---

## 4. 加一条守卫

**放哪**（真源是 [`TEST-LAYOUT.md`](./TEST-LAYOUT.md) §约定）：

| 类型 | 落点 |
|---|---|
| 结构性守卫（`verify-*.mjs`） | `test/` |
| 节点级行为冒烟（`*-smoke.mjs`） | `test/` |
| 真浏览器端到端（`e2e-*.mjs`） | `test/`（不进 verify 链） |
| 手动诊断 / 分析 / 生成工具 | `test/tools/`（**没有 CI 消费者**） |
| 构建与发布期脚本 | `scripts/`（只放用户与发布流程真的会跑的） |

**先决定档位**（判据见 `TEST-LAYOUT.md`）：失败意味着**用户会撞上** ⇒ 硬档（`verify`）；
守的是**仓库内务** ⇒ 软档（`verify:docs`）。拿不准放软档。

**必须做到**：

- **正 / 负对照成对**：负对照要证明"坏输入会被判出"，否则判据可能是恒真式。
- **走同一个判据函数**：对照与本体共用函数，而不是另写一段"应该失败"的近似逻辑。
- **扫描面要非空**：断言"域内零残留"之前，先断言域非空 —— 否则 walker 返回空表时判据恒真。
- **剥注释要字符串感知**：用 `test/tools/js-text.mjs`，**不要**用朴素块注释正则
  （它不认字符串与行注释，会把真实代码静默吃掉；`verify-module-layout` 有一节专门禁它）。
- **新工具要在 `TEST-LAYOUT.md` 里点名**（同一条守卫的另一节判"不许有没人知道的工具"）。

**⚠️ 不要加"守散文"的守卫。** 判据若去正则匹配**文档里的措辞或数字**，它守的就是编辑而不是腐化：
句子一改写，判据就从"复算"退化成"守住那两句话"。这条边界由
[`adr/0006`](./adr/0006-comment-discipline-as-written-convention.md) 定死，`MODULE-LAYOUT.md` §7
还专门留了一张"已从本表撤除"的清单记载它。

---

## 5. 改文件头注释（任何改动都要做）

**能写在代码旁的规则不单写文档。** 改行为时，同一次提交里要更新**对应文件的头注释**：

- **不变量**（必须 / 不得）—— 写进文件头；
- **契约**（需要什么外界、对外提供什么）—— 写进文件头，尤其 `src/**`（那一侧没有 `import`）；
- **实测出处**（"实测 X ≈ Y"）—— 留在**被实测的那个位置附近**，这样它是可核对的出处；
- **不要写**：日期、「曾经 / 旧实现」框定、踩坑复盘。

**决策**（有备选方案、有人付了代价的取舍）写进 [`adr/`](./adr/)，不写进文件头；
格式与"什么不该写"见 [`adr/README.md`](./adr/README.md)。

---

## 6. 提交前的自查清单

- [ ] 改过 `src/**` 吗？→ `npm run build`，并把 `lib/client.js` **同一个提交**带上。
- [ ] 改过 `lib/**` 吗？→ 说明"需重启 DSH 生效"。
- [ ] 新增了 `lib/` 下的文件吗？→ 加进 `package.json` 的 `files`。
- [ ] 新增了 `src/**` 文件吗？→ 登记进 `INLINE_MODULES` 并给 `markers`。
- [ ] 新增了设置项吗？→ 只改 `lib/settings-schema.js`，没另写 UI 表。
- [ ] 新增了路由吗？→ `node test/tools/host-route-index.mjs --write` 重算索引。
- [ ] 新增了守卫吗？→ 正负对照成对；工具已进 `TEST-LAYOUT.md`；没有去守文档散文。
- [ ] 改过文档吗？→ **没有新增会漂的数值**（改成了符号引用或复算命令）。
- [ ] 写进文档的每个路径 / 每个符号名**都真实存在**（这条最常出错）。
- [ ] `npm run verify` 全绿；`npm run verify:docs` 的结论**没有比改动前更差**。
