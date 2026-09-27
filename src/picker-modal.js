/**
 * picker-modal.js — 壁纸选择器**模态框**的渲染器（整棵模态框子树 + 它的 portal 包裹）。
 *
 * 为什么单独一个文件：这是选择器里**层级契约最重**的一块标记 —— src/styles.js 里
 * `.we-picker__*` 共出现 256 次 / 116 个不同类名，其中**跨层绑定两个 picker 类**的选择器
 * 有 9 条，落在这棵模态框子树里的就有 5 条（`.we-picker__modal-body .we-picker__grid`、
 * `.we-picker__card--checked .we-picker__card-check`、`.we-picker__card--hidden
 * .we-picker__card-title`、`.we-picker__filter-row .we-picker__playlist-select`、
 * `.we-picker__pager .we-picker__hint`）—— 标记挪一层、少一个类名，这些规则就**静默**失效。
 * 它此前住在 `WallpaperPicker` 那条 281 行的 return 表达式里，与 53 个处理器挤在同一屏；
 * 搬出后组件体只剩「状态 + 处理器 + 装配」，模态框怎么画看这里。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   · 渲染器**只从一个参数取外界**：`(ctx)`。标记**逐字搬入** —— 唯一改动是开头那段解构、
 *     以及 11 处「内联箭头直接写 `selection.*`」换成 ctx 里的具名回调（见下）。
 *   · ctx 由 `WallpaperPicker` 在**调用点**就地组装（见 src/client.js 里那次
 *     `renderPickerModal({...})`）：状态读值 + 派生列表 + 模态框那几个「改状态 + 发通知」的
 *     过渡回调。**多传字段无害，漏传会当场 ReferenceError**（守卫会抓住）—— 刻意选的
 *     失败方式：响亮且可定位。
 *   · 本渲染器**不写 `selection`、不自己发通知**：改状态是处理器的职责（它们仍住在面板组件
 *     里，一行没搬）。模态框里 11 处原本内联改状态的箭头 —— 页签切换 ×2、分页 ×4、批量 ×3、
 *     搜索 ×1、卡片点击 ×1 —— 现在都是 ctx 里的回调名；「全部恢复」与隐藏卡片的「恢复」
 *     仍直接调模块级函数（`restoreWallpapers` / `applySelection`），这与 src/panel-tabs.js
 *     直接调 `syncLayers()` 是同一口径：模块级工具可以直呼，组件状态只能经 ctx。
 *   · 模块级依赖（React / ReactDOM / VinylRecord / cardKeyDown / trapModalTab /
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
    const { sel, isRepoPanelCopy, closePicker, current, playbackLive, playableList, hiddenList, hiddenPageView, normalPage, cdMode, pagerRow, query, basePlayable, ratingCounts, typeCounts, onClear, onRatingFilterChange, onTypeFilterChange, onShowNormalView, onShowHiddenView, onHiddenPagePrev, onHiddenPageNext, onToggleBatchMode, onBatchHide, onBatchCancel, onSearchInput, onPickCard, onNormalPagePrev, onNormalPageNext } = ctx;
  return ReactDOM.createPortal(
      // repoPanel path: the picker opens as its own right-quarter liquid-glass
      // window (same recipe as the repo panel), NOT the centred dark dialog that
      // the settings copy uses. The scrim is a transparent full-screen click
      // catcher (no dark dim/blur) so picking stays visually continuous.
      React.createElement("div", { className: isRepoPanelCopy ? "we-repo-panel__modal-scrim" : "we-picker__modal-overlay", onClick: closePicker },
        React.createElement("div", {
          className: isRepoPanelCopy ? "we-picker__modal we-picker__modal--panel" : "we-picker__modal",
          "data-we-cards": sel.pickerLayout,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "选择壁纸",
          onClick: (e) => e.stopPropagation(),
          onKeyDown: trapModalTab,
        },
          React.createElement("div", { className: "we-picker__modal-head" },
            React.createElement("div", { className: "we-picker__modal-head-left" },
              React.createElement(VinylRecord, {
                cover: current && current.preview, title: current ? current.title : "",
                playing: playbackLive && Boolean(sel.url) && vinylSpinVisible(), sm: true,
              }),
              React.createElement("span", { className: "we-picker__modal-title" }, "选择壁纸"),
            ),
            React.createElement("button", {
              className: "we-picker__btn", type: "button", onClick: closePicker,
              // 打开模态框时焦点落在这里（一次性，见 modalInitialFocus）。
              ref: modalInitialFocus,
            }, "关闭"),
          ),
          React.createElement("div", { className: "we-picker__modal-tabs", role: "tablist" },
            React.createElement("button", {
              className: "we-picker__btn we-picker__tab" + (sel.modalView === "hidden" ? "" : " we-picker__tab--active"),
              type: "button",
              role: "tab",
              "aria-selected": sel.modalView !== "hidden",
              onClick: onShowNormalView,
            }, "正常列表（" + playableList.length + "）"),
            React.createElement("button", {
              className: "we-picker__btn we-picker__tab" + (sel.modalView === "hidden" ? " we-picker__tab--active" : ""),
              type: "button",
              role: "tab",
              "aria-selected": sel.modalView === "hidden",
              onClick: onShowHiddenView,
            }, "已隐藏（" + hiddenList.length + "）"),
          ),
          sel.modalView === "hidden"
            ? React.createElement("div", { className: "we-picker__modal-body" },
                hiddenList.length === 0
                  ? React.createElement("span", { className: "we-picker__hint" }, "没有已隐藏的壁纸")
                  : React.createElement("div", { className: "we-picker__grid" },
                      React.createElement("div", { className: "we-picker__row" },
                        React.createElement("span", { className: "we-picker__hint" },
                          "已隐藏 " + hiddenList.length + " 张（仅从列表隐藏，不删除源文件）"),
                        React.createElement("button", {
                          className: "we-picker__btn", type: "button",
                          onClick: () => {
                            if (!window.confirm("恢复全部 " + hiddenList.length + " 张已隐藏壁纸？")) return;
                            restoreWallpapers(hiddenList.map((w) => w.id));
                          },
                        }, "全部恢复"),
                      ),
                      (cdMode ? hiddenList : hiddenPageView.items).map((w) => React.createElement("div", {
                        key: w.id,
                        className: "we-picker__card we-picker__card--hidden",
                        role: "button",
                        tabIndex: 0,
                        title: w.title,
                        "aria-label": "恢复并应用 " + w.title,
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
                        : React.createElement("span", { className: "we-picker__card-placeholder" }, "无预览"),
                      CARD_TYPE_LABELS[w.type]
                        && React.createElement("span", { className: "we-picker__card-type" }, CARD_TYPE_LABELS[w.type]),
                      React.createElement("span", { className: "we-picker__card-title" }, w.title),
                      w.type === "scene" && React.createElement("span", { className: "we-picker__card-badge" }, w.sceneLive ? "实时渲染" : "静态帧"),
                      w.type === "web" && React.createElement("span", { className: "we-picker__card-badge" }, w.webLive ? "实时渲染" : "兼容模式"),
                      React.createElement("button", {
                        className: "we-picker__card-hide", type: "button",
                        title: "恢复此壁纸",
                        onClick: (e) => { e.stopPropagation(); restoreWallpapers([w.id]); },
                      }, "恢复"),
                      )),
                    ),
                    !cdMode && hiddenPageView.pages > 1 && pagerRow(
                      hiddenList.length, hiddenPageView.page, hiddenPageView.pages,
                      onHiddenPagePrev,
                      onHiddenPageNext,
                    ),
              )
            : React.createElement("div", { className: "we-picker__modal-body" },
                React.createElement("div", { className: "we-picker__row" },
                  React.createElement("span", { className: "we-picker__hint" },
                    playableList.length + " 个可播放壁纸 · 点击卡片即应用"),
                  React.createElement("button", {
                    className: "we-picker__btn", type: "button",
                    onClick: onToggleBatchMode,
                    disabled: playableList.length === 0,
                    title: "多选后批量隐藏",
                  }, sel.batchMode ? "退出批量" : "批量"),
                ),
                sel.batchMode && React.createElement("div", { className: "we-picker__row we-picker__batch-bar" },
                  React.createElement("span", { className: "we-picker__hint" }, "已选 " + sel.batchSelected.length + " 张"),
                  React.createElement("button", {
                    className: "we-picker__btn", type: "button",
                    disabled: sel.batchSelected.length === 0,
                    onClick: onBatchHide,
                  }, "批量隐藏"),
                  React.createElement("button", {
                    className: "we-picker__btn", type: "button",
                    onClick: onBatchCancel,
                  }, "取消"),
                ),
                React.createElement("div", { className: "we-picker__row we-picker__filter-row" },
                  // 标题搜索：几百上千张壁纸时最快的定位方式。输入即过滤
                  // （重置到第 1 页），与分级/类型过滤叠加。
                  React.createElement("input", {
                    className: "we-picker__text we-picker__search", type: "text",
                    value: sel.search,
                    placeholder: "搜索壁纸标题…",
                    "aria-label": "搜索壁纸标题",
                    onInput: onSearchInput,
                  }),
                  React.createElement("span", { className: "we-picker__hint we-picker__label" }, "内容分级"),
                  React.createElement("select", {
                    className: "we-picker__playlist-select",
                    value: sel.contentRatingFilter,
                    onChange: onRatingFilterChange,
                    "aria-label": "内容分级",
                    title: "对应 Wallpaper Engine 的内容分级（project.json contentrating）",
                  },
                  React.createElement("option", { value: "all" }, "全部（" + basePlayable.length + "）"),
                  React.createElement("option", { value: "everyone" }, "Everyone / G（" + ratingCounts.everyone + "）"),
                  React.createElement("option", { value: "pg13" }, "PG13（" + ratingCounts.pg13 + "）"),
                  React.createElement("option", { value: "mature" }, "Mature / R（" + ratingCounts.mature + "）"),
                  React.createElement("option", { value: "unrated" }, "未分级（" + ratingCounts.unrated + "）"),
                  ),
                  React.createElement("span", { className: "we-picker__hint we-picker__label" }, "类型"),
                  React.createElement("select", {
                    className: "we-picker__playlist-select",
                    value: sel.typeFilter,
                    onChange: onTypeFilterChange,
                    "aria-label": "类型",
                    title: "按壁纸类型过滤",
                  },
                  React.createElement("option", { value: "all" }, "全部（" + basePlayable.length + "）"),
                  React.createElement("option", { value: "video" }, "视频（" + (typeCounts.video || 0) + "）"),
                  React.createElement("option", { value: "web" }, "网页（" + (typeCounts.web || 0) + "）"),
                  React.createElement("option", { value: "image" }, "图片（" + (typeCounts.image || 0) + "）"),
                  React.createElement("option", { value: "scene" }, "场景（" + (typeCounts.scene || 0) + "）"),
                  ),
                ),
                React.createElement("div", { className: "we-picker__grid" },
                  // "Close wallpaper" card — equivalent of the old first <option>.
                  // Rendered as a <div role="button"> like every other card:
                  // <button> ignores aspect-ratio in several browsers, which
                  // collapses the cell and lets the "✕ 关闭" label float over
                  // the adjacent thumbnail.
                  React.createElement("div", {
                    className: "we-picker__card" + (sel.id ? "" : " we-picker__card--selected"),
                    role: "button",
                    tabIndex: 0,
                    onClick: onClear,
                    title: "关闭壁纸",
                    onKeyDown: cardKeyDown,
                  },
                  React.createElement("span", { className: "we-picker__card-close" }, "✕ 关闭"),
                  ),
                  playableList.length === 0
                    ? React.createElement("span", { className: "we-picker__hint" },
                        query
                          ? "没有匹配「" + sel.search + "」的壁纸 · 试试缩短关键词或清除过滤"
                          : "没有可播放的壁纸")
                    : (cdMode ? playableList : normalPage.items).map((w) => React.createElement("div", {
                        key: w.id,
                        className: "we-picker__card" + (w.id === sel.id ? " we-picker__card--selected" : "")
                          // 批量勾选高亮：此前勾选态只进了 batchSelected，高亮 CSS
                          // 却挂在 --selected（=当前播放）上，勾了永远不亮。
                          + (sel.batchMode && sel.batchSelected.indexOf(w.id) >= 0 ? " we-picker__card--checked" : ""),
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
                        : React.createElement("span", { className: "we-picker__card-placeholder" }, "无预览"),
                      // 类型徽标（卡片左上角）：批量模式下让位给勾选框。
                      !sel.batchMode && CARD_TYPE_LABELS[w.type]
                        && React.createElement("span", { className: "we-picker__card-type" }, CARD_TYPE_LABELS[w.type]),
                      React.createElement("span", { className: "we-picker__card-title" }, w.title),
                      w.type === "scene" && React.createElement("span", { className: "we-picker__card-badge" }, w.sceneLive ? "实时渲染" : "静态帧"),
                      w.type === "web" && React.createElement("span", { className: "we-picker__card-badge" }, w.webLive ? "实时渲染" : "兼容模式"),
                      sel.batchMode
                        ? React.createElement("span", { className: "we-picker__card-check" },
                            sel.batchSelected.indexOf(w.id) >= 0 ? "✓" : "")
                        : React.createElement("button", {
                            className: "we-picker__card-hide", type: "button",
                            title: "隐藏此壁纸（可在「已隐藏」中恢复）",
                            onClick: (e) => { e.stopPropagation(); hideWallpapers([w.id]); },
                          }, "隐藏"),
                      )),
                ),
                !cdMode && normalPage.pages > 1 && pagerRow(
                  playableList.length, normalPage.page, normalPage.pages,
                  onNormalPagePrev,
                  onNormalPageNext,
                ),
              ),
          // 底部只留提示：关闭按钮在顶部（modal-head，也是初始焦点落点），
          // 底部再放一个是重复的。
          React.createElement("div", { className: "we-picker__modal-foot" },
            React.createElement("span", { className: "we-picker__hint" }, "ESC / 点击遮罩关闭"),
          ),
        ),
      ),
      document.body,
    );
}

