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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-sg-"));
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
  const out = await run(`
    const R = await import("./render.mjs");
    const names = ["青岚", "人机2", "人机3", "人机4"];
    const events = [
      { t: "subgame", kind: "prisoner",
        picks: [[1, "认罪"], [2, "不认罪"]],
        outcome: "人机2 认罪 +2 能量，其余各被罚 4 能量（能量不够用血抵）",
        delta: [{ seat: 1, hp: "0", energy: "2" }, { seat: 2, hp: "-1", energy: "-3" }],
        by: 0, byGain: "2" },
      { t: "subgame", kind: "chicken",
        picks: [[1, "冲"], [2, "让"]],
        outcome: "人机2 冲、对方让：冲者 +2 能量",
        delta: [{ seat: 1, hp: "0", energy: "2" }, { seat: 2, hp: "0", energy: "0" }],
        by: 0 },
    ];
    // 大厅里牌桌是 display:none，先显出来
    document.getElementById("lobby").style.display = "none";
    document.getElementById("table").style.display = "";
    document.body.classList.add("in-game");
    const host = document.querySelector("[data-center]");
    if (!host) return "没有 [data-center]";
    host.innerHTML = R.subgameHtml({}, { names, events });
    return host.querySelectorAll(".sg-card").length + " 张卡";
  `);
  console.log("渲染结果：", out);
  await sleep(400);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const f = path.join(OUT, "20-subgame-card.png");
  fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
  console.log("saved", f);
  chrome.kill(); srv.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
