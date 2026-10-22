// 房间与对局状态机（服务端权威）。
//
// 原则：客户端只发「意图」，不算法则。
//   - 可出牌、费用、合法性：服务端算好放进投影（view.mjs）；
//   - 结算：服务端调引擎，客户端只收事件流；
//   - 中途要选目标：服务端先干跑收集 prompt（engine.collectPrompts），问完再真跑。
//
// 一次回合的完整时序：
//   拍卖(15s，仅第 5/10/15… 回合) → 天机窗口(6s，仅天机门人) → 出牌(45s)
//   → 追问(12s，仅需要的人) → 结算(广播) → 弃牌判断(20s) → 展示(3.5s) → 下一回合 / 局末(20s)
import crypto from "node:crypto";
import * as D from "../src/data.mjs";
import {
  createMatch, startRound, beginTurn, resolveTurn, endRound,
  peekAuction, auctionIfDue, playableCards, costFor, collectPrompts,
  discardOver, discardCards, autoDiscard, normalizeBid,
  collectTianjiPrompts, applyPendingTianjiNow,
  nextDraftFaction, applySetPick, draftStateOf, applyFreeOp,
  graftPromptSpecs, applyGraftedTianji, setEquipState,
} from "../src/engine.mjs";
import { viewFor, publicEvents } from "../src/view.mjs";
import { CONFIG } from "../src/config.mjs";
import { chooseAction, bidFor } from "../src/ai.mjs";
import { toU, fmt } from "../src/units.mjs";

const FAST = process.env.XD_FAST === "1";      // 自测用：把"展示/过场"压缩，出牌时间不变
const PHASE_MS = {
  births: FAST ? 200 : 15000,       // 开场：公示身世，等玩家确认（R51 动画挂这里）
  tempDraw: FAST ? 150 : 3000,      // R72：局初官宦子弟「同时随机抽一套」的公示期
  setDraft: FAST ? 150 : 12000,     // R72：局末术系轮抽，每个势力最多 12 秒
  setDraftEnd: FAST ? 150 : 3000,   // R72：轮抽结果公示 3 秒
  choose: CONFIG.decisionTimeoutMs,     // R18：超时未提交 -> 无能量出普通防御
  prompt: FAST ? 800 : 12000,
  auction: FAST ? 800 : 15000,          // 出价窗口：最多 15 秒，超时按 0 点（弃权）结算
  auctionResult: FAST ? 300 : 3000,     // R67：出价与结果公示 3 秒，然后进事件记录
  discard: FAST ? 800 : 20000,      // 回合末弃牌判断期
  reveal: FAST ? 200 : 3500,
  roundEnd: FAST ? 200 : 7000,      // R72：局末名次汇总（7 秒，之后接术系轮抽）
  matchOver: 0,
};

const rooms = new Map();
// R83：房间不再"没人就销毁" —— 有没有人都留着，只有两种情况会消失：
//   ① 房主主动解散；② 连续 30 分钟没有任何人在房间里。
const EMPTY_ROOM_TTL = 30 * 60_000;

// ---------- 资源变化（事件表面板用） ----------

// 一个回合里血量/能量可能被改很多次（天机、结算、拍卖），
// 面板要的是"这个回合净变化"，所以按回合累积而不是每次广播算一次。
function snapStats(m) {
  return m.players.map((p) => ({ hp: p.hp, energy: p.energy }));
}

function addChanges(room, pre) {
  const m = room.match;
  // 累加必须是**定点数**：turnChanges 里同样存定点数，格式化只在 snapshotFor 里做一次。
  // （以前把 fmt() 之后的字符串又加回去，"0" + "-1.5" 会拼成 "0-1.5"，前端就只能显示一个光秃秃的名字。）
  const acc = new Map((room.turnChanges || []).map((c) => [c.seat, c]));
  m.players.forEach((p, i) => {
    const before = pre[i] || { hp: p.hp, energy: p.energy };
    const dhp = p.hp - before.hp;            // 定点单位差，展示时再 fmt
    const de = p.energy - before.energy;
    if (!dhp && !de) return;
    const cur = acc.get(p.seat) || { seat: p.seat, hp: 0, energy: 0 };
    cur.hp += dhp;
    cur.energy += de;
    acc.set(p.seat, cur);
  });
  room.turnChanges = [...acc.values()].filter((c) => c.hp || c.energy);
}

// 下发前把定点差换成点数（0.5 一档），并丢掉没变化的那一侧
function changesForView(room) {
  return (room.turnChanges || [])
    .map((c) => ({ seat: c.seat, hp: fmt(c.hp), energy: fmt(c.energy) }))
    .map((c) => ({ ...c, hp: c.hp === "0" ? "" : c.hp, energy: c.energy === "0" ? "" : c.energy }))
    .filter((c) => c.hp || c.energy);
}

// ---------- 房间生命周期 ----------

export function createRoom(conn, { name, factions = 4, per = 1 } = {}) {
  const id = newRoomId();
  const room = {
    id,
    hostId: conn.id,
    phase: "lobby",
    createdAt: Date.now(),
    config: { factions, per },
    seats: [],
    conns: new Map(),          // clientId -> conn
    watch: new Set(),          // 观战 conn.id
    tokens: new Map(),         // token -> seat
    match: null,
    timer: null,
    deadline: 0,
    turnActs: {},
    freeOps: {},
    turnPrompts: [],
    pendingAnswers: {},
    bids: {},
    discards: {},
    tianjiVotes: {},
    daoQuotaUsed: {},
    lastEvents: [],
    roundSummary: null,
    tianjiLog: [],        // 本场天机流水（回合 → 天机），事件表面板要用
    turnChanges: [],      // 本回合各座位的血量/能量净变化
  };
  rebuildSeats(room);
  rooms.set(id, room);
  const seat = joinSeat(room, conn, name);
  touchPresence(room);               // R83：有人了 → 清掉 emptySince
  return { room, seat };
}

export function getRoom(id) { return rooms.get(String(id)); }

export function joinRoom(room, conn, name, { watch = false } = {}) {
  if (watch) {
    room.watch.add(conn.id);
    room.conns.set(conn.id, conn);
    touchPresence(room);
    return { seat: -1 };
  }
  const seat = joinSeat(room, conn, name);
  touchPresence(room);
  if (seat < 0) return { seat: -1, error: "房间已满" };
  return { seat };
}

function joinSeat(room, conn, name) {
  room.conns.set(conn.id, conn);
  if (room.phase !== "lobby") {
    // 中途加入＝观战
    room.watch.add(conn.id);
    return -1;
  }
  const target = room.seats.find((s) => s.kind === "empty");
  if (!target) { room.watch.add(conn.id); return -1; }
  const token = crypto.randomBytes(12).toString("hex");
  target.kind = "human";
  target.name = (name || "无名").slice(0, 12);
  target.clientId = conn.id;
  target.connected = true;
  target.token = token;
  room.tokens.set(token, target.seat);
  return target.seat;
}

export function resume(room, conn, token) {
  const seat = room.tokens.get(token);
  if (seat == null) return { error: "凭证已失效" };
  const s = room.seats[seat];
  if (s.kind !== "human") return { error: "座位已回收" };
  const old = s.clientId;
  // 同一个座位不允许两处同时在线：旧连接还活着就拒绝，避免"被顶掉的那一端无声卡死"
  const oldConn = old ? room.conns.get(old) : null;
  if (oldConn && !oldConn.closed && old !== conn.id) {
    return { error: "这个座位已在另一处打开" };
  }
  s.clientId = conn.id;
  s.connected = true;
  room.conns.delete(old);
  room.conns.set(conn.id, conn);
  if (room.match) room.match.players[seat].isAI = false;
  touchPresence(room);               // R83：重连回来 → 顺手续上挂起的阶段计时器
  return { seat };
}

export function leave(room, connId) {
  const s = room.seats.find((x) => x.clientId === connId);
  if (room.phase === "lobby") {
    if (s) {
      s.kind = "empty"; s.name = "空位"; s.clientId = null; s.token = null; s.connected = false;
    }
  } else if (s) {
    s.connected = false;             // 对局中：断开但保留座位，超时走默认动作；90 秒后才转人机
    if (room.match) room.match.players[s.seat].isAI = false;
    setTimeout(() => {
      if (room.phase === "lobby" || room.phase === "matchOver") return;
      if (!s.connected) takeOverByAI(room, s.seat);
    }, 90_000);
  }
  room.watch.delete(connId);
  room.conns.delete(connId);
  touchPresence(room);               // R83：房主转移 + 记录"从什么时候开始没人"
}

export function destroyRoom(room) {
  clearTimer(room);
  rooms.delete(room.id);
}

// ---------- R83：房主 / 在线状态 ----------
//
// 房间不再"人走即散"：房主离开后自动把房主转给还在房间里的人（座位优先，其次观战），
// 一个都不剩就 hostId = null，谁先进来谁接任。
function connAlive(room, id) {
  if (!id) return false;
  const c = room.conns.get(id);
  return !!(c && !c.closed);
}

export function ensureHost(room) {
  if (connAlive(room, room.hostId)) return room.hostId;
  const seatHost = room.seats.find((s) => s.kind === "human" && connAlive(room, s.clientId));
  const watcher = [...room.watch].find((id) => connAlive(room, id));
  room.hostId = seatHost ? seatHost.clientId : (watcher || null);
  return room.hostId;
}

// 每次连接变动都过一遍：转房主 + 记录"从什么时候开始没人" + 续/挂计时器
function touchPresence(room) {
  ensureHost(room);
  if (room.conns.size === 0) {
    if (!room.emptySince) room.emptySince = Date.now();
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  } else {
    room.emptySince = 0;
    resumeTimer(room);
  }
}

// 房主主动解散：立刻清空房间并通知所有人
export function dissolveRoom(room, connId) {
  if (room.hostId !== connId) return "只有房主可以解散房间";
  for (const [, conn] of room.conns) {
    try { conn.send({ t: "dissolved", roomId: room.id }); } catch { /* 掉线就算了 */ }
  }
  destroyRoom(room);
  return null;
}

function takeOverByAI(room, seat) {
  const s = room.seats[seat];
  s.kind = "ai"; s.connected = false; s.clientId = null; s.name = s.name + "(托管)";
  if (room.match) {
    room.match.players[seat].isAI = true;
    room.match.players[seat].name = s.name;
  }
  broadcast(room);
  // 若正等他出牌，直接替他出
  if (room.phase === "choose" && !room.turnActs[seat]) {
    const p = room.match.players[seat];
    if (p && p.alive) {
      const c = chooseAction(room.match, p);
      room.turnActs[seat] = { ...c };
      maybeResolve(room);
    }
  }
}

// ---------- 座位与势力 ----------

export function totalSeats(cfg) { return cfg.factions * cfg.per; }

// 人数白名单（R24）：{2,3,4,6,8}，且势力 2–4、每势力 1–2 人。
// 不用枚举表，直接算 —— 之前手写枚举漏了 2v2（2 势力 × 2 人 = 4 人）。
export function validConfig(cfg) {
  const f = Number(cfg.factions);
  const p = Number(cfg.per);
  if (!Number.isInteger(f) || !Number.isInteger(p)) return false;
  if (f < 2 || f > 4 || p < 1 || p > 2) return false;
  const n = f * p;
  return n === 2 || n === 3 || n === 4 || n === 6 || n === 8;
}

function rebuildSeats(room) {
  const n = totalSeats(room.config);
  const old = room.seats;
  room.seats = Array.from({ length: n }, (_, i) => {
    const prev = old[i];
    return prev
      ? { ...prev, seat: i, factionId: Math.floor(i / room.config.per) }
      : { seat: i, factionId: Math.floor(i / room.config.per), kind: "empty", name: "空位", clientId: null, connected: false, token: null };
  });
  // 被裁掉的座位：把连接放去观战，别直接踢
  for (const p of old.slice(n)) if (p.clientId) room.watch.add(p.clientId);
}

export function configure(room, connId, cfg) {
  if (room.phase !== "lobby") return "对局已开始，不能再改配置";
  if (connId !== room.hostId) return "只有房主能改";
  const next = { factions: Number(cfg.factions), per: Number(cfg.per) };
  if (!validConfig(next)) return "不支持的人数组合（可选 2、3、4、6、8 人）";
  room.config = next;
  rebuildSeats(room);
  return null;
}

export function setFaction(room, connId, seat, factionId) {
  if (room.phase !== "lobby") return "对局已开始";
  if (connId !== room.hostId) return "只有房主能调整势力";
  const s = room.seats[seat];
  if (!s) return "座位不存在";
  const f = Number(factionId);
  if (f < 0 || f >= room.config.factions) return "势力不存在";
  if (room.seats.filter((x) => x.factionId === f && x.seat !== seat).length >= room.config.per) return "该势力已满";
  s.factionId = f;
  return null;
}

export function takeSeat(room, connId, seat) {
  if (room.phase !== "lobby") return "对局已开始";
  const target = room.seats[seat];
  if (!target) return "座位不存在";
  if (target.kind === "human") return "该座位已有人";
  const mine = room.seats.find((x) => x.clientId === connId);
  if (mine) { mine.kind = "empty"; mine.name = "空位"; mine.clientId = null; mine.token = null; }
  const token = crypto.randomBytes(12).toString("hex");
  target.kind = "human";
  target.name = mine ? mine.name : "玩家";
  target.clientId = connId;
  target.connected = true;
  target.token = token;
  room.tokens.set(token, seat);
  return { token };
}

export function addAI(room, connId, seat) {
  if (room.phase !== "lobby") return "对局已开始";
  if (connId !== room.hostId) return "只有房主能加人机";
  const s = room.seats[seat];
  if (!s) return "座位不存在";
  if (s.kind === "human") return "该座位已有人";
  s.kind = "ai";
  s.name = `人机${seat + 1}`;
  s.connected = true;
  return null;
}

export function clearSeat(room, connId, seat) {
  if (room.phase !== "lobby") return "对局已开始";
  if (connId !== room.hostId) return "只有房主能清位";
  const s = room.seats[seat];
  if (!s || s.kind === "human") return "只能清空位或人机";
  s.kind = "empty"; s.name = "空位"; s.clientId = null; s.token = null;
  return null;
}

// ---------- 开局 ----------

export function startMatch(room, connId) {
  if (room.phase !== "lobby") return "已经开局";
  if (connId !== room.hostId) return "只有房主能开始";
  const empty = room.seats.find((s) => s.kind === "empty");
  if (empty) return `座位 ${empty.seat + 1} 还空着（请补人机或让玩家入座）`;
  const factions = new Map();
  for (const s of room.seats) factions.set(s.factionId, (factions.get(s.factionId) || 0) + 1);
  for (const [f, n] of factions) {
    if (n < 1 || n > 2) return `势力 ${f + 1} 人数为 ${n}，需 1–2 人`;
  }
  if (factions.size < 2 || factions.size > 4) return "势力数需在 2–4 之间";

  const seats = room.seats.map((s) => ({
    name: s.name,
    isAI: s.kind === "ai",
    factionId: s.factionId,
  }));
  room.match = createMatch({ seats, seed: Date.now() % 100000 });
  room.phase = "starting";
  room.lastEvents = [];
  room.tianjiLog = [];
  room.turnChanges = [];

  // R53 开场：先公示身世、等玩家确认，再进第一局（R51 的抽身世动画就挂在这个阶段）
  room.birthAcks = {};
  for (const s of room.seats) if (s.kind === "ai") room.birthAcks[s.seat] = true;
  room.phase = "births";
  setTimer(room, PHASE_MS.births, () => beginRound(room));
  emitRoom(room);
  maybeBeginRound(room);
  return null;
}

// ---------- 开场：身世公示与确认 ----------

export function submitBirthAck(room, connId) {
  if (room.phase !== "births") return "现在不是开场阶段";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  if (room.birthAcks[s.seat]) return null;      // 幂等
  room.birthAcks[s.seat] = true;
  emitRoom(room);
  maybeBeginRound(room);
  return null;
}

function maybeBeginRound(room) {
  const pend = room.seats.filter((s) => s.kind === "human" && !room.birthAcks[s.seat]);
  if (!pend.length) beginRound(room);
}

// ---------- 局初：官宦子弟特权（R52）----------

function beginRound(room) {
  const m = room.match;
  // R72：官宦子弟改成「同时、纯随机、可重复」抽取 —— 不再逐个挑，也不再等人。
  // startRound 的默认行为（autoTemp）就是每人都随机拿一套，且不互斥，正好是要的口径。
  startRound(m);
  room.roundSummary = null;
  room.setDraft = null;
  room.draftTurn = null;

  // 抽完公示 3 秒：让所有人看到"谁抽到了哪套"（之前是完全静默的）
  const draws = m.players
    .filter((p) => (p.tempSets || []).length)
    .map((p) => {
      const sid = p.tempSets[p.tempSets.length - 1];
      const set = D.setById(sid);
      return { seat: p.seat, setId: sid, name: set?.name || sid, cards: (set?.cards || []).length };
    });
  room.tempDraw = draws;

  if (draws.length) {
    room.phase = "tempDraw";
    setTimer(room, PHASE_MS.tempDraw, () => startTurn(room));
    emitRoom(room);
    return;
  }
  room.phase = "starting";
  startTurn(room);
}

// R72：局初不再有"挑"的动作，保留这个入口只为兼容老客户端 —— 直接返回 null。
export function submitSetup() { return null; }

// ---------- 回合流程 ----------

function startTurn(room, opts = {}) {
  const m = room.match;
  room.turnActs = {};
  room.freeOps = {};
  room.daoQuotaUsed = {};      // R55：本回合用掉道牌名额的人（装载神装也算）
  room.bids = {};
  room.discards = {};
  room.tianjiVotes = {};
  room.pendingAnswers = {};
  room.lastEvents = [];
  room.turnChanges = [];
  // R77：拍卖结束会再进一次 startTurn，那一次**不能**把回合数再推一格 ——
  // 以前这里无条件清成 false，于是第 5/10/15… 回合只办了拍卖、正戏整个被跳过，
  // 连带第 10 回合的「定期回复能量」也从来没触发过。
  room.turnAdvanced = !!opts.resumeAuction;

  if (m.roundOver) return finishRound(room);

  // 拍卖是第 5/10/15… 回合开始的第一个环节，排在天机判断之前：
  // 先拍完再定天机，出价时大家手上的能量还没被本回合消耗掉。
  // 这里先把回合计数推到这个新回合，牌桌上才显示「第 5 回合 · 拍卖」；
  // 拍完走 beginTurn 时用 advance:false，避免被推进两次。
  const offer = peekAuction(m);
  if (offer) {
    m.turn += 1;
    room.turnAdvanced = true;
    return startAuction(room, [], offer);
  }

  // R42：天机门人已删除，「天机窗口」这个阶段随之取消，直接进入回合开始
  beginTurnNow(room);
}

function beginTurnNow(room) {
  const m = room.match;
  const pre = snapStats(m);                     // 补给 / 天机会改血量与能量
  const ev = beginTurn(m, { advance: !room.turnAdvanced });
  const tj = ev.find((e) => e.t === "tianji");
  addChanges(room, pre);
  if (tj) {
    room.tianjiLog.push({
      round: m.roundIndex + 1, turn: m.turn, id: tj.id, name: tj.name,
      effect: D.cardById(tj.id)?.effect || "",
    });
    if (room.tianjiLog.length > 60) room.tianjiLog.shift();
  }

  // R77：补给（定期回复能量）要单独成节，原来这里只留天机，补给事件被丢掉了
  room.lastEvents = ev.filter((e) => ["tianji", "supply", "daoGain"].includes(e.t));

  // R53 ④ 天机执行：需要人参与的环节改在「出牌之前」问完并生效 ——
  // 协同型天机（天之赌场 / 赊天）和 R44 的窥天嫁接窗口都挂在这里，
  // 否则玩家是在不知道天机结果的情况下暗选的。
  const needHuman =
    (m.pendingTianji && collectTianjiPrompts(m, m.pendingTianji.id).some(
      (x) => room.seats[x.seat]?.kind === "human" && m.players[x.seat].alive))
    || (m.pendingGraft && room.seats[m.pendingGraft.holder]?.kind === "human");

  if (m.pendingTianji || m.pendingGraft) {
    room.phase = "tianjiExec";
    room.pendingAnswers = {};
    if (m.pendingGraft) {
      const holder = m.pendingGraft.holder;
      room.turnPrompts = room.seats[holder]?.kind === "human" ? graftPromptSpecs(m, holder) : [];
    } else {
      room.turnPrompts = collectTianjiPrompts(m, m.pendingTianji.id).filter(
        (x) => room.seats[x.seat]?.kind === "human" && m.players[x.seat].alive
      );
    }
    if (needHuman && room.turnPrompts.length) {
      setTimer(room, PHASE_MS.prompt, () => finishTianjiExec(room));
      emitRoom(room);
      return;
    }
    finishTianjiExec(room);
    return;
  }
  beginChoose(room);
}

function finishTianjiExec(room) {
  if (room.phase !== "tianjiExec") return;
  const m = room.match;
  const ans = room.pendingAnswers || {};
  // 协同型天机（赌场 / 赊天）
  if (m.pendingTianji) {
    const pre = snapStats(m);
    const ev = applyPendingTianjiNow(m, m.pendingTianji.id, ans);
    addChanges(room, pre);
    room.lastEvents = [...(room.lastEvents || []), ...ev];
  }
  // R44 窥天嫁接：搬走 from 的那一份，挂到 to 身上（to 吃两份，from 吃零）
  if (m.pendingGraft) {
    const holder = m.pendingGraft.holder;
    // 注意：pendingAnswers 是按座位分桶的，要先取持有者那一桶
    const bag = (room.pendingAnswers || {})[holder] || {};
    const from = Number(bag[`graft_from_${holder}`]);
    const to = Number(bag[`graft_to_${holder}`]);
    const pre = snapStats(m);
    const ev = applyGraftedTianji(m,
      Number.isInteger(from) && Number.isInteger(to) ? { from, to } : null);
    addChanges(room, pre);
    room.lastEvents = [...(room.lastEvents || []), ...ev];
  }
  room.turnPrompts = [];
  room.pendingAnswers = {};
  beginChoose(room);
}

function beginChoose(room) {
  const m = room.match;
  room.phase = "choose";
  // R50 暗选期信息隔离：先给"对外信息"拍一张快照。
  // 从此刻到全员出完为止，别人看到的血量 / 能量 / 道牌数 / 装备 / 术集一律用这张快照，
  // 否则对面可以从你装卸神装、兑换血能导致的数字跳动里反推出你要出什么牌。
  // 自己的视角永远实时（见 snapshotFor 里的 freezePublic）。
  room.publicFrozen = viewFor(m, -1, {});
  setTimer(room, PHASE_MS.choose, () => resolveTurnNow(room, true));

  // 人机先落子（同时暗选，先手不影响公平）
  for (const p of m.players) {
    if (!p.alive || !room.seats[p.seat]) continue;
    if (room.seats[p.seat].kind !== "ai") continue;
    const c = chooseAction(m, p);
    room.turnActs[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
    if (c.freeOps && c.freeOps.length) room.freeOps[p.seat] = c.freeOps;
  }
  emitRoom(room);
  maybeResolve(room);
}

// R55 神装：装载 / 卸下。独立消息，不走 submitPlay —— 手牌区里的小按钮直接发。
// 装载要消耗本回合的道牌使用名额（等于本回合已经出过道牌了），卸下不占名额。
export function submitEquip(room, connId, op) {
  const m = room.match;
  if (!m) return "对局未开始";
  if (room.phase !== "choose") return "只能在出牌阶段装卸神装";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const seat = s.seat;

  const daoId = String(op?.daoId || "");
  const on = op?.op === "equip";
  const err = setEquipState(m, seat, daoId, on);
  if (err) return err;

  if (on) {
    // 装载占用本回合的道牌名额
    if (room.turnActs[seat]?.daoId) {
      setEquipState(m, seat, daoId, false);        // 回滚，别留下半装状态
      return "本回合已经打出过道牌，不能再装载";
    }
    room.daoQuotaUsed[seat] = true;
  }
  // 装卸会改手牌，人机的落子与自己的可出集合都要跟着变
  for (const p of m.players) {
    if (!p.alive || room.seats[p.seat]?.kind !== "ai") continue;
    if (room.turnActs[p.seat]) continue;
    const c = chooseAction(m, p);
    room.turnActs[p.seat] = { cardId: c.cardId, daoId: c.daoId || null, craft: c.craft || null };
  }
  emitRoom(room);
  return null;
}

// 玩家提交出牌
// R74：身世天赋的实时操作（平民子弟 1 血 ↔ 2 能量；杏林 2 能量 → 治疗牌）
//
// 和出牌是**两条独立通道**：点一下立刻改一次，可以反复点、来回换。
// 关键约束（用户明确）：
//   · 血换能时血量不能掉到 0（引擎里挡）；
//   · 换完能量后"可用的术"必须立刻重算 —— 因为改动发生在提交之前，
//     下一次快照里的 playable / cost 自然是新能量的结果；
//   · **换完要作废已经预选的牌**，否则会出现"先选好一张 4 费牌、再把能量换成血，
//     然后这张牌其实付不起却被提交"的错位。所以这里 delete turnActs[seat]。
export function submitConvert(room, connId, op) {
  if (room.phase !== "choose") return "只能在出牌阶段转换";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const m = room.match;
  const p = m.players[s.seat];
  if (!p || !p.alive) return "你已被淘汰";
  const r = applyFreeOp(m, s.seat, op);
  if (!r.ok) return r.msg || "现在不能这么做";
  // 预选作废：让玩家用新的血/能重新选一次
  delete room.turnActs[s.seat];
  room.convertCount = room.convertCount || {};
  room.convertCount[s.seat] = (room.convertCount[s.seat] || 0) + 1;
  // 只广播状态；每个人的快照各自过 freezePublic，别人看到的是回合开始时的旧数字
  emitRoom(room);
  return null;
}

export function submitPlay(room, connId, act) {
  const m = room.match;
  if (!m) return "对局未开始";
  if (room.phase !== "choose") return "现在不是出牌阶段";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const p = m.players[s.seat];
  if (!p || !p.alive) return "你已被淘汰";
  if (room.turnActs[s.seat]) return "本回合已提交";

  const cardId = String(act.cardId || "");
  const legal = playableCards(m, p).filter((id) => costFor(m, p, id) <= p.energy);
  if (!legal.includes(cardId)) return "这张牌不能出";

  const entry = { cardId, daoId: null, craft: null };
  if (act.daoId) {
    if (!p.hand.includes(act.daoId)) return "没有这张道牌";
    if (D.cardById(act.daoId)?.category === "神装牌") return "神装需装备，不能当道牌打出";
    // R60：天地哀鸣「术套系内术与道牌失效，仅基础术生效」
    if (m.buffs.onlyBasicTurns > 0) return "天地哀鸣生效中：本回合道牌失效，只能打基础术";
    // R55：装载神装也算用掉了本回合的道牌名额，两者不能同时
    if (room.daoQuotaUsed[s.seat]) return "本回合的道牌名额已经用在装载神装上了";
    entry.daoId = act.daoId;
  }
  if (act.craft && typeof act.craft.delta === "number") {
    entry.craft = { delta: Math.round(act.craft.delta), patch: !!act.craft.patch };
  }
  if (Array.isArray(act.freeOps) && act.freeOps.length) {
    const allowed = new Set(
      (D.atomsOf(p.birth) || []).map((a) => a.atom)
    );
    const ok = act.freeOps.filter((op) =>
      (op.op === "convertToHp" || op.op === "convertToEnergy") ? allowed.has("convert")
        : op.op === "buyHeal" ? allowed.has("buyHeal") : false
    );
    if (ok.length) room.freeOps[s.seat] = ok;
  }
  room.turnActs[s.seat] = entry;
  emitRoom(room);
  maybeResolve(room);
}

// 追问的答案（出牌后的 prompt / 天机执行的 tianjiExec 共用）
export function submitAnswers(room, connId, answers) {
  if (room.phase !== "prompt" && room.phase !== "tianjiExec") return "现在不需要选择";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const mine = room.turnPrompts.filter((p) => p.seat === s.seat);
  if (!mine.length) return "你没有要选的东西";
  const bag = {};
  for (const spec of mine) {
    if (answers && answers[spec.id] !== undefined) bag[spec.id] = answers[spec.id];
  }
  room.pendingAnswers[s.seat] = bag;
  const waiting = room.turnPrompts.some(
    (p) => p.seat !== s.seat && room.pendingAnswers[p.seat] === undefined
  );
  if (!waiting) {
    if (room.phase === "tianjiExec") finishTianjiExec(room);
    else resolveWithAnswers(room);
  } else emitRoom(room);
  return null;
}

export function submitBid(room, connId, bid) {
  if (room.phase !== "auction") return "现在不是拍卖";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const p = room.match.players[s.seat];
  if (!p || !p.alive) return "你已被淘汰";
  // 整点出价：上限 = floor(能量/2)，负数 / 小数 / 超额一律夹回 [0, 上限]
  room.bids[s.seat] = normalizeBid(p.energy, bid);
  emitRoom(room);
  maybeSettleAuction(room);
  return null;
}

// 回合末弃牌：玩家自己挑要弃哪些道牌，弃不够也算（按弃的数量算，不强制到底）
export function submitDiscard(room, connId, ids) {
  if (room.phase !== "discard") return "现在不是弃牌阶段";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const p = room.match.players[s.seat];
  if (!p || !p.alive) return "你已被淘汰";
  const need = discardOver(room.match).find((o) => o.seat === s.seat);
  if (!need) return "你不需要弃牌";
  const list = Array.isArray(ids) ? ids.filter((id) => p.hand.includes(id)) : [];
  room.discards[s.seat] = discardCards(room.match, s.seat, list.slice(0, need.over));
  emitRoom(room);
  maybeFinishDiscard(room);
  return null;
}

// 终局后回到大厅（保留座位与配置），方便连打第二场
export function backToLobby(room, connId) {
  if (connId !== room.hostId) return "只有房主能重开";
  if (room.phase !== "matchOver") return "对局还没结束";
  clearTimer(room);
  room.match = null;
  room.phase = "lobby";
  room.lastEvents = [];
  room.roundSummary = null;
  room.tianjiLog = [];
  room.turnChanges = [];
  room.turnActs = {};
  for (const s of room.seats) {
    if (s.kind === "human" && !s.connected) {
      s.kind = "empty"; s.name = "空位"; s.clientId = null; s.token = null;
    }
  }
  return null;
}

export function hostNext(room, connId) {
  if (connId !== room.hostId) return "只有房主能推进";
  if (room.phase === "reveal") { clearTimer(room); startTurn(room); return null; }
  if (room.phase === "roundEnd") { clearTimer(room); nextRound(room); return null; }
  return null;
}

function maybeResolve(room) {
  const m = room.match;
  const waiting = m.players.filter(
    (p) => p.alive && room.seats[p.seat] && room.seats[p.seat].kind === "human" && !room.turnActs[p.seat]
  );
  if (!waiting.length) {
    clearTimer(room);
    resolveTurnNow(room, false);
  }
}

// timeout = 有人超时：未提交者默认 进阶防御，能量不足则 普通防御
function resolveTurnNow(room, timeout) {
  const m = room.match;
  if (room.phase !== "choose") return;
  const fallback = (p) => (p.energy >= costFor(m, p, "base_11") ? "base_11" : "base_10");
  for (const p of m.players) {
    if (!p.alive) continue;
    if (room.turnActs[p.seat]) continue;
    const s = room.seats[p.seat];
    if (!s) continue;
    if (s.kind === "ai") {
      const c = chooseAction(m, p);
      room.turnActs[p.seat] = { cardId: c.cardId, daoId: c.daoId || null };
    } else {
      room.turnActs[p.seat] = { cardId: fallback(p), daoId: null, timedOut: true };
    }
  }

  const actionable = collectPrompts(m, room.turnActs, { freeOps: room.freeOps });
  const humanPrompts = actionable.filter((x) => {
    const s = room.seats[x.seat];
    return s && s.kind === "human" && m.players[x.seat].alive;
  });

  if (humanPrompts.length) {
    room.phase = "prompt";
    room.turnPrompts = humanPrompts;
    room.pendingAnswers = {};
    setTimer(room, PHASE_MS.prompt, () => resolveWithAnswers(room));
    emitRoom(room);
    return;
  }
  resolveWithAnswers(room);
}

function resolveWithAnswers(room) {
  const m = room.match;
  clearTimer(room);

  const answers = room.pendingAnswers || {};
  const pre = snapStats(m);
  // R77：先抄下"每人带的那张道牌" —— 引擎在 onlyBasic（返璞归真）下会把 a.daoId 置空，
  // 结算后再读就只能看到"没带道牌"，事件记录里也就少了一句"道 · 焚术"。
  const daoSnap = {};
  for (const [seatStr, a] of Object.entries(room.turnActs || {})) daoSnap[seatStr] = a?.daoId || null;
  const ev = resolveTurn(m, room.turnActs, { freeOps: room.freeOps, answers });
  addChanges(room, pre);

  // 展示区需要「谁打了什么」——属于揭示信息，结算后一并下发
  for (const [seatStr, a] of Object.entries(room.turnActs)) {
    const seat = Number(seatStr);
    const c = D.cardById(a.cardId);
    if (!c) continue;
    const value = c.type === "攻术" ? fmt(toU(c.atk ?? 0)) : c.type === "御术" ? fmt(toU(c.def ?? 0)) : "";
    const daoId = daoSnap[seatStr] || null;
    ev.push({
      t: "play", seat, cardId: a.cardId, name: c.name, value, timedOut: !!a.timedOut,
      daoId, daoName: daoId ? (D.cardById(daoId)?.name || daoId) : null,
      daoVoid: !!daoId && ev.some((x) => x.t === "daoVoid" && x.seat === seat),
    });
  }
  room.lastEvents = ev;
  room.turnActs = {};
  room.freeOps = {};
  room.daoQuotaUsed = {};
  room.turnPrompts = [];
  room.pendingAnswers = {};
  room.publicFrozen = null;             // R50：结算完就解冻，对外信息恢复实时

  if (m.roundOver) return finishRound(room, ev);
  startDiscard(room, ev);
}

// ---------- 回合末弃牌判断（R11 修订：道牌上限 = 血量上限） ----------

function startDiscard(room, ev = []) {
  const m = room.match;
  room.discards = {};
  const over = discardOver(m);
  room.lastEvents = ev;

  if (!over.length) {
    room.phase = "reveal";
    setTimer(room, PHASE_MS.reveal, () => startTurn(room));
    emitRoom(room, ev);
    return;
  }

  room.phase = "discard";
  // 人机直接弃，不等窗口
  for (const o of over) {
    if (room.seats[o.seat]?.kind === "ai") room.discards[o.seat] = autoDiscard(m, o.seat);
  }
  setTimer(room, PHASE_MS.discard, () => finishDiscard(room));
  emitRoom(room, ev);
  maybeFinishDiscard(room);
}

function maybeFinishDiscard(room) {
  const pend = discardOver(room.match).filter((o) => room.discards[o.seat] === undefined);
  if (!pend.length) finishDiscard(room);
}

function finishDiscard(room) {
  if (room.phase !== "discard") return;
  const m = room.match;
  // 超时 / 没选的人由引擎兜底随机弃
  for (const o of discardOver(m)) {
    if (room.discards[o.seat] === undefined) room.discards[o.seat] = autoDiscard(m, o.seat);
  }
  const dev = [];
  for (const [seatStr, ids] of Object.entries(room.discards)) {
    if (!ids || !ids.length) continue;
    dev.push({
      t: "discard", seat: Number(seatStr),
      names: ids.map((id) => D.cardById(id)?.name || id),
    });
  }
  const merged = [...(room.lastEvents || []), ...dev];
  room.lastEvents = merged;
  room.discards = {};
  room.phase = "reveal";
  setTimer(room, PHASE_MS.reveal, () => startTurn(room));
  emitRoom(room, merged);
}

function startAuction(room, ev, offerId = null) {
  const m = room.match;
  room.phase = "auction";
  room.bids = {};
  room.offerId = offerId || peekAuction(m);   // peek 会动 rng，拍品只抽一次然后传进来
  for (const p of m.players) {
    if (!p.alive || room.seats[p.seat]?.kind !== "ai") continue;
    room.bids[p.seat] = bidFor(m, p, room.offerId);
  }
  setTimer(room, PHASE_MS.auction, () => settleAuction(room));
  emitRoom(room, ev);
  maybeSettleAuction(room);
}

function maybeSettleAuction(room) {
  const m = room.match;
  const waiting = m.players.filter(
    (p) => p.alive && room.seats[p.seat]?.kind === "human" && room.bids[p.seat] === undefined
  );
  if (!waiting.length) settleAuction(room);
}

function settleAuction(room) {
  if (room.phase !== "auction") return;
  const m = room.match;
  const pre = snapStats(m);                     // 拍卖会扣能量
  const ev = auctionIfDue(m, { offerId: room.offerId, bids: room.bids });
  addChanges(room, pre);
  const merged = [...(room.lastEvents || []), ...ev];
  room.lastEvents = merged;
  // R67：拍卖结完先公示 3 秒（所有人的出价 + 结果），再进事件记录、开回合
  room.auctionOutcome = summarizeAuction(ev, room);
  room.phase = "auctionResult";
  // R77：回到本回合时带上 resumeAuction —— 回合数已经推过了，别再推第二次
  setTimer(room, PHASE_MS.auctionResult, () => startTurn(room, { resumeAuction: true }));
  emitRoom(room, merged);
}

// 把拍卖事件收敛成一块可直接渲染的数据：拍品 / 每人出价 / 成交结果
function summarizeAuction(ev = [], room) {
  const m = room.match;
  const offer = ev.find((e) => e.t === "auction");
  const result = ev.find((e) => e.t === "auctionResult");
  const short = ev.find((e) => e.t === "auctionShort");
  const wins = ev.filter((e) => e.t === "auctionWin");
  const bids = (result?.bids || []).map((b) => ({
    seat: b.seat, bid: b.bid, name: m.players[b.seat]?.name || `座位${b.seat + 1}`,
  }));
  return {
    offerId: offer?.cardId || room.offerId || null,
    name: offer?.name || "",
    category: offer?.category || "",
    text: offer?.text || "",
    turn: m.turn,
    bids,
    winners: wins.map((w) => ({ seat: w.seat, bid: w.bid })),
    price: wins.length ? wins[0].bid : 0,
    reason: result?.kind === "unsold" ? (result.reason || "noBid") : "sold",
    copies: short?.copies || 0,
  };
}

export function finishRound(room, ev = []) {   // 导出给测试用：局末 -> 轮抽是易漏的衔接
  const m = room.match;
  let ranked;
  // R72：autoDraft=false -> endRound 只建轮抽、不派发，由下面逐个势力问
  try { ranked = endRound(m, { autoDraft: false }); } catch (e) { ranked = []; console.error("[room] endRound", e); }
  // R75：胜者免债 —— 记一条事件（endRound 只算账，不发事件）
  for (const f of (m.debtForgiven || [])) ev.push({ t: "debtForgive", ...f });

  room.roundSummary = ranked.map((r, i) => ({
    rank: i + 1,
    factionId: r.f.id,
    members: r.f.members,
    survived: r.survived,
    score: r.f.lastRoundScore ?? 0,
    total: r.f.score,
  }));

  if (m.matchOver) {
    room.phase = "matchOver";
    room.deadline = 0;
    emitRoom(room, ev);
    return;
  }
  room.phase = "roundEnd";
  setTimer(room, PHASE_MS.roundEnd, () => advanceSetDraft(room));
  emitRoom(room, ev);
}

// ---------- 局末术系轮抽（R72）----------
//
// 顺序由引擎算好（淘汰越早越先挑）。这里只负责：轮到谁、问人还是替人机随机、
// 超时兜底、以及把每次挑选变成一条事件。

function factionOf(room, factionId) {
  return room.match.factions.find((f) => f.id === factionId) || null;
}

// R73：这个势力由谁来决定 —— 引擎在 makeSetDraft 里已经算好"最后被淘汰的那名成员"
// （同势力多人同时淘汰则随机挑一个），这里只取结果，不再按"谁是真人"去挑人。
function repSeatForDraft(room, factionId) {
  const f = factionOf(room, factionId);
  if (!f) return -1;
  return room.match.setDraft?.info?.[factionId]?.rep ?? f.members[0];
}

function draftEvent(room, pick) {
  const m = room.match;
  const set = pick.setId ? D.setById(pick.setId) : null;
  return {
    t: "setDraft",
    factionId: pick.factionId,
    seat: pick.seat,
    members: pick.members,
    setId: pick.setId,
    name: set?.name || "",
    note: pick.note,
    // 剩余池子：让日志能看出"还剩几套"
    left: (m.setDraft?.pool || []).length,
    names: pick.members.map((s) => m.players[s]?.name || `座位${s + 1}`),
  };
}

function advanceSetDraft(room, ev = []) {
  clearTimer(room);
  const m = room.match;
  for (let guard = 0; guard < 32; guard += 1) {
    const fid = nextDraftFaction(m);
    if (fid === null) return finishSetDraft(room, ev);   // 势力 id 可能是 0，别用 !fid
    const seat = repSeatForDraft(room, fid);
    if (room.seats[seat]?.kind === "human") {
      room.phase = "setDraft";
      room.draftTurn = { factionId: fid, seat };
      setTimer(room, PHASE_MS.setDraft, () => {
        const r = applySetPick(m, fid, null);          // 超时 -> 随机
        room.draftTurn = null;
        advanceSetDraft(room, r ? [draftEvent(room, r)] : []);
      });
      emitRoom(room, ev);
      return undefined;
    }
    const r = applySetPick(m, fid, null);
    if (!r) return finishSetDraft(room, ev);
    ev.push(draftEvent(room, r));
  }
  return finishSetDraft(room, ev);
}

function finishSetDraft(room, ev = []) {
  clearTimer(room);
  room.draftTurn = null;
  const m = room.match;
  ev.push({ t: "setDraftEnd", total: m.setDraft?.picks?.length || 0 });
  room.phase = "setDraftEnd";
  emitRoom(room, ev);
  setTimer(room, PHASE_MS.setDraftEnd, () => nextRound(room));
}

// 玩家点选：只有"轮到你所属势力"时才有效
export function submitSetDraft(room, connId, setId) {
  if (room.phase !== "setDraft") return "现在不是术系轮抽阶段";
  const s = room.seats.find((x) => x.clientId === connId);
  if (!s) return "你不在本局中";
  const t = room.draftTurn;
  if (!t) return "还没轮到挑选";
  const f = factionOf(room, t.factionId);
  if (!f || !f.members.includes(s.seat)) return "现在不是你们势力在挑";
  // R73：同势力里只有「代表」（最后被淘汰的那位）能点，队友不能替他决定
  if (s.seat !== t.seat) return "本局由你们队里最后被淘汰的成员决定";
  const m = room.match;
  if (!(m.setDraft?.pool || []).includes(setId)) return "这一套已经被挑走了";
  const r = applySetPick(m, t.factionId, setId);
  if (!r) return "这一套现在挑不了";
  room.draftTurn = null;
  advanceSetDraft(room, [draftEvent(room, r)]);
  return null;
}

export function nextRound(room) {   // 导出给测试用：局间推进是最容易漏的阶段
  clearTimer(room);
  const m = room.match;
  if (m.matchOver) { room.phase = "matchOver"; emitRoom(room); return; }
  // R71：局与局之间必须走**同一条局初流程**。
  // 原来这里直接 startRound(m)，绕过了 beginRound() ——
  // 而官宦子弟挑术系（setup）恰恰在 beginRound() 里，
  // 结果第 2 局起只会静默随机发一套，玩家永远看不到选择界面。
  // 先把 phase 摆到 starting：没人是官宦子弟时 finishSetup 的阶段白名单才放行。
  room.phase = "starting";
  beginRound(room);
}

// ---------- 视图与广播 ----------

function lobbySnapshot(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    config: { ...room.config, players: totalSeats(room.config) },
    seats: room.seats.map((s) => ({
      seat: s.seat,
      factionId: s.factionId,
      kind: s.kind,
      name: s.name,
      connected: !!s.connected,
      isHost: s.clientId === room.hostId,
    })),
    watchers: room.watch.size,
  };
}

function seatOf(room, connId) {
  const s = room.seats.find((x) => x.clientId === connId);
  return s ? s.seat : -1;
}

export function snapshotFor(room, connId) {
  const seat = seatOf(room, connId);
  const amHost = room.hostId === connId;
  const base = { t: "room", room: lobbySnapshot(room), you: seat, amHost };
  if (room.phase === "lobby" || room.phase === "starting" || !room.match) return base;

  const m = room.match;
  const view = freezePublic(viewFor(m, seat, { events: room.lastEvents }), room, seat);
  return {
    ...base,
    t: "view",
    amHost,
    seat,
    phase: room.phase,
    deadline: room.deadline || 0,
    serverNow: Date.now(),
    view,
    submitted: m.players.filter((p) => room.turnActs?.[p.seat]).map((p) => p.seat),
    waiting: waitingSeats(room),
    tianjiLog: room.tianjiLog || [],
    // R44：挂起的窥天 / 协同天机，供前端在执行前窗口里显示"谁要做什么"
    pendingTianji: m.pendingTianji ? { name: m.pendingTianji.name } : null,
    pendingGraft: m.pendingGraft
      ? { name: m.pendingGraft.name, holder: m.pendingGraft.holder } : null,
    changes: changesForView(room),
    prompts: ["prompt", "tianjiExec"].includes(room.phase)
      ? room.turnPrompts.filter((p) => p.seat === seat) : [],
    answered: seat >= 0 && room.pendingAnswers ? room.pendingAnswers[seat] !== undefined : false,
    // R67：拍卖结果公示期的数据（所有人的出价 + 成交结果）
    auctionResult: room.phase === "auctionResult" ? room.auctionOutcome : null,
    // R72：局初官宦子弟「同时随机抽取」的结果，公示 3 秒
    tempDraw: room.phase === "tempDraw" ? (room.tempDraw || []) : [],
    // R72：局末术系轮抽 —— 顺序 / 剩余池子 / 轮到谁
    setDraft: ["setDraft", "setDraftEnd"].includes(room.phase) ? draftStateOf(m) : null,
    draftTurn: room.phase === "setDraft" && room.draftTurn ? {
      factionId: room.draftTurn.factionId,
      seat: room.draftTurn.seat,        // 代表（最后被淘汰的那位）
      mine: seat >= 0 && (factionOf(room, room.draftTurn.factionId)?.members || []).includes(seat),
      youPick: seat >= 0 && seat === room.draftTurn.seat,   // R73：只有代表能点
    } : null,
    convertCount: seat >= 0 ? (room.convertCount?.[seat] || 0) : 0,   // R74：本回合转换次数
    bid: seat >= 0 && room.bids ? room.bids[seat] : undefined,
    // R55：本回合的道牌名额是否已用掉（装载神装也算）
    daoQuotaUsed: seat >= 0 ? !!room.daoQuotaUsed?.[seat] : false,
    roundSummary: room.roundSummary,
    watch: seat < 0,
  };
}

// R50：暗选期把「别人」的可变字段换成回合开始时的快照；自己那一栏永远实时。
// 观战视角（seat < 0）本来就没有任何私有信息，也一并冻结，避免观战者泄漏给同桌玩家。
function freezePublic(view, room, mySeat) {
  const f = room.publicFrozen;
  if (!f) return view;
  const bySeat = new Map((f.players || []).map((p) => [p.seat, p]));
  return {
    ...view,
    players: (view.players || []).map((p) => {
      if (p.seat === mySeat && mySeat >= 0) return p;      // 自己：实时
      const old = bySeat.get(p.seat);
      if (!old) return p;
      return {
        ...p,
        hp: old.hp, maxHp: old.maxHp, energy: old.energy,
        handCount: old.handCount, equip: old.equip, equipCount: old.equipCount,
        sets: old.sets, setCount: old.setCount,
      };
    }),
  };
}

function emitRoom(room) {
  if (process.env.XD_LOG) {
    console.log(`[room ${room.id}] phase=${room.phase} turn=${room.match?.turn} round=${room.match?.roundIndex} timer=${!!room.timer}`);
  }
  broadcast(room);
}

export const roomCount = () => rooms.size;

export function broadcast(room, _ev) {
  const seen = new Set();
  for (const [, conn] of room.conns) {
    if (seen.has(conn.id)) continue;
    seen.add(conn.id);
    try {
      conn.send(snapshotFor(room, conn.id));
    } catch (e) {
      // 静默失败会让"某个玩家永远收不到更新"，非常难查 —— 这里必须出声
      console.error(`[broadcast] 座位 ${seatOf(room, conn.id)} 发送失败:`, e && e.message);
    }
  }
}

// 当前阶段还在等谁：客户端据此显示"等待 XX"，也避免误发指令
function waitingSeats(room) {
  const m = room.match;
  if (!m) return [];
  switch (room.phase) {
    case "births":
      return room.seats
        .filter((s) => s.kind === "human" && !room.birthAcks?.[s.seat])
        .map((s) => s.seat);
    case "setDraft":
      return room.draftTurn && room.seats[room.draftTurn.seat]?.kind === "human"
        ? [room.draftTurn.seat] : [];
    case "tempDraw":
      return [];
    case "tianjiExec":
      return room.turnPrompts
        .filter((x) => room.pendingAnswers?.[x.seat] === undefined)
        .map((x) => x.seat);
    case "choose":
      return m.players
        .filter((p) => p.alive && room.seats[p.seat]?.kind === "human" && !room.turnActs?.[p.seat])
        .map((p) => p.seat);
    case "prompt":
      return [...new Set(room.turnPrompts.map((x) => x.seat))]
        .filter((s) => room.pendingAnswers?.[s] === undefined);
    case "auction":
      return m.players
        .filter((p) => p.alive && room.seats[p.seat]?.kind === "human" && room.bids?.[p.seat] === undefined)
        .map((p) => p.seat);
    case "discard":
      return discardOver(m)
        .filter((o) => room.discards?.[o.seat] === undefined)
        .map((o) => o.seat);
    default:
      return [];
  }
}

export function send(conn, obj) {
  try { conn.send(obj); } catch { /* ignore */ }
}

// ---------- 定时器 ----------

// R83：房间里一个人都没有时，阶段计时器要**挂起**而不是继续跑 ——
// 否则四个人都退出后，AI 会自己把整局打完，回来看到的是一个已经结束的对局。
function setTimer(room, ms, fn) {
  clearTimer(room);
  room.pendingFn = fn;
  room.pendingMs = ms;
  room.deadline = Date.now() + ms;
  if (room.conns.size === 0) return;          // 无人：先存着，等人回来再续
  room.timer = setTimeout(() => {
    room.timer = null;
    const f = room.pendingFn;
    room.pendingFn = null;
    try { f && f(); } catch (e) { console.error("[room] timer", room.id, e); }
  }, ms);
  if (room.timer.unref) room.timer.unref();
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.pendingFn = null;
  room.pendingMs = 0;
}

// 有人回来了：把挂起的阶段重新排上（按原时长，不按"已经过了多久"补跑）
function resumeTimer(room) {
  if (room.timer || !room.pendingFn) return;
  const ms = room.pendingMs || 3000;
  setTimer(room, Math.max(200, ms), room.pendingFn);
}

// ---------- 房间号 ----------

function newRoomId() {
  for (let i = 0; i < 200; i++) {
    const id = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(id)) return id;
  }
  throw new Error("房间号耗尽");
}

// 定期清理：只清"连续 30 分钟没人"的房间（有人的房间不因为活得久被销毁）
export function sweepRooms(now = Date.now()) {
  for (const [, room] of rooms) {
    if (room.conns.size > 0) { room.emptySince = 0; continue; }
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > EMPTY_ROOM_TTL) destroyRoom(room);
  }
}

setInterval(() => sweepRooms(), 60_000).unref?.();
