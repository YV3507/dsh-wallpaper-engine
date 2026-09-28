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
 *   · `onActivate(id)` / `onRefresh()` / `onDelete(id)` / `exportUrl(id)`
 *   · `onEdit(id)` / `onDraftName(v)` / `onRenameCommit(id)` / `onCancelEdit()`
 *   · `onNewName(v)` / `onCreate()`
 * 对外提供：`renderFontSetEditor`（唯一的导出）。
 *
 * 不变量（都有守卫）：
 *   · **来源必须看得见**：随包 / 我的 / 「已修改（随包 X）」三态各有明确标记 —— 用户要能分辨
 *     "我改的是哪一份"（D3 写时复制的 UX 落点）。
 *   · **随包预设删不掉**：`origin === 'builtin'` 且未被覆盖时**不渲染删除按钮**（宿主也会拒）；
 *     **活动集**那一行也不出删除（要先切走 —— 界面上不摆必然报错的按钮）。
 *   · **覆盖的那一行，删除按钮的语义就是「恢复随包原样」**（同一个动作、按来源换标签）。
 *   · **读不懂的行不能用**：`broken` 的行禁用「使用」与「重命名」，但**保留删除**
 *     （删掉覆盖/坏文件是唯一的出路），并显示**可判定的原因**。
 *   · **删除必须过 confirm**：先答 false ⇒ 一个字节都不发。
 *   · 载入中与失败态各自可见：失败时给的是**原因**，不是"什么都没发生"。
 */

const ORIGIN_LABEL = { builtin: "随包", user: "我的" };

/** 一行的来源文案：用户层覆盖了随包那份时必须**两件事都说**（这是我的，且基于随包 X）。 */
function originText(row) {
  const base = ORIGIN_LABEL[row.origin] || row.id;
  return row.overrides ? base + "（已修改随包的「" + row.name + "」）" : base;
}

/** 删除按钮的标签：覆盖随包那份时，这个动作的语义是"恢复随包原样"。 */
function deleteLabel(row) {
  return row.overrides ? "恢复随包原样" : "删除";
}

function renderFontSetEditor(ctx) {
  const {
    fontSets, activeId, loading, error, editingId, draftName, newName,
    onActivate, onRefresh, onDelete, exportUrl,
    onEdit, onDraftName, onRenameCommit, onCancelEdit, onNewName, onCreate,
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
   * 删除必须过 confirm（与轮换列表、移除自定义壁纸同形：**面板**是问这一句的地方）。
   * 先答 false ⇒ 一个字节都不发。覆盖随包那一行的问法不同（那是"恢复原样"，不是"删除"）。
   */
  const confirmDelete = (row) => {
    if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
    const what = row.overrides === true
      ? "删掉对随包预设「" + (row.name || row.id) + "」的修改，恢复随包原样？"
      : "删除字体集「" + (row.name || row.id) + "」？此操作不可恢复。";
    return window.confirm(what);
  };

  const cells = [];
  for (const row of rows) {
    const isActive = row.id === activeId || row.active === true;
    const broken = typeof row.broken === "string" && row.broken;
    const overrides = row.overrides === true;
    // 纯随包那份删不掉（宿主也拒）；**活动集**同样不出删除（宿主的规则：先切走 ——
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
    if (canDelete) actions.push(btn("del", deleteLabel(row),
      () => { if (confirmDelete(row)) onDelete(row.id); },
      { title: overrides ? "删掉你的覆盖，回到随包那份" : "删除这个字体集" }));
    actions.push(exportLink(row.id));

    cells.push(React.createElement("tr", { key: row.id, className: "we-picker__fontset-row" },
      React.createElement("td", null,
        React.createElement("span", { className: "we-picker__fontset-name" }, row.name || row.id),
        isActive ? React.createElement("span", { className: "we-picker__hint" }, "（使用中）") : null,
        broken ? React.createElement("span", { className: "we-picker__hint" }, "无法读取：" + broken) : null,
      ),
      React.createElement("td", null, ctlText(originText(row))),
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
  }

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
      ctlText("字体集", "一份集 = 整套字体外观（颜色角色 / 排版 / 字重 / 字族 / 组件）。"
        + "「随包」的集直接可用、改它会自动存成你的一份；导入导出按整份文件走。"),
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
            React.createElement("th", null, "来源"),
            React.createElement("th", null, "操作"),
          ),
        ),
        React.createElement("tbody", null, cells),
      )
      : null,
    React.createElement("div", { className: "we-picker__ctl" },
      React.createElement("input", {
        className: "we-picker__file",
        type: "text",
        value: newName,
        placeholder: "新字体集名称",
        onChange: (e) => onNewName(e.target.value),
        onKeyDown: (e) => { if (e && e.key === "Enter") onCreate(); },
      }),
      btn("new", "新建（以当前外观）", () => onCreate(),
        { title: "把当前这套字体外观存成一份新的集，并切换过去" }),
      btn("refresh", "刷新", () => onRefresh()),
    ),
  );
}

export { renderFontSetEditor };
