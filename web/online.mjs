// 联机客户端：只发意图，不算法则。
//
// 收到的每一条消息都是"服务端投影"（view.mjs），本文件不 import 引擎 —— 除了卡牌名表
// （渲染需要中文名）。这样就不存在"前端偷偷算一遍规则导致两边不一致"的可能。
import * as D from "./src/data.mjs";
import { shuHtml, daoHtml, equipRowHtml, shuGroups, nameOf } from "./render.mjs";
import { renderBoard, playsOf, facColor } from "./board.mjs";
import { EventLog } from "./panel.mjs";
import { initTips } from "./tips.mjs";
import { CFG_OPTIONS } from "./lobby-config.mjs";

const $ = (id) => document.getElementById(id);
const LS = { room: "xd_room", token: "xd_token", name: "xd_name", recent: "xd_recent" };
const RECENT_MAX = 8;            // R83：本机记住最近进过的房间号（可逐条删）
const REVEAL_MS = 4200;          // 出牌在各人面前停留多久（斗地主式"亮一下"）

let ws = null;
let roomId = null;
let token = null;
let seat = -1;
let amHost = false;
let st = null;                 // 最近一条服务端消息
let lastMsg = null;            // 最近一条对局消息（重绘用）
let picked = { shu: null, dao: null, ops: [] };
let lastView = null;
let offset = 0;                // 服务端时间 - 本地时间
let ticker = null;
let reconnectAt = 0;
const expanded = new Set();   // 术牌折叠组（新出现的组自动展开，别让玩家面对一排收起的抽屉）
const seenGroups = new Set();
let shownPlays = {};           // 当前贴在座位前的牌
let myCard = null;             // 本回合我提交的牌（暗选阶段只给自己看）
let clearTimer = null;
const MSGS = [];
globalThis.__XD_MSGS__ = MSGS;

const panel = new EventLog($("panel"));

// ---------- 连接 ----------

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    MSGS.push("OPEN");
    setBanner("");
    flushSend();
    const savedRoom = localStorage.getItem(LS.room);
    const savedToken = localStorage.getItem(LS.token);
    const hash = (location.hash || "").replace("#", "").trim();
    // 只在"同一个房间的 hash + 本机存过 token"时才自动续座。
    // 否则新开一个标签页会把上一个标签的座位顶掉（所有人共享 localStorage）——
    // 这个坑在实际使用里就是"我在手机上开了第二页，第一页突然卡住不动"。
    if (savedRoom && savedToken && hash === savedRoom) {
      send({ t: "resume", roomId: savedRoom, token: savedToken });
    } else if (hash.length === 6) {
      $("in-room").value = hash;
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };

  ws.onclose = (e) => {
    MSGS.push("CLOSE:" + (e && e.code));
    pendingSend.length = 0;      // 断线后重连不重放旧指令，免得重复建房
    setBanner("连接断开，正在重连…");
    const wait = Math.max(800, 3000 - (Date.now() - reconnectAt));
    reconnectAt = Date.now();
    setTimeout(connect, wait);
  };
}

// 连接还没 open 时先把指令排队 —— 否则"点了创建房间但没反应"，
// 用户只会以为是卡了（E2E 里也踩过：ready 之后立刻 send，消息直接丢了）。
const pendingSend = [];
const send = (obj) => {
  if (!ws || ws.readyState !== 1) {
    if (ws && ws.readyState === 0) { pendingSend.push(obj); return true; }
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
};

function flushSend() {
  while (pendingSend.length && ws && ws.readyState === 1) {
    ws.send(JSON.stringify(pendingSend.shift()));
  }
}

function handle(msg) {
  if (msg.serverNow) offset = msg.serverNow - Date.now();
  MSGS.push(msg.t + ":" + (msg.phase || msg.room?.phase || "") + (msg.msg ? "!" + msg.msg : ""));
  if (MSGS.length > 60) MSGS.shift();

  switch (msg.t) {
    case "hello":
      if (msg.roomId) {
        roomId = msg.roomId;
        localStorage.setItem(LS.room, roomId);
        history.replaceState(null, "", "#" + roomId);
        $("m-room").textContent = roomId;
        rememberRoom(roomId);
      }
      if (msg.seat != null && msg.seat >= 0) {
        seat = msg.seat;
        if (msg.token) { token = msg.token; localStorage.setItem(LS.token, token); }
      }
      return;
    case "dissolved":
      // R83：房主解散 —— 房间已经不存在了，回首页并清掉本地凭证
      localStorage.removeItem(LS.room);
      localStorage.removeItem(LS.token);
      roomId = null; seat = -1; token = null; st = null; amHost = false;
      $("btn-dissolve").style.display = "none";
      history.replaceState(null, "", location.pathname);
      showHome();
      toast("房主已解散房间");
      return;
    case "room":
      st = msg;
      setHostView(!!msg.amHost);
      renderLobby(msg.room);
      return;
    case "view":
      st = msg;
      setHostView(!!msg.amHost);
      if (msg.seat != null && msg.seat >= 0) seat = msg.seat;
      renderGame(msg);
      return;
    case "error":
      toast(msg.msg);
      if (/房间不存在|房间已解散|凭证已失效|座位已回收/.test(msg.msg)) {
        localStorage.removeItem(LS.room);
        localStorage.removeItem(LS.token);
        roomId = null; seat = -1;
        showHome();
      }
      return;
  }
}

// ---------- 大厅 ----------

// R83：房主权限随时可能变（原房主走了，服务器会把房主转给还在的人），界面要跟着走
let hostSeen = false;            // 本次进房是否已经确认过身份（避免刚建房就误报"你成为房主"）
function setHostView(isHost) {
  const promoted = hostSeen && !amHost && isHost;
  amHost = isHost;
  hostSeen = true;
  $("btn-dissolve").style.display = isHost && roomId ? "" : "none";
  if (promoted) toast("原房主离开了，你现在是房主");
}

// ---------- 最近进入的房间（本机缓存，可逐条删） ----------

function recentRooms() {
  try {
    const list = JSON.parse(localStorage.getItem(LS.recent) || "[]");
    return Array.isArray(list) ? list.filter((x) => x && /^\d{6}$/.test(x.id)) : [];
  } catch { return []; }
}

function saveRecent(list) {
  localStorage.setItem(LS.recent, JSON.stringify(list.slice(0, RECENT_MAX)));
}

function rememberRoom(id) {
  if (!id) return;
  const list = recentRooms().filter((x) => x.id !== id);
  list.unshift({ id, at: Date.now() });
  saveRecent(list);
  renderRecent();
}

function forgetRoom(id) {
  saveRecent(recentRooms().filter((x) => x.id !== id));
  renderRecent();
}

function agoText(ts) {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function renderRecent() {
  const box = $("recent-box");
  if (!box) return;
  const list = recentRooms();
  if (!list.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = `
    <div class="recent-hd"><span>最近进入</span><button class="lnk" id="recent-clear">清空</button></div>
    <div class="recent-list">
      ${list.map((r) => `<div class="recent-row">
        <button class="recent-go" data-go="${r.id}">${r.id}</button>
        <span class="recent-at">${agoText(r.at)}</span>
        <button class="recent-x" data-del="${r.id}" title="从列表移除">×</button>
      </div>`).join("")}
    </div>`;
  box.querySelectorAll("[data-go]").forEach((b) => {
    b.onclick = () => { $("in-room").value = b.dataset.go; joinRoom(); };
  });
  box.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); forgetRoom(b.dataset.del); };
  });
  $("recent-clear").onclick = () => { localStorage.removeItem(LS.recent); renderRecent(); };
}

function showHome() {
  document.body.classList.remove("in-game");
  $("table").style.display = "none";
  $("lobby").style.display = "block";
  $("lobby-home").style.display = "flex";
  $("lobby-room").style.display = "none";
  $("btn-dissolve").style.display = "none";
  hostSeen = false;                // 离开房间后重置，下次进房重新确认身份
  renderRecent();
}

function renderLobby(room) {
  if (!room) return;
  roomId = room.id;
  $("m-room").textContent = room.id;
  $("table").style.display = "none";
  $("lobby").style.display = "block";
  $("lobby-home").style.display = "none";
  const box = $("lobby-room");
  box.style.display = "block";

  const cfgOptions = CFG_OPTIONS;

  const slots = room.seats.map((s) => {
    const cls = s.kind === "empty" ? "slot" : "slot filled";
    const mine = s.seat === seat;
    const ops = [];
    if (s.kind === "empty" && seat < 0) ops.push(`<button class="btn" data-take="${s.seat}">入座</button>`);
    if (amHost && s.kind === "empty") ops.push(`<button class="btn" data-ai="${s.seat}">补人机</button>`);
    if (amHost && s.kind === "ai") ops.push(`<button class="btn" data-clear="${s.seat}">清位</button>`);
    const facChips = amHost
      ? `<div class="ops">${Array.from({ length: room.config.factions }, (_, i) =>
          `<button class="btn ${s.factionId === i ? "primary" : ""}" data-fac="${s.seat}:${i}">${i + 1}</button>`).join("")}</div>`
      : "";
    const kindText = s.kind === "human" ? (s.connected ? "玩家" : "掉线") : s.kind === "ai" ? "人机" : "空位";
    return `
      <div class="${cls}">
        <div class="facbar" style="background:${facColor(s.factionId)}"></div>
        <div class="who">${s.name} ${s.isHost ? "👑" : ""} ${mine ? "（我）" : ""}</div>
        <div class="tagline">座位 ${s.seat + 1} · 势力 ${s.factionId + 1} · ${kindText}</div>
        <div class="ops">${ops.join("")}</div>
        ${facChips}
      </div>`;
  }).join("");

  box.innerHTML = `
    <div style="display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap">
      <div>
        <div style="font-size:11px;color:var(--ink3);letter-spacing:.14em">房号</div>
        <div class="roomcode">${room.id}</div>
      </div>
      <button class="btn" id="btn-copy">复制邀请链接</button>
      <div style="flex:1"></div>
      <div style="font-size:11.5px;color:var(--ink3)">${room.watchers} 人观战</div>
    </div>

    ${amHost ? `<div class="cfgrow">人数：
      ${cfgOptions.map((o) => `<button class="chip ${room.config.factions === o.factions && room.config.per === o.per ? "on" : ""}"
        data-cfg="${o.factions}:${o.per}" title="${o.factions * o.per} 人">${o.label}<em>${o.factions * o.per}</em></button>`).join("")}
    </div>` : `<div class="cfgrow">当前配置：${room.config.players} 人 / ${room.config.factions} 势力</div>`}

    <div class="grid-seats">${slots}</div>

    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${amHost ? `<button class="btn primary" id="btn-start">开始对局</button>` : `<span style="color:var(--ink3);font-size:12px">等房主开始对局…</span>`}
      <span style="color:var(--ink3);font-size:11.5px">空位可以补人机；开局前可改势力归属。</span>
    </div>`;

  box.querySelectorAll("[data-cfg]").forEach((b) => b.onclick = () => {
    const [f, p] = b.dataset.cfg.split(":").map(Number);
    send({ t: "config", factions: f, per: p });
  });
  box.querySelectorAll("[data-take]").forEach((b) => b.onclick = () => send({ t: "take", seat: Number(b.dataset.take) }));
  box.querySelectorAll("[data-ai]").forEach((b) => b.onclick = () => send({ t: "addAI", seat: Number(b.dataset.ai) }));
  box.querySelectorAll("[data-clear]").forEach((b) => b.onclick = () => send({ t: "clear", seat: Number(b.dataset.clear) }));
  box.querySelectorAll("[data-fac]").forEach((b) => b.onclick = () => {
    const [s, f] = b.dataset.fac.split(":").map(Number);
    send({ t: "faction", seat: s, factionId: f });
  });
  $("btn-copy").onclick = () => {
    const url = `${location.origin}${location.pathname}#${room.id}`;
    navigator.clipboard?.writeText(url).then(
      () => toast("邀请链接已复制"),
      () => toast(url)
    );
  };
  const startBtn = $("btn-start");
  if (startBtn) startBtn.onclick = () => { panel.reset(); send({ t: "start" }); };
}

// ---------- 对局 ----------

function renderGame(msg) {
  const v = msg.view;
  lastMsg = msg;
  document.body.classList.add("in-game");
  $("lobby").style.display = "none";
  $("table").style.display = "flex";

  $("m-round").textContent = Math.min(v.round + 1, 4);
  $("m-turn").textContent = v.turn;
  $("m-tianji").textContent = v.tianji?.now ? nameOf(v.tianji.now) : (v.lastTianji ? nameOf(v.lastTianji) : "—");

  if (!lastView || lastView.round !== v.round || lastView.turn !== v.turn) {
    picked = { shu: null, dao: null, ops: [] };
    myCard = null;
  }
  lastView = v;

  updatePlays(v, msg);
  renderBoard($("board"), v, boardCtx(msg, v));

  panel.update(v, msg);
  renderTray(msg, v);
  renderModals(msg, v);
  updateTimer(msg);
}

// 谁面前该摆哪张牌：结算后全部翻开亮几秒；暗选阶段只摆自己那张
function updatePlays(v, msg) {
  const fromLog = playsOf(v.log || []);
  if (Object.keys(fromLog).length) {
    shownPlays = fromLog;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { shownPlays = {}; if (lastMsg) renderGame(lastMsg); }, REVEAL_MS);
    return;
  }
  if (msg.phase === "choose" && myCard && (msg.submitted || []).includes(seat)) {
    shownPlays = { [seat]: myCard };
  }
}

function renderTray(msg, v) {
  const me = v.me;
  const canAct = msg.phase === "choose" && me && me.canAct && (msg.waiting || []).includes(msg.seat);

  // 手牌始终摆出来（不能点时置灰），比"一片空白"更像牌桌
  if (me) {
    // R49：默认只展开「术系」。攻击 / 防御折叠着，四个分组标题并排一行就能全看见；
    // 展开某一组会把它撑宽，其余组被推到右边（横向可滚），这是用户主动选的。
    for (const g of shuGroups(v)) {
      if (!g.collapsible || seenGroups.has(g.key)) continue;
      if (!g.key.startsWith("set:")) continue;
      seenGroups.add(g.key);
      expanded.add(g.key);
    }
    $("hand-shu").innerHTML = shuHtml(v, picked.shu, expanded);
    // R55：手牌区直接给出神装的「装载」，下面单独一行给已装载的「卸下」
    // R76：天赋与道牌同一行（只留按钮，说明点「?」再看），不再单独占一行
    $("hand-dao").innerHTML = daoHtml(v, picked.dao, { equipUI: canAct }) + equipRowHtml(v, { equipUI: canAct })
      + (canAct ? talentInlineHtml(v, msg) : "");
    $("hand-shu").classList.toggle("locked", !canAct);
    $("hand-dao").classList.toggle("locked", !canAct);
    if (canAct) { bindHand(msg, v); bindTalent(); }
    if (canAct) bindEquip(msg, v);
  } else {
    $("hand-shu").innerHTML = '<span class="hintline">观战中</span>';
    $("hand-dao").innerHTML = "";
  }

  // 没道牌也没神装就把整行收起来，手机上能省出一行高度
  const daoRow = $("row-dao");
  const hasTalent = canAct && v.me && (v.me.freeOps || []).length > 0;
  if (daoRow) {
    daoRow.style.display = me && ((me.hand || []).length || (me.equip || []).length || hasTalent) ? "flex" : "none";
  }

  // R49/R76：天赋区不再是独立一行 —— 内容在道牌行里（talentInlineHtml）
  const talentRow = $("row-talent");
  if (talentRow) talentRow.style.display = "none";

  const acts = $("tray-actions");
  acts.innerHTML = "";

  // R42：天机门人身世已删除，不再有"天机窗口"这个阶段
  if (msg.phase === "choose" && !canAct) {
    acts.innerHTML = `<span class="hintline">${me?.canAct === false ? "你已被淘汰，本局观战" : "已提交，等其他人出牌…"}</span>`;
    return;
  }

  if (canAct) {
    if (me.mustAttack) {
      const warn = document.createElement("span");
      warn.className = "hintline";
      warn.style.color = "var(--red)";
      warn.textContent = "本回合必须出攻击";
      acts.appendChild(warn);
    }
    const cost = picked.shu ? (v.me?.playable.find((x) => x.id === picked.shu)?.cost ?? 0) : 0;
    const c = document.createElement("span");
    c.className = "cost";
    c.innerHTML = `消耗 <b>${cost}</b>　能量 ${me.energy}`;
    acts.appendChild(c);

    const b = document.createElement("button");
    b.className = "btn primary";
    b.textContent = picked.shu ? `确认打出 · ${nameOf(picked.shu)}` : "请选一张术";
    b.disabled = !picked.shu;
    b.onclick = () => play();
    acts.appendChild(b);
  }
}

// R55 神装：装载 / 卸下都是独立消息，不走出牌提交
function bindEquip(msg, v) {
  $("hand-dao").querySelectorAll("[data-eq-on]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      send({ t: "equip", op: "equip", daoId: b.dataset.eqOn });
    };
  });
  $("hand-dao").querySelectorAll("[data-eq-off]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      send({ t: "equip", op: "unequip", daoId: b.dataset.eqOff });
    };
  });
}

function bindHand(msg, v) {
  $("hand-shu").querySelectorAll("[data-grp]").forEach((b) => b.onclick = () => {
    const k = b.dataset.grp;
    expanded.has(k) ? expanded.delete(k) : expanded.add(k);
    renderTray(msg, v);
  });
  $("hand-shu").querySelectorAll("[data-shu]").forEach((b) => b.onclick = () => {
    picked.shu = b.dataset.shu; renderTray(msg, v);
  });
  $("hand-dao").querySelectorAll("[data-dao]").forEach((b) => b.onclick = () => {
    picked.dao = picked.dao === b.dataset.dao ? null : b.dataset.dao; renderTray(msg, v);
  });
}

function play() {
  if (!picked.shu) return;
  const card = D.cardById(picked.shu);
  const ok = send({
    t: "play",
    cardId: picked.shu,
    daoId: picked.dao,
    freeOps: picked.ops.map((op) => ({ op })),
  });
  if (ok) {
    myCard = {
      seat, cardId: picked.shu, name: card?.name || "",
      value: card?.type === "攻术" ? card.atk : card?.type === "御术" ? (card.def ?? "∞") : "",
    };
    shownPlays = { [seat]: myCard };
    $("hand-shu").innerHTML = '<span class="hintline">已提交，等其他人…</span>';
    $("hand-dao").innerHTML = "";
    $("tray-actions").innerHTML = "";
    picked = { shu: null, dao: null, ops: [] };
    if (lastMsg) renderBoard($("board"), lastMsg.view, boardCtx(lastMsg, lastMsg.view));
  }
}

// 牌桌渲染上下文：进程条需要阶段、等待名单、最近事件
function boardCtx(msg, v) {
  return {
    mySeat: seat,
    phase: msg.phase,
    waiting: msg.waiting || [],
    submitted: msg.submitted || [],
    playOf: shownPlays,
    events: v.log || [],
    names: v.players.map((p) => p.name),
    auctionResult: msg.auctionResult || null,   // R67：拍卖结果公示数据
    setDraft: msg.setDraft || null,             // R72：局末术系轮抽
    tempDraw: msg.tempDraw || [],               // R72：局初官宦子弟抽取公示
  };
}

// R76：天赋内联块 —— 只放按钮和血/能读数，身世说明折叠到「?」里
function talentInlineHtml(v, msg) {
  const me = v.me;
  const ops = (me?.freeOps || []);
  if (!me || !ops.length) return "";
  const btns = ops.map((op) =>
    `<button class="btn tbtn" data-op="${op.op}" ${op.enabled ? "" : "disabled"}
      title="${op.enabled ? "点一次生效一次，可反复" : op.why || "条件不满足"}">${op.label}</button>`).join("");
  const cnt = msg.convertCount || 0;
  return `<span class="talent-inline">
    <b>天赋</b><span class="tname">${me.birthName || "身世"}</span>
    <button class="tq" data-birth="1" title="查看天赋说明">?</button>
    <span class="tops">${btns}</span>
    <span class="tstat">血 <b>${me.hp}</b>/${me.maxHp} · 能 <b>${me.energy}</b>${
      cnt ? `<em> · 已换 ${cnt}</em>` : ""}</span>
  </span>`;
}

function bindTalent() {
  document.querySelectorAll("[data-op]").forEach((b) => {
    b.onclick = () => {
      picked = { shu: null, dao: null, ops: [] };   // 换了血/能，之前选的牌必须作废重选
      modalKey = "";                                 // 强制重绘
      send({ t: "convert", op: b.dataset.op });
    };
  });
  document.querySelectorAll("[data-birth]").forEach((b) => {
    b.onclick = () => openBirthInfo();
  });
}

function openBirthInfo() {
  const me = st?.view?.me;
  if (!me) return;
  openModal(`
    <h3>身世 · ${me.birthName || ""}</h3>
    <p style="font-size:12.5px;line-height:1.7">${me.birthText || "（这个身世没有主动操作）"}</p>
    <div class="acts"><button class="btn" id="birth-close">知道了</button></div>`);
  const b = document.getElementById("birth-close");
  if (b) b.onclick = () => { closeModal(); modalKey = ""; };
}

// ---------- 弹窗 ----------



let modalKey = "";
let bidTick = null;      // R67：出价倒计时的 interval

function renderModals(msg, v) {
  const key = `${msg.phase}:${v.round}:${v.turn}:${msg.prompts?.length || 0}:${msg.bid}:${v.me?.discard?.over || 0}`;
  if (key === modalKey) return;

  // R51 开场：公示身世，等玩家确认
  if (msg.phase === "births") {
    modalKey = key;
    return openBirths(msg, v);
  }
  // R72/R73 局末：术系轮抽 —— 自己所属势力在挑时才弹（代表能点，队友只看）
  if (msg.phase === "setDraft" && msg.draftTurn?.mine) {
    modalKey = key;
    return openDraft(msg, v);
  }
  if (msg.phase === "discard" && v.me?.discard) {
    modalKey = key;
    return openDiscard(v);
  }
  if (msg.phase === "auction" && msg.bid === undefined && v.me?.canAct) {
    modalKey = key;
    return openAuction(msg, v);
  }
  // R44 窥天：天机执行前的嫁接窗口（要同时选「搬谁的份」和「嫁接到谁」）
  if (msg.phase === "tianjiExec" && msg.pendingGraft && !msg.answered) {
    modalKey = key;
    return openGraft(msg, v);
  }
  // prompt = 出牌后的追问；tianjiExec = 天机执行前的协同操作（R53 ④）
  if ((msg.phase === "prompt" || msg.phase === "tianjiExec") && msg.prompts?.length && !msg.answered) {
    modalKey = key;
    return openPrompts(msg, v);
  }
  if (msg.phase === "roundEnd" && msg.roundSummary?.length) {
    modalKey = key;
    return openRoundEnd(msg, v);
  }
  if (msg.phase === "matchOver") {
    modalKey = key;
    return openMatchEnd(msg, v);
  }
  if (["choose", "reveal", "auctionResult"].includes(msg.phase)) {
    modalKey = "";
    closeModal();
  }
}

// ---------- R44 天机嫁接（窥天）----------
function openGraft(msg, v) {
  const g = msg.pendingGraft;
  const names = v.players.map((p) => p.name);
  const alive = v.players.filter((p) => p.alive).map((p) => p.seat);
  let from = null, to = null;
  const chips = (key) => alive.map((s) =>
    `<button class="pick" data-g="${key}" data-seat="${s}">${names[s]}（血 ${v.players[s].hp}）</button>`).join("");
  openModal(`
    <h3>窥天 · 嫁接天机</h3>
    <p>本回合天机：<b>${g.name}</b>　由 ${names[g.holder]} 持有窥天。</p>
    <p style="font-size:12px;opacity:.75">把某一个人的那一份搬走，挂到另一个人身上——
      <b>被搬走的人完全不受影响，被嫁接的人吃到两份</b>。全场类天机（如焚天）也能这样改。</p>
    <div style="margin-top:10px">
      <div style="font-size:12px;color:var(--ink3)">① 搬走谁的那一份？</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" id="g-from">${chips("from")}</div>
    </div>
    <div style="margin-top:10px">
      <div style="font-size:12px;color:var(--ink3)">② 嫁接到谁身上？</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px" id="g-to">${chips("to")}</div>
    </div>
    <div class="acts">
      <button class="btn primary" id="g-ok" disabled>确认嫁接</button>
      <button class="btn" id="g-skip">不改，按原样生效</button>
    </div>`);
  const ok = document.getElementById("g-ok");
  const sync = () => { ok.disabled = !(from !== null && to !== null && from !== to); };
  document.querySelectorAll("[data-g]").forEach((b) => {
    b.onclick = () => {
      const s = Number(b.dataset.seat);
      const key = b.dataset.g;
      document.querySelectorAll(`[data-g="${key}"]`).forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      if (key === "from") from = s; else to = s;
      sync();
    };
  });
  ok.onclick = () => {
    send({ t: "answers", answers: { [`graft_from_${g.holder}`]: from, [`graft_to_${g.holder}`]: to } });
    closeModal(); modalKey = "";
  };
  document.getElementById("g-skip").onclick = () => {
    send({ t: "answers", answers: { [`graft_from_${g.holder}`]: -1, [`graft_to_${g.holder}`]: -1 } });
    closeModal(); modalKey = "";
  };
}

// ---------- R51 开场：抽身世 ----------
function openBirths(msg, v) {
  const me = v.players[seat];
  const birth = me?.birthName || me?.birth || "";
  const birthText = me?.birthText || "";
  const acked = !(msg.waiting || []).includes(seat);
  openModal(`
    <h3>开场 · 抽取身世</h3>
    <p style="font-size:12px;opacity:.75">从 6 种身世中随机获取，可以重复。</p>
    <div class="birth-card">
      <div class="birth-name">${birth}</div>
      <div class="birth-text">${birthText}</div>
    </div>
    <p style="font-size:12px;opacity:.75">${acked ? "已确认，等待其他人…" : "确认后进入第一局。"}</p>
    <div class="acts">
      <button class="btn primary" id="birth-ok" ${acked ? "disabled" : ""}>${acked ? "已确认" : "确认身世"}</button>
    </div>`);
  const b = document.getElementById("birth-ok");
  if (b && !acked) b.onclick = () => { send({ t: "birthAck" }); closeModal(); modalKey = ""; };
}

// ---------- R72 局末：术系轮抽 ----------
function openDraft(msg, v) {
  const d = msg.setDraft || {};
  const pool = d.pool || [];
  const who = (d.order || []).find((o) => o.state === "current");
  const names = (who?.members || []).map((x) => v.players[x]?.name || `座位${x + 1}`);
  const setName = (id) => D.setById(id)?.name || id;
  // 已经把谁挑走了也摆出来 —— 否则玩家不知道"现在还剩哪些是别人不要的"
  const done = (d.order || []).filter((o) => o.setId).map((o) => {
    const n = (o.members || []).map((x) => v.players[x]?.name || `座位${x + 1}`).join("/");
    return `<div class="dr-done"><i>${n}</i><b>${setName(o.setId)}</b></div>`;
  }).join("");
  const youPick = !!msg.draftTurn?.youPick;
  openModal(`
    <h3>术系轮抽 · 轮到你们</h3>
    <p style="font-size:12px">按<b>存活长短</b>轮流挑（活得越久越先挑），你们是第 <b>${d.idx + 1}</b> 家（共 ${d.order.length} 家）。
      挑走的一套归势力所有，队内共享。</p>
    ${done ? `<div class="dr-list">${done}</div>` : ""}
    ${youPick
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        ${pool.map((id) => `<button class="pick" data-dset="${id}">${D.setById(id)?.name || id}</button>`).join("")}
      </div>
      <p style="font-size:12px;opacity:.75;margin-top:8px">
        剩余 ${pool.length} 套；本局由你决定${(who?.members || []).length > 1 ? "（队里最后被淘汰的成员）" : ""}。超时自动随机。</p>`
    : `<p style="font-size:12px;opacity:.75;margin-top:10px">
        本局由队里<b>最后被淘汰</b>的 ${names.join("/")} 决定，你在等他挑。超时自动随机。</p>`}`);
  if (!youPick) return;                 // 队友只看，不给按钮
  document.querySelectorAll("[data-dset]").forEach((b) => {
    b.onclick = () => {
      send({ t: "setDraft", setId: b.dataset.dset });
      closeModal();
      modalKey = "";
    };
  });
}

function openAuction(msg, v) {
  const offer = v.auction;
  // v.me.energy 已经是"点"了（引擎内部用半点单位，投影层已换算过），不要再除一次。
  // 出价只按整点，向下取整后剩下的零头留在手里，出不了价。
  const energy = Number(v.me.energy) || 0;
  const max = Math.floor(energy);
  const odd = Math.round((energy - max) * 10) / 10;
  const opts = [];
  for (let i = 0; i <= max; i++) opts.push(i);
  openModal(`
    <h3>道牌拍卖 · 第 ${v.turn} 回合</h3>
    <p><b>${offer ? offer.name : "?"}</b>（${offer?.category || ""}）</p>
    <p style="font-size:12px">${offer?.text || ""}</p>
    <p>你的能量：<b>${energy}</b>　最高可出：<b>${max}</b> 点${odd ? `（余 ${odd} 点出不了价，留在手里）` : ""}</p>
    <p style="font-size:12px;opacity:.75">只能按整点出价；没拍到的人不扣能量。</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${opts.map((i) => `<button class="pick" data-bid="${i}">${i}</button>`).join("")}
    </div>
    <div class="acts"><button class="btn" data-bid="0">弃权（出 0）</button>
      <span class="bid-left">剩余 <b id="bid-left">—</b> 秒，超时按弃权处理</span></div>`);
  document.querySelectorAll("[data-bid]").forEach((b) => {
    b.onclick = () => {
      clearInterval(bidTick); bidTick = null;
      send({ t: "bid", bid: Number(b.dataset.bid) });
      closeModal(); modalKey = "";
    };
  });
  // R67：出价窗口最多 15 秒，给个倒计时，到点服务端按 0 点（弃权）结算
  clearInterval(bidTick);
  let left = msg.deadline && msg.serverNow
    ? Math.max(0, Math.ceil((msg.deadline - msg.serverNow) / 1000))
    : 15;
  const tick = () => {
    const el = document.getElementById("bid-left");
    if (!el) { clearInterval(bidTick); bidTick = null; return; }
    el.textContent = String(Math.max(0, left));
    if (left <= 0) { clearInterval(bidTick); bidTick = null; }
    left -= 1;
  };
  tick();
  bidTick = setInterval(tick, 1000);
}

// 回合末弃牌：道牌上限 = 血量上限，超了自己挑要弃哪几张
function openDiscard(v) {
  const d = v.me.discard;
  const pickedIds = new Set();
  openModal(`
    <h3>弃牌</h3>
    <p>道牌上限 <b>${d.cap}</b> 张（= 血量上限），你现有 ${d.handCount} 张，需弃 <b>${d.over}</b> 张。</p>
    <div id="d-list" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${(v.me.hand || []).map((id) => `<button class="pick" data-did="${id}">${nameOf(id)}</button>`).join("")}
    </div>
    <div class="acts">
      <span class="hintline" id="d-tip">已选 0/${d.over}</span>
      <button class="btn" id="d-ok" disabled>确认弃牌</button>
    </div>`);
  const ok = $("d-ok");
  const tip = $("d-tip");
  document.querySelectorAll("[data-did]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.did;
      if (pickedIds.has(id)) { pickedIds.delete(id); b.classList.remove("on"); }
      else if (pickedIds.size < d.over) { pickedIds.add(id); b.classList.add("on"); }
      tip.textContent = `已选 ${pickedIds.size}/${d.over}`;
      ok.disabled = pickedIds.size !== d.over;
    };
  });
  ok.onclick = () => {
    if (pickedIds.size !== d.over) return;
    send({ t: "discard", ids: [...pickedIds] });
    closeModal();
    modalKey = "";
  };
}

function openPrompts(msg, v) {
  const spec = msg.prompts[0];          // 同一回合通常只有一个需要选择的点
  const names = v.players.map((p) => p.name);
  let body = "";
  if (spec.type === "target" || spec.type === "targets") {
    body = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${(spec.pool || []).map((s) => `<button class="pick" data-ans="${s}">${names[s]}（血 ${v.players[s].hp}）</button>`).join("")}
    </div>`;
  } else if (spec.type === "card") {
    body = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${(spec.pool || []).map((id) => `<button class="pick" data-ans="${id}" data-tip="${id}">${nameOf(id)}</button>`).join("")}
    </div>`;
  } else if (spec.type === "branch" || spec.type === "subgame") {
    body = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
      ${(spec.options || []).map((o) => `<button class="pick" data-ans="${o}">${o}</button>`).join("")}
    </div>`;
  } else if (spec.type === "allocate") {
    body = `<div style="display:flex;gap:8px;margin-top:10px;align-items:center;font-size:13px">
      攻击 <input id="al-a" type="number" min="0" max="${spec.total}" value="0" style="width:60px">
      回血 <input id="al-h" type="number" min="0" max="${spec.total}" value="0" style="width:60px">
      防御 <input id="al-d" type="number" min="0" max="${spec.total}" value="${spec.total}" style="width:60px">
      <span style="color:var(--ink3);font-size:11px">共 ${spec.total} 点</span>
    </div>
    <div class="acts"><button class="btn primary" id="al-ok">确认</button></div>`;
  }
  openModal(`
    <h3>需要你的选择</h3>
    <p>${spec.label || ""}</p>
    ${body}
    <div class="acts"><button class="btn" id="ans-skip">让系统决定</button></div>`);

  document.querySelectorAll("[data-ans]").forEach((b) => {
    b.onclick = () => {
      const raw = b.dataset.ans;
      const value = spec.type === "target" || spec.type === "targets" ? Number(raw) : raw;
      send({ t: "answers", answers: { [spec.id]: value } });
      closeModal(); modalKey = "";
    };
  });
  const ok = $("al-ok");
  if (ok) ok.onclick = () => {
    const a = Number($("al-a").value) || 0;
    const h = Number($("al-h").value) || 0;
    const d = Number($("al-d").value) || 0;
    send({ t: "answers", answers: { [spec.id]: { attack: a, heal: h, defense: d } } });
    closeModal(); modalKey = "";
  };
  $("ans-skip").onclick = () => {
    send({ t: "answers", answers: {} });     // 服务端走兜底
    closeModal(); modalKey = "";
  };
}

function openRoundEnd(msg, v) {
  const rows = msg.roundSummary.map((r) => `
    <tr><td>${r.rank}</td><td>${r.members.map((s) => v.players[s].name).join(" / ")}</td>
    <td>${r.survived} 回合</td><td>${r.score}</td><td>${r.total}</td></tr>`).join("");
  openModal(`
    <h3>第 ${Math.min(v.round + 1, 4)} 局结束</h3>
    <table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px">
      <tr style="color:var(--ink3)"><td>名次</td><td>势力</td><td>存活</td><td>本局分</td><td>总分</td></tr>
      ${rows}
    </table>
    <p style="font-size:11.5px;color:var(--ink3);margin-top:8px">${amHost ? "点下面继续，或等 20 秒自动开始下一局" : "等房主开始下一局…"}</p>
    <div class="acts">${amHost ? '<button class="btn primary" id="go-next">进入下一局</button>' : ""}</div>`);
  const b = $("go-next");
  if (b) b.onclick = () => { send({ t: "next" }); closeModal(); modalKey = ""; };
}

function openMatchEnd(msg, v) {
  const rows = (msg.roundSummary || []).map((r) => `
    <tr><td>${r.rank}</td><td>${r.members.map((s) => v.players[s].name).join(" / ")}</td><td>${r.total}</td></tr>`).join("");
  openModal(`
    <h3>全场结束</h3>
    <table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px">
      <tr style="color:var(--ink3)"><td>名次</td><td>势力</td><td>总积分</td></tr>${rows}
    </table>
    <div class="acts">
      ${amHost ? '<button class="btn primary" id="btn-again">回到大厅（保留座位）</button>' : ""}
      <a class="btn" href="./online.html" style="text-decoration:none">离开</a>
    </div>`);
  const b = $("btn-again");
  if (b) b.onclick = () => { send({ t: "again" }); closeModal(); modalKey = ""; };
}

function openModal(html) { $("modal").innerHTML = html; $("overlay").classList.add("on"); delete $("overlay").dataset.closable; }
function closeModal() { $("overlay").classList.remove("on"); }

// ---------- 倒计时 ----------

function updateTimer(msg) {
  const el = $("m-timer");
  if (!msg.deadline) { el.textContent = ""; return; }
  const left = Math.max(0, msg.deadline - (Date.now() + offset));
  el.textContent = `${Math.ceil(left / 1000)}s`;
  el.classList.toggle("warn", left < 6000);
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (st && (st.t === "view" || st.t === "room")) updateTimer(st);
  }, 250);
}

// ---------- 小工具 ----------

let bannerTimer = null;
function setBanner(text) {
  const el = $("banner");
  if (!text) { el.classList.remove("on"); return; }
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(bannerTimer);
}

function toast(text) {
  setBanner(text);
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $("banner").classList.remove("on"), 2200);
}

// ---------- 事件绑定 ----------

$("in-name").value = localStorage.getItem(LS.name) || "";
$("btn-create").onclick = () => {
  const name = ($("in-name").value || "").trim() || "房主";
  localStorage.setItem(LS.name, name);
  send({ t: "create", name, factions: 4, per: 1 });
};
$("btn-join").onclick = () => joinRoom();
$("in-room").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

function joinRoom() {
  const code = ($("in-room").value || "").trim();
  const name = ($("in-name").value || "").trim() || "玩家";
  if (!/^\d{6}$/.test(code)) return toast("房号是 6 位数字");
  localStorage.setItem(LS.name, name);
  localStorage.removeItem(LS.room);
  localStorage.removeItem(LS.token);
  send({ t: "join", roomId: code, name });
}

$("btn-leave").onclick = () => {
  send({ t: "leave" });
  localStorage.removeItem(LS.room);
  localStorage.removeItem(LS.token);
  location.hash = "";
  location.reload();
};

// R83：房主解散房间 —— 立即销毁，其他人会被踢回首页
$("btn-dissolve").onclick = () => {
  if (!roomId) return;
  if (!confirm(`解散房间 ${roomId}？所有人都会被请出，房间号随即失效。`)) return;
  send({ t: "dissolve" });
  localStorage.removeItem(LS.room);
  localStorage.removeItem(LS.token);
  roomId = null; seat = -1; amHost = false;
  location.hash = "";
  setTimeout(() => location.reload(), 120);
};

renderRecent();

window.addEventListener("hashchange", () => {
  const code = (location.hash || "").replace("#", "");
  if (code.length === 6 && st?.room?.phase === "lobby") $("in-room").value = code;
});

// 点空白处关掉"看看就行"的弹窗（拍卖/追问这类必须做选择的，不响应）
$("overlay").onclick = (e) => {
  if (e.target === $("overlay") && $("overlay").dataset.closable) closeModal();
};

initTips();

// 自动化钩子（联机页：只暴露"发指令"和"读状态"，方便本地 E2E）
globalThis.__XD_ONLINE__ = {
  boot: Math.random().toString(36).slice(2, 7),   // 用于诊断"页面是否被重载"
  state: () => st,
  seat: () => seat,
  room: () => roomId,
  send: (obj) => send(obj),
  play: (cardId, daoId = null) => { picked = { shu: cardId, dao: daoId, ops: [] }; play(); },
  answer: (id, v) => send({ t: "answers", answers: { [id]: v } }),
  bid: (n) => send({ t: "bid", bid: n }),
  join: (code, name) => { $("in-room").value = code; $("in-name").value = name; joinRoom(); },
};

showHome();
startTicker();
connect();
