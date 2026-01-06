export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("OK");
    }

    // ✅ No obligues room en query: usa global
    const room = url.searchParams.get("room") ?? "global";

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request); // ✅ reenviar request original
  },
};


export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // clientId -> WebSocket
  }

  broadcast(obj, exceptId = null) {
    const msg = JSON.stringify(obj);
    for (const [id, ws] of this.sockets.entries()) {
      if (exceptId && id === exceptId) continue;
      try { ws.send(msg); } catch {}
    }
  }

  broadcastPeers() {
    this.broadcast({ type: "peers", count: this.sockets.size });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const clientId = crypto.randomUUID();
    const serverId = "cf-do";

    server.accept();
    this.sockets.set(clientId, server);

    // hello + peers
    server.send(JSON.stringify({ type: "hello", serverId, clientId }));
    this.broadcastPeers();

    server.addEventListener("message", (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }

      // Compat con tu protocolo actual
      if (data?.type === "join") {
        // ya estamos en la sala por DO; solo reemitimos peers por si acaso
        this.broadcastPeers();
        return;
      }

      if (data?.type === "signal") {
        // reenvía a todos menos al emisor
        this.broadcast({ type: "signal", payload: data.payload }, clientId);
      }
    });

    const onClose = () => {
      this.sockets.delete(clientId);
      this.broadcastPeers();
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    return new Response(null, { status: 101, webSocket: client });
  }
}
