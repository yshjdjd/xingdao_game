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
  // 单机：直接跳到局末，验证「轮抽 -> 下一局」这条链
  const r1 = await run(`
    const A = window.__XD_APP__;
    A.finishRound();
    await new Promise(r => setTimeout(r, 400));
    return document.getElementById("modal").innerText.slice(0, 120);
  `);
  console.log("局末弹窗：", JSON.stringify(r1));
  const step = await run(`
    const before = JSON.stringify({
      hasDraft: !!window.__XD_APP__.match().setDraft,
      order: (window.__XD_APP__.match().setDraft?.order || []),
      matrix: window.__XD_APP__.match().factions.map(f => f.members),
    });
    document.getElementById("go").click();
    const right = window.__XD_APP__.state().phase;
    await new Promise(r => setTimeout(r, 60));
    const m = window.__XD_APP__.match();
    return JSON.stringify({ before, right,
      phase: window.__XD_APP__.state().phase,
      hasButton: !!document.querySelector("[data-dset]"),
      pool: (m.setDraft?.pool || []).length,
      idx: m.setDraft?.idx,
      modal: document.getElementById("modal").innerText.replace(/\s+/g, " ").slice(0, 200),
    });
  `);
  console.log("轮抽弹窗：", step);
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, "23-solo-draft.png"), Buffer.from(shot1.result.data, "base64"));

  const step2 = await run(`
    const A = window.__XD_APP__;
    // 等轮到自己（人机每家都要 0.9 秒）
    let waited = 0;
    while (!document.querySelector("[data-dset]") && waited < 12000) {
      await new Promise(r => setTimeout(r, 120));
      waited += 120;
    }
    const hasBtn = !!document.querySelector("[data-dset]");
    if (hasBtn) document.querySelector("[data-dset]").click();
    // 等轮抽走完
    let waited2 = 0;
    while (A.state().phase === "draft" && waited2 < 15000) {
      await new Promise(r => setTimeout(r, 150));
      waited2 += 150;
    }
    return JSON.stringify({
      waited, hasBtn,
      phase: A.state().phase,
      picks: (A.match().setDraft?.picks || []).length,
      sets: A.match().factions.map(f => f.sets.length),
      trace: globalThis.__DRAFT_TRACE__ || [],
    });
  `);
  console.log("挑完之后：", step2);
  chrome.kill(); srv.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
