// 截当前联机页的关键画面：大厅首页 / 房间等待 / 对局中（桌面 + 手机横屏 + 2v2 + 竖屏提示）。
//
//   node tools/shot.mjs [输出目录]
//
// 用真 Chrome（CDP）跑真页面，产物用于人工看布局。
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, "..", "shots");
const PORT = 8960 + Math.floor(Math.random() * 30);
const CDP = 9460 + Math.floor(Math.random() * 30);
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const srv = spawn(process.execPath, [path.join(ROOT, "server", "index.mjs")], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "ignore", "inherit"],
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "xd-shot-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });

async function pageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
      const p = list.find((t) => t.type === "page");
      if (p) return p;
    } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error("chrome 未就绪");
}

async function main() {
  await sleep(800);
  const page = await pageTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener("open", r));
  const cmd = (method, params = {}) => new Promise((res) => {
    const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params }));
  });

  await cmd("Page.enable");
  await cmd("Runtime.enable");
  const viewport = (w, h, mobile = false) =>
    cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });

  const go = async (url) => { await cmd("Page.navigate", { url }); await sleep(1700); };
  const shot = async (name) => {
    // 截图前先把弹窗遮罩关掉：R53 之后"出牌前"可能还压着天机执行的弹窗，
    // 不关掉整张牌桌都是糊的。
    await cmd("Runtime.evaluate", {
      expression: 'document.getElementById("overlay")?.classList.remove("on"); 1',
    });
    await sleep(120);
    const r = await cmd("Page.captureScreenshot", { format: "png" });
    const file = path.join(OUT, name + ".png");
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    console.log("saved", file);
  };
  const run = async (expr) => {
    const r = await cmd("Runtime.evaluate", { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) console.error("页面异常:", JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const errs = async () => {
    const t = await cmd("Runtime.evaluate", {
      expression: "document.getElementById('errbox').textContent.trim()", returnByValue: true,
    });
    return t.result?.result?.value || "";
  };

  await viewport(1360, 880);
  await go(`http://127.0.0.1:${PORT}/online.html`);
  await shot("01-lobby-home");

  // ---- 4 人混战 ----
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 4, per: 1 }); await s(400);
    for (const i of [1,2,3]) { A.send({ t: "addAI", seat: i }); await s(150); }
    return "ok";
  `);
  await sleep(400);
  await shot("02-lobby-room");

  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "start" }); await s(1600);

    // R51/R52：开场先公示身世、局初官宦子弟要挑术系 —— 截图脚本要自己走过去
    for (let k = 0; k < 40; k++) {
      const st0 = A.state();
      if (st0?.phase === "births") { A.send({ t: "birthAck" }); await s(220); continue; }
      if (st0?.phase === "setDraft" && st0.draftTurn?.youPick) {
        A.send({ t: "setDraft", setId: st0.setDraft?.pool?.[0] }); await s(220); continue;
      }
      if (st0?.phase === "choose" || st0?.phase === "reveal") break;
      await s(200);
    }
    return "started";
  `);
  await shot("03-table-choose");

  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    const st = A.state();
    if (st.view?.me?.playable?.length) A.play(st.view.me.playable[0].id);
    await s(200);
    return "played";
  `);
  await sleep(900);
  await shot("04-table-reveal");
  console.log("err(4人):", (await errs()) || "无");

  // ---- 手机横屏 ----
  await viewport(844, 390, true);
  await sleep(700);
  await shot("05-mobile-landscape");
  // ---- 手机竖屏（应出现"请横屏"） ----
  await viewport(390, 844, true);
  await sleep(700);
  await shot("06-mobile-portrait");

  // ---- 2v2 ----
  await viewport(1360, 880);
  await go(`http://127.0.0.1:${PORT}/online.html`);
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 2, per: 2 }); await s(400);
    for (const i of [1,2,3]) { A.send({ t: "addAI", seat: i }); await s(150); }
    A.send({ t: "start" }); await s(1600);

    // R51/R52：开场先公示身世、局初官宦子弟要挑术系 —— 截图脚本要自己走过去
    for (let k = 0; k < 40; k++) {
      const st0 = A.state();
      if (st0?.phase === "births") { A.send({ t: "birthAck" }); await s(220); continue; }
      if (st0?.phase === "setDraft" && st0.draftTurn?.youPick) {
        A.send({ t: "setDraft", setId: st0.setDraft?.pool?.[0] }); await s(220); continue;
      }
      if (st0?.phase === "choose" || st0?.phase === "reveal") break;
      await s(200);
    }
    const st = A.state();
    if (st.view?.me?.playable?.length) A.play(st.view.me.playable[0].id);
    await s(900);
    return "ok";
  `);
  await sleep(600);
  await shot("07-table-2v2");
  console.log("err(2v2):", (await errs()) || "无");

  // ---- 3 势力（1v1v1） ----
  await go(`http://127.0.0.1:${PORT}/online.html`);
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 3, per: 1 }); await s(400);
    for (const i of [1,2]) { A.send({ t: "addAI", seat: i }); await s(150); }
    A.send({ t: "start" }); await s(1600);

    // R51/R52：开场先公示身世、局初官宦子弟要挑术系 —— 截图脚本要自己走过去
    for (let k = 0; k < 40; k++) {
      const st0 = A.state();
      if (st0?.phase === "births") { A.send({ t: "birthAck" }); await s(220); continue; }
      if (st0?.phase === "setDraft" && st0.draftTurn?.youPick) {
        A.send({ t: "setDraft", setId: st0.setDraft?.pool?.[0] }); await s(220); continue;
      }
      if (st0?.phase === "choose" || st0?.phase === "reveal") break;
      await s(200);
    }
    const st = A.state();
    if (st.view?.me?.playable?.length) A.play(st.view.me.playable[0].id);
    await s(900);
    return "ok";
  `);
  await sleep(600);
  await shot("08-table-3faction");
  console.log("err(3势力):", (await errs()) || "无");

  // ---- 8 人（4 势力 ×2）----
  await go(`http://127.0.0.1:${PORT}/online.html`);
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 4, per: 2 }); await s(400);
    for (const i of [1,2,3,4,5,6,7]) { A.send({ t: "addAI", seat: i }); await s(120); }
    A.send({ t: "start" }); await s(1600);

    // R51/R52：开场先公示身世、局初官宦子弟要挑术系 —— 截图脚本要自己走过去
    for (let k = 0; k < 40; k++) {
      const st0 = A.state();
      if (st0?.phase === "births") { A.send({ t: "birthAck" }); await s(220); continue; }
      if (st0?.phase === "setDraft" && st0.draftTurn?.youPick) {
        A.send({ t: "setDraft", setId: st0.setDraft?.pool?.[0] }); await s(220); continue;
      }
      if (st0?.phase === "choose" || st0?.phase === "reveal") break;
      await s(200);
    }
    const st = A.state();
    if (st.view?.me?.playable?.length) A.play(st.view.me.playable[0].id);
    await s(900);
    return "ok";
  `);
  await sleep(600);
  await shot("09-table-8p");
  console.log("err(8人):", (await errs()) || "无");

  // ---- 单机页 + 悬浮看牌 ----
  await go(`http://127.0.0.1:${PORT}/index.html`);
  await sleep(700);
  const pos = await run(`
    const b = document.querySelector("#hand-shu [data-shu]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };
  `);
  if (pos) {
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await sleep(500);
    await shot("10-solo-hover");
  } else {
    await shot("10-solo-hover");
  }
  console.log("err(单机):", (await errs()) || "无");

  // ---- 多回合后的中央坛（含遗留效果） ----
  await viewport(1360, 880);
  await go(`http://127.0.0.1:${PORT}/online.html`);
  await run(`
    const A = window.__XD_ONLINE__;
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    A.send({ t: "create", name: "青岚" }); await s(600);
    A.send({ t: "config", factions: 4, per: 1 }); await s(400);
    for (const i of [1,2,3]) { A.send({ t: "addAI", seat: i }); await s(120); }
    A.send({ t: "start" }); await s(1500);

    // R51/R52：开场先公示身世、局初官宦子弟要挑术系 —— 截图脚本要自己走过去
    for (let k = 0; k < 40; k++) {
      const st0 = A.state();
      if (st0?.phase === "births") { A.send({ t: "birthAck" }); await s(220); continue; }
      if (st0?.phase === "setDraft" && st0.draftTurn?.youPick) {
        A.send({ t: "setDraft", setId: st0.setDraft?.pool?.[0] }); await s(220); continue;
      }
      if (st0?.phase === "choose" || st0?.phase === "reveal") break;
      await s(200);
    }
    let found = false;
    for (let k = 0; k < 22 && !found; k++) {
      const st = A.state();
      const legal = st?.view?.me?.playable || [];
      if (st?.phase === "choose" && (st.waiting || []).includes(st.seat) && legal.length) {
        A.play(legal[Math.floor(Math.random()*legal.length)].id);
      }
      await s(1200);
      found = !!A.state()?.view?.tianji?.now;
      if (["prompt", "tianjiExec"].includes(A.state()?.phase)) { A.send({ t: "answers", answers: {} }); await s(600); }
      if ((A.state()?.phase) === "auction") { A.bid(0); await s(600); }
      if ((A.state()?.phase) === "roundEnd") { document.getElementById("go-next")?.click(); await s(1200); }
    }
    return A.state()?.view?.effects?.length || 0;
  `);
  await sleep(700);
  await shot("12-table-effects");
  console.log("err(多回合):", (await errs()) || "无");

  // ---- 手机横屏：有天机 + 遗留效果 + 长按看牌 ----
  await viewport(844, 390, true);
  await cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(700);
  await shot("13-mobile-effects");
  const tp = await run(`
    const b = document.querySelector("#hand-shu [data-shu]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  if (tp) {
    await cmd("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: tp.x, y: tp.y }] });
    await sleep(700);
    await cmd("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(150);
    await shot("14-mobile-longpress");
  }

  // ---- 事件面板展开（手机上） ----
  await viewport(844, 390, true);
  await sleep(400);
  await run(`document.getElementById("panel-toggle")?.click(); await new Promise(r=>setTimeout(r,300)); return 1;`);
  await shot("11-mobile-panel");

  ws.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { chrome.kill(); srv.kill(); setTimeout(() => process.exit(process.exitCode || 0), 300); });
