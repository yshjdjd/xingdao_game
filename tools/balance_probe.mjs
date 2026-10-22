// 快速平衡探针：全 AI 自动对局，看 R58 之后局面是否还正常（不会瞬间结束、也不会拖太久）。
//   node tools/balance_probe.mjs [局数]
import { createMatch, startRound, beginTurn, resolveTurn, endRound,
  peekAuction, auctionIfDue, discardOver, autoDiscard, playableCards, costFor } from "../src/engine.mjs";
import { chooseAction, bidFor } from "../src/ai.mjs";
import { fmt } from "../src/units.mjs";

const N = Number(process.argv[2] || 20);

function oneMatch(seed) {
  const m = createMatch({
    seats: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
    seed,
  });
  startRound(m);
  let turns = 0;
  let hpLost = 0;
  let prevHp = m.players.reduce((s, p) => s + p.hp, 0);
  let prevRound = -1;
  // 保险：最多 600 个回合，防止死循环
  for (let guard = 0; guard < 600; guard++) {
    if (m.matchOver) break;
    if (m.roundOver) {
      endRound(m);
      if (m.matchOver) break;
      startRound(m);
      continue;
    }
    // 拍卖（第 5/10/15… 回合开头）
    if (peekAuction(m)) {
      m.turn += 1;
      const bids = {};
      for (const p of m.players) if (p.alive) bids[p.seat] = bidFor(m, p);
      auctionIfDue(m, bids);
    }
    const ev = beginTurn(m, {});
    if (m.matchOver) break;
    if (ev.some((e) => e.t === "tianji")) { /* 天机已在 beginTurn 内生效 */ }

    const acts = {};
    for (const p of m.players) {
      if (!p.alive) continue;
      const c = chooseAction(m, p);
      acts[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
    }
    resolveTurn(m, acts, {});
    turns += 1;

    const hpNow = m.players.reduce((s, p) => s + (p.alive ? p.hp : 0), 0);
    hpLost += Math.max(0, prevHp - hpNow);
    prevHp = hpNow;
    prevRound = m.roundIndex;

    for (const o of discardOver(m)) autoDiscard(m, o.seat);
  }
  return {
    seed, turns, rounds: prevRound + 1, over: !!m.matchOver,
    survivor: m.players.filter((p) => p.alive).length,
    winner: m.players.find((p) => p.alive)?.name || "—",
    avgLoss: turns ? hpLost / 4 / turns : 0,     // 每人每回合平均掉血（点；4 人局）
  };
}

const rows = [];
for (let i = 0; i < N; i++) rows.push(oneMatch(5000 + i));

const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
const maxT = Math.max(...rows.map((r) => r.turns));
const minT = Math.min(...rows.map((r) => r.turns));
const finished = rows.filter((r) => r.over).length;

console.log(`对局数 ${N}`);
console.log(`打完（有人撑到最后/淘汰出胜负）：${finished} / ${N}`);
console.log(`平均回合数 ${avg("turns").toFixed(1)}（最少 ${minT}，最多 ${maxT}）`);
console.log(`平均到达局数 ${avg("rounds").toFixed(1)}（满局 4）`);
console.log(`平均每回合掉血 ${avg("avgLoss").toFixed(2)} 点`);
const byName = {};
for (const r of rows) byName[r.winner] = (byName[r.winner] || 0) + 1;
console.log("胜者分布：", Object.entries(byName).map(([k, v]) => `${k}=${v}`).join("  "));
const stuck = rows.filter((r) => !r.over);
if (stuck.length) console.log("!! 有对局没打完：", stuck.map((r) => `seed${r.seed}(${r.turns}回合)`).join(" "));
