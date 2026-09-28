/**
 * notice.js — 宿主侧**成功提示通道**（sink 甲：终端一行）。只发"成功事实"，不发问题。
 *
 * 为什么单独一条通道：日志的档位是**问题的严重度**，而"壁纸已就绪 / 媒体源已监听"不是
 * 问题 —— 它不该被写成 `info`（那条档位默认不面向用户，只在排障开闸时才可见），也不该被
 * `DSH_WE_LOG_LEVEL` 的闸门连带关掉。DSH 自己对「面向人的成功提示」的做法就是裸
 * `console.log`（`dsh web: <url>`），本模块照此实现，是与平台**同构**，不是另立一套 IO：
 *   · 不经 logger、不带级别、**不落** `http.jsonl`、不进会话；
 *   · 唯一一次日志出口是**投递失败**（见下）。
 *
 * 契约：`createNotice(log, name)` ⇒ `notice(kind, text)`。
 *   · `kind` 走**编译期白名单**（`KINDS`）—— 不在表里的一律丢弃：这条通道的预算是"每条
 *     成功事实一行"，没有白名单就会退化成第二份日志（`test/verify-logging.mjs` 的 N2/N3
 *     把"极其少量"变成机器事实）。
 *   · `text` 允许传函数：闸门关掉时不构造那串注定被丢弃的字符串（与 `src/live-layer.js`
 *     的 `detail` 惰性求值同一手法）。
 *   · 幂等：`seen` 随 `apply(ctx)` 重建 ⇒ **每 kind 每会话至多一条**，HMR 重挂不重发。
 *   · **输出形状与其他终端行统一**：`[<name>] <text> ✔` —— 同一个 `name` 前缀让"哪一行是
 *     这个插件打的"一眼可辨，末尾的 `✔` 只表示"这是成功提示、不是问题"。守卫 R3 钉住这个
 *     形状（少给 `name` 会以 `[undefined]` 判红，而不是静默换一种格式）。
 *
 * 不变量：
 *   · **成功不产生日志**；只有投递失败产生一条 `warn`（`log.warn`）。
 *   · 非 TTY 是**策略性静默，不是投递失败** —— 它绝不报警（否则 `pnpm dsh web` 在转发
 *     stdout 时会把"通道按设计安静"误报成故障）。
 *   · 只发成功事实：任何"失败也要提示"的诉求都是把 `error` / `warn` 写进日志，而不是加
 *     第三种提示。
 *
 * 闸门（`DSH_WE_NOTICE`）三态：
 *   · `0`            → 静默，**不报**（用户主动关）；
 *   · `1`            → 强制输出（非 TTY 的显式 opt-in）；
 *   · 其它 / 未设     → 仅 `process.stdout.isTTY === true` 时输出，否则静默且不报。
 * Desktop 的宿主由 Electron 以 `stdio: "pipe"` fork（`dsh-plugin-desktop` 的
 * `startIsolatedDesktopHost`），`isTTY` 恒为假 ⇒ Desktop 里这条通道默认安静，要看就显式
 * 设 `DSH_WE_NOTICE=1`。
 */

/** 编译期白名单：新增一条提示必须先在这里登记（N2/N3 按它判）。 */
const KINDS = ['media-origin', 'scene-ready'];

/**
 * @param {{warn?:Function}|null} log 宿主日志入口（`lib/log.js`）——**只有失败路径**会用它
 * @param {string} name 行前缀里的名字（与传给 `lib/log.js` 的同一个）⇒ `[<name>]`
 */
export function createNotice(log, name) {
  const seen = new Set();
  /** 行前缀：与其他终端行同形（`[wallpaper-engine] …`）。 */
  const prefix = '[' + name + '] ';
  /**
   * 投递失败：本模块**唯一**的日志出口（成功路径绝不碰 `log`，判据 N4 钉住这条）。
   * 函数名是契约的一部分 —— 守卫按它定位"失败处理器"，改名会判红，不会静默失去覆盖。
   */
  function reportFailure(kind, err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 行首的 `notice` 是给事后 grep 用的固定标记（提示通道的失败只从这一行看得出来）。
    try { log.warn('notice 投递失败（' + kind + '）：' + msg); } catch { /* ignore */ }
  }
  return function notice(kind, text) {
    if (!KINDS.includes(kind)) return;
    if (seen.has(kind)) return;
    // 先记名再投递：一次会话里每条 kind 至多尝试一次，所以投递失败也只会有一条 `warn`。
    seen.add(kind);
    const gate = String(process.env.DSH_WE_NOTICE || '').trim();
    if (gate === '0') return;
    if (gate !== '1' && process.stdout.isTTY !== true) return;
    try {
      const body = typeof text === 'function' ? text() : text;
      process.stdout.write(prefix + body + ' ✔\n', (err) => { if (err) reportFailure(kind, err); });
    } catch (err) {
      reportFailure(kind, err);
    }
  };
}
