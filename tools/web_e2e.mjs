// 浏览器端联机 E2E：真 Chrome + 真 WebSocket + 真 iframe 页面。
//
//   node tools/web_e2e.mjs [人数] [每势力人数]
//
// 做法：起服务 → 起无头 Chrome（开 CDP）→ 打开 web/_test_online.html →
// 轮询页面里的 #result，直到出现 "DONE {...}"。
// 这一层专门用来抓"Node 里跑得通、浏览器里白屏"的问题。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const N = Number(process.argv[2] || 2);
const PER = Number(process.argv[3] || 1);
const PORT = 8920 + Math.floor(Math.random() * 60);
const CDP = 9330 + Math.floor(Math.random() * 60);
const CHROME = process.env.CHROME
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT), XD_FAST: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--window-size=1400,1000", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* not ready */ }
    await sleep(150);
  }
  throw new Error("Chrome 调试端口未就绪");
}

async function main() {
  await sleep(700);
  const page = await targets();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const cmd = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await cmd("Page.navigate", {
    url: `http://127.0.0.1:${PORT}/_test_online.html?n=${N}&per=${PER}`,
  });

  const evaluate = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };

  let result = null;
  for (let i = 0; i < 400; i++) {
    const text = await evaluate("document.getElementById('result').textContent");
    if (typeof text === "string" && text.startsWith("DONE ")) {
      result = JSON.parse(text.slice(5));
      break;
    }
    if (i % 20 === 0 && typeof text === "string") {
      process.stdout.write("· " + text.split("\n").pop() + "\n");
    }
    await sleep(300);
  }

  if (!result) {
    console.log("超时：未拿到结果");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 1));
    process.exitCode = result.ok ? 0 : 1;
  }
  ws.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    chrome.kill();
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
