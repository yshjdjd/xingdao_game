// 大厅可选的人数编制。
//
// R70：标签必须写**真实编制**。每个势力最多 2 人（CONFIG.maxMembersPerFaction = 2），
// 所以 factions=3,per=2 是「2v2v2」而不是「3v3」；factions=4,per=2 是「2v2v2v2」。
// 之前写成 3v3 / 4v4，等于告诉玩家"3 人一队"，和实际开局完全不符。
//
// 独立成模块是为了让测试能直接 import（online.mjs 顶层有 WebSocket 副作用，不适合被单测引入）。

export const CFG_OPTIONS = [
  { label: "1v1", factions: 2, per: 1 },
  { label: "1v1v1", factions: 3, per: 1 },
  { label: "1v1v1v1 · 混战", factions: 4, per: 1 },
  { label: "2v2", factions: 2, per: 2 },
  { label: "2v2v2", factions: 3, per: 2 },
  { label: "2v2v2v2", factions: 4, per: 2 },
];

// 标签里 "v" 分成的段数必须等于势力数，每段的人数必须等于每势力人数。
export const labelMatchesConfig = (o) => {
  const teams = o.label.replace(/\s*·.*$/, "").split("v");
  return teams.length === o.factions && teams.every((n) => Number(n) === o.per);
};
