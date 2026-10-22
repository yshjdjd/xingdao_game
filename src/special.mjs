// 特殊牌处理器。按"原子名"分发，不认牌名。
// ctx = { m, acts, attacks, defenses, charges, explodes, answers, ev }
// 四个挂点：PRE（结算前改写/取消）→ VALUE（算胜者线前）→ COMBAT（命中后）→ POST（回合末/博弈）
import { ask, makePrompt } from "./prompts.mjs";
import { toU, fmt } from "./units.mjs";
import * as D from "./data.mjs";

const enemies = (m, p) => m.players.filter((q) => q.alive && q.factionId !== p.factionId && !q.immuneDao);

function voidAct(ctx, seat, why) {
  const a = ctx.acts.get(seat);
  if (!a || a.void) return;
  a.void = true;
  ctx.ev.push({ t: "void", seat, by: a.card.id, why });
}

export function thresholdOf(ctx, q) {
  const d = ctx.defenses.find((x) => x.p.seat === q.seat);
  let th = d ? d.threshold : 0;
  if (ctx.m.buffs.defBuffTurns > 0) th += ctx.m.buffs.defBuff;
  return th;
}

// ---------------- PRE ----------------

export const PRE = {
  // R64 replay（档 1.1）：揭示之后、其它效果之前，把这一手换成另一张术。
  // 额度锁死在"首出那张术付了多少费"，不能借机升档；列表第一个是原牌，所以没作答就等于不换。
  replay(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const a = ctx.acts.get(seat);
    if (!a || a.void) return;
    const cap = a.cost || 0;
    const pool = [a.card.id, ...ctx.playable(p).filter(
      (id) => id !== a.card.id && D.isImplemented(id) && ctx.costFor(p, id) <= cap
    )];
    const spec = makePrompt("card", {
      id: `replay_${seat}`,
      label: `可换一张术（费用 ≤ ${fmt(cap)}；第一张是原牌，选它就等于不换）`,
      pool,
    });
    const pick = ask(ctx, seat, spec);
    if (!pick || pick === a.card.id) return;
    const card = D.cardById(pick);
    const cost = ctx.costFor(p, pick);
    if (!card || cost > cap) return;                 // 兜底：绝不越权
    p.energy += cap;                                  // 退掉原来那张的费用
    p.energy -= cost;                                 // 收新牌的费用
    p.hand = p.hand.filter((id) => id !== pick);      // 换上的术从手牌走（如果有）
    a.card = card;
    a.base = toU(card.atk ?? 0);                      // 强化（craft）不带过来
    a.cost = cost;
    ctx.ev.push({ t: "replay", seat, from: pool[0], to: pick });
  },

  // 令某人本回合术无效，并在下回合被禁用
  banCard(ctx, seat) {
    const p = ctx.m.players[seat];
    const spec = makePrompt("target", {
      id: `ban_${seat}`, label: "选择一个敌方目标，令其本回合术无效并在下回合被禁用",
      pool: enemies(ctx.m, p).map((q) => q.seat),
    });
    const target = ask(ctx, seat, spec);
    if (target == null) return;
    voidAct(ctx, target, "banCard");
    ctx.m.players[target].bannedNextTurn = true;
    ctx.ev.push({ t: "ban", by: seat, target });
  },

  // 令本回合所有非友方的术失效，且本局不可再用
  banAllEnemies(ctx, seat) {
    const p = ctx.m.players[seat];
    for (const q of enemies(ctx.m, p)) {
      const a = ctx.acts.get(q.seat);
      if (!a || a.void) continue;
      voidAct(ctx, q.seat, "banAllEnemies");
      if (!ctx.m.bannedCardsThisRound.includes(a.card.id)) ctx.m.bannedCardsThisRound.push(a.card.id);
    }
  },

  // 每个其他存活者二选一：本回合术失效 / 道牌失效
  lockSpirit(ctx, seat) {
    const p = ctx.m.players[seat];
    for (const q of enemies(ctx.m, p)) {
      const a = ctx.acts.get(q.seat);
      if (!a) continue;
      const spec = makePrompt("branch", {
        id: `lock_${q.seat}`, label: "本回合术失效，还是道牌失效？", options: ["术", "道"],
      });
      const pick = ask(ctx, q.seat, spec);
      if (pick === "术") voidAct(ctx, q.seat, "lockSpirit");
      else if (a.daoId) a.daoVoid = true;
    }
  },

  // 公开手牌：信息类，离线无机制影响
  // 天下大白（R59）：本回合打出，**下一回合**全员道牌公示一回合。
  // 记成绝对回合号，不用计数器 —— 省得跟回合开始时的 buff 衰减打架。
  revealHands(ctx) {
    ctx.m.flags.revealHandUntilTurn = (ctx.m.turn || 0) + 1;
    ctx.ev.push({ t: "revealHands", untilTurn: ctx.m.flags.revealHandUntilTurn });
  },
};

// ---------------- VALUE ----------------

export const VALUE = {
  // 每实际造成伤害 +1 并重新核算 → 不动点逼近
  perHitAtkUp(ctx, seat, card, atom) {
    const p = ctx.m.players[seat];
    const a = ctx.attacks.find((x) => x.p.seat === seat);
    if (!a) return;
    let v = a.value;
    for (let i = 0; i < 6; i++) {
      const hits = enemies(ctx.m, p).filter((q) => v > thresholdOf(ctx, q)).length;
      const next = a.base + toU(atom.perHit || 1) * hits;
      if (next === v) break;
      v = next;
    }
    a.value = v;
  },

  // 把场上非友方的攻击数值总和重新分配为 攻击/回血/防御
  allocate(ctx, seat, card) {
    const p = ctx.m.players[seat];
    const total = ctx.attacks.filter((x) => x.p.factionId !== p.factionId)
      .reduce((s, x) => s + x.value, 0);
    if (!total) return;
    const spec = makePrompt("allocate", {
      id: `alloc_${seat}`, label: `可分配 ${fmt(total)} 点：攻击 / 回血 / 防御`, total,
    });
    const ans = ask(ctx, seat, spec);
    const atk = Math.min(total, ans.attack || 0);
    const heal = Math.min(total - atk, ans.heal || 0);
    const def = Math.max(0, total - atk - heal);
    if (atk > 0) ctx.attacks.push({ p, card, base: atk, value: atk, from: "allocate" });
    if (heal) p.hp = Math.min(p.maxHp, p.hp + heal);
    const own = ctx.defenses.find((d) => d.p.seat === seat);
    if (own) own.threshold = Math.max(own.threshold, def);
    else ctx.defenses.push({ p, card, threshold: def, from: "allocate" });
  },

  // 治疗：可对任何人（含自己）
  healTarget(ctx, seat, card, atom) {
    const m = ctx.m;
    const spec = makePrompt("target", {
      id: `heal_${seat}`, label: `回复 ${atom.amount || 1} 点血，选一名目标（默认自己）`,
      // R63：把施放者排在第一个 —— 没作答时 defaultAnswer 取 pool[0]，这样默认奶的是自己，
      // 不会出现"我打回春结果治了对面"。
      pool: [seat, ...m.players.filter((q) => q.alive && q.seat !== seat).map((q) => q.seat)],
    });
    const t = ask(ctx, seat, spec) ?? seat;
    const q = m.players[t];
    q.hp = Math.min(q.maxHp, q.hp + toU(atom.amount || 1));
    ctx.ev.push({ t: "healCard", by: seat, to: t });
  },

  // 复制他人本回合的术（本局可用）
  copyAction(ctx, seat, card) {
    const p = ctx.m.players[seat];
    const pool = enemies(ctx.m, p)
      .map((q) => ({ seat: q.seat, card: ctx.acts.get(q.seat)?.card }))
      .filter((x) => x.card && !ctx.acts.get(x.seat).void);
    if (!pool.length) return;
    const spec = makePrompt("card", {
      id: `copy_${seat}`, label: "选择一张本回合他人使用的术进行复制",
      pool: pool.map((x) => x.card.id),
    });
    const pick = ask(ctx, seat, spec);
    const src = pool.find((x) => x.card.id === pick) || pool[0];
    const copied = src.card;
    p.tempCards = p.tempCards || [];
    if (!p.tempCards.includes(copied.id)) p.tempCards.push(copied.id);
    if (copied.type === "御术") {
      const th = toU(copied.def ?? 0);
      const own = ctx.defenses.find((d) => d.p.seat === seat);
      if (own) own.threshold = Math.max(own.threshold, th);
      else ctx.defenses.push({ p, card, threshold: th, from: "copy" });
    }
    ctx.ev.push({ t: "copy", by: seat, card: copied.id });
  },
};

// ---------------- COMBAT ----------------

export const COMBAT = {
  // 全场固定伤害：可被阈值 ≥ 该数值的防御挡下（卡片备注如此）
  damageAllFixed(ctx, seat, card, atom) {
    const amount = toU(atom.amount || 0);
    for (const q of ctx.m.players.filter((x) => x.alive)) {
      if (thresholdOf(ctx, q) >= amount) continue;
      ctx.hit(q, amount, ctx.m.players[seat], { kind: "effect" });
    }
    ctx.ev.push({ t: "damageAll", amount: fmt(amount), by: seat });
  },

  // 自身无能量时，按蓄力者数量吸能；对方是防御/攻击/自爆则自己扣血（R12）
  energySteal(ctx, seat) {
    const p = ctx.m.players[seat];
    if (p.energy !== 0) return;
    const chargers = ctx.charges.filter((c) => c.p.seat !== seat && c.p.alive);
    let gained = 0;
    for (const c of chargers) { c.blocked = true; gained += toU(1); }
    p.energy += gained;
    const risky = [...ctx.acts.values()]
      .some((a) => a.p.seat !== seat && !a.void && ["御术", "攻术", "自爆"].includes(a.card.type));
    if (risky) p.hp -= toU(1);
    ctx.ev.push({ t: "stealEnergy", seat, gained: fmt(gained), hurt: risky });
  },
};

// ---------------- POST ----------------

export const POST = {
  // 同时博弈：囚徒 / 收割 / 狭路相逢 / 赌场
  subGame(ctx, seat, card, atom) {
    const m = ctx.m;
    const p = m.players[seat];
    const kind = atom.kind;
    // R69：决策期只问"你自己怎么选"，措辞写人话；别人的选择在揭示后统一公示
    // 只描述"你在选什么"，不写牌名（牌名由界面显示，src/ 里也不允许出现）
    const LABEL = {
      prisoner: "认罪，还是抵赖？",
      harvest: "押「涨」还是押「跌」？",
      chicken: "冲，还是让？",
    };
    const pickOf = (q, id, options, fallback) => {
      const spec = makePrompt("subgame", { id, label: LABEL[kind] || "请做出你的选择", options, default: fallback });
      return ask(ctx, q.seat, spec);
    };

    if (kind === "prisoner") {
      const pool = enemies(m, p).map((q) => q.seat).slice(0, atom.count || 2);
      if (pool.length < 2) return;
      const picks = pool.map((s) => [s, pickOf(m.players[s], `pri_${s}`, ["认罪", "不认罪"], "认罪")]);
      // R68：把"谁选了什么、各自得失多少"都记下来，界面要能展示过程
      const snap = new Map(pool.map((s) => [s, { hp: m.players[s].hp, en: m.players[s].energy }]));
      const byEn0 = p.energy;
      const confess = picks.filter(([, v]) => v === "认罪");
      if (confess.length === picks.length) {
        for (const [s] of picks) {
          const q = m.players[s];
          if (q.energy >= toU(2)) q.energy -= toU(2);
          else { q.hp -= toU(1); p.energy += toU(1); }
        }
      } else if (confess.length === 1) {
        const cs = confess[0][0];
        m.players[cs].energy += toU(2);
        for (const [s] of picks) {
          if (s === cs) continue;
          const q = m.players[s];
          let loss = toU(4);
          while (loss > 0 && q.energy > 0) { q.energy -= toU(0.5); loss -= toU(0.5); p.energy += toU(0.5); }
          while (loss > 0 && q.hp > 0) { q.hp -= toU(0.5); loss -= toU(0.5); p.energy += toU(0.5); }
        }
      } else {
        for (const [s] of picks) m.players[s].energy += toU(1);
      }
      const outcome = confess.length === picks.length
        ? "全员认罪：各付 2 能量（不够就扣 1 血）"
        : confess.length === 1
          ? `${m.players[confess[0][0]].name} 认罪 +2 能量，其余各被罚 4 能量（能量不够用血抵）`
          : "全员不认罪：各 +1 能量";
      ctx.ev.push({
        t: "subgame", kind, picks, outcome,
        delta: pool.map((s) => ({
          seat: s,
          hp: fmt(m.players[s].hp - snap.get(s).hp),
          energy: fmt(m.players[s].energy - snap.get(s).en),
        })),
        by: seat, byGain: fmt(p.energy - byEn0),
      });
    }

    if (kind === "harvest") {
      const all = m.players.filter((q) => q.alive && !q.immuneDao);
      const picks = all.map((q) => [q.seat, pickOf(q, `har_${q.seat}`, ["涨", "跌"], "涨")]);
      const snap = new Map(all.map((q) => [q.seat, q.energy]));
      const byEn0 = p.energy;
      const up = picks.filter(([, v]) => v === "涨").length;
      const down = picks.length - up;
      const minority = up < down ? "涨" : "跌";
      for (const [s, v] of picks) {
        const q = m.players[s];
        if (v === minority) q.energy += toU(1);
        else q.energy = Math.max(0, q.energy - toU(1));
      }
      p.energy += toU(Math.abs(up - down));
      ctx.ev.push({
        t: "subgame", kind, picks, up, down,
        outcome: `少数派「${minority}」，${up === down ? "（持平）" : `多 ${Math.abs(up - down)} 人`}`,
        delta: all.map((q) => ({ seat: q.seat, energy: fmt(q.energy - snap.get(q.seat)) })),
        by: seat, byGain: fmt(p.energy - byEn0),
      });
    }

    if (kind === "chicken") {
      const pool = enemies(m, p).map((q) => q.seat).slice(0, 2);
      if (pool.length < 2) return;
      const picks = pool.map((s) => [s, pickOf(m.players[s], `chk_${s}`, ["冲", "让"], "让")]);
      const snap = new Map(pool.map((s) => [s, { hp: m.players[s].hp, en: m.players[s].energy }]));
      const rush = picks.filter(([, v]) => v === "冲");
      if (rush.length === 2) for (const [s] of picks) m.players[s].hp -= toU(1);
      else if (rush.length === 1) m.players[rush[0][0]].energy += toU(2);
      else for (const [s] of picks) m.players[s].energy = Math.max(0, m.players[s].energy - toU(1));
      const outcome = rush.length === 2
        ? "两人都冲：各扣 1 血"
        : rush.length === 1
          ? `${m.players[rush[0][0]].name} 冲、对方让：冲者 +2 能量`
          : "两人都让：各 −1 能量";
      ctx.ev.push({
        t: "subgame", kind, picks, outcome,
        delta: pool.map((s) => ({
          seat: s,
          hp: fmt(m.players[s].hp - snap.get(s).hp),
          energy: fmt(m.players[s].energy - snap.get(s).en),
        })),
        by: seat,
      });
    }

    if (kind === "bet") {
      const all = m.players.filter((q) => q.alive);
      const bets = all.map((q) => {
        const max = Math.floor(q.energy / 2);
        const spec = makePrompt("branch", {
          id: `bet_${q.seat}`, label: "押注能量（0 表示弃权）",
          options: [0, 1, 2].filter((n) => n <= max),
        });
        const v = Number(ask(ctx, q.seat, spec)) || 0;
        q.energy -= toU(v);
        return [q.seat, v];
      });
      const total = bets.reduce((s, [, v]) => s + v, 0);
      const top = Math.max(...bets.map(([, v]) => v));
      const winners = bets.filter(([, v]) => v === top);
      const half = Math.ceil(total / 2 / winners.length);
      for (const [s] of winners) m.players[s].energy += toU(half);
      ctx.ev.push({ t: "subgame", kind: "bet", total });
    }
  },

  // 两名玩家各选"血量 / 能量"，按选择交换
  soulSwap(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const spec = makePrompt("targets", {
      id: `soul_${seat}`, label: "选两名玩家", pool: enemies(m, p).map((q) => q.seat), count: 2,
    });
    const pair = ask(ctx, seat, spec);
    if (!pair || pair.length < 2) return;
    const [a, b] = pair;
    const pick = (s) => ask(ctx, s, makePrompt("branch", {
      id: `soulpick_${s}`, label: "选血量还是能量", options: ["血量", "能量"],
    }));
    const pa = pick(a), pb = pick(b);
    const A = m.players[a], B = m.players[b];
    // R68：记录交换前后的实际数值，界面要把"过程"讲清楚
    const before = { a: { hp: A.hp, en: A.energy }, b: { hp: B.hp, en: B.energy } };
    const both = pa === pb;
    const swapHp = both ? pa === "血量" : true;
    const swapEn = both ? pa === "能量" : true;
    if (swapHp) { const t = A.hp; A.hp = Math.min(B.hp, A.maxHp); B.hp = Math.min(t, B.maxHp); }
    if (swapEn) { const t = A.energy; A.energy = B.energy; B.energy = t; }
    ctx.ev.push({
      t: "soulSwap", a, b, swapHp, swapEn, picks: [[a, pa], [b, pb]],
      before: {
        a: { hp: fmt(before.a.hp), en: fmt(before.a.en) },
        b: { hp: fmt(before.b.hp), en: fmt(before.b.en) },
      },
      after: {
        a: { hp: fmt(A.hp), en: fmt(A.energy) },
        b: { hp: fmt(B.hp), en: fmt(B.energy) },
      },
      by: seat,
    });
  },

  stealCard(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const pool = enemies(m, p).filter((q) => q.hand.length || q.equip.length);
    if (!pool.length) return;
    const spec = makePrompt("target", {
      id: `steal_${seat}`, label: "偷取一名玩家的道牌", pool: pool.map((q) => q.seat),
    });
    const t = ask(ctx, seat, spec) ?? pool[0].seat;
    const q = m.players[t];
    const bag = [...q.hand, ...q.equip];
    if (!bag.length) return;
    const id = bag[m.rng.int(bag.length)];
    q.hand = q.hand.filter((x) => x !== id);
    q.equip = q.equip.filter((x) => x !== id);
    p.hand.push(id);
    ctx.ev.push({ t: "steal", by: seat, from: q.seat, card: id });
  },

  // banSet（R59 重做）：先选一名敌方玩家，再看他**本回合打出的术**——
  //   出的是基础术 → 只封这一张基础术（比如「三阶攻击」），其余攻击照常
  //   出的是术系里的术 → 封掉他那一整套术系
  // 旧实现是"从敌方已拥有的套系里挑一个"，第 1 回合全员还没有套系，池子是空的 → 静默空放、连问都不问。
  banSet(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const foes = enemies(m, p);
    if (!foes.length) return;
    const spec = makePrompt("target", {
      id: `banset_${seat}`, label: "选择要焚毁其术牌的玩家", pool: foes.map((q) => q.seat),
    });
    const t = ask(ctx, seat, spec);
    const q = m.players[t];
    if (!q) return;
    const used = ctx.acts.get(q.seat)?.card;
    if (!used) {
      ctx.ev.push({ t: "banSet", by: seat, from: q.seat, miss: true });
      return;
    }
    const c = D.cardById(used.id);
    if (c?.kind === "set") {
      const sid = c.setId;
      m.bannedSets = [...new Set([...(m.bannedSets || []), sid])];
      m.banLog = [...(m.banLog || []), { kind: "set", id: sid, name: D.setById(sid)?.name || sid, owner: q.seat, by: seat }];
      ctx.ev.push({ t: "banSet", by: seat, from: q.seat, sid, name: D.setById(sid)?.name });
    } else if (c) {
      m.bannedBasic = [...new Set([...(m.bannedBasic || []), c.id])];
      m.banLog = [...(m.banLog || []), { kind: "card", id: c.id, name: c.name, owner: q.seat, by: seat }];
      ctx.ev.push({ t: "banBasic", by: seat, from: q.seat, cardId: c.id, name: c.name });
    }
  },

  revive(ctx, seat) {
    const m = ctx.m;
    const dead = m.players.filter((q) => !q.alive);
    if (!dead.length) return;
    const spec = makePrompt("target", {
      id: `revive_${seat}`, label: "复活一名已淘汰者", pool: dead.map((q) => q.seat),
    });
    const t = ask(ctx, seat, spec) ?? dead[0].seat;
    const q = m.players[t];
    q.alive = true;
    q.revived = true;
    q.hp = Math.min(toU(1), q.maxHp);
    q.energy = toU(1);
    m.eliminationOrder = m.eliminationOrder.filter((x) => x.seat !== q.seat);
    ctx.ev.push({ t: "revive", seat: q.seat, by: seat });
  },

  // 交换本回合打出的术（费用差 ≤ 2）
  swapActions(ctx, seat, card) {
    const m = ctx.m;
    const p = m.players[seat];
    const pool = enemies(m, p).filter((q) => {
      const a = ctx.acts.get(q.seat);
      if (!a || a.void) return false;
      return Math.abs((a.card.cost ?? 0) - (card.cost ?? 0)) <= 2;
    });
    if (!pool.length) return;
    const spec = makePrompt("target", {
      id: `swap_${seat}`, label: "与谁交换本回合的术", pool: pool.map((q) => q.seat),
    });
    const t = ask(ctx, seat, spec) ?? pool[0].seat;
    const other = ctx.acts.get(t);
    const mine = ctx.acts.get(seat);
    if (!other || !mine || other === mine) return;
    const mineCard = mine.card, mineBase = mine.base;
    mine.card = other.card; mine.base = other.base;
    other.card = mineCard; other.base = mineBase;
    ctx.ev.push({ t: "swap", a: seat, b: t });
  },

  // 下回合攻击数值最高者受伤（多人并列各 0.5）
  tallPoppy(ctx) {
    ctx.m.flags = ctx.m.flags || {};
    ctx.m.flags.tallPoppy = true;
  },

  // 铁索连环：两人承受伤害传导
  link(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const spec = makePrompt("targets", {
      id: `link_${seat}`, label: "选择两名玩家铁索相连", pool: enemies(m, p).map((q) => q.seat), count: 2,
    });
    const pair = ask(ctx, seat, spec);
    if (!pair || pair.length < 2) return;
    m.links = (m.links || []).concat([pair]);
    ctx.ev.push({ t: "link", pair });
  },

  // 强制某人下回合必须打出攻击（借刀杀人改写版：攻击是全局的，因此只约束"必须攻击"）
  forceAttack(ctx, seat) {
    const m = ctx.m;
    const p = m.players[seat];
    const spec = makePrompt("target", {
      id: `force_${seat}`, label: "指定一人下回合必须打出攻击",
      pool: enemies(m, p).map((q) => q.seat),
    });
    const t = ask(ctx, seat, spec);
    if (t == null) return;
    m.players[t].forcedAttackThisTurn = true;
    m.players[t].forcedAttackBy = seat;
    ctx.ev.push({ t: "forceAttack", seat: t, by: seat });
  },

  // 替罪：把本回合落在自己身上的负面效果转出去（本版折算为对目标 1 点伤害）
  redirect(ctx, seat) {
    const p = ctx.m.players[seat];
    if (p.redirectTo == null) return;
    const t = ctx.m.players[p.redirectTo];
    if (!t || !t.alive) return;
    t.hp -= toU(1);
    ctx.ev.push({ t: "redirectHit", from: seat, to: t.seat });
  },

  // 借贷型：按道牌与术集数量借等量能量，淘汰时未还则掉牌
  credit(ctx, seat) {
    const p = ctx.m.players[seat];
    const amount = (p.hand.length + p.equip.length + p.sets.length) * toU(1);
    if (amount <= 0) return;
    p.energy += amount;
    p.debt = (p.debt || 0) + amount;
    ctx.ev.push({ t: "credit", seat, amount: fmt(amount) });
  },
};

export const HANDLERS = { PRE, VALUE, COMBAT, POST };

// ---------------- 天机里的「当场选择」----------------
// 天机在回合开始就抽定了（beginTurn），但那一刻还没人可问。
// 押注型 / 借贷型这两种要每人表态，所以挂起到出牌结算前，跟其它追问一起收答案。

export function applyPendingTianji(ctx, card) {
  for (const a of (D.fx.cards[card.id]?.atoms) || []) {
    if (a.atom === "subGame" && a.kind === "bet") tianjiBet(ctx);
    else if (a.atom === "credit") tianjiCredit(ctx);
  }
}

// 押注型：每人自选押多少（0 = 弃权），押注最高者拿走一半，其余人平分另一半
function tianjiBet(ctx) {
  const m = ctx.m;
  const bets = [];
  for (const q of m.players.filter((x) => x.alive)) {
    const cap = Math.floor(q.energy / toU(1));        // 手里能押的点数
    if (cap <= 0) { bets.push([q.seat, 0]); continue; }
    const options = [];
    for (let n = 0; n <= Math.min(cap, 5); n++) options.push(n);
    if (cap > 5) options.push(cap);                   // 手头宽裕时还能"全押"
    const spec = makePrompt("branch", {
      id: `bet_${q.seat}`, label: `押注能量（最多 ${cap}，0 = 弃权）`, options,
    });
    const v = Math.max(0, Math.min(cap, Math.round(Number(ask(ctx, q.seat, spec)) || 0)));
    q.energy -= toU(v);
    bets.push([q.seat, v]);
  }

  const total = bets.reduce((s, [, v]) => s + v, 0);
  if (!total) {
    ctx.ev.push({ t: "subgame", kind: "bet", total: 0, winners: [], bets });
    return;
  }
  const top = Math.max(...bets.map(([, v]) => v));
  const winners = bets.filter(([, v]) => v === top).map(([s]) => s);
  // 押 0 = 弃权，不参与分成（只有真正下注的人才有资格分剩余那一半）
  const others = bets.filter(([, v]) => v > 0 && v < top).map(([s]) => s);

  // 赢家拿一半（向上取整），其余下注者平分另一半（向上取整）
  const halfA = Math.ceil(total / 2);
  const halfB = total - halfA;
  const payA = Math.ceil(halfA / winners.length) + (others.length ? 0 : halfB);
  const payB = others.length ? Math.ceil(halfB / others.length) : 0;
  for (const s of winners) m.players[s].energy += toU(payA);
  for (const s of others) m.players[s].energy += toU(payB);

  ctx.ev.push({
    t: "subgame", kind: "bet", total, top, winners, others,
    payWinner: payA, payOther: payB, bets,
  });
}

// 借贷型：按手上的道牌 / 装备 / 术集数量借等量能量，淘汰时未还清则掉牌
function tianjiCredit(ctx) {
  const m = ctx.m;
  for (const q of m.players.filter((x) => x.alive)) {
    // R75 修订：额度 = **拥有的道牌数**（手牌 + 已装载的神装，两者都是道牌）。
    // 选项直接给数字，0 就是"不借"。
    const cap = q.hand.length + q.equip.length;
    if (cap <= 0) continue;
    const options = [];
    for (let n = 0; n <= Math.min(cap, 5); n++) options.push(n);
    if (cap > 5) options.push(cap);
    const spec = makePrompt("branch", {
      id: `credit_${q.seat}`,
      label: `赊借能量（最多 ${cap} 点；淘汰时未还清要用能量/道牌抵，活到最后免除）`,
      options,
    });
    const v = Math.max(0, Math.min(cap, Math.round(Number(ask(ctx, q.seat, spec)) || 0)));
    if (!v) continue;
    q.energy += toU(v);
    q.debt = (q.debt || 0) + toU(v);
    ctx.ev.push({ t: "credit", seat: q.seat, amount: fmt(toU(v)) });
  }
}
