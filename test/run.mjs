// 规则回归测试。每个用例对应《裁决细则》里的一条裁定编号。
// 运行：node test/run.mjs
import { createMatch, startRound, resolveTurn, endRound,
  discardOver, discardCards, autoDiscard, peekAuction, auctionIfDue } from "../src/engine.mjs";
import { toU, fmt } from "../src/units.mjs";
import { raw } from "../src/data.mjs";
import { CONFIG } from "../src/config.mjs";

const DsetById = (sid) => raw.sets.find((x) => x.id === sid);

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

function board(n = 3, { seed = 1, turn = 5 } = {}) {
  const m = createMatch({ seats: Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` })), seed });
  startRound(m);
  m.turn = turn;
  m.tianji.firedThisTurn = true; // 测试时不让天机插手
  // 归一化：身世与血量固定，避免随机身世干扰断言
  for (const p of m.players) {
    p.birth = "birth_03";
    p.maxHp = toU(3);
    p.hp = toU(3);
  }
  return m;
}
const set = (m, seat, patch) => Object.assign(m.players[seat], patch);
const hp = (m, seat) => fmt(m.players[seat].hp);

test("R01 先加后乘：赤霄剑 +1 与罡风靴 ×2 → (4+1)×2 = 10，再被护心镜减至 9.5", () => {
  const m = board(2);
  set(m, 0, { energy: toU(20), equip: ["dao_02", "dao_03"] });
  set(m, 1, { equip: ["dao_01"] });
  const ev = resolveTurn(m, {
    0: { cardId: "base_04" },
    1: { cardId: "base_10" },
  });
  const hit = ev.find((e) => e.t === "hit");
  if (!hit) throw new Error("应当命中");
  if (hit.value !== "9.5") throw new Error(`期望 9.5，实际 ${hit.value}`);
});

test("R02 超阶防御：一阶普攻即使只有数值 1 也能击破", () => {
  const m = board(2);
  set(m, 0, { energy: toU(5) });
  resolveTurn(m, { 0: { cardId: "base_02" }, 1: { cardId: "base_12" } });
  if (m.players[1].hp === m.players[1].maxHp) throw new Error("超防应被普攻击破");
});

test("R02 补：四阶攻击（数值 4）打不破超阶防御（12）", () => {
  const m = board(2);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(5) });
  resolveTurn(m, { 0: { cardId: "base_04" }, 1: { cardId: "base_12" } });
  if (m.players[1].hp !== m.players[1].maxHp) throw new Error("4 < 12 不应命中");
});

test("R03 山海有灵：数值 1 击破，数值 2 被挡下", () => {
  const m1 = board(2);
  set(m1, 0, { energy: toU(5) });
  set(m1, 1, { energy: toU(10) });
  resolveTurn(m1, { 0: { cardId: "base_02" }, 1: { cardId: "b1s4_05" } });
  if (m1.players[1].hp === m1.players[1].maxHp) throw new Error("数值 1 应击破山海");

  const m2 = board(2);
  set(m2, 0, { energy: toU(5) });
  set(m2, 1, { energy: toU(10) });
  resolveTurn(m2, { 0: { cardId: "base_03" }, 1: { cardId: "b1s4_05" } });
  if (m2.players[1].hp !== m2.players[1].maxHp) throw new Error("数值 2 应被山海挡下");
});

test("R03 补：山海 + 护心镜不再无敌（护心镜不参与山海的数值判定）", () => {
  const m = board(2);
  set(m, 0, { energy: toU(5) });
  set(m, 1, { energy: toU(10), equip: ["dao_01"] });
  resolveTurn(m, { 0: { cardId: "base_02" }, 1: { cardId: "b1s4_05" } });
  if (m.players[1].hp === m.players[1].maxHp) throw new Error("普攻仍应击破山海");
});

test("R04 自爆数值只取决于血量，不吃赤霄剑加成", () => {
  const m = board(2);
  set(m, 0, { hp: toU(3), equip: ["dao_02"] });
  resolveTurn(m, { 0: { cardId: "base_13" }, 1: { cardId: "base_01" } });
  // 目标 3 血被 3 点自爆打掉，而不是 3.5
  if (m.players[1].hp !== 0) throw new Error(`期望目标归零，实际 ${hp(m, 1)}`);
});

test("R06 并列最高：最高者互不相伤，但胜者线对其它人照常生效", () => {
  const m = board(3);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  const before = m.players.map((p) => p.hp);
  resolveTurn(m, {
    0: { cardId: "base_04" },
    1: { cardId: "base_04" },
    2: { cardId: "base_01" },   // 蓄力，阈值 0 → 被胜者线命中
  });
  const after = m.players.map((p) => p.hp);
  if (after[0] !== before[0] || after[1] !== before[1]) throw new Error("并列者之间不应受伤");
  if (after[2] !== before[2] - toU(1)) throw new Error(`蓄力者应被命中扣 1，实际 ${hp(m, 2)}`);
});

test("R06 并列最高：并列者不吃彼此的攻击，但低值攻击者照样挨打", () => {
  const m = board(3);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  set(m, 2, { energy: toU(10) });
  resolveTurn(m, {
    0: { cardId: "base_04" },   // 4，并列最高
    1: { cardId: "base_04" },   // 4，并列最高
    2: { cardId: "base_03" },   // 2，线以下 → 判定失败，同时被命中（R58 合并后只扣 1）
  });
  if (m.players[0].hp !== toU(3) || m.players[1].hp !== toU(3)) {
    throw new Error(`并列者不该掉血，实际 ${hp(m, 0)} / ${hp(m, 1)}`);
  }
  if (m.players[2].hp !== toU(2)) throw new Error(`线以下只应扣 1（判定失败并入命中），实际 ${hp(m, 2)}`);
});

test("R58 判定失败与命中合并：低于胜者线只扣 1 血，不再叠加", () => {
  const m = board(3);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  const ev = resolveTurn(m, {
    0: { cardId: "base_04" },   // 4，胜者线
    1: { cardId: "base_03" },   // 2，线以下：既被命中又判定失败
    2: { cardId: "base_01" },   // 蓄力，阈值 0，被命中
  });
  // 出攻击的人防御恒为 0，所以"被命中"与"判定失败"必然同时成立 —— 只扣一次
  if (m.players[1].hp !== toU(2)) throw new Error(`判定失败只应扣 1，实际 ${hp(m, 1)}`);
  if (m.players[2].hp !== toU(2)) throw new Error(`蓄力者应被命中扣 1，实际 ${hp(m, 2)}`);
  const fail = ev.find((e) => e.t === "fail" && e.seat === 1);
  if (!fail) throw new Error("应记录判定失败事件");
  if (!fail.merged) throw new Error("被命中过的人，判定失败应标记为已合并");
});

test("R07 化劲：数值相等时反弹成立（≤ 取等号）", () => {
  const m = board(2);
  set(m, 0, { energy: toU(5) });
  set(m, 1, { energy: toU(5) });
  resolveTurn(m, {
    0: { cardId: "b2s4_01" },  // 一重化劲 3 / 反弹上限 3
    1: { cardId: "b2s4_01" },
  });
  // 双方并列 3 → 攻击作废；但双方都在反弹上限内，各吃 1 点反弹
  if (m.players[0].hp !== toU(2) || m.players[1].hp !== toU(2)) {
    throw new Error(`双方都应吃 1 点反弹，实际 ${hp(m, 0)} / ${hp(m, 1)}`);
  }
});

test("R09 阴阳倒转：能量组循环下移一档", async () => {
  const { applyTianjiCard } = await import("../src/engine.mjs");
  const { raw } = await import("../src/data.mjs");
  const m = board(4, { turn: 3 });
  set(m, 0, { energy: toU(4) });
  set(m, 1, { energy: toU(3) });
  set(m, 2, { energy: toU(3) });
  set(m, 3, { energy: toU(1) });
  applyTianjiCard(m, raw.tianji.find((t) => t.id === "tj_17"));
  const got = m.players.map((p) => fmt(p.energy)).join(",");
  if (got !== "3,1,1,4") throw new Error(`期望 3,1,1,4，实际 ${got}`);
});

test("自爆：第 1 回合不可用", () => {
  const m = board(2, { turn: 1 });
  set(m, 0, { hp: toU(2) });
  resolveTurn(m, { 0: { cardId: "base_13" }, 1: { cardId: "base_01" } });
  if (!m.players[0].alive) throw new Error("第 1 回合不应允许自爆");
});

test("补给：第 10 回合全员 +1 能量", async () => {
  const { beginTurn } = await import("../src/engine.mjs");
  // 隔离天机：本用例只验证补给本身。天机会改能量，混在一起断言会随概率调整而假失败
  // （beginTurn 每回合都会把 firedThisTurn 复位，所以这里直接把概率判定钉成 false）。
  const m = board(2, { turn: 9 });
  const origChance = m.rng.chance;
  m.rng.chance = () => false;
  const before = m.players.map((p) => p.energy);
  const ev = beginTurn(m);
  m.rng.chance = origChance;
  if (!ev.some((e) => e.t === "supply")) throw new Error("第 10 回合应触发补给");
  if (m.players[0].energy !== before[0] + toU(1)) throw new Error("第 10 回合应 +1 能量");
});

test("R43 天机概率：前三局 20% / 终局 30%（统计回归，±4 个百分点）", async () => {
  const { createMatch, startRound, beginTurn } = await import("../src/engine.mjs");
  const N = 3000;
  const seats = Array.from({ length: 4 }, (_, i) => ({ name: `P${i + 1}` }));
  let base = 0, final = 0;
  for (let i = 0; i < N; i++) {
    // 每一轮都用全新的对局，sinceLast 归零 → 不会触发"连续 5 回合保底"，只测自然概率
    const a = createMatch({ seats, seed: i + 1 });
    startRound(a);
    if (beginTurn(a, {}).some((e) => e.t === "tianji")) base += 1;

    const b = createMatch({ seats, seed: i + 1 });
    b.roundIndex = CONFIG.finalRoundIndex;
    startRound(b);
    if (beginTurn(b, {}).some((e) => e.t === "tianji")) final += 1;
  }
  const rb = base / N, rf = final / N;
  if (Math.abs(rb - CONFIG.tianjiBaseChance) > 0.04) {
    throw new Error(`前三局实测 ${(rb * 100).toFixed(1)}%，应接近 ${CONFIG.tianjiBaseChance * 100}%`);
  }
  if (Math.abs(rf - CONFIG.tianjiFinalChance) > 0.04) {
    throw new Error(`终局实测 ${(rf * 100).toFixed(1)}%，应接近 ${CONFIG.tianjiFinalChance * 100}%`);
  }
});

test("架构约束：src/ 下不得出现任何中文牌名（引擎不认识牌）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { raw } = await import("../src/data.mjs");
  const all = [
    ...raw.basic, ...raw.sets.flatMap((x) => x.cards), ...raw.tianji, ...raw.dao, ...raw.birth,
  ];
  // 「蓄力 / 自爆」这类既是牌名又是牌型，代码里必然出现，排除
  const types = new Set(all.map((c) => c.type).filter(Boolean));
  const names = all.map((c) => c.name)
    .filter((n) => n && n.length >= 2 && !types.has(n) && !["攻术", "御术"].includes(n));
  const dir = path.join(process.cwd(), "src");
  const hits = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".mjs")) continue;
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // 去注释
    for (const n of names) if (text.includes(n)) hits.push(`${f}: ${n}`);
  }
  if (hits.length) throw new Error("引擎里出现了牌名 → " + hits.slice(0, 5).join(" / "));
});

test("prompt·符咒：目标本回合术无效，且下回合被禁用", () => {
  const m = board(2);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  const before = m.players[1].hp;
  resolveTurn(m, { 0: { cardId: "b2s1_01" }, 1: { cardId: "base_04" } },
    { answers: { 0: {} } });
  if (m.players[0].hp !== m.players[0].maxHp) throw new Error("被符咒封住的攻击不应命中");
  if (before !== m.players[1].hp) throw new Error("无效化不应伤到攻击者");
});

test("prompt·七星八卦阵：非友方本回合的术全部失效", () => {
  const m = board(3);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  resolveTurn(m, { 0: { cardId: "b2s1_03" }, 1: { cardId: "base_04" }, 2: { cardId: "base_01" } });
  if (m.players[0].hp !== m.players[0].maxHp) throw new Error("被阵法压制的攻击不应命中");
});

test("prompt·鲸吞：无能量时按蓄力者数量吸能，且蓄力者拿不到能量", () => {
  const m = board(3);
  set(m, 1, { energy: 0 });
  set(m, 2, { energy: 0 });
  resolveTurn(m, { 0: { cardId: "b2s2_01" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } });
  if (m.players[0].energy !== toU(2)) throw new Error(`应吸到 2 点，实际 ${fmt(m.players[0].energy)}`);
  if (m.players[1].energy !== 0) throw new Error("被鲸吞者不应获得能量");
});

test("prompt·太极开天门：默认分配全部转防御，可挡下同值攻击", () => {
  const m = board(2);
  set(m, 0, { energy: toU(10) });
  set(m, 1, { energy: toU(10) });
  resolveTurn(m, { 0: { cardId: "b2s4_04" }, 1: { cardId: "base_04" } });
  if (m.players[0].hp !== m.players[0].maxHp) throw new Error("4 点全转防御应正好挡下 4 点攻击");
});

test("prompt·囚徒：双方都认罪则各付 2 点能量", () => {
  const m = board(3);
  set(m, 0, { energy: toU(6), hand: ["dao_12"] });
  set(m, 1, { energy: toU(6) });
  set(m, 2, { energy: toU(6) });
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_12" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } });
  // 默认答案：认罪 → 两人各 -2 能量（蓄力 +1 抵消一部分）
  if (m.players[1].energy > toU(5)) throw new Error(`认罪应扣 2 点，实际 ${fmt(m.players[1].energy)}`);
});

// 行动层扩展：身世 / 反制 / 匠作
function withBirths(births, n = 2) {
  const m = createMatch({ seats: Array.from({ length: n }, (_, i) => ({ name: `P${i + 1}` })), seed: 7 });
  births.forEach((b, i) => { if (m.players[i]) m.players[i].birth = b; });
  startRound(m);
  m.turn = 5;
  m.tianji.firedThisTurn = true;
  for (const p of m.players) { p.maxHp = toU(3); p.hp = toU(3); }
  return m;
}

test("特别阶段·官宦子弟：开局从本局术池拿到 1 张临时术", () => {
  const m = withBirths(["birth_03", "birth_01"]);
  const temp = m.players[0].tempCards || [];
  if (temp.length !== 1) throw new Error(`应拿到 1 张，实际 ${temp.length}`);
  const poolCards = m.pool.flatMap((sid) => DsetById(sid).cards.map((c) => c.id));
  if (!poolCards.includes(temp[0])) throw new Error("临时术应来自本局术池");
});

test("非出牌操作·平民子弟：1 血换 2 能量", () => {
  const m = withBirths(["birth_06", "birth_01"]);
  const before = { hp: m.players[0].hp, en: m.players[0].energy };
  resolveTurn(m, { 0: { cardId: "base_01" } }, { freeOps: { 0: [{ op: "convertToEnergy" }] } });
  if (m.players[0].hp !== before.hp - toU(1)) throw new Error("应扣 1 血");
  if (m.players[0].energy < before.en + toU(2)) throw new Error("应得 2 能量");
});

test("非出牌操作·杏林世家：2 能量换一张治疗牌，打出后回 1 血", () => {
  const m = withBirths(["birth_05", "birth_01"]);
  m.players[0].energy = toU(6);
  resolveTurn(m, { 0: { cardId: "base_01" } }, { freeOps: { 0: [{ op: "buyHeal" }] } });
  if (!m.players[0].hand.includes("synth_heal")) throw new Error("应获得治疗牌");
  const hpBefore = m.players[0].hp = toU(2);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "synth_heal" } });
  if (m.players[0].hp !== hpBefore + toU(1)) throw new Error("应回复 1 点血");
});

test("匠作之家：出牌时 +1 数值（先付能量）", () => {
  const m = withBirths(["birth_04", "birth_01"]);
  m.players[0].energy = toU(10);
  const ev = resolveTurn(m, { 0: { cardId: "base_04", craft: { delta: 1 } }, 1: { cardId: "base_01" } });
  const line = ev.find((e) => e.t === "line");
  if (!line || line.value !== "5") throw new Error(`胜者线应为 5，实际 ${line && line.value}`);
});

test("反制阶段·无懈可击：免疫本回合针对自己的道牌", () => {
  const m = withBirths(["birth_01", "birth_01"]);
  m.players[0].hand = ["dao_31"];
  m.players[1].hand = ["dao_15"];
  m.players[0].energy = toU(6);
  m.players[1].energy = toU(6);
  const ev = resolveTurn(
    m,
    { 0: { cardId: "base_04" }, 1: { cardId: "base_01", daoId: "dao_15" } },
    { reactions: { 0: { negate: true } } },
  );
  if (!ev.some((e) => e.t === "negate")) throw new Error("应触发反制");
  if (!ev.some((e) => e.t === "hit")) throw new Error("反制后攻击仍应生效");
});

test("借刀杀人：指定的人下回合被标记为必须攻击", () => {
  const m = withBirths(["birth_01", "birth_01"], 3);
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(4);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_13" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } });
  if (!m.players.some((p) => p.forcedAttackThisTurn)) throw new Error("应有一人被标记");
});

test("借刀杀人：被强制者拒不攻击，扣 1 血", () => {
  const m = withBirths(["birth_01", "birth_01"], 3);
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(4);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_13" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } });
  const forced = m.players.find((p) => p.forcedAttackThisTurn);
  if (!forced) throw new Error("应有人被强制");
  const before = forced.hp;
  // 被强制者选择蓄力 -> 违约
  const acts = {};
  for (const p of m.players) if (p.alive) acts[p.seat] = { cardId: "base_01" };
  const ev = resolveTurn(m, acts);
  if (!ev.some((e) => e.t === "forceFail")) throw new Error("应触发违约事件");
  if (forced.hp >= before) throw new Error("违约应扣 1 血");
});

test("借刀杀人：打出攻击则免罚", () => {
  const m = withBirths(["birth_01", "birth_01"], 3);
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(4);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_13" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } });
  const forced = m.players.find((p) => p.forcedAttackThisTurn);
  forced.energy = toU(10);
  const before = forced.hp;
  const acts = {};
  for (const p of m.players) if (p.alive) acts[p.seat] = { cardId: p.seat === forced.seat ? "base_04" : "base_01" };
  const ev = resolveTurn(m, acts);
  if (ev.some((e) => e.t === "forceFail")) throw new Error("已攻击不应违约");
  if (forced.hp < before) throw new Error("主动攻击者不应额外扣血");
});

test("借刀杀人：对施术者及其队友无效，但对被强制者的队友生效", () => {
  const m = withBirths(["birth_01", "birth_01", "birth_01", "birth_01"], 4);
  m.players[0].factionId = 0;   // 施术者
  m.players[3].factionId = 0;   // 施术者队友
  m.players[1].factionId = 1;   // 被强制者
  m.players[2].factionId = 1;   // 被强制者的队友
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(4);
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_13" },
    1: { cardId: "base_01" }, 2: { cardId: "base_01" }, 3: { cardId: "base_01" },
  });
  const forced = m.players.find((p) => p.forcedAttackThisTurn);
  forced.energy = toU(10);
  const acts = {};
  for (const p of m.players) if (p.alive) acts[p.seat] = { cardId: p.seat === forced.seat ? "base_04" : "base_01" };
  resolveTurn(m, acts);
  if (m.players[0].hp !== m.players[0].maxHp) throw new Error("施术者应免疫");
  if (m.players[3].hp !== m.players[3].maxHp) throw new Error("施术者队友应免疫");
  if (m.players[2].hp >= m.players[2].maxHp) throw new Error("被强制者的队友应被这套攻击命中");
});

// 拍卖（7.7）
function auctionBoard(n = 3) {
  // 拍卖在第 5 回合「开始」触发：此刻上一回合（4）已结束、beginTurn 还没跑，m.turn = 4
  const m = board(n, { turn: CONFIG.auctionEvery - 1 });
  m.players.forEach((p) => { p.energy = toU(10); p.hand = []; p.equip = []; });
  return m;
}

test("拍卖：最高价唯一则成交，支付并得牌", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(3);
  const before = m.players[0].energy;
  const ev = auctionIfDue(m, { offerId: "dao_21", bids: { 0: 4, 1: 2, 2: 1 } });
  if (!ev.some((e) => e.t === "auctionWin" && e.seat === 0)) throw new Error("应当由 0 号拿下");
  if (m.players[0].energy !== before - toU(4)) throw new Error("应支付 4 点能量");
  if (!m.players[0].hand.includes("dao_21")) throw new Error("应得牌");
});

test("拍卖：三人并列且 ≥3 → 各付各价各得一张", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(4);
  const ev = auctionIfDue(m, { offerId: "dao_21", bids: { 0: 3, 1: 3, 2: 3, 3: 1 } });
  const wins = ev.filter((e) => e.t === "auctionWin");
  if (wins.length !== 3) throw new Error(`应三人成交，实际 ${wins.length}`);
  for (const i of [0, 1, 2]) {
    if (!m.players[i].hand.includes("dao_21")) throw new Error(`${i} 应得牌`);
  }
});

test("拍卖：两人并列 → 流拍，不扣能量", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(3);
  const before = m.players.map((p) => p.energy);
  const ev = auctionIfDue(m, { offerId: "dao_21", bids: { 0: 3, 1: 3, 2: 1 } });
  if (!ev.some((e) => e.t === "auctionResult" && e.reason === "tie2")) throw new Error("应流拍");
  if (m.players.some((p, i) => p.energy !== before[i])) throw new Error("流拍不应扣能量");
});

test("拍卖：全场 0 出价 → 流拍", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(3);
  const ev = auctionIfDue(m, { offerId: "dao_21", bids: { 0: 0, 1: 0, 2: 0 } });
  if (!ev.some((e) => e.t === "auctionResult" && e.kind === "unsold")) throw new Error("应流拍");
});

test("拍卖：拍到神装可立即装备，不占手牌位", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(2);
  auctionIfDue(m, { offerId: "dao_02", bids: { 0: 3, 1: 0 } });
  if (!m.players[0].equip.includes("dao_02")) throw new Error("神装应立即装备");
  if (m.players[0].hand.includes("dao_02")) throw new Error("不应占手牌位");
});

test("拍卖：没拍到的人不扣能量（只有成交者付钱）", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(3);
  const before = m.players.map((p) => p.energy);
  auctionIfDue(m, { offerId: "dao_21", bids: { 0: 4, 1: 2, 2: 1 } });
  if (m.players[0].energy !== before[0] - toU(4)) throw new Error("成交者应支付 4 点");
  if (m.players[1].energy !== before[1]) throw new Error("出价低的人不该扣能量");
  if (m.players[2].energy !== before[2]) throw new Error("出价低的人不该扣能量");
});

test("拍卖：出价只按整点，半点零头留在手里", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const m = auctionBoard(2);
  m.players[0].energy = toU(2.5);   // 2.5 点 -> 最多出 2 点，剩 0.5 点
  m.players[1].energy = toU(0.5);   // 0.5 点 -> 出不起整点，等于弃权
  const ev = auctionIfDue(m, { offerId: "dao_21", bids: { 0: 99, 1: 99 } });
  const win = ev.find((e) => e.t === "auctionWin");
  if (!win) throw new Error("应当成交");
  if (!Number.isInteger(win.bid) || win.bid !== 2) throw new Error(`成交价应为整点 2，实际 ${win.bid}`);
  if (m.players[0].energy !== toU(0.5)) throw new Error("应只剩 0.5 点零头");
  if (m.players[1].energy !== toU(0.5)) throw new Error("出不起整点的人不该被扣能量");
});

test("拍卖：只在第 5/10/15 回合开始开拍（不是第 6 回合开头）", () => {
  const m = board(2);
  for (const p of m.players) p.energy = toU(6);
  const expect = { 3: false, 4: true, 5: false, 8: false, 9: true, 10: false };
  for (const [turn, want] of Object.entries(expect)) {
    m.turn = Number(turn);                       // 即将开始的回合 = turn + 1
    const got = !!peekAuction(m);
    if (got !== want) throw new Error(`第 ${Number(turn) + 1} 回合${want ? "应" : "不该"}开拍，实际${got ? "开了" : "没开"}`);
  }
});

test("拍卖：同一回合反复 peek 得到同一张拍品（不会把 rng 推着走）", () => {
  const m = board(2);
  m.turn = CONFIG.auctionEvery - 1;
  for (const p of m.players) p.energy = toU(6);
  const first = peekAuction(m);
  if (!first) throw new Error("第 5 回合应开拍");
  for (let i = 0; i < 5; i++) {
    if (peekAuction(m) !== first) throw new Error("同一回合的拍品必须固定，否则每次广播都会换一张");
  }
});

test("引雷：本回合所有攻击数值 +3，且不提升防御（出牌者自己也会被打中）", () => {
  const m = board(3);
  m.players[0].hand = ["dao_22"];
  m.players[0].energy = toU(10);
  m.players[1].energy = toU(10);
  m.players[2].energy = toU(10);
  const ev = resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_22" },   // 蓄力 + 引雷，自身阈值 0
    1: { cardId: "base_03" },                    // 二阶 2 -> 5
    2: { cardId: "base_10" },                    // 普通防御 3
  });
  const line = ev.find((e) => e.t === "line");
  if (!line || line.value !== "5") throw new Error(`胜者线应为 5，实际 ${line && line.value}`);
  if (m.players[2].hp !== toU(2)) throw new Error("阈值 3 挡不住 5，应扣 1 血");
  if (m.players[0].hp !== toU(2)) throw new Error("出引雷的人自己阈值 0，也应扣 1 血");
  if (m.players[1].hp !== toU(3)) throw new Error("攻击者本人不应受伤");
});

test("拍卖：出价上限受各人当前能量限制（实时能量不同）", async () => {
  const { auctionIfDue } = await import("../src/engine.mjs");
  const { bidFor } = await import("../src/ai.mjs");
  const m = board(3, { turn: CONFIG.auctionEvery - 1 });
  m.players[0].energy = toU(2);    // 只有 2 点
  m.players[1].energy = toU(12);   // 12 点
  m.players[2].energy = 0;
  const offer = "dao_21";
  const bid0 = bidFor(m, m.players[0], offer);
  if (bid0 > 2) throw new Error(`能量 2 的人不该出 ${bid0}`);
  // 即使硬塞一个超额出价，结算也必须按各自能量封顶
  const ev = auctionIfDue(m, { offerId: offer, bids: { 0: 99, 1: 1, 2: 5 } });
  const win = ev.find((e) => e.t === "auctionWin");
  if (!win || win.seat !== 0) throw new Error("应由 0 号成交");
  if (win.bid > 2) throw new Error(`成交价应被封顶为 2，实际 ${win.bid}`);
  if (m.players[0].energy < 0) throw new Error("不应扣成负数");
});

// 同盟模式（2 人/势力）
function allyBoard() {
  const m = board(4);
  m.players[0].factionId = 0;
  m.players[1].factionId = 0;
  m.players[2].factionId = 1;
  m.players[3].factionId = 1;
  m.factions = [0, 1].map((id) => ({
    id,
    members: m.players.filter((p) => p.factionId === id).map((p) => p.seat),
    sets: [],
    score: 0,
  }));
  m.players.forEach((p) => { p.sets = []; p.energy = toU(10); });
  return m;
}

test("同盟：队内不互相伤害（同势力跳过命中）", () => {
  const m = allyBoard();
  resolveTurn(m, {
    0: { cardId: "base_04" },   // 攻击 4
    1: { cardId: "base_01" },   // 队友蓄力，阈值 0
    2: { cardId: "base_01" },
    3: { cardId: "base_01" },
  });
  if (m.players[1].hp !== toU(3)) throw new Error("队友不应被自己人打中");
  if (m.players[2].hp !== toU(2)) throw new Error("敌方应被打中");
});

test("同盟：击杀能量由击败者所在势力均分", () => {
  const m = allyBoard();
  m.players[2].hp = toU(1);
  m.players[2].energy = toU(4);
  const before1 = m.players[1].energy;
  resolveTurn(m, {
    0: { cardId: "base_04" },
    1: { cardId: "base_01" },
    2: { cardId: "base_01" },
    3: { cardId: "base_01" },
  });
  if (m.players[2].alive) throw new Error("应被淘汰");
  if (m.players[1].energy <= before1) throw new Error("队友应分到能量");
});

test("同盟：术集归势力共享，局末每势力只挑 1 套", () => {
  const m = allyBoard();
  m.roundOver = true;
  const ranked = endRound(m);
  const f0 = m.factions[0];
  if (f0.sets.length !== 1) throw new Error(`每势力应只挑 1 套，实际 ${f0.sets.length}`);
  if (m.players[0].sets.length !== 1 || m.players[1].sets.length !== 1) throw new Error("两名成员都应解锁该套系");
  if (m.players[0].sets[0] !== m.players[1].sets[0]) throw new Error("队内应是同一套");
  if (ranked.length !== 2) throw new Error("排名应以势力为单位");
});

test("同盟：积分由势力共享（同队成员同分）", () => {
  const m = allyBoard();
  m.roundOver = true;
  endRound(m);
  if (m.players[0].lastRoundScore !== m.players[1].lastRoundScore) throw new Error("同队应同分");
});

// 视角投影
test("投影：只携带自己的手牌，别人只有数量", async () => {
  const { viewFor, auditView } = await import("../src/view.mjs");
  const m = board(4);
  m.turn = 3;                       // 避开拍卖回合（拍品是公示信息，会干扰断言）
  m.players[0].hand = ["dao_21", "dao_22"];
  m.players[1].hand = ["dao_03"];
  m.players[2].hand = ["dao_06", "dao_07", "dao_08"];
  m.players[3].hand = [];

  for (const seat of [0, 1, 2, 3]) {
    const v = viewFor(m, seat);
    const problems = auditView(v, m, seat);
    if (problems.length) throw new Error(`座位 ${seat}：${problems.join(" / ")}`);
    const json = JSON.stringify(v);
    // 别人手里的牌 id 不应出现在自己的投影里
    for (const p of m.players) {
      if (p.seat === seat) continue;
      for (const id of p.hand) {
        const mine = m.players[seat].hand.includes(id);
        if (!mine && json.includes(`"${id}"`)) throw new Error(`座位 ${seat} 看到了座位 ${p.seat} 的 ${id}`);
      }
    }
  }
});

test("投影：观战视角没有任何私有信息", async () => {
  const { viewFor, auditView } = await import("../src/view.mjs");
  const m = board(3);
  m.turn = 3;
  m.players[0].hand = ["dao_21"];
  const v = viewFor(m, -1);
  if ("me" in v) throw new Error("观战不应有 me");
  if (auditView(v, m, -1).length) throw new Error("观战视角自检失败");
  if (v.players.some((p) => "hand" in p)) throw new Error("观战不该看到手牌");
});

test("投影：不下发随机种子与内部字段", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2);
  const json = JSON.stringify(viewFor(m, 0));
  for (const bad of ["seed", "daoDeck", "dmgLog"]) {
    if (json.includes(`"${bad}"`)) throw new Error(`泄漏内部字段 ${bad}`);
  }
});

test("投影：playable 只给付得起的牌，并带上服务端算好的费用", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2);
  m.players[0].energy = toU(1);
  const v = viewFor(m, 0);
  if (!v.me.playable.length) throw new Error("应至少能出蓄力/普攻");
  for (const c of v.me.playable) {
    if (Number(c.cost) > 1) throw new Error(`能量 1 不该出现费用 ${c.cost} 的牌`);
  }
});

// 联机预演：先干跑收集 prompt，再带答案真跑
test("collectPrompts：不改动真实状态，且两次结果一致", async () => {
  const { collectPrompts } = await import("../src/engine.mjs");
  const m = board(3);
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(6);
  const acts = { 0: { cardId: "base_01", daoId: "dao_13" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } };
  const a = collectPrompts(m, acts);
  const b = collectPrompts(m, acts);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("两次预演结果不一致（随机序列未复现）");
  if (!a.length) throw new Error("借刀杀人应产生一个 target 提示");
  if (a[0].seat !== 0 || a[0].type !== "target") throw new Error("提示归属或类型不对");
  if (m.players[0].hand.length !== 1) throw new Error("预演不应消耗手牌");
  if (m.turn !== 5) throw new Error("预演不应推进状态");
});

test("prompt 往返：用预演拿到的 id 填答案，效果与默认答案不同", async () => {
  const { collectPrompts } = await import("../src/engine.mjs");
  const m = board(3);
  m.players[0].hand = ["dao_13"];
  m.players[0].energy = toU(6);
  const acts = { 0: { cardId: "base_01", daoId: "dao_13" }, 1: { cardId: "base_01" }, 2: { cardId: "base_01" } };
  const prompts = collectPrompts(m, acts);
  const answers = { 0: { [prompts[0].id]: 2 } };
  resolveTurn(m, acts, { answers });
  if (!m.players[2].forcedAttackThisTurn) throw new Error("指定的座位 2 应被强制攻击");
  if (m.players[1].forcedAttackThisTurn) throw new Error("座位 1 不该被强制");
});

// ---------- 需要当场做选择的天机 ----------

test("天之赌场：押注最高者拿一半，其余人平分另一半（各人选押多少，不是全押）", () => {
  const m = board(3);
  for (const s of [0, 1, 2]) set(m, s, { energy: toU(6) });
  m.pendingTianji = { id: "tj_21", name: "天之赌场" };
  const ev = resolveTurn(m, {}, { answers: { 0: { bet_0: 1 }, 1: { bet_1: 3 }, 2: { bet_2: 2 } } });

  const sg = ev.find((e) => e.t === "subgame" && e.kind === "bet");
  if (!sg) throw new Error("应有赌场结算事件");
  if (sg.total !== 6) throw new Error(`总注应为 6，实际 ${sg.total}`);
  // 押 3 的 P1 独占一半 ceil(6/2)=3；其余两人平分另一半 3 → 各 ceil(3/2)=2
  if (fmt(m.players[0].energy) !== "7") throw new Error(`P1 应为 6-1+2=7，实际 ${fmt(m.players[0].energy)}`);
  if (fmt(m.players[1].energy) !== "6") throw new Error(`P2 应为 6-3+3=6，实际 ${fmt(m.players[1].energy)}`);
  if (fmt(m.players[2].energy) !== "6") throw new Error(`P3 应为 6-2+2=6，实际 ${fmt(m.players[2].energy)}`);
});

test("天之赌场：全场弃权则无输赢；押注不会超过自己手上的能量", () => {
  const m = board(2);
  set(m, 0, { energy: toU(1) });
  set(m, 1, { energy: toU(0) });
  m.pendingTianji = { id: "tj_21", name: "天之赌场" };
  const ev = resolveTurn(m, {}, { answers: { 0: { bet_0: 99 }, 1: { bet_1: 99 } } });
  const sg = ev.find((e) => e.t === "subgame" && e.kind === "bet");
  if (sg.total !== 1) throw new Error(`能量只有 1，总注只能是 1，实际 ${sg.total}`);
  if (m.players[1].energy < 0) throw new Error("没有能量的人不应被扣成负数");
});

test("赊天：借多少自己选，记在债务上；淘汰时每缺 1 点随机掉 1 张道牌", async () => {
  const m = board(2);
  set(m, 0, { energy: toU(0), hand: ["dao_01", "dao_02", "dao_03"] });
  m.pendingTianji = { id: "tj_23", name: "赊天" };
  // 手牌 3 张 → 最多借 3；这里只借 2
  resolveTurn(m, {}, { answers: { 0: { credit_0: 2 }, 1: { credit_1: 0 } } });
  if (fmt(m.players[0].energy) !== "2") throw new Error(`应借到 2 能量，实际 ${fmt(m.players[0].energy)}`);
  if (fmt(m.players[0].debt) !== "2") throw new Error(`债务应记 2，实际 ${fmt(m.players[0].debt)}`);

  // 再让 P0 被打死，债务清算：欠 2 点 → 掉 2 张道牌
  const m2 = board(2);
  set(m2, 0, { energy: toU(0), hp: toU(0.5), hand: ["dao_01", "dao_02", "dao_03"], debt: toU(2) });
  set(m2, 1, { energy: toU(10) });
  const ev2 = resolveTurn(m2, { 0: { cardId: "base_01" }, 1: { cardId: "base_04" } });
  if (m2.players[0].alive) throw new Error("P0 应被淘汰");
  const debt = ev2.find((e) => e.t === "debt");
  if (!debt) throw new Error("淘汰时应清算赊账");
  if (m2.players[0].hand.length !== 1) throw new Error(`欠 2 点应掉 2 张，剩 ${m2.players[0].hand.length} 张`);
  if (m2.players[0].debt !== 0) throw new Error("清算后债务应清零");
});

test("抽到天之赌场 / 赊天时挂起，等结算前问人（不再静默失效）", async () => {
  const { beginTurn } = await import("../src/engine.mjs");
  let hit = null;
  for (let seed = 1; seed <= 300 && !hit; seed++) {
    const m = createMatch({ seats: [{ name: "A" }, { name: "B" }], seed });
    startRound(m);
    m.tianji.sinceLast = 99;        // 保底必现天机
    beginTurn(m, {});
    if (m.pendingTianji) hit = m.pendingTianji;
  }
  if (!hit) throw new Error("300 个种子都没抽到赌场/赊天");
  if (!["tj_21", "tj_23"].includes(hit.id)) throw new Error(`挂起的不是交互型天机：${hit.id}`);
});

test("R06 并列最高：截图那个场面 —— 并列两人不掉血，蓄力的该扣", () => {
  const m = board(3);
  set(m, 0, { energy: toU(5) });
  set(m, 1, { energy: toU(5) });
  set(m, 2, { energy: toU(5) });
  const before = m.players.map((p) => p.hp);
  const ev = resolveTurn(m, {
    0: { cardId: "base_02" },   // 一阶普攻 1
    1: { cardId: "base_02" },   // 一阶普攻 1 → 与 P0 并列
    2: { cardId: "base_01" },   // 蓄力，阈值 0
  });
  const line = ev.find((e) => e.t === "line");
  if (!line || !line.tied) throw new Error("应判定为并列");
  if (m.players[0].hp !== before[0] || m.players[1].hp !== before[1]) {
    throw new Error(`并列最高者互不相伤，实际 ${hp(m, 0)} / ${hp(m, 1)}`);
  }
  if (m.players[2].hp !== before[2] - toU(1)) {
    throw new Error(`蓄力者（无防御）应被命中扣 1，实际 ${hp(m, 2)}`);
  }
});

test("基础受击封顶：一回合被多个术打中，基础伤害也只结算 1 次", () => {
  const m = board(4);
  for (const p of m.players) p.energy = toU(10);
  const before = m.players.map((p) => p.hp);
  // 甲 高攻；乙 反弹；丙 低攻；丁 蓄力（阈值 0）
  // 丁 会被「甲的攻击命中」+「乙反弹丙的攻击」两次够到，但基础只能扣 1
  const ev = resolveTurn(m, {
    0: { cardId: "base_05" },
    1: { cardId: "base_08" },
    2: { cardId: "base_02" },
    3: { cardId: "base_01" },
  });
  const strikable = ev.filter((e) => e.t === "hit" || e.t === "reflect");
  const dmgFromStrike = toU(1);
  const drop = before[3] - m.players[3].hp;
  // 丁不可能是攻击者，不会被判定失败；所以掉血只能来自"被打中"
  if (drop > dmgFromStrike) {
    throw new Error(`丁被多次够到却扣了 ${fmt(drop)}，基础伤害应封顶 1（相关事件 ${strikable.length} 条）`);
  }
});

test("赌场：押 0（弃权）的人不参与分成", () => {
  const m = board(3);
  for (const p of m.players) p.energy = toU(6);
  m.pendingTianji = { id: "tj_21" };
  const e0 = m.players[2].energy;
  const ev = resolveTurn(m, {}, { answers: { 0: { bet_0: 2 }, 1: { bet_1: 1 }, 2: { bet_2: 0 } } });
  const sg = ev.find((e) => e.t === "subgame" && e.kind === "bet");
  if (!sg) throw new Error("没有赌局结算事件");
  if (sg.others.includes(2)) throw new Error("押 0 的人不该出现在分成名单里");
  if (m.players[2].energy !== e0) {
    throw new Error(`押 0 者能量应原封不动，实际 ${fmt(m.players[2].energy)}`);
  }
  // 总注 3：赢家拿一半 2，另一半 1 归另一个下注者
  if (m.players[0].energy !== e0 - toU(2) + toU(2)) {
    throw new Error(`赢家结算不对：${fmt(m.players[0].energy)}`);
  }
  if (m.players[1].energy !== e0 - toU(1) + toU(1)) {
    throw new Error(`另一名下注者结算不对：${fmt(m.players[1].energy)}`);
  }
});

test("道牌上限 = 血量上限；超了要自己在弃牌期挑牌弃掉", () => {
  const m = board(2);
  const p = m.players[0];
  p.hand = ["dao_01", "dao_02", "dao_03", "dao_04", "dao_05"];
  const cap = Math.round(p.maxHp / 2);
  if (p.hand.length <= cap) throw new Error("用例前提不成立：手牌没超上限");
  const over = discardOver(m);
  if (!over.some((o) => o.seat === p.seat)) throw new Error("超上限应进入弃牌判定");
  const lost = discardCards(m, p.seat, ["dao_02", "dao_04"]);
  if (lost.length !== 2) throw new Error("应弃掉指定两张");
  if (p.hand.length !== 3) throw new Error(`弃牌后应剩 3 张，实际 ${p.hand.length}`);
  if (discardOver(m).some((o) => o.seat === p.seat)) throw new Error("弃够之后不该还在弃牌判定里");
});

test("弃牌兜底：超时/AI 由引擎随机弃到刚好不超", () => {
  const m = board(2);
  const p = m.players[1];
  p.hand = ["dao_01", "dao_02", "dao_03", "dao_04"];
  const before = p.hand.length;
  const lost = autoDiscard(m, p.seat);
  if (!lost.length) throw new Error("超额时应自动弃牌");
  if (p.hand.length !== before - lost.length) throw new Error("自动弃牌数量不一致");
  if (p.hand.length > Math.round(p.maxHp / 2)) throw new Error("自动弃牌后仍超上限");
});

// ---------- R46 道牌生效顺序 ----------

test("R46 数据：每张道牌都有 order，被动只有替身玉符与无懈可击，且按 order 升序排列", async () => {
  const { daoOrder } = await import("../src/engine.mjs");
  const passive = new Set(["dao_06", "dao_31"]);          // 替身玉符 / 无懈可击
  let prev = -Infinity;
  for (const d of raw.dao) {
    const o = daoOrder(d.id);
    if (passive.has(d.id)) {
      if (o !== null) throw new Error(`${d.name} 是被动牌，order 应为 null`);
      continue;
    }
    if (typeof o !== "number") throw new Error(`${d.name} 缺少 order`);
    if (o < prev) throw new Error(`道牌顺序不是升序：${d.name} ${o} < ${prev}`);
    prev = o;
  }
  // 判定分界点：档 ①②③ 在判定前，档 ④⑤⑥ 在判定后
  const before = raw.dao.filter((d) => typeof daoOrder(d.id) === "number" && daoOrder(d.id) < 4);
  if (!before.some((d) => d.id === "dao_15")) throw new Error("锁灵符应在判定前执行");
  if (!before.some((d) => d.id === "dao_22")) throw new Error("引雷应在判定前执行");
  if (before.some((d) => d.id === "dao_26")) throw new Error("替罪(4.9)应在判定后执行");
});

test("R46 执行器：锁灵符（1.2）先于回春（2.1）—— 选「道」能把对面的回春拦下来", () => {
  // 这是改造前真实的顺序 bug：道牌在登记时就地生效，锁灵符的 PRE 钩子跑在它后面，
  // 于是"让对面道牌失效"永远拦不住已经结算完的回春。
  const m = withBirths(["birth_01", "birth_01"]);
  for (const p of m.players) { p.energy = toU(6); p.hp = p.maxHp - toU(1); }
  m.players[0].hand = ["dao_15"];      // 锁灵符 order 1.2
  m.players[1].hand = ["dao_21"];      // 回春   order 2.1
  const before = m.players.map((p) => p.hp);
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_15" },   // 都蓄力：本回合没有任何攻击，血量变化只可能来自回春
    1: { cardId: "base_01", daoId: "dao_21" },
  }, { answers: { 1: { lock_1: "道" } } });
  for (let i = 0; i < m.players.length; i++) {
    if (m.players[i].hp !== before[i]) throw new Error(`选「道」应让回春失效，${i} 号血量不该变`);
  }
});

test("R46 执行器：同一局面选「术」则回春照常生效（对照组）", () => {
  const m = withBirths(["birth_01", "birth_01"]);
  for (const p of m.players) { p.energy = toU(6); p.hp = p.maxHp - toU(1); }
  m.players[0].hand = ["dao_15"];
  m.players[1].hand = ["dao_21"];
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_15" },
    1: { cardId: "base_01", daoId: "dao_21" },
  }, { answers: { 1: { lock_1: "术" } } });
  // R63：回春改成单体治疗（默认选自己），不再全场奶
  if (m.players[1].hp !== m.players[1].maxHp) throw new Error("选「术」时回春应生效，施放者血量回到上限");
  if (m.players[0].hp === m.players[0].maxHp) throw new Error("回春是单体治疗，不该连带治好别人");
});

test("R45 天命轮转：本回合打出 → 下一回合必定天机动荡（跳过概率判定）", async () => {
  const { beginTurn } = await import("../src/engine.mjs");
  const m = board(2, { turn: 3 });
  m.players[0].hand = ["dao_30"];
  m.players[0].energy = toU(6);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_30" }, 1: { cardId: "base_01" } });
  if (!m.flags.tianjiForcedNext) throw new Error("应挂上「下一回合必定动荡」的标记");

  // 把概率钉成 0：如果它仍然触发，说明确实绕过了概率判定
  const orig = m.rng.chance;
  m.rng.chance = () => false;
  const ev = beginTurn(m);
  m.rng.chance = orig;
  if (!ev.some((e) => e.t === "tianji")) throw new Error("下一回合应必定天机动荡");
  if (m.flags.tianjiForcedNext) throw new Error("标记用掉后应清除，不能连续两回合强制");
});

// ---------- R52 官宦子弟特权 / R53 协同型天机 ----------

test("R52 官宦子弟：局初拿到 1 个争夺中的术系（整套，不占 3 套上限）", async () => {
  const { grantTempSet, tempSetChoices } = await import("../src/engine.mjs");
  const { setById } = await import("../src/data.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].birth = "birth_03";
  m.players[0].tempCards = [];
  const choices = tempSetChoices(m);
  if (!choices.length) throw new Error("本局应有正在争夺的术集");
  const got = grantTempSet(m, 0, choices[0]);
  if (got !== choices[0]) throw new Error("应拿到指定的术系");
  for (const c of setById(choices[0]).cards) {
    if (!m.players[0].tempCards.includes(c.id)) throw new Error(`应包含该术系的术：${c.name}`);
  }
  if (m.players[0].sets.length !== 0) throw new Error("临时术系不占势力术集的 3 套上限");
  // 传了池子里没有的 id → 随机挑一个，而不是空手
  m.players[1].birth = "birth_03";
  m.players[1].tempCards = [];
  const any = grantTempSet(m, 1, "not_a_real_set");
  if (!choices.includes(any)) throw new Error("非法 setId 应回退成随机派发");
});

test("R52 startRound(autoTemp:false) 不自动派发，留给水端去问玩家", async () => {
  const m = createMatch({ seats: [{ name: "P1" }, { name: "P2" }], seed: 5 });
  startRound(m, { autoTemp: false });
  for (const p of m.players) {
    if ((p.tempCards || []).length) throw new Error("autoTemp=false 时不应自动派发临时术系");
  }
});

test("R53 协同型天机：干跑只收集 prompt 不改动状态，真跑后清除挂起", async () => {
  const { collectTianjiPrompts, applyPendingTianjiNow } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  for (const p of m.players) p.energy = toU(4);
  m.pendingTianji = { id: "tj_21", name: "天之赌场" };

  const prompts = collectTianjiPrompts(m, "tj_21");
  if (!prompts.length) throw new Error("应收集到押注 prompt");
  if (m.players[0].energy !== toU(4)) throw new Error("干跑不应改动真实能量");
  if (!m.pendingTianji) throw new Error("干跑不应消耗 pendingTianji");

  applyPendingTianjiNow(m, "tj_21", {});
  if (m.pendingTianji) throw new Error("执行完应清除 pendingTianji");
});

// ---------- R44 窥天：天机嫁接 ----------

test("R44 窥天：全场类天机也能嫁接 —— 被搬走的吃零，被嫁接的吃两份", async () => {
  const { applyGraftedTianji } = await import("../src/engine.mjs");
  // 焚天 tj_19 = 全员 −1 血。搬走 1 号那份挂到 2 号身上 → 2 号 −2、1 号 −0、其余各 −1
  const m = board(4, { turn: 10 });
  m.pendingGraft = { id: "tj_19", name: "焚天", holder: 0 };
  const before = m.players.map((p) => p.hp);
  const ev = applyGraftedTianji(m, { from: 1, to: 2 });
  if (m.players[1].hp !== before[1]) throw new Error("被搬走的人应完全不受这道天机影响");
  if (m.players[2].hp !== before[2] - toU(2)) throw new Error("被嫁接的人应吃到两份");
  if (m.players[0].hp !== before[0] - toU(1)) throw new Error("没被牵扯的人应照常扣 1");
  if (m.players[3].hp !== before[3] - toU(1)) throw new Error("没被牵扯的人应照常扣 1");
  if (!ev.some((e) => e.t === "graft" && e.from === 1 && e.to === 2)) throw new Error("应记一条嫁接事件");
  if (m.pendingGraft) throw new Error("执行完应清除挂起");
});

test("R44 窥天：单体类天机改目标；from === to 时不改，按原样生效", async () => {
  const { applyGraftedTianji } = await import("../src/engine.mjs");
  // 生死劫 tj_09 = 血量最低者受到 1 点伤害
  const m = board(3, { turn: 10 });
  m.players[0].hp = toU(3); m.players[1].hp = toU(1); m.players[2].hp = toU(3);
  m.pendingGraft = { id: "tj_09", name: "生死劫", holder: 0 };
  applyGraftedTianji(m, { from: 1, to: 2 });
  if (m.players[1].hp !== toU(1)) throw new Error("原本的血量最低者被搬走，应毫发无伤");
  if (m.players[2].hp !== toU(2)) throw new Error("应改落在被嫁接的人身上");

  const m2 = board(3, { turn: 10 });
  m2.players[0].hp = toU(3); m2.players[1].hp = toU(1); m2.players[2].hp = toU(3);
  m2.pendingGraft = { id: "tj_09", name: "生死劫", holder: 0 };
  applyGraftedTianji(m2, { from: 1, to: 1 });          // 自己搬给自己 = 不改
  if (m2.players[1].hp !== toU(0.5) && m2.players[1].hp !== toU(0)) {
    throw new Error("from === to 时应按原样生效，血量最低者照常挨打");
  }
});

test("R44 窥天：打出后挂起，下一次可嫁接的天机先不生效等窗口", async () => {
  const { beginTurn } = await import("../src/engine.mjs");
  let found = null;
  // 天机是随机抽的，遍历种子找一个「可嫁接」的，避免用例依赖运气
  for (let s = 1; s <= 60 && !found; s++) {
    const m = board(2, { seed: s, turn: 10 });
    m.players[0].hand = ["dao_32"];
    m.players[0].energy = toU(6);
    resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_32" }, 1: { cardId: "base_01" } });
    if (m.flags.graftBy !== 0) throw new Error("打出窥天后应记录持有者");
    m.tianji.sinceLast = CONFIG.tianjiPity;            // 触发保底，保证下一回合必定动荡
    beginTurn(m);
    if (m.pendingGraft) found = m;
  }
  if (!found) throw new Error("60 个种子里都没抽到可嫁接的天机（数据或判定有问题）");
  if (found.flags.graftBy !== null) throw new Error("挂起被领走后应清除，不能反复用");
  if (found.pendingGraft.holder !== 0) throw new Error("挂起应记着窥天的持有者");
});

// ---------- R55 神装：装载 / 卸下 ----------

test("R55 神装：装载 / 卸下只改归属，且两边都计入道牌持有上限", async () => {
  const { setEquipState, discardOver } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  const p = m.players[0];
  p.hand = ["dao_02"];              // 赤霄剑（神装牌）
  p.equip = [];
  const cap = Math.round(p.maxHp / 2);

  if (setEquipState(m, 0, "dao_02", true) !== null) throw new Error("装载应成功");
  if (!p.equip.includes("dao_02")) throw new Error("应进入装备区");
  if (p.hand.includes("dao_02")) throw new Error("不该还留在手牌里");
  // 关键：装载之后照样占上限
  for (let i = 0; i < cap; i++) p.hand.push("dao_21");
  const over = discardOver(m).find((o) => o.seat === 0);
  if (!over || over.over !== 1) throw new Error("已装载的神装应计入道牌持有上限");

  if (setEquipState(m, 0, "dao_02", false) !== null) throw new Error("卸下应成功");
  if (p.equip.includes("dao_02")) throw new Error("应离开装备区");
  if (!p.hand.includes("dao_02")) throw new Error("卸下后应回到手牌");
});

test("R55 神装：非神装不能装卸，装备封禁期间不能装载", async () => {
  const { setEquipState } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_21"];   // 回春（神通牌）
  if (!setEquipState(m, 0, "dao_21", true)) throw new Error("非神装不应能装载");

  m.players[0].hand = ["dao_02"];
  m.buffs.equipDisabledTurns = 1;
  if (!setEquipState(m, 0, "dao_02", true)) throw new Error("装备封禁期间不应能装载");
  // 但卸下不受封禁影响
  m.players[0].equip = ["dao_02"];
  m.players[0].hand = [];
  if (setEquipState(m, 0, "dao_02", false) !== null) throw new Error("封禁期间仍应能卸下");
});

test("R55 神装：穿满导致超上限时，弃牌期可以弃掉已装载的（不会卡死）", async () => {
  const { discardCards, discardOver } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  const p = m.players[0];
  const cap = Math.round(p.maxHp / 2);
  p.hand = [];
  p.equip = Array.from({ length: cap + 1 }, (_, i) => `dao_0${i + 1}`);   // 穿到超上限一件
  if (!discardOver(m).find((o) => o.seat === 0)) throw new Error("穿满应算超上限");
  const lost = discardCards(m, 0, [p.equip[0]]);
  if (lost.length !== 1) throw new Error("应能弃掉已装载的神装");
  if (p.equip.includes(lost[0])) throw new Error("弃掉后应离开装备区");
});

// ---------- R48 / R49 投影层 ----------

test("R49 投影：shuList 给的是全部候选，不能用的带 usable=false 与原因", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].energy = toU(1);            // 只够一阶普攻
  const v = viewFor(m, 0);
  const list = v.me.shuList;
  if (!list || !list.length) throw new Error("应给出术区候选");
  const charge = list.find((x) => x.id === "base_01");
  const big = list.find((x) => x.id === "base_07");       // 十二阶攻击，费 12
  if (!charge || charge.usable !== true) throw new Error("蓄力（0 费）应可用");
  if (!big) throw new Error("用不了的牌也要出现在列表里（好变灰）");
  if (big.usable !== false) throw new Error("能量不足应标 usable=false");
  if (!/能量不足/.test(big.reason || "")) throw new Error(`应给出原因，实际：${big.reason}`);
});

test("R49 投影：神装在 daoList 里不可打出（只能装载）", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_02", "dao_21"];
  const v = viewFor(m, 0);
  const eq = v.me.daoList.find((x) => x.id === "dao_02");
  const heal = v.me.daoList.find((x) => x.id === "dao_21");
  if (eq.usable !== false) throw new Error("神装不能当道牌打出");
  if (!/装载/.test(eq.reason || "")) throw new Error("应说明需要装载");
  if (heal.usable !== true) throw new Error("回春应可打出");
});

test("R48/R49 投影：观战视角没有任何私有信息（没有 shuList / daoList / hand）", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  const v = viewFor(m, -1);
  if (v.me) throw new Error("观战不该有 me");
  const s = JSON.stringify(v);
  for (const leak of ["shuList", "daoList", "freeOps"]) {
    if (s.includes(leak)) throw new Error(`观战视角不该出现 ${leak}`);
  }
});

test("R50 暗选期信息隔离：装载神装不会让别人看到的数字跳动（自己那一栏实时）", async () => {
  process.env.XD_FAST = "1";               // 让服务端的阶段计时压到毫秒级
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  let err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1");
  R.submitBirthAck(room, "c2");
  for (let i = 0; i < 600 && room.phase !== "choose"; i++) await sleep(4);

  try {
    if (room.phase !== "choose") throw new Error("没进到出牌阶段");
    const m = room.match;
    m.players[0].hand.push("dao_02");                       // 赤霄剑（神装）
    const other0 = R.snapshotFor(room, "c2").view.players[0];
    const beforeOther = other0.handCount;
    const beforeOtherEq = (other0.equip || []).length;
    const beforeMine = R.snapshotFor(room, "c1").view.players[0].handCount;

    const e = R.submitEquip(room, "c1", { op: "equip", daoId: "dao_02" });
    if (e) throw new Error(e);

    const afterOther = R.snapshotFor(room, "c2").view.players[0];
    const afterMine = R.snapshotFor(room, "c1").view.players[0].handCount;
    if (afterOther.handCount !== beforeOther) throw new Error(`对外道牌数不该变：${beforeOther} → ${afterOther.handCount}`);
    if ((afterOther.equip || []).length !== beforeOtherEq) throw new Error("对外神装列表不该变（会暴露你在装载）");
    if (afterMine === beforeMine) throw new Error("自己的道牌数应实时变化");
  } finally {
    R.destroyRoom(room);
  }
});

// ---------- R59 术系公开 / 焚术 / 状态栏 ----------

test("R59 官宦子弟的临时术系要对外公开（不能只在 tempCards 里）", async () => {
  const { grantTempSet, tempSetChoices } = await import("../src/engine.mjs");
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].birth = "birth_03";
  m.players[0].tempCards = [];
  m.players[0].tempSets = [];
  const sid = grantTempSet(m, 0, tempSetChoices(m)[0]);
  const v = viewFor(m, 1);                       // 用别人的视角看
  const him = v.players[0];
  if (!him.tempSets.includes(sid)) throw new Error("临时术系应出现在对外视图里");
  const st = (him.statuses || []).find((x) => x.k === "tempSet");
  if (!st) throw new Error("状态栏应有一条「临时术系」");
});

test("R59 焚术：选玩家后按他本回合的牌封禁 —— 基础术只封那一张", async () => {
  const { playableCards } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_28"];
  m.players[0].energy = toU(10);
  set(m, 1, { energy: toU(10) });
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_28" },   // 焚术
    1: { cardId: "base_03" },                    // 二阶攻击（基础术）
  }, { answers: { 0: { banset_0: 1 } } });
  if (!m.bannedBasic.includes("base_03")) throw new Error("应封掉对方这回合用的基础术");
  if (!m.bannedSets.length) { /* ok：基础术不该连坐整系 */ }
  const left = playableCards(m, m.players[1]);
  if (left.includes("base_03")) throw new Error("被封的基础术不该还能打");
  if (!left.includes("base_02")) throw new Error("其它阶攻击不该被连坐");
});

test("R59 焚术：会向打牌者发起「选目标」追问（联机弹窗靠它）", async () => {
  const { collectPrompts } = await import("../src/engine.mjs");
  const m = board(3, { turn: 4 });
  m.players[0].hand = ["dao_28"];
  m.players[0].energy = toU(10);
  const prompts = collectPrompts(m, {
    0: { cardId: "base_01", daoId: "dao_28" },
    1: { cardId: "base_02" },
    2: { cardId: "base_03" },
  });
  const spec = prompts.find((x) => x.id === "banset_0");
  if (!spec) throw new Error(`应收集到焚术的选目标追问，实际 ${prompts.map((x) => x.id).join(",")}`);
  if (spec.type !== "target") throw new Error("焚术第一步应该是选玩家（target）");
});

test("R59 焚术：对方出蓄力 / 防御这类基础公共术 → 封的就是这张牌本身（全场失效）", async () => {
  const { playableCards } = await import("../src/engine.mjs");
  for (const [cardId, label] of [["base_01", "蓄力"], ["base_10", "普通防御"]]) {
    const m = board(3, { turn: 4 });
    m.players[0].hand = ["dao_28"];
    m.players[0].energy = toU(10);
    set(m, 1, { energy: toU(20) });
    set(m, 2, { energy: toU(20) });
    resolveTurn(m, {
      0: { cardId: "base_01", daoId: "dao_28" },
      1: { cardId },
      2: { cardId: "base_01" },
    }, { answers: { 0: { banset_0: 1 } } });
    if (!m.bannedBasic.includes(cardId)) throw new Error(`${label} 应被封掉这张牌本身`);
    if (m.bannedSets.length) throw new Error(`${label} 是基础术，不该连坐任何术系`);
    // 基础术是公共牌：不只是目标，其他所有人都不能再用
    for (const p of m.players) {
      if (playableCards(m, p).includes(cardId)) {
        throw new Error(`${label} 被焚后，${p.name} 也不该还能打`);
      }
    }
  }
});

test("R59 焚术：被封的牌在术区里写明原因（不是笼统的「本回合不可用」）", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_28"];
  m.players[0].energy = toU(10);
  set(m, 1, { energy: toU(20) });
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_28" },
    1: { cardId: "base_01" },
  }, { answers: { 0: { banset_0: 1 } } });
  const item = viewFor(m, 1).me.shuList.find((x) => x.id === "base_01");
  if (!item || item.usable) throw new Error("被焚的蓄力应不可用");
  if (!/焚毁/.test(item.reason || "")) throw new Error(`原因应说明被焚毁，实际：${item.reason}`);
});

test("R59 焚术：对方出的是术系里的术 → 封掉整套术系", async () => {
  const { playableCards } = await import("../src/engine.mjs");
  const grp = raw.sets[0];                       // 不要叫 set：会盖住测试里的 set() 助手
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_28"];
  m.players[0].energy = toU(10);
  m.players[1].sets = [grp.id];
  m.players[1].tempCards = [];
  set(m, 1, { energy: toU(40) });
  resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_28" },
    1: { cardId: grp.cards[0].id },              // 术系里的具体术
  }, { answers: { 0: { banset_0: 1 } } });
  if (!m.bannedSets.includes(grp.id)) throw new Error("应封掉整套术系");
  const left = playableCards(m, m.players[1]);
  if (left.some((id) => grp.cards.some((c) => c.id === id))) throw new Error("被焚的术系不该还能打");
  // 但术系仍然"拥有"，只是被封 —— 状态栏要能看见
  const { viewFor } = await import("../src/view.mjs");
  const him = viewFor(m, 1).players[1];
  if (!him.sets.includes(grp.id)) throw new Error("封禁不等于没收，术系仍应记为拥有");
  if (!(him.statuses || []).some((x) => x.k === "ban")) throw new Error("状态栏应显示封禁标签");
});

test("R59 状态栏：天下太平护盾 / 天灾能耗加倍 / 装备失效 都会出标签", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 6 });
  m.buffs.noDamageTurns = 1;
  m.buffs.costMul = 2; m.buffs.costMulTurns = 2;
  m.buffs.equipDisabledTurns = 3;
  const st = viewFor(m, 0).players[0].statuses.map((x) => x.k);
  for (const k of ["shield", "costUp", "equipDown"]) {
    if (!st.includes(k)) throw new Error(`应出现 ${k} 状态，实际 ${st.join(",")}`);
  }
  m.buffs.noDamageTurns = 0; m.buffs.costMulTurns = 0; m.buffs.equipDisabledTurns = 0;
  const st2 = viewFor(m, 0).players[0].statuses.map((x) => x.k);
  if (st2.includes("shield") || st2.includes("costUp") || st2.includes("equipDown")) {
    throw new Error("效果结束后标签应自动消失");
  }
});

test("R59 阵亡：记录能量瓜分详情，供出局横幅显示", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 8 });
  m.players[1].hp = toU(0.5);
  m.players[1].energy = toU(6);
  set(m, 0, { energy: toU(10) });
  resolveTurn(m, {
    0: { cardId: "base_04" },        // 四阶攻击 4，打穿阈值 0
    1: { cardId: "base_01" },        // 蓄力
  });
  const dead = viewFor(m, 0).players[1];
  if (dead.alive) throw new Error("应已被淘汰");
  if (!dead.deadInfo) throw new Error("阵亡应给出能量瓜分说明");
  if (!/能量/.test(dead.deadInfo)) throw new Error(`说明应包含能量去向，实际：${dead.deadInfo}`);
});

test("R59 阵亡：座位卡渲染出「出局」遮罩，并带上能量去向", async () => {
  // web/ 下的 data.mjs 在 Node 里没有 web/data/*.json；浏览器是靠 data.bundle.js 注入的。
  // 测试里手动注入同一份数据，就能直接断言渲染结果。
  {
    const { raw: cr, fx: cf } = await import("../src/data.mjs");
    globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  }
  const { viewFor } = await import("../src/view.mjs");
  const { seatHtml } = await import("../web/board.mjs");
  const m = board(2, { turn: 8 });
  m.players[1].alive = false;
  m.elimLog = [{ seat: 1, pool: toU(4), gainers: [0], share: toU(2) }];
  const html = seatHtml(viewFor(m, 0), 1, { mySeat: 0 });
  if (!html.includes("dead-veil")) throw new Error("应渲染出局遮罩");
  if (!html.includes("dead-stamp")) throw new Error("应显示「出局」印章");
  if (!/能量/.test(html)) throw new Error("遮罩里应写明能量去哪了");
});

test("R59 状态栏：座位卡会把状态标签渲染出来", async () => {
  // web/ 下的 data.mjs 在 Node 里没有 web/data/*.json；浏览器是靠 data.bundle.js 注入的。
  // 测试里手动注入同一份数据，就能直接断言渲染结果。
  {
    const { raw: cr, fx: cf } = await import("../src/data.mjs");
    globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  }
  const { viewFor } = await import("../src/view.mjs");
  const { seatHtml } = await import("../web/board.mjs");
  const m = board(2, { turn: 6 });
  m.players[0].tempSets = [raw.sets[0].id];
  m.buffs.noDamageTurns = 1;
  // R74：状态改成卡片正下方的独立面板 .dock（不再是绝对定位浮层，避免被牌桌裁掉）
  const html = seatHtml(viewFor(m, 1), 0, { mySeat: 1 });
  if (!html.includes("dock")) throw new Error("应渲染状态面板");
  if (!html.includes("状态")) throw new Error("面板应有标题");
  if (!html.includes("临时术系")) throw new Error("应显示临时术系");
  if (!html.includes("不扣血庇护")) throw new Error("应显示护盾");
  if (!html.includes("strow")) throw new Error("状态应逐行渲染（装/术/禁/益 分组）");
});

// ---------- R60 天机：焚天直接扣血 / 返璞归真禁道牌 ----------

test("R60 焚天：不走 hit —— 不吃护心镜、不被天下太平豁免、不受封顶", async () => {
  const { applyTianjiCard } = await import("../src/engine.mjs");
  const m = board(3, { turn: 12 });
  m.players.forEach((p) => { p.hp = toU(3); p.energy = toU(6); });
  // 给 0 号穿护心镜（旧版会因此少扣），再开天下太平（旧版会完全免疫）
  m.players[0].equip = ["dao_01"];
  m.buffs.noDamageTurns = 1;
  const before = m.players.map((p) => p.hp);
  applyTianjiCard(m, raw.tianji.find((t) => t.id === "tj_19"));
  for (let i = 0; i < m.players.length; i++) {
    if (m.players[i].hp !== before[i] - toU(1)) {
      throw new Error(`焚天应直接扣 1 血（不吃护心镜、不被太平豁免），${i} 号从 ${fmt(before[i])} 变成 ${fmt(m.players[i].hp)}`);
    }
  }
});

test("R60 焚天：天机执行时当场判死并记录出局（不等到回合结算）", async () => {
  const { applyGraftedTianji } = await import("../src/engine.mjs");
  const m = board(3, { turn: 12 });
  m.players[0].hp = toU(0.5);
  m.players[0].energy = toU(4);
  m.pendingGraft = { id: "tj_19", name: "x", holder: 1 };
  const ev = applyGraftedTianji(m, { from: 2, to: 1 });
  if (m.players[0].alive) throw new Error("被焚天扣死的人应立刻出局");
  if (!ev.some((e) => e.t === "eliminate" && e.seat === 0)) throw new Error("应记录出局事件");
  const { viewFor } = await import("../src/view.mjs");
  const dead = viewFor(m, 1).players[0];
  if (dead.alive) throw new Error("对外视图也应显示已出局");
  if (!dead.deadInfo) throw new Error("应带上能量去向说明");
});

test("R60 返璞归真：道牌也失效（AI 不选、投影标不可用、引擎不结算）", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const { chooseDao } = await import("../src/ai.mjs");
  const m = board(2, { turn: 6 });
  m.players[0].hand = ["dao_21"];
  m.players[0].energy = toU(6);
  m.buffs.onlyBasicTurns = 1;

  const item = viewFor(m, 0).me.daoList.find((x) => x.id === "dao_21");
  if (item.usable) throw new Error("返璞归真期间道牌应标不可用");
  if (!/道牌失效/.test(item.reason || "")) throw new Error(`原因应说明道牌失效，实际：${item.reason}`);

  if (chooseDao(m, m.players[0]) !== null) throw new Error("AI 不该在这时候还要打道牌");

  // 引擎兜底：就算硬塞一张道牌也不生效（回春不回血）
  m.players[0].hp = toU(1);
  const before = m.players[0].hp;
  const ev = resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_21" }, 1: { cardId: "base_01" } });
  if (m.players[0].hp !== before) throw new Error("返璞归真期间道牌不该生效");
  if (!ev.some((e) => e.t === "daoVoid")) throw new Error("应记录一条「道牌失效」事件");
});

test("R61 中央天机坛只讲本回合：不再渲染「遗留效果」条（挪到个人状态栏）", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { tianjiHtml } = await import("../web/render.mjs");
  const html = tianjiHtml({
    tianji: { now: null, last: null },
    // 即使 view 里还带着全场效果，中央也不该画出来
    effects: [{ key: "noDamage", label: "万法不侵", desc: "本回合不扣血", turns: 1 }],
    pool: [],
  }, {});
  if (html.includes("legacy")) throw new Error("中央不该再有遗留效果容器");
  if (html.includes("万法不侵")) throw new Error("中央不该再重复显示全场效果");

  // 同样的效果要能在个人状态栏里看到
  const { viewFor } = await import("../src/view.mjs");
  const m = board(3, { turn: 4 });
  m.buffs.noDamageTurns = 1;
  const v = viewFor(m, 0);
  for (const p of v.players) {
    if (!(p.statuses || []).some((s) => s.k === "shield")) {
      throw new Error(`${p.name} 的状态栏应显示不扣血庇护`);
    }
  }
});

test("R74 状态面板：无状态也照样有一块面板（布局稳定，不用找）", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { seatHtml } = await import("../web/board.mjs");
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  // 清掉可能在开局被随机派发的状态（board() 里 startRound 已按原始身世发过临时术系）
  m.players[0].tempSets = []; m.players[0].equip = [];
  const html = seatHtml(viewFor(m, 0), 0, { mySeat: 0 });
  if (!html.includes("dock")) throw new Error("没状态时也要有面板容器");
  if (!/class="dock empty"/.test(html)) throw new Error("没状态时应带 empty 标记");
  if (!html.includes("dock-none")) throw new Error("没状态时应显示「无」");

  // 有状态：按类型渲染成行，且神装能点开看牌面
  m.players[0].equip = ["dao_02"];
  m.players[0].tempSets = [raw.sets[0].id];
  const h2 = seatHtml(viewFor(m, 0), 0, { mySeat: 0 });
  if (h2.includes("dock-none")) throw new Error("有状态时不该再显示「无」");
  if (!h2.includes('data-modal="dao_02"')) throw new Error("神装行应可点开牌面");
  if (!/t-equip/.test(h2)) throw new Error("神装行应带 t-equip 类型");
  if (!/t-temp/.test(h2)) throw new Error("临时术系应带 t-temp 类型");
  if (h2.indexOf("状态") > h2.indexOf("t-equip")) throw new Error("标题应在状态行之前");
});

test("R62 日志：局末/终局不会因为 roundIndex 已自增而多出一条错位记录", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { recordKeyFor } = await import("../web/panel.mjs");
  const newest = { round: 1, turn: 2 };            // 上一条记录：第1局·回合2
  // 局末这一刻投影是"第2局 + 上一局的回合2"，必须挂回最新那条
  const k = recordKeyFor({ round: 2, turn: 2 }, "roundEnd", newest);
  if (k.round !== 1 || k.turn !== 2) throw new Error(`局末应挂到最新记录，实际 ${k.round}-${k.turn}`);
  const k2 = recordKeyFor({ round: 2, turn: 2 }, "matchOver", newest);
  if (k2.round !== 1 || k2.turn !== 2) throw new Error("终局同样要挂回最新记录");
  // 正常阶段不受影响
  const k3 = recordKeyFor({ round: 2, turn: 1 }, "choose", newest);
  if (k3.round !== 2 || k3.turn !== 1) throw new Error("正常回合应使用自己的坐标");
  // 没有任何历史记录时也不能崩
  const k4 = recordKeyFor({ round: 1, turn: 1 }, "roundEnd", undefined);
  if (k4.round !== 1 || k4.turn !== 1) throw new Error("无历史时应退化为自身坐标");
});

// ---------- R63 道牌修复 ----------

test("R63 回春：只治疗一个目标，不再是全场奶", async () => {
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_21"];
  m.players[0].energy = toU(10);
  m.players[0].hp = toU(1);
  m.players[1].hp = toU(1);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_21" }, 1: { cardId: "base_01" } });
  if (m.players[0].hp !== toU(3)) throw new Error(`自己应回到 3 血，实际 ${fmt(m.players[0].hp)}`);
  if (m.players[1].hp !== toU(1)) throw new Error("别人不该被治疗");
});

test("R63 献祭：真的掉 1 血换 3 能量（原先这个原子没实现，是空牌）", async () => {
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_25"];
  m.players[0].hp = toU(3);
  m.players[0].energy = toU(4);
  resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_25" }, 1: { cardId: "base_01" } });
  // 蓄力本身 +1，献祭 −1 血 +3 能
  if (m.players[0].hp !== toU(2)) throw new Error(`献祭应掉 1 血，实际 ${fmt(m.players[0].hp)}`);
  if (m.players[0].energy !== toU(4 + 1 + 3)) throw new Error(`能量应 4+1+3=8，实际 ${fmt(m.players[0].energy)}`);
});

test("R63 破防：本回合自己的攻击数值翻倍，且下一回合恢复", async () => {
  const { beginTurn } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_23"];
  m.players[0].energy = toU(20);
  const ev = resolveTurn(m, { 0: { cardId: "base_03", daoId: "dao_23" }, 1: { cardId: "base_01" } });
  const line = ev.find((e) => e.t === "line");
  if (!line || line.value !== "4") throw new Error(`二阶攻击 2 翻倍应为 4，实际 ${line && line.value}`);
  beginTurn(m);
  if (m.players[0].selfBuffs.atkMulTurns !== 0) throw new Error("自我倍率应在下一回合清掉");
  if (m.players[0].selfBuffs.atkMul !== 1) throw new Error("倍率应复位成 1");
});

test("R63 泣血珠 / 聚灵玉环：按「造成伤害」结算给攻方，不再给挨打的人", async () => {
  const mk = (equip) => {
    const m = board(2, { turn: 4 });
    m.players[0].equip = equip;
    m.players[0].hp = toU(1);
    m.players[0].energy = toU(10);
    return m;
  };
  const a = mk(["dao_09"]);                       // 泣血珠：每次有效伤害回 0.5 血
  resolveTurn(a, { 0: { cardId: "base_04" }, 1: { cardId: "base_01" } });
  if (a.players[0].hp !== toU(1.5)) throw new Error(`攻方应回 0.5 血，实际 ${fmt(a.players[0].hp)}`);

  const b = mk(["dao_04"]);                       // 聚灵玉环：每次有效伤害回 1 能量
  resolveTurn(b, { 0: { cardId: "base_04" }, 1: { cardId: "base_01" } });
  if (b.players[0].energy !== toU(10 - 4 + 1)) throw new Error(`攻方应回 1 能量，实际 ${fmt(b.players[0].energy)}`);

  const c = mk(["dao_09"]);                       // 反例：挨打的人带泣血珠不该回血
  resolveTurn(c, { 0: { cardId: "base_01" }, 1: { cardId: "base_04" } });
  if (c.players[0].hp > toU(1)) throw new Error("挨打的人不该因为戴了泣血珠就回血");
});

// ---------- R64 原子实现覆盖率自检 ----------

test("R64 原子自检：每张牌用到的原子都有人实现、都已登记、牌不会从池子里消失", async () => {
  const { auditAtoms } = await import("../tools/atom_audit.mjs");
  const { raw: cr, fx: cf, SUPPORTED_ATOMS, isImplemented } = await import("../src/data.mjs");
  const D2 = { raw: cr, fx: cf, SUPPORTED_ATOMS, isImplemented };
  const r = auditAtoms(D2);
  const lines = [];
  for (const x of r.orphans) lines.push(`没人认领：${x.atom} ← ${x.owners.slice(0, 3).join("、")}`);
  for (const x of r.unsupported) lines.push(`未登记 SUPPORTED_ATOMS：${x.atom}`);
  for (const x of r.unimplemented) lines.push(`被判为未实现：${x}`);
  if (lines.length) throw new Error(lines.join("；"));
  if (r.atomCount < 30) throw new Error(`原子数异常偏少（${r.atomCount}），自检可能没读到数据`);
});

test("R64 原子自检本身要能被验证：塞一个假原子必须报错", async () => {
  const { auditAtoms } = await import("../tools/atom_audit.mjs");
  const fake = {
    raw: { dao: [{ id: "x1", name: "假牌" }], tianji: [], sets: [], birth: [] },
    fx: { cards: { x1: { atoms: [{ atom: "definitelyNotAnAtom" }] } }, birth: {} },
    SUPPORTED_ATOMS: new Set(["definitelyNotAnAtom"]),
    isImplemented: () => true,
  };
  const r = auditAtoms(fake);
  if (r.ok) throw new Error("假原子应让自检失败");
  if (!r.orphans.some((o) => o.atom === "definitelyNotAnAtom")) {
    throw new Error("应把假原子列为「没人认领」");
  }
});

test("R64 原子自检：道牌与天机不允许出现「一个原子都没挂」的空牌", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  const empty = [];
  for (const d of cr.dao) if (!(cf.cards[d.id]?.atoms || []).length) empty.push(`道牌·${d.name}`);
  for (const t of cr.tianji) if (!(cf.cards[t.id]?.atoms || []).length) empty.push(`天机·${t.name}`);
  if (empty.length) throw new Error(`这些牌没有任何原子，运行时必然静默无效：${empty.join("、")}`);
});

test("R64 溯流光：揭示后能把这一手换成另一张术（费用不超首出，且能救场）", async () => {
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_33"];
  m.players[0].energy = toU(10);
  set(m, 1, { energy: toU(10) });               // 对方也得付得起二阶攻击，否则这回合没人攻击、没有胜者线
  const ev = resolveTurn(m, {
    0: { cardId: "base_02", daoId: "dao_33" },   // 一阶普攻，费 1
    1: { cardId: "base_03" },                    // 二阶攻击 2
  }, { answers: { 0: { replay_0: "base_10" } } });   // 换成普通防御（费 0 ≤ 1）
  if (!ev.some((e) => e.t === "replay" && e.seat === 0)) throw new Error("应记录一条重出事件");
  const line = ev.find((e) => e.t === "line");
  if (!line || line.value !== "2") throw new Error(`胜者线应只剩对方的 2，实际 ${line && line.value}`);
  if (ev.some((e) => e.t === "hit" && e.target === 0)) throw new Error("换成防御 3 后不该被打中");
  if (ev.some((e) => e.t === "fail" && e.seat === 0)) throw new Error("换成防御后不再参与判定，不该判定失败");
});

test("R64 溯流光：不作答就等于不换（原牌排在候选第一位）", async () => {
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_33"];
  m.players[0].energy = toU(10);
  const ev = resolveTurn(m, {
    0: { cardId: "base_03", daoId: "dao_33" },
    1: { cardId: "base_01" },
  });
  if (ev.some((e) => e.t === "replay")) throw new Error("没作答时不该发生重出");
  const line = ev.find((e) => e.t === "line");
  if (!line || line.value !== "2") throw new Error(`应保持原牌（二阶攻击 2），实际 ${line && line.value}`);
});

test("R64 溯流光：不能借重出升档（昂贵牌不在候选里）", async () => {
  const { collectPrompts } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_33"];
  m.players[0].energy = toU(40);
  const prompts = collectPrompts(m, {
    0: { cardId: "base_02", daoId: "dao_33" },   // 只付了 1 费
    1: { cardId: "base_01" },
  });
  const spec = prompts.find((x) => x.id === "replay_0");
  if (!spec) throw new Error("应收集到重出追问");
  if (!spec.pool.includes("base_02")) throw new Error("原牌必须在候选里（否则没法「不换」）");
  if (spec.pool.includes("base_04")) throw new Error("四阶攻击（费 4）不该出现在只付了 1 费的候选里");
});

test("R66 站内教程：两个入口都挂了「教程」按钮 + 弹层，教程文件也在 web/ 下", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const WEB = path.join(process.cwd(), "web");
  for (const page of ["online.html", "index.html"]) {
    const html = fs.readFileSync(path.join(WEB, page), "utf8");
    if (!html.includes('id="btn-tutorial"')) throw new Error(`${page} 缺「教程」按钮`);
    if (!html.includes('id="doc-overlay"')) throw new Error(`${page} 缺教程弹层容器`);
    if (!html.includes('id="doc-frame"')) throw new Error(`${page} 缺 iframe`);
    if (!html.includes("docview.js")) throw new Error(`${page} 没引入 docview.js`);
  }
  const tour = path.join(WEB, "tutorial.html");
  if (!fs.existsSync(tour)) throw new Error("web/tutorial.html 不存在（教程打不开）");
  const t = fs.readFileSync(tour, "utf8");
  if (!t.includes("玩家教程")) throw new Error("web/tutorial.html 内容不对");
  if (t.length < 8000) throw new Error(`web/tutorial.html 太小（${t.length}），可能被截断`);
});

test("R67 拍卖：没出价按 0 计，结果事件里带上所有人的出价", async () => {
  const { peekAuction, auctionIfDue } = await import("../src/engine.mjs");
  const m = board(3, { turn: 4 });            // auctionTurn = m.turn + 1 = 5，正好开拍
  for (const p of m.players) p.energy = toU(10);
  const offerId = peekAuction(m);
  if (!offerId) throw new Error("第 5 回合应开拍");
  // 只给 0 号报了个 2，其他两人「超时未出价」
  const ev = auctionIfDue(m, { offerId, bids: { 0: 2 } });
  const res = ev.find((e) => e.t === "auctionResult");
  if (!res) throw new Error("应产出 auctionResult 事件");
  if (res.bids.length !== 3) throw new Error(`应列出全部 3 人的出价，实际 ${res.bids.length}`);
  const others = res.bids.filter((b) => b.seat !== 0);
  if (others.some((b) => b.bid !== 0)) throw new Error("没出价的人应按 0 计");
  const win = ev.find((e) => e.t === "auctionWin");
  if (!win || win.seat !== 0) throw new Error("只有 0 号出价，应由他拍得");
});

test("R67 拍卖：出价全为 0 时判定流拍", async () => {
  const { peekAuction, auctionIfDue } = await import("../src/engine.mjs");
  const m = board(3, { turn: 4 });
  for (const p of m.players) p.energy = toU(10);
  const offerId = peekAuction(m);
  const ev = auctionIfDue(m, { offerId, bids: {} });
  const res = ev.find((e) => e.t === "auctionResult");
  if (!res || res.kind !== "unsold" || res.reason !== "noBid") throw new Error("应判定为无人出价流拍");
  if (ev.some((e) => e.t === "auctionWin")) throw new Error("流拍不该有人拍得");
  const before = m.players.map((p) => p.energy);
  if (m.players.some((p, i) => p.energy !== before[i])) throw new Error("流拍不该扣任何人的能量");
});

test("R67 拍卖流程：结算后先进 3 秒结果公示，再开回合（源码契约）", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const room = fs.readFileSync(path.join(process.cwd(), "server", "room.mjs"), "utf8");
  if (!room.includes("auctionResult: FAST ? 300 : 3000")) throw new Error("缺少 auctionResult 的 3 秒计时");
  if (!room.includes('room.phase = "auctionResult"')) throw new Error("结算后应切到 auctionResult 阶段");
  if (!room.includes("summarizeAuction")) throw new Error("应把出价收敛成可渲染的结果对象");
  if (!room.includes("auctionResult: room.phase === \"auctionResult\"")) throw new Error("快照里应下发 auctionResult");

  const board = fs.readFileSync(path.join(process.cwd(), "web", "board.mjs"), "utf8");
  if (!board.includes("auctionResultHtml")) throw new Error("中央应渲染拍卖结果块");
  const online = fs.readFileSync(path.join(process.cwd(), "web", "online.mjs"), "utf8");
  if (!online.includes("bid-left")) throw new Error("出价弹窗应有倒计时");
});

// ---------- R68 多人博弈：过程与结果都要能看见 ----------

test("R68 囚徒困境：事件带上每个人的选择、结果说明与各自得失", async () => {
  const m = board(3, { turn: 4 });
  m.players[0].hand = ["dao_12"];
  m.players[0].energy = toU(10);
  for (const p of m.players) if (p.hp < toU(3)) p.hp = toU(3);
  const ev = resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_12" },
    1: { cardId: "base_01" },
    2: { cardId: "base_01" },
  }, { answers: { 1: { pri_1: "不认罪" }, 2: { pri_2: "认罪" } } });
  const sg = ev.find((e) => e.t === "subgame" && e.kind === "prisoner");
  if (!sg) throw new Error("应产出囚徒困境事件");
  if ((sg.picks || []).length !== 2) throw new Error(`应记录两人的选择，实际 ${(sg.picks || []).length}`);
  if (!sg.outcome) throw new Error("应带一句结果说明");
  if (!(sg.delta || []).length) throw new Error("应带每个人的得失");
  const c = sg.picks.find(([s]) => s === 2);
  if (!c || c[1] !== "认罪") throw new Error("应记录 2 号选了「认罪」");
});

test("R68 收割 / 狭路相逢：同样记录选择与得失", async () => {
  const m = board(3, { turn: 4 });
  m.players[0].hand = ["dao_19"];
  m.players[0].energy = toU(10);
  const ev = resolveTurn(m, {
    0: { cardId: "base_01", daoId: "dao_19" },
    1: { cardId: "base_01" },
    2: { cardId: "base_01" },
  }, { answers: { 1: { har_1: "跌" }, 2: { har_2: "跌" } } });
  const sg = ev.find((e) => e.t === "subgame" && e.kind === "harvest");
  if (!sg) throw new Error("应产出收割事件");
  if ((sg.picks || []).length !== 3) throw new Error("三个人都该被记录选择");
  if (!sg.outcome) throw new Error("应说明少数派是哪边");
  if (!(sg.delta || []).length) throw new Error("应带各自能量变化");

  const m2 = board(3, { turn: 4 });
  m2.players[0].hand = ["dao_17"];
  m2.players[0].energy = toU(10);
  const ev2 = resolveTurn(m2, {
    0: { cardId: "base_01", daoId: "dao_17" },
    1: { cardId: "base_01" }, 2: { cardId: "base_01" },
  }, { answers: { 1: { chk_1: "冲" }, 2: { chk_2: "让" } } });
  const sg2 = ev2.find((e) => e.t === "subgame" && e.kind === "chicken");
  if (!sg2 || !sg2.outcome) throw new Error("狭路相逢应带结果说明");
  if (!(sg2.picks || []).length) throw new Error("狭路相逢应记录选择");
});

test("R68 渲染：博弈过程卡与事件文案都不为空", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { subgameHtml, eventLine } = await import("../web/render.mjs");
  const sg = {
    t: "subgame", kind: "prisoner",
    picks: [[0, "认罪"], [1, "不认罪"]],
    outcome: "1 号认罪 +2 能量，其余各被罚 4 能量",
    delta: [{ seat: 0, hp: "0", energy: "-2" }, { seat: 1, hp: "0", energy: "2" }],
    by: 0, byGain: "0",
  };
  const html = subgameHtml({}, { names: ["甲", "乙"], events: [sg] });
  if (!html.includes("sg-card")) throw new Error("应渲染博弈卡");
  if (!html.includes("囚徒困境")) throw new Error("应显示玩法名");
  if (!/认罪/.test(html) || !/不认罪/.test(html)) throw new Error("应显示每个人的选择");
  if (!/罚 4 能量/.test(html)) throw new Error("应显示结果");
  if (!/能 -2/.test(html)) throw new Error(`应显示各自得失，实际：${html.slice(0, 200)}`);

  const line = eventLine(sg, ["甲", "乙"]);
  if (!line || !/囚徒困境/.test(line)) throw new Error("事件记录应输出囚徒困境一行");
  if (!/甲/.test(line) || !/乙/.test(line)) throw new Error("事件记录应带两个人");

  const soul = { t: "soulSwap", a: 0, b: 1, swapHp: true, swapEn: true,
    picks: [[0, "血量"], [1, "血量"]],
    before: { a: { hp: "4", en: "2" }, b: { hp: "1", en: "8" } },
    after: { a: { hp: "1", en: "8" }, b: { hp: "4", en: "2" } }, by: 0 };
  const h2 = subgameHtml({}, { names: ["甲", "乙"], events: [soul] });
  if (!h2.includes("移魂术")) throw new Error("移魂术也要有卡");
  if (!/4\/2 → 1\/8/.test(h2)) throw new Error("移魂术应显示交换前后的数值");
  if (!eventLine(soul, ["甲", "乙"])) throw new Error("移魂术应有事件文案");
});

// ---------- R69 决策期不得提前亮出别人的选择 ----------

test("R69 中央选卡：choose / prompt 阶段绝不画博弈过程卡，只有 reveal 才公示", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { centerCardHtml } = await import("../web/board.mjs");
  const sg = {
    t: "subgame", kind: "prisoner",
    picks: [[0, "认罪"], [1, "不认罪"]], outcome: "甲认罪 +2",
    delta: [{ seat: 0, energy: "-2" }], by: 0, byGain: "0",
  };
  const v = { tianji: { now: null, last: null }, pool: [] };
  const ctx = { phase: "choose", names: ["甲", "乙"], events: [sg] };
  for (const phase of ["choose", "prompt", "discard", "auction", "births", "tempDraw", "setDraftEnd"]) {
    const html = centerCardHtml(v, { ...ctx, phase });
    if (html.includes("sg-card")) throw new Error(`「${phase}」阶段不该出现博弈过程卡`);
    if (/认罪/.test(html)) throw new Error(`「${phase}」阶段不该出现别人的选择`);
  }
  // 揭示之后才公示
  const shown = centerCardHtml(v, { ...ctx, phase: "reveal" });
  if (!shown.includes("sg-card")) throw new Error("揭示阶段应公示博弈过程");
  if (!/认罪/.test(shown)) throw new Error("揭示阶段应能看到各自的选择");
});

test("R69 决策期的提示词是问自己的选择，措辞不含别人的结果", async () => {
  const { collectPrompts } = await import("../src/engine.mjs");
  const m = board(3, { turn: 4 });
  m.players[0].hand = ["dao_12"];
  m.players[0].energy = toU(10);
  const prompts = collectPrompts(m, {
    0: { cardId: "base_01", daoId: "dao_12" },
    1: { cardId: "base_01" }, 2: { cardId: "base_01" },
  });
  const mine = prompts.filter((x) => x.id.startsWith("pri_"));
  if (mine.length !== 2) throw new Error(`应只给两名参与者各一条，实际 ${mine.length}`);
  for (const p of mine) {
    if (!/认罪/.test(p.label) && !/抵赖/.test(p.label)) {
      throw new Error(`提示词应说清在问什么，实际：${p.label}`);
    }
    if (/认罪/.test(p.label) && /不认罪/.test(p.label) && p.label.includes("人机")) {
      throw new Error("提示词不该出现别人的名字/选择");
    }
  }
});

test("R69 联机追问按座位过滤：每个人只收到自己的那一条", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  let err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1"); R.submitBirthAck(room, "c2");
  for (let i = 0; i < 600 && room.phase !== "choose"; i++) await sleep(4);
  try {
    // 造一个"两人都有追问"的现场
    room.phase = "prompt";
    room.turnPrompts = [
      { seat: 0, id: "pri_0", type: "subgame", label: "囚徒困境", options: ["认罪", "不赖账"] },
      { seat: 1, id: "pri_1", type: "subgame", label: "囚徒困境", options: ["认罪", "不赖账"] },
    ];
    room.pendingAnswers = {};
    const a = R.snapshotFor(room, "c1");
    const b = R.snapshotFor(room, "c2");
    if (a.prompts.length !== 1 || a.prompts[0].id !== "pri_0") throw new Error("c1 只该看到自己的追问");
    if (b.prompts.length !== 1 || b.prompts[0].id !== "pri_1") throw new Error("c2 只该看到自己的追问");
    if (JSON.stringify(a.prompts).includes("pri_1")) throw new Error("c1 的截图里不该出现别人的追问");
  } finally {
    R.destroyRoom(room);
  }
});

// ---------- R70 大厅编制文案 / 手机横屏紧凑布局 ----------

test("R70 大厅人数预设：标签必须等于真实编制（不许再出现 3v3 / 4v4）", async () => {
  const { CFG_OPTIONS, labelMatchesConfig } = await import("../web/lobby-config.mjs");
  const { CONFIG } = await import("../src/config.mjs");
  if (!CFG_OPTIONS.length) throw new Error("应有预设");
  for (const o of CFG_OPTIONS) {
    if (o.per > CONFIG.maxMembersPerFaction) {
      throw new Error(`${o.label} 每势力 ${o.per} 人，超过上限 ${CONFIG.maxMembersPerFaction}`);
    }
    if (!labelMatchesConfig(o)) {
      throw new Error(`标签「${o.label}」和真实编制不符（${o.factions} 势力 × ${o.per} 人）`);
    }
  }
  const labels = CFG_OPTIONS.map((o) => o.label);
  for (const bad of ["3v3", "4v4"]) {
    if (labels.some((l) => l.split("v").length === 2 && l.startsWith(bad[0]))) {
      throw new Error(`不该再出现「${bad}」这种错误编制`);
    }
  }
  // 6 人必须是 3 队 × 2，8 人必须是 4 队 × 2
  const six = CFG_OPTIONS.find((o) => o.factions * o.per === 6);
  if (!six || six.label !== "2v2v2") throw new Error(`6 人局应标成 2v2v2，实际 ${six && six.label}`);
  const eight = CFG_OPTIONS.find((o) => o.factions * o.per === 8);
  if (!eight || eight.label !== "2v2v2v2") throw new Error(`8 人局应标成 2v2v2v2，实际 ${eight && eight.label}`);
});

test("R70 座位卡：同时输出完整卡与紧凑条，紧凑条带血/能/道", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { seatHtml } = await import("../web/board.mjs");
  const { viewFor } = await import("../src/view.mjs");
  const m = board(4, { turn: 4 });
  const html = seatHtml(viewFor(m, 0), 1, { mySeat: 0 });
  if (!html.includes("seat-v full")) throw new Error("应保留完整卡变体");
  if (!html.includes("seat-v mini")) throw new Error("应输出紧凑条变体（手机横屏用）");
  if (!html.includes("seatcard mini")) throw new Error("紧凑条应带 seatcard mini 类");
  if (!/mn-sub/.test(html)) throw new Error("紧凑条应有身世/术系那行小字");
  const mini = html.slice(html.indexOf("seat-v mini"));
  for (const k of ["血", "能", "道"]) {
    if (!mini.includes(k)) throw new Error(`紧凑条应显示「${k}」`);
  }
});

// ---------- R71 局间推进必须重走「局初」流程 ----------

test("R71/R72 第 2 局起官宦子弟仍会自动随机拿术系，并有 3 秒公示", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const D2 = await import("../src/data.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  const err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1"); R.submitBirthAck(room, "c2");
  for (let i = 0; i < 600 && room.phase !== "choose"; i++) await sleep(4);
  try {
    const m = room.match;
    // 造一个"第 1 局刚结束、0 号是官宦子弟（且人机）"的现场
    m.players[0].birth = "birth_03";
    m.roundIndex = 0;
    room.seats[0].kind = "ai";                 // 人机：不该等任何人
    room.phase = "roundEnd";
    R.nextRound(room);
    if (room.phase !== "tempDraw") {
      throw new Error(`第 2 局应进入 tempDraw（抽取公示），实际 ${room.phase}`);
    }
    const snap = R.snapshotFor(room, "c1");
    if (!(snap.tempDraw || []).length) throw new Error("应公示谁抽到了哪套");
    if (snap.tempDraw[0].seat !== 0) throw new Error("公示的应是官宦子弟那一栏");
    if (!(m.players[0].tempSets || []).length) throw new Error("应已随机发放一套");
    if (!D2.setById(m.players[0].tempSets[0])) throw new Error("发出来的应是合法术集");
    // 公示结束后应进入正常回合
    for (let i = 0; i < 300 && room.phase === "tempDraw"; i++) await sleep(4);
    if (room.phase === "tempDraw") throw new Error("公示不该卡住");
  } finally {
    R.destroyRoom(room);
  }
});

test("R71 没有官宦子弟时，局间推进不能卡住", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  const err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1"); R.submitBirthAck(room, "c2");
  for (let i = 0; i < 600 && room.phase !== "choose"; i++) await sleep(4);
  try {
    const m = room.match;
    for (const p of m.players) p.birth = "birth_06";   // 平民子弟，没有 tempSet
    m.roundIndex = 0;
    room.phase = "roundEnd";
    R.nextRound(room);
    for (let i = 0; i < 200 && room.phase === "roundEnd"; i++) await sleep(4);
    if (room.phase === "tempDraw") throw new Error("没人有特权时不该进 tempDraw");
    if (!["starting", "births", "choose", "auction", "tianjiExec", "prompt"].includes(room.phase)) {
      throw new Error(`局间推进后阶段异常：${room.phase}`);
    }
  } finally {
    R.destroyRoom(room);
  }
});

// ---------- R72 术系轮抽 / 官宦子弟随机抽取 ----------

test("R73 轮抽顺序：活得越久越先挑（滚雪球），死得早的排后面", async () => {
  const { draftStateOf } = await import("../src/engine.mjs");
  const m = board(4, { turn: 4 });
  // 0 号第 2 回合死、1 号第 6 回合死、2/3 活到最后（第 9 回合）
  m.players[0].alive = false; m.players[0].roundStats.survivedTurns = 2;
  m.players[1].alive = false; m.players[1].roundStats.survivedTurns = 6;
  m.players[2].roundStats.survivedTurns = 9;
  m.players[3].roundStats.survivedTurns = 9;
  endRound(m, { autoDraft: false });
  const st = draftStateOf(m);
  const ids = st.order.map((o) => o.factionId);
  if (![2, 3].includes(ids[0]) || ![2, 3].includes(ids[1])) {
    throw new Error(`活到最后的应排最前，实际顺序 ${ids.join(">")}`);
  }
  if (ids[2] !== 1) throw new Error(`第 6 回合出局的应排第三，实际 ${ids.join(">")}`);
  if (ids[3] !== 0) throw new Error(`死得最早的最后挑，实际 ${ids.join(">")}`);
  // 顺位说明：存活优先、其次存活回合数降序
  for (let i = 1; i < st.order.length; i++) {
    const a = st.order[i - 1], b = st.order[i];
    if (a.alive !== b.alive) {
      if (!a.alive) throw new Error("存活的势力必须排在已淘汰的前面");
    } else if (a.survived < b.survived) {
      throw new Error(`顺位应按存活回合数降序：${a.survived} < ${b.survived}`);
    }
  }
});

test("R73 代表制：同势力多人不同时淘汰 → 由最后被淘汰的人决定", async () => {
  const { draftStateOf } = await import("../src/engine.mjs");
  const m = allyBoard();                       // 2 势力 × 2 人
  m.tianji.firedThisTurn = true;
  // 势力 0 = 座位 0/1：0 号第 4 回合死，1 号第 8 回合死（更晚 → 由 1 号决定）
  const f0 = m.factions.find((f) => f.members.includes(0));
  const other = f0.members.find((s) => s !== 0);
  m.players[0].alive = false; m.players[0].roundStats.survivedTurns = 4;
  m.players[other].alive = false; m.players[other].roundStats.survivedTurns = 8;
  for (const f of m.factions) {
    if (f === f0) continue;
    for (const s of f.members) { m.players[s].alive = false; m.players[s].roundStats.survivedTurns = 9; }
  }
  endRound(m, { autoDraft: false });
  const st = draftStateOf(m);
  const row = st.order.find((o) => o.factionId === f0.id);
  if (!row) throw new Error("势力 0 应在顺位里");
  if (row.rep !== other) throw new Error(`应由较晚淘汰的 ${other} 号决定，实际 ${row.rep}`);
  if (row.repSurvived !== 8) throw new Error(`代表的存活回合应为 8，实际 ${row.repSurvived}`);
  if (row.survived !== 8) throw new Error("势力存活时长取成员最大值（8）");
});

test("R73 代表制：同势力多人同时淘汰 → 在并列者之间随机挑一个", async () => {
  const { draftStateOf } = await import("../src/engine.mjs");
  const seen = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const m = createMatch({ seats: [{ name: "A" }, { name: "B" }], seed });
    startRound(m);
    m.tianji.firedThisTurn = true;
    for (const p of m.players) { p.alive = false; p.roundStats.survivedTurns = 5; }   // 同时淘汰
    endRound(m, { autoDraft: false });
    const row = draftStateOf(m).order[0];
    if (![0, 1].includes(row.rep)) throw new Error("代表应来自该势力成员");
    if (row.repSurvived !== 5) throw new Error("代表存活回合应为 5");
    seen.add(row.rep);
  }
  if (seen.size < 2) throw new Error(`同时淘汰时应在成员间随机，24 组只出现 ${[...seen]} —— 说明固定成了某人`);
});

test("R72 轮抽：每势力只挑 1 套，挑走的从池子移出；重复只转 2 能量且不消耗池子", async () => {
  const { applySetPick, nextDraftFaction, draftStateOf } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.roundOver = true;
  endRound(m, { autoDraft: false });
  const d = m.setDraft;
  const first = nextDraftFaction(m);
  const picked = applySetPick(m, first, d.pool[0]);
  if (!picked || picked.note !== "picked") throw new Error("第一次应正常挑走");
  const f0 = m.factions.find((x) => x.id === first);
  if (f0.sets.length !== 1) throw new Error("应只拿到 1 套");
  if (draftStateOf(m).pool.includes(picked.setId)) throw new Error("挑走的应从池子里移出");

  // 第二个势力：手里已经塞满 3 套 -> 只能转能量
  const second = nextDraftFaction(m);
  const f1 = m.factions.find((x) => x.id === second);
  f1.sets = ["b1s1", "b1s2", "b1s3"];
  const before = m.players[f1.members[0]].energy;
  const poolBefore = [...m.setDraft.pool];
  const r2 = applySetPick(m, second, null);
  if (r2.note !== "convert") throw new Error(`超上限应转能量，实际 ${r2.note}`);
  if (m.players[f1.members[0]].energy !== before + toU(2)) throw new Error("应给 2 能量");
  if (m.setDraft.pool.length !== poolBefore.length) throw new Error("超上限不该消耗池子（后面的人还能拿）");
  if (f1.sets.length !== 3) throw new Error("不该超过 3 套上限");
});

test("R72 轮抽：不是当前顺位的势力点不了", async () => {
  const { applySetPick, draftStateOf } = await import("../src/engine.mjs");
  const m = board(3, { turn: 4 });
  m.roundOver = true;
  endRound(m, { autoDraft: false });
  const st = draftStateOf(m);
  const bystander = st.order.map((o) => o.factionId).find((id) => id !== st.current);
  const r = applySetPick(m, bystander, st.pool[0]);
  if (r !== null) throw new Error("没轮到它却挑成功，顺位校验失效");
});

test("R72 服务端：局末先进轮抽，真人挑完才公示、再进下一局", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  const err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1"); R.submitBirthAck(room, "c2");
  for (let i = 0; i < 800 && room.phase !== "choose"; i++) await sleep(4);
  try {
    const m = room.match;
    m.roundOver = true;
    R.finishRound(room);                       // 走真实的局末流程
    if (room.phase !== "roundEnd") throw new Error(`局末应先进 roundEnd 汇总，实际 ${room.phase}`);
    if (!m.setDraft) throw new Error("endRound 应建好轮抽状态");
    for (let i = 0; i < 900 && room.phase !== "setDraft" && room.phase !== "setDraftEnd"; i++) await sleep(4);
    if (room.phase !== "setDraft" && room.phase !== "setDraftEnd") {
      throw new Error(`局末应进入轮抽，实际 ${room.phase}`);
    }
    // 等轮到"我"这一家（人机势力会自动挑掉，可能先轮到对方）
    let mine = null;
    for (let i = 0; i < 1200 && room.phase === "setDraft"; i++) {
      const snap = R.snapshotFor(room, "c1");
      if (!snap.setDraft || !snap.setDraft.order.length) throw new Error("快照里应带轮抽顺序");
      if (snap.draftTurn?.mine) { mine = snap; break; }
      await sleep(4);
    }
    if (room.phase === "setDraft") {
      if (!mine) throw new Error("一直没轮到真人挑");
      // 不该轮到的那一家去点 -> 必须被拒
      const otherId = mine.draftTurn.seat === 0 ? "c2" : "c1";
      const wrong = R.submitSetDraft(room, otherId, mine.setDraft.pool[0]);
      if (!wrong) throw new Error("不该轮到它时却挑成功了");
      const e2 = R.submitSetDraft(room, "c1", mine.setDraft.pool[0]);
      if (e2) throw new Error(e2);
    }
    for (let i = 0; i < 900 && room.phase === "setDraft"; i++) await sleep(4);
    const anySet = m.factions.some((f) => f.sets.length > 0);
    if (!anySet) throw new Error("轮抽结束后应该有势力拿到术系");
  } finally {
    R.destroyRoom(room);
  }
});

test("R72 官宦子弟：同时随机抽取，互不排斥（可重复），且公示给所有人", async () => {
  const m = createMatch({ seats: [{ name: "A" }, { name: "B" }], seed: 11 });
  for (const p of m.players) p.birth = "birth_03";      // 两人都是官宦子弟
  startRound(m);                                         // 默认 autoTemp：各自随机，不问也不排序
  const a = m.players[0].tempSets || [];
  const b = m.players[1].tempSets || [];
  if (a.length !== 1 || b.length !== 1) throw new Error("两人都应各拿到 1 套");
  if (!a[0] || !b[0]) throw new Error("拿到的应是合法术集");
  // "可重复"：同一套被两个人同时拿到是允许的 —— 换多组种子必然出现撞车
  let clash = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const mm = createMatch({ seats: [{ name: "A" }, { name: "B" }], seed });
    for (const p of mm.players) p.birth = "birth_03";
    startRound(mm);
    if (mm.players[0].tempSets[0] === mm.players[1].tempSets[0]) clash += 1;
  }
  if (!clash) throw new Error("30 组里一次都没撞同一套，说明实现里可能偷偷做了去重");
});

test("R72 渲染：轮抽卡显示顺位与出局回合，抽取公示显示谁拿到哪套", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { setDraftHtml, tempDrawHtml, eventLine } = await import("../web/render.mjs");
  const { centerCardHtml } = await import("../web/board.mjs");

  const sd = {
    order: [
      { factionId: 0, members: [0], alive: false, survived: 3, setId: "b1s1", note: "picked", state: "done" },
      { factionId: 1, members: [1], alive: true, survived: 9, setId: null, note: null, state: "current" },
    ],
    pool: ["b1s2", "b1s3"], total: 4, idx: 1, current: 1,
  };
  const html = setDraftHtml({}, { setDraft: sd, names: ["甲", "乙"] });
  if (!html.includes("sd-card")) throw new Error("应渲染轮抽卡");
  if (!/第 3 回合出局/.test(html)) throw new Error("应标出「淘汰早晚」的依据");
  if (!/挑选中/.test(html)) throw new Error("应标出当前正在挑的那一家");
  if (!/b1s2/.test(html) && !html.includes("sd-pool")) throw new Error("应列出剩余池子");

  const td = tempDrawHtml({}, { tempDraw: [{ seat: 0, name: "天马", cards: 6 }], names: ["甲"] });
  if (!td.includes("td-card") || !/天马/.test(td)) throw new Error("应渲染抽取公示");
  if (!/互不影响/.test(td)) throw new Error("应说明「各自随机、可能撞同一套」");

  // 阶段隔离：只有 setDraft / setDraftEnd 才画轮抽卡
  const v = { tianji: { now: null }, pool: [] };
  for (const phase of ["choose", "prompt", "reveal", "auction", "births", "tempDraw"]) {
    if (centerCardHtml(v, { phase, setDraft: sd, names: ["甲", "乙"] }).includes("sd-card")) {
      throw new Error(`「${phase}」阶段不该画轮抽卡`);
    }
  }
  for (const phase of ["setDraft", "setDraftEnd"]) {
    if (!centerCardHtml(v, { phase, setDraft: sd, names: ["甲", "乙"] }).includes("sd-card")) {
      throw new Error(`「${phase}」阶段应画轮抽卡`);
    }
  }

  const line = eventLine({ t: "setDraft", names: ["甲"], name: "天马", note: "picked", left: 2 }, ["甲"]);
  if (!/术系轮抽|天马/.test(line)) throw new Error("轮抽应有一行日志");
  const conv = eventLine({ t: "setDraft", names: ["甲"], name: "天马", note: "convert" }, ["甲"]);
  if (!/转 2 能量/.test(conv)) throw new Error("超上限应写清转能量");
});

// ---------- R74 平民子弟：实时血能转换 ----------

test("R74 引擎：1 血 ↔ 2 能量，可反复来回换，血量不会掉到 0", async () => {
  const { applyFreeOp } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].birth = "birth_06";                 // 平民子弟
  m.players[0].maxHp = toU(3); m.players[0].hp = toU(3);
  m.players[0].energy = toU(0);

  const a = applyFreeOp(m, 0, "convertToEnergy");
  if (!a.ok) throw new Error(a.msg);
  if (m.players[0].hp !== toU(2)) throw new Error(`血应变 2，实际 ${fmt(m.players[0].hp)}`);
  if (m.players[0].energy !== toU(2)) throw new Error(`能应变 2，实际 ${fmt(m.players[0].energy)}`);

  // 再换一次：1 血 4 能
  applyFreeOp(m, 0, "convertToEnergy");
  if (m.players[0].hp !== toU(1) || m.players[0].energy !== toU(4)) throw new Error("第二次换的结果不对");

  // 血量只剩 1 点时不能再换（不能把自己换死）
  const bad = applyFreeOp(m, 0, "convertToEnergy");
  if (bad.ok) throw new Error("血量只剩 1 点时不该还能换");
  if (m.players[0].hp !== toU(1)) throw new Error("被拒绝时不该改动血量");

  // 反着换回来
  const b = applyFreeOp(m, 0, "convertToHp");
  if (!b.ok) throw new Error(b.msg);
  if (m.players[0].hp !== toU(2) || m.players[0].energy !== toU(2)) {
    throw new Error(`换回来应 2 血 2 能，实际 ${fmt(m.players[0].hp)} 血 / ${fmt(m.players[0].energy)} 能`);
  }

  // 血量满了不能继续换血
  m.players[0].hp = toU(3); m.players[0].energy = toU(4);
  const full = applyFreeOp(m, 0, "convertToHp");
  if (full.ok) throw new Error("血量已满时不该还能换血");

  // 不是平民的人不能换
  m.players[1].birth = "birth_01";
  const no = applyFreeOp(m, 1, "convertToEnergy");
  if (no.ok) throw new Error("没有 convert 身世的人不该能换");
});

test("R74 投影：可用性按定点数判断（1 点能量不足以换血）", async () => {
  const { viewFor } = await import("../src/view.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].birth = "birth_06";
  m.players[0].maxHp = toU(3); m.players[0].hp = toU(3);
  m.players[0].energy = toU(1);                    // 只有 1 点能量
  let ops = viewFor(m, 0).me.freeOps;
  const toHp = ops.find((o) => o.op === "convertToHp");
  if (toHp.enabled) throw new Error("1 点能量不该能换 1 血");
  if (!toHp.why) throw new Error("不可用时要给原因");
  const toEn = ops.find((o) => o.op === "convertToEnergy");
  if (!toEn.enabled) throw new Error("3 血应该可以换能量");

  m.players[0].energy = toU(2);
  m.players[0].hp = toU(2);                        // 血不满才谈得上换血
  ops = viewFor(m, 0).me.freeOps;
  if (!ops.find((o) => o.op === "convertToHp").enabled) throw new Error("2 点能量应可换 1 血");
  if (!ops.find((o) => o.op === "convertToHp").repeat) throw new Error("应标记为可反复执行");
});

test("R74 服务端：转换立刻生效、作废预选，且别人看不到（暗选期冻结）", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const c2 = { id: "c2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  const err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1"); R.submitBirthAck(room, "c2");
  for (let i = 0; i < 900 && room.phase !== "choose"; i++) await sleep(4);
  try {
    const m = room.match;
    room.phase = "choose";
    room.publicFrozen = null;              // 让冻结逻辑不干扰本用例的"自己实时"
    const p = m.players[0];
    m.turn = 4;                            // R76：平民天赋第 3 回合起才可用
    p.birth = "birth_06";                  // 平民子弟
    p.maxHp = toU(3); p.hp = toU(3); p.energy = toU(0);

    // 先提交一张牌（模拟"已经预选好"）
    const before = m.players[0].hp;
    room.turnActs[0] = { cardId: "base_01" };

    const e1 = R.submitConvert(room, "c1", "convertToEnergy");
    if (e1) throw new Error(e1);
    if (p.hp !== before - toU(1)) throw new Error("服务端应立刻扣 1 血");
    if (p.energy !== toU(2)) throw new Error("服务端应立刻加 2 能量");
    if (room.turnActs[0]) throw new Error("转换后必须作废预选（turnActs 应被清掉）");

    const snap = R.snapshotFor(room, "c1");
    if (snap.convertCount !== 1) throw new Error("快照应记录本回合转换次数");
    if (snap.view.players[0].energy !== fmt(toU(2))) throw new Error("自己的快照应是新能量");

    // 能量不足 / 没有天赋 -> 拒绝
    p.energy = toU(1);
    if (!R.submitConvert(room, "c1", "convertToHp")) throw new Error("能量不足时应拒绝");
    m.players[1].birth = "birth_01";
    m.players[1].energy = toU(10);
    if (!R.submitConvert(room, "c2", "convertToEnergy")) throw new Error("没有天赋时应拒绝");
  } finally {
    R.destroyRoom(room);
  }
});

test("R74 服务端：转换只发生在出牌阶段之外会被拒绝", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "c1", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.addAI(room, "c1", 1);                          // 补满座位才能开局
  const err = R.startMatch(room, "c1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "c1");
  try {
    room.phase = "reveal";
    if (!R.submitConvert(room, "c1", "convertToEnergy")) throw new Error("非出牌阶段应拒绝");
  } finally {
    R.destroyRoom(room);
  }
});

// ---------- R75 赊天：清算顺序 / 余债保留 / 胜者豁免 ----------

test("R75 赊天清算：先用能量还，再掉道牌，剩下的继续欠", async () => {
  const m = board(2, { turn: 4 });
  const p = m.players[0];
  p.hp = toU(0.5); p.energy = toU(2);
  p.hand = ["dao_01", "dao_02", "dao_03"];
  p.debt = toU(3);                       // 欠 3 点
  set(m, 1, { energy: toU(10) });
  const ev = resolveTurn(m, { 0: { cardId: "base_01" }, 1: { cardId: "base_04" } });
  if (p.alive) throw new Error("应被淘汰");
  const e = ev.find((x) => x.t === "debt");
  if (!e) throw new Error("应记录一条赊天清算事件");
  if (Number(e.paid) !== 2) throw new Error(`应先用 2 点能量抵债，实际 ${e.paid}`);
  if ((e.lost || []).length !== 1) throw new Error(`能量不够的 1 点应掉 1 张道牌，实际 ${(e.lost || []).length}`);
  if (Number(e.left) !== 0) throw new Error(`应还清，实际仍欠 ${e.left}`);
  if (p.debt !== 0) throw new Error("还清了债务应归零");
  if (p.energy !== 0) throw new Error("抵债的能量不该再被瓜分");
  if (p.hand.length !== 2) throw new Error("应只剩 2 张道牌");
});

test("R75 赊天清算：能量+道牌都不够 → 继续欠着，之后拿牌被没收", async () => {
  const { seizeForDebt } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  const p = m.players[0];
  p.hp = toU(0.5); p.energy = toU(1); p.hand = ["dao_01"];
  p.debt = toU(5);                       // 欠 5 点，只有 1 能 + 1 张牌
  set(m, 1, { energy: toU(10) });
  const ev = resolveTurn(m, { 0: { cardId: "base_01" }, 1: { cardId: "base_04" } });
  const e = ev.find((x) => x.t === "debt");
  if (Number(e.paid) !== 1) throw new Error("应先抵 1 点能量");
  if ((e.lost || []).length !== 1) throw new Error("再掉 1 张道牌");
  if (Number(e.left) !== 3) throw new Error(`应还剩 3 点欠账，实际 ${e.left}`);
  if (p.debt !== toU(3)) throw new Error("余债必须保留，不能抹掉");
  if (p.hand.length !== 0) throw new Error("道牌应被抵扣掉");

  // 之后拿到道牌 -> 直接被天道没收
  const seized = seizeForDebt(m, p, "dao_05");
  if (!seized) throw new Error("欠债的人拿到道牌应被没收");
  if (p.debt !== toU(2)) throw new Error(`没收一张应抵 1 点，实际剩 ${fmt(p.debt)}`);
  if (p.hand.length !== 0) throw new Error("被没收的牌不该进手牌");
  const log = (m.debtSeizeLog || []).find((x) => x.t === "debtSeize");
  if (!log) throw new Error("应记录一条没收事件");
});

test("R75 赊天：债务跨局保留，但胜利势力的存活成员被免除", async () => {
  const m = board(2, { turn: 4 });
  m.players[0].debt = toU(2);
  // 跨局：startRound 不清债
  startRound(m);
  if (m.players[0].debt !== toU(2)) throw new Error("债务应跨局保留（原来会被 startRound 清掉）");

  // 局末：0 号活到最后 -> 免除
  m.players[0].alive = true; m.players[0].roundStats.survivedTurns = 9;
  m.players[1].alive = false; m.players[1].roundStats.survivedTurns = 4;
  endRound(m, { autoDraft: false });
  if (m.players[0].debt !== 0) throw new Error("活到最后的应被免除");
  if (!(m.debtForgiven || []).some((x) => x.seat === 0)) throw new Error("应记录免除事件");
});

test("R75 赊天：已淘汰的队友即使势力最后获胜，也照还（淘汰时已清算）", async () => {
  const m = allyBoard();                     // 2 势力 × 2 人：0/1 一队
  m.players[0].alive = false; m.players[0].roundStats.survivedTurns = 3;
  m.players[0].debt = toU(2);                // 死前欠着（模拟淘汰时没还清）
  m.players[1].alive = true; m.players[1].roundStats.survivedTurns = 9;
  m.players[1].debt = toU(1);
  for (const s of [2, 3]) { m.players[s].alive = false; m.players[s].roundStats.survivedTurns = 5; }
  const ranked = endRound(m, { autoDraft: false });
  if (ranked[0].f.id !== 0) throw new Error("势力 0 应是胜者");
  if (m.players[1].debt !== 0) throw new Error("存活队友应免除");
  if (m.players[0].debt !== toU(2)) throw new Error("已淘汰的队友不该被免除，仍要还");
});

test("R75 赊天提示词：额度 = 拥有的道牌数（手牌 + 神装），选项是纯数字（0 = 不借）", async () => {
  const { collectTianjiPrompts } = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  m.players[0].hand = ["dao_01", "dao_02"];
  m.players[0].equip = ["dao_03"];
  m.players[0].sets = ["b1s1", "b1s2"];          // 术系不参与额度
  set(m, 1, { hand: [], equip: [], sets: [] });
  const prompts = collectTianjiPrompts(m, "tj_23");
  const spec = prompts.find((x) => x.id === "credit_0");
  if (!spec) throw new Error("应给 0 号一条赊借追问");
  if (prompts.some((x) => x.id === "credit_1")) throw new Error("没有道牌的人不该被问");
  if (!/最多 3 点/.test(spec.label)) throw new Error(`额度应为 2 张手牌 + 1 件神装 = 3，实际：${spec.label}`);
  if (!spec.options.includes(0)) throw new Error("必须给「0」这个选项（不借）");
  if (!spec.options.includes(3)) throw new Error(`上限应是 3，实际选项 ${spec.options}`);
  if (spec.options.some((n) => n > 3)) throw new Error("不该出现超过上限的选项");
  if (spec.options.some((n) => typeof n !== "number")) throw new Error("选项应保持纯数字");
  if (spec.optionLabels) throw new Error("不该再带自定义选项文案（0 就是 不借）");
});

// ---------- R76 布局与身世天赋门槛 ----------

test("R76 平民天赋：第 3 回合起才能兑换（前两回合按钮灰、服务端也拒）", async () => {
  const { applyFreeOp } = await import("../src/engine.mjs");
  const { viewFor } = await import("../src/view.mjs");
  const { CONFIG } = await import("../src/config.mjs");
  const m = board(2, { turn: 1 });
  m.players[0].birth = "birth_06";
  m.players[0].maxHp = toU(3); m.players[0].hp = toU(3); m.players[0].energy = toU(0);

  for (const turn of [1, 2]) {
    m.turn = turn;
    const ops = viewFor(m, 0).me.freeOps;
    if (ops.some((o) => o.enabled)) throw new Error(`第 ${turn} 回合不该有任何可用的兑换`);
    if (!ops.every((o) => /第 3 回合起/.test(o.why || ""))) {
      throw new Error(`第 ${turn} 回合的不可用原因应写清回合门槛，实际 ${JSON.stringify(ops.map((o) => o.why))}`);
    }
    const r = applyFreeOp(m, 0, "convertToEnergy");
    if (r.ok) throw new Error(`第 ${turn} 回合服务端也不该允许兑换`);
    if (m.players[0].hp !== toU(3)) throw new Error("被拒绝时不该改动血量");
  }

  m.turn = CONFIG.convertFromTurn;               // 第 3 回合
  const ops = viewFor(m, 0).me.freeOps;
  if (!ops.find((o) => o.op === "convertToEnergy").enabled) throw new Error("第 3 回合应开放兑换");
  const r = applyFreeOp(m, 0, "convertToEnergy");
  if (!r.ok) throw new Error(r.msg);
  if (m.players[0].hp !== toU(2)) throw new Error("第 3 回合应能换血");
});

test("R76 状态面板方位：南北两排与卡片同一水平线，西东保持卡片下方", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const css = fs.readFileSync(path.join(process.cwd(), "web", "style.css"), "utf8");
  if (!/\.zone-n \.member,\.zone-s \.member\{[^}]*flex-direction:row/.test(css)) {
    throw new Error("南北两排的成员容器应改成横向（面板放卡片左右）");
  }
  if (!/\.zone-n \.dock,\.zone-s \.dock\{[^}]*width:/.test(css)) {
    throw new Error("南北两排的面板应给单独宽度，否则会撑爆整排");
  }
  // 西/东不要再被改成横向
  if (/\.zone-w \.member,\.zone-e \.member/.test(css)) {
    throw new Error("西东两侧应保持卡片下方（竖向）");
  }
});

test("R76 天赋：与道牌同一行渲染，说明折叠成「?」按钮", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "web", "online.mjs"), "utf8");
  if (!src.includes("talentInlineHtml")) throw new Error("应有天赋内联组件");
  if (!/hand-dao"\)\.innerHTML[\s\S]{0,400}talentInlineHtml/.test(src)) {
    throw new Error("天赋应渲染进道牌行（hand-dao），而不是单独一行");
  }
  if (!/class="tq" data-birth="1"/.test(src)) throw new Error("身世说明应折叠成「?」按钮");
  if (!/row-talent[\s\S]{0,80}display = "none"/.test(src)) {
    throw new Error("原来的独立天赋行应隐藏");
  }
  const app = fs.readFileSync(path.join(process.cwd(), "web", "app.mjs"), "utf8");
  if (!app.includes("talentInlineHtml")) throw new Error("单机版同样要内联");
});

test("拍卖：同一回合不会重复开拍", () => {
  const m = board(2);
  m.turn = CONFIG.auctionEvery - 1;
  for (const p of m.players) p.energy = toU(6);
  const first = peekAuction(m);
  if (!first) throw new Error("该回合应触发拍卖");
  auctionIfDue(m, { offerId: first, bids: { 0: 1 } });
  if (peekAuction(m)) throw new Error("同一回合不该再开一次拍卖");
});

// ---------- R77 事件记录：拍卖/补给单独成节，出牌一人一行 ----------

test("R77 服务端：出牌事件带上本回合用的道牌（名字 + id）", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const c1 = { id: "p1", send() {} };
  const c2 = { id: "p2", send() {} };
  const { room } = R.createRoom(c1, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, c2, "P2");
  const err = R.startMatch(room, "p1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "p1"); R.submitBirthAck(room, "p2");
  try {
    for (let i = 0; i < 1500 && room.phase !== "choose"; i++) await sleep(4);
    if (room.phase !== "choose") throw new Error(`没进到出牌阶段，停在 ${room.phase}`);
    const m = room.match;
    const p0 = m.players[0];
    p0.hand = ["dao_23"];            // 破防：纯自我增益，不追问、不依赖于人
    p0.energy = toU(12);
    const e1 = R.submitPlay(room, "p1", { cardId: "base_01", daoId: "dao_23" });
    if (e1) throw new Error(e1);
    const e2 = R.submitPlay(room, "p2", { cardId: "base_10" });
    if (e2) throw new Error(e2);
    let plays = [];
    for (let i = 0; i < 1200 && !plays.length; i++) {
      plays = (room.lastEvents || []).filter((e) => e.t === "play");
      if (!plays.length) await sleep(4);
    }
    if (!plays.length) throw new Error("结算后应下发 play 事件");
    const mine = plays.find((p) => p.seat === 0);
    if (!mine) throw new Error("应有一条 0 号位的出牌事件");
    if (mine.daoId !== "dao_23" || mine.daoName !== "破防") {
      throw new Error(`出牌事件应带道牌，实际 ${mine.daoId}/${mine.daoName}`);
    }
    const other = plays.find((p) => p.seat === 1);
    if (!other || other.daoName) throw new Error("没带道牌的人不该被写上道牌");
  } finally {
    R.destroyRoom(room);
  }
});

// 面板需要一个极简 DOM：这里只替 root / panel-body 两层，够 render() 跑通
function fakePanel() {
  globalThis.window = { innerWidth: 1280, addEventListener() {} };
  globalThis.document = { getElementById: () => null };
  const body = { innerHTML: "", querySelectorAll: () => [] };
  const root = {
    classList: { toggle() {} },
    querySelector: (sel) => (sel === ".panel-body" ? body : null),
  };
  return { root, body };
}

test("R77 事件记录：拍卖与补给单独成节，回合条目顺序为 天机 → 出牌 → 血量能量", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { EventLog } = await import("../web/panel.mjs");
  const { root, body } = fakePanel();
  const log = new EventLog(root);

  const v = {
    round: 0, turn: 5,
    players: [{ name: "甲" }, { name: "乙" }],
    log: [
      { t: "auction", cardId: "dao_01", name: "护心镜", category: "神装牌" },
      { t: "auctionResult", kind: "sold", bids: [{ seat: 0, bid: 3 }, { seat: 1, bid: 1 }], winners: [0] },
      { t: "auctionWin", seat: 0, bid: 3, cardId: "dao_01" },
      { t: "supply", turn: 5, amount: "1" },
      { t: "tianji", id: "tj_01", name: "风起" },
      { t: "play", seat: 0, cardId: "base_01", name: "蓄力", value: "",
        daoId: "dao_23", daoName: "破防" },
      { t: "play", seat: 1, cardId: "base_10", name: "普通防御", value: "1",
        daoId: "dao_28", daoName: "焚术", daoVoid: true },
      { t: "hit", by: 0, target: 1, value: "2", threshold: "1" },
    ],
  };
  log.update(v, { phase: "reveal", changes: [{ seat: 0, hp: -1, energy: -3 }] });
  const html = body.innerHTML;

  // ① 两个独立小节都在回合条目之前
  const iAuc = html.indexOf("pl-group");
  const iTurn = html.indexOf('class="pl-item');
  if (iAuc < 0 || iTurn < 0) throw new Error("应有拍卖/补给小节与回合条目");
  if (iAuc > iTurn) throw new Error("拍卖/补给应排在回合条目之前");
  if (!html.includes("定期回复能量")) throw new Error("补能应有独立小节标题");
  if (html.indexOf("定期回复能量") > iTurn) throw new Error("补能小节也要在回合条目之前");
  if (!html.includes('pl-out-name">护心镜')) throw new Error("拍卖条目应列出拍品");
  if (!html.includes("甲 以 3 点 拍得")) throw new Error("拍卖条目应写出成交结果");
  if (!/pl-bid win">\s*<i>甲<\/i><b>3<\/b>/.test(html)) throw new Error("拍卖条目应列出全场出价并标出得主");
  if (!html.includes("全场存活者各 +1 能量")) throw new Error("补能条目应写出结果");

  // ② 拍卖/补给不再混进回合备注
  if (/pl-note t-auction/.test(html) || /pl-note t-supply/.test(html)) {
    throw new Error("拍卖与补给已单独成节，回合里不该再重复");
  }

  // ③ 回合条目顺序：标题 → 天机 → 出牌（一人一行）→ 血量/能量 → 其它
  const seg = html.slice(iTurn);
  const iTj = seg.indexOf('class="pl-tj');
  const iPlay = seg.indexOf("pl-playlist");
  const iHp = seg.indexOf(">血量<");
  const iEn = seg.indexOf(">能量<");
  const iNote = seg.indexOf("pl-notes");
  if (!(iTj < iPlay && iPlay < iHp && iHp < iEn && iEn < iNote)) {
    throw new Error(`回合条目顺序不对：天机${iTj} 出牌${iPlay} 血${iHp} 能${iEn} 其它${iNote}`);
  }
  // 出牌一人一行，且道牌跟在术牌后面
  const rows = seg.match(/<div class="pl-play"/g) || [];
  if (rows.length !== 2) throw new Error(`应出两行出牌记录，实际 ${rows.length}`);
  if (!/道 · 破防/.test(seg)) throw new Error("出牌行应带道牌");
  if (!/道 · 焚术（被封）/.test(seg)) throw new Error("被返璞归真封掉的道牌要标出来");
});

test("R77 事件记录：没有拍卖/补给的回合不画空小节", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { EventLog } = await import("../web/panel.mjs");
  const { root, body } = fakePanel();
  const log = new EventLog(root);
  log.update({
    round: 0, turn: 2, players: [{ name: "甲" }, { name: "乙" }],
    log: [{ t: "play", seat: 0, cardId: "base_01", name: "蓄力", value: "" }],
  }, { phase: "reveal", changes: [] });
  const html = body.innerHTML;
  if (html.includes("pl-group")) throw new Error("没有拍卖/补给时不该出现空小节");
  if (!html.includes("pl-playlist")) throw new Error("普通回合仍要画出牌行");
});

test("R77 服务端：拍卖回合不再被跳过，第 10 回合的定期回复能量真的会发生", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = { id: "q1", send() {} };
  const b = { id: "q2", send() {} };
  const { room } = R.createRoom(a, { name: "T", factions: 2, per: 1 });
  R.joinRoom(room, b, "P2");
  const err = R.startMatch(room, "q1");
  if (err) { R.destroyRoom(room); throw new Error(err); }
  R.submitBirthAck(room, "q1"); R.submitBirthAck(room, "q2");
  const played = new Set();
  const supplies = [];
  let badChanges = null;
  let sawChanges = 0;
  let sawSnapshot = false;
  try {
    for (let i = 0; i < 6000; i++) {
      const m = room.match;
      if (!m) { await sleep(6); continue; }
      if (m.turn === 0) for (const p of m.players) { p.maxHp = toU(30); p.hp = toU(30); }
      for (const e of room.lastEvents || []) if (e.t === "supply") supplies.push(m.turn);
      // 第 10 回合既有拍卖（扣能量）又有补给（加能量）还有出牌 —— 净变化必须都是合法数字
      if (room.phase === "reveal" && m.turn === 10) {
        const ch = R.snapshotFor(room, "q1").changes || [];
        sawSnapshot = true;
        if (ch.length) sawChanges = ch.length;
        badChanges = ch.filter((c) => [c.hp, c.energy].some(
          (v) => v !== "" && v !== undefined && !Number.isFinite(Number(v))
        ));
      }
      if (room.phase === "choose") {
        played.add(m.turn);
        for (const s of room.seats) if (s.kind === "human") R.submitPlay(room, s.clientId, { cardId: "base_01" });
      }
      if (room.phase === "auction") {
        R.submitBid(room, "q1", 1); R.submitBid(room, "q2", 0);
      }
      if (m.turn >= 11 || m.roundIndex > 0 || room.phase === "matchOver") break;
      await sleep(6);
    }
    if (!played.has(5)) throw new Error("第 5 回合（拍卖回合）应该照常出牌，不能只办拍卖就跳过去");
    if (!played.has(10)) throw new Error("第 10 回合（拍卖回合）同样要正常打");
    if (!supplies.includes(10)) throw new Error(`第 10 回合应触发定期回复能量，实际 ${supplies.join(",")}`);
    if (!sawSnapshot) throw new Error("第 10 回合结算时应该能拿到快照（含 changes）");
    if (badChanges && badChanges.length) {
      throw new Error(`变化量被拼成了脏字符串：${JSON.stringify(badChanges[0])}`);
    }
  } finally {
    R.destroyRoom(room);
  }
});

test("R77 事件记录：局末轮抽不会顶掉下一局同回合号的记录", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { EventLog } = await import("../web/panel.mjs");
  const { root } = fakePanel();
  const log = new EventLog(root);
  const players = [{ name: "甲" }, { name: "乙" }];
  const play = { t: "play", seat: 0, cardId: "base_01", name: "蓄力", value: "" };

  // 第 1 局打到第 6 回合
  log.update({ round: 0, turn: 6, players, log: [play] }, { phase: "reveal", changes: [] });
  // 局末：endRound 已经把 roundIndex +1，但 turn 还停在 6
  log.update({ round: 1, turn: 6, players, log: [{ t: "setDraft", names: ["甲"], name: "五行" }] },
    { phase: "setDraft", changes: [] });
  if (log.records.length !== 1) throw new Error(`轮抽不该新建记录，实际有 ${log.records.length} 条`);
  if (!log.records[0].notes.some((n) => n.t === "setDraft")) throw new Error("轮抽事件应挂到局末那条记录上");

  // 第 2 局真打到第 6 回合 —— 必须新建一条，而不是复用上面那条
  log.update({ round: 1, turn: 6, players, log: [play] }, { phase: "reveal", changes: [] });
  const keys = log.records.map((r) => r.key);
  if (keys.length !== 2) throw new Error(`应有两回合记录，实际 ${keys.join(" / ")}`);
  if (keys[0] !== "2-6") throw new Error(`最新应是 2-6，实际 ${keys[0]}`);
  if (!log.records[0].plays.length) throw new Error("新记录的出牌不能被顶掉");
});

// ---------- R78 天官赐福：逐人独立抽牌 + 明细只给自己 ----------

test("R78 天官赐福：每人各抽各的（不是同一张），且都留下抽牌事件", async () => {
  const E = await import("../src/engine.mjs");
  const { cardById } = await import("../src/data.mjs");
  const m = board(4, { turn: 4 });
  for (const p of m.players) { p.hand = []; p.equip = []; }
  const ev = [];
  E.applyTianjiCard(m, cardById("tj_07"), ev);
  const gains = ev.filter((e) => e.t === "daoGain");
  if (gains.length !== 4) throw new Error(`4 人应各留一条抽牌事件，实际 ${gains.length}`);
  const ids = gains.map((g) => g.cardId);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`同一批不该发同一张实体牌，实际 ${gains.map((g) => g.name).join("/")}`);
  }
  // 每条事件都要带座位与牌名，面板才有东西可画
  if (gains.some((g) => !Number.isInteger(g.seat) || !g.name)) {
    throw new Error("抽牌事件应带 seat 与牌名");
  }
});

test("R78 投影：抽牌明细只给本人，别人 / 观战只看得到「1 张」", async () => {
  const E = await import("../src/engine.mjs");
  const { cardById } = await import("../src/data.mjs");
  const { viewFor } = await import("../src/view.mjs");
  const m = board(3, { turn: 4 });
  for (const p of m.players) { p.hand = []; p.equip = []; }
  const ev = [];
  E.applyTianjiCard(m, cardById("tj_07"), ev);
  const mine = ev.find((e) => e.t === "daoGain" && e.seat === 0);

  const v0 = viewFor(m, 0, { events: ev });
  const myGain = v0.log.filter((e) => e.t === "daoGain" && e.seat === 0).pop();
  if (!myGain || myGain.name !== mine.name || myGain.hidden) {
    throw new Error("自己应该看得到抽到的具体牌名");
  }
  const others = v0.log.filter((e) => e.t === "daoGain" && e.seat !== 0);
  if (others.some((e) => e.name || e.cardId || !e.hidden)) {
    throw new Error("别人的道牌内容不该出现在自己的投影里");
  }
  // 观战视角：全部隐藏
  const vs = viewFor(m, -1, { events: ev });
  if (vs.log.some((e) => e.t === "daoGain" && !e.hidden)) {
    throw new Error("观战视角不该看到任何人的抽牌内容");
  }
});

test("R78 事件记录：抽牌单独一行，排在天机下面、出牌上面", async () => {
  const { raw: cr, fx: cf } = await import("../src/data.mjs");
  globalThis.__XD_DATA__ = { cards: cr, effects: cf };
  const { EventLog } = await import("../web/panel.mjs");
  const { root, body } = fakePanel();
  const log = new EventLog(root);
  log.update({
    round: 0, turn: 6, players: [{ name: "甲" }, { name: "乙" }],
    log: [
      { t: "tianji", id: "tj_07", name: "天官赐福" },
      { t: "daoGain", seat: 0, cardId: "dao_23", name: "破防" },
      { t: "daoGain", seat: 1, hidden: true },
      { t: "play", seat: 0, cardId: "base_01", name: "蓄力", value: "" },
    ],
  }, { phase: "reveal", changes: [] });
  const html = body.innerHTML;
  const iTj = html.indexOf("天官赐福");
  const iGain = html.indexOf("pl-line\"><label>抽牌");
  const iPlay = html.indexOf("pl-playlist");
  if (iGain < 0) throw new Error("应有「抽牌」一行");
  if (!(iTj < iGain && iGain < iPlay)) throw new Error("抽牌行应夹在天机与出牌之间");
  if (!/甲<\/i>破防/.test(html)) throw new Error("自己抽到的牌名要写出来");
  if (!/乙<\/i><span class="pl-none">1 张/.test(html)) throw new Error("别人只写「1 张」");
});

// ---------- R79 道牌牌库：有限、只减不增、抽空即无 ----------

test("R79 天官赐福：只从剩余牌库抽，抽空了就是没抽到（不再凭空重建整副）", async () => {
  const E = await import("../src/engine.mjs");
  const { cardById } = await import("../src/data.mjs");
  const m = board(4, { turn: 4 });
  for (const p of m.players) { p.hand = []; p.equip = []; }
  m.daoDeck = ["dao_23", "dao_28", "dao_24"];      // 只剩 3 张
  const ev = [];
  E.applyTianjiCard(m, cardById("tj_07"), ev);
  const gains = ev.filter((e) => e.t === "daoGain");
  const got = gains.filter((g) => !g.empty);
  const empty = gains.filter((g) => g.empty);
  if (got.length !== 3) throw new Error(`只剩 3 张就该只发出 3 张，实际 ${got.length}`);
  if (empty.length !== 1) throw new Error("抽空的那一位应有「牌库已空」事件");
  const all = m.players.flatMap((p) => p.hand);
  if (all.length !== 3) throw new Error(`手牌总量应等于剩余牌库，实际 ${all.length}`);
  if (new Set(all).size !== all.length) throw new Error("同一张实体牌不该发两次");
  if (m.daoDeck.length !== 0) throw new Error("抽完牌库应清空，不能自己长回来");
});

test("R80 打出去 / 弃置的道牌都回公共牌库（整场一副，牌池守恒）", async () => {
  const E = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  // 0 号位手里一张破防，牌库里另有 5 张
  m.players[0].hand = ["dao_23"];
  m.players[0].energy = toU(12);
  m.daoDeck = ["dao_21", "dao_24", "dao_25", "dao_26", "dao_27"];
  const before = m.daoDeck.length;
  E.resolveTurn(m, { 0: { cardId: "base_01", daoId: "dao_23" }, 1: { cardId: "base_01" } });
  if (!m.daoDeck.includes("dao_23")) throw new Error("打出的破防应回到牌库");
  if (m.daoDeck.length !== before + 1) throw new Error(`牌库应 +1，实际 ${before}→${m.daoDeck.length}`);
  if (m.players[0].hand.includes("dao_23")) throw new Error("打出的道牌应从手里消失");

  // 弃置：超上限自动弃，也要回库（上限 = maxHp，3 血 = 3 张，所以放 4 张）
  const p = m.players[0];
  p.hand = ["dao_21", "dao_24", "dao_25", "dao_26"];
  p.equip = [];
  const left = m.daoDeck.length;
  const lost = E.autoDiscard(m, 0);
  if (!lost.length) throw new Error("超上限应弃牌");
  if (m.daoDeck.length !== left + lost.length) throw new Error("弃置的道牌应全部回到牌库");
  if (!lost.every((id) => m.daoDeck.includes(id))) throw new Error("弃掉的牌要真的在牌库里");

  // 玩家主动弃牌同样回库
  const before2 = m.daoDeck.length;
  const gone = E.discardCards(m, 0, [p.hand[0]]);
  if (gone.length !== 1) throw new Error("应弃掉 1 张");
  if (m.daoDeck.length !== before2 + 1) throw new Error("主动弃置也要回牌库");
});

test("R81 局末不回收：道牌是跨局发育资源，带着进下一局", async () => {
  const E = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  const total = m.daoDeck.length;
  if (total !== 60) throw new Error(`牌库应是 60 张，实际 ${total}`);

  // 两个人手上各 2 张 + 1 件神装（这些牌本局已经抽出来了，先从牌库里拿掉）
  m.players[0].hand = ["dao_21", "dao_23"];
  m.players[0].equip = ["dao_01"];
  m.players[1].hand = ["dao_24", "dao_25"];
  for (const id of ["dao_21", "dao_23", "dao_01", "dao_24", "dao_25"]) {
    const i = m.daoDeck.indexOf(id);
    if (i < 0) throw new Error(`${id} 应在牌库里`);
    m.daoDeck.splice(i, 1);
  }
  const left = m.daoDeck.length;

  E.endRound(m, { autoDraft: true });
  E.startRound(m);

  // 局末不回收：牌库不多回来，手上的牌原样带进下一局
  if (m.daoDeck.length !== left) {
    throw new Error(`局末不该把道牌收回牌库，实际 ${left} → ${m.daoDeck.length}`);
  }
  if (m.players[0].hand.join() !== "dao_21,dao_23") throw new Error("手上的道牌应跨局保留");
  if (m.players[0].equip.join() !== "dao_01") throw new Error("已装载的神装也应跨局保留");
  if (m.players[1].hand.join() !== "dao_24,dao_25") throw new Error("别人的道牌同样保留");
  if (!m.daoDeckReady) throw new Error("牌库应标记为已建立，不能每局重建");
});

test("R80 单局跑完牌库总量守恒：牌库 + 手上 + 天道没收 = 60", async () => {
  const E = await import("../src/engine.mjs");
  const { cardById } = await import("../src/data.mjs");
  const m = board(4, { turn: 4 });
  const total = m.daoDeck.length;
  // 天官赐福发一轮 → 部分牌离开牌库进手里
  const ev = [];
  E.applyTianjiCard(m, cardById("tj_07"), ev);
  const inHand = m.players.reduce((n, p) => n + p.hand.length + p.equip.length, 0);
  // R82：被赊天没收的牌也回牌库，所以「牌库 + 手上」恒等于 60
  if (m.daoDeck.length + inHand !== total) {
    throw new Error(`总量应守恒 ${total}：牌库 ${m.daoDeck.length} + 手上 ${inHand}`);
  }
  for (const p of m.players) { p.hand = []; p.equip = []; }
  for (const e of ev) if (e.t === "daoGain" && e.cardId && !e.seized) E.returnDao(m, e.cardId);
  if (m.daoDeck.length !== total) throw new Error(`回收后应回到 ${total}，实际 ${m.daoDeck.length}`);
});

test("R82 赊天没收的牌回公共牌库，不是凭空消失", async () => {
  const E = await import("../src/engine.mjs");
  const { cardById } = await import("../src/data.mjs");
  const m = board(2, { turn: 4 });
  const total = m.daoDeck.length;
  // 0 号位欠天道 2 点，天官赐福抽到的牌会被没收抵债
  m.players[0].hand = [];
  m.players[0].equip = [];
  m.players[0].debt = toU(2);
  const ev = [];
  E.applyTianjiCard(m, cardById("tj_07"), ev);
  const seized = ev.filter((e) => e.t === "daoGain" && e.seized);
  if (!seized.length) throw new Error("欠着债的人抽到牌应被没收");
  const inHand = m.players.reduce((n, p) => n + p.hand.length + p.equip.length, 0);
  if (m.daoDeck.length + inHand !== total) {
    throw new Error(`被没收的牌应回牌库，总量应恒为 ${total}：牌库 ${m.daoDeck.length} + 手上 ${inHand}`);
  }
  if (!m.daoDeck.includes(seized[0].cardId)) throw new Error("被没收的那张牌应在牌库里");
  // 债确实抵掉了
  if (m.players[0].debt >= toU(2)) throw new Error("没收应该抵掉 1 点债务");
});

test("R82 赊天清算掉的道牌也回牌库", async () => {
  const E = await import("../src/engine.mjs");
  const m = board(2, { turn: 4 });
  const total = m.daoDeck.length;
  const p = m.players[0];
  const ids = ["dao_21", "dao_23"];
  p.hand = [...ids];
  p.equip = [];
  p.energy = 0;
  p.debt = toU(2);                  // 2 点债：没有能量 → 掉 2 张道牌
  for (const id of ids) {
    const i = m.daoDeck.indexOf(id);
    if (i < 0) throw new Error(`${id} 应在牌库里`);
    m.daoDeck.splice(i, 1);
  }
  const before = m.daoDeck.length;
  // 淘汰即触发清算（settleDebt：先扣能量，再掉道牌抵债）
  p.hp = 0;
  E.settleEliminations(m, []);
  if (p.hand.length) throw new Error("抵债应把道牌收走");
  if (m.daoDeck.length !== before + ids.length) {
    throw new Error(`抵债的牌应回牌库（${before} → ${before + ids.length}），实际 ${m.daoDeck.length}`);
  }
  const inHand = m.players.reduce((n, q) => n + q.hand.length + q.equip.length, 0);
  if (m.daoDeck.length + inHand !== total) throw new Error("总量应仍为 60");
});

// ---------- R83 房间持久化：30 分钟保留 / 房主转移 / 解散 ----------

function fakeConn(id) {
  const sent = [];
  return { id, sent, send: (m) => sent.push(m), closed: false };
}

test("R83 房主离开 → 自动转给还在房间里的下一个人", async () => {
  const R = await import("../server/room.mjs");
  const a = fakeConn("h1");
  const b = fakeConn("h2");
  const { room } = R.createRoom(a, { name: "A", factions: 2, per: 1 });
  R.joinRoom(room, b, "B");
  if (room.hostId !== "h1") throw new Error("谁是创建者谁是房主");
  R.leave(room, "h1");
  if (room.hostId !== "h2") throw new Error(`房主应转给还在的人，实际 ${room.hostId}`);
  const snap = R.snapshotFor(room, "h2");
  if (!snap.amHost) throw new Error("新人房主应拿到 amHost");
  R.destroyRoom(room);
});

test("R83 所有人都走了，房间仍然保留；凭房号能重新进来", async () => {
  const R = await import("../server/room.mjs");
  const a = fakeConn("x1");
  const b = fakeConn("x2");
  const { room } = R.createRoom(a, { name: "A", factions: 2, per: 1 });
  const id = room.id;
  R.joinRoom(room, b, "B");
  R.leave(room, "x1");
  R.leave(room, "x2");
  if (room.conns.size !== 0) throw new Error("两人都该离开");
  if (!R.getRoom(id)) throw new Error("空房间不能立刻销毁（要继续保留）");
  if (!room.emptySince) throw new Error("应记录「从什么时候开始没人」");
  // 换个人凭房号进来：还是同一个房间，且成为房主
  const c = fakeConn("x3");
  const ok = R.getRoom(id);
  const { seat } = R.joinRoom(ok, c, "C");
  if (seat < 0) throw new Error("空位应该能坐进去");
  if (R.getRoom(id) !== ok) throw new Error("重进的必须是同一个房间");
  if (ok.hostId !== "x3") throw new Error("空房间重进的人应接任房主");
  if (ok.emptySince) throw new Error("有人了就该清掉 emptySince");
  R.destroyRoom(ok);
});

test("R83 房间只在「没人满 30 分钟」后才被清理，有人时不清理", async () => {
  const R = await import("../server/room.mjs");
  const a = fakeConn("y1");
  const { room } = R.createRoom(a, { name: "A", factions: 2, per: 1 });
  const id = room.id;
  // 有人：放很久也不清
  R.sweepRooms(Date.now() + 5 * 3600_000);
  if (!R.getRoom(id)) throw new Error("还有人在房间里，不该被清理");
  // 没人了：29 分钟还留着
  R.leave(room, "y1");
  const t0 = Date.now();
  R.sweepRooms(t0 + 29 * 60_000);
  if (!R.getRoom(id)) throw new Error("空房间 29 分钟时应保留");
  // 31 分钟：清掉
  R.sweepRooms(t0 + 31 * 60_000);
  if (R.getRoom(id)) throw new Error("空房间超过 30 分钟应销毁");
});

test("R83 只有房主能解散，解散后房间立刻消失且通知所有人", async () => {
  const R = await import("../server/room.mjs");
  const a = fakeConn("z1");
  const b = fakeConn("z2");
  const { room } = R.createRoom(a, { name: "A", factions: 2, per: 1 });
  R.joinRoom(room, b, "B");
  const id = room.id;
  const denied = R.dissolveRoom(room, "z2");
  if (!denied) throw new Error("非房主解散应被拒绝");
  if (!R.getRoom(id)) throw new Error("被拒绝时房间不能消失");
  const err = R.dissolveRoom(room, "z1");
  if (err) throw new Error(`房主解散应成功，实际 ${err}`);
  if (R.getRoom(id)) throw new Error("解散后房间应立刻消失");
  if (!b.sent.some((m) => m.t === "dissolved")) throw new Error("其他人应收到 dissolved");
});

test("R83 没人时阶段计时器挂起，有人回来才继续（不会让 AI 把空房间打完）", async () => {
  process.env.XD_FAST = "1";
  const R = await import("../server/room.mjs");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = fakeConn("w1");
  const b = fakeConn("w2");
  const { room } = R.createRoom(a, { name: "A", factions: 2, per: 1 });
  try {
    R.joinRoom(room, b, "B");
    R.startMatch(room, "w1");
    R.submitBirthAck(room, "w1"); R.submitBirthAck(room, "w2");
    for (let i = 0; i < 800 && room.phase !== "choose"; i++) await sleep(4);
    const before = room.phase;
    // 全员退出：计时器应挂起，等再久也不推进
    R.leave(room, "w1");
    R.leave(room, "w2");
    if (room.timer) throw new Error("没人时不该还有活着的计时器");
    const pinned = room.match.turn;
    await sleep(500);
    if (room.match.turn !== pinned || room.phase !== before) {
      throw new Error(`空房间仍在推进：${before} → ${room.phase}`);
    }
  } finally {
    R.destroyRoom(room);
  }
});

for (const c of cases) {
  try {
    await c.fn();
    pass += 1;
    console.log(`  ok   ${c.name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${c.name}\n       ${e.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
