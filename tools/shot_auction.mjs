// 抓「拍卖结果公示」那一帧。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "..", "shots");
const PORT = 9040 + Math.floor(Math.random() * 20);
const CDP = 9540 + Math.floor(Math.random() * 20);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-auc-"));
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
  await send("Runtime.evaluate", { expression: 'document.getElementById("overlay")?.classList.remove("on"); 1' });
  await sleep(120);
  const r = await send("Page.captureScreenshot", { format: "png" });
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
    A.send({ t: "config", factions: 4, per: 1 }); await s(300);
    for (const i of [1,2,3]) { A.send({ t: "addAI", seat: i }); await s(100); }
    A.send({ t: "start" }); await s(800);
    for (let k = 0; k < 40; k++) {
      const st = A.state();
      if (st?.phase === "births") { A.send({ t: "birthAck" }); await s(300); continue; }
      if (st?.phase === "setDraft" && st.draftTurn?.youPick) { A.send({ t: "setDraft", setId: st.setDraft?.pool?.[0] }); await s(300); continue; }
      break;
    }
    return 1;
  `);

  // 一路打到第 5 回合的拍卖
  const hit = await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    for (let k = 0; k < 1200; k++) {
      const st = A.state();
      if (!st) { await s(150); continue; }
      if (st.phase === "auctionResult") return 1;
      if (st.phase === "auction" && st.bid === undefined) {
        A.send({ t: "bid", bid: 2 }); await s(200); continue;
      }
      if (["prompt","tianjiExec"].includes(st.phase) && st.prompts?.length && !st.answered) {
        const a = {}; for (const p of st.prompts) a[p.id] = p.type === "target" ? (p.pool||[])[0] : (p.options?.[0] ?? null);
        A.send({ t: "answers", answers: a }); await s(200); continue;
      }
      if (st.phase === "choose" && (st.waiting||[]).includes(st.seat)) {
        const me = st.view.me; const legal = me.playable || [];
        if (legal.length) A.send({ t: "play", cardId: legal[Math.floor(Math.random()*legal.length)].id, daoId: null });
        await s(220); continue;
      }
      if (st.phase === "discard" && st.view?.me?.discard) { A.send({ t: "discard", ids: [] }); await s(200); continue; }
      await s(180);
    }
    return 0;
  `);
  console.log("到达拍卖结果阶段：", hit);
  const dom = await run(`return document.querySelector("[data-center]").innerHTML.slice(0, 900);`);
  console.log("中央 DOM：\n", dom);
  const st = await run(`
    const c = document.querySelector(".ar-card");
    if (!c) return "没有 .ar-card";
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), display: cs.display, maxW: cs.maxWidth });
  `);
  console.log("ar-card 尺寸：", st);
  await shot("19-auction-result");
  chrome.kill(); srv.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
