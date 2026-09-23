// WE 渲染引擎 — MDL 网格解析 (puppet 80B + 静态 MDLV0004/0014)
// 静态 MDL 结构: "MDLVxxxx" + 头部 + "materials/....json\0" + u32 标志 + u32 顶点字节数
//       + 顶点流 (stride 32: pos/normal/uv; stride 56: +tangent+uv2) + u32 索引字节数 + u16 索引
import { v3sub, v3cross, v3norm, v3dot } from './math.js';

// ── puppet MDL (80 字节 stride, 含骨骼蒙皮) ─────────────────────
// 骨骼/蒙皮语义**未改动**。块头布局与静态 MDL 相同
// (materials/<x>.json\0 + u32(stride<<16) + u32(vertBytes) + 顶点流 + u32(idxBytes) + u16 索引),
// 同样只是"只取第一个子网格块"。**实测不需要多块**: workshop 431960 全部 27 个
// puppet .mdl (MDLV0023) 逐块走均为 1 块 (scripts/tmp-mdlsplit7.mjs)。
// 若将来遇到真正的多块 puppet, 必须**同时**处理 blocks[1..N] 的 blendIndices/
// blendWeights 与每块绑定的骨骼子集, 不能照搬静态 MDL 的 submeshes 做法。
export function parseMdlPuppet(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let mdlsOffset = buf.length;
  for (let off = 9; off + 4 < buf.length; off++) {
    if (buf[off] === 0x4d && buf[off+1] === 0x44 && buf[off+2] === 0x4c && buf[off+3] === 0x53) { mdlsOffset = off; break; }
  }
  let found = null;
  for (let offset = 9; offset + 12 < mdlsOffset; offset++) {
    // 顶点 stride 由块头 u32 高 16 位给出 (0x0180→80B, 0x0181→84B); 与 puppet.js
    // _parseMdl 同一判据, 字段偏移从尾部推导 (uv@S-8)。
    const stride = (dv.getUint32(offset, true) >>> 16) === 0x0181 ? 84 : 80;
    const vertexBytes = dv.getUint32(offset + 4, true);
    const verticesOffset = offset + 8;
    if (vertexBytes === 0 || vertexBytes % stride !== 0) continue;
    const indexLenOffset = verticesOffset + vertexBytes;
    if (indexLenOffset + 4 > mdlsOffset) continue;
    const indexBytes = dv.getUint32(indexLenOffset, true);
    const indicesOffset = indexLenOffset + 4;
    if (indexBytes === 0 || indexBytes % 2 !== 0 || indicesOffset + indexBytes > mdlsOffset) continue;
    found = { verticesOffset, vertexBytes, indicesOffset, indexBytes, stride };
    break;
  }
  if (!found) return null;
  const vertexCount = found.vertexBytes / found.stride;
  const indexCount = found.indexBytes / 2;
  const uvOff = found.stride - 8;
  const positions = [], uvs = [];
  for (let i = 0; i < vertexCount; i++) {
    const vo = found.verticesOffset + i * found.stride;
    positions.push([dv.getFloat32(vo, true), dv.getFloat32(vo + 4, true), dv.getFloat32(vo + 8, true)]);
    uvs.push([dv.getFloat32(vo + uvOff, true), dv.getFloat32(vo + uvOff + 4, true)]);
  }
  const indices = [];
  for (let i = 0; i < indexCount; i++) indices.push(dv.getUint16(found.indicesOffset + i * 2, true));
  return { positions, uvs, indices, vertexCount, indexCount };
}

function _indexOfBytes(buf, str, from) {
  const needle = Buffer.from(str, 'ascii');
  for (let i = from; i + needle.length <= buf.length; i++) {
    let ok = true;
    for (let k = 0; k < needle.length; k++) if (buf[i + k] !== needle[k]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

// ── 静态 MDLV 块解析 (单块) ───────────────────────────────────
// 从 matStart 处的 "materials/<x>.json\0" 起解析**一个**子网格块:
//   materials/<x>.json\0 + u32 + u32(vertBytes) + 顶点流 + u32(idxBytes) + u16 索引流
// 每块**独立**判定 stride (同文件不同块可以是 32/48/56/20… 混合, 见 body.mdl / orbitaleffects.mdl)。
// 返回 { mesh, end } (end = 索引流末尾, 即下一块的 matStart), 失败返回 null。
//
// `relaxed` 仅用于**同文件第 2..N 块** (第 1 块永远走原判据 ⇒ 单块文件逐位不变)。
// 放宽的两点, 都由"块边界已被文件级自检钉死"背书:
//   1. 索引合法性扫描从 400 抽样/98% 改为**全量/100%** (抽样通过但真越界会毁几何);
//   2. 无法线回退不再要求 UV 落在 [0,1] —— 官方 ricepod/orbital_thunder 第 2 块
//      UV 是平铺坐标 u∈[-6.6,7.75] (真值, 不是脏数据), 旧判据会整块否决。
// 索引全量合法（vc > maxIdx）本身是很强的约束: 例如 orbital_thunder vertBytes=1100
// / maxIdx=54 只允许 stride ≤ 20, 而 20|1100 ⇒ 唯一解 20。
function _parseStaticBlockAt(buf, dv, matStart, relaxed = false) {
  let matEnd = matStart;
  while (matEnd < buf.length && buf[matEnd] !== 0) matEnd++;
  const materialPath = buf.toString('utf8', matStart, matEnd);
  const f0 = dv.getUint32(matEnd + 1, true);
  const vertBytes = dv.getUint32(matEnd + 5, true);
  const vertStart = matEnd + 9;
  if (vertBytes <= 0 || vertBytes > buf.length || vertStart + vertBytes > buf.length) return null;
  const cands = [];
  for (const stride of [64, 48, 32, 40, 44, 56]) {
    if (vertBytes % stride !== 0) continue;
    const vc = vertBytes / stride;
    if (vc < 3 || vc > 100000) continue;
    let normOk = 0, n = 0;
    for (let i = 0; i < Math.min(vc, 300); i++) {
      const o = vertStart + i * stride;
      const nx = dv.getFloat32(o + 12, true), ny = dv.getFloat32(o + 16, true), nz = dv.getFloat32(o + 20, true);
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (Math.abs(l - 1) < 0.1) normOk++;
      n++;
    }
    if (normOk < n * 0.6) continue;
    const idxBytesPos = vertStart + vertBytes;
    const idxBytesT = dv.getUint32(idxBytesPos, true);
    const idxStartT = idxBytesPos + 4;
    let idxAllOk = false;
    if (idxBytesT > 0 && idxBytesT % 2 === 0 && idxStartT + idxBytesT <= buf.length + 1) {
      const ic = idxBytesT / 2;
      if (ic > 0 && ic % 3 === 0 && ic < 300000) {
        // relaxed: 全量扫描, 要求 100% 索引 < vc (vc > maxIdx)
        const lim = relaxed ? ic : Math.min(ic, 400);
        let ok = 0;
        for (let k = 0; k < lim; k++) {
          if (dv.getUint16(idxStartT + k * 2, true) < vc) ok++;
        }
        idxAllOk = relaxed ? ok === lim : ok > lim * 0.98;
      }
    }
    let align = 0, an = 0;
    if (idxAllOk) {
      for (let k = 0; k + 2 < Math.min(idxBytesT / 2, 3000); k += 3) {
        const a = dv.getUint16(idxStartT + k * 2, true), b = dv.getUint16(idxStartT + k * 2 + 2, true), c = dv.getUint16(idxStartT + k * 2 + 4, true);
        if (a >= vc || b >= vc || c >= vc) continue;
        const pa = [dv.getFloat32(vertStart + a * stride, true), dv.getFloat32(vertStart + a * stride + 4, true), dv.getFloat32(vertStart + a * stride + 8, true)];
        const pb = [dv.getFloat32(vertStart + b * stride, true), dv.getFloat32(vertStart + b * stride + 4, true), dv.getFloat32(vertStart + b * stride + 8, true)];
        const pc = [dv.getFloat32(vertStart + c * stride, true), dv.getFloat32(vertStart + c * stride + 4, true), dv.getFloat32(vertStart + c * stride + 8, true)];
        const e1 = v3sub(pb, pa), e2 = v3sub(pc, pa);
        const fn = v3norm(v3cross(e1, e2));
        const vn = [dv.getFloat32(vertStart + a * stride + 12, true), dv.getFloat32(vertStart + a * stride + 16, true), dv.getFloat32(vertStart + a * stride + 20, true)];
        const vl = Math.sqrt(v3dot(vn, vn)) || 1;
        align += Math.abs(v3dot(fn, [vn[0] / vl, vn[1] / vl, vn[2] / vl]));
        an++;
      }
      if (an > 0) align /= an;
    }
    cands.push({ stride, vc, idxAllOk, align });
  }
  cands.sort((a, b) => (b.idxAllOk - a.idxAllOk) || (b.align - a.align));
  let chosen = cands[0];
  if (!chosen) {
    const idxBytesPos = vertStart + vertBytes;
    const idxBytesT = dv.getUint32(idxBytesPos, true);
    const idxStartT = idxBytesPos + 4;
    let ic = 0;
    if (idxBytesT > 0 && idxBytesT % 2 === 0 && idxStartT + idxBytesT <= buf.length + 1) ic = idxBytesT / 2;
    for (const stride of [20, 16, 24, 28, 36, 40, 44, 48, 56]) {
      if (vertBytes % stride !== 0) continue;
      const vc = vertBytes / stride;
      if (vc < 3 || vc > 100000) continue;
      if (ic === 0 || ic % 3 !== 0) continue;
      const lim = relaxed ? ic : Math.min(ic, 400);
      let idxOk = 0;
      for (let k = 0; k < lim; k++) if (dv.getUint16(idxStartT + k * 2, true) < vc) idxOk++;
      if (relaxed ? idxOk !== lim : idxOk < lim * 0.98) continue;
      const uvOff = stride - 8;
      let uvOk = 0, uvN = 0;
      let minX = 1e9, maxX = -1e9;
      for (let i = 0; i < Math.min(vc, 300); i++) {
        const o = vertStart + i * stride;
        const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true);
        if (!isFinite(x) || !isFinite(y) || !isFinite(z) || Math.abs(x) > 10000 || Math.abs(y) > 10000) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        const u = dv.getFloat32(o + uvOff, true), v = dv.getFloat32(o + uvOff + 4, true);
        if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) uvOk++;
        uvN++;
      }
      // relaxed: UV 允许越界 (平铺/滚动 UV 是合法数据), 由"索引全量合法"单独把关
      if (relaxed ? uvN > 0 : (uvN > 0 && uvOk > uvN * 0.6)) { chosen = { stride, vc, hasNormals: false }; break; }
    }
  }
  if (!chosen) return null;
  const { stride, vc, hasNormals } = chosen;
  const positions = [], normals = [], uvs = [], uv2s = [];
  const hasN = hasNormals !== false;
  // UV 布局 (引擎 vertex): 主纹理 UV1 在 stride 末尾 (stride-8);
  // 第 2 UV (lightmap) 仅 stride 56 有 (uv2@stride-16)
  const uvOff = stride === 64 ? 36 : stride - 8;
  let uv2Off = -1;
  if (stride === 56) {
    const p = stride - 16;
    let ok = 0, n = 0;
    for (let i = 0; i < Math.min(vc, 150); i++) {
      const o = vertStart + i * stride;
      const u = dv.getFloat32(o + p, true), v = dv.getFloat32(o + p + 4, true);
      if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) ok++;
      n++;
    }
    if (ok / n > 0.7) uv2Off = p;
  }
  for (let i = 0; i < vc; i++) {
    const o = vertStart + i * stride;
    positions.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]);
    normals.push(hasN ? [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)] : null);
    uvs.push([dv.getFloat32(o + uvOff, true), dv.getFloat32(o + uvOff + 4, true)]);
    uv2s.push(uv2Off >= 0 ? [dv.getFloat32(o + uv2Off, true), dv.getFloat32(o + uv2Off + 4, true)] : null);
  }
  const idxBytesPos = vertStart + vertBytes;
  const idxBytes = dv.getUint32(idxBytesPos, true);
  const idxStart = idxBytesPos + 4;
  if (idxBytes <= 0 || idxBytes % 2 !== 0 || idxStart + idxBytes > buf.length + 1) return null;
  const indices = [];
  for (let i = 0; i < idxBytes / 2; i++) indices.push(dv.getUint16(idxStart + i * 2, true));
  return {
    mesh: { positions, normals, uvs, uv2s, indices, materialPath, stride, vertexCount: vc, indexCount: indices.length },
    end: idxStart + idxBytes,
  };
}

// ── 静态 MDLV 解析 (多 UV 通道 + 法线对齐评分选 stride) ─────────
// 返回结构与旧版**完全兼容** (positions/normals/uvs/uv2s/indices/materialPath/
// stride/vertexCount/indexCount 仍指**第一个**子网格), 多子网格经 `submeshes`
// 增补暴露: submeshes[0] 与顶层字段同源, 长度 ≥1 (单块文件只有 1 项)。
//
// 多子网格: 一个 .mdl 里每个子网格各有一份材质 + 顶点流 + 索引流, 块链为
//   materials/<x>.json\0 + u32 + u32(vertBytes) + 顶点流 + u32(idxBytes) + 索引流
// 逐块首尾相接。**只修第一个子网格 ⇒ 官方 arsenal/pistols.mdl 6 块里 5 块
// (84.8% 顶点) 从不渲染**, 画面只剩一把刀 (实测非清屏 1.68% vs 应 45.5% 几何覆盖)。
//
// 版本门控 (无证据不推广): 仅 **MDLV0014** 走多块; MDLV0004 / MDLV0017 /
// MDLV0023 的块排布不同 (实测 MDLV0004 索引流尾=filesize 而非 filesize-1,
// MDLV0023 orbitsmall 头字段声称 4 块但块链自检失败) ⇒ 保持旧单块行为。
// 三重自检, 任一不过即回退到单块 (等价于改动前的行为):
//   1. 每块独立解析成功 (stride/索引越界/UV 判定全过);
//   2. 块链末尾 == 文件末尾 (filesize-1 或 filesize);
//   3. 块数 == 头部 u32@16 >>> 8 (对本地全部 15 个 MDLV0014 样本成立)。
export function parseMdlStatic(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'MDLV') return null;
  const matStart = _indexOfBytes(buf, 'materials/', 8);
  if (matStart < 0) return null;
  const first = _parseStaticBlockAt(buf, dv, matStart);
  if (!first) return null;
  const single = { ...first.mesh, submeshes: [first.mesh] };
  // 版本门控: 只有 MDLV0014 取证过多块块链
  if (buf.toString('ascii', 0, 8) !== 'MDLV0014') return single;
  const rest = [];
  let end = first.end;
  let chainOk = true;
  while (rest.length < 63) {
    const ms = _indexOfBytes(buf, 'materials/', end);
    if (ms < 0) break;                       // 没有下一块了
    const blk = _parseStaticBlockAt(buf, dv, ms, true);  // 第 2..N 块: 放宽判据
    if (!blk) { chainOk = false; break; }     // 块自检失败 → 整个多块结论作废
    rest.push(blk.mesh);
    end = blk.end;
  }
  if (!rest.length) return single;            // 单块文件: 与旧实现逐位等价
  const eofOk = end === buf.length - 1 || end === buf.length;
  const countOk = (dv.getUint32(16, true) >>> 8) === rest.length + 1;
  if (!chainOk || !eofOk || !countOk) return single;
  return { ...first.mesh, submeshes: [first.mesh, ...rest] };
}
