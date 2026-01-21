//signal-worker\src\index.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response("OK");
    }

    // room siempre por query, fallback por si pruebas a mano
    const room = url.searchParams.get("room") ?? "global";

    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
  },
};

const EMPTY_ROOM_STATE = {
  creator: { name: "", lang: "" },
  guest: { name: "", lang: "" },
};

const EMPTY_AGENT_STATE = {
  creator: false,
  guest: false,
};

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.sockets = new Map(); // clientId -> WebSocket
    this.meta = new Map(); // clientId -> { role: "creator" | "guest" }
  }

  roleForNextConnection() {
    // 1. Miramos qué roles están ocupados AHORA MISMO en memoria
    let creatorExists = false;
    for (const m of this.meta.values()) {
      if (m.role === "creator") {
        creatorExists = true;
        break;
      }
    }

    // 2. Si no hay creador conectado (porque es nuevo O porque acaba de refrescar),
    // el que entra recupera el trono de 'creator'.
    if (!creatorExists) return "creator";

    // 3. Si ya hay creador, eres guest
    return "guest";
  }

  broadcast(obj, exceptId = null) {
    const msg = JSON.stringify(obj);
    for (const [id, ws] of this.sockets.entries()) {
      if (exceptId && id === exceptId) continue;
      try {
        ws.send(msg);
      } catch {}
    }
  }

  broadcastPeers() {
    this.broadcast({ type: "peers", count: this.sockets.size });
  }

  async getRoomState() {
    const s = await this.state.storage.get("roomState");
    return s ?? EMPTY_ROOM_STATE;
  }

  async getAgentState() {
    const s = await this.state.storage.get("agentState");
    return s ?? EMPTY_AGENT_STATE;
  }

  async setAgentState(next) {
    await this.state.storage.put("agentState", next);
  }

  async broadcastAgentState() {
    const agentState = await this.getAgentState();
    this.broadcast({ type: "agent_state", agentState });
  }

  async setRoomState(nextState) {
    await this.state.storage.put("roomState", nextState);
  }

  async broadcastRoomState() {
    const roomState = await this.getRoomState();
    this.broadcast({ type: "room_state", roomState });
  }

  async handleMessage(clientId, role, data) {
    // Compat con tu protocolo actual
    if (data?.type === "join") {
      this.broadcastPeers();
      return;
    }

    // Inicialización SOLO por creator. Si ya hay idiomas guardados, no pisa nada.
    if (data?.type === "init_room") {
      if (role !== "creator") return;

      const incoming = data?.payload ?? {};
      const current = await this.getRoomState();

      const alreadyInit = Boolean(current.creator.lang && current.guest.lang);

      if (!alreadyInit) {
        const nextState = {
          creator: {
            name: (incoming.creator?.name ?? "").trim(),
            lang: (incoming.creator?.lang ?? "").trim(),
          },
          guest: {
            name: (incoming.guest?.name ?? "").trim(),
            lang: (incoming.guest?.lang ?? "").trim(),
          },
        };

        await this.setRoomState(nextState);
        await this.broadcastRoomState();
      } else {
        // si ya está init, igualmente mandamos estado al creador por si entra tarde
        await this.broadcastRoomState();
      }
      return;
    }

    // Cada usuario puede cambiar SOLO su nombre/idioma
    if (data?.type === "profile") {
      const patch = data?.payload ?? {};
      const current = await this.getRoomState();

      const nextState = structuredClone(current);

      if (role === "creator") {
        if (typeof patch.name === "string") nextState.creator.name = patch.name.trim();
        if (typeof patch.lang === "string") nextState.creator.lang = patch.lang.trim();
      } else {
        if (typeof patch.name === "string") nextState.guest.name = patch.name.trim();
        if (typeof patch.lang === "string") nextState.guest.lang = patch.lang.trim();
      }

      await this.setRoomState(nextState);
      await this.broadcastRoomState();
      return;
    }

    // Señalización WebRTC (igual que ahora)
    if (data?.type === "signal") {
      this.broadcast({ type: "signal", payload: data.payload }, clientId);
      return;
    }
    // NUEVO: Rebotar transcripciones (Espejo invertido)
    if (data?.type === "transcript") {
      // Se lo enviamos a todos (el front filtrará, o simplemente al peer)
      // Usamos broadcast excluyendo al remitente para que no se duplique
      this.broadcast({ type: "transcript", payload: data.payload }, clientId);
      return;
    }
    // NUEVO: Rebotar “agente hablando” (para aro dorado sincronizado)
    if (data?.type === "agent_speaking") {
      const { targetRole, speaking } = data?.payload ?? {};
      if (targetRole !== "creator" && targetRole !== "guest") return;

      const current = await this.getAgentState();
      const next = { ...current, [targetRole]: !!speaking };

      await this.setAgentState(next);
      await this.broadcast({ type: "agent_state", agentState: next });
      return;
    }


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
    const role = this.roleForNextConnection();

    server.accept();

    this.sockets.set(clientId, server);
    this.meta.set(clientId, { role });

    const roomState = await this.getRoomState();

    // hello + peers + roomState
    const agentState = await this.getAgentState();
    server.send(JSON.stringify({ type: "hello", serverId, clientId, role, roomState, agentState }));
    this.broadcastPeers();

    server.addEventListener("message", (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }

      // IMPORTANT: no hacemos async directamente aquí (Cloudflare ok, pero mejor aislado)
      this.handleMessage(clientId, role, data).catch(() => {});
    });

    const onClose = () => {
      this.sockets.delete(clientId);
      this.meta.delete(clientId);
      this.broadcastPeers();

      // si la sala queda vacía, reseteamos agentState en background
      if (this.sockets.size === 0) {
        (async () => {
          try {
            await this.setAgentState(EMPTY_AGENT_STATE);
            // opcional: también podrías resetear roomState si quieres
            // await this.setRoomState(EMPTY_ROOM_STATE);
          } catch {}
        })();
      }
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    return new Response(null, { status: 101, webSocket: client });
  }
}
