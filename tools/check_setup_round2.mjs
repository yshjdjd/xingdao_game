// 真实流程验证：第 1 局打完后，官宦子弟在第 2 局是否重新弹「挑术系」。
// 走的是 finishRound → 计时器 → nextRound 的自然路径（不是直接改 phase）。
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.XD_FAST = "1";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const R = await imp("server/room.mjs");
const { CONFIG } = await imp("src/config.mjs");
CONFIG.hpByRound = [8, 8, 8, 8];          // 别设 1：1 血会让人第 1 局就死，死了就不发术系

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c1 = { id: "c1", send() {} };
const c2 = { id: "c2", send() {} };
const { room } = R.createRoom(c1, { name: "A", factions: 2, per: 1 });
R.joinRoom(room, c2, "B");
const err = R.startMatch(room, "c1");
if (err) { console.error("startMatch:", err); process.exit(1); }
R.submitBirthAck(room, "c1");
R.submitBirthAck(room, "c2");

const m = room.match;
m.players[0].birth = "birth_03";           // 0 号是官宦子弟（从第 2 局起生效）

let setups = [];                            // 记录每次进入 setup 时的局号
let guard = 0;
while (guard++ < 4000) {
  const st = R.snapshotFor(room, "c1");
  if (!st) break;
  if (room.phase === "matchOver") break;

  if (room.phase === "tempDraw") {
    // R72：官宦子弟改成同时随机抽取，这里只要记录"哪几局弹过公示"
    if (!setups.includes(room.match.roundIndex + 1)) setups.push(room.match.roundIndex + 1);
  } else if (room.phase === "setDraft" && st.draftTurn?.youPick) {
    R.submitSetDraft(room, "c1", st.setDraft?.pool?.[0]);
  } else if (room.phase === "choose") {
    for (const id of ["c1", "c2"]) {
      const seat = [...room.seats].find((s) => s.clientId === id);
      if (!seat) continue;
      const snap = R.snapshotFor(room, id);
      const list = snap?.view?.me?.playable || [];
      if (!list.length) R.submitPlay(room, id, { cardId: "base_01" });
      else R.submitPlay(room, id, { cardId: list[0].id });
    }
  } else if (room.phase === "prompt" || room.phase === "tianjiExec") {
    for (const id of ["c1", "c2"]) {
      const snap = R.snapshotFor(room, id);
      if (!snap?.prompts?.length) continue;
      const ans = {};
      for (const p of snap.prompts) {
        ans[p.id] = p.type === "target" ? (p.pool || [])[0] : (p.options?.[0] ?? null);
      }
      R.submitAnswers(room, id, ans);
    }
  } else if (room.phase === "auction") {
    for (const id of ["c1", "c2"]) R.submitBid(room, id, 0);
  } else if (room.phase === "discard") {
    for (const id of ["c1", "c2"]) {
      const snap = R.snapshotFor(room, id);
      if (!snap?.view?.me?.discard) continue;
      R.submitDiscard(room, id, []);
    }
  } else if (room.phase === "roundEnd") {
    R.nextRound(room);
    // 立刻判定：有人活着要挑就会停在 setup；死光了 / 没特权 会 0ms 直接进下一阶段
    if (room.phase === "tempDraw") setups.push(m.roundIndex + 1);
  }
  await sleep(4);
}

const norm = [...new Set(setups.map((n) => Number(n)).filter((n) => n >= 2))].sort((a, b) => a - b);
console.log("第 2 局及以后进入 setup 的局号：", norm.length ? norm.join(", ") : "（一次都没有）");
const ok = norm.length > 0;
console.log(ok ? "✓ 第 2 局（或之后）确实弹出了挑术系" : "✗ 第 2 局起仍然没有挑术系");
R.destroyRoom(room);
process.exit(ok ? 0 : 1);
