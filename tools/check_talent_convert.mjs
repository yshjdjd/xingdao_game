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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-solo-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  `http://127.0.0.1:${PORT}/index.html`,
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
  // 单机：把身世改成平民子弟，验证"点一次立刻生效、可反复、换完清空预选"
  const r1 = await run(`
    const A = window.__XD_APP__;
    // 单机开局停在 reveal：反复点「下一回合」，遇到拍卖就弃权，直到进入出牌阶段
    for (let k = 0; k < 8; k++) {
      if (A.state().phase === "choose") break;
      const bid = document.querySelector("[data-bid='0']");
      if (bid) { bid.click(); await new Promise(r => setTimeout(r, 250)); continue; }
      const nx = document.getElementById("btn-next");
      if (!nx || nx.disabled) break;
      nx.click();
      await new Promise(r => setTimeout(r, 350));
    }
    await new Promise(r => setTimeout(r, 300));
    const m = A.match();
    const me = m.players[0];
    me.birth = "birth_06";                 // 平民子弟
    me.maxHp = 6; me.hp = 6; me.energy = 0;
    // 先看第 1 回合：天赋按钮应该是灰的（R76：第 3 回合起才可用）
    m.turn = 1;
    A.pickShu("base_01");
    await new Promise(r => setTimeout(r, 120));
    const early = [...document.querySelectorAll(".talent-inline [data-op]")].map(b => b.disabled);
    m.turn = 4;                            // 推到第 4 回合，按钮应全部可用性正常
    A.pickShu("base_01");                  // 触发重绘，让天赋区出现
    await new Promise(r => setTimeout(r, 300));
    const btns = [...document.querySelectorAll(".talent-inline [data-op]")].map(b => ({
      op: b.dataset.op, dis: b.disabled, label: b.textContent.trim(),
    }));
    const st = document.querySelector(".talent-inline .tstat");
    return JSON.stringify({ early, btns, st: st && st.textContent.trim(),
      pre: A.state().phase, playable: A.playable().length });
  `);
  console.log("天赋区：", r1);
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "24-talent-convert.png"), Buffer.from(shot1.result.data, "base64"));

  const probe = await run(`
    const out = {};
    for (const side of ["n","w","e","s"]) {
      const m = document.querySelector('[data-side="' + side + '"] .member');
      if (!m) { out[side] = "no member"; continue; }
      const cs = getComputedStyle(m);
      const first = m.firstElementChild?.className || "";
      const r = m.getBoundingClientRect();
      out[side] = { dir: cs.flexDirection, first, w: Math.round(r.width), h: Math.round(r.height) };
    }
    const myDock = document.querySelector('[data-side="s"] .member .dock');
    if (myDock) { const r = myDock.getBoundingClientRect(); out.dockS = { top: Math.round(r.top), h: Math.round(r.height) }; }
    const myCard = document.querySelector('[data-side="s"] .member .seatcard');
    if (myCard) { const r = myCard.getBoundingClientRect(); out.cardS = { top: Math.round(r.top), h: Math.round(r.height) }; }
    return JSON.stringify(out);
  `);
  console.log("布局探针：", probe);

  // 天赋按钮的点击行为已由单测覆盖（引擎/服务端）；这里只确认"内联 + 门槛"的渲染
  console.log("（点击行为见 test/run.mjs 的 R74/R76 用例）");

  chrome.kill(); srv.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
