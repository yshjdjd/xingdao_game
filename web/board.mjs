// 牌桌：把「势力」放到画面的四条边上。
//
// 规则很简单——我在南，其他势力按势力序号顺次坐剩下的边：
//   2 个势力 → 南 / 北（正对）
//   3 个势力 → 南 / 西 / 东（北边空出来）
//   4 个势力 → 南 / 西 / 北 / 东
//   8 人（4 势力 ×2）时同一边的两个人并排，仍然是"同势力同一边"。
import * as D from "./src/data.mjs";
import { playCardHtml, tianjiHtml, summaryHtml, progressHtml, auctionResultHtml, subgameHtml,
  tempDrawHtml, setDraftHtml } from "./render.mjs";

export const FAC_COLORS = ["#2f5d62", "#a5332a", "#8a6a2f", "#5b544a"];
export const facColor = (i) => FAC_COLORS[i % FAC_COLORS.length];
// R48：势力只用「一 / 二 / 三 / 四」表示，颜色块做区分
const FAC_NUM = ["一", "二", "三", "四"];
export const facLabel = (i) => FAC_NUM[i] || String(i + 1);

const SIDE_BY_OFFSET = {
  2: ["s", "n"],
  3: ["s", "w", "e"],
  4: ["s", "w", "n", "e"],
};

// 势力 → 方位。myFaction 永远在南（自己人贴着手牌区，视线最短）。
export function sideMap(v, mySeat) {
  const factions = [...new Set(v.players.map((p) => p.factionId))].sort((a, b) => a - b);
  const mine = mySeat >= 0 ? v.players[mySeat]?.factionId ?? factions[0] : factions[0];
  const order = SIDE_BY_OFFSET[factions.length] || SIDE_BY_OFFSET[4];
  const out = { n: [], s: [], w: [], e: [] };
  factions.forEach((f, idx) => {
    const rel = (f - mine + factions.length) % factions.length;
    const side = order[rel] || "n";
    out[side] = v.players.filter((p) => p.factionId === f).map((p) => p.seat);
  });
  return out;
}

const hpPct = (p) => {
  const max = Number(p.maxHp) || 1;
  return Math.max(0, Math.min(100, (Number(p.hp) / max) * 100));
};

const shortName = (s, n = 5) => (s || "?").slice(0, n);

// 术集是明置信息（R19：归势力所有），所以在对面也能看到"他抢到了什么"。
// R48：每个术系都能点开预览它包含的术，再点开某张术看详情。
function setChips(p) {
  const own = (p.sets || []).map((id) => ({ id, temp: false }));
  // R59：官宦子弟临时借来的术系也要公开（标个"临时"）
  const tmp = (p.tempSets || []).map((id) => ({ id, temp: true }));
  const all = [...own, ...tmp].map((x) => ({ ...x, s: D.setById(x.id) })).filter((x) => x.s);
  if (!all.length) return '<span class="chip-none">—</span>';
  return all.map(({ s, temp }) => {
    const isBan = (p.statuses || []).some((st) => st.k === "ban" && st.label.includes(s.name));
    return `<span class="chip-mini ${temp ? "tmp" : ""} ${isBan ? "ban" : ""}"
      data-tip="set:${s.id}" data-modal="set:${s.id}" title="${temp ? "临时术系（身世特权）" : ""}${isBan ? " · 已被封禁" : ""}"
      >${s.name}${temp ? "*" : ""}</span>`;
  }).join("");
}

// R74：状态改成卡片正下方的**独立面板**（不再是绝对定位的浮层）。
//
// 上一版用的是 position:absolute 挂在卡片外侧 —— 结果西边那张会被推到牌桌外的左侧、
// 东边推到右侧，正好落在 .play{overflow:hidden} 的裁切范围里，**实战里几乎看不到**。
// 现在改成文档流里的面板：卡片下面一行标题 + 分组行（装 / 术 / 禁 / 益 / 限 / 示），
// 永远不会被裁，也不用跟着视角算方位。
const STATUS_TAG = {
  equip: "装", equipDown: "禁", tempSet: "术", ban: "禁",
  shield: "护", buff: "益", costUp: "限", limit: "限", reveal: "示", info: "状",
};

function statusDockHtml(p) {
  const list = p.statuses || [];
  const hand = p.shownHand || [];
  const rows = list.map((s) => {
    const tag = STATUS_TAG[s.k] || "状";
    const link = s.id ? ` data-tip="${s.id}" data-modal="${s.id}"` : "";
    return `<div class="strow t-${s.tone || "info"}" title="${s.detail || s.label}"${link}>
      <i>${tag}</i><span>${s.label}</span></div>`;
  });
  if (hand.length) {
    rows.push(`<div class="strow t-info" title="天下大白：道牌已公示">
      <i>牌</i><span>${hand.map((id) => D.cardById(id)?.name || id).join("、")}</span></div>`);
  }
  const body = rows.length ? rows.join("") : `<div class="dock-none">无</div>`;
  return `<div class="dock ${rows.length ? "" : "empty"}">
      <div class="dock-hd"><b>状态</b>${rows.length ? `<em>${rows.length}</em>` : ""}</div>
      <div class="dock-body">${body}</div>
    </div>`;
}

export function seatHtml(v, seat, ctx = {}) {
  const p = v.players[seat];
  if (!p) return "";
  const { mySeat = -1, waiting = [], submitted = [], played = null } = ctx;
  const isMe = seat === mySeat;
  const dead = !p.alive;
  const wait = waiting.includes(seat);
  const done = submitted.includes(seat);
  const color = facColor(p.factionId);

  const birth = p.birth ? D.cardById(p.birth) : null;
  const slot = played ? playCardHtml(played) : "";
  const fac = facLabel(p.factionId);

  // R48：八个人的对外卡片结构完全一致 —— 名称 / 势力 / 身世 / 血量 / 能量 / 道牌数量。
  // 身世突出显示且可点开看天赋全文；术系与神装放在卡片下方的空白区，逐个可预览。
  const card = `
    <div class="pcard-slot ${played ? "has" : ""}">${slot}</div>
    <div class="seatcard ${dead ? "dead" : ""} ${isMe ? "mine" : ""} ${wait ? "wait" : ""}">
      <span class="facbar" style="background:${color}"></span>

      <div class="sc-top">
        <span class="facnum" style="background:${color}">${fac}</span>
        <div class="sc-id">
          <div class="sc-nm">${shortName(p.name, 6)}${isMe ? '<i class="tag me">我</i>' : ""}${p.isAI ? '<i class="tag ai">AI</i>' : ""}</div>
          <div class="sc-fac" style="color:${color}">势力 ${fac}</div>
        </div>
      </div>

      <div class="hpbar"><i style="width:${hpPct(p)}%"></i></div>

      <!-- R62：血量 / 能量 / 道牌数是决策时最常扫的三样，放大加粗 -->
      <div class="sc-nums">
        <span class="n-hp" title="血量"><i>血</i><b>${p.hp}</b><em>/${p.maxHp}</em></span>
        <span class="n-en" title="能量"><i>能</i><b>${p.energy}</b></span>
        <span class="n-dao" title="${p.shownHand ? "道牌（天下大白：已公示）" : "道牌数量"}"><i>道</i><b>${p.handCount}</b></span>
      </div>

      <div class="sc-birth ${birth ? "" : "none"}" ${birth ? `data-tip="${p.birth}" data-modal="${p.birth}"` : ""}>
        <i>身世</i><b>${birth ? birth.name : "—"}</b>
      </div>

      <!-- R62：术系是"这个人拥有什么"，留在卡里；神装 / 封禁 / 增益这些动态状态挪到外侧浮层 -->
      <div class="sc-side">
        <div class="side-row"><i>术系</i>${setChips(p)}</div>
      </div>

      <div class="sc-tags">
        ${dead ? '<span class="badge dead">出局</span>' : wait ? '<span class="badge wait">思考中</span>' : done ? '<span class="badge done">已出牌</span>' : ""}
      </div>
    </div>`;

  // R59：阵亡的人整块区域压暗 + 加一条出局横幅，一眼看得出谁已经死了
  const deadOverlay = dead ? `
    <div class="dead-veil">
      <span class="dead-stamp">出局</span>
      ${p.deadInfo ? `<span class="dead-sub">${p.deadInfo}</span>` : ""}
    </div>` : "";

  // R70：横屏手机另给一套「紧凑条」。桌面版的六字段竖排卡在 390 高的屏幕上只能靠缩字号，
  // 结果就是全挤在一起 —— 所以手机横屏不是把它缩小，而是换成一条横排：
  // 势力号 + 名字 + 身世/术系一行小字 + 血/能/道三数。两套结构同时输出，由 CSS 切换，
  // 这样旋转屏幕时不需要重新渲染。
  const setNames = [...(p.sets || []), ...(p.tempSets || [])]
    .map((id) => D.setById(id)?.name).filter(Boolean);
  const mini = `
    <div class="pcard-slot ${played ? "has" : ""}">${slot}</div>
    <div class="seatcard mini ${dead ? "dead" : ""} ${isMe ? "mine" : ""} ${wait ? "wait" : ""}">
      <span class="facbar" style="background:${color}"></span>
      <span class="facnum" style="background:${color}">${fac}</span>
      <div class="mn-id">
        <div class="mn-nm">${shortName(p.name, 5)}${isMe ? '<i class="tag me">我</i>' : ""}${dead ? '<i class="tag dl">出局</i>' : ""}</div>
        <div class="mn-sub">${birth ? birth.name : "—"}${setNames.length ? " · " + setNames.join("/") : ""}</div>
      </div>
      <div class="sc-nums">
        <span class="n-hp" title="血量"><i>血</i><b>${p.hp}</b></span>
        <span class="n-en" title="能量"><i>能</i><b>${p.energy}</b></span>
        <span class="n-dao" title="道牌数"><i>道</i><b>${p.handCount}</b></span>
      </div>
      ${wait ? '<span class="mn-dot wait"></span>' : done ? '<span class="mn-dot done"></span>' : ""}
    </div>`;

  return `<div class="seat-v full">${card}</div>`
    + `<div class="seat-v mini">${mini}</div>`
    + statusDockHtml(p) + deadOverlay;

  // 出牌槽朝桌心的方向由 CSS（.zone-x .pcard-slot 的绝对定位）决定，DOM 顺序保持一致
  return card;
}

// 渲染整张桌子（四个方位 + 中央天机坛）
// R69：中央画哪张卡，规则集中在这里（可测）。
// 关键约束：博弈/拍卖的"各家选择"**只能在揭示之后**出现 ——
// choose / prompt 阶段就算手上已经有这些事件，也一律不画。
export function centerCardHtml(v, ctx = {}) {
  const phase = ctx.phase || "";
  if (phase === "auctionResult") return auctionResultHtml(v, ctx);
  if (phase === "reveal") {
    const sg = subgameHtml(v, ctx);
    if (sg) return sg;
  }
  // R72：局初抽取公示 / 局末术系轮抽，各自占中央
  if (phase === "tempDraw") return tempDrawHtml(v, ctx) || tianjiHtml(v, ctx);
  if (phase === "setDraft" || phase === "setDraftEnd") return setDraftHtml(v, ctx) || tianjiHtml(v, ctx);
  return tianjiHtml(v, ctx);
}

export function renderBoard(root, v, ctx = {}) {
  const map = sideMap(v, ctx.mySeat ?? -1);
  const playOf = ctx.playOf || {};
  // 自己永远坐在南边最左，队友坐右边 —— 这样"我的状态浮层在左、队友在右"是固定的
  if (map.s.includes(ctx.mySeat ?? -1)) {
    map.s = [ctx.mySeat, ...map.s.filter((s) => s !== ctx.mySeat)];
  }
  // R74：状态面板改到卡片正下方（文档流），不再需要按视角算方位
  for (const side of ["n", "w", "e", "s"]) {
    const host = root.querySelector(`[data-side="${side}"]`);
    if (!host) continue;
    const seats = map[side] || [];
    host.innerHTML = seats.map((seat, idx) => `
      <div class="member" data-seat="${seat}" style="--fac:${facColor(v.players[seat].factionId)}">
        ${seatHtml(v, seat, { ...ctx, side, played: playOf[seat] || null })}
      </div>`).join("");
    host.classList.toggle("empty-side", seats.length === 0);
  }

  const center = root.querySelector("[data-center]");
  if (center) {
    const mid = centerCardHtml(v, ctx);
    center.innerHTML = progressHtml(ctx)
      + mid
      + summaryHtml(ctx.events || [], ctx.names || []);
  }
}

// 从结算事件里取出"谁打了什么"，用于贴在各人面前的出牌槽
export function playsOf(events = []) {
  const out = {};
  for (const e of events) {
    if (e.t === "play") out[e.seat] = e;
  }
  return out;
}

// 暗选阶段：别人面前只显示牌背，自己的显示真牌（自己当然知道自己打了啥）
export function maskPlays(plays, v, mySeat) {
  const out = {};
  for (const [seat, e] of Object.entries(plays)) {
    const s = Number(seat);
    out[s] = s === mySeat ? e : { ...e, faceDown: true, name: "？", cardId: e.cardId };
  }
  return out;
}

