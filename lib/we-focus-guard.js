/**
 * 网页壁纸的**帧级夺焦围栏** —— 一段以文本形式注入进壁纸文档的经典脚本。
 *
 * 现象：播某些网页类壁纸时，DSH 自己的输入框 / 下拉选择框 / 左下角账号菜单每被点一次就
 * 失去焦点（窗口仍在焦点、`relatedTarget` 为 null ⇒ 焦点被搬进了**另一个文档**）。
 * 与点击位置无关、与组件类型有关 —— 只有"必须持有键盘焦点才正常"的那类控件看得出来。
 *
 * 机制（在《鲸鱼计划表》workshopid 3800777313 上静态闭合）：
 *   ① 壁纸层 `pointer-events:none`，鼠标事件由 DSH UI 消费；插件在 window 捕获相把每次真实
 *      mousedown/mousemove 经 `__wp.pushPointer` 注入渲染页（src/live-layer.js），
 *      且只在 `selection.sceneLiveActive` 时发 ⇒ **暂停即停止注入**，这正是
 *      「暂停就恢复」的原因。
 *   ② 严格沙箱下渲染页够不到壁纸文档，控制只能经 web-shim 的 op 通道落到壁纸一侧；shim 用
 *      `elementFromPoint` 命中元素后 `dispatchEvent` 合成 pointer/mouse 事件
 *      （lib/webwallgl/web-shim.js 的 `pushPointer` / `elementFromPoint` / `dispatchEvent`）。
 *      合成事件的 `isTrusted === false`，与用户真点壁纸可区分。
 *   ③ 作者为了在 WE 桌面模式下"让键盘有处可去"，在**捕获相 mousedown** 里调 `window.focus()`
 *      （该壁纸 index.html 中全文件唯一的 `window.focus` 调用点）⇒ 宿主窗口里
 *      **任何位置**点一下，DSH 的 composer / 下拉框就丢焦点。
 *
 * 为什么可以整条废掉：本插件从不把键盘送进壁纸帧 —— web-shim 里 `keydown/keyup/keypress/
 * KeyboardEvent` 零命中，渲染页的 keydown 只用于音频解锁（lib/webwallgl/assets/renderer-*）。
 * 所以壁纸抢到帧级焦点，唯一效果就是**从 DSH 手里把键盘拿走**，而它在 DSH 里本来就收不到按键
 *（作者为此内置了软键盘）。围栏只拦**帧级** `window.focus()`；元素级
 * `HTMLElement.prototype.focus()` 原样放行 —— 壁纸自己的单元格编辑框、模态输入框照常工作，
 * 那是它真正需要的焦点。
 *
 * 实现纪律：
 *  - 注入体是**源码文本**（`weFocusGuardSource()` 用 `Function.prototype.toString` 取下面那个
 *    函数的原文），所以函数体必须**自足**：只碰 `window` 与标准内建，不引用本模块作用域的任何
 *    名字、不用 `import`/`export`（被当成经典脚本执行）。
 *  - 不放进 `lib/webwallgl/`：`test/tools/sync-webwallgl.mjs` 每次上游同步都 `rmSync`
 *    整个目录（vendored 面）。围栏必须是我们自己的字节，故随 `<script data-we-focus-guard>`
 *    注入 —— 与 shim 同一处（`lib/serve.js` 的 `/scene-files` HTML 分支，见该文件 `:460` 起的
 *    HTML 分支与 `:485` 的注入行），两条 web 路径（live 严格沙箱 + 旧链）都吃这一处注入。
 *  - 绝不抛：壁纸文档里任何异常都会毁掉作者脚本，而围栏的意义恰恰是"别让宿主被第三方代码
 *    拖下水"。补丁动作各自 try/catch，失败只体现为 `installed` / `elInstalled === false`。
 *  - 留计数：`window.__weFocusGuard = { calls, blocked, allowed, installed, allow,
 *    elCalls, elLast, elAt, elInstalled }`。
 *    壁纸帧控制台里一眼能看到拦了多少次 —— 这是围栏唯一的自证手段。`allow = true` 是
 *    **逃生门**（给对比测试用，不是用户开关）：置 true 后原函数照旧调用、`allowed` 累加。
 *  - **元素级只记账、不改行为**：`elCalls` / `elLast`（最近一次被 `el.focus()` 的元素 tag）/
 *    `elAt`（该次墙钟毫秒）/ `elInstalled`。为什么要记：上游 issue #148 报的是**周期性**失焦
 *    （0.9–3.6 s，暂停即恢复、且无需任何点击），而帧级围栏与触发方式无关 —— 若这类失焦来自
 *    壁纸自己 `setInterval(() => el.focus(), …)`，`blocked` 不会涨而 `elCalls` 会按那个节奏涨，
 *    两者一比就把"帧级窗口调用"与"元素级定时调用"分开了。**不拦**元素级：壁纸自己的单元格
 *    编辑框 / 模态输入框靠它正常工作（围栏的目的只是别让 DSH 的键盘被拿走，而不是禁掉壁纸的
 *    交互）。这里也刻意不记"是谁调的"（调用栈字符串会拖慢壁纸的每一帧）。
 *
 * 已知残留（不在本围栏射程内）：跨源 WindowProxy 上的 `top.focus()` / `parent.focus()` 无法从
 * 壁纸文档侧改写（同源策略允许调用、禁止改写）；要拦它只能在宿主半拦，代价是与作者页拉锯，
 * 本仓不做。真出现这类壁纸时，`__weFocusGuard.blocked` 与 `elCalls` **都不涨**而症状仍在
 * —— 那就是这个残留（宿主半的被动探针会把它与"焦点落在宿主 body"区分开，见
 * `src/client.js` 的 `installFocusProbe`）。
 */
export function weFocusGuardSource() {
  return '(' + weFocusGuardInstall.toString() + ')();';
}

/** 注入体本身（自足；注释会随源码一起进 HTML，写短） */
function weFocusGuardInstall() {
  var w = window;
  if (w.__weFocusGuard) return;                       // 幂等：同一文档重复注入只装一次
  var guard = { calls: 0, blocked: 0, allowed: 0, installed: false, allow: false,
                elCalls: 0, elLast: '', elAt: 0, elInstalled: false };
  w.__weFocusGuard = guard;
  var raw = null;
  try { raw = w.focus; } catch (e) { raw = null; }
  if (typeof raw !== 'function') return;              // 没有可拦的 focus：如实退场（installed 仍 false）
  var patched = function () {
    guard.calls += 1;
    if (guard.allow) { guard.allowed += 1; return raw.apply(w, arguments); }
    guard.blocked += 1;                               // 帧级夺焦：吞掉，不转交原函数
    return undefined;
  };
  // ① 直接赋值：Window 上的 focus 是原型上的可写操作 ⇒ 赋值产生自有属性并遮蔽它。
  try { w.focus = patched; } catch (e) { /* 只读/访问器：交给 ② */ }
  // ② 赋值没生效（继承来的不可写属性 / 访问器）时改用 defineProperty —— 自有属性的创建
  //    不受继承链约束，所以这条腿覆盖 ① 覆盖不到的形态。
  if (w.focus !== patched) {
    try { Object.defineProperty(w, 'focus', { configurable: true, writable: true, value: patched }); } catch (e) { /* 如实记账 */ }
  }
  guard.installed = w.focus === patched;
  // 元素级：**只记账、不改行为**（原函数照旧拿到同一 this 与参数）。#148 的周期性失焦若来自
  // 壁纸自己的定时器，涨的是 elCalls/elAt 而不是 blocked —— 两者一比即可分开"帧级窗口调用"
  // 与"元素级定时调用"，而放行元素级是刻意的（壁纸自己的编辑框/模态靠它工作）。
  var elProto = null, rawEl = null;
  try { elProto = w.HTMLElement && w.HTMLElement.prototype; rawEl = elProto && elProto.focus; } catch (e) { rawEl = null; }
  if (typeof rawEl === 'function') {
    var patchedEl = function () {
      guard.elCalls += 1;
      try { guard.elLast = this && this.tagName ? String(this.tagName) : '?'; guard.elAt = Date.now(); } catch (e) { /* 记账失败照样放行 */ }
      return rawEl.apply(this, arguments);
    };
    try { elProto.focus = patchedEl; } catch (e) { /* 只读/访问器：交给 defineProperty */ }
    if (elProto.focus !== patchedEl) {
      try { Object.defineProperty(elProto, 'focus', { configurable: true, writable: true, value: patchedEl }); } catch (e) { /* 如实记账 */ }
    }
    guard.elInstalled = elProto.focus === patchedEl;
  }
}
