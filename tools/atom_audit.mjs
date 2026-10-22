// 原子实现覆盖率自检。
//
// 背景：R63 修的 5 张「假道牌」都是同一个问题 —— 牌面在 data/effects.json 里挂了个原子名，
// 但引擎里没有任何人实现它，运行时静默无效（献祭、破防甚至连报错都没有）。
// 这个自检把「牌用到的原子」和「源码里被引用到的原子」对一遍：
//   1) 每个原子都得在 src/（除 data.mjs）里作为字符串字面量出现过，否则判定为"没人认领"
//   2) 每个原子都得在 SUPPORTED_ATOMS 里，否则 isImplemented() 会把整张牌判成未实现、直接从池子里筛掉
//   3) 每张道牌 / 天机都必须 isImplemented，否则它根本不会出现在游戏里
//
// 注意：这是**存在性**检查，抓不到"实现错对象"那一类（R63 的泣血珠就是挂在了守方），
// 那类必须靠行为测试。两种检查互补，都要有。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "src");

// 缓存源码（测试里多次调用不必重复读盘）
let _src = null;
function allSource() {
  if (_src != null) return _src;
  _src = fs.readdirSync(SRC)
    .filter((f) => f.endsWith(".mjs") && f !== "data.mjs")   // data.mjs 只是声明清单，不算实现
    .map((f) => fs.readFileSync(path.join(SRC, f), "utf8"))
    .join("\n");
  return _src;
}

// 三种"被认领"的写法都要认：
//   1) 字符串字面量  hasEquipAtom(m, p, "atkUp")
//   2) 对象方法简写  POST = { swapActions(ctx, seat) {…} }   ← special.mjs 里大量用这种
//   3) 对象键        case "x": / atom: "x"
const wiredInSource = (atom) =>
  new RegExp("[\"'`]" + atom + "[\"'`]|\\b" + atom + "\\s*[:(]").test(allSource());

// 收集"哪张牌用了哪个原子"
export function collectAtomUsage(D) {
  const used = new Map();      // atom -> Set(owner 文案)
  const add = (atom, owner) => {
    if (!used.has(atom)) used.set(atom, new Set());
    used.get(atom).add(owner);
  };
  for (const d of D.raw.dao) {
    for (const a of D.fx.cards[d.id]?.atoms || []) add(a.atom, `道牌·${d.name}`);
  }
  for (const t of D.raw.tianji) {
    for (const a of D.fx.cards[t.id]?.atoms || []) add(a.atom, `天机·${t.name}`);
  }
  for (const s of D.raw.sets) {
    for (const c of s.cards || []) {
      for (const a of D.fx.cards[c.id]?.atoms || []) add(a.atom, `术·${s.name}/${c.name}`);
    }
  }
  for (const b of D.raw.birth || []) {
    for (const a of D.fx.birth?.[b.id]?.atoms || []) add(a.atom, `身世·${b.name}`);
  }
  return used;
}

// 返回 { ok, orphans, unsupported, unimplemented }
export function auditAtoms(D) {
  const used = collectAtomUsage(D);
  const orphans = [];
  const unsupported = [];
  for (const [atom, owners] of used) {
    if (!wiredInSource(atom)) {
      orphans.push({ atom, owners: [...owners] });
    }
    if (!D.SUPPORTED_ATOMS.has(atom)) {
      unsupported.push({ atom, owners: [...owners] });
    }
  }
  const unimplemented = [];
  for (const d of D.raw.dao) if (!D.isImplemented(d.id)) unimplemented.push(`道牌·${d.name}(${d.id})`);
  for (const t of D.raw.tianji) if (!D.isImplemented(t.id)) unimplemented.push(`天机·${t.name}(${t.id})`);
  return {
    ok: !orphans.length && !unsupported.length && !unimplemented.length,
    orphans, unsupported, unimplemented,
    atomCount: used.size,
  };
}

// CLI：node tools/atom_audit.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const D = await import("../src/data.mjs");
  const r = auditAtoms(D);
  console.log(`牌面用到的原子：${r.atomCount} 个`);
  const show = (title, arr, fmt) => {
    if (!arr.length) { console.log(`✓ ${title}：无`); return; }
    console.log(`✗ ${title}：${arr.length} 项`);
    for (const x of arr) console.log("   " + fmt(x));
  };
  show("没人认领的原子", r.orphans, (x) => `${x.atom}  ← ${x.owners.slice(0, 4).join("、")}${x.owners.length > 4 ? ` 等 ${x.owners.length} 处` : ""}`);
  show("不在 SUPPORTED_ATOMS 的原子", r.unsupported, (x) => `${x.atom}  ← ${x.owners.join("、")}`);
  show("被判为未实现的牌", r.unimplemented, (x) => x);
  console.log(r.ok ? "\n原子自检通过 ✅" : "\n原子自检未通过 ❌");
  process.exit(r.ok ? 0 : 1);
}
