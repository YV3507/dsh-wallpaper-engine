/**
 * fontset-editor.js — 「字体集」编辑器面板（F3 阶段 3）：**纯渲染 + 意图回调**。
 *
 * 为什么单独一个模块、而且只做渲染：面板要能被判据**驱动**（点「切换」是否真的调切换、
 * 点「删除」是否先过 confirm）—— 渲染与副作用分开之后，挂载台给一组记录用的回调就能把
 * "哪个按钮对应哪个意图"钉死；真正的网络调用住在 `src/fontset-store.js`。
 * 这与 `src/picker-props-panel.js` 的分工同形（P3-11 的做法）。
 *
 * 契约：`renderFontSetEditor(ctx)`；`ctx` 里是**这一屏用到的一切**：
 *   · `fontSets`        宿主清单 `[{ id, name, origin, active, overrides?, broken? }]`
 *   · `activeId`        当前活动集 id（清单里的 `active` 也一致；这里显式再给一份便于渲染）
 *   · `loading` / `error`  载入中 / 可判定的失败文案（空串 = 没问题）
 *   · `editingId` / `draftName` / `newName`  三个**瞬态**字段（改名与新建的输入框状态；
 *     它们住在 `selection` 里、由 client 侧 setTransient 维护 —— 与 `selection.editing` 同一手法）
 *   · `onActivate(id)` / `onRefresh()` / `onDelete(id)` / `exportUrl(id)` / `onImport(file)`
 *   · `onEdit(id)` / `onDraftName(v)` / `onRenameCommit(id)` / `onCancelEdit()`
 *   · `onCreate()` —— **不带名字**：新集的名字由客户端生成（面板不再先问一句），
 *     用户随时可以用「重命名」改；两个按钮做同一件事的形态见下。
 * 对外提供：`renderFontSetEditor`（唯一的导出）。
 *
 * 导出为什么是**普通链接**（`<a download>`，不是 blob、也不是自己弹框）：这正是 DSH 自己的做法 ——
 * `@deepseek-ai/dsh-session-log-export` 的客户端把宿主下载路由交给浏览器下载管理器
 * （`document.createElement("a")` + `download` + `click()`）。在 DSH Desktop（Electron）里，
 * 应用会话**没有任何** `will-download` 拦截（唯一那处在登录会话上，而且是 `preventDefault`），
 * 于是走 Electron 默认下载流程 = **系统「另存为」对话框**。自己造一套保存通道只会与平台分叉。
 *
 * 不变量（都有守卫）：
 *   · **来源不在界面上露出**：随包 / 用户层是**实现细节**，用户面对的只是"一份份字体集"。
 *     `origin` / `overrides` 仍然照读，但只用于**能力**判定（能不能删、删下去是什么语义），
 *     一个字都不显示。
 *   · **发布物删不掉**：`origin === 'builtin'` 且未被覆盖时**不渲染删除按钮**（宿主也会拒）；
 *     **活动集**那一行也不出删除（要先切走 —— 界面上不摆必然报错的按钮）。
 *   · **被改过的那一份，删除按钮的语义是「恢复原样」**（同一个动作、按语义换标签：只说效果 ——
 *     删掉改动之后这一份回到它原本的样子 —— 不说来源）。
 *   · **读不懂的行不能用**：`broken` 的行禁用「使用」与「重命名」，但**保留删除**
 *     （删掉覆盖/坏文件是唯一的出路），并显示**可判定的原因**。
 *   · **删除必须过 confirm**：先答 false ⇒ 一个字节都不发。
 *   · 载入中与失败态各自可见：失败时给的是**原因**，不是"什么都没发生"。
 */

/**
 * 导入用的隐藏 file input（与自定义画面的导入同形：模块级 ref + 一个按钮去 `.click()`）。
 * 只做"选文件"，读文件与校验在 `importFontSet`（src/fontset-store.js）里。
 */
let importInput = null;

/** 删除按钮的标签：被改过的那一份，这个动作的语义是"恢复原样"（只说效果，不说来源）。 */
function deleteLabel(row) {
  return row.overrides ? "恢复原样" : "删除";
}

function renderFontSetEditor(ctx) {
  const {
    fontSets, activeId, loading, error, editingId, draftName, armedId,
    onActivate, onRefresh, onDelete, onArm, onDisarm, exportUrl, onImport,
    onEdit, onDraftName, onRenameCommit, onCancelEdit, onCreate,
  } = ctx;
  const rows = Array.isArray(fontSets) ? fontSets : [];
  const btn = (key, label, onClick, extra) => React.createElement("button",
    Object.assign({ key, className: "we-picker__btn", type: "button", onClick }, extra || {}), label);
  /** 导出 = **普通链接**（宿主带 attachment 头应答）—— 不引入 blob，也不需要 window.open。 */
  const exportLink = (id) => React.createElement("a", {
    key: "exp", className: "we-picker__btn", href: exportUrl(id), download: id + ".json",
    title: "下载这个字体集（可分享 / 可再导入）",
  }, "导出");
  /**
   * 破坏性动作要**再确认一次**，但**不能用原生对话框**（`window.confirm`）。
   *
   * 为什么不许原生模态（真机形态，也有守卫钉住）：原生 `confirm` 会把焦点交给它自己的窗口，
   * 而本插件是**同一个渲染页**里跑的 —— 后果是三重的：
   *   ① `blur` 立刻命中「窗口失焦时暂停」（`pauseOnBlur`，用户可开）⇒ 壁纸停住；
   *   ② 模态在时渲染线程**被同步阻塞** ⇒ 输入框收不到键，壁纸即便焦点回来也恢复不了；
   *   ③ 关闭时**回来那个 `focus` 事件不保证送达** ⇒ 判定卡在"窗口失焦"，只剩重载能救。
   * 所以确认做成**面板内**的一段状态（`armedId`）：点一次"待确认"，再点"确认"才发请求。
   * 与行内「重命名」同形；cancel/换行/关闭子分支都要把这段状态清掉。
   */
  const answerText = (row) => (row.overrides === true
    ? "把「" + (row.name || row.id) + "」恢复成它原本的样子？你在这份上的改动会丢掉。"
    : "删除「" + (row.name || row.id) + "」？此操作不可恢复。");

  const cells = [];
  for (const row of rows) {
    const isActive = row.id === activeId || row.active === true;
    const broken = typeof row.broken === "string" && row.broken;
    const overrides = row.overrides === true;
    // 发布物那份删不掉（宿主也拒）；**活动集**同样不出删除（宿主的规则：先切走 ——
    // "正在用的那份被删掉"没有可判定的结果，界面上也不该摆一个必然报错的按钮）。
    const canDelete = row.origin === "user" && !isActive;
    const actions = [];
    if (!broken) {
      if (!isActive) actions.push(btn("use", "使用", () => onActivate(row.id),
        { title: "切换到这个字体集（立即生效）" }));
      if (editingId !== row.id) {
        actions.push(btn("ren", "重命名", () => onEdit(row.id)));
      }
    }
    if (canDelete) {
      // 待确认时**按钮不隐藏**（也**不换位置**）：它仍占着那一格，宽度就完全不变 —— 藏起来会让
      // 整行缩一下、看起来像"点完少了个东西"。改成置灰 + 不可点，并向用户指路（问句在下面那行）。
      const armed = armedId === row.id;
      actions.push(btn("del", deleteLabel(row), () => { if (!armed) onArm(row.id); }, {
        disabled: armed,
        title: armed
          ? "已经问过你了 —— 在下面那一行选「确认」或「取消」"
          : (overrides ? "删掉你在这份上的改动，恢复它原本的样子" : "删除这个字体集（会再问一次）"),
      }));
    }
    actions.push(exportLink(row.id));

    cells.push(React.createElement("tr", { key: row.id, className: "we-picker__fontset-row" },
      React.createElement("td", null,
        React.createElement("span", { className: "we-picker__fontset-name" }, row.name || row.id),
        isActive ? React.createElement("span", { className: "we-picker__hint" }, "（使用中）") : null,
        broken ? React.createElement("span", { className: "we-picker__hint" }, "无法读取：" + broken) : null,
      ),
      React.createElement("td", null,
        editingId === row.id
          ? React.createElement(React.Fragment, null,
            React.createElement("input", {
              className: "we-picker__file",
              type: "text",
              value: draftName,
              placeholder: row.name || row.id,
              onChange: (e) => onDraftName(e.target.value),
              onKeyDown: (e) => { if (e && e.key === "Enter") onRenameCommit(row.id); },
            }),
            btn("ok", "保存", () => onRenameCommit(row.id)),
            btn("cancel", "取消", () => onCancelEdit()),
          )
          : actions,
      ),
    ));
    // 待确认**独占一行**（跨两列）：塞进操作格里会把整行往右推，既不美观也让"哪一行在问"
    // 变得含糊。这一行紧跟它自己那一行，问句在左、两枚按钮在右。
    if (canDelete && armedId === row.id) {
      cells.push(React.createElement("tr", { key: row.id + "-ask", className: "we-picker__fontset-confirm" },
        React.createElement("td", { colSpan: 2 },
          React.createElement("span", { className: "we-picker__hint" }, answerText(row)),
          btn("yes", "确认", () => onDelete(row.id), { title: "就这么办" }),
          btn("no", "取消", () => onDisarm(), { title: "算了" }),
        ),
      ));
    }
  }

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
      ctlText("字体集", "一份集 = 整套字体外观（颜色角色 / 排版 / 字重 / 字族 / 组件）。"
        + "改动只落到当前这一份、随时可以恢复原样；导入导出按整份文件走。"),
    ),
    loading ? React.createElement("div", { className: "we-picker__hint" }, "正在读取字体集…") : null,
    error ? React.createElement("div", { className: "we-picker__hint" }, "字体集不可用：" + error) : null,
    rows.length === 0 && !loading
      ? React.createElement("div", { className: "we-picker__hint" }, "还没有任何字体集 —— 下面可以新建一份。")
      : null,
    rows.length
      ? React.createElement("table", { className: "we-picker__font-table" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            React.createElement("th", null, "字体集"),
            React.createElement("th", null, "操作"),
          ),
        ),
        React.createElement("tbody", null, cells),
      )
      : null,
    React.createElement("div", { className: "we-picker__ctl" },
      React.createElement("input", {
        className: "we-picker__file",
        type: "file",
        // 只做文件对话框的提示（真正的门是 `$schema`，宿主权威校验）；
        // 与自定义画面的导入同形：隐藏 input + 一个按钮去 click()。
        accept: ".json,application/json",
        style: { display: "none" },
        ref: (el) => { importInput = el; },
        onChange: (e) => {
          const f = e.target.files && e.target.files[0];
          try { e.target.value = ""; } catch { /* ignore */ }
          if (f) onImport(f);
        },
      }),
      btn("import", "导入字体集…", () => {
        if (importInput && typeof importInput.click === "function") importInput.click();
      }, { title: "从「导出」得到的 .json 导入一份字体集" }),
      // 「新建」不再先问名字：名字由客户端生成（「我的字体集」/「我的字体集 2」…），
      // 建完立刻切过去 —— 用户的下一步一定是调它；想改名随时用行内的「重命名」。
      btn("new", "新建（以当前外观）", () => onCreate(),
        { title: "把当前这套字体外观存成一份新的集，并切换过去（名字之后可以改）" }),
      btn("refresh", "刷新", () => onRefresh()),
    ),
  );
}

export { renderFontSetEditor };
