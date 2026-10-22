// 联机 E2E：起一个真实服务进程，用 N 个真实 WebSocket 客户端打完整场。
//
//   node server/e2e.mjs [人数] [每势力人数]
//
// 它刻意不复用服务端内部函数 —— 全部走协议，这样才验证到"客户端能不能真的玩完一局"。
import { spawn } from "node:child_process";
import * as D from "../src/data.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8899 + Math.floor(Math.random() * 90);
const PLAYERS = Number(process.argv[2] || 4);
const PER = Number(process.argv[3] || 1);
const FACTIONS = Math.ceil(PLAYERS / PER);
const AI_FILL = process.env.AI_FILL === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seenPhases = new Set();

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => { if (process.env.VERBOSE) process.stdout.write("[srv] " + b); });
  child.stderr.on("data", (b) => process.stderr.write("[srv:err] " + b));
  return child;
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("服务未启动");
}

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { name, ws, state: null, seat: -1, roomId: null, inFlight: false, errors: [], last: null };
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === "error") { c.errors.push(msg.msg); return; }
    if (msg.t === "hello") { if (msg.seat != null) c.seat = msg.seat; if (msg.roomId) c.roomId = msg.roomId; return; }
    if (msg.t === "room" || msg.t === "view") c.state = msg;
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  return new Promise((res) => {
    ws.addEventListener("open", () => res(c));
  });
}

const answerFor = (p) => {
  switch (p.type) {
    case "target": return p.pool?.[0] ?? null;
    case "targets": return (p.pool || []).slice(0, p.count || 2);
    case "card": return p.pool?.[0] ?? null;
    case "allocate": return { attack: 0, heal: 0, defense: p.total || 0 };
    case "branch": return p.options?.[0] ?? null;
    default: return p.options?.[0] ?? null;
  }
};

// 每个客户端的主循环：服务端说"在等你"，就出手
async function drive(c) {
  let sentKey = "";
  for (let guard = 0; guard < 6000; guard++) {
    const st = c.state;
    if (process.env.DBG && guard % 30 === 0) {
      console.log("  [" + c.name + "]", st ? (st.t + ":" + (st.phase || st.room?.phase)) : "null",
        st && st.view ? "t" + st.view.turn : "",
        "wait=" + JSON.stringify(st && st.waiting),
        "err=" + c.errors.slice(-1).join(""));
    }
    if (!st) { await sleep(30); continue; }
    const phase = st.phase || st.room?.phase;
    if (phase) seenPhases.add(phase);
    if (phase === "matchOver") return "matchOver";

    if (st.t === "view" && st.seat >= 0) {
      const view = st.view;
      const me = view.me;
      const waiting = st.waiting || [];
      const key = `${view.round}-${view.turn}-${st.phase}-${st.seat}`;
      const act = waiting.includes(st.seat) && sentKey !== key;

      if (act && st.phase === "choose" && me?.canAct) {
        const legal = me.playable;
        const pick = legal[Math.floor(Math.random() * legal.length)];
        if (pick) {
          sentKey = key;
          const hand = (me.hand || []).filter((id) => D.cardById(id)?.category !== "神装牌");
          c.send({ t: "play", cardId: pick.id, daoId: Math.random() < 0.2 ? hand[0] : null });
        }
      } else if (act && (st.phase === "prompt" || st.phase === "tianjiExec") && st.prompts?.length) {
        sentKey = key;
        const answers = {};
        for (const p of st.prompts) answers[p.id] = answerFor(p);
        c.send({ t: "answers", answers });
      } else if (act && st.phase === "auction") {
        sentKey = key;
        c.send({ t: "bid", bid: Math.floor(Math.random() * 4) });
      } else if (act && st.phase === "births") {
        sentKey = key;                                   // R51 开场：确认身世
        c.send({ t: "birthAck" });
      } else if (act && st.phase === "setDraft" && st.draftTurn?.youPick) {
        sentKey = key;                                   // R72 局末：术系轮抽
        const pool = st.setDraft?.pool || [];
        c.send({ t: "setDraft", setId: pool.length ? pool[Math.floor(Math.random() * pool.length)] : null });
      }
    }
    await sleep(35);
  }
  return "timeout";
}

async function main() {
  const srv = startServer();
  try {
    await waitHealthy();
    console.log(`服务已启动 :${PORT}　配置：${PLAYERS} 人 / 每势力 ${PER} 人 / ${FACTIONS} 势力`);

    const host = await client("房主");
    host.send({ t: "create", name: "房主", factions: FACTIONS, per: PER });
    await sleep(200);
    if (!host.roomId) throw new Error("建房失败：" + host.errors.join(" / "));
    console.log(`房号 ${host.roomId}　房主座位 ${host.seat}`);

    const clients = [host];
    for (let i = 1; i < PLAYERS; i++) {
      const c = await client(`玩家${i + 1}`);
      c.send({ t: "join", roomId: host.roomId, name: `玩家${i + 1}` });
      await sleep(120);
      if (c.seat < 0) throw new Error(`玩家${i + 1} 入座失败：` + c.errors.join(" / "));
      clients.push(c);
    }
    console.log("入座：", clients.map((c) => `${c.name}#${c.seat}`).join(" "));

    if (AI_FILL) {
      // 改配置后补人机：先缩小到 2 人，再补满
      host.send({ t: "addAI", seat: PLAYERS > 2 ? 2 : 1 });
      await sleep(120);
    }

    host.send({ t: "start" });
    await sleep(300);
    if (host.errors.length) throw new Error("开局失败：" + host.errors.join(" / "));

    const results = await Promise.all(clients.map((c) => drive(c)));
    console.log("各客户端结束原因：", results.join(" / "));

    const st = host.state;
    const view = st.view || null;
    const phase = st.phase || st.room?.phase;
    console.log(`最终阶段：${phase}　回合：${view?.turn ?? "-"}　局：${(view?.round ?? 0) + 1}`);
    if (view) {
      console.log("终局血量：", view.players.map((p) => `${p.name} ${p.hp}/${p.maxHp}`).join("  "));
    }
    const allErrors = clients.flatMap((c) => c.errors);
    if (allErrors.length) console.log("协议错误（", allErrors.length, "）：", [...new Set(allErrors)].slice(0, 6).join(" / "));

    if (phase !== "matchOver") {
      console.error("未打到终局");
      process.exitCode = 1;
    } else {
      console.log("走过阶段：", [...seenPhases].join(" / "));
console.log("E2E 通过：4 局全部打完");
    }
  } finally {
    srv.kill();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
