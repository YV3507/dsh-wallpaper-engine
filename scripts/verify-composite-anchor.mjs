// 守卫 (待接入 verify): 量化 composite 定位漏掉的 attachment 骨架锚点。
//
// 为什么不用"两个函数相减": pkg-extract 的 resolveObjectTransform 与 core.js 的
// resolveTransform 是**两套独立实现**, 除锚点外还有别的差异 (根默认值 defOrigin、
// getVal 的 {value} 解包 vs parseSceneVec3 直读 …)。实测两函数相减时, 不带
// attachment 的 142 个对象差值反而更大 (中位 1057px) —— 说明系统性偏差盖过了锚点,
// 那种做法量不出锚点的影响。
//
// 改用**打桩法**: 把渲染器的 _attachmentOffset 临时替换为返回 [0,0] 再算一次
// resolveTransform, 两次之差**恰好**是锚点项的贡献。不带 attachment 的对象
// 天然为 0, 构成同场景内的完美对照。
//
// 用法: node scripts/verify-composite-anchor.mjs [sceneId] [宽] [高] [t]
import fs from 'node:fs';
import path from 'node:path';
import { SceneRenderer } from '../lib/scene-renderer.js';
import { sceneProjectionSize } from '../lib/pkg-extract.js';

const ROOT = process.env.DSH_WE_SCENE_ROOT || 'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const id = process.argv[2] || '3486806915';
const W = parseInt(process.argv[3] || '3840', 10);
const H = parseInt(process.argv[4] || '2160', 10);
const T = parseFloat(process.argv[5] || '2.5');

const src = path.join(ROOT, id, 'scene.pkg');
if (!fs.existsSync(src)) { console.log('找不到 ' + src); process.exit(2); }

const r = new SceneRenderer(src, { width: W, height: H, time: T, log: () => {} });
const projection = sceneProjectionSize(r.scene);
const ps = projection && projection.width ? [W / projection.width, H / (projection.height || 1080)] : [1, 1];

console.log(`场景 ${id}  ${W}x${H}  t=${T}s  ortho=${projection ? projection.width + 'x' + projection.height : '(无声明)'}`);
console.log(`画布换算 1 场景单位 = ${ps[0].toFixed(3)} x ${ps[1].toFixed(3)} px\n`);

// 打桩法: 同一对象算两次 resolveTransform, 第二次屏蔽锚点
const realOffset = r._attachmentOffset.bind(r);
function anchorDeltaPx(o) {
  let withA = null, withoutA = null;
  try { withA = r.resolveTransform(o); } catch { return null; }
  r._attachmentOffset = () => [0, 0];
  try { withoutA = r.resolveTransform(o); } catch { withoutA = null; }
  r._attachmentOffset = realOffset;
  if (!withA || !withoutA) return null;
  const dx = (withA.origin[0] - withoutA.origin[0]) * ps[0];
  const dy = (withA.origin[1] - withoutA.origin[1]) * ps[1];
  return { dx, dy, d: Math.hypot(dx, dy) };
}

const rows = [];
// 祖先里是否有带 attachment 的对象 —— resolveTransform 对链上**每一环**都叠加锚点项,
// 所以一个自身不带 attachment 的对象, 若链上有附着的祖先, 也会受影响。
function hasAttachedAncestor(o) {
  let cur = o, guard = 0;
  while (cur && cur.parent != null && guard < 32) {
    const p = (r.objects || []).find((x) => x.id === cur.parent);
    if (!p) break;
    if (p.attachment) return true;
    cur = p; guard++;
  }
  return false;
}

for (const o of r.objects || []) {
  if (!o || o.id == null) continue;
  const ad = anchorDeltaPx(o);
  if (!ad) continue;
  rows.push({
    id: o.id, name: String(o.name || '').slice(0, 14),
    attach: o.attachment ? String(o.attachment).slice(0, 12) : '',
    hasAttach: !!o.attachment, attachedAncestor: hasAttachedAncestor(o), ...ad,
  });
}

const att = rows.filter((x) => x.hasAttach);
const noAtt = rows.filter((x) => !x.hasAttach);
const stat = (arr) => {
  if (!arr.length) return null;
  const ds = arr.map((x) => x.d).sort((a, b) => a - b);
  return { n: arr.length, max: ds[ds.length - 1], med: ds[Math.floor(ds.length / 2)], mean: ds.reduce((s, v) => s + v, 0) / ds.length };
};

const sa = stat(att), sn = stat(noAtt);
console.log('── 锚点项贡献 (= composite 漏掉的那一段, px) ──');
console.log(`  带 attachment   n=${String(sa ? sa.n : 0).padStart(4)}` + (sa ? `  中位 ${sa.med.toFixed(1).padStart(7)}  均值 ${sa.mean.toFixed(1).padStart(7)}  最大 ${sa.max.toFixed(1).padStart(7)}` : ''));
console.log(`  不带 (对照组)    n=${String(sn ? sn.n : 0).padStart(4)}` + (sn ? `  中位 ${sn.med.toFixed(1).padStart(7)}  均值 ${sn.mean.toFixed(1).padStart(7)}  最大 ${sn.max.toFixed(1).padStart(7)}` : ''));

if (att.length) {
  console.log('\n  带 attachment 的对象明细:');
  for (const x of att.sort((p, q) => q.d - p.d)) {
    console.log(`    id=${String(x.id).padStart(5)} ${x.name.padEnd(15)} attach=${x.attach.padEnd(13)} Δ=(${x.dx.toFixed(1)}, ${x.dy.toFixed(1)})  |Δ|=${x.d.toFixed(1)}px`);
  }
}

console.log('\n── 判定 ──');
// 方法自洽性: 关键不是"对照组全为 0" —— resolveTransform 对链上每一环都叠加锚点,
// 所以自身不带 attachment 但**链上有附着祖先**的对象也会非零, 这是正确行为。
// 真正的自洽判据是: 对照组的**中位数为 0** (绝大多数对象完全不受影响)。
const ctrlNonZero = noAtt.filter((x) => x.d > 0.5);
const ctrlUnexplained = ctrlNonZero.filter((x) => !x.attachedAncestor);
console.log(`  对照组: 中位 ${sn ? sn.med.toFixed(1) : '-'}px, 非零 ${ctrlNonZero.length}/${noAtt.length} 个`);
console.log(`  非零且无附着祖先 (理论应为 0): ${ctrlUnexplained.length} 个`);
const selfConsistent = (!sn || sn.med === 0) && ctrlUnexplained.length <= 1;
console.log(`  方法自洽: ${selfConsistent ? '是' : '否 —— 存在无法用锚点解释的非零, 结果需存疑'}`);
if (selfConsistent && sa) {
  if (sa.max >= 50) console.log(`  ⇒ 带 attachment 最大错位 ${sa.max.toFixed(0)}px、中位 ${sa.med.toFixed(0)}px (≥50px): **角色部件明显错位, ① 必须修**`);
  else if (sa.max >= 20) console.log(`  ⇒ 最大错位 ${sa.max.toFixed(0)}px (20–50px): 边缘可见, 建议修`);
  else console.log(`  ⇒ 最大错位仅 ${sa.max.toFixed(1)}px (<20px): 视觉影响可忽略, ① 可不改`);
} else if (!sa) {
  console.log('  ⇒ 本场景没有带 attachment 的对象, 无法判定');
}
