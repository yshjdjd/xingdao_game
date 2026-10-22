// 卡牌数据 + 效果数据的装载与索引。
// 引擎只按 id 取"原子列表"，不认识任何中文牌名 —— grep 牌名在 src/ 下应为 0 命中。
//
// 双端装载：Node 下读 data/*.json；浏览器下由 web/data.bundle.js 注入 globalThis.__XD_DATA__。
// 因此这里不能静态 import node:fs（浏览器解析阶段就会失败），只在需要时动态 import。
import { toU } from "./units.mjs";

const injected = globalThis.__XD_DATA__;

let cardsRaw, effectsRaw;
if (injected) {
  cardsRaw = injected.cards;
  effectsRaw = injected.effects;
} else {
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { fileURLToPath } = await import("node:url");
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
  cardsRaw = readJson("data/cards.json");
  effectsRaw = readJson("data/effects.json");
}

export const raw = cardsRaw;
export const fx = effectsRaw;

const byId = new Map();
for (const c of raw.basic) byId.set(c.id, { ...c, kind: "basic" });
for (const s of raw.sets) {
  for (const c of s.cards) byId.set(c.id, { ...c, kind: "set", setId: s.id, setName: s.name });
}
for (const t of raw.tianji) byId.set(t.id, { ...t, kind: "tianji", name: t.name });
for (const d of raw.dao) byId.set(d.id, { ...d, kind: "dao", name: d.name });
for (const b of raw.birth) byId.set(b.id, { ...b, kind: "birth", name: b.name });
for (const c of fx.synthetic || []) byId.set(c.id, { ...c, kind: "synthetic" });

export const cardById = (id) => byId.get(id);

export const setById = (id) => raw.sets.find((s) => s.id === id);
export const setsOfBatch = (batch) => raw.sets.filter((s) => s.batch === batch);

// 已接入的原子：只有出现在这个集合里的，才算"引擎能跑"
export const SUPPORTED_ATOMS = new Set([
  // 数值 / 判定
  "thresholdInf", "pierceDef", "defPierceable", "incomingAtkDown",
  "atkUp", "atkMul", "atkMulSelf", "extraDamage", "reflect",
  "lifesteal", "maxHpDrain", "healPerHit", "gainEnergyPerHit",
  "drainEnergyPerHit", "healOnHurt",
  // 资源 / 生命
  "chargeBonus", "chargeThreshold", "energyAll", "energyAllDown", "healAll",
  "damageAll", "damageAllFixed", "damageLowest", "healLowest",
  "punishTopEnergy", "energyRegroup", "swapHpEnergy",
  "reviveLast", "reviveOnce", "extraHp", "explodeSurvive", "setAllHpOne",
  "loseHpGainEnergy",
  // 持续状态
  "atkBuff", "atkMulAll", "defBuff", "noDamage", "onlyBasic",
  "costMulAll", "equipDisabled", "banLastTurnCards",
  // 卡牌
  "drawDao", "costDiscount", "chargeMul", "tianjiNow",
  // 需要 prompt 的特殊牌（P1 已接入）
  "banCard", "banAllEnemies", "perHitAtkUp", "energySteal", "copyAction",
  "allocate", "swapActions", "stealCard", "banSet", "revive",
  "lockSpirit", "tallPoppy", "revealHands", "link", "soulSwap", "credit", "subGame",
  // 行动层扩展（P1-2）：非出牌操作 / 反制阶段 / 开局特别阶段
  "forceAttack", "redirect", "negate", "tempSet", "craft", "buyHeal", "convert",
  "tianjiControl", "healTarget",
  // R44 窥天：天机嫁接
  "tianjiGraft",
  // R64 溯流光：揭示后重出一手
  "replay",
]);

// 每张卡的原子列表（无条目 = 纯数值牌，引擎按 type 直接处理）
export const atomsOf = (id) => {
  if (fx.cards && fx.cards[id]) return fx.cards[id].atoms || [];
  if (fx.birth && fx.birth[id]) return fx.birth[id].atoms || [];
  const syn = (fx.synthetic || []).find((c) => c.id === id);
  return syn ? syn.atoms || [] : [];
};

// 该卡是否"数据齐全"（凡声明了引擎不支持的原子，即未接入）
export function cardStatus(id) {
  const atoms = atomsOf(id);
  if (atoms.some((a) => !SUPPORTED_ATOMS.has(a.atom))) return "unsupported";
  if (id.startsWith("tj_") ) {
    const tj = raw.tianji.find((t) => t.id === id);
    if (tj && atoms.length === 0) return "unsupported";
  }
  return "ok";
}

// 该卡在引擎里能否真正生效（供 AI 过滤与覆盖率统计）
export const isImplemented = (id) => cardStatus(id) === "ok";

// 套系被动：把套系特性折成对"消耗"的修正（消耗打折类）
export const setAtoms = (setId) => (fx.sets && fx.sets[setId]?.atoms) || [];

// 道牌分类
export const daoCategory = (id) => cardById(id)?.category || "";

// ---- 派生数值 ----

// 实际能量消耗（点）：套系被动可能打折
export function costOf(player, card) {
  let cost = card.cost ?? 0;
  for (const sid of player.sets) {
    for (const a of setAtoms(sid)) {
      if (a.atom !== "costDiscount") continue;
      if (a.filter?.type && a.filter.type !== card.type) continue;
      if (a.filter?.costAtLeast != null && cost < a.filter.costAtLeast) continue;
      if (a.excludeSelf && card.setId === sid) continue;
      cost = Math.round(cost * (a.factor ?? 0.5) * 2) / 2;
    }
  }
  return toU(cost);
}

export const isAttack = (card) => card.type === "攻术";
export const isDefense = (card) => card.type === "御术";
export const isCharge = (card) => card.type === "蓄力";
export const isExplode = (card) => card.type === "自爆";
