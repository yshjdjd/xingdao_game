// 视角投影演示：跑几步，然后打印"座位 0 的客户端会收到什么"。
// 用途：验证联机时前端拿到的数据是否刚好够用、且不泄漏。
// 运行：node cli/view.mjs --turns 6 --seat 0
import { createMatch, startRound, beginTurn, resolveTurn, peekAuction, auctionIfDue } from "../src/engine.mjs";
import { chooseAction, bidFor } from "../src/ai.mjs";
import { viewFor, auditView } from "../src/view.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const TURNS = Number(arg("turns", 6));
const SEAT = Number(arg("seat", 0));

const m = createMatch({
  seats: [{ name: "青岚" }, { name: "白露" }, { name: "赤霄" }, { name: "玄冥" }],
  seed: Number(arg("seed", 2026)),
});
startRound(m);

let lastEvents = [];
for (let i = 0; i < TURNS && !m.roundOver; i++) {
  beginTurn(m, { tianji: {} });
  const acts = {};
  const freeOps = {};
  for (const p of m.players) {
    if (!p.alive) continue;
    const c = chooseAction(m, p);
    acts[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
    if (c.freeOps?.length) freeOps[p.seat] = c.freeOps;
  }
  lastEvents = resolveTurn(m, acts, { freeOps });

  const offer = peekAuction(m);
  if (offer) {
    const bids = {};
    for (const q of m.players) if (q.alive) bids[q.seat] = bidFor(m, q, offer);
    auctionIfDue(m, { offerId: offer, bids });
  }
}

const v = viewFor(m, SEAT, { events: lastEvents });
const problems = auditView(v, m, SEAT);

const LINE = "─".repeat(56);
console.log(`\n第 ${v.round + 1} 局 · 第 ${v.turn} 回合　（座位 ${SEAT} 的客户端视角）`);
console.log(LINE);
console.log("场上：");
for (const p of v.players) {
  const me = p.seat === SEAT ? " ←我" : "";
  const state = p.alive ? `血 ${p.hp}/${p.maxHp}　能 ${p.energy}` : "已出局";
  console.log(`  P${p.seat + 1} ${p.name}（势力${p.factionId + 1}）　${state}　术集 ${p.setCount}　手牌 ${p.handCount}${me}`);
}
console.log(LINE);
console.log(`我的手牌：${v.me.hand.length ? v.me.hand.join(" / ") : "（空）"}`);
console.log(`可出：${v.me.playable.map((c) => `${c.id}(费${c.cost})`).join("  ")}`);
if (v.me.freeOps.length) {
  console.log(`身世操作：${v.me.freeOps.map((o) => `${o.label}${o.enabled ? "" : "(不可用)"}`).join("　")}`);
}
if (v.auction) console.log(`拍卖中：${v.auction.name}（${v.auction.category}）`);
console.log(LINE);
console.log(`本回合结算（公开事件）：${v.log.map((e) => e.t).join(" → ") || "（无）"}`);
console.log(LINE);
console.log(`投影体积：${JSON.stringify(v).length} 字节　泄漏自检：${problems.length ? "❌ " + problems.join("; ") : "✅ 通过"}`);
const fullPlayers = JSON.stringify(m.players).length;
const viewPlayers = JSON.stringify(v.players).length;
console.log(`玩家区：完整状态 ${fullPlayers} 字节（含 4 人手牌与内部字段）→ 投影 ${viewPlayers} 字节（只剩数量）。投影总额外包含术池与可出牌列表，所以总量反而更大 —— 但它是"能发出去的那份"。\n`);
