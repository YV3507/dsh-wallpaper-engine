/**
 * Wallpaper Engine scene.pkg / .tex resource extraction.
 *
 * 职责：**从场景包里探测作者内嵌的 MP4**（`extractSceneVideo` /
 * `extractSceneVideoFromDir`），供 `/scene-video` 用作出图来源链的第二顺位。
 * 本文件只做这件事；下面这些**格式事实**是它的依据，容器原语由 `./pkg-read.js` 提供：
 *
 * Format facts were cross-checked against the two reference implementations:
 * RePKG (github.com/notscuffed/repkg, PackageReader / TexReader and friends)
 * and linux-wallpaperengine (github.com/Almamu/linux-wallpaperengine,
 * PackageParser / TextureParser):
 *
 * - PKG header: int32-length-prefixed magic string, int32 entry count, then
 *   per entry a length-prefixed path plus uint32 offset/length. Offsets are
 *   relative to the end of the index. Entry data is stored raw in practice;
 *   some packers emit LZ4-chained entries instead (int64 original size, then
 *   repeated [int32 decompressed size][int32 compressed size][LZ4 block]).
 *   parsePkg probes for a perfectly-fitting block chain and flags such
 *   entries; readPkgEntry decompresses them ("compressedSize != size" means
 *   LZ4), single-block chains included.
 * - TEX magics are NUL-terminated 8-character strings (9 bytes on disk).
 *   TEXB0002+ mipmaps carry an isLZ4Compressed flag and a decompressed byte
 *   count; the LZ4 payload is one whole block per mipmap. TEXB0004 with an
 *   unknown FreeImage format plus the video flag marks an embedded MP4, which
 *   is exposed via TexInfo 的 `isVideoMp4`（本模块只做探测，不解码像素）。GIF flags
 *   (bit 2) pull in a TEXS frame container exposed via TexInfo.frames.
 *
 * LZ4 block decoding follows the official lz4 block format specification;
 * BC1/BC2/BC3 follow the standard public algorithms. **本仓不再解码 TEX 像素**：
 * 需要 RGBA 的那条线（静态帧提取 / 合成）已整体退役，容器原语唯一实现在
 * `lib/pkg-read.js`（`package.json` 的 `dependencies` 为空，也没有任何 vendored 副本可走）。
 *
 * @module @linxin666/dsh-client-ui-skin-center/scene-manifest
 */
import { Buffer } from 'node:buffer';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join as joinPath, resolve as resolvePath, sep } from 'node:path';
import { textDecoder, parsePkg, readPkgEntry } from './pkg-read.js';
/** SceneAccess over a packed scene.pkg container (case-insensitive paths). */
function pkgSceneAccess(pkgData) {
    const entries = parsePkg(pkgData);
    const byPath = new Map(entries.map((entry) => [entry.path.toLowerCase(), entry]));
    const readFile = (path) => {
        const entry = byPath.get(path.toLowerCase());
        if (!entry)
            return null;
        return { path: entry.path, bytes: readPkgEntry(pkgData, entry) };
    };
    return {
        readJson: (path) => {
            const file = readFile(path);
            if (!file)
                return null;
            try {
                return JSON.parse(textDecoder.decode(file.bytes));
            }
            catch {
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
    const normDir = resolvePath(dir);
    const realDir = (() => { try {
        return realpathSync(normDir);
    }
    catch {
        return normDir;
    } })();
    const readFile = (path) => {
        const abs = resolvePath(normDir, path);
        if (abs !== normDir && !abs.startsWith(normDir + sep))
            return null;
        try {
            // Never follow symlinks: a project dir containing a link must not
            // leak arbitrary file bytes into the extraction pipeline.
            if (lstatSync(abs).isSymbolicLink())
                return null;
            if (!statSync(abs).isFile())
                return null;
            const real = realpathSync(abs);
            if (real !== realDir && !real.startsWith(realDir + sep))
                return null;
            return { path, bytes: new Uint8Array(readFileSync(real)) };
        }
        catch {
            return null;
        }
    };
    const listTexPaths = () => {
        const out = [];
        const walk = (sub, depth) => {
            if (depth > 4)
                return;
            let names = [];
            try {
                names = readdirSync(sub === '' ? normDir : joinPath(normDir, sub));
            }
            catch {
                return;
            }
            for (const name of names) {
                const rel = sub === '' ? name : sub + '/' + name;
                let isDir = false;
                let isFile = false;
                try {
                    const lst = lstatSync(joinPath(normDir, rel));
                    if (lst.isSymbolicLink())
                        continue;
                    isDir = lst.isDirectory();
                    isFile = lst.isFile();
                }
                catch {
                    continue;
                }
                if (isDir)
                    walk(rel, depth + 1);
                else if (isFile && name.toLowerCase().endsWith('.tex'))
                    out.push(rel);
            }
        };
        walk('', 0);
        return out;
    };
    return {
        readJson: (path) => {
            const file = readFile(path);
            if (!file)
                return null;
            try {
                return JSON.parse(textDecoder.decode(file.bytes));
            }
            catch {
                return null;
            }
        },
        readFile,
        listTexPaths,
    };
}
function isLikelyMaskOrHelper(path) {
    const lower = path.toLowerCase();
    return (lower.includes('/masks/') ||
        lower.includes('_mask') ||
        lower.includes('mask') ||
        lower.includes('flow') ||
        lower.includes('wave') ||
        lower.includes('noise') ||
        lower.includes('lut') ||
        lower.includes('distort') ||
        lower.includes('warp') ||
        lower.includes('vortex') ||
        lower.includes('glow') ||
        lower.includes('neon') ||
        lower.includes('strip') ||
        lower.includes('bulb') ||
        lower.includes('led') ||
        lower.includes('combined') ||
        lower.includes('isometric') ||
        lower.includes('razer') ||
        lower.includes('len') ||
        lower.includes('lens') ||
        lower.includes('flare') ||
        lower.includes('prism') ||
        lower.includes('diffract') ||
        lower.includes('black') ||
        lower.includes('overlay') ||
        lower === 'sun' ||
        lower.endsWith('/sun.tex') ||
        lower.endsWith('/sun.json') ||
        lower.endsWith('/sun') ||
        lower.includes('waterripple') ||
        lower.includes('waterflow') ||
        lower.includes('phase') ||
        lower.includes('normal') ||
        lower.includes('foliagesway') ||
        lower.includes('cursorripple') ||
        lower.includes('赞助') ||
        lower.includes('sponsor') ||
        lower.includes('donate') ||
        lower.includes('qrcode') ||
        lower.includes('qr_code') ||
        lower.includes('audio_bar') ||
        lower.includes('audiobar') ||
        lower.includes('simple_audio') ||
        lower.includes('提示框') ||
        lower.includes('tip') ||
        lower.includes('watermark') ||
        lower.includes('logo') ||
        lower.includes('particle') ||
        lower.includes('audio') ||
        lower.includes('lightmap') ||
        lower.includes('light_map') ||
        lower.includes('visso') ||
        lower.includes('font') ||
        lower.includes('text_'));
}
function getTextureScore(path) {
    const lower = path.toLowerCase();
    if (isLikelyMaskOrHelper(path))
        return -100;
    let score = 0;
    if (lower.includes('白天') || lower.includes('day') || lower.includes('main') || lower.includes('background') || lower.includes('wallpaper')) {
        score += 50;
    }
    if (lower.includes('清晨') || lower.includes('morning') || lower.includes('黄昏') || lower.includes('dusk')) {
        score += 20;
    }
    if (lower.includes('昼夜变化') || lower.includes('mddn') || lower.includes('transition')) {
        score -= 30;
    }
    return score;
}
/** Find and extract the primary MP4 video embedded inside a scene's .tex textures. */
function extractSceneVideoVia(access) {
    const candidates = [];
    for (const path of access.listTexPaths()) {
        const file = access.readFile(path);
        if (!file)
            continue;
        const raw = file.bytes;
        for (let i = 0; i < 200 && i + 8 <= raw.length; i++) {
            if (raw[i] === 0x66 && raw[i + 1] === 0x74 && raw[i + 2] === 0x79 && raw[i + 3] === 0x70) {
                const ftypOffset = i - 4;
                if (ftypOffset >= 0 && ftypOffset < raw.length) {
                    candidates.push({
                        path,
                        score: getTextureScore(path),
                        bytes: raw.slice(ftypOffset),
                    });
                    break;
                }
            }
        }
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].bytes;
}
export function extractSceneVideo(pkgData) {
    return extractSceneVideoVia(pkgSceneAccess(pkgData));
}
export function extractSceneVideoFromDir(dir) {
    return extractSceneVideoVia(dirSceneAccess(dir));
}
