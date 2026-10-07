/**
 * inventory.js — **清单构建族**：`/inventory` 的载荷构造（`buildInventory`）与它的两个
 * 单条目字段函数（`sceneFieldsFor` / `webFieldsFor`）。
 *
 * 为什么这一族独立成文件：它是 `apply(ctx)` 里**最大的一块**（约 230 行），而且是
 * `apply()` 里**唯一**一个"读盘 → 组装 JSON"的纯产出过程 —— 不注册路由、不持有跨请求
 * 资源，只在工厂闭包里留一个 3 秒 TTL 缓存。把它摊在门面里，会让"注册与协议聚合"
 * 这件事被 200 多行扫描逻辑淹没（见 docs/CODE-STRUCTURE.md §5 的硬约束）。
 *
 * 契约：`createInventoryBuilder(c)` → 返回 `buildInventory`（同一个引用交给 `/inventory`
 * 路由）。这不是"路由族"而是**工厂**：本族要保留一份跨请求状态（TTL 缓存），工厂形式
 * 让这份状态的生命周期与 `apply()` 的一次调用严格一致 —— 若把它做成模块级单例，两次
 * apply 会共用缓存，那是行为改动。
 *
 * `c` 里是这一族**用到但不属于它**的东西（全是 `lib/index.js` 的模块级纯函数/常量，
 * 外加两个可变状态的**访问器**）：
 *   · `BASE`                        ← 路由前缀（拼 `media`/`preview`/`scene-frame` … 的 URL）
 *   · `tokenFor`                    ← 绝对路径 → token（**写** `mediaMap`，故由门面持有）
 *   · `mediaOriginApi`              ← 壁纸媒体源（`mediaOriginBase` / `ensureSceneMediaOrigin`）
 *   · `warmFaststart`               ← 视频 faststart 变体预热（门面里的 `warmFaststartFavorites`）
 *   · `log`                         ← 日志面
 *   · 扫描链：`locateWallpaperEngineP` / `owningLibrariesP` / `enumerateWallpapersAsync`
 *   · 条目设施：`pathKey` / `listCustomFrameIds` / `pathExistsP` / `mtimeOrNullP` / `extOf`
 *   · 上传存储：`ensureUploadDir` / `readUploadMeta` / `enumerateUploadsP` / `metaEntry`
 *   · 播放列表：`readPlaylistsP` / `playlistItemId`
 *   · 场景探测：`sceneVideoProbeKey` / `sceneVideoProbeGet` / `scheduleSceneVideoProbe`
 *   · 自定义画面：`customIdFromAbs`
 *   · `weAssetsAvailable`           ← WE 素材目录可用性谓词
 *   · `getUploadDir` / `getWeAssetsDir` ← ⚠️ **访问器不是值**：这两个目录都能被用户
 *     在运行时改（`/upload-dir` 与 `/we-assets-dir`）⇒ 传值快照会让清单一直报旧目录。
 *
 * 不变量：
 *   · **TTL 缓存只为省掉重复全扫**（3s）：客户端每次切壁纸/刷新面板都会重拉清单，
 *     而全量扫描（locate + readdir + 逐条目探测）在慢盘上要几百 ms 到几秒。
 *     语义不变 —— 浏览器半每次加载都会重取，新鲜度语义与"不缓存"一致。
 *   · **两个字段函数必须逐字共用**：Steam 扫描与自定义存储扫描都要同一套 scene/web
 *     字段（同一张场景从哪个来源来都必须表现一致）。
 *   · **`propsUrl` 只能在条目里给一次**：两个字段函数都返回过它，
 *     `webFieldsFor` 的 `null` 会把场景壁纸的值盖掉（实测 216 张场景一张都拿不到）。
 *   · **`sceneVideo` 诚实化**：只有探测缓存确认内嵌 MP4 才给 URL；未知则 `null` +
 *     投递后台探测，**绝不拿 `hasFrame` 冒充**（否则字段在说谎、客户端必然 404）。
 *   · **`scenePkgBytes` 只对单文件容器有意义**（松散目录没有"整包"，预算走基准）。
 *   · 清单里的 `sceneLiveSrc` / `sceneVideo` / `sceneAudio` / `media` / `preview` /
 *     `frameUrl` / `propsUrl` / `liveFrame` 的 URL 形态是**客户端契约**，
 *     被 `src/picker-model.js` 与 `src/live-layer.js` 消费 —— 改形态要同改它们。
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';

export function createInventoryBuilder(c) {
  const {
    log, BASE, tokenFor, mediaOriginApi, warmFaststart,
    locateWallpaperEngineP, owningLibrariesP, enumerateWallpapersAsync,
    pathKey, listCustomFrameIds, pathExistsP, mtimeOrNullP, extOf,
    ensureUploadDir, readUploadMeta, enumerateUploadsP, metaEntry,
    readPlaylistsP, playlistItemId, weAssetsAvailable,
    sceneVideoProbeKey, sceneVideoProbeGet, scheduleSceneVideoProbe, customIdFromAbs,
    getUploadDir, getWeAssetsDir,
  } = c;

  /**
   * Scene-shaped derived fields for ONE wallpaper entry: the WebWallGL
   * live-render capability (sceneLive / sceneLiveSrc), the embedded MP4 and
   * packaged-audio availability (sceneVideo / sceneAudio), and the 自定义画面
   * memory (hasCustomFrame).
   * Shared verbatim by the Steam scan and the custom-storage (uploads) scan —
   * a scene found in either place must behave identically, and every one of
   * these routes is driven by the entry's absolute main-file path, so no
   * extra plumbing is needed for the custom-storage case.
   */
  function sceneFieldsFor(w, hasFrame, customIds, sceneMtime) {
    const isScene = Boolean(w.type === 'scene' && hasFrame && w.fileAbs);
    // WebWallGL 2.1.0 起 httpSource 原生支持「松散目录」形态：站点根两种形态一致
    // （<mediaBase>/<token>/，token = 主文件绝对路径，根 = 其所在目录），渲染器先拉
    // project.json、按 file 后缀自动判形态（.json 结尾 → loose：拉入口 json 与同级
    // 素材；否则回退 scene.pkg 容器），auto 档 sceneDir 先试、scenePkg 兜底。所以 token
    // 一律发放、形态判定交给渲染器 —— 宿主不按扩展名关死松散目录的实时渲染。isPkg
    // 只剩一个用途：scenePkgBytes 只对单文件容器有意义（松散目录没有"整包"，预算走基准）。
    const isPkg = isScene && !w.fileAbs.toLowerCase().endsWith('.json');
    // sceneVideo 诚实化: 只有探测缓存确认该 pkg 真的内嵌 MP4 才给 URL;
    // 未知 (无缓存项) → null 并投递后台探测, 绝不猜 —— 拿 hasFrame 冒充
    // 「内嵌视频」客户端请求必然 404 (字段在说谎)。
    const svKey = isScene ? sceneVideoProbeKey(w.fileAbs, sceneMtime) : null;
    const svKnown = svKey === null ? undefined : sceneVideoProbeGet(svKey);
    if (svKey !== null && svKnown === undefined) scheduleSceneVideoProbe(w.fileAbs, svKey);
    // `scene.pkg` 的体积：客户端拿它把**首帧预算**按"这份载荷至少要传多久"放大
    //（见 `src/live-layer.js` 的 liveFirstFrameBudget）—— 首帧必须等整包到齐，
    // 而 100–336MB 的包在饿死的传输下远超固定 15s。取不到就 0（= 退回基准预算，
    // 绝不因为"量不出体积"把壁纸判失败）。
    let scenePkgBytes = 0;
    if (isPkg) {
      try { scenePkgBytes = statSync(w.fileAbs).size || 0; } catch { scenePkgBytes = 0; }
    }
    return {
      sceneLive: isScene,
      sceneLiveSrc: isScene ? tokenFor(w.fileAbs) : null,
      scenePkgBytes,
      sceneVideo: svKnown === true ? `${BASE}/scene-video/${tokenFor(w.fileAbs)}` : null,
      sceneAudio: isScene ? `${BASE}/scene-audio/${tokenFor(w.fileAbs)}` : null,
      hasCustomFrame: isScene ? customIds.has(customIdFromAbs(w.fileAbs)) : false,
    };
  }

  /**
   * Web-wallpaper live-render fields. `webLiveSrc` is the FULL entry URL
   * (mediaBase-relative path + file name), not a token: the renderer page's
   * web form expects `src` to be the complete entry URL (the WallpaperEM
   * protocol), and it derives project.json from it. Strict sandbox keeps the
   * third-party HTML on an opaque origin so it can never act with the DSH
   * origin's authority.
   */
  function webFieldsFor(w, entryOk, mediaBase) {
    const isWeb = Boolean(w.type === 'web' && entryOk && w.fileAbs);
    return {
      webLive: isWeb,
      // 绝对 URL（壁纸媒体源）——不透明源的沙箱 iframe 只有在这个源上才能把
      // 入口 HTML 与其子资源取回来；媒体源不可用时回落成应用源相对路径
      //（浏览器形态照旧，Desktop 上会 403）。
      webLiveSrc: isWeb
        ? `${mediaBase || ''}${BASE}/scene-files/${tokenFor(w.fileAbs)}/${basename(w.fileAbs)}`
        : null,
    };
  }

  // Build the inventory (async scan chain — fs.promises, event-loop friendly).
  // The browser half refetches live each load, so freshness semantics are
  // unchanged; only the blocking behavior is gone.
  //
  // 短 TTL 缓存（3s）：客户端每次切壁纸/刷新面板都会重新拉 inventory，而
  // 全量扫描（locate + readdir + 每个壁纸的存在性探测）在慢盘上要几百 ms
  // 到几秒。TTL 内直接返回缓存，对用户的感知延迟上限仍是 3 秒。
  const INVENTORY_TTL_MS = 3000;
  let inventoryCache = null; // { t, payload }
  async function buildInventory() {
    if (inventoryCache && Date.now() - inventoryCache.t < INVENTORY_TTL_MS) {
      return inventoryCache.payload;
    }
    const installDir = await locateWallpaperEngineP();
    const libraryDirs = await owningLibrariesP();
    const all = await enumerateWallpapersAsync(installDir, libraryDirs);
    const byPath = new Map(all.map((w) => [pathKey(w.fileAbs), w.id]));
    const byId = new Map(all.map((w) => [w.id, w]));
    const customIds = listCustomFrameIds();
    const wallpapers = await Promise.all(all.map(async (w) => {
      // 三次存在性探测并发（串行在慢盘上是 3× 延迟）。
      const [hasMedia, hasPreview, sceneMtime] = await Promise.all([
        w.type === 'video' || w.type === 'web' ? pathExistsP(w.fileAbs) : Promise.resolve(false),
        w.previewAbs ? pathExistsP(w.previewAbs) : Promise.resolve(false),
        // Scenes: fileAbs points at the resolved scene main file (scene.pkg /
        // scene.json); frameUrl serves the live-captured frame or the
        // user-imported 自定义画面 (there is no extraction step any more).
        // 用 stat 取 mtime：一次异步探测同时给出 mtime ——
        // 兼作存在性（hasFrame）与 sceneVideo 探测缓存（路径+mtime）的键。
        w.type === 'scene' && w.fileAbs ? mtimeOrNullP(w.fileAbs) : Promise.resolve(null),
      ]);
      const hasFrame = sceneMtime !== null;
      // 只有真的存在网页条目时才按需起媒体源监听（懒启动，失败回落空串）。
      const webMediaBase = w.type === 'web' && hasMedia ? await mediaOriginApi.mediaOriginBase() : '';
      return {
        id: w.id,
        title: w.title,
        type: w.type,
        contentrating: w.contentrating,
        playable: hasMedia,
        media: hasMedia ? `${BASE}/media/${tokenFor(w.fileAbs)}` : null,
        // 真实容器后缀（小写、不含点）。**为什么必须由宿主给**：媒体 URL 是 token 形态
        //（`/media/<base64url>`），路径里没有扩展名 —— 客户端靠 URL 猜容器只会恒判"不可解"，
        // 于是"原生可解的源不整片重编码"这条治理永远不生效。客户端同样保留 URL 兜底，
        // 以便夹具/旧宿主没有这个字段时行为不变。
        mediaExt: w.fileAbs ? extOf(w.fileAbs) : null,
        preview: hasPreview ? `${BASE}/preview/${tokenFor(w.previewAbs)}` : null,
        frameUrl: hasFrame ? `${BASE}/scene-frame/${tokenFor(w.fileAbs)}` : null,
        // 加载期占位底色（主题色）：尚无抽帧图时的兜底，避免一上来就是黑屏。
        schemeColor: w.schemeColor || null,
        // Scene fields — WebWallGL live render,
        // embedded MP4, packaged audio, 自定义画面 (see sceneFieldsFor).
        ...sceneFieldsFor(w, hasFrame, customIds, sceneMtime),
        // Web wallpapers: WebWallGL live render (entry HTML + injected shim) +
        // the automatic first-frame cache (可能还没有 → GET 404 → 用主题色)。
        ...webFieldsFor(w, hasMedia, webMediaBase),
        // 「壁纸属性」面板入口：只有场景/网页壁纸的项目目录才有 project.json
        // 用户属性。**必须在这里统一给一次** —— 上面两个字段函数都返回过
        // propsUrl，webFieldsFor 的 null 会把场景壁纸的值盖掉（实测 216 张场景
        // 一张都拿不到，按钮因此不显示）。
        propsUrl: (w.type === 'scene' || w.type === 'web') && w.fileAbs
          ? `${BASE}/props/${tokenFor(w.fileAbs)}`
          : null,
        liveFrame: w.type === 'web' && hasMedia ? `${BASE}/live-frame/${tokenFor(w.fileAbs)}` : null,
      };
    }));
    // Custom storage: scanned fresh each request (read-A storage), appended
    // AFTER the WE wallpapers. Two shapes come out of enumerateUploadsP —
    // `up-*` single-file uploads (images / MP4) and `up-dir-*` WE project
    // directories (scene.pkg / index.html / *.mp4 with a project.json), i.e.
    // a WallpaperEM-style downloads folder. Both get the same scene fields as
    // the Steam scan, so a scene from either source plays identically
    // (live WebWallGL / static frame / embedded video / packaged audio).
    const uploadsDir = ensureUploadDir();
    const uploadMeta = readUploadMeta();
    const uploads = await Promise.all((await enumerateUploadsP(uploadsDir)).map(async (w) => {
      const isDirProject = w.id.startsWith('up-dir-');
      const me = metaEntry(uploadMeta, w.id);
      const [hasMedia, hasPreview, sceneMtime] = await Promise.all([
        (w.type === 'video' || w.type === 'web') && w.fileAbs
          ? pathExistsP(w.fileAbs) : Promise.resolve(false),
        w.previewAbs ? pathExistsP(w.previewAbs) : Promise.resolve(false),
        // 同 Steam 扫描：mtime 兼作存在性与 sceneVideo 探测缓存键。
        w.type === 'scene' && w.fileAbs ? mtimeOrNullP(w.fileAbs) : Promise.resolve(null),
      ]);
      const hasFrame = sceneMtime !== null;
      const webMediaBase = w.type === 'web' && hasMedia ? await mediaOriginApi.mediaOriginBase() : '';
      return {
        id: w.id,
        // Project directories carry their own project.json title/rating;
        // single-file uploads use uploads/.meta.json (written by the upload route).
        title: isDirProject ? (w.title || w.id) : (me.title || w.id),
        contentrating: isDirProject ? (w.contentrating || null) : me.contentrating,
        type: w.type,
        // Single-file uploads exist by construction (they came from readdir);
        // directory entries report real existence. Scenes need no media —
        // they go through frameUrl / live render.
        playable: isDirProject ? hasMedia : true,
        media: w.type === 'scene' ? null : `${BASE}/media/${tokenFor(w.fileAbs)}`,
        // 同 Steam 扫描：真实容器后缀（见那里的注释）。
        mediaExt: w.fileAbs ? extOf(w.fileAbs) : null,
        preview: hasPreview
          ? `${BASE}/preview/${tokenFor(w.previewAbs)}`
          : w.type === 'video'
            ? `${BASE}/video-preview/${tokenFor(w.fileAbs)}`
            : null,
        frameUrl: hasFrame ? `${BASE}/scene-frame/${tokenFor(w.fileAbs)}` : null,
        schemeColor: w.schemeColor || null,
        ...sceneFieldsFor(w, hasFrame, customIds, sceneMtime),
        // Directory-shaped web wallpapers (project.json + index.html) get the
        // same live render path as scene directories.
        ...webFieldsFor(w, hasMedia, webMediaBase),
        // 同上：propsUrl 只在条目里给一次（见 Steam 扫描处的注释）。
        propsUrl: (w.type === 'scene' || w.type === 'web') && w.fileAbs
          ? `${BASE}/props/${tokenFor(w.fileAbs)}`
          : null,
        liveFrame: w.type === 'web' && hasMedia ? `${BASE}/live-frame/${tokenFor(w.fileAbs)}` : null,
      };
    }));
    wallpapers.push(...uploads);
    const playableIds = new Set(wallpapers.filter((w) => w.playable).map((w) => w.id));
    const playlists = (await readPlaylistsP(installDir)).map((playlist) => {
      const ids = [];
      const seenIds = new Set();
      for (const item of playlist.items) {
        const id = playlistItemId(item, byPath, byId);
        if (id && !seenIds.has(id)) { seenIds.add(id); ids.push(id); }
      }
      return {
        id: playlist.id,
        name: playlist.name,
        order: playlist.order,
        delay: playlist.delay,
        wallpaperIds: ids,
        total: ids.length,
        portableCount: ids.filter((id) => playableIds.has(id)).length,
        unresolvedCount: Math.max(0, playlist.items.length - ids.length),
      };
    });
    // 场景壁纸渲染页的 mediaBase（**宿主是唯一真源**，客户端不得自己拼 `location.origin`）。
    // **不按适配器形态门控**：网页壁纸要独立源是为了绕能力头栅栏，而场景壁纸要它是为了
    // **带宽**（`scene.pkg` 实测到 336MB；走应用源那条路挤不过首帧预算）—— 这个理由与
    // "是不是桌面壳"无关，浏览器形态同样成立。库里有可实时渲染的场景才起监听（懒启动）。
    // 起不来（`mediaOriginDead`）仍返回 '' ⇒ 客户端据此回落应用源（慢但可见），而不是空白。
    const sceneMediaBase = wallpapers.some((w) => w.sceneLive) ? await mediaOriginApi.ensureSceneMediaOrigin() : '';
    const payload = {
      installDir,
      uploadDir: getUploadDir(),
      // WE 官方素材（local-assets）：客户端据此决定 scene-live URL 是否带
      // localAssets=1，并在设置面板展示配置状态。
      weAssetsDir: getWeAssetsDir(),
      weAssetsAvailable: weAssetsAvailable(),
      // 场景渲染页的 mediaBase（独立壁纸媒体源的 origin；'' = 回落应用源）。
      // 客户端把它拼上 `${BASE}/scene-files` 后交给渲染页 —— 见 `src/live-layer.js` 的
      // liveRenderUrl（**不要再**在那里拼 location.origin，那会把大 pkg 推回应用源那条路）。
      sceneMediaBase,
      total: wallpapers.length,
      portableCount: wallpapers.filter((w) => w.playable).length,
      wallpapers,
      playlists,
    };
    inventoryCache = { t: Date.now(), payload };
    // 视频壁纸先排队生成 faststart 变体（轮换列表优先）：第一次切就该快，而不是"用过一次才快"。
    // 串行、只排一次、单张失败不影响其它；见 warmFaststartFavorites。
    warmFaststart(wallpapers, log).catch(() => { /* 预热是优化 */ });
    return payload;
  }

  return buildInventory;
}
