// 结算内核。纯函数式：输入状态 + 行动 + 种子，输出新状态 + 事件流。
// 约束：本文件不出现任何中文牌名，也不 import 任何 IO 相关模块。
import { CONFIG, hpForRound } from "./config.mjs";
import { U, toU, fmt, INF } from "./units.mjs";
import { makeRng } from "./rng.mjs";
import * as D from "./data.mjs";
import * as S from "./special.mjs";

const aliveList = (m) => m.players.filter((p) => p.alive);
const allies = (m, p) => m.players.filter((q) => q.factionId === p.factionId);
const nonAllies = (m, p) => aliveList(m).filter((q) => q.factionId !== p.factionId);

function newBuffs() {
  return {
    atkAdd: 0, atkAddTurns: 0,
    atkMul: 1, atkMulTurns: 0,
    costMul: 1, costMulTurns: 0,
    defBuff: 0, defBuffTurns: 0,
    chargeBonus: 0, chargeBonusTurns: 0,
    chargeMul: 1, chargeMulTurns: 0,
    noDamageTurns: 0,
    onlyBasicTurns: 0,
    equipDisabledTurns: 0,
    banLastTurn: false,
    lastTurnCards: [],
  };
}

// ---------- 建场 ----------

export function createMatch({ seats, seed = 1 }) {
  const rng = makeRng(seed);
  const players = seats.map((s, i) => ({
    seat: i,
    name: s.name || `P${i + 1}`,
    isAI: s.isAI !== false,
    factionId: s.factionId ?? i,
    hp: 0, maxHp: 0, energy: 0,
    sets: [], hand: [], equip: [], birth: null,
    alive: true, revived: false,
    flags: { explodeSurvived: false, usedRevive: false, hitThisTurn: false },
    roundStats: { hits: 0, charges: 0, kills: 0, survivedTurns: 0 },
    totalScore: 0,
    selfBuffs: { atkMul: 1, atkMulTurns: 0 },
  }));

  const births = rng.shuffle(D.raw.birth.map((b) => b.id));
  players.forEach((p, i) => { p.birth = births[i % births.length]; });

  // 势力表：1 人势力与 2 人势力走同一套逻辑（同盟只是 members 更长）
  const factionIds = [...new Set(players.map((p) => p.factionId))].sort((a, b) => a - b);
  const factions = factionIds.map((id) => ({
    id,
    members: players.filter((p) => p.factionId === id).map((p) => p.seat),
    sets: [],           // R19：术集归势力所有，队内共享
    score: 0,
  }));

  return {
    seed, rng, players,
    roundIndex: 0, turn: 0,
    pool: [], log: [],
    tianji: { sinceLast: 0, lastId: null, firedThisTurn: false },
    buffs: newBuffs(),
    daoDeck: [],
    daoDeckReady: false,     // R80：整场只建一次牌库（跨局不重置）
    factions,
    eliminationOrder: [],
    // 需要玩家当场做选择的天机（押注型 / 借贷型）：抽到时先挂起，等出牌结算前再问人
    pendingTianji: null,
    roundOver: false,
    matchOver: false,
    auctionDoneTurn: -1,
    auctionOffer: null,      // 本回合已公示的拍品（抽一次就固定住，见 peekAuction）
    auctionOfferTurn: -1,
  };
}

function buildDaoDeck(rng) {
  const deck = [];
  for (const d of D.raw.dao) for (let i = 0; i < (d.copies || 1); i++) deck.push(d.id);
  return rng.shuffle(deck);
}

function birthAtoms(p) {
  return (D.fx.birth && D.fx.birth[p.birth]?.atoms) || [];
}

// ---------- 官宦子弟特权（R52）----------

// 本局正在争夺的术集（可选项）
export const tempSetChoices = (m) => (m.pool || []).slice();

// 把某个术集整套临时借给该玩家（不占 3 套上限）。setId 为空或不在本局池子里 → 随机挑一个。
export function grantTempSet(m, seat, setId = null) {
  const p = m.players[seat];
  if (!p) return null;
  const choices = tempSetChoices(m);
  if (!choices.length) return null;
  const sid = choices.includes(setId) ? setId : m.rng.pick(choices);
  const s = D.setById(sid);
  if (!s) return null;
  p.tempCards = [...(p.tempCards || []), ...s.cards.map((c) => c.id)];
  // R59：术系一律公开（基础术除外）。临时借来的也算"拥有的术系"，要记下来对外展示，
  // 否则官宦子弟局初抽到的术系在别人屏幕上根本看不见。
  p.tempSets = [...(p.tempSets || []), sid];
  return sid;
}
function hasBirthAtom(p, atom) {
  return birthAtoms(p).some((a) => a.atom === atom);
}

export function startRound(m, opts = {}) {
  const hpBase = toU(hpForRound(m.roundIndex));
  m.turn = 0;
  m.buffs = newBuffs();
  m.tianji = { sinceLast: 0, lastId: null, firedThisTurn: false };
  m.eliminationOrder = [];
  m.roundOver = false;
  m.lastTurnCards = [];
  m.pendingTianji = null;
  m.auctionDoneTurn = -1;
  m.auctionOffer = null;
  m.auctionOfferTurn = -1;

  // R80：**整场一副公共牌库**。只有第一局建库，之后一直沿用（打出去 / 弃置的牌会洗回来，
  // 牌库总量守恒；唯一不回库的是「天道没收」）。
  // R81：局末**不回收**道牌 —— 道牌是跨局发育资源，谁攒了多少要带着走，
  //      否则「赊天没收」「天道没收」就失去意义了（反正局末都要交回去）。
  if (!m.daoDeckReady) {
    m.daoDeck = buildDaoDeck(m.rng);
    m.daoDeckReady = true;
  }

  for (const p of m.players) {
    const extra = birthAtoms(p).filter((a) => a.atom === "extraHp")
      .reduce((s, a) => s + toU(a.amount || 0), 0);
    p.maxHp = hpBase + extra;
    p.hp = p.maxHp;
    p.energy = 0;
    // R81：hand / equip 不再每局清空（只有第一局是空的）
    p.alive = true;
    p.revived = false;
    p.flags = { explodeSurvived: false, usedRevive: false, hitThisTurn: false };
    p.roundStats = { hits: 0, charges: 0, survivedTurns: 0, dealt: 0 };
    p.tempCards = [];
    p.tempSets = [];
    p.bannedNextTurn = false;
    p.forcedAttack = null;
    p.forcedAttackThisTurn = false;
    // R75：债务**跨局保留**（余债要一直欠着，拿到道牌就被没收）。
    // 胜利势力的存活成员在 endRound 里被免除，不会带进下一局。
    p.tianjiUsed = false;
    p.immuneDao = false;
    p.redirectTo = null;
    p.selfBuffs = { atkMul: 1, atkMulTurns: 0 };
  }
  m.pool = D.setsOfBatch(m.roundIndex + 1).map((s) => s.id);
  for (const f of m.factions) {
    for (const s of f.members) m.players[s].sets = [...f.sets];
  }
  m.bannedCardsThisRound = [];
  // R59：banSet 造成的封禁是"本局后续回合"，所以每局（startRound）清空
  m.bannedSets = [];
  m.bannedBasic = [];
  m.banLog = [];
  m.links = [];
  m.flags = m.flags || {};
  m.flags.tianjiForcedNext = false;   // R45：天命轮转的"下回合必定动荡"不跨局保留
  m.flags.graftBy = null;             // R44：窥天的挂起状态不跨局保留
  m.pendingGraft = null;
  m.setDraft = null;                  // R72：术系轮抽状态不跨局
  m.debtSeizeLog = [];                // R75：欠债没收的事件暂存

  // 官宦子弟（R52）：开局特别阶段，从本局正在争夺的术集里挑 1 个术系整套临时使用。
  // autoTemp=false 时先不派牌，交给调用方（服务端）去问玩家，问完用 grantTempSet 补上。
  for (const p of m.players) {
    if (!birthAtoms(p).some((a) => a.atom === "tempSet")) continue;
    if (opts.autoTemp === false && opts?.setup?.[p.seat] == null) continue;
    grantTempSet(m, p.seat, opts?.setup?.[p.seat] ?? null);
  }
  if (!m.score) m.score = m.players.map(() => 0);
  return m;
}

// ---------- 可出牌集合 ----------

export function playableCards(m, p) {
  const out = [];
  const push = (id) => { if (D.isImplemented(id)) out.push(id); };
  // R59：被 banSet 封掉的基础术 / 整套术系，本局后续回合不能再打
  const noBasic = new Set(m.bannedBasic || []);
  const noSet = new Set(m.bannedSets || []);
  for (const c of D.raw.basic) if (!noBasic.has(c.id)) push(c.id);
  for (const sid of p.sets) {
    if (noSet.has(sid)) continue;
    const s = D.setById(sid);
    for (const c of s.cards) push(c.id);
  }
  for (const id of p.tempCards || []) {
    const sc = D.cardById(id);
    if (sc?.kind === "set" && noSet.has(sc.setId)) continue;
    push(id);
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if ((m.bannedCardsThisRound || []).includes(out[i])) out.splice(i, 1);
  }
  if (m.buffs.onlyBasicTurns > 0) return D.raw.basic.map((c) => c.id).filter(D.isImplemented);
  if (m.buffs.banLastTurn) {
    return out.filter((id) => !(m.buffs.lastTurnCards || []).includes(id));
  }
  return out;
}

export function costFor(m, p, cardId) {
  const card = D.cardById(cardId);
  let units = D.costOf(p, card);
  if (m.buffs.costMulTurns > 0) units = Math.round(units * m.buffs.costMul);
  return units;
}

// ---------- 回合：开始 / 结算 ----------

export function beginTurn(m, opts = {}) {
  // 默认在这里推进回合计数。但拍卖属于"即将开始的那个回合"：驱动方为了让牌桌显示
  // 「第 5 回合 · 拍卖」会先把计数推上去，再用 advance:false 让这里不要重复推。
  if (opts.advance !== false) m.turn += 1;
  m.tianji.firedThisTurn = false;      // 每回合重新判定："本回合有没有天机"
  const ev = [];

  // 计时类 buff 衰减
  const b = m.buffs;
  if (b.atkAddTurns > 0 && --b.atkAddTurns === 0) b.atkAdd = 0;
  if (b.atkMulTurns > 0 && --b.atkMulTurns === 0) b.atkMul = 1;
  if (b.costMulTurns > 0 && --b.costMulTurns === 0) b.costMul = 1;
  if (b.defBuffTurns > 0) { b.defBuffTurns -= 1; if (b.defBuffTurns === 0) b.defBuff = 0; }
  if (b.chargeBonusTurns > 0) { b.chargeBonusTurns -= 1; if (b.chargeBonusTurns === 0) b.chargeBonus = 0; }
  if (b.chargeMulTurns > 0) { b.chargeMulTurns -= 1; if (b.chargeMulTurns === 0) b.chargeMul = 1; }
  if (b.noDamageTurns > 0) b.noDamageTurns -= 1;
  if (b.onlyBasicTurns > 0) b.onlyBasicTurns -= 1;
  if (b.equipDisabledTurns > 0) b.equipDisabledTurns -= 1;

  for (const p of m.players) {
    p.flags.hitThisTurn = false;
    // R63：自我倍率只在"打出那一回合"有效，原来 atkMulTurns 从不衰减
    p.selfBuffs.atkMulTurns = 0;
    p.selfBuffs.atkMul = 1;
    if (p.alive) p.roundStats.survivedTurns += 1;
  }

  // ① 补给：第 10/15/20… 回合
  if (m.turn >= CONFIG.supplyTurnStart && (m.turn - CONFIG.supplyTurnStart) % CONFIG.supplyEvery === 0) {
    for (const p of aliveList(m)) p.energy += CONFIG.supplyEnergy;
    ev.push({ t: "supply", turn: m.turn, amount: fmt(CONFIG.supplyEnergy) });
  }

  // ③ 天机
  const tj = rollTianji(m);
  if (tj) {
    let applied = false;
    const atoms = (D.fx.cards[tj.id]?.atoms) || [];
    const sub = [];                 // 天机自身产生的子事件（发牌等），排在「天机」之后
    // 需要当场做选择的天机不能在这里算 —— 此刻还没人可问。挂起到结算前再走一遍。
    if (atoms.some((a) => a.atom === "subGame" || a.atom === "credit")) {
      m.pendingTianji = { id: tj.id, name: tj.name };
    } else if (m.flags?.graftBy != null && isGraftableTianji(tj.id)) {
      // R44：有人挂着「窥天」→ 先别生效，等执行前窗口问完"搬谁的份、嫁接到谁"再算。
      m.pendingGraft = { id: tj.id, name: tj.name, holder: m.flags.graftBy };
      m.flags.graftBy = null;
    } else {
      applyTianji(m, tj, null, sub);
      applied = true;
    }
    ev.push({ t: "tianji", id: tj.id, name: tj.name });
    ev.push(...sub);
    // R60：天机在出牌之前就生效，扣血扣死的人**当场出局**，不等回合结算。
    // 顺序上先记天机、再记出局，事件记录读起来才顺。
    if (applied) settleEliminations(m, ev);
  }
  return ev;
}

function tianjiPool(m) {
  const t = m.turn;
  return D.raw.tianji.filter((c) => {
    if (c.id === "tj_19" && t < 10) return false;       // 焚天：回合 ≥10
    if (c.id === "tj_22" && t < 5) return false;        // 命运乖离：回合 ≥5（否则局初触发会 1 回合结束整局）
    if (c.id === "tj_20" && t < 15) return false;       // 天命改易：回合 ≥15
    if (c.id === "tj_15" && !aliveList(m).some((p) => p.hand.length)) return false;
    if (c.id === "tj_18" && m.eliminationOrder.length === 0) return false;
    if (!D.isImplemented(c.id)) return false;
    if (c.id === "tj_17") {
      const es = aliveList(m).map((p) => p.energy);
      if (new Set(es).size <= 1) return false;
    }
    return true;
  });
}

// R42：天机门人身世已删除，天机回到纯自然判定 —— 没有任何人能在判定前干预。
function rollTianji(m) {
  if (m.tianji.firedThisTurn) return null;

  // R45：上一回合有人打出了「天命轮转」→ 跳过概率判定，本回合必定动荡
  const doomed = !!m.flags?.tianjiForcedNext;
  if (doomed) m.flags.tianjiForcedNext = false;

  const chance = m.roundIndex === CONFIG.finalRoundIndex
    ? CONFIG.tianjiFinalChance : CONFIG.tianjiBaseChance;
  // 保底：连续 tianjiPity 回合没出，这一回合必定动荡
  const forced = doomed || m.tianji.sinceLast >= CONFIG.tianjiPity;
  if (!forced && !m.rng.chance(chance)) {
    m.tianji.sinceLast += 1;
    return null;
  }
  const pool = tianjiPool(m).map((c) => ({ ...c, weight: c.weight || 1 }));
  const picked = m.rng.weighted(pool);
  m.tianji.sinceLast = 0;
  m.tianji.lastId = picked?.id || null;
  m.tianji.firedThisTurn = true;
  return picked;
}

export function applyTianjiCard(m, card, ev = []) { applyTianji(m, card, null, ev); }

function applyTianji(m, card, graft = null, ev = []) {
  const atoms = (D.fx.cards[card.id]?.atoms) || [];
  for (const a of atoms) applyAtom(m, null, a, { source: "tianji", graft, ev });
}

// ---------- R44 窥天：天机嫁接 ----------

// 全场类：每个人各有一份。搬走 A 的那份挂到 B 身上 → B 吃两份、A 吃零。
const GRAFT_ALL = new Set(["damageAll", "healAll", "energyAll", "energyAllDown", "drawDao"]);
// 单体类：本来只落在某一个人身上，直接改目标即可（那个人不会有"两份"）。
const GRAFT_ONE = new Set(["damageLowest", "healLowest", "punishTopEnergy"]);

export function isGraftableTianji(id) {
  const atoms = (D.fx.cards[id]?.atoms) || [];
  return atoms.some((a) => GRAFT_ALL.has(a.atom) || GRAFT_ONE.has(a.atom));
}

// 逐个玩家结算"这一份"：被搬走的人跳过，被嫁接到的人吃两份
function perPlayer(list, graft, fn) {
  for (const p of list) {
    if (graft && p.seat === graft.from) continue;           // 这份被搬走了
    const times = graft && p.seat === graft.to ? 2 : 1;     // 目标：自己那份 + 搬来的那份
    for (let i = 0; i < times; i++) fn(p);
  }
}

// 单体类：本来只落在排第一的那个人身上。
// 那个人正好是被搬走的 → 改落到被嫁接的人头上；否则照旧（这道天机本来就没落在 from 身上）。
function graftOne(sorted, graft) {
  const first = sorted[0] || null;
  if (!graft || !first) return first;
  if (first.seat !== graft.from) return first;
  return sorted.find((p) => p.seat === graft.to) || null;
}

// ---------- 原子效果 ----------

function applyAtom(m, actor, a, ctx = {}) {
  const b = m.buffs;
  const graft = ctx.graft || null;      // R44：窥天嫁接 {from, to}
  switch (a.atom) {
    // R44 窥天：打出后挂起，下一次天机执行前可以搬一份
    case "tianjiGraft":
      if (actor) m.flags.graftBy = actor.seat;
      break;
    case "energyAll":
      perPlayer(aliveList(m), graft, (p) => { p.energy += toU(a.amount); });
      break;
    case "energyAllDown":
      perPlayer(aliveList(m), graft, (p) => { p.energy = Math.max(0, p.energy - toU(a.amount)); });
      break;
    case "healAll":
      perPlayer(m.players.filter((p) => p.alive || ctx.includeDead), graft,
        (p) => heal(m, p, toU(a.amount)));
      break;
    case "atkBuff":
      b.atkAdd += toU(a.add); b.atkAddTurns = a.turns || 1;
      break;
    case "atkMulAll":
      b.atkMul *= a.factor; b.atkMulTurns = a.turns || 1;
      break;
    case "defBuff":
      b.defBuff += toU(a.add); b.defBuffTurns = 1;
      break;
    case "noDamage":
      b.noDamageTurns = 1;
      break;
    case "onlyBasic":
      b.onlyBasicTurns = 1;
      break;
    case "costMulAll":
      b.costMul = a.factor; b.costMulTurns = a.turns || 1;
      break;
    case "chargeBonus":
      b.chargeBonus += toU(a.add); b.chargeBonusTurns = a.turns ?? 99;
      break;
    case "drawDao": {
      // R79：天官赐福的卡面是「所有玩家无论是否被淘汰都获得 1 张」，scope='all' 就按字面来；
      // 发放顺序也打乱 —— 谁先抽不该由座位号决定（牌从剩余牌库里随机挑，见 drawDao）。
      const targets = a.scope === "all" ? [...m.players] : aliveList(m);
      const order = a.amount > 0 ? m.rng.shuffle(targets) : targets;
      perPlayer(order, graft, (p) => {
        if (a.amount > 0) {
          for (let i = 0; i < a.amount; i++) drawDao(m, p, ctx.ev, { cause: "tianji" });
        } else {
          for (let i = 0; i < -a.amount; i++) discardDao(m, p);
        }
      });
      break;
    }
    case "damageAll":
      // R60：天机阶段的全员扣血**不走 hit** —— 它是环境伤害，不是任何人打出来的：
      // 不吃护心镜、不触发反伤、不被「天下太平」豁免、也不受"一回合基础伤害封顶 1 血"约束。
      // 直接从血量上扣，扣完由调用方立刻判死（settleEliminations）。
      perPlayer(aliveList(m), graft, (p) => { p.hp -= toU(a.amount); });
      break;
    case "damageLowest": {
      const t = graftOne(aliveList(m).sort((x, y) => x.hp - y.hp), graft);
      if (t) hit(m, t, toU(a.amount), null, { kind: "effect" });
      break;
    }
    case "healLowest": {
      const t = graftOne(aliveList(m).sort((x, y) => x.hp - y.hp), graft);
      if (t) heal(m, t, toU(a.amount));
      break;
    }
    case "punishTopEnergy": {
      const t = graftOne(aliveList(m).sort((x, y) => y.energy - x.energy), graft);
      if (t) t.energy = Math.max(0, t.energy - toU(a.amount));
      break;
    }
    case "energyRegroup": {
      // R09：按能量组循环下移一档
      const groups = [...new Set(aliveList(m).map((p) => p.energy))].sort((x, y) => y - x);
      if (groups.length <= 1) break;
      const map = new Map();
      groups.forEach((g, i) => map.set(g, groups[(i + 1) % groups.length]));
      for (const p of aliveList(m)) p.energy = map.get(p.energy);
      break;
    }
    case "swapHpEnergy": {
      // R10：血量与能量互换，血量上限不变；补充口径：互换后血量最低保留 0.5，
      // 否则开局全员 0 能量时会瞬杀全场（实测确实会）。
      const floor = toU(0.5);
      for (const p of aliveList(m)) {
        const hp = p.hp, en = p.energy;
        p.energy = Math.min(hp, p.maxHp);
        p.hp = Math.max(floor, Math.min(en, p.maxHp));
      }
      break;
    }
    case "reviveLast": {
      const last = m.eliminationOrder[m.eliminationOrder.length - 1];
      if (last) revivePlayer(m, last, toU(1), 0);
      break;
    }
    case "equipDisabled":
      b.equipDisabledTurns = a.turns || 1;
      break;
    case "banLastTurnCards":
      b.banLastTurn = true;
      b.lastTurnCards = m.lastTurnCards || [];
      break;
    // R63：献祭 —— 失去 1 血换 3 能量。原来这个原子只在 SUPPORTED_ATOMS 里挂着，没有实现，等于空牌。
    // 注意时序：它排在档 ②，此时本回合的牌已经付过费了，所以这 3 能量是**下一回合**的本钱。
    case "loseHpGainEnergy":
      if (actor) {
        actor.hp -= toU(a.loseHp ?? 1);
        actor.energy += toU(a.gainEnergy ?? 3);
      }
      break;
    // R63：破防 —— 本回合自己的攻击数值翻倍。原来没人写 selfBuffs，读了也是白读。
    case "atkMulSelf":
      if (actor) {
        actor.selfBuffs.atkMul = a.factor ?? 2;
        actor.selfBuffs.atkMulTurns = 1;
      }
      break;
    case "chargeMul":
      b.chargeMul = a.factor; b.chargeMulTurns = 1;
      break;
    // R45：天命轮转改为"下一回合必定天机动荡"，不再立刻抽牌。
    // 立刻抽牌发生在回合开始、还没人能反应的时候，等于静默生效；延后一回合后它可被看见，
    // 也会被「窥天」的嫁接窗口覆盖到。
    case "tianjiNow":
      m.flags.tianjiForcedNext = true;
      break;
    case "setAllHpOne":
      for (const p of aliveList(m)) p.hp = Math.min(p.hp, toU(1));
      break;
    case "healAllFixed":
      for (const p of aliveList(m)) heal(m, p, toU(a.amount));
      break;
    default:
      break;
  }
}

// R80：整场一副公共牌库 —— 打出去 / 弃置的牌都洗回牌库，牌池总量守恒。
// 唯一不回库的是「天道没收」（赊天抵债）：那是真被天道收走了。
// 注意牌库里**同名不同份是同一个 id**（回春 ×5），所以这里不能按 id 去重，
// 只能靠"调用点都在把牌从 hand/equip 移除之后"来保证同一份实体不会被回收两次。
export function returnDao(m, id) {
  if (id) m.daoDeck.push(id);
}

function drawDao(m, p, ev = null, meta = {}) {
  if (!m.daoDeck.length) {
    if (ev) ev.push({ t: "daoGain", seat: p.seat, empty: true, cause: meta.cause || "tianji" });
    return null;
  }
  const at = m.rng.int(m.daoDeck.length);
  const id = m.daoDeck.splice(at, 1)[0];
  const seized = !!seizeForDebt(m, p, id);  // R75：欠天道的，抽到的牌直接被没收
  if (!seized) {
    p.hand.push(id);
    trimHand(m, p);
  }
  // R78：发牌要留痕。以前天官赐福抽完什么都不记，玩家只能看到"道牌数 +1"，
  // 很容易误以为"全场拿的是同一张"。具体牌名只发给本人（见 view.publicEvents）。
  if (ev) {
    ev.push({
      t: "daoGain", seat: p.seat, cardId: id,
      name: D.cardById(id)?.name || id,
      cause: meta.cause || "tianji", seized,
    });
  }
  return id;
}
function discardDao(m, p) {
  if (p.hand.length) returnDao(m, p.hand.splice(m.rng.int(p.hand.length), 1)[0]);
}
// R11（修订）：道牌上限 = 血量上限本身（3/4/5/5 张），而不是"上限的一半"。
// 超出不会自动消失——回合结束会进入弃牌判断期，由持有者自己挑要弃哪些。
function handCap(p) {
  return Math.max(1, Math.round(p.maxHp / 2));
}
function trimHand(m, p) { autoDiscard(m, p.seat); }

// R55：神装获取即自动装载，且<b>照样计入道牌持有上限</b>——穿得越多，能带的神通/神策就越少。
// 已装载的在 equip 里，没装载的在 hand 里，两边一起算。
function heldDao(p) { return p.hand.length + (p.equip?.length || 0); }

// 回合结束的弃牌判断：谁超了、超几张（引擎不替玩家决定弃哪张）
export function discardOver(m) {
  return m.players
    .filter((p) => p.alive && heldDao(p) > handCap(p))
    .map((p) => ({ seat: p.seat, over: heldDao(p) - handCap(p), handCount: heldDao(p), cap: handCap(p) }));
}

// R55：超上限时也可以弃掉已装载的神装（否则"穿满+手牌也满"会卡死在弃牌期）
export function discardCards(m, seat, ids) {
  const p = m.players[seat];
  if (!p) return [];
  const pick = new Set(ids || []);
  const lostHand = p.hand.filter((id) => pick.has(id));
  if (lostHand.length) p.hand = p.hand.filter((id) => !pick.has(id));
  const lostEquip = (p.equip || []).filter((id) => pick.has(id));
  if (lostEquip.length) p.equip = p.equip.filter((id) => !pick.has(id));
  // R80：弃掉的牌回公共牌库（和打出去的一样，牌池总量守恒）
  for (const id of [...lostHand, ...lostEquip]) returnDao(m, id);
  return [...lostHand, ...lostEquip];
}

// 超时 / AI 兜底：随机弃到刚好不超
export function autoDiscard(m, seat) {
  const p = m.players[seat];
  if (!p) return [];
  const over = heldDao(p) - handCap(p);
  if (over <= 0) return [];
  const lost = [];
  // 先弃手上的，手牌空了才动已装载的神装（尽量保住已经生效的装备）
  for (let i = 0; i < over; i++) {
    if (p.hand.length) lost.push(...p.hand.splice(m.rng.int(p.hand.length), 1));
    else if (p.equip.length) lost.push(...p.equip.splice(m.rng.int(p.equip.length), 1));
    else break;
  }
  for (const id of lost) returnDao(m, id);   // R80：弃置回牌库
  return lost;
}

// ---------- R55 神装：装载 / 卸下 ----------
// 装载在出牌阶段做，且消耗本回合的道牌使用名额；卸下同样只在出牌阶段，但不占名额。
// 返回 null = 成功，否则返回给玩家看的错误原因。
export function setEquipState(m, seat, daoId, on) {
  const p = m.players[seat];
  if (!p) return "你不在本局中";
  if (!p.alive) return "你已被淘汰";
  const card = D.cardById(daoId);
  if (!card || card.category !== "神装牌") return "这不是神装牌";
  if (on) {
    if (!p.hand.includes(daoId)) return "你手上没有这件神装";
    if (m.buffs.equipDisabledTurns > 0) return "装备封禁期间不能装载";
    p.hand = p.hand.filter((id) => id !== daoId);
    p.equip = [...(p.equip || []), daoId];
  } else {
    if (!(p.equip || []).includes(daoId)) return "这件神装没有装载";
    p.equip = p.equip.filter((id) => id !== daoId);
    p.hand = [...p.hand, daoId];
  }
  return null;
}

function heal(m, p, units) {
  p.hp = Math.min(p.maxHp, p.hp + units);
}

// ---------- 伤害 ----------

function hasEquipAtom(m, p, name) {
  if (m.buffs.equipDisabledTurns > 0) return [];
  return p.equip
    .flatMap((id) => (D.fx.cards[id]?.atoms) || [])
    .filter((a) => a.atom === name);
}

function setAtomSum(p, name, field = "perHit") {
  let sum = 0;
  for (const sid of p.sets) {
    for (const a of D.setAtoms(sid)) {
      if (a.atom === name) sum += toU(a[field] ?? 0);
    }
  }
  return sum;
}

// 单次命中。depth 控制反伤只跑一轮（R05）。
function hit(m, target, amount, source, opts = {}) {
  const depth = opts.depth || 1;
  if (m.buffs.noDamageTurns > 0 && opts.kind !== "explode") return 0;
  if (!target.alive) return 0;
  let dmg = amount;

  // 攻方被动：额外扣血（洞玄冠 / 物道）
  if (source) {
    const extra = hasEquipAtom(m, source, "extraDamage").reduce((s, a) => s + toU(a.perHit || 0), 0)
      + setAtomSum(source, "extraDamage");
    dmg += extra;
  }
  if (dmg <= 0) return 0;
  target.hp -= dmg;
  target.flags.hitThisTurn = true;
  if (source) {
    source.roundStats.dealt = (source.roundStats.dealt || 0) + dmg;
    if (!m.dmgLog) m.dmgLog = new Map();
    const key = target.seat;
    if (!m.dmgLog.has(key)) m.dmgLog.set(key, new Map());
    const inner = m.dmgLog.get(key);
    inner.set(source.seat, (inner.get(source.seat) || 0) + dmg);
  }

  // 铁索连环：伤害在连环两人之间传导（只传导一层，避免递归）
  if (depth === 1 && m.links) {
    for (const pair of m.links) {
      if (!pair.includes(target.seat)) continue;
      const otherSeat = pair[0] === target.seat ? pair[1] : pair[0];
      const other = m.players[otherSeat];
      if (other && other.alive && other.seat !== (source ? source.seat : -1)) {
        hit(m, other, dmg, source, { depth: 2, kind: opts.kind });
      }
    }
  }

  if (depth > 1) return dmg; // 反伤不再触发反伤

  // 守方被动：反弹 / 回血 / 回能
  for (const a of hasEquipAtom(m, target, "reflect")) {
    const back = a.amount != null ? toU(a.amount) : (opts.attackValue || 0);
    if (source && back > 0) hit(m, source, back, target, { depth: depth + 1, kind: "reflect" });
  }
  // R63：泣血珠 / 聚灵玉环 是"**你造成**伤害时回血/回能"，主体是攻方（source），
  // 原来误写成守方（target），变成了"被打的人回血回能"，完全反了。
  if (source) {
    for (const a of hasEquipAtom(m, source, "healPerHit")) heal(m, source, toU(a.amount || 0));
    for (const a of hasEquipAtom(m, source, "gainEnergyPerHit")) source.energy += toU(a.amount || 0);
  }

  // 攻方被动：吸血 / 扣上限
  if (source) {
    const steal = setAtomSum(source, "lifesteal");
    if (steal > 0) heal(m, source, steal);
    const drain = setAtomSum(source, "maxHpDrain");
    if (drain > 0) {
      target.maxHp = Math.max(toU(0.5), target.maxHp - drain);
      target.hp = Math.min(target.hp, target.maxHp);
    }
  }
  return dmg;
}

// 赊借：淘汰时仍未还清的能量，每缺 1 点随机失去 1 张道牌（本局最终胜者局末免还）
// R75：赊天清算。顺序（用户口径）：
//   ① 先用**剩余能量**抵债；
//   ② 不够，每缺 1 点随机失去 1 张道牌（先手牌，再已装载的神装）；
//   ③ 还不够 —— **继续欠着**，跨局保留；之后每次获得道牌会被天道直接没收（seizeForDebt）。
// 返回明细，调用方据此发事件、并把"抵债后剩下的能量"拿去瓜分。
function settleDebt(m, p) {
  const out = { owe0: Math.max(0, p.debt || 0), paidEnergy: 0, lost: [], left: 0 };
  if (!out.owe0) return out;
  let owe = out.owe0;
  out.paidEnergy = Math.min(owe, Math.max(0, p.energy));
  p.energy -= out.paidEnergy;
  owe -= out.paidEnergy;
  while (owe >= toU(1)) {
    const pool = (p.hand && p.hand.length) ? p.hand : ((p.equip && p.equip.length) ? p.equip : null);
    if (!pool) break;
    out.lost.push(pool.splice(m.rng.int(pool.length), 1)[0]);
    owe -= toU(1);
  }
  // R82：抵债掉的道牌回公共牌库（不是真消失，牌池总量不变）
  for (const id of out.lost) returnDao(m, id);
  p.debt = owe;                       // 余债留着，不抹掉
  out.left = owe;
  return out;
}

// 欠着天道的人一旦拿到道牌 -> 直接没收抵债（不入手牌，牌回牌库）
export function seizeForDebt(m, p, id) {
  if (!p || !(p.debt > 0)) return false;
  p.debt = Math.max(0, p.debt - toU(1));
  returnDao(m, id);                   // R82：没收 = 牌回牌库抵债，不是让牌消失
  (m.debtSeizeLog = m.debtSeizeLog || []).push({
    t: "debtSeize", seat: p.seat, cardId: id,
    name: D.cardById(id)?.name || id, left: fmt(p.debt),
  });
  return true;
}

function revivePlayer(m, p, hp, energy) {
  p.alive = true;
  p.revived = true;
  p.hp = Math.min(hp, p.maxHp);
  p.energy = energy ?? p.energy;
  m.eliminationOrder = m.eliminationOrder.filter((x) => x.seat !== p.seat);
}

// ---------- 道牌生效顺序（R46）----------
// 每张道牌带一个 order（允许小数）：整数部分 = 档位（1–6），小数 = 档内顺序，越小越优先。
// 判定与扣血发生在「档 ③ 之后、档 ④ 之前」，所以 4 是执行器的唯一分界点：
//   order <  4 → 判定之前跑（档 ①②③）
//   order >= 4 → 判定之后跑（档 ④⑤⑥）
// 被动牌（order = null，替身玉符 / 无懈可击）不进队列，走它们各自的被动触发。
export const DAO_SPLIT = 4;

export function daoOrder(id) {
  const o = D.cardById(id)?.order;
  return typeof o === "number" ? o : null;
}

// 按 (order, seat) 排序；before=true 取判定前那一批，false 取判定后那一批
function orderedDao(queue, before) {
  return queue
    .filter((it) => typeof it.order === "number" && (before ? it.order < DAO_SPLIT : it.order >= DAO_SPLIT))
    .sort((a, b) => (a.order - b.order) || (a.seat - b.seat));
}

// 执行一张道牌：先走即时/全局类原子（applyAtom），再走它挂在 PRE/VALUE/COMBAT/POST 里的处理器。
// 两类原子互不重叠（已用脚本核对），所以可以安全地都跑一遍。
function runDao(ctx, it) {
  // R46：道牌是独立的一手。术被作废（封印 / 锁灵符选「术」）不影响道牌结算——
  // 只有被明确判为"本回合道牌失效"（daoVoid，如锁灵符选「道」）才拦下来。
  if (it.entry.daoVoid) return;
  const p = ctx.m.players[it.seat];
  for (const at of it.atoms) {
    applyAtom(ctx.m, p, at, { source: "dao" });
    const fn = S.PRE[at.atom] || S.VALUE[at.atom] || S.COMBAT[at.atom] || S.POST[at.atom];
    if (fn) fn(ctx, it.seat, it.entry.card, at);
  }
}


// 淘汰结算：血量归零的人立刻出局、能量按伤害来源瓜分。
// R60：抽成公共函数 —— 天机（尤其焚天）在出牌之前就会扣血，那一刻就得判死，
// 不能等人撑到结算阶段才死。
export function settleEliminations(m, ev = []) {
  for (const p of m.players) {
    if (!p.alive || p.hp > 0) continue;
    const rev = hasEquipAtom(m, p, "reviveOnce")[0];
    if (rev && !p.flags.usedRevive) {
      p.flags.usedRevive = true;
      p.hp = toU(rev.hp || 2);
      const gone = p.equip.filter((id) => (D.fx.cards[id]?.atoms || []).some((a) => a.atom === "reviveOnce"));
      p.equip = p.equip.filter((id) => !gone.includes(id));
      for (const id of gone) returnDao(m, id);    // R80：用掉的复活装回牌库
      continue;
    }
    p.alive = false;
    m.eliminationOrder.push(p);
    const inner = m.dmgLog?.get(p.seat) || new Map();
    const damagers = [...inner.keys()].map((s) => m.players[s]).filter(Boolean);
    // R75：天道先来收债（扣能量 / 掉道牌 / 余债保留），**剩下的**才给击杀者瓜分
    const dbt = settleDebt(m, p);
    // R59：把瓜分账目记下来，界面要能说清"他那些能量去哪了"
    const pool = p.energy;
    let split = { pool, gainers: [], share: 0, by: [] };
    if (damagers.length) {
      // 4.5 + 同盟：瓜分给"造成过伤害者"所在势力的全体成员
      const facIds = [...new Set(damagers.map((d) => d.factionId))];
      const gainers = m.players.filter((q) => facIds.includes(q.factionId));
      const share = Math.min(Math.floor(p.energy / Math.max(1, gainers.length)), Math.floor(p.energy / 2));
      for (const g of gainers) g.energy += share;
      for (const d of damagers) d.roundStats.kills = (d.roundStats.kills || 0) + 1;
      split = { pool, gainers: gainers.map((g) => g.seat), share, by: damagers.map((d) => d.seat) };
    }
    m.elimLog = [...(m.elimLog || []), { seat: p.seat, ...split }];
    p.energy = 0;
    ev.push({ t: "eliminate", seat: p.seat, by: damagers.map((k) => k.seat), split });
    if (dbt.owe0) {
      ev.push({
        t: "debt", seat: p.seat, paid: fmt(dbt.paidEnergy), lost: dbt.lost,
        left: fmt(dbt.left), owe0: fmt(dbt.owe0),
      });
    }
  }
  return ev;
}

// ---------- 主结算 ----------

export function resolveTurn(m, actions, options = {}) {
  const ev = [];
  const act = new Map();
  const answers = options.answers || {};
  const freeOps = options.freeOps || {};
  const reactions = options.reactions || {};

  // ---------- 0.0 天机里的「当场选择」环节（押注型 / 借贷型）----------
  // 这两张天机在回合开始时就抽定了，但轮不到那时候问人 —— 挪到这里，跟出牌的追问一起收答案。
  if (m.pendingTianji) {
    S.applyPendingTianji({
      m, ev, answers, prompts: options.prompts,
      acts: act, attacks: [], defenses: [], charges: [], explodes: [], forcedState: new Map(),
    }, m.pendingTianji);
    m.pendingTianji = null;
  }

  // ---------- 0. 反制阶段（道牌响应窗口） ----------
  for (const key of Object.keys(reactions)) {
    const p = m.players[Number(key)];
    if (!p || !p.alive) continue;
    const r = reactions[key] || {};
    if (r.negate && p.hand.includes("dao_31")) {
      p.hand = p.hand.filter((x) => x !== "dao_31");
      returnDao(m, "dao_31");            // R80：打出去的无懈可击回牌库
      p.immuneDao = true;
      ev.push({ t: "negate", seat: p.seat });
    } else if (r.redirect != null && p.hand.includes("dao_26")) {
      p.hand = p.hand.filter((x) => x !== "dao_26");
      returnDao(m, "dao_26");            // R80：打出去的偷天换日回牌库
      p.immuneDao = true;
      p.redirectTo = Number(r.redirect);
      ev.push({ t: "redirect", seat: p.seat, to: p.redirectTo });
    }
  }

  // ---------- 0.5 非出牌操作（出牌阶段的小界面，不计入本回合出牌） ----------
  for (const key of Object.keys(freeOps)) {
    const seat = Number(key);
    for (const op of freeOps[key] || []) {
      // 兼容老客户端：仍然可以在提交出牌时带 freeOps，规则与实时版完全一致
      const r = applyFreeOp(m, seat, op.op);
      if (!r.ok) continue;
      if (op.op === "buyHeal") ev.push({ t: "buyHeal", seat });
      else ev.push({ t: "convert", seat, to: op.op === "convertToHp" ? "hp" : "energy" });
    }
  }

  // ---------- 1. 登记 + 收费 + 道牌 ----------
  const daoQueue = [];      // R46：本回合打出的非神装道牌，稍后按 order 排序执行
  for (const p of aliveList(m)) {
    const a = actions[p.seat];
    if (!a || !a.cardId) continue;
    const card = D.cardById(a.cardId);
    const cost = costFor(m, p, a.cardId);
    if (p.energy < cost) continue;
    p.energy -= cost;
    const entry = {
      p, card, base: toU(card.atk ?? 0), daoId: a.daoId || null,
      void: false, daoVoid: false, patched: false,
      cost,                                     // R64：溯流光重出时要按这个额度退还/重扣
    };
    const craft = a.craft;
    if (craft && craft.delta) {
      const d = Number(craft.delta) || 0;          // 点：+ 加数值 / - 降数值换能量
      if (d > 0 && p.energy >= toU(d)) {
        p.energy -= toU(d);
        entry.base += toU(d);
      } else if (d < 0) {
        const refund = Math.min(-d, (card.cost ?? 0));
        p.energy += toU(refund);
        entry.base = Math.max(0, entry.base - toU(-d));
      }
      ev.push({ t: "craft", seat: p.seat, delta: d });
    }
    if (craft && craft.patch && p.energy >= toU(1) && D.atomsOf(card.id).some((x) => x.atom === "defPierceable")) {
      p.energy -= toU(1);
      entry.patched = true;                        // 补上"被普攻克制"的缺点，每张只能加一次
      ev.push({ t: "craftPatch", seat: p.seat });
    }
    act.set(p.seat, entry);

    if (a.daoId && m.buffs.onlyBasicTurns > 0) {
      // R60：返璞归真类天机「术套系内术与道牌失效，仅基础术生效」—— 道牌同样打不出去（照样要扣费，代价照付）
      if (!ev.some((e) => e.t === "daoVoid" && e.seat === p.seat)) {
        ev.push({ t: "daoVoid", seat: p.seat, daoId: a.daoId });
      }
      a.daoId = null;
    }
    if (a.daoId) {
      const dao = D.cardById(a.daoId);
      const atoms = D.atomsOf(a.daoId);      // 合成牌（杏林方）在 fx.synthetic 里，不能只查 fx.cards
      const isEquip = dao.category === "神装牌";
      const equipped = isEquip && m.buffs.equipDisabledTurns === 0;
      if (equipped) {
        // 神装：从手里穿到装备区，不消耗（被挤掉的那件才回牌库）
        if (p.equip.length >= CONFIG.equipmentSlots) returnDao(m, p.equip.shift());
        p.equip.push(a.daoId);
      } else if (!isEquip) {
        // R46：不在登记时就地生效——排进 order 队列，等档 ①（改写出牌本身）走完再按顺序跑。
        // 否则「锁灵符」(1.2) 会让对面的道牌失效，却拦不住已经先跑完的「回春」(2.1)。
        daoQueue.push({
          seat: p.seat, daoId: a.daoId, order: daoOrder(a.daoId), atoms, entry,
        });
      }
      p.hand = p.hand.filter((id) => id !== a.daoId);
      // R80：没有真正穿到身上的（神通/神策用掉、装备被封）都回公共牌库 —— 整场一副，牌池要转得起来
      if (!equipped) returnDao(m, a.daoId);
    }
  }

  // 被强制攻击者快照（上一回合被借刀杀人标记的人）
  const forcedState = new Map();
  for (const p of m.players) {
    if (p.forcedAttackThisTurn) forcedState.set(p.seat, p.forcedAttackBy ?? -1);
  }

  const ctx = {
    m, acts: act, attacks: [], defenses: [], charges: [], explodes: [],
    answers, ev, flags: {}, forcedState,
    prompts: options.prompts || null,          // 联机：收集"要问谁什么"
    daoQueue,                                  // R46：道牌执行队列（按 order）
    // 本回合已被"有效攻击"打中过的人。R06²：无论几个人打中你，
    // 基础伤害只结算一次；吸能量 / 增伤这类附加效果照常叠加。
    struck: new Set(),
    hit: (target, amount, source, opts) => hit(m, target, amount, source, opts),
    // R64：special.mjs 不能反向 import engine（会循环依赖），需要的查询函数从 ctx 递进去
    costFor: (target, id) => costFor(m, target, id),
    playable: (target) => playableCards(m, target),
  };

  // ---------- 2. 上回合被封印 ----------
  for (const [seat, a] of act) {
    if (a.p.bannedNextTurn) {
      a.void = true;
      a.p.bannedNextTurn = false;
      ev.push({ t: "sealed", seat });
    }
  }

  // ---------- 3. 结算前改写（术牌自己的 PRE 效果） ----------
  // R46：道牌不再混在这里——它们的 PRE 效果改由 order 队列统一调度（见 3.6）。
  for (const [seat, a] of act) {
    if (a.void) continue;
    for (const at of D.atomsOf(a.card.id)) {
      const fn = S.PRE[at.atom];
      if (fn) fn(ctx, seat, a.card, at);
    }
  }

  // ---------- 3.6 道牌档 ①②③：判定之前（R46）----------
  // 排在"改写出牌本身"之后、归纳各家牌之前，所以偷天换日换完的牌会进入后面的数值计算。
  for (const it of orderedDao(daoQueue, true)) runDao(ctx, it);

  // ---------- 4. 归纳本回合各家的牌 ----------
  for (const [seat, a] of act) {
    if (a.void) continue;
    const { p, card } = a;
    if (D.isAttack(card)) {
      let v = a.base;
      v = applyAttackValueMods(m, p, v);
      ctx.attacks.push({ p, card, base: a.base, value: v });
    } else if (D.isDefense(card)) {
      const inf = D.atomsOf(card.id).some((x) => x.atom === "thresholdInf");
      ctx.defenses.push({ p, card, threshold: inf ? INF : toU(card.def ?? 0) });
    } else if (D.isCharge(card)) {
      ctx.charges.push({ p, card, blocked: false });
    } else if (D.isExplode(card)) {
      if (m.turn >= 2) ctx.explodes.push({ p, card, value: p.hp });
    }
  }

  // ---------- 4.5 数值类改写（五雷 / 太极开天门 / 复制） ----------
  for (const [seat, a] of act) {
    if (a.void) continue;
    for (const at of D.atomsOf(a.card.id)) {
      const fn = S.VALUE[at.atom];
      if (fn) fn(ctx, seat, a.card, at);
    }
  }

  // ---------- 5. 胜者线（自爆不参与）----------
  // R06（修订）：并列最高只表示「并列者之间互不相伤」，胜者线照常成立，
  // 其余人照样拿自己的阈值去比——防御低、没防御、纯蓄力的人照样被命中扣血。
  let winnerLine = null;
  let tied = false;
  if (ctx.attacks.length) {
    const max = Math.max(...ctx.attacks.map((a) => a.value));
    tied = ctx.attacks.filter((a) => a.value === max).length > 1;
    winnerLine = max;
    ev.push({ t: "line", value: fmt(max), tied });
  }

  // ---------- 6. 防御 → 命中 ----------
  for (const p of aliveList(m)) {
    const def = ctx.defenses.find((d) => d.p.seat === p.seat);
    let th = def ? def.threshold : 0;
    if (m.buffs.defBuffTurns > 0) th += m.buffs.defBuff;
    if (!def) {
      const charging = ctx.charges.some((c) => c.p.seat === p.seat);
      const bonus = hasEquipAtom(m, p, "chargeThreshold").reduce((s, a) => s + toU(a.amount || 0), 0);
      if (charging && bonus) th += bonus;
    }
    if (winnerLine == null) continue;
    const win = ctx.attacks.find((a) => a.value === winnerLine);
    if (!win) continue;
    // 站在胜者线上的攻击者（并列时是这一整批）互不相伤；线以下的人照常挨打
    if (ctx.attacks.some((a) => a.value === winnerLine && a.p.seat === p.seat)) continue;
    const forcedBy = ctx.forcedState.get(win.p.seat);
    if (forcedBy !== undefined) {
      // R27：被强制出手的攻击，对施术者及其队友无效，对其他人（含自己的队友）全部生效
      const caster = m.players[forcedBy];
      if (caster && caster.factionId === p.factionId) continue;
    } else if (win.p.factionId === p.factionId) {
      continue;
    }

    const down = hasEquipAtom(m, p, "incomingAtkDown")
      .reduce((s, a) => s + toU(a.amount || 0), 0);
    const reduced = Math.max(0, win.value - down);
    const pierce = D.atomsOf(win.card.id).some((a) => a.atom === "pierceDef");
    const defEntry = def ? act.get(p.seat) : null;
    const defOpen = def && D.atomsOf(def.card.id).some((a) => a.atom === "defPierceable")
      && !(defEntry && defEntry.patched);

    let breaks;
    if (th === INF) {
      breaks = win.value < toU(2);
    } else if (pierce && defOpen) {
      breaks = true;
    } else {
      breaks = reduced > th;
    }
    if (breaks) {
      const hurt = def ? D.atomsOf(def.card.id).find((a) => a.atom === "healOnHurt") : null;
      if (hurt) {
        const [lo, hi] = hurt.healEnergy || [1, 2];
        p.energy += toU(lo) + m.rng.int(Math.max(1, toU(hi - lo) + 1));
      }
      const drain = D.atomsOf(win.card.id).find((a) => a.atom === "drainEnergyPerHit");
      if (drain && p.energy > 0) {
        const amt = Math.min(p.energy, toU(drain.amount || 1));
        p.energy -= amt;
        win.p.energy += amt;
      }
      // 基础伤害封顶：同一个人一回合被多少术打中都只吃 1 血的基础部分
      const repeat = ctx.struck.has(p.seat);
      const base = repeat ? 0 : toU(1);
      ctx.struck.add(p.seat);
      hit(m, p, base, win.p, { kind: "attack", attackValue: reduced });
      win.p.roundStats.hits += 1;
      ev.push({
        t: "hit", target: p.seat, by: win.p.seat, value: fmt(reduced),
        threshold: th === INF ? "∞" : fmt(th), repeat,
      });
    }
  }

  // ---------- 7. 判定失败 ----------
  // R58：「判定失败」和「被有效攻击打中」说的是同一件事的两面 —— 出攻击的人防御恒为 0，
  // 而有效攻击至少是 1，所以只要没站在胜者线上，这两条必然同时成立。
  // 从前两条各扣 1，等于同一个事实罚两次（实测 302/302 次判定失败都同时被命中，恒定 −2 血）。
  // 现在合并：一回合内由术牌攻击造成的基础掉血封顶 1 血，判定失败与受击共用这个额度（R36 扩展）。
  // 站在胜者线上的人本来就不判失败，不受影响。
  const lineValue = ctx.attacks.length ? Math.max(...ctx.attacks.map((a) => a.value)) : null;
  if (lineValue != null) {
    for (const a of ctx.attacks) {
      if (a.value >= lineValue) continue;
      const already = ctx.struck.has(a.p.seat);     // 已经被有效攻击打过 → 这一滴不再重复扣
      if (!already) {
        hit(m, a.p, toU(1), null, { kind: "judgeFail" });
        ctx.struck.add(a.p.seat);
      }
      ev.push({ t: "fail", seat: a.p.seat, merged: already });
    }
  }

  // ---------- 7.5 反弹 ----------
  for (const [seat, a] of act) {
    if (a.void) continue;
    const refl = D.atomsOf(a.card.id).find((x) => x.atom === "reflect" && x.capSource === "atk");
    if (!refl) continue;
    const cap = toU(a.card.atk ?? 0);
    for (const atk of ctx.attacks) {
      if (atk.p.factionId === a.p.factionId) continue;
      if (atk.value <= cap) {
        // 反弹也算"被有效攻击"，同样受每人每回合 1 血的基础封顶约束
        const repeat = ctx.struck.has(atk.p.seat);
        const base = repeat ? 0 : toU(1);
        ctx.struck.add(atk.p.seat);
        hit(m, atk.p, base, a.p, { kind: "reflect" });
        ev.push({ t: "reflect", from: seat, to: atk.p.seat, cap: fmt(cap), repeat });
      }
    }
  }

  // ---------- 7.6 自爆 ----------
  for (const e of ctx.explodes) {
    for (const t of nonAllies(m, e.p)) {
      const def = ctx.defenses.find((d) => d.p.seat === t.seat);
      const th = def ? def.threshold : 0;
      const down = hasEquipAtom(m, t, "incomingAtkDown")
        .reduce((s2, a) => s2 + toU(a.amount || 0), 0);
      if (th < Math.max(0, e.value - down)) hit(m, t, e.value, e.p, { kind: "explode" });
    }
    if (hasBirthAtom(e.p, "explodeSurvive") && !e.p.flags.explodeSurvived) {
      e.p.flags.explodeSurvived = true;
      e.p.hp = toU(0.5);
    } else {
      e.p.hp = 0;
    }
    e.p.energy = 0;
  }

  // ---------- 8. 战斗类特殊效果（鲸吞等） ----------
  for (const [seat, a] of act) {
    if (a.void) continue;
    for (const at of D.atomsOf(a.card.id)) {
      const fn = S.COMBAT[at.atom];
      if (fn) fn(ctx, seat, a.card, at);
    }
  }

  // ---------- 9. 回合末 / 博弈（术牌） ----------
  // R46：术按座位走（术没有 order）；道牌单独按 order 走，见 9.5 —— 这样档 ⑤ 一定先于档 ⑥，
  // 不再受"谁座位靠前谁先结算"影响。
  for (const [seat, a] of act) {
    if (a.void) continue;
    for (const at of D.atomsOf(a.card.id)) {
      const fn = S.POST[at.atom];
      if (fn) fn(ctx, seat, a.card, at);
    }
  }

  // ---------- 9.5 道牌档 ④⑤⑥：判定之后（R46）----------
  for (const it of orderedDao(daoQueue, false)) runDao(ctx, it);

  // ---------- 10. 枪打出头鸟（上回合挂上的标记） ----------
  if (m.flags?.tallPoppy && ctx.attacks.length) {
    const max = Math.max(...ctx.attacks.map((a) => a.value));
    const tops = ctx.attacks.filter((a) => a.value === max);
    const dmg = tops.length > 1 ? toU(0.5) : toU(1);
    for (const t of tops) hit(m, t.p, dmg, null, { kind: "effect" });
    m.flags.tallPoppy = false;
    ev.push({ t: "tallPoppy", count: tops.length });
  }

  // ---------- 10.5 强制攻击的履行校验（R27）----------
  for (const [seat, by] of forcedState) {
    const q = m.players[seat];
    const a = act.get(seat);
    const didAttack = !!(a && !a.void && D.isAttack(a.card));
    if (!didAttack && q.alive) {
      q.hp -= toU(1);                       // 没能力打 / 拒绝打：扣 1 血
      ev.push({ t: "forceFail", seat, by });
    }
    q.forcedAttackThisTurn = false;
    q.forcedAttackBy = null;
  }

  // ---------- 11. 蓄力 ----------
  for (const c of ctx.charges) {
    if (c.blocked) continue;
    if (!c.p.flags.hitThisTurn) {
      let gain = Math.round((toU(1) + m.buffs.chargeBonus) * m.buffs.chargeMul);
      const birth = birthAtoms(c.p).find((x) => x.atom === "chargeBonus");
      if (birth && c.p.roundStats.charges >= (birth.afterCharges || 0)) gain += toU(birth.add || 0);
      c.p.energy += gain;
      c.p.roundStats.charges += 1;
    }
  }

  // ---------- 12. 淘汰与瓜分 ----------
  settleEliminations(m, ev);
  m.dmgLog = new Map();

  // ---------- 13. 兜底衰减 ----------
  if (m.turn >= CONFIG.decayTurnStart) {
    for (const p of aliveList(m)) p.hp -= CONFIG.decayHp;
    settleEliminations(m, ev);          // R75：衰减致死也要走统一结算（能量抵债 / 余债保留）
    ev.push({ t: "decay", turn: m.turn });
  }

  m.lastTurnCards = [...act.values()].map((x) => x.card.id);

  // R75：抽牌 / 拍卖时被天道没收的牌，补进本次事件流（那些地方拿不到 ev）
  if (m.debtSeizeLog?.length) {
    ev.push(...m.debtSeizeLog);
    m.debtSeizeLog = [];
  }

  const factions = new Set(aliveList(m).map((p) => p.factionId));
  if (factions.size <= 1) m.roundOver = true;
  return ev;
}

function applyAttackValueMods(m, p, v) {
  let out = v;
  out += m.buffs.atkAdd;                                  // 血月当空
  out += hasEquipAtom(m, p, "atkUp").reduce((s, a) => s + toU(a.amount || 0), 0);
  let mul = m.buffs.atkMul;
  for (const a of hasEquipAtom(m, p, "atkMul")) mul *= a.factor;
  if (p.selfBuffs.atkMulTurns > 0) mul *= p.selfBuffs.atkMul;
  out = Math.round(out * mul);
  return out;
}


// ---------- 拍卖（7.7）----------
// 触发：每局第 5 / 10 / 15… 回合「开始」，且本局未结束。
//       拍卖是这些回合的第一个环节，排在天机判断之前 —— 出价时大家手上的能量还没被本回合消耗掉。
// 出价单位：整点能量。半点不能出价 —— 上限 = floor(能量 / 2)，剩下不到 1 点的零头留在手里。
//       下限 0（弃权）。负数 / 小数 / 超额一律夹回 [0, 上限] 的整数。
// 成交：最高价唯一 → 得牌；并列 ≥3 → 各付各价各得一张；并列 =2 或全场 0 → 流拍。
//       只有真正拿到牌的人才付钱；流拍、出价低、并列出局、供给不足，统统不扣能量。
// 先公示、后出价：拍品抽一次就固定下来（view 每次广播都会 peek，不能让它推着 rng 走）。

// startTurn 时 beginTurn 还没跑，m.turn 仍是刚结束的回合编号 → 即将开始的回合 = m.turn + 1
export const auctionTurn = (m) => m.turn + 1;

// 出价上限（点）：1 点 = 2 单位，向下取整，所以永远出不到半点
export const bidCap = (energy) => Math.max(0, Math.floor(energy / 2));

// 出价归一化：夹回 [0, 上限] 的整数
export function normalizeBid(energy, raw) {
  const n = Number(raw);
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  return Math.max(0, Math.min(bidCap(energy), v));
}

export function peekAuction(m) {
  if (m.roundOver) return null;
  const t = auctionTurn(m);
  if (t <= 0 || t % CONFIG.auctionEvery !== 0) return null;   // 只在第 5/10/15… 回合开拍
  if (m.auctionDoneTurn === t) return null;                   // 这个回合已经拍过了
  if (!m.daoDeck.length) return null;
  if (m.auctionOfferTurn === t && m.auctionOffer) return m.auctionOffer;
  m.auctionOffer = m.daoDeck[m.rng.int(m.daoDeck.length)];
  m.auctionOfferTurn = t;
  return m.auctionOffer;
}

export function auctionIfDue(m, opts = {}) {
  const ev = [];
  const id0 = opts.offerId || peekAuction(m);
  if (!id0) return ev;
  const id = id0;
  const card = D.cardById(id);
  // 本回合的拍卖已经办完，别重复。offer 是为哪个回合抽的，就以那个回合为准
  m.auctionDoneTurn = m.auctionOfferTurn >= 0 ? m.auctionOfferTurn : auctionTurn(m);
  ev.push({ t: "auction", cardId: id, name: card.name, category: card.category, text: card.text });

  const bids = aliveList(m).map((p) => ({ p, bid: normalizeBid(p.energy, opts.bids?.[p.seat] ?? 0) }));
  const top = Math.max(0, ...bids.map((b) => b.bid));
  const shown = bids.map((b) => ({ seat: b.p.seat, bid: b.bid }));   // 事件里只带座位与出价，别把玩家对象发出去
  if (top <= 0) {
    ev.push({ t: "auctionResult", kind: "unsold", bids: shown, reason: "noBid" });
    return ev;
  }

  let winners = bids.filter((b) => b.bid === top);
  if (winners.length === 2) {
    ev.push({ t: "auctionResult", kind: "unsold", bids: shown, reason: "tie2" });
    return ev;
  }

  // 供给不足：并列人数 > 该种剩余张数 → 按座位顺序先到先得，其余的人不扣能量
  const copies = m.daoDeck.filter((x) => x === id).length;
  if (winners.length > copies) {
    winners = winners.slice(0, copies);
    ev.push({ t: "auctionShort", copies });
  }

  for (const w of winners) {
    const pay = normalizeBid(w.p.energy, w.bid);    // 只扣整点，且不超过手上现有的能量
    if (pay <= 0) continue;
    w.p.energy -= toU(pay);
    takeFromDeck(m, id);
    if (!seizeForDebt(m, w.p, id)) {     // R75：欠天道的，拍到的牌直接被没收（钱照付）
      w.p.hand.push(id);
      trimHand(m, w.p);
    }
    // 神装可立即装备，不占本回合道牌使用次数
    const isEquip = card.category === "神装牌";
    if (isEquip && m.buffs.equipDisabledTurns === 0 && opts.autoEquip !== false) {
      w.p.hand = w.p.hand.filter((x) => x !== id);
      if (w.p.equip.length >= CONFIG.equipmentSlots) returnDao(m, w.p.equip.shift());   // R80：被挤掉的回库
      w.p.equip.push(id);
    }
    ev.push({ t: "auctionWin", seat: w.p.seat, bid: pay, cardId: id });
  }
  ev.push({ t: "auctionResult", kind: "sold", bids: shown, winners: winners.map((w) => w.p.seat) });
  return ev;
}

function takeFromDeck(m, id) {
  const i = m.daoDeck.indexOf(id);
  if (i >= 0) m.daoDeck.splice(i, 1);
}

// ---------- 身世的"非出牌操作"（R74：改成可实时重复执行）----------
//
// 平民子弟（convert）：1 血 ↔ 2 能量；杏林世家（buyHeal）：2 能量 → 一张治疗牌。
// 以前这些只能在提交出牌时一起报（freeOps），现在是**独立动作**：
// 服务端在出牌阶段随时调用它，玩家点一下服务器就改一次，血/能立刻变。
// 规则约束：
//   · 血换能时血量不能掉到 0（至少留 1 点）—— 否则等于自杀；
//   · 能换血时不能超过血量上限；
//   · 两个方向都可以反复做，来回换算（不是一次性）。
export function applyFreeOp(m, seat, op) {
  const p = m.players[seat];
  if (!p || !p.alive) return { ok: false, msg: "你已被淘汰" };
  // R76：平民子弟的血能兑换从第 3 回合起才开放（前两回合都没能量，能换等于白送启动资金）
  if ((op === "convertToHp" || op === "convertToEnergy") && m.turn < CONFIG.convertFromTurn) {
    return { ok: false, msg: `第 ${CONFIG.convertFromTurn} 回合起才能兑换` };
  }
  const has = (atom) => birthAtoms(p).some((a) => a.atom === atom);
  if (op === "convertToEnergy") {
    if (!has("convert")) return { ok: false, msg: "你没有这个身世天赋" };
    if (p.hp <= toU(1)) return { ok: false, msg: "血量至少要留 1 点，不能再换" };
    p.hp -= toU(1);
    p.energy += toU(2);
    return { ok: true, op, hp: -toU(1), energy: toU(2) };
  }
  if (op === "convertToHp") {
    if (!has("convert")) return { ok: false, msg: "你没有这个身世天赋" };
    if (p.energy < toU(2)) return { ok: false, msg: "能量不足（需要 2 点）" };
    if (p.hp >= p.maxHp) return { ok: false, msg: "血量已满" };
    p.energy -= toU(2);
    p.hp = Math.min(p.maxHp, p.hp + toU(1));
    return { ok: true, op, hp: toU(1), energy: -toU(2) };
  }
  if (op === "buyHeal") {
    if (!has("buyHeal")) return { ok: false, msg: "你没有这个身世天赋" };
    if (p.energy < toU(2)) return { ok: false, msg: "能量不足（需要 2 点）" };
    p.energy -= toU(2);
    p.hand.push("synth_heal");
    return { ok: true, op, energy: -toU(2), gained: "synth_heal" };
  }
  return { ok: false, msg: "未知的操作" };
}

// ---------- 局末：术系轮抽（R72）----------
//
// 规则：一局打完，本局争夺的每一套术系由各势力**轮流挑**。
//   ① 顺序 = 淘汰越早越先挑。死在前面的先补，活到最后的最后挑。
//      存活时长相同的势力之间随机（避免座位序带来固定优势）。
//   ② 每势力只挑 1 套；已经拥有 / 已满 3 套上限的，改发 2 能量（5.5）。
//   ③ 挑走的从池子里移出；重复/超上限的**不消耗池子**，后面的势力还能拿。
//
// 引擎只提供纯函数，谁在什么时候问人是服务端的事（和 prompt 一个套路）。

export function makeSetDraft(m, ranked = null) {
  const infos = m.factions.map((f) => ({
    id: f.id,
    members: [...f.members],
    alive: f.members.some((s) => m.players[s].alive),
    survived: Math.max(...f.members.map((s) => m.players[s].roundStats.survivedTurns)),
    score: f.score,
  }));
  // R73：**活得越久越先挑**（滚雪球：死得早说明打得不好，不该再给补强）。
  // 存活势力自然排最前（survived 最大），这里的 alive 只是并列时的兜底排序。
  infos.sort((a, b) => (b.alive - a.alive) || (b.survived - a.survived));
  // 同一批次（存活时长完全相同 / 同时被淘汰）内部随机 —— 不让座位序变成优势
  const order = [];
  for (let i = 0; i < infos.length; i += 1) {
    let j = i;
    while (j + 1 < infos.length
      && infos[j + 1].alive === infos[i].alive
      && infos[j + 1].survived === infos[i].survived) j += 1;
    order.push(...m.rng.shuffle(infos.slice(i, j + 1)));
    i = j;
  }
  // R73：代表制 —— 由**最后被淘汰**的那名成员决定（死得最晚 = 打得最好）。
  // 同势力多人同时淘汰（存活回合相同）则在他们之间随机挑一个。
  for (const x of infos) {
    const turns = x.members.map((s) => m.players[s].roundStats.survivedTurns);
    const best = Math.max(...turns);
    const tied = x.members.filter((s) => m.players[s].roundStats.survivedTurns === best);
    x.rep = tied.length ? m.rng.pick(tied) : x.members[0];
    x.repSurvived = best;
  }
  return {
    order: order.map((x) => x.id),
    info: Object.fromEntries(order.map((x) => [x.id, x])),
    pool: [...m.pool],
    rounds: [...m.pool],          // 本局一共争几套（展示用）
    picks: [],
    idx: 0,
    ranked: (ranked || []).map((r, i) => ({ rank: i + 1, factionId: r.f.id })),
  };
}

// 下一个该挑的势力（没人了就 null）
export function nextDraftFaction(m) {
  const d = m.setDraft;
  if (!d) return null;
  return d.idx < d.order.length ? d.order[d.idx] : null;
}

// 替某个势力挑一套。setId 为空 / 不在池子里 -> 随机（超时就用这个）。
export function applySetPick(m, factionId, setId = null) {
  const d = m.setDraft;
  if (!d) return null;
  if (d.order[d.idx] !== factionId) return null;          // 没轮到它
  const f = m.factions.find((x) => x.id === factionId);
  if (!f) return null;

  const pool = d.pool;
  let sid = null;
  let note = "picked";
  if (!pool.length) {
    note = "empty";                                        // 池子空了（术集数 < 势力数）
  } else {
    sid = pool.includes(setId) ? setId : m.rng.pick(pool);
    if (f.sets.includes(sid) || f.sets.length >= CONFIG.maxSets) {
      note = "convert";                                    // 5.5：重复/超上限 -> 转 2 能量
      for (const s of f.members) m.players[s].energy += toU(2);
    } else {
      f.sets.push(sid);
      pool.splice(pool.indexOf(sid), 1);
      for (const s of f.members) m.players[s].sets = [...f.sets];
    }
  }
  // R73：代表 = 最后被淘汰的那个人（同时淘汰则随机挑的一个）
  const rep = d.info?.[factionId]?.rep ?? f.members[0];
  const pick = { factionId, seat: rep, members: [...f.members], setId: sid, note };
  d.picks.push(pick);
  d.idx += 1;
  return pick;
}

// 一把梭（引擎单测 / 平衡探针 / 没有真人时走这条）
export function autoDraftAll(m) {
  const out = [];
  for (let guard = 0; guard < 32; guard += 1) {
    const fid = nextDraftFaction(m);
    if (fid === null) break;        // 注意：势力 id 可能是 0，不能用 !fid
    const r = applySetPick(m, fid, null);
    if (!r) break;
    out.push(r);
  }
  return out;
}

// 投影给界面的轮抽状态（谁先挑、挑了什么、池子还剩什么）
export function draftStateOf(m) {
  const d = m.setDraft;
  if (!d) return null;
  const picked = new Map(d.picks.map((p) => [p.factionId, p]));
  return {
    order: d.order.map((id) => {
      const info = d.info[id] || { members: [], survived: 0, alive: false };
      const p = picked.get(id);
      return {
        factionId: id,
        members: info.members,
        survived: info.survived,
        alive: !!info.alive,
        rep: info.rep,                       // R73：由谁决定
        repSurvived: info.repSurvived ?? info.survived,
        setId: p?.setId ?? null,
        note: p?.note ?? null,
        state: p ? "done" : (d.order[d.idx] === id ? "current" : "wait"),
      };
    }),
    pool: [...d.pool],
    total: d.rounds.length,
    idx: d.idx,
    current: d.order[d.idx] ?? null,
    picks: d.picks.map((p) => ({ ...p })),
  };
}

// ---------- 局末 ----------

export function endRound(m, opts = {}) {
  // 势力存活时长 = 最后一名成员被淘汰的回合数（同盟：最后一人倒下才算灭亡）
  const rows = m.factions.map((f) => ({
    f,
    alive: f.members.some((s) => m.players[s].alive),
    survived: Math.max(...f.members.map((s) => m.players[s].roundStats.survivedTurns)),
    kills: f.members.reduce((a, s) => a + (m.players[s].roundStats.kills || 0), 0),
  }));
  rows.sort((a, b) => (b.alive - a.alive) || (b.survived - a.survived));

  // R16：存活状态与存活时长都相同的势力 -> 随机
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && g.survived === r.survived && g.alive === r.alive) g.list.push(r);
    else groups.push({ survived: r.survived, alive: r.alive, list: [r] });
  }
  const ranked = [];
  for (const g of groups) ranked.push(...m.rng.shuffle(g.list));

  const N = m.factions.length;
  ranked.forEach((r, i) => {
    const rank = i + 1;
    const base = N - rank + (rank === 1 ? 2 : 0) + r.kills;
    const weighted = m.roundIndex === CONFIG.finalRoundIndex ? base * 2 : base;
    r.f.score += weighted;
    r.f.lastRoundScore = weighted;
    for (const s of r.f.members) {
      m.score[s] += weighted;         // 9.4：势力共享名次分与胜者加成
      m.players[s].lastRoundScore = weighted;
    }
  });

  // 7.2：胜者 +1 张道牌（终局期 +2）；同盟内每名存活成员各得一张
  const winner = ranked[0];
  if (winner) {
    const bonus = m.roundIndex === CONFIG.finalRoundIndex ? 2 : 1;
    for (const s of winner.f.members) {
      const q = m.players[s];
      if (!q.alive) continue;
      for (let i = 0; i < bonus; i++) drawDao(m, q);
    }
  }

  // R75：胜者豁免 —— 活到最后的势力成员不用还；**已淘汰的队友照还**（他们淘汰时已经清算过）。
  // 这里显式清零，因为债务现在跨局保留，不清就会带进下一局。
  m.debtForgiven = [];
  if (winner) {
    for (const s of winner.f.members) {
      const q = m.players[s];
      if (!q.alive || !(q.debt > 0)) continue;
      m.debtForgiven.push({ seat: s, amount: fmt(q.debt) });
      q.debt = 0;
    }
  }

  // 挑术集（R19/R35：归势力、队内共享、每势力 1 套）
  // R72：不再是"静默随机派发" —— 改成建一个**轮抽**，由服务端按顺序逐个问。
  // 顺序 = 淘汰越早越先挑（死得早的补一手），存活势力排在最后。
  m.setDraft = makeSetDraft(m, ranked);
  if (opts.autoDraft !== false) autoDraftAll(m);

  m.roundIndex += 1;
  if (m.roundIndex >= CONFIG.rounds) m.matchOver = true;
  return ranked;
}

// ---------- 联机支持：预演 ----------
//
// 服务端需要"先问再算"：揭示之后要问玩家"符咒指谁"，而 prompt 清单只能由结算过程产生。
// 做法是克隆一份状态、用空答案干跑一次，把 ctx.prompts 收集下来；
// 因为两侧的随机序列完全一致（rng 状态被一起复制），prompt id 也就一一对应。
//
// 这是纯函数式的最小代价：不需要把引擎改成协程/回调，也不需要给每张牌写"预检"。

export function cloneMatch(m) {
  const { rng, ...rest } = m;
  const copy = structuredClone(rest);
  copy.rng = makeRng(rng.state());     // 同一状态 -> 同一序列
  return copy;
}

// ---------- 协同型天机（天之赌场 / 赊天）：R53 前移到「出牌之前」执行 ----------

function tianjiCtx(m, extra = {}) {
  return {
    m, ev: extra.ev || [], answers: extra.answers || {}, prompts: extra.prompts || null,
    acts: new Map(), attacks: [], defenses: [], charges: [], explodes: [], forcedState: new Map(),
  };
}

// 联机：先在克隆上干跑一遍收集"要问谁什么"，问完再真跑（与 collectPrompts 同一套路）
export function collectTianjiPrompts(m, tianjiId) {
  let copy;
  try { copy = cloneMatch(m); } catch { return []; }
  const sink = [];
  try {
    S.applyPendingTianji(tianjiCtx(copy, { prompts: sink }), { id: tianjiId });
  } catch {
    return [];                      // 干跑失败不阻塞，走兜底答案
  }
  return sink;
}

export function applyPendingTianjiNow(m, tianjiId, answers = {}, ev = []) {
  if (!m.pendingTianji) return ev;
  S.applyPendingTianji(tianjiCtx(m, { answers, ev }), { id: tianjiId });
  m.pendingTianji = null;
  return ev;
}

// R44：执行被「窥天」嫁接过的天机。graft = { from, to }；from === to 或没给 → 按原样生效。
export function applyGraftedTianji(m, graft = null, ev = []) {
  const g = m.pendingGraft;
  if (!g) return ev;
  const ok = graft && Number.isInteger(graft.from) && Number.isInteger(graft.to) && graft.from !== graft.to;
  if (ok) ev.push({ t: "graft", holder: g.holder, from: graft.from, to: graft.to, tianji: g.id });
  const sub = [];                    // 天机本身的子事件（发牌等）排在意向之后
  applyTianji(m, D.cardById(g.id), ok ? { from: graft.from, to: graft.to } : null, sub);
  ev.push(...sub);
  m.pendingGraft = null;
  settleEliminations(m, ev);          // R60：天机扣死的人当场出局（先记嫁接、再记出局）
  return ev;
}

// 联机：给窥天持有者收「搬谁的份 / 嫁接到谁」
export function graftPromptSpecs(m, holder) {
  const pool = aliveList(m).map((p) => p.seat);
  return [
    { id: `graft_from_${holder}`, type: "target", seat: holder,
      label: "把谁的那一份搬走？（他会完全不受这道天机影响）", pool, count: 1 },
    { id: `graft_to_${holder}`, type: "target", seat: holder,
      label: "嫁接到谁身上？（他会吃到两份：自己那份 + 搬来的那份）", pool, count: 1 },
  ];
}

// 返回 [{ seat, id, type, label, options, pool, count, total }]
export function collectPrompts(m, actions, options = {}) {
  let copy;
  try { copy = cloneMatch(m); } catch { return []; }
  const sink = [];
  try {
    resolveTurn(copy, structuredClone(actions), {
      freeOps: options.freeOps ? structuredClone(options.freeOps) : undefined,
      reactions: options.reactions ? structuredClone(options.reactions) : undefined,
      answers: {},
      prompts: sink,
    });
  } catch {
    return [];                          // 干跑失败不阻塞出牌，走兜底答案
  }
  return sink;
}
