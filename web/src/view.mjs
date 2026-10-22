// 视角投影：把一个完整的对局状态，投影成"某个座位有权看到的那一份"。
//
// 为什么单独一层而不是直接发 state：
//   1. 引擎内部有 dmgLog / rng / seed / 手牌，任何一样泄漏都会毁掉博弈；
//   2. 客户端不该复刻规则 —— 可出牌、费用、合法性都由服务端算好再下发；
//   3. 将来观战/回放只是换一个 seat = -1 的投影，不必再写一套。
//
// 可见性口径（规则书 4.1）：血量/上限/能量/存活/术集/道牌数量/装备/身世 = 公开；
// 手牌内容、本回合尚未揭示的选择 = 私有；随机种子 = 永不公开。
import * as D from "./data.mjs";
import { playableCards, costFor, peekAuction } from "./engine.mjs";
import { fmt, toU } from "./units.mjs";
import { CONFIG } from "./config.mjs";

const PUBLIC_EVENTS = new Set([
  "line", "hit", "fail", "eliminate", "decay", "tianji", "supply", "auction",
  "auctionWin", "auctionResult", "auctionShort", "reflect", "ban", "void", "sealed",
  "copy", "swap", "stealEnergy", "damageAll", "healCard", "revive", "banSet",
  "forceFail", "forceAttack", "tallPoppy", "link", "credit", "soulSwap", "subgame",
  "convert", "buyHeal", "craft", "craftPatch", "negate", "redirect", "redirectHit",
  "bannedByPrev", "revealHands", "steal", "graft",
  "play",          // 揭示：谁打了什么（结算后公开）
  "daoGain",       // R78：谁抽了道牌（**牌名只给本人**，别人只知道"抽了 1 张"）
]);

// 事件白名单 + 去掉不该外露的字段。
// R78：daoGain 的牌名属于私有信息（道牌内容只有持有者知道），
// 给别人看时把 cardId / name 抹掉，只留"抽了 1 张"；观战视角一律抹掉。
export function publicEvents(events = [], seat = -1) {
  return events
    .filter((e) => PUBLIC_EVENTS.has(e.t))
    .map((e) => {
      const { seats: _drop, ...rest } = e;
      if (rest.t === "daoGain" && !rest.empty && rest.seat !== seat) {
        return { t: "daoGain", seat: rest.seat, cause: rest.cause, hidden: true };
      }
      return rest;
    });
}

// 持续效果 → 人话。中央「天机坛」要展示"之前回合留下的效果"，
// 所以这里不能只给布尔值，得带上剩余回合，客户端才能写「还剩 N 回合」。
const EFFECT_DEFS = [
  { key: "atkAdd", turns: "atkAddTurns", on: (b) => b.atkAdd !== 0, label: "攻击加成", kind: "atk",
    desc: (b) => `全场攻击 ${b.atkAdd > 0 ? "+" : ""}${fmt(b.atkAdd)}` },
  { key: "atkMul", turns: "atkMulTurns", on: (b) => b.atkMul !== 1, label: "攻击倍率", kind: "atk",
    desc: (b) => `全场攻击 ×${b.atkMul}` },
  { key: "defBuff", turns: "defBuffTurns", on: (b) => b.defBuff !== 0, label: "判定阈值", kind: "def",
    desc: (b) => `判定阈值 ${b.defBuff > 0 ? "+" : ""}${fmt(b.defBuff)}` },
  { key: "costMul", turns: "costMulTurns", on: (b) => b.costMul !== 1, label: "消耗倍率", kind: "cost",
    desc: (b) => `出牌消耗 ×${b.costMul}` },
  { key: "chargeBonus", turns: "chargeBonusTurns", on: (b) => b.chargeBonus !== 0, label: "蓄力加成", kind: "energy",
    desc: (b) => `每次蓄力额外 +${fmt(b.chargeBonus)}` },
  { key: "chargeMul", turns: "chargeMulTurns", on: (b) => b.chargeMul !== 1, label: "蓄力倍率", kind: "energy",
    desc: (b) => `蓄力收益 ×${b.chargeMul}` },
  { key: "noDamage", turns: "noDamageTurns", on: (b) => b.noDamageTurns > 0, label: "万法不侵", kind: "def",
    desc: () => "本回合所有攻击不造成伤害" },
  { key: "onlyBasic", turns: "onlyBasicTurns", on: (b) => b.onlyBasicTurns > 0, label: "返璞归真", kind: "ban",
    desc: () => "本回合只能使用基础术" },
  { key: "equipDisabled", turns: "equipDisabledTurns", on: (b) => b.equipDisabledTurns > 0, label: "装备封禁", kind: "ban",
    desc: () => "本回合装备（神装牌）不生效" },
  { key: "banLastTurn", turns: null, on: (b) => b.banLastTurn, label: "禁术封印", kind: "ban",
    desc: () => "本回合禁用上一回合打出过的术" },
];

// 生效中的全场持续效果（天机、道牌、术留下的都在这里）
export const activeEffects = (m) => EFFECT_DEFS
  .filter((d) => d.on(m.buffs))
  .map((d) => ({
    key: d.key,
    label: d.label,
    desc: d.desc(m.buffs),
    turns: d.turns ? Number(m.buffs[d.turns]) || 0 : 0,
    permanent: !d.turns,
  }));

const publicBuffs = (m) => ({
  atkAdd: m.buffs.atkAdd ? fmt(m.buffs.atkAdd) : null,
  atkMul: m.buffs.atkMul !== 1 ? m.buffs.atkMul : null,
  costMul: m.buffs.costMul !== 1 ? m.buffs.costMul : null,
  noDamage: m.buffs.noDamageTurns > 0,
  onlyBasic: m.buffs.onlyBasicTurns > 0,
  equipDisabled: m.buffs.equipDisabledTurns > 0,
  chargeBonus: m.buffs.chargeBonus ? fmt(m.buffs.chargeBonus) : null,
});

function publicPlayer(m, p, seat) {
  const isSelf = p.seat === seat;
  return {
    seat: p.seat,
    name: p.name,
    factionId: p.factionId,
    isAI: !!p.isAI,
    alive: p.alive,
    hp: fmt(Math.max(0, p.hp)),      // 内部允许负血用于判定，展示层夹到 0
    maxHp: fmt(p.maxHp),
    energy: fmt(p.energy),
    sets: [...p.sets],              // 术集明置
    setCount: p.sets.length,
    equip: [...p.equip],            // 装备明置
    // 身世默认公开（R48：对外信息面板要突出显示，且可点击查看天赋全文）
    birth: p.birth,
    birthName: D.cardById(p.birth)?.name || "",
    birthText: D.cardById(p.birth)?.effect || "",
    birthNote: D.cardById(p.birth)?.note || "",
    handCount: p.hand.length,       // 只给数量，不给内容
    debt: fmt(p.debt || 0),          // R75：欠天道是公开信息（借的时候全场都看着）
    bannedNextTurn: isSelf ? !!p.bannedNextTurn : undefined,
    forcedAttackThisTurn: !!p.forcedAttackThisTurn,
    // R59：临时借来的术系（官宦子弟）与公开拥有的术系一起展示，别人要看得见
    tempSets: [...(p.tempSets || [])],
    // R59：持续性状态标签（神装 / 封禁 / 天机遗留 / 护盾…），由投影层统一算好，前端只管画
    statuses: statusOf(m, p),
    // R59：阵亡的能量瓜分说明（谁拿走、各拿多少），供出局横幅显示
    deadInfo: p.alive ? undefined : deadInfoOf(m, p),
    // 天下大白生效期间，别人的道牌也要能看到具体内容
    shownHand: revealHandsNow(m) ? [...p.hand] : undefined,
  };
}

// R59：阵亡时的能量账目
function deadInfoOf(m, p) {
  const rec = (m.elimLog || []).find((x) => x.seat === p.seat);
  if (!rec) return "已出局";
  const pool = fmt(rec.pool || 0);
  if (!rec.gainers.length) return `能量 ${pool} 点未瓜分`;
  const who = rec.gainers.map((s) => (m.players[s]?.name || `#${s}`).slice(0, 4)).join("、");
  return `能量 ${pool} 点 → ${who} 各 +${fmt(rec.share)}`;
}

// 天下大白：本回合打出 → 下一回合全员道牌公示
function revealHandsNow(m) {
  const until = m.flags?.revealHandUntilTurn;
  return typeof until === "number" && (m.turn || 0) <= until;
}

// ---------- R59 状态栏 ----------
// 一条状态 = { k: 类别, label: 文字, tone: 语气, detail: 长说明（点开看） }
// 类别用来去重 / 上色：equip 神装 / tempSet 临时术系 / ban 封禁 / tianji 天机遗留 / buff 增益 / down 减益
function statusOf(m, p) {
  const b = m.buffs || {};
  const out = [];
  const add = (k, label, tone = "info", detail = "", id = null) => out.push({ k, label, tone, detail, id });

  // 已装载的神装
  for (const id of p.equip || []) {
    const c = D.cardById(id);
    if (c) add("equip", c.name, "equip", c.text || "", id);
  }
  // 天命改易：装备牌临时失效
  if (b.equipDisabledTurns > 0) {
    add("equipDown", `装备失效（剩 ${b.equipDisabledTurns} 回合）`, "down",
      `天机「${D.cardById("tj_20")?.name}」：接下来 3 回合术牌中的装备牌全部失效。`);
  }
  // 临时术系（官宦子弟）
  for (const sid of p.tempSets || []) {
    const s = D.setById(sid);
    if (s) add("tempSet", `临时术系·${s.name}`, "temp", "身世特权（tempSet）：本局临时获得的术系，不占 3 套上限。");
  }
  // 被 banSet 封掉的术系 / 基础术
  const noSet = new Set(m.bannedSets || []);
  for (const sid of p.sets || []) {
    if (!noSet.has(sid)) continue;
    const s = D.setById(sid);
    add("ban", `封禁·${s?.name || sid}`, "ban", `被「${D.cardById("dao_28")?.name}」焚毁，本局后续回合不能再打出该术系的术。`);
  }
  for (const it of p.tempSets || []) {
    if (!noSet.has(it)) continue;
    const s = D.setById(it);
    add("ban", `封禁·${s?.name || it}（临时）`, "ban", `被「${D.cardById("dao_28")?.name}」焚毁。`);
  }
  // 基础术是公共牌：一旦被焚，是全场都用不了，而不是只有被烧的那个人用不了
  for (const e of m.banLog || []) {
    if (e.kind !== "card") continue;
    add("ban", `焚毁·${e.name}`, "ban",
      `被「${D.cardById("dao_28")?.name}」焚毁。基础术是公共牌，本局后续回合全场都不能再用这张（目标是 ${m.players[e.owner]?.name || ""}）。`);
  }
  // 失落的历史：上一回合打过的术被封
  if (b.banLastTurn && (b.lastTurnCards || []).length) {
    const names = b.lastTurnCards.map((id) => D.cardById(id)?.name).filter(Boolean);
    add("ban", `上回合术牌封禁（${names.length} 张）`, "ban",
      `天机「${D.cardById("tj_24")?.name}」：上一回合所有人使用的术牌在接下来被封禁。被禁：${names.join("、")}`);
  }
  // R75：赊天的欠债（跨局保留）
  if ((p.debt || 0) > 0) {
    add("debt", `欠天道 ${fmt(p.debt)} 点`, "down",
      `「${D.cardById("tj_23")?.name}」：淘汰时先用能量还，不够就每缺 1 点掉 1 张道牌；还不上就继续欠着，之后拿到道牌会被天道直接没收。`);
  }
  // 天下太平：本回合不扣血
  if (b.noDamageTurns > 0) add("shield", "不扣血庇护", "good", `天机「${D.cardById("tj_06")?.name}」：本回合任何人不会扣血。`);
  // 天灾：能耗加倍
  if (b.costMulTurns > 0 && b.costMul > 1) {
    add("costUp", `能耗 ×${b.costMul}（剩 ${b.costMulTurns} 回合）`, "down", `天机「${D.cardById("tj_13")?.name}」：接下来的两回合能耗加倍。`);
  }
  // 天下大白：道牌公示
  if (revealHandsNow(m)) add("reveal", "道牌公示中", "info", `「${D.cardById("dao_20")?.name}」：本回合所有人的道牌公开可见。`);
  // 增益 / 限制（R61：中央不再有"遗留效果"条，剩余回合数搬到这里来）
  const left = (n) => (n > 1 && n <= 5 ? `（剩 ${n} 回合）` : "");
  if (b.atkAddTurns > 0 && b.atkAdd) add("buff", `攻击 +${fmt(b.atkAdd)}${left(b.atkAddTurns)}`, "good", "全场攻击数值提升。");
  if (b.atkMulTurns > 0 && b.atkMul !== 1) add("buff", `攻击 ×${b.atkMul}${left(b.atkMulTurns)}`, "good", "全场攻击数值倍率。");
  if (b.defBuffTurns > 0 && b.defBuff) add("buff", `防御 +${fmt(b.defBuff)}${left(b.defBuffTurns)}`, "good", "全场防御阈值提升。");
  if (b.chargeBonusTurns > 0 && b.chargeBonus) add("buff", `蓄力 +${fmt(b.chargeBonus)}`, "good", "蓄力时额外获得能量。");
  if (b.chargeMulTurns > 0 && b.chargeMul !== 1) add("buff", `蓄力 ×${b.chargeMul}${left(b.chargeMulTurns)}`, "good", "蓄力收益倍率。");
  if (b.onlyBasicTurns > 0) add("limit", "仅可用基础术", "down", "本回合只能打基础术。");
  if (p.bannedNextTurn) add("limit", "下回合术牌被封", "down", "禁术封印类效果：本回合的术无效，下回合被禁用。");
  if (p.forcedAttackThisTurn) add("limit", "被逼战", "down", `「${D.cardById("dao_29")?.name}」：本回合必须出攻击，否则扣 1 血。`);
  if (p.immuneDao) add("buff", "道牌免疫", "good", `「${D.cardById("dao_31")?.name}」：本回合免疫针对自己的道牌。`);
  return out;
}

function poolView(m) {
  return m.pool.map((sid) => {
    const s = D.setById(sid);
    return {
      id: sid,
      name: s.name,
      batch: s.batch,
      passive: s.passive,
      cards: s.cards.map((c) => ({
        id: c.id, name: c.name, type: c.type, cost: c.cost, atk: c.atk, def: c.def, text: c.text,
      })),
    };
  });
}

// seat = -1 即观战视角：没有任何私有信息
export function viewFor(m, seat, opts = {}) {
  const me = seat >= 0 ? m.players[seat] : null;

  const view = {
    v: 1,
    seed: undefined,                 // 明确不给：知道种子就能推算天机与牌堆
    turn: m.turn,
    round: m.roundIndex,
    roundOver: !!m.roundOver,
    matchOver: !!m.matchOver,
    buffs: publicBuffs(m),
    effects: activeEffects(m),
    lastTianji: m.tianji.lastId || null,
    // 天机：只给 id，牌面文案由客户端查表（天机是固定公开牌，不构成信息泄漏）
    tianji: {
      now: m.tianji.firedThisTurn ? (m.tianji.lastId || null) : null,
      last: m.tianji.lastId || null,
      since: Number(m.tianji.sinceLast) || 0,
      pity: Number(CONFIG.tianjiPity) || 0,
    },
    pool: poolView(m),
    links: (m.links || []).map((x) => [...x]),
    players: m.players.map((p) => publicPlayer(m, p, seat)),
    auction: (() => {
      const id = peekAuction(m);
      if (!id) return null;
      const c = D.cardById(id);
      return { offerId: id, name: c.name, category: c.category, text: c.text };
    })(),
    log: publicEvents(opts.events || [], seat).slice(-40),
    spectator: seat < 0,
  };

  if (me) {
    const playable = playableCards(m, me)
      .filter((id) => costFor(m, me, id) <= me.energy)
      // 3.4：自爆第 2 回合起才可用 —— 视图与引擎必须同一口径，否则会出现"能点但没效果"
      .filter((id) => !(m.turn < 2 && D.isExplode(D.cardById(id))))
      .map((id) => ({ id, cost: fmt(costFor(m, me, id)) }));
    view.me = {
      seat,
      name: me.name,
      hp: fmt(me.hp),
      maxHp: fmt(me.maxHp),
      energy: fmt(me.energy),          // 自己的资源：公开信息，给客户端省一次查表
      hand: [...me.hand],            // 只有自己的手牌
      tempCards: [...(me.tempCards || [])],
      playable,                      // 服务端算好的合法动作 + 费用
      // R49：面板要能显示"用不了的牌"（变灰、不可点），所以这里给的是**全部候选** + 可用标记。
      // 能不能点一律以服务端的 usable 为准，客户端不自己判断，避免出现"能点但没效果"。
      shuList: shuListFor(m, me),
      daoList: daoListFor(m, me),
      // R49：天赋区只在身世涉及主动决策时才出现
      birthName: D.cardById(me.birth)?.name || "",
      birthText: D.cardById(me.birth)?.effect || "",
      birthNote: D.cardById(me.birth)?.note || "",
      canAct: me.alive && !m.roundOver,
      freeOps: availableFreeOps(me, m),
      // 是否被强制攻击：前端需要提示"这回合必须出攻击"
      mustAttack: !!me.forcedAttackThisTurn,
      // 回合末弃牌判断：手牌超过血量上限时要自己挑牌弃掉（R55：已装载的神装也占位）
      discard: (() => {
        const cap = Math.max(1, Math.round(me.maxHp / 2));
        const held = me.hand.length + (me.equip?.length || 0);
        const over = held - cap;
        return over > 0 ? { over, cap, handCount: held } : null;
      })(),
    };
  }
  return view;
}

// R49：自己的术区。给出**全部候选**（基础术 + 势力术集 + 官宦子弟的临时术系），
// 逐张标出能不能用、以及为什么不能用 —— 面板据此把不能用的变灰。
function shuListFor(m, p) {
  const legal = new Set(playableCards(m, p));
  const ids = [
    ...D.raw.basic.map((c) => c.id),
    ...(p.sets || []).flatMap((sid) => (D.setById(sid)?.cards || []).map((c) => c.id)),
    ...(p.tempCards || []),
  ];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = D.cardById(id);
    if (!card) continue;
    const cost = costFor(m, p, id);
    const tooEarly = m.turn < 2 && D.isExplode(card);      // 3.4：自爆第 2 回合起
    // R59：被焚术烧掉的牌要说清楚是"本局废了"，不能笼统写成"本回合不可用"
    const burned = (m.bannedBasic || []).includes(id)
      || (card.kind === "set" && (m.bannedSets || []).includes(card.setId));
    const banned = !legal.has(id) && !burned;
    const poor = p.energy < cost;
    const usable = !burned && !banned && !tooEarly && !poor && p.alive && !m.roundOver;
    out.push({
      id, cost: fmt(cost), usable,
      reason: !p.alive ? "已淘汰" : m.roundOver ? "本局已结束"
        : burned ? "已被焚毁（本局）"
          : tooEarly ? "第 2 回合起才可用"
            : banned ? "本回合不可用"
              : poor ? `能量不足（需 ${fmt(cost)}）` : "",
    });
  }
  return out;
}

// R49：自己的道牌区。神装不能当效果打出（只能装载，见 R55），所以标成不可用。
function daoListFor(m, p) {
  const silenced = (m.buffs?.onlyBasicTurns || 0) > 0;   // R60：onlyBasic 生效期间道牌失效
  return p.hand.map((id) => {
    const card = D.cardById(id);
    const isEquip = card?.category === "神装牌";
    const usable = !isEquip && p.alive && !m.roundOver && !silenced;
    return {
      id, usable,
      reason: !p.alive ? "已淘汰"
        : m.roundOver ? "本局已结束"
          : silenced ? "本回合道牌失效（仅基础术生效）"
            : isEquip ? "神装需装载，不能当道牌打出" : "",
    };
  });
}

// 身世赋予的"非出牌操作"，由服务端声明可用性，客户端只负责画按钮
function availableFreeOps(p, m) {
  const atoms = D.atomsOf(p.birth).map((a) => a.atom);
  const out = [];
  const turnOk = (m?.turn || 0) >= CONFIG.convertFromTurn;   // R76：前两回合不能兑换
  // R74：这些操作改成"点一下立刻生效、可以反复点"，所以每一项都要给出 why（不可用原因）。
  // 注意定点数：1 点 = toU(1) = 2U。之前这里写成 `p.energy >= 2` / `p.hp > 2`
  // 是拿原始单位当点用，会让"只有 1 点能量"的人也看到可用 —— 已修。
  if (atoms.includes("convert")) {
    out.push({
      op: "convertToHp", label: "2 能量 → 1 血", repeat: true,
      enabled: turnOk && p.energy >= toU(2) && p.hp < p.maxHp,
      why: !turnOk ? `第 ${CONFIG.convertFromTurn} 回合起可用`
        : p.hp >= p.maxHp ? "血量已满" : "能量不足（需要 2 点）",
    });
    out.push({
      op: "convertToEnergy", label: "1 血 → 2 能量", repeat: true,
      enabled: turnOk && p.hp > toU(1),
      why: !turnOk ? `第 ${CONFIG.convertFromTurn} 回合起可用` : "血量至少要留 1 点",
    });
  }
  if (atoms.includes("buyHeal")) {
    out.push({
      op: "buyHeal", label: "2 能量 → 治疗牌", repeat: true,
      enabled: p.energy >= toU(2),
      why: "能量不足（需要 2 点）",
    });
  }
  return out;
}

// 自检：结构化地确认"没有别人的手牌、没有内部字段"。线上应在每次下发前跑一遍。
export function auditView(view, m, seat) {
  const problems = [];

  for (const p of view.players) {
    if ("hand" in p) problems.push(`座位 ${p.seat} 的公开信息里出现了 hand 字段`);
    if ("tempCards" in p) problems.push(`座位 ${p.seat} 的公开信息里出现了 tempCards 字段`);
    if (typeof p.handCount !== "number") problems.push(`座位 ${p.seat} 缺少 handCount`);
  }

  if (seat < 0 && "me" in view) problems.push("观战视角不应携带 me");
  if (seat >= 0) {
    if (!view.me) problems.push("玩家视角缺少 me");
    else {
      const allowed = new Set(m.players[seat].hand);
      for (const id of view.me.hand) {
        if (!allowed.has(id)) problems.push(`me.hand 出现了不属于自己的牌 ${id}`);
      }
      if (view.me.hand.length !== m.players[seat].hand.length) {
        problems.push("me.hand 与真实手牌数量不一致");
      }
    }
  }

  const json = JSON.stringify(view);
  for (const banned of ["seed", "rng", "dmgLog", "daoDeck", "answers"]) {
    if (json.includes(`"${banned}"`)) problems.push(`投影里出现了内部字段 ${banned}`);
  }
  return problems;
}
