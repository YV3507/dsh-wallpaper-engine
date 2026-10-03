/**
 * glass-panel.js — 「玻璃 UI」节的**渲染器**（纯渲染 + 显式 ctx）。
 *
 * 为什么单开一个文件（wip §10.13）：这一段原在 `src/panel-tabs.js`（1700+ 行、七个页签）里，
 * 而它与其余页签**只共享模块级纯助手** —— `React` / `SliderRow` / `switchRow` / `swatchRow` /
 * `weT` / `GLASS_COLOR_PRESETS` 都是**顶层声明**（`src/client.js` 等），构建期内联进同一工厂
 * 作用域 ⇒ 抽出来**不需要任何 ctx 传参样板**，`renderAppearanceTab` 照旧按名字调用即可。
 *
 * 契约（与 `src/panel-tabs.js` 文件头同一条，不在此重复解释）：
 *   · **只读** ctx —— 不得写 `selection` / ctx 别名指向的东西 / 模块级状态；
 *   · **动作经具名处理器** —— 写设置一律走 `on*`（由 `src/client.js` 提供），本文件只回答"画什么"；
 *   · 浏览器安全（无 import / require / Node API），且不得有顶层可执行语句读 client.js 的 const。
 *
 * 渲染源是**注册表驱动**的：`GLASS_CHILDREN`（`lib/settings-schema.js` 的登记表）+ `childGlassKey()`
 * 决定每个子项有哪些参数、叫什么 ⇒ 这里**不硬编码四项**（硬编码正是"面板渲染死旋钮"的来源，
 * 见 wip §10.12：四个子项曾多出 5 个没人读的键、左侧栏那节还多一行连 schema 键都不存在的滑杆）。
 */
/**
 * 「玻璃 UI」节 —— 全局四件套 + 两级子 UI 开关（高级配置）。
 *
 * 结构（见 wip 文档 §5.2 / §5.3，用户口径）：
 *   玻璃 UI
 *   ├─ 全局：玻璃颜色 · 玻璃透明度 · 雾化 · 玻璃保真度 · 对话栏玻璃保真度
 *   └─ 高级（不进简化配置）
 *      ├─ [子 UI 玻璃]        每个子 UI 要不要玻璃（= 它的显示前提）
 *      └─ [子 UI 独立配置]     总开关：给"已开启玻璃"的子项逐项开独立
 *         └─ 每个已开启玻璃的子项：
 *              [独立配置]  ⇒ 打开后展开它自己的四件套
 *
 * ⚠️ 耦合关系（用户口径）：**「子 UI 玻璃」对应项关闭时，它的「独立配置」不显示。**
 *    两级都是开关，且前者是后者的显示前提。
 * ⚠️ 「左侧栏覆盖」**不在**本节的子项里：它的"关"是**恢复背景**（那列回到壁纸原样），
 *    而本节的"关"是**恢复纯色/原生外观** —— 语义不同，它是乙类，独立成项留在「细节」。
 */
function renderAppearanceGlassSection(ctx) {
  const {
    onBlur, onGlassAlpha, onGlassChildParam, onGlassColor, onGlassFidelity,
    onToggleChildIndependent, onToggleGlassChild, setTransient,
    childIndependentOn, sel,
  } = ctx;
  // 总开关往返用的快照键（瞬态字段，**不落盘**：它只是"上一次展开时是什么样"）。
  const snapKey = "glassChildrenSnapshot";
  const children = ((typeof GLASS_CHILDREN !== "undefined" && GLASS_CHILDREN) || [])
    // ⚠️ 排除 `panelOff` 的子项：乙类（左侧栏）**不进这一层** ——
    //    它已有自己的总开关「左侧栏覆盖」，而它的"独立配置"耦合在那一项下面
    //    （见本文件「细节」节）。它留在登记表里只为生成 schema 键。
    .filter((c) => !c.panelOff);
  // i18n 词表：**就地包 weT(...)** —— 不能用 `weT(cn.label)` 那种属性访问。
  // i18n 判据是**文本扫描**：它只认出现在 `weT(` 实参里的中文；属性访问看不见 ⇒
  // 词条会全成孤儿、文本也进不了"裸中文"检查。所以词表每一项都直接过 weT。
  // （放在渲染函数内而非模块级：weT 依赖当前语言，必须每次渲染重取。）
  // 两侧靠 `id` 对齐；下面有兜底把"漏了哪个 id"当场画出来（比静默无标签好）。
  const CHILD_CN = {
    settingsWindow: {
      label: weT("设置窗口玻璃"), hint: weT("整个设置窗口（含全部原生分区）"),
      indep: weT("设置窗口玻璃·独立配置"), color: weT("设置窗口玻璃·玻璃颜色"),
      alpha: weT("设置窗口玻璃·玻璃透明度"), blur: weT("设置窗口玻璃·雾化"),
      fidelity: weT("设置窗口玻璃·玻璃保真度"),
    },
    conversation: {
      label: weT("对话框玻璃"), hint: weT("输入卡片 / 消息气泡 / 工具弹卡"),
      indep: weT("对话框玻璃·独立配置"), color: weT("对话框玻璃·玻璃颜色"),
      alpha: weT("对话框玻璃·玻璃透明度"), blur: weT("对话框玻璃·雾化"),
      fidelity: weT("对话框玻璃·玻璃保真度"),
    },
    leftSidebar: {
      label: weT("左侧栏玻璃"), hint: weT("宿主原生左栏（会话列表 / 工作区那一列）"),
      indep: weT("左侧栏玻璃·独立配置"), color: weT("左侧栏玻璃·玻璃颜色"),
      alpha: weT("左侧栏玻璃·玻璃透明度"), blur: weT("左侧栏玻璃·雾化"),
      fidelity: weT("左侧栏玻璃·玻璃保真度"),
    },
    floaters: {
      label: weT("浮层玻璃"), hint: weT("插件自己的更新提示 / 壁纸仓库抽屉"),
      indep: weT("浮层玻璃·独立配置"), color: weT("浮层玻璃·玻璃颜色"),
      alpha: weT("浮层玻璃·玻璃透明度"), blur: weT("浮层玻璃·雾化"),
      fidelity: weT("浮层玻璃·玻璃保真度"),
    },
  };
  // ⚠️ 用户口径（两级耦合）：
  //   · 「子 UI 玻璃」**关** ⇒ 下面所有子项开关都不显示（这一层整体收起）。
  //   · 每个子项自己的开关关 ⇒ **只有它**的「独立配置」及四件套不显示。
  // 所以这里不再有"总独立配置"开关：**「独立配置」直接归属它所属的那个子项开关下方**。
  //
  // ⚠️ 总开关的作用是**记住并恢复**各项状态，不是"把所有项都设成 true"：
  //    · 关：全部子项置 false（= 全部回到原生不透明纯色）+ 记下关之前的状态快照
  //    · 开：恢复快照（没有快照才全开）
  //   若开时一律全开，用户"只关掉设置窗口"的意图会在一次总开关往返后被静默抹掉。
  const glassOn = (id) => !!(sel.glassChildren && sel.glassChildren[id] === true);
  const childRows = [];
  const childOnCount = children.filter((c) => glassOn(c.id)).length;
  const masterOn = childOnCount > 0;
  if (masterOn) for (const c of children) {
    const cn = CHILD_CN[c.id];
    // 登记表与词表必须一一对应：漏一个就整项无标签（比 ReferenceError 更隐蔽）。
    if (!cn) { childRows.push(React.createElement("div", { className: "we-picker__hint", key: "gc-missing-" + c.id }, weT("内部错误：这个子界面缺少文案"))); continue; }
    const on = glassOn(c.id);
    // ① 每个子项的「玻璃」开关
    childRows.push(switchRow(cn.label, on, (e) => onToggleGlassChild(c.id, e.target.checked), {
      key: "gc-" + c.id,
      hint: cn.hint,
      tooltip: weT("打开后这个子界面走玻璃配方（玻璃颜色 / 透明度 / 雾化 / 保真度）；关闭则这个界面回到原生不透明纯色外观"),
    }));
    // ② ⚠️ 该项玻璃关 ⇒ 它的「独立配置」不显示（玻璃都不吃就无从"覆盖"）。
    if (!on) continue;
    const indep = !!(childIndependentOn && childIndependentOn(c.id));
    childRows.push(switchRow(cn.indep, indep, (e) => onToggleChildIndependent(c.id, e.target.checked), {
      key: "gi-" + c.id,
      hint: weT("用这一项自己的釉层参数覆盖全局"),
      tooltip: weT("打开后**紧接在本行下方**出现这一项自己的独立配置，**完全覆盖**上面的全局配置；关闭则回到继承全局"),
    }));
    // ③ 独立配置关着 ⇒ 不显示它自己的四件套（默认就是关 ⇒ 默认跟随全局）
    if (!indep) continue;
    const P = (param) => childGlassKey(c.id, param);
    // ⚠️ 按登记表的 `params` 渲染，**不硬编码四项** —— 不是每个子项都拿得到全部参数。
    //    `fidelity` 只有 `conversation` 有：它的面纱有专属的 `--we-chat-readability-*`，
    //    而共享面纱的面受 F2a / F1c 约束、**逐面保真度不可达**（见 wip §4.14）。
    //    硬编码会让那两个面多出一个"点了没反应"的旋钮 —— 正是要消灭的那类死开关。
    if (c.params.blur !== undefined) {
      childRows.push(SliderRow(cn.blur, 0, 60, 1,
        sel[P("blur")], (v) => onGlassChildParam(c.id, "blur", v),
        sel[P("blur")] + "px", "gc-blur-" + c.id));
    }
    if (c.params.transparency !== undefined) {
      childRows.push(SliderRow(cn.alpha, 0, 100, 5,
        sel[P("transparency")], (v) => onGlassChildParam(c.id, "transparency", v),
        sel[P("transparency")] + "%", "gc-alpha-" + c.id));
    }
    if (c.params.fidelity !== undefined) {
      childRows.push(SliderRow(cn.fidelity, 0, 100, 5,
        sel[P("fidelity")], (v) => onGlassChildParam(c.id, "fidelity", v),
        sel[P("fidelity")] + "%", "gc-fid-" + c.id));
    }
    if (c.params.color !== undefined) {
      childRows.push(swatchRow(cn.color, GLASS_COLOR_PRESETS,
        sel[P("color")], (v) => onGlassChildParam(c.id, "color", v), { key: "gc-color-" + c.id }));
    }
  }
  return React.createElement(React.Fragment, null,
  React.createElement("div", { className: "we-picker__section" },
    React.createElement("div", { className: "we-picker__section-head" },
      React.createElement("span", { className: "we-picker__section-label" }, weT("玻璃 UI")),
    ),
    // ── 全局四件套 ──
    // 玻璃颜色: the settings-window glass BASE tint. Defaults keep the stock
    // look (white light / deep navy dark); picking any preset or a custom
    // color tints the whole window glass in BOTH themes.
    swatchRow(weT("玻璃颜色"), GLASS_COLOR_PRESETS, sel.glassColor, onGlassColor, { key: "glass-color" }),
    SliderRow(weT("玻璃透明度"), 0, 100, 5, sel.glassAlpha, onGlassAlpha, sel.glassAlpha + "%"),
    // 「雾化」= 原「玻璃」滑块：控制的只有**模糊半径**（雾面深度），饱和度是解耦的
    // 常量材料属性（见 GLASS_SATURATE）。
    // ⚠️ 覆盖面的实测口径（`.test-cache/blur-selectors.mjs` 复算，按规则头归面）：
    //    它喂的 `--we-blur` 被这些面消费 —— 对话栏一族（输入卡片 / 气泡 / 工具弹卡）、
    //    **左侧栏覆盖**（`data-we-left-sidebar` 那列的 `::before`）、**设置窗口**、
    //    插件自身浮层（更新提示 / 仓库面板）。
    //    而**侧栏**（dsh-better-sidebar 与右栏面板）走的是它**自己的** `--we-sidebar-blur`
    //    （由「侧栏模糊」管）—— 那才是唯一不吃本项的面。
    SliderRow(weT("雾化"), 0, 60, 1, sel.blur, onBlur, sel.blur + "px", "glass-frost", {
      tooltip: weT("玻璃面板（对话栏卡片、左侧栏、设置窗口、插件浮层）的模糊半径 —— 越大越像磨砂玻璃；色彩饱和度不随本滑块变化。侧栏有自己的「侧栏模糊」，不受本项影响"),
    }),
    // 玻璃保真度（默认 100 = 完整可读性红线）：唯一的「颜色 vs 可读」权衡旋钮。
    // 100 = 玻璃色经亮度钳制保正文 ≥4.5:1（深色压暗 / 浅色提亮的现状）；拉低 =
    // 釉色向用户原色线性回退（单调，中间档不会更黑/更白）+ 地板层覆盖度同比例
    // 减薄，正文在极端壁纸上可读性让位；0 = 原色直出不钳制。数学入口
    // weClampSurfaceColor 第三参 + --we-glass-fidelity。
    SliderRow(weT("玻璃保真度"), 0, 100, 5, sel.glassFidelity, onGlassFidelity, sel.glassFidelity + "%", "glass-fidelity", {
      tooltip: weT("100 = 完整可读性红线（默认）：自定义玻璃色经亮度钳制，正文对比度始终 ≥4.5:1 —— 深色主题下颜色被压暗、浅色主题下被提亮。拉低后颜色更贴你选的原色，但正文在极端明暗的壁纸上可能看不清；看不清字时把本项拉回 100，或按「看不清字三步」调节。"),
    }),
    // ⚠️ 这里原本有独立的「对话栏玻璃保真度」旋钮（`chatGlassFidelity`）。**已撤除**
    //    （用户口径）：既然有了「对话框玻璃·独立配置」，同一个"对话栏的保真度"就有两个
    //    入口了 —— 那是两个旋钮控同一件事。现在它**只**由「对话框玻璃·独立配置」下的
    //    「对话框玻璃·玻璃保真度」提供，存储键**复用** `chatGlassFidelity`（D2：不新建
    //    平行键），所以老配置的值不会丢。
    // ── 高级：子 UI 玻璃总开关（不进简化配置）──
    // 一个总开关决定"这一层要不要展开"。它**不是**"要不要玻璃"的真相来源 ——
    // 关掉它 = 全部子项回到原生不透明纯色，同时下面整层收起；重新打开时
    // **恢复各项原来的开关状态**（快照存在 sel 的瞬态字段里，不落盘）。
    switchRow(weT("子 UI 玻璃"), masterOn,
      (e) => {
        const on = e.target.checked;
        if (!on) {
          // 关：先记快照再全关，这样重新打开能回到用户原来的组合。
          setTransient(snapKey, Object.assign({}, sel.glassChildren));
          for (const c of children) onToggleGlassChild(c.id, false);
        } else {
          const s = sel[snapKey];
          for (const c of children) onToggleGlassChild(c.id, s ? s[c.id] === true : true);
          setTransient(snapKey, null);
        }
      }, {
      key: "glass-children-master",
      hint: weT("哪些子界面走玻璃（高级 · 默认全开）"),
      tooltip: weT("这一层是「哪些面吃玻璃」的高级清单，不进简化配置。关掉它 = 下面每个子界面都回到**原生不透明纯色**（全关即整个界面都是原生黑白纯色），同时这一层控件整体收起；重新打开时会**恢复各项原来的开关**。"),
    }),
    ...childRows,
  ),
  );
}

export { renderAppearanceGlassSection };
