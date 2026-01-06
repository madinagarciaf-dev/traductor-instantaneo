import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.SIGNAL_PORT ? Number(process.env.SIGNAL_PORT) : 3001;
const SERVER_ID = Math.random().toString(36).slice(2, 8);

const server = http.createServer();
const wss = new WebSocketServer({ server });

// roomCode -> Set(ws)
const rooms = new Map();

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj) {
  const set = rooms.get(room);
  if (!set) return;
  for (const client of set) safeSend(client, obj);
}

function roomCount(room) {
  const set = rooms.get(room);
  return set ? set.size : 0;
}

function shortId() {
  return Math.random().toString(36).slice(2, 8);
}

wss.on("connection", (ws, req) => {
  ws.room = null;
  ws.clientId = shortId();

  console.log(`✅ [${SERVER_ID}] connect client=${ws.clientId} ip=${req.socket.remoteAddress}`);

  // “hello” directo al cliente (para debug)
  safeSend(ws, { type: "hello", serverId: SERVER_ID, clientId: ws.clientId });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.log(`⚠️ [${SERVER_ID}] bad json from client=${ws.clientId}`);
      return;
    }

    if (msg.type === "join" && typeof msg.room === "string") {
      const room = msg.room.toUpperCase();
      ws.room = room;

      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);

      console.log(`➡️ [${SERVER_ID}] join client=${ws.clientId} room=${room} count=${roomCount(room)}`);

      broadcastRoom(room, { type: "peers", count: roomCount(room), room, serverId: SERVER_ID });
      return;
    }

    if (ws.room && msg.type === "signal") {
      const set = rooms.get(ws.room);
      if (!set) return;

      // reenvía a los demás
      for (const client of set) {
        if (client !== ws) safeSend(client, msg);
      }
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    console.log(`❌ [${SERVER_ID}] close client=${ws.clientId} room=${room ?? "-"}`);

    if (!room) return;
    const set = rooms.get(room);
    if (!set) return;

    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
    else broadcastRoom(room, { type: "peers", count: roomCount(room), room, serverId: SERVER_ID });
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Signaling server [${SERVER_ID}] listening on ws://localhost:${PORT}`);
});
