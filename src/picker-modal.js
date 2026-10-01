/**
 * picker-modal.js — 壁纸选择器**库视图**的渲染器（整棵 `we-picker__modal` 子树）。
 *
 * 历史：它此前是 body 传送门里的居中弹框（遮罩 + 对话框语义）。UI 重构后改为
 * **页内下钻视图**：调用点（src/client.js 的 WallpaperPicker）在 `pickerOpen` 时
 * 把它整棵嵌进页签面板，ESC / 顶部「返回」/ 切页签退出。类名沿用旧系（`we-picker__modal*`
 * —— 116 个 `.we-picker__*` 选择器按层级/相邻关系绑定这棵树，改一个类名就静默失效），
 * 「modal」只剩名字，语义就是"壁纸库浏览视图"。
 *
 * 两套模式（渲染开关 `sel.pickerDraft`）：普通 = 点卡片即应用当前壁纸；草稿 = 轮播
 * 编辑器的下钻，点卡片加入/移出列表草稿（隐藏页 / 批量 / 关闭卡收起，顶部显已选数）。
 * **草稿=false 时逐字走普通分支**（标记等价 golden 只录普通形态）。
 *
 * 为什么单独一个文件：这是选择器里**层级契约最重**的一块标记 —— src/styles.js 里
 * `.we-picker__*` 共出现 256 次 / 116 个不同类名，其中**跨层绑定两个 picker 类**的选择器
 * 有 9 条，落在这棵子树里的就有 5 条（`.we-picker__modal-body .we-picker__grid`、
 * `.we-picker__card--checked .we-picker__card-check`、`.we-picker__card--hidden
 * .we-picker__card-title`、`.we-picker__filter-row .we-picker__playlist-select`、
 * `.we-picker__pager .we-picker__hint`）—— 标记挪一层、少一个类名，这些规则就**静默**失效。
 * 它此前住在 `WallpaperPicker` 那条 281 行的 return 表达式里，与 53 个处理器挤在同一屏；
 * 搬出后组件体只剩「状态 + 处理器 + 装配」，库视图怎么画看这里。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   · 渲染器**只从一个参数取外界**：`(ctx)`。标记**逐字搬入** —— 唯一改动是开头那段解构、
 *     以及 11 处「内联箭头直接写 `selection.*`」换成 ctx 里的具名回调（见下）。
 *   · ctx 由 `WallpaperPicker` 在**调用点**就地组装（见 src/client.js 里那次
 *     `renderPickerModal({...})`）：状态读值 + 派生列表 + 库视图那几个「改状态 + 发通知」的
 *     过渡回调。**多传字段无害，漏传会当场 ReferenceError**（守卫会抓住）—— 刻意选的
 *     失败方式：响亮且可定位。
 *   · 本渲染器**不写 `selection`、不自己发通知**：改状态是处理器的职责（它们仍住在面板组件
 *     里，一行没搬）。库视图里 11 处原本内联改状态的箭头 —— 页签切换 ×2、分页 ×4、批量 ×3、
 *     搜索 ×1、卡片点击 ×1 —— 现在都是 ctx 里的回调名；「全部恢复」与隐藏卡片的「恢复」
 *     仍直接调模块级函数（`restoreWallpapers` / `applySelection`），这与 src/panel-tabs.js
 *     直接调 `syncLayers()` 是同一口径：模块级工具可以直呼，组件状态只能经 ctx。
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

  function renderPickerModal(ctx) {
    const { sel, closePicker, current, playbackLive, playableList, hiddenList, hiddenPageView, normalPage, cdMode, pagerRow, query, basePlayable, ratingCounts, typeCounts, armedConfirm, onArmConfirm, onDisarmConfirm, onClear, onRatingFilterChange, onTypeFilterChange, onShowNormalView, onShowHiddenView, onHiddenPagePrev, onHiddenPageNext, onToggleBatchMode, onArmBatchHide, onBatchHide, onBatchCancel, onSearchInput, onPickCard, onNormalPagePrev, onNormalPageNext } = ctx;
  // 草稿模式（轮播编辑器的「选择壁纸」下钻，pickerDraft）：点卡片 = 加入/移出
  // 草稿（onPickCard 在组件侧路由），本形态下隐藏页 / 批量 / 关闭卡都无意义、整体收起，
  // 顶部换成已选计数提示。draft=false（普通下钻）时每一处都走原分支，逐字不受影响。
  const draft = sel.pickerDraft === true;
  const draftIdSet = new Set((sel.editing && sel.editing.wallpaperIds) || []);
  // 页内下钻视图：不再 portal 到 body、不再有遮罩与对话框语义 —— 整棵子树原样
  // 嵌进页签面板，挂载时机由调用点（WallpaperPicker 的 pickerOpen 分支）决定。
  return React.createElement("div", {
          className: "we-picker__modal",
          "data-we-cards": sel.pickerLayout,
          "aria-label": weT("选择壁纸"),
        },
          React.createElement("div", { className: "we-picker__modal-head" },
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
          ),
          !draft && React.createElement("div", { className: "we-picker__modal-tabs", role: "tablist" },
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
          ),
          sel.modalView === "hidden" && !draft
            ? React.createElement("div", { className: "we-picker__modal-body" },
                hiddenList.length === 0
                  ? React.createElement("span", { className: "we-picker__hint" }, weT("没有已隐藏的壁纸"))
                  : React.createElement("div", { className: "we-picker__grid" },
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
                      (cdMode ? hiddenList : hiddenPageView.items).map((w) => React.createElement("div", {
                        key: w.id,
                        className: "we-picker__card we-picker__card--hidden",
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
                    ),
                    !cdMode && hiddenPageView.pages > 1 && pagerRow(
                      hiddenList.length, hiddenPageView.page, hiddenPageView.pages,
                      onHiddenPagePrev,
                      onHiddenPageNext,
                    ),
              )
            : React.createElement("div", { className: "we-picker__modal-body" },
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
                sel.batchMode && React.createElement("div", { className: "we-picker__row we-picker__batch-bar" },
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
                ),
                // 问句行是**同级**（不是包一层）：包 Fragment 会把批量条整棵子树推深一层，
                // 那会让 116 个按层级绑定的选择器与「标记等价」golden 当场漂。
                renderConfirmRow(armedConfirm, "batchHide",
                  weT("隐藏选中的 {n} 张壁纸？可在「已隐藏」中随时恢复。", { n: sel.batchSelected.length }),
                  onBatchHide, onDisarmConfirm),
                React.createElement("div", { className: "we-picker__row we-picker__filter-row" },
                  // 标题搜索：几百上千张壁纸时最快的定位方式。输入即过滤
                  // （重置到第 1 页），与分级/类型过滤叠加。
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
                ),
                React.createElement("div", { className: "we-picker__grid" },
                  // "Close wallpaper" card — equivalent of the old first <option>.
                  // Rendered as a <div role="button"> like every other card:
                  // <button> ignores aspect-ratio in several browsers, which
                  // collapses the cell and lets the "✕ 关闭" label float over
                  // the adjacent thumbnail.
                  // 草稿模式下不渲染：该形态挑的是"进哪个列表"，与当前播放无关。
                  !draft && React.createElement("div", {
                    className: "we-picker__card" + (sel.id ? "" : " we-picker__card--selected"),
                    role: "button",
                    tabIndex: 0,
                    onClick: onClear,
                    title: weT("关闭壁纸"),
                    onKeyDown: cardKeyDown,
                  },
                  React.createElement("span", { className: "we-picker__card-close" }, weT("✕ 关闭")),
                  ),
                  playableList.length === 0
                    ? React.createElement("span", { className: "we-picker__hint" },
                        query
                          ? weT("没有匹配「{q}」的壁纸 · 试试缩短关键词或清除过滤", { q: sel.search })
                          : weT("没有可播放的壁纸"))
                    : (cdMode ? playableList : normalPage.items).map((w) => React.createElement("div", {
                        key: w.id,
                        className: "we-picker__card" + (w.id === sel.id ? " we-picker__card--selected" : "")
                          // 勾选高亮：草稿模式 = 成员集合；批量模式 = batchSelected
                          //（此前勾选态只进了 batchSelected，高亮 CSS 却挂在 --selected
                          //（=当前播放）上，勾了永远不亮 —— 同一条规则沿用）。
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
                      )),
                ),
                !cdMode && normalPage.pages > 1 && pagerRow(
                  playableList.length, normalPage.page, normalPage.pages,
                  onNormalPagePrev,
                  onNormalPageNext,
                ),
              ),
          // 底部只留提示：返回按钮在顶部（modal-head，也是初始焦点落点），
          // 底部再放一个是重复的。
          React.createElement("div", { className: "we-picker__modal-foot" },
            React.createElement("span", { className: "we-picker__hint" },
              draft ? weT("点卡片加入 / 移出 · ESC 返回") : weT("ESC 返回 · 点击卡片即应用")),
          ),
    );
}

