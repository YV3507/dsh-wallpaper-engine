// 增强 scene-scripts.js: createScriptProperties + engine.canvasSize + Vec3 + 用户属性
// 支持 829 类定位脚本: value.x = scriptProperties.x * engine.canvasSize.x
// 以及 App Dock 等复杂脚本的基础 API
//
// 2026-09 修订 (sf-aw): Vec2/Vec3 改为**逐条移植官方 JS 类库**
// `E:\...\wallpaper_engine\assets\scripts\jsclasses\baseclasses.js` (引擎启动时由
// scenescript64 载入: decompiled/scenescript64.dll.c:5789692 指向该路径)。
// 旧实现只有 add/subtract/multiply/divide/normalize/length 等少量方法, 且构造器
// 不补 z:
//   · 缺 lengthSqr()  → 官方默认壁纸 dino_run 的主控脚本 update() 第一句
//     `marioOrigin.subtract(origin).lengthSqr()` 抛 TypeError, 整段 update 丢失;
//   · 缺 distanceSqr/min/max/clamp/abs/sign/mod/step/smoothStep/mix/dot/cross/
//     equals/isFinite/copy/toConfigString 等 → NSL 库/工坊脚本中途抛错;
//   · `new Vec3(v.x, v.y)` z=undefined → formatResult 写回 "x y NaN"。
// 官方构造器还带 string/Vec2/Vec3 三种入参语义 (baseclasses.js:238-262), 一并移植。
import { parseVec3 } from './we-renderer/math.js';

const _Epsilon = 0.00001;
const deg2rad = Math.PI / 180;
const rad2deg = 180 / Math.PI;

// WEColor API (引擎颜色工具; 官方 assets/scripts/jsmodules/wecolor.js)
export const WEColor = {
  hsv2rgb({ x: h, y: s, z: v }) {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return new Vec3(rgb[0], rgb[1], rgb[2]);
  },
  rgb2hsv({ x: r, y: g, z: b }) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d !== 0) {
      if (mx === r) h = ((g - b) + d * (g < b ? 6 : 0)) / (6 * d);
      else if (mx === g) h = ((b - r) + d * 2) / (6 * d);
      else h = ((r - g) + d * 4) / (6 * d);
    }
    const s = mx === 0 ? 0 : d / mx;
    return new Vec3(((h % 1) + 1) % 1, s, mx);
  },
  // 官方 wecolor.js: normalizeColor/expandColor (0-255 ↔ 0-1)
  normalizeColor: (color) => new Vec3(color.x / 255, color.y / 255, color.z / 255),
  expandColor: (color) => new Vec3(color.x * 255, color.y * 255, color.z * 255),
};

// WEMath 模块 (官方 assets/scripts/jsmodules/wemath.js: deg2rad/rad2deg/smoothStep/mix
// + 旧实现已提供的 clamp/lerp/三角函数等超集)
export const WEMath = {
  deg2rad,
  rad2deg,
  smoothStep(min, max, v) { const x = Math.max(0, Math.min(1, (v - min) / (max - min))); return x * x * (3 - 2 * x); },
  smoothstep(min, max, v) { const x = Math.max(0, Math.min(1, (v - min) / (max - min))); return x * x * (3 - 2 * x); },
  mix: (a, b, v) => a + (b - a) * v,
  lerp: (a, b, v) => a + (b - a) * v,
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  pow: Math.pow,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  PI: Math.PI,
};

// WEVector 模块 (官方 assets/scripts/jsmodules/wevector.js) — 旧实现的模块映射把
// 一切非 WEMath 的 `import * as X` 都指向 __WEColor ⇒ WEVector.angleVector2 缺失
// (工坊脚本 "new Vec3(WEVector.angleVector2(...))" 抛错)。
export const WEVector = {
  angleVector2(angle) {
    const a = angle * deg2rad;
    return new Vec2(Math.cos(a), Math.sin(a));
  },
  vectorAngle2(direction) { return Math.atan2(direction.y, direction.x) * rad2deg; },
};

// createScriptProperties() 链式构建器: .addSlider({...}).addCheckbox({...})...finish()
// 属性值: 优先 user 属性映射, 否则 name.value (脚本默认值)
export class ScriptPropertiesBuilder {
  constructor(userProps) {
    this.userProps = userProps || {};
    this.props = {};
  }
  _add(prop) {
    // prop: {name, label, value, min, max, user?, ...}
    let val = prop.value;
    if (prop.user) {
      const uv = this.userProps[prop.user];
      if (uv !== undefined && uv !== null) val = uv;
    }
    this.props[prop.name] = val;
    return this;
  }
  addSlider(p) { return this._add(p); }
  addCheckbox(p) { return this._add(p); }
  addColor(p) { return this._add(p); }
  addTextinput(p) { return this._add(p); }
  addText(p) { return this._add(p); }
  addCombo(p) { return this._add(p); }
  addDropdown(p) { return this._add(p); }
  finish() { return this.props; }
}

// Vec2 (官方 baseclasses.js:4-237 移植; 构造器兼容 string / Vec3 / Vec2 / number)
export class Vec2 {
  constructor(x, y) {
    if (typeof x === 'string') {
      const p = x.split(' ');
      this.x = parseFloat(p[0]);
      this.y = parseFloat(p[1]);
    } else if (x instanceof Vec3 || x instanceof Vec2) {
      this.x = x.x;
      this.y = x.y;
    } else if (typeof x !== 'undefined') {
      this.x = x;
      this.y = (typeof y === 'number') ? y : x;
    } else {
      this.x = 0;
      this.y = 0;
    }
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y); }
  lengthSqr() { return this.x * this.x + this.y * this.y; }
  distance(v) { const dx = this.x - v.x, dy = this.y - v.y; return Math.sqrt(dx * dx + dy * dy); }
  distanceSqr(v) { const dx = this.x - v.x, dy = this.y - v.y; return dx * dx + dy * dy; }
  normalize() { return this.divide(this.length()); }
  copy() { return new Vec2(this.x, this.y); }
  // clone 是 copy 的别名: 保留自本地早先的手写 Vec2 实现。合并 main 时发现该实现
  // 与此处的官方移植版重名 (git 检测不到的语义重复, 会让模块抛
  // "Identifier 'Vec2' has already been declared"), 已删除重复类, 仅保留其独有的
  // clone 别名以免丢 API。
  clone() { return this.copy(); }
  equals(f) { return (f instanceof Vec2) && Math.abs(this.x - f.x) < _Epsilon && Math.abs(this.y - f.y) < _Epsilon; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y); }
  negate() { return new Vec2(-this.x, -this.y); }
  add(f) { return typeof f === 'number' ? new Vec2(this.x + f, this.y + f) : new Vec2(this.x + f.x, this.y + f.y); }
  subtract(f) { return typeof f === 'number' ? new Vec2(this.x - f, this.y - f) : new Vec2(this.x - f.x, this.y - f.y); }
  multiply(f) { return typeof f === 'number' ? new Vec2(this.x * f, this.y * f) : new Vec2(this.x * f.x, this.y * f.y); }
  divide(f) { return typeof f === 'number' ? new Vec2(this.x / f, this.y / f) : new Vec2(this.x / f.x, this.y / f.y); }
  dot(f) { return this.x * f.x + this.y * f.y; }
  reflect(f) { return this.subtract(f.multiply(2 * this.dot(f))); }
  perpendicular() { return new Vec2(this.y, -this.x); }
  project(v) { const d = v.lengthSqr(); return d === 0 ? new Vec2(0, 0) : v.multiply(this.dot(v) / d); }
  angle() { return Math.atan2(this.y, this.x) * rad2deg; }
  angleBetween(v) { return Math.atan2(this.x * v.y - this.y * v.x, this.x * v.x + this.y * v.y) * rad2deg; }
  rotate(angle) { const r = angle * deg2rad; const c = Math.cos(r), s = Math.sin(r); return new Vec2(c * this.x - s * this.y, s * this.x + c * this.y); }
  mix(v, a) {
    return typeof a === 'number'
      ? new Vec2(this.x + (v.x - this.x) * a, this.y + (v.y - this.y) * a)
      : new Vec2(this.x + (v.x - this.x) * a.x, this.y + (v.y - this.y) * a.y);
  }
  min(v) { return typeof v === 'number' ? new Vec2(Math.min(this.x, v), Math.min(this.y, v)) : new Vec2(Math.min(this.x, v.x), Math.min(this.y, v.y)); }
  max(v) { return typeof v === 'number' ? new Vec2(Math.max(this.x, v), Math.max(this.y, v)) : new Vec2(Math.max(this.x, v.x), Math.max(this.y, v.y)); }
  clamp(min, max) {
    const minX = typeof min === 'number' ? min : min.x, minY = typeof min === 'number' ? min : min.y;
    const maxX = typeof max === 'number' ? max : max.x, maxY = typeof max === 'number' ? max : max.y;
    return new Vec2(Math.max(minX, Math.min(maxX, this.x)), Math.max(minY, Math.min(maxY, this.y)));
  }
  abs() { return new Vec2(Math.abs(this.x), Math.abs(this.y)); }
  sign() { return new Vec2(Math.sign(this.x), Math.sign(this.y)); }
  round() { return new Vec2(Math.round(this.x), Math.round(this.y)); }
  floor() { return new Vec2(Math.floor(this.x), Math.floor(this.y)); }
  ceil() { return new Vec2(Math.ceil(this.x), Math.ceil(this.y)); }
  fract() { return new Vec2(this.x - Math.floor(this.x), this.y - Math.floor(this.y)); }
  mod(v) {
    return typeof v === 'number'
      ? new Vec2(this.x - v * Math.floor(this.x / v), this.y - v * Math.floor(this.y / v))
      : new Vec2(this.x - v.x * Math.floor(this.x / v.x), this.y - v.y * Math.floor(this.y / v.y));
  }
  step(edge) {
    const ex = typeof edge === 'number' ? edge : edge.x, ey = typeof edge === 'number' ? edge : edge.y;
    return new Vec2(this.x < ex ? 0 : 1, this.y < ey ? 0 : 1);
  }
  smoothStep(min, max) {
    const e0x = typeof min === 'number' ? min : min.x, e0y = typeof min === 'number' ? min : min.y;
    const e1x = typeof max === 'number' ? max : max.x, e1y = typeof max === 'number' ? max : max.y;
    let tx = Math.max(0, Math.min(1, (this.x - e0x) / (e1x - e0x)));
    let ty = Math.max(0, Math.min(1, (this.y - e0y) / (e1y - e0y)));
    return new Vec2(tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty));
  }
  toString() { return this.x + ' ' + this.y; }
  toConfigString() { return this.toString(); }
}

// Vec3 (官方 baseclasses.js:238-549 移植)
// 构造兼容: new Vec3(otherVec3) 复制 (733 Lens Flare 等脚本 new Vec3(thisLayer.size));
// 旧实现把 Vec3 实例存进 this.x → 后续运算 NaN → origin 级联 NaN → 组件渲染异常
export class Vec3 {
  constructor(x, y, z) {
    if (typeof x === 'string') {
      const p = x.split(' ');
      this.x = parseFloat(p[0]);
      this.y = parseFloat(p[1]);
      this.z = parseFloat(p[2]);
    } else if (x instanceof Vec3) {
      this.x = x.x; this.y = x.y; this.z = x.z;
    } else if (x instanceof Vec2) {
      this.x = x.x; this.y = x.y; this.z = 0;
    } else if (typeof x !== 'undefined') {
      this.x = x;
      this.y = (typeof y === 'number') ? y : x;
      this.z = (typeof z === 'number') ? z : ((typeof y === 'number') ? 0 : x);
    } else {
      this.x = 0; this.y = 0; this.z = 0;
    }
  }
  static fromSpherical(r, theta, phi) {
    const t = theta * deg2rad, p = phi * deg2rad, st = Math.sin(t);
    return new Vec3(r * st * Math.cos(p), r * Math.cos(t), r * st * Math.sin(p));
  }
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  lengthSqr() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  distance(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  distanceSqr(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  normalize() { return this.divide(this.length()); }
  copy() { return new Vec3(this.x, this.y, this.z); }
  equals(f) { return (f instanceof Vec3) && Math.abs(this.x - f.x) < _Epsilon && Math.abs(this.y - f.y) < _Epsilon && Math.abs(this.z - f.z) < _Epsilon; }
  isFinite() { return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z); }
  negate() { return new Vec3(-this.x, -this.y, -this.z); }
  add(f) {
    if (typeof f === 'number') return new Vec3(this.x + f, this.y + f, this.z + f);
    if (f instanceof Vec2) return new Vec3(this.x + f.x, this.y + f.y, this.z);
    return new Vec3(this.x + f.x, this.y + f.y, this.z + f.z);
  }
  subtract(f) {
    if (typeof f === 'number') return new Vec3(this.x - f, this.y - f, this.z - f);
    if (f instanceof Vec2) return new Vec3(this.x - f.x, this.y - f.y, this.z);
    return new Vec3(this.x - f.x, this.y - f.y, this.z - f.z);
  }
  multiply(f) {
    if (typeof f === 'number') return new Vec3(this.x * f, this.y * f, this.z * f);
    if (f instanceof Vec2) return new Vec3(this.x * f.x, this.y * f.y, this.z);
    return new Vec3(this.x * f.x, this.y * f.y, this.z * f.z);
  }
  divide(f) {
    if (typeof f === 'number') return new Vec3(this.x / f, this.y / f, this.z / f);
    if (f instanceof Vec2) return new Vec3(this.x / f.x, this.y / f.y, this.z);
    return new Vec3(this.x / f.x, this.y / f.y, this.z / f.z);
  }
  cross(f) { return new Vec3(this.y * f.z - this.z * f.y, this.z * f.x - this.x * f.z, this.x * f.y - this.y * f.x); }
  dot(f) { return this.x * f.x + this.y * f.y + this.z * f.z; }
  reflect(f) { return this.subtract(f.multiply(2 * this.dot(f))); }
  refract(normal, eta) {
    const NdotI = normal.dot(this);
    const k = 1 - eta * eta * (1 - NdotI * NdotI);
    if (k < 0) return new Vec3(0, 0, 0);
    return this.multiply(eta).subtract(normal.multiply(eta * NdotI + Math.sqrt(k)));
  }
  project(v) { const d = v.lengthSqr(); return d === 0 ? new Vec3(0, 0, 0) : v.multiply(this.dot(v) / d); }
  angleBetween(v) {
    const denom = Math.sqrt(this.lengthSqr() * v.lengthSqr());
    if (denom === 0) return 0;
    return Math.acos(Math.max(-1, Math.min(1, this.dot(v) / denom))) * rad2deg;
  }
  toSpherical() {
    const r = this.length();
    if (r === 0) return new Vec3(0, 0, 0);
    return new Vec3(r, Math.acos(this.y / r) * rad2deg, Math.atan2(this.z, this.x) * rad2deg);
  }
  mix(v, a) {
    return typeof a === 'number'
      ? new Vec3(this.x + (v.x - this.x) * a, this.y + (v.y - this.y) * a, this.z + (v.z - this.z) * a)
      : new Vec3(this.x + (v.x - this.x) * a.x, this.y + (v.y - this.y) * a.y, this.z + (v.z - this.z) * a.z);
  }
  min(v) { return typeof v === 'number' ? new Vec3(Math.min(this.x, v), Math.min(this.y, v), Math.min(this.z, v)) : new Vec3(Math.min(this.x, v.x), Math.min(this.y, v.y), Math.min(this.z, v.z)); }
  max(v) { return typeof v === 'number' ? new Vec3(Math.max(this.x, v), Math.max(this.y, v), Math.max(this.z, v)) : new Vec3(Math.max(this.x, v.x), Math.max(this.y, v.y), Math.max(this.z, v.z)); }
  clamp(min, max) {
    const minX = typeof min === 'number' ? min : min.x, minY = typeof min === 'number' ? min : min.y, minZ = typeof min === 'number' ? min : min.z;
    const maxX = typeof max === 'number' ? max : max.x, maxY = typeof max === 'number' ? max : max.y, maxZ = typeof max === 'number' ? max : max.z;
    return new Vec3(Math.max(minX, Math.min(maxX, this.x)), Math.max(minY, Math.min(maxY, this.y)), Math.max(minZ, Math.min(maxZ, this.z)));
  }
  abs() { return new Vec3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)); }
  sign() { return new Vec3(Math.sign(this.x), Math.sign(this.y), Math.sign(this.z)); }
  round() { return new Vec3(Math.round(this.x), Math.round(this.y), Math.round(this.z)); }
  floor() { return new Vec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)); }
  ceil() { return new Vec3(Math.ceil(this.x), Math.ceil(this.y), Math.ceil(this.z)); }
  fract() { return new Vec3(this.x - Math.floor(this.x), this.y - Math.floor(this.y), this.z - Math.floor(this.z)); }
  mod(v) {
    return typeof v === 'number'
      ? new Vec3(this.x - v * Math.floor(this.x / v), this.y - v * Math.floor(this.y / v), this.z - v * Math.floor(this.z / v))
      : new Vec3(this.x - v.x * Math.floor(this.x / v.x), this.y - v.y * Math.floor(this.y / v.y), this.z - v.z * Math.floor(this.z / v.z));
  }
  step(edge) {
    const ex = typeof edge === 'number' ? edge : edge.x, ey = typeof edge === 'number' ? edge : edge.y, ez = typeof edge === 'number' ? edge : edge.z;
    return new Vec3(this.x < ex ? 0 : 1, this.y < ey ? 0 : 1, this.z < ez ? 0 : 1);
  }
  smoothStep(min, max) {
    const e0x = typeof min === 'number' ? min : min.x, e0y = typeof min === 'number' ? min : min.y, e0z = typeof min === 'number' ? min : min.z;
    const e1x = typeof max === 'number' ? max : max.x, e1y = typeof max === 'number' ? max : max.y, e1z = typeof max === 'number' ? max : max.z;
    let tx = Math.max(0, Math.min(1, (this.x - e0x) / (e1x - e0x)));
    let ty = Math.max(0, Math.min(1, (this.y - e0y) / (e1y - e0y)));
    let tz = Math.max(0, Math.min(1, (this.z - e0z) / (e1z - e0z)));
    return new Vec3(tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty), tz * tz * (3 - 2 * tz));
  }
  toString() { return this.x + ' ' + this.y + ' ' + this.z; }
  toConfigString() { return this.toString(); }
}
