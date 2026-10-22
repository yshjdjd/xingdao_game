// 验证站内「教程」按钮：点击后弹层出现、iframe 加载成功、按 Esc 能关。
//   node tools/shot_doc.mjs
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "..", "shots");
const PORT = 9010 + Math.floor(Math.random() * 20);
const CDP = 9510 + Math.floor(Math.random() * 20);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT), XD_FAST: "1" }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-doc-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  `http://127.0.0.1:${PORT}/online.html`,
], { stdio: "ignore" });

let id = 0; const pending = new Map(); let ws;
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
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
    } catch { /* retry */ }
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
  await sleep(200);
  const r = await send("Page.captureScreenshot", { format: "png" });
  const f = path.join(OUT, name + ".png");
  fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
  console.log("saved", f);
};

(async () => {
  await connect();
  await sleep(2000);

  // 大厅态：按钮在不在
  const hasBtn = await run(`return !!document.getElementById("btn-tutorial");`);
  console.log("按钮存在：", hasBtn);

  // 点开
  const opened = await run(`
    document.getElementById("btn-tutorial").click();
    await new Promise(r => setTimeout(r, 900));
    const ov = document.getElementById("doc-overlay");
    const fr = document.getElementById("doc-frame");
    return JSON.stringify({
      overlayOn: ov.classList.contains("on"),
      src: fr.getAttribute("src"),
      h2: fr.contentDocument ? [...fr.contentDocument.querySelectorAll("h2")].length : -1,
      title: fr.contentDocument ? fr.contentDocument.title : "",
    });
  `);
  console.log("打开后：", opened);
  await shot("17-tutorial-overlay");

  // Esc 关闭
  const closed = await run(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise(r => setTimeout(r, 300));
    return !document.getElementById("doc-overlay").classList.contains("on");
  `);
  console.log("Esc 能关闭：", closed);

  // 横屏手机：弹层应铺满
  await send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const mob = await run(`
    document.getElementById("btn-tutorial").click();
    await new Promise(r => setTimeout(r, 800));
    const sh = document.querySelector(".doc-shell").getBoundingClientRect();
    return JSON.stringify({ w: Math.round(sh.width), h: Math.round(sh.height) });
  `);
  console.log("横屏手机弹层尺寸：", mob);
  await shot("18-tutorial-mobile");

  chrome.kill(); srv.kill();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch(async (e) => {
  console.error(e);
  try { chrome.kill(); srv.kill(); } catch {}
  process.exit(1);
});
