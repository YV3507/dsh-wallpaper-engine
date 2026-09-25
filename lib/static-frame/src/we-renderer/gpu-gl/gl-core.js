// WE GPU 后端 — WebGL (supreium-headless-gl) 基础设施
// 跨平台策略 (sf40h 调研结论):
//   - supreium-headless-gl 仅提供 x64 prebuilds (win32-x64/linux-x64/darwin-x64,
//     ABI 108-147)。arm64/ia32 无 prebuild → 不加载, 调用方回退 CPU (与现状一致)。
//   - 加载失败 (缺包/ABI 不匹配/原生异常) → 返回 null, 调用方回退 CPU。
//   - 每 worker 进程单例上下文; 静态帧 worker 每帧新进程 → 进程内调用安全。
// 性能天花板 (勿指望 CPU 算法追平): 官方 WE 是 GPU 实时渲染 (D3D11 + 预编译
// shader blob, 每帧 ~16ms), 本引擎是 CPU 逐像素光栅化 (960×540 实测 ~1s/帧,
// 240 帧预渲染 ≈ 4 分钟)。差距 = GPU 并行 vs CPU 串行, 不是算法可补 → 只能靠
// GPU 后端。webgpu/Dawn (0.4.0) spike 实测 21x, 但同进程二次 create() 与
// unmap 后立即重建 pipeline 都会原生崩溃 (每进程一实例; 避免 unmap 后重建)。
import { createRequire } from 'node:module';

// x64 才尝试原生加载 (supreium prebuilds 仅 x64; 其他架构保持纯 CPU)
const SUPPORTED_ARCH = new Set(['x64']);
let _ctx = null; // { gl, createWindow } | null (null = 不可用)
let _probed = false;
// 修复: 记录 createGLContext 建立的上下文, resetGPU 时显式销毁
// (headless-gl 上下文不会被 GC 及时回收, 官方要求 STACKGL_destroy_context)
const _contexts = new Set();

/**
 * 惰性获取 WebGL 上下文工厂。返回 null 表示 GPU 不可用 (调用方回退 CPU)。
 * 同进程内重复调用复用同一实例 (headless-gl 多 context 可并行, 但单例省内存)。
 */
export function getWebGL(forceProbe = false) {
  if (_probed && !forceProbe) return _ctx;
  _probed = true;
  if (!SUPPORTED_ARCH.has(process.arch)) {
    _ctx = null;
    return null;
  }
  // sf41: DSH 宿主 (Electron) fork 的 worker 会继承 ELECTRON_RUN_AS_NODE env —
  // node-gyp-build 的 isElectron() 检查该变量 → 判定 runtime=electron →
  // supreium 的 node ABI prebuild 加载失败 → GPU 失效回退 CPU。
  // worker 是纯 Node (process.versions.electron 无), 只被这个 env 变量误导 →
  // 在 require supreium 前强制清理 (双保险: 宿主 fork 已净化, 这里再兜底)。
  try {
    if (process.env.ELECTRON_RUN_AS_NODE !== undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    if (process.env.ELECTRON_NO_ASAR !== undefined) delete process.env.ELECTRON_NO_ASAR;
  } catch { /* ignore */ }
  try {
    // 动态 require: 包缺失 (未安装) 时抛错 → 回退 CPU, 不炸
    const require = createRequire(import.meta.url);
    const mod = require('supreium-headless-gl');
    if (typeof mod !== 'function') { _ctx = null; return null; }
    _ctx = { createWindow: mod };
    return _ctx;
  } catch {
    _ctx = null;
    return null;
  }
}

/**
 * 创建 WebGL 上下文 (WebGL1 路径 — supreium 的 WebGL2 JS 模拟层有 bug,
 * 官方 WE shader 是 GLSL ES 1.0, WebGL1 足够)。
 * @returns {object|null} gl 上下文或 null
 */
export function createGLContext(width = 64, height = 64) {
  const g = getWebGL();
  if (!g) return null;
  try {
    const gl = g.createWindow(width, height, { isWebGL2: false });
    if (!gl) return null;
    _contexts.add(gl); // 供 resetGPU 统一销毁
    return gl;
  } catch {
    return null;
  }
}

/**
 * 显式销毁一个 headless-gl 上下文 (修复: 此前没有任何 STACKGL_destroy_context
 * 调用, 上下文与 GPU 资源只能等 GC — 上游文档明确要求手动销毁)。
 * 取不到扩展 (旧版本/不支持) 时静默返回, 绝不抛错。
 */
export function destroyGLContext(gl) {
  if (!gl) return;
  if (!_contexts.delete(gl)) return; // 未登记/已销毁 → 幂等直接返回
  try {
    const ext = gl.getExtension('STACKGL_destroy_context');
    if (ext && typeof ext.destroy === 'function') ext.destroy();
  } catch { /* 销毁失败不影响调用方 */ }
}

/** GPU 是否可用 (同步检查; 未探测则探测一次) */
export function isGPUAvailable() {
  return getWebGL() !== null;
}

/**
 * 关闭并销毁当前上下文 (测试/进程退出用)。
 */
export function resetGPU() {
  // 修复: 原先只把 _ctx 置 null — createGLContext 建立的上下文与显存常驻
  for (const gl of Array.from(_contexts)) destroyGLContext(gl);
  _ctx = null;
  _probed = false;
}
