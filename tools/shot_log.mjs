// 抓「事件记录」面板：拍卖 / 定期回复能量 单独成节 + 回合条目。
// 用法：node tools/shot_log.mjs            （打到第 12 回合截图）
//       TARGET_TURN=8 node tools/shot_log.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "..", "shots");
const PORT = 9060 + Math.floor(Math.random() * 20);
const CDP = 9560 + Math.floor(Math.random() * 20);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET = Number(process.env.TARGET_TURN || 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT), XD_FAST: "1" }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-log-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  `http://127.0.0.1:${PORT}/online.html`,
], { stdio: "ignore" });

let id = 0; const pending = new Map(); let ws;
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, { res });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, no) => { ws.addEventListener("open", ok); ws.addEventListener("error", no); });
        ws.addEventListener("message", (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); }
        });
        await send("Runtime.enable"); await send("Page.enable");
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("连不上 Chrome");
}
const run = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.error("页面异常:", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) { console.error("截图失败:", JSON.stringify(r).slice(0, 200)); return; }
  const f = path.join(OUT, name + ".png");
  fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
  console.log("saved", f);
};

(async () => {
  await connect();
  await sleep(2200);
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(500);
    A.send({ t: "config", factions: 3, per: 1 }); await s(300);
    for (const i of [1,2]) { A.send({ t: "addAI", seat: i }); await s(100); }
    A.send({ t: "start" }); await s(800);
    return 1;
  `);

  // 自动打到目标回合：拍卖出价、追问随便选、出牌挑一张合法的
  const res = await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    window.__TRY = {};
    for (let k = 0; k < 900; k++) {
      const st = A.state();
      if (!st) { await s(120); continue; }
      if (st.phase === "births") { A.send({ t: "birthAck" }); await s(150); continue; }
      if (st.phase === "setDraft" && st.draftTurn?.youPick) { A.send({ t: "setDraft", setId: st.setDraft?.pool?.[0] }); await s(150); continue; }
      if (st.phase === "auction" && st.bid === undefined) { A.send({ t: "bid", bid: 2 }); await s(150); continue; }
      if (["prompt","tianjiExec"].includes(st.phase) && st.prompts?.length && !st.answered) {
        const a = {}; for (const p of st.prompts) a[p.id] = p.type === "target" ? (p.pool||[])[0] : (p.options?.[0] ?? null);
        A.send({ t: "answers", answers: a }); await s(150); continue;
      }
      if (st.phase === "choose" && (st.waiting||[]).includes(st.seat)) {
        const me = st.view.me; const legal = me.playable || [];
        if (legal.length) {
          // 第一次带张道牌（可能被拒，比如它是神装），第二次不带，保证一定能推进
          const n = (window.__TRY[st.view.turn] = (window.__TRY[st.view.turn] || 0) + 1);
          const card = legal[Math.floor(Math.random()*legal.length)].id;
          const hand = (me.hand||[]);
          A.send({ t: "play", cardId: card, daoId: (n === 1 && hand.length) ? hand[0] : null });
        }
        await s(200); continue;
      }
      if (st.phase === "discard" && st.view?.me?.discard) {
        const d = st.view.me.discard;
        A.send({ t: "discard", ids: (st.view.me.hand||[]).slice(0, d.over) });
        await s(150); continue;
      }
      if (st.view?.turn >= ${TARGET} && st.phase === "reveal") return st.view.turn;
      await s(150);
    }
    return -1;
  `);
  console.log("停在回合：", res);

  await run(`
    const p = document.getElementById("panel");
    if (p && p.classList.contains("collapsed")) document.getElementById("panel-toggle").click();
    p.querySelector(".panel-body").scrollTop = 0;
    return 1;
  `);
  await sleep(400);
  await shot("20-log-page");
  chrome.kill(); srv.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
