/**
 * panel-tabs.js — 面板页签的**渲染器**（六个域：壁纸 / 外观 / 吉祥物 / 效果 / 声音 / 高级，
 * 组合成四页签 壁纸库 / 外观 / 播放 / 系统，装配点见 src/client.js 的 renderActiveTab）。
 *
 * 为什么单独一个文件：这六个渲染器共 **1,240 行**，此前是 `WallpaperPicker` 内部的六个闭包
 * （夹在 2,400 行的组件体里）。它们**读**面板状态、**调**面板处理器，但自己不持有状态 ——
 * 正是最适合搬出去的一层。搬出后：面板组件体只剩"状态 + 处理器 + 装配"，页签怎么画看这里。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域"=
 * 同一 prelude / src/client.js 的顶层）：
 *   · 每个渲染器**只从一个参数取外界**：`(ctx)`。函数体**逐字搬入**，唯一改动是开头那段
 *     解构 —— 于是"这个页签要什么"写在签名处，"怎么画"一行没动（模板字符串里的有效空白
 *     也不会被批量重排弄坏）。
 *   · ctx 由 `WallpaperPicker` 在调用点就地组装（见 src/client.js 的 `renderActiveTab`）：
 *     面板的 `sel` / 页签需要的局部视图状态 / 处理器。**多传字段无害，漏传会当场
 *     ReferenceError**（守卫会抓住）—— 这是刻意选的失败方式：响亮且可定位。
 *   · 页签**不得**写 selection / 不得 emit：写设置是处理器的职责（它们仍住在面板组件里）。
 *     页签只做"读 + 组装 React 树"。
 *   · 模块级依赖（React / SliderRow / switchRow / ctlText / FRAME_VARIANTS / 各类预设表…）
 *     仍按内联规则直接读，不经过 ctx —— 它们是常量与纯组件，与面板状态无关。
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 */

  function renderWallpaperTab(ctx) {
    const { setSetting, setTransient, INTERVALS, armedConfirm, cdMode, current, editing, editorPageView, group, groups, isLiveScene, onArmConfirm, onArmDeleteGroup, onClear, onDeleteGroup, onDisarmConfirm, onGroupChange, onGroupInterval, onRefresh, onSwitchTransition, onSwitchTransitionDir, onSwitchTransitionSpeed, onToggleAudio, onTogglePlay, onToggleRotation, pagerRow, playableCount, playableList, playbackLive, renderUserPropsPanel, sel, uploadedList } = ctx;
    // 当前过场（类型 + 方向 + 实测算出的毫秒）：一次算好给三行控件用。
    const switchTr = switchTransitionOf(sel);
    // 待确认令牌按**当前对象**现算（不是常量缓存）：换列表 / 换壁纸后老问句自然不再匹配。
    const groupToken = group ? "group:" + group.id : "";
    const uploadToken = (w) => "upload:" + w.id;
    return React.createElement(React.Fragment, null,
      // ── 当前壁纸: vinyl record beside the selection, in both card styles. ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "当前壁纸"),
        ),
        React.createElement("div", { className: "we-picker__current" },
          React.createElement(VinylRecord, {
            cover: current && current.preview, title: current ? current.title : "",
            playing: playbackLive && Boolean(sel.url) && vinylSpinVisible(),
          }),
          React.createElement("div", { className: "we-picker__current-info" },
            React.createElement("div", { className: "we-picker__current-title", title: current ? current.title : "" },
              sel.id && current ? current.title : "未选择壁纸",
              // 类型 + 播放态：宽卡片里另起一行；抽屉（窄容器）里由 CSS 改成
              // 「名称（类型 · 播放中）」同一行，整行超出省略（见 .we-repo-panel 规则）。
              React.createElement("span", { className: "we-picker__current-meta" },
                current
                  ? ({ video: "视频壁纸", web: "网页壁纸", image: "图片壁纸", scene: isLiveScene ? "场景壁纸（实时渲染）" : "场景壁纸（静态帧）" }[current.type] || "壁纸") + (playbackLive ? " · 播放中" : " · 已暂停")
                  : "尚未选择壁纸")),
            // 失败/被过滤的原因说明包一层：抽屉里该层用 display:contents 展开成
            // grid 项（标题已独走第一行），靠这个包裹层保证「一行一项」。
            React.createElement("div", { className: "we-picker__current-sub" },
            // 播放失败原因（#84）: 浏览器解不了的编码 / 解码失败等，过去是
            // 「静默空白」，现在给出可读原因，配合下面的「播放」按钮重试。
            sel.videoError && React.createElement("div", { className: "we-picker__current-error" }, sel.videoError),
            // 选择被过滤条件排除（#84）: 过去壁纸层直接空白、按钮变灰且无任何
            // 说明，现在明确指出是哪一项过滤挡住了、怎么恢复。
            sel.blockedNote && React.createElement("div", { className: "we-picker__current-error" }, sel.blockedNote),
            // 实时渲染失败原因（自动回退到旧链时显示）：让「为什么黑」可见 ——
            // 用户反馈时能直接说明，也提示了重试入口（重开「实时渲染」开关）。
            liveFailReasonOf(sel) && React.createElement("div", { className: "we-picker__current-error" },
              "实时渲染失败（" + liveFailReasonOf(sel) + "），已自动回退；重新打开「实时渲染」开关可重试",)
            ),
          ),
          // 主操作区：选择壁纸（下钻库视图）。壁纸属性入口移到下面那排播放控制里、
          // 排在「暂停」之前（同排同级、同款式），见下方的控件行。
          React.createElement("div", { className: "we-picker__current-actions" },
            React.createElement("button", {
              className: "we-picker__btn we-picker__btn--primary", type: "button",
              ref: (el) => { pickerOpener = el; },
              onClick: () => {
                setTransient("pickerOpen", true);
                setTransient("pickerDraft", false); // 普通下钻（点卡片即应用）
                setTransient("modalView", "normal");
                pickerFocusPending = true; // 打开后焦点落入下钻视图（见 modalInitialFocus）
                emit();
              },
            }, "选择壁纸"),
          ),
        ),
        // 属性面板紧贴卡片下方（同一节里），抽屉/弹窗两种形态都可见。
        renderUserPropsPanel(),
        // Playback controls (wallpaper-independent; the thumbnail grid lives in
        // the modal above, so these stay within reach).
        React.createElement("div", { className: "we-picker__row" },
          // 壁纸属性（仅场景/网页壁纸 + 有 propsUrl）：与播放控制同排、同款式
          //（普通 .we-picker__btn；面板开着时 is-on 高亮）——入口与播放控制同级更顺手。
          (current && (current.type === "scene" || current.type === "web") && sel.propsUrl)
            && React.createElement("button", {
              className: "we-picker__btn" + (propsPanelOpen ? " is-on" : ""),
              type: "button",
              title: "壁纸作者提供的可调属性（改动立即生效）",
              onClick: () => {
                propsPanelOpen = !propsPanelOpen;
                if (propsPanelOpen) loadUserPropDefs(propTokenOf(sel), true);
                emit();
              },
            }, "壁纸属性"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onTogglePlay, disabled: !sel.url,
            // 按钮显示真实状态（#84）: 播放失败时回到「播放」，就是用户要的「继续」。
          }, playbackLive ? "暂停" : "播放"),
          // 音乐开关：与「播放」同级的一键切换。只影响音轨，不动播放态 ——
          // 关掉后画面继续播放。仅对含音轨的壁纸类型显示（视频 / 场景内嵌 MP4）。
          (sel.type === "video" || (sel.type === "scene" && (sel.sceneVideo || sel.sceneHasAudio)))
            && React.createElement("button", {
              className: "we-picker__btn" + (weAudioVolume() > 0 || sel.videoAudioEnabled === false ? "" : " is-on"),
              type: "button",
              onClick: onToggleAudio,
              disabled: !sel.url,
              title: sel.videoAudioEnabled === false
                ? "开启壁纸音轨（音量为 0 时自动设为 50%）"
                : "关闭壁纸音轨（画面继续播放）",
            }, sel.videoAudioEnabled === false ? "🔇 音乐关" : "🔊 音乐开"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onClear, disabled: !sel.id,
            title: "清除当前壁纸（停止播放，回到无壁纸状态）",
          }, "清除"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onRefresh, disabled: sel.loading,
          }, sel.loading ? "刷新中…" : "刷新"),
        ),
      ),
      // ── 切换过场（手动点选与自动轮播共用）：类型 / 方向 / 速度 ──
      // 默认「硬切」（零成本、零风险）；等「最帅的」讨论定下来，改 DEFAULTS 一处
      // 即可换默认。每种过场只动 transform / opacity / clip-path（见 switchFrames）。
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "切换过场"),
        ),
        // 过场动画：**下拉菜单**（不用水平平铺）—— 过场会持续增加，平铺一排按钮
        // 迟早挤成两行、还会把「方向 / 时长」挤下去；下拉天然可扩展。
        React.createElement("div", { className: "we-picker__ctl" },
          ctlText("过场动画", "换壁纸时的转场"),
          React.createElement("select", {
            className: "we-picker__select",
            value: sel.switchTransition,
            onChange: (e) => onSwitchTransition(e.target.value),
            "aria-label": "过场动画",
          },
            ...SWITCH_TRANSITIONS.map((t) =>
              React.createElement("option", { key: t.id, value: t.id }, t.label)),
          ),
        ),
        // 方向：只有方向型过场（推移 / 擦除 / 条带）听它；条带用它决定竖条 / 横条。
        switchTr.directional && React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
          ctlText("方向", "新画面从哪边进"),
          React.createElement("div", { className: "we-picker__seg" },
            SWITCH_DIRS.map((d) =>
              React.createElement("button", {
                key: d,
                className: "we-picker__btn we-picker__rate" + (sel.switchTransitionDir === d ? " we-picker__rate--active" : ""),
                type: "button",
                onClick: () => onSwitchTransitionDir(d),
                "aria-pressed": sel.switchTransitionDir === d ? "true" : "false",
                "aria-label": "过场方向 " + SWITCH_DIR_LABELS[d],
              }, SWITCH_DIR_LABELS[d]),
            ),
          ),
        ),
        // 时长档：只影响速度乘子，基准时长写在各过场里（见 SWITCH_TRANSITIONS）。
        switchTr.ms > 0 && React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
          ctlText("时长", "当前约 " + switchTr.ms + " ms"),
          React.createElement("div", { className: "we-picker__seg" },
            SWITCH_SPEEDS.map((s) =>
              React.createElement("button", {
                key: s.id,
                className: "we-picker__btn we-picker__rate" + (sel.switchTransitionSpeed === s.id ? " we-picker__rate--active" : ""),
                type: "button",
                onClick: () => onSwitchTransitionSpeed(s.id),
                "aria-pressed": sel.switchTransitionSpeed === s.id ? "true" : "false",
                "aria-label": "过场速度 " + s.label,
              }, s.label),
            ),
          ),
        ),
      ),
      // ── 自动轮播（原「轮播列表」）: user-defined carousel lists, each with its own
      //    wallpaper set, interval and order. Persisted as `rotationGroups` (host config.json). ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "自动轮播"),
        ),
        React.createElement("div", { className: "we-picker__row we-picker__playlist-row" },
        React.createElement("select", {
          className: "we-picker__playlist-select",
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
          onClick: startCreateGroup,
        }, "新建"),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          onClick: () => startEditGroup(sel.rotationGroupId),
          disabled: !sel.rotationGroupId,
        }, "编辑"),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          // 第一下只置令牌（`onArmDeleteGroup`）；落地在下面那行问句的「确认」里。
          // 待确认时**置灰**（不隐藏、不换位置）：按钮仍占着那一格，宽度就完全不变，
          // 而且它指路到问句行 —— 留着可点会让"再点一下是不是就删了"变成猜测。
          onClick: onArmDeleteGroup,
          disabled: !sel.rotationGroupId || armedConfirm === groupToken,
          title: armedConfirm === groupToken
            ? "已经问过你了 —— 在下面那一行选「确认」或「取消」"
            : "删除这个轮播列表（会再问一次）",
        }, "删除"),
      ),
      renderConfirmRow(armedConfirm, groupToken,
        "删除轮播列表「" + ((group && group.name) || "") + "」？此操作不可恢复。",
        onDeleteGroup, onDisarmConfirm),
      editing && React.createElement("div", { className: "we-picker__editor" },
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "名称"),
          React.createElement("input", {
            className: "we-picker__text", type: "text",
            value: editing.name,
            "aria-label": "轮播列表名称",
            onInput: (e) => { editing.name = e.target.value; emit(); },
          }),
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "间隔"),
          React.createElement("select", {
            className: "we-picker__rotation-interval",
            value: String(editing.interval),
            onChange: (e) => { editing.interval = clampNum(Number(e.target.value), 1, 1440, DEFAULTS.rotationInterval); emit(); },
            "aria-label": "轮播间隔",
          },
          ...INTERVALS.map((minutes) =>
            React.createElement("option", { key: minutes, value: String(minutes) }, minutes + " 分钟"),
          )),
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "顺序"),
          React.createElement("select", {
            className: "we-picker__playlist-select",
            value: editing.order,
            onChange: (e) => { editing.order = e.target.value; emit(); },
            "aria-label": "轮播顺序",
          },
          React.createElement("option", { value: "sequence" }, "顺序"),
          React.createElement("option", { value: "random" }, "随机"),
          ),
        ),
        // 选片走**页内下钻**（与「选择壁纸」同一套库视图）：点按钮进库浏览，
        // 卡片点击 = 加入/移出草稿（pickerDraft），顶部提示已选数；「返回」回编辑器。
        // 编辑器的内联多选网格（editor-grid + 分页）已退役 —— 大库在 24px 缩略图里
        // 翻页选片不可用，全尺寸浏览 + 搜索/过滤才是选片的正确形态。
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("button", {
            className: "we-picker__btn we-picker__btn--primary", type: "button",
            onClick: () => {
              setTransient("pickerOpen", true);
              setTransient("pickerDraft", true);
              setTransient("modalView", "normal");
              pickerFocusPending = true;
              emit();
            },
          }, "选择壁纸"),
          React.createElement("span", { className: "we-picker__hint" },
            "下钻进库挑选 · 点卡片加入 / 移出"),
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint" }, "已选 " + editing.wallpaperIds.length + " 个"),
          sel.inventory.playlists.length > 0 && React.createElement("select", {
            className: "we-picker__playlist-select",
            value: "",
            onChange: (e) => {
              const p = sel.inventory.playlists.find((pl) => pl.id === e.target.value);
              if (p) importPlaylistIntoDraft(p);
            },
          },
          React.createElement("option", { value: "" }, "从 WE 播放列表导入…"),
          ...sel.inventory.playlists.map((p) => React.createElement("option", {
            key: p.id, value: p.id,
          }, p.name + "（" + (p.portableCount || 0) + " 可播放）")),
          ),
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: saveEditingGroup,
          }, "保存"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: cancelEditGroup,
          }, "取消"),
        ),
      ),
      React.createElement("div", { className: "we-picker__ctl" },
        ctlText("自动轮转",
          !sel.rotationGroupId
            ? "请先选择或新建一个轮播列表"
            : playableCount < 2
              ? "当前列表至少需要 2 个可播放壁纸"
              : "每 " + (group ? group.interval : DEFAULTS.rotationInterval) + " 分钟切换一次"),
        React.createElement("div", { className: "we-picker__ctl-side" },
          React.createElement("select", {
            className: "we-picker__rotation-interval",
            value: String(group ? group.interval : DEFAULTS.rotationInterval),
            onChange: onGroupInterval,
            disabled: !sel.rotationEnabled || !sel.rotationGroupId || playableCount < 2,
            "aria-label": "轮转间隔",
          },
          ...INTERVALS.map((minutes) =>
            React.createElement("option", { key: minutes, value: String(minutes) }, minutes + " 分钟"),
          )),
          Toggle({
            checked: sel.rotationEnabled,
            onChange: onToggleRotation,
            label: "自动轮转",
            disabled: !sel.rotationGroupId || playableCount < 2,
            title: "按列表顺序/随机自动切换壁纸",
          }),
        ),
      ),
      ),
      // ── 自定义壁纸: local JPG/PNG/MP4 as wallpapers. Files are written by the
      //    host into its plugin-managed directory and served through the same
      //    media/preview routes (read-A storage: survives restarts, no quota
      //    limits). Uploads merge into the inventory on the host side. ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "自定义壁纸"),
        ),
        React.createElement("div", { className: "we-picker__uploads" },
        // Storage location — users can point uploads at a non-system drive
        // (most people don't want wallpaper files piling up on C:). The host
        // persists the choice and migrates existing files on change.
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "存储位置"),
          React.createElement("span", {
            className: "we-picker__uploads-path",
          }, sel.inventory.uploadDir || "—"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            disabled: sel.uploading,
            onClick: () => {
              setTransient("editingUploadDir", true);
              setTransient("uploadDirDraft", sel.inventory.uploadDir || "");
              emit();
            },
          }, "更改"),
        ),
        sel.editingUploadDir && React.createElement("div", { className: "we-picker__row" },
          React.createElement("input", {
            className: "we-picker__text", type: "text",
            value: sel.uploadDirDraft,
            placeholder: "绝对路径，如 D:\\MyWallpapers",
            onInput: (e) => { setTransient("uploadDirDraft", e.target.value); emit(); },
            onKeyDown: (e) => {
              if (e.key === "Enter") changeUploadDir(sel.uploadDirDraft, true);
              if (e.key === "Escape") { setTransient("editingUploadDir", false); emit(); }
            },
          }),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            disabled: sel.uploading,
            onClick: () => changeUploadDir(sel.uploadDirDraft, true),
          }, "保存"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: () => { setTransient("editingUploadDir", false); emit(); },
          }, "取消"),
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint" },
            "已有文件会迁移到新位置"),
          React.createElement("span", { className: "we-picker__hint" },
            "支持 ~ 表示用户主目录"),
        ),
        // ── 官方资源路径（local-assets）：场景实时渲染的 util、particle、
        // gradient 贴图默认是程序化复刻（观感近似）；指向本机 WE 安装目录的
        // assets 树后按名取官方像素，与官方引擎逐像素对齐。素材属 WE 版权
        // 内容，只从本机路径只读取用，不会被复制/上传。路径不硬编码 ——
        // 持久化在宿主 config.json（weAssetsDir），经 we-assets-dir 端点读写。
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "官方资源路径"),
          React.createElement("span", {
            className: "we-picker__uploads-path",
          }, sel.inventory.weAssetsDir || "—"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: () => {
              setTransient("editingWeAssetsDir", true);
              setTransient("weAssetsDirDraft", sel.inventory.weAssetsDir || "");
              setTransient("weAssetsError", "");
              emit();
            },
          }, sel.inventory.weAssetsDir ? "更改" : "设置"),
        ),
        sel.editingWeAssetsDir && React.createElement("div", { className: "we-picker__row" },
          React.createElement("input", {
            className: "we-picker__text", type: "text",
            value: sel.weAssetsDirDraft,
            placeholder: "WE assets 绝对路径，留空保存=清除",
            onInput: (e) => { setTransient("weAssetsDirDraft", e.target.value); emit(); },
            onKeyDown: (e) => {
              if (e.key === "Enter") changeWeAssetsDir(sel.weAssetsDirDraft);
              if (e.key === "Escape") { setTransient("editingWeAssetsDir", false); setTransient("weAssetsError", ""); emit(); }
            },
          }),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: () => changeWeAssetsDir(sel.weAssetsDirDraft),
          }, "保存"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: () => { setTransient("editingWeAssetsDir", false); setTransient("weAssetsError", ""); emit(); },
          }, "取消"),
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint" },
            sel.inventory.weAssetsAvailable
              ? "已启用 · 场景实时渲染取官方像素"
              : (sel.inventory.weAssetsDir
                ? "目录不可用（缺 materials/），场景实时渲染走程序化复刻"
                : "未配置 · 场景实时渲染贴图走程序化复刻")),
          React.createElement("span", { className: "we-picker__hint" },
            "指向 Wallpaper Engine 安装目录的 assets（或其拷贝）"),
        ),
        sel.weAssetsError && React.createElement("div", { className: "we-picker__error" },
          sel.weAssetsError,
        ),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint we-picker__label" }, "自定义"),
          React.createElement("input", {
            className: "we-picker__file", type: "file",
            accept: ".jpg,.jpeg,.png,.mp4",
            disabled: sel.uploading,
            onChange: (e) => {
              const f = e.target.files && e.target.files[0];
              if (f) uploadWallpaperFile(f);
              e.target.value = "";
            },
          }),
          sel.uploading && React.createElement("span", { className: "we-picker__hint" }, "上传中…"),
        ),
        sel.uploadError && React.createElement("div", { className: "we-picker__error" }, sel.uploadError),
        sel.uploadNote && React.createElement("div", { className: "we-picker__note" }, sel.uploadNote),
        React.createElement("div", { className: "we-picker__row" },
          React.createElement("span", { className: "we-picker__hint" }, "已上传 " + uploadedList.length + " 个"),
          React.createElement("span", { className: "we-picker__hint" }, "支持 JPG / PNG / MP4，及含 project.json 的 WE 壁纸目录"),
        ),
        uploadedList.length > 0 && React.createElement("div", { className: "we-picker__uploads-list" },
          uploadedList.map((w) => React.createElement(React.Fragment, { key: w.id },
            React.createElement("div", { className: "we-picker__uploads-item" },
            React.createElement("span", { className: "we-picker__uploads-name", title: w.title }, w.title),
            React.createElement("span", { className: "we-picker__hint" }, w.type === "video" ? "MP4" : "图片"),
            React.createElement("button", {
              className: "we-picker__btn", type: "button",
              // **会删本地文件** ⇒ 这一处最需要两下：第一下只置令牌。
              onClick: () => onArmConfirm(uploadToken(w)),
              disabled: sel.uploading || armedConfirm === uploadToken(w),
              title: armedConfirm === uploadToken(w)
                ? "已经问过你了 —— 在下面那一行选「确认」或「取消」"
                : "移除这个自定义壁纸（会再问一次，且会删除本地文件）",
            }, "移除"),
            ),
            // 问句行紧跟它自己那一项（挂在同一个 `key` 下，位置不会串到别的壁纸那里）。
            renderConfirmRow(armedConfirm, uploadToken(w),
              "移除自定义壁纸「" + w.title + "」？此操作会删除本地文件，且不可恢复。",
              () => removeUploadWallpaper(w.id), onDisarmConfirm),
          )),
        ),
        ),
      ),
      React.createElement("div", { className: "we-picker__row" },
        React.createElement("span", { className: "we-picker__hint" },
          (group
            ? "列表「" + group.name + "」：" + group.wallpaperIds.length + " 项 · " + playableCount + " 可播放 · 每 " + group.interval + " 分钟 · " + (group.order === "random" ? "随机" : "顺序")
            : playableList.length + " 个可播放壁纸") +
          (sel.rotationEnabled ? " · 自动轮转中" : "")),
      ),
    );
  }


  function renderAppearanceTab(ctx) {
    const { setSetting, officialColorOf, onAccent, onBlur, onBorder, onCaretColor, onComponentFamily, onComponentFont, onFontAdvanced, onFontResetAll, onGlassAlpha, onGlassColor, onSidebarAlpha, onSidebarBlur, onSidebarColor, onSidebarContentAlpha, onSidebarContentColor, onThemeColor, onThemeColorClear, onThemeDarkSeparate, onThemeFamily, onThemeSize, onThemeTypeOnly, onThemeWeight, onToggleFontCustom, onToggleThemeFollow, fontSet, sel } = ctx;
    // 「排版角色」表要按「只看改过的」筛，而**筛完是空**时要单独给一行提示 ⇒ 先算出来再渲染表。
    // ⚠️ 必须在 `React.createElement(...)` **之前**算（写成参数位置上的赋值表达式 ——
    //    赋值表达式的值是那个**数组本身**，于是它被当成一个子节点 ⇒ React #31「对象不能作为子节点」；
    //    空数组时看不出来，一旦有筛出来的角色就整块面板崩掉）。
    const typeRoles = THEME_TYPE_ROLES.filter((role) => !sel.themeTypeOnly
      || sel.themeSize[role.id] !== undefined
      || sel.themeWeight[role.id] !== undefined
      || sel.themeFamily[role.id] !== undefined);
    return React.createElement(React.Fragment, null,
      // ── 主题：配色（accent）+ 玻璃基底（颜色/透明度）──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "主题"),
        ),
        // 主题随壁纸：总开关（**默认关** = 不按壁纸自动改深浅主题；**试验性功能**，行内已标注）。
        // 开着时才取色判决，并把**最近一次结论**摊开（"为什么判成浅色"要能当场答）；
        // 关着时这个功能整体不生效。见 src/theme-follow.js。
        switchRow("主题随壁纸", sel.themeFollow === true, (e) => onToggleThemeFollow(e.target.checked), {
          key: "theme-follow",
          hint: "试验性功能 · 关 = 不按壁纸自动改深浅主题（默认关）",
          tooltip: "试验性功能：开着时按当前壁纸自动切全局深/浅：作者配色 → 画面主色，两条腿不一致时取深色；"
            + "在 DSH 设置里手动改过主题后，本张壁纸不再自动。关（默认）时这个功能整体不生效："
            + "不取色、不判决、不改主题；切换开关立刻生效。",
        }),
        sel.themeFollow === true && sel.themeFollowLine
          && React.createElement("div", { className: "we-picker__hint", key: "theme-follow-line" },
            "当前：" + sel.themeFollowLine),
        swatchRow("配色", ACCENT_PRESETS, sel.accent, onAccent, { key: "accent" }),
        // 玻璃颜色: the settings-window glass BASE tint. Defaults keep the stock
        // look (white light / deep navy dark); picking any preset or a custom
        // color tints the whole window glass in BOTH themes.
        swatchRow("玻璃颜色", GLASS_COLOR_PRESETS, sel.glassColor, onGlassColor, { key: "glass-color" }),
        SliderRow("玻璃透明度", 0, 60, 5, sel.glassAlpha, onGlassAlpha, sel.glassAlpha + "%"),
      ),
      // ── 细节：玻璃雾化深度 + 边框强调（原「效果」页签的两个材质细调项，
      //    与「主题」同属全局外观，故并入本页签）。──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "细节"),
        ),
        // 「雾化」= 原「玻璃」滑块：控制的只有模糊半径（雾面深度），饱和度是解耦
        // 的常量材料属性（见 GLASS_SATURATE）。改名是为了不与同组的「玻璃颜色 /
        // 玻璃透明度」字面撞车。
        SliderRow("雾化", 0, 60, 1, sel.blur, onBlur, sel.blur + "px", "glass-frost", {
          tooltip: "玻璃面板（设置窗口、输入栏、气泡、侧栏）的模糊半径 —— 越大越像磨砂玻璃；色彩饱和度不随本滑块变化",
        }),
        SliderRow("边框", 0, 90, 5, Math.round(sel.border * 100), onBorder, Math.round(sel.border * 100) + "%", "border-emphasis", {
          tooltip: "提高边框 / 分割线的对比度（浅色与深色主题通用）",
        }),
      ),
      // ── 字体 (custom typography)：原「字体」页签并入「外观」——总开关（关 =
      //    恢复 dsh 原生字体）+ 颜色角色 / 排版角色 / 字体族 / 组件字体（高级），
      //    开启时才渲染细节控件。字重不设全局值：按角色与按组件细化。 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "全局字体"),
        ),
        switchRow("字体自定义", sel.fontCustom, (e) => onToggleFontCustom(e.target.checked), {
          tooltip: "关闭后恢复 dsh 默认字体外观；开启后可调颜色角色、排版角色（字号/字重/字族）与组件字体",
        }),
        // 「恢复默认」只在总开关开启时出现：关闭时字体本就是 DSH 默认值，摆一个"恢复默认"
        // 没有意义（也会让人以为关掉开关还残留了什么自定义）。
        sel.fontCustom && React.createElement("div", { className: "we-picker__ctl" },
          React.createElement("button", {
            type: "button",
            className: "we-picker__chip",
            onClick: onFontResetAll,
            title: "清空所有字体自定义项（颜色角色 / 排版 / 字重 / 字族 / 组件字体），回到 DSH 默认",
          }, "恢复默认"),
        ),
        sel.fontCustom && React.createElement(React.Fragment, null,
          // F1：分角色上色。原「字体颜色」把四个角色压成同一个色（把 DSH 的四级文字层次
          // 压平）—— 那条全局折叠路径已随全局字体层删除；这里逐个角色放开，留空 = 跟随
          // 原生。经 theme 令牌层生效：body 内联、免 !important、{light,dark} 随配色自动换值。
          React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
            ctlText("文字颜色角色", "未设置 = 用 DSH 默认色（色块显示当前值）"),
          ),
          switchRow("深色单独设置", sel.themeDarkSeparate, (e) => onThemeDarkSeparate(e.target.checked), {
            tooltip: "关闭时一个颜色同时用于浅色与深色两套（内部仍存两套值）；开启后浅色/深色分别设置",
          }),
          THEME_COLOR_ROLES.map((role) => {
            const v = sel.themeColors[role.id] || { light: "", dark: "" };
            return React.createElement("div", { className: "we-picker__ctl", key: role.id },
              ctlText(role.label),
              React.createElement("label", { className: "we-picker__swatch-custom" },
                React.createElement("input", {
                  type: "color",
                  value: v.light || officialColorOf(role.tokens) || "#ffffff",
                  onInput: (e) => onThemeColor(role.id, "light", e.target.value, sel.themeDarkSeparate),
                  onChange: (e) => onThemeColor(role.id, "light", e.target.value, sel.themeDarkSeparate),
                  title: role.label + " · 浅色配色",
                }),
                React.createElement("span", { className: "we-picker__hint we-picker__value" },
                  v.light ? "浅 " + v.light : (officialColorOf(role.tokens) || "跟随")),
              ),
              sel.themeDarkSeparate && React.createElement("label", { className: "we-picker__swatch-custom" },
                React.createElement("input", {
                  type: "color",
                  value: v.dark || officialColorOf(role.tokens) || "#000000",
                  onInput: (e) => onThemeColor(role.id, "dark", e.target.value, true),
                  onChange: (e) => onThemeColor(role.id, "dark", e.target.value, true),
                  title: role.label + " · 深色配色",
                }),
                React.createElement("span", { className: "we-picker__hint we-picker__value" },
                  v.dark ? "深 " + v.dark : (officialColorOf(role.tokens) || "跟随")),
              ),
              (v.light || v.dark) && React.createElement("button", {
                type: "button",
                className: "we-picker__chip",
                onClick: () => onThemeColorClear(role.id),
                title: "清除该角色，回到原生层次",
              }, "清除"),
            );
          }),
          // F2/G4：排版角色（**绝对字号**）。用户口径：字号用绝对值、默认值可见 ——
          // 未填时输入框显示 DSH 官方字号（角色表的 defaultPx），清空即回它。
          // 已确认接受的副作用：设过绝对值的角色不再随 DSH「通用 → 字号」缩放（未设的照旧跟随）；
          // 行高一律沿用 DSH 的令牌，不随绝对值缩放。我们始终**不写** --dsh-content-font-size（红线 3）。
          React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
            ctlText("排版角色", "字号 px；留空 = 不改（字号/字重显示 DSH 当前值，字族选「跟随」）"),
          ),
          switchRow("只看改过的", sel.themeTypeOnly, (e) => onThemeTypeOnly(e.target.checked), {
            tooltip: "只列出改过字号/字重/字族的角色，便于收尾核对",
          }),
          // 表格化：表头放「字号 / 字重 / 字体」，一行一个角色 —— 三项在固定列上对齐，
          // 比每行重复三个无标签控件好扫读（颜色角色那张形状不同，仍用行式）。
          // 「只看改过的」**默认开** ⇒ 一行都没改过时表是空的：那种"空表"必须有话说，
          // 否则看着像坏了（这也是把默认值翻成开之后必须同时补的一件事）。
          typeRoles.length === 0
            ? React.createElement("div", { className: "we-picker__hint" },
              "没有改过的角色 —— 「只看改过的」正开着（共 " + THEME_TYPE_ROLES.length + " 个角色）。关掉它就能看到全部。")
            : null,
          React.createElement("table", { className: "we-picker__font-table" },
            React.createElement("thead", null,
              React.createElement("tr", null,
                React.createElement("th", null, "角色"),
                React.createElement("th", null, "字号"),
                React.createElement("th", null, "字重"),
                React.createElement("th", null, "字体"),
              ),
            ),
            React.createElement("tbody", null,
          typeRoles
            .map((role) => {
              const size = sel.themeSize[role.id];
              return React.createElement("tr", { key: role.id },
                React.createElement("td", null, ctlText(role.label)),
                React.createElement("td", null, React.createElement("input", {
                  type: "number",
                  value: size === undefined ? role.defaultPx : size,
                  min: THEME_SIZE_MIN,
                  max: THEME_SIZE_MAX,
                  step: 1,
                  style: { width: "46px" },
                  onChange: (e) => onThemeSize(role.id, e.target.value),
                  title: role.label + "：字号 px（清空即回 DSH 默认 " + role.defaultPx + "px）",
                })),
                React.createElement("td", null, React.createElement("input", {
                  type: "number",
                  value: sel.themeWeight[role.id] === undefined
                    ? (role.prefix ? Number(role.prefix) : 400)
                    : sel.themeWeight[role.id],
                  min: 100,
                  max: 900,
                  step: 100,
                  style: { width: "54px" },
                  onChange: (e) => onThemeWeight(role.id, e.target.value),
                  title: role.label + "：字重 100–900（清空即回默认）",
                })),
                React.createElement("td", null, React.createElement("select", {
                  value: sel.themeFamily[role.id] === undefined ? "" : sel.themeFamily[role.id],
                  style: { width: "92px" },
                  onChange: (e) => onThemeFamily(role.id, e.target.value),
                  title: role.label + "：字族（跟随 = 不覆盖，用 DSH 该角色的字族）",
                },
                  React.createElement("option", { value: "" }, "跟随"),
                  FONT_FAMILY_LABELS.map((f) =>
                    React.createElement("option", { key: f.v, value: f.v }, f.label)),
                )),
              );
            }),
            ),
          ),
          // G3/G4：组件字体 —— 属"高级"，收进本区内的「高级字体设置」子分支
          //（是"字体"的子分支，**不是**「高级」页签）。三条来自静态分析的纪律：
          //   ① 命中靠启动自探测（未命中的组件整条不生效，改名即降级、不误伤）；
          //   ② 代码块/终端的字体来自后代 `font:` 简写 ⇒ 只有官方 `--dsl-*` 钩子这条腿有效；
          //   ③ 不填 = 不生成规则（DSH 官方值）。
          switchRow("高级字体设置", sel.fontAdvanced, (e) => onFontAdvanced(e.target.checked), {
            tooltip: "按组件细化（模块前缀通道 + 官方 --dsl-* 钩子）：只对探测到的组件生效；不填即用 DSH 默认值",
          }),
          sel.fontAdvanced && React.createElement(React.Fragment, null,
            React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
              ctlText("组件字体", "未填时显示该组件当前的 DSH 默认值（— = 此刻不在页面上）；清空即回默认"),
            ),
            // 表格化：与「排版角色」表同构 —— 表头放「字号 / 字重 / 字体」，一行一个组件。
            React.createElement("table", { className: "we-picker__font-table" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "组件"),
                  React.createElement("th", null, "字号"),
                  React.createElement("th", null, "字重"),
                  React.createElement("th", null, "字体"),
                ),
              ),
              React.createElement("tbody", null,
            COMPONENT_FONT_TARGETS.map((target) => {
              const c = sel.componentFonts[target.id] || {};
              // 未填时**直接显示 DSH 当前默认值**（启动自探测时顺带读回的 computed 值）。
              const d = (typeof componentFontDefaults === "function"
                ? componentFontDefaults()[target.id] : null) || {};
              const famKey = FONT_FAMILY_LABELS.reduce(
                (acc, f) => (acc === "" && c.family !== undefined && fontFamilyStack(f.v) === c.family ? f.v : acc), "");
              return React.createElement("tr", { key: target.id },
                React.createElement("td", null, ctlText(target.label, target.group + " · 走 " + target.route)),
                React.createElement("td", null, React.createElement("input", {
                  type: "number",
                  value: c.size === undefined ? (d.size || "") : c.size,
                  placeholder: d.size ? "" : "—",
                  min: 6,
                  max: 40,
                  style: { width: "44px" },
                  onChange: (e) => onComponentFont(target.id, "size", e.target.value),
                  title: target.label + "：字号 px（清空即回 DSH 默认" + (d.size ? " " + d.size + "px" : "") + "）",
                })),
                React.createElement("td", null, React.createElement("input", {
                  type: "number",
                  value: c.weight === undefined ? (d.weight || "") : c.weight,
                  placeholder: d.weight ? "" : "—",
                  min: 100,
                  max: 900,
                  step: 100,
                  style: { width: "54px" },
                  onChange: (e) => onComponentFont(target.id, "weight", e.target.value),
                  title: target.label + "：字重 100–900（清空即回 DSH 默认" + (d.weight ? " " + d.weight : "") + "）",
                })),
                React.createElement("td", null, React.createElement("select", {
                  value: famKey,
                  style: { width: "96px" },
                  onChange: (e) => onComponentFamily(target.id, e.target.value),
                  title: target.label + "：字体族（跟随 = 不覆盖，用 DSH 默认）",
                },
                  React.createElement("option", { value: "" }, "跟随"),
                  FONT_FAMILY_LABELS.map((f) =>
                    React.createElement("option", { key: f.v, value: f.v }, f.label)),
                )),
              );
            }),
              ),
            ),
          ),
          // 全局字重已移除（与「字体颜色」同一类问题：一个全局值会把 DSH 的粗细层次压成
          // 一档）。字重改**按角色**细化（下面「排版角色」每行一个输入框）与**按组件**细化
          // （「高级字体设置」里每组件一项），都能填任意值；留空/「恢复默认」即回 DSH 官方字重。
          // 全局字体族已移除：字族改按角色（「排版角色」每行的字族下拉）
          // 与按组件（「高级字体设置」里每项的下拉）设置 —— 全局字族只经 body 继承，
          // 既压平 DSH 的字体栈层次，又够不到用 `font:` 简写的标题/表格/代码。
          // ── 字体集（**「字体自定义」的附属**）：总开关管"要不要自定义"，这里管"用哪一整套"。
          //    放在 `sel.fontCustom` 这一支**里面** —— 关掉自定义就整块收起（那时这一整套并不
          //    生效，摆出来只会让人以为它在起作用）。
          switchRow("字体集预设", fontSet.open, (e) => fontSet.onOpen(e.target.checked), {
            tooltip: "预设 = 一整套字体外观；改动只落到当前这一套，随时可以恢复原样",
          }),
          fontSet.open && renderFontSetEditor(fontSet),
        ),
      ),
      // ── 输入光标（#83）：光标色与壁纸相近时会隐形，这里给它一个独立于字体
      //    自定义的颜色项。「自动」= 不注入任何规则，跟随 dsh 原生表现。──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "输入光标"),
        ),
        swatchRow("光标颜色", CARET_COLOR_PRESETS, sel.caretColor, onCaretColor, {
          key: "caret-color",
          hint: "输入框光标看不清时换个颜色",
          auto: React.createElement("button", {
            key: "auto",
            className: "we-picker__swatch we-picker__swatch--auto" + (sel.caretColor === "" ? " we-picker__swatch--active" : ""),
            type: "button",
            title: "跟随 dsh 原生光标颜色",
            onClick: () => onCaretColor(""),
            "aria-label": "光标颜色 自动",
          }, "自动"),
          colorValue: sel.caretColor || "#4f8cff",
        }),
      ),
      // ── 窗口与侧栏：两套液态玻璃总开关，细节控件缩进一级并随开关显隐 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "窗口与侧栏"),
        ),
        // 设置窗口液态玻璃 master switch: turns the WHOLE native settings window
        // (nav + every native section, not just this page) into liquid glass with
        // the accent + transparency above; off restores the stock shell look.
        switchRow("设置窗口液态玻璃", sel.glassWindow, (e) => {
          setSetting("glassWindow", e.target.checked);
          emit();
        }, {
          key: "window-glass",
          hint: "整个设置窗口跟随配色与透明度",
          tooltip: "整个设置窗口（含 General / 模型 / 插件等全部原生分区）跟随配色与透明度；关闭则恢复原生样式",
        }),
        // 侧栏玻璃（dsh-better-sidebar 适配）：与设置窗口玻璃同级的一套独立细粒度
        // 控制 —— 总开关 + 专用模糊 + 专用透明度 + 玻璃基底色调，全部只作用于
        // dsh-better-sidebar 子树，不动会话玻璃（玻璃 / 玻璃透明度）的设置。
        // 仅在 host 检测到 dsh-better-sidebar 已安装且启用时显示（sidebarPresent）。
        // 开关本体 + 一句话说明始终显示；细节滑块以「侧栏液态玻璃」开关为前提
        // —— 关闭时隐藏，开启后随 emit 重渲染实时出现。
        sel.sidebarPresent && switchRow("侧栏液态玻璃", sel.sidebarGlass, (e) => {
          setSetting("sidebarGlass", e.target.checked);
          emit();
        }, {
          key: "sidebar-glass-toggle",
          hint: "dsh-better-sidebar 侧栏毛玻璃适配",
          tooltip: "dsh-better-sidebar 侧栏（文件 / 终端 / Git 等面板）的毛玻璃适配；关闭则恢复其原生外观",
        }),
        sel.sidebarPresent && sel.sidebarGlass && [
        SliderRow("侧栏模糊", 0, 200, 1, sel.sidebarBlur, onSidebarBlur, sel.sidebarBlur + "px", "sb-blur"),
        SliderRow("侧栏透明度", 0, 200, 1, sel.sidebarAlpha, onSidebarAlpha, sel.sidebarAlpha + "%", "sb-alpha"),
        swatchRow("侧栏玻璃颜色", GLASS_COLOR_PRESETS, sel.sidebarColor, onSidebarColor, { key: "sb-color" }),
        // 内容面（编辑器 / 终端）近不透明玻璃底：透明度 + 底色。固定调色板
        // （语法高亮 / ANSI）为不透明底设计，全透毛玻璃下注释灰不可读；这里
        // 在"玻璃感"与"可读性"之间取平衡——透明度越大越透，底色空 = 跟随主题。
        SliderRow("内容面透明度", 0, 80, 5, sel.sidebarContentAlpha, onSidebarContentAlpha, sel.sidebarContentAlpha + "%", "content-alpha"),
        swatchRow("内容面底色", GLASS_COLOR_PRESETS, sel.sidebarContentColor, onSidebarContentColor, {
          key: "content-color",
          auto: React.createElement("button", {
            key: "auto",
            className: "we-picker__swatch we-picker__swatch--auto" + (sel.sidebarContentColor === "" ? " we-picker__swatch--active" : ""),
            type: "button",
            title: "跟随主题面板色",
            onClick: () => onSidebarContentColor(""),
            "aria-label": "内容面底色 跟随主题",
          }, "主题"),
          colorValue: sel.sidebarContentColor || "#1e1f26",
        }),
        ],
      ),
    );
  }


  function renderAudioTab(ctx) {
    const { onToggleAudio, onVideoVolume, sel } = ctx;
    // 声音：壁纸音轨（视频 / 场景内嵌 MP4 / 场景包内音频共用一套设置）。
    // 系统音频反应 / 媒体信息 / 在线歌词三键已**退役为常开**（schema kind 'const'）：
    // 面板不再提供页面定义，运行时两侧一律按默认接入读值。
    return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "声音"),
        ),
        SliderRow("音量", 0, 100, 5,
          Math.round((Number(sel.videoVolume) || 0) * 100), onVideoVolume,
          Math.round((Number(sel.videoVolume) || 0) * 100) + "%"),
        switchRow("壁纸音轨", sel.videoAudioEnabled !== false, () => onToggleAudio(), {
          hint: "关闭=静音（保留音量数值）· 开启时音量 0 自动 50%",
          tooltip: "视频壁纸与场景壁纸（内嵌 MP4 音轨 / 包内独立音频）共用；默认静音，开启时若音量为 0 会自动提到 50%",
        }),
      ),
    );
  }


  function renderMascotTab(ctx) {
    const { onRopeFormChange, onRopeScaleChange, onRopeVisibilityChange, sel } = ctx;
    return React.createElement(React.Fragment, null,
      // ── 吉祥物：形态卡片即实时预览（随「吉祥物大小」滑块缩放），开关总控 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "聊天吉祥物"),
        ),
        switchRow("显示吉祥物", sel.ropeShown !== false, onRopeVisibilityChange, {
          key: "rope-shown",
          hint: "关闭后隐藏吉祥物与壁纸仓库抽屉",
          tooltip: "关闭后隐藏吉祥物与壁纸仓库抽屉；可随时在本页重新开启",
        }),
        // 吉祥物形态（maid = 默认小女仆 / whale = 鲸御姐）：卡片直接渲染形态
        // 立绘并按当前 ropeScale 缩放 —— 选形态与看大小两件事在同一处完成，
        // 调整下方滑块时卡片实时跟着变。关闭时仍可先设定，重新开启即生效。
        React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
          ctlText("吉祥物形态", "卡片按当前大小实时预览"),
          React.createElement("div", { className: "we-picker__mascot-row", role: "group", "aria-label": "吉祥物形态" },
            ROPE_FORM_VALUES.map((k) => {
              const form = ROPE_FORMS[k];
              return React.createElement("button", {
                key: k,
                type: "button",
                className: "we-picker__mascot-card" + (sel.ropeForm === k ? " we-picker__mascot-card--active" : ""),
                "aria-pressed": sel.ropeForm === k ? "true" : "false",
                title: form.label,
                onClick: () => onRopeFormChange(k),
              },
                React.createElement("span", {
                  className: "we-picker__mascot-art",
                  style: { width: Math.round(form.w * sel.ropeScale) + "px", height: Math.round(form.h * sel.ropeScale) + "px" },
                },
                  React.createElement("img", { src: form.img, alt: form.label, draggable: false })),
                React.createElement("span", { className: "we-picker__mascot-name" }, form.label),
              );
            }),
          ),
        ),
        SliderRow("吉祥物大小", ROPE_SCALE_MIN, ROPE_SCALE_MAX, ROPE_SCALE_STEP,
          sel.ropeScale, onRopeScaleChange, Math.round(sel.ropeScale * 100) + "%", "rope-scale"),
      ),
    );
  }


  function renderEffectsTab(ctx) {
    const { setSetting, onBackgroundBrightness, onBackgroundContrast, onBackgroundSaturate, onClearCustomFrame, onClearGpuFrame, onCustomFrameFile, onRecaptureGpuFrame, onRefreshFrame, onScrim, onWallpaperBlur, onWallpaperOpacity, sel } = ctx;
    // 效果页签的空态：没有启用壁纸时不摆一列无效滑块，改为引导去选壁纸。
    if (!sel.id) {
      return React.createElement("div", { className: "we-picker__empty" },
        React.createElement("span", { className: "we-picker__empty-title" }, "还没有启用壁纸"),
        React.createElement("span", { className: "we-picker__hint" },
          "选择一款壁纸后，可在这里调整模糊、亮度、适配、倍速等效果"),
        React.createElement("button", {
          className: "we-picker__btn we-picker__btn--primary", type: "button",
          ref: (el) => { pickerOpener = el; },
          onClick: () => {
            setTransient("pickerOpen", true);
            setTransient("pickerDraft", false); // 普通下钻（点卡片即应用）
            setTransient("modalView", "normal");
            pickerFocusPending = true;
            emit();
          },
        }, "选择壁纸"),
      );
    }
    // 画面来源相关的判定算一次给下面几行用：
    // - sceneWithFrame：有出图来源可换、有槽位可抓的场景壁纸；
    // - gpuPinnedHere：当前面板这张壁纸的槽里确实有实时帧（探测带 TTL，见
    //   probeGpuFrameState）—— 跨壁纸的 pinned 状态不能拿来显示。
    const sceneWithFrame = sel.type === "scene" && Boolean(sel.sceneFrameUrl);
    const gpuPinnedHere = gpuFrameUi.wid === String(sel.id) && gpuFrameUi.pinned;
    return React.createElement(React.Fragment, null,
      // ── 画面：壁纸层滤镜与边框细调 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "画面"),
        ),
        SliderRow("壁纸模糊", 0, 60, 1, sel.wallpaperBlur, onWallpaperBlur, sel.wallpaperBlur + "px"),
        SliderRow("亮度", 40, 160, 5, sel.backgroundBrightness, onBackgroundBrightness, sel.backgroundBrightness + "%"),
        SliderRow("对比度", 40, 200, 5, sel.backgroundContrast, onBackgroundContrast, sel.backgroundContrast + "%"),
        SliderRow("饱和度", 0, 200, 5, sel.backgroundSaturate, onBackgroundSaturate, sel.backgroundSaturate + "%"),
        // 壁纸透明度（#82）：越大越透，淡出后壁纸融向**原生外观**（浅色纯白 /
        // 深色纯黑，IDEA 背景图式）。与暗化互补 —— 一个减淡壁纸本身，一个压暗
        // 整体画面；上限 90% 避免调到「壁纸完全不可见但暗化还在」的诡异状态
        // （想关壁纸直接关掉即可）。
        SliderRow("壁纸透明度", 0, 90, 5, sel.wallpaperOpacity, onWallpaperOpacity, sel.wallpaperOpacity + "%", "wallpaper-opacity", {
          tooltip: "壁纸向原生底色淡出（浅色纯白 / 深色纯黑）；透明生效时壁纸层会垫这层原生底色，以保证玻璃模糊不被透明背景破坏。场景壁纸的垫底实时帧会在实时画面出场后退场，不会在淡出时透出来",
        }),
        SliderRow("暗化", 0, 90, 5, Math.round(sel.scrim * 100), onScrim, Math.round(sel.scrim * 100) + "%"),
        // ── 场景实时渲染（WebWallGL）：scene.pkg 壁纸的实时 WebGL 形态，默认
        // 开启。失败（首帧超时/运行失联）按壁纸记忆并自动降级回内嵌 MP4 →
        // 静态帧；重开本开关清空全部失败记忆（显式重试入口）。
        (sel.type === "scene" || sel.type === "web") && switchRow(
          sel.type === "web" ? "网页实时渲染" : "场景实时渲染",
          sel.sceneLive !== false, (e) => {
          setSetting("sceneLive", e.target.checked);
          setSetting("sceneLiveFailures", {});
          prepareLiveTimeouts.clear(); // 显式重试：准备期 live 超时冷却一并清零（评审 P1）
          clearLiveSessionFailures(); // 显式重试：**会话内**的传输类软失败同样要清（它不在设置里）
          syncLayers();               // key 的 live 段变化 → 层重建（升级/降级）
          syncSceneAudio(selection);  // 音频互斥状态随形态切换
          emit();
        }, {
          key: "scene-live",
          hint: "WebGL 实时渲染 · 失败自动降级",
          tooltip: sel.type === "web"
            ? "网页壁纸由 WebWallGL 加载并注入 WE API（音频/属性监听等），严格沙箱隔离（不继承宿主权限）；加载失败或运行失联时自动退回兼容 iframe。重新开启会重试此前失败的壁纸"
            : "场景壁纸由 WebWallGL 实时渲染（粒子/脚本/视差/包内音频）；加载失败或运行失联时自动退回内嵌视频 / 实时帧。重新开启会重试此前失败的壁纸",
        }),
        (sel.type === "scene" || sel.type === "web") && sel.sceneLive !== false
          && React.createElement("div", { className: "we-picker__ctl", key: "live-boot-delay" },
          ctlText("启动最长等待时间"),
          React.createElement("div", { className: "we-picker__seg" },
            [0, 3, 5, 10].map((secs) =>
              React.createElement("button", {
                key: secs,
                className: "we-picker__btn we-picker__rate" + (Number(sel.liveBootDelay) === secs ? " we-picker__rate--active" : ""),
                type: "button",
                onClick: () => { setSetting("liveBootDelay", secs); emit(); },
              }, secs === 0 ? "立即" : "≤" + secs + "s"),
            ),
          ),
        ),
        (sel.type === "scene" || sel.type === "web") && sel.sceneLive !== false
          && (sel.sceneLiveSrc || sel.webLiveSrc)
          && React.createElement("div", { className: "we-picker__ctl", key: "scene-live-fps" },
          ctlText("实时渲染帧率", "渲染 fps · 越低越省电"),
          React.createElement("div", { className: "we-picker__seg" },
            SCENE_LIVE_FPS_VALUES.map((f) =>
              React.createElement("button", {
                key: f,
                className: "we-picker__btn we-picker__rate" + (sel.sceneLiveFps === f ? " we-picker__rate--active" : ""),
                type: "button",
                // 帧率进 iframe query（sceneFps）→ syncLayers key 变化重建层
                onClick: () => { setSetting("sceneLiveFps", f); syncLayers(); emit(); },
              }, f + "fps"),
            ),
          ),
        ),
        // ── 出图来源：**只在实时渲染未生效时**出现 —— 它换的是「没有实时画面时显示什么」，
        //    实时画面在跑时它没有任何作用（换实时帧用下面的「重新截」）。──
        sel.type === "scene" && sel.sceneFrameUrl && !liveRenderEnabled(sel)
          && React.createElement("div", { className: "we-picker__ctl" },
          ctlText("出图来源", "这张画面从哪来",
            "场景壁纸「这张画面从哪来」。两档：**实时画面**（有抓帧就用它，没有则留空）与**自定义画面**（手动导入的截图）。点一次切换一次，选择记忆在当前壁纸上。实时渲染生效时本行不显示（那时画面来自实时渲染，切这里不会生效）"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onRefreshFrame,
            "aria-label": "切换出图来源",
          }, "切换"),
          React.createElement("span", { className: "we-picker__hint we-picker__value" },
            // 按**档位值**查表，不能当下标：值域有洞（0 与 4），下标会越界成 undefined.label
            (() => {
              const v = Number(sel.frameVariants && sel.frameVariants[String(sel.id)]) || 0;
              const i = Math.max(0, FRAME_VARIANTS.findIndex((f) => f.id === v));
              return "第 " + (i + 1) + "/" + frameVariantCount(sel, String(sel.id)) + " 档 · " + FRAME_VARIANTS[i].label;
            })()),
        ),
        // ── GPU 实时帧（抓帧缓存 + 重新截 + 微缩预览）：**实时渲染开着时同样显示**。
        //    它是切换途中 / live 首帧之前给用户看的那张静帧 —— 构图不对（黑帧、旧视口、
        //    切走瞬间抓的）时用户必须能立刻重抓，而不是先关掉实时渲染再回来。
        //    预览窗口指向的就是**层上正在用的那个 URL**（同一档位 + 缓存破坏参数），
        //    所以「预览看到什么，切换途中就是什么」。──
        sceneWithFrame && (gpuPinnedHere || liveRenderEnabled(sel))
          && React.createElement("div", { className: "we-picker__ctl we-picker__ctl--wrap" },
          ctlText("实时帧",
            gpuPinnedHere
              ? "已抓帧 · 优先于全部画面档位"
              : "实时渲染中 · 可随时抓一张",
            "实时渲染成功后会自动抓帧缓存这一帧（<key>_gpu.png），它优先于「出图来源」的自动档；切换壁纸途中、以及 live 首帧出来之前，屏幕上显示的就是它。「重新截」会按**当前**画面重抓一张（已存在的缓存会被替换，抓不到则原样保留）；「清除 GPU 帧」删掉缓存、回到「自动」：没有实时画面时是空态（不再**合成**任何「猜」出来的图）；唯一的例外是该帧连**加载都失败**、而壁纸有工程预览图时，退到预览图垫底（作者随包发布的图）。"),
          // 微缩预览：只有槽里真有实时帧时才显示（否则这里会显示成 CPU 档位帧，误导）。
          gpuPinnedHere && React.createElement("img", {
            className: "we-picker__frame-shot",
            src: framePreviewSrc(sel),
            alt: "当前壁纸实时帧预览",
            title: "当前壁纸的实时帧（就是切换途中 / live 首帧前显示的那张静帧）"
              + (gpuFrameUi.w > 0 && gpuFrameUi.h > 0 ? " · " + gpuFrameUi.w + "×" + gpuFrameUi.h : ""),
          }),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onRecaptureGpuFrame,
            disabled: gpuFrameUi.recapturing,
            "aria-label": "重新截取当前壁纸实时帧",
          }, gpuFrameUi.recapturing ? "抓帧中…" : "重新截"),
          gpuPinnedHere && React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onClearGpuFrame,
            "aria-label": "清除 GPU 实时帧缓存",
          }, gpuFrameUi.busy ? "清除中…" : "清除 GPU 帧"),
          gpuPinnedHere && gpuFrameUi.w > 0
            && React.createElement("span", { className: "we-picker__hint we-picker__value" },
              gpuFrameUi.w + "×" + gpuFrameUi.h),
          gpuFrameUi.error
            && React.createElement("div", { className: "we-picker__hint" }, gpuFrameUi.error),
        ),
        // ── 自定义画面（截屏导入）：出不了实时画面的壁纸（骨骼拼装场景，预览 gif 仅
        //    160px）由用户从 WE 截图导入，画质=截图分辨率；就是 ?v=4 那一档。
        //    同样**不受实时渲染开关影响**（导入/清除与 live 互不干扰）。──
        sel.type === "scene" && React.createElement("div", { className: "we-picker__ctl" },
          ctlText("自定义画面",
            "手动给电脑桌面截图，导入截图解决错误壁纸",
            "手动对电脑桌面截图（壁纸显示效果的分辨率即最终展示画质），再回来点「导入画面…」选中该截图；导入后自动切换为该图，可随时切回「实时画面」档。实时渲染生效时它仍会作为「出图来源」的自定义档"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: () => { if (customFrameInput) customFrameInput.click(); },
          }, frameVariantCount(sel, String(sel.id)) === FRAME_VARIANTS.length ? "替换图片…" : "导入画面…"),
          frameVariantCount(sel, String(sel.id)) === FRAME_VARIANTS.length && React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onClearCustomFrame,
          }, "清除"),
          React.createElement("input", {
            type: "file",
            accept: "image/png,image/jpeg,image/webp",
            style: { display: "none" },
            ref: (el) => { customFrameInput = el; },
            onChange: onCustomFrameFile,
          }),
        ),
        // Playback speed — native playbackRate, instant, no media reload. Video
        // wallpapers only (web/iframe and scene wallpapers have no playbackRate).
        sel.type === "video"
          && React.createElement("div", { className: "we-picker__ctl", key: "rate" },
          ctlText("倍速"),
          React.createElement("div", { className: "we-picker__seg" },
            [0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) =>
              React.createElement("button", {
                key: rate,
                className: "we-picker__btn we-picker__rate" + (sel.playbackRate === rate ? " we-picker__rate--active" : ""),
                type: "button",
                onClick: () => { setSetting("playbackRate", rate); emit(); },
              }, String(rate).replace(/\.?0+$/, "") + "x"),
            ),
          ),
        ),
        // 解码帧率上限（抽帧转码）：host 一次性把源视频重编码为上限帧率（时间线
        // 1.0x 正常速度，解码占用随帧率线性下降），与倍速解耦。首次转码需等待，
        // 播放中原片、转好自动切换；无 ffmpeg 自动回退原片。
        sel.type === "video"
          && React.createElement("div", { className: "we-picker__ctl", key: "fps" },
          ctlText("帧率上限", "抽帧转码 · 降低解码占用"),
          React.createElement("div", { className: "we-picker__seg" },
            FPS_CAP_VALUES.map((cap) =>
              React.createElement("button", {
                key: cap,
                className: "we-picker__btn we-picker__rate" + (sel.fpsCap === cap ? " we-picker__rate--active" : ""),
                type: "button",
                onClick: () => {
                  setSetting("fpsCap", cap); refreshMediaInfo(true); emit();
                },
              }, cap === 0 ? "无限制" : cap + "fps"),
            ),
          ),
        ),
        // Source metadata + transcode status (host moov probe / transcode lifecycle).
        sel.type === "video" && sel.mediaInfo && React.createElement("span", { className: "we-picker__hint", key: "media-info" },
          "源 " + sel.mediaInfo.width + "×" + sel.mediaInfo.height
            + (sel.mediaInfo.fps ? " · " + sel.mediaInfo.fps + "fps" : "")
            + (sel.mediaInfo.codec ? " · " + codecLabel(sel.mediaInfo.codec) : "")
            + (sel.transcodeState === "working" ? " · 抽帧准备中…"
              : sel.transcodeState === "ready" ? " · 已切换至 " + sel.fpsCap + "fps 抽帧版（正常速度，解码占用约减半）"
              : sel.transcodeState === "fallback" ? " · 转码不可用，已回退原片"
              : sel.transcodeState === "skipped" ? " · 源帧率 ≤ 上限，无需抽帧"
              : ""),
        ),
        // Download / transcode progress bar (polled from /transcode-progress).
        sel.type === "video" && sel.transcodeState === "working" && sel.transcodeProgress
          && React.createElement("div", { className: "we-picker__row we-picker__prog", key: "transcode-prog" },
            React.createElement("div", {
              className: "we-picker__prog-track",
              role: "progressbar",
              "aria-label": "转码进度",
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": Math.max(0, Math.min(100, sel.transcodeProgress.percent || 0)),
            },
              React.createElement("div", {
                className: "we-picker__prog-bar",
                style: { width: Math.max(2, Math.min(100, sel.transcodeProgress.percent || 0)) + "%" },
              }),
            ),
            React.createElement("span", { className: "we-picker__hint" },
              sel.transcodeProgress.phase === "download"
                ? "下载 ffmpeg " + (sel.transcodeProgress.percent || 0) + "%"
                : sel.transcodeProgress.phase === "transcode" && sel.transcodeProgress.finalizing ? "收尾中…"
                : sel.transcodeProgress.phase === "transcode"
                  ? "转码中 " + (sel.transcodeProgress.percent || 0) + "%"
                    + (sel.transcodeProgress.eta ? " · 约剩 " + sel.transcodeProgress.eta + " 秒" : "")
                : sel.transcodeProgress.phase === "done" ? "即将完成…"
                : "准备中…",
            ),
          ),
        // Fit mode — applies to the CURRENT wallpaper whatever its type (WE
        // video/scene image and custom uploads alike; web/iframe wallpapers
        // have no object-fit). 覆盖=cover 填充=contain 居中=center 拉伸=fill
        React.createElement("div", { className: "we-picker__ctl", key: "fit" },
          ctlText("适配"),
          React.createElement("div", { className: "we-picker__seg" },
            ["cover", "contain", "center", "fill"].map((mode) => {
              const label = { cover: "覆盖", contain: "填充", center: "居中", fill: "拉伸" }[mode];
              return React.createElement("button", {
                key: mode,
                className: "we-picker__btn we-picker__rate" + (sel.objectFit === mode ? " we-picker__rate--active" : ""),
                type: "button",
                title: mode,
                onClick: () => {
                  setSetting("objectFit", mode);
                  emit();
                  // Edge canvas 渲染路径的 fit 存在 weDrawCtx 上（syncLayers 的
                  // same-canvas 守卫不会重建 draw loop），直接更新并重绘。
                  if (weDrawCtx) {
                    weDrawCtx.fit = mode;
                    weDrawFrame();
                  }
                },
              }, label);
            }),
          ),
        ),
        // Horizontal mirror — scaleX(-1), compositor-only; works for video,
        // web (iframe) and (later) uploaded image wallpapers alike.
        switchRow("水平翻转", sel.flip, (e) => { setSetting("flip", e.target.checked); emit(); }, { key: "flip" }),
      ),
    );
  }

  function renderAdvancedTab(ctx) {
    const { setSetting, onEdgeCompatChange, onLayoutChange, sel } = ctx;
    return React.createElement(React.Fragment, null,
      // ── 浏览方式：紧凑 CD 架 vs 常规分页网格 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "浏览方式"),
        ),
        // Card style: classic (WE's original aspect-ratio 16/9 cards — the CD-like
        // look) vs the rewritten fixed-height cards that never overlap.
        switchRow("紧凑布局", sel.pickerLayout === "classic", (e) => onLayoutChange(e.target.checked ? "classic" : "fixed"), {
          hint: sel.pickerLayout === "classic" ? "CD 架：层叠 + 一页到底" : "常规网格 · 分页",
          tooltip: "紧凑 CD 架：层叠 + 一页到底",
        }),
      ),
      // ── 兼容性 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, "兼容性"),
        ),
        // Edge 兼容渲染开关：仅在 Edge 中生效（canvas 渲染，避免浏览器自带的
        // 「下载 / 投屏」悬浮工具栏）。
        switchRow("Edge 兼容", sel.edgeCompat !== false, (e) => onEdgeCompatChange(e.target.checked), {
          hint: "Edge 下视频壁纸走 canvas 渲染",
          tooltip: "Edge 兼容：视频壁纸改用 canvas 渲染，避免浏览器自带的「下载 / 投屏」悬浮工具栏；关闭则始终使用原生 <video>",
        }),
      ),
      // ── 适配（适配器模式）：本页跑在哪种宿主形态里 —— 自动检测 + 可手选 ──
      // 检测事实来源在宿主侧（能力头 / UA，见 lib/index.js 的 3c-0），客户端拿
      // 上报值 + 本地信号兜底；手选优先于检测，是检测不准时的自救。
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", {
            className: "we-picker__section-label",
            title: "适配目标决定四件事：网页壁纸载荷走哪个源（有无能力头栅栏）、桌面壳材质规则是否生效、窗口失焦暂停是否适用、面板哪些行可用。默认自动检测，检测不准时可手选覆盖（手选优先）。",
          }, "适配"),
        ),
        React.createElement("div", { className: "we-picker__ctl" },
          ctlText("适配目标", "自动检测 · 手选可覆盖"),
          React.createElement("select", {
            className: "we-picker__select",
            value: ADAPTER_TARGET_VALUES.includes(sel.adapterTarget) ? sel.adapterTarget : "auto",
            onChange: (e) => { setSetting("adapterTarget", e.target.value); emit(); },
            "aria-label": "适配目标",
          },
            ADAPTER_TARGET_VALUES.map((t) =>
              React.createElement("option", { key: t, value: t }, ADAPTER_LABELS[t] || t)),
          ),
        ),
        // 状态行只反映**检测**（与手选无关），且必须与宿主 mediaOriginNeeded 的
        // 三分支逐条对齐 —— 否则文案会说错载荷到底走哪个源：栅栏 ⇒ 独立媒体源；
        // 无栅栏的桌面形态（Electron UA）**仍然**走独立媒体源（安全默认）；只有
        // 原生浏览器才走应用源。desktop/fence 取自 adapterCaps（最终目标 + 上报）。
        React.createElement("div", { className: "we-picker__hint", key: "adapter-detected" },
          "检测到：" + adapterDetectedLabel()
          + (adapterCaps().fence
            ? " · 有能力头栅栏（网页壁纸走独立媒体源）"
            : adapterCaps().desktop
              ? " · 无栅栏的桌面形态（网页壁纸仍走独立媒体源）"
              : " · 无栅栏（网页壁纸走应用源）")),
        adapterMismatchWarning() && React.createElement("div", { className: "we-picker__hint", key: "adapter-warn" },
          adapterMismatchWarning()),
      ),
      // ── 省电：遮挡暂停（借鉴 Wallpaper Engine 的「被遮挡时暂停」）──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", {
            className: "we-picker__section-label",
            title: "类似 WE 的遮挡暂停：最小化、切到其它应用或使用电池供电时视频暂停、GPU 解码归零；回到界面 / 接通电源自动继续（网页壁纸仅随页面隐藏被浏览器节流）",
          }, "省电"),
        ),
        switchRow("最小化/切页时暂停", sel.pauseOnHidden, (e) => { setSetting("pauseOnHidden", e.target.checked); emit(); }, { key: "pause-hidden" }),
        // 失焦档按适配目标显隐：桌面壳失焦时壁纸多半仍整块可见，暂停会定格
        // **可见**画面 ⇒ 本目标下不提供；值不删，切到浏览器目标即重新生效。
        adapterCaps().blurPause
          && switchRow("窗口失焦时暂停", sel.pauseOnBlur, (e) => { setSetting("pauseOnBlur", e.target.checked); emit(); }, { key: "pause-blur" }),
        !adapterCaps().blurPause && React.createElement("div", { className: "we-picker__hint", key: "pause-blur-note" },
          "「窗口失焦时暂停」只在原生浏览器目标下提供 —— 桌面壳失焦时壁纸仍可见，暂停会定格可见画面"
          + (sel.pauseOnBlur ? "（当前已开启，本目标下不生效，切到浏览器目标后恢复）" : "")),
        switchRow("使用电池时暂停", sel.pauseOnBattery, (e) => { setSetting("pauseOnBattery", e.target.checked); emit(); }, { key: "pause-battery" }),
      ),
      // ── 实时渲染诊断（本会话有效，不落盘；从「效果」页签移来）：只对**能走实时
      //    渲染**的壁纸（场景 / 网页）显示 —— 视频、图片壁纸没有渲染页，摆出来是空的。──
      (sel.type === "scene" || sel.type === "web") && sel.sceneLive !== false
        && React.createElement("div", { className: "we-picker__section" },
          React.createElement("div", { className: "we-picker__section-head" },
            React.createElement("span", { className: "we-picker__section-label" }, "实时渲染诊断"),
          ),
          // live 诊断日志（本会话有效，不落盘）：默认只记关键事件（准备就绪/领养/
          // 首帧确认/判失败，每轮轮换 2–3 条，写在控制台与宿主诊断缓冲
          // `/wallpaper-engine/diag-log`）；这里开的是**逐秒心跳读数**（fps/running/
          // 暂停原因），排查「为什么没出帧」时用。
          switchRow(
            "live 诊断日志", liveDiagVerbose(), () => {
              toggleLiveDiag(); // 翻转 + 留痕（状态归 src/live-layer.js）
              emit();
            }, {
              key: "scene-live-diag",
              hint: "本会话有效 · 逐秒心跳读数",
              tooltip: "开启后每秒记录一次渲染页心跳读数（fps / running / 暂停原因）与准备、领养、判失败事件；"
                + "同时写入浏览器控制台和宿主诊断缓冲（GET /wallpaper-engine/diag-log）。排查 live 掉帧/降级时用，平时关着。",
            }),
        ),
    );
  }


export {
  renderWallpaperTab, renderAppearanceTab, renderAudioTab, renderMascotTab, renderEffectsTab, renderAdvancedTab,
};
