// 线上冒烟：连真实部署的 WebSocket，确认服务端跑的就是刚发的那份代码。
// 判据很简单：老版本没有 births / setup 阶段，也没有 setupSets 字段。
//   node tools/prod_smoke.mjs
const BASE = process.env.XD_URL || "https://xingdao-332037-11-1500273890.sh.run.tcloudbase.com";
const WS = BASE.replace(/^http/, "ws") + "/ws";
const log = (s) => { process.stdout.write(s + "\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自己兜底超时，避免被外层 timeout 杀掉后日志全丢
const watchdog = setTimeout(() => { log("!! 超时：25 秒内没走完冒烟"); process.exit(1); }, 25000);

function client(name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS);
    const c = { name, ws, state: null, seat: -1, errors: [], phases: new Set() };
    ws.addEventListener("open", () => res(c));
    ws.addEventListener("error", (e) => rej(new Error(`WebSocket 连接失败：${e?.message || "unknown"}`)));
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === "error") c.errors.push(msg.msg);
      if (msg.t === "hello") { if (msg.seat != null) c.seat = msg.seat; return; }
      if (msg.t === "room" || msg.t === "view") {
        c.state = msg;
        if (msg.phase) c.phases.add(msg.phase);
      }
    });
    c.send = (o) => ws.send(JSON.stringify(o));
    setTimeout(() => rej(new Error("WebSocket 连接超时")), 8000);
  });
}

(async () => {
  log("目标：" + BASE);
  const host = await client("房主");
  log("已连上 WebSocket");

  host.send({ t: "create", name: "房主", factions: 4, per: 1 });
  let code = null;
  for (let i = 0; i < 40 && !code; i++) { await sleep(120); code = host.state?.room?.id; }
  if (!code) throw new Error("没拿到房号");
  log("房号 " + code);

  for (let i = 1; i < 4; i++) { host.send({ t: "addAI", seat: i }); await sleep(120); }
  host.send({ t: "start" });

  // 关键判据：新版开局先进 births，并带上身世字段
  let sawBirths = false, birthPayload = null;
  for (let i = 0; i < 60 && !sawBirths; i++) {
    await sleep(150);
    const st = host.state;
    if (st?.phase === "births") {
      sawBirths = true;
      const me = st.view?.players?.[st.seat ?? 0];
      birthPayload = {
        waiting: st.waiting,
        birthName: me?.birthName,
        birthText: (me?.birthText || "").slice(0, 20),
        hasViewMe: !!st.view?.me,
        shuList: (st.view?.me?.shuList || []).length,
        daoList: (st.view?.me?.daoList || []).length,
      };
    }
  }
  if (!sawBirths) throw new Error("没进到 births 阶段 —— 线上可能还是旧版本");

  log("births 阶段：waiting=" + JSON.stringify(birthPayload.waiting)
    + " 身世=" + birthPayload.birthName
    + " 身世文本=" + JSON.stringify(birthPayload.birthText));
  log("新投影字段：shuList=" + birthPayload.shuList + "  daoList=" + birthPayload.daoList);

  // 确认身世 → 应该进 setup 或 choose
  host.send({ t: "birthAck" });
  let next = null;
  for (let i = 0; i < 60 && !next; i++) {
    await sleep(120);
    const p = host.state?.phase;
    if (p && p !== "births") next = p;
  }
  log("确认身世后进入：" + next);
  log("见过的阶段：" + [...host.phases].join(" / "));
  log("协议错误：" + (host.errors.length ? host.errors.join(" | ") : "无"));

  const ok = sawBirths && ["tempDraw", "setDraft", "setDraftEnd", "choose"].includes(next) && !host.errors.length
    && birthPayload.shuList > 0 && birthPayload.daoList >= 0;
  clearTimeout(watchdog);
  log(ok ? "\n线上冒烟通过：服务端已是新版本 ✅" : "\n线上冒烟未通过 ❌");
  process.exit(ok ? 0 : 1);
})().catch((e) => { clearTimeout(watchdog); log("!! " + (e?.message || e)); process.exit(1); });
