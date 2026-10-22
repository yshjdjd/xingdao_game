// 右侧事件记录：一整场流水账。
//
// R77 结构：
//   ① 拍卖（单独一节，逐场列出拍品 / 全场出价 / 成交结果）
//   ② 定期回复能量（补给，单独一节）
//   ③ 回合条目 —— 标题 → 天机 → 每人一行出牌（术 + 道）→ 血量 / 能量变化 → 其它事件
// 拍卖与补给原来混在回合条目的备注里，8 人局一多就淹掉了，所以提到最上面单独成节。
import { nameOf, eventLine } from "./render.mjs";

const PHASE_TEXT = {
  tianji: "天机窗口", choose: "出牌中", prompt: "追问", auction: "拍卖", auctionResult: "拍卖结果",
  tempDraw: "局初抽取", setDraft: "术系轮抽", setDraftEnd: "轮抽结果",
  reveal: "结算展示", roundEnd: "局末", matchOver: "终局", starting: "开局", lobby: "大厅",
};

// 拍卖相关的四种事件：拍品公示 / 成交 / 结果汇总 / 供给不足
const AUCTION_EVS = new Set(["auction", "auctionWin", "auctionResult", "auctionShort"]);
// 已经单独成节的事件，回合条目里不再重复一遍
const SPLIT_EVS = new Set([...AUCTION_EVS, "supply", "daoGain"]);

const sign = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "";
  return (v > 0 ? "+" : "") + v;
};
// 只留真正变了的人；服务端会把 hp=0 也一起带下来，这里要滤掉
const moved = (arr) => (arr || []).filter((c) => Number(c.d) !== 0);


// 日志按 (局, 回合) 分组。但 endRound() 里已经把 roundIndex +1 了，
// 于是「局末 / 终局」这一刻投影里是**新局 + 上一局的回合数**这种错位组合，
// 照它建记录就会凭空多出一条「第 N+1 局 · 回合 M」，而且里面装的是上一回合的数据。
// 所以局末/终局/局末轮抽这几个阶段一律挂到最新那条记录上。
//
// R77：原来只处理了 roundEnd / matchOver，setDraft 系列漏了 —— 于是每次局末轮抽都会
// 新建一条「第 N+1 局 · 回合 M」，等下一局真打到第 M 回合时，那条真记录反而被它顶掉，
// 事件记录里就凭空少一回合（看起来像"跳过了一回合"）。
const CARRY_PHASES = new Set(["roundEnd", "matchOver", "setDraft", "setDraftEnd"]);
export function recordKeyFor({ round, turn }, phase, newest) {
  if (CARRY_PHASES.has(phase) && newest) {
    return { round: newest.round, turn: newest.turn };
  }
  return { round, turn };
}

// 把当回合日志里的拍卖事件收敛成一条可渲染的条目。
// 拍卖在服务端是"先收价、后一次性发事件"，所以这里通常一次就拿到全套；
// 万一只到了半截，就先用 prev 兜着，等后面的补上。
function buildAuction(evs, prev) {
  const offer = evs.find((e) => e.t === "auction");
  const res = evs.find((e) => e.t === "auctionResult");
  const short = evs.find((e) => e.t === "auctionShort");
  const wins = evs.filter((e) => e.t === "auctionWin");
  return {
    cardId: offer?.cardId || prev?.cardId || null,
    name: offer?.name || prev?.name || "",
    category: offer?.category || prev?.category || "",
    bids: res?.bids
      ? res.bids.map((b) => ({ seat: b.seat, bid: Number(b.bid) || 0 }))
      : (prev?.bids || []),
    kind: res ? res.kind : (prev?.kind || "pending"),
    reason: res?.reason || prev?.reason || "",
    winners: res ? wins.map((w) => ({ seat: w.seat, bid: w.bid })) : (prev?.winners || []),
    short: short?.copies || prev?.short || 0,
  };
}

// 一场拍卖：第几局第几回合 · 拍品 → 结果 + 全场出价
function auctionHtml(r, nm) {
  const a = r.auction;
  const winNames = a.winners.map((w) => nm(w.seat)).join("、");
  const res = (() => {
    if (a.kind === "pending") return `<span class="pl-out-res wait">出价中…</span>`;
    if (a.kind === "sold") {
      const price = a.winners.length ? `${a.winners[0].bid} 点` : "";
      const each = a.winners.length > 1 ? "各以" : "以";
      return `<span class="pl-out-res sold">${winNames} ${each} ${price} 拍得</span>`;
    }
    const why = a.reason === "tie2" ? "两人同价" : "无人出价";
    return `<span class="pl-out-res unsold">流拍 · ${why}（全场不扣能量）</span>`;
  })();
  const short = a.short ? `<span class="pl-out-note">同类仅剩 ${a.short} 张，先到先得</span>` : "";
  const bids = a.bids.length
    ? `<div class="pl-out-bids">${a.bids
        .slice().sort((x, y) => x.seat - y.seat)
        .map((b) => `<span class="pl-bid${a.winners.some((w) => w.seat === b.seat) ? " win" : ""}">
          <i>${nm(b.seat)}</i><b>${b.bid}</b></span>`)
        .join("")}</div>`
    : "";
  return `<div class="pl-out">
    <div class="pl-out-hd">
      <span class="pl-out-turn">第 ${r.round} 局 · 回合 ${r.turn}</span>
      <b class="pl-out-name">${a.name || "拍品"}</b>
      ${a.category ? `<span class="pl-out-cat">${a.category}</span>` : ""}
    </div>
    <div class="pl-out-bd">${res}${short}${bids}</div>
  </div>`;
}

// 补给：第 10/15/20… 回合全场回能
function supplyHtml(r) {
  const amt = r.supply.amount ?? 1;
  return `<div class="pl-out pl-out-sup">
    <span class="pl-out-turn">第 ${r.round} 局 · 回合 ${r.turn}</span>
    <span class="pl-out-res gain">全场存活者各 +${amt} 能量</span>
  </div>`;
}

export class EventLog {
  constructor(root) {
    this.root = root;
    this.records = [];
    this.names = [];
    this.collapsed = new Set();
    this.open = window.innerWidth >= 1080;   // 窄屏默认收起，别一上来就挤扁牌桌
    this.userSet = false;
    this.applyOpen();
    // 宽屏用面板里的"收起"，窄屏（抽屉）还要靠顶栏那个"事件"按钮重新打开
    for (const id of ["panel-toggle", "btn-panel"]) {
      const b = document.getElementById(id);
      if (b) b.onclick = () => { this.open = !this.open; this.userSet = true; this.applyOpen(); };
    }
    window.addEventListener("resize", () => {
      if (this.userSet) return;
      const want = window.innerWidth >= 1080;
      if (want !== this.open) { this.open = want; this.applyOpen(); }
    });
  }

  applyOpen() {
    this.root.classList.toggle("collapsed", !this.open);
    const btn = document.getElementById("panel-toggle");
    if (btn) btn.textContent = this.open ? "收起" : "事件";
  }

  reset() { this.records = []; this.collapsed = new Set(); }

  ensure(round, turn) {
    const key = `${round}-${turn}`;
    let rec = this.records.find((r) => r.key === key);
    if (!rec) {
      rec = {
        key, round, turn, tianji: null, auction: null, supply: null,
        gains: [], plays: [], hp: [], energy: [], notes: [], phase: "",
      };
      this.records.unshift(rec);                       // 最新的在最上面
      if (this.records.length > 80) this.records.pop();
    }
    return rec;
  }

  update(v, msg) {
    const round = (v.round ?? 0) + 1;
    const turn = v.turn ?? 0;
    if (!turn) return this.render();
    const key = recordKeyFor({ round, turn }, msg.phase, this.records[0]);
    const rec = this.ensure(key.round, key.turn);
    this.names = v.players.map((p) => p.name);
    rec.phase = msg.phase || rec.phase;

    const evs = v.log || [];

    // 天机：优先用服务端流水（跨局也不会丢），其次用当回合投影，最后用当回合事件兜底
    const fromLog = (msg.tianjiLog || []).find((x) => x.round === round && x.turn === turn);
    if (fromLog) rec.tianji = fromLog;
    else if (v.tianji?.now) rec.tianji = { id: v.tianji.now, name: nameOf(v.tianji.now) };
    else {
      const tjEv = evs.find((e) => e.t === "tianji" && e.name);
      if (tjEv) rec.tianji = { id: tjEv.id, name: tjEv.name };
    }

    // 拍卖 / 补给：单独成节，不进回合条目
    const aucEvs = evs.filter((e) => AUCTION_EVS.has(e.t));
    if (aucEvs.length) rec.auction = buildAuction(aucEvs, rec.auction);
    const sup = evs.find((e) => e.t === "supply");
    if (sup) rec.supply = { amount: sup.amount ?? 1 };

    // R78：天机发的道牌（天官赐福等）—— 自己看牌名，别人只知道"抽了 1 张"
    const gains = evs.filter((e) => e.t === "daoGain");
    if (gains.length) {
      rec.gains = gains.map((e) => ({
        seat: e.seat, name: e.hidden ? null : e.name,
        empty: !!e.empty, seized: !!e.seized,
      }));
    }

    // 出牌（术牌 + 道牌）
    const plays = evs.filter((e) => e.t === "play");
    if (plays.length) {
      rec.plays = plays.map((e) => ({
        seat: e.seat, name: e.name, value: e.value, cardId: e.cardId,
        daoId: e.daoId || null, daoName: e.daoName || (e.daoId ? nameOf(e.daoId) : null),
        daoVoid: !!e.daoVoid, timedOut: !!e.timedOut,
      }));
    }

    // 血量 / 能量净变化
    if (msg.changes?.length) {
      rec.hp = msg.changes.filter((c) => c.hp).map((c) => ({ seat: c.seat, d: c.hp }));
      rec.energy = msg.changes.filter((c) => c.energy).map((c) => ({ seat: c.seat, d: c.energy }));
    }

    // 其它事件（命中 / 出局 / 博弈 / 轮抽 …）—— 保留事件类型，渲染时按类型着色
    const notes = evs
      .filter((e) => e.t !== "tianji" && !SPLIT_EVS.has(e.t))   // 天机/拍卖/补给已经单独展示
      .map((e) => ({ t: e.t, html: eventLine(e, this.names) }))
      .filter((x) => x.html);
    if (notes.length) {
      const seen = new Set();
      rec.notes = notes.filter((x) => (seen.has(x.html) ? false : (seen.add(x.html), true)));
    }

    this.render();
  }

  render() {
    if (!this.root) return;
    const nm = (s) => this.names[s] || `座位${s + 1}`;
    const body = this.root.querySelector(".panel-body");
    if (!body) return;

    // ① 拍卖 ② 定期回复能量：从回合记录里抽出来，按时间倒序单独成节
    const aucs = this.records.filter((r) => r.auction);
    const sups = this.records.filter((r) => r.supply);
    const aucBlock = aucs.length
      ? `<div class="pl-group">
          <div class="pl-group-hd"><span>拍卖</span><em>${aucs.length}</em></div>
          ${aucs.map((r) => auctionHtml(r, nm)).join("")}
        </div>` : "";
    const supBlock = sups.length
      ? `<div class="pl-group">
          <div class="pl-group-hd"><span>定期回复能量</span><em>${sups.length}</em></div>
          ${sups.map((r) => supplyHtml(r)).join("")}
        </div>` : "";

    // ③ 回合条目
    const turns = this.records.map((r) => {
      const closed = this.collapsed.has(r.key);
      const tj = r.tianji
        ? `<span class="pl-tj on" data-modal="${r.tianji.id}">${r.tianji.name} ›</span>`
        : `<span class="pl-tj">无</span>`;

      // 出牌：一人一行，"术名 数值" + "道 · 道牌名"
      const playing = ["choose", "prompt", "discard"].includes(r.phase);
      const plays = r.plays.length
        ? r.plays.slice().sort((a, b) => a.seat - b.seat).map((p) => {
            const val = p.value ? `<b>${p.value}</b>` : "";
            const dao = p.daoName
              ? `<span class="pl-dao${p.daoVoid ? " off" : ""}">道 · ${p.daoName}${p.daoVoid ? "（被封）" : ""}</span>`
              : "";
            const to = p.timedOut ? `<u>超时</u>` : "";
            return `<div class="pl-play" data-tip="${p.cardId || ""}">
              <i>${nm(p.seat)}</i><span class="pl-shu">${p.name}${val}</span>${dao}${to}
            </div>`;
          }).join("")
        : `<span class="pl-none">${playing ? "出牌中…" : "—"}</span>`;

      // 血量 / 能量：只列**真的有变化**的人
      const series = (arr) => moved(arr).map((c) => {
        const d = Number(c.d);
        const tone = d < 0 ? "down" : d > 0 ? "up" : "";
        return `<span class="pl-chip ${tone}"><i>${nm(c.seat)}</i>${sign(d)}</span>`;
      }).join("");
      const hpList = moved(r.hp);
      const enList = moved(r.energy);

      // 标题右侧的关键结果：一行扫过去就知道这一回合发生了什么
      const badges = [];
      if (hpList.length) {
        const down = hpList.filter((c) => Number(c.d) < 0);
        if (down.length) badges.push(`<span class="pl-b b-hurt">${down.length} 人掉血</span>`);
      }
      const killed = r.notes.filter((n) => n.t === "eliminate").length;
      if (killed) badges.push(`<span class="pl-b b-kill">${killed} 人出局</span>`);
      if (r.auction) badges.push(`<span class="pl-b b-gold">拍卖</span>`);
      if (r.supply) badges.push(`<span class="pl-b b-gold">补给</span>`);
      if (r.notes.some((n) => n.t === "setDraft")) badges.push(`<span class="pl-b b-gold">术系轮抽</span>`);
      if (r.notes.some((n) => n.t === "debt" || n.t === "debtSeize")) badges.push(`<span class="pl-b b-bad">赊天清算</span>`);
      // 什么都不发生时给一个"无动作"，避免标题行空着（回合还没结算完就别急着下结论）
      const settled = ["reveal", "roundEnd", "matchOver", "auctionResult"].includes(r.phase);
      if (!badges.length && settled && !r.plays.length && !r.notes.length && !r.tianji
        && !hpList.length && !enList.length && !(r.gains || []).length) badges.push(`<span class="pl-b">无动作</span>`);

      const notes = r.notes.length
        ? `<div class="pl-notes">${r.notes.map((n) => `<div class="pl-note t-${n.t}">${n.html}</div>`).join("")}</div>`
        : "";

      // 顺序固定：天机 → 抽牌 → 出牌 → 血量/能量 → 其它事件。空的整行不画
      const tjLine = r.tianji ? `<div class="pl-line"><label>天机</label><div>${tj}</div></div>` : "";
      const gainLine = (r.gains || []).length
        ? `<div class="pl-line"><label>抽牌</label><div class="pl-wrap">${r.gains.map((g) => {
            if (g.empty) return `<span class="pl-chip"><i>${nm(g.seat)}</i><u>牌库已空</u></span>`;
            const d = g.name
              ? `${g.name}${g.seized ? "<u>没收</u>" : ""}`
              : `<span class="pl-none">1 张</span>`;
            return `<span class="pl-chip dao"><i>${nm(g.seat)}</i>${d}</span>`;
          }).join("")}</div></div>` : "";
      const hpLine = hpList.length
        ? `<div class="pl-line"><label>血量</label><div class="pl-wrap">${series(r.hp)}</div></div>` : "";
      const enLine = enList.length
        ? `<div class="pl-line"><label>能量</label><div class="pl-wrap">${series(r.energy)}</div></div>` : "";
      return `
        <div class="pl-item ${closed ? "closed" : ""}">
          <div class="pl-hd" data-key="${r.key}">
            <span class="pl-r">第 ${r.round} 局 · 回合 ${r.turn}</span>
            <span class="pl-phase">${PHASE_TEXT[r.phase] || ""}</span>
            <span class="pl-badges">${closed ? "" : badges.join("")}</span>
            <span class="pl-fold">${closed ? "展开" : "收起"}</span>
          </div>
          ${closed ? "" : tjLine + gainLine}
          <div class="pl-line"><label>出牌</label><div class="pl-playlist">${plays}</div></div>
          ${closed ? "" : hpLine + enLine}
          ${closed ? "" : notes}
        </div>`;
    }).join("");

    body.innerHTML = (aucBlock + supBlock + turns)
      || `<div class="pl-empty">对局开始后，这里会实时记录每一回合。</div>`;

    body.querySelectorAll("[data-key]").forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.key;
        this.collapsed.has(k) ? this.collapsed.delete(k) : this.collapsed.add(k);
        this.render();
      };
    });
  }
}
