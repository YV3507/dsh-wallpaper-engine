// WE 渲染引擎 — 资源读取 (scene.pkg / 松散目录) 与纹理加载
import fs from 'node:fs';
import path from 'node:path';
import { decodePngBuffer } from './canvas.js';
import { parseTex, decodeTex } from '../pkg-extract.js';
import { decodeJpeg } from './jpeg.js';

// ── 松散 scene.json 目录访问器 ──────────────────────────────────
export function readPkgDir(dir) {
  const exists = (p) => fs.existsSync(path.join(dir, p));
  const read = (p) => {
    const f = path.join(dir, p);
    if (!fs.existsSync(f)) return null;
    return fs.readFileSync(f); // Buffer (兼容 toString('ascii') 等)
  };
  const readJson = (p) => { const b = read(p); return b ? JSON.parse(b.toString('utf8')) : null; };
  return {
    has: exists,
    entries: () => [],
    read,
    readJson,
    readText: (p) => { const b = read(p); return b ? b.toString('utf8') : null; },
  };
}

// ── scene.pkg 容器 ──────────────────────────────────────────────
export function readPkg(pkgPath) {
  const buf = fs.readFileSync(pkgPath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  // PKGV 容器: 支持两种头部布局
  // 旧: "PKGV" + u32 version + u32 count
  // 新: u32 ? + "PKGV0022" + u32 count (magic 在 offset 4)
  const magicAt0 = buf.toString('latin1', 0, 4);
  const magicAt4 = buf.toString('latin1', 4, 8);
  let count;
  let oldFormat = false;
  if (magicAt0 === 'PKGV') {
    oldFormat = true;
    pos = 4;
    pos += 4; // version
    count = dv.getInt32(pos, true); pos += 4;
  } else if (magicAt4 === 'PKGV') {
    // 新格式: [u32?][PKGV + 4 字符版本][u32 count] — magic 8 字节 (4-11), count @ 12
    pos = 12;
    count = dv.getInt32(pos, true); pos += 4;
  } else {
    throw new Error('not a PKGV container');
  }
  if (count <= 0 || count > 100000) throw new Error('invalid entry count ' + count);
  const entries = [];
  for (let i = 0; i < count; i++) {
    // name: u32 长度 + 字符串 (不 4 对齐; 字节级验证: nameLen@16=10, name@20-29, 直接接字段)
    const nameLen = dv.getInt32(pos, true); pos += 4;
    if (nameLen <= 0 || nameLen > 500) throw new Error('invalid name length ' + nameLen);
    const name = buf.toString('utf8', pos, pos + nameLen);
    pos += nameLen;
    // 条目字段: u32 offset + u32 size (小端)
    // 字节级验证 (PKGV0018, 2934788040): scene.json offset@30-33=0 size@34-37=3840;
    // materials/图层 2.tex offset@64-67=3840 size@68-71=2377110
    const offset = dv.getUint32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    entries.push({ name, offset, size });
    pos += 8;
  }
  // 数据区起点 = 描述区结束 (新格式 offset 相对数据区)
  const dataStart = pos;
  const map = new Map(entries.map((e) => [e.name, e]));
  const read = (p) => {
    const e = map.get(p);
    if (!e) return null;
    // 新格式 (PKGV@4): offset 一律相对 dataStart; 旧格式 (PKGV@0): 绝对偏移
    const abs = oldFormat ? e.offset : dataStart + e.offset;
    if (abs + e.size > buf.length) return null;
    return Buffer.from(buf.buffer, buf.byteOffset + abs, e.size);
  };
  const readJson = (p) => {
    const b = read(p);
    return b ? JSON.parse(b.toString('utf8')) : null;
  };
  return {
    has: (p) => map.has(p),
    entries: () => entries,
    read,
    readJson,
    readText: (p) => { const b = read(p); return b ? b.toString('utf8') : null; },
  };
}

// ── 动画图集帧选择 (TEXS 帧元数据) — 单一事实来源 ──────────────
// image.js 的「整图解码后裁剪」路径与 loadTexture 的「只解码该帧」路径共用本
// 函数, 两条路径的帧矩形因此逐位一致 —— 这是该优化无损的前提
// (docs/SCENE-FRAME-PERF.md §二十七)。返回 null 表示不是多帧图集。
export function atlasFrameRect(info, t) {
  if (!info || !info.frames || info.frames.length <= 1) return null;
  const count = info.frames.length;
  const duration = info.frames[0].frametime || 0.1;
  const index = Math.floor(t / duration) % count;
  const f = info.frames[index];
  if (!f) return null;
  const width = f.width || Math.floor(info.width / count);
  const height = f.height || info.height;
  const x = f.x || index * width;
  const y = f.y || 0;
  if (!(width > 0) || !(height > 0)) return null;
  return { index, x, y, width, height };
}

// ── 纹理解码 (TEXV 容器 → {width, height, rgba, frames?}) ──────
// opts.frameRect (可选): 只解码该矩形 (动画图集单帧)。仅在解码器确实走了区域
// 路径时 (frameDecoded) 才改变尺寸语义, 否则完全退回原有整图路径。
// infoPre (可选): 调用方已经 parseTex 过的头部信息 —— 复用它可以省掉一次整容器
// 解压 (压缩容器解压是顺序的, 60.8Mpx 图集约 250ms)。
export function loadTexImage(raw, opts, infoPre) {
  try {
    const info = infoPre || parseTex(raw);
    const frameRect = opts && opts.frameRect ? opts.frameRect : null;
    const dec = decodeTex(raw, frameRect ? { frameRect } : undefined);
    const frameDecoded = !!(frameRect && dec.kind === 'rgba' &&
      dec.width === frameRect.width && dec.height === frameRect.height);
    let width, height, rgba;
    if (dec.kind === 'png-pass') {
      const img = decodePngBuffer(Buffer.from(dec.bytes));
      width = img.width; height = img.height; rgba = img.rgba;
    } else if (dec.kind === 'jpeg') {
      const img = decodeJpeg(dec.bytes);
      width = img.width; height = img.height; rgba = img.rgba;
    } else {
      ({ width, height, rgba } = dec);
    }
    // 逻辑尺寸裁剪 (DXT padding) — 按帧解码时纹理尺寸就是帧尺寸, 不适用。
    // 若这里误跑, 会把帧大小的缓冲区按图集宽高重新解读并补零 → 静默损坏。
    if (!frameDecoded && (width !== info.width || height !== info.height)) {
      const srcW = width;
      width = info.width; height = info.height;
      const cropped = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) cropped.set(rgba.subarray(y * srcW * 4, y * srcW * 4 + width * 4), y * width * 4);
      rgba = cropped;
    }
    // 精灵图帧元数据 (TEXS: 帧数/时长/布局) — spritesheet 动画用。
    // 按帧解码后纹理已等于单帧, 不得再暴露 frames (否则上层会二次裁剪)。
    if (frameDecoded && (width !== frameRect.width || height !== frameRect.height)) {
      throw new Error('loadTexImage: 按帧解码结果尺寸不符 ' + width + 'x' + height +
        ' != ' + frameRect.width + 'x' + frameRect.height);
    }
    let frames = null;
    if (!frameDecoded && info.frames && info.frames.length > 1) {
      frames = {
        count: info.frames.length,
        duration: info.frames[0].frametime || 0.1,
        items: info.frames,
      };
    }
    return { width, height, rgba, frames };
  } catch (e) {
    throw e;
  }
}

export function loadPngFile(p) {
  const b = fs.readFileSync(p);
  return decodePngBuffer(b);
}
