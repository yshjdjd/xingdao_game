// 联机服务进程：静态站点 + WebSocket 房间服务。
//
// 启动：node server/index.mjs        （默认 8787 端口，PORT 可覆盖）
// 部署：容器里是同一个命令，监听 $PORT。
//
// 与静态托管版（web/ 直接上传）的区别：这里多一个常驻进程，所以能「服务端权威 + 广播」。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachWebSocket } from "./ws.mjs";
import * as R from "./room.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // xingdao/
const WEB = path.join(ROOT, "web");
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url === "/api/rooms") {
    // 仅用于调试：列出当前房间数（不含房间号，避免被扫）
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: R.roomCount() }));
    return;
  }

  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(path.resolve(WEB))) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // 单页应用式兜底：找不到就当首页（方便 /123456 这类分享链接）
      fs.readFile(path.join(WEB, "index.html"), (e2, html) => {
        if (e2) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "content-type": MIME[".html"] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(buf);
  });
});

attachWebSocket(server, (conn) => {
  conn.room = null;

  conn.onmessage = (msg) => {
    try {
      handle(conn, msg);
    } catch (e) {
      console.error("[msg]", e);
      R.send(conn, { t: "error", msg: "服务端处理失败：" + (e.message || e) });
    }
  };

  conn.onclose = () => {
    if (conn.room) R.leave(conn.room, conn.id);
    conn.room = null;
  };

  R.send(conn, { t: "hello", serverNow: Date.now() });
});

function handle(conn, msg) {
  const type = msg && msg.t;

  if (type === "create") {
    const { room, seat } = R.createRoom(conn, {
      name: msg.name,
      factions: clamp(msg.factions ?? 4, 1, 4),
      per: clamp(msg.per ?? 1, 1, 2),
    });
    conn.room = room;
    const token = room.seats[seat]?.token;
    R.send(conn, { t: "hello", roomId: room.id, seat, token, serverNow: Date.now() });
    R.broadcast(room);
    return;
  }

  if (type === "join") {
    const room = R.getRoom(msg.roomId);
    if (!room) return R.send(conn, { t: "error", msg: "房间不存在或已解散" });
    const { seat, error } = R.joinRoom(room, conn, msg.name, { watch: !!msg.watch });
    if (error) return R.send(conn, { t: "error", msg: error });
    conn.room = room;
    const token = seat >= 0 ? room.seats[seat]?.token : null;
    R.send(conn, { t: "hello", roomId: room.id, seat, token, serverNow: Date.now() });
    R.broadcast(room);
    return;
  }

  if (type === "resume") {
    const room = R.getRoom(msg.roomId);
    if (!room) return R.send(conn, { t: "error", msg: "房间已解散" });
    const { seat, error } = R.resume(room, conn, String(msg.token || ""));
    if (error) return R.send(conn, { t: "error", msg: error });
    conn.room = room;
    R.send(conn, { t: "hello", roomId: room.id, seat, token: msg.token, serverNow: Date.now() });
    R.broadcast(room);
    return;
  }

  const room = conn.room;
  if (!room) return R.send(conn, { t: "error", msg: "先创建或加入房间" });

  switch (type) {
    case "config": {
      const err = R.configure(room, conn.id, msg);
      if (err) return R.send(conn, { t: "error", msg: err });
      R.broadcast(room);
      return;
    }
    case "faction": {
      const err = R.setFaction(room, conn.id, Number(msg.seat), Number(msg.factionId));
      if (err) return R.send(conn, { t: "error", msg: err });
      R.broadcast(room);
      return;
    }
    case "take": {
      const r = R.takeSeat(room, conn.id, Number(msg.seat));
      if (typeof r === "string") return R.send(conn, { t: "error", msg: r });
      R.send(conn, { t: "hello", roomId: room.id, seat: Number(msg.seat), token: r.token });
      R.broadcast(room);
      return;
    }
    case "addAI": {
      const err = R.addAI(room, conn.id, Number(msg.seat));
      if (err) return R.send(conn, { t: "error", msg: err });
      R.broadcast(room);
      return;
    }
    case "clear": {
      const err = R.clearSeat(room, conn.id, Number(msg.seat));
      if (err) return R.send(conn, { t: "error", msg: err });
      R.broadcast(room);
      return;
    }
    case "start": {
      const err = R.startMatch(room, conn.id);
      if (err) return R.send(conn, { t: "error", msg: err });
      return;
    }
    case "play": {
      const err = R.submitPlay(room, conn.id, msg);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    // R55 神装：手牌区里的装卸按钮，独立于出牌提交
    case "equip": {
      const err = R.submitEquip(room, conn.id, { op: msg.op, daoId: msg.daoId });
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    // R42：天机门人已删除，不再有 tianji 消息（收到就忽略，别报错打断老客户端）
    case "tianji": return;
    // R51 开场：确认自己的身世
    case "birthAck": {
      const err = R.submitBirthAck(room, conn.id);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    // R74 出牌阶段：身世天赋实时操作（1 血 ↔ 2 能量 …）
    case "convert": {
      const err = R.submitConvert(room, conn.id, msg.op);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    // R72 局末：术系轮抽 —— 轮到你所属势力时点一套
    case "setDraft": {
      const err = R.submitSetDraft(room, conn.id, msg.setId);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    case "answers": {
      const err = R.submitAnswers(room, conn.id, msg.answers);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    case "bid": {
      const err = R.submitBid(room, conn.id, msg.bid);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    case "discard": {
      const err = R.submitDiscard(room, conn.id, msg.ids);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    case "again": {
      const err = R.backToLobby(room, conn.id);
      if (err) return R.send(conn, { t: "error", msg: err });
      R.broadcast(room);
      return;
    }
    case "next": {
      const err = R.hostNext(room, conn.id);
      if (err) R.send(conn, { t: "error", msg: err });
      return;
    }
    case "leave": {
      R.leave(room, conn.id);
      conn.room = null;
      R.broadcast(room);
      return;
    }
    case "dissolve": {
      // R83：房主主动解散 —— 房间立刻消失，其他人收到 dissolved 后回首页
      const err = R.dissolveRoom(room, conn.id);
      if (err) return R.send(conn, { t: "error", msg: err });
      conn.room = null;
      return;
    }
    default:
      R.send(conn, { t: "error", msg: "未知指令：" + type });
  }
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || lo));

server.listen(PORT, () => {
  console.log(`[行道] 联机服务已启动： http://127.0.0.1:${PORT}/  （WebSocket: /ws）`);
});
