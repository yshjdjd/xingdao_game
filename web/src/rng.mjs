// 可复现随机数。所有随机都必须走这里，种子落在房间记录里 —— 这是回放与平衡复现的地基。
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    // 内部状态：用于"预演一次再回滚"（联机时先干跑收集 prompt，再带答案真跑）。
    // 不暴露给客户端，只用于服务端克隆。
    state: () => a,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    shuffle: (arr) => {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
    // 权重抽样：items 里每项需有 weight > 0
    weighted: (items) => {
      const total = items.reduce((s, it) => s + it.weight, 0);
      if (total <= 0) return null;
      let r = next() * total;
      for (const it of items) {
        r -= it.weight;
        if (r <= 0) return it;
      }
      return items[items.length - 1];
    },
  };
}
