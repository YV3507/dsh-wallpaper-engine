// WE 渲染引擎 — scene 层: 场景图 (对象树/拓扑排序/类型分类)
// 官方对应: scenescript64.dll 的场景图构建 (CScene::createObject/addObjectToRenderOrder)
// P1 重构: 从 core.js 拆出, 纯搬家零行为变化
export function installSceneGraph(proto) {
  Object.assign(proto, {
    // ── 对象树: 依赖/父级排序 (CScene::createObject/addObjectToRenderOrder) ──
    _resolveObjects() {
      const objects = this.scene.objects || [];
      this.objects = objects.map((o) => ({ ...o, _renderType: this._classify(o) }));
      // 渲染顺序: 依赖前置 + 场景顺序 (防循环依赖栈溢出)
      //
      // ⚠ 去重键必须是**对象身份**, 不能是 `o.id` —— 官方手写的 scene JSON
      // (techno.json / audiophile.json 等) 的 objects 没有 `id` 字段, 旧实现用
      // `added.has(o.id)` 去重 ⇒ 4 个对象的键全是 undefined ⇒ **只有第一个对象
      // 进入 renderOrder**, 其余 3 个永不渲染 (实测 techno: objects=4 renderOrder=1)。
      // 有 id 的场景 (fantasticcar/ricepod/…) 行为逐位不变 (键仍是 'i<id>')。
      const order = [];
      const added = new Set();
      const visiting = new Set();
      const keyOf = (o) => (o && o.id != null ? 'i' + o.id : o);
      const add = (o) => {
        const k = keyOf(o);
        if (added.has(k)) return;
        if (visiting.has(k)) return; // 依赖循环 (A↔B): 已在此链中, 跳过
        visiting.add(k);
        for (const dep of o.dependencies || []) {
          const d = this.objects.find((x) => x.id === dep);
          if (d) add(d);
        }
        if (o.parent != null) {
          const p = this.objects.find((x) => x.id === o.parent);
          if (p) add(p);
        }
        visiting.delete(k);
        added.add(k);
        order.push(o);
      };
      for (const o of this.objects) add(o);
      this.renderOrder = order;
    },

    _classify(o) {
      if (o.image) return 'image';
      if (o.model) return 'model';
      if (o.particle) return 'particle';
      if (o.sound) return 'sound';
      if (o.text) return 'text';
      if (o.light) return 'light';
      return 'unknown';
    },
  });
}
