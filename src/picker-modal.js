/**
 * picker-modal.js — 壁纸选择器**库视图**的渲染器（整棵 `we-picker__modal` 子树）。
 *
 * 形态是**页内下钻视图**：调用点（src/client.js）在 `pickerOpen` 时把它整棵嵌进页签面板，
 * ESC / 顶部「返回」/ 切页签退出。类名沿用 `we-picker__modal*` 一系 —— 那些选择器**按层级与
 * 相邻关系**绑定这棵树（跨层绑定两个 picker 类的规则还落在本子树里），改一个类名或挪一层
 * 就**静默**失效，所以类名是契约而不是命名。`modal` 只剩名字，语义就是"壁纸库浏览视图"。
 *
 * 两套模式（渲染开关 `sel.pickerDraft`）：普通 = 点卡片即应用当前壁纸；草稿 = 轮播
 * 编辑器的下钻，点卡片加入/移出列表草稿（隐藏页 / 批量 / 关闭卡收起，顶部显已选数）。
 * **草稿=false 时逐字走普通分支**（标记等价 golden 只录普通形态）。
 *
 * 为什么单独一个文件：它是选择器里**层级契约最重**的一块标记，而把它留在
 * `WallpaperPicker` 的 return 表达式里，就等于让"库视图怎么画"混在"状态 + 处理器 + 装配"
 * 之间；搬出后组件体只剩后者，前者看这里。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   · 渲染器**只从一个参数取外界**：`(ctx)` —— 状态读值 + 派生列表 + 库视图那几个
 *     「改状态 + 发通知」的过渡回调，由 `WallpaperPicker` 在**调用点**就地组装。
 *   · **多传字段无害，漏传会当场 ReferenceError**（守卫会抓住）—— 刻意选的
 *     失败方式：响亮且可定位。
 *   · 本渲染器**不写 `selection`、不自己发通知**：改状态是处理器的职责（它们仍住在面板组件
 *     里）。库视图里那些改状态的箭头 —— 页签切换 ×2、批量 ×3、
 *     搜索 ×1、卡片点击 ×1 —— 都是 ctx 里的回调名；「全部恢复」与隐藏卡片的「恢复」
 *     仍直接调模块级函数（`restoreWallpapers` / `applySelection`），这与 src/panel-tabs.js
 *     直接调 `syncLayers()` 是同一口径：模块级工具可以直呼，组件状态只能经 ctx。
 *   · 虚拟滚动的窗口（vwin）与网格 ref（gridRef）也走 ctx：hooks 长在 WallpaperPicker
 *     里（本渲染器是纯函数），测量由 src/quick-panel.js 的 qpVirtWindow 负责 ——
 *     库视图**不分页**（用户口径），classic CD 架除外（见下）。
 *   · 模块级依赖（React / VinylRecord / cardKeyDown /
 *     modalInitialFocus / CARD_TYPE_LABELS / vinylSpinVisible / restoreWallpapers /
 *     hideWallpapers / applySelection）直接读，不经过 ctx —— 它们是常量、纯组件与模块级工具。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 *
 * **标记等价**是这一项的验收核心：搬迁前后这棵子树的 class 序列（深度优先 + 深度前缀）必须
 * 逐字相同 —— 判据在 `test/verify-client.mjs` 的「模态框标记等价」一段，含三个状态的 golden
 * （普通视图 / 批量模式 / 隐藏页）、负对照与绝对锚点。
 */

  // ── 网格几何常量（顶层：client.js 的 qpVirtWindow 调用引用同一份，改样式两边同步）──
  const PICKER_CARD_H = 92;   // .we-picker__card 的固定 height（网格轨道不认内容高，见 styles.js）
  const PICKER_CARD_GAP = 8;  // .we-picker__grid 的 gap
  const PICKER_VP_FIRST = 30; // 还没量到窗口时的首帧条目数（关闭卡在内；量完立刻收窄）

  function renderPickerModal(ctx) {
    const { sel, playableList, hiddenList, cdMode, vwin } = ctx;
  // ── 库视图虚拟滚动（用户口径：**不要分页**）────────────────────
  // 网格按"占位 spacer + 可视窗口"渲染，与侧栏（quick-panel）同一套机制：窗口由
  // `qpVirtWindow` 在 WallpaperPicker（组件）里量，经 ctx（vwin / gridRef）传进来 ——
  // 本渲染器是纯函数，hooks 不能长在它身上。classic CD 架**不虚拟化**（卡片是
  // aspect-ratio + 负 margin 叠盖，行高随列宽变，固定行距的算式不成立；那一档本来
  // 就没有分页），维持全量渲染。
  //   · 「✕ 关闭」卡是网格的**第 0 个条目**（不是列表元素）：必须算进窗口切片，
  //     否则它会把首行数据卡挤到别处（full-span 的上占位没法与它同行）。
  //   · viewTag 必须与 client.js 侧喂给 qpVirtWindow 的取值一致：换形态（正常 / 草稿 /
  //     隐藏 / 开关下钻）的一帧，旧窗口是另一份几何 ⇒ 按未测量处理（首窗 + 零占位），
  //     测量 effect 立刻跟上。
  const PICKER_CLOSE_ITEM = { __closeCard: true };
  // 草稿模式（轮播编辑器的「选择壁纸」下钻，pickerDraft）：点卡片 = 加入/移出
  // 草稿（onPickCard 在组件侧路由），本形态下隐藏页 / 批量 / 关闭卡都无意义、整体收起，
  // 顶部换成已选计数提示。draft=false（普通下钻）时每一处都走原分支，逐字不受影响。
  const draft = sel.pickerDraft === true;
  const draftIdSet = new Set((sel.editing && sel.editing.wallpaperIds) || []);
  const viewTag = sel.modalView === "hidden" ? "hidden" : (draft ? "draft" : "normal");
  // 窗口换算（vItems = gridItems.slice(vStart, vEnd)）：未测量 ⇒ 首窗；classic ⇒ 全量。
  // 占位高 = **网格行数** × 行距 − 一个 gap（spacer 自己与相邻行之间还各隔一个 gap）；
  // 上占位向下取整、下占位向上取整（末行不满也占一行）—— 测量回来的窗口本就按 cols
  // 对齐，这里只是防御。
  const pickerWindow = (gridItems) => {
    const meas = !cdMode && vwin && vwin.tag === viewTag && vwin.cols > 0;
    const start = meas ? Math.min(vwin.start, gridItems.length) : 0;
    const end = meas
      ? Math.max(start, Math.min(vwin.end, gridItems.length))
      : (cdMode ? gridItems.length : Math.min(PICKER_VP_FIRST, gridItems.length));
    const items = gridItems.slice(start, end);
    const after = gridItems.length - start - items.length;
    const pitch = PICKER_CARD_H + PICKER_CARD_GAP;
    return {
      items,
      topH: meas && start > 0 ? Math.floor(start / vwin.cols) * pitch - PICKER_CARD_GAP : 0,
      btmH: meas && after > 0 ? Math.ceil(after / vwin.cols) * pitch - PICKER_CARD_GAP : 0,
    };
  };
  // 两份窗口现算（切片是 O(窗口) 的浅拷贝，每渲染一次的开销可以忽略）：
  const closePlus = draft ? playableList : [PICKER_CLOSE_ITEM].concat(playableList);
  const normalWin = pickerWindow(closePlus);
  const hiddenWin = pickerWindow(hiddenList);
  // 这棵子树的所有渲染器（head / tabs / 两个 body 分支 / 批量条 / 过滤行 / 关闭卡 / 数据卡）
  // 都在下方的「子渲染器」段 —— 本函数只留"派生 + 装配"。

  // 页内下钻视图：不再 portal 到 body、不再有遮罩与对话框语义 —— 整棵子树原样
  // 嵌进页签面板，挂载时机由调用点（WallpaperPicker 的 pickerOpen 分支）决定。
  return React.createElement("div", {
          className: "we-picker__modal",
          "data-we-cards": sel.pickerLayout,
          "aria-label": weT("选择壁纸"),
        },
          renderPickerModalHead(ctx),
          !draft && renderPickerModalTabs(ctx, draft),
          sel.modalView === "hidden" && !draft
            ? renderPickerHiddenBody(ctx, hiddenWin)
            : renderPickerNormalBody(ctx, draft, draftIdSet, normalWin),
          // 底部只留提示：返回按钮在顶部（modal-head，也是初始焦点落点），
          // 底部再放一个是重复的。
          renderPickerModalFoot(draft),
    );
}

  // ── 库视图的子渲染器 ─────────────────────────────────────────────────
  // 判据：这些子树的输入全部来自 `ctx`（外加现算的 draft / draftIdSet / normalWin / hiddenWin）
  // ⇒ 不需要父函数的局部作用域。父函数只留"派生 + 装配"。

  function renderPickerVSpacer(key, h) {
    return React.createElement("div", {
      key,
      className: "we-picker__vspacer",
      style: { height: Math.max(0, h) + "px" },
      "aria-hidden": "true",
    });
  }

  function renderPickerCloseCard(ctx) {
    const { sel, onClear } = ctx;
    return React.createElement("div", {
      className: "we-picker__card" + (sel.id ? "" : " we-picker__card--selected"),
      role: "button",
      tabIndex: 0,
      onClick: onClear,
      title: weT("关闭壁纸"),
      onKeyDown: cardKeyDown,
    },
    React.createElement("span", { className: "we-picker__card-close" }, weT("✕ 关闭")),
    );
  }

  function renderPickerPickCard(ctx, w, draft, draftIdSet) {
    const { sel, onPickCard } = ctx;
    return React.createElement("div", {
      key: w.id,
      // 卡片自报身份：视频壁纸的提交前预热靠它（见 src/video-layer.js
      // 的 warmVideoForPointer）——按下即预热，抬手才点击。
      "data-we-id": String(w.id),
      className: "we-picker__card" + (w.id === sel.id ? " we-picker__card--selected" : "")
        // 勾选高亮：草稿模式 = 成员集合；批量模式 = batchSelected。
        // ⚠️ 高亮类必须是 `--checked` —— CSS 挂在它上面，挂到
        // `--selected`（= 当前播放）上会"勾了永远不亮"。
        + ((draft ? draftIdSet.has(w.id) : sel.batchMode && sel.batchSelected.indexOf(w.id) >= 0) ? " we-picker__card--checked" : ""),
      role: "button",
      tabIndex: 0,
      title: w.title,
      onClick: () => onPickCard(w),
      onKeyDown: cardKeyDown,
    },
    w.preview
      ? React.createElement("img", {
          src: w.preview, alt: w.title, loading: "lazy",
          onError: (e) => { e.target.style.display = "none"; },
          onLoad: (e) => { e.target.style.opacity = "1"; },
        })
      : React.createElement("span", { className: "we-picker__card-placeholder" }, weT("无预览")),
    // 类型徽标（卡片左上角）：勾选态（草稿 / 批量）下让位给勾选框。
    !sel.batchMode && !draft && CARD_TYPE_LABELS[w.type]
      && React.createElement("span", { className: "we-picker__card-type" }, CARD_TYPE_LABELS[w.type]),
    React.createElement("span", { className: "we-picker__card-title" }, w.title),
    w.type === "scene" && React.createElement("span", { className: "we-picker__card-badge" }, w.sceneLive ? weT("实时渲染") : weT("静态帧")),
    w.type === "web" && React.createElement("span", { className: "we-picker__card-badge" }, w.webLive ? weT("实时渲染") : weT("兼容模式")),
    (draft || sel.batchMode)
      ? React.createElement("span", { className: "we-picker__card-check" },
          (draft ? draftIdSet.has(w.id) : sel.batchSelected.indexOf(w.id) >= 0) ? "✓" : "")
      : React.createElement("button", {
          className: "we-picker__card-hide", type: "button",
          title: weT("隐藏此壁纸（可在「已隐藏」中恢复）"),
          onClick: (e) => { e.stopPropagation(); hideWallpapers([w.id]); },
        }, weT("隐藏")),
    );
  }

  function renderPickerHiddenBody(ctx, hiddenWin) {
    const { hiddenList, armedConfirm, onArmConfirm, onDisarmConfirm, cdMode, gridRef } = ctx;
    return React.createElement("div", { className: "we-picker__modal-body" },
        hiddenList.length === 0
          ? React.createElement("span", { className: "we-picker__hint" }, weT("没有已隐藏的壁纸"))
          : React.createElement(React.Fragment, null,
              // 头部行与问句行放在网格**外**（modal-body 直属）：它们是语义行不是
              // 网格单元 —— 作为网格子元素会被 auto-fill 塞进一张卡位（挤压变形）；
              // 放在网格外与正常列表的过滤行同构，网格里只剩纯卡片，虚拟
              // 窗口的行号折算才成立。
              React.createElement("div", { className: "we-picker__row" },
                React.createElement("span", { className: "we-picker__hint" },
                  weT("已隐藏 {n} 张（仅从列表隐藏，不删除源文件）", { n: hiddenList.length })),
                React.createElement("button", {
                  className: "we-picker__btn", type: "button",
                  // 第一下只置令牌；落地在问句行的「确认」里（`restoreWallpapers` 是
                  // 模块级工具 ⇒ 与隐藏卡片的「恢复」同口径，可以在问句行里直呼）。
                  onClick: () => onArmConfirm("restoreAll"),
                  disabled: armedConfirm === "restoreAll",
                  title: armedConfirm === "restoreAll"
                    ? weT("已经问过你了 —— 在下面那一行选「确认」或「取消」")
                    : weT("把已隐藏的全部恢复（会再问一次）"),
                }, weT("全部恢复")),
              ),
              renderConfirmRow(armedConfirm, "restoreAll",
                weT("恢复全部 {n} 张已隐藏壁纸？", { n: hiddenList.length }),
                () => restoreWallpapers(hiddenList.map((w) => w.id)), onDisarmConfirm),
              React.createElement("div", { ref: cdMode ? undefined : gridRef, className: "we-picker__grid" },
                hiddenWin.topH > 0 ? renderPickerVSpacer("we-picker-vtop", hiddenWin.topH) : null,
                hiddenWin.items.map((w) => React.createElement("div", {
                  key: w.id,
                  className: "we-picker__card we-picker__card--hidden",
                  // 卡片自报身份：视频壁纸的提交前预热靠它（指针按下 → 预到元数据，
                  // 见 src/video-layer.js 的 warmVideoForPointer）。
                  "data-we-id": String(w.id),
                  role: "button",
                  tabIndex: 0,
                  title: w.title,
                  "aria-label": weT("恢复并应用 {name}", { name: w.title }),
                  onClick: () => applySelection(w.id),
                  // 键盘可达性：正常列表卡片一直有 Enter/Space 处理，
                  // 已隐藏卡片漏了 —— 补上（共享 cardKeyDown）。
                  onKeyDown: cardKeyDown,
                },
                w.preview
                  ? React.createElement("img", {
                      src: w.preview, alt: w.title, loading: "lazy",
                      onError: (e) => { e.target.style.display = "none"; },
                      onLoad: (e) => { e.target.style.opacity = "1"; },
                    })
                  : React.createElement("span", { className: "we-picker__card-placeholder" }, weT("无预览")),
                CARD_TYPE_LABELS[w.type]
                  && React.createElement("span", { className: "we-picker__card-type" }, CARD_TYPE_LABELS[w.type]),
                React.createElement("span", { className: "we-picker__card-title" }, w.title),
                w.type === "scene" && React.createElement("span", { className: "we-picker__card-badge" }, w.sceneLive ? weT("实时渲染") : weT("静态帧")),
                w.type === "web" && React.createElement("span", { className: "we-picker__card-badge" }, w.webLive ? weT("实时渲染") : weT("兼容模式")),
                React.createElement("button", {
                  className: "we-picker__card-hide", type: "button",
                  title: weT("恢复此壁纸"),
                  onClick: (e) => { e.stopPropagation(); restoreWallpapers([w.id]); },
                }, weT("恢复")),
                )),
                hiddenWin.btmH > 0 ? renderPickerVSpacer("we-picker-vbtm", hiddenWin.btmH) : null,
              ),
            ),
      );
  }

  function renderPickerNormalBody(ctx, draft, draftIdSet, normalWin) {
    const { sel, playableList, onToggleBatchMode, armedConfirm, onBatchHide, onDisarmConfirm, cdMode, gridRef, query } = ctx;
    return React.createElement("div", { className: "we-picker__modal-body" },
        draft
          ? React.createElement("div", { className: "we-picker__row" },
              React.createElement("span", { className: "we-picker__hint" },
                weT("已选 {n} 个 · 点卡片加入 / 移出", { n: draftIdSet.size })),
            )
          : React.createElement("div", { className: "we-picker__row" },
            React.createElement("span", { className: "we-picker__hint" },
              weT("{n} 个可播放壁纸 · 点击卡片即应用", { n: playableList.length })),
            React.createElement("button", {
              className: "we-picker__btn", type: "button",
              onClick: onToggleBatchMode,
              disabled: playableList.length === 0,
              title: weT("多选后批量隐藏"),
            }, sel.batchMode ? weT("退出批量") : weT("批量")),
          ),
        sel.batchMode && renderPickerBatchBar(ctx),
        // 问句行是**同级**（不是包一层）：包 Fragment 会把批量条整棵子树推深一层，
        // 那会让 116 个按层级绑定的选择器与「标记等价」golden 当场漂。
        renderConfirmRow(armedConfirm, "batchHide",
          weT("隐藏选中的 {n} 张壁纸？可在「已隐藏」中随时恢复。", { n: sel.batchSelected.length }),
          onBatchHide, onDisarmConfirm),
        renderPickerFilterRow(ctx),
        React.createElement("div", { ref: cdMode ? undefined : gridRef, className: "we-picker__grid" },
          // "Close wallpaper" card — equivalent of the first <option> in the
          // select-based UI. Rendered as a <div role="button"> like every other card:
          // <button> ignores aspect-ratio in several browsers, which
          // collapses the cell and lets the "✕ 关闭" label float over
          // the adjacent thumbnail.
          // 草稿模式下不渲染：该形态挑的是"进哪个列表"，与当前播放无关。
          // 虚拟窗口形态：关闭卡是窗口的第 0 个条目（pickerWindow），随切片走；
          // 空库时窗口里只有它 + 空态提示。
          playableList.length === 0
            ? React.createElement(React.Fragment, null,
                !draft && renderPickerCloseCard(ctx),
                React.createElement("span", { className: "we-picker__hint" },
                  query
                    ? weT("没有匹配「{q}」的壁纸 · 试试缩短关键词或清除过滤", { q: sel.search })
                    : weT("没有可播放的壁纸")),
              )
            : React.createElement(React.Fragment, null,
                normalWin.topH > 0 ? renderPickerVSpacer("we-picker-vtop", normalWin.topH) : null,
                normalWin.items.map((w) => (w && w.__closeCard) ? renderPickerCloseCard(ctx) : renderPickerPickCard(ctx, w, draft, draftIdSet)),
                normalWin.btmH > 0 ? renderPickerVSpacer("we-picker-vbtm", normalWin.btmH) : null,
              ),
        ),
      );
  }

  function renderPickerModalHead(ctx) {
    const { current, playbackLive, sel, closePicker } = ctx;
    return React.createElement("div", { className: "we-picker__modal-head" },
      React.createElement("div", { className: "we-picker__modal-head-left" },
        React.createElement(VinylRecord, {
          cover: current && current.preview, title: current ? current.title : "",
          playing: playbackLive && Boolean(sel.url) && vinylSpinVisible(), sm: true,
        }),
        React.createElement("span", { className: "we-picker__modal-title" }, weT("选择壁纸")),
      ),
      React.createElement("button", {
        className: "we-picker__btn", type: "button", onClick: closePicker,
        // 打开库视图时焦点落在这里（一次性，见 modalInitialFocus）。
        ref: modalInitialFocus,
      }, weT("返回")),
    );
  }

  function renderPickerModalTabs(ctx, draft) {
    const { sel, onShowNormalView, onShowHiddenView, playableList, hiddenList } = ctx;
    return React.createElement("div", { className: "we-picker__modal-tabs", role: "tablist" },
      React.createElement("button", {
        className: "we-picker__btn we-picker__tab" + (sel.modalView === "hidden" ? "" : " we-picker__tab--active"),
        type: "button",
        role: "tab",
        "aria-selected": sel.modalView !== "hidden",
        onClick: onShowNormalView,
      }, weT("正常列表（{n}）", { n: playableList.length })),
      React.createElement("button", {
        className: "we-picker__btn we-picker__tab" + (sel.modalView === "hidden" ? " we-picker__tab--active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": sel.modalView === "hidden",
        onClick: onShowHiddenView,
      }, weT("已隐藏（{n}）", { n: hiddenList.length })),
    );
  }

  function renderPickerModalFoot(draft) {
    return React.createElement("div", { className: "we-picker__modal-foot" },
      React.createElement("span", { className: "we-picker__hint" },
        draft ? weT("点卡片加入 / 移出 · ESC 返回") : weT("ESC 返回 · 点击卡片即应用")),
    );
  }

  function renderPickerBatchBar(ctx) {
    const { sel, armedConfirm, onArmBatchHide, onBatchCancel } = ctx;
    return React.createElement("div", { className: "we-picker__row we-picker__batch-bar" },
      React.createElement("span", { className: "we-picker__hint" }, weT("已选 {n} 张", { n: sel.batchSelected.length })),
      React.createElement("button", {
        className: "we-picker__btn", type: "button",
        // 第一下只置令牌（`onArmBatchHide`）；落地在下面那行问句的「确认」里。
        // 待确认时置灰但**不隐藏**：位置与宽度都不变，并指路到问句行。
        onClick: onArmBatchHide,
        disabled: sel.batchSelected.length === 0 || armedConfirm === "batchHide",
        title: armedConfirm === "batchHide"
          ? weT("已经问过你了 —— 在下面那一行选「确认」或「取消」")
          : weT("隐藏选中的这些壁纸（会再问一次）"),
      }, weT("批量隐藏")),
      React.createElement("button", {
        className: "we-picker__btn", type: "button",
        onClick: onBatchCancel,
      }, weT("取消")),
    );
  }

  function renderPickerFilterRow(ctx) {
    const { sel, basePlayable, ratingCounts, typeCounts, onSearchInput, onRatingFilterChange, onTypeFilterChange } = ctx;
    return React.createElement("div", { className: "we-picker__row we-picker__filter-row" },
      // 标题搜索：几百上千张壁纸时最快的定位方式。输入即过滤，与分级/类型过滤叠加。
      React.createElement("input", {
        className: "we-picker__text we-picker__search", type: "text",
        value: sel.search,
        placeholder: weT("搜索壁纸标题…"),
        "aria-label": weT("搜索壁纸标题"),
        onInput: onSearchInput,
      }),
      React.createElement("span", { className: "we-picker__hint we-picker__label" }, weT("内容分级")),
      React.createElement("select", {
        className: "we-picker__playlist-select",
        value: sel.contentRatingFilter,
        onChange: onRatingFilterChange,
        "aria-label": weT("内容分级"),
        title: weT("对应 Wallpaper Engine 的内容分级（project.json contentrating）"),
      },
      React.createElement("option", { value: "all" }, weT("全部（{n}）", { n: basePlayable.length })),
      React.createElement("option", { value: "everyone" }, weT("Everyone / G（{n}）", { n: ratingCounts.everyone })),
      React.createElement("option", { value: "pg13" }, weT("PG13（{n}）", { n: ratingCounts.pg13 })),
      React.createElement("option", { value: "mature" }, weT("Mature / R（{n}）", { n: ratingCounts.mature })),
      React.createElement("option", { value: "unrated" }, weT("未分级（{n}）", { n: ratingCounts.unrated })),
      ),
      React.createElement("span", { className: "we-picker__hint we-picker__label" }, weT("类型")),
      React.createElement("select", {
        className: "we-picker__playlist-select",
        value: sel.typeFilter,
        onChange: onTypeFilterChange,
        "aria-label": weT("类型"),
        title: weT("按壁纸类型过滤（只筛列表与轮播候选，不打断正在应用的壁纸）"),
      },
      React.createElement("option", { value: "all" }, weT("全部（{n}）", { n: basePlayable.length })),
      React.createElement("option", { value: "video" }, weT("视频（{n}）", { n: typeCounts.video || 0 })),
      React.createElement("option", { value: "web" }, weT("网页（{n}）", { n: typeCounts.web || 0 })),
      React.createElement("option", { value: "image" }, weT("图片（{n}）", { n: typeCounts.image || 0 })),
      React.createElement("option", { value: "scene" }, weT("场景（{n}）", { n: typeCounts.scene || 0 })),
      ),
    );
  }

  export {
    renderPickerModal,
  };
