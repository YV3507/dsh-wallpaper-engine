/**
 * log.js — 宿主侧**日志收口**：三档（`error` / `warn` / `info`）+ 终端镜像。
 *
 * 为什么值得独立成文件：宿主此前的输出全是散落的裸 `console.log`，「问题」与「细节」
 * 之间没有分界 —— 逐帧统计、心跳、成功事实与真正的故障混在同一条流里，终端默认看到的
 * 是一片噪音。收成一个入口之后，"默认终端只出问题"是一处开关，而不是几十个判断。
 *
 * 档位即 `ctx.logger` 的方法名（不自建数值等级表 —— 平台各档是**包含关系**：
 * `error ⊂ +info ⊂ +warn ⊂ +debug`，用自建阈值表达不出「只看 `warn`、不看 `info`」）：
 *   · `error` —— 会导致**插件 / DSH / 系统**出问题：核心能力起不来、数据/进程被破坏、需用户处理；
 *   · `warn`  —— **影响显示效果**的非正常表现：降级、回退、围栏拒绝、首帧超时、重试、被拒的请求；
 *   · `info`  —— 其余全部：诊断细节、逐帧统计、运行信息、成功事实的**日志侧**留痕。
 *
 * 一次调用喂两个出口：
 *   ① 平台通道 `ctx.logger[level](line)` —— DSH Desktop 的宿主把 `FileExporter` 挂在
 *      `ctx.logger` 上（`levels = { default: 3 }`，自身 threshold `info`），所以 `warn` 会落进
 *      `dsh-<date>.error.log`；本 profile 未挂 console exporter ⇒ 平台不会重复打到终端。
 *   ② 终端镜像 —— `error` / `warn` 默认可见，`info` 只在 `DSH_WE_LOG_LEVEL=info` 时可见。
 *      这一层是本模块自己的：平台的 exporter 只负责落档，不负责"默认终端安静"。
 *
 * 不变量：
 *   · **`lib/**` 里只有本模块与 `lib/notice.js` 允许直接调用 `console.*` / `process.stdout`**，
 *     其余宿主模块一律经它们（`test/verify-logging.mjs` 的 N1 把这条变成机器事实）。
 *   · 档位名与 `ctx.logger` 的方法名一一对应，**不自建数值等级表**。
 *   · `info` 永远不面向用户：默认不进终端，也不进提示通道（提示通道见 `lib/notice.js`）。
 *   · 任何一次写入失败（平台通道抛错 / 终端抛错）都**不得**改变调用点的控制流，也不上抛。
 *
 * 闸门：`DSH_WE_LOG_LEVEL` ∈ {`error`, `warn`, `info`}（大小写不敏感、忽略空白），默认 `warn`；
 * 非法值按默认走。每次调用现读环境变量 —— 闸门是一次性的进程级开关，不是"模块被 import 的
 * 那一刻"的隐式快照。
 */

/** 三档：字面量与 `ctx.logger` 的方法名同形（D3）。顺序 = 严重度递增。 */
const LEVELS = ['error', 'warn', 'info'];
/** 严重度名次：越小越严重。终端镜像的判据是"消息名次 ≤ 闸门名次"。 */
const RANK = { error: 0, warn: 1, info: 2 };
/** 缺省闸门：`warn` ⇒ 终端只镜像 `error` + `warn`。 */
const DEFAULT_LEVEL = 'warn';

/** 当前闸门（现读环境变量；非法值回落缺省）。 */
function gateRank() {
  const raw = String(process.env.DSH_WE_LOG_LEVEL || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANK, raw) ? RANK[raw] : RANK[DEFAULT_LEVEL];
}

/**
 * 造一个日志入口。返回**可调用**对象：`log(text, level?)` 与 `log.error/warn/info(text)`
 * 同义（前者给"调用点自带级别变量"的地方用，后者给字面量级别用）。
 *
 * @param {{error?:Function,warn?:Function,info?:Function}|null} logger 平台 logger（`ctx.logger(name)`）
 * @param {string} name 终端前缀里的名字（`[<name>]`）
 * @param {string} tag  可选子标签（`[<name>][<tag>]`），由 `log.tag(tag)` 派生
 */
export function createLog(logger, name, tag = '') {
  const prefix = '[' + name + ']' + (tag ? '[' + tag + ']' : '');

  function write(level, text) {
    const line = prefix + ' ' + String(text == null ? '' : text);
    // ① 平台通道（落档；本 profile 没有 console exporter，不会重复打到终端）
    try {
      const method = logger && logger[level];
      if (typeof method === 'function') method.call(logger, line);
    } catch { /* 平台通道失败不影响终端镜像，也不上抛 */ }
    // ② 终端镜像：只有"名次 ≤ 闸门"的档位可见（默认 = error + warn）
    if (RANK[level] <= gateRank()) {
      try { console[level](line); } catch { /* 终端不可写（管道已关等）不是调用点的错 */ }
    }
  }

  const levelOf = (level) => (Object.prototype.hasOwnProperty.call(RANK, level) ? level : 'info');

  const log = (text, level) => write(levelOf(level), text);
  for (const level of LEVELS) log[level] = (text) => write(level, text);
  /** 派生子标签入口：`log.tag('media')` ⇒ 行前缀 `[<name>][media]`。 */
  log.tag = (child) => createLog(logger, name, child);
  return log;
}
