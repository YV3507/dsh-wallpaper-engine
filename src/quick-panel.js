/**
 * quick-panel.js — 快捷播放面板（侧边栏的**唯一**内容）：当前壁纸 + 轮播 + 列表快切
 * + 声音组 + 设置入口。
 *
 * 为什么单独一个文件：它是两个宿主位置的**同一份**内容 —— ① 官方右侧栏的 tab
 * （harness ≥0.1.5，`sidebar.right.pane.tab` 座位）；② 低版本宿主的右滑抽屉
 * （RopeDock 的 `.we-repo-panel`）。UI 重构后侧边栏不再是"设置页的副本"，只放
 * 日常高频操作；配置类全部留在设置页（壁纸引擎）。同一份面板画在两个壳里，
 * 壳的差异只有根类修饰（`dock`）。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域" =
 * 同一 prelude / src/client.js 的顶层）：
 *   · 这是一个**组件**（同 WallpaperPicker / RopeDock 一类），不是纯渲染器：直接
 *     `useStore()` 读 store，直呼模块级处理器（onTogglePlay / onToggleAudio /
 *     onVideoVolume / onClear / onToggleRotation / onGroupChange / onNextWallpaper —
 *     它们已从组件闭包提升到模块级，与设置页共用**同一份实现**）与模块级工具
 *     （applySelection / setSetting / setTransient / emit / SliderRow / switchRow /
 *     cardKeyDown / playableInventory / groupWallpapers / playbackIsVideoLike /
 *     CARD_TYPE_LABELS / openSettingsSection）。
 *   · **不得**出现 `selection.X =` 字面直写：写设置走 setSetting/setTransient/处理器
 *     （守卫 ①e 的棘轮只盯直写，本文件必须保持 0）。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）；React 只在渲染期读。
 */

  // 列表一次最多渲染的行数：库可以上千张，面板是"快切"不是"全集浏览" —— 超出
  // 让用户用搜索收敛（全量浏览在设置页的壁纸库下钻视图）。
  const QP_LIST_MAX = 100;
  // 面板本地的类型筛选档（用户口径：全部 / 场景 / 网页 / 视频 —— 面板是快切，
  // 只列三类主力类型；「图片」不单列，仍出现在「全部」里）。
  const QP_TYPES = [
    { id: "all", label: "全部" },
    { id: "scene", label: "场景" },
    { id: "web", label: "网页" },
    { id: "video", label: "视频" },
  ];
  // 列表/卡片视图的记忆键（同 picker-tab 口径：仅 UI 状态，localStorage，不进 config.json）。
  const QP_VIEW_KEY = "dsh-wallpaper-engine:qp-view";
  /** 读取面板视图偏好；缺失/非法回落**卡片**（默认形态），显式选过列表的仍读列表。 */
  function readQpView() {
    try {
      return localStorage.getItem(QP_VIEW_KEY) === "list" ? "list" : "cards";
    } catch { return "cards"; }
  }

  /** 类型 + live 形态的一句话徽标（与设置页当前壁纸卡同口径，去掉播放态）。 */
  function qpTypeLabel(w, sel) {
    if (!w) return "";
    const live = (w.type === "scene" || w.type === "web") && liveRenderEnabled(sel);
    if (w.type === "scene") return live ? "场景 · 实时渲染" : "场景 · 静态帧";
    if (w.type === "web") return live ? "网页 · 实时渲染" : "网页 · 兼容模式";
    return CARD_TYPE_LABELS[w.type] || "壁纸";
  }

  function QuickPanel(props) {
    const sel = useStore();
    const dock = (props && props.dock) || "drawer";
    // 视图偏好（列表 / 卡片）：useState 必须在早退分支之前（Rules of Hooks）。
    const [view, setView] = React.useState(readQpView);
    const switchView = (v) => {
      if (v === view) return;
      setView(v);
      try { localStorage.setItem(QP_VIEW_KEY, v); } catch { /* ignore */ }
    };
    // 库还没回来 / 扫描失败：面板只给一句话，不假装有内容（与设置页同一句文案）。
    if (!sel.loaded) {
      return React.createElement("div", { className: "we-qp we-qp--" + dock },
        React.createElement("span", { className: "we-picker__hint" }, "扫描 Wallpaper Engine…"));
    }
    if (sel.inventory.error) {
      return React.createElement("div", { className: "we-qp we-qp--" + dock },
        React.createElement("div", { className: "we-picker__error" },
          "未检测到 Wallpaper Engine：" + sel.inventory.error),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          onClick: () => loadInventory(), disabled: sel.loading,
        }, sel.loading ? "刷新中…" : "重试"));
    }

    const list = sel.inventory.wallpapers;
    const current = list.find((w) => w.id === sel.id) || null;
    const playbackLive = playbackIsVideoLike(sel) ? sel.videoPlaying : sel.playing;
    // 快切列表：与库视图同一过滤口径（分级 / 类型 / 隐藏），再叠面板自己的
    // 搜索词与**面板本地的类型筛选**（qpType：全部 / 场景 / 网页 / 视频 —— 瞬态，
    // 不影响设置页的过滤与轮播候选）。
    const q = String(sel.qpSearch || "").trim().toLowerCase();
    const typeFilter = QP_TYPES.some((t) => t.id === sel.qpType) ? sel.qpType : "all";
    const playable = playableInventory();
    const filtered = playable.filter((w) => {
      if (typeFilter !== "all" && w.type !== typeFilter) return false;
      if (q && String(w.title || "").toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    const rows = filtered.slice(0, QP_LIST_MAX);
    const groups = sel.rotationGroups;

    // ── 行：一张可快切的壁纸 ──
    const renderRow = (w) => React.createElement("div", {
      key: w.id,
      className: "we-qp__item" + (w.id === sel.id ? " we-qp__item--current" : ""),
      role: "option",
      tabIndex: 0,
      "aria-selected": w.id === sel.id ? "true" : "false",
      title: w.title,
      onClick: () => applySelection(w.id, { fromManual: true }),
      onKeyDown: cardKeyDown,
    },
      React.createElement("span", { className: "we-qp__item-thumb" },
        w.preview
          ? React.createElement("img", {
              src: w.preview, alt: "", loading: "lazy",
              onError: (e) => { e.target.style.display = "none"; },
              onLoad: (e) => { e.target.style.opacity = "1"; },
            })
          : null),
      React.createElement("span", { className: "we-qp__item-title" }, w.title),
      w.id === sel.id
        ? React.createElement("span", { className: "we-qp__item-badge" }, "当前")
        : React.createElement("span", { className: "we-qp__item-type" }, CARD_TYPE_LABELS[w.type] || "壁纸"),
    );

    // ── 卡：缩略图网格形态（视图切换的「卡片」档；点击语义与列表行一致）──
    const renderCard = (w) => React.createElement("div", {
      key: w.id,
      className: "we-qp__card" + (w.id === sel.id ? " we-qp__card--current" : ""),
      role: "option",
      tabIndex: 0,
      "aria-selected": w.id === sel.id ? "true" : "false",
      title: w.title,
      onClick: () => applySelection(w.id, { fromManual: true }),
      onKeyDown: cardKeyDown,
    },
      w.preview
        ? React.createElement("img", {
            src: w.preview, alt: "", loading: "lazy",
            onError: (e) => { e.target.style.display = "none"; },
            onLoad: (e) => { e.target.style.opacity = "1"; },
          })
        : React.createElement("span", { className: "we-qp__card-empty" }, "无预览"),
      React.createElement("span", { className: "we-qp__card-type" }, CARD_TYPE_LABELS[w.type] || "壁纸"),
      w.id === sel.id && React.createElement("span", { className: "we-qp__card-badge" }, "当前"),
      React.createElement("span", { className: "we-qp__card-title" }, w.title),
    );

    return React.createElement("div", { className: "we-qp we-qp--" + dock },
      // ── ① 当前壁纸 ──
      React.createElement("div", { className: "we-qp__current" },
        React.createElement("span", { className: "we-qp__thumb" },
          current && current.preview
            ? React.createElement("img", {
                src: current.preview, alt: "", loading: "lazy",
                onError: (e) => { e.target.style.display = "none"; },
                onLoad: (e) => { e.target.style.opacity = "1"; },
              })
            : null),
        React.createElement("div", { className: "we-qp__current-info" },
          React.createElement("div", { className: "we-qp__title", title: current ? current.title : "" },
            sel.id && current ? current.title : "未选择壁纸"),
          React.createElement("div", { className: "we-qp__meta" },
            current
              ? qpTypeLabel(current, sel) + (playbackLive ? " · 播放中" : " · 已暂停")
              : "从下面列表挑一张"),
          sel.videoError && React.createElement("div", { className: "we-picker__current-error" }, sel.videoError),
        ),
        React.createElement("div", { className: "we-qp__current-actions" },
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onTogglePlay, disabled: !sel.url,
          }, playbackLive ? "暂停" : "播放"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onClear, disabled: !sel.id,
            title: "清除当前壁纸（停止播放，回到无壁纸状态）",
          }, "清除"),
        ),
      ),
      // ── ② 轮播：列表 + 启停 + 下一张 ──
      React.createElement("div", { className: "we-qp__section" },
        React.createElement("div", { className: "we-qp__row" },
          React.createElement("select", {
            className: "we-picker__select we-qp__group",
            value: sel.rotationGroupId,
            onChange: onGroupChange,
            disabled: groups.length === 0,
            "aria-label": "轮播列表",
          },
            React.createElement("option", { value: "" }, groups.length ? "— 选择轮播列表 —" : "— 暂无轮播列表 —"),
            ...groups.map((g) => React.createElement("option", {
              key: g.id, value: g.id,
            }, g.name + "（" + groupWallpapers(g).length + " 可播放 · " + g.interval + " 分钟）")),
          ),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onNextWallpaper,
            disabled: (sel.rotationEnabled ? rotationCandidates() : playable).length < 2,
            title: "切到下一张（轮播开着按活动列表、关着按可播放网格）",
          }, "下一张"),
        ),
        switchRow("自动轮播", sel.rotationEnabled === true, () => onToggleRotation(), {
          hint: groups.length ? "按所选列表定时切换" : "先到设置页新建一个轮播列表",
        }),
      ),
      // ── ③ 壁纸列表（搜索 + 视图切换 + 快切）──
      React.createElement("div", { className: "we-qp__section we-qp__library" },
        React.createElement("div", { className: "we-qp__viewbar" },
          React.createElement("input", {
            className: "we-picker__text we-qp__search", type: "text",
            value: sel.qpSearch || "",
            placeholder: "搜索壁纸标题…",
            "aria-label": "搜索壁纸标题",
            onInput: (e) => { setTransient("qpSearch", e.target.value); emit(); },
          }),
          // 类型筛选：面板本地（全部 / 场景 / 网页 / 视频），瞬态不落盘；
          // 与设置页的「类型」过滤互不影响（那一条筛设置页列表与轮播候选），
          // 两处都只筛「列表」，不拦正在应用的壁纸。
          React.createElement("select", {
            className: "we-picker__select we-qp__type",
            value: typeFilter,
            onChange: (e) => { setTransient("qpType", e.target.value); emit(); },
            "aria-label": "类型筛选",
            title: "按类型筛选侧栏列表（只影响这里）",
          },
          ...QP_TYPES.map((t) => React.createElement("option", { key: t.id, value: t.id }, t.label)),
          ),
          // 列表 / 卡片：偏好记 localStorage（QP_VIEW_KEY），两个壳共用一份。
          React.createElement("div", { className: "we-picker__seg", role: "group", "aria-label": "视图" },
            React.createElement("button", {
              className: "we-picker__btn we-picker__rate" + (view !== "cards" ? " we-picker__rate--active" : ""),
              type: "button",
              "aria-pressed": view !== "cards" ? "true" : "false",
              onClick: () => switchView("list"),
            }, "列表"),
            React.createElement("button", {
              className: "we-picker__btn we-picker__rate" + (view === "cards" ? " we-picker__rate--active" : ""),
              type: "button",
              "aria-pressed": view === "cards" ? "true" : "false",
              onClick: () => switchView("cards"),
            }, "卡片"),
          ),
        ),
        React.createElement("div", {
          className: "we-qp__list" + (view === "cards" ? " we-qp__list--cards" : ""),
          role: "listbox", "aria-label": "壁纸列表",
        },
          rows.length
            ? rows.map(view === "cards" ? renderCard : renderRow)
            : React.createElement("span", { className: "we-picker__hint" },
                q ? "没有匹配「" + sel.qpSearch + "」的壁纸"
                  : (typeFilter !== "all" ? "该类型下没有可播放的壁纸" : "没有可播放的壁纸")),
        ),
        filtered.length > rows.length
          && React.createElement("span", { className: "we-picker__hint we-qp__more" },
              "还有 " + (filtered.length - rows.length) + " 张未显示 · 搜索可收敛，全量浏览在设置页"),
      ),
      // ── ④ 声音（系统音频反应 / 媒体信息 / 在线歌词已退役为常开 —— schema
      //    kind 'const'，面板不再提供开关，见 lib/settings-schema.js）──
      React.createElement("div", { className: "we-qp__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "声音"),
        ),
        SliderRow("音量", 0, 100, 5,
          Math.round((Number(sel.videoVolume) || 0) * 100), onVideoVolume,
          Math.round((Number(sel.videoVolume) || 0) * 100) + "%"),
        switchRow("壁纸音轨", sel.videoAudioEnabled !== false, () => onToggleAudio(), {
          tooltip: "视频壁纸与场景壁纸（内嵌 MP4 音轨 / 包内独立音频）共用；默认静音，开启时若音量为 0 会自动提到 50%",
        }),
      ),
      // ── ⑤ 底栏：设置入口 ──
      React.createElement("div", { className: "we-qp__foot" },
        React.createElement("button", {
          className: "we-picker__btn we-qp__settings", type: "button",
          "data-we-qp-entry": "1",
          onClick: openSettingsSection,
          title: "打开设置对话框的「壁纸引擎」分区（外观 / 播放 / 系统与全部配置）",
        }, "壁纸引擎设置 ›"),
      ),
    );
  }
