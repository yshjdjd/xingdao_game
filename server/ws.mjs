// 极简 WebSocket 服务端（RFC 6455），零依赖。
//
// 为什么不用 ws 包：这个项目全程没有 npm 依赖（部署=传目录 / 一个 node 进程），
// 而回合制游戏的消息量很小 —— 文本帧 + ping/pong 足够，不需要扩展协商、压缩、分片发送。
//
// 支持：握手、掩码解码、文本帧、分片接收、ping/pong、close。不支持：permessage-deflate、
// 二进制帧（收到直接关连接）。这对本项目足够，且代码只有两百行，出问题一眼能看完。
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function attachWebSocket(httpServer, onConnection) {
  httpServer.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const conn = makeConn(socket, req);
    onConnection(conn, req);
  });
}

function makeConn(socket, req) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  let lastPong = Date.now();

  const conn = {
    id: crypto.randomUUID(),
    req,
    remote: (req.socket.remoteAddress || "").replace("::ffff:", ""),
    onmessage: null,
    onclose: null,
    get closed() { return closed; },

    send(obj) {
      if (closed) return;
      writeFrame(socket, 0x1, Buffer.from(JSON.stringify(obj), "utf8"));
    },

    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      writeFrame(socket, 0x8, body);
      socket.end();
      conn.onclose?.();
    },

    ping() {
      if (!closed) writeFrame(socket, 0x9, Buffer.alloc(0));
    },
  };

  // 心跳：云托管的网关会掐掉长时间静默的连接，30 秒一次足够。
  const timer = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastPong > 90_000) return conn.close(1001, "心跳超时");
    conn.ping();
  }, 30_000);
  if (timer.unref) timer.unref();

  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    conn.onclose?.();
  };

  socket.on("close", finish);
  socket.on("error", finish);

  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (true) {
      const frame = readFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.size);

      const { fin, opcode, payload } = frame;
      if (opcode === 0x8) return conn.close(1000, "");
      if (opcode === 0x9) { writeFrame(socket, 0xA, payload); continue; }
      if (opcode === 0xA) { lastPong = Date.now(); continue; }
      if (opcode === 0x2) return conn.close(1003, "不支持二进制帧");

      if (opcode === 0x0) fragments.push(payload);
      else { fragments = [payload]; }

      if (!fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      if (!text) continue;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      try { conn.onmessage?.(msg); } catch (e) { console.error("[ws] handler error", e); }
    }
  });

  return conn;
}

// 从缓冲区里切出一帧；数据不够返回 null
function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 2 ** 32 + lo;
    offset += 8;
  }

  if (len > 1_000_000) throw new Error("帧过大");

  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;

  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

  return { fin, opcode, payload, size: offset + len };
}

function writeFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode;
  try { socket.write(Buffer.concat([header, payload])); } catch { /* 连接已断 */ }
}
