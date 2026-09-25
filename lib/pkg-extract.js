/**
 * dsh-wallpaper-engine — scene.pkg / scene.json static-frame extractor.
 *
 * Extracts the MAIN texture of a Wallpaper Engine scene wallpaper as a
 * standalone static image the browser can show behind the GUI:
 *
 *   - Packed scenes (`scene.pkg`, magic PKGVxxxx): the PKG entry index is
 *     parsed, entries are decompressed (LZ4 block chains, the format WE uses
 *     inside PKG containers), then the TEX container of each candidate
 *     texture is decoded.
 *   - Loose scenes (`scene.json` + plain .tex/.json files, e.g. WE
 *     defaultprojects): the same pipeline runs over a path-fenced directory
 *     access layer.
 *   - TEX containers (magic TEXV0005/TEXI0001) are parsed for metadata,
 *     mipmaps (TEXB0001..4, LZ4 or raw) and animated GIF frame tables
 *     (TEXS0001..3). The first mipmap of the first image is decoded to
 *     RGBA8888 for RGBA8888 / R8 / RG88 / DXT1 / DXT3 / DXT5.
 *   - **Embedded JPEG textures**: Wallpaper Engine stores photographic
 *     textures as a complete JPEG payload inside the TEX container (the mip
 *     data starts with FFD8 JFIF). Those are returned as-is — zero decoding,
 *     the most faithful and cheapest path for photographic scene wallpapers
 *     (the skin-center's extractor misses this variant and silently falls
 *     back to a mask texture; this module fixes that).
 *
 * Candidate selection: the first scene.json object carrying an `image`
 * property wins (its direct .tex reference, or the textures listed by the
 * material / instance it points at), then remaining .tex files are ranked by
 * pixel area with `mask`/`normal` paths penalized (they are grayscale /
 * normal-map helpers, never the wallpaper art). The first candidate that
 * decodes cleanly is returned.
 *
 * Zero runtime dependencies (node:zlib only). Format knowledge mirrors the
 * public RePKG / lwe reverse-engineering of the Wallpaper Engine formats.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
// jpeg-js is only needed by the multi-layer compositor (a JPEG-embedded layer
// must become pixels before it can be blended); the single-texture path still
// passes embedded JPEGs through untouched.
// Vendored copy imported by relative path: the DSH 2.0.14+ host resolves bare
// specifiers against the app/profile roots, never the link: target, so
// `import ... from 'jpeg-js'` fails to resolve under a link: install.
import jpegJsVendor from './vendor/jpeg-js/index.js';
const { decode: decodeJpeg } = jpegJsVendor;
// 分阶段耗时剖析 (DSH_WE_PROFILE=1; 默认关闭时 profTime 直接透传, 零开销)。
// 与 lib/we-renderer 共用同一累加器, 便于一次报告同时看到渲染与合成两侧的成本。
import { profAdd, profTime, profileEnabled } from './we-renderer/profile.js';

/** Wallpaper Engine texture format ids (TEXI0001 header), per RePKG/lwe. */
const TexFormat = {
  RGBA8888: 0,
  RGB888: 1,
  RGB565: 2,
  DXT5: 4,
  DXT3: 6,
  DXT1: 7,
  RG88: 8,
  R8: 9,
  RG1616F: 10,
  R16F: 11,
  BC7: 12,
  RGBA1010102: 13,
  RGBA16161616F: 14,
  RGB161616F: 15,
};
const TEX_FORMAT_NAMES = {
  0: 'RGBA8888',
  1: 'RGB888',
  2: 'RGB565',
  4: 'DXT5',
  6: 'DXT3',
  7: 'DXT1',
  8: 'RG88',
  9: 'R8',
  10: 'RG1616F',
  11: 'R16F',
  12: 'BC7',
  13: 'RGBA1010102',
  14: 'RGBA16161616F',
  15: 'RGB161616F',
};
/** TEXI0001 flags bit marking an animated (sprite-sheet / gif) texture. */
const TEX_FLAG_IS_GIF = 4;

const textDecoder = new TextDecoder('utf-8');

/**
 * Bounds-checked little-endian binary reader. Every failed read throws an
 * Error prefixed with the reader label.
 */
class Reader {
  constructor(data, label) {
    this.data = data;
    this.label = label;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
  }
  get remaining() {
    return this.view.byteLength - this.pos;
  }
  need(n) {
    if (n < 0 || this.pos + n > this.view.byteLength) {
      throw new Error(this.label + ': unexpected end of data');
    }
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.pos++);
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** Unsigned 64-bit integer; safe up to 2^53. */
  u64() {
    const lo = this.u32();
    return this.u32() * 4294967296 + lo;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n) {
    this.need(n);
    const out = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** int32-length-prefixed UTF-8 string (PKG magic and entry paths). */
  sizedString(maxLength) {
    const length = this.i32();
    if (length < 0 || length > maxLength) {
      throw new Error(this.label + ': invalid string length ' + length);
    }
    return textDecoder.decode(this.bytes(length));
  }
  /** NUL-terminated string (all TEX magics and the TEXB0004 json blob). */
  nstring(maxLength) {
    const start = this.pos;
    let end = start;
    const limit = Math.min(this.view.byteLength, start + maxLength);
    while (end < limit && this.view.getUint8(end) !== 0) end++;
    if (end >= limit) throw new Error(this.label + ': unterminated string');
    const out = textDecoder.decode(this.data.subarray(start, end));
    this.pos = end + 1;
    return out;
  }
}

/**
 * Decompress one raw LZ4 block (the format inside PKG entry chains and TEXB
 * mipmaps) following the official lz4 block format specification.
 *
 * @param src compressed block bytes
 * @param dstSize exact expected decompressed size
 */
function lz4DecompressBlock(src, dstSize) {
  const dst = new Uint8Array(dstSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let s = 0;
      do {
        if (ip >= src.length) throw new Error('lz4: truncated literal length');
        s = src[ip++];
        literalLength += s;
      } while (s === 255);
    }
    if (ip + literalLength > src.length || op + literalLength > dstSize) {
      throw new Error('lz4: literal run out of bounds');
    }
    dst.set(src.subarray(ip, ip + literalLength), op);
    ip += literalLength;
    op += literalLength;
    if (ip >= src.length) break;
    if (ip + 2 > src.length) throw new Error('lz4: truncated match offset');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('lz4: invalid match offset ' + offset);
    let matchLength = token & 15;
    if (matchLength === 15) {
      let s = 0;
      do {
        if (ip >= src.length) throw new Error('lz4: truncated match length');
        s = src[ip++];
        matchLength += s;
      } while (s === 255);
    }
    matchLength += 4;
    if (op + matchLength > dstSize) throw new Error('lz4: match run out of bounds');
    for (let i = 0; i < matchLength; i++) {
      dst[op] = dst[op - offset];
      op++;
    }
  }
  if (op !== dstSize) {
    throw new Error('lz4: decompressed size mismatch (got ' + op + ', expected ' + dstSize + ')');
  }
  return dst;
}

/**
 * Probe whether the entry data at [abs, abs+length) is an LZ4 block chain:
 * int64 original size followed by [int32 uncomp][int32 comp][block] entries
 * that reconstruct exactly originalSize bytes while consuming the entry to
 * the byte. Returns the original size when the chain fits perfectly.
 */
function probeCompressedEntry(data, abs, length) {
  if (length < 8) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const originalSize = view.getUint32(abs, true) + view.getUint32(abs + 4, true) * 4294967296;
  if (originalSize <= length || originalSize > 2147483647) return null;
  let pos = abs + 8;
  let total = 0;
  while (total < originalSize) {
    if (pos + 8 > abs + length) return null;
    const uncomp = view.getInt32(pos, true);
    const comp = view.getInt32(pos + 4, true);
    if (uncomp <= 0 || comp <= 0 || pos + 8 + comp > abs + length) return null;
    total += uncomp;
    pos += 8 + comp;
  }
  return total === originalSize && pos === abs + length ? originalSize : null;
}

/**
 * Parse a PKG container (magic PKGVxxxx) and return its entry index.
 * Entry offsets in the returned list are absolute positions inside data.
 */
function parsePkg(data) {
  const r = new Reader(data, 'pkg');
  const magic = r.sizedString(32);
  if (!/^PKGV\d{4}$/.test(magic)) throw new Error("pkg: bad magic '" + magic + "'");
  const count = r.i32();
  if (count < 0 || count > 1048576) throw new Error('pkg: invalid entry count ' + count);
  const index = [];
  for (let i = 0; i < count; i++) {
    index.push({ path: r.sizedString(1024), offset: r.u32(), length: r.u32() });
  }
  const dataStart = r.pos;
  return index.map(({ path, offset, length }) => {
    const abs = dataStart + offset;
    if (abs + length > data.byteLength) throw new Error("pkg: entry '" + path + "' out of bounds");
    const originalSize = probeCompressedEntry(data, abs, length);
    return originalSize === null
      ? { path, offset: abs, compressedSize: length, size: length, flags: 0 }
      : { path, offset: abs, compressedSize: length, size: originalSize, flags: 1 };
  });
}

/**
 * Extract (and decompress, when the entry uses LZ4 block-chain storage) one
 * package entry. Returns a fresh buffer of exactly entry.size bytes.
 */
function readPkgEntry(data, entry) {
  const abs = entry.offset;
  if (abs < 0 || abs + entry.compressedSize > data.byteLength) {
    throw new Error("pkg: entry '" + entry.path + "' out of bounds");
  }
  if ((entry.flags & 1) === 0) return data.slice(abs, abs + entry.compressedSize);
  const r = new Reader(data.subarray(abs, abs + entry.compressedSize), 'pkg');
  if (r.u64() !== entry.size) throw new Error("pkg: entry '" + entry.path + "' size mismatch");
  const out = new Uint8Array(entry.size);
  let written = 0;
  while (written < entry.size) {
    const uncomp = r.i32();
    const comp = r.i32();
    if (uncomp <= 0 || comp <= 0 || written + uncomp > entry.size) {
      throw new Error("pkg: corrupt compressed entry '" + entry.path + "'");
    }
    out.set(lz4DecompressBlock(r.bytes(comp), uncomp), written);
    written += uncomp;
  }
  if (r.remaining !== 0) throw new Error("pkg: corrupt compressed entry '" + entry.path + "'");
  return out;
}

/** Read one mipmap record; containerVersion selects the TEXB layout. */
function readMipmap(r, containerVersion) {
  if (containerVersion === 4) {
    const param1 = r.i32();
    const param2 = r.i32();
    r.nstring(1 << 20);
    const param3 = r.i32();
    if (param1 !== 1 || param2 !== 2 || param3 !== 1) {
      throw new Error('tex: bad TEXB0004 mipmap params');
    }
  }
  const width = r.i32();
  const height = r.i32();
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error('tex: invalid mipmap dimensions ' + width + 'x' + height);
  }
  const metaOnly = r.metaOnly === true;
  if (containerVersion === 1) {
    const n = r.i32();
    const b = r.bytes(n); // 只是视图, 不复制
    return { width, height, bytes: metaOnly ? null : b, storedLength: n, payloadLength: n };
  }
  const isLz4 = r.i32() === 1;
  const decompressedCount = r.i32();
  const storedLength = r.i32();
  const stored = r.bytes(storedLength);
  if (metaOnly) {
    return {
      width, height, bytes: null, storedLength, isLz4,
      payloadLength: isLz4 ? decompressedCount : storedLength,
    };
  }
  if (isLz4) {
    return {
      width, height, bytes: lz4DecompressBlock(stored, decompressedCount),
      storedLength, payloadLength: decompressedCount,
    };
  }
  return { width, height, bytes: stored, storedLength, payloadLength: storedLength };
}

/** Parse a TEX container into metadata plus the first image's mipmaps. */
function parseTexInternal(data, opts) {
  const r = new Reader(data, 'tex');
  // metaOnly: 只读元数据, 不解压 mip0。解压是顺序的且很贵 (60.8Mpx ≈ 250ms),
  // 做候选筛选时不需要像素。见 docs §二十九。
  r.metaOnly = !!(opts && opts.metaOnly);
  const magic1 = r.nstring(16);
  if (magic1 !== 'TEXV0005') throw new Error("tex: bad magic '" + magic1 + "'");
  const magic2 = r.nstring(16);
  if (magic2 !== 'TEXI0001') throw new Error("tex: bad image-info magic '" + magic2 + "'");
  const format = r.i32();
  const flags = r.i32();
  const textureWidth = r.i32();
  const textureHeight = r.i32();
  const imageWidth = r.i32();
  const imageHeight = r.i32();
  r.u32();
  if (TEX_FORMAT_NAMES[format] === undefined) throw new Error('tex: unsupported format ' + format);
  const containerMagic = r.nstring(16);
  const containerMatch = /^TEXB000([1-4])$/.exec(containerMagic);
  if (!containerMatch) throw new Error("tex: bad mipmap container magic '" + containerMagic + "'");
  let containerVersion = Number(containerMatch[1]);
  const imageCount = r.i32();
  if (imageCount <= 0 || imageCount > 256) throw new Error('tex: invalid image count ' + imageCount);
  let isVideoMp4 = false;
  if (containerVersion === 3) r.i32();
  else if (containerVersion === 4) {
    const freeImageFormat = r.i32();
    isVideoMp4 = r.i32() === 1;
    if (!(freeImageFormat === -1 && isVideoMp4)) containerVersion = 3;
  }
  let firstImage = null;
  for (let i = 0; i < imageCount; i++) {
    const mipmapCount = r.i32();
    if (mipmapCount <= 0 || mipmapCount > 32) throw new Error('tex: invalid mipmap count ' + mipmapCount);
    const mipmaps = [];
    for (let j = 0; j < mipmapCount; j++) mipmaps.push(readMipmap(r, containerVersion));
    if (firstImage === null) firstImage = mipmaps;
  }
  const isAnimatedGif = (flags & TEX_FLAG_IS_GIF) !== 0;
  const frames = [];
  if (isAnimatedGif) {
    const frameMagic = r.nstring(16);
    const frameMatch = /^TEXS000([1-3])$/.exec(frameMagic);
    if (!frameMatch) throw new Error("tex: bad frame container magic '" + frameMagic + "'");
    const frameVersion = Number(frameMatch[1]);
    const frameCount = r.i32();
    if (frameCount < 0 || frameCount > 4096) throw new Error('tex: invalid frame count ' + frameCount);
    if (frameVersion === 3) {
      r.i32();
      r.i32();
    }
    for (let i = 0; i < frameCount; i++) {
      const imageId = r.i32();
      const frametime = r.f32();
      if (frameVersion === 1) {
        const x = r.i32();
        const y = r.i32();
        const width = r.i32();
        r.i32();
        r.i32();
        const height = r.i32();
        frames.push({ imageId, frametime, x, y, width, height });
      } else {
        const x = r.f32();
        const y = r.f32();
        const width = r.f32();
        r.f32();
        r.f32();
        const height = r.f32();
        frames.push({ imageId, frametime, x, y, width, height });
      }
    }
  }
  const mip0 = firstImage[0];
  // metaOnly 时 bytes 为 null (未解压), 无法判定 payload —— 返回 null 而不是抛错。
  // 预解码路径的 payload 判定在 worker 里做 (那时已经解压了)。
  const embedded = !mip0.bytes
    ? null
    : mip0.bytes.length >= 2 && mip0.bytes[0] === 0xff && mip0.bytes[1] === 0xd8
      ? 'jpeg'
      : mip0.bytes.length >= 8 && mip0.bytes[0] === 0x89 && mip0.bytes[1] === 0x50 && mip0.bytes[2] === 0x4e && mip0.bytes[3] === 0x47
        ? 'png'
        : null;
  return {
    format,
    flags,
    width: imageWidth > 0 ? imageWidth : textureWidth > 0 ? textureWidth : mip0.width,
    height: imageHeight > 0 ? imageHeight : textureHeight > 0 ? textureHeight : mip0.height,
    isAnimatedGif,
    isVideoMp4,
    frames,
    imageCount,
    mipmaps: firstImage,
    embedded,
  };
}

/** Parse a TEX container and return its metadata (never throws on payload). */
function parseTex(data) {
  const parsed = parseTexInternal(data);
  const info = {
    width: parsed.width,
    height: parsed.height,
    format: parsed.format,
    formatName: TEX_FORMAT_NAMES[parsed.format] ?? 'unknown(' + parsed.format + ')',
    isAnimatedGif: parsed.isAnimatedGif,
    isVideoMp4: parsed.isVideoMp4,
    imageCount: parsed.imageCount,
    mipLevels: parsed.mipmaps.length,
    embedded: parsed.embedded,
  };
  if (parsed.isAnimatedGif) info.frames = parsed.frames;
  return info;
}

// ── Embedded JPEG support ───────────────────────────────────────────────────
// Wallpaper Engine stores photographic textures as a complete JPEG payload
// inside the TEX mip data (the JPEG starts right where raw pixels would).
// Detect by the FFD8 SOI marker and hand back the bytes untouched.

/**
 * Scan JPEG markers for the first SOF segment and return { width, height }.
 * Returns null when the payload is not a parseable JPEG.
 */
function jpegSofDims(bytes) {
  const len = bytes.length;
  let p = 2;
  while (p + 9 < len) {
    if (bytes[p] !== 0xff) { p++; continue; }
    const marker = bytes[p + 1];
    if (marker === 0xd8) { p += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > len) return null;
      return {
        height: ((bytes[p + 5] << 8) | bytes[p + 6]) & 0xffff,
        width: ((bytes[p + 7] << 8) | bytes[p + 8]) & 0xffff,
      };
    }
    const segLen = ((bytes[p + 2] << 8) | bytes[p + 3]) & 0xffff;
    if (segLen < 2) return null;
    p += 2 + segLen;
  }
  return null;
}

function rgb565(value) {
  const r = (value >> 11) & 31;
  const g = (value >> 5) & 63;
  const b = value & 31;
  return [r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2];
}

/** Build the 4-color BC palette; three-color + transparent when DXT1 c0 <= c1. */
function buildColorPalette(c0, c1, fourColor) {
  const palette = new Uint8Array(16);
  const [r0, g0, b0] = rgb565(c0);
  const [r1, g1, b1] = rgb565(c1);
  palette.set([r0, g0, b0, 255], 0);
  palette.set([r1, g1, b1, 255], 4);
  if (fourColor) {
    palette.set([((2 * r0 + r1) / 3) | 0, ((2 * g0 + g1) / 3) | 0, ((2 * b0 + b1) / 3) | 0, 255], 8);
    palette.set([((r0 + 2 * r1) / 3) | 0, ((g0 + 2 * g1) / 3) | 0, ((b0 + 2 * b1) / 3) | 0, 255], 12);
  } else {
    palette.set([((r0 + r1) / 2) | 0, ((g0 + g1) / 2) | 0, ((b0 + b1) / 2) | 0, 255], 8);
    palette.set([0, 0, 0, 0], 12);
  }
  return palette;
}

/** Shared BC1/BC2/BC3 block walker (blockStride 8 for BC1, 16 for BC2/BC3). */
function decodeColorBlocks(src, out, width, height, blockStride, colorOffset, dxt1Alpha) {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const base = (by * blocksX + bx) * blockStride;
      const c0 = view.getUint16(base + colorOffset, true);
      const c1 = view.getUint16(base + colorOffset + 2, true);
      const palette = buildColorPalette(c0, c1, dxt1Alpha ? c0 > c1 : true);
      const indices = view.getUint32(base + colorOffset + 4, true);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= width || y >= height) continue;
          const selector = (indices >> (2 * (py * 4 + px))) & 3;
          const dst = (y * width + x) * 4;
          out[dst] = palette[selector * 4];
          out[dst + 1] = palette[selector * 4 + 1];
          out[dst + 2] = palette[selector * 4 + 2];
          out[dst + 3] = palette[selector * 4 + 3];
        }
      }
    }
  }
}

/** BC1 (DXT1): 8-byte blocks, 4x4 pixels, optional 1-bit alpha. */
function decodeDxt1(src, width, height) {
  const out = new Uint8Array(width * height * 4);
  decodeColorBlocks(src, out, width, height, 8, 0, true);
  return out;
}

/** BC2 (DXT3): 16-byte blocks, 4-bit explicit alpha + BC1-style color. */
function decodeDxt3(src, width, height) {
  const out = new Uint8Array(width * height * 4);
  decodeColorBlocks(src, out, width, height, 16, 8, false);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const base = (by * blocksX + bx) * 16;
      const alphaLo = view.getUint32(base, true);
      const alphaHi = view.getUint32(base + 4, true);
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + ((i / 4) | 0);
        if (x >= width || y >= height) continue;
        const nibble = i < 8 ? (alphaLo >> (4 * i)) & 15 : (alphaHi >> (4 * (i - 8))) & 15;
        out[(y * width + x) * 4 + 3] = nibble * 17;
      }
    }
  }
  return out;
}

/** BC3 (DXT5): 16-byte blocks, interpolated 3-bit alpha + BC1-style color. */
function decodeDxt5(src, width, height) {
  const out = new Uint8Array(width * height * 4);
  decodeColorBlocks(src, out, width, height, 16, 8, false);
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const base = (by * blocksX + bx) * 16;
      const a0 = src[base];
      const a1 = src[base + 1];
      const alphas = new Uint8Array(8);
      alphas[0] = a0;
      alphas[1] = a1;
      if (a0 > a1) {
        for (let k = 2; k < 8; k++) alphas[k] = (((8 - k) * a0 + (k - 1) * a1) / 7) | 0;
      } else {
        for (let k = 2; k < 6; k++) alphas[k] = (((6 - k) * a0 + (k - 2) * a1) / 5) | 0;
        alphas[6] = 0;
        alphas[7] = 255;
      }
      let bits =
        src[base + 2] +
        src[base + 3] * 256 +
        src[base + 4] * 65536 +
        src[base + 5] * 16777216 +
        src[base + 6] * 4294967296 +
        src[base + 7] * 1099511627776;
      for (let i = 0; i < 16; i++) {
        const x = bx * 4 + (i % 4);
        const y = by * 4 + ((i / 4) | 0);
        const index = bits % 8;
        bits = Math.floor(bits / 8);
        if (x >= width || y >= height) continue;
        out[(y * width + x) * 4 + 3] = alphas[index];
      }
    }
  }
  return out;
}

/**
 * When the declared mipmap size does not match the stored byte count, Wallpaper
 * Engine occasionally stores a downscaled mip while the container header keeps
 * the original dims. Derive the real dims from the data length when a clean
 * factorization exists; otherwise null.
 */
function deriveDims(storedBytes, width, height, bpp) {
  for (let w = width; w >= 16; w = Math.floor(w / 2)) {
    const bytesPerRow = w * bpp;
    if (storedBytes % bytesPerRow !== 0) continue;
    const h = storedBytes / bytesPerRow;
    if (Number.isInteger(h) && h > 0 && h <= height * 2) return { width: w, height: h };
  }
  return null;
}

/**
 * Decode the first (largest) mipmap of a TEX container.
 *
 * Returns `{ kind: 'jpeg', bytes, width, height }` / `{ kind: 'png-pass',
 * bytes, width, height }` when the mip payload is an embedded JPEG / PNG
 * (Wallpaper Engine stores photographic textures as complete JPEG/PNG files
 * inside the TEX container — returned untouched, zero decode, best fidelity),
 * or `{ kind: 'rgba', width, height, rgba }` for RGBA8888 / R8 / RG88 /
 * DXT1 / DXT3 / DXT5. Embedded MP4 textures and unknown formats throw a
 * descriptive error instead of failing silently.
 */
/**
 * 按需解码压缩纹理的一个子矩形（docs/SCENE-FRAME-PERF.md §二十七）。
 *
 * 块压缩格式（DXT1/3/5）的每个 4x4 块彼此独立，所以只要把目标区域覆盖到的
 * 块行/块列抽成一段连续源数据，再交给同一个解码器，就能得到该区域的像素。
 * 因为复用的是同一套解码函数，结果与「整图解码后再裁剪」逐字节相同——这是
 * 静默回退之外唯一允许的优化类型（无损、可证明）。
 *
 * 返回覆盖 rect 的 RGBA（尺寸 = rect），或 null 表示无法处理（调用方应回退
 * 到整图解码）。绝不返回近似结果。
 */
const FRAME_DECODE_MIN_PIXELS = 4 * 1024 * 1024;

function dxtDecoderFor(format) {
  if (format === TexFormat.DXT1) return { decode: decodeDxt1, blockBytes: 8 };
  if (format === TexFormat.DXT3) return { decode: decodeDxt3, blockBytes: 16 };
  if (format === TexFormat.DXT5) return { decode: decodeDxt5, blockBytes: 16 };
  return null;
}

function decodeDxtRegion(bytes, width, height, rect, format) {
  const dxt = dxtDecoderFor(format);
  if (!dxt) return null;
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  // 只接受完全落在图集内的区域，越界一律回退（不做夹取，避免静默改变语义）。
  if (rect.x < 0 || rect.y < 0) return null;
  if (rect.x + rect.width > width || rect.y + rect.height > height) return null;
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const bx0 = Math.floor(rect.x / 4);
  const by0 = Math.floor(rect.y / 4);
  const bx1 = Math.min(blocksX, Math.ceil((rect.x + rect.width) / 4));
  const by1 = Math.min(blocksY, Math.ceil((rect.y + rect.height) / 4));
  const nbx = bx1 - bx0;
  const nby = by1 - by0;
  if (nbx <= 0 || nby <= 0) return null;
  const stride = nbx * dxt.blockBytes;
  const sub = new Uint8Array(stride * nby);
  for (let by = 0; by < nby; by++) {
    const src = ((by0 + by) * blocksX + bx0) * dxt.blockBytes;
    if (src < 0 || src + stride > bytes.length) return null;
    sub.set(bytes.subarray(src, src + stride), by * stride);
  }
  const dec = dxt.decode(sub, nbx * 4, nby * 4);
  // 块对齐会把区域起点向左上吸附，这里再裁回精确的 rect。
  const ox = rect.x - bx0 * 4;
  const oy = rect.y - by0 * 4;
  const decStride = nbx * 4;
  if (ox + rect.width > decStride || oy + rect.height > nby * 4) return null;
  const out = new Uint8Array(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let y = 0; y < rect.height; y++) {
    const s = ((oy + y) * decStride + ox) * 4;
    out.set(dec.subarray(s, s + rowBytes), y * rowBytes);
  }
  return out;
}

/**
 * 只取 TEX 容器的头部信息 + mip0 字节, 不做像素解码。
 * 供「块行并行预解码」把 mip0 交给 worker (docs §二十九)。
 * 注意: 压缩容器的 mip0.bytes 是**解压后**的数据, 解压本身是顺序的, 不可并行。
 * 返回 null 表示容器不可解析; 内嵌 JPEG/PNG payload 的容器由调用方跳过。
 */
function texMip0Info(data, opts) {
  const parsed = parseTexInternal(data, opts);
  if (!parsed || !parsed.mipmaps || !parsed.mipmaps.length) return null;
  const mip0 = parsed.mipmaps[0];
  return {
    // 逻辑尺寸 = 最终纹理尺寸 (loadTexImage 会把解码结果裁到这里)
    width: parsed.width,
    height: parsed.height,
    // 存储尺寸 = mip0 自身的尺寸, **解码必须用它** (它决定块/行跨距)。
    // 二者常常不同 (如逻辑 3281 而 mip0 是 3280/3284), 用错会导致块行错位 ——
    // 第 0 块行看着正常, 其后每行漂移一个块。
    storageWidth: mip0.width,
    storageHeight: mip0.height,
    format: parsed.format,
    frames: parsed.frames ? parsed.frames.length : 0,
    isAnimated: !!parsed.isAnimatedGif,
    storedLength: mip0.storedLength,
    payloadLength: mip0.payloadLength,
    bytes: mip0.bytes, // metaOnly 时为 null (未解压)
  };
}

/**
 * Decode a TEX container to pixels.
 *
 * `opts.frameIndex`（可选）请求「只解码动画图集的某一帧」：仅对 DXT 压缩、
 * 帧数 > 1、且图集不小于 FRAME_DECODE_MIN_PIXELS 的纹理生效，返回尺寸等于该
 * 帧的纹理（frames = null）。其余情况一律按原路径整图解码，语义完全不变。
 */
function decodeTex(data, opts) {
  const parsed = parseTexInternal(data);
  if (parsed.isVideoMp4) {
    throw new Error('tex: video mp4 textures cannot be decoded to a static frame');
  }
  const mip0 = parsed.mipmaps[0];
  if (
    opts && opts.frameRect && parsed.isAnimatedGif &&
    !process.env.DSH_WE_NO_ATLAS_FRAME &&
    parsed.width * parsed.height >= FRAME_DECODE_MIN_PIXELS
  ) {
    const rect = opts.frameRect;
    const rgba = decodeDxtRegion(mip0.bytes, parsed.width, parsed.height, rect, parsed.format);
    if (rgba) {
      return { kind: 'rgba', width: rect.width, height: rect.height, rgba, frames: null };
    }
  }
  // Embedded JPEG texture — pass the payload through untouched.
  if (mip0.bytes.length >= 2 && mip0.bytes[0] === 0xff && mip0.bytes[1] === 0xd8) {
    const dims = jpegSofDims(mip0.bytes);
    return {
      kind: 'jpeg',
      bytes: mip0.bytes,
      width: dims ? dims.width : parsed.width,
      height: dims ? dims.height : parsed.height,
    };
  }
  // Embedded PNG texture (newer WE scenes; photographic art, incl. transparent
  // PNG sprites) — pass the payload through untouched. IHDR dims are
  // big-endian at bytes 16-23.
  if (
    mip0.bytes.length >= 24 &&
    mip0.bytes[0] === 0x89 && mip0.bytes[1] === 0x50 &&
    mip0.bytes[2] === 0x4e && mip0.bytes[3] === 0x47
  ) {
    const ihdrW = (mip0.bytes[16] << 24) | (mip0.bytes[17] << 16) | (mip0.bytes[18] << 8) | mip0.bytes[19];
    const ihdrH = (mip0.bytes[20] << 24) | (mip0.bytes[21] << 16) | (mip0.bytes[22] << 8) | mip0.bytes[23];
    return {
      kind: 'png-pass',
      bytes: mip0.bytes,
      width: ihdrW > 0 ? ihdrW : parsed.width,
      height: ihdrH > 0 ? ihdrH : parsed.height,
    };
  }
  let { width, height, bytes } = mip0;
  // Embedded MP4 / QuickTime video texture (WE "sync" animations flag the TEX
  // as RGBA8888 but store an MP4 file; TEXI flags 0x2000/0x2200 mark them).
  // MP4 boxes start with [u32 big-endian size]['ftyp' ...]. The size sanity
  // check matters: raw RGBA textures can coincidentally start with bytes that
  // spell 'ftyp' in a pixel, but their leading u32 is pixel data, not a box
  // length (raw RGBA at w*h*4 is far larger than any small pixel value).
  if (bytes.length >= 12) {
    const boxSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    if (
      boxSize >= 12 && boxSize <= bytes.length &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    ) {
      throw new Error('tex: embedded mp4 video texture cannot be decoded to a static frame');
    }
  }
  switch (parsed.format) {
    case TexFormat.RGBA8888: {
      if (bytes.length < width * height * 4) {
        const derived = deriveDims(bytes.length, width, height, 4);
        if (!derived) throw new Error('tex: mipmap size mismatch for RGBA8888');
        width = derived.width;
        height = derived.height;
      }
      return { kind: 'rgba', width, height, rgba: bytes.slice(0, width * height * 4) };
    }
    case TexFormat.R8: {
      if (bytes.length < width * height) {
        // ★ WE 常把"R8 意图"的贴图以 DXT 存储 (加载期由 ConvertTexture0Format 转换):
        //   实测 <WE>/assets/materials/particle/fog1.tex 头部 format=9, 但 1024x1024 只有
        //   680,757B (真 R8 需 1,048,576B) —— 正是 DXT1+完整 mip 链的量级。
        //   旧实现按 R8 逐字节读 ⇒ 越界读全 0 + alpha 硬写 255 ⇒ **不透明黑/白实心方块**,
        //   并波及遮罩类贴图 (皓风琦 opacity 遮罩全 0 ⇒ 覆盖度 100%→0%)。
        const d1 = Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
        const d5 = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
        if (bytes.length >= d1) {
          try { return { kind: 'rgba', width, height, rgba: decodeDxt1(bytes, width, height) }; } catch { /* 落原路径 */ }
        } else if (bytes.length >= d5) {
          try { return { kind: 'rgba', width, height, rgba: decodeDxt5(bytes, width, height) }; } catch { /* 落原路径 */ }
        }
        const derived = deriveDims(bytes.length, width, height, 1);
        if (!derived) throw new Error('tex: mipmap size mismatch for R8');
        width = derived.width;
        height = derived.height;
      }
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = bytes[i];
        rgba[i * 4 + 1] = bytes[i];
        rgba[i * 4 + 2] = bytes[i];
        rgba[i * 4 + 3] = 255;
      }
      return { kind: 'rgba', width, height, rgba };
    }
    case TexFormat.RG88: {
      if (bytes.length < width * height * 2) {
        const derived = deriveDims(bytes.length, width, height, 2);
        if (!derived) throw new Error('tex: mipmap size mismatch for RG88');
        width = derived.width;
        height = derived.height;
      }
      const rgba = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        rgba[i * 4] = bytes[i * 2];
        rgba[i * 4 + 1] = bytes[i * 2 + 1];
        rgba[i * 4 + 2] = 0;
        rgba[i * 4 + 3] = 255;
      }
      return { kind: 'rgba', width, height, rgba };
    }
    case TexFormat.DXT1: {
      const expected = Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
      if (bytes.length < expected) throw new Error('tex: mipmap size mismatch for DXT1');
      return { kind: 'rgba', width, height, rgba: decodeDxt1(bytes, width, height) };
    }
    case TexFormat.DXT3: {
      const expected = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
      if (bytes.length < expected) throw new Error('tex: mipmap size mismatch for DXT3');
      return { kind: 'rgba', width, height, rgba: decodeDxt3(bytes, width, height) };
    }
    case TexFormat.DXT5: {
      const expected = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
      if (bytes.length < expected) throw new Error('tex: mipmap size mismatch for DXT5');
      return { kind: 'rgba', width, height, rgba: decodeDxt5(bytes, width, height) };
    }
    default:
      throw new Error('tex: unsupported format ' + parsed.format);
  }
}

/**
 * Extract the embedded MP4 payload from a video-texture TEX container
 * (WE "sync" video textures: TEXI0001 flags it, or mip0 starts with an
 * MP4 ftyp box). Returns the raw MP4 bytes, or null when the TEX is not
 * a video texture. Used by the scene static-frame pipeline to feed the
 * embedded video to ffmpeg for a still frame.
 */
function extractTexVideoMp4(raw) {
  try {
    const parsed = parseTexInternal(raw);
    if (!parsed || !parsed.mipmaps || !parsed.mipmaps.length) return null;
    if (parsed.isVideoMp4) return Buffer.from(parsed.mipmaps[0].bytes);
    const bytes = parsed.mipmaps[0].bytes;
    if (bytes && bytes.length >= 12) {
      const boxSize = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
      if (
        boxSize >= 12 && boxSize <= bytes.length &&
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      ) {
        return Buffer.from(bytes);
      }
    }
  } catch { /* not a video TEX / malformed */ }
  return null;
}

// ── PNG encoder (zero dependencies) ──────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 4294967295) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * 裁掉四周连续的**纯黑**行列 —— 纹理图集的 padding。
 *
 * 为什么需要：单纹理路径拿到的往往是壁纸的**图集**（常见 2048²/4096² 的 2 的
 * 幂次方画布），作者把画面放在其中一条带上、其余留黑。原样当静态帧用时，客户端
 * `background-size: cover` 以**图集中心**为准铺满 → 屏幕上一大片黑、画面只在边上
 * （用户反馈：「加载期间的抽帧图没铺满屏幕」，实测两张帧分别是 4096²/2048² 的
 * 方图、画面只在顶部一条带里）。裁成画面本身之后，cover 就是用户要的
 * 「高度为准、两边裁掉」。
 *
 * 只裁**四周连续全黑**（阈值 8/255，给压缩噪声留余量），不动画面内部的暗部；
 * 裁完任一维小于原图 10% 就放弃 —— 那是整张纯黑/异形的画面，裁了没意义还可能
 * 把有效内容裁掉。
 */
function cropBlackEdges(width, height, rgba, threshold = 8) {
  const rowBlack = (y) => {
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      if (rgba[i] > threshold || rgba[i + 1] > threshold || rgba[i + 2] > threshold || rgba[i + 3] > threshold) return false;
    }
    return true;
  };
  const colBlack = (x) => {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (rgba[i] > threshold || rgba[i + 1] > threshold || rgba[i + 2] > threshold || rgba[i + 3] > threshold) return false;
    }
    return true;
  };
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;
  while (top < bottom && rowBlack(top)) top++;
  while (bottom > top && rowBlack(bottom)) bottom--;
  while (left < right && colBlack(left)) left++;
  while (right > left && colBlack(right)) right--;
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w >= width && h >= height) return null;         // 没有可裁的
  if (w < width * 0.1 || h < height * 0.1) return null; // 裁完太小 → 放弃
  return { x: left, y: top, width: w, height: h };
}

/** 按裁切框抽出子图（行长按裁剪后宽度重排）。对 Buffer / Uint8Array 都安全：
 *  decodeTex 返回的是普通 Uint8Array，用 Buffer#copy 会抛。 */
function cropRgba(rgba, srcWidth, crop) {
  const out = new Uint8Array(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y++) {
    const srcStart = ((crop.y + y) * srcWidth + crop.x) * 4;
    out.set(rgba.subarray(srcStart, srcStart + crop.width * 4), y * crop.width * 4);
  }
  return out;
}

/**
 * 输出前裁掉图集 padding。**绝不抛错** —— 候选循环里任何异常都会被当成
 * 「这张贴图不可用」而跳过，从而悄悄换掉选中的画面（实测踩坑：cropRgba 用
 * Buffer#copy 抛 "rgba.copy is not a function"，4096² 的作者原画被跳过，
 * 最后选中一张 256² 的水波法线贴图当静态帧）。裁不了就返回 null = 原样输出。
 */
function cropFrameForOutput(rgba, width, height) {
  try {
    const crop = cropBlackEdges(width, height, rgba);
    if (!crop) return null;
    return {
      width: crop.width,
      height: crop.height,
      rgba: cropRgba(rgba, width, crop),
      note: width + 'x' + height + '→' + crop.width + 'x' + crop.height,
    };
  } catch {
    return null;
  }
}

/**
 * Encode RGBA8888 pixels as a minimal PNG (8-bit RGBA, filter type 0) using
 * node:zlib deflate and a hand-rolled CRC32. Zero dependencies.
 */
function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('png: invalid dimensions ' + width + 'x' + height);
  }
  if (rgba.length !== width * height * 4) throw new Error('png: rgba buffer size mismatch');
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Scene pipeline ───────────────────────────────────────────────────────────

/** Extract .tex candidate paths referenced by one scene.json image object. */
function collectImageObjectTextures(imageObject, readJson) {
  const out = [];
  const pushTextureList = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const name =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && typeof item.name === 'string'
            ? item.name
            : null;
      if (name && name.toLowerCase().endsWith('.tex')) out.push(name);
    }
  };
  const ref = imageObject.image;
  if (ref.toLowerCase().endsWith('.tex')) out.push(ref);
  else {
    const material = readJson(ref);
    if (material && Array.isArray(material.passes)) {
      for (const pass of material.passes) pushTextureList(pass && pass.textures);
    }
  }
  const instance = imageObject.instance;
  if (instance && typeof instance === 'object') pushTextureList(instance.textures);
  return out;
}

/** SceneAccess over a packed scene.pkg container (case-insensitive paths). */
function pkgSceneAccess(pkgData) {
  const entries = parsePkg(pkgData);
  const byPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]));
  const readFile = (path) => {
    const entry = byPath.get(path.toLowerCase());
    if (!entry) return null;
    return { path: entry.path, bytes: readPkgEntry(pkgData, entry) };
  };
  return {
    readJson: (path) => {
      const file = readFile(path);
      if (!file) return null;
      try {
        return JSON.parse(textDecoder.decode(file.bytes));
      } catch {
        return null;
      }
    },
    readFile,
    listTexPaths: () => entries.filter((entry) => entry.path.toLowerCase().endsWith('.tex')).map((entry) => entry.path),
  };
}

/**
 * SceneAccess over a loose scene project directory (scene.json plus loose
 * .tex/.json files, e.g. WE defaultprojects). Reads are fenced inside the
 * directory; texture references escaping it resolve to null.
 */
function dirSceneAccess(dir) {
  const readFile = (path) => {
    const abs = resolve(dir, path);
    if (abs !== dir && !abs.startsWith(dir + sep)) return null;
    try {
      if (!statSync(abs).isFile()) return null;
      return { path, bytes: new Uint8Array(readFileSync(abs)) };
    } catch {
      return null;
    }
  };
  const listTexPaths = () => {
    const out = [];
    const walk = (sub, depth) => {
      if (depth > 4) return;
      let names = [];
      try {
        names = readdirSync(sub === '' ? dir : join(dir, sub));
      } catch {
        return;
      }
      for (const name of names) {
        const rel = sub === '' ? name : sub + '/' + name;
        let isDir = false;
        let isFile = false;
        try {
          const stat = statSync(join(dir, rel));
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
        if (isDir) walk(rel, depth + 1);
        else if (isFile && name.toLowerCase().endsWith('.tex')) out.push(rel);
      }
    };
    walk('', 0);
    return out;
  };
  return {
    readJson: (path) => {
      const file = readFile(path);
      if (!file) return null;
      try {
        return JSON.parse(textDecoder.decode(file.bytes));
      } catch {
        return null;
      }
    },
    readFile,
    listTexPaths,
  };
}

/**
 * Shared scene pipeline over one access layer; label prefixes error text.
 *
 * Candidate order: textures referenced by the first scene object with an
 * `image` property first, then every other .tex ranked by a score that favors
 * wallpaper art — embedded JPEG/PNG payloads (WE only lossy-encodes
 * photographic art), full-color formats (RGBA8888/RGB888), and large areas —
 * while masks, depth/normal/effect helpers, R8/RG88 grayscale formats and
 * embedded workshop asset folders are heavily penalized.
 *
 * A post-decode quality gate rejects grayscale (>88% gray) and flat (near-zero
 * variance) frames — a mask/depth texture can never be the wallpaper — and
 * moves on to the next candidate. When nothing passes, the caller sees an
 * error and falls back to the project preview.
 *
 * Returns `{ mime, bytes, width, height, texturePath }`.
 */
const PATH_PENALTY_RE =
  /(^|[\\/])(masks?|effects?)([\\/]|$)|[\\/]workshop[\\/]|_mask|mask_|normal|depth|ripple|foliagesway|cloudmotion|shake|pulse|xray|opacity|lens|cursor|flow|grad|noise|particle|vignette|blur|sync|_anim|frame|seq/i;
/** Format → art-likelihood multiplier (embedded JPEG/PNG handled separately). */
const FORMAT_PENALTY = {
  0: 1, // RGBA8888
  1: 1, // RGB888
  7: 0.5, // DXT1
  6: 0.5, // DXT3
  4: 0.5, // DXT5
  8: 0.01, // RG88 — grayscale helper
  9: 0.01, // R8 — grayscale helper
  2: 0.1, // RGB565
  12: 0.05, // BC7
  13: 0.1, // RGBA1010102
  10: 0.05, 11: 0.05, 14: 0.05, 15: 0.05, // float formats
};

/** Sample the decoded frame: grayscale ratio + mean channel variance.
 *  采样**必须可复现**：此前用 `Math.random()` 去重取样 —— 同一张帧每次得到不同的
 *  grayRatio/meanVar，连"拒收理由"的数值都会变（实测 `var=31.6` ↔ `30.9`），使质量门
 *  不可复现、A/B 与回归验收没法比对。现改为**固定种子的 LCG**（结构不变、统计性质与随机
 *  取样一致，但同样输入必得同样输出）。刻意**不用**等间距取样：那会与规则纹理（棋盘/条纹）
 *  发生别名，反而让门禁误判。 */
function frameQuality(width, height, rgba) {
  const total = width * height;
  const n = Math.min(2000, total);
  const seen = new Set();
  let seed = 0x9e3779b9;                       // 固定种子 ⇒ 可复现
  const nextIdx = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed >>> 8) % total; };
  let gray = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    let idx;
    do { idx = nextIdx(); } while (seen.has(idx));
    seen.add(idx);
    const o = idx * 4;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    sr += r; sg += g; sb += b;
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 24) gray++;
  }
  const mr = sr / n, mg = sg / n, mb = sb / n;
  let v = 0;
  for (const idx of seen) {
    const o = idx * 4;
    v += Math.abs(rgba[o] - mr) + Math.abs(rgba[o + 1] - mg) + Math.abs(rgba[o + 2] - mb);
  }
  return { grayRatio: gray / n, meanVar: v / (n * 3) };
}

/** The quality gate: reject grayscale masks/depth and flat solid fills. */
function isAcceptableFrame(q) {
  if (q.grayRatio > 0.88) return false;
  if (q.meanVar < 3) return false;
  return true;
}

// Embedded-PNG decode cap (pixels). Bounds decode memory for quality probes
// AND composite layer decode. 40MP (~160MB RGBA peak) covers 8K art and
// oversized puppet-warp cutouts like 长安雪's 导出初音 4862×3288 (16MP) —
// the old 12MP cap silently dropped such layers, leaving composite(2)=背景+栏杆
// with the character missing.
const PNG_GATE_MAX_PIXELS = 40 * 1024 * 1024;

/**
 * Decode an embedded-PNG payload (8-bit RGB/RGBA only) to raw RGBA8888.
 * Payloads larger than PNG_GATE_MAX_PIXELS are refused (bounding decode
 * memory); null is also returned on any parse failure.
 */
function decodePngPayload(bytes, maxPixels) {
  const limit = maxPixels === undefined ? PNG_GATE_MAX_PIXELS : maxPixels;
  const b = Buffer.from(bytes);
  if (!(b.length >= 33 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG')) return null;
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  const ct = b[25];
  const channels = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (w <= 0 || h <= 0 || w > 16384 || h > 16384 || !channels || w * h > limit) return null;
  const idats = [];
  let p = 8;
  while (p < b.length) {
    if (p + 12 > b.length) return null;
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    if (p + 12 + len > b.length) return null;
    if (type === 'IDAT') idats.push(b.subarray(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!idats.length) return null;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idats));
  } catch {
    return null;
  }
  const stride = w * channels + 1;
  if (raw.length < stride * h) return null;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const line = raw.subarray(y * stride + 1, (y + 1) * stride);
    // ⚠️ 必须按**像素步进 4 字节**写入。原实现直接把源字节下标 x 当目标下标用
    // (`rgba[y * w * 4 + x]`): 对 RGBA (channels=4) 恰好等价, 但对 **RGB (channels=3)**
    // 会把 3 字节/像素**紧密排列**进 4 字节/像素的缓冲区 —— 每行只填满前
    // 3w/4w = **75%** 的字节, 后 25% 保持 0 (透明); 且通道逐像素错位 ⇒ 颜色发灰。
    // 实测 3669681034 的 7680x4320 colorType=2 内嵌 PNG 正是此症状 (左侧 75% 有内容
    // 且发灰、右侧 25% 全透明), 而渲染器那份 decodePngBuffer 对同一 payload 解码正确。
    for (let px = 0; px < w; px++) {
      for (let ch = 0; ch < channels; ch++) {
        const d = y * w * 4 + px * 4 + ch;
        const a = px > 0 ? rgba[d - 4] : 0;
        const pr = y > 0 ? rgba[d - w * 4] : 0;
        const pc = (y > 0 && px > 0) ? rgba[d - w * 4 - 4] : 0;
        let v = line[px * channels + ch];
        if (f === 1) v = (v + a) & 255;
        else if (f === 2) v = (v + pr) & 255;
        else if (f === 3) v = (v + ((a + pr) >> 1)) & 255;
        else if (f === 4) {
          const q = a + pr - pc;
          const pa = Math.abs(q - a);
          const pb = Math.abs(q - pr);
          const pcv = Math.abs(q - pc);
          v = (v + (pa <= pb && pa <= pcv ? a : pb <= pcv ? pr : pc)) & 255;
        }
        rgba[d] = v;
      }
      // RGB 源没有 alpha 通道 ⇒ 显式补不透明。原实现从不写 alpha 槽, 导致整幅趋近全透明。
      if (channels === 3) rgba[y * w * 4 + px * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/**
 * Quality-check an embedded-PNG payload WITHOUT committing to it: decode
 * and run the same grayscale/flat gate. Payloads larger than
 * PNG_GATE_MAX_PIXELS are trusted (bounding decode memory); returns null
 * then, or on any parse failure — the caller treats null as "accept".
 */
function pngQuality(bytes) {
  const d = decodePngPayload(bytes);
  return d ? frameQuality(d.width, d.height, d.rgba) : null;
}

// ── Multi-layer scene compositing ────────────────────────────────────────────
// A scene with several image objects (e.g. multi-panel layouts like workshop
// 3615954176 守岸人 — three 1664×2432 portrait panels side by side at
// x≈612/1910/3229) must be composited WITH the scene transforms. The
// single-texture path otherwise returns only ONE panel, and the client's
// cover fit then shows just the middle slice of the composition (the reported
// "只显示中间部分" bug).
//
// Geometry: the object origin is the layer CENTER in scene space, and WE
// scene.json uses **y-up** coordinates (origin at the scene bottom-left —
// verified on 3407400739 泳装明日香: iris quads at origin.y≈1600 land on the
// face after y' = H − y, matching the workshop preview; treating origin as
// y-down sent eye/highlight layers to the lower body and rendered white eyes).
// Pass 2 flips layer centers into canvas y-down once the canvas height is
// known. Size comes from the image json's width/height, then the object size,
// then the decoded texture; object scale multiplies; alignment anchors an
// edge; parent chains fold root-down. Rotation is not resampled (the quad is
// placed unrotated — rotating a bitmap would need full affine sampling and
// rotated 2D layers are rare in practice).

/** Parse a "x y z" scene-vector string; def when missing/malformed. */
function parseSceneVec3(val, def) {
  if (typeof val === 'string') {
    const parts = val.trim().split(/\s+/).map(parseFloat);
    if (parts.length >= 3 && !parts.some(isNaN)) return [parts[0], parts[1], parts[2]];
  }
  return def;
}

/** The scene's declared projection (authoring viewport), or null. */
function sceneProjectionSize(scene) {
  const general = scene && scene.general;
  const proj = general && general.orthogonalprojection;
  const rawW = proj && proj.width;
  const rawH = proj && proj.height;
  const width = typeof rawW === 'number' && Number.isFinite(rawW) && rawW > 0 ? Math.floor(rawW) : 0;
  const height = typeof rawH === 'number' && Number.isFinite(rawH) && rawH > 0 ? Math.floor(rawH) : 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Fold the parent transform chain (linux-wallpaperengine
 * CImage::resolveTransform): a child's origin/scale are relative to the
 * already-resolved parent, so grouped objects only land correctly after
 * folding. Walk leaf-first with a visited check + depth cap against cycles,
 * then accumulate root-down: offset = rotate(childOrigin * parentScale,
 * parentAngle).
 */
function resolveObjectTransform(sceneObjects, obj, defOrigin) {
  const chain = [obj];
  let cur = obj;
  while (cur.parent != null && chain.length <= 32) {
    const parent = sceneObjects.find((o) => o && o.id === cur.parent);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
    cur = parent;
  }
  const root = chain[chain.length - 1];
  let origin = parseSceneVec3(root.origin, defOrigin);
  let scale = parseSceneVec3(root.scale, [1, 1, 1]);
  let angle = parseSceneVec3(root.angles, [0, 0, 0])[2];
  for (let i = chain.length - 2; i >= 0; i--) {
    const localOrigin = parseSceneVec3(chain[i].origin, [0, 0, 0]);
    const localScale = parseSceneVec3(chain[i].scale, [1, 1, 1]);
    const localAngle = parseSceneVec3(chain[i].angles, [0, 0, 0])[2];
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    origin = [
      origin[0] + localOrigin[0] * scale[0] * c - localOrigin[1] * scale[1] * s,
      origin[1] + localOrigin[0] * scale[0] * s + localOrigin[1] * scale[1] * c,
      origin[2] + localOrigin[2] * scale[2],
    ];
    scale = [scale[0] * localScale[0], scale[1] * localScale[1], scale[2] * localScale[2]];
    angle += localAngle;
  }
  return { origin, scale, angle };
}

/** Resolve a WE material texture reference ('ricepod/jet') to a tex path. */
function resolveSceneTexPath(access, ref) {
  const want = String(ref).toLowerCase().replace(/\.tex$/i, '');
  if (!want) return null;
  return access.listTexPaths().find((p) => {
    const lower = p.toLowerCase();
    return lower === want + '.tex'
      || lower === 'materials/' + want + '.tex'
      || lower.endsWith('/' + want + '.tex')
      || lower.endsWith('/' + want);
  }) || null;
}

/** First non-render-target texture reference of a material pass. */
function firstPassTextureRef(pass) {
  const list = pass && Array.isArray(pass.textures) ? pass.textures : null;
  if (!list) return null;
  for (const item of list) {
    const ref = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof item.name === 'string'
        ? item.name
        : null;
    if (ref && !ref.startsWith('_rt_')) return ref;
  }
  return null;
}

/**
 * Puppet 贴图连通性：32×32 alpha 网格上最大连通域 / 不透明格总数。
 * 部件图集（长安雪 导出初音 0.33、Kirito asuna body bottom 0.33）多个孤立
 * 块散布 → 低；完整立绘/眼贴/肢体件（≥0.49，多数为 1.0）→ 高。
 * PUPPET_ATLAS_MAX 以下视为图集：静态合成 blit = 五官四散，必须跳过。
 */
const PUPPET_ATLAS_MAX = 0.45;
function puppetAtlasRatio(rgba, w, h) {
  const N = 32;
  const counts = new Uint16Array(N * N);
  const step = Math.max(1, Math.floor(w / 256));
  for (let y = 0; y < h; y++) {
    const gy = Math.min(N - 1, Math.floor((y * N) / h));
    const row = y * w;
    for (let x = 0; x < w; x += step) {
      if (rgba[(row + x) * 4 + 3] > 32) {
        counts[gy * N + Math.min(N - 1, Math.floor((x * N) / w))]++;
      }
    }
  }
  const cell = new Uint8Array(N * N);
  let opaque = 0;
  for (let i = 0; i < N * N; i++) { cell[i] = counts[i] >= 2 ? 1 : 0; opaque += cell[i]; }
  if (!opaque) return 0;
  const seen = new Uint8Array(N * N);
  let best = 0;
  for (let i = 0; i < N * N; i++) {
    if (!cell[i] || seen[i]) continue;
    let size = 0;
    const q = [i];
    seen[i] = 1;
    while (q.length) {
      const c = q.pop();
      size++;
      const cy = (c / N) | 0, cx = c % N;
      if (cx > 0 && cell[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; q.push(c - 1); }
      if (cx < N - 1 && cell[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; q.push(c + 1); }
      if (cy > 0 && cell[c - N] && !seen[c - N]) { seen[c - N] = 1; q.push(c - N); }
      if (cy < N - 1 && cell[c + N] && !seen[c + N]) { seen[c + N] = 1; q.push(c + N); }
    }
    if (size > best) best = size;
  }
  return best / opaque;
}

/** Decode a TEX container to raw RGBA pixels, whatever the payload kind. */function decodeTexToRgba(bytes) {
  const decoded = decodeTex(bytes);
  if (decoded.kind === 'rgba') return decoded;
  if (decoded.kind === 'jpeg') {
    const jpg = decodeJpeg(Buffer.from(decoded.bytes), { useTArray: true, maxResolutionInMP: 64 });
    return { width: jpg.width, height: jpg.height, rgba: jpg.data };
  }
  if (decoded.kind === 'png-pass') return decodePngPayload(decoded.bytes);
  return null;
}

/** Source-over blend one layer onto the canvas, with a layer alpha multiplier. */
function blitLayer(canvas, cw, ch, rgba, w, h, x0, y0, alpha) {
  for (let y = 0; y < h; y++) {
    const cy = y0 + y;
    if (cy < 0 || cy >= ch) continue;
    for (let x = 0; x < w; x++) {
      const cx = x0 + x;
      if (cx < 0 || cx >= cw) continue;
      const si = (y * w + x) * 4;
      const sa = (rgba[si + 3] / 255) * alpha;
      if (sa <= 0) continue;
      const di = (cy * cw + cx) * 4;
      const da = canvas[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      canvas[di] = Math.round((rgba[si] * sa + canvas[di] * da * (1 - sa)) / outA);
      canvas[di + 1] = Math.round((rgba[si + 1] * sa + canvas[di + 1] * da * (1 - sa)) / outA);
      canvas[di + 2] = Math.round((rgba[si + 2] * sa + canvas[di + 2] * da * (1 - sa)) / outA);
      canvas[di + 3] = Math.round(outA * 255);
    }
  }
}

/**
 * 单趟"重采样 + 合成": 把纹理直接双线性重采样并 source-over 合成到画布。
 *
 * 取代旧路径 (先 `resizeBilinear` 算出整层缓冲, 再 `blitLayer` 拷贝合成), 后者对每层要
 *   ① 分配一份**整层尺寸**的中间 RGBA 缓冲 (大分配), 并完整写入一遍;
 *   ② 再从头读一遍做 alpha 合成 (第二趟); 且遍历的是**整层**, 画外部分白算。
 * 旧实现已删除 (改动后无调用方); 等价性由 scripts/verify-composite-blit.mjs 守护。
 *
 * 逐位等价性 (改动前提): 旧 `resizeBilinear` 的输出 out(x,y) 由
 * `(x+0.5)*w/outW-0.5` 处的双线性抽样得出, 而旧 `blitLayer` 读的正是该 out(x,y)。
 * 因此"先算出整层 out, 再取其中可见部分"与"只为可见部分算 out(x,y)"结果相同 ——
 * 本函数把两条采样/舍入表达式**逐字保留**(含运算次序, 浮点加法不满足结合律),
 * 只是把中间结果直接就地合成, 不再落地。⇒ 输出像素完全一致。
 *
 * 附带的收益: 只遍历与画布相交的矩形, 旧实现是重采样整层后再按画布裁剪丢弃。
 *
 * @param {Uint8Array} rgba 源纹理
 * @param {number} w,h      源纹理尺寸
 * @param {number} outW,outH 图层在画布上的目标尺寸 (= L.lw, L.lh)
 * @param {number} x0,y0    图层左上角在画布上的位置
 * @param {number} alpha    图层 alpha 乘数
 */
function blitLayerScaled(canvas, cw, ch, rgba, w, h, outW, outH, x0, y0, alpha) {
  // 无缩放 ⇒ 原路径本来就是单趟 (blitLayer 直接读源), 保持调用以免重复代码
  if (outW === w && outH === h) { blitLayer(canvas, cw, ch, rgba, w, h, x0, y0, alpha); return; }
  if (outW <= 0 || outH <= 0 || w <= 0 || h <= 0) return;
  // 可见区 (图层局部坐标) = 图层矩形 ∩ 画布 —— 旧实现遍历整层后逐像素裁剪
  const lx0 = Math.max(0, -x0), lx1 = Math.min(outW, cw - x0);
  const ly0 = Math.max(0, -y0), ly1 = Math.min(outH, ch - y0);
  if (lx1 <= lx0 || ly1 <= ly0) return;
  const xRatio = w / outW, yRatio = h / outH;
  const n = lx1 - lx0;
  // 列映射按可见列预计算 (Int32Array/Float64Array: 可见宽度个元素, 与整层缓冲无关)
  const colA = new Int32Array(n), colB = new Int32Array(n), colF = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sx = (lx0 + i + 0.5) * xRatio - 0.5;
    const ax = Math.max(0, Math.min(w - 1, Math.floor(sx)));
    colA[i] = ax * 4;
    colB[i] = Math.min(w - 1, ax + 1) * 4;
    colF[i] = Math.min(Math.max(sx - ax, 0), 1);
  }
  const baseX = x0 + lx0;
  for (let ly = ly0; ly < ly1; ly++) {
    const sy = (ly + 0.5) * yRatio - 0.5;
    const ay = Math.max(0, Math.min(h - 1, Math.floor(sy)));
    const rowA = ay * w * 4;
    const rowB = Math.min(h - 1, ay + 1) * w * 4;
    const fy = Math.min(Math.max(sy - ay, 0), 1);
    const ify = 1 - fy;
    const cy = y0 + ly;
    let di = (cy * cw + baseX) * 4;
    for (let i = 0; i < n; i++, di += 4) {
      const a0 = rowA + colA[i], b0 = rowA + colB[i];
      const a1 = rowB + colA[i], b1 = rowB + colB[i];
      const fx = colF[i];
      const ifx = 1 - fx;
      // ↓↓ 与 resizeBilinear 内层逐字一致 (含运算次序)
      const sr = Math.round(rgba[a0] * ifx * ify + rgba[b0] * fx * ify + rgba[a1] * ifx * fy + rgba[b1] * fx * fy);
      const sg = Math.round(rgba[a0 + 1] * ifx * ify + rgba[b0 + 1] * fx * ify + rgba[a1 + 1] * ifx * fy + rgba[b1 + 1] * fx * fy);
      const sb = Math.round(rgba[a0 + 2] * ifx * ify + rgba[b0 + 2] * fx * ify + rgba[a1 + 2] * ifx * fy + rgba[b1 + 2] * fx * fy);
      const sa8 = Math.round(rgba[a0 + 3] * ifx * ify + rgba[b0 + 3] * fx * ify + rgba[a1 + 3] * ifx * fy + rgba[b1 + 3] * fx * fy);
      // ↓↓ 与 blitLayer 内层逐字一致 (含运算次序)
      const sa = (sa8 / 255) * alpha;
      if (sa <= 0) continue;
      const da = canvas[di + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      canvas[di] = Math.round((sr * sa + canvas[di] * da * (1 - sa)) / outA);
      canvas[di + 1] = Math.round((sg * sa + canvas[di + 1] * da * (1 - sa)) / outA);
      canvas[di + 2] = Math.round((sb * sa + canvas[di + 2] * da * (1 - sa)) / outA);
      canvas[di + 3] = Math.round(outA * 255);
    }
  }
}

/** Hard cap for the composite canvas (8K UHD). Beyond this we fall back to
 *  the single-texture path rather than risk a huge allocation. */
const COMPOSITE_MAX_PIXELS = 7680 * 4320;

/**
 * Composite every visible image object of a 2D scene into one frame.
 * Returns null when the scene is not a multi-layer 2D scene (single image,
 * 3D models present, too few decodable layers) — the caller then keeps using
 * the single-texture path.
 */
// 诊断 (DSH_WE_DIAG_COMPOSITE=1): 记录多层合成为何未被采用 —— 供对照实验与排障。
// 走导出函数而非 console (库内不直接打印), 由脚本读取。
let _compositeDiag = null;
function compositeBail(reason, detail) {
  if (process.env.DSH_WE_DIAG_COMPOSITE === '1') _compositeDiag = { reason, detail };
  return null;
}

function tryCompositeSceneLayers(scene, access, label) {
  const objects = scene.objects;
  // 3D model scenes use UV maps on meshes, not 2D desktop quads.
  if (objects.some((o) => o && typeof o.model === 'string' && o.model.length > 0)) return compositeBail('has-model');
  const isHelperName = (n) => {
    const l = String(n || '').toLowerCase();
    return l.includes('black') || l.includes('len') || l.includes('util')
      || l.includes('flare') || l.includes('blend') || l === 'sun' || l === 'sun2';
  };
  const imageObjects = objects.filter((o) =>
    o && typeof o.image === 'string'
    && !o.image.startsWith('models/util/')
    && o.visible !== false
    && !(o.visible && typeof o.visible === 'object' && o.visible.value === false)
    && !isHelperName(o.name)
    && !PATH_PENALTY_RE.test(o.image));
  if (imageObjects.length < 2) return compositeBail('few-image-objects', imageObjects.length + ' 层 / 共 ' + objects.length + ' 对象');

  const projection = sceneProjectionSize(scene);
  const defOrigin = projection
    ? [projection.width / 2, projection.height / 2, 0]
    : [1920, 1080, 0];

  // Pass 1: resolve + decode every layer.
  // decodeCache: texPath → 解码结果 (本次调用内复用; 见循环内说明)
  const layers = [];
  const decodeCache = new Map();
  // 诊断: 统计有多少层来自 puppet 对象 —— puppet 的材质贴图是**图集**,
  // 而图层过滤没有排除它们, 若整张图集被当普通 quad 贴上, 画面会出现"部件网格"。
  let puppetLayers = 0;
  for (const obj of imageObjects) {
    let modelJson = null;
    let texRef = null;
    let texPath = null;
    if (obj.image.toLowerCase().endsWith('.tex')) {
      texRef = obj.image;
      // 直接指向遮罩/特效贴图的层没有画面内容，仍跳过
      if (PATH_PENALTY_RE.test(String(texRef))) continue;
      texPath = resolveSceneTexPath(access, texRef);
    } else {
      modelJson = access.readJson(obj.image);
      // Puppet-warp 层在**合成路径里不是一律跳过**：眼贴/肢体件/完整立绘 blit 静态
      // 效果正确（尤诺2 的眼睛全画布贴图补全底图五官 —— 跳过=白眼修坏）；只有
      // 「部件图集」（连通性 < PUPPET_ATLAS_MAX，如长安雪 导出初音）blit
      // 才是五官四散 —— 那条判定只用在下方的**单图层候选**路径（puppetSkip），
      // 合成路径与 #88 / 回滚前 main 的已验证行为一致：整层照贴、不丢层。
      // 两种材质约定: model json 带 material 字段 → 材质 json;
      // 或 obj.image 本身即材质 (含 passes[].textures, 见 collectImageObjectTextures)。
      let matJson = null;
      if (modelJson && typeof modelJson.material === 'string') {
        matJson = access.readJson(modelJson.material)
          || access.readJson('materials/' + modelJson.material);
      }
      if (!matJson && modelJson && Array.isArray(modelJson.passes)) matJson = modelJson;
      if (!matJson || !Array.isArray(matJson.passes)) continue;
      // 收集全部 pass 的纹理引用，优先能解析的非遮罩路径 —— 旧逻辑只取首个
      // pass 的首张贴图，遇 masks/ 引用就把整层丢弃（长安雪缺栏杆的根因）。
      const refs = [];
      for (const pass of matJson.passes) {
        const list = pass && Array.isArray(pass.textures) ? pass.textures : null;
        if (!list) continue;
        for (const item of list) {
          const name = typeof item === 'string'
            ? item
            : item && typeof item === 'object' && typeof item.name === 'string'
              ? item.name
              : null;
          if (name && !name.startsWith('_rt_') && refs.indexOf(name) === -1) refs.push(name);
        }
      }
      for (const r of refs) {
        if (PATH_PENALTY_RE.test(r)) continue; // 遮罩/特效贴图不当画面层
        const p = resolveSceneTexPath(access, r);
        if (p) { texRef = r; texPath = p; break; }
      }
    }
    if (!texPath) continue;
    // 解码缓存 (本次调用内): 同一张贴图常被多个对象引用 —— 实测 3486806915 的
    // 鸟_00020.tex (7680x7920, 单次解码 1308ms) 被 6 个对象引用, 重复解码 6 次
    // ≈ 7.8s, 占该场景全部解码成本 (8.9s) 的绝大部分。命中时**连 pkg 读取一起跳过**。
    // 缓存的是解码结果本身; 下方 cropoffset 分支只派生新的 img 对象、不改缓存内容,
    // 且 blitLayerScaled 只读不写 ⇒ 输出像素不受影响。
    let img = null;
    if (decodeCache.has(texPath)) {
      img = decodeCache.get(texPath);
      if (profileEnabled) profAdd('合成:解码缓存命中', 0);
    } else {
      const file = access.readFile(texPath);
      if (!file) continue;
      profTime('合成:纹理解码', () => {
        try { img = decodeTexToRgba(file.bytes); } catch { img = null; }
      });
      // 只缓存成功结果 (失败不缓存, 保持与原先"每次重试"一致的行为)
      if (img) decodeCache.set(texPath, img);
    }
    if (!img || img.width < 16 || img.height < 16) continue;
    // Puppet 层元数据（图集/覆盖率）收集后在循环末统一过滤 —— 部件拼装型
    // 场景（Kirito x Asuna：几十个骨骼驱动小件，origin 只是暂存位置）静态
    // blit=四处乱飞；过滤规则见 layers 循环后的说明。

    // Layer size: image json width/height, then the object size, then the
    // decoded texture; object scale multiplies on top.
    const tr = resolveObjectTransform(objects, obj, defOrigin);
    let lw = 0;
    let lh = 0;
    const declaredW = modelJson && typeof modelJson.width === 'number' ? modelJson.width : 0;
    const declaredH = modelJson && typeof modelJson.height === 'number' ? modelJson.height : 0;
    if (declaredW > 0 && declaredH > 0) {
      lw = declaredW;
      lh = declaredH;
    } else if (typeof obj.size === 'string') {
      const parts = obj.size.trim().split(/\s+/).map(parseFloat);
      if (parts.length >= 2 && !parts.some(isNaN)) { lw = parts[0]; lh = parts[1]; }
    }
    if (!lw || !lh) { lw = img.width; lh = img.height; }

    // cropoffset: the image json samples a sub-rect of the texture.
    if (declaredW > 0 && declaredH > 0 && modelJson && typeof modelJson.cropoffset === 'string') {
      const parts = modelJson.cropoffset.trim().split(/\s+/).map(parseFloat);
      const ox = parts.length >= 2 && !parts.some(isNaN) ? parts[0] : 0;
      const oy = parts.length >= 2 && !parts.some(isNaN) ? parts[1] : 0;
      const cx0 = Math.max(0, Math.min(Math.round(ox), img.width - 1));
      const cy0 = Math.max(0, Math.min(Math.round(oy), img.height - 1));
      const cwCrop = Math.max(1, Math.min(Math.round(declaredW), img.width - cx0));
      const chCrop = Math.max(1, Math.min(Math.round(declaredH), img.height - cy0));
      if (cx0 !== 0 || cy0 !== 0 || cwCrop !== img.width || chCrop !== img.height) {
        const cropped = new Uint8Array(cwCrop * chCrop * 4);
        for (let y = 0; y < chCrop; y++) {
          cropped.set(
            img.rgba.subarray(((cy0 + y) * img.width + cx0) * 4, ((cy0 + y) * img.width + cx0 + cwCrop) * 4),
            y * cwCrop * 4,
          );
        }
        img = { width: cwCrop, height: chCrop, rgba: cropped };
      }
    }

    lw *= Math.abs(tr.scale[0]) || 1;
    lh *= Math.abs(tr.scale[1]) || 1;
    let cx = tr.origin[0];
    // Y 轴**不翻转**：2D 图层的 origin 是屏幕式 y-down 坐标；3D 世界坐标的 y-up
    // 是渲染器里由相机矩阵处理的，两者不是同一套坐标（见渲染器 model.js 的
    // NDC→屏幕映射 `sy = (0.5 - ndcY*0.5) * H`）。此处与 #88 / 回滚前 main 的
    // 已验证实现逐字一致 —— 追版时误并入的「统一翻转」会让每层上下镜像。
    let cy = tr.origin[1];
    if (modelJson && modelJson.fullscreen === true && projection) {
      lw = projection.width;
      lh = projection.height;
      cx = projection.width / 2;
      cy = projection.height / 2;
    }
    // alignment anchors the quad by half its scaled size per side (default
    // 'center' leaves the origin at the quad center).
    const alignment = typeof obj.alignment === 'string' ? obj.alignment.toLowerCase() : '';
    if (alignment.includes('left')) cx += lw / 2;
    else if (alignment.includes('right')) cx -= lw / 2;
    if (alignment.includes('top')) cy -= lh / 2;
    else if (alignment.includes('bottom')) cy += lh / 2;
    const alpha = typeof obj.alpha === 'number' && Number.isFinite(obj.alpha)
      ? Math.min(1, Math.max(0, obj.alpha))
      : 1;
    if (modelJson && modelJson.puppet) puppetLayers++;
    layers.push({ img, cx, cy, lw: Math.round(lw), lh: Math.round(lh), alpha });
  }
  // A single surviving layer is served better by the passthrough path
  // (embedded JPEG/PNG keep their original bytes there).
  if (layers.length < 2) return compositeBail('few-layers', layers.length + ' 层可解码 / ' + imageObjects.length + ' 候选');

  // Pass 2: canvas. The declared projection is authoritative; without one,
  // the canvas is the layers' bounding box (multi-panel scenes usually omit
  // the projection and simply span their panels).
  let cw;
  let ch;
  let offX = 0;
  let offY = 0;
  if (projection) {
    cw = projection.width;
    ch = projection.height;
  } else {
    // 包围盒与图层同一坐标系（y-down）计算，再平移让左上角落在 (0,0)。
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const L of layers) {
      minX = Math.min(minX, L.cx - L.lw / 2);
      maxX = Math.max(maxX, L.cx + L.lw / 2);
      minY = Math.min(minY, L.cy - L.lh / 2);
      maxY = Math.max(maxY, L.cy + L.lh / 2);
    }
    offX = -Math.floor(minX);
    offY = -Math.floor(minY);
    cw = Math.ceil(maxX - minX);
    ch = Math.ceil(maxY - minY);
  }
  if (cw <= 0 || ch <= 0 || cw * ch > COMPOSITE_MAX_PIXELS) return compositeBail('bad-canvas', cw + 'x' + ch);

  const canvas = new Uint8Array(cw * ch * 4);
  // WE clears the scene with its clear color. scene.json general.clearcolor is
  // the authoritative source and — crucially — lives INSIDE scene.pkg, while
  // the author's schemecolor property sits in project.json, which a packed
  // scene.pkg does NOT contain (so pkg scenes never saw the fill). Without
  // this fill, areas outside the layers stay transparent and render as a
  // black band over the dark GUI background (reported on 3615954176 守岸人:
  // black strip below the panels).
  const general = scene.general;
  const clearRaw = general && typeof general.clearcolor === 'string' ? general.clearcolor : null;
  const project = access.readJson('project.json');
  const schemeRaw = project && project.general && project.general.properties
    && project.general.properties.schemecolor && project.general.properties.schemecolor.value;
  const scheme = (general && general.clearenabled === false)
    ? null
    : parseSceneVec3(clearRaw, null) || parseSceneVec3(schemeRaw, null);
  if (scheme) {
    const r = Math.round(Math.min(1, Math.max(0, scheme[0])) * 255);
    const g = Math.round(Math.min(1, Math.max(0, scheme[1])) * 255);
    const b = Math.round(Math.min(1, Math.max(0, scheme[2])) * 255);
    for (let i = 0; i < cw * ch; i++) {
      canvas[i * 4] = r;
      canvas[i * 4 + 1] = g;
      canvas[i * 4 + 2] = b;
      canvas[i * 4 + 3] = 255;
    }
  }

  profTime('合成:重采样+合成', () => {
  for (const L of layers) {
    if (L.lw <= 0 || L.lh <= 0 || L.lw * L.lh > COMPOSITE_MAX_PIXELS) continue;
    // 单趟"重采样 + 合成": 取代原先的 resizeBilinear(整层中间缓冲) → blitLayer(再拷一遍)。
    // 旧的每层要 ① 分配一份整层尺寸 RGBA 缓冲 ② 写满它 ③ 再读一遍做 alpha 合成;
    // 新路径把重采样结果直接就地合成, 且只遍历与画布相交的区域。逐位等价见函数注释。
    blitLayerScaled(
      canvas, cw, ch, L.img.rgba, L.img.width, L.img.height, L.lw, L.lh,
      Math.round(L.cx - L.lw / 2) + offX,
      Math.round(L.cy - L.lh / 2) + offY,
      L.alpha,
    );
  }
  });

  // Same quality gate as the single-texture path: never emit a gray/flat frame.
  let q = null;
  profTime('合成:质量门', () => { q = frameQuality(cw, ch, canvas); });
  if (!isAcceptableFrame(q)) return compositeBail('quality-gate', JSON.stringify(q));
  // 成功路径也记录诊断 (reason='ok'), 便于统计 puppet 图集层占比
  if (process.env.DSH_WE_DIAG_COMPOSITE === '1') {
    _compositeDiag = { reason: 'ok', detail: layers.length + ' 层, 其中 puppet 图集层 ' + puppetLayers };
  }
  return {
    mime: 'image/png',
    bytes: profTime('合成:PNG编码', () => encodePng(cw, ch, canvas)),
    width: cw,
    height: ch,
    texturePath: 'composite(' + layers.length + ' layers)',
  };
}

function extractSceneMainImageVia(access, label, sceneFile, variant) {
  variant = variant | 0;
  _compositeDiag = null; // 每次调用重置, 避免读到上一次的陈旧原因
  // 场景主文件名不是常量: 官方 defaultprojects 的 audiophile / fantasticcar /
  // ricepod / techno 主文件是 <名字>.json (project.json.file 声明)。旧实现硬编码
  // scene.json ⇒ 这 4 个官方场景的主纹理提取一律 "scene.json not found or invalid"。
  // 显式入参优先 → 项目声明的 file → scene.json → 目录内唯一的 *.json。
  let scene = null;
  const tries = [];
  if (sceneFile) tries.push(sceneFile);
  const proj = access.readJson('project.json');
  if (proj && typeof proj.file === 'string' && proj.file.toLowerCase().endsWith('.json')) tries.push(proj.file);
  tries.push('scene.json');
  for (const f of tries) {
    scene = access.readJson(f);
    if (scene && Array.isArray(scene.objects)) break;
    scene = null;
  }
  if (!scene || !Array.isArray(scene.objects)) {
    throw new Error(label + ': ' + (tries[0] || 'scene.json') + ' not found or invalid');
  }
  // 三维模型场景**不做**主纹理提取 —— 这条路径只会从一堆材质贴图里挑"最像画"的一张,
  // 结果是把某个网格的材质贴图当成整帧 (实测 techno 256×256、fantasticcar 1024×1024
  // 的单张材质), 用户看到的就是"只显示某个材质而非真正渲染"。
  // 历史上 scene-manifest.js 里还并存过一份同名实现，那份早就有这条拒绝
  // (`3D scene cannot be extracted as 2D frame`)，而生产用的这一份漏了 ⇒ 完整渲染一旦
  // 失败, 回退链就给出这种无意义产物; 拒绝之后回退链继续走到官方 preview (作者的真实
  // 渲染图), 至少是可信画面。
  // ⚠️ 那份重复实现已于 2026-09 删除（无调用方、且曾让"改错地方"事故发生过一次：
  // 两处同名函数行为漂移，改了一处另一处照旧）。**本文件是唯一实现**，改动只改这里。
  if (scene.objects.some((o) => o && typeof o === 'object' && typeof o.model === 'string' && o.model.length > 0)) {
    throw new Error(label + ': 3D scene cannot be extracted as 2D frame');
  }
  // 档 0（默认）才走多层合成；档 1/2 是「出图来源」的备选生成逻辑：
  // 1=主纹理单张（跳过合成），2=作者原画（优先包内嵌入 JPEG/PNG 整图）。
  if (!variant) {
    // Multi-layer 2D scenes first: composite every visible image object with
    // its scene transform. The single-texture path below would otherwise pick
    // ONE layer and the client's cover fit would show only the middle slice.
    try {
      const composite = tryCompositeSceneLayers(scene, access, label);
      if (composite) return composite;
    } catch { /* fall through to the single-texture path */ }
  }
  let candidates = [];
  const imageObject = scene.objects.find(
    (o) => !!o && typeof o === 'object' && typeof o.image === 'string'
  );
  if (imageObject) candidates.push(...collectImageObjectTextures(imageObject, access.readJson));

  // Puppet 贴图分流：只有「部件图集」（连通性 < PUPPET_ATLAS_MAX）从单图层
  // 候选中排除（静态展示=五官四散）；眼贴/肢体件/完整立绘保留。
  const puppetTex = new Set();
  for (const o of scene.objects) {
    if (!o || typeof o.image !== 'string' || o.image.toLowerCase().endsWith('.tex')) continue;
    try {
      const im = access.readJson(o.image);
      if (im && typeof im.puppet === 'string' && im.puppet) {
        for (const t of collectImageObjectTextures(o, access.readJson)) {
          const p = resolveSceneTexPath(access, t) || t;
          puppetTex.add(String(p).toLowerCase());
        }
      }
    } catch { /* ignore */ }
  }
  const puppetSkip = new Set();
  for (const p of puppetTex) {
    try {
      const file = access.readFile(p);
      if (!file) { puppetSkip.add(p); continue; }
      const d = decodeTexToRgba(file.bytes);
      if (!d || puppetAtlasRatio(d.rgba, d.width, d.height) < PUPPET_ATLAS_MAX) puppetSkip.add(p);
    } catch { puppetSkip.add(p); }
  }

  // Rank the rest of the package's textures by art-likelihood score.
  const ranked = [];
  for (const path of access.listTexPaths()) {
    if (puppetSkip.has(path.toLowerCase())) continue;
    let score = 0;
    try {
      const file = access.readFile(path);
      const info = file ? parseTex(file.bytes) : null;
      if (info && !info.isVideoMp4) {
        const area = info.width * info.height;
        const embedded = info.embedded === 'jpeg' || info.embedded === 'png' ? 1 : FORMAT_PENALTY[info.format] ?? 0.05;
        const pathPenalty = PATH_PENALTY_RE.test(path) ? 0.02 : 1;
        score = area * embedded * pathPenalty;
      }
    } catch {
      score = 0;
    }
    ranked.push({ path, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  for (const { path } of ranked) {
    if (puppetSkip.has(path.toLowerCase())) continue;
    if (!candidates.some((c) => c.toLowerCase() === path.toLowerCase())) candidates.push(path);
  }
  // 首个 image 对象自身的引用若属图集型 puppet 贴图也要剔除
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (puppetSkip.has(String(candidates[i]).toLowerCase())) candidates.splice(i, 1);
  }
  if (variant === 2) {
    // 作者原画档：包内嵌入的 JPEG/PNG 整图（作者导出的原画/差分）按面积
    // 降序置顶；无嵌入时自然回退普通排序（如绯雪默认隐藏的微信图片差分）。
    const embedded = [];
    for (const path of access.listTexPaths()) {
      if (puppetSkip.has(path.toLowerCase())) continue;
      try {
        const file = access.readFile(path);
        const info = file ? parseTex(file.bytes) : null;
        if (info && (info.embedded === 'jpeg' || info.embedded === 'png')) {
          embedded.push({ path, area: (info.width || 0) * (info.height || 0) });
        }
      } catch { /* ignore */ }
    }
    embedded.sort((a, b) => b.area - a.area);
    const front = embedded.map((e) => e.path);
    const frontSet = new Set(front.map((f) => String(f).toLowerCase()));
    candidates = [...front, ...candidates.filter((c) => !frontSet.has(String(c).toLowerCase()))];
  }
  if (candidates.length === 0) throw new Error(label + ': no texture candidates found');

  let lastError = null;
  for (const path of candidates) {
    const file = access.readFile(path);
    if (!file) {
      lastError = new Error(label + ": texture '" + path + "' not found in " + (label === 'pkg' ? 'package' : 'directory'));
      continue;
    }
    try {
      const decoded = decodeTex(file.bytes);
      if (decoded.kind === 'jpeg') {
        // Embedded JPEG payloads are photographic art by construction — WE
        // never stores masks/helpers as JPEG. Pass through untouched.
        return {
          mime: 'image/jpeg',
          bytes: decoded.bytes,
          width: decoded.width,
          height: decoded.height,
          texturePath: file.path,
        };
      }
      if (decoded.kind === 'png-pass') {
        // Embedded PNGs are usually art, but some scenes store grayscale
        // variants (b/w edits, gray backgrounds) — quality-gate when cheap.
        const q = pngQuality(decoded.bytes);
        if (q && !isAcceptableFrame(q)) {
          lastError = new Error(
            label + ': frame rejected (' + file.path + '): gray=' + Math.round(q.grayRatio * 100) + '% var=' + q.meanVar.toFixed(1)
          );
          continue;
        }
        // 内嵌 PNG 通常是作者导出的整图（无 padding）；但图集型 PNG 同样会
        // 出现黑边 —— 只在**裁掉的面积够多**（>5%）时重编码，否则原样透传
        // （PNG 重编码无损，但没必要动作者的原始字节）。
        const embedCrop = cropFrameForOutput(decoded.rgba, decoded.width, decoded.height);
        if (embedCrop
          && embedCrop.width * embedCrop.height < decoded.width * decoded.height * 0.95) {
          return {
            mime: 'image/png',
            bytes: encodePng(embedCrop.width, embedCrop.height, embedCrop.rgba),
            width: embedCrop.width,
            height: embedCrop.height,
            texturePath: file.path + ' [cropped ' + embedCrop.note + ']',
          };
        }
        return {
          mime: 'image/png',
          bytes: decoded.bytes,
          width: decoded.width,
          height: decoded.height,
          texturePath: file.path,
        };
      }
      // 质量门禁必须按**原图**判：它决定候选纹理的取舍，换了输入就会换掉选中的
      // 纹理（实测把门禁挪到裁切之后，一张 256² 的法线贴图通过了门禁并被当成
      // 静态帧）。裁黑边只作用于**输出**，不参与选择。
      const q = frameQuality(decoded.width, decoded.height, decoded.rgba);
      if (!isAcceptableFrame(q)) {
        lastError = new Error(
          label + ': frame rejected (' + file.path + '): gray=' + Math.round(q.grayRatio * 100) + '% var=' + q.meanVar.toFixed(1)
        );
        continue;
      }
      const crop = cropFrameForOutput(decoded.rgba, decoded.width, decoded.height);
      const fw = crop ? crop.width : decoded.width;
      const fh = crop ? crop.height : decoded.height;
      return {
        mime: 'image/png',
        bytes: encodePng(fw, fh, crop ? crop.rgba : decoded.rgba),
        width: fw,
        height: fh,
        texturePath: file.path + (crop ? ' [cropped ' + crop.note + ']' : ''),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(label + ': no decodable texture found');
}

/**
 * 整数倍盒式降采样 (仅用于"回退主纹理"的巨图限幅)。
 *
 * 背景 (上游 issue #86): 场景渲染失败时回退到主纹理, 工坊壁纸的主纹理可达
 * **8192×4680 (3830 万像素 / 解码后 146MB RGBA)**。它作为整窗背景会被合成器
 * 反复采样, 是实打实的显存/内存与启动卡顿来源, 而它只是"渲染失败时的兜底",
 * 并不需要原始分辨率。按整数倍盒式平均降到 ≤ maxWidth, 保持长宽比与视觉质量。
 */
function downsampleRgba(rgba, width, height, maxWidth) {
  const factor = Math.max(2, Math.ceil(width / maxWidth));
  const nw = Math.max(1, Math.floor(width / factor));
  const nh = Math.max(1, Math.floor(height / factor));
  const out = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy0 = y * factor;
    for (let x = 0; x < nw; x++) {
      const sx0 = x * factor;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = sy0 + dy;
        if (sy >= height) break;
        const row = sy * width;
        for (let dx = 0; dx < factor; dx++) {
          const sx = sx0 + dx;
          if (sx >= width) break;
          const si = (row + sx) * 4;
          r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; a += rgba[si + 3]; n++;
        }
      }
      const di = (y * nw + x) * 4;
      out[di] = Math.round(r / n); out[di + 1] = Math.round(g / n);
      out[di + 2] = Math.round(b / n); out[di + 3] = Math.round(a / n);
    }
  }
  return { rgba: out, width: nw, height: nh };
}

/** 回退帧限幅: 超过 maxWidth 时解码→盒式降采样→重编码 PNG (原地返回原帧否则)。 */
function capFallbackFrame(frame, maxWidth) {
  if (!frame || !(frame.width > maxWidth) || !(frame.height > 0)) return frame;
  let rgba = null;
  try {
    if (frame.mime === 'image/png') {
      // 解码上限放宽到本帧实际像素数: 质量门 (12M) 对巨图直接拒收, 而限幅
      // 恰恰只需要处理巨图 (8192×4680 = 3830 万像素)。
      const d = decodePngPayload(frame.bytes, Math.max(PNG_GATE_MAX_PIXELS, frame.width * frame.height));
      if (d && d.rgba && d.width === frame.width) rgba = d.rgba;
    } else if (frame.mime === 'image/jpeg') {
      const d = decodeJpeg(Buffer.from(frame.bytes), { useTArray: true });
      if (d && d.data) rgba = d.data;
    }
  } catch { return frame; /* 解码不了就保持原样, 限幅不是关键路径 */ }
  if (!rgba) return frame;
  const capped = downsampleRgba(rgba, frame.width, frame.height, maxWidth);
  return {
    mime: 'image/png',
    bytes: encodePng(capped.width, capped.height, capped.rgba),
    width: capped.width,
    height: capped.height,
    texturePath: frame.texturePath,
    downscaledFrom: frame.width + 'x' + frame.height,
  };
}

/** 回退主纹理的宽度上限 (上游 #86 实测回退产物 8192×4680; 3840 与场景渲染同档)。 */
const FALLBACK_MAX_WIDTH = 3840;

/**
 * 场景是否含 puppet 对象 —— maintexture (主纹理近似) 模式的安全性判据。
 *
 * puppet 的材质贴图是**图集** (UV 蒙皮的部件网格图)。任何"把贴图当普通图层 / 当单图"
 * 的近似路径都会把整张图集贴出去, 画面出现部件网格。实测本地库 **7/7** 个走
 * composite 的场景都含 puppet 图集层 (见 docs/SCENE-FRAME-PERF.md §二十一)。
 * 因此 maintexture 模式遇到这类场景必须回退真实渲染, 而不是硬凑一张近似图。
 *
 * 提前返回: 找到第一个就停 (大型场景 148 个对象不必扫完)。
 */
function sceneHasPuppet(scene, access) {
  if (!scene || !Array.isArray(scene.objects)) return false;
  for (const o of scene.objects) {
    if (!o || typeof o.image !== 'string') continue;
    if (o.image.toLowerCase().endsWith('.tex')) continue;
    try { const m = access.readJson(o.image); if (m && m.puppet) return true; } catch { /* 读不到就跳过 */ }
  }
  return false;
}

/** Extract the main static frame of a packed scene.pkg (Uint8Array/Buffer).
 *  sceneFile: 项目声明的主文件名（官方项目未必叫 scene.json）。
 *  variant: 0=默认（合成优先）; 1=主纹理单张; 2=作者原画优先;（3=预览图由
 *  宿主 scene-frame 路由直接读 preview 文件，不进 pkg 提取）。 */
function extractSceneMainImage(pkgData, sceneFile, variant) {
  const access = pkgSceneAccess(pkgData);
  const frame = capFallbackFrame(extractSceneMainImageVia(access, 'pkg', sceneFile, variant | 0), FALLBACK_MAX_WIDTH);
  return frame ? { ...frame, hasPuppet: sceneHasPuppet(sceneFile ? access.readJson(sceneFile) || access.readJson('scene.json') : access.readJson('scene.json'), access) } : frame;
}

/**
 * Loose-scene variant: decode the main texture of a scene project directory
 * that ships its scene file and textures as plain files instead of a packed
 * scene.pkg. `sceneFile` is the project's declared main file name (defaults to
 * scene.json) — official projects may name it after the wallpaper.
 */
function extractSceneMainImageFromDir(dir, sceneFile, variant) {
  const access = dirSceneAccess(dir);
  const frame = capFallbackFrame(extractSceneMainImageVia(access, 'scene', sceneFile, variant | 0), FALLBACK_MAX_WIDTH);
  return frame ? { ...frame, hasPuppet: sceneHasPuppet(access.readJson(sceneFile || 'scene.json') || access.readJson('scene.json'), access) } : frame;
}

// blitLayerScaled 一并导出: 它是纯函数且是"逐位等价"的断言对象,
// 由 scripts/verify-composite-blit.mjs 用随机用例 + 边界用例长期守护。
// decodeTexToRgba 一并导出: 同样是纯函数 (bytes → {width,height,rgba}, 不吃 this)。
// decodePngPayload 一并导出: 供 scripts/verify-png-decode.mjs 断言它与渲染器那份
// decodePngBuffer 在同一 payload 上**逐像素一致** (RGB 通道步进 bug 的回归护栏)。
// decodeDxt1/3/5 + TexFormat 一并导出: 供 scripts/verify-atlas-frame-decode.mjs
// 用随机块流证明"区域解码 == 整图裁剪" (逐位)。
// decodeDxtRegion 一并导出: 动画图集按帧解码的核心 —— 见 §二十七/§二十八。
// 注: 原先未接线的 we-renderer/parallel.js + decode-worker.mjs (按**纹理**并行)
// 已删除: 实测只有 1.34x (§十七), 该轴被否定; 并行若要做必须切在**块行**。
export { extractSceneMainImage, extractSceneMainImageFromDir, parseTex, decodeTex, parsePkg, readPkgEntry, extractTexVideoMp4, blitLayerScaled, decodeTexToRgba, decodePngPayload, decodeDxt5, decodeDxt1, decodeDxt3, decodeDxtRegion, texMip0Info, TexFormat };
// 诊断出口: 多层合成为何未被采用 (见 compositeBail)
export function compositeDiagInfo() { return _compositeDiag; }
/**
 * maintexture (主纹理近似) 模式是否可采用这张产物 —— **纯函数**, 便于护栏用合成帧
 * 直接断言行为 (而非只匹配源码正则)。返回 false ⇒ 调用方必须回退真实渲染, 绝不返回空。
 *
 * 不可采用的三类:
 *   · 无产物 —— 质量门拒收 / 无候选 / 提取抛错 (实测 3640755971 属此类);
 *   · `hasPuppet` —— 场景含 puppet, 材质贴图是**图集**, 近似路径会整张贴出
 *     (实测本地库 7/7 个 composite 场景如此);
 *   · **近乎纯色/纯黑** —— 见下面的压缩率判据。
 *
 * 压缩率判据 (纯数学, 零解码成本): PNG/JPEG 对纯色画面的压缩率极高, 故
 * **字节/像素**能廉价区分"真画面"与"黑屏"。本地库 16 个主纹理产物实测:
 *   `2934788040`(花（静态）, 实际是整屏黑) = **0.0063** B/px
 *   次小 `3660962877` = 0.1776 ; 最大 = 2.1037
 * ⇒ 阈值 0.05 命中 1 个, 距最近正常值有 **28 倍**余量 (不会误伤真画面)。
 *
 * 为什么不直接复用提取路径的质量门: 那条门存在**无门分支**
 * (JPEG 直通分支不做检查; 超大 PNG 的 pngQuality 返回 null 时被 `q &&` 短路),
 * 而兜底路径刻意选择"验不了就接受"(有画面优于没画面)。主纹理模式是**主产物**,
 * 需要相反的保守策略 —— 所以这里给它**自己的**判据, 不依赖上游的隐含保证。
 */
export function isMainTextureUsable(frame) {
  if (!frame || !frame.bytes || !frame.width || !frame.height) return false;
  if (frame.hasPuppet) return false;
  const bytesPerPixel = frame.bytes.length / (frame.width * frame.height);
  if (bytesPerPixel < MIN_MAINTEXTURE_BYTES_PER_PIXEL) return false;
  return true;
}

/** 近乎纯色/黑屏的压缩率下限 (字节/像素)。依据见 isMainTextureUsable 注释。 */
const MIN_MAINTEXTURE_BYTES_PER_PIXEL = 0.05;
// 定位对照用: composite 侧的变换解析 (不含 attachment 骨架锚点) 与场景正交尺寸。
// 导出供 scripts/verify-composite-anchor.mjs 与渲染器的 resolveTransform 逐对象比对。
export { resolveObjectTransform, sceneProjectionSize };
