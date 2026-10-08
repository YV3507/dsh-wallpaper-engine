/**
 * json-response.js —— 宿主 JSON 应答的**唯一实现**（状态码 + 两个头 + `end`）。
 *
 * 为什么单独一个模块：这段三行样板**只许有一处实现**。抄成多份时，差异既没人看得到、
 * 也没人能判定它是有意还是漏抄 —— 现存的一个真实差异：`routes/scene-frame.js` 与
 * `routes/we-assets.js` **不写 `Cache-Control`**，其余都写 `no-store`（见下方"缓存头口径"）。
 *
 * 缓存头口径（合并时的**唯一**取舍）：
 *   · **默认 `Cache-Control: no-store`** —— 本插件的端点全部回答**本机当前状态**
 *     （settings / 活动媒体 / 探针结果 / 配置），端口是随机的 `--port 0` 回环端口，
 *     任何一层缓存都只会让"刚改完却读到旧值"。
 *   · **`null` = 不写该头** —— 为**保持行为逐字不变**而保留的出口：调用的那一处若没有这
 *     个头，合并**不得**顺手把它加上（那是行为改动）。真要统一成 `no-store`，应当是一次
 *     **显式**的改动，而不是附带的副作用。
 *
 * 用法（路由里的局部名保留，改成薄别名即可零调用点改动）：
 *
 *   import { sendJson } from '../json-response.js';
 *   …
 *   const json = (code, payload) => sendJson(res, code, payload);
 *   const jsonOut = (code, payload) => sendJson(res, code, payload, null); // 不写缓存头
 *
 * ⚠️ **这不是 `bodyReader`（`lib/http-body.js`）的对偶**：那个解决"收请求体不许抄漏上限"，
 * 这个解决"发应答不许抄出差异"。两者都是**同一件事只有一处实现**这条约定的产物。
 *
 * 浏览器安全无关（这是宿主半边），无 import、无第三方依赖。
 */

/**
 * 发一个 JSON 应答（`application/json; charset=utf-8`，可带 `Cache-Control`）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} code HTTP 状态码。
 * @param {unknown} payload 载荷（由 `JSON.stringify` 序列化）。
 * @param {string|null} [cacheControl='no-store'] `Cache-Control` 的值；
 *   **`null` 表示不写该头**（见文件头"缓存头口径"）。
 */
export function sendJson(res, code, payload, cacheControl = 'no-store') {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheControl !== null) res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(payload));
}
