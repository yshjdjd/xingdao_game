// 抓联机大厅：最近进入的房间列表 + 房内的「解散房间」按钮。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "..", "shots");
const PORT = 9080 + Math.floor(Math.random() * 20);
const CDP = 9580 + Math.floor(Math.random() * 20);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-room-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,860",
  `http://127.0.0.1:${PORT}/online.html`,
], { stdio: "ignore" });

let id = 0; const pending = new Map(); let ws;
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, { res });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function connect() {
  for (let i = 0; i < 60; i++) {
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
  if (r.result?.exceptionDetails) console.error("页面异常:", JSON.stringify(r.result.exceptionDetails).slice(0, 200));
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  if (!r.result?.data) { console.error("截图失败"); return; }
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
  console.log("saved", name);
};

(async () => {
  await connect();
  await sleep(2200);

  // 连开三间再退出，攒出"最近进入"记录
  for (const name of ["青岚", "白鹿", "空山"]) {
    await run(`
      const A = window.__XD_ONLINE__;
      A.send({ t: "create", name: "${name}", factions: 4, per: 1 });
      await new Promise(r => setTimeout(r, 700));
      return A.state()?.room?.id || null;
    `);
    await run(`document.getElementById("btn-leave").click(); return 1;`);
    await sleep(2600);   // 退出会整页重载
  }
  await shot("22-recent-rooms");

  // 再开一间，截房内（房主应看到「解散房间」）
  await run(`
    const A = window.__XD_ONLINE__;
    A.send({ t: "create", name: "青岚", factions: 4, per: 1 });
    await new Promise(r => setTimeout(r, 900));
    return document.getElementById("btn-dissolve").style.display;
  `);
  const visible = await run(`return document.getElementById("btn-dissolve").style.display !== "none";`);
  console.log("解散按钮可见：", visible);
  await shot("23-room-host");

  chrome.kill(); srv.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); try { chrome.kill(); srv.kill(); } catch {} process.exit(1); });
