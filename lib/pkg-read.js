/**
 * PKG 容器读取原语（**唯一实现**，P3-17）。
 *
 * 契约：`parsePkg` 解析 PKGV 目录；`readPkgEntry` 按条目读出字节（LZ4 条目自动解压）；
 * `probeCompressedEntry` 在不真解压的前提下回答"这条目是不是压缩的、原始多大"（给探测路径省一次分配）；
 * `lz4DecompressBlock` 是块解压，**带 MAX_DECOMPRESSED_BYTES 上限** —— 上限只该长在实现里，
 * 所以两个消费者共用这一份（历史上 pkg-extract 侧没有上限，是重复实现导致的漂移）。
 *
 * 消费者：`lib/pkg-extract.js`（TEX/MP4 抽取）与 `lib/scene-manifest.js`（内嵌视频探测）。
 * 二者曾各自内联一份**近重复**实现，差异全是"谁更小心"（上限 / 命名常量 / 注释）——
 * 合并时取更严格的那份，见 `docs/wip/REFACTOR-ASSESSMENT.md` P3-17。
 */
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/**
 * Hard ceilings for allocations driven by wallpaper file content. Workshop
 * files are untrusted: a crafted pkg/tex/png must not be able to force
 * multi-GB host allocations (PR #717 follow-up hardening).
 */
const MAX_PKG_ENTRY_BYTES = 512 * 1024 * 1024;

/** PkgEntry.flags bit marking LZ4 block-chain storage. */
const PKG_ENTRY_FLAG_LZ4 = 1;

const textDecoder = new TextDecoder('utf-8');

/**
 * Bounds-checked little-endian binary reader. Every failed read throws an
 * Error prefixed with the reader label (e.g. 'pkg: unexpected end of data').
 */
class Reader {
    data;
    label;
    view;
    pos = 0;
    constructor(data, label) {
        this.data = data;
        this.label = label;
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
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
        const hi = this.u32();
        return hi * 0x100000000 + lo;
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
        while (end < limit && this.view.getUint8(end) !== 0)
            end++;
        if (end >= limit) {
            throw new Error(this.label + ': unterminated string');
        }
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
    if (dstSize < 0 || dstSize > MAX_DECOMPRESSED_BYTES) {
        throw new Error('lz4: decompressed size out of bounds (' + String(dstSize) + ')');
    }
    const dst = new Uint8Array(dstSize);
    let ip = 0;
    let op = 0;
    while (ip < src.length) {
        const token = src[ip++];
        // literal run
        let literalLength = token >> 4;
        if (literalLength === 15) {
            let s = 0;
            do {
                if (ip >= src.length)
                    throw new Error('lz4: truncated literal length');
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
        if (ip >= src.length)
            break; // last sequence: literals only, block ends
        // match copy
        if (ip + 2 > src.length)
            throw new Error('lz4: truncated match offset');
        const offset = src[ip] | (src[ip + 1] << 8);
        ip += 2;
        if (offset === 0 || offset > op)
            throw new Error('lz4: invalid match offset ' + offset);
        let matchLength = token & 0x0f;
        if (matchLength === 15) {
            let s = 0;
            do {
                if (ip >= src.length)
                    throw new Error('lz4: truncated match length');
                s = src[ip++];
                matchLength += s;
            } while (s === 255);
        }
        matchLength += 4;
        if (op + matchLength > dstSize)
            throw new Error('lz4: match run out of bounds');
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
    if (length < 8)
        return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const originalSize = view.getUint32(abs, true) + view.getUint32(abs + 4, true) * 0x100000000;
    // compression only ever wins space; larger "originals" are raw data
    if (originalSize <= length || originalSize > 0x7fffffff)
        return null;
    let pos = abs + 8;
    let total = 0;
    while (total < originalSize) {
        if (pos + 8 > abs + length)
            return null;
        const uncomp = view.getInt32(pos, true);
        const comp = view.getInt32(pos + 4, true);
        if (uncomp <= 0 || comp <= 0 || pos + 8 + comp > abs + length)
            return null;
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
    if (!/^PKGV\d{4}$/.test(magic)) {
        throw new Error("pkg: bad magic '" + magic + "'");
    }
    const count = r.i32();
    if (count < 0 || count > 0x100000) {
        throw new Error('pkg: invalid entry count ' + count);
    }
    const index = [];
    for (let i = 0; i < count; i++) {
        index.push({ path: r.sizedString(1024), offset: r.u32(), length: r.u32() });
    }
    const dataStart = r.pos;
    return index.map(({ path, offset, length }) => {
        const abs = dataStart + offset;
        if (abs + length > data.byteLength) {
            throw new Error("pkg: entry '" + path + "' out of bounds");
        }
        const originalSize = probeCompressedEntry(data, abs, length);
        return originalSize === null
            ? { path, offset: abs, compressedSize: length, size: length, flags: 0 }
            : { path, offset: abs, compressedSize: length, size: originalSize, flags: PKG_ENTRY_FLAG_LZ4 };
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
    if ((entry.flags & PKG_ENTRY_FLAG_LZ4) === 0) {
        return data.slice(abs, abs + entry.compressedSize);
    }
    if (entry.size > MAX_PKG_ENTRY_BYTES) {
        throw new Error("pkg: entry '" + entry.path + "' too large (" + entry.size + ' bytes)');
    }
    const r = new Reader(data.subarray(abs, abs + entry.compressedSize), 'pkg');
    const originalSize = r.u64();
    if (originalSize !== entry.size) {
        throw new Error("pkg: entry '" + entry.path + "' size mismatch");
    }
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
    if (r.remaining !== 0) {
        throw new Error("pkg: corrupt compressed entry '" + entry.path + "'");
    }
    return out;
}

export { MAX_DECOMPRESSED_BYTES, MAX_PKG_ENTRY_BYTES, PKG_ENTRY_FLAG_LZ4, textDecoder, Reader, lz4DecompressBlock, probeCompressedEntry, parsePkg, readPkgEntry };
