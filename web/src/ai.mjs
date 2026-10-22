// AI。L1 = 启发式（快，用于批量自对弈与托管）；L2 = 蒙特卡洛（准，单步 1-3 秒）。
// 两者共用同一份"候选动作生成"，保证换 AI 不影响规则。
import * as D from "./data.mjs";
import { toU, fmt } from "./units.mjs";
import { playableCards, costFor, beginTurn, resolveTurn } from "./engine.mjs";

const nonAllies = (m, p) => m.players.filter((q) => q.alive && q.factionId !== p.factionId);

function defenseThresholds(m, q) {
  // 对手可能达到的阈值（公开信息可推：其术集与能量都是公开的）
  const out = [0]; // 蓄力 / 攻击时阈值 0
  for (const id of playableCards(m, q)) {
    const c = D.cardById(id);
    if (c.type !== "御术") continue;
    if (costFor(m, q, id) > q.energy) continue;
    if (!out.includes(c.def ?? 0)) out.push(c.def ?? 0);
  }
  return out.sort((a, b) => a - b);
}

function bestThreshold(m, q) {
  const t = defenseThresholds(m, q);
  return t[t.length - 1] || 0;
}

export function candidates(m, p) {
  const list = [];
  for (const id of playableCards(m, p)) {
    const c = D.cardById(id);
    const cost = costFor(m, p, id);
    if (cost > p.energy) continue;
    // 自爆：第 2 回合起、且只在血量 ≤1 点时才纳入候选（避免随机噪声把它当常规牌）
    if (c.type === "自爆" && (m.turn < 2 || p.hp > toU(2))) continue;
    list.push({ cardId: id, cost, type: c.type });
  }
  if (!list.length) return [{ cardId: "base_01", cost: 0, type: "蓄力" }]; // 蓄力恒可用
  return list;
}

// ---------- L1 启发式 ----------
// 用"计划型"AI 而不是逐动作打分：每个 AI 开局抽一个进攻目标档位，
// 攒够就出手。四家档位不同，天然避免"所有人同时打同一个数值 → 并列作废"的对称死锁。

function maxAffordableAttack(m, q) {
  let best = 0;
  for (const id of playableCards(m, q)) {
    const c = D.cardById(id);
    if (c.type !== "攻术") continue;
    if (costFor(m, q, id) > q.energy) continue;
    best = Math.max(best, c.atk ?? 0);
  }
  return best;
}

const TARGETS = [4, 5, 8, 12];

function planOf(p, rng) {
  if (!p.plan) {
    p.plan = { target: TARGETS[rng.int(TARGETS.length)], noise: 0.12 };
  }
  return p.plan;
}

function attackOptions(m, p) {
  const out = [];
  for (const id of playableCards(m, p)) {
    const c = D.cardById(id);
    if (c.type !== "攻术") continue;
    const cost = costFor(m, p, id);
    if (cost > p.energy) continue;
    out.push({ cardId: id, atk: c.atk ?? 0, cost });
  }
  return out.sort((a, b) => a.atk - b.atk);
}

function defenseOptions(m, p) {
  const out = [];
  for (const id of playableCards(m, p)) {
    const c = D.cardById(id);
    if (c.type !== "御术") continue;
    const cost = costFor(m, p, id);
    if (cost > p.energy) continue;
    out.push({ cardId: id, def: c.def ?? 0, cost });
  }
  return out.sort((a, b) => a.def - b.def);
}

export function chooseL1(m, p, rng = m.rng) {
  const plan = planOf(p, rng);
  const opps = nonAllies(m, p);
  const legal = candidates(m, p);
  const pickRandom = () => legal[rng.int(legal.length)];

  if (rng.chance(plan.noise)) return pickRandom();

  const hpRatio = p.hp / p.maxHp;
  const incoming = Math.max(0, ...opps.map((q) => maxAffordableAttack(m, q)));

  // 被借刀杀人强制：能打就必须打，否则扣 1 血
  if (p.forcedAttackThisTurn) {
    const forced = attackOptions(m, p).filter((a) => a.atk >= 1);
    if (forced.length) return forced[forced.length - 1];
  }
  const atks = attackOptions(m, p);
  const defs = defenseOptions(m, p);

  // 1) 濒死先保命
  if (hpRatio <= 0.45 && incoming > 0) {
    const best = defs.filter((d) => d.def >= incoming).sort((a, b) => a.cost - b.cost)[0];
    if (best) return best;
  }

  // 2) 攒够就打：只有打到"计划档位"才出手。
  //    否则宁可再攒一回合 —— 因为人人都能打 4 的时候，4 必然并列作废。
  let target = plan.target;
  if (m.turn > 20) target = 4;
  else if (m.turn > 14) target = Math.min(target, 8);

  const usable = atks.filter((a) => a.atk >= 4);
  const want = usable.filter((a) => a.atk >= target);
  if (want.length) {
    const best = want.sort((a, b) => a.cost - b.cost || a.atk - b.atk)[0];
    if (p.energy >= best.cost) return best;
  }
  // 已到 12 能量还打不到目标档位（例如只持有低档术），退而求其次
  if (p.energy >= 12 && usable.length) {
    const best = usable[usable.length - 1];
    if (p.energy >= best.cost) return best;
  }

  // 3) 能量富余且当前没人能威胁到我 -> 防御吃一波（省下能量下回合爆发）
  if (p.energy >= 8 && incoming === 0) {
    const best = defs[defs.length - 1];
    if (best) return best;
  }

  // 4) 默认蓄力
  const charge = legal.find((c) => D.cardById(c.cardId).type === "蓄力");
  if (charge) return charge;

  // 5) 实在不行就防御
  return defs[0] || pickRandom();
}

// ---------- L2 蒙特卡洛 ----------

// 深拷贝一局的可变部分，用于 rollout（引擎是纯函数，但状态对象要隔离）
function cloneState(m) {
  return {
    ...m,
    players: m.players.map((p) => ({
      ...p,
      sets: p.sets.slice(),
      hand: p.hand.slice(),
      equip: p.equip.slice(),
      flags: { ...p.flags },
      roundStats: { ...p.roundStats },
      selfBuffs: { ...p.selfBuffs },
    })),
    buffs: { ...m.buffs },
    tianji: { ...m.tianji },
    daoDeck: m.daoDeck.slice(),
    eliminationOrder: m.eliminationOrder.slice(),
  };
}

function rolloutScore(st, meSeat) {
  const me = st.players[meSeat];
  if (!me.alive) return 0;
  const aliveRank = st.players.filter((p) => p.alive).length;
  return 1 + (me.hp / Math.max(1, me.maxHp)) * 0.8 + aliveRank * 0.15 + me.energy * 0.03;
}

export function chooseL2(m, p, { rollouts = 120, rng = m.rng } = {}) {
  const list = candidates(m, p);
  let best = null;
  for (const cand of list) {
    let total = 0;
    for (let i = 0; i < rollouts; i++) {
      const st = cloneState(m);
      const me = st.players[p.seat];
      if (costFor(st, me, cand.cardId) > me.energy) { total += 0; continue; }
      const acts = {};
      acts[me.seat] = { cardId: cand.cardId, daoId: null };
      for (const q of st.players) {
        if (q.seat === me.seat || !q.alive) continue;
        const pick = chooseL1(st, q, rng);
        acts[q.seat] = { cardId: pick.cardId, daoId: null };
      }
      resolveTurn(st, acts);
      total += rolloutScore(st, p.seat);
    }
    const avg = total / rollouts;
    if (!best || avg > best.avg) best = { ...cand, avg };
  }
  return best || list[0];
}

// 出牌阶段的"非出牌操作"：不计入本回合出牌，属于身世赋予的小界面
function extrasFor(m, p, card) {
  const ops = [];
  const atoms = D.atomsOf(p.birth);
  const has = (n) => atoms.some((a) => a.atom === n);

  if (has("convert")) {                       // 平民子弟：1 血 <-> 2 能量
    if (p.hp < p.maxHp && p.energy >= toU(4)) ops.push({ op: "convertToHp" });
    else if (p.energy < toU(2) && p.hp >= toU(3)) ops.push({ op: "convertToEnergy" });
  }
  if (has("buyHeal") && p.energy >= toU(4) && p.hp < p.maxHp) ops.push({ op: "buyHeal" }); // 杏林世家

  let craft = null;
  if (has("craft") && D.isAttack(card)) {     // 匠作之家：加 1 点数值，够过免费防御即可
    const v = card.atk ?? 0;
    if (v > 0 && v <= 3 && p.energy >= costFor(m, p, card.id) + toU(1)) craft = { delta: 1 };
  }
  return { ops, craft };
}


// ---------- 道牌估值（拍卖出价 + 是否打出）----------
// 只按"类别 + 原子"估值，不看具体牌名。

function baseValue(card) {
  if (!card) return 0;
  const atoms = D.atomsOf(card.id).map((a) => a.atom);
  if (card.category === "神装牌") {
    let v = 2.0;
    if (atoms.includes("atkMul") || atoms.includes("atkUp")) v += 0.4;
    if (atoms.includes("incomingAtkDown")) v += 0.2;
    return v;
  }
  if (card.category === "神策牌") return 2.2;
  return 1.5;   // 神通
}

// 拍卖出价：整数能量。手牌少、能量富余时更敢抬价。
export function bidFor(m, p, cardId, rng = m.rng) {
  const card = D.cardById(cardId);
  const v = baseValue(card);
  const spare = Math.floor(p.energy / 2);
  // 留出攻击用的能量：能量少时也要留 1 点余量，但不能因此完全不出价
  const reserve = spare >= 8 ? 3 : spare >= 4 ? 1 : 0;
  const cap = Math.max(0, spare - reserve);
  const need = (p.hand?.length || 0) < 2 ? 1.25 : 1.0;
  const noise = rng.chance(0.25) ? rng.int(3) - 1 : 0;   // 偶发抬价/压价，制造并列
  return Math.max(0, Math.min(cap, Math.round(v * need * (p.aggression ?? 1)) + noise));
}

// 是否打出一张道牌：返回 id 或 null
export function chooseDao(m, p, chosenCard) {
  // R60：onlyBasic（返璞归真）生效时道牌同样失效，AI 别浪费一张
  if (m.buffs && m.buffs.onlyBasicTurns > 0) return null;
  const hand = (p.hand || []).filter((id) => D.isImplemented(id));
  if (!hand.length) return null;
  const opps = nonAllies(m, p);
  const slotFree = p.equip.length < 2;
  const deficit = p.maxHp - p.hp;

  const score = (id) => {
    const card = D.cardById(id);
    const atoms = D.atomsOf(id).map((a) => a.atom);
    let v = 0;
    if (card.category === "神装牌") v = slotFree ? baseValue(card) * 0.8 : 0;
    if (atoms.includes("healTarget")) v = deficit >= toU(2) ? 2.4 : 0;
    if (atoms.includes("damageAllFixed")) {
      const low = opps.filter((q) => q.hp <= toU(2)).length;
      v = 0.9 + low * 0.5;
    }
    if (atoms.includes("atkMulSelf")) v = (chosenCard && chosenCard.type === "攻术" && (chosenCard.atk ?? 0) >= 4) ? 1.6 : 0;
    if (atoms.includes("chargeMul")) v = chosenCard && chosenCard.type === "蓄力" ? 1.2 : 0;
    if (atoms.includes("loseHpGainEnergy")) v = p.energy < toU(2) && p.hp > toU(2) ? 1.4 : 0;
    if (atoms.includes("tianjiNow")) v = 0.8;
    if (atoms.includes("setAllHpOne")) v = opps.filter((q) => q.hp > toU(2)).length >= 2 ? 1.2 : 0;
    if (atoms.includes("healAll")) v = deficit >= toU(2) ? 1.2 : 0;
    if (v === 0 && card.category === "神策牌") v = 1.0;
    if (v === 0 && card.category === "神通牌") v = 0.6;
    return v;
  };

  let best = null;
  for (const id of hand) {
    const v = score(id);
    if (v >= 0.9 && (!best || v > best.v)) best = { id, v };
  }
  return best ? best.id : null;
}

export function chooseAction(m, p, { level = "l1", rollouts = 120 } = {}) {
  const base = level === "l2" ? chooseL2(m, p, { rollouts }) : chooseL1(m, p);
  const card = D.cardById(base.cardId);
  const { ops, craft } = extrasFor(m, p, card);

  // 道牌每回合最多 1 张：交给估值函数决定
  const daoId = chooseDao(m, p, card);

  return { ...base, craft, freeOps: ops, daoId };
}

// 完整一局：从当前状态跑到本局结束（供模拟与复盘用）
export function playToRoundEnd(m, { level = "l1", maxTurns = 60 } = {}) {
  let guard = 0;
  while (!m.roundOver && guard++ < maxTurns) {
    beginTurn(m);
    const acts = {};
    for (const p of m.players) {
      if (!p.alive) continue;
      const c = chooseAction(m, p, { level });
      acts[p.seat] = { cardId: c.cardId, daoId: null };
    }
    resolveTurn(m, acts);
  }
  return m;
}
