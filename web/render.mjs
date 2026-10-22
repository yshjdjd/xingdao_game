// 共用渲染：单机页与联机页都只认「投影」（view.mjs 的产物），不认引擎内部状态。
// 这样同一套 DOM 结构能同时服务两种模式，也保证联机页永远看不到别人的手牌。
import * as D from "./src/data.mjs";

export const nameOf = (id) => D.cardById(id)?.name || id;

// R49：基础术的四类。蓄力 / 自爆只有一个动作 → 不折叠，直接摆出来；
// 攻击 / 防御里面有各阶，才需要展开。顺序也按这个排。
export const BASIC_GROUPS = [
  { key: "base:蓄力", label: "蓄力", hint: "积累能量", order: 1, collapsible: false },
  { key: "base:自爆", label: "自爆", hint: "以命换命", order: 2, collapsible: false },
  { key: "base:攻术", label: "攻击", hint: "造成伤害", order: 3, collapsible: true },
  { key: "base:御术", label: "防御", hint: "提高判定阈值", order: 4, collapsible: true },
];

const BASIC_LABEL = {
  "蓄力": "蓄力", "攻术": "攻击", "御术": "防御", "自爆": "自爆",
};

// ---------- 牌面信息（悬浮 / 长按 / 点击详情都走这里） ----------

// 术 / 道 / 天机 / 身世 / 术集 五类牌的字段各不相同，统一成一份"详情"，UI 才不用分叉。
export function cardInfo(id) {
  const c = D.cardById(id);
  if (!c) return groupInfo(id) || { title: id, sub: "", tags: [], rows: [] };
  const rows = [];

  if (c.kind === "tianji") {
    return {
      title: c.name,
      sub: "天机",
      tags: [c.type || "天机", c.condition && c.condition !== "—" ? `触发：${c.condition}` : null].filter(Boolean),
      rows: [
        ["效果", c.effect || "—"],
        c.note ? ["备注", c.note] : null,
      ].filter(Boolean),
      tone: "tianji",
    };
  }

  if (c.kind === "birth") {
    return {
      title: c.name,
      sub: "身世",
      tags: [c.role].filter(Boolean),
      rows: [
        ["效果", c.effect || "—"],
        c.note ? ["备注", c.note] : null,
      ].filter(Boolean),
      tone: "birth",
    };
  }

  if (c.kind === "dao") {
    return {
      title: c.name,
      sub: "道牌",
      tags: [c.category, c.target ? `目标：${c.target}` : null].filter(Boolean),
      rows: [
        ["效果", c.text || "—"],
        c.duration ? ["时效", c.duration] : null,
        c.note ? ["备注", c.note] : null,
      ].filter(Boolean),
      tone: "dao",
    };
  }

  if (c.kind === "set") {
    return {
      title: c.name,
      sub: `术 · ${c.setName}`,
      tags: [c.type, `消耗 ${c.cost ?? 0}`],
      rows: [
        ["效果", c.text || "—"],
      ],
      tone: "shu",
      stat: statOf(c),
    };
  }

  return {
    title: c.name,
    sub: `基础术 · ${BASIC_LABEL[c.type] || c.type}`,
    tags: [c.type, `消耗 ${c.cost ?? 0}`],
    rows: [["效果", c.text || "—"]],
    tone: "shu",
    stat: statOf(c),
  };
}

// 折叠组的组头也能长按看说明（术集特性 / 基础术系用途）
function groupInfo(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith("set:")) {
    const s = D.setById(key.slice(4));
    if (!s) return null;
    return {
      title: s.name,
      sub: `术集 · 第 ${s.batch} 批`,
      tags: [s.passive ? "有套系特性" : "无套系特性"],
      rows: [
        ["套系特性", s.passive || "—"],
        ["包含", s.cards.map((x) => x.name).join("、")],
      ],
      tone: "set",
    };
  }
  if (key.startsWith("base:")) {
    const g = BASIC_GROUPS.find((x) => x.key === key);
    if (!g) return null;
    return {
      title: `${g.label}（基础术系）`,
      sub: "基础术",
      tags: ["基础术系"],
      rows: [["用途", g.hint]],
      tone: "set",
    };
  }
  return null;
}

function statOf(c) {
  if (c.type === "攻术") return { label: "攻击", value: c.atk };
  if (c.type === "御术") return { label: "防御", value: c.def ?? "∞" };
  if (c.type === "蓄力") return { label: "蓄力", value: `+1` };
  return null;
}

// ---------- 术牌区（折叠分组） ----------

// 术集各自成组，基础术按「蓄力 / 攻击 / 防御 / 自爆」四组，全部可折叠。
export function shuGroups(v) {
  const me = v.me;
  if (!me) return [];
  // R49：用 shuList（全部候选 + 可用标记），不是 playable（只含能打的）。
  // 老版本如果只有 playable，就退化为"全都可用"，不至于白屏。
  const list = me.shuList || (me.playable || []).map((x) => ({ ...x, usable: true, reason: "" }));
  const map = new Map();
  for (const item of list) {
    const card = D.cardById(item.id);
    if (!card) continue;
    let key, label, order, hint, collapsible;
    if (card.kind === "set") {
      key = `set:${card.setId}`;
      const s = D.setById(card.setId);
      label = card.setName;
      hint = s?.passive ? `套系特性：${s.passive}` : "术集";
      order = 0;                       // 术系排在最前
      collapsible = true;
    } else {
      const t = card.type;
      key = `base:${t}`;
      const g = BASIC_GROUPS.find((x) => x.key === key);
      label = g?.label || t;
      hint = g?.hint || "";
      order = g?.order ?? 5;
      collapsible = g?.collapsible ?? true;
    }
    if (!map.has(key)) map.set(key, { key, label, hint, order, collapsible, cards: [] });
    map.get(key).cards.push({ ...item, card });
  }
  const groups = [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const g of groups) {
    g.cards.sort((a, b) => (a.card.cost ?? 0) - (b.card.cost ?? 0)
      || String(a.card.atk ?? 0) - String(b.card.atk ?? 0));
  }
  return groups;
}

export function shuHtml(v, picked, expanded) {
  const groups = shuGroups(v);
  if (!groups.length) return '<div class="empty">暂无可打的术</div>';
  return groups.map((g) => {
    const hit = g.cards.some((x) => x.id === picked);
    const usable = g.cards.filter((x) => x.usable !== false).length;
    const count = `<span class="gcount" title="可用 / 全部">${usable}/${g.cards.length}</span>`;
    // R49：蓄力 / 自爆不用展开，直接把牌摆出来
    if (!g.collapsible) {
      return `<div class="grp flat ${hit ? "hit" : ""}">
        <span class="ghead flat" data-tip="${g.key}">
          <span class="gname">${g.label}</span>${count}
        </span>
        <div class="gbody">${g.cards.map((x) => shuBtn(x, picked)).join("")}</div>
      </div>`;
    }
    const open = expanded.has(g.key);
    return `
      <div class="grp ${open ? "open" : ""}">
        <button class="ghead" data-grp="${g.key}" data-tip="${g.key}">
          <span class="gtoggle">${open ? "−" : "+"}</span>
          <span class="gname">${g.label}</span>${count}
          ${hit ? '<span class="gdot"></span>' : ""}
        </button>
        ${open ? `<div class="gbody">${g.cards.map((x) => shuBtn(x, picked)).join("")}</div>` : ""}
      </div>`;
  }).join("");
}

function shuBtn(x, picked) {
  const c = x.card;
  const stat = statOf(c);
  // R49：不能用的变灰 + 不可点（服务端给的 usable / reason，客户端不自己判断）
  const usable = x.usable !== false;
  return `<button class="pick ${picked === x.id ? "sel" : ""} ${c.kind === "set" ? "isset" : ""} ${usable ? "" : "dim"}"
      ${usable ? `data-shu="${x.id}"` : "disabled"} data-tip="${x.id}" title="${usable ? "" : (x.reason || "不可用")}">
      <span class="pn">${c.name}</span>
      <span class="pb">${usable
        ? (stat ? `<b>${stat.label} ${stat.value}</b>` : c.type) + ` · 费${x.cost}`
        : `<b>${x.reason || "不可用"}</b>`}</span>
    </button>`;
}

// R49：道牌区 —— 只有自己能看到自己的具体道牌。最多约 6 张，用 grid 自适应排。
export function daoHtml(v, picked, opts = {}) {
  const list = v.me?.daoList || (v.me?.hand || []).map((id) => ({ id, usable: true, reason: "" }));
  if (!list.length) return '<div class="empty">（无道牌）</div>';
  return list.map((x) => {
    const c = D.cardById(x.id);
    const isEquip = c.category === "神装牌";
    // R55：神装在手牌区里就能直接装载（占本回合道牌名额），不必走出牌提交
    const eqBtn = (opts.equipUI && isEquip)
      ? `<span class="eq" data-eq-on="${x.id}" title="装载（占本回合的道牌名额）">装载</span>` : "";
    const usable = x.usable !== false;
    return `<button class="pick dao ${picked === x.id ? "sel" : ""} ${usable ? "" : "dim"}"
        ${usable ? `data-dao="${x.id}"` : "disabled"} data-tip="${x.id}"
        title="${usable ? "" : (x.reason || "不可用")}">
        <span class="pn">${c.name}</span>
        <span class="pb">${c.category || "道牌"}</span>${eqBtn}
      </button>`;
  }).join("");
}

// R49：天赋区 —— 只在身世涉及主动决策时才出现（平民的血能兑换、杏林的换治疗牌）
export function talentHtml(v, opts = {}) {
  const me = v.me;
  if (!me) return "";
  const ops = me.freeOps || [];
  if (!ops.length) return "";
  return `<div class="talent">
    <div class="th"><i>天赋</i><b>${me.birthName || "身世"}</b>${opts.status || ""}</div>
    <div class="tb">${me.birthText || ""}</div>
    ${opts.buttons || ""}
  </div>`;
}

// R55：已装载的神装 —— 卸下同样只在这里做，不占道牌名额
export function equipRowHtml(v, opts = {}) {
  const eq = v.me?.equip || [];
  if (!eq.length) return "";
  const items = eq.map((id) => {
    const c = D.cardById(id);
    const off = opts.equipUI
      ? `<span class="eq off" data-eq-off="${id}" title="卸下（不占道牌名额）">卸下</span>` : "";
    return `<span class="eqchip" data-tip="${id}">${c.name}${off}</span>`;
  }).join("");
  return `<div class="eqrow"><span class="eqlabel">已装载 ${eq.length} 件</span>${items}</div>`;
}

// ---------- 出牌槽（斗地主式：贴在每个座位靠中心的一侧） ----------

export function playCardHtml(e, { faceDown = false } = {}) {
  if (faceDown) {
    return `<div class="pcard back"><span>?</span></div>`;
  }
  const c = D.cardById(e.cardId);
  const stat = c ? statOf(c) : null;
  return `<div class="pcard ${stat ? "" : "plain"}" data-tip="${e.cardId || ""}">
      <div class="pc-n">${e.name || "—"}</div>
      <div class="pc-v">${stat ? stat.value : ""}</div>
      ${e.timedOut ? '<div class="pc-tag">超时</div>' : ""}
    </div>`;
}

// ---------- 中央天机坛 ----------

export function tianjiHtml(v, opts = {}) {
  const id = v.tianji?.now || null;
  const c = id ? D.cardById(id) : null;
  // R61：中央只讲"本回合发生了什么"。全场持续效果挪到每个人的状态栏去了 ——
  // 多人局里你真正要看的是"谁现在带什么状态"，不是中央再重复一遍。

  const now = c ? `
      <div class="tj-card" data-modal="${id}" data-tip="${id}">
        <div class="tj-kind">天机 · ${c.type || "无常"}</div>
        <div class="tj-name">${c.name}</div>
        <div class="tj-effect">${c.effect || "—"}</div>
        ${c.condition && c.condition !== "—" ? `<div class="tj-cond">触发条件：${c.condition}</div>` : ""}
        <div class="tj-more">点击查看详情 ›</div>
      </div>` : `
      <div class="tj-none">
        <div class="tj-none-ic">☰</div>
        <div class="tj-none-t">本回合天机未涌动</div>
        <div class="tj-none-s">${
          v.tianji?.last
            ? `最近一次：${nameOf(v.tianji.last)}${v.tianji.since ? `　已连续 ${v.tianji.since} 回合平静` : ""}`
            : "开局至今风平浪静"
        }${v.tianji?.pity ? `　·　连续 ${v.tianji.pity} 回合必现` : ""}</div>
      </div>`;

  // 中央太空会显得没内容：把"本局争哪几套术"放进来，也是玩家最关心的一条公开信息
  const poolHtml = (v.pool || []).length ? `
      <div class="pool-row">
        <span class="pool-lab">本局争夺</span>
        ${v.pool.map((s) => `<span class="chip-mini" data-tip="set:${s.id}" data-modal="set:${s.id}">${s.name}</span>`).join("")}
      </div>` : "";

  const top = `<div class="tj-top">第 ${(v.round ?? 0) + 1} 局 · 第 ${v.turn ?? 0} 回合</div>`;

  return `${top}<div class="tj-wrap ${id ? "on" : ""}">${now}</div>${poolHtml}`;
}

// R67：拍卖结果公示（3 秒）—— 拍品、每个人的出价、成交结果
export function auctionResultHtml(v, opts = {}) {
  // 注意：拍卖结果挂在**消息顶层**（msg.auctionResult），不在 view 里 ——
  // 它是界面状态而不是投影数据。所以优先从 opts 取，v 上只作为兜底。
  const r = opts.auctionResult || v.auctionResult;
  if (!r) return "";
  const nm = (s) => (opts.names?.[s] || r.bids.find((b) => b.seat === s)?.name || `座位${s + 1}`).slice(0, 6);
  const rows = (r.bids || []).map((b) => {
    const win = (r.winners || []).some((w) => w.seat === b.seat);
    return `<span class="ar-bid ${win ? "win" : ""} ${b.bid === 0 ? "zero" : ""}">
      <i>${nm(b.seat)}</i><b>${b.bid}</b></span>`;
  }).join("");
  const verdict = r.reason === "sold"
    ? `<span class="ar-win">${(r.winners || []).map((w) => nm(w.seat)).join("、")} 以 <b>${r.price}</b> 点拍得</span>`
    : `<span class="ar-none">流拍${r.reason === "tie2" ? "（两人同价）" : "（无人出价）"} · 全场不扣能量</span>`;
  return `<div class="ar-card" data-tip="${r.offerId || ""}" data-modal="${r.offerId || ""}">
      <div class="ar-hd">道牌拍卖 · 第 ${r.turn} 回合</div>
      <div class="ar-name">${r.name || "?"}<em>${r.category || ""}</em></div>
      <div class="ar-bids">${rows || '<span class="ar-none">无人参与</span>'}</div>
      <div class="ar-verdict">${verdict}</div>
    </div>`;
}

// R68：多人博弈的「决策过程」卡片 —— 囚徒困境 / 收割 / 狭路相逢 / 移魂术 / 天之赌场
// 这些牌要别人做选择，就算全是人机，也得让玩家看清"谁选了什么、结果如何"
const SG_NAME = { prisoner: "囚徒困境", harvest: "收割", chicken: "狭路相逢", bet: "天之赌场" };

export function subgameHtml(v, opts = {}) {
  const evs = (opts.events || []).filter((e) => e.t === "subgame" || e.t === "soulSwap");
  if (!evs.length) return "";
  const nm = (s) => (opts.names?.[s] || `座位${s + 1}`).slice(0, 6);
  const nz = (x) => Number(x) !== 0 && Number.isFinite(Number(x));
  const sgn = (x) => { const n = Number(x); return n > 0 ? `+${n}` : String(n); };

  return evs.map((e) => {
    if (e.t === "soulSwap") {
      const what = [e.swapHp && "血量", e.swapEn && "能量"].filter(Boolean).join(" + ") || "无";
      const row = (s, pick, b, a) => `<span class="sg-pick">
        <i>${nm(s)}</i><b>${pick || "—"}</b><em>${b?.hp ?? "?"}/${b?.en ?? "?"} → ${a?.hp ?? "?"}/${a?.en ?? "?"}</em></span>`;
      return `<div class="sg-card">
        <div class="sg-hd">移魂术</div>
        <div class="sg-picks">${row(e.a, e.picks?.[0]?.[1], e.before?.a, e.after?.a)}${row(e.b, e.picks?.[1]?.[1], e.before?.b, e.after?.b)}</div>
        <div class="sg-out">交换 <b>${what}</b>（数值为 血/能）</div>
      </div>`;
    }
    const picks = (e.picks || []).map(([s, val]) =>
      `<span class="sg-pick"><i>${nm(s)}</i><b>${val}</b></span>`).join("");
    const ds = (e.delta || []).map((d) => {
      const parts = [];
      if (nz(d.hp)) parts.push(`血 ${sgn(d.hp)}`);
      if (nz(d.energy)) parts.push(`能 ${sgn(d.energy)}`);
      return parts.length ? `<span class="sg-d"><i>${nm(d.seat)}</i>${parts.join(" · ")}</span>` : "";
    }).filter(Boolean).join("");
    const gain = (e.by != null && nz(e.byGain)) ? `<span class="sg-by">${nm(e.by)} 额外 +${e.byGain} 能量</span>` : "";
    const bet = e.kind === "bet"
      ? `<div class="sg-out">总注 ${e.total || 0}；${(e.winners || []).map(nm).join("、") || "无人"} 押 ${e.top ?? 0}`
        + `${e.payWinner ? ` 各得 +${e.payWinner}` : ""}${e.payOther ? `，其余各 +${e.payOther}` : ""}</div>`
      : "";
    return `<div class="sg-card">
      <div class="sg-hd">${SG_NAME[e.kind] || "博弈"}</div>
      ${picks ? `<div class="sg-picks">${picks}</div>` : ""}
      ${e.outcome ? `<div class="sg-out">${e.outcome}</div>` : ""}
      ${ds ? `<div class="sg-deltas">${ds}</div>` : ""}
      ${gain}
      ${bet}
    </div>`;
  }).join("");
}

// 结算一句话摘要（展示阶段挂在天机坛下方）
// R72：局初官宦子弟「同时随机抽取术系」的公示（3 秒）
export function tempDrawHtml(v, opts = {}) {
  const list = opts.tempDraw || [];
  if (!list.length) return "";
  const nm = (s) => (opts.names?.[s] || `座位${s + 1}`).slice(0, 6);
  return `<div class="td-card">
      <div class="td-hd">局初抽取 · 官宦子弟特权</div>
      <div class="td-list">${list.map((d) => `<span class="td-item">
        <i>${nm(d.seat)}</i><b>${d.name}</b><em>${d.cards} 张术</em></span>`).join("")}</div>
      <div class="td-note">各自随机、互不影响（可能抽到同一套）</div>
    </div>`;
}

// R72：局末术系轮抽 —— 顺序（淘汰越早越先挑）+ 剩余池子 + 已挑结果
export function setDraftHtml(v, opts = {}) {
  const d = opts.setDraft;
  if (!d) return "";
  const nm = (s) => (opts.names?.[s] || `座位${s + 1}`).slice(0, 5);
  const setName = (id) => D.setById(id)?.name || id;
  const rows = (d.order || []).map((o, i) => {
    const who = (o.members || []).map(nm).join("/");
    // R73：多人势力只有"最后被淘汰的那位"能决定，标出来
    const by = (o.members || []).length > 1 && o.rep != null
      ? `<em class="sd-by">由 ${nm(o.rep)} 决定</em>` : "";
    const picked = o.setId
      ? (o.note === "convert" ? "已拥有 · 转 2 能量" : setName(o.setId))
      : (o.note === "empty" ? "池子已空" : "");
    return `<div class="sd-row ${o.state}">
      <span class="sd-i">${i + 1}</span>
      <span class="sd-who">${who}${by}</span>
      <span class="sd-why">${o.alive ? "存活" : `第 ${o.survived} 回合出局`}</span>
      <span class="sd-got">${picked || (o.state === "current" ? "<b>挑选中…</b>" : "待挑")}</span>
    </div>`;
  }).join("");
  const pool = (d.pool || []).map((id) => `<span class="sd-pool" data-tip="${id}" data-modal="${id}">${setName(id)}</span>`).join("");
  return `<div class="sd-card">
      <div class="sd-hd">术系轮抽 · 活得越久越先挑</div>
      <div class="sd-rows">${rows}</div>
      <div class="sd-poolbox">${pool ? `<i>剩余</i>${pool}` : `<i>已挑完</i>`}</div>
    </div>`;
}

export function summaryHtml(events, names) {
  if (!events || !events.length) return "";
  const label = (s) => (names[s] || "?").slice(0, 6);
  const hits = events.filter((e) => e.t === "hit");
  const fails = events.filter((e) => e.t === "fail");
  const line = events.find((e) => e.t === "line");
  const bits = [];
  if (hits.length) bits.push(`<span class="s-hit">命中 ${hits.map((e) => label(e.target)).join("、")}</span>`);
  if (fails.length) {
    // R58：已经因命中掉过血的人，判定失败不再二次扣血，标注一下免得玩家以为是少算了
    const txt = fails.map((e) => `${label(e.seat)}${e.merged ? "（已计入命中）" : ""}`).join("、");
    bits.push(`<span class="s-fail">判定失败 ${txt}</span>`);
  }
  if (line) bits.push(`<span class="s-line">胜者线 ${line.value}${line.tied ? "（并列 · 最高者互不相伤）" : ""}</span>`);
  // R67：拍卖结果现在由中央的结果卡单独呈现（公示 3 秒），这里不再重复一行
  const bet = events.find((e) => e.t === "subgame" && e.kind === "bet" && e.total);
  if (bet) {
    bits.push(`<span class="s-auc">赌局 总注 ${bet.total}：${bet.winners.map(label).join("、")} 各得 +${bet.payWinner}`
      + `${bet.payOther ? `，其余各 +${bet.payOther}` : ""}</span>`);
  }
  const credits = events.filter((e) => e.t === "credit");
  if (credits.length) {
    bits.push(`<span class="s-auc">赊借 ${credits.map((e) => `${label(e.seat)} +${e.amount}`).join("、")}</span>`);
  }
  const elim = events.filter((e) => e.t === "eliminate");
  if (elim.length) bits.push(`<span class="s-dead">出局 ${elim.map((e) => label(e.seat)).join("、")}</span>`);
  return bits.length ? `<div class="sum">${bits.join("")}</div>` : "";
}

// ---------- 中央：回合进程条 ----------
// 一个回合走完的顺序：拍卖 → 出牌 → 追问 → 结算 → 弃牌。
// 牌桌中央常驻显示，让大家随时知道"现在走到哪一步、刚才发生了什么"。
// R42：天机判定/执行是瞬时环节（无人需要操作），没有独立阶段，所以不占进程条的一格。
//      结果会显示在中央「天机坛」：有则写"天机动荡：XXX"，无则写"天机平稳"。
const STEPS = [
  { k: "auction", n: "拍卖" },
  { k: "choose", n: "出牌" },
  { k: "prompt", n: "追问" },
  { k: "reveal", n: "结算" },
  { k: "discard", n: "弃牌" },
];

export function progressHtml(ctx = {}) {
  const phase = ctx.phase || "";
  const idx = STEPS.findIndex((s) => s.k === phase);
  const items = STEPS.map((s, i) => {
    const cls = i === idx ? "on" : idx >= 0 && i < idx ? "done" : "";
    return `<span class="pg-i ${cls}"><i>${i + 1}</i>${s.n}</span>`;
  }).join('<span class="pg-a">›</span>');

  // 底下那行提示：优先说"在等谁"，否则播报最近发生的事
  let note = "";
  const waiting = ctx.waiting || [];
  const names = ctx.names || [];
  if (waiting.length && ["choose", "auction", "prompt", "discard"].includes(phase)) {
    const who = waiting.map((s) => (names[s] || "?").slice(0, 6)).join("、");
    const verb = { choose: "出牌", auction: "出价", prompt: "做选择", discard: "弃牌" }[phase];
    note = `等待 ${who} ${verb}`;
  }
  // R67：拍卖结果公示期，中央已经有一整块结果卡了，这里只说一句别重复出价列表
  if (!note && phase === "auctionResult") note = "出价已揭晓，3 秒后转入事件记录";
  if (!note) {
    const evs = (ctx.events || []).filter((e) => e.t !== "play").slice(-1);
    if (evs.length) note = eventLine(evs[0], names).replace(/<[^>]+>/g, "");
  }
  if (!note) {
    const plays = (ctx.events || []).filter((e) => e.t === "play");
    if (plays.length) note = `本回合 ${plays.length} 人已出手`;
  }
  return `<div class="progress">${items}${note ? `<div class="pg-note">${note}</div>` : ""}</div>`;
}

// 事件 → 一行战报（事件表面板用）
export function eventLine(e, names) {
  const label = (s) => (names[s] || "?").slice(0, 6);
  switch (e.t) {
    case "hit":
      return e.repeat
        ? `<span class="k">再被够到</span> ${label(e.by)} → ${label(e.target)}（基础已封顶，只叠加附加效果）`
        : `<span class="k">命中</span> ${label(e.by)} → ${label(e.target)}（${e.value} 破 ${e.threshold}）`;
    case "discard": return `${label(e.seat)} 弃掉 ${(e.names || []).join("、")}`;
    case "fail": return `${label(e.seat)} 判定失败${e.merged ? "（已计入命中）" : ""}`;
    case "eliminate": return `<span class="k">出局</span> ${label(e.seat)}`;
    case "tianji": return `<span class="k">天机</span> ${nameOf(e.id)}`;
    case "supply": return `补给：全场 +1 能量`;
    case "decay": return `<span class="k">终局衰减</span> 全场 -1 血`;
    case "auction": return `<span class="k">拍卖</span> ${e.name ?? nameOf(e.cardId)}`;
    case "auctionWin": return `${label(e.seat)} 以 ${e.bid} 点能量拍得 ${nameOf(e.cardId)}（未拍中者不扣能量）`;
    case "auctionResult": {
      // R67：把所有人的出价写进记录，别只留个"流拍"
      const who = (e.bids || []).map((b) => `${label(b.seat)} ${b.bid}`).join(" · ");
      const bids = who ? `出价 ${who}` : "";
      if (e.kind === "sold") return `<span class="k">拍卖</span> ${bids}`;
      const why = e.reason === "tie2" ? "两人同价，流拍" : "无人出价，流拍";
      return `<span class="k">拍卖</span> ${bids}（${why}，全场不扣能量）`;
    }
    case "forceFail": return `${label(e.seat)} 拒绝/无法攻击，扣 1 血`;
    case "reflect": return `${label(e.from)} 反弹命中 ${label(e.to)}`;
    case "damageAll": return `全场受到 ${e.amount} 点`;
    case "healCard": return `${label(e.by)} 治疗了 ${label(e.to)}`;
    case "convert": return `${label(e.seat)} 兑换 ${e.to === "hp" ? "血量" : "能量"}`;
    case "buyHeal": return `${label(e.seat)} 换来一张治疗牌`;
    case "negate": return `${label(e.seat)} 无懈可击`;
    case "revive": return `${label(e.seat)} 复活`;
    case "ban": return `${label(e.by)} 封了 ${label(e.target)} 的术（本回合无效 + 下回合禁用）`;
    case "void": return `${label(e.seat)} 的出牌被无效化`;
    // 胜者线：并列只让最高者之间互不相伤，其余人照常判定（R06）
    case "line":
      return e.tied
        ? `<span class="k">胜者线</span> ${e.value}（并列 → 最高者互不相伤，其余照常判定）`
        : `<span class="k">胜者线</span> ${e.value}`;
    case "subgame": {
      if (e.kind === "bet") {
        if (!e.total) return "赌局：全场弃权";
        const w = (e.winners || []).map((s) => label(s)).join("、");
        const rest = e.payOther ? `，其余各 +${e.payOther}` : "";
        return `<span class="k">赌局</span> 总注 ${e.total}；${w} 押 ${e.top} 各得 +${e.payWinner}${rest}`;
      }
      // R68：囚徒 / 收割 / 狭路相逢 —— 过程（谁选了什么）+ 结果 + 各自得失
      const nm = { prisoner: "囚徒困境", harvest: "收割", chicken: "狭路相逢" }[e.kind] || "博弈";
      const choices = (e.picks || []).map(([s, v]) => `${label(s)}「${v}」`).join(" · ");
      const ds = (e.delta || []).map((d) => {
        const a = [];
        if (Number(d.hp)) a.push(`血${Number(d.hp) > 0 ? "+" : ""}${d.hp}`);
        if (Number(d.energy)) a.push(`能${Number(d.energy) > 0 ? "+" : ""}${d.energy}`);
        return a.length ? `${label(d.seat)} ${a.join("/")}` : "";
      }).filter(Boolean).join(" · ");
      const gain = (e.by != null && Number(e.byGain)) ? `；${label(e.by)} 额外 +${e.byGain} 能` : "";
      return `<span class="k">${nm}</span> ${choices}`
        + (e.outcome ? ` → ${e.outcome}` : "")
        + (ds ? `（${ds}${gain}）` : "");
    }
    case "soulSwap": {
      const what = [e.swapHp && "血量", e.swapEn && "能量"].filter(Boolean).join("+") || "无";
      const pa = e.picks?.[0]?.[1] || "?", pb = e.picks?.[1]?.[1] || "?";
      return `<span class="k">移魂术</span> ${label(e.a)}「${pa}」· ${label(e.b)}「${pb}」→ 交换 ${what}`;
    }
    case "tempDraw":
      return `<span class="k">官宦子弟抽取</span> ${label(e.seat)} 拿到 ${e.name}（临时借用，不占上限）`;
    case "setDraft": {
      const who = (e.names || []).map((x) => x.slice(0, 6)).join(" / ")
        || (e.members || []).map(label).join(" / ");
      if (e.note === "empty") return `<span class="k">术系轮抽</span> ${who} 轮到时池子已空`;
      if (e.note === "convert") return `<span class="k">术系轮抽</span> ${who} 已拥有 ${e.name}（转 2 能量）`;
      return `<span class="k">术系轮抽</span> ${who} 挑走 ${e.name}${e.left ? `（剩 ${e.left} 套）` : ""}`;
    }
    case "setDraftEnd": return `<span class="k">术系轮抽</span> 全部挑完，共 ${e.total} 家`;
    case "credit": return `${label(e.seat)} 赊借 ${e.amount} 能量`;
    case "daoGain": {
      // R78：自己看牌名，别人只知道"抽了 1 张"（道牌内容私有）
      if (e.empty) return `<span class="k">抽牌</span> 牌库已抽空，${label(e.seat)} 没能拿到道牌`;
      if (e.hidden) return `${label(e.seat)} 抽到 1 张道牌`;
      if (e.seized) return `<span class="k">抽牌</span> ${label(e.seat)} 抽到 ${e.name}，被天道没收抵债`;
      return `<span class="k">抽牌</span> ${label(e.seat)} 抽到 ${e.name}`;
    }
    case "debt": {
      // R75：欠债清算 —— 先用能量还，再掉道牌，剩下的继续欠
      const bits = [];
      if (Number(e.paid)) bits.push(`能量 -${e.paid}`);
      if ((e.lost || []).length) bits.push(`抵掉 ${e.lost.length} 张道牌（回牌库）`);
      if (Number(e.left)) bits.push(`仍欠 ${e.left} 点`);
      return `<span class="k">赊天清算</span> ${label(e.seat)} 欠 ${e.owe0} 点${
        bits.length ? `：${bits.join("，")}` : ""}`;
    }
    case "debtSeize":
      return `<span class="k">天道没收</span> ${label(e.seat)} 刚获得的 ${e.name} 被直接抵债（牌回牌库）${
        Number(e.left) ? `，仍欠 ${e.left} 点` : "，已还清"}`;
    case "debtForgive":
      return `<span class="k">赊天免除</span> ${label(e.seat)} 活到最后，${e.amount} 点欠账一笔勾销`;
    case "debtSeizeEnd": return "";
    default: return "";
  }
}
