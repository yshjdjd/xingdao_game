// 覆盖率报告：哪些卡引擎真正能跑，哪些还在等 prompt 系统。
// 运行：node cli/coverage.mjs
import * as D from "../src/data.mjs";

const groups = [
  ["基础术", D.raw.basic],
  ["术套系", D.raw.sets.flatMap((s) => s.cards.map((c) => ({ ...c, setName: s.name })))],
  ["天机", D.raw.tianji],
  ["道牌", D.raw.dao],
  ["身世", D.raw.birth],
];

let totalAll = 0, okAll = 0;
console.log("# 卡牌接入覆盖率\n");
console.log("| 分组 | 已接入 / 总数 | 覆盖率 |");
console.log("| --- | --- | --- |");
const missing = [];
for (const [name, list] of groups) {
  const ok = list.filter((c) => D.isImplemented(c.id));
  totalAll += list.length; okAll += ok.length;
  console.log(`| ${name} | ${ok.length} / ${list.length} | ${((ok.length / list.length) * 100).toFixed(0)}% |`);
  for (const c of list) {
    if (!D.isImplemented(c.id)) {
      const atoms = (D.fx.cards[c.id]?.atoms || []).map((a) => a.atom).join("/") || "未声明";
      missing.push({ group: name, id: c.id, name: c.name, atoms, why: c.text || c.effect || "" });
    }
  }
}
console.log(`| **合计** | **${okAll} / ${totalAll}** | **${((okAll / totalAll) * 100).toFixed(0)}%** |`);
console.log("\n## 未接入清单（全部集中在「需要中途二次互动」的卡）\n");
console.log("| 分组 | 名称 | 原子 | 规则要点 |");
console.log("| --- | --- | --- | --- |");
for (const x of missing) {
  const why = String(x.why).replace(/\|/g, "\\|").slice(0, 60);
  console.log(`| ${x.group} | ${x.name} | \`${x.atoms}\` | ${why} |`);
}
console.log(`\n> 未接入的卡不会出现在 AI 的候选动作里，也不会进入天机抽取池 —— 因此上面的平衡报告只反映已接入部分。`);
