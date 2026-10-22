// 自对弈 + 平衡报告。P0 的验收工具：
//   node cli/selfplay.mjs --matches 2000 --players 4
// 输出 reports/balance-*.md，并把关键指标打到控制台。
import fs from "node:fs";
import path from "node:path";
import { createMatch, startRound, beginTurn, resolveTurn, endRound, peekAuction, auctionIfDue } from "../src/engine.mjs";
import { chooseAction, bidFor } from "../src/ai.mjs";
import * as D from "../src/data.mjs";
import { fmt } from "../src/units.mjs";
import { CONFIG } from "../src/config.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const MATCHES = Number(arg("matches", 500));
const PLAYERS = Number(arg("players", 4));
const PER = Number(arg("per", 1));              // 每势力人数：1 = 个人模式，2 = 同盟模式
const AI = arg("ai", "l1");
const SEED0 = Number(arg("seed", 1));

const nameOf = (id) => D.cardById(id)?.name || id;

function newStats() {
  return {
    matches: 0,
    roundTurns: [],
    matchTurns: 0,
    cardUse: new Map(),
    cardUseByRound: new Map(),
    setPicked: new Map(),
    setWin: new Map(),
    tianji: new Map(),
    hits: 0,
    fails: 0,
    eliminations: 0,
    explode: 0,
    scoreBySeat: [],
    winnerScore: [],
    stalls: 0,
    roundWinners: new Map(),
    auctions: 0, auctionWin: 0, auctionUnsold: 0, auctionTie2: 0, priceSum: 0,
    daoUse: new Map(), daoWin: new Map(),
  };
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function playOneMatch(seed, stats) {
  const seats = Array.from({ length: PLAYERS }, (_, i) => ({
    name: `P${i + 1}`,
    isAI: true,
    factionId: Math.floor(i / PER),
  }));
  const m = createMatch({ seats, seed });

  for (let r = 0; r < CONFIG.rounds; r++) {
    startRound(m);
    let turns = 0;
    while (!m.roundOver && turns < CONFIG.maxTurnsPerRound) {
      // 天机门人：判定前的小窗口。AI 用简单策略：血量低时 30% 概率"来临"
      const ctl = {};
      for (const q of m.players) {
        if (!q.alive || q.tianjiUsed) continue;
        const isDoor = D.atomsOf(q.birth).some((a) => a.atom === "tianjiControl");
        if (isDoor && q.hp <= q.maxHp / 2 && m.rng.chance(0.3)) ctl[q.seat] = "来临";
      }
      const startEv = beginTurn(m, { tianji: ctl });
      for (const e of startEv) if (e.t === "tianji") bump(stats.tianji, nameOf(e.id));
      const acts = {};
      const freeOps = {};
      for (const p of m.players) {
        if (!p.alive) continue;
        const c = chooseAction(m, p, { level: AI });
        acts[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
        if (c.daoId) bump(stats.daoUse, nameOf(c.daoId));
        if (c.freeOps && c.freeOps.length) freeOps[p.seat] = c.freeOps;
        bump(stats.cardUse, nameOf(c.cardId));
        if (!stats.cardUseByRound.has(r)) stats.cardUseByRound.set(r, new Map());
        bump(stats.cardUseByRound.get(r), nameOf(c.cardId));
        const card = D.cardById(c.cardId);
        if (card.type === "自爆") stats.explode += 1;
      }
      const ev = resolveTurn(m, acts, { freeOps });
      for (const e of ev) {
        if (e.t === "hit") stats.hits += 1;
        if (e.t === "fail") stats.fails += 1;
        if (e.t === "eliminate") stats.eliminations += 1;
      }
      for (const e of ev) {
        if (e.t === "hit") stats.hits += 1;
        if (e.t === "fail") stats.fails += 1;
        if (e.t === "eliminate") stats.eliminations += 1;
      }
      // 拍卖：第 5/10/15… 回合结束
      const offer = peekAuction(m);
      if (offer) {
        const bids = {};
        for (const q of m.players) if (q.alive) bids[q.seat] = bidFor(m, q, offer);
        const aev = auctionIfDue(m, { offerId: offer, bids });
        stats.auctions += 1;
        const wins = aev.filter((e) => e.t === "auctionWin");
        if (wins.length) {
          stats.auctionWin += 1;
          for (const w of wins) stats.priceSum += w.bid;
        } else {
          stats.auctionUnsold += 1;
          if (aev.some((e) => e.t === "auctionResult" && e.reason === "tie2")) stats.auctionTie2 += 1;
        }
      }
      turns += 1;
    }
    if (!m.roundOver) stats.stalls += 1;
    stats.roundTurns.push(turns);

    const before = new Map(m.factions.map((f) => [f.id, f.sets.slice()]));
    const ranked = endRound(m);
    const winner = ranked[0];
    if (winner) {
      for (const s of winner.f.members) bump(stats.roundWinners, s);
      for (const sid of before.get(winner.f.id) || []) bump(stats.setWin, sid);
    }
    for (const f of m.factions) {
      for (const sid of before.get(f.id) || []) bump(stats.setPicked, sid);
    }
    if (m.matchOver) break;
  }

  stats.matches += 1;
  stats.matchTurns += stats.roundTurns.slice(-CONFIG.rounds).reduce((a, b) => a + b, 0);
  const rankedF = [...m.factions].sort((a, b) => b.score - a.score);
  if (!stats.scoreBySeat.length) stats.scoreBySeat = m.players.map(() => 0);
  m.players.forEach((p, i) => { stats.scoreBySeat[i] += m.score[p.seat]; });
  stats.winnerScore.push(rankedF[0] ? rankedF[0].score : 0);
  return m;
}

function pct(a, b) { return b ? ((a / b) * 100).toFixed(1) + "%" : "—"; }

function main() {
  const stats = newStats();
  for (let i = 0; i < MATCHES; i++) playOneMatch(SEED0 + i, stats);

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const totalRounds = stats.roundTurns.length;
  const lines = [];
  const P = (s = "") => { lines.push(s); console.log(s); };

  P(`# 《行道》平衡自对弈报告`);
  P();
  P(`- 生成时间：${new Date().toLocaleString("zh-CN")}`);
  P(`- 规则集：${CONFIG.ruleset}`);
  P(`- 对局数：${stats.matches}　人数：${PLAYERS}（每势力 ${PER} 人，共 ${Math.ceil(PLAYERS / PER)} 势力）　AI：${AI.toUpperCase()}`);
  P();
  P(`## 1. 节奏`);
  P();
  P(`| 指标 | 值 |`);
  P(`| --- | --- |`);
  P(`| 平均每局回合数 | ${avg(stats.roundTurns).toFixed(1)} |`);
  P(`| 最短 / 最长局 | ${Math.min(...stats.roundTurns)} / ${Math.max(...stats.roundTurns)} |`);
  P(`| 平均整场回合数 | ${(stats.matchTurns / stats.matches).toFixed(1)} |`);
  P(`| 单局触顶（>${CONFIG.maxTurnsPerRound} 回合） | ${stats.stalls} 次 |`);
  P(`| 总命中 | ${stats.hits} |`);
  P(`| 判定失败（扣血） | ${stats.fails} |`);
  P(`| 命中 : 判定失败 | ${(stats.hits / Math.max(1, stats.fails)).toFixed(2)} : 1 |`);
  P(`| 自爆使用 | ${stats.explode} 次 |`);
  P();

  P(`## 2. 基础术使用分布（前 12）`);
  P();
  P(`| 术 | 次数 | 占比 |`);
  P(`| --- | --- | --- |`);
  const totalUse = [...stats.cardUse.values()].reduce((a, b) => a + b, 0);
  [...stats.cardUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([n, c]) => P(`| ${n} | ${c} | ${pct(c, totalUse)} |`));
  P();

  P(`## 3. 术套系强度`);
  P();
  P(`| 套系 | 被持有（局次） | 持有即胜（局次） | 胜率 |`);
  P(`| --- | --- | --- | --- |`);
  const setIds = [...new Set([...stats.setPicked.keys(), ...stats.setWin.keys()])];
  setIds.sort((a, b) => (stats.setWin.get(b) || 0) / Math.max(1, stats.setPicked.get(b) || 1)
    - (stats.setWin.get(a) || 0) / Math.max(1, stats.setPicked.get(a) || 1));
  for (const sid of setIds) {
    const picked = stats.setPicked.get(sid) || 0;
    const win = stats.setWin.get(sid) || 0;
    const s = D.setById(sid);
    P(`| ${s ? s.name : sid} | ${picked} | ${win} | ${pct(win, picked)} |`);
  }
  P();

  P(`## 3.5 道牌：拍卖与使用`);
  P();
  P(`| 指标 | 值 |`);
  P(`| --- | --- |`);
  P(`| 拍卖场次 | ${stats.auctions} |`);
  P(`| 成交场次 | ${stats.auctionWin}（成交率 ${pct(stats.auctionWin, stats.auctions)}） |`);
  P(`| 流拍场次 | ${stats.auctionUnsold}（其中"两人并列" ${stats.auctionTie2}） |`);
  P(`| 平均成交价 | ${(stats.priceSum / Math.max(1, stats.auctionWin)).toFixed(1)} 能量 |`);
  P();
  P(`| 道牌使用（前 10） | 次数 |`);
  P(`| --- | --- |`);
  [...stats.daoUse.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([n, c]) => P(`| ${n} | ${c} |`));
  P();
  P(`## 4. 天机触发频次（前 10）`);
  P();
  P(`| 天机 | 次数 |`);
  P(`| --- | --- |`);
  [...stats.tianji.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .forEach(([n, c]) => P(`| ${n} | ${c} |`));
  P();

  P(`## 5. 座位 / 先手`);
  P();
  P(`| 座位 | 平均总积分 |`);
  P(`| --- | --- |`);
  stats.scoreBySeat.forEach((s, i) => P(`| P${i + 1} | ${(s / stats.matches).toFixed(2)} |`));
  P();
  P(`平均胜者积分：${avg(stats.winnerScore).toFixed(2)}`);
  P();
  P(`## 6. 已知缺口`);
  P();
  P(`- 本报告只覆盖"引擎已接入"的卡；未接入的卡在 \`node cli/coverage.mjs\` 中列出。`);
  P(`- AI 的道牌估值是按「类别 + 原子」估的（神装 2.0–2.6 / 神策 2.2 / 神通 1.5），不是精确收益模型；拍卖出价也基于同一套估值，因此成交价反映的是"AI 认为值多少"，不是玩家市场的真实价格。`);
  P(`- 神策的"两人并列 → 流拍"规则会显著压低成交率，这是规则本身的设计（抬价即资敌）。`);
  P(`- 同盟（2 人/势力）尚未接入，当前为个人模式。`);

  const outDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const mode = PER === 1 ? "ffa" : `${Math.ceil(PLAYERS / PER)}v${Math.ceil(PLAYERS / PER)}`;
  const out = path.join(outDir, `balance-${PLAYERS}p-${mode}-${Date.now()}.md`);
  fs.writeFileSync(out, lines.join("\n"), "utf8");
  console.log(`\n报告已写入 ${out}`);
}

main();
