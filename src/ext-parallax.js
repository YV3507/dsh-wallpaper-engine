/**
 * ext-parallax.js — 「扩展」页签**三号模块**（3D 效果）的扩展岛。
 *
 * ══ 它是什么 ══════════════════════════════════════════════════════════════════
 * 一个**模块描述符**（形状 `{ id, title, desc?, render? }`，契约写在 src/panel-tabs.js 的
 * `extensionModules()` 上方）：panel-tabs 只负责把它排在「扩展」页签里，具体的控件与文案
 * 全在本文件。视差本体在 `src/parallax-layer.js`（只有变量与事件、不建 DOM），设置项的
 * 真源在 `lib/settings-schema.js` 的 10 个 `parallax*` 键。
 *
 * 契约：
 *   需要的外界：`ctx`（由 `src/client.js` 在 `renderExtensionsTab({...})` 的调用点组装）——
 *     `sel` + 一组具名 `on*` 处理器；扁平可用的渲染助手 `React` / `weT` / `switchRow` /
 *     `SliderRow`（后三个住在 `src/client.js` 正文，函数体内调用没问题）。
 *   对外提供：`PARALLAX_EXTENSION_MODULE`（注册表项）。
 *
 * 不变量：
 *   · **模块不得自己写设置 / 发通知 / 持有状态**（panel-tabs 的注册表契约）：本文件里
 *     不出现任何设置写入 / 通知发送 / `selection` 读取，一个动作一个 `on*` 处理器。
 *   · **只从一个参数取外界**：`renderParallaxIsland(ctx)`，函数体第一行解构。
 *   · 参数的可调范围与默认值**不在这里写死**：`SliderRow` 的 min/max/step 与设置白名单的
 *     KINDS 一致（改范围要同时看 lib/settings-schema.js —— 那份是唯一真源）。
 *   · 关掉总开关时只画总开关 + 一句说明（避免"关着还能拖参数"的错觉）。
 *   · 控件顺序 = 先定"整块动多远"、再定"谁跟着动"：背景缓动距离 → 吉祥物跟随 →
 *     界面元素跟随 → 界面跟随距离 → 四个区域距离 → 缓动平滑（观感）。**方向不是设置项**：壁纸与吉祥物
 *     的口径是"关于屏幕中心对称"（光标在右上 ⇒ 整块往左下）、界面整块与壁纸**同向**
 *     （用户口径 m01371："希望输入框和背景同向运动" ⇒ 像镜头横移，近处多走一点），
 *     要换向改 src/parallax-layer.js 的 `PARALLAX_DIRECTION` / `PARALLAX_UI_SIGN`。
 *   · 界面那一组的距离 = **一个总倍率 + 四个区域倍率**（用户口径 m01915-①：「各个区域的缓动
 *     距离支持单独调节」）：区域滑杆只在「界面元素跟随」打开时才画，四个值都乘在总倍率上
 *     （出厂 1 / 1.5 / 0.6 / 0.4 ⇒ 与上一个版本逐像素同观感；真源 lib/settings-schema.js）。
 *     它动的是真实界面，所以默认关。
 */

/**
 * 扩展岛：总开关 → 背景缓动距离 → 吉祥物跟随 → 界面元素跟随 → 界面跟随距离 → 四个区域距离
 * → 缓动平滑。
 * @param {{sel:object}} ctx 见文件头契约
 */
function renderParallaxIsland(ctx) {
  const { sel, onParallaxEnabled, onParallaxBg, onParallaxMascot, onParallaxUi, onParallaxUiDepth,
    onParallaxUiChatDepth, onParallaxUiComposerDepth, onParallaxUiSidebarDepth,
    onParallaxUiBubbleDepth, onParallaxSmooth } = ctx;
  const on = sel.parallaxEnabled === true;
  const ui = on && sel.parallaxUi === true;
  return React.createElement(React.Fragment, null,
    switchRow(weT("启用 3D 效果"), on, onParallaxEnabled, { key: "parallax-on" }),
    React.createElement("span", { className: "we-picker__hint", key: "parallax-what" },
      weT("光标移动时，壁纸与吉祥物沿屏幕中心的对称方向轻轻偏移；界面整块默认不动（要一起动就打开下面的「界面元素跟随」）")),
    // 距离的单位是**最长对角线的百分比**（用户口径）：光标走完一整条对角线时，该层挪 pct% 个对角线。
    // 壁纸额外放大 1 + pct/100 补边（见 src/parallax-layer.js 文件头）。
    on && SliderRow(weT("背景缓动距离"), 0, 10, 0.1, sel.parallaxBg, onParallaxBg, "%", "parallax-bg",
      { tooltip: weT("光标走完一整条对角线时，壁纸挪动的距离占该对角线的百分比（壁纸会同时放大同样多，免得边上露出底色）") }),
    on && switchRow(weT("吉祥物跟随"), sel.parallaxMascot !== false, onParallaxMascot,
      { key: "parallax-mascot", hint: weT("挂件也按「背景缓动距离」一起挪") }),
    // 界面整块（输入卡片 / 会话文本区 / 侧栏）：动的是真实界面 ⇒ 单独一个开关、默认关。
    // 四组的倍率就在下面四行（真源 lib/settings-schema.js；层里的 PARALLAX_GROUP_* 只作缺值兜底）。
    on && switchRow(weT("界面元素跟随"), sel.parallaxUi === true, onParallaxUi,
      { key: "parallax-ui", hint: weT("输入卡片、会话文本区（连里面的用户气泡一起）与侧栏作为整块跟着挪：文字与底下的玻璃一起动") }),
    ui && SliderRow(weT("界面跟随距离"), 0, 6, 0.5, sel.parallaxUiDepth, onParallaxUiDepth, "%",
      "parallax-ui-depth",
      { tooltip: weT("光标走完一整条对角线时，会话文本区挪动的距离占该对角线的百分比 —— 这是界面四组的总倍率，下面四个区域距离都乘在它身上") }),
    // 四个区域各自的倍率（用户口径 m01915-①：各区域的缓动距离单独调）。
    // 0 = 这一档完全不跟；1 = 与「界面跟随距离」相同；出厂值 = 改设置项之前那份写死的倍率。
    ui && SliderRow(weT("会话文本区距离"), 0, 3, 0.1, sel.parallaxUiChatDepth, onParallaxUiChatDepth,
      "", "parallax-ui-chat-depth",
      { tooltip: weT("长回复所在的整块文本区的距离倍率：1 = 与「界面跟随距离」相同") }),
    ui && SliderRow(weT("输入卡片距离"), 0, 3, 0.1, sel.parallaxUiComposerDepth,
      onParallaxUiComposerDepth, "", "parallax-ui-composer-depth",
      { tooltip: weT("底部输入卡片的距离倍率：比文本区大一点（出厂 1.5）看着最靠前、纵深更明显") }),
    ui && SliderRow(weT("侧栏距离"), 0, 3, 0.1, sel.parallaxUiSidebarDepth, onParallaxUiSidebarDepth,
      "", "parallax-ui-sidebar-depth",
      { tooltip: weT("左侧栏的距离倍率（出厂 0.6）：它比文本区更靠后，所以默认走得更少") }),
    ui && SliderRow(weT("用户气泡距离"), 0, 3, 0.1, sel.parallaxUiBubbleDepth, onParallaxUiBubbleDepth,
      "", "parallax-ui-bubble-depth",
      { tooltip: weT("你的消息气泡在会话文本区之外再多走的倍率（出厂 0.4）：0 = 气泡只跟着文本区一起动") }),
    on && SliderRow(weT("缓动平滑"), 0, 98, 1, sel.parallaxSmooth, onParallaxSmooth, "%", "parallax-smooth",
      { tooltip: weT("0 = 立刻跟手，越大越柔和（跟得越慢、停下后还会飘一小段才归位）") }),
  );
}

/** 「扩展」页签的三号模块（注册表项；`id` 是 React key，改它会让面板重挂一次）。
 *  `title` / `desc` 与另外两个模块同一条理由写成 getter（渲染时才取译文，见 panel-tabs 的契约）。 */
const PARALLAX_EXTENSION_MODULE = {
  id: 'parallax',
  get title() { return weT("3D 效果"); },
  get desc() { return weT("光标移动时，壁纸与吉祥物沿屏幕中心的对称方向轻轻偏移，界面整块则与壁纸同向轻挪（视差纵深）"); },
  render: renderParallaxIsland,
};

export { PARALLAX_EXTENSION_MODULE, renderParallaxIsland };
