// 用真页面渲染一块「博弈过程卡」，确认排版与配色（不依赖真的抽到囚徒）。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-sd2-"));
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
  if (r.result?.exceptionDetails) console.error("页面异常:", JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

(async () => {
  await connect();
  await sleep(1800);
  // 1v1：自己 + 1 个人机，非 FAST —— 轮抽会等真人 12 秒，足够截图
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 2, per: 1 }); await s(400);
    A.send({ t: "addAI", seat: 1 }); await s(200);
    A.send({ t: "start" });
    return "ok";
  `);

  let hit = false;
  for (let k = 0; k < 900; k++) {
    const st = await run(`
      const A = window.__XD_ONLINE__;
      const st = A.state();
      if (!st) return "none";
      if (st.phase === "births") { A.send({ t: "birthAck" }); return "births"; }
      if (st.phase === "tempDraw") return "tempDraw";
      if (st.phase === "setDraft") return "setDraft";
      if (st.phase === "choose" && (st.waiting || []).includes(st.seat)) {
        const list = st.view?.me?.playable || [];
        if (list.length) A.play(list[Math.floor(Math.random() * list.length)].id);
        else A.play("base_01");
        return "choose";
      }
      if ((st.phase === "prompt" || st.phase === "tianjiExec") && (st.prompts || []).length && !st.answered) {
        A.send({ t: "answers", answers: {} });
        return "prompt";
      }
      if (st.phase === "auction" && st.bid === undefined && st.view?.me?.canAct) { A.bid(0); return "auction"; }
      if (st.phase === "discard" && st.view?.me?.discard?.over) { A.send({ t: "discard", ids: [] }); return "discard"; }
      return st.phase;
    `);
    if (st === "setDraft") { hit = true; break; }
    if (st === "matchOver") break;
    await sleep(120);
  }
  console.log("到达术系轮抽：", hit);
  await sleep(500);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const f = path.join(OUT, "22-set-draft-live.png");
  fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
  console.log("saved", f);
  chrome.kill(); srv.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
