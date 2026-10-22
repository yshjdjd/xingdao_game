// 可调参数。所有"可能会被改"的规则常数集中在这里，改一行即可，不散落在引擎里。
import { toU } from "./units.mjs";

export const CONFIG = {
  ruleset: "v1.4 + R01-R64",

  // R25 血量按局数（单位：点，运行时转定点）
  hpByRound: [3, 4, 5, 5],

  // 人数白名单（R24）：只允许这几种人数开局
  allowedPlayerCounts: [2, 3, 4, 6, 8],
  maxFactions: 4,
  maxMembersPerFaction: 2,

  // 局结构：争夺期 3 局 + 终局期 1 局
  rounds: 4,
  finalRoundIndex: 3,

  // 天机（6.1）—— R43：前三局 20%，终局 30%（原为 1/3 与 0.5）
  tianjiBaseChance: 0.2,
  tianjiFinalChance: 0.3,
  tianjiPity: 5,          // 连续 5 回合未触发 -> 第 6 回合必触发（保底不变）

  // 补给（4.1）：第 10/15/20… 回合，全员能量 +1
  supplyTurnStart: 10,
  supplyEvery: 5,
  supplyEnergy: toU(1),

  // 兜底终局（R08）：第 25 回合起，每回合结束全场 -1 血
  decayTurnStart: 25,
  decayHp: toU(1),

  // 拍卖（7.7）：每局第 5/10/15… 回合
  auctionEvery: 5,

  // 手牌上限（R11 修订）：= 血量上限本身（第 1 局 3、第 2 局 4、第 3/4 局 5）。
  // 引擎里由 handCap(p) 直接按 maxHp 算，不走配置 —— 想改这里得同时改 engine.handCap()。
  // R55：神装获取即自动装载、**可穿多件**（不再限 2 槽），但仍然计入道牌持有上限。
  // 卸下 / 装载都只能在出牌阶段做，且装载要消耗本回合的道牌使用名额。
  equipmentSlots: 99,

  // 术集上限（R19：覆盖规则书 5.5 的 2 套）
  maxSets: 3,
  startSets: 0,           // 2.1 初始状态：仅基础术

  // 平民子弟的身世天赋（1 血 ↔ 2 能量）从第几回合起可用（R76）：
  // 前两回合大家都没能量，能换血=平白多 2 点启动资金，太超标。
  convertFromTurn: 3,

  // 决策倒计时（R18）：无能量 -> 普通防御。出牌阶段的计时就以这里为准。
  decisionTimeoutMs: 45000,

  // 安全阀：单局回合上限（防止 AI 互苟导致死循环，正常不会触发）
  maxTurnsPerRound: 60,
};

export const hpForRound = (roundIndex) =>
  CONFIG.hpByRound[Math.min(roundIndex, CONFIG.hpByRound.length - 1)];

export const isValidPlayerCount = (n) => CONFIG.allowedPlayerCounts.includes(n);

// 积分（9.2）
export function roundScore({ factions, rank, winner, kills }) {
  const base = factions - rank + (winner ? 2 : 0) + kills;
  return base;
}
