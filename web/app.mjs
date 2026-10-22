// 行道 · 单机人机对战前端。
// 直接用浏览器原生 ESM 调引擎（web/src 是引擎源码副本），没有构建步骤、没有框架。
import { createMatch, startRound, beginTurn, resolveTurn, endRound,
  nextDraftFaction, applySetPick, applyFreeOp,
  peekAuction, auctionIfDue, playableCards, costFor, collectPrompts,
  discardOver, discardCards, autoDiscard, normalizeBid, bidCap,
  setEquipState } from "./src/engine.mjs";
import { chooseAction, bidFor } from "./src/ai.mjs";
import { viewFor, auditView } from "./src/view.mjs";
import * as D from "./src/data.mjs";
import { fmt, toU } from "./src/units.mjs";
import { shuHtml, daoHtml, equipRowHtml, shuGroups, nameOf } from "./render.mjs";
import { renderBoard, playsOf } from "./board.mjs";
import { EventLog } from "./panel.mjs";
import { initTips } from "./tips.mjs";

const SEATS = ["我", "玄冥", "白露", "赤霄"];
const MY = 0;
const REVEAL_MS = 4200;

let m = null;
let picked = { shu: null, dao: null, ops: [] };
let phase = "idle";           // idle | choose | reveal | auction | discard | roundEnd | draft | matchEnd
let pendingOffer = null;
let turnAdvanced = false;     // 拍卖已经把回合计数推过了，beginTurn 不要重复推
let daoQuotaUsed = false;     // R55：本回合的道牌名额已用（装载神装也算）
let lastEvents = [];
let convCount = 0;      // R74：本回合身世操作次数
let drawSeq = 0;        // R72：局初抽取公示的计时器令牌（防止和局末轮抽撞车）
const expanded = new Set();
const seenGroups = new Set();
const tianjiLog = [];         // 单机也按"服务端口径"攒一份流水，事件表直接复用
let shownPlays = {};
let clearTimer = null;

const $ = (id) => document.getElementById(id);
const panel = new EventLog($("panel"));

// ---------- 渲染 ----------

function render() {
  if (!m) return;
  const v = viewFor(m, MY, { events: lastEvents });
  document.body.classList.add("in-game");
  const problems = auditView(v, m, MY);
  if (problems.length) console.error("投影泄漏", problems);

  $("m-round").textContent = v.round + 1;
  $("m-turn").textContent = v.turn;
  $("m-tianji").textContent = v.tianji?.now ? nameOf(v.tianji.now) : (v.lastTianji ? nameOf(v.lastTianji) : "—");

  const fromLog = playsOf(lastEvents);
  if (Object.keys(fromLog).length) {
    shownPlays = fromLog;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { shownPlays = {}; render(); }, REVEAL_MS);
  }

  renderBoard($("board"), v, {
    mySeat: MY,
    phase,
    waiting: phase === "choose" || phase === "discard" ? [MY] : [],
    submitted: [],
    playOf: shownPlays,
    events: lastEvents,
    names: SEATS,
  });

  panel.update(v, { phase, tianjiLog, changes: changesForView() });
  renderHand(v);

  const btn = $("btn-next");
  btn.disabled = phase === "choose" || phase === "auction" || phase === "discard" || phase === "draft";
  btn.textContent = phase === "reveal" ? "下一回合" : phase === "roundEnd" ? "下一局"
    : phase === "matchEnd" ? "再来一场" : "开始";

  const acts = $("tray-actions");
  if (phase === "choose") {
    const cost = picked.shu ? fmt(costFor(m, m.players[MY], picked.shu)) : 0;
    acts.innerHTML = `<span class="cost">消耗 <b>${cost}</b>　能量 ${fmt(m.players[MY].energy)}</span>
      <button class="btn primary" id="btn-play">${picked.shu ? "确认打出 · " + nameOf(picked.shu) : "请选一张术"}</button>`;
    const b = $("btn-play");
    b.disabled = !picked.shu;
    b.onclick = () => confirmPlay();
  } else {
    acts.innerHTML = '<span class="hintline">' +
      (phase === "reveal" ? "点「下一回合」继续" : "（等待）") + "</span>";
  }
}

function renderHand(v) {
  const shu = $("hand-shu");
  const dao = $("hand-dao");
  const locked = phase !== "choose";
  // R49：默认只展开「术系」。攻击 / 防御折叠着，四个分组标题并排一行就能全看见；
    // 展开某一组会把它撑宽，其余组被推到右边（横向可滚），这是用户主动选的。
  for (const g of shuGroups(v)) {
    if (!g.collapsible || seenGroups.has(g.key)) continue;
    if (!g.key.startsWith("set:")) continue;
    seenGroups.add(g.key);
    expanded.add(g.key);
  }
  shu.innerHTML = shuHtml(v, picked.shu, expanded);
  // R55：神装的装载 / 卸下直接在手牌区做（装载占本回合道牌名额，卸下不占）
  const talentOps = (!locked && v.me) ? (v.me.freeOps || []) : [];
  dao.innerHTML = daoHtml(v, picked.dao, { equipUI: !locked }) + equipRowHtml(v, { equipUI: !locked })
    + (talentOps.length ? talentInlineHtml(v) : "");     // R76：天赋与道牌同一行
  const daoRow = $("row-dao");
  if (daoRow) {
    daoRow.style.display = ((v.me?.hand || []).length || (v.me?.equip || []).length || talentOps.length)
      ? "flex" : "none";
  }
  bindTalentInline();

  // R49/R76：天赋区不再是独立一行 —— 内容在道牌行里（talentInlineHtml）
  const talentRow = $("row-talent");
  if (talentRow) talentRow.style.display = "none";
  shu.classList.toggle("locked", locked);
  dao.classList.toggle("locked", locked);
  if (locked) return;

  shu.querySelectorAll("[data-grp]").forEach((b) => b.onclick = () => {
    const k = b.dataset.grp;
    expanded.has(k) ? expanded.delete(k) : expanded.add(k);
    renderHand(v);
  });
  shu.querySelectorAll("[data-shu]").forEach((b) => b.onclick = () => {
    picked.shu = b.dataset.shu; render();
  });
  dao.querySelectorAll("[data-dao]").forEach((b) => b.onclick = () => {
    picked.dao = picked.dao === b.dataset.dao ? null : b.dataset.dao; render();
  });
  dao.querySelectorAll("[data-eq-on]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const err = setEquipState(m, MY, b.dataset.eqOn, true);
    if (err) return banner(err);
    // 装载 = 用掉本回合的道牌名额，不能再带一张道牌
    if (picked.dao) picked.dao = null;
    daoQuotaUsed = true;
    banner(`装载 ${nameOf(b.dataset.eqOn)}`);
    render();
  });
  dao.querySelectorAll("[data-eq-off]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const err = setEquipState(m, MY, b.dataset.eqOff, false);
    if (err) return banner(err);
    banner(`卸下 ${nameOf(b.dataset.eqOff)}`);
    render();
  });
}

function banner(text) {
  const el = $("banner");
  el.textContent = text;
  el.classList.add("on");
  setTimeout(() => el.classList.remove("on"), 1400);
}

// ---------- 资源变化（单机版自己算，口径与联机 room.mjs 一致） ----------

let lastChanges = [];
const snapStats = () => m.players.map((p) => ({ hp: p.hp, energy: p.energy }));
function addChanges(pre) {
  // R77：累加用定点数，格式化留到展示时做（字符串累加会把 "0" + "-1.5" 拼成 "0-1.5"）
  const acc = new Map(lastChanges.map((c) => [c.seat, c]));
  m.players.forEach((p, i) => {
    const b = pre[i] || { hp: p.hp, energy: p.energy };
    const cur = acc.get(p.seat) || { seat: p.seat, hp: 0, energy: 0 };
    cur.hp += p.hp - b.hp;
    cur.energy += p.energy - b.energy;
    acc.set(p.seat, cur);
  });
  lastChanges = [...acc.values()].filter((c) => c.hp || c.energy);
}

// 展示用：定点差 → 点数，没有变化的一侧留空
function changesForView() {
  return lastChanges
    .map((c) => {
      const hp = fmt(c.hp), energy = fmt(c.energy);
      return { seat: c.seat, hp: hp === "0" ? "" : hp, energy: energy === "0" ? "" : energy };
    })
    .filter((c) => c.hp || c.energy);
}

// R76：天赋内联块（与道牌同一行）—— 只放按钮 + 血/能读数，说明折叠到「?」
function talentInlineHtml(v) {
  const me = v.me;
  const ops = (me?.freeOps || []);
  if (!me || !ops.length) return "";
  const btns = ops.map((op) =>
    `<button class="btn tbtn" data-op="${op.op}" ${op.enabled ? "" : "disabled"}
      title="${op.enabled ? "点一次生效一次，可反复" : op.why || "条件不满足"}">${op.label}</button>`).join("");
  return `<span class="talent-inline">
    <b>天赋</b><span class="tname">${me.birthName || "身世"}</span>
    <button class="tq" data-birth="1" title="查看天赋说明">?</button>
    <span class="tops">${btns}</span>
    <span class="tstat">血 <b>${me.hp}</b>/${me.maxHp} · 能 <b>${me.energy}</b>${
      convCount ? `<em> · 已换 ${convCount}</em>` : ""}</span>
  </span>`;
}

function bindTalentInline() {
  document.querySelectorAll("[data-op]").forEach((b) => {
    b.onclick = () => {
      const r = applyFreeOp(m, MY, b.dataset.op);
      if (!r.ok) return;
      convCount += 1;
      picked = { shu: null, dao: null, ops: [] };   // 血/能变了，预选必须作废
      render();
    };
  });
  document.querySelectorAll("[data-birth]").forEach((b) => {
    b.onclick = () => {
      const me = viewFor(m, MY).me;
      openModal(`
        <h3>身世 · ${me.birthName || ""}</h3>
        <p style="font-size:12.5px;line-height:1.7">${me.birthText || "（这个身世没有主动操作）"}</p>
        <div class="acts"><button class="btn" id="birth-close">知道了</button></div>`);
      const c = $("birth-close");
      if (c) c.onclick = () => closeModal();
    };
  });
}

// ---------- 流程 ----------

function newMatch() {
  m = createMatch({ seats: SEATS.map((n, i) => ({ name: n, isAI: i !== MY })), seed: Date.now() % 100000 });
  tianjiLog.length = 0;
  lastChanges = [];
  shownPlays = {};
  panel.reset();
  phase = "reveal";
  $("btn-next").disabled = true;
  // R72：局初官宦子弟是「同时随机抽取」，抽完公示一下再开打
  if (startRoundWithDraw()) return;
  nextTurn();
}

function nextTurn() {
  if (m.matchOver) return showMatchEnd();
  if (m.roundOver) return finishRound();

  // 拍卖是第 5/10/15… 回合开始的第一个环节，排在天机判断之前：
  // 先拍完再定天机，出价时手上的能量还没被本回合消耗掉。
  // 先把回合计数推到这个新回合（牌桌要显示「第 5 回合 · 拍卖」），拍完就不再推进第二次。
  const offer = peekAuction(m);
  if (offer) {
    m.turn += 1;
    turnAdvanced = true;
    return askAuction(offer, () => nextTurn());
  }

  lastChanges = [];                  // 新回合：只统计本回合的净变化
  const pre = snapStats();
  const ev = beginTurn(m, { advance: !turnAdvanced });
  turnAdvanced = false;
  addChanges(pre);
  const tj = ev.find((e) => e.t === "tianji");
  if (tj) {
    banner(`天机 · ${nameOf(tj.id)}`);
    tianjiLog.push({
      round: m.roundIndex + 1, turn: m.turn, id: tj.id, name: tj.name,
      effect: D.cardById(tj.id)?.effect || "",
    });
  }

  picked = { shu: null, dao: null, ops: [] };
  convCount = 0;
  daoQuotaUsed = false;
  phase = "choose";
  // R77：补给（定期回复能量）要单独进事件记录，不能跟着天机一起被丢掉；
  // 拍卖事件是本回合拍卖环节留下的，也要一起带过来（否则一进回合就被这次覆盖冲掉）
  const aucEvs = lastEvents.filter((e) => e.t.startsWith("auction"));
  lastEvents = [...aucEvs, ...ev.filter((e) => ["tianji", "supply", "daoGain"].includes(e.t))];
  render();
}

function confirmPlay() {
  if (!picked.shu) return;
  // R55：装载神装已经用掉本回合的道牌名额，不能再带一张道牌
  const daoId = daoQuotaUsed ? null : (picked.dao || null);
  const acts = {};
  acts[MY] = { cardId: picked.shu, daoId };
  for (const p of m.players) {
    if (p.seat === MY || !p.alive) continue;
    const c = chooseAction(m, p);
    acts[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
  }
  // 结算前先看有没有要当场表态的（天之赌场押注 / 赊天借贷），有就先问本人
  const mine = collectPrompts(m, acts).filter((x) => x.seat === MY);
  if (mine.length) return askPrompts(mine, [], (ans) => doResolve(acts, ans));
  doResolve(acts, []);
}

// 一次问一个，答完接着问下一个；AI 座位用引擎兜底
function askPrompts(queue, answers, done) {
  if (!queue.length) return done(answers);
  const spec = queue[0];
  const opts = (spec.options || []).map(
    (o) => `<button class="btn" data-pick="${o}">${o}</button>`
  ).join("");
  openModal(`
    <h3>${spec.label || "请选择"}</h3>
    <div class="row" id="prompt-opts">${opts}</div>
  `);
  $("modal").querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = () => {
      closeModal();
      answers.push({ id: spec.id, value: Number(b.dataset.pick) });
      askPrompts(queue.slice(1), answers, done);
    };
  });
}

function doResolve(acts, ansList = []) {
  const bag = {};
  for (const a of ansList) bag[a.id] = a.value;
  const pre = snapStats();
  // R77：引擎在返璞归真下会把 daoId 置空，先抄一份（与服务端同口径）
  const daoSnap = {};
  for (const [seat, a] of Object.entries(acts)) daoSnap[seat] = a?.daoId || null;
  lastEvents = resolveTurn(m, acts, {
    answers: { [MY]: bag },
    freeOps: picked.ops.length ? { [MY]: picked.ops.map((op) => ({ op })) } : undefined,
  });
  addChanges(pre);
  phase = "reveal";

  // 把"谁打了什么"折叠成事件给展示区（与服务端同一口径）
  for (const [seat, a] of Object.entries(acts)) {
    const c = D.cardById(a.cardId);
    const val = c.type === "攻术" ? c.atk : c.type === "御术" ? (c.def ?? "∞") : "";
    const daoId = daoSnap[seat] || null;
    lastEvents.push({
      t: "play", seat: Number(seat), cardId: a.cardId, name: c.name, value: val,
      daoId, daoName: daoId ? (D.cardById(daoId)?.name || daoId) : null,
      daoVoid: !!daoId && lastEvents.some((e) => e.t === "daoVoid" && e.seat === Number(seat)),
    });
  }

  // 人机超了道牌上限：它自己挑不了，引擎兜底随机弃到刚好不超
  for (const o of discardOver(m)) {
    if (o.seat === MY) continue;
    const lost = autoDiscard(m, o.seat);
    if (lost.length) {
      lastEvents.push({ t: "discard", seat: o.seat, names: lost.map((id) => D.cardById(id)?.name || id) });
    }
  }
  finishTurn();
}

function finishTurn() {
  // 回合末弃牌判断：道牌上限 = 血量上限，超了要自己挑
  const need = discardOver(m).find((o) => o.seat === MY);
  if (need && m.players[MY].alive && !m.roundOver) return askDiscard(need);
  phase = "reveal";
  render();
  if (m.roundOver) $("btn-next").textContent = "结算本局";
}

function askDiscard(need) {
  phase = "discard";
  const p = m.players[MY];
  const pickedIds = new Set();
  openModal(`
    <h3>弃牌</h3>
    <p>道牌上限 <b>${need.cap}</b> 张（= 血量上限），你现有 ${need.handCount} 张，需弃 <b>${need.over}</b> 张。</p>
    <div id="d-list" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${p.hand.map((id) => `<button class="pick" data-did="${id}">${nameOf(id)}</button>`).join("")}
    </div>
    <div class="acts">
      <span class="hintline" id="d-tip">已选 0/${need.over}</span>
      <button class="btn" id="d-ok" disabled>确认弃牌</button>
    </div>`);
  const ok = $("d-ok");
  const tip = $("d-tip");
  document.querySelectorAll("[data-did]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.did;
      if (pickedIds.has(id)) { pickedIds.delete(id); b.classList.remove("on"); }
      else if (pickedIds.size < need.over) { pickedIds.add(id); b.classList.add("on"); }
      tip.textContent = `已选 ${pickedIds.size}/${need.over}`;
      ok.disabled = pickedIds.size !== need.over;
    };
  });
  ok.onclick = () => {
    if (pickedIds.size !== need.over) return;
    discardCards(m, MY, [...pickedIds]);
    closeModal();
    finishTurn();
  };
}

function askAuction(offer = pendingOffer, after = null) {
  phase = "auction";
  pendingOffer = offer;
  const c = D.cardById(offer);
  const max = bidCap(m.players[MY].energy);
  const odd = fmt(m.players[MY].energy - toU(max));   // 不足 1 点的零头，出不了价
  openModal(`
    <h3>道牌拍卖 · 第 ${m.turn} 回合</h3>
    <p><b>${c.name}</b>（${c.category}）</p>
    <p style="font-size:12px">${c.text}</p>
    <p>你的能量：<b>${fmt(m.players[MY].energy)}</b>　最高可出：<b>${max}</b> 点${odd !== "0" ? `（余 ${odd} 点出不了价，留在手里）` : ""}</p>
    <p style="font-size:12px;opacity:.75">只能按整点出价；没拍到的人不扣能量。</p>
    <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
      ${Array.from({ length: max + 1 }, (_, i) => `<button class="pick" data-bid="${i}">${i}</button>`).join("")}
    </div>
    <div class="acts"><button class="btn" data-bid="-1">弃权</button></div>`);
  document.querySelectorAll("[data-bid]").forEach((b) => {
    b.onclick = () => settleAuction(Number(b.dataset.bid), after);
  });
}

function settleAuction(bid, after = null) {
  const bids = {};
  for (const p of m.players) {
    if (!p.alive) continue;
    bids[p.seat] = p.seat === MY ? normalizeBid(m.players[MY].energy, bid) : bidFor(m, p, pendingOffer);
  }
  const pre = snapStats();
  const ev = auctionIfDue(m, { offerId: pendingOffer, bids });
  addChanges(pre);
  lastEvents = [...lastEvents, ...ev];
  closeModal();
  pendingOffer = null;
  (after || finishTurn)();
}

function finishRound() {
  drawSeq += 1;                      // 作废可能还挂着的"局初公示 -> 进回合"计时器
  // R72：autoDraft=false —— 术系改成玩家自己按顺位挑
  const ranked = endRound(m, { autoDraft: false });
  phase = m.matchOver ? "matchEnd" : "roundEnd";
  const win = ranked[0];
  const rows = ranked.map((r, i) => {
    const names = r.f.members.map((s) => s === MY ? "我" : SEATS[s]).join(" / ");
    return `<tr><td>${i + 1}</td><td>${names}</td><td>${r.survived} 回合</td><td>${r.f.lastRoundScore ?? 0}</td></tr>`;
  }).join("");
  openModal(`
    <h3>第 ${m.roundIndex} 局结束</h3>
    <p>胜者：<b>${win.f.members.map((s) => s === MY ? "我" : SEATS[s]).join(" / ")}</b></p>
    <table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px">
      <tr style="color:var(--ink3)"><td>名次</td><td>势力</td><td>存活</td><td>本局得分</td></tr>${rows}
    </table>
    <div class="acts"><button class="btn primary" id="go">${
      m.matchOver ? "查看总成绩" : "抽术系 · 进入第 " + Math.min(4, m.roundIndex + 1) + " 局"}</button></div>`);
  $("go").onclick = () => { if (m.matchOver) return showMatchEnd(); startDraft(); };
}

// ---------- R72：局末术系轮抽（单机）----------
//
// 顺序由引擎算好（淘汰越早越先挑）。轮到自己势力 -> 弹选择；人机 -> 停 0.9 秒自动挑，
// 让人看得见"正在一家一家挑"这个过程，而不是啪一下结束。

function namesOf(f) {
  return f.members.map((x) => (x === MY ? "我" : SEATS[x])).join(" / ");
}

function startDraft() {
  phase = "draft";
  draftStep();
}

function draftStep() {
  const fid = nextDraftFaction(m);
  if (fid === null) return endDraft();
  const d = m.setDraft;
  const f = m.factions.find((x) => x.id === fid);
  // R73：代表制 —— 只有"最后被淘汰的那位"能决定；我是队友时只能看
  const rep = d.info?.[fid]?.rep ?? f.members[0];
  const mine = rep === MY;
  const repName = rep === MY ? "我" : SEATS[rep];
  const done = d.picks.map((pk) => {
    const nf = m.factions.find((x) => x.id === pk.factionId);
    const nm = pk.setId ? D.setById(pk.setId)?.name : "（无）";
    return `<div class="dr-done"><i>${namesOf(nf)}</i><b>${nm}</b></div>`;
  }).join("");
  const pool = d.pool.map((id) => `<button class="pick" data-dset="${id}">${D.setById(id)?.name || id}</button>`).join("");
  openModal(`
    <h3>术系轮抽 · 第 ${d.idx + 1} / ${d.order.length} 家</h3>
    <p style="font-size:12px">按<b>存活长短</b>轮流挑（活得越久越先挑）。现在轮到
      <b>${namesOf(f)}</b>${mine ? "（由你决定）" : `（由 ${repName} 决定…）`}</p>
    ${done ? `<div class="dr-list">${done}</div>` : ""}
    ${mine
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${pool}</div>
       <p style="font-size:12px;opacity:.75;margin-top:8px">剩余 ${d.pool.length} 套，挑走的一套队内共享。</p>`
    : `<p style="font-size:12px;opacity:.6;margin-top:10px">${
      f.members.includes(MY) ? "本局由队里最后被淘汰的成员决定，等待中…" : "对方正在挑…"}</p>`}`);
  if (mine) {
    document.querySelectorAll("[data-dset]").forEach((b) => {
      b.onclick = () => {
        const pk = applySetPick(m, fid, b.dataset.dset);
        if (pk) lastEvents = [...lastEvents, draftEv(pk)];
        draftStep();
      };
    });
    return;
  }
  setTimeout(() => {
    if (phase !== "draft") return;
    const pk = applySetPick(m, fid, null);
    if (pk) lastEvents = [...lastEvents, draftEv(pk)];
    draftStep();
  }, 900);
}

function draftEv(pick) {
  const f = m.factions.find((x) => x.id === pick.factionId);
  return {
    t: "setDraft", factionId: pick.factionId, seat: pick.seat,
    members: f.members, setId: pick.setId,
    name: pick.setId ? D.setById(pick.setId)?.name : "",
    note: pick.note, left: (m.setDraft?.pool || []).length,
    names: f.members.map((x) => (x === MY ? "我" : SEATS[x])),
  };
}

function endDraft() {
  lastEvents = [...lastEvents, { t: "setDraftEnd", total: m.setDraft?.picks?.length || 0 }];
  closeModal();
  continueAfterRound();
}

// R72：局初抽取公示（官宦子弟同时随机拿一套）。有抽取就显示 2.4 秒再进回合。
function startRoundWithDraw() {
  startRound(m);
  const draws = m.players.filter((p) => (p.tempSets || []).length).map((p) => {
    const sid = p.tempSets[p.tempSets.length - 1];
    const set = D.setById(sid);
    return { t: "tempDraw", seat: p.seat, setId: sid, name: set?.name || sid, cards: (set?.cards || []).length };
  });
  if (!draws.length) return false;
  phase = "reveal";                  // 公示期：一个中性的"看牌"状态，避免还挂着 draft/roundEnd
  lastEvents = [...lastEvents, ...draws];
  openModal(`
    <h3>局初 · 官宦子弟特权</h3>
    <p style="font-size:12px">同时随机抽取本局争夺中的术系（各自独立，可能撞同一套）。</p>
    <div class="dr-list" style="margin-top:8px">${draws.map((d) =>
      `<div class="dr-done"><i>${d.seat === MY ? "我" : SEATS[d.seat]}</i><b>${d.name}</b></div>`).join("")}</div>
    <p style="font-size:12px;opacity:.6;margin-top:8px">即将开始…</p>`);
  // 令牌守卫：若这段时间里已经进了局末 / 轮抽 / 终局，就作废这次"进入回合"
  const my = drawSeq;
  setTimeout(() => {
    if (my !== drawSeq) return;
    if (phase === "draft" || phase === "roundEnd" || phase === "matchEnd") return;
    closeModal();
    nextTurn();
  }, 2400);
  return true;
}

function continueAfterRound() {
  closeModal();
  if (m.matchOver) return showMatchEnd();
  lastChanges = [];
  if (startRoundWithDraw()) return;
  nextTurn();
}

function showMatchEnd() {
  phase = "matchEnd";
  const ranked = [...m.factions].sort((a, b) => b.score - a.score);
  const rows = ranked.map((f, i) => `<tr><td>${i + 1}</td><td>${f.members.map((s) => (s === MY ? "我" : SEATS[s])).join(" / ")}</td><td>${f.score}</td></tr>`).join("");
  openModal(`
    <h3>全场结束</h3>
    <table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px">
      <tr style="color:var(--ink3)"><td>名次</td><td>势力</td><td>总积分</td></tr>${rows}
    </table>
    <div class="acts"><button class="btn primary" id="again">再来一场</button></div>`);
  $("again").onclick = () => { closeModal(); newMatch(); };
}

function openModal(html) { $("modal").innerHTML = html; $("overlay").classList.add("on"); delete $("overlay").dataset.closable; }
function closeModal() { $("overlay").classList.remove("on"); }

// ---------- 事件绑定 ----------

$("btn-next").onclick = () => {
  if (phase === "matchEnd") return newMatch();
  if (phase === "roundEnd" || phase === "draft") return;
  if (phase === "choose" || phase === "auction" || phase === "discard") return;
  if (m.roundOver) return finishRound();
  nextTurn();
};
$("btn-restart").onclick = () => { closeModal(); newMatch(); };

// 回车 = 确认 / 下一步
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (phase === "choose") { confirmPlay(); return; }
  if (!$("btn-next").disabled) $("btn-next").onclick();
});

$("overlay").onclick = (e) => {
  if (e.target === $("overlay") && $("overlay").dataset.closable) closeModal();
};

initTips();

// 自动化钩子：便于本地调试与 E2E（单机页面，不涉及服务端状态）
globalThis.__XD_APP__ = {
  state: () => ({ phase, turn: m.turn, round: m.roundIndex, roundOver: m.roundOver, matchOver: m.matchOver }),
  playable: () => (m ? playableCards(m, m.players[MY]).map((id) => ({ id, cost: fmt(costFor(m, m.players[MY], id)) })) : []),
  pickShu: (id) => { picked.shu = id; render(); },
  pickDao: (id) => { picked.dao = id; render(); },
  confirm: () => confirmPlay(),
  next: () => { if (!$("btn-next").disabled) $("btn-next").onclick(); },
  bid: (n) => settleAuction(n),
  continueAfterRound: () => continueAfterRound(),
  finishRound: () => finishRound(),        // R72：调试/E2E 用，直接进局末
  match: () => m,
};

newMatch();
